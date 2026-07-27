import {
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  type RuntimeV2Command,
  type RuntimeV2EvidenceReference,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2Phase,
  type RuntimeV2Projection,
  type RuntimeV2ProjectionAudience,
  type RuntimeV2RecoveryScope,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2Strategy,
  type RuntimeV2SubagentJob,
  type RuntimeV2SubagentStatus,
  type RuntimeV2SubagentTelemetry,
  type RuntimeV2TerminalOutcome,
  type RuntimeV2TurnIdentity,
  type RuntimeV2WorkPlanReference,
} from "./contracts";
import type {
  RuntimeV2PlanReviewCommit,
  SealedWorkPlanV1,
} from "./workPlan";

export interface RuntimeV2EventBase {
  readonly schemaVersion: typeof RUNTIME_V2_EVENT_SCHEMA_VERSION;
  readonly sequence: number;
  readonly eventId: string;
  readonly at: number;
}

export type RuntimeV2Event =
  | (RuntimeV2EventBase & {
      readonly type: "turn.admitted";
      readonly turn: RuntimeV2TurnIdentity;
      readonly strategy: RuntimeV2Strategy;
      readonly objective: string;
      readonly constraints: readonly string[];
      readonly acceptanceCriteria: readonly string[];
    })
  | (RuntimeV2EventBase & {
      readonly type: "run.started";
      readonly run: RuntimeV2RunIdentity;
      readonly phase: Exclude<RuntimeV2Phase, "reviewing" | "completed">;
    })
  | (RuntimeV2EventBase & {
      readonly type: "phase.changed";
      readonly run: RuntimeV2RunIdentity;
      readonly phase: Exclude<RuntimeV2Phase, "completed">;
      readonly reason: string;
    })
  | (RuntimeV2EventBase & {
      readonly type: "observation.recorded";
      readonly run: RuntimeV2RunIdentity;
      readonly evidence: RuntimeV2EvidenceReference;
    })
  | (RuntimeV2EventBase & {
      readonly type: "command.scheduled";
      readonly run: RuntimeV2RunIdentity;
      readonly command: RuntimeV2Command;
    })
  | (RuntimeV2EventBase & {
      readonly type: "command.completed";
      readonly run: RuntimeV2RunIdentity;
      readonly idempotencyKey: string;
      readonly status: "succeeded" | "failed" | "canceled";
    })
  | (RuntimeV2EventBase & {
      readonly type: "provider.responded";
      readonly run: RuntimeV2RunIdentity;
      readonly idempotencyKey: string;
      readonly result: RuntimeV2NormalizedProviderResult;
    })
  | (RuntimeV2EventBase & {
      readonly type: "tool.completed";
      readonly run: RuntimeV2RunIdentity;
      readonly idempotencyKey: string;
      readonly evidence: readonly RuntimeV2EvidenceReference[];
      readonly status: "succeeded" | "failed" | "blocked";
      readonly failureKind?:
        | "execution_failed"
        | "not_authorized"
        | "protocol_invalid"
        | "mutation_rejected"
        | "source_mismatch"
        | "target_invalid";
    })
  | (RuntimeV2EventBase & {
      readonly type: "validation.completed";
      readonly run: RuntimeV2RunIdentity;
      readonly idempotencyKey: string;
      readonly evidence: readonly RuntimeV2EvidenceReference[];
      readonly passed: boolean;
      /** A protocol or authority rejection asks for a corrected validation
       * call in the same phase. Only a real execution/assertion failure
       * justifies returning to source modification. */
      readonly failureKind?:
        | "assertion_failed"
        | "execution_failed"
        | "not_authorized"
        | "protocol_invalid";
    })
  | (RuntimeV2EventBase & {
      readonly type: "work_plan.sealed";
      readonly run: RuntimeV2RunIdentity;
      readonly workPlan: RuntimeV2WorkPlanReference;
      readonly sealedPlan: SealedWorkPlanV1;
      readonly reviewCommit: RuntimeV2PlanReviewCommit;
    })
  | (RuntimeV2EventBase & {
      readonly type: "work_plan.approved";
      readonly run: RuntimeV2RunIdentity;
      readonly workPlan: RuntimeV2WorkPlanReference;
    })
  | (RuntimeV2EventBase & {
      readonly type: "work_plan.invalidated";
      readonly run: RuntimeV2RunIdentity;
      readonly workPlan: RuntimeV2WorkPlanReference;
      readonly reason: string;
    })
  | (RuntimeV2EventBase & {
      readonly type: "recovery.epoch_opened";
      readonly run: RuntimeV2RunIdentity;
      readonly reason: string;
      readonly evidence: readonly RuntimeV2EvidenceReference[];
    })
  | (RuntimeV2EventBase & {
      readonly type: "recovery.recorded";
      readonly run: RuntimeV2RunIdentity;
      readonly scope: RuntimeV2RecoveryScope;
      readonly fingerprint: string;
    })
  | (RuntimeV2EventBase & {
      readonly type: "recovery.exhausted";
      readonly run: RuntimeV2RunIdentity;
      readonly scope: RuntimeV2RecoveryScope;
      readonly fingerprint: string;
      readonly reason: string;
    })
  | (RuntimeV2EventBase & {
      readonly type: "soft_signal.observed";
      readonly run: RuntimeV2RunIdentity;
      readonly signal: "no_tool_call" | "empty_response" | "repeat" | "context_pressure" | "iteration_limit";
    })
  | (RuntimeV2EventBase & {
      readonly type: "subagents.scheduled";
      readonly run: RuntimeV2RunIdentity;
      readonly jobs: readonly RuntimeV2SubagentJob[];
    })
  | (RuntimeV2EventBase & {
      readonly type: "subagent.telemetry";
      readonly run: RuntimeV2RunIdentity;
      readonly telemetry: RuntimeV2SubagentTelemetry;
    })
  | (RuntimeV2EventBase & {
      readonly type: "subagent.completed";
      readonly run: RuntimeV2RunIdentity;
      readonly jobId: string;
      readonly status: Extract<RuntimeV2SubagentStatus, "completed" | "failed" | "canceled">;
      readonly summary: string;
      readonly evidence: readonly RuntimeV2EvidenceReference[];
    })
  | (RuntimeV2EventBase & {
      readonly type: "projection.published";
      readonly run: RuntimeV2RunIdentity;
      readonly audience: RuntimeV2ProjectionAudience;
      readonly projectionId: string;
      readonly projection: RuntimeV2Projection;
    })
  | (RuntimeV2EventBase & {
      readonly type: "run.aborted";
      readonly run: RuntimeV2RunIdentity;
      readonly reason: string;
    })
  | (RuntimeV2EventBase & {
      readonly type: "run.completed";
      readonly run: RuntimeV2RunIdentity;
      readonly outcome: RuntimeV2TerminalOutcome;
    })
  | (RuntimeV2EventBase & {
      readonly type: "turn.completed";
      readonly turn: RuntimeV2TurnIdentity;
      readonly runId: string;
      readonly outcome: RuntimeV2TerminalOutcome;
    });

/**
 * External effects return semantic event fields only.  The controller owns
 * ledger metadata, so a late provider or tool callback can never publish a
 * stale sequence number or event identity.
 */
export type RuntimeV2EventDraft = RuntimeV2Event extends infer Event
  ? Event extends RuntimeV2Event
    ? Omit<Event, keyof RuntimeV2EventBase>
    : never
  : never;

export function isRuntimeV2TerminalEvent(event: RuntimeV2Event): boolean {
  return event.type === "run.completed" || event.type === "turn.completed";
}

export function isRuntimeV2TerminalResultKind(value: unknown): value is RuntimeV2ResultKind {
  return value === "success" || value === "partial" || value === "blocked" || value === "error" || value === "canceled";
}
