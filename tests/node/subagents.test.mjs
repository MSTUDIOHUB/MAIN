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
    ...overrides,
  };
}

test("capacity policy serializes local models and permits bounded cloud parallelism", () => {
  const local = subagents.resolveSubagentCapacityPolicy(makeConfig("local"));
  assert.equal(local.profile, "local");
  assert.equal(local.maxActiveRequests, 1);
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

test("local capacity scheduler never runs two child model calls at once", async () => {
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

  assert.equal(maxActive, 1);
  assert.deepEqual(executionOrder, ["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]);
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
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      name: "Euler",
      role: "explorer",
      objective: "Inspect the event boundary",
      contextHints: "Start with src/lib/turnEvents.ts",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-1",
      getMessages: () => parentMessages,
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
});

test("subagent source contracts keep children read-only and UI activity clickable", () => {
  const registrySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolRegistrySetup.ts"), "utf8");
  const partitionSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"), "utf8");
  const chatSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ChatArea.tsx"), "utf8");
  const panelSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/RightPanel.tsx"), "utf8");
  const schemaSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/toolSchemas.ts"), "utf8");

  assert.match(registrySource, /subagentDepth > 0/);
  assert.match(registrySource, /risk === "read_only" \|\| risk === "external_read"/);
  assert.match(registrySource, /tool\.function\.name === "spawn_subagent"/);
  assert.match(partitionSource, /never reuse the[\s\S]*read-only result cache for subagents/);
  assert.match(chatSource, /data-testid="subagent-activity-notice"/);
  assert.match(chatSource, /openSubagentsPanel/);
  assert.match(panelSource, /rightPanelTab === "subagents"/);
  assert.match(panelSource, /<SubagentsPanel/);
  assert.match(schemaSource, /name: "spawn_subagent"/);
});
