import { shouldBypassApprovedPlanReadCacheForPatchRecovery } from "../../approvedPlanRecoveryTools";
import {
  FILE_UNCHANGED_STUB,
  buildFileReadSignature,
  buildFileUnchangedReplayContent,
  buildFileUnchangedStub,
  formatReadFileWindowCoverageStub,
  formatReadFileWindowNarrowedNote,
  getReadFileCoverageForPath,
  type FileReadState,
} from "../../orchestrator/fileReadCache";
import {
  countSuccessfulPlanReadEvidence,
  hasSuccessfulTabularActivity,
} from "../../orchestrator/planOrchestration";
import {
  appendPlanRepeatReadLimitGuidance,
  buildGenericObservationContinuationPrompt,
  buildPlanClosurePromptFromEvidence,
  buildPlanExplorationBudget,
  buildPlanGateBlockedResult,
  buildReadOnlyCacheSignature,
  emitToolPreflightBlocked,
  getSessionTaskTargetingEvidence,
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
import type { ResolvedUserIntent } from "../../runIntent";
import { initialLifecycleStateForPlanAction, planRuntimeToolCall } from "../../runtimeTools";
import { shouldBlockToolCallForTargeting, type TaskTargetingProfile } from "../../taskTargeting";
import { isLocalFileReadApproved, type ToolCapabilityRegistry, type ToolPermissionPolicy } from "../../toolCapabilities";
import type { MainThreadEventInput, MainThreadItem } from "../../turnEvents";
import type { PlanRuntimePhase } from "../../workflowModels";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
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
  effectiveExecuteRecoveryFileRead: boolean;
  readOnlyResultCache: Map<string, CachedReadOnlyToolResult>;
  readOnlyDuplicateSkipCounts: Map<string, number>;
  fileReadStates: Map<string, FileReadState>;
  approvedPlanBrowserValidationCache: Map<string, ToolExecutionResult>;
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
    effectiveExecuteRecoveryFileRead,
    readOnlyResultCache,
    readOnlyDuplicateSkipCounts,
    fileReadStates,
    approvedPlanBrowserValidationCache,
    iterationContext,
    emitTurnEvent,
  } = input;
  const { eventThreadId, eventTurnId } = iterationContext;

  const readOnlyCalls: ReadOnlyToolCallForRound[] = [];
  const localFileReadCalls: LocalFileReadToolCallForRound[] = [];
  const specFileCalls: ToolCallToExecute[] = [];
  const writeCalls: WriteToolCallForRound[] = [];
  const toolArgsByCallId = new Map<string, Record<string, unknown>>();
  const readOnlyCallSignatures = new Map<string, string>();
  const readFileWindowNarrowedNotes = new Map<string, string>();
  const queuedReadOnlySignatures = new Set<string>();
  const toolFailureSignatures = new Map<string, string>();
  const preExecutionResults: ToolExecutionResult[] = [];

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
        continue;
      }
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
        (workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          runtimeIntent === "execute" &&
          shouldBypassApprovedPlanReadCacheForPatchRecovery({
            toolName: tc.name,
            allowFileRead: allowApprovedPlanRecoveryFileRead,
          })) ||
        (workflowMode === "edit" &&
          runtimeIntent === "execute" &&
          tc.name === "read_file" &&
          effectiveExecuteRecoveryFileRead);
      if (bypassApprovedPlanPatchRecoveryReadCache) {
        logAgentEvent("approved_plan_patch_recovery_read_cache_bypass", {
          iteration,
          target,
          recentActivity: (workflowMode === "plan" ? recentPlanToolActivity : recentToolActivity)
            .slice(-4)
            .map((activity) => ({
              name: activity.name,
              target: activity.target,
              status: activity.status,
            })),
        });
      }

      if (fileReadState && !bypassApprovedPlanPatchRecoveryReadCache && isContentInActiveMessages(fileReadState.modelContent, managedAgentMessages)) {
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
              });
              continue;
            }
          }
        }
      }

      if (!bypassApprovedPlanPatchRecoveryReadCache && (cached || queuedReadOnlySignatures.has(signature))) {
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

      queuedReadOnlySignatures.add(signature);
      readOnlyCallSignatures.set(tc.id, signature);
      if (fileReadSignature) readOnlyCallSignatures.set(`${tc.id}:file_read`, fileReadSignature);
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
        preExecutionResults.push({
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
