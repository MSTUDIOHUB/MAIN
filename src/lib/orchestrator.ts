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
  type OpenAiToolChoice,
  type StreamSettings,
  type StreamResult,
} from "./streaming";
import { type ToolDefinition } from "./toolSchemas";
import { executeTool } from "./toolExecutor";
import { estimateMessagesTokens, estimateTokens } from "./contextTrim";
import type { ContextMemoryState } from "./contextMemory";
import { generateId } from "./utils";
import {
  type MCPServer,
  type MCPTool,
} from "./mcpClient";
import { getFileMetadata, shellPermissionPreflight } from "./ipc";
import { buildToolDiffPreview, supportsToolDiffPreview, type ToolDiffPreview } from "./toolDiff";
import { preflightWorkspaceMutation } from "./workspaceMutationPreflight";
import { summarizeApplyPatchTarget } from "./applyPatchTool";
import { syncPlanArtifactAfterToolSuccess } from "./planArtifactSync";
import {
  buildReadFileWindowContinuationGuidance,
} from "./readFileWindow";
import {
  FILE_UNCHANGED_STUB,
  buildOptionalTasksMdMissingResult,
  isMissingOptionalTasksMdReadError,
  isOptionalTasksMdRead,
} from "./orchestrator/fileReadCache";
import {
  isReasoningDominatedLengthResult,
} from "./orchestrator/agentRecovery";
import {
  buildUnityApplyTextPolicyBlockedMessage,
  isUnityExecutionContext,
  resolveUnityScriptPathFromArgs,
} from "./orchestrator/unityDiagnostics";
import {
  buildPlanRecoveryPromptFromContext,
} from "./orchestrator/planOrchestration";

export {
  buildExecuteXmlTextActionRecoveryPrompt,
  buildPseudoToolCallRecoveryPrompt,
  extractPseudoToolCallName,
  isReasoningDominatedLengthResult,
  isReasoningDominatedNoActionResult,
  looksLikeNonStandardToolCallFormat,
  looksLikePseudoToolCallPlaceholder,
  recoverPseudoToolCallFromContext,
  shouldRecoverLanguageMismatchTurn,
  shouldRecoverExecuteXmlTextWithoutAction,
} from "./orchestrator/agentRecovery";
export {
  shouldRepromptBeforeUnityConsoleFallback,
  shouldTriggerUnityMcpFirstIterationFallback,
  shouldTriggerUnityMcpStrictRetry,
} from "./orchestrator/unityDiagnostics";
export {
  buildPlanReadOnlyConvergencePrompt,
} from "./orchestrator/planOrchestration";
import {
  type SessionAutoApproveScope,
  type ToolLifecycleState,
} from "./runtimeTools";
import type { AppConfig, Skill } from "../store/useAppStore";
import {
  buildPlanTaskEvidenceAudit,
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
  repairActionablePlanArtifactContent,
  validateActionablePlanArtifact,
  validatePlanArtifactContent,
  type PlanArtifactQualityResult,
  type PlanArtifactRecoveryAction,
  type PlanExecutionEvidenceEntry,
  type PlanExecutionProgressUpdate,
  type PlanRuntimePhase,
  type PlanTaskEvidenceAudit,
  type PlanTask,
  type ReplyOption,
} from "./workflowModels";
import type { MainModeKey } from "./mainModes";
import { type CommandDirective, type ResolvedUserIntent } from "./runIntent";
import {
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
  isReadOnlyShellInspectionToolCall,
  type TargetProgressOutcome,
} from "./repetitionGuard";
import {
  isUnityApplyTextPrecisePatchArgs,
  isLocalFileReadApproved,
} from "./toolCapabilities";
import {
  buildCompatibilityRetryMessages,
  extractCompatibilityTextContent,
  hasProviderNativeToolsDisabled,
} from "./providerCompatibility";
import {
  getModelInstructionProfile,
  normalizeCloudToolProtocol,
  normalizeLocalToolProtocol,
  resolveEffectiveCloudApiFormat,
  type CloudToolProtocol,
  type ModelReasoningMode,
} from "./cloudProtocol";
import { getErrorMessage } from "./errorUtils";
import { resolveProtocolPackageReadPath } from "./protocolPackages";
import { resolveStudioCompatToolArgs } from "./studioCompatPathResolver";
import { isCloudGatewayTimeoutMessage, isRetryableCloudErrorMessage } from "./cloudRetry";
import { buildPlanApprovalChoiceHint } from "./planControl";
import {
  type PlanMaxIterationsCheckpoint,
  type PlanToolActivitySummary,
} from "./planExecutionRecovery";
import {
  isApprovedPlanRecoveryToolName,
  isApprovedPlanSourceEditFirstToolName,
} from "./approvedPlanRecoveryTools";
import {
  type ExecuteRecoveryMode,
} from "./executeRecoveryTools";
import { validateShellToolContract } from "./toolExecutionContract";
import {
  formatToolFeedbackEnvelope,
  type ToolFeedbackStatus,
} from "./toolFeedbackEnvelope";
import {
  withEventSchema,
  type MainThreadEvent,
} from "./turnEvents";
import { normalizeToolCallForExecution } from "./toolCallNormalization";
import {
  composeReviewablePlanFromEvidence,
  materializePlanArtifactFromVisibleText,
  sanitizePlanEvidenceInput,
  type PlanEvidenceRecord,
  type PlanMaterializationSource,
} from "./planMaterialization";
import { formatToolPresentation } from "./toolPresentation";
import {
  buildPlanReadOnlyProgressNarration,
  buildToolCallsProgressNarration,
  type ProgressNarration,
} from "./progressNarration";
import { shouldUseRustProxyForLocalProvider } from "./localProviderRouting";
import type { ShellPermissionApproval, ShellPermissionDecision } from "./ipc";
import { resolveShellAutoApproval } from "./shellAutoApproval";
import {
  isPlanReadOnlyToolName,
} from "./planReadOnlyConvergence";
import {
  filterPlanToolNamesForRuntimePhase,
} from "./planRuntime";
import {
  extractPrimaryUserRequestText,
  normalizeTurnInputContextSignals,
  type TurnInputContextSignals,
} from "./turnIntake";

// ── Spec file auto-approval helpers ────────────────────────────────

const PRE_APPROVAL_PLAN_FILE_NAMES = new Set(["plan.md", "design.md"]);
const EXECUTION_PLAN_FILE_NAMES = new Set(["requirements.md", "plan.md", "tasks.md"]);
const PLAN_ARTIFACT_MUTATION_TOOLS = new Set(["write_file", "replace_in_file", "apply_patch"]);
export const PLAN_REPEAT_READ_LIMIT = 3;
export const PLAN_EXPLORATION_READ_ONLY_TOOLS = new Set([
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "web_search",
  "web_fetch",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "knowledge_search",
  "knowledge_get_excerpt",
  "get_file_outline",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);
export const WEB_RESEARCH_TOOL_NAMES = new Set(["web_search", "web_fetch"]);
export const KNOWLEDGE_TOOL_NAMES = new Set(["knowledge_search", "knowledge_get_excerpt"]);
const GLOBAL_CHAT_CONTEXT_READ_TOOL_NAMES = new Set([
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
]);
const GLOBAL_CHAT_ALWAYS_ALLOWED_TOOL_NAMES = new Set([
  ...WEB_RESEARCH_TOOL_NAMES,
  ...KNOWLEDGE_TOOL_NAMES,
]);
export const EXECUTION_VERIFICATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "execute_command",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

const MCP_EDIT_TOOL_NAMES = new Set(["script_apply_edits", "apply_text_edits", "manage_script", "create_script", "delete_script"]);
export const EDIT_PROGRESS_TOOL_NAMES = new Set([
  "write_file",
  "replace_in_file",
  "apply_patch",
  ...MCP_EDIT_TOOL_NAMES,
]);
const FORCE_CONTEXT_TEXT_CHARS = 60_000;
const FORCE_CONTEXT_TOOL_RESULT_CHARS = 35_000;
const FORCE_CONTEXT_TOOL_MESSAGE_COUNT = 12;
const FORCE_CONTEXT_TOOL_LOOP_INTERVAL = 6;
const CHAT_REPAIR_REQUEST_RE =
  /(?:找到|定位|排查|分析|检查|诊断|找出).{0,40}(?:问题|bug|错误|异常|故障|原因|root cause).{0,80}(?:修复|解决|修改|改掉|处理)|(?:修复|解决|修改|改掉|处理).{0,80}(?:问题|bug|错误|异常|故障)|\b(?:find|locate|diagnose|investigate|analy[sz]e).{0,60}(?:issue|bug|error|problem|root cause).{0,80}(?:fix|repair|patch|resolve)|\b(?:fix|repair|patch|resolve).{0,60}(?:issue|bug|error|problem)\b/i;

export function looksLikeRepairExecutionRequest(text: string): boolean {
  return CHAT_REPAIR_REQUEST_RE.test(String(text || "").replace(/\s+/g, " ").trim());
}

function getMessageContentText(content: AgentMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContentPart => part.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

export function hasPlanUserContextObservation(messages: AgentMessage[], latestAssistantText = ""): boolean {
  const assistantTexts = messages
    .filter((message) => message.role === "assistant")
    .map((message) => getMessageContentText(message.content))
    .concat(latestAssistantText)
    .join("\n");
  return /(?:截图观察|从截图(?:中)?(?:我)?观察到|图片中可见|图\s*\d|screenshot observations|screenshot shows|image shows|visible in the provided image)/i.test(assistantTexts);
}

export function filterPlanRuntimeToolDefinitionsForPhase(input: {
  tools: ToolDefinition[];
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  planRuntimePhase?: PlanRuntimePhase;
  allowDraftingRecoveryRead?: boolean;
}): ToolDefinition[] {
  const names = new Set(filterPlanToolNamesForRuntimePhase({
    toolNames: input.tools.map((tool) => tool.function.name),
    workflowMode: input.workflowMode,
    isPlanApproved: input.isPlanApproved,
    planRuntimePhase: input.planRuntimePhase,
    allowDraftingRecoveryRead: input.allowDraftingRecoveryRead,
  }));
  if (names.size === input.tools.length) return input.tools;
  return input.tools.filter((tool) => names.has(tool.function.name));
}

export function filterGlobalChatToolDefinitions(input: {
  tools: ToolDefinition[];
  workspace: string;
  userContext: TurnInputContextSignals;
}): ToolDefinition[] {
  if (input.workspace.trim()) return input.tools;

  const hasExplicitFileContext =
    input.userContext.mentionedFilePaths.length > 0 ||
    input.userContext.attachedFilePaths.length > 0;

  return input.tools.filter((tool) => {
    const name = tool.function.name;
    if (GLOBAL_CHAT_ALWAYS_ALLOWED_TOOL_NAMES.has(name)) return true;
    return hasExplicitFileContext && GLOBAL_CHAT_CONTEXT_READ_TOOL_NAMES.has(name);
  });
}

export function planUnsupportedToolFeedbackMessage(input: {
  language: "zh" | "en";
  toolName: string;
  runtimeIntent: ResolvedUserIntent;
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  planRuntimePhase?: PlanRuntimePhase;
  availableToolNames: string[];
}): string {
  if (input.workflowMode === "plan" && !input.isPlanApproved) {
    const phase = input.planRuntimePhase || "grounding";
    const readOnly = isPlanReadOnlyToolName(input.toolName);
    if (phase === "explore_structure" && input.toolName !== "get_project_skeleton") {
      return input.language === "zh"
        ? `PLAN_EXPLORE_STRUCTURE_TOOL_BLOCKED: 当前是 Explore project structure 阶段，只允许一次浅层 get_project_skeleton(depth: 2)。完成项目结构探索后再进入定向读取。`
        : `PLAN_EXPLORE_STRUCTURE_TOOL_BLOCKED: The current phase is Explore project structure, so only one shallow get_project_skeleton(depth: 2) call is available. Targeted reads open after the structure pass.`;
    }
    if (phase === "drafting" || phase === "synthesis" || phase === "needs_rewrite" || phase === "review_ready" || phase === "blocked") {
      return input.language === "zh"
        ? `PLAN_DRAFTING_TOOL_BLOCKED: 当前处于 ${phase} 阶段，只允许创建或更新 .MAIN/plans/plan.md。不要继续调用 ${input.toolName}；请基于已有证据用 write_file 或 replace_in_file 写入可审批计划文件。`
        : `PLAN_DRAFTING_TOOL_BLOCKED: The current phase is ${phase}, so only creating or updating .MAIN/plans/plan.md is allowed. Do not call ${input.toolName}; use write_file or replace_in_file to write the reviewable plan from existing evidence.`;
    }
    if ((phase === "grounding" || phase === "needs_evidence" || phase === "explore_structure") && !readOnly) {
      return input.language === "zh"
        ? `PLAN_GROUNDING_TOOL_BLOCKED: 当前处于 ${phase} 阶段，只允许截图/附件观察和最小定向只读证据工具。不要调用 ${input.toolName}；先补足事实，再进入 plan.md 草稿。`
        : `PLAN_GROUNDING_TOOL_BLOCKED: The current phase is ${phase}, so only observation and minimal read-only evidence tools are available. Do not call ${input.toolName}; gather facts first, then draft plan.md.`;
    }
  }

  if (input.toolName === "read_file" && !input.availableToolNames.includes("read_file")) {
    const alternatives = ["grep_search", "get_file_outline", "get_project_skeleton", "glob_search"]
      .filter((name) => input.availableToolNames.includes(name));
    const alternativesText = alternatives.length > 0 ? alternatives.join(", ") : input.language === "zh" ? "已缓存上下文" : "cached context";
    return input.language === "zh"
      ? `READ_FILE_NOT_AVAILABLE_IN_RECOVERY: read_file 在当前 ${input.runtimeIntent} 恢复步骤没有开放。请不要改用 shell/cat/sed/head/tail 读取文件；改用 ${alternativesText}，或直接基于已有缓存上下文进入 patch/验证/最终说明。`
      : `READ_FILE_NOT_AVAILABLE_IN_RECOVERY: read_file is not exposed in the current ${input.runtimeIntent} recovery step. Do not switch to shell/cat/sed/head/tail file reads; use ${alternativesText}, or proceed from cached context to patching, validation, or the final answer.`;
  }

  return input.language === "zh"
    ? `工具 "${input.toolName}" 当前没有暴露给 ${input.runtimeIntent} 运行意图。请使用本轮可用工具；如果这是已批准计划的执行步骤，请继续按执行阶段恢复。`
    : `Tool "${input.toolName}" is not exposed for the current ${input.runtimeIntent} runtime intent. Use an available tool; if this is approved plan execution, continue from the execution stage.`;
}

export function computeContextForceReason(input: {
  messages: AgentMessage[];
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  inputBudget?: number;
  proactiveTriggerBudget?: number;
}): {
  shouldForce: boolean;
  reason: string | null;
  textChars: number;
  toolChars: number;
  toolMessages: number;
  estimatedTokens: number;
  tokenPressure: number;
} {
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

  const estimatedTokens = estimateMessagesTokens(input.messages);
  const fallbackInputBudget = Math.max(2048, Math.ceil((textChars + 1) / 3));
  const inputBudget = Math.max(1, Math.floor(input.inputBudget || fallbackInputBudget));
  const triggerBudget = Math.max(1, Math.floor(input.proactiveTriggerBudget || inputBudget * 0.92));
  const tokenPressure = estimatedTokens / triggerBudget;
  const scaledTextChars = Math.max(FORCE_CONTEXT_TEXT_CHARS, Math.floor(triggerBudget * 3.2));
  const scaledToolChars = Math.max(FORCE_CONTEXT_TOOL_RESULT_CHARS, Math.floor(triggerBudget * 2.4));

  const result = (shouldForce: boolean, reason: string | null) => ({
    shouldForce,
    reason,
    textChars,
    toolChars,
    toolMessages,
    estimatedTokens,
    tokenPressure,
  });

  if (estimatedTokens >= triggerBudget) {
    return result(true, "token_budget_threshold");
  }
  if (textChars >= scaledTextChars && tokenPressure >= 0.65) {
    return result(true, "text_chars_threshold");
  }
  if (toolChars >= scaledToolChars && tokenPressure >= 0.65) {
    return result(true, "tool_chars_threshold");
  }
  if (toolMessages >= FORCE_CONTEXT_TOOL_MESSAGE_COUNT * 2 && tokenPressure >= 0.6) {
    return result(true, "tool_message_threshold");
  }
  if (toolMessages >= FORCE_CONTEXT_TOOL_MESSAGE_COUNT && tokenPressure >= 0.8) {
    return result(true, "tool_message_threshold");
  }
  if (
    input.workflowMode === "plan" &&
    input.isPlanApproved &&
    input.iteration > 1 &&
    input.iteration % FORCE_CONTEXT_TOOL_LOOP_INTERVAL === 0 &&
    (tokenPressure >= 0.55 || toolChars >= Math.floor(scaledToolChars * 0.75))
  ) {
    return result(true, "approved_plan_loop_interval");
  }
  return result(false, null);
}

export function getSessionTaskTargetingEvidence(sessionKey: string): Set<string> {
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

export function isPreApprovalPlanDraftWrite(name: string, args: Record<string, unknown>): boolean {
  const target = getPlanArtifactMutationTarget(name, args);
  return !!target && PRE_APPROVAL_PLAN_FILE_NAMES.has(target.fileName);
}

export function isExecutionPlanArtifactWrite(name: string, args: Record<string, unknown>): boolean {
  const target = getPlanArtifactMutationTarget(name, args);
  return !!target && EXECUTION_PLAN_FILE_NAMES.has(target.fileName);
}

export function isTasksPlanWrite(name: string, args: Record<string, unknown>): boolean {
  const target = getPlanArtifactMutationTarget(name, args);
  return !!target && target.fileName === "tasks.md";
}

function isEphemeralPlanArtifactMutation(name: string, args: Record<string, unknown>): boolean {
  if (!PLAN_ARTIFACT_MUTATION_TOOLS.has(name)) return false;
  return isEphemeralPlanArtifactPath((args.path as string) || "");
}

export function isPlanArtifactPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().includes(".main/plans/");
}

export function emitToolPreflightBlocked(
  callbacks: OrchestratorCallbacks,
  input: {
    reason: string;
    tool: string;
    target: string;
    message: string;
    toolCallId?: string;
    lifecycleState?: ToolLifecycleState;
  },
): void {
  const payload = {
    reason: input.reason,
    tool: input.tool,
    target: input.target || null,
    message: compactDiagnosticText(input.message),
    toolCallId: input.toolCallId || null,
    lifecycleState: input.lifecycleState || "blocked",
  };
  logAgentEvent("tool_preflight_blocked", payload);
  callbacks.onDebugEvent?.("agent.tool_preflight_blocked", payload);
}

export function isProjectSourceWriteResult(result: ToolExecutionResult): boolean {
  return (
    !result.isError &&
    EDIT_PROGRESS_TOOL_NAMES.has(result.name) &&
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
  if (name === "get_project_skeleton" || name === "glob_search" || name === "grep_search" || name.startsWith("repo_map_")) {
    evidence.add("workspace:structure");
    if (name === "grep_search") {
      const text = `${result.content || ""}\n${result.displayContent || ""}`;
      const fileMatches = text.matchAll(/(?:^|\n)\s*([^\n:]+?\.(?:ts|tsx|js|jsx|rs|py|go|css|scss|html|json|md|toml|yaml|yml|cs|cpp|c|h|hpp|java|kt|swift|vue|svelte))(?::\d+)?(?::|\s|$)/gi);
      for (const match of fileMatches) {
        const filePath = String(match[1] || "").trim();
        if (filePath && !filePath.includes(" ")) {
          evidence.add(`file:${normalizeEvidencePath(filePath)}`);
        }
      }
    }
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

function rebuildReadBeforeModifyEvidenceFromHistory(
  sessionKey: string,
  messages: AgentMessage[],
): void {
  const evidence = getSessionReadBeforeModifyEvidence(sessionKey);
  const toolCallMap = new Map<string, { name: string; path: string }>();

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const call = tc as { id?: string; function?: { name?: string; arguments?: string } };
        if (call.id && call.function?.name && call.function.arguments) {
          try {
            const parsed = JSON.parse(call.function.arguments);
            const name = call.function.name;
            let path = "";
            if (typeof parsed.path === "string") {
              path = parsed.path.trim();
            } else if (typeof parsed.TargetFile === "string") {
              path = parsed.TargetFile.trim();
            }
            if (path) {
              toolCallMap.set(call.id, { name, path });
            }
          } catch {
            // Ignore JSON parsing issues
          }
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      const callInfo = toolCallMap.get(msg.tool_call_id);
      if (callInfo) {
        const name = callInfo.name;
        const path = callInfo.path;
        const text = getMessageContentText(msg.content);
        const isError =
          text.startsWith("Error:") ||
          text.startsWith("system_error:") ||
          text.startsWith("TASK_TARGETING_BLOCKED:") ||
          text.startsWith("PLAN_GROUNDING_TOOL_BLOCKED:") ||
          text.startsWith("PLAN_DRAFTING_TOOL_BLOCKED:") ||
          text.startsWith("PLAN_EXPLORE_STRUCTURE_TOOL_BLOCKED:") ||
          text.startsWith("READ_FILE_NOT_AVAILABLE_IN_RECOVERY:");
        const isPruned =
          text.includes("Historical read content") &&
          text.includes("removed");

        if (!isError || isPruned) {
          if (name === "read_file" || name === "get_file_outline" || name === "read_document") {
            evidence.add(`file:${normalizeEvidencePath(path)}`);
          } else if (name === "list_directory") {
            evidence.add(`dir:${normalizeEvidencePath(path) || "."}`);
          } else if (
            name === "get_project_skeleton" ||
            name === "glob_search" ||
            name === "grep_search" ||
            name.startsWith("repo_map_")
          ) {
            evidence.add("workspace:structure");
            if (name === "grep_search") {
              const fileMatches = text.matchAll(
                /(?:^|\n)\s*([^\n:]+?\.(?:ts|tsx|js|jsx|rs|py|go|css|scss|html|json|md|toml|yaml|yml|cs|cpp|c|h|hpp|java|kt|swift|vue|svelte))(?::\d+)?(?::|\s|$)/gi
              );
              for (const match of fileMatches) {
                const filePath = String(match[1] || "").trim();
                if (filePath && !filePath.includes(" ")) {
                  evidence.add(`file:${normalizeEvidencePath(filePath)}`);
                }
              }
            }
          }
        }
      }
    }
  }
}

export async function buildReadBeforeModifyValidationError(
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

  const messages = callbacks.getMessages();
  rebuildReadBeforeModifyEvidenceFromHistory(callbacks.getSessionKey(), messages);

  const path = typeof args.path === "string" ? args.path : "";
  if (!path || isPlanArtifactPath(path)) return null;

  const target = getToolTarget(tc.name, args);
  const normalizedPath = normalizeEvidencePath(path);
  const evidence = getSessionReadBeforeModifyEvidence(callbacks.getSessionKey());
  if (callbacks.getWorkspaceTree().trim()) {
    evidence.add("workspace:structure");
  }
  const hasExactRead = evidence.has(`file:${normalizedPath}`);
  const hasParentRead = evidence.has(`dir:${getParentEvidencePath(path)}`) || evidence.has("workspace:structure");

  let existingFile = tc.name === "replace_in_file";
  let metadata: { path: string; sizeBytes: number; modifiedMs: number } | null = null;
  if (tc.name === "write_file") {
    metadata = await readFileMetadataIfAvailable(path, workspace);
    existingFile = !!metadata;
  }

  // 1. Write File Size-Gate Check
  if (tc.name === "write_file" && metadata && metadata.sizeBytes > 8192) {
    const language = callbacks.getPreferredLanguage();
    const message = language === "zh"
      ? `WRITE_FILE_GATE_BLOCKED: 文件 ${path} 已存在且体量较大 (大小: ${(metadata.sizeBytes / 1024).toFixed(1)}KB)。为节省关键上下文 Token 预算，禁止全量 write_file 重写现有大文件。你必须改用 replace_in_file 或 apply_patch 提交精确的局部 diff 修改。`
      : `WRITE_FILE_GATE_BLOCKED: The file ${path} already exists and is large (${(metadata.sizeBytes / 1024).toFixed(1)}KB). To conserve context token budget, full-text write_file is blocked for large existing files. You MUST use replace_in_file or apply_patch to supply a precise diff.`;
    callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
    emitToolPreflightBlocked(callbacks, {
      reason: "write_file_gate_blocked",
      tool: tc.name,
      target,
      message,
      toolCallId: tc.id,
      lifecycleState: "blocked",
    });
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

  if (!existingFile && hasParentRead) return null;
  if (hasExactRead) return null;

  const language = callbacks.getPreferredLanguage();
  const message = language === "zh"
    ? existingFile
      ? `READ_BEFORE_MODIFY_BLOCKED: 修改 ${path} 前必须先读取该文件。请先调用 read_file 或 get_file_outline 获取当前内容/结构，再重试写入。`
      : `READ_BEFORE_MODIFY_BLOCKED: 创建 ${path} 前需要先检查目标目录或项目结构。请先调用 get_project_skeleton 或 list_directory，再重试写入。`
    : existingFile
    ? `READ_BEFORE_MODIFY_BLOCKED: Read ${path} before modifying it. Call read_file or get_file_outline first, then retry the write.`
    : `READ_BEFORE_MODIFY_BLOCKED: Inspect the target directory or project structure before creating ${path}. Call get_project_skeleton or list_directory first, then retry the write.`;
  callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
  emitToolPreflightBlocked(callbacks, {
    reason: "read_before_modify_blocked",
    tool: tc.name,
    target,
    message,
    toolCallId: tc.id,
    lifecycleState: "blocked",
  });
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

/**
 * Intercept and block file reads via shell commands to prevent context flooding.
 */
function normalizeShellReadSegment(segment: string): string {
  return String(segment || "")
    .trim()
    .replace(/^\(\s*/, "")
    .replace(/\s*\)$/, "")
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "")
    .replace(/^(?:command|builtin)\s+/, "")
    .trim();
}

function isDirectoryOnlyShellSegment(segment: string): boolean {
  return /^(?:cd|pushd|popd)\b/i.test(segment);
}

function shellSegmentWords(segment: string): string[] {
  return String(segment || "").match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) =>
    word.replace(/^(['"])(.*)\1$/, "$2")
  ) || [];
}

function catHeadTailSegmentHasFileOperand(command: string, args: string[]): boolean {
  const normalizedCommand = command.toLowerCase();
  let skipNextOptionValue = false;
  for (const arg of args) {
    if (!arg) continue;
    if (skipNextOptionValue) {
      skipNextOptionValue = false;
      continue;
    }
    if (arg === "--") return args.indexOf(arg) < args.length - 1;
    if (normalizedCommand !== "cat" && /^(?:-n|-c|--lines|--bytes)$/.test(arg)) {
      skipNextOptionValue = true;
      continue;
    }
    if (normalizedCommand !== "cat" && /^(?:--lines=|--bytes=)/.test(arg)) continue;
    if (normalizedCommand !== "cat" && /^-\d+$/.test(arg)) continue;
    if (/^-/.test(arg)) continue;
    return true;
  }
  return false;
}

function sedSegmentHasFileOperand(args: string[]): boolean {
  let consumedScript = false;
  let skipNextScriptArg = false;
  for (const arg of args) {
    if (!arg) continue;
    if (skipNextScriptArg) {
      skipNextScriptArg = false;
      consumedScript = true;
      continue;
    }
    if (arg === "--") continue;
    if (/^(?:-e|-f)$/.test(arg)) {
      skipNextScriptArg = true;
      continue;
    }
    if (/^(?:-e|-f).+/.test(arg)) {
      consumedScript = true;
      continue;
    }
    if (/^-/.test(arg)) continue;
    if (!consumedScript) {
      consumedScript = true;
      continue;
    }
    return true;
  }
  return false;
}

function isShellFileReadSegment(segment: string): boolean {
  const normalized = normalizeShellReadSegment(segment);
  if (!normalized || isDirectoryOnlyShellSegment(normalized)) return false;
  const [command = "", ...args] = shellSegmentWords(normalized);
  if (/^(?:cat|head|tail)$/i.test(command)) {
    return catHeadTailSegmentHasFileOperand(command, args);
  }
  if (/^sed$/i.test(command)) {
    return sedSegmentHasFileOperand(args);
  }
  return false;
}

export function isShellFileReadCommand(command: string): boolean {
  const raw = String(command || "").trim();
  if (!raw) return false;
  return raw
    .split(/\s*(?:&&|\|\||;|\|)\s*/g)
    .map(normalizeShellReadSegment)
    .filter(Boolean)
    .some(isShellFileReadSegment);
}

export function buildShellReadValidationError(
  tc: ToolCallToExecute,
  args: Record<string, unknown>,
  callbacks: OrchestratorCallbacks,
): ToolExecutionResult | null {
  if (tc.name !== "run_command" && tc.name !== "execute_command") return null;
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return null;

  const isShellRead = isShellFileReadCommand(command);
  if (isShellRead) {
    const language = callbacks.getPreferredLanguage();
    const message = language === "zh"
      ? `SHELL_READ_FORBIDDEN: 禁止通过终端命令 (${command}) 直接读取文件内容以防止上下文过载。read_file 可用时请使用 read_file + start_line/max_lines；恢复模式未开放 read_file 时，请使用 grep_search/get_file_outline 或基于已有缓存直接 patch/验证/最终说明，不要改用 cat/sed/head/tail 绕行。`
      : `SHELL_READ_FORBIDDEN: Reading files via terminal commands (${command}) is disabled to prevent context overload. Use read_file with start_line/max_lines when available; if recovery mode has not exposed read_file, use grep_search/get_file_outline or proceed from cached context to patching, validation, or the final answer instead of cat/sed/head/tail.`;
    const target = getToolTarget(tc.name, args);
    callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
    emitToolPreflightBlocked(callbacks, {
      reason: "shell_read_forbidden",
      tool: tc.name,
      target,
      message,
      toolCallId: tc.id,
      lifecycleState: "blocked",
    });
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
  return null;
}

/**
 * Detect repetitive read/write loops on the same file path and enforce a circuit-breaker.
 */
export function buildLoopDetectionValidationError(
  tc: ToolCallToExecute,
  args: Record<string, unknown>,
  callbacks: OrchestratorCallbacks,
): ToolExecutionResult | null {
  if (tc.name !== "write_file" && tc.name !== "replace_in_file" && tc.name !== "read_file") return null;

  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return null;

  const messages = callbacks.getMessages();
  const currentTurnMessages: AgentMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") break;
    currentTurnMessages.unshift(msg);
  }

  const successfulToolResultsByCallId = new Map<string, boolean>();
  for (const msg of currentTurnMessages) {
    if (msg.role !== "tool") continue;
    const toolCallId = typeof (msg as { tool_call_id?: unknown }).tool_call_id === "string"
      ? String((msg as { tool_call_id?: unknown }).tool_call_id)
      : "";
    if (!toolCallId) continue;
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    successfulToolResultsByCallId.set(
      toolCallId,
      !/^\s*Error:|"\s*status\s*"\s*:\s*"(?:failed|blocked|declined)"|"\s*isError\s*"\s*:\s*true|LOOP_DETECTED|REPEATED_FAILURE_BLOCKED/i.test(content),
    );
  }

  const samePathCalls: Array<{ name: string; id?: string; order: number; successful: boolean }> = [];
  currentTurnMessages.forEach((msg, order) => {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const c = call as { id?: string; function?: { name?: string; arguments?: string } };
        if (c.function?.name === "write_file" || c.function?.name === "replace_in_file" || c.function?.name === "read_file") {
          if (c.id === tc.id) continue;
          try {
            const parsed = JSON.parse(c.function.arguments || "{}");
            const parsedPath = String(parsed.path || parsed.TargetFile || "").trim();
            if (parsedPath === path) {
              samePathCalls.push({
                name: c.function.name,
                id: c.id,
                order,
                successful: c.id ? successfulToolResultsByCallId.get(c.id) !== false : true,
              });
            }
          } catch {
            // Ignore malformed JSON
          }
        }
      }
    }
  });

  const repetitions = samePathCalls.length;
  if (repetitions >= 5) {
    const target = getToolTarget(tc.name, args);
    if (tc.name === "read_file") {
      const successfulMutations = samePathCalls
        .filter((call) => (call.name === "write_file" || call.name === "replace_in_file") && call.successful);
      const latestSuccessfulMutation = successfulMutations[successfulMutations.length - 1];
      const readsAfterLatestMutation = latestSuccessfulMutation
        ? samePathCalls.filter((call) => call.name === "read_file" && call.order > latestSuccessfulMutation.order).length
        : Number.POSITIVE_INFINITY;
      if (latestSuccessfulMutation && readsAfterLatestMutation === 0) return null;

      const language = callbacks.getPreferredLanguage();
      const message = language === "zh"
        ? [
            `READ_FILE_REPEAT_LIMIT: ${path} 已在当前回合被重复读取/修改多次，本次 read_file 不再重新读取。`,
            "请复用已有缓存内容；read_file 仍开放时，只能改用 start_line/end_line/max_lines 读取真正缺失的窗口。",
            "如果本轮工具面已经关闭 read_file，请改用 grep_search/get_file_outline，或基于已有上下文直接 patch/验证/最终说明；不要用 shell cat/sed/head/tail 绕过。",
            "如果已有上下文不足以继续，请在正文中说明缺失信息和阻塞点，不要原样重试。",
          ].join("\n")
        : [
            `READ_FILE_REPEAT_LIMIT: ${path} has already been read/edited repeatedly in this turn, so this read_file call was not re-run.`,
            "Reuse cached content; when read_file is still exposed, only narrow the next request with start_line/end_line/max_lines for a genuinely missing window.",
            "If the current tool surface has closed read_file, switch to grep_search/get_file_outline, or proceed from existing context to patching, validation, or the final answer; do not bypass this with shell cat/sed/head/tail.",
            "If the available context is insufficient, explain the missing information and blocker in prose instead of retrying the same call.",
          ].join("\n");
      callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
      emitToolPreflightBlocked(callbacks, {
        reason: "read_file_repeat_limit",
        tool: tc.name,
        target,
        message,
        toolCallId: tc.id,
        lifecycleState: "completed",
      });
      callbacks.onToolDone(tc.name, target, message, { toolCallId: tc.id });
      return {
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: message,
        isError: false,
        lifecycleState: "completed",
      };
    }

    const language = callbacks.getPreferredLanguage();
    const message = language === "zh"
      ? `LOOP_DETECTED: 检测到你在文件 ${path} 上执行了多次重复的读取/修改操作。为防止死循环，本次调用已拦截。请暂停并在正文中解释为什么之前的改动未能成功应用（如编译错误或环境问题），然后使用 <user_options> 请用户确认方向。`
      : `LOOP_DETECTED: Detected multiple repetitive read/write operations on ${path}. To prevent an infinite execution loop, this call has been blocked. Please pause and explain in prose why previous edits failed (e.g. build errors or environment issues), then use <user_options> to ask the user for guidance.`;
    callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
    emitToolPreflightBlocked(callbacks, {
      reason: "loop_detected",
      tool: tc.name,
      target,
      message,
      toolCallId: tc.id,
      lifecycleState: "blocked",
    });
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

  return null;
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

export function computeManagedContextLimit(contextLimit: number, tools: ToolDefinition[], extraMargin: number = 0): number {
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
  reasoning_content?: string;
  reasoning?: string;
}

export function buildAssistantHistoryMessage(
  content: string,
  providerReasoning?: Pick<StreamResult, "reasoningContent" | "reasoningField"> | null,
  extra: Partial<Pick<AgentMessage, "tool_calls">> = {},
): AgentMessage {
  void providerReasoning;
  return {
    role: "assistant",
    content,
    ...extra,
  };
}

export function truncateForLog(value: string, maxLength = 96): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength).trim()}...`;
}

export function summarizeReplyOptionsForLog(replyOptions: ReplyOption[], limit = 4) {
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
  getWebSearchEnabled?: () => boolean;
  getWebSearchProvider?: () => string;
  getEnabledKnowledgeBaseIds?: () => string[];
  getAssociatedPaths: () => string[];
  getSessionKey: () => string;
  getCurrentTurnId?: () => string | null;
  hasSessionHookInitialized: (sessionKey: string) => boolean;
  markSessionHookInitialized: (sessionKey: string) => void;
  // Planning & Management
  getCurrentRunIntent: () => ResolvedUserIntent;
  getRuntimeRunIntent?: () => ResolvedUserIntent;
  getForcedExecuteRecoveryMode?: () => ExecuteRecoveryMode | null;
  getCommandDirective?: () => CommandDirective | null;
  getWorkflowMode: () => "chat" | "edit" | "plan";
  getIsPlanApproved: () => boolean;
  getPlanApprovalChoice: () => string | null;
  getReadOnlyAutoApproveForSession: () => boolean;
  getApprovedLocalFileReadPaths: () => string[];
  getAutoApproveToolScopes?: () => SessionAutoApproveScope[];
  getPlanStage: () => "idle" | "plan" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed";
  getPlanTasks: () => PlanTask[];
  getPlanExecutionEvidenceLedger: () => PlanExecutionEvidenceEntry[];
  getPlanAutoResumeCount?: () => number;
  getStatus: () => "idle" | "running" | "pending_review" | "error";
  consumeActiveGuidance?: () => { id: string; text: string; turnId: string | null } | null;
  startNewTurn: () => void;
  getContextMemoryState?: () => ContextMemoryState | null;
  shouldForceXmlForProviderCompatibility?: () => boolean;
  onProviderCompatibilityFallback?: (reason: string) => void;
  onProviderNativeToolSuccess?: () => void;
  onDebugEvent?: (event: string, data?: Record<string, unknown>) => void;

  // UI updates
  onStreamToken: (token: string, messageId: string) => void;
  onStreamDone: (
    fullText: string,
    messageId: string,
    truncated: boolean,
    meta?: { suppressTruncationWarning?: boolean; reason?: string },
  ) => void;
  onThought: (thought: string) => void;
  onAssistantFinalText: (
    text: string,
    replyOptions?: ReplyOption[],
    meta?: {
      hasToolCalls?: boolean;
      hiddenThought?: string;
      visibility?: "user_progress" | "hidden_process" | "substantive_plan_text";
      preserveAssistantText?: boolean;
      capsuleCandidate?: boolean;
      modelAuthored?: boolean;
      progress?: ProgressNarration;
      toolCalls?: Array<{ id?: string; name: string; target: string }>;
    },
  ) => void;
  onStatusChange: (status: "idle" | "running" | "pending_review" | "error") => void;
  onError: (error: string) => void;
  onNonActionableStop: (
    message: string,
    reason: "no_output" | "no_action" | "missing_tool_loop" | "incomplete_plan",
    progress?: Partial<PlanExecutionProgressUpdate>,
  ) => void;
  onPlanArtifactUpdated: (path: string, content: string, kind: "plan" | "requirements" | "design" | "tasks" | "bugfix") => void;
  onPlanStageChanged: (stage: "idle" | "plan" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed") => void;
  onPlanTasksUpdated: (content: string) => void;
  onPlanExecutionProgress?: (progress: PlanExecutionProgressUpdate) => void;
  onApprovedPlanHandoff?: (prompt: string) => void;
  onPlanMaxIterationsCheckpoint?: (checkpoint: PlanMaxIterationsCheckpoint) => boolean | Promise<boolean>;
  onExecuteMaxIterationsCheckpoint?: (checkpoint: PlanMaxIterationsCheckpoint) => boolean | Promise<boolean>;
  onTurnSummaryReady: (summary: string) => void;
  onExecutionDigestUpdate?: (summary: string) => void;
  onTurnRuntimePhaseChanged?: (phase: {
    id: string;
    kind: "scope" | "context" | "diagnosis" | "implementation" | "validation";
    title: string;
    summary?: string;
    domain?: string;
    status?: "pending" | "running" | "done" | "failed";
  }) => void;
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
    reason: "proactive" | "reactive" | "execute_recovery",
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
    meta?: { toolCallId?: string; diff?: ToolDiffPreview },
  ) => void;
  onToolError: (
    toolName: string,
    target: string,
    error: string,
    meta?: { toolCallId?: string; qualityGateReason?: string | null; planRecoveryReason?: string | null },
  ) => void;

  // Human-in-the-loop — only for write/execute tools.
  // Read-only tools are auto-executed by the orchestrator.
  requestReview: (toolCall: {
    toolCallId?: string;
    name: string;
    arguments: Record<string, unknown>;
    risk?: "local_file_read" | "browser_control";
    localFileReadPath?: string;
    shellPermissionDecision?: ShellPermissionDecision;
  }) => Promise<ReviewDecision>;
}

// ── Helpers ───────────────────────────────────────────────────────

export function deriveStreamSettings(config: AppConfig): StreamSettings {
  if (config.activeProfile === "local") {
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
      // Ollama 原生端点保留前端直连；配置成 /v1 时也走后端代理。
      useRustProxy: shouldUseRustProxyForLocalProvider(config.local.provider, config.local.endpoint),
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
    reasoningEffort: config.cloud.reasoningEffort ?? "none",
    toolProtocol: normalizeCloudToolProtocol(config.cloud.toolProtocol),
    // Cloud profile should not inherit the local KV-cache/context limit.
    contextLimit: undefined,
    provider: config.cloud.provider,
    useRustProxy: true,  // Route through Rust to bypass WebView CORS
  };
}

export function resolveEffectiveToolProtocol(config: AppConfig, settings: StreamSettings) {
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
  reasoning: ModelReasoningMode;
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
    if (toolProtocol === "auto" && /gemma/.test(model.toLowerCase())) {
      toolProtocol = "xml";
    }
    if (input.compatibilityOverride === true) toolProtocol = "xml";
    if (input.compatibilityOverride === false && toolProtocol === "xml" && providerLower.includes("omlx") && configured !== "xml" && !/gemma/.test(model.toLowerCase())) {
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

export function shouldUseXmlToolProtocol(
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

export function prepareMessagesForToolProtocol(
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
export function getToolTarget(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_directory":  return (args.path as string) || ".";
    case "read_file":       return (args.path as string) || "";
    case "read_document":   return (args.path as string) || "";
    case "analyze_tabular_document": return (args.path as string) || "";
    case "query_tabular_document": return (args.path as string) || "";
    case "index_workspace_documents": return (args.path as string) || ".";
    case "knowledge_search": return (args.query as string) || "knowledge";
    case "knowledge_get_excerpt": return (args.chunk_id as string) || (args.chunkId as string) || "knowledge excerpt";
    case "glob_search":     return (args.pattern as string) || "";
    case "grep_search":     return (args.query as string) || "";
    case "web_search":      return (args.query as string) || "web search";
    case "web_fetch":       return (args.url as string) || "";
    case "repo_map_search": return (args.query as string) || "";
    case "repo_map_context": return (args.task as string) || "repo map context";
    case "repo_map_files": return (args.filter as string) || "repo map files";
    case "repo_map_impact": return (args.target as string) || "";
    case "repo_map_status": return "repo map";
    case "execute_command": return (args.command as string) || "";
    case "send_pty_input":  return (args.input as string) || "terminal input";
    case "run_command":     return (args.command as string) || "";
    case "browser_evaluate": return (args.url as string) || "";
    case "read_pty_buffer": return "terminal";
    case "read_pty_tail":   return "terminal tail";
    case "read_pty_since":  return `terminal @ ${args.offset ?? 0}`;
    case "get_pty_status":  return "terminal status";
    case "clear_pty_buffer": return "terminal buffer";
    case "replace_in_file": return (args.path as string) || "";
    case "write_file":      return (args.path as string) || "";
    case "apply_patch":     return summarizeApplyPatchTarget((args.patch as string) || "") || "workspace patch";
    default:                return (args.input as string) || name;
  }
}

const PROSE_CODE_DUMP_MIN_CHARS = 12_000;
const PROSE_CODE_DUMP_LARGE_CHARS = 32_000;
export const MAX_NO_ACTION_RETRIES = 2;
const PLAN_EXPLORATION_REPEAT_READ_LIMIT = 1;
export const EXECUTE_CONVERGENCE_PROMPT_RATIO = 0.72;
export const PLAN_EXECUTE_CONVERGENCE_PROMPT_RATIO = 0.24;
export const MAX_NO_PROGRESS_LOOP_REPEATS = 5;
export const MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS = 2;
const NO_PROGRESS_EXCLUDED_TOOLS = new Set([
  "execute_command",
  "send_pty_input",
  "browser_evaluate",
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

function normalizeNoProgressResultContent(result: ToolExecutionResult): string {
  const raw = String(result.content || "");
  if (!PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)) return raw;
  return raw
    .replace(/Duplicate skip count in this run:\s*\d+\./gi, "Duplicate skip count in this run: [n].")
    .replace(/duplicateCount\s*[:=]\s*\d+/gi, "duplicateCount=[n]")
    .replace(/Previous read:\s*[\d,]+\s+chars/gi, "Previous read: [n] chars")
    .replace(/Previous read window:\s*lines\s+\d+-\d+\s+of\s+\d+,\s*[\d,]+\s+result chars/gi, "Previous read window: lines [range] of [n], [n] result chars");
}

export function buildNoProgressBatchSignature(results: ToolExecutionResult[]): string {
  const usable = results.filter((result) => !result.isError);
  if (usable.length === 0) return "";
  if (usable.every((result) => NO_PROGRESS_EXCLUDED_TOOLS.has(result.name))) return "";
  const fragments = usable
    .map((result) => {
      const contentHash = stableProgressHash(normalizeNoProgressResultContent(result));
      return `${result.name}::${result.target || ""}::${contentHash}`;
    })
    .sort();
  return fragments.join("||");
}

export function isApprovedPlanRecoveryTool(
  tool: ToolDefinition,
  options: { allowFileRead?: boolean } = {},
): boolean {
  return isApprovedPlanRecoveryToolName(tool.function.name, PLAN_EXPLORATION_READ_ONLY_TOOLS, options);
}

export function isApprovedPlanSourceEditFirstTool(
  tool: ToolDefinition,
  options: { allowFileRead?: boolean } = {},
): boolean {
  return isApprovedPlanSourceEditFirstToolName(tool.function.name, options);
}

function isSourceFileEvidencePath(value: string): boolean {
  const normalized = String(value || "").replace(/\\/g, "/").trim();
  return /^(?:src|app|lib|components|hooks|store|styles|utils|pages|server|client|packages|apps)\//i.test(normalized) &&
    /\.(?:tsx?|jsx?|css|scss|json|py|rs|go|swift|vue|svelte)$/i.test(normalized) &&
    !/\.MAIN\/plans\//i.test(normalized);
}

export function approvedPlanNeedsSourceEditBeforeValidation(
  tasks: PlanTask[],
  evidenceLedger: PlanExecutionEvidenceEntry[],
): boolean {
  if (!Array.isArray(tasks) || tasks.length === 0) return false;
  const hasSourceWriteEvidence = (evidenceLedger || []).some((entry) =>
    entry.kind === "file" &&
    /^(?:apply_patch|replace_in_file|write_file)$/.test(entry.sourceTool || "") &&
    isSourceFileEvidencePath(entry.value || entry.target || "")
  );
  if (hasSourceWriteEvidence) return false;

  const audit = buildPlanTaskEvidenceAudit({
    tasks,
    evidenceLedger,
    preserveMissing: true,
    highlightNext: true,
  });
  return audit.remainingTasks.some((task) => {
    const evidencePaths = (task.evidence || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.value);
    const text = task.text || "";
    return evidencePaths.some(isSourceFileEvidencePath) ||
      /(?:修改|更新|新增|修复|重写|实现|调整|接入|补齐|edit|modify|update|add|fix|rewrite|implement|patch)\b/i.test(text) &&
        /(?:src|app|lib|components|hooks|store|styles|utils|pages|server|client|packages|apps)\//i.test(text);
  });
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

export function shouldCompactProseCodeDump(input: {
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

export function buildProseCodeDumpNotice(language: "zh" | "en", charCount: number): string {
  const formatted = charCount.toLocaleString();
  return language === "zh"
    ? `模型刚才把约 ${formatted} 个字符的代码作为聊天正文输出了，但没有通过写入工具落到真实文件。为避免界面卡死，我已将这段超长正文收起；接下来会强制它改用 \`apply_patch\` / \`write_file\` / \`replace_in_file\` 写入项目文件。`
    : `The model just produced about ${formatted} characters of code as chat text instead of writing real files. To keep the UI responsive, I compacted that oversized reply and will force the next step to use \`apply_patch\` / \`write_file\` / \`replace_in_file\` for actual project files.`;
}

export function buildNonActionableStopMessage(language: "zh" | "en", reason: "no_output" | "missing_tool_loop" | "incomplete_plan" | "plain_text_execution"): string {
  if (language === "zh") {
    switch (reason) {
      case "no_output":
        return "模型连续没有产生可见结果或可执行动作，本轮已停止。没有生成计划文件，也没有写入项目文件。";
      case "missing_tool_loop":
        return "模型连续输出说明或代码正文，但没有使用写入/读取工具，本轮已停止。聊天内容不会被当作已写入文件。";
      case "incomplete_plan":
        return "计划生成已暂停：模型写出的 plan.md 没有通过质量门，MAIN 也无法从当前干净证据生成可审批的 `.MAIN/plans/plan.md`。请查看调试日志中的 `plan_evidence_sanitized` 与 `plan_quality_gate_recovery_decision`，优先补足缺失的源码证据或修复证据污染。";
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
      return "Plan generation paused: the model's plan.md failed the quality gate, and MAIN could not generate a reviewable `.MAIN/plans/plan.md` from the current clean evidence. Check `plan_evidence_sanitized` and `plan_quality_gate_recovery_decision` in the debug log, then add the missing source evidence or fix evidence pollution.";
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
      ? "`.MAIN/plans/plan.md`"
      : "`.MAIN/plans/plan.md`";
  }
  if (stage === "bugfix") return "`.MAIN/plans/bugfix.md`";
  return "`.MAIN/plans/plan.md`";
}

export function buildPlanReviewReadyMessage(
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

export function isSuccessfulPlanArtifactWriteResult(result: ToolExecutionResult): boolean {
  return (
    !result.isError &&
    PLAN_ARTIFACT_MUTATION_TOOLS.has(result.name) &&
    !!result.target &&
    isPlanArtifactPath(result.target)
  );
}

export function buildHiddenThoughtOnlyContinuationPrompt(language: "zh" | "en", consecutiveNoToolCount: number): string {
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

export function buildExecuteConvergencePrompt(language: "zh" | "en", iteration: number, maxIterations: number): string {
  return language === "zh"
    ? [
        `本轮 Execute 已进行 ${iteration}/${maxIterations} 轮工具循环，接近安全边界。`,
        "MAIN 会临时收窄工具面：宽泛读取和搜索都会被收起，只保留小补丁/写入工具以及有限命令或浏览器验证。",
        "请先根据已有工具结果判断任务是否已经完成：如果完成，直接输出最终总结并停止，不要再调用工具。",
        "如果 read_file 当前不可用，不要继续请求 read_file，也不要改用 cat/sed/head/tail 通过 shell 读取文件。",
        "如果 grep_search/get_file_outline 已经给出足够定位信息，请直接用 replace_in_file/apply_patch 做最小修改，或运行一次验证命令；不要再调用新的搜索/泛读工具。",
        "不要重复读取、重复验证或继续改同一个目标而没有新证据。",
      ].join("\n")
    : [
        `This Execute turn has reached ${iteration}/${maxIterations} tool-loop iterations and is approaching the safety boundary.`,
        "MAIN will temporarily narrow the tool surface: broad reads and searches are withheld, leaving small patch/write tools plus finite command or browser validation.",
        "First decide from existing tool results whether the task is already complete. If it is complete, output the final summary and stop without more tools.",
        "If read_file is unavailable, do not keep requesting read_file and do not switch to cat/sed/head/tail shell file reads.",
        "If grep_search/get_file_outline already provide enough location context, directly apply the smallest replace_in_file/apply_patch edit or run one validation command; do not call new search or broad read tools.",
        "Do not repeat reads, repeat validation, or keep editing the same target without new evidence.",
    ].join("\n");
}

export function looksLikePlanCompletionClaim(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /(?:全部|所有|全[部都]?|已|已经).{0,24}(?:完成|满足|通过)|(?:任务|证据).{0,16}(?:全部|全都).{0,16}(?:完成|满足|通过)|\b\d+\s*\/\s*\d+\b.{0,24}(?:完成|complete|completed|done|satisfied|passed)/i.test(normalized) ||
    /(?:all|every).{0,40}(?:task|evidence|item).{0,40}(?:complete|completed|done|satisfied|passed)|(?:complete|completed|done|satisfied).{0,40}(?:all|every).{0,40}(?:task|evidence|item)/i.test(normalized)
  );
}

export function looksLikeOperationCompletionClaim(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const hasCompletionClaim =
    /(?:已|已经|现已|刚刚|成功).{0,24}(?:修复|修改|实现|更新|写入|生成|执行|完成|验证|通过)|(?:修复|修改|实现|更新|写入|生成|执行|验证).{0,16}(?:完成|好了|成功|通过)|(?:done|fixed|implemented|patched|updated|completed|wrote|created|generated|ran|verified|passed)\b/i.test(normalized);
  if (!hasCompletionClaim) return false;
  const looksLikeProposalOnly =
    /(?:方案|建议|计划|将会|可以|应该|准备|下一步|如果|待|需要用户|是否|proposal|plan|suggest|would|will|should|can|could|next step|ready to|once)/i.test(normalized) &&
    !/(?:已|已经|成功|done|fixed|implemented|patched|updated|completed|verified|passed)\b/i.test(normalized);
  return !looksLikeProposalOnly;
}

export function looksLikeExecutionReplanningText(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length < 240) return false;
  const hasPlanShape =
    /(?:修复方案|实现方案|执行方案|实施步骤|下一步|计划|方案|建议|Proposal|Implementation Plan|Execution Plan|Next steps?)/i.test(normalized);
  const hasFutureAction =
    /(?:将|会|建议|可以|应该|需要|下一步|准备|开始|执行|修改|修复|实现|验证|will|would|should|can|could|need to|next|propose|recommend|start|execute|modify|fix|implement|verify)/i.test(normalized);
  const hasConcreteWork =
    /(?:src\/|\.tsx?|\.jsx?|\.py|\.rs|\.go|\.json|\.md|read_file|write_file|replace_in_file|run_command|browser_evaluate|文件|代码|接口|组件|测试|验证|file|code|component|test|validation)/i.test(normalized);
  return hasPlanShape && hasFutureAction && hasConcreteWork && !looksLikeOperationCompletionClaim(normalized);
}

export function buildExecuteCompletionEvidencePrompt(language: "zh" | "en", retryCount: number): string {
  if (language === "en") {
    return [
      "The previous reply claimed the operation was complete, but MAIN has no real tool evidence for this execution turn.",
      "Do not repeat the completion claim. Start real tool actions now: inspect the relevant files, write or patch files if needed, run the necessary command/verification, then summarize only after tool results exist.",
      retryCount > 1 ? "This is a repeated failure. If you cannot perform the operation, stop and state the exact blocker instead of claiming success." : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "上一条回复声称操作已完成，但 MAIN 没有看到本轮执行的真实工具证据。",
    "不要重复完成声明。现在必须开始真实工具操作：读取相关文件，必要时写入或打补丁，运行必要命令/验证，然后只能基于工具结果总结。",
    retryCount > 1 ? "这已经是重复失败。如果无法执行，请明确说明具体阻塞，不要声称成功。" : "",
  ].filter(Boolean).join("\n");
}

export function buildExecuteReplanningEvidencePrompt(language: "zh" | "en", retryCount: number): string {
  if (language === "en") {
    return [
      "The user already approved execution for this turn, but the previous reply produced another plan instead of real tool evidence.",
      "Do not re-plan. Start the smallest necessary real tool action now: write/patch files, run a command, use Browser/Playwright validation, or pause with the exact blocker.",
      retryCount > 1 ? "This is a repeated failure. Stop with a concrete blocker if no real action is possible." : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "用户已经批准本轮执行，但上一条回复又输出了新的方案，没有产生真实工具证据。",
    "不要重新规划。现在必须开始最小必要的真实工具动作：写入/替换文件、运行命令、调用 Browser/Playwright 验证，或明确暂停说明具体阻塞。",
    retryCount > 1 ? "这已经是重复失败。如果无法真实执行，请直接给出具体阻塞，不要继续输出方案。" : "",
  ].filter(Boolean).join("\n");
}

export function buildReadOnlyPermissionHardRecoveryPrompt(language: "zh" | "en", workflowMode: "chat" | "edit" | "plan"): string {
  if (language === "en") {
    return [
      "The user already allowed read-only inspection for this session, but the previous turn still did not make useful tool progress.",
      "Do not ask for permission again and do not narrate a future read.",
      workflowMode === "plan"
        ? "If the evidence is sufficient, create or update `.MAIN/plans/plan.md` with write_file or replace_in_file; if one fact is still missing, call exactly one targeted read/search tool now. If the target was already cached, reuse the existing content instead of rereading it."
        : "If you need evidence, call one targeted read/search tool now. If the target was already cached, reuse the existing content and move to the next real action: patch/write, run a finite command, browser validation, or state the exact blocker.",
    ].join("\n");
  }
  return [
    "用户已经允许本会话的只读检查，但上一轮仍没有产生有效工具进展。",
    "不要再次询问许可，也不要只描述接下来要读取什么。",
    workflowMode === "plan"
      ? "如果证据已经足够，直接用 write_file 或 replace_in_file 创建/更新 `.MAIN/plans/plan.md`；如果只缺一个事实，现在只调用一次定向读取/搜索工具。目标已缓存时复用已有内容，不要重复读取。"
      : "如果还需要证据，现在只调用一次定向读取/搜索工具。目标已缓存时复用已有内容，并进入下一个真实动作：写入/替换、运行有限命令、浏览器验证，或说明精确阻塞。",
  ].join("\n");
}

export function buildApprovedPlanNoProgressStrategySwitchPrompt(input: {
  language: "zh" | "en";
  remainingText: string;
  repeatedTargets: string[];
  recentToolActivity: PlanToolActivitySummary[];
  allowFileRead?: boolean;
}): string {
  const repeatedTargets = input.repeatedTargets.length > 0
    ? input.repeatedTargets.join(input.language === "zh" ? "、" : ", ")
    : input.language === "zh" ? "最近已读目标" : "recently read targets";
  const recent = input.recentToolActivity
    .slice(-4)
    .map((item) => [item.status, item.name, item.target, item.detail].filter(Boolean).join(" "))
    .join(input.language === "zh" ? "；" : "; ");

  if (input.language === "en") {
    return [
      "The approved Plan is still executing, but the last read-only batch reused already-known file content and did not create action evidence.",
      "Continue now. Do not stop and do not re-plan.",
      `Repeated/known targets: ${repeatedTargets}`,
      recent ? `Recent tool evidence: ${recent}` : "",
      `Unsatisfied task: ${input.remainingText}`,
      input.allowFileRead
        ? "For the next response, MAIN keeps action tools plus targeted file reads available for exact-content or patch recovery. Use one only when needed, then patch or validate."
        : "For the next response, MAIN keeps action tools plus patch-recovery `read_file` only when a patch mismatch just happened. Use `apply_patch`/`replace_in_file`/`write_file`, run a command, use Browser/Playwright validation, or state the exact blocker if no real action is possible.",
      "Do not call read/list/search again for the same cached target. If exact current content is needed, perform one targeted read and immediately continue with patching or validation.",
    ].filter(Boolean).join("\n");
  }

  return [
    "已批准的 Plan 仍在执行，但上一批只读工具只是复用了已知文件内容，没有产生行动证据。",
    "现在继续执行，不要停止，也不要重新规划。",
    `重复/已知目标：${repeatedTargets}`,
    recent ? `最近工具证据：${recent}` : "",
    `证据未满足任务：${input.remainingText}`,
    input.allowFileRead
      ? "下一轮 MAIN 会保留行动工具和定向文件读取，用于精确内容或 patch 恢复。只在需要时读一次，随后必须写入或验证。"
      : "下一轮 MAIN 会保留行动工具；只有刚发生 patch 不匹配时才开放一次定向 `read_file`。请优先使用 `apply_patch` / `replace_in_file` / `write_file` 修改，运行命令，执行 Browser/Playwright 验证，或说明无法真实行动的具体阻塞。",
    "不要再次对同一缓存目标调用 read/list/search；如果确实需要精确当前内容，只做一次定向读取，然后立即继续 patch 或验证。",
  ].filter(Boolean).join("\n");
}

function buildApprovedPlanSourceEditFirstPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "Approved execution must start with real project action, not another exploration loop.",
      "If the approved plan includes a source-file edit, the next tool call should be `apply_patch`, `replace_in_file`, or `write_file` against the named source file.",
      "Do not read `.MAIN/plans/plan.md` again, and do not use `run_command`/`cat`/`head`/`grep`/`rg` to page source files before the first project write. Validation commands are for after the write.",
    ].join("\n");
  }
  return [
    "批准后的执行必须从真实项目动作开始，不能再次进入探索循环。",
    "如果已批准计划包含源码修改，下一次工具调用应直接对命名源码文件使用 `apply_patch`、`replace_in_file` 或 `write_file`。",
    "不要再次读取 `.MAIN/plans/plan.md`，也不要在第一次项目写入前用 `run_command`/`cat`/`head`/`grep`/`rg` 分页读取源码；验证命令应在写入之后再运行。",
  ].join("\n");
}

export function formatPlanAuditRemainingTasks(
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

function formatApprovedPlanNoToolAvailableTools(
  language: "zh" | "en",
  toolNames?: Iterable<string> | null,
): string {
  if (!toolNames) return "";
  const available = new Set(Array.from(toolNames).map((name) => String(name || "")));
  const preferred = [
    "read_file",
    "apply_patch",
    "replace_in_file",
    "write_file",
    "run_command",
    "execute_command",
    "browser_evaluate",
  ].filter((name) => available.has(name));
  if (preferred.length === 0) return "";
  return language === "zh"
    ? `本轮已开放关键工具：${preferred.map((name) => `\`${name}\``).join("、")}。暂停原因不是工具缺失，而是模型没有按执行协议调用工具。`
    : `Key tools were available this turn: ${preferred.map((name) => `\`${name}\``).join(", ")}. This pause is not caused by missing tools; the model did not follow the execution protocol and call one.`;
}

export function buildApprovedPlanNoToolPauseMessage(
  language: "zh" | "en",
  remainingText: string,
  consecutiveNoToolCount: number,
  audit?: PlanTaskEvidenceAudit,
  completionClaimRejected = false,
  availableToolNames?: Iterable<string> | null,
): string {
  const auditLine = audit && audit.totalCount > 0
    ? language === "zh"
      ? `可信审计进度：${audit.completedCount}/${audit.totalCount}`
      : `Trusted audit progress: ${audit.completedCount}/${audit.totalCount}`
    : "";
  const availableToolsLine = formatApprovedPlanNoToolAvailableTools(language, availableToolNames);

  return language === "zh"
    ? [
        completionClaimRejected ? "完成声明未验证" : "计划执行已暂停",
        "",
        completionClaimRejected
          ? `原因：模型声称计划已完成，但可信任务审计没有通过；模型正文不会被当作完成证据。`
          : `原因：模型连续 ${consecutiveNoToolCount} 次提前停止，返回了正文但没有继续调用工具；当前任务清单仍有证据未满足的任务。`,
        "已保留当前 workspace、工具结果和任务证据，不会把这次正文当作完成证据。",
        ...(auditLine ? [auditLine] : []),
        ...(availableToolsLine ? [availableToolsLine] : []),
        "",
        "未完成任务：",
        remainingText,
        "",
        "下一步：点击 Resume Execution 后，MAIN 应先重新读取当前 workspace 状态，再选择证据未满足且与当前诊断最相关的任务继续。",
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
        ...(availableToolsLine ? [availableToolsLine] : []),
        "",
        "Remaining tasks:",
        remainingText,
        "",
        "Next: click Resume Execution so MAIN rereads current workspace state and continues with the evidence-unsatisfied task that best matches the current diagnosis.",
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

export function buildApprovedPlanValidationPendingMessage(input: {
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

export function buildBrowserValidationContinuationPrompt(input: {
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

export function resolveApprovedPlanValidationBoundary(input: {
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

function isPlanRuntimeInstructionMemory(text: string): boolean {
  return /(?:本轮处于\s*PLAN\s*模式|This turn is in PLAN mode|上一条\s*Plan\s*回复|previous Plan reply|PLAN_REPEAT_READ_LIMIT|PLAN_QUALITY_GATE|如果确实缺少关键业务选择|critical business choice|真正阻塞执行的选择|plan direction is unclear|用\s*`?\s*<?user_options>?\s*`?\s*提问|ask with\s*`?\s*<?user_options>?|可见计划必须|visible\s+`?<proposed_plan>`|创建\s*plan\.md\s*是\s*runtime|MAIN\s+runtime\s+会物化|物化为\s*`?\.MAIN\/plans\/plan\.md|Codex app\s*计划结构|Codex app plan shape|tsx\s*约束|imageParts\s*[0-9]|turn_intake|不要重复扫描目录|Do not repeat directory scans|不要为了完成规划而调用|Do not call\s+`?(?:write_file|replace_in_file)`?\s+just to finish planning)/i.test(
    String(text || "").replace(/\\/g, "/"),
  );
}

function isPlanControlUserPrompt(text: string): boolean {
  return /^(?:上一条规划内容过长|当前规划还没有进入可执行阶段|计划已批准|请继续上一轮 PLAN|The previous planning reply was too long|The current plan has not reached|The plan is approved|Continue the previous PLAN turn)/i.test(
    String(text || "").trim(),
  );
}

export function getOriginalUserPromptForPlanFallback(callbacks: OrchestratorCallbacks): string {
  const userMessages = callbacks.getMessages()
    .filter((message) => message.role === "user")
    .map((message) => {
      const raw = extractCompatibilityTextContent(message.content);
      const primary = extractPrimaryUserRequestText(raw);
      return stripControlPromptForPlanFallback(primary || raw);
    })
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
    if (!text || isPlanRuntimeInstructionMemory(text)) continue;
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

export function collectPlanClosureMaterializationInput(
  callbacks: OrchestratorCallbacks,
  recentActivity: PlanToolActivitySummary[] = [],
  attemptedTargets: string[] = [],
  fallbackUserGoal = "",
): {
  userGoal: string;
  evidence: string[];
  evidenceRecords: PlanEvidenceRecord[];
  files: string[];
  constraints: string[];
  sanitizer: ReturnType<typeof sanitizePlanEvidenceInput>["stats"];
  sanitizerDropped: ReturnType<typeof sanitizePlanEvidenceInput>["dropped"];
} {
  const memory = callbacks.getContextMemoryState?.() || null;
  const userGoal =
    stripControlPromptForPlanFallback(extractPrimaryUserRequestText(fallbackUserGoal) || fallbackUserGoal) ||
    getOriginalUserPromptForPlanFallback(callbacks) ||
    stripControlPromptForPlanFallback(
      extractPrimaryUserRequestText(memory?.latestUserRequest?.text || "") ||
      memory?.latestUserRequest?.text ||
      "",
    );
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
  const evidenceRecords: PlanEvidenceRecord[] = recentActivity
    .filter((item) => item.status === "succeeded")
    .map((item) => {
      const summary = item.detail || "";
      const hashInput = [item.name, item.target, summary].filter(Boolean).join("\n");
      return {
        tool: item.name,
        target: item.target,
        status: "succeeded",
        ...(summary ? { summary } : {}),
        hash: stableProgressHash(hashInput),
      };
    });
  const fallbackHighlights = evidenceFromMemory.length > 0 || evidenceFromActivity.length > 0
    ? []
    : collectFallbackToolHighlights(callbacks, attemptedTargets)
      .filter((item) => !/Repeated read-only tool call skipped|Duplicate skip count|already called with identical arguments/i.test(item));

  const sanitized = sanitizePlanEvidenceInput({
    userGoal,
    evidence: [...evidenceFromMemory, ...evidenceFromActivity, ...fallbackHighlights],
    evidenceRecords,
    files,
    constraints,
    language: callbacks.getPreferredLanguage(),
    maxEvidence: 14,
    maxFiles: 14,
    maxConstraints: 8,
  });

  return {
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    evidenceRecords,
    files: sanitized.files,
    constraints: sanitized.constraints,
    sanitizer: sanitized.stats,
    sanitizerDropped: sanitized.dropped,
  };
}

export function buildPlanClosurePromptFromEvidence(
  callbacks: OrchestratorCallbacks,
  recentActivity: PlanToolActivitySummary[] = [],
  attemptedTargets: string[] = [],
  fallbackUserGoal = "",
): string {
  const closureInput = collectPlanClosureMaterializationInput(
    callbacks,
    recentActivity,
    attemptedTargets,
    fallbackUserGoal,
  );
  return composeReviewablePlanFromEvidence({
    ...closureInput,
    language: callbacks.getPreferredLanguage(),
  });
}

export function buildPlanRecoveryPrompt(callbacks: OrchestratorCallbacks, sourceText: string, attemptedTargets: string[] = []): string {
  const toolHighlights = collectFallbackToolHighlights(callbacks, attemptedTargets)
    .filter((item) => !/Repeated read-only tool call skipped|Duplicate skip count|already called with identical arguments/i.test(item))
    .slice(0, 6);
  return buildPlanRecoveryPromptFromContext({
    language: callbacks.getPreferredLanguage(),
    userPrompt: getOriginalUserPromptForPlanFallback(callbacks),
    sourceText,
    toolHighlights,
  });
}

export function isReviewablePlanStage(stage: ReturnType<OrchestratorCallbacks["getPlanStage"]>): boolean {
  return stage === "plan" || stage === "design" || stage === "bugfix" || stage === "ready_to_execute";
}

export function createHookContextMessages(
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

export function buildPlanCommandExecutionHint(
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

export function buildApprovedPlanContinuationPrompt(callbacks: OrchestratorCallbacks): string {
  const language = callbacks.getPreferredLanguage();
  const approvalChoiceHint = buildPlanApprovalChoiceHint(callbacks.getPlanApprovalChoice(), language);
  const requestedDocs = detectRequestedRootMarkdownDeliverables(getOriginalUserPromptForPlanFallback(callbacks));
  const runtimeTaskList = formatPlanTasksForContinuationPrompt(callbacks.getPlanTasks(), language);
  const sourceEditFirstPrompt = buildApprovedPlanSourceEditFirstPrompt(language);
  const deliverableHint = requestedDocs.length > 0
    ? language === "zh"
      ? `6. 用户明确要求最终文档：${requestedDocs.map((name) => `项目根目录 \`${name}\``).join("、")}。必须把它写进当前任务清单；如果持久化 tasks.md，也作为最后交付步骤，并在计划完成前真实写入。\n`
      : `6. The user explicitly requested final document(s): ${requestedDocs.map((name) => `project-root \`${name}\``).join(", ")}. Add them to the current task list; if tasks.md is persisted, include them as final deliverables and write them before marking the plan complete.\n`
    : "";

  return (
    approvalChoiceHint +
    (callbacks.getPlanTasks().length > 0
      ? language === "zh"
        ? "计划已批准，现在进入执行阶段（EXECUTION MODE）。MAIN 已有 runtime 任务清单，ExecutionCapsule 会直接显示任务进度；不需要为了第一次源码写入强制创建或读取 `.MAIN/plans/tasks.md`。请按当前任务清单逐项执行，使用 <tool_use> 格式调用工具；只有任务较长、需要跨会话审计或用户明确要求留档时，才先把清单持久化到 tasks.md。不要为了确认 tasks.md 是否存在而读取它；只有它已知存在或你正在同步已有审计文件时，才读取/更新。任何需要 shell 的任务都必须在当前任务清单中保留精确命令并用反引号包裹。如果某个源码文件已经读过，再读只返回 `FILE_UNCHANGED_STUB`，不要重复读取，必须转向 `apply_patch`/`replace_in_file`/`write_file`、运行验证、读取不同目标，或明确暂停说明阻塞。页面渲染验证必须使用 Browser/Playwright DOM 或截图证据，不能用 curl/grep/cat 代替；Tauri/人工验证不可自动完成时要暂停说明待用户验证。你可以正常修改项目源码文件，写入路径必须是项目中的正确位置，绝对不要将源码写入 `.MAIN/plans/` 或任何隐藏目录。只有全部任务都有真实文件/命令/交付物/浏览器证据满足，或剩余项明确待用户验证后，才能结束执行；如果 tasks.md 已存在，完成任务后再同步更新对应 checkbox。\n"
        : "The plan is approved. You are now in EXECUTION MODE. MAIN already has a runtime task list, so ExecutionCapsule can show task progress without forcing creation or reads of `.MAIN/plans/tasks.md` before the first source write. Execute the current task list with tool calls; persist the list to tasks.md only when the work is long, cross-session, or explicitly needs an audit file. Do not read tasks.md just to check whether it exists; only read/update it when it is already known to exist or you are syncing an existing audit file. Any task that needs shell work must keep the exact command in the current task list using backticks. If a source file has already been read and another read only returns `FILE_UNCHANGED_STUB`, do not reread it; switch to `apply_patch`/`replace_in_file`/`write_file`, run validation, inspect a different target, or pause with the exact blocker. Rendered-page validation requires Browser/Playwright DOM or screenshot evidence; do not substitute curl/grep/cat. If Tauri or manual validation cannot be automated, pause and report pending user validation. You may now edit project source files, but write them to the proper project paths and never into `.MAIN/plans/` or hidden folders. Only stop when every task has satisfied real file/command/deliverable/browser evidence, or remaining items are explicitly pending user validation; if tasks.md exists, update the matching checkbox after evidence exists.\n"
      : language === "zh"
      ? "计划已批准，现在进入执行阶段（EXECUTION MODE）。请先基于已批准的 plan.md 派生精简 runtime 任务清单；只有任务较长、需要跨会话审计或用户明确要求留档时，才生成 `.MAIN/plans/tasks.md`。不要为了确认 tasks.md 是否存在而读取它。随后按任务逐项执行，使用 <tool_use> 格式调用工具。页面渲染验证必须使用 Browser/Playwright DOM 或截图证据；Tauri/人工验证不可自动完成时要暂停说明待用户验证。你可以正常修改项目源码文件，写入路径必须是项目中的正确位置，绝对不要将源码写入 `.MAIN/plans/` 或任何隐藏目录。只有全部任务都有真实文件/命令/交付物/浏览器证据满足，或剩余项明确待用户验证后，才能结束执行。\n"
      : "The plan is approved. You are now in EXECUTION MODE. First derive a concise runtime task list from the approved plan.md; generate `.MAIN/plans/tasks.md` only when the work is long, cross-session, or explicitly needs an audit file. Do not read tasks.md just to check whether it exists. Then execute the tasks one by one using tool calls. Rendered-page validation requires Browser/Playwright DOM or screenshot evidence; if Tauri or manual validation cannot be automated, pause and report pending user validation. You may now edit project source files, but write them to the proper project paths and never into `.MAIN/plans/` or hidden folders. Only stop when every task has satisfied real file/command/deliverable/browser evidence, or remaining items are explicitly pending user validation.\n") +
    deliverableHint +
    (runtimeTaskList ? "\n" + runtimeTaskList + "\n" : "") +
    "\n" +
    sourceEditFirstPrompt +
    "\n" +
    buildPlanCommandExecutionHint(callbacks.getPlanTasks(), language)
  );
}

export function shouldTreatCloudGatewayErrorAsCompatibility(
  errMsg: string,
  isCloudProfile: boolean,
  messages: AgentMessage[],
  nativeToolsWereAttempted: boolean,
): boolean {
  if (!isCloudProfile || isCloudGatewayTimeoutMessage(errMsg) || !isRetryableCloudErrorMessage(errMsg)) return false;
  return nativeToolsWereAttempted || hasToolRoundHistory(messages);
}

export const PLAN_NO_VISIBLE_TOKEN_TIMEOUT_MS = 125_000;

interface FetchLLMStreamOptions {
  noVisibleTokenTimeoutMs?: number;
  noVisibleTokenTimeoutLabel?: string;
  toolChoice?: OpenAiToolChoice;
  responseFormat?: Record<string, unknown>;
  workflowMode?: string;
  runtimeIntent?: string;
}

export function isStreamWatchdogTimeoutMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("stream_first_chunk_timeout") ||
    normalized.includes("stream_idle_timeout") ||
    normalized.includes("stream_no_visible_token_timeout") ||
    normalized.includes("stream_no_visible_progress_timeout") ||
    normalized.includes("first chunk timeout") ||
    normalized.includes("first response timeout") ||
    normalized.includes("没有返回首个流式 chunk") ||
    normalized.includes("没有继续输出") ||
    normalized.includes("首个流式 chunk") ||
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

export function shouldDeferNoProgressStopToPlanReadOnlyConvergence(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  hasPlanDecisionOutput: boolean;
  resultCount: number;
  successfulReadOnlyResultCount: number;
  nonReadOnlySuccessfulResultCount: number;
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved || input.hasPlanDecisionOutput) return false;
  if (input.resultCount <= 0 || input.successfulReadOnlyResultCount <= 0) return false;
  return input.nonReadOnlySuccessfulResultCount === 0;
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
  shouldRedirectToPlanClosure: boolean;
  reason: string | null;
} {
  if (input.workflowMode !== "plan" || input.isPlanApproved) {
    return { shouldRedirectToPlanClosure: false, reason: null };
  }
  const duplicateCount = input.duplicateCount ?? 0;
  const isBroadStructureTool =
    input.toolName === "get_project_skeleton" ||
    (input.toolName === "list_directory" && (!input.target || input.target === "." || input.target === "./"));
  if (isBroadStructureTool && duplicateCount >= PLAN_EXPLORATION_REPEAT_READ_LIMIT) {
    return {
      shouldRedirectToPlanClosure: true,
      reason: "repeated_broad_structure_read",
    };
  }
  if (input.hasTabularEvidence && isBroadStructureTool) {
    return {
      shouldRedirectToPlanClosure: true,
      reason: "tabular_context_already_available",
    };
  }
  if ((input.successfulReadEvidenceCount ?? 0) >= 2 && isBroadStructureTool) {
    return {
      shouldRedirectToPlanClosure: true,
      reason: "sufficient_read_context_already_available",
    };
  }
  return { shouldRedirectToPlanClosure: false, reason: null };
}

export async function runLifecycleHooks(
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
export async function fetchLLMStream(
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
          {
            toolChoice: options.toolChoice,
            responseFormat: options.responseFormat,
          },
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
    const isLocal = settings.provider === "Ollama" || settings.provider === "LM Studio" || settings.provider === "OMLX" ||
      String(settings.baseUrl || "").toLowerCase().includes("localhost") ||
      String(settings.baseUrl || "").toLowerCase().includes("127.0.0.1") ||
      String(settings.baseUrl || "").toLowerCase().includes("::1") ||
      String(settings.baseUrl || "").toLowerCase().includes("ollama") ||
      String(settings.baseUrl || "").toLowerCase().includes(":11434");
    const skipReasoningDominatedEscalation = isReasoningDominatedLengthResult(result, isLocal);
    const isChat = options.workflowMode === "chat" || options.runtimeIntent === "respond";
    const allowEscalation = !(isChat && currentMaxTokens >= 4096);
    const hasToolCalls = Array.isArray(result.toolCalls) && result.toolCalls.length > 0;
    const shouldEscalate = result.finishReason === "length" &&
      escalationCount < MAX_ESCALATIONS &&
      !skipReasoningDominatedEscalation &&
      allowEscalation &&
      (!isLocal || hasToolCalls || options.workflowMode === "plan" || options.workflowMode === "edit");
    if (shouldEscalate) {
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
    if (result.finishReason === "length" && skipReasoningDominatedEscalation && escalationCount < MAX_ESCALATIONS) {
      logAgentEvent("max_output_escalation_skipped", {
        reason: "reasoning_dominated_length",
        contentChars: result.content.length,
        reasoningChars: String(result.reasoningContent || "").length,
        toolCalls: result.toolCalls.length,
      });
    }

    const truncated = result.finishReason === "length";
    callbacks.onStreamDone(fullText, messageId, truncated, {
      suppressTruncationWarning: skipReasoningDominatedEscalation,
      reason: skipReasoningDominatedEscalation ? "reasoning_dominated_length" : "",
    });
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
  internalFeedback?: boolean;
  qualityGateReason?: string;
  planRecoveryAction?: PlanArtifactRecoveryAction;
  missingPlanSections?: string[];
}

function getToolResultDiagnosticText(result?: ToolExecutionResult): string {
  if (!result) return "";
  return [
    result.content,
    result.displayContent,
    result.qualityGateReason,
    result.lifecycleState,
  ].filter(Boolean).join("\n");
}

export function isReadFileRepeatLimitResult(result: ToolExecutionResult): boolean {
  return result.name === "read_file" && /^READ_FILE_REPEAT_LIMIT\b/i.test(result.content || "");
}

export function summarizeReadFileRepeatLimitBatch(results: ToolExecutionResult[]): {
  total: number;
  target: string;
  targetCount: number;
} | null {
  const repeatResults = results.filter(isReadFileRepeatLimitResult);
  if (repeatResults.length < 8) return null;
  const targetCounts = new Map<string, number>();
  for (const result of repeatResults) {
    const target = String(result.target || "").trim() || "(unknown)";
    targetCounts.set(target, (targetCounts.get(target) || 0) + 1);
  }
  const top = [...targetCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 6) return null;
  return {
    total: repeatResults.length,
    target: top[0],
    targetCount: top[1],
  };
}

export function buildReadFileRepeatLimitBatchPauseNotice(input: {
  language: "zh" | "en";
  target: string;
  total: number;
  targetCount: number;
}): string {
  if (input.language === "en") {
    return [
      "Execution paused: the model kept retrying the same blocked read_file call instead of using the cached context.",
      `Repeated target: ${input.target} (${input.targetCount}/${input.total} blocked reads in this batch).`,
      "Resume by reusing the existing file context and moving to a patch, validation command, or an explicit blocker. Do not retry the same read_file call.",
    ].join("\n");
  }
  return [
    "执行已暂停：模型持续重试同一个已拦截的 read_file，而不是复用已读上下文。",
    `重复目标：${input.target}（本批次 ${input.targetCount}/${input.total} 次读取被拦截）。`,
    "继续时请复用已有文件上下文，转向 patch、验证命令，或说明明确阻塞；不要原样重试同一个 read_file。",
  ].join("\n");
}

// Build a patch-mismatch recovery hint. Returns null when there is no mismatch.
// When apply_patch fails with context mismatch, this tells the model to
// fall back to read_file + replace_in_file/write_file for precise editing.
export function buildApplyPatchMismatchHint(
  result: ToolExecutionResult,
  language: "en" | "zh",
): string | null {
  const diagnostic = getToolResultDiagnosticText(result);
  const isPatchMismatch = /search_text_mismatch|MUTATION_PREFLIGHT_BLOCKED|patch.*(?:mismatch|failed to apply)|replacement text was not found|context.*not.*found|Patch context/i.test(diagnostic) ||
    (result.name === "apply_patch" && /invalid_patch|invalid patch/i.test(diagnostic));
  if (!isPatchMismatch) return null;

  if (language === "zh") {
    return (
      "apply_patch 上下文匹配失败。请使用以下策略重试：" +
      "\n1. 先用 read_file 读取目标文件的最新内容" +
      "\n2. 改用 replace_in_file 进行精确行替换，或使用 write_file 写入完整文件" +
      "\n3. 确保 diff 中的 search_text 与文件实际内容完全一致"
    );
  }
  return (
    "apply_patch context match failed. Use this strategy to retry:" +
    "\n1. First read_file to get the latest file content" +
    "\n2. Switch to replace_in_file for precise line replacement, or write_file for full file write" +
    "\n3. Ensure the diff search_text exactly matches the actual file content"
  );
}



export function targetProgressOutcomeForToolResult(result?: ToolExecutionResult): TargetProgressOutcome {
  if (!result) return "failed";
  const diagnostic = getToolResultDiagnosticText(result);
  if (/FILE_UNCHANGED_STUB|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT|empty_change|invalid_patch|identical_content|no changes|no-op|nothing to (?:change|patch|write)/i.test(diagnostic)) {
    return "no_change";
  }
  if (/search_text_mismatch|MUTATION_PREFLIGHT_BLOCKED|patch.*(?:mismatch|failed to apply)|replacement text was not found/i.test(diagnostic)) {
    return "blocked";
  }
  if (result.lifecycleState === "declined") return "declined";
  if (result.lifecycleState === "blocked") return "blocked";
  if (!result.isError) return "succeeded";
  return "failed";
}

export function targetProgressReasonForToolResult(result?: ToolExecutionResult): string {
  const diagnostic = getToolResultDiagnosticText(result)
    .replace(/\s+/g, " ")
    .trim();
  if (!diagnostic) return "missing_result";
  const reason =
    diagnostic.match(/\b(?:reason|error|status)\s*[:=]\s*([^.;\n]{1,100})/i)?.[1] ||
    diagnostic.match(/\b(search_text_mismatch|empty_change|invalid_patch|identical_content|MUTATION_PREFLIGHT_BLOCKED|FILE_UNCHANGED_STUB|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT)\b/i)?.[1] ||
    diagnostic.slice(0, 120);
  return reason.trim();
}

interface PlanMaterializationResultForLoop {
  ok: boolean;
  path?: string;
  kind?: "plan" | "design";
  content?: string;
  reason?: string;
  source?: PlanMaterializationSource;
  toolResult?: ToolExecutionResult;
}

async function writeMaterializedPlanArtifact(input: {
  materialized: {
    ok: boolean;
    path?: string;
    kind?: "plan" | "design";
    content?: string;
    reason?: string;
    source?: PlanMaterializationSource;
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
      source: materialized.source,
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
      source: materialized.source,
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

export function parseToolCallArguments(tc: ToolCallToExecute, workspace?: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return normalizeToolCallForExecution(tc.name, parsed as Record<string, unknown>, workspace);
  } catch {
    return {};
  }
}

export function buildToolActionNarration(input: {
  calls: ToolCallToExecute[];
  workspace: string;
  language: "zh" | "en";
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  userGoal?: string;
  turnIntent?: ResolvedUserIntent | string;
  currentHypothesis?: string;
  previousObservation?: string;
  userContext?: TurnInputContextSignals;
}): ProgressNarration | null {
  const calls = input.calls.slice(0, 3);
  if (calls.length === 0) return null;

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

  const hasPlanWrite = presentations.some((item) =>
    PLAN_ARTIFACT_MUTATION_TOOLS.has(item.name) &&
    /\.(?:main|MAIN)\/plans\/(?:requirements|plan|design|bugfix)\.md$/i.test(item.target.replace(/\\/g, "/"))
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
  const context = normalizeTurnInputContextSignals(input.userContext);

  if (input.workflowMode === "plan" && !input.isPlanApproved && hasPlanWrite) {
    return {
      phase: "summarizing",
      title: input.language === "zh" ? "整理可审批方案" : "Draft reviewable plan",
      why: input.language === "zh"
        ? "计划审批前只持久化方案，不提前修改源码。"
        : "Before approval, persist the plan without editing source files.",
      action: input.language === "zh"
        ? "正在写入或更新 `.MAIN/plans/plan.md` 草案。"
        : "Writing or updating the `.MAIN/plans/plan.md` draft.",
      evidence: "",
      next: "",
      targets: presentations.map((item) => item.presentation.target).filter(Boolean),
      status: "running",
      source: "runtime",
    };
  }

  if (input.workflowMode === "plan" && !input.isPlanApproved && hasReadOrAnalysis) {
    const planNarration = buildPlanReadOnlyProgressNarration({
      calls: presentations.map((item) => ({ name: item.name, target: item.target })),
      language: input.language,
      userGoal: input.userGoal,
      userContext: context,
      status: "running",
      source: "runtime",
    });
    if (planNarration) return planNarration;
  }

  return buildToolCallsProgressNarration({
    calls: presentations.map((item) => ({ name: item.name, target: item.target })),
    language: input.language,
    userGoal: input.userGoal,
    turnIntent: input.turnIntent,
    workflowMode: input.workflowMode,
    currentHypothesis: input.currentHypothesis,
    previousObservation: input.previousObservation,
    status: "running",
    source: "runtime",
  });
}

export function normalizeToolCallToExecute(
  tc: ToolCallToExecute,
  workspace?: string | null,
): ToolCallToExecute {
  const toolArgs = parseToolCallArguments(tc, workspace);
  return {
    ...tc,
    arguments: JSON.stringify(toolArgs),
  };
}

export function buildReadOnlyCacheSignature(name: string, args: Record<string, unknown>): string {
  return buildRepeatLoopSignature(name, buildRepeatLoopArgsKey(args));
}

export function formatCachedReadOnlyToolResult(
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

export function appendPlanRepeatReadLimitGuidance(
  content: string,
  language: "zh" | "en",
  stage: ReturnType<OrchestratorCallbacks["getPlanStage"]>,
): string {
  const guidance = language === "zh"
    ? stage === "requirements"
      ? "PLAN_REPEAT_READ_LIMIT: 你正在计划阶段重复读取已经缓存且未变化的上下文。请停止重复读取，直接基于 requirements.md 和已有文件上下文写入 `.MAIN/plans/plan.md`；如果设计方向不明确，用 `<user_options>` 提供用户可点击选择并立刻停止。"
      : "PLAN_REPEAT_READ_LIMIT: 你正在重复读取已经缓存且未变化的上下文。请停止重复读取，转向创建/更新 `.MAIN/plans/plan.md`，或用 `<user_options>` 询问关键分叉。"
    : stage === "requirements"
    ? "PLAN_REPEAT_READ_LIMIT: You are repeating cached unchanged reads during planning. Stop rereading files and write `.MAIN/plans/plan.md` from requirements.md and existing context; if the plan direction is unclear, offer `<user_options>` and stop."
    : "PLAN_REPEAT_READ_LIMIT: You are repeating cached unchanged reads. Stop rereading and create/update `.MAIN/plans/plan.md`, or offer `<user_options>` for the key decision.";
  return `${content}\n\n${guidance}`;
}

export function truncateToolContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + `\n...[truncated, ${content.length - maxChars} chars omitted]`;
}

export async function readFileMetadataIfAvailable(path: string, workspace?: string): Promise<{ path: string; sizeBytes: number; modifiedMs: number } | null> {
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

async function readMutationDiffSnapshot(input: {
  path: string;
  workspace: string;
  sessionKey?: string;
  allowExternalLocalRead?: boolean;
}): Promise<{ path: string; content: string; existed: boolean }> {
  try {
    const content = await executeTool(
      "read_file",
      { path: input.path, __raw: true },
      input.workspace,
      input.sessionKey,
      { allowExternalLocalRead: input.allowExternalLocalRead === true },
    );
    return {
      path: input.path,
      content: String(content ?? ""),
      existed: true,
    };
  } catch {
    return {
      path: input.path,
      content: "",
      existed: false,
    };
  }
}

function buildMutationDiffPreviewFromSnapshots(input: {
  toolName: string;
  target: string;
  before: { path: string; content: string; existed: boolean } | null;
  after: { path: string; content: string; existed: boolean } | null;
}): ToolDiffPreview | undefined {
  if (!supportsToolDiffPreview(input.toolName)) return undefined;
  const path = String(input.after?.path || input.before?.path || input.target || "").trim();
  if (!path || isEphemeralPlanArtifactPath(path)) return undefined;
  const oldText = input.before?.content ?? "";
  const newText = input.after?.content ?? "";
  const existed = input.before?.existed === true;
  if (oldText === newText && existed === (input.after?.existed === true)) return undefined;
  return {
    old: oldText,
    new: newText,
    path,
    existed,
    fullFile: true,
  };
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
    if (name === "run_command" || name === "execute_command" || name === "browser_evaluate") return { modelChars: 6000, displayChars: 8000 };
    return { modelChars: 6000, displayChars: 8000 };
  }

  if (name === "read_file") return { modelChars: 24000, displayChars: 10000 };
  if (name === "read_document" || name === "analyze_tabular_document" || name === "query_tabular_document") {
    return { modelChars: 16000, displayChars: 10000 };
  }
  if (name === "run_command" || name === "execute_command" || name === "browser_evaluate") return { modelChars: 12000, displayChars: 10000 };
  return { modelChars: 12000, displayChars: 10000 };
}

export function inferLifecycleStateFromToolResult(result: ToolExecutionResult): ToolLifecycleState {
  if (result.lifecycleState) return result.lifecycleState;
  if (!result.isError) {
    if (/"noOp"\s*:\s*true/.test(result.content || "")) return "completed";
    if (result.content.includes(FILE_UNCHANGED_STUB) || /Repeated read-only tool call skipped:|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT/i.test(result.content)) {
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
    /Repeated read-only tool call skipped:|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT/i.test(result.content);
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

export function buildToolResultHistoryContentByFormat(
  result: ToolExecutionResult,
  format: AppConfig["toolFeedbackFormat"],
): string {
  if (format !== "envelope_v1") return result.content;
  return buildToolResultHistoryContent(result);
}

interface ExecuteToolLifecycleOptions {
  allowExternalLocalRead?: boolean;
  shellPermissionApproval?: ShellPermissionApproval;
  turnContext?: TurnInputContextSignals;
  recentPlanToolActivity?: PlanToolActivitySummary[];
  attemptedPlanWriteTargets?: string[];
}

async function executeToolCallWithLifecycle(
  tc: ToolCallToExecute,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
  options: ExecuteToolLifecycleOptions = {},
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

  const shellReadValidationErrorBeforeContract = buildShellReadValidationError(
    tc,
    toolArgs,
    callbacks,
  );
  if (shellReadValidationErrorBeforeContract) {
    return shellReadValidationErrorBeforeContract;
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
  const baseResolvedArgs =
    tc.name === "read_file" && typeof compatArgs.path === "string"
      ? {
          ...compatArgs,
          path: resolveProtocolPackageReadPath(compatArgs.path, callbacks.getSkills(), workspace),
        }
      : compatArgs;
  const resolvedArgs =
    tc.name === "web_search" && typeof baseResolvedArgs.provider !== "string"
      ? {
          ...baseResolvedArgs,
          provider: callbacks.getWebSearchProvider?.() || "duckduckgo",
        }
      : baseResolvedArgs;
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
    {
      turnContext: options.turnContext,
      recentToolActivity: options.recentPlanToolActivity,
      attemptedTargets: options.attemptedPlanWriteTargets,
    },
  );
  if (planArtifactValidationError) {
    return planArtifactValidationError;
  }

  const loopDetectionValidationError = buildLoopDetectionValidationError(
    tc,
    resolvedArgs,
    callbacks,
  );
  if (loopDetectionValidationError) {
    return loopDetectionValidationError;
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

  const mutationVerificationPath = resolveMutationVerificationPath(tc.name, resolvedArgs);
  const shouldCaptureMutationDiff =
    !!mutationVerificationPath &&
    supportsToolDiffPreview(tc.name) &&
    !isEphemeralPlanArtifactPath(mutationVerificationPath);
  const mutationBeforeDiffSnapshot = shouldCaptureMutationDiff && mutationVerificationPath
    ? await readMutationDiffSnapshot({
        path: mutationVerificationPath,
        workspace,
        sessionKey,
        allowExternalLocalRead: options.allowExternalLocalRead === true,
      })
    : null;
  const diffPreview = isEphemeralPlanArtifactMutation(tc.name, resolvedArgs)
    ? undefined
    : await buildToolDiffPreview(tc.name, resolvedArgs, { workspace, sessionKey });
  callbacks.onToolExecuting(tc.name, target, diffPreview, { toolCallId: tc.id });
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
    const mutationAfterDiffSnapshot = shouldCaptureMutationDiff && mutationVerificationPath
      ? await readMutationDiffSnapshot({
          path: mutationVerificationPath,
          workspace,
          sessionKey,
          allowExternalLocalRead: options.allowExternalLocalRead === true,
        })
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

    let finalContent = modelContent;
    let finalDisplayContent = displayContent;
    let finalQualityGateReason: string | undefined;
    let finalPlanRecoveryAction: PlanArtifactRecoveryAction | undefined;
    let finalMissingPlanSections: string[] | undefined;
    let isInternalFeedback = false;

    const path = typeof resolvedArgs.path === "string" ? resolvedArgs.path : "";
    const kind = path ? detectPlanArtifactKind(path) : null;
    if (kind && kind !== "tasks" && PLAN_ARTIFACT_MUTATION_TOOLS.has(tc.name)) {
      const nextContent = typeof resolvedArgs.content === "string" ? resolvedArgs.content : "";
      const validation = kind === "plan"
        ? validateActionablePlanArtifact(nextContent)
        : validatePlanArtifactContent(nextContent, kind);
      if (!validation.ok) {
        const qualityResult = kind === "plan"
          ? validation as PlanArtifactQualityResult
          : null;
        const recoveryAction = qualityResult?.recoveryAction || "rewrite";
        const missingSections = qualityResult?.missingSections || [];
        logAgentEvent("plan_artifact_quality_rejected", {
          path,
          kind,
          tool: tc.name,
          reason: validation.reason || "quality_gate",
          recoveryAction,
          missingSections,
          canAutoRepair: qualityResult?.canAutoRepair ?? false,
        });

        const shouldUseInternalFeedback =
          kind === "plan" &&
          !callbacks.getIsPlanApproved();

        const language = callbacks.getPreferredLanguage();
        const recoveryHintZh = recoveryAction === "targeted_evidence"
          ? "这属于证据缺口；runtime 会重新开放一次受限只读补证。下一步只读取一个最相关证据，随后必须回到 plan.md。"
          : recoveryAction === "auto_scaffold"
          ? "这属于低质量草稿；runtime 会给出最小计划脚手架，请按脚手架重写 plan.md。"
          : "这属于结构重写问题；不要继续读文件，直接补齐缺失章节并重写 plan.md。";
        const recoveryHintEn = recoveryAction === "targeted_evidence"
          ? "This is an evidence gap; runtime will reopen one limited read-only recovery pass. Read exactly one relevant evidence target, then return to plan.md."
          : recoveryAction === "auto_scaffold"
          ? "This is a low-quality draft; runtime will provide a minimal plan scaffold. Rewrite plan.md from that scaffold."
          : "This is a structural rewrite issue; do not read more files, add the missing sections and rewrite plan.md.";
        const missingHint = missingSections.length > 0
          ? ` missingSections=${missingSections.join(",")};`
          : "";

        const feedbackMessage = language === "zh"
          ? shouldUseInternalFeedback
            ? `[WARNING] ${path} 已成功写入并保存到磁盘。但是，当前内容未达到 Codex App 式可审批 plan.md 的完美质量要求（原因：${validation.reason || "质量不足"}；recovery=${recoveryAction};${missingHint}）。不要把猜测或调试日志建议写成计划；请在下一步中增量编辑 plan.md 补齐缺失章节，并确保每个改动有具体依据。${recoveryHintZh}`
            : `[WARNING] ${path} 已成功写入并保存到磁盘。但是，其内容不像可审批的正式计划（原因：${validation.reason || "质量不足"}）。`
          : shouldUseInternalFeedback
          ? `[WARNING] ${path} has been successfully written and saved to disk. However, the content does not yet meet the Codex app-style reviewable plan.md requirements (${validation.reason || "quality gate"}; recovery=${recoveryAction};${missingHint}). Do not turn guesses or debug-log advice into the plan; please incrementally edit plan.md in the next step to add the missing sections and ground each change in concrete evidence. ${recoveryHintEn}`
          : `[WARNING] ${path} has been successfully written and saved to disk. However, the content does not look like a reviewable plan artifact (${validation.reason || "quality gate"}).`;

        finalContent = `${modelContent}\n\n${feedbackMessage}`;
        finalDisplayContent = `${displayContent}\n\n${feedbackMessage}`;
        finalQualityGateReason = validation.reason || "quality_gate";
        finalPlanRecoveryAction = recoveryAction;
        finalMissingPlanSections = missingSections;
        isInternalFeedback = shouldUseInternalFeedback;
      }
    }

    const completedDiffPreview =
      buildMutationDiffPreviewFromSnapshots({
        toolName: tc.name,
        target,
        before: mutationBeforeDiffSnapshot,
        after: mutationAfterDiffSnapshot,
      }) || diffPreview;
    callbacks.onToolDone(tc.name, target, finalDisplayContent, { toolCallId: tc.id, diff: completedDiffPreview });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: finalContent,
      displayContent: finalDisplayContent,
      isError: false,
      lifecycleState: "completed",
      ...(finalQualityGateReason ? { qualityGateReason: finalQualityGateReason } : {}),
      ...(finalPlanRecoveryAction ? { planRecoveryAction: finalPlanRecoveryAction } : {}),
      ...(finalMissingPlanSections ? { missingPlanSections: finalMissingPlanSections } : {}),
      ...(isInternalFeedback ? { internalFeedback: true } : {}),
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
    if (isOptionalTasksMdRead(tc.name, target) && isMissingOptionalTasksMdReadError(errorMsg)) {
      const optionalMessage = buildOptionalTasksMdMissingResult(callbacks.getPreferredLanguage(), target);
      callbacks.onToolDone(tc.name, target, optionalMessage, { toolCallId: tc.id });
      const postHookResult = await runLifecycleHooks(callbacks, hooksConfig, "PostToolUse", {
        toolName: tc.name,
        toolArgs: resolvedArgs,
        toolResult: optionalMessage,
        isError: false,
        workspace,
        workflowMode: callbacks.getWorkflowMode(),
        language: callbacks.getPreferredLanguage(),
        associatedPaths: callbacks.getAssociatedPaths(),
      });
      return {
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: optionalMessage,
        displayContent: optionalMessage,
        isError: false,
        lifecycleState: "completed",
        additionalContexts: [
          ...preHookResult.additionalContexts,
          ...postHookResult.additionalContexts,
        ],
      };
    }
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

export async function autoMaterializePlanArtifactFromVisibleText(input: {
  visibleText: string;
  workspace: string;
  callbacks: OrchestratorCallbacks;
  userGoal?: string;
  recentToolActivity?: PlanToolActivitySummary[];
  attemptedTargets?: string[];
  turnContext?: TurnInputContextSignals;
}): Promise<PlanMaterializationResultForLoop> {
  const closureInput = collectPlanClosureMaterializationInput(
    input.callbacks,
    input.recentToolActivity || [],
    input.attemptedTargets || [],
    input.userGoal || "",
  );
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: input.visibleText,
    planStage: input.callbacks.getPlanStage(),
    userGoal: closureInput.userGoal || getOriginalUserPromptForPlanFallback(input.callbacks),
    evidence: closureInput.evidence,
    evidenceRecords: closureInput.evidenceRecords,
    files: closureInput.files,
    recentToolActivity: input.recentToolActivity,
    turnContext: input.turnContext,
    language: input.callbacks.getPreferredLanguage(),
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
export async function executeReadOnlyToolsConcurrently(
  toolCalls: Array<ToolCallToExecute & { allowExternalLocalRead?: boolean }>,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
  options: Pick<ExecuteToolLifecycleOptions, "turnContext" | "recentPlanToolActivity" | "attemptedPlanWriteTargets"> = {},
): Promise<ToolExecutionResult[]> {
  const promises = toolCalls.map(tc =>
    executeToolCallWithLifecycle(tc, workspace, callbacks, allTools, hooksConfig, {
      allowExternalLocalRead: tc.allowExternalLocalRead === true,
      turnContext: options.turnContext,
      recentPlanToolActivity: options.recentPlanToolActivity,
      attemptedPlanWriteTargets: options.attemptedPlanWriteTargets,
    }),
  );
  return Promise.all(promises);
}

export async function executeLocalFileReadToolWithReview(
  tc: ToolCallToExecute,
  toolArgs: Record<string, unknown>,
  localFileReadPath: string,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
): Promise<ToolExecutionResult> {
  const target = getToolTarget(tc.name, toolArgs);

  let decision: ReviewDecision;
  try {
    decision = await callbacks.requestReview({
      toolCallId: tc.id,
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

export function buildPlanGateBlockedResult(
  tc: ToolCallToExecute,
  toolArgs: Record<string, unknown>,
  callbacks: OrchestratorCallbacks,
  reason: "pre_approval_source_write" | "pre_approval_tasks" | "missing_tasks_before_source",
): ToolExecutionResult {
  const target = getToolTarget(tc.name, toolArgs);
  const language = callbacks.getPreferredLanguage();
  const message = language === "zh"
    ? reason === "pre_approval_tasks"
      ? "PLAN 阶段尚未批准，不能提前生成 `.MAIN/plans/tasks.md`。请先完成 plan.md 草稿并等待用户批准。"
      : reason === "missing_tasks_before_source"
      ? "计划已批准，但还没有可执行的任务清单。请先从 plan.md 派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再按任务修改源码或交付文档。"
      : "PLAN 阶段尚未批准，不能修改源码或项目交付文件。请先用 write_file 或 replace_in_file 写入可审批的 `.MAIN/plans/plan.md`；必要时可用 `.MAIN/plans/design.md` 记录证据归因。"
    : reason === "pre_approval_tasks"
    ? "PLAN mode is not approved yet, so `.MAIN/plans/tasks.md` must not be generated. Create a plan.md draft and wait for approval first."
    : reason === "missing_tasks_before_source"
    ? "The plan is approved, but there is no executable task list yet. First derive a runtime task list from plan.md; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs before editing source or final deliverables."
    : "PLAN mode is not approved yet, so source or deliverable files cannot be modified. First use write_file or replace_in_file to write a reviewable `.MAIN/plans/plan.md`; use `.MAIN/plans/design.md` only when evidence tradeoffs need a short ledger.";

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
  options: {
    turnContext?: TurnInputContextSignals;
    recentToolActivity?: PlanToolActivitySummary[];
    attemptedTargets?: string[];
  } = {},
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
    let validation = kind === "plan"
      ? validateActionablePlanArtifact(nextContent)
      : validatePlanArtifactContent(nextContent, kind);
    if (
      kind === "plan" &&
      !validation.ok &&
      tc.name === "write_file" &&
      typeof args.content === "string"
    ) {
      const originalReason = validation.reason || "quality_gate";
      const closureInput = collectPlanClosureMaterializationInput(
        callbacks,
        options.recentToolActivity || [],
        options.attemptedTargets || [],
      );
      const canonicalized = materializePlanArtifactFromVisibleText({
        visibleText: nextContent,
        planStage: callbacks.getPlanStage(),
        userGoal: closureInput.userGoal || getOriginalUserPromptForPlanFallback(callbacks),
        evidence: closureInput.evidence,
        evidenceRecords: closureInput.evidenceRecords,
        files: closureInput.files,
        recentToolActivity: options.recentToolActivity,
        turnContext: options.turnContext,
        language,
      });
      if (canonicalized.ok && canonicalized.content) {
        const canonicalValidation = validateActionablePlanArtifact(canonicalized.content);
        if (canonicalValidation.ok) {
          args.content = canonicalized.content;
          tc.arguments = JSON.stringify({ ...args, content: canonicalized.content });
          nextContent = canonicalized.content;
          validation = canonicalValidation;
          logAgentEvent("plan_artifact_quality_canonicalized", {
            path,
            kind,
            tool: tc.name,
            originalReason,
          });
        }
      }
    }
    if (
      kind === "plan" &&
      !validation.ok &&
      validation.canAutoRepair &&
      tc.name === "write_file" &&
      typeof args.content === "string"
    ) {
      const repaired = repairActionablePlanArtifactContent({
        content: nextContent,
        userGoal: getOriginalUserPromptForPlanFallback(callbacks),
        quality: validation,
        language,
      });
      if (repaired.repairedSections.length > 0) {
        const repairedValidation = validateActionablePlanArtifact(repaired.content);
        if (repairedValidation.ok) {
          args.content = repaired.content;
          tc.arguments = JSON.stringify({ ...args, content: repaired.content });
          nextContent = repaired.content;
          validation = repairedValidation;
          logAgentEvent("plan_artifact_quality_auto_repaired", {
            path,
            kind,
            tool: tc.name,
            repairedSections: repaired.repairedSections,
          });
        }
      }
    }
    if (!validation.ok) {
      return null;
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
export async function executeWriteToolWithReview(
  tc: ToolCallToExecute,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
  options: Pick<ExecuteToolLifecycleOptions, "turnContext" | "recentPlanToolActivity" | "attemptedPlanWriteTargets"> & { skipUserReview?: boolean } = {},
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
  const mutationPreflight = await preflightWorkspaceMutation({
    toolName: tc.name,
    args: toolArgs,
    language: callbacks.getPreferredLanguage(),
    readFile: async (path) => String(await executeTool("read_file", { path, __raw: true }, workspace, callbacks.getSessionKey()) ?? ""),
  });
  if (!mutationPreflight.ok) {
    logAgentEvent("workspace_mutation_preflight_blocked", {
      tool: tc.name,
      target,
      reason: mutationPreflight.reason,
    });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: `Error: ${mutationPreflight.message || "MUTATION_PREFLIGHT_BLOCKED"}`,
      isError: true,
      lifecycleState: "blocked",
    };
  }

  const shellApprovalResolution = await resolveShellAutoApproval({
    toolName: tc.name,
    args: toolArgs,
    workspace,
    preflight: shellPermissionPreflight,
  });
  if (shellApprovalResolution.error) {
    logAgentEvent("shell_permission_preflight_failed", {
      tool: tc.name,
      target,
      command: shellApprovalResolution.command,
      error: shellApprovalResolution.error,
    });
  } else if (shellApprovalResolution.decision) {
    logAgentEvent("shell_permission_preflight", {
      tool: tc.name,
      target,
      command: shellApprovalResolution.command,
      decision: shellApprovalResolution.decision.decision,
      requiresApproval: shellApprovalResolution.decision.requiresApproval,
      riskLevel: shellApprovalResolution.decision.riskLevel || null,
      suggestedRule: shellApprovalResolution.decision.suggestedRule || null,
      suggestedRules: shellApprovalResolution.decision.suggestedRules || [],
    });
  }

  if (shellApprovalResolution.decision?.decision === "deny") {
    const deniedRule =
      shellApprovalResolution.decision.matchedRule ||
      shellApprovalResolution.decision.segmentDecisions.find((segment) => segment.decision === "deny")?.matchedRule ||
      "";
    const message = callbacks.getPreferredLanguage() === "zh"
      ? `命令被 shell 权限策略拒绝: \`${shellApprovalResolution.decision.command}\`${deniedRule ? ` matches \`${deniedRule}\`` : ""}`
      : `Shell permission policy denied command: \`${shellApprovalResolution.decision.command}\`${deniedRule ? ` matches \`${deniedRule}\`` : ""}`;
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

  if (options.skipUserReview) {
    logAgentEvent("session_auto_review_applied", {
      tool: tc.name,
      target,
      shellPermissionCommand: shellApprovalResolution.command,
      shellPermissionDecision: shellApprovalResolution.decision?.decision || null,
      shellPermissionApprovalAttached: !!shellApprovalResolution.approval,
    });
    return await executeToolCallWithLifecycle(
      tc,
      workspace,
      callbacks,
      allTools,
      hooksConfig,
      {
        shellPermissionApproval: shellApprovalResolution.approval,
        turnContext: options.turnContext,
        recentPlanToolActivity: options.recentPlanToolActivity,
        attemptedPlanWriteTargets: options.attemptedPlanWriteTargets,
      },
    );
  }

  let decision: ReviewDecision;
  try {
    const browserRisk = tc.name === "browser_evaluate" ? "browser_control" : undefined;
    decision = await callbacks.requestReview({
      toolCallId: tc.id,
      name: tc.name,
      arguments: toolArgs,
      ...(browserRisk ? { risk: browserRisk } : {}),
      ...(shellApprovalResolution.decision ? { shellPermissionDecision: shellApprovalResolution.decision } : {}),
    });
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
      {
        shellPermissionApproval: decision.shellPermissionApproval,
        turnContext: options.turnContext,
        recentPlanToolActivity: options.recentPlanToolActivity,
        attemptedPlanWriteTargets: options.attemptedPlanWriteTargets,
      },
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

export const MAX_RECENT_PLAN_TOOL_ACTIVITY = 12;
export const CONCISE_PLAN_ARTIFACT_HINT_ZH =
  "计划文档必须精简：plan.md 60-120 行；可选 design.md 40-80 行；如确需持久化 tasks.md，保持 8-20 个 checkbox。不要写教程式长文、完整代码清单或重复背景。Proposal 只做一页审阅摘要。";
export const CONCISE_PLAN_ARTIFACT_HINT_EN =
  "Keep plan artifacts concise: plan.md 60-120 lines; optional design.md 40-80 lines; if tasks.md must be persisted, keep it to 8-20 checkboxes. Do not write tutorial-style prose, full code listings, or repeated background. The Proposal should be a one-page review summary.";

export function logAgentEvent(event: string, data: Record<string, unknown> = {}) {
  try {
    console.info(`[agent.${event}]`, data);
  } catch {
    // Logging must never affect the agent loop.
  }
}

export function compactDiagnosticText(value: unknown, maxChars = 260): string {
  const text = String(value ?? "")
    .replace(/\[MAIN_TOOL_FEEDBACK_V1\]\{[^\n]*\}/g, "[tool-feedback-envelope]")
    .replace(/"tool_call_id"\s*:\s*"[^"]*"/gi, "\"tool_call_id\":\"[redacted]\"")
    .replace(/\btool_call_id\s*[:=]\s*[^\s,;}]+/gi, "tool_call_id=[redacted]")
    .replace(/\bhash\s*[:=]\s*[a-f0-9]{6,}/gi, "hash=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}...`;
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

export function summarizeMessagesForDiagnostics(messages: AgentMessage[]): Record<string, unknown> {
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

export function summarizeToolsForDiagnostics(tools: ToolDefinition[]): Record<string, unknown> {
  let schemaChars = 0;
  try {
    schemaChars = JSON.stringify(tools).length;
  } catch {
    schemaChars = 0;
  }
  return {
    count: tools.length,
    schemaChars,
    estimatedSchemaTokens: Math.ceil(schemaChars / 4),
  };
}

export * from "./orchestrator/types";
export { executeAgentLoop, AgentOrchestrator } from "./orchestrator/loop/AgentOrchestrator";

export { isReasoningModelName } from "./orchestrator/agentRecovery";
