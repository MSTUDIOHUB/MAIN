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
  filterPlanToolNamesAfterReadOnlyConvergence,
  shouldNarrowPlanToolsAfterReadOnlyConvergence,
  shouldRedirectPlanToolsAfterReadOnlyConvergence,
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

test("plan read-only convergence tightens when user supplied screenshots or files", () => {
  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 2,
    userContext: { imageParts: 2 },
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 1,
    toolCount: 6,
    userContext: { attachedFilePaths: ["logs/main-debug.log"] },
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 1,
    toolCount: 5,
    userContext: { mentionedFilePaths: ["src/App.tsx"] },
  }), false);
});

test("post-convergence plan turns redirect more read-only tools before execution", () => {
  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["list_directory"],
  }), true);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: true,
    toolNames: ["list_directory"],
  }), false);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: true,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["read_file"],
  }), false);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["write_file"],
  }), false);
});

test("post-convergence plan tool surface narrows to plan artifact materialization", () => {
  assert.equal(shouldNarrowPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
  }), true);

  assert.deepEqual(filterPlanToolNamesAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    toolNames: [
      "list_directory",
      "glob_search",
      "read_file",
      "replace_in_file",
      "write_file",
      "get_project_skeleton",
      "read_pty_tail",
    ],
  }), ["replace_in_file", "write_file"]);

  assert.deepEqual(filterPlanToolNamesAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: true,
    convergencePromptAlreadyUsed: true,
    toolNames: ["read_file", "write_file"],
  }), ["read_file", "write_file"]);

  assert.deepEqual(filterPlanToolNamesAfterReadOnlyConvergence({
    workflowMode: "edit",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    toolNames: ["read_file", "write_file"],
  }), ["read_file", "write_file"]);
});
