import { extractReadFileWindowMetadata } from "./readFileWindow";
import { sha256Hex } from "./sha256";
import { workspacePathsReferToSameFile } from "./workspacePaths";

export interface PlanSourceObservation {
  observationRef: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  excerptHash: string;
  versionToken: string;
  requestSignature: string;
}

interface ReadObservationIdentityLike {
  path?: string;
  requestSignature?: string;
  versionToken?: string;
  contentHash?: string;
  window?: { startLine?: number; endLine?: number };
}

const MAX_SOURCE_OBSERVATION_CHARS = 16_000;
const MAX_SOURCE_OBSERVATION_LINES = 320;
const MAX_SOURCE_OBSERVATIONS = 4;
const SIGNAL_CONTEXT_LINES = 14;

function normalizedSource(value: string): string {
  return String(value || "").replace(/\r\n?/g, "\n");
}

export function buildPlanSourceObservationRef(input: {
  path: string;
  startLine: number;
  endLine: number;
  excerptHash: string;
  versionToken: string;
  requestSignature: string;
}): string {
  return `source-observation-sha256-${sha256Hex(JSON.stringify({
    path: String(input.path || "").replace(/\\/g, "/"),
    startLine: Math.floor(Number(input.startLine) || 0),
    endLine: Math.floor(Number(input.endLine) || 0),
    excerptHash: String(input.excerptHash || ""),
    versionToken: String(input.versionToken || ""),
    requestSignature: String(input.requestSignature || ""),
  }))}`;
}

function readFileBody(value: string): string {
  const text = normalizedSource(value);
  const startMarker = "\n---CONTENT START---\n";
  const endMarker = "\n---CONTENT END---";
  const start = text.indexOf(startMarker);
  if (start < 0) return text;
  const bodyStart = start + startMarker.length;
  const end = text.lastIndexOf(endMarker);
  return end >= bodyStart ? text.slice(bodyStart, end) : text.slice(bodyStart);
}

function sourceSignalScore(line: string): number {
  let score = 0;
  if (/\b(?:function|class|interface|type|fn|impl|struct|enum)\b|=>/.test(line)) score += 2;
  if (/\b(?:addEventListener|dispatchEvent|invoke|emit|listen|querySelector|getElementById)\s*\(/.test(line)) score += 6;
  if (/\b(?:return|await|throw|if|match)\b|\?\.|\?\?/.test(line)) score += 2;
  if (/\b[A-Za-z_$][A-Za-z0-9_$]*\s*=|\.[A-Za-z_$][A-Za-z0-9_$]*\s*=/.test(line)) score += 2;
  if (/\.split\s*\(|\.pop\s*\(|\.slice\s*\(|\.map\s*\(/.test(line)) score += 2;
  return score;
}

function observation(
  path: string,
  lines: string[],
  localStart: number,
  localEnd: number,
  returnedStartLine: number,
  identity: ReadObservationIdentityLike | undefined,
): PlanSourceObservation | null {
  // Keep the canonical LF-normalized source bytes exactly as returned. In
  // particular, do not trim indentation, trailing spaces, or a final newline:
  // the line range and hash are the immutable observation contract.
  const excerpt = lines.slice(localStart, localEnd + 1).join("\n");
  if (!excerpt.trim()) return null;
  const startLine = returnedStartLine + localStart;
  const endLine = startLine + excerpt.split("\n").length - 1;
  const versionToken = String(identity?.versionToken || identity?.contentHash || "").trim();
  const requestSignature = String(identity?.requestSignature || "").trim();
  if (!versionToken || !requestSignature) return null;
  const identityWindow = identity?.window;
  if (
    identityWindow && (
      startLine < Math.max(1, Math.floor(Number(identityWindow.startLine) || 1)) ||
      endLine > Math.max(0, Math.floor(Number(identityWindow.endLine) || 0))
    )
  ) return null;
  const excerptHash = `source-sha256-${sha256Hex(excerpt)}`;
  const observationRef = buildPlanSourceObservationRef({
    path,
    startLine,
    endLine,
    excerptHash,
    versionToken,
    requestSignature,
  });
  return {
    observationRef,
    path,
    startLine,
    endLine,
    excerpt,
    excerptHash,
    versionToken,
    requestSignature,
  };
}

/**
 * Preserve exact, bounded source windows before human-readable summaries are
 * compacted. Every excerpt carries its path/range/version/hash and is accepted
 * only from the runtime read_file result boundary.
 */
export function extractRuntimePlanSourceObservations(input: {
  target: string;
  content: string;
  readFileObservation?: ReadObservationIdentityLike;
}): PlanSourceObservation[] {
  const body = readFileBody(input.content);
  const lines = body.split("\n");
  if (!body.trim() || lines.length === 0) return [];
  const metadata = extractReadFileWindowMetadata(normalizedSource(input.content));
  const returnedStartLine = metadata?.returnedStartLine ||
    Math.max(1, Math.floor(Number(input.readFileObservation?.window?.startLine) || 1));
  const path = String(
    input.readFileObservation?.path || metadata?.path || input.target || "",
  ).trim();
  if (!path) return [];
  if (
    input.target &&
    !workspacePathsReferToSameFile(input.target, path)
  ) return [];
  if (
    input.readFileObservation?.path &&
    !workspacePathsReferToSameFile(input.readFileObservation.path, path)
  ) return [];
  if (
    metadata?.path &&
    !workspacePathsReferToSameFile(metadata.path, path)
  ) return [];

  if (
    body.length <= MAX_SOURCE_OBSERVATION_CHARS &&
    lines.length <= MAX_SOURCE_OBSERVATION_LINES
  ) {
    const exact = observation(
      path,
      lines,
      0,
      lines.length - 1,
      returnedStartLine,
      input.readFileObservation,
    );
    return exact ? [exact] : [];
  }

  const anchors = lines
    .map((line, index) => ({ index, score: sourceSignalScore(line) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_SOURCE_OBSERVATIONS * 2);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const anchor of anchors) {
    const next = {
      start: Math.max(0, anchor.index - SIGNAL_CONTEXT_LINES),
      end: Math.min(lines.length - 1, anchor.index + SIGNAL_CONTEXT_LINES),
    };
    const overlap = ranges.find((range) =>
      next.start <= range.end + 1 && next.end >= range.start - 1
    );
    if (overlap) {
      overlap.start = Math.min(overlap.start, next.start);
      overlap.end = Math.max(overlap.end, next.end);
    } else if (ranges.length < MAX_SOURCE_OBSERVATIONS) {
      ranges.push(next);
    }
  }
  if (ranges.length === 0) ranges.push({ start: 0, end: Math.min(lines.length - 1, 80) });
  let retainedChars = 0;
  const result: PlanSourceObservation[] = [];
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    let end = range.end;
    let excerpt = lines.slice(range.start, end + 1).join("\n");
    while (excerpt.length + retainedChars > MAX_SOURCE_OBSERVATION_CHARS && end > range.start) {
      end -= 1;
      excerpt = lines.slice(range.start, end + 1).join("\n");
    }
    if (excerpt.length + retainedChars > MAX_SOURCE_OBSERVATION_CHARS) break;
    const exact = observation(
      path,
      lines,
      range.start,
      end,
      returnedStartLine,
      input.readFileObservation,
    );
    if (!exact) continue;
    result.push(exact);
    retainedChars += exact.excerpt.length;
  }
  return result;
}

export function normalizePlanSourceObservations(
  values: unknown,
): PlanSourceObservation[] {
  if (!Array.isArray(values)) return [];
  const result: PlanSourceObservation[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const path = String(item.path || "").trim();
    const excerpt = normalizedSource(String(item.excerpt || ""));
    const startLine = Math.floor(Number(item.startLine));
    const endLine = Math.floor(Number(item.endLine));
    const excerptHash = String(item.excerptHash || "").trim();
    const versionToken = String(item.versionToken || "").trim();
    const requestSignature = String(item.requestSignature || "").trim();
    const observationRef = String(item.observationRef || "").trim();
    const computedHash = `source-sha256-${sha256Hex(excerpt)}`;
    const computedRef = buildPlanSourceObservationRef({
      path,
      startLine,
      endLine,
      excerptHash,
      versionToken,
      requestSignature,
    });
    if (
      !path || !excerpt.trim() || excerpt.length > MAX_SOURCE_OBSERVATION_CHARS ||
      startLine <= 0 || endLine < startLine ||
      endLine - startLine + 1 !== excerpt.split("\n").length ||
      excerptHash !== computedHash ||
      !versionToken || versionToken === "unknown-version" ||
      !requestSignature || requestSignature === "unknown-request" ||
      observationRef !== computedRef
    ) continue;
    const identity = `${path}:${startLine}-${endLine}:${excerptHash}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({
      observationRef,
      path,
      startLine,
      endLine,
      excerpt,
      excerptHash,
      versionToken,
      requestSignature,
    });
    if (result.length >= MAX_SOURCE_OBSERVATIONS) break;
  }
  return result;
}
