import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createRequire } from "node:module";
import { createServer } from "node:http";

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
const install = (overrides = {}) => ({
  id: "one", name: "Fixture", version: "1", description: "", workspaceScope: "/a",
  packagePath: ".protocols/fixture", packageHash: "hash-one", manifestPath: "gemini-extension.json",
  sourcePath: "/fixture.zip", installedAt: 1, enabled: true, skillEntryPoints: [], unsupportedFeatures: [],
  mcpServers: [{ key: "tools", url: "http://127.0.0.1:54321/mcp", supported: true, status: "supported", enabled: true, reasons: [] }],
  ...overrides,
});

test("workspace normalization preserves filesystem roots", () => {
  assert.equal(mcp.normalizeExtensionWorkspace("/"), "/");
  assert.equal(mcp.normalizeExtensionWorkspace("C:\\"), "C:/");
  assert.equal(mcp.normalizeExtensionWorkspace("/repo/"), "/repo");
});

test("extension MCP view is workspace-scoped and preserves manual configuration", () => {
  const extension = install();
  const servers = mcp.extensionMcpServers(extension);
  const tool = { name: "ping", description: "Ping", inputSchema: { type: "object" }, _mainMcpOrigin: { serverName: servers[0].name, serverUrl: servers[0].url, remoteName: "ping" } };
  const discovery = { [mcp.extensionMcpDiscoveryKey(extension)]: { tools: [tool], toolServerMap: { ping: servers[0].url }, serverStatuses: [] } };
  const input = { workspace: "/a", manualServers: [{ name: "manual", type: "http", url: "http://localhost:8080/mcp" }], manualTools: [], manualToolServerMap: {}, installations: [extension], discoveries: discovery };
  const view = mcp.resolveWorkspaceMcpView(input);
  assert.equal(view.mcpServers.length, 2);
  assert.equal(view.mcpDiscoveredTools.length, 1);
  assert.equal(mcp.resolveWorkspaceMcpView({ ...input, workspace: "/b" }).mcpDiscoveredTools.length, 0);
  assert.equal(mcp.resolveWorkspaceMcpView({ ...input, workspace: "/b" }).mcpServers.length, 1);
  tool.inputSchema.type = "string";
  assert.equal(view.mcpDiscoveredTools[0].inputSchema.type, "object");
});

test("blocked, disabled and stale extension discoveries are never admitted", () => {
  assert.deepEqual(mcp.extensionMcpServers(install({ enabled: false })), []);
  assert.deepEqual(mcp.extensionMcpServers(install({ mcpServers: [{ key: "bad", url: "http://localhost/mcp", supported: false, status: "blocked", enabled: true }] })), []);
  const first = install();
  const next = install({ packageHash: "hash-two" });
  assert.notEqual(mcp.extensionMcpDiscoveryKey(first), mcp.extensionMcpDiscoveryKey(next));
  const view = mcp.resolveWorkspaceMcpView({ workspace: "/a", manualServers: [], manualTools: [], manualToolServerMap: {}, installations: [next], discoveries: { [mcp.extensionMcpDiscoveryKey(first)]: { tools: [{ name: "old" }], toolServerMap: {}, serverStatuses: [] } } });
  assert.deepEqual(view.mcpDiscoveredTools, []);
});

test("an extension at the same endpoint cannot revive disabled manual tools", () => {
  const extension = install();
  const view = mcp.resolveWorkspaceMcpView({ workspace: "/a", manualServers: [{ name: "manual", type: "http", url: extension.mcpServers[0].url, enabled: false }], manualTools: [{ name: "disabled_manual" }], manualToolServerMap: { disabled_manual: extension.mcpServers[0].url }, installations: [extension], discoveries: {} });
  assert.deepEqual(view.mcpDiscoveredTools, []);
});

test("extension management detects unfinished turns in foreground, background and persisted sessions", () => {
  const base = { currentWorkspace: "/b", conversationTurns: [], runtimeBySessionKey: {}, sessionsByWorkspace: {} };
  assert.equal(mcp.workspaceHasUnfinishedTurns(base, "/a"), false);
  assert.equal(mcp.workspaceHasUnfinishedTurns({ ...base, sessionsByWorkspace: { "/a": [{ runtimeSnapshot: { conversationTurns: [{ status: "paused", runtimeOutcome: { status: "paused" } }] } }] } }, "/a"), true);
  assert.equal(mcp.workspaceHasUnfinishedTurns({ ...base, runtimeBySessionKey: { "/a:123": { conversationTurns: [{ status: "running" }] } } }, "/a"), true);
  assert.equal(mcp.workspaceHasUnfinishedTurns({ ...base, currentWorkspace: "/a", conversationTurns: [{ status: "completed", runtimeOutcome: { status: "completed" } }] }, "/a"), false);
});

function serializedReviewCheckpoint(strategy, terminal = false) {
  const runtime = loadTs("src/lib/runtime-v2/index.ts");
  const turn = { workspaceKey: "/a", sessionKey: "/a:123", sessionEpoch: "epoch-fixture", clientSubmissionId: `submission-${strategy}`, turnId: `turn-${strategy}` };
  const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: `run-${strategy}`, parentRunId: null, attemptId: "attempt-one" };
  let aggregate = null;
  const append = (type, fields) => {
    aggregate = runtime.transition(aggregate, {
      schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: aggregate?.nextSequence || 0,
      eventId: `event-${strategy}-${aggregate?.nextSequence || 0}`,
      at: (aggregate?.updatedAt || 0) + 1,
      type,
      ...fields,
    });
  };
  append("turn.admitted", { turn, strategy, objective: "Fixture review", constraints: [], acceptanceCriteria: [] });
  append("run.started", { run, phase: "planning" });
  append("phase.changed", { run, phase: "reviewing", reason: "fixture_review_wait" });
  if (terminal) {
    append("phase.changed", { run, phase: "finalizing", reason: "fixture_complete" });
    const projection = runtime.buildRuntimeV2FinalProjection(aggregate, "fixture-final", "error", "fixture_closed", "Fixture closed.");
    const outcome = { resultKind: "error", reason: "fixture_closed", completedAt: aggregate.updatedAt + 1, finalProjectionId: projection.id };
    append("run.completed", { run, outcome, finalProjection: projection });
    append("projection.published", { run, audience: "final", projectionId: projection.id, projection });
    append("turn.completed", { turn, runId: run.runId, outcome });
  }
  const checkpoint = runtime.createRuntimeV2Checkpoint({ revision: aggregate.events.length, aggregate, updatedAt: aggregate.updatedAt });
  const serialized = JSON.parse(JSON.stringify(runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: checkpoint })));
  assert.equal(serialized[turn.turnId].schemaVersion, "turn-runtime-checkpoint.v5");
  assert.equal(Object.hasOwn(serialized[turn.turnId], "aggregate"), false);
  return { turn, serialized };
}

test("extension management replays serialized v5 Plan and Goal ledgers even when transcript pages are absent", () => {
  for (const strategy of ["plan", "goal"]) {
    const { serialized } = serializedReviewCheckpoint(strategy);
    const snapshot = { runtimeV2Checkpoints: serialized, conversationTurns: [] };
    const base = { currentWorkspace: "/b", sessionsByWorkspace: { "/a": [{ runtimeSnapshot: snapshot }] } };
    assert.equal(mcp.workspaceHasUnfinishedTurns(base, "/a"), true, strategy);
    assert.equal(mcp.workspaceHasUnfinishedTurns({ currentWorkspace: "/a", ...snapshot }, "/a"), true, strategy);
    assert.equal(mcp.workspaceHasUnfinishedTurns({ currentWorkspace: "/b", ...snapshot }, "/b"), false, "foreign workspace checkpoint is not an owner");
  }
});

test("a replay-closed v5 ledger outranks stale paused conversation projection", () => {
  const { serialized, turn } = serializedReviewCheckpoint("plan", true);
  assert.equal(mcp.workspaceHasUnfinishedTurns({ currentWorkspace: "/a", runtimeV2Checkpoints: serialized, conversationTurns: [{ id: turn.turnId, status: "paused", runtimeOutcome: { status: "paused" } }] }, "/a"), false);
});

test("an imported anonymous HTTP binding discovers and calls tools over a real HTTP connection", async () => {
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
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "extension-fixture", version: "1" } }
      : rpc.method === "tools/list"
        ? { tools: [{ name: "extension_ping", description: "Read a fixture value", inputSchema: { type: "object", properties: {} } }] }
        : { content: [{ type: "text", text: "extension-http-ok" }] };
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
    const installation = install({ mcpServers: [{ key: "fixture", url, supported: true, status: "supported", enabled: true, reasons: [] }] });
    const discovery = await client.discoverAllMcpTools(mcp.extensionMcpServers(installation));
    assert.equal(discovery.serverStatuses[0].status, "connected");
    const view = mcp.resolveWorkspaceMcpView({ workspace: "/a", manualServers: [], manualTools: [], manualToolServerMap: {}, installations: [installation], discoveries: { [mcp.extensionMcpDiscoveryKey(installation)]: discovery } });
    assert.equal(view.mcpDiscoveredTools[0].name, "extension_ping");
    assert.match(await client.executeMcpTool(url, "extension_ping", {}), /extension-http-ok/);
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  } finally {
    client.__setMcpInvokeForTests(null);
    await new Promise((resolve) => server.close(resolve));
  }
});
