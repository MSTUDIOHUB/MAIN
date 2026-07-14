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
const modelLanes = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/modelLaneCoordinator.ts"));
const subagentRuntime = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/subagentRuntime.ts"));
const subagentJoinRuntime = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/subagentJoinRuntime.ts"));
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

test("subagent allowed paths preserve execution casing while deduplicating identities", () => {
  assert.deepEqual(subagents.parseSubagentAllowedPaths(
    "src/hooks/useCsvParser.ts,./src/hooks/usecsvparser.ts,src/store/DashboardStore.ts",
    "/workspace",
  ), [
    "src/hooks/useCsvParser.ts",
    "src/store/DashboardStore.ts",
  ]);
});

test("capacity policy permits two local children and bounded cloud parallelism", () => {
  const local = subagents.resolveSubagentCapacityPolicy(makeConfig("local"));
  assert.equal(local.profile, "local");
  assert.equal(local.maxActiveRequests, 2);
  assert.equal(local.maxBurstActiveRequests, 3);
  assert.equal(local.maxCreatedPerTurn, 3);
  assert.equal(local.model, "qwen3.6-35b-a3b");

  const cloud = subagents.resolveSubagentCapacityPolicy(makeConfig("cloud", {
    cloudServers: [{ id: "primary", provider: "OpenAI", model: "gpt-cloud" }],
    activeCloudServerId: "primary",
  }));
  assert.equal(cloud.profile, "cloud");
  assert.equal(cloud.maxActiveRequests, 3);
  assert.equal(cloud.maxBurstActiveRequests, 3);
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

  const dismissed = [
    ...events,
    turnEvents.withEventSchema({
      type: "subagent.dismissed",
      threadId: "thread-1",
      turnId: "turn-1",
      timestampMs: 22,
      subagentId: "subagent-1",
    }),
  ];
  assert.deepEqual(subagents.projectSubagentRuns(dismissed), []);
});

test("session restore reconciles active records that have no live controller", () => {
  subagents.resetSubagentRuntimeForTests();
  const events = [turnEvents.withEventSchema({
    type: "subagent.created",
    threadId: "thread-restore",
    turnId: "turn-old",
    timestampMs: 10,
    subagent: {
      id: "subagent-orphan",
      parentTurnId: "turn-old",
      threadId: "thread-restore",
      name: "Euler",
      role: "explorer",
      objective: "Inspect stale state",
      status: "running",
      profile: "local",
      provider: "OMLX",
      model: "qwen",
      createdAt: 10,
      updatedAt: 10,
    },
  })];

  const reconciled = subagents.reconcileOrphanedSubagentEvents(events, 50);
  const [run] = subagents.projectSubagentRuns(reconciled);
  assert.equal(run.status, "canceled");
  assert.equal(run.completedAt, 50);
  assert.equal(run.closedAt, 50);
  assert.match(run.error, /SUBAGENT_ORPHANED_AFTER_RESTART/);
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

test("a queued third local child starts only after two safe model-overlap samples", async () => {
  subagents.resetSubagentRuntimeForTests();
  modelLanes.resetModelLaneCoordinatorForTests();
  modelLanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: 24,
    total_bytes: 64 * 1024 ** 3,
    available_bytes: 24 * 1024 ** 3,
  }));
  const policy = subagents.resolveSubagentCapacityPolicy(makeConfig("local"));
  let active = 0;
  let maxActive = 0;
  let releaseTasks;
  const taskGate = new Promise((resolve) => { releaseTasks = resolve; });
  let resolveThirdStarted;
  const thirdStarted = new Promise((resolve) => { resolveThirdStarted = resolve; });
  const tasks = Promise.all([0, 1, 2].map(() => subagents.withSubagentCapacity({
    policy,
    task: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 3) resolveThirdStarted();
      await taskGate;
      active -= 1;
    },
  })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(active, 2);

  const firstModel = await modelLanes.acquireModelLane({
    config: makeConfig("local"),
    agentKind: "subagent",
    subagentId: "subagent-health-1",
  });
  firstModel.markFirstToken();
  const secondModel = await modelLanes.acquireModelLane({
    config: makeConfig("local"),
    agentKind: "subagent",
    subagentId: "subagent-health-2",
  });
  secondModel.markFirstToken();
  await modelLanes.sampleModelLaneMemoryForTests(policy.laneKey);
  await modelLanes.sampleModelLaneMemoryForTests(policy.laneKey);
  assert.equal(subagents.getSubagentBurstAdmission(policy).allowed, true);
  await Promise.race([
    thirdStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("elastic child was not admitted")), 2_000)),
  ]);
  assert.equal(maxActive, 3);

  releaseTasks();
  await tasks;
  secondModel.release();
  firstModel.release();
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
  assert.deepEqual(subagents.getPendingCoordinatedSubagentIds("thread-async", "turn-async"), []);
  assert.equal(subagents.getCoordinatedSubagentRunCount("thread-async", "turn-async"), 1);
});

test("parent finalization cancels live children and releases coordinator state", async () => {
  subagents.resetSubagentRuntimeForTests();
  const controller = new AbortController();
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  controller.signal.addEventListener("abort", () => resolveCompletion({
    subagentId: "subagent-finalize",
    name: "Euler",
    scopeKey: "runtime",
    status: "canceled",
    summary: "Partial evidence retained.",
    evidence: [],
  }), { once: true });
  subagents.registerSubagentAbortController("subagent-finalize", controller);
  subagents.registerCoordinatedSubagentRun({
    threadId: "thread-finalize",
    parentTurnId: "turn-finalize",
    subagentId: "subagent-finalize",
    name: "Euler",
    scopeKey: "runtime",
    completion,
  });

  const result = await subagents.finalizeCoordinatedSubagentsForParent({
    threadId: "thread-finalize",
    parentTurnId: "turn-finalize",
    graceMs: 100,
  });
  subagents.unregisterSubagentAbortController("subagent-finalize");
  assert.deepEqual(result.requestedIds, ["subagent-finalize"]);
  assert.deepEqual(result.canceledIds, ["subagent-finalize"]);
  assert.deepEqual(result.settledIds, ["subagent-finalize"]);
  assert.deepEqual(result.timedOutIds, []);
  assert.equal(result.releasedCount, 1);
  assert.equal(subagents.getCoordinatedSubagentRunCount("thread-finalize", "turn-finalize"), 0);
});

test("completed child remains joinable until the parent consumes its result", async () => {
  subagents.resetSubagentRuntimeForTests();
  const completion = Promise.resolve({
    subagentId: "subagent-ready",
    name: "Mendel",
    scopeKey: "ready-result",
    status: "completed",
    summary: "Ready before the parent reached its join boundary.",
    evidence: [],
  });
  subagents.registerCoordinatedSubagentRun({
    threadId: "thread-ready",
    parentTurnId: "turn-ready",
    subagentId: "subagent-ready",
    name: "Mendel",
    scopeKey: "ready-result",
    completion,
  });
  await completion;
  await Promise.resolve();

  assert.deepEqual(
    subagents.getPendingCoordinatedSubagentIds("thread-ready", "turn-ready"),
    ["subagent-ready"],
  );
  const joined = await subagents.waitForCoordinatedSubagents({
    threadId: "thread-ready",
    parentTurnId: "turn-ready",
  });
  assert.equal(joined.results[0].status, "completed");
  assert.deepEqual(subagents.getPendingCoordinatedSubagentIds("thread-ready", "turn-ready"), []);
});

test("runtime parent join injects structured child evidence before finalization", async () => {
  const messages = [];
  const events = [];
  const recent = [];
  const recentPlan = [];
  const joined = await subagentJoinRuntime.joinPendingSubagentsForParent({
    callbacks: {
      getPendingSubagentIds: () => ["subagent-euler", "subagent-mendel"],
      waitSubagents: async () => ({
        pendingIds: [],
        results: [{
          subagentId: "subagent-euler",
          name: "Euler",
          scopeKey: "events",
          status: "completed",
          summary: "Found the event boundary.",
          evidence: [{ tool: "read_file", target: "src/lib/turnEvents.ts", detail: "Versioned events." }],
        }],
      }),
      getPreferredLanguage: () => "en",
      appendMessage: (message) => messages.push(message),
      onDebugEvent: (event, data) => events.push({ event, data }),
    },
    recentToolActivity: recent,
    recentPlanToolActivity: recentPlan,
    reason: "parent_final_response",
  });

  assert.equal(joined, true);
  assert.match(messages[0].content, /SUBAGENT_JOIN_RESULT/);
  assert.deepEqual(recent.map((entry) => [entry.name, entry.target]), [["read_file", "src/lib/turnEvents.ts"]]);
  assert.deepEqual(recentPlan, recent);
  assert.deepEqual(events.map((entry) => entry.event), ["parent_join_required", "parent_join_injected"]);
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

test("iteration boundary with evidence is a blocked partial result, not a failure", async () => {
  subagents.resetSubagentRuntimeForTests();
  const traceEvents = [];
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      objective: "Inspect a bounded file",
      scopeKey: "bounded-file",
      scope: "One file",
      allowedPaths: "src/lib/subagents.ts",
      expectedOutput: "Partial evidence",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-boundary",
      getMessages: () => [],
      onDebugEvent: (event, data) => traceEvents.push({ event, data }),
    },
    parentTurnId: "turn-boundary",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      childCallbacks.onToolDone("read_file", "src/lib/subagents.ts", "Coordinator evidence");
      childCallbacks.onAssistantFinalText("The coordinator retains a bounded partial result.");
      childCallbacks.onNonActionableStop("Iteration boundary reached.", "no_action", {
        recoveryReason: "max_iterations_boundary",
      });
      return { status: "stopped_no_action", reason: "max_iterations_boundary" };
    },
  });

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /bounded partial result/);
  assert.equal(result.evidence.length, 1);
  assert.ok(traceEvents.some((entry) => entry.event === "subagent_partial_result_preserved"));
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
  assert.equal(subagents.findSubagentLeaseOverlap({
    threadId: "thread-scope",
    workspace: "/workspace",
    allowedPaths: ["src/lib"],
  })?.subagentId, "subagent-scope");
  assert.equal(subagents.findSubagentLeaseOverlap({
    threadId: "thread-scope",
    workspace: "/workspace",
    allowedPaths: ["src/components"],
  }), null);
});

test("subagent source contracts keep children read-only and UI activity clickable", () => {
  const registrySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolRegistrySetup.ts"), "utf8");
  const partitionSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"), "utf8");
  const chatSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ChatArea.tsx"), "utf8");
  const panelSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/RightPanel.tsx"), "utf8");
  const schemaSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/toolSchemas.ts"), "utf8");
  const workflowSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(registrySource, /subagentDepth > 0/);
  assert.match(registrySource, /childToolNames = new Set\(\[/);
  for (const toolName of [
    "read_file",
    "grep_search",
    "get_file_outline",
    "code_ast_query",
    "find_symbol_references",
    "git_status",
    "git_diff",
  ]) {
    assert.match(registrySource, new RegExp(`"${toolName}"`));
  }
  assert.match(registrySource, /mcpServers\.length > 0 && subagentDepth === 0/);
  assert.match(partitionSource, /never reuse the[\s\S]*read-only result cache for subagents/);
  assert.match(chatSource, /data-testid="subagent-activity-notice"/);
  assert.match(chatSource, /openSubagentsPanel/);
  assert.match(panelSource, /rightPanelTab === "subagents"/);
  assert.match(panelSource, /<SubagentsPanel/);
  assert.match(schemaSource, /name: "spawn_subagent"/);
  assert.match(schemaSource, /name: "wait_subagents"/);
  assert.match(workflowSource, /run\.parentTurnId !== currentParentTurnId/);
  assert.match(workflowSource, /return prepareSubagentsForNewTurn\(\)\.then\(executeLoopStrategy\)/);
  assert.match(workflowSource, /subagent_new_turn_preflight/);
  const debugLogSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/debugLog.ts"), "utf8");
  assert.match(debugLogSource, /source === "agent\.iteration_start"/);
  assert.match(debugLogSource, /source === "agent\.context_pack_built"/);
  assert.match(debugLogSource, /source === "agent\.stream_low_content_diagnostic"/);
});
