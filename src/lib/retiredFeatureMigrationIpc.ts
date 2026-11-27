import {
  compareAndSwapSessionSnapshot, compareAndSwapLegacySessionFile, cleanupLegacyImageStudioOutputs,
  finalizeLegacySessionImport, listAllSessionSnapshots, listLegacySessionFiles, loadProjectSession,
  prepareProjectSessionSnapshotForSave, saveProjectSession,
} from "./ipc";
import { matchesCommittedStartupSession, migrateRetiredFeatureSnapshots, retireRemovedFeatures, withSessionMigrationStage } from "./retiredFeatureMigration";

function isSnapshotRevisionConflict(error: unknown): boolean {
  try {
    return JSON.parse(error instanceof Error ? error.message : String(error))?.code === "revision_conflict";
  } catch {
    return false;
  }
}

export function importLocalStartupSession(workspace: string, snapshot: Record<string, unknown>) {
  return withSessionMigrationStage("import_browser_snapshot", async () => {
    const candidate = retireRemovedFeatures(snapshot);
    try {
      return await saveProjectSession(workspace, candidate, { exactStorageRevision: true });
    } catch (error) {
      if (!isSnapshotRevisionConflict(error) ||
          (typeof snapshot.id !== "number" && typeof snapshot.id !== "string")) throw error;
      // A previous process may have saved these exact bytes before it could
      // publish the storage pointer. A newer, different native history wins
      // its CAS and leaves the browser copy pending for explicit recovery.
      const existing = await loadProjectSession(workspace, snapshot.id);
      if (Number(existing?.storageRevision) > (Number(snapshot.storageRevision) || 0) &&
          matchesCommittedStartupSession(prepareProjectSessionSnapshotForSave(candidate, null), existing)) {
        return existing;
      }
      throw error;
    }
  }, `${workspace}:${snapshot.id}@${snapshot.storageRevision ?? 0}`);
}

let migration: Promise<{ scanned: number; changed: number }> | undefined;
/** Startup gate: a failed/conflicting pass never authorizes deletion or loading stale state. */
export function ensureRetiredFeatureMigration(knownWorkspaces: string[] = []): Promise<{ scanned: number; changed: number }> {
  if (!migration) migration = migrateRetiredFeatureSnapshots({
    list: () => listAllSessionSnapshots(knownWorkspaces),
    compareAndSwap: compareAndSwapSessionSnapshot,
    finalizeLegacyCopy: finalizeLegacySessionImport,
    listLegacyFiles: () => listLegacySessionFiles(knownWorkspaces),
    compareAndSwapLegacyFile: compareAndSwapLegacySessionFile,
    cleanupOutputs: cleanupLegacyImageStudioOutputs,
  }).catch(error => { migration = undefined; throw error; });
  return migration;
}
