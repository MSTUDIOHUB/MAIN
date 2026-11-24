import { compareAndSwapSessionSnapshot, compareAndSwapLegacySessionFile, cleanupLegacyImageStudioOutputs, finalizeLegacySessionImport, listAllSessionSnapshots, listLegacySessionFiles } from "./ipc";
import { migrateRetiredFeatureSnapshots } from "./retiredFeatureMigration";
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
