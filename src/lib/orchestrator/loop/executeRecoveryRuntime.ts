import {
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
  consecutiveBlockedReadFileCount: number;
  repeatedEditValidationAttempts: number;
}

export type ExecuteRecoveryPhaseTransition =
  | "none"
  | "context_refreshed"
  | "context_version_changed_to_targeting"
  | "validation_progress"
  | "context_to_mutation"
  | "mutation_to_validation"
  | "post_mutation_check_to_validation"
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
}): ExecutionDecisionCheckpoint | null {
  if (!input.expectedTarget && !input.previous) return null;
  return {
    expectedTarget: input.expectedTarget,
    sourceObservationKey: input.sourceObservationKey,
    nextRequiredCapability: input.nextRequiredCapability,
    ...(input.previous?.evidenceVersion
      ? { evidenceVersion: input.previous.evidenceVersion }
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
  const mode = recoveryEligible
    ? normalizeExecuteRecoveryMode(input.forcedState?.mode ?? input.forcedMode)
    : "normal";
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
      : input.forcedState?.expectedTarget?.trim() || null,
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
    readLease: mode === "normal" ? null : input.forcedState?.readLease || null,
    sourceObservationKey: mode === "normal"
      ? null
      : input.forcedState?.sourceObservationKey?.trim() || null,
    decisionCheckpoint: mode === "normal"
      ? null
      : input.forcedState?.decisionCheckpoint || null,
    consecutiveBlockedReadFileCount: 0,
    repeatedEditValidationAttempts: 0,
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
  const nextMode = normalizeExecuteRecoveryMode(input.mode) as Exclude<ExecuteRecoveryMode, "normal">;
  const expectedTarget = input.expectedTarget?.trim() || state.expectedTarget;
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
    readLease: input.readLease === undefined ? state.readLease : input.readLease,
    sourceObservationKey: input.sourceObservationKey === undefined
      ? state.sourceObservationKey
      : input.sourceObservationKey,
    decisionCheckpoint: input.decisionCheckpoint === undefined
      ? state.decisionCheckpoint
      : input.decisionCheckpoint,
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
    readLease: input.readLease === undefined ? state.readLease : input.readLease,
    sourceObservationKey: input.sourceObservationKey === undefined
      ? state.sourceObservationKey
      : input.sourceObservationKey?.trim() || null,
    decisionCheckpoint: input.decisionCheckpoint === undefined
      ? buildExecuteRecoveryDecisionCheckpoint({
          expectedTarget,
          sourceObservationKey: input.sourceObservationKey === undefined
            ? state.sourceObservationKey
            : input.sourceObservationKey?.trim() || null,
          nextRequiredCapability: nextContract.nextRequiredCapability,
          previous: state.decisionCheckpoint,
        })
      : input.decisionCheckpoint,
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
    const activeReadLease = state.readLease &&
      (state.readLease.state === "available" || state.readLease.state === "active")
        ? state.readLease
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
              state: "available",
            },
            decisionCheckpoint: {
              expectedTarget: contextTarget,
              sourceObservationKey,
              nextRequiredCapability: "targeted_read",
              evidenceVersion: observedVersion,
            },
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
              state: "available",
            },
            decisionCheckpoint: {
              expectedTarget: contextTarget,
              sourceObservationKey,
              nextRequiredCapability: "targeted_read",
              evidenceVersion: observedVersion || expectedVersion || null,
            },
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
          decisionCheckpoint: {
            expectedTarget: contextTarget,
            sourceObservationKey,
            nextRequiredCapability: "targeting",
            evidenceVersion: observedVersion,
          },
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
            decisionCheckpoint: {
              expectedTarget: contextTarget,
              sourceObservationKey,
              nextRequiredCapability: "targeted_read",
              evidenceVersion: observedVersion,
            },
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
        readLease: state.readLease && workspacePathsReferToSameFile(state.readLease.target, contextTarget)
          ? {
              ...state.readLease,
              state: "consumed",
              observationKey: sourceObservationKey,
              requestedRange: observation.sourceRequestedRange || state.readLease.requestedRange,
              observedVersion: observation.sourceObservedVersion || state.readLease.observedVersion,
            }
          : state.readLease,
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
    const activeReadLease = state.readLease &&
      (state.readLease.state === "available" || state.readLease.state === "active")
        ? state.readLease
        : null;
    const leaseMatchesEvidence = Boolean(activeReadLease) && readEvidenceSatisfiesRecoveryLease({
      lease: activeReadLease,
      target: observation.freshReadTarget,
      requestedRange: observation.sourceRequestedRange,
      observedVersion: observation.sourceObservedVersion,
    });
    if (!leaseMatchesEvidence) {
      return {
        state: transactionState,
        transition: "none",
        target: contextTarget,
        consumedExpectedRead: false,
      };
    }
    const sourceObservationKey = observation.sourceObservationKey?.trim() || state.sourceObservationKey;
    const completesPostMutationCheck = contract.phase === "post_mutation_check";
    return {
      state: resetExecuteRecoveryPhaseProgress({
        ...transactionState,
        expectedTarget: contextTarget,
        reason: completesPostMutationCheck
          ? "recovery_post_mutation_context_observed"
          : transactionState.reason,
        sourceObservationKey,
        readLease: state.readLease && workspacePathsReferToSameFile(state.readLease.target, contextTarget)
          ? {
              ...state.readLease,
              state: "consumed",
              observationKey: sourceObservationKey,
              requestedRange: observation.sourceRequestedRange || state.readLease.requestedRange,
              observedVersion: observation.sourceObservedVersion || state.readLease.observedVersion,
            }
          : state.readLease,
        decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
          expectedTarget: contextTarget,
          sourceObservationKey,
          nextRequiredCapability: completesPostMutationCheck
            ? "validation"
            : contract.nextRequiredCapability,
          previous: state.decisionCheckpoint,
        }),
      }),
      transition: completesPostMutationCheck
        ? "post_mutation_check_to_validation"
        : "context_refreshed",
      target: contextTarget,
      consumedExpectedRead: true,
    };
  }

  if (
    (contract.phase === "mutation" || contract.nextRequiredCapability === "recover_process") &&
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
        readLease: {
          purpose: "post_mutation_verify",
          target: mutationTarget,
          state: "available",
        },
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
    (state.mode === "action_plus_targeting" || state.mode === "validation_only") &&
    observation.validationTarget
  ) {
    const validationToolName = observation.validationToolName?.trim() || "";
    const ptyObservation = [
      "read_pty_buffer",
      "read_pty_tail",
      "read_pty_since",
      "get_pty_status",
    ].includes(validationToolName);
    const healthyServerReconciliation =
      validationToolName === "run_command" &&
      isLocalDevServerHealthProbeCommand(observation.validationTarget);
    if (ptyObservation || healthyServerReconciliation) {
      return {
        state: resetExecuteRecoveryPhaseProgress({
          ...transactionState,
          reason: healthyServerReconciliation
            ? "recovery_existing_server_reconciled"
            : "recovery_pty_observation_observed",
          decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
            expectedTarget,
            sourceObservationKey: state.sourceObservationKey,
            nextRequiredCapability: "browser_validation",
            previous: state.decisionCheckpoint,
          }),
        }),
        transition: "validation_progress",
        target: expectedTarget || observation.validationTarget,
        consumedExpectedRead: false,
      };
    }
    if (state.mode === "action_plus_targeting") {
      return {
        state: clearExecuteRecoveryRuntimeState(transactionState),
        transition: "validation_to_normal",
        target: expectedTarget || observation.validationTarget,
        consumedExpectedRead: false,
      };
    }
    // validation_only falls through to the generic finite/browser validation
    // close below. The special PTY branch above ensures readiness advances the
    // same transaction instead of being mistaken for final acceptance.
  }

  if (
    contract.phase === "validation" &&
    observation.validationTarget
  ) {
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

export function applyCrossIterationReadFileRecoveryState(
  state: ExecuteRecoveryRuntimeState,
  input: {
    mode: ExecuteRecoveryMode;
    reason: string;
    consecutiveBlockedReadFileCount: number;
  },
): ExecuteRecoveryRuntimeState {
  const nextMode = normalizeExecuteRecoveryMode(input.mode);
  const previousPhase = resolveExecuteRecoveryActionContract(state.mode).phase;
  const nextPhase = resolveExecuteRecoveryActionContract(nextMode).phase;
  const nextState: ExecuteRecoveryRuntimeState = {
    ...state,
    mode: nextMode,
    reason: input.reason,
    expectedTarget: nextMode === "normal" ? null : state.expectedTarget,
    readLease: nextMode === "normal" ? null : state.readLease,
    sourceObservationKey: nextMode === "normal" ? null : state.sourceObservationKey,
    decisionCheckpoint: nextMode === "normal" ? null : state.decisionCheckpoint,
    consecutiveBlockedReadFileCount: input.consecutiveBlockedReadFileCount,
  };
  return previousPhase !== nextPhase
    ? resetExecuteRecoveryPhaseProgress(nextState)
    : nextState;
}

export function setRepeatedEditValidationRecoveryAttempts(
  state: ExecuteRecoveryRuntimeState,
  repeatedEditValidationAttempts: number,
): ExecuteRecoveryRuntimeState {
  return {
    ...state,
    repeatedEditValidationAttempts,
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
