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
import { compactContextForExecuteRecovery, computeContextBudgets, estimateMessagesTokens, estimateTokens, manageContext } from "./contextTrim";
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
  hasExecutableProposalReplyOptions,
  hasOnlyNonBlockingPlanReplyOptions,
  hasOnlyReadOnlyPermissionReplyOptions,
  serializeAssistantReplyForHistory,
  shouldAutoContinueReadOnlyPermission as shouldAutoContinueReadOnlyPermissionState,
  shouldPauseForReplyOptions,
  shouldRouteUnapprovedPlanReplyOptionsToArtifact,
  stripReadOnlyPermissionPrompt,
} from "./replyOptions";
import { buildToolDiffPreview, type ToolDiffPreview } from "./toolDiff";
import { preflightWorkspaceMutation } from "./workspaceMutationPreflight";
import { summarizeApplyPatchTarget } from "./applyPatchTool";
import { syncPlanArtifactAfterToolSuccess } from "./planArtifactSync";
import {
  buildReadFileWindowContinuationGuidance,
  planReadFileWindowCoverage,
} from "./readFileWindow";
import {
  FILE_UNCHANGED_STUB,
  buildFileReadSignature,
  buildFileUnchangedStub,
  buildOptionalTasksMdMissingResult,
  formatReadFileWindowCoverageStub,
  formatReadFileWindowNarrowedNote,
  getReadFileCoverageForPath,
  getSessionFileReadStates,
  hashString,
  isMissingOptionalTasksMdReadError,
  isOptionalTasksMdRead,
  pruneFileReadStates,
} from "./orchestrator/fileReadCache";
import {
  buildExecuteNoActionPauseMessage,
  buildLanguageMismatchRecoveryPrompt,
  buildMalformedToolUseRecoveryPrompt,
  buildPseudoToolCallRecoveryPrompt,
  buildReasoningDominatedPauseMessage,
  buildReasoningDominatedRecoveryPrompt,
  buildToolProtocolDoomLoopStopMessage,
  buildToolUnavailableRecoveryPrompt,
  choosePseudoToolRecovery,
  containsToolNameParameterFallback,
  containsToolUseBlock,
  extractPseudoToolCallName,
  extractUserMentionedFilePathsFromMessages,
  isReasoningDominatedLengthResult,
  isReasoningDominatedNoActionResult,
  looksLikeNonStandardToolCallFormat,
  looksLikePseudoToolCallPlaceholder,
  looksLikeToolUnavailableClaim,
  shouldRecoverLanguageMismatchTurn,
  summarizeProtocolFragmentForLog,
} from "./orchestrator/agentRecovery";
import {
  UNITY_FALLBACK_RECOVERY_READ_ONLY_TOOL_NAMES,
  annotateUnityEditToolDescriptions,
  buildUnityApplyTextPolicyBlockedMessage,
  extractMcpCallFailureCategory,
  isUnityCommandDirective,
  isUnityConsoleDiagnosticsDirective,
  isUnityExecutionContext,
  isUnityLikelyServer,
  isUnityScriptWriteToolCall,
  resolveUnityScriptPathFromArgs,
  shouldRepromptBeforeUnityConsoleFallback,
  shouldTriggerUnityMcpFirstIterationFallback,
} from "./orchestrator/unityDiagnostics";
import {
  buildPlanAutoScaffoldPrompt,
  buildPlanEvidenceRecoveryBlockedPrompt,
  buildPlanEvidenceRecoveryClosurePrompt,
  buildPlanFallbackNotice,
  buildPlanPostConvergenceToolRedirectPrompt,
  buildPlanReadOnlyConvergencePause,
  buildPlanReadOnlyConvergencePrompt,
  buildPlanRecoveryPromptFromContext,
  buildPlanStreamTimeoutPauseMessage,
  countSuccessfulPlanReadEvidence,
  hasGroundedPlanClosureEvidence,
  hasSuccessfulTabularActivity,
  planRuntimePhasePresentation,
  resolvePlanClosureArtifactKind,
} from "./orchestrator/planOrchestration";

export {
  buildPseudoToolCallRecoveryPrompt,
  extractPseudoToolCallName,
  isReasoningDominatedLengthResult,
  isReasoningDominatedNoActionResult,
  looksLikeNonStandardToolCallFormat,
  looksLikePseudoToolCallPlaceholder,
  recoverPseudoToolCallFromContext,
  shouldRecoverLanguageMismatchTurn,
} from "./orchestrator/agentRecovery";
export {
  shouldRepromptBeforeUnityConsoleFallback,
  shouldTriggerUnityMcpFirstIterationFallback,
} from "./orchestrator/unityDiagnostics";
export {
  buildPlanReadOnlyConvergencePrompt,
} from "./orchestrator/planOrchestration";
import {
  initialLifecycleStateForPlanAction,
  planRuntimeToolCall,
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
  looksLikeSubstantivePlanAssistantText,
  repairActionablePlanArtifactContent,
  validateActionablePlanArtifact,
  validatePlanArtifactContent,
  type PlanArtifactQualityResult,
  type PlanArtifactRecoveryAction,
  type PlanExecutionEvidenceEntry,
  type PlanExecutionProgressPhase,
  type PlanExecutionProgressUpdate,
  type PlanRuntimePhase,
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
  registerTargetProgressEventForLoopGuard,
  registerToolCallForRepeatGuard,
  type TargetProgressOutcome,
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
  resolveReasoningPolicy,
  resolveEffectiveCloudApiFormat,
  type CloudToolProtocol,
  type ModelReasoningMode,
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
  buildPlanNoProgressLoopPauseNotice,
  buildPlanProgressSignatureFromToolActivity,
  buildPlanMaxIterationsCheckpoint,
  buildPlanMaxIterationsPauseNotice,
  isCachedReadOnlyPlanActivity,
  summarizeRepeatedPlanTargetsFromToolActivity,
  type PlanMaxIterationsCheckpoint,
  type PlanToolActivitySummary,
} from "./planExecutionRecovery";
import {
  describeApprovedPlanRecoveryToolSurface,
  describeApprovedPlanSourceEditFirstToolSurface,
  isApprovedPlanCachedReadOnlyNoProgressBatch,
  isApprovedPlanRecoveryToolName,
  isApprovedPlanSourceEditFirstToolName,
  shouldBypassApprovedPlanReadCacheForPatchRecovery,
  shouldAllowApprovedPlanRecoveryFileRead,
} from "./approvedPlanRecoveryTools";
import {
  buildExecuteNoProgressLoopPauseNotice,
  buildExecuteRecoveryPrompt,
  describeExecuteRecoveryToolSurface,
  isExecuteRecoveryToolName,
  normalizeExecuteRecoveryMode,
  resolveExecuteReadOnlyRecoveryTrigger,
  resolveReadOnlyNoProgressTrigger,
  shouldAllowExecuteRecoveryFileRead,
  summarizeRepeatedExecuteTargets,
  type ExecuteRecoveryMode,
} from "./executeRecoveryTools";
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
  composePlanArtifactFromEvidence,
  composeReviewablePlanFromEvidence,
  materializePlanArtifactFromVisibleText,
  sanitizePlanEvidenceInput,
  summarizePlanEvidenceDetail,
  type PlanEvidenceRecord,
  type PlanMaterializationSource,
} from "./planMaterialization";
import { formatToolPresentation } from "./toolPresentation";
import {
  buildPlanReadOnlyProgressNarration,
  buildToolCallsProgressNarration,
  progressNarrationToText,
  type ProgressNarration,
} from "./progressNarration";
import {
  buildEmptyModelResponsePauseNotice,
  buildMaxStepsFinalTextPrompt,
  buildMaxStepsToolCallIgnoredNotice,
  resolveAgentLoopMaxIterations,
  shouldUseMaxStepsFinalTextOnly,
  type AgentLoopIterationLimits,
} from "./agentLoopSafety";
import { shouldUseRustProxyForLocalProvider } from "./localProviderRouting";
import type { ShellPermissionApproval } from "./ipc";
import {
  buildTaskTargetingProfile,
  getTaskTargetingEvidenceKey,
  shouldBlockToolCallForTargeting,
  type TaskOrchestratorPhase,
} from "./taskTargeting";
import {
  assessPlanEvidenceReadiness,
  isPlanReadOnlyToolName,
  shouldTriggerPlanReadOnlyConvergence,
} from "./planReadOnlyConvergence";
import {
  buildPlanEvidenceBlockedPauseMessage,
  buildPlanTargetedEvidenceRecoveryPrompt,
  filterPlanToolNamesForRuntimePhase,
  isPlanDraftWriteToolName,
  resolvePlanNoActionRecovery,
  resolvePlanSuppressedToolRecovery,
  shouldClosePlanToolSurfaceAfterReadOnlyConvergence,
  shouldRedirectPlanToolsAfterReadOnlyConvergence,
} from "./planRuntime";
import {
  extractPrimaryUserRequestText,
  extractTurnInputContextSignalsFromMessages,
  normalizeTurnInputContextSignals,
  type TurnInputContextSignals,
} from "./turnIntake";

// ── Spec file auto-approval helpers ────────────────────────────────

const PRE_APPROVAL_PLAN_FILE_NAMES = new Set(["requirements.md", "plan.md", "design.md"]);
const EXECUTION_PLAN_FILE_NAMES = new Set(["requirements.md", "plan.md", "tasks.md"]);
const PLAN_ARTIFACT_MUTATION_TOOLS = new Set(["write_file", "replace_in_file", "apply_patch"]);
const PLAN_REPEAT_READ_LIMIT = 3;
const PLAN_EXPLORATION_READ_ONLY_TOOLS = new Set([
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
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
  "get_file_outline",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);
const EXECUTION_VERIFICATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "execute_command",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

const EDIT_PROGRESS_TOOL_NAMES = new Set(["write_file", "replace_in_file", "apply_patch"]);
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

function hasPlanUserContextObservation(messages: AgentMessage[], latestAssistantText = ""): boolean {
  const assistantTexts = messages
    .filter((message) => message.role === "assistant")
    .map((message) => getMessageContentText(message.content))
    .concat(latestAssistantText)
    .join("\n");
  return /(?:截图观察|从截图(?:中)?(?:我)?观察到|图片中可见|图\s*\d|screenshot observations|screenshot shows|image shows|visible in the provided image)/i.test(assistantTexts);
}

function filterPlanRuntimeToolDefinitionsForPhase(input: {
  tools: ToolDefinition[];
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  planRuntimePhase?: PlanRuntimePhase;
}): ToolDefinition[] {
  const names = new Set(filterPlanToolNamesForRuntimePhase({
    toolNames: input.tools.map((tool) => tool.function.name),
    workflowMode: input.workflowMode,
    isPlanApproved: input.isPlanApproved,
    planRuntimePhase: input.planRuntimePhase,
  }));
  if (names.size === input.tools.length) return input.tools;
  return input.tools.filter((tool) => names.has(tool.function.name));
}

function planUnsupportedToolFeedbackMessage(input: {
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

  return input.language === "zh"
    ? `工具 "${input.toolName}" 当前没有暴露给 ${input.runtimeIntent} 运行意图。请使用本轮可用工具；如果这是已批准计划的执行步骤，请继续按执行阶段恢复。`
    : `Tool "${input.toolName}" is not exposed for the current ${input.runtimeIntent} runtime intent. Use an available tool; if this is approved plan execution, continue from the execution stage.`;
}

function computeContextForceReason(input: {
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
  if (name === "get_project_skeleton" || name === "glob_search" || name === "grep_search" || name.startsWith("repo_map_")) {
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
export function buildShellReadValidationError(
  tc: ToolCallToExecute,
  args: Record<string, unknown>,
  callbacks: OrchestratorCallbacks,
): ToolExecutionResult | null {
  if (tc.name !== "run_command" && tc.name !== "execute_command") return null;
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return null;

  const isShellRead = /^(?:cat|head|tail|sed)\b/.test(command) || /\b(?:cat|head|tail)\s+[^&|>;]+/.test(command);
  if (isShellRead) {
    const language = callbacks.getPreferredLanguage();
    const message = language === "zh"
      ? `SHELL_READ_FORBIDDEN: 禁止通过终端命令 (${command}) 直接读取文件内容以防止上下文过载。请改用内置的 read_file 工具并指定 start_line / max_lines 参数进行分页定向读取。`
      : `SHELL_READ_FORBIDDEN: Reading files via terminal commands (${command}) is disabled to prevent context overload. Please use the built-in read_file tool with start_line / max_lines for paged reading.`;
    const target = getToolTarget(tc.name, args);
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
  let repetitions = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const c = call as { function?: { name?: string; arguments?: string } };
        if (c.function?.name === "write_file" || c.function?.name === "replace_in_file" || c.function?.name === "read_file") {
          try {
            const parsed = JSON.parse(c.function.arguments || "{}");
            const parsedPath = (parsed.path || parsed.TargetFile || "").trim();
            if (parsedPath === path) {
              repetitions++;
            }
          } catch {
            // Ignore malformed JSON
          }
        }
      }
    }
    if (repetitions >= 6) break;
  }

  if (repetitions >= 5) {
    const language = callbacks.getPreferredLanguage();
    const message = language === "zh"
      ? `LOOP_DETECTED: 检测到你在文件 ${path} 上执行了多次重复的读取/修改操作。为防止死循环，本次调用已拦截。请暂停并在正文中解释为什么之前的改动未能成功应用（如编译错误或环境问题），然后使用 <user_options> 请用户确认方向。`
      : `LOOP_DETECTED: Detected multiple repetitive read/write operations on ${path}. To prevent an infinite execution loop, this call has been blocked. Please pause and explain in prose why previous edits failed (e.g. build errors or environment issues), then use <user_options> to ask the user for guidance.`;
    const target = getToolTarget(tc.name, args);
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
  reasoning_content?: string;
  reasoning?: string;
}

function buildAssistantHistoryMessage(
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
  getForcedExecuteRecoveryMode?: () => ExecuteRecoveryMode | null;
  getCommandDirective?: () => CommandDirective | null;
  getWorkflowMode: () => "chat" | "edit" | "plan";
  getIsPlanApproved: () => boolean;
  getPlanApprovalChoice: () => string | null;
  getReadOnlyAutoApproveForSession: () => boolean;
  getApprovedLocalFileReadPaths: () => string[];
  getPlanStage: () => "idle" | "plan" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed";
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
    meta?: { toolCallId?: string },
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
    name: string;
    arguments: Record<string, unknown>;
    risk?: "local_file_read";
    localFileReadPath?: string;
  }) => Promise<ReviewDecision>;
}

// ── Helpers ───────────────────────────────────────────────────────

function deriveStreamSettings(config: AppConfig): StreamSettings {
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
const MAX_NO_ACTION_RETRIES = 2;
const PLAN_EXPLORATION_REPEAT_READ_LIMIT = 1;
const EXECUTE_CONVERGENCE_PROMPT_RATIO = 0.72;
const PLAN_EXECUTE_CONVERGENCE_PROMPT_RATIO = 0.24;
const MAX_NO_PROGRESS_LOOP_REPEATS = 5;
const MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS = 2;
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

function buildNoProgressBatchSignature(results: ToolExecutionResult[]): string {
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

function isApprovedPlanRecoveryTool(
  tool: ToolDefinition,
  options: { allowFileRead?: boolean } = {},
): boolean {
  const name = tool.function.name;
  if (name === "read_file") return true;
  return isApprovedPlanRecoveryToolName(name, PLAN_EXPLORATION_READ_ONLY_TOOLS, options);
}

function isApprovedPlanSourceEditFirstTool(
  tool: ToolDefinition,
  options: { allowFileRead?: boolean } = {},
): boolean {
  if (tool.function.name === "read_file") return true;
  return isApprovedPlanSourceEditFirstToolName(tool.function.name, options);
}

function isSourceFileEvidencePath(value: string): boolean {
  const normalized = String(value || "").replace(/\\/g, "/").trim();
  return /^(?:src|app|lib|components|hooks|store|styles|utils|pages|server|client|packages|apps)\//i.test(normalized) &&
    /\.(?:tsx?|jsx?|css|scss|json|py|rs|go|swift|vue|svelte)$/i.test(normalized) &&
    !/\.MAIN\/plans\//i.test(normalized);
}

function approvedPlanNeedsSourceEditBeforeValidation(
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
    ? `模型刚才把约 ${formatted} 个字符的代码作为聊天正文输出了，但没有通过写入工具落到真实文件。为避免界面卡死，我已将这段超长正文收起；接下来会强制它改用 \`apply_patch\` / \`write_file\` / \`replace_in_file\` 写入项目文件。`
    : `The model just produced about ${formatted} characters of code as chat text instead of writing real files. To keep the UI responsive, I compacted that oversized reply and will force the next step to use \`apply_patch\` / \`write_file\` / \`replace_in_file\` for actual project files.`;
}

function buildNonActionableStopMessage(language: "zh" | "en", reason: "no_output" | "missing_tool_loop" | "incomplete_plan" | "plain_text_execution"): string {
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
        "MAIN 会临时收窄工具面：宽泛读取会被收起，只保留写入、命令、浏览器验证和少量定向定位工具。",
        "请先根据已有工具结果判断任务是否已经完成：如果完成，直接输出最终总结并停止，不要再调用工具。",
        "如果仍未完成，只调用一个最小必要的下一步动作工具；不要重复读取、重复验证或继续改同一个目标而没有新证据。",
      ].join("\n")
    : [
        `This Execute turn has reached ${iteration}/${maxIterations} tool-loop iterations and is approaching the safety boundary.`,
        "MAIN will temporarily narrow the tool surface: broad reads are withheld, leaving write, command, browser validation, and lightweight targeting tools.",
        "First decide from existing tool results whether the task is already complete. If it is complete, output the final summary and stop without more tools.",
      "If it is not complete, call exactly one smallest necessary action tool. Do not repeat reads, repeat validation, or keep editing the same target without new evidence.",
    ].join("\n");
}

function looksLikePlanCompletionClaim(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /(?:全部|所有|全[部都]?|已|已经).{0,24}(?:完成|满足|通过)|(?:任务|证据).{0,16}(?:全部|全都).{0,16}(?:完成|满足|通过)|\b\d+\s*\/\s*\d+\b.{0,24}(?:完成|complete|completed|done|satisfied|passed)/i.test(normalized) ||
    /(?:all|every).{0,40}(?:task|evidence|item).{0,40}(?:complete|completed|done|satisfied|passed)|(?:complete|completed|done|satisfied).{0,40}(?:all|every).{0,40}(?:task|evidence|item)/i.test(normalized)
  );
}

function looksLikeOperationCompletionClaim(text: string): boolean {
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

function looksLikeExecutionReplanningText(text: string): boolean {
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

function buildExecuteCompletionEvidencePrompt(language: "zh" | "en", retryCount: number): string {
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

function buildExecuteReplanningEvidencePrompt(language: "zh" | "en", retryCount: number): string {
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

function buildReadOnlyPermissionHardRecoveryPrompt(language: "zh" | "en", workflowMode: "chat" | "edit" | "plan"): string {
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

function buildApprovedPlanNoProgressStrategySwitchPrompt(input: {
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

function getOriginalUserPromptForPlanFallback(callbacks: OrchestratorCallbacks): string {
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

function collectPlanClosureMaterializationInput(
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

function buildPlanClosurePromptFromEvidence(
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

function buildPlanRecoveryPrompt(callbacks: OrchestratorCallbacks, sourceText: string, attemptedTargets: string[] = []): string {
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

function isReviewablePlanStage(stage: ReturnType<OrchestratorCallbacks["getPlanStage"]>): boolean {
  return stage === "plan" || stage === "design" || stage === "bugfix" || stage === "ready_to_execute";
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
        ? "计划已批准，现在进入执行阶段（EXECUTION MODE）。MAIN 已有 runtime 任务清单，TopIsland 会直接显示任务进度；不需要为了第一次源码写入强制创建或读取 `.MAIN/plans/tasks.md`。请按当前任务清单逐项执行，使用 <tool_use> 格式调用工具；只有任务较长、需要跨会话审计或用户明确要求留档时，才先把清单持久化到 tasks.md。不要为了确认 tasks.md 是否存在而读取它；只有它已知存在或你正在同步已有审计文件时，才读取/更新。任何需要 shell 的任务都必须在当前任务清单中保留精确命令并用反引号包裹。如果某个源码文件已经读过，再读只返回 `FILE_UNCHANGED_STUB`，不要重复读取，必须转向 `apply_patch`/`replace_in_file`/`write_file`、运行验证、读取不同目标，或明确暂停说明阻塞。页面渲染验证必须使用 Browser/Playwright DOM 或截图证据，不能用 curl/grep/cat 代替；Tauri/人工验证不可自动完成时要暂停说明待用户验证。你可以正常修改项目源码文件，写入路径必须是项目中的正确位置，绝对不要将源码写入 `.MAIN/plans/` 或任何隐藏目录。只有全部任务都有真实文件/命令/交付物/浏览器证据满足，或剩余项明确待用户验证后，才能结束执行；如果 tasks.md 已存在，完成任务后再同步更新对应 checkbox。\n"
        : "The plan is approved. You are now in EXECUTION MODE. MAIN already has a runtime task list, so TopIsland can show task progress without forcing creation or reads of `.MAIN/plans/tasks.md` before the first source write. Execute the current task list with tool calls; persist the list to tasks.md only when the work is long, cross-session, or explicitly needs an audit file. Do not read tasks.md just to check whether it exists; only read/update it when it is already known to exist or you are syncing an existing audit file. Any task that needs shell work must keep the exact command in the current task list using backticks. If a source file has already been read and another read only returns `FILE_UNCHANGED_STUB`, do not reread it; switch to `apply_patch`/`replace_in_file`/`write_file`, run validation, inspect a different target, or pause with the exact blocker. Rendered-page validation requires Browser/Playwright DOM or screenshot evidence; do not substitute curl/grep/cat. If Tauri or manual validation cannot be automated, pause and report pending user validation. You may now edit project source files, but write them to the proper project paths and never into `.MAIN/plans/` or hidden folders. Only stop when every task has satisfied real file/command/deliverable/browser evidence, or remaining items are explicitly pending user validation; if tasks.md exists, update the matching checkbox after evidence exists.\n"
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
    const isLocal = settings.provider === "Ollama" || settings.provider === "LM Studio" || settings.provider === "OMLX" ||
      String(settings.baseUrl || "").toLowerCase().includes("localhost") ||
      String(settings.baseUrl || "").toLowerCase().includes("127.0.0.1") ||
      String(settings.baseUrl || "").toLowerCase().includes("::1") ||
      String(settings.baseUrl || "").toLowerCase().includes("ollama") ||
      String(settings.baseUrl || "").toLowerCase().includes(":11434");
    const skipReasoningDominatedEscalation = isReasoningDominatedLengthResult(result, isLocal);
    const isChat = options.workflowMode === "chat" || options.runtimeIntent === "respond";
    const allowEscalation = !(isChat && currentMaxTokens >= 4096);
    if (result.finishReason === "length" && escalationCount < MAX_ESCALATIONS && !skipReasoningDominatedEscalation && allowEscalation) {
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

function targetProgressOutcomeForToolResult(result?: ToolExecutionResult): TargetProgressOutcome {
  if (!result) return "failed";
  const diagnostic = getToolResultDiagnosticText(result);
  if (/FILE_UNCHANGED_STUB|empty_change|invalid_patch|identical_content|no changes|no-op|nothing to (?:change|patch|write)/i.test(diagnostic)) {
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

function targetProgressReasonForToolResult(result?: ToolExecutionResult): string {
  const diagnostic = getToolResultDiagnosticText(result)
    .replace(/\s+/g, " ")
    .trim();
  if (!diagnostic) return "missing_result";
  const reason =
    diagnostic.match(/\b(?:reason|error|status)\s*[:=]\s*([^.;\n]{1,100})/i)?.[1] ||
    diagnostic.match(/\b(search_text_mismatch|empty_change|invalid_patch|identical_content|MUTATION_PREFLIGHT_BLOCKED|FILE_UNCHANGED_STUB)\b/i)?.[1] ||
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

function parseToolCallArguments(tc: ToolCallToExecute, workspace?: string | null): Record<string, unknown> {
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
      ? "PLAN_REPEAT_READ_LIMIT: 你正在计划阶段重复读取已经缓存且未变化的上下文。请停止重复读取，直接基于 requirements.md 和已有文件上下文写入 `.MAIN/plans/plan.md`；如果设计方向不明确，用 `<user_options>` 提供用户可点击选择并立刻停止。"
      : "PLAN_REPEAT_READ_LIMIT: 你正在重复读取已经缓存且未变化的上下文。请停止重复读取，转向创建/更新 `.MAIN/plans/plan.md`，或用 `<user_options>` 询问关键分叉。"
    : stage === "requirements"
    ? "PLAN_REPEAT_READ_LIMIT: You are repeating cached unchanged reads during planning. Stop rereading files and write `.MAIN/plans/plan.md` from requirements.md and existing context; if the plan direction is unclear, offer `<user_options>` and stop."
    : "PLAN_REPEAT_READ_LIMIT: You are repeating cached unchanged reads. Stop rereading and create/update `.MAIN/plans/plan.md`, or offer `<user_options>` for the key decision.";
  return `${content}\n\n${guidance}`;
}

function truncateToolContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + `\n...[truncated, ${content.length - maxChars} chars omitted]`;
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
    {
      turnContext: options.turnContext,
      recentToolActivity: options.recentPlanToolActivity,
      attemptedTargets: options.attemptedPlanWriteTargets,
    },
  );
  if (planArtifactValidationError) {
    return planArtifactValidationError;
  }

  const shellReadValidationError = buildShellReadValidationError(
    tc,
    resolvedArgs,
    callbacks,
  );
  if (shellReadValidationError) {
    return shellReadValidationError;
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

    let finalContent = modelContent;
    let finalDisplayContent = displayContent;
    let finalQualityGateReason: string | undefined;
    let finalPlanRecoveryAction: PlanArtifactRecoveryAction | undefined;
    let finalMissingPlanSections: string[] | undefined;
    let isInternalFeedback = false;

    const path = typeof resolvedArgs.path === "string" ? resolvedArgs.path : "";
    const kind = path ? detectPlanArtifactKind(path) : null;
    if (kind && kind !== "tasks") {
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

    callbacks.onToolDone(tc.name, target, finalDisplayContent, { toolCallId: tc.id });
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

async function autoMaterializePlanArtifactFromVisibleText(input: {
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
async function executeReadOnlyToolsConcurrently(
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
      ? "PLAN 阶段尚未批准，不能提前生成 `.MAIN/plans/tasks.md`。请先完成 plan.md 草稿并等待用户批准。"
      : reason === "missing_tasks_before_source"
      ? "计划已批准，但还没有可执行的任务清单。请先从 plan.md 派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再按任务修改源码或交付文档。"
      : "PLAN 阶段尚未批准，不能修改源码或项目交付文件。请先用 write_file 或 replace_in_file 写入可审批的 `.MAIN/plans/plan.md`；requirements.md 仅在确有需求台账时可选生成。"
    : reason === "pre_approval_tasks"
    ? "PLAN mode is not approved yet, so `.MAIN/plans/tasks.md` must not be generated. Create a plan.md draft and wait for approval first."
    : reason === "missing_tasks_before_source"
    ? "The plan is approved, but there is no executable task list yet. First derive a runtime task list from plan.md; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs before editing source or final deliverables."
    : "PLAN mode is not approved yet, so source or deliverable files cannot be modified. First use write_file or replace_in_file to write a reviewable `.MAIN/plans/plan.md`. requirements.md is optional for requirement-ledger cases.";

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
async function executeWriteToolWithReview(
  tc: ToolCallToExecute,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
  options: Pick<ExecuteToolLifecycleOptions, "turnContext" | "recentPlanToolActivity" | "attemptedPlanWriteTargets"> = {},
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

const MAX_RECENT_PLAN_TOOL_ACTIVITY = 12;
const CONCISE_PLAN_ARTIFACT_HINT_ZH =
  "计划文档必须精简：plan.md 60-120 行；可选 requirements.md 40-80 行；如确需持久化 tasks.md，保持 8-20 个 checkbox。不要写教程式长文、完整代码清单或重复背景。Proposal 只做一页审阅摘要。";
const CONCISE_PLAN_ARTIFACT_HINT_EN =
  "Keep plan artifacts concise: plan.md 60-120 lines; optional requirements.md 40-80 lines; if tasks.md must be persisted, keep it to 8-20 checkboxes. Do not write tutorial-style prose, full code listings, or repeated background. The Proposal should be a one-page review summary.";

function logAgentEvent(event: string, data: Record<string, unknown> = {}) {
  try {
    console.info(`[agent.${event}]`, data);
  } catch {
    // Logging must never affect the agent loop.
  }
}

function compactDiagnosticText(value: unknown, maxChars = 260): string {
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

function collectDiagnosticNoiseIndicators(value: unknown): string[] {
  const raw = String(value ?? "");
  const indicators: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["tool_feedback_envelope", /\[MAIN_TOOL_FEEDBACK_V1\]|MAIN\s+TOOL\s+FEEDBACK/i],
    ["tool_call_id", /\btool_call_id\b|\btool call id\b/i],
    ["observed_status", /\bstatus\s*[:=]\s*observed\b/i],
    ["hash_field", /\bhash\s*[:=]/i],
    ["excerpt_field", /\bexcerpt\s*[:=]/i],
    ["context_memory", /ContextMemoryState|ContextState/i],
    ["xml_tool_markup", /<\/?(?:tool_use|tool_call|function_call|tool|parameter)\b/i],
  ];
  for (const [name, pattern] of checks) {
    if (pattern.test(raw)) indicators.push(name);
  }
  return indicators;
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
  const reasoningPolicy = resolveReasoningPolicy({
    activeProfile: config.activeProfile,
    requestedMode: modelProtocolProfile.reasoning,
    reasoningRequest: config.activeProfile === "cloud" ? "auto" : "off",
    reasoningDisplay: config.reasoningDisplay,
    reasoningEffort: settings.reasoningEffort,
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
  {
    const language = callbacks.getPreferredLanguage();
    const userGoal = compactDiagnosticText(getOriginalUserPromptForPlanFallback(callbacks), 220);
    const hasImages = callbacks.getMessages().some((message) =>
      Array.isArray(message.content) &&
      message.content.some((part: any) => part?.type === "image_url" || part?.type === "input_image")
    );
    emitTurnEvent({
      type: "progress.updated",
      threadId: eventThreadId,
      turnId: eventTurnId,
      timestampMs: Date.now(),
      progress: {
        phase: "understanding",
        title: language === "zh" ? "理解需求" : "Understanding request",
        status: "running",
        summary: hasImages
          ? language === "zh"
            ? "正在理解用户目标、截图内容和执行约束，随后再定向读取必要证据。"
            : "Understanding the user goal, screenshots, and constraints before targeted evidence reads."
          : language === "zh"
          ? "正在理解用户目标、约束和安全边界，随后选择最小必要行动。"
          : "Understanding the user goal, constraints, and safety boundary before choosing the smallest useful action.",
        evidence: userGoal ? (language === "zh" ? `用户目标：${userGoal}` : `User goal: ${userGoal}`) : "",
        next: workflowMode === "plan" && !callbacks.getIsPlanApproved()
          ? language === "zh"
            ? "先做只读证据收束；批准前只允许生成计划文件。"
            : "First gather read-only evidence; before approval only plan artifacts may be written."
          : language === "zh"
          ? "进入定向上下文读取、执行或明确阻塞。"
          : "Move into targeted context reads, execution, or a concrete blocker.",
        dedupeKey: `understanding:${eventTurnId}`,
      },
    });
  }

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
    reasoningPolicyMode: reasoningPolicy.mode,
    reasoningDisplay: reasoningPolicy.display,
    reasoningReplayInContext: reasoningPolicy.replayInContext,
    providerFamily: modelProtocolProfile.providerFamily,
    xmlToolsEnabled: true,
  });
  logAgentEvent("reasoning_policy_applied", {
    mode: reasoningPolicy.mode,
    request: reasoningPolicy.request,
    display: reasoningPolicy.display,
    replayInContext: reasoningPolicy.replayInContext,
    maxHiddenChars: reasoningPolicy.maxHiddenChars,
    providerFamily: modelProtocolProfile.providerFamily,
    activeProfile: config.activeProfile,
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
  const latestUserPromptFullText = latestUserPrompt ? extractCompatibilityTextContent(latestUserPrompt.content) : "";
  const latestUserPromptText = extractPrimaryUserRequestText(latestUserPromptFullText) || latestUserPromptFullText;
  const turnInputContextSignals = extractTurnInputContextSignalsFromMessages(initialMessages);
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
    userContext: turnInputContextSignals,
  });
  const initialTaskTargetingProfile = buildCurrentTaskTargetingProfile();
  emitTaskOrchestratorPhase("INTAKE_PARSE", {
    facets: initialTaskTargetingProfile.facets,
    explicitPaths: initialTaskTargetingProfile.explicitPaths.slice(0, 8),
    symbols: initialTaskTargetingProfile.symbols.slice(0, 8),
    preferredReadTools: initialTaskTargetingProfile.preferredReadTools,
    allowRootSkeleton: initialTaskTargetingProfile.allowRootSkeleton,
    imageParts: initialTaskTargetingProfile.imageParts,
    mentionedFilePaths: initialTaskTargetingProfile.mentionedFilePaths.slice(0, 6),
    attachedFilePaths: initialTaskTargetingProfile.attachedFilePaths.slice(0, 6),
    hasUserProvidedContext: initialTaskTargetingProfile.hasUserProvidedContext,
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
      config.activeProfile,
      settings.provider || "",
      settings.model || "",
      modelProtocolProfile.providerFamily,
      modelProtocolProfile.reasoning,
      modelProtocolProfile.notes.join(","),
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
        modelProtocolNotes: modelProtocolProfile.notes,
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
  let emptyResponseCountThisTurn = 0;
  let consecutiveReasoningDominatedCount = 0;
  let usedMaxStepsFinalTextPrompt = false;
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
  let usedPlanClosurePrompt = false;
  let usedPlanDeterministicQualityClosure = false;
  let usedPlanReadOnlyConvergencePrompt = false;
  let planPostConvergenceToolRedirectCount = 0;
  let planRuntimePhase: PlanRuntimePhase = workflowMode === "plan" && !callbacks.getIsPlanApproved()
    ? "explore_structure"
    : "drafting";
  let planQualityRejectCount = 0;
  let planLastQualityGateReason = "";
  let planLastMissingSections: string[] = [];
  let planEvidenceRecoveryPasses = 0;
  let planReasoningOnlyRecoveryPasses = 0;
  let planAutoScaffoldPromptIssued = false;
  let planDeterministicClosureEvidenceRecoveryIssued = false;
  let usedExecuteCompletionEvidencePrompt = false;
  let usedExecuteReplanningEvidencePrompt = false;
  let usedReadOnlyPermissionHardRecoveryPrompt = false;
  let planReadOnlyConvergenceBatches = 0;
  let planReadOnlyConvergenceTools = 0;
  const attemptedPlanWriteTargets: string[] = [];
  let recentSuccessfulProjectWrite: { name: string; target: string } | null = null;
  let sawExecuteOperationEvidence = false;
  let recoveringFromEmptyAssistantReplyAfterWrite = false;
  let lastAssistantTextForCheckpoint = "";
  const recentPlanToolActivity: PlanToolActivitySummary[] = [];
  const recentToolActivity: PlanToolActivitySummary[] = [];
  const successfulEditTargetsSinceVerification = new Map<string, number>();
  let lastNoProgressBatchSignature = "";
  let noProgressBatchRepeatCount = 0;
  let approvedPlanNoProgressRecoveryAttempts = 0;
  let approvedPlanActionOnlyRecoveryActive = workflowMode === "plan" && callbacks.getIsPlanApproved();
  let executeRecoveryMode: ExecuteRecoveryMode =
    workflowMode === "edit"
      ? normalizeExecuteRecoveryMode(callbacks.getForcedExecuteRecoveryMode?.())
      : "normal";
  let executeRecoveryReason = executeRecoveryMode === "normal" ? "" : "forced_execute_recovery";
  let executeRecoveryAttempts = executeRecoveryMode === "normal" ? 0 : 1;
  const activateExecuteRecovery = (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context: Record<string, unknown> = {},
  ) => {
    const normalizedMode = normalizeExecuteRecoveryMode(mode) as Exclude<ExecuteRecoveryMode, "normal">;
    executeRecoveryAttempts += 1;
    executeRecoveryMode = normalizedMode;
    executeRecoveryReason = reason;
    logAgentEvent("execute_recovery_activated", {
      iteration,
      executeRecoveryMode,
      executeRecoveryAttempts,
      reason,
      recoveryToolSurface: describeExecuteRecoveryToolSurface(
        executeRecoveryMode,
        shouldAllowExecuteRecoveryFileRead(recentToolActivity),
      ),
      ...context,
    });
  };
  const clearExecuteRecovery = (reason: string) => {
    if (executeRecoveryMode === "normal") return;
    logAgentEvent("execute_recovery_cleared", {
      iteration,
      previousMode: executeRecoveryMode,
      executeRecoveryAttempts,
      reason,
    });
    executeRecoveryMode = "normal";
    executeRecoveryReason = "";
    executeRecoveryAttempts = 0;
  };
  const rememberToolActivity = (targetList: PlanToolActivitySummary[], result: ToolExecutionResult) => {
    if (result.internalFeedback) return;
    const rawDetail = result.displayContent || result.content || "";
    const planEvidenceDetail = summarizePlanEvidenceDetail({
      tool: result.name,
      target: result.target,
      content: rawDetail,
      maxChars: 220,
    });
    const detail = planEvidenceDetail || (/\bREAD_FILE_RESULT\b/i.test(rawDetail) ? "" : truncateForLog(rawDetail, 120));
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
  const normalizeLoopGuardTarget = (target: string) => String(target || "")
    .replace(/^shell-write:/, "")
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const isEditProgressResult = (result: ToolExecutionResult) =>
    EDIT_PROGRESS_TOOL_NAMES.has(result.name) || String(result.target || "").startsWith("shell-write:");
  const isVerificationEvidenceResult = (result: ToolExecutionResult) =>
    !result.isError &&
    !result.internalFeedback &&
    EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name);
  const setPlanRuntimePhase = (
    phase: PlanRuntimePhase,
    reason?: string,
    status: "pending" | "running" | "done" | "failed" = "running",
  ) => {
    if (workflowMode !== "plan" || callbacks.getIsPlanApproved()) return;
    if (planRuntimePhase === phase && !reason) return;
    planRuntimePhase = phase;
    const presentation = planRuntimePhasePresentation(phase, callbacks.getPreferredLanguage(), reason);
    callbacks.onTurnRuntimePhaseChanged?.({
      id: `plan_${phase}`,
      kind: presentation.kind,
      title: presentation.title,
      summary: presentation.summary,
      domain: "plan_runtime",
      status,
    });
    logAgentEvent("plan_runtime_phase_changed", {
      phase,
      reason: reason || "",
      iteration,
      qualityRejectCount: planQualityRejectCount,
      missingSections: planLastMissingSections,
    });
  };

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
  const approvedPlanBrowserValidationCache = new Map<string, ToolExecutionResult>();
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
    logAgentEvent("plan_review_ready_after_tool", {
      trigger,
      iteration,
      planStage: stage,
      isPlanApproved: callbacks.getIsPlanApproved(),
      statusBeforeReview: callbacks.getStatus(),
    });
    if (stage === "design") {
      logAgentEvent("plan_design_review_ready_after_tool", {
        trigger,
        iteration,
        planStage: stage,
        isPlanApproved: callbacks.getIsPlanApproved(),
        statusBeforeReview: callbacks.getStatus(),
      });
    }
    setPlanRuntimePhase("review_ready", "quality gate accepted", "done");
    callbacks.onAssistantFinalText(buildPlanReviewReadyMessage(language, stage));
    const approved = await waitForPlanApprovalIfNeeded();
    if (!approved) {
      if (callbacks.getStatus() !== "pending_review") {
        callbacks.onStatusChange("idle");
      }
      return "stopped";
    }

    callbacks.onPlanStageChanged("executing");
    approvedPlanActionOnlyRecoveryActive = true;
    approvedPlanNoProgressRecoveryAttempts = 0;
    const continuationPrompt = buildApprovedPlanContinuationPrompt(callbacks);
    if (callbacks.onApprovedPlanHandoff) {
      callbacks.onApprovedPlanHandoff(continuationPrompt);
      callbacks.onStatusChange("idle");
      return "stopped";
    }
    callbacks.appendMessage({
      role: "user",
      content: continuationPrompt,
    });
    return "approved_continue";
  }

  const buildDeterministicClosureEvidenceRecoveryPrompt = (reason: string): string => {
    const language = callbacks.getPreferredLanguage();
    if (language === "en") {
      return [
        "PLAN_DETERMINISTIC_CLOSURE_NEEDS_EVIDENCE: MAIN could not materialize a reviewable plan from clean evidence.",
        reason ? `Failure reason: ${reason}.` : "",
        "Do exactly one targeted read/search for the missing source or data fact. Prefer the specific file, symbol, or dataset already implicated by the user request.",
        "After that single tool result, stop exploring and produce a concise `<proposed_plan>` for `.MAIN/plans/plan.md`.",
        "Do not call broad directory scans, do not edit source files, and do not create `tasks.md` before approval.",
      ].filter(Boolean).join("\n");
    }
    return [
      "PLAN_DETERMINISTIC_CLOSURE_NEEDS_EVIDENCE: MAIN 无法从清洗后的证据物化可审批计划。",
      reason ? `失败原因：${reason}。` : "",
      "下一步只做一次定向读取/搜索，补齐缺失的源码或数据事实。优先读取用户目标已经指向的具体文件、符号或数据集。",
      "拿到这一次工具结果后，停止探索，直接输出精简 `<proposed_plan>`，用于 `.MAIN/plans/plan.md`。",
      "不要再泛扫目录；批准前不要修改源码，也不要创建 `tasks.md`。",
    ].filter(Boolean).join("\n");
  };

  async function materializePlanFromEvidenceForReview(trigger: string, details: {
    qualityGateReason?: string;
    qualityRejectCount?: number;
  } = {}): Promise<"not_attempted" | "failed" | "stopped" | "approved_continue"> {
    if (workflowMode !== "plan" || callbacks.getIsPlanApproved()) return "not_attempted";
    if (isReviewablePlanStage(callbacks.getPlanStage())) {
      const reviewResult = await pauseForReviewablePlanArtifact(trigger);
      if (reviewResult === "approved_continue") return "approved_continue";
      if (reviewResult === "stopped") return "stopped";
    }

    const closureInput = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      attemptedPlanWriteTargets,
      latestUserPromptText,
    );
    logAgentEvent("plan_evidence_sanitized", {
      trigger,
      iteration,
      structuredEvidenceCount: closureInput.evidenceRecords.length,
      ...closureInput.sanitizer,
      droppedPreview: closureInput.sanitizerDropped
        .slice(0, 6)
        .map((item) => ({
          bucket: item.bucket,
          reason: item.reason,
          preview: compactDiagnosticText(item.preview, 140),
        })),
    });
    const hasClosureGroundedEvidence = hasGroundedPlanClosureEvidence(closureInput, recentPlanToolActivity);
    const hasStructuredClosureEvidence = closureInput.evidenceRecords.length > 0;
    const logDeterministicClosureDecision = (reason: string, deterministicClosure: boolean) => {
      logAgentEvent("plan_quality_gate_recovery_decision", {
        trigger,
        iteration,
        qualityGateReason: details.qualityGateReason || reason || "deterministic_closure",
        qualityRejectCount: details.qualityRejectCount || planQualityRejectCount,
        recoveryAction: "deterministic_closure",
        hasGroundedEvidence: hasClosureGroundedEvidence,
        hasStructuredEvidence: hasStructuredClosureEvidence,
        deterministicClosure,
        deterministicClosureReason: reason,
        sanitizedEvidenceCount: closureInput.evidence.length,
        structuredEvidenceCount: closureInput.evidenceRecords.length,
        sanitizedFileCount: closureInput.files.length,
        sanitizerDropped: closureInput.sanitizer.dropped,
        sanitizerDropReasons: closureInput.sanitizer.dropReasons,
      });
    };
    if (!hasClosureGroundedEvidence) {
      logDeterministicClosureDecision("missing_grounded_evidence", false);
      logAgentEvent("plan_deterministic_materialization_skipped", {
        trigger,
        reason: "missing_grounded_evidence",
        evidenceCount: closureInput.evidence.length,
        structuredEvidenceCount: closureInput.evidenceRecords.length,
        fileCount: closureInput.files.length,
        qualityGateReason: details.qualityGateReason || "",
        qualityRejectCount: details.qualityRejectCount || 0,
      });
      return "not_attempted";
    }

    const closureDiagnosticSource = [
      ...closureInput.evidence,
      ...closureInput.files,
      closureInput.userGoal,
    ].join("\n");
    const evidencePreview = closureInput.evidence
      .slice(0, 5)
      .map((item) => compactDiagnosticText(item, 180))
      .filter(Boolean);
    logAgentEvent("plan_deterministic_materialization_attempt", {
      trigger,
      iteration,
      evidenceCount: closureInput.evidence.length,
      structuredEvidenceCount: closureInput.evidenceRecords.length,
      fileCount: closureInput.files.length,
      filePreview: closureInput.files.slice(0, 8),
      evidencePreview,
      noiseIndicators: collectDiagnosticNoiseIndicators(closureDiagnosticSource),
      qualityGateReason: details.qualityGateReason || "",
      qualityRejectCount: details.qualityRejectCount || 0,
    });

    const deterministicContent = composePlanArtifactFromEvidence({
      ...closureInput,
      language: callbacks.getPreferredLanguage(),
    });
    const materialized = materializePlanArtifactFromVisibleText({
      visibleText: deterministicContent,
      preferredKind: "plan",
      sourceHint: "deterministic_evidence",
      userGoal: closureInput.userGoal,
      evidence: closureInput.evidence,
      evidenceRecords: closureInput.evidenceRecords,
      files: closureInput.files,
      language: callbacks.getPreferredLanguage(),
    });

    if (!materialized.ok) {
      logDeterministicClosureDecision(materialized.reason || "quality_gate", false);
      logAgentEvent("plan_deterministic_materialization_rejected", {
        trigger,
        reason: materialized.reason || "unknown",
        evidenceCount: closureInput.evidence.length,
        structuredEvidenceCount: closureInput.evidenceRecords.length,
        fileCount: closureInput.files.length,
        validationReason: materialized.reason || "unknown",
        deterministicContentChars: deterministicContent.length,
        deterministicContentPreview: compactDiagnosticText(deterministicContent, 420),
        evidencePreview,
        filePreview: closureInput.files.slice(0, 8),
        noiseIndicators: collectDiagnosticNoiseIndicators(`${deterministicContent}\n${closureDiagnosticSource}`),
        qualityGateReason: details.qualityGateReason || "",
        qualityRejectCount: details.qualityRejectCount || 0,
      });
      return "failed";
    }

    logAgentEvent("plan_deterministic_materialization_success", {
      trigger,
      iteration,
      evidenceCount: closureInput.evidence.length,
      structuredEvidenceCount: closureInput.evidenceRecords.length,
      fileCount: closureInput.files.length,
      targetPath: materialized.path || ".MAIN/plans/plan.md",
      planArtifactSource: materialized.source || "deterministic_evidence",
      qualityGateReason: details.qualityGateReason || "",
      qualityRejectCount: details.qualityRejectCount || 0,
    });
    const writeResult = await writeMaterializedPlanArtifact({
      materialized,
      workspace,
      callbacks,
      toolCallPrefix: "plan_deterministic",
    });
    if (!writeResult.ok) {
      logAgentEvent("plan_deterministic_write_failed", {
        trigger,
        iteration,
        reason: writeResult.reason || "unknown",
      });
      return "failed";
    }

    const reviewResult = await pauseForReviewablePlanArtifact(trigger);
    if (reviewResult === "approved_continue") return "approved_continue";
    if (reviewResult === "stopped") return "stopped";
    return "failed";
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
      latestUserPromptText,
    );
    const evidenceCount = closureInput.evidence.length;
    const currentStage = callbacks.getPlanStage();
    const hasReviewablePlanArtifacts = isReviewablePlanStage(currentStage);
    const closureKind = resolvePlanClosureArtifactKind(closureInput, currentStage, recentPlanToolActivity);
    const targetPath = closureKind === "design" ? ".MAIN/plans/design.md" : ".MAIN/plans/plan.md";
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
      if (closureKind === "plan") {
        const deterministicResult = await materializePlanFromEvidenceForReview("deterministic_plan_closure");
        if (deterministicResult === "approved_continue") return "approved_continue";
        if (deterministicResult === "stopped") return "stopped";
      }
      logAgentEvent("plan_closure_artifact_rejected", {
        trigger,
        iteration,
        reason: "design_closure_prompt_already_used",
        evidenceCount,
        targetPath,
      });
      return "failed";
    }

    logAgentEvent("plan_closure_guard_start", {
      trigger,
      iteration,
      evidenceCount,
      structuredEvidenceCount: closureInput.evidenceRecords.length,
      fileCount: closureInput.files.length,
      constraintCount: closureInput.constraints.length,
      targetPath,
      closureKind,
      userGoalPreview: compactDiagnosticText(closureInput.userGoal, 160),
      planStage: currentStage,
    });

    if (!usedPlanClosurePrompt) {
      usedPlanClosureGuard = true;
      usedPlanClosurePrompt = true;
      setPlanRuntimePhase("drafting", `${closureKind} closure prompt ready`);
      const prompt = composeReviewablePlanFromEvidence({
        ...closureInput,
        kind: closureKind,
        language: callbacks.getPreferredLanguage(),
      });
      logAgentEvent("plan_closure_prompt", {
        trigger,
        iteration,
        evidenceCount,
        structuredEvidenceCount: closureInput.evidenceRecords.length,
        fileCount: closureInput.files.length,
        targetPath,
      });
      if (closureKind === "design") {
        logAgentEvent("plan_design_closure_prompt", {
          trigger,
          iteration,
          evidenceCount,
          fileCount: closureInput.files.length,
          targetPath,
        });
      }
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: prompt,
      });
      return "approved_continue";
    }
    return "failed";
  }

  const agentLoopConfig = config as AppConfig & {
    agentLoop?: { iterationLimits?: AgentLoopIterationLimits | null } | null;
  };
  const effectiveMaxIterations = resolveAgentLoopMaxIterations({
    workflowMode,
    runtimeIntent: resolveRuntimeIntent(),
    isPlanApproved: callbacks.getIsPlanApproved(),
    limits: agentLoopConfig.agentLoop?.iterationLimits ?? null,
  });
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
  const pauseApprovedPlanNoProgressLoop = (input: {
    reason: string;
    repeats: number;
    remainingText?: string;
    logContext?: Record<string, unknown>;
  }) => {
    const language = callbacks.getPreferredLanguage();
    const repeatedTargets = summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
    const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
    const nextStep = language === "zh"
      ? "换目标、改为写入/命令/浏览器验证，或说明真实阻塞"
      : "switch target, patch/run/browser-verify, or state the real blocker";
    const pauseNotice = buildPlanNoProgressLoopPauseNotice({
      language,
      repeats: Math.max(1, input.repeats),
      remainingTask: input.remainingText,
      evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
      recentToolActivity: recentPlanToolActivity,
      repeatedTargets,
    });

    logAgentEvent("loop_stop", {
      reason: input.reason,
      iteration,
      repeats: Math.max(1, input.repeats),
      repeatedTargets,
      progressSignature: truncateForLog(progressSignature, 220),
      ...(input.logContext || {}),
    });
    emitTaskOrchestratorPhase("PAUSED", {
      reason: input.reason,
      iteration,
      repeats: Math.max(1, input.repeats),
      remainingTask: input.remainingText || "",
      repeatedTargets,
    });
    emitPlanExecutionProgress("paused", {
      progressSignature,
      repeatedTargets,
      recoveryReason: input.reason,
      nextStep,
    });
    callbacks.onNonActionableStop(
      pauseNotice,
      "no_action",
      {
        progressSignature,
        repeatedTargets,
        recoveryReason: input.reason,
        nextStep,
      },
    );
    callbacks.onStatusChange("idle");
  };
  const pauseApprovedPlanStreamWatchdog = (
    message: string,
    logContext?: Record<string, unknown>,
  ): boolean => {
    if (workflowMode !== "plan" || !callbacks.getIsPlanApproved() || !isStreamWatchdogTimeoutMessage(message)) {
      return false;
    }

    const language = callbacks.getPreferredLanguage();
    const repeatedTargets = summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
    const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
    const nextStep = language === "zh"
      ? "恢复后直接调用真实工具执行下一项计划任务，或说明具体阻塞"
      : "resume by calling real tools for the next plan task, or state the concrete blocker";
    const pauseNotice = language === "zh"
      ? [
          "执行已暂停：模型持续返回流式内容，但没有产生可见说明或工具调用。",
          "MAIN 已保留当前 workspace 状态，没有把这次不可见输出当作执行失败。",
          `最近工具目标：${repeatedTargets.length > 0 ? repeatedTargets.join("、") : "未定位到单一目标"}`,
          `建议恢复动作：${nextStep}。`,
        ].join("\n")
      : [
          "Execution paused: the model kept streaming content but produced no visible explanation or tool call.",
          "MAIN kept the current workspace state and did not treat this invisible-output stall as an execution failure.",
          `Recent targets: ${repeatedTargets.length > 0 ? repeatedTargets.join(", ") : "no single target identified"}`,
          `Suggested recovery: ${nextStep}.`,
        ].join("\n");

    logAgentEvent("approved_plan_stream_watchdog_paused", {
      iteration,
      message: message.slice(0, 240),
      progressSignature: truncateForLog(progressSignature, 220),
      repeatedTargets,
      ...(logContext || {}),
    });
    emitTaskOrchestratorPhase("PAUSED", {
      reason: "stream_no_visible_progress_timeout",
      iteration,
      repeatedTargets,
    });
    emitPlanExecutionProgress("paused", {
      progressSignature,
      repeatedTargets,
      recoveryReason: "stream_no_visible_progress_timeout",
      nextStep,
    });
    callbacks.onNonActionableStop(
      pauseNotice,
      "no_output",
      {
        progressSignature,
        repeatedTargets,
        recoveryReason: "stream_no_visible_progress_timeout",
        nextStep,
      },
    );
    callbacks.onStatusChange("idle");
    return true;
  };
  const continueApprovedPlanWithStrategySwitch = (input: {
    reason: string;
    remainingText: string;
    logContext?: Record<string, unknown>;
  }) => {
    const language = callbacks.getPreferredLanguage();
    const repeatedTargets = summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
    const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
    const allowFileRead = shouldAllowApprovedPlanRecoveryFileRead(recentPlanToolActivity);
    approvedPlanNoProgressRecoveryAttempts += 1;
    approvedPlanActionOnlyRecoveryActive = true;
    logAgentEvent("plan_execution_strategy_switch_reprompt", {
      reason: input.reason,
      iteration,
      attempts: approvedPlanNoProgressRecoveryAttempts,
      repeatedTargets,
      progressSignature: truncateForLog(progressSignature, 220),
      recoveryToolSurface: describeApprovedPlanRecoveryToolSurface(allowFileRead),
      ...(input.logContext || {}),
    });
    emitTaskOrchestratorPhase("EXECUTE_STEP", {
      reason: input.reason,
      iteration,
      attempts: approvedPlanNoProgressRecoveryAttempts,
      repeatedTargets,
    });
    emitPlanExecutionProgress("running", {
      progressSignature,
      repeatedTargets,
      recoveryReason: input.reason,
      nextStep: language === "zh"
        ? "下一轮保留行动工具和定向恢复读取；避免重复缓存目标，优先写入/命令/浏览器验证"
        : "next turn keeps action tools and targeted recovery reads; avoid cached rereads and prioritize patching, commands, or browser validation",
    });
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: buildApprovedPlanNoProgressStrategySwitchPrompt({
        language,
        remainingText: input.remainingText,
        repeatedTargets,
        recentToolActivity: recentPlanToolActivity,
        allowFileRead,
      }),
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
    maxIterations: effectiveMaxIterations,
    iterationLimitSource: {
      chatRespond: agentLoopConfig.agentLoop?.iterationLimits?.chatRespond ?? null,
      editExecute: agentLoopConfig.agentLoop?.iterationLimits?.editExecute ?? null,
      planDraft: agentLoopConfig.agentLoop?.iterationLimits?.planDraft ?? null,
      planExecution: agentLoopConfig.agentLoop?.iterationLimits?.planExecution ?? null,
    },
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
  if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
    setPlanRuntimePhase("explore_structure", "start");
  }

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
    const finalTextOnlyStep = shouldUseMaxStepsFinalTextOnly({
      workflowMode,
      runtimeIntent,
      isPlanApproved: callbacks.getIsPlanApproved(),
      iteration,
      maxIterations: effectiveMaxIterations,
      alreadyPrompted: usedMaxStepsFinalTextPrompt,
    });
    if (finalTextOnlyStep) {
      usedMaxStepsFinalTextPrompt = true;
      logAgentEvent("max_steps_final_text_prompt", {
        iteration,
        maxIterations: effectiveMaxIterations,
        workflowMode,
        runtimeIntent,
        repeatedTargets: summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
      });
    }
    const rawIterationAllTools = finalTextOnlyStep ? [] : resolveAllToolsForRuntime(runtimeIntent);
    const allowApprovedPlanRecoveryFileRead = shouldAllowApprovedPlanRecoveryFileRead(recentPlanToolActivity);
    const isExecuteRecoveryEligible =
      (workflowMode === "edit" || (workflowMode === "plan" && callbacks.getIsPlanApproved())) &&
      runtimeIntent === "execute" &&
      executeRecoveryMode !== "normal";
    const allowExecuteRecoveryFileRead = shouldAllowExecuteRecoveryFileRead(recentToolActivity);
    const recoveryIterationAllTools = isExecuteRecoveryEligible
      ? rawIterationAllTools.filter((tool) => isExecuteRecoveryToolName(
          tool.function.name,
          PLAN_EXPLORATION_READ_ONLY_TOOLS,
          {
            mode: executeRecoveryMode,
            allowFileRead: allowExecuteRecoveryFileRead,
          },
        ))
      : rawIterationAllTools;
    if (isExecuteRecoveryEligible && recoveryIterationAllTools.length !== rawIterationAllTools.length) {
      logAgentEvent("execute_recovery_tool_scope_applied", {
        iteration,
        executeRecoveryMode,
        executeRecoveryReason,
        executeRecoveryAttempts,
        allowFileRead: allowExecuteRecoveryFileRead,
        recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, allowExecuteRecoveryFileRead),
        rawTools: rawIterationAllTools.map((tool) => tool.function.name).slice(0, 24),
        scopedTools: recoveryIterationAllTools.map((tool) => tool.function.name),
        removedToolCount: Math.max(0, rawIterationAllTools.length - recoveryIterationAllTools.length),
      });
    }
    const approvedPlanSourceEditFirstActive =
      workflowMode === "plan" &&
      callbacks.getIsPlanApproved() &&
      approvedPlanNeedsSourceEditBeforeValidation(
        callbacks.getPlanTasks(),
        callbacks.getPlanExecutionEvidenceLedger(),
      );
    const baseIterationAllTools =
      approvedPlanSourceEditFirstActive
        ? recoveryIterationAllTools.filter((tool) => isApprovedPlanSourceEditFirstTool(tool, {
            allowFileRead: allowApprovedPlanRecoveryFileRead,
          }))
        : approvedPlanActionOnlyRecoveryActive &&
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved()
        ? recoveryIterationAllTools.filter((tool) => isApprovedPlanRecoveryTool(tool, {
            allowFileRead: allowApprovedPlanRecoveryFileRead,
          }))
        : recoveryIterationAllTools;
    if (approvedPlanSourceEditFirstActive && baseIterationAllTools.length !== recoveryIterationAllTools.length) {
      logAgentEvent("approved_plan_source_edit_first_tool_scope_applied", {
        iteration,
        allowFileRead: allowApprovedPlanRecoveryFileRead,
        recoveryToolSurface: describeApprovedPlanSourceEditFirstToolSurface(allowApprovedPlanRecoveryFileRead),
        rawTools: recoveryIterationAllTools.map((tool) => tool.function.name).slice(0, 24),
        scopedTools: baseIterationAllTools.map((tool) => tool.function.name),
        removedToolCount: Math.max(0, recoveryIterationAllTools.length - baseIterationAllTools.length),
        taskCount: callbacks.getPlanTasks().length,
        evidenceCount: callbacks.getPlanExecutionEvidenceLedger().length,
      });
    }
    const phaseScopedIterationAllTools = filterPlanRuntimeToolDefinitionsForPhase({
      tools: baseIterationAllTools,
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      planRuntimePhase,
    });
    const shouldClosePlanToolSurface = shouldClosePlanToolSurfaceAfterReadOnlyConvergence({
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
      planRuntimePhase,
      evidenceReadiness: assessPlanEvidenceReadiness({
        userContext: turnInputContextSignals,
        recentToolActivity: recentPlanToolActivity,
        hasObservedUserContext: hasPlanUserContextObservation(
          callbacks.getMessages() as AgentMessage[],
          lastAssistantTextForCheckpoint,
        ),
      }).status,
    });
    const iterationAllTools = shouldClosePlanToolSurface
      ? baseIterationAllTools.filter((tool) => isPlanDraftWriteToolName(tool.function.name))
      : phaseScopedIterationAllTools;
    if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && iterationAllTools.length !== baseIterationAllTools.length) {
      logAgentEvent("plan_runtime_tool_scope_applied", {
        iteration,
        planRuntimePhase,
        rawTools: rawIterationAllTools.map((tool) => tool.function.name).slice(0, 24),
        scopedTools: iterationAllTools.map((tool) => tool.function.name),
        removedToolCount: Math.max(0, baseIterationAllTools.length - iterationAllTools.length),
        postConvergence: shouldClosePlanToolSurface,
      });
    }
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
    const contextLimitForManagement = snapshotContextLimit ?? (cloudResponsesCompact ? 32768 : null);
    const effectiveContextLimitForManagement = contextLimitForManagement != null
      ? computeManagedContextLimit(contextLimitForManagement, llmTools)
      : null;
    const contextBudgetsForManagement = effectiveContextLimitForManagement != null
      ? computeContextBudgets(effectiveContextLimitForManagement)
      : null;
    const contextForceForManagement = contextBudgetsForManagement
      ? computeContextForceReason({
          messages: callbacks.getMessages() as AgentMessage[],
          iteration,
          workflowMode,
          isPlanApproved: callbacks.getIsPlanApproved(),
          inputBudget: contextBudgetsForManagement.inputBudget,
          proactiveTriggerBudget: contextBudgetsForManagement.proactiveTriggerBudget,
        })
      : null;
    let executeRecoveryContextAlreadyCompacted = false;
    if (isExecuteRecoveryEligible && contextForceForManagement?.shouldForce) {
      const recoveryMessagesBefore = callbacks.getMessages().length;
      const recoveryManagedResult = compactContextForExecuteRecovery(
        callbacks.getMessages(),
        {
          previousMemoryState: callbacks.getContextMemoryState?.() || null,
          turnId: callbacks.getCurrentTurnId?.() || eventTurnId,
          maxMessages: 36,
          maxToolResultMessages: 12,
          maxToolChars: 12_000,
          maxToolCallGroups: 6,
          maxToolResultTokens: 360,
          latestUserMessages: 2,
        },
      );
      callbacks.onContextMemoryBuilt?.(recoveryManagedResult.memoryState, recoveryManagedResult.memoryPacket);
      managedAgentMessages = recoveryManagedResult.messages as AgentMessage[];
      if (recoveryManagedResult.changed) {
        callbacks.replaceMessages(managedAgentMessages);
        callbacks.onContextCompress({
          droppedCount: recoveryManagedResult.droppedCount,
          droppedMessageCount: recoveryManagedResult.droppedMessageCount,
          tokenCountBefore: recoveryManagedResult.tokenCountBefore,
          tokenCountAfter: recoveryManagedResult.tokenCountAfter,
          tokenReduction: recoveryManagedResult.tokenReduction,
          compressedContext: recoveryManagedResult.compressedContext,
          displaySummary: recoveryManagedResult.displaySummary,
          memoryPacket: recoveryManagedResult.memoryPacket,
          microCompactionKind: recoveryManagedResult.microCompactionKind,
          microCompactedCount: recoveryManagedResult.microCompactedCount,
          tokenBreakdown: recoveryManagedResult.tokenBreakdownBefore,
        }, "execute_recovery");
      }
      executeRecoveryContextAlreadyCompacted = true;
      logAgentEvent("execute_recovery_context_compacted", {
        iteration,
        executeRecoveryMode,
        executeRecoveryReason,
        forceReason: contextForceForManagement.reason,
        estimatedTokens: Math.round(contextForceForManagement.estimatedTokens),
        tokenPressure: Number(contextForceForManagement.tokenPressure.toFixed(3)),
        messagesBefore: recoveryMessagesBefore,
        messagesAfter: managedAgentMessages.length,
        droppedMessageCount: recoveryManagedResult.droppedMessageCount,
        tokenBefore: Math.round(recoveryManagedResult.tokenCountBefore),
        tokenAfter: Math.round(recoveryManagedResult.tokenCountAfter),
        toolResultMessagesAfter: managedAgentMessages.filter((message) => message.role === "tool").length,
        toolCharsAfter: managedAgentMessages.reduce((sum, message) =>
          message.role === "tool" && typeof message.content === "string"
            ? sum + message.content.length
            : sum,
        0),
        recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, allowExecuteRecoveryFileRead),
      });
    } else if (isExecuteRecoveryEligible) {
      logAgentEvent("execute_recovery_context_skipped", {
        iteration,
        executeRecoveryMode,
        executeRecoveryReason,
        reason: "below_context_threshold",
        estimatedTokens: contextForceForManagement
          ? Math.round(contextForceForManagement.estimatedTokens)
          : null,
        tokenPressure: contextForceForManagement
          ? Number(contextForceForManagement.tokenPressure.toFixed(3))
          : null,
        proactiveTriggerBudget: contextBudgetsForManagement?.proactiveTriggerBudget ?? null,
        recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, allowExecuteRecoveryFileRead),
      });
    }
    if (
      !executeRecoveryContextAlreadyCompacted &&
      effectiveContextLimitForManagement != null &&
      contextBudgetsForManagement &&
      contextForceForManagement
    ) {
      const effectiveContextLimit = effectiveContextLimitForManagement;
      const contextBudgets = contextBudgetsForManagement;
      const { inputBudget, outputBudget } = contextBudgets;
      const contextForce = contextForceForManagement;
      const isUnapprovedPlanContext = workflowMode === "plan" && !callbacks.getIsPlanApproved();
      const forcedContextToolBudget = contextForce.shouldForce
        ? callbacks.getIsPlanApproved()
          ? 1200
          : isUnapprovedPlanContext
          ? 1000
          : 1600
        : null;
      const forcedContextAssistantBudget = contextForce.shouldForce
        ? callbacks.getIsPlanApproved()
          ? 900
          : isUnapprovedPlanContext
          ? 700
          : 1000
        : null;
      const managedResult = manageContext(
        callbacks.getMessages(),
        effectiveContextLimit,
        cloudResponsesCompact ? Math.min(outputBudget, 2048) : outputBudget,
        cloudResponsesCompact
          ? 700
          : forcedContextToolBudget
          ? forcedContextToolBudget
          : isUnapprovedPlanContext
          ? 1200
          : callbacks.getIsPlanApproved()
          ? 2200
          : Math.max(4000, Math.floor(inputBudget * 0.32)),
        cloudResponsesCompact
          ? 500
          : forcedContextAssistantBudget
          ? forcedContextAssistantBudget
          : isUnapprovedPlanContext
          ? 900
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
      const compressionRatio = managedResult.tokenCountBefore > 0
        ? managedResult.tokenReduction / managedResult.tokenCountBefore
        : 0;
      const shouldAnnounceCompression =
        managedResult.droppedMessageCount > 0 ||
        managedResult.tokenReduction >= 1024 ||
        compressionRatio >= 0.05;
      if (managedResult.changed && shouldAnnounceCompression) {
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
        estimatedTokens: Math.round(contextForce.estimatedTokens),
        tokenPressure: Number(contextForce.tokenPressure.toFixed(3)),
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
      const protocolMessagesForLLM = prepareMessagesForToolProtocol(
        managedAgentMessages,
        config,
        settings,
        providerCompatibilityOverride,
      );
      const finalTextOnlyPrompt = finalTextOnlyStep
        ? buildMaxStepsFinalTextPrompt({
            language: callbacks.getPreferredLanguage(),
            iteration,
            maxIterations: effectiveMaxIterations,
            repeatedTargets: summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
          })
        : "";
      const messagesForLLM = finalTextOnlyPrompt
        ? [...protocolMessagesForLLM, { role: "user" as const, content: finalTextOnlyPrompt }]
        : protocolMessagesForLLM;
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
        executeRecoveryMode,
        executeRecoveryReason,
        recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, allowExecuteRecoveryFileRead),
        finalTextOnlyStep,
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
        {
          ...streamWatchdogOptions,
          workflowMode,
          runtimeIntent,
        },
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
      if (pauseApprovedPlanStreamWatchdog(errMsg, { stage: "initial_stream" })) {
        return;
      }
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
            {
              ...getPlanStreamWatchdogOptions(llmTools.length),
              workflowMode,
              runtimeIntent,
            },
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
          if (pauseApprovedPlanStreamWatchdog(retryErrMsg, { stage: "context_compaction_retry" })) {
            return;
          }
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
              {
                ...getPlanStreamWatchdogOptions(llmTools.length),
                workflowMode,
                runtimeIntent,
              },
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
            if (pauseApprovedPlanStreamWatchdog(finalErrMsg, { stage: "emergency_compaction_retry" })) {
              return;
            }
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
            {
              ...getPlanStreamWatchdogOptions(llmTools.length),
              workflowMode,
              runtimeIntent,
            },
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
          if (pauseApprovedPlanStreamWatchdog(cloudRetryErrMsg, { stage: "cloud_compaction_retry" })) {
            return;
          }
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
            {
              ...getPlanStreamWatchdogOptions(0),
              workflowMode,
              runtimeIntent,
            },
          );
        } catch (retryErr) {
          if ((retryErr as Error).name === "AbortError") {
            callbacks.onStatusChange("idle");
            return;
          }

          const retryMsg = (retryErr as Error).message || "";
          if (pauseApprovedPlanStreamWatchdog(retryMsg, { stage: "provider_compatibility_retry" })) {
            return;
          }
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
                {
                  ...getPlanStreamWatchdogOptions(0),
                  workflowMode,
                  runtimeIntent,
                },
              );
            } catch (finalErr) {
              if ((finalErr as Error).name === "AbortError") {
                callbacks.onStatusChange("idle");
                return;
              }
              const finalErrMsg = (finalErr as Error).message || "";
              if (pauseApprovedPlanStreamWatchdog(finalErrMsg, { stage: "provider_compatibility_final_retry" })) {
                return;
              }
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
                  {
                    ...getPlanStreamWatchdogOptions(0),
                    workflowMode,
                    runtimeIntent,
                  },
                );
              } catch (lastErr) {
                if ((lastErr as Error).name === "AbortError") {
                  callbacks.onStatusChange("idle");
                  return;
                }
                const lastErrorMessage = getErrorMessage(lastErr, "未知错误");
                if (pauseApprovedPlanStreamWatchdog(lastErrorMessage, { stage: "provider_compatibility_transcript_retry" })) {
                  return;
                }
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
    const providerReasoningForHistory =
      typeof streamResult.reasoningContent === "string" && streamResult.reasoningContent.trim()
        ? {
            reasoningContent: streamResult.reasoningContent,
            reasoningField: streamResult.reasoningField,
          }
        : null;
    logAgentEvent("stream_done", {
      iteration,
      finishReason: streamResult.finishReason || "unknown",
      contentChars: streamText.length,
      providerReasoningChars: providerReasoningForHistory?.reasoningContent.length ?? 0,
      toolCalls: streamResult.toolCalls.length,
      elapsedMs: Date.now() - iterationRequestStartedAt,
      emptyResult: streamText.length === 0 && streamResult.toolCalls.length === 0,
    });
    if (providerReasoningForHistory) {
      logAgentEvent("reasoning_suppressed", {
        iteration,
        chars: providerReasoningForHistory.reasoningContent.length,
        field: providerReasoningForHistory.reasoningField || "reasoning_content",
        replayInContext: false,
        display: reasoningPolicy.display,
      });
    }
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
      true,
    );
    const reasoningDominatedNoAction = isReasoningDominatedNoActionResult(streamResult);
    if (reasoningDominatedNoAction && normalized.toolCalls.length === 0 && normalized.replyOptions.length === 0) {
      if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
        const readiness = assessPlanEvidenceReadiness({
          userContext: turnInputContextSignals,
          recentToolActivity: recentPlanToolActivity,
          hasObservedUserContext: hasPlanUserContextObservation(
            callbacks.getMessages() as AgentMessage[],
            lastAssistantTextForCheckpoint,
          ),
        });
        const targetedRecoveryPasses = Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses);
        const recoveryDecision = resolvePlanNoActionRecovery({
          workflowMode,
          isPlanApproved: callbacks.getIsPlanApproved(),
          reasoningOnly: true,
          evidenceReadiness: readiness.status,
          targetedRecoveryPasses,
        });
        logAgentEvent("plan_reasoning_only_recovery_decision", {
          iteration,
          action: recoveryDecision.action,
          reason: recoveryDecision.reason,
          finishReason: streamResult.finishReason || "unknown",
          evidenceReadiness: readiness.status,
          evidenceReadinessReason: readiness.reason,
          successfulTargetedReads: readiness.successfulTargetedReads,
          successfulSearches: readiness.successfulSearches,
          targetedRecoveryPasses,
          contentChars: streamResult.content.length,
          reasoningChars: String(streamResult.reasoningContent || "").length,
        });

        if (recoveryDecision.action === "deterministic_materialization") {
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          const closureResult = await materializePlanFromEvidenceForReview(
            streamResult.finishReason === "length"
              ? "reasoning_only_length_plan_closure"
              : "reasoning_only_stop_plan_closure",
          );
          if (closureResult === "approved_continue") continue;
          if (closureResult === "stopped") return;
          if (targetedRecoveryPasses < 1) {
            planReasoningOnlyRecoveryPasses += 1;
            setPlanRuntimePhase("needs_evidence", "deterministic closure needed more evidence");
            callbacks.onStatusChange("running");
            callbacks.appendMessage({
              role: "user",
              content: buildPlanTargetedEvidenceRecoveryPrompt({
                language: callbacks.getPreferredLanguage(),
                reason: readiness.reason,
              }),
            });
            continue;
          }
          if (closureResult === "failed" || closureResult === "not_attempted") {
            callbacks.onNonActionableStop(
              buildPlanEvidenceBlockedPauseMessage({
                language: callbacks.getPreferredLanguage(),
                reason: readiness.reason,
              }),
              "incomplete_plan",
              {
                recoveryReason: "plan_reasoning_only_materialization_failed",
                nextStep: callbacks.getPreferredLanguage() === "zh"
                  ? "补充一个具体缺失事实或关键选择后继续"
                  : "provide the concrete missing fact or key decision, then resume",
              },
            );
            callbacks.onStatusChange("idle");
            return;
          }
        }

        if (recoveryDecision.action === "targeted_evidence") {
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          planReasoningOnlyRecoveryPasses += 1;
          setPlanRuntimePhase("needs_evidence", readiness.reason);
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildPlanTargetedEvidenceRecoveryPrompt({
              language: callbacks.getPreferredLanguage(),
              reason: readiness.reason,
            }),
          });
          continue;
        }

        if (recoveryDecision.action === "pause_blocked") {
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          setPlanRuntimePhase("blocked", readiness.reason, "failed");
          callbacks.onNonActionableStop(
            buildPlanEvidenceBlockedPauseMessage({
              language: callbacks.getPreferredLanguage(),
              reason: readiness.reason,
            }),
            "incomplete_plan",
            {
              recoveryReason: "plan_reasoning_only_evidence_blocked",
              nextStep: callbacks.getPreferredLanguage() === "zh"
                ? "补充一个具体缺失事实或关键选择后继续"
                : "provide the concrete missing fact or key decision, then resume",
            },
          );
          callbacks.onStatusChange("idle");
          return;
        }
      }

      consecutiveReasoningDominatedCount++;
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      logAgentEvent(
        consecutiveReasoningDominatedCount >= 2
          ? "reasoning_dominated_pause"
          : "reasoning_dominated_recovery",
        {
          iteration,
          consecutiveReasoningDominatedCount,
          contentChars: streamResult.content.length,
          reasoningChars: String(streamResult.reasoningContent || "").length,
          workflowMode,
          turnIntent,
          planStage: callbacks.getPlanStage(),
          isPlanApproved: callbacks.getIsPlanApproved(),
        },
      );
      if (consecutiveReasoningDominatedCount >= 2) {
        callbacks.onNonActionableStop(
          buildReasoningDominatedPauseMessage(callbacks.getPreferredLanguage(), workflowMode),
          workflowMode === "plan" ? "incomplete_plan" : "no_output",
        );
        callbacks.onStatusChange("idle");
        return;
      }
      if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
        approvedPlanActionOnlyRecoveryActive = true;
        logAgentEvent("approved_plan_reasoning_recovery_tool_surface", {
          iteration,
          recoveryToolSurface: "action_plus_targeting_reads",
          allowFileRead: false,
        });
      } else if (workflowMode === "edit" && resolveRuntimeIntent() === "execute") {
        activateExecuteRecovery("action_plus_targeting", "reasoning_dominated_recovery", {
          consecutiveReasoningDominatedCount,
          contentChars: streamResult.content.length,
          reasoningChars: String(streamResult.reasoningContent || "").length,
        });
      }
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: buildReasoningDominatedRecoveryPrompt(callbacks.getPreferredLanguage(), workflowMode),
      });
      continue;
    }
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
      emptyResponseCountThisTurn++;
      if (
        workflowMode === "chat" &&
        runtimeIntent === "respond" &&
        emptyResponseCountThisTurn >= 2
      ) {
        const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
        logAgentEvent("loop_stop", {
          reason: "empty_model_response",
          iteration,
          consecutiveEmptyResponseCount,
          emptyResponseCountThisTurn,
          repeatedTargets,
        });
        callbacks.onNonActionableStop(
          buildEmptyModelResponsePauseNotice({
            language: callbacks.getPreferredLanguage(),
            emptyResponses: emptyResponseCountThisTurn,
            repeatedTargets,
            localProfile: config.activeProfile === "local",
          }),
          "no_output",
          {
            repeatedTargets,
            recoveryReason: "empty_model_response",
            nextStep: callbacks.getPreferredLanguage() === "zh"
              ? "复用已读上下文，要求直接总结、换目标或说明具体阻塞"
              : "reuse cached context and ask for a direct summary, a different target, or the concrete blocker",
          },
        );
        callbacks.onStatusChange("idle");
        return;
      }
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
            ? "上一条 Plan 回复是空的。请立即继续生成可审批的正式计划：复杂实现和修复类请求默认用 write_file 或 replace_in_file 创建/更新 `.MAIN/plans/plan.md`；如果信息不足，只能用 `<user_options>` 给出关键选择。不要只返回空消息、隐藏 thinking/analysis，或伪工具占位。"
            : "The previous Plan reply was empty. Continue now with a reviewable plan: complex implementation and fix plans should use write_file or replace_in_file to create/update `.MAIN/plans/plan.md`; if information is insufficient, offer key choices with `<user_options>`. Do not return an empty message, hidden thinking/analysis only, or pseudo-tool placeholders.",
        });
        continue;
      }
      if (consecutiveEmptyResponseCount >= 3) {
        const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
        logAgentEvent("loop_stop", {
          reason: "empty_model_response",
          iteration,
          consecutiveEmptyResponseCount,
          emptyResponseCountThisTurn,
          repeatedTargets,
        });
        callbacks.onNonActionableStop(
          buildEmptyModelResponsePauseNotice({
            language: callbacks.getPreferredLanguage(),
            emptyResponses: consecutiveEmptyResponseCount,
            repeatedTargets,
            localProfile: config.activeProfile === "local",
          }),
          "no_output",
          {
            repeatedTargets,
            recoveryReason: "empty_model_response",
            nextStep: callbacks.getPreferredLanguage() === "zh"
              ? "复用已读上下文，要求直接总结、换目标或说明具体阻塞"
              : "reuse cached context and ask for a direct summary, a different target, or the concrete blocker",
          },
        );
        callbacks.onStatusChange("idle");
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
    consecutiveReasoningDominatedCount = 0;

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
    if (finalTextOnlyStep && effectiveToolCalls.length > 0) {
      callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      const finalText = normalized.visibleText.trim();
      const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
      logAgentEvent("max_steps_tool_calls_ignored", {
        iteration,
        maxIterations: effectiveMaxIterations,
        toolCalls: effectiveToolCalls.length,
        toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
        visibleChars: finalText.length,
        repeatedTargets,
      });
      if (finalText) {
        callbacks.onAssistantFinalText(finalText, [], {
          hasToolCalls: false,
          modelAuthored: true,
        });
        const assistantHistoryText = serializeAssistantReplyForHistory(finalText, []);
        callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
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
      callbacks.onNonActionableStop(
        buildMaxStepsToolCallIgnoredNotice({
          language: callbacks.getPreferredLanguage(),
          iteration,
          maxIterations: effectiveMaxIterations,
          repeatedTargets,
        }),
        "no_action",
        {
          repeatedTargets,
          recoveryReason: "max_iterations_boundary",
          nextStep: callbacks.getPreferredLanguage() === "zh"
            ? "复用已读上下文，直接总结、换目标或说明具体阻塞"
            : "reuse cached context, summarize directly, switch targets, or state the concrete blocker",
        },
      );
      callbacks.onStatusChange("idle");
      return;
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
    const suppressTruncatedReadOnlyPermissionOptions =
      effectiveToolCalls.length === 0 &&
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      normalized.finishReason === "length" &&
      hasOnlyReadOnlyPermissionReplyOptions(normalized.replyOptions);
    const suppressReadOnlyPermissionOptions =
      autoContinueReadOnlyPermission ||
      suppressReadOnlyPermissionOptionsForToolCalls ||
      suppressTruncatedReadOnlyPermissionOptions;
    const suppressPlanContinuationReplyOptions =
      effectiveToolCalls.length === 0 &&
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      hasOnlyNonBlockingPlanReplyOptions(normalized.replyOptions);
    const suppressExecutableProposalOptionsForToolCalls =
      effectiveToolCalls.length > 0 &&
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      hasExecutableProposalReplyOptions(normalized.replyOptions);
    const currentPlanStageForReview = callbacks.getPlanStage();
    const isApprovedPlanExecutionTurn =
      workflowMode === "plan" &&
      callbacks.getIsPlanApproved() &&
      currentPlanStageForReview === "executing";
    const suppressApprovedPlanExecutionReplyOptions =
      effectiveToolCalls.length === 0 &&
      isApprovedPlanExecutionTurn &&
      normalized.replyOptions.length > 0;
    const suppressNonDecisionReplyOptions =
      suppressReadOnlyPermissionOptions ||
      suppressPlanContinuationReplyOptions ||
      suppressExecutableProposalOptionsForToolCalls ||
      suppressApprovedPlanExecutionReplyOptions;
    const sourceVisibleText = normalizedBase.visibleText || normalized.visibleText;
    const hasStructuredProposal = hasStructuredPlanProposal(streamText);
    const hasReadyPlanArtifacts = currentPlanStageForReview === "ready_to_execute";
    const hasReviewablePlanArtifacts = isReviewablePlanStage(currentPlanStageForReview);
    const rawFinalReplyOptions = compactedProseCodeDump || suppressNonDecisionReplyOptions
      ? []
      : normalized.replyOptions;
    const planReplyOptionsRoutedToArtifact = shouldRouteUnapprovedPlanReplyOptionsToArtifact({
      replyOptions: rawFinalReplyOptions,
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      hasStructuredProposal,
      hasReadyPlanArtifacts,
      hasReviewablePlanArtifacts,
      sawPlanModeToolActivity,
      visibleText: sourceVisibleText,
    });
    const normalizedVisibleTextForUser = suppressReadOnlyPermissionOptions
      ? stripReadOnlyPermissionPrompt(normalized.visibleText)
      : normalized.visibleText;
    const finalVisibleText = compactedProseCodeDump
      ? buildProseCodeDumpNotice(callbacks.getPreferredLanguage(), normalized.visibleText.length)
      : compactedIncompletePlanText
      ? buildPlanFallbackNotice(callbacks.getPreferredLanguage(), sourceVisibleText.length)
      : normalizedVisibleTextForUser;
    const finalReplyOptions = planReplyOptionsRoutedToArtifact ? [] : rawFinalReplyOptions;
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
    if (suppressTruncatedReadOnlyPermissionOptions) {
      logAgentEvent("truncated_readonly_permission_options_ignored", {
        iteration,
        replyOptions: normalized.replyOptions.length,
        hiddenThoughtChars: normalized.hiddenThought.length,
        visibleChars: normalized.visibleText.length,
        workflowMode,
        turnIntent,
      });
    }
    if (suppressPlanContinuationReplyOptions) {
      logAgentEvent("plan_continuation_reply_options_ignored", {
        iteration,
        replyOptions: normalized.replyOptions.length,
        optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
        visibleChars: normalized.visibleText.length,
        workflowMode,
        turnIntent,
      });
    }
    if (suppressExecutableProposalOptionsForToolCalls) {
      logAgentEvent("plan_executable_reply_options_ignored_for_tool_call", {
        iteration,
        toolCalls: effectiveToolCalls.length,
        replyOptions: normalized.replyOptions.length,
        optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
        workflowMode,
        turnIntent,
      });
    }
    if (suppressApprovedPlanExecutionReplyOptions) {
      logAgentEvent("approved_plan_execution_reply_options_ignored", {
        iteration,
        replyOptions: normalized.replyOptions.length,
        optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
        visibleChars: normalized.visibleText.length,
        workflowMode,
        turnIntent,
        runtimeIntent,
        planStage: currentPlanStageForReview,
      });
    }
    if (planReplyOptionsRoutedToArtifact) {
      logAgentEvent("plan_reply_options_routed_to_artifact", {
        iteration,
        replyOptions: rawFinalReplyOptions.length,
        optionPreview: summarizeReplyOptionsForLog(rawFinalReplyOptions),
        sawPlanModeToolActivity,
        visibleChars: sourceVisibleText.length,
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
    const shouldHideApprovedPlanNoToolText =
      shouldSuppressApprovedPlanNoToolText && rejectedCompletionClaim;

    if (shouldSuppressApprovedPlanNoToolText && (userVisibleText.trim() || finalReplyOptions.length > 0)) {
      if (shouldHideApprovedPlanNoToolText) {
        callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      }
      logAgentEvent(rejectedCompletionClaim ? "plan_completion_claim_rejected" : "plan_no_tool_text_suppressed", {
        iteration,
        completionClaimRejected: rejectedCompletionClaim,
        auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
        auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
        remaining: approvedPlanAuditForNoTool?.remainingTasks.length ?? 0,
        visibleChars: userVisibleText.length,
        preservedVisibleText: !shouldHideApprovedPlanNoToolText,
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

    const isAllowedUnapprovedPlanDraftMutationCall = (call: ToolCallToExecute) =>
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      isPreApprovalPlanDraftWrite(call.name, parseToolCallArguments(call, workspace));
    const unsupportedToolCalls = effectiveToolCalls.filter((call) =>
      !availableToolNames.has(call.name) &&
      !isAllowedUnapprovedPlanDraftMutationCall(call)
    );
    const progressEligibleToolCalls = effectiveToolCalls.filter((call) =>
      availableToolNames.has(call.name) ||
      isAllowedUnapprovedPlanDraftMutationCall(call)
    );
    const hasSuppressedUnsupportedPlanToolCalls =
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      unsupportedToolCalls.length > 0;
    const hasSubstantivePlanAssistantText =
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      looksLikeSubstantivePlanAssistantText(visibleAssistantText);
    const toolActionNarration = progressEligibleToolCalls.length > 0
      ? buildToolActionNarration({
        calls: progressEligibleToolCalls,
        workspace,
        language: callbacks.getPreferredLanguage(),
        workflowMode,
        isPlanApproved: callbacks.getIsPlanApproved(),
        userGoal: latestUserPromptText,
        turnIntent,
        currentHypothesis: visibleAssistantText.trim() || lastAssistantTextForCheckpoint,
        previousObservation: recentToolActivity[recentToolActivity.length - 1]?.detail || "",
        userContext: turnInputContextSignals,
      })
      : null;
    const runtimeNarrationInjected = progressEligibleToolCalls.length > 0 && !visibleAssistantText.trim() && !!toolActionNarration;
    if (runtimeNarrationInjected && toolActionNarration) {
      visibleAssistantText = progressNarrationToText(toolActionNarration, callbacks.getPreferredLanguage());
      logAgentEvent("tool_action_narration_injected", {
        iteration,
        workflowMode,
        turnIntent,
        toolCalls: progressEligibleToolCalls.length,
        toolNames: progressEligibleToolCalls.map((call) => call.name).slice(0, 8),
      });
    }
    if (hasSuppressedUnsupportedPlanToolCalls) {
      logAgentEvent("plan_unsupported_tool_call_suppressed", {
        iteration,
        reason: "unavailable_before_progress",
        toolNames: unsupportedToolCalls.map((call) => call.name).slice(0, 8),
        availableToolNames: Array.from(availableToolNames).slice(0, 12),
        preservedVisibleText: visibleAssistantText.trim().length > 0,
        planRuntimePhase,
      });
    }

    if (effectiveToolCalls.length > 0 && containsToolUseBlock(streamText)) {
      const preserveScopedPlanVisibleText =
        workflowMode === "plan" &&
        !callbacks.getIsPlanApproved() &&
        visibleAssistantText.trim().length > 0;
      if (!preserveScopedPlanVisibleText) {
        callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      }
      logAgentEvent("tool_protocol_stream_cleared", {
        iteration,
        toolCalls: effectiveToolCalls.length,
        narrationInjected: visibleAssistantText.trim().length > 0,
        preservedVisibleText: preserveScopedPlanVisibleText,
        workflowMode,
        turnIntent,
      });
    }

    const historyAssistantText = visibleAssistantText || "";
    if (historyAssistantText.trim() && !runtimeNarrationInjected) {
      lastAssistantTextForCheckpoint = historyAssistantText;
    }

    const autoContinueNonBlockingPlanChoices =
      suppressPlanContinuationReplyOptions &&
      effectiveToolCalls.length === 0 &&
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved();
    if (autoContinueNonBlockingPlanChoices) {
      logAgentEvent("plan_non_blocking_choice_auto_continue", {
        iteration,
        replyOptions: normalized.replyOptions.length,
        optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
        visibleChars: normalized.visibleText.length,
        workflowMode,
        turnIntent,
      });
      const nonBlockingHistoryText = serializeAssistantReplyForHistory(historyAssistantText, []);
      if (nonBlockingHistoryText.trim()) {
        callbacks.appendMessage(buildAssistantHistoryMessage(nonBlockingHistoryText, providerReasoningForHistory));
      }
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: callbacks.getPreferredLanguage() === "zh"
          ? "MAIN 已将刚才的非阻塞计划选项视为继续规划许可：不要再询问是否开始探索或是否提供路径；请立即调用一个最具体的只读工具读取/搜索缺失证据。如果证据已经足够，直接创建/更新 `.MAIN/plans/plan.md`。"
          : "MAIN treated the previous non-blocking plan options as permission to continue planning: do not ask whether to start exploration or provide paths again; immediately call one specific read/search tool for the missing evidence. If evidence is sufficient, create/update `.MAIN/plans/plan.md`.",
      });
      continue;
    }

    if (!shouldHideApprovedPlanNoToolText) {
      callbacks.onTurnSummaryReady(visibleAssistantText);
    }

    if (normalized.hiddenThought) {
      callbacks.onThought(normalized.hiddenThought);
    }

    const shouldRenderToolProgress =
      progressEligibleToolCalls.length > 0 &&
      finalReplyOptions.length === 0 &&
      !hasSubstantivePlanAssistantText;
    const shouldPreserveApprovedExecutionText =
      shouldRenderToolProgress &&
      workflowMode === "plan" &&
      callbacks.getIsPlanApproved() &&
      !runtimeNarrationInjected &&
      visibleAssistantText.trim().length > 0;
    if (!shouldHideApprovedPlanNoToolText && (visibleAssistantText || finalReplyOptions.length > 0)) {
      callbacks.onAssistantFinalText(visibleAssistantText, finalReplyOptions, {
        hasToolCalls: effectiveToolCalls.length > 0,
        visibility: hasSubstantivePlanAssistantText
          ? "substantive_plan_text"
          : shouldRenderToolProgress || shouldSuppressApprovedPlanNoToolText ? "user_progress" : undefined,
        preserveAssistantText: shouldPreserveApprovedExecutionText,
        capsuleCandidate: shouldRenderToolProgress && !runtimeNarrationInjected && visibleAssistantText.trim().length > 0,
        modelAuthored: !runtimeNarrationInjected,
        progress: shouldRenderToolProgress
          ? toolActionNarration || undefined
          : undefined,
        hiddenThought: normalized.hiddenThought,
        toolCalls: progressEligibleToolCalls.map((call) => {
          const args = parseToolCallArguments(call, workspace);
          return {
            id: call.id,
            name: call.name,
            target: getToolTarget(call.name, args),
          };
        }),
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
        logAgentEvent("readonly_permission_auto_continue_limit", {
          iteration,
          consecutiveNoToolCount,
          workflowMode,
          turnIntent,
          runtimeIntent,
          usedHardRecovery: usedReadOnlyPermissionHardRecoveryPrompt,
        });
        if (!usedReadOnlyPermissionHardRecoveryPrompt) {
          usedReadOnlyPermissionHardRecoveryPrompt = true;
          consecutiveNoToolCount = 0;
          if (historyAssistantText.trim()) {
            callbacks.appendMessage(buildAssistantHistoryMessage(historyAssistantText, providerReasoningForHistory));
          }
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildReadOnlyPermissionHardRecoveryPrompt(callbacks.getPreferredLanguage(), workflowMode),
          });
          continue;
        }
        callbacks.onNonActionableStop(
          callbacks.getPreferredLanguage() === "zh"
            ? "本轮已暂停：模型在只读许可已授予后仍没有产生有效工具动作。恢复时请直接使用一个未缓存的定向工具调用，或基于已缓存内容继续写入/验证。"
            : "This turn is paused: after read-only permission was granted, the model still did not produce useful tool action. Resume with one uncached targeted tool call, or continue from cached content with write/validation.",
          workflowMode === "plan" ? "incomplete_plan" : "no_action",
        );
        callbacks.onStatusChange("idle");
        return;
      }

      if (historyAssistantText.trim()) {
        callbacks.appendMessage(buildAssistantHistoryMessage(historyAssistantText, providerReasoningForHistory));
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

    const hasExecutablePlanProposalOptions =
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      hasExecutableProposalReplyOptions(rawFinalReplyOptions);
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

    const planEvidenceReadinessForRedirect = assessPlanEvidenceReadiness({
      userContext: turnInputContextSignals,
      recentToolActivity: recentPlanToolActivity,
      hasObservedUserContext: hasPlanUserContextObservation(
        callbacks.getMessages() as AgentMessage[],
        lastAssistantTextForCheckpoint || visibleAssistantText,
      ),
    });
    const shouldRedirectPostConvergenceToolCalls = shouldRedirectPlanToolsAfterReadOnlyConvergence({
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
      hasPlanDecisionOutput: hasStructuredProposal || finalReplyOptions.length > 0 || hasReviewablePlanArtifacts,
      toolNames: effectiveToolCalls
        .filter((call) => !isAllowedUnapprovedPlanDraftMutationCall(call))
        .map((call) => call.name),
      evidenceReadiness: planEvidenceReadinessForRedirect.status,
      planRuntimePhase,
    });
    if (shouldRedirectPostConvergenceToolCalls) {
      if (hasMeaningfulVisibleText) {
        callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
      } else {
        callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
      }
      logAgentEvent("plan_post_convergence_tool_redirect", {
        iteration,
        redirectCount: planPostConvergenceToolRedirectCount + 1,
        toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
        imageParts: turnInputContextSignals.imageParts,
        mentionedFilePaths: turnInputContextSignals.mentionedFilePaths.length,
        attachedFilePaths: turnInputContextSignals.attachedFilePaths.length,
        preservedVisibleText: hasMeaningfulVisibleText,
        evidenceReadiness: planEvidenceReadinessForRedirect.status,
        evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
        planRuntimePhase,
      });
      logAgentEvent("plan_unsupported_tool_call_suppressed", {
        iteration,
        reason: "post_convergence_readonly_tool",
        toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
        availableToolNames: Array.from(availableToolNames).slice(0, 12),
        preservedVisibleText: hasMeaningfulVisibleText,
        evidenceReadiness: planEvidenceReadinessForRedirect.status,
        evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
        planRuntimePhase,
        qualityGateReason: planLastQualityGateReason,
        missingSections: planLastMissingSections,
      });

      const suppressedRecoveryDecision = resolvePlanSuppressedToolRecovery({
        workflowMode,
        isPlanApproved: callbacks.getIsPlanApproved(),
        evidenceReadiness: planEvidenceReadinessForRedirect.status,
        targetedRecoveryPasses: Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses),
      });
      logAgentEvent("plan_suppressed_tool_recovery_decision", {
        iteration,
        action: suppressedRecoveryDecision.action,
        reason: suppressedRecoveryDecision.reason,
        evidenceReadiness: planEvidenceReadinessForRedirect.status,
        evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
        targetedRecoveryPasses: Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses),
      });
      let suppressedDeterministicClosureFailed = false;
      if (suppressedRecoveryDecision.action === "deterministic_materialization") {
        const closureResult = await materializePlanFromEvidenceForReview(
          "post_convergence_suppressed_tool_plan_closure",
          {
            qualityGateReason: planLastQualityGateReason,
            qualityRejectCount: planQualityRejectCount,
          },
        );
        if (closureResult === "approved_continue") continue;
        if (closureResult === "stopped") return;
        suppressedDeterministicClosureFailed = true;
      }
      if (
        suppressedRecoveryDecision.action === "targeted_evidence" ||
        (
          suppressedRecoveryDecision.action === "deterministic_materialization" &&
          Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses) < 1
        )
      ) {
        planReasoningOnlyRecoveryPasses += 1;
        setPlanRuntimePhase("needs_evidence", planEvidenceReadinessForRedirect.reason);
        callbacks.onStatusChange("running");
        callbacks.appendMessage({
          role: "user",
          content: buildPlanTargetedEvidenceRecoveryPrompt({
            language: callbacks.getPreferredLanguage(),
            reason: planEvidenceReadinessForRedirect.reason,
          }),
        });
        continue;
      }
      if (suppressedRecoveryDecision.action === "pause_blocked") {
        setPlanRuntimePhase("blocked", planEvidenceReadinessForRedirect.reason, "failed");
        callbacks.onNonActionableStop(
          buildPlanEvidenceBlockedPauseMessage({
            language: callbacks.getPreferredLanguage(),
            reason: planEvidenceReadinessForRedirect.reason,
          }),
          "incomplete_plan",
          {
            recoveryReason: "plan_suppressed_tool_evidence_blocked",
            nextStep: callbacks.getPreferredLanguage() === "zh"
              ? "补充一个具体缺失事实或关键选择后继续"
              : "provide the concrete missing fact or key decision, then resume",
          },
        );
        callbacks.onStatusChange("idle");
        return;
      }
      if (
        suppressedDeterministicClosureFailed &&
        Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses) >= 1
      ) {
        setPlanRuntimePhase("blocked", "deterministic closure failed", "failed");
        callbacks.onNonActionableStop(
          buildPlanEvidenceBlockedPauseMessage({
            language: callbacks.getPreferredLanguage(),
            reason: "deterministic_plan_materialization_failed",
          }),
          "incomplete_plan",
          {
            recoveryReason: "plan_suppressed_tool_materialization_failed",
            nextStep: callbacks.getPreferredLanguage() === "zh"
              ? "检查计划证据账本和物化质量门禁"
              : "inspect the plan evidence ledger and materialization quality gate",
          },
        );
        callbacks.onStatusChange("idle");
        return;
      }

      planPostConvergenceToolRedirectCount += 1;
      if (String(planRuntimePhase) !== "needs_rewrite") {
        setPlanRuntimePhase("drafting", "read-only tool suppressed");
      }
      callbacks.onStatusChange("running");
      const shouldIssueAutoScaffold =
        planPostConvergenceToolRedirectCount >= 2 &&
        planQualityRejectCount >= 1 &&
        !planAutoScaffoldPromptIssued;
      if (shouldIssueAutoScaffold) {
        planAutoScaffoldPromptIssued = true;
        setPlanRuntimePhase("needs_rewrite", "auto scaffold after repeated blocked reads");
        callbacks.appendMessage({
          role: "user",
          content: buildPlanAutoScaffoldPrompt({
            language: callbacks.getPreferredLanguage(),
            latestUserPromptText,
            recentToolActivity: recentPlanToolActivity,
            qualityGateReason: planLastQualityGateReason,
            missingSections: planLastMissingSections,
          }),
        });
        continue;
      }
      callbacks.appendMessage({
        role: "user",
        content: buildPlanPostConvergenceToolRedirectPrompt({
          language: callbacks.getPreferredLanguage(),
          toolNames: effectiveToolCalls.map((call) => call.name),
          userContext: turnInputContextSignals,
          phase: planRuntimePhase,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
          rejectCount: planQualityRejectCount,
        }),
      });
      continue;
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
      callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
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
      const truncatedAfterCachedReadOnly =
        wasTruncated &&
        !sawExecuteOperationEvidence &&
        recentPlanToolActivity.slice(-4).some(isCachedReadOnlyPlanActivity);

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

      if (truncatedAfterCachedReadOnly) {
        const recoveryInput = {
          reason: "no_progress_cached_read_only_length",
          remainingText,
          logContext: {
            finishReason: normalized.finishReason || "unknown",
            hiddenThoughtChars: normalized.hiddenThought.length,
            visibleChars: normalized.visibleText.length,
          },
        };
        if (approvedPlanNoProgressRecoveryAttempts < MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS) {
          continueApprovedPlanWithStrategySwitch(recoveryInput);
          continue;
        } else {
          pauseApprovedPlanNoProgressLoop({
            ...recoveryInput,
            repeats: Math.max(1, consecutiveNoToolCount),
          });
          return;
        }
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
            ? "恢复后先核查当前 workspace 状态，再基于 runtime 任务清单继续；只有已知存在时才读取 tasks.md"
            : "on resume, inspect current workspace state and continue from the runtime task list; read tasks.md only if it is already known to exist",
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
        const isExecuteRuntimeWithoutEvidence =
          workflowMode === "edit" ||
          turnIntent === "execute" ||
          runtimeIntent === "execute" ||
          runtimeIntent === "studio_workflow";
        const rejectedExecuteCompletionClaim =
          isExecuteRuntimeWithoutEvidence &&
          finalReplyOptions.length === 0 &&
          !sawExecuteOperationEvidence &&
          looksLikeOperationCompletionClaim(visibleAssistantText || userVisibleText);
        if (rejectedExecuteCompletionClaim) {
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          callbacks.onStatusChange("running");
          consecutiveNoToolCount++;
          logAgentEvent("execute_completion_claim_without_evidence", {
            iteration,
            consecutiveNoToolCount,
            workflowMode,
            turnIntent,
            runtimeIntent,
            visibleChars: (visibleAssistantText || userVisibleText).length,
          });

          if (usedExecuteCompletionEvidencePrompt || consecutiveNoToolCount >= MAX_NO_ACTION_RETRIES) {
            logAgentEvent("loop_stop", {
              reason: "execute_completion_claim_without_evidence",
              iteration,
              consecutiveNoToolCount,
            });
            callbacks.onNonActionableStop(
              buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution"),
              "no_action",
            );
            callbacks.onStatusChange("idle");
            return;
          }

          usedExecuteCompletionEvidencePrompt = true;
          callbacks.appendMessage({
            role: "user",
            content: buildExecuteCompletionEvidencePrompt(callbacks.getPreferredLanguage(), consecutiveNoToolCount),
          });
          continue;
        }

        const rejectedExecuteReplanningText =
          isExecuteRuntimeWithoutEvidence &&
          finalReplyOptions.length === 0 &&
          !sawExecuteOperationEvidence &&
          looksLikeExecutionReplanningText(visibleAssistantText || userVisibleText);
        if (rejectedExecuteReplanningText) {
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          callbacks.onStatusChange("running");
          consecutiveNoToolCount++;
          logAgentEvent("execute_replanning_text_without_evidence", {
            iteration,
            consecutiveNoToolCount,
            workflowMode,
            turnIntent,
            runtimeIntent,
            visibleChars: (visibleAssistantText || userVisibleText).length,
          });

          if (usedExecuteReplanningEvidencePrompt || consecutiveNoToolCount >= MAX_NO_ACTION_RETRIES) {
            logAgentEvent("loop_stop", {
              reason: "execute_replanning_text_without_evidence",
              iteration,
              consecutiveNoToolCount,
            });
            callbacks.onNonActionableStop(
              buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution"),
              "no_action",
            );
            callbacks.onStatusChange("idle");
            return;
          }

          usedExecuteReplanningEvidencePrompt = true;
          callbacks.appendMessage({
            role: "user",
            content: buildExecuteReplanningEvidencePrompt(callbacks.getPreferredLanguage(), consecutiveNoToolCount),
          });
          continue;
        }

        // ── Plan Mode Interception ────────────────────────────────
        // In Plan mode, only enter review when the model has either:
        // 1. submitted a valid top-level proposal payload, or
        // 2. finished writing spec artifacts up to a legacy ready_to_execute stage.
        // Ordinary summaries / progress notes stay in ChatArea only.
        if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && (hasStructuredProposal || hasReviewablePlanArtifacts)) {
          let hasMaterializedStructuredProposal = hasReviewablePlanArtifacts;
          if (hasStructuredProposal && !hasReviewablePlanArtifacts) {
            const materializedProposal = await autoMaterializePlanArtifactFromVisibleText({
              visibleText: sourceVisibleText || streamText,
              workspace,
              callbacks,
              userGoal: latestUserPromptText,
              recentToolActivity: recentPlanToolActivity,
              attemptedTargets: attemptedPlanWriteTargets,
              turnContext: turnInputContextSignals,
            });
            logAgentEvent(materializedProposal.ok ? "plan_structured_proposal_materialized" : "plan_structured_proposal_materialization_rejected", {
              iteration,
              ok: materializedProposal.ok,
              path: materializedProposal.path || "",
              kind: materializedProposal.kind || "",
              reason: materializedProposal.reason || "",
              planArtifactSource: materializedProposal.source || "",
              visibleChars: (sourceVisibleText || streamText).length,
            });
            hasMaterializedStructuredProposal = materializedProposal.ok;
          }
          if (hasMaterializedStructuredProposal) {
            setPlanRuntimePhase("review_ready", "proposal ready", "done");
            callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
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
            const continuationPrompt = buildApprovedPlanContinuationPrompt(callbacks);
            if (callbacks.onApprovedPlanHandoff) {
              callbacks.onApprovedPlanHandoff(continuationPrompt);
              callbacks.onStatusChange("idle");
              return;
            }
            const continuationMsg: AgentMessage = {
              role: "user",
              content: continuationPrompt,
            };
            callbacks.appendMessage(continuationMsg);
            continue;
          }
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
          (sawPlanModeToolActivity || wasTruncated || hasExecutablePlanProposalOptions || planReplyOptionsRoutedToArtifact);
        const shouldTryPlanTextMaterialization =
          planningStillIncomplete &&
          hasMeaningfulSourcePlanText &&
          !hasReviewablePlanArtifacts &&
          (finalReplyOptions.length === 0 || hasExecutablePlanProposalOptions || planReplyOptionsRoutedToArtifact) &&
          !hasStructuredProposal &&
          (
            sawPlanModeToolActivity ||
            wasTruncated ||
            hasExecutablePlanProposalOptions ||
            planReplyOptionsRoutedToArtifact ||
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
            userGoal: latestUserPromptText,
            recentToolActivity: recentPlanToolActivity,
            attemptedTargets: attemptedPlanWriteTargets,
            turnContext: turnInputContextSignals,
          });

          if (materializedPlan.ok) {
            setPlanRuntimePhase("review_ready", "materialized plan accepted", "done");
            callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
            logAgentEvent("plan_text_materialized", {
              iteration,
              path: materializedPlan.path,
              kind: materializedPlan.kind,
              planArtifactSource: materializedPlan.source || "",
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
            const continuationPrompt = buildApprovedPlanContinuationPrompt(callbacks);
            if (callbacks.onApprovedPlanHandoff) {
              callbacks.onApprovedPlanHandoff(continuationPrompt);
              callbacks.onStatusChange("idle");
              return;
            }
            callbacks.appendMessage({
              role: "user",
              content: continuationPrompt,
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
          if (sourceVisibleText.trim()) {
            callbacks.onAssistantFinalText(sourceVisibleText, [], {
              hasToolCalls: false,
              visibility: "substantive_plan_text",
            });
          }
          callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));

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
              if (!planDeterministicClosureEvidenceRecoveryIssued && planEvidenceRecoveryPasses < 1) {
                planDeterministicClosureEvidenceRecoveryIssued = true;
                setPlanRuntimePhase("needs_evidence", "deterministic closure failed");
                callbacks.onStatusChange("running");
                callbacks.appendMessage({
                  role: "user",
                  content: buildDeterministicClosureEvidenceRecoveryPrompt(
                    planLastQualityGateReason || "deterministic closure failed",
                  ),
                });
                continue;
              }
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
            callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
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
                ? "你已经有旧流程的 requirements.md，下一步必须创建/更新 `.MAIN/plans/plan.md` 作为可审批方案；如果设计方向仍不明确，只能用 `<user_options>` 给出面向用户的选择并停止。不要重复读取已读文件。"
                : currentPlanStage === "design"
                ? "你已经有 plan.md，下一步应输出正式 Proposal 或给用户关键选择；不要在批准前提前生成 tasks.md。"
                : sawPlanModeToolActivity
                ? "你已经开始做项目探索了，但还没有给出可让用户决策的规划结果。下一步应先收束分歧并询问用户。"
                : "请先给出可让用户决策的规划问题。"
              : currentPlanStage === "requirements"
              ? "A legacy requirements.md exists. Next create/update `.MAIN/plans/plan.md` as the reviewable plan; if the plan direction is still unclear, offer `<user_options>` and stop. Do not repeat reads of files already in context."
              : currentPlanStage === "design"
              ? "plan.md exists. Next submit the formal Proposal or offer the key choices; do not generate tasks.md before approval."
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
                  "2. 如果信息已经足够，用 write_file 或 replace_in_file 创建/更新 `.MAIN/plans/plan.md`，提交正式可审批方案。\n" +
                  "3. 如果这是复杂实现计划，必须落盘可审批 plan.md；requirements.md 只是可选需求台账，在用户批准之前不要生成 `tasks.md` 或修改源码。\n" +
                  `${currentPlanStage === "requirements" ? "当前已经有旧流程 requirements.md，本轮不要重复读文件；请直接写入 plan.md，或用 user_options 询问设计分叉。\n" : ""}` +
                  `${wasTruncated ? "你上一条回复已经发生截断，请从中断处继续，不要重头重复。\n" : ""}` +
                  "不要只输出一句总结、结束语，或空结束符。"
                : `The current plan has not reached an executable stage. ${missingStepHint}\n` +
                  `${CONCISE_PLAN_ARTIFACT_HINT_EN}\n` +
                  "Continue planning and complete one of these before ending this turn:\n" +
                  "1. Output 3-8 key judgments in Markdown, then offer 2-4 `<user_options>` for the user to choose from.\n" +
                  "2. If there is enough information, use write_file or replace_in_file to create/update `.MAIN/plans/plan.md` as the formal reviewable plan.\n" +
                  "3. For complex implementation planning, the reviewable plan must be persisted to plan.md; requirements.md is only an optional requirement ledger. Do not generate `tasks.md` or edit source files before approval.\n" +
                  `${currentPlanStage === "requirements" ? "A legacy requirements.md already exists. Do not repeat file reads in this turn; write plan.md directly, or ask for design choices with user_options.\n" : ""}` +
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
            if (
              isExecuteRuntimeWithoutEvidence &&
              recentToolActivity.length >= 3 &&
              !sawExecuteOperationEvidence
            ) {
              const pauseMessage = buildExecuteNoActionPauseMessage({
                language: callbacks.getPreferredLanguage(),
                recentToolActivity,
                visibleText: visibleAssistantText || userVisibleText,
              });
              logAgentEvent("loop_stop", {
                reason: "execute_read_only_no_action_checkpoint",
                iteration,
                consecutiveNoToolCount,
                recentToolActivity: recentToolActivity.length,
                repeatedTargets: summarizeRepeatedPlanTargetsFromToolActivity(recentToolActivity),
              });
              callbacks.onNonActionableStop(
                pauseMessage,
                "no_action",
                {
                  repeatedTargets: summarizeRepeatedPlanTargetsFromToolActivity(recentToolActivity),
                  recoveryReason: "execute_read_only_no_action_checkpoint",
                  nextStep: callbacks.getPreferredLanguage() === "zh"
                    ? "复用已读上下文，转向写入/验证/明确阻塞"
                    : "reuse read context and pivot to write/verify/a concrete blocker",
                },
              );
              callbacks.onStatusChange("idle");
              return;
            }
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
                    ? `${rejectedCompletionClaim ? "你刚才的完成声明没有通过可信证据审计；不要再输出完成总结，先继续真实执行。\n" : ""}继续执行当前任务清单中证据未满足的任务。不要重复计划说明，直接根据当前进度继续实现下一个任务；如果需要修改文件，继续使用工具调用；如果文件已读且再次读取只返回 \`FILE_UNCHANGED_STUB\`，不要继续重复读取，必须写入/替换、换目标，或明确暂停说明阻塞。凡是任务里带有 shell 命令的，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr；长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查结果。完成当前任务后，必须先产生真实文件/命令/验证证据；如果 \`.MAIN/plans/tasks.md\` 已存在，再更新对应 checkbox 为 \`[x]\`。只有所有任务证据满足后才能结束。\n下一批优先任务：\n`
                    : `${rejectedCompletionClaim ? "Your completion claim did not pass the trusted evidence audit; do not output a final summary yet, continue the real work first.\n" : ""}Continue executing tasks whose evidence is not satisfied in the current task list. Do not restate the plan; just move to the next task based on the current progress. If a file has already been read and another read only returns \`FILE_UNCHANGED_STUB\`, do not keep rereading it: write/patch, choose another target, or pause with the exact blocker. If a task includes shell commands, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status. After each task, produce real file/command/verification evidence; if \`.MAIN/plans/tasks.md\` exists, update the matching checkbox to \`[x]\`. Only stop when every task has satisfied evidence.\nNext priority tasks:\n`) +
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
          callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
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
        callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
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

    callbacks.appendMessage(buildAssistantHistoryMessage(
      historyAssistantText,
      providerReasoningForHistory,
      { tool_calls: toolCallsForMsg },
    ));

    // Partition tool calls into auto-executable, local file read approvals,
    // spec file writes (auto-approved in Plan Mode), and review-gated tools.
    const readOnlyCalls: Array<ToolCallToExecute & { allowExternalLocalRead?: boolean }> = [];
    const localFileReadCalls: Array<ToolCallToExecute & { localFileReadPath: string }> = [];
    const specFileCalls: ToolCallToExecute[] = [];
    const writeCalls: ToolCallToExecute[] = [];
    const toolArgsByCallId = new Map<string, Record<string, unknown>>();
    const readOnlyCallSignatures = new Map<string, string>();
    const readFileWindowNarrowedNotes = new Map<string, string>();
    const queuedReadOnlySignatures = new Set<string>();
    const toolFailureSignatures = new Map<string, string>();
    let allResults: ToolExecutionResult[] = [];

    for (const tc of effectiveToolCalls) {
      let toolArgs = parseToolCallArguments(tc, workspace);
      const targetingProfile = buildCurrentTaskTargetingProfile();
      const isPlanStructureExploreTool =
        workflowMode === "plan" &&
        !callbacks.getIsPlanApproved() &&
        planRuntimePhase === "explore_structure" &&
        tc.name === "get_project_skeleton";
      if (
        tc.name === "get_project_skeleton" &&
        (targetingProfile.allowRootSkeleton || isPlanStructureExploreTool) &&
        (
          toolArgs.depth == null ||
          String(toolArgs.depth).trim() === "" ||
          Number(toolArgs.depth) > 2
        )
      ) {
        toolArgs = { ...toolArgs, depth: 2 };
        tc.arguments = JSON.stringify(toolArgs);
        logAgentEvent("task_targeting_tool_args_normalized", {
          iteration,
          tool: tc.name,
          reason: isPlanStructureExploreTool ? "plan_explore_structure_depth_clamp" : "shallow_root_skeleton_default",
          depth: 2,
          imageParts: targetingProfile.imageParts,
          hasUserProvidedContext: targetingProfile.hasUserProvidedContext,
        });
      }
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

      const isAllowedPlanDraftMutation =
        workflowMode === "plan" &&
        !callbacks.getIsPlanApproved() &&
        isPreApprovalPlanDraftWrite(tc.name, toolArgs);
      if (!availableToolNames.has(tc.name) && !isAllowedPlanDraftMutation) {
        const isUnapprovedPlanContext = workflowMode === "plan" && !callbacks.getIsPlanApproved();
        const message = planUnsupportedToolFeedbackMessage({
          language: callbacks.getPreferredLanguage(),
          toolName: tc.name,
          runtimeIntent,
          workflowMode,
          isPlanApproved: callbacks.getIsPlanApproved(),
          planRuntimePhase,
          availableToolNames: Array.from(availableToolNames),
        });
        logAgentEvent("plan_unsupported_tool_call_suppressed", {
          iteration,
          tool: tc.name,
          target,
          runtimeIntent,
          workflowMode,
          isPlanApproved: callbacks.getIsPlanApproved(),
          availableToolNames: Array.from(availableToolNames).slice(0, 12),
          planRuntimePhase,
          internalFeedback: isUnapprovedPlanContext,
        });
        if (!isUnapprovedPlanContext) {
          callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
        }
        allResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: `Error: ${message}`,
          isError: true,
          lifecycleState: "blocked",
          ...(isUnapprovedPlanContext ? { internalFeedback: true, displayContent: "" } : {}),
        });
        continue;
      }

      const targetingGate = isPlanStructureExploreTool
        ? { blocked: false }
        : shouldBlockToolCallForTargeting({
            profile: targetingProfile,
            toolName: tc.name,
            args: toolArgs,
            target,
            availableToolNames,
            language: callbacks.getPreferredLanguage(),
            allowApprovedPlanDesignWrite:
              workflowMode === "plan" &&
              callbacks.getIsPlanApproved() &&
              runtimeIntent === "execute",
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
          imageParts: targetingProfile.imageParts,
          hasUserProvidedContext: targetingProfile.hasUserProvidedContext,
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

      if (
        workflowMode === "plan" &&
        callbacks.getIsPlanApproved() &&
        approvedPlanActionOnlyRecoveryActive &&
        isReadOnlyShellInspectionToolCall(tc.name, toolArgs)
      ) {
        const message = callbacks.getPreferredLanguage() === "zh"
          ? [
              "APPROVED_PLAN_SHELL_READ_BLOCKED: 已批准计划的执行阶段不能在首次项目写入前用 shell 分页读取源码。",
              "请复用已批准 plan.md 和已确认的源码证据，直接使用 `apply_patch`、`replace_in_file` 或 `write_file` 修改目标源码文件；写入后再运行验证命令。",
            ].join("\n")
          : [
              "APPROVED_PLAN_SHELL_READ_BLOCKED: approved plan execution must not page source files through shell before the first project write.",
              "Reuse the approved plan and confirmed source evidence, then call `apply_patch`, `replace_in_file`, or `write_file` against the target source file. Run validation commands after the write.",
            ].join("\n");
        callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
        logAgentEvent("approved_plan_shell_read_blocked", {
          iteration,
          tool: tc.name,
          target,
          actionOnly: approvedPlanActionOnlyRecoveryActive,
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
      const effectiveAvailableToolNames = isAllowedPlanDraftMutation
        ? new Set([...availableToolNames, tc.name])
        : availableToolNames;
      const planned = planRuntimeToolCall({
        toolCall: tc,
        workspace,
        availableToolNames: effectiveAvailableToolNames,
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
        let effectiveToolArgs = toolArgs;
        let signature = buildReadOnlyCacheSignature(tc.name, effectiveToolArgs);
        let cached = readOnlyResultCache.get(signature);
        const fileReadMetadata =
          tc.name === "read_file" && typeof toolArgs.path === "string"
            ? await readFileMetadataIfAvailable(toolArgs.path, workspace)
            : null;
        let fileReadSignature =
          tc.name === "read_file" && typeof toolArgs.path === "string"
            ? buildFileReadSignature(fileReadMetadata?.path ?? toolArgs.path, effectiveToolArgs)
            : "";
        let fileReadState = fileReadSignature ? fileReadStates.get(fileReadSignature) : undefined;
        const bypassApprovedPlanPatchRecoveryReadCache =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          runtimeIntent === "execute" &&
          shouldBypassApprovedPlanReadCacheForPatchRecovery({
            toolName: tc.name,
            allowFileRead: allowApprovedPlanRecoveryFileRead,
          });
        if (bypassApprovedPlanPatchRecoveryReadCache) {
          logAgentEvent("approved_plan_patch_recovery_read_cache_bypass", {
            iteration,
            target,
            recentActivity: recentPlanToolActivity.slice(-4).map((activity) => ({
              name: activity.name,
              target: activity.target,
              status: activity.status,
            })),
          });
        }

        if (fileReadState && !bypassApprovedPlanPatchRecoveryReadCache) {
          const metadata = fileReadMetadata ?? await readFileMetadataIfAvailable(fileReadState.path, workspace);
          const unchanged =
            metadata != null &&
            metadata.sizeBytes === fileReadState.sizeBytes &&
            metadata.modifiedMs === fileReadState.modifiedMs;

          if (!unchanged) {
            fileReadStates.delete(fileReadSignature);
            logAgentEvent("file_read_cache_invalidated", {
              iteration,
              target: target || fileReadState.path,
              reason: metadata ? "metadata_changed" : "metadata_unavailable",
              signature: truncateForLog(fileReadSignature, 180),
              previous: {
                sizeBytes: fileReadState.sizeBytes,
                modifiedMs: fileReadState.modifiedMs,
                contentHash: fileReadState.contentHash,
              },
              current: metadata
                ? {
                    sizeBytes: metadata.sizeBytes,
                    modifiedMs: metadata.modifiedMs,
                  }
                : null,
            });
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
              (duplicateCount >= PLAN_REPEAT_READ_LIMIT || planBudget.shouldRedirectToPlanClosure);
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
            logAgentEvent("file_read_cache_hit", {
              iteration,
              target: target || fileReadState.path,
              decision: shouldPushPlanReadLimit ? "unchanged_stub_with_plan_redirect" : "unchanged_stub",
              signature: truncateForLog(fileReadSignature, 180),
              duplicateCount,
              sizeBytes: fileReadState.sizeBytes,
              modifiedMs: fileReadState.modifiedMs,
              contentHash: fileReadState.contentHash,
            });
            const baseStub = buildFileUnchangedStub(fileReadState);
            const closurePrompt = shouldPushPlanReadLimit
              ? `\n\n${buildPlanClosurePromptFromEvidence(callbacks, recentPlanToolActivity, attemptedPlanWriteTargets, latestUserPromptText)}`
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

        if (
          tc.name === "read_file" &&
          typeof toolArgs.path === "string" &&
          fileReadMetadata &&
          !bypassApprovedPlanPatchRecoveryReadCache
        ) {
          const coverage = getReadFileCoverageForPath({
            states: fileReadStates,
            path: toolArgs.path,
            metadata: fileReadMetadata,
            currentSignature: fileReadSignature,
          });
          if (coverage.fullFileState) {
            const duplicateCount = (readOnlyDuplicateSkipCounts.get(coverage.fullFileState.signature) ?? 0) + 1;
            readOnlyDuplicateSkipCounts.set(coverage.fullFileState.signature, duplicateCount);
            const content = buildFileUnchangedStub(coverage.fullFileState);
            logAgentEvent("file_read_cache_hit", {
              iteration,
              target: target || coverage.fullFileState.path,
              decision: "full_file_covers_requested_read",
              signature: truncateForLog(coverage.fullFileState.signature, 180),
              duplicateCount,
              sizeBytes: coverage.fullFileState.sizeBytes,
              modifiedMs: coverage.fullFileState.modifiedMs,
              contentHash: coverage.fullFileState.contentHash,
            });
            allResults.push({
              toolCallId: tc.id,
              name: tc.name,
              target,
              content,
              displayContent: `${FILE_UNCHANGED_STUB}: ${target || coverage.fullFileState.path}`,
              isError: false,
            });
            continue;
          }

          if (coverage.ranges.length > 0) {
            const totalLines = Math.max(
              coverage.totalLines,
              ...coverage.ranges.map((range) => range.endLine),
            );
            const resolvedCoveragePlan = planReadFileWindowCoverage(effectiveToolArgs, totalLines, coverage.ranges);
            if (resolvedCoveragePlan.fullyCovered) {
              const duplicateCount = (readOnlyDuplicateSkipCounts.get(fileReadSignature || signature) ?? 0) + 1;
              readOnlyDuplicateSkipCounts.set(fileReadSignature || signature, duplicateCount);
              const content = formatReadFileWindowCoverageStub(fileReadMetadata.path, resolvedCoveragePlan);
              logAgentEvent("file_read_cache_hit", {
                iteration,
                target: target || fileReadMetadata.path,
                decision: "window_fully_covered",
                signature: truncateForLog(fileReadSignature || signature, 180),
                duplicateCount,
                requested: resolvedCoveragePlan.original,
                coveredRanges: resolvedCoveragePlan.coveredRanges,
              });
              allResults.push({
                toolCallId: tc.id,
                name: tc.name,
                target,
                content,
                displayContent: `${FILE_UNCHANGED_STUB}: ${target || fileReadMetadata.path}`,
                isError: false,
              });
              continue;
            }
            if (resolvedCoveragePlan.overlapped && resolvedCoveragePlan.suggestedArgs) {
              effectiveToolArgs = resolvedCoveragePlan.suggestedArgs;
              signature = buildReadOnlyCacheSignature(tc.name, effectiveToolArgs);
              cached = readOnlyResultCache.get(signature);
              fileReadSignature = buildFileReadSignature(fileReadMetadata.path, effectiveToolArgs);
              fileReadState = fileReadStates.get(fileReadSignature);
              const note = formatReadFileWindowNarrowedNote(fileReadMetadata.path, resolvedCoveragePlan);
              if (note) readFileWindowNarrowedNotes.set(tc.id, note);
              logAgentEvent("file_read_cache_window_narrowed", {
                iteration,
                target: target || fileReadMetadata.path,
                original: resolvedCoveragePlan.original,
                suggestedRange: resolvedCoveragePlan.suggestedRange,
                coveredRanges: resolvedCoveragePlan.coveredRanges,
                newSignature: truncateForLog(fileReadSignature, 180),
              });
              if (fileReadState) {
                readFileWindowNarrowedNotes.delete(tc.id);
                const content = buildFileUnchangedStub(fileReadState);
                logAgentEvent("file_read_cache_hit", {
                  iteration,
                  target: target || fileReadState.path,
                  decision: "narrowed_window_already_cached",
                  signature: truncateForLog(fileReadSignature, 180),
                  sizeBytes: fileReadState.sizeBytes,
                  modifiedMs: fileReadState.modifiedMs,
                  contentHash: fileReadState.contentHash,
                });
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
          }
        }

        if (!bypassApprovedPlanPatchRecoveryReadCache && (cached || queuedReadOnlySignatures.has(signature))) {
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
            (duplicateCount >= PLAN_REPEAT_READ_LIMIT || planBudget.shouldRedirectToPlanClosure);
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
            ? `\n\n${buildPlanClosurePromptFromEvidence(callbacks, recentPlanToolActivity, attemptedPlanWriteTargets, latestUserPromptText)}`
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
          arguments: JSON.stringify(effectiveToolArgs),
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
        const reviewSignature = buildRepeatLoopSignature(tc.name, buildRepeatLoopArgsKey(toolArgs));
        const cachedBrowserValidation =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          runtimeIntent === "execute" &&
          tc.name === "browser_evaluate"
            ? approvedPlanBrowserValidationCache.get(reviewSignature)
            : undefined;
        if (cachedBrowserValidation) {
          logAgentEvent("approved_plan_browser_validation_reused", {
            iteration,
            target,
            signature: truncateForLog(reviewSignature, 180),
          });
          allResults.push({
            toolCallId: tc.id,
            name: tc.name,
            target,
            content: [
              `REUSED_BROWSER_VALIDATION: identical browser_evaluate for ${target || "the same target"} already succeeded in this execution turn.`,
              "Reuse the previous browser/DOM result and continue with the next unverified task or final summary.",
              "",
              truncateToolContent(cachedBrowserValidation.content || cachedBrowserValidation.displayContent || "", 4000),
            ].filter(Boolean).join("\n"),
            displayContent: `REUSED_BROWSER_VALIDATION: ${target || cachedBrowserValidation.target || "browser_evaluate"}`,
            isError: false,
            lifecycleState: "completed",
          });
          continue;
        }
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
        {
          turnContext: turnInputContextSignals,
          recentPlanToolActivity,
          attemptedPlanWriteTargets,
        },
      );
      const normalizedReadResults: ToolExecutionResult[] = [];
      for (const result of readResults) {
        const narrowedNote = readFileWindowNarrowedNotes.get(result.toolCallId);
        const resultForModel = narrowedNote && !result.isError
          ? {
              ...result,
              content: `${narrowedNote}\n\n${result.content}`,
              displayContent: result.displayContent || `${narrowedNote}\n\n${result.content}`,
            }
          : result;
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
            logAgentEvent("file_read_cache_stored", {
              iteration,
              target: result.target || metadata.path,
              signature: truncateForLog(fileReadSignature, 180),
              reason: previous ? "content_or_metadata_changed" : "new_read",
              cacheSize: fileReadStates.size,
              sizeBytes: metadata.sizeBytes,
              modifiedMs: metadata.modifiedMs,
              contentChars: result.content.length,
              contentHash,
            });
          }
          readOnlyDuplicateSkipCounts.delete(fileReadSignature);
        }
        normalizedReadResults.push(resultForModel);
      }
      allResults.push(...normalizedReadResults);
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
        {
          turnContext: turnInputContextSignals,
          recentPlanToolActivity,
          attemptedPlanWriteTargets,
        },
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
        {
          turnContext: turnInputContextSignals,
          recentPlanToolActivity,
          attemptedPlanWriteTargets,
        },
      );
      allResults.push(result);
      if (tc.name === "browser_evaluate" && !result.isError) {
        const toolArgs = parseToolCallArguments(tc, workspace);
        const signature = buildRepeatLoopSignature(tc.name, buildRepeatLoopArgsKey(toolArgs));
        approvedPlanBrowserValidationCache.set(signature, result);
      }

      // Check if the loop was aborted during user review
      if (abortController.signal.aborted) {
        callbacks.onStatusChange("idle");
        return;
      }
    }

    for (const result of allResults) {
      if (result.isError) continue;
      if (!PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)) {
        sawExecuteOperationEvidence = true;
      }
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
        sawExecuteOperationEvidence = true;
        recoveringFromEmptyAssistantReplyAfterWrite = false;
        continue;
      }
      if (EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name)) {
        sawExecuteOperationEvidence = true;
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
    const externalResultsForDigest = allResults.filter((result) => !result.internalFeedback);
    if (callbacks.onExecutionDigestUpdate && externalResultsForDigest.length > 0) {
      const digest = buildExecutionDigest({
        language: callbacks.getPreferredLanguage(),
        turnIntent,
        toolResults: externalResultsForDigest,
        remainingTask: remainingTaskForDigest?.text,
      });
      if (digest) callbacks.onExecutionDigestUpdate(digest);
    }

    if (workflowMode === "plan") {
      allResults.forEach(rememberPlanToolActivity);
    }
    if (
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      planRuntimePhase === "explore_structure" &&
      allResults.some((result) => result.name === "get_project_skeleton" && !result.internalFeedback)
    ) {
      const structureSucceeded = allResults.some((result) =>
        result.name === "get_project_skeleton" &&
        !result.internalFeedback &&
        !result.isError
      );
      if (structureSucceeded) {
        setPlanRuntimePhase("explore_structure", "project structure explored", "done");
        setPlanRuntimePhase("grounding", "after project structure");
      } else {
        setPlanRuntimePhase("grounding", "project structure unavailable; continue targeted grounding");
      }
    }
    emitTaskOrchestratorPhase("EVIDENCE_RECONCILE", {
      iteration,
      results: allResults.length,
      successfulResults: allResults.filter((result) => !result.isError).length,
      evidenceKeys: [...taskTargetingEvidence].slice(-8),
    });

    const successfulReadOnlyExplorationResults = allResults.filter((result) =>
      !result.isError && PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
    );
    const nonReadOnlySuccessfulResultCount = allResults.filter((result) =>
      !result.isError && !PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
    ).length;
    if (workflowMode === "plan" && callbacks.getIsPlanApproved() && nonReadOnlySuccessfulResultCount > 0) {
      approvedPlanActionOnlyRecoveryActive = false;
      approvedPlanNoProgressRecoveryAttempts = 0;
    }
    if (workflowMode === "edit" && nonReadOnlySuccessfulResultCount > 0) {
      clearExecuteRecovery("action_evidence_observed");
    }
    const hasPlanDecisionOutput =
      hasStructuredProposal ||
      finalReplyOptions.length > 0 ||
      isReviewablePlanStage(callbacks.getPlanStage()) ||
      allResults.some(isSuccessfulPlanArtifactWriteResult);
    const isUnapprovedPlanReadOnlyBatch = shouldDeferNoProgressStopToPlanReadOnlyConvergence({
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      hasPlanDecisionOutput,
      resultCount: allResults.length,
      successfulReadOnlyResultCount: successfulReadOnlyExplorationResults.length,
      nonReadOnlySuccessfulResultCount,
    });
    const wasPlanEvidenceRecoveryPhase = String(planRuntimePhase) === "needs_evidence";
    let pendingPlanRuntimeRecoveryPrompt: string | null = null;
    let pendingExecuteRecoveryPrompt: string | null = null;
    let pendingExecuteNoProgressPause: {
      notice: string;
      repeatedTargets: string[];
      progressSignature: string;
      reason: string;
    } | null = null;
    let pendingPlanDeterministicQualityClosure: {
      trigger: string;
      qualityGateReason: string;
      qualityRejectCount: number;
    } | null = null;
    const planQualityRecoveryResults = allResults.filter((result) =>
      result.internalFeedback &&
      !!result.planRecoveryAction
    );
    if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && planQualityRecoveryResults.length > 0) {
      planQualityRejectCount += planQualityRecoveryResults.length;
      const latestQualityResult = planQualityRecoveryResults[planQualityRecoveryResults.length - 1];
      planLastQualityGateReason = latestQualityResult.qualityGateReason || "quality_gate";
      planLastMissingSections = latestQualityResult.missingPlanSections || [];
      logAgentEvent("plan_quality_recovery_action", {
        iteration,
        recoveryAction: latestQualityResult.planRecoveryAction,
        qualityRejectCount: planQualityRejectCount,
        qualityGateReason: planLastQualityGateReason,
        missingSections: planLastMissingSections,
        evidenceRecoveryPasses: planEvidenceRecoveryPasses,
      });

      if (latestQualityResult.planRecoveryAction === "targeted_evidence" && planEvidenceRecoveryPasses < 1) {
        setPlanRuntimePhase("needs_evidence", planLastQualityGateReason);
      } else if (
        latestQualityResult.planRecoveryAction === "auto_scaffold" ||
        planQualityRejectCount >= 2 ||
        (latestQualityResult.planRecoveryAction === "targeted_evidence" && planEvidenceRecoveryPasses >= 1)
      ) {
        if (!planAutoScaffoldPromptIssued) {
          planAutoScaffoldPromptIssued = true;
          setPlanRuntimePhase("needs_rewrite", "auto scaffold after quality gate");
          pendingPlanRuntimeRecoveryPrompt = buildPlanAutoScaffoldPrompt({
            language: callbacks.getPreferredLanguage(),
            latestUserPromptText,
            recentToolActivity: recentPlanToolActivity,
            qualityGateReason: planLastQualityGateReason,
            missingSections: planLastMissingSections,
          });
        } else {
          setPlanRuntimePhase("needs_rewrite", planLastQualityGateReason);
        }
      } else {
        setPlanRuntimePhase("needs_rewrite", planLastQualityGateReason);
      }

      const qualityClosureEvidence = collectPlanClosureMaterializationInput(
        callbacks,
        recentPlanToolActivity,
        attemptedPlanWriteTargets,
        latestUserPromptText,
      );
      const hasQualityClosureEvidence = hasGroundedPlanClosureEvidence(
        qualityClosureEvidence,
        recentPlanToolActivity,
      );
      const hasStructuredQualityClosureEvidence = qualityClosureEvidence.evidenceRecords.length > 0;
      const shouldDeterministicallyClosePlanAfterQualityGate =
        !usedPlanDeterministicQualityClosure &&
        planQualityRejectCount >= 1 &&
        hasQualityClosureEvidence &&
        (
          latestQualityResult.planRecoveryAction !== "targeted_evidence" ||
          hasStructuredQualityClosureEvidence
        );
      logAgentEvent("plan_quality_gate_recovery_decision", {
        iteration,
        qualityGateReason: planLastQualityGateReason,
        qualityRejectCount: planQualityRejectCount,
        recoveryAction: latestQualityResult.planRecoveryAction || "",
        hasGroundedEvidence: hasQualityClosureEvidence,
        hasStructuredEvidence: hasStructuredQualityClosureEvidence,
        deterministicClosure: shouldDeterministicallyClosePlanAfterQualityGate,
        sanitizedEvidenceCount: qualityClosureEvidence.evidence.length,
        structuredEvidenceCount: qualityClosureEvidence.evidenceRecords.length,
        sanitizedFileCount: qualityClosureEvidence.files.length,
        sanitizerDropped: qualityClosureEvidence.sanitizer.dropped,
        sanitizerDropReasons: qualityClosureEvidence.sanitizer.dropReasons,
      });
      if (shouldDeterministicallyClosePlanAfterQualityGate) {
        pendingPlanRuntimeRecoveryPrompt = null;
        pendingPlanDeterministicQualityClosure = {
          trigger: "plan_quality_gate_repeated_rewrite",
          qualityGateReason: planLastQualityGateReason,
          qualityRejectCount: planQualityRejectCount,
        };
      }
    }

    const evidenceRecoveryBatchResults = wasPlanEvidenceRecoveryPhase
      ? allResults.filter((result) =>
          !result.internalFeedback &&
          PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
        )
      : [];
    if (
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      evidenceRecoveryBatchResults.length > 0 &&
      pendingPlanRuntimeRecoveryPrompt == null
    ) {
      planEvidenceRecoveryPasses += 1;
      const hasSuccessfulEvidence = evidenceRecoveryBatchResults.some((result) => !result.isError);
      if (hasSuccessfulEvidence) {
        setPlanRuntimePhase("drafting", "evidence recovery complete");
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryClosurePrompt({
          language: callbacks.getPreferredLanguage(),
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
        });
      } else {
        setPlanRuntimePhase("blocked", "evidence recovery failed", "failed");
        pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryBlockedPrompt({
          language: callbacks.getPreferredLanguage(),
          recentToolActivity: recentPlanToolActivity,
          qualityGateReason: planLastQualityGateReason,
          missingSections: planLastMissingSections,
        });
      }
    }

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

    const executeReadOnlyRecovery =
      workflowMode === "edit" && runtimeIntent === "execute"
        ? resolveExecuteReadOnlyRecoveryTrigger({
            results: allResults,
            recentActivity: recentToolActivity,
            readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
            sawExecuteOperationEvidence,
            noProgressBatchRepeatCount,
            minReadOnlyActivities: 8,
            maxNoProgressReadOnlyRepeats: 2,
            maxReadOnlyToolChars: 30_000,
          })
        : { shouldRecover: false, reason: "", readOnlyActivityCount: 0, batchToolChars: 0 };
    if (executeReadOnlyRecovery.shouldRecover) {
      const language = callbacks.getPreferredLanguage();
      const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
      const allowFileRead = shouldAllowExecuteRecoveryFileRead(recentToolActivity);
      if (executeRecoveryAttempts < 2) {
        const nextMode: Exclude<ExecuteRecoveryMode, "normal"> = allowFileRead
          ? "patch_recovery_read"
          : "action_plus_targeting";
        activateExecuteRecovery(nextMode, executeReadOnlyRecovery.reason, {
          readOnlyActivityCount: executeReadOnlyRecovery.readOnlyActivityCount,
          batchToolChars: executeReadOnlyRecovery.batchToolChars,
          repeatedTargets,
        });
        pendingExecuteRecoveryPrompt = buildExecuteRecoveryPrompt({
          language,
          reason: executeReadOnlyRecovery.reason,
          mode: nextMode,
          repeatedTargets,
          recentActivity: recentToolActivity,
          allowFileRead,
        });
      } else {
        const remainingText = callbacks.getPreferredLanguage() === "zh"
          ? "执行恢复后仍只有只读探索，没有写入、命令或浏览器验证证据。"
          : "execute recovery still produced read-only exploration without write, command, or browser validation evidence";
        pendingExecuteNoProgressPause = {
          notice: buildExecuteNoProgressLoopPauseNotice({
            language,
            repeats: Math.max(1, noProgressBatchRepeatCount),
            remainingTask: remainingText,
            recentActivity: recentToolActivity,
            repeatedTargets,
          }),
          repeatedTargets,
          progressSignature: buildPlanProgressSignatureFromToolActivity(recentToolActivity) || noProgressBatchSignature,
          reason: executeReadOnlyRecovery.reason,
        };
      }
    }

    const chatReadOnlyNoProgress =
      workflowMode === "chat" && runtimeIntent === "respond"
        ? resolveReadOnlyNoProgressTrigger({
            results: allResults,
            recentActivity: recentToolActivity,
            readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
            sawExecuteOperationEvidence: false,
            noProgressBatchRepeatCount,
            minReadOnlyActivities: 16,
            minCachedReadOnlyActivities: 6,
            maxNoProgressReadOnlyRepeats: 3,
            maxReadOnlyToolChars: 48_000,
          })
        : { shouldRecover: false, reason: "", readOnlyActivityCount: 0, batchToolChars: 0 };
    if (chatReadOnlyNoProgress.shouldRecover) {
      const language = callbacks.getPreferredLanguage();
      const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
      const progressSignature = buildPlanProgressSignatureFromToolActivity(recentToolActivity) || noProgressBatchSignature;
      const nextStep = language === "zh"
        ? "复用已读上下文，直接回答、换目标或说明具体阻塞"
        : "reuse cached context to answer directly, switch targets, or state the concrete blocker";
      logAgentEvent("loop_stop", {
        reason: chatReadOnlyNoProgress.reason,
        iteration,
        repeats: noProgressBatchRepeatCount,
        readOnlyActivityCount: chatReadOnlyNoProgress.readOnlyActivityCount,
        batchToolChars: chatReadOnlyNoProgress.batchToolChars,
        repeatedTargets,
        progressSignature: truncateForLog(progressSignature, 220),
      });
      callbacks.onNonActionableStop(
        buildExecuteNoProgressLoopPauseNotice({
          language,
          scope: "chat",
          repeats: Math.max(1, noProgressBatchRepeatCount),
          remainingTask: language === "zh"
            ? "当前对话回合只有只读探索，没有产出最终回答或具体阻塞。"
            : "the chat turn produced only read-only exploration, not a final answer or concrete blocker",
          recentActivity: recentToolActivity,
          repeatedTargets,
        }),
        "no_action",
        {
          progressSignature,
          repeatedTargets,
          recoveryReason: chatReadOnlyNoProgress.reason,
          nextStep,
        },
      );
      callbacks.onStatusChange("idle");
      return;
    }

    const approvedPlanCachedReadOnlyBatch =
      workflowMode === "plan" &&
      callbacks.getIsPlanApproved() &&
      isApprovedPlanCachedReadOnlyNoProgressBatch({
        results: allResults,
        readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
        sawExecutionEvidence: sawExecuteOperationEvidence,
      });
    let approvedPlanNoProgressDecision: {
      action: "recover" | "pause";
      reason: string;
      remainingText: string;
      repeats: number;
      logContext: Record<string, unknown>;
    } | null = null;

    if (approvedPlanCachedReadOnlyBatch) {
      const remainingText = remainingTaskForDigest?.text || (
        callbacks.getPreferredLanguage() === "zh"
          ? "当前已批准计划仍有任务缺少写入、命令或浏览器验证证据。"
          : "the approved plan still has tasks missing write, command, or browser validation evidence"
      );
      const recoveryInput = {
        reason: "no_progress_cached_read_only_batch",
        remainingText,
        logContext: {
          currentBatchTools: allResults.map((result) => result.name).slice(0, 8),
          currentBatchTargets: allResults.map((result) => result.target).filter(Boolean).slice(0, 8),
        },
      };
      approvedPlanNoProgressDecision = {
        ...recoveryInput,
        action: approvedPlanNoProgressRecoveryAttempts < MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS
          ? "recover"
          : "pause",
        repeats: Math.max(1, noProgressBatchRepeatCount),
      };
    }

    if (noProgressBatchRepeatCount >= MAX_NO_PROGRESS_LOOP_REPEATS) {
      if (isUnapprovedPlanReadOnlyBatch) {
        logAgentEvent("no_progress_deferred_to_plan_readonly_convergence", {
          iteration,
          repeats: noProgressBatchRepeatCount,
          batches: planReadOnlyConvergenceBatches,
          tools: planReadOnlyConvergenceTools,
        });
      } else if (workflowMode === "edit" && runtimeIntent === "execute" && pendingExecuteRecoveryPrompt) {
        logAgentEvent("execute_no_progress_deferred_to_recovery", {
          iteration,
          repeats: noProgressBatchRepeatCount,
          executeRecoveryMode,
          executeRecoveryReason,
        });
      } else if (workflowMode === "edit" && runtimeIntent === "execute") {
        const language = callbacks.getPreferredLanguage();
        const repeatedTargets = pendingExecuteNoProgressPause?.repeatedTargets.length
          ? pendingExecuteNoProgressPause.repeatedTargets
          : summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
        const progressSignature =
          pendingExecuteNoProgressPause?.progressSignature ||
          buildPlanProgressSignatureFromToolActivity(recentToolActivity) ||
          noProgressBatchSignature;
        const pauseNotice = pendingExecuteNoProgressPause?.notice || buildExecuteNoProgressLoopPauseNotice({
          language,
          repeats: noProgressBatchRepeatCount,
          remainingTask: language === "zh"
            ? "先停止重复读取，改为写入、命令验证、浏览器验证，或说明真实阻塞。"
            : "stop repeated reads and pivot to patch/write, command validation, browser validation, or the real blocker",
          recentActivity: recentToolActivity,
          repeatedTargets,
        });
        logAgentEvent("loop_stop", {
          reason: "execute_no_progress_batch_loop",
          iteration,
          repeats: noProgressBatchRepeatCount,
          repeatedTargets,
          progressSignature: truncateForLog(progressSignature, 220),
          recoveryReason: pendingExecuteNoProgressPause?.reason || "",
        });
        emitTaskOrchestratorPhase("PAUSED", {
          reason: "execute_no_progress_batch_loop",
          iteration,
          repeats: noProgressBatchRepeatCount,
          remainingTask: language === "zh"
            ? "复用已读上下文，改为执行动作或说明真实阻塞。"
            : "reuse read context, take action, or state the real blocker",
          repeatedTargets,
        });
        callbacks.onNonActionableStop(
          pauseNotice,
          "no_action",
          {
            progressSignature,
            repeatedTargets,
            recoveryReason: "execute_no_progress_batch_loop",
            nextStep: language === "zh"
              ? "复用已读上下文，转向写入/命令/浏览器验证，或说明真实阻塞"
              : "reuse cached context and pivot to patch/run/browser validation, or state the real blocker",
          },
        );
        callbacks.onStatusChange("idle");
        return;
      } else {
        const remainingText = remainingTaskForDigest?.text || (
          callbacks.getPreferredLanguage() === "zh"
            ? "先重新核对当前目标与参数，再选择不同策略继续。"
            : "Recheck current targets and parameters, then continue with a different strategy."
        );
        const language = callbacks.getPreferredLanguage();
        const repeatedTargets = (() => {
          const counts = new Map<string, number>();
          for (const activity of recentPlanToolActivity.slice(-8)) {
            const target = String(activity.target || "").trim();
            if (!target) continue;
            const cachedWeight = /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped/i.test(activity.detail || "") ? 2 : 1;
            counts.set(target, (counts.get(target) || 0) + cachedWeight);
          }
          return [...counts.entries()]
            .filter(([, count]) => count >= 2)
            .sort((a, b) => b[1] - a[1])
            .map(([target]) => target)
            .slice(0, 4);
        })();
        const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity) || noProgressBatchSignature;
        const pauseNotice = buildPlanNoProgressLoopPauseNotice({
          language,
          repeats: noProgressBatchRepeatCount,
          remainingTask: remainingText,
          evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
          recentToolActivity: recentPlanToolActivity,
          repeatedTargets,
        });
        logAgentEvent("loop_stop", {
          reason: "no_progress_batch_loop",
          iteration,
          repeats: noProgressBatchRepeatCount,
          repeatedTargets,
          progressSignature: truncateForLog(progressSignature, 220),
        });
        emitTaskOrchestratorPhase("PAUSED", {
          reason: "no_progress_batch_loop",
          iteration,
          repeats: noProgressBatchRepeatCount,
          remainingTask: remainingText,
          repeatedTargets,
        });
        callbacks.onNonActionableStop(
          pauseNotice,
          "no_action",
          {
            progressSignature,
            repeatedTargets,
            recoveryReason: "no_progress_batch_loop",
            nextStep: language === "zh"
              ? "换目标、改为写入/命令/浏览器验证，或说明真实阻塞"
              : "switch target, patch/run/browser-verify, or state the real blocker",
          },
        );
        callbacks.onStatusChange("idle");
        return;
      }
    }

    for (const result of allResults) {
      const signature = toolFailureSignatures.get(result.toolCallId);
      if (!signature) continue;
      if (result.internalFeedback) continue;
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
      if (result.internalFeedback) continue;
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
    if (allResults.some(isVerificationEvidenceResult)) {
      successfulEditTargetsSinceVerification.clear();
    }
    for (const result of allResults) {
      if (result.isError || result.internalFeedback || !isEditProgressResult(result)) continue;
      const targetKey = normalizeLoopGuardTarget(result.target);
      if (!targetKey) continue;
      const count = (successfulEditTargetsSinceVerification.get(targetKey) || 0) + 1;
      successfulEditTargetsSinceVerification.set(targetKey, count);
      if (count < 3) continue;

      const displayTarget = String(result.target || targetKey).replace(/^shell-write:/, "");
      const language = callbacks.getPreferredLanguage();
      logAgentEvent("loop_stop", {
        reason: "repeat_edit_target_without_validation",
        iteration,
        target: displayTarget,
        editCount: count,
      });
      callbacks.onNonActionableStop(
        language === "zh"
          ? [
              "执行已暂停：同一回合连续修改同一目标，但期间没有新的验证证据。",
              `重复目标：${displayTarget}`,
              "继续前请先运行测试、命令或浏览器验证；如果无法验证，请说明真实阻塞并给出当前状态。",
            ].join("\n")
          : [
              "Execution paused: this turn kept editing the same target without fresh validation evidence.",
              `Repeated target: ${displayTarget}`,
              "Before continuing, run a test, command, or browser validation; if validation is blocked, state the blocker and current status.",
            ].join("\n"),
        "no_action",
        {
          repeatedTargets: [displayTarget],
          recoveryReason: "repeat_edit_target_without_validation",
          nextStep: language === "zh"
            ? "先验证当前目标，再决定继续修改、换目标或总结"
            : "validate this target before editing it again, switching targets, or summarizing",
        },
      );
      callbacks.onStatusChange("idle");
      return;
    }
    if (pendingExecuteRecoveryPrompt) {
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: pendingExecuteRecoveryPrompt,
      });
      continue;
    }
    if (pendingExecuteNoProgressPause) {
      callbacks.onNonActionableStop(
        pendingExecuteNoProgressPause.notice,
        "no_action",
        {
          progressSignature: pendingExecuteNoProgressPause.progressSignature,
          repeatedTargets: pendingExecuteNoProgressPause.repeatedTargets,
          recoveryReason: pendingExecuteNoProgressPause.reason,
          nextStep: callbacks.getPreferredLanguage() === "zh"
            ? "复用已读上下文，转向写入/命令/浏览器验证，或说明真实阻塞"
            : "reuse cached context and pivot to patch/run/browser validation, or state the real blocker",
        },
      );
      callbacks.onStatusChange("idle");
      return;
    }
    if (pendingPlanRuntimeRecoveryPrompt) {
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: pendingPlanRuntimeRecoveryPrompt,
      });
      continue;
    }

    if (pendingPlanDeterministicQualityClosure) {
      usedPlanDeterministicQualityClosure = true;
      const closureResult = await materializePlanFromEvidenceForReview(
        pendingPlanDeterministicQualityClosure.trigger,
        {
          qualityGateReason: pendingPlanDeterministicQualityClosure.qualityGateReason,
          qualityRejectCount: pendingPlanDeterministicQualityClosure.qualityRejectCount,
        },
      );
      if (closureResult === "approved_continue") continue;
      if (closureResult === "stopped") return;
      if (closureResult === "failed") {
        logAgentEvent("plan_quality_deterministic_closure_failed", {
          iteration,
          qualityGateReason: pendingPlanDeterministicQualityClosure.qualityGateReason,
          qualityRejectCount: pendingPlanDeterministicQualityClosure.qualityRejectCount,
        });
        if (!planDeterministicClosureEvidenceRecoveryIssued && planEvidenceRecoveryPasses < 1) {
          planDeterministicClosureEvidenceRecoveryIssued = true;
          setPlanRuntimePhase("needs_evidence", "quality deterministic closure failed");
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildDeterministicClosureEvidenceRecoveryPrompt(
              pendingPlanDeterministicQualityClosure.qualityGateReason || "quality deterministic closure failed",
            ),
          });
          continue;
        }
        callbacks.onNonActionableStop(
          buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
          "incomplete_plan",
          {
            recoveryReason: "plan_quality_deterministic_closure_failed",
            nextStep: callbacks.getPreferredLanguage() === "zh"
              ? "检查计划证据账本和质量门禁，避免继续重复写同一个 plan.md"
              : "inspect the plan evidence ledger and quality gate instead of repeatedly writing the same plan.md",
          },
        );
        callbacks.onStatusChange("idle");
        return;
      }
    }

    if (approvedPlanNoProgressDecision) {
      if (approvedPlanNoProgressDecision.action === "recover") {
        continueApprovedPlanWithStrategySwitch(approvedPlanNoProgressDecision);
        continue;
      } else {
        pauseApprovedPlanNoProgressLoop(approvedPlanNoProgressDecision);
        return;
      }
    }

    if (isUnapprovedPlanReadOnlyBatch && !hasPlanDecisionOutput) {
      planReadOnlyConvergenceBatches += 1;
      planReadOnlyConvergenceTools += successfulReadOnlyExplorationResults.length;
    } else if (!isUnapprovedPlanReadOnlyBatch || hasPlanDecisionOutput) {
      planReadOnlyConvergenceBatches = 0;
      planReadOnlyConvergenceTools = 0;
    }

    const planEvidenceReadinessForConvergence = assessPlanEvidenceReadiness({
      userContext: turnInputContextSignals,
      recentToolActivity: recentPlanToolActivity,
      hasObservedUserContext: hasPlanUserContextObservation(
        callbacks.getMessages() as AgentMessage[],
        lastAssistantTextForCheckpoint,
      ),
    });
    const shouldConvergeUnapprovedPlanReadOnly = shouldTriggerPlanReadOnlyConvergence({
      isUnapprovedPlanReadOnlyBatch,
      hasPlanDecisionOutput,
      batchCount: planReadOnlyConvergenceBatches,
      toolCount: planReadOnlyConvergenceTools,
      userContext: turnInputContextSignals,
      recentToolActivity: recentPlanToolActivity,
      hasObservedUserContext: planEvidenceReadinessForConvergence.status !== "needs_observation",
      convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
    });

    if (shouldConvergeUnapprovedPlanReadOnly) {
      const language = callbacks.getPreferredLanguage();
      const convergencePhase = planEvidenceReadinessForConvergence.status === "needs_targeted_read"
        ? "needs_evidence"
        : "synthesis";
      const convergenceReason = planEvidenceReadinessForConvergence.status === "needs_targeted_read"
        ? planEvidenceReadinessForConvergence.reason
        : "targeted evidence ready";
      setPlanRuntimePhase(convergencePhase, convergenceReason);
      logAgentEvent("plan_readonly_convergence_threshold", {
        iteration,
        batches: planReadOnlyConvergenceBatches,
        tools: planReadOnlyConvergenceTools,
        imageParts: turnInputContextSignals.imageParts,
        mentionedFilePaths: turnInputContextSignals.mentionedFilePaths.length,
        attachedFilePaths: turnInputContextSignals.attachedFilePaths.length,
        promptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
        evidenceReadiness: planEvidenceReadinessForConvergence.status,
        evidenceReadinessReason: planEvidenceReadinessForConvergence.reason,
        successfulTargetedReads: planEvidenceReadinessForConvergence.successfulTargetedReads,
        successfulSearches: planEvidenceReadinessForConvergence.successfulSearches,
      });
      if (!usedPlanReadOnlyConvergencePrompt) {
        usedPlanReadOnlyConvergencePrompt = true;
        setPlanRuntimePhase(
          planEvidenceReadinessForConvergence.status === "needs_targeted_read" ? "needs_evidence" : "drafting",
          convergenceReason,
        );
        callbacks.appendMessage({
          role: "user",
          content: buildPlanReadOnlyConvergencePrompt(
            language,
            planReadOnlyConvergenceBatches,
            planReadOnlyConvergenceTools,
            turnInputContextSignals,
          ),
        });
        continue;
      }

      const pause = buildPlanReadOnlyConvergencePause(
        language,
        planReadOnlyConvergenceBatches,
        planReadOnlyConvergenceTools,
        turnInputContextSignals,
      );
      const historyText = serializeAssistantReplyForHistory(pause.text, pause.options);
      callbacks.onAssistantFinalText(pause.text, pause.options, { hasToolCalls: false });
      callbacks.appendMessage({ role: "assistant", content: historyText });
      callbacks.onStatusChange("idle");
      return;
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

      if (workflowMode === "plan" && callbacks.getIsPlanApproved() && tc.name === "browser_evaluate") {
        const recoveryMessage = formatRepeatLoopRecoveryMessage(tc.name, target, repeatCheck.threshold);
        if (!repeatGuardRecoveredSignatures.has(repeatCheck.signature)) {
          repeatGuardRecoveredSignatures.add(repeatCheck.signature);
          recentToolCalls.length = 0;
          callbacks.onToolError(tc.name, target, recoveryMessage, { toolCallId: tc.id });
          callbacks.appendMessage({
            role: "system",
            content: `[System: ${recoveryMessage}]`,
          });
          recoveredReadOnlyRepeat = true;
          break;
        }

        const language = callbacks.getPreferredLanguage();
        const repeatedTargets = target ? [target] : summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
        const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
        const notice = language === "zh"
          ? [
              "执行已暂停：浏览器验证重复调用同一目标，没有产生新的执行证据。",
              `重复目标：${repeatedTargets.join("、") || "未定位到单一目标"}`,
              "MAIN 已保留最近一次 Browser/Playwright 结果；继续时请复用已有验证，改为下一个任务、命令验证、源码修正或最终总结。",
            ].join("\n")
          : [
              "Execution paused: browser validation repeated the same target without new evidence.",
              `Repeated target: ${repeatedTargets.join(", ") || "no single target identified"}`,
              "MAIN kept the latest Browser/Playwright result; on resume, reuse it and move to the next task, command validation, source edit, or final summary.",
            ].join("\n");
        logAgentEvent("loop_stop", {
          reason: "approved_plan_repeated_browser_validation",
          iteration,
          target,
          progressSignature: truncateForLog(progressSignature, 220),
        });
        callbacks.onNonActionableStop(
          notice,
          "no_action",
          {
            progressSignature,
            repeatedTargets,
            recoveryReason: "approved_plan_repeated_browser_validation",
            nextStep: language === "zh"
              ? "复用已有浏览器结果，转向下一个任务、命令验证、源码修正或最终总结"
              : "reuse the browser result and move to the next task, command validation, source edit, or final summary",
          },
        );
        callbacks.onStatusChange("idle");
        return;
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
          : `\nRecovery: start a fresh recovery context and continue with an evidence-unsatisfied task such as: ${remainingTask.text}`
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
      const resultByToolCallId = new Map(allResults.map((result) => [result.toolCallId, result]));
      for (const tc of effectiveToolCalls) {
        const toolArgs = parseToolCallArguments(tc, workspace);
        const target = getShellMutationTargetForLoopGuard(tc.name, toolArgs) || getToolTarget(tc.name, toolArgs);
        const toolResult = resultByToolCallId.get(tc.id);
        const outcome = targetProgressOutcomeForToolResult(toolResult);
        const reason = targetProgressReasonForToolResult(toolResult);
        const progressCheck = registerTargetProgressEventForLoopGuard(recentTargetToolCalls, {
          name: tc.name,
          target,
          outcome,
          reason,
        });
        if (!progressCheck.repeated) continue;

        const recoveryMessage = formatTargetProgressLoopRecoveryMessage(
          progressCheck.family,
          target || progressCheck.targetKey,
          progressCheck.threshold,
        );
        const isExecuteTargetRecoveryEligible =
          runtimeIntent === "execute" &&
          progressCheck.family === "edit" &&
          (workflowMode === "edit" || (workflowMode === "plan" && callbacks.getIsPlanApproved())) &&
          (outcome === "blocked" || outcome === "failed" || outcome === "no_change");
        const displayTarget = String(target || progressCheck.targetKey || "").replace(/^shell-write:/, "");
        const appendExecuteTargetRecoveryPrompt = (mode: Exclude<ExecuteRecoveryMode, "normal">, recoveryReason: string) => {
          activateExecuteRecovery(mode, recoveryReason, {
            target: displayTarget,
            outcome,
            reason,
          });
          callbacks.appendMessage({
            role: "user",
            content: buildExecuteRecoveryPrompt({
              language: callbacks.getPreferredLanguage(),
              reason: recoveryReason,
              mode,
              repeatedTargets: displayTarget ? [displayTarget] : summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
              recentActivity: recentToolActivity,
              allowFileRead: mode === "patch_recovery_read",
            }),
          });
        };
        if (!targetProgressGuardRecoveredSignatures.has(progressCheck.signature)) {
          targetProgressGuardRecoveredSignatures.add(progressCheck.signature);
          recentTargetToolCalls.length = 0;
          callbacks.onToolError(tc.name, target, recoveryMessage, { toolCallId: tc.id });
          callbacks.appendMessage({
            role: "system",
            content: `[System: ${recoveryMessage}]`,
          });
          if (isExecuteTargetRecoveryEligible && executeRecoveryAttempts < 2) {
            appendExecuteTargetRecoveryPrompt("patch_recovery_read", "target_progress_patch_mismatch");
          }
          recoveredTargetProgressLoop = true;
          break;
        }

        if (isExecuteTargetRecoveryEligible && executeRecoveryAttempts < 3) {
          recentTargetToolCalls.length = 0;
          callbacks.onToolError(tc.name, target, recoveryMessage, { toolCallId: tc.id });
          callbacks.appendMessage({
            role: "system",
            content: `[System: ${recoveryMessage}]`,
          });
          appendExecuteTargetRecoveryPrompt("action_plus_targeting", "target_progress_no_diff_chain");
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
        executeRecoveryMode,
      });
      if (workflowMode === "edit" && runtimeIntent === "execute") {
        activateExecuteRecovery("action_plus_targeting", "execute_convergence_prompt", {
          maxIterations: effectiveMaxIterations,
          recentToolActivity: recentToolActivity.length,
        });
      }
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
      sawExecuteOperationEvidence,
      executeRecoveryMode,
    });
    const handled = await callbacks.onExecuteMaxIterationsCheckpoint?.(checkpoint);
    if (handled) {
      callbacks.onStatusChange("idle");
      return;
    }
    callbacks.onNonActionableStop(
      buildExecuteMaxIterationsPauseNotice(checkpoint, callbacks.getPreferredLanguage()),
      "no_action",
    );
    callbacks.onStatusChange("idle");
    return;
  }

  const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
  const progressSignature = buildPlanProgressSignatureFromToolActivity(recentToolActivity);
  logAgentEvent("loop_stop", {
    reason: "max_iterations_boundary",
    iteration: effectiveMaxIterations,
    workflowMode,
    runtimeIntent: resolveRuntimeIntent(),
    repeatedTargets,
    progressSignature: truncateForLog(progressSignature, 220),
  });
  callbacks.onNonActionableStop(
    callbacks.getPreferredLanguage() === "zh"
      ? `本轮达到 ${effectiveMaxIterations} 轮安全边界，已停止在可恢复状态。`
      : `This turn reached the ${effectiveMaxIterations}-iteration safety boundary and stopped in a recoverable state.`,
    "no_action",
    {
      progressSignature,
      repeatedTargets,
      recoveryReason: "max_iterations_boundary",
      nextStep: callbacks.getPreferredLanguage() === "zh"
        ? "复用已读上下文，直接总结、换目标或说明具体阻塞"
        : "reuse cached context, summarize directly, switch targets, or state the concrete blocker",
    },
  );
  callbacks.onStatusChange("idle");
  emitTurnCompletedEvent();
}
