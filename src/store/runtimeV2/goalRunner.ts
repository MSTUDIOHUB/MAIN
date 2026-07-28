import {
  completeRuntimeV2GoalSaga,
  continueRuntimeV2GoalSaga,
  createRuntimeV2GoalSaga,
  decideRuntimeV2GoalSaga,
  recordRuntimeV2GoalBoundary,
  recordRuntimeV2GoalSliceLaunch,
  recordRuntimeV2GoalSliceOutcome,
  RUNTIME_V2_GOAL_SAGA_SCHEMA_VERSION,
  type RuntimeV2EvidenceReference,
  type RuntimeV2GoalOwnerIdentity,
  type RuntimeV2GoalSagaState,
  type RuntimeV2GoalSliceOutcome,
  type RuntimeV2GoalSliceRequest,
} from "../../lib/runtime-v2";
import { resolveGoalBudget } from "../../lib/goalBudget";
import {
  migrateGoalDefinition,
  normalizeGoalCriteria,
  type GoalEvidenceEntry,
  type GoalRuntimeSnapshot,
} from "../../lib/goalState";
import type { GoalContinuationAuthorization } from "../../lib/submit/turnSubmission";

export const RUNTIME_V2_GOAL_SAGA_CHECKPOINT_SCHEMA_VERSION =
  "runtime-v2-goal-saga-checkpoint.v1" as const;

export interface RuntimeV2GoalSagaCheckpoint {
  readonly schemaVersion: typeof RUNTIME_V2_GOAL_SAGA_CHECKPOINT_SCHEMA_VERSION;
  readonly revision: number;
  readonly owner: RuntimeV2GoalOwnerIdentity;
  readonly state: RuntimeV2GoalSagaState;
}

export interface RuntimeV2GoalSagaCheckpointPort {
  load(input: {
    readonly owner: RuntimeV2GoalOwnerIdentity;
  }): Promise<RuntimeV2GoalSagaCheckpoint | null>;
  commit(input: {
    readonly owner: RuntimeV2GoalOwnerIdentity;
    readonly expectedRevision: number;
    readonly state: RuntimeV2GoalSagaState;
  }): Promise<{
    readonly disposition: "committed" | "idempotent" | "conflict";
    readonly checkpoint: RuntimeV2GoalSagaCheckpoint | null;
  }>;
}

export interface RuntimeV2GoalSlicePort {
  /**
   * The implementation must admit this exact request as one ordinary Runtime
   * v2 Execute Turn/Run. The slice id is the idempotency key for cold resume.
   */
  launch(input: {
    readonly request: RuntimeV2GoalSliceRequest;
    readonly signal: AbortSignal;
  }): Promise<void>;
  /**
   * Once request.deadlineAt is reached, the slice owner must drive the Turn to
   * a canonical deadline/cancel outcome before reporting it completed. The
   * saga never fabricates a child Turn terminal or abandons a running slice.
   */
  observe(input: {
    readonly request: RuntimeV2GoalSliceRequest;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly status: "running" }
    | { readonly status: "missing" }
    | { readonly status: "completed"; readonly outcome: RuntimeV2GoalSliceOutcome }
  >;
}

export interface RuntimeV2GoalSagaPorts {
  readonly checkpoint: RuntimeV2GoalSagaCheckpointPort;
  readonly slice: RuntimeV2GoalSlicePort;
}

export type RuntimeV2GoalAdmissionAuthority =
  | {
      readonly kind: "creation";
      readonly authorized: boolean;
    }
  | {
      readonly kind: "legacy_continuation";
      readonly authorization: GoalContinuationAuthorization | null;
    };

export interface RuntimeV2GoalBoundaryInput {
  /** Existing Goal v3 is a read-only migration/admission source. */
  readonly runtime: GoalRuntimeSnapshot;
  readonly admission: {
    readonly workspaceKey: string;
    readonly sessionKey: string;
    readonly sessionEpoch: string;
    readonly ownerTurnId: string;
    readonly authority: RuntimeV2GoalAdmissionAuthority;
  };
  readonly now?: number;
  readonly sliceDurationMs?: number;
  readonly maxRecoveryAttempts?: number;
}

export type RuntimeV2GoalSagaStepResult =
  | {
      readonly disposition: "launched" | "resumed_launch";
      readonly checkpoint: RuntimeV2GoalSagaCheckpoint;
      readonly request: RuntimeV2GoalSliceRequest;
    }
  | {
      readonly disposition: "launch_uncertain";
      readonly checkpoint: RuntimeV2GoalSagaCheckpoint;
      readonly request: RuntimeV2GoalSliceRequest;
      readonly error: string;
    }
  | {
      readonly disposition: "running";
      readonly checkpoint: RuntimeV2GoalSagaCheckpoint;
      readonly request: RuntimeV2GoalSliceRequest;
    }
  | {
      readonly disposition: "slice_settled" | "continued";
      readonly checkpoint: RuntimeV2GoalSagaCheckpoint;
    }
  | {
      readonly disposition: "completed";
      readonly checkpoint: RuntimeV2GoalSagaCheckpoint;
    }
  | {
      readonly disposition: "superseded";
      readonly checkpoint: RuntimeV2GoalSagaCheckpoint | null;
    };

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

function legacyEvidenceKind(
  entry: GoalEvidenceEntry,
): RuntimeV2EvidenceReference["kind"] {
  if (entry.kind === "read") return "source";
  if (entry.kind === "file_change") return "mutation";
  if (
    entry.kind === "test" ||
    entry.kind === "build" ||
    entry.kind === "browser" ||
    entry.kind === "desktop" ||
    entry.kind === "user_validation"
  ) return "validation";
  return "tool";
}

function migrateLegacyEvidence(
  runtime: GoalRuntimeSnapshot,
): RuntimeV2EvidenceReference[] {
  return (runtime.progress.evidence || [])
    .filter((entry) => entry.status !== "failed")
    .slice(-128)
    .map((entry) => ({
      id: entry.id,
      kind: legacyEvidenceKind(entry),
      target: String(entry.target || entry.sourceTool || "legacy-goal-evidence").trim(),
      version: `legacy-goal-evidence:${Math.max(0, Number(entry.createdAt) || 0)}`,
    }));
}

function authorityMatches(input: {
  readonly goal: ReturnType<typeof migrateGoalDefinition>;
  readonly admission: RuntimeV2GoalBoundaryInput["admission"];
}): boolean {
  const { goal, admission } = input;
  if (
    String(goal.ownerTurnId || "").trim() !== admission.ownerTurnId ||
    (
      String(goal.sessionKey || "").trim() &&
      goal.sessionKey !== admission.sessionKey &&
      goal.sessionKey !== admission.workspaceKey
    )
  ) return false;
  if (admission.authority.kind === "creation") {
    return admission.authority.authorized;
  }
  const authorization = admission.authority.authorization;
  return !!authorization &&
    authorization.kind === "goal_continuation_authorization" &&
    authorization.workspaceKey === admission.workspaceKey &&
    authorization.sessionKey === admission.sessionKey &&
    authorization.goalId === goal.id &&
    authorization.goalRevision === (goal.revision || 1);
}

function historicalTerminal(
  runtime: GoalRuntimeSnapshot,
  at: number,
): RuntimeV2GoalSagaState["terminal"] {
  if (runtime.status === "completed") {
    return {
      resultKind: "success",
      reasonCode: "objective_satisfied",
      reason: "Read-only migration of a historically completed Goal.",
      completedAt: at,
    };
  }
  if (runtime.status === "cancelled") {
    return {
      resultKind: "canceled",
      reasonCode: "canceled",
      reason: "Read-only migration of a historically canceled Goal.",
      completedAt: at,
    };
  }
  if (runtime.status === "failed") {
    return {
      resultKind: "error",
      reasonCode: "execution_error",
      reason: runtime.lastError || "Read-only migration of a historically failed Goal.",
      completedAt: at,
    };
  }
  if (runtime.status === "budget_exceeded") {
    return {
      resultKind: "partial",
      reasonCode: "resource_budget_exhausted",
      reason: runtime.pauseReason || runtime.progress.lastStopReason ||
        "Read-only migration of a historically incomplete Goal.",
      completedAt: at,
    };
  }
  return null;
}

/**
 * Translate the existing Goal definition/progress/admission boundary once.
 * Subsequent writes use only RuntimeV2GoalSagaCheckpoint.
 */
export function createRuntimeV2GoalSagaFromBoundary(
  input: RuntimeV2GoalBoundaryInput,
): RuntimeV2GoalSagaState {
  const runtime = input.runtime;
  const goal = migrateGoalDefinition(input.runtime.goal);
  const now = Math.max(0, Number(input.now) || Date.now());
  const criteria = normalizeGoalCriteria(goal).slice(0, 32);
  const evidence = migrateLegacyEvidence(runtime);
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  const criterionEvidence = Object.fromEntries(criteria.map((criterion) => [
    criterion.id,
    criterion.status === "satisfied"
      ? (criterion.evidenceIds || []).filter((id) => evidenceIds.has(id)).slice(-8)
      : [],
  ]));
  const budget = resolveGoalBudget({
    maxIterations: goal.iterationBudget,
    maxTokens: goal.tokenBudget,
    maxToolCalls: goal.toolCallBudget,
    maxDurationMs: goal.maxDurationMs,
  });
  const owner: RuntimeV2GoalOwnerIdentity = {
    workspaceKey: input.admission.workspaceKey,
    sessionKey: input.admission.sessionKey,
    sessionEpoch: input.admission.sessionEpoch,
    goalId: goal.id,
    goalRevision: goal.revision || 1,
    ownerTurnId: input.admission.ownerTurnId,
  };
  const authorityValid = authorityMatches({ goal, admission: input.admission });
  const reviewRequired = goal.migrationReviewRequired || goal.criteriaReviewRequired ||
    criteria.filter((criterion) => criterion.required).length === 0;
  let state = createRuntimeV2GoalSaga({
    owner,
    objective: {
      text: goal.objective,
      constraints: goal.constraints || [],
      acceptanceCriteria: criteria.filter((criterion) => criterion.required).map((criterion) => criterion.text),
    },
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      required: criterion.required,
    })),
    createdAt: Math.max(0, Number(goal.createdAt) || now),
    deadlineAt: (Number(goal.createdAt) || now) + budget.maxDurationMs,
    sliceDurationMs: input.sliceDurationMs,
    maxRecoveryAttempts: input.maxRecoveryAttempts,
    tokenBudget: budget.maxTokens,
    toolCallBudget: budget.maxToolCalls,
    evidence,
    criterionEvidence,
    boundary: !authorityValid || reviewRequired
      ? {
          kind: "authority_lost",
          reason: !authorityValid
            ? "Goal admission authority does not match the persisted owner."
            : "Goal acceptance authority requires explicit review before execution.",
          at: now,
        }
      : null,
  });
  const terminal = historicalTerminal(runtime, now);
  if (terminal) state = completeRuntimeV2GoalSaga(state, terminal);
  return state;
}

export function serializeRuntimeV2GoalSagaCheckpoint(
  checkpoint: RuntimeV2GoalSagaCheckpoint,
): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

function hasValidGoalSagaStateShape(
  state: RuntimeV2GoalSagaState,
  owner: RuntimeV2GoalOwnerIdentity,
): boolean {
  const validStatus = state.status === "ready" ||
    state.status === "slice_running" ||
    state.status === "slice_settled" ||
    state.status === "completed";
  const activeIdentityValid = !state.activeSlice || (
    sameOwner(state.activeSlice.goal, owner) &&
    state.activeSlice.turn.turnId === state.activeSlice.run.turnId &&
    state.activeSlice.turn.sessionKey === owner.sessionKey &&
    state.activeSlice.turn.sessionEpoch === owner.sessionEpoch
  );
  const statusShapeValid =
    (
      state.status === "ready" &&
      !state.activeSlice &&
      !state.settledSlice &&
      !state.terminal
    ) ||
    (
      state.status === "slice_running" &&
      !!state.activeSlice &&
      !state.settledSlice &&
      !state.terminal
    ) ||
    (
      state.status === "slice_settled" &&
      !state.activeSlice &&
      !!state.settledSlice &&
      !state.terminal
    ) ||
    (
      state.status === "completed" &&
      !state.activeSlice &&
      !state.settledSlice &&
      !!state.terminal
    );
  return validStatus &&
    sameOwner(state.owner, owner) &&
    activeIdentityValid &&
    statusShapeValid &&
    Number.isInteger(state.nextSliceOrdinal) &&
    state.nextSliceOrdinal >= 1 &&
    Number.isInteger(state.totalSlices) &&
    state.totalSlices >= 0 &&
    Number.isFinite(state.deadlineAt) &&
    state.deadlineAt > state.createdAt &&
    !!state.resourceBudget &&
    !!state.usage &&
    Number.isFinite(state.usage.tokensUsed) &&
    state.usage.tokensUsed >= 0 &&
    Number.isFinite(state.usage.toolCalls) &&
    state.usage.toolCalls >= 0 &&
    state.criteria.length <= 32 &&
    state.evidence.length <= 128 &&
    state.recentSlices.length <= 12;
}

export function normalizeRuntimeV2GoalSagaCheckpoint(
  value: unknown,
  expectedOwner: RuntimeV2GoalOwnerIdentity,
): RuntimeV2GoalSagaCheckpoint | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RuntimeV2GoalSagaCheckpoint>;
  if (
    candidate.schemaVersion !== RUNTIME_V2_GOAL_SAGA_CHECKPOINT_SCHEMA_VERSION ||
    !candidate.owner ||
    !candidate.state ||
    candidate.state.schemaVersion !== RUNTIME_V2_GOAL_SAGA_SCHEMA_VERSION ||
    !sameOwner(candidate.owner, expectedOwner) ||
    !hasValidGoalSagaStateShape(candidate.state, expectedOwner) ||
    !Number.isInteger(candidate.revision) ||
    Number(candidate.revision) < 1
  ) return null;
  return candidate as RuntimeV2GoalSagaCheckpoint;
}

export function deserializeRuntimeV2GoalSagaCheckpoint(
  source: string,
  expectedOwner: RuntimeV2GoalOwnerIdentity,
): RuntimeV2GoalSagaCheckpoint | null {
  try {
    return normalizeRuntimeV2GoalSagaCheckpoint(JSON.parse(source), expectedOwner);
  } catch {
    return null;
  }
}

async function commitState(input: {
  readonly port: RuntimeV2GoalSagaCheckpointPort;
  readonly checkpoint: RuntimeV2GoalSagaCheckpoint;
  readonly state: RuntimeV2GoalSagaState;
}): Promise<RuntimeV2GoalSagaCheckpoint | null> {
  const committed = await input.port.commit({
    owner: input.checkpoint.owner,
    expectedRevision: input.checkpoint.revision,
    state: input.state,
  });
  return committed.disposition === "conflict" ? null : committed.checkpoint;
}

export async function driveRuntimeV2GoalSagaOnce(input: {
  readonly ports: RuntimeV2GoalSagaPorts;
  readonly owner: RuntimeV2GoalOwnerIdentity;
  readonly initialState?: RuntimeV2GoalSagaState;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}): Promise<RuntimeV2GoalSagaStepResult> {
  const now = input.now || Date.now;
  let checkpoint = await input.ports.checkpoint.load({ owner: input.owner });
  if (!checkpoint) {
    if (!input.initialState || !sameOwner(input.initialState.owner, input.owner)) {
      throw new Error("RUNTIME_V2_GOAL_CHECKPOINT_MISSING");
    }
    const created = await input.ports.checkpoint.commit({
      owner: input.owner,
      expectedRevision: 0,
      state: input.initialState,
    });
    if (created.disposition === "conflict" || !created.checkpoint) {
      return { disposition: "superseded", checkpoint: created.checkpoint };
    }
    checkpoint = created.checkpoint;
  }

  let state = checkpoint.state;
  if (input.signal.aborted && !state.terminal && !state.boundary) {
    const canceled = recordRuntimeV2GoalBoundary(state, {
      kind: "cancel_requested",
      reason: "Goal execution was canceled by its admitted owner.",
      at: now(),
    });
    const committed = await commitState({
      port: input.ports.checkpoint,
      checkpoint,
      state: canceled,
    });
    if (!committed) return { disposition: "superseded", checkpoint: null };
    checkpoint = committed;
    state = committed.state;
  }

  const decision = decideRuntimeV2GoalSaga(state, now());
  if (decision.kind === "none") {
    return { disposition: "completed", checkpoint };
  }
  if (decision.kind === "complete_goal") {
    const completed = completeRuntimeV2GoalSaga(state, decision.outcome);
    const committed = await commitState({
      port: input.ports.checkpoint,
      checkpoint,
      state: completed,
    });
    return committed
      ? { disposition: "completed", checkpoint: committed }
      : { disposition: "superseded", checkpoint: null };
  }
  if (decision.kind === "continue_goal") {
    const continued = continueRuntimeV2GoalSaga(
      state,
      decision.fromSliceId,
      now(),
    );
    const committed = await commitState({
      port: input.ports.checkpoint,
      checkpoint,
      state: continued,
    });
    return committed
      ? { disposition: "continued", checkpoint: committed }
      : { disposition: "superseded", checkpoint: null };
  }
  if (decision.kind === "launch_slice") {
    const scheduled = recordRuntimeV2GoalSliceLaunch(state, decision.request, now());
    const committed = await commitState({
      port: input.ports.checkpoint,
      checkpoint,
      state: scheduled,
    });
    if (!committed) return { disposition: "superseded", checkpoint: null };
    try {
      await input.ports.slice.launch({ request: decision.request, signal: input.signal });
      return { disposition: "launched", checkpoint: committed, request: decision.request };
    } catch (error) {
      // The durable activeSlice is the recovery fence. The next drive observes
      // the exact Turn before invoking the idempotent launch again.
      return {
        disposition: "launch_uncertain",
        checkpoint: committed,
        request: decision.request,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const observed = await input.ports.slice.observe({
    request: decision.request,
    signal: input.signal,
  });
  if (observed.status === "running") {
    return { disposition: "running", checkpoint, request: decision.request };
  }
  if (observed.status === "missing") {
    try {
      await input.ports.slice.launch({ request: decision.request, signal: input.signal });
      return {
        disposition: "resumed_launch",
        checkpoint,
        request: decision.request,
      };
    } catch (error) {
      return {
        disposition: "launch_uncertain",
        checkpoint,
        request: decision.request,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const settled = recordRuntimeV2GoalSliceOutcome(state, observed.outcome);
  const committed = await commitState({
    port: input.ports.checkpoint,
    checkpoint,
    state: settled,
  });
  return committed
    ? { disposition: "slice_settled", checkpoint: committed }
    : { disposition: "superseded", checkpoint: null };
}
