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
  isLocalProfile,
  type OpenAiToolChoice,
  type StreamSettings,
  type StreamResult,
} from "./streaming";
import {
  SUBMIT_PLAN_CANDIDATE_TOOL_NAME,
  type ToolDefinition,
} from "./toolSchemas";
import { isBuiltInToolName, type ToolCatalog } from "./toolCatalog";
import { executeTool } from "./toolExecutor";
import { computeContextTokenBreakdown, estimateMessagesTokens, estimateTokens, manageContext, type TrimMessage } from "./contextTrim";
import type { ContextMemoryState } from "./contextMemory";
import { generateId } from "./utils";
import { readHarnessRunMarker } from "./harnessCrashTelemetry";
import {
  type MCPServer,
  type MCPTool,
} from "./mcpClient";
import { getFileMetadata, shellPermissionPreflight, writeFileAtomic } from "./ipc";
import { acquireModelLane } from "./modelLaneCoordinator";
import { MODEL_CONTROL_LANGUAGE } from "./modelControlLanguage";
import { buildToolDiffPreview, supportsToolDiffPreview, type ToolDiffPreview } from "./toolDiff";
import { preflightWorkspaceMutation } from "./workspaceMutationPreflight";
import {
  isReadOnlyNoProgressDetail,
} from "./executeRecoveryTools";
import {
  normalizeWorkspacePathIdentity,
  workspacePathsReferToSameFile,
} from "./workspacePaths";
import {
  recordSubagentScopeBlockedTool,
  type SpawnSubagentResult,
} from "./subagents";
import { resolveToolArgumentAuthorization } from "./toolArgumentAuthorization";
import {
  BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES,
  isWorkspaceMutationToolCall,
  WORKSPACE_MUTATION_TOOL_NAMES,
  resolveWorkspaceMutationTargets,
} from "./workspaceMutationTools";
import { formatPtyInputTarget } from "./ptyCommandRuntime";
import { parseApplyPatch, summarizeApplyPatchTarget } from "./applyPatchTool";
import {
  commitResolvedPlanArtifactUpdate,
  resolvePlanArtifactAfterToolSuccess,
  syncPlanArtifactAfterToolSuccess,
} from "./planArtifactSync";
import {
  buildReadFileWindowContinuationGuidance,
  resolveReadFileResultAfterLargeFileSummary,
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
import type {
  MaxIterationsCheckpointHandling,
  ToolCatalogIdentity,
  ToolCallToExecute,
  ToolErrorLifecycleMeta,
  ToolExecutionResult,
} from "./orchestrator/types";
import {
  buildUnityApplyTextPolicyBlockedMessage,
  isUnityExecutionContext,
} from "./orchestrator/unityDiagnostics";
import {
  buildPlanRecoveryPromptFromContext,
} from "./orchestrator/planOrchestration";
import {
  detectRequestedRootMarkdownDeliverables,
  isPlanControlUserPrompt,
  isPlanRuntimeInstructionMemory,
  stripControlPromptForPlanFallback,
} from "./orchestrator/prompts/planPrompts";

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
export {
  buildExecuteConvergencePrompt,
  buildHiddenThoughtOnlyContinuationPrompt,
  buildReadOnlyPermissionHardRecoveryPrompt,
  looksLikeOperationCompletionClaim,
  looksLikePlanCompletionClaim,
} from "./orchestrator/prompts/executePrompts";
export {
  buildApprovedPlanNoToolPauseMessage,
  buildApprovedPlanValidationPendingMessage,
  buildBrowserValidationContinuationPrompt,
  formatPlanAuditRemainingTasks,
  resolveApprovedPlanValidationBoundary,
} from "./orchestrator/prompts/planPrompts";
import {
  isAllowedBySessionAutoApprove,
  type SessionAutoApproveScope,
  type ToolLifecycleState,
} from "./runtimeTools";
import type { AppConfig, Skill } from "./appTypes";
import {
  canonicalizePlanArtifactPath,
  classifyPlanArtifactQualityResult,
  deriveRuntimePlanTasksFromArtifacts,
  detectPlanArtifactKind,
  extractPlanTasks,
  findDroppedPlanTasks,
  getPendingPlanTaskCommandFocus,
  isEphemeralPlanArtifactPath,
  isPlanTaskTrustedComplete,
  analyzePlanDecisionFork,
  repairActionablePlanArtifactContent,
  validateActionablePlanArtifact,
  validateDerivedPlanTasksForApproval,
  validatePlanArtifactContent,
  type PlanArtifact,
  type PlanArtifactQualityResult,
  type PlanArtifactRecoveryAction,
  type PlanExecutionEvidenceEntry,
  type PlanExecutionProgressUpdate,
  type PlanRuntimePhase,
  type PlanTask,
  type ReplyOption,
} from "./workflowModels";
import type { MainModeKey } from "./mainModes";
import { isMutationRuntimeIntent, type CommandDirective, type ResolvedUserIntent } from "./runIntent";
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
import type { PendingSlashCommand, StudioAgentKey, StudioConfig } from "./gameStudio/catalog";
import {
  buildRepeatLoopArgsKey,
  buildRepeatLoopSignature,
  getShellMutationTargetForLoopGuard,
  isReadOnlyShellInspectionToolCall,
  type TargetProgressOutcome,
} from "./repetitionGuard";
import {
  getLocalFileReadPathForToolCall,
  getToolRiskLevelForCall,
  isUnityApplyTextPrecisePatchArgs,
  isLocalFileReadApproved,
  isToolAutoExecutableForCall,
  type ToolCapabilityRegistry,
  type ToolRiskLevel,
} from "./toolCapabilities";
import {
  buildCompatibilityRetryMessages,
  extractCompatibilityTextContent,
  hasProviderNativeToolsDisabled,
} from "./providerCompatibility";
import {
  latestVisualContextIsModelVisible,
  resolveTurnVisualPayloadBinding,
} from "./visualContext";
import {
  getProtocolInstructionProfile,
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
  type ExecuteRecoveryContractPhase,
  type ExecuteRecoveryMode,
  type ExecutionDecisionCheckpoint,
  type RecoveryReadLease,
} from "./executeRecoveryTools";
import { validateShellToolContract } from "./toolExecutionContract";
import {
  formatToolFeedbackEnvelope,
  type ToolFeedbackStatus,
} from "./toolFeedbackEnvelope";
import {
  getObservedWorkspaceMutationPaths,
  getToolExecutionName,
  hasCompletedToolExecution,
  hasVerifiedWorkspaceMutationEffect,
} from "./toolResultEffect";
import {
  withEventSchema,
  type MainThreadEvent,
} from "./turnEvents";
import { normalizeToolCallForExecution } from "./toolCallNormalization";
import {
  appendTrustedValidationCommandsToPlan,
  composeReviewablePlanFromEvidence,
  materializePlanArtifactFromVisibleText,
  sanitizePlanEvidenceInput,
  validateGroundedActionablePlanArtifact,
  type PlanEvidenceRecord,
  type PlanMaterializationResult,
  type PlanMaterializationSource,
} from "./planMaterialization";
import {
  assessPlanExecutableValidation,
  planArtifactRequiresExecutableValidation,
} from "./planExecutableValidation";
import { resolveTrustedProjectValidationCommands } from "./projectValidationCommands";
import {
  assessPlanClosureEvidence,
  browserResultLooksSuccessful,
  buildPlanEvidenceBundle,
  commandResultLooksSuccessful,
  hasDeterministicPlanMaterializationEvidence,
  isPlanEvidenceBundleReady,
  resolveStructuredDesktopAutomationOutcome,
  type PlanEvidenceBundle,
} from "./planEvidence";
import { createPlanAuthoringContract } from "./planAuthoringContract";
import { buildPlanSubmissionGuidance } from "./planSubmissionGuidance";
import {
  createRuntimeSynthesizedPlanCandidate,
  hasTypedPlanDraftEnvelope,
} from "./planDraftIngress";
import type { PlanCandidateRepairCheckpoint } from "./planCandidateRepair";
import {
  derivePlanTasksFromCandidate,
  sealPlanCandidate,
  validateSealedPlanCandidate,
  type PlanCandidateV2,
} from "./planContract";
import { compactStructuredCommandResult } from "./commandValidationOutcome";
import { VERIFICATION_TOOL_NAMES } from "./verificationEvidence";
import {
  buildBrowserValidationFailureContent,
  parseBrowserValidationOutcome,
} from "./browserValidation";
import { formatToolPresentation } from "./toolPresentation";
import {
  buildPlanReadOnlyProgressNarration,
  buildToolCallsProgressNarration,
  type ProgressNarration,
} from "./progressNarration";
import { shouldUseRustProxyForLocalProvider } from "./localProviderRouting";
import type { ShellPermissionApproval, ShellPermissionDecision } from "./ipc";
import { canApplyShellAutoReview, resolveShellAutoApproval } from "./shellAutoApproval";
import {
  assessPlanEvidenceReadiness,
  isPlanReadOnlyToolName,
} from "./planReadOnlyConvergence";
import {
  derivePlanEvidenceObligations,
  formatPlanEvidenceObligation,
} from "./planEvidenceObligations";
import {
  filterPlanToolNamesForRuntimePhase,
} from "./planRuntime";
import {
  extractPrimaryUserRequestText,
  normalizeTurnInputContextSignals,
  type TurnInputContextSignals,
} from "./turnIntake";
import { canonicalizeVisibleUserText } from "./turnContext";

// ── Spec file auto-approval helpers ────────────────────────────────

const PRE_APPROVAL_PLAN_FILE_NAMES = new Set(["plan.md", "design.md"]);
const EXECUTION_PLAN_FILE_NAMES = new Set(["requirements.md", "plan.md", "tasks.md"]);
const PLAN_ARTIFACT_MUTATION_TOOLS = new Set(["write_file", "replace_in_file", "apply_patch"]);
export const PLAN_REPEAT_READ_LIMIT = 3;
export const EXECUTION_REPEAT_READ_LIMIT = 8;
export const PLAN_EXPLORATION_READ_ONLY_TOOLS = new Set([
  "spawn_subagent",
  "wait_subagents",
  "cancel_subagent",
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
  "code_ast_query",
  "find_symbol_references",
  "git_status",
  "git_diff",
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
export const EXECUTION_VERIFICATION_TOOL_NAMES = VERIFICATION_TOOL_NAMES;

export const EDIT_PROGRESS_TOOL_NAMES = WORKSPACE_MUTATION_TOOL_NAMES;
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

export function hasPlanVisualContextGrounding(
  messages: AgentMessage[],
  turnId?: string | null,
): boolean {
  // This is transport grounding, not proof that the model interpreted the
  // screenshot correctly. Never promote free-form assistant prose to visual
  // evidence.
  return latestVisualContextIsModelVisible(messages, turnId);
}

export function filterPlanRuntimeToolDefinitionsForPhase(input: {
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
        ? `PLAN_DRAFTING_TOOL_BLOCKED: 当前处于 ${phase} 阶段，不能调用 ${input.toolName}。请严格遵循最新的 [PLAN AUTHORING CONTRACT] 与当前 ${SUBMIT_PLAN_CANDIDATE_TOOL_NAME} schema；当前 schema 决定本轮接收完整 typed graph 还是有界局部 repair patch。MAIN runtime 负责校验与原子渲染 .MAIN/plans/plan.md。真正阻塞的用户选择仍用 <user_options>。`
        : `PLAN_DRAFTING_TOOL_BLOCKED: The ${phase} phase cannot call ${input.toolName}. Follow the latest [PLAN AUTHORING CONTRACT] and the active ${SUBMIT_PLAN_CANDIDATE_TOOL_NAME} schema exactly; that active schema determines whether this turn accepts a complete typed graph or a bounded local repair patch. MAIN runtime owns validation and atomic rendering of .MAIN/plans/plan.md. A genuinely blocking user choice still uses <user_options>.`;
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
      ? `READ_SCOPE_DEFERRED: 当前事务的下一能力不是这个 read_file 调用。若目标文件版本已变化、所需范围尚未观察或上下文窗口已淘汰，请在对应读取阶段重新发起定向读取；否则使用 ${alternativesText} 继续当前阶段。不要用 shell/cat/sed/head/tail 绕过文件读取契约。`
      : `READ_SCOPE_DEFERRED: This read_file call is not the current transaction's next capability. Request a targeted read in the matching read phase when the file version changed, a required range is missing, or the context window was evicted; otherwise continue the current phase with ${alternativesText}. Do not bypass the file-read contract through shell/cat/sed/head/tail.`;
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
 * Legacy artifact classifier retained for import/restore and for identifying
 * model attempts to mutate runtime-owned Plan files. A true result is not an
 * authorization: typed Plan authoring must use the active submission transport
 * declared by the latest Plan authoring contract.
 */
function getPlanArtifactMutationTargets(name: string, args: Record<string, unknown>): Array<{ path: string; fileName: string }> {
  if (!PLAN_ARTIFACT_MUTATION_TOOLS.has(name)) return [];
  const rawPaths = name === "apply_patch"
    ? (() => {
        const parsed = parseApplyPatch(typeof args.patch === "string" ? args.patch : "");
        if (!parsed.ok) return [];
        return parsed.operations.flatMap((operation) =>
          operation.newPath ? [operation.path, operation.newPath] : [operation.path]
        );
      })()
    : [typeof args.path === "string" ? args.path : ""];
  const targets: Array<{ path: string; fileName: string }> = [];
  for (const path of rawPaths) {
    const kind = detectPlanArtifactKind(path);
    if (!kind || kind === "summary") continue;
    const canonicalPath = canonicalizePlanArtifactPath(path);
    const fileName = canonicalPath.split("/").pop() || "";
    if (fileName && !targets.some((target) => target.path === canonicalPath)) {
      targets.push({ path: canonicalPath, fileName: fileName.toLowerCase() });
    }
  }
  return targets;
}

function mutationTargetsOnlyPlanArtifacts(
  name: string,
  args: Record<string, unknown>,
  targets: Array<{ path: string; fileName: string }>,
): boolean {
  if (targets.length === 0) return false;
  if (name !== "apply_patch") return true;
  const parsed = parseApplyPatch(typeof args.patch === "string" ? args.patch : "");
  if (!parsed.ok) return false;
  const changedPathCount = parsed.operations.reduce(
    (count, operation) => count + (operation.newPath ? 2 : 1),
    0,
  );
  return changedPathCount === targets.length;
}

export function isPreApprovalPlanDraftWrite(name: string, args: Record<string, unknown>): boolean {
  const targets = getPlanArtifactMutationTargets(name, args);
  return mutationTargetsOnlyPlanArtifacts(name, args, targets) &&
    targets.every((target) => PRE_APPROVAL_PLAN_FILE_NAMES.has(target.fileName));
}

export function isExecutionPlanArtifactWrite(name: string, args: Record<string, unknown>): boolean {
  const targets = getPlanArtifactMutationTargets(name, args);
  return mutationTargetsOnlyPlanArtifacts(name, args, targets) &&
    targets.every((target) => EXECUTION_PLAN_FILE_NAMES.has(target.fileName));
}

export function isTasksPlanWrite(name: string, args: Record<string, unknown>): boolean {
  const targets = getPlanArtifactMutationTargets(name, args);
  return mutationTargetsOnlyPlanArtifacts(name, args, targets) &&
    targets.every((target) => target.fileName === "tasks.md");
}

function isEphemeralPlanArtifactMutation(name: string, args: Record<string, unknown>): boolean {
  if (!PLAN_ARTIFACT_MUTATION_TOOLS.has(name)) return false;
  return isEphemeralPlanArtifactPath((args.path as string) || "");
}

export function isPlanArtifactPath(path: string): boolean {
  const kind = detectPlanArtifactKind(path);
  return !!kind && kind !== "summary";
}

export function getProtectedPlanArtifactMutationViolation(
  name: string,
  args: Record<string, unknown>,
  language: "zh" | "en",
): { reason: string; target: string; message: string } | null {
  const path = typeof args.path === "string" ? args.path : "";
  const command = typeof args.command === "string" ? args.command : "";
  const isProtectedDelete = name === "delete_workspace_path" && isPlanArtifactPath(path);
  const normalizedCommand = command.replace(/\\/g, "/").toLowerCase();
  const isProtectedShellAccess =
    (name === "run_command" || name === "execute_command") &&
    normalizedCommand.includes(".main/plans/");
  if (!isProtectedDelete && !isProtectedShellAccess) return null;

  const target = isProtectedDelete ? canonicalizePlanArtifactPath(path) : truncateForLog(command, 240);
  const reason = isProtectedDelete
    ? "plan_artifact_delete_blocked"
    : "plan_artifact_shell_access_blocked";
  const message = language === "zh"
    ? `${reason.toUpperCase()}: 计划产物不能通过 ${name} 修改、删除或读取（目标：${target}）。请使用 write_file 或 replace_in_file 单文件更新，使 MAIN 能在磁盘、Store、revision 和批准状态变化前校验最终内容；不再需要的计划应通过 Plan 工作流重新生成或显式清理会话。`
    : `${reason.toUpperCase()}: Plan artifacts cannot be modified, deleted, or read through ${name} (target: ${target}). Use a single-file write_file or replace_in_file call so MAIN can validate the final content before disk, Store, revision, and approval state change; regenerate or explicitly clear obsolete plans through the Plan workflow.`;
  return { reason, target, message };
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
    evidenceChain?: {
      recentToolActivity: string;
      evidenceKeys: string[];
    };
  },
): void {
  const payload = {
    reason: input.reason,
    tool: input.tool,
    target: input.target || null,
    message: compactDiagnosticText(input.message),
    toolCallId: input.toolCallId || null,
    lifecycleState: input.lifecycleState || "blocked",
    evidenceChain: input.evidenceChain || null,
  };
  logAgentEvent("tool_preflight_blocked", payload);
  callbacks.onDebugEvent?.("agent.tool_preflight_blocked", payload);
}

export function isProjectSourceWriteResult(
  result: ToolExecutionResult,
  args: Record<string, unknown> = {},
): boolean {
  if (!hasVerifiedWorkspaceMutationEffect(result, args)) return false;
  const executionName = getToolExecutionName(result);
  return (
    EDIT_PROGRESS_TOOL_NAMES.has(executionName) &&
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
          text.startsWith("READ_SCOPE_DEFERRED:") ||
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
  if (!READ_BEFORE_MODIFY_WRITE_TOOLS.has(tc.name) && tc.name !== "read_file") return null;
  const runtimeIntent = callbacks.getRuntimeRunIntent?.() ?? callbacks.getCurrentRunIntent();
  if (!isMutationRuntimeIntent(runtimeIntent) && runtimeIntent !== "studio_workflow" && !callbacks.getIsPlanApproved()) {
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
  let writeMetadataStatus: FileMetadataAvailabilityProbe["status"] | null = null;
  if (tc.name === "write_file") {
    const probe = await probeFileMetadataAvailability(path, workspace);
    writeMetadataStatus = probe.status;
    metadata = probe.status === "exists" ? probe.metadata : null;
    existingFile = probe.status === "exists";
  } else if (tc.name === "read_file") {
    metadata = await readFileMetadataIfAvailable(path, workspace);
    existingFile = !!metadata;
  }

  const config = callbacks.getConfig?.();
  const contextLimit = callbacks.getSnapshotContextLimit?.() || config?.local?.contextLimit || 32768;
  const dynamicMaxWriteSizeBytes = Math.max(48 * 1024, Math.floor(contextLimit * 1.5 * 1024));

  // 1. Read File Size-Gate Check for unwindowed reads of large files
  if (tc.name === "read_file" && metadata && metadata.sizeBytes > dynamicMaxWriteSizeBytes && !args.start_line && !args.end_line && !args.max_lines) {
    const language = callbacks.getPreferredLanguage();
    const message = language === "zh"
      ? `READ_FILE_GATE_BLOCKED: 文件 ${path} 已存在且体量较庞大 (大小: ${(metadata.sizeBytes / 1024).toFixed(1)}KB)。为节省关键 Token 预算，已禁止无窗口全量读取。你必须指定 start_line/end_line/max_lines 分页读取，或改用 grep_search / get_file_outline 进行精准检索。`
      : `READ_FILE_GATE_BLOCKED: The file ${path} exists and is very large (${(metadata.sizeBytes / 1024).toFixed(1)}KB). To conserve context budget, unwindowed full read is blocked. You MUST specify start_line/end_line/max_lines to page, or use grep_search / get_file_outline for targeted exploration.`;
    callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
    emitToolPreflightBlocked(callbacks, {
      reason: "read_file_gate_blocked",
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

  if (tc.name === "read_file") return null;

  if (tc.name === "write_file" && writeMetadataStatus === "unknown") {
    const language = callbacks.getPreferredLanguage();
    const message = language === "zh"
      ? `WRITE_FILE_METADATA_UNAVAILABLE: 无法确认 ${path} 是否已存在（可能是 IPC、权限或路径解析错误）。为避免把未知状态误当成新文件并覆盖内容，本次写入已阻止；请先读取目标或修复文件访问问题。`
      : `WRITE_FILE_METADATA_UNAVAILABLE: could not determine whether ${path} already exists (for example due to IPC, permission, or path-resolution failure). The write was blocked so an unknown state cannot be mistaken for a new file; read the target or resolve file access first.`;
    callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
    emitToolPreflightBlocked(callbacks, {
      reason: "write_file_metadata_unavailable",
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

  // 2. Write File Size-Gate Check (Dynamic threshold scaling with context limit, min 48KB)
  if (tc.name === "write_file" && metadata && metadata.sizeBytes > dynamicMaxWriteSizeBytes) {
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

  if (writeMetadataStatus === "absent" && hasParentRead) return null;
  if (!existingFile && tc.name !== "write_file" && hasParentRead) return null;
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

function sedSegmentMutatesInPlace(args: string[]): boolean {
  return args.some((arg) =>
    arg === "-i" ||
    /^-i.+/.test(arg) ||
    /^-[A-Za-z]*i[A-Za-z]*$/.test(arg) ||
    arg === "--in-place" ||
    arg.startsWith("--in-place=")
  );
}

function grepSegmentHasFileOperand(args: string[]): boolean {
  let patternConsumed = false;
  let skipNextOptionValue = false;
  for (const arg of args) {
    if (!arg) continue;
    if (skipNextOptionValue) {
      skipNextOptionValue = false;
      continue;
    }
    if (arg === "--") continue;
    if (/^(?:-A|-B|-C|-m|--after-context|--before-context|--context|--max-count|-e|--regexp|-g|--glob|-t|--type|--type-add|--include|--exclude|--exclude-dir)$/.test(arg)) {
      skipNextOptionValue = true;
      if (/^(?:-e|--regexp)$/.test(arg)) patternConsumed = true;
      continue;
    }
    if (/^(?:-[ABCm]\d+|--(?:after-context|before-context|context|max-count)=|--(?:glob|type|type-add|include|exclude|exclude-dir)=)/.test(arg)) {
      continue;
    }
    if (/^(?:-e|--regexp)=?.+/i.test(arg)) {
      patternConsumed = true;
      continue;
    }
    if (/^(?:-f|--file)(?:=|$)/.test(arg)) return true;
    if (/^-/.test(arg)) continue;
    if (!patternConsumed) {
      patternConsumed = true;
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
  const commandName = command.replace(/^.*[\\/]/, "");
  if (/^(?:cat|head|tail)$/i.test(commandName)) {
    return catHeadTailSegmentHasFileOperand(commandName, args);
  }
  if (/^sed$/i.test(commandName)) {
    if (sedSegmentMutatesInPlace(args)) return false;
    return sedSegmentHasFileOperand(args);
  }
  if (/^(?:grep|egrep|fgrep|rg|ripgrep)$/i.test(commandName)) {
    return grepSegmentHasFileOperand(args);
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
      ? `SHELL_READ_FORBIDDEN: 禁止通过终端命令 (${command}) 绕过文件读取工具。原因不是终端占用上下文，而是 cat/sed/head/tail/grep/rg 的文件输出绕过 read_file 的分页、文件版本、范围缓存和修改后失效语义。请使用 read_file；文件版本变化、新范围、上下文淘汰、补丁失配或修改后核验都允许复读，同版本同窗口仍在上下文时会返回缓存 stub，应直接转向修改、验证或精确阻塞。`
      : `SHELL_READ_FORBIDDEN: Do not bypass file tools with terminal command (${command}). The issue is not terminal context use: file output from cat/sed/head/tail/grep/rg bypasses read_file paging, version checks, range caching, and post-mutation invalidation. Use read_file instead. A changed version, new range, evicted context, patch mismatch, or post-mutation check permits another read; the same active version/window returns a cache stub and should lead to mutation, validation, or an exact blocker.`;
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
    callbacks.onToolDone(tc.name, target, message, {
      toolCallId: tc.id,
      internalFeedback: true,
      qualityGateReason: "shell_read_forbidden",
    });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: message,
      displayContent: message,
      isError: false,
      internalFeedback: true,
      qualityGateReason: "shell_read_forbidden",
      lifecycleState: "blocked",
    };
  }
  return null;
}

/**
 * Detect repetitive mutation loops on the same file path and enforce a circuit-breaker.
 * read_file has its own versioned, range-aware cache and must not be limited by
 * a path-only count: distinct windows and post-mutation verification are valid.
 */
function collectMutationPathsForLoopGuard(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (toolName !== "apply_patch") {
    return [String(args.path || args.TargetFile || "").trim()].filter(Boolean);
  }
  const parsed = parseApplyPatch(String(args.patch || ""));
  if (!parsed.ok) return [];
  return [...new Set(parsed.operations.flatMap((operation) =>
    [operation.path, operation.newPath || ""].filter(Boolean)
  ))];
}

export function buildLoopDetectionValidationError(
  tc: ToolCallToExecute,
  args: Record<string, unknown>,
  callbacks: OrchestratorCallbacks,
): ToolExecutionResult | null {
  if (
    tc.name !== "write_file" &&
    tc.name !== "replace_in_file" &&
    tc.name !== "apply_patch"
  ) return null;

  const currentPaths = collectMutationPathsForLoopGuard(tc.name, args);
  if (currentPaths.length === 0) return null;

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
      !/^\s*Error:|"\s*status\s*"\s*:\s*"(?:failed|blocked|declined|no_op|no_effect_mutation)"|"\s*isError\s*"\s*:\s*true|"\s*noOp\s*"\s*:\s*true|NO_EFFECT_MUTATION|LOOP_DETECTED|REPEATED_FAILURE_BLOCKED/i.test(content),
    );
  }

  const samePathCalls = new Map<string, Array<{ order: number; successful: boolean }>>(
    currentPaths.map((path) => [path, []]),
  );
  currentTurnMessages.forEach((msg, order) => {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const c = call as { id?: string; function?: { name?: string; arguments?: string } };
        if (c.function?.name === "write_file" || c.function?.name === "replace_in_file" || c.function?.name === "apply_patch") {
          if (c.id === tc.id) continue;
          try {
            const parsed = JSON.parse(c.function.arguments || "{}");
            const resultSucceeded = c.id
              ? successfulToolResultsByCallId.get(c.id)
              : undefined;
            // A sibling call in the current unexecuted batch has no result yet.
            // It is neutral and must not reset a real historical failure streak.
            if (resultSucceeded == null) continue;
            const parsedPaths = collectMutationPathsForLoopGuard(c.function.name, parsed);
            for (const currentPath of currentPaths) {
              if (!parsedPaths.some((candidate) =>
                workspacePathsReferToSameFile(candidate, currentPath)
              )) continue;
              samePathCalls.get(currentPath)?.push({
                order,
                successful: resultSucceeded,
              });
            }
          } catch {
            // Ignore malformed JSON
          }
        }
      }
    }
  });

  // Successful iterative edits are real progress. This legacy safety net is
  // only for repeated failed mutations on the same target; exact-argument
  // failures and no-op writes are handled by the more specific guards.
  const blockedPath = currentPaths.find((currentPath) => {
    const calls = samePathCalls.get(currentPath) || [];
    const repetitions = calls.reduce(
      (streak, call) => call.successful ? 0 : streak + 1,
      0,
    );
    return repetitions >= 5;
  });
  if (blockedPath) {
    const target = getToolTarget(tc.name, args);
    const language = callbacks.getPreferredLanguage();
    const message = language === "zh"
      ? `LOOP_DETECTED: 检测到你在文件 ${blockedPath} 上执行了多次连续失败的修改。为防止死循环，本次调用已拦截。请暂停并在正文中解释为什么之前的改动未能成功应用（如编译错误或环境问题），然后使用 <user_options> 请用户确认方向。`
      : `LOOP_DETECTED: Detected multiple consecutively failed mutations on ${blockedPath}. To prevent an infinite execution loop, this call has been blocked. Please pause and explain in prose why previous edits failed (e.g. build errors or environment issues), then use <user_options> to ask the user for guidance.`;
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
  /** Runtime-only Turn owner for exact multimodal transport receipts. */
  runtimeTurnId?: string;
  runtimeVisualImageParts?: number;
  runtimeVisualPayloadDigest?: string;
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
  getCurrentRunIdentity?: () => {
    runId: string;
    parentRunId: string | null;
    goalSliceId?: string;
  };
  getSubagentDepth?: () => number;
  getSubagentScope?: () => import("./subagents").SubagentExecutionScope | null;
  getRuntimeTraceContext?: () => import("./subagents").RuntimeTraceContext;
  /** Exact owner-fenced checkpoint for the active Turn. */
  getTurnRuntimeCheckpoint?: () => import("./turnRuntimeCheckpoint").TurnRuntimeCheckpointV1 | null;
  getSnapshotContextLimit?: () => number;
  hasSessionHookInitialized: (sessionKey: string) => boolean;
  markSessionHookInitialized: (sessionKey: string) => void;
  // Planning & Management
  getCurrentRunIntent: () => ResolvedUserIntent;
  getRuntimeRunIntent?: () => ResolvedUserIntent;
  getGoalTurnContract?: () => import("./goalState").GoalTurnContract | null;
  getExecutionConsentGranted?: () => boolean;
  getForcedExecuteRecoveryMode?: () => ExecuteRecoveryMode | null;
  getForcedExecuteRecoveryState?: () => {
    mode: ExecuteRecoveryMode;
    reason?: string | null;
    expectedTarget?: string | null;
    attempts?: number;
    phase?: ExecuteRecoveryContractPhase;
    phaseNoProgressCount?: number;
    protocolNoProgressCount?: number;
    protocolNoProgressFingerprint?: string | null;
    readLease?: RecoveryReadLease | null;
    sourceObservationKey?: string | null;
    decisionCheckpoint?: ExecutionDecisionCheckpoint | null;
  } | null;
  getCommandDirective?: () => CommandDirective | null;
  getWorkflowMode: () => "chat" | "edit" | "plan";
  getIsPlanApproved: () => boolean;
  getPlanApprovalChoice: () => string | null;
  getReadOnlyAutoApproveForSession: () => boolean;
  getApprovedLocalFileReadPaths: () => string[];
  getAutoApproveToolScopes?: () => SessionAutoApproveScope[];
  getPlanStage: () => "idle" | "plan" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed";
  getPlanArtifacts?: () => PlanArtifact[];
  getPlanTasks: () => PlanTask[];
  getPlanExecutionEvidenceLedger: () => PlanExecutionEvidenceEntry[];
  getPlanAutoResumeCount?: () => number;
  getIsApprovedPlanExecutionTransitionPending?: () => boolean;
  getStatus: () => "idle" | "running" | "pending_review" | "error";
  consumeActiveGuidance?: () => { id: string; text: string; turnId: string | null } | null;
  onGuidanceInjected?: (guidance: { id: string; text: string; turnId: string | null }) => void;
  startNewTurn: () => void;
  getContextMemoryState?: () => ContextMemoryState | null;
  shouldForceXmlForProviderCompatibility?: () => boolean;
  onProviderCompatibilityFallback?: (reason: string) => void;
  onProviderNativeToolSuccess?: () => void;
  onToolSurfaceResolved?: (availableToolNames: string[]) => void;
  onDebugEvent?: (event: string, data?: Record<string, unknown>) => void;
  onModelUsage?: (usage: NonNullable<StreamResult["usage"]>) => void;
  onExecuteRecoveryStateChange?: (state: {
    mode: ExecuteRecoveryMode;
    reason: string;
    expectedTarget: string | null;
    attempts: number;
    phase: ExecuteRecoveryContractPhase;
    phaseNoProgressCount: number;
    protocolNoProgressCount: number;
    protocolNoProgressFingerprint: string | null;
    readLease: RecoveryReadLease | null;
    sourceObservationKey: string | null;
    decisionCheckpoint: ExecutionDecisionCheckpoint | null;
  }) => void;
  evaluateGoalToolResultCheckpoint?: (results: ToolExecutionResult[]) => {
    complete: boolean;
    reasons: string[];
    evidenceCount: number;
    supportingEvidenceIds: string[];
  };
  getPendingSubagentIds?: () => string[];
  runSubagent?: (
    request: import("./subagents").SpawnSubagentRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<import("./subagents").SpawnSubagentResult>;
  waitSubagents?: (
    request: import("./subagents").WaitSubagentsRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<import("./subagents").WaitSubagentsResult>;
  cancelSubagent?: (
    request: import("./subagents").CancelSubagentRequest,
  ) => Promise<import("./subagents").CancelSubagentResult>;

  // Goal Mode Support
  onGoalProgressUpdate?: (progress: import("./goalState").GoalProgress, goal: import("./goalState").GoalDefinition) => void;
  onGoalRuntimeUpdate?: (runtime: import("./goalState").GoalRuntimeSnapshot) => void;
  onGoalIterationStart?: (iteration: import("./goalState").GoalIteration) => void;
  onGoalIterationEnd?: (iteration: import("./goalState").GoalIteration) => void;
  onGoalCheckpointSaved?: (checkpoint: import("./goalState").GoalCheckpoint) => void;
  onGoalUserConfirmNeeded?: (message: string) => Promise<boolean>;
  onGoalOutcome?: (outcome: import("./goalState").GoalLoopOutcome) => void;

  // UI updates
  onStreamToken: (token: string, messageId: string) => void;
  onStreamDone: (
    fullText: string,
    messageId: string,
    truncated: boolean,
    meta?: {
      suppressTruncationWarning?: boolean;
      reason?: string;
      streamDiagnostics?: StreamResult["streamDiagnostics"];
    },
  ) => void;
  onThought: (thought: string) => void;
  /** Durable, user-visible progress commentary. This is not a terminal answer. */
  onAssistantCommentary?: (
    text: string,
    meta?: {
      visibility: "assistant_update";
      modelAuthored?: boolean;
      progress?: ProgressNarration;
      toolCalls?: Array<{ id?: string; name: string; target: string }>;
    },
  ) => void;
  onAssistantFinalText: (
    text: string,
    replyOptions?: ReplyOption[],
    meta?: {
      hasToolCalls?: boolean;
      hiddenThought?: string;
      visibility?: "user_progress" | "hidden_process" | "assistant_update" | "stage_summary" | "substantive_plan_text";
      preserveAssistantText?: boolean;
      capsuleCandidate?: boolean;
      modelAuthored?: boolean;
      progress?: ProgressNarration;
      toolCalls?: Array<{ id?: string; name: string; target: string }>;
      awaitingInput?: boolean;
    },
  ) => void;
  onStatusChange: (status: "idle" | "running" | "pending_review" | "error") => void;
  onError: (error: string) => void;
  onNonActionableStop: (
    message: string,
    reason: "no_output" | "no_action" | "missing_tool_loop" | "incomplete_plan",
    progress?: Partial<PlanExecutionProgressUpdate>,
  ) => void;
  onPlanArtifactUpdated: (
    path: string,
    content: string,
    kind: "plan" | "requirements" | "design" | "tasks" | "bugfix",
    metadata?: { candidate?: PlanCandidateV2 },
  ) => void;
  onPlanArtifactRejected?: (
    path: string,
    kind: "plan" | "requirements" | "design" | "tasks" | "bugfix",
    reason: string,
  ) => void;
  onPlanStageChanged: (stage: "idle" | "plan" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed") => void;
  onPlanApprovalInvalidated?: (reason: string) => void;
  onPlanTasksUpdated: (content: string) => void;
  onPlanExecutionProgress?: (progress: PlanExecutionProgressUpdate) => void;
  /** A fixed, user-safe plan drafting narration. Raw phases stay in the loop. */
  onPlanRuntimeNarration?: (narration: string | null) => void;
  onPlanMaxIterationsCheckpoint?: (
    checkpoint: PlanMaxIterationsCheckpoint,
  ) => MaxIterationsCheckpointHandling | Promise<MaxIterationsCheckpointHandling>;
  onExecuteMaxIterationsCheckpoint?: (
    checkpoint: PlanMaxIterationsCheckpoint,
  ) => MaxIterationsCheckpointHandling | Promise<MaxIterationsCheckpointHandling>;
  onChatMaxIterationsCheckpoint?: (
    checkpoint: PlanMaxIterationsCheckpoint,
  ) => MaxIterationsCheckpointHandling | Promise<MaxIterationsCheckpointHandling>;
  onTurnSummaryReady: (summary: string) => void;
  onExecutionDigestUpdate?: (summary: string) => void;
  onTurnRuntimePhaseChanged?: (phase: {
    id: string;
    kind: "scope" | "context" | "diagnosis" | "implementation" | "validation";
    title: string;
    summary?: string;
    domain?: string;
    status?: "pending" | "running" | "done" | "failed";
    reason?: string;
    iteration?: number;
    qualityRejectCount?: number;
  }) => void;
  onTurnEvent?: (event: MainThreadEvent) => void;
  hasRuntimeThreadStarted?: (threadId: string) => boolean;
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
    meta?: { toolCallId?: string; executionName?: string; catalogIdentity?: ToolCatalogIdentity },
  ) => void;
  onToolDone: (
    toolName: string,
    target: string,
    result: string,
    meta?: {
      toolCallId?: string;
      executionName?: string;
      catalogIdentity?: ToolCatalogIdentity;
      /** Runtime-owned final arguments after compatibility normalization. */
      executedArgs?: Record<string, unknown>;
      diff?: ToolDiffPreview;
      internalFeedback?: boolean;
      qualityGateReason?: string | null;
      /** Exact structured payload for evidence parsing when the UI result is truncated. */
      evidenceResult?: string;
    },
  ) => void;
  /** Structured post-execution observation used by non-UI evidence collectors. */
  onToolResultObserved?: (result: ToolExecutionResult) => void;
  onToolError: (
    toolName: string,
    target: string,
    error: string,
    meta?: ToolErrorLifecycleMeta,
  ) => void;

  // Human-in-the-loop — only for write/execute tools.
  // Read-only tools are auto-executed by the orchestrator.
  requestReview: (toolCall: {
    toolCallId?: string;
    name: string;
    arguments: Record<string, unknown>;
    risk?: ToolRiskLevel;
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
      reasoningRequest: "off",
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

export function resolveRuntimeProtocolProfile(input: {
  activeProfile?: "local" | "cloud";
  provider?: string | null;
  /** Accepted for caller compatibility; model identity never changes runtime guidance. */
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
  const protocolProfile = getProtocolInstructionProfile({
    protocol: input.protocol || "openai",
  });

  let toolProtocol: CloudToolProtocol = configured;
  if (activeProfile === "local") {
    toolProtocol = normalizeLocalToolProtocol(configured === "auto" ? undefined : configured, provider);
    if (input.compatibilityOverride === true) toolProtocol = "xml";
  } else {
    toolProtocol = normalizeCloudToolProtocol(configured);
    if (toolProtocol === "auto") toolProtocol = protocolProfile.toolProtocolPreference;
    if (input.compatibilityOverride === true) toolProtocol = "xml";
  }

  return {
    providerFamily: activeProfile === "local" ? provider || "local" : protocolProfile.provider,
    toolProtocol,
    reasoning: protocolProfile.reasoning,
    notes: protocolProfile.noiseRules,
  };
}

export function shouldUseXmlToolProtocol(
  config: AppConfig,
  settings: StreamSettings,
  messages: AgentMessage[],
  compatibilityOverride?: boolean,
): boolean {
  const profile = resolveRuntimeProtocolProfile({
    activeProfile: config.activeProfile,
    provider: settings.provider,
    model: settings.model,
    protocol: settings.apiProtocol,
    configuredToolProtocol: resolveEffectiveToolProtocol(config, settings),
    compatibilityOverride,
  });
  if (profile.toolProtocol === "xml") return true;
  if (compatibilityOverride === true) return true;
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
  const mutationTargets = resolveWorkspaceMutationTargets(name, args);
  if (mutationTargets.length > 0) return mutationTargets.join(", ");
  switch (name) {
    case "spawn_subagent":  return (args.name as string) || (args.objective as string) || "subagent";
    case "wait_subagents": return (args.subagent_ids as string) ||
      (args.collaboration_task_ids as string) || "all subagents";
    case "cancel_subagent": return (args.subagent_id as string) ||
      (args.collaboration_task_id as string) || "subagent";
    case "list_directory":  return (args.path as string) || ".";
    case "read_file":       return (args.path as string) || "";
    case "read_document":   return (args.path as string) || "";
    case "analyze_tabular_document": return (args.path as string) || "";
    case "query_tabular_document": return (args.path as string) || "";
    case "index_workspace_documents": return (args.path as string) || ".";
    case "knowledge_search": return (args.query as string) || "knowledge";
    case "knowledge_get_excerpt": return (args.chunk_id as string) || (args.chunkId as string) || "knowledge excerpt";
    case "glob_search":     return (args.pattern as string) || "";
    case "grep_search":     return (args.path as string) || (args.query as string) || "";
    case "web_search":      return (args.query as string) || "web search";
    case "web_fetch":       return (args.url as string) || "";
    case "repo_map_search": return (args.query as string) || "";
    case "repo_map_context": return (args.task as string) || "repo map context";
    case "repo_map_files": return (args.filter as string) || "repo map files";
    case "repo_map_impact": return (args.target as string) || "";
    case "repo_map_status": return "repo map";
    case "get_file_outline": return (args.path as string) || "";
    case "code_ast_query": return (args.path as string) || "";
    case "find_symbol_references": return (args.path as string) || (args.symbol as string) || "";
    case "git_status": return "git status";
    case "git_diff": return (args.path as string) || (args.filter as string) || "workspace diff";
    case "execute_command": return (args.command as string) || "";
    case "send_pty_input":  return formatPtyInputTarget(
      typeof args.input === "string" ? args.input : "",
      typeof args.control === "string" ? args.control : undefined,
    );
    case "run_command":     return (args.command as string) || "";
    case "browser_evaluate": return (args.url as string) || "";
    case "computer_use": return (args.app_name as string) || (args.appName as string) || (args.app as string) || "desktop app";
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
export const EXECUTE_CONVERGENCE_PROMPT_RATIO = 0.24;
export const MAX_NO_PROGRESS_LOOP_REPEATS = 5;
export const MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS = 2;
export const MAX_CONSECUTIVE_READ_FILE_CALLS = 3;
export const MAX_CONSECUTIVE_READ_ONLY_ITERATIONS = 3;

export function isReadFileOnlyPattern(results: ToolExecutionResult[]): boolean {
  if (results.length === 0) return false;
  return results.every(res => 
    res.name === "read_file" && 
    !res.isError && 
    (
      res.content.includes("FILE_UNCHANGED_STUB") ||
      res.content.includes("CACHED_FILE_REPLAY") ||
      res.content.includes("READ_FILE_REPEAT_LIMIT") ||
      res.content.includes("READ_FILE_WINDOW_NARROWED")
    )
  );
}

export function isContentInActiveMessages(modelContent: string, messages: AgentMessage[]): boolean {
  if (!modelContent || !modelContent.trim()) return false;
  return messages.some(msg => typeof msg.content === "string" && msg.content.includes(modelContent));
}
const NO_PROGRESS_EXCLUDED_TOOLS = new Set([
  "run_command",
  "execute_command",
  "send_pty_input",
  "browser_evaluate",
  "computer_use",
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
  if (/^\s*READ_FILE_WINDOW_NARROWED\b/i.test(raw)) {
    // A request such as 1-21 followed by 1-22 may legitimately return the
    // missing line, but it is the same semantic decision request. Keep the
    // read legal while preventing tiny overlap expansions from resetting the
    // convergence counter every turn.
    return "READ_FILE_WINDOW_NARROWED";
  }
  return raw
    .replace(/Duplicate skip count in this run:\s*\d+\./gi, "Duplicate skip count in this run: [n].")
    .replace(/\(duplicate\s+\d+\)/gi, "(duplicate [n])")
    .replace(/duplicateCount\s*[:=]\s*\d+/gi, "duplicateCount=[n]")
    .replace(/Previous read:\s*[\d,]+\s+chars/gi, "Previous read: [n] chars")
    .replace(/Previous read window:\s*lines\s+\d+-\d+\s+of\s+\d+,\s*[\d,]+\s+result chars/gi, "Previous read window: lines [range] of [n], [n] result chars");
}

export function buildNoProgressBatchSignature(results: ToolExecutionResult[]): string {
  const usable = results.filter(hasCompletedToolExecution);
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
    hasCompletedToolExecution(result) &&
    PLAN_ARTIFACT_MUTATION_TOOLS.has(result.name) &&
    !!result.target &&
    isPlanArtifactPath(result.target)
  );
}

export function getOriginalUserPromptForPlanFallback(callbacks: OrchestratorCallbacks): string {
  const userMessages = callbacks.getMessages()
    .filter((message) => message.role === "user")
    .map((message) => {
      const raw = extractCompatibilityTextContent(message.content);
      // Runtime context packets and hidden resume prompts share the user role
      // for provider compatibility, but they are not canonical user input.
      // Reuse the same boundary as durable turn context instead of selecting
      // the first arbitrary user-role packet.
      const canonical = canonicalizeVisibleUserText(raw);
      return canonical ? stripControlPromptForPlanFallback(canonical) : "";
    })
    .filter(Boolean);
  return userMessages.find((text) => !isPlanControlUserPrompt(text)) || userMessages[0] || "";
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
  evidenceBundle: PlanEvidenceBundle;
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
      const facts = item.facts || [];
      const structuredFacts = item.structuredFacts || [];
      const sourceObservations = item.sourceObservations || [];
      const hashInput = [
        item.name,
        item.target,
        summary,
        ...facts,
        JSON.stringify(structuredFacts),
        JSON.stringify(sourceObservations.map((observation) => ({
          path: observation.path,
          startLine: observation.startLine,
          endLine: observation.endLine,
          excerptHash: observation.excerptHash,
          versionToken: observation.versionToken,
        }))),
      ].filter(Boolean).join("\n");
      return {
        tool: item.name,
        target: item.target,
        status: "succeeded",
        ...(summary ? { summary } : {}),
        ...(facts.length > 0 ? { facts } : {}),
        ...(structuredFacts.length > 0 ? { structuredFacts } : {}),
        ...(sourceObservations.length > 0 ? { sourceObservations } : {}),
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
  const evidenceBundle = buildPlanEvidenceBundle({
    turnId: callbacks.getCurrentTurnId?.() || null,
    objective: sanitized.userGoal,
    constraints: sanitized.constraints,
    evidenceRecords,
    files: sanitized.files,
  });

  return {
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    evidenceRecords,
    files: sanitized.files,
    constraints: sanitized.constraints,
    sanitizer: sanitized.stats,
    sanitizerDropped: sanitized.dropped,
    evidenceBundle,
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
    language: MODEL_CONTROL_LANGUAGE,
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
  const deliverableHint = requestedDocs.length > 0
    ? language === "zh"
      ? `6. 用户明确要求最终文档：${requestedDocs.map((name) => `项目根目录 \`${name}\``).join("、")}。必须把它写进当前任务清单；如果持久化 tasks.md，也作为最后交付步骤，并在计划完成前真实写入。\n`
      : `6. The user explicitly requested final document(s): ${requestedDocs.map((name) => `project-root \`${name}\``).join(", ")}. Add them to the current task list; if tasks.md is persisted, include them as final deliverables and write them before marking the plan complete.\n`
    : "";

  return (
    approvalChoiceHint +
    (callbacks.getPlanTasks().length > 0
      ? language === "zh"
        ? "计划已批准，现在进入执行阶段（EXECUTION MODE）。MAIN 已有 runtime 任务清单，ExecutionCapsule 会直接显示任务进度；不需要为了第一次源码写入强制创建或读取 `.MAIN/plans/tasks.md`。请按当前任务清单逐项执行，通过当前暴露的正式工具调用推进；只有任务较长、需要跨会话审计或用户明确要求留档时，才先把清单持久化到 tasks.md。不要为了确认 tasks.md 是否存在而读取它；只有它已知存在或你正在同步已有审计文件时，才读取/更新。任何需要 shell 的任务都必须在当前任务清单中保留精确命令并用反引号包裹。只有同一文件版本、同一读取范围仍在当前上下文且再次读取只返回 `FILE_UNCHANGED_STUB` 时，才应停止该无进展重复；文件修改后、结果已淘汰或需要不同范围时可以重新读取。否则转向 `apply_patch`/`replace_in_file`/`write_file`、验证、其他必要范围或精确阻塞。页面渲染验证必须使用 Browser/Playwright DOM 或截图证据，不能用 curl/grep/cat 代替；不可自动执行的 Tauri/人工复核只记录为最终结论中的建议项，不能关闭任何自动验证缺口，也不能仅因此暂停。你可以正常修改项目源码文件，写入路径必须是项目中的正确位置，绝对不要将源码写入 `.MAIN/plans/` 或任何隐藏目录。只有全部可自动执行的任务都有真实文件/命令/交付物/浏览器证据满足后才能结束执行；剩余 Tauri/人工复核必须明确列在结论中。如果 tasks.md 已存在，完成任务后再同步更新对应 checkbox。\n"
        : "The plan is approved. You are now in EXECUTION MODE. MAIN already has a runtime task list, so ExecutionCapsule can show task progress without forcing creation or reads of `.MAIN/plans/tasks.md` before the first source write. Execute the current task list with tool calls; persist the list to tasks.md only when the work is long, cross-session, or explicitly needs an audit file. Do not read tasks.md just to check whether it exists; only read/update it when it is already known to exist or you are syncing an existing audit file. Any task that needs shell work must keep the exact command in the current task list using backticks. Stop rereading only when the same range of the same unchanged file version is still active and another read returns `FILE_UNCHANGED_STUB`; reread after mutation, eviction, or for a different required range. Otherwise patch/write, validate, inspect another needed range, or pause with the exact blocker. Rendered-page validation requires Browser/Playwright DOM or screenshot evidence; do not substitute curl/grep/cat. Tauri or manual review that cannot be automated is only an advisory in the final conclusion: it cannot close any automatic validation gap and must not by itself pause the run. You may now edit project source files, but write them to the proper project paths and never into `.MAIN/plans/` or hidden folders. Stop only after every automatable task has real file/command/deliverable/browser evidence, and list any remaining Tauri/manual review explicitly in the conclusion; if tasks.md exists, update the matching checkbox after evidence exists.\n"
      : language === "zh"
      ? "计划已批准，现在进入执行阶段（EXECUTION MODE）。请先基于已批准的 plan.md 派生精简 runtime 任务清单；只有任务较长、需要跨会话审计或用户明确要求留档时，才生成 `.MAIN/plans/tasks.md`。不要为了确认 tasks.md 是否存在而读取它。随后按任务逐项执行，通过当前暴露的正式工具调用推进。页面渲染验证必须使用 Browser/Playwright DOM 或截图证据；不可自动执行的 Tauri/人工复核只记录在最终结论中，不能关闭自动验证缺口，也不能仅因此暂停。你可以正常修改项目源码文件，写入路径必须是项目中的正确位置，绝对不要将源码写入 `.MAIN/plans/` 或任何隐藏目录。只有全部可自动执行任务都有真实文件/命令/交付物/浏览器证据满足后才能结束，并在结论中列出剩余用户复核建议。\n"
      : "The plan is approved. You are now in EXECUTION MODE. First derive a concise runtime task list from the approved plan.md; generate `.MAIN/plans/tasks.md` only when the work is long, cross-session, or explicitly needs an audit file. Do not read tasks.md just to check whether it exists. Then execute the tasks one by one using tool calls. Rendered-page validation requires Browser/Playwright DOM or screenshot evidence. Tauri or manual review that cannot be automated belongs only in the final conclusion: it cannot close an automatic validation gap and must not by itself pause the run. You may now edit project source files, but write them to the proper project paths and never into `.MAIN/plans/` or hidden folders. Stop only after every automatable task has real file/command/deliverable/browser evidence, and list any remaining user review suggestions in the conclusion.\n") +
    deliverableHint +
    (runtimeTaskList ? "\n" + runtimeTaskList + "\n" : "") +
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
  maxStreamElapsedMs?: number;
  maxStreamElapsedLabel?: string;
  toolChoice?: OpenAiToolChoice;
  responseFormat?: Record<string, unknown>;
  workflowMode?: string;
  runtimeIntent?: string;
  visualTransportBinding?: import("./visualContext").VisualTransportRequestBinding;
}

export function permitsConfiguredMaxOutputEscalation(
  maxTokensOverride: number | undefined,
  maxEscalationsOverride: number | undefined,
): boolean {
  // An explicit max-token value is the fixed ceiling unless the caller also
  // supplies an explicit, positive retry budget. This lets bounded phases use
  // the override as their starting point without silently enabling the
  // default three retries.
  return maxTokensOverride === undefined || (maxEscalationsOverride ?? 0) > 0;
}

export function isStreamWatchdogTimeoutMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("stream_first_chunk_timeout") ||
	  normalized.includes("stream_idle_timeout") ||
	  normalized.includes("stream_no_visible_token_timeout") ||
	  normalized.includes("stream_no_visible_progress_timeout") ||
	  normalized.includes("stream_visible_text_repetition") ||
	  normalized.includes("stream_max_elapsed_timeout") ||
	  normalized.includes("first chunk timeout") ||
	  normalized.includes("first response timeout") ||
	  normalized.includes("maximum stream duration") ||
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

export function createStreamMaxElapsedTimeoutError(timeoutMs: number, label?: string): Error {
  const suffix = label ? ` (${label})` : "";
  const error = new Error(`STREAM_MAX_ELAPSED_TIMEOUT: maximum stream duration ${timeoutMs}ms exceeded${suffix}`);
  (error as Error & { code?: string }).code = "STREAM_MAX_ELAPSED_TIMEOUT";
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
  rejectedVisibleCandidate?: boolean;
  toolCallCount?: number;
  replyOptionCount?: number;
}): boolean {
  if (input.workflowMode !== "plan" || input.isPlanApproved || input.hasReviewablePlanArtifacts) return false;
  if (input.evidenceCount <= 0) return false;
  if ((input.toolCallCount ?? 0) > 0 || (input.replyOptionCount ?? 0) > 0) return false;
  if ((input.consecutiveEmptyResponseCount ?? 0) >= 2) return true;
  if (input.usedPlanRecoveryPrompt) return true;
  return input.rejectedVisibleCandidate === true;
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
  const turnRuntimeCheckpoint = callbacks.getTurnRuntimeCheckpoint?.() || null;
  const canonicalRunIdentity = turnRuntimeCheckpoint?.canonical.run?.identity || null;
  const visualTransportBinding = options.visualTransportBinding || (
    turnRuntimeCheckpoint &&
    canonicalRunIdentity &&
    turnRuntimeCheckpoint.owner.sessionKey === callbacks.getSessionKey() &&
    canonicalRunIdentity.sessionKey === turnRuntimeCheckpoint.owner.sessionKey &&
    canonicalRunIdentity.sessionEpoch === turnRuntimeCheckpoint.owner.sessionEpoch &&
    canonicalRunIdentity.turnId === turnRuntimeCheckpoint.owner.turnId
      ? resolveTurnVisualPayloadBinding(messages, {
          owner: {
            sessionKey: canonicalRunIdentity.sessionKey,
            sessionEpoch: canonicalRunIdentity.sessionEpoch,
            turnId: canonicalRunIdentity.turnId,
            runId: canonicalRunIdentity.runId,
            attemptId: canonicalRunIdentity.attemptId,
          },
          expectedImageParts: turnRuntimeCheckpoint.input.admittedUserContext.imageParts,
        }) || undefined
      : undefined
  );
  // P1: Constrain local output length while retaining room for provider-reported hidden reasoning.
  const isLocal = isLocalProfile(settings);
  let currentMaxTokens: number;
  if (maxTokensOverride !== undefined) {
    currentMaxTokens = maxTokensOverride;
  } else {
    currentMaxTokens = computeInitialMaxTokens(settings.contextLimit);
  }
  let transientRetryCount = 0;

  // Max output tokens escalation loop (from claude-code-haha)
  const MAX_ESCALATIONS = maxEscalationsOverride ?? 3;
  const MAX_TRANSIENT_RETRIES = 2;
  let escalationCount = 0;

  // Track consecutive stream cancellations for aggressive context compaction
  let consecutiveCancelCount = 0;
  let capacityHandoffRetryCount = 0;

  const traceContext = callbacks.getRuntimeTraceContext?.();
  const isSubagentRequest = (callbacks.getSubagentDepth?.() || 0) > 0;
  const requestTokenBudget = Math.min(
    settings.contextLimit || 32_768,
    Math.max(2_048, estimateMessagesTokens(messages as TrimMessage[]) + currentMaxTokens),
  );
  const modelLane = await acquireModelLane({
    config: callbacks.getConfig(),
    contextLimit: settings.contextLimit,
    requestTokenBudget,
    agentKind: isSubagentRequest ? "subagent" : "parent",
    subagentId: traceContext?.subagentId,
    signal,
    onDebugEvent: (event, data) => callbacks.onDebugEvent?.(event, {
      ...data,
      ...(traceContext || {}),
    }),
  });

  try {
  while (true) {
    fullText = "";
    let result: StreamResult;
	    try {
	      result = await new Promise<StreamResult>((resolve, reject) => {
	        let settled = false;
	        const requestAbortController = new AbortController();
	        const timeoutMs = options.noVisibleTokenTimeoutMs ?? 0;
	        const maxStreamElapsedMs = options.maxStreamElapsedMs ?? 0;
	        let noVisibleTokenTimer: ReturnType<typeof setTimeout> | null = null;
	        let maxStreamElapsedTimer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
	          if (noVisibleTokenTimer !== null) {
	            clearTimeout(noVisibleTokenTimer);
	            noVisibleTokenTimer = null;
	          }
	          if (maxStreamElapsedTimer !== null) {
	            clearTimeout(maxStreamElapsedTimer);
	            maxStreamElapsedTimer = null;
	          }
	          signal.removeEventListener("abort", onExternalAbort);
	          modelLane.setPressureHandler(undefined);
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
	        modelLane.setPressureHandler((pressureFailure) => {
	          safeReject(pressureFailure);
	          requestAbortController.abort();
	        });
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
	        if (maxStreamElapsedMs > 0) {
	          maxStreamElapsedTimer = setTimeout(() => {
	            logAgentEvent("stream_max_elapsed_timeout", {
	              maxStreamElapsedMs,
	              label: options.maxStreamElapsedLabel || null,
	              workflowMode: options.workflowMode || null,
	              runtimeIntent: options.runtimeIntent || null,
	              currentMaxTokens,
	              toolCount: allTools.length,
	            });
	            callbacks.onHarnessRunUpdate?.({
	              streamStatus: "stream_max_elapsed_timeout",
	              lastStreamError: "STREAM_MAX_ELAPSED_TIMEOUT",
	              streamElapsedMs: maxStreamElapsedMs,
	              streamLifecycleStatus: "timeout",
	            });
	            const timeoutError = createStreamMaxElapsedTimeoutError(
	              maxStreamElapsedMs,
	              options.maxStreamElapsedLabel,
	            );
	            safeReject(timeoutError);
	            requestAbortController.abort();
	          }, maxStreamElapsedMs);
	        }

        void streamChatCompletion(
          messages,
          settings,
          {
            onToken: (token) => {
	          if (token.length > 0) modelLane.markFirstToken();
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
            visualTransportBinding,
          },
        ).catch((err) => {
          safeReject(err instanceof Error ? err : new Error(getErrorMessage(err, "LLM stream failed")));
        });
      });
    } catch (err) {
      const retryMessage = getErrorMessage(err, "LLM stream failed");
	  const childHandedBackForFailure = modelLane.reportFailure(err);
	  if (retryMessage.includes("SUBAGENT_MEMORY_PRESSURE_DEGRADED")) throw err;
	  if (isSubagentRequest && childHandedBackForFailure) throw err;
      
      const isOomError = isLocal && (
        retryMessage.toLowerCase().includes("oom") ||
        retryMessage.toLowerCase().includes("out of memory") ||
        retryMessage.toLowerCase().includes("memory allocation") ||
        retryMessage.toLowerCase().includes("connection reset") ||
        retryMessage.toLowerCase().includes("socket hang up")
      );

      if (isOomError && settings.contextLimit && settings.contextLimit > 4096) {
	    if (childHandedBackForFailure && capacityHandoffRetryCount >= 1) throw err;
	    if (childHandedBackForFailure) capacityHandoffRetryCount += 1;
        const newLimit = Math.max(4096, Math.floor(settings.contextLimit / 2));
        logAgentEvent("local_oom_fallback", {
          originalLimit: settings.contextLimit,
          newLimit,
          error: retryMessage,
        });
        settings.contextLimit = newLimit;
        currentMaxTokens = Math.min(currentMaxTokens, computeInitialMaxTokens(newLimit));
        callbacks.onStreamToken("__ESCALATION_RESET__:", messageId);
        // Give the local engine (Ollama/MLX) a moment to release its failed memory allocation
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

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

      // ── Consecutive cancellation tracking (Fix 4) ─────────────────────
      const isAbort = !signal.aborted && (
        (err as Error).name === "AbortError" ||
        retryMessage.toLowerCase().includes("abort") ||
        retryMessage.toLowerCase().includes("cancel")
      );

      if (isAbort) {
        consecutiveCancelCount++;
	        logAgentEvent("stream_cancellation_detected", {
	          consecutiveCount: consecutiveCancelCount,
	          cancelDuration: options.noVisibleTokenTimeoutMs ?? 0,
	          maxStreamElapsedMs: options.maxStreamElapsedMs ?? 0,
	        });

        // After 2+ consecutive cancellations, aggressively compact context
        if (consecutiveCancelCount >= 2 && settings.contextLimit && messages.length > 0) {
          const aggressiveLimit = Math.max(8192, Math.floor(settings.contextLimit * 0.6));
          const compactedResult = manageContext(
            messages as TrimMessage[],
            aggressiveLimit,
            Math.max(2048, Math.floor(aggressiveLimit * 0.15)),
            2000,
            1000,
            true,
          );
          if (compactedResult.changed) {
            // Reassign messages to compacted version for the next retry
            messages = compactedResult.messages as AgentMessage[];
            currentMaxTokens = Math.min(currentMaxTokens, computeInitialMaxTokens(aggressiveLimit));
            logAgentEvent("aggressive_context_compaction", {
              reason: "consecutive_stream_cancellations",
              cancelCount: consecutiveCancelCount,
              tokenReduction: compactedResult.tokenReduction,
              targetLimit: aggressiveLimit,
            });
            callbacks.onStreamToken("__ESCALATION_RESET__:", messageId);
            // Retry once with compacted context
            continue;
          }
        }
      } else {
        consecutiveCancelCount = 0;
      }

      throw err;
    }

    // Reset consecutive cancellation counter on successful stream completion
    consecutiveCancelCount = 0;

    // Escalation limits: Local ceiling is 32768; Cloud ceiling is 32768
    const effectiveCap = 32768;

    // Calculate context pressure to decide whether escalation makes sense
    const tokenBreakdown = computeContextTokenBreakdown(messages as import("./contextTrim").TrimMessage[]);
    const contextPressure = tokenBreakdown.total > 0 ? tokenBreakdown.system / tokenBreakdown.total : 0;
    // Escalation rules: only skip, never auto-degrade
    // - If context pressure > 0.85, skip escalation (keep current maxTokens)
    // - An explicit maxTokensOverride stays fixed unless the caller also
    //   supplied a positive, bounded escalation budget.
    const shouldEscalate =
      result.finishReason === "length" &&
      escalationCount < MAX_ESCALATIONS &&
      currentMaxTokens < effectiveCap &&
      contextPressure <= 0.85 &&
      permitsConfiguredMaxOutputEscalation(maxTokensOverride, maxEscalationsOverride);

    if (shouldEscalate) {
      const nextMaxTokens = escalateMaxTokens(currentMaxTokens, settings.contextLimit);
      if (nextMaxTokens !== null && nextMaxTokens > currentMaxTokens) {
        const targetMaxTokens = Math.min(nextMaxTokens, effectiveCap);
        if (targetMaxTokens > currentMaxTokens) {
          escalationCount++;
          logAgentEvent("max_output_escalated", {
            previousMaxTokens: currentMaxTokens,
            currentMaxTokens: targetMaxTokens,
            attempt: escalationCount,
            isLocal,
            contextPressure: Number(contextPressure.toFixed(3)),
          });
          currentMaxTokens = targetMaxTokens;

          // Reset stream buffer to accumulate clean output with expanded max_tokens
          callbacks.onStreamToken("__ESCALATION_RESET__:", messageId);
          continue;
        }
      }
    }

    // When context pressure > 0.92 and response is truncated, consider mild degradation
    if (
      result.finishReason === "length" &&
      contextPressure > 0.92 &&
      currentMaxTokens > 4096 &&
      maxTokensOverride === undefined
    ) {
      const degradedTokens = Math.max(4096, currentMaxTokens - 4096);
      if (degradedTokens < currentMaxTokens) {
        logAgentEvent("max_output_degraded", {
          previousMaxTokens: currentMaxTokens,
          currentMaxTokens: degradedTokens,
          reason: "extreme_context_pressure",
          contextPressure: Number(contextPressure.toFixed(3)),
        });
        currentMaxTokens = degradedTokens;
        callbacks.onStreamToken("__ESCALATION_RESET__:", messageId);
        continue;
      }
    }

    // Log when escalation was skipped due to context pressure
    if (
      result.finishReason === "length" &&
      contextPressure > 0.85 &&
      escalationCount < MAX_ESCALATIONS
    ) {
      logAgentEvent("max_output_escalation_skipped", {
        reason: "context_pressure_too_high",
        contextPressure: Number(contextPressure.toFixed(3)),
        currentMaxTokens,
      });
    }

    const isReasoningDominated = isReasoningDominatedLengthResult(result, isLocal);
    if (result.finishReason === "length" && isReasoningDominated && escalationCount < MAX_ESCALATIONS) {
      logAgentEvent("max_output_escalation_skipped", {
        reason: "reasoning_dominated_length",
        contentChars: result.content.length,
        reasoningChars: String(result.reasoningContent || "").length,
        toolCalls: result.toolCalls.length,
      });
    }

    const truncated = result.finishReason === "length";
    callbacks.onStreamDone(fullText, messageId, truncated, {
      suppressTruncationWarning: isReasoningDominated,
      reason: isReasoningDominated ? "reasoning_dominated_length" : "",
      streamDiagnostics: result.streamDiagnostics,
    });
    return result;

  }
  } finally {
    modelLane.release();
  }
}

// ── Tool Execution ─────────────────────────────────────────────────

function getToolResultDiagnosticText(result?: ToolExecutionResult): string {
  if (!result) return "";
  return [
    result.content,
    result.displayContent,
    result.qualityGateReason,
    result.lifecycleState,
  ].filter(Boolean).join("\n");
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
  quality?: PlanArtifactQualityResult;
  evidenceBundleHash?: string;
  candidate?: PlanCandidateV2;
  candidateRepairCheckpoint?: PlanCandidateRepairCheckpoint;
  candidateRepairExhausted?: boolean;
  toolResult?: ToolExecutionResult;
  /** Extracted reply options from <user_options> blocks. */
  replyOptions?: string[];
}

export interface ReviewablePlanPreparationResult {
  ok: boolean;
  repaired: boolean;
  reason?: string;
}

type ExecutablePlanCandidatePreparation = PlanMaterializationResult & {
  repaired?: boolean;
};

function buildTransientPlanArtifact(input: {
  path: string;
  content: string;
}): PlanArtifact {
  return {
    kind: "plan",
    path: input.path,
    title: "Plan",
    content: input.content,
    revision: 1,
    updatedAt: 0,
  };
}

function rejectExecutablePlanCandidate(
  reason: string,
): ExecutablePlanCandidatePreparation {
  return {
    ok: false,
    repaired: false,
    reason,
    quality: classifyPlanArtifactQualityResult({ ok: false, reason }),
  };
}

async function prepareExecutablePlanCandidate(input: {
  materialized: PlanMaterializationResult;
  workspace: string;
  callbacks: OrchestratorCallbacks;
}): Promise<ExecutablePlanCandidatePreparation> {
  const materialized = input.materialized;
  if (
    !materialized.ok ||
    materialized.kind !== "plan" ||
    !materialized.path ||
    !materialized.content
  ) {
    return materialized;
  }

  const artifact = buildTransientPlanArtifact({
    path: materialized.path,
    content: materialized.content,
  });
  const typedRuntimeAuthority = materialized.candidate?.ingress === "typed_runtime" ||
    materialized.candidate?.ingress === "runtime_synthesized";
  const tasks = typedRuntimeAuthority
    ? derivePlanTasksFromCandidate(materialized.candidate!)
    : deriveRuntimePlanTasksFromArtifacts([artifact], {
        language: input.callbacks.getPreferredLanguage(),
      });
  const assessment = assessPlanExecutableValidation({
    planArtifacts: [artifact],
    executionPlanTasks: tasks,
  });
  if (!assessment.missing) {
    if (!materialized.candidate) return { ...materialized, repaired: false };
    const candidate = sealPlanCandidate({
      candidate: materialized.candidate,
      content: materialized.content,
      runtimeTasks: tasks,
    });
    const failures = validateSealedPlanCandidate({
      candidate,
      expectedContent: materialized.content,
      expectedBundleHash: materialized.evidenceBundleHash,
    });
    return failures.length === 0
      ? { ...materialized, candidate, repaired: false }
      : rejectExecutablePlanCandidate(`typed_plan_contract_invalid:${failures.join(",")}`);
  }

  if (typedRuntimeAuthority) {
    // A typed proposal must carry an acceptance-capable primitive itself.
    // Manifest/Markdown repair is a legacy compatibility path and must never
    // manufacture authority missing from a new runtime candidate.
    return rejectExecutablePlanCandidate("typed_plan_executable_validation_missing");
  }

  let packageManifest: string;
  try {
    packageManifest = String(await executeTool(
      "read_file",
      { path: "package.json", __raw: true },
      input.workspace,
      input.callbacks.getSessionKey(),
    ) ?? "");
  } catch (error) {
    logAgentEvent("plan_manifest_validation_unproven", {
      reason: "package_manifest_unavailable",
      path: materialized.path,
      error: getErrorMessage(error, "package.json unavailable"),
    });
    return rejectExecutablePlanCandidate(
      "executable_validation_manifest_unproven:package_manifest_unavailable",
    );
  }

  const commandResolution = resolveTrustedProjectValidationCommands(packageManifest, {
    maxCommands: 1,
  });
  if (!commandResolution.ok) {
    logAgentEvent("plan_manifest_validation_unproven", {
      reason: commandResolution.reason,
      path: materialized.path,
    });
    return rejectExecutablePlanCandidate(
      `executable_validation_manifest_unproven:${commandResolution.reason}`,
    );
  }

  const repair = appendTrustedValidationCommandsToPlan({
    content: materialized.content,
    commands: commandResolution.commands.map((entry) => entry.command),
    language: input.callbacks.getPreferredLanguage(),
  });
  if (!repair.ok) {
    return rejectExecutablePlanCandidate(
      `executable_validation_manifest_unproven:${repair.reason}`,
    );
  }

  const repairedArtifact = buildTransientPlanArtifact({
    path: materialized.path,
    content: repair.content,
  });
  const quality = validateActionablePlanArtifact(repair.content);
  if (!quality.ok) {
    return rejectExecutablePlanCandidate(
      `manifest_validation_repair_rejected:${quality.reason || "quality_gate"}`,
    );
  }
  const repairedTasks = deriveRuntimePlanTasksFromArtifacts([repairedArtifact], {
    language: input.callbacks.getPreferredLanguage(),
  });
  const taskQuality = validateDerivedPlanTasksForApproval(repairedTasks);
  if (!taskQuality.ok) {
    return rejectExecutablePlanCandidate(
      `manifest_validation_repair_rejected:${taskQuality.reason || "invalid_runtime_plan_task_graph"}`,
    );
  }
  const repairedAssessment = assessPlanExecutableValidation({
    planArtifacts: [repairedArtifact],
    executionPlanTasks: repairedTasks,
  });
  if (repairedAssessment.missing) {
    return rejectExecutablePlanCandidate("executable_validation_task_missing");
  }

  const sealedCandidate = materialized.candidate
    ? sealPlanCandidate({
        candidate: materialized.candidate,
        content: repair.content,
        runtimeTasks: repairedTasks,
      })
    : undefined;
  if (sealedCandidate) {
    const failures = validateSealedPlanCandidate({
      candidate: sealedCandidate,
      expectedContent: repair.content,
      expectedBundleHash: materialized.evidenceBundleHash,
    });
    if (failures.length > 0) {
      return rejectExecutablePlanCandidate(`typed_plan_contract_invalid:${failures.join(",")}`);
    }
  }

  logAgentEvent("plan_manifest_validation_repaired", {
    path: materialized.path,
    command: commandResolution.commands[0]?.command || "",
    scriptName: commandResolution.commands[0]?.scriptName || "",
    manifestPath: commandResolution.commands[0]?.manifestPath || "package.json",
  });
  return {
    ...materialized,
    content: repair.content,
    ...(sealedCandidate ? { candidate: sealedCandidate } : {}),
    source: "manifest_validation_repaired_plan",
    repaired: true,
  };
}

async function writeMaterializedPlanArtifact(input: {
  materialized: {
    ok: boolean;
    path?: string;
    kind?: "plan" | "design";
    content?: string;
    reason?: string;
    source?: PlanMaterializationSource;
    quality?: PlanArtifactQualityResult;
    evidenceBundleHash?: string;
    candidate?: PlanCandidateV2;
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
      quality: materialized.quality,
    };
  }

  const toolCallId = `${input.toolCallPrefix}_${generateId()}`;
  const args = { path: materialized.path, content: materialized.content };
  input.callbacks.onToolExecuting("write_file", materialized.path, undefined, { toolCallId });

  try {
    let resultStr = "Plan artifact written atomically and verified.";
    try {
      await writeFileAtomic(materialized.path, materialized.content, input.workspace);
      const readBack = await executeTool(
        "read_file",
        { path: materialized.path, __raw: true },
        input.workspace,
        input.callbacks.getSessionKey(),
      );
      if (String(readBack ?? "") !== materialized.content) {
        throw new Error("Atomic plan artifact read-back did not match the validated candidate.");
      }
    } catch (atomicError) {
      // Browser E2E adapters and older desktop bridges may not expose the
      // atomic IPC yet. Preserve compatibility, but still require exact
      // read-back before publishing the artifact or review request.
      logAgentEvent("plan_artifact_atomic_write_fallback", {
        path: materialized.path,
        reason: getErrorMessage(atomicError, "atomic bridge unavailable"),
      });
      const rawResult = await executeTool("write_file", args, input.workspace, input.callbacks.getSessionKey());
      resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
      const fallbackReadBack = await executeTool(
        "read_file",
        { path: materialized.path, __raw: true },
        input.workspace,
        input.callbacks.getSessionKey(),
      );
      if (String(fallbackReadBack ?? "") !== materialized.content) {
        throw new Error("Plan artifact fallback write read-back did not match the validated candidate.");
      }
    }
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
        candidate: materialized.candidate,
      },
    );
    input.callbacks.onToolDone("write_file", materialized.path, resultStr, { toolCallId });
    return {
      ok: true,
      path: materialized.path,
      kind: materialized.kind,
      content: materialized.content,
      source: materialized.source,
      evidenceBundleHash: materialized.evidenceBundleHash,
      candidate: materialized.candidate,
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
    input.callbacks.onToolError("write_file", materialized.path, message, {
      toolCallId,
      failureKind: "actual",
    });
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

/**
 * Last pre-review repair for persisted/restored plans. The artifact is updated
 * atomically before its approval identity is calculated; if a trusted command
 * cannot be proven, the caller must keep the run out of pending_review.
 */
export async function prepareReviewablePlanArtifactForReview(input: {
  workspace: string;
  callbacks: OrchestratorCallbacks;
}): Promise<ReviewablePlanPreparationResult> {
  const artifacts = input.callbacks.getPlanArtifacts?.() || [];
  if (artifacts.length === 0) return { ok: true, repaired: false };
  const typedTasks = artifacts.flatMap((artifact) =>
    artifact.candidate?.state === "sealed"
      ? derivePlanTasksFromCandidate(artifact.candidate)
      : []
  );
  const tasks = typedTasks.length > 0
    ? typedTasks
    : deriveRuntimePlanTasksFromArtifacts(artifacts, {
        language: input.callbacks.getPreferredLanguage(),
      });
  const assessment = assessPlanExecutableValidation({
    planArtifacts: artifacts,
    executionPlanTasks: tasks,
  });
  if (!assessment.missing) return { ok: true, repaired: false };

  const artifact = artifacts.find((candidate) =>
    candidate.kind === "plan" && planArtifactRequiresExecutableValidation(candidate)
  );
  if (!artifact) {
    return {
      ok: false,
      repaired: false,
      reason: "executable_validation_repair_target_missing",
    };
  }
  const prepared = await prepareExecutablePlanCandidate({
    materialized: {
      ok: true,
      kind: "plan",
      path: artifact.path,
      content: artifact.content,
      source: "visible_plan",
      ...(artifact.candidate
        ? {
            candidate: artifact.candidate,
            evidenceBundleHash: artifact.candidate.bundleHash,
          }
        : {}),
    },
    workspace: input.workspace,
    callbacks: input.callbacks,
  });
  if (!prepared.ok || !prepared.content || !prepared.path || !prepared.kind) {
    return {
      ok: false,
      repaired: false,
      reason: prepared.reason || "executable_validation_task_missing",
    };
  }
  if (!prepared.repaired) {
    return {
      ok: false,
      repaired: false,
      reason: "executable_validation_task_missing",
    };
  }

  const written = await writeMaterializedPlanArtifact({
    materialized: prepared,
    workspace: input.workspace,
    callbacks: input.callbacks,
    toolCallPrefix: "plan_manifest_validation_repair",
  });
  return written.ok
    ? { ok: true, repaired: true }
    : {
        ok: false,
        repaired: false,
        reason: written.reason || "manifest_validation_repair_write_failed",
      };
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
        ? "计划审批前只校验候选方案，不提前修改源码。"
        : "Before approval, validate the plan candidate without editing source files.",
      action: input.language === "zh"
        ? "正在把候选方案交给 runtime 校验和物化。"
        : "Passing the plan candidate to runtime validation and materialization.",
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

export function buildGenericObservationContinuationPrompt(
  language: "zh" | "en",
  toolName: string,
  target: string,
  duplicateCount: number,
): string {
  const targetDesc = target ? ` (${target})` : "";
  if (language === "zh") {
    return [
      `[OBSERVATION_CHECKPOINT] 检查/诊断工具 ${toolName}${targetDesc} 在本轮已重复调用 ${duplicateCount} 次。`,
      "通用流程确认与阶段指引：",
      "1. 【现象与证据确认】：复用上面已返回的诊断/日志/文件内容，在正文中简要确认关键报错堆栈、行号或修改点。",
      "2. 【进入实施/验证】：如果证据已足够，请直接调用代码修改工具 (replace_in_file / apply_patch / write_file) 实施修补或运行验证命令；不要原样重复刷读取。",
      "3. 【阻塞明确】：如因缺少其他信息无法继续，请在回复中说明具体阻塞或使用 <user_options> 请用户确认。",
    ].join("\n");
  }
  return [
    `[OBSERVATION_CHECKPOINT] Inspection/diagnostic tool ${toolName}${targetDesc} has been invoked ${duplicateCount} times in this turn.`,
    "Workflow Validation Protocol:",
    "1. [Evidence Confirmation]: Synthesize the retrieved error log, file content, or DOM state in prose to confirm line numbers or root cause.",
    "2. [Phase Advancement]: If evidence is sufficient, proceed directly to code modification (replace_in_file / apply_patch / write_file) or verification commands; do not re-run identical reads.",
    "3. [Blocker Escalation]: If information is incomplete and unretrievable, explain the concrete blocker or offer <user_options>.",
  ].join("\n");
}

export function appendPlanRepeatReadLimitGuidance(
  content: string,
  language: "zh" | "en",
  stage: ReturnType<OrchestratorCallbacks["getPlanStage"]>,
): string {
  const guidance = language === "zh"
    ? stage === "requirements"
      ? `PLAN_REPEAT_READ_LIMIT: 你正在计划阶段重复读取已经缓存且未变化的上下文。请停止重复读取，直接基于 requirements.md 和已有文件上下文提交完整 typed graph；如果存在真正由用户决定的阻塞分叉，再用 <user_options> 提问并立刻停止。${buildPlanSubmissionGuidance("zh")}`
      : `PLAN_REPEAT_READ_LIMIT: 你正在重复读取已经缓存且未变化的上下文。请停止重复读取并提交完整 typed graph；只有真正阻塞的用户决策才能使用 <user_options>。${buildPlanSubmissionGuidance("zh")}`
    : stage === "requirements"
    ? `PLAN_REPEAT_READ_LIMIT: You are repeating cached unchanged reads during planning. Stop rereading files and submit the complete typed graph from requirements.md and existing context; use <user_options> only for a genuinely blocking user-owned decision. ${buildPlanSubmissionGuidance("en")}`
    : `PLAN_REPEAT_READ_LIMIT: You are repeating cached unchanged reads. Stop rereading and submit the complete typed graph; use <user_options> only for a genuinely blocking user-owned decision. ${buildPlanSubmissionGuidance("en")}`;
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

export type FileMetadataAvailabilityProbe =
  | {
      status: "exists";
      metadata: { path: string; sizeBytes: number; modifiedMs: number };
    }
  | { status: "absent"; metadata: null }
  | { status: "unknown"; metadata: null };

/**
 * Unlike `readFileMetadataIfAvailable`, this preserves the distinction between
 * a confirmed ENOENT and an IPC/permission/path-resolution failure. Callers may
 * authorize creation only for the former.
 */
export async function probeFileMetadataAvailability(
  path: string,
  workspace?: string,
): Promise<FileMetadataAvailabilityProbe> {
  try {
    const metadata = await getFileMetadata(path, workspace);
    return {
      status: "exists",
      metadata: {
        path: String(metadata.path || path),
        sizeBytes: Number(metadata.sizeBytes) || 0,
        modifiedMs: Number(metadata.modifiedMs) || 0,
      },
    };
  } catch (error) {
    const message = getErrorMessage(error, "FILE_METADATA_UNAVAILABLE");
    if (message.startsWith("FILE_METADATA_NOT_FOUND:")) {
      return { status: "absent", metadata: null };
    }
    return { status: "unknown", metadata: null };
  }
}

function normalizePathLike(value: string): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}

function resolveMutationVerificationPath(name: string, args: Record<string, unknown>): string | null {
  const targets = resolveWorkspaceMutationTargets(name, args);
  return targets.length === 1 ? normalizePathLike(targets[0]) : null;
}

function isSameFileMetadata(
  left: { path: string; sizeBytes: number; modifiedMs: number } | null,
  right: { path: string; sizeBytes: number; modifiedMs: number } | null,
): boolean {
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
  if (!input.before || !input.after) return false;
  const normalized = input.result.trim();
  const emptyPayload = normalized === "" || normalized === "{}" || normalized === "null";
  const unchanged = isSameFileMetadata(input.before, input.after);
  return emptyPayload && unchanged;
}

export function isVerifiedNoEffectMutation(input: {
  supportsDiffVerification: boolean;
  beforeDiffSnapshot: unknown | null;
  afterDiffSnapshot: unknown | null;
  observedDiffPreview?: ToolDiffPreview;
  result: string;
  beforeMetadata: { path: string; sizeBytes: number; modifiedMs: number } | null;
  afterMetadata: { path: string; sizeBytes: number; modifiedMs: number } | null;
}): boolean {
  if (input.supportsDiffVerification) {
    return (
      input.beforeDiffSnapshot !== null &&
      input.beforeDiffSnapshot !== undefined &&
      input.afterDiffSnapshot !== null &&
      input.afterDiffSnapshot !== undefined &&
      !input.observedDiffPreview
    );
  }
  return isNoEffectMutationResult({
    result: input.result,
    before: input.beforeMetadata,
    after: input.afterMetadata,
  });
}

async function readMutationDiffSnapshot(input: {
  path: string;
  workspace: string;
  sessionKey?: string;
  allowExternalLocalRead?: boolean;
}): Promise<{ path: string; content: string; existed: boolean } | null> {
  const availability = await probeFileMetadataAvailability(input.path, input.workspace);
  if (availability.status === "absent") {
    return { path: input.path, content: "", existed: false };
  }
  if (availability.status === "unknown") return null;
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
    // The file may have been removed between metadata and content reads. Only
    // a second confirmed ENOENT can represent that as a deletion snapshot;
    // permission/IPC/path-resolution failures remain unknown and cannot
    // manufacture a diff or durable mutation evidence.
    const afterFailure = await probeFileMetadataAvailability(input.path, input.workspace);
    return afterFailure.status === "absent"
      ? { path: input.path, content: "", existed: false }
      : null;
  }
}

function buildMutationDiffPreviewFromSnapshots(input: {
  toolName: string;
  target: string;
  before: { path: string; content: string; existed: boolean } | null;
  after: { path: string; content: string; existed: boolean } | null;
}): ToolDiffPreview | undefined {
  if (!supportsToolDiffPreview(input.toolName)) return undefined;
  if (!input.before || !input.after) return undefined;
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
    if (name === "read_file") return { modelChars: 36000, displayChars: 10000 };
    if (name === "read_document" || name === "analyze_tabular_document" || name === "query_tabular_document") {
      return { modelChars: 7000, displayChars: 8000 };
    }
    if (name === "run_command" || name === "execute_command" || name === "browser_evaluate" || name === "computer_use") return { modelChars: 6000, displayChars: 8000 };
    return { modelChars: 6000, displayChars: 8000 };
  }

  if (name === "read_file") return { modelChars: 36000, displayChars: 10000 };
  if (name === "read_document" || name === "analyze_tabular_document" || name === "query_tabular_document") {
    return { modelChars: 16000, displayChars: 10000 };
  }
  if (name === "run_command" || name === "execute_command" || name === "browser_evaluate" || name === "computer_use") return { modelChars: 12000, displayChars: 10000 };
  return { modelChars: 12000, displayChars: 10000 };
}

export function inferLifecycleStateFromToolResult(result: ToolExecutionResult): ToolLifecycleState {
  if (result.internalFeedback) return "blocked";
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
  const observedMutationPaths = getObservedWorkspaceMutationPaths(result);
  const failedAfterWorkspaceMutation =
    lifecycleState === "failed" &&
    result.workspaceEffect === "partial" &&
    observedMutationPaths.length > 0;
  const isNoOp = /"noOp"\s*:\s*true/.test(result.content || "");
  const isNoEffectMutation = /NO_EFFECT_MUTATION/i.test(result.content || "");
  const isCachedReuse =
    PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name) &&
    isReadOnlyNoProgressDetail(result.displayContent || result.content);
  const status: ToolFeedbackStatus =
    lifecycleState === "declined"
      ? "declined"
    : lifecycleState === "blocked"
      ? "blocked"
    : failedAfterWorkspaceMutation
      ? "failed"
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
    workspaceEffect: failedAfterWorkspaceMutation ? "partial" : undefined,
    changedPaths: failedAfterWorkspaceMutation ? observedMutationPaths : undefined,
    nextAction: failedAfterWorkspaceMutation
      ? "reread_changed_paths_before_retry"
      : undefined,
    summary: failedAfterWorkspaceMutation
      ? "Tool failed after changing the workspace; the changed source context is stale."
      : noOpSummary || result.displayContent || result.content,
    hints: failedAfterWorkspaceMutation
      ? [
          `Reread the current changed path${observedMutationPaths.length === 1 ? "" : "s"}: ${observedMutationPaths.join(", ")}.`,
          "Do not retry the failed mutation from the pre-call source content or with identical arguments.",
        ]
      : undefined,
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
  if (format !== "envelope_v1") {
    const observedMutationPaths = getObservedWorkspaceMutationPaths(result);
    if (
      inferLifecycleStateFromToolResult(result) === "failed" &&
      result.workspaceEffect === "partial" &&
      observedMutationPaths.length > 0
    ) {
      return [
        `PARTIAL_WORKSPACE_MUTATION:${JSON.stringify({
          workspace_effect: "partial",
          changedPaths: observedMutationPaths,
          next_action: "reread_changed_paths_before_retry",
        })}`,
        "The tool failed after changing the workspace. Reread the current changed path before repair; do not retry from pre-call source content or with identical arguments.",
        result.content,
      ].join("\n");
    }
    return result.content;
  }
  return buildToolResultHistoryContent(result);
}

interface ExecuteToolLifecycleOptions {
  allowExternalLocalRead?: boolean;
  /** Runtime-owned lease roots for one safely fanned-out child read. */
  scopedReadPaths?: string[];
  shellPermissionApproval?: ShellPermissionApproval;
  abortSignal?: AbortSignal;
  turnContext?: TurnInputContextSignals;
  recentPlanToolActivity?: PlanToolActivitySummary[];
  attemptedPlanWriteTargets?: string[];
  toolCatalog?: ToolCatalog;
  /** Fires at the child registration boundary, before any same-batch wait_subagents call. */
  onSubagentSpawnCreated?: (
    outcome: SpawnSubagentResult,
  ) => void | Promise<void>;
  /** Authorization that was computed before PreToolUse ran. */
  authorizationMode?: "automatic" | "session" | "user" | "plan_artifact";
  toolCapabilityRegistry?: ToolCapabilityRegistry;
}

function stableToolArgumentIdentity(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableToolArgumentIdentity(entry)).join(",")}]`;
  }
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableToolArgumentIdentity(entry)}`)
    .join(",")}}`;
}

const SCOPED_READ_FAN_OUT_TOOLS = new Set([
  "grep_search",
  "find_symbol_references",
  "git_diff",
]);

interface ScopedReadFanOutEntry {
  sourcePath: string;
  content: string;
  negative: boolean;
  error: string;
  blocked: boolean;
  additionalContexts: string[];
}

/**
 * Execute each runtime-owned scoped-read target through its own validation and
 * Pre/PostToolUse lifecycle. The model-visible JSON still represents one tool
 * call, while the immutable sidecar paths remain the sole execution scope.
 */
async function executeScopedReadFanOutWithLifecycle(input: {
  tc: ToolCallToExecute;
  baseToolArgs: Record<string, unknown>;
  scopedReadPaths: string[];
  workspace: string;
  callbacks: OrchestratorCallbacks;
  allTools: ToolDefinition[];
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>;
  options: ExecuteToolLifecycleOptions;
}): Promise<ToolExecutionResult> {
  const {
    tc,
    baseToolArgs,
    scopedReadPaths,
    workspace,
    callbacks,
    allTools,
    hooksConfig,
    options,
  } = input;
  const sessionKey = callbacks.getSessionKey();
  const target = scopedReadPaths.join(", ");
  callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });

  // Validate the shared selector/query once before it is projected across
  // runtime-owned paths. Otherwise one malformed model call is misreported as
  // N independent file failures and creates bogus path-coverage debt.
  const baseValidationError = validateToolExecutionContract(tc.name, baseToolArgs, allTools);
  if (baseValidationError) {
    const scope = callbacks.getSubagentScope?.() ?? null;
    const quarantined = scope
      ? recordSubagentScopeBlockedTool(scope, tc.name)
      : false;
    const message = [
      `SUBAGENT_SCOPED_READ_CALL_INVALID: ${baseValidationError}`,
      quarantined
        ? `The broad tool '${tc.name}' is removed for the next child iteration. Use an exact allowed read_file/read_document/get_file_outline call instead.`
        : "Correct the shared arguments before retrying this scoped read.",
    ].join(" ");
    callbacks.onToolDone(tc.name, target, message, {
      toolCallId: tc.id,
      internalFeedback: true,
      qualityGateReason: "subagent_scoped_read_invalid_arguments",
    });
    callbacks.onDebugEvent?.("subagent_scoped_read_fallback", {
      tool: tc.name,
      scopeKey: scope?.scopeKey || null,
      reason: "invalid_shared_arguments",
      quarantined,
      scopedReadPaths,
    });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: message,
      displayContent: "",
      isError: false,
      lifecycleState: "blocked",
      internalFeedback: true,
      qualityGateReason: "subagent_scoped_read_invalid_arguments",
    };
  }

  const entries = await Promise.all(scopedReadPaths.map(async (sourcePath): Promise<ScopedReadFanOutEntry> => {
    const initialArgs = normalizeToolCallForExecution(
      tc.name,
      { ...baseToolArgs, path: sourcePath },
      workspace,
    );
    const validationError = validateToolExecutionContract(tc.name, initialArgs, allTools);
    if (validationError) {
      return {
        sourcePath,
        content: "",
        negative: false,
        error: validationError,
        blocked: true,
        additionalContexts: [],
      };
    }

    const hookPayload = {
      toolName: tc.name,
      toolArgs: initialArgs,
      workspace,
      workflowMode: callbacks.getWorkflowMode(),
      language: callbacks.getPreferredLanguage(),
      associatedPaths: callbacks.getAssociatedPaths(),
      scopedReadFanOut: true,
      scopedReadTarget: sourcePath,
      scopedReadTargets: [...scopedReadPaths],
    };
    const preHookResult = await runLifecycleHooks(
      callbacks,
      hooksConfig,
      "PreToolUse",
      hookPayload,
    );
    if (preHookResult.blocked) {
      return {
        sourcePath,
        content: "",
        negative: false,
        error: preHookResult.blockedReason ?? `${tc.name} was blocked by a PreToolUse hook.`,
        blocked: true,
        additionalContexts: [...preHookResult.additionalContexts],
      };
    }

    const hookArgs = normalizeToolCallForExecution(
      tc.name,
      preHookResult.updatedToolArgs ?? initialArgs,
      workspace,
    );
    const hookPath = typeof hookArgs.path === "string" ? hookArgs.path.trim() : "";
    if (
      !hookPath ||
      normalizeWorkspacePathIdentity(hookPath) !== normalizeWorkspacePathIdentity(sourcePath)
    ) {
      return {
        sourcePath,
        content: "",
        negative: false,
        error: `SCOPED_READ_HOOK_PATH_BLOCKED: PreToolUse cannot rewrite runtime-owned target ${sourcePath} to ${hookPath || "(missing)"}.`,
        blocked: true,
        additionalContexts: [...preHookResult.additionalContexts],
      };
    }

    // Keep path immutable after hooks while honoring safe edits to query,
    // symbol, filter and result-budget arguments.
    const effectiveArgs = { ...hookArgs, path: sourcePath };
    const postHookValidationError = validateToolExecutionContract(tc.name, effectiveArgs, allTools);
    if (postHookValidationError) {
      return {
        sourcePath,
        content: "",
        negative: false,
        error: postHookValidationError,
        blocked: true,
        additionalContexts: [...preHookResult.additionalContexts],
      };
    }

    try {
      const value = await executeTool(
        tc.name,
        effectiveArgs,
        workspace,
        sessionKey,
        {
          allowExternalLocalRead: options.allowExternalLocalRead === true,
          shellPermissionApproval: options.shellPermissionApproval,
          toolCatalog: options.toolCatalog,
        },
      );
      const content = typeof value === "string" ? value : JSON.stringify(value);
      const negative = !content.trim() ||
        /(?:no matches?|0 matches?|not found|no references? found)/i.test(content);
      const postHookResult = await runLifecycleHooks(callbacks, hooksConfig, "PostToolUse", {
        ...hookPayload,
        toolArgs: effectiveArgs,
        toolResult: content,
        isError: false,
      });
      return {
        sourcePath,
        content,
        negative,
        error: "",
        blocked: false,
        additionalContexts: [
          ...preHookResult.additionalContexts,
          ...postHookResult.additionalContexts,
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error || "Unknown scoped read error");
      const postHookResult = await runLifecycleHooks(callbacks, hooksConfig, "PostToolUse", {
        ...hookPayload,
        toolArgs: effectiveArgs,
        toolResult: errorMessage,
        isError: true,
      });
      return {
        sourcePath,
        content: "",
        negative: false,
        error: errorMessage,
        blocked: false,
        additionalContexts: [
          ...preHookResult.additionalContexts,
          ...postHookResult.additionalContexts,
        ],
      };
    }
  }));

  const successful = entries.filter((entry) => !entry.error);
  const failed = entries.filter((entry) => Boolean(entry.error));
  const allTargetsFailed = failed.length === entries.length;
  const sharedFailure = allTargetsFailed && new Set(
    failed.map((entry) => entry.error.trim()),
  ).size === 1;
  const coverage = {
    requiredPaths: [...scopedReadPaths],
    coveredPaths: successful.map((entry) => entry.sourcePath),
    // An identical all-target error is call/global failure evidence, not proof
    // that every underlying file is unreadable. Keep the targets uncovered so
    // exact reads can recover them, without falsely labelling each path failed.
    failedPaths: sharedFailure ? [] : failed.map((entry) => entry.sourcePath),
  };
  const cloudProfile = callbacks.getConfig().activeProfile === "cloud";
  const budgets = getToolResultBudgets(tc.name, cloudProfile);
  const perTargetBudget = Math.max(
    1_000,
    Math.floor(budgets.modelChars / scopedReadPaths.length) - 96,
  );
  const coverageLine = `SCOPED_READ_COVERAGE: ${JSON.stringify(coverage)}`;
  const resultSections = entries.map((entry) => {
    const body = entry.error
      ? `Error: ${entry.error}`
      : truncateToolContent(entry.content || "(no matches)", perTargetBudget);
    return `=== ${entry.sourcePath} ===\n${body}`;
  }).join("\n\n");
  const rawContent = `${coverageLine}\n\n${resultSections}`;
  const modelContent = truncateToolContent(rawContent, budgets.modelChars);
  const displayContent = truncateToolContent(rawContent, budgets.displayChars);
  const additionalContexts = [...new Set(entries.flatMap((entry) => entry.additionalContexts))];
  const scopedReadObservations = successful.map(({ sourcePath, content, negative }) => ({
    sourcePath,
    content,
    negative,
  }));

  if (failed.length > 0) {
    const scope = callbacks.getSubagentScope?.() ?? null;
    const quarantined = allTargetsFailed && scope
      ? recordSubagentScopeBlockedTool(scope, tc.name)
      : false;
    const recoveryGuidance = quarantined
      ? `\n\nSCOPED_READ_EXACT_FALLBACK: all fan-out targets failed for '${tc.name}'. This broad tool is removed for the next child iteration; inspect each still-uncovered allowed file with an exact read_file/read_document/get_file_outline call.`
      : "";
    const failureContent = `${modelContent}${recoveryGuidance}`;
    const failureDisplayContent = `${displayContent}${recoveryGuidance}`;
    callbacks.onToolError(tc.name, target, displayContent, {
      toolCallId: tc.id,
      failureKind: "actual",
    });
    if (quarantined) {
      callbacks.onDebugEvent?.("subagent_scoped_read_fallback", {
        tool: tc.name,
        scopeKey: scope?.scopeKey || null,
        reason: sharedFailure ? "shared_all_target_failure" : "all_target_failure",
        quarantined,
        scopedReadPaths,
      });
    }
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: failureContent,
      displayContent: failureDisplayContent,
      isError: true,
      lifecycleState: successful.length === 0 && failed.every((entry) => entry.blocked)
        ? "blocked"
        : "failed",
      scopedReadCoverage: coverage,
      ...(scopedReadObservations.length > 0 ? { scopedReadObservations } : {}),
      additionalContexts,
    };
  }

  callbacks.onToolDone(tc.name, target, displayContent, { toolCallId: tc.id });
  return {
    toolCallId: tc.id,
    name: tc.name,
    target,
    content: modelContent,
    displayContent,
    isError: false,
    lifecycleState: "completed",
    scopedReadCoverage: coverage,
    scopedReadObservations,
    additionalContexts,
  };
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
  const catalogResolution = options.toolCatalog?.lookup(tc.name);
  const executionName = catalogResolution?.status === "resolved"
    ? catalogResolution.entry.executionName
    : tc.name;
  const catalogIdentity: ToolCatalogIdentity = catalogResolution?.status === "resolved"
    ? {
        source: catalogResolution.entry.source,
        canonicalName: catalogResolution.entry.canonicalName,
      }
    : {
        source: !options.toolCatalog && isBuiltInToolName(tc.name) ? "built_in" : "unknown",
        canonicalName: tc.name,
      };
  let toolArgs: Record<string, unknown>;
  try {
    const parsed = JSON.parse(tc.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool call arguments must be a JSON object.");
    }
    toolArgs = normalizeToolCallForExecution(executionName, parsed as Record<string, unknown>, workspace);
  } catch {
    return {
      toolCallId: tc.id,
      name: tc.name,
      executionName,
      catalogIdentity,
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
    return {
      ...shellReadValidationErrorBeforeContract,
      executionName,
      catalogIdentity,
      executedArgs: toolArgs,
    };
  }

  const scopedReadPaths = [...new Set(
    (options.scopedReadPaths || [])
      .map((path) => String(path || "").trim())
      .filter(Boolean),
  )];
  if (
    scopedReadPaths.length > 1 &&
    SCOPED_READ_FAN_OUT_TOOLS.has(tc.name)
  ) {
    const scopedResult = await executeScopedReadFanOutWithLifecycle({
      tc,
      baseToolArgs: toolArgs,
      scopedReadPaths,
      workspace,
      callbacks,
      allTools,
      hooksConfig,
      options,
    });
    return {
      ...scopedResult,
      executionName,
      catalogIdentity,
      executedArgs: toolArgs,
    };
  }

  // Validate required parameters before execution
  const validationError = validateToolExecutionContract(tc.name, toolArgs, allTools);
  if (validationError) {
    callbacks.onToolError(tc.name, "", validationError, { toolCallId: tc.id, executionName, catalogIdentity });
    return {
      toolCallId: tc.id,
      name: tc.name,
      executionName,
      catalogIdentity,
      executedArgs: toolArgs,
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
  const compatResolved = resolveStudioCompatToolArgs(executionName, effectiveArgs);
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
  const hookArgumentsChanged =
    stableToolArgumentIdentity(toolArgs) !== stableToolArgumentIdentity(effectiveArgs);
  const target = scopedReadPaths.length > 1
    ? scopedReadPaths.join(", ")
    : getToolTarget(executionName, resolvedArgs);

  if (preHookResult.blocked) {
    const reason = preHookResult.blockedReason ?? `${tc.name} was blocked by a PreToolUse hook.`;
    callbacks.onToolError(tc.name, target, reason, { toolCallId: tc.id, executionName, catalogIdentity });
    return {
      toolCallId: tc.id,
      name: tc.name,
      executionName,
      catalogIdentity,
      executedArgs: resolvedArgs,
      target,
      content: `Error: ${reason}`,
      isError: true,
      lifecycleState: "blocked",
      ...(preHookResult.additionalContexts.length > 0
        ? { additionalContexts: preHookResult.additionalContexts }
        : {}),
    };
  }

  const postHookValidationError = validateToolExecutionContract(tc.name, resolvedArgs, allTools);
  if (postHookValidationError) {
    callbacks.onToolError(tc.name, target, postHookValidationError, {
      toolCallId: tc.id,
      executionName,
      catalogIdentity,
    });
    return {
      toolCallId: tc.id,
      name: tc.name,
      executionName,
      catalogIdentity,
      executedArgs: resolvedArgs,
      target,
      content: `Error: ${postHookValidationError}`,
      isError: true,
      lifecycleState: "blocked",
      additionalContexts: [...preHookResult.additionalContexts],
    };
  }

  const finalShellMutationTarget = getShellMutationTargetForLoopGuard(executionName, resolvedArgs);
  if (
    hookArgumentsChanged &&
    callbacks.getCommandDirective?.()?.kind === "file_modify" &&
    finalShellMutationTarget
  ) {
    const message = callbacks.getPreferredLanguage() === "zh"
      ? `PRE_TOOL_USE_SHELL_SOURCE_MUTATION_BLOCKED: PreToolUse 将最终命令改成了写入动作 ${finalShellMutationTarget}。文件修改回合必须使用结构化文件工具；该命令未执行。`
      : `PRE_TOOL_USE_SHELL_SOURCE_MUTATION_BLOCKED: PreToolUse changed the final command into the write action ${finalShellMutationTarget}. File-modification turns must use structured file tools; this command did not run.`;
    callbacks.onToolError(tc.name, target, message, {
      toolCallId: tc.id,
      executionName,
      catalogIdentity,
      failureKind: "policy",
    });
    logAgentEvent("pre_tool_hook_shell_source_mutation_blocked", {
      tool: tc.name,
      executionName,
      target,
      finalShellMutationTarget,
      diskWritten: false,
    });
    return {
      toolCallId: tc.id,
      name: tc.name,
      executionName,
      catalogIdentity,
      executedArgs: resolvedArgs,
      target,
      content: `Error: ${message}`,
      isError: true,
      lifecycleState: "blocked",
      qualityGateReason: "pre_tool_hook_shell_source_mutation_blocked",
      additionalContexts: [...preHookResult.additionalContexts],
    };
  }

  if (hookArgumentsChanged) {
    const argumentAuthorization = resolveToolArgumentAuthorization({
      executionName,
      args: resolvedArgs,
      target,
      isPlanApproved: callbacks.getIsPlanApproved(),
      planTasks: callbacks.getPlanTasks(),
      subagentScope: callbacks.getSubagentScope?.() ?? null,
      threadId: callbacks.getSessionKey(),
      sessionEpoch: callbacks.getTurnRuntimeCheckpoint?.()?.owner.sessionEpoch,
    });
    if (!argumentAuthorization.allowed) {
      const commandScope = argumentAuthorization.approvedPlanCommandScope;
      const mutationScope = argumentAuthorization.approvedPlanMutationScope;
      const childScope = callbacks.getSubagentScope?.() ?? null;
      const message = argumentAuthorization.blockReason === "approved_plan_command_scope"
        ? `PRE_TOOL_USE_APPROVED_PLAN_COMMAND_BLOCKED: the final command '${commandScope.requestedCommand || "<missing>"}' is outside the approved Plan command scope (${commandScope.plannedCommands.join(" | ") || "none"}).`
        : argumentAuthorization.blockReason === "approved_plan_mutation_scope"
        ? `PRE_TOOL_USE_APPROVED_PLAN_SCOPE_BLOCKED: the final mutation target(s) '${mutationScope.unexpectedTargets.join(", ") || mutationScope.requestedTargets.join(", ") || target || "<missing>"}' are outside the approved Plan scope (${mutationScope.plannedTargets.join(", ") || "none"}).`
        : argumentAuthorization.blockReason === "parent_subagent_scope_overlap"
        ? `PRE_TOOL_USE_PARENT_SCOPE_DEFERRED: the final target '${argumentAuthorization.parentScopeConflictTarget || target || "<missing>"}' overlaps the active lease held by ${argumentAuthorization.parentScopeConflict?.subagentId || "an active subagent"} (${argumentAuthorization.parentScopeConflict?.scopeKey || "unknown"}).`
        : `PRE_TOOL_USE_SUBAGENT_SCOPE_BLOCKED: the final target(s) '${argumentAuthorization.blockedSubagentTargets.join(", ") || "<missing>"}' are outside allowed_paths for scope '${childScope?.scopeKey || "unknown"}'.`;
      if (argumentAuthorization.blockReason === "subagent_path_scope" && childScope) {
        recordSubagentScopeBlockedTool(childScope, tc.name);
      }
      callbacks.onToolError(tc.name, target, message, {
        toolCallId: tc.id,
        executionName,
        catalogIdentity,
        failureKind: "policy",
      });
      logAgentEvent("pre_tool_hook_scope_reauthorization_blocked", {
        tool: tc.name,
        executionName,
        target,
        reason: argumentAuthorization.blockReason,
        requestedCommand: commandScope.requestedCommand || null,
        plannedCommands: commandScope.plannedCommands,
        requestedTargets: mutationScope.requestedTargets,
        unexpectedTargets: mutationScope.unexpectedTargets,
        plannedTargets: mutationScope.plannedTargets,
        subagentScopeKey: childScope?.scopeKey || null,
        blockedSubagentTargets: argumentAuthorization.blockedSubagentTargets,
        parentScopeConflictTarget: argumentAuthorization.parentScopeConflictTarget || null,
        conflictingSubagentId: argumentAuthorization.parentScopeConflict?.subagentId || null,
        conflictingScopeKey: argumentAuthorization.parentScopeConflict?.scopeKey || null,
      });
      return {
        toolCallId: tc.id,
        name: tc.name,
        executionName,
        catalogIdentity,
        executedArgs: resolvedArgs,
        target,
        content: `Error: ${message}`,
        isError: true,
        lifecycleState: "blocked",
        qualityGateReason: "pre_tool_hook_scope_reauthorization_blocked",
        ...(mutationScope.applies && !mutationScope.allowed
          ? {
              approvedPlanScopeConflict: {
                requestedTargets: mutationScope.requestedTargets,
                unexpectedTargets: mutationScope.unexpectedTargets,
                plannedTargets: mutationScope.plannedTargets,
              },
            }
          : {}),
        additionalContexts: [...preHookResult.additionalContexts],
      };
    }
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
    return { ...planArtifactValidationError, executionName, catalogIdentity, executedArgs: resolvedArgs };
  }

  const loopDetectionValidationError = buildLoopDetectionValidationError(
    tc,
    resolvedArgs,
    callbacks,
  );
  if (loopDetectionValidationError) {
    return { ...loopDetectionValidationError, executionName, catalogIdentity, executedArgs: resolvedArgs };
  }

  const readBeforeModifyValidationError = await buildReadBeforeModifyValidationError(
    tc,
    resolvedArgs,
    workspace,
    callbacks,
  );
  if (readBeforeModifyValidationError) {
    return { ...readBeforeModifyValidationError, executionName, catalogIdentity, executedArgs: resolvedArgs };
  }

  const unityExecutionContext = isUnityExecutionContext(callbacks);
  if (
    unityExecutionContext &&
    tc.name === "apply_text_edits" &&
    !isUnityApplyTextPrecisePatchArgs(resolvedArgs)
  ) {
    const message = buildUnityApplyTextPolicyBlockedMessage(callbacks.getPreferredLanguage());
    callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id, executionName, catalogIdentity });
    return {
      toolCallId: tc.id,
      name: tc.name,
      executionName,
      catalogIdentity,
      executedArgs: resolvedArgs,
      target,
      content: `Error: ${message}`,
      isError: true,
      lifecycleState: "blocked",
      additionalContexts: [...preHookResult.additionalContexts],
    };
  }

  let effectiveAllowExternalLocalRead = options.allowExternalLocalRead === true;
  let effectiveShellPermissionApproval = options.shellPermissionApproval;
  if (hookArgumentsChanged) {
    const capabilityRegistry = options.toolCapabilityRegistry;
    const finalRisk = getToolRiskLevelForCall(tc.name, resolvedArgs, capabilityRegistry, {
      workspace,
      approvedLocalFileReadPaths: callbacks.getApprovedLocalFileReadPaths(),
    });
    const capability = capabilityRegistry?.tools[tc.name];
    const source = capability?.source ?? "unknown";
    const policy = capabilityRegistry?.policy;
    const finalLocalFileReadPath = getLocalFileReadPathForToolCall(tc.name, resolvedArgs, workspace) || "";
    const shellApprovalResolution = await resolveShellAutoApproval({
      toolName: tc.name,
      args: resolvedArgs,
      workspace,
      preflight: shellPermissionPreflight,
    });

    logAgentEvent("pre_tool_hook_arguments_reauthorized", {
      tool: tc.name,
      executionName,
      target,
      authorizationMode: options.authorizationMode || "unscoped",
      finalRisk,
      source,
      shellCommandChanged: !!shellApprovalResolution.command,
    });

    if (policy?.disabledRiskLevels.includes(finalRisk)) {
      const message = `PRE_TOOL_USE_ARGUMENT_POLICY_BLOCKED: ${tc.name} arguments changed after authorization and the final ${finalRisk} risk is disabled.`;
      callbacks.onToolError(tc.name, target, message, {
        toolCallId: tc.id,
        executionName,
        catalogIdentity,
        failureKind: "policy",
      });
      return {
        toolCallId: tc.id,
        name: tc.name,
        executionName,
        catalogIdentity,
        executedArgs: resolvedArgs,
        target,
        content: `Error: ${message}`,
        isError: true,
        lifecycleState: "blocked",
        additionalContexts: [...preHookResult.additionalContexts],
      };
    }

    if (shellApprovalResolution.decision?.decision === "deny") {
      const message = `PRE_TOOL_USE_ARGUMENT_POLICY_BLOCKED: the final shell command produced by PreToolUse was denied by the shell permission policy.`;
      callbacks.onToolError(tc.name, target, message, {
        toolCallId: tc.id,
        executionName,
        catalogIdentity,
        failureKind: "policy",
      });
      return {
        toolCallId: tc.id,
        name: tc.name,
        executionName,
        catalogIdentity,
        executedArgs: resolvedArgs,
        target,
        content: `Error: ${message}`,
        isError: true,
        lifecycleState: "blocked",
        additionalContexts: [...preHookResult.additionalContexts],
      };
    }

    const automaticallyAuthorized = !!capabilityRegistry && isToolAutoExecutableForCall(
      tc.name,
      resolvedArgs,
      capabilityRegistry,
      policy,
      {
        workspace,
        approvedLocalFileReadPaths: callbacks.getApprovedLocalFileReadPaths(),
      },
    );
    const sessionAuthorized = !!capabilityRegistry && !!policy && isAllowedBySessionAutoApprove(
      finalRisk,
      source,
      callbacks.getAutoApproveToolScopes?.() || [],
      policy,
    );
    const shellAuthorizationCurrent = !shellApprovalResolution.command ||
      canApplyShellAutoReview(shellApprovalResolution);
    const mayContinueWithoutReview =
      options.authorizationMode === "automatic"
        ? automaticallyAuthorized && shellAuthorizationCurrent
        : options.authorizationMode === "session"
        ? (automaticallyAuthorized || sessionAuthorized) && shellAuthorizationCurrent
        : false;

    if (mayContinueWithoutReview) {
      if (finalRisk === "local_file_read" && (automaticallyAuthorized || sessionAuthorized)) {
        effectiveAllowExternalLocalRead = true;
      }
      if (shellApprovalResolution.command) {
        effectiveShellPermissionApproval = shellApprovalResolution.approval;
      }
    } else {
      let decision: ReviewDecision;
      try {
        decision = await callbacks.requestReview({
          toolCallId: tc.id,
          name: tc.name,
          arguments: resolvedArgs,
          risk: finalRisk,
          ...(finalLocalFileReadPath ? { localFileReadPath: finalLocalFileReadPath } : {}),
          ...(shellApprovalResolution.decision
            ? { shellPermissionDecision: shellApprovalResolution.decision }
            : {}),
        });
      } catch {
        callbacks.onStatusChange("idle");
        return {
          toolCallId: tc.id,
          name: tc.name,
          executionName,
          catalogIdentity,
          executedArgs: resolvedArgs,
          target,
          content: "User cancelled approval for the final PreToolUse arguments.",
          isError: true,
          lifecycleState: "declined",
          additionalContexts: [...preHookResult.additionalContexts],
        };
      }
      callbacks.onStatusChange("running");
      if (decision.action !== "accept") {
        const content = decision.action === "reject"
          ? "User rejected the final PreToolUse arguments."
          : `Tool execution failed: ${decision.error}`;
        return {
          toolCallId: tc.id,
          name: tc.name,
          executionName,
          catalogIdentity,
          executedArgs: resolvedArgs,
          target,
          content,
          isError: decision.action !== "reject",
          lifecycleState: decision.action === "reject" ? "declined" : "failed",
          additionalContexts: [...preHookResult.additionalContexts],
        };
      }
      effectiveShellPermissionApproval = decision.shellPermissionApproval;
      if (
        finalLocalFileReadPath &&
        (
          isLocalFileReadApproved(decision.grantLocalFileReadPath || "", [finalLocalFileReadPath]) ||
          isLocalFileReadApproved(finalLocalFileReadPath, callbacks.getApprovedLocalFileReadPaths())
        )
      ) {
        effectiveAllowExternalLocalRead = true;
      }
    }
  }

  const mutationVerificationPath = resolveMutationVerificationPath(executionName, resolvedArgs);
  const shouldCaptureMutationDiff =
    !!mutationVerificationPath &&
    supportsToolDiffPreview(executionName) &&
    !isEphemeralPlanArtifactPath(mutationVerificationPath);
  const mutationBeforeDiffSnapshot = shouldCaptureMutationDiff && mutationVerificationPath
    ? await readMutationDiffSnapshot({
        path: mutationVerificationPath,
        workspace,
        sessionKey,
        allowExternalLocalRead: effectiveAllowExternalLocalRead,
      })
    : null;
  const diffPreview = isEphemeralPlanArtifactMutation(executionName, resolvedArgs)
    ? undefined
    : await buildToolDiffPreview(executionName, resolvedArgs, { workspace, sessionKey });
  callbacks.onToolExecuting(tc.name, target, diffPreview, {
    toolCallId: tc.id,
    executionName,
    catalogIdentity,
  });
  const mutationBeforeMeta = mutationVerificationPath
    ? await readFileMetadataIfAvailable(mutationVerificationPath, workspace)
    : null;

  let executionAttempted = false;
  try {
    executionAttempted = true;
    let subagentSpawnOutcome: SpawnSubagentResult | undefined;
    let rawResult = tc.name === "spawn_subagent"
      ? await (async () => {
          if (!callbacks.runSubagent) {
            throw new Error("Subagent runtime is unavailable for this workflow.");
          }
          const result = await callbacks.runSubagent({
            taskKey: typeof resolvedArgs.task_key === "string"
              ? resolvedArgs.task_key
              : typeof resolvedArgs.taskKey === "string" ? resolvedArgs.taskKey : undefined,
            taskKind: typeof resolvedArgs.task_kind === "string"
              ? resolvedArgs.task_kind as import("./collaborationWorkItems").CollaborationTaskKind
              : typeof resolvedArgs.taskKind === "string"
              ? resolvedArgs.taskKind as import("./collaborationWorkItems").CollaborationTaskKind
              : undefined,
            objective: String(resolvedArgs.objective || ""),
            delegationReason: typeof resolvedArgs.delegation_reason === "string"
              ? resolvedArgs.delegation_reason
              : typeof resolvedArgs.delegationReason === "string" ? resolvedArgs.delegationReason : undefined,
            successCriteria: typeof resolvedArgs.success_criteria === "string"
              ? resolvedArgs.success_criteria
              : typeof resolvedArgs.successCriteria === "string" ? resolvedArgs.successCriteria : undefined,
            name: typeof resolvedArgs.name === "string" ? resolvedArgs.name : undefined,
            role: typeof resolvedArgs.role === "string" ? resolvedArgs.role : undefined,
            scope: typeof resolvedArgs.scope === "string" ? resolvedArgs.scope : undefined,
            allowedPaths: typeof resolvedArgs.allowed_paths === "string"
              ? resolvedArgs.allowed_paths
              : typeof resolvedArgs.allowedPaths === "string" ? resolvedArgs.allowedPaths : undefined,
            requiredPaths: typeof resolvedArgs.required_paths === "string"
              ? resolvedArgs.required_paths
              : typeof resolvedArgs.requiredPaths === "string" ? resolvedArgs.requiredPaths : undefined,
            accessMode: typeof resolvedArgs.access_mode === "string"
              ? resolvedArgs.access_mode as import("./collaborationWorkItems").CollaborationAccessMode
              : typeof resolvedArgs.accessMode === "string"
              ? resolvedArgs.accessMode as import("./collaborationWorkItems").CollaborationAccessMode
              : undefined,
            expectedOutput: typeof resolvedArgs.expected_output === "string"
              ? resolvedArgs.expected_output
              : typeof resolvedArgs.expectedOutput === "string" ? resolvedArgs.expectedOutput : undefined,
            dependsOn: typeof resolvedArgs.depends_on === "string"
              ? resolvedArgs.depends_on
              : typeof resolvedArgs.dependsOn === "string" ? resolvedArgs.dependsOn : undefined,
            independentReviewOf: typeof resolvedArgs.independent_review_of === "string"
              ? resolvedArgs.independent_review_of
              : typeof resolvedArgs.independentReviewOf === "string" ? resolvedArgs.independentReviewOf : undefined,
            goalSliceId: typeof resolvedArgs.goal_slice_id === "string"
              ? resolvedArgs.goal_slice_id
              : typeof resolvedArgs.goalSliceId === "string" ? resolvedArgs.goalSliceId : undefined,
          }, { signal: options.abortSignal });
          subagentSpawnOutcome = result;
          if (
            result.subagentId !== null &&
            (result.status === "queued" || result.status === "running")
          ) {
            await options.onSubagentSpawnCreated?.(result);
          }
          return JSON.stringify(result);
        })()
      : tc.name === "wait_subagents"
        ? await (async () => {
            if (!callbacks.waitSubagents) {
              throw new Error("Subagent wait runtime is unavailable for this workflow.");
            }
            const subagentIds = String(resolvedArgs.subagent_ids || "")
              .split(/[\n,;]+/)
              .map((value) => value.trim())
              .filter(Boolean);
            const collaborationTaskIds = String(resolvedArgs.collaboration_task_ids || "")
              .split(/[\n,;]+/)
              .map((value) => value.trim())
              .filter(Boolean);
            const joined = await callbacks.waitSubagents(
              { subagentIds, collaborationTaskIds },
              { signal: options.abortSignal },
            );
            const unusableFailure = joined.results.find((entry) =>
              entry.status === "failed" &&
              entry.evidence.length === 0 &&
              (!entry.summary.trim() || entry.summary.trim() === String(entry.blocker || entry.error || "").trim())
            );
            if (unusableFailure) {
              throw new Error(unusableFailure.blocker || unusableFailure.error || `Subagent ${unusableFailure.name} failed without usable evidence.`);
            }
            return JSON.stringify(joined);
          })()
        : tc.name === "cancel_subagent"
          ? await (async () => {
              if (!callbacks.cancelSubagent) {
                throw new Error("Subagent cancellation runtime is unavailable for this workflow.");
              }
              const canceled = await callbacks.cancelSubagent({
                subagentId: typeof resolvedArgs.subagent_id === "string"
                  ? resolvedArgs.subagent_id
                  : typeof resolvedArgs.subagentId === "string" ? resolvedArgs.subagentId : undefined,
                collaborationTaskId: typeof resolvedArgs.collaboration_task_id === "string"
                  ? resolvedArgs.collaboration_task_id
                  : typeof resolvedArgs.collaborationTaskId === "string"
                  ? resolvedArgs.collaborationTaskId
                  : undefined,
              });
              return JSON.stringify(canceled);
            })()
      : await executeTool(tc.name, resolvedArgs, workspace, sessionKey, {
            allowExternalLocalRead: effectiveAllowExternalLocalRead,
            shellPermissionApproval: effectiveShellPermissionApproval,
            toolCatalog: options.toolCatalog,
          });
    let resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);

    if (tc.name === "browser_evaluate") {
      const browserOutcome = parseBrowserValidationOutcome(resultStr);
      const browserSucceeded = browserResultLooksSuccessful(resultStr);
      logAgentEvent("browser_validation_result", {
        target,
        ok: browserOutcome?.ok ?? browserSucceeded,
        failureType: browserOutcome?.failureType ?? null,
        failureFingerprint: browserOutcome?.failureFingerprint ?? null,
        blankPage: browserOutcome?.blankPage ?? false,
        screenshotPath: browserOutcome?.screenshotPath ?? null,
        failureReasons: browserOutcome?.failureReasons.slice(0, 8) ?? [],
        failureSummary: browserOutcome?.failureSummary.slice(0, 600) ?? "",
        validationSpecErrorCode: browserOutcome?.validationSpecError?.code ?? null,
        failedSelector:
          browserOutcome?.validationSpecError?.selector ||
          browserOutcome?.failedAction?.selector ||
          null,
        locatorCandidates: browserOutcome?.interactiveElements
          .flatMap((element) => element.selectorCandidates)
          .slice(0, 16) ?? [],
        pageErrorCount: browserOutcome?.pageErrors.length ?? 0,
        consoleErrorCount: browserOutcome?.consoleErrors.length ?? 0,
        failedAssertionCount: browserOutcome?.failedAssertionCount ?? 0,
        durationMs: browserOutcome?.durationMs ?? null,
      });
      if (!browserSucceeded) {
        const cloudProfile = callbacks.getConfig().activeProfile === "cloud";
        const budgets = getToolResultBudgets(tc.name, cloudProfile);
        const failureContent = buildBrowserValidationFailureContent(resultStr);
        const modelFailureContent = truncateToolContent(failureContent, budgets.modelChars);
        const displayFailureContent = truncateToolContent(failureContent, budgets.displayChars);
        callbacks.onToolError(tc.name, target, displayFailureContent, {
          toolCallId: tc.id,
          executionName,
          catalogIdentity,
          executedArgs: resolvedArgs,
          evidenceResult: resultStr,
          failureKind: "actual",
        });
        const postHookResult = await runLifecycleHooks(callbacks, hooksConfig, "PostToolUse", {
          toolName: tc.name,
          toolArgs: resolvedArgs,
          toolResult: resultStr,
          isError: true,
          workspace,
          workflowMode: callbacks.getWorkflowMode(),
          language: callbacks.getPreferredLanguage(),
          associatedPaths: callbacks.getAssociatedPaths(),
        });
        return {
          toolCallId: tc.id,
          name: tc.name,
          executionName,
          catalogIdentity,
          executedArgs: resolvedArgs,
          target,
          content: modelFailureContent,
          displayContent: displayFailureContent,
          isError: true,
          lifecycleState: "failed",
          executionAttempted,
          additionalContexts: [
            ...preHookResult.additionalContexts,
            ...postHookResult.additionalContexts,
          ],
        };
      }
    }

    if (tc.name === "computer_use") {
      const desktopOutcome = resolveStructuredDesktopAutomationOutcome(resultStr, {
        requireCausalInteraction: true,
      });
      let parsedDesktop: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(resultStr);
        parsedDesktop = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        parsedDesktop = null;
      }
      const adapterReportedSuccess = parsedDesktop?.ok === true || parsedDesktop?.success === true;
      logAgentEvent("desktop_control_result", {
        target,
        ok: adapterReportedSuccess,
        verified: desktopOutcome === "verified",
        failureType: String(parsedDesktop?.failureType || "") || null,
        failureSummary: String(parsedDesktop?.failureSummary || parsedDesktop?.error || "").slice(0, 600),
        screenshotPath: String(parsedDesktop?.screenshotPath || "") || null,
        actionCount: Array.isArray(parsedDesktop?.actions) ? parsedDesktop.actions.length : 0,
        assertionCount: Array.isArray(parsedDesktop?.assertions) ? parsedDesktop.assertions.length : 0,
        durationMs: typeof parsedDesktop?.durationMs === "number" ? parsedDesktop.durationMs : null,
      });
      if (!adapterReportedSuccess) {
        const cloudProfile = callbacks.getConfig().activeProfile === "cloud";
        const budgets = getToolResultBudgets(tc.name, cloudProfile);
        const failureContent = `DESKTOP_CONTROL_FAILED:\n${resultStr}`;
        const modelFailureContent = truncateToolContent(failureContent, budgets.modelChars);
        const displayFailureContent = truncateToolContent(failureContent, budgets.displayChars);
        callbacks.onToolError(tc.name, target, displayFailureContent, {
          toolCallId: tc.id,
          executionName,
          catalogIdentity,
          executedArgs: resolvedArgs,
          evidenceResult: resultStr,
          failureKind: "actual",
        });
        const postHookResult = await runLifecycleHooks(callbacks, hooksConfig, "PostToolUse", {
          toolName: tc.name,
          toolArgs: resolvedArgs,
          toolResult: resultStr,
          isError: true,
          workspace,
          workflowMode: callbacks.getWorkflowMode(),
          language: callbacks.getPreferredLanguage(),
          associatedPaths: callbacks.getAssociatedPaths(),
        });
        return {
          toolCallId: tc.id,
          name: tc.name,
          executionName,
          catalogIdentity,
          executedArgs: resolvedArgs,
          target,
          content: modelFailureContent,
          displayContent: displayFailureContent,
          isError: true,
          lifecycleState: "failed",
          executionAttempted,
          additionalContexts: [
            ...preHookResult.additionalContexts,
            ...postHookResult.additionalContexts,
          ],
        };
      }
    }

    // Auto Map-Reduce for large files during read_file
    if (tc.name === "read_file" && resultStr.includes("truncated: true") && !resolvedArgs.start_line) {
      const { summarizeLargeFile } = await import("./summarizeLargeFile");
      const summary = await summarizeLargeFile(
        resolvedArgs.path as string,
        workspace,
        sessionKey,
        callbacks.getConfig(),
      );
      const resolvedSummaryResult = resolveReadFileResultAfterLargeFileSummary(
        resultStr,
        summary,
      );
      if (summary.summarized) {
        resultStr = resolvedSummaryResult;
        rawResult = resolvedSummaryResult;
      } else {
        // Keep the bounded READ_FILE_RESULT envelope. It carries totalLines,
        // returnedLines and nextStartLine, so a model can request a genuinely
        // new window instead of repeating the whole file after raw content is
        // clipped by the generic tool-result character budget.
        logAgentEvent("large_file_summary_skipped", {
          target,
          reason: summary.reason,
          preservedReadWindow: true,
        });
      }
    }

    const mutationAfterMeta = mutationVerificationPath
      ? await readFileMetadataIfAvailable(mutationVerificationPath, workspace)
      : null;
    const mutationAfterDiffSnapshot = shouldCaptureMutationDiff && mutationVerificationPath
      ? await readMutationDiffSnapshot({
          path: mutationVerificationPath,
          workspace,
          sessionKey,
          allowExternalLocalRead: effectiveAllowExternalLocalRead,
        })
      : null;
    const observedMutationDiffPreview = buildMutationDiffPreviewFromSnapshots({
      toolName: executionName,
      target: mutationVerificationPath || target,
      before: mutationBeforeDiffSnapshot,
      after: mutationAfterDiffSnapshot,
    });
    const verifiedNoEffectMutation =
      isWorkspaceMutationToolCall(executionName, resolvedArgs) &&
      isVerifiedNoEffectMutation({
        supportsDiffVerification: supportsToolDiffPreview(executionName),
        beforeDiffSnapshot: mutationBeforeDiffSnapshot,
        afterDiffSnapshot: mutationAfterDiffSnapshot,
        observedDiffPreview: observedMutationDiffPreview,
        result: resultStr,
        beforeMetadata: mutationBeforeMeta,
        afterMetadata: mutationAfterMeta,
      });
    if (
      mutationVerificationPath &&
      verifiedNoEffectMutation
    ) {
      const noEffectMessage = buildNoEffectMutationMessage({
        language: callbacks.getPreferredLanguage(),
        toolName: tc.name,
        target,
        verificationPath: mutationVerificationPath,
        result: resultStr,
      });
      callbacks.onToolError(tc.name, target, noEffectMessage, {
        toolCallId: tc.id,
        executionName,
        catalogIdentity,
        failureKind: "actual",
      });
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
        executionName,
        catalogIdentity,
        executedArgs: resolvedArgs,
        target,
        content: `Error: ${noEffectMessage}`,
        isError: true,
        lifecycleState: "failed",
        executionAttempted,
        workspaceEffect: "none",
        additionalContexts: [
          ...preHookResult.additionalContexts,
          ...postHookResult.additionalContexts,
        ],
      };
    }
    const cloudProfile = callbacks.getConfig().activeProfile === "cloud";
    const budgets = getToolResultBudgets(tc.name, cloudProfile);
    const modelContent = tc.name === "run_command"
      ? compactStructuredCommandResult(resultStr, budgets.modelChars)
      : truncateToolContent(resultStr, budgets.modelChars);
    const displayContent = tc.name === "run_command"
      ? compactStructuredCommandResult(resultStr, budgets.displayChars)
      : truncateToolContent(resultStr, budgets.displayChars);

    if (tc.name === "run_command" && !commandResultLooksSuccessful(tc.name, resultStr)) {
      callbacks.onToolError(tc.name, target, displayContent, {
        toolCallId: tc.id,
        executionName,
        catalogIdentity,
        executedArgs: resolvedArgs,
        evidenceResult: resultStr,
        failureKind: "actual",
      });
      const postHookResult = await runLifecycleHooks(callbacks, hooksConfig, "PostToolUse", {
        toolName: tc.name,
        toolArgs: resolvedArgs,
        toolResult: resultStr,
        isError: true,
        workspace,
        workflowMode: callbacks.getWorkflowMode(),
        language: callbacks.getPreferredLanguage(),
        associatedPaths: callbacks.getAssociatedPaths(),
      });
      return {
        toolCallId: tc.id,
        name: tc.name,
        executionName,
        catalogIdentity,
        executedArgs: resolvedArgs,
        target,
        content: modelContent,
        displayContent,
        isError: true,
        lifecycleState: "failed",
        executionAttempted,
        additionalContexts: [
          ...preHookResult.additionalContexts,
          ...postHookResult.additionalContexts,
        ],
      };
    }

    const planArtifactSyncCallbacks = {
      onPlanArtifactUpdated: callbacks.onPlanArtifactUpdated,
      onPlanTasksUpdated: callbacks.onPlanTasksUpdated,
    };
    const planArtifactSyncOptions = {
      readFile: async (path: string) => {
        const content = await executeTool("read_file", { path, __raw: true }, workspace, sessionKey, {
          allowExternalLocalRead: effectiveAllowExternalLocalRead,
        });
        return String(content ?? "");
      },
      warn: (message: string, error?: unknown) => logAgentEvent("plan_artifact_sync_warn", {
        message,
        error: error instanceof Error ? error.message : String(error || ""),
      }),
    };
    // Resolve the exact bytes written first, but do not publish them to the
    // Plan store until the quality gate below accepts the candidate. A disk
    // write is not proof that a reviewable artifact exists.
    const resolvedPlanArtifactUpdate = await resolvePlanArtifactAfterToolSuccess(
      tc.name,
      resolvedArgs,
      planArtifactSyncOptions,
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
    let planArtifactAccepted = true;

    if (tc.name === "spawn_subagent") {
      try {
        const spawnOutcome = JSON.parse(resultStr) as {
          status?: string;
          reason?: string;
        };
        if (spawnOutcome.status === "deferred") {
          finalQualityGateReason = `subagent_delegation_${spawnOutcome.reason || "deferred"}`;
          isInternalFeedback = true;
        }
      } catch {
        // A non-JSON child result is handled as a normal tool result. The
        // coordinator always emits structured JSON for policy deferrals.
      }
    }

    const path = resolvedPlanArtifactUpdate?.path || (typeof resolvedArgs.path === "string" ? resolvedArgs.path : "");
    const kind = resolvedPlanArtifactUpdate?.kind || (path ? detectPlanArtifactKind(path) : null);
    if (kind && kind !== "summary" && PLAN_ARTIFACT_MUTATION_TOOLS.has(tc.name)) {
      const nextContent = resolvedPlanArtifactUpdate?.content ||
        (typeof resolvedArgs.content === "string" ? resolvedArgs.content : "");
      const validation = kind === "plan"
        ? validateGroundedActionablePlanArtifact({
            content: nextContent,
            recentToolActivity: options.recentPlanToolActivity,
          })
        : validatePlanArtifactContent(nextContent, kind);
      if (!validation.ok) {
        planArtifactAccepted = false;
        const qualityResult = kind === "plan"
          ? validation as PlanArtifactQualityResult
          : null;
        const recoveryAction = qualityResult?.recoveryAction || "rewrite";
        const missingSections = qualityResult?.missingSections || [];
        const decisionFork = kind === "plan" ? analyzePlanDecisionFork(nextContent) : null;
        if (decisionFork?.requiresUserOptions) {
          logAgentEvent("plan_decision_fork_requires_user_input", {
            path,
            kind,
            reason: validation.reason || decisionFork.reason || "decision_fork",
            options: decisionFork.options,
            recommendedDefault: decisionFork.recommendedDefault || null,
            userVisibleDecision: decisionFork.userVisibleDecision === true,
          });
        }
        logAgentEvent("plan_artifact_quality_rejected", {
          path,
          kind,
          tool: tc.name,
          reason: validation.reason || "quality_gate",
          recoveryAction,
          missingSections,
          canAutoRepair: qualityResult?.canAutoRepair ?? false,
          storePublished: false,
          ...(decisionFork ? { decisionFork } : {}),
        });
        callbacks.onPlanArtifactRejected?.(
          path,
          kind,
          validation.reason || "quality_gate",
        );

        const shouldUseInternalFeedback =
          kind === "plan" &&
          !callbacks.getIsPlanApproved();

        const language = callbacks.getPreferredLanguage();
        const recoveryHintZh = recoveryAction === "targeted_evidence"
          ? "这属于证据缺口；runtime 会重新开放一次受限只读补证。下一步只读取一个最相关证据，随后必须输出新的可见计划候选。"
          : recoveryAction === "auto_scaffold"
          ? "这属于低质量草稿；runtime 会给出最小计划脚手架，请按脚手架输出新的可见计划候选。"
          : "这属于结构重写问题；不要继续读文件，直接补齐缺失章节并输出新的可见计划候选。";
        const recoveryHintEn = recoveryAction === "targeted_evidence"
          ? "This is an evidence gap; runtime will reopen one limited read-only recovery pass. Read exactly one relevant evidence target, then output a new visible plan candidate."
          : recoveryAction === "auto_scaffold"
          ? "This is a low-quality draft; runtime will provide a minimal plan scaffold. Output a new visible plan candidate from that scaffold."
          : "This is a structural rewrite issue; do not read more files, add the missing sections and output a new visible plan candidate.";
        const missingHint = missingSections.length > 0
          ? ` missingSections=${missingSections.join(",")};`
          : "";

        const feedbackMessage = language === "zh"
          ? shouldUseInternalFeedback
            ? `[WARNING] 检测到模型直接写入的计划候选 ${path}，但当前内容未达到可审批质量（原因：${validation.reason || "质量不足"}；recovery=${recoveryAction};${missingHint}）。不要继续直接写计划文件；请提交完整 typed graph，并确保每个改动有具体证据引用。${buildPlanSubmissionGuidance("zh")}${recoveryHintZh}`
            : `[WARNING] ${path} 已成功写入并保存到磁盘。但是，其内容不像可审批的正式计划（原因：${validation.reason || "质量不足"}）。`
          : shouldUseInternalFeedback
          ? `[WARNING] A model-authored plan file candidate was detected at ${path}, but it does not meet reviewable quality (${validation.reason || "quality gate"}; recovery=${recoveryAction};${missingHint}). Do not keep writing the plan file directly; submit the complete typed graph with concrete evidence references. ${buildPlanSubmissionGuidance("en")} ${recoveryHintEn}`
          : `[WARNING] ${path} has been successfully written and saved to disk. However, the content does not look like a reviewable plan artifact (${validation.reason || "quality gate"}).`;

        finalContent = `${modelContent}\n\n${feedbackMessage}`;
        finalDisplayContent = `${displayContent}\n\n${feedbackMessage}`;
        finalQualityGateReason = validation.reason || "quality_gate";
        finalPlanRecoveryAction = recoveryAction;
        finalMissingPlanSections = missingSections;
        // A rejected artifact write is runtime control feedback in every
        // workflow state. It may be visible to the model for recovery, but it
        // must never count as user progress or successful execution evidence.
        isInternalFeedback = true;
      }
    }

    if (
      resolvedPlanArtifactUpdate?.kind === "plan" &&
      planArtifactAccepted
    ) {
      const prepared = tc.preparedPlanArtifact;
      const typedCommitMismatch = !prepared ||
        canonicalizePlanArtifactPath(prepared.path) !== resolvedPlanArtifactUpdate.path ||
        prepared.content !== resolvedPlanArtifactUpdate.content ||
        prepared.candidate.state !== "sealed" ||
        prepared.candidate.bundleHash !== prepared.evidenceBundleHash;
      if (typedCommitMismatch) {
        planArtifactAccepted = false;
        isInternalFeedback = true;
        finalQualityGateReason = "typed_plan_commit_authority_missing_or_mismatched";
        finalPlanRecoveryAction = "rewrite";
        const message = callbacks.getPreferredLanguage() === "zh"
          ? "[WARNING] 计划文件虽然已写入磁盘，但其最终字节与写前密封的 typed Plan 权限不一致，因此没有发布到 Session、没有创建审批，也没有替换任务图。请基于当前证据重新输出一个完整可见计划候选。"
          : "[WARNING] The plan file was written, but its final bytes do not match the sealed typed Plan authority prepared before the write. MAIN did not publish it to the Session, create approval, or replace the task graph. Re-emit one complete visible Plan candidate from the current evidence.";
        finalContent = `${finalContent}\n\n${message}`;
        finalDisplayContent = `${finalDisplayContent}\n\n${message}`;
        callbacks.onPlanArtifactRejected?.(
          resolvedPlanArtifactUpdate.path,
          "plan",
          finalQualityGateReason,
        );
        logAgentEvent("plan_artifact_typed_commit_rejected", {
          path: resolvedPlanArtifactUpdate.path,
          tool: tc.name,
          hasPreparedAuthority: !!prepared,
          contentMatches: prepared?.content === resolvedPlanArtifactUpdate.content,
          candidateState: prepared?.candidate.state || null,
          storePublished: false,
        });
      }
    }

    if (resolvedPlanArtifactUpdate && planArtifactAccepted) {
      commitResolvedPlanArtifactUpdate(
        resolvedPlanArtifactUpdate,
        planArtifactSyncCallbacks,
        tc.preparedPlanArtifact
          ? { candidate: tc.preparedPlanArtifact.candidate }
          : undefined,
      );
    }

    const completedTarget = mutationVerificationPath || target;
    const trustedBuiltInMutation =
      catalogIdentity.source === "built_in" &&
      BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES.has(executionName) &&
      isWorkspaceMutationToolCall(executionName, resolvedArgs);
    // A proposed built-in diff can be accepted after its trusted executor
    // completes. MCP/Skill tools must contribute an observed before/after diff;
    // sharing an executionName with a built-in editor grants no trust.
    const completedDiffPreview = observedMutationDiffPreview ||
      (trustedBuiltInMutation ? diffPreview : undefined);
    const mutationChangedPaths = observedMutationDiffPreview?.path
      ? [observedMutationDiffPreview.path]
      : trustedBuiltInMutation
      ? resolveWorkspaceMutationTargets(executionName, resolvedArgs, completedTarget)
      : [];
    const workspaceMutationEvidence = mutationChangedPaths.length > 0
      ? {
          changedPaths: [...new Set(mutationChangedPaths)],
          ...(completedDiffPreview ? { diff: completedDiffPreview } : {}),
        }
      : undefined;
    callbacks.onToolDone(tc.name, completedTarget, finalDisplayContent, {
      ...(
        tc.name === "browser_evaluate"
          ? { evidenceResult: resultStr }
          : tc.name === "computer_use" || tc.name === "run_command" || tc.name === "apply_patch"
          ? { evidenceResult: resultStr }
          : {}
      ),
      toolCallId: tc.id,
      executionName,
      catalogIdentity,
      executedArgs: resolvedArgs,
      diff: completedDiffPreview,
      ...(isInternalFeedback ? { internalFeedback: true } : {}),
      ...(finalQualityGateReason ? { qualityGateReason: finalQualityGateReason } : {}),
    });
    return {
      toolCallId: tc.id,
      name: tc.name,
      executionName,
      catalogIdentity,
      executedArgs: resolvedArgs,
      target: completedTarget,
      content: finalContent,
      displayContent: finalDisplayContent,
      ...(tc.name === "wait_subagents" ? { runtimeEvidenceContent: resultStr } : {}),
      isError: false,
      ...(subagentSpawnOutcome ? { subagentSpawnOutcome } : {}),
      lifecycleState: "completed",
      executionAttempted,
      ...(workspaceMutationEvidence ? { workspaceEffect: "verified" as const } : {}),
      ...(workspaceMutationEvidence ? { workspaceMutationEvidence } : {}),
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
    const failedMutationAfterSnapshot = executionAttempted && shouldCaptureMutationDiff && mutationVerificationPath
      ? await readMutationDiffSnapshot({
          path: mutationVerificationPath,
          workspace,
          sessionKey,
          allowExternalLocalRead: effectiveAllowExternalLocalRead,
        })
      : null;
    const failedMutationDiff = buildMutationDiffPreviewFromSnapshots({
      toolName: executionName,
      target: mutationVerificationPath || target,
      before: mutationBeforeDiffSnapshot,
      after: failedMutationAfterSnapshot,
    });
    const failedMutationEvidence = failedMutationDiff?.path
      ? { changedPaths: [failedMutationDiff.path], diff: failedMutationDiff }
      : undefined;
    if (
      (tc.name === "execute_command" || tc.name === "send_pty_input") &&
      /^PTY_[A-Z_]+:/.test(errorMsg)
    ) {
      logAgentEvent("pty_command_runtime_error", {
        tool: tc.name,
        target,
        code: errorMsg.split(":", 1)[0],
        message: errorMsg.slice(0, 1_000),
        sessionKey,
      });
    }
    if (isOptionalTasksMdRead(tc.name, target) && isMissingOptionalTasksMdReadError(errorMsg)) {
      const optionalMessage = buildOptionalTasksMdMissingResult(callbacks.getPreferredLanguage(), target);
      callbacks.onToolDone(tc.name, target, optionalMessage, {
        toolCallId: tc.id,
        executionName,
        catalogIdentity,
      });
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
        executionName,
        catalogIdentity,
        executedArgs: resolvedArgs,
        target,
        content: optionalMessage,
        displayContent: optionalMessage,
        isError: false,
        lifecycleState: "completed",
        executionAttempted,
        ...(isWorkspaceMutationToolCall(executionName, resolvedArgs)
          ? { workspaceEffect: failedMutationEvidence ? "partial" as const : "possible" as const }
          : {}),
        ...(failedMutationEvidence ? { workspaceMutationEvidence: failedMutationEvidence } : {}),
        additionalContexts: [
          ...preHookResult.additionalContexts,
          ...postHookResult.additionalContexts,
        ],
      };
    }
    callbacks.onToolError(tc.name, target, errorMsg, {
      toolCallId: tc.id,
      executionName,
      catalogIdentity,
      executedArgs: resolvedArgs,
      evidenceResult: errorMsg,
      ...(failedMutationDiff ? { diff: failedMutationDiff } : {}),
      ...(failedMutationEvidence ? { workspaceMutationEvidence: failedMutationEvidence } : {}),
      failureKind: "actual",
    });
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
      executionName,
      catalogIdentity,
      executedArgs: resolvedArgs,
      target,
      content: `Error: ${errorMsg}`,
      isError: true,
      lifecycleState: "failed",
      executionAttempted,
      ...(isWorkspaceMutationToolCall(executionName, resolvedArgs)
        ? { workspaceEffect: failedMutationEvidence ? "partial" as const : "possible" as const }
        : {}),
      ...(failedMutationEvidence ? { workspaceMutationEvidence: failedMutationEvidence } : {}),
      additionalContexts: [
        ...preHookResult.additionalContexts,
        ...postHookResult.additionalContexts,
      ],
    };
  }
}

function assessPlanMaterializationReadiness(input: {
  userGoal: string;
  recentToolActivity: PlanToolActivitySummary[];
  turnContext?: TurnInputContextSignals;
  hasGroundedVisualContext: boolean;
}): {
  ready: boolean;
  status: ReturnType<typeof assessPlanEvidenceReadiness>["status"];
  reason: string;
  obligations: ReturnType<typeof derivePlanEvidenceObligations>;
  rejectionReason: string;
} {
  const readiness = assessPlanEvidenceReadiness({
    userGoal: input.userGoal,
    userContext: input.turnContext,
    recentToolActivity: input.recentToolActivity,
    hasGroundedVisualContext: input.hasGroundedVisualContext,
  });
  const obligations = derivePlanEvidenceObligations({
    objective: input.userGoal,
    activities: input.recentToolActivity,
  });
  const rejectionReason = obligations.length > 0
    ? `unverified_plan_contract_counterpart:${obligations.map(formatPlanEvidenceObligation).join(",")}`
    : `insufficient_grounded_evidence:${readiness.reason}`;
  return {
    ready: readiness.status === "ready_for_plan",
    status: readiness.status,
    reason: readiness.reason,
    obligations,
    rejectionReason,
  };
}

export async function autoMaterializePlanArtifactFromVisibleText(input: {
  visibleText: string;
  workspace: string;
  callbacks: OrchestratorCallbacks;
  userGoal?: string;
  recentToolActivity?: PlanToolActivitySummary[];
  attemptedTargets?: string[];
  turnContext?: TurnInputContextSignals;
  candidateRepairCheckpoint?: PlanCandidateRepairCheckpoint | null;
}): Promise<PlanMaterializationResultForLoop> {
  const closureInput = collectPlanClosureMaterializationInput(
    input.callbacks,
    input.recentToolActivity || [],
    input.attemptedTargets || [],
    input.userGoal || "",
  );
  // A complete typed candidate owns its own graph/evidence validation. Parse it
  // before legacy readiness inference so a valid decision-only Plan (or an
  // invalid typed field) cannot be hidden behind a prose/read heuristic. The
  // fallback path remains fail-closed on the existing readiness gate.
  const hasTypedCandidate = hasTypedPlanDraftEnvelope(input.visibleText);
  const planReadiness = assessPlanMaterializationReadiness({
    userGoal: closureInput.userGoal || getOriginalUserPromptForPlanFallback(input.callbacks),
    recentToolActivity: input.recentToolActivity || [],
    turnContext: input.turnContext,
    hasGroundedVisualContext: hasPlanVisualContextGrounding(
      input.callbacks.getMessages() as AgentMessage[],
      input.callbacks.getCurrentTurnId?.(),
    ),
  });
  if (!hasTypedCandidate && !planReadiness.ready) {
    logAgentEvent("plan_visible_materialization_rejected", {
      reason: planReadiness.rejectionReason,
      evidenceReadiness: planReadiness.status,
      evidenceReadinessReason: planReadiness.reason,
      evidenceObligations: planReadiness.obligations.map(formatPlanEvidenceObligation),
      evidenceBundleId: closureInput.evidenceBundle.bundleId,
      evidenceBundleHash: closureInput.evidenceBundle.hash,
    });
    return {
      ok: false,
      reason: planReadiness.rejectionReason,
      quality: classifyPlanArtifactQualityResult({
        ok: false,
        reason: planReadiness.rejectionReason,
      }),
    };
  }
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
    evidenceBundle: closureInput.evidenceBundle,
    expectedEvidenceBundleHash: closureInput.evidenceBundle.hash,
    ingressMode: "typed_runtime",
    candidateRepairCheckpoint: input.candidateRepairCheckpoint,
  });

  if (!materialized.ok || !materialized.path || !materialized.content || !materialized.kind) {
    logAgentEvent("plan_visible_materialization_rejected", {
      reason: materialized.reason || "quality_gate",
      failureStage: materialized.quality?.failureStage || null,
      failurePreview: materialized.quality?.failurePreview || null,
      replyOptions: materialized.replyOptions?.length || 0,
      decisionFork: materialized.decisionFork || null,
      evidenceBundleId: closureInput.evidenceBundle.bundleId,
      evidenceBundleHash: closureInput.evidenceBundle.hash,
      semanticFacts: closureInput.evidenceBundle.facts.length,
      changeTargets: closureInput.evidenceBundle.changeTargets.length,
    });
    return {
      ok: false,
      reason: materialized.reason || "quality_gate",
      quality: materialized.quality,
      replyOptions: materialized.replyOptions,
      candidateRepairCheckpoint: materialized.candidateRepairCheckpoint,
      candidateRepairExhausted: materialized.candidateRepairExhausted,
    };
  }

  const prepared = await prepareExecutablePlanCandidate({
    materialized,
    workspace: input.workspace,
    callbacks: input.callbacks,
  });
  if (!prepared.ok || !prepared.path || !prepared.content || !prepared.kind) {
    logAgentEvent("plan_visible_materialization_rejected", {
      reason: prepared.reason || "executable_validation_task_missing",
      failureStage: prepared.quality?.failureStage || null,
      failurePreview: prepared.quality?.failurePreview || null,
      evidenceBundleId: closureInput.evidenceBundle.bundleId,
      evidenceBundleHash: closureInput.evidenceBundle.hash,
    });
    return {
      ok: false,
      reason: prepared.reason || "executable_validation_task_missing",
      quality: prepared.quality,
      replyOptions: materialized.replyOptions,
    };
  }

  return writeMaterializedPlanArtifact({
    materialized: prepared,
    workspace: input.workspace,
    callbacks: input.callbacks,
    toolCallPrefix: "plan_materialize",
  });
}

/**
 * Materialize a runtime-owned Plan artifact from already-sanitized, concrete
 * evidence. This is intentionally separate from the model-visible recovery
 * prompt: an "auto scaffold" must either produce and validate a real artifact
 * or report a precise rejection, rather than silently launching another
 * unbounded model rewrite.
 */
export async function autoMaterializePlanArtifactFromEvidence(input: {
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
  const planReadiness = assessPlanMaterializationReadiness({
    userGoal: closureInput.userGoal || getOriginalUserPromptForPlanFallback(input.callbacks),
    recentToolActivity: input.recentToolActivity || [],
    turnContext: input.turnContext,
    hasGroundedVisualContext: hasPlanVisualContextGrounding(
      input.callbacks.getMessages() as AgentMessage[],
      input.callbacks.getCurrentTurnId?.(),
    ),
  });
  const hasBundleEvidence = isPlanEvidenceBundleReady(closureInput.evidenceBundle);
  const closureAssessment = assessPlanClosureEvidence(closureInput.evidenceBundle);
  const hasDeterministicEvidence = planReadiness.ready &&
    hasDeterministicPlanMaterializationEvidence(
      closureInput.evidenceBundle,
    );
  if (!planReadiness.ready || !hasBundleEvidence || !hasDeterministicEvidence) {
    const rejectionReason = !planReadiness.ready
      ? planReadiness.rejectionReason
      : !hasBundleEvidence
      ? "insufficient_relevant_plan_evidence"
      : closureAssessment.unresolvedContractKinds.length > 0
        ? `unverified_plan_contract_counterpart:${closureAssessment.unresolvedContractKinds.join(",")}`
        : closureAssessment.ready
          ? "insufficient_facet_specific_diagnostic_evidence"
          : "insufficient_diagnostic_plan_evidence";
    logAgentEvent("plan_evidence_materialization_rejected", {
      reason: rejectionReason,
      evidenceCount: closureInput.evidence.length,
      structuredEvidenceCount: closureInput.evidenceRecords.length,
      fileCount: closureInput.files.length,
      sanitizerDropped: closureInput.sanitizer.dropped,
      sanitizerDropReasons: closureInput.sanitizer.dropReasons,
      evidenceBundleId: closureInput.evidenceBundle.bundleId,
      evidenceBundleHash: closureInput.evidenceBundle.hash,
      bundleReady: hasBundleEvidence,
      closureReady: hasDeterministicEvidence,
      rationaleReady: closureAssessment.ready,
      deterministicMaterializationReady: hasDeterministicEvidence,
      evidenceReadiness: planReadiness.status,
      evidenceReadinessReason: planReadiness.reason,
      evidenceObligations: planReadiness.obligations.map(formatPlanEvidenceObligation),
      closureReason: closureAssessment.reason,
      objectiveTargetMatches: closureAssessment.objectiveTargetMatches,
      defectSignalMatches: closureAssessment.defectSignalMatches,
      contractMismatchMatches: closureAssessment.contractMismatchMatches,
      contractMismatchKinds: closureAssessment.contractMismatchKinds,
      unresolvedContractKinds: closureAssessment.unresolvedContractKinds,
      semanticFacts: closureInput.evidenceBundle.facts.length,
      changeTargets: closureInput.evidenceBundle.changeTargets.length,
    });
    return {
      ok: false,
      reason: rejectionReason,
      quality: classifyPlanArtifactQualityResult({
        ok: false,
        reason: rejectionReason,
      }),
    };
  }
  const language = input.callbacks.getPreferredLanguage();
  const objective = closureInput.userGoal || getOriginalUserPromptForPlanFallback(input.callbacks);
  const authoringContract = createPlanAuthoringContract({
    objective,
    contextSignals: normalizeTurnInputContextSignals(input.turnContext || {}),
    recentPlanToolActivity: input.recentToolActivity,
  });
  const diagnosisText = closureAssessment.contractMismatchKinds.length > 0
    ? `${language === "zh" ? "已确认运行时契约不一致" : "Confirmed runtime contract mismatch"}: ${closureAssessment.contractMismatchKinds.join(", ")}`
    : `${language === "zh" ? "已确认的证据依据" : "Confirmed evidence-backed rationale"}: ${closureInput.evidenceBundle.facts.map((fact) => fact.summary).join("; ")}`;
  const typed = createRuntimeSynthesizedPlanCandidate({
    bundle: closureInput.evidenceBundle,
    authoringContract,
    language,
    validationCommands: closureInput.evidenceBundle.verificationTargets,
    diagnosisText,
  });
  const materialized: PlanMaterializationResult = typed.ok
    ? {
        ok: true,
        kind: "plan",
        path: ".MAIN/plans/plan.md",
        content: typed.candidate.projection.content,
        source: "deterministic_evidence",
        evidenceBundleHash: closureInput.evidenceBundle.hash,
        candidate: typed.candidate,
        replyOptions: [],
      }
    : {
        ok: false,
        reason: `typed_plan_ingress_invalid:${typed.failures.join(",")}`,
      };

  if (!materialized.ok || !materialized.path || !materialized.content || !materialized.kind) {
    logAgentEvent("plan_evidence_materialization_rejected", {
      reason: materialized.reason || "quality_gate",
      evidenceCount: closureInput.evidence.length,
      structuredEvidenceCount: closureInput.evidenceRecords.length,
      fileCount: closureInput.files.length,
      sanitizerDropped: closureInput.sanitizer.dropped,
      sanitizerDropReasons: closureInput.sanitizer.dropReasons,
      evidenceBundleId: closureInput.evidenceBundle.bundleId,
      evidenceBundleHash: closureInput.evidenceBundle.hash,
      semanticFacts: closureInput.evidenceBundle.facts.length,
      changeTargets: closureInput.evidenceBundle.changeTargets.length,
    });
    return {
      ok: false,
      reason: materialized.reason || "quality_gate",
      quality: materialized.quality,
    };
  }

  const prepared = await prepareExecutablePlanCandidate({
    materialized,
    workspace: input.workspace,
    callbacks: input.callbacks,
  });
  if (!prepared.ok || !prepared.path || !prepared.content || !prepared.kind) {
    logAgentEvent("plan_evidence_materialization_rejected", {
      reason: prepared.reason || "executable_validation_task_missing",
      evidenceBundleId: closureInput.evidenceBundle.bundleId,
      evidenceBundleHash: closureInput.evidenceBundle.hash,
    });
    return {
      ok: false,
      reason: prepared.reason || "executable_validation_task_missing",
      quality: prepared.quality,
    };
  }

  logAgentEvent("plan_evidence_materialization_ready", {
    path: prepared.path,
    kind: prepared.kind,
    source: prepared.source || "deterministic_evidence",
    evidenceCount: closureInput.evidence.length,
    structuredEvidenceCount: closureInput.evidenceRecords.length,
    fileCount: closureInput.files.length,
    evidenceBundleId: closureInput.evidenceBundle.bundleId,
    evidenceBundleHash: closureInput.evidenceBundle.hash,
  });
  return writeMaterializedPlanArtifact({
    materialized: prepared,
    workspace: input.workspace,
    callbacks: input.callbacks,
    toolCallPrefix: "plan_evidence_materialize",
  });
}

/**
 * Execute read-only tools concurrently.
 * From claude-code-haha's toolOrchestration.ts: safe tools can run in parallel.
 */
export async function executeReadOnlyToolsConcurrently(
  toolCalls: Array<ToolCallToExecute & {
    allowExternalLocalRead?: boolean;
    authorizationMode?: ExecuteToolLifecycleOptions["authorizationMode"];
    scopedReadPaths?: string[];
  }>,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
  options: Pick<ExecuteToolLifecycleOptions, "abortSignal" | "turnContext" | "recentPlanToolActivity" | "attemptedPlanWriteTargets" | "toolCatalog" | "toolCapabilityRegistry" | "authorizationMode" | "onSubagentSpawnCreated"> = {},
): Promise<ToolExecutionResult[]> {
  const execute = (tc: typeof toolCalls[number]) =>
    executeToolCallWithLifecycle(tc, workspace, callbacks, allTools, hooksConfig, {
      allowExternalLocalRead: tc.allowExternalLocalRead === true,
      scopedReadPaths: tc.scopedReadPaths,
      abortSignal: options.abortSignal,
      turnContext: options.turnContext,
      recentPlanToolActivity: options.recentPlanToolActivity,
      attemptedPlanWriteTargets: options.attemptedPlanWriteTargets,
      toolCatalog: options.toolCatalog,
      toolCapabilityRegistry: options.toolCapabilityRegistry,
      onSubagentSpawnCreated: options.onSubagentSpawnCreated,
      authorizationMode: tc.authorizationMode || options.authorizationMode || "automatic",
    });
  const indexedCalls = toolCalls.map((tc, index) => ({ tc, index }));
  const registrationCalls = indexedCalls.filter(({ tc }) => tc.name !== "wait_subagents");
  const waitCalls = indexedCalls.filter(({ tc }) => tc.name === "wait_subagents");
  const resultsByIndex = new Map<number, ToolExecutionResult>();
  const hooksCanRequestReview = hooksConfig.hooks.PreToolUse.some((hook) => hook.enabled);
  const executeRegistrationCalls = async () => {
    if (hooksCanRequestReview) {
      for (const { tc, index } of registrationCalls) {
        resultsByIndex.set(index, await execute(tc));
      }
      return;
    }
    const results = await Promise.all(registrationCalls.map(({ tc }) => execute(tc)));
    results.forEach((result, resultIndex) => {
      resultsByIndex.set(registrationCalls[resultIndex].index, result);
    });
  };

  // A hook can promote an otherwise read-only call into a reviewed action.
  // Serialize hook-bearing calls so pending-review ownership cannot be
  // overwritten by a second concurrent request. A same-response
  // wait_subagents is also held behind every spawn/registration call; the
  // model cannot race its join against children that are not registered yet.
  await executeRegistrationCalls();
  if (waitCalls.length > 0) {
    logAgentEvent("subagent_wait_registration_barrier", {
      spawnCalls: registrationCalls.filter(({ tc }) => tc.name === "spawn_subagent").length,
      waitCalls: waitCalls.length,
    });
    for (const { tc, index } of waitCalls) {
      resultsByIndex.set(index, await execute(tc));
    }
  }
  return indexedCalls.map(({ index }) => resultsByIndex.get(index) as ToolExecutionResult);
}

export async function executeLocalFileReadToolWithReview(
  tc: ToolCallToExecute,
  toolArgs: Record<string, unknown>,
  localFileReadPath: string,
  workspace: string,
  callbacks: OrchestratorCallbacks,
  allTools: ToolDefinition[],
  hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>>,
  options: Pick<ExecuteToolLifecycleOptions, "toolCatalog" | "toolCapabilityRegistry"> = {},
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
      {
        allowExternalLocalRead,
        toolCatalog: options.toolCatalog,
        toolCapabilityRegistry: options.toolCapabilityRegistry,
        authorizationMode: "user",
      },
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
  reason:
    | "pre_approval_plan_artifact_write"
    | "pre_approval_source_write"
    | "pre_approval_tasks"
    | "missing_tasks_before_source",
): ToolExecutionResult {
  const target = getToolTarget(tc.name, toolArgs);
  const language = callbacks.getPreferredLanguage();
  const baseMessage = language === "zh"
    ? reason === "pre_approval_plan_artifact_write"
      ? "`.MAIN/plans/plan.md` 是 runtime 拥有的审批投影，模型在 PLAN 阶段不得直接创建、替换或增量编辑。请提交完整 typed graph，由 runtime 校验、封存并单向渲染。"
      : reason === "pre_approval_tasks"
      ? "PLAN 阶段尚未批准，不能提前生成 `.MAIN/plans/tasks.md`。请先提交完整 typed graph，由 runtime 渲染 plan.md 并等待用户批准。"
      : reason === "missing_tasks_before_source"
      ? "计划已批准，但还没有可执行的任务清单。请先从 plan.md 派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再按任务修改源码或交付文档。"
      : "PLAN 阶段尚未批准，不能修改源码或项目交付文件。请提交完整 typed graph，由 MAIN runtime 校验并渲染 `.MAIN/plans/plan.md`。"
    : reason === "pre_approval_plan_artifact_write"
    ? "`.MAIN/plans/plan.md` is a runtime-owned review projection; the model must not create, replace, or incrementally edit it during PLAN authoring. Submit one complete typed graph for the runtime to validate, seal, and render."
    : reason === "pre_approval_tasks"
    ? "PLAN mode is not approved yet, so `.MAIN/plans/tasks.md` must not be generated. Submit the complete typed graph for runtime rendering and wait for approval."
    : reason === "missing_tasks_before_source"
    ? "The plan is approved, but there is no executable task list yet. First derive a runtime task list from plan.md; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs before editing source or final deliverables."
    : "PLAN mode is not approved yet, so source or deliverable files cannot be modified. Submit the complete typed graph for MAIN runtime to validate and render as `.MAIN/plans/plan.md`.";
  const message = reason === "missing_tasks_before_source"
    ? baseMessage
    : `${baseMessage}\n${buildPlanSubmissionGuidance(language)}`;

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

function buildPlanArtifactQualityPreflightRejection(input: {
  tc: ToolCallToExecute;
  target: string;
  path: string;
  kind: "plan" | "requirements" | "design" | "tasks" | "bugfix";
  callbacks: OrchestratorCallbacks;
  validation: {
    ok: boolean;
    reason?: string;
    recoveryAction?: PlanArtifactRecoveryAction;
    missingSections?: string[];
  };
}): ToolExecutionResult {
  const { tc, target, path, kind, callbacks, validation } = input;
  const language = callbacks.getPreferredLanguage();
  const reason = validation.reason || "quality_gate";
  const recoveryAction = validation.recoveryAction || "rewrite";
  const missingSections = validation.missingSections || [];
  const missingHint = missingSections.length > 0
    ? ` missingSections=${missingSections.join(",")};`
    : "";
  const message = language === "zh"
    ? `PLAN_ARTIFACT_QUALITY_REJECTED_BEFORE_WRITE: ${path} 未通过质量门（原因：${reason}；recovery=${recoveryAction};${missingHint}）。候选内容没有写入磁盘，原有文件、任务状态和审批身份保持不变。请根据反馈修正候选后重试；只有真实产品/范围/技术决策阻塞时才询问用户。`
    : `PLAN_ARTIFACT_QUALITY_REJECTED_BEFORE_WRITE: ${path} failed the quality gate (${reason}; recovery=${recoveryAction};${missingHint}). The candidate was not written, so the existing file, task state, and approval identity remain unchanged. Correct the candidate and retry; ask the user only for a genuinely blocking product, scope, or technology decision.`;

  callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
  callbacks.onToolDone(tc.name, target, message, {
    toolCallId: tc.id,
    internalFeedback: true,
    qualityGateReason: reason,
  });
  logAgentEvent("plan_artifact_quality_rejected", {
    path,
    kind,
    tool: tc.name,
    reason,
    recoveryAction,
    missingSections,
    canAutoRepair: false,
    diskWritten: false,
    storePublished: false,
  });
  return {
    toolCallId: tc.id,
    name: tc.name,
    target,
    content: message,
    displayContent: message,
    isError: false,
    lifecycleState: "completed",
    internalFeedback: true,
    qualityGateReason: reason,
    planRecoveryAction: recoveryAction,
    ...(missingSections.length > 0 ? { missingPlanSections: missingSections } : {}),
  };
}

export async function buildPlanArtifactMutationValidationError(
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
  const protectedMutation = getProtectedPlanArtifactMutationViolation(
    tc.name,
    args,
    callbacks.getPreferredLanguage(),
  );
  if (protectedMutation) {
    callbacks.onToolExecuting(tc.name, protectedMutation.target, undefined, { toolCallId: tc.id });
    callbacks.onToolDone(tc.name, protectedMutation.target, protectedMutation.message, {
      toolCallId: tc.id,
      internalFeedback: true,
      qualityGateReason: protectedMutation.reason,
    });
    logAgentEvent("plan_artifact_protected_mutation_blocked", {
      tool: tc.name,
      target: protectedMutation.target,
      reason: protectedMutation.reason,
      diskWritten: false,
      storePublished: false,
    });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target: protectedMutation.target,
      content: protectedMutation.message,
      displayContent: protectedMutation.message,
      isError: false,
      lifecycleState: "completed",
      internalFeedback: true,
      qualityGateReason: protectedMutation.reason,
      planRecoveryAction: "rewrite",
    };
  }
  if (tc.name === "apply_patch") {
    const parsed = parseApplyPatch(typeof args.patch === "string" ? args.patch : "");
    if (!parsed.ok) return null;
    const planTargets = parsed.operations.flatMap((operation) =>
      [operation.path, operation.newPath || ""].filter((path) => {
        const kind = path ? detectPlanArtifactKind(path) : null;
        return !!kind && kind !== "summary";
      })
    );
    if (planTargets.length === 0) return null;

    const target = planTargets.join(", ");
    const message = callbacks.getPreferredLanguage() === "zh"
      ? `PLAN_ARTIFACT_PATCH_REQUIRES_SINGLE_FILE_MUTATION: apply_patch 不能修改 ${target}。计划产物必须使用 write_file 或 replace_in_file 单文件更新，以便 MAIN 在任何磁盘、Store、revision 或批准状态变化前计算并校验最终内容。本次补丁未执行；若补丁还包含源码修改，请拆分后重试。`
      : `PLAN_ARTIFACT_PATCH_REQUIRES_SINGLE_FILE_MUTATION: apply_patch cannot modify ${target}. Plan artifacts must be updated with a single-file write_file or replace_in_file call so MAIN can compute and validate the final content before any disk, Store, revision, or approval-state mutation. This patch was not executed; split out any source changes and retry.`;
    callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
    callbacks.onToolDone(tc.name, target, message, {
      toolCallId: tc.id,
      internalFeedback: true,
      qualityGateReason: "plan_artifact_patch_requires_single_file_mutation",
    });
    logAgentEvent("plan_artifact_patch_preflight_blocked", {
      tool: tc.name,
      paths: planTargets,
      diskWritten: false,
      storePublished: false,
    });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: message,
      displayContent: message,
      isError: false,
      lifecycleState: "completed",
      internalFeedback: true,
      qualityGateReason: "plan_artifact_patch_requires_single_file_mutation",
      planRecoveryAction: "rewrite",
    };
  }
  if (tc.name !== "write_file" && tc.name !== "replace_in_file") return null;

  const path = typeof args.path === "string" ? args.path : "";
  const kind = path ? detectPlanArtifactKind(path) : null;
  if (!kind || kind === "summary") return null;

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

  if (nextContent == null) {
    const target = getToolTarget(tc.name, args);
    const message = callbacks.getPreferredLanguage() === "zh"
      ? `PLAN_ARTIFACT_PREFLIGHT_UNAVAILABLE: 无法在写入前计算 ${path} 的最终内容，本次修改未执行。请重新读取精确文件内容后再提交局部替换。`
      : `PLAN_ARTIFACT_PREFLIGHT_UNAVAILABLE: MAIN could not compute the final ${path} content before writing, so the mutation was not executed. Read the exact current content and retry the targeted replacement.`;
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

  const language = callbacks.getPreferredLanguage();
  const target = getToolTarget(tc.name, args);

  let validation = kind === "plan"
      ? validateGroundedActionablePlanArtifact({
          content: nextContent,
          recentToolActivity: options.recentToolActivity,
        })
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
        ingressMode: "legacy_markdown_import",
      });
      if (canonicalized.ok && canonicalized.content) {
        const canonicalValidation = validateGroundedActionablePlanArtifact({
          content: canonicalized.content,
          recentToolActivity: options.recentToolActivity,
        });
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
        const repairedValidation = validateGroundedActionablePlanArtifact({
          content: repaired.content,
          recentToolActivity: options.recentToolActivity,
        });
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
  let manifestRepairedPlanCandidate: ExecutablePlanCandidatePreparation | null = null;
  if (
    kind === "plan" &&
    !validation.ok &&
    /(?:^|:)non_executable_test_plan(?:$|:)/i.test(validation.reason || "")
  ) {
    // A trusted workspace manifest may supply the exact finite validation
    // command that model prose omitted. Attempt that provider-neutral repair
    // before rejecting the write, then rerun the complete grounded quality
    // gate so an executable command cannot mask evidence or scope defects.
    const prepared = await prepareExecutablePlanCandidate({
      materialized: {
        ok: true,
        kind: "plan",
        path,
        content: nextContent,
        source: "visible_plan",
      },
      workspace,
      callbacks,
    });
    if (prepared.ok && prepared.content) {
      const repairedValidation = validateGroundedActionablePlanArtifact({
        content: prepared.content,
        recentToolActivity: options.recentToolActivity,
      });
      if (repairedValidation.ok) {
        nextContent = prepared.content;
        validation = repairedValidation;
        manifestRepairedPlanCandidate = prepared;
      }
    }
  }
  if (!validation.ok) {
    return buildPlanArtifactQualityPreflightRejection({
      tc,
      target,
      path,
      kind,
      callbacks,
      validation,
    });
  }

  if (kind === "plan") {
    const closureInput = collectPlanClosureMaterializationInput(
      callbacks,
      options.recentToolActivity || [],
      options.attemptedTargets || [],
    );
    const materialized = materializePlanArtifactFromVisibleText({
      visibleText: manifestRepairedPlanCandidate?.content || nextContent,
      planStage: callbacks.getPlanStage(),
      sourceHint: manifestRepairedPlanCandidate?.source || "visible_plan",
      userGoal: closureInput.userGoal || getOriginalUserPromptForPlanFallback(callbacks),
      evidence: closureInput.evidence,
      evidenceRecords: closureInput.evidenceRecords,
      files: closureInput.files,
      recentToolActivity: options.recentToolActivity,
      turnContext: options.turnContext,
      language,
      evidenceBundle: closureInput.evidenceBundle,
      expectedEvidenceBundleHash: closureInput.evidenceBundle.hash,
      ingressMode: "typed_runtime",
    });
    if (!materialized.ok || !materialized.content || !materialized.candidate) {
      return buildPlanArtifactQualityPreflightRejection({
        tc,
        target,
        path,
        kind,
        callbacks,
        validation: {
          ok: false,
          reason: materialized.reason || "typed_plan_candidate_missing",
          recoveryAction: materialized.quality?.recoveryAction || "rewrite",
          missingSections: materialized.quality?.missingSections,
        },
      });
    }
    const prepared = await prepareExecutablePlanCandidate({
      materialized,
      workspace,
      callbacks,
    });
    if (!prepared.ok || !prepared.content || !prepared.candidate || !prepared.evidenceBundleHash) {
      return buildPlanArtifactQualityPreflightRejection({
        tc,
        target,
        path,
        kind,
        callbacks,
        validation: {
          ok: false,
          reason: prepared.reason || "typed_plan_candidate_missing",
          recoveryAction: "rewrite",
        },
      });
    }
    nextContent = prepared.content;
    tc.preparedPlanArtifact = {
      path: canonicalizePlanArtifactPath(prepared.path || path),
      content: prepared.content,
      evidenceBundleHash: prepared.evidenceBundleHash,
      candidate: prepared.candidate,
    };
    if (tc.name === "write_file") {
      args.content = prepared.content;
      tc.arguments = JSON.stringify({ ...args, content: prepared.content });
    }
    // replace_in_file is promoted below to one validated full-content write.
    // Keep its search/replace transport untouched until that atomic promotion.
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

  if (tc.name === "replace_in_file") {
    const originalToolName = tc.name;
    tc.name = "write_file";
    delete args.search_text;
    delete args.replace_text;
    args.path = path;
    args.content = nextContent;
    tc.arguments = JSON.stringify(args);
    logAgentEvent("plan_artifact_replace_promoted_to_validated_write", {
      path,
      kind,
      originalTool: originalToolName,
      effectiveTool: tc.name,
      contentChars: nextContent.length,
    });
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
  options: Pick<ExecuteToolLifecycleOptions, "turnContext" | "recentPlanToolActivity" | "attemptedPlanWriteTargets" | "toolCatalog" | "toolCapabilityRegistry"> & { skipUserReview?: boolean } = {},
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
    probeFileAvailability: async (path) => (
      await probeFileMetadataAvailability(path, workspace)
    ).status,
    readFileMetadata: async (path) => {
      try {
        const metadata = await getFileMetadata(path, workspace);
        return {
          sizeBytes: Number(metadata.sizeBytes) || 0,
          modifiedMs: Number(metadata.modifiedMs) || 0,
        };
      } catch {
        return null;
      }
    },
  });
  if (!mutationPreflight.ok) {
    const recoveryTarget = String(mutationPreflight.path || "").trim() || target;
    logAgentEvent("workspace_mutation_preflight_blocked", {
      tool: tc.name,
      target: recoveryTarget,
      reason: mutationPreflight.reason,
    });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target: recoveryTarget,
      content: `Error: ${mutationPreflight.message || "MUTATION_PREFLIGHT_BLOCKED"}`,
      isError: true,
      lifecycleState: "blocked",
      mutationPreflightReason: mutationPreflight.reason,
      ...(mutationPreflight.patchRecoveryMismatch
        ? { patchRecoveryMismatch: mutationPreflight.patchRecoveryMismatch }
        : {}),
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

  if (options.skipUserReview && canApplyShellAutoReview(shellApprovalResolution)) {
    logAgentEvent("session_auto_review_applied", {
      tool: tc.name,
      target,
      shellPermissionCommand: shellApprovalResolution.command,
      shellPermissionDecision: shellApprovalResolution.decision?.decision || null,
      shellPermissionApprovalScope: shellApprovalResolution.approval?.scope || null,
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
        toolCatalog: options.toolCatalog,
        toolCapabilityRegistry: options.toolCapabilityRegistry,
        authorizationMode: "session",
      },
    );
  }

  if (options.skipUserReview && shellApprovalResolution.command) {
    logAgentEvent("session_auto_review_deferred_to_shell_permission", {
      tool: tc.name,
      target,
      shellPermissionCommand: shellApprovalResolution.command,
      shellPermissionDecision: shellApprovalResolution.decision?.decision || null,
      requiresUserReview: shellApprovalResolution.requiresUserReview === true,
      preflightFailed: !!shellApprovalResolution.error,
    });
  }

  let decision: ReviewDecision;
  try {
    const reviewRisk = getToolRiskLevelForCall(
      tc.name,
      toolArgs,
      options.toolCapabilityRegistry,
      {
        workspace,
        approvedLocalFileReadPaths: callbacks.getApprovedLocalFileReadPaths(),
      },
    );
    decision = await callbacks.requestReview({
      toolCallId: tc.id,
      name: tc.name,
      arguments: toolArgs,
      risk: reviewRisk,
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
        toolCatalog: options.toolCatalog,
        toolCapabilityRegistry: options.toolCapabilityRegistry,
        authorizationMode: "user",
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
export const MAX_PLAN_EVIDENCE_TOOL_ACTIVITY = 32;
export const CONCISE_PLAN_ARTIFACT_HINT_ZH =
  "计划文档必须精简：plan.md 60-120 行；可选 design.md 40-80 行；如确需持久化 tasks.md，保持 8-20 个 checkbox。不要写教程式长文、完整代码清单或重复背景。Proposal 只做一页审阅摘要。";
export const CONCISE_PLAN_ARTIFACT_HINT_EN =
  "Keep plan artifacts concise: plan.md 60-120 lines; optional design.md 40-80 lines; if tasks.md must be persisted, keep it to 8-20 checkboxes. Do not write tutorial-style prose, full code listings, or repeated background. The Proposal should be a one-page review summary.";

export function logAgentEvent(event: string, data: Record<string, unknown> = {}) {
  try {
    const marker = readHarnessRunMarker();
    console.info(`[agent.${event}]`, {
      sessionKey: data.sessionKey ?? data.threadId ?? marker?.sessionKey ?? null,
      turnId: data.turnId ?? marker?.turnId ?? null,
      runId: data.runId ?? marker?.lastGoalSliceRunId ?? marker?.runId ?? null,
      parentRunId: data.parentRunId ?? marker?.parentRunId ?? null,
      goalId: data.goalId ?? null,
      goalSliceId: data.goalSliceId ?? null,
      planRevision: data.planRevision ?? null,
      stopClass: data.stopClass ?? null,
      actionRequestId: data.actionRequestId ?? null,
      ...data,
    });
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
export { AgentOrchestrator } from "./orchestrator/loop/AgentOrchestrator";
export { executeAgentLoop } from "./orchestrator/loop/AgentLoopRunner";
