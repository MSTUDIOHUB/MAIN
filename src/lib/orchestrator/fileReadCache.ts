import { buildRepeatLoopArgsKey } from "../repetitionGuard";
import {
  extractReadFileWindowMetadata,
  type planReadFileWindowCoverage,
} from "../readFileWindow";

export interface FileReadState {
  signature: string;
  path: string;
  argsKey: string;
  contentHash: string;
  contentLength: number;
  sizeBytes: number;
  modifiedMs: number;
  modelContent: string;
  updatedAt: number;
}

export const FILE_UNCHANGED_STUB = "FILE_UNCHANGED_STUB";

const MAX_FILE_READ_STATES_PER_SESSION = 240;
const sessionFileReadStates = new Map<string, Map<string, FileReadState>>();

type ReadFileWindowCoveragePlan = ReturnType<typeof planReadFileWindowCoverage>;

export function getSessionFileReadStates(sessionKey: string): Map<string, FileReadState> {
  const key = sessionKey || "default";
  let states = sessionFileReadStates.get(key);
  if (!states) {
    states = new Map<string, FileReadState>();
    sessionFileReadStates.set(key, states);
  }
  return states;
}

export function pruneFileReadStates(states: Map<string, FileReadState>): void {
  if (states.size <= MAX_FILE_READ_STATES_PER_SESSION) return;
  const staleKeys = [...states.entries()]
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(0, states.size - MAX_FILE_READ_STATES_PER_SESSION)
    .map(([key]) => key);
  staleKeys.forEach((key) => states.delete(key));
}

export function isOptionalTasksMdRead(toolName: string, target: string): boolean {
  if (toolName !== "read_file") return false;
  const normalized = target.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return normalized === ".main/plans/tasks.md" || normalized.endsWith("/.main/plans/tasks.md");
}

export function isMissingOptionalTasksMdReadError(errorMessage: string): boolean {
  return /no such file or directory|os error 2|路径不存在|无法访问/i.test(errorMessage);
}

export function buildOptionalTasksMdMissingResult(language: "zh" | "en", target: string): string {
  return language === "zh"
    ? [
        `OPTIONAL_TASKS_MD_NOT_PRESENT path: ${target || ".MAIN/plans/tasks.md"}`,
        "`tasks.md` 是可选审计文件，当前不存在也不阻塞执行。",
        "请直接使用 MAIN 提供的 runtime 任务清单和已批准的 plan.md；不要再为了确认是否存在而重复读取 `.MAIN/plans/tasks.md`。",
      ].join("\n")
    : [
        `OPTIONAL_TASKS_MD_NOT_PRESENT path: ${target || ".MAIN/plans/tasks.md"}`,
        "`tasks.md` is an optional audit file; it is not required for execution.",
        "Use MAIN's runtime task list and the approved plan.md instead; do not reread `.MAIN/plans/tasks.md` just to check existence.",
      ].join("\n");
}

export function hashString(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function buildFileReadSignature(path: string, args: Record<string, unknown>): string {
  const argsKey = buildRepeatLoopArgsKey(
    Object.fromEntries(
      Object.entries(args)
        .filter(([key]) => key !== "path")
        .filter(([, value]) => value !== undefined && value !== null && value !== ""),
    ),
  );
  return `read_file::${path}::${argsKey}`;
}

export function buildFileUnchangedStub(state: FileReadState): string {
  const readFileWindow = extractReadFileWindowMetadata(state.modelContent);
  if (readFileWindow?.truncated) {
    return [
      `${FILE_UNCHANGED_STUB}: "${state.path}" has already been read with the same range/options, and the file is unchanged.`,
      `Previous read window: lines ${readFileWindow.returnedStartLine}-${readFileWindow.returnedEndLine} of ${readFileWindow.totalLines}, ${state.contentLength.toLocaleString()} result chars, file size ${state.sizeBytes.toLocaleString()} bytes, modified ${state.modifiedMs}, hash ${state.contentHash}.`,
      readFileWindow.nextStartLine
        ? `This was not the whole file. Next: call read_file with start_line=${readFileWindow.nextStartLine} and max_lines to continue, or use start_line/end_line around the exact error line.`
        : "This was not the whole file. Next: call read_file with a different start_line/end_line/max_lines range around the exact line you need.",
      "Do not use run_command merely to page file contents; run_command is for tests, builds, diagnostics, and other shell work.",
    ].join("\n");
  }

  return [
    `${FILE_UNCHANGED_STUB}: "${state.path}" has already been read with the same range/options, and the content is unchanged.`,
    `Previous read: ${state.contentLength.toLocaleString()} chars, file size ${state.sizeBytes.toLocaleString()} bytes, modified ${state.modifiedMs}, hash ${state.contentHash}.`,
    "Reuse the earlier file content already in context. Do not call read_file for this same file/range again unless you have reason to believe it changed.",
    "Next: inspect a different file, use get_file_outline/grep_search for a narrower question, or continue the implementation/answer from the cached content.",
  ].join("\n");
}

export function buildFileUnchangedReplayContent(state: FileReadState, duplicateCount: number): string {
  return [
    `CACHED_FILE_REPLAY: "${state.path}" is unchanged, but MAIN is replaying the previous read because approved execution requested this same file/range again (duplicate ${duplicateCount}).`,
    "Use the source content below now. Do not call read_file for this same file/range again unless the file changes.",
    state.modelContent,
  ].join("\n\n");
}

export function formatReadFileWindowCoverageStub(
  path: string,
  plan: ReadFileWindowCoveragePlan,
): string {
  const covered = plan.coveredRanges
    .map((range) => `${range.startLine}-${range.endLine}`)
    .join(", ");
  return [
    `${FILE_UNCHANGED_STUB}: "${path}" requested lines ${plan.original.startLine}-${plan.original.endLine}, but that window is already covered by unchanged earlier read_file results.`,
    covered ? `Covered read windows already in context: ${covered}.` : "",
    "Reuse the earlier source already in context instead of rereading the same lines.",
    "Next: continue the implementation, use get_file_outline/grep_search for a narrower question, or request only a missing line range.",
  ].filter(Boolean).join("\n");
}

export function formatReadFileWindowNarrowedNote(
  path: string,
  plan: ReadFileWindowCoveragePlan,
): string {
  const suggested = plan.suggestedRange;
  if (!suggested) return "";
  const covered = plan.coveredRanges
    .map((range) => `${range.startLine}-${range.endLine}`)
    .join(", ");
  return [
    `READ_FILE_WINDOW_NARROWED: "${path}" was requested as lines ${plan.original.startLine}-${plan.original.endLine}, overlapping unchanged lines already in context.`,
    covered ? `Existing windows: ${covered}.` : "",
    `MAIN returned only the missing window ${suggested.startLine}-${suggested.endLine} to avoid duplicating tool-result context.`,
  ].filter(Boolean).join("\n");
}

export function getReadFileCoverageForPath(input: {
  states: Map<string, FileReadState>;
  path: string;
  metadata: { path: string; sizeBytes: number; modifiedMs: number } | null;
  currentSignature: string;
}): {
  fullFileState: FileReadState | null;
  ranges: Array<{ startLine: number; endLine: number }>;
  totalLines: number;
} {
  const normalizedPath = normalizePathLike(input.metadata?.path || input.path).toLowerCase();
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let fullFileState: FileReadState | null = null;
  let totalLines = 0;

  for (const [signature, state] of input.states.entries()) {
    if (signature === input.currentSignature) continue;
    if (normalizePathLike(state.path).toLowerCase() !== normalizedPath) continue;
    if (
      input.metadata &&
      (state.sizeBytes !== input.metadata.sizeBytes || state.modifiedMs !== input.metadata.modifiedMs)
    ) {
      continue;
    }

    const windowMetadata = extractReadFileWindowMetadata(state.modelContent);
    if (windowMetadata) {
      totalLines = Math.max(totalLines, windowMetadata.totalLines);
      ranges.push({
        startLine: windowMetadata.returnedStartLine,
        endLine: windowMetadata.returnedEndLine,
      });
    } else if (!fullFileState) {
      fullFileState = state;
    }
  }

  return { fullFileState, ranges, totalLines };
}

function normalizePathLike(value: string): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}
