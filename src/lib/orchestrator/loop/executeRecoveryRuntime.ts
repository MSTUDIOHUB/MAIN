import {
  isLegacyPostMutationReadLease,
  migrateRecoveryReadLease,
  normalizeRecoveryReadRange,
  normalizeExecutionDecisionCheckpointSnapshot,
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
import {
  directEditTransactionHasCurrentClosureEvidence,
  recordDirectEditMutation,
  recordDirectEditValidation,
  resolveDirectEditTransaction,
  setDirectEditTransactionPhase,
} from "../../directEditTransaction";

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
  | "objective_audit_to_edit_or_close"
  | "mutation_to_validation"
  | "validation_to_objective_audit"
  | "validation_to_normal";

export interface ExecuteRecoveryObservation {
  expectedTarget?: string | null;
  freshReadTarget?: string | null;
  mutationTarget?: string | null;
  /** Exact structured changed paths when one mutation updates multiple files. */
  mutationTargets?: string[];
  mutationToolName?: string | null;
  validationTarget?: string | null;
  validationToolName?: string | null;
  /** Bounded successful validation semantics retained for objective audit. */
  validationSummary?: string | null;
  /** Stable observation identity; an unchanged cache stub may replay it. */
  sourceObservationKey?: string | null;
  sourceRequestedRange?: RecoveryReadLease["requestedRange"];
  sourceObservedVersion?: string | null;
  sourceRangeWasRuntimeNarrowed?: boolean;
  /** Cache stubs may confirm unleased targeting, but never consume a read lease. */
  sourceObservationWasCacheStub?: boolean;
}

export interface PtyObservationPolicyDeferral {
  requestedUrl: string | null;
}

export interface JoinedSubagentMutationValidationRecovery {
  expectedTarget: string | null;
  decisionCheckpoint: ExecutionDecisionCheckpoint;
}

export interface ExecuteRecoverySourceWindowContinuation {
  target: string;
  sourceObservationKey: string;
  observedVersion: string;
  requestedRange: NonNullable<RecoveryReadLease["requestedRange"]>;
  readLease: RecoveryReadLease;
}

/**
 * Reopen a bounded source window when a required action stalls with only a
 * truncated observation. A quarantined read_file request may extend the
 * window, but it must not skip the still-unseen lines immediately after the
 * retained observation. Strategy-pivot budgets remain the outer bound, while
 * the synthetic continuation remains one-shot.
 */
export function resolveExecuteRecoverySourceWindowContinuation(input: {
  state: ExecuteRecoveryRuntimeState;
  protocolActualToolCalls?: Array<{
    name?: string | null;
    arguments?: string | null;
  }> | null;
  observations: Array<{
    key?: string | null;
    path?: string | null;
    versionToken?: string | null;
    source?: "fresh" | "stub" | "replay" | null;
    window?: {
      startLine: number;
      endLine: number;
      totalLines: number;
      truncated: boolean;
    } | null;
  }>;
}): ExecuteRecoverySourceWindowContinuation | null {
  const target = input.state.expectedTarget?.trim() || "";
  const sourceObservationKey = input.state.sourceObservationKey?.trim() || "";
  if (
    input.state.mode === "normal" ||
    !target ||
    !sourceObservationKey
  ) {
    return null;
  }
  const observation = [...input.observations].reverse().find((candidate) =>
    candidate.key === sourceObservationKey &&
    candidate.source !== "stub" &&
    workspacePathsReferToSameFile(candidate.path || "", target)
  );
  const window = observation?.window;
  const observedVersion = observation?.versionToken?.trim() || "";
  if (
    !window ||
    !observedVersion ||
    window.startLine < 1 ||
    window.endLine < window.startLine ||
    window.totalLines <= window.endLine
  ) {
    return null;
  }
  const requestedReadRange = [...(input.protocolActualToolCalls || [])]
    .reverse()
    .flatMap((call) => {
      if (call.name !== "read_file") return [];
      try {
        const parsed = JSON.parse(call.arguments || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
        const args = parsed as Record<string, unknown>;
        if (!workspacePathsReferToSameFile(String(args.path || ""), target)) return [];
        const range = normalizeRecoveryReadRange(args);
        return range?.startLine && (range.endLine || range.maxLines) ? [range] : [];
      } catch {
        return [];
      }
    })[0] || null;
  if (
    !requestedReadRange &&
    input.state.readLease?.purpose === "missing_window"
  ) {
    return null;
  }
  const coveredWindows = input.observations
    .filter((candidate) =>
      candidate.source !== "stub" &&
      candidate.versionToken === observedVersion &&
      workspacePathsReferToSameFile(candidate.path || "", target) &&
      candidate.window
    )
    .map((candidate) => candidate.window!)
    .sort((left, right) => left.startLine - right.startLine);
  const adjacentStartLine = window.endLine + 1;
  let startLine = requestedReadRange?.startLine
    ? Math.min(requestedReadRange.startLine, adjacentStartLine)
    : adjacentStartLine;
  let endLine = requestedReadRange
    ? requestedReadRange.endLine ?? (
        requestedReadRange.startLine! +
        Math.max(1, requestedReadRange.maxLines || 1) -
        1
      )
    : startLine + Math.max(1, window.endLine - window.startLine + 1) - 1;
  startLine = Math.min(Math.max(1, startLine), window.totalLines);
  endLine = Math.min(Math.max(startLine, endLine), window.totalLines);
  for (const covered of coveredWindows) {
    if (covered.endLine < startLine) continue;
    if (covered.startLine > startLine) {
      endLine = Math.min(endLine, covered.startLine - 1);
      break;
    }
    startLine = covered.endLine + 1;
    if (startLine > endLine || startLine > window.totalLines) return null;
  }
  const requestedRange = {
    startLine,
    endLine,
    maxLines: endLine - startLine + 1,
  };
  const observationKeys = Array.from(new Set([
    ...(input.state.readLease?.observationKeys || []),
    sourceObservationKey,
  ]));
  return {
    target,
    sourceObservationKey,
    observedVersion,
    requestedRange,
    readLease: {
      purpose: "missing_window",
      target,
      requestedRange,
      observationKey: sourceObservationKey,
      observationKeys,
      observedVersion,
      state: "available",
    },
  };
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

function buildObjectiveMutationCheckpoint(input: {
  checkpoint: ExecutionDecisionCheckpoint | null;
  expectedTarget: string | null;
  evidenceTargets: string[];
}): ExecutionDecisionCheckpoint {
  const checkpoint = input.checkpoint;
  return {
    ...(checkpoint || {
      expectedTarget: input.expectedTarget,
      sourceObservationKey: null,
      nextRequiredCapability: "validation" as const,
    }),
    directEditTransaction: recordDirectEditMutation({
      transaction: resolveDirectEditTransaction(checkpoint),
      expectedTargets: input.expectedTarget ? [input.expectedTarget] : [],
      mutationTargets: input.evidenceTargets,
      requirementRef: checkpoint?.requirementRef,
      planTaskId: checkpoint?.planTaskId,
    }),
  };
}

/**
 * Rebase a parent recovery transaction after a joined child produced real
 * workspace mutation evidence.
 *
 * A child closure may still be blocked or unverified; that must not be
 * mistaken for task completion. The changed paths are nevertheless trusted
 * workspace facts after adoption, so the parent must validate them instead of
 * continuing the pre-join targeting/no-tool contract.
 */
export function resolveJoinedSubagentMutationValidationRecovery(input: {
  state: ExecuteRecoveryRuntimeState;
  mutationTargets: readonly string[];
}): JoinedSubagentMutationValidationRecovery | null {
  const mutationTargets = input.mutationTargets.reduce<string[]>((targets, value) => {
    const target = String(value || "").trim().replace(/\\/g, "/");
    if (
      !target ||
      targets.some((entry) => workspacePathsReferToSameFile(entry, target))
    ) {
      return targets;
    }
    return [...targets, target];
  }, []);
  if (mutationTargets.length === 0) return null;

  const previous = input.state.decisionCheckpoint;
  const retainedExpectedTarget =
    input.state.expectedTarget?.trim() ||
    previous?.expectedTarget?.trim() ||
    null;
  const expectedTarget = retainedExpectedTarget || (
    mutationTargets.length === 1 ? mutationTargets[0] : null
  );
  const decisionCheckpoint: ExecutionDecisionCheckpoint = {
    ...(previous || {
      expectedTarget,
      sourceObservationKey: null,
      nextRequiredCapability: "validation" as const,
    }),
    expectedTarget,
    // A child write invalidates any parent source snapshot for the adopted
    // path. Validation owns the next step; a later diagnostic may reopen a
    // fresh, explicitly leased read.
    sourceObservationKey: null,
    nextRequiredCapability: "validation",
    directEditTransaction: recordDirectEditMutation({
      transaction: resolveDirectEditTransaction(previous),
      expectedTargets: [
        ...(retainedExpectedTarget ? [retainedExpectedTarget] : []),
        ...mutationTargets,
      ],
      mutationTargets,
      requirementRef: previous?.requirementRef,
      planTaskId: previous?.planTaskId,
    }),
  };
  return { expectedTarget, decisionCheckpoint };
}

function buildExecuteRecoveryDecisionCheckpoint(input: {
  expectedTarget: string | null;
  sourceObservationKey: string | null;
  nextRequiredCapability: ExecutionDecisionCheckpoint["nextRequiredCapability"];
  previous: ExecutionDecisionCheckpoint | null;
  evidenceVersion?: string | null;
}): ExecutionDecisionCheckpoint | null {
  if (!input.expectedTarget && !input.previous) return null;
  const transactionPhase =
    input.nextRequiredCapability === "targeting" ||
    input.nextRequiredCapability === "targeted_read" ||
    input.nextRequiredCapability === "browser_diagnostic"
      ? "inspect"
      : input.nextRequiredCapability === "mutation"
        ? "mutate"
        : input.nextRequiredCapability === "any"
          ? null
          : "validate";
  const directEditTransaction = transactionPhase
    ? setDirectEditTransactionPhase(
        resolveDirectEditTransaction(input.previous),
        transactionPhase,
      )
    : resolveDirectEditTransaction(input.previous);
  return {
    // The checkpoint is the transaction state, not a per-phase projection.
    // Carry it forward as a whole so adding a new owned field cannot silently
    // erase it at the next context -> mutation -> validation transition.
    ...(input.previous || {}),
    expectedTarget: input.expectedTarget,
    sourceObservationKey: input.sourceObservationKey,
    nextRequiredCapability: input.nextRequiredCapability,
    ...(input.evidenceVersion === undefined
      ? {}
      : {
          evidenceVersion:
            String(input.evidenceVersion || "").trim() || null,
        }),
    ...(directEditTransaction ? { directEditTransaction } : {}),
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
  const directEditTransaction =
    resolveDirectEditTransaction(checkpoint) ||
    resolveDirectEditTransaction(previous);
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
    // Unknown-to-this-function checkpoint fields still belong to the active
    // transaction. Merge the prior snapshot before applying the explicit
    // activation so future fields cannot be lost to another manual whitelist.
    ...(previous || {}),
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
    ...(directEditTransaction ? { directEditTransaction } : {}),
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
  const restoredDecisionCheckpoint =
    normalizeExecutionDecisionCheckpointSnapshot(
      input.forcedState?.decisionCheckpoint,
    );
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
            previous: restoredDecisionCheckpoint,
          })
        : restoredDecisionCheckpoint,
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
        normalizeExecutionDecisionCheckpointSnapshot(input.decisionCheckpoint),
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
  const targetChanged = Boolean(expectedTarget || state.expectedTarget) && (
    !expectedTarget ||
    !state.expectedTarget ||
    !workspacePathsReferToSameFile(expectedTarget, state.expectedTarget)
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
  validationSummary?: string | null,
): {
  state: ExecuteRecoveryRuntimeState;
  transition: ExecuteRecoveryPhaseTransition;
  target: string | null;
  consumedExpectedRead: false;
} {
  const checkpoint = state.decisionCheckpoint;
  const target = state.expectedTarget || validationTarget;
  const directEditTransaction = resolveDirectEditTransaction(checkpoint);
  if (!checkpoint || !directEditTransaction) {
    return {
      state: clearExecuteRecoveryRuntimeState(state),
      transition: "validation_to_normal",
      target,
      consumedExpectedRead: false,
    };
  }

  const validated = recordDirectEditValidation({
    transaction: directEditTransaction,
    tool: validationToolName || "validation",
    target: validationTarget,
    summary: validationSummary,
    fallbackTarget: state.expectedTarget,
  });
  const verifiedCheckpoint: ExecutionDecisionCheckpoint = {
    ...checkpoint,
    // The exact command has now succeeded. Keep the command as the reusable
    // acceptance boundary for any audit correction, but retire the failure
    // diagnosis so it cannot masquerade as an unresolved defect.
    finiteValidationFailureDetail: null,
    finiteValidationDiagnosticTargets: [],
    directEditTransaction: validated.transaction,
  };

  if (!validated.coverage.covered) {
    const missingTarget =
      validated.coverage.missingTargets[0] || state.expectedTarget;
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
          directEditTransaction: setDirectEditTransactionPhase(
            verifiedCheckpoint.directEditTransaction,
            readLease ? "inspect" : "mutate",
          ),
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

  if (validated.coverage.kind === "root") {
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
      observation.validationSummary,
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
    const targetingObservation = Boolean(
      !currentVersionLease &&
      contract.nextRequiredCapability === "targeting" &&
      observation.sourceObservationKey?.trim(),
    );
    const leaseMatchesEvidence = targetingObservation || (
      Boolean(currentVersionLease) &&
      readEvidenceSatisfiesRecoveryLease({
        lease: currentVersionLease,
        target: observation.freshReadTarget,
        requestedRange: observation.sourceRequestedRange,
        observedVersion: observation.sourceObservedVersion,
      })
    );
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
        readLease: activeReadLease &&
          contextTarget &&
          workspacePathsReferToSameFile(activeReadLease.target, contextTarget)
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
    const activeReadLease = contract.readLease &&
      (contract.readLease.state === "available" || contract.readLease.state === "active")
        ? contract.readLease
        : null;
    if (!activeReadLease && state.mode !== "objective_audit") {
      // Mutation and validation surfaces never authorize an adjacent read.
      // A stale provider call or restored legacy request therefore cannot
      // refresh source identity, reset the phase budget, or reopen the loop.
      return {
        state: transactionState,
        transition: "none",
        target: expectedTarget,
        consumedExpectedRead: false,
      };
    }
    // Objective audit is the only broad surface allowed to observe a fresh
    // unleased source. Narrow recovery phases reopen reads through context /
    // targeting contracts instead of treating an adjacent read as progress.
    const shouldBindFreshReadTarget = Boolean(
      expectedTarget ||
      activeReadLease ||
      state.mode === "objective_audit",
    );
    const contextTarget = objectiveAuditTargetSwitch
      ? observation.freshReadTarget
      : expectedTarget || (shouldBindFreshReadTarget ? observation.freshReadTarget : null);
    if (
      state.mode !== "objective_audit" &&
      contextTarget &&
      !workspacePathsReferToSameFile(observation.freshReadTarget, contextTarget)
    ) {
      return {
        state: transactionState,
        transition: "none",
        target: contextTarget,
        consumedExpectedRead: false,
      };
    }
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
    const boundSourceObservationKey = contextTarget ? sourceObservationKey : null;
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
    const auditTransaction = resolveDirectEditTransaction(
      transactionState.decisionCheckpoint,
    );
    const repeatsCurrentValidatedAuditTarget = Boolean(
      state.mode === "objective_audit" &&
      contextTarget &&
      expectedTarget &&
      workspacePathsReferToSameFile(contextTarget, expectedTarget) &&
      directEditTransactionHasCurrentClosureEvidence(
        auditTransaction,
        expectedTarget,
      ) &&
      [
        ...(auditTransaction?.expectedTargets || []),
        ...(auditTransaction?.mutations.map((entry) => entry.target) || []),
      ].some((target) =>
        workspacePathsReferToSameFile(contextTarget, target)
      )
    );
    if (repeatsCurrentValidatedAuditTarget) {
      // Reading the just-validated owner is the audit's evidence-gathering
      // step. Keep closure optional, but expose one exact correction primitive
      // on the next request. Previously this branch returned `none`, leaving
      // the model permanently on a read-only surface even after it found a
      // concrete remaining defect.
      const correctionCheckpoint = buildExecuteRecoveryDecisionCheckpoint({
        expectedTarget: contextTarget,
        sourceObservationKey: boundSourceObservationKey,
        nextRequiredCapability: "mutation",
        previous: state.decisionCheckpoint,
        evidenceVersion: observedVersion || previousVersion,
      });
      const correctionTransaction = setDirectEditTransactionPhase(
        resolveDirectEditTransaction(correctionCheckpoint),
        "audit",
      );
      const reviewedState = resetExecuteRecoveryPhaseProgress({
        ...transactionState,
        reason: "objective_audit_source_reviewed",
        expectedTarget: contextTarget,
        sourceObservationKey: boundSourceObservationKey,
        readLease: null,
        // `nextRequiredCapability` opens the optional correction surface, while
        // the transaction itself stays audited. A no-tool response can therefore
        // accept the already validated revision; an actual edit records a new
        // revision and returns to validation.
        decisionCheckpoint: correctionCheckpoint && correctionTransaction
          ? {
              ...correctionCheckpoint,
              directEditTransaction: correctionTransaction,
            }
          : correctionCheckpoint,
      });
      return {
        state: reviewedState,
        transition: "objective_audit_to_edit_or_close",
        target: contextTarget,
        consumedExpectedRead: true,
      };
    }
    if (state.mode === "objective_audit" && contextTarget) {
      const reopenedState = resetExecuteRecoveryPhaseProgress({
        ...transactionState,
        mode: "mutation_first",
        reason: "objective_audit_source_reopened",
        expectedTarget: contextTarget,
        sourceObservationKey: boundSourceObservationKey,
        readLease: null,
        decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
          expectedTarget: contextTarget,
          sourceObservationKey: boundSourceObservationKey,
          nextRequiredCapability: "mutation",
          previous: state.decisionCheckpoint,
          evidenceVersion: observedVersion || previousVersion,
        }),
      });
      return {
        state: reopenedState,
        transition: "context_to_mutation",
        target: contextTarget,
        consumedExpectedRead: true,
      };
    }
    const refreshedState: ExecuteRecoveryRuntimeState = {
        ...transactionState,
        expectedTarget: contextTarget,
        reason: activeReadLease
          ? transactionState.reason
          : "recovery_source_observation_refreshed",
        sourceObservationKey: boundSourceObservationKey,
        readLease: activeReadLease &&
          contextTarget &&
          workspacePathsReferToSameFile(activeReadLease.target, contextTarget)
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
          sourceObservationKey: boundSourceObservationKey,
          nextRequiredCapability: contract.nextRequiredCapability,
          previous: state.decisionCheckpoint,
          evidenceVersion: observedVersion || previousVersion,
        }),
      };
    // A leased source read or an objective-audit target switch satisfies a
    // concrete runtime obligation.
    const committedState = activeReadLease || contextTarget
      ? resetExecuteRecoveryPhaseProgress(refreshedState)
      : refreshedState;
    return {
      state: committedState,
      transition: "context_refreshed",
      target: contextTarget,
      consumedExpectedRead: Boolean(activeReadLease),
    };
  }

  if (
    contract.phase !== "context" &&
    (observation.mutationTarget || observation.mutationTargets?.length)
  ) {
    if (contract.nextRequiredCapability !== "mutation") {
      // A stale adjacent mutation cannot bypass the active validation or
      // objective-audit boundary. A fresh source read must explicitly reopen
      // mutation before a write result can advance this transaction.
      return {
        state: transactionState,
        transition: "none",
        target: expectedTarget,
        consumedExpectedRead: false,
      };
    }
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
    const anchoredTargetCorrection = Boolean(
      expectedTarget &&
      !state.readLease &&
      observedMutationTargets.length === 1 &&
      ["replace_in_file", "apply_patch"].includes(
        String(observation.mutationToolName || ""),
      ) &&
      !observedMutationTargets.some((target) =>
        workspacePathsReferToSameFile(target, expectedTarget)
      ),
    );
    const auditTargetSwitch = state.mode === "objective_audit" &&
      observedMutationTargets.length > 0 &&
      Boolean(
        expectedTarget &&
        !observedMutationTargets.some((target) =>
          workspacePathsReferToSameFile(target, expectedTarget)
        ),
      );
    const mutationTarget = auditTargetSwitch || anchoredTargetCorrection
      ? observedMutationTargets[0] || null
      : expectedTarget || observedMutationTargets[0] || null;
    if (
      !mutationTarget ||
      (
        state.mode !== "objective_audit" &&
        !anchoredTargetCorrection &&
        expectedTarget &&
        !observedMutationTargets.some((target) =>
          workspacePathsReferToSameFile(target, expectedTarget)
        )
      )
    ) {
      return {
        state: transactionState,
        transition: "none",
        target: mutationTarget,
        consumedExpectedRead: false,
      };
    }
    const evidenceTargets = observedMutationTargets.map((target) =>
      !auditTargetSwitch &&
      !anchoredTargetCorrection &&
      expectedTarget &&
      workspacePathsReferToSameFile(target, expectedTarget)
        ? expectedTarget
        : target
    );
    // A failed finite validation without a uniquely attributed diagnostic is
    // a workspace-scoped repair. The first successful edit is evidence for
    // that repair, not proof that this file is its sole owner. Validation runs
    // after each bounded repair; another structured failure may open a new
    // targeting transaction for a sibling owner.
    const workspaceScopedFiniteRepair = Boolean(
      state.decisionCheckpoint?.pendingFiniteValidation &&
      !expectedTarget &&
      !state.decisionCheckpoint.expectedTarget
    );
    const nextExpectedTarget = workspaceScopedFiniteRepair
      ? null
      : auditTargetSwitch
      ? observedMutationTargets.length === 1
        ? observedMutationTargets[0]
        : null
      : anchoredTargetCorrection
      ? observedMutationTargets[0]
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
        reason: workspaceScopedFiniteRepair
          ? "workspace_repair_mutation_observed"
          : "recovery_mutation_observed",
        expectedTarget: nextExpectedTarget,
        // A successful mutation carries structured changed-path/diff evidence,
        // but it does not prove the whole user objective is implemented. Move
        // provisionally to validation; assistantCompletionPhase may reopen the
        // mutation surface for a distinct structured objective/target request.
        readLease: null,
        sourceObservationKey: anchoredTargetCorrection
          ? null
          : transactionState.sourceObservationKey,
        decisionCheckpoint: buildExecuteRecoveryDecisionCheckpoint({
          expectedTarget: nextExpectedTarget,
          sourceObservationKey: anchoredTargetCorrection
            ? null
            : state.sourceObservationKey,
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
        observation.validationSummary,
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
      observation.validationSummary,
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
  // A bounded targeting phase that reaches its no-progress boundary has
  // already spent its opportunity to identify more context. Leaving it on the
  // same grep/read-only surface makes both strategy pivots wording-only and
  // can strand an Execute turn forever even when the parent already consumed
  // child/source evidence. Release that surface to the ordinary mutation
  // primitives; mutation preflight still validates the concrete target chosen
  // by the model.
  const closeStalledTargeting =
    previousCheckpoint?.nextRequiredCapability === "targeting";
  const closeContextSurface = closeRepeatedRead || closeStalledTargeting;
  const nextCapability = closeContextSurface
    ? "mutation" as const
    : previousCheckpoint?.nextRequiredCapability || "mutation";
  const nextMode = closeContextSurface ? "mutation_first" as const : input.state.mode;
  const contractBoundaryChanged = closeContextSurface ||
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
      readLease:
        closeContextSurface ? null : input.state.readLease,
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
    ? `当前恢复阶段连续 ${maxIterations} 次没有获得新证据。已有证据账本和恢复事务已冻结；MAIN 将在全局续跑预算内重新核对目标版本与范围，再继续精确修改或验证，不会原样重复同一语义请求。`
    : `The current recovery phase produced no fresh evidence for ${maxIterations} consecutive attempts. The evidence ledger and recovery transaction were frozen; within the global continuation budget, MAIN will re-check the target version and range before continuing the exact mutation or validation without replaying the same semantic request.`;
}
