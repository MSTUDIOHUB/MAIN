import { buildRepeatLoopArgsKey } from "../repetitionGuard";
import { isPtyControlInput } from "../ptyCommandRuntime";
import {
  extractReadFileWindowMetadata,
  type planReadFileWindowCoverage,
} from "../readFileWindow";
import { workspacePathsReferToSameFile } from "../workspacePaths";
import {
  isWorkspaceMutationToolCall,
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../workspaceMutationTools";

export interface FileReadState {
  signature: string;
  path: string;
  argsKey: string;
  contentHash: string;
  contentLength: number;
  sizeBytes: number;
  modifiedMs: number;
  modelContent: string;
  /** Stable identity for the exact request window and file version. */
  observation?: FileReadObservationIdentity;
  /** Parsed source window retained with this observation, when read_file returned one. */
  window?: FileReadWindowIdentity;
  /** Increments only when context management actually evicts this exact source window. */
  contextEvictionEpoch?: number;
  /** The eviction epoch for which the retained source was most recently replayed. */
  lastReplayContextEvictionEpoch?: number;
  /** Actual cached-source replays since this file version was observed. */
  replayCountSinceVersion?: number;
  updatedAt: number;
}

export type FileReadObservationSource = "fresh" | "stub" | "replay";

export interface FileReadObservationIdentity {
  key: string;
  path: string;
  requestSignature: string;
  versionToken: string;
  contentHash?: string;
  source: FileReadObservationSource;
}

export interface FileReadWindowIdentity {
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export type ReadFileEligibilityKind =
  | "fresh_read"
  | "context_replay"
  | "unchanged_stub"
  | "scope_deferred";

export interface ReadFileEligibilityDecision {
  kind: ReadFileEligibilityKind;
  reason:
    | "transaction_scope_mismatch"
    | "missing_window"
    | "content_version_changed"
    | "context_window_evicted"
    | "same_snapshot_window_active"
    | "same_context_epoch_already_replayed";
  observedVersion: string | null;
  currentVersion: string | null;
  contextEpoch: number;
}

export const FILE_UNCHANGED_STUB = "FILE_UNCHANGED_STUB";

const MAX_FILE_READ_STATES_PER_SESSION = 240;
const sessionFileReadStates = new Map<string, Map<string, FileReadState>>();

type ReadFileWindowCoveragePlan = ReturnType<typeof planReadFileWindowCoverage>;

/**
 * Decide read eligibility before recovery-mode tool restrictions are applied.
 * The decision depends only on transaction scope, exact window/version state,
 * and context residency. Recovery cannot bypass this versioned cache.
 */
export function resolveReadFileEligibilityDecision(input: {
  scopeMatches: boolean;
  hasCachedWindow: boolean;
  observedVersion?: string | null;
  currentVersion?: string | null;
  contentInContext: boolean;
  contextEpoch?: number;
  replayedContextEpoch?: number | null;
}): ReadFileEligibilityDecision {
  const observedVersion = input.observedVersion || null;
  const currentVersion = input.currentVersion || null;
  const contextEpoch = Math.max(0, Math.floor(input.contextEpoch || 0));
  const decision = (
    kind: ReadFileEligibilityKind,
    reason: ReadFileEligibilityDecision["reason"],
  ): ReadFileEligibilityDecision => ({
    kind,
    reason,
    observedVersion,
    currentVersion,
    contextEpoch,
  });
  if (!input.scopeMatches) return decision("scope_deferred", "transaction_scope_mismatch");
  if (!input.hasCachedWindow) return decision("fresh_read", "missing_window");
  if (!observedVersion || !currentVersion || observedVersion !== currentVersion) {
    return decision("fresh_read", "content_version_changed");
  }
  if (input.contentInContext) {
    return decision("unchanged_stub", "same_snapshot_window_active");
  }
  if (input.replayedContextEpoch !== contextEpoch) {
    return decision("context_replay", "context_window_evicted");
  }
  return decision("unchanged_stub", "same_context_epoch_already_replayed");
}

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

function collectMutationTargets(
  toolName: string,
  args: Record<string, unknown>,
  fallbackTarget: string,
): string[] {
  return resolveWorkspaceMutationTargets(toolName, args, fallbackTarget);
}

function normalizeChangedPaths(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

/**
 * Read only top-level structured mutation metadata. Command stdout is opaque
 * user output and must not be interpreted as a cache-control instruction.
 */
export function extractStructuredChangedPaths(
  ...contents: Array<string | undefined>
): string[] {
  for (const content of contents) {
    if (!content?.trim()) continue;
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const changedPaths = [
        ...normalizeChangedPaths(parsed.changedPaths),
        ...normalizeChangedPaths(parsed.changedFiles),
      ];
      if (changedPaths.length > 0) return [...new Set(changedPaths)];
    } catch {
      // Non-JSON tool output has no structured changed-path guarantee.
    }
  }
  return [];
}

/**
 * A successful workspace action starts a new observation epoch. Invalidate
 * every cached range for changed files and every args-only workspace
 * observation (grep/outline/AST/repo-map/git-diff), so post-action validation
 * cannot replay old evidence even when size and mtime happen to match. Exact
 * read_file windows survive opaque commands: their metadata is checked before
 * reuse, while unversioned grep/outline/AST/repo-map/git caches are cleared.
 * A command may invalidate exact windows only when it reports changed paths in
 * a structured result envelope.
 */
export function invalidateWorkspaceReadCachesAfterMutation(input: {
  toolName: string;
  args: Record<string, unknown>;
  target?: string;
  changedPaths?: string[];
  fileReadStates: Map<string, FileReadState>;
  readOnlyResultCache?: Map<string, unknown>;
  readOnlyDuplicateSkipCounts?: Map<string, number>;
}): { invalidatedFileReadSignatures: string[]; invalidatedReadOnlyEntries: number } {
  if (
    input.toolName === "send_pty_input" &&
    isPtyControlInput(
      typeof input.args.input === "string" ? input.args.input : "",
      typeof input.args.control === "string" ? input.args.control : undefined,
    )
  ) {
    // A control action does not change a file version, so exact versioned
    // read_file windows remain valid. The foreground process may have changed
    // generated files asynchronously before it stopped, however, so args-only
    // grep/outline/AST/git caches must be observed again.
    const invalidatedReadOnlyEntries = input.readOnlyResultCache?.size || 0;
    const invalidatedKeys = [...(input.readOnlyResultCache?.keys() || [])];
    input.readOnlyResultCache?.clear();
    invalidatedKeys.forEach((key) => input.readOnlyDuplicateSkipCounts?.delete(key));
    return { invalidatedFileReadSignatures: [], invalidatedReadOnlyEntries };
  }
  if (isWorkspaceMutationToolName(input.toolName) && !isWorkspaceMutationToolCall(input.toolName, input.args)) {
    return { invalidatedFileReadSignatures: [], invalidatedReadOnlyEntries: 0 };
  }
  const targets = collectMutationTargets(
    input.toolName,
    input.args,
    String(input.target || ""),
  );
  const exactChangedPaths = [...new Set([
    ...targets,
    ...normalizeChangedPaths(input.changedPaths),
  ])];
  const invalidatedFileReadSignatures: string[] = [];
  for (const [signature, state] of input.fileReadStates.entries()) {
    if (!exactChangedPaths.some((target) => workspacePathsReferToSameFile(state.path, target))) continue;
    input.fileReadStates.delete(signature);
    input.readOnlyDuplicateSkipCounts?.delete(signature);
    invalidatedFileReadSignatures.push(signature);
  }

  const invalidatedReadOnlyEntries = input.readOnlyResultCache?.size || 0;
  input.readOnlyResultCache?.clear();
  return { invalidatedFileReadSignatures, invalidatedReadOnlyEntries };
}

/** Remove all older metadata epochs for a path before planning window coverage. */
export function invalidateStaleFileReadStatesForPath(input: {
  states: Map<string, FileReadState>;
  path: string;
  sizeBytes: number;
  modifiedMs: number;
}): string[] {
  const invalidated: string[] = [];
  for (const [signature, state] of input.states.entries()) {
    if (!workspacePathsReferToSameFile(state.path, input.path)) continue;
    if (state.sizeBytes === input.sizeBytes && state.modifiedMs === input.modifiedMs) continue;
    input.states.delete(signature);
    invalidated.push(signature);
  }
  return invalidated;
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

export function buildFileReadObservationIdentity(input: {
  requestSignature: string;
  path: string;
  sizeBytes: number;
  modifiedMs: number;
  contentHash?: string;
  source: FileReadObservationSource;
}): FileReadObservationIdentity {
  const versionToken = `${input.sizeBytes}:${input.modifiedMs}`;
  const contentToken = String(input.contentHash || "unknown");
  return {
    key: `${input.requestSignature}::version=${versionToken}::content=${contentToken}`,
    path: input.path,
    requestSignature: input.requestSignature,
    versionToken,
    ...(input.contentHash ? { contentHash: input.contentHash } : {}),
    source: input.source,
  };
}

export function buildFileReadWindowIdentity(modelContent: string): FileReadWindowIdentity | undefined {
  const metadata = extractReadFileWindowMetadata(modelContent);
  if (!metadata) return undefined;
  return {
    startLine: metadata.returnedStartLine,
    endLine: metadata.returnedEndLine,
    totalLines: metadata.totalLines,
    truncated: metadata.truncated,
  };
}

export function getFileReadObservationForState(
  state: FileReadState,
  source: FileReadObservationSource = "replay",
): FileReadObservationIdentity {
  const observation = state.observation || buildFileReadObservationIdentity({
    requestSignature: state.signature,
    path: state.path,
    sizeBytes: state.sizeBytes,
    modifiedMs: state.modifiedMs,
    contentHash: state.contentHash,
    source,
  });
  return observation.source === source ? observation : { ...observation, source };
}

/**
 * Resolve the exact source observation to pin during edit recovery. Prefer an
 * explicit observation/request/version identity; only fall back to the newest
 * window for the exact same workspace path. Map insertion order breaks
 * millisecond timestamp ties so a later targeted range wins over an older
 * file-head read.
 */
export function selectFileReadStateForRecoveryContext(input: {
  states: Map<string, FileReadState>;
  targetPath?: string | null;
  observationKey?: string;
  requestSignature?: string;
  versionToken?: string;
}): FileReadState | null {
  const targetPath = String(input.targetPath || "")
    .trim()
    .replace(/^[`'\"]+|[`'\"]+$/g, "")
    .replace(/:(?:line\s*)?\d+(?:-\d+)?$/i, "");
  const candidates = [...input.states.values()]
    .map((state, index) => ({ state, index, observation: getFileReadObservationForState(state) }))
    .filter(({ state }) => !targetPath || workspacePathsReferToSameFile(state.path, targetPath))
    .filter(({ observation }) => !input.observationKey || observation.key === input.observationKey)
    .filter(({ state }) => !input.requestSignature || state.signature === input.requestSignature)
    .filter(({ observation }) => !input.versionToken || observation.versionToken === input.versionToken)
    .sort((left, right) =>
      right.state.updatedAt - left.state.updatedAt || right.index - left.index
    );
  return candidates[0]?.state || null;
}

export function buildFileUnchangedStub(state: FileReadState): string {
  const readFileWindow = extractReadFileWindowMetadata(state.modelContent);
  if (readFileWindow?.truncated) {
    return [
      `${FILE_UNCHANGED_STUB}: "${state.path}" has already been read with the same range/options, and the file is unchanged.`,
      `Previous read window: lines ${readFileWindow.returnedStartLine}-${readFileWindow.returnedEndLine} of ${readFileWindow.totalLines}, ${state.contentLength.toLocaleString()} result chars, file size ${state.sizeBytes.toLocaleString()} bytes, modified ${state.modifiedMs}, hash ${state.contentHash}.`,
      readFileWindow.nextStartLine
        ? `This was not the whole file. Request lines at or after ${readFileWindow.nextStartLine} only if the current decision needs that missing range; otherwise continue to mutation or validation.`
        : "This was not the whole file. Request a different window only after identifying the exact missing range needed for the current decision.",
      "Do not use run_command merely to page file contents; run_command is for tests, builds, diagnostics, and other shell work.",
    ].join("\n");
  }

  return [
    `${FILE_UNCHANGED_STUB}: "${state.path}" has already been read with the same range/options, and the content is unchanged.`,
    `Previous read: ${state.contentLength.toLocaleString()} chars, file size ${state.sizeBytes.toLocaleString()} bytes, modified ${state.modifiedMs}, hash ${state.contentHash}.`,
    "Reuse the earlier file content already in context. Do not call read_file for this same file/range again unless you have reason to believe it changed.",
    "Continue the implementation/answer from the cached content; inspect another target only when a concrete unresolved question requires it.",
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
    } else if (
      !fullFileState &&
      !/^\s*\[FILE MAP-REDUCE SUMMARY\]/i.test(state.modelContent)
    ) {
      // A semantic summary is useful evidence, but it is not proof that every
      // exact line range is present in context. Keep later targeted windows
      // readable.
      fullFileState = state;
    }
  }

  return { fullFileState, ranges, totalLines };
}

function normalizePathLike(value: string): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}
