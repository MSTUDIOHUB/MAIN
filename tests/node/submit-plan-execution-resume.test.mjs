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

const {
  buildTrustedPlanResumePrompt,
  runSubmitPlanExecutionResumeEffect,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitPlanExecutionResume.ts"),
);

function planArtifact(overrides = {}) {
  return {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content: [
      "# Plan restore execution contract",
      "",
      "## User goal",
      "- Resume an approved implementation without losing its task identity.",
      "",
      "## Summary",
      "- Read `src/App.tsx` and confirmed it owns the restored view.",
      "",
      "## Read evidence",
      "- `src/App.tsx`: the component renders the restored view.",
      "",
      "## Key changes",
      "- Modify `src/App.tsx` so the restored view renders the approved state.",
      "",
      "## Public APIs / interfaces / types",
      "- Keep the existing component props unchanged.",
      "",
      "## Execution steps",
      "1. Update the restored rendering branch in `src/App.tsx`.",
      "2. Run the focused verification command.",
      "",
      "## Validation criteria",
      "- The restored view renders the approved state.",
      "",
      "## Test plan",
      "- Run `npm test` and require a zero exit code.",
      "",
      "## Assumptions and defaults",
      "- Preserve unrelated rendering behavior.",
      "",
    ].join("\n"),
    updatedAt: 1,
    ...overrides,
  };
}

function planTask(overrides = {}) {
  return {
    id: "task-1",
    text: "Modify src/App.tsx so the restored view renders the approved state",
    status: "pending",
    executionKind: "mutation",
    evidenceStatus: "missing",
    source: "runtime",
    evidence: [{ kind: "file", value: "src/App.tsx" }],
    ...overrides,
  };
}

function validationTask(overrides = {}) {
  return {
    id: "task-validate",
    text: "Run verification command `npm test`",
    status: "pending",
    executionKind: "validation",
    evidenceStatus: "missing",
    source: "runtime",
    commands: ["npm test"],
    evidence: [{ kind: "cmd", value: "npm test" }],
    ...overrides,
  };
}

function progressSnapshot(overrides = {}) {
  return {
    turnId: "turn-plan",
    phase: "paused",
    currentTaskId: "task-1",
    currentTask: "Modify src/App.tsx so the restored view renders the approved state",
    currentTool: "",
    latestEvidence: "",
    nextStep: "Apply the approved mutation",
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
    currentTurnId: "turn-plan",
    planArtifacts: [],
    planTasks: [],
    planStage: "idle",
    planExecutionEvidenceLedger: [],
    planExecutionProgressSnapshot: null,
    isPlanApproved: false,
    conversationTurns: [{ id: "turn-plan", userPrompt: "Continue the approved plan" }],
    ...overrides,
  };
}

function createHarness(state) {
  return {
    preRunPatches: [],
    logs: [],
    resumes: [],
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
    resumeSubmission(text, images, options) {
      this.resumes.push({ text, images, options });
    },
  };
}

test("plan execution resume hydrates plan state and restarts the target logical turn", async () => {
  const state = createState();
  const harness = createHarness(state);
  const hydratedTask = planTask();
  const hydratedValidation = validationTask();

  await runSubmitPlanExecutionResumeEffect({
    text: "继续执行计划",
    images: ["ignored-image"],
    preferredLanguage: "zh",
    shouldRouteContinuationToPlanResume: true,
    uiParentTurnId: "turn-parent",
    commandDirective: { kind: "control", action: "resume_plan_execution" },
    getState: () => state,
    setState: harness.setState.bind(harness),
    applyPreRunSessionPatch: harness.applyPreRunSessionPatch.bind(harness),
    hydrateExistingPlanArtifactsForWorkspace: async () => ({
      artifacts: [planArtifact()],
      tasks: [hydratedTask, hydratedValidation],
      hasTasksArtifact: true,
    }),
    ensureApprovedPlanRuntimeTasksForState: () => [hydratedTask, hydratedValidation],
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
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
  assert.equal(state.isPlanApproved, true);
  assert.equal(state.planApprovalChoice, "继续执行计划");
  assert.equal(state.planStage, "executing");
  assert.equal(state.showPlanPanel, true);
  assert.equal(state.rightPanelTab, "plan");
  assert.equal(state.showDiff, false);
  assert.deepEqual(harness.logs, [
    {
      event: "existing_plan_hydrated_for_execution",
      data: {
        workspace: "/repo",
        reusedExistingState: false,
        artifacts: [".MAIN/plans/plan.md"],
        taskCount: 2,
      },
    },
  ]);
  assert.equal(harness.resumes.length, 1);
  assert.match(harness.resumes[0].text, /请在新的恢复上下文中继续执行计划/);
  assert.match(harness.resumes[0].text, /Modify src\/App\.tsx/);
  assert.equal(harness.resumes[0].images, undefined);
  assert.deepEqual(harness.resumes[0].options, {
    hidden: true,
    createVisibleTurnForHiddenMessage: false,
    reuseCurrentTurn: true,
    turnIdOverride: "turn-parent",
    preservePlanState: true,
    resolvedIntent: "execute",
    commandDirective: { kind: "control", action: "resume_plan_execution" },
    executionConsentGranted: true,
    skipIntentResolution: true,
    turnTitle: "计划执行恢复",
    intentSummary: "从已批准计划的剩余任务继续执行。",
  });
});

test("plan execution resume reuses existing plan state without rehydrating", async () => {
  const existingTask = planTask({ id: "existing-task" });
  const state = createState({
    planArtifacts: [planArtifact()],
    planTasks: [existingTask, validationTask()],
    planStage: "ready_to_execute",
    isPlanApproved: true,
    planExecutionProgressSnapshot: progressSnapshot({
      currentTaskId: "existing-task",
      currentTask: existingTask.text,
    }),
  });
  const harness = createHarness(state);
  let hydrateCalls = 0;

  await runSubmitPlanExecutionResumeEffect({
    text: "continue plan",
    preferredLanguage: "en",
    shouldRouteContinuationToPlanResume: true,
    commandDirective: null,
    getState: () => state,
    setState: harness.setState.bind(harness),
    applyPreRunSessionPatch: harness.applyPreRunSessionPatch.bind(harness),
    hydrateExistingPlanArtifactsForWorkspace: async () => {
      hydrateCalls += 1;
      return { artifacts: [], tasks: [], hasTasksArtifact: false };
    },
    ensureApprovedPlanRuntimeTasksForState: () => [],
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
  });

  assert.equal(hydrateCalls, 0);
  assert.equal(state.planStage, "executing");
  assert.equal(harness.logs[0].data.reusedExistingState, true);
  assert.equal(harness.logs[0].data.taskCount, 2);
  assert.equal(harness.resumes.length, 1);
  assert.match(harness.resumes[0].text, /Continue plan execution in a fresh recovery context/);
  assert.equal(harness.resumes[0].options.turnTitle, "Plan Execution Resume");
  assert.equal(harness.resumes[0].options.reuseCurrentTurn, true);
  assert.equal(harness.resumes[0].options.turnIdOverride, "turn-plan");
  assert.equal(state.planExecutionProgressSnapshot.currentTaskId, "existing-task");
});

test("plan execution resume revokes an invalid old Plan while preserving its audit artifact", async () => {
  const invalidPlan = planArtifact({
    content: "# Plan\n\n## Key changes\n- Modify `src/App.tsx`.",
  });
  const state = createState({
    planArtifacts: [invalidPlan],
    planTasks: [planTask(), validationTask()],
    planStage: "executing",
    isPlanApproved: true,
  });
  const harness = createHarness(state);
  const blocked = [];

  await runSubmitPlanExecutionResumeEffect({
    text: "continue plan",
    preferredLanguage: "en",
    shouldRouteContinuationToPlanResume: true,
    commandDirective: null,
    getState: () => state,
    setState: harness.setState.bind(harness),
    applyPreRunSessionPatch: harness.applyPreRunSessionPatch.bind(harness),
    hydrateExistingPlanArtifactsForWorkspace: async () => {
      throw new Error("reviewable in-memory Plan must be audited before any disk fallback");
    },
    ensureApprovedPlanRuntimeTasksForState: () => [planTask(), validationTask()],
    resumeSubmission: harness.resumeSubmission.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
    onResumeBlocked: (message, detail) => blocked.push({ message, detail }),
  });

  assert.equal(state.isPlanApproved, false);
  assert.equal(state.planStage, "plan");
  assert.equal(state.planArtifacts.length, 1);
  assert.equal(state.planArtifacts[0].content, invalidPlan.content);
  assert.equal(state.planExecutionProgressSnapshot, null);
  assert.equal(harness.resumes.length, 0);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].message, /kept it as an audit record/);
  assert.equal(harness.logs.at(-1).event, "existing_plan_resume_revalidation_blocked");
});

test("plan execution resume pauses when the checkpoint turn or run owner is stale", async () => {
  for (const mismatch of ["turn", "run"]) {
    const task = planTask();
    const snapshot = progressSnapshot({
      ...(mismatch === "turn" ? { turnId: "turn-stale" } : {}),
      ...(mismatch === "run" ? { runId: "run-stale", parentRunId: "run-parent" } : {}),
    });
    const state = createState({
      planArtifacts: [planArtifact()],
      planTasks: [task, validationTask()],
      planStage: "executing",
      isPlanApproved: true,
      planExecutionProgressSnapshot: snapshot,
      harnessRunMarker: mismatch === "run"
        ? {
            runId: "outer-run",
            activeRunId: "run-current",
            activeParentRunId: "run-parent",
            turnId: "turn-plan",
          }
        : null,
    });
    const harness = createHarness(state);
    const blocked = [];

    await runSubmitPlanExecutionResumeEffect({
      text: "continue plan",
      preferredLanguage: "en",
      shouldRouteContinuationToPlanResume: true,
      commandDirective: null,
      getState: () => state,
      setState: harness.setState.bind(harness),
      applyPreRunSessionPatch: harness.applyPreRunSessionPatch.bind(harness),
      hydrateExistingPlanArtifactsForWorkspace: async () => {
        throw new Error("valid in-memory Plan should not rehydrate");
      },
      ensureApprovedPlanRuntimeTasksForState: () => [task, validationTask()],
      resumeSubmission: harness.resumeSubmission.bind(harness),
      logStoreEvent: harness.logStoreEvent.bind(harness),
      onResumeBlocked: (message, detail) => blocked.push({ message, detail }),
    });

    assert.equal(state.isPlanApproved, false, mismatch);
    assert.equal(state.planStage, "plan", mismatch);
    assert.equal(harness.resumes.length, 0, mismatch);
    assert.equal(blocked.length, 1, mismatch);
    assert.equal(
      blocked[0].detail.reason,
      mismatch === "turn"
        ? "plan_resume_progress_owner_mismatch"
        : "plan_resume_progress_run_owner_mismatch",
      mismatch,
    );
  }
});

test("trusted plan resume prompt summarizes evidence and remaining tasks", () => {
  const prompt = buildTrustedPlanResumePrompt({
    language: "en",
    hasTasksArtifact: false,
    tasks: [planTask()],
    artifacts: [planArtifact()],
    evidenceLedger: [
      {
        kind: "cmd",
        value: "npm test",
        target: "npm test",
        sourceTool: "run_command",
      },
    ],
  });

  assert.match(prompt, /Plan artifact summary:/);
  assert.match(prompt, /Recent trusted execution evidence:/);
  assert.match(prompt, /cmd:npm test \(run_command\)/);
  assert.match(prompt, /Priority recovery tasks:/);
});
