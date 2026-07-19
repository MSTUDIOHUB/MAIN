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

const { runSubmitPlanExecutionResumeEffect } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitPlanExecutionResume.ts"),
);

function planArtifact(overrides = {}) {
  return {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content: "# Plan\n\n## Execution steps\n1. Update `src/App.tsx`.\n",
    updatedAt: 1,
    ...overrides,
  };
}

function planTask(overrides = {}) {
  return {
    id: "task-1",
    text: "Update src/App.tsx",
    status: "pending",
    executionKind: "mutation",
    evidenceStatus: "missing",
    source: "runtime",
    evidence: [{ kind: "file", value: "src/App.tsx" }],
    ...overrides,
  };
}

function progressSnapshot(overrides = {}) {
  return {
    turnId: "turn-old",
    runId: "run-old",
    parentRunId: "run-parent-old",
    phase: "executing",
    currentTaskId: "task-1",
    currentTask: "Update src/App.tsx",
    currentTool: "write_file",
    latestEvidence: "",
    nextStep: "Continue old Run",
    iteration: 2,
    maxIterations: 50,
    autoResumeCount: 0,
    updatedAt: 100,
    ...overrides,
  };
}

function createState(overrides = {}) {
  return {
    currentWorkspace: "/repo",
    planArtifacts: [],
    planTasks: [],
    planStage: "idle",
    planExecutionProgressSnapshot: null,
    isPlanApproved: false,
    ...overrides,
  };
}

function createHarness(state) {
  return {
    preRunPatches: [],
    logs: [],
    blocked: [],
    dispatches: [],
    setState(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next && typeof next === "object") Object.assign(state, next);
    },
    applyPreRunSessionPatch(patch) {
      this.preRunPatches.push(patch);
      Object.assign(state, patch);
    },
    logStoreEvent(event, data) {
      this.logs.push({ event, data });
    },
    onResumeBlocked(message, detail) {
      this.blocked.push({ message, detail });
    },
    resumeSubmission(...args) {
      this.dispatches.push(args);
    },
  };
}

test("disk hydration is discovery-only and cannot dispatch or inherit execution authority", async () => {
  const state = createState({
    isPlanApproved: true,
    planStage: "executing",
  });
  const harness = createHarness(state);
  const task = planTask();

  const result = await runSubmitPlanExecutionResumeEffect({
    text: "继续执行计划",
    images: ["must-not-be-forwarded"],
    preferredLanguage: "zh",
    shouldRouteContinuationToPlanResume: true,
    uiParentTurnId: "turn-old",
    commandDirective: { kind: "control", action: "resume_plan_execution" },
    getState: () => state,
    setState: harness.setState.bind(harness),
    applyPreRunSessionPatch: harness.applyPreRunSessionPatch.bind(harness),
    hydrateExistingPlanArtifactsForWorkspace: async () => ({
      artifacts: [planArtifact()],
      tasks: [task],
      hasTasksArtifact: false,
    }),
    // Adversarial legacy callback: discovery must never invoke it even when a
    // caller still carries the pre-refactor field at runtime.
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
    onResumeBlocked: harness.onResumeBlocked.bind(harness),
  });

  assert.deepEqual(harness.preRunPatches, [
    {
      input: "",
      contextMentions: [],
      attachedFiles: [],
      lockedComposerIntent: null,
      pendingRunDecision: null,
    },
  ]);
  assert.equal(result.kind, "discovery_only");
  assert.equal(result.reason, "plan_resume_requires_explicit_turn_approval");
  assert.equal(result.requiresTurnAdmission, true);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.artifactCount, 1);
  assert.equal(result.taskCount, 1);
  assert.equal(state.isPlanApproved, false);
  assert.equal(state.planApprovalChoice, null);
  assert.equal(state.planStage, "plan");
  assert.equal(state.showPlanPanel, true);
  assert.equal(state.rightPanelTab, "plan");
  assert.equal(state.showDiff, false);
  assert.equal(harness.dispatches.length, 0);
  assert.equal(harness.blocked.length, 1);
  assert.match(harness.blocked[0].message, /新的工作区回合/);
  assert.deepEqual(harness.logs.map((entry) => entry.event), [
    "existing_plan_discovered_for_review",
    "existing_plan_resume_requires_explicit_turn_approval",
  ]);
});

test("in-memory discovery never rehydrates or reuses a stale Turn/Run checkpoint", async () => {
  const task = planTask();
  const state = createState({
    planArtifacts: [planArtifact()],
    planTasks: [task],
    planStage: "executing",
    isPlanApproved: true,
    planExecutionProgressSnapshot: progressSnapshot(),
  });
  const harness = createHarness(state);
  let hydrateCalls = 0;

  const result = await runSubmitPlanExecutionResumeEffect({
    text: "continue plan",
    preferredLanguage: "en",
    shouldRouteContinuationToPlanResume: true,
    uiParentTurnId: "turn-old",
    commandDirective: null,
    getState: () => state,
    setState: harness.setState.bind(harness),
    applyPreRunSessionPatch: harness.applyPreRunSessionPatch.bind(harness),
    hydrateExistingPlanArtifactsForWorkspace: async () => {
      hydrateCalls += 1;
      return { artifacts: [], tasks: [], hasTasksArtifact: false };
    },
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
    onResumeBlocked: harness.onResumeBlocked.bind(harness),
  });

  assert.equal(hydrateCalls, 0);
  assert.equal(result.reason, "plan_resume_requires_explicit_turn_approval");
  assert.equal(state.isPlanApproved, false);
  assert.equal(state.planStage, "plan");
  assert.equal(state.planExecutionProgressSnapshot.turnId, "turn-old");
  assert.equal(state.planExecutionProgressSnapshot.runId, "run-old");
  assert.equal(state.planExecutionProgressSnapshot.phase, "paused");
  assert.match(state.planExecutionProgressSnapshot.nextStep, /new workspace Turn/);
  assert.equal(harness.logs[0].data.reusedExistingState, true);
  assert.equal(harness.dispatches.length, 0);
});

test("missing reviewable artifacts return a visible approval requirement with zero dispatch", async () => {
  const state = createState();
  const harness = createHarness(state);

  const result = await runSubmitPlanExecutionResumeEffect({
    text: "continue plan",
    preferredLanguage: "en",
    shouldRouteContinuationToPlanResume: true,
    commandDirective: null,
    getState: () => state,
    setState: harness.setState.bind(harness),
    applyPreRunSessionPatch: harness.applyPreRunSessionPatch.bind(harness),
    hydrateExistingPlanArtifactsForWorkspace: async () => ({
      artifacts: [],
      tasks: [],
      hasTasksArtifact: false,
    }),
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
    onResumeBlocked: harness.onResumeBlocked.bind(harness),
  });

  assert.equal(result.reason, "plan_resume_artifact_not_found");
  assert.match(result.message, /No reviewable existing plan/);
  assert.equal(state.isPlanApproved, false);
  assert.equal(state.planStage, "plan");
  assert.equal(harness.dispatches.length, 0);
  assert.equal(harness.blocked.length, 1);
});

test("hydration errors close as a visible discovery result instead of starting execution", async () => {
  const state = createState();
  const harness = createHarness(state);

  const result = await runSubmitPlanExecutionResumeEffect({
    text: "继续执行计划",
    preferredLanguage: "zh",
    shouldRouteContinuationToPlanResume: true,
    commandDirective: null,
    getState: () => state,
    setState: harness.setState.bind(harness),
    applyPreRunSessionPatch: harness.applyPreRunSessionPatch.bind(harness),
    hydrateExistingPlanArtifactsForWorkspace: async () => {
      throw new Error("disk unavailable");
    },
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
    onResumeBlocked: harness.onResumeBlocked.bind(harness),
  });

  assert.equal(result.reason, "plan_resume_discovery_unavailable");
  assert.match(result.message, /执行保持暂停/);
  assert.match(result.message, /disk unavailable/);
  assert.equal(state.isPlanApproved, false);
  assert.equal(state.planStage, "plan");
  assert.equal(harness.dispatches.length, 0);
  assert.deepEqual(harness.logs.map((entry) => entry.event), [
    "existing_plan_discovery_unavailable",
  ]);
  assert.equal(harness.blocked.length, 1);
});

test("legacy resume source contains no execution grant or hidden dispatch path", () => {
  const source = fsSync.readFileSync(
    path.join(workspaceRoot, "src/store/submitPlanExecutionResume.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /resumeSubmission\s*\(/);
  assert.doesNotMatch(source, /executionConsentGranted\s*:\s*true/);
  assert.doesNotMatch(source, /isPlanApproved\s*:\s*true/);
  assert.doesNotMatch(source, /reuseCurrentTurn/);
  assert.doesNotMatch(source, /turnIdOverride/);
  assert.match(source, /requiresTurnAdmission:\s*true/);
  assert.match(source, /existing_plan_discovered_for_review/);
});
