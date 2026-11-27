import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const runtime = load("src/lib/runtime-v2/index.ts");
const { PlanLedger } = load("src/store/runtimeV2/planLedger.ts");
const turn = {
  workspaceKey: "/fixture",
  sessionKey: "/fixture:1",
  sessionEpoch: "epoch",
  clientSubmissionId: "submission",
  turnId: "turn-plan-headroom",
};
const run = {
  sessionKey: turn.sessionKey,
  sessionEpoch: turn.sessionEpoch,
  turnId: turn.turnId,
  runId: "plan-run",
  parentRunId: null,
  attemptId: "plan-attempt",
};

function fixture(eventCount) {
  const events = [
    { type: "turn.admitted", turn, strategy: "plan", objective: "Plan validation", constraints: [], acceptanceCriteria: [] },
    { type: "run.started", run, phase: "planning" },
  ];
  // This is a legitimate legacy history of ordinary live projections.
  for (let i = events.length; i < eventCount; i++) {
    const projection = { id: `old-${i}`, audience: "capsule_live", kind: "live_action", dedupeKey: `old-${i}`, markdown: "Planning." };
    events.push({ type: "projection.published", run, audience: projection.audience, projectionId: projection.id, projection });
  }
  const aggregate = runtime.replayRuntimeV2Events(events.map((event, sequence) => ({
    ...event,
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    eventId: `event-${sequence}`,
    sequence,
    at: sequence + 1,
  })));
  assert.ok(aggregate);
  let checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate, revision: eventCount, updatedAt: eventCount });
  const projected = [];
  const port = {
    async load() { return checkpoint; },
    async append(request) {
      const result = runtime.appendRuntimeV2Checkpoint({ ...request, checkpoint });
      if (result.checkpoint) checkpoint = result.checkpoint;
      return result;
    },
    async commitEmergencyTerminal() { assert.fail("This fixture has room for a canonical conclusion."); },
  };
  const ledger = new PlanLedger(turn, port, { async publish(input) { projected.push(input); } }, checkpoint);
  return { ledger, projected };
}

test("Plan live Capsule state follows committed receipts without expanding the checkpoint", async () => {
  const { ledger, projected } = fixture(2);
  const command = await ledger.schedule(run, "request_model", { mode: "plan" });
  await ledger.settleCommand({
    type: "provider.responded",
    run,
    idempotencyKey: command.idempotencyKey,
    result: { toolCalls: [], diagnostics: [] },
  });
  assert.deepEqual(ledger.snapshot().events.map(event => event.type), [
    "turn.admitted", "run.started", "command.scheduled", "provider.responded",
  ]);
  assert.deepEqual(projected.map(input => [input.audience, input.event.type]), [
    ["capsule_live", "command.scheduled"], ["capsule_live", "provider.responded"],
  ]);
});

test("Plan reserves canonical terminal receipts before scheduling another request", async () => {
  const { ledger, projected } = fixture(runtime.MAX_RUNTIME_V2_CHECKPOINT_EVENTS - 7);
  await assert.rejects(ledger.schedule(run, "request_model", { mode: "plan" }), error =>
    error.name === "PlanCheckpointTerminalReserveError" && error.reasonCode === "checkpoint_event_budget_exceeded");
  await ledger.finishTerminal({ run, resultKind: "error", reason: "The Plan event budget is exhausted." });
  const aggregate = ledger.snapshot();
  assert.equal(aggregate.terminalOutcome.resultKind, "error");
  assert.equal(aggregate.events.filter(event => event.type === "run.completed").length, 1);
  assert.equal(aggregate.events.filter(event => event.type === "turn.completed").length, 1);
  assert.equal(projected.filter(input => input.audience === "final").length, 1);
  assert.ok(aggregate.events.length <= runtime.MAX_RUNTIME_V2_CHECKPOINT_EVENTS);
});
