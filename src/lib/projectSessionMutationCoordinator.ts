import {
  createKeyedAsyncQueue,
  type KeyedAsyncQueue,
} from "./keyedAsyncQueue";

export const PROJECT_SESSION_DELETE_FENCED = "project_session_delete_fenced";
export const PROJECT_SESSION_WORKSPACE_CLEAR_FENCED = "project_session_workspace_clear_fenced";

export class ProjectSessionDeleteFencedError extends Error {
  readonly code = PROJECT_SESSION_DELETE_FENCED;

  constructor() {
    super("Project Session persistence is fenced because deletion has started.");
    this.name = "ProjectSessionDeleteFencedError";
  }
}

export class ProjectSessionWorkspaceClearFencedError extends Error {
  readonly code = PROJECT_SESSION_WORKSPACE_CLEAR_FENCED;

  constructor() {
    super("Project Session persistence is fenced because workspace history clearing has started.");
    this.name = "ProjectSessionWorkspaceClearFencedError";
  }
}

export interface ProjectSessionMutationCoordinator {
  save<T>(ownerKey: string, task: () => Promise<T>): Promise<T>;
  delete<T>(ownerKey: string, task: () => Promise<T>): Promise<T>;
  clear<T>(workspaceKey: string, ownerKeys: readonly string[], task: () => Promise<T>): Promise<T>;
  isDeleteFenced(ownerKey: string): boolean;
  isWorkspaceClearFenced(workspaceKey: string): boolean;
}

function normalizeOwnerKey(ownerKey: string): string {
  return String(ownerKey || "").trim() || "__default__";
}

function normalizeWorkspaceKey(workspaceKey: string): string {
  return String(workspaceKey || "").trim() || "__default_workspace__";
}

function resolveOwnerWorkspaceKey(ownerKey: string): string {
  const separatorIndex = ownerKey.lastIndexOf("\u0000");
  return normalizeWorkspaceKey(separatorIndex >= 0 ? ownerKey.slice(0, separatorIndex) : "");
}

interface ActiveWorkspaceClear {
  token: string;
  claimedOwners: Set<string>;
  promise: Promise<unknown>;
}

/**
 * Serialize durable mutations for one Project Session and fence stale saves as
 * soon as deletion is requested. An already-running save may finish, but the
 * shared owner queue guarantees that deletion runs after it. Saves that have
 * not started are rejected by the fence before they reach IPC.
 */
export function createProjectSessionMutationCoordinator(
  queue: KeyedAsyncQueue = createKeyedAsyncQueue(),
): ProjectSessionMutationCoordinator {
  const ownerFenceClaims = new Map<string, Set<string>>();
  const activeDeletes = new Map<string, Promise<unknown>>();
  const activeWorkspaceClears = new Map<string, ActiveWorkspaceClear>();
  const knownOwnersByWorkspace = new Map<string, Set<string>>();
  const workspaceMutations = new Map<string, Set<Promise<unknown>>>();
  let fenceSequence = 0;

  const hasOwnerFence = (ownerKey: string) => (ownerFenceClaims.get(ownerKey)?.size || 0) > 0;
  const rememberOwner = (workspaceKey: string, ownerKey: string) => {
    const owners = knownOwnersByWorkspace.get(workspaceKey) || new Set<string>();
    owners.add(ownerKey);
    knownOwnersByWorkspace.set(workspaceKey, owners);
  };
  const claimOwnerFence = (ownerKey: string, token: string) => {
    const claims = ownerFenceClaims.get(ownerKey) || new Set<string>();
    claims.add(token);
    ownerFenceClaims.set(ownerKey, claims);
  };
  const releaseOwnerFence = (ownerKey: string, token: string) => {
    const claims = ownerFenceClaims.get(ownerKey);
    if (!claims) return;
    claims.delete(token);
    if (claims.size === 0) ownerFenceClaims.delete(ownerKey);
  };
  const claimOwnerForActiveClear = (workspaceKey: string, ownerKey: string) => {
    const activeClear = activeWorkspaceClears.get(workspaceKey);
    if (!activeClear) return false;
    activeClear.claimedOwners.add(ownerKey);
    claimOwnerFence(ownerKey, activeClear.token);
    return true;
  };
  const trackWorkspaceMutation = <T>(workspaceKey: string, mutation: Promise<T>): Promise<T> => {
    const mutations = workspaceMutations.get(workspaceKey) || new Set<Promise<unknown>>();
    mutations.add(mutation);
    workspaceMutations.set(workspaceKey, mutations);
    const removeMutation = () => {
      const current = workspaceMutations.get(workspaceKey);
      current?.delete(mutation);
      if (current?.size === 0) workspaceMutations.delete(workspaceKey);
    };
    void mutation.then(removeMutation, removeMutation);
    return mutation;
  };

  return {
    save<T>(ownerKey: string, task: () => Promise<T>): Promise<T> {
      const normalizedOwnerKey = normalizeOwnerKey(ownerKey);
      const workspaceKey = resolveOwnerWorkspaceKey(normalizedOwnerKey);
      rememberOwner(workspaceKey, normalizedOwnerKey);
      if (claimOwnerForActiveClear(workspaceKey, normalizedOwnerKey)) {
        return Promise.reject(new ProjectSessionWorkspaceClearFencedError());
      }
      if (hasOwnerFence(normalizedOwnerKey)) {
        return Promise.reject(new ProjectSessionDeleteFencedError());
      }
      const mutation = queue.run(normalizedOwnerKey, () => {
        if (claimOwnerForActiveClear(workspaceKey, normalizedOwnerKey)) {
          throw new ProjectSessionWorkspaceClearFencedError();
        }
        if (hasOwnerFence(normalizedOwnerKey)) {
          throw new ProjectSessionDeleteFencedError();
        }
        return task();
      });
      return trackWorkspaceMutation(workspaceKey, mutation);
    },

    delete<T>(ownerKey: string, task: () => Promise<T>): Promise<T> {
      const normalizedOwnerKey = normalizeOwnerKey(ownerKey);
      const workspaceKey = resolveOwnerWorkspaceKey(normalizedOwnerKey);
      rememberOwner(workspaceKey, normalizedOwnerKey);
      if (claimOwnerForActiveClear(workspaceKey, normalizedOwnerKey)) {
        return Promise.reject(new ProjectSessionWorkspaceClearFencedError());
      }
      const activeDelete = activeDeletes.get(normalizedOwnerKey);
      if (activeDelete) return activeDelete as Promise<T>;

      // Establish the tombstone synchronously, before the delete enters the
      // async owner queue, so no later caller can enqueue an unfenced save.
      const deleteToken = `delete:${++fenceSequence}`;
      claimOwnerFence(normalizedOwnerKey, deleteToken);
      const mutation = queue.run(normalizedOwnerKey, task);
      const settled = mutation.then(
        (result) => result,
        (error) => {
          releaseOwnerFence(normalizedOwnerKey, deleteToken);
          throw error;
        },
      );
      activeDeletes.set(normalizedOwnerKey, settled);
      const clearActiveDelete = () => {
        if (activeDeletes.get(normalizedOwnerKey) === settled) {
          activeDeletes.delete(normalizedOwnerKey);
        }
      };
      void settled.then(clearActiveDelete, clearActiveDelete);
      return trackWorkspaceMutation(workspaceKey, settled);
    },

    clear<T>(workspaceKey: string, ownerKeys: readonly string[], task: () => Promise<T>): Promise<T> {
      const normalizedWorkspaceKey = normalizeWorkspaceKey(workspaceKey);
      const requestedOwners = ownerKeys.map(normalizeOwnerKey);
      const activeClear = activeWorkspaceClears.get(normalizedWorkspaceKey);
      if (activeClear) {
        requestedOwners.forEach((ownerKey) => {
          rememberOwner(normalizedWorkspaceKey, ownerKey);
          activeClear.claimedOwners.add(ownerKey);
          claimOwnerFence(ownerKey, activeClear.token);
        });
        return activeClear.promise as Promise<T>;
      }

      const clearToken = `workspace-clear:${++fenceSequence}`;
      const claimedOwners = new Set<string>([
        ...(knownOwnersByWorkspace.get(normalizedWorkspaceKey) || []),
        ...requestedOwners,
      ]);
      claimedOwners.forEach((ownerKey) => {
        rememberOwner(normalizedWorkspaceKey, ownerKey);
        claimOwnerFence(ownerKey, clearToken);
      });

      // Publish the active clear synchronously. Later saves are rejected and
      // dynamically tombstoned before any asynchronous work can start.
      const record: ActiveWorkspaceClear = {
        token: clearToken,
        claimedOwners,
        promise: Promise.resolve(undefined),
      };
      activeWorkspaceClears.set(normalizedWorkspaceKey, record);
      const pendingMutations = Array.from(workspaceMutations.get(normalizedWorkspaceKey) || []);
      const mutation = Promise.allSettled(pendingMutations).then(task);
      const settled = mutation.then(
        (result) => result,
        (error) => {
          record.claimedOwners.forEach((ownerKey) => releaseOwnerFence(ownerKey, clearToken));
          throw error;
        },
      );
      record.promise = settled;
      const releaseWorkspaceFence = () => {
        if (activeWorkspaceClears.get(normalizedWorkspaceKey) === record) {
          activeWorkspaceClears.delete(normalizedWorkspaceKey);
        }
      };
      void settled.then(releaseWorkspaceFence, releaseWorkspaceFence);
      return settled;
    },

    isDeleteFenced(ownerKey: string): boolean {
      return hasOwnerFence(normalizeOwnerKey(ownerKey));
    },

    isWorkspaceClearFenced(workspaceKey: string): boolean {
      return activeWorkspaceClears.has(normalizeWorkspaceKey(workspaceKey));
    },
  };
}
