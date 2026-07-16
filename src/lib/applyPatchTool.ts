export type ApplyPatchOperationKind = "add" | "update" | "delete";

export interface ApplyPatchOperation {
  kind: ApplyPatchOperationKind;
  path: string;
  newPath?: string;
  hunks: ApplyPatchHunk[];
  content?: string;
}

export interface ApplyPatchHunk {
  oldText: string;
  newText: string;
}

export interface ParsedApplyPatch {
  ok: boolean;
  operations: ApplyPatchOperation[];
  error?: string;
}

export interface ApplyPatchPreviewChange {
  path: string;
  kind: ApplyPatchOperationKind;
  oldContent: string;
  newContent: string;
  existed: boolean;
}

export interface ApplyPatchPreview {
  ok: boolean;
  changes: ApplyPatchPreviewChange[];
  error?: string;
}

export interface ApplyPatchIo {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  deletePath?: (path: string) => Promise<void>;
}

function normalizePatchPath(path: string): string {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function isUnsafePatchPath(path: string): boolean {
  const normalized = normalizePatchPath(path);
  return (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  );
}

function parseHeaderPath(line: string, prefix: string): string {
  return normalizePatchPath(line.slice(prefix.length).trim());
}

function normalizeUnifiedDiffPath(rawPath: string): string {
  const firstToken = String(rawPath || "").trim().split(/\s+/)[0] || "";
  if (firstToken === "/dev/null") return firstToken;
  return normalizePatchPath(firstToken.replace(/^[ab]\//, ""));
}

function looksLikeUnifiedDiff(lines: string[], index: number): boolean {
  return lines[index]?.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ");
}

function normalizeUnifiedDiffToApplyPatch(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines.some((line) => line.trim() === "*** Begin Patch")) {
    const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
    const end = lines.findIndex((line) => line.trim() === "*** End Patch");
    const body = end > begin ? lines.slice(begin + 1, end).join("\n") : raw;
    const bodyLines = body.split("\n");
    if (bodyLines.some((_, index) => looksLikeUnifiedDiff(bodyLines, index))) {
      return normalizeUnifiedDiffToApplyPatch(body);
    }
    return raw;
  }
  if (!lines.some((_, index) => looksLikeUnifiedDiff(lines, index))) return raw;

  const output: string[] = ["*** Begin Patch"];
  let index = 0;
  let emitted = false;
  while (index < lines.length) {
    if (!looksLikeUnifiedDiff(lines, index)) {
      index += 1;
      continue;
    }

    const oldPath = normalizeUnifiedDiffPath(lines[index].slice(4));
    const newPath = normalizeUnifiedDiffPath(lines[index + 1].slice(4));
    index += 2;
    const hunkLines: string[] = [];
    while (index < lines.length && !looksLikeUnifiedDiff(lines, index)) {
      const line = lines[index];
      if (!line.startsWith("\\ No newline")) hunkLines.push(line);
      index += 1;
    }

    if (oldPath === "/dev/null") {
      if (isUnsafePatchPath(newPath)) continue;
      output.push(`*** Add File: ${newPath}`);
      for (const line of hunkLines) {
        if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue;
        if (line.startsWith("+")) output.push(line);
      }
      emitted = true;
      continue;
    }

    if (newPath === "/dev/null") {
      if (isUnsafePatchPath(oldPath)) continue;
      output.push(`*** Delete File: ${oldPath}`);
      emitted = true;
      continue;
    }

    const path = newPath || oldPath;
    if (isUnsafePatchPath(path)) continue;
    output.push(`*** Update File: ${path}`);
    for (const line of hunkLines) {
      if (line.startsWith("---") || line.startsWith("+++")) continue;
      output.push(line);
    }
    emitted = true;
  }
  output.push("*** End Patch");
  return emitted ? output.join("\n") : raw;
}

function stripLinePrefix(line: string): { prefix: string; text: string } | null {
  if (!line) return { prefix: " ", text: "" };
  const prefix = line[0];
  if (prefix !== " " && prefix !== "+" && prefix !== "-") return null;
  return { prefix, text: line.slice(1) };
}

function pushUpdateHunk(
  hunks: ApplyPatchHunk[],
  lines: string[],
): void {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let sawChange = false;

  for (const line of lines) {
    if (line.startsWith("@@")) continue;
    const parsed = stripLinePrefix(line);
    if (!parsed) continue;
    if (parsed.prefix === " " || parsed.prefix === "-") oldLines.push(parsed.text);
    if (parsed.prefix === " " || parsed.prefix === "+") newLines.push(parsed.text);
    if (parsed.prefix === "-" || parsed.prefix === "+") sawChange = true;
  }

  if (!sawChange) return;
  hunks.push({
    oldText: oldLines.join("\n") + (oldLines.length > 0 ? "\n" : ""),
    newText: newLines.join("\n") + (newLines.length > 0 ? "\n" : ""),
  });
}

export function parseApplyPatch(patch: string): ParsedApplyPatch {
  const raw = normalizeUnifiedDiffToApplyPatch(String(patch || "")).replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const first = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const last = lines.findIndex((line) => line.trim() === "*** End Patch");
  if (first < 0 || last < 0 || last <= first) {
    return { ok: false, operations: [], error: "apply_patch must include *** Begin Patch and *** End Patch markers." };
  }

  const body = lines.slice(first + 1, last);
  const operations: ApplyPatchOperation[] = [];
  let index = 0;

  while (index < body.length) {
    const line = body[index] || "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const path = parseHeaderPath(line, "*** Add File: ");
      if (isUnsafePatchPath(path)) return { ok: false, operations: [], error: `Unsafe or missing patch path: ${path || "(empty)"}` };
      index += 1;
      const contentLines: string[] = [];
      while (index < body.length && !body[index].startsWith("*** ")) {
        const current = body[index];
        if (!current.startsWith("+")) {
          return { ok: false, operations: [], error: `Add File lines must start with '+': ${path}` };
        }
        contentLines.push(current.slice(1));
        index += 1;
      }
      operations.push({
        kind: "add",
        path,
        hunks: [],
        content: contentLines.join("\n") + (contentLines.length > 0 ? "\n" : ""),
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const path = parseHeaderPath(line, "*** Delete File: ");
      if (isUnsafePatchPath(path)) return { ok: false, operations: [], error: `Unsafe or missing patch path: ${path || "(empty)"}` };
      operations.push({ kind: "delete", path, hunks: [] });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const path = parseHeaderPath(line, "*** Update File: ");
      if (isUnsafePatchPath(path)) return { ok: false, operations: [], error: `Unsafe or missing patch path: ${path || "(empty)"}` };
      index += 1;
      let newPath: string | undefined;
      const hunkLines: string[] = [];
      const hunks: ApplyPatchHunk[] = [];
      while (index < body.length && !body[index].startsWith("*** Add File: ") && !body[index].startsWith("*** Update File: ") && !body[index].startsWith("*** Delete File: ")) {
        const current = body[index];
        if (current.startsWith("*** Move to: ")) {
          newPath = parseHeaderPath(current, "*** Move to: ");
          if (isUnsafePatchPath(newPath)) return { ok: false, operations: [], error: `Unsafe move target: ${newPath || "(empty)"}` };
        } else if (current.startsWith("@@") && hunkLines.some((item) => /^[ +-]/.test(item))) {
          pushUpdateHunk(hunks, hunkLines.splice(0, hunkLines.length));
          hunkLines.push(current);
        } else if (current.trim() === "*** End of File") {
          // Marker is accepted but does not affect text.
        } else {
          hunkLines.push(current);
        }
        index += 1;
      }
      pushUpdateHunk(hunks, hunkLines);
      if (hunks.length === 0 && !newPath) {
        return { ok: false, operations: [], error: `Update File has no changes: ${path}` };
      }
      operations.push({ kind: "update", path, newPath, hunks });
      continue;
    }

    return { ok: false, operations: [], error: `Unsupported apply_patch line: ${line}` };
  }

  if (operations.length === 0) {
    return { ok: false, operations: [], error: "apply_patch contains no file operations." };
  }
  return { ok: true, operations };
}

function replaceFirstExact(content: string, oldText: string, newText: string): string | null {
  if (!oldText) return null;
  const directIndex = content.indexOf(oldText);
  if (directIndex >= 0) {
    return content.slice(0, directIndex) + newText + content.slice(directIndex + oldText.length);
  }
  if (oldText.endsWith("\n")) {
    const trimmedOld = oldText.slice(0, -1);
    const trimmedNew = newText.endsWith("\n") ? newText.slice(0, -1) : newText;
    const trimmedIndex = content.indexOf(trimmedOld);
    if (trimmedIndex >= 0) {
      return content.slice(0, trimmedIndex) + trimmedNew + content.slice(trimmedIndex + trimmedOld.length);
    }
  }
  return null;
}

export async function previewApplyPatch(
  patch: string,
  readFile: (path: string) => Promise<string>,
): Promise<ApplyPatchPreview> {
  const parsed = parseApplyPatch(patch);
  if (!parsed.ok) return { ok: false, changes: [], error: parsed.error };

  const changes: ApplyPatchPreviewChange[] = [];
  const staged = new Map<string, string | null>();

  const readCurrent = async (path: string): Promise<{ content: string; existed: boolean }> => {
    if (staged.has(path)) {
      const value = staged.get(path);
      if (value == null) throw new Error(`${path} is deleted earlier in this patch.`);
      return { content: value, existed: true };
    }
    try {
      return { content: await readFile(path), existed: true };
    } catch {
      return { content: "", existed: false };
    }
  };

  for (const operation of parsed.operations) {
    if (operation.kind === "add") {
      const current = await readCurrent(operation.path);
      if (current.existed) {
        return { ok: false, changes: [], error: `Add File target already exists: ${operation.path}` };
      }
      const next = operation.content || "";
      if (!next) return { ok: false, changes: [], error: `Add File content is empty: ${operation.path}` };
      staged.set(operation.path, next);
      changes.push({ path: operation.path, kind: "add", oldContent: "", newContent: next, existed: false });
      continue;
    }

    if (operation.kind === "delete") {
      const current = await readCurrent(operation.path);
      if (!current.existed) {
        return { ok: false, changes: [], error: `Delete File target does not exist: ${operation.path}` };
      }
      staged.set(operation.path, null);
      changes.push({ path: operation.path, kind: "delete", oldContent: current.content, newContent: "", existed: true });
      continue;
    }

    const current = await readCurrent(operation.path);
    if (!current.existed) {
      return { ok: false, changes: [], error: `Update File target does not exist: ${operation.path}` };
    }
    let next = current.content;
    for (const hunk of operation.hunks) {
      const updated = replaceFirstExact(next, hunk.oldText, hunk.newText);
      if (updated == null) {
        return { ok: false, changes: [], error: `Patch context was not found in ${operation.path}.` };
      }
      next = updated;
    }
    if (next === current.content && !operation.newPath) {
      return { ok: false, changes: [], error: `Patch would not change ${operation.path}.` };
    }
    staged.set(operation.path, operation.newPath ? null : next);
    if (operation.newPath) staged.set(operation.newPath, next);
    changes.push({
      path: operation.newPath || operation.path,
      kind: "update",
      oldContent: current.content,
      newContent: next,
      existed: true,
    });
  }

  if (changes.length === 0 || changes.every((change) => change.oldContent === change.newContent)) {
    return { ok: false, changes: [], error: "apply_patch would not change any files." };
  }

  return { ok: true, changes };
}

export async function applyWorkspacePatch(
  patch: string,
  io: ApplyPatchIo,
): Promise<ApplyPatchPreview> {
  const preview = await previewApplyPatch(patch, io.readFile);
  if (!preview.ok) return preview;
  for (const change of preview.changes) {
    if (change.kind === "delete") {
      if (!io.deletePath) return { ok: false, changes: [], error: `Delete File is not supported for ${change.path}.` };
      await io.deletePath(change.path);
    } else {
      await io.writeFile(change.path, change.newContent);
    }
  }
  return preview;
}

export function summarizeApplyPatchTarget(patch: string, maxPaths = 4): string {
  const parsed = parseApplyPatch(patch);
  if (!parsed.ok) return "";
  const paths = parsed.operations
    .map((operation) => operation.newPath || operation.path)
    .filter(Boolean)
    .slice(0, maxPaths);
  const suffix = parsed.operations.length > paths.length ? ` +${parsed.operations.length - paths.length}` : "";
  return `${paths.join(", ")}${suffix}`;
}
