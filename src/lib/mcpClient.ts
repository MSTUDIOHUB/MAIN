// lib/mcpClient.ts
// MCP (Model Context Protocol) HTTP Client — Streamable HTTP transport.
// Implements tool discovery (tools/list) and tool execution (tools/call)
// with session initialization compatible with Unity MCP / OpenCode style flows.

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
  /**
   * MAIN-owned discovery identity. MCP servers never author this field.
   * Keeping the remote name and server identity on the discovered value lets
   * the ToolCatalog resolve duplicate bare names without relying on discovery
   * completion order.
   */
  _mainMcpOrigin?: MCPToolOrigin;
}

export interface MCPToolOrigin {
  serverName: string;
  serverUrl: string;
  remoteName: string;
}

export function getMcpToolOrigin(tool: MCPTool): MCPToolOrigin | undefined {
  const origin = tool._mainMcpOrigin;
  if (!origin?.serverUrl || !origin.remoteName) return undefined;
  return origin;
}

export function getMcpToolServerUrl(
  tool: MCPTool,
  fallbackMap?: Record<string, string>,
): string | undefined {
  return getMcpToolOrigin(tool)?.serverUrl || fallbackMap?.[tool.name];
}

export function getMcpToolRemoteName(tool: MCPTool): string {
  return getMcpToolOrigin(tool)?.remoteName || tool.name;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface ProxyDetailedResponse {
  status: number;
  ok: boolean;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
}

interface McpSessionState {
  sessionId?: string;
  initialized: boolean;
  protocolVersion: string;
}

type InvokeFn = <T = any>(command: string, args?: Record<string, unknown>) => Promise<T>;

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_SESSION_HEADER = "mcp-session-id";
const UNITY_EDIT_TOOL_NAMES = new Set(["apply_text_edits", "script_apply_edits"]);

export type MCPDiagnosticCategory =
  | "ok"
  | "unreachable"
  | "route_mismatch"
  | "header_mismatch"
  | "rpc_error"
  | "empty_tools"
  | "http_error"
  | "invalid_response";

export interface MCPDiagnostic {
  category: MCPDiagnosticCategory;
  message: string;
  status?: number;
  statusText?: string;
  responseSnippet?: string;
}

export interface MCPServerTestResult extends MCPDiagnostic {
  serverName: string;
  url: string;
  toolCount: number;
  ok: boolean;
}

export type MCPServerConnectionState = "connected" | "failed" | "disabled";

export interface MCPServerStatusSnapshot {
  serverName: string;
  url: string;
  enabled: boolean;
  status: MCPServerConnectionState;
  toolCount: number;
  category?: MCPDiagnosticCategory;
  message?: string;
  httpStatus?: number;
  cached?: boolean;
}

export interface DiscoverAllMcpToolsOptions {
  forceRefresh?: boolean;
  useFailureBackoff?: boolean;
  failureBackoffMs?: number;
  nowMs?: number;
  logFailures?: boolean;
}

class MCPRequestError extends Error {
  readonly category: Exclude<MCPDiagnosticCategory, "ok" | "empty_tools">;
  readonly url: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly responseSnippet?: string;
  readonly sessionId?: string;

  constructor(params: {
    category: Exclude<MCPDiagnosticCategory, "ok" | "empty_tools">;
    message: string;
    url: string;
    status?: number;
    statusText?: string;
    responseSnippet?: string;
    sessionId?: string;
  }) {
    super(params.message);
    this.name = "MCPRequestError";
    this.category = params.category;
    this.url = params.url;
    this.status = params.status;
    this.statusText = params.statusText;
    this.responseSnippet = params.responseSnippet;
    this.sessionId = params.sessionId;
  }
}

let rpcIdCounter = 0;
let invokePromise: Promise<InvokeFn | null> | null = null;
const mcpSessions = new Map<string, McpSessionState>();
const MCP_DISCOVERY_FAILURE_BACKOFF_MS = 60_000;
const MCP_DISCOVERY_FAILURE_BACKOFF_CATEGORIES = new Set<MCPDiagnosticCategory>([
  "unreachable",
  "invalid_response",
]);
const mcpDiscoveryFailureCache = new Map<string, { snapshot: MCPServerStatusSnapshot; expiresAt: number }>();

let toolServerMap: Record<string, string> = {};

export function setMcpToolServerMap(map: Record<string, string>): void {
  toolServerMap = { ...map };
}

export function getMcpToolServerMap(): Record<string, string> {
  return toolServerMap;
}

export function isMcpTool(name: string): boolean {
  return name in toolServerMap;
}

export function getMcpServerUrl(toolName: string): string | undefined {
  return toolServerMap[toolName];
}

export function __setMcpInvokeForTests(invoke: InvokeFn | null): void {
  invokePromise = Promise.resolve(invoke);
}

export function __clearMcpDiscoveryFailureCacheForTests(): void {
  mcpDiscoveryFailureCache.clear();
  mcpSessions.clear();
  rpcIdCounter = 0;
}

function getMcpDiscoveryFailureCacheKey(server: MCPServer): string {
  return `${server.name}\u0000${server.url}`;
}

function cloneMcpStatusSnapshot(snapshot: MCPServerStatusSnapshot, cached: boolean): MCPServerStatusSnapshot {
  return { ...snapshot, cached };
}

function getCachedMcpDiscoveryFailure(
  server: MCPServer,
  options: DiscoverAllMcpToolsOptions,
): MCPServerStatusSnapshot | null {
  if (options.forceRefresh === true || options.useFailureBackoff === false) return null;
  const key = getMcpDiscoveryFailureCacheKey(server);
  const entry = mcpDiscoveryFailureCache.get(key);
  const now = options.nowMs ?? Date.now();
  if (!entry || entry.expiresAt <= now) {
    if (entry) mcpDiscoveryFailureCache.delete(key);
    return null;
  }
  return cloneMcpStatusSnapshot(entry.snapshot, true);
}

function rememberMcpDiscoveryFailure(
  server: MCPServer,
  snapshot: MCPServerStatusSnapshot,
  options: DiscoverAllMcpToolsOptions,
): void {
  if (options.useFailureBackoff === false) return;
  const key = getMcpDiscoveryFailureCacheKey(server);
  if (!snapshot.category || !MCP_DISCOVERY_FAILURE_BACKOFF_CATEGORIES.has(snapshot.category)) {
    mcpDiscoveryFailureCache.delete(key);
    return;
  }
  const ttl = Math.max(0, options.failureBackoffMs ?? MCP_DISCOVERY_FAILURE_BACKOFF_MS);
  if (ttl <= 0) return;
  mcpDiscoveryFailureCache.set(key, {
    snapshot: cloneMcpStatusSnapshot(snapshot, false),
    expiresAt: (options.nowMs ?? Date.now()) + ttl,
  });
}

function getSession(url: string): McpSessionState {
  const existing = mcpSessions.get(url);
  if (existing) return existing;
  const created: McpSessionState = {
    initialized: false,
    protocolVersion: MCP_PROTOCOL_VERSION,
  };
  mcpSessions.set(url, created);
  return created;
}

function resetSession(url: string): void {
  mcpSessions.set(url, {
    initialized: false,
    protocolVersion: MCP_PROTOCOL_VERSION,
  });
}

function getResponseSnippet(text: string): string | undefined {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 260);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUnityEditEmptyResult(toolName: string, result: unknown): boolean {
  if (!UNITY_EDIT_TOOL_NAMES.has(toolName)) return false;
  if (isPlainObject(result) && Object.keys(result).length === 0) return true;
  if (!isPlainObject(result)) return false;
  const content = result.content;
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  const merged = content
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (isPlainObject(entry) && typeof entry.text === "string") return entry.text;
      return JSON.stringify(entry ?? "");
    })
    .join("")
    .trim();
  return merged.length === 0;
}

function extractSessionId(headers?: Record<string, string>): string | undefined {
  if (!headers) return undefined;
  return headers[MCP_SESSION_HEADER] || headers["Mcp-Session-Id"] || headers["MCP-Session-Id"];
}

function parseSseJsonRpc(body: string): JsonRpcResponse | null {
  const payloads: string[] = [];
  const dataLines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    if (!line.trim() && dataLines.length > 0) {
      payloads.push(dataLines.join("\n"));
      dataLines.length = 0;
    }
  }
  if (dataLines.length > 0) payloads.push(dataLines.join("\n"));

  for (const payload of payloads) {
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // ignore invalid chunk
    }
  }
  return null;
}

function parseJsonRpcBody(body: string, contentType?: string): JsonRpcResponse | null {
  const text = String(body || "").trim();
  if (!text) return null;
  const normalizedType = String(contentType || "").toLowerCase();

  if (normalizedType.includes("text/event-stream") || text.startsWith("event:") || text.includes("\ndata:")) {
    return parseSseJsonRpc(text);
  }

  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    return null;
  }
}

function categorizeHttpStatus(status: number): Exclude<MCPDiagnosticCategory, "ok" | "empty_tools"> {
  if (status === 404 || status === 405) return "route_mismatch";
  if (status === 406) return "header_mismatch";
  return "http_error";
}

function buildHttpErrorMessage(
  category: Exclude<MCPDiagnosticCategory, "ok" | "empty_tools">,
  status: number,
  responseSnippet?: string,
): string {
  if (category === "route_mismatch") {
    return `HTTP ${status}. MCP route mismatch; check whether the URL should include "/mcp".`;
  }
  if (category === "header_mismatch") {
    return `HTTP ${status}. MCP server requires Accept: ${MCP_ACCEPT_HEADER}.`;
  }
  if (status === 400 && /missing session id/i.test(String(responseSnippet || ""))) {
    return `HTTP ${status}. MCP session is required; the client needs to initialize and reuse mcp-session-id.`;
  }
  return `HTTP ${status}.`;
}

async function getInvoke(): Promise<InvokeFn | null> {
  if (!invokePromise) {
    invokePromise = import("@tauri-apps/api/core")
      .then((mod) => mod.invoke as InvokeFn)
      .catch(() => null);
  }
  return invokePromise;
}

async function requestViaRustProxy(
  url: string,
  method: "GET" | "POST" | "DELETE",
  headers: Record<string, string>,
  body?: string,
): Promise<ProxyDetailedResponse> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new MCPRequestError({
      category: "unreachable",
      message: "Rust HTTP proxy unavailable in current runtime.",
      url,
    });
  }

  try {
    return await invoke<ProxyDetailedResponse>("proxy_request_detailed", {
      url,
      method,
      headers,
      body: body ?? null,
    });
  } catch (err) {
    const reason = err instanceof Error && err.message ? err.message : String(err);
    throw new MCPRequestError({
      category: "unreachable",
      message: `Unable to reach MCP server (${url}). ${reason}`,
      url,
    });
  }
}

async function sendJsonRpcRequest(
  url: string,
  request: JsonRpcRequest,
  session: McpSessionState,
): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    Accept: MCP_ACCEPT_HEADER,
    "Content-Type": "application/json",
  };
  if (session.sessionId) headers[MCP_SESSION_HEADER] = session.sessionId;
  if (session.protocolVersion) headers["mcp-protocol-version"] = session.protocolVersion;

  const response = await requestViaRustProxy(url, "POST", headers, JSON.stringify(request));
  const sessionIdFromHeader = extractSessionId(response.headers);
  if (sessionIdFromHeader) session.sessionId = sessionIdFromHeader;

  const snippet = getResponseSnippet(response.body);
  const json = parseJsonRpcBody(response.body, response.contentType);

  if (!response.ok) {
    if (json?.error) {
      throw new MCPRequestError({
        category: "rpc_error",
        message: `MCP error [${json.error.code}] ${json.error.message}`,
        url,
        status: response.status,
        statusText: `HTTP ${response.status}`,
        responseSnippet: snippet,
        sessionId: sessionIdFromHeader,
      });
    }
    const category = categorizeHttpStatus(response.status);
    throw new MCPRequestError({
      category,
      message: buildHttpErrorMessage(category, response.status, snippet),
      url,
      status: response.status,
      statusText: `HTTP ${response.status}`,
      responseSnippet: snippet,
      sessionId: sessionIdFromHeader,
    });
  }

  if (!json || typeof json !== "object") {
    throw new MCPRequestError({
      category: "invalid_response",
      message: "MCP server returned a non-JSON response.",
      url,
      status: response.status,
      statusText: `HTTP ${response.status}`,
      responseSnippet: snippet,
      sessionId: sessionIdFromHeader,
    });
  }

  if (json.error) {
    throw new MCPRequestError({
      category: "rpc_error",
      message: `MCP error [${json.error.code}] ${json.error.message}`,
      url,
      status: response.status,
      statusText: `HTTP ${response.status}`,
      responseSnippet: snippet,
      sessionId: sessionIdFromHeader,
    });
  }

  return json;
}

function shouldRecoverSession(err: unknown): boolean {
  if (!(err instanceof MCPRequestError)) return false;
  if (err.category !== "rpc_error" && err.category !== "http_error") return false;
  const msg = (err.message || "").toLowerCase();
  return msg.includes("missing session") || msg.includes("unknown session") || msg.includes("invalid session");
}

async function ensureMcpInitialized(server: MCPServer, session: McpSessionState): Promise<void> {
  if (session.initialized) return;

  const initializeRequest: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: ++rpcIdCounter,
    method: "initialize",
    params: {
      protocolVersion: session.protocolVersion || MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "MAIN",
        version: "1.6.1",
      },
    },
  };

  const runInitialize = async () => sendJsonRpcRequest(server.url, initializeRequest, session);

  let initialized = false;
  try {
    const initJson = await runInitialize();
    const protocolVersion = String(initJson.result?.protocolVersion || "").trim();
    if (protocolVersion) session.protocolVersion = protocolVersion;
    initialized = true;
  } catch (err) {
    if (err instanceof MCPRequestError && err.sessionId && !session.sessionId) {
      session.sessionId = err.sessionId;
      const initJson = await runInitialize();
      const protocolVersion = String(initJson.result?.protocolVersion || "").trim();
      if (protocolVersion) session.protocolVersion = protocolVersion;
      initialized = true;
    } else {
      throw err;
    }
  }

  if (!initialized) return;
  session.initialized = true;

  // Best-effort notification for streamable MCP initialization lifecycle.
  try {
    await sendJsonRpcRequest(server.url, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, session);
  } catch {
    // Some servers ignore or reject this notification; discovery can still proceed.
  }
}

function toMcpDiagnostic(err: unknown): MCPDiagnostic {
  if (err instanceof MCPRequestError) {
    return {
      category: err.category,
      message: err.message,
      status: err.status,
      statusText: err.statusText,
      responseSnippet: err.responseSnippet,
    };
  }
  return {
    category: "invalid_response",
    message: err instanceof Error ? err.message : String(err),
  };
}

export async function discoverMcpTools(server: MCPServer): Promise<MCPTool[]> {
  const session = getSession(server.url);
  await ensureMcpInitialized(server, session);

  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: ++rpcIdCounter,
    method: "tools/list",
    params: {},
  };

  try {
    const json = await sendJsonRpcRequest(server.url, request, session);
    return json.result?.tools ?? [];
  } catch (err) {
    if (shouldRecoverSession(err)) {
      resetSession(server.url);
      const refreshed = getSession(server.url);
      await ensureMcpInitialized(server, refreshed);
      const retried = await sendJsonRpcRequest(server.url, request, refreshed);
      return retried.result?.tools ?? [];
    }
    throw err;
  }
}

export async function testMcpServer(server: MCPServer): Promise<MCPServerTestResult> {
  try {
    const tools = await discoverMcpTools(server);
    if (tools.length === 0) {
      return {
        serverName: server.name,
        url: server.url,
        ok: false,
        toolCount: 0,
        category: "empty_tools",
        message: "Connected to MCP server but no tools were returned.",
      };
    }
    return {
      serverName: server.name,
      url: server.url,
      ok: true,
      toolCount: tools.length,
      category: "ok",
      message: `Connected and discovered ${tools.length} tool(s).`,
    };
  } catch (err) {
    const diagnostic = toMcpDiagnostic(err);
    return {
      serverName: server.name,
      url: server.url,
      ok: false,
      toolCount: 0,
      ...diagnostic,
    };
  }
}

export async function discoverAllMcpTools(
  servers: MCPServer[],
  options: DiscoverAllMcpToolsOptions = {},
): Promise<{
  tools: MCPTool[];
  toolServerMap: Record<string, string>;
  serverStatuses: MCPServerStatusSnapshot[];
}> {
  const allTools: MCPTool[] = [];
  const map: Record<string, string> = {};
  const statusSnapshots: MCPServerStatusSnapshot[] = [];
  const httpServers = servers.filter((s) => s.type === "http");
  const statusOrder = new Map(httpServers.map((server, index) => [`${server.name}\u0000${server.url}`, index]));

  const results = await Promise.allSettled(
    httpServers.map(async (server) => {
      if (server.enabled === false) {
        mcpDiscoveryFailureCache.delete(getMcpDiscoveryFailureCacheKey(server));
        statusSnapshots.push({
          serverName: server.name,
          url: server.url,
          enabled: false,
          status: "disabled",
          toolCount: 0,
          category: "ok",
          message: "Server is disabled in settings.",
        });
        return;
      }
      const cachedFailure = getCachedMcpDiscoveryFailure(server, options);
      if (cachedFailure) {
        statusSnapshots.push(cachedFailure);
        return;
      }
      try {
        const tools = await discoverMcpTools(server);
        mcpDiscoveryFailureCache.delete(getMcpDiscoveryFailureCacheKey(server));
        for (const tool of tools) {
          allTools.push({
            ...tool,
            _mainMcpOrigin: {
              serverName: server.name,
              serverUrl: server.url,
              remoteName: tool.name,
            },
          });
          map[tool.name] = server.url;
        }
        statusSnapshots.push({
          serverName: server.name,
          url: server.url,
          enabled: true,
          status: "connected",
          toolCount: tools.length,
          category: tools.length > 0 ? "ok" : "empty_tools",
          message: tools.length > 0
            ? `Connected and discovered ${tools.length} tool(s).`
            : "Connected to MCP server but no tools were returned.",
        });
      } catch (err) {
        const diagnostic = toMcpDiagnostic(err);
        const failureSnapshot: MCPServerStatusSnapshot = {
          serverName: server.name,
          url: server.url,
          enabled: true,
          status: "failed",
          toolCount: 0,
          category: diagnostic.category,
          message: diagnostic.message,
          httpStatus: diagnostic.status,
        };
        statusSnapshots.push(failureSnapshot);
        rememberMcpDiscoveryFailure(server, failureSnapshot, options);
        if (options.logFailures !== false) {
          console.warn(`[MCP] Failed to discover tools from ${server.name} (${server.url}): ${diagnostic.message}`);
          console.warn("[MCP] Discovery diagnostics", {
            server: server.name,
            url: server.url,
            category: diagnostic.category,
            status: diagnostic.status,
            responseSnippet: diagnostic.responseSnippet,
          });
        }
      }
    }),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      const diagnostic = toMcpDiagnostic(r.reason);
      console.warn("[MCP] Unexpected rejection during discovery:", {
        category: diagnostic.category,
        message: diagnostic.message,
        status: diagnostic.status,
        responseSnippet: diagnostic.responseSnippet,
      });
    }
  }

  statusSnapshots.sort((a, b) => {
    const keyA = `${a.serverName}\u0000${a.url}`;
    const keyB = `${b.serverName}\u0000${b.url}`;
    return (statusOrder.get(keyA) ?? Number.MAX_SAFE_INTEGER) - (statusOrder.get(keyB) ?? Number.MAX_SAFE_INTEGER);
  });

  allTools.sort((left, right) => {
    const leftOrigin = getMcpToolOrigin(left);
    const rightOrigin = getMcpToolOrigin(right);
    const leftKey = `${leftOrigin?.serverName || ""}\u0000${leftOrigin?.serverUrl || ""}\u0000${leftOrigin?.remoteName || left.name}`;
    const rightKey = `${rightOrigin?.serverName || ""}\u0000${rightOrigin?.serverUrl || ""}\u0000${rightOrigin?.remoteName || right.name}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  // Preserve the legacy bare-name map for callers that have not adopted the
  // ToolCatalog yet, but make its fallback winner deterministic. The catalog
  // retains every registration and never uses this lossy map for conflicts.
  const deterministicToolServerMap: Record<string, string> = {};
  for (const tool of allTools) {
    const serverUrl = getMcpToolServerUrl(tool, map);
    if (serverUrl && !(tool.name in deterministicToolServerMap)) {
      deterministicToolServerMap[tool.name] = serverUrl;
    }
  }

  return { tools: allTools, toolServerMap: deterministicToolServerMap, serverStatuses: statusSnapshots };
}

export async function executeMcpTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const session = getSession(serverUrl);
  await ensureMcpInitialized({ name: "MCP", type: "http", url: serverUrl }, session);

  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: ++rpcIdCounter,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  let json: JsonRpcResponse;
  try {
    json = await sendJsonRpcRequest(serverUrl, request, session);
  } catch (err) {
    try {
      if (!shouldRecoverSession(err)) throw err;
      resetSession(serverUrl);
      const refreshed = getSession(serverUrl);
      await ensureMcpInitialized({ name: "MCP", type: "http", url: serverUrl }, refreshed);
      json = await sendJsonRpcRequest(serverUrl, request, refreshed);
    } catch (finalErr) {
      const diagnostic = toMcpDiagnostic(finalErr);
      const category = /session/i.test(diagnostic.message) ? "session" : diagnostic.category;
      throw new Error(`MCP_CALL_FAILURE[${category}] ${diagnostic.message}`);
    }
  }

  if (isUnityEditEmptyResult(toolName, json.result)) {
    throw new Error(
      toolName === "apply_text_edits"
        ? "MCP_CALL_FAILURE[empty_result] apply_text_edits returned an empty result ({}). Treat this as a failed edit and switch to script_apply_edits or re-run with strict coordinates + precondition SHA."
        : "MCP_CALL_FAILURE[empty_result] script_apply_edits returned an empty result ({}). Treat this as failed and retry with explicit edits/anchors or verify the target script/class/method names.",
    );
  }

  return formatMcpToolCallResult(toolName, json.result);
}

/** Normalize the MCP CallToolResult boundary before orchestration sees it. */
export function formatMcpToolCallResult(toolName: string, result: any): string {
  const content = result?.content;
  const formatted = Array.isArray(content)
    ? content
        .map((c: any) => (typeof c === "string" ? c : c.text ?? JSON.stringify(c)))
        .join("\n")
    : JSON.stringify(result ?? {});
  if (result?.isError === true) {
    const diagnostic = formatted.trim() || "MCP tool returned isError=true without diagnostic content.";
    throw new Error(`MCP_TOOL_ERROR[${toolName}] ${diagnostic}`);
  }
  if (Array.isArray(content)) {
    return formatted;
  }
  return formatted;
}
