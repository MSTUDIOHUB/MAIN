import {
  resolveExecuteRecoveryBatchDecision,
  type ExecuteRecoveryMode,
  type RecoveryActionContract,
} from "../../executeRecoveryTools";
import {
  resolveApprovedPlanCommandScope,
  resolveApprovedPlanMutationScope,
} from "../../approvedPlanExecutionScope";
import {
  FILE_UNCHANGED_STUB,
  buildFileReadObservationIdentity,
  buildFileReadSignature,
  buildFileUnchangedReplayContent,
  buildFileUnchangedStub,
  formatReadFileWindowCoverageStub,
  formatReadFileWindowNarrowedNote,
  getReadFileCoverageForPath,
  invalidateStaleFileReadStatesForPath,
  resolveReadFileEligibilityDecision,
  type FileReadState,
} from "../../orchestrator/fileReadCache";
import {
  countSuccessfulPlanReadEvidence,
  hasSuccessfulTabularActivity,
} from "../../orchestrator/planOrchestration";
import { browserResultLooksSuccessful } from "../../planEvidence";
import { buildBrowserValidationCacheSignature } from "../../browserValidation";
import {
  appendPlanRepeatReadLimitGuidance,
  buildGenericObservationContinuationPrompt,
  buildPlanClosurePromptFromEvidence,
  buildPlanExplorationBudget,
  buildPlanGateBlockedResult,
  buildReadOnlyCacheSignature,
  emitToolPreflightBlocked,
  getSessionTaskTargetingEvidence,
  getProtectedPlanArtifactMutationViolation,
  getToolTarget,
  isContentInActiveMessages,
  isExecutionPlanArtifactWrite,
  isPreApprovalPlanDraftWrite,
  isTasksPlanWrite,
  logAgentEvent,
  MAX_RECENT_PLAN_TOOL_ACTIVITY,
  parseToolCallArguments,
  planUnsupportedToolFeedbackMessage,
  PLAN_REPEAT_READ_LIMIT,
  readFileMetadataIfAvailable,
  truncateForLog,
  truncateToolContent,
  formatCachedReadOnlyToolResult,
} from "../../orchestrator";
import { planReadFileWindowCoverage } from "../../readFileWindow";
import {
  buildRepeatLoopArgsKey,
  buildRepeatLoopSignature,
} from "../../repetitionGuard";
import type { ResolvedUserIntent } from "../../runIntent";
import { initialLifecycleStateForPlanAction, planRuntimeToolCall } from "../../runtimeTools";
import { shouldBlockToolCallForTargeting, type TaskTargetingProfile } from "../../taskTargeting";
import { isLocalFileReadApproved, type ToolCapabilityRegistry, type ToolPermissionPolicy } from "../../toolCapabilities";
import type { MainThreadEventInput, MainThreadItem } from "../../turnEvents";
import {
  isFinitePlanValidationCommand,
  isFlexiblePlanValidationCommandEvidence,
  type PlanRuntimePhase,
} from "../../workflowModels";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { findSubagentScopeConflict, validateSubagentScopeTarget } from "../../subagents";
import { workspacePathsReferToSameFile } from "../../workspacePaths";
import {
  isWorkspaceMutationToolCall,
  resolveWorkspaceMutationTargets,
} from "../../workspaceMutationTools";
import { shouldCacheReadOnlyToolResult } from "../../readOnlyToolCachePolicy";
import {
  extractLocalDevServerPort,
  isLocalDevServerHealthProbeCommand,
  resolveBrowserValidationPreflight,
} from "../../devServerRuntime";
import type {
  AgentMessage,
  CachedReadOnlyToolResult,
  OrchestratorCallbacks,
  ToolCallToExecute,
  ToolExecutionResult,
} from "../types";
import type {
  LocalFileReadToolCallForRound,
  ReadOnlyToolCallForRound,
  WriteToolCallForRound,
} from "./toolExecutionRound";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import type { TurnIterationContext } from "./turnIterationContext";

export interface ToolCallPartitioningResult {
  readOnlyCalls: ReadOnlyToolCallForRound[];
  localFileReadCalls: LocalFileReadToolCallForRound[];
  specFileCalls: ToolCallToExecute[];
  writeCalls: WriteToolCallForRound[];
  toolArgsByCallId: Map<string, Record<string, unknown>>;
  readOnlyCallSignatures: Map<string, string>;
  readFileWindowNarrowedNotes: Map<string, string>;
  toolFailureSignatures: Map<string, string>;
  preExecutionResults: ToolExecutionResult[];
}

function parentHasReusableDelegatedSourceWindow(input: {
  activity: PlanToolActivitySummary;
  fileReadStates: Map<string, FileReadState>;
  managedAgentMessages: AgentMessage[];
}): boolean {
  const delegated = input.activity.delegatedObservation;
  if (!delegated || delegated.parentContextState !== "reference_only") return true;
  return [...input.fileReadStates.values()].some((state) => {
    if (!workspacePathsReferToSameFile(state.path, input.activity.target)) return false;
    if (!isContentInActiveMessages(state.modelContent, input.managedAgentMessages)) return false;
    if (
      delegated.sourceVersion &&
      state.observation?.versionToken &&
      delegated.sourceVersion !== state.observation.versionToken
    ) return false;
    if (!delegated.sourceRange) return true;
    if (!state.window) return false;
    return state.window.startLine <= delegated.sourceRange.startLine &&
      state.window.endLine >= delegated.sourceRange.endLine;
  });
}

function recoveryContractAuthorizesApprovedPlanCommand(input: {
  toolName: string;
  command: string;
  plannedCommands: string[];
  contract: RecoveryActionContract;
}): boolean {
  if (input.toolName !== "run_command") return false;
  if (
    input.contract.nextRequiredCapability === "validation" &&
    input.plannedCommands.every(isFlexiblePlanValidationCommandEvidence)
  ) {
    return isFinitePlanValidationCommand(input.command);
  }
  if (
    input.contract.nextRequiredCapability !== "reconcile_server" ||
    !isLocalDevServerHealthProbeCommand(input.command)
  ) {
    return false;
  }
  const expectedPort = extractLocalDevServerPort(input.contract.devServerUrl || "");
  const requestedPort = extractLocalDevServerPort(input.command);
  return expectedPort !== null && requestedPort === expectedPort;
}

export function findDelegatedObservationRequiringParentReread(input: {
  mutationTargets: string[];
  recentToolActivity: PlanToolActivitySummary[];
  fileReadStates: Map<string, FileReadState>;
  managedAgentMessages: AgentMessage[];
}): PlanToolActivitySummary | null {
  for (const target of input.mutationTargets) {
    const delegatedActivities = [...input.recentToolActivity].reverse().filter((activity) =>
      activity.delegatedObservation?.requiresParentReread === true &&
      workspacePathsReferToSameFile(activity.target, target)
    );
    for (const delegatedActivity of delegatedActivities) {
      if (!parentHasReusableDelegatedSourceWindow({
          activity: delegatedActivity,
          fileReadStates: input.fileReadStates,
          managedAgentMessages: input.managedAgentMessages,
        })) {
        return delegatedActivity;
      }
    }
  }
  return null;
}

export async function partitionToolCallsForExecution(input: {
  toolCalls: ToolCallToExecute[];
  workspace: string;
  callbacks: OrchestratorCallbacks;
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  planRuntimePhase: PlanRuntimePhase;
  availableToolNames: Set<string>;
  toolCapabilityRegistry: ToolCapabilityRegistry;
  toolPermissionPolicy: ToolPermissionPolicy;
  recentPlanToolActivity: PlanToolActivitySummary[];
  recentToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  latestUserPromptText: string;
  managedAgentMessages: AgentMessage[];
  failedToolCallCounts: Map<string, number>;
  buildCurrentTaskTargetingProfile: () => TaskTargetingProfile;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  recoveryActionContract: RecoveryActionContract;
  readOnlyResultCache: Map<string, CachedReadOnlyToolResult>;
  readOnlyDuplicateSkipCounts: Map<string, number>;
  fileReadStates: Map<string, FileReadState>;
  browserValidationCache: Map<string, ToolExecutionResult>;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId">;
  emitTurnEvent: (event: MainThreadEventInput) => void;
}): Promise<ToolCallPartitioningResult> {
  const {
    toolCalls,
    workspace,
    callbacks,
    iteration,
    workflowMode,
    runtimeIntent,
    planRuntimePhase,
    availableToolNames,
    toolCapabilityRegistry,
    toolPermissionPolicy,
    recentPlanToolActivity,
    recentToolActivity,
    attemptedPlanWriteTargets,
    latestUserPromptText,
    managedAgentMessages,
    failedToolCallCounts,
    buildCurrentTaskTargetingProfile,
    executeRecoveryState,
    recoveryActionContract,
    readOnlyResultCache,
    readOnlyDuplicateSkipCounts,
    fileReadStates,
    browserValidationCache,
    iterationContext,
    emitTurnEvent,
  } = input;
  const { eventThreadId, eventTurnId } = iterationContext;
  const executeRecoveryMode: ExecuteRecoveryMode = executeRecoveryState.mode;

  const readOnlyCalls: ReadOnlyToolCallForRound[] = [];
  const localFileReadCalls: LocalFileReadToolCallForRound[] = [];
  const specFileCalls: ToolCallToExecute[] = [];
  const writeCalls: WriteToolCallForRound[] = [];
  const toolArgsByCallId = new Map<string, Record<string, unknown>>();
  const readOnlyCallSignatures = new Map<string, string>();
  const readFileWindowNarrowedNotes = new Map<string, string>();
  const queuedReadOnlySignatures = new Set<string>();
  const queuedFileReadSignatures = new Set<string>();
  const toolFailureSignatures = new Map<string, string>();
  const preExecutionResults: ToolExecutionResult[] = [];
  let sawOrderSensitiveWorkspaceAction = false;
  let deferRemainingCallsForBatchOrder = false;
  const executeRecoveryContract = recoveryActionContract;
  const executeRecoveryBatchDecision = resolveExecuteRecoveryBatchDecision({
    mode: executeRecoveryMode,
    calls: toolCalls.map((call) => {
      const args = parseToolCallArguments(call, workspace);
      return {
        id: call.id,
        name: call.name,
        target: getToolTarget(call.name, args),
      };
    }),
    recentActivity: recentToolActivity,
    expectedTarget: executeRecoveryState.expectedTarget,
    contract: executeRecoveryContract,
  });

  for (const tc of toolCalls) {
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
    let target = getToolTarget(tc.name, toolArgs);
    callbacks.onHarnessRunUpdate?.({
      latestTool: tc.name,
      latestToolTarget: target || null,
      toolCallId: tc.id,
      streamStatus: "tool_called",
    });
    const baseFailureSignature = buildRepeatLoopSignature(
      tc.name,
      buildRepeatLoopArgsKey(toolArgs),
    );
    const recoveryFailureScope = executeRecoveryMode === "normal"
      ? ""
      : [
          executeRecoveryContract.phase,
          executeRecoveryContract.nextRequiredCapability,
          executeRecoveryState.expectedTarget || "no-target",
          executeRecoveryState.sourceObservationKey ||
            executeRecoveryState.readLease?.observedVersion ||
            "no-file-version",
          executeRecoveryContract.ptyGeneration ?? "no-pty-generation",
        ].join("::");
    const failureSignature = recoveryFailureScope
      ? `${baseFailureSignature}::recovery=${recoveryFailureScope}`
      : baseFailureSignature;
    toolFailureSignatures.set(tc.id, failureSignature);

    const isAllowedPlanDraftMutation =
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      isPreApprovalPlanDraftWrite(tc.name, toolArgs);
    if (!availableToolNames.has(tc.name) && !isAllowedPlanDraftMutation) {
      const isUnapprovedPlanContext = workflowMode === "plan" && !callbacks.getIsPlanApproved();
      const unsupportedMessage = planUnsupportedToolFeedbackMessage({
        language: callbacks.getPreferredLanguage(),
        toolName: tc.name,
        runtimeIntent,
        workflowMode,
        isPlanApproved: callbacks.getIsPlanApproved(),
        planRuntimePhase,
        availableToolNames: Array.from(availableToolNames),
      });
      const isExecuteRecoveryScopeCorrection = executeRecoveryBatchDecision.active;
      const isReadScopeDeferred = tc.name === "read_file";
      const isDelegationPolicyDeferral = tc.name === "spawn_subagent";
      const isInternalScopeDeferral =
        isExecuteRecoveryScopeCorrection || isReadScopeDeferred || isDelegationPolicyDeferral;
      const message = isExecuteRecoveryScopeCorrection
        ? tc.name === "read_file"
          ? callbacks.getPreferredLanguage() === "zh"
            ? `READ_SCOPE_DEFERRED: read_file 不在本次请求的实际工具面中，因此没有执行。请不要原样重试或用 shell 绕行；改用实际列出的工具推进 ${executeRecoveryContract.nextRequiredCapability}。`
            : `READ_SCOPE_DEFERRED: read_file is not in this request's actual tool surface, so it did not run. Do not retry it unchanged or bypass it through shell commands; use the tools actually listed to advance ${executeRecoveryContract.nextRequiredCapability}.`
          : callbacks.getPreferredLanguage() === "zh"
            ? `EXECUTE_RECOVERY_SCOPE_DEFERRED: ${tc.name} 不属于当前 ${executeRecoveryBatchDecision.phase} 阶段；请使用当前工具面完成下一能力。`
            : `EXECUTE_RECOVERY_SCOPE_DEFERRED: ${tc.name} is outside the current ${executeRecoveryBatchDecision.phase} phase; use the active tool surface for the next capability.`
        : isDelegationPolicyDeferral
        ? callbacks.getPreferredLanguage() === "zh"
          ? "SUBAGENT_DELEGATION_DEFERRED: 当前阶段或自适应准入没有开放新的子智能体。请继续主体的当前步骤；若已有子智能体正在运行，请先 wait_subagents 汇合。"
          : "SUBAGENT_DELEGATION_DEFERRED: The current phase or adaptive admission does not allow another subagent. Continue the parent's current step; join any running children with wait_subagents first."
        : unsupportedMessage;
      if (executeRecoveryBatchDecision.active) {
        logAgentEvent("execute_recovery_scope_deferred", {
          iteration,
          phase: executeRecoveryBatchDecision.phase,
          nextRequiredCapability: executeRecoveryContract.nextRequiredCapability,
          mode: executeRecoveryMode,
          tool: tc.name,
          target,
          expectedTarget: executeRecoveryState.expectedTarget,
          availableToolNames: Array.from(availableToolNames).slice(0, 12),
          outcome: "internal_scope_feedback",
        });
      }
      if (isDelegationPolicyDeferral) {
        logAgentEvent("delegation_admission_deferred", {
          iteration,
          reason: "spawn_unavailable_on_current_tool_surface",
          workflowMode,
          runtimeIntent,
          planRuntimePhase,
          availableToolNames: Array.from(availableToolNames).slice(0, 12),
          failureKind: "policy",
        });
      }
      logAgentEvent("plan_unsupported_tool_call_suppressed", {
        iteration,
        reason: "unavailable_before_execution",
        toolNames: [tc.name],
        tool: tc.name,
        target,
        runtimeIntent,
        workflowMode,
        isPlanApproved: callbacks.getIsPlanApproved(),
        availableToolNames: Array.from(availableToolNames).slice(0, 12),
        planRuntimePhase,
        preservedVisibleText: false,
        internalFeedback: isUnapprovedPlanContext || isInternalScopeDeferral,
      });
      if (!isUnapprovedPlanContext && !isInternalScopeDeferral) {
        callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
      } else if (isInternalScopeDeferral) {
        toolFailureSignatures.delete(tc.id);
        callbacks.onToolDone(tc.name, target, message, {
          toolCallId: tc.id,
          internalFeedback: true,
          qualityGateReason: isExecuteRecoveryScopeCorrection
            ? "execute_recovery_scope_deferred"
            : isDelegationPolicyDeferral
            ? "subagent_delegation_deferred"
            : "read_scope_deferred",
        });
      }
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: isInternalScopeDeferral ? message : `Error: ${message}`,
        isError: !isInternalScopeDeferral,
        lifecycleState: isInternalScopeDeferral ? "completed" : "blocked",
        ...(isInternalScopeDeferral
          ? {
              qualityGateReason: isExecuteRecoveryScopeCorrection
                ? "execute_recovery_scope_deferred"
                : isDelegationPolicyDeferral
                ? "subagent_delegation_deferred"
                : "read_scope_deferred",
              internalFeedback: true,
              displayContent: "",
            }
          : {}),
        ...(isUnapprovedPlanContext && !isExecuteRecoveryScopeCorrection
          ? { internalFeedback: true, displayContent: "" }
          : {}),
      });
      continue;
    }

    const isOrderSensitiveWorkspaceAction =
      isWorkspaceMutationToolCall(tc.name, toolArgs) ||
      tc.name === "run_command" ||
      tc.name === "execute_command" ||
      tc.name === "send_pty_input";
    // Execution rounds intentionally group auto-executable observations ahead
    // of reviewed/ mutating calls. Preserve the model's within-batch happens-
    // before relation by deferring any workspace observation that follows an
    // action; otherwise grep/outline/git/PTY results could describe the state
    // before the earlier write or command. The capability risk keeps this
    // boundary aligned with the registry instead of maintaining another list
    // of individual read tool names here.
    const isOrderSensitiveWorkspaceObservation =
      toolCapabilityRegistry.tools[tc.name]?.risk === "read_only";
    const observationWouldRunBeforeEarlierAction =
      sawOrderSensitiveWorkspaceAction && isOrderSensitiveWorkspaceObservation;
    if (observationWouldRunBeforeEarlierAction) {
      deferRemainingCallsForBatchOrder = true;
    }
    if (deferRemainingCallsForBatchOrder) {
      const language = callbacks.getPreferredLanguage();
      const message = language === "zh"
        ? `ORDERED_BATCH_CALL_DEFERRED: ${tc.name} 位于同批写入/命令之后。MAIN 不会把它提前到修改前执行；请先消费本批操作结果，再在下一条回复中读取修改后的文件或继续后续动作。`
        : `ORDERED_BATCH_CALL_DEFERRED: ${tc.name} appeared after a write/command in the same batch. MAIN will not move it ahead of that action; consume this batch result, then read the post-action file or continue later actions in the next response.`;
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: "ordered_batch_call_deferred",
      });
      logAgentEvent("ordered_batch_call_deferred", {
        iteration,
        tool: tc.name,
        target,
        reason: observationWouldRunBeforeEarlierAction
          ? "workspace_observation_after_action"
          : "depends_on_deferred_observation",
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: message,
        displayContent: "",
        isError: false,
        lifecycleState: "completed",
        internalFeedback: true,
        qualityGateReason: "ordered_batch_call_deferred",
      });
      continue;
    }
    if (
      executeRecoveryBatchDecision.active &&
      executeRecoveryBatchDecision.selectedCallId !== tc.id
    ) {
      const language = callbacks.getPreferredLanguage();
      const readOutsideTransactionScope =
        tc.name === "read_file" &&
        Boolean(executeRecoveryState.expectedTarget) &&
        !workspacePathsReferToSameFile(target, executeRecoveryState.expectedTarget || "");
      const readScopeDecision = readOutsideTransactionScope
          ? resolveReadFileEligibilityDecision({
            scopeMatches: false,
            hasCachedWindow: false,
            contentInContext: false,
          })
        : null;
      const selectedTool = executeRecoveryBatchDecision.selectedToolName ||
        executeRecoveryContract.nextRequiredCapability;
      const expectedTargetHint = executeRecoveryState.expectedTarget
        ? language === "zh"
          ? executeRecoveryBatchDecision.phase === "need_context"
            ? ` 当前事务目标是 ${executeRecoveryState.expectedTarget}；下一步必须读取该目标。`
            : executeRecoveryBatchDecision.phase === "need_mutation" || executeRecoveryBatchDecision.phase === "legacy_action"
              ? ` 当前事务目标是 ${executeRecoveryState.expectedTarget}；下一步必须修改该目标。`
              : ` 当前事务目标必须保持为 ${executeRecoveryState.expectedTarget}。`
          : executeRecoveryBatchDecision.phase === "need_context"
            ? ` The transaction target is ${executeRecoveryState.expectedTarget}; the next call must read that target.`
            : executeRecoveryBatchDecision.phase === "need_mutation" || executeRecoveryBatchDecision.phase === "legacy_action"
              ? ` The transaction target is ${executeRecoveryState.expectedTarget}; the next call must mutate that target.`
              : ` The transaction target must remain ${executeRecoveryState.expectedTarget}.`
        : "";
      const message = readOutsideTransactionScope
        ? language === "zh"
          ? `READ_SCOPE_DEFERRED: ${target || "该读取"} 不属于当前恢复事务目标 ${executeRecoveryState.expectedTarget}。本次没有执行读取；请只读取事务目标的变化版本或缺失行范围。`
          : `READ_SCOPE_DEFERRED: ${target || "This read"} is outside the current recovery target ${executeRecoveryState.expectedTarget}. The read did not execute; request only a changed version or missing line window of the transaction target.`
        : language === "zh"
          ? `EXECUTE_RECOVERY_BATCH_DEFERRED: 当前恢复事务处于 ${executeRecoveryBatchDecision.phase}，本批只执行一个 ${selectedTool}。${tc.name} 已推迟；请先消费本批工具结果，再在下一条回复中调用下一阶段的一个工具。${expectedTargetHint}`
          : `EXECUTE_RECOVERY_BATCH_DEFERRED: The recovery transaction is in ${executeRecoveryBatchDecision.phase}; this batch executes only one ${selectedTool}. ${tc.name} was deferred. Consume this tool result, then call one tool for the next phase in the next response.${expectedTargetHint}`;
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: readOutsideTransactionScope
          ? "execute_recovery_read_scope_deferred"
          : "execute_recovery_batch_deferred",
      });
      toolFailureSignatures.delete(tc.id);
      logAgentEvent("execute_recovery_batch_call_deferred", {
        iteration,
        phase: executeRecoveryBatchDecision.phase,
        selectedCallId: executeRecoveryBatchDecision.selectedCallId,
        selectedTool: executeRecoveryBatchDecision.selectedToolName,
        deferredCallId: tc.id,
        deferredTool: tc.name,
        target,
        expectedTarget: executeRecoveryState.expectedTarget,
        reason: readScopeDecision?.reason || "serialized_recovery_step",
        readEligibility: readScopeDecision?.kind || null,
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: message,
        displayContent: "",
        isError: false,
        lifecycleState: "completed",
        internalFeedback: true,
        qualityGateReason: readOutsideTransactionScope
          ? "execute_recovery_read_scope_deferred"
          : "execute_recovery_batch_deferred",
      });
      continue;
    }

    const directScopeTarget = typeof toolArgs.path === "string" ? toolArgs.path.trim() : "";
    const mutationScopeTargets = resolveWorkspaceMutationTargets(tc.name, toolArgs, target);
    const scopeTargets = mutationScopeTargets.length > 0
      ? mutationScopeTargets
      : tc.name === "grep_search" || tc.name === "find_symbol_references" || tc.name === "git_diff"
        ? [directScopeTarget || "."]
        : new Set(["read_file", "get_file_outline", "code_ast_query"] as string[]).has(tc.name)
          ? [directScopeTarget]
          : [];
    if (scopeTargets.length > 0) {
      const subagentScope = callbacks.getSubagentScope?.() ?? null;
      const scopeConflict = subagentScope ? null : scopeTargets
        .map((scopeTarget) => findSubagentScopeConflict({
          threadId: callbacks.getSessionKey(),
          targetPath: scopeTarget,
        }))
        .find(Boolean) || null;
      const scopeBlocked = subagentScope
        ? scopeTargets.some((scopeTarget) =>
            !scopeTarget || !validateSubagentScopeTarget(subagentScope, scopeTarget)
          )
        : !!scopeConflict;
      const parentScopeDeferred = !subagentScope && !!scopeConflict;
      callbacks.onDebugEvent?.("delegation_scope_decision", {
        tool: tc.name,
        targets: scopeTargets,
        decision: parentScopeDeferred ? "deferred" : scopeBlocked ? "blocked" : "allowed",
        reason: parentScopeDeferred
          ? "overlapping_active_scope"
          : scopeBlocked ? "subagent_scope_escape" : "no_scope_conflict",
        agentKind: subagentScope ? "subagent" : "parent",
        subagentId: subagentScope?.subagentId || scopeConflict?.subagentId || null,
        scopeKey: subagentScope?.scopeKey || scopeConflict?.scopeKey || null,
      });
      if (scopeBlocked) {
        const message = subagentScope
          ? `SUBAGENT_SCOPE_BLOCKED: ${tc.name} targets '${scopeTargets.join(", ") || "<missing path>"}' are outside allowed_paths for scope '${subagentScope.scopeKey}'.`
          : `PARENT_SCOPE_DEFERRED_TO_SUBAGENT: '${scopeTargets.join(", ")}' overlaps the active lease held by ${scopeConflict?.subagentId} (${scopeConflict?.scopeKey}). This is a policy deferral, not a tool failure; continue non-overlapping work and call wait_subagents before accessing it.`;
        if (parentScopeDeferred) {
          toolFailureSignatures.delete(tc.id);
          callbacks.onToolDone(tc.name, target, message, {
            toolCallId: tc.id,
            internalFeedback: true,
            qualityGateReason: "subagent_scope_policy_deferred",
          });
          logAgentEvent("delegation_scope_deferred", {
            iteration,
            tool: tc.name,
            targets: scopeTargets,
            conflictingSubagentId: scopeConflict?.subagentId || null,
            conflictingScopeKey: scopeConflict?.scopeKey || null,
            failureKind: "policy",
          });
        } else {
          callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
        }
        preExecutionResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: parentScopeDeferred ? message : `Error: ${message}`,
          displayContent: parentScopeDeferred ? "" : undefined,
          isError: !parentScopeDeferred,
          lifecycleState: parentScopeDeferred ? "completed" : "blocked",
          ...(parentScopeDeferred
            ? {
                internalFeedback: true,
                qualityGateReason: "subagent_scope_policy_deferred",
              }
            : {}),
        });
        continue;
      }
    }

    const protectedPlanMutation = getProtectedPlanArtifactMutationViolation(
      tc.name,
      toolArgs,
      callbacks.getPreferredLanguage(),
    );
    if (protectedPlanMutation) {
      callbacks.onToolExecuting(tc.name, protectedPlanMutation.target, undefined, { toolCallId: tc.id });
      callbacks.onToolDone(tc.name, protectedPlanMutation.target, protectedPlanMutation.message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: protectedPlanMutation.reason,
      });
      logAgentEvent("plan_artifact_protected_mutation_blocked", {
        iteration,
        tool: tc.name,
        target: protectedPlanMutation.target,
        reason: protectedPlanMutation.reason,
        diskWritten: false,
        storePublished: false,
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target: protectedPlanMutation.target,
        content: protectedPlanMutation.message,
        displayContent: protectedPlanMutation.message,
        isError: false,
        lifecycleState: "completed",
        internalFeedback: true,
        qualityGateReason: protectedPlanMutation.reason,
        planRecoveryAction: "rewrite",
      });
      continue;
    }

    if (tc.name === "write_file" && target) {
      const failedPatchCount = [...recentPlanToolActivity, ...recentToolActivity]
        .filter((activity) =>
          activity.name === "apply_patch" &&
          activity.status === "failed" &&
          workspacePathsReferToSameFile(activity.target, target)
        ).length;
      if (failedPatchCount >= 2) {
        const latestRead = [...fileReadStates.values()]
          .filter((state) => workspacePathsReferToSameFile(state.path, target))
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const currentMeta = await readFileMetadataIfAvailable(target, workspace);
        const snapshotStillCurrent = !!latestRead && !!currentMeta &&
          latestRead.sizeBytes === currentMeta.sizeBytes &&
          latestRead.modifiedMs === currentMeta.modifiedMs;
        const exactFullFileObserved = !!latestRead?.window &&
          latestRead.window.startLine === 1 &&
          latestRead.window.endLine >= latestRead.window.totalLines &&
          !latestRead.window.truncated;
        const fullWriteAllowed = exactFullFileObserved && snapshotStillCurrent;
        callbacks.onDebugEvent?.("patch_recovery_full_write_decision", {
          target,
          failedPatchCount,
          observedWindow: latestRead?.window || null,
          exactFullFileObserved,
          snapshotStillCurrent,
          decision: fullWriteAllowed ? "allowed" : "blocked",
          latestReadHash: latestRead?.contentHash || null,
        });
        if (!fullWriteAllowed) {
          const message = `WRITE_FILE_AFTER_PATCH_FAILURE_BLOCKED: ${failedPatchCount} precise patches failed for '${target}'. Full-file replacement requires an exact complete-file observation whose version still matches the current file.`;
          callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
          preExecutionResults.push({
            toolCallId: tc.id,
            name: tc.name,
            target,
            content: `Error: ${message}`,
            isError: true,
            lifecycleState: "blocked",
          });
          continue;
        }
      }
    }

    if ((failedToolCallCounts.get(failureSignature) ?? 0) >= 2) {
      const failureCount = failedToolCallCounts.get(failureSignature) ?? 0;
      const argsJson = typeof tc.arguments === "string" ? tc.arguments : "";
      logAgentEvent("repeated_failure_block_details", {
        iteration,
        tool: tc.name,
        arguments: argsJson,
        target,
        toolCallId: tc.id,
        failureSignature,
        failureCount,
        firstSeenIteration: iteration - (failureCount - 1),
      });
      const message = callbacks.getPreferredLanguage() === "zh"
        ? `REPEATED_FAILURE_BLOCKED: ${tc.name}${target ? ` (${target})` : ""} 已用相同参数连续失败。请先诊断最近错误，改变参数或换一条策略，不要原样重试。`
        : `REPEATED_FAILURE_BLOCKED: ${tc.name}${target ? ` (${target})` : ""} has failed repeatedly with identical arguments. Diagnose the latest error and change arguments or strategy before retrying.`;
      const _recentActivity = recentPlanToolActivity.slice(-MAX_RECENT_PLAN_TOOL_ACTIVITY);
      const _evidenceKeys = Array.from(getSessionTaskTargetingEvidence(callbacks.getSessionKey())).slice(0, 20);
      emitToolPreflightBlocked(callbacks, {
        reason: "repeated_failure_blocked",
        tool: tc.name,
        target,
        message,
        toolCallId: tc.id,
        lifecycleState: "blocked",
        evidenceChain: _recentActivity.length > 0 || _evidenceKeys.length > 0
          ? { recentToolActivity: JSON.stringify(_recentActivity.slice(-6).map((a) => `${a.name}->${a.target}`)), evidenceKeys: _evidenceKeys }
          : undefined,
      });
      callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: `Error: ${message}`,
        isError: true,
        lifecycleState: "blocked",
      });
      continue;
    }

    if (tc.name === "browser_evaluate" && typeof toolArgs.url === "string") {
      const browserPreflight = resolveBrowserValidationPreflight({
        requestedUrl: toolArgs.url,
        ledger: callbacks.getPlanExecutionEvidenceLedger(),
      });
      if (browserPreflight.action === "block") {
        const requestedUrl = toolArgs.url;
        // browser_evaluate has not executed yet. Every preflight outcome is a
        // lifecycle/reconciliation result owned by the dev-server transaction,
        // never an actual browser failure. Real launch failures remain in the
        // evidence ledger under execute_command/PTY observations.
        const policyDeferral = true;
        const language = callbacks.getPreferredLanguage();
        const message = browserPreflight.reason === "PTY_OBSERVATION_REQUIRED"
          ? language === "zh"
            ? `PTY_OBSERVATION_REQUIRED: 长进程当前为 ${browserPreflight.runtimeStatus}，尚未形成同一 PTY generation 的 ready 证据。请调用 get_pty_status 或 read_pty_since 观察现有前台进程；不要用 sleep 轮询，也不要把 PTY_BUSY 解释为端口或全部终端被占用。ready 后再访问 ${requestedUrl}。`
            : `PTY_OBSERVATION_REQUIRED: The long-running process is ${browserPreflight.runtimeStatus} and has no ready evidence for the current PTY generation. Observe the existing foreground process with get_pty_status or read_pty_since; do not poll with sleep or interpret PTY_BUSY as a port/global-terminal failure. Browser-validate ${requestedUrl} after readiness.`
          : browserPreflight.reason === "DEV_SERVER_PORT_CONFLICT_UNCONFIRMED"
          ? language === "zh"
            ? `DEV_SERVER_PORT_CONFLICT_UNCONFIRMED: 检测到明确端口冲突，但尚未证明现有服务健康。请用独立有限命令通道探测 ${requestedUrl}；健康则复用该 URL 并继续浏览器验收，否则再修复或重启服务。`
            : `DEV_SERVER_PORT_CONFLICT_UNCONFIRMED: An explicit port conflict was observed, but the existing service is not yet proven healthy. Probe ${requestedUrl} through an independent finite-command channel; reuse it for browser validation if healthy, otherwise repair or restart the service.`
          : browserPreflight.reason === "DEV_SERVER_STOPPED"
          ? language === "zh"
            ? `DEV_SERVER_STOPPED: 最新 PTY 生命周期表明开发服务器已经退出。重新启动并观察 ready 后，才能访问 ${requestedUrl}。`
            : `DEV_SERVER_STOPPED: The latest PTY lifecycle shows that the dev server exited. Restart it and observe readiness before browser validation at ${requestedUrl}.`
          : language === "zh"
            ? `DEV_SERVER_START_FAILED: 最新 PTY 证据表明开发服务器启动失败。请先修复或重启，再观察 ready，之后访问 ${requestedUrl}。`
            : `DEV_SERVER_START_FAILED: The latest PTY evidence shows that the dev server failed to start. Repair or restart it, observe readiness, then browser-validate ${requestedUrl}.`;
        // Readiness/reconciliation is a deterministic phase transition. Keep
        // it out of failedToolCallCounts so the ready URL remains usable later.
        toolFailureSignatures.delete(tc.id);
        callbacks.onToolDone(tc.name, requestedUrl, message, {
          toolCallId: tc.id,
          internalFeedback: true,
          qualityGateReason: browserPreflight.reason?.toLowerCase() || "browser_preflight_deferred",
        });
        logAgentEvent("browser_validation_blocked_until_dev_server_ready", {
          iteration,
          requestedUrl,
          runtimeStatus: browserPreflight.runtimeStatus,
          reason: browserPreflight.reason,
          nextCapability: browserPreflight.nextCapability,
          policyDeferral,
          ptyObservationToolsAvailable: ["read_pty_since", "read_pty_tail", "get_pty_status"]
            .filter((name) => availableToolNames.has(name)),
        });
        preExecutionResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target: requestedUrl,
          content: policyDeferral ? message : `Error: ${message}`,
          displayContent: policyDeferral ? "" : undefined,
          isError: !policyDeferral,
          lifecycleState: policyDeferral ? "completed" : "blocked",
          ...(policyDeferral
            ? {
                internalFeedback: true,
                qualityGateReason: browserPreflight.reason?.toLowerCase() || "browser_preflight_deferred",
              }
            : {}),
        });
        continue;
      }
      if (browserPreflight.action === "correct") {
        const requestedUrl = toolArgs.url;
        toolArgs = { ...toolArgs, url: browserPreflight.url };
        tc.arguments = JSON.stringify(toolArgs);
        toolArgsByCallId.set(tc.id, toolArgs);
        target = getToolTarget(tc.name, toolArgs);
        logAgentEvent("browser_validation_url_corrected_from_runtime_evidence", {
          iteration,
          requestedUrl,
          resolvedUrl: browserPreflight.url,
        });
      }
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
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: `Error: ${message}`,
        isError: true,
        lifecycleState: "blocked",
      });
      continue;
    }

    const approvedPlanCommandScope = resolveApprovedPlanCommandScope({
      isPlanApproved: callbacks.getIsPlanApproved(),
      toolName: tc.name,
      args: toolArgs,
      tasks: callbacks.getPlanTasks(),
    });
    const approvedPlanCommandRecoveryLease =
      approvedPlanCommandScope.applies &&
      !approvedPlanCommandScope.allowed &&
      recoveryContractAuthorizesApprovedPlanCommand({
        toolName: tc.name,
        command: approvedPlanCommandScope.requestedCommand,
        plannedCommands: approvedPlanCommandScope.plannedCommands,
        contract: executeRecoveryContract,
      });
    if (approvedPlanCommandScope.applies && !approvedPlanCommandScope.allowed && !approvedPlanCommandRecoveryLease) {
      const reviewed = approvedPlanCommandScope.plannedCommands.join(" | ") || "none";
      const message = callbacks.getPreferredLanguage() === "zh"
        ? `APPROVED_PLAN_COMMAND_DEFERRED: 该 shell 命令不是已批准 Plan 中的精确命令，因此未执行。已审核命令：${reviewed}。请使用已审核命令或专用读写工具，或提交包含该命令的新 revision。`
        : `APPROVED_PLAN_COMMAND_DEFERRED: This shell command is not an exact command from the approved Plan, so it did not run. Reviewed commands: ${reviewed}. Use a reviewed command or a dedicated read/write tool, or submit a revision containing this command.`;
      logAgentEvent("approved_plan_command_scope_deferred", {
        iteration,
        tool: tc.name,
        command: approvedPlanCommandScope.requestedCommand,
        plannedCommands: approvedPlanCommandScope.plannedCommands,
      });
      toolFailureSignatures.delete(tc.id);
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: "approved_plan_command_scope_deferred",
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: message,
        isError: false,
        internalFeedback: true,
        qualityGateReason: "approved_plan_command_scope_deferred",
        lifecycleState: "blocked",
      });
      continue;
    }
    if (approvedPlanCommandRecoveryLease) {
      logAgentEvent("execute_recovery_validation_command_lease_consumed", {
        iteration,
        tool: tc.name,
        command: approvedPlanCommandScope.requestedCommand,
        recoveryPhase: executeRecoveryContract.phase,
        nextRequiredCapability: executeRecoveryContract.nextRequiredCapability,
        devServerUrl: executeRecoveryContract.devServerUrl,
      });
    }
    const approvedPlanMutationScope = resolveApprovedPlanMutationScope({
      isPlanApproved: callbacks.getIsPlanApproved(),
      toolName: tc.name,
      args: toolArgs,
      target,
      tasks: callbacks.getPlanTasks(),
    });
    if (approvedPlanMutationScope.applies && !approvedPlanMutationScope.allowed) {
      const unexpected = approvedPlanMutationScope.unexpectedTargets.join(", ") || target || tc.name;
      const planned = approvedPlanMutationScope.plannedTargets.join(", ") || "none";
      const message = callbacks.getPreferredLanguage() === "zh"
        ? `APPROVED_PLAN_SCOPE_BLOCKED: ${unexpected} 不在已批准 Plan 的修改目标中，因此本次写入未执行。当前允许的修改目标：${planned}。请先用现有测试、内联命令或只读检查完成计划内验证并继续任务；只有该目标确属必要源码改动时，才生成聚焦的新 revision 供审核。`
        : `APPROVED_PLAN_SCOPE_BLOCKED: ${unexpected} is outside the approved Plan mutation targets, so this write was not executed. Allowed targets: ${planned}. Continue with in-scope validation using existing tests, inline commands, or read-only inspection; create a focused revision only if this target is genuinely required for the source change.`;
      callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
      logAgentEvent("approved_plan_mutation_scope_blocked", {
        iteration,
        tool: tc.name,
        target,
        requestedTargets: approvedPlanMutationScope.requestedTargets,
        unexpectedTargets: approvedPlanMutationScope.unexpectedTargets,
        plannedTargets: approvedPlanMutationScope.plannedTargets,
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: `Error: ${message}`,
        isError: true,
        lifecycleState: "blocked",
        approvedPlanScopeConflict: {
          requestedTargets: approvedPlanMutationScope.requestedTargets,
          unexpectedTargets: approvedPlanMutationScope.unexpectedTargets,
          plannedTargets: approvedPlanMutationScope.plannedTargets,
        },
      });
      continue;
    }

    if (isWorkspaceMutationToolCall(tc.name, toolArgs)) {
      const mutationTargets = resolveWorkspaceMutationTargets(tc.name, toolArgs, target);
      const delegatedSource = findDelegatedObservationRequiringParentReread({
        mutationTargets,
        recentToolActivity,
        fileReadStates,
        managedAgentMessages,
      });
      if (delegatedSource) {
        const rereadTarget = mutationTargets.find((candidate) =>
          workspacePathsReferToSameFile(candidate, delegatedSource.target)
        ) || delegatedSource.target;
        const readToolAvailable = availableToolNames.has("read_file");
        const message = callbacks.getPreferredLanguage() === "zh"
          ? `PARENT_SOURCE_REREAD_REQUIRED: ${delegatedSource.target} 的证据由子智能体 ${delegatedSource.delegatedObservation?.owner.subagentId} 观察，join 只注入了紧凑引用，不能作为父任务已消费的源码窗口。${readToolAvailable ? `请先对 ${rereadTarget} 调用一次定向 read_file，再根据父任务实际看到的版本修改。` : `当前工具面缺少 read_file；请保持修改暂停，直到恢复契约重新开放该定向读取能力。`}`
          : `PARENT_SOURCE_REREAD_REQUIRED: evidence for ${delegatedSource.target} was observed by child ${delegatedSource.delegatedObservation?.owner.subagentId}; join injected only a compact reference, not parent-consumed source. ${readToolAvailable ? `Call one targeted read_file for ${rereadTarget}, then mutate from the version actually seen by the parent.` : "read_file is absent from the current tool surface; keep the mutation paused until the recovery contract exposes that targeted read."}`;
        toolFailureSignatures.delete(tc.id);
        callbacks.onToolDone(tc.name, target, message, {
          toolCallId: tc.id,
          internalFeedback: true,
          qualityGateReason: "subagent_parent_reread_required",
        });
        logAgentEvent("subagent_parent_reread_required", {
          iteration,
          tool: tc.name,
          target,
          rereadTarget,
          ownerSubagentId: delegatedSource.delegatedObservation?.owner.subagentId || null,
          sourceObservationKey: delegatedSource.delegatedObservation?.sourceObservationKey || null,
          sourceVersion: delegatedSource.delegatedObservation?.sourceVersion || null,
          sourceRange: delegatedSource.delegatedObservation?.sourceRange || null,
          readToolAvailable,
          failureKind: "policy",
        });
        preExecutionResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: message,
          displayContent: "",
          isError: false,
          lifecycleState: "completed",
          internalFeedback: true,
          qualityGateReason: "subagent_parent_reread_required",
        });
        continue;
      }
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
      toolPermissionPolicy,
      approvedLocalFileReadPaths,
      autoApproveToolScopes: callbacks.getAutoApproveToolScopes?.() || [],
      workflowMode,
      runtimeIntent,
      isPlanApproved: callbacks.getIsPlanApproved(),
      planTaskCount: callbacks.getPlanTasks().length,
      getToolTarget,
      isPreApprovalPlanDraftWrite,
      isExecutionPlanArtifactWrite,
      isTasksPlanWrite,
    });
    logAgentEvent("tool_permission_plan", {
      tool: tc.name,
      source: planned.source,
      risk: planned.risk,
      autoApproveToolScopes: callbacks.getAutoApproveToolScopes?.() || [],
      plannedAction: planned.action,
      sessionAutoApproved: planned.sessionAutoApproved,
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
      if (planned.sessionAutoApproved && planned.risk !== "local_file_read") {
        writeCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments, skipUserReview: true });
        if (isOrderSensitiveWorkspaceAction) sawOrderSensitiveWorkspaceAction = true;
        continue;
      }
      // A repeated delegation is still a new isolated run; never reuse the
      // read-only result cache for subagents.
      if (tc.name === "spawn_subagent" || tc.name === "wait_subagents") {
        readOnlyCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
        continue;
      }
      let effectiveToolArgs = toolArgs;
      // read_file has a dedicated cache keyed by path + range/options and
      // guarded by size/mtime. The generic cache is args-only and can replay a
      // pre-mutation result, so it must never own persistent file reads.
      const cacheableReadOnlyTool =
        tc.name !== "read_file" && shouldCacheReadOnlyToolResult(tc.name);
      let signature = buildReadOnlyCacheSignature(tc.name, effectiveToolArgs);
      let cached = cacheableReadOnlyTool ? readOnlyResultCache.get(signature) : undefined;
      const fileReadMetadata =
        tc.name === "read_file" && typeof toolArgs.path === "string"
          ? await readFileMetadataIfAvailable(toolArgs.path, workspace)
          : null;
      let fileReadSignature =
        tc.name === "read_file" && typeof toolArgs.path === "string"
          ? buildFileReadSignature(fileReadMetadata?.path ?? toolArgs.path, effectiveToolArgs)
          : "";
      let fileReadState = fileReadSignature ? fileReadStates.get(fileReadSignature) : undefined;
      if (fileReadMetadata) {
        const invalidatedSignatures = invalidateStaleFileReadStatesForPath({
          states: fileReadStates,
          path: fileReadMetadata.path,
          sizeBytes: fileReadMetadata.sizeBytes,
          modifiedMs: fileReadMetadata.modifiedMs,
        });
        invalidatedSignatures.forEach((key) => readOnlyDuplicateSkipCounts.delete(key));
        if (invalidatedSignatures.length > 0) {
          logAgentEvent("file_read_cache_invalidated", {
            iteration,
            target,
            reason: "path_metadata_epoch_changed",
            invalidatedCount: invalidatedSignatures.length,
            current: {
              sizeBytes: fileReadMetadata.sizeBytes,
              modifiedMs: fileReadMetadata.modifiedMs,
            },
          });
        }
        fileReadState = fileReadSignature ? fileReadStates.get(fileReadSignature) : undefined;
      }
      if (
        fileReadSignature &&
        queuedFileReadSignatures.has(fileReadSignature)
      ) {
        const content = [
          `${FILE_UNCHANGED_STUB}: an identical read_file path/range is already queued in this tool batch.`,
          "Reuse the other result from this batch; request a different start_line/end_line/max_lines window only if more source is needed.",
        ].join("\n");
        logAgentEvent("file_read_same_batch_duplicate", {
          iteration,
          target,
          signature: truncateForLog(fileReadSignature, 180),
        });
        preExecutionResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target,
          content,
            displayContent: `${FILE_UNCHANGED_STUB}: ${target}`,
            isError: false,
            ...(fileReadMetadata
              ? {
                  readFileObservation: buildFileReadObservationIdentity({
                    requestSignature: fileReadSignature,
                    path: fileReadMetadata.path,
                    sizeBytes: fileReadMetadata.sizeBytes,
                    modifiedMs: fileReadMetadata.modifiedMs,
                    source: "stub",
                  }),
                }
              : {}),
          });
        continue;
      }

      if (fileReadState) {
        const contentStillActive = isContentInActiveMessages(
          fileReadState.modelContent,
          managedAgentMessages,
        );
        const metadata = fileReadMetadata ?? await readFileMetadataIfAvailable(fileReadState.path, workspace);
        const unchanged =
          metadata != null &&
          metadata.sizeBytes === fileReadState.sizeBytes &&
          metadata.modifiedMs === fileReadState.modifiedMs;
        const contextEvictionEpoch = fileReadState.contextEvictionEpoch || 0;
        const eligibility = resolveReadFileEligibilityDecision({
          scopeMatches: true,
          hasCachedWindow: true,
          observedVersion: `${fileReadState.sizeBytes}:${fileReadState.modifiedMs}`,
          currentVersion: metadata
            ? `${metadata.sizeBytes}:${metadata.modifiedMs}`
            : null,
          contentInContext: contentStillActive,
          contextEpoch: contextEvictionEpoch,
          replayedContextEpoch: fileReadState.lastReplayContextEvictionEpoch,
        });

        if (!unchanged || eligibility.kind === "fresh_read") {
          fileReadStates.delete(fileReadSignature);
          logAgentEvent("file_read_cache_invalidated", {
            iteration,
            target: target || fileReadState.path,
            reason: eligibility.reason,
            eligibility: eligibility.kind,
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
          const replayedCurrentEviction =
            fileReadState.lastReplayContextEvictionEpoch === contextEvictionEpoch;
          if (
            eligibility.kind === "context_replay" &&
            !replayedCurrentEviction
          ) {
            // Context management, rather than the filesystem, may evict an
            // exact source window. Restore it once for each real eviction
            // epoch. This is deliberately not a lifetime read cap: another
            // compaction can restore the same unchanged version again, and a
            // mutation creates a fresh version. The independent approved-plan
            // no-progress budget prevents replay itself from becoming a loop.
            fileReadState.lastReplayContextEvictionEpoch = contextEvictionEpoch;
            fileReadState.replayCountSinceVersion = (fileReadState.replayCountSinceVersion || 0) + 1;
            const content = buildFileUnchangedReplayContent(fileReadState, duplicateCount);
            logAgentEvent("file_read_cache_hit", {
              iteration,
              target: target || fileReadState.path,
              decision: "context_evicted_replay",
              eligibilityReason: eligibility.reason,
              signature: truncateForLog(fileReadSignature, 180),
              duplicateCount,
              sizeBytes: fileReadState.sizeBytes,
              modifiedMs: fileReadState.modifiedMs,
              contentHash: fileReadState.contentHash,
            });
            preExecutionResults.push({
              toolCallId: tc.id,
              name: tc.name,
              target,
              content,
              displayContent: `CACHED_FILE_REPLAY: ${target || fileReadState.path}`,
              isError: false,
              readFileObservation: buildFileReadObservationIdentity({
                requestSignature: fileReadSignature,
                path: fileReadState.path,
                sizeBytes: fileReadState.sizeBytes,
                modifiedMs: fileReadState.modifiedMs,
                contentHash: fileReadState.contentHash,
                source: "replay",
              }),
            });
            continue;
          }
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
            eligibilityReason: eligibility.reason,
            signature: truncateForLog(fileReadSignature, 180),
            duplicateCount,
            sizeBytes: fileReadState.sizeBytes,
            modifiedMs: fileReadState.modifiedMs,
            contentHash: fileReadState.contentHash,
          });
          // An unchanged covered read is always a successful cache stub. Do
          // not manufacture a second approved-Plan failure path after an
          // arbitrary duplicate count; the RecoveryActionContract owns the
          // bounded semantic no-progress budget for this request.
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
          preExecutionResults.push({
            toolCallId: tc.id,
            name: tc.name,
            target,
            content,
            displayContent: `${FILE_UNCHANGED_STUB}: ${target || fileReadState.path}`,
            isError: false,
            readFileObservation: buildFileReadObservationIdentity({
              requestSignature: fileReadSignature,
              path: fileReadState.path,
              sizeBytes: fileReadState.sizeBytes,
              modifiedMs: fileReadState.modifiedMs,
              contentHash: fileReadState.contentHash,
              source: "stub",
            }),
          });
          continue;
        }
      }

      if (
        tc.name === "read_file" &&
        typeof toolArgs.path === "string" &&
        fileReadMetadata
      ) {
        const coverage = getReadFileCoverageForPath({
          states: fileReadStates,
          path: toolArgs.path,
          metadata: fileReadMetadata,
          currentSignature: fileReadSignature,
        });
        if (coverage.fullFileState && isContentInActiveMessages(coverage.fullFileState.modelContent, managedAgentMessages)) {
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
          preExecutionResults.push({
            toolCallId: tc.id,
            name: tc.name,
            target,
            content,
            displayContent: `${FILE_UNCHANGED_STUB}: ${target || coverage.fullFileState.path}`,
            isError: false,
            readFileObservation: buildFileReadObservationIdentity({
              // Identity belongs to the requested subrange, not the cached
              // full-file source that happened to cover it.
              requestSignature: fileReadSignature,
              path: fileReadMetadata.path,
              sizeBytes: coverage.fullFileState.sizeBytes,
              modifiedMs: coverage.fullFileState.modifiedMs,
              contentHash: coverage.fullFileState.contentHash,
              source: "stub",
            }),
          });
          continue;
        }

        if (coverage.ranges.length > 0) {
          const totalLines = Math.max(
            coverage.totalLines,
            ...coverage.ranges.map((range) => range.endLine),
          );
          const resolvedCoveragePlan = planReadFileWindowCoverage(effectiveToolArgs, totalLines, coverage.ranges);
          const targetPath = (fileReadMetadata?.path ?? toolArgs.path).toLowerCase();
          const areRangesActive = [...fileReadStates.values()]
            .filter(state => state.path.toLowerCase() === targetPath)
            .every(state => isContentInActiveMessages(state.modelContent, managedAgentMessages));
          if (resolvedCoveragePlan.fullyCovered && areRangesActive) {
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
            preExecutionResults.push({
              toolCallId: tc.id,
              name: tc.name,
              target,
              content,
              displayContent: `${FILE_UNCHANGED_STUB}: ${target || fileReadMetadata.path}`,
              isError: false,
              readFileObservation: buildFileReadObservationIdentity({
                requestSignature: fileReadSignature,
                path: fileReadMetadata.path,
                sizeBytes: fileReadMetadata.sizeBytes,
                modifiedMs: fileReadMetadata.modifiedMs,
                source: "stub",
              }),
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
              preExecutionResults.push({
                toolCallId: tc.id,
                name: tc.name,
                target,
                content,
                displayContent: `${FILE_UNCHANGED_STUB}: ${target || fileReadState.path}`,
                isError: false,
                readFileObservation: buildFileReadObservationIdentity({
                  requestSignature: fileReadSignature,
                  path: fileReadState.path,
                  sizeBytes: fileReadState.sizeBytes,
                  modifiedMs: fileReadState.modifiedMs,
                  contentHash: fileReadState.contentHash,
                  source: "stub",
                }),
              });
              continue;
            }
          }
        }
      }

      if (
        cacheableReadOnlyTool &&
        (cached || queuedReadOnlySignatures.has(signature))
      ) {
        const duplicateCount = (readOnlyDuplicateSkipCounts.get(signature) ?? 0) + 1;
        readOnlyDuplicateSkipCounts.set(signature, duplicateCount);
        const shouldPushReadOnlyRepeatLimit =
          duplicateCount >= (tc.name === "read_console" ? 2 : 8) &&
          (workflowMode === "edit" || workflowMode === "chat" || callbacks.getIsPlanApproved());
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
        const repeatLimitGuidance = shouldPushReadOnlyRepeatLimit
          ? buildGenericObservationContinuationPrompt(
              callbacks.getPreferredLanguage(),
              tc.name,
              target,
              duplicateCount,
            )
          : "";
        const closurePrompt = shouldPushPlanReadLimit
          ? `\n\n${buildPlanClosurePromptFromEvidence(callbacks, recentPlanToolActivity, attemptedPlanWriteTargets, latestUserPromptText)}`
          : "";
        preExecutionResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: shouldPushPlanReadLimit
            ? appendPlanRepeatReadLimitGuidance(
                `${duplicateContent}${closurePrompt}`,
                callbacks.getPreferredLanguage(),
                callbacks.getPlanStage(),
              )
            : repeatLimitGuidance
            ? `${repeatLimitGuidance}\n\n${duplicateContent}`
            : duplicateContent,
          displayContent: shouldPushReadOnlyRepeatLimit
            ? `READ_ONLY_REPEAT_LIMIT: ${target || tc.name}`
            : undefined,
          isError: false,
        });
        continue;
      }

      if (cacheableReadOnlyTool) {
        queuedReadOnlySignatures.add(signature);
        readOnlyCallSignatures.set(tc.id, signature);
      }
      if (fileReadSignature) {
        queuedFileReadSignatures.add(fileReadSignature);
        readOnlyCallSignatures.set(`${tc.id}:file_read`, fileReadSignature);
      }
      readOnlyCalls.push({
        id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(effectiveToolArgs),
        allowExternalLocalRead:
          !!planned.localFileReadPath &&
          (planned.risk === "local_file_read" ||
            isLocalFileReadApproved(planned.localFileReadPath, approvedLocalFileReadPaths)),
      });
    } else if (planned.action === "spec_file_auto_approved") {
      specFileCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
      if (isOrderSensitiveWorkspaceAction) sawOrderSensitiveWorkspaceAction = true;
    } else if (planned.action === "blocked_plan_gate") {
      if (planned.target) attemptedPlanWriteTargets.push(planned.target);
      preExecutionResults.push(buildPlanGateBlockedResult(tc, toolArgs, callbacks, planned.reason || "pre_approval_source_write"));
    } else if (planned.action === "blocked_unavailable") {
      const message = callbacks.getPreferredLanguage() === "zh"
        ? `工具 "${tc.name}" 当前没有暴露给 ${runtimeIntent} 运行意图。请使用本轮可用工具；如果这是已批准计划的执行步骤，请继续按执行阶段恢复。`
        : `Tool "${tc.name}" is not exposed for the current ${runtimeIntent} runtime intent. Use an available tool; if this is approved plan execution, continue from the execution stage.`;
      callbacks.onToolError(tc.name, planned.target, message, { toolCallId: tc.id });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target: planned.target,
        content: `Error: ${message}`,
        isError: true,
        lifecycleState: "blocked",
      });
    } else {
      const reviewSignature = tc.name === "browser_evaluate"
        ? buildBrowserValidationCacheSignature(toolArgs)
        : buildRepeatLoopSignature(tc.name, buildRepeatLoopArgsKey(toolArgs));
      const cachedBrowserValidation = tc.name === "browser_evaluate"
        ? browserValidationCache.get(reviewSignature)
        : undefined;
      if (cachedBrowserValidation) {
        const cachedContent = cachedBrowserValidation.content || cachedBrowserValidation.displayContent || "";
        const cachedBrowserFailed = cachedBrowserValidation.isError || !browserResultLooksSuccessful(cachedContent);
        logAgentEvent("browser_validation_reused_without_state_change", {
          iteration,
          target,
          signature: truncateForLog(reviewSignature, 180),
          previousResult: cachedBrowserFailed ? "failed" : "succeeded",
        });
        preExecutionResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target,
          content: [
            `REUSED_BROWSER_VALIDATION: identical browser_evaluate for ${target || "the same target"} already ran without a subsequent command or source mutation.`,
            cachedBrowserFailed
              ? "The previous validation failed. Do not rerun it unchanged; use the captured diagnostic to repair the page or change the validation target/arguments."
              : "Reuse the previous browser/DOM result and continue with the next unverified task or final summary.",
            "",
            truncateToolContent(cachedContent, 4000),
          ].filter(Boolean).join("\n"),
          displayContent: `${cachedBrowserFailed ? "REUSED_BROWSER_VALIDATION_FAILED" : "REUSED_BROWSER_VALIDATION"}: ${target || cachedBrowserValidation.target || "browser_evaluate"}`,
          isError: cachedBrowserFailed,
          lifecycleState: cachedBrowserFailed ? "failed" : "completed",
        });
        continue;
      }
      writeCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
      if (isOrderSensitiveWorkspaceAction) sawOrderSensitiveWorkspaceAction = true;
    }
  }

  return {
    readOnlyCalls,
    localFileReadCalls,
    specFileCalls,
    writeCalls,
    toolArgsByCallId,
    readOnlyCallSignatures,
    readFileWindowNarrowedNotes,
    toolFailureSignatures,
    preExecutionResults,
  };
}
