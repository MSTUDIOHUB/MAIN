import type { Skill } from "./appTypes";
import { isMap, parseDocument } from "yaml";
import {
  discoverPersonalAgentSkills,
  globSearch,
  inspectGlobalSkillPackage,
  readFile,
  readGlobalSkillPackageFile,
} from "./ipc";
import type { ToolDefinition } from "./toolSchemas";
import {
  getApplicableProtocolPackagesForWorkspace,
  globalProtocolPackageId,
  getProtocolPackageEntryPath,
  isSafeGlobalSkillRelativePath,
  isSafeProtocolPackagePath,
} from "./protocolPackages";

export type SkillCatalogSource = "panel" | "personal" | "workspace" | "package";

export interface SkillCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: SkillCatalogSource;
  readonly content: string;
  readonly entryPath: string | null;
  readonly basePath: string | null;
  readonly version: string;
  readonly allowImplicitInvocation: boolean;
  readonly supportingFiles: readonly string[];
  readonly globalPackageId?: string;
  readonly globalResourceBase?: string;
  readonly globalResourcePaths?: readonly string[];
}

export interface SkillCatalogSnapshot {
  readonly entries: readonly SkillCatalogEntry[];
  readonly explicitSkillIds: readonly string[];
  readonly warnings: readonly string[];
  readonly loadedAt: number;
}

export interface LoadedSkillContent {
  readonly id: string;
  readonly ref: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly source: SkillCatalogSource;
  readonly entryPath: string | null;
  readonly basePath: string | null;
  readonly version: string;
  readonly supportingFiles: readonly string[];
  readonly hostGuidance: string;
  readonly disclosure: "full" | "overview" | "window";
  readonly complete: boolean;
  readonly partial: boolean;
  readonly totalLines: number;
  readonly totalChars: number;
  readonly returnedRange: SkillSourceRange;
  readonly requestedRangeComplete: boolean;
  readonly nextStartLine: number | null;
  readonly nextStartChar: number | null;
  readonly sections: readonly SkillDocumentSection[];
  readonly sectionCount: number;
  readonly nextSectionCursor: string | null;
  readonly resource?: string;
  readonly resourceReadSupported?: boolean;
}

/** Source-character offsets use JS UTF-16 indexing, zero-based/end-exclusive.
 * Line numbers are one-based and include every touched line, even a partial one. */
export interface SkillSourceRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly startChar: number;
  readonly endChar: number;
}

export interface SkillDocumentSection {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  readonly startLine: number;
  readonly endLine: number;
  /** An unusually long heading may have an explicitly marked exact prefix. */
  readonly titleTruncated?: boolean;
}

export interface SkillDisclosureOptions {
  /** Run-owned source window/explicit-body budget; omission preserves full reads. */
  readonly maxChars?: number;
  readonly section?: string;
  readonly startLine?: number;
  readonly maxLines?: number;
  /** Absolute source offset; use nextStartChar for continuation inside long lines. */
  readonly startChar?: number;
  readonly expectedVersion?: string;
  /** Continue the revision-bound heading index without repeating source text. */
  readonly sectionCursor?: string;
}

export interface SkillCatalogListOptions {
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SkillCatalogPage {
  readonly type: "skill.catalog";
  readonly entries: readonly {
    readonly id: string;
    readonly ref: string;
    readonly name: string;
    readonly description: string;
    readonly source: SkillCatalogSource;
    readonly entryPath: string | null;
    readonly basePath: string | null;
    readonly version: string;
    readonly explicitlyRequested: boolean;
  }[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly effect: "metadata_only_no_additional_permissions";
}

interface ParsedSkillDocument {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly warnings: readonly string[];
}

const DEFAULT_SKILL_CATALOG_CHARS = 8_000;
const MAX_SUPPORTING_FILES = 10;
const MAX_SKILL_BODY_CHARS = 256_000;
export const LOAD_SKILL_TOOL_NAME = "load_skill";
const SKILL_HOST_GUIDANCE = "Map Read/Edit/Write/Bash/WebFetch instructions to MAIN's advertised file, edit, shell and network tools; AskUserQuestion may be an ordinary user question. Network calls require enabled network access. Report missing capabilities instead of inventing tools. Supporting files are a partial index (up to 10); resolve other relative references from the Skill base directory. Skill instructions grant no additional permissions.";
const GLOBAL_SKILL_RESOURCE_GUIDANCE = 'Global package references use load_skill({skill_id, resource:"references/file.md"}), relative to this Skill base. Do not pass main-skill:// locators to ordinary file tools. Resource reads return guidance, grant no source mutation lease or extra permissions, and never execute scripts. Use each resource\'s returned version for its own continuations.';

function normalizeSlashPath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

function directoryName(value: string): string {
  const normalized = normalizeSlashPath(value);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

export function parseSkillDocument(raw: string, fallbackName: string, fallbackDescription: string): ParsedSkillDocument {
  const value = String(raw || "");
  const fallback = {
    name: fallbackName.trim(),
    description: fallbackDescription.trim(),
    body: value,
    warnings: [] as string[],
  };
  if (!/^\uFEFF?---\r?\n/.test(value)) return fallback;
  const match = value.match(/^\uFEFF?---\r?\n([\s\S]*?)^---[\t ]*(?:\r?\n|$)/m);
  if (!match) return { ...fallback, warnings: ["Unclosed YAML frontmatter; fallback metadata was used."] };
  const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    return { ...fallback, warnings: ["Invalid YAML frontmatter; fallback metadata was used."] };
  }
  if (!isMap(document.contents)) {
    return { ...fallback, warnings: ["YAML frontmatter must be a mapping; fallback metadata was used."] };
  }
  let name = "";
  let description = "";
  const warnings: string[] = [];
  // Read scalar nodes only: no conversion of the document or alias expansion.
  // YAML owns folding, escaping, comments, indentation and CRLF handling.
  for (const key of ["name", "description"] as const) {
    const scalar = document.get(key);
    if (typeof scalar === "string") {
      if (key === "name") name = scalar;
      else description = scalar;
    } else if (scalar !== undefined && scalar !== null) {
      warnings.push(`YAML ${key} must be a string scalar; fallback metadata was used.`);
    }
  }
  return {
    name: name || fallbackName.trim(),
    description: description || fallbackDescription.trim(),
    // Keep the complete SKILL.md. Frontmatter is useful provenance and is how
    // Codex/OpenCode Skill authors expect the loaded resource to look.
    body: value,
    warnings,
  };
}

function stableContentVersion(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Compact model references resolve only against this immutable admission.
 * Canonical ids remain the persistence/telemetry identity and stay accepted. */
export function skillReference(snapshot: SkillCatalogSnapshot, skillId: string): string {
  const hash = stableContentVersion(skillId);
  const collisions = [...new Set(snapshot.entries
    .filter((entry) => stableContentVersion(entry.id) === hash)
    .map((entry) => entry.id))].sort();
  return `s:${hash}${collisions.length > 1 ? `:${collisions.indexOf(skillId) + 1}` : ""}`;
}

export function resolveSkillId(
  snapshot: SkillCatalogSnapshot | null | undefined,
  reference: string,
): string | null {
  if (!snapshot) return null;
  const value = String(reference || "").trim();
  const exact = snapshot.entries.find((entry) => entry.id === value);
  if (exact) return exact.id;
  return snapshot.entries.find((entry) => skillReference(snapshot, entry.id) === value)?.id || null;
}

interface SkillSourceLine { readonly start: number; readonly end: number }

function sourceLines(content: string): SkillSourceLine[] {
  const lines: SkillSourceLine[] = [];
  const endings = /\r\n|\n|\r/g;
  let start = 0;
  for (let match = endings.exec(content); match; match = endings.exec(content)) {
    const end = match.index + match[0].length;
    lines.push({ start, end });
    start = end;
  }
  if (start < content.length) lines.push({ start, end: content.length });
  return lines;
}

function documentSections(content: string, lines: readonly SkillSourceLine[]): SkillDocumentSection[] {
  const headings: Array<Omit<SkillDocumentSection, "endLine">> = [];
  let fence: { marker: string; length: number } | null = null;
  let frontmatter = /^\uFEFF?---(?:\r?\n|\r)/.test(content);
  for (let index = 0; index < lines.length; index += 1) {
    const line = content.slice(lines[index]!.start, lines[index]!.end).replace(/[\r\n]+$/, "");
    if (frontmatter) {
      if (index > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      continue;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^ {0,3}(#{1,6})[\t ]+(.+?)\s*$/);
    if (!heading) continue;
    headings.push({
      id: `L${index + 1}`,
      title: heading[2]!.replace(/[\t ]+#+[\t ]*$/, ""),
      level: heading[1]!.length,
      startLine: index + 1,
    });
  }
  const sections = headings.map((heading) => ({ ...heading, endLine: lines.length }));
  const parents: number[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    while (parents.length && sections[parents[parents.length - 1]!]!.level >= sections[index]!.level) {
      sections[parents.pop()!]!.endLine = sections[index]!.startLine - 1;
    }
    parents.push(index);
  }
  return sections;
}

function positiveSourceInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`SKILL_RANGE_INVALID: ${label} must be a positive integer.`);
  return value;
}

function relativeSupportingPaths(entry: SkillCatalogEntry): string[] {
  const base = normalizeSlashPath(entry.basePath || "");
  return entry.supportingFiles.map((raw) => {
    const value = normalizeSlashPath(raw);
    return base && value.startsWith(`${base}/`) ? value.slice(base.length + 1) : value;
  });
}

function sectionIndexPage(
  sections: readonly SkillDocumentSection[],
  version: string,
  maxChars: number | undefined,
  cursor?: string,
): { sections: SkillDocumentSection[]; nextSectionCursor: string | null } {
  let start = 0;
  if (cursor) {
    const match = cursor.match(/^([a-f0-9]{8}):(\d+)$/);
    start = match ? Number(match[2]) : NaN;
    if (!match || match[1] !== version || !Number.isSafeInteger(start) || start >= sections.length) {
      throw new Error("SKILL_SECTION_CURSOR_INVALID: restart the index from this admitted revision.");
    }
  }
  const selected: SkillDocumentSection[] = [];
  const limit = maxChars ?? Infinity;
  for (const section of sections.slice(start)) {
    const candidate = [...selected, section];
    if (JSON.stringify(candidate).length <= limit) {
      selected.push(section);
      continue;
    }
    if (selected.length) break;
    // Even an adversarial single-line heading cannot grow the index without
    // bound. Its title is a labeled exact prefix; read the source line for all
    // characters. The small fixed locator envelope remains available.
    let titleEnd = Math.max(0, Math.min(section.title.length, limit));
    let bounded = { ...section, title: section.title.slice(0, titleEnd), titleTruncated: true };
    while (titleEnd > 0 && JSON.stringify([bounded]).length > limit) {
      titleEnd = Math.max(0, titleEnd - Math.max(1, JSON.stringify([bounded]).length - limit));
      bounded = { ...bounded, title: section.title.slice(0, titleEnd) };
    }
    selected.push(bounded);
    break;
  }
  const next = start + selected.length;
  return { sections: selected, nextSectionCursor: next < sections.length ? `${version}:${next}` : null };
}

function freezeEntry(entry: SkillCatalogEntry): SkillCatalogEntry {
  return Object.freeze({
    ...entry,
    supportingFiles: Object.freeze([...entry.supportingFiles]),
    ...(entry.globalResourcePaths ? { globalResourcePaths: Object.freeze([...entry.globalResourcePaths]) } : {}),
  });
}

function modelVisibleEntries(snapshot: SkillCatalogSnapshot): SkillCatalogEntry[] {
  const explicit = new Set(snapshot.explicitSkillIds);
  return snapshot.entries.filter((entry) =>
    entry.allowImplicitInvocation || explicit.has(entry.id)
  );
}

function explicitInvocationMatches(prompt: string, name: string): boolean {
  const cleanName = name.trim();
  if (!prompt || !cleanName) return false;
  const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)[$@]${escaped}(?=$|\\s|[.,;:!?，。；：！？])`, "iu")
    .test(prompt);
}

async function supportingFilesFor(basePath: string, entryPath: string, workspace: string): Promise<string[]> {
  if (!basePath || !workspace) return [];
  const candidates = await globSearch(`${basePath}/**/*`, workspace).catch(() => []);
  return [...new Set(candidates
    .map(normalizeSlashPath)
    .filter((candidate) => candidate && candidate !== normalizeSlashPath(entryPath)))]
    .sort()
    .slice(0, MAX_SUPPORTING_FILES);
}

async function allowImplicitFor(basePath: string, workspace: string): Promise<boolean> {
  if (!basePath || !workspace) return true;
  try {
    const config = await readFile(`${basePath}/agents/openai.yaml`, workspace);
    return allowImplicitFromConfig(config);
  } catch {
    return true;
  }
}

function allowImplicitFromConfig(config: string | null | undefined): boolean {
  return !/allow_implicit_invocation\s*:\s*false\b/i.test(String(config || ""));
}

function validEntryName(value: string, fallback: string): string {
  const name = String(value || "").trim();
  return (name || fallback.trim()).slice(0, 128);
}

function validEntryDescription(value: string, name: string): string {
  const description = String(value || "").trim();
  return (description || `Use the ${name} workflow when it is explicitly requested.`)
    .slice(0, 1_024);
}

function admissibleSkillBody(
  value: string,
  label: string,
  warnings: string[],
): string | null {
  const content = String(value || "");
  if (!content.trim()) {
    warnings.push(`Skill ${label} has no SKILL.md content and was omitted.`);
    return null;
  }
  if (content.length > MAX_SKILL_BODY_CHARS) {
    warnings.push(
      `Skill ${label} exceeds the ${MAX_SKILL_BODY_CHARS}-character safety limit and was omitted.`,
    );
    return null;
  }
  return content;
}

export async function loadSkillCatalog(input: {
  readonly workspace: string;
  readonly skills: readonly Skill[];
  readonly userPrompt?: string;
  readonly now?: () => number;
}): Promise<SkillCatalogSnapshot> {
  const workspace = String(input.workspace || "").trim();
  const entries: SkillCatalogEntry[] = [];
  const warnings: string[] = [];

  const globalPackages = new Set<string>();
  for (const skill of input.skills || []) {
    const packageId = globalProtocolPackageId(skill);
    if (!packageId || globalPackages.has(packageId)) continue;
    globalPackages.add(packageId);
    try {
      const meta = await inspectGlobalSkillPackage(packageId);
      if (meta.packageId !== packageId) throw new Error("GLOBAL_SKILL_ID_MISMATCH");
      const files = [...new Set(meta.files)];
      if (!files.every(isSafeGlobalSkillRelativePath)) throw new Error("GLOBAL_SKILL_RESOURCE_PATH_INVALID");
      const entryPoints = [...new Set(meta.entryPoints?.length ? meta.entryPoints : [meta.entryPoint])];
      for (const entryPoint of entryPoints) {
        if (!isSafeGlobalSkillRelativePath(entryPoint) || !files.includes(entryPoint)) {
          warnings.push(`Global package ${packageId} has an invalid entry path and it was omitted.`);
          continue;
        }
        const content = await readGlobalSkillPackageFile(packageId, entryPoint);
        const parsed = parseSkillDocument(content, skill.name || meta.name, skill.desc || "");
        warnings.push(...parsed.warnings.map((warning) => `Skill ${entryPoint}: ${warning}`));
        const name = validEntryName(parsed.name, skill.name || meta.name);
        const admittedBody = admissibleSkillBody(parsed.body, name, warnings);
        if (!admittedBody) continue;
        const base = entryPoint.includes("/") ? entryPoint.slice(0, entryPoint.lastIndexOf("/")) : "";
        const prefix = base ? `${base}/` : "";
        const configPath = `${prefix}agents/openai.yaml`;
        const config = files.includes(configPath) ? await readGlobalSkillPackageFile(packageId, configPath) : null;
        entries.push(freezeEntry({
          id: `global:${packageId}:${entryPoint}`, name,
          description: validEntryDescription(parsed.description, name), source: "package",
          content: admittedBody, entryPath: `main-skill://${packageId}/${entryPoint}`,
          basePath: `main-skill://${packageId}${base ? `/${base}` : ""}`,
          version: stableContentVersion(admittedBody),
          allowImplicitInvocation: skill.allowImplicitInvocation !== false && allowImplicitFromConfig(config),
          supportingFiles: files.filter((file) => file.startsWith(prefix) && file !== entryPoint && file !== configPath)
            .slice(0, MAX_SUPPORTING_FILES).map((file) => `main-skill://${packageId}/${file}`),
          globalPackageId: packageId, globalResourceBase: base, globalResourcePaths: files,
        }));
      }
    } catch (error) {
      warnings.push(`Global Skill package ${packageId} could not load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const skill of input.skills || []) {
    if (!skill?.active || skill.type === "package") continue;
    const name = validEntryName(skill.name, `skill-${skill.id}`);
    const description = validEntryDescription(skill.desc, name);
    const content = admissibleSkillBody(skill.content, name, warnings);
    if (!content) continue;
    entries.push(freezeEntry({
      id: `panel:${skill.id}`,
      name,
      description,
      source: "panel",
      content,
      entryPath: null,
      basePath: null,
      version: stableContentVersion(content),
      allowImplicitInvocation: skill.allowImplicitInvocation !== false,
      supportingFiles: [],
    }));
  }

  const personalDocuments = typeof discoverPersonalAgentSkills === "function"
    ? await discoverPersonalAgentSkills().catch(() => [])
    : [];
  for (const document of personalDocuments) {
    const entryPath = String(document.entryPath || "").trim();
    const basePath = String(document.basePath || "").trim();
    if (!entryPath || !basePath) continue;
    const fallbackName = normalizeSlashPath(basePath).split("/").pop() || "personal-skill";
    const parsed = parseSkillDocument(document.content, fallbackName, "");
    warnings.push(...parsed.warnings.map((warning) => `Skill ${entryPath}: ${warning}`));
    const name = validEntryName(parsed.name, fallbackName);
    const admittedBody = admissibleSkillBody(parsed.body, name, warnings);
    if (!admittedBody) continue;
    entries.push(freezeEntry({
      id: `personal:${stableContentVersion(entryPath)}`,
      name,
      description: validEntryDescription(parsed.description, name),
      source: "personal",
      content: admittedBody,
      entryPath,
      basePath,
      version: stableContentVersion(admittedBody),
      allowImplicitInvocation: allowImplicitFromConfig(document.openaiYaml),
      supportingFiles: [...new Set(
        (document.supportingFiles || []).map((value) => String(value || "").trim()).filter(Boolean),
      )].slice(0, MAX_SUPPORTING_FILES),
    }));
  }

  if (workspace) {
    const packages = getApplicableProtocolPackagesForWorkspace(
      [...(input.skills || [])],
      workspace,
    );
    for (const skill of packages) {
      const entryPoints = [...new Set(
        Array.isArray(skill.entryPoints) && skill.entryPoints.length
          ? skill.entryPoints
          : [skill.entryPoint || "SKILL.md"],
      )];
      for (const entryPoint of entryPoints) {
        if (typeof entryPoint !== "string" || !entryPoint.trim() ||
          !isSafeProtocolPackagePath(skill.packagePath || "", entryPoint)) {
          warnings.push(`Package Skill ${skill.name || skill.id} has an unsafe entry path ${entryPoint} and was omitted.`);
          continue;
        }
        const entryPath = getProtocolPackageEntryPath({ ...skill, entryPoint });
        try {
          const content = await readFile(entryPath, workspace);
          const parsed = parseSkillDocument(content, skill.name || skill.id, skill.desc || "");
          warnings.push(...parsed.warnings.map((warning) => `Skill ${entryPath}: ${warning}`));
          const name = validEntryName(parsed.name, skill.name || skill.id);
          const admittedBody = admissibleSkillBody(parsed.body, name, warnings);
          if (!admittedBody) continue;
          const basePath = directoryName(entryPath);
          entries.push(freezeEntry({
            id: entryPoints.length === 1 ? `package:${skill.id}` : `package:${skill.id}:${entryPoint}`,
            name,
            description: validEntryDescription(parsed.description, name),
            source: "package",
            content: admittedBody,
            entryPath,
            basePath,
            version: stableContentVersion(admittedBody),
            allowImplicitInvocation: skill.allowImplicitInvocation !== false && await allowImplicitFor(basePath, workspace),
            supportingFiles: await supportingFilesFor(basePath, entryPath, workspace),
          }));
        } catch (error) {
          warnings.push(
            `Package Skill ${skill.name || skill.id} could not load ${entryPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    const workspaceEntries = await globSearch(
      ".agents/skills/**/SKILL.md",
      workspace,
    ).catch(() => []);
    for (const rawEntryPath of [...new Set(workspaceEntries)].sort()) {
      const entryPath = normalizeSlashPath(rawEntryPath);
      if (!entryPath.startsWith(".agents/skills/") || entryPath.includes("/../")) {
        warnings.push(`Workspace Skill entry ${rawEntryPath} is outside .agents/skills and was omitted.`);
        continue;
      }
      try {
        const content = await readFile(entryPath, workspace);
        const basePath = directoryName(entryPath);
        const fallbackName = basePath.split("/").pop() || "workspace-skill";
        const parsed = parseSkillDocument(content, fallbackName, "");
        warnings.push(...parsed.warnings.map((warning) => `Skill ${entryPath}: ${warning}`));
        const name = validEntryName(parsed.name, fallbackName);
        const admittedBody = admissibleSkillBody(parsed.body, name, warnings);
        if (!admittedBody) continue;
        entries.push(freezeEntry({
          id: `workspace:${entryPath}`,
          name,
          description: validEntryDescription(parsed.description, name),
          source: "workspace",
          content: admittedBody,
          entryPath,
          basePath,
          version: stableContentVersion(admittedBody),
          allowImplicitInvocation: await allowImplicitFor(basePath, workspace),
          supportingFiles: await supportingFilesFor(basePath, entryPath, workspace),
        }));
      } catch (error) {
        warnings.push(
          `Workspace Skill ${entryPath} could not be loaded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const prompt = String(input.userPrompt || "");
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.name.toLocaleLowerCase();
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  const explicitSkillIds = entries
    .filter((entry) =>
      nameCounts.get(entry.name.toLocaleLowerCase()) === 1 &&
      explicitInvocationMatches(prompt, entry.name)
    )
    .map((entry) => entry.id);
  for (const [name, count] of nameCounts) {
    if (count > 1 && explicitInvocationMatches(prompt, name)) {
      warnings.push(`Explicit Skill name ${name} is ambiguous and was not activated.`);
    }
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    explicitSkillIds: Object.freeze(explicitSkillIds),
    warnings: Object.freeze(warnings),
    loadedAt: (input.now || Date.now)(),
  });
}

/** Every admitted visible entry remains discoverable even when the initial
 * context summary is small. Cursors belong to this immutable catalog/query. */
export function listSkillCatalog(
  snapshot: SkillCatalogSnapshot | null | undefined,
  options: SkillCatalogListOptions = {},
): SkillCatalogPage {
  const query = String(options.query || "").trim().toLocaleLowerCase();
  const visible = snapshot ? modelVisibleEntries(snapshot) : [];
  const explicit = new Set(snapshot?.explicitSkillIds || []);
  const matches = visible.filter((entry) => !query ||
    `${entry.name}\n${entry.description}`.toLocaleLowerCase().includes(query)
  );
  const revision = stableContentVersion(JSON.stringify([
    query,
    visible.map((entry) => [entry.id, entry.version, entry.name, entry.description, explicit.has(entry.id)]),
  ]));
  let offset = 0;
  if (options.cursor) {
    const cursor = String(options.cursor).match(/^([a-f0-9]{8}):(\d+)$/);
    offset = cursor ? Number(cursor[2]) : NaN;
    if (!cursor || cursor[1] !== revision || !Number.isSafeInteger(offset) || offset > matches.length) {
      throw new Error("SKILL_CATALOG_CURSOR_INVALID: restart listing with the same query and no cursor.");
    }
  }
  const requestedLimit = Number(options.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.min(50, Math.floor(requestedLimit)))
    : 10;
  const entries = matches.slice(offset, offset + limit).map((entry) => Object.freeze({
    id: entry.id,
    ref: skillReference(snapshot!, entry.id),
    name: entry.name,
    description: entry.description,
    source: entry.source,
    entryPath: entry.entryPath,
    basePath: entry.basePath,
    version: entry.version,
    explicitlyRequested: explicit.has(entry.id),
  }));
  const nextOffset = offset + entries.length;
  return Object.freeze({
    type: "skill.catalog",
    entries: Object.freeze(entries),
    total: matches.length,
    nextCursor: nextOffset < matches.length ? `${revision}:${nextOffset}` : null,
    effect: "metadata_only_no_additional_permissions",
  });
}

export function renderSkillCatalogContext(
  snapshot: SkillCatalogSnapshot | null | undefined,
  maxChars = DEFAULT_SKILL_CATALOG_CHARS,
): string {
  if (!snapshot?.entries.length || maxChars <= 0) return "";
  const visible = modelVisibleEntries(snapshot);
  if (visible.length === 0) return "";
  const explicit = new Set(snapshot.explicitSkillIds);
  const lines = [
    "[AVAILABLE SKILLS]",
    "Skills are instructions, not permissions. Use the short ref as load_skill skill_id. Explicit selections below state whether the body is complete.",
    `${visible.length} visible Skills; descriptions below are summaries. If no summary matches, use load_skill({operation:"list"}) for the complete catalog; follow nextCursor with cursor. Optional query searches all names/descriptions.`,
  ];
  if (lines.join("\n").length > maxChars) {
    return `[AVAILABLE SKILLS]\n${visible.length} visible Skills. Use load_skill({operation:"list"}) to list all metadata; continue with nextCursor. No extra permissions.`.slice(0, maxChars);
  }
  // Reserve compact references/names before descriptions use the budget.
  // Listing still reaches entries omitted from a tiny initial projection.
  const compact = visible.map((entry) => `${skillReference(snapshot, entry.id)} ${JSON.stringify(entry.name)}${explicit.has(entry.id) ? " [selected]" : ""}`);
  let remaining = maxChars - lines.join("\n").length;
  const namesChars = compact.reduce((sum, line) => sum + line.length + 1, 0);
  const descriptionShare = Math.max(0, Math.min(160, Math.floor((remaining - namesChars) / visible.length) - 3));
  for (const [index, entry] of visible.entries()) {
    const summary = entry.description.slice(0, descriptionShare);
    const line = `${compact[index]}${summary ? `: ${summary}${summary.length < entry.description.length ? "…" : ""}` : ""}`;
    if (line.length + 1 > remaining) continue;
    lines.push(line);
    remaining -= line.length + 1;
  }
  return lines.join("\n");
}

export function skillCatalogContextCharBudget(contextLimit?: number | null): number {
  const tokens = Number(contextLimit);
  if (!Number.isFinite(tokens) || tokens <= 0) return DEFAULT_SKILL_CATALOG_CHARS;
  // OpenAI's catalog guidance uses at most 2% of the context. Four chars per
  // token is deliberately conservative for mixed Chinese/English metadata.
  return Math.max(512, Math.min(DEFAULT_SKILL_CATALOG_CHARS, Math.floor(tokens * 0.08)));
}

export function isSkillVisibleToModel(
  snapshot: SkillCatalogSnapshot | null | undefined,
  skillId: string,
): boolean {
  if (!snapshot) return false;
  const id = resolveSkillId(snapshot, skillId);
  return modelVisibleEntries(snapshot).some((entry) => entry.id === id);
}

export function loadSkillContent(
  snapshot: SkillCatalogSnapshot | null | undefined,
  skillId: string,
  options: SkillDisclosureOptions = {},
): LoadedSkillContent {
  const id = resolveSkillId(snapshot, skillId);
  const entry = snapshot?.entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`SKILL_NOT_ADMITTED: ${skillId || "missing skill id"}`);
  }
  if (options.expectedVersion !== undefined && options.expectedVersion !== entry.version) {
    throw new Error(`SKILL_VERSION_MISMATCH: expected ${options.expectedVersion}; admitted ${entry.version}. Restart from this admitted revision.`);
  }
  const lines = sourceLines(entry.content);
  const allSections = documentSections(entry.content, lines);
  const maxChars = positiveSourceInteger(options.maxChars, "maxChars");
  const maxLines = positiveSourceInteger(options.maxLines, "maxLines");
  const requestedStartLine = positiveSourceInteger(options.startLine, "startLine");
  const section = options.section ? allSections.find((candidate) => candidate.id === options.section) : null;
  if (options.section && !section) throw new Error(`SKILL_SECTION_NOT_FOUND: ${options.section}`);
  const windowRequested = !!section || requestedStartLine !== undefined || options.startChar !== undefined || maxLines !== undefined;
  const indexOnly = options.sectionCursor !== undefined;
  if (indexOnly && windowRequested) throw new Error("SKILL_RANGE_INVALID: read either a section index page or a source window.");
  const overview = indexOnly || (!windowRequested && maxChars !== undefined && entry.content.length > maxChars);
  const indexBudget = maxChars === undefined ? undefined : indexOnly ? maxChars : Math.floor(maxChars / 3);
  const index = overview ? sectionIndexPage(allSections, entry.version, indexBudget, options.sectionCursor) : { sections: [], nextSectionCursor: null };
  const indexChars = index.sections.length ? JSON.stringify(index.sections).length : 0;
  const sourceBudget = maxChars === undefined ? undefined : Math.max(1, maxChars - indexChars);
  const startLine = requestedStartLine ?? section?.startLine ?? 1;
  if (startLine > Math.max(1, lines.length)) throw new Error(`SKILL_RANGE_INVALID: startLine exceeds ${lines.length} source lines.`);
  if (section && (startLine < section.startLine || startLine > section.endLine)) {
    throw new Error("SKILL_RANGE_INVALID: startLine is outside the requested section.");
  }
  const lineStart = lines[startLine - 1]?.start || 0;
  const startChar = options.startChar ?? lineStart;
  if (!Number.isSafeInteger(startChar) || startChar < lineStart ||
      (entry.content.length === 0 ? startChar !== 0 : startChar >= (lines[startLine - 1]?.end ?? 0))) {
    throw new Error("SKILL_RANGE_INVALID: startChar must be an absolute offset inside startLine; use the returned continuation.");
  }
  const firstBodySection = allSections.find((candidate) => candidate.level > 1) || allSections.find((candidate) => candidate.startLine > 1);
  let desiredEnd = overview && firstBodySection
    ? lines[firstBodySection.startLine - 1]!.start
    : lines[(section?.endLine ?? lines.length) - 1]?.end ?? 0;
  if (maxLines !== undefined) desiredEnd = Math.min(desiredEnd, lines[Math.min(lines.length, startLine + maxLines - 1) - 1]!.end);
  // Without a preface, provide an initial exact source window, never an empty
  // overview whose continuation cannot make progress.
  if (desiredEnd <= startChar) desiredEnd = section ? lines[section.endLine - 1]!.end : entry.content.length;
  const endChar = indexOnly ? startChar : Math.min(desiredEnd, startChar + (sourceBudget ?? entry.content.length));
  const touchedEnd = endChar === startChar ? 0 : lines.findIndex((line) => line.end >= endChar) + 1;
  const nextLine = endChar < entry.content.length ? lines.findIndex((line) => line.end > endChar) + 1 : null;
  const complete = startChar === 0 && endChar === entry.content.length;
  return Object.freeze({
    id: entry.id,
    ref: skillReference(snapshot!, entry.id),
    name: entry.name,
    description: entry.description,
    content: entry.content.slice(startChar, endChar),
    source: entry.source,
    entryPath: entry.entryPath,
    basePath: entry.basePath,
    version: entry.version,
    supportingFiles: Object.freeze(relativeSupportingPaths(entry)),
    hostGuidance: entry.globalPackageId ? `${SKILL_HOST_GUIDANCE} ${GLOBAL_SKILL_RESOURCE_GUIDANCE}` : SKILL_HOST_GUIDANCE,
    ...(entry.globalPackageId ? { resourceReadSupported: true } : {}),
    disclosure: complete ? "full" : overview ? "overview" : "window",
    complete,
    partial: !complete,
    totalLines: lines.length,
    totalChars: entry.content.length,
    returnedRange: Object.freeze({ startLine: lines.length === 0 ? 0 : startLine, endLine: touchedEnd, startChar, endChar }),
    requestedRangeComplete: !indexOnly && endChar === desiredEnd,
    nextStartLine: nextLine,
    nextStartChar: nextLine === null ? null : endChar,
    sections: Object.freeze(index.sections.map((heading) => Object.freeze(heading))),
    sectionCount: allSections.length,
    nextSectionCursor: index.nextSectionCursor,
  });
}

/** Package identity and manifest paths are captured at admission. The native
 * reader independently checks the managed content-addressed root and bytes. */
export async function loadSkillResourceContent(
  snapshot: SkillCatalogSnapshot | null | undefined,
  skillId: string,
  resource: string,
  options: SkillDisclosureOptions = {},
): Promise<LoadedSkillContent> {
  const id = resolveSkillId(snapshot, skillId);
  const entry = snapshot?.entries.find((candidate) => candidate.id === id);
  if (!entry || !isSkillVisibleToModel(snapshot, skillId)) throw new Error("SKILL_NOT_ADMITTED: resource Skill is not visible in this Turn.");
  const prefix = `global:${entry.globalPackageId}:`;
  const entryPoint = entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : "";
  const base = entryPoint.includes("/") ? entryPoint.slice(0, entryPoint.lastIndexOf("/")) : "";
  if (!entry.globalPackageId || !/^[a-f0-9]{64}$/.test(entry.globalPackageId) ||
      !isSafeGlobalSkillRelativePath(entryPoint) || entry.globalResourceBase !== base ||
      entry.entryPath !== `main-skill://${entry.globalPackageId}/${entryPoint}` ||
      !entry.globalResourcePaths?.includes(entryPoint)) {
    throw new Error("SKILL_RESOURCE_UNAVAILABLE: only admitted global package resources are supported.");
  }
  if (!isSafeGlobalSkillRelativePath(resource)) throw new Error("SKILL_RESOURCE_PATH_INVALID: use a relative path within the selected Skill base.");
  const path = entry.globalResourceBase ? `${entry.globalResourceBase}/${resource}` : resource;
  if (!entry.globalResourcePaths?.includes(path)) throw new Error("SKILL_RESOURCE_NOT_ADMITTED: path is absent from the captured package manifest.");
  const content = await readGlobalSkillPackageFile(entry.globalPackageId, path);
  const resourceEntry = freezeEntry({ ...entry, content, version: stableContentVersion(content), entryPath: `main-skill://${entry.globalPackageId}/${path}` });
  const loaded = loadSkillContent({ ...snapshot!, entries: [resourceEntry] }, entry.id, options);
  return Object.freeze({ ...loaded, ref: skillReference(snapshot!, entry.id), resource });
}

export function buildLoadSkillToolDefinition(
  snapshot: SkillCatalogSnapshot | null | undefined,
): ToolDefinition | null {
  if (!snapshot) return null;
  const visible = modelVisibleEntries(snapshot);
  if (visible.length === 0) return null;
  return {
    type: "function",
    function: {
      name: LOAD_SKILL_TOOL_NAME,
      description:
        "Read an admitted Skill (default operation=load). Small bodies are complete; long bodies first return an exact preface and section index, explicitly partial. Read relevant sections or line windows before following their instructions; continue with nextStartLine/nextStartChar and expected_version. For global package references, set resource to a path relative to the selected Skill base. operation=list discovers metadata only, with nextCursor pagination. No additional permissions; never executes Skill content.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["load", "list"],
            description: "Optional; defaults to load. list discovers metadata without a skill_id.",
          },
          skill_id: {
            type: "string",
            description: "Required for load: short ref from the catalog, or an exact canonical id from a list result. Unknown or hidden entries are rejected.",
          },
          resource: { type: "string", description: "Optional global package reference path relative to this Skill base, e.g. references/setup.md. Rejects absolute paths, traversal and unknown resources; omit for SKILL.md. Guidance only; never executes scripts or grants project/source/write permissions." },
          section: { type: "string", description: "Optional exact section id from the Skill index, such as L15. Returns original source, never a generated summary." },
          start_line: { type: "integer", description: "Optional one-based source line. Use nextStartLine for continuation; with section, it must stay within that section." },
          max_lines: { type: "integer", description: "Optional positive source line window. The Run source budget also bounds the returned content." },
          start_char: { type: "integer", description: "Optional absolute zero-based UTF-16 source offset inside start_line; use nextStartChar when continuing a partial line." },
          max_chars: { type: "integer", description: "Optional smaller source-character window, bounded by the current Run budget." },
          expected_version: { type: "string", description: "Pass the returned version on subsequent section/window reads; mismatched revisions are rejected." },
          section_cursor: { type: "string", description: "Continue a heading index with nextSectionCursor. Returns another index page without repeating source text; do not combine with section or source ranges." },
          query: { type: "string", description: "Optional list filter over all visible names and descriptions. Omit to list every entry." },
          cursor: { type: "string", description: "List continuation: exact nextCursor from the previous page with the same query." },
          limit: { type: "integer", description: "Optional list page size, from 1 to 50; default 10." },
        },
        required: [],
      },
    },
  };
}

/** Explicit invocation is deterministic (Codex `$skill` / OpenCode launcher
 * semantics). It uses the same immutable catalog revision as load_skill, but
 * is projected before the first provider step so the model cannot ignore a
 * user-selected Skill. */
export function renderExplicitSkillActivationContext(
  snapshot: SkillCatalogSnapshot | null | undefined,
  options: Pick<SkillDisclosureOptions, "maxChars"> = {},
): string {
  if (!snapshot?.explicitSkillIds.length) return "";
  let remaining = positiveSourceInteger(options.maxChars, "maxChars");
  const activated = snapshot.explicitSkillIds.map((id, index) => {
    const share = remaining === undefined ? undefined : Math.floor(remaining / (snapshot.explicitSkillIds.length - index));
    const source = loadSkillContent(snapshot, id, { maxChars: share === 0 ? 1 : share });
    const loaded = share === 0 ? {
      ...source, content: "", complete: false, partial: true,
      returnedRange: { startLine: 1, endLine: 0, startChar: 0, endChar: 0 },
      nextStartLine: 1, nextStartChar: 0,
      sections: [], nextSectionCursor: source.sectionCount ? `${source.version}:0` : null,
    } : source;
    if (remaining !== undefined) remaining = Math.max(0, remaining - loaded.content.length - (loaded.sections.length ? JSON.stringify(loaded.sections).length : 0));
    return [
      `[EXPLICITLY ACTIVATED SKILL ref=${loaded.ref} revision=${loaded.version} state=${loaded.complete ? "fully-loaded" : "selected-not-fully-loaded"}]`,
      `Name: ${loaded.name}`,
      loaded.entryPath ? `Entry: ${loaded.entryPath.split(/[\\/]/).pop()}` : "Entry: panel-managed SKILL.md",
      loaded.basePath ? `Base directory: ${loaded.basePath}` : "Base directory: none",
      loaded.supportingFiles.length > 0
        ? `Supporting files (partial index; relative to base, read only when needed): ${loaded.supportingFiles.join(", ")}`
        : "",
      !loaded.complete ? [
        `This Skill is selected, but its full instructions are not loaded. Total ${loaded.totalLines} lines / ${loaded.totalChars} UTF-16 characters. Read the relevant original sections with load_skill before applying them; this index is not a summary or proof of a full read.`,
        `Source preface/window: lines ${loaded.returnedRange.startLine}-${loaded.returnedRange.endLine}; chars [${loaded.returnedRange.startChar},${loaded.returnedRange.endChar}). Continue with skill_id=${loaded.ref}, start_line=${loaded.nextStartLine}, start_char=${loaded.nextStartChar}, expected_version=${loaded.version}.`,
        "Sections (id | lines | heading; nested ranges may overlap):",
        ...loaded.sections.map((section) => `${section.id} | ${section.startLine}-${section.endLine} | ${section.title}${section.titleTruncated ? " [heading prefix; read source for complete heading]" : ""}`),
        loaded.nextSectionCursor ? `More headings: load_skill skill_id=${loaded.ref}, section_cursor=${loaded.nextSectionCursor}, expected_version=${loaded.version}.` : "",
        "[EXACT SOURCE PREFACE/WINDOW]",
      ].join("\n") : "",
      loaded.content,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
  return `[SKILL HOST GUIDANCE]\n${SKILL_HOST_GUIDANCE}${snapshot?.entries.some((entry) => entry.globalPackageId) ? ` ${GLOBAL_SKILL_RESOURCE_GUIDANCE}` : ""}\n\n${activated}`;
}
