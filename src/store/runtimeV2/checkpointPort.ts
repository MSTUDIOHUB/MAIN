import {
  appendRuntimeV2Checkpoint,
  commitRuntimeV2EmergencyTerminalEnvelope,
  normalizeRuntimeV2Checkpoint,
  normalizeRuntimeV2EmergencyTerminalEnvelope,
  normalizeRuntimeV2EmergencyTerminalEnvelopeMap,
  type CheckpointPort,
  type RuntimeV2EmergencyTerminalEnvelopeMap,
  type RuntimeV2EmergencyTerminalEnvelopeV1,
  type RuntimeV2CheckpointV3,
  type RuntimeV2Event,
  type RuntimeV2TurnIdentity,
  RuntimeV2CheckpointWriteBoundaryError,
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
  readonly buildSessionRuntimeSnapshot: (state: Record<string, unknown>) => unknown;
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

function emergencyEnvelopeMapFor(
  state: any,
): RuntimeV2EmergencyTerminalEnvelopeMap {
  return normalizeRuntimeV2EmergencyTerminalEnvelopeMap(
    state?.runtimeV2EmergencyTerminalEnvelopes,
  );
}

function emergencyEnvelopeForOwner(
  state: any,
  owner: RuntimeV2TurnIdentity,
): RuntimeV2EmergencyTerminalEnvelopeV1 | null {
  return normalizeRuntimeV2EmergencyTerminalEnvelope(
    emergencyEnvelopeMapFor(state)[owner.turnId],
    owner,
  );
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
      if (emergencyEnvelopeForOwner(input.get(), owner)) {
        throw new Error(
          "RUNTIME_V2_EMERGENCY_TERMINAL_ENVELOPE_PRESENT",
        );
      }
      return checkpointForOwner(input.get(), owner);
    },

    async append({ owner, expectedRevision, event }) {
      for (
        let attempt = 1;
        attempt <= CHECKPOINT_PROJECTION_ATTEMPTS;
        attempt += 1
      ) {
        const state = input.get();
        if (emergencyEnvelopeForOwner(state, owner)) {
          return { disposition: "conflict" as const, checkpoint: null };
        }
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
            buildRuntimeSnapshot: (candidate) => input.buildSessionRuntimeSnapshot(candidate),
            persistSessionRecord: input.persistSessionRecord,
          });
        } catch (error) {
          input.logStoreEvent("runtime_v2_checkpoint_persist_failed", {
            turnId: owner.turnId,
            revision: appended.checkpoint.revision,
            error: error instanceof Error ? error.message : String(error),
          });
          throw new RuntimeV2CheckpointWriteBoundaryError(
            "checkpoint_persist_failed",
          );
        }
        const latestState = input.get();
        if (emergencyEnvelopeForOwner(latestState, owner)) {
          return { disposition: "conflict" as const, checkpoint: null };
        }
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
          ...(event.type === "soft_signal.observed"
            ? { signal: event.signal }
            : {}),
          ...(event.type === "recovery.exhausted"
            ? { recoveryScope: event.scope }
            : {}),
          rebasedConcurrentRuntime:
            storeRevisionBeforePersist !== expectedStoreRevision,
        });
        return { disposition: "committed" as const, checkpoint: appended.checkpoint };
      }
      return { disposition: "conflict" as const, checkpoint: null };
    },

    async commitEmergencyTerminal({
      owner,
      run,
      expectedRevision,
      envelope,
    }) {
      for (
        let attempt = 1;
        attempt <= CHECKPOINT_PROJECTION_ATTEMPTS;
        attempt += 1
      ) {
        const state = input.get();
        const currentEnvelope =
          emergencyEnvelopeForOwner(state, owner);
        const committed = commitRuntimeV2EmergencyTerminalEnvelope({
          checkpoint: checkpointForOwner(state, owner),
          currentEnvelope,
          owner,
          run,
          expectedRevision,
          envelope,
        });
        if (committed.disposition !== "committed") {
          return committed;
        }
        const nextEnvelopeMap = {
          ...emergencyEnvelopeMapFor(state),
          [owner.turnId]: committed.envelope,
        };
        const projectedState = {
          ...state,
          runtimeV2EmergencyTerminalEnvelopes: nextEnvelopeMap,
        };
        let durableState: any = projectedState;
        const sessions = state.sessionsByWorkspace?.[input.scopeKey] || [];
        const sessionRecord = input.sessionId == null
          ? null
          : sessions.find((candidate: any) =>
              candidate.id === input.sessionId
            ) || null;
        const shouldPersist =
          input.sessionId != null &&
          state.config?.sessionRecordingEnabled === true &&
          sessionRecord?.recordingDisabled !== true;
        if (shouldPersist) {
          if (!sessionRecord) {
            throw new RuntimeV2CheckpointWriteBoundaryError(
              "checkpoint_persist_failed",
            );
          }
          let saved: any;
          try {
            // This intentionally is a partial Session patch. The Project
            // Session persistence adapter merges it with the last durable
            // snapshot, so recursive live Store state and the oversized
            // checkpoint ledger never enter this emergency write.
            saved = await input.persistSessionRecord(input.scopeKey, {
              id: sessionRecord.id,
              storageRevision: sessionRecord.storageRevision,
              transcriptPartial: true,
              runtimeSnapshot: {
                runtimeV2EmergencyTerminalEnvelopes: nextEnvelopeMap,
              },
            });
          } catch (error) {
            input.logStoreEvent(
              "runtime_v2_emergency_terminal_persist_failed",
              {
                turnId: owner.turnId,
                runId: run.runId,
                lastRevision: expectedRevision,
                reasonCode: envelope.reasonCode,
                error: error instanceof Error
                  ? error.message
                  : String(error),
              },
            );
            throw new RuntimeV2CheckpointWriteBoundaryError(
              "checkpoint_persist_failed",
            );
          }
          durableState = {
            ...projectedState,
            sessionsByWorkspace: {
              ...state.sessionsByWorkspace,
              [input.scopeKey]: sessions.map((candidate: any) =>
                candidate.id === input.sessionId &&
                  saved &&
                  typeof saved === "object"
                  ? { ...candidate, ...saved }
                  : candidate
              ),
            },
          };
        }

        const latestState = input.get();
        const rechecked = commitRuntimeV2EmergencyTerminalEnvelope({
          checkpoint: checkpointForOwner(latestState, owner),
          currentEnvelope:
            emergencyEnvelopeForOwner(latestState, owner),
          owner,
          run,
          expectedRevision,
          envelope,
        });
        if (rechecked.disposition === "idempotent") {
          return rechecked;
        }
        if (rechecked.disposition !== "committed") {
          input.logStoreEvent(
            "runtime_v2_emergency_terminal_projection_conflict",
            {
              turnId: owner.turnId,
              runId: run.runId,
              lastRevision: expectedRevision,
              disposition: "checkpoint_advanced",
              attempt,
            },
          );
          return { disposition: "conflict" as const, envelope: null };
        }
        const rebasedProjectedState = {
          ...latestState,
          runtimeV2EmergencyTerminalEnvelopes: {
            ...emergencyEnvelopeMapFor(latestState),
            [owner.turnId]: committed.envelope,
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
          input.logStoreEvent(
            "runtime_v2_emergency_terminal_projection_conflict",
            {
              turnId: owner.turnId,
              runId: run.runId,
              lastRevision: expectedRevision,
              disposition: published.disposition,
              attempt,
            },
          );
          if (
            published.disposition === "revision_conflict" &&
            attempt < CHECKPOINT_PROJECTION_ATTEMPTS
          ) {
            continue;
          }
          return { disposition: "conflict" as const, envelope: null };
        }
        input.logStoreEvent("runtime_v2_emergency_terminal_committed", {
          turnId: owner.turnId,
          runId: run.runId,
          lastRevision: expectedRevision,
          resultKind: committed.envelope.resultKind,
          reasonCode: committed.envelope.reasonCode,
          hasMutation: committed.envelope.hasMutation,
        });
        return committed;
      }
      return { disposition: "conflict" as const, envelope: null };
    },
  };
}

export function getRuntimeV2Checkpoint(
  state: unknown,
  owner: RuntimeV2TurnIdentity,
): RuntimeV2CheckpointV3 | null {
  return checkpointForOwner(state, owner);
}

export function getRuntimeV2EmergencyTerminalEnvelope(
  state: unknown,
  owner: RuntimeV2TurnIdentity,
): RuntimeV2EmergencyTerminalEnvelopeV1 | null {
  return emergencyEnvelopeForOwner(state, owner);
}

/** Narrow type-only guard used by adapter tests without importing a Store. */
export function isRuntimeV2CheckpointEvent(value: unknown): value is RuntimeV2Event {
  return !!value && typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { eventId?: unknown }).eventId === "string";
}
