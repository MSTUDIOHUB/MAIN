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
const {
  createDraftPlanCandidate,
  hashPlanCandidate,
  sealPlanCandidate,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planContract.ts"),
);

function buildTypedReviewArtifact(overrides = {}) {
  const variant = String(overrides.variant || "").trim();
  const content = [
    "# Proposed Plan",
    "",
    "## User goal",
    `- Keep the reviewed Plan bound to one sealed runtime task graph.${variant ? ` ${variant}` : ""}`,
    "",
    "## Confirmed evidence",
    "- [E1] `src/main.ts` owns the state transition that must change.",
    "",
    "## Key changes",
    "- [C1] Modify `src/main.ts` so the state transition preserves the reviewed invariant.",
    "",
    "## Test Plan",
    "- [V1] For C1, run `npm test` and require exit status 0.",
  ].join("\n");
  const authoringContract = {
    version: 7,
    contractId: "review-runtime-contract",
    objective: "Keep the reviewed Plan bound to one sealed runtime task graph.",
    facets: [{
      id: "G1",
      index: 1,
      text: "Keep the reviewed Plan bound to one sealed runtime task graph.",
    }],
    contextTargets: [],
    reusableEvidenceTargets: [],
    imageCount: 0,
    diagnosisRequired: false,
    criteria: [],
  };
  const bundle = {
    bundleId: "review-runtime-bundle",
    hash: "review-runtime-bundle-hash",
    turnId: "turn-review-runtime",
    objective: authoringContract.objective,
    constraints: [],
    facts: [{
      id: "E1",
      tool: "read_file",
      target: "src/main.ts",
      summary: "src/main.ts owns the reviewed state transition.",
      hash: "review-runtime-e1",
    }],
    changeTargets: ["src/main.ts"],
    verificationTargets: [],
  };
  const draft = createDraftPlanCandidate({
    content,
    bundle,
    authoringContract,
    summary: ["Bind review and execution to the same typed Plan."],
    findings: [],
    diagnoses: [],
    changes: [{
      text: "[C1] Modify src/main.ts so the state transition preserves the reviewed invariant.",
      targetRef: "src/main.ts",
      evidenceRefs: ["E1"],
    }],
    interfaces: [],
    tests: ["V1"],
    assumptions: [],
    blockingChoices: [],
  });
  const candidate = sealPlanCandidate({
    candidate: draft,
    content,
    runtimeTasks: [{
      id: "review-runtime-validation",
      text: "[V1] Run npm test and require exit status 0.",
      status: "pending",
      executionKind: "validation",
      requirementRef: "G1",
      validation: [{
        kind: "finite_command",
        acceptance: "required",
        command: "npm test",
        capability: "test",
        segments: [{
          command: "npm test",
          connector: "start",
          role: "validator",
          capability: "test",
        }],
      }],
    }],
  });
  return {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    candidate,
    candidateHash: hashPlanCandidate(candidate),
    authoringContractId: candidate.authoringContractId,
    revision: overrides.revision ?? 1,
    updatedAt: 1,
  };
}

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
  const artifact = buildTypedReviewArtifact();
  const { abortController, events, handlers } = createHandlers({
    callbacks: {
      getPlanArtifacts: () => [artifact],
    },
  });

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

test("plan review accepts a coherent sealed typed candidate", async () => {
  const artifact = buildTypedReviewArtifact();
  const { events, handlers } = createHandlers({
    callbacks: {
      getPlanStage: () => "plan",
      getPlanArtifacts: () => [artifact],
      getPreferredLanguage: () => "en",
      onAssistantFinalText: () => {},
    },
  });

  assert.equal(await handlers.pauseForReviewablePlanArtifact("typed_candidate"), "stopped");
  assert.equal(
    events.some((event) => event.type === "status" && event.status === "pending_review"),
    true,
  );
});

test("plan review fail-closes typed metadata when its candidate is missing", async () => {
  const { candidate: _candidate, ...partialArtifact } = buildTypedReviewArtifact();
  const { events, handlers, getPlanRuntimeState } = createHandlers({
    callbacks: {
      getPlanStage: () => "plan",
      getPlanArtifacts: () => [partialArtifact],
      getPreferredLanguage: () => "en",
      onAssistantFinalText: () => {},
    },
  });

  assert.equal(
    await handlers.pauseForReviewablePlanArtifact("partial_typed_candidate"),
    "not_reviewable",
  );
  assert.equal(getPlanRuntimeState().planArtifactQualityRejected, true);
  assert.equal(
    getPlanRuntimeState().planLastQualityGateReason,
    "candidate_metadata_without_candidate",
  );
  assert.equal(
    events.some((event) => event.type === "status" && event.status === "pending_review"),
    false,
  );
});

test("plan review rejects malformed candidate payloads without throwing", async () => {
  const malformedCandidate = { schemaVersion: 4, state: "sealed" };
  malformedCandidate.circular = malformedCandidate;
  const artifact = {
    ...buildTypedReviewArtifact(),
    candidate: malformedCandidate,
    candidateHash: "plan-candidate-sha256-malformed",
    authoringContractId: "review-runtime-contract",
  };
  const { events, handlers, getPlanRuntimeState } = createHandlers({
    callbacks: {
      getPlanStage: () => "plan",
      getPlanArtifacts: () => [artifact],
      getPreferredLanguage: () => "en",
      onAssistantFinalText: () => {},
    },
  });

  await assert.doesNotReject(() =>
    handlers.pauseForReviewablePlanArtifact("malformed_typed_candidate")
  );
  assert.equal(getPlanRuntimeState().planLastQualityGateReason, "candidate_payload_malformed");
  assert.equal(
    events.some((event) => event.type === "status" && event.status === "pending_review"),
    false,
  );
});

test("plan review rejects candidate hash and authoring-contract drift", async () => {
  for (const [field, value, expectedReason] of [
    ["candidateHash", "plan-candidate-sha256-drift", "candidate_hash_mismatch"],
    ["authoringContractId", "other-authoring-contract", "candidate_authoring_contract_mismatch"],
  ]) {
    const artifact = { ...buildTypedReviewArtifact(), [field]: value };
    const { handlers, getPlanRuntimeState } = createHandlers({
      callbacks: {
        getPlanStage: () => "plan",
        getPlanArtifacts: () => [artifact],
        getPreferredLanguage: () => "en",
        onAssistantFinalText: () => {},
      },
    });

    assert.equal(
      await handlers.pauseForReviewablePlanArtifact(`drift_${field}`),
      "not_reviewable",
    );
    assert.equal(getPlanRuntimeState().planLastQualityGateReason, expectedReason);
  }
});

test("approval wait invalidates an already-approved partial typed candidate", async () => {
  const { candidate: _candidate, ...partialArtifact } = buildTypedReviewArtifact();
  const invalidations = [];
  const { handlers } = createHandlers({
    callbacks: {
      getIsPlanApproved: () => true,
      getPlanArtifacts: () => [partialArtifact],
      onPlanApprovalInvalidated: (reason) => invalidations.push(reason),
    },
  });

  assert.equal(await handlers.waitForPlanApprovalIfNeeded(), false);
  assert.deepEqual(invalidations, [
    "typed_plan_review_authority:primary_plan_integrity:candidate_metadata_without_candidate",
  ]);
});

test("plan approval is rejected when the reviewed artifact changes before execution", async () => {
  let approved = false;
  let artifact = buildTypedReviewArtifact();
  const invalidations = [];
  const { handlers } = createHandlers({
    onStatusObserved: (status) => {
      if (status !== "pending_review") return;
      artifact = buildTypedReviewArtifact({ variant: "Reviewed rewrite.", revision: 2 });
      approved = true;
    },
    callbacks: {
      getIsPlanApproved: () => approved,
      getPlanStage: () => "plan",
      getPlanArtifacts: () => [artifact],
      getPreferredLanguage: () => "en",
      onAssistantFinalText: () => {},
      onPlanApprovalInvalidated: (reason) => invalidations.push(reason),
    },
  });

  assert.equal(await handlers.waitForPlanApprovalIfNeeded(), false);
  assert.deepEqual(invalidations, ["typed_plan_review_identity_changed"]);
});

test("an accepted rewrite can enter review with the current tool-phase quality state", async () => {
  const artifact = buildTypedReviewArtifact();
  const { abortController, events, handlers } = createHandlers({
    // This deliberately models the outer loop before the tool phase has been
    // folded: it still holds the previous rejection.
    planRuntimeState: { planArtifactQualityRejected: true },
    callbacks: {
      getPlanStage: () => "plan",
      getPlanArtifacts: () => [artifact],
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

test("legacy Plan Markdown fails closed before executable validation", async () => {
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
    "primary_plan_not_typed",
  );
});

test("a supporting design artifact cannot become the primary review authority", async () => {
  const artifact = {
    kind: "design",
    path: ".MAIN/plans/design.md",
    title: "Design",
    content: [
      "# Design",
      "",
      "## Data flow",
      "- Parse the selected CSV, aggregate course sales, then render and export the report.",
      "",
      "## Validation",
      "- Use the supplied sample to check aggregation output and malformed-row handling.",
    ].join("\n"),
    revision: 1,
    updatedAt: 1,
  };
  const { events, handlers } = createHandlers({
    callbacks: {
      getPlanStage: () => "design",
      getPlanArtifacts: () => [artifact],
      getPreferredLanguage: () => "en",
      onAssistantFinalText: () => {},
    },
  });

  assert.equal(await handlers.pauseForReviewablePlanArtifact("design_strategy"), "not_reviewable");
  assert.equal(events.some((event) => event.type === "status" && event.status === "pending_review"), false);
});

test("legacy Plan Markdown with a finite command still cannot enter new review", async () => {
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

  assert.equal(await handlers.pauseForReviewablePlanArtifact("explicit_cargo_test"), "not_reviewable");
  assert.equal(events.some((event) => event.type === "status" && event.status === "pending_review"), false);
});

test("plan review pauses the current run and approved execution keeps the normal tool surface", async () => {
  const artifact = buildTypedReviewArtifact();
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
      getPlanArtifacts: () => [artifact],
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
