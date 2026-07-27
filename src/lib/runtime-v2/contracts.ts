export const RUNTIME_V2_ENGINE_VERSION = "v2" as const;
export const RUNTIME_V2_EVENT_SCHEMA_VERSION = "runtime-v2-event.v1" as const;
export const RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION = "turn-runtime-checkpoint.v3" as const;

export type RuntimeEngineVersion = "legacy" | typeof RUNTIME_V2_ENGINE_VERSION;

export type RuntimeV2Strategy = "chat" | "analyze" | "plan" | "execute" | "goal";

export type RuntimeV2Phase =
  | "preparing"
  | "observing"
  | "planning"
  | "reviewing"
  | "acting"
  | "validating"
  | "finalizing"
  | "completed";

export type RuntimeV2ResultKind =
  | "success"
  | "partial"
  | "blocked"
  | "error"
  | "canceled";

export type RuntimeV2ProjectionAudience =
  | "capsule_live"
  | "chat_milestone"
  | "timeline"
  | "final";

export type RuntimeV2CommandKind =
  | "collect_observation"
  | "request_model"
  | "execute_tool"
  | "execute_validation"
  | "schedule_subagents"
  | "join_subagents"
  | "publish_projection"
  | "finalize_turn";

export type RuntimeV2TransportVariant =
  | "native_required"
  | "native_auto"
  | "text_envelope";

/** Recovery is deliberately scoped to a durable, structural fact. Model prose
 * and loop counts are not valid recovery keys. */
export type RuntimeV2RecoveryScope =
  | "transport"
  | "action"
  | "context"
  | "diagnostic";

export interface RuntimeV2RecoveryReceipt {
  readonly scope: RuntimeV2RecoveryScope;
  readonly fingerprint: string;
  readonly count: number;
  readonly epoch: number;
  readonly lastAttemptAt: number;
}

export interface RuntimeV2RecoveryExhaustion {
  readonly scope: RuntimeV2RecoveryScope;
  readonly fingerprint: string;
  readonly reason: string;
  readonly at: number;
}

export interface RuntimeV2TurnIdentity {
  readonly workspaceKey: string;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly clientSubmissionId: string;
  readonly turnId: string;
}

export interface RuntimeV2RunIdentity {
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly turnId: string;
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly attemptId: string;
}

export interface RuntimeV2Objective {
  readonly text: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

export interface RuntimeV2EvidenceReference {
  readonly id: string;
  readonly kind: "source" | "tool" | "mutation" | "validation" | "subagent" | "user";
  readonly target: string;
  readonly version: string | null;
}

export interface RuntimeV2WorkPlanReference {
  readonly id: string;
  readonly revision: number;
  readonly digest: string;
  readonly projectionHash: string;
  readonly status: "draft" | "sealed" | "pending_review" | "approved" | "invalidated";
}

export interface RuntimeV2RecoveryBudget {
  readonly transportAttempts: number;
  readonly actionRepeats: number;
  readonly contextRefreshes: number;
  readonly diagnosticRepairs: number;
  readonly epoch: number;
  /** A bounded, replayable receipt ledger rather than process-local counters. */
  readonly receipts: readonly RuntimeV2RecoveryReceipt[];
  readonly exhausted: RuntimeV2RecoveryExhaustion | null;
}

export interface RuntimeV2Command {
  readonly idempotencyKey: string;
  readonly kind: RuntimeV2CommandKind;
  readonly run: RuntimeV2RunIdentity;
  readonly phase: Exclude<RuntimeV2Phase, "completed">;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RuntimeV2CommandReceipt {
  readonly idempotencyKey: string;
  readonly kind: RuntimeV2CommandKind;
  readonly actionFingerprint: string;
  readonly status: "succeeded" | "failed" | "canceled";
  readonly completedAt: number;
}

export interface RuntimeV2TerminalOutcome {
  readonly resultKind: RuntimeV2ResultKind;
  readonly reason: string;
  readonly completedAt: number;
  readonly finalProjectionId: string;
}

export interface RuntimeV2NormalizedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface RuntimeV2ProviderDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface RuntimeV2NormalizedProviderResult {
  readonly visibleText?: string;
  readonly commentary?: string;
  readonly toolCalls: readonly RuntimeV2NormalizedToolCall[];
  readonly diagnostics: readonly RuntimeV2ProviderDiagnostic[];
  readonly usage?: Readonly<Record<string, number>>;
}

/** A public, durable-or-live UI projection. Hidden model reasoning never fits
 * this type: callers may supply only provider-visible commentary or facts from
 * structured runtime actions. */
export interface RuntimeV2Projection {
  readonly id: string;
  readonly audience: RuntimeV2ProjectionAudience;
  readonly markdown: string;
  readonly kind: "live_action" | "milestone" | "timeline" | "final";
  readonly dedupeKey: string;
}

export type RuntimeV2SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/** Read-only child contract for the first collaboration slice. A child never
 * receives mutation authority and its result is evidence, not parent state. */
export interface RuntimeV2SubagentJob {
  readonly id: string;
  readonly run: RuntimeV2RunIdentity;
  readonly parentRunId: string;
  readonly scopeKey: string;
  readonly objective: string;
  readonly allowedPaths: readonly string[];
  readonly status: RuntimeV2SubagentStatus;
  readonly requestedAt: number;
  readonly firstTokenAt: number | null;
  readonly closedAt: number | null;
  readonly summary: string | null;
}

export interface RuntimeV2SubagentTelemetry {
  readonly jobId: string;
  readonly phase: "request_opened" | "first_token" | "closed";
  readonly at: number;
}
