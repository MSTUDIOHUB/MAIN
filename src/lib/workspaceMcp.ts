import {
  bindUnityMcpWorkspace,
  executeMcpTool,
  getMcpToolOrigin,
  type UnityMcpWorkspaceBinding,
  type MCPServer,
  type MCPTool,
} from "./mcpClient";
import type { ToolCatalogEntry } from "./toolCatalog";
import type { ToolDefinition } from "./toolSchemas";
import { UNITY_CLI_CONSOLE_TOOL, UNITY_MCP_CONSOLE_TOOL, UNITY_OFFICIAL_MCP_CONSOLE_TOOL } from "./runtime-v2/workspaceReadPolicy";
import { discoverUnityOfficialMcp, UNITY_OFFICIAL_MCP_SERVER, type UnityOfficialMcpBinding } from "./unityOfficialMcp";
import { runUnityEditorOperation } from "./ipc";

interface UnityCliConsoleBinding {
  readonly instanceId: string;
  readonly editorPid: number;
  readonly editorVersion: string;
}

export interface WorkspaceMcpSnapshot {
  readonly workspace: string;
  readonly mcpServers: MCPServer[];
  readonly mcpDiscoveredTools: MCPTool[];
  readonly mcpToolServerMap: Record<string, string>;
  readonly unityBindings?: Readonly<Record<string, UnityMcpWorkspaceBinding>>;
  readonly unityCliConsole?: UnityCliConsoleBinding;
  readonly unityGameViewSupported?: true;
  readonly unityOfficialMcp?: UnityOfficialMcpBinding;
  readonly unityOfficialMcpOfferVersion?: string;
  readonly disabledToolKeys?: readonly string[];
  readonly planObservationsAllowed?: boolean;
}

export async function bindWorkspaceUnityMcpView(
  snapshot: WorkspaceMcpSnapshot,
  editorVersion: string | undefined,
): Promise<WorkspaceMcpSnapshot> {
  const servers = new Set(snapshot.mcpDiscoveredTools
    .map(getMcpToolOrigin)
    .filter(origin => origin?.connector === "unity")
    .map(origin => origin!.serverUrl));
  if (!servers.size) return snapshot;
  const matches = editorVersion ? await Promise.all([...servers].map(serverUrl =>
    bindUnityMcpWorkspace({ serverUrl, canonicalWorkspace: snapshot.workspace, editorVersion }).catch(() => null)
  )) : [];
  const unityBindings = Object.freeze(Object.fromEntries(matches
    .filter((binding): binding is UnityMcpWorkspaceBinding => !!binding)
    .map(binding => [binding.serverUrl, binding])));
  const tools = snapshot.mcpDiscoveredTools.filter(tool => {
    const origin = getMcpToolOrigin(tool);
    return origin?.connector !== "unity" ||
      (unityBindings[origin.serverUrl] && origin.remoteName !== "set_active_instance");
  });
  return Object.freeze({ ...snapshot, unityBindings, mcpDiscoveredTools: tools,
    mcpToolServerMap: Object.fromEntries(tools.map(tool => [tool.name, getMcpToolOrigin(tool)?.serverUrl || snapshot.mcpToolServerMap[tool.name]])) });
}

const EDITOR_OBSERVATIONS = {
  unity_mcp_scene: { remoteName: "manage_scene", action: "get_active", description: "Read the active scene of this workspace's connected Editor." },
  [UNITY_MCP_CONSOLE_TOOL]: { remoteName: "read_console", action: "get", description: "Read current Console errors and warnings from this workspace's connected Editor." },
} as const;
const UNITY_CLI_CONSOLE_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: UNITY_CLI_CONSOLE_TOOL,
    description: "Read current Unity Console errors and warnings, including compiler file and line diagnostics, from this workspace's connected Editor through Unity CLI.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};
const UNITY_OFFICIAL_MCP_CONSOLE_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: UNITY_OFFICIAL_MCP_CONSOLE_TOOL,
    description: "Read the current Unity Console errors and warnings through the official Unity MCP server for this workspace.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};
export const UNITY_MCP_CONSOLE_ARGS = Object.freeze({ action: "get", types: ["error", "warning"], count: 25, format: "json" });
export const UNITY_MCP_REPAIR_CONSOLE_ARGS = Object.freeze({ action: "get", types: ["error", "warning"], format: "json", page_size: 100, cursor: 0 });
const UNITY_CONSOLE_READ_ARGUMENTS = new Set(["action", "types", "count", "format", "page_size", "pageSize", "cursor",
  "filter_text", "filterText", "include_stacktrace", "includeStacktrace"]);
const UNITY_REFLECTION_READ_ARGUMENTS = new Set(["action", "class_name", "member_name", "query", "scope"]);

function editorObservationBinding(snapshot: WorkspaceMcpSnapshot | null | undefined, name: string) {
  const observation = EDITOR_OBSERVATIONS[name as keyof typeof EDITOR_OBSERVATIONS];
  if (!observation || !snapshot?.unityBindings) return null;
  for (const server of snapshot.mcpServers) {
    const binding = snapshot.unityBindings[server.url];
    if (binding && snapshot.mcpDiscoveredTools.some(tool => {
      const origin = getMcpToolOrigin(tool);
      if (origin?.serverUrl !== server.url || origin.remoteName !== observation.remoteName) return false;
      const keys = [name, observation.remoteName, `${server.name}:${observation.remoteName}`,
        `${server.name}/${observation.remoteName}`, `${server.url}:${observation.remoteName}`, `${server.url}#${observation.remoteName}`]
        .map(key => key.toLowerCase());
      return !snapshot.disabledToolKeys?.some(key => keys.includes(key.trim().toLowerCase()));
    })) return { binding, observation };
  }
  return null;
}

export async function bindWorkspaceUnityCliConsole(
  snapshot: WorkspaceMcpSnapshot,
  editorVersion: string | undefined,
  probe: (workspace: string, editorVersion: string) => Promise<unknown> = probeWorkspaceUnityCliConsole,
): Promise<WorkspaceMcpSnapshot> {
  if (!snapshot.workspace || !editorVersion || workspaceUnityOfficialConsoleBinding(snapshot) ||
      editorObservationBinding(snapshot, UNITY_MCP_CONSOLE_TOOL)) return snapshot;
  const result = await probe(snapshot.workspace, editorVersion).catch(() => null) as Partial<UnityCliConsoleBinding> | null;
  const pid = result?.editorPid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || result?.editorVersion !== editorVersion) return snapshot;
  return Object.freeze({ ...snapshot, unityCliConsole: Object.freeze({
    instanceId: `unity-cli:${pid}`, editorPid: pid, editorVersion,
  }) });
}

export function probeWorkspaceUnityCliConsole(workspace: string, editorVersion: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(6_000);
  return runUnityEditorOperation(UNITY_CLI_CONSOLE_TOOL, { workspace, editorVersion },
    signal ? AbortSignal.any([timeout, signal]) : timeout, Date.now() + 6_000);
}

export async function bindWorkspaceUnityOfficialMcp(
  snapshot: WorkspaceMcpSnapshot, editorVersion: string, signal: AbortSignal,
): Promise<WorkspaceMcpSnapshot> {
  const official = await discoverUnityOfficialMcp(snapshot.workspace, editorVersion, signal);
  const tools = [...snapshot.mcpDiscoveredTools, ...official.tools];
  const toolServerMap = { ...snapshot.mcpToolServerMap };
  for (const tool of official.tools) toolServerMap[tool.name] ??= official.server.url;
  return Object.freeze({
    ...snapshot, unityOfficialMcp: official.binding, unityOfficialMcpOfferVersion: undefined,
    mcpServers: Object.freeze([...snapshot.mcpServers, official.server]) as unknown as MCPServer[],
    mcpDiscoveredTools: Object.freeze(tools) as unknown as MCPTool[],
    mcpToolServerMap: Object.freeze(toolServerMap),
  });
}

export function withoutWorkspaceUnityOfficialMcp(snapshot: WorkspaceMcpSnapshot): WorkspaceMcpSnapshot {
  const { url } = UNITY_OFFICIAL_MCP_SERVER;
  return Object.freeze({
    ...snapshot,
    unityOfficialMcp: undefined,
    mcpServers: snapshot.mcpServers.filter(server => server.url !== url),
    mcpDiscoveredTools: snapshot.mcpDiscoveredTools.filter(tool => getMcpToolOrigin(tool)?.serverUrl !== url),
    mcpToolServerMap: Object.fromEntries(Object.entries(snapshot.mcpToolServerMap).filter(([, serverUrl]) => serverUrl !== url)),
  });
}

export function workspaceUnityOfficialConsoleBinding(snapshot: WorkspaceMcpSnapshot | null | undefined) {
  const binding = snapshot?.unityOfficialMcp;
  if (!snapshot || !binding) return null;
  const consoleOrigin = snapshot.mcpDiscoveredTools.map(getMcpToolOrigin)
    .find(origin => origin?.connector === "unity_official" && origin.remoteName === "console");
  if (!consoleOrigin) return null;
  const { serverName, serverUrl, remoteName } = consoleOrigin;
  const keys = [UNITY_OFFICIAL_MCP_CONSOLE_TOOL, remoteName, `${serverName}:${remoteName}`,
    `${serverName}/${remoteName}`, `${serverUrl}:${remoteName}`, `${serverUrl}#${remoteName}`].map(key => key.toLowerCase());
  return snapshot.disabledToolKeys?.some(key => keys.includes(key.trim().toLowerCase())) ? null : binding;
}

export function workspaceUnityCliConsoleBinding(
  snapshot: WorkspaceMcpSnapshot | null | undefined, workspace: string | undefined, args: Readonly<Record<string, unknown>>,
): UnityCliConsoleBinding | null {
  return workspace && snapshot?.workspace === normalizeMcpWorkspace(workspace) && !Object.keys(args).length
    ? snapshot.unityCliConsole ?? null : null;
}

export function boundWorkspaceEditorObservation(
  snapshot: WorkspaceMcpSnapshot | null | undefined, workspace: string | undefined,
  entry: ToolCatalogEntry, args: Readonly<Record<string, unknown>>,
): { binding: UnityMcpWorkspaceBinding | UnityCliConsoleBinding | UnityOfficialMcpBinding; kind: "console" | "scene" | "reflection" } | null {
  if (!workspace || snapshot?.workspace !== normalizeMcpWorkspace(workspace)) return null;
  if (entry.source === "built_in") {
    if (entry.executionName === UNITY_OFFICIAL_MCP_CONSOLE_TOOL) {
      const binding = workspaceUnityOfficialConsoleBinding(snapshot);
      return binding && !Object.keys(args).length ? { binding, kind: "console" } : null;
    }
    if (entry.executionName === UNITY_CLI_CONSOLE_TOOL) {
      const binding = workspaceUnityCliConsoleBinding(snapshot, workspace, args);
      return binding ? { binding, kind: "console" } : null;
    }
    const match = editorObservationBinding(snapshot, entry.executionName);
    return match && Object.keys(args).length === 0
      ? { binding: match.binding, kind: match.observation.remoteName === "read_console" ? "console" : "scene" } : null;
  }
  const origin = entry.mcpTool && getMcpToolOrigin(entry.mcpTool);
  const binding = origin?.connector === "unity" && snapshot.unityBindings?.[origin.serverUrl];
  if (!binding || !origin || origin.serverUrl !== entry.serverUrl) return null;
  const keys = Object.keys(args);
  if (origin.remoteName === "read_console" && args.action === "get" && keys.every(key => UNITY_CONSOLE_READ_ARGUMENTS.has(key))) return { binding, kind: "console" };
  if (origin.remoteName === "manage_scene" && args.action === "get_active" && keys.length === 1) return { binding, kind: "scene" };
  if (origin.remoteName === "unity_reflect" && ["get_type", "get_member", "search"].includes(String(args.action)) &&
      keys.every(key => UNITY_REFLECTION_READ_ARGUMENTS.has(key))) return { binding, kind: "reflection" };
  return null;
}

export function workspaceEditorObservationTools(snapshot: WorkspaceMcpSnapshot | null | undefined): ToolDefinition[] {
  const tools: ToolDefinition[] = Object.entries(EDITOR_OBSERVATIONS).flatMap(([name, observation]) =>
    editorObservationBinding(snapshot, name)
      ? [{ type: "function" as const, function: {
          name, description: observation.description, parameters: { type: "object", properties: {}, required: [] },
        } }]
      : []);
  if (snapshot?.unityCliConsole) tools.push(UNITY_CLI_CONSOLE_DEFINITION);
  if (workspaceUnityOfficialConsoleBinding(snapshot)) tools.unshift(UNITY_OFFICIAL_MCP_CONSOLE_DEFINITION);
  return tools;
}

export async function executeUnityMcpObservation(input: {
  snapshot: WorkspaceMcpSnapshot | null | undefined;
  workspace: string;
  name: string;
  args: Record<string, unknown>;
  repairScope?: true;
}): Promise<string> {
  const entry = editorObservationBinding(input.snapshot, input.name);
  if (!entry || input.snapshot?.workspace !== normalizeMcpWorkspace(input.workspace) || Object.keys(input.args).length) {
    throw new Error("MCP_UNITY_OBSERVATION_SCOPE_MISMATCH");
  }
  const { binding, observation } = entry;
  return executeMcpTool(binding.serverUrl, observation.remoteName,
    observation.remoteName === "read_console"
      ? input.repairScope ? UNITY_MCP_REPAIR_CONSOLE_ARGS : UNITY_MCP_CONSOLE_ARGS
      : { action: observation.action },
    binding);
}

export function normalizeMcpWorkspace(workspace: string): string {
  const normalized = String(workspace || "").trim().replace(/\\/g, "/");
  return normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)
    ? normalized
    : normalized.replace(/\/+$/, "");
}

/** Compose connector inputs for the Run's workspace, never the visible tab.
 * The result is a detached admission snapshot consumed by the existing tool
 * catalog and permission owner. */
export function resolveWorkspaceMcpView(input: {
  readonly workspace: string;
  readonly manualServers: readonly MCPServer[];
  readonly manualTools: readonly MCPTool[];
  readonly manualToolServerMap: Readonly<Record<string, string>>;
  readonly disabledToolKeys?: readonly string[];
  readonly planObservationsAllowed?: boolean;
}): WorkspaceMcpSnapshot {
  const workspace = normalizeMcpWorkspace(input.workspace);
  const servers = input.manualServers.map((server) => ({ ...server }));
  const enabledUrls = new Set(servers.filter((server) => server.enabled !== false).map((server) => server.url));
  const toolServerMap: Record<string, string> = {};
  const admittedTools = input.manualTools.filter((tool) => {
    const url = tool._mainMcpOrigin?.serverUrl || input.manualToolServerMap[tool.name];
    if (!url || !enabledUrls.has(url)) return false;
    toolServerMap[tool.name] = url;
    return true;
  }).map((tool) => JSON.parse(JSON.stringify(tool)) as MCPTool);
  return Object.freeze({
    workspace,
    mcpServers: Object.freeze(servers) as unknown as MCPServer[],
    mcpDiscoveredTools: Object.freeze(admittedTools) as unknown as MCPTool[],
    mcpToolServerMap: Object.freeze(toolServerMap),
    ...(input.disabledToolKeys?.length ? { disabledToolKeys: Object.freeze([...input.disabledToolKeys]) } : {}),
    ...(input.planObservationsAllowed ? { planObservationsAllowed: true } : {}),
  });
}
