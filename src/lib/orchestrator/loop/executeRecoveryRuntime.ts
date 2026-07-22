import {
  isLegacyPostMutationReadLease,
  migrateRecoveryReadLease,
  normalizeRecoveryReadRange,
  normalizeExecuteRecoveryMode,
  readEvidenceSatisfiesRecoveryLease,
  resolveExecuteRecoveryActionContract,
  resolveExecuteNoProgressStrategyDecision,
  type ExecutionDecisionCheckpoint,
  type ExecuteRecoveryMode,
  type ForcedExecuteRecoveryRuntimeState,
  type RecoveryReadLease,
  type ExecuteNoProgressStrategyDecision,
  type PendingFiniteValidationCheckpoint,
} from "../../executeRecoveryTools";
import { isLocalDevServerHealthProbeCommand } from "../../devServerRuntime";
import { workspacePathsReferToSameFile } from "../../workspacePaths";

export const MAX_EXECUTE_RECOVERY_ITERATIONS = 6;

export interface ExecuteRecoveryRuntimeState {
  mode: ExecuteRecoveryMode;
  reason: string;
  /** File identity carried by the complete context -> mutation -> validation transaction. */
  expectedTarget: string | null;
  attempts: number;
  /** Consecutive iterations without fresh evidence inside the current phase. */
  phaseNoProgressCount: number;
  /** Monotonic retries of the same semantic request, independent of policy/tool failures. */
  protocolNoProgressCount: number;
  protocolNoProgressFingerprint: string | null;
  /** @deprecated Compatibility mirror for persisted/logged recovery counters. */
  iterationCount: number;
  readLease: RecoveryReadLease | null;
  sourceObservationKey: string | null;
  decisionCheckpoint: ExecutionDecisionCheckpoint | null;
}

export type ExecuteRecoveryPhaseTransition =
  | "none"
  | "context_refreshed"
  | "context_version_changed_to_targeting"
  | "validation_progress"
  | "context_to_mutation"
  | "mutation_to_validation"
  | "validation_to_objective_audit"
  | "validation_to_normal";

export interface ExecuteRecoveryObservation {
  expectedTarget?: string | null;
  freshReadTarget?: string | null;
  mutationTarget?: string | null;
  /** Exact structured changed paths when one mutation updates multiple files. */
  mutationTargets?: string[];
  validationTarget?: string | null;
  validationToolName?: string | null;
  /** Stable observation identity; an unchanged cache stub may replay it. */
  sourceObservationKey?: string | null;
  sourceRequestedRange?: RecoveryReadLease["requestedRange"];
  sourceObservedVersion?: string | null;
  sourceRangeWasRuntimeNarrowed?: boolean;
  /** Cache stubs may consume a one-shot lease, but never refresh recovery budgets. */
  sourceObservationWasCacheStub?: boolean;
}

export interface PtyObservationPolicyDeferral {
  requestedUrl: string | null;
}

/**
 * Recognize the structured browser-preflight outcome that means the current
 * dev-server generation still needs PTY observation. This is a policy-owned
 * phase deferral, not a browser failure, so callers must not infer it from the
 * localized feedback text.
 */
export function resolvePtyObservationPolicyDeferral(
  results: Array<{
    name?: string | null;
    target?: string | null;
    internalFeedback?: boolean;
    qualityGateReason?: string | null;
  }>,
): PtyObservationPolicyDeferral | null {
  const deferredBrowser = results.find((result) =>
    result.name === "browser_evaluate" &&
    result.internalFeedback === true &&
    result.qualityGateReason === "pty_observation_required"
  );
  if (!deferredBrowser) return null;
  return {
    requestedUrl: deferredBrowser.target?.trim() || null,
  };
}

function resetExecuteRecoveryPhaseProgress<T extends ExecuteRecoveryRuntimeState>(state: T): T {
  return {
    ...state,
    phaseNoProgressCount: 0,
    iterationCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
  };
}

function appendObjectiveMutationEvidence(
  checkpoint: ExecutionDecisionCheckpoint | null,
  targets: string[],
): NonNullable<ExecutionDecisionCheckpoint["objectiveMutationEvidence"]> {
  const requirementRef = checkpoint?.requirementRef?.trim() || null;
  return targets.reduce<NonNullable<ExecutionDecisionCheckpoint["objectiveMutationEvidence"]>>(
    (evidence, target) => {
      const alreadyRecorded = evidence.some((entry) =>
        workspacePathsReferToSameFile(entry.target, target) &&
        String(entry.requirementRef || "").toLowerCase() ===
          String(requirementRef || "").toLowerCase()
      );
      return alreadyRecorded
        ? evidence
        : [
            ...evidence,
            { target, ...(requirementRef ? { requirementRef } : {}) },
          ].slice(-32);
    },
    checkpoint?.objectiveMutationEvidence || [],
  );
}

function appendObjectiveExpectedTargets(
  checkpoint: ExecutionDecisionCheckpoint | null,
  targets: string[],
): string[] {
  return targets.reduce<string[]>((expectedTargets, target) => {
    if (expectedTargets.some((entry) => workspacePathsReferToSameFile(entry, target))) {
      return expectedTargets;
    }
    return [...expectedTargets, target].slice(-32);
  }, checkpoint?.objectiveExpectedTargets || []);
}

function buildObjectiveMutationCheckpoint(input: {
  checkpoint: ExecutionDecisionCheckpoint | null;
  expectedTarget: string | null;
  evidenceTargets: string[];
}): ExecutionDecisionCheckpoint {
  const checkpoint = input.checkpoint;
  const requirementRef = checkpoint?.requirementRef?.trim() || null;
  const planTaskId = checkpoint?.planTaskId?.trim() || null;
  const objectiveKind: NonNullable<ExecutionDecisionCheckpoint["objectiveKind"]> =
    requirementRef || planTaskId ? "requirement" : "root";
  const previousRevision = Math.max(
    1,
    Math.floor(Number(checkpoint?.objectiveRevision) || 1),
  );
  // A mutation requested after a successful validation opens a genuinely new
  // objective revision. Validation-stage follow-up edits before any successful
  // validation stay in the same revision and retain the finite checkpoint.
  const objectiveRevision = checkpoint?.objectiveValidationEvidence
    ? previousRevision + 1
    : previousRevision;
  const identity = requirementRef
    ? `requirement:${requirementRef.toLowerCase()}`
    : planTaskId
      ? `task:${planTaskId.toLowerCase()}`
      : checkpoint?.objectiveObligationId?.trim() || "root:direct-edit";
  const expectedTargets = appendObjectiveExpectedTargets(
    checkpoint,
    [
      ...(input.expectedTarget ? [input.expectedTarget] : []),
      ...input.evidenceTargets,
    ],
  );
  return {
    ...(checkpoint || {
      expectedTarget: input.expectedTarget,
      sourceObservationKey: null,
      nextRequiredCapability: "validation" as const,
    }),
    objectiveObligationId: identity,
    objectiveRevision,
    objectiveKind,
    objectiveExpectedTargets: expectedTargets,
    objectiveMutationEvidence: appendObjectiveMutationEvidence(
      checkpoint,
      input.evidenceTargets,
    ),
    objectiveValidationEvidence: null,
    objectiveClosurePending: true,
  };
}

function resolveObjectiveMutationCoverage(input: {
  checkpoint: ExecutionDecisionCheckpoint | null;
  expectedTarget: string | null;
}): { covered: boolean; missingTargets: string[]; kind: "root" | "requirement" } {
  const checkpoint = input.checkpoint;
  const kind = checkpoint?.objectiveKind || (
    checkpoint?.requirementRef || checkpoint?.planTaskId ? "requirement" : "root"
  );
  const expectedTargets = checkpoint?.objectiveExpectedTargets?.length
    ? checkpoint.objectiveExpectedTargets
    : input.expectedTarget
      ? [input.expectedTarget]
      : [];
  const requirementRef = checkpoint?.requirementRef?.trim().toLowerCase() || "";
  const evidence = checkpoint?.objectiveMutationEvidence || [];
  const missingTargets = expectedTargets.filter((target) => !evidence.some((entry) =>
    workspacePathsReferToSameFile(entry.target, target) &&
    (
      kind === "root" ||
      !requirementRef ||
      String(entry.requirementRef || "").trim().toLowerCase() === requirementRef
    )
  ));
  return {
    covered: expectedTargets.length > 0 && missingTargets.length === 0,
    missingTargets,
    kind,
  };
}

function buildExecuteRecoveryDecisionCheckpoint(input: {
  expectedTarget: string | null;
  sourceObservationKey: string | null;
  nextRequiredCapability: ExecutionDecisionCheckpoint["nextRequiredCapability"];
  previous: ExecutionDecisionCheckpoint | null;
  evidenceVersion?: string | null;
}): ExecutionDecisionCheckpoint | null {
  if (!input.expectedTarget && !input.previous) return null;
  const evidenceVersion = input.evidenceVersion === undefined
    ? input.previous?.evidenceVersion || null
    : input.evidenceVersion;
  const planTaskId = input.previous?.planTaskId?.trim() || null;
  const requirementRef = input.previous?.requirementRef?.trim() || null;
  const pendingFiniteValidation = input.previous?.pendingFiniteValidation || null;
  const validationMutationReopenCount = Math.max(
    0,
    Math.floor(Number(input.previous?.validationMutationReopenCount) || 0),
  );
  const validationMutationReopenFingerprints =
    input.previous?.validationMutationReopenFingerprints || [];
  const objectiveMutationEvidence = input.previous?.objectiveMutationEvidence || [];
  const objectiveClosurePending = input.previous?.objectiveClosurePending === true;
  const objectiveObligationId = input.previous?.objectiveObligationId?.trim() || null;
  const objectiveRevision = Math.max(
    1,
    Math.floor(Number(input.previous?.objectiveRevision) || 1),
  );
  const objectiveKind = input.previous?.objectiveKind;
  const objectiveExpectedTargets = input.previous?.objectiveExpectedTargets || [];
  const objectiveValidationEvidence = input.previous?.objectiveValidationEvidence || null;
  const browserFailureFingerprint = input.previous?.browserFailureFingerprint || null;
  const browserFailureCallSignature = input.previous?.browserFailureCallSignature || null;
  const browserFailureDetail = input.previous?.browserFailureDetail || null;
  const browserFailedLocator = input.previous?.browserFailedLocator || null;
  const browserLocatorCandidates = input.previous?.browserLocatorCandidates || [];
  const browserRequestedUrl = input.previous?.browserRequestedUrl || null;
  return {
    expectedTarget: input.expectedTarget,
    sourceObservationKey: input.sourceObservationKey,
    nextRequiredCapability: input.nextRequiredCapability,
    ...(evidenceVersion
      ? { evidenceVersion }
      : {}),
    ...(planTaskId ? { planTaskId } : {}),
    ...(requirementRef ? { requirementRef } : {}),
    ...(pendingFiniteValidation ? { pendingFiniteValidation } : {}),
    ...(validationMutationReopenCount > 0
      ? { validationMutationReopenCount }
      : {}),
    ...(validationMutationReopenFingerprints.length > 0
      ? { validationMutationReopenFingerprints }
      : {}),
    ...(objectiveMutationEvidence.length > 0
      ? { objectiveMutationEvidence }
      : {}),
    ...(objectiveObligationId ? { objectiveObligationId } : {}),
    ...(input.previous?.objectiveRevision !== undefined ? { objectiveRevision } : {}),
    ...(objectiveKind ? { objectiveKind } : {}),
    ...(objectiveExpectedTargets.length > 0 ? { objectiveExpectedTargets } : {}),
    ...(input.previous?.objectiveValidationEvidence !== undefined
      ? { objectiveValidationEvidence }
      : {}),
    ...(objectiveClosurePending ? { objectiveClosurePending: true } : {}),
    ...(browserFailureFingerprint ? { browserFailureFingerprint } : {}),
    ...(browserFailureCallSignature ? { browserFailureCallSignature } : {}),
    ...(browserFailureDetail ? { browserFailureDetail } : {}),
    ...(browserFailedLocator ? { browserFailedLocator } : {}),
    ...(browserLocatorCandidates.length > 0 ? { browserLocatorCandidates } : {}),
    ...(browserRequestedUrl ? { browserRequestedUrl } : {}),
  };
}

function inheritExecuteRecoveryCheckpointIdentity(
  checkpoint: ExecutionDecisionCheckpoint | null,
  previous: ExecutionDecisionCheckpoint | null,
): ExecutionDecisionCheckpoint | null {
  if (!checkpoint) return checkpoint;
  const planTaskId = checkpoint.planTaskId?.trim() || previous?.planTaskId?.trim() || null;
  const requirementRef = checkpoint.requirementRef?.trim() || previous?.requirementRef?.trim() || null;
  const pendingFiniteValidation = checkpoint.pendingFiniteValidation ||
    previous?.pendingFiniteValidation || null;
  const validationMutationReopenCount = Math.max(
    0,
    Math.floor(Number(
      checkpoint.validationMutationReopenCount ??
      previous?.validationMutationReopenCount,
    ) || 0),
  );
  const validationMutationReopenFingerprints =
    checkpoint.validationMutationReopenFingerprints ??
    previous?.validationMutationReopenFingerprints ??
    [];
  const objectiveMutationEvidence = checkpoint.objectiveMutationEvidence ??
    previous?.objectiveMutationEvidence ??
    [];
  const objectiveClosurePending = checkpoint.objectiveClosurePending ??
    previous?.objectiveClosurePending ??
    false;
  const objectiveObligationId = checkpoint.objectiveObligationId?.trim() ||
    previous?.objectiveObligationId?.trim() || null;
  const objectiveRevision = Math.max(
    1,
    Math.floor(Number(checkpoint.objectiveRevision ?? previous?.objectiveRevision) || 1),
  );
  const objectiveKind = checkpoint.objectiveKind || previous?.objectiveKind;
  const objectiveExpectedTargets = checkpoint.objectiveExpectedTargets ??
    previous?.objectiveExpectedTargets ?? [];
  const objectiveValidationEvidence = checkpoint.objectiveValidationEvidence ??
    previous?.objectiveValidationEvidence ?? null;
  const browserFailureFingerprint = checkpoint.browserFailureFingerprint ||
    previous?.browserFailureFingerprint || null;
  const browserFailureCallSignature = checkpoint.browserFailureCallSignature === undefined
    ? previous?.browserFailureCallSignature || null
    : checkpoint.browserFailureCallSignature?.trim() || null;
  const browserFailureDetail = checkpoint.browserFailureDetail ||
    previous?.browserFailureDetail || null;
  const browserFailedLocator = checkpoint.browserFailedLocator ||
    previous?.browserFailedLocator || null;
  const browserLocatorCandidates = checkpoint.browserLocatorCandidates ??
    previous?.browserLocatorCandidates ?? [];
  const browserRequestedUrl = checkpoint.browserRequestedUrl ||
    previous?.browserRequestedUrl || null;
  const noProgressStrategyPivots = checkpoint.noProgressStrategyPivots ??
    previous?.noProgressStrategyPivots ?? [];
  return {
    ...checkpoint,
    ...(planTaskId ? { planTaskId } : {}),
    ...(requirementRef ? { requirementRef } : {}),
    ...(pendingFiniteValidation ? { pendingFiniteValidation } : {}),
    ...(validationMutationReopenCount > 0
      ? { validationMutationReopenCount }
      : {}),
    ...(validationMutationReopenFingerprints.length > 0
      ? { validationMutationReopenFingerprints }
      : {}),
    ...(objectiveMutationEvidence.length > 0
      ? { objectiveMutationEvidence }
      : {}),
    ...(objectiveObligationId ? { objectiveObligationId } : {}),
    ...(checkpoint.objectiveRevision !== undefined || previous?.objectiveRevision !== undefined
      ? { objectiveRevision }
      : {}),
    ...(objectiveKind ? { objectiveKind } : {}),
    ...(objectiveExpectedTargets.length > 0 ? { objectiveExpectedTargets } : {}),
    ...(checkpoint.objectiveValidationEvidence !== undefined ||
      previous?.objectiveValidationEvidence !== undefined
      ? { objectiveValidationEvidence }
      : {}),
    ...(objectiveClosurePending ? { objectiveClosurePending: true } : {}),
    ...(browserFailureFingerprint ? { browserFailureFingerprint } : {}),
    ...(checkpoint.browserFailureCallSignature !== undefined ||
      previous?.browserFailureCallSignature !== undefined
      ? { browserFailureCallSignature }
      : {}),
    ...(browserFailureDetail ? { browserFailureDetail } : {}),
    ...(browserFailedLocator ? { browserFailedLocator } : {}),
    ...(browserLocatorCandidates.length > 0 ? { browserLocatorCandidates } : {}),
    ...(browserRequestedUrl ? { browserRequestedUrl } : {}),
    ...(noProgressStrategyPivots.length > 0
      ? { noProgressStrategyPivots: [...noProgressStrategyPivots] }
      : {}),
  };
}

export function createExecuteRecoveryRuntimeState(input: {
  workflowMode: "chat" | "edit" | "plan";
  forcedMode?: ExecuteRecoveryMode | null;
  forcedState?: ForcedExecuteRecoveryRuntimeState | null;
}): ExecuteRecoveryRuntimeState {
  const hasForcedRecovery = normalizeExecuteRecoveryMode(
    input.forcedState?.mode ?? input.forcedMode,
  ) !== "normal";
  const recoveryEligible =
    input.workflowMode === "edit" ||
    (input.workflowMode === "plan" && hasForcedRecovery);
  const requestedMode = recoveryEligible
    ? normalizeExecuteRecoveryMode(input.forcedState?.mode ?? input.forcedMode)
    : "normal";
  const forcedExpectedTarget = requestedMode === "normal"
    ? null
    : input.forcedState?.expectedTarget?.trim() || null;
  const legacyPostMutationReadLease = isLegacyPostMutationReadLease(
    input.forcedState?.readLease,
  );
  const forcedReadObligation = !legacyPostMutationReadLease && requestedMode !== "normal" &&
    input.forcedState?.decisionCheckpoint?.nextRequiredCapability === "targeted_read";
  const restoredReadLease = migrateRecoveryReadLease(input.forcedState?.readLease);
  const synthesizedReadLease = forcedReadObligation && forcedExpectedTarget &&
    !restoredReadLease
      ? {
          purpose: "missing_window" as const,
          target: forcedExpectedTarget,
          observedVersion: input.forcedState?.decisionCheckpoint?.evidenceVersion || null,
          state: "available" as const,
        }
      : null;
  const readLease = requestedMode === "normal"
    ? null
    : restoredReadLease || synthesizedReadLease;
  const mode = requestedMode !== "normal" && readLease &&
    (readLease.state === "available" || readLease.state === "active")
      ? "patch_recovery_read"
      : requestedMode === "patch_recovery_read"
        ? "mutation_first"
        : requestedMode;
  const phaseNoProgressCount = mode === "normal"
    ? 0
    : Math.max(0, input.forcedState?.phaseNoProgressCount || 0);
  return {
    mode,
    reason: mode === "normal"
      ? ""
      : input.forcedState?.reason?.trim() || "forced_execute_recovery",
    expectedTarget: mode === "normal"
      ? null
      : forcedExpectedTarget,
    attempts: mode === "normal"
      ? 0
      : Math.max(1, Math.floor(Number(input.forcedState?.attempts) || 1)),
    phaseNoProgressCount,
    iterationCount: phaseNoProgressCount,
    protocolNoProgressCount: mode === "normal"
      ? 0
      : Math.max(0, input.forcedState?.protocolNoProgressCount || 0),
    protocolNoProgressFingerprint: mode === "normal"
      ? null
      : input.forcedState?.protocolNoProgressFingerprint?.trim() || null,
    readLease,
    sourceObservationKey: mode === "normal"
      ? null
      : input.forcedState?.sourceObservationKey?.trim() || null,
    decisionCheckpoint: mode === "normal"
      ? null
      : legacyPostMutationReadLease
        ? buildExecuteRecoveryDecisionCheckpoint({
            expectedTarget: forcedExpectedTarget,
            sourceObservationKey:
              input.forcedState?.sourceObservationKey?.trim() || null,
            nextRequiredCapability: "validation",
            previous: input.forcedState?.decisionCheckpoint || null,
          })
        : input.forcedState?.decisionCheckpoint || null,
  };
}

export function activateExecuteRecoveryRuntimeState(
  state: ExecuteRecoveryRuntimeState,
  input: {
    mode: Exclude<ExecuteRecoveryMode, "normal">;
    reason: string;
    expectedTarget?: string | null;
    /** Explicitly release a prior single-target lock for an objective follow-up. */
    resetExpectedTarget?: boolean;
    readLease?: RecoveryReadLease | null;
    sourceObservationKey?: string | null;
    decisionCheckpoint?: ExecutionDecisionCheckpoint | null;
  },
): ExecuteRecoveryRuntimeState {
  const requestedMode = normalizeExecuteRecoveryMode(input.mode) as Exclude<ExecuteRecoveryMode, "normal">;
  const requestedExpectedTarget = input.expectedTarget?.trim() || null;
  const expectedTarget = input.resetExpectedTarget
    ? requestedExpectedTarget
    : requestedExpectedTarget || state.expectedTarget;
  const readLease = migrateRecoveryReadLease(
    input.readLease === undefined ? state.readLease : input.readLease,
  );
  const hasActiveContextLease = Boolean(
    readLease &&
    (readLease.state === "available" || readLease.state === "active")
  );
  // Lease state is authoritative. Callers cannot request a mutation-only tool
  // surface while simultaneously carrying an unconsumed context-read lease.
  const nextMode: Exclude<ExecuteRecoveryMode, "normal"> = hasActiveContextLease
    ? "patch_recovery_read"
    : requestedMode === "patch_recovery_read"
      ? "mutation_first"
      : requestedMode;
  const requestedSourceObservationKey = input.sourceObservationKey === undefined
    ? state.sourceObservationKey
    : input.sourceObservationKey?.trim() || null;
  const sourceObservationKey = requestedSourceObservationKey || (
    readLease?.state === "consumed"
      ? readLease.observationKey?.trim() || null
      : null
  );
  const requestedDecisionCheckpoint = input.decisionCheckpoint === undefined
    ? undefined
    : inheritExecuteRecoveryCheckpointIdentity(
        input.decisionCheckpoint,
        state.decisionCheckpoint,
      );
  const previousContract = resolveExecuteRecoveryActionContract(state.mode, {
    expectedTarget: state.expectedTarget,
    readLease: state.readLease,
    sourceObservationKey: state.sourceObservationKey,
    decisionCheckpoint: state.decisionCheckpoint,
    phaseNoProgressCount: state.phaseNoProgressCount,
    protocolNoProgressCount: state.protocolNoProgressCount,
    protocolNoProgressFingerprint: state.protocolNoProgressFingerprint,
  });
  const nextContract = resolveExecuteRecoveryActionContract(nextMode, {
    expectedTarget,
    readLease,
    sourceObservationKey,
    decisionCheckpoint: requestedDecisionCheckpoint === undefined
      ? state.decisionCheckpoint
      : requestedDecisionCheckpoint,
    phaseNoProgressCount: state.phaseNoProgressCount,
    protocolNoProgressCount: state.protocolNoProgressCount,
    protocolNoProgressFingerprint: state.protocolNoProgressFingerprint,
  });
  const phaseChanged = previousContract.phase !== nextContract.phase;
  const capabilityChanged =
    previousContract.nextRequiredCapability !== nextContract.nextRequiredCapability;
  const targetChanged = Boolean(
    expectedTarget &&
    (!state.expectedTarget ||
      !workspacePathsReferToSameFile(expectedTarget, state.expectedTarget)),
  );
  const nextState: ExecuteRecoveryRuntimeState = {
    ...state,
    mode: nextMode,
    reason: input.reason,
    expectedTarget,
    attempts: state.attempts + 1,
    readLease,
    sourceObservationKey,
    decisionCheckpoint: requestedDecisionCheckpoint === undefined
      ? buildExecuteRecoveryDecisionCheckpoint({
          expectedTarget,
          sourceObservationKey,
          nextRequiredCapability: nextContract.nextRequiredCapability,
          previous: state.decisionCheckpoint,
        })
      : requestedDecisionCheckpoint,
  };
  return phaseChanged || capabilityChanged || targetChanged
    ? resetExecuteRecoveryPhaseProgress(nextState)
    : nextState;
}

export function clearExecuteRecoveryRuntimeState(
  state: ExecuteRecoveryRuntimeState,
): ExecuteRecoveryRuntimeState {
  return {
    ...state,
    mode: "normal",
    reason: "",
    expectedTarget: null,
    attempts: 0,
    phaseNoProgressCount: 0,
    iterationCount: 0,
    protocolNoProgressCount: 0,
    protocolNoProgressFingerprint: null,
    readLease: null,
    sourceObservationKey: null,
    decisionCheckpoint: null,
  };
}

/**
 * A finite project command may be synthesized only for the generic validation
 * lane. Browser, desktop, and process-lifecycle checkpoints are already exact
 * obligations; replacing one with `validation` would hide its required tool
 * surface and strand the loop on an unrelated build/test command.
 */
export function shouldPinExecuteRecoveryFiniteValidationCheckpoint(
  state: ExecuteRecoveryRuntimeState,
): boolean {
  if (
    state.mode !== "validation_only" &&
    state.mode !== "finite_validation_only"
  ) return false;
  if (state.decisionCheckpoint?.pendingFiniteValidation) return false;
  const nextCapability = state.decisionCheckpoint?.nextRequiredCapability;
  return !nextCapability || nextCapability === "validation";
}

/**
 * Attach the runtime-selected finite acceptance boundary without spending a
 * recovery attempt or resetting no-progress accounting. Discovery is an
 * internal policy step; only executing the command is model-visible progress.
 */
export function pinExecuteRecoveryFiniteValidationCheckpoint(
  state: ExecuteRecoveryRuntimeState,
  checkpoint: PendingFiniteValidationCheckpoint,
): ExecuteRecoveryRuntimeState {
  if (!shouldPinExecuteRecoveryFiniteValidationCheckpoint(state)) return state;
  const command = checkpoint.command.trim();
  const cwd = checkpoint.cwd.trim() || ".";
  if (!command) return state;
  return {
    ...state,
    decisionCheckpoint: {
      ...(state.decisionCheckpoint || {
        expectedTarget: state.expectedTarget,
        sourceObservationKey: state.sourceObservationKey,
        nextRequiredCapability: "validation" as const,
      }),
      expectedTarget: state.expectedTarget,
      sourceObservationKey: state.sourceObservationKey,
      nextRequiredCapability: "validation",
      pendingFiniteValidation: {
        command,
        cwd,
        ...(Number.isFinite(checkpoint.timeoutMs) && Number(checkpoint.timeoutMs) > 0
          ? { timeoutMs: Math.floor(Number(checkpoint.timeoutMs)) }
          : {}),
      },
    },
  };
}

function transitionValidatedObjective(
  state: ExecuteRecoveryRuntimeState,
  validationTarget: string,
  validationToolName: string,
): {
  state: ExecuteRecoveryRuntimeState;
  transition: ExecuteRecoveryPhaseTransition;
  target: string | null;
  consumedExpectedRead: false;
} {
  const checkpoint = state.decisionCheckpoint;
  const target = state.expectedTarget || validationTarget;
  if (checkpoint?.objectiveClosurePending !== true) {
    return {
      state: clearExecuteRecoveryRuntimeState(state),
      transition: "validation_to_normal",
      target,
      consumedExpectedRead: false,
    };
  }

  const coverage = resolveObjectiveMutationCoverage({
    checkpoint,
    expectedTarget: state.expectedTarget,
  });
  const objectiveRevision = Math.max(
    1,
    Math.floor(Number(checkpoint.objectiveRevision) || 1),
  );
  const verifiedCheckpoint: ExecutionDecisionCheckpoint = {
    ...checkpoint,
    objectiveRevision,
    objectiveKind: coverage.kind,
    objectiveValidationEvidence: {
      tool: validationToolName || "validation",
      target: validationTarget,
      revision: objectiveRevision,
    },
    objectiveClosurePending: true,
  };

  if (!coverage.covered) {
    const missingTarget = coverage.missingTargets[0] || state.expectedTarget;
    const readLease: RecoveryReadLease | null = missingTarget
      ? {
          purpose: "missing_window",
          target: missingTarget,
          state: "available",
        }
      : null;
    return {
      state: resetExecuteRecoveryPhaseProgress({
        ...state,
        mode: readLease ? "patch_recovery_read" : "mutation_first",
        reason: "objective_obligation_mutation_evidence_missing",
        expectedTarget: missingTarget || null,
        readLease,
        sourceObservationKey: null,
        decisionCheckpoint: {
          ...verifiedCheckpoint,
          expectedTarget: missingTarget || null,
          sourceObservationKey: null,
          nextRequiredCapability: readLease ? "targeted_read" : "mutation",
        },
      }),
      transition: "validation_progress",
      target: missingTarget || target,
      consumedExpectedRead: false,
    };
  }

  if (coverage.kind === "root") {
    return {
      state: resetExecuteRecoveryPhaseProgress({
        ...state,
        mode: "objective_audit",
        reason: "objective_closure_audit_required",
        readLease: null,
        decisionCheckpoint: {
          ...verifiedCheckpoint,
          expectedTarget: state.expectedTarget,
          sourceObservationKey: state.sourceObservationKey,
          nextRequiredCapability: "any",
        },
      }),
      transition: "validation_to_objective_audit",
      target,
      consumedExpectedRead: false,
    };
  }

  return {
    state: clearExecuteRecoveryRuntimeState(state),
    transition: "validation_to_normal",
    target,
    consumedExpectedRead: false,
  };
}

/**
 * Advance an active recovery transaction from observed tool evidence. Phase
 * transitions do not consume another recovery attempt: they are progress in
 * the same transaction. Only a verified validation result may return to the
 * normal tool surface.
 */
export function transitionExecuteRecoveryRuntimeState(
  state: ExecuteRecoveryRuntimeState,
  observation: ExecuteRecoveryObservation,
): {
  state: ExecuteRecoveryRuntimeState;
  transition: ExecuteRecoveryPhaseTransition;
  target: string | null;
  consumedExpectedRead: boolean;
} {
  if (state.mode === "normal") {
    return { state, transition: "none", target: null, consumedExpectedRead: false };
  }

  const observedExpectedTarget = observation.expectedTarget?.trim() || null;
  const expectedTarget = state.expectedTarget || observedExpectedTarget;
  const transactionState = expectedTarget && expectedTarget !== state.expectedTarget
    ? { ...state, expectedTarget }
    : state;
  const contract = resolveExecuteRecoveryActionContract(state.mode, {
    expectedTarget,
    readLease: state.readLease,
    sourceObservationKey: state.sourceObservationKey,
    decisionCheckpoint: state.decisionCheckpoint,
    phaseNoProgressCount: state.phaseNoProgressCount,
    protocolNoProgressCount: state.protocolNoProgressCount,
    protocolNoProgressFingerprint: state.protocolNoProgressFingerprint,
  });

  if (
    contract.nextRequiredCapability === "browser_diagnostic" &&
    observation.validationTarget &&
    observation.validationToolName === "browser_evaluate"
  ) {
    // A corrected interaction closes a spec-diagnostic transaction directly.
    // Diagnostic reads remain non-causal and cannot select a mutation target.
    return transitionValidatedObjective(
      transactionState,
      observation.validationTarget,
      observation.validationToolName,
    );
  }

  if (contract.phase === "context" && observation.freshReadTarget) {
    const contextTarget = expectedTarget || observation.freshReadTarget;
    if (!workspacePathsReferToSameFile(observation.freshReadTarget, contextTarget)) {
      return {
        state: transactionState,
        transition: "none",
        target: contextTarget,
        consumedExpectedRead: false,
      };
    }
    const activeReadLease = contract.readLease &&
      (contract.readLease.state === "available" || contract.readLease.state === "active")
        ? contract.readLease
        : null;
    const commitContextProgress = (next: ExecuteRecoveryRuntimeState) =>
      observation.sourceObservationWasCacheStub === true
        ? next
        : resetExecuteRecoveryPhaseProgress(next);
    if (activeReadLease?.coverageMode === "segmented_exact") {
      const requiredRange = normalizeRecoveryReadRange(
        activeReadLease.requiredRange || activeReadLease.requestedRange,
      );
      const remainingRange = normalizeRecoveryReadRange(activeReadLease.requestedRange);
      const observedRange = normalizeRecoveryReadRange(observation.sourceRequestedRange);
      if (!requiredRange || !remainingRange || !observedRange) {
        return {
          state: transactionState,
          transition: "none",
          target: contextTarget,
          consumedExpectedRead: false,
        };
      }
      const requiredStart = requiredRange.startLine || 1;
      const requiredEnd = requiredRange.endLine ?? (
        requiredRange.maxLines
          ? requiredStart + requiredRange.maxLines - 1
          : requiredStart
      );
      const remainingStart = remainingRange.startLine || requiredStart;
      const observedStart = observedRange.startLine || remainingStart;
      const observedEnd = observedRange.endLine ?? (
        observedRange.maxLines
          ? observedStart + observedRange.maxLines - 1
          : observedStart
      );
      const expectedVersion = String(activeReadLease.observedVersion || "").trim();
      const observedVersion = String(observation.sourceObservedVersion || "").trim();
      if (expectedVersion && observedVersion && expectedVersion !== observedVersion) {
        const sourceObservationKey = observation.sourceObservationKey?.trim() || null;
        return {
          state: commitContextProgress({
            ...transactionState,
            reason: "recovery_plan_line_version_changed",
            sourceObservationKey,
            readLease: {
              ...activeReadLease,
              requestedRange: requiredRange,
              requiredRange,
              coveredRanges: [],
              observedVersion,
              observationKey: sourceObservationKey,
              observationKeys: [],
              state: "available",
            },
            decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
              expectedTarget: contextTarget,
              sourceObservationKey,
              nextRequiredCapability: "targeted_read",
              evidenceVersion: observedVersion,
              previous: state.decisionCheckpoint,
            }),
          }),
          transition: "context_refreshed",
          target: contextTarget,
          consumedExpectedRead: false,
        };
      }
      const runtimeNarrowedPrefix =
        observation.sourceRangeWasRuntimeNarrowed === true &&
        observedStart > remainingStart;
      if (
        (observedStart !== remainingStart && !runtimeNarrowedPrefix) ||
        observedStart > requiredEnd ||
        observedEnd < observedStart ||
        observedEnd > requiredEnd
      ) {
        return {
          state: transactionState,
          transition: "none",
          target: contextTarget,
          consumedExpectedRead: false,
        };
      }
      const sourceObservationKey = observation.sourceObservationKey?.trim() || state.sourceObservationKey;
      const sourceObservationKeys = Array.from(new Set([
        ...(activeReadLease.observationKeys || []),
        ...(sourceObservationKey ? [sourceObservationKey] : []),
      ]));
      const coveredRanges = [
        ...(activeReadLease.coveredRanges || []),
        { startLine: remainingStart, endLine: observedEnd },
      ];
      if (observedEnd < requiredEnd) {
        const nextStartLine = observedEnd + 1;
        return {
          state: commitContextProgress({
            ...transactionState,
            reason: "recovery_plan_line_segment_observed",
            sourceObservationKey,
            readLease: {
              ...activeReadLease,
              requestedRange: {
                startLine: nextStartLine,
                endLine: requiredEnd,
                maxLines: requiredEnd - nextStartLine + 1,
              },
              requiredRange,
              coveredRanges,
              observedVersion: observedVersion || expectedVersion || null,
              observationKey: sourceObservationKey,
              observationKeys: sourceObservationKeys,
              state: "available",
            },
            decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
              expectedTarget: contextTarget,
              sourceObservationKey,
              nextRequiredCapability: "targeted_read",
              evidenceVersion: observedVersion || expectedVersion || null,
              previous: state.decisionCheckpoint,
            }),
          }),
          transition: "context_refreshed",
          target: contextTarget,
          consumedExpectedRead: false,
        };
      }
      return {
        state: commitContextProgress({
          ...transactionState,
          mode: "mutation_first",
          reason: "recovery_context_observed",
          expectedTarget: contextTarget,
          sourceObservationKey,
          readLease: {
            ...activeReadLease,
            requestedRange: observation.sourceRequestedRange || remainingRange,
            requiredRange,
            coveredRanges,
            observedVersion: observedVersion || expectedVersion || null,
            observationKey: sourceObservationKey,
            observationKeys: sourceObservationKeys,
            state: "consumed",
          },
          decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
            expectedTarget: contextTarget,
            sourceObservationKey,
            nextRequiredCapability: "mutation",
            previous: state.decisionCheckpoint,
          }),
        }),
        transition: "context_to_mutation",
        target: contextTarget,
        consumedExpectedRead: true,
      };
    }
    const expectedVersion = String(activeReadLease?.observedVersion || "").trim();
    const observedVersion = String(observation.sourceObservedVersion || "").trim();
    const sourceVersionChanged = Boolean(
      activeReadLease && expectedVersion && observedVersion && expectedVersion !== observedVersion
    );
    if (sourceVersionChanged && activeReadLease?.purpose === "initial_targeting") {
      const sourceObservationKey = observation.sourceObservationKey?.trim() || null;
      return {
        state: commitContextProgress({
          ...transactionState,
          mode: "action_plus_targeting",
          reason: "recovery_source_version_changed",
          expectedTarget: contextTarget,
          sourceObservationKey,
          readLease: null,
          decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
            expectedTarget: contextTarget,
            sourceObservationKey,
            nextRequiredCapability: "targeting",
            evidenceVersion: observedVersion,
            previous: state.decisionCheckpoint,
          }),
        }),
        transition: "context_version_changed_to_targeting",
        target: contextTarget,
        consumedExpectedRead: false,
      };
    }
    const currentVersionLease = sourceVersionChanged && activeReadLease
      ? { ...activeReadLease, observedVersion }
      : activeReadLease;
    const leaseMatchesEvidence = Boolean(currentVersionLease) && readEvidenceSatisfiesRecoveryLease({
      lease: currentVersionLease,
      target: observation.freshReadTarget,
      requestedRange: observation.sourceRequestedRange,
      observedVersion: observation.sourceObservedVersion,
    });
    if (!leaseMatchesEvidence) {
      if (sourceVersionChanged && currentVersionLease) {
        const sourceObservationKey = observation.sourceObservationKey?.trim() || null;
        return {
          state: commitContextProgress({
            ...transactionState,
            reason: "recovery_source_version_refreshed",
            sourceObservationKey,
            readLease: { ...currentVersionLease, state: "available" },
            decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
              expectedTarget: contextTarget,
              sourceObservationKey,
              nextRequiredCapability: "targeted_read",
              evidenceVersion: observedVersion,
              previous: state.decisionCheckpoint,
            }),
          }),
          transition: "context_refreshed",
          target: contextTarget,
          consumedExpectedRead: false,
        };
      }
      return {
        state: transactionState,
        transition: "none",
        target: contextTarget,
        consumedExpectedRead: false,
      };
    }
    const sourceObservationKey = observation.sourceObservationKey?.trim() || state.sourceObservationKey;
    const nextState = commitContextProgress({
        ...transactionState,
        mode: "mutation_first",
        reason: "recovery_context_observed",
        expectedTarget: contextTarget,
        sourceObservationKey,
        readLease: activeReadLease && workspacePathsReferToSameFile(activeReadLease.target, contextTarget)
          ? {
              ...activeReadLease,
              state: "consumed",
              observationKey: sourceObservationKey,
              observationKeys: Array.from(new Set([
                ...(activeReadLease.observationKeys || []),
                ...(sourceObservationKey ? [sourceObservationKey] : []),
              ])),
              requestedRange: observation.sourceRequestedRange || activeReadLease.requestedRange,
              observedVersion: observation.sourceObservedVersion || activeReadLease.observedVersion,
            }
          : null,
        decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
          expectedTarget: contextTarget,
          sourceObservationKey,
          nextRequiredCapability: "mutation",
          previous: state.decisionCheckpoint,
        }),
      });
    return {
      state: nextState,
      transition: "context_to_mutation",
      target: contextTarget,
      consumedExpectedRead: true,
    };
  }

  if (contract.phase !== "context" && observation.freshReadTarget) {
    const objectiveAuditTargetSwitch = state.mode === "objective_audit" && Boolean(
      expectedTarget &&
      !workspacePathsReferToSameFile(observation.freshReadTarget, expectedTarget),
    );
    const contextTarget = objectiveAuditTargetSwitch
      ? observation.freshReadTarget
      : expectedTarget || observation.freshReadTarget;
    if (
      state.mode !== "objective_audit" &&
      !workspacePathsReferToSameFile(observation.freshReadTarget, contextTarget)
    ) {
      return {
        state: transactionState,
        transition: "none",
        target: contextTarget,
        consumedExpectedRead: false,
      };
    }
    const activeReadLease = contract.readLease &&
      (contract.readLease.state === "available" || contract.readLease.state === "active")
        ? contract.readLease
        : null;
    const leaseMatchesEvidence = Boolean(activeReadLease) && readEvidenceSatisfiesRecoveryLease({
      lease: activeReadLease,
      target: observation.freshReadTarget,
      requestedRange: observation.sourceRequestedRange,
      observedVersion: observation.sourceObservedVersion,
    });
    if (activeReadLease && !leaseMatchesEvidence) {
      return {
        state: transactionState,
        transition: "none",
        target: contextTarget,
        consumedExpectedRead: false,
      };
    }
    const sourceObservationKey = observation.sourceObservationKey?.trim() || state.sourceObservationKey;
    const observedVersion = observation.sourceObservedVersion?.trim() || null;
    const previousVersion = state.decisionCheckpoint?.evidenceVersion?.trim() || null;
    const observationChanged = Boolean(
      (sourceObservationKey && sourceObservationKey !== state.sourceObservationKey) ||
      (observedVersion && observedVersion !== previousVersion),
    );
    if (!activeReadLease && !observationChanged) {
      return {
        state: transactionState,
        transition: "none",
        target: contextTarget,
        consumedExpectedRead: false,
      };
    }
    return {
      state: resetExecuteRecoveryPhaseProgress({
        ...transactionState,
        expectedTarget: contextTarget,
        reason: activeReadLease
          ? transactionState.reason
          : "recovery_source_observation_refreshed",
        sourceObservationKey,
        readLease: activeReadLease && workspacePathsReferToSameFile(activeReadLease.target, contextTarget)
          ? {
              ...activeReadLease,
              state: "consumed",
              observationKey: sourceObservationKey,
              observationKeys: Array.from(new Set([
                ...(activeReadLease.observationKeys || []),
                ...(sourceObservationKey ? [sourceObservationKey] : []),
              ])),
              requestedRange: observation.sourceRequestedRange || activeReadLease.requestedRange,
              observedVersion: observation.sourceObservedVersion || activeReadLease.observedVersion,
            }
          : null,
        decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
          expectedTarget: contextTarget,
          sourceObservationKey,
          nextRequiredCapability: contract.nextRequiredCapability,
          previous: state.decisionCheckpoint,
          evidenceVersion: observedVersion || previousVersion,
        }),
      }),
      transition: "context_refreshed",
      target: contextTarget,
      consumedExpectedRead: Boolean(activeReadLease),
    };
  }

  if (
    contract.phase !== "context" &&
    (observation.mutationTarget || observation.mutationTargets?.length)
  ) {
    const structuredMutationTargets = (observation.mutationTargets || [])
      .map((target) => target.trim())
      .filter(Boolean);
    const observedMutationTargets = [...new Set(
      structuredMutationTargets.length > 0
        ? structuredMutationTargets
        : observation.mutationTarget
          ? [observation.mutationTarget.trim()].filter(Boolean)
          : [],
    )];
    const auditTargetSwitch = state.mode === "objective_audit" &&
      observedMutationTargets.length > 0 &&
      Boolean(
        expectedTarget &&
        !observedMutationTargets.some((target) =>
          workspacePathsReferToSameFile(target, expectedTarget)
        ),
      );
    const mutationTarget = auditTargetSwitch
      ? observedMutationTargets[0] || null
      : expectedTarget || observedMutationTargets[0] || null;
    if (
      !mutationTarget ||
      (state.mode !== "objective_audit" && expectedTarget && !observedMutationTargets.some((target) =>
        workspacePathsReferToSameFile(target, expectedTarget)
      ))
    ) {
      return {
        state: transactionState,
        transition: "none",
        target: mutationTarget,
        consumedExpectedRead: false,
      };
    }
    const evidenceTargets = observedMutationTargets.map((target) =>
      !auditTargetSwitch && expectedTarget && workspacePathsReferToSameFile(target, expectedTarget)
        ? expectedTarget
        : target
    );
    const nextExpectedTarget = auditTargetSwitch
      ? observedMutationTargets.length === 1
        ? observedMutationTargets[0]
        : null
      : expectedTarget || (
          observedMutationTargets.length === 1 ? mutationTarget : null
        );
    const objectiveCheckpoint = buildObjectiveMutationCheckpoint({
      checkpoint: state.decisionCheckpoint,
      expectedTarget: nextExpectedTarget,
      evidenceTargets,
    });
    return {
      state: resetExecuteRecoveryPhaseProgress({
        ...transactionState,
        mode: "validation_only",
        reason: "recovery_mutation_observed",
        expectedTarget: nextExpectedTarget,
        // A successful mutation carries structured changed-path/diff evidence,
        // but it does not prove the whole user objective is implemented. Move
        // provisionally to validation; assistantCompletionPhase may reopen the
        // mutation surface for a distinct structured objective/target request.
        readLease: null,
        decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
          expectedTarget: nextExpectedTarget,
          sourceObservationKey: state.sourceObservationKey,
          nextRequiredCapability: "validation",
          previous: objectiveCheckpoint,
        }),
      }),
      transition: "mutation_to_validation",
      target: mutationTarget,
      consumedExpectedRead: false,
    };
  }

  if (
    (contract.phase === "validation" || contract.phase === "reconcile") &&
    observation.validationTarget
  ) {
    const validationToolName = observation.validationToolName?.trim() || "";
    const nextCapability = contract.nextRequiredCapability;
    const ptyObservation = [
      "read_pty_buffer",
      "read_pty_tail",
      "read_pty_since",
      "get_pty_status",
    ].includes(validationToolName);
    const ptyInput = validationToolName === "send_pty_input";
    const healthyServerReconciliation =
      validationToolName === "run_command" &&
      isLocalDevServerHealthProbeCommand(observation.validationTarget);
    const processLaunch =
      validationToolName === "execute_command" &&
      (nextCapability === "launch_long_process" || nextCapability === "recover_process");
    if (processLaunch || ptyInput) {
      return {
        state: resetExecuteRecoveryPhaseProgress({
          ...transactionState,
          reason: processLaunch
            ? "recovery_process_launched"
            : "recovery_pty_input_observed",
          decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
            expectedTarget,
            sourceObservationKey: state.sourceObservationKey,
            nextRequiredCapability: "observe_pty",
            previous: state.decisionCheckpoint,
          }),
        }),
        transition: "validation_progress",
        target: expectedTarget || observation.validationTarget,
        consumedExpectedRead: false,
      };
    }
    const processReady =
      (ptyObservation && nextCapability === "observe_pty") ||
      (
        healthyServerReconciliation &&
        (nextCapability === "recover_process" || nextCapability === "reconcile_server")
      );
    if (processReady) {
      // PTY readiness closes only the process-start obligation. If the Plan
      // also carries browser evidence, the task audit reactivates that
      // independent obligation after this transaction is cleared.
      return transitionValidatedObjective(
        transactionState,
        observation.validationTarget,
        validationToolName,
      );
    }
    const browserValidation = validationToolName === "browser_evaluate";
    const desktopValidation = validationToolName === "computer_use";
    if (
      nextCapability === "launch_long_process" ||
      nextCapability === "recover_process" ||
      nextCapability === "reconcile_server" ||
      nextCapability === "observe_pty" ||
      (nextCapability === "browser_validation" && !browserValidation) ||
      (nextCapability === "desktop_validation" && !desktopValidation)
    ) {
      return {
        state: transactionState,
        transition: "none",
        target: expectedTarget || observation.validationTarget,
        consumedExpectedRead: false,
      };
    }
    // Validation is often a workspace command rather than a file-targeted
    // operation. Closure remains bound to the transaction file identity.
    return transitionValidatedObjective(
      transactionState,
      observation.validationTarget,
      validationToolName,
    );
  }

  return {
    state: transactionState,
    transition: "none",
    target: expectedTarget,
    consumedExpectedRead: false,
  };
}

export function resolveExecuteRecoveryNoProgressBoundary(input: {
  state: ExecuteRecoveryRuntimeState;
  cause: string;
  language: "zh" | "en";
  availableToolNames?: Iterable<string> | null;
  unfinishedObjective?: string | null;
}): {
  state: ExecuteRecoveryRuntimeState;
  decision: ExecuteNoProgressStrategyDecision;
} {
  const decision = resolveExecuteNoProgressStrategyDecision({
    attemptedStrategies: input.state.decisionCheckpoint?.noProgressStrategyPivots,
    currentTaskId: input.state.decisionCheckpoint?.planTaskId,
    expectedTarget: input.state.expectedTarget,
    unfinishedObjective:
      input.unfinishedObjective || input.state.decisionCheckpoint?.requirementRef,
    availableToolNames: input.availableToolNames,
    cause: input.cause,
    language: input.language,
  });
  if (decision.action === "pause") {
    return { state: input.state, decision };
  }

  const previousCheckpoint = input.state.decisionCheckpoint;
  const closeRepeatedRead = Boolean(
    input.state.readLease &&
    (input.state.readLease.state === "available" || input.state.readLease.state === "active")
  );
  const nextCapability = closeRepeatedRead
    ? "mutation" as const
    : previousCheckpoint?.nextRequiredCapability || "mutation";
  const nextMode = closeRepeatedRead ? "mutation_first" as const : input.state.mode;
  const contractBoundaryChanged = closeRepeatedRead ||
    nextMode !== input.state.mode ||
    nextCapability !== previousCheckpoint?.nextRequiredCapability;
  const checkpoint: ExecutionDecisionCheckpoint = {
    ...(previousCheckpoint || {
      expectedTarget: input.state.expectedTarget,
      sourceObservationKey: input.state.sourceObservationKey,
      nextRequiredCapability: nextCapability,
    }),
    expectedTarget: input.state.expectedTarget,
    sourceObservationKey: input.state.sourceObservationKey,
    nextRequiredCapability: nextCapability,
    noProgressStrategyPivots: decision.attemptedStrategies,
  };
  return {
    decision,
    state: {
      ...input.state,
      mode: nextMode,
      reason: `no_progress_strategy_pivot:${decision.strategy}`,
      attempts: input.state.attempts + 1,
      // A wording-only pivot does not buy another recovery window. Reset the
      // hard budget only when the executable contract actually changes.
      phaseNoProgressCount: contractBoundaryChanged
        ? 0
        : input.state.phaseNoProgressCount,
      iterationCount: contractBoundaryChanged
        ? 0
        : input.state.iterationCount,
      protocolNoProgressCount: contractBoundaryChanged
        ? 0
        : input.state.protocolNoProgressCount,
      protocolNoProgressFingerprint: contractBoundaryChanged
        ? null
        : input.state.protocolNoProgressFingerprint,
      readLease: closeRepeatedRead ? null : input.state.readLease,
      decisionCheckpoint: checkpoint,
    },
  };
}

export function advanceExecuteRecoveryRuntimeIteration(
  state: ExecuteRecoveryRuntimeState,
): {
  state: ExecuteRecoveryRuntimeState;
  maxIterations: number;
  reachedMaxIterations: boolean;
} {
  if (state.mode === "normal") {
    return {
      state,
      maxIterations: MAX_EXECUTE_RECOVERY_ITERATIONS,
      reachedMaxIterations: false,
    };
  }

  const phaseNoProgressCount = Math.max(
    0,
    Number.isFinite(state.phaseNoProgressCount)
      ? state.phaseNoProgressCount
      : state.iterationCount || 0,
  ) + 1;
  const nextState = {
    ...state,
    phaseNoProgressCount,
    iterationCount: phaseNoProgressCount,
  };
  return {
    state: nextState,
    maxIterations: MAX_EXECUTE_RECOVERY_ITERATIONS,
    reachedMaxIterations:
      // Phase attempts are debited immediately before a request. Allow counts
      // 1..MAX to issue, then pause when the would-be seventh request advances
      // to MAX+1. Protocol no-progress is recorded after results, so its
      // boundary remains inclusive.
      nextState.phaseNoProgressCount > MAX_EXECUTE_RECOVERY_ITERATIONS ||
      nextState.protocolNoProgressCount >= MAX_EXECUTE_RECOVERY_ITERATIONS,
  };
}

/**
 * Count a repeated semantic request even when its cache/policy outcome is
 * budget-neutral. Ranges and localized prose are intentionally absent from
 * the caller-provided fingerprint, so tiny window changes cannot refund the
 * transaction forever.
 */
export function registerExecuteRecoveryProtocolNoProgress(
  state: ExecuteRecoveryRuntimeState,
  fingerprint: string,
): ExecuteRecoveryRuntimeState {
  if (state.mode === "normal") return state;
  const normalized = String(fingerprint || "").trim();
  if (!normalized) return state;
  const repeated = normalized === state.protocolNoProgressFingerprint;
  return {
    ...state,
    protocolNoProgressFingerprint: normalized,
    protocolNoProgressCount: repeated ? state.protocolNoProgressCount + 1 : 1,
  };
}

export function isExecuteRecoveryPolicyDeferralFingerprint(
  fingerprint: string | null | undefined,
): boolean {
  const normalized = String(fingerprint || "").trim();
  if (!normalized) return false;
  if (normalized.includes(":policy:")) return true;
  try {
    const parsed = JSON.parse(normalized) as { kind?: unknown };
    return parsed?.kind === "approved_plan_scope_conflict";
  } catch {
    return false;
  }
}

/**
 * A policy-owned deferral may exhaust the semantic protocol counter without
 * consuming a real diagnostic attempt. Once this turn already has durable
 * evidence, release the narrow transaction for one normal iteration; approved
 * Plan scope and ordinary completion guards still constrain every real call.
 */
export function shouldReleaseExecuteRecoveryPolicyBoundary(input: {
  state: ExecuteRecoveryRuntimeState;
  hasDurableEvidence: boolean;
  maxIterations?: number;
}): boolean {
  const maxIterations = Math.max(
    1,
    Math.floor(Number(input.maxIterations) || MAX_EXECUTE_RECOVERY_ITERATIONS),
  );
  return input.state.mode !== "normal" &&
    input.hasDurableEvidence &&
    input.state.protocolNoProgressCount >= maxIterations &&
    input.state.phaseNoProgressCount < maxIterations &&
    isExecuteRecoveryPolicyDeferralFingerprint(
      input.state.protocolNoProgressFingerprint,
    );
}

export function buildExecuteRecoveryMaxIterationsPrompt(input: {
  language: string;
  maxIterations?: number;
}): string {
  const maxIterations = input.maxIterations ?? MAX_EXECUTE_RECOVERY_ITERATIONS;
  return input.language === "zh"
    ? `执行已暂停：当前恢复阶段连续 ${maxIterations} 次没有获得新证据。已有证据账本已保留，恢复事务已关闭；继续时请重新核对目标文件版本与范围，再恢复精确修改或验证，不要重复同一语义请求。`
    : `Execution paused: the current recovery phase produced no fresh evidence for ${maxIterations} consecutive attempts. The evidence ledger was preserved and the recovery transaction was closed; on resume, re-check the target version and range before continuing the exact mutation or validation without repeating the same semantic request.`;
}
