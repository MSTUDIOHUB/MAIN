// lib/orchestrator.ts
// The Agent Execution Loop.
//
// Architecture (inspired by claude-code-haha's query.ts + QueryEngine.ts):
//   1. SSE streaming with per-token UI rendering
//   2. Native OpenAI `tools` API — model generates `tool_calls` natively
//   3. Fallback text parser for models that output tool calls as XML text
//   4. Read-only tools → auto-execute (no user gate)
//   5. Write/execute tools → human-in-the-loop via ActionCard
//   6. Multi-turn: after tool result, loop back automatically
//   7. Error recovery: reactive compact for context-too-long errors
//   8. Max output tokens escalation (8k → 16k → 32k → 64k)
//   9. Concurrent execution for read-only tools
//  10. Error feedback: tool errors returned as role:"tool" for AI self-repair
// ────────────────────────────────────────────────────────────────────

import {
  streamChatCompletion,
  escalateMaxTokens,
  computeInitialMaxTokens,
  type StreamSettings,
  type StreamResult,
} from "./streaming";
import { buildToolDefinitions, skillNameToToolName, type ToolDefinition } from "./toolSchemas";
import { executeTool, isReadOnlyTool } from "./toolExecutor";
import { computeContextBudgets, manageContext } from "./contextTrim";
import { generateId } from "./utils";
import { buildSystemPrompt } from "./systemPrompt";
import { discoverAllMcpTools, setMcpToolServerMap, type MCPServer, type MCPTool } from "./mcpClient";
import { deletePlanFiles } from "./ipc";
import { ensureVisibleConclusion, isAssistantTurnEmpty, normalizeAssistantTurn } from "./normalizedTurn";
import { hasStructuredPlanProposal } from "./planProposal";
import { serializeAssistantReplyForHistory, shouldPauseForReplyOptions } from "./replyOptions";
import { buildToolDiffPreview, type ToolDiffPreview } from "./toolDiff";
import { syncPlanArtifactAfterToolSuccess } from "./planArtifactSync";
import type { AppConfig, Skill } from "../store/useAppStore";
import { getPendingPlanTaskCommandFocus, type PlanTask, type ReplyOption } from "./workflowModels";
import type { MainModeKey } from "./mainModes";
import type { ResolvedUserIntent } from "./runIntent";
import {
  loadResolvedInstructions,
  type ResolvedInstructionSet,
} from "./instructions";
import {
  loadHooksConfig,
  runHookEvent,
  type HookDefinition,
  type HookExecutionRecord,
  type HookEvent,
} from "./hooks";
import type { PendingSlashCommand, StudioAgentKey } from "./gameStudioCatalog";
import {
  formatRepeatLoopFatalMessage,
  formatRepeatLoopRecoveryMessage,
  registerToolCallForRepeatGuard,
} from "./repetitionGuard";
import {
  buildCompatibilityRetryMessages,
  buildTranscriptCompatibilityRetryMessages,
  ensureProviderCompatibilityMode,
  extractCompatibilityTextContent,
  hasProviderNativeToolsDisabled,
  isProviderCompatibilityErrorMessage,
} from "./providerCompatibility";
import { getErrorMessage } from "./errorUtils";
import { resolveProtocolPackageReadPath } from "./protocolPackages";
import { isRetryableCloudErrorMessage } from "./cloudRetry";
import {
  buildMissingToolCallContinuationPrompt,
  resolveMissingToolCallRepromptKind,
} from "./missingToolCallReprompt";

// ── Spec file auto-approval helpers ────────────────────────────────

const SPEC_FILE_NAMES = new Set(["requirements.md", "design.md", "tasks.md", "bugfix.md"]);

/**
 * Returns true if a write_file call targets a spec file inside `.MAIN/plans/`.
 * These are auto-approved in Plan Mode — no user review required.
 */
function isSpecFileWrite(name: string, args: Record<string, unknown>): boolean {
  if (name !== "write_file") return false;
  const path = (args.path as string) || "";
  const normalized = path.replace(/\\/g, "/");
  // Match both `.MAIN/plans/requirements.md` and absolute paths containing it
  if (normalized.includes(".MAIN/plans/")) {
    const fileName = normalized.split("/").pop() || "";
    return SPEC_FILE_NAMES.has(fileName);
  }
  return false;
}

// ── Tool argument validation ────────────────────────────────────────

/**
 * Validate that all required parameters for a tool are present.
 * Returns an error message string if any are missing, or null if valid.
 */
function validateToolArgs(name: string, args: Record<string, unknown>, allTools: ToolDefinition[]): string | null {
  const def = allTools.find(d => d.function.name === name);
  if (!def) return null; // Unknown tool — let it through and fail downstream
  const required = def.function.parameters.required;
  const missing = required.filter(k => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length === 0) return null;
  return `Tool '${name}' is missing required parameter(s): ${missing.join(", ")}. ` +
    `Required: ${required.join(", ")}. Please retry with the correct arguments.`;
}

// ── Types ─────────────────────────────────────────────────────────

/** A tool call in the assistant message (OpenAI format). */
export interface ToolCallInMessage {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Multimodal content parts (OpenAI-compatible format). */
export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageUrlContentPart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextContentPart | ImageUrlContentPart;

/** Message format supporting native tool calling and multimodal content. */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: ToolCallInMessage[];
  tool_call_id?: string;
}

/** Result returned when the user acts on a pending Action Card. */
export type ReviewDecision =
  | { action: "accept" }
  | { action: "reject" }
  | { action: "error"; error: string };

export interface OrchestratorCallbacks {
  // State accessors
  getMessages: () => AgentMessage[];
  getConfig: () => AppConfig;
  getPreferredLanguage: () => "zh" | "en";
  getSkills: () => Skill[];
  getMainModeKey: () => MainModeKey;
  getActiveStudioAgentKey: () => StudioAgentKey;
  getGameStudioInitialized: () => boolean;
  getPendingSlashCommand: () => PendingSlashCommand | null;
  getWorkspaceTree: () => string;
  getMcpServers: () => MCPServer[];
  getMcpDiscoveredTools: () => MCPTool[];
  getAssociatedPaths: () => string[];
  getSessionKey: () => string;
  hasSessionHookInitialized: (sessionKey: string) => boolean;
  markSessionHookInitialized: (sessionKey: string) => void;
  // Planning & Management
  getCurrentRunIntent: () => ResolvedUserIntent;
  getWorkflowMode: () => "chat" | "edit" | "plan";
  getIsPlanApproved: () => boolean;
  getPlanStage: () => "idle" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed";
  getPlanTasks: () => PlanTask[];
  getStatus: () => "idle" | "running" | "pending_review" | "error";
  startNewTurn: () => void;

  // UI updates
  onStreamToken: (token: string, messageId: string) => void;
  onStreamDone: (fullText: string, messageId: string, truncated: boolean) => void;
  onThought: (thought: string) => void;
  onAssistantText: (text: string) => void;
  onAssistantFinalText: (text: string, replyOptions?: ReplyOption[]) => void;
  onStatusChange: (status: "idle" | "running" | "pending_review" | "error") => void;
  onError: (error: string) => void;
  onPlanArtifactUpdated: (path: string, content: string, kind: "requirements" | "design" | "tasks" | "bugfix") => void;
  onPlanStageChanged: (stage: "idle" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed") => void;
  onPlanTasksUpdated: (content: string) => void;
  onTurnSummaryReady: (summary: string) => void;
  onInstructionsResolved: (resolved: ResolvedInstructionSet) => void;
  onHooksLoaded: (hooks: HookDefinition[], loadedAt?: number | null) => void;
  onHookStart: (event: HookEvent, hook: HookDefinition) => void;
  onHookResult: (record: HookExecutionRecord) => void;
  onHookBlocked: (event: HookEvent, reason: string, record?: HookExecutionRecord) => void;

  // Message history management
  appendMessage: (msg: AgentMessage) => void;
  replaceMessages: (msgs: AgentMessage[]) => void;
  onContextCompress: (
    stats: {
      droppedCount: number;
      tokenCountBefore: number;
      tokenCountAfter: number;
      tokenReduction: number;
    },
    reason: "proactive" | "reactive",
  ) => void;

  // Tool execution UI feedback
  onToolExecuting: (toolName: string, target: string, diff?: ToolDiffPreview) => void;
  onToolDone: (toolName: string, target: string, result: string) => void;
  onToolError: (toolName: string, target: string, error: string) => void;

  // Human-in-the-loop — only for write/execute tools.
  // Read-only tools are auto-executed by the orchestrator.
  requestReview: (toolCall: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<ReviewDecision>;
}

// ── Helpers ───────────────────────────────────────────────────────

function deriveStreamSettings(config: AppConfig): StreamSettings {
  if (config.activeProfile === "local") {
    const isOllama = config.local.provider === "Ollama";
    return {
      baseUrl: config.local.endpoint,
      apiKey: config.local.apiKey || "not-needed",
      model: config.local.model,
      temperature: 0.2,
      contextLimit: config.local.contextLimit,
      provider: config.local.provider,
      // LM Studio / OMLX 的本地流式接口在桌面 WebView 中可能触发
      // “Load Failed”，统一交给 Tauri 后端请求，避开 WebView 限制。
      // Ollama 保留前端直连，因为它使用原生 /api/chat 流格式。
      useRustProxy: !isOllama,
    };
  }
  return {
    baseUrl: config.cloud.endpoint || "https://api.openai.com/v1",
    apiKey: config.cloud.apiKey,
    model: config.cloud.model,
    apiProtocol: config.cloud.protocol || "openai",
    apiFormat: config.cloud.apiFormat || "chat_completions",
    customHeaders: config.cloud.customHeaders || "",
    temperature: config.cloud.temperature ?? 0.6,
    topP: config.cloud.topP ?? 0.95,
    disableResponseStorage: config.cloud.disableResponseStorage ?? true,
    reasoningEffort: config.cloud.reasoningEffort ?? "none",
    // Cloud profile should not inherit the local KV-cache/context limit.
    contextLimit: undefined,
    provider: config.cloud.provider,
    useRustProxy: true,  // Route through Rust to bypass WebView CORS
  };
}

/** Derive a short display target from tool arguments. */
function getToolTarget(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_directory":  return (args.path as string) || ".";
    case "read_file":       return (args.path as string) || "";
    case "read_document":   return (args.path as string) || "";
    case "analyze_tabular_document": return (args.path as string) || "";
    case "query_tabular_document": return (args.path as string) || "";
    case "index_workspace_documents": return (args.path as string) || ".";
    case "glob_search":     return (args.pattern as string) || "";
    case "grep_search":     return (args.query as string) || "";
    case "execute_command": return (args.command as string) || "";
    case "send_pty_input":  return (args.input as string) || "terminal input";
    case "run_command":     return (args.command as string) || "";
    case "read_pty_buffer": return "terminal";
    case "read_pty_tail":   return "terminal tail";
    case "read_pty_since":  return `terminal @ ${args.offset ?? 0}`;
    case "get_pty_status":  return "terminal status";
    case "clear_pty_buffer": return "terminal buffer";
    case "replace_in_file": return (args.path as string) || "";
    default:                return (args.input as string) || name;
  }
}

function createHookContextMessages(
  event: HookEvent,
  contexts: string[],
): AgentMessage[] {
  return contexts
    .map(context => context.trim())
    .filter(Boolean)
    .map(context => ({
      role: "system" as const,
      content: `[HookContext:${event}]\n${context}`,
    }));
}

function hasToolRoundHistory(messages: AgentMessage[]): boolean {
  return messages.some((message) =>
    message.role === "tool" ||
    (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0),
  );
}

function buildPlanCommandExecutionHint(
  tasks: PlanTask[],
  language: "zh" | "en",
): string {
  const focus = getPendingPlanTaskCommandFocus(tasks, 3);
  if (focus.length === 0) {
    return language === "zh"
      ? "如果某个任务需要运行 shell 命令，请先把精确命令写在 tasks.md 的 checkbox 文本里并用反引号包裹；进入执行后，一次性命令优先调用 run_command 并检查 exitCode/stdout/stderr，长驻或交互式命令调用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查输出，不能只用文字复述。"
      : "If a task requires shell commands, write the exact commands inside the tasks.md checkbox text using backticks. During execution, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status. Do not merely describe commands in prose.";
  }

  const detail = focus
    .map(({ task, commands }) =>
      language === "zh"
        ? `任务：${task.text}\n命令：${commands.map((command) => `\`${command}\``).join("、")}`
        : `Task: ${task.text}\nCommands: ${commands.map((command) => `\`${command}\``).join(", ")}`,
    )
    .join("\n\n");

  return language === "zh"
    ? "在当前未完成任务里检测到了必须实际运行的 shell 命令。一次性命令请优先调用 run_command；长驻或交互式命令调用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查结果；不要只在正文里重复这些命令：\n\n" + detail
    : "The remaining tasks include shell commands that must be run for real. Prefer run_command for finite commands; for long-running or interactive commands call execute_command and verify with read_pty_since/read_pty_tail/get_pty_status. Do not just repeat them in prose:\n\n" + detail;
}

function shouldTreatCloudGatewayErrorAsCompatibility(
  errMsg: string,
  isCloudProfile: boolean,
  messages: AgentMessage[],
  nativeToolsWereAttempted: boolean,
): boolean {
  if (!isCloudProfile || !isRetryableCloudErrorMessage(errMsg)) return false;
  return nativeToolsWereAttempted || hasToolRoundHistory(messages);
}

async function runLifecycleHooks(
  callbacks: OrchestratorCallbacks,
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
  event: HookEvent,
  payload: Record<string, unknown>,
) {
  const enabledHooks = hooksConfig.hooks[event].filter(hook => hook.enabled);
  enabledHooks.forEach(hook => callbacks.onHookStart(event, hook));

  const result = await runHookEvent(hooksConfig, event, payload);
  result.records.forEach(record => callbacks.onHookResult(record));
  if (result.blocked) {
    callbacks.onHookBlocked(
      event,
      result.blockedReason ?? `${event} was blocked by a hook.`,
      result.records[result.records.length - 1],
    );
  }
  return result;
}

/**
 * Fetches a full LLM response via SSE streaming.
 * Returns the complete StreamResult (text + tool calls).
 *
 * Enhanced with max output tokens escalation from claude-code-haha:
 * If the response is truncated (finish_reason: "length"), we retry
 * with a higher max_tokens up to 64k.
 */
async function fetchLLMStream(
  messages: AgentMessage[],
  settings: StreamSettings,
  messageId: string,
  callbacks: OrchestratorCallbacks,
  signal: AbortSignal,
  allTools: ToolDefinition[],
  maxTokensOverride?: number,
): Promise<StreamResult> {
  let fullText = "";
  let currentMaxTokens = maxTokensOverride ?? computeInitialMaxTokens(settings.contextLimit);
  let transientRetryCount = 0;

  // Max output tokens escalation loop (from claude-code-haha)
  const MAX_ESCALATIONS = 3;
  const MAX_TRANSIENT_RETRIES = 2;
  let escalationCount = 0;

  while (true) {
    fullText = "";
    let result: StreamResult;
    try {
      result = await new Promise<StreamResult>((resolve, reject) => {
        let settled = false;
        const safeResolve = (r: StreamResult) => { if (!settled) { settled = true; resolve(r); } };
        const safeReject = (err: Error) => { if (!settled) { settled = true; reject(err); } };

        streamChatCompletion(
          messages,
          settings,
          {
            onToken: (token) => {
              fullText += token;
              callbacks.onStreamToken(token, messageId);
            },
            onDone: (result) => {
              if (signal.aborted) {
                const abortErr = new Error("Aborted");
                abortErr.name = "AbortError";
                safeReject(abortErr);
                return;
              }
              safeResolve(result);
            },
            onError: (err) => {
              safeReject(err);
            },
          },
          signal,
          allTools,
          currentMaxTokens,
        );
      });
    } catch (err) {
      const retryMessage = getErrorMessage(err, "LLM stream failed");
      if (
        !signal.aborted &&
        transientRetryCount < MAX_TRANSIENT_RETRIES &&
        isRetryableCloudErrorMessage(retryMessage)
      ) {
        transientRetryCount++;
        callbacks.onStreamToken("__ESCALATION_RESET__:", messageId);
        console.warn(`[orchestrator] transient cloud error, retrying request (${transientRetryCount}/${MAX_TRANSIENT_RETRIES})`, retryMessage);
        await new Promise((resolve) => setTimeout(resolve, 350 * transientRetryCount));
        continue;
      }
      throw err;
    }

    // Check if the response was truncated and we can escalate
    if (result.finishReason === "length" && escalationCount < MAX_ESCALATIONS) {
        const nextMaxTokens = escalateMaxTokens(currentMaxTokens, settings.contextLimit);
      if (nextMaxTokens !== null) {
        escalationCount++;
        currentMaxTokens = nextMaxTokens;
        console.log(`[orchestrator] Max output tokens escalated to ${currentMaxTokens} (attempt ${escalationCount})`);

        // Clear the previous streaming content for this message
        // by resetting — the caller's onStreamToken will accumulate fresh content
        callbacks.onStreamToken("__ESCALATION_RESET__:", messageId);

        continue; // Retry with higher max_tokens
      }
    }

    const truncated = result.finishReason === "length";
    callbacks.onStreamDone(fullText, messageId, truncated);
    return result;
  }
}

// ── Tool Execution ─────────────────────────────────────────────────

interface ToolCallToExecute {
  id: string;
  name: string;
  arguments: string;
}

interface ToolExecutionResult {
  toolCallId: string;
  name: string;
  target: string;
  content: string; // result or error message
  isError: boolean;
  additionalContexts?: string[];
}

async function executeToolCallWithLifecycle(
  tc: ToolCallToExecute,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
): Promise<ToolExecutionResult> {
  const sessionKey = callbacks.getSessionKey();
  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = JSON.parse(tc.arguments);
  } catch {
    return {
      toolCallId: tc.id,
      name: tc.name,
      target: "",
      content: `Error: Invalid JSON in tool call arguments: ${tc.arguments}`,
      isError: true,
    };
  }

  // Validate required parameters before execution
  const validationError = validateToolArgs(tc.name, toolArgs, allTools);
  if (validationError) {
    callbacks.onToolError(tc.name, "", validationError);
    return { toolCallId: tc.id, name: tc.name, target: "", content: `Error: ${validationError}`, isError: true };
  }

  const preHookResult = await runLifecycleHooks(callbacks, hooksConfig, "PreToolUse", {
    toolName: tc.name,
    toolArgs,
    workspace,
    workflowMode: callbacks.getWorkflowMode(),
    language: callbacks.getPreferredLanguage(),
    associatedPaths: callbacks.getAssociatedPaths(),
  });

  const effectiveArgs = preHookResult.updatedToolArgs ?? toolArgs;
  const resolvedArgs =
    tc.name === "read_file" && typeof effectiveArgs.path === "string"
      ? {
          ...effectiveArgs,
          path: resolveProtocolPackageReadPath(effectiveArgs.path, callbacks.getSkills(), workspace),
        }
      : effectiveArgs;
  const target = getToolTarget(tc.name, resolvedArgs);

  if (preHookResult.blocked) {
    const reason = preHookResult.blockedReason ?? `${tc.name} was blocked by a PreToolUse hook.`;
    callbacks.onToolError(tc.name, target, reason);
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: `Error: ${reason}`,
      isError: true,
      ...(preHookResult.additionalContexts.length > 0
        ? { additionalContexts: preHookResult.additionalContexts }
        : {}),
    };
  }

  const diffPreview = await buildToolDiffPreview(tc.name, effectiveArgs, { workspace, sessionKey });
  callbacks.onToolExecuting(tc.name, target, diffPreview);

  try {
    const rawResult = await executeTool(tc.name, resolvedArgs, workspace, sessionKey);
    const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
    const truncated = resultStr.length > 8000
      ? resultStr.slice(0, 8000) + `\n...[truncated, ${resultStr.length - 8000} chars omitted]`
      : resultStr;

    // 计划文件会在 Plan 面板中单独展示，不再依赖聊天区自己拼装。
    await syncPlanArtifactAfterToolSuccess(
      tc.name,
      resolvedArgs,
      {
        onPlanArtifactUpdated: callbacks.onPlanArtifactUpdated,
        onPlanTasksUpdated: callbacks.onPlanTasksUpdated,
      },
      {
        readFile: async (path) => {
          const content = await executeTool("read_file", { path }, workspace, sessionKey);
          return String(content ?? "");
        },
        warn: (message, error) => console.warn(message, error),
      },
    );

    const postHookResult = await runLifecycleHooks(callbacks, hooksConfig, "PostToolUse", {
      toolName: tc.name,
      toolArgs: resolvedArgs,
      toolResult: resultStr,
      isError: false,
      workspace,
      workflowMode: callbacks.getWorkflowMode(),
      language: callbacks.getPreferredLanguage(),
      associatedPaths: callbacks.getAssociatedPaths(),
    });

    callbacks.onToolDone(tc.name, target, truncated);
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: truncated,
      isError: false,
      additionalContexts: [
        ...preHookResult.additionalContexts,
        ...postHookResult.additionalContexts,
      ],
    };
  } catch (err) {
    // ── Error Feedback Pattern (claude-code-haha) ────────────
    // Instead of throwing, we return the error as a tool result.
    // The AI sees the error and can self-correct (e.g., try a different path).
    const errorMsg = (err as Error).message || String(err);
    callbacks.onToolError(tc.name, target, errorMsg);
    const postHookResult = await runLifecycleHooks(callbacks, hooksConfig, "PostToolUse", {
      toolName: tc.name,
      toolArgs: resolvedArgs,
      toolResult: errorMsg,
      isError: true,
      workspace,
      workflowMode: callbacks.getWorkflowMode(),
      language: callbacks.getPreferredLanguage(),
      associatedPaths: callbacks.getAssociatedPaths(),
    });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: `Error: ${errorMsg}`,
      isError: true,
      additionalContexts: [
        ...preHookResult.additionalContexts,
        ...postHookResult.additionalContexts,
      ],
    };
  }
}

/**
 * Execute read-only tools concurrently.
 * From claude-code-haha's toolOrchestration.ts: safe tools can run in parallel.
 */
async function executeReadOnlyToolsConcurrently(
  toolCalls: ToolCallToExecute[],
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
): Promise<ToolExecutionResult[]> {
  const promises = toolCalls.map(tc =>
    executeToolCallWithLifecycle(tc, workspace, callbacks, allTools, hooksConfig),
  );
  return Promise.all(promises);
}

/**
 * Execute a write/execute tool through the human-in-the-loop gate.
 */
async function executeWriteToolWithReview(
  tc: ToolCallToExecute,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
): Promise<ToolExecutionResult> {
  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = JSON.parse(tc.arguments);
  } catch {
    return {
      toolCallId: tc.id,
      name: tc.name,
      target: "",
      content: `Error: Invalid JSON in tool call arguments: ${tc.arguments}`,
      isError: true,
    };
  }

  // Validate required parameters before presenting to user
  const validationError = validateToolArgs(tc.name, toolArgs, allTools);
  if (validationError) {
    return { toolCallId: tc.id, name: tc.name, target: "", content: `Error: ${validationError}`, isError: true };
  }

  const target = getToolTarget(tc.name, toolArgs);
  callbacks.onStatusChange("pending_review");

  let decision: ReviewDecision;
  try {
    decision = await callbacks.requestReview({ name: tc.name, arguments: toolArgs });
  } catch {
    callbacks.onStatusChange("idle");
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: "User cancelled the review.",
      isError: true,
    };
  }

  callbacks.onStatusChange("running");

  let content: string;
  let isError: boolean;

  if (decision.action === "accept") {
    const execution = await executeToolCallWithLifecycle(
      tc,
      workspace,
      callbacks,
      allTools,
      hooksConfig,
    );
    return execution;
  } else if (decision.action === "reject") {
    content = "User rejected the tool call. Try a different approach.";
    isError = false; // Not an error per se — the AI should try a different approach
  } else {
    content = `Tool execution failed: ${decision.error}`;
    isError = true;
  }

  return { toolCallId: tc.id, name: tc.name, target, content, isError };
}

// ── The Loop ──────────────────────────────────────────────────────

const MAX_ITERATIONS = 25;
const MAX_ITERATIONS_PLAN_EXECUTION = 50;

/**
 * Execute the Agent loop.
 *
 * Flow (based on claude-code-haha's query.ts queryLoop):
 * 1. Build/manage context (compact + trim)
 * 2. Stream LLM response (text + tool_calls)
 *    - On context_length_exceeded: reactive compact and retry
 *    - On max_tokens truncation: escalate max_tokens and retry
 * 3. If tool_calls found:
 *    a. Read-only tools → auto-execute (concurrently when possible)
 *    b. Write/execute tools → gate through requestReview
 * 4. Append assistant message (with tool_calls) + tool result messages
 * 5. Loop until the model returns a plain text response.
 */
export async function executeAgentLoop(
  callbacks: OrchestratorCallbacks,
  abortController: AbortController,
): Promise<void> {
  const config = callbacks.getConfig();
  const isCloudProfile = config.activeProfile === "cloud";
  const skills = callbacks.getSkills();
  const initialMessages = callbacks.getMessages();
  const supportsNativeTools = !(isCloudProfile && config.cloud.apiFormat === "responses");
  const nativeToolsEnabled = supportsNativeTools && !hasProviderNativeToolsDisabled(initialMessages);
  const settings = deriveStreamSettings(config);
  const workspace = config.workspace;
  const mainModeKey = callbacks.getMainModeKey();
  const workspaceTree = callbacks.getWorkspaceTree();

  console.log('[orchestrator] executeAgentLoop');
  console.log('[orchestrator] activeProfile:', config.activeProfile);
  console.log('[orchestrator] derived settings:', JSON.stringify({
    baseUrl: settings.baseUrl,
    model: settings.model,
    useRustProxy: settings.useRustProxy,
    hasApiKey: !!settings.apiKey,
    provider: settings.provider,
    nativeToolsEnabled,
  }));

  // ── Config Snapshot ──────────────────────────────────────────────
  // Local profile uses the slider-driven context limit. Cloud profile
  // bypasses local KV-cache/context compression entirely.
  const snapshotContextLimit = isCloudProfile ? undefined : config.local.contextLimit;

  // Discover MCP tools from configured servers
  const mcpServers = callbacks.getMcpServers();
  let mcpTools = callbacks.getMcpDiscoveredTools();

  if (mcpServers.length > 0) {
    console.log(`[orchestrator] Discovering tools from ${mcpServers.length} MCP server(s)...`);
    const { tools: discovered, toolServerMap } = await discoverAllMcpTools(mcpServers);
    if (discovered.length > 0) {
      console.log(`[orchestrator] Discovered ${discovered.length} MCP tool(s):`, discovered.map(t => t.name).join(", "));
      mcpTools = discovered;
      // Update the module-level routing map so toolExecutor can look up MCP tools
      setMcpToolServerMap(toolServerMap);
    } else {
      console.log(`[orchestrator] No MCP tools discovered (servers may be offline).`);
    }
  }

  // Build merged tool definitions: built-in tools + active skill-based tools + MCP tools
  const allTools = buildToolDefinitions(skills, mcpTools);
  const resolveLlmTools = () =>
    supportsNativeTools && !hasProviderNativeToolsDisabled(callbacks.getMessages()) ? allTools : [];
  const turnIntent = callbacks.getCurrentRunIntent();
  const workflowMode = callbacks.getWorkflowMode();
  const associatedPaths = callbacks.getAssociatedPaths();
  const resolvedInstructions = config.instructionsEnabled
    ? await loadResolvedInstructions(workspace, skills, associatedPaths)
    : {
        layers: [],
        templates: [],
        sources: [],
        matchedRules: [],
        associatedPaths: [],
        loadedAt: Date.now(),
        debugSummary: "Workspace instructions are disabled.",
      };
  callbacks.onInstructionsResolved(resolvedInstructions);

  const hooksConfig = config.hooksEnabled
    ? await loadHooksConfig(workspace)
    : {
        path: null,
        hooks: {
          SessionStart: [],
          UserPromptSubmit: [],
          PreToolUse: [],
          PostToolUse: [],
        },
        loadedAt: Date.now(),
      };
  callbacks.onHooksLoaded(
    Object.values(hooksConfig.hooks).flat(),
    hooksConfig.loadedAt,
  );

  // ── Dynamic System Prompt Refresh ──────────────────────────────────
  // Rebuild the system prompt on every agent loop invocation to ensure
  // that any changes in active skills or model configuration are
  // immediately reflected in the LLM's context.
  const messages = callbacks.getMessages();
  const mcpToolNames = mcpTools.map(t => t.name);
  const customToolNames = skills
    .filter(s => s.active && s.type === "tool")
    .map(s => skillNameToToolName(s.name))
    .filter(Boolean);

  const systemPrompt = buildSystemPrompt(
    skills,
    workspace,
    mainModeKey,
    workspaceTree,
    customToolNames,
    mcpToolNames,
    workflowMode,
    callbacks.getPreferredLanguage(),
    resolvedInstructions,
    {
      initialized: callbacks.getGameStudioInitialized(),
      activeStudioAgentKey: callbacks.getActiveStudioAgentKey(),
      pendingSlashCommand: callbacks.getPendingSlashCommand(),
    },
    turnIntent,
  );

  if (messages.length === 0) {
    // Initial message
    callbacks.appendMessage({ role: "system", content: systemPrompt });
  } else if (messages[0].role === "system") {
    // Refresh existing system prompt with current state
    const refreshed = [...messages];
    refreshed[0] = { ...refreshed[0], content: systemPrompt };
    callbacks.replaceMessages(refreshed);
  } else {
    // Prepend system prompt if missing (e.g. from an imported session)
    callbacks.replaceMessages([{ role: "system", content: systemPrompt }, ...messages]);
  }

  if (config.hooksEnabled) {
    const sessionKey = callbacks.getSessionKey();
    if (!callbacks.hasSessionHookInitialized(sessionKey)) {
      const sessionHookResult = await runLifecycleHooks(
        callbacks,
        hooksConfig,
        "SessionStart",
        {
          workspace,
          workflowMode,
          language: callbacks.getPreferredLanguage(),
          sessionKey,
        },
      );
      createHookContextMessages("SessionStart", sessionHookResult.additionalContexts)
        .forEach(message => callbacks.appendMessage(message));
      callbacks.markSessionHookInitialized(sessionKey);
      if (sessionHookResult.blocked) {
        callbacks.onStatusChange("idle");
        return;
      }
    }

    const lastUserMessage = [...callbacks.getMessages()]
      .reverse()
      .find(message => message.role === "user");
    const userPrompt = lastUserMessage ? extractCompatibilityTextContent(lastUserMessage.content) : "";
    const promptHookResult = await runLifecycleHooks(
      callbacks,
      hooksConfig,
      "UserPromptSubmit",
      {
        workspace,
        workflowMode,
        language: callbacks.getPreferredLanguage(),
        prompt: userPrompt,
        associatedPaths,
      },
    );

    createHookContextMessages("UserPromptSubmit", promptHookResult.additionalContexts)
      .forEach(message => callbacks.appendMessage(message));
    if (promptHookResult.blocked) {
      callbacks.onStatusChange("idle");
      return;
    }
  }

  callbacks.onStatusChange("running");

  let iteration = 0;
  let consecutiveNoToolCount = 0;
  let consecutiveEmptyResponseCount = 0;
  let currentMaxTokens: number | undefined; // undefined = use default
  let sawPlanModeToolActivity = false;

  // ── Strict Repeat Guard ──────────────────────────────────────────
  // Track recent tool calls to detect repetition loops. For read-only
  // tools, inject one recovery hint back into the loop before treating
  // the pattern as fatal, so the model gets a chance to pivot tools.
  const recentToolCalls: Array<{ name: string; argsKey: string }> = [];
  const repeatGuardRecoveredSignatures = new Set<string>();

  // ── Plan Mode Gate ──────────────────────────────────────────────
  // In Plan mode, the agent should pause after presenting a plan and
  // wait for user approval before proceeding with write operations.
  // This helper checks if the loop should pause for plan review.
  async function waitForPlanApprovalIfNeeded(): Promise<boolean> {
    if (workflowMode !== "plan") return true; // Not in plan mode, continue
    if (callbacks.getIsPlanApproved()) return true; // Already approved

    // Pause the loop and wait for user approval
    callbacks.onStatusChange("pending_review");

    // Wait for the plan to be approved (polling approach since we can't
    // easily add a new Promise-based gate without refactoring the entire
    // callback architecture). The UI will show a "Start Execution" button.
    return new Promise<boolean>((resolve) => {
      const checkInterval = setInterval(() => {
        if (abortController.signal.aborted) {
          clearInterval(checkInterval);
          resolve(false);
          return;
        }
        if (callbacks.getIsPlanApproved()) {
          clearInterval(checkInterval);
          resolve(true);
        }
      }, 300);
    });
  }

  const effectiveMaxIterations = workflowMode === "plan"
    ? MAX_ITERATIONS_PLAN_EXECUTION
    : MAX_ITERATIONS;

  while (iteration < effectiveMaxIterations) {
    iteration++;

    if (abortController.signal.aborted) {
      callbacks.onStatusChange("idle");
      return;
    }

    // ── Pre-LLM Turn Preparation ──
    callbacks.startNewTurn();

    // 1. Local-only context management. Cloud mode sends the full history
    // and lets the remote server enforce its own context policy.
    let managedAgentMessages = callbacks.getMessages() as AgentMessage[];
    if (snapshotContextLimit != null) {
      const contextLimit = snapshotContextLimit;
      const { outputBudget } = computeContextBudgets(contextLimit);
      const managedResult = manageContext(
        callbacks.getMessages(),
        contextLimit,
        outputBudget,
        1200, // maxToolResultTokens: aggressively truncate tool results
        800,  // maxAssistantTokens: aggressively truncate assistant prose
      );
      managedAgentMessages = managedResult.messages as AgentMessage[];
      if (managedResult.changed) {
        callbacks.replaceMessages(managedAgentMessages);
      }
      if (managedResult.changed && managedResult.tokenReduction > 0) {
        callbacks.onContextCompress({
          droppedCount: managedResult.droppedCount,
          tokenCountBefore: managedResult.tokenCountBefore,
          tokenCountAfter: managedResult.tokenCountAfter,
          tokenReduction: managedResult.tokenReduction,
        }, "proactive");
      }
    }

    // 2. Stream LLM response
    const assistantMsgId = generateId();
    let streamResult: StreamResult;

    try {
      streamResult = await fetchLLMStream(
        managedAgentMessages,
        settings,
        assistantMsgId,
        callbacks,
        abortController.signal,
        resolveLlmTools(),
        currentMaxTokens,
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        callbacks.onStatusChange("idle");
        return;
      }

      // ── Reactive Compact (local profile only) ───────────────
      // If the error is a context_length_exceeded, compact the messages
      // more aggressively and retry once.
      const errMsg = (err as Error).message || "";
      const nativeToolsWereAttempted = resolveLlmTools().length > 0;
      const isContextError =
        (err as Error & { isContextError?: boolean }).isContextError === true ||
        errMsg.includes("CONTEXT_LENGTH_EXCEEDED") ||
        errMsg.includes("context_length_exceeded") ||
        errMsg.includes("context window") ||
        errMsg.includes("maximum context length") ||
        errMsg.includes("token limit");
      const isCompatibilityError =
        isProviderCompatibilityErrorMessage(errMsg) ||
        shouldTreatCloudGatewayErrorAsCompatibility(
          errMsg,
          isCloudProfile,
          managedAgentMessages,
          nativeToolsWereAttempted,
        );

      if (isContextError && snapshotContextLimit != null) {
        console.log("[orchestrator] Context length exceeded — reactive compact and retry");

        // More aggressive compaction: reduce tool result budget and output budget
        const aggressiveOutputBudget = 1024;
        const maxToolResultTokens = 800;
        const aggressivelyManagedResult = manageContext(
          callbacks.getMessages(),
          snapshotContextLimit,
          aggressiveOutputBudget,
          maxToolResultTokens,
          600,
        );
        const aggressivelyManaged = aggressivelyManagedResult.messages as AgentMessage[];
        if (aggressivelyManagedResult.changed) {
          callbacks.replaceMessages(aggressivelyManaged);
        }
        if (aggressivelyManagedResult.changed && aggressivelyManagedResult.tokenReduction > 0) {
          callbacks.onContextCompress({
            droppedCount: aggressivelyManagedResult.droppedCount,
            tokenCountBefore: aggressivelyManagedResult.tokenCountBefore,
            tokenCountAfter: aggressivelyManagedResult.tokenCountAfter,
            tokenReduction: aggressivelyManagedResult.tokenReduction,
          }, "reactive");
        }

        // Retry once with the compacted context
        try {
          streamResult = await fetchLLMStream(
            aggressivelyManaged,
            settings,
            assistantMsgId,
            callbacks,
            abortController.signal,
            resolveLlmTools(),
            2048, // Lower max_tokens for the retry
          );
        } catch (retryErr) {
          if ((retryErr as Error).name === "AbortError") {
            callbacks.onStatusChange("idle");
            return;
          }

          // Second retry: strip tool_calls from messages entirely (some providers
          // like Ollama choke on tool_calls in message history) and retry with
          // plain text-only messages
          console.log("[orchestrator] Second retry: stripping tool_calls from messages");
          const strippedMessages = buildCompatibilityRetryMessages(aggressivelyManaged);

          try {
            streamResult = await fetchLLMStream(
              strippedMessages,
              settings,
              assistantMsgId,
              callbacks,
              abortController.signal,
              resolveLlmTools(),
              2048,
            );
          } catch (finalErr) {
            if ((finalErr as Error).name === "AbortError") {
              callbacks.onStatusChange("idle");
              return;
            }
            callbacks.onError(`Context too long even after compaction. Please start a new conversation or reduce context.`);
            callbacks.onStatusChange("error");
            return;
          }
        }
      } else if (isContextError) {
        callbacks.onError("Remote context limit exceeded. Cloud mode is not using local context compression, so please start a new conversation or shorten the history.");
        callbacks.onStatusChange("error");
        return;
      } else if (isCompatibilityError) {
        console.log("[orchestrator] Provider compatibility retry: flattening history for cloud request");
        const compatibilityMessages = ensureProviderCompatibilityMode(
          buildCompatibilityRetryMessages(managedAgentMessages),
          workflowMode,
        );

        try {
          streamResult = await fetchLLMStream(
            compatibilityMessages,
            settings,
            assistantMsgId,
            callbacks,
            abortController.signal,
            resolveLlmTools(),
            currentMaxTokens,
          );
        } catch (retryErr) {
          if ((retryErr as Error).name === "AbortError") {
            callbacks.onStatusChange("idle");
            return;
          }

          const retryMsg = (retryErr as Error).message || "";
          const retryLooksLikeCompatibility =
            isProviderCompatibilityErrorMessage(retryMsg) ||
            (isCloudProfile && isRetryableCloudErrorMessage(retryMsg));

          if (retryLooksLikeCompatibility) {
            const providerCompatibilityMessages = ensureProviderCompatibilityMode(
              compatibilityMessages,
              workflowMode,
            );
            callbacks.replaceMessages(providerCompatibilityMessages);
            try {
              streamResult = await fetchLLMStream(
                providerCompatibilityMessages,
                settings,
                assistantMsgId,
                callbacks,
                abortController.signal,
                [],
                currentMaxTokens,
              );
            } catch (finalErr) {
              if ((finalErr as Error).name === "AbortError") {
                callbacks.onStatusChange("idle");
                return;
              }
              const transcriptMessages = buildTranscriptCompatibilityRetryMessages(
                managedAgentMessages,
                workflowMode,
              );
              callbacks.replaceMessages(transcriptMessages);
              try {
                streamResult = await fetchLLMStream(
                  transcriptMessages,
                  settings,
                  assistantMsgId,
                  callbacks,
                  abortController.signal,
                  [],
                  currentMaxTokens,
                );
              } catch (lastErr) {
                if ((lastErr as Error).name === "AbortError") {
                  callbacks.onStatusChange("idle");
                  return;
                }
                const lastErrorMessage = getErrorMessage(lastErr, "未知错误");
                callbacks.onError(
                  "当前云端服务对会话内容格式兼容性较弱。我已经自动尝试过精简历史、关闭原生 tools，并回退到单条纯文本 transcript，但仍被服务端拒绝。请先新建一个纯文本新会话再试，或换一个兼容性更好的 OpenAI 协议网关。\n\n上游返回：" + lastErrorMessage,
                );
                callbacks.onStatusChange("error");
                return;
              }
            }
          } else {
            callbacks.onError(getErrorMessage(retryErr, retryMsg || "LLM stream failed"));
            callbacks.onStatusChange("error");
            return;
          }
        }
      } else {
        callbacks.onError(getErrorMessage(err, "LLM stream failed"));
        callbacks.onStatusChange("error");
        return;
      }
    }

    const streamText = streamResult.content;

    // 3. 将不同模型输出统一整理成标准结构，避免 UI 继续靠多处分支猜测。
    const normalized = ensureVisibleConclusion(normalizeAssistantTurn(streamResult));
    if (isAssistantTurnEmpty(normalized)) {
      consecutiveEmptyResponseCount++;
      if (consecutiveEmptyResponseCount >= 3) {
        callbacks.onError(
          isCloudProfile
            ? "云端模型连续返回空响应，当前网关兼容性可能不稳定。请新建一个纯文本会话再试，或切换到兼容性更好的 OpenAI 协议网关。"
            : "模型连续返回空响应，没有产生可见正文或工具调用。请重试，或切换到更稳定的本地模型。",
        );
        callbacks.onStatusChange("error");
        return;
      }

      callbacks.appendMessage({
        role: "user",
        content:
          workflowMode === "chat"
            ? "上一条回复是空的。请直接输出对用户可见的 Markdown 正文来回答用户；如果确实需要工具，请使用正式工具调用。不要只返回空消息，也不要只输出不可见的 thinking/analysis 标签。现在继续。"
            : "上一条回复是空的。请继续执行，并确保这次返回可见正文或正式工具调用；不要只返回空消息，也不要只输出不可见的 thinking/analysis 标签。现在继续。",
      });
      continue;
    }
    consecutiveEmptyResponseCount = 0;

    const historyAssistantText = normalized.visibleText || "";
    callbacks.onTurnSummaryReady(normalized.visibleText);

    if (normalized.hiddenThought) {
      callbacks.onThought(normalized.hiddenThought);
    }

    if (normalized.visibleText || normalized.replyOptions.length > 0) {
      callbacks.onAssistantFinalText(normalized.visibleText, normalized.replyOptions);
      if (normalized.visibleText) {
        callbacks.onAssistantText(normalized.visibleText);
      }
    }

    const effectiveToolCalls: Array<{ id: string; name: string; arguments: string }> =
      normalized.toolCalls.map((call) => ({
        id: call.id || `call_${generateId()}`,
        name: call.name,
        arguments: call.arguments,
      }));

    if (workflowMode === "plan" && effectiveToolCalls.length > 0) {
      sawPlanModeToolActivity = true;
    }

    const hasStructuredProposal = hasStructuredPlanProposal(streamText);
    const hasReadyPlanArtifacts = callbacks.getPlanStage() === "ready_to_execute";
    const shouldPauseForUserChoice = shouldPauseForReplyOptions({
      replyOptions: normalized.replyOptions,
      toolCallCount: effectiveToolCalls.length,
      workflowMode,
      hasStructuredProposal,
      hasReadyPlanArtifacts,
      isPlanApproved: callbacks.getIsPlanApproved(),
    });
    const assistantHistoryText = serializeAssistantReplyForHistory(historyAssistantText, normalized.replyOptions);

    // 4. Handle turn termination or continuation
    if (effectiveToolCalls.length === 0) {
        // No tool calls found in this response.
        callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });

        if (shouldPauseForUserChoice) {
          callbacks.onStatusChange("idle");
          return;
        }

        // ── Plan Mode Interception ────────────────────────────────
        // In Plan mode, only enter review when the model has either:
        // 1. submitted a valid top-level proposal payload, or
        // 2. finished writing spec artifacts up to a legacy ready_to_execute stage.
        // Ordinary summaries / progress notes stay in ChatArea only.
        if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && (hasStructuredProposal || hasReadyPlanArtifacts)) {
          const approved = await waitForPlanApprovalIfNeeded();
          if (!approved) {
            // Aborted during plan review — preserve pending_review status
            // so the plan panel stays visible for the user to review.
            // stopGeneration() already handles the isGenerating flag.
            // Only fall back to idle if something else cleared the status.
            if (callbacks.getStatus() !== "pending_review") {
              callbacks.onStatusChange("idle");
            }
            return;
          }
          // Approved — 保留计划文件给右侧 Plan 面板继续展示，执行完成后再统一清理。
          callbacks.onPlanStageChanged("executing");
          const language = callbacks.getPreferredLanguage();
          const continuationMsg: AgentMessage = {
            role: "user",
            content:
              (language === "zh"
                ? "计划已批准，现在进入执行阶段（EXECUTION MODE）。请按以下顺序继续：\n1. 先基于已批准的 requirements/design 或 bugfix 生成 `.MAIN/plans/tasks.md`，把执行任务拆清楚；在 tasks.md 生成前，不要直接跳到源码改动。\n2. 生成 tasks.md 后，TopIsland 会显示任务进度；之后再按 tasks.md 逐个执行，使用 <tool_use> 格式调用工具。\n3. 任何需要 shell 的任务都必须在 tasks.md checkbox 中写出精确命令，并用反引号包裹；进入执行后，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr；长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 验证结果。\n4. 你可以正常修改项目源码文件，写入路径必须是项目中的正确位置，绝对不要将源码写入 `.MAIN/plans/` 或任何隐藏目录。\n5. 每完成一个任务后，先同步更新 `.MAIN/plans/tasks.md` 中对应的 checkbox 状态；只有全部任务都标记为 `[x]` 后，才能结束执行。\n\n"
                : "The plan is approved. You are now in EXECUTION MODE. Continue in this order:\n1. First generate `.MAIN/plans/tasks.md` from the approved requirements/design or bugfix so the execution steps are explicit. Do not jump straight to source edits before tasks.md exists.\n2. After tasks.md is generated, follow it task by task using tool calls.\n3. Any task that needs shell work must include the exact command inside the tasks.md checkbox text using backticks. During execution, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status.\n4. You may now edit project source files, but write them to the proper project paths and never into `.MAIN/plans/` or hidden folders.\n5. After each task, update the matching checkbox in `.MAIN/plans/tasks.md` before moving on; only stop when all tasks are `[x]`.\n\n") +
              buildPlanCommandExecutionHint(callbacks.getPlanTasks(), language),
          };
          callbacks.appendMessage(continuationMsg);
          continue;
        }

        const currentPlanStage = callbacks.getPlanStage();
        const planningStillIncomplete =
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          !hasStructuredProposal &&
          currentPlanStage !== "ready_to_execute";
        const hasMeaningfulVisibleText = normalized.visibleText.trim().length > 0;
        const wasTruncated = normalized.finishReason === "length";
        // If the plan is incomplete, always force continuation — even on the
        // first iteration when planStage is still "idle" and no tool activity
        // has occurred. The model should never stop with a text-only response
        // while the plan hasn't reached a terminal state.
        const shouldForcePlanContinuation = planningStillIncomplete && (isCloudProfile || !hasMeaningfulVisibleText);

        if (shouldForcePlanContinuation) {
          consecutiveNoToolCount++;
          if (consecutiveNoToolCount >= 5) {
            callbacks.onStatusChange("idle");
            return;
          }

          const missingStepHint =
            currentPlanStage === "requirements"
              ? "你已经有 requirements.md，下一步必须继续生成 design.md（或 bugfix.md），再提交正式 Proposal 让用户确认。"
              : currentPlanStage === "design"
              ? "你已经有 design.md，下一步必须输出正式 Proposal，让用户先确认方案；不要在批准前提前生成 tasks.md。"
              : currentPlanStage === "bugfix"
              ? "你已经有 bugfix.md，下一步必须输出正式 Proposal，让用户先确认修复方案；不要在批准前提前生成 tasks.md。"
              : sawPlanModeToolActivity
              ? "你已经开始做项目探索了，但还没有真正落盘完整的规划结果。下一步必须继续输出 requirements.md / design.md（或 bugfix.md）并提交正式 Proposal。"
              : "请继续把计划补全到可执行阶段。";

          const continuationMsg: AgentMessage = {
            role: "user",
            content:
              `当前规划还没有进入可执行阶段。${missingStepHint}\n` +
              "请继续规划，并在本轮结束前至少完成以下其一：\n" +
              "1. 使用 <tool_use> 调用 write_file，将缺失的 requirements/design 或 bugfix 规格写入 `.MAIN/plans/`。\n" +
              "2. 输出正式 Proposal：`[PROPOSAL START]` + `# Proposed Plan` + 结构化 Markdown 正文 + 合法 `<plan>` JSON。\n" +
              "3. 在用户批准之前，不要提前生成执行用的 `tasks.md`。\n" +
              `${wasTruncated ? "你上一条回复已经发生截断，请从中断处继续，不要重头重复。\n" : ""}` +
              `不要只输出一句总结、结束语，或空结束符。\n${hasMeaningfulVisibleText ? "你刚才的说明可以保留，但现在必须继续完成剩余计划。" : ""}`,
          };
          callbacks.appendMessage(continuationMsg);
          continue;
        }

        const missingToolCallRepromptKind = resolveMissingToolCallRepromptKind({
          workflowMode,
          visibleText: normalized.visibleText,
          mainModeKey,
        });
        const shouldRepromptForMissingToolCall =
          (!hasMeaningfulVisibleText && workflowMode !== "chat") ||
          missingToolCallRepromptKind !== "none";

        if (shouldRepromptForMissingToolCall) {
          consecutiveNoToolCount++;
          if (consecutiveNoToolCount >= 5) {
            callbacks.onError("模型连续多次未能正确使用 <tool_use> 格式调用工具，陷入复读循环，已强制中止。你可以尝试更明确地指引它执行。");
            callbacks.onStatusChange("error");
            return;
          }

          const continuationMsg: AgentMessage = {
            role: "user",
            content: buildMissingToolCallContinuationPrompt(
              missingToolCallRepromptKind === "none" ? "generic" : missingToolCallRepromptKind,
              callbacks.getPreferredLanguage(),
            ),
          };
          callbacks.appendMessage(continuationMsg);
          continue;
        }

        // No intent detected — genuinely done
        const hasRemainingApprovedPlanTasks =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          callbacks.getPlanTasks().some((task) => task.status !== "completed");

        if (hasRemainingApprovedPlanTasks) {
          consecutiveNoToolCount++;
          if (consecutiveNoToolCount >= 5) {
            callbacks.onError("计划执行过程中模型连续多次提前停下，但仍有未完成任务。已中止本轮，请重试或切换更稳定的模型。");
            callbacks.onStatusChange("error");
            return;
          }

          const remainingTasks = callbacks.getPlanTasks().filter((task) => task.status !== "completed").slice(0, 3);
          const remainingText = remainingTasks.map((task) => `- ${task.text}`).join("\n");
          const language = callbacks.getPreferredLanguage();
          callbacks.appendMessage({
            role: "user",
            content:
              (language === "zh"
                ? "继续执行 tasks.md 中剩余的未完成任务。不要重复计划说明，直接根据当前进度继续实现下一个任务；如果需要修改文件，继续使用工具调用。凡是任务里带有 shell 命令的，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr；长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查结果。完成当前任务后，先把 `.MAIN/plans/tasks.md` 中对应的 checkbox 更新为 `[x]`，再继续下一项；只有 tasks.md 全部勾选后才能结束。\n下一批优先任务：\n"
                : "Continue executing the remaining incomplete tasks from tasks.md. Do not restate the plan; just move to the next task based on the current progress. If a task includes shell commands, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status. After each task, update the matching checkbox in `.MAIN/plans/tasks.md` before moving on; only stop when all tasks are complete.\nNext priority tasks:\n") +
              remainingText +
              "\n\n" +
              buildPlanCommandExecutionHint(callbacks.getPlanTasks(), language),
          });
          continue;
        }

        if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
          callbacks.onPlanStageChanged("completed");
          try { await deletePlanFiles(); } catch (e) { console.warn("[orchestrator] Failed to delete plan files:", e); }
        }

        // ── Plan-mode safety net ──────────────────────────────────────
        // In plan mode, the loop must NEVER exit via text-only response
        // while the plan is incomplete. All specific checks above should
        // have caught these cases, but if they didn't, re-prompt instead
        // of exiting so the model gets another chance to use tools.
        if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && currentPlanStage !== "ready_to_execute") {
          consecutiveNoToolCount++;
          if (consecutiveNoToolCount >= 5) {
            callbacks.onError("模型在计划模式下多次未能使用工具，已中止。你可以尝试更明确地指引它执行。");
            callbacks.onStatusChange("error");
            return;
          }
          callbacks.appendMessage({
            role: "user",
            content: "你必须使用 <tool_use> 格式调用工具来继续操作。规则：\n" +
              "1. 不要询问用户，自己做决定并执行。\n" +
              "2. 如果不确定，选择最合理的方案直接执行。\n" +
              "3. 格式示例：\n" +
              "<tool_use>\n<tool>write_file</tool>\n<parameter name=\"path\">输出文件路径</parameter>\n<parameter name=\"content\">文件内容</parameter>\n</tool_use>\n" +
              "请立即用上述格式调用工具继续。",
          });
          continue;
        }

        callbacks.onStatusChange("idle");
        return;
      }

    // Tools have been found, reset the no-tool streak
    consecutiveNoToolCount = 0;

    // 4. Process tool calls
    // Append the assistant message with tool_calls
    const toolCallsForMsg: ToolCallInMessage[] = effectiveToolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));

    callbacks.appendMessage({
      role: "assistant",
      content: historyAssistantText,
      tool_calls: toolCallsForMsg,
    });

    // Partition tool calls into read-only (auto-execute), spec file writes
    // (auto-approved in Plan Mode), and write (review-gated)
    const readOnlyCalls: ToolCallToExecute[] = [];
    const specFileCalls: ToolCallToExecute[] = [];
    const writeCalls: ToolCallToExecute[] = [];

    for (const tc of effectiveToolCalls) {
      let toolArgs: Record<string, unknown>;
      try { toolArgs = JSON.parse(tc.arguments); } catch { toolArgs = {}; }

      if (isReadOnlyTool(tc.name)) {
        readOnlyCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
      } else if (workflowMode === "plan" && isSpecFileWrite(tc.name, toolArgs)) {
        specFileCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
      } else {
        writeCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
      }
    }

    // Execute read-only tools concurrently (claude-code-haha pattern)
    let allResults: ToolExecutionResult[] = [];

    if (readOnlyCalls.length > 0) {
      const readResults = await executeReadOnlyToolsConcurrently(
        readOnlyCalls,
        workspace,
        callbacks,
        allTools,
        hooksConfig,
      );
      allResults.push(...readResults);
    }

    // Execute spec file writes concurrently — auto-approved, no user review needed
    if (specFileCalls.length > 0) {
      const specResults = await executeReadOnlyToolsConcurrently(
        specFileCalls,
        workspace,
        callbacks,
        allTools,
        hooksConfig,
      );
      allResults.push(...specResults);
    }

    // Execute write tools sequentially (they may have side effects)
    for (const tc of writeCalls) {
      const result = await executeWriteToolWithReview(
        tc,
        workspace,
        callbacks,
        allTools,
        hooksConfig,
      );
      allResults.push(result);

      // Check if the loop was aborted during user review
      if (abortController.signal.aborted) {
        callbacks.onStatusChange("idle");
        return;
      }
    }

    // Append all tool result messages
    for (const result of allResults) {
      callbacks.appendMessage({
        role: "tool",
        content: result.content,
        tool_call_id: result.toolCallId,
      });
      if (result.additionalContexts?.length) {
        createHookContextMessages("PostToolUse", result.additionalContexts)
          .forEach(message => callbacks.appendMessage(message));
      }
    }

    if (workflowMode === "plan" && callbacks.getIsPlanApproved() && allResults.some((result) => !result.isError)) {
      callbacks.onPlanStageChanged("executing");
    }

    // ── Strict Repeat Guard check ────────────────────────────────────
    // After each batch of tool calls, check for repetition loops
    let recoveredReadOnlyRepeat = false;
    for (const tc of effectiveToolCalls) {
      let toolArgs: Record<string, unknown>;
      try { toolArgs = JSON.parse(tc.arguments); } catch { toolArgs = {}; }
      const readOnly = isReadOnlyTool(tc.name);
      const repeatCheck = registerToolCallForRepeatGuard(recentToolCalls, tc.name, toolArgs, readOnly);
      if (!repeatCheck.repeated) continue;

      const target = getToolTarget(tc.name, toolArgs);
      if (readOnly && !repeatGuardRecoveredSignatures.has(repeatCheck.signature)) {
        const recoveryMessage = formatRepeatLoopRecoveryMessage(tc.name, target, repeatCheck.threshold);
        repeatGuardRecoveredSignatures.add(repeatCheck.signature);
        recentToolCalls.length = 0;
        callbacks.onToolError(tc.name, target, recoveryMessage);
        callbacks.appendMessage({
          role: "system",
          content: `[System: ${recoveryMessage}]`,
        });
        recoveredReadOnlyRepeat = true;
        break;
      }

      callbacks.onError(formatRepeatLoopFatalMessage(tc.name, target, repeatCheck.threshold));
      callbacks.onStatusChange("error");
      return;
    }

    if (recoveredReadOnlyRepeat) {
      continue;
    }

    // Loop continues — the model sees all tool results and can respond
  }

  callbacks.onError(`Agent loop reached maximum iterations (${effectiveMaxIterations}).`);
  callbacks.onStatusChange("idle");
}
