import { invoke } from "@tauri-apps/api/core";
import {
  inspectGeminiExtensionArchive,
  type GeminiExtensionArchive,
  type GeminiExtensionPreview,
} from "./geminiExtensions";

export async function cleanupGeminiExtension(extension: Pick<GeminiExtensionPreview, "packagePath" | "workspaceScope">): Promise<void> {
  await invoke("delete_protocol_package", {
    localPath: extension.packagePath,
    workspace: extension.workspaceScope,
  });
}

export async function extractGeminiExtension(zipPath: string, workspace: string): Promise<GeminiExtensionPreview> {
  const archive = await invoke<GeminiExtensionArchive>("extract_gemini_extension", { zipPath, workspace });
  try {
    return inspectGeminiExtensionArchive(archive);
  } catch (error) {
    await invoke("delete_protocol_package", { localPath: archive.local_path, workspace: archive.workspace }).catch(() => undefined);
    throw error;
  }
}
