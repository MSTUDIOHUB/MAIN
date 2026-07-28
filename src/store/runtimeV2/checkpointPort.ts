import {
  appendRuntimeV2Checkpoint,
  normalizeRuntimeV2Checkpoint,
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

function checkpointMapFor(state: any): Record<string, unknown> {
  const value = state?.runtimeV2Checkpoints;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function checkpointForOwner(state: any, owner: RuntimeV2TurnIdentity): RuntimeV2CheckpointV3 | null {
  // Only the active Turn crosses the normalization boundary here. Replaying
  // every checkpoint in the session on every ledger append made the live
  // path quadratic as event history grew.
  const candidate = checkpointMapFor(state)[owner.turnId];
  return normalizeRuntimeV2Checkpoint(candidate, owner);
}

function runIdForEvent(event: RuntimeV2Event): string | null {
  return "run" in event ? event.run.runId : null;
}

const CHECKPOINT_PROJECTION_ATTEMPTS = 3;

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
      for (
        let attempt = 1;
        attempt <= CHECKPOINT_PROJECTION_ATTEMPTS;
        attempt += 1
      ) {
        const state = input.get();
        const appended = appendRuntimeV2Checkpoint({
          checkpoint: checkpointForOwner(state, owner),
          owner,
          expectedRevision,
          event,
        });
        if (appended.disposition !== "committed") {
          return appended.disposition === "idempotent"
            ? { disposition: "idempotent" as const, checkpoint: appended.checkpoint }
            : { disposition: "conflict" as const, checkpoint: null };
        }

        const storeRevisionBeforePersist = input.getSessionRevisionToken();
        const projectedState = {
          ...state,
          runtimeV2Checkpoints: {
            ...checkpointMapFor(state),
            [owner.turnId]: appended.checkpoint,
          },
        };
        let durableState: any;
        try {
          durableState = await persistSubmitRuntimeProjection({
            state: projectedState,
            scopeKey: input.scopeKey,
            sessionId: input.sessionId,
            sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
            buildRuntimeSnapshot: (candidate) => input.normalizeSessionRuntimeSnapshot(candidate),
            persistSessionRecord: input.persistSessionRecord,
          });
        } catch (error) {
          input.logStoreEvent("runtime_v2_checkpoint_persist_failed", {
            turnId: owner.turnId,
            revision: appended.checkpoint.revision,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        const latestState = input.get();
        const latestCheckpoint = checkpointForOwner(latestState, owner);
        if (
          latestCheckpoint &&
          latestCheckpoint.revision !== expectedRevision
        ) {
          const alreadyPublished = latestCheckpoint.aggregate.events.some(
            (candidate) => candidate.eventId === event.eventId,
          );
          if (alreadyPublished) {
            return {
              disposition: "idempotent" as const,
              checkpoint: latestCheckpoint,
            };
          }
          input.logStoreEvent("runtime_v2_checkpoint_projection_conflict", {
            turnId: owner.turnId,
            revision: appended.checkpoint.revision,
            disposition: "checkpoint_advanced",
            attempt,
          });
          return { disposition: "conflict" as const, checkpoint: null };
        }

        // Session-local presentation state (for example the one-second
        // elapsed-time tick) may legitimately advance while the durable
        // checkpoint is being written. Rebase only the checkpoint map onto
        // that latest state, then publish synchronously against its current
        // owner token. This preserves concurrent UI fields without weakening
        // the ledger's own expectedRevision fence above.
        const rebasedProjectedState = {
          ...latestState,
          runtimeV2Checkpoints: {
            ...checkpointMapFor(latestState),
            [owner.turnId]: appended.checkpoint,
          },
        };
        const rebasedDurableState = durableState &&
            typeof durableState === "object"
          ? {
              ...rebasedProjectedState,
              ...(durableState.sessionsByWorkspace
                ? { sessionsByWorkspace: durableState.sessionsByWorkspace }
                : {}),
            }
          : undefined;
        const expectedStoreRevision = input.getSessionRevisionToken();
        const published = input.publishOwnerScopedRuntimeProjection({
          projectedState: rebasedProjectedState,
          durableState: rebasedDurableState,
          scopeKey: input.scopeKey,
          sessionId: input.sessionId,
          expectedRevisionToken: expectedStoreRevision,
        });
        if (!published.published) {
          input.logStoreEvent("runtime_v2_checkpoint_projection_conflict", {
            turnId: owner.turnId,
            revision: appended.checkpoint.revision,
            disposition: published.disposition,
            attempt,
          });
          if (
            published.disposition === "revision_conflict" &&
            attempt < CHECKPOINT_PROJECTION_ATTEMPTS
          ) {
            continue;
          }
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
          rebasedConcurrentRuntime:
            storeRevisionBeforePersist !== expectedStoreRevision,
        });
        return { disposition: "committed" as const, checkpoint: appended.checkpoint };
      }
      return { disposition: "conflict" as const, checkpoint: null };
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
