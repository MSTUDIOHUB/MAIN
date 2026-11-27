import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fsSync.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fsSync.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  cache.set(normalized, module.exports);
  return module.exports;
}

const lanes = loadTs(path.join(workspaceRoot, "src/lib/modelLaneCoordinator.ts"));
const appConfig = loadTs(path.join(workspaceRoot, "src/lib/appConfig.ts"));
const estimateLib = loadTs(path.join(workspaceRoot, "src/lib/localConcurrencyEstimate.ts"));
const configSlice = loadTs(path.join(workspaceRoot, "src/store/slices/configSlice.ts"));

function localConfig(maxActiveRequests) {
  return {
    activeProfile: "local",
    local: {
      provider: "local-provider",
      endpoint: "http://127.0.0.1:8000/v1",
      model: "fixture-model",
      ...(maxActiveRequests ? { maxActiveRequests } : {}),
    },
    cloud: {},
    cloudServers: [],
    activeCloudServerId: "",
  };
}

test("lane identity canonicalizes endpoint routing without retaining credentials", () => {
  const withSecrets = localConfig();
  withSecrets.local.endpoint =
    "HTTP://user:super-secret@127.0.0.1:8000/v1/?api_key=also-secret#fragment";
  const canonical = localConfig();
  canonical.local.endpoint = "http://127.0.0.1:8000/v1";

  const secretKey = appConfig.resolveRuntimeLaneKey(withSecrets);
  assert.equal(secretKey, appConfig.resolveRuntimeLaneKey(canonical));
  assert.doesNotMatch(secretKey, /super-secret|also-secret|user/i);
});

test("unknown local lanes expose one memory-guarded overlap probe", () => {
  lanes.resetModelLaneCoordinatorForTests();
  const unknown = lanes.getModelLaneCapacityObservation(localConfig());
  assert.equal(unknown.configured, false);
  assert.equal(unknown.maxActiveRequests, 2);
  assert.equal(unknown.maxActiveSubagents, 1);
  assert.equal(unknown.requestMode, "parallel");

  const configuredSerial =
    lanes.getModelLaneCapacityObservation(localConfig(1));
  assert.equal(configuredSerial.configured, true);
  assert.equal(configuredSerial.maxActiveRequests, 1);
  assert.equal(configuredSerial.maxActiveSubagents, 0);
  assert.equal(configuredSerial.requestMode, "serialized");

  const configured =
    lanes.getModelLaneCapacityObservation(localConfig(4));
  assert.equal(configured.configured, true);
  assert.equal(configured.maxActiveRequests, 4);
  assert.equal(configured.maxActiveSubagents, 3);
  assert.equal(configured.requestMode, "parallel");

  const oversized =
    lanes.getModelLaneCapacityObservation(localConfig(99));
  assert.equal(oversized.configured, true);
  assert.equal(oversized.requestLimitCeiling, 8);
  assert.equal(oversized.maxActiveRequests, 8);
  assert.equal(oversized.maxActiveSubagents, 7);
});

test("an unknown local lane proves overlap at 2 before expanding directly to memory-estimated capacity", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  lanes.setModelLaneStaggerMsForTests(0);
  const events = [];
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: 24,
    total_bytes: 64 * 1024 ** 3,
    available_bytes: 24 * 1024 ** 3,
  }));
  const parent = await lanes.acquireModelLane({
    config: localConfig(),
    requestTokenBudget: 10_000,
    agentKind: "parent",
  });
  let admitted = false;
  const childPromise = lanes.acquireModelLane({
    config: localConfig(),
    requestTokenBudget: 10_000,
    agentKind: "subagent",
    subagentId: "subagent-serial",
    onDebugEvent: (event, data) => events.push({ event, data }),
  }).then((lease) => {
    admitted = true;
    return lease;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admitted, false);
  assert.ok(events.some((entry) =>
    entry.event === "model_lane_admission" &&
    entry.data.decision === "queued" &&
    entry.data.queueReason === "cold_start_first_token" &&
    entry.data.limit === 2
  ));
  parent.markFirstToken();
  const child = await childPromise;
  assert.equal(admitted, true);
  child.markFirstToken();
  const confirmed = lanes.getModelLaneCapacityObservation(localConfig());
  assert.equal(confirmed.maxConfirmedActiveRequests, 2);
  assert.equal(confirmed.maxActiveRequests, 8);
  assert.equal(confirmed.maxActiveSubagents, 7);
  const secondChild = await lanes.acquireModelLane({
    config: localConfig(),
    requestTokenBudget: 10_000,
    agentKind: "subagent",
    subagentId: "subagent-progressive-2",
  });
  secondChild.markFirstToken();
  const expanded = lanes.getModelLaneCapacityObservation(localConfig());
  assert.equal(expanded.maxConfirmedActiveRequests, 3);
  assert.equal(expanded.maxActiveRequests, 8);
  assert.equal(expanded.maxActiveSubagents, 7);
  const thirdChild = await lanes.acquireModelLane({
    config: localConfig(),
    requestTokenBudget: 10_000,
    agentKind: "subagent",
    subagentId: "subagent-progressive-3",
  });
  thirdChild.release();
  secondChild.release();
  child.release();
  parent.release();
});

test("explicit local capacity allows parent and two child model requests to overlap", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  const events = [];
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: 20,
    total_bytes: 64 * 1024 ** 3,
    available_bytes: 20 * 1024 ** 3,
  }));
  const parent = await lanes.acquireModelLane({
    config: localConfig(4),
    contextLimit: 131072,
    requestTokenBudget: 10_000,
    agentKind: "parent",
  });
  let admittedChildren = 0;
  const firstChildPromise = lanes.acquireModelLane({
    config: localConfig(4),
    contextLimit: 131072,
    requestTokenBudget: 10_000,
    agentKind: "subagent",
    subagentId: "subagent-overlap-1",
    onDebugEvent: (event, data) => events.push({ event, data }),
  }).then((lease) => {
    admittedChildren += 1;
    return lease;
  });
  const secondChildPromise = lanes.acquireModelLane({
    config: localConfig(4),
    contextLimit: 131072,
    requestTokenBudget: 10_000,
    agentKind: "subagent",
    subagentId: "subagent-overlap-2",
    onDebugEvent: (event, data) => events.push({ event, data }),
  }).then((lease) => {
    admittedChildren += 1;
    return lease;
  });
  await Promise.resolve();
  assert.equal(admittedChildren, 0);
  parent.markFirstToken();
  const firstChild = await firstChildPromise;
  firstChild.markFirstToken();
  const secondChild = await secondChildPromise;
  secondChild.markFirstToken();
  assert.equal(admittedChildren, 2);
  const observed =
    lanes.getModelLaneCapacityObservation(localConfig(4));
  assert.equal(observed.maxConfirmedActiveRequests, 3);
  assert.equal(observed.maxActiveSubagents, 3);
  assert.ok(events.some((entry) =>
    entry.event === "model_lane_admission" &&
    entry.data.activeRequests === 3 &&
    entry.data.limit === 4
  ));
  assert.ok(events.some((entry) =>
    entry.event === "model_lane_admission" &&
    entry.data.decision === "queued" &&
    entry.data.queueReason === "cold_start_first_token" &&
    entry.data.liveRequests?.some((request) => request.agentKind === "parent")
  ));
  secondChild.release();
  firstChild.release();
  parent.release();
});

test("explicit local capacity admits a fourth model request after healthy overlap", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  const events = [];
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: 24,
    total_bytes: 64 * 1024 ** 3,
    available_bytes: 24 * 1024 ** 3,
  }));
  const parent = await lanes.acquireModelLane({
    config: localConfig(4),
    requestTokenBudget: 10_000,
    agentKind: "parent",
  });
  parent.markFirstToken();
  const firstChild = await lanes.acquireModelLane({
    config: localConfig(4),
    requestTokenBudget: 10_000,
    agentKind: "subagent",
    subagentId: "subagent-burst-1",
  });
  firstChild.markFirstToken();
  const secondChild = await lanes.acquireModelLane({
    config: localConfig(4),
    requestTokenBudget: 10_000,
    agentKind: "subagent",
    subagentId: "subagent-burst-2",
  });
  secondChild.markFirstToken();
  await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 10_000);
  await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 10_000);
  assert.equal(lanes.getModelLaneBurstAdmission(parent.laneKey).allowed, true);

  const thirdChild = await lanes.acquireModelLane({
    config: localConfig(4),
    requestTokenBudget: 10_000,
    agentKind: "subagent",
    subagentId: "subagent-burst-3",
    onDebugEvent: (event, data) => events.push({ event, data }),
  });
  assert.ok(events.some((entry) =>
    entry.event === "model_lane_admission" &&
    entry.data.decision === "admitted" &&
    entry.data.activeRequests === 4 &&
    entry.data.limit === 4
  ));

  thirdChild.release();
  secondChild.release();
  firstChild.release();
  parent.release();
});

test("two local subagent streams overlap using measured request demand instead of full context", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  const events = [];
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: 20,
    total_bytes: 64 * 1024 ** 3,
    available_bytes: 20 * 1024 ** 3,
  }));
  const first = await lanes.acquireModelLane({
    config: localConfig(2),
    contextLimit: 131072,
    requestTokenBudget: 12_000,
    agentKind: "subagent",
    subagentId: "subagent-first",
    onDebugEvent: (event, data) => events.push({ event, data }),
  });
  const secondPromise = lanes.acquireModelLane({
    config: localConfig(2),
    contextLimit: 131072,
    requestTokenBudget: 12_000,
    agentKind: "subagent",
    subagentId: "subagent-second",
    onDebugEvent: (event, data) => events.push({ event, data }),
  });
  first.markFirstToken();
  const second = await secondPromise;

  const admissionSample = events.find((entry) =>
    entry.event === "memory_pressure_sample" && entry.data.phase === "admission"
  );
  assert.ok(admissionSample);
  assert.equal(admissionSample.data.action, "sample");
  assert.ok(admissionSample.data.reserveBytes < 20 * 1024 ** 3);
  assert.ok(events.some((entry) =>
    entry.event === "model_lane_admission" && entry.data.overlapping === true
  ));

  second.release();
  first.release();
});

test("critical admission pressure queues the waiter safely without killing it and runs once parent releases", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  const events = [];
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: 3,
    total_bytes: 64 * 1024 ** 3,
    available_bytes: 3 * 1024 ** 3,
  }));
  const parent = await lanes.acquireModelLane({
    config: localConfig(2),
    contextLimit: 32768,
    agentKind: "parent",
  });
  parent.markFirstToken();
  let childAdmitted = false;
  const childPromise = lanes.acquireModelLane({
    config: localConfig(2),
    contextLimit: 32768,
    agentKind: "subagent",
    subagentId: "subagent-pressure",
    onDebugEvent: (event, data) => events.push({ event, data }),
  }).then((lease) => {
    childAdmitted = true;
    return lease;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(childAdmitted, false);
  assert.ok(events.some((entry) =>
    entry.event === "model_lane_admission" &&
    entry.data.decision === "queued" &&
    (entry.data.queueReason === "memory_reserve" || entry.data.queueReason === "lane_full")
  ));
  parent.release();
  const child = await childPromise;
  assert.equal(childAdmitted, true);
  child.release();
});

test("optional streams skip memory pressure and two independent results can overlap their parent", { timeout: 8_000 }, async () => {
  lanes.resetModelLaneCoordinatorForTests();
  lanes.setModelLaneStaggerMsForTests(0);
  const config = localConfig();
  const gib = 1024 ** 3;
  let availableGb = 8.1;
  const logs = [];
  const parentRunId = "repair-run";
  lanes.setModelLaneMemoryReaderForTests(async () => ({ total_bytes: 68.7 * gib, available_bytes: availableGb * gib }));
  const childPromise = lanes.acquireModelLane({
    config,
    contextLimit: 262_144,
    requestTokenBudget: 262_144,
    agentKind: "subagent",
    optionalOverlap: true,
    parentRunId,
    subagentId: "optional-skip",
    onDebugEvent: (event, data) => logs.push({ event, ...data }),
  });
  const skipped = assert.rejects(childPromise, /memory_reserve/);
  const parent = await lanes.acquireModelLane({
    config,
    contextLimit: 262_144,
    requestTokenBudget: 262_144,
    agentKind: "parent",
    parentRunId,
  });
  let child;
  let sibling;
  try {
    parent.markFirstToken();
    await skipped;
    assert.ok(logs.some(item => item.decision === "skipped" && item.queueReason === "memory_reserve" && Number.isFinite(item.waitMs)));
    availableGb = 30;
    child = await lanes.acquireModelLane({
      config, contextLimit: 262_144, requestTokenBudget: 262_144,
      agentKind: "subagent", optionalOverlap: true, parentRunId, subagentId: "shader-one",
      onDebugEvent: (event, data) => logs.push({ event, ...data }),
    });
    child.markFirstToken();
    sibling = await lanes.acquireModelLane({
      config,
      contextLimit: 262_144,
      requestTokenBudget: 262_144,
      agentKind: "subagent",
      optionalOverlap: true,
      parentRunId,
      subagentId: "shader-two",
      onDebugEvent: (event, data) => logs.push({ event, ...data }),
    });
    sibling.markFirstToken();
    const observed = lanes.getModelLaneCapacityObservation(config);
    assert.equal(observed.maxConfirmedOverlappingChildren, 2);
    assert.equal(observed.maxActiveSubagents, 7);
    assert.deepEqual(logs.filter(item => item.decision === "admitted" && item.overlapsParent).map(item => item.subagentId),
      ["shader-one", "shader-two"]);
  } finally {
    sibling?.release();
    child?.release();
    parent.release();
  }
});

test("an explicit dependency can finish its model request after the parent releases its lane", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  const config = localConfig(2);
  const parentRunId = "r";
  const selected = lanes.acquireModelLane({ config, agentKind: "subagent", parentRunId, subagentId: "s", optionalOverlap: true });
  await new Promise(resolve => setImmediate(resolve));
  lanes.promoteModelLaneSubagentDependency("another-run", "s");
  lanes.promoteModelLaneSubagentDependency(parentRunId, "s");
  const child = await selected;
  child.release();
});

for (const failureMessage of ["OOM", "429 rate limited", "concurrency limit reached"]) {
  test(`capacity failure '${failureMessage}' hands the newest child back before the parent`, async () => {
    lanes.resetModelLaneCoordinatorForTests();
    lanes.setModelLaneMemoryReaderForTests(async () => ({
      total_gb: 64,
      available_gb: 30,
      total_bytes: 64 * 1024 ** 3,
      available_bytes: 30 * 1024 ** 3,
    }));
    const parent = await lanes.acquireModelLane({
      config: localConfig(4),
      contextLimit: 32768,
      agentKind: "parent",
    });
    parent.markFirstToken();
    const firstChild = await lanes.acquireModelLane({
      config: localConfig(4),
      contextLimit: 32768,
      agentKind: "subagent",
      subagentId: "subagent-failure-first",
    });
    firstChild.markFirstToken();
    const secondChild = await lanes.acquireModelLane({
      config: localConfig(4),
      contextLimit: 32768,
      agentKind: "subagent",
      subagentId: "subagent-failure-second",
    });
    let firstChildFailure = null;
    let secondChildFailure = null;
    firstChild.setPressureHandler((error) => { firstChildFailure = error; });
    secondChild.setPressureHandler((error) => { secondChildFailure = error; });
    assert.equal(parent.reportFailure(new Error(failureMessage)), true);
    assert.equal(firstChildFailure, null);
    assert.match(secondChildFailure?.message || "", /SUBAGENT_MEMORY_PRESSURE_DEGRADED/);
    parent.markFirstToken();
    secondChild.release();
    firstChild.release();
    parent.release();
  });
}

test("transport and semantic timeouts do not falsely degrade provider capacity", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  const parent = await lanes.acquireModelLane({
    config: localConfig(),
    contextLimit: 32768,
    agentKind: "parent",
  });
  for (const message of [
    "connection reset",
    "524 gateway timeout",
    "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT",
  ]) {
    assert.equal(parent.reportFailure(new Error(message)), false);
  }
  parent.release();
});

test("a transient memory probe failure recovers without restarting the lane", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  let attempts = 0;
  lanes.setModelLaneMemoryReaderForTests(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary probe failure");
    return {
      total_gb: 64,
      available_gb: 24,
      total_bytes: 64 * 1024 ** 3,
      available_bytes: 24 * 1024 ** 3,
    };
  });
  const parent = await lanes.acquireModelLane({
    config: localConfig(),
    requestTokenBudget: 10_000,
    agentKind: "parent",
  });
  parent.markFirstToken();
  assert.equal(
    await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 10_000),
    false,
  );
  assert.equal(
    lanes.getModelLaneBurstAdmission(parent.laneKey).reason,
    "memory_probe_unavailable",
  );
  assert.equal(
    await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 10_000),
    true,
  );
  assert.notEqual(
    lanes.getModelLaneBurstAdmission(parent.laneKey).reason,
    "memory_probe_unavailable",
  );
  parent.release();
});

test("estimateLocalConcurrencyFromMemory scales across 16G/32G/64G/128G, overrides, and configSlice clearing", async () => {
  const gib = 1024 ** 3;
  const est16Tight = estimateLib.estimateLocalConcurrencyFromMemory({
    totalBytes: 16 * gib,
    availableBytes: 5 * gib,
    contextLimit: 131_072,
  });
  assert.equal(est16Tight.source, "memory");
  assert.equal(est16Tight.totalRequestsLimit, 1);
  assert.equal(est16Tight.recommendedSubagents, 0);
  assert.equal(est16Tight.memoryReserveBytes, 4 * gib);
  assert.equal(est16Tight.criticalMemoryBytes, 4 * gib);

  const est16 = estimateLib.estimateLocalConcurrencyFromMemory({
    totalBytes: 16 * gib,
    availableBytes: 6.5 * gib,
    contextLimit: 131_072,
  });
  assert.equal(est16.totalRequestsLimit, 2);
  assert.equal(est16.recommendedSubagents, 1);

  const est32 = estimateLib.estimateLocalConcurrencyFromMemory({
    totalBytes: 32 * gib,
    availableBytes: 10 * gib,
    contextLimit: 131_072,
  });
  assert.equal(est32.totalRequestsLimit, 3);
  assert.equal(est32.recommendedSubagents, 2);

  const est64 = estimateLib.estimateLocalConcurrencyFromMemory({
    totalBytes: 64 * gib,
    availableBytes: 21 * gib,
    contextLimit: 131_072,
  });
  assert.equal(est64.totalRequestsLimit, 7);
  assert.equal(est64.recommendedSubagents, 6);
  assert.equal(est64.memoryReserveBytes, 64 * gib * 0.10);
  assert.equal(est64.criticalMemoryBytes, 64 * gib * 0.08);
  assert.equal(est64.perStreamBudgetBytes, 2.25 * gib);

  const est128 = estimateLib.estimateLocalConcurrencyFromMemory({
    totalBytes: 128 * gib,
    availableBytes: 64 * gib,
    contextLimit: 150_000,
  });
  assert.equal(est128.totalRequestsLimit, 8);
  assert.equal(est128.recommendedSubagents, 7);
  assert.equal(est128.perStreamBudgetBytes, 2.25 * gib);

  assert.equal(
    estimateLib.estimateLocalConcurrencyFromMemory({ contextLimit: 16_384 }).perStreamBudgetBytes,
    1.75 * gib,
  );
  assert.equal(
    estimateLib.estimateLocalConcurrencyFromMemory({ contextLimit: 262_144 }).perStreamBudgetBytes,
    3.0 * gib,
  );

  const fallback = estimateLib.estimateLocalConcurrencyFromMemory({});
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.totalRequestsLimit, 2);
  assert.equal(fallback.recommendedSubagents, 1);

  const configured = estimateLib.estimateLocalConcurrencyFromMemory({
    totalBytes: 16 * gib,
    availableBytes: 4 * gib,
    configuredMaxActiveRequests: 99,
  });
  assert.equal(configured.source, "configured");
  assert.equal(configured.totalRequestsLimit, 8);
  assert.equal(configured.recommendedSubagents, 7);

  const withOverride = configSlice.normalizeLocalConfig({ maxActiveRequests: 6 });
  assert.equal(withOverride.maxActiveRequests, 6);
  const preserved = configSlice.normalizeLocalConfig({ model: "other" }, withOverride);
  assert.equal(preserved.maxActiveRequests, 6);
  const cleared = configSlice.normalizeLocalConfig(
    { ...withOverride, maxActiveRequests: undefined },
    withOverride,
  );
  assert.equal("maxActiveRequests" in cleared, false);

  lanes.resetModelLaneCoordinatorForTests();
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 16,
    available_gb: 5,
    total_bytes: 16 * gib,
    available_bytes: 5 * gib,
  }));
  const refreshed = await lanes.refreshModelLaneMemorySnapshot();
  assert.equal(refreshed?.total_bytes, 16 * gib);
  assert.equal(lanes.getModelLaneCapacityObservation(localConfig()).maxActiveRequests, 1);
  lanes.primeModelLaneMemorySnapshot({
    total_gb: 64,
    available_gb: 21,
    total_bytes: 64 * gib,
    available_bytes: 21 * gib,
  });
  assert.equal(lanes.getModelLaneCapacityObservation(localConfig()).maxActiveRequests, 2);
});

test("post-cold-start concurrent requests stagger instead of blocking on cold_start_first_token and reach 5-7 parallel streams", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  const gib = 1024 ** 3;
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: 21,
    total_bytes: 64 * gib,
    available_bytes: 21 * gib,
  }));
  lanes.setModelLaneStaggerMsForTests(25);
  const config = {
    ...localConfig(),
    local: { ...localConfig().local, contextLimit: 131_072 },
  };
  const events = [];
  const parent = await lanes.acquireModelLane({
    config,
    contextLimit: 131_072,
    agentKind: "parent",
  });
  const child1Promise = lanes.acquireModelLane({
    config,
    contextLimit: 131_072,
    agentKind: "subagent",
    subagentId: "child-1",
    onDebugEvent: (event, data) => events.push({ event, data }),
  });
  parent.markFirstToken();
  const child1 = await child1Promise;
  child1.markFirstToken();
  assert.equal(lanes.getModelLaneCapacityObservation(config).maxActiveRequests, 7);

  const eventsAfterConfirmStart = events.length;
  const extraChildren = await Promise.all(
    [2, 3, 4, 5, 6].map((idx) =>
      lanes.acquireModelLane({
        config,
        contextLimit: 131_072,
        agentKind: "subagent",
        subagentId: `child-${idx}`,
        onDebugEvent: (event, data) => events.push({ event, data }),
      })
    ),
  );
  const postConfirmEvents = events.slice(eventsAfterConfirmStart);
  assert.ok(
    postConfirmEvents.some((entry) =>
      entry.event === "model_lane_admission" &&
      entry.data.queueReason === "stagger_launch"
    ),
  );
  assert.equal(
    postConfirmEvents.some((entry) =>
      entry.event === "model_lane_admission" &&
      entry.data.queueReason === "cold_start_first_token"
    ),
    false,
    "confirmed concurrency must not block additional subagents on cold_start_first_token",
  );
  assert.equal(extraChildren.length, 5);
  for (const lease of extraChildren.reverse()) lease.release();
  child1.release();
  parent.release();
});

test("soft reserve pressure holds and steps down without killing active or queued children", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  lanes.setModelLaneStaggerMsForTests(0);
  const gib = 1024 ** 3;
  let availableGb = 21;
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: availableGb,
    total_bytes: 64 * gib,
    available_bytes: availableGb * gib,
  }));
  const config = localConfig(7);
  const debugEvents = [];
  const activeAbortErrors = [];
  const parent = await lanes.acquireModelLane({
    config,
    contextLimit: 131_072,
    agentKind: "parent",
    onDebugEvent: (event, data) => debugEvents.push({ event, data }),
  });
  parent.setPressureHandler((err) => activeAbortErrors.push({ id: "parent", err }));
  parent.markFirstToken();

  const activeChildren = [];
  for (let i = 1; i <= 4; i += 1) {
    const child = await lanes.acquireModelLane({
      config,
      contextLimit: 131_072,
      agentKind: "subagent",
      subagentId: `soft-active-${i}`,
      onDebugEvent: (event, data) => debugEvents.push({ event, data }),
    });
    child.setPressureHandler((err) => activeAbortErrors.push({ id: `soft-active-${i}`, err }));
    child.markFirstToken();
    activeChildren.push(child);
  }

  availableGb = 7.0; // between critical (5.12 GiB) and reserve (7.4 GiB)
  const waiterAbort = new AbortController();
  let queuedAdmitted = false;
  let queuedRejected = null;
  const queuedPromise = lanes.acquireModelLane({
    config,
    contextLimit: 131_072,
    agentKind: "subagent",
    subagentId: "soft-queued-waiter",
    signal: waiterAbort.signal,
    onDebugEvent: (event, data) => debugEvents.push({ event, data }),
  }).then((lease) => {
    queuedAdmitted = true;
    return lease;
  }).catch((error) => {
    queuedRejected = error;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queuedAdmitted, false);
  assert.equal(queuedRejected, null);
  assert.ok(debugEvents.some((entry) =>
    entry.event === "model_lane_admission" &&
    entry.data.decision === "queued" &&
    entry.data.queueReason === "memory_reserve"
  ));

  assert.equal(await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 8_192), false);
  assert.equal(await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 8_192), false);
  assert.ok(debugEvents.some((entry) =>
    entry.event === "memory_pressure_sample" &&
    entry.data.action === "step_down" &&
    entry.data.pressureReducedLimit === 6
  ));
  assert.equal(lanes.getModelLaneCapacityObservation(config).maxActiveRequests, 6);
  assert.deepEqual(activeAbortErrors, []);
  assert.equal(queuedRejected, null);

  waiterAbort.abort();
  await queuedPromise;
  assert.equal(queuedRejected?.name, "AbortError");
  for (const child of activeChildren.reverse()) child.release();
  parent.release();
});

test("hard critical pressure aborts only newest active child and never kills queued waiter in async race", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  lanes.setModelLaneStaggerMsForTests(0);
  const gib = 1024 ** 3;
  let availableGb = 24;
  let holdRead = null;
  lanes.setModelLaneMemoryReaderForTests(async () => {
    if (holdRead) {
      await holdRead.promise;
    }
    return {
      total_gb: 64,
      available_gb: availableGb,
      total_bytes: 64 * gib,
      available_bytes: availableGb * gib,
    };
  });
  const config = localConfig();
  const parent = await lanes.acquireModelLane({
    config,
    contextLimit: 131_072,
    agentKind: "parent",
  });
  let parentError = null;
  parent.setPressureHandler((err) => { parentError = err; });
  parent.markFirstToken();

  const child1 = await lanes.acquireModelLane({
    config,
    contextLimit: 131_072,
    agentKind: "subagent",
    subagentId: "critical-older",
  });
  let child1Error = null;
  child1.setPressureHandler((err) => { child1Error = err; });
  child1.markFirstToken();

  const child2 = await lanes.acquireModelLane({
    config,
    contextLimit: 131_072,
    agentKind: "subagent",
    subagentId: "critical-newest",
  });
  let child2Error = null;
  child2.setPressureHandler((err) => { child2Error = err; });
  child2.markFirstToken();

  let resolveHold;
  holdRead = { promise: new Promise((resolve) => { resolveHold = resolve; }) };
  let queuedAdmitted = false;
  let queuedRejected = null;
  const queuedEvents = [];
  const queuedPromise = lanes.acquireModelLane({
    config,
    contextLimit: 131_072,
    agentKind: "subagent",
    subagentId: "critical-queued-waiter",
    onDebugEvent: (event, data) => queuedEvents.push({ event, data }),
  }).then((lease) => {
    queuedAdmitted = true;
    return lease;
  }).catch((error) => {
    queuedRejected = error;
  });

  await new Promise((resolve) => setImmediate(resolve));
  availableGb = 3; // below critical (5.12 GiB)
  holdRead = null;
  resolveHold();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(parentError, null);
  assert.equal(child1Error, null);
  assert.match(child2Error?.message || "", /SUBAGENT_MEMORY_PRESSURE_DEGRADED/);
  assert.equal(queuedRejected, null, "queued waiter must not be killed in critical async race");
  assert.equal(queuedAdmitted, false);
  assert.ok(queuedEvents.some((entry) =>
    entry.event === "model_lane_admission" &&
    entry.data.decision === "queued"
  ));

  availableGb = 24;
  child2.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queuedRejected, null);
  child1.release();
  const queuedLease = await queuedPromise;
  assert.equal(queuedAdmitted, true);
  assert.equal(queuedRejected, null);
  queuedLease.release();
  parent.release();
});

test("elastic recovery restores concurrency after 8 healthy overlap samples or 16s window, and OOM cooldown is 16s", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  lanes.setModelLaneStaggerMsForTests(0);
  const gib = 1024 ** 3;
  let now = 1_000_000;
  lanes.setModelLaneClockForTests(() => now);
  let availableGb = 21;
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: availableGb,
    total_bytes: 64 * gib,
    available_bytes: availableGb * gib,
  }));
  const config = localConfig(7);
  const parent = await lanes.acquireModelLane({
    config,
    contextLimit: 131_072,
    agentKind: "parent",
  });
  parent.markFirstToken();

  const children = [];
  for (let i = 1; i <= 5; i += 1) {
    const child = await lanes.acquireModelLane({
      config,
      contextLimit: 131_072,
      agentKind: "subagent",
      subagentId: `elastic-child-${i}`,
    });
    child.markFirstToken();
    children.push(child);
  }

  availableGb = 7.0;
  await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 8_192);
  await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 8_192);
  assert.equal(lanes.getModelLaneCapacityObservation(config).maxActiveRequests, 6);

  availableGb = 21;
  for (let i = 0; i < 7; i += 1) {
    assert.equal(await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 8_192), true);
    assert.equal(lanes.getModelLaneCapacityObservation(config).maxActiveRequests, 6);
  }
  assert.equal(await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 8_192), true);
  assert.equal(lanes.getModelLaneCapacityObservation(config).maxActiveRequests, 7);

  for (const child of children.slice(1).reverse()) child.release();
  // Active: parent + children[0] (2 active). Trigger hard OOM failure -> 16s cooldown lock to 1 and reduced limit 1.
  assert.equal(parent.reportFailure(new Error("OOM")), true);
  children[0].release();
  assert.equal(lanes.getModelLaneCapacityObservation(config).maxActiveRequests, 1);

  now += 10_000; // 10s < 16s cooldown
  assert.equal(lanes.getModelLaneCapacityObservation(config).maxActiveRequests, 1);

  now += 6_001; // 16.001s -> cooldown expired and recovery window elapsed
  const recoveredChild = await lanes.acquireModelLane({
    config,
    contextLimit: 131_072,
    agentKind: "subagent",
    subagentId: "elastic-post-oom-child",
  });
  assert.equal(lanes.getModelLaneCapacityObservation(config).maxActiveRequests, 2);
  recoveredChild.release();
  parent.release();
});
