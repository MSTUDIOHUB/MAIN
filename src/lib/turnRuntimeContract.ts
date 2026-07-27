/**
 * Canonical workspace Turn/Run lifecycle.
 *
 * This module deliberately has no React, store, provider, or executor imports.
 * Runtime owners may adapt its events to persistence and UI event envelopes,
 * but model prose must never be used to derive these states.
 */

export const TURN_RUNTIME_CONTRACT_SCHEMA_VERSION = 1 as const;

export type TurnStrategy = "chat" | "plan" | "execute" | "goal";

export type TurnCompletionResultKind =
  | "success"
  | "partial"
  | "blocked"
  | "error"
  | "canceled";

export type TurnRunPhase =
  | "admitted"
  | "preparing"
  | "investigating"
  | "planning"
  | "executing"
  | "validating"
  | "reviewing"
  | "finalizing"
  | "completed";

export type TurnRunPauseKind = "review" | "approval" | "input" | "recoverable";

export type TurnRunResumeResolution =
  | "review_completed"
  | "approval_granted"
  | "input_supplied"
  | "recovery";

export interface CanonicalTurnIdentity {
  readonly workspaceKey: string;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly clientSubmissionId: string;
  readonly turnId: string;
}

/** Attempt is part of the fence: a late callback from a replaced attempt is stale. */
export interface CanonicalRunIdentity {
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly turnId: string;
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly attemptId: string;
}

export interface CanonicalPlanArtifact {
  readonly path: string;
  readonly digest: string;
  readonly revision: number;
}

export type CanonicalPlanReviewStatus =
  | "none"
  | "pending"
  | "approved"
  | "changes_requested"
  | "canceled";

export interface CanonicalTurnPause {
  readonly kind: TurnRunPauseKind;
  readonly reason: string;
  readonly subject: "run" | "plan";
  readonly requestedAt: number;
}

export interface CanonicalTurnState {
  readonly identity: CanonicalTurnIdentity;
  readonly strategy: TurnStrategy;
  readonly status: "open" | "completed";
  readonly resultKind: TurnCompletionResultKind | null;
  readonly completionReason: string | null;
}

export interface CanonicalRunState {
  readonly identity: CanonicalRunIdentity;
  readonly status: "running" | "paused" | "aborted" | "completed";
  readonly phase: TurnRunPhase;
  readonly pause: CanonicalTurnPause | null;
  readonly resultKind: TurnCompletionResultKind | null;
  readonly completionReason: string | null;
}

interface CanonicalTurnRuntimeEventBase {
  readonly schemaVersion: typeof TURN_RUNTIME_CONTRACT_SCHEMA_VERSION;
  /** Application order is authoritative, including when timestamps are equal. */
  readonly sequence: number;
  readonly at: number;
}

export type CanonicalTurnRuntimeEvent =
  | (CanonicalTurnRuntimeEventBase & {
      readonly type: "turn.admitted";
      readonly turn: CanonicalTurnIdentity;
      readonly strategy: TurnStrategy;
    })
  | (CanonicalTurnRuntimeEventBase & {
      readonly type: "run.started";
      readonly run: CanonicalRunIdentity;
      readonly phase: Exclude<TurnRunPhase, "admitted" | "reviewing" | "completed">;
    })
  | (CanonicalTurnRuntimeEventBase & {
      readonly type: "run.phase_changed";
      readonly run: CanonicalRunIdentity;
      readonly phase: Exclude<TurnRunPhase, "admitted" | "completed">;
    })
  | (CanonicalTurnRuntimeEventBase & {
      readonly type: "run.paused";
      readonly run: CanonicalRunIdentity;
      readonly pauseKind: TurnRunPauseKind;
      readonly reason: string;
    })
  | (CanonicalTurnRuntimeEventBase & {
      readonly type: "run.resumed";
      readonly run: CanonicalRunIdentity;
      readonly resolution: TurnRunResumeResolution;
      readonly phase: Exclude<TurnRunPhase, "admitted" | "reviewing" | "completed">;
    })
  | (CanonicalTurnRuntimeEventBase & {
      readonly type: "plan.artifact_accepted";
      readonly run: CanonicalRunIdentity;
      readonly artifact: CanonicalPlanArtifact;
    })
  | (CanonicalTurnRuntimeEventBase & {
      readonly type: "plan.review_resolved";
      readonly run: CanonicalRunIdentity;
      readonly decision: "approved" | "changes_requested";
      readonly reason: string;
    })
  | (CanonicalTurnRuntimeEventBase & {
      /** Aborted is cancellation evidence, not a terminal Run or Turn outcome. */
      readonly type: "run.aborted";
      readonly run: CanonicalRunIdentity;
      readonly reason: string;
    })
  | (CanonicalTurnRuntimeEventBase & {
      readonly type: "run.completed";
      readonly run: CanonicalRunIdentity;
      readonly resultKind: TurnCompletionResultKind;
      readonly reason: string;
    })
  | (CanonicalTurnRuntimeEventBase & {
      readonly type: "turn.completed";
      readonly turn: CanonicalTurnIdentity;
      readonly runId: string;
      readonly resultKind: TurnCompletionResultKind;
      readonly reason: string;
    });

export interface CanonicalTurnRuntimeState {
  readonly schemaVersion: typeof TURN_RUNTIME_CONTRACT_SCHEMA_VERSION;
  readonly turn: CanonicalTurnState;
  readonly run: CanonicalRunState | null;
  /** Earlier main Runs remain immutable evidence when a same-Turn child Run takes ownership. */
  readonly priorRuns: readonly CanonicalRunState[];
  readonly planArtifact: CanonicalPlanArtifact | null;
  readonly planReviewStatus: CanonicalPlanReviewStatus;
  readonly events: readonly CanonicalTurnRuntimeEvent[];
  readonly nextSequence: number;
  readonly lastEventAt: number;
}

export type TurnRuntimeTransitionRejection =
  | "invalid_schema_version"
  | "invalid_event_sequence"
  | "event_sequence_conflict"
  | "invalid_event_time"
  | "event_time_regression"
  | "turn_identity_mismatch"
  | "run_identity_mismatch"
  | "run_identity_invalid"
  | "turn_already_completed"
  | "run_already_started"
  | "run_not_started"
  | "run_not_running"
  | "run_not_paused"
  | "run_not_aborted"
  | "run_not_completed"
  | "phase_invalid"
  | "pause_reason_required"
  | "resume_resolution_mismatch"
  | "plan_strategy_required"
  | "plan_artifact_invalid"
  | "plan_review_not_pending"
  | "plan_review_resolution_required"
  | "cancellation_requires_abort"
  | "aborted_run_requires_canceled_result"
  | "run_result_mismatch";

export type TurnRuntimeTransitionResult =
  | {
      readonly disposition: "applied" | "idempotent";
      readonly state: CanonicalTurnRuntimeState;
    }
  | {
      readonly disposition: "rejected";
      readonly state: CanonicalTurnRuntimeState;
      readonly reason: TurnRuntimeTransitionRejection;
    };

const TURN_STRATEGIES = new Set<TurnStrategy>(["chat", "plan", "execute", "goal"]);
const START_PHASES = new Set<TurnRunPhase>([
  "preparing",
  "investigating",
  "planning",
  "executing",
  "validating",
  "finalizing",
]);
const ACTIVE_PHASES = new Set<TurnRunPhase>([
  ...START_PHASES,
  "reviewing",
]);

function isRequiredIdentityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function assertTurnIdentity(identity: CanonicalTurnIdentity): void {
  for (const value of [
    identity.workspaceKey,
    identity.sessionKey,
    identity.sessionEpoch,
    identity.clientSubmissionId,
    identity.turnId,
  ]) {
    if (!isRequiredIdentityPart(value)) {
      throw new Error("Canonical Turn identity fields must be non-empty and trimmed");
    }
  }
}

export function isCanonicalRunIdentity(identity: unknown): identity is CanonicalRunIdentity {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
  const candidate = identity as Partial<CanonicalRunIdentity>;
  return [
    candidate.sessionKey,
    candidate.sessionEpoch,
    candidate.turnId,
    candidate.runId,
    candidate.attemptId,
  ].every(isRequiredIdentityPart) && (
    candidate.parentRunId === null || isRequiredIdentityPart(candidate.parentRunId)
  );
}

/** Parse one JSON-only Run identity without granting authority to partial data. */
export function normalizeCanonicalRunIdentity(value: unknown): CanonicalRunIdentity | null {
  if (!isCanonicalRunIdentity(value)) return null;
  return {
    sessionKey: value.sessionKey,
    sessionEpoch: value.sessionEpoch,
    turnId: value.turnId,
    runId: value.runId,
    parentRunId: value.parentRunId,
    attemptId: value.attemptId,
  };
}

function sameTurnIdentity(left: CanonicalTurnIdentity, right: CanonicalTurnIdentity): boolean {
  return left.workspaceKey === right.workspaceKey &&
    left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.clientSubmissionId === right.clientSubmissionId &&
    left.turnId === right.turnId;
}

export function isSameCanonicalRunIdentity(
  left: CanonicalRunIdentity,
  right: CanonicalRunIdentity,
): boolean {
  return left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.parentRunId === right.parentRunId &&
    left.attemptId === right.attemptId;
}

function runBelongsToTurn(run: CanonicalRunIdentity, turn: CanonicalTurnIdentity): boolean {
  return run.sessionKey === turn.sessionKey &&
    run.sessionEpoch === turn.sessionEpoch &&
    run.turnId === turn.turnId;
}

function validEventTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function normalizedReason(value: string): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function eventsEqual(
  left: CanonicalTurnRuntimeEvent,
  right: CanonicalTurnRuntimeEvent,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reject(
  state: CanonicalTurnRuntimeState,
  reason: TurnRuntimeTransitionRejection,
): TurnRuntimeTransitionResult {
  return { disposition: "rejected", state, reason };
}

function commit(
  state: CanonicalTurnRuntimeState,
  event: CanonicalTurnRuntimeEvent,
  patch: Partial<Omit<CanonicalTurnRuntimeState, "schemaVersion" | "events" | "nextSequence" | "lastEventAt">>,
): TurnRuntimeTransitionResult {
  return {
    disposition: "applied",
    state: {
      ...state,
      ...patch,
      events: [...state.events, event],
      nextSequence: state.nextSequence + 1,
      lastEventAt: event.at,
    },
  };
}

export function createCanonicalTurnRuntime(input: {
  readonly turn: CanonicalTurnIdentity;
  readonly strategy: TurnStrategy;
  readonly admittedAt: number;
}): CanonicalTurnRuntimeState {
  assertTurnIdentity(input.turn);
  if (!TURN_STRATEGIES.has(input.strategy)) {
    throw new Error(`Unsupported Turn strategy: ${String(input.strategy)}`);
  }
  if (!validEventTime(input.admittedAt)) {
    throw new Error("Canonical Turn admission time must be a finite non-negative number");
  }
  const admitted: CanonicalTurnRuntimeEvent = {
    schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
    type: "turn.admitted",
    sequence: 0,
    at: input.admittedAt,
    turn: input.turn,
    strategy: input.strategy,
  };
  return {
    schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
    turn: {
      identity: input.turn,
      strategy: input.strategy,
      status: "open",
      resultKind: null,
      completionReason: null,
    },
    run: null,
    priorRuns: [],
    planArtifact: null,
    planReviewStatus: "none",
    events: [admitted],
    nextSequence: 1,
    lastEventAt: input.admittedAt,
  };
}

function validateRunEventIdentity(
  state: CanonicalTurnRuntimeState,
  run: CanonicalRunIdentity,
): TurnRuntimeTransitionRejection | null {
  if (!isCanonicalRunIdentity(run) || !runBelongsToTurn(run, state.turn.identity)) {
    return "run_identity_invalid";
  }
  if (!state.run) return null;
  return isSameCanonicalRunIdentity(state.run.identity, run) ? null : "run_identity_mismatch";
}

function expectedResumeResolution(kind: TurnRunPauseKind): TurnRunResumeResolution {
  switch (kind) {
    case "review":
      return "review_completed";
    case "approval":
      return "approval_granted";
    case "input":
      return "input_supplied";
    case "recoverable":
      return "recovery";
  }
}

/** Pure lifecycle reducer. Rejected transitions return the original state. */
export function reduceCanonicalTurnRuntime(
  state: CanonicalTurnRuntimeState,
  event: CanonicalTurnRuntimeEvent,
): TurnRuntimeTransitionResult {
  if (event.schemaVersion !== TURN_RUNTIME_CONTRACT_SCHEMA_VERSION) {
    return reject(state, "invalid_schema_version");
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    return reject(state, "invalid_event_sequence");
  }
  if (event.sequence < state.nextSequence) {
    const existing = state.events.find((candidate) => candidate.sequence === event.sequence);
    return existing && eventsEqual(existing, event)
      ? { disposition: "idempotent", state }
      : reject(state, "event_sequence_conflict");
  }
  if (event.sequence !== state.nextSequence) {
    return reject(state, "invalid_event_sequence");
  }
  if (!validEventTime(event.at)) return reject(state, "invalid_event_time");
  if (event.at < state.lastEventAt) return reject(state, "event_time_regression");
  if (state.turn.status === "completed") return reject(state, "turn_already_completed");

  if (event.type === "turn.admitted") {
    return reject(state, "event_sequence_conflict");
  }

  if (event.type === "turn.completed") {
    if (!sameTurnIdentity(state.turn.identity, event.turn)) {
      return reject(state, "turn_identity_mismatch");
    }
    if (!state.run) return reject(state, "run_not_started");
    if (state.run.identity.runId !== event.runId) {
      return reject(state, "run_identity_mismatch");
    }
    if (state.run.status !== "completed") return reject(state, "run_not_completed");
    if (state.run.resultKind !== event.resultKind) return reject(state, "run_result_mismatch");
    const reason = normalizedReason(event.reason);
    if (!reason) return reject(state, "pause_reason_required");
    return commit(state, event, {
      turn: {
        ...state.turn,
        status: "completed",
        resultKind: event.resultKind,
        completionReason: reason,
      },
    });
  }

  if (event.type === "run.started") {
    if (!isCanonicalRunIdentity(event.run) || !runBelongsToTurn(event.run, state.turn.identity)) {
      return reject(state, "run_identity_invalid");
    }
    if (!START_PHASES.has(event.phase)) return reject(state, "phase_invalid");
    if (!state.run) {
      return commit(state, event, {
        run: {
          identity: event.run,
          status: "running",
          phase: event.phase,
          pause: null,
          resultKind: null,
          completionReason: null,
        },
      });
    }

    const isAuthorizedChild = state.run.status === "paused" &&
      state.run.pause?.kind === "recoverable" &&
      event.run.parentRunId === state.run.identity.runId &&
      event.run.runId !== state.run.identity.runId;
    if (!isAuthorizedChild) return reject(state, "run_already_started");
    return commit(state, event, {
      priorRuns: [...state.priorRuns, state.run],
      run: {
        identity: event.run,
        status: "running",
        phase: event.phase,
        pause: null,
        resultKind: null,
        completionReason: null,
      },
    });
  }

  const identityRejection = validateRunEventIdentity(state, event.run);
  if (identityRejection) return reject(state, identityRejection);

  switch (event.type) {
    case "run.phase_changed": {
      if (!state.run) return reject(state, "run_not_started");
      if (state.run.status !== "running") return reject(state, "run_not_running");
      if (!ACTIVE_PHASES.has(event.phase)) return reject(state, "phase_invalid");
      return commit(state, event, {
        run: { ...state.run, phase: event.phase },
      });
    }
    case "run.paused": {
      if (!state.run) return reject(state, "run_not_started");
      if (state.run.status !== "running") return reject(state, "run_not_running");
      const reason = normalizedReason(event.reason);
      if (!reason) return reject(state, "pause_reason_required");
      return commit(state, event, {
        run: {
          ...state.run,
          status: "paused",
          pause: {
            kind: event.pauseKind,
            reason,
            subject: "run",
            requestedAt: event.at,
          },
        },
      });
    }
    case "run.resumed": {
      if (!state.run) return reject(state, "run_not_started");
      if (state.run.status !== "paused" || !state.run.pause) {
        return reject(state, "run_not_paused");
      }
      if (state.planReviewStatus === "pending") {
        return reject(state, "plan_review_resolution_required");
      }
      if (event.resolution !== expectedResumeResolution(state.run.pause.kind)) {
        return reject(state, "resume_resolution_mismatch");
      }
      if (!START_PHASES.has(event.phase)) return reject(state, "phase_invalid");
      return commit(state, event, {
        run: {
          ...state.run,
          status: "running",
          phase: event.phase,
          pause: null,
        },
      });
    }
    case "plan.artifact_accepted": {
      if (state.turn.strategy !== "plan") return reject(state, "plan_strategy_required");
      if (!state.run) return reject(state, "run_not_started");
      if (state.run.status !== "running") return reject(state, "run_not_running");
      if (
        !isRequiredIdentityPart(event.artifact.path) ||
        !isRequiredIdentityPart(event.artifact.digest) ||
        !Number.isSafeInteger(event.artifact.revision) ||
        event.artifact.revision < 1
      ) {
        return reject(state, "plan_artifact_invalid");
      }
      return commit(state, event, {
        planArtifact: event.artifact,
        planReviewStatus: "pending",
        run: {
          ...state.run,
          status: "paused",
          phase: "reviewing",
          pause: {
            kind: "approval",
            reason: "plan_review_required",
            subject: "plan",
            requestedAt: event.at,
          },
        },
      });
    }
    case "plan.review_resolved": {
      if (state.turn.strategy !== "plan") return reject(state, "plan_strategy_required");
      if (!state.run) return reject(state, "run_not_started");
      if (
        state.run.status !== "paused" ||
        state.run.pause?.subject !== "plan" ||
        state.planReviewStatus !== "pending"
      ) {
        return reject(state, "plan_review_not_pending");
      }
      const reason = normalizedReason(event.reason);
      if (!reason) return reject(state, "pause_reason_required");
      const approved = event.decision === "approved";
      return commit(state, event, {
        planReviewStatus: approved ? "approved" : "changes_requested",
        run: {
          ...state.run,
          status: approved ? "paused" : "running",
          phase: approved ? "reviewing" : "planning",
          pause: approved
            ? {
                kind: "recoverable",
                reason: "approved_plan_child_run_pending",
                subject: "run",
                requestedAt: event.at,
              }
            : null,
        },
      });
    }
    case "run.aborted": {
      if (!state.run) return reject(state, "run_not_started");
      if (state.run.status !== "running" && state.run.status !== "paused") {
        return reject(state, "run_not_running");
      }
      const reason = normalizedReason(event.reason);
      if (!reason) return reject(state, "pause_reason_required");
      return commit(state, event, {
        planReviewStatus: state.planReviewStatus === "pending"
          ? "canceled"
          : state.planReviewStatus,
        run: {
          ...state.run,
          status: "aborted",
          pause: null,
          completionReason: reason,
        },
      });
    }
    case "run.completed": {
      if (!state.run) return reject(state, "run_not_started");
      const reason = normalizedReason(event.reason);
      if (!reason) return reject(state, "pause_reason_required");
      if (state.run.status === "aborted") {
        if (event.resultKind !== "canceled") {
          return reject(state, "aborted_run_requires_canceled_result");
        }
      } else {
        if (state.run.status !== "running") return reject(state, "run_not_running");
        if (event.resultKind === "canceled") {
          return reject(state, "cancellation_requires_abort");
        }
      }
      return commit(state, event, {
        run: {
          ...state.run,
          status: "completed",
          phase: "completed",
          pause: null,
          resultKind: event.resultKind,
          completionReason: reason,
        },
      });
    }
  }
}

export interface CanonicalCancellationPlan {
  readonly disposition: "planned";
  readonly events: readonly [
    Extract<CanonicalTurnRuntimeEvent, { type: "run.aborted" }>,
    Extract<CanonicalTurnRuntimeEvent, { type: "run.completed" }>,
    Extract<CanonicalTurnRuntimeEvent, { type: "turn.completed" }>,
  ];
}

export type CanonicalCancellationPlanResult = CanonicalCancellationPlan | {
  readonly disposition: "rejected";
  readonly reason: "turn_already_completed" | "run_not_started" | "run_not_running" | "invalid_event_time";
};

/**
 * Produce the sole cancellation order. Callers append these events through the
 * reducer; `run.aborted` alone never closes either lifecycle.
 */
export function planCanonicalTurnCancellation(input: {
  readonly state: CanonicalTurnRuntimeState;
  readonly reason: string;
  readonly at: number;
}): CanonicalCancellationPlanResult {
  const { state } = input;
  if (state.turn.status === "completed") {
    return { disposition: "rejected", reason: "turn_already_completed" };
  }
  if (!state.run) return { disposition: "rejected", reason: "run_not_started" };
  if (state.run.status !== "running" && state.run.status !== "paused") {
    return { disposition: "rejected", reason: "run_not_running" };
  }
  if (!validEventTime(input.at) || input.at < state.lastEventAt) {
    return { disposition: "rejected", reason: "invalid_event_time" };
  }
  const reason = normalizedReason(input.reason) || "user_canceled";
  const base = state.nextSequence;
  return {
    disposition: "planned",
    events: [
      {
        schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
        type: "run.aborted",
        sequence: base,
        at: input.at,
        run: state.run.identity,
        reason,
      },
      {
        schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
        type: "run.completed",
        sequence: base + 1,
        at: input.at,
        run: state.run.identity,
        resultKind: "canceled",
        reason,
      },
      {
        schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
        type: "turn.completed",
        sequence: base + 2,
        at: input.at,
        turn: state.turn.identity,
        runId: state.run.identity.runId,
        resultKind: "canceled",
        reason,
      },
    ],
  };
}

export type TurnIngressMode = "submit" | "queue" | "guidance";

export type CanonicalRunTransactionOutcome =
  | { status: "completed"; resultKind: Exclude<TurnCompletionResultKind, "canceled">; reason: string }
  | { status: "paused"; pauseKind: TurnRunPauseKind; reason: string }
  | { status: "aborted"; reason: string };

export type CanonicalRunTransactionProjection =
  | {
      disposition: "projected";
      state: CanonicalTurnRuntimeState;
      compatibility: TurnRuntimeCompatibilityProjection;
    }
  | {
      disposition: "rejected";
      reason: TurnRuntimeTransitionRejection |
        Extract<CanonicalCancellationPlanResult, { disposition: "rejected" }>["reason"];
    };

/**
 * Transaction adapter used by the live engine while legacy event persistence
 * is being migrated. It makes the canonical reducer the admission authority
 * for one Run conclusion; callers may only project UI/events from the returned
 * compatibility state.
 */
export function projectCanonicalRunTransaction(input: {
  turn: CanonicalTurnIdentity;
  run: CanonicalRunIdentity;
  strategy: TurnStrategy;
  outcome: CanonicalRunTransactionOutcome;
  at: number;
  closesTurn: boolean;
  planArtifact?: CanonicalPlanArtifact;
}): CanonicalRunTransactionProjection {
  let state = createCanonicalTurnRuntime({
    turn: input.turn,
    strategy: input.strategy,
    admittedAt: input.at,
  });
  const start = reduceCanonicalTurnRuntime(state, {
    schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
    type: "run.started",
    sequence: state.nextSequence,
    at: input.at,
    run: input.run,
    phase: input.strategy === "plan" ? "planning" : input.strategy === "chat" ? "preparing" : "executing",
  });
  if (start.disposition === "rejected") return { disposition: "rejected", reason: start.reason };
  state = start.state;

  if (input.planArtifact) {
    const accepted = reduceCanonicalTurnRuntime(state, {
      schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
      type: "plan.artifact_accepted",
      sequence: state.nextSequence,
      at: input.at,
      run: input.run,
      artifact: input.planArtifact,
    });
    if (accepted.disposition === "rejected") return { disposition: "rejected", reason: accepted.reason };
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
    if (paused.disposition === "rejected") return { disposition: "rejected", reason: paused.reason };
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
  if (completed.disposition === "rejected") return { disposition: "rejected", reason: completed.reason };
  state = completed.state;
  if (input.closesTurn) {
    const turnCompleted = reduceCanonicalTurnRuntime(state, {
      schemaVersion: TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
      type: "turn.completed",
      sequence: state.nextSequence,
      at: input.at,
      turn: input.turn,
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

export type TurnIngressDecision =
  | {
      readonly kind: "admit_turn";
      readonly createsTurn: true;
      readonly admission: "immediate" | "fifo";
      readonly strategy: TurnStrategy;
    }
  | {
      readonly kind: "attach_guidance";
      readonly createsTurn: false;
      readonly admission: "active_run";
      readonly target: CanonicalRunIdentity;
    }
  | {
      readonly kind: "reject";
      readonly createsTurn: false;
      readonly reason:
        | "active_run_requires_explicit_ingress"
        | "active_run_required"
        | "active_run_not_guidable"
        | "invalid_strategy";
    };

export type TurnIngressInput =
  | {
      readonly mode: "submit" | "queue";
      readonly strategy: TurnStrategy;
      readonly activeTurn?: CanonicalTurnRuntimeState | null;
    }
  | {
      readonly mode: "guidance";
      readonly activeTurn?: CanonicalTurnRuntimeState | null;
    };

function hasOpenTurn(state: CanonicalTurnRuntimeState | null | undefined): boolean {
  return !!state && state.turn.status === "open";
}

/**
 * Guidance is an input item owned by the active Run. It is not a workspace
 * submission and therefore creates no Turn. Submit/queue always admit a Turn;
 * active execution requires the caller to choose queue or guidance explicitly.
 */
export function decideTurnIngress(input: TurnIngressInput): TurnIngressDecision {
  if (input.mode === "guidance") {
    if (!hasOpenTurn(input.activeTurn) || !input.activeTurn?.run) {
      return { kind: "reject", createsTurn: false, reason: "active_run_required" };
    }
    if (input.activeTurn.run.status !== "running") {
      return { kind: "reject", createsTurn: false, reason: "active_run_not_guidable" };
    }
    // Finalization is the linearization boundary between an admitted Guide and
    // a completed Run. Once the runtime acquires that boundary, new Guide
    // input must fail closed so the Composer can leave the draft available for
    // Queue instead of racing terminal publication.
    if (input.activeTurn.run.phase === "finalizing") {
      return { kind: "reject", createsTurn: false, reason: "active_run_not_guidable" };
    }
    return {
      kind: "attach_guidance",
      createsTurn: false,
      admission: "active_run",
      target: input.activeTurn.run.identity,
    };
  }

  if (!TURN_STRATEGIES.has(input.strategy)) {
    return { kind: "reject", createsTurn: false, reason: "invalid_strategy" };
  }
  if (input.mode === "queue") {
    return {
      kind: "admit_turn",
      createsTurn: true,
      admission: "fifo",
      strategy: input.strategy,
    };
  }
  if (hasOpenTurn(input.activeTurn)) {
    return {
      kind: "reject",
      createsTurn: false,
      reason: "active_run_requires_explicit_ingress",
    };
  }
  return {
    kind: "admit_turn",
    createsTurn: true,
    admission: "immediate",
    strategy: input.strategy,
  };
}

export type TurnCompatibilityAgentStatus = "idle" | "running" | "pending_review" | "error";

export type TurnCompatibilityConversationStatus =
  | "planning"
  | "awaiting_approval"
  | "awaiting_input"
  | "executing"
  | "paused"
  | "stopped_no_action"
  | "done"
  | "error";

export type TurnCompatibilityVisibleStatus =
  | TurnCompatibilityConversationStatus
  | TurnCompletionResultKind;

export interface TurnCompatibilityRuntimeOutcome {
  readonly status: "paused" | "completed";
  readonly checkpointKind?: "paused" | "aborted";
  readonly reason: string;
  readonly resultKind?: TurnCompletionResultKind;
  readonly pauseKind?: TurnRunPauseKind;
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly updatedAt: number;
}

export interface TurnRuntimeCompatibilityProjection {
  readonly agentStatus: TurnCompatibilityAgentStatus;
  readonly conversationTurnStatus: TurnCompatibilityConversationStatus;
  readonly visibleTurnStatus: TurnCompatibilityVisibleStatus;
  readonly isTerminal: boolean;
  readonly resultKind: TurnCompletionResultKind | null;
  readonly runtimeOutcome: TurnCompatibilityRuntimeOutcome | null;
}

function runningConversationStatus(state: CanonicalTurnRuntimeState): TurnCompatibilityConversationStatus {
  if (state.turn.strategy === "plan" && (!state.run || state.run.phase === "planning")) {
    return "planning";
  }
  return "executing";
}

/** Project structured runtime truth into the legacy Store/UI vocabulary. */
export function projectTurnRuntimeCompatibility(
  state: CanonicalTurnRuntimeState,
): TurnRuntimeCompatibilityProjection {
  if (state.turn.status === "completed" && state.turn.resultKind) {
    const resultKind = state.turn.resultKind;
    const conversationTurnStatus: TurnCompatibilityConversationStatus = resultKind === "error"
      ? "error"
      : resultKind === "blocked"
        ? "stopped_no_action"
        : "done";
    return {
      agentStatus: resultKind === "error" ? "error" : "idle",
      conversationTurnStatus,
      visibleTurnStatus: resultKind,
      isTerminal: true,
      resultKind,
      runtimeOutcome: state.run
        ? {
            status: "completed",
            reason: state.turn.completionReason || state.run.completionReason || "turn_completed",
            resultKind,
            runId: state.run.identity.runId,
            parentRunId: state.run.identity.parentRunId,
            updatedAt: state.lastEventAt,
          }
        : null,
    };
  }

  if (
    state.turn.strategy === "plan" &&
    state.planReviewStatus === "pending" &&
    state.run?.status === "paused" &&
    state.run.pause?.subject === "plan"
  ) {
    return {
      agentStatus: "pending_review",
      conversationTurnStatus: "awaiting_approval",
      visibleTurnStatus: "awaiting_approval",
      isTerminal: false,
      resultKind: null,
      runtimeOutcome: {
        status: "paused",
        checkpointKind: "paused",
        reason: state.run.pause.reason,
        pauseKind: "approval",
        runId: state.run.identity.runId,
        parentRunId: state.run.identity.parentRunId,
        updatedAt: state.lastEventAt,
      },
    };
  }

  if (state.run?.status === "paused" && state.run.pause) {
    const status: TurnCompatibilityConversationStatus = state.run.pause.kind === "approval"
      ? "awaiting_approval"
      : state.run.pause.kind === "input"
        ? "awaiting_input"
        : "paused";
    return {
      agentStatus: state.run.pause.kind === "approval" ? "pending_review" : "idle",
      conversationTurnStatus: status,
      visibleTurnStatus: status,
      isTerminal: false,
      resultKind: null,
      runtimeOutcome: {
        status: "paused",
        checkpointKind: "paused",
        reason: state.run.pause.reason,
        pauseKind: state.run.pause.kind,
        runId: state.run.identity.runId,
        parentRunId: state.run.identity.parentRunId,
        updatedAt: state.lastEventAt,
      },
    };
  }

  if (state.run?.status === "aborted") {
    return {
      agentStatus: "idle",
      conversationTurnStatus: "paused",
      visibleTurnStatus: "paused",
      isTerminal: false,
      resultKind: null,
      // Compatibility intentionally maps aborted evidence to a paused outcome;
      // only turn.completed(canceled) may project a terminal cancellation.
      runtimeOutcome: {
        status: "paused",
        checkpointKind: "aborted",
        reason: state.run.completionReason || "run_aborted",
        pauseKind: "recoverable",
        runId: state.run.identity.runId,
        parentRunId: state.run.identity.parentRunId,
        updatedAt: state.lastEventAt,
      },
    };
  }

  const conversationTurnStatus = runningConversationStatus(state);
  return {
    agentStatus: "running",
    conversationTurnStatus,
    visibleTurnStatus: conversationTurnStatus,
    isTerminal: false,
    resultKind: null,
    runtimeOutcome: null,
  };
}
