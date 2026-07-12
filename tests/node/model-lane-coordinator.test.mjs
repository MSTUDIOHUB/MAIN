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

function localConfig() {
  return {
    activeProfile: "local",
    local: { provider: "OMLX", endpoint: "http://127.0.0.1:8000/v1", model: "qwen" },
    cloud: {},
    cloudServers: [],
    activeCloudServerId: "",
  };
}

test("local parent and one child model request overlap after cold-start admission", async () => {
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
  let childAdmitted = false;
  const childPromise = lanes.acquireModelLane({
    config: localConfig(),
    contextLimit: 32768,
    agentKind: "subagent",
    subagentId: "subagent-overlap",
  }).then((lease) => {
    childAdmitted = true;
    return lease;
  });
  await Promise.resolve();
  assert.equal(childAdmitted, false);
  parent.markFirstToken();
  const child = await childPromise;
  assert.equal(childAdmitted, true);
  child.release();
  parent.release();
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

for (const failureMessage of ["OOM", "connection reset", "429 rate limited", "524 gateway timeout"]) {
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
    const child = await lanes.acquireModelLane({
      config: localConfig(),
      contextLimit: 32768,
      agentKind: "subagent",
      subagentId: "subagent-failure",
    });
    let childFailure = null;
    child.setPressureHandler((error) => { childFailure = error; });
    assert.equal(parent.reportFailure(new Error(failureMessage)), true);
    assert.match(childFailure?.message || "", /SUBAGENT_MEMORY_PRESSURE_DEGRADED/);
    parent.markFirstToken();
    child.release();
    parent.release();
  });
}
