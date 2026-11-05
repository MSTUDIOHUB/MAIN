import type {
  MCPServer,
  MCPTool,
} from "./mcpClient";

export interface WorkspaceMcpSnapshot {
  readonly workspace: string;
  readonly mcpServers: MCPServer[];
  readonly mcpDiscoveredTools: MCPTool[];
  readonly mcpToolServerMap: Record<string, string>;
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
  });
}
