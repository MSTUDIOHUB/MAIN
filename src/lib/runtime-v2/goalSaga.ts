import type {
  RuntimeV2EvidenceReference,
  RuntimeV2Objective,
  RuntimeV2ResultKind,
  RuntimeV2RunIdentity,
  RuntimeV2TurnIdentity,
} from "./contracts";

export const RUNTIME_V2_GOAL_SAGA_SCHEMA_VERSION =
  "runtime-v2-goal-saga.v1" as const;

export type RuntimeV2GoalSagaStatus =
  | "ready"
  | "slice_running"
  | "slice_settled"
  | "completed";

export interface RuntimeV2GoalOwnerIdentity {
  readonly workspaceKey: string;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly goalId: string;
  readonly goalRevision: number;
  readonly ownerTurnId: string;
}

export interface RuntimeV2GoalCriterion {
  readonly id: string;
  readonly text: string;
  readonly required: boolean;
}

export type RuntimeV2GoalBoundaryKind =
  | "cancel_requested"
  | "authority_lost"
  | "deadline_exceeded"
  | "resource_budget_exhausted";

export interface RuntimeV2GoalBoundarySignal {
  readonly kind: RuntimeV2GoalBoundaryKind;
  readonly reason: string;
  readonly at: number;
}

export type RuntimeV2GoalSliceReasonCode =
  | "objective_satisfied"
  | "slice_boundary"
  | "validation_incomplete"
  | "execution_error"
  | "external_blocked"
  | "deadline_exceeded"
  | "authority_lost"
  | "canceled"
  | "recovery_exhausted";

export interface RuntimeV2GoalAcceptanceReceipt {
  readonly criterionId: string;
  readonly status: "satisfied" | "invalidated";
  readonly evidenceIds: readonly string[];
}

export interface RuntimeV2GoalSliceOutcome {
  readonly outcomeId: string;
  readonly sliceId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly resultKind: RuntimeV2ResultKind;
  readonly reasonCode: RuntimeV2GoalSliceReasonCode;
  readonly reason: string;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly acceptance: readonly RuntimeV2GoalAcceptanceReceipt[];
  /** A structural action/diagnostic key, never generated prose. */
  readonly recoveryFingerprint: string;
  readonly recoverable: boolean;
  readonly usage?: {
    readonly tokensUsed: number;
    readonly toolCalls: number;
  };
  readonly completedAt: number;
}

export interface RuntimeV2GoalSliceRequest {
  readonly sliceId: string;
  readonly ordinal: number;
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly strategy: "execute";
  readonly objective: RuntimeV2Objective;
  readonly criteria: readonly RuntimeV2GoalCriterion[];
  readonly goal: RuntimeV2GoalOwnerIdentity;
  readonly priorEvidence: readonly RuntimeV2EvidenceReference[];
  readonly deadlineAt: number;
  readonly goalDeadlineAt: number;
}

/** Preserve the parent Goal's stable criterion identity at the Execute
 * admission boundary. The slice prompt is presentation context; it must not
 * replace criterion ids with anonymous synthesized text. */
export function runtimeV2GoalSliceExecuteAdmission(
  request: RuntimeV2GoalSliceRequest,
): {
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly text: string;
  }[];
} {
  return {
    objective: request.objective.text,
    constraints: request.objective.constraints,
    acceptanceCriteria: request.criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
    })),
  };
}

export interface RuntimeV2GoalSliceReceipt {
  readonly request: RuntimeV2GoalSliceRequest;
  readonly outcomeId: string;
  readonly resultKind: RuntimeV2ResultKind;
  readonly reasonCode: RuntimeV2GoalSliceReasonCode;
  readonly reason: string;
  readonly completedAt: number;
  readonly meaningfulProgress: boolean;
  readonly recoverable: boolean;
}

export interface RuntimeV2GoalSagaTerminal {
  readonly resultKind: RuntimeV2ResultKind;
  readonly reasonCode: RuntimeV2GoalBoundaryKind | RuntimeV2GoalSliceReasonCode;
  readonly reason: string;
  readonly completedAt: number;
}

export interface RuntimeV2GoalSagaState {
  readonly schemaVersion: typeof RUNTIME_V2_GOAL_SAGA_SCHEMA_VERSION;
  readonly owner: RuntimeV2GoalOwnerIdentity;
  readonly objective: RuntimeV2Objective;
  readonly criteria: readonly RuntimeV2GoalCriterion[];
  readonly status: RuntimeV2GoalSagaStatus;
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly sliceDurationMs: number;
  /**
   * Legacy checkpoint field. Kept so v1 Goal checkpoints remain readable;
   * repeated diagnostics are pressure signals and never terminal authority.
   */
  readonly maxRecoveryAttempts: number;
  readonly resourceBudget: {
    readonly tokenLimit: number | null;
    readonly toolCallLimit: number | null;
  };
  readonly usage: {
    readonly tokensUsed: number;
    readonly toolCalls: number;
  };
  readonly nextSliceOrdinal: number;
  readonly totalSlices: number;
  readonly activeSlice: RuntimeV2GoalSliceRequest | null;
  readonly settledSlice: RuntimeV2GoalSliceReceipt | null;
  /** Bounded diagnostic history. Each Turn retains its own full v2 ledger. */
  readonly recentSlices: readonly RuntimeV2GoalSliceReceipt[];
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly criterionEvidence: Readonly<Record<string, readonly string[]>>;
  readonly recovery: {
    readonly fingerprint: string | null;
    readonly count: number;
    readonly exhausted: boolean;
  };
  readonly boundary: RuntimeV2GoalBoundarySignal | null;
  readonly terminal: RuntimeV2GoalSagaTerminal | null;
  readonly updatedAt: number;
}

export type RuntimeV2GoalSagaDecision =
  | { readonly kind: "launch_slice"; readonly request: RuntimeV2GoalSliceRequest }
  | { readonly kind: "observe_slice"; readonly request: RuntimeV2GoalSliceRequest }
  | { readonly kind: "continue_goal"; readonly fromSliceId: string; readonly reason: string }
  | { readonly kind: "complete_goal"; readonly outcome: RuntimeV2GoalSagaTerminal }
  | { readonly kind: "none"; readonly outcome: RuntimeV2GoalSagaTerminal };

const MAX_CRITERIA = 32;
const MAX_EVIDENCE = 128;
const MAX_RECENT_SLICES = 12;
const MAX_EVIDENCE_PER_CRITERION = 8;

function nonEmpty(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`RUNTIME_V2_GOAL_INVALID_${field.toUpperCase()}`);
  return normalized;
}

function clampPositiveInt(value: number, min: number, max: number): number {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized < min) return min;
  return Math.min(max, normalized);
}

function sameOwner(
  left: RuntimeV2GoalOwnerIdentity,
  right: RuntimeV2GoalOwnerIdentity,
): boolean {
  return left.workspaceKey === right.workspaceKey &&
    left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.goalId === right.goalId &&
    left.goalRevision === right.goalRevision &&
    left.ownerTurnId === right.ownerTurnId;
}

function evidenceKey(evidence: RuntimeV2EvidenceReference): string {
  return [
    evidence.id,
    evidence.kind,
    evidence.target,
    evidence.version || "",
  ].join("\u0000");
}

function boundedEvidence(
  evidence: readonly RuntimeV2EvidenceReference[],
  criterionEvidence: Readonly<Record<string, readonly string[]>>,
): readonly RuntimeV2EvidenceReference[] {
  const deduped = new Map<string, RuntimeV2EvidenceReference>();
  for (const item of evidence) deduped.set(evidenceKey(item), item);
  const values = [...deduped.values()];
  if (values.length <= MAX_EVIDENCE) return values;
  const retainedIds = new Set(Object.values(criterionEvidence).flat());
  const retained = values.filter((item) => retainedIds.has(item.id));
  const recent = values
    .filter((item) => !retainedIds.has(item.id))
    .slice(-Math.max(0, MAX_EVIDENCE - retained.length));
  return [...retained.slice(-MAX_EVIDENCE), ...recent].slice(-MAX_EVIDENCE);
}

function requiredCriteriaSatisfied(state: RuntimeV2GoalSagaState): boolean {
  const required = state.criteria.filter((criterion) => criterion.required);
  return required.length > 0 &&
    required.every((criterion) => (state.criterionEvidence[criterion.id] || []).length > 0);
}

function sliceIdentityMatches(
  request: RuntimeV2GoalSliceRequest,
  outcome: RuntimeV2GoalSliceOutcome,
): boolean {
  return request.sliceId === outcome.sliceId &&
    request.turn.turnId === outcome.turnId &&
    request.run.runId === outcome.runId;
}

function terminalForBoundary(
  state: RuntimeV2GoalSagaState,
  boundary: RuntimeV2GoalBoundarySignal,
): RuntimeV2GoalSagaTerminal {
  const hasEvidence = state.evidence.length > 0;
  const resultKind: RuntimeV2ResultKind =
    boundary.kind === "cancel_requested" ? "canceled"
      : boundary.kind === "authority_lost" ? "blocked"
        : boundary.kind === "deadline_exceeded" ? "partial"
          : boundary.kind === "resource_budget_exhausted" ? "partial"
          : hasEvidence ? "partial" : "error";
  return {
    resultKind,
    reasonCode: boundary.kind,
    reason: boundary.reason,
    completedAt: boundary.at,
  };
}

function terminalForSettledSlice(
  state: RuntimeV2GoalSagaState,
  receipt: RuntimeV2GoalSliceReceipt,
): RuntimeV2GoalSagaTerminal | null {
  if (receipt.reasonCode === "canceled" || receipt.resultKind === "canceled") {
    return {
      resultKind: "canceled",
      reasonCode: "canceled",
      reason: receipt.reason,
      completedAt: receipt.completedAt,
    };
  }
  if (receipt.reasonCode === "authority_lost") {
    return {
      resultKind: "blocked",
      reasonCode: receipt.reasonCode,
      reason: receipt.reason,
      completedAt: receipt.completedAt,
    };
  }
  if (receipt.reasonCode === "deadline_exceeded") {
    return {
      resultKind: "partial",
      reasonCode: receipt.reasonCode,
      reason: receipt.reason,
      completedAt: receipt.completedAt,
    };
  }
  if (receipt.reasonCode === "external_blocked" || receipt.resultKind === "blocked") {
    return {
      resultKind: "blocked",
      reasonCode: receipt.reasonCode,
      reason: receipt.reason,
      completedAt: receipt.completedAt,
    };
  }
  if (receipt.resultKind === "success" && requiredCriteriaSatisfied(state)) {
    return {
      resultKind: "success",
      reasonCode: "objective_satisfied",
      reason: receipt.reason,
      completedAt: receipt.completedAt,
    };
  }
  if (
    receipt.reasonCode !== "recovery_exhausted" &&
    receipt.resultKind === "error" &&
    !receipt.recoverable
  ) {
    return {
      resultKind: "error",
      reasonCode: receipt.reasonCode,
      reason: receipt.reason,
      completedAt: receipt.completedAt,
    };
  }
  return null;
}

export function createRuntimeV2GoalSaga(input: {
  readonly owner: RuntimeV2GoalOwnerIdentity;
  readonly objective: RuntimeV2Objective;
  readonly criteria: readonly RuntimeV2GoalCriterion[];
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly sliceDurationMs?: number;
  readonly maxRecoveryAttempts?: number;
  readonly tokenBudget?: number;
  readonly toolCallBudget?: number;
  readonly evidence?: readonly RuntimeV2EvidenceReference[];
  readonly criterionEvidence?: Readonly<Record<string, readonly string[]>>;
  readonly boundary?: RuntimeV2GoalBoundarySignal | null;
}): RuntimeV2GoalSagaState {
  const owner: RuntimeV2GoalOwnerIdentity = {
    workspaceKey: nonEmpty(input.owner.workspaceKey, "workspace"),
    sessionKey: nonEmpty(input.owner.sessionKey, "session"),
    sessionEpoch: nonEmpty(input.owner.sessionEpoch, "session_epoch"),
    goalId: nonEmpty(input.owner.goalId, "goal_id"),
    goalRevision: clampPositiveInt(input.owner.goalRevision, 1, Number.MAX_SAFE_INTEGER),
    ownerTurnId: nonEmpty(input.owner.ownerTurnId, "owner_turn"),
  };
  const criteria = input.criteria
    .slice(0, MAX_CRITERIA)
    .map((criterion) => ({
      id: nonEmpty(criterion.id, "criterion_id"),
      text: nonEmpty(criterion.text, "criterion_text").slice(0, 2_000),
      required: criterion.required === true,
    }));
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
    throw new Error("RUNTIME_V2_GOAL_DUPLICATE_CRITERION");
  }
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const initialCriterionEvidence = Object.fromEntries(
    Object.entries(input.criterionEvidence || {})
      .filter(([criterionId]) => criterionIds.has(criterionId))
      .map(([criterionId, evidenceIds]) => [
        criterionId,
        [...new Set(evidenceIds.map(String).filter(Boolean))].slice(-MAX_EVIDENCE_PER_CRITERION),
      ]),
  );
  const createdAt = Math.max(0, Number(input.createdAt) || 0);
  const deadlineAt = Math.max(createdAt + 1, Number(input.deadlineAt) || createdAt + 1);
  return {
    schemaVersion: RUNTIME_V2_GOAL_SAGA_SCHEMA_VERSION,
    owner,
    objective: {
      text: nonEmpty(input.objective.text, "objective").slice(0, 12_000),
      constraints: input.objective.constraints.map(String).filter(Boolean).slice(0, 32),
      acceptanceCriteria: criteria.filter((criterion) => criterion.required).map((criterion) => criterion.text),
    },
    criteria,
    status: "ready",
    createdAt,
    deadlineAt,
    sliceDurationMs: clampPositiveInt(input.sliceDurationMs || 12 * 60_000, 30_000, 30 * 60_000),
    maxRecoveryAttempts: clampPositiveInt(input.maxRecoveryAttempts || 2, 1, 8),
    resourceBudget: {
      tokenLimit: Number.isFinite(input.tokenBudget) && Number(input.tokenBudget) > 0
        ? Math.floor(Number(input.tokenBudget))
        : null,
      toolCallLimit: Number.isFinite(input.toolCallBudget) && Number(input.toolCallBudget) > 0
        ? Math.floor(Number(input.toolCallBudget))
        : null,
    },
    usage: { tokensUsed: 0, toolCalls: 0 },
    nextSliceOrdinal: 1,
    totalSlices: 0,
    activeSlice: null,
    settledSlice: null,
    recentSlices: [],
    evidence: boundedEvidence(input.evidence || [], initialCriterionEvidence),
    criterionEvidence: initialCriterionEvidence,
    recovery: { fingerprint: null, count: 0, exhausted: false },
    boundary: input.boundary || null,
    terminal: null,
    updatedAt: createdAt,
  };
}

export function buildRuntimeV2GoalSliceRequest(
  state: RuntimeV2GoalSagaState,
  now: number,
): RuntimeV2GoalSliceRequest {
  if (state.status !== "ready" || state.activeSlice || state.settledSlice || state.terminal) {
    throw new Error("RUNTIME_V2_GOAL_NOT_READY_FOR_SLICE");
  }
  const ordinal = state.nextSliceOrdinal;
  const base = `${state.owner.goalId}:v${state.owner.goalRevision}:slice:${ordinal}`;
  const turnId = `${state.owner.ownerTurnId}:goal-slice:${state.owner.goalRevision}:${ordinal}`;
  const runId = `${turnId}:run`;
  const pendingCriteria = state.criteria
    .filter((criterion) => criterion.required && !(state.criterionEvidence[criterion.id] || []).length);
  return {
    sliceId: base,
    ordinal,
    turn: {
      workspaceKey: state.owner.workspaceKey,
      sessionKey: state.owner.sessionKey,
      sessionEpoch: state.owner.sessionEpoch,
      clientSubmissionId: `${base}:submission`,
      turnId,
    },
    run: {
      sessionKey: state.owner.sessionKey,
      sessionEpoch: state.owner.sessionEpoch,
      turnId,
      runId,
      parentRunId: null,
      attemptId: `${runId}:attempt:1`,
    },
    strategy: "execute",
    objective: {
      ...state.objective,
      acceptanceCriteria: pendingCriteria.map((criterion) => criterion.text),
    },
    criteria: pendingCriteria,
    goal: state.owner,
    priorEvidence: state.evidence,
    deadlineAt: Math.min(state.deadlineAt, Math.max(now + 1, now + state.sliceDurationMs)),
    goalDeadlineAt: state.deadlineAt,
  };
}

export function recordRuntimeV2GoalBoundary(
  state: RuntimeV2GoalSagaState,
  signal: RuntimeV2GoalBoundarySignal,
): RuntimeV2GoalSagaState {
  if (state.terminal) return state;
  return {
    ...state,
    boundary: {
      ...signal,
      reason: nonEmpty(signal.reason, "boundary_reason").slice(0, 2_000),
      at: Math.max(state.updatedAt, Number(signal.at) || state.updatedAt),
    },
    updatedAt: Math.max(state.updatedAt, Number(signal.at) || state.updatedAt),
  };
}

export function recordRuntimeV2GoalSliceLaunch(
  state: RuntimeV2GoalSagaState,
  request: RuntimeV2GoalSliceRequest,
  at: number,
): RuntimeV2GoalSagaState {
  if (state.boundary || at >= state.deadlineAt) {
    throw new Error("RUNTIME_V2_GOAL_SLICE_LAUNCH_AFTER_BOUNDARY");
  }
  const expected = buildRuntimeV2GoalSliceRequest(state, at);
  if (
    request.sliceId !== expected.sliceId ||
    request.turn.turnId !== expected.turn.turnId ||
    request.run.runId !== expected.run.runId ||
    !sameOwner(request.goal, state.owner)
  ) {
    throw new Error("RUNTIME_V2_GOAL_SLICE_IDENTITY_MISMATCH");
  }
  return {
    ...state,
    status: "slice_running",
    activeSlice: request,
    updatedAt: Math.max(state.updatedAt, at),
  };
}

export function recordRuntimeV2GoalSliceOutcome(
  state: RuntimeV2GoalSagaState,
  outcome: RuntimeV2GoalSliceOutcome,
): RuntimeV2GoalSagaState {
  const prior = state.recentSlices.find((receipt) => receipt.request.sliceId === outcome.sliceId);
  if (prior) {
    if (prior.outcomeId === outcome.outcomeId) return state;
    throw new Error("RUNTIME_V2_GOAL_SLICE_DUPLICATE_CONFLICT");
  }
  const request = state.activeSlice;
  if (!request || state.status !== "slice_running" || !sliceIdentityMatches(request, outcome)) {
    throw new Error("RUNTIME_V2_GOAL_STALE_SLICE_OUTCOME");
  }
  const oldEvidenceKeys = new Set(state.evidence.map(evidenceKey));
  const mergedEvidence = [...state.evidence, ...outcome.evidence];
  const mergedEvidenceIds = new Set(mergedEvidence.map((item) => item.id));
  const criterionEvidence: Record<string, readonly string[]> = { ...state.criterionEvidence };
  let newlySatisfied = false;
  for (const acceptance of outcome.acceptance) {
    if (!state.criteria.some((criterion) => criterion.id === acceptance.criterionId)) continue;
    if (acceptance.status === "invalidated") {
      criterionEvidence[acceptance.criterionId] = [];
      continue;
    }
    const validIds = [...new Set(acceptance.evidenceIds)]
      .filter((id) => mergedEvidenceIds.has(id))
      .slice(-MAX_EVIDENCE_PER_CRITERION);
    if (validIds.length > 0 && !(criterionEvidence[acceptance.criterionId] || []).length) {
      newlySatisfied = true;
    }
    criterionEvidence[acceptance.criterionId] = validIds;
  }
  const newEvidence = outcome.evidence.some((item) => !oldEvidenceKeys.has(evidenceKey(item)));
  const meaningfulProgress = newEvidence || newlySatisfied;
  const fingerprint = nonEmpty(
    outcome.recoveryFingerprint || `${outcome.resultKind}:${outcome.reasonCode}`,
    "recovery_fingerprint",
  ).slice(0, 500);
  const recoveryCount = meaningfulProgress
    ? 0
    : state.recovery.fingerprint === fingerprint
      ? state.recovery.count + 1
      : 1;
  const receipt: RuntimeV2GoalSliceReceipt = {
    request,
    outcomeId: nonEmpty(outcome.outcomeId, "outcome_id"),
    resultKind: outcome.resultKind,
    reasonCode: outcome.reasonCode,
    reason: nonEmpty(outcome.reason, "slice_reason").slice(0, 2_000),
    completedAt: Math.max(state.updatedAt, outcome.completedAt),
    meaningfulProgress,
    recoverable: outcome.recoverable,
  };
  return {
    ...state,
    status: "slice_settled",
    activeSlice: null,
    settledSlice: receipt,
    recentSlices: [...state.recentSlices, receipt].slice(-MAX_RECENT_SLICES),
    totalSlices: state.totalSlices + 1,
    evidence: boundedEvidence(mergedEvidence, criterionEvidence),
    criterionEvidence,
    recovery: meaningfulProgress
      ? { fingerprint: null, count: 0, exhausted: false }
      : { fingerprint, count: recoveryCount, exhausted: false },
    usage: {
      tokensUsed: state.usage.tokensUsed +
        Math.max(0, Math.floor(Number(outcome.usage?.tokensUsed) || 0)),
      toolCalls: state.usage.toolCalls +
        Math.max(0, Math.floor(Number(outcome.usage?.toolCalls) || 0)),
    },
    updatedAt: receipt.completedAt,
  };
}

export function continueRuntimeV2GoalSaga(
  state: RuntimeV2GoalSagaState,
  fromSliceId: string,
  at: number,
): RuntimeV2GoalSagaState {
  if (
    state.status !== "slice_settled" ||
    !state.settledSlice ||
    state.settledSlice.request.sliceId !== fromSliceId ||
    state.terminal
  ) {
    throw new Error("RUNTIME_V2_GOAL_CONTINUATION_IDENTITY_MISMATCH");
  }
  return {
    ...state,
    status: "ready",
    settledSlice: null,
    nextSliceOrdinal: state.nextSliceOrdinal + 1,
    updatedAt: Math.max(state.updatedAt, at),
  };
}

export function completeRuntimeV2GoalSaga(
  state: RuntimeV2GoalSagaState,
  outcome: RuntimeV2GoalSagaTerminal,
): RuntimeV2GoalSagaState {
  if (state.terminal) {
    if (
      state.terminal.resultKind === outcome.resultKind &&
      state.terminal.reasonCode === outcome.reasonCode
    ) return state;
    throw new Error("RUNTIME_V2_GOAL_TERMINAL_CONFLICT");
  }
  return {
    ...state,
    status: "completed",
    activeSlice: null,
    settledSlice: null,
    terminal: outcome,
    updatedAt: Math.max(state.updatedAt, outcome.completedAt),
  };
}

export function decideRuntimeV2GoalSaga(
  state: RuntimeV2GoalSagaState,
  now: number,
): RuntimeV2GoalSagaDecision {
  if (state.terminal) return { kind: "none", outcome: state.terminal };
  // A Goal cannot outlive an unresolved child Turn. Cancellation/deadline is
  // first delivered through that slice's ordinary v2 terminal contract; only
  // then may the saga publish its own conclusion.
  if (state.status === "slice_running" && state.activeSlice) {
    return { kind: "observe_slice", request: state.activeSlice };
  }
  const settledTerminal = state.status === "slice_settled" && state.settledSlice
    ? terminalForSettledSlice(state, state.settledSlice)
    : null;
  if (state.boundary) {
    if (
      settledTerminal &&
      state.settledSlice &&
      state.settledSlice.completedAt <= state.boundary.at
    ) {
      return { kind: "complete_goal", outcome: settledTerminal };
    }
    return { kind: "complete_goal", outcome: terminalForBoundary(state, state.boundary) };
  }
  if (settledTerminal) {
    return { kind: "complete_goal", outcome: settledTerminal };
  }
  if (now >= state.deadlineAt) {
    return {
      kind: "complete_goal",
      outcome: terminalForBoundary(state, {
        kind: "deadline_exceeded",
        reason: "Goal execution deadline reached; committed slice evidence is preserved.",
        at: now,
      }),
    };
  }
  if (
    (
      state.resourceBudget.tokenLimit != null &&
      state.usage.tokensUsed >= state.resourceBudget.tokenLimit
    ) ||
    (
      state.resourceBudget.toolCallLimit != null &&
      state.usage.toolCalls >= state.resourceBudget.toolCallLimit
    )
  ) {
    return {
      kind: "complete_goal",
      outcome: terminalForBoundary(state, {
        kind: "resource_budget_exhausted",
        reason: "Goal resource authority is exhausted; committed slice evidence is preserved.",
        at: now,
      }),
    };
  }
  if (state.status === "slice_settled" && state.settledSlice) {
    return {
      kind: "continue_goal",
      fromSliceId: state.settledSlice.request.sliceId,
      reason: state.settledSlice.meaningfulProgress
        ? "New structured evidence remains available for the next bounded slice."
        : "The recoverable slice outcome has remaining diagnostic capacity.",
    };
  }
  return { kind: "launch_slice", request: buildRuntimeV2GoalSliceRequest(state, now) };
}
