import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export const REAL_OMLX_WORKSPACE_PROXY_LIMITS = Object.freeze({
  maxWorkspaceFiles: 4_000,
  maxSearchFiles: 500,
  maxSearchFileBytes: 768 * 1024,
  maxSearchTotalBytes: 8 * 1024 * 1024,
  searchReadConcurrency: 4,
  maxSearchResults: 200,
  maxGrepOutputChars: 128 * 1024,
  maxGlobResults: 500,
  maxIndexEntries: 1_000,
  maxExplicitReadBytes: 2 * 1024 * 1024,
  maxWindowScanBytes: 2 * 1024 * 1024,
  maxDebugEntries: 500,
  maxDebugMessageChars: 8_000,
});

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".main",
  "node_modules",
  "target",
  "dist",
  "dist-ssr",
  "build",
  "out",
  "coverage",
  "test-results",
  "playwright-report",
  "library",
  "logs",
  "obj",
  "bin",
  "temp",
  "usersettings",
  "packagecache",
]);

const SEARCHABLE_TEXT_EXTENSIONS = new Set([
  ".astro",
  ".bash",
  ".c",
  ".cc",
  ".cfg",
  ".cjs",
  ".cmake",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".cxx",
  ".fish",
  ".go",
  ".gql",
  ".gradle",
  ".graphql",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".properties",
  ".proto",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".svg",
  ".swift",
  ".toml",
  ".ts",
  ".tsv",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const SEARCHABLE_EXTENSIONLESS_FILES = new Set([
  "dockerfile",
  "license",
  "makefile",
  "procfile",
  "readme",
]);

export interface RealOmlxWorkspaceInventory {
  files: string[];
  maxFiles: number;
  truncated: boolean;
  visitedDirectories: number;
  prunedDirectories: number;
  skippedEntries: number;
}

export interface RealOmlxWorkspaceCommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/**
 * Execute a finite validation command against the isolated replay workspace.
 *
 * The real-model bridge must not synthesize a successful command result from
 * a source-pattern oracle: doing so can accept a final file that no longer
 * parses. The caller remains responsible for classifying the command as
 * finite before reaching this boundary.
 */
export async function runRealOmlxWorkspaceCommand(
  workspace: string,
  command: string,
  options: {
    timeoutMs?: number;
    maxOutputChars?: number;
  } = {},
): Promise<RealOmlxWorkspaceCommandResult> {
  const cwd = path.resolve(workspace);
  const workspaceStat = await fs.stat(cwd);
  if (!workspaceStat.isDirectory()) {
    throw new Error(`REAL_OMLX_COMMAND_WORKSPACE_NOT_DIRECTORY: ${cwd}`);
  }
  const normalizedCommand = String(command || "").trim();
  if (!normalizedCommand) {
    throw new Error("REAL_OMLX_COMMAND_EMPTY");
  }
  const timeoutMs = Math.max(
    1_000,
    Math.min(300_000, Math.floor(Number(options.timeoutMs) || 120_000)),
  );
  const maxOutputChars = Math.max(
    4_096,
    Math.min(2 * 1024 * 1024, Math.floor(Number(options.maxOutputChars) || 256 * 1024)),
  );
  const startedAt = Date.now();

  return await new Promise<RealOmlxWorkspaceCommandResult>((resolve) => {
    const useProcessGroup = process.platform !== "win32";
    const child = useProcessGroup
      ? spawn("/bin/sh", ["-lc", normalizedCommand], {
          cwd,
          detached: true,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(normalizedCommand, {
          cwd,
          env: process.env,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let launchError = "";
    let settled = false;

    const appendOutput = (
      current: string,
      chunk: Buffer | string,
    ): { value: string; truncated: boolean } => {
      const next = `${current}${String(chunk)}`;
      if (next.length <= maxOutputChars) {
        return { value: next, truncated: false };
      }
      return {
        value: next.slice(-maxOutputChars),
        truncated: true,
      };
    };
    child.stdout?.on("data", (chunk) => {
      const next = appendOutput(stdout, chunk);
      stdout = next.value;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr?.on("data", (chunk) => {
      const next = appendOutput(stderr, chunk);
      stderr = next.value;
      stderrTruncated = stderrTruncated || next.truncated;
    });
    child.on("error", (error) => {
      launchError = error instanceof Error ? error.message : String(error);
    });

    const terminate = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (useProcessGroup) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // The process may have exited between the timeout and the signal.
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      const forceKill = setTimeout(() => terminate("SIGKILL"), 1_000);
      forceKill.unref?.();
    }, timeoutMs);
    timeout.unref?.();

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (launchError) {
        stderr = `${stderr}${stderr ? "\n" : ""}${launchError}`;
      }
      resolve({
        command: normalizedCommand,
        cwd,
        exitCode: typeof code === "number" ? code : 1,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

export interface RealOmlxSearchFileSelection {
  files: string[];
  maxFiles: number;
  eligibleFiles: number;
  skippedNonTextFiles: number;
  truncated: boolean;
}

export type RealOmlxBoundedTextRead =
  | {
      ok: true;
      path: string;
      content: string;
      sizeBytes: number;
    }
  | {
      ok: false;
      path: string;
      content: "";
      sizeBytes: number;
      reason: "binary" | "not_file" | "outside_workspace" | "read_error" | "too_large";
    };

export interface RealOmlxBoundedTextBatch {
  files: Array<{ path: string; content: string; sizeBytes: number }>;
  skipped: Array<{ path: string; reason: string; sizeBytes: number }>;
  requestedFiles: number;
  consideredFiles: number;
  totalBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  truncated: boolean;
}

export interface RealOmlxFileWindow {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  totalChars: number;
  returnedChars: number;
  truncated: boolean;
  nextStartLine: number | null;
  scanTruncated: boolean;
  scannedBytes: number;
  sizeBytes: number;
}

export interface RealOmlxAcceptanceState {
  authoringContractIds: string[];
  evidenceBundleHashes: string[];
  observedSubagentPreferences: string[];
  spawnedScopes: Array<{
    scopeKey: string;
    subagentIds: string[];
  }>;
  joinedSubagentIds: string[];
  joinedScopeKeys: string[];
  consumedScopeKeys: string[];
}

export interface RealOmlxCollaborationScopeState {
  scopeKey: string;
  subagentIds: string[];
  spawned: boolean;
  joined: boolean;
  consumed: boolean;
}

export function createRealOmlxAcceptanceState(): RealOmlxAcceptanceState {
  return {
    authoringContractIds: [],
    evidenceBundleHashes: [],
    observedSubagentPreferences: [],
    spawnedScopes: [],
    joinedSubagentIds: [],
    joinedScopeKeys: [],
    consumedScopeKeys: [],
  };
}

function appendUnique(values: string[], candidates: unknown[]): string[] {
  return [...new Set([
    ...values,
    ...candidates.map((value) => String(value || "").trim()).filter(Boolean),
  ])];
}

function parseStructuredDebugMessage(message: unknown): Record<string, unknown> {
  if (message && typeof message === "object" && !Array.isArray(message)) {
    return message as Record<string, unknown>;
  }
  if (typeof message !== "string") return {};
  try {
    const parsed = JSON.parse(message);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Retain the small set of structured facts used by real-model acceptance in a
 * dedicated ledger. Unlike the human debug tail, this state is keyed and is
 * not evicted when a slower model produces many recovery diagnostics.
 */
export function recordRealOmlxAcceptanceDebugEvent(
  current: RealOmlxAcceptanceState,
  source: unknown,
  message: unknown,
): RealOmlxAcceptanceState {
  const eventSource = String(source || "").trim();
  const payload = parseStructuredDebugMessage(message);
  let next: RealOmlxAcceptanceState = {
    ...current,
    authoringContractIds: [...current.authoringContractIds],
    evidenceBundleHashes: [...current.evidenceBundleHashes],
    observedSubagentPreferences: [...current.observedSubagentPreferences],
    spawnedScopes: current.spawnedScopes.map((entry) => ({
      scopeKey: entry.scopeKey,
      subagentIds: [...entry.subagentIds],
    })),
    joinedSubagentIds: [...current.joinedSubagentIds],
    joinedScopeKeys: [...current.joinedScopeKeys],
    consumedScopeKeys: [...current.consumedScopeKeys],
  };

  if (eventSource === "agent.plan_authoring_contract_injected") {
    next.authoringContractIds = appendUnique(next.authoringContractIds, [payload.contractId]);
  }
  if (["agent.plan_evidence_bundle_ready", "agent.plan_evidence_bundle_injected"].includes(eventSource)) {
    next.evidenceBundleHashes = appendUnique(next.evidenceBundleHashes, [payload.evidenceBundleHash]);
  }
  if (eventSource === "agent.task_orchestrator_phase") {
    next.observedSubagentPreferences = appendUnique(
      next.observedSubagentPreferences,
      [payload.subagentPreference],
    );
  }
  if (eventSource === "agent.semantic_collaboration_task_spawned") {
    const scopeKey = String(payload.scopeKey || "").trim();
    const subagentId = String(payload.subagentId || "").trim();
    if (scopeKey) {
      const existing = next.spawnedScopes.find((entry) => entry.scopeKey === scopeKey);
      if (existing) {
        existing.subagentIds = appendUnique(existing.subagentIds, [subagentId]);
      } else {
        next.spawnedScopes.push({
          scopeKey,
          subagentIds: appendUnique([], [subagentId]),
        });
      }
    }
  }
  if (eventSource === "parent_join_injected") {
    next.joinedSubagentIds = appendUnique(
      next.joinedSubagentIds,
      Array.isArray(payload.resultIds) ? payload.resultIds : [],
    );
  }
  if (eventSource === "parent_resume") {
    next.joinedSubagentIds = appendUnique(
      next.joinedSubagentIds,
      Array.isArray(payload.subagentIds) ? payload.subagentIds : [],
    );
  }
  if (eventSource === "agent.semantic_collaboration_evidence_consumed") {
    const outcomes = Array.isArray(payload.outcomes) ? payload.outcomes : [];
    for (const value of outcomes) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const outcome = value as Record<string, unknown>;
      const scopeKey = String(outcome.taskKey || outcome.scopeKey || "").trim();
      next.joinedSubagentIds = appendUnique(next.joinedSubagentIds, [outcome.subagentId]);
      next.joinedScopeKeys = appendUnique(next.joinedScopeKeys, [scopeKey]);
      if (outcome.evidenceAdopted === true || outcome.consumed === true) {
        next.consumedScopeKeys = appendUnique(next.consumedScopeKeys, [scopeKey]);
      }
    }
    next.consumedScopeKeys = appendUnique(
      next.consumedScopeKeys,
      Array.isArray(payload.consumedScopeKeys) ? payload.consumedScopeKeys : [],
    );
  }
  return next;
}

export function projectRealOmlxCollaborationScopes(input: {
  acceptance: RealOmlxAcceptanceState;
  runs: Array<{ id?: unknown; scopeKey?: unknown }>;
  expectedScopeKeys?: string[];
}): RealOmlxCollaborationScopeState[] {
  const runScopes = input.runs.map((run) => ({
    id: String(run.id || "").trim(),
    scopeKey: String(run.scopeKey || "").trim(),
  })).filter((run) => run.id && run.scopeKey);
  const scopeKeys = appendUnique(
    [],
    input.expectedScopeKeys?.length
      ? input.expectedScopeKeys
      : [
          ...input.acceptance.spawnedScopes.map((entry) => entry.scopeKey),
          ...runScopes.map((run) => run.scopeKey),
        ],
  );
  const joinedIds = new Set(input.acceptance.joinedSubagentIds);
  const joinedScopes = new Set(input.acceptance.joinedScopeKeys);
  const consumedScopes = new Set(input.acceptance.consumedScopeKeys);
  return scopeKeys.map((scopeKey) => {
    const recordedIds = input.acceptance.spawnedScopes.find(
      (entry) => entry.scopeKey === scopeKey,
    )?.subagentIds || [];
    const subagentIds = appendUnique(
      [],
      [...recordedIds, ...runScopes.filter((run) => run.scopeKey === scopeKey).map((run) => run.id)],
    );
    return {
      scopeKey,
      subagentIds,
      spawned: subagentIds.length > 0,
      joined: joinedScopes.has(scopeKey) || subagentIds.some((id) => joinedIds.has(id)),
      consumed: consumedScopes.has(scopeKey),
    };
  });
}

function normalizeRelativePath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function resolveExistingWorkspaceFile(
  workspace: string,
  rawPath: string,
): Promise<{ absolutePath: string; relativePath: string } | null> {
  const root = path.resolve(workspace);
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(root, rawPath || ".");
  if (!isInsideRoot(candidate, root)) return null;
  try {
    const realRoot = await fs.realpath(root);
    const realCandidate = await fs.realpath(candidate);
    if (!isInsideRoot(realCandidate, realRoot)) return null;
    return {
      absolutePath: realCandidate,
      relativePath: normalizeRelativePath(path.relative(realRoot, realCandidate)),
    };
  } catch {
    return null;
  }
}

function containsNullByte(value: Uint8Array): boolean {
  const sampleLength = Math.min(value.length, 4_096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (value[index] === 0) return true;
  }
  return false;
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), maximum));
}

function takePrefixChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return Array.from(value).slice(0, maxChars).join("");
}

export function shouldPruneRealOmlxWorkspaceDirectory(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const name = path.posix.basename(normalized).toLowerCase();
  if (!name) return false;
  if (name.startsWith(".")) return true;
  if (IGNORED_DIRECTORY_NAMES.has(name)) return true;
  const lowerPath = normalized.toLowerCase();
  return lowerPath === "src-tauri/gen" ||
    lowerPath.startsWith("src-tauri/gen/") ||
    lowerPath === "src-tauri/icons" ||
    lowerPath.startsWith("src-tauri/icons/");
}

export function isRealOmlxSearchableTextPath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath);
  const basename = path.posix.basename(normalized).toLowerCase();
  if (!basename || basename.startsWith(".")) return false;
  const extension = path.posix.extname(basename).toLowerCase();
  return extension
    ? SEARCHABLE_TEXT_EXTENSIONS.has(extension)
    : SEARCHABLE_EXTENSIONLESS_FILES.has(basename);
}

export async function collectBoundedRealOmlxWorkspaceFiles(
  workspace: string,
  options: { maxFiles?: number } = {},
): Promise<RealOmlxWorkspaceInventory> {
  const root = path.resolve(workspace);
  const maxFiles = boundedPositiveInteger(
    options.maxFiles,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxWorkspaceFiles,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxWorkspaceFiles,
  );
  const files: string[] = [];
  const pendingDirectories: Array<{ absolutePath: string; relativePath: string }> = [{
    absolutePath: root,
    relativePath: "",
  }];
  let visitedDirectories = 0;
  let prunedDirectories = 0;
  let skippedEntries = 0;
  let truncated = false;

  while (pendingDirectories.length > 0 && files.length < maxFiles) {
    const current = pendingDirectories.pop()!;
    visitedDirectories += 1;
    let entries;
    try {
      entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    } catch {
      skippedEntries += 1;
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const childDirectories: Array<{ absolutePath: string; relativePath: string }> = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const relativePath = normalizeRelativePath(
        current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name,
      );
      if (entry.isDirectory()) {
        if (shouldPruneRealOmlxWorkspaceDirectory(relativePath)) {
          prunedDirectories += 1;
        } else {
          childDirectories.push({
            absolutePath: path.join(current.absolutePath, entry.name),
            relativePath,
          });
        }
        continue;
      }
      if (!entry.isFile()) {
        // Never follow symlinks or device files from a disposable real-workspace copy.
        skippedEntries += 1;
        continue;
      }
      files.push(relativePath);
      if (files.length >= maxFiles) {
        truncated = index < entries.length - 1 || childDirectories.length > 0 || pendingDirectories.length > 0;
        break;
      }
    }
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      pendingDirectories.push(childDirectories[index]);
    }
  }

  if (pendingDirectories.length > 0) truncated = true;
  return {
    files,
    maxFiles,
    truncated,
    visitedDirectories,
    prunedDirectories,
    skippedEntries,
  };
}

export function selectBoundedRealOmlxSearchFiles(
  filePaths: string[],
  options: { maxFiles?: number } = {},
): RealOmlxSearchFileSelection {
  const maxFiles = boundedPositiveInteger(
    options.maxFiles,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFiles,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFiles,
  );
  const uniquePaths = [...new Set((Array.isArray(filePaths) ? filePaths : [])
    .map(normalizeRelativePath)
    .filter(Boolean))];
  const eligible = uniquePaths.filter(isRealOmlxSearchableTextPath);
  return {
    files: eligible.slice(0, maxFiles),
    maxFiles,
    eligibleFiles: eligible.length,
    skippedNonTextFiles: uniquePaths.length - eligible.length,
    truncated: eligible.length > maxFiles,
  };
}

export async function readBoundedRealOmlxWorkspaceTextFile(
  workspace: string,
  rawPath: string,
  options: { maxBytes?: number } = {},
): Promise<RealOmlxBoundedTextRead> {
  const maxBytes = boundedPositiveInteger(
    options.maxBytes,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFileBytes,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxExplicitReadBytes,
  );
  const fallbackPath = normalizeRelativePath(rawPath);
  const resolved = await resolveExistingWorkspaceFile(workspace, rawPath);
  if (!resolved) {
    return { ok: false, path: fallbackPath, content: "", sizeBytes: 0, reason: "outside_workspace" };
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const metadata = await fs.stat(resolved.absolutePath);
    if (!metadata.isFile()) {
      return { ok: false, path: resolved.relativePath, content: "", sizeBytes: metadata.size, reason: "not_file" };
    }
    if (metadata.size > maxBytes) {
      return { ok: false, path: resolved.relativePath, content: "", sizeBytes: metadata.size, reason: "too_large" };
    }
    handle = await fs.open(resolved.absolutePath, "r");
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(1, metadata.size + 1)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      return { ok: false, path: resolved.relativePath, content: "", sizeBytes: bytesRead, reason: "too_large" };
    }
    const body = buffer.subarray(0, bytesRead);
    if (containsNullByte(body)) {
      return { ok: false, path: resolved.relativePath, content: "", sizeBytes: bytesRead, reason: "binary" };
    }
    return {
      ok: true,
      path: resolved.relativePath,
      content: body.toString("utf8"),
      sizeBytes: bytesRead,
    };
  } catch {
    return { ok: false, path: resolved.relativePath, content: "", sizeBytes: 0, reason: "read_error" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readBoundedRealOmlxWorkspaceTextFiles(
  workspace: string,
  rawPaths: string[],
  options: {
    concurrency?: number;
    maxFileBytes?: number;
    maxFiles?: number;
    maxTotalBytes?: number;
  } = {},
): Promise<RealOmlxBoundedTextBatch> {
  const maxFiles = boundedPositiveInteger(
    options.maxFiles,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFiles,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFiles,
  );
  const maxFileBytes = boundedPositiveInteger(
    options.maxFileBytes,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFileBytes,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxExplicitReadBytes,
  );
  const maxTotalBytes = boundedPositiveInteger(
    options.maxTotalBytes,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchTotalBytes,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchTotalBytes,
  );
  const concurrency = boundedPositiveInteger(
    options.concurrency,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.searchReadConcurrency,
    16,
  );
  const uniquePaths = [...new Set((Array.isArray(rawPaths) ? rawPaths : [])
    .map(normalizeRelativePath)
    .filter(Boolean))];
  const candidates = uniquePaths.slice(0, maxFiles);
  const files: RealOmlxBoundedTextBatch["files"] = [];
  const skipped: RealOmlxBoundedTextBatch["skipped"] = [];
  let totalBytes = 0;
  let consideredFiles = 0;
  let budgetExhausted = false;

  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    if (budgetExhausted) break;
    const chunk = candidates.slice(offset, offset + concurrency);
    const results = await Promise.all(chunk.map((filePath) =>
      readBoundedRealOmlxWorkspaceTextFile(workspace, filePath, { maxBytes: maxFileBytes })
    ));
    consideredFiles += results.length;
    for (const result of results) {
      if (!result.ok) {
        skipped.push({ path: result.path, reason: result.reason, sizeBytes: result.sizeBytes });
        continue;
      }
      if (totalBytes + result.sizeBytes > maxTotalBytes) {
        skipped.push({ path: result.path, reason: "total_budget", sizeBytes: result.sizeBytes });
        budgetExhausted = true;
        continue;
      }
      files.push({ path: result.path, content: result.content, sizeBytes: result.sizeBytes });
      totalBytes += result.sizeBytes;
    }
  }

  if (budgetExhausted && consideredFiles < candidates.length) {
    for (const filePath of candidates.slice(consideredFiles)) {
      skipped.push({ path: filePath, reason: "total_budget", sizeBytes: 0 });
    }
  }
  return {
    files,
    skipped,
    requestedFiles: uniquePaths.length,
    consideredFiles,
    totalBytes,
    maxFiles,
    maxTotalBytes,
    truncated: uniquePaths.length > maxFiles || skipped.length > 0,
  };
}

export async function readRealOmlxWorkspaceFileWindow(
  workspace: string,
  rawPath: string,
  options: {
    startLine?: number;
    endLine?: number;
    maxLines?: number;
    maxChars?: number;
    maxScanBytes?: number;
  } = {},
): Promise<RealOmlxFileWindow> {
  const resolved = await resolveExistingWorkspaceFile(workspace, rawPath);
  if (!resolved) throw new Error(`E2E_WORKSPACE_READ_OUT_OF_SCOPE: ${rawPath}`);
  const metadata = await fs.stat(resolved.absolutePath);
  if (!metadata.isFile()) throw new Error(`E2E_WORKSPACE_READ_NOT_FILE: ${rawPath}`);
  const sampleHandle = await fs.open(resolved.absolutePath, "r");
  try {
    const sample = Buffer.alloc(Math.min(Math.max(1, metadata.size), 4_096));
    const { bytesRead } = await sampleHandle.read(sample, 0, sample.length, 0);
    if (containsNullByte(sample.subarray(0, bytesRead))) {
      throw new Error(`E2E_WORKSPACE_READ_BINARY: ${rawPath}`);
    }
  } finally {
    await sampleHandle.close().catch(() => {});
  }

  const startLine = boundedPositiveInteger(options.startLine, 1, Number.MAX_SAFE_INTEGER);
  const maxLines = boundedPositiveInteger(options.maxLines, 1_000, 2_000);
  const requestedEndLine = Math.max(
    startLine,
    Math.min(
      boundedPositiveInteger(options.endLine, startLine + maxLines - 1, Number.MAX_SAFE_INTEGER),
      startLine + maxLines - 1,
    ),
  );
  const maxChars = boundedPositiveInteger(options.maxChars, 32_000, 64_000);
  const maxScanBytes = boundedPositiveInteger(
    options.maxScanBytes,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxWindowScanBytes,
    REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxWindowScanBytes,
  );
  const bytesToScan = Math.min(metadata.size, maxScanBytes);
  const scanTruncated = metadata.size > bytesToScan;
  const selected: string[] = [];
  let selectedChars = 0;
  let totalLines = 0;
  let totalChars = 0;
  let lineTruncated = false;

  if (bytesToScan > 0) {
    const stream = createReadStream(resolved.absolutePath, {
      encoding: "utf8",
      start: 0,
      end: bytesToScan - 1,
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        totalLines += 1;
        const lineChars = Array.from(line).length;
        totalChars += lineChars + (totalLines > 1 ? 1 : 0);
        if (totalLines < startLine || totalLines > requestedEndLine || lineTruncated) continue;
        const separatorChars = selected.length > 0 ? 1 : 0;
        const nextChars = selectedChars + separatorChars + lineChars;
        if (selected.length > 0 && nextChars > maxChars) {
          lineTruncated = true;
          continue;
        }
        if (selected.length === 0 && nextChars > maxChars) {
          selected.push(takePrefixChars(line, maxChars));
          selectedChars = maxChars;
          lineTruncated = true;
          continue;
        }
        selected.push(line);
        selectedChars = nextChars;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  const returnedStartLine = totalLines === 0 || selected.length === 0 ? 0 : Math.min(startLine, totalLines);
  const returnedEndLine = returnedStartLine === 0 ? 0 : returnedStartLine + selected.length - 1;
  const notWholeScannedFile = returnedStartLine !== 1 || returnedEndLine !== totalLines;
  const moreRequestedLines = returnedEndLine > 0 && returnedEndLine < Math.min(requestedEndLine, Math.max(1, totalLines));
  const moreScannedLines = returnedEndLine > 0 && returnedEndLine < totalLines;
  const truncated = scanTruncated || notWholeScannedFile || moreRequestedLines || moreScannedLines || lineTruncated;
  return {
    path: rawPath,
    content: selected.join("\n"),
    startLine: returnedStartLine,
    endLine: returnedEndLine,
    totalLines,
    totalChars,
    returnedChars: selectedChars,
    truncated,
    nextStartLine: truncated && returnedEndLine > 0 ? returnedEndLine + 1 : null,
    scanTruncated,
    scannedBytes: bytesToScan,
    sizeBytes: metadata.size,
  };
}

export function compactRealOmlxDebugEntry(
  input: Record<string, unknown> | null | undefined,
  maxMessageChars = REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxDebugMessageChars,
): Record<string, unknown> {
  const message = typeof input?.message === "string" ? input.message : String(input?.message ?? "");
  const boundedMessage = message.length <= maxMessageChars
    ? message
    : `${message.slice(0, maxMessageChars)}...<e2e-debug-truncated:${message.length}>`;
  return {
    timestamp: String(input?.timestamp || ""),
    level: String(input?.level || ""),
    source: String(input?.source || ""),
    message: boundedMessage,
  };
}
