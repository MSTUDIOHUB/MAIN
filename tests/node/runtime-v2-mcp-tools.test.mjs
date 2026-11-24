import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        path.join(base, "index.ts"),
      ]) {
        if (
          fs.existsSync(candidate) &&
          (candidate.endsWith(".ts") || candidate.endsWith(".tsx"))
        ) {
          return loadTs(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    runtimeRequire,
  );
  cache.set(normalized, module.exports);
  return module.exports;
}

const toolDiscovery = loadTs(path.join(workspaceRoot, "src/lib/toolSearch.ts"));
test.afterEach(() => toolDiscovery.clearUnlockedToolsForSession("session-mcp"));
const authorization = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionAuthorization.ts",
));
const authorizationContext = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionAuthorizationContext.ts",
));
const executionTypes = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionTypes.ts",
));
const evidence = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionEvidence.ts",
));
const executionToolPort = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionToolPort.ts",
));
const toolExecutor = loadTs(path.join(
  workspaceRoot,
  "src/lib/toolExecutor.ts",
));
const mcpClient = loadTs(path.join(
  workspaceRoot,
  "src/lib/mcpClient.ts",
));
const runtime = loadTs(path.join(
  workspaceRoot,
  "src/lib/runtime-v2/index.ts",
));

function stateForMcp(tools, toolServerMap, overrides = {}) {
  return {
    config: {
      mcpRouting: {
        enabled: true,
        threshold: 2,
        fallbackToFullList: true,
        disabledToolKeys: [],
      },
    },
    mcpServers: [{
      name: "Fixture MCP",
      type: "http",
      url: "http://fixture.example/mcp",
      enabled: true,
    }],
    mcpDiscoveredTools: tools,
    mcpToolServerMap: toolServerMap,
    approvedLocalFileReadPaths: [],
    currentTurnExecutionConsent: null,
    webSearchEnabled: false,
    runtimeV2Checkpoints: {},
    ...overrides,
  };
}

function portsFor(state) {
  return {
    get: () => state,
    context: {
      turnId: "turn-mcp",
      runWorkspace: "/tmp/runtime-v2-mcp",
      runSessionKey: "session-mcp",
      phaseLanguage: "en",
    },
    live: executionTypes.createRuntimeV2LiveExecutionState(),
    now: () => 1,
    nextId: (scope) => `${scope}-1`,
    logStoreEvent: () => undefined,
  };
}

function mcpTool(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    _mainMcpOrigin: {
      serverName: "Fixture MCP",
      serverUrl: "http://fixture.example/mcp",
      remoteName: name,
    },
  };
}

test("Runtime v2 freezes discovered MCP tools, advertises a bounded surface, and executes the catalog binding", async () => {
  mcpClient.__clearMcpDiscoveryFailureCacheForTests();
  const calls = [];
  mcpClient.__setMcpInvokeForTests(async (command, payload) => {
    assert.equal(command, "proxy_request_detailed");
    const request = JSON.parse(payload.body);
    calls.push(request);
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: {} }
      : request.method === "tools/list"
        ? {
            tools: [{
              name: "docs_search",
              description: "Search documentation and return matching passages",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            }],
          }
        : request.method === "tools/call"
          ? { content: [{ type: "text", text: "fixture MCP result" }] }
          : {};
    return {
      status: 200,
      ok: true,
      body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      contentType: "application/json",
      headers: { "mcp-session-id": "fixture-session" },
    };
  });

  const discovery = await mcpClient.discoverAllMcpTools([{
    name: "Fixture MCP",
    type: "http",
    url: "http://fixture.example/mcp",
    enabled: true,
  }], { forceRefresh: true });
  assert.equal(discovery.tools.length, 1);

  const state = stateForMcp(
    discovery.tools,
    discovery.toolServerMap,
  );
  const ports = portsFor(state);
  const frozen = authorizationContext.authorizationFor(ports);
  const mcpEntry = frozen.toolCatalog.entries.find((entry) =>
    entry.source === "mcp" && entry.executionName === "docs_search"
  );
  assert.ok(mcpEntry, "the Turn catalog should contain the discovered MCP tool");
  assert.equal(frozen.capabilityRegistry.tools[mcpEntry.exposedName].risk, "external_read");

  const coldSurface = authorizationContext.providerToolDefinitionsForCommand(ports, { kind: "request_model", payload: { mode: "analyze" } });
  assert.ok(coldSurface.some(tool => tool.function.name === "tool_search"));
  assert.ok(coldSurface.some(tool => tool.function.name === mcpEntry.exposedName), "the relevant admitted tool is already usable");
  toolDiscovery.unlockToolsForSession("session-mcp", [mcpEntry.exposedName]);
  const surface = authorizationContext.providerToolDefinitionsForCommand(
    ports,
    { kind: "request_model", payload: { mode: "analyze" } },
  );
  assert.ok(surface.some((definition) =>
    definition.function.name === mcpEntry.exposedName
  ));

  state.mcpDiscoveredTools = [mcpTool("late_tool", "Read late data")];
  assert.equal(
    authorizationContext.authorizationFor(ports).toolCatalog.lookup("late_tool").status,
    "unknown",
    "discovery changes after admission must not mutate the Turn catalog",
  );

  const allowed = await authorization.authorizeToolForCurrentTurn(
    ports,
    mcpEntry.exposedName,
    { query: "runtime" },
  );
  assert.equal(allowed.allowed, true);
  assert.equal(evidence.toolDefinitionExists(ports, mcpEntry.exposedName), true);

  const output = await toolExecutor.executeTool(
    mcpEntry.exposedName,
    { query: "runtime" },
    ports.context.runWorkspace,
    ports.context.runSessionKey,
    { toolCatalog: frozen.toolCatalog },
  );
  assert.equal(output, "fixture MCP result");
  const execution = calls.find((request) => request.method === "tools/call");
  assert.deepEqual(execution.params, {
    name: "docs_search",
    arguments: { query: "runtime" },
  });

  mcpClient.__clearMcpDiscoveryFailureCacheForTests();
  mcpClient.__setMcpInvokeForTests(null);
});

test("Runtime v2 keeps MCP effects out of Analyze and requires existing effect approvals", async () => {
  const read = mcpTool("docs_search", "Search documentation and return passages");
  const write = mcpTool("github_create_comment", "Create a GitHub issue comment");
  const destructive = mcpTool("desktop_delete_project", "Delete a project through desktop control");
  const state = stateForMcp(
    [read, write, destructive],
    {
      docs_search: "http://fixture.example/mcp",
      github_create_comment: "http://fixture.example/mcp",
      desktop_delete_project: "http://fixture.example/mcp",
    },
  );
  const ports = portsFor(state);
  const frozen = authorizationContext.authorizationFor(ports);
  const entryFor = (remoteName) => frozen.toolCatalog.entries.find((entry) =>
    entry.source === "mcp" && entry.executionName === remoteName
  );
  const readEntry = entryFor("docs_search");
  const writeEntry = entryFor("github_create_comment");
  const destructiveEntry = entryFor("desktop_delete_project");
  assert.ok(readEntry && writeEntry && destructiveEntry);

  toolDiscovery.unlockToolsForSession("session-mcp", [readEntry.exposedName, writeEntry.exposedName, destructiveEntry.exposedName]);
  const analyzeSurface = authorizationContext.providerToolDefinitionsForCommand(
    ports,
    { kind: "request_model", payload: { mode: "analyze" } },
  ).map((definition) => definition.function.name);
  assert.ok(analyzeSurface.includes(readEntry.exposedName));
  assert.ok(!analyzeSurface.includes(writeEntry.exposedName));
  assert.ok(!analyzeSurface.includes(destructiveEntry.exposedName));

  const withoutConsent = await authorization.authorizeToolForCurrentTurn(
    ports,
    writeEntry.exposedName,
    { input: "comment" },
  );
  assert.equal(withoutConsent.allowed, false);
  assert.match(withoutConsent.reason || "", /authorization|授权/i);

  state.currentTurnExecutionConsent = { turnId: "turn-mcp", granted: true };
  const destructiveReview = await authorization.authorizeToolForCurrentTurn(
    ports,
    destructiveEntry.exposedName,
    { input: "project-1" },
  );
  assert.equal(destructiveReview.allowed, false);
  assert.equal(destructiveReview.approvalRequired, true);
  assert.equal(destructiveReview.risk, "destructive");

  mcpClient.__clearMcpDiscoveryFailureCacheForTests();
  mcpClient.__setMcpInvokeForTests(async (_command, payload) => {
    const request = JSON.parse(payload.body);
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: {} }
      : request.method === "tools/call"
        ? { content: [{ type: "text", text: "comment created" }] }
        : {};
    return {
      status: 200,
      ok: true,
      body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      contentType: "application/json",
      headers: { "mcp-session-id": "effect-session" },
    };
  });
  const toolPort = executionToolPort.createRuntimeV2ToolPort(ports);
  const effectCompletion = await toolPort.execute({
    command: {
      kind: "execute_tool",
      phase: "acting",
      run: {
        sessionKey: "session-mcp",
        sessionEpoch: "epoch-mcp",
        turnId: "turn-mcp",
        runId: "run-mcp",
        parentRunId: null,
        attemptId: "attempt-mcp",
      },
      idempotencyKey: "execute-mcp-write",
      payload: {
        toolCallId: "call-mcp-write",
        toolName: writeEntry.exposedName,
        arguments: { input: "issue-1" },
      },
    },
    signal: new AbortController().signal,
  });
  assert.equal(effectCompletion.type, "tool.completed");
  assert.equal(effectCompletion.status, "succeeded");
  assert.equal(effectCompletion.effectKind, "external_operation");
  assert.deepEqual(effectCompletion.evidence.map((item) => item.kind), ["tool"]);
  assert.deepEqual(
    effectCompletion.evidence.map((item) => item.target),
    ["issue-1"],
    "an MCP effect keeps its external target instead of borrowing a workspace path",
  );
  assert.equal(ports.live.hasExecutedMutationEffect, false);

  const turn = {
    workspaceKey: "/tmp/runtime-v2-mcp",
    sessionKey: "session-mcp",
    sessionEpoch: "epoch-mcp",
    clientSubmissionId: "submission-plan-mcp",
    turnId: "turn-mcp",
  };
  const run = {
    sessionKey: turn.sessionKey,
    sessionEpoch: turn.sessionEpoch,
    turnId: turn.turnId,
    runId: "run-plan-mcp",
    parentRunId: null,
    attemptId: "attempt-plan-mcp",
  };
  let sequence = 0;
  const runtimeEvent = (type, fields) => ({
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: sequence++,
    eventId: `mcp-plan-event-${sequence}`,
    at: sequence,
    type,
    ...fields,
  });
  let aggregate = runtime.transition(null, runtimeEvent("turn.admitted", {
    turn,
    strategy: "plan",
    objective: "Create an external issue comment",
    constraints: [],
    acceptanceCriteria: ["The comment exists"],
    acceptanceCriterionIds: ["criterion-comment"],
  }));
  aggregate = runtime.transition(aggregate, runtimeEvent("run.started", {
    run,
    phase: "acting",
  }));
  state.runtimeV2Checkpoints = {
    [turn.turnId]: runtime.createRuntimeV2Checkpoint({
      revision: 1,
      aggregate,
      updatedAt: aggregate.updatedAt,
    }),
  };
  const planRejection = authorization.validateToolAgainstPhaseAndPlan({
    ports,
    command: {
      kind: "execute_tool",
      phase: "acting",
      run,
      idempotencyKey: "plan-mcp-effect",
      payload: { toolCallId: "plan-mcp-effect-call" },
    },
    toolName: writeEntry.exposedName,
    args: { input: "issue-1" },
    target: "issue-1",
  });
  assert.equal(planRejection.allowed, false);
  assert.equal(
    planRejection.reasonCode,
    "approved_plan_mcp_effect_scope_missing",
  );

  const validationRejection = authorization.validateToolAgainstPhaseAndPlan({
    ports,
    command: {
      kind: "execute_validation",
      phase: "validating",
      run,
      idempotencyKey: "mcp-validation-rejected-before-execution",
      payload: { toolCallId: "mcp-validation-call" },
    },
    toolName: writeEntry.exposedName,
    args: { input: "issue-1" },
    target: "issue-1",
  });
  assert.equal(validationRejection.allowed, false);
  assert.equal(
    validationRejection.reasonCode,
    "validation_tool_source_untrusted",
  );

  const falseValidation = evidence.toolCompletionFor(
    ports,
    {
      kind: "execute_validation",
      run: {
        sessionKey: "session-mcp",
        sessionEpoch: "epoch-mcp",
        turnId: "turn-mcp",
        runId: "run-mcp",
        parentRunId: null,
        attemptId: "attempt-mcp",
      },
      idempotencyKey: "mcp-cannot-validate",
      payload: {},
    },
    writeEntry.exposedName,
    { input: "issue-1" },
    "issue-1",
    JSON.stringify({ success: true, passed: true }),
    "succeeded",
  );
  assert.equal(falseValidation.type, "validation.completed");
  assert.equal(falseValidation.passed, false);
  mcpClient.__clearMcpDiscoveryFailureCacheForTests();
  mcpClient.__setMcpInvokeForTests(null);
});

test("Runtime v2 MCP routing keeps explicitly named tools without exposing an unbounded catalog", () => {
  const tools = Array.from({ length: 8 }, (_, index) =>
    mcpTool(
      `fixture_tool_${index}`,
      `Read fixture category ${index}`,
    )
  );
  const map = Object.fromEntries(tools.map((tool) => [
    tool.name,
    "http://fixture.example/mcp",
  ]));
  const state = stateForMcp(tools, map);
  const frozen = authorizationContext.createRuntimeV2ExecutionAuthorization(state);
  const selected = authorizationContext.runtimeV2ProviderToolDefinitionsForPrompt(
    frozen,
    "Use fixture_tool_7 for this exact request.",
  );
  const selectedMcp = selected.filter((definition) =>
    frozen.toolCatalog.lookup(definition.function.name).status === "resolved" &&
    frozen.toolCatalog.lookup(definition.function.name).entry.source === "mcp"
  );
  assert.ok(selectedMcp.some((definition) =>
    frozen.toolCatalog.lookup(definition.function.name).entry.executionName ===
      "fixture_tool_7"
  ));
  assert.ok(selectedMcp.length <= 2, "non-explicit MCP tools should obey the frozen threshold");
});

test("disabled MCP keys are a hard authorization boundary that explicit prompts cannot revive", async () => {
  const tool = mcpTool("docs_search", "Search documentation and return passages");
  const map = { docs_search: "http://fixture.example/mcp" };
  const baseline = authorizationContext.createRuntimeV2ExecutionAuthorization(
    stateForMcp([tool], map),
  );
  const entry = baseline.toolCatalog.entries.find((candidate) =>
    candidate.source === "mcp"
  );
  assert.ok(entry);
  const keyVariants = [
    entry.executionName,
    entry.exposedName,
    entry.canonicalName,
    `${entry.serverName}:${entry.executionName}`,
  ];

  for (const disabledKey of new Set(keyVariants)) {
    const state = stateForMcp([tool], map, {
      config: {
        mcpRouting: {
          enabled: true,
          threshold: 2,
          fallbackToFullList: true,
          disabledToolKeys: [disabledKey],
        },
      },
    });
    const ports = portsFor(state);
    const frozen = authorizationContext.authorizationFor(ports);
    const disabledEntry = frozen.toolCatalog.entries.find((candidate) =>
      candidate.source === "mcp"
    );
    assert.ok(disabledEntry);
    const surface = authorizationContext.runtimeV2ProviderToolDefinitionsForPrompt(
      frozen,
      `Use ${disabledEntry.exposedName} exactly.`,
    );
    assert.ok(!surface.some((definition) =>
      definition.function.name === disabledEntry.exposedName
    ));
    const denied = await authorization.authorizeToolForCurrentTurn(
      ports,
      disabledEntry.exposedName,
      { query: "runtime" },
    );
    assert.equal(denied.allowed, false);
    assert.match(denied.reason || "", /disabled|禁用/i);
  }
});

test("Runtime MCP authorization consumes the admitted workspace snapshot rather than a switched UI workspace", () => {
  const admitted = stateForMcp([mcpTool("admitted_read", "Read admitted workspace")], { admitted_read: "http://fixture.example/mcp" });
  const switched = stateForMcp([mcpTool("other_workspace_read", "Read another workspace")], { other_workspace_read: "http://fixture.example/mcp" });
  const ports = portsFor(switched);
  ports.context.workspaceMcpSnapshot = {
    workspace: "/workspace-a",
    mcpServers: admitted.mcpServers,
    mcpDiscoveredTools: admitted.mcpDiscoveredTools,
    mcpToolServerMap: admitted.mcpToolServerMap,
  };
  const frozen = authorizationContext.authorizationFor(ports);
  assert.ok(frozen.toolCatalog.entries.some((entry) => entry.executionName === "admitted_read"));
  assert.ok(!frozen.toolCatalog.entries.some((entry) => entry.executionName === "other_workspace_read"));
  ports.context.workspaceMcpSnapshot = null;
  assert.equal(authorizationContext.authorizationFor(ports), frozen);
});

test("Analyze receives the bound Editor Console result and rejects raw Unity effects", async (t) => {
  const { bindWorkspaceUnityMcpView, resolveWorkspaceMcpView } = loadTs("src/lib/workspaceMcp.ts");
  const { runRuntimeV2ReadOnlyLoop } = loadTs("src/lib/runtime-v2/readOnly.ts");
  const workspace = "/tmp/runtime-v2-mcp";
  const server = { name: "Editor fixture", type: "http", url: "http://fixture-editor.example/mcp", enabled: true };
  const hash = createHash("sha1").update(`${workspace}/Assets`).digest("hex").slice(0, 16);
  const instance = { id: `fixture@${hash}`, hash, unity_version: "2022.3.62t16" };
  const schemas = [
    ["read_console", "Read or clear the Console."],
    ["unity_reflect", "Inspect API types and members."],
    ["manage_scene", "Read or change the active scene. Example: get the active scene."],
    ["find_gameobjects", "Find objects in the active scene."],
    ["execute_code", "Run C# in Unity and return diagnostics. Example: read the active scene."],
    ["batch_execute", "Submit tools together and read their results. Example: inspect several assets."],
    ["apply_text_edits", "Apply text edits and return the resulting status. Example: edit a script."],
    ["set_active_instance", "Select an Editor instance."],
  ].map(([name, description]) => ({ name, description, inputSchema: { type: "object", properties: {} } }));
  const calls = [];
  const marker = "Console fixture warning 731";
  const consoleResult = { success: true, message: "Retrieved 1 log entries.",
    data: [{ type: "Warning", file: "Assets/Fixture.cs", line: 12, message: marker }] };
  mcpClient.__clearMcpDiscoveryFailureCacheForTests();
  mcpClient.__setMcpInvokeForTests(async (_command, payload) => {
    const request = JSON.parse(payload.body);
    let result = {};
    if (request.method === "initialize") result = { serverInfo: { name: "mcp-for-unity-server" } };
    if (request.method === "tools/list") result = { tools: schemas };
    if (request.method === "resources/read") result = { contents: [{ text: JSON.stringify({ success: true, instances: [instance] }) }] };
    if (request.method === "tools/call") {
      calls.push(request.params);
      result = request.params.name === "set_active_instance"
        ? { structuredContent: { success: true, data: { instance: instance.id } } }
        : { content: [{ type: "text", text: JSON.stringify(consoleResult) }], structuredContent: consoleResult };
    }
    return { status: 200, ok: true, body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) };
  });
  t.after(() => {
    mcpClient.__setMcpInvokeForTests(null);
    mcpClient.__clearMcpDiscoveryFailureCacheForTests();
  });
  const discovery = await mcpClient.discoverAllMcpTools([server], { forceRefresh: true });
  const workspaceMcpSnapshot = await bindWorkspaceUnityMcpView(resolveWorkspaceMcpView({
    workspace, manualServers: [server], manualTools: discovery.tools, manualToolServerMap: discovery.toolServerMap,
  }), instance.unity_version);
  const state = stateForMcp([], {}, { currentTurnExecutionConsent: { turnId: "turn-mcp", granted: true } });
  const ports = portsFor(state);
  ports.context = { ...ports.context, runtimeRunIntent: "analyze", workspaceMcpSnapshot };
  const turn = {
    workspaceKey: workspace, sessionKey: "session-mcp", sessionEpoch: "epoch-mcp",
    clientSubmissionId: "submission-console", turnId: "turn-mcp",
  };
  const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId,
    runId: "run-console", parentRunId: null, attemptId: "attempt-console" };
  const toolPort = executionToolPort.createRuntimeV2ToolPort(ports);
  const scope = authorizationContext.authorizationFor(ports);
  const rawEntries = scope.toolCatalog.entries.filter(entry => entry.source === "mcp");
  toolDiscovery.unlockToolsForSession(turn.sessionKey, rawEntries.map(entry => entry.exposedName));
  const rawEffectNames = rawEntries.filter(entry => ["execute_code", "batch_execute", "apply_text_edits", "read_console", "manage_scene"].includes(entry.executionName));
  const requested = { id: "console-read", name: "unity_mcp_console", arguments: {} };
  const published = [];
  let nextId = 0;
  let providerRequests = 0;
  let initialSurface = [];
  let modelReceivedConsole = false;
  const result = await runRuntimeV2ReadOnlyLoop({
    strategy: "analyze", turn, run, objective: "Read the connected Editor Console.",
    now: Date.now, deadlineMs: 5_000, signal: new AbortController().signal,
    ports: {
      clockId: { now: Date.now, nextId: (kind) => `${kind}-${++nextId}`, nextIdempotencyKey: ({ kind }) => `${kind}-${++nextId}` },
      checkpoint: { append: async (input) => {
        const result = runtime.appendRuntimeV2Checkpoint({ ...input, checkpoint: state.runtimeV2Checkpoints[turn.turnId] });
        assert.equal(result.disposition, "committed");
        state.runtimeV2Checkpoints[turn.turnId] = result.checkpoint;
        return result;
      } },
      provider: { request: async ({ command }) => {
        if (++providerRequests === 1) {
          initialSurface = authorizationContext.providerToolDefinitionsForCommand(ports, command).map(tool => tool.function.name);
          ports.live.messages.push({ role: "assistant", content: "", tool_calls: [{
            id: requested.id, type: "function", function: { name: requested.name, arguments: "{}" },
          }] });
          return { visibleText: "", toolCalls: [requested], diagnostics: [] };
        }
        modelReceivedConsole = ports.live.messages.some(message => message.role === "tool" && message.content.includes(marker));
        return { visibleText: marker, toolCalls: [], diagnostics: [] };
      } },
      tool: toolPort,
      scheduler: { execute: async () => assert.fail("Console read should not schedule children") },
      projection: { publish: async input => published.push(input) },
    },
  });
  assert.ok(initialSurface.includes(requested.name));
  const receipt = result.aggregate.events.find(event => event.type === "tool.completed");
  assert.equal(receipt?.status, "succeeded", receipt?.failureReasonCode);
  assert.deepEqual(JSON.parse(receipt.modelContent), consoleResult);
  assert.deepEqual(receipt.evidence.map(item => item.kind), ["tool"]);
  assert.equal(receipt.effectKind, "observation");
  assert.equal(modelReceivedConsole, true);
  assert.equal(result.resultKind, "success");
  assert.equal(providerRequests, 2);
  assert.equal(result.aggregate.events.filter(event => event.type === "run.completed").length, 1);
  assert.equal(result.aggregate.events.filter(event => event.type === "turn.completed").length, 1);
  assert.equal(published.filter(input => input.audience === "final").length, 1);

  const executeEvidence = (receiptOrigin) => result.aggregate.events
    .filter(event => event.sequence <= receipt.sequence)
    .reduce((aggregate, event) => runtime.transition(aggregate,
      event.type === "turn.admitted" ? { ...event, strategy: "execute", constraints: [], completionRequirement: { kind: "workspace_change", editorDiagnostics: true } }
        : event === receipt ? { ...event, receiptOrigin } : event), null);
  assert.equal(runtime.runtimeV2CommandTaskReadyForConclusion(executeEvidence("executed")), false);
  assert.equal(runtime.runtimeV2CommandTaskReadyForConclusion(executeEvidence("replayed")), false);

  const modelCommand = { kind: "request_model", payload: { mode: "analyze" } };
  const surface = authorizationContext.providerToolDefinitionsForCommand(ports, modelCommand).map(tool => tool.function.name);
  assert.ok(surface.includes("unity_mcp_scene"));
  assert.ok(surface.includes("find_gameobjects"), "an explicitly read-only connector tool remains available");
  assert.equal(rawEffectNames.length, 5);
  for (const entry of rawEffectNames) {
    assert.ok(!surface.includes(entry.exposedName), `${entry.executionName} appeared in Analyze`);
    const completion = await toolPort.execute({ command: {
      kind: "execute_tool", phase: "observing", run, idempotencyKey: entry.exposedName,
      payload: { toolName: entry.exposedName, arguments: { action: "get", query: "SELECT 1" } },
    }, signal: new AbortController().signal });
    assert.equal(completion.status, "blocked", entry.executionName);
    assert.equal(completion.failureReasonCode, "workspace_read_only_authority", entry.executionName);
    assert.deepEqual(completion.evidence, []);
  }
  assert.deepEqual(calls, [
    { name: "set_active_instance", arguments: { instance: instance.id } },
    { name: "read_console", arguments: { action: "get", types: ["error", "warning"], count: 25, format: "json" } },
  ]);

  const { boundRuntimeV2ProviderToolCalls } = loadTs("src/store/runtimeV2/providerToolSurface.ts");
  const observations = [["read_console", { action: "get", count: 30 }], ["unity_reflect", { action: "get_type", class_name: "UnityEngine.Mesh" }]]
    .map(([name, args]) => ({ id: name, name: rawEntries.find(entry => entry.executionName === name).exposedName,
      arguments: args }));
  const batch = boundRuntimeV2ProviderToolCalls(observations.map(call => ({ ...call,
    boundEditorObservation: !!authorizationContext.runtimeV2BoundEditorObservation(ports, call.name, call.arguments),
  })), new Set(), new Set());
  assert.equal(batch.selection, "safe_batch");
  assert.equal(batch.accepted.length, 2);
  for (const call of batch.accepted) {
    const completion = await toolPort.execute({ command: { kind: "execute_tool", phase: "observing", run,
      idempotencyKey: call.id, payload: { toolName: call.name, arguments: call.arguments } }, signal: new AbortController().signal });
    assert.equal(completion.status, "succeeded");
    assert.equal(completion.effectKind, "observation");
    assert.deepEqual(completion.evidence.map(item => item.kind), ["tool"]);
  }
  assert.deepEqual(calls.slice(-4).map(call => call.name), ["set_active_instance", "read_console", "set_active_instance", "unity_reflect"]);

  state.config.toolPermissionPolicy = { disabledRiskLevels: ["external_read"] };
  const disabledPorts = { ...ports, live: executionTypes.createRuntimeV2LiveExecutionState() };
  assert.ok(!authorizationContext.providerToolDefinitionsForCommand(disabledPorts, modelCommand)
    .some(tool => tool.function.name === requested.name));
  assert.equal((await authorization.authorizeToolForCurrentTurn(disabledPorts, requested.name, {})).allowed, false);
});
