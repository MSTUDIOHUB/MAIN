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
const runtimeTools = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/runtimeTools.ts"));

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

function makeSubagentClosure(overrides = {}) {
  const { owner: ownerOverrides = {}, ...closureOverrides } = overrides;
  const status = closureOverrides.status || "completed";
  const state = closureOverrides.state || (status === "completed" ? "satisfied" : "blocked");
  return {
    schemaVersion: subagents.SUBAGENT_CLOSURE_SCHEMA_VERSION,
    owner: {
      agentKind: "subagent",
      threadId: "thread-1",
      parentTurnId: "turn-1",
      subagentId: "subagent-1",
      runId: "run-subagent-1",
      parentRunId: "run-parent-1",
      ...ownerOverrides,
    },
    scopeKey: closureOverrides.scopeKey || "turn-events",
    status,
    state,
    remainingWork: status === "completed" ? null : "Inspect the unresolved child scope.",
    observationCount: 0,
    substantiveEvidenceCount: 0,
    acceptedEvidenceToolCallIds: [],
    requiredPaths: [],
    coveredPaths: [],
    failedPaths: [],
    uncoveredPaths: [],
    reasonCode: status === "completed" ? "runtime_completed" : "runtime_blocked",
    reason: status === "completed" ? "The controlled runtime completed." : "The controlled runtime did not complete.",
    ...closureOverrides,
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

test("read-only child roles never imply workspace mutation capability", () => {
  assert.equal(subagentRuntime.resolveReadOnlySubagentRole("coder"), "investigator");
  assert.equal(subagentRuntime.resolveReadOnlySubagentRole("reviewer"), "investigator");
});

test("capacity policy permits two local children and bounded cloud parallelism", () => {
  const local = subagents.resolveSubagentCapacityPolicy(makeConfig("local"));
  assert.equal(local.profile, "local");
  assert.equal(local.maxActiveRequests, 2);
  assert.equal(local.maxBurstActiveRequests, 3);
  assert.equal(local.maxConcurrentChildren, 3);
  assert.equal(local.model, "qwen3.6-35b-a3b");

  const cloud = subagents.resolveSubagentCapacityPolicy(makeConfig("cloud", {
    cloudServers: [{ id: "primary", provider: "OpenAI", model: "gpt-cloud" }],
    activeCloudServerId: "primary",
  }));
  assert.equal(cloud.profile, "cloud");
  assert.equal(cloud.maxActiveRequests, 3);
  assert.equal(cloud.maxBurstActiveRequests, 3);
  assert.equal(cloud.maxConcurrentChildren, 6);
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
    scopeKey: "turn-events",
    runId: "run-subagent-1",
    parentRunId: "run-parent-1",
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
      patch: {
        status: "completed",
        completedAt: 20,
        updatedAt: 20,
        summary: "Found the event boundary.",
        closureState: "satisfied",
        closureAudit: makeSubagentClosure(),
      },
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

test("persisted completion without an authoritative closure envelope fails closed", () => {
  const legacyBase = {
    id: "subagent-legacy",
    parentTurnId: "turn-legacy",
    threadId: "thread-legacy",
    name: "Legacy",
    role: "explorer",
    objective: "Inspect legacy persisted state",
    status: "queued",
    profile: "local",
    provider: "Local",
    model: "legacy-model",
    createdAt: 10,
    updatedAt: 10,
  };
  const events = [
    turnEvents.withEventSchema({
      type: "subagent.created",
      threadId: legacyBase.threadId,
      turnId: legacyBase.parentTurnId,
      timestampMs: 10,
      subagent: legacyBase,
    }),
    turnEvents.withEventSchema({
      type: "subagent.updated",
      threadId: legacyBase.threadId,
      turnId: legacyBase.parentTurnId,
      timestampMs: 20,
      subagentId: legacyBase.id,
      patch: {
        status: "completed",
        summary: "无剩余工作 / No remaining work / Hakuna kazi iliyobaki.",
        updatedAt: 20,
        completedAt: 20,
      },
    }),
    turnEvents.withEventSchema({
      type: "subagent.closed",
      threadId: legacyBase.threadId,
      turnId: legacyBase.parentTurnId,
      timestampMs: 21,
      subagentId: legacyBase.id,
      closedAt: 21,
      reason: "completed",
    }),
  ];

  const [record] = subagents.projectSubagentRuns(events);
  assert.equal(record.status, "blocked");
  assert.equal(record.closureState, "blocked");
  assert.equal(record.remainingWork, legacyBase.objective);
  assert.match(record.error || "", /SUBAGENT_CLOSURE_CONTRACT_MISSING/);
  assert.equal(subagents.isAuthoritativeSubagentClosure(undefined), false);
  assert.equal(subagents.isAuthoritativeSubagentClosure({ state: "satisfied" }), false);
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

test("an explicit collaboration preference keeps its start boundary while allowed mode follows capacity", () => {
  const runtimeHealth = (state) => ({
    laneKey: "local:test",
    profile: "local",
    state,
    activeChildren: 2,
    queuedChildren: 1,
    capacityLimit: 2,
    memorySafety: "safe",
    recentSuccessfulRuns: 1,
    latestStartupMs: 240,
    latestCapacityWaitMs: 10,
  });
  for (const state of ["busy", "degraded"]) {
    const preferred = subagents.resolveDelegationDecision({
      preference: "preferred",
      phase: "context",
      hasWorkspace: true,
      runtimeHealth: runtimeHealth(state),
    });
    assert.equal(preferred.action, "admit");
    assert.equal(preferred.reason, "explicit_preference");

    const allowed = subagents.resolveDelegationDecision({
      preference: "allowed",
      phase: "context",
      hasWorkspace: true,
      runtimeHealth: runtimeHealth(state),
    });
    assert.equal(allowed.action, "defer");
    assert.equal(allowed.reason, `runtime_capacity_${state}`);
  }
});

test("queued children reserve parent access while allowing independent read-only peers", async () => {
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

  assert.equal(subagents.findSubagentLeaseOverlap({
    threadId: "thread-lease-order",
    workspace: "/workspace",
    allowedPaths: ["src/lib/subagents.ts"],
  }), null);
  assert.ok(subagents.findSubagentLeaseOverlap({
    threadId: "thread-lease-order",
    workspace: "/workspace",
    allowedPaths: ["src/lib/subagents.ts"],
    accessMode: "write",
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
      allowedPaths: "src/lib/turnEvents.ts,vite.config.js,src/main.js,src-tauri/src/main.rs",
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
      assert.match(childCallbacks.getMessages()[0].content, /fresh, one-shot subagent/);
      assert.doesNotMatch(
        childCallbacks.getMessages()[0].content,
        /Start with src\/lib\/turnEvents\.ts/,
        "unverified model-authored context hints are not copied into a fresh child",
      );
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
      const rustCommandSource = [
        "use tauri::{AppHandle, Manager};",
        "tauri::Builder::default().invoke_handler(tauri::generate_handler![save_file_content]);",
        "#[tauri::command]",
        "fn save_file_content(app: AppHandle, content: String, file_path: Option<String>) -> Result<(), String> {",
        "  let path = file_path.ok_or_else(|| \"missing path\".to_string())?;",
        "  std::fs::write(path, content).map_err(|error| error.to_string())",
        "}",
      ].join("\n");
      const directRustFacts = planMaterialization.extractPlanEvidenceSourceFacts(rustCommandSource);
      assert.ok(directRustFacts.includes(
        "command_handler_argument_contract(save_file_content,content,filePath)",
      ), JSON.stringify(directRustFacts));
      recordChildToolResult(childCallbacks, "read_file", "src-tauri/src/main.rs", rustCommandSource);
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
    "subagent.completed",
    "subagent.closed",
  ]);
  const [record] = subagents.projectSubagentRuns(events);
  assert.equal(record.status, "completed");
  assert.equal(record.activities.filter((activity) => activity.status === "completed").length, 11);
  assert.match(result.evidence.find((item) => item.target === "vite.config.js")?.detail || "", /port:\s*1420/);
  const mainEvidence = result.evidence.find((item) => item.target === "src/main.js");
  assert.ok(mainEvidence?.facts?.some((fact) => /event_dom_listener_contract\(DOMContentLoaded\)/.test(fact)));
  assert.ok(mainEvidence?.facts?.some((fact) => /listener_calls\([^)]*\binitToolbar\b[^)]*\binitEditor\b/.test(fact)));
  assert.ok(mainEvidence?.facts?.every((fact) => !/localDefinition|nestedDefinitionCall/.test(fact)));
  const rustEvidence = result.evidence.find((item) => item.target === "src-tauri/src/main.rs");
  assert.ok(rustEvidence?.facts?.includes(
    "command_handler_argument_contract(save_file_content,content,filePath)",
  ), JSON.stringify(rustEvidence?.facts || []));

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

test("partial scoped fan-out stays degraded while covered evidence remains reusable for planning", async () => {
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
  assert.deepEqual(promoted.map((item) => item.target), ["src/main.js"]);
  assert.equal(promoted[0].delegatedObservation.planningEvidenceState, "reusable");
  const obligations = toolActivityTracking.extractSubagentParentRereadObligations({
    toolCallId: "wait-partial-fanout",
    name: "wait_subagents",
    target: result.subagentId,
    content: JSON.stringify({ results: [result], pendingIds: [] }),
    isError: false,
  });
  assert.deepEqual(obligations.map((item) => item.target), ["src/components/editor.js"]);
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

test("missing substantive evidence blocks closure independently of report wording", async () => {
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
  assert.match(result.blocker || "", /SUBAGENT_EVIDENCE_REQUIRED/);
  assert.equal(result.closureAudit.reasonCode, "missing_substantive_evidence");
  assert.equal(result.remainingWork, "Inspect parser normalization");
  assert.equal(result.evidence.length, 1);
});

test("parent-owned decisions and implementation handoff do not downgrade a completed read-only child", async () => {
  subagents.resetSubagentRuntimeForTests();
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      name: "Euler",
      objective: "Inspect parser normalization",
      scopeKey: "csv-parser-parent-handoff",
      allowedPaths: "src/hooks/useCsvParser.ts",
      expectedOutput: "Source-backed mapping evidence",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "zh",
      getSessionKey: () => "thread-parent-handoff",
      getMessages: () => [],
    },
    parentTurnId: "turn-parent-handoff",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/hooks/useCsvParser.ts",
        [
          "READ_FILE_RESULT",
          "path: src/hooks/useCsvParser.ts",
          "---CONTENT START---",
          "export function normalizeRow(row) {",
          "  return { creator: row.creator || '' };",
          "}",
          "---CONTENT END---",
        ].join("\n"),
      );
      childCallbacks.onAssistantFinalText([
        "## 结论",
        "`src/hooks/useCsvParser.ts` 只输出 creator。",
        "## 不确定项",
        "无。",
        "## 剩余范围内工作",
        "无。",
        "## 父任务交接",
        "父任务决定兼容策略，并在获批后实施字段映射；另行核对允许路径外的数据样本。",
      ].join("\n"));
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.closureAudit?.state, "satisfied");
  assert.equal(result.remainingWork, undefined);
  assert.match(result.parentHandoff || "", /父任务决定兼容策略/);
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
  assert.equal(result.remainingWork, "Inspect parser normalization");
  assert.match(result.blocker || "", /SUBAGENT_EVIDENCE_REQUIRED/);
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
    "无。在允许的只读范围 src/hooks/useCsvParser.ts 内，已完成字段映射分析。",
    "**无**。在允许路径 src/hooks/useChartData.ts 和 src/store/dashboardStore.ts 内，消费逻辑已完整分析完毕。",
    "无。已读取并分析所有允许路径内的文件，完成了对 creatorName 消费逻辑的调查。",
    "无。目标已达成，creatorName 的类型约束已完整分析。\n\n---",
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
    collaborationTaskId: result.collaborationTaskId,
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

test("non-code file and document reads retain source observation provenance", async () => {
  subagents.resetSubagentRuntimeForTests();
  const markdownBody = [
    "# Deployment notes",
    "Use the reviewed staging checklist before release.",
  ].join("\n");
  const markdownRead = [
    "READ_FILE_RESULT",
    "path: docs/deployment.md",
    "truncated: true",
    "totalLines: 20",
    `totalChars: ${markdownBody.length + 240}`,
    `returnedChars: ${markdownBody.length}`,
    "returnedLines: 5-6",
    "nextStartLine: 7",
    "---CONTENT START---",
    markdownBody,
    "---CONTENT END---",
  ].join("\n");
  const documentBody = "Approved retention policy for customer records.";
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      objective: "Inspect the deployment note and policy document",
      scopeKey: "non-code-source-observations",
      allowedPaths: "docs/deployment.md,docs/retention.docx",
      expectedOutput: "Source-backed findings for both documents",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-non-code-source-observations",
      getMessages: () => [],
    },
    parentTurnId: "turn-non-code-source-observations",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "docs/deployment.md",
        markdownRead,
        { toolCallId: "child-read-deployment-markdown" },
      );
      recordChildToolResult(
        childCallbacks,
        "read_document",
        "docs/retention.docx",
        documentBody,
        { toolCallId: "child-read-retention-document" },
      );
      childCallbacks.onAssistantFinalText("Both documents were inspected.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "completed");
  const markdownEvidence = result.evidence.find((item) => item.target === "docs/deployment.md");
  assert.equal(markdownEvidence?.observation?.kind, "source");
  assert.equal(markdownEvidence?.observation?.substantive, true);
  assert.equal(markdownEvidence?.provenance.sourceContentChars, [...markdownBody].length);
  assert.match(markdownEvidence?.provenance.sourceContentHash || "", /^[a-z0-9]+$/i);
  assert.deepEqual(markdownEvidence?.provenance.sourceRange, {
    startLine: 5,
    endLine: 6,
    totalLines: 20,
    truncated: true,
  });

  const documentEvidence = result.evidence.find((item) => item.target === "docs/retention.docx");
  assert.equal(documentEvidence?.observation?.kind, "source");
  assert.equal(documentEvidence?.observation?.substantive, true);
  assert.equal(documentEvidence?.provenance.sourceContentChars, [...documentBody].length);
  assert.match(documentEvidence?.provenance.sourceContentHash || "", /^[a-z0-9]+$/i);
});

test("a cached non-code read stub cannot satisfy child source evidence", async () => {
  subagents.resetSubagentRuntimeForTests();
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      objective: "Inspect the deployment note",
      scopeKey: "cached-non-code-source",
      allowedPaths: "docs/deployment.md",
      expectedOutput: "Source-backed deployment evidence",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-cached-non-code-source",
      getMessages: () => [],
    },
    parentTurnId: "turn-cached-non-code-source",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "docs/deployment.md",
        "FILE_UNCHANGED_STUB: the exact source window remains in context",
        { toolCallId: "child-read-cached-markdown" },
      );
      childCallbacks.onAssistantFinalText("The cached stub did not expose source bytes.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.closureAudit?.substantiveEvidenceCount, 0);
  assert.equal(result.evidence[0]?.observation?.kind, "source");
  assert.equal(result.evidence[0]?.observation?.substantive, false);
  assert.equal(result.evidence[0]?.provenance.sourceContentChars, 0);
  assert.equal(result.evidence[0]?.provenance.sourceContentHash, undefined);
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
      taskKey: "turn-events",
      taskKind: "explore",
      objective: "Inspect turn event persistence",
      delegationReason: "This independent persistence check can run while the parent inspects projection.",
      successCriteria: "Return a source-backed observation of the event persistence contract.",
      scope: "Turn event persistence only",
      requiredPaths: "",
      allowedPaths: "src/lib/turnEvents.ts",
      accessMode: "read",
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
  assert.equal(subagents.getCoordinatedSubagentRunCount("thread-async", "turn-async"), 0);
  assert.equal(subagents.findSubagentScopeConflict({
    threadId: "thread-async",
    targetPath: "src/lib/turnEvents.ts",
  }), null);
});

test("minimal model spawn input is completed into a strict read-only work item", async () => {
  subagents.resetSubagentRuntimeForTests();
  const parentCallbacks = {
    getConfig: () => makeConfig("local"),
    getPreferredLanguage: () => "en",
    getSessionKey: () => "thread-minimal-spawn",
    getMessages: () => [{ role: "user", content: "parent" }],
  };
  const handle = subagentRuntime.scheduleControlledSubagent({
    request: {
      objective: "Inspect the toolbar filename rendering behavior.",
    },
    parentCallbacks,
    parentTurnId: "turn-minimal-spawn",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/components/toolbar.js",
        "toolbar filename rendering",
      );
      childCallbacks.onAssistantFinalText("The toolbar rendering owner was inspected.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(handle.status, "queued");
  assert.deepEqual(handle.allowedPaths, ["."]);
  assert.match(handle.scopeKey, /^delegated-task-/);
  const joined = await subagents.waitForCoordinatedSubagents({
    threadId: "thread-minimal-spawn",
    parentTurnId: "turn-minimal-spawn",
    subagentIds: [handle.subagentId],
  });
  assert.equal(joined.results[0].closureAudit.state, "satisfied");
  assert.equal(joined.results[0].evidence[0].target, "src/components/toolbar.js");
});

test("an implement request without an exact write scope starts as a safe read-only child", async () => {
  subagents.resetSubagentRuntimeForTests();
  const debugEvents = [];
  const handle = subagentRuntime.scheduleControlledSubagent({
    request: {
      taskKey: "FixFilePathDisplay",
      taskKind: "implement",
      objective: "Find and fix the duplicated filename display.",
      accessMode: "write",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-missing-write-scope",
      getMessages: () => [{ role: "user", content: "parent" }],
      getCurrentRunIntent: () => "execute",
      getRuntimeRunIntent: () => "execute",
      getExecutionConsentGranted: () => true,
      onDebugEvent: (event, data) => debugEvents.push({ event, data }),
    },
    parentTurnId: "turn-missing-write-scope",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/components/toolbar.js",
        "The toolbar renders a duplicate filename label.",
      );
      childCallbacks.onAssistantFinalText("The parent should remove the duplicate label.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(handle.status, "queued");
  assert.deepEqual(handle.allowedPaths, ["."]);
  const joined = await subagents.waitForCoordinatedSubagents({
    threadId: "thread-missing-write-scope",
    parentTurnId: "turn-missing-write-scope",
    subagentIds: [handle.subagentId],
  });
  assert.equal(joined.results[0].closureAudit.state, "satisfied");
  assert.ok(debugEvents.some((entry) =>
    entry.event === "delegation_scope_decision" &&
    entry.data?.decision === "downgraded" &&
    entry.data?.reason === "missing_exact_write_scope"
  ));
});

test("collaboration keeps the canonical parent owner while projecting the visible Turn", async () => {
  subagents.resetSubagentRuntimeForTests();
  const events = [];
  const handle = subagentRuntime.scheduleControlledSubagent({
    request: {
      objective: "Inspect one exact source owner.",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-owner-split",
      getMessages: () => [],
    },
    parentTurnId: "turn-canonical",
    presentationTurnId: "turn-visible",
    existingRunCount: 0,
    emitEvent: (event) => events.push(event),
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/main.js",
        "canonical owner evidence",
      );
      childCallbacks.onAssistantFinalText("The canonical owner was inspected.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });

  assert.equal(handle.status, "queued");
  assert.deepEqual(
    subagents.getPendingCoordinatedSubagentIds(
      "thread-owner-split",
      "turn-canonical",
    ),
    [handle.subagentId],
  );
  assert.deepEqual(
    subagents.getPendingCoordinatedSubagentIds(
      "thread-owner-split",
      "turn-visible",
    ),
    [],
  );
  const joined = await subagents.waitForCoordinatedSubagents({
    threadId: "thread-owner-split",
    parentTurnId: "turn-canonical",
    subagentIds: [handle.subagentId],
  });
  assert.equal(joined.results[0].status, "completed");
  assert.equal(
    events.find((event) => event.type === "subagent.created")?.turnId,
    "turn-visible",
  );
  assert.equal(
    events.find((event) => event.type === "subagent.created")?.subagent?.parentTurnId,
    "turn-visible",
  );
  assert.equal(
    events.find((event) => event.type === "subagent.closed")?.turnId,
    "turn-visible",
  );
});

test("a fresh dependent child receives verified observations but no prior child context", async () => {
  subagents.resetSubagentRuntimeForTests();
  const events = [];
  const parentCallbacks = {
    getConfig: () => makeConfig("local"),
    getPreferredLanguage: () => "en",
    getSessionKey: () => "thread-dependency-handoff",
    getMessages: () => [{
      role: "user",
      content: "PRIVATE_PARENT_TRANSCRIPT",
    }],
  };
  const dependency = subagentRuntime.scheduleControlledSubagent({
    request: {
      taskKey: "dependency-source",
      taskKind: "explore",
      objective: "Identify the source-side dependency contract.",
      delegationReason: "The source contract can be verified independently.",
      successCriteria: "Return one source-backed dependency observation.",
      requiredPaths: "src/dependency.ts",
      allowedPaths: "src/dependency.ts",
      accessMode: "read",
      expectedOutput: "Exact source evidence for the downstream task.",
    },
    parentCallbacks,
    parentTurnId: "turn-dependency-handoff",
    existingRunCount: 0,
    emitEvent: (event) => events.push(event),
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/dependency.ts",
        "export const dependencyMarker = true;",
        { toolCallId: "dependency-source-read" },
      );
      childCallbacks.onAssistantFinalText(
        "SECRET_CHILD_SUMMARY must never be inherited.",
      );
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });
  await subagents.waitForCoordinatedSubagents({
    threadId: "thread-dependency-handoff",
    parentTurnId: "turn-dependency-handoff",
    subagentIds: [dependency.subagentId],
  });

  let dependentPrompt = "";
  const dependent = subagentRuntime.scheduleControlledSubagent({
    request: {
      taskKey: "dependent-consumer",
      taskKind: "validate",
      objective: "Validate the consumer against the verified dependency contract.",
      delegationReason: "The consumer validation is a distinct downstream task.",
      successCriteria: "Return one source-backed consumer observation.",
      requiredPaths: "src/consumer.ts",
      allowedPaths: "src/consumer.ts",
      accessMode: "read",
      expectedOutput: "Consumer validation with exact source evidence.",
      dependsOn: "dependency-source",
    },
    parentCallbacks,
    parentTurnId: "turn-dependency-handoff",
    existingRunCount: 0,
    emitEvent: (event) => events.push(event),
    executeAgentLoop: async (childCallbacks) => {
      dependentPrompt = childCallbacks.getMessages()[0].content;
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/consumer.ts",
        "import { dependencyMarker } from './dependency';",
        { toolCallId: "dependent-consumer-read" },
      );
      childCallbacks.onAssistantFinalText("Consumer validation complete.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });
  const joined = await subagents.waitForCoordinatedSubagents({
    threadId: "thread-dependency-handoff",
    parentTurnId: "turn-dependency-handoff",
    subagentIds: [dependent.subagentId],
  });

  assert.equal(joined.results[0].status, "completed");
  assert.match(dependentPrompt, /Verified dependency evidence/);
  assert.match(dependentPrompt, /dependency-source/);
  assert.match(dependentPrompt, /read_file · src\/dependency\.ts/);
  assert.doesNotMatch(dependentPrompt, /SECRET_CHILD_SUMMARY/);
  assert.doesNotMatch(dependentPrompt, /PRIVATE_PARENT_TRANSCRIPT/);
});

test("runtime wait treats an unmatched model ID as all registered children without another model iteration", async () => {
  subagents.resetSubagentRuntimeForTests();
  let releaseChild;
  const completion = new Promise((resolve) => { releaseChild = resolve; });
  subagents.registerCoordinatedSubagentRun({
    threadId: "thread-runtime-wait",
    parentTurnId: "turn-runtime-wait",
    subagentId: "subagent-runtime-wait",
    name: "Euler",
    scopeKey: "runtime-wait",
    runId: "run-subagent-runtime-wait",
    parentRunId: "run-parent-runtime-wait",
    completion,
  });

  let settled = false;
  const waiting = subagents.waitForCoordinatedSubagents({
    threadId: "thread-runtime-wait",
    parentTurnId: "turn-runtime-wait",
    // Models sometimes spell an all-children request as a value even though
    // the schema says to omit this field. The runtime ledger remains authority.
    subagentIds: ["all"],
  }).finally(() => { settled = true; });

  let eventLoopAdvanced = false;
  await new Promise((resolve) => setTimeout(() => {
    eventLoopAdvanced = true;
    resolve();
  }, 0));
  assert.equal(eventLoopAdvanced, true, "awaiting a child must yield to the UI event loop");
  assert.equal(settled, false, "an unmatched ID must not return an empty join result");

  releaseChild({
    subagentId: "subagent-runtime-wait",
    name: "Euler",
    scopeKey: "runtime-wait",
    status: "completed",
    summary: "The registered child completed.",
    summaryTrust: "unverified_hypothesis",
    evidence: [],
    closureAudit: makeSubagentClosure({
      scopeKey: "runtime-wait",
      owner: {
        threadId: "thread-runtime-wait",
        parentTurnId: "turn-runtime-wait",
        subagentId: "subagent-runtime-wait",
        runId: "run-subagent-runtime-wait",
        parentRunId: "run-parent-runtime-wait",
      },
    }),
  });
  const joined = await waiting;
  assert.deepEqual(joined.results.map((entry) => entry.subagentId), ["subagent-runtime-wait"]);
  assert.deepEqual(joined.pendingIds, []);
});

test("a one-shot subagent identity cannot be replaced or reactivated", async () => {
  subagents.resetSubagentRuntimeForTests();
  const threadId = "thread-one-shot";
  const sessionEpoch = "epoch-one-shot";
  const parentTurnId = "turn-one-shot";
  const subagentId = "subagent-one-shot";
  let resolveRun;
  const completion = new Promise((resolve) => { resolveRun = resolve; });
  const result = {
    subagentId,
    name: "Noether",
    scopeKey: "one-shot",
    status: "completed",
    summary: "The immutable task completed.",
    summaryTrust: "unverified_hypothesis",
    evidence: [],
    closureAudit: makeSubagentClosure({
      scopeKey: "one-shot",
      owner: {
        threadId,
        parentTurnId,
        subagentId,
        runId: "run-one-shot",
        parentRunId: "run-parent-one-shot",
      },
    }),
  };

  subagents.acquireSubagentScopeLease({
    threadId,
    sessionEpoch,
    parentTurnId,
    subagentId,
    generation: "generation-one-shot",
    scopeKey: "one-shot",
    workspace: "/workspace",
    allowedPaths: ["src/one-shot.ts"],
    createdAt: Date.now(),
  });
  const registration = {
    threadId,
    sessionEpoch,
    parentTurnId,
    subagentId,
    generation: "generation-one-shot",
    name: "Noether",
    scopeKey: "one-shot",
    runId: "run-one-shot",
    parentRunId: "run-parent-one-shot",
    completion,
  };
  subagents.registerCoordinatedSubagentRun(registration);
  assert.throws(
    () => subagents.registerCoordinatedSubagentRun(registration),
    /SUBAGENT_ID_ALREADY_REGISTERED/,
  );

  resolveRun(result);
  const joined = await subagents.waitForCoordinatedSubagents({
    threadId,
    sessionEpoch,
    parentTurnId,
  });
  assert.deepEqual(
    joined.results.map((entry) => entry.summary),
    ["The immutable task completed."],
  );
  assert.deepEqual(joined.pendingIds, []);
  assert.equal(subagents.findSubagentScopeConflict({
    threadId,
    sessionEpoch,
    targetPath: "src/one-shot.ts",
  }), null);
  assert.throws(
    () => subagents.registerCoordinatedSubagentRun({
      ...registration,
      completion: Promise.resolve(result),
    }),
    /SUBAGENT_ID_ALREADY_REGISTERED/,
    "a consumed closed identity must never be reactivated",
  );
});

test("coordination registry isolates identical child identities across session epochs", async () => {
  subagents.resetSubagentRuntimeForTests();
  const threadId = "thread-epoch-fence";
  const parentTurnId = "turn-epoch-fence";
  const subagentId = "subagent-epoch-fence";
  const makeResult = (epoch) => ({
    subagentId,
    name: "Curie",
    scopeKey: epoch,
    status: "completed",
    summary: `${epoch} completed.`,
    summaryTrust: "unverified_hypothesis",
    evidence: [],
    closureAudit: makeSubagentClosure({
      scopeKey: epoch,
      owner: {
        threadId,
        parentTurnId,
        subagentId,
        runId: `run-${epoch}`,
        parentRunId: null,
      },
    }),
  });
  for (const epoch of ["epoch-a", "epoch-b"]) {
    subagents.registerCoordinatedSubagentRun({
      threadId,
      sessionEpoch: epoch,
      parentTurnId,
      subagentId,
      generation: `generation-${epoch}`,
      name: "Curie",
      scopeKey: epoch,
      runId: `run-${epoch}`,
      parentRunId: null,
      completion: Promise.resolve(makeResult(epoch)),
    });
  }

  const epochAJoin = await subagents.waitForCoordinatedSubagents({
    threadId,
    sessionEpoch: "epoch-a",
    parentTurnId,
  });
  assert.deepEqual(epochAJoin.results.map((entry) => entry.summary), ["epoch-a completed."]);
  assert.deepEqual(
    subagents.getPendingCoordinatedSubagentIds(threadId, parentTurnId, "epoch-b"),
    [subagentId],
  );
  assert.equal(subagents.getCoordinatedSubagentRunCount(threadId, parentTurnId, "epoch-a"), 0);
  assert.equal(
    subagents.getCoordinatedSubagentRunCount(threadId, parentTurnId, "epoch-b"),
    0,
    "terminal children leave the active registry immediately even before their result is joined",
  );

  const epochBJoin = await subagents.waitForCoordinatedSubagents({
    threadId,
    sessionEpoch: "epoch-b",
    parentTurnId,
  });
  assert.deepEqual(epochBJoin.results.map((entry) => entry.summary), ["epoch-b completed."]);
});

test("an explicit all token dominates a simultaneously valid subset", async () => {
  subagents.resetSubagentRuntimeForTests();
  const threadId = "thread-mixed-all";
  const parentTurnId = "turn-mixed-all";
  const makeResult = (subagentId) => ({
    subagentId,
    name: subagentId,
    scopeKey: subagentId,
    status: "completed",
    summary: `${subagentId} completed.`,
    summaryTrust: "unverified_hypothesis",
    evidence: [],
    closureAudit: makeSubagentClosure({
      scopeKey: subagentId,
      owner: {
        threadId,
        parentTurnId,
        subagentId,
        runId: `run-${subagentId}`,
        parentRunId: null,
      },
    }),
  });
  for (const subagentId of ["subagent-one", "subagent-two"]) {
    subagents.registerCoordinatedSubagentRun({
      threadId,
      parentTurnId,
      subagentId,
      name: subagentId,
      scopeKey: subagentId,
      completion: Promise.resolve(makeResult(subagentId)),
    });
  }
  const joined = await subagents.waitForCoordinatedSubagents({
    threadId,
    parentTurnId,
    subagentIds: ["all", "subagent-one"],
  });
  assert.deepEqual(
    joined.results.map((entry) => entry.subagentId).sort(),
    ["subagent-one", "subagent-two"],
  );
  assert.deepEqual(joined.pendingIds, []);
});

test("runtime wait never projects a model-only stale ID as pending Turn work", async () => {
  subagents.resetSubagentRuntimeForTests();
  const joined = await subagents.waitForCoordinatedSubagents({
    threadId: "thread-no-live-child",
    parentTurnId: "turn-no-live-child",
    subagentIds: ["subagent-model-only-stale-id"],
  });
  assert.deepEqual(joined, { results: [], pendingIds: [] });
});

test("runtime wait reports unconsumed siblings and redirects a stale subset to the live Turn ledger", async () => {
  subagents.resetSubagentRuntimeForTests();
  const makeResult = (subagentId, scopeKey) => ({
    subagentId,
    name: subagentId,
    scopeKey,
    status: "completed",
    summary: `${subagentId} completed.`,
    summaryTrust: "unverified_hypothesis",
    evidence: [],
    closureAudit: makeSubagentClosure({
      scopeKey,
      owner: {
        threadId: "thread-subset-wait",
        parentTurnId: "turn-subset-wait",
        subagentId,
        runId: `run-${subagentId}`,
        parentRunId: null,
      },
    }),
  });
  let releaseSecond;
  subagents.registerCoordinatedSubagentRun({
    threadId: "thread-subset-wait",
    parentTurnId: "turn-subset-wait",
    subagentId: "subagent-first",
    name: "First",
    scopeKey: "first-scope",
    completion: Promise.resolve(makeResult("subagent-first", "first-scope")),
  });
  subagents.registerCoordinatedSubagentRun({
    threadId: "thread-subset-wait",
    parentTurnId: "turn-subset-wait",
    subagentId: "subagent-second",
    name: "Second",
    scopeKey: "second-scope",
    completion: new Promise((resolve) => { releaseSecond = resolve; }),
  });

  const firstJoin = await subagents.waitForCoordinatedSubagents({
    threadId: "thread-subset-wait",
    parentTurnId: "turn-subset-wait",
    subagentIds: ["subagent-first"],
  });
  assert.deepEqual(firstJoin.results.map((entry) => entry.subagentId), ["subagent-first"]);
  assert.deepEqual(firstJoin.pendingIds, ["subagent-second"]);

  let staleJoinSettled = false;
  const staleJoin = subagents.waitForCoordinatedSubagents({
    threadId: "thread-subset-wait",
    parentTurnId: "turn-subset-wait",
    subagentIds: ["subagent-first"],
  }).finally(() => { staleJoinSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(staleJoinSettled, false);

  releaseSecond(makeResult("subagent-second", "second-scope"));
  const secondJoin = await staleJoin;
  assert.deepEqual(secondJoin.results.map((entry) => entry.subagentId), ["subagent-second"]);
  assert.deepEqual(secondJoin.pendingIds, []);
});

test("runtime wait is abortable without consuming a child result", async () => {
  subagents.resetSubagentRuntimeForTests();
  let releaseChild;
  const completion = new Promise((resolve) => { releaseChild = resolve; });
  subagents.registerCoordinatedSubagentRun({
    threadId: "thread-abort-wait",
    parentTurnId: "turn-abort-wait",
    subagentId: "subagent-abort-wait",
    name: "Noether",
    scopeKey: "abort-wait",
    completion,
  });
  const controller = new AbortController();
  const waiting = subagents.waitForCoordinatedSubagents({
    threadId: "thread-abort-wait",
    parentTurnId: "turn-abort-wait",
    signal: controller.signal,
  }).then(
    () => "resolved",
    (error) => error?.name || "rejected",
  );

  controller.abort();
  releaseChild({
    subagentId: "subagent-abort-wait",
    name: "Noether",
    scopeKey: "abort-wait",
    status: "completed",
    summary: "Completed after the parent canceled its wait.",
    summaryTrust: "unverified_hypothesis",
    evidence: [],
    closureAudit: makeSubagentClosure({
      scopeKey: "abort-wait",
      owner: {
        threadId: "thread-abort-wait",
        parentTurnId: "turn-abort-wait",
        subagentId: "subagent-abort-wait",
        runId: "run-subagent-abort-wait",
        parentRunId: null,
      },
    }),
  });
  assert.equal(await waiting, "AbortError");
  await completion;
  await Promise.resolve();
  assert.deepEqual(
    subagents.getPendingCoordinatedSubagentIds("thread-abort-wait", "turn-abort-wait"),
    ["subagent-abort-wait"],
    "an aborted parent wait must not consume a late child result",
  );
  const recoveredJoin = await subagents.waitForCoordinatedSubagents({
    threadId: "thread-abort-wait",
    parentTurnId: "turn-abort-wait",
  });
  assert.deepEqual(recoveredJoin.results.map((entry) => entry.subagentId), ["subagent-abort-wait"]);
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
    closureAudit: makeSubagentClosure({
      scopeKey: "ready-result",
      owner: {
        threadId: "thread-ready",
        parentTurnId: "turn-ready",
        subagentId: "subagent-ready",
        runId: "run-subagent-ready",
        parentRunId: null,
      },
    }),
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

test("parent join fails closed for missing and tampered child closure envelopes", async () => {
  for (const variant of ["missing", "tampered_owner"]) {
    subagents.resetSubagentRuntimeForTests();
    const subagentId = `subagent-join-${variant}`;
    const threadId = `thread-join-${variant}`;
    const parentTurnId = `turn-join-${variant}`;
    const scopeKey = `scope-join-${variant}`;
    const rawResult = {
      subagentId,
      name: "Noether",
      scopeKey,
      status: "completed",
      summary: variant === "missing"
        ? "No remaining work."
        : "无剩余工作。",
      summaryTrust: "unverified_hypothesis",
      evidence: [],
      ...(variant === "tampered_owner"
        ? {
            closureAudit: makeSubagentClosure({
              scopeKey,
              owner: {
                threadId,
                parentTurnId,
                subagentId: "subagent-foreign-owner",
                runId: `run-${subagentId}`,
                parentRunId: null,
              },
            }),
          }
        : {}),
    };
    subagents.registerCoordinatedSubagentRun({
      threadId,
      parentTurnId,
      subagentId,
      name: "Noether",
      scopeKey,
      objective: "Inspect the exact joined scope",
      runId: `run-${subagentId}`,
      parentRunId: null,
      completion: Promise.resolve(rawResult),
    });

    const joined = await subagents.waitForCoordinatedSubagents({
      threadId,
      parentTurnId,
      subagentIds: [subagentId],
    });
    assert.equal(joined.results[0].status, "blocked", variant);
    assert.equal(joined.results[0].closureAudit.state, "blocked", variant);
    assert.equal(joined.results[0].closureAudit.reasonCode, "invalid_closure_envelope", variant);
    assert.equal(joined.results[0].closureAudit.owner.subagentId, subagentId, variant);
    assert.equal(joined.results[0].remainingWork, "Inspect the exact joined scope", variant);
    assert.match(joined.results[0].error || "", /SUBAGENT_CLOSURE_CONTRACT_INVALID/, variant);
  }
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
          parentHandoff: "Replace the unrelated status bar implementation.",
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
              factReferences: Array.from({ length: 80 }, (_unused, index) => ({
                fact: `event-contract-${index}`,
                sourceToolCallId: "child-read-events",
                sourceObservationKey: "read_file::src/lib/turnEvents.ts::v1",
                sourceVersion: "v1",
              })),
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

  assert.equal(joined.joined, true);
  assert.equal(joined.adoptedEvidenceCount, 1);
  assert.equal(joined.sourceEvidenceCount, 1);
  assert.deepEqual(joined.requestedIds, ["subagent-euler", "subagent-mendel"]);
  assert.deepEqual(joined.resultIds, ["subagent-euler"]);
  assert.match(messages[0].content, /SUBAGENT_JOIN_RESULT/);
  assert.match(messages[0].content, /unverified recommendations/);
  assert.match(messages[0].content, /targeted parent read_file/);
  assert.match(messages[0].content, /src\/lib\/turnEvents\.ts/);
  assert.doesNotMatch(messages[0].content, /Found the event boundary/);
  assert.doesNotMatch(messages[0].content, /Replace the unrelated status bar/);
  assert.doesNotMatch(messages[0].content, /factReferences/);
  assert.equal(messages[0].content.length < 6_000, true);
  assert.deepEqual(recent.map((entry) => [entry.name, entry.target]), [["read_file", "src/lib/turnEvents.ts"]]);
  assert.equal(recent[0].readFileObservation, undefined);
  assert.equal(recent[0].delegatedObservation.owner.subagentId, "subagent-euler");
  assert.equal(recent[0].delegatedObservation.requiresParentReread, true);
  assert.deepEqual(recentPlan, recent);
  assert.deepEqual(events.map((entry) => entry.event), ["parent_join_required", "parent_join_injected"]);
  assert.equal(events[1].data.internalPayloadChars > events[1].data.modelPayloadChars, true);
});

test("runtime parent join preserves a joined result without claiming empty evidence was consumed", async () => {
  const messages = [];
  const events = [];
  const recent = [];
  const recentPlan = [];
  const joinResult = await subagentJoinRuntime.joinPendingSubagentsForParent({
    callbacks: {
      getPendingSubagentIds: () => ["subagent-empty"],
      waitSubagents: async () => ({
        pendingIds: [],
        results: [{
          subagentId: "subagent-empty",
          name: "Noether",
          scopeKey: "empty-result",
          status: "completed",
          summary: "No tool-backed observations were produced.",
          summaryTrust: "unverified_hypothesis",
          evidence: [],
        }],
      }),
      getPreferredLanguage: () => "en",
      appendMessage: (message) => messages.push(message),
      onDebugEvent: (event, data) => events.push({ event, data }),
    },
    recentToolActivity: recent,
    recentPlanToolActivity: recentPlan,
    reason: "plan_finalization",
  });

  assert.deepEqual(joinResult, {
    joined: true,
    requestedIds: ["subagent-empty"],
    resultIds: ["subagent-empty"],
    adoptedEvidenceCount: 0,
    sourceEvidenceCount: 0,
    requiredParentRereads: 0,
    adoptedMutationEvidenceCount: 0,
    adoptedMutationTargets: [],
    taskOutcomes: [],
  });
  assert.equal(messages.length, 1, "the parent still receives the joined child result");
  assert.deepEqual(recent, []);
  assert.deepEqual(recentPlan, []);
  assert.equal(events[1].data.evidenceCount, 0);
  assert.equal(events[1].data.provenanceBackedEvidenceCount, 0);
});

test("runtime parent join retains the bounded Plan evidence ledger beyond recent activity", async () => {
  const recent = [];
  const recentPlan = [];
  const evidence = Array.from({ length: 20 }, (_unused, index) => ({
    tool: "read_file",
    target: `src/owner-${index}.ts`,
    detail: `Observed owner ${index} contract.`,
    provenance: {
      source: "tool_observation",
      owner: { agentKind: "subagent", subagentId: "subagent-ledger" },
      sourceToolCallId: `child-read-${index}`,
    },
  }));
  evidence.push({
    tool: "read_file",
    target: "src/owner-19.ts",
    detail: "Observed the latest owner 19 contract detail.",
    provenance: {
      source: "tool_observation",
      owner: { agentKind: "subagent", subagentId: "subagent-ledger" },
      sourceToolCallId: "child-read-19-replay",
    },
  });

  const joined = await subagentJoinRuntime.joinPendingSubagentsForParent({
    callbacks: {
      getPendingSubagentIds: () => ["subagent-ledger"],
      waitSubagents: async () => ({
        pendingIds: [],
        results: [{
          subagentId: "subagent-ledger",
          name: "Ledger",
          scopeKey: "many-owners",
          status: "completed",
          summary: "Observed many independent owners.",
          summaryTrust: "unverified_hypothesis",
          evidence,
        }],
      }),
      getPreferredLanguage: () => "en",
      appendMessage: () => {},
    },
    recentToolActivity: recent,
    recentPlanToolActivity: recentPlan,
    reason: "plan_finalization",
  });

  assert.equal(joined.sourceEvidenceCount, 21);
  assert.equal(joined.adoptedEvidenceCount, 20);
  assert.equal(recent.length, 12, "ordinary recent activity keeps its UI/context bound");
  assert.equal(recentPlan.length, 20, "Plan evidence keeps the larger ledger bound");
  assert.equal(recentPlan.some((entry) => entry.target === "src/owner-0.ts"), true);
  assert.match(
    recentPlan.find((entry) => entry.target === "src/owner-19.ts")?.detail || "",
    /latest owner 19/,
  );
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

test("wall-clock timeout preserves substantive observations as a partial handoff", () => {
  assert.equal(subagentRuntime.resolveTimedOutSubagentEvidenceStatus({
    status: "blocked",
    wallClockTimedOut: true,
    substantiveEvidenceCount: 8,
  }), "degraded");
  assert.equal(subagentRuntime.resolveTimedOutSubagentEvidenceStatus({
    status: "blocked",
    wallClockTimedOut: true,
    substantiveEvidenceCount: 0,
  }), "blocked");
  assert.equal(subagentRuntime.resolveTimedOutSubagentEvidenceStatus({
    status: "blocked",
    wallClockTimedOut: false,
    substantiveEvidenceCount: 8,
  }), "blocked");
  assert.equal(subagentRuntime.resolveTimedOutSubagentEvidenceStatus({
    status: "canceled",
    wallClockTimedOut: true,
    substantiveEvidenceCount: 8,
  }), "canceled");
});

test("a stream failure after substantive child evidence preserves that evidence for parent join", async () => {
  subagents.resetSubagentRuntimeForTests();
  const traceEvents = [];
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      objective: "Inspect the toolbar implementation",
      scopeKey: "toolbar-source",
      scope: "One exact source file",
      allowedPaths: "src/components/toolbar.js",
      expectedOutput: "Source-backed findings",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-stream-failure",
      getMessages: () => [],
      onDebugEvent: (event, data) => traceEvents.push({ event, data }),
    },
    parentTurnId: "turn-stream-failure",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/components/toolbar.js",
        "The toolbar click handler delegates file selection to the runtime-owned open path.",
      );
      throw new Error("STREAM_VISIBLE_TEXT_REPETITION: repeated summary suffix");
    },
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.closureAudit.state, "partial");
  assert.equal(result.closureAudit.reasonCode, "runtime_partial_failure");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].target, "src/components/toolbar.js");
  assert.ok(traceEvents.some((entry) =>
    entry.event === "subagent_partial_evidence_preserved_after_runtime_failure"
  ));

  const adopted = toolActivityTracking.extractDelegatedSubagentActivities({
    toolCallId: "wait-stream-failure",
    name: "wait_subagents",
    target: result.subagentId,
    content: JSON.stringify({ pendingIds: [], results: [result] }),
    isError: false,
    lifecycleState: "completed",
  }, { evidenceLedger: true });
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].target, "src/components/toolbar.js");
  assert.equal(adopted[0].delegatedObservation.closureState, "partial");
});

test("a partial child handoff cannot be promoted by an explicit no-remaining-work report", async () => {
  subagents.resetSubagentRuntimeForTests();
  const traceEvents = [];
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      objective: "Inspect a bounded file",
      scopeKey: "bounded-file-complete",
      scope: "One file",
      allowedPaths: "src/lib/subagents.ts",
      expectedOutput: "Source-backed contract finding",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "zh",
      getSessionKey: () => "thread-boundary-complete",
      getMessages: () => [],
      onDebugEvent: (event, data) => traceEvents.push({ event, data }),
    },
    parentTurnId: "turn-boundary-complete",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(childCallbacks, "read_file", "src/lib/subagents.ts", "Coordinator evidence");
      childCallbacks.onAssistantFinalText([
        "## 结论",
        "已核实协调器契约。",
        "## 剩余范围内工作",
        "无。在允许范围内已完成调查。",
        "## 父任务交接",
        "实现修改由父任务决定。",
      ].join("\n"));
      return {
        status: "completed",
        resultKind: "blocked",
        reason: "subagent_max_iterations_partial_handoff",
      };
    },
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.closureAudit?.state, "partial");
  assert.equal(result.closureAudit?.status, "degraded");
  assert.equal(result.closureAudit?.owner.subagentId, result.subagentId);
  assert.match(result.remainingWork || "", /Inspect a bounded file/);
  assert.match(result.parentHandoff || "", /父任务决定/);
  assert.equal(traceEvents.some((entry) => entry.event === "subagent_bounded_handoff_closed"), false);
});

test("Chinese, English, and third-language summaries yield the same typed partial closure", async () => {
  const summaries = [
    "## 剩余范围内工作\n无。已完成调查。",
    "## Remaining In-Scope Work\nNone. The investigation is complete.",
    "Hakuna kazi iliyobaki; uchunguzi umekamilika.",
  ];
  const projections = [];
  for (const [index, summary] of summaries.entries()) {
    subagents.resetSubagentRuntimeForTests();
    const result = await subagentRuntime.executeControlledSubagent({
      request: {
        objective: "Inspect the bounded runtime contract",
        scopeKey: "language-neutral-closure",
        allowedPaths: "src/lib/subagents.ts",
        expectedOutput: "One source-backed contract observation",
      },
      parentCallbacks: {
        getConfig: () => makeConfig("local"),
        getPreferredLanguage: () => "en",
        getSessionKey: () => `thread-language-neutral-${index}`,
        getMessages: () => [],
      },
      parentTurnId: `turn-language-neutral-${index}`,
      existingRunCount: 0,
      emitEvent: () => {},
      executeAgentLoop: async (childCallbacks) => {
        recordChildToolResult(
          childCallbacks,
          "read_file",
          "src/lib/subagents.ts",
          "export const SUBAGENT_CLOSURE_SCHEMA_VERSION = 1;",
        );
        childCallbacks.onAssistantFinalText(summary);
        return {
          status: "completed",
          resultKind: "blocked",
          reason: "subagent_max_iterations_partial_handoff",
        };
      },
    });
    assert.equal(subagents.isAuthoritativeSubagentClosure(result.closureAudit, {
      threadId: `thread-language-neutral-${index}`,
      parentTurnId: `turn-language-neutral-${index}`,
      subagentId: result.subagentId,
      scopeKey: "language-neutral-closure",
    }), true);
    projections.push({
      status: result.status,
      state: result.closureAudit.state,
      closureStatus: result.closureAudit.status,
      remainingWork: result.closureAudit.remainingWork,
      observationCount: result.closureAudit.observationCount,
      substantiveEvidenceCount: result.closureAudit.substantiveEvidenceCount,
      reasonCode: result.closureAudit.reasonCode,
    });
  }

  assert.deepEqual(projections, [projections[0], projections[0], projections[0]]);
  assert.equal(projections[0].status, "degraded");
  assert.equal(projections[0].state, "partial");
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

test("overlapping write leases are a policy deferral rather than a failed spawn", () => {
  subagents.resetSubagentRuntimeForTests();
  subagents.acquireSubagentScopeLease({
    threadId: "thread-overlap",
    parentTurnId: "turn-overlap",
    subagentId: "subagent-existing",
    scopeKey: "existing-scope",
    workspace: "/workspace",
    allowedPaths: ["src/lib/subagents.ts"],
    accessMode: "write",
    createdAt: Date.now(),
  });
  const debugEvents = [];
  const result = subagentRuntime.scheduleControlledSubagent({
    request: {
      name: "Mendel",
      taskKey: "modify-runtime-coordinator",
      taskKind: "implement",
      objective: "Modify the runtime coordinator under an exact write lease",
      delegationReason: "A bounded implementation can proceed independently after diagnosis.",
      successCriteria: "Produce a scoped diff for the coordinator.",
      requiredPaths: "",
      allowedPaths: "src/lib",
      accessMode: "write",
      expectedOutput: "A structured diff and concise implementation summary.",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-overlap",
      getCurrentRunIntent: () => "execute",
      getRuntimeRunIntent: () => "execute",
      getExecutionConsentGranted: () => true,
      getIsPlanApproved: () => false,
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

test("implement tasks cannot acquire a write lease without parent authority", () => {
  subagents.resetSubagentRuntimeForTests();
  let started = false;
  const result = subagentRuntime.scheduleControlledSubagent({
    request: {
      taskKey: "unauthorized-implementation",
      taskKind: "implement",
      objective: "Apply one bounded source correction.",
      delegationReason: "The edit is independently bounded.",
      successCriteria: "Produce a source diff.",
      requiredPaths: "",
      allowedPaths: "src/main.js",
      accessMode: "write",
      expectedOutput: "Structured diff evidence.",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-write-authority",
      getCurrentRunIntent: () => "analyze",
      getRuntimeRunIntent: () => "analyze",
      getExecutionConsentGranted: () => false,
      getIsPlanApproved: () => false,
    },
    parentTurnId: "turn-write-authority",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async () => {
      started = true;
      throw new Error("unauthorized child must not start");
    },
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.reason, "write_not_authorized");
  assert.equal(started, false);
  assert.equal(
    subagents.getCoordinatedSubagentRunCount(
      "thread-write-authority",
      "turn-write-authority",
    ),
    0,
  );
});

test("approved Plan children inherit only exact reviewed write targets", async () => {
  const planTasks = [{
    id: "task-reviewed-main",
    title: "Repair the viewer entry point",
    status: "pending",
    evidence: [{ kind: "file", value: "src/main.js" }],
  }];
  const makeApprovedCallbacks = (threadId) => ({
    getConfig: () => makeConfig("local"),
    getPreferredLanguage: () => "en",
    getSessionKey: () => threadId,
    getMessages: () => [],
    getCurrentRunIntent: () => "execute",
    getRuntimeRunIntent: () => "execute",
    getExecutionConsentGranted: () => false,
    getIsPlanApproved: () => true,
    getPlanTasks: () => planTasks,
  });
  const makeWriteRequest = (allowedPaths) => ({
    taskKey: `approved-write-${allowedPaths}`,
    taskKind: "implement",
    objective: "Apply one reviewed source correction.",
    allowedPaths,
    accessMode: "write",
  });

  for (const [index, allowedPaths] of [
    "src/components/editor.js",
    "src",
  ].entries()) {
    subagents.resetSubagentRuntimeForTests();
    let started = false;
    const deferred = subagentRuntime.scheduleControlledSubagent({
      request: makeWriteRequest(allowedPaths),
      parentCallbacks: makeApprovedCallbacks(`thread-plan-scope-${index}`),
      parentTurnId: `turn-plan-scope-${index}`,
      existingRunCount: 0,
      emitEvent: () => {},
      executeAgentLoop: async () => {
        started = true;
        throw new Error("out-of-scope child must not start");
      },
    });
    assert.equal(deferred.status, "deferred");
    assert.equal(deferred.reason, "write_not_authorized");
    assert.equal(started, false);
  }

  subagents.resetSubagentRuntimeForTests();
  const admitted = subagentRuntime.scheduleControlledSubagent({
    request: makeWriteRequest("src/main.js"),
    parentCallbacks: makeApprovedCallbacks("thread-plan-scope-exact"),
    parentTurnId: "turn-plan-scope-exact",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/main.js",
        "reviewed source",
      );
      childCallbacks.onAssistantFinalText("The reviewed source target was inspected.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });
  assert.equal(admitted.status, "queued");
  await subagents.waitForCoordinatedSubagents({
    threadId: "thread-plan-scope-exact",
    parentTurnId: "turn-plan-scope-exact",
    subagentIds: [admitted.subagentId],
  });
});

test("active parent recovery admits read children but never grants a child write lease", async () => {
  subagents.resetSubagentRuntimeForTests();
  const recoveryCallbacks = {
    getConfig: () => makeConfig("local"),
    getPreferredLanguage: () => "en",
    getSessionKey: () => "thread-recovery-child",
    getMessages: () => [],
    getCurrentRunIntent: () => "execute",
    getRuntimeRunIntent: () => "execute",
    getExecutionConsentGranted: () => true,
    getIsPlanApproved: () => false,
    getPlanTasks: () => [],
    getForcedExecuteRecoveryState: () => ({
      mode: "mutation_first",
      expectedTarget: "src/main.js",
    }),
  };
  const readHandle = subagentRuntime.scheduleControlledSubagent({
    request: {
      objective: "Independently inspect the current recovery target.",
    },
    parentCallbacks: recoveryCallbacks,
    parentTurnId: "turn-recovery-child",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/main.js",
        "recovery source evidence",
      );
      childCallbacks.onAssistantFinalText("The recovery target was inspected.");
      return { status: "completed", reason: "agent_loop_completed" };
    },
  });
  assert.equal(readHandle.status, "queued");
  await subagents.waitForCoordinatedSubagents({
    threadId: "thread-recovery-child",
    parentTurnId: "turn-recovery-child",
    subagentIds: [readHandle.subagentId],
  });

  let writeStarted = false;
  const writeHandle = subagentRuntime.scheduleControlledSubagent({
    request: {
      taskKey: "recovery-write",
      taskKind: "implement",
      objective: "Modify the recovery target.",
      allowedPaths: "src/main.js",
      accessMode: "write",
    },
    parentCallbacks: recoveryCallbacks,
    parentTurnId: "turn-recovery-child",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async () => {
      writeStarted = true;
      throw new Error("recovery child write must not start");
    },
  });
  assert.equal(writeHandle.status, "deferred");
  assert.equal(writeHandle.reason, "write_not_authorized");
  assert.equal(writeStarted, false);
});

test("authorized write children use the direct lease instead of an empty approved Plan", async () => {
  subagents.resetSubagentRuntimeForTests();
  const defaultToolPolicy = {
    autoExecuteRiskLevels: ["read_only", "external_read"],
    approvalRequiredRiskLevels: [
      "local_file_read",
      "workspace_write",
      "shell",
      "external_write",
      "browser_control",
      "destructive",
    ],
    disabledRiskLevels: [],
  };
  let childLedger = [];
  const result = await subagentRuntime.executeControlledSubagent({
    request: {
      taskKey: "repair-main-viewer",
      taskKind: "implement",
      objective: "Apply one exact source correction in the viewer entry point.",
      delegationReason: "The edit is bounded to one independently owned file.",
      successCriteria: "Return a structured diff for src/main.js.",
      requiredPaths: "src/main.js",
      allowedPaths: "src/main.js",
      accessMode: "write",
      expectedOutput: "Source-backed read and mutation evidence.",
    },
    parentCallbacks: {
      getConfig: () => makeConfig("local"),
      getPreferredLanguage: () => "en",
      getSessionKey: () => "thread-write-child",
      getMessages: () => [],
      getCurrentRunIntent: () => "execute",
      getRuntimeRunIntent: () => "execute",
      getExecutionConsentGranted: () => true,
      getIsPlanApproved: () => false,
      getApprovedLocalFileReadPaths: () => [],
    },
    parentTurnId: "turn-write-child",
    existingRunCount: 0,
    emitEvent: () => {},
    executeAgentLoop: async (childCallbacks) => {
      assert.equal(childCallbacks.getIsPlanApproved(), false);
      assert.deepEqual(childCallbacks.getPlanTasks(), []);
      assert.deepEqual(childCallbacks.getAutoApproveToolScopes(), ["workspace_write"]);

      const planned = runtimeTools.planRuntimeToolCall({
        toolCall: {
          id: "replace-main",
          name: "replace_in_file",
          arguments: JSON.stringify({
            path: "src/main.js",
            search_text: "const before = true;",
            replace_text: "const before = false;",
          }),
        },
        workspace: "/workspace",
        availableToolNames: new Set(["read_file", "replace_in_file"]),
        capabilityRegistry: {
          tools: {
            replace_in_file: {
              source: "built_in",
              risk: "workspace_write",
              autoExecutable: false,
              enabled: true,
            },
          },
          policy: defaultToolPolicy,
        },
        toolPermissionPolicy: defaultToolPolicy,
        approvedLocalFileReadPaths: [],
        autoApproveToolScopes: childCallbacks.getAutoApproveToolScopes(),
        workflowMode: childCallbacks.getWorkflowMode(),
        runtimeIntent: childCallbacks.getRuntimeRunIntent(),
        isPlanApproved: childCallbacks.getIsPlanApproved(),
        planTaskCount: childCallbacks.getPlanTasks().length,
        getToolTarget: (_name, args) => String(args.path || ""),
        isPreApprovalPlanDraftWrite: () => false,
        isExecutionPlanArtifactWrite: () => false,
        isTasksPlanWrite: () => false,
      });
      assert.equal(planned.action, "auto_execute");
      assert.notEqual(planned.reason, "missing_tasks_before_source");

      recordChildToolResult(
        childCallbacks,
        "read_file",
        "src/main.js",
        "const before = true;",
      );
      childCallbacks.onToolDone(
        "replace_in_file",
        "src/main.js",
        "Updated src/main.js",
        {
          toolCallId: "replace-main",
          executionName: "replace_in_file",
          executedArgs: {
            path: "src/main.js",
            search_text: "const before = true;",
            replace_text: "const before = false;",
          },
          diff: {
            path: "src/main.js",
            old: "const before = true;",
            new: "const before = false;",
          },
        },
      );
      childCallbacks.onToolResultObserved?.({
        toolCallId: "replace-main",
        name: "replace_in_file",
        target: "src/main.js",
        content: "Updated src/main.js",
        isError: false,
        workspaceMutationEvidence: {
          changedPaths: ["src/main.js"],
          diff: {
            path: "src/main.js",
            old: "const before = true;",
            new: "const before = false;",
          },
        },
      });
      childLedger = childCallbacks.getPlanExecutionEvidenceLedger();
      childCallbacks.onAssistantFinalText([
        "## Findings",
        "Applied the exact replacement in src/main.js.",
        "## Uncertainty",
        "None.",
        "## Remaining In-Scope Work",
        "None.",
        "## Parent Handoff",
        "Review the joined diff before closing the parent Turn.",
      ].join("\n"));
      return { status: "completed", resultKind: "success", reason: "agent_loop_completed" };
    },
  });

  assert.equal(childLedger.length, 1);
  assert.equal(childLedger[0].kind, "file");
  assert.equal(childLedger[0].target, "src/main.js");
  assert.equal(result.status, "completed");
  assert.equal(result.mutationEvidence?.length, 1);
  assert.equal(result.mutationEvidence?.[0]?.target, "src/main.js");
  assert.equal(result.mutationEvidence?.[0]?.transactionId, result.subagentId);
  assert.equal(result.evidence.some((item) =>
    item.tool === "replace_in_file" && item.target === "src/main.js"
  ), true);
  assert.match(result.parentHandoff || "", /parent_validation_required/);
});

test("scope leases reject child escape and serialize only conflicting access modes", () => {
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
  }), null);
  assert.equal(subagents.findSubagentLeaseOverlap({
    threadId: "thread-scope",
    workspace: "/workspace",
    allowedPaths: ["other/../src/lib"],
  }), null);
  assert.equal(subagents.findSubagentLeaseOverlap({
    threadId: "thread-scope",
    workspace: "/workspace",
    allowedPaths: ["src/lib"],
    accessMode: "write",
  })?.subagentId, "subagent-scope");
  assert.equal(subagents.findSubagentLeaseOverlap({
    threadId: "thread-scope",
    workspace: "/workspace",
    allowedPaths: ["src/components"],
  }), null);
});

test("subagent source contracts gate read and approved write tasks while keeping UI activity clickable", () => {
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
    "apply_patch",
    "replace_in_file",
    "write_file",
  ]) {
    assert.match(registrySource, new RegExp(`"${toolName}"`));
  }
  assert.match(registrySource, /subagentAccessMode === "write"/);
  assert.match(registrySource, /mcpServers\.length > 0 && subagentDepth === 0/);
  assert.match(subagentRuntimeSource, /onToolSurfaceResolved: undefined/);
  assert.doesNotMatch(subagentRuntimeSource, /\.\.\.input\.parentCallbacks/);
  assert.match(subagentRuntimeSource, /getForcedExecuteRecoveryState: \(\) => null/);
  assert.match(subagentRuntimeSource, /onExecuteRecoveryStateChange: undefined/);
  assert.match(
    partitionSource,
    /tc\.name === "spawn_subagent"[\s\S]*tc\.name === "wait_subagents"[\s\S]*tc\.name === "cancel_subagent"[\s\S]*readOnlyCalls\.push[\s\S]*continue;/,
  );
  assert.match(chatSource, /data-testid="subagent-activity-notice"/);
  assert.match(chatSource, /openSubagentsPanel/);
  assert.match(panelSource, /rightPanelTab === "subagents"/);
  assert.match(panelSource, /<SubagentsPanel/);
  assert.match(schemaSource, /name: "spawn_subagent"/);
  assert.match(schemaSource, /name: "wait_subagents"/);
  assert.match(workflowSource, /run\.parentTurnId !== currentParentTurnId/);
  assert.match(workflowSource, /return prepareSubagentsForNewTurn\(\)\.then\(executeDurablyAdmittedLoop\)/);
  assert.match(workflowSource, /subagent_new_turn_preflight/);
  const debugLogSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/debugLog.ts"), "utf8");
  assert.match(debugLogSource, /source === "agent\.iteration_start"/);
  assert.match(debugLogSource, /source === "agent\.context_pack_built"/);
  assert.match(debugLogSource, /source === "agent\.stream_low_content_diagnostic"/);
});
