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
import { executeTool } from "./toolExecutor";
import { computeContextBudgets, estimateTokens, manageContext } from "./contextTrim";
import { clampContextLimitToReported } from "./contextWindow";
import { generateId } from "./utils";
import { buildSystemPrompt } from "./systemPrompt";
import { discoverAllMcpTools, getMcpToolServerMap, setMcpToolServerMap, type MCPServer, type MCPTool } from "./mcpClient";
import { getFileMetadata } from "./ipc";
import { ensureVisibleConclusion, isAssistantTurnEmpty, normalizeAssistantTurn } from "./normalizedTurn";
import { hasStructuredPlanProposal } from "./planProposal";
import {
  buildReadOnlyPermissionContinuationPrompt,
  serializeAssistantReplyForHistory,
  shouldAutoContinueReadOnlyPermission as shouldAutoContinueReadOnlyPermissionState,
  shouldPauseForReplyOptions,
  stripReadOnlyPermissionPrompt,
} from "./replyOptions";
import { buildToolDiffPreview, type ToolDiffPreview } from "./toolDiff";
import { syncPlanArtifactAfterToolSuccess } from "./planArtifactSync";
import type { AppConfig, Skill } from "../store/useAppStore";
import {
  detectPlanArtifactKind,
  extractPlanTasks,
  findDroppedPlanTasks,
  getPendingPlanTaskCommandFocus,
  isPlanTaskTrustedComplete,
  validatePlanArtifactContent,
  type PlanExecutionEvidenceEntry,
  type PlanTask,
  type ReplyOption,
} from "./workflowModels";
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
  buildRepeatLoopArgsKey,
  buildRepeatLoopSignature,
  formatRepeatLoopFatalMessage,
  formatRepeatLoopRecoveryMessage,
  registerToolCallForRepeatGuard,
} from "./repetitionGuard";
import {
  buildToolCapabilityRegistry,
  filterToolDefinitionsForIntent,
  isToolAutoExecutableForCall,
  routeMcpToolsForPrompt,
} from "./toolCapabilities";
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
import { isCloudGatewayTimeoutMessage, isRetryableCloudErrorMessage } from "./cloudRetry";
import {
  buildMissingToolCallContinuationPrompt,
  resolveMissingToolCallRepromptKind,
} from "./missingToolCallReprompt";
import { buildPlanApprovalChoiceHint } from "./planControl";

// ── Spec file auto-approval helpers ────────────────────────────────

const PRE_APPROVAL_PLAN_FILE_NAMES = new Set(["requirements.md", "design.md", "bugfix.md"]);
const EXECUTION_PLAN_FILE_NAMES = new Set(["requirements.md", "design.md", "tasks.md", "bugfix.md"]);
const PLAN_ARTIFACT_MUTATION_TOOLS = new Set(["write_file", "replace_in_file"]);
const PLAN_REPEAT_READ_LIMIT = 3;
const EXECUTION_VERIFICATION_TOOL_NAMES = new Set([
  "run_command",
  "execute_command",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

/**
 * Returns true if a mutation targets a spec file inside `.MAIN/plans/`.
 * These are auto-executed in Plan Mode, but the allowed file set depends
 * on the current plan stage.
 */
function getPlanArtifactMutationTarget(name: string, args: Record<string, unknown>): { path: string; fileName: string } | null {
  if (!PLAN_ARTIFACT_MUTATION_TOOLS.has(name)) return null;
  const path = (args.path as string) || "";
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.toLowerCase().includes(".main/plans/")) return null;
  const fileName = normalized.split("/").pop() || "";
  return fileName ? { path, fileName } : null;
}

function isPreApprovalPlanDraftWrite(name: string, args: Record<string, unknown>): boolean {
  const target = getPlanArtifactMutationTarget(name, args);
  return !!target && PRE_APPROVAL_PLAN_FILE_NAMES.has(target.fileName);
}

function isExecutionPlanArtifactWrite(name: string, args: Record<string, unknown>): boolean {
  const target = getPlanArtifactMutationTarget(name, args);
  return !!target && EXECUTION_PLAN_FILE_NAMES.has(target.fileName);
}

function isTasksPlanWrite(name: string, args: Record<string, unknown>): boolean {
  const target = getPlanArtifactMutationTarget(name, args);
  return !!target && target.fileName === "tasks.md";
}

function isPlanArtifactPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().includes(".main/plans/");
}

function isProjectSourceWriteResult(result: ToolExecutionResult): boolean {
  return (
    !result.isError &&
    PLAN_ARTIFACT_MUTATION_TOOLS.has(result.name) &&
    !!result.target &&
    !isPlanArtifactPath(result.target)
  );
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

// region: 上下文压缩预留

function computeToolSchemaReserve(contextLimit: number, tools: ToolDefinition[], extraMargin: number = 0): number {
  const toolTokens = tools.length > 0 ? estimateTokens(JSON.stringify(tools)) : 0;
  const providerMargin = tools.length > 0 ? 768 : 384;
  const reserve = Math.max(providerMargin, Math.round(toolTokens * 0.6) + extraMargin);
  const maxReserve = Math.max(providerMargin, Math.floor(contextLimit * 0.4));
  return Math.min(maxReserve, reserve);
}

function computeManagedContextLimit(contextLimit: number, tools: ToolDefinition[], extraMargin: number = 0): number {
  const effectiveLimit = contextLimit - computeToolSchemaReserve(contextLimit, tools, extraMargin);
  return Math.max(2048, effectiveLimit);
}

// endregion

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

function truncateForLog(value: string, maxLength = 96): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength).trim()}...`;
}

function summarizeReplyOptionsForLog(replyOptions: ReplyOption[], limit = 4) {
  return replyOptions.slice(0, limit).map((option, index) => ({
    index,
    label: truncateForLog(option.label || ""),
    value: truncateForLog(option.value || ""),
    ...(option.action ? { action: option.action } : {}),
  }));
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
  getRuntimeRunIntent?: () => ResolvedUserIntent;
  getWorkflowMode: () => "chat" | "edit" | "plan";
  getIsPlanApproved: () => boolean;
  getPlanApprovalChoice: () => string | null;
  getReadOnlyAutoApproveForSession: () => boolean;
  getPlanStage: () => "idle" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed";
  getPlanTasks: () => PlanTask[];
  getPlanExecutionEvidenceLedger: () => PlanExecutionEvidenceEntry[];
  getStatus: () => "idle" | "running" | "pending_review" | "error";
  startNewTurn: () => void;

  // UI updates
  onStreamToken: (token: string, messageId: string) => void;
  onStreamDone: (fullText: string, messageId: string, truncated: boolean) => void;
  onThought: (thought: string) => void;
  onAssistantFinalText: (text: string, replyOptions?: ReplyOption[]) => void;
  onStatusChange: (status: "idle" | "running" | "pending_review" | "error") => void;
  onError: (error: string) => void;
  onNonActionableStop: (message: string, reason: "no_output" | "no_action" | "missing_tool_loop" | "incomplete_plan") => void;
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
      compressedContext?: string;
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
    case "write_file":      return (args.path as string) || "";
    default:                return (args.input as string) || name;
  }
}

const PROSE_CODE_DUMP_MIN_CHARS = 12_000;
const PROSE_CODE_DUMP_LARGE_CHARS = 32_000;
const MAX_NO_ACTION_RETRIES = 2;

function looksLikeProseCodeDump(text: string): boolean {
  const content = text.trim();
  if (content.length < PROSE_CODE_DUMP_MIN_CHARS) return false;

  const fenceCount = (content.match(/```/g) ?? []).length;
  const fileHeadingCount = (
    content.match(/(?:^|\n)\s*(?:#{1,4}\s*)?(?:文件|File)\s*[:：]\s*[\w./ -]+\.(?:cs|ts|tsx|js|jsx|json|css|html|md|asset|prefab)\b/gi) ?? []
  ).length;
  const pathHeadingCount = (
    content.match(/(?:^|\n)\s*(?:#{1,4}\s*)?[\w.-]+(?:\/[\w.-]+)+\.(?:cs|ts|tsx|js|jsx|json|css|html|md|asset|prefab)\b/g) ?? []
  ).length;
  const codeKeywordCount = (
    content.match(/\b(?:using|namespace|public|private|protected|internal|class|struct|interface|enum|function|const|let|var|import|export)\b/g) ?? []
  ).length;

  if (fenceCount >= 4) return true;
  if (fileHeadingCount + pathHeadingCount >= 2) return true;
  return content.length >= PROSE_CODE_DUMP_LARGE_CHARS && codeKeywordCount >= 30;
}

function shouldCompactProseCodeDump(input: {
  workflowMode: "chat" | "edit" | "plan";
  turnIntent: ResolvedUserIntent;
  visibleText: string;
  toolCallCount: number;
  isPlanApproved: boolean;
}): boolean {
  if (input.toolCallCount > 0) return false;
  if (input.workflowMode === "chat") return false;
  if (input.workflowMode === "plan" && !input.isPlanApproved) return false;
  return looksLikeProseCodeDump(input.visibleText);
}

function buildProseCodeDumpNotice(language: "zh" | "en", charCount: number): string {
  const formatted = charCount.toLocaleString();
  return language === "zh"
    ? `模型刚才把约 ${formatted} 个字符的代码作为聊天正文输出了，但没有通过写入工具落到真实文件。为避免界面卡死，我已将这段超长正文收起；接下来会强制它改用 \`write_file\` / \`replace_in_file\` 写入项目文件。`
    : `The model just produced about ${formatted} characters of code as chat text instead of writing real files. To keep the UI responsive, I compacted that oversized reply and will force the next step to use \`write_file\` / \`replace_in_file\` for actual project files.`;
}

function buildNonActionableStopMessage(language: "zh" | "en", reason: "no_output" | "missing_tool_loop" | "incomplete_plan" | "plain_text_execution"): string {
  if (language === "zh") {
    switch (reason) {
      case "no_output":
        return "模型连续没有产生可见结果或可执行动作，本轮已停止。没有生成计划文件，也没有写入项目文件。";
      case "missing_tool_loop":
        return "模型连续输出说明或代码正文，但没有使用写入/读取工具，本轮已停止。聊天内容不会被当作已写入文件。";
      case "incomplete_plan":
        return "模型没有生成可审批的计划草稿或计划文件，本轮已停止。请重新发送明确要求写入 `.MAIN/plans/requirements.md` 和 `.MAIN/plans/design.md` 的计划请求，或切换到直接执行。";
      default:
        return "模型只输出了文字说明，没有产生真实工具调用或文件变更，本轮已停止。";
    }
  }

  switch (reason) {
    case "no_output":
      return "The model repeatedly produced no visible result or executable action, so this turn stopped. No plan files or project files were created.";
    case "missing_tool_loop":
      return "The model kept producing prose or code in chat without using read/write tools, so this turn stopped. Chat text is not treated as written files.";
    case "incomplete_plan":
      return "The model did not produce a reviewable plan draft or plan files, so this turn stopped. Send a clearer planning request that explicitly writes `.MAIN/plans/requirements.md` and `.MAIN/plans/design.md`, or switch to direct execution.";
    default:
      return "The model only produced prose and did not create real tool calls or file changes, so this turn stopped.";
  }
}

function buildPlanFallbackNotice(language: "zh" | "en", sourceChars: number): string {
  const formatted = sourceChars.toLocaleString();
  return language === "zh"
    ? `模型刚才输出了约 ${formatted} 个字符的规划正文，但没有生成可审批的计划文件。MAIN 会要求模型通过工具写入真实的 \`.MAIN/plans/requirements.md\` 与 \`.MAIN/plans/design.md\`，或先用可点击选项向你确认关键分叉；不会把工具日志或截断内容强行写成计划。`
    : `The model produced about ${formatted} characters of planning text but did not create reviewable plan files. MAIN will ask it to write real \`.MAIN/plans/requirements.md\` and \`.MAIN/plans/design.md\` artifacts through tools, or ask you for the key decision first; tool logs and truncated text will not be forced into plan files.`;
}

function looksLikeToolUnavailableClaim(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  const toolClaim =
    /没有(?:可用|可以调用|能调用|任何)?(?:的)?工具/.test(normalized) ||
    /无法(?:访问|读取|查看|打开|调用|使用).*(?:文件|目录|工作区|工具|本地)/.test(normalized) ||
    /不能(?:访问|读取|查看|打开|调用|使用).*(?:文件|目录|工作区|工具|本地)/.test(normalized) ||
    /(?:no|without|lack|lacks|do not have|don't have|cannot|can't|unable to).{0,80}(?:tool|function|file|folder|filesystem|workspace|local)/i.test(normalized) ||
    /(?:tool|function|file|folder|filesystem|workspace|local).{0,80}(?:unavailable|not available|not accessible|unsupported|disabled)/i.test(normalized);
  return toolClaim;
}

function buildToolUnavailableRecoveryPrompt(language: "zh" | "en", workflowMode: "chat" | "edit" | "plan"): string {
  const writeAllowed = workflowMode === "chat"
    ? language === "zh"
      ? "当前是聊天回合，除非用户明确要求实现或修改，先只使用只读工具。"
      : "This is a chat turn, so use read-only tools unless the user explicitly asked for implementation or edits."
    : language === "zh"
    ? "如果用户要求实现、修复或计划落盘，可以使用写入/执行工具。"
    : "If the user asked for implementation, fixes, or plan artifacts, write/execute tools are available.";

  return language === "zh"
    ? [
        "上一条回复把云端原生 function tools 不可用误解成 MAIN 没有工具。请纠正：MAIN 内置工具可通过 XML `<tool_use>` 调用。",
        "不要再声称无法访问工作区、文件或工具；如果需要上下文，请立即调用合适的 XML 工具。",
        writeAllowed,
        "可用示例：",
        "<tool_use>",
        "<tool>read_file</tool>",
        "<parameter name=\"path\">README.md</parameter>",
        "</tool_use>",
      ].join("\n")
    : [
        "The previous reply confused native function-tools support with MAIN tool availability. Correct this: MAIN built-in tools are available through XML `<tool_use>` calls.",
        "Do not claim that workspace files or tools are unavailable; if context is needed, immediately call the appropriate XML tool.",
        writeAllowed,
        "Example:",
        "<tool_use>",
        "<tool>read_file</tool>",
        "<parameter name=\"path\">README.md</parameter>",
        "</tool_use>",
      ].join("\n");
}

function stripControlPromptForPlanFallback(text: string): string {
  return String(text || "")
    .replace(/^本轮处于 PLAN 模式。[\s\S]*?\n\n/i, "")
    .replace(/^This turn is in PLAN mode\.[\s\S]*?\n\n/i, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, " ")
    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi, " ")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlanControlUserPrompt(text: string): boolean {
  return /^(?:上一条规划内容过长|当前规划还没有进入可执行阶段|计划已批准|请继续上一轮 PLAN|The previous planning reply was too long|The current plan has not reached|The plan is approved|Continue the previous PLAN turn)/i.test(
    String(text || "").trim(),
  );
}

function getOriginalUserPromptForPlanFallback(callbacks: OrchestratorCallbacks): string {
  const userMessages = callbacks.getMessages()
    .filter((message) => message.role === "user")
    .map((message) => stripControlPromptForPlanFallback(extractCompatibilityTextContent(message.content)))
    .filter(Boolean);
  return userMessages.find((text) => !isPlanControlUserPrompt(text)) || userMessages[0] || "";
}

function detectRequestedRootMarkdownDeliverables(text: string): string[] {
  const source = String(text || "");
  const hasRootHint = /(?:根目录|项目根目录|当前项目|workspace root|project root|root directory)/i.test(source);
  const matches = Array.from(source.matchAll(/(?:^|[^\w./-])([A-Za-z][\w.-]*\.md|README\.md|Readme\.md|readme\.md)(?=$|[^\w./-])/g))
    .map((match) => match[1])
    .filter(Boolean);
  const normalized = matches
    .map((name) => name.replace(/^readme\.md$/i, "Readme.md"))
    .filter((name) => !/^(?:requirements|design|tasks|bugfix)\.md$/i.test(name));

  if (normalized.length === 0 && hasRootHint && /(?:md\s*文档|markdown|说明文档|总结.*文档|Readme|README)/i.test(source)) {
    normalized.push("Readme.md");
  }

  return [...new Set(normalized)];
}

function collectFallbackToolHighlights(callbacks: OrchestratorCallbacks, attemptedTargets: string[] = []): string[] {
  const highlights: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const clean = stripControlPromptForPlanFallback(value)
      .replace(/[#>*_`~]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return;
    const shortened = clean.length > 180 ? `${clean.slice(0, 180).trim()}...` : clean;
    const key = shortened.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    highlights.push(shortened);
  };

  attemptedTargets.forEach((target) => add(`模型曾尝试修改：${target}`));

  for (const message of callbacks.getMessages()) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        try {
          const parsed = JSON.parse(call.function.arguments || "{}");
          const target = getToolTarget(call.function.name, parsed);
          if (target) add(`已规划/尝试工具：${call.function.name} -> ${target}`);
        } catch {
          // Ignore malformed historical calls; they are not useful for fallback planning.
        }
      }
    }
    if (message.role === "tool") {
      add(extractCompatibilityTextContent(message.content));
    }
    if (highlights.length >= 10) break;
  }

  return highlights.slice(0, 10);
}

function collectFallbackPlanBullets(sourceText: string, fallbackPrompt: string, maxBullets = 8): string[] {
  const source = stripControlPromptForPlanFallback(sourceText)
    .replace(/[#>*_`~]/g, " ")
    .replace(/(?:[，,。.\-_]\s*){24,}/g, " ")
    .trim();
  const candidates = source
    .split(/\n+|(?<=[。！？.!?])\s+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "").trim())
    .filter((line) =>
      line.length >= 8 &&
      line.length <= 180 &&
      !/^(?:让我|但是等等|不过等等|我认为|实际上|用户说|之前的消息|But wait|I think|Actually|The user says)/i.test(line) &&
      !/<\/?(?:user_options|option|plan)\b/i.test(line),
    );

  const bullets: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(candidate);
    if (bullets.length >= maxBullets) break;
  }

  if (bullets.length > 0) return bullets;
  const fallback = stripControlPromptForPlanFallback(fallbackPrompt);
  return fallback
    ? [fallback.length > 160 ? `${fallback.slice(0, 160).trim()}...` : fallback]
    : [];
}

function buildPlanRecoveryPrompt(callbacks: OrchestratorCallbacks, sourceText: string, attemptedTargets: string[] = []): string {
  const language = callbacks.getPreferredLanguage();
  const userPrompt = getOriginalUserPromptForPlanFallback(callbacks);
  const toolHighlights = collectFallbackToolHighlights(callbacks, attemptedTargets)
    .filter((item) => !/Repeated read-only tool call skipped|Duplicate skip count|already called with identical arguments/i.test(item))
    .slice(0, 6);
  const bullets = collectFallbackPlanBullets(sourceText, userPrompt, 6);
  const contextSummary = [
    userPrompt ? (language === "zh" ? `用户原始目标：${userPrompt}` : `Original user goal: ${userPrompt}`) : "",
    bullets.length > 0
      ? (language === "zh" ? `可用规划要点：\n${bullets.map((item) => `- ${item}`).join("\n")}` : `Useful planning points:\n${bullets.map((item) => `- ${item}`).join("\n")}`)
      : "",
    toolHighlights.length > 0
      ? (language === "zh" ? `已读取/尝试的上下文：\n${toolHighlights.map((item) => `- ${item}`).join("\n")}` : `Context already read/tried:\n${toolHighlights.map((item) => `- ${item}`).join("\n")}`)
      : "",
  ].filter(Boolean).join("\n\n");

  if (language === "en") {
    return [
      "The previous planning output did not produce valid reviewable plan files. Regenerate the plan correctly now.",
      "",
      contextSummary,
      "",
      "Rules:",
      "- Do not copy tool logs, duplicate-call warnings, hidden thinking, raw source code, or truncation messages into plan files.",
      "- `requirements.md` must summarize the user's intent into real requirements: goal, scope, findings, deliverables, acceptance criteria, and open questions.",
      "- `design.md` must be executable: affected files/modules, ordered implementation strategy, data/control flow, validation, and risks. For complex implementations, include one concise Mermaid diagram by default; skip diagrams for simple structures unless the user explicitly asks for one.",
      "- If a design direction is unclear, ask the user with `<user_options>` and stop. Do not invent a final design.",
      "- If the direction is clear, call `write_file` or `replace_in_file` to create/update concise `.MAIN/plans/requirements.md` and `.MAIN/plans/design.md`, then submit the normal Proposal for approval. Do not generate `tasks.md` before approval.",
    ].filter(Boolean).join("\n");
  }

  return [
    "上一轮规划没有产出有效的可审批计划文件。现在请重新生成真正的计划。",
    "",
    contextSummary,
    "",
    "规则：",
    "- 不要把工具日志、重复调用提示、后台思考、原始源码或截断提示写进计划文件。",
    "- `requirements.md` 必须总结用户真实意图并形成需求规格：目标、范围、当前发现、交付物、验收标准、待确认问题。",
    "- `design.md` 必须是可执行方案：影响文件/模块、执行顺序、数据流/控制流、验证方式和风险。复杂实现默认包含 1 个简短 Mermaid 图；简单结构不需要，除非用户明确要求生成图。",
    "- 如果设计方向不明确，使用 `<user_options>` 让用户选择并立刻停止；不要编造最终方案。",
    "- 如果方向已经明确，必须调用 `write_file` 或 `replace_in_file` 创建/更新精简的 `.MAIN/plans/requirements.md` 与 `.MAIN/plans/design.md`，然后提交正常 Proposal 等待审批。批准前不要生成 `tasks.md`。",
  ].filter(Boolean).join("\n");
}

function isReviewablePlanStage(stage: ReturnType<OrchestratorCallbacks["getPlanStage"]>): boolean {
  return stage === "design" || stage === "bugfix" || stage === "ready_to_execute";
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

function buildApprovedPlanContinuationPrompt(callbacks: OrchestratorCallbacks): string {
  const language = callbacks.getPreferredLanguage();
  const approvalChoiceHint = buildPlanApprovalChoiceHint(callbacks.getPlanApprovalChoice(), language);
  const requestedDocs = detectRequestedRootMarkdownDeliverables(getOriginalUserPromptForPlanFallback(callbacks));
  const deliverableHint = requestedDocs.length > 0
    ? language === "zh"
      ? `6. 用户明确要求最终文档：${requestedDocs.map((name) => `项目根目录 \`${name}\``).join("、")}。必须把它写进 tasks.md 的最后交付步骤，并在计划完成前真实写入。\n`
      : `6. The user explicitly requested final document(s): ${requestedDocs.map((name) => `project-root \`${name}\``).join(", ")}. Add them as final tasks.md deliverables and write them before marking the plan complete.\n`
    : "";

  return (
    approvalChoiceHint +
    (language === "zh"
      ? "计划已批准，现在进入执行阶段（EXECUTION MODE）。请按以下顺序继续：\n1. 先基于已批准的 requirements/design 或 bugfix 生成 `.MAIN/plans/tasks.md`，把执行任务拆清楚；tasks.md 必须精简为 8-20 个 checkbox，每项一句话。\n2. 生成 tasks.md 后，TopIsland 会显示任务进度；之后再按 tasks.md 逐个执行，使用 <tool_use> 格式调用工具。\n3. 任何需要 shell 的任务都必须在 tasks.md checkbox 中写出精确命令，并用反引号包裹；进入执行后，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr；长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 验证结果。\n4. 你可以正常修改项目源码文件，写入路径必须是项目中的正确位置，绝对不要将源码写入 `.MAIN/plans/` 或任何隐藏目录。\n5. 每完成一个任务后，先同步更新 `.MAIN/plans/tasks.md` 中对应的 checkbox 状态；tasks.md 是审计记录，不能删除已完成或旧任务，只能勾选、追加或保留“已完成任务”区块。只有全部任务都标记为 `[x]` 后，才能结束执行。\n"
      : "The plan is approved. You are now in EXECUTION MODE. Continue in this order:\n1. First generate `.MAIN/plans/tasks.md` from the approved requirements/design or bugfix so the execution steps are explicit. Keep tasks.md concise: 8-20 checkboxes, one sentence each.\n2. After tasks.md is generated, follow it task by task using tool calls.\n3. Any task that needs shell work must include the exact command inside the tasks.md checkbox text using backticks. During execution, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status.\n4. You may now edit project source files, but write them to the proper project paths and never into `.MAIN/plans/` or hidden folders.\n5. After each task, update the matching checkbox in `.MAIN/plans/tasks.md` before moving on; tasks.md is an audit record, so never delete completed or previous tasks. Only check items off, append tasks, or keep a completed-tasks section. Only stop when all tasks are `[x]`.\n") +
    deliverableHint +
    "\n" +
    buildPlanCommandExecutionHint(callbacks.getPlanTasks(), language)
  );
}

function shouldTreatCloudGatewayErrorAsCompatibility(
  errMsg: string,
  isCloudProfile: boolean,
  messages: AgentMessage[],
  nativeToolsWereAttempted: boolean,
): boolean {
  if (!isCloudProfile || isCloudGatewayTimeoutMessage(errMsg) || !isRetryableCloudErrorMessage(errMsg)) return false;
  return nativeToolsWereAttempted || hasToolRoundHistory(messages);
}

function isStreamWatchdogTimeoutMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("stream_first_chunk_timeout") ||
    normalized.includes("first chunk timeout") ||
    normalized.includes("first response timeout") ||
    normalized.includes("没有返回首个流式 chunk") ||
    normalized.includes("没有返回响应头")
  );
}

function buildPlanStreamTimeoutPauseMessage(
  language: "zh" | "en",
  stage: ReturnType<OrchestratorCallbacks["getPlanStage"]>,
): string {
  if (language === "en") {
    return stage === "requirements"
      ? "requirements.md has been generated, but the model did not return the next design step in time. This planning turn is paused; continue with design.md when ready."
      : "The model did not return the next planning step in time. This planning turn is paused and can be continued.";
  }
  return stage === "requirements"
    ? "已生成 requirements.md，但模型长时间没有返回下一步设计方案。本轮已暂停，你可以继续生成 design.md。"
    : "模型长时间没有返回下一步规划内容，本轮已暂停，可以继续当前计划阶段。";
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
  maxEscalationsOverride?: number,
): Promise<StreamResult> {
  let fullText = "";
  let currentMaxTokens = maxTokensOverride ?? computeInitialMaxTokens(settings.contextLimit);
  let transientRetryCount = 0;

  // Max output tokens escalation loop (from claude-code-haha)
  const MAX_ESCALATIONS = maxEscalationsOverride ?? 3;
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

        void streamChatCompletion(
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
        ).catch((err) => {
          safeReject(err instanceof Error ? err : new Error(getErrorMessage(err, "LLM stream failed")));
        });
      });
    } catch (err) {
      const retryMessage = getErrorMessage(err, "LLM stream failed");
      if (
        !signal.aborted &&
        transientRetryCount < MAX_TRANSIENT_RETRIES &&
        !isCloudGatewayTimeoutMessage(retryMessage) &&
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
  content: string; // model-facing result or error message
  displayContent?: string; // UI-facing result, can differ from model-facing content
  isError: boolean;
  additionalContexts?: string[];
}

interface CachedReadOnlyToolResult {
  name: string;
  target: string;
  content: string;
}

interface FileReadState {
  signature: string;
  path: string;
  argsKey: string;
  contentHash: string;
  contentLength: number;
  sizeBytes: number;
  modifiedMs: number;
  modelContent: string;
  updatedAt: number;
}

const FILE_UNCHANGED_STUB = "FILE_UNCHANGED_STUB";
const MAX_FILE_READ_STATES_PER_SESSION = 240;
const sessionFileReadStates = new Map<string, Map<string, FileReadState>>();

function getSessionFileReadStates(sessionKey: string): Map<string, FileReadState> {
  const key = sessionKey || "default";
  let states = sessionFileReadStates.get(key);
  if (!states) {
    states = new Map<string, FileReadState>();
    sessionFileReadStates.set(key, states);
  }
  return states;
}

function pruneFileReadStates(states: Map<string, FileReadState>): void {
  if (states.size <= MAX_FILE_READ_STATES_PER_SESSION) return;
  const staleKeys = [...states.entries()]
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(0, states.size - MAX_FILE_READ_STATES_PER_SESSION)
    .map(([key]) => key);
  staleKeys.forEach((key) => states.delete(key));
}

function parseToolCallArguments(tc: ToolCallToExecute): Record<string, unknown> {
  try {
    return JSON.parse(tc.arguments);
  } catch {
    return {};
  }
}

function buildReadOnlyCacheSignature(name: string, args: Record<string, unknown>): string {
  return buildRepeatLoopSignature(name, buildRepeatLoopArgsKey(args));
}

function formatCachedReadOnlyToolResult(
  name: string,
  target: string,
  cached: CachedReadOnlyToolResult | undefined,
  duplicateCount: number,
): string {
  const suffix = target ? ` (target: "${target}")` : "";
  const preview = cached?.content
    ? `\n\nEarlier result preview:\n${cached.content.slice(0, 1600)}${cached.content.length > 1600 ? "\n...[preview truncated]" : ""}`
    : "";

  return [
    `Repeated read-only tool call skipped: "${name}" was already called with identical arguments${suffix}.`,
    `Duplicate skip count in this run: ${duplicateCount}.`,
    "Reuse the earlier tool result already in context. Do not call the same tool with the same arguments again; continue with a different file, a more specific outline/search tool, or produce the next visible answer.",
    preview,
  ].filter(Boolean).join("\n");
}

function appendPlanRepeatReadLimitGuidance(
  content: string,
  language: "zh" | "en",
  stage: ReturnType<OrchestratorCallbacks["getPlanStage"]>,
): string {
  const guidance = language === "zh"
    ? stage === "requirements"
      ? "PLAN_REPEAT_READ_LIMIT: 你正在计划阶段重复读取已经缓存且未变化的上下文。请停止重复读取，直接基于 requirements.md 和已有文件上下文生成 `.MAIN/plans/design.md`；如果设计方向不明确，用 `<user_options>` 提供用户可点击选择并立刻停止。"
      : "PLAN_REPEAT_READ_LIMIT: 你正在重复读取已经缓存且未变化的上下文。请停止重复读取，转向生成下一份计划文件、正式 Proposal，或用 `<user_options>` 询问关键分叉。"
    : stage === "requirements"
    ? "PLAN_REPEAT_READ_LIMIT: You are repeating cached unchanged reads during planning. Stop rereading files and generate `.MAIN/plans/design.md` from requirements.md and existing context; if the design direction is unclear, offer `<user_options>` and stop."
    : "PLAN_REPEAT_READ_LIMIT: You are repeating cached unchanged reads. Stop rereading and produce the next plan artifact, a formal Proposal, or `<user_options>` for the key decision.";
  return `${content}\n\n${guidance}`;
}

function truncateToolContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + `\n...[truncated, ${content.length - maxChars} chars omitted]`;
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function buildFileReadSignature(path: string, args: Record<string, unknown>): string {
  const argsKey = buildRepeatLoopArgsKey(
    Object.fromEntries(
      Object.entries(args)
        .filter(([key]) => key !== "path")
        .filter(([_, value]) => value !== undefined && value !== null && value !== ""),
    ),
  );
  return `read_file::${path}::${argsKey}`;
}

function buildFileUnchangedStub(state: FileReadState): string {
  return [
    `${FILE_UNCHANGED_STUB}: "${state.path}" has already been read with the same range/options, and the content is unchanged.`,
    `Previous read: ${state.contentLength.toLocaleString()} chars, file size ${state.sizeBytes.toLocaleString()} bytes, modified ${state.modifiedMs}, hash ${state.contentHash}.`,
    "Reuse the earlier file content already in context. Do not call read_file for this same file/range again unless you have reason to believe it changed.",
    "Next: inspect a different file, use get_file_outline/grep_search for a narrower question, or continue the implementation/answer from the cached content.",
  ].join("\n");
}

async function readFileMetadataIfAvailable(path: string, workspace?: string): Promise<{ path: string; sizeBytes: number; modifiedMs: number } | null> {
  try {
    const metadata = await getFileMetadata(path, workspace);
    return {
      path: String(metadata.path || path),
      sizeBytes: Number(metadata.sizeBytes) || 0,
      modifiedMs: Number(metadata.modifiedMs) || 0,
    };
  } catch {
    return null;
  }
}

function getToolResultBudgets(name: string, cloudProfile: boolean): { modelChars: number; displayChars: number } {
  if (cloudProfile) {
    if (name === "read_file") return { modelChars: 8000, displayChars: 8000 };
    if (name === "read_document" || name === "analyze_tabular_document" || name === "query_tabular_document") {
      return { modelChars: 7000, displayChars: 8000 };
    }
    if (name === "run_command" || name === "execute_command") return { modelChars: 6000, displayChars: 8000 };
    return { modelChars: 6000, displayChars: 8000 };
  }

  if (name === "read_file") return { modelChars: 24000, displayChars: 10000 };
  if (name === "read_document" || name === "analyze_tabular_document" || name === "query_tabular_document") {
    return { modelChars: 16000, displayChars: 10000 };
  }
  if (name === "run_command" || name === "execute_command") return { modelChars: 12000, displayChars: 10000 };
  return { modelChars: 12000, displayChars: 10000 };
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

  const planArtifactValidationError = await buildPlanArtifactMutationValidationError(
    tc,
    resolvedArgs,
    workspace,
    callbacks,
  );
  if (planArtifactValidationError) {
    return planArtifactValidationError;
  }

  const diffPreview = await buildToolDiffPreview(tc.name, effectiveArgs, { workspace, sessionKey });
  callbacks.onToolExecuting(tc.name, target, diffPreview);

  try {
    const rawResult = await executeTool(tc.name, resolvedArgs, workspace, sessionKey);
    const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
    const cloudProfile = callbacks.getConfig().activeProfile === "cloud";
    const budgets = getToolResultBudgets(tc.name, cloudProfile);
    const modelContent = truncateToolContent(resultStr, budgets.modelChars);
    const displayContent = truncateToolContent(resultStr, budgets.displayChars);

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

    callbacks.onToolDone(tc.name, target, displayContent);
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: modelContent,
      displayContent,
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

function buildPlanGateBlockedResult(
  tc: ToolCallToExecute,
  toolArgs: Record<string, unknown>,
  callbacks: OrchestratorCallbacks,
  reason: "pre_approval_source_write" | "pre_approval_tasks" | "missing_tasks_before_source",
): ToolExecutionResult {
  const target = getToolTarget(tc.name, toolArgs);
  const language = callbacks.getPreferredLanguage();
  const message = language === "zh"
    ? reason === "pre_approval_tasks"
      ? "PLAN 阶段尚未批准，不能提前生成 `.MAIN/plans/tasks.md`。请先完成 requirements/design 或 bugfix 草稿并等待用户批准。"
      : reason === "missing_tasks_before_source"
      ? "计划已批准，但还没有可执行的 `.MAIN/plans/tasks.md` 任务清单。请先生成 tasks.md，再按任务修改源码或交付文档。"
      : "PLAN 阶段尚未批准，不能修改源码或项目交付文件。请先生成 `.MAIN/plans/requirements.md` 与 `.MAIN/plans/design.md`（或 bugfix.md）供用户审批。"
    : reason === "pre_approval_tasks"
    ? "PLAN mode is not approved yet, so `.MAIN/plans/tasks.md` must not be generated. Create requirements/design or bugfix drafts and wait for approval first."
    : reason === "missing_tasks_before_source"
    ? "The plan is approved, but there is no executable `.MAIN/plans/tasks.md` task list yet. Generate tasks.md before editing source or final deliverables."
    : "PLAN mode is not approved yet, so source or deliverable files cannot be modified. Create `.MAIN/plans/requirements.md` plus `.MAIN/plans/design.md` (or bugfix.md) for review first.";

  callbacks.onToolExecuting(tc.name, target);
  callbacks.onToolError(tc.name, target, message);
  return {
    toolCallId: tc.id,
    name: tc.name,
    target,
    content: `Error: PLAN_STAGE_BLOCKED: ${message}`,
    isError: true,
  };
}

async function buildPlanArtifactMutationValidationError(
  tc: ToolCallToExecute,
  args: Record<string, unknown>,
  workspace: string,
  callbacks: OrchestratorCallbacks,
): Promise<ToolExecutionResult | null> {
  if (tc.name !== "write_file" && tc.name !== "replace_in_file") return null;

  const path = typeof args.path === "string" ? args.path : "";
  const kind = path ? detectPlanArtifactKind(path) : null;
  if (!kind) return null;

  let nextContent: string | null = null;
  if (tc.name === "write_file") {
    nextContent = typeof args.content === "string" ? args.content : "";
  } else if (tc.name === "replace_in_file") {
    const searchText = typeof args.search_text === "string" ? args.search_text : "";
    const replaceText = typeof args.replace_text === "string" ? args.replace_text : "";
    if (searchText) {
      try {
        const currentContent = String(await executeTool("read_file", { path }, workspace, callbacks.getSessionKey()) ?? "");
        nextContent = currentContent.includes(searchText)
          ? currentContent.replace(searchText, replaceText)
          : null;
      } catch {
        nextContent = null;
      }
    }
  }

  if (nextContent == null) return null;

  const language = callbacks.getPreferredLanguage();
  const target = getToolTarget(tc.name, args);

  if (kind !== "tasks") {
    const validation = validatePlanArtifactContent(nextContent, kind);
    if (!validation.ok) {
      const message = language === "zh"
        ? `PLAN_QUALITY_GATE: ${path} 被拦截，内容不像可审批的正式计划（${validation.reason || "质量不足"}）。请基于用户目标和已读源码重新生成 requirements/design，或用 <user_options> 询问关键分叉；不要写入工具日志、后台思考、截断提示或原始代码片段。`
        : `PLAN_QUALITY_GATE: ${path} was rejected because it does not look like a reviewable plan artifact (${validation.reason || "quality gate"}). Regenerate requirements/design from the user goal and inspected source, or ask the user with <user_options>; do not write tool logs, hidden thinking, truncation notices, or raw source snippets.`;
      callbacks.onToolExecuting(tc.name, target);
      callbacks.onToolError(tc.name, target, message);
      return {
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: `Error: ${message}`,
        isError: true,
      };
    }
  }

  if (kind === "tasks") {
    const previousTasks = callbacks.getPlanTasks();
    const parsedTasks = extractPlanTasks(nextContent);
    const droppedTasks =
      previousTasks.length > 0 && parsedTasks.length === 0
        ? previousTasks
        : findDroppedPlanTasks(previousTasks, parsedTasks);

    if (droppedTasks.length > 0) {
      const message = language === "zh"
        ? `PLAN_TASK_HISTORY_BLOCKED: tasks.md 不能删除已有任务记录。本次写入会移除 ${droppedTasks.length} 个任务（例如：${droppedTasks.slice(0, 3).map((task) => task.text).join("；")}）。请只把完成项的 checkbox 改成 [x]、追加新任务，或保留“已完成任务”区块。`
        : `PLAN_TASK_HISTORY_BLOCKED: tasks.md must not delete existing task history. This write would remove ${droppedTasks.length} task(s) (for example: ${droppedTasks.slice(0, 3).map((task) => task.text).join("; ")}). Only mark completed checkboxes as [x], append tasks, or keep a completed-tasks section.`;
      callbacks.onToolExecuting(tc.name, target);
      callbacks.onToolError(tc.name, target, message);
      return {
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: `Error: ${message}`,
        isError: true,
      };
    }

    if (callbacks.getIsPlanApproved()) {
      const previousById = new Map(previousTasks.map((task) => [task.id, task]));
      const unsupportedCompletions = parsedTasks.filter((task) => {
        if (task.claimedStatus !== "completed") return false;
        const previous = previousById.get(task.id);
        return !previous || !isPlanTaskTrustedComplete(previous);
      });

      if (unsupportedCompletions.length > 0) {
        const message = language === "zh"
          ? `PLAN_TASK_EVIDENCE_BLOCKED: tasks.md 不能把缺少真实执行证据的任务直接勾选完成。请先真实执行并验证这些任务，再更新 checkbox：${unsupportedCompletions.slice(0, 3).map((task) => task.text).join("；")}`
          : `PLAN_TASK_EVIDENCE_BLOCKED: tasks.md cannot mark tasks complete before trusted execution evidence exists. Execute and verify these tasks first, then update their checkboxes: ${unsupportedCompletions.slice(0, 3).map((task) => task.text).join("; ")}`;
        callbacks.onToolExecuting(tc.name, target);
        callbacks.onToolError(tc.name, target, message);
        return {
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: `Error: ${message}`,
          isError: true,
        };
      }
    }
  }

  return null;
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
const CONCISE_PLAN_ARTIFACT_HINT_ZH =
  "计划文档必须精简：requirements.md 40-80 行、design.md 60-120 行、bugfix.md 40-80 行、tasks.md 8-20 个 checkbox；不要写教程式长文、完整代码清单或重复背景。Proposal 只做一页审阅摘要。";
const CONCISE_PLAN_ARTIFACT_HINT_EN =
  "Keep plan artifacts concise: requirements.md 40-80 lines, design.md 60-120 lines, bugfix.md 40-80 lines, tasks.md 8-20 checkboxes. Do not write tutorial-style prose, full code listings, or repeated background. The Proposal should be a one-page review summary.";

function logAgentEvent(event: string, data: Record<string, unknown> = {}) {
  try {
    console.info(`[agent.${event}]`, data);
  } catch {
    // Logging must never affect the agent loop.
  }
}

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
  const nativeToolsEnabled = !hasProviderNativeToolsDisabled(initialMessages);
  const settings = deriveStreamSettings(config);
  const workspace = config.workspace;
  const mainModeKey = callbacks.getMainModeKey();
  const workspaceTree = callbacks.getWorkspaceTree();
  const turnIntent = callbacks.getCurrentRunIntent();
  const workflowMode = callbacks.getWorkflowMode();
  const resolveRuntimeIntent = (): ResolvedUserIntent => {
    const currentConversationIntent = callbacks.getCurrentRunIntent();
    const requestedRuntimeIntent = callbacks.getRuntimeRunIntent?.() ?? currentConversationIntent;
    if (
      currentConversationIntent === "plan" &&
      callbacks.getIsPlanApproved() &&
      requestedRuntimeIntent === "plan"
    ) {
      return "execute";
    }
    return requestedRuntimeIntent;
  };

  console.log('[orchestrator] executeAgentLoop');
  console.log('[orchestrator] activeProfile:', config.activeProfile);
  console.log('[orchestrator] derived settings:', JSON.stringify({
    baseUrl: settings.baseUrl,
    model: settings.model,
    useRustProxy: settings.useRustProxy,
    hasApiKey: !!settings.apiKey,
    provider: settings.provider,
    nativeToolsEnabled,
    xmlToolsEnabled: true,
  }));

  // ── Config Snapshot ──────────────────────────────────────────────
  // Local profile uses the slider-driven context limit. Cloud profile
  // bypasses local KV-cache/context compression entirely.
  const snapshotContextLimit = isCloudProfile ? undefined : config.local.contextLimit;

  // Discover MCP tools from configured servers
  const mcpServers = callbacks.getMcpServers();
  let mcpTools = callbacks.getMcpDiscoveredTools();
  let mcpToolServerMap = getMcpToolServerMap();

  if (mcpServers.length > 0) {
    console.log(`[orchestrator] Discovering tools from ${mcpServers.length} MCP server(s)...`);
    const { tools: discovered, toolServerMap } = await discoverAllMcpTools(mcpServers);
    mcpToolServerMap = toolServerMap;
    setMcpToolServerMap(toolServerMap);
    if (discovered.length > 0) {
      console.log(`[orchestrator] Discovered ${discovered.length} MCP tool(s):`, discovered.map(t => t.name).join(", "));
      mcpTools = discovered;
    } else {
      console.log(`[orchestrator] No MCP tools discovered (servers may be offline).`);
      mcpTools = [];
    }
  }

  const latestUserPrompt = [...initialMessages]
    .reverse()
    .find((message) => message.role === "user");
  const mcpRoutingResult = routeMcpToolsForPrompt({
    tools: mcpTools,
    servers: mcpServers,
    toolServerMap: mcpToolServerMap,
    userPrompt: latestUserPrompt ? extractCompatibilityTextContent(latestUserPrompt.content) : "",
    config: config.mcpRouting,
  });
  mcpTools = mcpRoutingResult.tools;
  logAgentEvent("mcp_routing", { ...mcpRoutingResult.telemetry });

  // Build intent-scoped tool definitions: built-ins + active skills + routed MCP tools.
  const routedToolDefinitions = buildToolDefinitions(skills, mcpTools);
  const toolCapabilityRegistry = buildToolCapabilityRegistry({
    toolDefinitions: routedToolDefinitions,
    skills,
    mcpTools,
    mcpServers,
    mcpToolServerMap,
    policy: config.toolPermissionPolicy,
  });
  const resolveAllToolsForRuntime = (runtimeIntent: ResolvedUserIntent): ToolDefinition[] =>
    filterToolDefinitionsForIntent(
      routedToolDefinitions,
      callbacks.getCurrentRunIntent(),
      toolCapabilityRegistry,
      {
        runtimeIntent,
        planApproved: callbacks.getIsPlanApproved(),
      },
    );
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
  const mcpToolNameSet = new Set(mcpTools.map(t => t.name));
  const skillToolNameSet = new Set(skills
    .filter(s => s.active && s.type === "tool")
    .map(s => skillNameToToolName(s.name))
    .filter(Boolean));
  let appliedSystemPromptKey = "";
  const applySystemPromptForRuntime = (runtimeIntent: ResolvedUserIntent, tools: ToolDefinition[]) => {
    const availableToolNameList = tools.map((tool) => tool.function.name);
    const systemPromptKey = [
      runtimeIntent,
      workflowMode,
      callbacks.getPreferredLanguage(),
      availableToolNameList.join(","),
    ].join("|");
    if (systemPromptKey === appliedSystemPromptKey) return;

    const mcpToolNames = availableToolNameList.filter((name) => mcpToolNameSet.has(name));
    const customToolNames = availableToolNameList.filter((name) => skillToolNameSet.has(name));
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
      runtimeIntent,
      config.promptLanguageStrategy,
      availableToolNameList,
    );
    const currentMessages = callbacks.getMessages();
    if (currentMessages.length === 0) {
      callbacks.appendMessage({ role: "system", content: systemPrompt });
    } else if (currentMessages[0].role === "system") {
      const refreshed = [...currentMessages];
      refreshed[0] = { ...refreshed[0], content: systemPrompt };
      callbacks.replaceMessages(refreshed);
    } else {
      callbacks.replaceMessages([{ role: "system", content: systemPrompt }, ...currentMessages]);
    }
    appliedSystemPromptKey = systemPromptKey;
  };

  const initialRuntimeIntent = resolveRuntimeIntent();
  applySystemPromptForRuntime(initialRuntimeIntent, resolveAllToolsForRuntime(initialRuntimeIntent));

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
  const getMaxOutputEscalations = () =>
    workflowMode === "plan" && !callbacks.getIsPlanApproved()
      ? 0
      : 2;
  let sawPlanModeToolActivity = false;
  let usedPlanRecoveryPrompt = false;
  let usedToolUnavailableRecoveryPrompt = false;
  const attemptedPlanWriteTargets: string[] = [];
  let recentSuccessfulProjectWrite: { name: string; target: string } | null = null;
  let recoveringFromEmptyAssistantReplyAfterWrite = false;

  // ── Strict Repeat Guard ──────────────────────────────────────────
  // Track recent tool calls to detect repetition loops. For read-only
  // tools, inject one recovery hint back into the loop before treating
  // the pattern as fatal, so the model gets a chance to pivot tools.
  const recentToolCalls: Array<{ name: string; argsKey: string }> = [];
  const repeatGuardRecoveredSignatures = new Set<string>();
  const readOnlyResultCache = new Map<string, CachedReadOnlyToolResult>();
  const readOnlyDuplicateSkipCounts = new Map<string, number>();
  const fileReadStates = getSessionFileReadStates(callbacks.getSessionKey());

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
  const loopStartRuntimeIntent = resolveRuntimeIntent();
  const loopStartTools = resolveAllToolsForRuntime(loopStartRuntimeIntent);

  logAgentEvent("loop_start", {
    workflowMode,
    turnIntent,
    runtimeIntent: loopStartRuntimeIntent,
    messagesLen: callbacks.getMessages().length,
    allTools: loopStartTools.length,
    mcpTools: mcpTools.length,
    builtinAndSkillTools: Math.max(0, loopStartTools.length - mcpTools.length),
    nativeToolsEnabled: !hasProviderNativeToolsDisabled(callbacks.getMessages()),
    xmlToolsEnabled: true,
    maxOutputEscalations: getMaxOutputEscalations(),
  });

  while (iteration < effectiveMaxIterations) {
    iteration++;

    if (abortController.signal.aborted) {
      callbacks.onStatusChange("idle");
      return;
    }

    // ── Pre-LLM Turn Preparation ──
    callbacks.startNewTurn();
    const runtimeIntent = resolveRuntimeIntent();
    const iterationAllTools = resolveAllToolsForRuntime(runtimeIntent);
    const availableToolNames = new Set(iterationAllTools.map((tool) => tool.function.name));
    applySystemPromptForRuntime(runtimeIntent, iterationAllTools);

    // 1. Context management. Cloud mode uses a lightweight pass so tool-heavy
    // histories do not trigger slow Responses requests or gateway 524s.
    let managedAgentMessages = callbacks.getMessages() as AgentMessage[];
    const llmTools = !hasProviderNativeToolsDisabled(callbacks.getMessages()) ? iterationAllTools : [];
    const cloudResponsesCompact = isCloudProfile && config.cloud.apiFormat === "responses";
    if (snapshotContextLimit != null || cloudResponsesCompact) {
      const contextLimit = snapshotContextLimit ?? 32768;
      const effectiveContextLimit = computeManagedContextLimit(contextLimit, llmTools);
      const { inputBudget, outputBudget } = computeContextBudgets(effectiveContextLimit);
      const managedResult = manageContext(
        callbacks.getMessages(),
        effectiveContextLimit,
        cloudResponsesCompact ? Math.min(outputBudget, 2048) : outputBudget,
        cloudResponsesCompact ? 700 : Math.max(4000, Math.floor(inputBudget * 0.45)),
        cloudResponsesCompact ? 500 : Math.max(2000, Math.floor(inputBudget * 0.25)),
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
          compressedContext: managedResult.compressedContext,
        }, "proactive");
      }
    }

    // 2. Stream LLM response
    const assistantMsgId = generateId();
    let streamResult: StreamResult;
    const maxOutputEscalations = getMaxOutputEscalations();

    logAgentEvent("iteration_start", {
      iteration,
      workflowMode,
      turnIntent,
      runtimeIntent,
      messagesLen: managedAgentMessages.length,
      allTools: iterationAllTools.length,
      llmTools: llmTools.length,
      xmlToolsEnabled: true,
      mcpTools: mcpTools.length,
      currentMaxTokens: currentMaxTokens ?? "default",
    });

    try {
      streamResult = await fetchLLMStream(
        managedAgentMessages,
        settings,
        assistantMsgId,
        callbacks,
        abortController.signal,
        llmTools,
        currentMaxTokens,
        maxOutputEscalations,
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
      if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(errMsg)) {
        const planStage = callbacks.getPlanStage();
        logAgentEvent("plan_stage_waiting_for_design", {
          iteration,
          planStage,
          reason: "stream_first_chunk_timeout",
          message: errMsg.slice(0, 240),
        });
        callbacks.onNonActionableStop(
          buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
          "incomplete_plan",
        );
        callbacks.onStatusChange("idle");
        return;
      }
      const nativeToolsWereAttempted = llmTools.length > 0;
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

        const { contextLimit: reactiveContextLimit, reportedContextLimit } =
          clampContextLimitToReported(snapshotContextLimit, errMsg);
        if (reportedContextLimit != null && reportedContextLimit < snapshotContextLimit) {
          console.log(
            `[orchestrator] Provider reported context window ${reportedContextLimit}; ` +
            `clamping configured limit ${snapshotContextLimit} for reactive retry`,
          );
        }

        // More aggressive compaction: reduce tool result budget while keeping
        // enough response room for a tool call instead of a length stop.
        const aggressiveOutputBudget = Math.min(3072, Math.max(1536, Math.floor(reactiveContextLimit * 0.08)));
        const aggressiveContextLimit = computeManagedContextLimit(
          reactiveContextLimit,
          llmTools,
          aggressiveOutputBudget,
        );
        const maxToolResultTokens = 800;
        const aggressivelyManagedResult = manageContext(
          callbacks.getMessages(),
          aggressiveContextLimit,
          aggressiveOutputBudget,
          maxToolResultTokens,
          480,
          true,
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
            compressedContext: aggressivelyManagedResult.compressedContext,
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
            llmTools,
            aggressiveOutputBudget,
            1,
          );
        } catch (retryErr) {
          if ((retryErr as Error).name === "AbortError") {
            callbacks.onStatusChange("idle");
            return;
          }
          const retryErrMsg = (retryErr as Error).message || "";
          if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(retryErrMsg)) {
            const planStage = callbacks.getPlanStage();
            logAgentEvent("plan_stage_waiting_for_design", {
              iteration,
              planStage,
              reason: "stream_first_chunk_timeout_after_compaction",
              message: retryErrMsg.slice(0, 240),
            });
            callbacks.onNonActionableStop(
              buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
              "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return;
          }

          // Second retry: strip tool_calls from messages entirely (some providers
          // like Ollama choke on tool_calls in message history) and retry with
          // plain text-only messages
          console.log("[orchestrator] Second retry: stripping tool_calls from messages");
          const strippedMessages = buildCompatibilityRetryMessages(aggressivelyManaged);
          const emergencyOutputBudget = Math.min(2048, Math.max(1024, Math.floor(reactiveContextLimit * 0.06)));
          const emergencyContextLimit = computeManagedContextLimit(reactiveContextLimit, llmTools, emergencyOutputBudget);
          const emergencyManagedResult = manageContext(
            strippedMessages,
            emergencyContextLimit,
            emergencyOutputBudget,
            320,
            220,
            true,
          );
          const emergencyManaged = emergencyManagedResult.messages as AgentMessage[];

          if (emergencyManagedResult.changed && emergencyManagedResult.tokenReduction > 0) {
            callbacks.replaceMessages(emergencyManaged);
            callbacks.onContextCompress({
              droppedCount: emergencyManagedResult.droppedCount,
              tokenCountBefore: emergencyManagedResult.tokenCountBefore,
              tokenCountAfter: emergencyManagedResult.tokenCountAfter,
              tokenReduction: emergencyManagedResult.tokenReduction,
              compressedContext: emergencyManagedResult.compressedContext,
            }, "reactive");
          }

          try {
            streamResult = await fetchLLMStream(
              emergencyManaged,
              settings,
              assistantMsgId,
              callbacks,
              abortController.signal,
              llmTools,
              emergencyOutputBudget,
              0,
            );
          } catch (finalErr) {
            if ((finalErr as Error).name === "AbortError") {
              callbacks.onStatusChange("idle");
              return;
            }
            const finalErrMsg = (finalErr as Error).message || "";
            if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(finalErrMsg)) {
              const planStage = callbacks.getPlanStage();
              logAgentEvent("plan_stage_waiting_for_design", {
                iteration,
                planStage,
                reason: "stream_first_chunk_timeout_after_emergency_compaction",
                message: finalErrMsg.slice(0, 240),
              });
              callbacks.onNonActionableStop(
                buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
                "incomplete_plan",
              );
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
        console.log("[orchestrator] Provider compatibility retry: disabling native tools and enabling XML tool_use");
        const compatibilityMessages = ensureProviderCompatibilityMode(
          buildCompatibilityRetryMessages(managedAgentMessages),
          workflowMode,
        );
        callbacks.replaceMessages(compatibilityMessages);
        logAgentEvent("native_tool_fallback", {
          iteration,
          nativeToolsAttempted: nativeToolsWereAttempted,
          allTools: iterationAllTools.length,
          llmToolsBeforeFallback: llmTools.length,
          llmToolsAfterFallback: 0,
          xmlToolsEnabled: true,
          reason: errMsg.slice(0, 240),
        });

        try {
          streamResult = await fetchLLMStream(
            compatibilityMessages,
            settings,
            assistantMsgId,
            callbacks,
            abortController.signal,
            [],
            currentMaxTokens,
            maxOutputEscalations,
          );
        } catch (retryErr) {
          if ((retryErr as Error).name === "AbortError") {
            callbacks.onStatusChange("idle");
            return;
          }

          const retryMsg = (retryErr as Error).message || "";
          if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(retryMsg)) {
            const planStage = callbacks.getPlanStage();
            logAgentEvent("plan_stage_waiting_for_design", {
              iteration,
              planStage,
              reason: "stream_first_chunk_timeout_after_compatibility_retry",
              message: retryMsg.slice(0, 240),
            });
            callbacks.onNonActionableStop(
              buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
              "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return;
          }
          const retryLooksLikeCompatibility =
            isProviderCompatibilityErrorMessage(retryMsg) ||
            (isCloudProfile && !isCloudGatewayTimeoutMessage(retryMsg) && isRetryableCloudErrorMessage(retryMsg));

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
                maxOutputEscalations,
              );
            } catch (finalErr) {
              if ((finalErr as Error).name === "AbortError") {
                callbacks.onStatusChange("idle");
                return;
              }
              const finalErrMsg = (finalErr as Error).message || "";
              if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(finalErrMsg)) {
                const planStage = callbacks.getPlanStage();
                logAgentEvent("plan_stage_waiting_for_design", {
                  iteration,
                  planStage,
                  reason: "stream_first_chunk_timeout_after_provider_compatibility_retry",
                  message: finalErrMsg.slice(0, 240),
                });
                callbacks.onNonActionableStop(
                  buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
                  "incomplete_plan",
                );
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
                  maxOutputEscalations,
                );
              } catch (lastErr) {
                if ((lastErr as Error).name === "AbortError") {
                  callbacks.onStatusChange("idle");
                  return;
                }
                const lastErrorMessage = getErrorMessage(lastErr, "未知错误");
                if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(lastErrorMessage)) {
                  const planStage = callbacks.getPlanStage();
                  logAgentEvent("plan_stage_waiting_for_design", {
                    iteration,
                    planStage,
                    reason: "stream_first_chunk_timeout_after_transcript_retry",
                    message: lastErrorMessage.slice(0, 240),
                  });
                  callbacks.onNonActionableStop(
                    buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
                    "incomplete_plan",
                  );
                  callbacks.onStatusChange("idle");
                  return;
                }
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
    logAgentEvent("stream_done", {
      iteration,
      finishReason: streamResult.finishReason || "unknown",
      contentChars: streamText.length,
      toolCalls: streamResult.toolCalls.length,
    });

    // 3. 将不同模型输出统一整理成标准结构，避免 UI 继续靠多处分支猜测。
    const normalizedBase = normalizeAssistantTurn(streamResult);
    const normalized = ensureVisibleConclusion(normalizedBase);
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

      const shouldForcePostWriteVerification =
        workflowMode === "edit" &&
        !!recentSuccessfulProjectWrite;

      callbacks.appendMessage({
        role: "user",
        content:
          shouldForcePostWriteVerification
            ? buildMissingToolCallContinuationPrompt(
                "post_write_verify",
                callbacks.getPreferredLanguage(),
                consecutiveEmptyResponseCount,
              )
            : workflowMode === "chat"
            ? "上一条回复是空的。请直接输出对用户可见的 Markdown 正文来回答用户；如果确实需要工具，请使用正式工具调用。不要只返回空消息，也不要只输出不可见的 thinking/analysis 标签。现在继续。"
            : "上一条回复是空的。请继续执行，并确保这次返回可见正文或正式工具调用；不要只返回空消息，也不要只输出不可见的 thinking/analysis 标签。现在继续。",
      });
      if (shouldForcePostWriteVerification) {
        recoveringFromEmptyAssistantReplyAfterWrite = true;
      }
      continue;
    }
    consecutiveEmptyResponseCount = 0;

    const effectiveToolCalls: Array<{ id: string; name: string; arguments: string }> =
      normalized.toolCalls.map((call) => ({
        id: call.id || `call_${generateId()}`,
        name: call.name,
        arguments: call.arguments,
      }));

    const compactedProseCodeDump = shouldCompactProseCodeDump({
      workflowMode,
      turnIntent,
      visibleText: normalized.visibleText,
      toolCallCount: effectiveToolCalls.length,
      isPlanApproved: callbacks.getIsPlanApproved(),
    });
    const compactedIncompletePlanText =
      !compactedProseCodeDump &&
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      effectiveToolCalls.length === 0 &&
      normalized.finishReason === "length" &&
      (normalizedBase.visibleText || normalized.visibleText).trim().length > 1200;
    const autoContinueReadOnlyPermission =
      effectiveToolCalls.length === 0 &&
      !compactedProseCodeDump &&
      shouldAutoContinueReadOnlyPermissionState({
        replyOptions: normalized.replyOptions,
        readOnlyAutoApproveForSession: callbacks.getReadOnlyAutoApproveForSession(),
      });
    const sourceVisibleText = normalizedBase.visibleText || normalized.visibleText;
    const normalizedVisibleTextForUser = autoContinueReadOnlyPermission
      ? stripReadOnlyPermissionPrompt(normalized.visibleText)
      : normalized.visibleText;
    const finalVisibleText = compactedProseCodeDump
      ? buildProseCodeDumpNotice(callbacks.getPreferredLanguage(), normalized.visibleText.length)
      : compactedIncompletePlanText
      ? buildPlanFallbackNotice(callbacks.getPreferredLanguage(), sourceVisibleText.length)
      : normalizedVisibleTextForUser;
    const finalReplyOptions = compactedProseCodeDump || autoContinueReadOnlyPermission ? [] : normalized.replyOptions;
    const historyAssistantText = finalVisibleText || "";

    if (finalReplyOptions.length > 0) {
      logAgentEvent("reply_options_detected", {
        iteration,
        replyOptions: finalReplyOptions.length,
        optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
        toolCalls: effectiveToolCalls.length,
        workflowMode,
        turnIntent,
      });
    }

    const shouldRecoverToolUnavailableClaim =
      isCloudProfile &&
      iterationAllTools.length > 0 &&
      effectiveToolCalls.length === 0 &&
      finalReplyOptions.length === 0 &&
      !compactedProseCodeDump &&
      looksLikeToolUnavailableClaim(finalVisibleText);

    if (shouldRecoverToolUnavailableClaim && !usedToolUnavailableRecoveryPrompt) {
      usedToolUnavailableRecoveryPrompt = true;
      logAgentEvent("tool_unavailable_claim_reprompt", {
        iteration,
        allTools: iterationAllTools.length,
        llmTools: llmTools.length,
        xmlToolsEnabled: true,
        visibleChars: finalVisibleText.length,
      });
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: buildToolUnavailableRecoveryPrompt(callbacks.getPreferredLanguage(), workflowMode),
      });
      continue;
    }

    if (compactedProseCodeDump) {
      logAgentEvent("prose_code_dump_compacted", {
        iteration,
        originalVisibleChars: normalized.visibleText.length,
        compactedVisibleChars: finalVisibleText.length,
        workflowMode,
        turnIntent,
      });
    }

    callbacks.onTurnSummaryReady(finalVisibleText);

    if (normalized.hiddenThought) {
      callbacks.onThought(normalized.hiddenThought);
    }

    if (finalVisibleText || finalReplyOptions.length > 0) {
      callbacks.onAssistantFinalText(finalVisibleText, finalReplyOptions);
    }

    if (autoContinueReadOnlyPermission) {
      consecutiveNoToolCount++;
      logAgentEvent("readonly_permission_auto_continue", {
        iteration,
        consecutiveNoToolCount,
        visibleChars: normalized.visibleText.length,
        strippedVisibleChars: finalVisibleText.length,
      });
      if (consecutiveNoToolCount >= MAX_NO_ACTION_RETRIES) {
        callbacks.onError("模型连续要求确认只读步骤，没有继续调用只读工具。已中止本轮，请重试或切换更稳定的模型。");
        callbacks.onStatusChange("error");
        return;
      }

      if (historyAssistantText.trim()) {
        callbacks.appendMessage({ role: "assistant", content: historyAssistantText });
      }
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: buildReadOnlyPermissionContinuationPrompt(callbacks.getPreferredLanguage()),
      });
      continue;
    }

    if (workflowMode === "plan" && effectiveToolCalls.length > 0) {
      sawPlanModeToolActivity = true;
    }

    const hasStructuredProposal = hasStructuredPlanProposal(streamText);
    const currentPlanStageForReview = callbacks.getPlanStage();
    const hasReadyPlanArtifacts = currentPlanStageForReview === "ready_to_execute";
    const hasReviewablePlanArtifacts = isReviewablePlanStage(currentPlanStageForReview);
    const shouldPauseForUserChoice = shouldPauseForReplyOptions({
      replyOptions: finalReplyOptions,
      toolCallCount: effectiveToolCalls.length,
      workflowMode,
      hasStructuredProposal,
      hasReadyPlanArtifacts,
      isPlanApproved: callbacks.getIsPlanApproved(),
    });
    const assistantHistoryText = serializeAssistantReplyForHistory(historyAssistantText, finalReplyOptions);
    const hasMeaningfulVisibleText = finalVisibleText.trim().length > 0;
    const wasTruncated = normalized.finishReason === "length";

    logAgentEvent("normalized_turn", {
      iteration,
      visibleChars: normalized.visibleText.length,
      hiddenThoughtChars: normalized.hiddenThought.length,
      replyOptions: normalized.replyOptions.length,
      toolCalls: effectiveToolCalls.length,
      finishReason: normalized.finishReason || "unknown",
      hasStructuredProposal,
      planStage: currentPlanStageForReview,
      isPlanApproved: callbacks.getIsPlanApproved(),
    });

    // 4. Handle turn termination or continuation
    if (shouldPauseForUserChoice) {
      logAgentEvent("reply_options_pause", {
        iteration,
        replyOptions: finalReplyOptions.length,
        optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
        droppedToolCalls: effectiveToolCalls.length,
        workflowMode,
        turnIntent,
      });
      callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });
      callbacks.onStatusChange("idle");
      return;
    }

    if (effectiveToolCalls.length === 0) {
        // ── Plan Mode Interception ────────────────────────────────
        // In Plan mode, only enter review when the model has either:
        // 1. submitted a valid top-level proposal payload, or
        // 2. finished writing spec artifacts up to a legacy ready_to_execute stage.
        // Ordinary summaries / progress notes stay in ChatArea only.
        if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && (hasStructuredProposal || hasReviewablePlanArtifacts)) {
          callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });
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
          // Approved — 保留计划文件给右侧 Plan 面板继续展示，由用户在文件树或计划面板中手动删除。
          callbacks.onPlanStageChanged("executing");
          const continuationMsg: AgentMessage = {
            role: "user",
            content: buildApprovedPlanContinuationPrompt(callbacks),
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
        const hasMeaningfulSourcePlanText = sourceVisibleText.trim().length > 0;
        const shouldMaterializeFallbackPlan =
          planningStillIncomplete &&
          hasMeaningfulSourcePlanText &&
          !hasReviewablePlanArtifacts &&
          (sawPlanModeToolActivity || wasTruncated);
        const shouldRefineLongPlanIntoChoice =
          planningStillIncomplete &&
          hasMeaningfulVisibleText &&
          wasTruncated &&
          !shouldMaterializeFallbackPlan;
        const shouldForcePlanContinuation = planningStillIncomplete && !hasMeaningfulVisibleText;

        if (shouldMaterializeFallbackPlan) {
          callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });

          if (usedPlanRecoveryPrompt) {
            logAgentEvent("loop_stop", {
              reason: "plan_recovery_prompt_limit",
              iteration,
              visibleChars: sourceVisibleText.length,
              finishReason: normalized.finishReason || "unknown",
            });
            callbacks.onNonActionableStop(
              buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
              "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return;
          }

          usedPlanRecoveryPrompt = true;
          logAgentEvent("plan_recovery_prompt_start", {
            iteration,
            visibleChars: sourceVisibleText.length,
            finishReason: normalized.finishReason || "unknown",
            sawPlanModeToolActivity,
          });
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildPlanRecoveryPrompt(callbacks, sourceVisibleText, attemptedPlanWriteTargets),
          });
          continue;
        }

        if (shouldRefineLongPlanIntoChoice) {
          callbacks.onStatusChange("running");
          consecutiveNoToolCount++;
          logAgentEvent("plan_refine_long_output", {
            iteration,
            consecutiveNoToolCount,
            visibleChars: normalized.visibleText.length,
            finishReason: normalized.finishReason || "unknown",
          });
          if (consecutiveNoToolCount >= MAX_NO_ACTION_RETRIES) {
            logAgentEvent("loop_stop", {
              reason: "plan_refine_long_output_limit",
              iteration,
              consecutiveNoToolCount,
            });
            callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });
            callbacks.onNonActionableStop(
              buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
              "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return;
          }
          const language = callbacks.getPreferredLanguage();
          callbacks.appendMessage({
            role: "user",
            content:
              language === "zh"
                ? "上一条规划内容过长并发生截断。不要继续输出长篇计划，也不要写入 `.MAIN/plans/`。请把刚才内容收束成不超过 8 条要点，然后用面向用户的口吻提出 2-4 个可点击选项。每个 `<option>` 必须是用户点击后会发送的完整选择，不要写成“是否……”问题句。使用 `<user_options>` 后立刻停止等待。"
                : "The previous planning reply was too long and was truncated. Do not continue with a long plan and do not write `.MAIN/plans/` files. Condense it into no more than 8 bullets, then offer 2-4 decision options with `<user_options>` and stop immediately.",
          });
          continue;
        }

        if (shouldForcePlanContinuation) {
          consecutiveNoToolCount++;
          if (consecutiveNoToolCount >= MAX_NO_ACTION_RETRIES) {
            logAgentEvent("loop_stop", {
              reason: "force_plan_continuation_limit",
              iteration,
              consecutiveNoToolCount,
            });
            callbacks.onNonActionableStop(
              buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "no_output"),
              "no_output",
            );
            callbacks.onStatusChange("idle");
            return;
          }
          const language = callbacks.getPreferredLanguage();

          const missingStepHint =
            language === "zh"
              ? currentPlanStage === "requirements"
                ? "你已经有 requirements.md，下一步必须基于现有需求规格生成 `.MAIN/plans/design.md`；如果设计方向仍不明确，只能用 `<user_options>` 给出面向用户的选择并停止。不要重复读取已读文件。"
                : currentPlanStage === "design"
                ? "你已经有 design.md，下一步应输出正式 Proposal 或给用户关键选择；不要在批准前提前生成 tasks.md。"
                : currentPlanStage === "bugfix"
                ? "你已经有 bugfix.md，下一步应输出正式 Proposal 或给用户关键选择；不要在批准前提前生成 tasks.md。"
                : sawPlanModeToolActivity
                ? "你已经开始做项目探索了，但还没有给出可让用户决策的规划结果。下一步应先收束分歧并询问用户。"
                : "请先给出可让用户决策的规划问题。"
              : currentPlanStage === "requirements"
              ? "requirements.md exists. Next generate `.MAIN/plans/design.md` from the existing requirements; if the design direction is still unclear, offer `<user_options>` and stop. Do not repeat reads of files already in context."
              : currentPlanStage === "design"
              ? "design.md exists. Next submit the formal Proposal or offer the key choices; do not generate tasks.md before approval."
              : currentPlanStage === "bugfix"
              ? "bugfix.md exists. Next submit the formal Proposal or offer the key choices; do not generate tasks.md before approval."
              : sawPlanModeToolActivity
              ? "You have started project exploration but have not produced a planning result the user can decide on. Next condense the tradeoffs and ask the user."
              : "First present a planning question the user can decide on.";

          const continuationMsg: AgentMessage = {
            role: "user",
            content:
              language === "zh"
                ? `当前规划还没有进入可执行阶段。${missingStepHint}\n` +
                  `${CONCISE_PLAN_ARTIFACT_HINT_ZH}\n` +
                  "请继续规划，并在本轮结束前完成以下其一：\n" +
                  "1. 用普通 Markdown 输出 3-8 条关键判断，然后用面向用户的口吻给出 2-4 个 `<user_options>` 让用户选择；每个选项必须是用户可直接点击发送的完整选择，不要写成“是否……”问题句。\n" +
                  "2. 如果信息已经足够，输出正式 Proposal：`[PROPOSAL START]` + `# Proposed Plan` + 一页审阅摘要 + 合法 `<plan>` JSON。\n" +
                  "3. 如果这是复杂实现计划，必须生成 `.MAIN/plans/requirements.md` 与 `.MAIN/plans/design.md` 供审批；在用户批准之前不要生成 `tasks.md` 或修改源码。\n" +
                  `${currentPlanStage === "requirements" ? "当前已经有 requirements.md，本轮不要重复读文件；请直接写 design.md，或用 user_options 询问设计分叉。\n" : ""}` +
                  `${wasTruncated ? "你上一条回复已经发生截断，请从中断处继续，不要重头重复。\n" : ""}` +
                  "不要只输出一句总结、结束语，或空结束符。"
                : `The current plan has not reached an executable stage. ${missingStepHint}\n` +
                  `${CONCISE_PLAN_ARTIFACT_HINT_EN}\n` +
                  "Continue planning and complete one of these before ending this turn:\n" +
                  "1. Output 3-8 key judgments in Markdown, then offer 2-4 `<user_options>` for the user to choose from.\n" +
                  "2. If there is enough information, output the formal Proposal: `[PROPOSAL START]` + `# Proposed Plan` + one-page review summary + valid `<plan>` JSON.\n" +
                  "3. For complex implementation planning, create `.MAIN/plans/requirements.md` and `.MAIN/plans/design.md` for review; do not generate `tasks.md` or edit source files before approval.\n" +
                  `${currentPlanStage === "requirements" ? "requirements.md already exists. Do not repeat file reads in this turn; write design.md directly, or ask for design choices with user_options.\n" : ""}` +
                  `${wasTruncated ? "Your previous reply was truncated; continue from the interruption point without restarting.\n" : ""}` +
                  "Do not output only a summary, sign-off, or empty stop.",
          };
          callbacks.appendMessage(continuationMsg);
          continue;
        }

        const truncatedWithoutToolCall = wasTruncated && workflowMode !== "chat";
        const missingToolCallRepromptKind = compactedProseCodeDump || truncatedWithoutToolCall
          ? "generic"
          : resolveMissingToolCallRepromptKind({
              workflowMode,
              visibleText: normalized.visibleText,
              mainModeKey,
              recentWrite: recentSuccessfulProjectWrite
                ? {
                    lastSuccessfulToolName: recentSuccessfulProjectWrite.name,
                    lastSuccessfulTargetPath: recentSuccessfulProjectWrite.target,
                    lastSuccessfulTargetOutsidePlan: !isPlanArtifactPath(recentSuccessfulProjectWrite.target),
                    recoveringFromEmptyAssistantReply: recoveringFromEmptyAssistantReplyAfterWrite,
                  }
                : {
                    recoveringFromEmptyAssistantReply: recoveringFromEmptyAssistantReplyAfterWrite,
                  },
            });
        const shouldRepromptForMissingToolCall =
          (!hasMeaningfulVisibleText && workflowMode !== "chat") ||
          missingToolCallRepromptKind !== "none";

        if (shouldRepromptForMissingToolCall) {
          callbacks.onStatusChange("running");
          consecutiveNoToolCount++;
          if (!hasMeaningfulVisibleText) {
            callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          }
          logAgentEvent("missing_tool_reprompt", {
            iteration,
            kind: missingToolCallRepromptKind === "none" ? "generic" : missingToolCallRepromptKind,
            consecutiveNoToolCount,
            visibleChars: normalized.visibleText.length,
            preservedVisibleText: hasMeaningfulVisibleText,
          });
          if (consecutiveNoToolCount >= MAX_NO_ACTION_RETRIES) {
            logAgentEvent("loop_stop", {
              reason: "missing_tool_reprompt_limit",
              iteration,
              consecutiveNoToolCount,
              kind: missingToolCallRepromptKind === "none" ? "generic" : missingToolCallRepromptKind,
            });
            callbacks.onNonActionableStop(
              buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "missing_tool_loop"),
              "missing_tool_loop",
            );
            callbacks.onStatusChange("idle");
            return;
          }

          const continuationMsg: AgentMessage = {
            role: "user",
            content: buildMissingToolCallContinuationPrompt(
              missingToolCallRepromptKind === "none" ? "generic" : missingToolCallRepromptKind,
              callbacks.getPreferredLanguage(),
              consecutiveNoToolCount,
            ),
          };
          if (missingToolCallRepromptKind === "post_write_verify") {
            recoveringFromEmptyAssistantReplyAfterWrite = true;
          }
          callbacks.appendMessage(continuationMsg);
          continue;
        }

        // No intent detected — genuinely done
        const approvedPlanTasks = workflowMode === "plan" && callbacks.getIsPlanApproved()
          ? callbacks.getPlanTasks()
          : [];
        const approvedPlanMissingTasks =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          approvedPlanTasks.length === 0;
        const hasRemainingApprovedPlanTasks =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          approvedPlanTasks.some((task) => !isPlanTaskTrustedComplete(task));

        if (approvedPlanMissingTasks || hasRemainingApprovedPlanTasks) {
          callbacks.onStatusChange("running");
          consecutiveNoToolCount++;
          if (consecutiveNoToolCount >= MAX_NO_ACTION_RETRIES) {
            logAgentEvent("loop_stop", {
              reason: "remaining_plan_tasks_limit",
              iteration,
              consecutiveNoToolCount,
            });
            callbacks.onError("计划执行过程中模型连续多次提前停下，但仍有未完成任务。已中止本轮，请重试或切换更稳定的模型。");
            callbacks.onStatusChange("error");
            return;
          }

          const remainingTasks = approvedPlanTasks.filter((task) => !isPlanTaskTrustedComplete(task)).slice(0, 3);
          const remainingText = remainingTasks.length > 0
            ? remainingTasks.map((task) => `- ${task.text}`).join("\n")
            : callbacks.getPreferredLanguage() === "zh"
            ? "- 先生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
            : "- First generate `.MAIN/plans/tasks.md`, then execute source or deliverable writes.";
          const language = callbacks.getPreferredLanguage();
          callbacks.appendMessage({
            role: "user",
            content:
              (approvedPlanMissingTasks
                ? buildApprovedPlanContinuationPrompt(callbacks) + "\n\n"
                : language === "zh"
                ? "继续执行 tasks.md 中证据未满足的任务。不要重复计划说明，直接根据当前进度继续实现下一个任务；如果需要修改文件，继续使用工具调用。凡是任务里带有 shell 命令的，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr；长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查结果。完成当前任务后，必须先产生真实文件/命令/验证证据，再把 `.MAIN/plans/tasks.md` 中对应 checkbox 更新为 `[x]`；不要删除已完成或旧任务记录，只有所有任务证据满足后才能结束。\n下一批优先任务：\n"
                : "Continue executing tasks whose evidence is not satisfied. Do not restate the plan; just move to the next task based on the current progress. If a task includes shell commands, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status. After each task, produce real file/command/verification evidence before updating the matching checkbox in `.MAIN/plans/tasks.md`; do not delete completed or previous task records. Only stop when every task has satisfied evidence.\nNext priority tasks:\n") +
              remainingText +
              "\n\n" +
              buildPlanCommandExecutionHint(approvedPlanTasks, language),
          });
          continue;
        }

        if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
          callbacks.onPlanStageChanged("completed");
        }

        if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && currentPlanStage !== "ready_to_execute") {
          logAgentEvent("loop_stop", {
            reason: "plan_waiting_for_user_or_summary",
            iteration,
            visibleChars: normalized.visibleText.length,
            replyOptions: normalized.replyOptions.length,
            planStage: currentPlanStage,
          });
          callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });
          callbacks.onNonActionableStop(
            buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
            "incomplete_plan",
          );
          callbacks.onStatusChange("idle");
          return;
        }

        logAgentEvent("loop_stop", {
          reason: "assistant_text_done",
          iteration,
          visibleChars: normalized.visibleText.length,
          replyOptions: normalized.replyOptions.length,
        });
        callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });
        callbacks.onStatusChange("idle");
        return;
      }

    // Tools have been found, reset the no-tool streak
    consecutiveNoToolCount = 0;
    logAgentEvent("tool_calls_detected", {
      iteration,
      count: effectiveToolCalls.length,
      names: effectiveToolCalls.map((call) => call.name).slice(0, 12),
    });

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

    // Partition tool calls into auto-executable, spec file writes
    // (auto-approved in Plan Mode), and review-gated tools.
    const readOnlyCalls: ToolCallToExecute[] = [];
    const specFileCalls: ToolCallToExecute[] = [];
    const writeCalls: ToolCallToExecute[] = [];
    const readOnlyCallSignatures = new Map<string, string>();
    const queuedReadOnlySignatures = new Set<string>();
    let allResults: ToolExecutionResult[] = [];

    for (const tc of effectiveToolCalls) {
      const toolArgs = parseToolCallArguments(tc);
      const target = getToolTarget(tc.name, toolArgs);

      if (!availableToolNames.has(tc.name)) {
        const message = callbacks.getPreferredLanguage() === "zh"
          ? `工具 "${tc.name}" 当前没有暴露给 ${runtimeIntent} 运行意图。请使用本轮可用工具；如果这是已批准计划的执行步骤，请继续按执行阶段恢复。`
          : `Tool "${tc.name}" is not exposed for the current ${runtimeIntent} runtime intent. Use an available tool; if this is approved plan execution, continue from the execution stage.`;
        callbacks.onToolError(tc.name, target, message);
        allResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: `Error: ${message}`,
          isError: true,
        });
        continue;
      }

      if (isToolAutoExecutableForCall(tc.name, toolArgs, toolCapabilityRegistry, config.toolPermissionPolicy)) {
        const signature = buildReadOnlyCacheSignature(tc.name, toolArgs);
        const cached = readOnlyResultCache.get(signature);
        const fileReadMetadata =
          tc.name === "read_file" && typeof toolArgs.path === "string"
            ? await readFileMetadataIfAvailable(toolArgs.path, workspace)
            : null;
        const fileReadSignature =
          tc.name === "read_file" && typeof toolArgs.path === "string"
            ? buildFileReadSignature(fileReadMetadata?.path ?? toolArgs.path, toolArgs)
            : "";
        const fileReadState = fileReadSignature ? fileReadStates.get(fileReadSignature) : undefined;

        if (fileReadState) {
          const metadata = fileReadMetadata ?? await readFileMetadataIfAvailable(fileReadState.path, workspace);
          const unchanged =
            metadata != null &&
            metadata.sizeBytes === fileReadState.sizeBytes &&
            metadata.modifiedMs === fileReadState.modifiedMs;

          if (!unchanged) {
            fileReadStates.delete(fileReadSignature);
          } else {
            const duplicateCount = (readOnlyDuplicateSkipCounts.get(fileReadSignature) ?? 0) + 1;
            readOnlyDuplicateSkipCounts.set(fileReadSignature, duplicateCount);
            const shouldPushPlanReadLimit =
              workflowMode === "plan" &&
              !callbacks.getIsPlanApproved() &&
              duplicateCount >= PLAN_REPEAT_READ_LIMIT;
            if (shouldPushPlanReadLimit) {
              logAgentEvent("plan_repeat_read_limit", {
                iteration,
                stage: callbacks.getPlanStage(),
                tool: tc.name,
                target: target || fileReadState.path,
                duplicateCount,
              });
            }
            const content = shouldPushPlanReadLimit
              ? appendPlanRepeatReadLimitGuidance(
                  buildFileUnchangedStub(fileReadState),
                  callbacks.getPreferredLanguage(),
                  callbacks.getPlanStage(),
                )
              : buildFileUnchangedStub(fileReadState);
            allResults.push({
              toolCallId: tc.id,
              name: tc.name,
              target,
              content,
              displayContent: `${FILE_UNCHANGED_STUB}: ${target || fileReadState.path}`,
              isError: false,
            });
            continue;
          }
        }

        if (cached || queuedReadOnlySignatures.has(signature)) {
          const duplicateCount = (readOnlyDuplicateSkipCounts.get(signature) ?? 0) + 1;
          readOnlyDuplicateSkipCounts.set(signature, duplicateCount);
          const shouldPushPlanReadLimit =
            workflowMode === "plan" &&
            !callbacks.getIsPlanApproved() &&
            duplicateCount >= PLAN_REPEAT_READ_LIMIT;
          if (shouldPushPlanReadLimit) {
            logAgentEvent("plan_repeat_read_limit", {
              iteration,
              stage: callbacks.getPlanStage(),
              tool: tc.name,
              target,
              duplicateCount,
            });
          }
          const duplicateContent = formatCachedReadOnlyToolResult(tc.name, target, cached, duplicateCount);
          allResults.push({
            toolCallId: tc.id,
            name: tc.name,
            target,
            content: shouldPushPlanReadLimit
              ? appendPlanRepeatReadLimitGuidance(
                  duplicateContent,
                  callbacks.getPreferredLanguage(),
                  callbacks.getPlanStage(),
                )
              : duplicateContent,
            isError: false,
          });
          continue;
        }

        queuedReadOnlySignatures.add(signature);
        readOnlyCallSignatures.set(tc.id, signature);
        if (fileReadSignature) readOnlyCallSignatures.set(`${tc.id}:file_read`, fileReadSignature);
        readOnlyCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
      } else if (workflowMode === "plan" && runtimeIntent !== "execute" && runtimeIntent !== "studio_workflow") {
        const approved = callbacks.getIsPlanApproved();
        const hasExecutableTasks = callbacks.getPlanTasks().length > 0;

        if (!approved && isPreApprovalPlanDraftWrite(tc.name, toolArgs)) {
          specFileCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
        } else if (approved && isExecutionPlanArtifactWrite(tc.name, toolArgs)) {
          specFileCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
        } else {
          if (target) attemptedPlanWriteTargets.push(target);
          const reason = !approved && isTasksPlanWrite(tc.name, toolArgs)
            ? "pre_approval_tasks"
            : approved && !hasExecutableTasks
            ? "missing_tasks_before_source"
            : "pre_approval_source_write";
          allResults.push(buildPlanGateBlockedResult(tc, toolArgs, callbacks, reason));
        }
      } else {
        writeCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
      }
    }

    // Execute read-only tools concurrently (claude-code-haha pattern)
    if (readOnlyCalls.length > 0) {
      const readResults = await executeReadOnlyToolsConcurrently(
        readOnlyCalls,
        workspace,
        callbacks,
        iterationAllTools,
        hooksConfig,
      );
      for (const result of readResults) {
        const signature = readOnlyCallSignatures.get(result.toolCallId);
        if (signature && !result.isError) {
          readOnlyResultCache.set(signature, {
            name: result.name,
            target: result.target,
            content: result.content,
          });
          readOnlyDuplicateSkipCounts.delete(signature);
        }
        const fileReadSignature = readOnlyCallSignatures.get(`${result.toolCallId}:file_read`);
        if (fileReadSignature && result.name === "read_file" && !result.isError) {
          const parsedCall = readOnlyCalls.find((call) => call.id === result.toolCallId);
          const args = parsedCall ? parseToolCallArguments(parsedCall) : {};
          const path = typeof args.path === "string" ? args.path : result.target;
          const metadata = await readFileMetadataIfAvailable(path, workspace);
          const contentHash = hashString(result.content);
          const previous = fileReadStates.get(fileReadSignature);
          if (metadata && (!previous || previous.contentHash !== contentHash || previous.modifiedMs !== metadata.modifiedMs || previous.sizeBytes !== metadata.sizeBytes)) {
            fileReadStates.set(fileReadSignature, {
              signature: fileReadSignature,
              path: metadata.path,
              argsKey: buildRepeatLoopArgsKey(
                Object.fromEntries(Object.entries(args).filter(([key]) => key !== "path")),
              ),
              contentHash,
              contentLength: result.content.length,
              sizeBytes: metadata.sizeBytes,
              modifiedMs: metadata.modifiedMs,
              modelContent: result.content,
              updatedAt: Date.now(),
            });
            pruneFileReadStates(fileReadStates);
          }
          readOnlyDuplicateSkipCounts.delete(fileReadSignature);
        }
      }
      allResults.push(...readResults);
    }

    // Execute spec file writes concurrently — auto-approved, no user review needed
    if (specFileCalls.length > 0) {
      const specResults = await executeReadOnlyToolsConcurrently(
        specFileCalls,
        workspace,
        callbacks,
        iterationAllTools,
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
        iterationAllTools,
        hooksConfig,
      );
      allResults.push(result);

      // Check if the loop was aborted during user review
      if (abortController.signal.aborted) {
        callbacks.onStatusChange("idle");
        return;
      }
    }

    for (const result of allResults) {
      if (result.isError) continue;
      if (isProjectSourceWriteResult(result)) {
        recentSuccessfulProjectWrite = {
          name: result.name,
          target: result.target,
        };
        recoveringFromEmptyAssistantReplyAfterWrite = false;
        continue;
      }
      if (EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name)) {
        recentSuccessfulProjectWrite = null;
        recoveringFromEmptyAssistantReplyAfterWrite = false;
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
      const toolArgs = parseToolCallArguments(tc);
      const autoExecutable = isToolAutoExecutableForCall(
        tc.name,
        toolArgs,
        toolCapabilityRegistry,
        config.toolPermissionPolicy,
      );
      const repeatCheck = registerToolCallForRepeatGuard(recentToolCalls, tc.name, toolArgs, autoExecutable);
      if (!repeatCheck.repeated) continue;

      const target = getToolTarget(tc.name, toolArgs);
      if (autoExecutable && !repeatGuardRecoveredSignatures.has(repeatCheck.signature)) {
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

      const fatalMessage = formatRepeatLoopFatalMessage(tc.name, target, repeatCheck.threshold);
      const remainingTask = callbacks.getPlanTasks().find((task) => !isPlanTaskTrustedComplete(task));
      const recentEvidence = callbacks.getPlanExecutionEvidenceLedger().slice(-5);
      const recentEvidenceText = recentEvidence.length > 0
        ? recentEvidence.map((entry) => `${entry.kind}:${entry.target || entry.value} via ${entry.sourceTool}`).join(" | ")
        : callbacks.getPreferredLanguage() === "zh" ? "无" : "none";
      const structuredRecovery = callbacks.getPreferredLanguage() === "zh"
        ? [
            "RecoveryDetails:",
            `- duplicateTool: ${tc.name}`,
            `- target: ${target || "unknown"}`,
            `- duplicateCount: ${repeatCheck.threshold}+`,
            `- recentSuccessfulEvidence: ${recentEvidenceText}`,
            `- suggestedNextTask: ${remainingTask?.text || "重新读取 tasks.md 与证据摘要后继续"}`,
          ].join("\n")
        : [
            "RecoveryDetails:",
            `- duplicateTool: ${tc.name}`,
            `- target: ${target || "unknown"}`,
            `- duplicateCount: ${repeatCheck.threshold}+`,
            `- recentSuccessfulEvidence: ${recentEvidenceText}`,
            `- suggestedNextTask: ${remainingTask?.text || "reread tasks.md plus the evidence summary, then continue"}`,
          ].join("\n");
      const recoveryHint = remainingTask
        ? callbacks.getPreferredLanguage() === "zh"
          ? `\nRecovery: 请开启新的恢复上下文，从证据未满足的任务继续：${remainingTask.text}`
          : `\nRecovery: start a fresh recovery context and continue from the first task with unsatisfied evidence: ${remainingTask.text}`
        : callbacks.getPreferredLanguage() === "zh"
        ? "\nRecovery: 请开启新的恢复上下文，重新读取 tasks.md 与证据摘要后继续。"
        : "\nRecovery: start a fresh recovery context, reread tasks.md plus the evidence summary, then continue.";
      callbacks.onError(`${fatalMessage}\n${structuredRecovery}${recoveryHint}`);
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
