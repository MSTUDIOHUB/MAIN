import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const { assessPlanSubmission } = load("src/store/runtimeV2/planSubmissionAssessment.ts");
const { assertAdmittedPlanCriteriaMapped } = load("src/store/runtimeV2/planSubmissionPolicy.ts");
const { workPlanDraftFromSubmission } = load("src/store/runtimeV2/workPlanSubmission.ts");
const { PLAN_SUBMISSION_VALIDATION_REJECTION_CODE, recordRuntimeV2PlanSubmissionRejection,
  restoreRuntimeV2PlanSubmissionRepairHistory } = load("src/store/runtimeV2/planSubmissionRepair.ts");

const criterionIds = ["criterion-user-objective"];
const candidate = () => ({
  planMarkdown: "# Collector plan\nCreate the collector and verify its behavior.",
  changes: [{ title: "Create collector", operation: "create", targets: ["Assets/Collector.cs"], change: "Implement collection behavior." }],
  validations: [{ kind: "finite_command", command: "npm test", expectedOutcome: "Tests pass." }],
});
const assess = (submission, extra = {}) => assessPlanSubmission({ candidate: submission, evidence: [], objective: "Create collector", criterionIds, aggregate: null, ...extra });

test("five manual advisory checks become a draft with exact typed coverage diagnostics", () => {
  const submission = candidate();
  submission.validations = Array.from({ length: 5 }, (_, index) => ({ kind: "advisory", required: true, expectedOutcome: `Manually verify collector condition ${index}.` }));
  const result = assess(submission);
  assert.equal(result.kind, "draft");
  assert.equal(result.diagnostics.length, 5);
  result.diagnostics.forEach((diagnostic, index) => {
    assert.equal(diagnostic.code, "plan_validation_not_required");
    assert.equal(diagnostic.fieldPath, `validations[${index}]`);
    assert.deepEqual(diagnostic.criterionIds, criterionIds);
    assert.equal(diagnostic.rawKind, "advisory");
    assert.equal(diagnostic.compiledKind, "advisory");
  });
  const compiled = workPlanDraftFromSubmission(submission, [], "Create collector", criterionIds);
  assert.throws(() => assertAdmittedPlanCriteriaMapped({ draft: compiled.draft, criterionIds }), /cannot provide required validation coverage/);
});

test("a requested finite command records its downgrade instead of claiming the model authored advisory", () => {
  const submission = candidate();
  submission.validations = [{ kind: "finite_command", command: "npm run dev", required: true, expectedOutcome: "Service starts." }];
  const result = assess(submission);
  assert.equal(result.kind, "draft");
  assert.deepEqual(result.diagnostics[0], {
    code: "plan_validation_not_required", fieldPath: "validations[0].command", criterionIds,
    message: "validations[0].command: A service startup is advisory. Use a separate finite check that exits with a pass/fail result.",
    rawKind: "finite_command", compiledKind: "advisory", normalizationReason: "non_finite_command_downgraded_to_advisory",
    commandRejectionReason: "service_observation", commandSegmentIndex: 0,
  });
  assert.ok(result.normalizationReasons.includes("validations[0]:non_finite_command_downgraded_to_advisory"));
});

test("Unity editor probes and checks without failure semantics report the specific repair", () => {
  const submission = candidate();
  submission.validations = [
    { kind: "finite_command", command: "unity command script run --file AgentScripts/BuildBreakout.cs --dry_run true", expectedOutcome: "Dry run succeeds." },
    { kind: "finite_command", command: "unity command editor.playmode start && unity command script eval \"return GameManager.Instance.Score;\" && unity command editor.playmode stop", expectedOutcome: "Score increases." },
    { kind: "finite_command", command: "node -e \"console.log(true)\"", expectedOutcome: "The behavior is correct." },
    { kind: "finite_command", command: "npm test || true", expectedOutcome: "Tests pass." },
  ];
  const result = assess(submission, { requireBehavioralValidation: true });
  assert.equal(result.kind, "draft");
  assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.commandRejectionReason),
    ["unbounded_command_segment", "unbounded_command_segment", "inline_assertion_missing_failure_semantics", "non_fail_fast_connector"]);
  assert.ok(result.diagnostics.every(diagnostic => diagnostic.compiledKind === "advisory" &&
    diagnostic.rawKind === "finite_command" && diagnostic.criterionIds[0] === criterionIds[0]));
  assert.match(result.diagnostics[0].message, /test.*pass\/fail/i);
  assert.match(result.diagnostics[0].message, /unity test \. --mode PlayMode/);
  assert.match(result.diagnostics[2].message, /non-zero/i);
  assert.match(result.diagnostics[3].message, /exit status/i);
  assert.equal(result.diagnostics[1].commandSegmentIndex, 0);
});

test("candidate feedback remains parseable and bounded with many diagnostics", async () => {
  const diagnostics = Array.from({ length: 40 }, (_, index) => ({
    code: "plan_validation_not_required", fieldPath: `validations[${index}]`, criterionIds,
    commandRejectionReason: "unbounded_command_segment", message: 'A quote " and line break\n'.repeat(60),
  }));
  const messages = [];
  let receipt;
  await recordRuntimeV2PlanSubmissionRejection({
    ledger: { snapshot: () => null, schedule: async () => ({ idempotencyKey: "validation" }),
      settleCommand: async (event) => { receipt = event; } },
    run: { runId: "fixture" }, call: { id: "candidate", name: "submit_runtime_v2_work_plan", arguments: {} },
    messages, diagnostics,
  });
  assert.equal(messages[0].content, receipt.modelContent);
  assert.equal(receipt.failureReasonCode, PLAN_SUBMISSION_VALIDATION_REJECTION_CODE);
  assert.ok(receipt.modelContent.length <= 4_000);
  const feedback = JSON.parse(receipt.modelContent.replace(/^WORK_PLAN_REJECTED: /, ""));
  assert.equal(feedback.code, "PLAN_EXECUTION_READINESS_INCOMPLETE");
  assert.ok(feedback.omittedDiagnosticCount > 0);
  assert.equal(feedback.omittedDiagnosticCount + feedback.diagnostics.length, diagnostics.length);
  assert.deepEqual(feedback.diagnostics[0].criterionIds, criterionIds);
  assert.equal(feedback.diagnostics[0].commandRejectionReason, "unbounded_command_segment");
});

test("cold repair restores the latest same-Run typed rejection, including legacy presentation receipts", () => {
  const run = { sessionKey: "/fixture:1", sessionEpoch: "epoch", turnId: "turn", runId: "plan", parentRunId: null, attemptId: "plan" };
  const commands = ["first", "latest", "stale"].map(id => ({ type: "command.scheduled", command: {
    kind: "execute_tool", idempotencyKey: id, payload: {
      runtimeControlPlane: true, toolName: "submit_runtime_v2_work_plan", toolCallId: id,
      arguments: { planMarkdown: id },
    },
  } }));
  const events = commands.flatMap((command, index) => [command, {
    type: "tool.completed", run: index === 2 ? { ...run, attemptId: "stale" } : run,
    idempotencyKey: command.command.idempotencyKey, status: "failed", failureKind: "protocol_invalid",
    failureReasonCode: PLAN_SUBMISSION_VALIDATION_REJECTION_CODE,
    ...(index === 1 ? { modelContent: "WORK_PLAN_REJECTED: actual command reason" } : {
      presentation: { message: "WORK_PLAN_REJECTED: legacy message" },
    }),
  }]);
  const messages = [];
  restoreRuntimeV2PlanSubmissionRepairHistory({ aggregate: { events }, run, messages });
  assert.equal(messages[0].tool_calls[0].id, "latest");
  assert.equal(messages[1].content, "WORK_PLAN_REJECTED: actual command reason");
  restoreRuntimeV2PlanSubmissionRepairHistory({ aggregate: { events }, run, messages });
  assert.equal(messages.length, 2);
  const legacyMessages = [];
  restoreRuntimeV2PlanSubmissionRepairHistory({ aggregate: { events: events.slice(0, 2) }, run, messages: legacyMessages });
  assert.equal(legacyMessages[1].content, "WORK_PLAN_REJECTED: legacy message");
});

test("a valid submission retains the sealed review contract and canonical decision journal", () => {
  const result = assess(candidate(), { decisionJournal: "## Confirmed choices\nUse the existing collector scope.", createdAt: 123 });
  assert.equal(result.kind, "reviewable");
  assert.equal(result.sealedPlan.status, "pending_review");
  assert.equal(result.sealedPlan.createdAt, 123);
  assert.deepEqual(result.sealedPlan.draft.validations[0].criterionIds, criterionIds);
  assert.match(result.sealedPlan.markdown, /Confirmed choices/);
});

test("missing validations and structural errors remain draft diagnostics without weakening sealing", () => {
  const withoutChecks = candidate();
  withoutChecks.validations = [];
  const missing = assess(withoutChecks);
  assert.equal(missing.kind, "draft");
  assert.deepEqual(missing.diagnostics[0].criterionIds, criterionIds);
  assert.equal(missing.diagnostics[0].code, "plan_validation_missing");
  const structural = candidate();
  structural.changes[0].dependsOn = [9];
  structural.validations[0].stepIndexes = [1];
  const invalid = assess(structural);
  assert.equal(invalid.kind, "draft");
  assert.ok(invalid.diagnostics.some(item => item.fieldPath === "steps[0].dependsOn" && item.code === "plan_structure_invalid"));
  assert.match(invalid.diagnostics.find(item => item.fieldPath === "validations[0].stepIndexes").message, /zero-based indexes from 0 to 0/);
});

test("required collaboration and compiler failures remain typed non-reviewable results", () => {
  const collaboration = assess(candidate(), { collaborationRequired: true });
  assert.equal(collaboration.kind, "draft");
  assert.equal(collaboration.diagnostics[0].code, "plan_collaboration_incomplete");
  const submission = candidate();
  submission.changes = 42;
  const compilation = assess(submission);
  assert.equal(compilation.kind, "draft");
  assert.equal(compilation.diagnostics[0].code, "plan_submission_compile_invalid");
});

test("an advisory extra does not prevent required executable coverage from remaining reviewable", () => {
  const submission = candidate();
  submission.validations.push({ kind: "advisory", expectedOutcome: "User can inspect collector behavior." });
  const result = assess(submission);
  assert.equal(result.kind, "reviewable");
  assert.equal(result.sealedPlan.draft.validations[1].required, false);
});

test("a behavioral implementation cannot enter review on build and manual checks alone", () => {
  const submission = candidate();
  submission.validations = [
    { kind: "finite_command", command: "dotnet build", expectedOutcome: "Scripts compile." },
    { kind: "assertion", required: true, expectedOutcome: "Manually check movement and score." },
  ];
  const rejected = assess(submission, { requireBehavioralValidation: true });
  assert.equal(rejected.kind, "draft");
  assert.ok(rejected.diagnostics.some(item => item.code === "plan_validation_evidence_mismatch" && item.fieldPath === "validations[0]"));
  assert.equal(assess(submission, { requireBehavioralValidation: true, aggregate: {
    objective: { acceptanceEvidenceRequirements: ["static"] }, subagents: [], events: [],
  } }).kind, "reviewable", "an explicitly static criterion can use its build check");
  submission.validations.push({ kind: "finite_command", command: "unity test . --mode PlayMode --timeout 120",
    expectedOutcome: "The collector test proves movement, scoring and reset." });
  assert.equal(assess(submission, { requireBehavioralValidation: true }).kind, "reviewable");
});

test("reviewable Markdown cannot use compiler title fallback to bypass a missing required change", () => {
  const submission = candidate();
  delete submission.changes[0].change;
  const result = assess(submission);
  assert.equal(result.kind, "draft");
  assert.ok(result.diagnostics.some(item => item.code === "plan_structure_invalid" && item.fieldPath === "changes[0].change"));
});
