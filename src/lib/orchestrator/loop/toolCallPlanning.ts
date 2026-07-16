import {
  describeApprovedPlanRecoveryToolSurface,
  describeApprovedPlanSourceEditFirstToolSurface,
  shouldAllowApprovedPlanRecoveryFileRead,
} from "../../approvedPlanRecoveryTools";
import { resolveDevServerRuntimeState } from "../../devServerRuntime";
import {
  isExecuteRecoveryToolName,
  resolveExecuteRecoveryActionContract,
  type ExecutionDecisionCheckpoint,
  type RecoveryActionContract,
  type RecoveryReadLease,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";
import {
  EXECUTION_VERIFICATION_TOOL_NAMES,
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
  approvedPlanNeedsSourceEditBeforeValidation,
  filterPlanRuntimeToolDefinitionsForPhase,
  getOriginalUserPromptForPlanFallback,
  hasPlanUserContextObservation,
  isApprovedPlanRecoveryTool,
  isApprovedPlanSourceEditFirstTool,
  logAgentEvent,
} from "../../orchestrator";
import { summarizeRepeatedPlanTargetsFromToolActivity, type PlanToolActivitySummary } from "../../planExecutionRecovery";
import { assessPlanEvidenceReadiness } from "../../planReadOnlyConvergence";
import { shouldClosePlanToolSurfaceAfterReadOnlyConvergence } from "../../planRuntime";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import {
  normalizeIndependentDelegationScopeKeys,
  resolveDelegationDecision,
  type DelegationDecision,
  type DelegationRuntimePhase,
} from "../../subagents";
import type { ToolDefinition } from "../../toolSchemas";
import {
  resolveSubagentDelegationPreference,
  type TurnInputContextSignals,
} from "../../turnIntake";
import type { PlanRuntimePhase } from "../../workflowModels";
import { isWorkspaceMutationToolName } from "../../workspaceMutationTools";
import type { AgentMessage, OrchestratorCallbacks } from "../types";

export interface IterationToolSurfaceDecision {
  isExecuteRecoveryEligible: boolean;
  allowExecuteRecoveryFileRead: boolean;
  effectiveExecuteRecoveryFileRead: boolean;
  recoveryActionContract: RecoveryActionContract;
  approvedPlanSourceEditFirstActive: boolean;
  allowApprovedPlanRecoveryFileRead: boolean;
  delegationDecision: DelegationDecision;
  iterationAllTools: ToolDefinition[];
  availableToolNames: Set<string>;
}

export function resolveIterationToolSurface(input: {
  callbacks: OrchestratorCallbacks;
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  rawIterationAllTools: ToolDefinition[];
  executeRecoveryMode: ExecuteRecoveryMode;
  executeRecoveryReason: string;
  executeRecoveryAttempts: number;
  executeRecoveryExpectedTarget?: string | null;
  executeRecoveryReadLease?: RecoveryReadLease | null;
  executeRecoverySourceObservationKey?: string | null;
  executeRecoveryDecisionCheckpoint?: ExecutionDecisionCheckpoint | null;
  executeRecoveryProtocolNoProgressCount?: number;
  executeRecoveryProtocolNoProgressFingerprint?: string | null;
  recoveryIterationCount: number;
  maxRecoveryIterations: number;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  approvedPlanNoProgressRecoveryAttempts: number;
  approvedPlanLongReasoningNoActionCount: number;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  planRuntimePhase: PlanRuntimePhase;
  usedPlanReadOnlyConvergencePrompt: boolean;
  turnInputContextSignals: TurnInputContextSignals;
  lastAssistantTextForCheckpoint: string;
  latestUserPromptText?: string;
}): IterationToolSurfaceDecision {
  const {
    callbacks,
    iteration,
    workflowMode,
    runtimeIntent,
    rawIterationAllTools,
    executeRecoveryMode,
    executeRecoveryReason,
    executeRecoveryAttempts,
    executeRecoveryExpectedTarget,
    executeRecoveryReadLease,
    executeRecoverySourceObservationKey,
    executeRecoveryDecisionCheckpoint,
    executeRecoveryProtocolNoProgressCount = 0,
    executeRecoveryProtocolNoProgressFingerprint = null,
    recoveryIterationCount,
    maxRecoveryIterations,
    approvedPlanActionOnlyRecoveryActive,
    approvedPlanNoToolRecoveryFileReadActive,
    approvedPlanNoProgressRecoveryAttempts,
    approvedPlanLongReasoningNoActionCount,
    recentToolActivity,
    recentPlanToolActivity,
    planRuntimePhase,
    usedPlanReadOnlyConvergencePrompt,
    turnInputContextSignals,
    lastAssistantTextForCheckpoint,
    latestUserPromptText = "",
  } = input;

  const devServerRuntimeObservation = resolveDevServerRuntimeState(
    callbacks.getPlanExecutionEvidenceLedger(),
  );
  const isExecuteRecoveryEligible =
    (workflowMode === "edit" || (workflowMode === "plan" && callbacks.getIsPlanApproved())) &&
    isMutationRuntimeIntent(runtimeIntent) &&
    executeRecoveryMode !== "normal";
  const recoveryActionContract = resolveExecuteRecoveryActionContract(executeRecoveryMode, {
    expectedTarget: executeRecoveryExpectedTarget,
    readLease: executeRecoveryReadLease,
    sourceObservationKey: executeRecoverySourceObservationKey,
    decisionCheckpoint: executeRecoveryDecisionCheckpoint,
    phaseNoProgressCount: recoveryIterationCount,
    protocolNoProgressCount: executeRecoveryProtocolNoProgressCount,
    protocolNoProgressFingerprint: executeRecoveryProtocolNoProgressFingerprint,
    devServerStatus: devServerRuntimeObservation.status,
    devServerNextCapability: devServerRuntimeObservation.nextCapability,
    devServerUrl: devServerRuntimeObservation.url,
    ptyGeneration: devServerRuntimeObservation.foregroundGeneration,
    ptyOutputSequence: devServerRuntimeObservation.outputSequence,
  });
  const allowExecuteRecoveryFileRead = recoveryActionContract.allowTargetedFileRead;
  const effectiveExecuteRecoveryFileRead = recoveryActionContract.allowTargetedFileRead;
  const recoveryIterationAllTools = isExecuteRecoveryEligible
    ? rawIterationAllTools.filter((tool) => isExecuteRecoveryToolName(
        tool.function.name,
        PLAN_EXPLORATION_READ_ONLY_TOOLS,
        {
          mode: executeRecoveryMode,
          allowFileRead: allowExecuteRecoveryFileRead,
          contract: recoveryActionContract,
        },
      ))
    : rawIterationAllTools;
  if (isExecuteRecoveryEligible && recoveryIterationAllTools.length !== rawIterationAllTools.length) {
    logAgentEvent("execute_recovery_tool_scope_applied", {
      iteration,
      executeRecoveryMode,
      executeRecoveryReason,
      executeRecoveryAttempts,
      recoveryPhase: recoveryActionContract.phase,
      nextRequiredCapability: recoveryActionContract.nextRequiredCapability,
      phaseNoProgressCount: recoveryActionContract.phaseNoProgressCount,
      protocolNoProgressCount: recoveryActionContract.protocolNoProgressCount,
      protocolNoProgressFingerprint: recoveryActionContract.protocolNoProgressFingerprint,
      devServerStatus: recoveryActionContract.devServerStatus,
      devServerNextCapability: devServerRuntimeObservation.nextCapability,
      devServerUrl: recoveryActionContract.devServerUrl,
      ptyGeneration: recoveryActionContract.ptyGeneration,
      ptyOutputSequence: recoveryActionContract.ptyOutputSequence,
      allowFileRead: effectiveExecuteRecoveryFileRead,
      adaptiveFileReadAllowed: allowExecuteRecoveryFileRead,
      recoveryToolSurface: recoveryActionContract.surfaceDescription,
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
  const approvedPlanInitialSourceReadAllowed =
    approvedPlanSourceEditFirstActive &&
    runtimeIntent === "execute" &&
    recentPlanToolActivity.length === 0 &&
    callbacks.getPlanExecutionEvidenceLedger().length === 0;
  const approvedPlanPatchRecoveryFileReadAllowed =
    approvedPlanNoToolRecoveryFileReadActive ||
    shouldAllowApprovedPlanRecoveryFileRead(recentPlanToolActivity);
  // Source-edit execution may span several files. Keep the narrowly scoped
  // read_file tool available until a no-progress strategy switch explicitly
  // moves the loop to action-only recovery; cached-read guards still prevent
  // repeated exploration.
  const approvedPlanSourceEditFileReadAllowed =
    approvedPlanSourceEditFirstActive &&
    runtimeIntent === "execute" &&
    !approvedPlanActionOnlyRecoveryActive;
  const allowApprovedPlanRecoveryFileRead =
    approvedPlanSourceEditFileReadAllowed || approvedPlanPatchRecoveryFileReadAllowed;
  const preservePtyLifecycle =
    devServerRuntimeObservation.status === "pending" ||
    devServerRuntimeObservation.status === "running";

  if (executeRecoveryMode !== "normal" || approvedPlanActionOnlyRecoveryActive || approvedPlanNoToolRecoveryFileReadActive) {
    logAgentEvent("recovery_loop_summary", {
      iteration,
      workflowMode,
      runtimeIntent,
      executeRecoveryMode,
      executeRecoveryReason,
      executeRecoveryAttempts,
      recoveryPhase: recoveryActionContract.phase,
      nextRequiredCapability: recoveryActionContract.nextRequiredCapability,
      phaseNoProgressCount: recoveryActionContract.phaseNoProgressCount,
      protocolNoProgressCount: recoveryActionContract.protocolNoProgressCount,
      protocolNoProgressFingerprint: recoveryActionContract.protocolNoProgressFingerprint,
      recoveryIterationCount,
      maxRecoveryIterations,
      approvedPlanActionOnlyRecoveryActive,
      approvedPlanNoToolRecoveryFileReadActive,
      approvedPlanNoProgressRecoveryAttempts,
      approvedPlanLongReasoningNoActionCount,
      allowApprovedPlanRecoveryFileRead,
      recentPlanToolActivity: recentPlanToolActivity.length,
      repeatedTargets: summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity),
    });
  }

  const approvedPlanActionRecoveryActive =
    approvedPlanActionOnlyRecoveryActive &&
    workflowMode === "plan" &&
    callbacks.getIsPlanApproved();
  const executeContractOwnsSurface =
    isExecuteRecoveryEligible && recoveryActionContract.phase !== "normal";
  const initialBaseIterationAllTools =
    executeContractOwnsSurface
      ? recoveryIterationAllTools
      : approvedPlanActionRecoveryActive
      ? recoveryIterationAllTools.filter((tool) => isApprovedPlanRecoveryTool(tool, {
          allowFileRead: approvedPlanPatchRecoveryFileReadAllowed,
        }))
      : approvedPlanSourceEditFirstActive
      ? recoveryIterationAllTools.filter((tool) => isApprovedPlanSourceEditFirstTool(tool, {
          allowFileRead: allowApprovedPlanRecoveryFileRead,
          preservePtyLifecycle,
        }))
      : recoveryIterationAllTools;
  const recoveryScopesDelegation =
    executeRecoveryMode !== "normal" ||
    approvedPlanActionOnlyRecoveryActive ||
    approvedPlanNoToolRecoveryFileReadActive;
  const joinedChildNeedsParentReread = [...recentToolActivity, ...recentPlanToolActivity]
    .some((activity) => activity.delegatedObservation?.requiresParentReread === true);
  const canExposeParentReread =
    recoveryActionContract.phase === "normal" ||
    recoveryActionContract.phase === "context" ||
    recoveryActionContract.phase === "mutation";
  const extraRecoveryToolNames = new Set<string>();
  if (recoveryScopesDelegation) extraRecoveryToolNames.add("wait_subagents");
  if (joinedChildNeedsParentReread && canExposeParentReread) extraRecoveryToolNames.add("read_file");
  const baseIterationAllTools = extraRecoveryToolNames.size > 0
    ? [
        ...initialBaseIterationAllTools.filter((tool) =>
          !recoveryScopesDelegation || tool.function.name !== "spawn_subagent"
        ),
        ...rawIterationAllTools.filter((tool) =>
          extraRecoveryToolNames.has(tool.function.name) &&
          !initialBaseIterationAllTools.some((candidate) =>
            candidate.function.name === tool.function.name
          )
        ),
      ]
    : initialBaseIterationAllTools;
  if (
    !executeContractOwnsSurface &&
    approvedPlanSourceEditFirstActive &&
    baseIterationAllTools.length !== recoveryIterationAllTools.length
  ) {
    logAgentEvent("approved_plan_source_edit_first_tool_scope_applied", {
      iteration,
      allowFileRead: allowApprovedPlanRecoveryFileRead,
      preservePtyLifecycle,
      devServerRuntimeStatus: devServerRuntimeObservation.status,
      initialSourceReadAllowed: approvedPlanInitialSourceReadAllowed,
      sourceEditFileReadAllowed: approvedPlanSourceEditFileReadAllowed,
      recoveryToolSurface: describeApprovedPlanSourceEditFirstToolSurface(
        allowApprovedPlanRecoveryFileRead,
        preservePtyLifecycle,
      ),
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
  const delegationActivities = workflowMode === "plan" && !callbacks.getIsPlanApproved()
    ? recentPlanToolActivity
    : recentToolActivity;
  const recoveryPhase = recoveryActionContract.phase;
  // Once a turn has crossed a decisive mutation/validation boundary, a later
  // source reread must not make delegation look diagnostic again. Rereads are
  // expected during post-mutation checks and patch recovery; reopening child
  // fan-out there would regress the runtime into discovery at the most
  // resource-sensitive part of the transaction.
  const latestDecisiveRuntimeActivity = [...delegationActivities]
    .reverse()
    .find((activity) =>
      activity.status === "succeeded" &&
      (
        isWorkspaceMutationToolName(activity.name) ||
        EXECUTION_VERIFICATION_TOOL_NAMES.has(activity.name)
      )
    );
  let delegationPhase: DelegationRuntimePhase;
  if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
    delegationPhase = planRuntimePhase === "explore_structure"
      ? "context"
      : planRuntimePhase === "grounding" || planRuntimePhase === "needs_evidence"
      ? "diagnostic"
      : "finalization";
  } else if (recoveryPhase === "context") {
    delegationPhase = "context";
  } else if (recoveryPhase === "mutation") {
    delegationPhase = "mutation";
  } else if (
    recoveryPhase === "post_mutation_check" ||
    recoveryPhase === "validation" ||
    recoveryPhase === "reconcile"
  ) {
    delegationPhase = "validation";
  } else if (
    latestDecisiveRuntimeActivity &&
    isWorkspaceMutationToolName(latestDecisiveRuntimeActivity.name)
  ) {
    delegationPhase = "mutation";
  } else if (
    latestDecisiveRuntimeActivity &&
    EXECUTION_VERIFICATION_TOOL_NAMES.has(latestDecisiveRuntimeActivity.name)
  ) {
    delegationPhase = "validation";
  } else if (delegationActivities.some((activity) =>
    activity.status === "succeeded" && PLAN_EXPLORATION_READ_ONLY_TOOLS.has(activity.name)
  )) {
    delegationPhase = "diagnostic";
  } else {
    delegationPhase = "context";
  }
  const explicitScopeKeys = [
    ...(turnInputContextSignals.mentionedFilePaths || []),
    ...(turnInputContextSignals.attachedFilePaths || []),
  ];
  const observedScopeKeys = delegationActivities
    .filter((activity) =>
      activity.status === "succeeded" &&
      PLAN_EXPLORATION_READ_ONLY_TOOLS.has(activity.name) &&
      !!String(activity.target || "").trim() &&
      activity.target !== "."
    )
    .map((activity) => activity.target);
  const normalizedIndependentScopeKeys = normalizeIndependentDelegationScopeKeys([
    ...explicitScopeKeys,
    ...observedScopeKeys,
  ]);
  const explicitScopeCount = normalizeIndependentDelegationScopeKeys(explicitScopeKeys).length;
  const observedScopeCount = normalizeIndependentDelegationScopeKeys(observedScopeKeys).length;
  const pendingSubagentCount = callbacks.getPendingSubagentIds?.().length || 0;
  const plannedWorkItemCount = workflowMode === "plan"
    ? callbacks.getPlanTasks().length
    : 0;
  const delegationDecision = resolveDelegationDecision({
    preference: resolveSubagentDelegationPreference(latestUserPromptText),
    phase: delegationPhase,
    hasWorkspace: !!String(callbacks.getConfig?.().workspace || "").trim(),
    explicitScopeCount,
    observedScopeCount,
    plannedWorkItemCount,
    independentScopeKeys: normalizedIndependentScopeKeys,
    pendingSubagentCount,
    subagentDepth: callbacks.getSubagentDepth?.() || 0,
  });
  const delegationScopedIterationAllTools = delegationDecision.action === "admit"
    ? phaseScopedIterationAllTools
    : phaseScopedIterationAllTools.filter((tool) => tool.function.name !== "spawn_subagent");
  if (
    phaseScopedIterationAllTools.some((tool) => tool.function.name === "spawn_subagent") ||
    pendingSubagentCount > 0 ||
    delegationDecision.preference !== "unspecified"
  ) {
    logAgentEvent("delegation_admission_decision", {
      iteration,
      action: delegationDecision.action,
      reason: delegationDecision.reason,
      phase: delegationDecision.phase,
      preference: delegationDecision.preference,
      independentScopeCount: delegationDecision.independentScopeCount,
      explicitScopeCount: delegationDecision.explicitScopeCount,
      observedScopeCount: delegationDecision.observedScopeCount,
      plannedWorkItemCount: delegationDecision.plannedWorkItemCount,
      pendingSubagentCount: delegationDecision.pendingSubagentCount,
      spawnToolExposed: delegationDecision.action === "admit" &&
        phaseScopedIterationAllTools.some((tool) => tool.function.name === "spawn_subagent"),
      providerNeutral: true,
    });
  }
  const shouldClosePlanToolSurface = shouldClosePlanToolSurfaceAfterReadOnlyConvergence({
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
    planRuntimePhase,
    evidenceReadiness: assessPlanEvidenceReadiness({
      userGoal: getOriginalUserPromptForPlanFallback(callbacks),
      userContext: turnInputContextSignals,
      recentToolActivity: recentPlanToolActivity,
      hasObservedUserContext: hasPlanUserContextObservation(
        callbacks.getMessages() as AgentMessage[],
        lastAssistantTextForCheckpoint,
      ),
    }).status,
  });
  const iterationAllTools = shouldClosePlanToolSurface
    ? []
    : delegationScopedIterationAllTools;

  const shouldLogToolSurfaceDecision =
    rawIterationAllTools.length !== iterationAllTools.length ||
    executeRecoveryMode !== "normal" ||
    approvedPlanActionOnlyRecoveryActive ||
    approvedPlanNoToolRecoveryFileReadActive ||
    (workflowMode === "plan" && callbacks.getIsPlanApproved());
  if (shouldLogToolSurfaceDecision) {
    const rawToolNames = rawIterationAllTools.map((tool) => tool.function.name);
    const scopedToolNames = iterationAllTools.map((tool) => tool.function.name);
    const scopedToolNameSet = new Set(scopedToolNames);
    logAgentEvent("tool_surface_decision", {
      iteration,
      workflowMode,
      runtimeIntent,
      planStage: callbacks.getPlanStage(),
      isPlanApproved: callbacks.getIsPlanApproved(),
      executeRecoveryMode,
      executeRecoveryReason,
      approvedPlanSourceEditFirstActive,
      approvedPlanActionOnlyRecoveryActive,
      approvedPlanNoToolRecoveryFileReadActive,
      executeContractOwnsSurface,
      // Report the effective surface, not an upstream eligibility hint. Those
      // can legitimately be true while a later phase filter removes read_file.
      allowFileRead: scopedToolNameSet.has("read_file"),
      readFileExposed: scopedToolNameSet.has("read_file"),
      approvedPlanPatchRecoveryFileReadAllowed,
      approvedPlanSourceEditFileReadAllowed,
      recoveryToolSurface: approvedPlanActionRecoveryActive || approvedPlanNoToolRecoveryFileReadActive
        ? describeApprovedPlanRecoveryToolSurface(approvedPlanPatchRecoveryFileReadAllowed)
        : approvedPlanSourceEditFirstActive
        ? describeApprovedPlanSourceEditFirstToolSurface(
            allowApprovedPlanRecoveryFileRead,
            preservePtyLifecycle,
          )
        : recoveryActionContract.surfaceDescription,
      rawToolCount: rawToolNames.length,
      scopedToolCount: scopedToolNames.length,
      removedToolCount: Math.max(0, rawToolNames.length - scopedToolNames.length),
      removedTools: rawToolNames.filter((name) => !scopedToolNameSet.has(name)).slice(0, 24),
      scopedTools: scopedToolNames.slice(0, 24),
    });
  }

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

  return {
    isExecuteRecoveryEligible,
    allowExecuteRecoveryFileRead,
    effectiveExecuteRecoveryFileRead,
    recoveryActionContract,
    approvedPlanSourceEditFirstActive,
    allowApprovedPlanRecoveryFileRead,
    delegationDecision,
    iterationAllTools,
    availableToolNames: new Set(iterationAllTools.map((tool) => tool.function.name)),
  };
}
