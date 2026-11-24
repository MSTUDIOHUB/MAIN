import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const fileReads = [];
const load = createTsModuleLoader({
  "./ipc": {
    getChatTempRoot: async sessionKey => `/chat/${sessionKey}`,
    readFile: async (path, workspace) => { fileReads.push({ path, workspace }); return "attached bytes"; },
    ingestAttachmentFile: async () => ({ path: ".MAIN-chat-attachments/approved.txt", workspace: "/chat/approved" }),
  },
});
const runtime = load("src/lib/runtime-v2/index.ts");
const auth = load("src/store/runtimeV2/executionAuthorizationContext.ts");
const { createRuntimeV2LiveExecutionState } = load("src/store/runtimeV2/executionTypes.ts");
const discovery = load("src/lib/toolSearch.ts");
const { executeTool } = load("src/lib/toolExecutor.ts");
const projectTools = ["glob_search", "grep_search", "replace_in_file", "write_file", "apply_patch", "run_command", "get_project_skeleton", "git_status", "browser_evaluate", "computer_use"];
const attachmentTools = ["read_file", "read_document", "analyze_tabular_document", "query_tabular_document"];
let ordinal = 0;
const sessions = [];
test.afterEach(() => { for (const session of sessions.splice(0)) discovery.clearUnlockedToolsForSession(session); fileReads.length = 0; });

function fixture(workspace, { web = true, mcp = [], mutableWorkspace = "/different-live-project" } = {}) {
  const sessionKey = `scope-availability-${++ordinal}`;
  sessions.push(sessionKey);
  const turn = { workspaceKey: workspace || "__MAIN_GLOBAL_CHAT__", sessionKey, sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" };
  const run = { sessionKey, sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
  let aggregate = runtime.transition(null, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "turn.admitted", sequence: 0, eventId: "admit", at: 1,
    turn, strategy: "execute", objective: "Inspect the current service.", acceptanceCriteria: [], constraints: [] });
  aggregate = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "run.started", sequence: 1, eventId: "start", at: 2, run, phase: "observing" });
  const state = { currentWorkspace: mutableWorkspace, config: {}, webSearchEnabled: web, webSearchProvider: "bing",
    mcpServers: [{ name: "Fixture", url: "http://fixture.invalid/mcp", type: "http", enabled: true }],
    mcpDiscoveredTools: mcp, mcpToolServerMap: {},
    runtimeV2Checkpoints: { turn: runtime.createRuntimeV2Checkpoint({ aggregate, revision: 2, updatedAt: 2 }) } };
  const ports = { get: () => state, live: createRuntimeV2LiveExecutionState(), context: {
    turnId: "turn", runWorkspace: workspace, runSessionKey: sessionKey, runtimeRunIntent: "execute", phaseLanguage: "en",
    networkRead: { enabled: web, provider: "bing" },
    turnInputContextSignals: { attachedFilePaths: [".MAIN-chat-attachments/brief.txt"], mentionedFilePaths: [], imageParts: 0 },
  } };
  const command = { run, kind: "request_model", idempotencyKey: "model", phase: "observing", payload: { mode: "execute" } };
  return { state, ports, command, sessionKey, authorization: () => auth.authorizationFor(ports),
    selected: () => auth.providerToolDefinitionsForCommand(ports, command).map(tool => tool.function.name) };
}

test("global catalog omits workspace-only built-ins using the frozen Run scope", () => {
  const f = fixture("");
  const catalog = f.authorization().toolCatalog;
  for (const name of projectTools) assert.equal(catalog.lookup(name).status, "unknown", `${name} cannot run without a workspace`);
  for (const name of attachmentTools) assert.equal(catalog.lookup(name).status, "resolved", `${name} still serves explicit files`);
  assert.equal(catalog.lookup("record_execution_contract").status, "resolved", "this patch does not invent a new control-tool policy");
});

test("global Execute advertises enabled web reads directly without guessing language or a tool-search keyword", () => {
  const f = fixture("");
  const selected = f.selected();
  for (const name of ["web_search", "web_fetch", "read_file", "tool_search"]) assert.ok(selected.includes(name), name);
  for (const name of projectTools) assert.ok(!selected.includes(name), name);
});

test("tool search and old session unlocks cannot resurrect workspace-only tools in global Execute", () => {
  const f = fixture("");
  discovery.unlockToolsForSession(f.sessionKey, projectTools);
  const result = JSON.parse(discovery.executeToolSearch({ query: "all", limit: 20 }, { sessionKey: f.sessionKey, toolCatalog: f.authorization().toolCatalog }));
  const discovered = result.availableExtendedTools.map(tool => tool.name);
  for (const name of projectTools) {
    assert.ok(!discovered.includes(name), name);
    assert.ok(!f.selected().includes(name), name);
  }
  for (const name of attachmentTools) assert.ok(f.selected().includes(name), `discovered ${name} remains callable for explicit files`);
});

test("global web-off does not add network tools even after an old unlock", () => {
  const f = fixture("", { web: false });
  discovery.unlockToolsForSession(f.sessionKey, ["web_search", "web_fetch"]);
  for (const name of ["web_search", "web_fetch"]) {
    assert.equal(f.authorization().toolCatalog.lookup(name).status, "unknown");
    assert.ok(!f.selected().includes(name));
  }
});

test("real project scope preserves the existing core tool order and discovery", () => {
  const f = fixture("/fixture", { mutableWorkspace: "" });
  assert.deepEqual(f.selected(), ["glob_search", "grep_search", "read_file", "replace_in_file", "write_file", "run_command", "tool_search", "record_execution_contract"]);
  assert.equal(f.authorization().toolCatalog.lookup("get_project_skeleton").status, "resolved");
  discovery.executeToolSearch({ query: "get_project_skeleton" }, { sessionKey: f.sessionKey, toolCatalog: f.authorization().toolCatalog });
  assert.ok(f.selected().includes("get_project_skeleton"));
});

test("global catalog filtering preserves namespaced MCP tools with a workspace-tool remote name", () => {
  const remote = { name: "run_command", description: "Remote service operation", inputSchema: { type: "object", properties: {} },
    _mainMcpOrigin: { serverName: "Fixture", serverUrl: "http://fixture.invalid/mcp", remoteName: "run_command" } };
  const f = fixture("", { mcp: [remote] });
  const entry = f.authorization().toolCatalog.entries.find(entry => entry.source === "mcp");
  assert.ok(entry);
  assert.equal(entry.executionName, "run_command");
  assert.equal(f.authorization().toolCatalog.lookup(entry.exposedName).status, "resolved");
  assert.notEqual(entry.exposedName, "run_command");
  assert.equal(f.authorization().toolCatalog.lookup("run_command").status, "unknown");
});

test("the shared native guard still rejects project tools while explicit files retain their original approval boundary", async () => {
  for (const name of projectTools) await assert.rejects(executeTool(name, {}, "", "global-session"), /WORKSPACE_REQUIRED_FOR_TOOL/);
  await assert.rejects(executeTool("read_file", { path: "unattached.txt", __raw: true }, "", "global-session"), /WORKSPACE_REQUIRED_FOR_TOOL/);
  await assert.rejects(executeTool("read_file", { path: "/private/secret.txt", __raw: true }, "", "global-session"), /requires user approval/);
  assert.equal(await executeTool("read_file", { path: ".MAIN-chat-attachments/brief.txt", __raw: true }, "", "global-session"), "attached bytes");
  assert.equal(await executeTool("read_file", { path: "/explicit/approved.txt", __raw: true }, "", "global-session", { allowExternalLocalRead: true }), "attached bytes");
  assert.deepEqual(fileReads, [{ path: ".MAIN-chat-attachments/brief.txt", workspace: "/chat/global-session" }, { path: ".MAIN-chat-attachments/approved.txt", workspace: "/chat/approved" }]);
});
