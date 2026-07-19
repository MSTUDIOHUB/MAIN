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

test("submit plan hydration discovers artifacts without auto-approving execution", async () => {
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
    sendOriginSessionEpoch: "epoch-7",
    getState: harness.getState,
    setState: harness.setState,
    hydrateExistingPlanArtifactsForWorkspace: async () => hydratedPlan(),
    derivePlanStageFromArtifacts: () => "ready_to_execute",
    isSessionRuntimeOwnerActive: (_state, key, epoch) =>
      key === "/repo:7" && epoch === "epoch-7",
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
    nowMs: () => 1234,
  });

  assert.equal(state.planArtifacts.length, 1);
  assert.equal(state.planTasks.length, 1);
  assert.equal(state.planStage, "ready_to_execute");
  assert.equal(state.isPlanApproved, false);
  assert.equal(state.showPlanPanel, true);
  assert.equal(state.rightPanelTab, "plan");
  assert.equal(state.showDiff, false);
  assert.equal(state.runtimeEvents[0].type, "plan_state_hydrated");
  assert.equal(state.runtimeEvents[0].timestampMs, 1234);
  assert.equal(state.planLifecycle.sessionKey, "/repo:7");
  assert.equal(state.planLifecycle.sessionEpoch, "epoch-7");
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

test("submit plan hydration replaces a stale same-key lifecycle with the exact Session epoch", async () => {
  const state = createState({
    planLifecycle: {
      schemaVersion: 2,
      version: 8,
      status: "empty",
      sessionKey: "/repo:7",
      sessionEpoch: "epoch-stale-container",
      planTurnId: null,
      artifactIdentity: null,
      reviewIdentity: null,
      approvalLease: null,
      executionLease: null,
      lastIssuedAttempt: 0,
      execution: null,
      pause: null,
      updatedAt: 100,
    },
  });
  const harness = createHarness(state);

  await runSubmitPlanHydrationEffect({
    reason: "existing_plan_execution",
    text: "continue exact plan",
    preferredLanguage: "en",
    workspace: "/repo",
    sendOriginSessionKey: "/repo:7",
    sendOriginSessionEpoch: "epoch-7",
    getState: harness.getState,
    setState: harness.setState,
    hydrateExistingPlanArtifactsForWorkspace: async () => hydratedPlan(),
    derivePlanStageFromArtifacts: () => "ready_to_execute",
    isSessionRuntimeOwnerActive: (_candidate, key, epoch) =>
      key === "/repo:7" && epoch === "epoch-7",
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
    nowMs: () => 1300,
  });

  assert.equal(state.planLifecycle.sessionKey, "/repo:7");
  assert.equal(state.planLifecycle.sessionEpoch, "epoch-7");
  assert.equal(state.planLifecycle.status, "drafting");
  assert.equal(state.planLifecycle.approvalLease, null);
  assert.equal(state.planLifecycle.executionLease, null);
  assert.equal(harness.resumes.length, 1);
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
    sendOriginSessionEpoch: "epoch-7",
    getState: harness.getState,
    setState: harness.setState,
    hydrateExistingPlanArtifactsForWorkspace: async () => hydratedPlan(),
    derivePlanStageFromArtifacts: () => "idle",
    isSessionRuntimeOwnerActive: () => false,
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

test("submit plan hydration rejects a recreated Session with the same key but a new epoch", async () => {
  const state = createState({
    planLifecycle: {
      sessionKey: "/repo:7",
      sessionEpoch: "epoch-7",
      status: "empty",
    },
  });
  const harness = createHarness(state);
  let finishHydration;
  const hydrationPending = new Promise((resolve) => {
    finishHydration = resolve;
  });

  const effect = runSubmitPlanHydrationEffect({
    reason: "existing_plan_execution",
    text: "continue exact plan",
    preferredLanguage: "en",
    workspace: "/repo",
    sendOriginSessionKey: "/repo:7",
    sendOriginSessionEpoch: "epoch-7",
    getState: harness.getState,
    setState: harness.setState,
    hydrateExistingPlanArtifactsForWorkspace: async () => hydrationPending,
    derivePlanStageFromArtifacts: () => "ready_to_execute",
    isSessionRuntimeOwnerActive: (candidate, key, epoch) =>
      candidate.planLifecycle?.sessionKey === key &&
      candidate.planLifecycle?.sessionEpoch === epoch,
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
  });

  state.planLifecycle = {
    ...state.planLifecycle,
    sessionEpoch: "epoch-7-recreated",
  };
  finishHydration(hydratedPlan());
  await effect;

  assert.deepEqual(state.planArtifacts, []);
  assert.deepEqual(state.planTasks, []);
  assert.deepEqual(harness.resumes, []);
  assert.equal(state.planLifecycle.sessionEpoch, "epoch-7-recreated");
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
