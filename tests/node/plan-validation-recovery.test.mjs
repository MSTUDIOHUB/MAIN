import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const { planValidationRecovery, PLAN_VALIDATION_REPAIR_FAILED } = load("src/store/runtimeV2/planValidationRecovery.ts");
const { PLAN_SUBMISSION_VALIDATION_REJECTION_CODE } = load("src/store/runtimeV2/planSubmissionRepair.ts");
const run = { sessionKey: "/fixture:1", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
const toolName = "submit_runtime_v2_work_plan";
const candidate = { planMarkdown: "# Breakout", changes: [{ targets: ["Assets/Paddle.cs"], change: "Add paddle controls" }],
  validations: [{ kind: "assertion", expectedOutcome: "The paddle moves." }] };
const diagnostic = { code: "plan_validation_not_required", fieldPath: "validations[0]",
  message: "Add a required behavioral check.", criterionIds: ["paddle"] };
const feedback = (diagnostics = [diagnostic], extra = {}) =>
  `WORK_PLAN_REJECTED: ${JSON.stringify({ code: "PLAN_EXECUTION_READINESS_INCOMPLETE", diagnostics, ...extra })}`;

function ledger() {
  const events = [];
  function append(type, value, owner = run) {
    const event = { type, run: owner, sequence: events.length, at: 1, ...value };
    events.push(event);
    return event.sequence;
  }
  function schedule(kind, idempotencyKey, payload, owner) {
    return append("command.scheduled", { command: { run: owner, kind, idempotencyKey, payload } }, owner);
  }
  function reject(id, args = candidate, modelContent = feedback(), owner = run, callId = id) {
    schedule("execute_tool", id, { toolName, runtimeControlPlane: true, toolCallId: callId, arguments: args }, owner);
    return append("tool.completed", { idempotencyKey: id, status: "failed", failureKind: "protocol_invalid",
      failureReasonCode: PLAN_SUBMISSION_VALIDATION_REJECTION_CODE, modelContent }, owner);
  }
  function beginRepair(idempotencyKey = "repair-request", owner = run) {
    return schedule("request_model", idempotencyKey, { planValidationOnlyRepair: true }, owner);
  }
  function response(toolCalls, idempotencyKey = "repair-request", owner = run) {
    return append("provider.responded", { idempotencyKey, result: { toolCalls } }, owner);
  }
  return { events, append, reject, beginRepair, response, current: (frontier = 0) => planValidationRecovery({ events }, run, frontier) };
}

test("validation recovery requires the latest exact duplicate on the current Run frontier", () => {
  const h = ledger();
  h.reject("first");
  assert.equal(h.current(), null);
  h.reject("stale-attempt", candidate, feedback(), { ...run, attemptId: "different" });
  assert.equal(h.current(), null);
  const latestFeedback = feedback([{ ...diagnostic, fieldPath: "validations[0].command" }]);
  h.reject("duplicate", { validations: candidate.validations, changes: candidate.changes, planMarkdown: candidate.planMarkdown }, latestFeedback);
  assert.deepEqual(h.current(), { kind: "repair", candidate, feedback: latestFeedback, rejectedCommands: [] });
  assert.equal(h.current(2), null, "a duplicate before the evidence frontier cannot drive repair");
  h.reject("new", { ...candidate, changes: [{ ...candidate.changes[0], change: "Use existing input" }] });
  assert.equal(h.current(), null, "matching Markdown alone is insufficient");
});

test("validation-only repair tracks exact rejected commands without treating supplemental checks as stale", () => {
  const h = ledger();
  const args = { ...candidate, validations: [
    { kind: "finite_command", command: " unity command editor.playmode start " },
    { kind: "finite_command", command: "unity command test run --mode playmode" },
    { kind: "finite_command", command: "dotnet build" },
  ] };
  const rejected = feedback([
    { ...diagnostic, fieldPath: "validations[0].command" },
    { ...diagnostic, fieldPath: "validations[1]", normalizationReason: "non_finite_command_downgraded_to_advisory" },
    { ...diagnostic, fieldPath: "validations[2].stepIndexes", code: "plan_structure_invalid" },
  ]);
  h.reject("first", args, rejected);
  h.reject("second", args, rejected);
  assert.deepEqual(h.current().rejectedCommands, ["unity command editor.playmode start", "unity command test run --mode playmode"]);
});

test("validation recovery leaves mixed, omitted, malformed and unknown diagnostics on the normal Plan path", () => {
  for (const rejected of [
    feedback([diagnostic, { ...diagnostic, fieldPath: "changes[0].targets", code: "plan_structure_invalid" }]),
    feedback([diagnostic], { omittedDiagnosticCount: 1 }),
    feedback().slice(0, -2),
    feedback([{ ...diagnostic, code: "unknown", fieldPath: "validations[0]" }]),
    feedback([{ ...diagnostic, message: "x".repeat(4_001) }]),
  ]) {
    const h = ledger();
    h.reject("first");
    h.reject("second", candidate, rejected);
    assert.equal(h.current(), null);
  }
});

test("validation recovery retries an interrupted request but exhausts real no-action or typed failures", () => {
  const h = ledger();
  h.reject("first");
  h.reject("second");
  h.beginRepair("interrupted");
  h.append("command.completed", { status: "failed", idempotencyKey: "interrupted" });
  assert.equal(h.current().kind, "repair");
  h.beginRepair("old-attempt", { ...run, attemptId: "stale" });
  h.response([], "old-attempt", { ...run, attemptId: "stale" });
  assert.equal(h.current().kind, "repair");
  h.beginRepair();
  h.response([]);
  assert.deepEqual(h.current(), { kind: "exhausted" });

  const failed = ledger();
  failed.reject("first");
  failed.reject("second");
  failed.beginRepair();
  failed.append("command.completed", { status: "failed", idempotencyKey: "repair-request",
    failureReasonCode: PLAN_VALIDATION_REPAIR_FAILED });
  assert.deepEqual(failed.current(), { kind: "exhausted" });
});

test("a validation repair candidate consumes the option only after exact typed rejection", () => {
  const h = ledger();
  h.reject("first");
  h.reject("second");
  h.beginRepair();
  const changed = { ...candidate, validations: [{ kind: "finite_command", command: "npm test", expectedOutcome: "Behavior checks pass." }] };
  h.response([{ id: "corrected", name: toolName, arguments: changed }]);
  assert.equal(h.current(), null, "allow normal pending candidate assessment");
  h.reject("other-rejection", candidate, feedback(), run, "corrected");
  assert.equal(h.current(), null, "a reused call ID is insufficient to link an unrelated candidate");
  h.reject("corrected-rejection", changed, feedback(), run, "corrected");
  assert.deepEqual(h.current(), { kind: "exhausted" });
});
