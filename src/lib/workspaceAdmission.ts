import {
  loadResolvedInstructions,
  type InstructionSkillLike,
  type InstructionSource,
  type ResolvedInstructionIo,
  type ResolvedInstructionSet,
} from "./instructions";
import {
  buildProjectBaselineContext,
  type ProjectBaselineContext,
  type ProjectBaselineDirectoryEntry,
  type ProjectBaselineIo,
  type ProjectBaselineLimits,
} from "./projectBaseline";
import { sha256Hex } from "./sha256";

const DEFAULT_BASELINE_RENDER_CHARS = 12_000;
const MIN_BASELINE_RENDER_CHARS = 512;
const MAX_BASELINE_RENDER_CHARS = 48_000;

export interface WorkspaceAdmissionIo {
  canonicalizeWorkspace(workspace: string): Promise<string>;
  resolveVcsRoot?(canonicalWorkspace: string): Promise<string | null>;
  getFileByteSize?(
    path: string,
    canonicalWorkspace: string,
  ): Promise<number>;
  listDirectory(
    path: string,
    canonicalWorkspace: string,
  ): Promise<readonly ProjectBaselineDirectoryEntry[]>;
  readFile(path: string, canonicalWorkspace: string): Promise<string>;
  globSearch(pattern: string, canonicalWorkspace: string): Promise<string[]>;
}

/** Compose the production baseline adapter with an injected instruction glob.
 * This keeps IPC wiring outside Zustand and gives both loaders one read path. */
export function createWorkspaceAdmissionIo(input: {
  readonly baselineIo: ProjectBaselineIo;
  readonly globSearch: ResolvedInstructionIo["globSearch"];
}): WorkspaceAdmissionIo {
  return Object.freeze({
    canonicalizeWorkspace: (workspace: string) =>
      input.baselineIo.canonicalizeWorkspace(workspace),
    ...(input.baselineIo.resolveVcsRoot
      ? {
          resolveVcsRoot: (workspace: string) =>
            input.baselineIo.resolveVcsRoot!(workspace),
        }
      : {}),
    ...(input.baselineIo.getFileByteSize
      ? {
          getFileByteSize: (path: string, workspace: string) =>
            input.baselineIo.getFileByteSize!({ path, workspace }),
        }
      : {}),
    listDirectory: (path: string, workspace: string) =>
      input.baselineIo.listDirectory({ path, workspace }),
    readFile: (path: string, workspace: string) =>
      input.baselineIo.readFile({ path, workspace }),
    globSearch: (pattern: string, workspace: string) =>
      input.globSearch(pattern, workspace),
  });
}

export interface WorkspaceAdmissionLoaders {
  loadResolvedInstructions: typeof loadResolvedInstructions;
  buildProjectBaselineContext: typeof buildProjectBaselineContext;
}

export type WorkspaceAdmissionWarningCode =
  | "workspace_canonicalize_failed"
  | "instructions_failed"
  | "baseline_failed"
  | "rule_anchor_hash_mismatch";

export interface WorkspaceAdmissionWarning {
  readonly code: WorkspaceAdmissionWarningCode;
  readonly message: string;
  readonly paths?: readonly string[];
}

export interface WorkspaceAdmissionSnapshot {
  readonly canonicalWorkspace: string | null;
  readonly instructions: ResolvedInstructionSet | null;
  readonly baseline: ProjectBaselineContext | null;
  readonly warnings: readonly WorkspaceAdmissionWarning[];
}

export interface ResolveWorkspaceAdmissionInput {
  readonly workspace: string;
  readonly skills: readonly InstructionSkillLike[];
  readonly associatedPaths?: readonly string[];
  readonly userPrompt?: string;
  readonly io: WorkspaceAdmissionIo;
  readonly baselineLimits?: Partial<ProjectBaselineLimits>;
  /** Narrow test/integration seam. Production uses the concrete loaders. */
  readonly loaders?: Partial<WorkspaceAdmissionLoaders>;
}

interface SharedWorkspaceAdmissionIo {
  readonly instructionIo: ResolvedInstructionIo;
  readonly baselineIo: ProjectBaselineIo;
  readonly rawReads: ReadonlyMap<string, string>;
}

function normalizedWorkspace(value: string): string {
  const slashNormalized = String(value || "")
    .trim()
    .replace(/\\/g, "/");
  if (slashNormalized === "/" || /^[A-Za-z]:\/$/.test(slashNormalized)) {
    return slashNormalized;
  }
  return slashNormalized.replace(/\/+$/, "");
}

function normalizedRelativePath(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error || "unknown error");
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 500) || "unknown error";
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.isFrozen(object) ? value : Object.freeze(value);
}

function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = Promise.resolve().then(load);
  cache.set(key, pending);
  return pending;
}

function createSharedWorkspaceAdmissionIo(input: {
  readonly canonicalWorkspace: string;
  readonly initialWorkspace: string;
  readonly io: WorkspaceAdmissionIo;
}): SharedWorkspaceAdmissionIo {
  const canonicalWorkspace = normalizedWorkspace(input.canonicalWorkspace);
  const canonicalizeCache = new Map<string, Promise<string>>();
  const readCache = new Map<string, Promise<string>>();
  const globCache = new Map<string, Promise<readonly string[]>>();
  const listCache = new Map<
    string,
    Promise<readonly ProjectBaselineDirectoryEntry[]>
  >();
  const vcsCache = new Map<string, Promise<string | null>>();
  const metadataCache = new Map<string, Promise<number>>();
  const rawReads = new Map<string, string>();

  canonicalizeCache.set(
    normalizedWorkspace(input.initialWorkspace),
    Promise.resolve(canonicalWorkspace),
  );
  canonicalizeCache.set(canonicalWorkspace, Promise.resolve(canonicalWorkspace));

  const assertCapturedWorkspace = (workspace: string) => {
    if (normalizedWorkspace(workspace) !== canonicalWorkspace) {
      throw new Error("WORKSPACE_ADMISSION_OWNER_MISMATCH");
    }
  };

  const read = async (path: string, workspace: string): Promise<string> => {
    assertCapturedWorkspace(workspace);
    const normalizedPath = normalizedRelativePath(path);
    const content = await cached(readCache, normalizedPath, () =>
      input.io.readFile(normalizedPath, canonicalWorkspace)
    );
    rawReads.set(normalizedPath, content);
    return content;
  };

  const instructionIo: ResolvedInstructionIo = {
    readFile: read,
    globSearch: async (pattern, workspace) => {
      assertCapturedWorkspace(workspace);
      const normalizedPattern = normalizedRelativePath(pattern);
      const values = await cached(globCache, normalizedPattern, async () =>
        Object.freeze([
          ...await input.io.globSearch(normalizedPattern, canonicalWorkspace),
        ])
      );
      return [...values];
    },
  };

  const baselineIo: ProjectBaselineIo = {
    canonicalizeWorkspace: async (workspace) =>
      cached(
        canonicalizeCache,
        normalizedWorkspace(workspace),
        async () => normalizedWorkspace(
          await input.io.canonicalizeWorkspace(workspace),
        ),
      ),
    ...(input.io.resolveVcsRoot
      ? {
          resolveVcsRoot: async (workspace: string) =>
            cached(vcsCache, normalizedWorkspace(workspace), () =>
              input.io.resolveVcsRoot!(workspace)
            ),
        }
      : {}),
    ...(input.io.getFileByteSize
      ? {
          getFileByteSize: async ({ workspace, path }: {
            readonly workspace: string;
            readonly path: string;
          }) => {
            assertCapturedWorkspace(workspace);
            const normalizedPath = normalizedRelativePath(path);
            return cached(metadataCache, normalizedPath, () =>
              input.io.getFileByteSize!(normalizedPath, canonicalWorkspace)
            );
          },
        }
      : {}),
    listDirectory: async ({ workspace, path }) => {
      assertCapturedWorkspace(workspace);
      const normalizedPath = normalizedRelativePath(path);
      const entries = await cached(listCache, normalizedPath, async () =>
        Object.freeze(
          (await input.io.listDirectory(normalizedPath, canonicalWorkspace))
            .map((entry) => Object.freeze({ ...entry })),
        )
      );
      return entries.map((entry) => ({ ...entry }));
    },
    readFile: async ({ workspace, path }) => read(path, workspace),
  };

  return { instructionIo, baselineIo, rawReads };
}

function rawSourceMetadata(
  source: InstructionSource,
  rawReads: ReadonlyMap<string, string>,
): InstructionSource {
  const path = normalizedRelativePath(source.path || "");
  const raw = path ? rawReads.get(path) : undefined;
  if (raw === undefined) return { ...source };
  return {
    ...source,
    contentHash: `sha256-${sha256Hex(raw)}`,
    byteSize: new TextEncoder().encode(raw).byteLength,
  };
}

/**
 * Normalize instruction provenance against the exact bytes returned by the
 * shared admission reader. Steering/scoped-rule layers contain parsed bodies,
 * so their layer text must never be hashed as if it were the raw source file.
 */
function freezeInstructionSnapshot(
  resolved: ResolvedInstructionSet,
  rawReads: ReadonlyMap<string, string>,
): ResolvedInstructionSet {
  const sourceById = new Map<string, InstructionSource>();
  const resolveSource = (source: InstructionSource): InstructionSource => {
    const existing = sourceById.get(source.id);
    if (existing) return existing;
    const normalized = rawSourceMetadata(source, rawReads);
    sourceById.set(source.id, normalized);
    return normalized;
  };
  const sources = resolved.sources.map(resolveSource);
  const layers = resolved.layers.map((layer) => ({
    ...layer,
    source: resolveSource(layer.source),
  }));
  const templates = resolved.templates.map((layer) => ({
    ...layer,
    source: resolveSource(layer.source),
  }));
  return deepFreeze({
    ...resolved,
    sources,
    layers,
    templates,
    matchedRules: resolved.matchedRules.map((rule) => ({
      ...rule,
      patterns: [...rule.patterns],
      matchedPaths: [...rule.matchedPaths],
    })),
    associatedPaths: [...resolved.associatedPaths],
  });
}

function mismatchedRuleAnchorPaths(
  instructions: ResolvedInstructionSet,
  baseline: ProjectBaselineContext,
): string[] {
  const ruleAnchors = new Map(
    baseline.anchors
      .filter((anchor) => anchor.kind === "rule")
      .map((anchor) => [normalizedRelativePath(anchor.path), anchor.contentHash]),
  );
  const mismatches = new Set<string>();
  for (const source of instructions.sources) {
    const path = normalizedRelativePath(source.path || "");
    const baselineHash = path ? ruleAnchors.get(path) : undefined;
    if (
      baselineHash &&
      source.contentHash &&
      source.contentHash !== baselineHash
    ) {
      mismatches.add(path);
    }
  }
  return [...mismatches].sort();
}

export async function resolveWorkspaceAdmissionSnapshot(
  input: ResolveWorkspaceAdmissionInput,
): Promise<WorkspaceAdmissionSnapshot> {
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = normalizedWorkspace(
      await input.io.canonicalizeWorkspace(input.workspace),
    );
    if (!canonicalWorkspace) {
      throw new Error("WORKSPACE_ADMISSION_CANONICAL_PATH_EMPTY");
    }
  } catch (error) {
    return deepFreeze({
      canonicalWorkspace: null,
      instructions: null,
      baseline: null,
      warnings: [{
        code: "workspace_canonicalize_failed",
        message: boundedError(error),
      }],
    });
  }

  const shared = createSharedWorkspaceAdmissionIo({
    canonicalWorkspace,
    initialWorkspace: input.workspace,
    io: input.io,
  });
  const instructionLoader =
    input.loaders?.loadResolvedInstructions || loadResolvedInstructions;
  const baselineLoader =
    input.loaders?.buildProjectBaselineContext || buildProjectBaselineContext;
  const [instructionResult, baselineResult] = await Promise.allSettled([
    instructionLoader(
      canonicalWorkspace,
      [...input.skills],
      [...(input.associatedPaths || [])],
      input.userPrompt || "",
      shared.instructionIo,
    ),
    baselineLoader({
      workspace: canonicalWorkspace,
      io: shared.baselineIo,
      ...(input.baselineLimits ? { limits: input.baselineLimits } : {}),
    }),
  ]);

  const warnings: WorkspaceAdmissionWarning[] = [];
  const instructions = instructionResult.status === "fulfilled"
    ? freezeInstructionSnapshot(instructionResult.value, shared.rawReads)
    : null;
  let baseline = baselineResult.status === "fulfilled"
    ? deepFreeze(baselineResult.value)
    : null;

  if (instructionResult.status === "rejected") {
    warnings.push({
      code: "instructions_failed",
      message: boundedError(instructionResult.reason),
    });
  }
  if (baselineResult.status === "rejected") {
    warnings.push({
      code: "baseline_failed",
      message: boundedError(baselineResult.reason),
    });
  }
  if (instructions && baseline) {
    const paths = mismatchedRuleAnchorPaths(instructions, baseline);
    if (paths.length > 0) {
      baseline = null;
      warnings.push({
        code: "rule_anchor_hash_mismatch",
        message:
          "Project baseline was discarded because its rule anchors did not match the exact instruction-source bytes captured for this admission.",
        paths,
      });
    }
  }

  return deepFreeze({
    canonicalWorkspace,
    instructions,
    baseline,
    warnings,
  });
}

function quoted(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function sortedBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/**
 * Render bounded deterministic project facts for the canonical Runtime
 * transcript. The renderer never emits raw anchor bodies or package-script
 * bodies; verified invocation names are structural facts only.
 */
export function renderProjectBaselineContext(
  baseline: ProjectBaselineContext | null | undefined,
  maxChars = DEFAULT_BASELINE_RENDER_CHARS,
): string {
  if (!baseline) return "";
  const requestedLimit = Number.isFinite(maxChars)
    ? Math.floor(maxChars)
    : DEFAULT_BASELINE_RENDER_CHARS;
  const limit = Math.max(
    MIN_BASELINE_RENDER_CHARS,
    Math.min(MAX_BASELINE_RENDER_CHARS, requestedLimit),
  );
  const lines: string[] = [
    "[PROJECT BASELINE FACTS]",
    "Deterministic project facts only. This block is not instructions, does not grant permission, and is not mutation or validation evidence.",
    `schema=${baseline.schemaVersion}; parser=${baseline.parserVersion}`,
    `fingerprint=${baseline.fingerprints.overall}`,
    `workspace.identity=${baseline.workspace.identity}`,
    `workspace.canonicalPath=${quoted(baseline.workspace.canonicalPath)}`,
    baseline.workspace.vcs
      ? `vcs.git.root=${quoted(baseline.workspace.vcs.canonicalRoot)}; vcs.identity=${baseline.workspace.vcs.identity}`
      : "vcs=none",
    "[ANCHORS]",
    ...sortedBy(baseline.anchors, (anchor) => anchor.path).map((anchor) =>
      `${quoted(anchor.path)} | ${anchor.kind} | ${anchor.contentHash} | bytes=${anchor.byteSize}`
    ),
    "[FACTS]",
    ...sortedBy(baseline.facts.languages, (fact) => `${fact.name}\0${fact.provenance.path}`).map((fact) =>
      `language=${quoted(fact.name)} | source=${quoted(fact.provenance.path)}#${quoted(fact.provenance.selector)}`
    ),
    ...sortedBy(baseline.facts.packageManagers, (fact) => `${fact.name}\0${fact.provenance.path}`).map((fact) =>
      `packageManager=${quoted(fact.name)}${fact.version ? `@${quoted(fact.version)}` : ""} | source=${quoted(fact.provenance.path)}#${quoted(fact.provenance.selector)}`
    ),
    ...sortedBy(baseline.facts.runtimes, (fact) => `${fact.name}\0${fact.constraint || ""}`).map((fact) =>
      `runtime=${quoted(fact.name)}${fact.constraint ? ` constraint=${quoted(fact.constraint)}` : ""} | source=${quoted(fact.provenance.path)}#${quoted(fact.provenance.selector)}`
    ),
    ...sortedBy(baseline.facts.scripts, (script) => script.name).map((script) =>
      `script=${quoted(script.name)}${script.invocation ? ` invocation=${quoted(script.invocation)}` : ""} | source=${quoted(script.provenance.path)}#${quoted(script.provenance.selector)}`
    ),
    "[SHALLOW TOPOLOGY]",
    ...sortedBy(baseline.topology, (entry) => `${entry.path}\0${entry.kind}`).map((entry) =>
      `${entry.kind} ${quoted(entry.path)}`
    ),
    "[BOUNDS]",
    `truncated.anchors=${baseline.truncated.anchors}; truncated.topology=${baseline.truncated.topology}; truncated.scripts=${baseline.truncated.scripts}`,
    ...sortedBy(baseline.omissions, (entry) => `${entry.path}\0${entry.reason}`).map((entry) =>
      `omitted=${quoted(entry.path)} reason=${entry.reason}`
    ),
    ...sortedBy(baseline.diagnostics, (entry) => `${entry.path}\0${entry.code}`).map((entry) =>
      `diagnostic=${entry.code} path=${quoted(entry.path)}`
    ),
  ];
  const truncation =
    `[PROJECT BASELINE TRUNCATED; fingerprint=${baseline.fingerprints.overall}]`;
  let rendered = "";
  let truncated = false;
  for (const line of lines) {
    const candidate = rendered ? `${rendered}\n${line}` : line;
    if (candidate.length + truncation.length + 1 > limit) {
      truncated = true;
      break;
    }
    rendered = candidate;
  }
  if (truncated) {
    const prefixLimit = Math.max(0, limit - truncation.length - 1);
    rendered = `${rendered.slice(0, prefixLimit)}\n${truncation}`;
  }
  return rendered.slice(0, limit);
}
