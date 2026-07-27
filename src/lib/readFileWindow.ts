export const READ_FILE_RESULT_MARKER = "READ_FILE_RESULT";

// Keep ordinary source files in one observation. The former 180/6.8K
// defaults turned a 27KB file into five model round trips despite ample
// context. Explicit ranges remain bounded for genuinely large files.
const DEFAULT_WINDOW_MAX_LINES = 1000;
const DEFAULT_WINDOW_MAX_CHARS = 32000;
const MAX_REQUESTED_WINDOW_LINES = 2000;

interface NormalizedReadFileWindow {
  startLine: number;
  requestedEndLine: number;
  requestedMaxLines: number;
  explicitWindow: boolean;
}

export interface ReadFileWindowRange {
  startLine: number;
  endLine: number;
  requestedMaxLines: number;
  explicitWindow: boolean;
}

export interface ReadFileWindowCoveragePlan {
  original: ReadFileWindowRange;
  overlapped: boolean;
  fullyCovered: boolean;
  suggestedArgs?: Record<string, unknown>;
  suggestedRange?: ReadFileWindowRange;
  coveredRanges: Array<{ startLine: number; endLine: number }>;
}

export interface ReadFileWindowMetadata {
  marker: typeof READ_FILE_RESULT_MARKER;
  path: string;
  contentVersion?: string;
  truncated: boolean;
  totalLines: number;
  totalChars: number;
  returnedStartLine: number;
  returnedEndLine: number;
  returnedChars: number;
  nextStartLine?: number;
}

export interface ReadFileWindowPayload {
  path?: string;
  content: string;
  contentVersion?: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  totalChars: number;
  returnedChars?: number;
  truncated: boolean;
  nextStartLine?: number | null;
}

export interface OptionalLargeFileSummary {
  content: string;
  summarized: boolean;
}

/**
 * A failed or unnecessary Map-Reduce attempt must not erase the bounded
 * READ_FILE_RESULT envelope. That envelope is the model's paging contract:
 * it carries the versioned window and nextStartLine needed to request new
 * source instead of blindly repeating the same full-file read.
 */
export function resolveReadFileResultAfterLargeFileSummary(
  originalResult: string,
  summary: OptionalLargeFileSummary,
): string {
  return summary.summarized ? summary.content : originalResult;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.floor(value);
    return rounded > 0 ? rounded : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      const rounded = Math.floor(parsed);
      return rounded > 0 ? rounded : undefined;
    }
  }
  return undefined;
}

function splitTextLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function normalizeWindowArgs(
  args: Record<string, unknown>,
  totalLines: number,
): NormalizedReadFileWindow {
  const explicitStartLine = parsePositiveInteger(args.start_line);
  const explicitEndLine = parsePositiveInteger(args.end_line);
  const explicitMaxLines = parsePositiveInteger(args.max_lines);
  const explicitWindow = !!explicitStartLine || !!explicitEndLine || !!explicitMaxLines;
  const requestedMaxLines = Math.min(
    explicitMaxLines ?? DEFAULT_WINDOW_MAX_LINES,
    MAX_REQUESTED_WINDOW_LINES,
  );
  const startLine = Math.min(Math.max(explicitStartLine ?? 1, 1), Math.max(totalLines, 1));
  const maxLineEnd = startLine + requestedMaxLines - 1;
  const requestedEndLine = Math.min(
    explicitEndLine ? Math.min(explicitEndLine, maxLineEnd) : maxLineEnd,
    Math.max(totalLines, 1),
  );

  return {
    startLine,
    requestedEndLine: Math.max(startLine, requestedEndLine),
    requestedMaxLines,
    explicitWindow,
  };
}

export function resolveReadFileWindowRequest(
  args: Record<string, unknown>,
  totalLines: number,
): ReadFileWindowRange {
  const normalized = normalizeWindowArgs(args, totalLines);
  return {
    startLine: normalized.startLine,
    endLine: normalized.requestedEndLine,
    requestedMaxLines: normalized.requestedMaxLines,
    explicitWindow: normalized.explicitWindow,
  };
}

function normalizeCoverageRanges(
  ranges: Array<{ startLine: number; endLine: number }>,
  totalLines: number,
): Array<{ startLine: number; endLine: number }> {
  const clamped = ranges
    .map((range) => ({
      startLine: Math.max(1, Math.floor(Number(range.startLine) || 0)),
      endLine: Math.min(Math.max(totalLines, 1), Math.floor(Number(range.endLine) || 0)),
    }))
    .filter((range) => range.startLine > 0 && range.endLine >= range.startLine)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const range of clamped) {
    const previous = merged[merged.length - 1];
    if (previous && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function planReadFileWindowCoverage(
  args: Record<string, unknown>,
  totalLines: number,
  coveredRanges: Array<{ startLine: number; endLine: number }>,
): ReadFileWindowCoveragePlan {
  const original = resolveReadFileWindowRequest(args, totalLines);
  const normalizedCoverage = normalizeCoverageRanges(coveredRanges, totalLines);
  const overlapped = normalizedCoverage.some((range) =>
    range.startLine <= original.endLine && range.endLine >= original.startLine
  );

  if (!overlapped) {
    return {
      original,
      overlapped: false,
      fullyCovered: false,
      coveredRanges: normalizedCoverage,
    };
  }

  const gaps: Array<{ startLine: number; endLine: number }> = [];
  let cursor = original.startLine;
  for (const range of normalizedCoverage) {
    if (range.endLine < cursor) continue;
    if (range.startLine > original.endLine) break;
    if (range.startLine > cursor) {
      gaps.push({ startLine: cursor, endLine: Math.min(range.startLine - 1, original.endLine) });
    }
    cursor = Math.max(cursor, range.endLine + 1);
    if (cursor > original.endLine) break;
  }
  if (cursor <= original.endLine) {
    gaps.push({ startLine: cursor, endLine: original.endLine });
  }

  if (gaps.length === 0) {
    return {
      original,
      overlapped: true,
      fullyCovered: true,
      coveredRanges: normalizedCoverage,
    };
  }

  const firstGap = gaps[0];
  const suggestedEndLine = Math.min(
    firstGap.endLine,
    firstGap.startLine + Math.max(1, original.requestedMaxLines) - 1,
  );
  const suggestedRange: ReadFileWindowRange = {
    startLine: firstGap.startLine,
    endLine: suggestedEndLine,
    requestedMaxLines: Math.max(1, suggestedEndLine - firstGap.startLine + 1),
    explicitWindow: true,
  };
  const suggestedArgs = {
    ...args,
    start_line: suggestedRange.startLine,
    end_line: suggestedRange.endLine,
    max_lines: suggestedRange.requestedMaxLines,
  };

  return {
    original,
    overlapped: true,
    fullyCovered: false,
    suggestedArgs,
    suggestedRange,
    coveredRanges: normalizedCoverage,
  };
}

function selectWindowLines(
  lines: string[],
  startLine: number,
  requestedEndLine: number,
): { content: string; endLine: number; lineTruncated: boolean } {
  if (lines.length === 0) {
    return { content: "", endLine: 0, lineTruncated: false };
  }

  const selected: string[] = [];
  let charCount = 0;
  let lineTruncated = false;
  const startIndex = startLine - 1;
  const requestedEndIndex = Math.min(requestedEndLine - 1, lines.length - 1);

  for (let index = startIndex; index <= requestedEndIndex; index += 1) {
    const line = lines[index] ?? "";
    const separatorLength = selected.length > 0 ? 1 : 0;
    const nextLength = charCount + separatorLength + line.length;
    if (selected.length > 0 && nextLength > DEFAULT_WINDOW_MAX_CHARS) break;
    if (selected.length === 0 && nextLength > DEFAULT_WINDOW_MAX_CHARS) {
      selected.push(line.slice(0, DEFAULT_WINDOW_MAX_CHARS));
      charCount = DEFAULT_WINDOW_MAX_CHARS;
      lineTruncated = true;
      break;
    }
    selected.push(line);
    charCount = nextLength;
  }

  const endLine = selected.length > 0 ? startLine + selected.length - 1 : startLine;
  return {
    content: selected.join("\n"),
    endLine,
    lineTruncated,
  };
}

export function extractReadFileWindowMetadata(content: string): ReadFileWindowMetadata | null {
  if (!content.startsWith(`${READ_FILE_RESULT_MARKER}\n`)) return null;
  const headerEnd = content.indexOf("\n---CONTENT START---");
  const header = headerEnd >= 0 ? content.slice(0, headerEnd) : content;
  const values = new Map<string, string>();
  for (const line of header.split("\n").slice(1)) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }

  const returnedLines = values.get("returnedLines") || "";
  const returnedMatch = /^(\d+)-(\d+)$/.exec(returnedLines);
  const totalLines = Number(values.get("totalLines"));
  const totalChars = Number(values.get("totalChars"));
  const returnedChars = Number(values.get("returnedChars"));
  const nextStartLine = Number(values.get("nextStartLine"));
  if (!Number.isFinite(totalLines) || !Number.isFinite(totalChars) || !returnedMatch) return null;

  return {
    marker: READ_FILE_RESULT_MARKER,
    path: values.get("path") || "",
    contentVersion: values.get("contentVersion") || undefined,
    truncated: values.get("truncated") === "true",
    totalLines,
    totalChars,
    returnedStartLine: Number(returnedMatch[1]),
    returnedEndLine: Number(returnedMatch[2]),
    returnedChars: Number.isFinite(returnedChars) ? returnedChars : 0,
    ...(Number.isFinite(nextStartLine) && nextStartLine > 0 ? { nextStartLine } : {}),
  };
}

export function formatReadFileWindowForModel(
  path: string,
  content: string,
  args: Record<string, unknown> = {},
): string {
  const lines = splitTextLines(content);
  const totalLines = lines.length;
  const normalized = normalizeWindowArgs(args, totalLines);
  const shouldReturnRaw =
    !normalized.explicitWindow &&
    content.length <= DEFAULT_WINDOW_MAX_CHARS &&
    totalLines <= DEFAULT_WINDOW_MAX_LINES;

  if (shouldReturnRaw) return content;

  const { content: windowContent, endLine, lineTruncated } = selectWindowLines(
    lines,
    normalized.startLine,
    normalized.requestedEndLine,
  );
  const returnedEndLine = totalLines === 0 ? 0 : endLine;
  const returnedStartLine = totalLines === 0 ? 0 : normalized.startLine;
  const moreRequestedLines = returnedEndLine < normalized.requestedEndLine;
  const moreFileLines = returnedEndLine > 0 && returnedEndLine < totalLines;
  const notWholeFile = returnedStartLine !== 1 || returnedEndLine !== totalLines;
  const truncated = notWholeFile || moreRequestedLines || moreFileLines || lineTruncated;
  const nextStartLine = moreFileLines || moreRequestedLines || lineTruncated
    ? Math.max(returnedEndLine + 1, normalized.startLine + 1)
    : undefined;
  const header = [
    READ_FILE_RESULT_MARKER,
    `path: ${path}`,
    `truncated: ${truncated ? "true" : "false"}`,
    `totalLines: ${totalLines}`,
    `totalChars: ${content.length}`,
    `returnedLines: ${returnedStartLine}-${returnedEndLine}`,
    `returnedChars: ${windowContent.length}`,
    nextStartLine ? `nextStartLine: ${nextStartLine}` : "",
    "note: This is a bounded window only when truncated=true. Do not automatically continue paging; request another read_file window only when the current decision needs specific missing lines. Do not use run_command merely to page file contents.",
    "---CONTENT START---",
  ].filter(Boolean);

  return `${header.join("\n")}\n${windowContent}\n---CONTENT END---`;
}

export function formatReadFileWindowPayloadForModel(
  path: string,
  payload: ReadFileWindowPayload,
  _args: Record<string, unknown> = {},
): string {
  const content = String(payload.content || "");
  const returnedStartLine = Math.max(0, Number(payload.startLine) || 0);
  const returnedEndLine = Math.max(0, Number(payload.endLine) || 0);
  const totalLines = Math.max(0, Number(payload.totalLines) || 0);
  const totalChars = Math.max(0, Number(payload.totalChars) || 0);
  const returnedChars = Math.max(0, Number(payload.returnedChars ?? content.length) || 0);
  const nextStartLine = parsePositiveInteger(payload.nextStartLine);
  const header = [
    READ_FILE_RESULT_MARKER,
    `path: ${path}`,
    payload.contentVersion
      ? `contentVersion: ${payload.contentVersion}`
      : "",
    `truncated: ${payload.truncated ? "true" : "false"}`,
    `totalLines: ${totalLines}`,
    `totalChars: ${totalChars}`,
    `returnedLines: ${returnedStartLine}-${returnedEndLine}`,
    `returnedChars: ${returnedChars}`,
    nextStartLine ? `nextStartLine: ${nextStartLine}` : "",
    "note: This is a bounded window only when truncated=true. Do not automatically continue paging; request another read_file window only when the current decision needs specific missing lines. Do not use run_command merely to page file contents.",
    "---CONTENT START---",
  ].filter(Boolean);

  return `${header.join("\n")}\n${content}\n---CONTENT END---`;
}

export function buildReadFileWindowContinuationGuidance(content: string): string | null {
  const metadata = extractReadFileWindowMetadata(content);
  if (!metadata?.truncated) return null;

  return [
    "The earlier read_file result was a bounded window, not the whole file.",
    metadata.nextStartLine
      ? `If the current decision needs missing source, request the specific range beginning at or after line ${metadata.nextStartLine}; otherwise continue to mutation or validation.`
      : "Request another start_line/end_line window only when the current decision identifies specific missing source.",
    "Do not use run_command merely to page file contents.",
  ].join("\n");
}
