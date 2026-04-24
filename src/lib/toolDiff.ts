import { readChatTempFile, readFile } from "./ipc";

export interface ToolDiffPreview {
  old: string;
  new: string;
  path?: string;
}

export function supportsToolDiffPreview(toolName: string): boolean {
  return toolName === "write_file" || toolName === "replace_in_file";
}

interface ToolDiffPreviewContext {
  workspace?: string;
  sessionKey?: string;
}

export async function buildToolDiffPreview(
  toolName: string,
  toolArgs: Record<string, unknown>,
  context: ToolDiffPreviewContext = {},
): Promise<ToolDiffPreview | undefined> {
  const path = typeof toolArgs.path === "string" ? toolArgs.path : undefined;

  if (toolName === "replace_in_file") {
    return {
      old: typeof toolArgs.search_text === "string" ? toolArgs.search_text : "",
      new: typeof toolArgs.replace_text === "string" ? toolArgs.replace_text : "",
      ...(path ? { path } : {}),
    };
  }

  if (toolName === "write_file") {
    let originalContent = "";
    if (path) {
      try {
        originalContent =
          !String(context.workspace || "").trim() && context.sessionKey
            ? await readChatTempFile(context.sessionKey, path)
            : await readFile(path);
      } catch {
        originalContent = "";
      }
    }

    return {
      old: originalContent,
      new: typeof toolArgs.content === "string" ? toolArgs.content : "",
      ...(path ? { path } : {}),
    };
  }

  return undefined;
}
