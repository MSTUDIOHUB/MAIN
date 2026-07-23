import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) return loadTranspiledModuleSync(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const repair = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planCandidateRepair.ts"),
);
const { extractTypedPlanDraftEnvelope } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planDraftIngress.ts"),
);
const { materializePlanArtifactFromVisibleText } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planMaterialization.ts"),
);
const { resolveNonActionableStopOutcome } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/completionGuards.ts"),
);
const { handlePlanNoToolRecovery } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/planNoToolRecovery.ts"),
);
const { handleEmptyResponseRecovery } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/emptyResponseRecovery.ts"),
);
const { buildPreapprovalPlanStreamWatchdogRecoveryPrompt } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/streamRecovery.ts"),
);
const { SUBMIT_PLAN_CANDIDATE_TOOL_DEFINITION } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/toolSchemas.ts"),
);
const { ensureProviderCompatibilityMode } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/providerCompatibility.ts"),
);
const { consumeNativePlanCandidateSubmission } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/requiredToolProtocol.ts"),
);

function baseDraft() {
  return {
    schemaVersion: 2,
    evidenceRefs: ["E1"],
    goalEvidenceBases: [{
      goalRef: "G1",
      componentRef: "B1",
      evidenceRefs: ["E1"],
      ownerRefs: ["src/runtime.ts"],
      relationRefs: [],
      diagnosisRefs: ["R1"],
    }],
    summary: ["Keep this summary."],
    diagnoses: [{
      id: "R1",
      text: "Observed relationship.",
      certainty: "observed",
      evidenceRefs: ["E1"],
      goalRefs: ["G1"],
      chainRefs: ["E1"],
    }],
    changes: [{
      id: "C1",
      text: "Update the runtime owner.",
      targetRef: "src/runtime.ts",
      operation: "modify",
      evidenceRefs: ["E1"],
      diagnosisRefs: ["R1"],
      goalRefs: ["G1"],
      expectedOutcome: "The runtime uses the selected owner.",
      relationships: [],
    }],
    decisions: [],
    interfaces: [],
    validations: [{
      id: "V1",
      goalRefs: ["G1"],
      changeRefs: ["C1"],
      primitive: { kind: "finite_command", command: "node --test focused.test.mjs" },
      expectedOutcome: "",
    }],
    assumptions: [],
    blockingChoices: [],
  };
}

function checkpoint(draft = baseDraft(), failures = ["typed_validation_outcome_missing:V1"]) {
  return repair.createPlanCandidateRepairCheckpoint({
    draft,
    evidenceBundleHash: "bundle-hash",
    evidenceReceiptHash: "receipt-hash",
    failures,
    outputChars: 4_000,
  });
}

function patch(baseDraftHash, operations) {
  return {
    schemaVersion: 2,
    repair: {
      contractVersion: 1,
      baseDraftHash,
      operations,
    },
  };
}

function planEnvelope(value) {
  return `<plan_candidate>${JSON.stringify(value)}</plan_candidate>`;
}

const materializationBundle = {
  bundleId: "repair-bundle",
  hash: "repair-bundle-hash",
  turnId: "repair-turn",
  objective: "Update src/runtime.ts so the runtime uses the selected owner.",
  constraints: [],
  facts: [{
    id: "E1",
    tool: "read_file",
    target: "src/runtime.ts",
    summary: "The runtime owner boundary was observed.",
    hash: "repair-e1-hash",
  }],
  observedTargets: ["src/runtime.ts"],
  changeTargets: ["src/runtime.ts"],
  verificationTargets: ["tests/node/plan-candidate-repair.test.mjs"],
  coverageObligations: [],
  evidenceComponents: [{
    id: "B1",
    evidenceRefs: ["E1"],
    ownerRefs: ["src/runtime.ts"],
    relationRefs: [],
    requiredForClosure: false,
    supportsDiagnosis: false,
  }],
};

function materialize(value, candidateRepairCheckpoint = null) {
  return materializePlanArtifactFromVisibleText({
    visibleText: planEnvelope(value),
    userGoal: materializationBundle.objective,
    evidenceBundle: materializationBundle,
    expectedEvidenceBundleHash: materializationBundle.hash,
    ingressMode: "typed_runtime",
    candidateRepairCheckpoint,
    language: "en",
    turnContext: { mentionedFilePaths: ["src/runtime.ts"] },
  });
}

function noToolHarness() {
  const appended = [];
  const statuses = [];
  const stops = [];
  const phases = [];
  return {
    appended,
    statuses,
    stops,
    phases,
    callbacks: {
      getPreferredLanguage: () => "en",
      getMessages: () => [],
      getIsPlanApproved: () => false,
      getPlanStage: () => "requirements",
      getPlanArtifacts: () => [],
      getCurrentTurnId: () => "repair-turn",
      appendMessage: (message) => appended.push(message),
      onStatusChange: (status) => statuses.push(status),
      onAssistantFinalText: () => {},
      onStreamToken: () => {},
      onNonActionableStop: (message, reason, progress) => stops.push({ message, reason, progress }),
      onPlanStageChanged: () => {},
    },
  };
}

function noToolInput(harness, visibleText, overrides = {}) {
  return {
    callbacks: harness.callbacks,
    activeProfile: "local",
    iteration: 1,
    workflowMode: "plan",
    turnIntent: "plan",
    commandDirectiveAction: null,
    workspace: workspaceRoot,
    latestUserPromptText: materializationBundle.objective,
    streamText: visibleText,
    sourceVisibleText: visibleText,
    assistantHistoryText: visibleText,
    providerReasoningForHistory: null,
    hasStructuredProposal: true,
    hasReviewablePlanArtifacts: false,
    sawPlanModeToolActivity: true,
    wasTruncated: false,
    hasExecutablePlanProposalOptions: false,
    planReplyOptionsRoutedToArtifact: false,
    finalReplyOptionsCount: 0,
    effectiveToolCallCount: 0,
    hasMeaningfulVisibleText: true,
    normalizedVisibleText: visibleText,
    normalizedFinishReason: "stop",
    protocolViolation: undefined,
    protocolAllowedTools: [],
    protocolActualTools: [],
    assistantMsgId: "repair-assistant",
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/runtime.ts",
      status: "succeeded",
      detail: "The runtime owner boundary was observed.",
    }],
    attemptedPlanWriteTargets: [],
    turnInputContextSignals: { mentionedFilePaths: ["src/runtime.ts"] },
    consecutiveNoToolCount: 0,
    usedPlanRecoveryPrompt: false,
    planClosureEvidenceRecoveryIssued: false,
    planRuntimePhase: "drafting",
    planEvidenceRecoveryObjective: "none",
    planEvidenceRecoveryPasses: 0,
    planEvidenceNoProgressPasses: 0,
    planEvidenceProgressFingerprint: "",
    planVisibleQualityPromptBudget: [],
    planCandidateRepairCheckpoint: null,
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planFacetMappingSource: "",
    planArtifactQualityRejected: false,
    planAutoScaffoldPromptIssued: false,
    setPlanRuntimePhase: (phase, reason, status) => harness.phases.push({ phase, reason, status }),
    waitForPlanApprovalIfNeeded: async () => false,
    tryClosePlanWithEvidence: async () => "failed",
    ...overrides,
  };
}

test("local repair replaces only rejected nodes and preserves accepted graph plus evidence authority", () => {
  const draft = baseDraft();
  const state = checkpoint(draft);
  assert.equal(state.exhausted, false);
  assert.deepEqual(state.invalidTargets, [{ kind: "validation", id: "V1", index: 1 }]);

  const nextValidation = {
    ...draft.validations[0],
    expectedOutcome: "The focused check exits with status 0.",
  };
  const applied = repair.applyPlanCandidateRepairPatch({
    checkpoint: state,
    patch: patch(state.baseDraftHash, [{
      kind: "validation",
      operation: "replace",
      targetId: "V1",
      node: nextValidation,
    }]),
  });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.draft.validations, [nextValidation]);
  assert.deepEqual(applied.draft.diagnoses, draft.diagnoses);
  assert.deepEqual(applied.draft.changes, draft.changes);
  assert.deepEqual(applied.draft.evidenceRefs, draft.evidenceRefs);
  assert.strictEqual(applied.draft.evidenceRefs, draft.evidenceRefs);
  assert.equal(state.evidenceReceiptHash, "receipt-hash");

  const forbidden = repair.applyPlanCandidateRepairPatch({
    checkpoint: state,
    patch: patch(state.baseDraftHash, [{
      kind: "change",
      operation: "replace",
      targetId: "C1",
      node: draft.changes[0],
    }]),
  });
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.failures.join(","), /target_forbidden:change:C1/);
});

test("typed ingress defaults only optional display containers while semantic graph arrays stay required", () => {
  const draft = baseDraft();
  for (const key of ["summary", "interfaces", "assumptions", "blockingChoices"]) delete draft[key];
  const parsed = extractTypedPlanDraftEnvelope(planEnvelope(draft));
  assert.equal(parsed.status, "parsed");
  assert.deepEqual(parsed.draft.summary, []);
  assert.deepEqual(parsed.draft.interfaces, []);
  assert.deepEqual(parsed.draft.assumptions, []);
  // A submitted candidate cannot carry a blocking choice; omission therefore
  // means the same safe protocol state as an explicit empty list. Actual user
  // choices remain a separate <user_options> stop outside candidate authority.
  assert.deepEqual(parsed.draft.blockingChoices, []);

  const missingSemantic = baseDraft();
  delete missingSemantic.decisions;
  const rejected = extractTypedPlanDraftEnvelope(planEnvelope(missingSemantic));
  assert.equal(rejected.status, "invalid");
  assert.match(rejected.failures.join(","), /typed_plan_draft_field_missing:decisions/);
});

test("surface failures mark linked validations locally without rewriting the valid change", () => {
  const state = checkpoint(baseDraft(), ["typed_change_validation_surface_ungrounded:C1:desktop"]);
  assert.equal(state.exhausted, false);
  assert.deepEqual(state.addableKinds, ["validation"]);
  assert.deepEqual(state.invalidTargets, [{ kind: "validation", id: "V1", index: 1 }]);
  assert.equal(state.invalidTargets.some((target) => target.kind === "change"), false);
});

test("goal evidence basis failures expose only the affected B mapping or a missing mapping addition", () => {
  const invalid = checkpoint(baseDraft(), ["typed_goal_evidence_refs_mismatch:B1"]);
  assert.equal(invalid.exhausted, false);
  assert.deepEqual(invalid.invalidTargets, [{ kind: "goal_basis", id: "B1", index: 1 }]);
  assert.deepEqual(invalid.addableKinds, []);

  const missing = checkpoint(baseDraft(), [
    "typed_goal_evidence_component_unmapped:B2",
    "typed_goal_evidence_basis_missing:G2",
  ]);
  assert.equal(missing.exhausted, false);
  assert.deepEqual(missing.invalidTargets, []);
  assert.deepEqual(missing.addableKinds, ["goal_basis"]);

  const correctedBasis = {
    ...invalid.baseDraft.goalEvidenceBases[0],
    evidenceRefs: ["E1"],
  };
  const applied = repair.applyPlanCandidateRepairPatch({
    checkpoint: invalid,
    patch: patch(invalid.baseDraftHash, [{
      kind: "goal_basis",
      operation: "replace",
      targetId: "B1",
      node: correctedBasis,
    }]),
  });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.draft.goalEvidenceBases, [correctedBasis]);
  assert.deepEqual(applied.draft.evidenceRefs, invalid.baseDraft.evidenceRefs);
  assert.equal(invalid.evidenceReceiptHash, "receipt-hash");
});

test("different consecutive failures retain the first correction and stop after the bounded second repair", () => {
  const initial = checkpoint();
  const correctedValidation = {
    ...initial.baseDraft.validations[0],
    expectedOutcome: "The focused check exits with status 0.",
  };
  const firstApply = repair.applyPlanCandidateRepairPatch({
    checkpoint: initial,
    patch: patch(initial.baseDraftHash, [{
      kind: "validation",
      operation: "replace",
      targetId: "V1",
      node: correctedValidation,
    }]),
  });
  assert.equal(firstApply.ok, true);
  const secondState = repair.advancePlanCandidateRepairCheckpoint({
    checkpoint: initial,
    outputChars: 900,
    draft: firstApply.draft,
    failures: ["typed_change_outcome_missing:C1"],
  });
  assert.equal(secondState.exhausted, false);
  assert.equal(secondState.attempts, 1);
  assert.deepEqual(secondState.baseDraft.validations, [correctedValidation]);
  assert.deepEqual(secondState.invalidTargets, [{ kind: "change", id: "C1", index: 1 }]);

  const correctedChange = {
    ...secondState.baseDraft.changes[0],
    expectedOutcome: "A concrete corrected outcome.",
  };
  const secondApply = repair.applyPlanCandidateRepairPatch({
    checkpoint: secondState,
    patch: patch(secondState.baseDraftHash, [{
      kind: "change",
      operation: "replace",
      targetId: "C1",
      node: correctedChange,
    }]),
  });
  assert.equal(secondApply.ok, true);
  const exhausted = repair.advancePlanCandidateRepairCheckpoint({
    checkpoint: secondState,
    outputChars: 800,
    draft: secondApply.draft,
    failures: ["typed_goal_diagnosis_missing:G1"],
  });
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.attempts, 2);
  assert.equal(exhausted.terminalReason, "typed_plan_candidate_repair_attempts_exhausted");
  assert.deepEqual(exhausted.baseDraft.validations, [correctedValidation]);
  assert.deepEqual(exhausted.baseDraft.changes, [correctedChange]);
});

test("materialization accepts a local patch and refuses repeated whole-candidate rewrites", () => {
  const invalidDraft = baseDraft();
  const first = materialize(invalidDraft);
  assert.equal(first.ok, false);
  assert.equal(first.candidateRepairCheckpoint?.attempts, 0);
  assert.equal(first.candidateRepairExhausted, undefined);

  const correctedValidation = {
    ...invalidDraft.validations[0],
    expectedOutcome: "The focused check exits with status 0.",
  };
  const localPatch = patch(first.candidateRepairCheckpoint.baseDraftHash, [{
    kind: "validation",
    operation: "replace",
    targetId: "V1",
    node: correctedValidation,
  }]);
  const accepted = materializePlanArtifactFromVisibleText({
    visibleText: planEnvelope(localPatch),
    userGoal: materializationBundle.objective,
    evidenceBundle: materializationBundle,
    expectedEvidenceBundleHash: materializationBundle.hash,
    ingressMode: "typed_runtime",
    candidateRepairCheckpoint: first.candidateRepairCheckpoint,
    language: "en",
    turnContext: { mentionedFilePaths: ["src/runtime.ts"] },
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.candidate?.evidenceReceipt.bundleHash, materializationBundle.hash);
  assert.deepEqual(accepted.candidate?.changes.map((item) => item.id), ["C1"]);

  const nativeSubmission = consumeNativePlanCandidateSubmission({
    enabled: true,
    result: {
      content: "discarded provider prose",
      toolCalls: [{
        id: "repair-call",
        name: "submit_plan_candidate",
        arguments: JSON.stringify(localPatch),
      }],
    },
  });
  assert.equal(nativeSubmission.consumed, true);
  const acceptedNative = materializePlanArtifactFromVisibleText({
    visibleText: nativeSubmission.result.content,
    userGoal: materializationBundle.objective,
    evidenceBundle: materializationBundle,
    expectedEvidenceBundleHash: materializationBundle.hash,
    ingressMode: "typed_runtime",
    candidateRepairCheckpoint: first.candidateRepairCheckpoint,
    language: "en",
    turnContext: { mentionedFilePaths: ["src/runtime.ts"] },
  });
  assert.equal(acceptedNative.ok, true, JSON.stringify(acceptedNative));
  assert.equal(
    acceptedNative.candidate?.projection.contentHash,
    accepted.candidate?.projection.contentHash,
  );

  const correctedFullDraft = { ...invalidDraft, validations: [correctedValidation] };
  const firstRewrite = materialize(correctedFullDraft, first.candidateRepairCheckpoint);
  assert.equal(firstRewrite.ok, false);
  assert.match(firstRewrite.reason, /typed_plan_repair_patch_required/);
  assert.equal(firstRewrite.candidateRepairCheckpoint?.attempts, 1);
  assert.equal(firstRewrite.candidateRepairExhausted, undefined);
  const secondRewrite = materialize(correctedFullDraft, firstRewrite.candidateRepairCheckpoint);
  assert.equal(secondRewrite.ok, false);
  assert.equal(secondRewrite.candidateRepairCheckpoint?.attempts, 2);
  assert.equal(secondRewrite.candidateRepairExhausted, true);
  assert.equal(
    secondRewrite.candidateRepairCheckpoint?.terminalReason,
    "typed_plan_candidate_repair_attempts_exhausted",
  );
});

test("no-tool recovery dispatches only a local patch and exhausts as action-required without idle", async () => {
  const invalidDraft = baseDraft();
  const originalText = planEnvelope(invalidDraft);
  const firstHarness = noToolHarness();
  const first = await handlePlanNoToolRecovery(noToolInput(firstHarness, originalText));
  assert.equal(first.status, "continue");
  assert.ok(first.planCandidateRepairCheckpoint);
  assert.equal(firstHarness.appended.length, 1);
  assert.equal(firstHarness.appended[0].role, "user");
  assert.match(firstHarness.appended[0].content, /PLAN_CANDIDATE_LOCAL_REPAIR_V1/);
  assert.doesNotMatch(firstHarness.appended[0].content, /Keep this summary/);

  const correctedFullDraft = {
    ...invalidDraft,
    validations: [{
      ...invalidDraft.validations[0],
      expectedOutcome: "The focused check exits with status 0.",
    }],
  };
  const fullRewriteText = planEnvelope(correctedFullDraft);
  const secondHarness = noToolHarness();
  const second = await handlePlanNoToolRecovery(noToolInput(secondHarness, fullRewriteText, {
    iteration: 2,
    planCandidateRepairCheckpoint: first.planCandidateRepairCheckpoint,
    planQualityRejectCount: first.planQualityRejectCount,
    planArtifactQualityRejected: true,
  }));
  assert.equal(second.status, "continue");
  assert.equal(second.planCandidateRepairCheckpoint?.attempts, 1);

  const terminalHarness = noToolHarness();
  const terminal = await handlePlanNoToolRecovery(noToolInput(terminalHarness, fullRewriteText, {
    iteration: 3,
    planCandidateRepairCheckpoint: second.planCandidateRepairCheckpoint,
    planQualityRejectCount: second.planQualityRejectCount,
    planArtifactQualityRejected: true,
  }));
  assert.equal(terminal.status, "stopped");
  assert.equal(terminal.planCandidateRepairCheckpoint?.exhausted, true);
  assert.equal(terminalHarness.stops.length, 1);
  assert.equal(
    terminalHarness.stops[0].progress.recoveryReason,
    "plan_candidate_repair_budget_exhausted",
  );
  assert.equal(terminalHarness.stops[0].progress.phase, "paused");
  assert.equal(terminalHarness.statuses.includes("idle"), false);
  assert.equal(terminalHarness.phases.at(-1)?.phase, "blocked");
});

test("initial, per-repair, and cumulative budgets fail closed before another model round", () => {
  const oversizedInitial = repair.createPlanCandidateRepairCheckpoint({
    draft: baseDraft(),
    evidenceBundleHash: "bundle-hash",
    evidenceReceiptHash: "receipt-hash",
    failures: ["typed_validation_outcome_missing:V1"],
    outputChars: repair.MAX_TYPED_PLAN_INITIAL_OUTPUT_CHARS + 1,
  });
  assert.equal(oversizedInitial.exhausted, true);
  assert.equal(oversizedInitial.terminalReason, "typed_plan_candidate_initial_output_budget_exceeded");

  const oversizedRepair = repair.advancePlanCandidateRepairCheckpoint({
    checkpoint: checkpoint(),
    outputChars: repair.MAX_TYPED_PLAN_REPAIR_OUTPUT_CHARS + 1,
    failures: ["typed_plan_repair_patch_required"],
  });
  assert.equal(oversizedRepair.exhausted, true);
  assert.equal(oversizedRepair.terminalReason, "typed_plan_candidate_repair_output_budget_exceeded");
});

test("repair prompt is bounded and omits accepted node bodies", () => {
  const state = checkpoint();
  const prompt = repair.buildPlanCandidateRepairPrompt(state);
  assert.match(prompt, /PLAN_CANDIDATE_LOCAL_REPAIR_V1/);
  assert.match(prompt, /acceptedNodeIds=.*C1/);
  assert.doesNotMatch(prompt, /Update the runtime owner/);
  assert.match(prompt, /supersedes and suspends every earlier instruction/i);
  assert.ok(prompt.length <= repair.MAX_TYPED_PLAN_REPAIR_PROMPT_CHARS);
});

test("active repair empty replies consume the same bounded budget and pause without idle", async () => {
  const events = [];
  const callbacks = {
    getPreferredLanguage: () => "en",
    getIsPlanApproved: () => false,
    getPlanStage: () => "drafting",
    getSubagentDepth: () => 0,
    onStatusChange: (status) => events.push({ type: "status", status }),
    appendMessage: (message) => events.push({ type: "append", message }),
    onNonActionableStop: (message, reason, details) =>
      events.push({ type: "stop", message, reason, details }),
  };
  const run = (state, consecutiveEmptyResponseCount) => handleEmptyResponseRecovery({
    callbacks,
    activeProfile: "local",
    iteration: 4,
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    forceXmlTools: false,
    streamText: "",
    normalized: {
      visibleText: "",
      hiddenThought: "",
      replyOptions: [],
      hasExplicitUserChoiceRequest: false,
      toolCalls: [],
      finishReason: "stop",
    },
    normalizedBaseToolCallCount: 0,
    recentToolActivity: [],
    recentSuccessfulProjectWrite: null,
    consecutiveEmptyResponseCount,
    emptyResponseCountThisTurn: consecutiveEmptyResponseCount,
    usedMalformedToolUseRecoveryPrompt: false,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
    planCandidateRepairCheckpoint: state,
    pauseForReviewablePlanArtifact: async () => "not_reviewable",
    tryClosePlanWithEvidence: async () => "not_attempted",
  });

  const first = await run(checkpoint(), 0);
  assert.equal(first.status, "continue");
  assert.equal(first.planCandidateRepairCheckpoint.attempts, 1);
  const repairPrompt = events.filter((event) => event.type === "append").at(-1).message.content;
  assert.match(repairPrompt, /PLAN_CANDIDATE_LOCAL_REPAIR_V1/);
  assert.doesNotMatch(repairPrompt, /submit the complete typed graph/i);

  const second = await run(first.planCandidateRepairCheckpoint, 1);
  assert.equal(second.status, "stopped");
  assert.equal(second.planCandidateRepairCheckpoint.exhausted, true);
  const stop = events.findLast((event) => event.type === "stop");
  assert.equal(stop.details.recoveryReason, "plan_candidate_repair_budget_exhausted");
  assert.equal(events.some((event) => event.type === "status" && event.status === "idle"), false);
});

test("active repair watchdog recovery cannot revive a full-draft instruction", () => {
  for (const language of ["en", "zh"]) {
    const prompt = buildPreapprovalPlanStreamWatchdogRecoveryPrompt(language, false, true);
    assert.match(prompt, /PLAN_CANDIDATE_LOCAL_REPAIR_STREAM_RECOVERY/);
    assert.match(prompt, /repair patch/);
    assert.match(prompt, /暂停|suspended/i);
    assert.doesNotMatch(prompt, /otherwise submit the complete typed graph/i);
  }
});

test("drafting tool feedback defers to the active schema instead of hardcoding full resubmission", () => {
  const source = fs.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");
  const start = source.indexOf("export function planUnsupportedToolFeedbackMessage");
  const end = source.indexOf("\nexport function ", start + 20);
  const functionSource = source.slice(start, end > start ? end : undefined);
  assert.match(functionSource, /latest \[PLAN AUTHORING CONTRACT\]/);
  assert.match(functionSource, /active .*schema/);
  assert.doesNotMatch(functionSource, /with the complete typed graph/);
});

test("active repair uses a phase-scoped native schema and the same patch-only text fallback", () => {
  const state = checkpoint();
  const originalRequired = SUBMIT_PLAN_CANDIDATE_TOOL_DEFINITION.function.parameters.required;
  assert.ok(originalRequired.includes("evidenceRefs"));
  const [repairTool] = repair.replacePlanCandidateSubmissionToolForRepair(
    [SUBMIT_PLAN_CANDIDATE_TOOL_DEFINITION],
    state,
  );
  assert.notEqual(repairTool, SUBMIT_PLAN_CANDIDATE_TOOL_DEFINITION);
  assert.deepEqual(repairTool.function.parameters.required, ["schemaVersion", "repair"]);
  assert.equal(repairTool.function.parameters.properties.evidenceRefs, undefined);
  assert.deepEqual(
    repairTool.function.parameters.properties.repair.properties.baseDraftHash.enum,
    [state.baseDraftHash],
  );
  assert.equal(SUBMIT_PLAN_CANDIDATE_TOOL_DEFINITION.function.parameters.required, originalRequired);

  const native = repair.buildPlanCandidateRepairIterationProtocol({
    checkpoint: state,
    submissionTransport: "native_tool",
  });
  assert.match(native.primaryCard, /Call submit_plan_candidate exactly once with the patch object/);
  assert.doesNotMatch(native.primaryCard, /complete typed graph|complete replacement object|not a delta/i);
  assert.doesNotMatch(native.primaryCard, /"goalEvidenceBases".*"summary".*"diagnoses"/);
  assert.match(native.providerCompatibilityCard, /<plan_candidate>\{"schemaVersion":2,"repair":/);
  assert.doesNotMatch(native.providerCompatibilityCard, /complete typed graph|complete replacement object|not a delta/i);

  const compatibilityMessages = ensureProviderCompatibilityMode([
    {
      role: "system",
      content: "[PLAN AUTHORING CONTRACT]\nFULL_RESUBMIT_ONLY\n[/PLAN AUTHORING CONTRACT]",
    },
  ], "plan", [repairTool], {
    replacementPlanAuthoringContract: native.providerCompatibilityCard,
  });
  const compatibilityText = compatibilityMessages.map((message) => message.content).join("\n");
  assert.doesNotMatch(compatibilityText, /FULL_RESUBMIT_ONLY/);
  assert.match(compatibilityText, /PLAN_CANDIDATE_LOCAL_REPAIR_V1/);
  assert.match(compatibilityText, /<plan_candidate>\{"schemaVersion":2,"repair":/);

  const textOnly = repair.buildPlanCandidateRepairIterationProtocol({
    checkpoint: state,
    submissionTransport: "text_envelope",
  });
  assert.equal(textOnly.providerCompatibilityCard, undefined);
  assert.match(textOnly.primaryCard, /<plan_candidate>\{"schemaVersion":2,"repair":/);
  assert.doesNotMatch(textOnly.primaryCard, /complete typed graph|complete replacement object|not a delta/i);
});

test("repair budget exhaustion projects a canonical action-required pause", () => {
  assert.deepEqual(
    resolveNonActionableStopOutcome("incomplete_plan", {
      phase: "paused",
      recoveryReason: "plan_candidate_repair_budget_exhausted",
      nextStep: "typed_plan_candidate_repair_attempts_exhausted",
    }),
    {
      status: "paused",
      pauseKind: "action_required",
      reason: "plan_candidate_repair_budget_exhausted",
    },
  );
});
