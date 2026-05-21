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
  assessPlanEvidenceReadiness,
  filterPlanToolNamesAfterReadOnlyConvergence,
  shouldNarrowPlanToolsAfterReadOnlyConvergence,
  shouldRedirectPlanToolsAfterReadOnlyConvergence,
  shouldTriggerPlanReadOnlyConvergence,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planReadOnlyConvergence.ts"));

test("plan evidence readiness requires observed user context and targeted reads", () => {
  assert.deepEqual(
    assessPlanEvidenceReadiness({
      userContext: { imageParts: 1 },
      hasObservedUserContext: false,
      recentToolActivity: [
        { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
      ],
    }),
    {
      status: "needs_observation",
      reason: "provided_context_not_observed",
      successfulTargetedReads: 0,
      successfulSearches: 1,
    },
  );

  assert.equal(
    assessPlanEvidenceReadiness({
      hasObservedUserContext: true,
      recentToolActivity: [
        { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
      ],
    }).status,
    "needs_targeted_read",
  );

  assert.equal(
    assessPlanEvidenceReadiness({
      hasObservedUserContext: true,
      recentToolActivity: [
        { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
      ],
    }).status,
    "ready_for_plan",
  );
});

test("plan read-only convergence triggers only after targeted evidence is ready", () => {
  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 3,
    toolCount: 12,
    recentToolActivity: [
      { name: "grep_search", target: "csv/import/loadData", status: "succeeded" },
    ],
  }), false);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 3,
    toolCount: 3,
    recentToolActivity: [
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 12,
    recentToolActivity: [
      { name: "get_file_outline", target: "src/store/dashboardStore.ts", status: "succeeded" },
    ],
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
    hasObservedUserContext: false,
    recentToolActivity: [
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
  }), false);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 2,
    toolCount: 2,
    userContext: { imageParts: 2 },
    hasObservedUserContext: true,
    recentToolActivity: [
      { name: "read_file", target: "src/hooks/useCsvParser.ts", status: "succeeded" },
    ],
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 1,
    toolCount: 6,
    userContext: { attachedFilePaths: ["logs/main-debug.log"] },
    hasObservedUserContext: true,
    recentToolActivity: [
      { name: "read_file", target: "logs/main-debug.log", status: "succeeded" },
    ],
  }), true);

  assert.equal(shouldTriggerPlanReadOnlyConvergence({
    isUnapprovedPlanReadOnlyBatch: true,
    hasPlanDecisionOutput: false,
    batchCount: 1,
    toolCount: 5,
    userContext: { mentionedFilePaths: ["src/App.tsx"] },
    hasObservedUserContext: true,
    recentToolActivity: [
      { name: "grep_search", target: "App", status: "succeeded" },
    ],
  }), false);
});

test("post-convergence plan turns redirect more read-only tools before execution", () => {
  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["list_directory"],
    evidenceReadiness: "ready_for_plan",
  }), true);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: true,
    toolNames: ["list_directory"],
    evidenceReadiness: "ready_for_plan",
  }), false);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: true,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["read_file"],
    evidenceReadiness: "ready_for_plan",
  }), false);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["write_file"],
    evidenceReadiness: "ready_for_plan",
  }), false);

  assert.equal(shouldRedirectPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
    hasPlanDecisionOutput: false,
    toolNames: ["list_directory"],
    evidenceReadiness: "needs_targeted_read",
  }), false);
});

test("post-convergence plan tool surface stays open for targeted evidence reads", () => {
  assert.equal(shouldNarrowPlanToolsAfterReadOnlyConvergence({
    workflowMode: "plan",
    isPlanApproved: false,
    convergencePromptAlreadyUsed: true,
  }), false);

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
  }), [
    "list_directory",
    "glob_search",
    "read_file",
    "replace_in_file",
    "write_file",
    "get_project_skeleton",
    "read_pty_tail",
  ]);

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
