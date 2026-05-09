export interface EnsureWorkspaceFileIndexParams {
  workspacePath: string;
  contentVersion: number;
  forceRefresh?: boolean;
}

export interface WorkspaceFileIndexController {
  getCachedFiles: (workspacePath: string, contentVersion: number) => string[] | null;
  ensureLoaded: (params: EnsureWorkspaceFileIndexParams) => Promise<string[]>;
  clearWorkspace: (workspacePath: string) => void;
  clearAll: () => void;
}

export type WorkspaceFileListLoader = (workspacePath: string) => Promise<string[]>;

interface WorkspaceFileCacheEntry {
  contentVersion: number;
  files: string[];
  lastAccessedAt: number;
}

interface WorkspaceFileInflightEntry {
  contentVersion: number;
  promise: Promise<string[]>;
}

export function createWorkspaceFileIndexController(
  loader: WorkspaceFileListLoader,
  options?: { maxEntries?: number },
): WorkspaceFileIndexController {
  const maxEntries = Math.max(1, Number(options?.maxEntries) || 8);
  const cache = new Map<string, WorkspaceFileCacheEntry>();
  const inflight = new Map<string, WorkspaceFileInflightEntry>();

  const touch = (workspacePath: string, entry: WorkspaceFileCacheEntry) => {
    entry.lastAccessedAt = Date.now();
    cache.set(workspacePath, entry);
  };

  const prune = () => {
    if (cache.size <= maxEntries) return;
    const victims = [...cache.entries()]
      .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
    while (cache.size > maxEntries && victims.length > 0) {
      const [key] = victims.shift()!;
      cache.delete(key);
    }
  };

  const getCachedFiles = (workspacePath: string, contentVersion: number): string[] | null => {
    const normalizedWorkspace = String(workspacePath || "").trim();
    if (!normalizedWorkspace) return null;
    const entry = cache.get(normalizedWorkspace);
    if (!entry) return null;
    if (entry.contentVersion !== contentVersion) return null;
    touch(normalizedWorkspace, entry);
    return entry.files;
  };

  const ensureLoaded = async (params: EnsureWorkspaceFileIndexParams): Promise<string[]> => {
    const workspacePath = String(params.workspacePath || "").trim();
    if (!workspacePath) return [];
    const contentVersion = Number.isFinite(params.contentVersion) ? params.contentVersion : 0;
    const forceRefresh = params.forceRefresh === true;

    if (!forceRefresh) {
      const cached = getCachedFiles(workspacePath, contentVersion);
      if (cached) return cached;
    }

    const pending = inflight.get(workspacePath);
    if (pending && pending.contentVersion === contentVersion) {
      return pending.promise;
    }

    const request = loader(workspacePath)
      .then((files) => {
        const normalizedFiles = Array.isArray(files)
          ? files.filter((item): item is string => typeof item === "string")
          : [];
        const entry: WorkspaceFileCacheEntry = {
          contentVersion,
          files: normalizedFiles,
          lastAccessedAt: Date.now(),
        };
        cache.set(workspacePath, entry);
        prune();
        return normalizedFiles;
      })
      .catch(() => [])
      .finally(() => {
        const current = inflight.get(workspacePath);
        if (current?.promise === request) {
          inflight.delete(workspacePath);
        }
      });

    inflight.set(workspacePath, {
      contentVersion,
      promise: request,
    });

    return request;
  };

  return {
    getCachedFiles,
    ensureLoaded,
    clearWorkspace: (workspacePath: string) => {
      const normalizedWorkspace = String(workspacePath || "").trim();
      if (!normalizedWorkspace) return;
      cache.delete(normalizedWorkspace);
      inflight.delete(normalizedWorkspace);
    },
    clearAll: () => {
      cache.clear();
      inflight.clear();
    },
  };
}
