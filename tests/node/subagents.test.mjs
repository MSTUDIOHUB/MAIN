import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) return transpiledModuleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (fsSync.existsSync(candidate) && /\.tsx?$/.test(candidate)) return loadTranspiledModuleSync(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const subagents = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/subagents.ts"));
const subagentRuntime = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/subagentRuntime.ts"));
const turnEvents = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnEvents.ts"));

function makeConfig(profile, overrides = {}) {
  return {
    activeProfile: profile,
    language: "zh",
    local: {
      provider: "OMLX",
      endpoint: "http://127.0.0.1:8000/v1",
      model: "qwen3.6-35b-a3b",
      contextLimit: 32768,
      apiKey: "",
      toolProtocol: "auto",
    },
    cloud: {
      provider: "OpenAI",
      model: "gpt-test",
      protocol: "openai",
      apiFormat: "chat_completions",
      toolProtocol: "auto",
      auth: { mode: "api_key", status: "disconnected" },
    },
    cloudServers: [],
    activeCloudServerId: "",
    workspace: "/workspace",
    ...overrides,
  };
}

test("capacity policy permits two local children and bounded cloud parallelism", () => {
  const local = subagents.resolveSubagentCapacityPolicy(makeConfig("local"));
  assert.equal(local.profile, "local");
  assert.equal(local.maxActiveRequests, 2);
  assert.equal(local.maxCreatedPerTurn, 3);
  assert.equal(local.model, "qwen3.6-35b-a3b");

  const cloud = subagents.resolveSubagentCapacityPolicy(makeConfig("cloud", {
    cloudServers: [{ id: "primary", provider: "OpenAI", model: "gpt-cloud" }],
    activeCloudServerId: "primary",
  }));
  assert.equal(cloud.profile, "cloud");
  assert.equal(cloud.maxActiveRequests, 3);
  assert.equal(cloud.maxCreatedPerTurn, 6);
  assert.equal(cloud.model, "gpt-cloud");
});

test("runtime event projection preserves completion while recording thread closure", () => {
  const base = {
    id: "subagent-1",
    parentTurnId: "turn-1",
    threadId: "thread-1",
    name: "Euler",
    role: "explorer",
    objective: "Trace the event path",
    status: "queued",
    profile: "local",
    provider: "OMLX",
    model: "qwen3.6-35b-a3b",
    createdAt: 10,
    updatedAt: 10,
  };
  const events = [
    turnEvents.withEventSchema({ type: "subagent.created", threadId: "thread-1", turnId: "turn-1", timestampMs: 10, subagent: base }),
    turnEvents.withEventSchema({
      type: "subagent.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      timestampMs: 20,
      subagentId: "subagent-1",
      patch: { status: "completed", completedAt: 20, updatedAt: 20, summary: "Found the event boundary." },
      activity: { id: "activity-1", timestampMs: 20, status: "completed", title: "Summary returned" },
    }),
    turnEvents.withEventSchema({ type: "subagent.closed", threadId: "thread-1", turnId: "turn-1", timestampMs: 21, subagentId: "subagent-1", closedAt: 21, reason: "completed" }),
  ];

  const [record] = subagents.projectSubagentRuns(events);
  assert.equal(record.status, "completed");
  assert.equal(record.closedAt, 21);
  assert.equal(record.summary, "Found the event boundary.");
  assert.equal(record.activities.length, 1);
  assert.deepEqual(subagents.getSubagentRunsForTurn(events, "turn-1").map((run) => run.id), ["subagent-1"]);
});

test("local capacity scheduler runs at most two child workflows at once", async () => {
  subagents.resetSubagentRuntimeForTests();
  const policy = subagents.resolveSubagentCapacityPolicy(makeConfig("local"));
  let active = 0;
  let maxActive = 0;
  const executionOrder = [];

  await Promise.all([0, 1, 2].map((index) => subagents.withSubagentCapacity({
    policy,
    task: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      executionOrder.push(`start:${index}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      executionOrder.push(`end:${index}`);
      active -= 1;
    },
  })));

  assert.equal(maxActive, 2);
  assert.deepEqual(executionOrder.slice(0, 2), ["start:0", "start:1"]);
  assert.equal(executionOrder.filter((entry) => entry.startsWith("start:")).length, 3);
  assert.equal(executionOrder.filter((entry) => entry.startsWith("end:")).length, 3);
});

test("cloud capacity scheduler caps concurrent child calls at three", async () => {
  subagents.resetSubagentRuntimeForTests();
  const policy = subagents.resolveSubagentCapacityPolicy(makeConfig("cloud"));
  let active = 0;
  let maxActive = 0;

  await Promise.all([0, 1, 2, 3, 4].map(() => subagents.withSubagentCapacity({
    policy,
    task: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
    },
  })));

  assert.equal(maxActive, 3);
});

test("controlled child runtime isolates messages and returns its summary through events", async () => {
  subagents.resetSubagentRuntimeForTests();
  const events = [];
  const parentMessages = [{ role: "user", content: "private parent transcript" }];
  const traceEvents = [];
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      name: "Euler",
      role: "explorer",
      objective: "Inspect the event boundary",
      contextHints: "Start with src/lib/turnEvents.ts",
      scopeKey: "turn-events",
      scope: "Inspect only the turn event contract",
      allowedPaths: "src/lib/turnEvents.ts",
      expectedOutput: "Evidence summary",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-1",
      getMessages: () => parentMessages,
      getCurrentRunIdentity: () => ({ runId: "run-parent", parentRunId: null }),
      onDebugEvent: (event, data) => traceEvents.push({ event, data }),
    },
    parentTurnId: "turn-1",
    existingRunCount: 0,
    emitEvent: (event) => events.push(event),
    executeAgentLoop: async (childCallbacks) => {
      assert.equal(childCallbacks.getSubagentDepth(), 1);
      assert.equal(childCallbacks.getCurrentRunIntent(), "analyze");
      assert.equal(childCallbacks.getMessages().length, 1);
      assert.notEqual(childCallbacks.getMessages(), parentMessages);
      assert.match(childCallbacks.getMessages()[0].content, /bounded read-only subagent/);
      assert.notEqual(childCallbacks.getCurrentRunIdentity().runId, "run-parent");
      assert.equal(childCallbacks.getCurrentRunIdentity().parentRunId, "run-parent");
      childCallbacks.onDebugEvent("child_trace_probe", {});
      childCallbacks.onToolExecuting("read_file", "src/lib/turnEvents.ts");
      childCallbacks.onToolDone("read_file", "src/lib/turnEvents.ts", "event schema");
      childCallbacks.onAssistantFinalText("The event boundary is versioned and durable.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.summary, "The event boundary is versioned and durable.");
  assert.deepEqual(events.map((event) => event.type).filter((type, index, all) => index === 0 || type !== all[index - 1]), [
    "subagent.created",
    "subagent.updated",
    "subagent.closed",
  ]);
  const [record] = subagents.projectSubagentRuns(events);
  assert.equal(record.status, "completed");
  assert.equal(record.activities.filter((activity) => activity.status === "completed").length, 2);
  assert.equal(traceEvents[0].data.agentKind, "subagent");
  assert.equal(traceEvents[0].data.parentRunId, "run-parent");
  assert.match(traceEvents[0].data.runId, /^run-subagent-/);
  assert.ok(traceEvents.some((entry) => entry.event === "subagent_queued"));
  assert.ok(traceEvents.some((entry) => entry.event === "subagent_started"));
  assert.ok(traceEvents.some((entry) => entry.event === "subagent_finished"));
  assert.ok(traceEvents.every((entry) =>
    entry.data.runId === result.subagentId.replace(/^subagent-/, "run-subagent-")
  ));
});

test("async spawn returns a handle before completion and wait preserves structured results", async () => {
  subagents.resetSubagentRuntimeForTests();
  const events = [];
  let releaseChild;
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  const parentCallbacks = {
    getConfig: () => makeConfig("local"),
    getPreferredLanguage: () => "en",
    getSessionKey: () => "thread-async",
    getMessages: () => [{ role: "user", content: "parent" }],
  };
  const handle = subagentRuntime.scheduleControlledSubagent({
    request: {
      name: "Euler",
      role: "explorer",
      objective: "Inspect turn event persistence",
      scopeKey: "turn-events",
      scope: "Turn event persistence only",
      allowedPaths: "src/lib/turnEvents.ts",
      expectedOutput: "Path-backed summary",
    },
    parentCallbacks,
    parentTurnId: "turn-async",
    existingRunCount: 0,
    emitEvent: (event) => events.push(event),
    executeAgentLoop: async (childCallbacks) => {
      await childGate;
      childCallbacks.onToolDone("read_file", "src/lib/turnEvents.ts", "versioned events");
      childCallbacks.onAssistantFinalText("Turn events are versioned and persisted.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });
  assert.equal(handle.status, "queued");
  assert.equal(handle.scopeKey, "turn-events");
  assert.equal(events.some((event) => event.type === "subagent.closed"), false);

  const waiting = subagents.waitForCoordinatedSubagents({
    threadId: "thread-async",
    parentTurnId: "turn-async",
    subagentIds: [handle.subagentId],
  });
  releaseChild();
  const joined = await waiting;
  assert.equal(joined.results[0].status, "completed");
  assert.match(joined.results[0].summary, /versioned and persisted/);
  assert.equal(joined.results[0].evidence[0].target, "src/lib/turnEvents.ts");
});

test("blocked child results preserve their useful summary instead of becoming tool errors", async () => {
  subagents.resetSubagentRuntimeForTests();
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      objective: "Inspect a bounded blocker",
      scopeKey: "blocker",
      scope: "One file",
      allowedPaths: "src/lib/subagents.ts",
      expectedOutput: "Partial evidence",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-blocked",
      getMessages: () => [],
    },
    parentTurnId: "turn-blocked",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      childCallbacks.onToolDone("read_file", "src/lib/subagents.ts", "lease registry located");
      childCallbacks.onAssistantFinalText("The lease registry is usable evidence.", [
        { label: "Approve", value: "approve" },
      ], { awaitingInput: true });
      return { status: "paused", reason: "awaiting_user_choice" };
    },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.summary, /usable evidence/);
  assert.equal(result.evidence.length, 1);
});

test("scope leases reject child escape and parent overlap", () => {
  subagents.resetSubagentRuntimeForTests();
  subagents.acquireSubagentScopeLease({
    threadId: "thread-scope",
    parentTurnId: "turn-scope",
    subagentId: "subagent-scope",
    scopeKey: "runtime",
    workspace: "/workspace",
    allowedPaths: ["src/lib/subagents.ts"],
    createdAt: Date.now(),
  });
  const scope = {
    subagentId: "subagent-scope",
    parentSessionKey: "thread-scope",
    scopeKey: "runtime",
    workspace: "/workspace",
    allowedPaths: ["src/lib/subagents.ts"],
  };
  assert.equal(subagents.validateSubagentScopeTarget(scope, "/workspace/src/lib/subagents.ts"), true);
  assert.equal(subagents.validateSubagentScopeTarget(scope, "src/lib/orchestrator.ts"), false);
  assert.equal(subagents.findSubagentScopeConflict({
    threadId: "thread-scope",
    targetPath: "/workspace/src/lib/subagents.ts",
  })?.subagentId, "subagent-scope");
  assert.equal(subagents.findSubagentScopeConflict({
    threadId: "thread-scope",
    targetPath: "src",
  })?.subagentId, "subagent-scope");
  assert.equal(subagents.findSubagentScopeConflict({
    threadId: "thread-scope",
    targetPath: ".",
  })?.subagentId, "subagent-scope");
});

test("subagent source contracts keep children read-only and UI activity clickable", () => {
  const registrySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolRegistrySetup.ts"), "utf8");
  const partitionSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"), "utf8");
  const chatSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ChatArea.tsx"), "utf8");
  const panelSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/RightPanel.tsx"), "utf8");
  const schemaSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/toolSchemas.ts"), "utf8");

  assert.match(registrySource, /subagentDepth > 0/);
  assert.match(registrySource, /childToolNames = new Set\(\["read_file", "grep_search", "get_file_outline"\]\)/);
  assert.match(registrySource, /mcpServers\.length > 0 && subagentDepth === 0/);
  assert.match(partitionSource, /never reuse the[\s\S]*read-only result cache for subagents/);
  assert.match(chatSource, /data-testid="subagent-activity-notice"/);
  assert.match(chatSource, /openSubagentsPanel/);
  assert.match(panelSource, /rightPanelTab === "subagents"/);
  assert.match(panelSource, /<SubagentsPanel/);
  assert.match(schemaSource, /name: "spawn_subagent"/);
  assert.match(schemaSource, /name: "wait_subagents"/);
});
