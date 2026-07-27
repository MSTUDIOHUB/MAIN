import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, path.join(basePath, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    runtimeRequire,
  );
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const canonical = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/turnRuntimeContract.ts"),
);
const checkpoints = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/turnRuntimeCheckpoint.ts"),
);
const ingress = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/turnIngress.ts"),
);
const guidanceRuntime = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/runtimeGuidance.ts"),
);

const turn = Object.freeze({
  workspaceKey: "/workspace/project",
  sessionKey: "/workspace/project:9",
  sessionEpoch: "epoch-9",
  clientSubmissionId: "submission-9",
  turnId: "turn-9",
});
const run = Object.freeze({
  sessionKey: turn.sessionKey,
  sessionEpoch: turn.sessionEpoch,
  turnId: turn.turnId,
  runId: "run-9",
  parentRunId: null,
  attemptId: "attempt-9",
});
const expectedOwner = Object.freeze({
  workspaceKey: turn.workspaceKey,
  sessionKey: turn.sessionKey,
  sessionEpoch: turn.sessionEpoch,
  turnId: turn.turnId,
});

function apply(state, type, fields, at = state.lastEventAt + 1) {
  const result = canonical.reduceCanonicalTurnRuntime(state, {
    schemaVersion: canonical.TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
    type,
    sequence: state.nextSequence,
    at,
    ...fields,
  });
  assert.equal(result.disposition, "applied", result.reason);
  return result.state;
}

function runningCheckpoint() {
  const admitted = canonical.createCanonicalTurnRuntime({
    turn,
    strategy: "plan",
    admittedAt: 10,
  });
  const running = apply(admitted, "run.started", {
    run,
    phase: "planning",
  }, 11);
  return checkpoints.createTurnRuntimeCheckpoint({ canonical: running });
}

test("production ingress selector exposes Guide only for an exact running Run", () => {
  const checkpoint = runningCheckpoint();
  const running = ingress.selectTurnIngressAvailability({
    checkpoint,
    expectedOwner,
    strategy: "plan",
    runtimeOwnerObserved: true,
  });
  assert.equal(running.mode, "guidance_or_queue");
  assert.deepEqual(running.guidanceTarget, run);

  const finalizingCanonical = apply(checkpoint.canonical, "run.phase_changed", {
    run,
    phase: "finalizing",
  }, 12);
  const finalizing = ingress.selectTurnIngressAvailability({
    checkpoint: checkpoints.createTurnRuntimeCheckpoint({ canonical: finalizingCanonical }),
    expectedOwner,
    strategy: "plan",
    runtimeOwnerObserved: true,
  });
  assert.equal(finalizing.mode, "queue_only");
  assert.equal(finalizing.guidanceTarget, null);

  const pausedCanonical = apply(checkpoint.canonical, "run.paused", {
    run,
    pauseKind: "review",
    reason: "awaiting_plan_review",
  }, 12);
  const paused = ingress.selectTurnIngressAvailability({
    checkpoint: checkpoints.createTurnRuntimeCheckpoint({ canonical: pausedCanonical }),
    expectedOwner,
    strategy: "plan",
    runtimeOwnerObserved: true,
  });
  assert.equal(paused.mode, "queue_only");
  assert.equal(paused.guidanceTarget, null);
});

test("observed owner without an exact checkpoint fails closed to Queue-only", () => {
  assert.equal(ingress.selectTurnIngressAvailability({
    checkpoint: null,
    expectedOwner,
    strategy: "execute",
    runtimeOwnerObserved: true,
  }).mode, "queue_only");
  assert.equal(ingress.selectTurnIngressAvailability({
    checkpoint: null,
    expectedOwner,
    strategy: "execute",
    runtimeOwnerObserved: false,
  }).mode, "submit");

  const staleOwner = { ...expectedOwner, sessionEpoch: "epoch-stale" };
  assert.equal(ingress.selectTurnIngressAvailability({
    checkpoint: runningCheckpoint(),
    expectedOwner: staleOwner,
    strategy: "plan",
    runtimeOwnerObserved: true,
  }).mode, "queue_only");
});

test("guidance contract rejects turn-only legacy data and fences child attempts", () => {
  const created = guidanceRuntime.createActiveGuidance({
    id: "guidance-9",
    text: "Inspect the failing assertion first",
    target: run,
    createdAt: 20,
  });
  assert.ok(created);
  assert.deepEqual(guidanceRuntime.normalizeActiveGuidance(created), created);
  assert.equal(guidanceRuntime.normalizeActiveGuidance({
    id: "legacy",
    text: "legacy turn guidance",
    turnId: turn.turnId,
    createdAt: 20,
  }), null);
  assert.equal(guidanceRuntime.isActiveGuidanceOwnedByRun(created, run), true);
  assert.equal(guidanceRuntime.isActiveGuidanceOwnedByRun(created, {
    ...run,
    runId: "run-child",
    parentRunId: run.runId,
    attemptId: "attempt-child",
  }), false);
});
