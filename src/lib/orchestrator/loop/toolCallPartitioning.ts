import { shouldBypassApprovedPlanReadCacheForPatchRecovery } from "../../approvedPlanRecoveryTools";
import {
  resolveExecuteRecoveryBatchDecision,
  shouldUseExecutePatchRecoveryReadLease,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";
import { resolveApprovedPlanMutationScope } from "../../approvedPlanExecutionScope";
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
  isReadOnlyShellInspectionToolCall,
} from "../../repetitionGuard";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import { initialLifecycleStateForPlanAction, planRuntimeToolCall } from "../../runtimeTools";
import { shouldBlockToolCallForTargeting, type TaskTargetingProfile } from "../../taskTargeting";
import { isLocalFileReadApproved, type ToolCapabilityRegistry, type ToolPermissionPolicy } from "../../toolCapabilities";
import type { MainThreadEventInput, MainThreadItem } from "../../turnEvents";
import type { PlanRuntimePhase } from "../../workflowModels";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { findSubagentScopeConflict, validateSubagentScopeTarget } from "../../subagents";
import { workspacePathsReferToSameFile } from "../../workspacePaths";
import {
  isWorkspaceMutationToolCall,
  resolveWorkspaceMutationTargets,
} from "../../workspaceMutationTools";
import { shouldCacheReadOnlyToolResult } from "../../readOnlyToolCachePolicy";
import {
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
  approvedPlanActionOnlyRecoveryActive: boolean;
  allowApprovedPlanRecoveryFileRead: boolean;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  effectiveExecuteRecoveryFileRead: boolean;
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
    approvedPlanActionOnlyRecoveryActive,
    allowApprovedPlanRecoveryFileRead,
    executeRecoveryState,
    effectiveExecuteRecoveryFileRead,
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
  let approvedPlanPatchRecoveryReadLeaseClaimed = false;
  let executePatchRecoveryReadLeaseClaimed = false;
  let sawOrderSensitiveWorkspaceAction = false;
  let deferRemainingCallsForBatchOrder = false;
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
    const failureSignature = buildRepeatLoopSignature(tc.name, buildRepeatLoopArgsKey(toolArgs));
    toolFailureSignatures.set(tc.id, failureSignature);

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
      if (executeRecoveryBatchDecision.active) {
        logAgentEvent("execute_recovery_unavailable_tool_call", {
          iteration,
          phase: executeRecoveryBatchDecision.phase,
          mode: executeRecoveryMode,
          tool: tc.name,
          target,
          expectedTarget: executeRecoveryState.expectedTarget,
          availableToolNames: Array.from(availableToolNames).slice(0, 12),
          outcome: "blocked_before_batch_deferral",
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
        internalFeedback: isUnapprovedPlanContext,
      });
      if (!isUnapprovedPlanContext) {
        callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
      }
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: `Error: ${message}`,
        isError: true,
        lifecycleState: "blocked",
        ...(executeRecoveryBatchDecision.active
          ? { qualityGateReason: "execute_recovery_tool_unavailable" }
          : {}),
        ...(isUnapprovedPlanContext ? { internalFeedback: true, displayContent: "" } : {}),
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
      const selectedTool = executeRecoveryBatchDecision.selectedToolName || (
        executeRecoveryBatchDecision.phase === "need_context"
          ? "read_file"
          : executeRecoveryBatchDecision.phase === "need_mutation"
            ? "apply_patch/replace_in_file/write_file"
            : "run_command/browser_evaluate"
      );
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
      const message = language === "zh"
        ? `EXECUTE_RECOVERY_BATCH_DEFERRED: 当前恢复事务处于 ${executeRecoveryBatchDecision.phase}，本批只执行一个 ${selectedTool}。${tc.name} 已推迟；请先消费本批工具结果，再在下一条回复中调用下一阶段的一个工具。${expectedTargetHint}`
        : `EXECUTE_RECOVERY_BATCH_DEFERRED: The recovery transaction is in ${executeRecoveryBatchDecision.phase}; this batch executes only one ${selectedTool}. ${tc.name} was deferred. Consume this tool result, then call one tool for the next phase in the next response.${expectedTargetHint}`;
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: "execute_recovery_batch_deferred",
      });
      logAgentEvent("execute_recovery_batch_call_deferred", {
        iteration,
        phase: executeRecoveryBatchDecision.phase,
        selectedCallId: executeRecoveryBatchDecision.selectedCallId,
        selectedTool: executeRecoveryBatchDecision.selectedToolName,
        deferredCallId: tc.id,
        deferredTool: tc.name,
        target,
        expectedTarget: executeRecoveryState.expectedTarget,
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
        qualityGateReason: "execute_recovery_batch_deferred",
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
      callbacks.onDebugEvent?.("delegation_scope_decision", {
        tool: tc.name,
        targets: scopeTargets,
        decision: scopeBlocked ? "blocked" : "allowed",
        agentKind: subagentScope ? "subagent" : "parent",
        subagentId: subagentScope?.subagentId || scopeConflict?.subagentId || null,
        scopeKey: subagentScope?.scopeKey || scopeConflict?.scopeKey || null,
      });
      if (scopeBlocked) {
        const message = subagentScope
          ? `SUBAGENT_SCOPE_BLOCKED: ${tc.name} targets '${scopeTargets.join(", ") || "<missing path>"}' are outside allowed_paths for scope '${subagentScope.scopeKey}'.`
          : `PARENT_SCOPE_OWNED_BY_SUBAGENT: '${scopeTargets.join(", ")}' overlaps the lease held by ${scopeConflict?.subagentId} (${scopeConflict?.scopeKey}). Continue non-overlapping work and call wait_subagents before accessing it.`;
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
        const sourceBody = String(latestRead?.modelContent || "")
          .replace(/^[\s\S]*?---CONTENT START---\s*/i, "")
          .replace(/\s*---CONTENT END---[\s\S]*$/i, "");
        const sourceLineCount = sourceBody ? sourceBody.split(/\r?\n/).length : Number.POSITIVE_INFINITY;
        const snapshotStillCurrent = !!latestRead && !!currentMeta &&
          latestRead.sizeBytes === currentMeta.sizeBytes &&
          latestRead.modifiedMs === currentMeta.modifiedMs;
        const fullWriteAllowed = sourceLineCount <= 400 && snapshotStillCurrent;
        callbacks.onDebugEvent?.("patch_recovery_full_write_decision", {
          target,
          failedPatchCount,
          sourceLineCount: Number.isFinite(sourceLineCount) ? sourceLineCount : null,
          snapshotStillCurrent,
          decision: fullWriteAllowed ? "allowed" : "blocked",
          latestReadHash: latestRead?.contentHash || null,
        });
        if (!fullWriteAllowed) {
          const message = `WRITE_FILE_AFTER_PATCH_FAILURE_BLOCKED: ${failedPatchCount} precise patches failed for '${target}'. Full-file replacement requires a current complete read of at most 400 lines whose size and modified-time still match the latest read snapshot.`;
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
        const failed = browserPreflight.runtimeStatus === "failed" || browserPreflight.runtimeStatus === "stopped";
        const message = failed
          ? `DEV_SERVER_START_FAILED: the latest PTY observation shows that the dev server failed. Repair or restart it, then inspect PTY readiness before browser validation at ${requestedUrl}.`
          : `DEV_SERVER_NOT_READY: the latest long-running command is still ${browserPreflight.runtimeStatus}. Call read_pty_since/read_pty_tail/get_pty_status and wait for a ready URL before browser validation at ${requestedUrl}.`;
        // The browser tool did not execute, so this transient readiness gate must not
        // poison the repeated-failure history for a later, ready browser validation.
        toolFailureSignatures.delete(tc.id);
        callbacks.onToolError(tc.name, requestedUrl, message, { toolCallId: tc.id });
        logAgentEvent("browser_validation_blocked_until_dev_server_ready", {
          iteration,
          requestedUrl,
          runtimeStatus: browserPreflight.runtimeStatus,
          ptyObservationToolsAvailable: ["read_pty_since", "read_pty_tail", "get_pty_status"]
            .filter((name) => availableToolNames.has(name)),
        });
        preExecutionResults.push({
          toolCallId: tc.id,
          name: tc.name,
          target: requestedUrl,
          content: `Error: ${message}`,
          isError: true,
          lifecycleState: "blocked",
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

    const approvedPlanMutationScope = resolveApprovedPlanMutationScope({
      workflowMode,
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
      const bypassApprovedPlanPatchRecoveryReadCache =
        !approvedPlanPatchRecoveryReadLeaseClaimed &&
        workflowMode === "plan" &&
        callbacks.getIsPlanApproved() &&
        isMutationRuntimeIntent(runtimeIntent) &&
        shouldBypassApprovedPlanReadCacheForPatchRecovery({
          toolName: tc.name,
          allowFileRead: allowApprovedPlanRecoveryFileRead,
          target,
          recentActivity: recentPlanToolActivity,
        });
      const bypassExecutePatchRecoveryReadCache =
        workflowMode === "edit" &&
        isMutationRuntimeIntent(runtimeIntent) &&
        shouldUseExecutePatchRecoveryReadLease({
          toolName: tc.name,
          allowFileRead: effectiveExecuteRecoveryFileRead,
          target,
          recentActivity: recentToolActivity,
          leaseClaimed: executePatchRecoveryReadLeaseClaimed,
        });
      if (bypassApprovedPlanPatchRecoveryReadCache) approvedPlanPatchRecoveryReadLeaseClaimed = true;
      if (bypassExecutePatchRecoveryReadCache) executePatchRecoveryReadLeaseClaimed = true;
      const bypassPatchRecoveryReadCache =
        bypassApprovedPlanPatchRecoveryReadCache || bypassExecutePatchRecoveryReadCache;
      if (bypassPatchRecoveryReadCache) {
        logAgentEvent(
          bypassApprovedPlanPatchRecoveryReadCache
            ? "approved_plan_patch_recovery_read_cache_bypass"
            : "execute_patch_recovery_read_cache_bypass",
          {
            iteration,
            target,
            leaseScope: "one_targeted_read_per_batch",
            recentActivity: (workflowMode === "plan" ? recentPlanToolActivity : recentToolActivity)
              .slice(-4)
              .map((activity) => ({
                name: activity.name,
                target: activity.target,
                status: activity.status,
              })),
          },
        );
      }

      if (
        fileReadSignature &&
        queuedFileReadSignatures.has(fileReadSignature) &&
        !bypassPatchRecoveryReadCache
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

      if (fileReadState && !bypassPatchRecoveryReadCache) {
        const contentStillActive = isContentInActiveMessages(
          fileReadState.modelContent,
          managedAgentMessages,
        );
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
          if (!contentStillActive) {
            // Context compaction may evict the tool message while the runtime
            // still owns the exact versioned window. Replay the retained
            // source so the model can use it, but mark it as an observation
            // replay rather than fresh execution progress. A successful
            // mutation invalidates this state before a post-edit read.
            const content = buildFileUnchangedReplayContent(fileReadState, duplicateCount);
            logAgentEvent("file_read_cache_hit", {
              iteration,
              target: target || fileReadState.path,
              decision: "context_evicted_replay",
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
            signature: truncateForLog(fileReadSignature, 180),
            duplicateCount,
            sizeBytes: fileReadState.sizeBytes,
            modifiedMs: fileReadState.modifiedMs,
            contentHash: fileReadState.contentHash,
          });
          const replayApprovedExecutionRead =
            workflowMode === "plan" &&
            callbacks.getIsPlanApproved() &&
            runtimeIntent === "execute" &&
            tc.name === "read_file" &&
            duplicateCount >= 2 &&
            !shouldPushPlanReadLimit;
          const shouldPushApprovedPlanReadLimit =
            replayApprovedExecutionRead &&
            duplicateCount >= 3;
          const approvedPlanReadLimitMessage = shouldPushApprovedPlanReadLimit
            ? callbacks.getPreferredLanguage() === "zh"
              ? [
                  `READ_FILE_REPEAT_LIMIT: ${target || fileReadState.path} 已在已批准计划执行中重复读取，本次不再重新读取。`,
                  "请复用上方缓存内容，改为 apply_patch/replace_in_file/write_file、运行验证，或说明明确阻塞。",
                ].join("\n")
              : [
                  `READ_FILE_REPEAT_LIMIT: ${target || fileReadState.path} was reread repeatedly during approved plan execution, so this read was not re-run.`,
                  "Reuse the cached context and switch to apply_patch/replace_in_file/write_file, validation, or a concrete blocker.",
                ].join("\n")
            : "";
          if (shouldPushApprovedPlanReadLimit) {
            emitToolPreflightBlocked(callbacks, {
              reason: "read_file_repeat_limit",
              tool: tc.name,
              target: target || fileReadState.path,
              message: approvedPlanReadLimitMessage,
              toolCallId: tc.id,
              lifecycleState: "completed",
            });
          }
          const baseStub = shouldPushApprovedPlanReadLimit
            ? approvedPlanReadLimitMessage
            : replayApprovedExecutionRead
            ? buildFileUnchangedReplayContent(fileReadState, duplicateCount)
            : buildFileUnchangedStub(fileReadState);
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
            displayContent: shouldPushApprovedPlanReadLimit
              ? `READ_FILE_REPEAT_LIMIT: ${target || fileReadState.path}`
              : `${FILE_UNCHANGED_STUB}: ${target || fileReadState.path}`,
            isError: false,
            readFileObservation: buildFileReadObservationIdentity({
              requestSignature: fileReadSignature,
              path: fileReadState.path,
              sizeBytes: fileReadState.sizeBytes,
              modifiedMs: fileReadState.modifiedMs,
              contentHash: fileReadState.contentHash,
              source: replayApprovedExecutionRead ? "replay" : "stub",
            }),
          });
          continue;
        }
      }

      if (
        tc.name === "read_file" &&
        typeof toolArgs.path === "string" &&
        fileReadMetadata &&
        !bypassPatchRecoveryReadCache
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
        !bypassPatchRecoveryReadCache &&
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
