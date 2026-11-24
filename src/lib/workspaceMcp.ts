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
import { RUNTIME_V2_EDITOR_READ_TOOL_NAMES, type RuntimeV2EditorReadToolName } from "./runtime-v2/workspaceReadPolicy";

export interface WorkspaceMcpSnapshot {
  readonly workspace: string;
  readonly mcpServers: MCPServer[];
  readonly mcpDiscoveredTools: MCPTool[];
  readonly mcpToolServerMap: Record<string, string>;
  readonly unityBindings?: Readonly<Record<string, UnityMcpWorkspaceBinding>>;
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
  unity_mcp_console: { remoteName: "read_console", action: "get", description: "Read current Console errors and warnings from this workspace's connected Editor." },
} as const satisfies Record<RuntimeV2EditorReadToolName, { remoteName: string; action: string; description: string }>;
export const UNITY_MCP_OBSERVATION_NAMES = RUNTIME_V2_EDITOR_READ_TOOL_NAMES;
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

export function boundUnityMcpObservation(
  snapshot: WorkspaceMcpSnapshot | null | undefined, workspace: string | undefined,
  entry: ToolCatalogEntry, args: Readonly<Record<string, unknown>>,
): { binding: UnityMcpWorkspaceBinding; kind: "console" | "scene" | "reflection" } | null {
  if (!workspace || snapshot?.workspace !== normalizeMcpWorkspace(workspace)) return null;
  if (entry.source === "built_in") {
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

export function unityMcpObservationTools(snapshot: WorkspaceMcpSnapshot | null | undefined): ToolDefinition[] {
  return Object.entries(EDITOR_OBSERVATIONS).flatMap(([name, observation]) =>
    editorObservationBinding(snapshot, name)
      ? [{ type: "function" as const, function: {
          name, description: observation.description, parameters: { type: "object", properties: {}, required: [] },
        } }]
      : []);
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
