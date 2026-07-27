import {
  readFile,
  writeFileAtomic,
  writeFileCreateNew,
} from "../../lib/ipc";
import {
  isGoalRuntimeDeleted,
  resolveGoalRuntimeRelativeDirPath,
} from "../../lib/goalPersistence";
import { sha256Hex } from "../../lib/sha256";
import type { RuntimeV2GoalOwnerIdentity } from "../../lib/runtime-v2";
import {
  deserializeRuntimeV2GoalSagaCheckpoint,
  normalizeRuntimeV2GoalSagaCheckpoint,
  RUNTIME_V2_GOAL_SAGA_CHECKPOINT_SCHEMA_VERSION,
  serializeRuntimeV2GoalSagaCheckpoint,
  type RuntimeV2GoalSagaCheckpoint,
  type RuntimeV2GoalSagaCheckpointPort,
} from "./goalRunner";

export const RUNTIME_V2_GOAL_SAGA_FILE_PREFIX = "runtime-v2-saga";

export interface RuntimeV2GoalCheckpointFileIo {
  readonly read: (
    path: string,
    workspace: string,
  ) => Promise<string | null>;
  readonly create: (
    path: string,
    content: string,
    workspace: string,
  ) => Promise<void>;
  readonly replace: (
    path: string,
    content: string,
    workspace: string,
  ) => Promise<void>;
}

export interface RuntimeV2GoalCheckpointFilePortInput {
  readonly workspace: string;
  readonly io?: RuntimeV2GoalCheckpointFileIo;
  readonly isDeleted?: (workspace: string, goalId: string) => boolean;
}

const ownerQueues = new Map<string, Promise<void>>();

function ownerKey(
  workspace: string,
  owner: RuntimeV2GoalOwnerIdentity,
): string {
  return [
    workspace,
    owner.sessionKey,
    owner.sessionEpoch,
    owner.goalId,
    owner.goalRevision,
    owner.ownerTurnId,
  ].join("\u0000");
}

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = ownerQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  ownerQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (ownerQueues.get(key) === tail) ownerQueues.delete(key);
  }
}

function checkpointPath(owner: RuntimeV2GoalOwnerIdentity): string {
  const ownerDigest = sha256Hex([
    owner.sessionKey,
    owner.sessionEpoch,
    owner.ownerTurnId,
    owner.goalRevision,
  ].join("\u0000")).slice(0, 24);
  return `${resolveGoalRuntimeRelativeDirPath(owner.goalId)}/${RUNTIME_V2_GOAL_SAGA_FILE_PREFIX}-${ownerDigest}.json`;
}

function defaultIo(): RuntimeV2GoalCheckpointFileIo {
  return {
    async read(path, workspace) {
      try {
        return await readFile(path, workspace);
      } catch {
        // A first writer still uses CREATE_NEW. An existing unreadable or
        // corrupt file therefore fails closed instead of being overwritten.
        return null;
      }
    },
    create: (path, content, workspace) =>
      writeFileCreateNew(path, content, workspace),
    replace: (path, content, workspace) =>
      writeFileAtomic(path, content, workspace),
  };
}

function sameState(
  left: RuntimeV2GoalSagaCheckpoint,
  rightState: RuntimeV2GoalSagaCheckpoint["state"],
): boolean {
  return JSON.stringify(left.state) === JSON.stringify(rightState);
}

async function readCheckpoint(input: {
  readonly io: RuntimeV2GoalCheckpointFileIo;
  readonly path: string;
  readonly workspace: string;
  readonly owner: RuntimeV2GoalOwnerIdentity;
}): Promise<RuntimeV2GoalSagaCheckpoint | null> {
  const source = await input.io.read(input.path, input.workspace);
  if (source == null) return null;
  const checkpoint = deserializeRuntimeV2GoalSagaCheckpoint(source, input.owner);
  if (!checkpoint) {
    throw new Error("RUNTIME_V2_GOAL_CHECKPOINT_CORRUPT_OR_FOREIGN");
  }
  return checkpoint;
}

/**
 * Crash-safe Goal saga persistence. The v2 file is independent from legacy
 * state.json: legacy remains a read-only migration source, never a write sink.
 *
 * The in-process owner queue closes read/write races; CREATE_NEW prevents a
 * failed first read from overwriting an existing checkpoint.
 */
export function createRuntimeV2GoalCheckpointFilePort(
  input: RuntimeV2GoalCheckpointFilePortInput,
): RuntimeV2GoalSagaCheckpointPort {
  const workspace = String(input.workspace || "").trim();
  if (!workspace) throw new Error("RUNTIME_V2_GOAL_WORKSPACE_REQUIRED");
  const io = input.io || defaultIo();
  const deleted = input.isDeleted || isGoalRuntimeDeleted;
  return {
    async load({ owner }) {
      if (deleted(workspace, owner.goalId)) return null;
      return readCheckpoint({
        io,
        path: checkpointPath(owner),
        workspace,
        owner,
      });
    },

    async commit({ owner, expectedRevision, state }) {
      const path = checkpointPath(owner);
      return serialized(ownerKey(workspace, owner), async () => {
        if (deleted(workspace, owner.goalId)) {
          return { disposition: "conflict" as const, checkpoint: null };
        }
        const current = await readCheckpoint({
          io,
          path,
          workspace,
          owner,
        });
        if (current) {
          if (sameState(current, state)) {
            return { disposition: "idempotent" as const, checkpoint: current };
          }
          if (current.revision !== expectedRevision) {
            return { disposition: "conflict" as const, checkpoint: current };
          }
          const checkpoint: RuntimeV2GoalSagaCheckpoint = {
            schemaVersion: RUNTIME_V2_GOAL_SAGA_CHECKPOINT_SCHEMA_VERSION,
            revision: current.revision + 1,
            owner,
            state,
          };
          if (deleted(workspace, owner.goalId)) {
            return { disposition: "conflict" as const, checkpoint: null };
          }
          await io.replace(
            path,
            serializeRuntimeV2GoalSagaCheckpoint(checkpoint),
            workspace,
          );
          return { disposition: "committed" as const, checkpoint };
        }
        if (expectedRevision !== 0) {
          return { disposition: "conflict" as const, checkpoint: null };
        }
        const checkpoint: RuntimeV2GoalSagaCheckpoint = {
          schemaVersion: RUNTIME_V2_GOAL_SAGA_CHECKPOINT_SCHEMA_VERSION,
          revision: 1,
          owner,
          state,
        };
        try {
          await io.create(
            path,
            serializeRuntimeV2GoalSagaCheckpoint(checkpoint),
            workspace,
          );
          return { disposition: "committed" as const, checkpoint };
        } catch (createError) {
          // Another writer may have won CREATE_NEW. Re-read and return an
          // ordinary CAS result; unreadable existing state remains an error.
          const raced = await readCheckpoint({
            io,
            path,
            workspace,
            owner,
          });
          if (!raced) throw createError;
          return sameState(raced, state)
            ? { disposition: "idempotent" as const, checkpoint: raced }
            : { disposition: "conflict" as const, checkpoint: raced };
        }
      });
    },
  };
}

export function resolveRuntimeV2GoalSagaFilePath(
  owner: RuntimeV2GoalOwnerIdentity,
): string {
  return checkpointPath(owner);
}

export function isRuntimeV2GoalSagaFileCheckpoint(
  value: unknown,
  owner: RuntimeV2GoalOwnerIdentity,
): value is RuntimeV2GoalSagaCheckpoint {
  return normalizeRuntimeV2GoalSagaCheckpoint(value, owner) !== null;
}
