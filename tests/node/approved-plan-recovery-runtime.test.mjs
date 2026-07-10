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
  applyApprovedPlanActionOnlyRecoveryState,
  applyApprovedPlanNoToolRecoveryState,
  applyApprovedPlanStrategySwitchRecoveryState,
  applyApprovedPlanToolResultRecoveryState,
  createApprovedPlanRecoveryRuntimeState,
  resetApprovedPlanHandoffRecoveryState,
  resetApprovedPlanLongReasoningNoActionCount,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanRecoveryRuntime.ts"),
);

test("approved plan recovery state starts with normal execution surface", () => {
  assert.deepEqual(createApprovedPlanRecoveryRuntimeState(), {
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
    approvedPlanLongReasoningNoActionCount: 0,
  });
});

test("approved plan recovery state applies strategy-switch and no-tool results", () => {
  let state = createApprovedPlanRecoveryRuntimeState();
  state = applyApprovedPlanStrategySwitchRecoveryState(state, {
    approvedPlanNoProgressRecoveryAttempts: 1,
    approvedPlanActionOnlyRecoveryActive: true,
  });
  assert.equal(state.approvedPlanNoProgressRecoveryAttempts, 1);
  assert.equal(state.approvedPlanActionOnlyRecoveryActive, true);

  state = applyApprovedPlanNoToolRecoveryState(state, {
    approvedPlanNoProgressRecoveryAttempts: 2,
    approvedPlanActionOnlyRecoveryActive: true,
    approvedPlanNoToolRecoveryFileReadActive: true,
    approvedPlanLongReasoningNoActionCount: 1,
  });
  assert.deepEqual(state, {
    approvedPlanNoProgressRecoveryAttempts: 2,
    approvedPlanActionOnlyRecoveryActive: true,
    approvedPlanNoToolRecoveryFileReadActive: true,
    approvedPlanLongReasoningNoActionCount: 1,
  });
});

test("approved plan recovery state applies tool-result and reset slices independently", () => {
  let state = {
    approvedPlanNoProgressRecoveryAttempts: 2,
    approvedPlanActionOnlyRecoveryActive: true,
    approvedPlanNoToolRecoveryFileReadActive: true,
    approvedPlanLongReasoningNoActionCount: 3,
  };

  state = resetApprovedPlanLongReasoningNoActionCount(state);
  assert.equal(state.approvedPlanLongReasoningNoActionCount, 0);
  assert.equal(state.approvedPlanActionOnlyRecoveryActive, true);

  state = applyApprovedPlanActionOnlyRecoveryState(state, {
    approvedPlanActionOnlyRecoveryActive: false,
  });
  assert.equal(state.approvedPlanActionOnlyRecoveryActive, false);
  assert.equal(state.approvedPlanNoToolRecoveryFileReadActive, true);

  state = applyApprovedPlanToolResultRecoveryState(state, {
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
  });
  assert.equal(state.approvedPlanNoProgressRecoveryAttempts, 0);
  assert.equal(state.approvedPlanNoToolRecoveryFileReadActive, false);
});

test("approved plan handoff reset preserves existing file-read recovery flag", () => {
  const state = resetApprovedPlanHandoffRecoveryState({
    approvedPlanNoProgressRecoveryAttempts: 2,
    approvedPlanActionOnlyRecoveryActive: true,
    approvedPlanNoToolRecoveryFileReadActive: true,
    approvedPlanLongReasoningNoActionCount: 4,
  });

  assert.deepEqual(state, {
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: true,
    approvedPlanLongReasoningNoActionCount: 0,
  });
});
