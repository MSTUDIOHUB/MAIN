import type { Skill } from "./appTypes";
import {
  getMcpToolOrigin,
  getMcpToolRemoteName,
  getMcpToolServerUrl,
  type MCPServer,
  type MCPTool,
  type MCPToolOrigin,
} from "./mcpClient";
import {
  TOOL_DEFINITIONS,
  mcpToToolDefinition,
  normalizeToolDefinition,
  skillToToolDefinition,
  type ToolDefinition,
} from "./toolSchemas";

export type ToolCatalogSource = "built_in" | "skill" | "mcp";

export type ToolCatalogDiagnosticCode =
  | "reserved_name"
  | "duplicate_name"
  | "duplicate_registration"
  | "invalid_name"
  | "missing_skill_identity"
  | "missing_mcp_origin";

export interface ToolCatalogDiagnosticCandidate {
  source: ToolCatalogSource;
  canonicalName: string;
  exposedName: string;
  serverName?: string;
  serverUrl?: string;
  skillId?: string;
  packagePath?: string;
  entryPoint?: string;
  executionName: string;
}

export interface ToolCatalogDiagnostic {
  code: ToolCatalogDiagnosticCode;
  severity: "warning" | "error";
  requestedName: string;
  message: string;
  winner?: ToolCatalogDiagnosticCandidate;
  candidates: ToolCatalogDiagnosticCandidate[];
}

export interface ToolCatalogEntry extends ToolCatalogDiagnosticCandidate {
  definition: ToolDefinition;
  aliases: string[];
  mcpTool?: MCPTool;
}

export type ToolCatalogLookup =
  | { status: "resolved"; requestedName: string; entry: ToolCatalogEntry; via: "exposed" | "canonical" | "alias" }
  | { status: "ambiguous"; requestedName: string; candidates: ToolCatalogEntry[] }
  | { status: "unknown"; requestedName: string };

export interface ToolCatalog {
  entries: ToolCatalogEntry[];
  toolDefinitions: ToolDefinition[];
  mcpTools: MCPTool[];
  mcpToolServerMap: Record<string, string>;
  diagnostics: ToolCatalogDiagnostic[];
  lookup: (name: string) => ToolCatalogLookup;
}

export interface BuildToolCatalogInput {
  skills?: Skill[];
  mcpTools?: MCPTool[];
  mcpServers?: MCPServer[];
  mcpToolServerMap?: Record<string, string>;
  builtInDefinitions?: ToolDefinition[];
}

const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function slug(value: string, maxLength: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return (normalized || "tool").slice(0, maxLength);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "_mainMcpOrigin")
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isValidFunctionName(name: string): boolean {
  return FUNCTION_NAME_PATTERN.test(name);
}

function toCandidate(entry: ToolCatalogEntry): ToolCatalogDiagnosticCandidate {
  return {
    source: entry.source,
    canonicalName: entry.canonicalName,
    exposedName: entry.exposedName,
    executionName: entry.executionName,
    ...(entry.serverName ? { serverName: entry.serverName } : {}),
    ...(entry.serverUrl ? { serverUrl: entry.serverUrl } : {}),
    ...(entry.skillId ? { skillId: entry.skillId } : {}),
    ...(entry.packagePath ? { packagePath: entry.packagePath } : {}),
    ...(entry.entryPoint ? { entryPoint: entry.entryPoint } : {}),
  };
}

function buildSkillCanonicalName(name: string, identity: string): string {
  return `skill__${slug(name, 40)}__${stableHash(identity)}`;
}

function buildMcpCanonicalName(origin: MCPToolOrigin): string {
  const identity = `${origin.serverName}\u0000${origin.serverUrl}\u0000${origin.remoteName}`;
  return `mcp__${slug(origin.serverName, 14)}__${slug(origin.remoteName, 24)}__${stableHash(identity)}`;
}

function resolveMcpOrigin(
  tool: MCPTool,
  serversByUrl: Map<string, MCPServer>,
  fallbackMap: Record<string, string>,
): MCPToolOrigin | null {
  const attached = getMcpToolOrigin(tool);
  if (attached) return attached;
  const serverUrl = getMcpToolServerUrl(tool, fallbackMap);
  if (!serverUrl) return null;
  return {
    serverName: serversByUrl.get(serverUrl)?.name || "mcp",
    serverUrl,
    remoteName: getMcpToolRemoteName(tool),
  };
}

function sortEntries(entries: ToolCatalogEntry[]): ToolCatalogEntry[] {
  const mcpEntries = entries
    .filter((entry) => entry.source === "mcp")
    .sort((left, right) => compareText(left.canonicalName, right.canonicalName));
  // Keep the long-standing built-in declaration order. Provider behavior can
  // be sensitive to tool order even though discovery order must not be.
  const builtInEntries = entries.filter((entry) => entry.source === "built_in");
  const skillEntries = entries
    .filter((entry) => entry.source === "skill")
    .sort((left, right) => compareText(left.canonicalName, right.canonicalName));
  return [...mcpEntries, ...builtInEntries, ...skillEntries];
}

export function isBuiltInToolName(name: string, definitions: ToolDefinition[] = TOOL_DEFINITIONS): boolean {
  return definitions.some((definition) => definition.function.name === name);
}

export function buildToolCatalog(input: BuildToolCatalogInput = {}): ToolCatalog {
  const builtInDefinitions = input.builtInDefinitions ?? TOOL_DEFINITIONS;
  const skills = input.skills ?? [];
  const mcpTools = input.mcpTools ?? [];
  const fallbackMap = input.mcpToolServerMap ?? {};
  const serversByUrl = new Map((input.mcpServers ?? []).map((server) => [server.url, server]));
  const diagnostics: ToolCatalogDiagnostic[] = [];
  const entries: ToolCatalogEntry[] = [];
  const publicNames = new Set<string>();

  for (const definition of builtInDefinitions) {
    const name = definition.function.name;
    if (!name || publicNames.has(name)) continue;
    const entry: ToolCatalogEntry = {
      source: "built_in",
      canonicalName: name,
      exposedName: name,
      executionName: name,
      definition: normalizeToolDefinition(definition),
      aliases: [name],
    };
    entries.push(entry);
    publicNames.add(name);
  }

  const allSkillCandidates = skills
    .filter((skill) => skill.active && skill.type === "tool")
    .map((skill) => ({ skill, definition: skillToToolDefinition(skill) }))
    .filter((candidate): candidate is { skill: Skill; definition: ToolDefinition } => !!candidate.definition)
    .map((candidate) => {
      // Runtime identity must not drift when a Skill description or schema is
      // edited. Those fields only choose a deterministic winner when the same
      // package was registered more than once.
      const skillId = String(candidate.skill.id || "").trim();
      const packagePath = String(candidate.skill.packagePath || "").trim();
      const entryPoint = String(candidate.skill.entryPoint || "").trim();
      const identity = `${skillId}\u0000${packagePath}\u0000${entryPoint}`;
      return {
        ...candidate,
        skillId,
        packagePath,
        entryPoint,
        identity,
        fingerprint: stableJson({
          name: candidate.skill.name,
          description: candidate.skill.desc || "",
          definition: candidate.definition,
        }),
      };
    })
    .sort((left, right) => {
      const leftKey = `${left.identity}\u0000${left.fingerprint}`;
      const rightKey = `${right.identity}\u0000${right.fingerprint}`;
      return compareText(leftKey, rightKey);
    });
  const skillCandidates: typeof allSkillCandidates = [];
  for (let index = 0; index < allSkillCandidates.length;) {
    const retained = allSkillCandidates[index];
    let duplicateCount = 0;
    index += 1;
    while (
      index < allSkillCandidates.length &&
      allSkillCandidates[index].identity === retained.identity
    ) {
      duplicateCount += 1;
      index += 1;
    }
    if (!retained.skillId) {
      diagnostics.push({
        code: "missing_skill_identity",
        severity: "error",
        requestedName: retained.definition.function.name,
        message: `Skill "${retained.skill.name}" has no stable id and cannot be executed safely.`,
        candidates: [],
      });
      continue;
    }
    skillCandidates.push(retained);
    if (duplicateCount > 0) {
      diagnostics.push({
        code: "duplicate_registration",
        severity: "warning",
        requestedName: retained.definition.function.name,
        message: `Skill "${retained.skill.name}" exact identity was registered ${duplicateCount + 1} times; one deterministic definition was retained.`,
        candidates: [],
      });
    }
  }
  const skillsByBareName = new Map<string, typeof skillCandidates>();
  for (const candidate of skillCandidates) {
    const name = candidate.definition.function.name;
    skillsByBareName.set(name, [...(skillsByBareName.get(name) ?? []), candidate]);
  }
  // Canonical identities must never be shadowed by a bare Skill name. Seed
  // the reservation set with every requested bare name before assigning any
  // canonical name so the result is independent of registration order.
  const reservedSkillCanonicalNames = new Set([
    ...publicNames,
    ...skillCandidates.map((candidate) => candidate.definition.function.name),
  ]);
  for (const candidate of skillCandidates) {
    const bareName = candidate.definition.function.name;
    const baseCanonicalName = buildSkillCanonicalName(bareName, candidate.identity);
    let canonicalName = baseCanonicalName;
    let collisionIndex = 0;
    while (reservedSkillCanonicalNames.has(canonicalName)) {
      collisionIndex += 1;
      canonicalName = `${baseCanonicalName.slice(0, 54)}__${stableHash(`${candidate.identity}\u0000${collisionIndex}`)}`;
    }
    reservedSkillCanonicalNames.add(canonicalName);
    const sameNameCandidates = skillsByBareName.get(bareName) ?? [];
    const canUseBareName = !publicNames.has(bareName) && sameNameCandidates.length === 1;
    const exposedName = canUseBareName ? bareName : canonicalName;
    const entry: ToolCatalogEntry = {
      source: "skill",
      canonicalName,
      exposedName,
      executionName: bareName,
      skillId: candidate.skillId,
      ...(candidate.packagePath
        ? { packagePath: candidate.packagePath }
        : {}),
      ...(candidate.entryPoint
        ? { entryPoint: candidate.entryPoint }
        : {}),
      definition: normalizeToolDefinition({
        ...candidate.definition,
        function: { ...candidate.definition.function, name: exposedName },
      }),
      aliases: [...new Set([canonicalName, exposedName, bareName])],
    };
    entries.push(entry);
    publicNames.add(exposedName);
    if (!canUseBareName) {
      const winner = entries.find((existing) => existing.exposedName === bareName);
      diagnostics.push({
        code: winner ? "reserved_name" : "duplicate_name",
        severity: "warning",
        requestedName: bareName,
        message: winner
          ? `Tool name "${bareName}" is already owned by ${winner.source}; the skill is exposed as "${canonicalName}".`
          : `Multiple skills requested "${bareName}"; deterministic canonical names were assigned.`,
        ...(winner ? { winner: toCandidate(winner) } : {}),
        candidates: [toCandidate(entry)],
      });
    }
  }

  type McpCandidate = {
    tool: MCPTool;
    origin: MCPToolOrigin;
    identity: string;
    fingerprint: string;
    canonicalName: string;
  };
  const allMcpCandidates: McpCandidate[] = [];
  for (const tool of mcpTools) {
    const origin = resolveMcpOrigin(tool, serversByUrl, fallbackMap);
    if (!origin) {
      diagnostics.push({
        code: "missing_mcp_origin",
        severity: "error",
        requestedName: tool.name,
        message: `MCP tool "${tool.name}" has no server identity and cannot be executed safely.`,
        candidates: [],
      });
      continue;
    }
    const identity = `${origin.serverName}\u0000${origin.serverUrl}\u0000${origin.remoteName}`;
    allMcpCandidates.push({
      tool,
      origin,
      identity,
      fingerprint: stableJson(tool),
      canonicalName: buildMcpCanonicalName(origin),
    });
  }
  allMcpCandidates.sort((left, right) =>
    compareText(left.identity, right.identity) || compareText(left.fingerprint, right.fingerprint)
  );

  const uniqueMcpCandidates: McpCandidate[] = [];
  for (let index = 0; index < allMcpCandidates.length;) {
    const first = allMcpCandidates[index];
    const duplicates: McpCandidate[] = [];
    while (index < allMcpCandidates.length && allMcpCandidates[index].identity === first.identity) {
      duplicates.push(allMcpCandidates[index]);
      index += 1;
    }
    uniqueMcpCandidates.push(duplicates[0]);
    if (duplicates.length > 1) {
      diagnostics.push({
        code: "duplicate_registration",
        severity: "warning",
        requestedName: first.origin.remoteName,
        message: `MCP server "${first.origin.serverName}" registered "${first.origin.remoteName}" ${duplicates.length} times; one deterministic definition was retained.`,
        candidates: [],
      });
    }
  }

  // Some Skills expose a friendly bare name while retaining a hidden
  // canonical lookup key. Reserve both identities so an MCP tool cannot
  // shadow either one through exposed-name precedence.
  const reservedCanonicalNames = new Set(
    entries.flatMap((entry) => [entry.canonicalName, entry.exposedName]),
  );
  for (const candidate of uniqueMcpCandidates) {
    const baseName = candidate.canonicalName;
    let canonicalName = baseName;
    let collisionIndex = 0;
    while (reservedCanonicalNames.has(canonicalName)) {
      collisionIndex += 1;
      canonicalName = `${baseName.slice(0, 54)}__${stableHash(`${candidate.identity}\u0000${collisionIndex}`)}`;
    }
    candidate.canonicalName = canonicalName;
    reservedCanonicalNames.add(canonicalName);
  }

  const mcpByBareName = new Map<string, McpCandidate[]>();
  for (const candidate of uniqueMcpCandidates) {
    const bareName = candidate.origin.remoteName;
    mcpByBareName.set(bareName, [...(mcpByBareName.get(bareName) ?? []), candidate]);
  }

  for (const candidate of uniqueMcpCandidates) {
    const bareName = candidate.origin.remoteName;
    const sameNameCandidates = mcpByBareName.get(bareName) ?? [];
    const validBareName = isValidFunctionName(bareName);
    const existingOwner = entries.find((entry) => entry.exposedName === bareName);
    const conflictsWithCanonicalName =
      reservedCanonicalNames.has(bareName) && bareName !== candidate.canonicalName;
    const canUseBareName =
      validBareName &&
      !existingOwner &&
      !conflictsWithCanonicalName &&
      sameNameCandidates.length === 1;
    const exposedName = canUseBareName ? bareName : candidate.canonicalName;
    const definition = mcpToToolDefinition({
      ...candidate.tool,
      name: exposedName,
      _mainMcpOrigin: candidate.origin,
    });
    if (!definition) continue;
    const catalogTool: MCPTool = {
      ...candidate.tool,
      name: exposedName,
      _mainMcpOrigin: candidate.origin,
    };
    const entry: ToolCatalogEntry = {
      source: "mcp",
      canonicalName: candidate.canonicalName,
      exposedName,
      executionName: candidate.origin.remoteName,
      serverName: candidate.origin.serverName,
      serverUrl: candidate.origin.serverUrl,
      definition,
      aliases: [...new Set([candidate.canonicalName, exposedName, bareName])],
      mcpTool: catalogTool,
    };
    entries.push(entry);
    publicNames.add(exposedName);

    if (!validBareName) {
      diagnostics.push({
        code: "invalid_name",
        severity: "warning",
        requestedName: bareName,
        message: `MCP tool name "${bareName}" is not provider-portable; it is exposed as "${candidate.canonicalName}".`,
        candidates: [toCandidate(entry)],
      });
    } else if (existingOwner) {
      diagnostics.push({
        code: "reserved_name",
        severity: "warning",
        requestedName: bareName,
        message: `Tool name "${bareName}" is owned by ${existingOwner.source}; the MCP tool is exposed as "${candidate.canonicalName}".`,
        winner: toCandidate(existingOwner),
        candidates: [toCandidate(entry)],
      });
    }
  }

  for (const [bareName, candidates] of mcpByBareName) {
    if (candidates.length <= 1) continue;
    const candidateEntries = entries.filter((entry) =>
      entry.source === "mcp" && entry.executionName === bareName
    );
    diagnostics.push({
      code: "duplicate_name",
      severity: "warning",
      requestedName: bareName,
      message: `Multiple MCP servers registered "${bareName}"; each tool was assigned a stable canonical name.`,
      candidates: candidateEntries.map(toCandidate),
    });
  }

  const orderedEntries = sortEntries(entries);
  const exposedLookup = new Map(orderedEntries.map((entry) => [entry.exposedName, entry]));
  const canonicalLookup = new Map(orderedEntries.map((entry) => [entry.canonicalName, entry]));
  const aliasLookup = new Map<string, ToolCatalogEntry[]>();
  for (const entry of orderedEntries) {
    for (const alias of entry.aliases) {
      aliasLookup.set(alias, [...(aliasLookup.get(alias) ?? []), entry]);
    }
  }

  const lookup = (name: string): ToolCatalogLookup => {
    const requestedName = String(name || "").trim();
    const exposed = exposedLookup.get(requestedName);
    if (exposed) return { status: "resolved", requestedName, entry: exposed, via: "exposed" };
    const canonical = canonicalLookup.get(requestedName);
    if (canonical) return { status: "resolved", requestedName, entry: canonical, via: "canonical" };
    const aliases = aliasLookup.get(requestedName) ?? [];
    if (aliases.length === 1) {
      return { status: "resolved", requestedName, entry: aliases[0], via: "alias" };
    }
    if (aliases.length > 1) {
      return { status: "ambiguous", requestedName, candidates: aliases };
    }
    return { status: "unknown", requestedName };
  };

  const mcpToolServerMap: Record<string, string> = {};
  for (const entry of orderedEntries) {
    if (entry.source !== "mcp" || !entry.serverUrl) continue;
    mcpToolServerMap[entry.exposedName] = entry.serverUrl;
    mcpToolServerMap[entry.canonicalName] = entry.serverUrl;
  }

  return {
    entries: orderedEntries,
    toolDefinitions: orderedEntries.map((entry) => entry.definition),
    mcpTools: orderedEntries
      .filter((entry): entry is ToolCatalogEntry & { mcpTool: MCPTool } => entry.source === "mcp" && !!entry.mcpTool)
      .map((entry) => entry.mcpTool),
    mcpToolServerMap,
    diagnostics: diagnostics.sort((left, right) =>
      compareText(`${left.requestedName}\u0000${left.code}\u0000${left.message}`, `${right.requestedName}\u0000${right.code}\u0000${right.message}`)
    ),
    lookup,
  };
}
