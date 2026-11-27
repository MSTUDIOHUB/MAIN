import {
  compareAndSwapSessionSnapshot, compareAndSwapLegacySessionFile, cleanupLegacyImageStudioOutputs,
  finalizeLegacySessionImport, finalizeTerminalCredentialHistoryCleanup, listAllSessionSnapshots, listLegacySessionFiles, loadProjectSession,
  prepareProjectSessionSnapshotForSave, saveProjectSession,
} from "./ipc";
import { matchesCommittedStartupSession, migrateRetiredFeatureSnapshots, retireRemovedFeatures, withSessionMigrationStage, type SessionMigrationResult } from "./retiredFeatureMigration";
import { planSessionTerminalCredentialCleanup } from "./terminalCredentialHistory";
import { appendDebugLog } from "./debugLog";

function isSessionStoreError(error: unknown, code: string): boolean {
  try {
    return JSON.parse(error instanceof Error ? error.message : String(error))?.code === code;
  } catch {
    return false;
  }
}

export function importLocalStartupSession(workspace: string, snapshot: Record<string, unknown>) {
  return withSessionMigrationStage("import_browser_snapshot", async () => {
    const plan = planSessionTerminalCredentialCleanup(snapshot);
    if (plan.disposition === "deferred") return null;
    const candidate = retireRemovedFeatures(plan.snapshot);
    try {
      return await saveProjectSession(workspace, candidate, { exactStorageRevision: true });
    } catch (error) {
      if (!isSessionStoreError(error, "revision_conflict") ||
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

let migration: Promise<SessionMigrationResult> | undefined;
/** Startup gate: a failed/conflicting pass never authorizes deletion or loading stale state. */
export function ensureRetiredFeatureMigration(knownWorkspaces: string[] = []): Promise<SessionMigrationResult> {
  if (!migration) migration = migrateRetiredFeatureSnapshots({
    list: () => listAllSessionSnapshots(knownWorkspaces),
    compareAndSwap: compareAndSwapSessionSnapshot,
    finalizeLegacyCopy: finalizeLegacySessionImport,
    listLegacyFiles: () => listLegacySessionFiles(knownWorkspaces),
    compareAndSwapLegacyFile: compareAndSwapLegacySessionFile,
    cleanupOutputs: cleanupLegacyImageStudioOutputs,
    planTerminalCredentialCleanup: planSessionTerminalCredentialCleanup,
  }).then(async result => {
    if (result.deferred) appendDebugLog("info", "session.terminalCredentialHistory", { deferredOwners: result.deferred });
    await withSessionMigrationStage("finalize_terminal_credential_history", async () => {
      try {
        await finalizeTerminalCredentialHistoryCleanup();
      } catch (error) {
        if (!isSessionStoreError(error, "database_busy")) throw error;
        appendDebugLog("warn", "session.terminalCredentialHistory", { sqliteCheckpointDeferred: true });
      }
    });
    return result;
  }).catch(error => { migration = undefined; throw error; });
  return migration;
}
