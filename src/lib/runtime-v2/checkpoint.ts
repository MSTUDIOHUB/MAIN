import { canonicalJson as stableJson } from "../canonicalJson";
import { sha256Hex } from "../sha256";
import {
  RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION,
  RUNTIME_V2_ENGINE_VERSION,
  type RuntimeV2Command,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
} from "./contracts";
import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Event } from "./events";
import {
  normalizeRuntimeV2EmergencyTerminalEnvelope,
  sameRuntimeV2EmergencyTerminalRun,
  type RuntimeV2EmergencyTerminalEnvelopeV1,
  type RuntimeV2EmergencyTerminalReasonCode,
} from "./emergencyTerminal";
import { tryTransition } from "./reducer";

/** The durable envelope must support long-running Execute Turns. The former
 * 512-event ceiling could be reached by ordinary provider/tool/projection
 * receipts, turning persistence pressure into an accidental lifecycle owner. */
export const MAX_RUNTIME_V2_CHECKPOINT_EVENTS = 2_048;
export const MAX_RUNTIME_V2_CHECKPOINT_CHARS = 8_388_608;
export const RUNTIME_V2_LEGACY_CHECKPOINT_SCHEMA_VERSION =
  "turn-runtime-checkpoint.v3" as const;
export const RUNTIME_V2_PREVIOUS_CHECKPOINT_SCHEMA_VERSION =
  "turn-runtime-checkpoint.v4" as const;

export class RuntimeV2CheckpointWriteBoundaryError extends Error {
  readonly code = "RUNTIME_V2_CHECKPOINT_WRITE_BOUNDARY";

  constructor(
    readonly reasonCode: RuntimeV2EmergencyTerminalReasonCode,
  ) {
    super(reasonCode);
    this.name = "RuntimeV2CheckpointWriteBoundaryError";
  }
}

export function runtimeV2CheckpointWriteFailureReason(
  error: unknown,
): RuntimeV2EmergencyTerminalReasonCode | null {
  if (error instanceof RuntimeV2CheckpointWriteBoundaryError) {
    return error.reasonCode;
  }
  const reasonCode = (
    error &&
    typeof error === "object" &&
    "reasonCode" in error
  )
    ? (error as { readonly reasonCode?: unknown }).reasonCode
    : null;
  return reasonCode === "checkpoint_event_budget_exceeded" ||
      reasonCode === "checkpoint_size_budget_exceeded" ||
      reasonCode === "checkpoint_persist_failed"
    ? reasonCode
    : null;
}

export interface RuntimeV2CheckpointV4 {
  readonly schemaVersion: typeof RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION;
  readonly engineVersion: typeof RUNTIME_V2_ENGINE_VERSION;
  readonly revision: number;
  readonly owner: RuntimeV2TurnIdentity;
  /** The reducer result is persisted as a cache only; `events` stay source of truth. */
  readonly aggregate: TurnAggregateV1;
  readonly events: readonly RuntimeV2Event[];
  readonly scheduledCommands: readonly RuntimeV2Command[];
  readonly aggregateDigest: string;
  readonly updatedAt: number;
  readonly migratedFrom?:
    | typeof RUNTIME_V2_LEGACY_CHECKPOINT_SCHEMA_VERSION
    | typeof RUNTIME_V2_PREVIOUS_CHECKPOINT_SCHEMA_VERSION;
  readonly migrationDisposition?:
    | "terminal_read_only"
    | "active_unmodified"
    | "active_uncontracted_mutation";
}

/** Compatibility alias for store adapters that shipped with the v3 name. */
export type RuntimeV2CheckpointV3 = RuntimeV2CheckpointV4;

export type RuntimeV2CheckpointMap = Record<string, RuntimeV2CheckpointV3>;

export interface RuntimeV2PersistedCheckpointV5 {
  readonly schemaVersion: typeof RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION;
  readonly engineVersion: typeof RUNTIME_V2_ENGINE_VERSION;
  readonly revision: number;
  readonly owner: RuntimeV2TurnIdentity;
  /** The event ledger is the only persisted lifecycle truth. */
  readonly events: readonly RuntimeV2Event[];
  readonly aggregateDigest: string;
  readonly updatedAt: number;
  readonly migratedFrom?:
    | typeof RUNTIME_V2_LEGACY_CHECKPOINT_SCHEMA_VERSION
    | typeof RUNTIME_V2_PREVIOUS_CHECKPOINT_SCHEMA_VERSION;
  readonly migrationDisposition?:
    | "terminal_read_only"
    | "active_unmodified"
    | "active_uncontracted_mutation";
}

export type RuntimeV2PersistedCheckpointMap =
  Record<string, RuntimeV2PersistedCheckpointV5>;

export interface RuntimeV2CheckpointRejection {
  readonly code: "invalid_value" | "unsupported_schema" | "unsupported_engine" |
    "invalid_revision" | "invalid_updated_at" | "invalid_owner" | "owner_mismatch" |
    "serialization_failed" | "size_budget_exceeded" | "legacy_replay_failed" |
    "events_missing" | "event_budget_exceeded" | "event_replay_rejected" |
    "replay_owner_mismatch" | "aggregate_digest_mismatch" | "aggregate_cache_mismatch" |
    "scheduled_cache_mismatch" | "updated_at_stale";
  readonly turnId?: string;
  readonly sessionKey?: string;
  readonly sessionEpoch?: string;
  readonly revision?: number;
  readonly eventCount?: number;
  readonly serializedChars?: number;
}

export interface RuntimeV2CheckpointNormalizationOptions {
  readonly onRejected?: (diagnostic: RuntimeV2CheckpointRejection) => void;
  /** Read/restore may quarantine a damaged entry. A save must not acknowledge
   * a snapshot after silently removing its own canonical event ledger. */
  readonly rejectInvalid?: boolean;
}

function boundedIdentity(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/[\u0000\r\n]/g, "").slice(0, 180) : undefined;
}

function checkpointRejection(
  value: unknown,
  code: RuntimeV2CheckpointRejection["code"],
  serializedChars?: number,
): RuntimeV2CheckpointRejection {
  const record = isPlainRecord(value) ? value : {};
  const owner = isPlainRecord(record.owner) ? record.owner : {};
  return { code,
    ...(boundedIdentity(owner.turnId) ? { turnId: boundedIdentity(owner.turnId) } : {}),
    ...(boundedIdentity(owner.sessionKey) ? { sessionKey: boundedIdentity(owner.sessionKey) } : {}),
    ...(boundedIdentity(owner.sessionEpoch) ? { sessionEpoch: boundedIdentity(owner.sessionEpoch) } : {}),
    ...(Number.isSafeInteger(record.revision) ? { revision: Number(record.revision) } : {}),
    ...(Array.isArray(record.events) ? { eventCount: record.events.length } : {}),
    ...(serializedChars !== undefined ? { serializedChars } : {}),
  };
}

export interface CreateRuntimeV2CheckpointInput {
  readonly revision: number;
  readonly aggregate: TurnAggregateV1;
  /** Accepted only when it matches the computed digest; callers do not choose
   * a checkpoint identity. */
  readonly aggregateDigest?: string;
  readonly updatedAt: number;
}

/**
 * A deserialized checkpoint is replay-validated once at the persistence
 * boundary. Checkpoints created by the reducer, and normalized copies that
 * already passed replay validation, are immutable runtime values and can use
 * the incremental CAS path without replaying the whole ledger on every event.
 */
const trustedRuntimeV2Checkpoints = new WeakSet<object>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function sameOwner(left: RuntimeV2TurnIdentity, right: RuntimeV2TurnIdentity): boolean {
  return left.workspaceKey === right.workspaceKey &&
    left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.clientSubmissionId === right.clientSubmissionId &&
    left.turnId === right.turnId;
}

function isFinitePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function checkpointOwner(
  value: Record<string, unknown>,
  expectedOwner?: Partial<RuntimeV2TurnIdentity>,
): RuntimeV2TurnIdentity | null {
  if (!isPlainRecord(value.owner)) return null;
  const owner = value.owner as unknown as RuntimeV2TurnIdentity;
  if (![owner.workspaceKey, owner.sessionKey, owner.sessionEpoch, owner.clientSubmissionId, owner.turnId]
    .every((part) => typeof part === "string" && part.trim() === part && part.length > 0)) return null;
  if (expectedOwner && Object.entries(expectedOwner).some(([key, expected]) =>
    expected !== undefined && owner[key as keyof RuntimeV2TurnIdentity] !== expected
  )) return null;
  return owner;
}

/** The digest covers the full replayed state, including scheduled effects. */
export function runtimeV2AggregateDigest(aggregate: TurnAggregateV1): string {
  return `runtime-v2-aggregate-sha256-${sha256Hex(stableJson(aggregate))}`;
}

/** Replay makes corrupted cached aggregate fields incapable of taking control. */
export function replayRuntimeV2Events(events: readonly RuntimeV2Event[]): TurnAggregateV1 | null {
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_RUNTIME_V2_CHECKPOINT_EVENTS) return null;
  let state: TurnAggregateV1 | null = null;
  for (const event of events) {
    const result = tryTransition(state, event);
    if (result.disposition === "rejected") return null;
    state = result.state;
  }
  return state;
}

export function createRuntimeV2Checkpoint(
  input: CreateRuntimeV2CheckpointInput,
): RuntimeV2CheckpointV3 {
  const revision = Math.floor(Number(input.revision));
  const updatedAt = Number(input.updatedAt);
  if (!isFinitePositiveInteger(revision) || !isFiniteTimestamp(updatedAt)) {
    throw new Error("Runtime v2 checkpoint revision and updatedAt must be finite.");
  }
  if (input.aggregate.events.length > MAX_RUNTIME_V2_CHECKPOINT_EVENTS) {
    throw new RuntimeV2CheckpointWriteBoundaryError(
      "checkpoint_event_budget_exceeded",
    );
  }
  const digest = runtimeV2AggregateDigest(input.aggregate);
  if (input.aggregateDigest && input.aggregateDigest !== digest) {
    throw new Error("Runtime v2 checkpoint aggregate digest mismatch.");
  }
  const checkpoint: RuntimeV2CheckpointV3 = {
    schemaVersion: RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION,
    engineVersion: RUNTIME_V2_ENGINE_VERSION,
    revision,
    owner: input.aggregate.turn,
    aggregate: input.aggregate,
    events: input.aggregate.events,
    scheduledCommands: input.aggregate.scheduledCommands,
    aggregateDigest: digest,
    updatedAt,
  };
  assertRuntimeV2CheckpointPersistable(checkpoint);
  trustedRuntimeV2Checkpoints.add(checkpoint);
  return checkpoint;
}

/**
 * Enforce the persisted v5 representation, not the live aggregate cache.
 * This prevents the serializer from silently dropping a trusted oversized
 * checkpoint after its side effect already executed.
 */
export function assertRuntimeV2CheckpointPersistable(
  checkpoint: RuntimeV2CheckpointV3,
): void {
  if (checkpoint.events.length > MAX_RUNTIME_V2_CHECKPOINT_EVENTS) {
    throw new RuntimeV2CheckpointWriteBoundaryError(
      "checkpoint_event_budget_exceeded",
    );
  }
  let encodedLength = Number.POSITIVE_INFINITY;
  try {
    encodedLength = JSON.stringify({
      schemaVersion: checkpoint.schemaVersion,
      engineVersion: checkpoint.engineVersion,
      revision: checkpoint.revision,
      owner: checkpoint.owner,
      events: checkpoint.events,
      aggregateDigest: checkpoint.aggregateDigest,
      updatedAt: checkpoint.updatedAt,
      ...(checkpoint.migratedFrom
        ? { migratedFrom: checkpoint.migratedFrom }
        : {}),
      ...(checkpoint.migrationDisposition
        ? { migrationDisposition: checkpoint.migrationDisposition }
        : {}),
    } satisfies RuntimeV2PersistedCheckpointV5).length;
  } catch {
    // An unencodable event is no safer to persist than an oversized one.
  }
  if (encodedLength > MAX_RUNTIME_V2_CHECKPOINT_CHARS) {
    throw new RuntimeV2CheckpointWriteBoundaryError(
      "checkpoint_size_budget_exceeded",
    );
  }
}

function migratedObjective(
  aggregate: TurnAggregateV1,
): TurnAggregateV1["objective"] {
  const criteria = aggregate.objective.acceptanceCriteria.length > 0
    ? aggregate.objective.acceptanceCriteria
    : aggregate.strategy === "execute"
      ? [aggregate.objective.text]
      : [];
  const ids = aggregate.objective.acceptanceCriterionIds?.length ===
      criteria.length
    ? aggregate.objective.acceptanceCriterionIds
    : criteria.map((_, index) =>
        aggregate.strategy === "execute" && criteria.length === 1
          ? "criterion-user-objective"
          : `criterion-${index + 1}`
      );
  return {
    ...aggregate.objective,
    acceptanceCriteria: criteria,
    acceptanceCriterionIds: ids,
  };
}

function normalizeLegacyActiveEvents(
  events: readonly unknown[],
): readonly RuntimeV2Event[] {
  const legacyContractCommandKeys = new Set(
    events.flatMap((event) => {
      if (
        !isPlainRecord(event) ||
        event.type !== "command.scheduled" ||
        !isPlainRecord(event.command) ||
        event.command.kind !== "commit_execution_contract"
      ) {
        return [];
      }
      return typeof event.command.idempotencyKey === "string"
        ? [event.command.idempotencyKey]
        : [];
    }),
  );
  const normalized: RuntimeV2Event[] = [];
  for (const candidate of events) {
    if (!isPlainRecord(candidate)) continue;
    if (
      candidate.type === "execution_contract.committed" ||
      candidate.type === "execution_contract.rejected" ||
      candidate.type === "execution_contract.invalidated"
    ) {
      continue;
    }
    if (
      candidate.type === "command.scheduled" &&
      isPlainRecord(candidate.command) &&
      candidate.command.kind === "commit_execution_contract"
    ) {
      continue;
    }
    if (
      candidate.type === "command.completed" &&
      typeof candidate.idempotencyKey === "string" &&
      legacyContractCommandKeys.has(candidate.idempotencyKey)
    ) {
      continue;
    }
    const event = candidate as unknown as RuntimeV2Event;
    if (event.type === "turn.admitted") {
      const acceptanceCriteria = event.acceptanceCriteria.length > 0
        ? event.acceptanceCriteria
        : event.strategy === "execute"
          ? [event.objective]
          : [];
      normalized.push({
        ...event,
        acceptanceCriteria,
        acceptanceCriterionIds:
          event.acceptanceCriterionIds?.length ===
              acceptanceCriteria.length
            ? event.acceptanceCriterionIds
            : acceptanceCriteria.map((_, index) =>
                event.strategy === "execute" &&
                    acceptanceCriteria.length === 1
                  ? "criterion-user-objective"
                  : `criterion-${index + 1}`
              ),
      });
      continue;
    }
    if (
      event.type === "subagent.completed" &&
      event.status === "completed" &&
      !event.report
    ) {
      normalized.push({
        ...event,
        status: event.evidence.length > 0 ? "degraded" : "failed",
        summary:
          event.evidence.length > 0
            ? "Legacy child result retained evidence but lacked a structured report; parent takeover is required."
            : "Legacy child result lacked both a structured evidence-linked report and retained evidence.",
      });
      continue;
    }
    normalized.push(event);
  }
  return normalized.map((event, sequence): RuntimeV2Event => ({
    ...event,
    sequence,
  }));
}

function normalizeLegacyRuntimeV2Checkpoint(
  value: Record<string, unknown> & {
    readonly revision: number;
    readonly updatedAt: number;
  },
  owner: RuntimeV2TurnIdentity,
): RuntimeV2CheckpointV4 | null {
  if (
    !isPlainRecord(value.aggregate) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.scheduledCommands)
  ) {
    return null;
  }
  const rawAggregate = value.aggregate as unknown as TurnAggregateV1;
  if (
    !sameOwner(rawAggregate.turn, owner) ||
    !sameJson(rawAggregate.events, value.events) ||
    !sameJson(rawAggregate.scheduledCommands, value.scheduledCommands) ||
    value.aggregateDigest !== runtimeV2AggregateDigest(rawAggregate) ||
    value.updatedAt < rawAggregate.updatedAt
  ) {
    return null;
  }
  const hasMutation = rawAggregate.evidence.some(
    (evidence) => evidence.kind === "mutation",
  );
  if (rawAggregate.terminalOutcome) {
    const {
      executionContract: _legacyExecutionContract,
      ...legacyAggregate
    } = rawAggregate as TurnAggregateV1 & {
      readonly executionContract?: unknown;
    };
    const aggregate: TurnAggregateV1 = {
      ...legacyAggregate,
      objective: migratedObjective(rawAggregate),
    };
    const normalized: RuntimeV2CheckpointV4 = {
      schemaVersion: RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION,
      engineVersion: RUNTIME_V2_ENGINE_VERSION,
      revision: value.revision,
      owner,
      aggregate,
      events: aggregate.events,
      scheduledCommands: aggregate.scheduledCommands,
      aggregateDigest: runtimeV2AggregateDigest(aggregate),
      updatedAt: value.updatedAt,
      migratedFrom: value.schemaVersion as
        | typeof RUNTIME_V2_LEGACY_CHECKPOINT_SCHEMA_VERSION
        | typeof RUNTIME_V2_PREVIOUS_CHECKPOINT_SCHEMA_VERSION,
      migrationDisposition: "terminal_read_only",
    };
    trustedRuntimeV2Checkpoints.add(normalized);
    return normalized;
  }
  const events = normalizeLegacyActiveEvents(
    value.events,
  );
  const replayed = replayRuntimeV2Events(events);
  if (!replayed || !sameOwner(replayed.turn, owner)) return null;
  const normalized: RuntimeV2CheckpointV4 = {
    schemaVersion: RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION,
    engineVersion: RUNTIME_V2_ENGINE_VERSION,
    revision: value.revision,
    owner,
    aggregate: replayed,
    events: replayed.events,
    scheduledCommands: replayed.scheduledCommands,
    aggregateDigest: runtimeV2AggregateDigest(replayed),
    updatedAt: Math.max(value.updatedAt, replayed.updatedAt),
    migratedFrom: value.schemaVersion as
      | typeof RUNTIME_V2_LEGACY_CHECKPOINT_SCHEMA_VERSION
      | typeof RUNTIME_V2_PREVIOUS_CHECKPOINT_SCHEMA_VERSION,
    migrationDisposition: hasMutation
      ? "active_uncontracted_mutation"
      : "active_unmodified",
  };
  trustedRuntimeV2Checkpoints.add(normalized);
  return normalized;
}

/**
 * Validate a persisted checkpoint by replay. No legacy/unknown checkpoint is
 * coerced into v3; history remains readable through its original adapter.
 */
export function normalizeRuntimeV2Checkpoint(
  value: unknown,
  expectedOwner?: Partial<RuntimeV2TurnIdentity>,
  onRejected?: (diagnostic: RuntimeV2CheckpointRejection) => void,
): RuntimeV2CheckpointV3 | null {
  const reject = (code: RuntimeV2CheckpointRejection["code"], serializedChars?: number) => {
    onRejected?.(checkpointRejection(value, code, serializedChars));
    return null;
  };
  if (!isPlainRecord(value)) return reject("invalid_value");
  if (![RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION, RUNTIME_V2_PREVIOUS_CHECKPOINT_SCHEMA_VERSION,
    RUNTIME_V2_LEGACY_CHECKPOINT_SCHEMA_VERSION].includes(value.schemaVersion as typeof RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION)) return reject("unsupported_schema");
  if (value.engineVersion !== RUNTIME_V2_ENGINE_VERSION) return reject("unsupported_engine");
  if (!isFinitePositiveInteger(value.revision)) return reject("invalid_revision");
  if (!isFiniteTimestamp(value.updatedAt)) return reject("invalid_updated_at");
  if (!checkpointOwner(value)) return reject("invalid_owner");
  if (!checkpointOwner(value, expectedOwner)) return reject("owner_mismatch");
  if (trustedRuntimeV2Checkpoints.has(value)) {
    return value as unknown as RuntimeV2CheckpointV3;
  }
  try {
    const serializedChars = JSON.stringify(value).length;
    if (serializedChars > MAX_RUNTIME_V2_CHECKPOINT_CHARS) return reject("size_budget_exceeded", serializedChars);
  } catch {
    return reject("serialization_failed");
  }
  const owner = value.owner as unknown as RuntimeV2TurnIdentity;
  if (
    value.schemaVersion ===
      RUNTIME_V2_LEGACY_CHECKPOINT_SCHEMA_VERSION ||
    value.schemaVersion ===
      RUNTIME_V2_PREVIOUS_CHECKPOINT_SCHEMA_VERSION
  ) {
    return normalizeLegacyRuntimeV2Checkpoint(value as Record<string, unknown> & {
      readonly revision: number; readonly updatedAt: number;
    }, owner) || reject("legacy_replay_failed");
  }
  if (!Array.isArray(value.events) || value.events.length === 0) return reject("events_missing");
  if (value.events.length > MAX_RUNTIME_V2_CHECKPOINT_EVENTS) return reject("event_budget_exceeded");
  const replayed = replayRuntimeV2Events(value.events as RuntimeV2Event[]);
  if (!replayed) return reject("event_replay_rejected");
  if (!sameOwner(replayed.turn, owner)) return reject("replay_owner_mismatch");
  const digest = runtimeV2AggregateDigest(replayed);
  if (value.aggregateDigest !== digest) return reject("aggregate_digest_mismatch");
  if (
    value.aggregate !== undefined &&
    !sameJson(value.aggregate, replayed)
  ) return reject("aggregate_cache_mismatch");
  if (
    value.scheduledCommands !== undefined &&
    !sameJson(value.scheduledCommands, replayed.scheduledCommands)
  ) return reject("scheduled_cache_mismatch");
  if (value.updatedAt < replayed.updatedAt) return reject("updated_at_stale");
  const normalized: RuntimeV2CheckpointV3 = {
    schemaVersion: RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION,
    engineVersion: RUNTIME_V2_ENGINE_VERSION,
    revision: value.revision,
    owner,
    aggregate: replayed,
    events: replayed.events,
    scheduledCommands: replayed.scheduledCommands,
    aggregateDigest: digest,
    updatedAt: value.updatedAt,
  };
  trustedRuntimeV2Checkpoints.add(normalized);
  return normalized;
}

export function normalizeRuntimeV2CheckpointMap(
  value: unknown,
  expectedOwner?: Partial<RuntimeV2TurnIdentity>,
  options: RuntimeV2CheckpointNormalizationOptions = {},
): RuntimeV2CheckpointMap {
  if (!isPlainRecord(value)) return {};
  const rejected: RuntimeV2CheckpointRejection[] = [];
  const result: RuntimeV2CheckpointMap = {};
  let invalidOwnLedger = false;
  for (const [turnId, checkpoint] of Object.entries(value)) {
    const normalized = normalizeRuntimeV2Checkpoint(checkpoint, { ...expectedOwner, turnId }, diagnostic => {
      rejected.push(diagnostic);
      options.onRejected?.(diagnostic);
      const owner = isPlainRecord(checkpoint) ? checkpointOwner(checkpoint) : null;
      const unrelatedOwner = owner && expectedOwner &&
        (["workspaceKey", "sessionKey", "sessionEpoch"] as const).some(field =>
          expectedOwner[field] !== undefined && owner[field] !== expectedOwner[field]);
      if (!unrelatedOwner) invalidOwnLedger = true;
    });
    if (normalized) result[turnId] = normalized;
  }
  if (rejected.length && !options.onRejected) {
    // Emit only identities and machine reasons, never event/source bodies.
    console.warn("[runtime_v2_checkpoint_filtered]", JSON.stringify({ rejectedCount: rejected.length, diagnostics: rejected.slice(0, 8) }));
  }
  if (options.rejectInvalid && invalidOwnLedger) {
    throw new RuntimeV2CheckpointWriteBoundaryError("checkpoint_persist_failed");
  }
  return result;
}

/**
 * Strip replayable caches at the Session persistence boundary. Live Store
 * checkpoints retain `aggregate` for efficient decisions; disk contains one
 * canonical ledger and reconstructs the cache through normalization.
 */
export function serializeRuntimeV2CheckpointMap(
  value: unknown,
  expectedOwner?: Partial<RuntimeV2TurnIdentity>,
  options: RuntimeV2CheckpointNormalizationOptions = {},
): RuntimeV2PersistedCheckpointMap {
  const normalized = normalizeRuntimeV2CheckpointMap(value, expectedOwner, { ...options, rejectInvalid: true });
  const persisted = Object.fromEntries(
    Object.entries(normalized).map(([turnId, checkpoint]) => [
      turnId,
      {
        schemaVersion: RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION,
        engineVersion: RUNTIME_V2_ENGINE_VERSION,
        revision: checkpoint.revision,
        owner: checkpoint.owner,
        events: checkpoint.events,
        aggregateDigest: checkpoint.aggregateDigest,
        updatedAt: checkpoint.updatedAt,
        ...(checkpoint.migratedFrom
          ? { migratedFrom: checkpoint.migratedFrom }
          : {}),
        ...(checkpoint.migrationDisposition
          ? { migrationDisposition: checkpoint.migrationDisposition }
          : {}),
      } satisfies RuntimeV2PersistedCheckpointV5,
    ]),
  );
  for (const [turnId, checkpoint] of Object.entries(normalized)) {
    const saved = persisted[turnId];
    assertRuntimeV2CheckpointPersistable(checkpoint);
    if (!saved || saved.events !== checkpoint.events || saved.events.length !== checkpoint.events.length ||
      saved.aggregateDigest !== checkpoint.aggregateDigest || !sameOwner(saved.owner, checkpoint.owner)) {
      throw new RuntimeV2CheckpointWriteBoundaryError("checkpoint_persist_failed");
    }
  }
  return persisted;
}

export type AppendRuntimeV2CheckpointResult =
  | { readonly disposition: "committed"; readonly checkpoint: RuntimeV2CheckpointV3 }
  | { readonly disposition: "idempotent"; readonly checkpoint: RuntimeV2CheckpointV3 }
  | { readonly disposition: "conflict"; readonly checkpoint: null };

/** Pure CAS append used by the Store port and deterministic tests. */
export function appendRuntimeV2Checkpoint(input: {
  readonly checkpoint: RuntimeV2CheckpointV3 | null;
  readonly owner: RuntimeV2TurnIdentity;
  readonly expectedRevision: number;
  readonly event: RuntimeV2Event;
}): AppendRuntimeV2CheckpointResult {
  const current = input.checkpoint;
  if (current && !sameOwner(current.owner, input.owner)) {
    return { disposition: "conflict", checkpoint: null };
  }
  const revision = current?.revision || 0;
  if (revision !== input.expectedRevision) {
    const existing = current?.events.find((event) => event.eventId === input.event.eventId);
    if (existing && sameJson(existing, input.event)) {
      return { disposition: "idempotent", checkpoint: current! };
    }
    return { disposition: "conflict", checkpoint: null };
  }
  const previous = current?.aggregate || null;
  const transition = tryTransition(previous, input.event);
  if (transition.disposition === "rejected") return { disposition: "conflict", checkpoint: null };
  return {
    disposition: "committed",
    checkpoint: createRuntimeV2Checkpoint({
      revision: revision + 1,
      aggregate: transition.state,
      updatedAt: input.event.at,
    }),
  };
}

function sameEmergencyEnvelope(
  left: RuntimeV2EmergencyTerminalEnvelopeV1,
  right: RuntimeV2EmergencyTerminalEnvelopeV1,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    sameOwner(left.owner, right.owner) &&
    sameRuntimeV2EmergencyTerminalRun(left.run, right.run) &&
    left.resultKind === right.resultKind &&
    left.reasonCode === right.reasonCode &&
    left.reason === right.reason &&
    left.at === right.at &&
    left.lastRevision === right.lastRevision &&
    left.hasMutation === right.hasMutation;
}

export type CommitRuntimeV2EmergencyTerminalEnvelopeResult =
  | {
      readonly disposition: "committed" | "idempotent";
      readonly envelope: RuntimeV2EmergencyTerminalEnvelopeV1;
    }
  | {
      readonly disposition: "conflict";
      readonly envelope: null;
    };

/** Pure owner/revision CAS shared by the Store adapter and pressure tests. */
export function commitRuntimeV2EmergencyTerminalEnvelope(input: {
  readonly checkpoint: RuntimeV2CheckpointV3 | null;
  readonly currentEnvelope: RuntimeV2EmergencyTerminalEnvelopeV1 | null;
  readonly owner: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly expectedRevision: number;
  readonly envelope: RuntimeV2EmergencyTerminalEnvelopeV1;
}): CommitRuntimeV2EmergencyTerminalEnvelopeResult {
  const envelope = normalizeRuntimeV2EmergencyTerminalEnvelope(
    input.envelope,
    input.owner,
  );
  if (
    !envelope ||
    !sameRuntimeV2EmergencyTerminalRun(envelope.run, input.run) ||
    envelope.lastRevision !== input.expectedRevision
  ) {
    return { disposition: "conflict", envelope: null };
  }
  if (input.currentEnvelope) {
    return sameEmergencyEnvelope(input.currentEnvelope, envelope)
      ? { disposition: "idempotent", envelope: input.currentEnvelope }
      : { disposition: "conflict", envelope: null };
  }
  const checkpoint = input.checkpoint;
  const checkpointIsFullyTerminal = !!checkpoint?.aggregate.terminalOutcome &&
    checkpoint.aggregate.finalProjectionId ===
      checkpoint.aggregate.terminalOutcome.finalProjectionId &&
    checkpoint.aggregate.events.some((event) =>
      event.type === "turn.completed"
    );
  if (
    (!checkpoint && input.expectedRevision !== 0) ||
    (
      checkpoint &&
      (
        !sameOwner(checkpoint.owner, input.owner) ||
        checkpoint.revision !== input.expectedRevision ||
        checkpointIsFullyTerminal ||
        (checkpoint.aggregate.run
          ? !sameRuntimeV2EmergencyTerminalRun(
              checkpoint.aggregate.run.identity,
              input.run,
            )
          // Stop can exhaust the size budget while appending run.started to
          // an admitted Turn. Only this canceled envelope may establish its
          // first Run identity; normalization already binds it to the owner.
          : envelope.resultKind !== "canceled" ||
            envelope.reasonCode !== "checkpoint_size_budget_exceeded")
      )
    )
  ) {
    return { disposition: "conflict", envelope: null };
  }
  return { disposition: "committed", envelope };
}
