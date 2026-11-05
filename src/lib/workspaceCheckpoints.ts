export interface WorkspaceFileCheckpoint {
  readonly id: string;
  readonly sessionKey: string;
  readonly workspace: string;
  readonly path: string;
  readonly existedBefore: boolean;
  readonly previousContent: string | null;
  readonly toolName: string;
  readonly timestamp: number;
}

const DEFAULT_SESSION_KEY = "__default__";
const checkpointsBySession = new Map<string, WorkspaceFileCheckpoint[]>();
const MaxCheckpointsPerSession = 200;

function normalizeKey(sessionKey?: string | null): string {
  const trimmed = String(sessionKey || "").trim();
  return trimmed || DEFAULT_SESSION_KEY;
}

function normalizePath(path: string): string {
  return String(path || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/**
 * Inspired by gg-framework / ggcoder Checkpoints:
 * Automatically capture a pre-mutation snapshot of any workspace file before
 * `write_file`, `replace_in_file`, or `apply_patch` modifies it on disk.
 * This replaces rigid pre-edit lockouts with safe post-hoc rollback.
 */
export function recordWorkspaceFileCheckpoint(input: {
  readonly sessionKey?: string | null;
  readonly workspace?: string | null;
  readonly path: string;
  readonly existedBefore: boolean;
  readonly previousContent: string | null;
  readonly toolName: string;
}): WorkspaceFileCheckpoint {
  const sessionKey = normalizeKey(input.sessionKey);
  const path = normalizePath(input.path);
  const entry: WorkspaceFileCheckpoint = {
    id: `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionKey,
    workspace: String(input.workspace || "").trim(),
    path,
    existedBefore: input.existedBefore,
    previousContent: input.previousContent,
    toolName: input.toolName,
    timestamp: Date.now(),
  };

  let list = checkpointsBySession.get(sessionKey);
  if (!list) {
    list = [];
    checkpointsBySession.set(sessionKey, list);
  }
  list.push(entry);
  if (list.length > MaxCheckpointsPerSession) {
    list.splice(0, list.length - MaxCheckpointsPerSession);
  }
  return entry;
}

export function listWorkspaceCheckpoints(
  sessionKey?: string | null,
): readonly WorkspaceFileCheckpoint[] {
  return checkpointsBySession.get(normalizeKey(sessionKey)) || [];
}

/**
 * Returns the earliest recorded baseline for a file in the session so a full
 * rewind restores the file to its original state before the agent touched it.
 */
export function getInitialFileBaselineForSession(
  sessionKey: string | null | undefined,
  path: string,
): WorkspaceFileCheckpoint | null {
  const target = normalizePath(path);
  const list = listWorkspaceCheckpoints(sessionKey);
  return list.find((cp) => cp.path === target) || null;
}

export async function rewindWorkspaceCheckpoints(
  sessionKey: string | null | undefined,
  handlers: {
    readonly writeFile: (path: string, content: string) => Promise<void>;
    readonly deletePath?: (path: string) => Promise<void>;
  },
): Promise<{
  readonly restoredPaths: string[];
  readonly deletedPaths: string[];
}> {
  const list = listWorkspaceCheckpoints(sessionKey);
  const earliestByPath = new Map<string, WorkspaceFileCheckpoint>();
  for (const cp of list) {
    if (!earliestByPath.has(cp.path)) {
      earliestByPath.set(cp.path, cp);
    }
  }
  const restoredPaths: string[] = [];
  const deletedPaths: string[] = [];
  for (const [path, baseline] of earliestByPath.entries()) {
    if (baseline.existedBefore && baseline.previousContent !== null) {
      await handlers.writeFile(path, baseline.previousContent);
      restoredPaths.push(path);
    } else if (!baseline.existedBefore && handlers.deletePath) {
      await handlers.deletePath(path);
      deletedPaths.push(path);
    }
  }
  checkpointsBySession.delete(normalizeKey(sessionKey));
  return { restoredPaths, deletedPaths };
}
