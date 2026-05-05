import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type MainUpdateInstallStage = "downloading" | "installing";

export interface MainUpdateProgress {
  stage: MainUpdateInstallStage;
  downloadedBytes: number;
  contentLength?: number;
  percent?: number;
}

export interface MainUpdateInfo {
  update: Update;
  currentVersion: string;
  version: string;
  notes: string;
  date?: string;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "");
}

function isUpdaterUnavailable(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("__tauri__") ||
    message.includes("__tauri_internals__") ||
    message.includes("not allowed") ||
    message.includes("unknown command") ||
    message.includes("plugin:updater") ||
    message.includes("updater plugin")
  );
}

export async function checkForMainUpdate() {
  try {
    const update = await check({ timeout: 15_000 });
    if (!update) return null;

    return {
      update,
      currentVersion: update.currentVersion,
      version: update.version,
      notes: update.body || "",
      date: update.date,
    } satisfies MainUpdateInfo;
  } catch (error) {
    if (isUpdaterUnavailable(error)) return null;
    throw error;
  }
}

export async function installMainUpdate(
  updateInfo: MainUpdateInfo,
  onProgress?: (progress: MainUpdateProgress) => void,
) {
  let downloadedBytes = 0;
  let contentLength: number | undefined;

  const emitProgress = (stage: MainUpdateInstallStage) => {
    onProgress?.({
      stage,
      downloadedBytes,
      contentLength,
      percent: contentLength ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100)) : undefined,
    });
  };

  emitProgress("downloading");

  await updateInfo.update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      downloadedBytes = 0;
      contentLength = event.data.contentLength;
      emitProgress("downloading");
      return;
    }

    if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      emitProgress("downloading");
      return;
    }

    emitProgress("installing");
  });

  emitProgress("installing");
  await relaunch();
}
