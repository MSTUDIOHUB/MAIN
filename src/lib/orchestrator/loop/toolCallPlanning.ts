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
  filterPlanRuntimeToolDefinitionsForPhase,
  getOriginalUserPromptForPlanFallback,
  hasPlanVisualContextGrounding,
  logAgentEvent,
} from "../../orchestrator";
import { summarizeRepeatedPlanTargetsFromToolActivity, type PlanToolActivitySummary } from "../../planExecutionRecovery";
import { assessPlanEvidenceReadiness } from "../../planReadOnlyConvergence";
import { shouldClosePlanToolSurfaceAfterReadOnlyConvergence } from "../../planRuntime";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import {
  getSubagentAdmissionHealth,
  normalizeIndependentDelegationScopeKeys,
  resolveDelegationDecision,
  resolveSubagentCapacityPolicy,
  type DelegationDecision,
  type DelegationRuntimePhase,
} from "../../subagents";
import type { ToolDefinition } from "../../toolSchemas";
import {
  resolveEffectiveSubagentDelegationPreference,
  type TurnInputContextSignals,
} from "../../turnIntake";
import type { PlanRuntimePhase } from "../../workflowModels";
import { scopeExecutionEvidenceLedger } from "../../verificationEvidence";
import { isWorkspaceMutationToolName } from "../../workspaceMutationTools";
import type { AgentMessage, OrchestratorCallbacks } from "../types";

export interface IterationToolSurfaceDecision {
  isExecuteRecoveryEligible: boolean;
  allowExecuteRecoveryFileRead: boolean;
  recoveryActionContract: RecoveryActionContract;
  directFileModifyPhase: DirectFileModifyPhase;
  delegationDecision: DelegationDecision;
  iterationAllTools: ToolDefinition[];
  availableToolNames: Set<string>;
}

export type DirectFileModifyPhase = "source_change" | "validation" | null;

const DIRECT_FILE_MODIFY_SOURCE_TOOLS = new Set([
  "spawn_subagent",
  "wait_subagents",
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "code_ast_query",
  "find_symbol_references",
  "read_file",
  "replace_in_file",
  "write_file",
  "apply_patch",
  "git_status",
  "git_diff",
  "run_command",
  "get_project_skeleton",
  "get_file_outline",
]);

const DIRECT_FILE_MODIFY_VALIDATION_TOOLS = new Set([
  ...DIRECT_FILE_MODIFY_SOURCE_TOOLS,
  "execute_command",
  "send_pty_input",
  "browser_evaluate",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

export function hasStructuredWorkspaceMutationEvidence(input: {
  callbacks: OrchestratorCallbacks;
  recentToolActivity: PlanToolActivitySummary[];
}): boolean {
  if (input.recentToolActivity.some((activity) =>
    activity.status === "succeeded" && isWorkspaceMutationToolName(activity.name)
  )) return true;

  return scopeExecutionEvidenceLedger(
    input.callbacks.getPlanExecutionEvidenceLedger(),
    input.callbacks.getCurrentTurnId?.(),
  ).some((entry) =>
    entry.kind === "file" && isWorkspaceMutationToolName(entry.sourceTool)
  );
}

function resolveDirectFileModifyPhase(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  executeRecoveryMode: ExecuteRecoveryMode;
  recentToolActivity: PlanToolActivitySummary[];
}): DirectFileModifyPhase {
  if (
    input.workflowMode !== "edit" ||
    !isMutationRuntimeIntent(input.runtimeIntent) ||
    input.executeRecoveryMode !== "normal" ||
    input.callbacks.getIsPlanApproved() ||
    input.callbacks.getCommandDirective?.()?.kind !== "file_modify"
  ) return null;

  return hasStructuredWorkspaceMutationEvidence(input)
    ? "validation"
    : "source_change";
}

export function buildDirectFileModifyActionContractCard(input: {
  phase: Exclude<DirectFileModifyPhase, null>;
  availableToolNames: Iterable<string>;
}): string {
  const availableTools = [...new Set(input.availableToolNames)].sort().join(", ");
  const phaseGuidance = input.phase === "source_change"
    ? [
        "The user intent is a workspace file modification. Locate only the source context needed for the change, then modify source with apply_patch, replace_in_file, or write_file.",
        "run_command is available only for finite diagnostics in this phase. Do not use Python, shell redirection, sed, or temporary scripts to write workspace source, and do not start a dev server before structured file-mutation evidence exists.",
      ]
    : [
        "Structured workspace mutation evidence exists. Use finite run_command validation next when appropriate; use execute_command only for a genuinely long-running process and inspect that process through the PTY tools before browser validation.",
        "If validation identifies a source defect, repair it with apply_patch, replace_in_file, or write_file so the changed path and diff remain structured evidence.",
      ];
  return [
    "[TURN_ACTION_CONTRACT]",
    `intent=file_modify; phase=${input.phase}`,
    `availableTools=${availableTools}`,
    ...phaseGuidance,
    "Call only a tool in availableTools. MAIN changes the real tool schema when the execution phase advances.",
  ].join("\n");
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
    recentToolActivity,
    recentPlanToolActivity,
    planRuntimePhase,
    usedPlanReadOnlyConvergencePrompt,
    turnInputContextSignals,
    latestUserPromptText = "",
  } = input;

  const devServerRuntimeObservation = resolveDevServerRuntimeState(
    scopeExecutionEvidenceLedger(
      callbacks.getPlanExecutionEvidenceLedger(),
      callbacks.getCurrentTurnId?.(),
    ),
  );
  const isExecuteRecoveryEligible =
    workflowMode === "edit" &&
    isMutationRuntimeIntent(runtimeIntent) &&
    executeRecoveryMode !== "normal";
  const pendingSubagentCount = callbacks.getPendingSubagentIds?.().length || 0;
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
  const recoveryIterationAllTools = isExecuteRecoveryEligible
    ? rawIterationAllTools.filter((tool) =>
        (
          tool.function.name !== "wait_subagents" ||
          pendingSubagentCount > 0
        ) &&
        isExecuteRecoveryToolName(
          tool.function.name,
          PLAN_EXPLORATION_READ_ONLY_TOOLS,
          {
            mode: executeRecoveryMode,
            allowFileRead: allowExecuteRecoveryFileRead,
            contract: recoveryActionContract,
          },
        )
      )
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
      allowFileRead: allowExecuteRecoveryFileRead,
      adaptiveFileReadAllowed: allowExecuteRecoveryFileRead,
      recoveryToolSurface: recoveryActionContract.surfaceDescription,
      rawTools: rawIterationAllTools.map((tool) => tool.function.name).slice(0, 24),
      scopedTools: recoveryIterationAllTools.map((tool) => tool.function.name),
      removedToolCount: Math.max(0, rawIterationAllTools.length - recoveryIterationAllTools.length),
    });
  }

  if (executeRecoveryMode !== "normal") {
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
      recentPlanToolActivity: recentPlanToolActivity.length,
      repeatedTargets: summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity),
    });
  }

  const executeContractOwnsSurface =
    isExecuteRecoveryEligible && recoveryActionContract.phase !== "normal";
  const initialBaseIterationAllTools = recoveryIterationAllTools;
  const recoveryScopesDelegation = executeContractOwnsSurface;
  const joinedChildNeedsParentReread = [...recentToolActivity, ...recentPlanToolActivity]
    .some((activity) => activity.delegatedObservation?.requiresParentReread === true);
  const canExposeParentReread =
    recoveryActionContract.phase === "normal" ||
    (
      recoveryActionContract.phase === "context" &&
      recoveryActionContract.nextRequiredCapability === "targeted_read"
    );
  const extraRecoveryToolNames = new Set<string>();
  if (recoveryScopesDelegation && pendingSubagentCount > 0) {
    extraRecoveryToolNames.add("wait_subagents");
  }
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
  const planPhaseScopedIterationAllTools = filterPlanRuntimeToolDefinitionsForPhase({
    tools: baseIterationAllTools,
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    planRuntimePhase,
  });
  const directFileModifyPhase = resolveDirectFileModifyPhase({
    callbacks,
    workflowMode,
    runtimeIntent,
    executeRecoveryMode,
    recentToolActivity,
  });
  const directFileModifyAllowedTools = directFileModifyPhase === "source_change"
    ? DIRECT_FILE_MODIFY_SOURCE_TOOLS
    : directFileModifyPhase === "validation"
    ? DIRECT_FILE_MODIFY_VALIDATION_TOOLS
    : null;
  const phaseScopedIterationAllTools = directFileModifyAllowedTools
    ? planPhaseScopedIterationAllTools.filter((tool) =>
        directFileModifyAllowedTools.has(tool.function.name)
      )
    : planPhaseScopedIterationAllTools;
  if (
    directFileModifyPhase &&
    phaseScopedIterationAllTools.length !== planPhaseScopedIterationAllTools.length
  ) {
    logAgentEvent("direct_file_modify_tool_scope_applied", {
      iteration,
      phase: directFileModifyPhase,
      commandDirectiveKind: callbacks.getCommandDirective?.()?.kind || null,
      rawToolCount: planPhaseScopedIterationAllTools.length,
      scopedToolCount: phaseScopedIterationAllTools.length,
      removedTools: planPhaseScopedIterationAllTools
        .map((tool) => tool.function.name)
        .filter((name) => !directFileModifyAllowedTools!.has(name))
        .slice(0, 24),
      scopedTools: phaseScopedIterationAllTools
        .map((tool) => tool.function.name)
        .slice(0, 24),
      structuredMutationObserved: directFileModifyPhase === "validation",
      providerNeutral: true,
    });
  }
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
  } else if (recoveryPhase === "validation" || recoveryPhase === "reconcile") {
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
  const plannedWorkItemCount = workflowMode === "plan"
    ? callbacks.getPlanTasks().length
    : 0;
  const runtimeConfig = callbacks.getConfig?.();
  const delegationRuntimeHealth = runtimeConfig?.activeProfile &&
    runtimeConfig.local &&
    runtimeConfig.cloud &&
    Array.isArray(runtimeConfig.cloudServers)
    ? getSubagentAdmissionHealth(resolveSubagentCapacityPolicy(runtimeConfig))
    : null;
  const effectiveSubagentPreference = resolveEffectiveSubagentDelegationPreference({
    rawUserInput: latestUserPromptText,
    defaultPreference: turnInputContextSignals.subagentPreference && turnInputContextSignals.subagentPreference !== "unspecified"
      ? turnInputContextSignals.subagentPreference
      : callbacks.getGoalTurnContract?.()?.subagentPreference,
  });
  const delegationDecision = resolveDelegationDecision({
    preference: effectiveSubagentPreference,
    phase: delegationPhase,
    hasWorkspace: !!String(callbacks.getConfig?.().workspace || "").trim(),
    explicitScopeCount,
    observedScopeCount,
    plannedWorkItemCount,
    independentScopeKeys: normalizedIndependentScopeKeys,
    pendingSubagentCount,
    subagentDepth: callbacks.getSubagentDepth?.() || 0,
    runtimeHealth: delegationRuntimeHealth,
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
      runtimeHealthState: delegationRuntimeHealth?.state || "unknown",
      activeChildren: delegationRuntimeHealth?.activeChildren ?? null,
      queuedChildren: delegationRuntimeHealth?.queuedChildren ?? null,
      capacityLimit: delegationRuntimeHealth?.capacityLimit ?? null,
      memorySafety: delegationRuntimeHealth?.memorySafety || "unknown",
      recentSuccessfulRuns: delegationRuntimeHealth?.recentSuccessfulRuns ?? 0,
      latestStartupMs: delegationRuntimeHealth?.latestStartupMs ?? null,
      latestCapacityWaitMs: delegationRuntimeHealth?.latestCapacityWaitMs ?? null,
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
      hasGroundedVisualContext: hasPlanVisualContextGrounding(
        callbacks.getMessages() as AgentMessage[],
        callbacks.getCurrentTurnId?.(),
      ),
    }).status,
  });
  const iterationAllTools = shouldClosePlanToolSurface
    ? []
    : delegationScopedIterationAllTools;

  const shouldLogToolSurfaceDecision =
    rawIterationAllTools.length !== iterationAllTools.length ||
    executeRecoveryMode !== "normal" ||
    callbacks.getIsPlanApproved();
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
      executeContractOwnsSurface,
      directFileModifyPhase,
      // Report the effective surface, not an upstream eligibility hint. Those
      // can legitimately be true while a later phase filter removes read_file.
      allowFileRead: scopedToolNameSet.has("read_file"),
      readFileExposed: scopedToolNameSet.has("read_file"),
      recoveryToolSurface: recoveryActionContract.surfaceDescription,
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
    recoveryActionContract,
    directFileModifyPhase,
    delegationDecision,
    iterationAllTools,
    availableToolNames: new Set(iterationAllTools.map((tool) => tool.function.name)),
  };
}
