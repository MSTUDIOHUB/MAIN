import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  __clearMcpDiscoveryFailureCacheForTests,
  __setMcpInvokeForTests,
  bindUnityMcpWorkspace,
  discoverAllMcpTools,
  executeMcpTool,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/mcpClient.ts"));

test("discoverAllMcpTools caches unreachable discovery failures and force refresh bypasses cache", async () => {
  __clearMcpDiscoveryFailureCacheForTests();

  let proxyCalls = 0;
  __setMcpInvokeForTests(async () => {
    proxyCalls += 1;
    throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
  });

  const servers = [
    { name: "unityMCP", type: "http", url: "http://localhost:8080/mcp", enabled: true },
  ];

  const first = await discoverAllMcpTools(servers, {
    nowMs: 1_000,
    failureBackoffMs: 60_000,
  });
  assert.equal(proxyCalls, 1);
  assert.equal(first.serverStatuses[0].status, "failed");
  assert.equal(first.serverStatuses[0].category, "unreachable");
  assert.notEqual(first.serverStatuses[0].cached, true);

  const second = await discoverAllMcpTools(servers, {
    nowMs: 2_000,
    failureBackoffMs: 60_000,
  });
  assert.equal(proxyCalls, 1);
  assert.equal(second.serverStatuses[0].status, "failed");
  assert.equal(second.serverStatuses[0].category, "unreachable");
  assert.equal(second.serverStatuses[0].cached, true);

  const forced = await discoverAllMcpTools(servers, {
    nowMs: 3_000,
    failureBackoffMs: 60_000,
    forceRefresh: true,
  });
  assert.equal(proxyCalls, 2);
  assert.equal(forced.serverStatuses[0].status, "failed");
  assert.equal(forced.serverStatuses[0].category, "unreachable");
  assert.notEqual(forced.serverStatuses[0].cached, true);

  __clearMcpDiscoveryFailureCacheForTests();
  __setMcpInvokeForTests(null);
});

test("MCP SSE notifications and mismatched ids cannot consume a Coplay response", async t => {
  __clearMcpDiscoveryFailureCacheForTests();
  t.after(() => {
    __clearMcpDiscoveryFailureCacheForTests();
    __setMcpInvokeForTests(null);
  });

  const workspace = "/tmp/isolated-unity";
  const editorVersion = "6000.6.5f1";
  const hash = createHash("sha1").update(`${workspace}/Assets`).digest("hex").slice(0, 16);
  const instanceId = `Fixture@${hash}`;
  const server = { name: "Fixture", type: "http", url: "http://127.0.0.1:18761/mcp" };
  const routes = [];

  __setMcpInvokeForTests(async (_command, args) => {
    const request = JSON.parse(args.body);
    routes.push(request.method);
    const ok = { status: 200, ok: true, headers: { "mcp-session-id": "fixture-session" } };
    if (request.method === "notifications/initialized") return { ...ok, status: 202, body: "" };
    if (request.method === "initialize") return { ...ok, contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: request.id,
        result: { serverInfo: { name: "mcp-for-unity-server" }, protocolVersion: "2025-03-26" } }) };

    const result = request.method === "tools/list" ? { tools: [{ name: "read_console", inputSchema: {} }] }
      : request.method === "resources/read" ? { contents: [{ text: JSON.stringify({ success: true,
          instances: [{ hash, id: instanceId, unity_version: editorVersion }] }) }] }
      : request.params.name === "set_active_instance" ? { structuredContent: { success: true, data: { instance: instanceId } } }
      : { content: [{ type: "text", text: "Retrieved 1 log entries." }],
          structuredContent: { success: true, data: "fixture-console" } };
    const events = [
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } },
      { jsonrpc: "2.0", id: request.id + 1, result: { unrelated: true } },
      { jsonrpc: "2.0", id: request.id, result },
    ];
    return { ...ok, contentType: "text/event-stream", body: events
      .map(event => `event: message\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("") };
  });

  assert.equal((await discoverAllMcpTools([server])).tools[0].name, "read_console");
  const binding = await bindUnityMcpWorkspace({ serverUrl: server.url, canonicalWorkspace: workspace, editorVersion });
  assert.equal(binding?.instanceId, instanceId);
  assert.equal(JSON.parse(await executeMcpTool(server.url, "read_console", { action: "get" }, binding)).data, "fixture-console");
  assert.deepEqual(routes, ["initialize", "notifications/initialized", "tools/list", "resources/read",
    "resources/read", "tools/call", "tools/call"]);
});
