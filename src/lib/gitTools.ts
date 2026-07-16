import { buildLineDiff, getDiffStats, type DiffLine } from "./diff";
import { getGitDiff, getGitStatus, type GitDiffEntry } from "./ipc";

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function changedRanges(lines: DiffLine[], contextLines: number): Array<[number, number]> {
  const changed = lines
    .map((line, index) => line.type === "unchanged" ? -1 : index)
    .filter((index) => index >= 0);
  if (changed.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length, index + contextLines + 1);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  return ranges;
}

function lineNumbersBefore(lines: DiffLine[], index: number): { oldLine: number; newLine: number } {
  let oldLine = 1;
  let newLine = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (lines[cursor].type !== "added") oldLine += 1;
    if (lines[cursor].type !== "removed") newLine += 1;
  }
  return { oldLine, newLine };
}

function formatEntryPatch(entry: GitDiffEntry, contextLines: number): string {
  if (entry.binary) return "Binary file changed";
  const lines = buildLineDiff(entry.old || "", entry.new || "");
  const ranges = changedRanges(lines, contextLines);
  return ranges.map(([start, end]) => {
    const { oldLine, newLine } = lineNumbersBefore(lines, start);
    const body = lines.slice(start, end).map((line) => {
      const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
      return `${prefix}${line.text}`;
    }).join("\n");
    return `@@ -${oldLine} +${newLine} @@\n${body}`;
  }).join("\n");
}

export async function runGitStatusTool(
  workspace: string,
  includeStats = true,
): Promise<string> {
  const status = await getGitStatus(workspace, includeStats);
  return JSON.stringify({
    ...status,
    note: "Structured read-only Git status from MAIN's native backend.",
  });
}

export async function runGitDiffTool(
  args: Record<string, unknown> | null | undefined,
  workspace: string,
): Promise<string> {
  const normalizedArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const path = typeof normalizedArgs.path === "string" && normalizedArgs.path.trim() ? normalizedArgs.path.trim() : undefined;
  const filter = typeof normalizedArgs.filter === "string" && normalizedArgs.filter.trim() ? normalizedArgs.filter.trim() : undefined;
  const maxFiles = clampInteger(normalizedArgs.max_files ?? normalizedArgs.maxFiles, 20, 1, 60);
  const maxChars = clampInteger(normalizedArgs.max_chars ?? normalizedArgs.maxChars, 24_000, 2_000, 80_000);
  const contextLines = clampInteger(normalizedArgs.context_lines ?? normalizedArgs.contextLines, 3, 0, 12);
  const allEntries = await getGitDiff(workspace, path, filter);
  const selected = allEntries.slice(0, maxFiles);
  let remainingChars = maxChars;
  let outputTruncated = allEntries.length > selected.length;
  const entries = selected.map((entry) => {
    const stats = getDiffStats(entry.old || "", entry.new || "");
    const patch = formatEntryPatch(entry, contextLines);
    const boundedPatch = patch.length <= remainingChars
      ? patch
      : `${patch.slice(0, Math.max(0, remainingChars)).trimEnd()}\n...[diff truncated]`;
    if (patch.length > remainingChars) outputTruncated = true;
    remainingChars = Math.max(0, remainingChars - boundedPatch.length);
    return {
      path: entry.path,
      status: entry.status,
      binary: entry.binary === true,
      added: stats.added,
      removed: stats.removed,
      patch: remainingChars === 0 && !boundedPatch ? "[diff budget exhausted]" : boundedPatch,
    };
  });
  return JSON.stringify({
    mode: "head_to_worktree",
    path: path || null,
    filter: filter || null,
    changedFiles: allEntries.length,
    returnedFiles: entries.length,
    entries,
    truncated: outputTruncated,
    note: allEntries.length === 0
      ? "No HEAD-to-worktree differences matched this request. The empty result is valid and needs no pagination."
      : "Structured HEAD-to-worktree diff, including staged, unstaged, and untracked changes. Use path to narrow large results.",
  });
}
