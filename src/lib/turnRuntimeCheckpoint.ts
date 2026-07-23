import type { PlanToolActivitySummary } from "./planExecutionRecovery";
import {
  normalizeTurnInputContextSignals,
  type TurnInputContextSignals,
} from "./turnIntake";
import {
  resolveMonotonicVisualContextStatus,
  type VisualContextDeliveryState,
  type VisualContextDeliveryStatus,
} from "./visualContext";
import {
  isPreferredDelegationEvidenceTargetWithinScope,
  normalizePreferredDelegationScopeContract,
  reconcilePreferredDelegationScopeContractAfterRestart,
  type PreferredDelegationScopeContract,
} from "./preferredDelegationScopes";
import {
  normalizeSubagentClosureReceiptLedger,
  resolveSubagentClosureReceiptReferences,
  type SubagentClosureReceiptLedger,
} from "./subagentClosureReceipts";
import {
  TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
  createCanonicalTurnRuntime,
  planCanonicalTurnCancellation,
  projectCanonicalRunTransaction,
  projectTurnRuntimeCompatibility,
  reduceCanonicalTurnRuntime,
  type CanonicalPlanArtifact,
  type CanonicalRunTransactionOutcome,
  type CanonicalRunTransactionProjection,
  type CanonicalRunIdentity,
  type CanonicalTurnIdentity,
  type CanonicalTurnRuntimeEvent,
  type CanonicalTurnRuntimeState,
  type TurnRuntimeCompatibilityProjection,
  type TurnCompletionResultKind,
  type TurnRunPauseKind,
  type TurnRunPhase,
  type TurnRunResumeResolution,
  type TurnStrategy,
} from "./turnRuntimeContract";

export const TURN_RUNTIME_CHECKPOINT_SCHEMA_VERSION =
  "turn-runtime-checkpoint.v1" as const;
export const MAX_DURABLE_TURN_RUNTIME_CHECKPOINTS = 32;
export const MAX_DURABLE_TURN_CLOSURE_RECEIPT_REFS = 48;
export const MAX_DURABLE_TURN_RUNTIME_EVENTS = 512;

const MAX_DURABLE_TURN_RUNTIME_CHECKPOINT_CHARS = 1_048_576;
const MAX_DURABLE_TURN_RUNTIME_STRING_CHARS = 8_192;
const MAX_DURABLE_TURN_INPUT_PATHS = 48;
const MAX_DURABLE_TURN_INPUT_IMAGE_PARTS = 128;

export interface TurnRuntimeCheckpointOwner {
  workspaceKey: string;
  sessionKey: string;
  sessionEpoch: string;
  clientSubmissionId: string;
  turnId: string;
}

export interface TurnRuntimePlanningCheckpoint {
  preferredDelegationScopeContract: PreferredDelegationScopeContract | null;
  /**
   * References only. Canonical adopted evidence lives in the independent
   * Session receipt ledger and is never self-certified by this checkpoint.
   */
  closureReceiptRefs: string[];
}

/**
 * Immutable user-payload facts captured when the durable Turn is first
 * admitted, plus the monotonic visual-delivery/observation state produced by
 * runtime receipts. Raw image bytes deliberately never enter this checkpoint.
 */
export interface TurnRuntimeInputCheckpoint {
  admittedUserContext: TurnInputContextSignals;
  visualContext: VisualContextDeliveryState;
}

export interface TurnRuntimeCheckpointV1 {
  schemaVersion: typeof TURN_RUNTIME_CHECKPOINT_SCHEMA_VERSION;
  revision: number;
  owner: TurnRuntimeCheckpointOwner;
  canonical: CanonicalTurnRuntimeState;
  input: TurnRuntimeInputCheckpoint;
  planning: TurnRuntimePlanningCheckpoint;
  updatedAt: number;
}

export type TurnRuntimeCheckpointMap = Record<string, TurnRuntimeCheckpointV1>;

export interface TurnRuntimeCheckpointExpectedOwner {
  workspaceKey?: string | null;
  sessionKey?: string | null;
  sessionEpoch?: string | null;
  turnId?: string | null;
}

const TURN_STRATEGIES = new Set<TurnStrategy>(["chat", "plan", "execute", "goal"]);
const RUN_PHASES = new Set<TurnRunPhase>([
  "admitted",
  "preparing",
  "investigating",
  "planning",
  "executing",
  "validating",
  "reviewing",
  "finalizing",
  "completed",
]);
const PAUSE_KINDS = new Set<TurnRunPauseKind>([
  "review",
  "approval",
  "input",
  "recoverable",
]);
const RESUME_RESOLUTIONS = new Set<TurnRunResumeResolution>([
  "review_completed",
  "approval_granted",
  "input_supplied",
  "recovery",
]);
const RESULT_KINDS = new Set<TurnCompletionResultKind>([
  "success",
  "partial",
  "blocked",
  "error",
  "canceled",
]);

function requiredString(value: unknown): string | null {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_DURABLE_TURN_RUNTIME_STRING_CHARS &&
      value === value.trim()
    ? value
    : null;
}

function normalizeDurableTurnInputPaths(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const path = requiredString(candidate);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= MAX_DURABLE_TURN_INPUT_PATHS) break;
  }
  return paths;
}

function normalizeDurableTurnInputContextSignals(
  value: unknown,
): TurnInputContextSignals | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const imageParts = Math.floor(Number(record.imageParts));
  if (
    !Number.isSafeInteger(imageParts) ||
    imageParts < 0 ||
    imageParts > MAX_DURABLE_TURN_INPUT_IMAGE_PARTS
  ) return null;
  const mentionedFilePaths = normalizeDurableTurnInputPaths(record.mentionedFilePaths);
  const attachedFilePaths = normalizeDurableTurnInputPaths(record.attachedFilePaths);
  if (!mentionedFilePaths || !attachedFilePaths) return null;
  return normalizeTurnInputContextSignals({
    imageParts,
    mentionedFilePaths,
    attachedFilePaths,
    subagentPreference: record.subagentPreference as TurnInputContextSignals["subagentPreference"],
    diagnosisRequirement: record.diagnosisRequirement as TurnInputContextSignals["diagnosisRequirement"],
  });
}

const VISUAL_CONTEXT_DELIVERY_STATUSES = new Set<VisualContextDeliveryStatus>([
  "none",
  "queued",
  "delivered",
  "partially_delivered",
  "provider_unsupported",
  "not_delivered",
]);

function createInitialVisualContextState(
  admittedUserContext: TurnInputContextSignals,
): VisualContextDeliveryState {
  const expectedImageParts = admittedUserContext.imageParts;
  return {
    status: expectedImageParts > 0 ? "queued" : "none",
    expectedImageParts,
    deliveredImageParts: 0,
    omittedImageParts: 0,
    recognition: expectedImageParts > 0 ? "pending" : "unverified",
  };
}

function normalizeDurableVisualContextState(
  value: unknown,
  admittedUserContext: TurnInputContextSignals,
): VisualContextDeliveryState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = String(record.status || "") as VisualContextDeliveryStatus;
  if (!VISUAL_CONTEXT_DELIVERY_STATUSES.has(status)) return null;
  const expectedImageParts = Math.floor(Number(record.expectedImageParts));
  const deliveredImageParts = Math.floor(Number(record.deliveredImageParts));
  const omittedImageParts = Math.floor(Number(record.omittedImageParts));
  if (
    !Number.isSafeInteger(expectedImageParts) ||
    !Number.isSafeInteger(deliveredImageParts) ||
    !Number.isSafeInteger(omittedImageParts) ||
    expectedImageParts !== admittedUserContext.imageParts ||
    deliveredImageParts < 0 ||
    omittedImageParts < 0 ||
    deliveredImageParts > expectedImageParts ||
    omittedImageParts > expectedImageParts
  ) return null;

  const recognition = record.recognition === "pending" ||
      record.recognition === "observed" ||
      record.recognition === "unverified"
    ? record.recognition
    : expectedImageParts > 0
      ? "pending"
      : "unverified";
  const observationSummary = record.observationSummary === undefined
    ? null
    : requiredString(record.observationSummary);
  const observationId = record.observationId === undefined
    ? null
    : requiredString(record.observationId);
  if (
    (record.observationSummary !== undefined && !observationSummary) ||
    (record.observationId !== undefined && !observationId)
  ) return null;
  if (
    recognition === "observed" &&
    (status !== "delivered" || !observationSummary || !observationId)
  ) return null;
  if (recognition !== "observed" && (observationSummary || observationId)) return null;
  if (expectedImageParts === 0 && status !== "none") return null;

  return {
    status,
    expectedImageParts,
    deliveredImageParts,
    omittedImageParts,
    recognition,
    ...(observationSummary ? { observationSummary } : {}),
    ...(observationId ? { observationId } : {}),
  };
}

function normalizeTurnRuntimeInputCheckpoint(
  value: unknown,
): TurnRuntimeInputCheckpoint | null {
  // Checkpoints created before typed Turn-input ownership existed are still
  // restorable, but they fail closed to an empty context instead of guessing
  // from a later synthetic user/control message.
  if (value === undefined) {
    const admittedUserContext = normalizeTurnInputContextSignals();
    return {
      admittedUserContext,
      visualContext: createInitialVisualContextState(admittedUserContext),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const admittedUserContext = normalizeDurableTurnInputContextSignals(
    record.admittedUserContext,
  );
  if (!admittedUserContext) return null;
  const visualContext = record.visualContext === undefined
    ? createInitialVisualContextState(admittedUserContext)
    : normalizeDurableVisualContextState(record.visualContext, admittedUserContext);
  return visualContext ? { admittedUserContext, visualContext } : null;
}

function isBoundedJsonValue(value: unknown, maxChars: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && serialized.length <= maxChars;
  } catch {
    return false;
  }
}

function finiteTimestamp(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function normalizeTurnIdentity(value: unknown): CanonicalTurnIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const workspaceKey = requiredString(record.workspaceKey);
  const sessionKey = requiredString(record.sessionKey);
  const sessionEpoch = requiredString(record.sessionEpoch);
  const clientSubmissionId = requiredString(record.clientSubmissionId);
  const turnId = requiredString(record.turnId);
  return workspaceKey && sessionKey && sessionEpoch && clientSubmissionId && turnId
    ? { workspaceKey, sessionKey, sessionEpoch, clientSubmissionId, turnId }
    : null;
}

function normalizeRunIdentity(value: unknown): CanonicalRunIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionKey = requiredString(record.sessionKey);
  const sessionEpoch = requiredString(record.sessionEpoch);
  const turnId = requiredString(record.turnId);
  const runId = requiredString(record.runId);
  const attemptId = requiredString(record.attemptId);
  const parentRunId = record.parentRunId === null ? null : requiredString(record.parentRunId);
  return sessionKey && sessionEpoch && turnId && runId && attemptId &&
      (record.parentRunId === null || parentRunId)
    ? { sessionKey, sessionEpoch, turnId, runId, parentRunId, attemptId }
    : null;
}

function normalizeCanonicalEvent(value: unknown): CanonicalTurnRuntimeEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== TURN_RUNTIME_CONTRACT_SCHEMA_VERSION) return null;
  const type = requiredString(record.type);
  const sequence = Number(record.sequence);
  const at = finiteTimestamp(record.at);
  if (!type || !Number.isSafeInteger(sequence) || sequence < 0 || at === null) return null;
  const base = {
    schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
    sequence,
    at,
  };
  if (type === "turn.admitted") {
    const turn = normalizeTurnIdentity(record.turn);
    const strategy = String(record.strategy || "") as TurnStrategy;
    return turn && TURN_STRATEGIES.has(strategy)
      ? { ...base, type, turn, strategy }
      : null;
  }
  if (type === "turn.completed") {
    const turn = normalizeTurnIdentity(record.turn);
    const runId = requiredString(record.runId);
    const resultKind = String(record.resultKind || "") as TurnCompletionResultKind;
    const reason = requiredString(record.reason);
    return turn && runId && RESULT_KINDS.has(resultKind) && reason
      ? { ...base, type, turn, runId, resultKind, reason }
      : null;
  }
  const run = normalizeRunIdentity(record.run);
  if (!run) return null;
  if (type === "run.started") {
    const phase = String(record.phase || "") as TurnRunPhase;
    return RUN_PHASES.has(phase) ? { ...base, type, run, phase: phase as never } : null;
  }
  if (type === "run.phase_changed") {
    const phase = String(record.phase || "") as TurnRunPhase;
    return RUN_PHASES.has(phase) ? { ...base, type, run, phase: phase as never } : null;
  }
  if (type === "run.paused") {
    const pauseKind = String(record.pauseKind || "") as TurnRunPauseKind;
    const reason = requiredString(record.reason);
    return PAUSE_KINDS.has(pauseKind) && reason
      ? { ...base, type, run, pauseKind, reason }
      : null;
  }
  if (type === "run.resumed") {
    const resolution = String(record.resolution || "") as TurnRunResumeResolution;
    const phase = String(record.phase || "") as TurnRunPhase;
    return RESUME_RESOLUTIONS.has(resolution) && RUN_PHASES.has(phase)
      ? { ...base, type, run, resolution, phase: phase as never }
      : null;
  }
  if (type === "plan.artifact_accepted") {
    const artifactRecord = record.artifact && typeof record.artifact === "object" &&
        !Array.isArray(record.artifact)
      ? record.artifact as Record<string, unknown>
      : null;
    const path = requiredString(artifactRecord?.path);
    const digest = requiredString(artifactRecord?.digest);
    const revision = safePositiveInteger(artifactRecord?.revision);
    return path && digest && revision
      ? { ...base, type, run, artifact: { path, digest, revision } }
      : null;
  }
  if (type === "plan.review_resolved") {
    const decision = record.decision === "approved" || record.decision === "changes_requested"
      ? record.decision
      : null;
    const reason = requiredString(record.reason);
    return decision && reason ? { ...base, type, run, decision, reason } : null;
  }
  if (type === "run.aborted") {
    const reason = requiredString(record.reason);
    return reason ? { ...base, type, run, reason } : null;
  }
  if (type === "run.completed") {
    const resultKind = String(record.resultKind || "") as TurnCompletionResultKind;
    const reason = requiredString(record.reason);
    return RESULT_KINDS.has(resultKind) && reason
      ? { ...base, type, run, resultKind, reason }
      : null;
  }
  return null;
}

function sameJson(left: unknown, right: unknown): boolean {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  };
  try {
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
  } catch {
    return false;
  }
}

/** Rebuild canonical state only from its ordered event ledger. */
export function normalizeCanonicalTurnRuntimeState(
  value: unknown,
): CanonicalTurnRuntimeState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== TURN_RUNTIME_CONTRACT_SCHEMA_VERSION ||
    !Array.isArray(record.events) ||
    record.events.length === 0 ||
    record.events.length > MAX_DURABLE_TURN_RUNTIME_EVENTS
  ) return null;
  const events = record.events.map(normalizeCanonicalEvent);
  if (events.some((event) => !event)) return null;
  const admitted = events[0];
  if (!admitted || admitted.type !== "turn.admitted" || admitted.sequence !== 0) return null;
  let state: CanonicalTurnRuntimeState;
  try {
    state = createCanonicalTurnRuntime({
      turn: admitted.turn,
      strategy: admitted.strategy,
      admittedAt: admitted.at,
    });
  } catch {
    return null;
  }
  for (const event of events.slice(1) as CanonicalTurnRuntimeEvent[]) {
    const transition = reduceCanonicalTurnRuntime(state, event);
    if (transition.disposition === "rejected") return null;
    state = transition.state;
  }
  const persistedProjection = {
    schemaVersion: record.schemaVersion,
    turn: record.turn,
    run: record.run ?? null,
    priorRuns: record.priorRuns,
    planArtifact: record.planArtifact ?? null,
    planReviewStatus: record.planReviewStatus,
    events,
    nextSequence: record.nextSequence,
    lastEventAt: record.lastEventAt,
  };
  return sameJson(persistedProjection, state) ? state : null;
}

/** Apply one live Run conclusion to an already-admitted durable Turn. */
export function projectCanonicalRunTransactionFromState(input: {
  state: CanonicalTurnRuntimeState;
  run: CanonicalRunIdentity;
  outcome: CanonicalRunTransactionOutcome;
  at: number;
  closesTurn: boolean;
  planArtifact?: CanonicalPlanArtifact;
}): CanonicalRunTransactionProjection {
  let state = input.state;
  const currentRunIdentity = state.run?.identity || null;
  const exactCurrentRun = !!currentRunIdentity &&
    currentRunIdentity.sessionKey === input.run.sessionKey &&
    currentRunIdentity.sessionEpoch === input.run.sessionEpoch &&
    currentRunIdentity.turnId === input.run.turnId &&
    currentRunIdentity.runId === input.run.runId &&
    currentRunIdentity.parentRunId === input.run.parentRunId &&
    currentRunIdentity.attemptId === input.run.attemptId;
  if (!exactCurrentRun) {
    const parentRun = state.run;
    const exactChildHandoff = !!parentRun &&
      parentRun.identity.sessionKey === input.run.sessionKey &&
      parentRun.identity.sessionEpoch === input.run.sessionEpoch &&
      parentRun.identity.turnId === input.run.turnId &&
      input.run.parentRunId === parentRun.identity.runId &&
      input.run.runId !== parentRun.identity.runId;
    if (!exactChildHandoff) {
      return { disposition: "rejected", reason: "run_identity_mismatch" };
    }
    if (parentRun.status === "running") {
      const parentPaused = reduceCanonicalTurnRuntime(state, {
        schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
        type: "run.paused",
        sequence: state.nextSequence,
        at: input.at,
        run: parentRun.identity,
        pauseKind: "recoverable",
        reason: "runtime_child_handoff",
      });
      if (parentPaused.disposition === "rejected") {
        return { disposition: "rejected", reason: parentPaused.reason };
      }
      state = parentPaused.state;
    }
    if (state.run?.status !== "paused" || state.run.pause?.kind !== "recoverable") {
      return { disposition: "rejected", reason: "run_not_paused" };
    }
    const childStarted = reduceCanonicalTurnRuntime(state, {
      schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
      type: "run.started",
      sequence: state.nextSequence,
      at: input.at,
      run: input.run,
      phase: input.planArtifact ? "planning" : "finalizing",
    });
    if (childStarted.disposition === "rejected") {
      return { disposition: "rejected", reason: childStarted.reason };
    }
    state = childStarted.state;
  }
  if (input.planArtifact) {
    const accepted = reduceCanonicalTurnRuntime(state, {
      schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
      type: "plan.artifact_accepted",
      sequence: state.nextSequence,
      at: input.at,
      run: input.run,
      artifact: input.planArtifact,
    });
    if (accepted.disposition === "rejected") {
      return { disposition: "rejected", reason: accepted.reason };
    }
    state = accepted.state;
    return {
      disposition: "projected",
      state,
      compatibility: projectTurnRuntimeCompatibility(state),
    };
  }
  if (input.outcome.status === "aborted") {
    const planned = planCanonicalTurnCancellation({
      state,
      reason: input.outcome.reason,
      at: input.at,
    });
    if (planned.disposition === "rejected") return planned;
    for (const event of planned.events) {
      const transition = reduceCanonicalTurnRuntime(state, event);
      if (transition.disposition === "rejected") {
        return { disposition: "rejected", reason: transition.reason };
      }
      state = transition.state;
    }
    return {
      disposition: "projected",
      state,
      compatibility: projectTurnRuntimeCompatibility(state),
    };
  }
  if (input.outcome.status === "paused") {
    const paused = reduceCanonicalTurnRuntime(state, {
      schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
      type: "run.paused",
      sequence: state.nextSequence,
      at: input.at,
      run: input.run,
      pauseKind: input.outcome.pauseKind,
      reason: input.outcome.reason,
    });
    if (paused.disposition === "rejected") {
      return { disposition: "rejected", reason: paused.reason };
    }
    state = paused.state;
    return {
      disposition: "projected",
      state,
      compatibility: projectTurnRuntimeCompatibility(state),
    };
  }
  const completed = reduceCanonicalTurnRuntime(state, {
    schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
    type: "run.completed",
    sequence: state.nextSequence,
    at: input.at,
    run: input.run,
    resultKind: input.outcome.resultKind,
    reason: input.outcome.reason,
  });
  if (completed.disposition === "rejected") {
    return { disposition: "rejected", reason: completed.reason };
  }
  state = completed.state;
  if (input.closesTurn) {
    const turnCompleted = reduceCanonicalTurnRuntime(state, {
      schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
      type: "turn.completed",
      sequence: state.nextSequence,
      at: input.at,
      turn: state.turn.identity,
      runId: input.run.runId,
      resultKind: input.outcome.resultKind,
      reason: input.outcome.reason,
    });
    if (turnCompleted.disposition === "rejected") {
      return { disposition: "rejected", reason: turnCompleted.reason };
    }
    state = turnCompleted.state;
  }
  return {
    disposition: "projected",
    state,
    compatibility: projectTurnRuntimeCompatibility(state),
  };
}

export type TurnRuntimeCheckpointTransactionProjection =
  | {
      disposition: "projected";
      checkpoint: TurnRuntimeCheckpointV1;
      compatibility: TurnRuntimeCompatibilityProjection;
    }
  | {
      disposition: "rejected";
      reason: string;
    };

/**
 * Shared checkpoint transaction used by normal and emergency terminal paths.
 * The canonical reducer owns admission; callers may only project legacy UI and
 * events from the returned compatibility snapshot.
 */
export function projectTurnRuntimeCheckpointTransaction(input: {
  checkpoint: TurnRuntimeCheckpointV1 | null;
  owner: CanonicalTurnIdentity;
  run: CanonicalRunIdentity;
  strategy: TurnStrategy;
  outcome: CanonicalRunTransactionOutcome;
  at: number;
  closesTurn: boolean;
  planArtifact?: CanonicalPlanArtifact;
}): TurnRuntimeCheckpointTransactionProjection {
  if (input.checkpoint && !sameJson(input.checkpoint.owner, input.owner)) {
    return { disposition: "rejected", reason: "checkpoint_owner_mismatch" };
  }
  const projection = input.checkpoint
    ? projectCanonicalRunTransactionFromState({
        state: input.checkpoint.canonical,
        run: input.run,
        outcome: input.outcome,
        at: input.at,
        closesTurn: input.closesTurn,
        ...(input.planArtifact ? { planArtifact: input.planArtifact } : {}),
      })
    : projectCanonicalRunTransaction({
        turn: input.owner,
        run: input.run,
        strategy: input.strategy,
        outcome: input.outcome,
        at: input.at,
        closesTurn: input.closesTurn,
        ...(input.planArtifact ? { planArtifact: input.planArtifact } : {}),
      });
  if (projection.disposition === "rejected") return projection;
  try {
    const checkpoint = input.checkpoint
      ? updateTurnRuntimeCheckpointCanonical({
          checkpoint: input.checkpoint,
          canonical: projection.state,
          updatedAt: input.at,
        })
      : createTurnRuntimeCheckpoint({
          canonical: projection.state,
          updatedAt: input.at,
        });
    return checkpoint
      ? {
          disposition: "projected",
          checkpoint,
          compatibility: projection.compatibility,
        }
      : { disposition: "rejected", reason: "checkpoint_owner_mismatch" };
  } catch {
    return { disposition: "rejected", reason: "checkpoint_projection_invalid" };
  }
}

function normalizeClosureReceiptRefs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_DURABLE_TURN_CLOSURE_RECEIPT_REFS) {
    return null;
  }
  const refs = value.map(requiredString);
  if (refs.some((receiptId) => !receiptId)) return null;
  const normalized = refs as string[];
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function resolvePlanningReceiptEvidence(input: {
  checkpointOwner: TurnRuntimeCheckpointOwner;
  canonical: CanonicalTurnRuntimeState;
  contract: PreferredDelegationScopeContract | null;
  closureReceiptRefs: string[];
  receiptLedger: SubagentClosureReceiptLedger | null | undefined;
}): {
  activities: PlanToolActivitySummary[];
  validReceiptRefs: string[];
  evidenceOwners: Array<{ subagentId: string; scopeKey: string; target: string }>;
} {
  const resolution = resolveSubagentClosureReceiptReferences({
    ledger: input.receiptLedger,
    receiptRefs: input.closureReceiptRefs,
    expectedOwner: {
      workspaceKey: input.checkpointOwner.workspaceKey,
      sessionKey: input.checkpointOwner.sessionKey,
      sessionEpoch: input.checkpointOwner.sessionEpoch,
      parentTurnId: input.checkpointOwner.turnId,
      allowedParentRunIds: [
        ...(input.canonical.run ? [input.canonical.run.identity.runId] : []),
        ...input.canonical.priorRuns.map((run) => run.identity.runId),
      ],
    },
    contract: input.contract,
  });
  return {
    activities: resolution.acceptedEvidence.map((evidence) => evidence.activity),
    validReceiptRefs: resolution.resolvedReceiptRefs,
    evidenceOwners: resolution.receipts.flatMap((receipt) =>
      receipt.acceptedEvidence.map((evidence) => ({
        subagentId: receipt.subagentId,
        scopeKey: receipt.scopeKey,
        target: evidence.activity.target,
      }))
    ),
  };
}

function ownerFromCanonical(canonical: CanonicalTurnRuntimeState): TurnRuntimeCheckpointOwner {
  return { ...canonical.turn.identity };
}

export function isTurnRuntimeCheckpointOwnerMatch(
  checkpoint: Pick<TurnRuntimeCheckpointV1, "owner">,
  expected: TurnRuntimeCheckpointExpectedOwner,
): boolean {
  return (!expected.sessionKey || checkpoint.owner.sessionKey === expected.sessionKey) &&
    (!expected.sessionEpoch || checkpoint.owner.sessionEpoch === expected.sessionEpoch) &&
    (!expected.turnId || checkpoint.owner.turnId === expected.turnId) &&
    (!expected.workspaceKey || checkpoint.owner.workspaceKey === expected.workspaceKey);
}

export function normalizeTurnRuntimeCheckpoint(
  value: unknown,
  options?: {
    expectedOwner?: TurnRuntimeCheckpointExpectedOwner;
    closureReceiptLedger?: SubagentClosureReceiptLedger | null;
    coldRestore?: boolean;
    now?: number;
  },
): TurnRuntimeCheckpointV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isBoundedJsonValue(value, MAX_DURABLE_TURN_RUNTIME_CHECKPOINT_CHARS)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== TURN_RUNTIME_CHECKPOINT_SCHEMA_VERSION) return null;
  const revision = safePositiveInteger(record.revision);
  const updatedAt = finiteTimestamp(record.updatedAt);
  const canonical = normalizeCanonicalTurnRuntimeState(record.canonical);
  const owner = normalizeTurnIdentity(record.owner);
  if (!revision || updatedAt === null || !canonical || !owner) return null;
  const canonicalOwner = ownerFromCanonical(canonical);
  if (!sameJson(owner, canonicalOwner)) return null;
  const checkpointOwner = owner as TurnRuntimeCheckpointOwner;
  if (options?.expectedOwner && !isTurnRuntimeCheckpointOwnerMatch(
    { owner: checkpointOwner },
    options.expectedOwner,
  )) return null;

  const inputCheckpoint = normalizeTurnRuntimeInputCheckpoint(record.input);
  if (!inputCheckpoint) return null;

  const planningRecord = record.planning && typeof record.planning === "object" &&
      !Array.isArray(record.planning)
    ? record.planning as Record<string, unknown>
    : null;
  if (!planningRecord) return null;
  const preferredContract = planningRecord.preferredDelegationScopeContract == null
    ? null
    : normalizePreferredDelegationScopeContract(
        planningRecord.preferredDelegationScopeContract,
      );
  if (planningRecord.preferredDelegationScopeContract != null && !preferredContract) return null;
  // v1 checkpoints briefly embedded adopted evidence before receipt ownership
  // existed. Preserve their canonical Turn state, but never migrate that
  // self-authored payload into durable collaboration authority.
  const closureReceiptRefs = planningRecord.closureReceiptRefs === undefined &&
      Array.isArray(planningRecord.adoptedEvidence)
    ? []
    : normalizeClosureReceiptRefs(planningRecord.closureReceiptRefs);
  if (!closureReceiptRefs) return null;

  let restoredCanonical = canonical;
  let restoredContract = preferredContract;
  let restoredClosureReceiptRefs = closureReceiptRefs;
  let changedForRestore = false;
  if (options?.coldRestore) {
    if (restoredCanonical.run?.status === "running") {
      const at = Math.max(
        restoredCanonical.lastEventAt,
        finiteTimestamp(options.now) ?? Date.now(),
      );
      const transition = reduceCanonicalTurnRuntime(restoredCanonical, {
        schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
        type: "run.paused",
        sequence: restoredCanonical.nextSequence,
        at,
        run: restoredCanonical.run.identity,
        pauseKind: "recoverable",
        reason: "application_restarted",
      });
      if (transition.disposition === "rejected") return null;
      restoredCanonical = transition.state;
      changedForRestore = true;
    }
  }
  if (options?.coldRestore || options?.closureReceiptLedger !== undefined) {
    const receiptResolution = resolvePlanningReceiptEvidence({
      checkpointOwner,
      canonical: restoredCanonical,
      contract: restoredContract,
      closureReceiptRefs,
      receiptLedger: options.closureReceiptLedger,
    });
    const reconciledContract = options?.coldRestore
      ? reconcilePreferredDelegationScopeContractAfterRestart({
          contract: restoredContract,
          adoptedEvidence: receiptResolution.evidenceOwners,
        })
      : restoredContract
        ? {
            ...restoredContract,
            registrations: restoredContract.registrations.map((registration) => {
              if (registration.state !== "consumed") return registration;
              const exactEvidence = receiptResolution.evidenceOwners.some((evidence) =>
                evidence.subagentId === registration.subagentId &&
                evidence.scopeKey === registration.requiredScopeKey &&
                isPreferredDelegationEvidenceTargetWithinScope(
                  registration.allowedPaths,
                  evidence.target,
                )
              );
              return exactEvidence
                ? registration
                : { ...registration, state: "incomplete" as const };
            }),
          }
        : null;
    if (!sameJson(restoredContract, reconciledContract)) changedForRestore = true;
    if (!sameJson(closureReceiptRefs, receiptResolution.validReceiptRefs)) {
      changedForRestore = true;
    }
    restoredContract = reconciledContract;
    const consumedRegistrationKeys = new Set(
      (restoredContract?.registrations || [])
        .filter((registration) => registration.state === "consumed")
        .map((registration) => `${registration.subagentId}\u001f${registration.requiredScopeKey}`),
    );
    const resolvedLedger = normalizeSubagentClosureReceiptLedger(options.closureReceiptLedger, {
      expectedOwner: checkpointOwner,
    });
    restoredClosureReceiptRefs = receiptResolution.validReceiptRefs.filter((receiptId) => {
      const receipt = resolvedLedger?.receipts.find((candidate) => candidate.receiptId === receiptId);
      return !!receipt && consumedRegistrationKeys.has(
        `${receipt.subagentId}\u001f${receipt.scopeKey}`,
      );
    });
  }
  const restoredUpdatedAt = changedForRestore
    ? Math.max(updatedAt, restoredCanonical.lastEventAt, finiteTimestamp(options?.now) ?? Date.now())
    : updatedAt;
  return {
    schemaVersion: TURN_RUNTIME_CHECKPOINT_SCHEMA_VERSION,
    revision: changedForRestore ? revision + 1 : revision,
    owner: checkpointOwner,
    canonical: restoredCanonical,
    input: inputCheckpoint,
    planning: {
      preferredDelegationScopeContract: restoredContract,
      closureReceiptRefs: restoredClosureReceiptRefs,
    },
    updatedAt: restoredUpdatedAt,
  };
}

export function normalizeTurnRuntimeCheckpointMap(
  value: unknown,
  options?: {
    expectedSessionKey?: string | null;
    expectedSessionEpoch?: string | null;
    expectedWorkspaceKey?: string | null;
    closureReceiptLedger?: SubagentClosureReceiptLedger | null;
    coldRestore?: boolean;
    now?: number;
  },
): TurnRuntimeCheckpointMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const checkpointEntries = Object.entries(value as Record<string, unknown>);
  if (checkpointEntries.length > MAX_DURABLE_TURN_RUNTIME_CHECKPOINTS) return {};
  const sessionKey = requiredString(options?.expectedSessionKey);
  const sessionEpoch = requiredString(options?.expectedSessionEpoch);
  const workspaceKey = requiredString(options?.expectedWorkspaceKey);
  if (
    (options?.expectedSessionKey && !sessionKey) ||
    (options?.expectedSessionEpoch && !sessionEpoch) ||
    (options?.expectedWorkspaceKey && !workspaceKey)
  ) {
    return {};
  }
  const normalized = checkpointEntries.flatMap(
    ([turnId, candidate]) => {
      const checkpoint = normalizeTurnRuntimeCheckpoint(candidate, {
        ...(sessionKey || sessionEpoch || workspaceKey
          ? {
              expectedOwner: {
                ...(sessionKey ? { sessionKey } : {}),
                ...(sessionEpoch ? { sessionEpoch } : {}),
                ...(workspaceKey ? { workspaceKey } : {}),
                turnId,
              },
            }
          : {}),
        coldRestore: options?.coldRestore,
        closureReceiptLedger: options?.closureReceiptLedger,
        now: options?.now,
      });
      return checkpoint && checkpoint.owner.turnId === turnId ? [checkpoint] : [];
    },
  );
  normalized.sort((left, right) => left.updatedAt - right.updatedAt);
  return Object.fromEntries(
    normalized
      .slice(-MAX_DURABLE_TURN_RUNTIME_CHECKPOINTS)
      .map((checkpoint) => [checkpoint.owner.turnId, checkpoint]),
  );
}

export function createTurnRuntimeCheckpoint(input: {
  canonical: CanonicalTurnRuntimeState;
  admittedUserContext?: TurnInputContextSignals;
  preferredDelegationScopeContract?: PreferredDelegationScopeContract | null;
  closureReceiptRefs?: string[];
  updatedAt?: number;
}): TurnRuntimeCheckpointV1 {
  const admittedUserContext = normalizeTurnInputContextSignals(
    input.admittedUserContext,
  );
  const checkpoint = normalizeTurnRuntimeCheckpoint({
    schemaVersion: TURN_RUNTIME_CHECKPOINT_SCHEMA_VERSION,
    revision: 1,
    owner: ownerFromCanonical(input.canonical),
    canonical: input.canonical,
    input: {
      admittedUserContext,
      visualContext: createInitialVisualContextState(admittedUserContext),
    },
    planning: {
      preferredDelegationScopeContract:
        input.preferredDelegationScopeContract || null,
      closureReceiptRefs: input.closureReceiptRefs || [],
    },
    updatedAt: input.updatedAt ?? input.canonical.lastEventAt,
  });
  if (!checkpoint) throw new Error("Invalid Turn runtime checkpoint input");
  return checkpoint;
}

/**
 * Advances only runtime-owned visual receipt/observation state. The admitted
 * payload facts are immutable for the lifetime of the durable Turn.
 */
export function updateTurnRuntimeVisualContextCheckpoint(input: {
  checkpoint: TurnRuntimeCheckpointV1;
  visualContext: VisualContextDeliveryState;
  updatedAt?: number;
}): TurnRuntimeCheckpointV1 | null {
  const incoming = normalizeDurableVisualContextState(
    input.visualContext,
    input.checkpoint.input.admittedUserContext,
  );
  if (!incoming) return null;
  const previous = input.checkpoint.input.visualContext;
  const monotonicStatus = resolveMonotonicVisualContextStatus(
    previous.status,
    incoming.status,
  );
  const statusOwner = monotonicStatus === incoming.status ? incoming : previous;
  const previousObservation = previous.recognition === "observed"
    ? {
        recognition: "observed" as const,
        observationSummary: previous.observationSummary,
        observationId: previous.observationId,
      }
    : null;
  const incomingObservation = incoming.recognition === "observed"
    ? {
        recognition: "observed" as const,
        observationSummary: incoming.observationSummary,
        observationId: incoming.observationId,
      }
    : null;
  const observation = monotonicStatus === "delivered"
    // The first owner-fenced observation is immutable evidence. Retries may
    // repeat it, but a later model response cannot rewrite what the original
    // delivered payload was recorded as showing.
    ? previousObservation || incomingObservation
    : null;
  const visualContext: VisualContextDeliveryState = {
    status: monotonicStatus,
    expectedImageParts: statusOwner.expectedImageParts,
    deliveredImageParts: statusOwner.deliveredImageParts,
    omittedImageParts: statusOwner.omittedImageParts,
    ...(observation || {
      recognition: incoming.recognition || previous.recognition || "unverified",
    }),
  };
  return normalizeTurnRuntimeCheckpoint({
    ...input.checkpoint,
    revision: input.checkpoint.revision + 1,
    input: {
      admittedUserContext: input.checkpoint.input.admittedUserContext,
      visualContext,
    },
    updatedAt: Math.max(input.checkpoint.updatedAt, input.updatedAt ?? Date.now()),
  });
}

export function updateTurnRuntimeCheckpointCanonical(input: {
  checkpoint: TurnRuntimeCheckpointV1;
  canonical: CanonicalTurnRuntimeState;
  updatedAt?: number;
}): TurnRuntimeCheckpointV1 | null {
  const owner = ownerFromCanonical(input.canonical);
  if (!sameJson(owner, input.checkpoint.owner)) return null;
  return normalizeTurnRuntimeCheckpoint({
    ...input.checkpoint,
    revision: input.checkpoint.revision + 1,
    canonical: input.canonical,
    updatedAt: Math.max(
      input.checkpoint.updatedAt,
      input.updatedAt ?? input.canonical.lastEventAt,
    ),
  });
}

export function updateTurnRuntimePlanningCheckpoint(input: {
  checkpoint: TurnRuntimeCheckpointV1;
  preferredDelegationScopeContract: PreferredDelegationScopeContract | null;
  closureReceiptRefs: string[];
  updatedAt?: number;
}): TurnRuntimeCheckpointV1 | null {
  const contract = input.preferredDelegationScopeContract == null
    ? null
    : normalizePreferredDelegationScopeContract(input.preferredDelegationScopeContract);
  if (input.preferredDelegationScopeContract && !contract) return null;
  const closureReceiptRefs = normalizeClosureReceiptRefs(input.closureReceiptRefs);
  if (!closureReceiptRefs) return null;
  return normalizeTurnRuntimeCheckpoint({
    ...input.checkpoint,
    revision: input.checkpoint.revision + 1,
    planning: {
      preferredDelegationScopeContract: contract,
      closureReceiptRefs,
    },
    updatedAt: Math.max(input.checkpoint.updatedAt, input.updatedAt ?? Date.now()),
  });
}

export function restoreDurableTurnPlanningActivities(
  checkpoint: TurnRuntimeCheckpointV1 | null | undefined,
  receiptLedger: SubagentClosureReceiptLedger | null | undefined,
): PlanToolActivitySummary[] {
  if (!checkpoint) return [];
  const resolved = resolvePlanningReceiptEvidence({
    checkpointOwner: checkpoint.owner,
    canonical: checkpoint.canonical,
    contract: checkpoint.planning.preferredDelegationScopeContract,
    closureReceiptRefs: checkpoint.planning.closureReceiptRefs,
    receiptLedger,
  });
  return resolved.activities.map((activity) => ({
    ...activity,
    delegatedObservation: activity.delegatedObservation
      ? {
          ...activity.delegatedObservation,
          owner: { ...activity.delegatedObservation.owner },
          ...(activity.delegatedObservation.sourceRange
            ? { sourceRange: { ...activity.delegatedObservation.sourceRange } }
            : {}),
        }
      : undefined,
  }));
}

export function upsertTurnRuntimeCheckpoint(
  current: TurnRuntimeCheckpointMap | null | undefined,
  checkpoint: TurnRuntimeCheckpointV1,
): TurnRuntimeCheckpointMap {
  const normalizedCurrent = normalizeTurnRuntimeCheckpointMap(current);
  const normalized = normalizeTurnRuntimeCheckpoint(checkpoint);
  if (!normalized) return normalizedCurrent;
  const existing = normalizedCurrent[normalized.owner.turnId];
  if (existing && (
    !sameJson(existing.owner, normalized.owner) ||
    existing.revision > normalized.revision
  )) return normalizedCurrent;
  const bounded = [
    ...Object.values(normalizedCurrent).filter((candidate) =>
      candidate.owner.turnId !== normalized.owner.turnId
    ),
    normalized,
  ]
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(-MAX_DURABLE_TURN_RUNTIME_CHECKPOINTS);
  return normalizeTurnRuntimeCheckpointMap(Object.fromEntries(
    bounded.map((candidate) => [candidate.owner.turnId, candidate]),
  ));
}
