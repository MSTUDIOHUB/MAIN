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
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];
      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  applyNoProgressTrackingRuntimeState,
  applyToolFailureSignatureRuntimeState,
  createAgentLoopGuardRuntimeState,
  getNoProgressTrackingRuntimeState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/loopGuardRuntimeState.ts"),
);

test("loop guard runtime state initializes the unified no-progress and repeat guards", () => {
  const state = createAgentLoopGuardRuntimeState();

  assert.equal(state.lastNoProgressBatchSignature, "");
  assert.equal(state.noProgressBatchRepeatCount, 0);
  assert.equal(state.consecutiveReadFileOnlyCacheHits, 0);
  assert.deepEqual(state.recentToolCalls, []);
  assert.deepEqual(state.recentTargetToolCalls, []);
  assert.equal(state.repeatGuardRecoveredSignatures.size, 0);
  assert.equal(state.targetProgressGuardRecoveredSignatures.size, 0);
  assert.equal(state.failedToolCallCounts.size, 0);
});

test("no-progress tracking snapshot and reducer preserve unrelated guard collection ownership", () => {
  const state = createAgentLoopGuardRuntimeState();
  state.failedToolCallCounts.set("run_command:npm-test", 2);

  assert.deepEqual(getNoProgressTrackingRuntimeState(state), {
    lastNoProgressBatchSignature: "",
    noProgressBatchRepeatCount: 0,
    consecutiveReadFileOnlyCacheHits: 0,
    lastReadFileOnlyObservationSignature: "",
  });

  const next = applyNoProgressTrackingRuntimeState(state, {
    lastNoProgressBatchSignature: "read_file:src/app.ts",
    noProgressBatchRepeatCount: 3,
    consecutiveReadFileOnlyCacheHits: 2,
    lastReadFileOnlyObservationSignature: "window-app",
  });
  assert.equal(next.failedToolCallCounts, state.failedToolCallCounts);
  assert.equal(next.failedToolCallCounts.get("run_command:npm-test"), 2);
  assert.deepEqual(getNoProgressTrackingRuntimeState(next), {
    lastNoProgressBatchSignature: "read_file:src/app.ts",
    noProgressBatchRepeatCount: 3,
    consecutiveReadFileOnlyCacheHits: 2,
    lastReadFileOnlyObservationSignature: "window-app",
  });
});

test("tool failure signature reducer increments errors and clears on success", () => {
  const state = createAgentLoopGuardRuntimeState();
  const signatures = new Map([
    ["call_1", "read_file:src/app.ts"],
    ["call_2", "run_command:npm-test"],
    ["call_3", "ignored:internal"],
  ]);

  applyToolFailureSignatureRuntimeState(state, {
    toolFailureSignatures: signatures,
    results: [
      { toolCallId: "call_1", isError: true },
      { toolCallId: "call_1", isError: true },
      { toolCallId: "call_2", isError: true },
      { toolCallId: "call_3", isError: true, internalFeedback: true },
    ],
  });
  assert.equal(state.failedToolCallCounts.get("read_file:src/app.ts"), 2);
  assert.equal(state.failedToolCallCounts.get("run_command:npm-test"), 1);
  assert.equal(state.failedToolCallCounts.has("ignored:internal"), false);

  applyToolFailureSignatureRuntimeState(state, {
    toolFailureSignatures: signatures,
    results: [{ toolCallId: "call_1", isError: false }],
  });
  assert.equal(state.failedToolCallCounts.has("read_file:src/app.ts"), false);
  assert.equal(state.failedToolCallCounts.get("run_command:npm-test"), 1);
});

test("browser readiness preflight blocks do not poison real browser failure counts", () => {
  const state = createAgentLoopGuardRuntimeState();
  const browserSignature = "browser_evaluate:http://localhost:1420/";

  applyToolFailureSignatureRuntimeState(state, {
    toolFailureSignatures: new Map(),
    results: [
      { toolCallId: "preflight_pending", isError: true },
      { toolCallId: "preflight_failed", isError: true },
    ],
  });
  assert.equal(state.failedToolCallCounts.has(browserSignature), false);

  applyToolFailureSignatureRuntimeState(state, {
    toolFailureSignatures: new Map([
      ["browser_failure_1", browserSignature],
      ["browser_failure_2", browserSignature],
    ]),
    results: [
      { toolCallId: "browser_failure_1", isError: true },
      { toolCallId: "browser_failure_2", isError: true },
    ],
  });
  assert.equal(state.failedToolCallCounts.get(browserSignature), 2);
});
