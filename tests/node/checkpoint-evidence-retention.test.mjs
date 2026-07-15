import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const localRequire = createRequire(normalized);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  cache.set(normalized, module.exports);
  return module.exports;
}

const recovery = loadTs(path.join(workspaceRoot, "src/lib/planExecutionRecovery.ts"));

function checkpoint(overrides = {}) {
  return recovery.buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 0,
    autoResumeEligible: true,
    tasks: [],
    evidenceLedger: [],
    recentToolActivity: [],
    ...overrides,
  });
}

test("execute checkpoint keeps mutation evidence even without Plan tasks", () => {
  const value = checkpoint({
    evidenceLedger: [{
      id: "mutation",
      kind: "file",
      value: "src/main.js",
      target: "src/main.js",
      sourceTool: "apply_patch",
      createdAt: 1,
    }],
    recentToolActivity: [{
      name: "apply_patch",
      target: "src/main.js",
      status: "succeeded",
    }],
  });
  assert.match(value.completedEvidence.join("\n"), /file:src\/main\.js via apply_patch/);
  assert.doesNotMatch(value.completedEvidence.join("\n"), /No trusted project-source evidence/);
});

test("checkpoint retains exact read observation when the ledger has no completion evidence", () => {
  const observation = {
    key: "src/toolbar.js::205-256::v2",
    path: "src/toolbar.js",
    requestSignature: "205:52",
    versionToken: "v2",
    source: "fresh",
  };
  const value = checkpoint({
    recentToolActivity: [{
      name: "read_file",
      target: "src/toolbar.js",
      status: "succeeded",
      readFileObservation: observation,
    }],
  });
  assert.match(value.completedEvidence.join("\n"), /src\/toolbar\.js/);
  assert.match(value.completedEvidence.join("\n"), /version=v2/);
  assert.match(value.completedEvidence.join("\n"), /request=205:52/);

  const previous = recovery.buildPlanProgressSignatureFromToolActivity([{
    name: "read_file",
    target: "src/toolbar.js",
    status: "succeeded",
    readFileObservation: { ...observation, key: "src/toolbar.js::205-256::v1", versionToken: "v1" },
  }]);
  const current = recovery.buildPlanProgressSignatureFromToolActivity([{
    name: "read_file",
    target: "src/toolbar.js",
    status: "succeeded",
    readFileObservation: observation,
  }]);
  assert.notEqual(previous, current);
});
