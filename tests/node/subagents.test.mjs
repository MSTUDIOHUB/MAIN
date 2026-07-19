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
const toolActivityTracking = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolActivityTracking.ts"));
const planMaterialization = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planMaterialization.ts"));
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

let observedToolSequence = 0;
function recordChildToolResult(callbacks, tool, target, content, options = {}) {
  const toolCallId = options.toolCallId || `child-tool-${++observedToolSequence}`;
  callbacks.onToolDone(tool, target, content, { toolCallId });
  callbacks.onToolResultObserved?.({
    toolCallId,
    name: tool,
    target,
    content,
    isError: false,
    ...(options.readFileObservation
      ? { readFileObservation: options.readFileObservation }
      : {}),
  });
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

test("broad read-only child searches narrow to every covered lease root without widening the lease", () => {
  const scope = {
    subagentId: "subagent-scope",
    parentSessionKey: "thread",
    scopeKey: "chart-consumer",
    workspace: "/workspace",
    allowedPaths: ["src/hooks/useChartData.ts", "src/store/dashboardStore.ts"],
    allowedFilePaths: ["src/hooks/useChartData.ts", "src/store/dashboardStore.ts"],
    allowedDirectoryPaths: [],
    scopeKind: "exact_files",
    blockedToolNames: [],
  };
  assert.deepEqual(subagents.resolveSubagentScopedReadTargets({ scope, requestedPath: "." }), {
    action: "narrow",
    requestedPath: ".",
    targets: ["src/hooks/useChartData.ts", "src/store/dashboardStore.ts"],
    reason: "root_default",
  });
  assert.deepEqual(subagents.resolveSubagentScopedReadTargets({ scope, requestedPath: "src" }), {
    action: "narrow",
    requestedPath: "src",
    targets: ["src/hooks/useChartData.ts", "src/store/dashboardStore.ts"],
    reason: "ancestor_narrowed",
  });
  assert.deepEqual(subagents.resolveSubagentScopedReadTargets({ scope, requestedPath: "other" }), {
    action: "block",
    requestedPath: "other",
    targets: [],
  });
  assert.deepEqual(subagents.resolveSubagentScopedReadTargets({ scope, requestedPath: "../outside" }), {
    action: "block",
    requestedPath: "../outside",
    targets: [],
  });
});

test("parent path evidence prevents redundant delegation across current and legacy keys", () => {
  assert.equal(subagents.countParentObservedDelegationPaths({
    allowedPaths: ["src/main.js", "src/styles"],
    evidenceKeys: new Set(["path:src/main.js", "file:src/styles/main.css"]),
  }), 2);
  assert.equal(subagents.countParentObservedDelegationPaths({
    allowedPaths: ["src/main.js"],
    evidenceKeys: new Set(["symbol:initToolbar", "path:src/editor.js"]),
  }), 0);
});

test("read-only child roles never imply workspace mutation capability", () => {
  assert.equal(subagentRuntime.resolveReadOnlySubagentRole("coder"), "investigator");
  assert.equal(subagentRuntime.resolveReadOnlySubagentRole("reviewer"), "investigator");
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

test("adaptive delegation admits only useful context or diagnostic fan-out", () => {
  const readyRuntimeHealth = {
    laneKey: "local:test",
    profile: "local",
    state: "ready",
    activeChildren: 0,
    queuedChildren: 0,
    capacityLimit: 2,
    memorySafety: "safe",
    recentSuccessfulRuns: 1,
    latestStartupMs: 120,
    latestCapacityWaitMs: 0,
  };
  const simple = subagents.resolveDelegationDecision({
    phase: "context",
    hasWorkspace: true,
    explicitScopeCount: 1,
  });
  assert.equal(simple.action, "defer");
  assert.equal(simple.reason, "insufficient_independent_scope");

  const observedOnly = subagents.resolveDelegationDecision({
    phase: "diagnostic",
    hasWorkspace: true,
    observedScopeCount: 2,
    independentScopeKeys: ["src/lib/runtime", "src/components/ChatArea.tsx"],
  });
  assert.equal(observedOnly.action, "defer");
  assert.equal(observedOnly.reason, "insufficient_independent_scope");
  assert.equal(observedOnly.observedScopeCount, 2);
  assert.equal(observedOnly.independentScopeCount, 2);

  const structuredScopes = subagents.resolveDelegationDecision({
    phase: "context",
    hasWorkspace: true,
    explicitScopeCount: 2,
    independentScopeKeys: ["src/lib/runtime", "src/components/ChatArea.tsx"],
    runtimeHealth: readyRuntimeHealth,
  });
  assert.equal(structuredScopes.action, "admit");
  assert.equal(structuredScopes.reason, "adaptive_multi_scope");

  const unknownRuntimeHealth = subagents.resolveDelegationDecision({
    phase: "context",
    hasWorkspace: true,
    explicitScopeCount: 2,
    independentScopeKeys: ["src/lib/runtime", "src/components/ChatArea.tsx"],
  });
  assert.equal(unknownRuntimeHealth.action, "defer");
  assert.equal(unknownRuntimeHealth.reason, "runtime_health_unavailable");

  const busyRuntimeHealth = subagents.resolveDelegationDecision({
    phase: "context",
    hasWorkspace: true,
    explicitScopeCount: 2,
    independentScopeKeys: ["src/lib/runtime", "src/components/ChatArea.tsx"],
    runtimeHealth: { ...readyRuntimeHealth, state: "busy", queuedChildren: 1 },
  });
  assert.equal(busyRuntimeHealth.action, "defer");
  assert.equal(busyRuntimeHealth.reason, "runtime_capacity_busy");

  const scopesAlreadyUnderDiagnosis = subagents.resolveDelegationDecision({
    phase: "diagnostic",
    hasWorkspace: true,
    explicitScopeCount: 2,
    observedScopeCount: 2,
    independentScopeKeys: ["src/lib/runtime", "src/components/ChatArea.tsx"],
  });
  assert.equal(scopesAlreadyUnderDiagnosis.action, "defer");
  assert.equal(scopesAlreadyUnderDiagnosis.reason, "insufficient_independent_scope");

  const plannedIndependentWork = subagents.resolveDelegationDecision({
    phase: "context",
    hasWorkspace: true,
    plannedWorkItemCount: 2,
    independentScopeKeys: ["src/lib/runtime", "src/components/ChatArea.tsx"],
  });
  assert.equal(plannedIndependentWork.action, "defer");
  assert.equal(plannedIndependentWork.reason, "insufficient_independent_scope");

  const preferred = subagents.resolveDelegationDecision({
    preference: "preferred",
    phase: "context",
    hasWorkspace: true,
  });
  assert.equal(preferred.action, "defer");
  assert.equal(preferred.reason, "insufficient_independent_scope");

  const preferredWithIndependentScope = subagents.resolveDelegationDecision({
    preference: "preferred",
    phase: "context",
    hasWorkspace: true,
    explicitScopeCount: 1,
    independentScopeKeys: ["src/main.js"],
    runtimeHealth: readyRuntimeHealth,
  });
  assert.equal(preferredWithIndependentScope.action, "admit");
  assert.equal(preferredWithIndependentScope.reason, "explicit_preference");

  const afterMutation = subagents.resolveDelegationDecision({
    preference: "preferred",
    phase: "mutation",
    hasWorkspace: true,
    explicitScopeCount: 4,
  });
  assert.equal(afterMutation.action, "defer");
  assert.equal(afterMutation.reason, "phase_not_eligible");

  const pendingJoin = subagents.resolveDelegationDecision({
    preference: "preferred",
    phase: "diagnostic",
    hasWorkspace: true,
    pendingSubagentCount: 1,
  });
  assert.equal(pendingJoin.action, "defer");
  assert.equal(pendingJoin.reason, "pending_subagents_require_join");

  const forbidden = subagents.resolveDelegationDecision({
    preference: "forbidden",
    phase: "context",
    hasWorkspace: true,
    explicitScopeCount: 3,
  });
  assert.equal(forbidden.action, "deny");
  assert.equal(forbidden.reason, "user_forbidden");

  const checklistOnly = subagents.resolveDelegationDecision({
    phase: "context",
    hasWorkspace: true,
    plannedWorkItemCount: 6,
  });
  assert.equal(checklistOnly.action, "defer");
  assert.equal(checklistOnly.independentScopeCount, 0);

  const overlappingHints = subagents.resolveDelegationDecision({
    phase: "diagnostic",
    hasWorkspace: true,
    independentScopeKeys: ["src/lib", "src/lib/subagents.ts", "./src/lib"],
  });
  assert.equal(overlappingHints.action, "defer");
  assert.equal(overlappingHints.independentScopeCount, 1);
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

test("Auto delegation uses observed capacity health instead of assuming a fresh lane is safe", () => {
  subagents.resetSubagentRuntimeForTests();
  const policy = subagents.resolveSubagentCapacityPolicy(makeConfig("local"));
  const unknown = subagents.getSubagentAdmissionHealth(policy);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.latestStartupMs, null);

  subagents.recordSubagentRuntimeSample({
    laneKey: policy.laneKey,
    startupMs: 240,
    capacityWaitMs: 0,
    successful: true,
  });
  const ready = subagents.getSubagentAdmissionHealth(policy);
  assert.equal(ready.state, "ready");
  assert.equal(ready.recentSuccessfulRuns, 1);
  assert.equal(ready.latestStartupMs, 240);
  assert.equal(ready.latestCapacityWaitMs, 0);

  subagents.reportSubagentCapacityFailure(policy, new Error("out of memory"));
  const degraded = subagents.getSubagentAdmissionHealth(policy);
  assert.equal(degraded.state, "degraded");
});

test("queued children reserve child scope and immediately defer overlapping parent reads", async () => {
  subagents.resetSubagentRuntimeForTests();
  const policy = subagents.resolveSubagentCapacityPolicy(makeConfig("local"));
  let releaseOccupiers;
  const occupierGate = new Promise((resolve) => { releaseOccupiers = resolve; });
  let occupiedCount = 0;
  let resolveOccupied;
  const occupied = new Promise((resolve) => { resolveOccupied = resolve; });
  const occupiers = [0, 1].map(() => subagents.withSubagentCapacity({
    policy,
    task: async () => {
      occupiedCount += 1;
      if (occupiedCount === 2) resolveOccupied();
      await occupierGate;
    },
  }));
  await occupied;

  let resolveChildLoopStarted;
  const childLoopStarted = new Promise((resolve) => { resolveChildLoopStarted = resolve; });
  let allowToolStart;
  const toolStartGate = new Promise((resolve) => { allowToolStart = resolve; });
  let resolveToolActivated;
  const toolActivated = new Promise((resolve) => { resolveToolActivated = resolve; });
  let releaseChild;
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  const completion = subagentRuntime.executeControlledSubagent({
    request: {
      name: "Noether",
      objective: "Inspect scope admission ordering",
      scopeKey: "lease-order",
      allowedPaths: "src/lib/subagents.ts",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-lease-order",
      getMessages: () => [{ role: "user", content: "parent" }],
    },
    parentTurnId: "turn-lease-order",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      resolveChildLoopStarted();
      await toolStartGate;
      childCallbacks.onToolExecuting("read_file", "src/lib/subagents.ts");
      resolveToolActivated();
      await childGate;
      recordChildToolResult(childCallbacks, "read_file", "src/lib/subagents.ts", "observed");
      childCallbacks.onAssistantFinalText("Scope ordering inspected.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.ok(subagents.findSubagentLeaseOverlap({
    threadId: "thread-lease-order",
    workspace: "/workspace",
    allowedPaths: ["src/lib/subagents.ts"],
  }));
  assert.ok(subagents.findSubagentScopeConflict({
    threadId: "thread-lease-order",
    targetPath: "src/lib/subagents.ts",
  }));

  releaseOccupiers();
  await Promise.all(occupiers);
  await childLoopStarted;
  assert.ok(subagents.findSubagentScopeConflict({
    threadId: "thread-lease-order",
    targetPath: "src/lib/subagents.ts",
  }));

  allowToolStart();
  await toolActivated;
  assert.ok(subagents.findSubagentScopeConflict({
    threadId: "thread-lease-order",
    targetPath: "src/lib/subagents.ts",
  }));

  releaseChild();
  const result = await completion;
  assert.equal(result.status, "completed");
  assert.equal(subagents.findSubagentScopeConflict({
    threadId: "thread-lease-order",
    targetPath: "src/lib/subagents.ts",
  }), null);
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
      allowedPaths: "src/lib/turnEvents.ts,vite.config.js,src/main.js",
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
      recordChildToolResult(childCallbacks, "read_file", "src/lib/turnEvents.ts", "event schema");
      recordChildToolResult(childCallbacks, "read_file", "vite.config.js", [
        "READ_FILE_RESULT",
        "path: vite.config.js",
        "---CONTENT START---",
        "import { defineConfig } from 'vite';",
        "export default defineConfig({ plugins: [] });",
        "---CONTENT END---",
      ].join("\n"));
      recordChildToolResult(childCallbacks, "read_file", "src/main.js", [
        "READ_FILE_RESULT",
        "path: src/main.js",
        "---CONTENT START---",
        "invoke('load_document');",
        "invoke('save_document');",
        "invoke('read_settings');",
        "invoke('write_settings');",
        "document.addEventListener('DOMContentLoaded', () => {",
        "  initToolbar();",
        "  initEditor();",
        "  initPreview();",
        "  initOutline();",
        "  initStatusBar();",
        "  initDragDrop();",
        "  initKeyboardShortcuts();",
        "  function localDefinition() { nestedDefinitionCall(); }",
        "  window.addEventListener('file-open', handleFileOpen);",
        "});",
        "---CONTENT END---",
      ].join("\n"));
      const laterMainWindow = [
        "READ_FILE_RESULT",
        "path: src/main.js",
        "---CONTENT START---",
        "export function initializeMarkdownToolbarWithKeyboardBindings() {}",
        "export function initializeMarkdownEditorWithPersistentDocumentState() {}",
        "export function initializeMarkdownPreviewWithSanitizedRendering() {}",
        "export function initializeDesktopFileEventsWithPayloadRouting() {}",
        "export function initializeApplicationErrorBoundaryWithDiagnostics() {}",
        "export function initializeWindowLifecycleWithCleanupHandlers() {}",
        "---CONTENT END---",
      ].join("\n");
      const finalMainWindow = [
        "READ_FILE_RESULT",
        "path: src/main.js",
        "---CONTENT START---",
        "function initPreview() {}",
        "function updatePreview() {}",
        "function initOutline() {}",
        "function updateOutline() {}",
        "function initStatusBar() {}",
        "---CONTENT END---",
      ].join("\n");
      // Mirror the logged MD Viewer reread sequence: first window, later
      // window, first window replay, final window, then later/final replays.
      recordChildToolResult(childCallbacks, "read_file", "src/main.js", laterMainWindow);
      recordChildToolResult(childCallbacks, "read_file", "src/main.js", [
        "READ_FILE_RESULT",
        "path: src/main.js",
        "---CONTENT START---",
        "document.addEventListener('DOMContentLoaded', () => {",
        "  initToolbar();",
        "  initEditor();",
        "});",
        "---CONTENT END---",
      ].join("\n"));
      recordChildToolResult(childCallbacks, "read_file", "src/main.js", finalMainWindow);
      recordChildToolResult(childCallbacks, "read_file", "src/main.js", laterMainWindow);
      recordChildToolResult(childCallbacks, "read_file", "src/main.js", finalMainWindow);
      recordChildToolResult(childCallbacks, "read_file", "vite.config.js", [
        "READ_FILE_RESULT",
        "path: vite.config.js",
        "---CONTENT START---",
        ...Array.from({ length: 80 }, (_, index) => `// setup comment ${index}`),
        "export default defineConfig({ server: { port: 1420, strictPort: true } });",
        "---CONTENT END---",
      ].join("\n"));
      childCallbacks.onAssistantFinalText("The event boundary is versioned and durable.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.closureAudit?.requiredPaths, []);
  assert.deepEqual(result.closureAudit?.coveredPaths, []);
  assert.deepEqual(result.closureAudit?.failedPaths, []);
  assert.deepEqual(result.closureAudit?.uncoveredPaths, []);
  assert.equal(result.summary, "The event boundary is versioned and durable.");
  assert.equal(result.summaryTrust, "unverified_hypothesis");
  assert.ok(result.evidence.every((item) =>
    item.provenance?.source === "tool_observation" &&
    !!item.provenance?.sourceToolCallId
  ));
  assert.deepEqual(events.map((event) => event.type).filter((type, index, all) => index === 0 || type !== all[index - 1]), [
    "subagent.created",
    "subagent.updated",
    "subagent.closed",
  ]);
  const [record] = subagents.projectSubagentRuns(events);
  assert.equal(record.status, "completed");
  assert.equal(record.activities.filter((activity) => activity.status === "completed").length, 10);
  assert.match(result.evidence.find((item) => item.target === "vite.config.js")?.detail || "", /port:\s*1420/);
  const mainEvidence = result.evidence.find((item) => item.target === "src/main.js");
  assert.ok(mainEvidence?.facts?.some((fact) => /event_dom_listener_contract\(DOMContentLoaded\)/.test(fact)));
  assert.ok(mainEvidence?.facts?.some((fact) => /listener_calls\([^)]*\binitToolbar\b[^)]*\binitEditor\b/.test(fact)));
  assert.ok(mainEvidence?.facts?.every((fact) => !/localDefinition|nestedDefinitionCall/.test(fact)));

  const promoted = toolActivityTracking.extractDelegatedSubagentActivities({
    toolCallId: "call_wait_logged_md_viewer",
    name: "wait_subagents",
    target: result.subagentId,
    content: JSON.stringify({ results: [result], pendingIds: [] }),
    isError: false,
  });
  const promotedMain = promoted.find((item) => item.target === "src/main.js");
  assert.ok(promotedMain?.facts?.some((fact) => /event_dom_listener_contract\(DOMContentLoaded\)/.test(fact)));
  assert.ok(promotedMain?.facts?.some((fact) => /listener_calls\([^)]*\binitToolbar\b[^)]*\binitEditor\b/.test(fact)));
  assert.equal(planMaterialization.findContradictedPlanDiagnosticClaim({
    content: "- `src/main.js` 中 `initToolbar()` 在 DOM 元素就绪前被调用（主因）。",
    recentToolActivity: promoted,
  }), "initToolbar");
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

test("partial scoped fan-out coverage cannot close the child or parent join", async () => {
  subagents.resetSubagentRuntimeForTests();
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      name: "Noether",
      objective: "Inspect both exact UI entry files",
      scopeKey: "ui-entry-files",
      allowedPaths: "src/main.js,src/components/editor.js",
      expectedOutput: "Source-backed findings for both files",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-partial-fanout",
      getMessages: () => [],
    },
    parentTurnId: "turn-partial-fanout",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      const coverage = {
        requiredPaths: ["src/main.js", "src/components/editor.js"],
        coveredPaths: ["src/main.js"],
        failedPaths: ["src/components/editor.js"],
      };
      const content = [
        `SCOPED_READ_COVERAGE: ${JSON.stringify(coverage)}`,
        "",
        "=== src/main.js ===",
        "initEditor();",
        "",
        "=== src/components/editor.js ===",
        "Error: simulated scoped read failure",
      ].join("\n");
      childCallbacks.onToolError("grep_search", "src/main.js, src/components/editor.js", content);
      childCallbacks.onToolResultObserved?.({
        toolCallId: "child-fanout-partial",
        name: "grep_search",
        target: "src/main.js, src/components/editor.js",
        content,
        displayContent: content,
        isError: true,
        lifecycleState: "failed",
        scopedReadCoverage: coverage,
        scopedReadObservations: [{
          sourcePath: "src/main.js",
          content: "initEditor();",
          negative: false,
        }],
      });
      childCallbacks.onAssistantFinalText("The main entry was observed; the editor entry was not.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.closureAudit?.state, "partial");
  assert.deepEqual(result.closureAudit?.requiredPaths, [
    "src/main.js",
    "src/components/editor.js",
  ]);
  assert.deepEqual(result.closureAudit?.coveredPaths, ["src/main.js"]);
  assert.deepEqual(result.closureAudit?.failedPaths, ["src/components/editor.js"]);
  assert.deepEqual(result.closureAudit?.uncoveredPaths, ["src/components/editor.js"]);
  assert.match(result.remainingWork || "", /src\/components\/editor\.js/);
  assert.equal(result.evidence.length, 1);

  const promoted = toolActivityTracking.extractDelegatedSubagentActivities({
    toolCallId: "wait-partial-fanout",
    name: "wait_subagents",
    target: result.subagentId,
    content: JSON.stringify({ results: [result], pendingIds: [] }),
    isError: false,
  });
  assert.deepEqual(promoted, []);
});

test("allowed paths remain an authorization ceiling rather than mandatory coverage", async () => {
  subagents.resetSubagentRuntimeForTests();
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      name: "Curie",
      objective: "Identify the UI bootstrap entry",
      scopeKey: "ui-bootstrap-candidates",
      allowedPaths: "src/main.js,src/components/editor.js",
      expectedOutput: "One source-backed bootstrap finding",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-allowed-ceiling",
      getMessages: () => [],
    },
    parentTurnId: "turn-allowed-ceiling",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      childCallbacks.onToolResultObserved?.({
        toolCallId: "child-read-bootstrap",
        name: "read_file",
        target: "src/main.js",
        content: "document.addEventListener('DOMContentLoaded', initEditor);",
        isError: false,
        lifecycleState: "completed",
      });
      childCallbacks.onAssistantFinalText("src/main.js owns the DOMContentLoaded bootstrap.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.closureAudit?.state, "satisfied");
  assert.deepEqual(result.closureAudit?.requiredPaths, []);
  assert.equal(result.closureAudit?.substantiveEvidenceCount, 1);
});

test("non-substantive observations cannot satisfy required fan-out coverage", async () => {
  subagents.resetSubagentRuntimeForTests();
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      name: "Franklin",
      objective: "Inspect both UI modules",
      scopeKey: "ui-module-coverage",
      allowedPaths: "src/main.js,src/components/editor.js",
      expectedOutput: "Evidence for both UI modules",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-non-substantive-coverage",
      getMessages: () => [],
    },
    parentTurnId: "turn-non-substantive-coverage",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      const coverage = {
        requiredPaths: ["src/main.js", "src/components/editor.js"],
        coveredPaths: ["src/main.js", "src/components/editor.js"],
        failedPaths: [],
      };
      childCallbacks.onToolResultObserved?.({
        toolCallId: "child-outline-fanout",
        name: "get_file_outline",
        target: "src/main.js, src/components/editor.js",
        content: "outline aggregate",
        isError: false,
        lifecycleState: "completed",
        scopedReadCoverage: coverage,
        scopedReadObservations: [{
          sourcePath: "src/main.js",
          content: "function initEditor()",
          negative: false,
        }, {
          sourcePath: "src/components/editor.js",
          content: "(No recognizable symbols found)",
          negative: true,
        }],
      });
      childCallbacks.onAssistantFinalText("Only the main module produced a substantive outline.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.closureAudit?.state, "partial");
  assert.deepEqual(result.closureAudit?.coveredPaths, ["src/main.js"]);
  assert.deepEqual(result.closureAudit?.uncoveredPaths, ["src/components/editor.js"]);
});

test("child reports with declared remaining work cannot be marked completed", async () => {
  subagents.resetSubagentRuntimeForTests();
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      name: "Euler",
      objective: "Inspect parser normalization",
      scopeKey: "csv-parser",
      allowedPaths: "src/hooks/useCsvParser.ts",
      expectedOutput: "Source-backed mapping evidence",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "zh",
      getSessionKey: () => "thread-incomplete-report",
      getMessages: () => [],
    },
    parentTurnId: "turn-incomplete-report",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "get_file_outline",
        "src/hooks/useCsvParser.ts",
        "(No class/interface/type declarations found)",
      );
      childCallbacks.onAssistantFinalText([
        "当前没有足够源码结论。",
        "## 剩余工作",
        "1. 使用 read_file 读取 src/hooks/useCsvParser.ts。",
      ].join("\n"));
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "blocked");
  assert.match(result.blocker || "", /SUBAGENT_REMAINING_WORK_DECLARED/);
  assert.match(result.remainingWork || "", /read_file/);
  assert.equal(result.evidence.length, 1);
});

test("structured child reports and empty outlines cannot produce false completion", async () => {
  subagents.resetSubagentRuntimeForTests();
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      name: "Euler",
      objective: "Inspect parser normalization",
      scopeKey: "structured-incomplete-report",
      allowedPaths: "src/hooks/useCsvParser.ts",
      expectedOutput: "Source-backed mapping evidence",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "zh",
      getSessionKey: () => "thread-structured-incomplete-report",
      getMessages: () => [],
    },
    parentTurnId: "turn-structured-incomplete-report",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "get_file_outline",
        "src/hooks/useCsvParser.ts",
        "null",
      );
      childCallbacks.onAssistantFinalText(JSON.stringify({
        findings: [{
          summary: "The outline did not expose source-backed behavior.",
          remaining_work: "使用 read_file 读取 src/hooks/useCsvParser.ts 后再核实映射。",
        }],
      }));
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.closureAudit?.state, "blocked");
  assert.equal(result.closureAudit?.substantiveEvidenceCount, 0);
  assert.equal(result.evidence[0]?.observation?.substantive, false);
  assert.match(result.remainingWork || "", /read_file/);
  assert.match(result.blocker || "", /SUBAGENT_REMAINING_WORK_DECLARED/);
});

test("negated remaining-work sections do not downgrade a completed child", () => {
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork([
    "结论已覆盖全部允许路径。",
    "## 剩余工作",
    "无需进一步调查，已覆盖所有允许路径内的消费逻辑。",
  ].join("\n")), "");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork([
    "All scoped evidence was collected.",
    "## Remaining Work",
    "No further work is required within the assigned scope.",
  ].join("\n")), "");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork([
    "已确认类型契约。",
    "## 剩余工作",
    "无。已完成对指定范围内的类型定义检查。",
  ].join("\n")), "");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork([
    "The type contract is confirmed.",
    "## Remaining Work",
    "None. The assigned scope is complete.",
  ].join("\n")), "");
  for (const completedStatement of [
    "无（已完成指定范围内的消费逻辑分析）。",
    "无剩余工作。",
    "已完成，无剩余工作。",
    "No remaining work.",
    "No remaining tasks.",
    "Nothing remains to be done.",
    "None — all scoped work completed.",
  ]) {
    assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork([
      "## Remaining Work",
      completedStatement,
    ].join("\n")), "", completedStatement);
  }
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork(JSON.stringify({
    findings: [{ remaining_work: "尝试使用 read_file 读取完整源码。" }],
  })), "尝试使用 read_file 读取完整源码。");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork(JSON.stringify({
    findings: [{ remaining_work: "无。" }],
  })), "");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork(JSON.stringify({
    findings: [{ remaining_work: { status: "done" } }],
  })), "");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork(JSON.stringify({
    remaining_work: 0,
  })), "");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork(JSON.stringify({
    remaining_work: [{ task: "read x", status: "done" }],
  })), "");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork(JSON.stringify({
    schema: { properties: { remaining_work: { description: "Source field, not child work" } } },
  })), "");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork(JSON.stringify({
    report: { examples: [{ remaining_work: "example only" }] },
  })), "");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork([
    "```json",
    JSON.stringify({ remaining_tasks: ["read_file src/main.js", "run targeted verification"] }),
    "```",
  ].join("\n")), "read_file src/main.js\nrun targeted verification");
  assert.equal(subagentRuntime.extractDeclaredSubagentRemainingWork([
    "Here is the structured report:",
    "```json",
    JSON.stringify({ findings: [{ remaining_work: "read_file src/late.ts" }] }),
    "```",
  ].join("\n")), "read_file src/late.ts");
});

test("empty structure observations include null and empty structured containers", () => {
  assert.equal(subagentRuntime.isEmptySubagentStructureObservation("null"), true);
  assert.equal(subagentRuntime.isEmptySubagentStructureObservation("[]"), true);
  assert.equal(subagentRuntime.isEmptySubagentStructureObservation('{"path":"src/main.js","symbols":[]}'), true);
  assert.equal(subagentRuntime.isEmptySubagentStructureObservation('{"symbols":[{}]}'), true);
  assert.equal(subagentRuntime.isEmptySubagentStructureObservation('{"symbols":{"items":[]}}'), true);
  assert.equal(subagentRuntime.isEmptySubagentStructureObservation('{"path":"src/main.js","metadata":{"language":"ts"}}'), true);
  assert.equal(subagentRuntime.isEmptySubagentStructureObservation("function initEditor()"), false);
  assert.equal(subagentRuntime.isEmptySubagentStructureObservation('[{"name":"initEditor"}]'), false);
  assert.equal(subagentRuntime.isEmptySubagentStructureObservation('{"symbols":{"items":[{"name":"initEditor"}]}}'), false);
});

test("subagent evidence retains tool-call, version, range, and fact provenance", async () => {
  subagents.resetSubagentRuntimeForTests();
  const content = [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "truncated: true",
    "totalLines: 120",
    "totalChars: 4800",
    "returnedLines: 20-24",
    "returnedChars: 180",
    "nextStartLine: 25",
    "---CONTENT START---",
    "document.addEventListener('DOMContentLoaded', initToolbar);",
    "---CONTENT END---",
  ].join("\n");
  const observation = {
    key: "read-main-window::version=4800:100::content=abc",
    path: "src/main.js",
    requestSignature: "read_file::src/main.js::start_line=20,end_line=24",
    versionToken: "4800:100",
    contentHash: "abc",
    source: "fresh",
  };
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      objective: "Inspect one event binding",
      scopeKey: "main-window",
      allowedPaths: "src/main.js",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-provenance",
      getMessages: () => [],
    },
    parentTurnId: "turn-provenance",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(childCallbacks, "read_file", "src/main.js", content, {
        toolCallId: "child-read-main-window",
        readFileObservation: observation,
      });
      childCallbacks.onAssistantFinalText("The event binding looks relevant.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  const [evidence] = result.evidence;
  assert.equal(evidence.provenance.source, "tool_observation");
  assert.deepEqual(evidence.provenance.owner, {
    agentKind: "subagent",
    subagentId: result.subagentId,
    parentTurnId: "turn-provenance",
    runId: `run-${result.subagentId}`,
  });
  assert.equal(evidence.provenance.sourceToolCallId, "child-read-main-window");
  assert.equal(evidence.provenance.sourceObservation.key, observation.key);
  assert.equal(evidence.provenance.sourceVersion, "4800:100");
  assert.deepEqual(evidence.provenance.sourceRange, {
    startLine: 20,
    endLine: 24,
    totalLines: 120,
    truncated: true,
  });
  assert.ok((evidence.provenance.factReferences || []).length > 0);
  assert.ok((evidence.provenance.factReferences || []).every((reference) =>
    reference.sourceToolCallId === "child-read-main-window" &&
    reference.sourceObservationKey === observation.key
  ));
});

test("subagent evidence keeps disjoint windows of the same file as separate observations", async () => {
  subagents.resetSubagentRuntimeForTests();
  const readResult = (startLine, endLine, content) => [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "truncated: true",
    "totalLines: 120",
    "totalChars: 4800",
    `returnedLines: ${startLine}-${endLine}`,
    `returnedChars: ${content.length}`,
    `nextStartLine: ${endLine + 1}`,
    "---CONTENT START---",
    content,
    "---CONTENT END---",
  ].join("\n");
  const observation = (startLine, endLine, hash) => ({
    key: `src/main.js:${startLine}-${endLine}:v1:${hash}`,
    path: "src/main.js",
    requestSignature: `read_file::src/main.js::${startLine}-${endLine}`,
    versionToken: "v1",
    contentHash: hash,
    source: "fresh",
  });
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      objective: "Inspect two independent event binding windows",
      scopeKey: "main-two-windows",
      allowedPaths: "src/main.js",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-two-windows",
      getMessages: () => [],
    },
    parentTurnId: "turn-two-windows",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/main.js",
        readResult(1, 20, "document.addEventListener('DOMContentLoaded', initEditor);"),
        {
          toolCallId: "child-read-main-head",
          readFileObservation: observation(1, 20, "head"),
        },
      );
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/main.js",
        readResult(80, 100, "document.querySelector('#new-btn').addEventListener('click', createNew);"),
        {
          toolCallId: "child-read-main-toolbar",
          readFileObservation: observation(80, 100, "toolbar"),
        },
      );
      childCallbacks.onAssistantFinalText("Two windows inspected.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.evidence.length, 2);
  assert.deepEqual(
    result.evidence.map((item) => item.provenance.sourceRange),
    [
      { startLine: 1, endLine: 20, totalLines: 120, truncated: true },
      { startLine: 80, endLine: 100, totalLines: 120, truncated: true },
    ],
  );
  const promoted = toolActivityTracking.extractDelegatedSubagentActivities({
    toolCallId: "wait-two-windows",
    name: "wait_subagents",
    target: result.subagentId,
    content: JSON.stringify({ results: [result], pendingIds: [] }),
    isError: false,
  });
  assert.equal(promoted.length, 2);
  assert.deepEqual(
    promoted.map((item) => item.delegatedObservation.sourceObservationKey),
    ["src/main.js:1-20:v1:head", "src/main.js:80-100:v1:toolbar"],
  );
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
      recordChildToolResult(childCallbacks, "read_file", "src/lib/turnEvents.ts", "versioned events");
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
  assert.equal(subagents.findSubagentScopeConflict({
    threadId: "thread-async",
    targetPath: "src/lib/turnEvents.ts",
  }), null);
});

test("child initialization cannot overwrite parent recovery or terminal tool-surface state", async () => {
  subagents.resetSubagentRuntimeForTests();
  let parentRecoveryWrites = 0;
  let parentToolSurfaceWrites = 0;
  const parentCheckpoint = {
    mode: "objective_audit",
    reason: "parent objective audit remains active",
    expectedTarget: "src/main.ts",
  };

  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      name: "Noether",
      objective: "Inspect a read-only file without changing parent state",
      scopeKey: "callback-isolation",
      allowedPaths: "src/lib/subagents.ts",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-callback-isolation",
      getMessages: () => [{ role: "user", content: "parent" }],
      getForcedExecuteRecoveryState: () => parentCheckpoint,
      onExecuteRecoveryStateChange: () => { parentRecoveryWrites += 1; },
      onToolSurfaceResolved: () => { parentToolSurfaceWrites += 1; },
    },
    parentTurnId: "turn-callback-isolation",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      assert.equal(childCallbacks.getForcedExecuteRecoveryState?.(), null);
      childCallbacks.onExecuteRecoveryStateChange?.({
        mode: "normal",
        reason: "child initialization",
        expectedTarget: null,
        attempts: 0,
        phase: "mutation",
        phaseNoProgressCount: 0,
        protocolNoProgressCount: 0,
        protocolNoProgressFingerprint: null,
        readLease: null,
        sourceObservationKey: null,
        decisionCheckpoint: null,
      });
      childCallbacks.onToolSurfaceResolved?.(["read_file"]);
      recordChildToolResult(childCallbacks, "read_file", "src/lib/subagents.ts", "callback boundary source");
      childCallbacks.onAssistantFinalText("Callback boundary inspected.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(parentRecoveryWrites, 0);
  assert.equal(parentToolSurfaceWrites, 0);
  assert.equal(parentCheckpoint.mode, "objective_audit");
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
    summaryTrust: "unverified_hypothesis",
    evidence: [],
  }), { once: true });
  subagents.acquireSubagentScopeLease({
    threadId: "thread-finalize",
    parentTurnId: "turn-finalize",
    subagentId: "subagent-finalize",
    scopeKey: "runtime",
    workspace: "/workspace",
    allowedPaths: ["src/lib/subagents.ts"],
    createdAt: Date.now(),
  });
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
  assert.equal(subagents.findSubagentScopeConflict({
    threadId: "thread-finalize",
    targetPath: "src/lib/subagents.ts",
  }), null);
});

test("completed child remains joinable until the parent consumes its result", async () => {
  subagents.resetSubagentRuntimeForTests();
  const completion = Promise.resolve({
    subagentId: "subagent-ready",
    name: "Mendel",
    scopeKey: "ready-result",
    status: "completed",
    summary: "Ready before the parent reached its join boundary.",
    summaryTrust: "unverified_hypothesis",
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
          summaryTrust: "unverified_hypothesis",
          evidence: [{
            tool: "read_file",
            target: "src/lib/turnEvents.ts",
            detail: "Versioned events.",
            provenance: {
              source: "tool_observation",
              owner: {
                agentKind: "subagent",
                subagentId: "subagent-euler",
              },
              sourceToolCallId: "child-read-events",
            },
          }],
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
  assert.match(messages[0].content, /unverified child hypothesis/);
  assert.match(messages[0].content, /targeted parent read_file/);
  assert.deepEqual(recent.map((entry) => [entry.name, entry.target]), [["read_file", "src/lib/turnEvents.ts"]]);
  assert.equal(recent[0].readFileObservation, undefined);
  assert.equal(recent[0].delegatedObservation.owner.subagentId, "subagent-euler");
  assert.equal(recent[0].delegatedObservation.requiresParentReread, true);
  assert.deepEqual(recentPlan, recent);
  assert.deepEqual(events.map((entry) => entry.event), ["parent_join_required", "parent_join_injected"]);
});

test("only a structured parent scope deferral requests deterministic child join", () => {
  assert.equal(subagentJoinRuntime.shouldJoinPendingSubagentsAfterScopeDeferral([{
    toolCallId: "parent-read-css",
    name: "read_file",
    target: "src/styles/main.css",
    content: "PARENT_SCOPE_DEFERRED_TO_SUBAGENT",
    isError: false,
    lifecycleState: "completed",
    internalFeedback: true,
    qualityGateReason: "subagent_scope_policy_deferred",
  }]), true);
  assert.equal(subagentJoinRuntime.shouldJoinPendingSubagentsAfterScopeDeferral([{
    toolCallId: "child-scope-escape",
    name: "grep_search",
    target: "src",
    content: "SUBAGENT_SCOPE_BLOCKED",
    isError: true,
    lifecycleState: "blocked",
  }]), false);
  assert.equal(subagentJoinRuntime.shouldJoinPendingSubagentsAfterScopeDeferral([{
    toolCallId: "ordinary-policy-deferral",
    name: "read_file",
    target: "src/main.js",
    content: "READ_SCOPE_DEFERRED",
    isError: false,
    lifecycleState: "completed",
    internalFeedback: true,
    qualityGateReason: "read_scope_deferred",
  }]), false);
  assert.equal(subagentJoinRuntime.shouldJoinPendingSubagentsAfterScopeDeferral([{
    toolCallId: "parent-read-css",
    name: "read_file",
    target: "src/styles/main.css",
    content: "PARENT_SCOPE_DEFERRED_TO_SUBAGENT",
    isError: false,
    lifecycleState: "completed",
    internalFeedback: true,
    qualityGateReason: "subagent_scope_policy_deferred",
  }, {
    toolCallId: "failed-validation",
    name: "run_command",
    target: "npm test",
    content: "tests failed",
    isError: true,
    lifecycleState: "failed",
  }]), false);
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
      recordChildToolResult(childCallbacks, "read_file", "src/lib/subagents.ts", "lease registry located");
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

test("iteration boundary with substantive evidence is a degraded partial result, not a failure", async () => {
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
      recordChildToolResult(childCallbacks, "read_file", "src/lib/subagents.ts", "Coordinator evidence");
      childCallbacks.onAssistantFinalText("The coordinator retains a bounded partial result.");
      childCallbacks.onNonActionableStop("Iteration boundary reached.", "no_action", {
        recoveryReason: "max_iterations_boundary",
      });
      return { status: "stopped_no_action", reason: "max_iterations_boundary" };
    },
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.closureAudit?.state, "partial");
  assert.match(result.summary, /bounded partial result/);
  assert.equal(result.evidence.length, 1);
  assert.ok(traceEvents.some((entry) => entry.event === "subagent_partial_result_preserved"));
});

test("a completed error conclusion never projects as subagent success", async () => {
  subagents.resetSubagentRuntimeForTests();
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      objective: "Inspect a bounded file",
      scopeKey: "error-conclusion",
      allowedPaths: "src/lib/subagents.ts",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-error-conclusion",
      getMessages: () => [],
    },
    parentTurnId: "turn-error-conclusion",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      childCallbacks.onAssistantFinalText("The provider request failed before inspection.");
      return {
        status: "completed",
        resultKind: "error",
        reason: "provider_connection_reset",
      };
    },
  });

  assert.equal(result.status, "failed");
  assert.notEqual(result.closureAudit?.state, "satisfied");
  assert.match(result.summary, /provider request failed/i);
});

test("overlapping child scope is a policy deferral rather than a failed spawn", () => {
  subagents.resetSubagentRuntimeForTests();
  subagents.acquireSubagentScopeLease({
    threadId: "thread-overlap",
    parentTurnId: "turn-overlap",
    subagentId: "subagent-existing",
    scopeKey: "existing-scope",
    workspace: "/workspace",
    allowedPaths: ["src/lib/subagents.ts"],
    createdAt: Date.now(),
  });
  const debugEvents = [];
  const result = subagentRuntime.scheduleControlledSubagent({
    request: {
      name: "Mendel",
      objective: "Inspect the same runtime coordinator",
      scopeKey: "overlapping-scope",
      allowedPaths: "src/lib",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-overlap",
      onDebugEvent: (event, data) => debugEvents.push({ event, data }),
    },
    parentTurnId: "turn-overlap",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async () => {
      throw new Error("deferred work must not start");
    },
  });

  assert.equal(result.status, "deferred");
  assert.equal(result.reason, "overlapping_active_scope");
  assert.equal(result.subagentId, null);
  assert.equal(result.conflictingSubagentId, "subagent-existing");
  assert.deepEqual(
    subagents.getPendingCoordinatedSubagentIds("thread-overlap", "turn-overlap"),
    [],
  );
  assert.ok(debugEvents.some((entry) =>
    entry.event === "delegation_scope_decision" && entry.data.decision === "deferred"
  ));
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
  const directoryScope = {
    ...scope,
    scopeKey: "src-directory",
    allowedPaths: ["src"],
  };
  assert.equal(subagents.validateSubagentScopeTarget(scope, "/workspace/src/lib/subagents.ts"), true);
  assert.equal(subagents.validateSubagentScopeTarget(scope, "src/lib/orchestrator.ts"), false);
  assert.equal(
    subagents.validateSubagentScopeTarget(scope, "src/lib/../package.json"),
    false,
    "a child target cannot use ParentDir components to escape its exact scope",
  );
  assert.equal(
    subagents.validateSubagentScopeTarget(scope, "../src/lib/subagents.ts"),
    false,
    "workspace-relative traversal above the root is rejected",
  );
  assert.equal(subagents.validateSubagentScopeTarget(directoryScope, "src/../package.json"), false);
  assert.equal(subagents.validateSubagentScopeTarget(directoryScope, "other/../src/main.ts"), true);
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
    targetPath: "other/../src/lib/subagents.ts",
  })?.subagentId, "subagent-scope", "lexical aliases cannot bypass a parent/child reservation");
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
    allowedPaths: ["other/../src/lib"],
  })?.subagentId, "subagent-scope");
  assert.equal(subagents.findSubagentLeaseOverlap({
    threadId: "thread-scope",
    workspace: "/workspace",
    allowedPaths: ["src/components"],
  }), null);
});

test("subagent source contracts keep children read-only and UI activity clickable", () => {
  const registrySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolRegistrySetup.ts"), "utf8");
  const subagentRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/subagentRuntime.ts"), "utf8");
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
  assert.match(subagentRuntimeSource, /onToolSurfaceResolved: undefined/);
  assert.doesNotMatch(subagentRuntimeSource, /\.\.\.input\.parentCallbacks/);
  assert.match(subagentRuntimeSource, /getForcedExecuteRecoveryState: \(\) => null/);
  assert.match(subagentRuntimeSource, /onExecuteRecoveryStateChange: undefined/);
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
