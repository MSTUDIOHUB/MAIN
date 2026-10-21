import type { Skill } from "./appTypes";
import { isMap, parseDocument } from "yaml";
import {
  discoverPersonalAgentSkills,
  globSearch,
  readFile,
} from "./ipc";
import type { ToolDefinition } from "./toolSchemas";
import {
  getApplicableProtocolPackagesForWorkspace,
  getProtocolPackageEntryPath,
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
}

export interface SkillCatalogSnapshot {
  readonly entries: readonly SkillCatalogEntry[];
  readonly explicitSkillIds: readonly string[];
  readonly warnings: readonly string[];
  readonly loadedAt: number;
}

export interface LoadedSkillContent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly source: SkillCatalogSource;
  readonly entryPath: string | null;
  readonly basePath: string | null;
  readonly version: string;
  readonly supportingFiles: readonly string[];
  readonly hostGuidance: string;
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

function freezeEntry(entry: SkillCatalogEntry): SkillCatalogEntry {
  return Object.freeze({
    ...entry,
    supportingFiles: Object.freeze([...entry.supportingFiles]),
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
    "Skills are instructions, not permissions. Call load_skill with an exact skill_id before following discovered instructions; explicitly activated bodies are already supplied.",
    `${visible.length} visible Skills; descriptions below are summaries. If no summary matches, use load_skill({operation:"list"}) for the complete catalog; follow nextCursor with cursor. Optional query searches all names/descriptions.`,
  ];
  if (lines.join("\n").length > maxChars) {
    return `[AVAILABLE SKILLS]\n${visible.length} visible Skills. Use load_skill({operation:"list"}) to list all metadata; continue with nextCursor. No extra permissions.`.slice(0, maxChars);
  }
  // A compact name index retains broad discoverability before descriptions
  // spend the context allowance. Full metadata is always available by list.
  const names: string[] = [];
  for (const entry of visible) {
    const candidate = `Names: ${[...names, JSON.stringify(entry.name)].join(", ")}`;
    if ([...lines, candidate].join("\n").length > maxChars) break;
    names.push(JSON.stringify(entry.name));
  }
  if (names.length > 0) lines.push(`Names: ${names.join(", ")}`);
  for (const entry of visible) {
    const summary = entry.description.length > 160
      ? `${entry.description.slice(0, 159)}…`
      : entry.description;
    const line = [
      `- id=${JSON.stringify(entry.id)}`,
      `name=${JSON.stringify(entry.name)}`,
      `description=${JSON.stringify(summary)}`,
      `source=${entry.source}`,
      explicit.has(entry.id) ? "explicitly_requested=true" : "model_discoverable=true",
    ].join("; ");
    const candidate = [...lines, line].join("\n");
    if (candidate.length > maxChars) continue;
    lines.push(line);
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
  return modelVisibleEntries(snapshot).some((entry) => entry.id === skillId);
}

export function loadSkillContent(
  snapshot: SkillCatalogSnapshot | null | undefined,
  skillId: string,
): LoadedSkillContent {
  const id = String(skillId || "").trim();
  const entry = snapshot?.entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`SKILL_NOT_ADMITTED: ${id || "missing skill id"}`);
  }
  return Object.freeze({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    content: entry.content,
    source: entry.source,
    entryPath: entry.entryPath,
    basePath: entry.basePath,
    version: entry.version,
    supportingFiles: Object.freeze([...entry.supportingFiles]),
    hostGuidance: SKILL_HOST_GUIDANCE,
  });
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
        "Load an admitted Agent Skill by skill_id (default operation=load), returning its complete immutable SKILL.md and paths. Use operation=list with optional query to discover all visible metadata; pass nextCursor as cursor for later pages. Listing never returns bodies. No additional permissions; never executes Skill content.",
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
            enum: visible.map((entry) => entry.id),
            description: "Required for load: exact Skill id from the catalog summary or a list result.",
          },
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
): string {
  if (!snapshot?.explicitSkillIds.length) return "";
  const activated = snapshot.explicitSkillIds.map((id) => {
    const loaded = loadSkillContent(snapshot, id);
    return [
      `[EXPLICITLY ACTIVATED SKILL id=${JSON.stringify(loaded.id)} revision=${loaded.version}]`,
      `Name: ${loaded.name}`,
      loaded.entryPath ? `Entry: ${loaded.entryPath}` : "Entry: panel-managed SKILL.md",
      loaded.basePath ? `Base directory: ${loaded.basePath}` : "Base directory: none",
      loaded.supportingFiles.length > 0
        ? `Supporting files (read only when needed): ${loaded.supportingFiles.join(", ")}`
        : "",
      loaded.content,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
  return `[SKILL HOST GUIDANCE]\n${SKILL_HOST_GUIDANCE}\n\n${activated}`;
}
