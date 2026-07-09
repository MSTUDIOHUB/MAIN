import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

  const source = fsSync.readFileSync(normalizedPath, "utf8");
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
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { applySubmitPlanStateReset } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitPlanStateReset.ts"),
);

test("submit plan state reset skips state writes when runtime decision preserves plan state", () => {
  const patches = [];
  const didReset = applySubmitPlanStateReset({
    shouldResetPlanState: false,
    defaultNormalizedStreamState: { status: "idle" },
    setState: (patch) => patches.push(patch),
  });

  assert.equal(didReset, false);
  assert.deepEqual(patches, []);
});

test("submit plan state reset clears approved plan runtime fields", () => {
  const patches = [];
  const streamState = { status: "idle", chunks: [] };
  const didReset = applySubmitPlanStateReset({
    shouldResetPlanState: true,
    defaultNormalizedStreamState: streamState,
    setState: (patch) => patches.push(patch),
  });

  assert.equal(didReset, true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].isPlanApproved, false);
  assert.equal(patches[0].planApprovalChoice, null);
  assert.deepEqual(patches[0].planExecutionEvidenceLedger, []);
  assert.equal(patches[0].planExecutionEvidenceCount, 0);
  assert.equal(patches[0].planAutoResumeCount, 0);
  assert.equal(patches[0].planExecutionProgressSnapshot, null);
  assert.equal(patches[0].normalizedStreamState, streamState);
  assert.deepEqual(patches[0].planArtifacts, []);
  assert.deepEqual(patches[0].planTasks, []);
  assert.equal(patches[0].planStage, "idle");
  assert.equal(patches[0].clearedPlanTurnId, null);
  assert.deepEqual(patches[0].currentTurnExecutionConsent, {
    turnId: null,
    granted: false,
  });
});
