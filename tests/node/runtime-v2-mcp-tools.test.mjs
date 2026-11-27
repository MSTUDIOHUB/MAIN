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

const pipelineConsole = {
  success: true,
  data: {
    cursor: 0, truncated: false, total: 1,
    consoleEvidence: { rowSource: "retained", retainedWindowComplete: true, retainedErrors: 1, retainedWarnings: 0, session: "capture", cursor: 8 },
    groundTruth: { ageMs: 120, sampledUtc: "2026-11-27T07:01:01.000Z", compilationFailed: true, compiling: false, consoleErrors: 1, consoleWarnings: 0 },
    items: [{ type: "Error", message: "Assets/Tests/Fixture.cs(88,10): error CS0246: Missing type." }],
  },
};

const pipelineEvidence = {
  complete: false,
  diagnostics: [],
  retainedDiagnostics: [{ kind: "csharp", path: "Assets/Tests/Fixture.cs", line: 88, code: "CS0246" }],
  pipeline: { retainedWindowComplete: true, retainedErrors: 1, retainedWarnings: 0, session: "capture", cursor: 8,
    live: { ageMs: 120, sampledAt: Date.parse("2026-11-27T07:01:01.000Z"), compilationFailed: true, compiling: false, errors: 1, warnings: 0 } },
};

test("Execute reads current Unity compiler errors and resolves the owning asmdef before repair", async (t) => {
  const { runtimeV2ExecutionEditorGuidance } = loadTs("src/store/runtimeV2/executionEditorGuidance.ts");
  const store = stateForMcp([], {}, { currentTurnExecutionConsent: { turnId: "turn-mcp", granted: true } });
  const ports = portsFor(store);
  const workspace = ports.context.runWorkspace;
  const turn = { workspaceKey: workspace, sessionKey: "session-mcp", sessionEpoch: "epoch-mcp", turnId: "turn-mcp", clientSubmissionId: "unity-repair" };
  const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId,
    runId: "run-unity-repair", parentRunId: null, attemptId: "attempt-unity-repair" };
  let aggregate = null;
  const apply = (type, fields) => {
    const sequence = aggregate?.nextSequence ?? 0;
    aggregate = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence, eventId: `unity-repair-${sequence}`, at: sequence + 1, type, run, ...fields });
    store.runtimeV2Checkpoints[turn.turnId] = runtime.createRuntimeV2Checkpoint({
      revision: aggregate.nextSequence, aggregate, updatedAt: aggregate.updatedAt,
    });
  };
  apply("turn.admitted", { turn, strategy: "execute", objective: "修复console窗口的错误", constraints: [], acceptanceCriteria: [],
    completionRequirement: { kind: "workspace_change", editorDiagnostics: true } });
  apply("run.started", { phase: "observing" });
  const observed = { kind: "execute_tool", phase: "observing", run, idempotencyKey: "console",
    payload: { toolName: "unity_official_mcp_console", arguments: {} } };
  apply("command.scheduled", { command: observed });
  const editorPid = 30663;
  const editorVersion = "6000.6.5f1";
  apply("tool.completed", { idempotencyKey: observed.idempotencyKey, status: "succeeded", evidence: [], effectKind: "observation",
    editorConsole: { ...pipelineEvidence, instanceId: `unity-official-mcp:${editorPid}`, editorPid, editorVersion } });
  const path = "Assets/Tests/Fixture.cs";
  const asmdef = "Assets/Tests/Fixture.asmdef";
  const version = `sha256-${"a".repeat(64)}`;
  const declaration = { name: "Unity.InputSystem", path: "Library/PackageCache/com.unity.inputsystem@verified/InputSystem/Unity.InputSystem.asmdef",
    package: "com.unity.inputsystem", packageVersion: "1.20.0", version };
  let references = [{ reference: "UnityEngine.InputSystem", status: "missing", candidate: { ...declaration, namespace: "UnityEngine.InputSystem" } }];
  const calls = [];
  const originalWindow = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "unity_compile_project") return {
      status: "failed", kind: "csharp", editor: "connected", projectRoot: ".", editorPid, editorVersion,
      targets: [{ path, version }], diagnostics: [{ file: path, line: 2, column: 19, code: "CS0234", message: "InputSystem is missing" }],
    };
    assert.equal(command, "unity_inspect_assemblies");
    return { complete: true, sources: [{ path, assembly: { name: "Fixture", path: asmdef, version, predefined: false, references } }] };
  } } };
  t.after(() => { globalThis.window = originalWindow; });
  const port = executionToolPort.createRuntimeV2ToolPort(ports);
  const signal = new AbortController().signal;
  const [baseline] = runtime.decideNextCommands(aggregate, { checkUnityCompilation: true });
  assert.ok(baseline?.payload.runtimeOwnedUnityBaselineCompile);
  await assert.rejects(port.execute({ command: baseline, signal }), /UNITY_REPAIR_EVIDENCE_AUTHORITY_INVALID/);
  assert.equal(calls.length, 0);
  apply("command.scheduled", { command: baseline });
  const baselineReceipt = await port.execute({ command: baseline, signal });
  assert.equal(baselineReceipt.status, "succeeded");
  assert.equal(JSON.parse(baselineReceipt.modelContent).status, "failed");
  assert.deepEqual(baselineReceipt.evidence, []);
  apply("tool.completed", baselineReceipt);
  const [inspect] = runtime.decideNextCommands(aggregate, { checkUnityCompilation: true });
  assert.ok(inspect?.payload.runtimeOwnedUnityAssemblyDiagnosis);
  apply("command.scheduled", { command: inspect });
  const report = await port.execute({ command: inspect, signal });
  assert.equal(report.status, "succeeded");
  assert.deepEqual(report.evidence, []);
  apply("tool.completed", report);
  assert.deepEqual(runtime.decideNextCommands(aggregate, { checkUnityCompilation: true }), []);
  assert.deepEqual(calls.map(({ command, args }) => [command, args.workspace, args.targets ?? args.sourcePaths]), [
    ["unity_compile_project", workspace, [path]], ["unity_inspect_assemblies", workspace, [path]],
  ]);
  assert.deepEqual(calls[0].args.consoleBinding, { editorPid, editorVersion });
  const guide = runtimeV2ExecutionEditorGuidance(aggregate, new Set()).instruction;
  assert.match(guide, /Fixture\.asmdef.*UnityEngine\.InputSystem.*Unity\.InputSystem/);
  assert.match(guide, /Preserve the verified C# namespace "UnityEngine\.InputSystem" in source imports/);
  assert.match(guide, /CS0234/);
  assert.equal(runtime.runtimeV2CommandTaskReadyForConclusion(aggregate), false);

  // The first compile checks a C# file. The immutable inspection receipt,
  // rather than the extension of the compile target, proves the invalid edge.
  const predefinedReport = JSON.parse(report.modelContent);
  predefinedReport.sources[0].assembly.references = [
    { reference: "Assembly-CSharp", status: "predefined" },
  ];
  const withPredefinedEdge = runtime.replayRuntimeV2Events(aggregate.events.map(event =>
    event.type === "tool.completed" && event.idempotencyKey === report.idempotencyKey
      ? { ...event, modelContent: JSON.stringify(predefinedReport) }
      : event));
  assert.deepEqual(JSON.parse(baselineReceipt.modelContent).targets.map(target => target.path), [path]);
  const predefinedGuide = runtimeV2ExecutionEditorGuidance(withPredefinedEdge, new Set()).instruction;
  assert.match(predefinedGuide, /confirms an unsupported reference from a named assembly/);
  assert.ok(predefinedGuide.includes(`"${path}" belongs to "${asmdef}" ("Fixture"), which references the predefined script assembly "Assembly-CSharp"`));
  assert.match(predefinedGuide, /Locate the actual source declarations.*owning \.asmdef or \.asmref/);
  assert.doesNotMatch(guide, /confirms an unsupported reference from a named assembly/);

  const write = { ...observed, idempotencyKey: "repair-reference", payload: { toolName: "replace_in_file", arguments: { path: asmdef } } };
  apply("command.scheduled", { command: write });
  apply("tool.completed", { idempotencyKey: write.idempotencyKey, status: "succeeded", effectKind: "workspace_change",
    evidence: [{ id: "changed-reference", kind: "mutation", target: asmdef, version }] });
  const [verify] = runtime.decideNextCommands(aggregate, { checkUnityCompilation: true });
  assert.ok(verify?.payload.runtimeOwnedUnityCompile);
  apply("command.scheduled", { command: verify });
  apply("tool.completed", { idempotencyKey: verify.idempotencyKey, status: "failed", evidence: [], modelContent: JSON.stringify({
    status: "failed", kind: "csharp", editor: "connected", projectRoot: ".", editorPid, editorVersion, targets: [{ path: asmdef, version }],
    diagnostics: [{ file: path, line: 2, column: 13, code: "CS0234", message: "InputSystem does not exist in the namespace Unity" }],
  }) });
  const [inspectAfter] = runtime.decideNextCommands(aggregate, { checkUnityCompilation: true });
  assert.ok(inspectAfter?.payload.runtimeOwnedUnityAssemblyDiagnosis);
  references = [{ reference: declaration.name, status: "resolved", resolved: declaration }];
  apply("command.scheduled", { command: inspectAfter });
  const reportAfter = await port.execute({ command: inspectAfter, signal });
  apply("tool.completed", reportAfter);
  const newGuide = runtimeV2ExecutionEditorGuidance(aggregate, new Set()).instruction;
  assert.match(newGuide, /Preserve the verified C# namespace "UnityEngine\.InputSystem" in source imports/);
  assert.match(newGuide, /InputSystem does not exist in the namespace Unity/);
  assert.doesNotMatch(newGuide, /has missing reference/);
  const changedPackage = JSON.parse(reportAfter.modelContent);
  changedPackage.sources[0].assembly.references[0].resolved.version = `sha256-${"b".repeat(64)}`;
  const stale = runtime.replayRuntimeV2Events(aggregate.events.map(event => event.idempotencyKey === reportAfter.idempotencyKey &&
    event.type === "tool.completed" ? { ...event, modelContent: JSON.stringify(changedPackage) } : event));
  assert.doesNotMatch(runtimeV2ExecutionEditorGuidance(stale, new Set()).instruction, /Preserve the verified C# namespace/);
});

test("Unity mutation preparation rejects a newly introduced predefined assembly before review", async (t) => {
  const { prepareRuntimeV2Mutation } = loadTs("src/store/runtimeV2/executionMutationPreflight.ts");
  const ports = portsFor(stateForMcp([], {}));
  const workspace = ports.context.runWorkspace;
  const target = "Assets/Physics/Interactions.asmdef";
  const run = { sessionKey: "session-mcp", sessionEpoch: "epoch-mcp", turnId: "turn-mcp",
    runId: "run-assembly-edit", parentRunId: null, attemptId: "attempt-assembly-edit" };
  ports.context.projectBaselineContext = { kind: "project_baseline_context", workspace: { canonicalPath: workspace },
    facts: { runtimes: [{ name: "unity", version: "6000.6.5f1", provenance: { path: "ProjectSettings/ProjectVersion.txt" } }] } };
  const invokeCalls = [];
  const before = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (name, args) => {
    invokeCalls.push({ name, args });
    assert.equal(name, "read_file");
    return '{"name":"Interactions","references":[]}';
  } } };
  t.after(() => { globalThis.window = before; });
  const args = { path: target, content: '{"name":"Interactions","references":["Assembly-CSharp"]}' };
  const prepared = await prepareRuntimeV2Mutation({ ports, command: { kind: "execute_tool", phase: "acting", run,
    idempotencyKey: "write-assembly", payload: { toolName: "write_file", arguments: args } },
  toolName: "write_file", args, target, failureContextTarget: target, toolExecutionOptions: {} });
  assert.equal(prepared.allowed, false);
  assert.equal(prepared.completion.failureKind, "mutation_rejected");
  assert.equal(prepared.completion.failureReasonCode, "mutation_preflight_unity_predefined_assembly_reference");
  assert.match(prepared.completion.presentation.message, /Assembly-CSharp/);
  assert.deepEqual(invokeCalls, [{ name: "read_file", args: { path: target, workspace } }]);
});

test("Execute advertises the CLI Console with MCP disabled and records the bound evidence", async (t) => {
  const { bindWorkspaceUnityCliConsole, resolveWorkspaceMcpView } = loadTs("src/lib/workspaceMcp.ts");
  const state = stateForMcp([], {}, { currentTurnExecutionConsent: { turnId: "turn-mcp", granted: true } });
  state.mcpServers[0].enabled = false;
  const ports = portsFor(state);
  const workspace = ports.context.runWorkspace;
  const editorVersion = "6000.6.5f1";
  const editorPid = 30663;
  ports.context.workspaceMcpSnapshot = await bindWorkspaceUnityCliConsole(resolveWorkspaceMcpView({
    workspace, manualServers: state.mcpServers, manualTools: [], manualToolServerMap: {},
  }), editorVersion, async () => ({ editorPid, editorVersion }));
  const surface = authorizationContext.providerToolDefinitionsForCommand(ports, {
    kind: "request_model", payload: { mode: "execute" },
  }).map(tool => tool.function.name);
  assert.ok(surface.includes("unity_cli_console"));
  assert.ok(!surface.includes("unity_mcp_console"));

  const originalWindow = globalThis.window;
  const calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    return pipelineConsole;
  } } };
  t.after(() => { globalThis.window = originalWindow; });
  const toolPort = executionToolPort.createRuntimeV2ToolPort(ports);
  const run = { sessionKey: "session-mcp", sessionEpoch: "epoch-mcp", turnId: "turn-mcp",
    runId: "run-cli-console", parentRunId: null, attemptId: "attempt-cli-console" };
  const completion = await toolPort.execute({
    command: { kind: "execute_tool", phase: "observing", run, idempotencyKey: "console",
      payload: { toolName: "unity_cli_console", toolCallId: "read-console", arguments: {} } },
    signal: new AbortController().signal,
  });
  assert.equal(completion.status, "succeeded", completion.failureReasonCode);
  assert.equal(completion.effectKind, "observation");
  assert.deepEqual(completion.editorConsole, {
    instanceId: "unity-cli:30663", editorVersion, editorPid, ...pipelineEvidence,
  });
  const options = { workspaceMcpSnapshot: ports.context.workspaceMcpSnapshot };
  await assert.rejects(toolExecutor.executeTool("unity_cli_console", { action: "clear" }, workspace, run.sessionKey, options), /SCOPE_MISMATCH/);
  await assert.rejects(toolExecutor.executeTool("unity_cli_console", {}, "/another-workspace", run.sessionKey, options), /SCOPE_MISMATCH/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "unity_cli_console");
  assert.deepEqual([calls[0].args.workspace, calls[0].args.editorVersion, calls[0].args.expectedPid], [workspace, editorVersion, editorPid]);
});

test("Unity Official MCP and a manual HTTP server keep separate tool identities and Console receipts", async (t) => {
  const { bindWorkspaceUnityCliConsole, bindWorkspaceUnityOfficialMcp, resolveWorkspaceMcpView } = loadTs("src/lib/workspaceMcp.ts");
  const manual = mcpTool("console", "List device Console output");
  const state = stateForMcp([manual], { console: manual._mainMcpOrigin.serverUrl });
  state.config.unityOfficialMcpEnabled = true;
  const ports = portsFor(state);
  const workspace = ports.context.runWorkspace;
  const editorVersion = "6000.6.5f1";
  const calls = [];
  let officialFailure = "";
  let officialPid = 30663;
  const originalWindow = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "unity_cli_console") return { editorPid: officialPid, editorVersion };
    if (!args.call) return { editorPid: officialPid, tools: [mcpTool("console", "Read or clear Unity Console")] };
    if (officialFailure) return { structuredContent: { success: false, message: officialFailure } };
    if (args.expectedPid !== officialPid) throw new Error("UNITY_OFFICIAL_MCP_EDITOR_UNAVAILABLE");
    if (!args.consoleObservation) return { content: [{ type: "text", text: "official status" }] };
    return { structuredContent: pipelineConsole };
  } } };
  t.after(() => { globalThis.window = originalWindow; });
  const snapshot = await bindWorkspaceUnityOfficialMcp(resolveWorkspaceMcpView({
    workspace, manualServers: state.mcpServers, manualTools: state.mcpDiscoveredTools, manualToolServerMap: state.mcpToolServerMap,
  }), editorVersion, new AbortController().signal);
  ports.context.workspaceMcpSnapshot = await bindWorkspaceUnityCliConsole(snapshot, editorVersion, () => assert.fail("Unneeded CLI probe"));
  assert.equal(ports.context.workspaceMcpSnapshot, snapshot);
  assert.deepEqual(snapshot.mcpServers.map(server => server.type), ["http", "stdio"]);
  const catalog = authorizationContext.authorizationFor(ports).toolCatalog;
  const official = catalog.entries.find(entry => entry.mcpTool?._mainMcpOrigin?.connector === "unity_official");
  assert.equal(catalog.lookup("console").status, "ambiguous");
  assert.ok(official);

  const run = { sessionKey: "session-mcp", sessionEpoch: "epoch-mcp", turnId: "turn-mcp", runId: "run-official-console",
    parentRunId: null, attemptId: "attempt-official-console" };
  assert.equal(authorizationContext.runtimeV2ToolVisibleToProvider(ports, official.exposedName), true);
  const repair = runtime.transition(null, {
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: 0, eventId: "console-repair", at: 1,
    type: "turn.admitted", turn: { workspaceKey: workspace, sessionKey: run.sessionKey, sessionEpoch: run.sessionEpoch,
      clientSubmissionId: "console-repair-submission", turnId: run.turnId }, strategy: "execute", objective: "修复console窗口的错误",
    constraints: [], acceptanceCriteria: [], completionRequirement: { kind: "workspace_change", editorDiagnostics: true },
  });
  state.runtimeV2Checkpoints[run.turnId] = runtime.createRuntimeV2Checkpoint({ revision: 1, aggregate: repair, updatedAt: repair.updatedAt });
  const repairTools = authorizationContext.providerToolDefinitionsForCommand(ports, { kind: "request_model", payload: { mode: "execute" } })
    .map(tool => tool.function.name);
  assert.ok(repairTools.includes("unity_official_mcp_console"));
  assert.ok(!repairTools.includes(official.exposedName), "the unbound Console alias cannot replace typed repair evidence");
  assert.equal(authorizationContext.runtimeV2ToolVisibleToProvider(ports, official.exposedName), false);
  state.runtimeV2Checkpoints = {};
  const toolPort = executionToolPort.createRuntimeV2ToolPort(ports);
  const call = {
    command: { kind: "execute_tool", phase: "observing", run, idempotencyKey: "official-console",
      payload: { toolName: "unity_official_mcp_console", toolCallId: "read-console", arguments: {} } },
    signal: new AbortController().signal,
  };
  const completion = await toolPort.execute(call);
  assert.equal(completion.status, "succeeded", completion.failureReasonCode);
  assert.equal(completion.effectKind, "observation");
  assert.deepEqual(completion.editorConsole, {
    instanceId: "unity-official-mcp:30663", editorVersion, editorPid: 30663, ...pipelineEvidence,
  });
  assert.deepEqual(calls[1].args.call, { name: "console", arguments: { command: "get", args: { tail: 100, level: "warn" } } });
  assert.deepEqual([calls[1].args.workspace, calls[1].args.editorVersion, calls[1].args.expectedPid], [workspace, editorVersion, 30663]);
  const options = { toolCatalog: catalog, workspaceMcpSnapshot: snapshot };
  await assert.rejects(toolExecutor.executeTool("unity_official_mcp_console", { command: "clear" }, workspace, run.sessionKey, options), /SCOPE_MISMATCH/);
  await assert.rejects(toolExecutor.executeTool(official.exposedName, { command: "status" }, "/other", run.sessionKey, options), /SCOPE_MISMATCH/);
  await assert.rejects(toolExecutor.executeTool(official.exposedName, { command: "status" }, workspace, run.sessionKey,
    { ...options, isUnityOfficialMcpEnabled: () => false }), /OFFICIAL_MCP_DISABLED/);
  assert.equal(await toolExecutor.executeTool(official.exposedName, { command: "status" }, workspace, run.sessionKey, options), "official status");
  assert.equal(calls.length, 3);

  officialPid = 30664;
  const restarted = await toolPort.execute({ ...call, command: { ...call.command, idempotencyKey: "old-pid-console" } });
  assert.equal(restarted.status, "failed");
  assert.equal(calls.at(-1).command, "unity_official_mcp");
  assert.equal(calls.at(-1).args.workspace, workspace);
  assert.equal(calls.at(-1).args.call, undefined, "a stale invocation can only rediscover, not retry against another Editor");
  const afterRestart = await toolPort.execute({ ...call, command: { ...call.command, idempotencyKey: "new-pid-console" } });
  assert.equal(afterRestart.editorConsole.editorPid, officialPid);
  assert.equal(calls.at(-1).args.expectedPid, officialPid);

  officialFailure = "MCP returned an unverified Console result";
  const failed = await toolPort.execute({ ...call, command: { ...call.command, idempotencyKey: "closed-console" } });
  assert.equal(failed.status, "failed");
  const surface = authorizationContext.providerToolDefinitionsForCommand(ports, {
    kind: "request_model", payload: { mode: "execute" },
  }).map(tool => tool.function.name);
  assert.ok(surface.includes("unity_cli_console"));
  assert.ok(!surface.includes("unity_official_mcp_console"));
  assert.equal(calls.at(-1).command, "unity_cli_console");
  assert.ok(snapshot.unityOfficialMcp);
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
