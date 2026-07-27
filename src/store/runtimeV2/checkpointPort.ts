import {
  appendRuntimeV2Checkpoint,
  normalizeRuntimeV2Checkpoint,
  normalizeRuntimeV2CheckpointMap,
  type CheckpointPort,
  type RuntimeV2CheckpointV3,
  type RuntimeV2Event,
  type RuntimeV2TurnIdentity,
} from "../../lib/runtime-v2";
import { persistSubmitRuntimeProjection } from "../persistSubmitRuntimeProjection";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2CheckpointStoreAdapterInput {
  readonly get: StoreGet;
  readonly set: StoreSet;
  readonly scopeKey: string;
  readonly sessionId: number | null | undefined;
  readonly getSessionRevisionToken: () => unknown;
  readonly sanitizeTaskBlocksForPersist: (blocks: any[]) => any[];
  readonly normalizeSessionRuntimeSnapshot: (snapshot: Record<string, unknown>) => unknown;
  readonly persistSessionRecord: (scopeKey: string, session: unknown) => Promise<unknown>;
  readonly publishOwnerScopedRuntimeProjection: (input: {
    projectedState: any;
    durableState?: any;
    scopeKey: string;
    sessionId: number | string | null | undefined;
    expectedRevisionToken: unknown;
  }) => { published: boolean; disposition: string };
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

function checkpointMapFor(state: any) {
  // The map is keyed by Turn id.  Never normalize it with a particular Turn
  // owner here: doing so silently discards valid checkpoints belonging to
  // other Turns when the current Turn appends its next event.
  return normalizeRuntimeV2CheckpointMap(state?.runtimeV2Checkpoints);
}

function checkpointForOwner(state: any, owner: RuntimeV2TurnIdentity): RuntimeV2CheckpointV3 | null {
  const candidate = checkpointMapFor(state)[owner.turnId];
  return normalizeRuntimeV2Checkpoint(candidate, owner);
}

function runIdForEvent(event: RuntimeV2Event): string | null {
  return "run" in event ? event.run.runId : null;
}

/**
 * Store-side CAS port. Runtime v2 itself never sees Zustand, Session records,
 * or IPC; this adapter persists each ledger append before the controller can
 * execute the corresponding effect.
 */
export function createRuntimeV2CheckpointPort(
  input: RuntimeV2CheckpointStoreAdapterInput,
): CheckpointPort {
  return {
    async load({ owner }) {
      return checkpointForOwner(input.get(), owner);
    },

    async append({ owner, expectedRevision, event }) {
      const state = input.get();
      const checkpoints = checkpointMapFor(state);
      const current = checkpointForOwner(state, owner);
      const appended = appendRuntimeV2Checkpoint({
        checkpoint: current,
        owner,
        expectedRevision,
        event,
      });
      if (appended.disposition !== "committed") {
        return appended.disposition === "idempotent"
          ? { disposition: "idempotent" as const, checkpoint: appended.checkpoint }
          : { disposition: "conflict" as const, checkpoint: null };
      }

      const expectedStoreRevision = input.getSessionRevisionToken();
      const projectedState = {
        ...state,
        runtimeV2Checkpoints: {
          ...checkpoints,
          [owner.turnId]: appended.checkpoint,
        },
      };
      try {
        const durableState = await persistSubmitRuntimeProjection({
          state: projectedState,
          scopeKey: input.scopeKey,
          sessionId: input.sessionId,
          sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
          buildRuntimeSnapshot: (candidate) => input.normalizeSessionRuntimeSnapshot(candidate),
          persistSessionRecord: input.persistSessionRecord,
        });
        const published = input.publishOwnerScopedRuntimeProjection({
          projectedState,
          durableState,
          scopeKey: input.scopeKey,
          sessionId: input.sessionId,
          expectedRevisionToken: expectedStoreRevision,
        });
        if (!published.published) {
          input.logStoreEvent("runtime_v2_checkpoint_projection_conflict", {
            turnId: owner.turnId,
            revision: appended.checkpoint.revision,
            disposition: published.disposition,
          });
          return { disposition: "conflict" as const, checkpoint: null };
        }
        // This is deliberately emitted only after the durable snapshot and
        // owner-scoped publication both succeed. It lets a debug trace prove
        // that a side-effect fence existed without serializing model prose or
        // tool output into the log.
        input.logStoreEvent("runtime_v2_ledger_committed", {
          turnId: owner.turnId,
          runId: runIdForEvent(event),
          eventType: event.type,
          sequence: event.sequence,
          revision: appended.checkpoint.revision,
          sideEffectFence: event.type === "command.scheduled",
        });
        return { disposition: "committed" as const, checkpoint: appended.checkpoint };
      } catch (error) {
        input.logStoreEvent("runtime_v2_checkpoint_persist_failed", {
          turnId: owner.turnId,
          revision: appended.checkpoint.revision,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

export function getRuntimeV2Checkpoint(
  state: unknown,
  owner: RuntimeV2TurnIdentity,
): RuntimeV2CheckpointV3 | null {
  return checkpointForOwner(state, owner);
}

/** Narrow type-only guard used by adapter tests without importing a Store. */
export function isRuntimeV2CheckpointEvent(value: unknown): value is RuntimeV2Event {
  return !!value && typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { eventId?: unknown }).eventId === "string";
}
