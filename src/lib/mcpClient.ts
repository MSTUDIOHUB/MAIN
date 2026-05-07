// lib/mcpClient.ts
// MCP (Model Context Protocol) HTTP Client — Streamable HTTP transport.
// Implements tool discovery (tools/list) and tool execution (tools/call)
// per the MCP specification (2025-03-26).
//
// Architecture:
//   1. discoverMcpTools(server) → fetches available tools from an MCP server
//   2. executeMcpTool(serverUrl, name, args) → invokes a tool on the server
//   3. Module-level tool→server routing map for zero-signature-change integration
// ────────────────────────────────────────────────────────────────────

// ── Types ──────────────────────────────────────────────────────────

export interface MCPServer {
  name: string;
  type: "http";
  url: string;
  enabled?: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
}

// ── JSON-RPC 2.0 ───────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

let rpcIdCounter = 0;

// ── Module-level Tool→Server Routing Map ────────────────────────────
// Allows executeTool() and isReadOnlyTool() in other modules to check
// whether a tool belongs to an MCP server without threading the map
// through every function signature.

let toolServerMap: Record<string, string> = {};

/** Update the routing map (called by orchestrator after discovery). */
export function setMcpToolServerMap(map: Record<string, string>): void {
  toolServerMap = { ...map };
}

/** Read the current routing map. */
export function getMcpToolServerMap(): Record<string, string> {
  return toolServerMap;
}

/** Check if a tool name belongs to a discovered MCP server. */
export function isMcpTool(name: string): boolean {
  return name in toolServerMap;
}

/** Get the server URL that provides a given MCP tool. */
export function getMcpServerUrl(toolName: string): string | undefined {
  return toolServerMap[toolName];
}

// ── Tool Discovery ─────────────────────────────────────────────────

/**
 * Discover available tools from a single MCP server.
 * Sends a JSON-RPC `tools/list` request via HTTP POST.
 */
export async function discoverMcpTools(server: MCPServer): Promise<MCPTool[]> {
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: ++rpcIdCounter,
    method: "tools/list",
  };

  const response = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `MCP discovery failed for ${server.name}: HTTP ${response.status} ${response.statusText}`
    );
  }

  const json: JsonRpcResponse = await response.json();

  if (json.error) {
    throw new Error(`MCP error from ${server.name}: [${json.error.code}] ${json.error.message}`);
  }

  return json.result?.tools ?? [];
}

/**
 * Discover tools from all configured MCP servers concurrently.
 * Failed servers are silently skipped (logged as warnings).
 * Returns the merged tool list and a tool→server URL routing map.
 */
export async function discoverAllMcpTools(
  servers: MCPServer[],
): Promise<{ tools: MCPTool[]; toolServerMap: Record<string, string> }> {
  const allTools: MCPTool[] = [];
  const map: Record<string, string> = {};

  const httpServers = servers.filter((s) => s.type === "http" && s.enabled !== false);

  const results = await Promise.allSettled(
    httpServers.map(async (server) => {
      try {
        const tools = await discoverMcpTools(server);
        for (const tool of tools) {
          allTools.push(tool);
          map[tool.name] = server.url;
        }
      } catch (err) {
        console.warn(
          `[MCP] Failed to discover tools from ${server.name} (${server.url}):`,
          err instanceof Error ? err.message : err
        );
      }
    }),
  );

  // Log any unexpected rejections (shouldn't happen due to try/catch above)
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("[MCP] Unexpected rejection during discovery:", r.reason);
    }
  }

  return { tools: allTools, toolServerMap: map };
}

// ── Tool Execution ─────────────────────────────────────────────────

/**
 * Execute a tool call on an MCP server.
 * Sends a JSON-RPC `tools/call` request via HTTP POST.
 * Returns the result as a string (for compatibility with the existing
 * tool result pipeline that feeds back into the LLM context).
 */
export async function executeMcpTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: ++rpcIdCounter,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const response = await fetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `MCP execution failed for ${toolName}: HTTP ${response.status} ${response.statusText}`
    );
  }

  const json: JsonRpcResponse = await response.json();

  if (json.error) {
    throw new Error(
      `MCP tool error for ${toolName}: [${json.error.code}] ${json.error.message}`
    );
  }

  // MCP `tools/call` returns { content: [{ type: "text", text: "..." }, ...] }
  const content = json.result?.content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) =>
        typeof c === "string" ? c : c.text ?? JSON.stringify(c)
      )
      .join("\n");
  }

  // Fallback: serialize the entire result
  return JSON.stringify(json.result ?? {});
}
