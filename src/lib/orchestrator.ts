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
import type { ContextMemoryState } from "./contextMemory";
import { clampContextLimitToReported } from "./contextWindow";
import { generateId } from "./utils";
import { buildSystemPrompt } from "./systemPrompt";
import {
  discoverAllMcpTools,
  getMcpToolServerMap,
  setMcpToolServerMap,
  type MCPServer,
  type MCPTool,
  type MCPServerStatusSnapshot,
} from "./mcpClient";
import { getFileMetadata } from "./ipc";
import { ensureVisibleConclusionWithPolicy, isAssistantTurnEmpty, isSyntheticVisibleConclusion, normalizeAssistantTurn } from "./normalizedTurn";
import { hasStructuredPlanProposal } from "./planProposal";
import {
  buildReadOnlyPermissionContinuationPrompt,
  hasOnlyReadOnlyPermissionReplyOptions,
  serializeAssistantReplyForHistory,
  shouldAutoContinueReadOnlyPermission as shouldAutoContinueReadOnlyPermissionState,
  shouldPauseForReplyOptions,
  stripReadOnlyPermissionPrompt,
} from "./replyOptions";
import { buildToolDiffPreview, type ToolDiffPreview } from "./toolDiff";
import { syncPlanArtifactAfterToolSuccess } from "./planArtifactSync";
import {
  buildReadFileWindowContinuationGuidance,
  extractReadFileWindowMetadata,
} from "./readFileWindow";
import {
  initialLifecycleStateForPlanAction,
  planRuntimeToolCall,
  type ToolLifecycleState,
} from "./runtimeTools";
import type { AppConfig, Skill } from "../store/useAppStore";
import {
  buildPlanTaskEvidenceAudit,
  detectResponseLanguageMismatch,
  detectPlanArtifactKind,
  extractPlanTasks,
  findDroppedPlanTasks,
  getPendingPlanTaskCommandFocus,
  hasBrowserValidationCapability,
  describePlanValidationDecision,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
  isEphemeralPlanArtifactPath,
  isPlanTaskTrustedComplete,
  validatePlanArtifactContent,
  type PlanExecutionEvidenceEntry,
  type PlanExecutionProgressPhase,
  type PlanExecutionProgressUpdate,
  type PlanTaskEvidenceAudit,
  type PlanTask,
  type ReplyOption,
} from "./workflowModels";
import type { MainModeKey } from "./mainModes";
import { hasExplicitUnityConsoleDiagnosticCue, type CommandDirective, type ResolvedUserIntent } from "./runIntent";
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
import type { PendingSlashCommand, StudioAgentKey, StudioConfig } from "./gameStudioCatalog";
import {
  buildRepeatLoopArgsKey,
  buildRepeatLoopSignature,
  formatRepeatLoopFatalMessage,
  formatRepeatLoopRecoveryMessage,
  formatTargetProgressLoopRecoveryMessage,
  getShellMutationTargetForLoopGuard,
  isReadOnlyShellInspectionToolCall,
  registerTargetProgressForLoopGuard,
  registerToolCallForRepeatGuard,
} from "./repetitionGuard";
import {
  buildToolCapabilityRegistry,
  filterToolDefinitionsForIntent,
  isUnityApplyTextPrecisePatchArgs,
  isLocalFileReadApproved,
  type McpRoutingPriorityMode,
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
import {
  getModelInstructionProfile,
  normalizeCloudToolProtocol,
  normalizeLocalToolProtocol,
  resolveEffectiveCloudApiFormat,
  type CloudToolProtocol,
} from "./cloudProtocol";
import { getErrorMessage } from "./errorUtils";
import { resolveProtocolPackageReadPath } from "./protocolPackages";
import { resolveStudioCompatToolArgs } from "./studioCompatPathResolver";
import { isCloudGatewayTimeoutMessage, isRetryableCloudErrorMessage } from "./cloudRetry";
import {
  buildMissingToolCallContinuationPrompt,
  resolveMissingToolCallRepromptKind,
} from "./missingToolCallReprompt";
import { buildPlanApprovalChoiceHint } from "./planControl";
import {
  buildPlanExecutionProgressUpdate,
  buildExecuteMaxIterationsPauseNotice,
  buildPlanMaxIterationsCheckpoint,
  buildPlanMaxIterationsPauseNotice,
  type PlanMaxIterationsCheckpoint,
  type PlanToolActivitySummary,
} from "./planExecutionRecovery";
import {
  buildPlanExecutionNoToolRecoveryPrompt,
} from "./planExecutionNoTool";
import { validateShellToolContract } from "./toolExecutionContract";
import { buildExecutionDigest } from "./executionDigest";
import {
  formatToolFeedbackEnvelope,
  type ToolFeedbackStatus,
} from "./toolFeedbackEnvelope";
import {
  withEventSchema,
  type MainThreadEventInput,
  type MainThreadEvent,
  type MainThreadItem,
} from "./turnEvents";
import { normalizeToolCallForExecution } from "./toolCallNormalization";
import {
  composeReviewableDesignFromEvidence,
  materializePlanArtifactFromVisibleText,
} from "./planMaterialization";
import { formatToolPresentation } from "./toolPresentation";
import type { ShellPermissionApproval } from "./ipc";
import {
  buildTaskTargetingProfile,
  getTaskTargetingEvidenceKey,
  shouldBlockToolCallForTargeting,
  type TaskOrchestratorPhase,
} from "./taskTargeting";

// ── Spec file auto-approval helpers ────────────────────────────────

const PRE_APPROVAL_PLAN_FILE_NAMES = new Set(["requirements.md", "design.md"]);
const EXECUTION_PLAN_FILE_NAMES = new Set(["requirements.md", "design.md", "tasks.md"]);
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
const FORCE_CONTEXT_TEXT_CHARS = 60_000;
const FORCE_CONTEXT_TOOL_RESULT_CHARS = 35_000;
const FORCE_CONTEXT_TOOL_MESSAGE_COUNT = 12;
const FORCE_CONTEXT_TOOL_LOOP_INTERVAL = 6;

function getMessageContentText(content: AgentMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContentPart => part.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

function computeContextForceReason(input: {
  messages: AgentMessage[];
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
}): { shouldForce: boolean; reason: string | null; textChars: number; toolChars: number; toolMessages: number } {
  let textChars = 0;
  let toolChars = 0;
  let toolMessages = 0;
  for (const message of input.messages) {
    const text = getMessageContentText(message.content);
    textChars += text.length;
    if (message.role === "tool") {
      toolChars += text.length;
      toolMessages += 1;
    }
  }

  if (textChars >= FORCE_CONTEXT_TEXT_CHARS) {
    return { shouldForce: true, reason: "text_chars_threshold", textChars, toolChars, toolMessages };
  }
  if (toolChars >= FORCE_CONTEXT_TOOL_RESULT_CHARS) {
    return { shouldForce: true, reason: "tool_chars_threshold", textChars, toolChars, toolMessages };
  }
  if (toolMessages >= FORCE_CONTEXT_TOOL_MESSAGE_COUNT) {
    return { shouldForce: true, reason: "tool_message_threshold", textChars, toolChars, toolMessages };
  }
  if (
    input.workflowMode === "plan" &&
    input.isPlanApproved &&
    input.iteration > 1 &&
    input.iteration % FORCE_CONTEXT_TOOL_LOOP_INTERVAL === 0
  ) {
    return { shouldForce: true, reason: "approved_plan_loop_interval", textChars, toolChars, toolMessages };
  }
  return { shouldForce: false, reason: null, textChars, toolChars, toolMessages };
}

function getSessionTaskTargetingEvidence(sessionKey: string): Set<string> {
  const key = sessionKey || "__default__";
  const globalKey = "__MAIN_TASK_TARGETING_EVIDENCE__";
  const globalRecord = globalThis as typeof globalThis & {
    [globalKey]?: Map<string, Set<string>>;
  };
  if (!globalRecord[globalKey]) {
    globalRecord[globalKey] = new Map<string, Set<string>>();
  }
  let evidence = globalRecord[globalKey]!.get(key);
  if (!evidence) {
    evidence = new Set<string>();
    globalRecord[globalKey]!.set(key, evidence);
  }
  return evidence;
}

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

function isEphemeralPlanArtifactMutation(name: string, args: Record<string, unknown>): boolean {
  if (!PLAN_ARTIFACT_MUTATION_TOOLS.has(name)) return false;
  return isEphemeralPlanArtifactPath((args.path as string) || "");
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

const READ_BEFORE_MODIFY_WRITE_TOOLS = new Set(["write_file", "replace_in_file"]);

function normalizeEvidencePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase();
}

function getParentEvidencePath(path: string): string {
  const normalized = normalizeEvidencePath(path);
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : ".";
}

function getSessionReadBeforeModifyEvidence(sessionKey: string): Set<string> {
  const key = sessionKey || "__default__";
  const globalKey = "__MAIN_READ_BEFORE_MODIFY_EVIDENCE__";
  const globalRecord = globalThis as typeof globalThis & {
    [globalKey]?: Map<string, Set<string>>;
  };
  if (!globalRecord[globalKey]) {
    globalRecord[globalKey] = new Map<string, Set<string>>();
  }
  let evidence = globalRecord[globalKey]!.get(key);
  if (!evidence) {
    evidence = new Set<string>();
    globalRecord[globalKey]!.set(key, evidence);
  }
  return evidence;
}

function rememberReadBeforeModifyEvidence(
  sessionKey: string,
  name: string,
  args: Record<string, unknown>,
  result: ToolExecutionResult,
): void {
  if (result.isError) return;
  const evidence = getSessionReadBeforeModifyEvidence(sessionKey);
  const path = typeof args.path === "string" ? args.path : result.target;
  if (name === "read_file" || name === "get_file_outline" || name === "read_document") {
    if (path) evidence.add(`file:${normalizeEvidencePath(path)}`);
    return;
  }
  if (name === "list_directory") {
    const dir = typeof args.path === "string" && args.path.trim() ? args.path : ".";
    evidence.add(`dir:${normalizeEvidencePath(dir) || "."}`);
    return;
  }
  if (name === "get_project_skeleton" || name === "glob_search" || name === "grep_search") {
    evidence.add("workspace:structure");
    return;
  }
  if (isReadOnlyShellInspectionToolCall(name, args)) {
    evidence.add("workspace:structure");
    return;
  }
  if (/unity|yaml|reference|asset|prefab|scene/i.test(name) && /read|list|search|get|query|find/i.test(name)) {
    evidence.add("unity:context");
  }
}

async function buildReadBeforeModifyValidationError(
  tc: ToolCallToExecute,
  args: Record<string, unknown>,
  workspace: string,
  callbacks: OrchestratorCallbacks,
): Promise<ToolExecutionResult | null> {
  if (!READ_BEFORE_MODIFY_WRITE_TOOLS.has(tc.name)) return null;
  const runtimeIntent = callbacks.getRuntimeRunIntent?.() ?? callbacks.getCurrentRunIntent();
  if (runtimeIntent !== "execute" && runtimeIntent !== "studio_workflow" && !callbacks.getIsPlanApproved()) {
    return null;
  }

  const path = typeof args.path === "string" ? args.path : "";
  if (!path || isPlanArtifactPath(path)) return null;

  const normalizedPath = normalizeEvidencePath(path);
  const evidence = getSessionReadBeforeModifyEvidence(callbacks.getSessionKey());
  if (callbacks.getWorkspaceTree().trim()) {
    evidence.add("workspace:structure");
  }
  const hasExactRead = evidence.has(`file:${normalizedPath}`);
  const hasParentRead = evidence.has(`dir:${getParentEvidencePath(path)}`) || evidence.has("workspace:structure");

  let existingFile = tc.name === "replace_in_file";
  if (tc.name === "write_file") {
    existingFile = !!(await readFileMetadataIfAvailable(path, workspace));
  }

  if (!existingFile && hasParentRead) return null;
  if (hasExactRead) return null;

  const target = getToolTarget(tc.name, args);
  const language = callbacks.getPreferredLanguage();
  const message = language === "zh"
    ? existingFile
      ? `READ_BEFORE_MODIFY_BLOCKED: 修改 ${path} 前必须先读取该文件。请先调用 read_file 或 get_file_outline 获取当前内容/结构，再重试写入。`
      : `READ_BEFORE_MODIFY_BLOCKED: 创建 ${path} 前需要先检查目标目录或项目结构。请先调用 get_project_skeleton 或 list_directory，再重试写入。`
    : existingFile
    ? `READ_BEFORE_MODIFY_BLOCKED: Read ${path} before modifying it. Call read_file or get_file_outline first, then retry the write.`
    : `READ_BEFORE_MODIFY_BLOCKED: Inspect the target directory or project structure before creating ${path}. Call get_project_skeleton or list_directory first, then retry the write.`;
  callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
  callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
  return {
    toolCallId: tc.id,
    name: tc.name,
    target,
    content: `Error: ${message}`,
    isError: true,
    lifecycleState: "blocked",
  };
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
  const missingRequiredMessage = `Tool '${name}' is missing required parameter(s): ${missing.join(", ")}. ` +
    `Required: ${required.join(", ")}. Please retry with the correct arguments.`;
  return missingRequiredMessage;
}

function validateToolExecutionContract(name: string, args: Record<string, unknown>, allTools: ToolDefinition[]): string | null {
  const requiredError = validateToolArgs(name, args, allTools);
  if (requiredError) return requiredError;
  return validateShellToolContract(name, args);
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
    ...(option.source ? { source: option.source } : {}),
  }));
}

/** Result returned when the user acts on a pending Action Card. */
export type ReviewDecision =
  | { action: "accept"; grantLocalFileReadPath?: string; shellPermissionApproval?: ShellPermissionApproval }
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
  getGameStudioConfig?: () => StudioConfig | null;
  getWorkspaceTree: () => string;
  getMcpServers: () => MCPServer[];
  getMcpDiscoveredTools: () => MCPTool[];
  getAssociatedPaths: () => string[];
  getSessionKey: () => string;
  getCurrentTurnId?: () => string | null;
  hasSessionHookInitialized: (sessionKey: string) => boolean;
  markSessionHookInitialized: (sessionKey: string) => void;
  // Planning & Management
  getCurrentRunIntent: () => ResolvedUserIntent;
  getRuntimeRunIntent?: () => ResolvedUserIntent;
  getCommandDirective?: () => CommandDirective | null;
  getWorkflowMode: () => "chat" | "edit" | "plan";
  getIsPlanApproved: () => boolean;
  getPlanApprovalChoice: () => string | null;
  getReadOnlyAutoApproveForSession: () => boolean;
  getApprovedLocalFileReadPaths: () => string[];
  getPlanStage: () => "idle" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed";
  getPlanTasks: () => PlanTask[];
  getPlanExecutionEvidenceLedger: () => PlanExecutionEvidenceEntry[];
  getPlanAutoResumeCount?: () => number;
  getStatus: () => "idle" | "running" | "pending_review" | "error";
  startNewTurn: () => void;
  getContextMemoryState?: () => ContextMemoryState | null;
  shouldForceXmlForProviderCompatibility?: () => boolean;
  onProviderCompatibilityFallback?: (reason: string) => void;
  onProviderNativeToolSuccess?: () => void;

  // UI updates
  onStreamToken: (token: string, messageId: string) => void;
  onStreamDone: (fullText: string, messageId: string, truncated: boolean) => void;
  onThought: (thought: string) => void;
  onAssistantFinalText: (text: string, replyOptions?: ReplyOption[], meta?: { hasToolCalls?: boolean }) => void;
  onStatusChange: (status: "idle" | "running" | "pending_review" | "error") => void;
  onError: (error: string) => void;
  onNonActionableStop: (message: string, reason: "no_output" | "no_action" | "missing_tool_loop" | "incomplete_plan") => void;
  onPlanArtifactUpdated: (path: string, content: string, kind: "requirements" | "design" | "tasks" | "bugfix") => void;
  onPlanStageChanged: (stage: "idle" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed") => void;
  onPlanTasksUpdated: (content: string) => void;
  onPlanExecutionProgress?: (progress: PlanExecutionProgressUpdate) => void;
  onPlanMaxIterationsCheckpoint?: (checkpoint: PlanMaxIterationsCheckpoint) => boolean | Promise<boolean>;
  onExecuteMaxIterationsCheckpoint?: (checkpoint: PlanMaxIterationsCheckpoint) => boolean | Promise<boolean>;
  onTurnSummaryReady: (summary: string) => void;
  onExecutionDigestUpdate?: (summary: string) => void;
  onTurnEvent?: (event: MainThreadEvent) => void;
  onHarnessRunUpdate?: (patch: Record<string, unknown>) => void;
  onInstructionsResolved: (resolved: ResolvedInstructionSet) => void;
  onHooksLoaded: (hooks: HookDefinition[], loadedAt?: number | null) => void;
  onHookStart: (event: HookEvent, hook: HookDefinition) => void;
  onHookResult: (record: HookExecutionRecord) => void;
  onHookBlocked: (event: HookEvent, reason: string, record?: HookExecutionRecord) => void;

  // Message history management
  appendMessage: (msg: AgentMessage) => void;
  replaceMessages: (msgs: AgentMessage[]) => void;
  onContextMemoryBuilt?: (state: ContextMemoryState, packet: string) => void;
  onContextCompress: (
    stats: {
      droppedCount: number;
      droppedMessageCount?: number;
      tokenCountBefore: number;
      tokenCountAfter: number;
      tokenReduction: number;
      compressedContext?: string;
      displaySummary?: string;
      memoryPacket?: string;
      microCompactionKind?: "none" | "tool_results" | "assistant_messages" | "mixed";
      microCompactedCount?: number;
      tokenBreakdown?: {
        topSourceLabel: string;
        topSourceTokens: number;
        total: number;
      };
    },
    reason: "proactive" | "reactive",
  ) => void;

  // Tool execution UI feedback
  onToolExecuting: (
    toolName: string,
    target: string,
    diff?: ToolDiffPreview,
    meta?: { toolCallId?: string },
  ) => void;
  onToolDone: (
    toolName: string,
    target: string,
    result: string,
    meta?: { toolCallId?: string },
  ) => void;
  onToolError: (
    toolName: string,
    target: string,
    error: string,
    meta?: { toolCallId?: string },
  ) => void;

  // Human-in-the-loop — only for write/execute tools.
  // Read-only tools are auto-executed by the orchestrator.
  requestReview: (toolCall: {
    name: string;
    arguments: Record<string, unknown>;
    risk?: "local_file_read";
    localFileReadPath?: string;
  }) => Promise<ReviewDecision>;
}

// ── Helpers ───────────────────────────────────────────────────────

function deriveStreamSettings(config: AppConfig): StreamSettings {
  if (config.activeProfile === "local") {
    const isOllama = config.local.provider === "Ollama";
    const toolProtocol = normalizeLocalToolProtocol(config.local.toolProtocol, config.local.provider);
    return {
      baseUrl: config.local.endpoint,
      apiKey: config.local.apiKey || "not-needed",
      model: config.local.model,
      sendSamplingParameters: true,
      temperature: 0.2,
      contextLimit: config.local.contextLimit,
      provider: config.local.provider,
      toolProtocol,
      // LM Studio / OMLX 的本地流式接口在桌面 WebView 中可能触发
      // “Load Failed”，统一交给 Tauri 后端请求，避开 WebView 限制。
      // Ollama 保留前端直连，因为它使用原生 /api/chat 流格式。
      useRustProxy: !isOllama,
    };
  }
  const cloudAuthMode = config.cloudExperimentalLoginEnabled === true ? config.cloud.auth?.mode ?? "api_key" : "api_key";
  return {
    baseUrl: config.cloud.endpoint || "https://api.openai.com/v1",
    apiKey: config.cloud.apiKey,
    model: config.cloud.model,
    apiProtocol: config.cloud.protocol || "openai",
    apiFormat: resolveEffectiveCloudApiFormat({
      protocol: config.cloud.protocol || "openai",
      apiFormat: config.cloud.apiFormat || "chat_completions",
      authMode: cloudAuthMode,
    }),
    authMode: cloudAuthMode,
    tokenRef: config.cloudExperimentalLoginEnabled === true ? config.cloud.auth?.tokenRef : undefined,
    customHeaders: config.cloud.customHeaders || "",
    disableResponseStorage: config.cloud.disableResponseStorage ?? true,
    reasoningEffort: config.thinkingPolicy === "action_only" ? "none" : (config.cloud.reasoningEffort ?? "none"),
    toolProtocol: normalizeCloudToolProtocol(config.cloud.toolProtocol),
    // Cloud profile should not inherit the local KV-cache/context limit.
    contextLimit: undefined,
    provider: config.cloud.provider,
    useRustProxy: true,  // Route through Rust to bypass WebView CORS
  };
}

function resolveEffectiveToolProtocol(config: AppConfig, settings: StreamSettings) {
  return config.activeProfile === "local"
    ? normalizeLocalToolProtocol(settings.toolProtocol, config.local.provider)
    : normalizeCloudToolProtocol(settings.toolProtocol);
}

export function resolveModelProtocolProfile(input: {
  activeProfile?: "local" | "cloud";
  provider?: string | null;
  model?: string | null;
  protocol?: string | null;
  configuredToolProtocol?: CloudToolProtocol | null;
  compatibilityOverride?: boolean | null;
}): {
  providerFamily: string;
  toolProtocol: CloudToolProtocol;
  reasoning: "native_hidden" | "tagged" | "none";
  notes: string[];
} {
  const activeProfile = input.activeProfile === "cloud" ? "cloud" : "local";
  const configured = input.configuredToolProtocol || "auto";
  const provider = String(input.provider || "").trim();
  const providerLower = provider.toLowerCase();
  const model = String(input.model || "").trim();
  const cloudProfile = getModelInstructionProfile({
    protocol: input.protocol || "openai",
    provider,
    model,
  });

  let toolProtocol: CloudToolProtocol = configured;
  if (activeProfile === "local") {
    toolProtocol = normalizeLocalToolProtocol(configured === "auto" ? undefined : configured, provider);
    if (input.compatibilityOverride === true) toolProtocol = "xml";
    if (input.compatibilityOverride === false && toolProtocol === "xml" && providerLower.includes("omlx")) {
      toolProtocol = "auto";
    }
  } else {
    toolProtocol = normalizeCloudToolProtocol(configured);
    if (toolProtocol === "auto") toolProtocol = cloudProfile.toolProtocolPreference;
    if (input.compatibilityOverride === true) toolProtocol = "xml";
    if (input.compatibilityOverride === false && toolProtocol === "xml" && cloudProfile.toolProtocolPreference !== "xml") {
      toolProtocol = "native";
    }
  }

  return {
    providerFamily: activeProfile === "local" ? provider || "local" : cloudProfile.provider,
    toolProtocol,
    reasoning: cloudProfile.reasoning,
    notes: cloudProfile.noiseRules,
  };
}

function shouldUseXmlToolProtocol(
  config: AppConfig,
  settings: StreamSettings,
  messages: AgentMessage[],
  compatibilityOverride?: boolean,
): boolean {
  const profile = resolveModelProtocolProfile({
    activeProfile: config.activeProfile,
    provider: settings.provider,
    model: settings.model,
    protocol: settings.apiProtocol,
    configuredToolProtocol: resolveEffectiveToolProtocol(config, settings),
    compatibilityOverride,
  });
  if (profile.toolProtocol === "xml") return true;
  if (compatibilityOverride === true) return true;
  if (compatibilityOverride === false) return false;
  return hasProviderNativeToolsDisabled(messages);
}

function prepareMessagesForToolProtocol(
  messages: AgentMessage[],
  config: AppConfig,
  settings: StreamSettings,
  compatibilityOverride?: boolean,
): AgentMessage[] {
  return shouldUseXmlToolProtocol(config, settings, messages, compatibilityOverride)
    ? buildCompatibilityRetryMessages(messages) as AgentMessage[]
    : messages;
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
const PLAN_EXPLORATION_REPEAT_READ_LIMIT = 1;
const EXECUTE_CONVERGENCE_PROMPT_RATIO = 0.72;
const PLAN_EXECUTE_CONVERGENCE_PROMPT_RATIO = 0.24;
const MAX_NO_PROGRESS_LOOP_REPEATS = 3;
const NO_PROGRESS_EXCLUDED_TOOLS = new Set([
  "execute_command",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

function stableProgressHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildNoProgressBatchSignature(results: ToolExecutionResult[]): string {
  const usable = results.filter((result) => !result.isError);
  if (usable.length === 0) return "";
  if (usable.every((result) => NO_PROGRESS_EXCLUDED_TOOLS.has(result.name))) return "";
  const fragments = usable
    .map((result) => {
      const contentHash = stableProgressHash(result.content || "");
      return `${result.name}::${result.target || ""}::${contentHash}`;
    })
    .sort();
  return fragments.join("||");
}

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
        return "模型没有生成可审批的计划草稿或计划文件，本轮已停止。请重新发送明确要求写入 `.MAIN/plans/design.md` 的计划请求，或切换到直接执行。";
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
      return "The model did not produce a reviewable plan draft or plan files, so this turn stopped. Send a clearer planning request that explicitly writes `.MAIN/plans/design.md`, or switch to direct execution.";
    default:
      return "The model only produced prose and did not create real tool calls or file changes, so this turn stopped.";
  }
}

function getPlanReviewArtifactLabel(
  stage: ReturnType<OrchestratorCallbacks["getPlanStage"]>,
  language: "zh" | "en",
): string {
  if (stage === "ready_to_execute") {
    return language === "zh"
      ? "`.MAIN/plans/design.md` 和 `.MAIN/plans/tasks.md`"
      : "`.MAIN/plans/design.md` and `.MAIN/plans/tasks.md`";
  }
  if (stage === "bugfix") return "`.MAIN/plans/bugfix.md`";
  return "`.MAIN/plans/design.md`";
}

function buildPlanReviewReadyMessage(
  language: "zh" | "en",
  stage: ReturnType<OrchestratorCallbacks["getPlanStage"]>,
): string {
  const artifact = getPlanReviewArtifactLabel(stage, language);
  if (language === "en") {
    return [
      `I generated the reviewable plan artifact ${artifact} and paused here for your approval.`,
      "Please review it in the Plan panel. If the direction, tech stack, output format, or scope is not right, reply with the adjustment; otherwise approve it to enter execution.",
    ].join("\n\n");
  }

  return [
    `我已经生成了可审批计划文件 ${artifact}，现在停在审批阶段。`,
    "请在右侧计划面板审阅；如果技术栈、输出形式、范围或方案方向不对，直接回复你的调整。确认无误后再批准进入执行。",
  ].join("\n\n");
}

function isSuccessfulPlanArtifactWriteResult(result: ToolExecutionResult): boolean {
  return (
    !result.isError &&
    PLAN_ARTIFACT_MUTATION_TOOLS.has(result.name) &&
    !!result.target &&
    isPlanArtifactPath(result.target)
  );
}

function buildHiddenThoughtOnlyContinuationPrompt(language: "zh" | "en", consecutiveNoToolCount: number): string {
  return language === "zh"
    ? [
        `上一条回复只有后台思考，没有给用户可见结论（第 ${consecutiveNoToolCount} 次）。`,
        "你已经读取/搜索了上下文；现在必须直接输出面向用户的 Markdown 结论。",
        "不要继续只返回 thinking/analysis 标签；除非真的缺少关键证据，否则不要再读同一批文件。",
        "结论至少包含：是否已经实现、哪些证据支持、仍缺什么或下一步。",
      ].join("\n")
    : [
        `The previous reply only contained hidden thinking and no user-visible conclusion (${consecutiveNoToolCount} time).`,
        "You have already read/searched the context; now output a user-visible Markdown conclusion.",
        "Do not return only thinking/analysis tags again. Do not reread the same files unless a key fact is still missing.",
        "Include at least: whether it is implemented, supporting evidence, and what is still missing or next.",
      ].join("\n");
}

function buildExecuteConvergencePrompt(language: "zh" | "en", iteration: number, maxIterations: number): string {
  return language === "zh"
    ? [
        `本轮 Execute 已进行 ${iteration}/${maxIterations} 轮工具循环，接近安全边界。`,
        "请先根据已有工具结果判断任务是否已经完成：如果完成，直接输出最终总结并停止，不要再调用工具。",
        "如果仍未完成，只调用一个最小必要的下一步工具；不要重复读取、重复验证或继续改同一个目标而没有新证据。",
      ].join("\n")
    : [
        `This Execute turn has reached ${iteration}/${maxIterations} tool-loop iterations and is approaching the safety boundary.`,
        "First decide from existing tool results whether the task is already complete. If it is complete, output the final summary and stop without more tools.",
      "If it is not complete, call exactly one smallest necessary next tool. Do not repeat reads, repeat validation, or keep editing the same target without new evidence.",
    ].join("\n");
}

function buildLanguageMismatchRecoveryPrompt(language: "zh" | "en"): string {
  return language === "zh"
    ? [
        "上一条可见回复语言与本轮目标语言不一致。",
        "不要解释语言策略，也不要复述过程。",
        "请基于已完成的上下文与证据，重新输出同等结论，并且必须使用简体中文。",
      ].join("\n")
    : [
        "The previous visible reply used the wrong language for this turn.",
        "Do not explain language policy and do not repeat process narration.",
      "Using the existing context and evidence, restate the same conclusion in English.",
      ].join("\n");
}

export function shouldRecoverLanguageMismatchTurn(input: {
  text: string;
  targetLanguage: "zh" | "en";
  suppressedByPlanGuard: boolean;
  toolCallCount: number;
  alreadyRetried: boolean;
}): {
  action: "recover_once" | "hide_text_continue" | "pass";
  shouldRecover: boolean;
  exhausted: boolean;
  hideTextForToolCall: boolean;
  mismatch: boolean;
  detectedLanguage: "zh" | "en" | null;
  hanCount: number;
  latinLetters: number;
  latinWords: number;
} {
  const mismatch = detectResponseLanguageMismatch({
    text: input.text,
    targetLanguage: input.targetLanguage,
  });
  const hasActionableMismatch =
    !input.suppressedByPlanGuard &&
    input.text.trim().length > 0 &&
    mismatch.mismatch;
  const hideTextForToolCall =
    hasActionableMismatch &&
    input.toolCallCount > 0;
  const shouldRecover =
    hasActionableMismatch &&
    input.toolCallCount === 0 &&
    !input.alreadyRetried;
  const exhausted =
    hasActionableMismatch &&
    input.alreadyRetried &&
    input.toolCallCount === 0;
  return {
    action: shouldRecover ? "recover_once" : hideTextForToolCall ? "hide_text_continue" : "pass",
    shouldRecover,
    exhausted,
    hideTextForToolCall,
    mismatch: mismatch.mismatch,
    detectedLanguage: mismatch.detectedLanguage,
    hanCount: mismatch.hanCount,
    latinLetters: mismatch.latinLetters,
    latinWords: mismatch.latinWords,
  };
}

const PSEUDO_TOOL_CALL_RE = /(?:^|\n)\s*(?:\[(?:Tool call|tool_call|工具调用)\s*:\s*([a-z_][a-z0-9_]*)\s*\]|(?:Tool call|tool_call|工具调用)\s*:\s*([a-z_][a-z0-9_]*))\s*$/im;
const NON_STANDARD_TOOL_WRAPPER_RE = /<tool_code(?:\s[^>]*)?>[\s\S]*?<\/tool_code>/i;
const TABULAR_FILE_RE = /\.(?:csv|tsv|xlsx|xls|xlsm)$/i;
const UNITY_FALLBACK_RECOVERY_READ_ONLY_TOOL_NAMES = new Set([
  "list_directory",
  "get_project_skeleton",
  "glob_search",
  "grep_search",
  "read_file",
  "get_file_outline",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "unity_docs",
  "unity_reflect",
  "find_gameobjects",
  "find_in_file",
  "read_console",
]);

export function extractPseudoToolCallName(text: string): string | null {
  const content = String(text || "");
  if (!content.trim()) return null;
  if (/<tool_use>|<tool_call|<function_call/i.test(content)) return null;
  const match = content.match(PSEUDO_TOOL_CALL_RE);
  const name = String(match?.[1] || match?.[2] || "").trim();
  return name || null;
}

export function looksLikePseudoToolCallPlaceholder(text: string): boolean {
  return extractPseudoToolCallName(text) != null;
}

export function looksLikeNonStandardToolCallFormat(text: string): boolean {
  const content = String(text || "");
  if (!content.trim()) return false;
  if (/<tool_use>|<tool_call|<function_call/i.test(content)) return false;
  return NON_STANDARD_TOOL_WRAPPER_RE.test(content);
}

export function buildPseudoToolCallRecoveryPrompt(language: "zh" | "en", workflowMode: "chat" | "edit" | "plan"): string {
  const modeText = workflowMode === "chat" ? "read-only/discussion" : workflowMode === "plan" ? "plan" : "execute";
  return language === "zh"
    ? [
        "你刚才输出了非标准工具格式（如 `[Tool call: ...]` 或 `<tool_code>...</tool_code>`），它不是可执行工具调用，MAIN 不能据此执行工具。",
        "如果你需要工具，必须立即用正式 XML 工具协议重发，并补齐所有必填参数：",
        "<tool_use>",
        "<tool>read_file</tool>",
        "<parameter name=\"path\">相对 workspace 的文件路径</parameter>",
        "</tool_use>",
        `当前运行阶段：${modeText}。不要再输出 \`[Tool call: ...]\`、\`<tool_code>...</tool_code>\`，也不要只描述“我要调用工具”。如果缺少路径或参数，请先用可用的只读工具获取上下文，或直接用可见正文说明缺口。`,
      ].join("\n")
    : [
        "You just emitted a non-standard tool format (for example `[Tool call: ...]` or `<tool_code>...</tool_code>`). That is not an executable tool call, so MAIN cannot run a tool from it.",
        "If you need a tool, immediately resend it using the formal XML tool protocol with all required parameters:",
        "<tool_use>",
        "<tool>read_file</tool>",
        "<parameter name=\"path\">workspace-relative file path</parameter>",
        "</tool_use>",
        `Current workflow mode: ${modeText}. Do not output \`[Tool call: ...]\`, \`<tool_code>...</tool_code>\`, or merely describe that you will call a tool. If a path or argument is missing, use an available read-only tool to gather context or explain the gap in visible text.`,
      ].join("\n");
}

function buildToolProtocolDoomLoopStopMessage(language: "zh" | "en", toolName?: string | null): string {
  const tool = toolName ? ` ${toolName}` : "";
  return language === "zh"
    ? `模型连续输出不可执行的伪工具调用${tool}，没有补齐正式 XML 参数。MAIN 已停止本轮以避免继续堆叠恢复提示。你可以继续当前任务，MAIN 会保留已读取的上下文；建议下一条明确指定文件路径或让 MAIN 先读取 @ 文件。`
    : `The model repeatedly emitted a non-executable pseudo tool call${tool} without valid XML parameters. MAIN stopped this turn to avoid piling on more recovery prompts. You can continue the task; MAIN kept the context already read. For the next message, specify the file path or ask MAIN to read the @ file first.`;
}

function containsToolUseBlock(text: string): boolean {
  return /<tool_use\b/i.test(String(text || ""));
}

function containsToolNameParameterFallback(text: string): boolean {
  return /<tool_use\b[\s\S]*?<parameter\s+name=["'](?:tool|name|function)["']/i.test(String(text || ""));
}

function summarizeProtocolFragmentForLog(text: string): string {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function extractUserMentionedFilePathsFromMessages(messages: AgentMessage[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const markerIndex = message.content.indexOf("[user_mentioned_files]");
    if (markerIndex < 0) continue;
    const section = message.content
      .slice(markerIndex)
      .split(/\n\[[a-z_]+(?:_[a-z_]+)*\]/i)[0] || "";
    const pathRe = /^path:\s*(.+?)\s*$/gmi;
    let match: RegExpExecArray | null;
    while ((match = pathRe.exec(section)) !== null) {
      const value = String(match[1] || "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      paths.push(value);
    }
  }
  return paths;
}

function choosePseudoToolRecovery(input: {
  pseudoToolName: string | null;
  availableToolNames: Set<string>;
  mentionedPaths: string[];
  workflowMode: "chat" | "edit" | "plan";
  turnIntent: ResolvedUserIntent;
}): {
  call: { id: string; name: string; arguments: string } | null;
  requestedToolName: string | null;
  recoveredToolName: string | null;
  reason: string;
  mentionedPathCount: number;
  argumentKeys: string[];
} {
  const requestedToolName = String(input.pseudoToolName || "").trim();
  if (!requestedToolName) {
    return {
      call: null,
      requestedToolName: null,
      recoveredToolName: null,
      reason: "no_pseudo_tool_name",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }
  if (!input.availableToolNames.has(requestedToolName)) {
    return {
      call: null,
      requestedToolName,
      recoveredToolName: null,
      reason: "tool_not_available",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }

  if (requestedToolName === "get_project_skeleton" || requestedToolName === "get_pty_status" || requestedToolName === "clear_pty_buffer") {
    return {
      call: {
        id: `pseudo_recovered_${generateId()}`,
        name: requestedToolName,
        arguments: JSON.stringify({}),
      },
      requestedToolName,
      recoveredToolName: requestedToolName,
      reason: "no_required_arguments",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }

  const uniqueMentionedPath = input.mentionedPaths.length === 1 ? input.mentionedPaths[0] : "";
  if (!uniqueMentionedPath) {
    return {
      call: null,
      requestedToolName,
      recoveredToolName: null,
      reason: input.mentionedPaths.length > 1 ? "ambiguous_mentioned_paths" : "missing_required_path",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }

  const isTabular = TABULAR_FILE_RE.test(uniqueMentionedPath);
  const shouldPreferTabularAnalysis =
    requestedToolName === "read_file" &&
    isTabular &&
    input.availableToolNames.has("analyze_tabular_document") &&
    (input.workflowMode === "plan" || input.turnIntent === "analyze" || input.turnIntent === "report" || input.turnIntent === "summarize");
  const recoveredToolName = shouldPreferTabularAnalysis ? "analyze_tabular_document" : requestedToolName;
  if (!input.availableToolNames.has(recoveredToolName)) {
    return {
      call: null,
      requestedToolName,
      recoveredToolName: null,
      reason: "recovered_tool_not_available",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }

  const pathOnlyTools = new Set([
    "read_file",
    "read_document",
    "analyze_tabular_document",
    "get_file_outline",
    "list_directory",
    "index_workspace_documents",
  ]);
  if (!pathOnlyTools.has(recoveredToolName)) {
    return {
      call: null,
      requestedToolName,
      recoveredToolName: null,
      reason: "tool_requires_uninferrable_arguments",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }

  const args = { path: uniqueMentionedPath };
  return {
    call: {
      id: `pseudo_recovered_${generateId()}`,
      name: recoveredToolName,
      arguments: JSON.stringify(args),
    },
    requestedToolName,
    recoveredToolName,
    reason: shouldPreferTabularAnalysis ? "unique_tabular_mention" : "unique_mentioned_path",
    mentionedPathCount: input.mentionedPaths.length,
    argumentKeys: Object.keys(args),
  };
}

export function recoverPseudoToolCallFromContext(input: {
  text: string;
  availableToolNames: Set<string> | string[];
  mentionedPaths: string[];
  workflowMode: "chat" | "edit" | "plan";
  turnIntent: ResolvedUserIntent;
}): ReturnType<typeof choosePseudoToolRecovery> {
  return choosePseudoToolRecovery({
    pseudoToolName: extractPseudoToolCallName(input.text),
    availableToolNames: input.availableToolNames instanceof Set
      ? input.availableToolNames
      : new Set(input.availableToolNames),
    mentionedPaths: input.mentionedPaths,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
  });
}

function buildMalformedToolUseRecoveryPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "Your previous reply contained a `<tool_use>` block, but MAIN could not parse it as an executable tool call.",
      "Continue with exactly one valid XML tool call now. Use this shape:",
      "<tool_use>",
      "<tool>query_tabular_document</tool>",
      "<parameter name=\"path\">path/to/file.csv</parameter>",
      "<parameter name=\"query\">SQL or natural-language query</parameter>",
      "</tool_use>",
      "Do not put the tool name inside `<parameter name=\"tool\">`, and do not output prose around the tool call.",
    ].join("\n");
  }

  return [
    "上一条回复包含 `<tool_use>`，但 MAIN 没能解析成可执行工具调用。",
    "现在请只输出一个合法 XML 工具调用，格式如下：",
    "<tool_use>",
    "<tool>query_tabular_document</tool>",
    "<parameter name=\"path\">path/to/file.csv</parameter>",
    "<parameter name=\"query\">SQL 或自然语言查询</parameter>",
    "</tool_use>",
    "不要把工具名写进 `<parameter name=\"tool\">`，也不要在工具调用前后输出说明文字。",
  ].join("\n");
}

export function shouldRepromptBeforeUnityConsoleFallback(input: {
  readConsoleCalled: boolean;
  hasSuccessfulReadOnlyActivity: boolean;
  repromptAlreadyIssued: boolean;
}): boolean {
  return !input.readConsoleCalled && input.hasSuccessfulReadOnlyActivity && !input.repromptAlreadyIssued;
}

function looksLikePlanCompletionClaim(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /(?:全部|所有|全[部都]?|已|已经).{0,24}(?:完成|满足|通过)|(?:任务|证据).{0,16}(?:全部|全都).{0,16}(?:完成|满足|通过)|\b\d+\s*\/\s*\d+\b.{0,24}(?:完成|complete|completed|done|satisfied|passed)/i.test(normalized) ||
    /(?:all|every).{0,40}(?:task|evidence|item).{0,40}(?:complete|completed|done|satisfied|passed)|(?:complete|completed|done|satisfied).{0,40}(?:all|every).{0,40}(?:task|evidence|item)/i.test(normalized)
  );
}

function formatPlanAuditRemainingTasks(
  audit: PlanTaskEvidenceAudit,
  language: "zh" | "en",
  fallback: string,
  limit = 8,
): string {
  const lines = audit.remainingTasks.slice(0, limit).map((task, index) => {
    const evidence = task.evidence?.map((item) => `${item.kind}:${item.value}`).join(", ") ||
      (language === "zh" ? "缺少证据标签" : "missing evidence label");
    const status = task.evidenceStatus || task.status || "missing";
    const reason = task.blockedReason || (language === "zh" ? "证据未满足" : "evidence is not satisfied");
    return `- ${index + 1}. ${task.text} [${status}; ${evidence}] - ${reason}`;
  });
  return lines.length > 0 ? lines.join("\n") : fallback;
}

function buildApprovedPlanNoToolPauseMessage(
  language: "zh" | "en",
  remainingText: string,
  consecutiveNoToolCount: number,
  audit?: PlanTaskEvidenceAudit,
  completionClaimRejected = false,
): string {
  const auditLine = audit && audit.totalCount > 0
    ? language === "zh"
      ? `可信审计进度：${audit.completedCount}/${audit.totalCount}`
      : `Trusted audit progress: ${audit.completedCount}/${audit.totalCount}`
    : "";

  return language === "zh"
    ? [
        completionClaimRejected ? "完成声明未验证" : "计划执行已暂停",
        "",
        completionClaimRejected
          ? `原因：模型声称计划已完成，但可信任务审计没有通过；模型正文不会被当作完成证据。`
          : `原因：模型连续 ${consecutiveNoToolCount} 次提前停止，返回了正文但没有继续调用工具；当前任务清单仍有证据未满足的任务。`,
        "已保留当前 workspace、工具结果和任务证据，不会把这次正文当作完成证据。",
        ...(auditLine ? [auditLine] : []),
        "",
        "未完成任务：",
        remainingText,
        "",
        "下一步：点击 Resume Execution 后，MAIN 应先重新读取当前 workspace 状态，再继续第一个证据未满足的任务。",
        "",
        "RecoveryDetails:",
        "- type: remaining_plan_tasks_limit",
        `- noToolStops: ${consecutiveNoToolCount}`,
        `- completionClaimRejected: ${completionClaimRejected ? "true" : "false"}`,
        "- action: Resume Execution",
      ].join("\n")
    : [
        completionClaimRejected ? "Completion claim not accepted" : "Plan execution paused",
        "",
        completionClaimRejected
          ? "Reason: the model claimed the plan was complete, but the trusted task audit did not pass. Assistant prose is not completion evidence."
          : `Reason: the model stopped early ${consecutiveNoToolCount} time(s), returned prose, and did not continue with tool calls while the current task list still has unsatisfied evidence.`,
        "MAIN preserved the current workspace, tool results, and evidence ledger. This prose is not treated as completion evidence.",
        ...(auditLine ? [auditLine] : []),
        "",
        "Remaining tasks:",
        remainingText,
        "",
        "Next: click Resume Execution so MAIN rereads current workspace state and continues from the first task whose evidence is not satisfied.",
        "",
        "RecoveryDetails:",
        "- type: remaining_plan_tasks_limit",
        `- noToolStops: ${consecutiveNoToolCount}`,
        `- completionClaimRejected: ${completionClaimRejected ? "true" : "false"}`,
        "- action: Resume Execution",
      ].join("\n");
}

function formatPendingValidationTasks(
  audit: PlanTaskEvidenceAudit,
  language: "zh" | "en",
  browserValidationAvailable: boolean,
): string {
  const tasks = audit.pendingUserValidationTasks.length > 0
    ? audit.pendingUserValidationTasks
    : audit.remainingTasks.filter((task) =>
        isPlanTaskAwaitingBrowserValidation(task) || isPlanTaskAwaitingExternalValidation(task)
      );
  const lines = tasks.slice(0, 8).map((task, index) => {
    const decision = describePlanValidationDecision({
      task,
      language,
      browserValidationAvailable,
    });
    const evidence = task.evidence?.map((item) => `${item.kind}:${item.value}`).join(", ") ||
      (language === "zh" ? "缺少证据标签" : "missing evidence label");
    return `- ${index + 1}. ${task.text} [${task.evidenceStatus || "missing"}; ${evidence}]${decision ? ` - ${decision}` : ""}`;
  });
  return lines.length > 0
    ? lines.join("\n")
    : language === "zh"
    ? "- 当前没有需要外部验证的任务。"
    : "- No external validation tasks are pending.";
}

function buildApprovedPlanValidationPendingMessage(input: {
  language: "zh" | "en";
  audit: PlanTaskEvidenceAudit;
  browserValidationAvailable: boolean;
}): string {
  const pendingText = formatPendingValidationTasks(input.audit, input.language, input.browserValidationAvailable);
  return input.language === "zh"
    ? [
        "自动执行已到验证边界",
        "",
        `可信审计进度：${input.audit.completedCount}/${input.audit.totalCount}；剩余项需要浏览器/Tauri/用户确认，不能用 curl、grep 或 cat 替代。`,
        "",
        "待验证项：",
        pendingText,
        "",
        "状态：已保留当前 workspace、端口/命令证据和任务清单；不会继续尝试 kill 端口或重复启动本地服务。",
      ].join("\n")
    : [
        "Automated execution reached a validation boundary",
        "",
        `Trusted audit progress: ${input.audit.completedCount}/${input.audit.totalCount}. The remaining item(s) require browser, Tauri, or user confirmation and cannot be replaced by curl, grep, or cat.`,
        "",
        "Pending validation:",
        pendingText,
        "",
        "State: MAIN preserved the workspace, port/command evidence, and task list; it will not keep killing ports or restarting local servers.",
      ].join("\n");
}

function buildBrowserValidationContinuationPrompt(input: {
  language: "zh" | "en";
  remainingText: string;
}): string {
  if (input.language === "zh") {
    return [
      "当前剩余任务需要浏览器级验证。下一步必须调用可用的 Browser/Playwright 工具，而不是继续用 curl、grep、cat 或重复启动 dev server。",
      "验证策略：使用当前实际 dev server URL；打开页面；执行 DOM 断言；必要时截图；如果是 Markdown Viewer/test-sample.md 场景，读取样例内容后注入编辑器 textarea，触发 input，再检查 preview 中标题、代码块、表格、脚注、Mermaid 容器和关键样式。",
      "若 Browser/Playwright 工具调用失败或不可用，暂停并说明待用户验证，不要继续兜圈。",
      "待验证任务：",
      input.remainingText,
    ].join("\n");
  }
  return [
    "The remaining task requires browser-level validation. Next, call an available Browser/Playwright tool; do not keep using curl, grep, cat, or repeated dev-server starts.",
    "Validation strategy: use the actual dev-server URL, open the page, run DOM assertions, and take a screenshot if needed. For Markdown Viewer/test-sample.md, read the sample content, inject it into the editor textarea, dispatch input, then assert the preview contains headings, code blocks, tables, footnotes, Mermaid containers, and key styles.",
    "If Browser/Playwright is unavailable or fails, pause and report pending user validation instead of looping.",
    "Pending validation:",
    input.remainingText,
  ].join("\n");
}

function resolveApprovedPlanValidationBoundary(input: {
  audit: PlanTaskEvidenceAudit | null;
  availableToolNames: Set<string>;
}): "none" | "browser_prompt" | "pause_external_validation" {
  const audit = input.audit;
  if (!audit) return "none";
  const browserAvailable = hasBrowserValidationCapability(input.availableToolNames);
  if (audit.pendingExternalValidation && audit.automationComplete) {
    return "pause_external_validation";
  }
  if (audit.allTrustedComplete) return "none";
  const remaining = audit.remainingTasks;
  if (remaining.length === 0) return "none";
  const allBrowser = remaining.every(isPlanTaskAwaitingBrowserValidation);
  const allExternal = remaining.every((task) =>
    isPlanTaskAwaitingExternalValidation(task) ||
    (isPlanTaskAwaitingBrowserValidation(task) && !browserAvailable)
  );
  if (allBrowser && browserAvailable) return "browser_prompt";
  if (allExternal) return "pause_external_validation";
  return "none";
}

function buildPlanFallbackNotice(language: "zh" | "en", sourceChars: number): string {
  const formatted = sourceChars.toLocaleString();
  return language === "zh"
    ? `模型刚才输出了约 ${formatted} 个字符的规划正文，但没有生成可审批的计划文件。MAIN 会要求模型通过工具写入真实的 \`.MAIN/plans/design.md\`，或先用可点击选项向你确认关键分叉；不会把工具日志或截断内容强行写成计划。`
    : `The model produced about ${formatted} characters of planning text but did not create reviewable plan files. MAIN will ask it to write a real \`.MAIN/plans/design.md\` artifact through tools, or ask you for the key decision first; tool logs and truncated text will not be forced into plan files.`;
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

function collectContextMemoryTexts(
  entries: Array<{ text?: string } | null | undefined> | undefined,
  maxItems: number,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries || []) {
    const text = stripControlPromptForPlanFallback(entry?.text || "");
    if (!text) continue;
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function collectPlanClosureMaterializationInput(
  callbacks: OrchestratorCallbacks,
  recentActivity: PlanToolActivitySummary[] = [],
  attemptedTargets: string[] = [],
): {
  userGoal: string;
  evidence: string[];
  files: string[];
  constraints: string[];
} {
  const memory = callbacks.getContextMemoryState?.() || null;
  const userGoal =
    getOriginalUserPromptForPlanFallback(callbacks) ||
    stripControlPromptForPlanFallback(memory?.latestUserRequest?.text || "");
  const constraints = collectContextMemoryTexts(memory?.constraints, 5);
  const files = [
    ...collectContextMemoryTexts(
      (memory?.files || []).map((entry) => ({ text: entry.path || entry.text })),
      8,
    ),
    ...recentActivity
      .filter((item) => item.status === "succeeded" && item.target)
      .map((item) => item.target),
  ];

  const evidenceFromMemory = collectContextMemoryTexts(memory?.evidence, 8);
  const evidenceFromActivity = recentActivity
    .filter((item) => item.status === "succeeded")
    .map((item) => [item.name, item.target, item.detail].filter(Boolean).join("; "));
  const fallbackHighlights = evidenceFromMemory.length > 0 || evidenceFromActivity.length > 0
    ? []
    : collectFallbackToolHighlights(callbacks, attemptedTargets)
      .filter((item) => !/Repeated read-only tool call skipped|Duplicate skip count|already called with identical arguments/i.test(item));

  return {
    userGoal,
    evidence: [...evidenceFromMemory, ...evidenceFromActivity, ...fallbackHighlights],
    files,
    constraints,
  };
}

function hasSuccessfulTabularActivity(recentActivity: PlanToolActivitySummary[]): boolean {
  return recentActivity.some((item) =>
    item.status === "succeeded" &&
    (item.name === "analyze_tabular_document" || item.name === "query_tabular_document")
  );
}

function countSuccessfulPlanReadEvidence(recentActivity: PlanToolActivitySummary[]): number {
  const evidenceTools = new Set([
    "get_project_skeleton",
    "list_directory",
    "read_file",
    "get_file_outline",
    "read_document",
    "analyze_tabular_document",
    "query_tabular_document",
    "glob_search",
    "grep_search",
  ]);
  const signatures = new Set<string>();
  for (const item of recentActivity) {
    if (item.status !== "succeeded" || !evidenceTools.has(item.name)) continue;
    signatures.add([item.name, item.target || "", item.detail || ""].join("|"));
  }
  return signatures.size;
}

function buildPlanDesignClosurePromptFromEvidence(
  callbacks: OrchestratorCallbacks,
  recentActivity: PlanToolActivitySummary[] = [],
  attemptedTargets: string[] = [],
): string {
  const closureInput = collectPlanClosureMaterializationInput(callbacks, recentActivity, attemptedTargets);
  return composeReviewableDesignFromEvidence({
    ...closureInput,
    language: callbacks.getPreferredLanguage(),
  });
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
      "- `design.md` is the default required approval artifact. It must include the user goal/constraints, current findings, proposed approach, affected files/interfaces, ordered implementation strategy, data/control flow, risks/tradeoffs, validation, and default assumptions/follow-up enhancements. For complex implementations, include one concise Mermaid diagram by default; skip diagrams for simple structures unless the user explicitly asks for one.",
      "- Non-blocking MVP tradeoffs must be written with explicit defaults as assumptions or follow-up enhancements. If a choice blocks execution, ask with `<user_options>` before approval and stop.",
      "- `requirements.md` is optional. Only create it when the user explicitly asks for a requirement ledger or when large/compliance-heavy scope needs traceability; it is never a prerequisite for approval.",
      "- If a design direction is unclear, ask the user with `<user_options>` and stop. Do not invent a final design.",
      "- If the direction is clear, call `write_file` or `replace_in_file` to create/update concise `.MAIN/plans/design.md`, then submit the normal Proposal for approval. Do not generate `tasks.md` before approval.",
    ].filter(Boolean).join("\n");
  }

  return [
    "上一轮规划没有产出有效的可审批计划文件。现在请重新生成真正的计划。",
    "",
    contextSummary,
    "",
    "规则：",
    "- 不要把工具日志、重复调用提示、后台思考、原始源码或截断提示写进计划文件。",
    "- `design.md` 是默认必需的审批方案：必须包含用户目标/约束、当前发现、拟定方案、影响文件/接口、执行顺序、数据流/控制流、风险取舍、验证方式和默认假设/后续增强。复杂实现默认包含 1 个简短 Mermaid 图；简单结构不需要，除非用户明确要求生成图。",
    "- 非阻塞 MVP 取舍必须写成带默认值的默认假设或后续增强；真正阻塞执行的选择必须在批准前用 `<user_options>` 提问并停止。",
    "- `requirements.md` 是可选需求台账；只有用户明确要求、范围很大或需要合规/验收追踪时才生成，绝不是审批前置条件。",
    "- 如果设计方向不明确，使用 `<user_options>` 让用户选择并立刻停止；不要编造最终方案。",
    "- 如果方向已经明确，必须调用 `write_file` 或 `replace_in_file` 创建/更新精简的 `.MAIN/plans/design.md`，然后提交正常 Proposal 等待审批。批准前不要生成 `tasks.md`。",
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
  const diagnosticHint = language === "zh"
    ? "诊断步骤优先使用内联 `run_command`，避免在项目根目录创建临时诊断脚本；确需脚本文件时，请先把它列入当前任务清单或持久化的 tasks.md，并使用明确临时路径或清理策略。"
    : "For diagnostics, prefer inline `run_command` and avoid creating temporary diagnostic scripts in the project root; if a script file is truly needed, list it in the current task list or persisted tasks.md first and use an explicit temporary path or cleanup strategy.";
  if (focus.length === 0) {
    return language === "zh"
      ? "如果某个任务需要运行 shell 命令，请先把精确命令写在当前任务清单里并用反引号包裹；如果本轮持久化 tasks.md，也同步写入对应 checkbox。进入执行后，一次性命令优先调用 run_command 并检查 exitCode/stdout/stderr，长驻或交互式命令调用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查输出，不能只用文字复述。" + diagnosticHint
      : "If a task requires shell commands, write the exact commands in the current task list using backticks; if this run persists tasks.md, mirror them in the matching checkbox. During execution, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status. Do not merely describe commands in prose. " + diagnosticHint;
  }

  const detail = focus
    .map(({ task, commands }) =>
      language === "zh"
        ? `任务：${task.text}\n命令：${commands.map((command) => `\`${command}\``).join("、")}`
        : `Task: ${task.text}\nCommands: ${commands.map((command) => `\`${command}\``).join(", ")}`,
    )
    .join("\n\n");

  return language === "zh"
    ? "在当前未完成任务里检测到了必须实际运行的 shell 命令。一次性命令请优先调用 run_command；长驻或交互式命令调用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查结果；不要只在正文里重复这些命令：\n\n" + detail + "\n\n" + diagnosticHint
    : "The remaining tasks include shell commands that must be run for real. Prefer run_command for finite commands; for long-running or interactive commands call execute_command and verify with read_pty_since/read_pty_tail/get_pty_status. Do not just repeat them in prose:\n\n" + detail + "\n\n" + diagnosticHint;
}

function formatPlanTasksForContinuationPrompt(
  tasks: PlanTask[],
  language: "zh" | "en",
  limit = 12,
): string {
  const visibleTasks = tasks.slice(0, limit);
  if (visibleTasks.length === 0) return "";
  const lines = visibleTasks.map((task, index) => {
    const evidence = task.evidence?.map((item) => `${item.kind}:${item.value}`).join(", ") ||
      (language === "zh" ? "无证据标签" : "no evidence label");
    return `${index + 1}. ${task.text} [${evidence}]`;
  }).join("\n");
  return language === "zh"
    ? "当前 runtime 任务清单：\n" + lines
    : "Current runtime task list:\n" + lines;
}

function buildApprovedPlanContinuationPrompt(callbacks: OrchestratorCallbacks): string {
  const language = callbacks.getPreferredLanguage();
  const approvalChoiceHint = buildPlanApprovalChoiceHint(callbacks.getPlanApprovalChoice(), language);
  const requestedDocs = detectRequestedRootMarkdownDeliverables(getOriginalUserPromptForPlanFallback(callbacks));
  const runtimeTaskList = formatPlanTasksForContinuationPrompt(callbacks.getPlanTasks(), language);
  const deliverableHint = requestedDocs.length > 0
    ? language === "zh"
      ? `6. 用户明确要求最终文档：${requestedDocs.map((name) => `项目根目录 \`${name}\``).join("、")}。必须把它写进当前任务清单；如果持久化 tasks.md，也作为最后交付步骤，并在计划完成前真实写入。\n`
      : `6. The user explicitly requested final document(s): ${requestedDocs.map((name) => `project-root \`${name}\``).join(", ")}. Add them to the current task list; if tasks.md is persisted, include them as final deliverables and write them before marking the plan complete.\n`
    : "";

  return (
    approvalChoiceHint +
    (callbacks.getPlanTasks().length > 0
      ? language === "zh"
        ? "计划已批准，现在进入执行阶段（EXECUTION MODE）。MAIN 已有 runtime 任务清单，TopIsland 会直接显示任务进度；不需要为了第一次源码写入强制创建 `.MAIN/plans/tasks.md`。请按当前任务清单逐项执行，使用 <tool_use> 格式调用工具；只有任务较长、需要跨会话审计或用户明确要求留档时，才先把清单持久化到 tasks.md。任何需要 shell 的任务都必须在当前任务清单中保留精确命令并用反引号包裹。页面渲染验证必须使用 Browser/Playwright DOM 或截图证据，不能用 curl/grep/cat 代替；Tauri/人工验证不可自动完成时要暂停说明待用户验证。你可以正常修改项目源码文件，写入路径必须是项目中的正确位置，绝对不要将源码写入 `.MAIN/plans/` 或任何隐藏目录。只有全部任务都有真实文件/命令/交付物/浏览器证据满足，或剩余项明确待用户验证后，才能结束执行；如果 tasks.md 已存在，完成任务后再同步更新对应 checkbox。\n"
        : "The plan is approved. You are now in EXECUTION MODE. MAIN already has a runtime task list, so TopIsland can show task progress without forcing `.MAIN/plans/tasks.md` before the first source write. Execute the current task list with tool calls; persist the list to tasks.md only when the work is long, cross-session, or explicitly needs an audit file. Any task that needs shell work must keep the exact command in the current task list using backticks. Rendered-page validation requires Browser/Playwright DOM or screenshot evidence; do not substitute curl/grep/cat. If Tauri or manual validation cannot be automated, pause and report pending user validation. You may now edit project source files, but write them to the proper project paths and never into `.MAIN/plans/` or hidden folders. Only stop when every task has satisfied real file/command/deliverable/browser evidence, or remaining items are explicitly pending user validation; if tasks.md exists, update the matching checkbox after evidence exists.\n"
      : language === "zh"
      ? "计划已批准，现在进入执行阶段（EXECUTION MODE）。请先基于已批准的 design.md 派生精简 runtime 任务清单；只有任务较长、需要跨会话审计或用户明确要求留档时，才生成 `.MAIN/plans/tasks.md`。随后按任务逐项执行，使用 <tool_use> 格式调用工具。页面渲染验证必须使用 Browser/Playwright DOM 或截图证据；Tauri/人工验证不可自动完成时要暂停说明待用户验证。你可以正常修改项目源码文件，写入路径必须是项目中的正确位置，绝对不要将源码写入 `.MAIN/plans/` 或任何隐藏目录。只有全部任务都有真实文件/命令/交付物/浏览器证据满足，或剩余项明确待用户验证后，才能结束执行。\n"
      : "The plan is approved. You are now in EXECUTION MODE. First derive a concise runtime task list from the approved design.md; generate `.MAIN/plans/tasks.md` only when the work is long, cross-session, or explicitly needs an audit file. Then execute the tasks one by one using tool calls. Rendered-page validation requires Browser/Playwright DOM or screenshot evidence; if Tauri or manual validation cannot be automated, pause and report pending user validation. You may now edit project source files, but write them to the proper project paths and never into `.MAIN/plans/` or hidden folders. Only stop when every task has satisfied real file/command/deliverable/browser evidence, or remaining items are explicitly pending user validation.\n") +
    deliverableHint +
    (runtimeTaskList ? "\n" + runtimeTaskList + "\n" : "") +
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

const PLAN_NO_VISIBLE_TOKEN_TIMEOUT_MS = 125_000;

interface FetchLLMStreamOptions {
  noVisibleTokenTimeoutMs?: number;
  noVisibleTokenTimeoutLabel?: string;
}

export function isStreamWatchdogTimeoutMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("stream_first_chunk_timeout") ||
    normalized.includes("stream_no_visible_token_timeout") ||
    normalized.includes("first chunk timeout") ||
    normalized.includes("first response timeout") ||
    normalized.includes("没有返回首个流式 chunk") ||
    normalized.includes("长时间没有返回可见流式内容") ||
    normalized.includes("没有返回响应头")
  );
}

export function createStreamNoVisibleTokenTimeoutError(timeoutMs: number, label?: string): Error {
  const suffix = label ? ` (${label})` : "";
  const error = new Error(`STREAM_NO_VISIBLE_TOKEN_TIMEOUT: no visible model output after ${timeoutMs}ms${suffix}`);
  (error as Error & { code?: string }).code = "STREAM_NO_VISIBLE_TOKEN_TIMEOUT";
  return error;
}

export function shouldUsePlanNoVisibleTokenWatchdog(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  nativeToolCount: number;
  activeProfile?: "local" | "cloud";
  provider?: string | null;
  toolProtocol?: string | null;
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved || input.nativeToolCount > 0) return false;
  const toolProtocol = String(input.toolProtocol || "auto").toLowerCase();
  const localTextToolProtocol =
    input.activeProfile === "local" &&
    (toolProtocol === "xml" || toolProtocol === "auto" || toolProtocol === "");
  if (localTextToolProtocol) return false;
  return true;
}

export function shouldAttemptPlanClosureGuard(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  hasReviewablePlanArtifacts: boolean;
  evidenceCount: number;
  consecutiveEmptyResponseCount?: number;
  usedPlanRecoveryPrompt?: boolean;
  rejectedVisibleChars?: number;
  toolCallCount?: number;
  replyOptionCount?: number;
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved || input.hasReviewablePlanArtifacts) return false;
  if (input.evidenceCount <= 0) return false;
  if ((input.toolCallCount ?? 0) > 0 || (input.replyOptionCount ?? 0) > 0) return false;
  if ((input.consecutiveEmptyResponseCount ?? 0) >= 2) return true;
  if (input.usedPlanRecoveryPrompt) return true;
  return typeof input.rejectedVisibleChars === "number" && input.rejectedVisibleChars > 0 && input.rejectedVisibleChars < 280;
}

export function buildPlanExplorationBudget(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  toolName: string;
  target?: string;
  duplicateCount?: number;
  hasTabularEvidence?: boolean;
  successfulReadEvidenceCount?: number;
}): {
  shouldRedirectToDesignClosure: boolean;
  reason: string | null;
} {
  if (input.workflowMode !== "plan" || input.isPlanApproved) {
    return { shouldRedirectToDesignClosure: false, reason: null };
  }
  const duplicateCount = input.duplicateCount ?? 0;
  const isBroadStructureTool =
    input.toolName === "get_project_skeleton" ||
    (input.toolName === "list_directory" && (!input.target || input.target === "." || input.target === "./"));
  if (isBroadStructureTool && duplicateCount >= PLAN_EXPLORATION_REPEAT_READ_LIMIT) {
    return {
      shouldRedirectToDesignClosure: true,
      reason: "repeated_broad_structure_read",
    };
  }
  if (input.hasTabularEvidence && isBroadStructureTool) {
    return {
      shouldRedirectToDesignClosure: true,
      reason: "tabular_context_already_available",
    };
  }
  if ((input.successfulReadEvidenceCount ?? 0) >= 2 && isBroadStructureTool) {
    return {
      shouldRedirectToDesignClosure: true,
      reason: "sufficient_read_context_already_available",
    };
  }
  return { shouldRedirectToDesignClosure: false, reason: null };
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
  options: FetchLLMStreamOptions = {},
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
        const requestAbortController = new AbortController();
        const timeoutMs = options.noVisibleTokenTimeoutMs ?? 0;
        let noVisibleTokenTimer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (noVisibleTokenTimer !== null) {
            clearTimeout(noVisibleTokenTimer);
            noVisibleTokenTimer = null;
          }
          signal.removeEventListener("abort", onExternalAbort);
        };
        const safeResolve = (r: StreamResult) => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(r);
          }
        };
        const safeReject = (err: Error) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        };
        const createAbortError = () => {
          const abortErr = new Error("Aborted");
          abortErr.name = "AbortError";
          return abortErr;
        };
        function onExternalAbort() {
          requestAbortController.abort();
          safeReject(createAbortError());
        }

        if (signal.aborted) {
          safeReject(createAbortError());
          return;
        }

        signal.addEventListener("abort", onExternalAbort, { once: true });
        if (timeoutMs > 0) {
          noVisibleTokenTimer = setTimeout(() => {
            const timeoutError = createStreamNoVisibleTokenTimeoutError(
              timeoutMs,
              options.noVisibleTokenTimeoutLabel,
            );
            safeReject(timeoutError);
            requestAbortController.abort();
          }, timeoutMs);
        }

        void streamChatCompletion(
          messages,
          settings,
          {
            onToken: (token) => {
              if (noVisibleTokenTimer !== null && token.length > 0) {
                clearTimeout(noVisibleTokenTimer);
                noVisibleTokenTimer = null;
              }
              fullText += token;
              callbacks.onStreamToken(token, messageId);
            },
            onDone: (result) => {
              if (signal.aborted || requestAbortController.signal.aborted) {
                safeReject(createAbortError());
                return;
              }
              safeResolve(result);
            },
            onError: (err) => {
              safeReject(err);
            },
            onLifecycle: (event) => {
              callbacks.onHarnessRunUpdate?.({
                activeStreamId: event.streamId || null,
                streamStatus: event.phase,
                streamChunkCount: event.chunkCount ?? 0,
                streamByteCount: event.byteCount ?? 0,
                lastStreamError: event.error || null,
                streamElapsedMs: event.elapsedMs ?? 0,
                streamLifecycleStatus: event.status || null,
              });
            },
          },
          requestAbortController.signal,
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
        logAgentEvent("transient_cloud_retry", {
          attempt: transientRetryCount,
          maxRetries: MAX_TRANSIENT_RETRIES,
          message: retryMessage.slice(0, 240),
        });
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
        logAgentEvent("max_output_escalated", {
          currentMaxTokens,
          attempt: escalationCount,
        });

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
  lifecycleState?: ToolLifecycleState;
  additionalContexts?: string[];
}

interface PlanMaterializationResultForLoop {
  ok: boolean;
  path?: string;
  kind?: "design";
  content?: string;
  reason?: string;
  toolResult?: ToolExecutionResult;
}

async function writeMaterializedPlanArtifact(input: {
  materialized: {
    ok: boolean;
    path?: string;
    kind?: "design";
    content?: string;
    reason?: string;
  };
  workspace: string;
  callbacks: OrchestratorCallbacks;
  toolCallPrefix: string;
}): Promise<PlanMaterializationResultForLoop> {
  const materialized = input.materialized;
  if (!materialized.ok || !materialized.path || !materialized.content || !materialized.kind) {
    return {
      ok: false,
      reason: materialized.reason || "quality_gate",
    };
  }

  const toolCallId = `${input.toolCallPrefix}_${generateId()}`;
  const args = { path: materialized.path, content: materialized.content };
  input.callbacks.onToolExecuting("write_file", materialized.path, undefined, { toolCallId });

  try {
    const rawResult = await executeTool("write_file", args, input.workspace, input.callbacks.getSessionKey());
    const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
    await syncPlanArtifactAfterToolSuccess(
      "write_file",
      args,
      {
        onPlanArtifactUpdated: input.callbacks.onPlanArtifactUpdated,
        onPlanTasksUpdated: input.callbacks.onPlanTasksUpdated,
      },
      {
        readFile: async (path) => {
          const content = await executeTool("read_file", { path, __raw: true }, input.workspace, input.callbacks.getSessionKey());
          return String(content ?? "");
        },
        warn: (message, error) => logAgentEvent("plan_artifact_sync_warn", {
          message,
          error: error instanceof Error ? error.message : String(error || ""),
        }),
      },
    );
    input.callbacks.onToolDone("write_file", materialized.path, resultStr, { toolCallId });
    return {
      ok: true,
      path: materialized.path,
      kind: materialized.kind,
      content: materialized.content,
      toolResult: {
        toolCallId,
        name: "write_file",
        target: materialized.path,
        content: resultStr,
        displayContent: resultStr,
        isError: false,
        lifecycleState: "completed",
      },
    };
  } catch (error) {
    const message = getErrorMessage(error, "Failed to write materialized plan artifact");
    input.callbacks.onToolError("write_file", materialized.path, message, { toolCallId });
    return {
      ok: false,
      path: materialized.path,
      kind: materialized.kind,
      content: materialized.content,
      reason: message,
      toolResult: {
        toolCallId,
        name: "write_file",
        target: materialized.path,
        content: `Error: ${message}`,
        displayContent: `Error: ${message}`,
        isError: true,
        lifecycleState: "failed",
      },
    };
  }
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

function parseToolCallArguments(tc: ToolCallToExecute, workspace?: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return normalizeToolCallForExecution(tc.name, parsed as Record<string, unknown>, workspace);
  } catch {
    return {};
  }
}

function buildToolActionNarration(input: {
  calls: ToolCallToExecute[];
  workspace: string;
  language: "zh" | "en";
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
}): string {
  const calls = input.calls.slice(0, 3);
  if (calls.length === 0) return "";

  const presentations = calls.map((call) => {
    const args = parseToolCallArguments(call, input.workspace);
    const target = getToolTarget(call.name, args);
    return {
      name: call.name,
      target,
      presentation: formatToolPresentation({
        toolName: call.name,
        target,
        language: input.language,
      }),
    };
  });

  const hasDesignWrite = presentations.some((item) =>
    PLAN_ARTIFACT_MUTATION_TOOLS.has(item.name) &&
    item.target.replace(/\\/g, "/").toLowerCase().endsWith(".main/plans/design.md")
  );
  const hasReadOrAnalysis = presentations.some((item) =>
    [
      "read_file",
      "read_document",
      "analyze_tabular_document",
      "query_tabular_document",
      "get_project_skeleton",
      "list_directory",
      "glob_search",
      "grep_search",
    ].includes(item.name)
  );
  const summaries = presentations.map((item) => item.presentation.summary).join(input.language === "zh" ? "；" : "; ");
  const extraCount = Math.max(0, input.calls.length - presentations.length);
  const suffix = extraCount > 0
    ? input.language === "zh" ? ` 等 ${input.calls.length} 个动作` : ` and ${extraCount} more action${extraCount === 1 ? "" : "s"}`
    : "";

  if (input.workflowMode === "plan" && !input.isPlanApproved && hasDesignWrite) {
    return input.language === "zh"
      ? "我会把当前上下文整理成可审批的 `design.md` 草案，然后停下来等你审阅；如果技术栈、输出形式或范围需要调整，审批前仍可改。"
      : "I will turn the current context into a reviewable `design.md` draft, then pause for your review; stack, output format, and scope can still be adjusted before approval.";
  }

  if (input.workflowMode === "plan" && !input.isPlanApproved && hasReadOrAnalysis) {
    return input.language === "zh"
      ? `我会先做只读探索：${summaries}${suffix}。拿到证据后再决定是提问确认分叉，还是生成可审批设计草案。`
      : `I will first gather read-only context: ${summaries}${suffix}. After that I will either ask for a decision or draft a reviewable design.`;
  }

  return input.language === "zh"
    ? `我会执行下一步工具动作：${summaries}${suffix}。`
    : `I will run the next tool action: ${summaries}${suffix}.`;
}

function normalizeToolCallToExecute(
  tc: ToolCallToExecute,
  workspace?: string | null,
): ToolCallToExecute {
  const toolArgs = parseToolCallArguments(tc, workspace);
  return {
    ...tc,
    arguments: JSON.stringify(toolArgs),
  };
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
  const readFileWindowGuidance = name === "read_file" && cached?.content
    ? buildReadFileWindowContinuationGuidance(cached.content)
    : null;
  const preview = cached?.content
    ? `\n\nEarlier result preview:\n${cached.content.slice(0, 1600)}${cached.content.length > 1600 ? "\n...[preview truncated]" : ""}`
    : "";

  return [
    `Repeated read-only tool call skipped: "${name}" was already called with identical arguments${suffix}.`,
    `Duplicate skip count in this run: ${duplicateCount}.`,
    readFileWindowGuidance || "Reuse the earlier tool result already in context. Do not call the same tool with the same arguments again; continue with a different file, a more specific outline/search tool, or produce the next visible answer.",
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
  const readFileWindow = extractReadFileWindowMetadata(state.modelContent);
  if (readFileWindow?.truncated) {
    return [
      `${FILE_UNCHANGED_STUB}: "${state.path}" has already been read with the same range/options, and the file is unchanged.`,
      `Previous read window: lines ${readFileWindow.returnedStartLine}-${readFileWindow.returnedEndLine} of ${readFileWindow.totalLines}, ${state.contentLength.toLocaleString()} result chars, file size ${state.sizeBytes.toLocaleString()} bytes, modified ${state.modifiedMs}, hash ${state.contentHash}.`,
      readFileWindow.nextStartLine
        ? `This was not the whole file. Next: call read_file with start_line=${readFileWindow.nextStartLine} and max_lines to continue, or use start_line/end_line around the exact error line.`
        : "This was not the whole file. Next: call read_file with a different start_line/end_line/max_lines range around the exact line you need.",
      "Do not use run_command merely to page file contents; run_command is for tests, builds, diagnostics, and other shell work.",
    ].join("\n");
  }

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

function normalizePathLike(value: string): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}

function resolveUnityScriptPathFromArgs(args: Record<string, unknown>): string | null {
  const folder = typeof args.path === "string" ? normalizePathLike(args.path) : "";
  const name = typeof args.name === "string" ? String(args.name).trim() : "";
  if (!folder || !name) return null;
  const fileName = name.endsWith(".cs") ? name : `${name}.cs`;
  return normalizePathLike(`${folder.replace(/\/+$/, "")}/${fileName}`);
}

function resolveMutationVerificationPath(name: string, args: Record<string, unknown>): string | null {
  const pathArg = typeof args.path === "string" ? normalizePathLike(args.path) : "";

  switch (name) {
    case "write_file":
    case "replace_in_file":
    case "create_script":
    case "delete_script":
      return pathArg || null;
    case "script_apply_edits":
      return resolveUnityScriptPathFromArgs(args);
    case "manage_script": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      if (action !== "create" && action !== "delete") return null;
      return resolveUnityScriptPathFromArgs(args);
    }
    case "apply_text_edits": {
      const uri = typeof args.uri === "string" ? String(args.uri).trim() : "";
      if (!uri) return null;
      if (uri.startsWith("Assets/")) return normalizePathLike(uri);
      if (uri.startsWith("file://")) {
        try {
          return normalizePathLike(decodeURIComponent(uri.replace(/^file:\/\//, "")));
        } catch {
          return normalizePathLike(uri.replace(/^file:\/\//, ""));
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function isSameFileMetadata(
  left: { path: string; sizeBytes: number; modifiedMs: number } | null,
  right: { path: string; sizeBytes: number; modifiedMs: number } | null,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    normalizePathLike(left.path) === normalizePathLike(right.path) &&
    left.sizeBytes === right.sizeBytes &&
    left.modifiedMs === right.modifiedMs
  );
}

function isNoEffectMutationResult(input: {
  result: string;
  before: { path: string; sizeBytes: number; modifiedMs: number } | null;
  after: { path: string; sizeBytes: number; modifiedMs: number } | null;
}): boolean {
  const normalized = input.result.trim();
  const emptyPayload = normalized === "" || normalized === "{}" || normalized === "null";
  const unchanged = isSameFileMetadata(input.before, input.after);
  return emptyPayload && unchanged;
}

function buildNoEffectMutationMessage(input: {
  language: "zh" | "en";
  toolName: string;
  target: string;
  verificationPath: string;
  result: string;
}): string {
  const toolLabel = input.target
    ? `${input.toolName} (${input.target})`
    : input.toolName;
  const resultPreview = input.result.trim().slice(0, 120) || "{}";
  if (input.language === "zh") {
    return [
      `NO_EFFECT_MUTATION: ${toolLabel} 返回了成功结果，但未观察到实际文件变化。`,
      `校验路径: ${input.verificationPath}`,
      `返回摘要: ${resultPreview}`,
      "请先读取目标文件并精确定位修改点，再重试一次带明确 patch 的工具调用；不要重复同一参数。",
    ].join("\n");
  }
  return [
    `NO_EFFECT_MUTATION: ${toolLabel} reported success, but no observable file change was detected.`,
    `Verification path: ${input.verificationPath}`,
    `Result summary: ${resultPreview}`,
    "Read the target file, identify the exact edit location, and retry with a precise patch instead of repeating identical arguments.",
  ].join("\n");
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

function inferLifecycleStateFromToolResult(result: ToolExecutionResult): ToolLifecycleState {
  if (result.lifecycleState) return result.lifecycleState;
  if (!result.isError) {
    if (/"noOp"\s*:\s*true/.test(result.content || "")) return "completed";
    if (result.content.includes(FILE_UNCHANGED_STUB) || /Repeated read-only tool call skipped:/i.test(result.content)) {
      return "completed";
    }
    return "completed";
  }

  if (
    /PLAN_STAGE_BLOCKED|PLAN_TASK_HISTORY_BLOCKED|PLAN_TASK_EVIDENCE_BLOCKED|PLAN_QUALITY_GATE|REPEATED_FAILURE_BLOCKED/i.test(result.content)
  ) {
    return "blocked";
  }
  if (/rejected by user|User rejected the tool call|declined/i.test(result.content)) {
    return "declined";
  }
  return "failed";
}

function buildToolResultHistoryContent(result: ToolExecutionResult): string {
  const lifecycleState = inferLifecycleStateFromToolResult(result);
  const isNoOp = /"noOp"\s*:\s*true/.test(result.content || "");
  const isNoEffectMutation = /NO_EFFECT_MUTATION/i.test(result.content || "");
  const isCachedReuse =
    result.content.includes(FILE_UNCHANGED_STUB) ||
    /Repeated read-only tool call skipped:/i.test(result.content);
  const status: ToolFeedbackStatus =
    lifecycleState === "declined"
      ? "declined"
    : lifecycleState === "blocked"
      ? "blocked"
    : isNoEffectMutation
      ? "no_effect_mutation"
    : lifecycleState === "failed"
      ? "failed"
    : isNoOp
      ? "no_op"
      : isCachedReuse
      ? "cached"
      : "completed";
  const noOpSummary = isNoOp
    ? "No-op update; target already matched requested content."
    : undefined;
  return formatToolFeedbackEnvelope({
    status,
    toolCallId: result.toolCallId,
    tool: result.name,
    target: result.target,
    content: result.content,
    summary: noOpSummary || result.displayContent || result.content,
    truncated:
      typeof result.displayContent === "string" &&
      result.displayContent.length > 0 &&
      result.displayContent.length < result.content.length,
  });
}

function buildToolResultHistoryContentByFormat(
  result: ToolExecutionResult,
  format: AppConfig["toolFeedbackFormat"],
): string {
  if (format !== "envelope_v1") return result.content;
  return buildToolResultHistoryContent(result);
}

async function executeToolCallWithLifecycle(
  tc: ToolCallToExecute,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
  options: { allowExternalLocalRead?: boolean; shellPermissionApproval?: ShellPermissionApproval } = {},
): Promise<ToolExecutionResult> {
  const sessionKey = callbacks.getSessionKey();
  let toolArgs: Record<string, unknown>;
  try {
    const parsed = JSON.parse(tc.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool call arguments must be a JSON object.");
    }
    toolArgs = normalizeToolCallForExecution(tc.name, parsed as Record<string, unknown>, workspace);
  } catch {
    return {
      toolCallId: tc.id,
      name: tc.name,
      target: "",
      content: `Error: Invalid JSON in tool call arguments: ${tc.arguments}`,
      isError: true,
      lifecycleState: "failed",
    };
  }

  // Validate required parameters before execution
  const validationError = validateToolExecutionContract(tc.name, toolArgs, allTools);
  if (validationError) {
    callbacks.onToolError(tc.name, "", validationError, { toolCallId: tc.id });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target: "",
      content: `Error: ${validationError}`,
      isError: true,
      lifecycleState: "blocked",
    };
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
  const compatResolved = resolveStudioCompatToolArgs(tc.name, effectiveArgs);
  const compatArgs = compatResolved.args;
  if (compatResolved.hits.length > 0) {
    const threadId = callbacks.getSessionKey() || "default";
    const turnId = callbacks.getCurrentTurnId?.() || generateId();
    for (const hit of compatResolved.hits) {
      callbacks.onTurnEvent?.(withEventSchema({
        type: "path_alias_hit",
        threadId,
        turnId,
        timestampMs: Date.now(),
        tool: hit.tool,
        field: hit.field,
        from: hit.from,
        to: hit.to,
        rule: hit.rule,
      }));
    }
  }
  const resolvedArgs =
    tc.name === "read_file" && typeof compatArgs.path === "string"
      ? {
          ...compatArgs,
          path: resolveProtocolPackageReadPath(compatArgs.path, callbacks.getSkills(), workspace),
        }
      : compatArgs;
  const target = getToolTarget(tc.name, resolvedArgs);

  if (preHookResult.blocked) {
    const reason = preHookResult.blockedReason ?? `${tc.name} was blocked by a PreToolUse hook.`;
    callbacks.onToolError(tc.name, target, reason, { toolCallId: tc.id });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: `Error: ${reason}`,
      isError: true,
      lifecycleState: "blocked",
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

  const readBeforeModifyValidationError = await buildReadBeforeModifyValidationError(
    tc,
    resolvedArgs,
    workspace,
    callbacks,
  );
  if (readBeforeModifyValidationError) {
    return readBeforeModifyValidationError;
  }

  const unityExecutionContext = isUnityExecutionContext(callbacks);
  if (
    unityExecutionContext &&
    tc.name === "apply_text_edits" &&
    !isUnityApplyTextPrecisePatchArgs(resolvedArgs)
  ) {
    const message = buildUnityApplyTextPolicyBlockedMessage(callbacks.getPreferredLanguage());
    callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: `Error: ${message}`,
      isError: true,
      lifecycleState: "blocked",
      additionalContexts: [...preHookResult.additionalContexts],
    };
  }

  const diffPreview = isEphemeralPlanArtifactMutation(tc.name, resolvedArgs)
    ? undefined
    : await buildToolDiffPreview(tc.name, resolvedArgs, { workspace, sessionKey });
  callbacks.onToolExecuting(tc.name, target, diffPreview, { toolCallId: tc.id });
  const mutationVerificationPath = resolveMutationVerificationPath(tc.name, resolvedArgs);
  const mutationBeforeMeta = mutationVerificationPath
    ? await readFileMetadataIfAvailable(mutationVerificationPath, workspace)
    : null;

  try {
    const rawResult = await executeTool(tc.name, resolvedArgs, workspace, sessionKey, {
      allowExternalLocalRead: options.allowExternalLocalRead === true,
      shellPermissionApproval: options.shellPermissionApproval,
    });
    const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
    const mutationAfterMeta = mutationVerificationPath
      ? await readFileMetadataIfAvailable(mutationVerificationPath, workspace)
      : null;
    if (
      mutationVerificationPath &&
      isNoEffectMutationResult({
        result: resultStr,
        before: mutationBeforeMeta,
        after: mutationAfterMeta,
      })
    ) {
      const noEffectMessage = buildNoEffectMutationMessage({
        language: callbacks.getPreferredLanguage(),
        toolName: tc.name,
        target,
        verificationPath: mutationVerificationPath,
        result: resultStr,
      });
      callbacks.onToolError(tc.name, target, noEffectMessage, { toolCallId: tc.id });
      const postHookResult = await runLifecycleHooks(callbacks, hooksConfig, "PostToolUse", {
        toolName: tc.name,
        toolArgs: resolvedArgs,
        toolResult: noEffectMessage,
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
        content: `Error: ${noEffectMessage}`,
        isError: true,
        lifecycleState: "failed",
        additionalContexts: [
          ...preHookResult.additionalContexts,
          ...postHookResult.additionalContexts,
        ],
      };
    }
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
          const content = await executeTool("read_file", { path, __raw: true }, workspace, sessionKey, {
            allowExternalLocalRead: options.allowExternalLocalRead === true,
          });
          return String(content ?? "");
        },
        warn: (message, error) => logAgentEvent("plan_artifact_sync_warn", {
          message,
          error: error instanceof Error ? error.message : String(error || ""),
        }),
      },
    );
    rememberReadBeforeModifyEvidence(sessionKey, tc.name, resolvedArgs, {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: modelContent,
      displayContent,
      isError: false,
    });

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

    callbacks.onToolDone(tc.name, target, displayContent, { toolCallId: tc.id });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: modelContent,
      displayContent,
      isError: false,
      lifecycleState: "completed",
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
    callbacks.onToolError(tc.name, target, errorMsg, { toolCallId: tc.id });
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
      lifecycleState: "failed",
      additionalContexts: [
        ...preHookResult.additionalContexts,
        ...postHookResult.additionalContexts,
      ],
    };
  }
}

async function autoMaterializePlanArtifactFromVisibleText(input: {
  visibleText: string;
  workspace: string;
  callbacks: OrchestratorCallbacks;
}): Promise<PlanMaterializationResultForLoop> {
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: input.visibleText,
    planStage: input.callbacks.getPlanStage(),
  });

  if (!materialized.ok || !materialized.path || !materialized.content || !materialized.kind) {
    return {
      ok: false,
      reason: materialized.reason || "quality_gate",
    };
  }

  return writeMaterializedPlanArtifact({
    materialized,
    workspace: input.workspace,
    callbacks: input.callbacks,
    toolCallPrefix: "plan_materialize",
  });
}

/**
 * Execute read-only tools concurrently.
 * From claude-code-haha's toolOrchestration.ts: safe tools can run in parallel.
 */
async function executeReadOnlyToolsConcurrently(
  toolCalls: Array<ToolCallToExecute & { allowExternalLocalRead?: boolean }>,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
): Promise<ToolExecutionResult[]> {
  const promises = toolCalls.map(tc =>
    executeToolCallWithLifecycle(tc, workspace, callbacks, allTools, hooksConfig, {
      allowExternalLocalRead: tc.allowExternalLocalRead === true,
    }),
  );
  return Promise.all(promises);
}

async function executeLocalFileReadToolWithReview(
  tc: ToolCallToExecute,
  toolArgs: Record<string, unknown>,
  localFileReadPath: string,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
): Promise<ToolExecutionResult> {
  const target = getToolTarget(tc.name, toolArgs);
  callbacks.onStatusChange("pending_review");

  let decision: ReviewDecision;
  try {
    decision = await callbacks.requestReview({
      name: tc.name,
      arguments: toolArgs,
      risk: "local_file_read",
      localFileReadPath,
    });
  } catch {
    callbacks.onStatusChange("idle");
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: "User cancelled the local file read approval.",
      isError: true,
      lifecycleState: "declined",
    };
  }

  callbacks.onStatusChange("running");

  if (decision.action === "accept") {
    const allowExternalLocalRead =
      isLocalFileReadApproved(decision.grantLocalFileReadPath || "", [localFileReadPath]) ||
      isLocalFileReadApproved(localFileReadPath, callbacks.getApprovedLocalFileReadPaths());
    return await executeToolCallWithLifecycle(
      tc,
      workspace,
      callbacks,
      allTools,
      hooksConfig,
      { allowExternalLocalRead },
    );
  }

  if (decision.action === "reject") {
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: "User rejected reading this local file outside the workspace. Ask for a different file, use an attached file, or continue without it.",
      isError: true,
      lifecycleState: "declined",
    };
  }

  return {
    toolCallId: tc.id,
    name: tc.name,
    target,
    content: `Tool execution failed: ${decision.error}`,
    isError: true,
    lifecycleState: "failed",
  };
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
      ? "PLAN 阶段尚未批准，不能提前生成 `.MAIN/plans/tasks.md`。请先完成 design.md 草稿并等待用户批准。"
      : reason === "missing_tasks_before_source"
      ? "计划已批准，但还没有可执行的任务清单。请先从 design.md 派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再按任务修改源码或交付文档。"
      : "PLAN 阶段尚未批准，不能修改源码或项目交付文件。请先生成 `.MAIN/plans/design.md` 供用户审批；requirements.md 仅在确有需求台账时可选生成。"
    : reason === "pre_approval_tasks"
    ? "PLAN mode is not approved yet, so `.MAIN/plans/tasks.md` must not be generated. Create a design.md draft and wait for approval first."
    : reason === "missing_tasks_before_source"
    ? "The plan is approved, but there is no executable task list yet. First derive a runtime task list from design.md; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs before editing source or final deliverables."
    : "PLAN mode is not approved yet, so source or deliverable files cannot be modified. Create `.MAIN/plans/design.md` for review first; requirements.md is optional for requirement-ledger cases.";

  callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
  callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
  return {
    toolCallId: tc.id,
    name: tc.name,
    target,
    content: `Error: PLAN_STAGE_BLOCKED: ${message}`,
    isError: true,
    lifecycleState: "blocked",
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
        const currentContent = String(await executeTool("read_file", { path, __raw: true }, workspace, callbacks.getSessionKey()) ?? "");
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
        ? `PLAN_QUALITY_GATE: ${path} 被拦截，内容不像可审批的正式计划（${validation.reason || "质量不足"}）。请基于用户目标和已读源码重新生成 design.md，或用 <user_options> 询问关键分叉；不要写入工具日志、后台思考、截断提示或原始代码片段。`
        : `PLAN_QUALITY_GATE: ${path} was rejected because it does not look like a reviewable plan artifact (${validation.reason || "quality gate"}). Regenerate design.md from the user goal and inspected source, or ask the user with <user_options>; do not write tool logs, hidden thinking, truncation notices, or raw source snippets.`;
      callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
      callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
      return {
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: `Error: ${message}`,
        isError: true,
        lifecycleState: "blocked",
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
      callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
      callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
      return {
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: `Error: ${message}`,
        isError: true,
        lifecycleState: "blocked",
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
        callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
        callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
        return {
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: `Error: ${message}`,
          isError: true,
          lifecycleState: "blocked",
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
    const parsed = JSON.parse(tc.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool call arguments must be a JSON object.");
    }
    toolArgs = normalizeToolCallForExecution(tc.name, parsed as Record<string, unknown>, workspace);
  } catch {
    return {
      toolCallId: tc.id,
      name: tc.name,
      target: "",
      content: `Error: Invalid JSON in tool call arguments: ${tc.arguments}`,
      isError: true,
      lifecycleState: "failed",
    };
  }

  // Validate required parameters before presenting to user
  const validationError = validateToolExecutionContract(tc.name, toolArgs, allTools);
  if (validationError) {
    return {
      toolCallId: tc.id,
      name: tc.name,
      target: "",
      content: `Error: ${validationError}`,
      isError: true,
      lifecycleState: "blocked",
    };
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
      lifecycleState: "declined",
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
      { shellPermissionApproval: decision.shellPermissionApproval },
    );
    return execution;
  } else if (decision.action === "reject") {
    content = "User rejected the tool call. Try a different approach.";
    isError = false; // Not an error per se — the AI should try a different approach
  } else {
    content = `Tool execution failed: ${decision.error}`;
    isError = true;
  }

  return {
    toolCallId: tc.id,
    name: tc.name,
    target,
    content,
    isError,
    lifecycleState: decision.action === "reject" ? "declined" : isError ? "failed" : "declined",
  };
}

// ── The Loop ──────────────────────────────────────────────────────

const MAX_ITERATIONS = 25;
const MAX_ITERATIONS_PLAN_EXECUTION = 50;
const MAX_RECENT_PLAN_TOOL_ACTIVITY = 12;
const CONCISE_PLAN_ARTIFACT_HINT_ZH =
  "计划文档必须精简：design.md 60-120 行；可选 requirements.md 40-80 行；如确需持久化 tasks.md，保持 8-20 个 checkbox。不要写教程式长文、完整代码清单或重复背景。Proposal 只做一页审阅摘要。";
const CONCISE_PLAN_ARTIFACT_HINT_EN =
  "Keep plan artifacts concise: design.md 60-120 lines; optional requirements.md 40-80 lines; if tasks.md must be persisted, keep it to 8-20 checkboxes. Do not write tutorial-style prose, full code listings, or repeated background. The Proposal should be a one-page review summary.";

function logAgentEvent(event: string, data: Record<string, unknown> = {}) {
  try {
    console.info(`[agent.${event}]`, data);
  } catch {
    // Logging must never affect the agent loop.
  }
}

function summarizeMessageContentForDiagnostics(content: AgentMessage["content"]): {
  chars: number;
  images: number;
} {
  if (typeof content === "string") {
    return { chars: content.length, images: 0 };
  }
  if (!Array.isArray(content)) {
    return { chars: 0, images: 0 };
  }
  return content.reduce(
    (summary, part) => {
      if (part.type === "text") {
        summary.chars += String(part.text || "").length;
      } else if (part.type === "image_url") {
        summary.images += 1;
      }
      return summary;
    },
    { chars: 0, images: 0 },
  );
}

function summarizeMessagesForDiagnostics(messages: AgentMessage[]): Record<string, unknown> {
  const byRole: Record<string, number> = {};
  const charsByRole: Record<string, number> = {};
  let textChars = 0;
  let imageParts = 0;
  let toolCallMessages = 0;
  let toolResultMessages = 0;
  let maxMessageChars = 0;
  let maxMessageRole = "";

  for (const message of messages) {
    byRole[message.role] = (byRole[message.role] ?? 0) + 1;
    const contentSummary = summarizeMessageContentForDiagnostics(message.content);
    textChars += contentSummary.chars;
    imageParts += contentSummary.images;
    charsByRole[message.role] = (charsByRole[message.role] ?? 0) + contentSummary.chars;
    if (contentSummary.chars > maxMessageChars) {
      maxMessageChars = contentSummary.chars;
      maxMessageRole = message.role;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      toolCallMessages += 1;
    }
    if (message.role === "tool") {
      toolResultMessages += 1;
    }
  }

  return {
    count: messages.length,
    byRole,
    charsByRole,
    textChars,
    estimatedTokens: Math.ceil(textChars / 4),
    imageParts,
    toolCallMessages,
    toolResultMessages,
    maxMessageChars,
    maxMessageRole: maxMessageRole || null,
  };
}

function summarizeToolsForDiagnostics(tools: ToolDefinition[]): Record<string, unknown> {
  let schemaChars = 0;
  try {
    schemaChars = JSON.stringify(tools).length;
  } catch {
    schemaChars = 0;
  }
  return {
    count: tools.length,
    names: tools.map((tool) => tool.function.name).slice(0, 20),
    schemaChars,
    estimatedSchemaTokens: Math.ceil(schemaChars / 4),
  };
}

function isUnityCommandDirective(commandDirective?: CommandDirective | null): boolean {
  return commandDirective?.kind === "unity";
}

function isUnityConsoleDiagnosticsDirective(commandDirective?: CommandDirective | null): boolean {
  return commandDirective?.kind === "unity" && commandDirective?.action === "console_diagnostics";
}

export function shouldTriggerUnityMcpFirstIterationFallback(input: {
  toolCallCount: number;
  replyOptionCount: number;
  unityMcpFirstPhaseActive: boolean;
  unityMcpFirstIterationPending: boolean;
}): boolean {
  return (
    input.toolCallCount === 0 &&
    input.replyOptionCount === 0 &&
    input.unityMcpFirstPhaseActive &&
    input.unityMcpFirstIterationPending
  );
}

function isUnityLikelyServer(server: MCPServer): boolean {
  return /unity/i.test(`${server.name} ${server.url}`);
}

function extractMcpCallFailureCategory(content: string): string | null {
  const match = content.match(/MCP_CALL_FAILURE\[([^[\]]+)\]/i);
  return match ? match[1].toLowerCase() : null;
}

function isUnityExecutionContext(callbacks: OrchestratorCallbacks): boolean {
  const commandDirective = callbacks.getCommandDirective?.() ?? null;
  const gameStudioUnityContext =
    callbacks.getMainModeKey() === "game_studio" &&
    callbacks.getGameStudioConfig?.()?.engine === "unity";
  return isUnityCommandDirective(commandDirective) || gameStudioUnityContext;
}

function isUnityScriptEditToolName(name: string): boolean {
  return name === "script_apply_edits" || name === "apply_text_edits";
}

function isUnityScriptWriteToolCall(name: string, args: Record<string, unknown>): boolean {
  if (isUnityScriptEditToolName(name)) return true;
  if (name === "create_script" || name === "delete_script") return true;
  if (name !== "manage_script") return false;
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  return action === "create" || action === "delete";
}

function buildUnityApplyTextPolicyBlockedMessage(language: "zh" | "en"): string {
  return language === "zh"
    ? "UNITY_EDIT_POLICY_BLOCKED: apply_text_edits 仅允许用于“精确补丁”（必须提供 uri、完整坐标 edits，以及 precondition_sha/ precondition_sha256）。当前参数不满足约束。请改用 script_apply_edits，或先读取文件并补全精确坐标与 precondition 后重试。"
    : "UNITY_EDIT_POLICY_BLOCKED: apply_text_edits is allowed only for precise patches (uri + full coordinate edits + precondition_sha/precondition_sha256). The current arguments are non-compliant. Use script_apply_edits instead, or read the file and retry with exact coordinates and precondition.";
}

function annotateUnityEditToolDescriptions(tools: MCPTool[], enabled: boolean): MCPTool[] {
  if (!enabled) return tools;
  return tools.map((tool) => {
    if (tool.name === "script_apply_edits") {
      const guidance = "Unity policy: preferred tool for C# method/class edits.";
      if ((tool.description || "").includes(guidance)) return tool;
      return {
        ...tool,
        description: `${tool.description || ""}${tool.description ? " " : ""}${guidance}`.trim(),
      };
    }
    if (tool.name === "apply_text_edits") {
      const guidance = "Unity policy: only for precise coordinate patches with precondition SHA.";
      if ((tool.description || "").includes(guidance)) return tool;
      return {
        ...tool,
        description: `${tool.description || ""}${tool.description ? " " : ""}${guidance}`.trim(),
      };
    }
    return tool;
  });
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
  const settings = deriveStreamSettings(config);
  const effectiveToolProtocol = resolveEffectiveToolProtocol(config, settings);
  const compatibilityForcedAtStart = callbacks.shouldForceXmlForProviderCompatibility?.();
  const nativeToolsEnabled = !shouldUseXmlToolProtocol(
    config,
    settings,
    initialMessages,
    compatibilityForcedAtStart,
  );
  const modelProtocolProfile = resolveModelProtocolProfile({
    activeProfile: config.activeProfile,
    provider: settings.provider,
    model: settings.model,
    protocol: settings.apiProtocol,
    configuredToolProtocol: effectiveToolProtocol,
    compatibilityOverride: compatibilityForcedAtStart,
  });
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
  const eventThreadId = callbacks.getSessionKey() || "default";
  const eventTurnId = callbacks.getCurrentTurnId?.() || generateId();
  let turnEventTerminalEmitted = false;
  const emitTurnEvent = (event: MainThreadEventInput): void => {
    callbacks.onTurnEvent?.(withEventSchema(event));
  };
  const emitTurnCompletedEvent = () => {
    if (turnEventTerminalEmitted) return;
    turnEventTerminalEmitted = true;
    emitTurnEvent({
      type: "turn.completed",
      threadId: eventThreadId,
      turnId: eventTurnId,
      timestampMs: Date.now(),
    });
  };
  const emitTurnFailedEvent = (message: string) => {
    if (turnEventTerminalEmitted) return;
    turnEventTerminalEmitted = true;
    emitTurnEvent({
      type: "turn.failed",
      threadId: eventThreadId,
      turnId: eventTurnId,
      timestampMs: Date.now(),
      error: { message },
    });
  };
  emitTurnEvent({
    type: "thread.started",
    threadId: eventThreadId,
    timestampMs: Date.now(),
  });
  emitTurnEvent({
    type: "turn.started",
    threadId: eventThreadId,
    turnId: eventTurnId,
    timestampMs: Date.now(),
  });

  logAgentEvent("runtime_settings", {
    baseUrl: settings.baseUrl,
    model: settings.model,
    useRustProxy: settings.useRustProxy,
    hasApiKey: !!settings.apiKey,
    provider: settings.provider,
    nativeToolsEnabled,
    toolProtocol: effectiveToolProtocol,
    modelProtocolToolProtocol: modelProtocolProfile.toolProtocol,
    modelProtocolReasoning: modelProtocolProfile.reasoning,
    providerFamily: modelProtocolProfile.providerFamily,
    xmlToolsEnabled: true,
  });

  // ── Config Snapshot ──────────────────────────────────────────────
  // Local profile uses the slider-driven context limit. Cloud profile
  // bypasses local KV-cache/context compression entirely.
  const snapshotContextLimit = isCloudProfile ? undefined : config.local.contextLimit;

  // Discover MCP tools from configured servers
  const mcpServers = callbacks.getMcpServers();
  const latestUserPrompt = [...initialMessages]
    .reverse()
    .find((message) => message.role === "user");
  const latestUserPromptText = latestUserPrompt ? extractCompatibilityTextContent(latestUserPrompt.content) : "";
  const commandDirective = callbacks.getCommandDirective?.() ?? null;
  const gameStudioUnityContext =
    callbacks.getMainModeKey() === "game_studio" &&
    callbacks.getGameStudioConfig?.()?.engine === "unity";
  const unityCommandRequested = isUnityCommandDirective(commandDirective) || gameStudioUnityContext;
  const unityConsoleDiagnosticsRequested =
    isUnityConsoleDiagnosticsDirective(commandDirective) ||
    (unityCommandRequested && hasExplicitUnityConsoleDiagnosticCue(latestUserPromptText));
  const unityScriptEditRequested =
    unityCommandRequested &&
    /fix|repair|patch|edit|modify|refactor|script|code|c#|cs|修复|补丁|修改|脚本|代码|编译|报错|错误/i.test(
      latestUserPromptText,
    );

  const enabledMcpServers = mcpServers.filter((server) => server.enabled !== false);
  let mcpTools = callbacks.getMcpDiscoveredTools();
  let mcpToolServerMap = getMcpToolServerMap();
  let mcpServerStatuses: MCPServerStatusSnapshot[] = mcpServers.map((server) => ({
    serverName: server.name,
    url: server.url,
    enabled: server.enabled !== false,
    status: server.enabled === false ? "disabled" : "failed",
    toolCount: 0,
    category: server.enabled === false ? "ok" : "invalid_response",
    message: server.enabled === false
      ? "Server is disabled in settings."
      : "Server status is unknown until discovery runs.",
  }));

  if (mcpServers.length > 0) {
    logAgentEvent("mcp_discovery_start", {
      enabledServers: enabledMcpServers.length,
      totalServers: mcpServers.length,
    });
    const { tools: discovered, toolServerMap, serverStatuses } = await discoverAllMcpTools(mcpServers);
    mcpServerStatuses = serverStatuses;
    mcpToolServerMap = toolServerMap;
    setMcpToolServerMap(toolServerMap);
    if (discovered.length > 0) {
      logAgentEvent("mcp_discovery_done", {
        discoveredTools: discovered.length,
        toolNames: discovered.map(t => t.name).slice(0, 24),
      });
      mcpTools = discovered;
    } else {
      logAgentEvent("mcp_discovery_done", {
        discoveredTools: 0,
      });
      mcpTools = [];
    }
  }

  const connectedMcpServerUrls = new Set(
    mcpServerStatuses
      .filter((status) => status.status === "connected" && status.enabled)
      .map((status) => status.url),
  );
  const connectedMcpServers = enabledMcpServers.filter((server) => connectedMcpServerUrls.has(server.url));
  const preferredUnityMcpServerUrls = connectedMcpServers
    .filter((server) => isUnityLikelyServer(server))
    .map((server) => server.url);
  const effectivePreferredUnityUrls = preferredUnityMcpServerUrls.length > 0
    ? preferredUnityMcpServerUrls
    : connectedMcpServers.map((server) => server.url);
  const unityMcpFirstEligible = unityCommandRequested && effectivePreferredUnityUrls.length > 0;
  const mcpPriorityMode: McpRoutingPriorityMode = unityMcpFirstEligible ? "unity_mcp_first" : "none";
  const forceFirstMcpTools = unityMcpFirstEligible && unityConsoleDiagnosticsRequested
    ? ["read_console", "set_active_instance"]
    : [];

  logAgentEvent("mcp_server_status", {
    requestedUnityRouting: unityCommandRequested,
    gameStudioUnityContext,
    unityConsoleDiagnosticsRequested,
    statuses: mcpServerStatuses.map((status) => ({
      server: status.serverName,
      url: status.url,
      enabled: status.enabled,
      state: status.status,
      toolCount: status.toolCount,
      category: status.category,
      httpStatus: status.httpStatus,
    })),
  });

  const mcpRoutingResult = routeMcpToolsForPrompt({
    tools: mcpTools,
    servers: connectedMcpServers,
    toolServerMap: mcpToolServerMap,
    userPrompt: latestUserPromptText,
    config: config.mcpRouting,
    priorityMode: mcpPriorityMode,
    preferredServerUrls: effectivePreferredUnityUrls,
    forceFirstTools: forceFirstMcpTools,
    unityRoutingContext: {
      preferStructuredScriptEdits: unityScriptEditRequested,
    },
  });
  mcpTools = mcpRoutingResult.tools;
  mcpTools = annotateUnityEditToolDescriptions(mcpTools, unityCommandRequested);
  logAgentEvent("mcp_routing", { ...mcpRoutingResult.telemetry });

  // Build intent-scoped tool definitions: built-ins + active skills + routed MCP tools.
  const routedToolDefinitions = buildToolDefinitions(skills, mcpTools);
  const toolCapabilityRegistry = buildToolCapabilityRegistry({
    toolDefinitions: routedToolDefinitions,
    skills,
    mcpTools,
    mcpServers: connectedMcpServers,
    mcpToolServerMap,
    policy: config.toolPermissionPolicy,
  });
  const preferredUnityServerUrlSet = new Set(effectivePreferredUnityUrls);
  const preferredUnityMcpToolNameSet = new Set(
    mcpTools
      .filter((tool) => preferredUnityServerUrlSet.has(mcpToolServerMap[tool.name] || ""))
      .map((tool) => tool.name),
  );
  const fallbackUnityMcpToolNameSet = new Set(mcpTools.map((tool) => tool.name));
  const effectiveUnityMcpToolNameSet = preferredUnityMcpToolNameSet.size > 0
    ? preferredUnityMcpToolNameSet
    : fallbackUnityMcpToolNameSet;
  let unityMcpFirstPhaseActive = unityMcpFirstEligible && effectiveUnityMcpToolNameSet.size > 0;
  let unityMcpFallbackReason: string | null = null;
  let unityMcpFirstIterationPending = unityMcpFirstPhaseActive;
  let unityMcpForceConsoleFirstPending = unityMcpFirstPhaseActive && unityConsoleDiagnosticsRequested;
  let unityConsoleMissingFirstToolRepromptIssued = false;
  let unityConsoleFinalVerificationRequired = false;
  let unityConsoleRefreshObservedAfterWrite = false;

  const activateUnityMcpFallback = (reason: string) => {
    if (!unityMcpFirstPhaseActive) return;
    unityMcpFirstPhaseActive = false;
    unityMcpForceConsoleFirstPending = false;
    unityMcpFallbackReason = reason;
    logAgentEvent("unity_mcp_fallback", {
      reason,
      unityCommandRequested,
      unityConsoleDiagnosticsRequested,
      preferredServers: effectivePreferredUnityUrls,
    });
  };

  const resolveAllToolsForRuntime = (runtimeIntent: ResolvedUserIntent): ToolDefinition[] => {
    const filtered = filterToolDefinitionsForIntent(
      routedToolDefinitions,
      callbacks.getCurrentRunIntent(),
      toolCapabilityRegistry,
      {
        runtimeIntent,
        planApproved: callbacks.getIsPlanApproved(),
      },
    );

    if (!unityMcpFirstPhaseActive) {
      return filtered;
    }

    const forcedOrder = unityMcpForceConsoleFirstPending
      ? ["read_console", "set_active_instance"]
      : [];
    const forcedTools = forcedOrder
      .map((name) => filtered.find((tool) => tool.function.name === name))
      .filter((tool): tool is ToolDefinition => !!tool);

    if (unityMcpForceConsoleFirstPending && forcedTools.length === 0) {
      activateUnityMcpFallback("missing_required_console_tool");
      return filtered;
    }

    const forcedSet = new Set(forcedTools.map((tool) => tool.function.name));
    const prioritizedUnityMcpTools = filtered.filter(
      (tool) => effectiveUnityMcpToolNameSet.has(tool.function.name) && !forcedSet.has(tool.function.name),
    );

    if (forcedTools.length === 0 && prioritizedUnityMcpTools.length === 0) {
      activateUnityMcpFallback("mcp_tools_not_exposed_for_runtime");
      return filtered;
    }

    return [
      ...forcedTools,
      ...prioritizedUnityMcpTools,
      ...filtered.filter(
        (tool) =>
          !forcedSet.has(tool.function.name) &&
          !effectiveUnityMcpToolNameSet.has(tool.function.name),
      ),
    ];
  };
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
  const taskTargetingEvidence = getSessionTaskTargetingEvidence(callbacks.getSessionKey());
  const emitTaskOrchestratorPhase = (phase: TaskOrchestratorPhase, extra: Record<string, unknown> = {}) => {
    logAgentEvent("task_orchestrator_phase", {
      phase,
      workflowMode,
      turnIntent,
      planApproved: callbacks.getIsPlanApproved(),
      ...extra,
    });
  };
  const buildCurrentTaskTargetingProfile = () => buildTaskTargetingProfile({
    userPrompt: latestUserPromptText,
    planTaskTexts: callbacks.getPlanTasks().map((task) => task.text),
    associatedPaths,
    skills,
    observedEvidence: [...taskTargetingEvidence],
  });
  const initialTaskTargetingProfile = buildCurrentTaskTargetingProfile();
  emitTaskOrchestratorPhase("INTAKE_PARSE", {
    facets: initialTaskTargetingProfile.facets,
    explicitPaths: initialTaskTargetingProfile.explicitPaths.slice(0, 8),
    symbols: initialTaskTargetingProfile.symbols.slice(0, 8),
    preferredReadTools: initialTaskTargetingProfile.preferredReadTools,
    allowRootSkeleton: initialTaskTargetingProfile.allowRootSkeleton,
    requiresDesignProtocol: initialTaskTargetingProfile.requiresDesignProtocol,
    designProtocolSatisfied: initialTaskTargetingProfile.designProtocolSatisfied,
  });

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
      callbacks.getGameStudioConfig?.()?.engine ?? "",
      callbacks.getGameStudioConfig?.()?.engineVersion ?? "",
      callbacks.getCommandDirective?.()?.kind ?? "none",
      callbacks.getCommandDirective?.()?.action ?? "",
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
        studioConfig: callbacks.getGameStudioConfig?.() ?? null,
      },
      runtimeIntent,
      config.promptLanguageStrategy,
      config.thinkingPolicy ?? "normal",
      availableToolNameList,
      callbacks.getCommandDirective?.() ?? null,
      {
        unityMcpFirst: unityMcpFirstPhaseActive,
        unityConsoleFirst: unityMcpFirstPhaseActive && unityConsoleDiagnosticsRequested,
        connectedServerNames: mcpServerStatuses
          .filter((status) => status.status === "connected" && /unity/i.test(`${status.serverName} ${status.url}`))
          .map((status) => status.serverName),
      },
      {
        displayLanguage: config.language,
        resolvedResponseLanguage: callbacks.getPreferredLanguage(),
      },
      {
        activeProfile: config.activeProfile,
        provider: settings.provider,
        model: settings.model,
        toolProtocol: effectiveToolProtocol,
        nativeToolsEnabled: !shouldUseXmlToolProtocol(
          config,
          settings,
          callbacks.getMessages(),
          compatibilityForcedAtStart,
        ),
      },
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
    logAgentEvent("tool_protocol_card_applied", {
      runtimeIntent,
      workflowMode,
      activeProfile: config.activeProfile,
      provider: settings.provider || "unknown",
      toolProtocol: effectiveToolProtocol,
      nativeToolsEnabled: !shouldUseXmlToolProtocol(
        config,
        settings,
        callbacks.getMessages(),
        compatibilityForcedAtStart,
      ),
      availableTools: availableToolNameList.length,
    });
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
  let loggedLocalPlanNoVisibleTokenNoticeOnly = false;
  const getPlanStreamWatchdogOptions = (nativeToolCount: number): FetchLLMStreamOptions | undefined => {
    const watchdogEnabled = shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      nativeToolCount,
      activeProfile: config.activeProfile,
      provider: settings.provider,
      toolProtocol: effectiveToolProtocol,
    });

    if (
      !watchdogEnabled &&
      !loggedLocalPlanNoVisibleTokenNoticeOnly &&
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      nativeToolCount === 0 &&
      config.activeProfile === "local"
    ) {
      loggedLocalPlanNoVisibleTokenNoticeOnly = true;
      logAgentEvent("plan_no_visible_token_notice_only", {
        activeProfile: config.activeProfile,
        provider: settings.provider || "unknown",
        toolProtocol: effectiveToolProtocol,
        workflowMode,
        turnIntent,
      });
    }

    return watchdogEnabled
      ? {
          noVisibleTokenTimeoutMs: PLAN_NO_VISIBLE_TOKEN_TIMEOUT_MS,
          noVisibleTokenTimeoutLabel: `${workflowMode}:preapproval_xml_tools`,
        }
      : undefined;
  };
  let sawPlanModeToolActivity = false;
  let usedPlanRecoveryPrompt = false;
  let usedToolUnavailableRecoveryPrompt = false;
  let usedPseudoToolCallRecoveryPrompt = false;
  let usedMalformedToolUseRecoveryPrompt = false;
  let usedLanguageMismatchRecoveryPrompt = false;
  let usedExecuteConvergencePrompt = false;
  let usedPlanClosureGuard = false;
  let usedPlanDesignClosurePrompt = false;
  const attemptedPlanWriteTargets: string[] = [];
  let recentSuccessfulProjectWrite: { name: string; target: string } | null = null;
  let recoveringFromEmptyAssistantReplyAfterWrite = false;
  let lastAssistantTextForCheckpoint = "";
  const recentPlanToolActivity: PlanToolActivitySummary[] = [];
  const recentToolActivity: PlanToolActivitySummary[] = [];
  let lastNoProgressBatchSignature = "";
  let noProgressBatchRepeatCount = 0;
  const rememberToolActivity = (targetList: PlanToolActivitySummary[], result: ToolExecutionResult) => {
    const detail = truncateForLog(result.displayContent || result.content || "", 120);
    targetList.push({
      name: result.name,
      target: result.target,
      status: result.isError ? "failed" : "succeeded",
      ...(detail ? { detail } : {}),
    });
    if (targetList.length > MAX_RECENT_PLAN_TOOL_ACTIVITY) {
      targetList.splice(0, targetList.length - MAX_RECENT_PLAN_TOOL_ACTIVITY);
    }
  };
  const rememberPlanToolActivity = (result: ToolExecutionResult) => rememberToolActivity(recentPlanToolActivity, result);
  const rememberAnyToolActivity = (result: ToolExecutionResult) => rememberToolActivity(recentToolActivity, result);

  // ── Strict Repeat Guard ──────────────────────────────────────────
  // Track recent tool calls to detect repetition loops. For read-only
  // tools, inject one recovery hint back into the loop before treating
  // the pattern as fatal, so the model gets a chance to pivot tools.
  const recentToolCalls: Array<{ name: string; argsKey: string }> = [];
  const recentTargetToolCalls: Array<{ name: string; targetKey: string; family: "edit" | "verify" | "other" }> = [];
  const repeatGuardRecoveredSignatures = new Set<string>();
  const targetProgressGuardRecoveredSignatures = new Set<string>();
  const failedToolCallCounts = new Map<string, number>();
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

  async function pauseForReviewablePlanArtifact(trigger: string): Promise<"not_reviewable" | "stopped" | "approved_continue"> {
    if (workflowMode !== "plan" || callbacks.getIsPlanApproved()) return "not_reviewable";
    const stage = callbacks.getPlanStage();
    if (!isReviewablePlanStage(stage)) return "not_reviewable";

    const language = callbacks.getPreferredLanguage();
    logAgentEvent("plan_design_review_ready_after_tool", {
      trigger,
      iteration,
      planStage: stage,
      isPlanApproved: callbacks.getIsPlanApproved(),
      statusBeforeReview: callbacks.getStatus(),
    });
    callbacks.onAssistantFinalText(buildPlanReviewReadyMessage(language, stage));
    const approved = await waitForPlanApprovalIfNeeded();
    if (!approved) {
      if (callbacks.getStatus() !== "pending_review") {
        callbacks.onStatusChange("idle");
      }
      return "stopped";
    }

    callbacks.onPlanStageChanged("executing");
    callbacks.appendMessage({
      role: "user",
      content: buildApprovedPlanContinuationPrompt(callbacks),
    });
    return "approved_continue";
  }

  async function tryClosePlanWithEvidence(trigger: string, details: {
    consecutiveEmptyResponseCount?: number;
    rejectedVisibleChars?: number;
    toolCallCount?: number;
    replyOptionCount?: number;
  } = {}): Promise<"not_attempted" | "failed" | "stopped" | "approved_continue"> {
    const closureInput = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      attemptedPlanWriteTargets,
    );
    const evidenceCount = closureInput.evidence.length;
    const currentStage = callbacks.getPlanStage();
    const hasReviewablePlanArtifacts = isReviewablePlanStage(currentStage);
    const shouldAttempt = shouldAttemptPlanClosureGuard({
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      hasReviewablePlanArtifacts,
      evidenceCount,
      usedPlanRecoveryPrompt,
      ...details,
    });

    if (!shouldAttempt) return "not_attempted";
    if (usedPlanClosureGuard) {
      logAgentEvent("plan_closure_artifact_rejected", {
        trigger,
        iteration,
        reason: "design_closure_prompt_already_used",
        evidenceCount,
        targetPath: ".MAIN/plans/design.md",
      });
      return "failed";
    }

    logAgentEvent("plan_closure_guard_start", {
      trigger,
      iteration,
      evidenceCount,
      fileCount: closureInput.files.length,
      constraintCount: closureInput.constraints.length,
      targetPath: ".MAIN/plans/design.md",
      planStage: currentStage,
    });

    if (!usedPlanDesignClosurePrompt) {
      usedPlanClosureGuard = true;
      usedPlanDesignClosurePrompt = true;
      const prompt = composeReviewableDesignFromEvidence({
        ...closureInput,
        language: callbacks.getPreferredLanguage(),
      });
      logAgentEvent("plan_design_closure_prompt", {
        trigger,
        iteration,
        evidenceCount,
        fileCount: closureInput.files.length,
        targetPath: ".MAIN/plans/design.md",
      });
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: prompt,
      });
      return "approved_continue";
    }
    return "failed";
  }

  const effectiveMaxIterations = workflowMode === "plan"
    ? MAX_ITERATIONS_PLAN_EXECUTION
    : MAX_ITERATIONS;
  const emitPlanExecutionProgress = (
    phase: PlanExecutionProgressPhase,
    overrides: Partial<PlanExecutionProgressUpdate> = {},
  ) => {
    if (workflowMode !== "plan" || !callbacks.getIsPlanApproved() || !callbacks.onPlanExecutionProgress) return;
    callbacks.onPlanExecutionProgress({
      ...buildPlanExecutionProgressUpdate({
        language: callbacks.getPreferredLanguage(),
        phase,
        iterationCount: iteration,
        maxIterations: effectiveMaxIterations,
        autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
        tasks: callbacks.getPlanTasks(),
        evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
        recentToolActivity: recentPlanToolActivity,
      }),
      ...overrides,
    });
  };
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
    activeProfile: config.activeProfile,
    provider: settings.provider || "unknown",
    nativeToolsEnabled: !shouldUseXmlToolProtocol(
      config,
      settings,
      callbacks.getMessages(),
      callbacks.shouldForceXmlForProviderCompatibility?.(),
    ),
    toolProtocol: effectiveToolProtocol,
    xmlToolsEnabled: true,
    unityMcpFirstPhaseActive,
    unityMcpFallbackReason,
    maxOutputEscalations: getMaxOutputEscalations(),
  });
  emitPlanExecutionProgress("starting");

  while (iteration < effectiveMaxIterations) {
    iteration++;
    emitPlanExecutionProgress("running");

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
    const providerCompatibilityOverride = callbacks.shouldForceXmlForProviderCompatibility?.();
    const forceXmlTools = shouldUseXmlToolProtocol(
      config,
      settings,
      callbacks.getMessages(),
      providerCompatibilityOverride,
    );
    const llmTools = !forceXmlTools ? iterationAllTools : [];
    const cloudResponsesCompact = isCloudProfile && config.cloud.apiFormat === "responses";
    if (snapshotContextLimit != null || cloudResponsesCompact) {
      const contextLimit = snapshotContextLimit ?? 32768;
      const effectiveContextLimit = computeManagedContextLimit(contextLimit, llmTools);
      const { inputBudget, outputBudget } = computeContextBudgets(effectiveContextLimit);
      const contextForce = computeContextForceReason({
        messages: callbacks.getMessages() as AgentMessage[],
        iteration,
        workflowMode,
        isPlanApproved: callbacks.getIsPlanApproved(),
      });
      const managedResult = manageContext(
        callbacks.getMessages(),
        effectiveContextLimit,
        cloudResponsesCompact ? Math.min(outputBudget, 2048) : outputBudget,
        cloudResponsesCompact
          ? 700
          : callbacks.getIsPlanApproved()
          ? 2200
          : Math.max(4000, Math.floor(inputBudget * 0.32)),
        cloudResponsesCompact
          ? 500
          : callbacks.getIsPlanApproved()
          ? 1400
          : Math.max(2000, Math.floor(inputBudget * 0.18)),
        contextForce.shouldForce,
        {
          previousMemoryState: callbacks.getContextMemoryState?.() || null,
          turnId: callbacks.getCurrentTurnId?.() || eventTurnId,
        },
      );
      callbacks.onContextMemoryBuilt?.(managedResult.memoryState, managedResult.memoryPacket);
      logAgentEvent("context_memory_built", {
        memoryId: managedResult.memoryState.id,
        goals: managedResult.memoryState.goals.length,
        constraints: managedResult.memoryState.constraints.length,
        evidence: managedResult.memoryState.evidence.length,
        files: managedResult.memoryState.files.length,
        packetChars: managedResult.memoryPacket.length,
      });
      managedAgentMessages = managedResult.messages as AgentMessage[];
      if (managedResult.changed) {
        callbacks.replaceMessages(managedAgentMessages);
      }
      if (managedResult.changed && managedResult.tokenReduction >= 256) {
        callbacks.onContextCompress({
          droppedCount: managedResult.droppedCount,
          droppedMessageCount: managedResult.droppedMessageCount,
          tokenCountBefore: managedResult.tokenCountBefore,
          tokenCountAfter: managedResult.tokenCountAfter,
          tokenReduction: managedResult.tokenReduction,
          compressedContext: managedResult.compressedContext,
          displaySummary: managedResult.displaySummary,
          memoryPacket: managedResult.memoryPacket,
          microCompactionKind: managedResult.microCompactionKind,
          microCompactedCount: managedResult.microCompactedCount,
          tokenBreakdown: managedResult.tokenBreakdownBefore,
        }, "proactive");
        emitPlanExecutionProgress("context_compression");
      }
      logAgentEvent("context_pack_built", {
        messagesBefore: callbacks.getMessages().length,
        messagesAfter: managedAgentMessages.length,
        tokenBefore: Math.round(managedResult.tokenCountBefore),
        tokenAfter: Math.round(managedResult.tokenCountAfter),
        droppedMessageCount: managedResult.droppedMessageCount,
        microCompactionKind: managedResult.microCompactionKind,
        microCompactedCount: managedResult.microCompactedCount,
        forceManaged: contextForce.shouldForce,
        forceReason: contextForce.reason,
        textChars: contextForce.textChars,
        toolChars: contextForce.toolChars,
        toolMessages: contextForce.toolMessages,
      });
    }

    // 2. Stream LLM response
    const assistantMsgId = generateId();
    let streamResult: StreamResult;
    const maxOutputEscalations = getMaxOutputEscalations();
    const iterationRequestStartedAt = Date.now();

    logAgentEvent("iteration_start", {
      iteration,
      workflowMode,
      turnIntent,
      runtimeIntent,
      messagesLen: managedAgentMessages.length,
      allTools: iterationAllTools.length,
      llmTools: llmTools.length,
      toolProtocol: effectiveToolProtocol,
      xmlToolsEnabled: true,
      mcpTools: mcpTools.length,
      currentMaxTokens: currentMaxTokens ?? "default",
    });
    callbacks.onHarnessRunUpdate?.({
      status: "running",
      iteration,
      maxIterations: effectiveMaxIterations,
      workflowMode,
      runtimeIntent,
      planStage: callbacks.getPlanStage(),
      isPlanApproved: callbacks.getIsPlanApproved(),
      messagesLen: managedAgentMessages.length,
      toolCount: iterationAllTools.length,
      activeStreamId: null,
      streamStatus: "iteration_started",
      streamChunkCount: 0,
      streamByteCount: 0,
      lastStreamError: null,
    });

    try {
      const messagesForLLM = prepareMessagesForToolProtocol(
        managedAgentMessages,
        config,
        settings,
        providerCompatibilityOverride,
      );
      const streamWatchdogOptions = getPlanStreamWatchdogOptions(llmTools.length) ?? {};
      logAgentEvent("llm_request_shape", {
        iteration,
        workflowMode,
        turnIntent,
        runtimeIntent,
        activeProfile: config.activeProfile,
        provider: settings.provider || "unknown",
        providerFamily: modelProtocolProfile.providerFamily,
        model: settings.model,
        apiProtocol: settings.apiProtocol,
        useRustProxy: settings.useRustProxy,
        contextLimit: settings.contextLimit,
        configuredContextLimit: snapshotContextLimit ?? null,
        currentMaxTokens: currentMaxTokens ?? "default",
        maxOutputEscalations,
        forceXmlTools,
        toolProtocol: effectiveToolProtocol,
        nativeToolsEnabled: !forceXmlTools,
        compatibilityOverride: !!providerCompatibilityOverride,
        messages: summarizeMessagesForDiagnostics(messagesForLLM),
        managedMessages: summarizeMessagesForDiagnostics(managedAgentMessages),
        allTools: summarizeToolsForDiagnostics(iterationAllTools),
        llmTools: summarizeToolsForDiagnostics(llmTools),
        watchdog: {
          hardTimeoutMs: streamWatchdogOptions.noVisibleTokenTimeoutMs ?? null,
          label: streamWatchdogOptions.noVisibleTokenTimeoutLabel ?? null,
          noticeOnlyForLocalPlan:
            workflowMode === "plan" &&
            !callbacks.getIsPlanApproved() &&
            config.activeProfile === "local" &&
            forceXmlTools,
        },
      });
      streamResult = await fetchLLMStream(
        messagesForLLM,
        settings,
        assistantMsgId,
        callbacks,
        abortController.signal,
        llmTools,
        currentMaxTokens,
        maxOutputEscalations,
        streamWatchdogOptions,
      );
      if (llmTools.length > 0) {
        callbacks.onProviderNativeToolSuccess?.();
      }
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
        logAgentEvent("context_retry_start", {
          iteration,
          reason: "local_context_length_exceeded",
          snapshotContextLimit,
          error: errMsg.slice(0, 240),
        });

        const { contextLimit: reactiveContextLimit, reportedContextLimit } =
          clampContextLimitToReported(snapshotContextLimit, errMsg);
        if (reportedContextLimit != null && reportedContextLimit < snapshotContextLimit) {
          logAgentEvent("context_limit_clamped", {
            iteration,
            reportedContextLimit,
            configuredContextLimit: snapshotContextLimit,
          });
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
          {
            previousMemoryState: callbacks.getContextMemoryState?.() || null,
          },
        );
        callbacks.onContextMemoryBuilt?.(aggressivelyManagedResult.memoryState, aggressivelyManagedResult.memoryPacket);
        const aggressivelyManaged = aggressivelyManagedResult.messages as AgentMessage[];
        if (aggressivelyManagedResult.changed) {
          callbacks.replaceMessages(aggressivelyManaged);
        }
        if (aggressivelyManagedResult.changed && aggressivelyManagedResult.tokenReduction > 0) {
          callbacks.onContextCompress({
            droppedCount: aggressivelyManagedResult.droppedCount,
            droppedMessageCount: aggressivelyManagedResult.droppedMessageCount,
            tokenCountBefore: aggressivelyManagedResult.tokenCountBefore,
            tokenCountAfter: aggressivelyManagedResult.tokenCountAfter,
            tokenReduction: aggressivelyManagedResult.tokenReduction,
            compressedContext: aggressivelyManagedResult.compressedContext,
            displaySummary: aggressivelyManagedResult.displaySummary,
            memoryPacket: aggressivelyManagedResult.memoryPacket,
            microCompactionKind: aggressivelyManagedResult.microCompactionKind,
            microCompactedCount: aggressivelyManagedResult.microCompactedCount,
            tokenBreakdown: aggressivelyManagedResult.tokenBreakdownBefore,
          }, "reactive");
          emitPlanExecutionProgress("context_compression");
        }

        // Retry once with the compacted context
        try {
          const aggressivelyManagedForLLM = prepareMessagesForToolProtocol(
            aggressivelyManaged,
            config,
            settings,
            providerCompatibilityOverride,
          );
          streamResult = await fetchLLMStream(
            aggressivelyManagedForLLM,
            settings,
            assistantMsgId,
            callbacks,
            abortController.signal,
            llmTools,
            aggressiveOutputBudget,
            1,
            getPlanStreamWatchdogOptions(llmTools.length),
          );
          if (llmTools.length > 0) {
            callbacks.onProviderNativeToolSuccess?.();
          }
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
          logAgentEvent("context_retry_start", {
            iteration,
            reason: "strip_tool_calls_for_emergency_retry",
          });
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
            {
              previousMemoryState: callbacks.getContextMemoryState?.() || null,
            },
          );
          callbacks.onContextMemoryBuilt?.(emergencyManagedResult.memoryState, emergencyManagedResult.memoryPacket);
          const emergencyManaged = emergencyManagedResult.messages as AgentMessage[];

          if (emergencyManagedResult.changed && emergencyManagedResult.tokenReduction > 0) {
            callbacks.replaceMessages(emergencyManaged);
            callbacks.onContextCompress({
              droppedCount: emergencyManagedResult.droppedCount,
              droppedMessageCount: emergencyManagedResult.droppedMessageCount,
              tokenCountBefore: emergencyManagedResult.tokenCountBefore,
              tokenCountAfter: emergencyManagedResult.tokenCountAfter,
              tokenReduction: emergencyManagedResult.tokenReduction,
              compressedContext: emergencyManagedResult.compressedContext,
              displaySummary: emergencyManagedResult.displaySummary,
              memoryPacket: emergencyManagedResult.memoryPacket,
              microCompactionKind: emergencyManagedResult.microCompactionKind,
              microCompactedCount: emergencyManagedResult.microCompactedCount,
              tokenBreakdown: emergencyManagedResult.tokenBreakdownBefore,
            }, "reactive");
            emitPlanExecutionProgress("context_compression");
          }

          try {
            const emergencyManagedForLLM = prepareMessagesForToolProtocol(
              emergencyManaged,
              config,
              settings,
              providerCompatibilityOverride,
            );
            streamResult = await fetchLLMStream(
              emergencyManagedForLLM,
              settings,
              assistantMsgId,
              callbacks,
              abortController.signal,
              llmTools,
              emergencyOutputBudget,
              0,
              getPlanStreamWatchdogOptions(llmTools.length),
            );
            if (llmTools.length > 0) {
              callbacks.onProviderNativeToolSuccess?.();
            }
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
        logAgentEvent("context_retry_start", {
          iteration,
          reason: "cloud_context_length_exceeded",
          error: errMsg.slice(0, 240),
        });
        const cloudReactiveContextLimit = 32768;
        const cloudReactiveOutputBudget = Math.min(
          2048,
          Math.max(1024, Math.floor(cloudReactiveContextLimit * 0.06)),
        );
        const cloudReactiveManagedLimit = computeManagedContextLimit(
          cloudReactiveContextLimit,
          llmTools,
          cloudReactiveOutputBudget,
        );
        const cloudManagedResult = manageContext(
          callbacks.getMessages(),
          cloudReactiveManagedLimit,
          cloudReactiveOutputBudget,
          700,
          500,
          true,
          {
            previousMemoryState: callbacks.getContextMemoryState?.() || null,
          },
        );
        callbacks.onContextMemoryBuilt?.(cloudManagedResult.memoryState, cloudManagedResult.memoryPacket);
        const cloudManagedMessages = cloudManagedResult.messages as AgentMessage[];
        if (cloudManagedResult.changed) {
          callbacks.replaceMessages(cloudManagedMessages);
        }
        if (cloudManagedResult.changed && cloudManagedResult.tokenReduction > 0) {
          callbacks.onContextCompress({
            droppedCount: cloudManagedResult.droppedCount,
            droppedMessageCount: cloudManagedResult.droppedMessageCount,
            tokenCountBefore: cloudManagedResult.tokenCountBefore,
            tokenCountAfter: cloudManagedResult.tokenCountAfter,
            tokenReduction: cloudManagedResult.tokenReduction,
            compressedContext: cloudManagedResult.compressedContext,
            displaySummary: cloudManagedResult.displaySummary,
            memoryPacket: cloudManagedResult.memoryPacket,
            microCompactionKind: cloudManagedResult.microCompactionKind,
            microCompactedCount: cloudManagedResult.microCompactedCount,
            tokenBreakdown: cloudManagedResult.tokenBreakdownBefore,
          }, "reactive");
          emitPlanExecutionProgress("context_compression");
        }

        try {
          const cloudManagedForLLM = prepareMessagesForToolProtocol(
            cloudManagedMessages,
            config,
            settings,
            providerCompatibilityOverride,
          );
          streamResult = await fetchLLMStream(
            cloudManagedForLLM,
            settings,
            assistantMsgId,
            callbacks,
            abortController.signal,
            llmTools,
            cloudReactiveOutputBudget,
            1,
            getPlanStreamWatchdogOptions(llmTools.length),
          );
          if (llmTools.length > 0) {
            callbacks.onProviderNativeToolSuccess?.();
          }
        } catch (cloudRetryErr) {
          if ((cloudRetryErr as Error).name === "AbortError") {
            callbacks.onStatusChange("idle");
            return;
          }
          const cloudRetryErrMsg = (cloudRetryErr as Error).message || "";
          if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(cloudRetryErrMsg)) {
            const planStage = callbacks.getPlanStage();
            logAgentEvent("plan_stage_waiting_for_design", {
              iteration,
              planStage,
              reason: "stream_first_chunk_timeout_after_cloud_compaction",
              message: cloudRetryErrMsg.slice(0, 240),
            });
            callbacks.onNonActionableStop(
              buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
              "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return;
          }
          callbacks.onError(
            "Remote context limit exceeded even after local compaction retry. Please start a new conversation or shorten the history.",
          );
          callbacks.onStatusChange("error");
          return;
        }
      } else if (isCompatibilityError) {
        logAgentEvent("provider_compatibility_retry", {
          iteration,
          reason: errMsg.slice(0, 240),
          nativeToolsAttempted: nativeToolsWereAttempted,
        });
        callbacks.onProviderCompatibilityFallback?.(errMsg);
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
            getPlanStreamWatchdogOptions(0),
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
                getPlanStreamWatchdogOptions(0),
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
                  getPlanStreamWatchdogOptions(0),
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
      elapsedMs: Date.now() - iterationRequestStartedAt,
      emptyResult: streamText.length === 0 && streamResult.toolCalls.length === 0,
    });
    if (streamText.length === 0 && streamResult.toolCalls.length === 0) {
      logAgentEvent("llm_empty_response_diagnostic", {
        iteration,
        elapsedMs: Date.now() - iterationRequestStartedAt,
        workflowMode,
        turnIntent,
        runtimeIntent,
        activeProfile: config.activeProfile,
        provider: settings.provider || "unknown",
        model: settings.model,
        toolProtocol: effectiveToolProtocol,
        nativeToolsEnabled: llmTools.length > 0,
        llmToolCount: llmTools.length,
        messageCount: managedAgentMessages.length,
        contextLimit: settings.contextLimit,
        currentMaxTokens: currentMaxTokens ?? "default",
        likelyCauses: [
          config.activeProfile === "local" ? "local_prefill_or_provider_empty_completion" : "gateway_or_provider_empty_completion",
          forceXmlTools ? "text_xml_tool_protocol_no_native_tool_call" : "native_tool_protocol",
          managedAgentMessages.length > 12 ? "long_multi_turn_context" : "short_context",
        ],
      });
    }

    // 3. 将不同模型输出统一整理成标准结构，避免 UI 继续靠多处分支猜测。
    const normalizedBase = normalizeAssistantTurn(streamResult);
    const normalized = ensureVisibleConclusionWithPolicy(
      normalizedBase,
      config.thinkingPolicy !== "action_only",
    );
    if (isAssistantTurnEmpty(normalized)) {
      if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isReviewablePlanStage(callbacks.getPlanStage())) {
        logAgentEvent("plan_review_ready_after_empty_response", {
          iteration,
          planStage: callbacks.getPlanStage(),
          consecutiveEmptyResponseCount,
        });
        const reviewResult = await pauseForReviewablePlanArtifact("empty_response_with_reviewable_artifact");
        if (reviewResult === "approved_continue") continue;
        if (reviewResult === "stopped") return;
      }

      const malformedToolUseBlock =
        workflowMode === "plan" &&
        !callbacks.getIsPlanApproved() &&
        containsToolUseBlock(streamText) &&
        normalizedBase.toolCalls.length === 0;
      if (malformedToolUseBlock && !usedMalformedToolUseRecoveryPrompt) {
        usedMalformedToolUseRecoveryPrompt = true;
        logAgentEvent("tool_protocol_parse_failed", {
          iteration,
          workflowMode,
          turnIntent,
          reason: "unparsed_tool_use_block",
          preview: summarizeProtocolFragmentForLog(streamText),
        });
        callbacks.onStatusChange("running");
        callbacks.appendMessage({
          role: "user",
          content: buildMalformedToolUseRecoveryPrompt(callbacks.getPreferredLanguage()),
        });
        continue;
      }

      consecutiveEmptyResponseCount++;
      if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
        if (consecutiveEmptyResponseCount >= 2) {
          const closureResult = await tryClosePlanWithEvidence("empty_response_checkpoint", {
            consecutiveEmptyResponseCount,
            toolCallCount: 0,
            replyOptionCount: 0,
          });
          if (closureResult === "approved_continue") continue;
          if (closureResult === "stopped") return;
          if (closureResult === "failed") {
            logAgentEvent("plan_empty_after_closure_failed", {
              iteration,
              consecutiveEmptyResponseCount,
            });
          }
          logAgentEvent("loop_stop", {
            reason: "plan_empty_response_checkpoint",
            iteration,
            consecutiveEmptyResponseCount,
          });
          callbacks.onNonActionableStop(
            buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
            "incomplete_plan",
          );
          callbacks.onStatusChange("idle");
          return;
        }

        callbacks.appendMessage({
          role: "user",
          content: callbacks.getPreferredLanguage() === "zh"
            ? "上一条 Plan 回复是空的。请立即继续生成可审批的正式计划：复杂实现和修复类请求默认写入 `.MAIN/plans/design.md`；如果信息不足，只能用 `<user_options>` 给出关键选择。不要只返回空消息、隐藏 thinking/analysis，或伪工具占位。"
            : "The previous Plan reply was empty. Continue now with a reviewable plan: complex implementation and fix plans should write `.MAIN/plans/design.md`; if information is insufficient, offer key choices with `<user_options>`. Do not return an empty message, hidden thinking/analysis only, or pseudo-tool placeholders.",
        });
        continue;
      }
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

    let effectiveToolCalls: Array<{ id: string; name: string; arguments: string }> =
      normalized.toolCalls.map((call) => normalizeToolCallToExecute({
        id: call.id || `call_${generateId()}`,
        name: call.name,
        arguments: call.arguments,
      }, workspace));
    if (effectiveToolCalls.length > 0 && containsToolNameParameterFallback(streamText)) {
      const recoveredArgKeys = (() => {
        try {
          const parsedArgs = JSON.parse(effectiveToolCalls[0].arguments || "{}");
          return parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
            ? Object.keys(parsedArgs).sort()
            : [];
        } catch {
          return [];
        }
      })();
      logAgentEvent("tool_protocol_parse_recovered", {
        iteration,
        toolName: effectiveToolCalls[0].name,
        argumentKeys: recoveredArgKeys,
        workflowMode,
        turnIntent,
      });
    }

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
    const suppressReadOnlyPermissionOptionsForToolCalls =
      effectiveToolCalls.length > 0 &&
      hasOnlyReadOnlyPermissionReplyOptions(normalized.replyOptions);
    const sourceVisibleText = normalizedBase.visibleText || normalized.visibleText;
    const normalizedVisibleTextForUser = autoContinueReadOnlyPermission || suppressReadOnlyPermissionOptionsForToolCalls
      ? stripReadOnlyPermissionPrompt(normalized.visibleText)
      : normalized.visibleText;
    const finalVisibleText = compactedProseCodeDump
      ? buildProseCodeDumpNotice(callbacks.getPreferredLanguage(), normalized.visibleText.length)
      : compactedIncompletePlanText
      ? buildPlanFallbackNotice(callbacks.getPreferredLanguage(), sourceVisibleText.length)
      : normalizedVisibleTextForUser;
    const finalReplyOptions = compactedProseCodeDump || autoContinueReadOnlyPermission || suppressReadOnlyPermissionOptionsForToolCalls
      ? []
      : normalized.replyOptions;
    let recoveredPseudoToolCall = false;
    const pseudoToolNameCandidate =
      effectiveToolCalls.length === 0 &&
      finalReplyOptions.length === 0 &&
      !compactedProseCodeDump &&
      !compactedIncompletePlanText
        ? extractPseudoToolCallName(normalized.visibleText) ||
          extractPseudoToolCallName(normalized.hiddenThought) ||
          extractPseudoToolCallName(streamText)
        : null;
    if (pseudoToolNameCandidate) {
      const pseudoRecovery = choosePseudoToolRecovery({
        pseudoToolName: pseudoToolNameCandidate,
        availableToolNames,
        mentionedPaths: extractUserMentionedFilePathsFromMessages(callbacks.getMessages()),
        workflowMode,
        turnIntent,
      });
      if (pseudoRecovery.call) {
        recoveredPseudoToolCall = true;
        effectiveToolCalls = [pseudoRecovery.call];
        callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
        logAgentEvent("pseudo_tool_recovered", {
          iteration,
          requestedToolName: pseudoRecovery.requestedToolName,
          recoveredToolName: pseudoRecovery.recoveredToolName,
          reason: pseudoRecovery.reason,
          argumentKeys: pseudoRecovery.argumentKeys,
          mentionedPathCount: pseudoRecovery.mentionedPathCount,
          workflowMode,
          turnIntent,
        });
      } else {
        logAgentEvent("pseudo_tool_recovery_unavailable", {
          iteration,
          requestedToolName: pseudoRecovery.requestedToolName,
          reason: pseudoRecovery.reason,
          mentionedPathCount: pseudoRecovery.mentionedPathCount,
          workflowMode,
          turnIntent,
        });
      }
    }
    if (suppressReadOnlyPermissionOptionsForToolCalls) {
      logAgentEvent("readonly_permission_options_ignored_for_tool_call", {
        iteration,
        toolCalls: effectiveToolCalls.length,
        replyOptions: normalized.replyOptions.length,
        workflowMode,
        turnIntent,
      });
    }
    const pseudoToolCallPlaceholder =
      effectiveToolCalls.length === 0 &&
      finalReplyOptions.length === 0 &&
      !compactedProseCodeDump &&
      !compactedIncompletePlanText &&
      (
        looksLikePseudoToolCallPlaceholder(normalized.visibleText) ||
        looksLikePseudoToolCallPlaceholder(normalized.hiddenThought) ||
        looksLikeNonStandardToolCallFormat(streamText)
      );
    const syntheticVisibleConclusion =
      !compactedProseCodeDump &&
      !compactedIncompletePlanText &&
      (recoveredPseudoToolCall || isSyntheticVisibleConclusion(finalVisibleText) || pseudoToolCallPlaceholder);
    const userVisibleText = syntheticVisibleConclusion ? "" : finalVisibleText;
    if (syntheticVisibleConclusion) {
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      logAgentEvent("synthetic_visible_conclusion_suppressed", {
        iteration,
        workflowMode,
        turnIntent,
        hiddenThoughtChars: normalized.hiddenThought.length,
        toolCalls: effectiveToolCalls.length,
      });
    }
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
      looksLikeToolUnavailableClaim(userVisibleText);

    if (shouldRecoverToolUnavailableClaim && !usedToolUnavailableRecoveryPrompt) {
      usedToolUnavailableRecoveryPrompt = true;
      logAgentEvent("tool_unavailable_claim_reprompt", {
        iteration,
        allTools: iterationAllTools.length,
        llmTools: llmTools.length,
        xmlToolsEnabled: true,
        visibleChars: userVisibleText.length,
      });
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: buildToolUnavailableRecoveryPrompt(callbacks.getPreferredLanguage(), workflowMode),
      });
      continue;
    }

    if (pseudoToolCallPlaceholder && !usedPseudoToolCallRecoveryPrompt) {
      usedPseudoToolCallRecoveryPrompt = true;
      logAgentEvent("pseudo_tool_repair_requested", {
        iteration,
        workflowMode,
        turnIntent,
        requestedToolName: pseudoToolNameCandidate || "unknown",
        visibleChars: normalized.visibleText.length,
        hiddenThoughtChars: normalized.hiddenThought.length,
      });
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: buildPseudoToolCallRecoveryPrompt(callbacks.getPreferredLanguage(), workflowMode),
      });
      continue;
    }

    if (pseudoToolCallPlaceholder && usedPseudoToolCallRecoveryPrompt) {
      logAgentEvent("tool_protocol_doom_loop", {
        iteration,
        workflowMode,
        turnIntent,
        requestedToolName: pseudoToolNameCandidate || "unknown",
        visibleChars: normalized.visibleText.length,
        hiddenThoughtChars: normalized.hiddenThought.length,
      });
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      callbacks.onNonActionableStop(
        buildToolProtocolDoomLoopStopMessage(callbacks.getPreferredLanguage(), pseudoToolNameCandidate),
        "missing_tool_loop",
      );
      callbacks.onStatusChange("idle");
      return;
    }

    if (shouldTriggerUnityMcpFirstIterationFallback({
      toolCallCount: effectiveToolCalls.length,
      replyOptionCount: finalReplyOptions.length,
      unityMcpFirstPhaseActive,
      unityMcpFirstIterationPending,
    })) {
      unityMcpFirstIterationPending = false;
      activateUnityMcpFallback("first_iteration_no_tool_call");
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: callbacks.getPreferredLanguage() === "zh"
          ? "Unity MCP 首轮没有触发工具调用。请立即改用当前可用的本地只读工具继续诊断，不要再声称将要读取。先读取最相关的日志/文件并给出发现。"
          : "Unity MCP did not produce a tool call in the first iteration. Immediately continue with currently available local read-only tools, read the most relevant logs/files now, and report findings.",
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

    const approvedPlanAuditForNoTool =
      workflowMode === "plan" &&
      callbacks.getIsPlanApproved() &&
      effectiveToolCalls.length === 0
        ? buildPlanTaskEvidenceAudit({
            tasks: callbacks.getPlanTasks(),
            evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
            highlightNext: true,
          })
        : null;
    const approvedPlanMissingTasksForNoTool =
      workflowMode === "plan" &&
      callbacks.getIsPlanApproved() &&
      effectiveToolCalls.length === 0 &&
      approvedPlanAuditForNoTool?.totalCount === 0;
    const hasRemainingApprovedPlanTasksForNoTool =
      workflowMode === "plan" &&
      callbacks.getIsPlanApproved() &&
      effectiveToolCalls.length === 0 &&
      !!approvedPlanAuditForNoTool &&
      (!approvedPlanAuditForNoTool.allTrustedComplete || approvedPlanAuditForNoTool.pendingExternalValidation);
    const shouldSuppressApprovedPlanNoToolText =
      approvedPlanMissingTasksForNoTool || hasRemainingApprovedPlanTasksForNoTool;
    const rejectedCompletionClaim =
      shouldSuppressApprovedPlanNoToolText && looksLikePlanCompletionClaim(userVisibleText);

    if (shouldSuppressApprovedPlanNoToolText && (userVisibleText.trim() || finalReplyOptions.length > 0)) {
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      logAgentEvent(rejectedCompletionClaim ? "plan_completion_claim_rejected" : "plan_no_tool_text_suppressed", {
        iteration,
        completionClaimRejected: rejectedCompletionClaim,
        auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
        auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
        remaining: approvedPlanAuditForNoTool?.remainingTasks.length ?? 0,
        visibleChars: userVisibleText.length,
      });
    }

    const languageMismatchDecision = shouldRecoverLanguageMismatchTurn({
      text: userVisibleText,
      targetLanguage: callbacks.getPreferredLanguage(),
      suppressedByPlanGuard: shouldSuppressApprovedPlanNoToolText,
      toolCallCount: effectiveToolCalls.length,
      alreadyRetried: usedLanguageMismatchRecoveryPrompt,
    });

    if (languageMismatchDecision.action === "recover_once") {
      usedLanguageMismatchRecoveryPrompt = true;
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      logAgentEvent("language_mismatch_reprompt", {
        iteration,
        targetLanguage: callbacks.getPreferredLanguage(),
        detectedLanguage: languageMismatchDecision.detectedLanguage,
        hanCount: languageMismatchDecision.hanCount,
        latinLetters: languageMismatchDecision.latinLetters,
        latinWords: languageMismatchDecision.latinWords,
        visibleChars: userVisibleText.length,
      });
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: buildLanguageMismatchRecoveryPrompt(callbacks.getPreferredLanguage()),
      });
      continue;
    }

    let visibleAssistantText = userVisibleText;
    if (languageMismatchDecision.action === "hide_text_continue") {
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      visibleAssistantText = "";
      logAgentEvent("language_mismatch_text_hidden_for_tool_calls", {
        iteration,
        targetLanguage: callbacks.getPreferredLanguage(),
        detectedLanguage: languageMismatchDecision.detectedLanguage,
        hanCount: languageMismatchDecision.hanCount,
        latinLetters: languageMismatchDecision.latinLetters,
        latinWords: languageMismatchDecision.latinWords,
        visibleChars: userVisibleText.length,
        toolCalls: effectiveToolCalls.length,
      });
    }

    if (languageMismatchDecision.exhausted) {
      logAgentEvent("language_mismatch_reprompt_exhausted", {
        iteration,
        targetLanguage: callbacks.getPreferredLanguage(),
        detectedLanguage: languageMismatchDecision.detectedLanguage,
        visibleChars: userVisibleText.length,
      });
    }

    if (effectiveToolCalls.length > 0 && !visibleAssistantText.trim() && config.thinkingPolicy !== "action_only") {
      const narration = buildToolActionNarration({
        calls: effectiveToolCalls,
        workspace,
        language: callbacks.getPreferredLanguage(),
        workflowMode,
        isPlanApproved: callbacks.getIsPlanApproved(),
      });
      if (narration) {
        visibleAssistantText = narration;
        logAgentEvent("tool_action_narration_injected", {
          iteration,
          workflowMode,
          turnIntent,
          thinkingPolicy: config.thinkingPolicy,
          toolCalls: effectiveToolCalls.length,
          toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
        });
      }
    }

    if (effectiveToolCalls.length > 0 && containsToolUseBlock(streamText)) {
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      logAgentEvent("tool_protocol_stream_cleared", {
        iteration,
        toolCalls: effectiveToolCalls.length,
        narrationInjected: visibleAssistantText.trim().length > 0,
        workflowMode,
        turnIntent,
      });
    }

    const historyAssistantText = visibleAssistantText || "";
    if (historyAssistantText.trim()) {
      lastAssistantTextForCheckpoint = historyAssistantText;
    }

    if (!shouldSuppressApprovedPlanNoToolText) {
      callbacks.onTurnSummaryReady(visibleAssistantText);
    }

    if (normalized.hiddenThought) {
      callbacks.onThought(normalized.hiddenThought);
    }

    if (!shouldSuppressApprovedPlanNoToolText && (visibleAssistantText || finalReplyOptions.length > 0)) {
      callbacks.onAssistantFinalText(visibleAssistantText, finalReplyOptions, {
        hasToolCalls: effectiveToolCalls.length > 0,
      });
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
    const isApprovedPlanExecutionTurn =
      workflowMode === "plan" &&
      callbacks.getIsPlanApproved() &&
      currentPlanStageForReview === "executing";
    const hasReadyPlanArtifacts = currentPlanStageForReview === "ready_to_execute";
    const hasReviewablePlanArtifacts = isReviewablePlanStage(currentPlanStageForReview);
    const shouldPauseForUserChoice = shouldPauseForReplyOptions({
      replyOptions: finalReplyOptions,
      toolCallCount: effectiveToolCalls.length,
      workflowMode,
      hasStructuredProposal,
      hasReadyPlanArtifacts,
      isPlanApproved: callbacks.getIsPlanApproved(),
      forcePause: normalized.hasExplicitUserChoiceRequest,
      finishReason: normalized.finishReason,
    });
    const assistantHistoryText = serializeAssistantReplyForHistory(historyAssistantText, finalReplyOptions);
    const hasMeaningfulVisibleText = visibleAssistantText.trim().length > 0;
    const wasTruncated = normalized.finishReason === "length";
    const hiddenThoughtOnlyNoToolStop =
      effectiveToolCalls.length === 0 &&
      finalReplyOptions.length === 0 &&
      !hasMeaningfulVisibleText &&
      normalized.hiddenThought.trim().length > 0;

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

    if (finalReplyOptions.length > 0 && !shouldPauseForUserChoice) {
      logAgentEvent("reply_options_rejected", {
        iteration,
        reason: wasTruncated ? "truncated_inferred_options" : "non_pauseable_options",
        replyOptions: finalReplyOptions.length,
        optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
        finishReason: normalized.finishReason || "unknown",
        workflowMode,
        turnIntent,
      });
    }

    // 4. Handle turn termination or continuation
    if (shouldPauseForUserChoice && !shouldSuppressApprovedPlanNoToolText) {
      logAgentEvent("reply_options_pause", {
        iteration,
        replyOptions: finalReplyOptions.length,
        optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
        droppedToolCalls: effectiveToolCalls.length,
        workflowMode,
        turnIntent,
      });
      if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
        logAgentEvent("plan_user_choice_checkpoint", {
          iteration,
          replyOptions: finalReplyOptions.length,
          optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
          hasStructuredProposal,
          planStage: currentPlanStageForReview,
        });
      }
      callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });
      callbacks.onStatusChange("idle");
      return;
    }

    if (isApprovedPlanExecutionTurn && effectiveToolCalls.length === 0 && shouldSuppressApprovedPlanNoToolText) {
      callbacks.onStatusChange("running");
      consecutiveNoToolCount++;
      const language = callbacks.getPreferredLanguage();
      const approvedPlanTasks = approvedPlanAuditForNoTool?.tasks || callbacks.getPlanTasks();
      const approvedPlanMissingTasks = (approvedPlanAuditForNoTool?.totalCount || 0) === 0;
      const remainingText = approvedPlanAuditForNoTool
        ? formatPlanAuditRemainingTasks(
            approvedPlanAuditForNoTool,
            language,
            language === "zh"
              ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
              : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.",
          )
        : language === "zh"
        ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
        : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.";
      const validationBoundary = resolveApprovedPlanValidationBoundary({
        audit: approvedPlanAuditForNoTool,
        availableToolNames,
      });
      const browserValidationAvailable = hasBrowserValidationCapability(availableToolNames);

      if (validationBoundary === "pause_external_validation" && approvedPlanAuditForNoTool) {
        logAgentEvent("plan_execution_validation_boundary", {
          iteration,
          reason: "external_validation_unavailable",
          auditCompleted: approvedPlanAuditForNoTool.completedCount,
          auditTotal: approvedPlanAuditForNoTool.totalCount,
          remaining: approvedPlanAuditForNoTool.remainingTasks.length,
          pendingUserValidation: approvedPlanAuditForNoTool.pendingUserValidationTasks.length,
          browserValidationAvailable,
        });
        emitPlanExecutionProgress("paused", {
          currentTask: language === "zh" ? "待用户验证" : "pending user validation",
          nextStep: language === "zh"
            ? "自动验证能力不足，等待用户完成浏览器/Tauri/人工确认"
            : "automation boundary reached; wait for browser/Tauri/user confirmation",
        });
        callbacks.onNonActionableStop(
          buildApprovedPlanValidationPendingMessage({
            language,
            audit: approvedPlanAuditForNoTool,
            browserValidationAvailable,
          }),
          "incomplete_plan",
        );
        callbacks.onStatusChange("idle");
        return;
      }

      logAgentEvent("plan_execution_no_tool_reprompt", {
        iteration,
        consecutiveNoToolCount,
        visibleChars: normalized.visibleText.length,
        completionClaimRejected: rejectedCompletionClaim,
        missingTasksArtifact: approvedPlanMissingTasks,
        auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
        auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
        remaining: approvedPlanAuditForNoTool?.remainingTasks.length ?? 0,
      });

      if (consecutiveNoToolCount >= MAX_NO_ACTION_RETRIES) {
        logAgentEvent("loop_stop", {
          reason: "plan_execution_no_tool_checkpoint",
          iteration,
          consecutiveNoToolCount,
          completionClaimRejected: rejectedCompletionClaim,
          auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
          auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
        });
        emitPlanExecutionProgress("paused", {
          nextStep: language === "zh"
            ? "恢复后先读取当前 tasks.md 和 workspace 状态，再继续第一个证据未满足的任务"
            : "on resume, reread current tasks.md and workspace state, then continue the first task whose evidence is not satisfied",
        });
        callbacks.onNonActionableStop(
          buildApprovedPlanNoToolPauseMessage(
            language,
            remainingText,
            consecutiveNoToolCount,
            approvedPlanAuditForNoTool || undefined,
            rejectedCompletionClaim,
          ),
          "incomplete_plan",
        );
        callbacks.onStatusChange("idle");
        return;
      }

      callbacks.appendMessage({
        role: "user",
        content: validationBoundary === "browser_prompt"
          ? buildBrowserValidationContinuationPrompt({ language, remainingText })
          : buildPlanExecutionNoToolRecoveryPrompt({
              language,
              missingTasksArtifact: approvedPlanMissingTasks,
              remainingText,
              commandHint: buildPlanCommandExecutionHint(approvedPlanTasks, language),
              rejectedCompletionClaim,
            }),
      });
      continue;
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
        const shouldTryPlanTextMaterialization =
          planningStillIncomplete &&
          hasMeaningfulSourcePlanText &&
          !hasReviewablePlanArtifacts &&
          finalReplyOptions.length === 0 &&
          !hasStructuredProposal &&
          (
            sawPlanModeToolActivity ||
            wasTruncated ||
            turnIntent === "plan" ||
            commandDirective?.action === "plan_file_change"
          );
        const shouldRefineLongPlanIntoChoice =
          planningStillIncomplete &&
          hasMeaningfulVisibleText &&
          wasTruncated &&
          !shouldMaterializeFallbackPlan;
        const shouldForcePlanContinuation = planningStillIncomplete && !hasMeaningfulVisibleText;

        if (shouldTryPlanTextMaterialization) {
          const materializedPlan = await autoMaterializePlanArtifactFromVisibleText({
            visibleText: sourceVisibleText,
            workspace,
            callbacks,
          });

          if (materializedPlan.ok) {
            callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });
            logAgentEvent("plan_text_materialized", {
              iteration,
              path: materializedPlan.path,
              kind: materializedPlan.kind,
              visibleChars: sourceVisibleText.length,
              sawPlanModeToolActivity,
              wasTruncated,
            });
            const approved = await waitForPlanApprovalIfNeeded();
            if (!approved) {
              if (callbacks.getStatus() !== "pending_review") {
                callbacks.onStatusChange("idle");
              }
              return;
            }
            callbacks.onPlanStageChanged("executing");
            callbacks.appendMessage({
              role: "user",
              content: buildApprovedPlanContinuationPrompt(callbacks),
            });
            continue;
          }

          logAgentEvent("plan_text_materialization_rejected", {
            iteration,
            reason: materializedPlan.reason || "unknown",
            visibleChars: sourceVisibleText.length,
          });
        }

        if (shouldMaterializeFallbackPlan) {
          callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });

          if (usedPlanRecoveryPrompt) {
            const closureResult = await tryClosePlanWithEvidence("plan_recovery_prompt_limit", {
              rejectedVisibleChars: sourceVisibleText.length,
              toolCallCount: effectiveToolCalls.length,
              replyOptionCount: finalReplyOptions.length,
            });
            if (closureResult === "approved_continue") continue;
            if (closureResult === "stopped") return;
            if (closureResult === "failed") {
              logAgentEvent("plan_empty_after_closure_failed", {
                iteration,
                visibleChars: sourceVisibleText.length,
              });
            }
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
            const closureResult = await tryClosePlanWithEvidence("force_plan_continuation_limit", {
              rejectedVisibleChars: sourceVisibleText.length,
              toolCallCount: effectiveToolCalls.length,
              replyOptionCount: finalReplyOptions.length,
            });
            if (closureResult === "approved_continue") continue;
            if (closureResult === "stopped") return;
            if (closureResult === "failed") {
              logAgentEvent("plan_empty_after_closure_failed", {
                iteration,
                consecutiveNoToolCount,
              });
            }
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
                ? "你已经有旧流程的 requirements.md，下一步必须生成或更新 `.MAIN/plans/design.md` 作为可审批方案；如果设计方向仍不明确，只能用 `<user_options>` 给出面向用户的选择并停止。不要重复读取已读文件。"
                : currentPlanStage === "design"
                ? "你已经有 design.md，下一步应输出正式 Proposal 或给用户关键选择；不要在批准前提前生成 tasks.md。"
                : sawPlanModeToolActivity
                ? "你已经开始做项目探索了，但还没有给出可让用户决策的规划结果。下一步应先收束分歧并询问用户。"
                : "请先给出可让用户决策的规划问题。"
              : currentPlanStage === "requirements"
              ? "A legacy requirements.md exists. Next generate or update `.MAIN/plans/design.md` as the reviewable plan; if the design direction is still unclear, offer `<user_options>` and stop. Do not repeat reads of files already in context."
              : currentPlanStage === "design"
              ? "design.md exists. Next submit the formal Proposal or offer the key choices; do not generate tasks.md before approval."
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
                  "3. 如果这是复杂实现计划，必须生成 `.MAIN/plans/design.md` 供审批；requirements.md 只是可选需求台账，在用户批准之前不要生成 `tasks.md` 或修改源码。\n" +
                  `${currentPlanStage === "requirements" ? "当前已经有旧流程 requirements.md，本轮不要重复读文件；请直接写 design.md，或用 user_options 询问设计分叉。\n" : ""}` +
                  `${wasTruncated ? "你上一条回复已经发生截断，请从中断处继续，不要重头重复。\n" : ""}` +
                  "不要只输出一句总结、结束语，或空结束符。"
                : `The current plan has not reached an executable stage. ${missingStepHint}\n` +
                  `${CONCISE_PLAN_ARTIFACT_HINT_EN}\n` +
                  "Continue planning and complete one of these before ending this turn:\n" +
                  "1. Output 3-8 key judgments in Markdown, then offer 2-4 `<user_options>` for the user to choose from.\n" +
                  "2. If there is enough information, output the formal Proposal: `[PROPOSAL START]` + `# Proposed Plan` + one-page review summary + valid `<plan>` JSON.\n" +
                  "3. For complex implementation planning, create `.MAIN/plans/design.md` for review; requirements.md is only an optional requirement ledger. Do not generate `tasks.md` or edit source files before approval.\n" +
                  `${currentPlanStage === "requirements" ? "A legacy requirements.md already exists. Do not repeat file reads in this turn; write design.md directly, or ask for design choices with user_options.\n" : ""}` +
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
          missingToolCallRepromptKind !== "none" ||
          hiddenThoughtOnlyNoToolStop;

        if (shouldRepromptForMissingToolCall) {
          callbacks.onStatusChange("running");
          consecutiveNoToolCount++;
          if (!hasMeaningfulVisibleText) {
            callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          }
          logAgentEvent("missing_tool_reprompt", {
            iteration,
            kind: hiddenThoughtOnlyNoToolStop
              ? "hidden_thought_only"
              : missingToolCallRepromptKind === "none" ? "generic" : missingToolCallRepromptKind,
            consecutiveNoToolCount,
            visibleChars: normalized.visibleText.length,
            preservedVisibleText: hasMeaningfulVisibleText,
          });
          if (consecutiveNoToolCount >= MAX_NO_ACTION_RETRIES) {
            logAgentEvent("loop_stop", {
              reason: "missing_tool_reprompt_limit",
              iteration,
              consecutiveNoToolCount,
              kind: hiddenThoughtOnlyNoToolStop
                ? "hidden_thought_only"
                : missingToolCallRepromptKind === "none" ? "generic" : missingToolCallRepromptKind,
            });
            callbacks.onNonActionableStop(
              buildNonActionableStopMessage(
                callbacks.getPreferredLanguage(),
                hiddenThoughtOnlyNoToolStop ? "no_output" : "missing_tool_loop",
              ),
              hiddenThoughtOnlyNoToolStop ? "no_output" : "missing_tool_loop",
            );
            callbacks.onStatusChange("idle");
            return;
          }

          const continuationMsg: AgentMessage = {
            role: "user",
            content: hiddenThoughtOnlyNoToolStop
              ? buildHiddenThoughtOnlyContinuationPrompt(callbacks.getPreferredLanguage(), consecutiveNoToolCount)
              : buildMissingToolCallContinuationPrompt(
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

        if (unityConsoleDiagnosticsRequested && unityConsoleFinalVerificationRequired) {
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: callbacks.getPreferredLanguage() === "zh"
              ? "在输出最终结论前，必须先完成一次最终验证：先调用 refresh_unity，再调用 read_console。完成这一次验证后再给结论，不要重复多轮验证。"
              : "Before giving the final conclusion, run one final verification pass: call refresh_unity first, then read_console. After this single verification pass, provide the conclusion without repeating more verification loops.",
          });
          continue;
        }

        // No intent detected — genuinely done
        const approvedPlanAudit = approvedPlanAuditForNoTool ||
          (workflowMode === "plan" && callbacks.getIsPlanApproved()
            ? buildPlanTaskEvidenceAudit({
                tasks: callbacks.getPlanTasks(),
                evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
                highlightNext: true,
              })
            : null);
        const approvedPlanTasks = approvedPlanAudit?.tasks || [];
        const approvedPlanMissingTasks =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          (approvedPlanAudit?.totalCount || 0) === 0;
        const hasRemainingApprovedPlanTasks =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          !!approvedPlanAudit &&
          (!approvedPlanAudit.allTrustedComplete || approvedPlanAudit.pendingExternalValidation);

        if (approvedPlanMissingTasks || hasRemainingApprovedPlanTasks) {
          callbacks.onStatusChange("running");
          consecutiveNoToolCount++;
          const language = callbacks.getPreferredLanguage();
          const remainingText = approvedPlanAudit
            ? formatPlanAuditRemainingTasks(
                approvedPlanAudit,
                language,
                language === "zh"
                  ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
                  : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.",
              )
            : language === "zh"
            ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
            : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.";
          const validationBoundary = resolveApprovedPlanValidationBoundary({
            audit: approvedPlanAudit,
            availableToolNames,
          });
          const browserValidationAvailable = hasBrowserValidationCapability(availableToolNames);
          if (validationBoundary === "pause_external_validation" && approvedPlanAudit) {
            logAgentEvent("plan_execution_validation_boundary", {
              iteration,
              reason: "external_validation_unavailable",
              auditCompleted: approvedPlanAudit.completedCount,
              auditTotal: approvedPlanAudit.totalCount,
              remaining: approvedPlanAudit.remainingTasks.length,
              pendingUserValidation: approvedPlanAudit.pendingUserValidationTasks.length,
              browserValidationAvailable,
            });
            emitPlanExecutionProgress("paused", {
              currentTask: callbacks.getPreferredLanguage() === "zh" ? "待用户验证" : "pending user validation",
              nextStep: callbacks.getPreferredLanguage() === "zh"
                ? "自动验证能力不足，等待用户完成浏览器/Tauri/人工确认"
                : "automation boundary reached; wait for browser/Tauri/user confirmation",
            });
            callbacks.onNonActionableStop(
              buildApprovedPlanValidationPendingMessage({
                language,
                audit: approvedPlanAudit,
                browserValidationAvailable,
              }),
              "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return;
          }
          if (consecutiveNoToolCount >= MAX_NO_ACTION_RETRIES) {
            logAgentEvent("loop_stop", {
              reason: "remaining_plan_tasks_limit",
              iteration,
              consecutiveNoToolCount,
              completionClaimRejected: rejectedCompletionClaim,
              auditCompleted: approvedPlanAudit?.completedCount ?? 0,
              auditTotal: approvedPlanAudit?.totalCount ?? 0,
            });
            emitPlanExecutionProgress("paused", {
              nextStep: callbacks.getPreferredLanguage() === "zh"
                ? "点击 Resume Execution 后重新读取当前 workspace 状态并继续"
                : "click Resume Execution, reread current workspace state, and continue",
            });
            callbacks.onNonActionableStop(
              buildApprovedPlanNoToolPauseMessage(
                callbacks.getPreferredLanguage(),
                remainingText,
                consecutiveNoToolCount,
                approvedPlanAudit || undefined,
                rejectedCompletionClaim,
              ),
              "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return;
          }

          callbacks.appendMessage({
            role: "user",
            content:
              validationBoundary === "browser_prompt"
                ? buildBrowserValidationContinuationPrompt({ language, remainingText })
                : (approvedPlanMissingTasks
                    ? buildApprovedPlanContinuationPrompt(callbacks) + "\n\n"
                    : language === "zh"
                    ? `${rejectedCompletionClaim ? "你刚才的完成声明没有通过可信证据审计；不要再输出完成总结，先继续真实执行。\n" : ""}继续执行当前任务清单中证据未满足的任务。不要重复计划说明，直接根据当前进度继续实现下一个任务；如果需要修改文件，继续使用工具调用。凡是任务里带有 shell 命令的，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr；长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查结果。完成当前任务后，必须先产生真实文件/命令/验证证据；如果 \`.MAIN/plans/tasks.md\` 已存在，再更新对应 checkbox 为 \`[x]\`。只有所有任务证据满足后才能结束。\n下一批优先任务：\n`
                    : `${rejectedCompletionClaim ? "Your completion claim did not pass the trusted evidence audit; do not output a final summary yet, continue the real work first.\n" : ""}Continue executing tasks whose evidence is not satisfied in the current task list. Do not restate the plan; just move to the next task based on the current progress. If a task includes shell commands, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status. After each task, produce real file/command/verification evidence; if \`.MAIN/plans/tasks.md\` exists, update the matching checkbox to \`[x]\`. Only stop when every task has satisfied evidence.\nNext priority tasks:\n`) +
                  remainingText +
                  "\n\n" +
                  buildPlanCommandExecutionHint(approvedPlanTasks, language),
          });
          continue;
        }

        if (
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          approvedPlanAudit &&
          approvedPlanAudit.pendingUserValidationTasks.length > 0
        ) {
          const language = callbacks.getPreferredLanguage();
          emitPlanExecutionProgress("paused", {
            currentTask: language === "zh" ? "待用户验证" : "pending user validation",
            nextStep: language === "zh"
              ? "自动部分已完成，等待用户完成剩余验证"
              : "automated work is complete; waiting for remaining user validation",
          });
          callbacks.onNonActionableStop(
            buildApprovedPlanValidationPendingMessage({
              language,
              audit: approvedPlanAudit,
              browserValidationAvailable: hasBrowserValidationCapability(availableToolNames),
            }),
            "incomplete_plan",
          );
          callbacks.onStatusChange("idle");
          return;
        }

        if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
          emitTaskOrchestratorPhase("DONE", {
            reason: "plan_evidence_complete",
            iteration,
          });
          emitPlanExecutionProgress("completed");
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
          emitTurnEvent({
            type: "item.completed",
            threadId: eventThreadId,
            turnId: eventTurnId,
            timestampMs: Date.now(),
            item: {
              id: assistantMsgId,
              details: {
                type: "agent_message",
                text: assistantHistoryText,
              },
            } as MainThreadItem,
          });
          callbacks.onNonActionableStop(
            buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
            "incomplete_plan",
          );
          callbacks.onStatusChange("idle");
          emitTurnCompletedEvent();
          return;
        }

        logAgentEvent("loop_stop", {
          reason: "assistant_text_done",
          iteration,
          visibleChars: normalized.visibleText.length,
          replyOptions: normalized.replyOptions.length,
        });
        callbacks.appendMessage({ role: "assistant", content: assistantHistoryText });
        emitTurnEvent({
          type: "item.completed",
          threadId: eventThreadId,
          turnId: eventTurnId,
          timestampMs: Date.now(),
          item: {
            id: assistantMsgId,
            details: {
              type: "agent_message",
              text: assistantHistoryText,
            },
          } as MainThreadItem,
        });
        callbacks.onStatusChange("idle");
        emitTurnCompletedEvent();
        return;
      }

    // Tools have been found, reset the no-tool streak
    consecutiveNoToolCount = 0;
    if (unityMcpFirstIterationPending) {
      unityMcpFirstIterationPending = false;
    }
    logAgentEvent("tool_calls_detected", {
      iteration,
      count: effectiveToolCalls.length,
      names: effectiveToolCalls.map((call) => call.name).slice(0, 12),
    });
    emitTaskOrchestratorPhase("EXECUTE_STEP", {
      iteration,
      toolCalls: effectiveToolCalls.length,
      toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 12),
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

    // Partition tool calls into auto-executable, local file read approvals,
    // spec file writes (auto-approved in Plan Mode), and review-gated tools.
    const readOnlyCalls: Array<ToolCallToExecute & { allowExternalLocalRead?: boolean }> = [];
    const localFileReadCalls: Array<ToolCallToExecute & { localFileReadPath: string }> = [];
    const specFileCalls: ToolCallToExecute[] = [];
    const writeCalls: ToolCallToExecute[] = [];
    const toolArgsByCallId = new Map<string, Record<string, unknown>>();
    const readOnlyCallSignatures = new Map<string, string>();
    const queuedReadOnlySignatures = new Set<string>();
    const toolFailureSignatures = new Map<string, string>();
    let allResults: ToolExecutionResult[] = [];

    for (const tc of effectiveToolCalls) {
      const toolArgs = parseToolCallArguments(tc, workspace);
      toolArgsByCallId.set(tc.id, toolArgs);
      const target = getToolTarget(tc.name, toolArgs);
      callbacks.onHarnessRunUpdate?.({
        latestTool: tc.name,
        latestToolTarget: target || null,
        toolCallId: tc.id,
        streamStatus: "tool_called",
      });
      const failureSignature = buildRepeatLoopSignature(tc.name, buildRepeatLoopArgsKey(toolArgs));
      toolFailureSignatures.set(tc.id, failureSignature);

      if ((failedToolCallCounts.get(failureSignature) ?? 0) >= 2) {
        const message = callbacks.getPreferredLanguage() === "zh"
          ? `REPEATED_FAILURE_BLOCKED: ${tc.name}${target ? ` (${target})` : ""} 已用相同参数连续失败。请先诊断最近错误，改变参数或换一条策略，不要原样重试。`
          : `REPEATED_FAILURE_BLOCKED: ${tc.name}${target ? ` (${target})` : ""} has failed repeatedly with identical arguments. Diagnose the latest error and change arguments or strategy before retrying.`;
        callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
        allResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: `Error: ${message}`,
          isError: true,
          lifecycleState: "blocked",
        });
        continue;
      }

      if (!availableToolNames.has(tc.name)) {
        const message = callbacks.getPreferredLanguage() === "zh"
          ? `工具 "${tc.name}" 当前没有暴露给 ${runtimeIntent} 运行意图。请使用本轮可用工具；如果这是已批准计划的执行步骤，请继续按执行阶段恢复。`
          : `Tool "${tc.name}" is not exposed for the current ${runtimeIntent} runtime intent. Use an available tool; if this is approved plan execution, continue from the execution stage.`;
        callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
        allResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: `Error: ${message}`,
          isError: true,
          lifecycleState: "blocked",
        });
        continue;
      }

      const targetingProfile = buildCurrentTaskTargetingProfile();
      const targetingGate = shouldBlockToolCallForTargeting({
        profile: targetingProfile,
        toolName: tc.name,
        args: toolArgs,
        target,
        availableToolNames,
        language: callbacks.getPreferredLanguage(),
      });
      if (targetingGate.blocked) {
        const message = targetingGate.message || (
          callbacks.getPreferredLanguage() === "zh"
            ? "TASK_TARGETING_BLOCKED: 请先使用更定向的读取或确认步骤。"
            : "TASK_TARGETING_BLOCKED: use a more targeted read or confirmation step first."
        );
        callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
        logAgentEvent("task_targeting_tool_blocked", {
          iteration,
          tool: tc.name,
          target,
          reason: targetingGate.reason || "unknown",
          facets: targetingProfile.facets,
          preferredReadTools: targetingProfile.preferredReadTools,
          explicitPaths: targetingProfile.explicitPaths.slice(0, 8),
          symbols: targetingProfile.symbols.slice(0, 8),
        });
        allResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: `Error: ${message}`,
          isError: true,
          lifecycleState: "blocked",
        });
        continue;
      }

      const approvedLocalFileReadPaths = callbacks.getApprovedLocalFileReadPaths();
      const planned = planRuntimeToolCall({
        toolCall: tc,
        workspace,
        availableToolNames,
        capabilityRegistry: toolCapabilityRegistry,
        toolPermissionPolicy: config.toolPermissionPolicy,
        approvedLocalFileReadPaths,
        workflowMode,
        runtimeIntent,
        isPlanApproved: callbacks.getIsPlanApproved(),
        planTaskCount: callbacks.getPlanTasks().length,
        getToolTarget,
        isPreApprovalPlanDraftWrite,
        isExecutionPlanArtifactWrite,
        isTasksPlanWrite,
      });
      const targetState = initialLifecycleStateForPlanAction(planned.action);
      emitTurnEvent({
        type: "item.started",
        threadId: eventThreadId,
        turnId: eventTurnId,
        timestampMs: Date.now(),
        item: {
          id: tc.id,
          details: {
            type: "tool_lifecycle",
            toolCallId: tc.id,
            tool: tc.name,
            target: planned.target,
            status: targetState,
          },
        } as MainThreadItem,
      });

      if (planned.action === "local_file_read_review" && planned.localFileReadPath) {
        localFileReadCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments, localFileReadPath: planned.localFileReadPath });
      } else if (planned.action === "auto_execute") {
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
            const planBudget = buildPlanExplorationBudget({
              workflowMode,
              isPlanApproved: callbacks.getIsPlanApproved(),
              toolName: tc.name,
              target: target || fileReadState.path,
              duplicateCount,
              hasTabularEvidence: hasSuccessfulTabularActivity(recentPlanToolActivity),
              successfulReadEvidenceCount: countSuccessfulPlanReadEvidence(recentPlanToolActivity),
            });
            const shouldPushPlanReadLimit =
              workflowMode === "plan" &&
              !callbacks.getIsPlanApproved() &&
              (duplicateCount >= PLAN_REPEAT_READ_LIMIT || planBudget.shouldRedirectToDesignClosure);
            if (shouldPushPlanReadLimit) {
              logAgentEvent("plan_repeat_read_limit", {
                iteration,
                stage: callbacks.getPlanStage(),
                tool: tc.name,
                target: target || fileReadState.path,
                duplicateCount,
                reason: planBudget.reason || "duplicate_file_read",
              });
            }
            const baseStub = buildFileUnchangedStub(fileReadState);
            const closurePrompt = shouldPushPlanReadLimit
              ? `\n\n${buildPlanDesignClosurePromptFromEvidence(callbacks, recentPlanToolActivity, attemptedPlanWriteTargets)}`
              : "";
            const content = shouldPushPlanReadLimit
              ? appendPlanRepeatReadLimitGuidance(
                  `${baseStub}${closurePrompt}`,
                  callbacks.getPreferredLanguage(),
                  callbacks.getPlanStage(),
                )
              : baseStub;
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
          const planBudget = buildPlanExplorationBudget({
            workflowMode,
            isPlanApproved: callbacks.getIsPlanApproved(),
            toolName: tc.name,
            target,
            duplicateCount,
            hasTabularEvidence: hasSuccessfulTabularActivity(recentPlanToolActivity),
            successfulReadEvidenceCount: countSuccessfulPlanReadEvidence(recentPlanToolActivity),
          });
          const shouldPushPlanReadLimit =
            workflowMode === "plan" &&
            !callbacks.getIsPlanApproved() &&
            (duplicateCount >= PLAN_REPEAT_READ_LIMIT || planBudget.shouldRedirectToDesignClosure);
          if (shouldPushPlanReadLimit) {
            logAgentEvent("plan_repeat_read_limit", {
              iteration,
              stage: callbacks.getPlanStage(),
              tool: tc.name,
              target,
              duplicateCount,
              reason: planBudget.reason || "duplicate_read",
            });
          }
          const duplicateContent = formatCachedReadOnlyToolResult(tc.name, target, cached, duplicateCount);
          const closurePrompt = shouldPushPlanReadLimit
            ? `\n\n${buildPlanDesignClosurePromptFromEvidence(callbacks, recentPlanToolActivity, attemptedPlanWriteTargets)}`
            : "";
          allResults.push({
            toolCallId: tc.id,
            name: tc.name,
            target,
            content: shouldPushPlanReadLimit
              ? appendPlanRepeatReadLimitGuidance(
                  `${duplicateContent}${closurePrompt}`,
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
        readOnlyCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          allowExternalLocalRead:
            !!planned.localFileReadPath &&
            isLocalFileReadApproved(planned.localFileReadPath, approvedLocalFileReadPaths),
        });
      } else if (planned.action === "spec_file_auto_approved") {
        specFileCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
      } else if (planned.action === "blocked_plan_gate") {
        if (planned.target) attemptedPlanWriteTargets.push(planned.target);
        allResults.push(buildPlanGateBlockedResult(tc, toolArgs, callbacks, planned.reason || "pre_approval_source_write"));
      } else if (planned.action === "blocked_unavailable") {
        const message = callbacks.getPreferredLanguage() === "zh"
          ? `工具 "${tc.name}" 当前没有暴露给 ${runtimeIntent} 运行意图。请使用本轮可用工具；如果这是已批准计划的执行步骤，请继续按执行阶段恢复。`
          : `Tool "${tc.name}" is not exposed for the current ${runtimeIntent} runtime intent. Use an available tool; if this is approved plan execution, continue from the execution stage.`;
        callbacks.onToolError(tc.name, planned.target, message, { toolCallId: tc.id });
        allResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target: planned.target,
          content: `Error: ${message}`,
          isError: true,
          lifecycleState: "blocked",
        });
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
          const args = parsedCall ? parseToolCallArguments(parsedCall, workspace) : {};
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

    // Execute approved-by-user local file reads sequentially. These are read
    // tools, but the first access to each external path is intentionally
    // human-gated.
    for (const tc of localFileReadCalls) {
      const toolArgs = parseToolCallArguments(tc, workspace);
      const result = await executeLocalFileReadToolWithReview(
        tc,
        toolArgs,
        tc.localFileReadPath,
        workspace,
        callbacks,
        iterationAllTools,
        hooksConfig,
      );
      allResults.push(result);

      if (abortController.signal.aborted) {
        callbacks.onStatusChange("idle");
        return;
      }
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
      const resultArgs = toolArgsByCallId.get(result.toolCallId) ?? {};
      const targetingEvidenceKey = getTaskTargetingEvidenceKey(result.name, resultArgs, result.target);
      if (targetingEvidenceKey) {
        taskTargetingEvidence.add(targetingEvidenceKey);
      }
      if (unityConsoleDiagnosticsRequested && isUnityScriptWriteToolCall(result.name, resultArgs)) {
        unityConsoleFinalVerificationRequired = true;
        unityConsoleRefreshObservedAfterWrite = false;
      }
      if (unityConsoleDiagnosticsRequested && unityConsoleFinalVerificationRequired) {
        if (result.name === "refresh_unity") {
          unityConsoleRefreshObservedAfterWrite = true;
        } else if (result.name === "read_console" && unityConsoleRefreshObservedAfterWrite) {
          unityConsoleFinalVerificationRequired = false;
          unityConsoleRefreshObservedAfterWrite = false;
        }
      }

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

    let unityMcpFallbackPrompt: string | null = null;
    if (unityMcpForceConsoleFirstPending) {
      const readConsoleResult = allResults.find((result) => result.name === "read_console");
      if (!readConsoleResult) {
        const hasSuccessfulReadOnlyActivity = allResults.some(
          (result) => !result.isError && UNITY_FALLBACK_RECOVERY_READ_ONLY_TOOL_NAMES.has(result.name),
        );
        if (shouldRepromptBeforeUnityConsoleFallback({
          readConsoleCalled: false,
          hasSuccessfulReadOnlyActivity,
          repromptAlreadyIssued: unityConsoleMissingFirstToolRepromptIssued,
        })) {
          unityConsoleMissingFirstToolRepromptIssued = true;
          unityMcpFallbackPrompt = callbacks.getPreferredLanguage() === "zh"
            ? "你已经调用了可用工具，但这轮是 Unity console 诊断路径，仍缺少必需的 `read_console`。下一条请只输出一个标准 XML `<tool_use>` 调用 `read_console`（必要时先 `set_active_instance`），不要输出 `<tool_code>` 或过程说明。"
            : "You already called an available tool, but this Unity console diagnostics path still requires `read_console`. In the next reply, output exactly one standard XML `<tool_use>` call for `read_console` (use `set_active_instance` first only if required), with no `<tool_code>` wrapper and no process narration.";
        } else {
          activateUnityMcpFallback("forced_console_tool_not_called");
          unityMcpForceConsoleFirstPending = false;
          unityMcpFallbackPrompt = callbacks.getPreferredLanguage() === "zh"
            ? "Unity MCP 未按预期执行 read_console，本轮自动回退到本地诊断路径。请立即使用本地只读工具读取最相关日志并给出结论。"
            : "Unity MCP did not execute read_console as expected. This turn has been auto-fallbacked to local diagnostics. Use local read-only tools now and report findings.";
        }
      } else if (readConsoleResult.isError) {
        const failureCategory = extractMcpCallFailureCategory(readConsoleResult.content || "");
        if (failureCategory && ["unreachable", "route_mismatch", "session"].includes(failureCategory)) {
          activateUnityMcpFallback(`forced_console_call_failed:${failureCategory}`);
          unityMcpForceConsoleFirstPending = false;
          unityMcpFallbackPrompt = callbacks.getPreferredLanguage() === "zh"
            ? "Unity MCP 首轮 read_console 调用失败，已自动回退到本地诊断路径。请直接读取本地日志并给出报错定位。"
            : "Unity MCP read_console failed on the first pass, so the turn has auto-fallbacked to local diagnostics. Read local logs directly and provide error localization.";
        } else {
          unityMcpForceConsoleFirstPending = false;
        }
      } else {
        unityMcpForceConsoleFirstPending = false;
      }
    }

    allResults.forEach(rememberAnyToolActivity);
    const remainingTaskForDigest = callbacks.getPlanTasks().find((task) => !isPlanTaskTrustedComplete(task));
    if (callbacks.onExecutionDigestUpdate && allResults.length > 0) {
      const digest = buildExecutionDigest({
        language: callbacks.getPreferredLanguage(),
        turnIntent,
        toolResults: allResults,
        remainingTask: remainingTaskForDigest?.text,
      });
      if (digest) callbacks.onExecutionDigestUpdate(digest);
    }

    if (workflowMode === "plan") {
      allResults.forEach(rememberPlanToolActivity);
    }
    emitTaskOrchestratorPhase("EVIDENCE_RECONCILE", {
      iteration,
      results: allResults.length,
      successfulResults: allResults.filter((result) => !result.isError).length,
      evidenceKeys: [...taskTargetingEvidence].slice(-8),
    });

    const noProgressBatchSignature = buildNoProgressBatchSignature(allResults);
    if (noProgressBatchSignature) {
      if (noProgressBatchSignature === lastNoProgressBatchSignature) {
        noProgressBatchRepeatCount += 1;
      } else {
        lastNoProgressBatchSignature = noProgressBatchSignature;
        noProgressBatchRepeatCount = 1;
      }
    } else {
      lastNoProgressBatchSignature = "";
      noProgressBatchRepeatCount = 0;
    }

    if (noProgressBatchRepeatCount >= MAX_NO_PROGRESS_LOOP_REPEATS) {
      const remainingText = remainingTaskForDigest?.text || (
        callbacks.getPreferredLanguage() === "zh"
          ? "先重新核对当前目标与参数，再选择不同策略继续。"
          : "Recheck current targets and parameters, then continue with a different strategy."
      );
      logAgentEvent("loop_stop", {
        reason: "no_progress_batch_loop",
        iteration,
        repeats: noProgressBatchRepeatCount,
      });
      emitTaskOrchestratorPhase("PAUSED", {
        reason: "no_progress_batch_loop",
        iteration,
        repeats: noProgressBatchRepeatCount,
        remainingTask: remainingText,
      });
      callbacks.onNonActionableStop(
        callbacks.getPreferredLanguage() === "zh"
          ? [
              "执行已暂停：连续多轮工具结果没有实质变化。",
              "这通常意味着当前策略在原地重复，继续重试只会消耗上下文。",
              "",
              `建议下一步：${remainingText}`,
            ].join("\n")
          : [
              "Execution paused: consecutive tool batches showed no material progress.",
              "This usually means the current strategy is repeating in place and further retries will only consume context.",
              "",
              `Suggested next step: ${remainingText}`,
            ].join("\n"),
        "no_action",
      );
      callbacks.onStatusChange("idle");
      return;
    }

    for (const result of allResults) {
      const signature = toolFailureSignatures.get(result.toolCallId);
      if (!signature) continue;
      if (result.isError) {
        failedToolCallCounts.set(signature, (failedToolCallCounts.get(signature) ?? 0) + 1);
      } else {
        failedToolCallCounts.delete(signature);
      }
    }

    // Append all tool result messages
    for (const result of allResults) {
      const toolHistoryContent = buildToolResultHistoryContentByFormat(result, config.toolFeedbackFormat);
      callbacks.appendMessage({
        role: "tool",
        content: toolHistoryContent,
        tool_call_id: result.toolCallId,
      });
      emitTurnEvent({
        type: "item.completed",
        threadId: eventThreadId,
        turnId: eventTurnId,
        timestampMs: Date.now(),
        item: {
          id: result.toolCallId,
          details: {
            type: "tool_result",
            toolCallId: result.toolCallId,
            tool: result.name,
            target: result.target,
            status: inferLifecycleStateFromToolResult(result),
            text: result.displayContent || result.content,
          },
        } as MainThreadItem,
      });
      if (result.additionalContexts?.length) {
        createHookContextMessages("PostToolUse", result.additionalContexts)
          .forEach(message => callbacks.appendMessage(message));
      }
    }
    if (unityMcpFallbackPrompt) {
      callbacks.appendMessage({
        role: "user",
        content: unityMcpFallbackPrompt,
      });
    }

    if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && allResults.some(isSuccessfulPlanArtifactWriteResult)) {
      const currentStage = callbacks.getPlanStage();
      if (isReviewablePlanStage(currentStage)) {
        const reviewResult = await pauseForReviewablePlanArtifact("post_tool_plan_artifact_write");
        if (reviewResult === "approved_continue") continue;
        if (reviewResult === "stopped") return;
      } else {
        logAgentEvent("plan_artifact_write_not_reviewable_after_tool", {
          iteration,
          planStage: currentStage,
          targets: allResults
            .filter(isSuccessfulPlanArtifactWriteResult)
            .map((result) => result.target)
            .slice(0, 6),
        });
      }
    }

    if (workflowMode === "plan" && callbacks.getIsPlanApproved() && allResults.some((result) => !result.isError)) {
      callbacks.onPlanStageChanged("executing");
    }

    if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
      if (allResults.some((result) => result.isError)) {
        emitPlanExecutionProgress("tool_error");
      } else if (allResults.some((result) => !result.isError)) {
        emitPlanExecutionProgress("tool_done");
      }
    }

    // ── Strict Repeat Guard check ────────────────────────────────────
    // After each batch of tool calls, check for repetition loops
    let recoveredReadOnlyRepeat = false;
    for (const tc of effectiveToolCalls) {
      const toolArgs = parseToolCallArguments(tc, workspace);
      const autoExecutable = isToolAutoExecutableForCall(
        tc.name,
        toolArgs,
        toolCapabilityRegistry,
        config.toolPermissionPolicy,
        {
          workspace,
          approvedLocalFileReadPaths: callbacks.getApprovedLocalFileReadPaths(),
        },
      );
      const readOnlyShellInspection = isReadOnlyShellInspectionToolCall(tc.name, toolArgs);
      const repeatGuardReadOnly = autoExecutable || readOnlyShellInspection;
      const repeatCheck = registerToolCallForRepeatGuard(recentToolCalls, tc.name, toolArgs, repeatGuardReadOnly);
      if (!repeatCheck.repeated) continue;

      const target = getToolTarget(tc.name, toolArgs);
      if (repeatGuardReadOnly && (readOnlyShellInspection || !repeatGuardRecoveredSignatures.has(repeatCheck.signature))) {
        const recoveryMessage = formatRepeatLoopRecoveryMessage(tc.name, target, repeatCheck.threshold);
        if (!readOnlyShellInspection) {
          repeatGuardRecoveredSignatures.add(repeatCheck.signature);
        }
        recentToolCalls.length = 0;
        callbacks.onToolError(tc.name, target, recoveryMessage, { toolCallId: tc.id });
        callbacks.appendMessage({
          role: "system",
          content: `[System: ${recoveryMessage}]`,
        });
        recoveredReadOnlyRepeat = true;
        break;
      }

      const fatalMessage = formatRepeatLoopFatalMessage(tc.name, target, repeatCheck.threshold);
      const remainingTask = callbacks.getPlanTasks().find((task) => !isPlanTaskTrustedComplete(task));
      const defaultSuggestedNextTask = callbacks.getPreferredLanguage() === "zh"
        ? "先复用已成功结果，再继续下一个文件或不同目标"
        : "reuse successful results already in context, then continue with the next file or a different target";
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
            `- suggestedNextTask: ${remainingTask?.text || defaultSuggestedNextTask}`,
          ].join("\n")
        : [
            "RecoveryDetails:",
            `- duplicateTool: ${tc.name}`,
            `- target: ${target || "unknown"}`,
            `- duplicateCount: ${repeatCheck.threshold}+`,
            `- recentSuccessfulEvidence: ${recentEvidenceText}`,
            `- suggestedNextTask: ${remainingTask?.text || defaultSuggestedNextTask}`,
          ].join("\n");
      const recoveryHint = remainingTask
        ? callbacks.getPreferredLanguage() === "zh"
          ? `\nRecovery: 请开启新的恢复上下文，从证据未满足的任务继续：${remainingTask.text}`
          : `\nRecovery: start a fresh recovery context and continue from the first task with unsatisfied evidence: ${remainingTask.text}`
        : callbacks.getPreferredLanguage() === "zh"
        ? "\nRecovery: 请开启新的恢复上下文，先复用已成功结果，再继续下一个文件或不同目标。"
        : "\nRecovery: start a fresh recovery context, reuse successful results, then continue with the next file or a different target.";
      callbacks.onError(`${fatalMessage}\n${structuredRecovery}${recoveryHint}`);
      callbacks.onStatusChange("error");
      emitTurnFailedEvent(fatalMessage);
      return;
    }

    let recoveredTargetProgressLoop = false;
    if (!recoveredReadOnlyRepeat) {
      for (const tc of effectiveToolCalls) {
        const toolArgs = parseToolCallArguments(tc, workspace);
        const target = getShellMutationTargetForLoopGuard(tc.name, toolArgs) || getToolTarget(tc.name, toolArgs);
        const progressCheck = registerTargetProgressForLoopGuard(recentTargetToolCalls, tc.name, target);
        if (!progressCheck.repeated) continue;

        const recoveryMessage = formatTargetProgressLoopRecoveryMessage(
          progressCheck.family,
          target || progressCheck.targetKey,
          progressCheck.threshold,
        );
        if (!targetProgressGuardRecoveredSignatures.has(progressCheck.signature)) {
          targetProgressGuardRecoveredSignatures.add(progressCheck.signature);
          recentTargetToolCalls.length = 0;
          callbacks.onToolError(tc.name, target, recoveryMessage, { toolCallId: tc.id });
          callbacks.appendMessage({
            role: "system",
            content: `[System: ${recoveryMessage}]`,
          });
          recoveredTargetProgressLoop = true;
          break;
        }

        callbacks.onNonActionableStop(
          callbacks.getPreferredLanguage() === "zh"
            ? [
                "执行已暂停：检测到同一目标上的工具进展循环。",
                recoveryMessage,
                "请继续时先核查当前 workspace 状态，再选择不同策略或输出最终结果。",
              ].join("\n")
            : [
                "Execution paused: detected a tool progress loop on the same target.",
                recoveryMessage,
                "On resume, first inspect current workspace state, then choose a different strategy or output the final result.",
              ].join("\n"),
          "no_action",
        );
        callbacks.onStatusChange("idle");
        return;
      }
    }

    if (recoveredReadOnlyRepeat || recoveredTargetProgressLoop) {
      continue;
    }

    const shouldConvergeExecuteTurn =
      workflowMode === "edit" ||
      (workflowMode === "plan" && callbacks.getIsPlanApproved() && runtimeIntent === "execute");
    const convergencePromptRatio =
      workflowMode === "plan" && callbacks.getIsPlanApproved()
        ? PLAN_EXECUTE_CONVERGENCE_PROMPT_RATIO
        : EXECUTE_CONVERGENCE_PROMPT_RATIO;
    if (
      shouldConvergeExecuteTurn &&
      !usedExecuteConvergencePrompt &&
      iteration >= Math.max(8, Math.floor(effectiveMaxIterations * convergencePromptRatio))
    ) {
      usedExecuteConvergencePrompt = true;
      logAgentEvent("execute_convergence_prompt", {
        iteration,
        maxIterations: effectiveMaxIterations,
        recentToolActivity: recentToolActivity.length,
      });
      callbacks.appendMessage({
        role: "user",
        content: buildExecuteConvergencePrompt(callbacks.getPreferredLanguage(), iteration, effectiveMaxIterations),
      });
    }

    // Loop continues — the model sees all tool results and can respond
  }

  if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
    const checkpoint = buildPlanMaxIterationsCheckpoint({
      iterationCount: effectiveMaxIterations,
      maxIterations: effectiveMaxIterations,
      autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
      tasks: callbacks.getPlanTasks(),
      evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
      recentToolActivity: recentPlanToolActivity,
      lastAssistantText: lastAssistantTextForCheckpoint,
      unresolvedBlockers: [
        `Agent loop reached maximum iterations (${effectiveMaxIterations}) while plan execution was still active.`,
      ],
    });
    logAgentEvent("max_iterations_checkpoint", {
      workflowMode,
      iteration: effectiveMaxIterations,
      autoResumeCount: checkpoint.autoResumeCount,
      remainingTasks: checkpoint.remainingTasks.length,
      recentToolActivity: checkpoint.recentToolActivity.length,
    });
    emitPlanExecutionProgress(
      checkpoint.autoResumeCount < 1 ? "checkpoint" : "paused",
      {
        nextStep: checkpoint.autoResumeCount < 1
          ? callbacks.getPreferredLanguage() === "zh"
            ? "保存检查点并自动开启一次隐藏续跑"
            : "save checkpoint and start one hidden auto-resume"
          : callbacks.getPreferredLanguage() === "zh"
          ? "点击 Resume Execution 后从检查点继续"
          : "click Resume Execution to continue from checkpoint",
      },
    );
    callbacks.onStatusChange("idle");
    const handled = await callbacks.onPlanMaxIterationsCheckpoint?.(checkpoint);
    if (handled) return;
    callbacks.onError(buildPlanMaxIterationsPauseNotice(checkpoint, callbacks.getPreferredLanguage()));
    return;
  }

  if (workflowMode === "edit") {
    const checkpoint = buildPlanMaxIterationsCheckpoint({
      iterationCount: effectiveMaxIterations,
      maxIterations: effectiveMaxIterations,
      autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
      tasks: [],
      evidenceLedger: [],
      recentToolActivity,
      lastAssistantText: lastAssistantTextForCheckpoint,
      unresolvedBlockers: [
        `Agent loop reached maximum iterations (${effectiveMaxIterations}) while execute runtime was still active.`,
      ],
    });
    logAgentEvent("execute_max_iterations_checkpoint", {
      workflowMode,
      iteration: effectiveMaxIterations,
      autoResumeCount: checkpoint.autoResumeCount,
      recentToolActivity: checkpoint.recentToolActivity.length,
    });
    callbacks.onStatusChange("idle");
    const handled = await callbacks.onExecuteMaxIterationsCheckpoint?.(checkpoint);
    if (handled) return;
    callbacks.onNonActionableStop(
      buildExecuteMaxIterationsPauseNotice(checkpoint, callbacks.getPreferredLanguage()),
      "no_action",
    );
    return;
  }

  callbacks.onNonActionableStop(
    callbacks.getPreferredLanguage() === "zh"
      ? `本轮达到 ${effectiveMaxIterations} 轮安全边界，已停止在可恢复状态。`
      : `This turn reached the ${effectiveMaxIterations}-iteration safety boundary and stopped in a recoverable state.`,
    "no_action",
  );
  callbacks.onStatusChange("idle");
  emitTurnCompletedEvent();
}
