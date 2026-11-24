import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

async function harness() {
  let checkpoint = null;
  let nativeFault = null;
  let appendFault = null;
  let projectionFault = false;
  const saves = [], documents = new Map(), projections = [];
  const load = createTsModuleLoader({
    "../../lib/ipc": { savePlanDocument: async input => {
      saves.push(structuredClone(input));
      if (nativeFault === "before-save") { nativeFault = null; throw new Error("disk unavailable"); }
      let stored = documents.get(input.documentId);
      if (stored) assert.deepEqual(input, stored.input, "recovery must retry the same immutable save input");
      else {
        const reference = { owner: input.owner, documentId: input.documentId, revision: 1, contentHash: hash(input.markdown),
          path: `/fixture/.MAIN/plans/${input.documentId}/rev-1.md`, title: input.title, kind: input.kind };
        stored = { input: structuredClone(input), reference }; documents.set(input.documentId, stored);
      }
      if (nativeFault === "lost-ack") { nativeFault = null; throw new Error("save acknowledgement lost"); }
      return stored.reference;
    } },
    "./executionBlocker": { projectRuntimeV2ExecutionBlocker() {} },
  });
  const runtime = load("src/lib/runtime-v2/index.ts");
  const { PlanLedger } = load("src/store/runtimeV2/planLedger.ts");
  const drafts = load("src/store/runtimeV2/planDraftRunner.ts");
  const records = load("src/lib/planDocumentRecords.ts");
  const owner = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "draft-epoch", clientSubmissionId: "submission-draft", turnId: "draft-turn" };
  const run = { sessionKey: owner.sessionKey, sessionEpoch: owner.sessionEpoch, turnId: owner.turnId, runId: "draft-run", parentRunId: null, attemptId: "draft-run" };
  const port = { append: async input => {
    if (appendFault?.(input.event)) { appendFault = null; throw new Error("simulated checkpoint interruption"); }
    const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input });
    assert.equal(result.disposition, "committed", result.reason);
    checkpoint = result.checkpoint;
    return result;
  } };
  const projection = { publish: async input => {
    projections.push(input);
    if (projectionFault && input.audience === "final") throw new Error("viewer unavailable");
  } };
  let state = { currentTurnId: owner.turnId, harnessRunMarker: { runId: run.runId, sessionKey: run.sessionKey },
    planLifecycle: { sessionEpoch: run.sessionEpoch }, conversationTurns: [{ id: owner.turnId }], activeActionRequest: null };
  const runner = { context: { phaseLanguage: "en", abortCtrl: new AbortController(), runSessionKey: owner.sessionKey, turnId: owner.turnId, harnessRunId: run.runId },
    get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; }, logStoreEvent() {} };
  let ledger = new PlanLedger(owner, port, projection, null);
  await ledger.append({ type: "turn.admitted", turn: owner, strategy: "plan", objective: "Create a collector", constraints: [],
    acceptanceCriteria: ["Collector behavior works"], acceptanceCriterionIds: ["criterion-user-objective"] });
  await ledger.append({ type: "run.started", run, phase: "planning" });
  const candidate = { planMarkdown: "# Collector plan\n\nCreate the collector and manually inspect its gameplay behavior.",
    changes: [{ operation: "create", targets: ["Assets/Collector.cs"], change: "Implement collector behavior." }],
    validations: [{ kind: "advisory", required: true, expectedOutcome: "Inspect collector behavior in the editor." }] };
  const call = { id: "collector-plan-submission", name: "submit_runtime_v2_work_plan", arguments: candidate };
  const request = await ledger.schedule(run, "request_model", {});
  await ledger.settleCommand({ type: "provider.responded", run, idempotencyKey: request.idempotencyKey,
    result: { visibleText: "", toolCalls: [call], diagnostics: [] } });
  const submission = await ledger.schedule(run, "execute_tool", { toolName: call.name, toolCallId: call.id, arguments: call.arguments, runtimeControlPlane: true });
  await ledger.settleCommand({ type: "tool.completed", run, idempotencyKey: submission.idempotencyKey, status: "failed", evidence: [], failureKind: "protocol_invalid" });
  const diagnostics = load("src/store/runtimeV2/planSubmissionAssessment.ts").assessPlanSubmission({ candidate, evidence: [], objective: "Create a collector",
    criterionIds: ["criterion-user-objective"], aggregate: ledger.snapshot() }).diagnostics;
  const cold = (nativeKeyOrder = false) => {
    const raw = runtime.serializeRuntimeV2CheckpointMap({ [owner.turnId]: checkpoint })[owner.turnId];
    const json = nativeKeyOrder ? JSON.stringify(raw, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value) : JSON.stringify(raw);
    let rejection;
    checkpoint = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(json), undefined, value => { rejection = value; });
    assert.ok(checkpoint, `the sole persisted ledger must survive a cold restart: ${JSON.stringify(rejection)}`);
    ledger = new PlanLedger(owner, port, projection, checkpoint);
  };
  return { run, owner, runner, saves, documents, projections, runtime, records,
    checkpoint: () => checkpoint, state: () => state,
    setNativeFault(value) { nativeFault = value; }, setAppendFault(value) { appendFault = value; }, setProjectionFault(value) { projectionFault = value; },
    cold,
    save: () => drafts.saveRuntimeV2PlanDraft({ runner, ledger, run, call, candidate, diagnostics }),
    recover: () => drafts.recoverRuntimeV2PlanDraft(runner, ledger, run),
    async retry() { const blocker = ledger.snapshot().run.blocker; await ledger.append({ type: "run.decision_recorded", run, requestId: blocker.requestId, choice: "recheck" }); },
    cutBefore(predicate) { const events = checkpoint.aggregate.events; const index = events.findIndex(predicate); assert.ok(index >= 0);
      const aggregate = runtime.replayRuntimeV2Events(events.slice(0, index));
      checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt }); cold(); },
    finish: (resultKind, reason) => ledger.finishTerminal({ run, resultKind, reason, finalMarkdown: reason }),
    finishWithoutMarkdown: (resultKind, reason) => ledger.finishTerminal({ run, resultKind, reason }),
  };
}

function assertUniquePartial(h) {
  const aggregate = h.checkpoint().aggregate;
  assert.equal(aggregate.terminalOutcome.resultKind, "partial");
  assert.equal(aggregate.events.filter(event => event.type === "run.completed").length, 1);
  assert.equal(aggregate.events.filter(event => event.type === "turn.completed").length, 1);
  assert.equal(aggregate.events.filter(event => event.type === "projection.published" && event.audience === "final").length, 1);
  assert.equal(aggregate.sealedWorkPlan, null);
  assert.equal(aggregate.workPlan, null);
  assert.equal(h.state().activeActionRequest, null);
  assert.equal(h.records.resolvePlanDraftFromAggregate(aggregate).documentRef.contentHash, hash(h.saves[0].markdown));
}

test("a saved draft closes as one partial result and never grants execution authority", async () => {
  const h = await harness();
  assert.equal((await h.save()).outcome.resultKind, "partial");
  assertUniquePartial(h);
  h.cold();
  assert.equal((await h.recover()).outcome.resultKind, "partial");
  assert.equal(h.saves.length, 1);
  assertUniquePartial(h);
});

test("draft receipt proof survives native JSON sorting every nested object key", async () => {
  const h = await harness();
  await h.save();
  const live = h.records.resolvePlanDraftFromAggregate(h.checkpoint().aggregate);
  assert.ok(live);
  h.cold(true);
  const restored = h.records.resolvePlanDraftFromAggregate(h.checkpoint().aggregate);
  assert.deepEqual(restored, live, "native JSON must retain the exact candidate and owner proof");
  assert.equal(JSON.stringify(restored), JSON.stringify(live), "normalized UI source equality must survive native key order");
  assert.equal((await h.recover()).outcome.resultKind, "partial");
  assert.equal(h.saves.length, 1);
  assertUniquePartial(h);
});

for (const fault of ["before-save", "lost-ack"]) test(`draft ${fault} pauses and retries the exact saved input without regeneration`, async () => {
  const h = await harness();
  h.setNativeFault(fault);
  assert.equal((await h.save()).outcome.status, "paused");
  assert.equal(h.checkpoint().aggregate.run.blocker.reasonCode, "document_save_failed");
  assert.equal(h.checkpoint().aggregate.terminalOutcome, null);
  h.cold();
  await h.retry();
  assert.equal((await h.recover()).outcome.resultKind, "partial");
  assert.equal(h.saves.length, 2);
  assert.deepEqual(h.saves[1], h.saves[0]);
  assert.equal(h.documents.size, 1);
  assertUniquePartial(h);
});

test("lost draft receipt replays its pending native save with the same content and identity", async () => {
  const h = await harness();
  h.setAppendFault(event => event.type === "tool.completed" && !!event.modelContent?.includes('"planDraft"'));
  await assert.rejects(h.save(), /simulated checkpoint interruption/);
  assert.equal(h.documents.size, 1);
  assert.equal(h.records.resolvePlanDraftFromAggregate(h.checkpoint().aggregate), null);
  h.cold();
  assert.equal((await h.recover()).outcome.resultKind, "partial");
  assert.equal(h.saves.length, 2);
  assertUniquePartial(h);
});

test("saved draft survives a lost run conclusion or final publication without another save", async () => {
  for (const failure of ["run.completed", "projection.published", "turn.completed"]) {
    const h = await harness();
    h.setAppendFault(event => event.type === failure && (failure !== "projection.published" || event.audience === "final"));
    await assert.rejects(h.save(), /simulated checkpoint interruption/);
    h.cold();
    assert.equal((await h.recover()).outcome.resultKind, "partial");
    assert.equal(h.saves.length, 1);
    assertUniquePartial(h);
  }
});

test("lost UI publication reuses the durable final projection and keeps one canonical conclusion", async () => {
  const h = await harness(); h.setProjectionFault(true);
  await h.save();
  h.cold(); h.setProjectionFault(false);
  await h.recover();
  assert.equal(h.saves.length, 1);
  const finals = h.projections.filter(input => input.audience === "final");
  assert.equal(finals.length, 2);
  assert.equal(finals[0].projection.id, finals[1].projection.id);
  assertUniquePartial(h);
});

test("draft proof rejects tampered owners, source candidates, metadata and ordinary tool results", async () => {
  const h = await harness(); await h.save();
  const original = h.checkpoint().aggregate;
  assert.ok(h.records.resolvePlanDraftFromAggregate(original));
  for (const tamper of [
    aggregate => { const receipt = aggregate.events.find(event => event.type === "tool.completed" && event.modelContent?.includes('"planDraft"')); const data = JSON.parse(receipt.modelContent); data.planDraft.documentRef.owner.sessionEpoch = "foreign"; receipt.modelContent = JSON.stringify(data); },
    aggregate => { const source = aggregate.events.find(event => event.type === "provider.responded"); source.result.toolCalls[0].arguments.planMarkdown = "Forged source"; },
    aggregate => { const command = aggregate.events.find(event => event.type === "command.scheduled" && event.command.payload.planDraftMetadata); command.command.payload.runtimeOwnedPlanDocumentSave = false; },
    aggregate => { const command = aggregate.events.find(event => event.type === "command.scheduled" && event.command.payload.planDraftMetadata); command.command.payload.planDraftMetadata.diagnostics[0].code = "forged-readiness"; },
    aggregate => { const receipt = aggregate.events.find(event => event.type === "tool.completed" && event.modelContent?.includes('"planDraft"')); const data = JSON.parse(receipt.modelContent); data.markdown += "\nForged body"; receipt.modelContent = JSON.stringify(data); },
  ]) { const copy = structuredClone(original); tamper(copy); assert.equal(h.records.resolvePlanDraftFromAggregate(copy), null); }
});

test("an existing canonical error conclusion remains authoritative during draft recovery", async () => {
  const h = await harness(); await h.save();
  h.cutBefore(event => event.type === "command.scheduled" && event.command.kind === "finalize_turn");
  await h.finish("error", "An independent runtime boundary failed.");
  h.cold();
  const recovered = await h.recover();
  assert.equal(recovered.outcome.resultKind, "error");
  assert.equal(recovered.outcome.reason, "An independent runtime boundary failed.");
  assert.equal(h.checkpoint().aggregate.events.filter(event => event.type === "run.completed").length, 1);
});

test("a terminal intent without optional Markdown retains its digest across real JSON persistence", async () => {
  const h = await harness(); await h.save();
  h.cutBefore(event => event.type === "command.scheduled" && event.command.kind === "finalize_turn");
  await h.finishWithoutMarkdown("error", "An independent runtime boundary failed.");
  h.cold();
  const command = h.checkpoint().aggregate.events.find(event => event.type === "command.scheduled" && event.command.kind === "finalize_turn");
  assert.equal(Object.hasOwn(command.command.payload, "finalMarkdown"), false);
  assert.equal(h.checkpoint().aggregate.terminalOutcome.resultKind, "error");
  assert.equal((await h.recover()).outcome.resultKind, "error");
});
