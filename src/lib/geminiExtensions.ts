import type { Skill } from "./appTypes";

/** Import-time compatibility only. Runtime consumes ordinary package Skills
 * and ordinary MCP servers, never the upstream extension manifest. */
export interface GeminiExtensionArchive {
  manifest_json: string;
  manifest_path: string;
  files: string[];
  entry_points: string[];
  package_hash: string;
  local_path: string;
  workspace: string;
}

export interface GeminiExtensionMcpComponent {
  key: string;
  url?: string;
  status: "supported" | "blocked";
  supported: boolean;
  reasons: string[];
  enabled: boolean;
}

export interface GeminiExtensionPreview {
  name: string;
  version: string;
  description: string;
  workspaceScope: string;
  packagePath: string;
  packageHash: string;
  manifestPath: string;
  skillEntryPoints: string[];
  mcpServers: GeminiExtensionMcpComponent[];
  unsupportedFeatures: string[];
}

export interface GeminiExtensionInstallation extends GeminiExtensionPreview {
  id: string;
  sourcePath: string;
  installedAt: number;
  enabled: boolean;
}
export type GeminiExtensionInstall = GeminiExtensionInstallation;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function path(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.includes("\\") ||
    value.startsWith("/") || /^[a-z]:/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value.split("/").every((part) => part && part !== "." && part !== "..") ? value : null;
}

export function normalizeGeminiExtensionWorkspace(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized === "/" || /^[a-z]:\/$/i.test(normalized) ? normalized : normalized.replace(/\/+$/, "");
}

function packagePath(value: unknown): string | null {
  const normalized = path(value);
  return normalized?.startsWith(".protocols/") && normalized.split("/").length === 2 ? normalized : null;
}

function manifestRoot(manifestPath: string): string {
  return manifestPath.slice(0, -"gemini-extension.json".length);
}

export function isAnonymousGeminiHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || /\$|%[a-z_][a-z0-9_]*%|\{|\}|[\u0000-\u0020\u007f]/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname) && !parsed.username && !parsed.password && !parsed.hash && !parsed.search;
  } catch {
    return false;
  }
}

export function inspectGeminiExtensionArchive(archive: GeminiExtensionArchive): GeminiExtensionPreview {
  const localPath = packagePath(archive.local_path);
  const manifestPath = path(archive.manifest_path);
  const workspaceScope = normalizeGeminiExtensionWorkspace(archive.workspace);
  if (!localPath || !manifestPath || !workspaceScope ||
    !/^(?:[^/]+\/)?gemini-extension\.json$/.test(manifestPath) ||
    !/^sha256-[a-f0-9]{64}$/.test(archive.package_hash)) {
    throw new Error("GEMINI_EXTENSION_INVALID_ARCHIVE_METADATA");
  }
  if (typeof archive.manifest_json !== "string" || archive.manifest_json.length > 1024 * 1024) {
    throw new Error("GEMINI_EXTENSION_INVALID_MANIFEST");
  }
  let manifest: Record<string, unknown> | null;
  try { manifest = record(JSON.parse(archive.manifest_json)); } catch { manifest = null; }
  if (!manifest || typeof manifest.name !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(manifest.name) ||
    typeof manifest.version !== "string" || !manifest.version.trim() || manifest.version.length > 128) {
    throw new Error("GEMINI_EXTENSION_INVALID_MANIFEST");
  }
  const files = [...new Set(archive.files || [])];
  if (files.some((file) => !path(file)) || !files.includes(manifestPath)) {
    throw new Error("GEMINI_EXTENSION_INVALID_ARCHIVE_METADATA");
  }
  const root = manifestRoot(manifestPath);
  const skillEntryPoints = files.filter((file) =>
    file.startsWith(`${root}skills/`) && file.endsWith("/SKILL.md") &&
    file.slice(`${root}skills/`.length).split("/").length >= 2,
  ).sort();
  if ((archive.entry_points || []).some((entry) => !skillEntryPoints.includes(entry)) ||
    skillEntryPoints.some((entry) => !archive.entry_points.includes(entry))) {
    throw new Error("GEMINI_EXTENSION_INVALID_SKILL_ENTRIES");
  }
  const unsupportedFeatures: string[] = [];
  for (const folder of ["commands", "hooks", "agents", "policies"]) {
    if (files.some((file) => file.startsWith(`${root}${folder}/`))) unsupportedFeatures.push(folder);
  }
  for (const key of ["contextFileName", "excludeTools", "settings", "themes", "plan", "migratedTo"]) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) unsupportedFeatures.push(key);
  }
  if (files.includes(`${root}GEMINI.md`)) unsupportedFeatures.push("GEMINI.md");
  const globalMcpReasons = ["excludeTools", "settings", "policies"]
    .filter((feature) => unsupportedFeatures.includes(feature));
  const servers = manifest.mcpServers === undefined ? {} : record(manifest.mcpServers);
  if (!servers) throw new Error("GEMINI_EXTENSION_INVALID_MCP_CONFIG");
  const mcpServers = Object.entries(servers).map(([key, raw]): GeminiExtensionMcpComponent => {
    const config = record(raw);
    const reasons = [...globalMcpReasons];
    if (!key.trim() || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) reasons.push("invalid_server_name");
    if (!config) reasons.push("invalid_server_config");
    if (config) {
      if ("url" in config) reasons.push("sse_transport");
      if (["command", "args", "cwd", "env"].some((field) => field in config)) reasons.push("stdio_transport");
      if (!isAnonymousGeminiHttpUrl(config.httpUrl)) reasons.push("invalid_or_unresolved_http_url");
      for (const field of Object.keys(config)) {
        if (!["httpUrl", "description", "url", "command", "args", "cwd", "env"].includes(field)) reasons.push(field);
      }
    }
    const supported = reasons.length === 0;
    return {
      key,
      ...(supported ? { url: config!.httpUrl as string } : {}),
      status: supported ? "supported" : "blocked",
      supported,
      reasons: [...new Set(reasons)],
      enabled: supported,
    };
  });
  return {
    name: manifest.name,
    version: manifest.version.trim(),
    description: typeof manifest.description === "string" ? manifest.description.slice(0, 2000) : "",
    workspaceScope,
    packagePath: localPath,
    packageHash: archive.package_hash,
    manifestPath,
    skillEntryPoints,
    mcpServers,
    unsupportedFeatures: [...new Set(unsupportedFeatures)],
  };
}

export function createGeminiExtensionInstallation(
  preview: GeminiExtensionPreview,
  options: {
    id: string;
    sourcePath: string;
    now?: number;
    enabled?: boolean;
    skillEntryPoints?: string[];
    mcpKeys?: string[];
  },
): GeminiExtensionInstallation {
  return {
    ...preview,
    id: options.id,
    sourcePath: options.sourcePath,
    installedAt: options.now ?? Date.now(),
    enabled: options.enabled !== false,
    skillEntryPoints: preview.skillEntryPoints.filter((entry) => !options.skillEntryPoints || options.skillEntryPoints.includes(entry)),
    mcpServers: preview.mcpServers.map((server) => ({
      ...server,
      enabled: server.supported && server.status === "supported" &&
        (!options.mcpKeys || options.mcpKeys.includes(server.key)),
    })),
  };
}
export const createGeminiExtensionInstall = createGeminiExtensionInstallation;

export function extensionSkillProjection(installation: GeminiExtensionInstallation): Skill | null {
  if (!installation.skillEntryPoints.length) return null;
  return {
    id: `gemini:${installation.id}`,
    name: installation.name,
    desc: installation.description,
    content: "",
    active: installation.enabled,
    type: "package",
    packagePath: installation.packagePath,
    entryPoint: installation.skillEntryPoints[0],
    entryPoints: [...installation.skillEntryPoints],
    workspaceScope: installation.workspaceScope,
    allowImplicitInvocation: true,
  };
}

/** Persisted records are untrusted configuration, not extension authority. */
export function normalizeGeminiExtensionInstallations(value: unknown): GeminiExtensionInstallation[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((raw): GeminiExtensionInstallation[] => {
    const item = record(raw);
    if (!item || typeof item.id !== "string" || !/^[a-z0-9._:-]{1,200}$/i.test(item.id) || ids.has(item.id) ||
      typeof item.name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item.name) ||
      typeof item.version !== "string" || !item.version.trim() ||
      !packagePath(item.packagePath) || !normalizeGeminiExtensionWorkspace(item.workspaceScope) ||
      typeof item.manifestPath !== "string" || !/^(?:[^/]+\/)?gemini-extension\.json$/.test(item.manifestPath) || !path(item.manifestPath) ||
      typeof item.packageHash !== "string" || !/^sha256-[a-f0-9]{64}$/.test(item.packageHash) ||
      !Array.isArray(item.skillEntryPoints) || !Array.isArray(item.mcpServers)) return [];
    const root = manifestRoot(item.manifestPath);
    const entries = item.skillEntryPoints.filter((entry): entry is string =>
      typeof entry === "string" && Boolean(path(entry)) && entry.startsWith(`${root}skills/`) && entry.endsWith("/SKILL.md"),
    );
    if (entries.length !== item.skillEntryPoints.length) return [];
    const unsupportedFeatures = Array.isArray(item.unsupportedFeatures) ? item.unsupportedFeatures.filter((v): v is string => typeof v === "string") : [];
    const globalRestrictions = unsupportedFeatures.filter((feature) => ["settings", "policies", "excludeTools"].includes(feature));
    ids.add(item.id);
    return [{
      id: item.id,
      name: item.name,
      version: item.version,
      description: typeof item.description === "string" ? item.description : "",
      workspaceScope: normalizeGeminiExtensionWorkspace(item.workspaceScope),
      packagePath: item.packagePath as string,
      packageHash: item.packageHash,
      manifestPath: item.manifestPath,
      skillEntryPoints: [...new Set(entries)],
      sourcePath: typeof item.sourcePath === "string" ? item.sourcePath : "",
      installedAt: typeof item.installedAt === "number" && Number.isFinite(item.installedAt) ? item.installedAt : 0,
      enabled: item.enabled === true,
      unsupportedFeatures,
      mcpServers: item.mcpServers.flatMap((rawServer): GeminiExtensionMcpComponent[] => {
        const server = record(rawServer);
        if (!server || typeof server.key !== "string" || !server.key.trim()) return [];
        const reasons = [...globalRestrictions, ...(Array.isArray(server.reasons) ? server.reasons.filter((v): v is string => typeof v === "string") : ["invalid_server_config"])];
        const supported = server.supported === true && server.status === "supported" && reasons.length === 0 && isAnonymousGeminiHttpUrl(server.url);
        return [{ key: server.key, ...(supported ? { url: server.url as string } : {}), supported, status: supported ? "supported" : "blocked", reasons, enabled: supported && server.enabled === true }];
      }),
    }];
  });
}
