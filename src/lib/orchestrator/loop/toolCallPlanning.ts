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
import {
  derivePlanEvidenceObligations,
  formatPlanEvidenceObligation,
  getPlanEvidenceObligationToolName,
  type PlanEvidenceObligation,
} from "../../planEvidenceObligations";
import {
  isPlanRuntimeFinalizationPhase,
  shouldClosePlanToolSurfaceAfterReadOnlyConvergence,
} from "../../planRuntime";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import { buildTaskTargetingProfile } from "../../taskTargeting";
import {
  getSubagentAdmissionHealth,
  normalizeIndependentDelegationScopeKeys,
  resolveDelegationDecision,
  resolvePreferredDelegationRequirement,
  resolveSubagentCapacityPolicy,
  type DelegationDecision,
  type DelegationRuntimePhase,
  type PreferredDelegationRequirement,
  type SubagentExecutionScope,
} from "../../subagents";
import {
  SUBMIT_PLAN_CANDIDATE_TOOL_NAME,
  type ToolDefinition,
} from "../../toolSchemas";
import {
  resolveEffectiveSubagentDelegationPreference,
  type TurnInputContextSignals,
} from "../../turnIntake";
import type { PlanRuntimePhase } from "../../workflowModels";
import {
  hasSuccessfulWorkspaceMutationEvidence,
  scopeExecutionEvidenceLedger,
} from "../../verificationEvidence";
import type { AgentMessage, OrchestratorCallbacks } from "../types";
import {
  collectAuthoritativePreferredDelegationEvidenceOwnerPaths,
  collectPreferredDelegationWorkspacePathCandidates,
  collectTrustedPreferredDelegationWorkspaceTopologyPaths,
  derivePreferredDelegationScopeCandidates,
  getPreferredDelegationScopeProgress,
  preferredDelegationScopeContractMatchesWave,
  type PreferredDelegationScopeContract,
} from "../../preferredDelegationScopes";

export interface IterationToolSurfaceDecision {
  isExecuteRecoveryEligible: boolean;
  allowExecuteRecoveryFileRead: boolean;
  recoveryActionContract: RecoveryActionContract;
  directFileModifyPhase: DirectFileModifyPhase;
  delegationDecision: DelegationDecision;
  preferredDelegationRequirement: PreferredDelegationRequirement;
  /** Exact runtime-owned read/search transaction for this Plan iteration. */
  planEvidenceObligation?: PlanEvidenceObligation;
  iterationAllTools: ToolDefinition[];
  availableToolNames: Set<string>;
}

export type DirectFileModifyPhase = "source_change" | "validation" | null;

const DIRECT_FILE_MODIFY_WORKSPACE_TOOLS = new Set([
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

const DIRECT_FILE_MODIFY_SOURCE_TOOLS = new Set([
  "spawn_subagent",
  "wait_subagents",
  ...DIRECT_FILE_MODIFY_WORKSPACE_TOOLS,
]);

// Mutation evidence changes the preferred action to validation; it does not
// revoke source inspection or a follow-up edit. Keeping the same bounded
// workspace surface avoids read/edit/validate protocol oscillation.
const DIRECT_FILE_MODIFY_VALIDATION_TOOLS = DIRECT_FILE_MODIFY_WORKSPACE_TOOLS;

const SUBAGENT_UNSCOPED_WORKSPACE_TOOLS = new Set([
  "glob_search",
  "get_project_skeleton",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
]);

const SUBAGENT_EXACT_PATH_TOOLS = new Set([
  "read_file",
  "read_document",
  "get_file_outline",
  "code_ast_query",
]);

const SUBAGENT_REQUIRED_SCOPED_PATH_TOOLS = new Set([
  "grep_search",
  "find_symbol_references",
  "git_diff",
]);

function withSubagentPathContract(
  tool: ToolDefinition,
  paths: string[],
  description: string,
): ToolDefinition {
  const pathProperty = tool.function.parameters.properties.path;
  if (!pathProperty || paths.length === 0) return tool;
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: {
        ...tool.function.parameters,
        properties: {
          ...tool.function.parameters.properties,
          path: {
            ...pathProperty,
            description,
            enum: [...paths],
          },
        },
        required: [...new Set([...(tool.function.parameters.required || []), "path"])],
      },
    },
  };
}

function withExactPlanEvidenceParameterContract(
  tool: ToolDefinition,
  parameter: "path" | "symbol",
  value: string,
): ToolDefinition {
  const property = tool.function.parameters.properties[parameter];
  if (!property || !value) return tool;
  return {
    ...tool,
    function: {
      ...tool.function,
      description: `${tool.function.description} Runtime evidence contract: ${parameter} must equal ${JSON.stringify(value)}.`,
      parameters: {
        ...tool.function.parameters,
        properties: {
          ...tool.function.parameters.properties,
          [parameter]: {
            ...property,
            description: `Runtime-owned exact ${parameter}: ${value}`,
            enum: [value],
          },
        },
        required: [...new Set([...(tool.function.parameters.required || []), parameter])],
      },
    },
  };
}

/**
 * A needs_evidence iteration executes one ledger-derived primitive. Exposing
 * the wider discovery surface lets a model accidentally satisfy a different
 * action (or reread accepted child evidence) while the real obligation stays
 * open, so both the tool name and its decisive argument are scoped here.
 */
export function scopePlanEvidenceObligationToolDefinitions(input: {
  tools: ToolDefinition[];
  obligation?: PlanEvidenceObligation;
}): ToolDefinition[] {
  if (!input.obligation) return input.tools;
  const expectedTool = getPlanEvidenceObligationToolName(input.obligation);
  const expectedValue = input.obligation.kind === "read_target"
    ? String(input.obligation.targetRef || "").trim()
    : String(input.obligation.symbol || "").trim();
  if (!expectedValue) return [];
  return input.tools.flatMap((tool) => {
    if (tool.function.name !== expectedTool) return [];
    return [withExactPlanEvidenceParameterContract(
      tool,
      input.obligation!.kind === "read_target" ? "path" : "symbol",
      expectedValue,
    )];
  });
}

export function scopeSubagentToolDefinitions(input: {
  tools: ToolDefinition[];
  scope: SubagentExecutionScope | null;
}): ToolDefinition[] {
  if (!input.scope) return input.tools;
  const scope = input.scope;
  const blocked = new Set(scope.blockedToolNames);
  const ownsWorkspaceRoot = scope.allowedPaths.some((path) => path === ".");
  return input.tools.flatMap((tool) => {
    const name = tool.function.name;
    if (blocked.has(name)) return [];
    if (!ownsWorkspaceRoot && SUBAGENT_UNSCOPED_WORKSPACE_TOOLS.has(name)) return [];
    if (name === "list_directory") {
      if (scope.allowedDirectoryPaths.length === 0) return [];
      return [withSubagentPathContract(
        tool,
        scope.allowedDirectoryPaths,
        `Exact directory owned by this subagent: ${scope.allowedDirectoryPaths.join(", ")}`,
      )];
    }
    if (SUBAGENT_REQUIRED_SCOPED_PATH_TOOLS.has(name)) {
      return [withSubagentPathContract(
        tool,
        scope.allowedPaths,
        `Required exact scope target. Choose one of: ${scope.allowedPaths.join(", ")}`,
      )];
    }
    if (
      scope.scopeKind === "exact_files" &&
      SUBAGENT_EXACT_PATH_TOOLS.has(name)
    ) {
      return [withSubagentPathContract(
        tool,
        scope.allowedFilePaths,
        `Required exact file owned by this subagent. Choose one of: ${scope.allowedFilePaths.join(", ")}`,
      )];
    }
    return [tool];
  });
}

export function hasStructuredWorkspaceMutationEvidence(input: {
  callbacks: OrchestratorCallbacks;
  recentToolActivity: PlanToolActivitySummary[];
}): boolean {
  // Activity summaries intentionally omit arguments and execution disposition;
  // a declined/no-op write, Plan artifact update, or inspect-shaped dynamic
  // tool can therefore look like a successful mutation by name alone. Phase
  // advancement trusts only the Turn-scoped durable file ledger produced from
  // the verified tool result and diff.
  return hasSuccessfulWorkspaceMutationEvidence({
    ledger: input.callbacks.getPlanExecutionEvidenceLedger(),
    transactionId: input.callbacks.getCurrentTurnId?.(),
  });
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
        "Structured workspace mutation evidence exists. Complete every remaining source edit with apply_patch, replace_in_file, or write_file; a file-modification turn may require more than one structured mutation.",
        "After the last required source edit, validate the current workspace state with the finite run_command tool. Set its cwd field instead of prefixing the command with cd; trusted execution rejects shell-level working-directory changes. A newer mutation makes any earlier validation stale.",
        "Long-running process and browser tools are not part of this finite checkpoint; MAIN exposes them only through an explicit process-lifecycle validation contract.",
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
  /** Formal turn authorization; recovery must not infer mutation authority from prose. */
  turnIntent?: ResolvedUserIntent;
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
  preferredDelegationScopeContract?: PreferredDelegationScopeContract | null;
  preferredDelegationMaterializationBlockedScopeKeys?: string[];
}): IterationToolSurfaceDecision {
  const {
    callbacks,
    iteration,
    workflowMode,
    runtimeIntent,
    turnIntent = runtimeIntent,
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
    preferredDelegationScopeContract = null,
    preferredDelegationMaterializationBlockedScopeKeys = [],
  } = input;

  const devServerRuntimeObservation = resolveDevServerRuntimeState(
    scopeExecutionEvidenceLedger(
      callbacks.getPlanExecutionEvidenceLedger(),
      callbacks.getCurrentTurnId?.(),
    ),
  );
  const isExecuteRecoveryEligible =
    (
      (workflowMode === "edit" && isMutationRuntimeIntent(runtimeIntent)) ||
      (
        workflowMode === "chat" &&
        isMutationRuntimeIntent(turnIntent) &&
        executeRecoveryReason.startsWith("chat_repair_strategy_pivot:")
      )
    ) &&
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
  // submit_plan_candidate is runtime control-plane ingress, not a generally
  // executable read-only tool. Keep it out of Chat/Edit and approved Plan
  // surfaces even though its permission risk is intentionally non-mutating.
  const initialBaseIterationAllTools =
    workflowMode === "plan" && !callbacks.getIsPlanApproved()
      ? recoveryIterationAllTools
      : recoveryIterationAllTools.filter((tool) =>
          tool.function.name !== SUBMIT_PLAN_CANDIDATE_TOOL_NAME
        );
  const recoveryScopesDelegation = executeContractOwnsSurface;
  const joinedChildNeedsParentReread = [...recentToolActivity, ...recentPlanToolActivity]
    .some((activity) =>
      activity.delegatedObservation?.requiresParentReread === true &&
      (
        workflowMode !== "plan" ||
        callbacks.getIsPlanApproved() ||
        activity.delegatedObservation.planningEvidenceState !== "reusable"
      )
    );
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
        activity.mutationObserved === true ||
        EXECUTION_VERIFICATION_TOOL_NAMES.has(activity.name)
      )
    );
  const declaredTargetProfile = buildTaskTargetingProfile({
    userPrompt: latestUserPromptText,
    planTaskTexts: callbacks.getPlanTasks().map((task) => task.text),
    userContext: turnInputContextSignals,
  });
  const explicitScopeKeys = [
    ...declaredTargetProfile.explicitPaths,
    ...(turnInputContextSignals.mentionedFilePaths || []),
    ...(turnInputContextSignals.attachedFilePaths || []),
  ];
  const observedScopeKeys = collectPreferredDelegationWorkspacePathCandidates(
    delegationActivities,
  );
  const authoritativePlanEvidenceOwnerScopeKeys =
    workflowMode === "plan" && !callbacks.getIsPlanApproved()
      ? collectAuthoritativePreferredDelegationEvidenceOwnerPaths(recentPlanToolActivity)
      : [];
  const trustedPlanWorkspaceTopologyScopeKeys =
    workflowMode === "plan" && !callbacks.getIsPlanApproved()
      ? collectTrustedPreferredDelegationWorkspaceTopologyPaths(recentPlanToolActivity)
      : [];
  const stablePlanWorkspaceOwnerScopeKeys = [
    ...trustedPlanWorkspaceTopologyScopeKeys,
    ...authoritativePlanEvidenceOwnerScopeKeys,
  ];
  const normalizedIndependentScopeKeys = normalizeIndependentDelegationScopeKeys([
    ...(workflowMode === "plan" && !callbacks.getIsPlanApproved()
      ? []
      : explicitScopeKeys),
    ...(workflowMode === "plan" && !callbacks.getIsPlanApproved()
      ? stablePlanWorkspaceOwnerScopeKeys
      : observedScopeKeys),
  ]);
  const explicitScopeCount = normalizeIndependentDelegationScopeKeys(explicitScopeKeys).length;
  const observedScopeCount = normalizeIndependentDelegationScopeKeys(
    workflowMode === "plan" && !callbacks.getIsPlanApproved()
      ? stablePlanWorkspaceOwnerScopeKeys
      : observedScopeKeys,
  ).length;
  const plannedWorkItemCount = workflowMode === "plan"
    ? callbacks.getPlanTasks().length
    : 0;
  const runtimeConfig = callbacks.getConfig?.();
  const subagentCapacityPolicy = runtimeConfig?.activeProfile &&
    runtimeConfig.local &&
    runtimeConfig.cloud &&
    Array.isArray(runtimeConfig.cloudServers)
    ? resolveSubagentCapacityPolicy(runtimeConfig)
    : null;
  const delegationRuntimeHealth = runtimeConfig?.activeProfile &&
    runtimeConfig.local &&
    runtimeConfig.cloud &&
    Array.isArray(runtimeConfig.cloudServers)
    ? getSubagentAdmissionHealth(subagentCapacityPolicy!)
    : null;
  const effectiveSubagentPreference = resolveEffectiveSubagentDelegationPreference({
    rawUserInput: latestUserPromptText,
    defaultPreference: turnInputContextSignals.subagentPreference && turnInputContextSignals.subagentPreference !== "unspecified"
      ? turnInputContextSignals.subagentPreference
      : callbacks.getGoalTurnContract?.()?.subagentPreference,
  });
  const preferredDelegationScopeCandidates = derivePreferredDelegationScopeCandidates({
    candidatePathKeys: normalizedIndependentScopeKeys,
    structuredInput: latestUserPromptText,
    // The scheduler remains the hard capacity authority. A minimal callback
    // fixture may omit full config, so keep discovery capable of expressing
    // the same bounded local contract instead of silently erasing scopes.
    maxCreatedPerTurn: subagentCapacityPolicy?.maxCreatedPerTurn || 3,
    strategy: workflowMode === "plan" && !callbacks.getIsPlanApproved()
      ? "stable_top_level"
      : "shallowest_parallel",
  });
  const preferredDelegationScopeProgress = getPreferredDelegationScopeProgress(
    preferredDelegationScopeContract,
  );
  const openPlanEvidenceObligations =
    workflowMode === "plan" && !callbacks.getIsPlanApproved()
      ? derivePlanEvidenceObligations({
          objective: latestUserPromptText || getOriginalUserPromptForPlanFallback(callbacks),
          activities: recentPlanToolActivity,
        })
      : [];
  // Two authoritative, non-overlapping top-level owners are already a stable
  // parallel boundary. Freeze and materialize that boundary as soon as it is
  // known; do not make preferred collaboration wait for Plan finalization.
  // A single subsystem remains provisional until the ordinary finalization
  // gate closes, so sibling file reads never manufacture parallel work.
  const preferredPlanStableParallelOwnersReady =
    preferredDelegationScopeCandidates.length >= 2;
  const preferredPlanEvidenceTopologyReady =
    workflowMode !== "plan" ||
    callbacks.getIsPlanApproved() ||
    preferredPlanStableParallelOwnersReady ||
    (
      isPlanRuntimeFinalizationPhase(planRuntimePhase) &&
      openPlanEvidenceObligations.length === 0
    );
  const preferredPlanContractActivationDeferred =
    effectiveSubagentPreference === "preferred" &&
    !preferredDelegationScopeContract &&
    !preferredPlanEvidenceTopologyReady;
  // A model can close all Plan evidence in one parallel read batch. That
  // normally advances the runtime straight into drafting, whose tool surface
  // is intentionally empty. When the captured Turn preference says
  // collaboration is preferred and that batch has proved at least two useful,
  // non-overlapping scopes, preserve one bounded pre-draft delegation
  // checkpoint instead of silently skipping the user's preference. Reopen
  // only spawn_subagent; all normal phase, capacity, recursion, and workspace
  // admission boundaries below remain authoritative.
  const preferredPlanDelegationCheckpointPending =
    workflowMode === "plan" &&
    !callbacks.getIsPlanApproved() &&
    isPlanRuntimeFinalizationPhase(planRuntimePhase) &&
    planRuntimePhase !== "review_ready" &&
    planRuntimePhase !== "blocked" &&
    effectiveSubagentPreference === "preferred" &&
    preferredPlanEvidenceTopologyReady &&
    !preferredDelegationScopeProgress.satisfied &&
    (
      preferredDelegationScopeProgress.open ||
      preferredDelegationScopeCandidates.length >= 2
    );
  const checkpointSpawnTool = preferredPlanDelegationCheckpointPending
    ? baseIterationAllTools.find((tool) => tool.function.name === "spawn_subagent")
    : undefined;
  const delegationEligiblePhaseScopedIterationAllTools =
    checkpointSpawnTool &&
    !phaseScopedIterationAllTools.some((tool) => tool.function.name === "spawn_subagent")
      ? [...phaseScopedIterationAllTools, checkpointSpawnTool]
      : phaseScopedIterationAllTools;

  let delegationPhase: DelegationRuntimePhase;
  if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
    delegationPhase = preferredPlanDelegationCheckpointPending
      ? "diagnostic"
      : planRuntimePhase === "explore_structure"
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
    latestDecisiveRuntimeActivity.mutationObserved === true
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
  const runtimeOwnedLifecycleReviewAvailable =
    effectiveSubagentPreference === "preferred" &&
    (delegationPhase === "mutation" || delegationPhase === "validation") &&
    !!latestDecisiveRuntimeActivity &&
    rawIterationAllTools.some((tool) =>
      tool.function.name === "spawn_subagent"
    );
  const preferredDelegationRequirement = resolvePreferredDelegationRequirement({
    decision: delegationDecision,
    independentScopeKeys: normalizedIndependentScopeKeys,
    scopeCandidates: preferredDelegationScopeCandidates,
    scopeContract: preferredDelegationScopeContract,
    activationAllowed: !preferredPlanContractActivationDeferred,
    blockedScopeKeys: preferredDelegationMaterializationBlockedScopeKeys,
    // Later lifecycle waves are materialized by the runtime control plane even
    // when another phase-specific filter has hidden spawn_subagent from the
    // provider request. A decisive mutation or verification event is the
    // evidence-owned need signal; initial discovery cannot manufacture a
    // second duplicate wave.
    spawnToolAvailable:
      runtimeOwnedLifecycleReviewAvailable ||
      delegationEligiblePhaseScopedIterationAllTools.some((tool) =>
        tool.function.name === "spawn_subagent"
      ),
  });
  const preferredDelegationContractMatchesCurrentWave =
    preferredDelegationScopeContractMatchesWave({
      contract: preferredDelegationScopeContract,
      lifecyclePhase: preferredDelegationRequirement.lifecyclePhase,
      scopes: preferredDelegationRequirement.requiredScopes,
    });
  const preferredDelegationCurrentWaveHasCapacity =
    !preferredDelegationScopeContract ||
    (
      !preferredDelegationContractMatchesCurrentWave &&
      preferredDelegationScopeProgress.activeScopeKeys.length === 0 &&
      !preferredDelegationScopeProgress.open
    ) ||
    preferredDelegationScopeProgress.creationCapacityRemaining > 0;
  const delegationScopedIterationAllTools = delegationDecision.action === "admit" &&
      preferredDelegationRequirement.reason !== "runtime_materialization_failed" &&
      !preferredPlanContractActivationDeferred &&
      preferredDelegationCurrentWaveHasCapacity
    ? delegationEligiblePhaseScopedIterationAllTools
    : delegationEligiblePhaseScopedIterationAllTools.filter((tool) =>
        tool.function.name !== "spawn_subagent"
      );
  if (
    delegationEligiblePhaseScopedIterationAllTools.some((tool) =>
      tool.function.name === "spawn_subagent"
    ) ||
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
        delegationEligiblePhaseScopedIterationAllTools.some((tool) =>
          tool.function.name === "spawn_subagent"
        ),
      preferredPlanDelegationCheckpointPending,
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
  const subagentScope = callbacks.getSubagentScope?.() ?? null;
  const subagentScopedIterationAllTools = scopeSubagentToolDefinitions({
    tools: delegationScopedIterationAllTools,
    scope: subagentScope,
  });
  if (subagentScope) {
    const beforeNames = delegationScopedIterationAllTools.map((tool) => tool.function.name);
    const afterNames = subagentScopedIterationAllTools.map((tool) => tool.function.name);
    callbacks.onDebugEvent?.("subagent_tool_surface_scoped", {
      iteration,
      scopeKey: subagentScope.scopeKey,
      scopeKind: subagentScope.scopeKind,
      allowedPaths: subagentScope.allowedPaths,
      blockedToolNames: subagentScope.blockedToolNames,
      removedTools: beforeNames.filter((name) => !afterNames.includes(name)),
      scopedTools: afterNames,
    });
  }
  const preferredDelegationScopedIterationAllTools = preferredDelegationRequirement.required
    ? subagentScopedIterationAllTools.filter((tool) => tool.function.name === "spawn_subagent")
    : subagentScopedIterationAllTools;
  // Keep a user-requested first delegation checkpoint and an in-flight join
  // authoritative. Once those boundaries are clear, needs_evidence is owned
  // by the first exact open ledger obligation, recomputed every iteration.
  const planEvidenceObligation =
    workflowMode === "plan" &&
    !callbacks.getIsPlanApproved() &&
    planRuntimePhase === "needs_evidence" &&
    pendingSubagentCount === 0 &&
    !preferredDelegationRequirement.contractOpen
      ? openPlanEvidenceObligations[0]
      : undefined;
  const evidenceObligationScopedIterationAllTools = scopePlanEvidenceObligationToolDefinitions({
    tools: preferredDelegationScopedIterationAllTools,
    obligation: planEvidenceObligation,
  });
  const closedPlanAuthoringSurface = evidenceObligationScopedIterationAllTools.filter(
    (tool) => tool.function.name === SUBMIT_PLAN_CANDIDATE_TOOL_NAME,
  );
  const iterationAllTools = preferredDelegationRequirement.required
    ? preferredDelegationScopedIterationAllTools
    : preferredDelegationRequirement.contractOpen
    ? preferredDelegationScopedIterationAllTools.filter((tool) =>
        pendingSubagentCount > 0 && tool.function.name === "wait_subagents"
      )
    : shouldClosePlanToolSurface
    ? closedPlanAuthoringSurface
    : evidenceObligationScopedIterationAllTools;

  if (planEvidenceObligation) {
    logAgentEvent("plan_evidence_obligation_tool_scope_applied", {
      iteration,
      planRuntimePhase,
      obligation: formatPlanEvidenceObligation(planEvidenceObligation),
      expectedTool: getPlanEvidenceObligationToolName(planEvidenceObligation),
      scopedTools: iterationAllTools.map((tool) => tool.function.name),
      pendingSubagentCount,
      providerNeutral: true,
    });
  }

  if (delegationDecision.preference === "preferred") {
    logAgentEvent("preferred_delegation_requirement", {
      iteration,
      required: preferredDelegationRequirement.required,
      reason: preferredDelegationRequirement.reason,
      candidateScopeKeys: preferredDelegationRequirement.candidateScopeKeys,
      requiredScopes: preferredDelegationRequirement.requiredScopes,
      remainingScopes: preferredDelegationRequirement.remainingScopes,
      consumedScopeKeys: preferredDelegationRequirement.consumedScopeKeys,
      contractOpen: preferredDelegationRequirement.contractOpen,
      delegationAction: delegationDecision.action,
      delegationReason: delegationDecision.reason,
      preferredPlanDelegationCheckpointPending,
      preferredPlanEvidenceTopologyReady,
      preferredPlanStableParallelOwnersReady,
      openPlanEvidenceObligationCount: openPlanEvidenceObligations.length,
      authoritativeEvidenceOwnerScopeKeys: authoritativePlanEvidenceOwnerScopeKeys,
      trustedWorkspaceTopologyScopeKeys: trustedPlanWorkspaceTopologyScopeKeys,
      effectiveTools: iterationAllTools.map((tool) => tool.function.name),
      providerNeutral: true,
    });
  }

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
    preferredDelegationRequirement,
    ...(planEvidenceObligation ? { planEvidenceObligation } : {}),
    iterationAllTools,
    availableToolNames: new Set(iterationAllTools.map((tool) => tool.function.name)),
  };
}
