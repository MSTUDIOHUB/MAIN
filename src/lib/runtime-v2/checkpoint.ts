import { sha256Hex } from "../sha256";
import {
  RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION,
  RUNTIME_V2_ENGINE_VERSION,
  type RuntimeV2Command,
  type RuntimeV2TurnIdentity,
} from "./contracts";
import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Event } from "./events";
import { tryTransition } from "./reducer";

export const MAX_RUNTIME_V2_CHECKPOINT_EVENTS = 512;
export const MAX_RUNTIME_V2_CHECKPOINT_CHARS = 1_048_576;

export interface RuntimeV2CheckpointV3 {
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
}

export type RuntimeV2CheckpointMap = Record<string, RuntimeV2CheckpointV3>;

export interface CreateRuntimeV2CheckpointInput {
  readonly revision: number;
  readonly aggregate: TurnAggregateV1;
  /** Accepted only when it matches the computed digest; callers do not choose
   * a checkpoint identity. */
  readonly aggregateDigest?: string;
  readonly updatedAt: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
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
  const digest = runtimeV2AggregateDigest(input.aggregate);
  if (!isFinitePositiveInteger(revision) || !isFiniteTimestamp(updatedAt)) {
    throw new Error("Runtime v2 checkpoint revision and updatedAt must be finite.");
  }
  if (input.aggregateDigest && input.aggregateDigest !== digest) {
    throw new Error("Runtime v2 checkpoint aggregate digest mismatch.");
  }
  if (input.aggregate.events.length > MAX_RUNTIME_V2_CHECKPOINT_EVENTS) {
    throw new Error("Runtime v2 checkpoint event budget exceeded.");
  }
  return {
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
}

/**
 * Validate a persisted checkpoint by replay. No legacy/unknown checkpoint is
 * coerced into v3; history remains readable through its original adapter.
 */
export function normalizeRuntimeV2Checkpoint(
  value: unknown,
  expectedOwner?: Partial<RuntimeV2TurnIdentity>,
): RuntimeV2CheckpointV3 | null {
  if (!isPlainRecord(value)) return null;
  try {
    if (JSON.stringify(value).length > MAX_RUNTIME_V2_CHECKPOINT_CHARS) return null;
  } catch {
    return null;
  }
  if (value.schemaVersion !== RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION || value.engineVersion !== RUNTIME_V2_ENGINE_VERSION) {
    return null;
  }
  if (!isFinitePositiveInteger(value.revision) || !isFiniteTimestamp(value.updatedAt) || !isPlainRecord(value.owner)) return null;
  const owner = value.owner as unknown as RuntimeV2TurnIdentity;
  if (![owner.workspaceKey, owner.sessionKey, owner.sessionEpoch, owner.clientSubmissionId, owner.turnId]
    .every((part) => typeof part === "string" && part.trim() === part && part.length > 0)) return null;
  if (expectedOwner && Object.entries(expectedOwner).some(([key, expected]) =>
    expected !== undefined && owner[key as keyof RuntimeV2TurnIdentity] !== expected
  )) return null;
  if (!Array.isArray(value.events)) return null;
  const replayed = replayRuntimeV2Events(value.events as RuntimeV2Event[]);
  if (!replayed || !sameOwner(replayed.turn, owner)) return null;
  const digest = runtimeV2AggregateDigest(replayed);
  if (value.aggregateDigest !== digest || !sameJson(value.aggregate, replayed)) return null;
  if (!sameJson(value.scheduledCommands, replayed.scheduledCommands)) return null;
  if (value.updatedAt < replayed.updatedAt) return null;
  return {
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
}

export function normalizeRuntimeV2CheckpointMap(
  value: unknown,
  expectedOwner?: Partial<RuntimeV2TurnIdentity>,
): RuntimeV2CheckpointMap {
  if (!isPlainRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([turnId, checkpoint]) => [turnId, normalizeRuntimeV2Checkpoint(checkpoint, {
      ...expectedOwner,
      turnId,
    })] as const)
    .filter((entry): entry is [string, RuntimeV2CheckpointV3] => !!entry[1]));
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
