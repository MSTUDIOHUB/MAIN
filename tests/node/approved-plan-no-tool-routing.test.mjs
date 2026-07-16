import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

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
  transpiledModuleCache.set(normalizedPath, module.exports);

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

const { resolveApprovedPlanNoToolRoute } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanNoToolRouting.ts"),
);

function route(overrides = {}) {
  return resolveApprovedPlanNoToolRoute({
    workflowMode: "plan",
    isPlanApproved: true,
    planStage: "executing",
    toolCallCount: 0,
    planTasks: [],
    evidenceLedger: [],
    userVisibleText: "",
    ...overrides,
  });
}

test("approved plan no-tool route suppresses completion claims when tasks are missing", () => {
  const decision = route({
    userVisibleText: "All tasks are complete.",
  });

  assert.equal(decision.audit.totalCount, 0);
  assert.equal(decision.approvedPlanMissingTasks, true);
  assert.equal(decision.hasRemainingApprovedPlanTasks, true);
  assert.equal(decision.shouldHandleApprovedPlanNoTool, true);
  assert.equal(decision.shouldSuppressApprovedPlanNoToolText, true);
  assert.equal(decision.rejectedCompletionClaim, true);
  assert.equal(decision.shouldHideApprovedPlanNoToolText, true);
  assert.equal(decision.shouldLogApprovedPlanNoToolRoute, true);
});

test("approved plan no-tool route suppresses prose while trusted evidence remains incomplete", () => {
  const decision = route({
    planTasks: [{
      id: "task-1",
      text: "Update the source file",
      status: "pending",
      evidence: [{ kind: "file", value: "src/App.tsx" }],
    }],
    userVisibleText: "I am still working through the task.",
  });

  assert.equal(decision.audit.totalCount, 1);
  assert.equal(decision.approvedPlanMissingTasks, false);
  assert.equal(decision.hasRemainingApprovedPlanTasks, true);
  assert.equal(decision.shouldHandleApprovedPlanNoTool, true);
  assert.equal(decision.shouldSuppressApprovedPlanNoToolText, true);
  assert.equal(decision.rejectedCompletionClaim, false);
  assert.equal(decision.shouldHideApprovedPlanNoToolText, false);
});

test("approved plan no-tool route does not intervene when tool calls are present", () => {
  const decision = route({
    toolCallCount: 1,
    userVisibleText: "All tasks are complete.",
  });

  assert.equal(decision.audit, null);
  assert.equal(decision.shouldHandleApprovedPlanNoTool, false);
  assert.equal(decision.shouldSuppressApprovedPlanNoToolText, false);
  assert.equal(decision.rejectedCompletionClaim, false);
  assert.equal(decision.shouldLogApprovedPlanNoToolRoute, false);
});

test("approved plan no-tool route does not intervene outside approved execution", () => {
  const decision = route({
    isPlanApproved: false,
    planStage: "plan",
    userVisibleText: "All tasks are complete.",
  });

  assert.equal(decision.audit, null);
  assert.equal(decision.approvedPlanMissingTasks, false);
  assert.equal(decision.hasRemainingApprovedPlanTasks, false);
  assert.equal(decision.shouldHandleApprovedPlanNoTool, false);
  assert.equal(decision.shouldSuppressApprovedPlanNoToolText, false);
  assert.equal(decision.shouldLogApprovedPlanNoToolRoute, false);
});

test("user-only review is a conclusion advisory instead of a no-tool completion blocker", () => {
  const decision = route({
    planTasks: [{
      id: "task-review",
      text: "User reviews the target desktop interaction",
      status: "pending",
      evidence: [{ kind: "manual_user_validation", value: "user confirmation" }],
    }],
    availableToolNames: new Set(["read_file", "run_command"]),
    userVisibleText: "Automated work is complete.",
  });

  assert.equal(decision.audit.acceptedCompletion, true);
  assert.equal(decision.audit.pendingUserValidationTasks.length, 1);
  assert.equal(decision.hasRemainingApprovedPlanTasks, false);
  assert.equal(decision.shouldHandleApprovedPlanNoTool, false);
  assert.equal(decision.shouldSuppressApprovedPlanNoToolText, false);
});

test("browser review remains an automatic evidence blocker when browser automation is unavailable", () => {
  const planTasks = [{
    id: "task-browser",
    text: "Verify the rendered page",
    status: "pending",
    evidence: [{ kind: "browser_dom", value: "browser DOM validation" }],
  }];
  const unavailable = route({
    planTasks,
    availableToolNames: new Set(["read_file", "run_command"]),
  });
  const available = route({
    planTasks,
    availableToolNames: new Set(["browser_evaluate"]),
  });

  assert.equal(unavailable.audit.acceptedCompletion, false);
  assert.equal(unavailable.hasRemainingApprovedPlanTasks, true);
  assert.equal(unavailable.shouldHandleApprovedPlanNoTool, true);
  assert.equal(available.audit.acceptedCompletion, false);
  assert.equal(available.shouldHandleApprovedPlanNoTool, true);
});

test("an unavailable browser cannot hide a missing mutation in the same task", () => {
  const planTasks = [{
    id: "task-mutation-and-browser",
    text: "Update the page, then verify the rendered result",
    status: "pending",
    evidence: [
      { kind: "file", value: "src/App.tsx" },
      { kind: "browser_dom", value: "browser DOM validation" },
    ],
  }];
  const beforeMutation = route({
    planTasks,
    availableToolNames: new Set(["read_file", "run_command"]),
  });
  const afterMutation = route({
    planTasks,
    evidenceLedger: [{
      id: "mutation",
      kind: "file",
      value: "src/App.tsx",
      target: "src/App.tsx",
      sourceTool: "apply_patch",
      createdAt: 1,
    }],
    availableToolNames: new Set(["read_file", "run_command"]),
  });

  assert.equal(beforeMutation.audit.tasks[0].evidenceStatus, "missing");
  assert.equal(beforeMutation.audit.acceptedCompletion, false);
  assert.equal(beforeMutation.shouldHandleApprovedPlanNoTool, true);
  assert.equal(afterMutation.audit.tasks[0].evidenceStatus, "requires_browser_validation");
  assert.equal(afterMutation.audit.acceptedCompletion, false);
  assert.equal(afterMutation.hasRemainingApprovedPlanTasks, true);
  assert.equal(afterMutation.shouldHandleApprovedPlanNoTool, true);
});
