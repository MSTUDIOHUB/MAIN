import type { RuntimeV2RunState, TurnAggregateV1 } from "./aggregate";
import {
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  type RuntimeV2Command, type RuntimeV2CommandReceipt,
  type RuntimeV2EvidenceReference, type RuntimeV2Phase,
  type RuntimeV2RunIdentity, type RuntimeV2TerminalOutcome,
  type RuntimeV2TurnIdentity, type RuntimeV2WorkPlanReference,
} from "./contracts";
import type { RuntimeV2Event } from "./events";
import {
  canOpenRuntimeV2RecoveryEpoch, canRecordRuntimeV2Recovery,
  emptyRuntimeV2RecoveryBudget, exhaustRuntimeV2Recovery,
  openRuntimeV2RecoveryEpoch, recordRuntimeV2Recovery,
  runtimeV2ActionFingerprint,
} from "./recovery";
import { MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS, applyRuntimeV2SubagentTelemetry } from "./subagents";
import { validateRuntimeV2SubagentReport } from "./subagentReport";
import { validateRuntimeV2SubagentValidationReceipts } from "./validationReceipt";
import {
  hasNovelRuntimeV2Evidence,
  hasMatchingRuntimeV2SealedPlanAuthority,
  isValidRuntimeV2ExecutionContractCommit,
  isValidRuntimeV2SubagentJob,
} from "./reducerGuards";
export type RuntimeV2TransitionRejection =
  | "initial_event_required"
  | "invalid_event_schema"
  | "invalid_event_sequence"
  | "event_sequence_gap"
  | "event_sequence_conflict"
  | "event_time_regression"
  | "turn_identity_mismatch"
  | "run_identity_mismatch"
  | "run_already_started"
  | "run_not_started"
  | "run_not_active"
  | "turn_already_completed"
  | "phase_invalid"
  | "plan_strategy_required"
  | "plan_review_required"
  | "plan_identity_mismatch"
  | "execution_contract_invalid"
  | "command_identity_mismatch"
  | "command_already_scheduled"
  | "command_already_completed"
  | "command_not_scheduled"
  | "command_kind_mismatch"
  | "recovery_evidence_required"
  | "recovery_evidence_not_novel"
  | "recovery_limit_exceeded"
  | "recovery_already_exhausted"
  | "subagent_invalid"
  | "subagent_scope_conflict"
  | "subagent_not_found"
  | "subagent_telemetry_invalid"
  | "run_already_aborted"
  | "canceled_requires_abort"
  | "abort_requires_canceled"
  | "success_requires_finalizing"
  | "terminal_outcome_mismatch"
  | "final_projection_missing"
  | "final_projection_mismatch";

export type RuntimeV2TransitionResult =
  | {
      readonly disposition: "applied" | "idempotent";
      readonly state: TurnAggregateV1;
    }
  | {
      readonly disposition: "rejected";
      readonly state: TurnAggregateV1 | null;
      readonly reason: RuntimeV2TransitionRejection;
    };

const PHASE_TRANSITIONS: Readonly<Record<Exclude<RuntimeV2Phase, "completed">, readonly RuntimeV2Phase[]>> = {
  preparing: ["observing", "planning", "acting", "finalizing"],
  observing: ["planning", "acting", "finalizing"],
  planning: ["reviewing", "acting", "finalizing"],
  reviewing: ["planning", "acting", "finalizing"],
  acting: ["observing", "validating", "finalizing"],
  validating: ["acting", "finalizing"],
  finalizing: [],
};

function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value === value.trim(); }
function isFiniteTimestamp(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

function isSameTurn(left: RuntimeV2TurnIdentity, right: RuntimeV2TurnIdentity): boolean {
  return left.workspaceKey === right.workspaceKey &&
    left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.clientSubmissionId === right.clientSubmissionId &&
    left.turnId === right.turnId;
}

function isSameRun(left: RuntimeV2RunIdentity, right: RuntimeV2RunIdentity): boolean {
  return left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.parentRunId === right.parentRunId &&
    left.attemptId === right.attemptId;
}

function isSameOutcome(left: RuntimeV2TerminalOutcome, right: RuntimeV2TerminalOutcome): boolean {
  return left.resultKind === right.resultKind &&
    left.reason === right.reason &&
    left.completedAt === right.completedAt &&
    left.finalProjectionId === right.finalProjectionId;
}

function isSameWorkPlan(left: RuntimeV2WorkPlanReference, right: RuntimeV2WorkPlanReference): boolean {
  return left.id === right.id &&
    left.revision === right.revision &&
    left.digest === right.digest &&
    left.projectionHash === right.projectionHash;
}

function isValidTurnIdentity(value: RuntimeV2TurnIdentity): boolean {
  return [
    value.workspaceKey,
    value.sessionKey,
    value.sessionEpoch,
    value.clientSubmissionId,
    value.turnId,
  ].every(isNonEmptyString);
}

function isValidRunIdentity(value: RuntimeV2RunIdentity): boolean {
  return [
    value.sessionKey,
    value.sessionEpoch,
    value.turnId,
    value.runId,
    value.attemptId,
  ].every(isNonEmptyString) && (value.parentRunId === null || isNonEmptyString(value.parentRunId));
}

function isValidEvent(event: RuntimeV2Event): boolean {
  return event.schemaVersion === RUNTIME_V2_EVENT_SCHEMA_VERSION &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence >= 0 &&
    isNonEmptyString(event.eventId) &&
    isFiniteTimestamp(event.at);
}

function isSameEvent(left: RuntimeV2Event, right: RuntimeV2Event): boolean {
  return left.eventId === right.eventId && JSON.stringify(left) === JSON.stringify(right);
}

function rejection(
  state: TurnAggregateV1 | null,
  reason: RuntimeV2TransitionRejection,
): RuntimeV2TransitionResult {
  return { disposition: "rejected", state, reason };
}

function append(
  state: TurnAggregateV1,
  event: RuntimeV2Event,
  patch: Omit<Partial<TurnAggregateV1>, "events" | "nextSequence" | "updatedAt"> = {},
): TurnAggregateV1 {
  return {
    ...state,
    ...patch,
    events: [...state.events, event],
    nextSequence: event.sequence + 1,
    updatedAt: event.at,
  };
}

function createInitialAggregate(event: Extract<RuntimeV2Event, { type: "turn.admitted" }>): TurnAggregateV1 {
  return {
    schemaVersion: "turn-aggregate.v1",
    turn: event.turn,
    strategy: event.strategy,
    objective: {
      text: event.objective,
      constraints: [...event.constraints],
      acceptanceCriteria: [...event.acceptanceCriteria],
      ...(event.acceptanceCriterionIds
        ? { acceptanceCriterionIds: [...event.acceptanceCriterionIds] }
        : {}),
      ...(event.acceptanceEvidenceRequirements
        ? {
            acceptanceEvidenceRequirements: [
              ...event.acceptanceEvidenceRequirements,
            ],
          }
        : {}),
    },
    run: null,
    phase: "preparing",
    events: [event],
    evidence: [],
    workPlan: null,
    sealedWorkPlan: null,
    planReviewCommit: null,
    executionContract: null,
    scheduledCommands: [],
    completedCommands: [],
    pendingToolCalls: [],
    subagents: [],
    recovery: emptyRuntimeV2RecoveryBudget(),
    terminalOutcome: null,
    finalProjectionId: null,
    nextSequence: event.sequence + 1,
    updatedAt: event.at,
  };
}

function appendEvidence(
  existing: readonly RuntimeV2EvidenceReference[],
  additions: readonly RuntimeV2EvidenceReference[],
): readonly RuntimeV2EvidenceReference[] {
  const next = [...existing];
  const known = new Set(existing.map((item) => `${item.id}\u0000${item.target}\u0000${item.version || ""}`));
  for (const evidence of additions) {
    const key = `${evidence.id}\u0000${evidence.target}\u0000${evidence.version || ""}`;
    if (known.has(key)) continue;
    known.add(key);
    next.push(evidence);
  }
  return next;
}

function activeRun(
  state: TurnAggregateV1,
  run: RuntimeV2RunIdentity,
): RuntimeV2TransitionRejection | null {
  if (!state.run) return "run_not_started";
  if (!isSameRun(state.run.identity, run)) return "run_identity_mismatch";
  if (state.run.status === "completed") return "run_not_active";
  return null;
}

function removeScheduledCommand(
  state: TurnAggregateV1,
  idempotencyKey: string,
  expectedKind?: TurnAggregateV1["scheduledCommands"][number]["kind"],
): { readonly command: TurnAggregateV1["scheduledCommands"][number] | null; readonly scheduledCommands: readonly TurnAggregateV1["scheduledCommands"][number][] } {
  const command = state.scheduledCommands.find((candidate) => candidate.idempotencyKey === idempotencyKey) || null;
  if (!command || (expectedKind && command.kind !== expectedKind)) {
    return { command: null, scheduledCommands: state.scheduledCommands };
  }
  return {
    command,
    scheduledCommands: state.scheduledCommands.filter((candidate) => candidate.idempotencyKey !== idempotencyKey),
  };
}

function commandReceipt(
  command: RuntimeV2Command,
  status: RuntimeV2CommandReceipt["status"],
  completedAt: number,
): RuntimeV2CommandReceipt {
  return {
    idempotencyKey: command.idempotencyKey,
    kind: command.kind,
    actionFingerprint: runtimeV2ActionFingerprint(command),
    status,
    completedAt,
  };
}

function appendCommandReceipt(
  current: readonly RuntimeV2CommandReceipt[],
  receipt: RuntimeV2CommandReceipt,
): readonly RuntimeV2CommandReceipt[] {
  if (current.some((item) => item.idempotencyKey === receipt.idempotencyKey)) return current;
  // Checkpoints retain enough receipts to distinguish a previously started
  // effect from a cold-recovery replay, without turning a long session into an
  // unbounded event cache.
  return [...current, receipt].slice(-256);
}

function resolveCommandCompletion(
  state: TurnAggregateV1,
  event: Extract<RuntimeV2Event, { type: "command.completed" | "provider.responded" | "tool.completed" | "validation.completed" }>,
  expectedKind?: TurnAggregateV1["scheduledCommands"][number]["kind"],
): RuntimeV2TransitionResult | {
  readonly command: TurnAggregateV1["scheduledCommands"][number];
  readonly scheduledCommands: readonly TurnAggregateV1["scheduledCommands"][number][];
} {
  const runRejection = activeRun(state, event.run);
  if (runRejection) return rejection(state, runRejection);
  const completion = removeScheduledCommand(state, event.idempotencyKey, expectedKind);
  if (!completion.command) {
    const anyCommand = state.scheduledCommands.some((command) => command.idempotencyKey === event.idempotencyKey);
    return rejection(state, anyCommand ? "command_kind_mismatch" : "command_not_scheduled");
  }
  return { command: completion.command, scheduledCommands: completion.scheduledCommands };
}

function isTransitionResult(value: RuntimeV2TransitionResult | {
  readonly command: TurnAggregateV1["scheduledCommands"][number];
  readonly scheduledCommands: readonly TurnAggregateV1["scheduledCommands"][number][];
}): value is RuntimeV2TransitionResult {
  return "disposition" in value;
}

function canChangePhase(current: RuntimeV2Phase, next: RuntimeV2Phase): boolean {
  if (current === "completed") return false;
  return PHASE_TRANSITIONS[current].includes(next);
}

function isRunBoundEvent(event: RuntimeV2Event): event is Exclude<RuntimeV2Event, Extract<RuntimeV2Event, { type: "turn.admitted" | "turn.completed" }>> {
  return event.type !== "turn.admitted" && event.type !== "turn.completed";
}

export function tryTransition(
  state: TurnAggregateV1 | null,
  event: RuntimeV2Event,
): RuntimeV2TransitionResult {
  if (!isValidEvent(event)) return rejection(state, "invalid_event_schema");

  if (!state) {
    if (event.type !== "turn.admitted" || event.sequence !== 0 || !isValidTurnIdentity(event.turn)) {
      return rejection(null, "initial_event_required");
    }
    return { disposition: "applied", state: createInitialAggregate(event) };
  }

  if (event.sequence < state.nextSequence) {
    const existing = state.events.find((candidate) => candidate.sequence === event.sequence);
    if (existing && isSameEvent(existing, event)) return { disposition: "idempotent", state };
    return rejection(state, "event_sequence_conflict");
  }
  if (event.sequence > state.nextSequence) return rejection(state, "event_sequence_gap");
  if (event.at < state.updatedAt) return rejection(state, "event_time_regression");
  if (event.type === "turn.admitted") return rejection(state, "turn_already_completed");
  if (event.type === "turn.completed") {
    if (!isSameTurn(state.turn, event.turn)) return rejection(state, "turn_identity_mismatch");
  } else if (isRunBoundEvent(event)) {
    // A final projection is published after `run.completed` but before the
    // matching `turn.completed`. It must retain the exact completed Run
    // identity without pretending that the Run is still active.
    if (event.type === "projection.published" && state.terminalOutcome) {
      if (!state.run || !isSameRun(state.run.identity, event.run)) {
        return rejection(state, "run_identity_mismatch");
      }
    } else {
    if (!state.run && event.type !== "run.started") return rejection(state, "run_not_started");
    if (event.type === "run.started") {
      if (!isValidRunIdentity(event.run) ||
        event.run.turnId !== state.turn.turnId ||
        event.run.sessionKey !== state.turn.sessionKey ||
        event.run.sessionEpoch !== state.turn.sessionEpoch) {
        return rejection(state, "run_identity_mismatch");
      }
    } else {
      const runRejection = activeRun(state, event.run);
      if (runRejection) return rejection(state, runRejection);
    }
    }
  }

  if (state.terminalOutcome && event.type !== "turn.completed" && event.type !== "projection.published") {
    return rejection(state, "turn_already_completed");
  }

  switch (event.type) {
    case "run.started": {
      if (state.run) return rejection(state, "run_already_started");
      const run: RuntimeV2RunState = {
        identity: event.run,
        status: "running",
        phase: event.phase,
        terminalOutcome: null,
      };
      return {
        disposition: "applied",
        state: append(state, event, { run, phase: event.phase }),
      };
    }
    case "phase.changed": {
      if (!canChangePhase(state.phase, event.phase)) return rejection(state, "phase_invalid");
      const run = state.run;
      if (!run) return rejection(state, "run_not_started");
      const status = event.phase === "reviewing" ? "reviewing" : "running";
      return {
        disposition: "applied",
        state: append(state, event, {
          phase: event.phase,
          run: { ...run, phase: event.phase, status },
        }),
      };
    }
    case "observation.recorded":
      return {
        disposition: "applied",
        state: append(state, event, {
          evidence: appendEvidence(state.evidence, [event.evidence]),
        }),
      };
    case "command.scheduled": {
      if (!isSameRun(event.command.run, event.run) || event.command.phase !== state.phase) {
        return rejection(state, "command_identity_mismatch");
      }
      if (state.scheduledCommands.some((command) => command.idempotencyKey === event.command.idempotencyKey)) {
        return rejection(state, "command_already_scheduled");
      }
      if (state.completedCommands.some((command) => command.idempotencyKey === event.command.idempotencyKey)) {
        return rejection(state, "command_already_completed");
      }
      return {
        disposition: "applied",
        state: append(state, event, {
          scheduledCommands: [...state.scheduledCommands, event.command],
        }),
      };
    }
    case "command.completed": {
      const completion = resolveCommandCompletion(state, event);
      if (isTransitionResult(completion)) return completion;
      const toolCallId =
        typeof completion.command.payload.toolCallId === "string"
          ? completion.command.payload.toolCallId
          : "";
      return {
        disposition: "applied",
        state: append(state, event, {
          scheduledCommands: completion.scheduledCommands,
          completedCommands: appendCommandReceipt(
            state.completedCommands,
            commandReceipt(completion.command, event.status, event.at),
          ),
          pendingToolCalls: toolCallId
            ? state.pendingToolCalls.filter((call) => call.id !== toolCallId)
            : state.pendingToolCalls,
        }),
      };
    }
    case "provider.responded": {
      const completion = resolveCommandCompletion(state, event, "request_model");
      if (isTransitionResult(completion)) return completion;
      return {
        disposition: "applied",
        state: append(state, event, {
          scheduledCommands: completion.scheduledCommands,
          completedCommands: appendCommandReceipt(
            state.completedCommands,
            commandReceipt(completion.command, "succeeded", event.at),
          ),
          pendingToolCalls: event.result.toolCalls,
        }),
      };
    }
    case "tool.completed": {
      const completion = resolveCommandCompletion(state, event, "execute_tool");
      if (isTransitionResult(completion)) return completion;
      const toolCallId = typeof completion.command.payload.toolCallId === "string"
        ? completion.command.payload.toolCallId
        : "";
      return {
        disposition: "applied",
        state: append(state, event, {
          scheduledCommands: completion.scheduledCommands,
          completedCommands: appendCommandReceipt(
            state.completedCommands,
            commandReceipt(
              completion.command,
              event.status === "succeeded" ? "succeeded" : "failed",
              event.at,
            ),
          ),
          evidence: appendEvidence(state.evidence, event.evidence),
          pendingToolCalls: toolCallId
            ? state.pendingToolCalls.filter((call) => call.id !== toolCallId)
            : state.pendingToolCalls,
        }),
      };
    }
    case "validation.completed": {
      const completion = resolveCommandCompletion(state, event, "execute_validation");
      if (isTransitionResult(completion)) return completion;
      const toolCallId = typeof completion.command.payload.toolCallId === "string"
        ? completion.command.payload.toolCallId
        : "";
      return {
        disposition: "applied",
        state: append(state, event, {
          scheduledCommands: completion.scheduledCommands,
          completedCommands: appendCommandReceipt(
            state.completedCommands,
            // The validation command itself completed successfully even when
            // the acceptance check did not pass. `event.passed` is the
            // semantic result; command failure is reserved for a validator
            // that could not be executed or authorized.
            commandReceipt(completion.command, "succeeded", event.at),
          ),
          evidence: appendEvidence(state.evidence, event.evidence),
          pendingToolCalls: toolCallId
            ? state.pendingToolCalls.filter((call) => call.id !== toolCallId)
            : state.pendingToolCalls,
        }),
      };
    }
    case "execution_contract.committed": {
      if (
        !isValidRuntimeV2ExecutionContractCommit({
          state,
          event,
        })
      ) {
        return rejection(state, "execution_contract_invalid");
      }
      return {
        disposition: "applied",
        state: append(state, event, {
          executionContract: event.contract,
        }),
      };
    }
    case "execution_contract.rejected":
      if (!event.reason.trim()) {
        return rejection(state, "execution_contract_invalid");
      }
      return {
        disposition: "applied",
        state: append(state, event),
      };
    case "execution_contract.invalidated": {
      if (
        !state.executionContract ||
        state.executionContract.id !== event.contractId ||
        state.executionContract.revision < event.revision
      ) {
        return rejection(state, "execution_contract_invalid");
      }
      if (state.executionContract.revision > event.revision) {
        // A replacement commit makes the prior revision stale immediately.
        // Preserve the explicit audit event without invalidating the newer
        // authority that is already active.
        return {
          disposition: "applied",
          state: append(state, event),
        };
      }
      return {
        disposition: "applied",
        state: append(state, event, {
          executionContract: {
            ...state.executionContract,
            status: "invalidated",
          },
        }),
      };
    }
    case "work_plan.sealed": {
      if (state.strategy !== "plan") return rejection(state, "plan_strategy_required");
      if (state.phase !== "planning") return rejection(state, "phase_invalid");
      if (!hasMatchingRuntimeV2SealedPlanAuthority({ event, state })) {
        return rejection(state, "plan_identity_mismatch");
      }
      const run = state.run;
      if (!run) return rejection(state, "run_not_started");
      return {
        disposition: "applied",
        state: append(state, event, {
          phase: "reviewing",
          run: { ...run, phase: "reviewing", status: "reviewing" },
          workPlan: { ...event.workPlan, status: "pending_review" },
          sealedWorkPlan: event.sealedPlan,
          planReviewCommit: event.reviewCommit,
        }),
      };
    }
    case "work_plan.approved": {
      if (state.strategy !== "plan") return rejection(state, "plan_strategy_required");
      if (!state.workPlan || state.run?.status !== "reviewing") return rejection(state, "plan_review_required");
      if (!isSameWorkPlan(state.workPlan, event.workPlan)) return rejection(state, "plan_identity_mismatch");
      const run = state.run;
      if (!run) return rejection(state, "run_not_started");
      return {
        disposition: "applied",
        state: append(state, event, {
          // Approval grants effect authority; it does not prove that the
          // execution process has prepared current workspace context. Resume
          // through the ordinary preparing/observing path so collaboration,
          // source freshness and mutation gating remain available.
          phase: "preparing",
          run: { ...run, phase: "preparing", status: "running" },
          workPlan: { ...event.workPlan, status: "approved" },
        }),
      };
    }
    case "work_plan.invalidated": {
      if (!state.workPlan || !isSameWorkPlan(state.workPlan, event.workPlan)) {
        return rejection(state, "plan_identity_mismatch");
      }
      const run = state.run;
      if (!run) return rejection(state, "run_not_started");
      return {
        disposition: "applied",
        state: append(state, event, {
          phase: "planning",
          run: { ...run, phase: "planning", status: "running" },
          workPlan: { ...event.workPlan, status: "invalidated" },
        }),
      };
    }
    case "recovery.epoch_opened": {
      if (event.evidence.length === 0) return rejection(state, "recovery_evidence_required");
      if (!hasNovelRuntimeV2Evidence(state.evidence, event.evidence)) {
        return rejection(state, "recovery_evidence_not_novel");
      }
      if (!canOpenRuntimeV2RecoveryEpoch(state.recovery)) {
        return rejection(state, "recovery_limit_exceeded");
      }
      return {
        disposition: "applied",
        state: append(state, event, {
          evidence: appendEvidence(state.evidence, event.evidence),
          recovery: openRuntimeV2RecoveryEpoch(state.recovery),
        }),
      };
    }
    case "recovery.recorded": {
      if (!canRecordRuntimeV2Recovery(state.recovery, event.scope, event.fingerprint)) {
        return rejection(state, "recovery_limit_exceeded");
      }
      return {
        disposition: "applied",
        state: append(state, event, {
          recovery: recordRuntimeV2Recovery({
            budget: state.recovery,
            scope: event.scope,
            fingerprint: event.fingerprint,
            at: event.at,
          }),
        }),
      };
    }
    case "recovery.exhausted": {
      if (state.recovery.exhausted) return rejection(state, "recovery_already_exhausted");
      return {
        disposition: "applied",
        state: append(state, event, {
          recovery: exhaustRuntimeV2Recovery({
            budget: state.recovery,
            scope: event.scope,
            fingerprint: event.fingerprint,
            reason: event.reason,
            at: event.at,
          }),
        }),
      };
    }
    case "soft_signal.observed":
      return { disposition: "applied", state: append(state, event) };
    case "subagents.scheduled": {
      const activeCount = state.subagents.filter((job) =>
        job.status === "queued" || job.status === "running"
      ).length;
      if (
        event.jobs.length === 0 ||
        activeCount + event.jobs.length >
          MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS ||
        event.jobs.some((job) =>
          !isValidRuntimeV2SubagentJob(job, event.run)
        )
      ) {
        return rejection(state, "subagent_invalid");
      }
      const known = new Set(state.subagents.map((job) => job.id));
      if (event.jobs.some((job) => known.has(job.id))) return rejection(state, "subagent_invalid");
      return {
        disposition: "applied",
        state: append(state, event, { subagents: [...state.subagents, ...event.jobs] }),
      };
    }
    case "subagent.telemetry": {
      const index = state.subagents.findIndex((job) => job.id === event.telemetry.jobId);
      if (index < 0) return rejection(state, "subagent_not_found");
      const current = state.subagents[index]!;
      const nextJob = applyRuntimeV2SubagentTelemetry(current, event.telemetry);
      if (!nextJob) return rejection(state, "subagent_telemetry_invalid");
      const subagents = [...state.subagents];
      subagents[index] = nextJob;
      return { disposition: "applied", state: append(state, event, { subagents }) };
    }
    case "subagent.completed": {
      const index = state.subagents.findIndex((job) => job.id === event.jobId);
      if (index < 0) return rejection(state, "subagent_not_found");
      const current = state.subagents[index]!;
      if (current.status !== "running" || current.closedAt === null) {
        return rejection(state, "subagent_telemetry_invalid");
      }
      if (
        event.status === "completed" &&
        !validateRuntimeV2SubagentReport({
          report: event.report,
          evidence: event.evidence,
        })
      ) {
        return rejection(state, "subagent_invalid");
      }
      if (event.status === "degraded" && event.evidence.length === 0) return rejection(state, "subagent_invalid");
      if (!validateRuntimeV2SubagentValidationReceipts({
        receipts: event.validationReceipts,
        evidence: event.evidence,
        taskKind: current.taskKind,
        eventAt: event.at,
      })) {
        return rejection(state, "subagent_invalid");
      }
      const subagents = [...state.subagents];
      subagents[index] = {
        ...current,
        status: event.status,
        summary: event.summary.trim() || null,
        report: event.report || null,
      };
      return {
        disposition: "applied",
        state: append(state, event, {
          subagents,
          evidence: appendEvidence(state.evidence, event.evidence),
        }),
      };
    }
    case "projection.published": {
      if (event.projection.id !== event.projectionId || event.projection.audience !== event.audience) {
        return rejection(state, "final_projection_mismatch");
      }
      if (event.audience === "final") {
        if (!state.terminalOutcome) return rejection(state, "final_projection_missing");
        if (event.projectionId !== state.terminalOutcome.finalProjectionId) {
          return rejection(state, "final_projection_mismatch");
        }
        if (state.finalProjectionId) return rejection(state, "final_projection_mismatch");
      }
      return {
        disposition: "applied",
        state: append(state, event, {
          finalProjectionId: event.audience === "final" ? event.projectionId : state.finalProjectionId,
        }),
      };
    }
    case "run.aborted": {
      if (state.events.some((candidate) => candidate.type === "run.aborted")) {
        return rejection(state, "run_already_aborted");
      }
      if (!event.reason.trim()) return rejection(state, "invalid_event_schema");
      return { disposition: "applied", state: append(state, event) };
    }
    case "run.completed": {
      const run = state.run;
      if (!run) return rejection(state, "run_not_started");
      const wasAborted = state.events.some((candidate) =>
        candidate.type === "run.aborted"
      );
      if (event.outcome.resultKind === "canceled" && !wasAborted) {
        return rejection(state, "canceled_requires_abort");
      }
      if (event.outcome.resultKind !== "canceled" && wasAborted) {
        return rejection(state, "abort_requires_canceled");
      }
      if (event.outcome.resultKind === "success" && state.phase !== "finalizing") {
        return rejection(state, "success_requires_finalizing");
      }
      return {
        disposition: "applied",
        state: append(state, event, {
          phase: "completed",
          run: {
            ...run,
            phase: "completed",
            status: "completed",
            terminalOutcome: event.outcome,
          },
          terminalOutcome: event.outcome,
        }),
      };
    }
    case "turn.completed": {
      if (!state.run || state.run.status !== "completed" || !state.terminalOutcome) {
        return rejection(state, "run_not_active");
      }
      if (event.runId !== state.run.identity.runId || !isSameOutcome(event.outcome, state.terminalOutcome)) {
        return rejection(state, "terminal_outcome_mismatch");
      }
      if (state.finalProjectionId !== state.terminalOutcome.finalProjectionId) {
        return rejection(state, "final_projection_missing");
      }
      return { disposition: "applied", state: append(state, event) };
    }
  }
}

export function transition(state: TurnAggregateV1 | null, event: RuntimeV2Event): TurnAggregateV1 {
  const result = tryTransition(state, event);
  if (result.disposition === "rejected") {
    throw new Error(`Runtime v2 transition rejected: ${result.reason}`);
  }
  return result.state;
}
