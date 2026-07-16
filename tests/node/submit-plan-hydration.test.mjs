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

const { runSubmitPlanHydrationEffect } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitPlanHydration.ts"),
);

function createState(overrides = {}) {
  return {
    currentWorkspace: "/repo",
    currentSessionId: 7,
    currentTurnId: "turn-1",
    planArtifacts: [],
    planTasks: [],
    planStage: "idle",
    isPlanApproved: false,
    runtimeEvents: [],
    showPlanPanel: false,
    rightPanelTab: "terminal",
    showDiff: true,
    ...overrides,
  };
}

function createHarness(state) {
  return {
    logs: [],
    resumes: [],
    getState: () => state,
    setState: (patch) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next && typeof next === "object") Object.assign(state, next);
    },
    logStoreEvent(event, data) {
      this.logs.push({ event, data });
    },
    resumeSubmission(text, images, options) {
      this.resumes.push({ text, images, options });
    },
  };
}

function hydratedPlan() {
  return {
    artifacts: [
      {
        kind: "plan",
        path: ".MAIN/plans/plan.md",
        title: "Plan",
        content: "# Plan",
        updatedAt: 1,
      },
    ],
    tasks: [
      {
        id: "task-1",
        text: "Ship it",
        completed: false,
        source: "runtime",
      },
    ],
    hasTasksArtifact: true,
  };
}

test("submit plan hydration applies hydrated state and resumes with skip flag", async () => {
  const state = createState();
  const harness = createHarness(state);

  await runSubmitPlanHydrationEffect({
    reason: "existing_plan_execution",
    text: "继续执行计划",
    images: ["img"],
    options: { preservePlanState: false, source: "test" },
    preferredLanguage: "zh",
    workspace: "/repo",
    sendOriginSessionKey: "/repo:7",
    getState: harness.getState,
    setState: harness.setState,
    hydrateExistingPlanArtifactsForWorkspace: async () => hydratedPlan(),
    derivePlanStageFromArtifacts: () => "ready_to_execute",
    isSessionRuntimeActive: () => true,
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
    nowMs: () => 1234,
  });

  assert.equal(state.planArtifacts.length, 1);
  assert.equal(state.planTasks.length, 1);
  assert.equal(state.planStage, "executing");
  assert.equal(state.isPlanApproved, true);
  assert.equal(state.showPlanPanel, true);
  assert.equal(state.rightPanelTab, "plan");
  assert.equal(state.showDiff, false);
  assert.equal(state.runtimeEvents[0].type, "plan_state_hydrated");
  assert.equal(state.runtimeEvents[0].timestampMs, 1234);
  assert.deepEqual(harness.logs, [
    {
      event: "plan_state_hydrated",
      data: {
        workspace: "/repo",
        reason: "existing_plan_execution",
        artifacts: [".MAIN/plans/plan.md"],
        taskCount: 1,
      },
    },
  ]);
  assert.deepEqual(harness.resumes, [
    {
      text: "继续执行计划",
      images: ["img"],
      options: {
        preservePlanState: true,
        source: "test",
        skipAutoPlanHydration: true,
      },
    },
  ]);
});

test("submit plan hydration skips async resume when origin session is inactive", async () => {
  const state = createState();
  const harness = createHarness(state);

  await runSubmitPlanHydrationEffect({
    reason: "resume_plan_semantic",
    text: "continue plan",
    images: undefined,
    options: undefined,
    preferredLanguage: "en",
    workspace: "/repo",
    sendOriginSessionKey: "/repo:7",
    getState: harness.getState,
    setState: harness.setState,
    hydrateExistingPlanArtifactsForWorkspace: async () => hydratedPlan(),
    derivePlanStageFromArtifacts: () => "idle",
    isSessionRuntimeActive: () => false,
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
  });

  assert.deepEqual(harness.resumes, []);
  assert.deepEqual(state.planArtifacts, []);
  assert.deepEqual(state.planTasks, []);
  assert.equal(state.planStage, "idle");
  assert.deepEqual(harness.logs, [
    {
      event: "send_async_resume_skipped_inactive_session",
      data: {
        phase: "auto_plan_hydration",
        sessionKey: "/repo:7",
      },
    },
  ]);
});
