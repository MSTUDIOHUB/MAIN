import type { Skill } from "./appTypes";
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
}

interface ParsedSkillDocument {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

const DEFAULT_SKILL_CATALOG_CHARS = 8_000;
const MAX_SUPPORTING_FILES = 10;
const MAX_SKILL_BODY_CHARS = 256_000;
export const LOAD_SKILL_TOOL_NAME = "load_skill";

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

function stripYamlScalar(value: string): string {
  return value
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function parseSkillDocument(raw: string, fallbackName: string, fallbackDescription: string): ParsedSkillDocument {
  const value = String(raw || "");
  if (!/^---\r?\n/.test(value)) {
    return {
      name: fallbackName.trim(),
      description: fallbackDescription.trim(),
      body: value.trim(),
    };
  }
  const match = value.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    return {
      name: fallbackName.trim(),
      description: fallbackDescription.trim(),
      body: value.trim(),
    };
  }
  let name = "";
  let description = "";
  for (const line of String(match[1] || "").split(/\r?\n/)) {
    const keyMatch = line.match(/^\s*(name|description)\s*:\s*(.*)$/i);
    if (!keyMatch) continue;
    if (keyMatch[1].toLowerCase() === "name") {
      name = stripYamlScalar(keyMatch[2]);
    } else {
      description = stripYamlScalar(keyMatch[2]);
    }
  }
  return {
    name: name || fallbackName.trim(),
    description: description || fallbackDescription.trim(),
    // Keep the complete SKILL.md. Frontmatter is useful provenance and is how
    // Codex/OpenCode Skill authors expect the loaded resource to look.
    body: value.trim(),
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
  const content = String(value || "").trim();
  if (!content) {
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
      if (!isSafeProtocolPackagePath(skill.packagePath || "", skill.entryPoint || "SKILL.md")) {
        warnings.push(`Package Skill ${skill.name || skill.id} has an unsafe entry path and was omitted.`);
        continue;
      }
      const entryPath = getProtocolPackageEntryPath(skill);
      try {
        const content = await readFile(entryPath, workspace);
        const parsed = parseSkillDocument(content, skill.name || skill.id, skill.desc || "");
        const name = validEntryName(parsed.name, skill.name || skill.id);
        const admittedBody = admissibleSkillBody(parsed.body, name, warnings);
        if (!admittedBody) continue;
        const basePath = directoryName(entryPath);
        entries.push(freezeEntry({
          id: `package:${skill.id}`,
          name,
          description: validEntryDescription(parsed.description, name),
          source: "package",
          content: admittedBody,
          entryPath,
          basePath,
          version: stableContentVersion(admittedBody),
          allowImplicitInvocation: await allowImplicitFor(basePath, workspace),
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

export function renderSkillCatalogContext(
  snapshot: SkillCatalogSnapshot | null | undefined,
  maxChars = DEFAULT_SKILL_CATALOG_CHARS,
): string {
  if (!snapshot?.entries.length || maxChars <= 0) return "";
  const visible = modelVisibleEntries(snapshot);
  if (visible.length === 0) return "";
  const explicit = new Set(snapshot.explicitSkillIds);
  const header = [
    "[AVAILABLE SKILLS]",
    "Skills are workflow instructions, not extra permissions. Call load_skill with the exact id before following a model-discovered Skill; explicitly activated Skill bodies are already supplied separately. The tool returns its complete SKILL.md, base path, revision, and supporting file paths. Read supporting files only when needed and use ordinary authorized tools for all actions.",
  ];
  const lines = [...header];
  let omitted = 0;
  for (const entry of visible) {
    const line = [
      `- id=${JSON.stringify(entry.id)}`,
      `name=${JSON.stringify(entry.name)}`,
      `description=${JSON.stringify(entry.description)}`,
      `source=${entry.source}`,
      explicit.has(entry.id) ? "explicitly_requested=true" : "model_discoverable=true",
    ].join("; ");
    const candidate = [...lines, line].join("\n");
    if (candidate.length > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
  }
  if (omitted > 0) {
    const warning = `[${omitted} additional Skill entries omitted by the catalog context budget.]`;
    if ([...lines, warning].join("\n").length <= maxChars) lines.push(warning);
  }
  if (snapshot.explicitSkillIds.length > 0) {
    const directive = `Explicit activation already admitted for: ${snapshot.explicitSkillIds.join(", ")}. Follow the supplied activated content without calling load_skill again.`;
    if ([...lines, directive].join("\n").length <= maxChars) lines.push(directive);
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
        "Load one admitted Agent Skill before using it. Returns the complete immutable SKILL.md, base directory, revision, provenance, and up to 10 supporting file paths. It grants no additional permissions and never executes Skill content.",
      parameters: {
        type: "object",
        properties: {
          skill_id: {
            type: "string",
            enum: visible.map((entry) => entry.id),
            description: "Exact Skill id from [AVAILABLE SKILLS].",
          },
        },
        required: ["skill_id"],
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
  return snapshot.explicitSkillIds.map((id) => {
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
}
