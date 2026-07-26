import { getChatTempRoot, readChatTempFile, readFile } from "./ipc";
import { isChatAttachmentPath } from "./attachments";
import { previewApplyPatch, summarizeApplyPatchTarget } from "./applyPatchTool";
import { buildLineDiff } from "./diff";

export interface ToolDiffPreview {
  old: string;
  new: string;
  path?: string;
  existed?: boolean;
  fullFile?: boolean;
}

export interface ToolDiffChangedRange {
  path: string;
  startLine: number;
  endLine: number;
  maxLines: number;
}

/**
 * Retain one concrete source locus from an observed full-file mutation diff.
 * This is recovery metadata only: it does not infer intent or validate the
 * edit. When a whole-file rewrite contains several hunks, the hunk with the
 * most changed lines is the safest bounded place to reopen after validation.
 */
export function resolveToolDiffChangedRange(
  preview?: ToolDiffPreview | null,
): ToolDiffChangedRange | null {
  const path = String(preview?.path || "").trim();
  if (!preview?.fullFile || !path || preview.old === preview.new) return null;

  const changedPositions: number[] = [];
  let newLine = 1;
  for (const line of buildLineDiff(preview.old, preview.new)) {
    if (line.type === "unchanged") {
      newLine += 1;
      continue;
    }
    changedPositions.push(Math.max(1, newLine));
    if (line.type === "added") newLine += 1;
  }
  if (changedPositions.length === 0) return null;

  const hunks: Array<{
    startLine: number;
    endLine: number;
    changedLines: number;
  }> = [];
  for (const position of changedPositions) {
    const current = hunks[hunks.length - 1];
    if (current && position - current.endLine <= 3) {
      current.endLine = Math.max(current.endLine, position);
      current.changedLines += 1;
    } else {
      hunks.push({
        startLine: position,
        endLine: position,
        changedLines: 1,
      });
    }
  }
  const selected = hunks.reduce((best, candidate) => {
    if (candidate.changedLines !== best.changedLines) {
      return candidate.changedLines > best.changedLines ? candidate : best;
    }
    const candidateSpan = candidate.endLine - candidate.startLine;
    const bestSpan = best.endLine - best.startLine;
    return candidateSpan >= bestSpan ? candidate : best;
  });
  return {
    path,
    startLine: selected.startLine,
    endLine: selected.endLine,
    maxLines: selected.endLine - selected.startLine + 1,
  };
}

export function supportsToolDiffPreview(toolName: string): boolean {
  return (
    toolName === "write_file" ||
    toolName === "replace_in_file" ||
    toolName === "apply_patch" ||
    toolName === "script_apply_edits" ||
    toolName === "apply_text_edits" ||
    toolName === "manage_script" ||
    toolName === "create_script" ||
    toolName === "delete_script"
  );
}

interface ToolDiffPreviewContext {
  workspace?: string;
  sessionKey?: string;
}

async function readPreviewFile(path: string, context: ToolDiffPreviewContext): Promise<string> {
  if (context.sessionKey && isChatAttachmentPath(path)) {
    return await readFile(path, await getChatTempRoot(context.sessionKey));
  }
  return !String(context.workspace || "").trim() && context.sessionKey
    ? await readChatTempFile(context.sessionKey, path)
    : await readFile(path, context.workspace);
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
        const originalContent = await readPreviewFile(path, context);
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
        originalContent = await readPreviewFile(path, context);
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

  if (toolName === "apply_patch") {
    const patch = typeof toolArgs.patch === "string" ? toolArgs.patch : "";
    if (!patch.trim()) return undefined;
    const preview = await previewApplyPatch(patch, (path) => readPreviewFile(path, context));
    if (!preview.ok || preview.changes.length === 0) {
      return {
        old: "",
        new: patch,
        path: summarizeApplyPatchTarget(patch) || "workspace patch",
        existed: false,
        fullFile: false,
      };
    }
    if (preview.changes.length === 1) {
      const change = preview.changes[0];
      return {
        old: change.oldContent,
        new: change.newContent,
        path: change.path,
        existed: change.existed,
        fullFile: true,
      };
    }
    return {
      old: preview.changes.map((change) => `--- ${change.path}\n${change.oldContent}`).join("\n"),
      new: preview.changes.map((change) => `+++ ${change.path}\n${change.newContent}`).join("\n"),
      path: summarizeApplyPatchTarget(patch),
      existed: true,
      fullFile: true,
    };
  }

  return undefined;
}
