import { sha256Hex } from "./sha256";

export const PROJECT_BASELINE_SCHEMA_VERSION = 1;
export const PROJECT_BASELINE_PARSER_VERSION = 1;

export interface ProjectBaselineLimits {
  readonly maxAnchorBytes: number;
  readonly maxTotalAnchorBytes: number;
  readonly maxAnchors: number;
  readonly maxTopologyEntries: number;
  readonly maxDirectoryEntries: number;
  readonly maxTopologyDepth: number;
  readonly maxScripts: number;
  readonly maxPathLength: number;
}

export const DEFAULT_PROJECT_BASELINE_LIMITS: ProjectBaselineLimits = Object.freeze({
  maxAnchorBytes: 2 * 1024 * 1024,
  maxTotalAnchorBytes: 8 * 1024 * 1024,
  maxAnchors: 64,
  maxTopologyEntries: 256,
  maxDirectoryEntries: 256,
  maxTopologyDepth: 2,
  maxScripts: 128,
  maxPathLength: 512,
});

export type ProjectBaselineEntryKind = "file" | "directory" | "symlink";

export interface ProjectBaselineDirectoryEntry {
  readonly name: string;
  readonly kind: ProjectBaselineEntryKind;
}

export interface ProjectBaselineIo {
  canonicalizeWorkspace(workspace: string): Promise<string>;
  resolveVcsRoot?(canonicalWorkspace: string): Promise<string | null>;
  /** Optional production preflight used to reject oversized anchors before
   * loading their contents into the renderer process. */
  getFileByteSize?(input: {
    readonly workspace: string;
    readonly path: string;
  }): Promise<number>;
  listDirectory(input: {
    readonly workspace: string;
    readonly path: string;
  }): Promise<readonly ProjectBaselineDirectoryEntry[]>;
  readFile(input: {
    readonly workspace: string;
    readonly path: string;
  }): Promise<string>;
}

export type ProjectBaselineAnchorKind = "manifest" | "lockfile" | "rule" | "config";

export interface ProjectBaselineAnchor {
  readonly path: string;
  readonly kind: ProjectBaselineAnchorKind;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly provenance: "workspace_file";
}

export interface ProjectBaselineTopologyEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface ProjectBaselineProvenance {
  readonly path: string;
  readonly selector: string;
  readonly contentHash: string;
}

export interface ProjectBaselineFact {
  readonly name: string;
  readonly version?: string;
  readonly constraint?: string;
  readonly provenance: ProjectBaselineProvenance;
}

export interface ProjectBaselineScript {
  readonly name: string;
  readonly invocation: string | null;
  readonly provenance: ProjectBaselineProvenance;
}

export interface ProjectBaselineFacts {
  readonly languages: readonly ProjectBaselineFact[];
  readonly packageManagers: readonly ProjectBaselineFact[];
  readonly runtimes: readonly ProjectBaselineFact[];
  readonly scripts: readonly ProjectBaselineScript[];
}

export type ProjectBaselineOmissionReason =
  | "anchor_count_limit"
  | "anchor_too_large"
  | "total_anchor_bytes_limit"
  | "unsafe_entry";

export interface ProjectBaselineOmission {
  readonly path: string;
  readonly reason: ProjectBaselineOmissionReason;
}

export interface ProjectBaselineDiagnostic {
  readonly code: "manifest_parse_failed";
  readonly path: string;
}

export interface ProjectBaselineContext {
  readonly kind: "project_baseline_context";
  readonly schemaVersion: number;
  readonly parserVersion: number;
  readonly workspace: {
    readonly canonicalPath: string;
    readonly identity: string;
    readonly vcs: {
      readonly kind: "git";
      readonly canonicalRoot: string;
      readonly identity: string;
    } | null;
  };
  readonly limits: ProjectBaselineLimits;
  readonly anchors: readonly ProjectBaselineAnchor[];
  readonly topology: readonly ProjectBaselineTopologyEntry[];
  readonly facts: ProjectBaselineFacts;
  readonly omissions: readonly ProjectBaselineOmission[];
  readonly diagnostics: readonly ProjectBaselineDiagnostic[];
  readonly truncated: { readonly anchors: boolean; readonly topology: boolean; readonly scripts: boolean };
  readonly fingerprints: {
    readonly anchors: string;
    readonly topology: string;
    readonly facts: string;
    readonly overall: string;
  };
}

export type ProjectBaselineStaleReason =
  | "missing_previous"
  | "schema_version"
  | "parser_version"
  | "workspace_identity"
  | "limits"
  | "anchors"
  | "topology"
  | "facts"
  | "fingerprint";

export interface ProjectBaselineComparison {
  readonly status: "fresh" | "stale";
  readonly reasons: readonly ProjectBaselineStaleReason[];
  readonly previousFingerprint: string | null;
  readonly currentFingerprint: string;
}

type AnchorCandidate = { readonly path: string; readonly kind: ProjectBaselineAnchorKind };
type LoadedAnchor = ProjectBaselineAnchor & { readonly content: string };

const STATIC_ANCHORS: readonly AnchorCandidate[] = [
  ...["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "pubspec.yaml", "Package.swift"].map(path => ({ path, kind: "manifest" as const })),
  ...["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "poetry.lock", "uv.lock", "Pipfile.lock", "Cargo.lock", "go.sum", "composer.lock", "Gemfile.lock", "pubspec.lock", "Package.resolved"].map(path => ({ path, kind: "lockfile" as const })),
  ...["AGENTS.md", "AGENT.md", "CLAUDE.md", ".github/copilot-instructions.md", ".cursorrules"].map(path => ({ path, kind: "rule" as const })),
  ...[".gitignore", ".ignore", ".dockerignore", "tsconfig.json", "jsconfig.json", "vite.config.ts", "vite.config.js", "vite.config.mjs", "next.config.js", "next.config.mjs", "next.config.ts", "nuxt.config.ts", "svelte.config.js", "astro.config.mjs", "eslint.config.js", "eslint.config.mjs", "biome.json", "biome.jsonc", "deno.json", "deno.jsonc", "ruff.toml", "pytest.ini", "mypy.ini", "tox.ini", ".python-version", "rust-toolchain.toml", "rustfmt.toml", "go.work", "settings.gradle", "settings.gradle.kts", "Directory.Build.props", "Directory.Build.targets", "global.json", "CMakeLists.txt", "Makefile", "Dockerfile", ".tool-versions", ".nvmrc"].map(path => ({ path, kind: "config" as const })),
];

const DYNAMIC_RULE_DIRECTORIES = [".cursor/rules", ".MAIN/steering", ".MAIN/rules"] as const;
const IGNORED_SEGMENTS = new Set([".git", ".main", "node_modules", "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".svelte-kit", ".cache", "vendor", "pods", "deriveddata", ".venv", "venv", "__pycache__"]);
const SENSITIVE_DIRECTORIES = new Set([".ssh", ".gnupg", ".aws"]);
const SENSITIVE_NAMES = new Set([".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials.json", "credentials.yaml", "credentials.yml", "secrets.json", "secrets.yaml", "secrets.yml", "auth.json", "id_rsa", "id_ed25519"]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareText).filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function normalizeCanonicalPath(input: string): string {
  let normalized = input.trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) throw new Error("PROJECT_BASELINE_INVALID_WORKSPACE");
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//u.test(normalized)) throw new Error("PROJECT_BASELINE_INVALID_WORKSPACE");
  if (/^\/+$/u.test(normalized)) return "/";
  if (/^[A-Za-z]:\/+$/u.test(normalized)) return `${normalized.slice(0, 2)}/`;
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function normalizeRelativePath(input: string): string | null {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function joinRelative(parent: string, name: string): string | null {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return null;
  return normalizeRelativePath(parent ? `${parent}/${name}` : name);
}

export function isProjectBaselineSensitivePath(input: string): boolean {
  const path = normalizeRelativePath(input);
  if (!path) return true;
  const segments = path.toLowerCase().split("/");
  const name = segments[segments.length - 1] || "";
  if (segments.some(segment => SENSITIVE_DIRECTORIES.has(segment))) return true;
  if (name === ".env" || (name.startsWith(".env.") && !/\.(?:example|sample|template)$/.test(name))) return true;
  if (SENSITIVE_NAMES.has(name) || /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name)) return true;
  return false;
}

export function isProjectBaselineIgnoredPath(input: string): boolean {
  const path = normalizeRelativePath(input);
  if (!path) return true;
  return path.toLowerCase().split("/").some(segment => IGNORED_SEGMENTS.has(segment));
}

function resolveLimits(input?: Partial<ProjectBaselineLimits>): ProjectBaselineLimits {
  const integer = (key: keyof ProjectBaselineLimits, minimum: number) => {
    const value = input?.[key] ?? DEFAULT_PROJECT_BASELINE_LIMITS[key];
    return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : DEFAULT_PROJECT_BASELINE_LIMITS[key];
  };
  return {
    maxAnchorBytes: integer("maxAnchorBytes", 1),
    maxTotalAnchorBytes: integer("maxTotalAnchorBytes", 1),
    maxAnchors: integer("maxAnchors", 1),
    maxTopologyEntries: integer("maxTopologyEntries", 1),
    maxDirectoryEntries: integer("maxDirectoryEntries", 1),
    maxTopologyDepth: integer("maxTopologyDepth", 0),
    maxScripts: integer("maxScripts", 0),
    maxPathLength: integer("maxPathLength", 32),
  };
}

async function safeList(io: ProjectBaselineIo, workspace: string, path: string): Promise<readonly ProjectBaselineDirectoryEntry[]> {
  try {
    const entries = await io.listDirectory({ workspace, path });
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

async function scanTopology(io: ProjectBaselineIo, workspace: string, limits: ProjectBaselineLimits, omissions: ProjectBaselineOmission[]) {
  const topology: ProjectBaselineTopologyEntry[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }];
  let truncated = false;
  while (queue.length && topology.length < limits.maxTopologyEntries) {
    const current = queue.shift()!;
    const rawEntries = [...await safeList(io, workspace, current.path)];
    const entries = rawEntries.sort((a, b) => compareText(String(a?.name || ""), String(b?.name || "")));
    if (entries.length > limits.maxDirectoryEntries) truncated = true;
    for (const entry of entries.slice(0, limits.maxDirectoryEntries)) {
      const child = joinRelative(current.path, String(entry?.name || ""));
      if (!child || child.length > limits.maxPathLength || !["file", "directory", "symlink"].includes(entry?.kind)) {
        omissions.push({ path: current.path || ".", reason: "unsafe_entry" });
        continue;
      }
      if (entry.kind === "symlink" || isProjectBaselineSensitivePath(child) || isProjectBaselineIgnoredPath(child)) continue;
      if (topology.length >= limits.maxTopologyEntries) { truncated = true; break; }
      topology.push({ path: child, kind: entry.kind });
      if (entry.kind === "directory" && current.depth < limits.maxTopologyDepth) queue.push({ path: child, depth: current.depth + 1 });
    }
  }
  if (queue.length) truncated = true;
  return { topology: topology.sort((a, b) => compareText(a.path, b.path) || compareText(a.kind, b.kind)), truncated };
}

async function discoverCandidates(io: ProjectBaselineIo, workspace: string, omissions: ProjectBaselineOmission[]): Promise<AnchorCandidate[]> {
  const candidates = [...STATIC_ANCHORS];
  const rootEntries = await safeList(io, workspace, "");
  for (const entry of rootEntries) {
    const path = joinRelative("", String(entry?.name || ""));
    if (!path || entry.kind !== "file") continue;
    if (/\.(?:sln|csproj|fsproj|vbproj)$/.test(path.toLowerCase())) candidates.push({ path, kind: "manifest" });
  }
  for (const directory of DYNAMIC_RULE_DIRECTORIES) {
    for (const entry of await safeList(io, workspace, directory)) {
      const path = joinRelative(directory, String(entry?.name || ""));
      if (!path || path.length > DEFAULT_PROJECT_BASELINE_LIMITS.maxPathLength) {
        omissions.push({ path: directory, reason: "unsafe_entry" });
        continue;
      }
      if (entry.kind === "file" && path.toLowerCase().endsWith(".md") && !isProjectBaselineSensitivePath(path)) candidates.push({ path, kind: "rule" });
    }
  }
  const unique = new Map<string, AnchorCandidate>();
  for (const candidate of candidates) if (!isProjectBaselineSensitivePath(candidate.path)) unique.set(candidate.path, candidate);
  return [...unique.values()].sort((a, b) => compareText(a.path, b.path));
}

async function loadAnchors(io: ProjectBaselineIo, workspace: string, limits: ProjectBaselineLimits, omissions: ProjectBaselineOmission[]) {
  const loaded: LoadedAnchor[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const candidate of await discoverCandidates(io, workspace, omissions)) {
    if (candidate.path.length > limits.maxPathLength) continue;
    if (loaded.length >= limits.maxAnchors) {
      omissions.push({ path: candidate.path, reason: "anchor_count_limit" });
      truncated = true;
      continue;
    }
    if (io.getFileByteSize) {
      let byteSize: number;
      try {
        byteSize = await io.getFileByteSize({ workspace, path: candidate.path });
      } catch {
        continue;
      }
      if (!Number.isSafeInteger(byteSize) || byteSize < 0) continue;
      if (byteSize > limits.maxAnchorBytes) {
        omissions.push({ path: candidate.path, reason: "anchor_too_large" });
        truncated = true;
        continue;
      }
      if (totalBytes + byteSize > limits.maxTotalAnchorBytes) {
        omissions.push({ path: candidate.path, reason: "total_anchor_bytes_limit" });
        truncated = true;
        continue;
      }
    }
    let content: string;
    try { content = await io.readFile({ workspace, path: candidate.path }); } catch { continue; }
    if (typeof content !== "string") continue;
    const byteSize = new TextEncoder().encode(content).byteLength;
    let reason: ProjectBaselineOmissionReason | null = null;
    if (byteSize > limits.maxAnchorBytes) reason = "anchor_too_large";
    else if (totalBytes + byteSize > limits.maxTotalAnchorBytes) reason = "total_anchor_bytes_limit";
    if (reason) {
      omissions.push({ path: candidate.path, reason });
      truncated = true;
      continue;
    }
    totalBytes += byteSize;
    loaded.push({ ...candidate, content, byteSize, contentHash: `sha256-${sha256Hex(content)}`, provenance: "workspace_file" });
  }
  return { loaded, truncated };
}

function provenance(anchor: LoadedAnchor, selector: string): ProjectBaselineProvenance {
  return { path: anchor.path, selector, contentHash: anchor.contentHash };
}

function safeScalar(value: unknown, max = 160): string | null {
  if (typeof value !== "string") return null;
  const compact = value.trim();
  return compact && compact.length <= max && !/[\u0000-\u001f\u007f]/.test(compact) ? compact : null;
}

function safeVersionConstraint(value: unknown): string | null {
  const compact = safeScalar(value, 80);
  return compact && /\d/u.test(compact) && /^[0-9xX.*+<>=~^|,&!() /_-]+$/u.test(compact) ? compact : null;
}

function dedupeFacts(facts: ProjectBaselineFact[]): ProjectBaselineFact[] {
  const sorted = facts.sort((a, b) => compareText(`${a.name}\0${a.version || ""}\0${a.constraint || ""}\0${a.provenance.path}`, `${b.name}\0${b.version || ""}\0${b.constraint || ""}\0${b.provenance.path}`));
  const unique = new Map<string, ProjectBaselineFact>();
  for (const fact of sorted) {
    const key = `${fact.name}\0${fact.version || ""}\0${fact.constraint || ""}`;
    if (!unique.has(key)) unique.set(key, fact);
  }
  return [...unique.values()];
}

const LOCK_MANAGERS: Readonly<Record<string, string>> = {
  "package-lock.json": "npm", "npm-shrinkwrap.json": "npm", "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lock": "bun", "bun.lockb": "bun", "poetry.lock": "poetry", "uv.lock": "uv", "Pipfile.lock": "pipenv", "Cargo.lock": "cargo", "go.sum": "go_modules", "composer.lock": "composer", "Gemfile.lock": "bundler", "pubspec.lock": "dart_pub", "Package.resolved": "swiftpm",
};

function buildFacts(loaded: LoadedAnchor[], topology: readonly ProjectBaselineTopologyEntry[], limits: ProjectBaselineLimits, diagnostics: ProjectBaselineDiagnostic[]) {
  const byPath = new Map(loaded.map(anchor => [anchor.path, anchor]));
  const languages: ProjectBaselineFact[] = [];
  const packageManagers: ProjectBaselineFact[] = [];
  const runtimes: ProjectBaselineFact[] = [];
  const scripts: ProjectBaselineScript[] = [];
  let scriptsTruncated = false;
  const add = (bucket: ProjectBaselineFact[], name: string, anchor: LoadedAnchor, selector: string, extra: Pick<ProjectBaselineFact, "version" | "constraint"> = {}) => bucket.push({ name, ...extra, provenance: provenance(anchor, selector) });
  for (const [path, manager] of Object.entries(LOCK_MANAGERS)) {
    const anchor = byPath.get(path);
    if (anchor) add(packageManagers, manager, anchor, "lockfile");
  }
  const manifestLanguages: Array<[string, string, string?]> = [["pyproject.toml", "Python"], ["Cargo.toml", "Rust", "cargo"], ["go.mod", "Go", "go_modules"], ["pom.xml", "Java", "maven"], ["build.gradle", "Java", "gradle"], ["build.gradle.kts", "Kotlin", "gradle"], ["composer.json", "PHP", "composer"], ["Gemfile", "Ruby", "bundler"], ["pubspec.yaml", "Dart", "dart_pub"], ["Package.swift", "Swift", "swiftpm"]];
  for (const [path, language, manager] of manifestLanguages) {
    const anchor = byPath.get(path);
    if (!anchor) continue;
    add(languages, language, anchor, "manifest");
    if (manager) add(packageManagers, manager, anchor, "manifest");
  }
  for (const anchor of loaded.filter(item => /\.(?:sln|csproj|fsproj|vbproj)$/i.test(item.path))) {
    add(languages, anchor.path.endsWith(".fsproj") ? "F#" : anchor.path.endsWith(".vbproj") ? "Visual Basic" : "C#", anchor, "manifest_extension");
    add(packageManagers, "dotnet", anchor, "manifest_extension");
  }
  const packageAnchor = byPath.get("package.json");
  let scriptManager: string | null = null;
  if (packageAnchor) {
    add(languages, "JavaScript", packageAnchor, "manifest");
    try {
      const parsed = JSON.parse(packageAnchor.content) as Record<string, unknown>;
      const managerSpec = safeScalar(parsed.packageManager);
      const managerMatch = managerSpec?.match(/^([A-Za-z0-9._-]+)@(.+)$/);
      if (managerMatch && ["npm", "pnpm", "yarn", "bun"].includes(managerMatch[1]!.toLowerCase()) && /^[0-9A-Za-z.+_-]{1,64}$/u.test(managerMatch[2]!)) {
        scriptManager = managerMatch[1]!.toLowerCase();
        add(packageManagers, scriptManager, packageAnchor, "$.packageManager", { version: managerMatch[2] });
      }
      const engines = parsed.engines && typeof parsed.engines === "object" && !Array.isArray(parsed.engines) ? parsed.engines as Record<string, unknown> : {};
      for (const [name, rawConstraint] of Object.entries(engines).sort(([a], [b]) => compareText(a, b))) {
        const constraint = safeVersionConstraint(rawConstraint);
        if (constraint && /^[A-Za-z0-9._-]+$/.test(name)) add(runtimes, name.toLowerCase(), packageAnchor, `$.engines.${name}`, { constraint });
      }
      const declaredScripts = parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts) ? parsed.scripts as Record<string, unknown> : {};
      const names = Object.entries(declaredScripts).filter(([name, body]) => typeof body === "string" && !!safeScalar(name, 128)).map(([name]) => name).sort(compareText);
      if (!scriptManager) scriptManager = ["pnpm", "yarn", "bun", "npm"].find(name => packageManagers.some(fact => fact.name === name)) || null;
      for (const name of names.slice(0, limits.maxScripts)) scripts.push({ name, invocation: scriptManager && /^[A-Za-z0-9:_-]+$/.test(name) ? `${scriptManager} run ${name}` : null, provenance: provenance(packageAnchor, `$.scripts.${name}`) });
      scriptsTruncated = names.length > limits.maxScripts;
    } catch {
      diagnostics.push({ code: "manifest_parse_failed", path: packageAnchor.path });
    }
  }
  const go = byPath.get("go.mod");
  const goConstraint = safeVersionConstraint(go?.content.match(/^go\s+([^\s]+)\s*$/m)?.[1]);
  if (go && goConstraint) add(runtimes, "go", go, "go directive", { constraint: goConstraint });
  const pyproject = byPath.get("pyproject.toml");
  const pythonConstraint = safeVersionConstraint(pyproject?.content.match(/^requires-python\s*=\s*["']([^"']+)["']/m)?.[1]);
  if (pyproject && pythonConstraint) add(runtimes, "python", pyproject, "requires-python", { constraint: pythonConstraint });
  const extensionLanguage: Readonly<Record<string, string>> = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", py: "Python", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin", php: "PHP", rb: "Ruby", dart: "Dart", swift: "Swift", cs: "C#", fs: "F#", vb: "Visual Basic", c: "C", h: "C", cc: "C++", cpp: "C++", hpp: "C++", vue: "Vue", svelte: "Svelte" };
  for (const entry of topology) {
    if (entry.kind !== "file") continue;
    const extension = entry.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
    const language = extensionLanguage[extension];
    if (language) languages.push({ name: language, provenance: { path: entry.path, selector: "file_extension", contentHash: `path-sha256-${sha256Hex(entry.path)}` } });
  }
  return { languages: dedupeFacts(languages), packageManagers: dedupeFacts(packageManagers), runtimes: dedupeFacts(runtimes), scripts, scriptsTruncated };
}

function uniqueSortedOmissions(input: ProjectBaselineOmission[]): ProjectBaselineOmission[] {
  const keyed = new Map(input.map(item => [`${item.path}\0${item.reason}`, item]));
  return [...keyed.values()].sort((a, b) => compareText(a.path, b.path) || compareText(a.reason, b.reason));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export async function buildProjectBaselineContext(input: { readonly workspace: string; readonly io: ProjectBaselineIo; readonly limits?: Partial<ProjectBaselineLimits> }): Promise<ProjectBaselineContext> {
  const canonicalPath = normalizeCanonicalPath(await input.io.canonicalizeWorkspace(input.workspace));
  const limits = resolveLimits(input.limits);
  const omissions: ProjectBaselineOmission[] = [];
  const diagnostics: ProjectBaselineDiagnostic[] = [];
  const scanned = await scanTopology(input.io, canonicalPath, limits, omissions);
  const anchorsResult = await loadAnchors(input.io, canonicalPath, limits, omissions);
  const factsResult = buildFacts(anchorsResult.loaded, scanned.topology, limits, diagnostics);
  const vcsCandidate = input.io.resolveVcsRoot ? await input.io.resolveVcsRoot(canonicalPath).catch(() => null) : null;
  const vcsRoot = vcsCandidate ? normalizeCanonicalPath(await input.io.canonicalizeWorkspace(vcsCandidate)) : null;
  const workspace = {
    canonicalPath,
    identity: `project-workspace-sha256-${sha256Hex(canonicalPath)}`,
    vcs: vcsRoot ? { kind: "git" as const, canonicalRoot: vcsRoot, identity: `project-vcs-root-sha256-${sha256Hex(vcsRoot)}` } : null,
  };
  const anchors = anchorsResult.loaded.map(({ content: _content, ...anchor }) => anchor);
  const facts: ProjectBaselineFacts = { languages: factsResult.languages, packageManagers: factsResult.packageManagers, runtimes: factsResult.runtimes, scripts: factsResult.scripts };
  const normalizedOmissions = uniqueSortedOmissions(omissions);
  const truncated = { anchors: anchorsResult.truncated, topology: scanned.truncated, scripts: factsResult.scriptsTruncated };
  const fingerprints = {
    anchors: `project-baseline-anchors-sha256-${sha256Hex(canonicalJson(anchors))}`,
    topology: `project-baseline-topology-sha256-${sha256Hex(canonicalJson(scanned.topology))}`,
    facts: `project-baseline-facts-sha256-${sha256Hex(canonicalJson(facts))}`,
    overall: "",
  };
  fingerprints.overall = `project-baseline-sha256-${sha256Hex(canonicalJson({ schemaVersion: PROJECT_BASELINE_SCHEMA_VERSION, parserVersion: PROJECT_BASELINE_PARSER_VERSION, workspace, limits, fingerprints: { anchors: fingerprints.anchors, topology: fingerprints.topology, facts: fingerprints.facts }, omissions: normalizedOmissions, diagnostics, truncated }))}`;
  return deepFreeze({ kind: "project_baseline_context", schemaVersion: PROJECT_BASELINE_SCHEMA_VERSION, parserVersion: PROJECT_BASELINE_PARSER_VERSION, workspace, limits, anchors, topology: scanned.topology, facts, omissions: normalizedOmissions, diagnostics: diagnostics.sort((a, b) => compareText(a.path, b.path)), truncated, fingerprints });
}

export function compareProjectBaselineContexts(previous: ProjectBaselineContext | null | undefined, current: ProjectBaselineContext): ProjectBaselineComparison {
  if (!previous) return { status: "stale", reasons: ["missing_previous"], previousFingerprint: null, currentFingerprint: current.fingerprints.overall };
  const reasons: ProjectBaselineStaleReason[] = [];
  if (previous.schemaVersion !== current.schemaVersion) reasons.push("schema_version");
  if (previous.parserVersion !== current.parserVersion) reasons.push("parser_version");
  if (previous.workspace.identity !== current.workspace.identity || previous.workspace.vcs?.identity !== current.workspace.vcs?.identity) reasons.push("workspace_identity");
  if (canonicalJson(previous.limits) !== canonicalJson(current.limits)) reasons.push("limits");
  if (previous.fingerprints.anchors !== current.fingerprints.anchors) reasons.push("anchors");
  if (previous.fingerprints.topology !== current.fingerprints.topology) reasons.push("topology");
  if (previous.fingerprints.facts !== current.fingerprints.facts) reasons.push("facts");
  if (!reasons.length && previous.fingerprints.overall !== current.fingerprints.overall) reasons.push("fingerprint");
  return { status: reasons.length ? "stale" : "fresh", reasons, previousFingerprint: previous.fingerprints.overall, currentFingerprint: current.fingerprints.overall };
}

export function isProjectBaselineFresh(previous: ProjectBaselineContext | null | undefined, current: ProjectBaselineContext): boolean {
  return compareProjectBaselineContexts(previous, current).status === "fresh";
}
