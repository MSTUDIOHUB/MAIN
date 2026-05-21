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
  filterPlanToolNamesForRuntimePhase,
  filterPlanToolNamesAfterReadOnlyConvergence,
  shouldRedirectPlanToolsAfterReadOnlyConvergence,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planReadOnlyConvergence.ts"));

const allPlanTools = [
  "get_project_skeleton",
  "grep_search",
  "read_file",
  "write_file",
  "replace_in_file",
  "run_command",
];

test("plan runtime phases scope the tool surface", () => {
  assert.deepEqual(filterPlanToolNamesForRuntimePhase({
    toolNames: allPlanTools,
    workflowMode: "plan",
    isPlanApproved: false,
    planRuntimePhase: "grounding",
  }), ["get_project_skeleton", "grep_search", "read_file"]);

  assert.deepEqual(filterPlanToolNamesForRuntimePhase({
    toolNames: allPlanTools,
    workflowMode: "plan",
    isPlanApproved: false,
    planRuntimePhase: "needs_evidence",
  }), ["get_project_skeleton", "grep_search", "read_file"]);

  assert.deepEqual(filterPlanToolNamesForRuntimePhase({
    toolNames: allPlanTools,
    workflowMode: "plan",
    isPlanApproved: false,
    planRuntimePhase: "drafting",
  }), ["write_file", "replace_in_file"]);

  assert.deepEqual(filterPlanToolNamesForRuntimePhase({
    toolNames: allPlanTools,
    workflowMode: "plan",
    isPlanApproved: false,
    planRuntimePhase: "review_ready",
  }), []);
});

test("needs_rewrite remains write-only even before the old convergence prompt", () => {
  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: false,
    hasPlanDecisionOutput: false,
    toolNames: ["read_file"],
    evidenceReadiness: "needs_targeted_read",
    planRuntimePhase: "needs_rewrite",
  }), true);

  assert.deepEqual(filterPlanToolNamesAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: false,
    evidenceReadiness: "needs_targeted_read",
    planRuntimePhase: "needs_rewrite",
    toolNames: allPlanTools,
  }), ["write_file", "replace_in_file"]);
});

test("needs_evidence reopens read-only tools after convergence", () => {
  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["read_file"],
    evidenceReadiness: "ready_for_plan",
    planRuntimePhase: "needs_evidence",
  }), false);
});
