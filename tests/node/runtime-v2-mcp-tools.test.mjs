import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
  assert.ok(effectCompletion.evidence.some((item) => item.kind === "mutation"));
  assert.deepEqual(
    effectCompletion.evidence.map((item) => item.target),
    ["issue-1"],
    "an MCP effect keeps its external target instead of borrowing a workspace path",
  );
  assert.equal(ports.live.hasExecutedMutationEffect, true);

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
