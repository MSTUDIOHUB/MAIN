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

export class ProjectSessionStaleWriteFencedError extends Error {
  readonly code = "project_session_stale_write_fenced";

  constructor() {
    super("Project Session persistence was superseded by a newer runtime revision.");
    this.name = "ProjectSessionStaleWriteFencedError";
  }
}

export const DEFAULT_PROJECT_SESSION_SAVE_SETTLEMENT_TIMEOUT_MS = 5_000;
const DEFAULT_PROJECT_SESSION_DEADLINE_LEAD_MS = 100;

export class ProjectSessionSaveTimedOutError extends Error {
  readonly code = "project_session_save_timed_out";
  readonly ownerKey: string;
  readonly mutationDeadlineMs: number;

  constructor(ownerKey: string, mutationDeadlineMs: number) {
    super("Project Session persistence exceeded its bounded mutation lease.");
    this.name = "ProjectSessionSaveTimedOutError";
    this.ownerKey = ownerKey;
    this.mutationDeadlineMs = mutationDeadlineMs;
  }
}

export interface ProjectSessionSaveLease {
  /**
   * Rust must reject the CAS transaction if it cannot commit before this
   * timestamp. The JavaScript owner queue settles only after this deadline,
   * so a timed-out write cannot cross a later save/delete/clear mutation.
   */
  mutationDeadlineMs: number;
  /**
   * A previous mutation had an ambiguous response. The next writer must read
   * the authoritative Rust revision before selecting its expected CAS value.
   */
  revisionReconciliationRequired: boolean;
}

export interface ProjectSessionSaveOptions {
  /**
   * Evaluated only after this owner reaches the head of its mutation queue.
   * This closes the gap where a newer runtime revision is published while an
   * older debounced save is waiting behind another durable mutation.
   */
  isCurrent?: () => boolean;
  /** Primarily exposed for deterministic tests; production uses the default. */
  settlementTimeoutMs?: number;
}

export interface ProjectSessionMutationCoordinatorOptions {
  saveSettlementTimeoutMs?: number;
  deadlineLeadMs?: number;
}

/**
 * A `persisting` queue entry is an uncommitted admission projection. Only the
 * exact admission transaction that owns its receipt may serialize it; every
 * generic autosave/Goal/session mutation must wait for a later clean snapshot.
 */
export function isProjectSessionAdmissionProjectionOwned(
  session: unknown,
  allowedReceiptId?: string,
): boolean {
  const entries = (session as any)?.runtimeSnapshot?.workspaceTurnQueue?.entries;
  if (!Array.isArray(entries)) return true;
  const persisting = entries.filter((entry: any) => entry?.status === "persisting");
  if (persisting.length === 0) return true;
  const exactReceiptId = String(allowedReceiptId || "").trim();
  return !!exactReceiptId &&
    persisting.length === 1 &&
    persisting[0]?.receipt?.receiptId === exactReceiptId;
}

export interface ProjectSessionMutationCoordinator {
  save<T>(
    ownerKey: string,
    task: (lease: ProjectSessionSaveLease) => Promise<T>,
    options?: ProjectSessionSaveOptions,
  ): Promise<T>;
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
 * soon as deletion is requested. Each save receives a Rust-enforced mutation
 * deadline that closes before its bounded JavaScript queue lease releases;
 * deletion therefore runs only after the old writer can no longer commit.
 * Saves that have not started are rejected before they reach IPC.
 */
export function createProjectSessionMutationCoordinator(
  queue: KeyedAsyncQueue = createKeyedAsyncQueue(),
  options: ProjectSessionMutationCoordinatorOptions = {},
): ProjectSessionMutationCoordinator {
  const ownerFenceClaims = new Map<string, Set<string>>();
  const activeDeletes = new Map<string, Promise<unknown>>();
  const activeWorkspaceClears = new Map<string, ActiveWorkspaceClear>();
  const knownOwnersByWorkspace = new Map<string, Set<string>>();
  const workspaceMutations = new Map<string, Set<Promise<unknown>>>();
  const mutationGenerationByOwner = new Map<string, number>();
  const uncertainRevisionGenerationByOwner = new Map<string, number>();
  const authoritativeRevisionGenerationByOwner = new Map<string, number>();
  let fenceSequence = 0;

  const normalizeTimeoutMs = (value: unknown): number => {
    const configured = Number(value);
    return Number.isFinite(configured)
      ? Math.max(1, Math.min(60_000, Math.trunc(configured)))
      : DEFAULT_PROJECT_SESSION_SAVE_SETTLEMENT_TIMEOUT_MS;
  };
  const defaultSaveSettlementTimeoutMs = normalizeTimeoutMs(
    options.saveSettlementTimeoutMs,
  );
  const configuredDeadlineLeadMs = Number(options.deadlineLeadMs);
  const deadlineLeadMs = Number.isFinite(configuredDeadlineLeadMs)
    ? Math.max(0, Math.min(1_000, Math.trunc(configuredDeadlineLeadMs)))
    : DEFAULT_PROJECT_SESSION_DEADLINE_LEAD_MS;
  const nextMutationGeneration = (ownerKey: string): number => {
    const generation = (mutationGenerationByOwner.get(ownerKey) || 0) + 1;
    mutationGenerationByOwner.set(ownerKey, generation);
    return generation;
  };
  const markRevisionUncertain = (ownerKey: string, generation: number) => {
    // Once generation N has produced an authoritative CAS response, a late
    // rejection from an older generation cannot make the owner uncertain
    // again or force unrelated future saves through a stale recovery path.
    if ((authoritativeRevisionGenerationByOwner.get(ownerKey) || 0) >= generation) {
      return;
    }
    uncertainRevisionGenerationByOwner.set(
      ownerKey,
      Math.max(uncertainRevisionGenerationByOwner.get(ownerKey) || 0, generation),
    );
  };
  const markMutationAuthoritative = (ownerKey: string, generation: number) => {
    authoritativeRevisionGenerationByOwner.set(
      ownerKey,
      Math.max(authoritativeRevisionGenerationByOwner.get(ownerKey) || 0, generation),
    );
    const uncertainGeneration = uncertainRevisionGenerationByOwner.get(ownerKey) || 0;
    // A late response from generation N must not clear uncertainty introduced
    // by a newer timed-out generation N + 1.
    if (uncertainGeneration > 0 && uncertainGeneration <= generation) {
      uncertainRevisionGenerationByOwner.delete(ownerKey);
    }
  };

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
    save<T>(
      ownerKey: string,
      task: (lease: ProjectSessionSaveLease) => Promise<T>,
      options: ProjectSessionSaveOptions = {},
    ): Promise<T> {
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
        if (options.isCurrent && !options.isCurrent()) {
          throw new ProjectSessionStaleWriteFencedError();
        }
        const generation = nextMutationGeneration(normalizedOwnerKey);
        const settlementTimeoutMs = normalizeTimeoutMs(
          options.settlementTimeoutMs ?? defaultSaveSettlementTimeoutMs,
        );
        // Close Rust's write window before the JavaScript queue releases. The
        // small lead avoids timer jitter opening a delete/late-write race.
        const effectiveLeadMs = Math.min(
          deadlineLeadMs,
          Math.max(0, settlementTimeoutMs - 1),
        );
        const mutationDeadlineMs = Date.now() + settlementTimeoutMs - effectiveLeadMs;
        const lease: ProjectSessionSaveLease = {
          mutationDeadlineMs,
          revisionReconciliationRequired:
            (uncertainRevisionGenerationByOwner.get(normalizedOwnerKey) || 0) > 0,
        };
        let taskPromise: Promise<T>;
        try {
          taskPromise = Promise.resolve(task(lease));
        } catch (error) {
          markRevisionUncertain(normalizedOwnerKey, generation);
          throw error;
        }

        // Observe the underlying invoke even after the bounded queue lease has
        // settled. Generation ordering prevents an older late response from
        // clearing uncertainty owned by a newer mutation.
        void taskPromise.then(
          () => markMutationAuthoritative(normalizedOwnerKey, generation),
          () => markRevisionUncertain(normalizedOwnerKey, generation),
        );

        return new Promise<T>((resolve, reject) => {
          let settled = false;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback();
          };
          const timer = setTimeout(() => finish(() => {
            markRevisionUncertain(normalizedOwnerKey, generation);
            reject(new ProjectSessionSaveTimedOutError(
              normalizedOwnerKey,
              mutationDeadlineMs,
            ));
          }), settlementTimeoutMs);
          taskPromise.then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error)),
          );
        });
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
