import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const cache = new Map();
function loadTs(file) {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute);
  const module = { exports: {} };
  cache.set(absolute, module.exports);
  const local = createRequire(absolute);
  const output = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  new Function("exports", "module", "require", output)(module.exports, module, (name) => {
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(absolute), name);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) return loadTs(candidate);
      }
    }
    return local(name);
  });
  return module.exports;
}

const mcp = loadTs("src/lib/workspaceMcp.ts");
const server = (name, enabled = true) => ({ name, type: "http", url: `http://localhost/${name}/mcp`, enabled });
const tool = (name, source) => ({
  name, description: name, inputSchema: { type: "object", properties: { target: { type: "string" } } },
  _mainMcpOrigin: { serverName: source.name, serverUrl: source.url, remoteName: name },
});
const snapshot = (overrides = {}) => mcp.resolveWorkspaceMcpView({
  workspace: "/a", manualServers: [], manualTools: [], manualToolServerMap: {}, ...overrides,
});

test("Unity observations require the exact project and version and select it before calling the fixed read action", async () => {
  const client = loadTs("src/lib/mcpClient.ts");
  client.__clearMcpDiscoveryFailureCacheForTests();
  const configured = server("editor");
  const hash = createHash("sha1").update("/a/Assets").digest("hex").slice(0, 16);
  const instance = { id: `a@${hash}`, hash, unity_version: "2022.3.62t16" };
  const calls = [];
  client.__setMcpInvokeForTests(async (_command, payload) => {
    const request = JSON.parse(payload.body);
    calls.push(request);
    let result = {};
    if (request.method === "initialize") result = { serverInfo: { name: "mcp-for-unity-server" } };
    if (request.method === "tools/list") result = { tools: ["set_active_instance", "manage_scene", "read_console"].map(name => ({ name, inputSchema: {} })) };
    if (request.method === "resources/read") result = { contents: [{ text: JSON.stringify({ success: true, instances: [instance] }) }] };
    if (request.params?.name === "set_active_instance") result = { structuredContent: { success: true, data: { instance: instance.id } } };
    if (request.params?.name === "read_console") result = { content: [{ text: "fixture diagnostics" }] };
    return { status: 200, ok: true, body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) };
  });
  try {
    const found = await client.discoverAllMcpTools([configured]);
    const view = snapshot({ manualServers: [configured], manualTools: found.tools, manualToolServerMap: found.toolServerMap });
    assert.deepEqual((await mcp.bindWorkspaceUnityMcpView(view, "6000.0.1f1")).mcpDiscoveredTools, []);
    const bound = await mcp.bindWorkspaceUnityMcpView(view, instance.unity_version);
    assert.deepEqual(mcp.unityMcpObservationTools(bound).map(tool => tool.function.name), ["unity_mcp_scene", "unity_mcp_console"]);
    assert.ok(!bound.mcpDiscoveredTools.some(tool => tool.name === "set_active_instance"));
    await assert.rejects(mcp.executeUnityMcpObservation({ snapshot: bound, workspace: "/b", name: "unity_mcp_console", args: {} }), /SCOPE_MISMATCH/);
    await assert.rejects(mcp.executeUnityMcpObservation({ snapshot: bound, workspace: "/a", name: "unity_mcp_console", args: { action: "clear" } }), /SCOPE_MISMATCH/);
    const result = await mcp.executeUnityMcpObservation({ snapshot: bound, workspace: "/a", name: "unity_mcp_console", args: {} });
    assert.equal(result, "fixture diagnostics");
    assert.deepEqual(calls.filter(call => call.method === "tools/call").map(call => call.params), [
      { name: "set_active_instance", arguments: { instance: instance.id } },
      { name: "read_console", arguments: { action: "get", types: ["error", "warning"], count: 25, format: "json" } },
    ]);
  } finally {
    client.__setMcpInvokeForTests(null);
  }
});

test("workspace normalization preserves filesystem roots", () => {
  assert.equal(mcp.normalizeMcpWorkspace("/"), "/");
  assert.equal(mcp.normalizeMcpWorkspace("C:\\"), "C:/");
  assert.equal(mcp.normalizeMcpWorkspace("/repo/"), "/repo");
});

test("manual MCP snapshots exclude disabled and unregistered discovery results", () => {
  const enabled = server("enabled");
  delete enabled.enabled; // Existing manual configurations default to enabled.
  const disabled = server("disabled", false);
  const foreign = server("foreign");
  const view = snapshot({
    manualServers: [enabled, disabled],
    manualTools: [tool("ping", enabled), tool("disabled", disabled), tool("foreign", foreign), { name: "unknown" }],
  });
  assert.deepEqual(view.mcpServers, [enabled, disabled], "configured server state remains available to the existing permission owner");
  assert.deepEqual(view.mcpDiscoveredTools.map((entry) => entry.name), ["ping"]);
  assert.deepEqual(view.mcpToolServerMap, { ping: enabled.url });
});

test("attached MCP provenance takes precedence over a legacy server map", () => {
  const enabled = server("enabled");
  const disabled = server("disabled", false);
  const ping = tool("ping", enabled);
  const legacy = { name: "legacy", description: "Legacy", inputSchema: { type: "object" } };
  const view = snapshot({
    manualServers: [enabled, disabled], manualTools: [ping, legacy, tool("blocked", disabled)],
    manualToolServerMap: { ping: disabled.url, legacy: enabled.url, blocked: enabled.url, missing: enabled.url },
  });
  assert.deepEqual(view.mcpDiscoveredTools, [ping, legacy]);
  assert.deepEqual(view.mcpDiscoveredTools[0]._mainMcpOrigin, ping._mainMcpOrigin);
  assert.deepEqual(view.mcpToolServerMap, { ping: enabled.url, legacy: enabled.url },
    "a fallback map cannot revive disabled attached provenance or add an undiscovered tool");
});

test("duplicate remote tool names retain each configured server's exact provenance", () => {
  const first = server("first");
  const second = server("second");
  const tools = [tool("ping", first), tool("ping", second)];
  const view = snapshot({ manualServers: [first, second], manualTools: tools });
  assert.deepEqual(view.mcpDiscoveredTools, tools);
  assert.notEqual(view.mcpDiscoveredTools[0]._mainMcpOrigin.serverUrl, view.mcpDiscoveredTools[1]._mainMcpOrigin.serverUrl);
});

test("new Run MCP snapshots cannot mutate or acquire capabilities from another Run's inputs", () => {
  const configured = server("manual");
  const ping = tool("ping", configured);
  const input = { manualServers: [configured], manualTools: [ping], manualToolServerMap: { ping: configured.url } };
  const first = snapshot({ ...input, workspace: "/a/" });
  assert.equal(first.workspace, "/a");
  for (const value of [first, first.mcpServers, first.mcpDiscoveredTools, first.mcpToolServerMap]) assert.ok(Object.isFrozen(value));
  configured.enabled = false;
  ping.inputSchema.properties.target.type = "number";
  ping._mainMcpOrigin.remoteName = "changed";
  input.manualToolServerMap.ping = "http://unrelated/mcp";
  const second = snapshot({ ...input, workspace: "/b" });
  assert.equal(second.workspace, "/b");
  assert.deepEqual(second.mcpDiscoveredTools, []);
  assert.equal(first.mcpServers[0].enabled, true);
  assert.equal(first.mcpDiscoveredTools[0].inputSchema.properties.target.type, "string");
  assert.equal(first.mcpDiscoveredTools[0]._mainMcpOrigin.remoteName, "ping");
  assert.deepEqual(first.mcpToolServerMap, { ping: configured.url });
});

test("a manually configured HTTP server discovers and calls tools over a real HTTP connection", async () => {
  const client = loadTs("src/lib/mcpClient.ts");
  const methods = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    methods.push(rpc.method);
    response.setHeader("Content-Type", "application/json");
    response.setHeader("mcp-session-id", "fixture-session");
    if (rpc.method === "notifications/initialized") {
      response.statusCode = 202;
      response.end();
      return;
    }
    const result = rpc.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "manual-fixture", version: "1" } }
      : rpc.method === "tools/list"
        ? { tools: [{ name: "manual_ping", description: "Read a fixture value", inputSchema: { type: "object", properties: {} } }] }
        : { content: [{ type: "text", text: "manual-http-ok" }] };
    if (rpc.method !== "initialize") assert.equal(request.headers["mcp-session-id"], "fixture-session");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  client.__setMcpInvokeForTests(async (command, args) => {
    assert.equal(command, "proxy_request_detailed");
    const response = await fetch(args.url, { method: args.method, headers: args.headers, body: args.body || undefined });
    return { status: response.status, ok: response.ok, body: await response.text(), contentType: response.headers.get("content-type"), headers: Object.fromEntries(response.headers) };
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const configured = { name: "manual-fixture", type: "http", url, enabled: true };
    const discovery = await client.discoverAllMcpTools([configured]);
    assert.equal(discovery.serverStatuses[0].status, "connected");
    const view = snapshot({ manualServers: [configured], manualTools: discovery.tools, manualToolServerMap: discovery.toolServerMap });
    assert.equal(view.mcpDiscoveredTools[0].name, "manual_ping");
    assert.equal(view.mcpDiscoveredTools[0]._mainMcpOrigin.serverName, configured.name);
    assert.match(await client.executeMcpTool(url, "manual_ping", {}), /manual-http-ok/);
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  } finally {
    client.__setMcpInvokeForTests(null);
    await new Promise((resolve) => server.close(resolve));
  }
});
