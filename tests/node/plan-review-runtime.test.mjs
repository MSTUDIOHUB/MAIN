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
  createPlanReviewRuntimeHandlers,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/planReviewRuntime.ts"),
);
const {
  resolveIterationToolSurface,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"),
);

function basePlanRuntimeState(overrides = {}) {
  return {
    planRuntimePhase: "explore_structure",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planArtifactQualityRejected: false,
    planEvidenceRecoveryPasses: 0,
    planReasoningOnlyRecoveryPasses: 0,
    planAutoScaffoldPromptIssued: false,
    planDraftingRecoveryReadCount: 0,
    planClosureEvidenceRecoveryIssued: false,
    planReadOnlyConvergenceBatches: 0,
    planReadOnlyConvergenceTools: 0,
    sawPlanModeToolActivity: false,
    usedPlanRecoveryPrompt: false,
    usedPlanClosureGuard: false,
    usedPlanClosurePrompt: false,
    usedPlanReadOnlyConvergencePrompt: false,
    planPostConvergenceToolRedirectCount: 0,
    ...overrides,
  };
}

function createHandlers(overrides = {}) {
  const events = [];
  const abortController = overrides.abortController ?? new AbortController();
  let currentStatus = "running";
  let planRuntimeState = basePlanRuntimeState(overrides.planRuntimeState);
  let approvedPlanRecoveryState = {
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
    approvedPlanLongReasoningNoActionCount: 0,
  };
  const callbacks = {
    getIsPlanApproved: () => false,
    getStatus: () => currentStatus,
    onStatusChange: (status) => {
      currentStatus = status;
      events.push({ type: "status", status });
      overrides.onStatusObserved?.(status);
    },
    ...overrides.callbacks,
  };
  const handlers = createPlanReviewRuntimeHandlers({
    callbacks,
    abortController,
    workflowMode: overrides.workflowMode ?? "plan",
    latestUserPromptText: "Create a plan",
    recentPlanToolActivity: overrides.recentPlanToolActivity ?? [],
    attemptedPlanWriteTargets: [],
    getIteration: () => 3,
    getPlanRuntimeState: () => planRuntimeState,
    setPlanRuntimeState: (state) => {
      planRuntimeState = state;
    },
    getApprovedPlanRecoveryState: () => approvedPlanRecoveryState,
    setApprovedPlanRecoveryState: (state) => {
      approvedPlanRecoveryState = state;
    },
    setPlanRuntimePhase: (phase, reason, status) =>
      events.push({ type: "phase", phase, reason, status }),
    ...overrides.handlerInput,
  });
  return {
    abortController,
    events,
    handlers,
    getPlanRuntimeState: () => planRuntimeState,
    getApprovedPlanRecoveryState: () => approvedPlanRecoveryState,
  };
}

test("plan review wait returns immediately outside plan mode", async () => {
  const { events, handlers } = createHandlers({ workflowMode: "chat" });

  assert.equal(await handlers.waitForPlanApprovalIfNeeded(), true);
  assert.deepEqual(events, []);
});

test("plan review wait enters pending review and resolves false when aborted", async () => {
  const { abortController, events, handlers } = createHandlers();

  const wait = handlers.waitForPlanApprovalIfNeeded();
  assert.deepEqual(events, [{ type: "status", status: "pending_review" }]);
  abortController.abort();

  assert.equal(await wait, false);
});

test("plan review pause rejects a persisted quality-rejected artifact", async () => {
  const { events, handlers } = createHandlers({
    planRuntimeState: { planArtifactQualityRejected: true },
    callbacks: {
      getPlanStage: () => "plan",
    },
  });

  assert.equal(
    await handlers.pauseForReviewablePlanArtifact("next_iteration_no_tool"),
    "not_reviewable",
  );
  assert.deepEqual(events, []);
});

test("an accepted rewrite can enter review with the current tool-phase quality state", async () => {
  const { abortController, events, handlers } = createHandlers({
    // This deliberately models the outer loop before the tool phase has been
    // folded: it still holds the previous rejection.
    planRuntimeState: { planArtifactQualityRejected: true },
    callbacks: {
      getPlanStage: () => "plan",
      getPreferredLanguage: () => "en",
      onAssistantFinalText: () => {},
    },
  });

  const pause = handlers.pauseForReviewablePlanArtifact(
    "accepted_rewrite_same_tool_phase",
    { planArtifactQualityRejected: false },
  );
  assert.equal(events.some((event) => event.type === "status" && event.status === "pending_review"), true);
  abortController.abort();

  assert.equal(await pause, "stopped");
  assert.equal(events.some((event) => event.type === "phase" && event.phase === "review_ready"), true);
});

test("plan approval continues in the same loop, preserves its owner, and reopens the initial source read", async () => {
  let approved = false;
  const trace = [];
  const lifecycle = [];
  const appendedMessages = [];
  const recentPlanToolActivity = [{
    name: "write_file",
    status: "succeeded",
    target: ".MAIN/plans/plan.md",
  }];
  const tasks = [{
    id: "edit-main",
    text: "Modify src/main.rs",
    status: "pending",
    evidenceStatus: "missing",
    evidence: [{ kind: "file", value: "src/main.rs" }],
  }];
  const { events, handlers } = createHandlers({
    recentPlanToolActivity,
    onStatusObserved: (status) => lifecycle.push(`status:${status}`),
    callbacks: {
      getIsPlanApproved: () => approved,
      getPlanStage: () => "design",
      getPreferredLanguage: () => "en",
      getPlanApprovalChoice: () => null,
      getPlanTasks: () => tasks,
      getMessages: () => [{ role: "user", content: "Fix the Rust backend" }],
      onAssistantFinalText: () => {
        lifecycle.push("final");
        trace.push("final");
      },
      onPlanStageChanged: (stage) => trace.push(`stage:${stage}`),
      onApprovedPlanExecutionStarted: () => trace.push("execution_started"),
      appendMessage: (message) => appendedMessages.push(message),
    },
  });

  const pause = handlers.pauseForReviewablePlanArtifact("test");
  setTimeout(() => {
    approved = true;
  }, 10);

  assert.equal(await pause, "approved_continue");
  const pendingIndex = events.findIndex((event) => event.type === "status" && event.status === "pending_review");
  assert.ok(pendingIndex >= 0);
  assert.deepEqual(lifecycle.slice(0, 2), ["status:pending_review", "final"]);
  assert.deepEqual(trace.slice(0, 3), ["final", "stage:executing", "execution_started"]);
  assert.equal(events.filter((event) => event.type === "status" && event.status === "pending_review").length, 1);
  assert.equal(events.at(-1).status, "running");
  assert.equal(recentPlanToolActivity.length, 0);
  assert.equal(appendedMessages.length, 1);
  assert.match(appendedMessages[0].content, /EXECUTION MODE/);

  const tools = ["read_file", "apply_patch", "replace_in_file", "write_file", "run_command"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const surface = resolveIterationToolSurface({
    callbacks: {
      getIsPlanApproved: () => true,
      getPlanTasks: () => tasks,
      getPlanExecutionEvidenceLedger: () => [],
      getMessages: () => [],
      getPlanStage: () => "executing",
    },
    iteration: 1,
    workflowMode: "plan",
    runtimeIntent: "execute",
    rawIterationAllTools: tools,
    executeRecoveryMode: "normal",
    executeRecoveryReason: "",
    executeRecoveryAttempts: 0,
    recoveryIterationCount: 0,
    maxRecoveryIterations: 6,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanLongReasoningNoActionCount: 0,
    recentToolActivity: [],
    recentPlanToolActivity,
    planRuntimePhase: "executing",
    planDraftingRecoveryReadCount: 0,
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {},
    lastAssistantTextForCheckpoint: "",
  });
  assert.equal(surface.allowApprovedPlanRecoveryFileRead, true);
  assert.equal(surface.iterationAllTools.some((tool) => tool.function.name === "read_file"), true);
});
