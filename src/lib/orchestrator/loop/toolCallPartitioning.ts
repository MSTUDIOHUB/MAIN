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
  hashString,
  invalidateStaleFileReadStatesForPath,
  resolveReadFileEligibilityDecision,
  type FileReadState,
} from "../../orchestrator/fileReadCache";
import { readFileWindow } from "../../ipc";
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
  probeFileMetadataAvailability,
  readFileMetadataIfAvailable,
  truncateForLog,
  truncateToolContent,
  formatCachedReadOnlyToolResult,
} from "../../orchestrator";
import { planReadFileWindowCoverage } from "../../readFileWindow";
import {
  buildRepeatLoopArgsKey,
  buildRepeatLoopSignature,
  getShellMutationTargetForLoopGuard,
} from "../../repetitionGuard";
import type { ResolvedUserIntent } from "../../runIntent";
import { initialLifecycleStateForPlanAction, planRuntimeToolCall } from "../../runtimeTools";
import { shouldBlockToolCallForTargeting, type TaskTargetingProfile } from "../../taskTargeting";
import { isLocalFileReadApproved, type ToolCapabilityRegistry, type ToolPermissionPolicy } from "../../toolCapabilities";
import {
  getShellToolCwd,
  looksDangerousShellCommand,
  looksLongRunningShellCommand,
} from "../../toolExecutionContract";
import type { MainThreadEventInput, MainThreadItem } from "../../turnEvents";
import {
  isFinitePlanValidationCommand,
  type PlanRuntimePhase,
} from "../../workflowModels";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import {
  findSubagentScopeConflict,
  recordSubagentScopeBlockedTool,
  resolveSubagentScopedReadTargets,
  validateSubagentScopeTarget,
} from "../../subagents";
import {
  isAbsoluteWorkspacePath,
  workspacePathsReferToSameFile,
} from "../../workspacePaths";
import {
  isWorkspaceMutationToolCall,
  resolveWorkspaceMutationCreateOnlyTargets,
  resolveWorkspaceMutationCreationTargets,
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
import { hasStructuredWorkspaceMutationEvidence } from "./toolCallPlanning";
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

const SUBAGENT_SCOPE_NARROWABLE_READ_TOOLS = new Set([
  "grep_search",
  "find_symbol_references",
  "git_diff",
]);

function finiteValidationCheckpointMatchesArgs(input: {
  checkpoint: NonNullable<RecoveryActionContract["decisionCheckpoint"]>["pendingFiniteValidation"];
  args: Record<string, unknown>;
}): boolean {
  const checkpoint = input.checkpoint;
  if (!checkpoint) return true;
  const command = String(input.args.command || input.args.cmd || "").trim();
  if (command !== checkpoint.command.trim()) return false;
  if (getShellToolCwd(input.args) !== checkpoint.cwd) return false;
  if (checkpoint.timeoutMs !== undefined) {
    const requestedTimeout = Number(input.args.timeout_ms);
    if (!Number.isFinite(requestedTimeout) || requestedTimeout !== checkpoint.timeoutMs) {
      return false;
    }
  }
  return true;
}

function grepSearchPathLeavesWorkspace(args: Record<string, unknown>): boolean {
  const path = String(args.path || ".").trim().replace(/\\/g, "/");
  if (!path || path === "." || path === "./") return false;
  if (isAbsoluteWorkspacePath(path)) return true;
  return path.split("/").some((part) => part === "..");
}

export async function objectiveAuditTargetsMissingReadObservation(input: {
  mutationTargets: string[];
  knownTargets: string[];
  creationTargets?: string[];
  createOnlyTargets?: string[];
  fileReadStates: Map<string, FileReadState>;
  managedAgentMessages: AgentMessage[];
  workspace: string;
  readMetadata?: typeof readFileMetadataIfAvailable;
  probeMetadata?: typeof probeFileMetadataAvailability;
}): Promise<string[]> {
  const switchedTargets = input.mutationTargets.filter((target) =>
    !input.knownTargets.some((knownTarget) =>
      workspacePathsReferToSameFile(knownTarget, target)
    )
  );
  const missingTargets: string[] = [];
  for (const target of switchedTargets) {
    const isCreateOnlyTarget = (input.createOnlyTargets || []).some((creationTarget) =>
      workspacePathsReferToSameFile(creationTarget, target)
    );
    // apply_patch Add File is create-only: the patch executor rejects an
    // existing target atomically, so no nullable metadata inference is needed.
    if (isCreateOnlyTarget) continue;
    const isExplicitCreationCandidate = (input.creationTargets || []).some((creationTarget) =>
      workspacePathsReferToSameFile(creationTarget, target)
    );
    let verifiedTargetMetadata: Awaited<ReturnType<typeof readFileMetadataIfAvailable>> | undefined;
    if (isExplicitCreationCandidate) {
      const probe = await (input.probeMetadata || probeFileMetadataAvailability)(
        target,
        input.workspace,
      );
      // Only a confirmed ENOENT permits creation. Unknown IPC, permission, or
      // path-resolution failures stay blocked instead of being mistaken for
      // proof that write_file cannot overwrite anything.
      if (probe.status === "absent") continue;
      if (probe.status === "exists") verifiedTargetMetadata = probe.metadata;
    }
    const candidates = [...input.fileReadStates.values()]
      .filter((state) => workspacePathsReferToSameFile(state.path, target))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    let reusable = false;
    for (const state of candidates) {
      if (!isContentInActiveMessages(state.modelContent, input.managedAgentMessages)) continue;
      const metadata = verifiedTargetMetadata || await (
        input.readMetadata || readFileMetadataIfAvailable
      )(state.path, input.workspace);
      if (
        metadata &&
        metadata.sizeBytes === state.sizeBytes &&
        metadata.modifiedMs === state.modifiedMs
      ) {
        reusable = true;
        break;
      }
    }
    if (!reusable) missingTargets.push(target);
  }
  return missingTargets;
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
  if (
    input.toolName === "execute_command" &&
    (
      input.contract.nextRequiredCapability === "launch_long_process" ||
      input.contract.nextRequiredCapability === "recover_process"
    )
  ) {
    const command = input.command.trim();
    const reviewedLongProcess = input.plannedCommands.some(looksLongRunningShellCommand);
    const isSingleProcessCommand = !/(?:\r?\n|&&|\|\||[;&|<>`]|\$\()/u.test(command);
    return !reviewedLongProcess &&
      isSingleProcessCommand &&
      !looksDangerousShellCommand(command) &&
      looksLongRunningShellCommand(command);
  }
  if (input.toolName !== "run_command") return false;
  if (
    input.contract.nextRequiredCapability === "validation" &&
    input.plannedCommands.length === 0
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

export type DelegatedObservationReuseDecision = {
  reusable: boolean;
  reason:
    | "versioned_exact_mutation"
    | "parent_context_available"
    | "mutation_not_self_verifying"
    | "missing_source_identity"
    | "missing_content_hash"
    | "missing_content_length"
    | "missing_source_range"
    | "insufficient_source_coverage"
    | "current_version_unavailable"
    | "source_version_changed"
    | "current_content_hash_unavailable"
    | "source_content_changed"
    | "mutation_context_outside_observed_source";
};

export async function readCurrentDelegatedSourceContent(input: {
  activity: PlanToolActivitySummary;
  target: string;
  workspace: string;
  readWindow?: typeof readFileWindow;
}): Promise<{ content: string; contentHash: string } | null> {
  const delegated = input.activity.delegatedObservation;
  const sourceRange = delegated?.sourceRange;
  const sourceContentChars = delegated?.sourceContentChars;
  if (
    !sourceRange ||
    !Number.isFinite(sourceContentChars) ||
    Number(sourceContentChars) < 0
  ) return null;
  try {
    const payload = await (input.readWindow || readFileWindow)(
      input.target,
      input.workspace,
      sourceRange.startLine,
      sourceRange.endLine,
      Math.max(1, sourceRange.endLine - sourceRange.startLine + 1),
      Math.max(1, Math.floor(Number(sourceContentChars))),
    );
    if (
      payload.startLine !== sourceRange.startLine ||
      payload.endLine !== sourceRange.endLine ||
      payload.totalLines !== sourceRange.totalLines
    ) return null;
    const content = String(payload.content || "");
    return { content, contentHash: hashString(content) };
  } catch {
    return null;
  }
}

function isSingleTargetDelegatedUpdatePatch(
  patch: string,
  delegatedTarget: string,
): boolean {
  const operationLines = patch
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^\*\*\* (?:Update|Add|Delete) File:|^\*\*\* Move to:/u.test(line));
  if (operationLines.some((line) =>
    /^\*\*\* (?:Add|Delete) File:|^\*\*\* Move to:/u.test(line)
  )) return false;
  const updateTargets = operationLines.flatMap((line) => {
    const match = line.match(/^\*\*\* Update File:\s*(.+)$/u);
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  });
  return updateTargets.length === 1 &&
    workspacePathsReferToSameFile(updateTargets[0], delegatedTarget);
}

/**
 * Reuse a child read only for mutations whose own application contract checks
 * exact source context. Full-file writes and deletes still require a parent
 * read. Metadata is checked again for every attempted mutation, so a prior
 * successful write cannot reuse a stale child epoch.
 */
export function resolveVersionedDelegatedObservationReuse(input: {
  activity: PlanToolActivitySummary;
  mutationToolName: string;
  mutationArgs: Record<string, unknown>;
  currentVersion: string | null;
  currentContentHash: string | null;
  currentSourceContent: string | null;
}): DelegatedObservationReuseDecision {
  const delegated = input.activity.delegatedObservation;
  if (!delegated?.requiresParentReread) {
    return { reusable: true, reason: "parent_context_available" };
  }
  const selfVerifyingMutation = input.mutationToolName === "replace_in_file"
    ? String(input.mutationArgs.search_text || "").trim().length > 0
    : input.mutationToolName === "apply_patch" &&
      isSingleTargetDelegatedUpdatePatch(
        String(input.mutationArgs.patch || ""),
        input.activity.target,
      );
  if (!selfVerifyingMutation) {
    return { reusable: false, reason: "mutation_not_self_verifying" };
  }
  if (!delegated.sourceToolCallId || !delegated.sourceObservationKey || !delegated.sourceVersion) {
    return { reusable: false, reason: "missing_source_identity" };
  }
  if (!delegated.sourceContentHash) {
    return { reusable: false, reason: "missing_content_hash" };
  }
  if (!Number.isFinite(delegated.sourceContentChars)) {
    return { reusable: false, reason: "missing_content_length" };
  }
  if (!input.currentVersion) {
    return { reusable: false, reason: "current_version_unavailable" };
  }
  if (input.currentVersion !== delegated.sourceVersion) {
    return { reusable: false, reason: "source_version_changed" };
  }
  if (!input.currentContentHash || input.currentSourceContent === null) {
    return { reusable: false, reason: "current_content_hash_unavailable" };
  }
  if (input.currentContentHash !== delegated.sourceContentHash) {
    return { reusable: false, reason: "source_content_changed" };
  }
  if (!delegated.sourceRange) {
    return { reusable: false, reason: "missing_source_range" };
  }
  if (
    input.mutationToolName === "apply_patch" &&
    (
      delegated.sourceRange.truncated ||
      delegated.sourceRange.startLine !== 1 ||
      delegated.sourceRange.endLine < delegated.sourceRange.totalLines
    )
  ) {
    return { reusable: false, reason: "insufficient_source_coverage" };
  }
  if (
    input.mutationToolName === "replace_in_file" &&
    !input.currentSourceContent.includes(String(input.mutationArgs.search_text || ""))
  ) {
    return { reusable: false, reason: "mutation_context_outside_observed_source" };
  }
  return { reusable: true, reason: "versioned_exact_mutation" };
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
  // Runtime-owned fan-out targets for broad child reads. This sidecar never
  // enters model-authored JSON, so it cannot be forged by a child response.
  const scopedReadPathsByCallId = new Map<string, string[]>();
  const readOnlyCallSignatures = new Map<string, string>();
  const readFileWindowNarrowedNotes = new Map<string, string>();
  const queuedReadOnlySignatures = new Set<string>();
  const queuedFileReadSignatures = new Set<string>();
  const queuedBrowserValidationSignatures = new Set<string>();
  const toolFailureSignatures = new Map<string, string>();
  const preExecutionResults: ToolExecutionResult[] = [];
  let sawOrderSensitiveWorkspaceAction = false;
  let deferRemainingCallsForBatchOrder = false;
  const executeRecoveryContract = recoveryActionContract;
  const structuredMutationObserved = hasStructuredWorkspaceMutationEvidence({
    callbacks,
    recentToolActivity,
  });
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
    const subagentScope = callbacks.getSubagentScope?.() ?? null;
    if (subagentScope && SUBAGENT_SCOPE_NARROWABLE_READ_TOOLS.has(tc.name)) {
      const requestedPath = typeof toolArgs.path === "string" ? toolArgs.path : "";
      const scopeResolution = resolveSubagentScopedReadTargets({
        scope: subagentScope,
        requestedPath,
      });
      if (scopeResolution.action === "narrow" && scopeResolution.targets.length > 0) {
        toolArgs = { ...toolArgs, path: scopeResolution.targets[0] };
        tc.arguments = JSON.stringify(toolArgs);
        scopedReadPathsByCallId.set(tc.id, scopeResolution.targets);
        callbacks.onDebugEvent?.("subagent_scope_tool_args_narrowed", {
          iteration,
          tool: tc.name,
          scopeKey: subagentScope.scopeKey,
          requestedPath: scopeResolution.requestedPath,
          resolvedPath: scopeResolution.targets[0],
          resolvedPaths: scopeResolution.targets,
          reason: scopeResolution.reason,
          allowedPaths: subagentScope.allowedPaths,
        });
      }
    }
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

    const browserCallSignature = tc.name === "browser_evaluate"
      ? buildBrowserValidationCacheSignature(toolArgs)
      : null;
    const persistedBrowserFailureSignature =
      executeRecoveryState.decisionCheckpoint?.browserFailureCallSignature?.trim() || null;
    if (
      browserCallSignature &&
      persistedBrowserFailureSignature === browserCallSignature &&
      !browserValidationCache.has(browserCallSignature)
    ) {
      const previousDetail = String(
        executeRecoveryState.decisionCheckpoint?.browserFailureDetail ||
        "the same deterministic browser validation already failed",
      ).replace(/\s+/g, " ").trim().slice(0, 600);
      const locatorCandidates = (
        executeRecoveryState.decisionCheckpoint?.browserLocatorCandidates || []
      ).slice(0, 8);
      const message = callbacks.getPreferredLanguage() === "zh"
        ? [
            "BROWSER_VALIDATION_PERSISTED_FAILURE_REUSED: 完全相同的 browser_evaluate 已稳定失败，且此后没有页面或参数状态变化证据，本次未重新启动浏览器。",
            `既有失败：${previousDetail}`,
            locatorCandidates.length > 0
              ? `可用候选：${locatorCandidates.join(", ")}`
              : "请先修改 selector、actions、checks，或修复页面源码后再重新验证。",
          ].join("\n")
        : [
            "BROWSER_VALIDATION_PERSISTED_FAILURE_REUSED: this exact browser_evaluate already failed deterministically and no page or argument state change has been observed since, so the browser was not relaunched.",
            `Previous failure: ${previousDetail}`,
            locatorCandidates.length > 0
              ? `Available candidates: ${locatorCandidates.join(", ")}`
              : "Change the selector, actions, or checks, or repair the page source before validating again.",
          ].join("\n");
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: "browser_validation_persisted_failure_reused",
      });
      toolFailureSignatures.delete(tc.id);
      logAgentEvent("browser_validation_persisted_failure_reused", {
        iteration,
        target,
        signature: truncateForLog(browserCallSignature, 180),
        recoveryPhase: executeRecoveryContract.phase,
        nextRequiredCapability: executeRecoveryContract.nextRequiredCapability,
        browserFailureFingerprint:
          executeRecoveryState.decisionCheckpoint?.browserFailureFingerprint || null,
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: message,
        displayContent: `BROWSER_VALIDATION_PERSISTED_FAILURE_REUSED: ${target || "browser_evaluate"}`,
        isError: false,
        lifecycleState: "completed",
        internalFeedback: true,
        qualityGateReason: "browser_validation_persisted_failure_reused",
      });
      continue;
    }

    const finiteCommandRequestedThroughPty =
      tc.name === "execute_command" &&
      availableToolNames.has("run_command") &&
      isFinitePlanValidationCommand(String(toolArgs.command || ""));
    if (finiteCommandRequestedThroughPty) {
      const message = callbacks.getPreferredLanguage() === "zh"
        ? "FINITE_COMMAND_REQUIRES_RUN_COMMAND: 这是一次性构建、测试或诊断命令，未启动 PTY。请用 run_command 和相同 cwd 执行，以获得明确的 exitCode、stdout 和 stderr。"
        : "FINITE_COMMAND_REQUIRES_RUN_COMMAND: This is a finite build, test, or diagnostic command, so no PTY was started. Use run_command with the same cwd to obtain an explicit exitCode, stdout, and stderr.";
      toolFailureSignatures.delete(tc.id);
      emitToolPreflightBlocked(callbacks, {
        reason: "finite_command_requires_run_command",
        tool: tc.name,
        target,
        message,
        toolCallId: tc.id,
        lifecycleState: "blocked",
      });
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: "finite_command_requires_run_command",
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: message,
        displayContent: message,
        isError: false,
        lifecycleState: "blocked",
        internalFeedback: true,
        qualityGateReason: "finite_command_requires_run_command",
      });
      continue;
    }

    const pendingFiniteValidation =
      executeRecoveryContract.decisionCheckpoint?.pendingFiniteValidation || null;
    const mismatchedFiniteValidationCheckpoint =
      tc.name === "run_command" &&
      executeRecoveryContract.nextRequiredCapability === "validation" &&
      executeRecoveryState.reason !== "failed_finite_validation_command" &&
      pendingFiniteValidation &&
      !finiteValidationCheckpointMatchesArgs({
        checkpoint: pendingFiniteValidation,
        args: toolArgs,
      });
    if (mismatchedFiniteValidationCheckpoint) {
      const message = callbacks.getPreferredLanguage() === "zh"
        ? `FINITE_VALIDATION_CHECKPOINT_MISMATCH: 修复后的验收边界仍是 ${pendingFiniteValidation.command}（cwd=${pendingFiniteValidation.cwd}）。本次不同命令未执行，请原样重跑该验证。`
        : `FINITE_VALIDATION_CHECKPOINT_MISMATCH: The post-repair acceptance boundary remains ${pendingFiniteValidation.command} (cwd=${pendingFiniteValidation.cwd}). The different command did not run; rerun that validation unchanged.`;
      toolFailureSignatures.delete(tc.id);
      emitToolPreflightBlocked(callbacks, {
        reason: "finite_validation_checkpoint_mismatch",
        tool: tc.name,
        target,
        message,
        toolCallId: tc.id,
        lifecycleState: "blocked",
      });
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: "finite_validation_checkpoint_mismatch",
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: message,
        displayContent: message,
        isError: false,
        lifecycleState: "blocked",
        internalFeedback: true,
        qualityGateReason: "finite_validation_checkpoint_mismatch",
      });
      continue;
    }

    if (tc.name === "grep_search" && grepSearchPathLeavesWorkspace(toolArgs)) {
      const path = String(toolArgs.path || "").trim();
      const message = callbacks.getPreferredLanguage() === "zh"
        ? `WORKSPACE_SEARCH_SCOPE_BLOCKED: grep_search 只能搜索当前工作区，未搜索 ${path}。如需读取已知的外部依赖文件，请直接调用 read_file，并使用精确路径和行范围。`
        : `WORKSPACE_SEARCH_SCOPE_BLOCKED: grep_search is workspace-only, so ${path} was not searched. To inspect a known external dependency file, call read_file directly with its exact path and line range.`;
      toolFailureSignatures.delete(tc.id);
      emitToolPreflightBlocked(callbacks, {
        reason: "workspace_search_scope_blocked",
        tool: tc.name,
        target: path,
        message,
        toolCallId: tc.id,
        lifecycleState: "blocked",
      });
      callbacks.onToolDone(tc.name, path, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: "workspace_search_scope_blocked",
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target: path,
        content: message,
        displayContent: message,
        isError: false,
        lifecycleState: "blocked",
        internalFeedback: true,
        qualityGateReason: "workspace_search_scope_blocked",
      });
      continue;
    }

    const isAllowedPlanDraftMutation =
      workflowMode === "plan" &&
      !callbacks.getIsPlanApproved() &&
      isPreApprovalPlanDraftWrite(tc.name, toolArgs);
    const isSelectedCurrentRecoveryMutation =
      executeRecoveryBatchDecision.selectedCallId === tc.id &&
      isWorkspaceMutationToolCall(tc.name, toolArgs) &&
      (
        !executeRecoveryState.expectedTarget ||
        resolveWorkspaceMutationTargets(tc.name, toolArgs, target).some((mutationTarget) =>
          workspacePathsReferToSameFile(
            mutationTarget,
            executeRecoveryState.expectedTarget || "",
          )
        )
      );
    if (
      !availableToolNames.has(tc.name) &&
      !isAllowedPlanDraftMutation &&
      !isSelectedCurrentRecoveryMutation
    ) {
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
      const qualityGateReason = isExecuteRecoveryScopeCorrection
        ? "execute_recovery_scope_deferred"
        : isDelegationPolicyDeferral
        ? "subagent_delegation_deferred"
        : isReadScopeDeferred
        ? "read_scope_deferred"
        : "tool_unavailable_for_turn_phase";
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
        internalFeedback: true,
      });
      toolFailureSignatures.delete(tc.id);
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason,
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: message,
        isError: false,
        lifecycleState: "completed",
        qualityGateReason,
        internalFeedback: true,
        displayContent: "",
      });
      continue;
    }

    const longProcessBeforeFileMutation =
      callbacks.getCommandDirective?.()?.kind === "file_modify" &&
      !structuredMutationObserved &&
      (tc.name === "run_command" || tc.name === "execute_command") &&
      looksLongRunningShellCommand(toolArgs.command);
    if (longProcessBeforeFileMutation) {
      const language = callbacks.getPreferredLanguage();
      const message = language === "zh"
        ? "LONG_PROCESS_BEFORE_FILE_MUTATION_DEFERRED: 文件修改回合尚无结构化源码改动证据。请先用 apply_patch、replace_in_file 或 write_file 完成改动；开发服务器和其他长进程会在修改后验证阶段开放。"
        : "LONG_PROCESS_BEFORE_FILE_MUTATION_DEFERRED: This file-modification turn has no structured source mutation yet. Use apply_patch, replace_in_file, or write_file first; dev servers and other long processes become available in the post-mutation validation phase.";
      toolFailureSignatures.delete(tc.id);
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: "long_process_before_file_mutation_deferred",
      });
      logAgentEvent("long_process_before_file_mutation_deferred", {
        iteration,
        tool: tc.name,
        target,
        commandDirectiveKind: "file_modify",
        structuredMutationObserved: false,
        diskWritten: false,
        internalFeedback: true,
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
        qualityGateReason: "long_process_before_file_mutation_deferred",
      });
      continue;
    }

    const shellMutationTarget = getShellMutationTargetForLoopGuard(tc.name, toolArgs);
    if (
      callbacks.getCommandDirective?.()?.kind === "file_modify" &&
      shellMutationTarget
    ) {
      const language = callbacks.getPreferredLanguage();
      const message = language === "zh"
        ? `SHELL_SOURCE_MUTATION_DEFERRED: ${tc.name} 检测到写入动作 ${shellMutationTarget}。文件修改回合必须使用 apply_patch、replace_in_file 或 write_file，以保留 changedPaths、diff 和恢复证据；本次 shell 写入未执行。`
        : `SHELL_SOURCE_MUTATION_DEFERRED: ${tc.name} contains the write action ${shellMutationTarget}. File-modification turns must use apply_patch, replace_in_file, or write_file so changedPaths, diffs, and recovery evidence remain structured; this shell write did not run.`;
      toolFailureSignatures.delete(tc.id);
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: "shell_source_mutation_deferred",
      });
      logAgentEvent("shell_source_mutation_deferred", {
        iteration,
        tool: tc.name,
        target,
        shellMutationTarget,
        commandDirectiveKind: "file_modify",
        nativeMutationTools: ["apply_patch", "replace_in_file", "write_file"],
        diskWritten: false,
        internalFeedback: true,
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
        qualityGateReason: "shell_source_mutation_deferred",
      });
      continue;
    }

    if (
      executeRecoveryMode === "objective_audit" &&
      isWorkspaceMutationToolCall(tc.name, toolArgs)
    ) {
      const mutationTargets = resolveWorkspaceMutationTargets(tc.name, toolArgs, target);
      const creationTargets = resolveWorkspaceMutationCreationTargets(
        tc.name,
        toolArgs,
        target,
      );
      const createOnlyTargets = resolveWorkspaceMutationCreateOnlyTargets(
        tc.name,
        toolArgs,
      );
      const knownTargets = [
        ...(executeRecoveryState.decisionCheckpoint?.objectiveExpectedTargets || []),
        ...(executeRecoveryState.expectedTarget ? [executeRecoveryState.expectedTarget] : []),
      ];
      const missingReadTargets = await objectiveAuditTargetsMissingReadObservation({
        mutationTargets,
        knownTargets,
        creationTargets,
        createOnlyTargets,
        fileReadStates,
        managedAgentMessages,
        workspace,
      });
      if (missingReadTargets.length > 0) {
        const language = callbacks.getPreferredLanguage();
        const message = language === "zh"
          ? `OBJECTIVE_AUDIT_TARGET_READ_REQUIRED: closure audit 请求修改新目标 ${missingReadTargets.join(", ")}，但当前上下文没有这些文件仍有效的源码 observation。本次写入未执行；请先对新目标调用 read_file，再根据读取结果修改。`
          : `OBJECTIVE_AUDIT_TARGET_READ_REQUIRED: the closure audit requested a mutation to new target(s) ${missingReadTargets.join(", ")}, but the current context has no still-valid source observation for them. The write did not execute; call read_file for each new target before mutating it.`;
        toolFailureSignatures.delete(tc.id);
        callbacks.onToolDone(tc.name, target, message, {
          toolCallId: tc.id,
          internalFeedback: true,
          qualityGateReason: "objective_audit_target_read_required",
        });
        logAgentEvent("objective_audit_target_mutation_deferred", {
          iteration,
          tool: tc.name,
          mutationTargets,
          missingReadTargets,
          knownTargets,
          diskWritten: false,
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
          qualityGateReason: "objective_audit_target_read_required",
        });
        continue;
      }
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
        : new Set([
            "read_file",
            "read_file_window",
            "read_document",
            "get_file_outline",
            "code_ast_query",
            "list_directory",
          ] as string[]).has(tc.name)
          ? [directScopeTarget]
          : [];
    if (scopeTargets.length > 0) {
      const activeSubagentScope = callbacks.getSubagentScope?.() ?? null;
      const scopeConflict = activeSubagentScope ? null : scopeTargets
        .map((scopeTarget) => findSubagentScopeConflict({
          threadId: callbacks.getSessionKey(),
          targetPath: scopeTarget,
        }))
        .find(Boolean) || null;
      const scopeBlocked = activeSubagentScope
        ? scopeTargets.some((scopeTarget) =>
            !scopeTarget || !validateSubagentScopeTarget(activeSubagentScope, scopeTarget)
          )
        : !!scopeConflict;
      const parentScopeDeferred = !activeSubagentScope && !!scopeConflict;
      callbacks.onDebugEvent?.("delegation_scope_decision", {
        tool: tc.name,
        targets: scopeTargets,
        decision: parentScopeDeferred ? "deferred" : scopeBlocked ? "blocked" : "allowed",
        reason: parentScopeDeferred
          ? "overlapping_active_scope"
          : scopeBlocked ? "subagent_scope_escape" : "no_scope_conflict",
        agentKind: activeSubagentScope ? "subagent" : "parent",
        subagentId: activeSubagentScope?.subagentId || scopeConflict?.subagentId || null,
        scopeKey: activeSubagentScope?.scopeKey || scopeConflict?.scopeKey || null,
      });
      if (scopeBlocked) {
        const message = activeSubagentScope
          ? `SUBAGENT_SCOPE_BLOCKED: ${tc.name} targets '${scopeTargets.join(", ") || "<missing path>"}' are outside allowed_paths for scope '${activeSubagentScope.scopeKey}'.`
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
          const childScope = activeSubagentScope!;
          const firstBlockedCallForTool = recordSubagentScopeBlockedTool(childScope, tc.name);
          callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
          callbacks.onDebugEvent?.("subagent_scope_tool_quarantined", {
            iteration,
            tool: tc.name,
            scopeKey: childScope.scopeKey,
            targets: scopeTargets,
            firstBlockedCallForTool,
            nextSurfaceAction: "remove_tool",
          });
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
      const policyReason = failureCount >= 3
        ? "repeated_failure_exhausted"
        : "repeated_failure_blocked";
      failedToolCallCounts.set(failureSignature, failureCount + 1);
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
        ? `${policyReason.toUpperCase()}: ${tc.name}${target ? ` (${target})` : ""} 已用相同参数连续失败。请改变参数、目标或工具，不要原样重试。`
        : `${policyReason.toUpperCase()}: ${tc.name}${target ? ` (${target})` : ""} has failed repeatedly with identical arguments. Change arguments, target, or tool instead of retrying unchanged.`;
      const _recentActivity = recentPlanToolActivity.slice(-MAX_RECENT_PLAN_TOOL_ACTIVITY);
      const _evidenceKeys = Array.from(getSessionTaskTargetingEvidence(callbacks.getSessionKey())).slice(0, 20);
      emitToolPreflightBlocked(callbacks, {
        reason: policyReason,
        tool: tc.name,
        target,
        message,
        toolCallId: tc.id,
        lifecycleState: "blocked",
        evidenceChain: _recentActivity.length > 0 || _evidenceKeys.length > 0
          ? { recentToolActivity: JSON.stringify(_recentActivity.slice(-6).map((a) => `${a.name}->${a.target}`)), evidenceKeys: _evidenceKeys }
          : undefined,
      });
      // This call never reached the executor. Keep the two real failures as
      // evidence, but do not let the policy response become a third failure
      // or feed the global fatal repeat guard.
      toolFailureSignatures.delete(tc.id);
      callbacks.onToolDone(tc.name, target, message, {
        toolCallId: tc.id,
        internalFeedback: true,
        qualityGateReason: policyReason,
      });
      preExecutionResults.push({
        toolCallId: tc.id,
        name: tc.name,
        target,
        content: message,
        displayContent: message,
        isError: false,
        internalFeedback: true,
        qualityGateReason: policyReason,
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
        const delegatedMetadata = await readFileMetadataIfAvailable(rereadTarget, workspace);
        const currentVersion = delegatedMetadata
          ? `${delegatedMetadata.sizeBytes}:${delegatedMetadata.modifiedMs}`
          : null;
        const currentSource = await readCurrentDelegatedSourceContent({
          activity: delegatedSource,
          target: rereadTarget,
          workspace,
        });
        const reuseDecision = resolveVersionedDelegatedObservationReuse({
          activity: delegatedSource,
          mutationToolName: tc.name,
          mutationArgs: toolArgs,
          currentVersion,
          currentContentHash: currentSource?.contentHash || null,
          currentSourceContent: currentSource?.content ?? null,
        });
        if (reuseDecision.reusable) {
          logAgentEvent("subagent_versioned_evidence_reused", {
            iteration,
            tool: tc.name,
            target,
            sourceTarget: delegatedSource.target,
            ownerSubagentId: delegatedSource.delegatedObservation?.owner.subagentId || null,
            sourceToolCallId: delegatedSource.delegatedObservation?.sourceToolCallId || null,
            sourceObservationKey: delegatedSource.delegatedObservation?.sourceObservationKey || null,
            sourceVersion: delegatedSource.delegatedObservation?.sourceVersion || null,
            sourceContentHash: delegatedSource.delegatedObservation?.sourceContentHash || null,
            currentContentHash: currentSource?.contentHash || null,
            currentVersion,
            reason: reuseDecision.reason,
            safetyContract: "self_verifying_mutation",
          });
        } else {
          const readToolAvailable = availableToolNames.has("read_file");
          const message = callbacks.getPreferredLanguage() === "zh"
            ? `PARENT_SOURCE_REREAD_REQUIRED: ${delegatedSource.target} 的子智能体证据不能安全复用（${reuseDecision.reason}）。${readToolAvailable ? `请先对 ${rereadTarget} 调用一次定向 read_file，再根据父任务实际看到的版本修改。` : `当前工具面缺少 read_file；请保持修改暂停，直到恢复契约重新开放该定向读取能力。`}`
            : `PARENT_SOURCE_REREAD_REQUIRED: child evidence for ${delegatedSource.target} cannot be reused safely (${reuseDecision.reason}). ${readToolAvailable ? `Call one targeted read_file for ${rereadTarget}, then mutate from the version actually seen by the parent.` : "read_file is absent from the current tool surface; keep the mutation paused until the recovery contract exposes that targeted read."}`;
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
            sourceContentHash: delegatedSource.delegatedObservation?.sourceContentHash || null,
            currentContentHash: currentSource?.contentHash || null,
            sourceRange: delegatedSource.delegatedObservation?.sourceRange || null,
            currentVersion,
            reuseReason: reuseDecision.reason,
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
      const scopedReadPaths = scopedReadPathsByCallId.get(tc.id) || [];
      const buildEffectiveReadSignature = (args: Record<string, unknown>) =>
        buildReadOnlyCacheSignature(
          tc.name,
          scopedReadPaths.length > 1
            ? {
                ...args,
                __runtime_scoped_read_paths: [...scopedReadPaths].sort(),
              }
            : args,
        );
      let signature = buildEffectiveReadSignature(effectiveToolArgs);
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
            signature = buildEffectiveReadSignature(effectiveToolArgs);
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
        ...(scopedReadPaths.length > 0 ? { scopedReadPaths } : {}),
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
      if (
        tc.name === "browser_evaluate" &&
        queuedBrowserValidationSignatures.has(reviewSignature)
      ) {
        const message = callbacks.getPreferredLanguage() === "zh"
          ? "BROWSER_VALIDATION_BATCH_DUPLICATE_DEFERRED: 同一批次已经安排了参数完全相同的 browser_evaluate。本次重复调用未执行；请先使用首次调用返回的 DOM、locator、断言与错误证据。"
          : "BROWSER_VALIDATION_BATCH_DUPLICATE_DEFERRED: an identical browser_evaluate is already scheduled in this batch. This duplicate did not run; consume the first call's DOM, locator, assertion, and error evidence.";
        callbacks.onToolDone(tc.name, target, message, {
          toolCallId: tc.id,
          internalFeedback: true,
          qualityGateReason: "browser_validation_batch_duplicate",
        });
        toolFailureSignatures.delete(tc.id);
        logAgentEvent("browser_validation_batch_duplicate_deferred", {
          iteration,
          target,
          signature: truncateForLog(reviewSignature, 180),
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
          qualityGateReason: "browser_validation_batch_duplicate",
        });
        continue;
      }
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
      if (tc.name === "browser_evaluate") {
        queuedBrowserValidationSignatures.add(reviewSignature);
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
