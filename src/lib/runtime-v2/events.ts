import {
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  type RuntimeV2Command,
  type RuntimeV2EvidenceReference,
  type RuntimeV2ExecutionValidationAuthority,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2Phase,
  type RuntimeV2Projection,
  type RuntimeV2ProjectionAudience,
  type RuntimeV2RecoveryScope,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2Strategy,
  type RuntimeV2SubagentHandoffApplicationSource,
  type RuntimeV2SubagentJob,
  type RuntimeV2SubagentStatus,
  type RuntimeV2SubagentTelemetry,
  type RuntimeV2TerminalOutcome,
  type RuntimeV2ToolPresentation,
  type RuntimeV2TurnIdentity,
  type RuntimeV2WorkPlanReference,
} from "./contracts";
import type {
  RuntimeV2PlanReviewCommit,
  SealedWorkPlanV1,
} from "./workPlan";
import type { RuntimeV2SubagentReportV1 } from "./subagentReport";
import type {
  RuntimeV2ValidatedMutationVersion,
} from "./validationReceipt";

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
      readonly acceptanceCriterionIds?: readonly string[];
      readonly acceptanceEvidenceRequirements?: readonly (
        "static" | "behavioral" | "interaction"
      )[];
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
      /** A replay closes the provider tool pair with an already committed
       * same-version receipt. It is not a new observation or progress
       * boundary and therefore carries no new evidence. */
      readonly receiptOrigin?: "executed" | "replayed";
      readonly presentation?: RuntimeV2ToolPresentation;
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
      readonly presentation?: RuntimeV2ToolPresentation;
      /** Exact authority and criterion linkage used when this validation was
       * admitted. A receipt without it cannot prove Execute completion. */
      readonly authority?: RuntimeV2ExecutionValidationAuthority;
      /** Exact mutation boundary observed by the validator. Any later
       * mutation makes this receipt stale. */
      readonly mutationBoundarySequence?: number;
      readonly validatedMutationVersions?:
        readonly RuntimeV2ValidatedMutationVersion[];
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
      readonly signal:
        | "no_tool_call"
        | "empty_response"
        | "repeat"
        | "context_pressure"
        | "iteration_limit"
        | "protocol_drift"
        | "repeated_action";
    })
  | (RuntimeV2EventBase & {
      readonly type: "subagents.scheduled";
      readonly run: RuntimeV2RunIdentity;
      readonly maxActiveSubagents: number;
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
      readonly status: Extract<
        RuntimeV2SubagentStatus,
        "completed" | "degraded" | "failed" | "canceled"
      >;
      readonly summary: string;
      /** Parent evidence available to a review child. It is not appended to
       * the aggregate again and cannot be counted as child-produced evidence. */
      readonly inheritedEvidence?:
        readonly RuntimeV2EvidenceReference[];
      readonly evidence: readonly RuntimeV2EvidenceReference[];
      readonly report?: RuntimeV2SubagentReportV1;
    })
  | (RuntimeV2EventBase & {
      readonly type: "subagent.handoff_delivered";
      /** Parent Run that received the child result. */
      readonly run: RuntimeV2RunIdentity;
      readonly jobId: string;
      readonly contextEntryId: string;
      readonly evidenceIds: readonly string[];
    })
  | (RuntimeV2EventBase & {
      readonly type: "subagent.handoff_applied";
      /** Parent Run that explicitly used child evidence. */
      readonly run: RuntimeV2RunIdentity;
      readonly jobId: string;
      readonly evidenceIds: readonly string[];
      readonly sourceEventId: string;
      readonly source:
        RuntimeV2SubagentHandoffApplicationSource;
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
