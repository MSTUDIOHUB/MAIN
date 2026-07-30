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

test("unknown lanes expose one empirical child probe while configured capacity reserves the parent", () => {
  lanes.resetModelLaneCoordinatorForTests();
  const unknown = lanes.getModelLaneCapacityObservation(localConfig());
  assert.equal(unknown.configured, false);
  assert.equal(unknown.maxActiveRequests, 2);
  assert.equal(unknown.maxActiveSubagents, 1);

  const configured =
    lanes.getModelLaneCapacityObservation(localConfig(4));
  assert.equal(configured.configured, true);
  assert.equal(configured.maxActiveRequests, 4);
  assert.equal(configured.maxActiveSubagents, 3);

  const oversized =
    lanes.getModelLaneCapacityObservation(localConfig(99));
  assert.equal(oversized.configured, true);
  assert.equal(oversized.requestLimitCeiling, 4);
  assert.equal(oversized.maxActiveRequests, 4);
  assert.equal(oversized.maxActiveSubagents, 3);
});

test("local parent and two child model requests overlap after cold-start admission", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  const events = [];
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: 20,
    total_bytes: 64 * 1024 ** 3,
    available_bytes: 20 * 1024 ** 3,
  }));
  const parent = await lanes.acquireModelLane({
    config: localConfig(),
    contextLimit: 131072,
    requestTokenBudget: 10_000,
    agentKind: "parent",
  });
  let admittedChildren = 0;
  const firstChildPromise = lanes.acquireModelLane({
    config: localConfig(),
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
    config: localConfig(),
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
    lanes.getModelLaneCapacityObservation(localConfig());
  assert.equal(observed.maxConfirmedActiveRequests, 3);
  assert.equal(observed.maxActiveSubagents, 3);
  assert.ok(events.some((entry) =>
    entry.event === "model_lane_admission" &&
    entry.data.activeRequests === 3 &&
    entry.data.limit === 3
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

test("healthy local overlap exposes an elastic fourth model lane for parent plus three children", async () => {
  lanes.resetModelLaneCoordinatorForTests();
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
  parent.markFirstToken();
  const firstChild = await lanes.acquireModelLane({
    config: localConfig(),
    requestTokenBudget: 10_000,
    agentKind: "subagent",
    subagentId: "subagent-burst-1",
  });
  firstChild.markFirstToken();
  const secondChild = await lanes.acquireModelLane({
    config: localConfig(),
    requestTokenBudget: 10_000,
    agentKind: "subagent",
    subagentId: "subagent-burst-2",
  });
  secondChild.markFirstToken();
  await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 10_000);
  await lanes.sampleModelLaneMemoryForTests(parent.laneKey, 10_000);
  assert.equal(lanes.getModelLaneBurstAdmission(parent.laneKey).allowed, true);

  const thirdChild = await lanes.acquireModelLane({
    config: localConfig(),
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
    config: localConfig(),
    contextLimit: 131072,
    requestTokenBudget: 12_000,
    agentKind: "subagent",
    subagentId: "subagent-first",
    onDebugEvent: (event, data) => events.push({ event, data }),
  });
  const secondPromise = lanes.acquireModelLane({
    config: localConfig(),
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

test("critical admission pressure rejects the child while preserving the parent", async () => {
  lanes.resetModelLaneCoordinatorForTests();
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64,
    available_gb: 3,
    total_bytes: 64 * 1024 ** 3,
    available_bytes: 3 * 1024 ** 3,
  }));
  const parent = await lanes.acquireModelLane({
    config: localConfig(),
    contextLimit: 32768,
    agentKind: "parent",
  });
  parent.markFirstToken();
  await assert.rejects(
    lanes.acquireModelLane({
      config: localConfig(),
      contextLimit: 32768,
      agentKind: "subagent",
      subagentId: "subagent-pressure",
    }),
    /SUBAGENT_MEMORY_PRESSURE_DEGRADED/,
  );
  parent.release();
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
      config: localConfig(),
      contextLimit: 32768,
      agentKind: "parent",
    });
    parent.markFirstToken();
    const firstChild = await lanes.acquireModelLane({
      config: localConfig(),
      contextLimit: 32768,
      agentKind: "subagent",
      subagentId: "subagent-failure-first",
    });
    firstChild.markFirstToken();
    const secondChild = await lanes.acquireModelLane({
      config: localConfig(),
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
