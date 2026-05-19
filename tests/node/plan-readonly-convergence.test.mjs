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
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  shouldTriggerPlanReadOnlyConvergence,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planReadOnlyConvergence.ts"));

test("plan read-only convergence triggers after three batches or twelve tools", () => {
  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 3,
    toolCount: 3,
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 12,
  }), true);
});

test("plan read-only convergence does not trigger once decision output exists", () => {
  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: true,
    batchCount: 8,
    toolCount: 40,
  }), false);
});
