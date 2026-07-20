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
    setPlanRuntimePhase: (phase, reason, status) =>
      events.push({ type: "phase", phase, reason, status }),
    ...overrides.handlerInput,
  });
  return {
    abortController,
    events,
    handlers,
    getPlanRuntimeState: () => planRuntimeState,
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

test("plan review cannot open from a stale stage without a materialized artifact", async () => {
  const { events, handlers } = createHandlers({
    callbacks: {
      getPlanStage: () => "design",
      getPlanArtifacts: () => [],
    },
  });

  assert.equal(
    await handlers.pauseForReviewablePlanArtifact("stale_stage"),
    "not_reviewable",
  );
  assert.deepEqual(events, []);
});

test("plan approval is rejected when the reviewed artifact changes before execution", async () => {
  let approved = false;
  let artifactContent = "# Plan\n\n- Change A";
  const { handlers } = createHandlers({
    onStatusObserved: (status) => {
      if (status !== "pending_review") return;
      artifactContent = "# Plan\n\n- Change B";
      approved = true;
    },
    callbacks: {
      getIsPlanApproved: () => approved,
      getPlanStage: () => "plan",
      getPlanArtifacts: () => [{
        kind: "plan",
        path: ".MAIN/plans/plan.md",
        title: "Plan",
        content: artifactContent,
        revision: artifactContent.endsWith("B") ? 2 : 1,
        updatedAt: 1,
      }],
      getPreferredLanguage: () => "en",
      onAssistantFinalText: () => {},
    },
  });

  assert.equal(
    await handlers.pauseForReviewablePlanArtifact("artifact_changed"),
    "stopped",
  );
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

test("plan review fails closed when a validation section has no executable task", async () => {
  const artifact = {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content: [
      "# Proposed Plan",
      "",
      "## Implementation",
      "- Modify `src/main.ts` to preserve the parsed creator name in the returned object.",
      "",
      "## Test Plan",
      "- Upload a CSV and manually inspect the creator shown on the dashboard.",
    ].join("\n"),
    revision: 1,
    updatedAt: 1,
  };
  const { events, handlers, getPlanRuntimeState } = createHandlers({
    callbacks: {
      getPlanStage: () => "plan",
      getPlanArtifacts: () => [artifact],
      getPreferredLanguage: () => "en",
      onAssistantFinalText: () => {},
    },
  });

  assert.equal(await handlers.pauseForReviewablePlanArtifact("missing_validation_command"), "not_reviewable");
  assert.equal(events.some((event) => event.type === "status" && event.status === "pending_review"), false);
  assert.equal(getPlanRuntimeState().planArtifactQualityRejected, true);
  assert.equal(
    getPlanRuntimeState().planLastQualityGateReason,
    "executable_validation_task_missing",
  );
});

test("plan review accepts an explicit finite non-Node validation command without manifest repair", async () => {
  const artifact = {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content: [
      "# Proposed Plan",
      "",
      "## Implementation",
      "- Modify `src/main.rs` to preserve the parsed creator name.",
      "",
      "## Test Plan",
      "- Run `cargo test` and inspect the exit status and output.",
    ].join("\n"),
    revision: 1,
    updatedAt: 1,
  };
  const { events, handlers } = createHandlers({
    callbacks: {
      getPlanStage: () => "plan",
      getPlanArtifacts: () => [artifact],
      getPreferredLanguage: () => "en",
      onAssistantFinalText: () => {},
    },
  });

  assert.equal(await handlers.pauseForReviewablePlanArtifact("explicit_cargo_test"), "stopped");
  assert.equal(events.some((event) => event.type === "status" && event.status === "pending_review"), true);
});

test("plan review pauses the current run and approved execution keeps the normal tool surface", async () => {
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
      getIsPlanApproved: () => false,
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

  assert.equal(await handlers.pauseForReviewablePlanArtifact("test"), "stopped");
  const pendingIndex = events.findIndex((event) => event.type === "status" && event.status === "pending_review");
  assert.ok(pendingIndex >= 0);
  assert.deepEqual(lifecycle.slice(0, 2), ["status:pending_review", "final"]);
  assert.deepEqual(trace, ["final"]);
  assert.equal(events.filter((event) => event.type === "status" && event.status === "pending_review").length, 1);
  assert.equal(events.at(-1).status, "pending_review");
  assert.equal(recentPlanToolActivity.length, 1);
  assert.equal(appendedMessages.length, 0);

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
    recentToolActivity: [],
    recentPlanToolActivity,
    planRuntimePhase: "executing",
    planDraftingRecoveryReadCount: 0,
    usedPlanReadOnlyConvergencePrompt: false,
    turnInputContextSignals: {},
    lastAssistantTextForCheckpoint: "",
  });
  assert.equal(surface.recoveryActionContract.phase, "normal");
  assert.equal(surface.iterationAllTools.some((tool) => tool.function.name === "read_file"), true);
});
