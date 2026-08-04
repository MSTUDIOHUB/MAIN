export const READ_FILE_RESULT_MARKER = "READ_FILE_RESULT";

// Keep ordinary source files in one observation. The former 180/6.8K
// defaults turned a 27KB file into five model round trips despite ample
// context. Explicit ranges remain bounded for genuinely large files.
const DEFAULT_WINDOW_MAX_LINES = 1000;
const DEFAULT_WINDOW_MAX_CHARS = 32000;
const MAX_REQUESTED_WINDOW_LINES = 2000;
const MAX_REQUESTED_WINDOW_CHARS = 64000;

interface NormalizedReadFileWindow {
  startLine: number;
  requestedEndLine: number;
  requestedMaxLines: number;
  requestedMaxChars: number;
  explicitWindow: boolean;
  startChar?: number;
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
  returnedStartChar?: number;
  returnedEndChar?: number;
  nextStartChar?: number;
}

export interface ExactReadFileWindow {
  metadata: ReadFileWindowMetadata;
  content: string;
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
  returnedStartChar?: number | null;
  returnedEndChar?: number | null;
  nextStartChar?: number | null;
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

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.floor(value);
    return rounded >= 0 ? rounded : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      const rounded = Math.floor(parsed);
      return rounded >= 0 ? rounded : undefined;
    }
  }
  return undefined;
}

function exactSourceLineRecords(content: string): string[] {
  if (!content) return [];
  return (content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || [])
    .filter((record) => record.length > 0);
}

function sourceLineStartCharOffset(content: string, startLine: number): number {
  if (startLine <= 1) return 0;
  const chars = Array.from(content);
  let line = 1;
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] === "\r" && chars[index + 1] === "\n") {
      index += 1;
    } else if (chars[index] !== "\r" && chars[index] !== "\n") {
      continue;
    }
    line += 1;
    if (line === startLine) return index + 1;
  }
  return chars.length;
}

function normalizeWindowArgs(
  args: Record<string, unknown>,
  totalLines: number,
): NormalizedReadFileWindow {
  const explicitStartLine = parsePositiveInteger(args.start_line);
  const explicitEndLine = parsePositiveInteger(args.end_line);
  const explicitMaxLines = parsePositiveInteger(args.max_lines);
  const explicitMaxChars = parsePositiveInteger(args.max_chars);
  const explicitStartChar = parseNonNegativeInteger(args.start_char);
  const explicitWindow =
    !!explicitStartLine ||
    !!explicitEndLine ||
    !!explicitMaxLines ||
    explicitStartChar !== undefined;
  const requestedMaxLines = Math.min(
    explicitMaxLines ?? DEFAULT_WINDOW_MAX_LINES,
    MAX_REQUESTED_WINDOW_LINES,
  );
  const requestedMaxChars = Math.min(
    explicitMaxChars ?? DEFAULT_WINDOW_MAX_CHARS,
    MAX_REQUESTED_WINDOW_CHARS,
  );
  const startLine = Math.min(Math.max(explicitStartLine ?? 1, 1), Math.max(totalLines, 1));
  const maxLineEnd = startLine + requestedMaxLines - 1;
  // Some providers advance `start_line` from the previous nextStartLine but
  // accidentally retain that previous window's end_line. Treat the now
  // reversed end as stale instead of collapsing the continuation to one
  // line; otherwise the file can never reach complete same-version coverage.
  const usableEndLine =
    explicitEndLine !== undefined && explicitEndLine >= startLine
      ? explicitEndLine
      : undefined;
  const requestedEndLine = Math.min(
    usableEndLine ? Math.min(usableEndLine, maxLineEnd) : maxLineEnd,
    Math.max(totalLines, 1),
  );

  return {
    startLine,
    requestedEndLine: Math.max(startLine, requestedEndLine),
    requestedMaxLines,
    requestedMaxChars,
    explicitWindow,
    ...(explicitStartChar !== undefined
      ? { startChar: explicitStartChar }
      : {}),
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

function selectExactWindowLines(
  lines: string[],
  startLine: number,
  requestedEndLine: number,
  maxChars: number,
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
    const lineChars = Array.from(line);
    if (selected.length > 0 && charCount + lineChars.length > maxChars) {
      break;
    }
    if (selected.length === 0 && lineChars.length > maxChars) {
      selected.push(lineChars.slice(0, maxChars).join(""));
      lineTruncated = true;
      break;
    }
    selected.push(line);
    charCount += lineChars.length;
  }
  return {
    content: selected.join(""),
    endLine: selected.length > 0 ? startLine + selected.length - 1 : startLine,
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
  const returnedCharsRange = values.get("returnedCharRange") || "";
  const returnedCharsMatch = /^(\d+)-(\d+)$/.exec(returnedCharsRange);
  const nextStartChar = Number(values.get("nextStartChar"));
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
    ...(returnedCharsMatch
      ? {
          returnedStartChar: Number(returnedCharsMatch[1]),
          returnedEndChar: Number(returnedCharsMatch[2]),
        }
      : {}),
    ...(Number.isFinite(nextStartChar) && nextStartChar >= 0
      ? { nextStartChar }
      : {}),
  };
}

/**
 * Return source text only when the complete, standard READ_FILE_RESULT
 * envelope is still present. Context compaction may preserve range metadata
 * beside an excerpt; that is useful for orientation but must never become
 * mutation authority.
 */
export function extractExactReadFileWindow(
  content: string,
): ExactReadFileWindow | null {
  const metadata = extractReadFileWindowMetadata(content);
  if (!metadata) return null;
  const startMarker = "\n---CONTENT START---\n";
  const endMarker = "\n---CONTENT END---";
  const contentStart = content.indexOf(startMarker);
  const contentEnd = content.lastIndexOf(endMarker);
  if (
    contentStart < 0 ||
    contentEnd < contentStart + startMarker.length
  ) {
    return null;
  }
  const exactContent = content.slice(
    contentStart + startMarker.length,
    contentEnd,
  );
  if (
    metadata.nextStartLine !== undefined &&
    metadata.nextStartLine > metadata.totalLines
  ) {
    return null;
  }
  if (
    metadata.totalLines === 0 &&
    (
      metadata.returnedStartLine !== 0 ||
      metadata.returnedEndLine !== 0 ||
      metadata.returnedChars !== 0 ||
      metadata.truncated
    )
  ) {
    return null;
  }
  if (
    metadata.totalLines > 0 &&
    metadata.returnedStartLine === 0 &&
    metadata.returnedEndLine === 0 &&
    metadata.returnedStartChar === undefined
  ) {
    return null;
  }
  if (
    metadata.returnedStartLine === 1 &&
    metadata.returnedEndLine === metadata.totalLines &&
    metadata.returnedChars < metadata.totalChars
  ) {
    return null;
  }
  if (
    metadata.returnedStartChar !== undefined &&
    (
      metadata.returnedStartChar !== 0 ||
      metadata.returnedEndChar !== metadata.totalChars ||
      metadata.returnedEndChar - metadata.returnedStartChar !==
        metadata.returnedChars ||
      Array.from(exactContent).length !== metadata.returnedChars ||
      metadata.truncated
    )
  ) {
    return null;
  }
  return {
    metadata,
    content: exactContent,
  };
}

/**
 * Serve a focused same-version range from a previously returned window.
 * This is a cache replay, not a second filesystem read. It keeps the normal
 * READ_FILE_RESULT contract so a smaller model receives the requested source
 * directly instead of an indirect "look earlier in the transcript" message.
 */
export function replayReadFileWindowFromResult(
  previousResult: string,
  args: Record<string, unknown>,
): string | null {
  const metadata = extractReadFileWindowMetadata(previousResult);
  if (!metadata) return null;
  const requestedPath = String(args.path || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  const cachedPath = metadata.path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (requestedPath && requestedPath !== cachedPath) return null;
  const normalized = normalizeWindowArgs(args, metadata.totalLines);
  if (
    normalized.startLine < metadata.returnedStartLine ||
    normalized.requestedEndLine > metadata.returnedEndLine
  ) {
    return null;
  }
  const startMarker = "\n---CONTENT START---\n";
  const endMarker = "\n---CONTENT END---";
  const contentStart = previousResult.indexOf(startMarker);
  const contentEnd = previousResult.lastIndexOf(endMarker);
  if (
    contentStart < 0 ||
    contentEnd < contentStart + startMarker.length
  ) {
    return null;
  }
  const cachedLines = exactSourceLineRecords(
    previousResult.slice(contentStart + startMarker.length, contentEnd),
  );
  const expectedCachedLines =
    metadata.returnedEndLine - metadata.returnedStartLine + 1;
  if (cachedLines.length < expectedCachedLines) return null;
  const relativeStart =
    normalized.startLine - metadata.returnedStartLine + 1;
  const relativeEnd =
    normalized.requestedEndLine - metadata.returnedStartLine + 1;
  const selected = selectExactWindowLines(
    cachedLines,
    relativeStart,
    relativeEnd,
    normalized.requestedMaxChars,
  );
  if (selected.lineTruncated) return null;
  const returnedEndLine =
    normalized.startLine + selected.endLine - relativeStart;
  const moreRequestedLines =
    returnedEndLine < normalized.requestedEndLine;
  const moreFileLines = returnedEndLine < metadata.totalLines;
  const truncated =
    normalized.startLine !== 1 ||
    returnedEndLine !== metadata.totalLines ||
    moreRequestedLines ||
    moreFileLines ||
    selected.lineTruncated;
  return formatReadFileWindowPayloadForModel(
    metadata.path,
    {
      path: metadata.path,
      content: selected.content,
      contentVersion: metadata.contentVersion,
      startLine: normalized.startLine,
      endLine: returnedEndLine,
      totalLines: metadata.totalLines,
      totalChars: metadata.totalChars,
      returnedChars: Array.from(selected.content).length,
      truncated,
      nextStartLine:
        moreRequestedLines || moreFileLines
          ? returnedEndLine + 1
          : null,
    },
    args,
  );
}

export function formatReadFileWindowForModel(
  path: string,
  content: string,
  args: Record<string, unknown> = {},
): string {
  const lines = exactSourceLineRecords(content);
  const totalContentChars = Array.from(content).length;
  const totalLines = lines.length;
  const normalized = normalizeWindowArgs(args, totalLines);
  if (normalized.startChar !== undefined) {
    const sourceChars = Array.from(content);
    const startChar = Math.min(normalized.startChar, sourceChars.length);
    const endChar = Math.min(
      sourceChars.length,
      startChar + normalized.requestedMaxChars,
    );
    const windowContent = sourceChars.slice(startChar, endChar).join("");
    const truncated = startChar !== 0 || endChar !== sourceChars.length;
    return formatReadFileWindowPayloadForModel(path, {
      path,
      content: windowContent,
      startLine: 0,
      endLine: 0,
      totalLines,
      totalChars: sourceChars.length,
      returnedChars: endChar - startChar,
      truncated,
      returnedStartChar: startChar,
      returnedEndChar: endChar,
      nextStartChar: endChar < sourceChars.length ? endChar : null,
    });
  }
  const shouldReturnRaw =
    !normalized.explicitWindow &&
    totalContentChars <= normalized.requestedMaxChars &&
    totalLines <= DEFAULT_WINDOW_MAX_LINES;

  if (shouldReturnRaw) return content;

  const { content: windowContent, endLine, lineTruncated } =
    selectExactWindowLines(
    lines,
    normalized.startLine,
    normalized.requestedEndLine,
    normalized.requestedMaxChars,
    );
  if (lineTruncated) {
    const sourceChars = Array.from(content);
    const startChar = sourceLineStartCharOffset(
      content,
      normalized.startLine,
    );
    const endChar = Math.min(
      sourceChars.length,
      startChar + normalized.requestedMaxChars,
    );
    return formatReadFileWindowPayloadForModel(path, {
      path,
      content: sourceChars.slice(startChar, endChar).join(""),
      startLine: 0,
      endLine: 0,
      totalLines,
      totalChars: totalContentChars,
      returnedChars: endChar - startChar,
      truncated: true,
      returnedStartChar: startChar,
      returnedEndChar: endChar,
      nextStartChar: endChar < sourceChars.length ? endChar : null,
    });
  }
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
    `totalChars: ${totalContentChars}`,
    `returnedLines: ${returnedStartLine}-${returnedEndLine}`,
    `returnedChars: ${Array.from(windowContent).length}`,
    nextStartLine ? `nextStartLine: ${nextStartLine}` : "",
    "note: This is a bounded window only when truncated=true. When full-file semantics are required, continue from nextStartLine with read_file until the same-version coverage is complete; for a local decision, request only the specific missing range. Do not use run_command merely to page file contents.",
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
  const returnedChars = Math.max(
    0,
    Number(payload.returnedChars ?? Array.from(content).length) || 0,
  );
  const requestedNextStartLine =
    parsePositiveInteger(payload.nextStartLine);
  const nextStartLine =
    requestedNextStartLine !== undefined &&
      totalLines > 0 &&
      requestedNextStartLine > returnedEndLine &&
      requestedNextStartLine <= totalLines
      ? requestedNextStartLine
      : undefined;
  const returnedStartChar = parseNonNegativeInteger(payload.returnedStartChar);
  const returnedEndChar = parseNonNegativeInteger(payload.returnedEndChar);
  const nextStartChar = parseNonNegativeInteger(payload.nextStartChar);
  const reachesLineEof =
    payload.truncated &&
    totalLines > 0 &&
    returnedStartLine > 1 &&
    returnedEndLine >= totalLines &&
    nextStartLine === undefined;
  const continuationNote = nextStartChar !== undefined
    ? `note: This is a bounded character window. Continue with start_char: ${nextStartChar} on the same content version; character cursors are 0-based and end-exclusive, so adjacent results concatenate without overlap or loss. Do not use run_command merely to page file contents.`
    : reachesLineEof
      ? "note: This bounded line window reaches EOF. Do not request a line past totalLines; combine it with prior same-version windows, or request only an earlier missing range. Do not use run_command merely to page file contents."
    : "note: This is a bounded window only when truncated=true. When full-file semantics are required, continue from nextStartLine with read_file until the same-version coverage is complete; for a local decision, request only the specific missing range. Do not use run_command merely to page file contents.";
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
    returnedStartChar !== undefined && returnedEndChar !== undefined
      ? `returnedCharRange: ${returnedStartChar}-${returnedEndChar}`
      : "",
    nextStartLine ? `nextStartLine: ${nextStartLine}` : "",
    nextStartChar !== undefined ? `nextStartChar: ${nextStartChar}` : "",
    continuationNote,
    "---CONTENT START---",
  ].filter(Boolean);

  return `${header.join("\n")}\n${content}\n---CONTENT END---`;
}

function exactSourceLineCount(content: string): number {
  if (!content) return 0;
  const separators = content.match(/\r\n|\r|\n/g)?.length || 0;
  return separators + (/(?:\r\n|\r|\n)$/.test(content) ? 0 : 1);
}

/**
 * Production normally receives a versioned window from the Rust reader. A
 * compatible older backend may return a complete small file as raw text
 * instead. Normalize only that raw source into the same envelope; never parse
 * it as a command result, and never trim file boundary characters.
 */
export function ensureVersionedReadFileResultForModel(
  path: string,
  output: unknown,
  contentVersion: string,
): string {
  const content = typeof output === "string"
    ? output
    : output === null || output === undefined
      ? ""
      : JSON.stringify(output, null, 2);
  const metadata = extractReadFileWindowMetadata(content);
  if (metadata?.contentVersion) return content;
  if (metadata) {
    const startMarker = "\n---CONTENT START---\n";
    const endMarker = "\n---CONTENT END---";
    const contentStart = content.indexOf(startMarker);
    const contentEnd = content.lastIndexOf(endMarker);
    if (
      contentStart < 0 ||
      contentEnd < contentStart + startMarker.length
    ) {
      return content;
    }
    const source = content.slice(
      contentStart + startMarker.length,
      contentEnd,
    );
    return formatReadFileWindowPayloadForModel(
      metadata.path || path,
      {
        path: metadata.path || path,
        content: source,
        contentVersion,
        startLine: metadata.returnedStartLine,
        endLine: metadata.returnedEndLine,
        totalLines: metadata.totalLines,
        totalChars: metadata.totalChars,
        returnedChars: metadata.returnedChars,
        truncated: metadata.truncated,
        nextStartLine: metadata.nextStartLine,
        returnedStartChar: metadata.returnedStartChar,
        returnedEndChar: metadata.returnedEndChar,
        nextStartChar: metadata.nextStartChar,
      },
    );
  }
  const totalLines = exactSourceLineCount(content);
  const totalChars = Array.from(content).length;
  return formatReadFileWindowPayloadForModel(path, {
    path,
    content,
    contentVersion,
    startLine: totalLines === 0 ? 0 : 1,
    endLine: totalLines,
    totalLines,
    totalChars,
    returnedChars: totalChars,
    truncated: false,
  });
}

export function buildReadFileWindowContinuationGuidance(content: string): string | null {
  const metadata = extractReadFileWindowMetadata(content);
  if (!metadata?.truncated) return null;

  return [
    "The earlier read_file result was a bounded window, not the whole file.",
    metadata.nextStartChar !== undefined
      ? `Continue the exact same content version with read_file start_char: ${metadata.nextStartChar}; this character cursor is 0-based and end-exclusive, so adjacent results can be concatenated without overlap or loss.`
      : metadata.nextStartLine
      ? `If full-file semantics are required, continue sequentially from line ${metadata.nextStartLine} on the same content version; if only a local decision remains, request the specific missing range, otherwise continue to mutation or validation.`
      : "For full-file semantics, continue with another same-version start_line/end_line window; otherwise request only a range needed by the current decision.",
    "Do not use run_command merely to page file contents.",
  ].join("\n");
}
