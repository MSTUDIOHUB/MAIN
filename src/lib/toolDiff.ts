import { readChatTempFile, readFile } from "./ipc";

export interface ToolDiffPreview {
  old: string;
  new: string;
  path?: string;
  existed?: boolean;
  fullFile?: boolean;
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
    const searchText = typeof toolArgs.search_text === "string" ? toolArgs.search_text : "";
    const replaceText = typeof toolArgs.replace_text === "string" ? toolArgs.replace_text : "";
    if (path && searchText) {
      try {
        const originalContent =
          !String(context.workspace || "").trim() && context.sessionKey
            ? await readChatTempFile(context.sessionKey, path)
            : await readFile(path, context.workspace);
        if (originalContent.includes(searchText)) {
          return {
            old: originalContent,
            new: originalContent.replace(searchText, replaceText),
            path,
            existed: true,
            fullFile: true,
          };
        }
      } catch {
        // Fall through to the legacy fragment preview below.
      }
    }

    return {
      old: searchText,
      new: replaceText,
      ...(path ? { path } : {}),
      fullFile: false,
    };
  }

  if (toolName === "write_file") {
    let originalContent = "";
    let existed = false;
    if (path) {
      try {
        originalContent =
          !String(context.workspace || "").trim() && context.sessionKey
            ? await readChatTempFile(context.sessionKey, path)
            : await readFile(path, context.workspace);
        existed = true;
      } catch {
        originalContent = "";
      }
    }

    return {
      old: originalContent,
      new: typeof toolArgs.content === "string" ? toolArgs.content : "",
      ...(path ? { path } : {}),
      existed,
      fullFile: true,
    };
  }

  return undefined;
}
