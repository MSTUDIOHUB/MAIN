import {
  isLegacyPostMutationReadLease,
  migrateRecoveryReadLease,
  normalizeRecoveryReadRange,
  normalizeExecuteRecoveryMode,
  readEvidenceSatisfiesRecoveryLease,
  resolveExecuteRecoveryActionContract,
  type ExecutionDecisionCheckpoint,
  type ExecuteRecoveryMode,
  type ForcedExecuteRecoveryRuntimeState,
  type RecoveryReadLease,
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
  | "validation_to_normal";

export interface ExecuteRecoveryObservation {
  expectedTarget?: string | null;
  freshReadTarget?: string | null;
  mutationTarget?: string | null;
  validationTarget?: string | null;
  validationToolName?: string | null;
  /** Present only for a fresh/replayed source observation, never a cache stub. */
  sourceObservationKey?: string | null;
  sourceRequestedRange?: RecoveryReadLease["requestedRange"];
  sourceObservedVersion?: string | null;
  sourceRangeWasRuntimeNarrowed?: boolean;
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
  return {
    ...checkpoint,
    ...(planTaskId ? { planTaskId } : {}),
    ...(requirementRef ? { requirementRef } : {}),
    ...(pendingFiniteValidation ? { pendingFiniteValidation } : {}),
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
    readLease?: RecoveryReadLease | null;
    sourceObservationKey?: string | null;
    decisionCheckpoint?: ExecutionDecisionCheckpoint | null;
  },
): ExecuteRecoveryRuntimeState {
  const requestedMode = normalizeExecuteRecoveryMode(input.mode) as Exclude<ExecuteRecoveryMode, "normal">;
  const expectedTarget = input.expectedTarget?.trim() || state.expectedTarget;
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
          state: resetExecuteRecoveryPhaseProgress({
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
          state: resetExecuteRecoveryPhaseProgress({
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
        state: resetExecuteRecoveryPhaseProgress({
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
        state: resetExecuteRecoveryPhaseProgress({
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
          state: resetExecuteRecoveryPhaseProgress({
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
    const nextState = resetExecuteRecoveryPhaseProgress({
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
    observation.mutationTarget
  ) {
    const mutationTarget = expectedTarget || observation.mutationTarget;
    if (!workspacePathsReferToSameFile(observation.mutationTarget, mutationTarget)) {
      return {
        state: transactionState,
        transition: "none",
        target: mutationTarget,
        consumedExpectedRead: false,
      };
    }
    return {
      state: resetExecuteRecoveryPhaseProgress({
        ...transactionState,
        mode: "validation_only",
        reason: "recovery_mutation_observed",
        expectedTarget: mutationTarget,
        // A successful mutation carries structured changed-path/diff evidence,
        // but it does not prove the whole user objective is implemented. Move
        // provisionally to validation; assistantCompletionPhase may reopen the
        // mutation surface once when the model explicitly requests more edits.
        readLease: null,
        decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
          expectedTarget: mutationTarget,
          sourceObservationKey: state.sourceObservationKey,
          nextRequiredCapability: "validation",
          previous: state.decisionCheckpoint,
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
      return {
        state: clearExecuteRecoveryRuntimeState(transactionState),
        transition: "validation_to_normal",
        // PTY readiness closes only the process-start obligation. If the Plan
        // also carries browser evidence, the task audit reactivates that
        // independent obligation after this transaction is cleared.
        target: expectedTarget || observation.validationTarget,
        consumedExpectedRead: false,
      };
    }
    const browserValidation = validationToolName === "browser_evaluate";
    if (
      nextCapability === "launch_long_process" ||
      nextCapability === "recover_process" ||
      nextCapability === "reconcile_server" ||
      nextCapability === "observe_pty" ||
      (nextCapability === "browser_validation" && !browserValidation)
    ) {
      return {
        state: transactionState,
        transition: "none",
        target: expectedTarget || observation.validationTarget,
        consumedExpectedRead: false,
      };
    }
    return {
      state: clearExecuteRecoveryRuntimeState(transactionState),
      transition: "validation_to_normal",
      // Validation is often a workspace command rather than a file-targeted
      // operation. Clear bookkeeping against the transaction file identity.
      target: expectedTarget || observation.validationTarget,
      consumedExpectedRead: false,
    };
  }

  return {
    state: transactionState,
    transition: "none",
    target: expectedTarget,
    consumedExpectedRead: false,
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

/**
 * Undo the iteration-start debit when the runtime itself deferred a call,
 * returned an unchanged cache stub, or only observed a still-running PTY.
 * These outcomes add no diagnostic failure and must not exhaust the six-step
 * no-progress budget merely because the model followed the requested gate.
 */
export function refundExecuteRecoveryRuntimeIteration(
  state: ExecuteRecoveryRuntimeState,
): ExecuteRecoveryRuntimeState {
  if (state.mode === "normal") return state;
  const phaseNoProgressCount = Math.max(
    0,
    (Number.isFinite(state.phaseNoProgressCount)
      ? state.phaseNoProgressCount
      : state.iterationCount || 0) - 1,
  );
  return {
    ...state,
    phaseNoProgressCount,
    iterationCount: phaseNoProgressCount,
  };
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
