import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

async function fixture({ omitAdmissionSource = false, purpose = "plan", includeWorkspaceEvidence = false } = {}) {
  const saves = [], reads = [], checkpoints = {};
  const stored = new Map();
  const load = createTsModuleLoader({ "../../lib/ipc": {
    savePlanDocument: async input => {
      saves.push(structuredClone(input));
      const ref = { owner: input.owner, documentId: input.documentId, revision: 1, contentHash: hash(input.markdown),
        path: `/fixture/.MAIN/plans/${input.documentId}/rev-1.md`, title: input.title, kind: input.kind };
      stored.set(input.documentId, { ...ref, markdown: input.markdown }); return ref;
    },
    readPlanDocument: async ref => { reads.push(structuredClone(ref)); return stored.get(ref.documentId); },
  } });
  const runtime = load("src/lib/runtime-v2/index.ts");
  const { PlanLedger } = load("src/store/runtimeV2/planLedger.ts");
  const owner = turnId => ({ workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch-1", clientSubmissionId: `${turnId}-submission`, turnId });
  const run = turn => ({ sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: `${turn.turnId}-run`, parentRunId: null, attemptId: `${turn.turnId}-run` });
  const createLedger = async (turn, sourcePlanDraft) => {
    const identity = run(turn);
    const port = { append: async input => {
      const result = runtime.appendRuntimeV2Checkpoint({ checkpoint: checkpoints[turn.turnId] || null, ...input });
      assert.equal(result.disposition, "committed", `${input.event.type}: ${result.reason}`); checkpoints[turn.turnId] = result.checkpoint; return result;
    } };
    const ledger = new PlanLedger(turn, port, { publish: async () => {} }, null);
    await ledger.append({ type: "turn.admitted", turn, strategy: "plan", ...(turn.turnId === "next-turn" && purpose ? { planPurpose: purpose } : {}),
      ...(sourcePlanDraft && !omitAdmissionSource ? { sourcePlanDraft } : {}), objective: "Create a collector while preserving offline play", constraints: [],
      acceptanceCriteria: ["Collector works"], acceptanceCriterionIds: ["criterion-user-objective"] });
    await ledger.append({ type: "run.started", run: identity, phase: "planning" });
    return { ledger, run: identity, port };
  };
  const sourceOwner = owner("source-turn");
  const source = await createLedger(sourceOwner);
  const questionnaire = load("src/lib/userQuestions.ts").normalizeUserQuestionnaire({ revision: 1, purpose: "plan_confirmation", title: "Collector scope", questions: [
    { id: "method", prompt: "Which scope should guide the collector?", selectionMode: "single", options: [{ id: "offline", label: "Preserve offline play" }, { id: "network", label: "Networked collector" }], required: true },
  ] });
  await source.ledger.append({ type: "run.paused", run: source.run, blocker: { requestId: "source-confirmation", reasonCode: "user_questionnaire", evidenceSequence: 1,
    message: "Confirm collector scope", options: ["recheck", "stop"], questionnaire } });
  await source.ledger.append({ type: "run.decision_recorded", run: source.run, requestId: "source-confirmation", choice: "recheck",
    answer: { requestId: "source-confirmation", revision: 1, answers: [{ questionId: "method", selectedValues: ["offline"] }] } });
  await source.ledger.append({ type: "run.resumed", run: source.run, requestId: "source-confirmation" });
  if (includeWorkspaceEvidence) {
    const inputs = [
      { id: "manifest", toolName: "read_file", target: "Packages/manifest.json", result: "Unity Test Framework 1.8.0" },
      { id: "scene", toolName: "read_file", target: "Assets/Scenes/CollectorTest.unity", result: "Existing CollectorTest scene" },
      { id: "skill", toolName: "load_skill", target: "external-workflow", result: "Do not replay loaded instructions" },
    ];
    for (const [index, { id, toolName, target, result }] of inputs.entries()) {
      const args = { path: target };
      const evidenceId = `E${index + 1}`;
      const readRequest = await source.ledger.schedule(source.run, "request_model", {});
      await source.ledger.settleCommand({ type: "provider.responded", run: source.run, idempotencyKey: readRequest.idempotencyKey,
        result: { visibleText: "Do not replay historical provider prose.", toolCalls: [{ id, name: toolName, arguments: args }], diagnostics: [] } });
      const read = await source.ledger.schedule(source.run, "execute_tool", { toolName, toolCallId: id, arguments: args });
      await source.ledger.settleCommand({ type: "tool.completed", run: source.run, idempotencyKey: read.idempotencyKey, status: "succeeded",
        modelContent: `[${evidenceId}] ${target}\n${result}`,
        evidence: [{ id: evidenceId, kind: toolName === "read_file" ? "source" : "tool", target, version: `sha256-${hash(result)}` }] });
    }
  }
  const candidate = { planMarkdown: "# Collector plan\n\nCreate a collector while preserving offline play.", changes: [{ operation: "create", targets: ["Assets/Collector.cs"], change: "Implement collector behavior." }],
    validations: [{ kind: "advisory", expectedOutcome: "Inspect behavior in the editor." }] };
  const call = { id: "source-submission", name: "submit_runtime_v2_work_plan", arguments: candidate };
  const request = await source.ledger.schedule(source.run, "request_model", {});
  await source.ledger.settleCommand({ type: "provider.responded", run: source.run, idempotencyKey: request.idempotencyKey, result: { visibleText: "", toolCalls: [call], diagnostics: [] } });
  const submission = await source.ledger.schedule(source.run, "execute_tool", { toolName: call.name, toolCallId: call.id, arguments: candidate, runtimeControlPlane: true });
  await source.ledger.settleCommand({ type: "tool.completed", run: source.run, idempotencyKey: submission.idempotencyKey, status: "failed", evidence: [] });
  const journal = load("src/lib/planDecisionJournal.ts").buildPlanDecisionJournal(source.ledger.snapshot());
  const sourceRunner = { context: { phaseLanguage: "en", runSessionKey: sourceOwner.sessionKey, harnessRunId: source.run.runId,
    turnId: sourceOwner.turnId, abortCtrl: new AbortController() }, get: () => ({}), set() {}, logStoreEvent() {} };
  await load("src/store/runtimeV2/planDraftRunner.ts").saveRuntimeV2PlanDraft({ runner: sourceRunner, ledger: source.ledger, run: source.run, call, candidate, decisionJournal: journal,
    diagnostics: [{ code: "plan_validation_missing", fieldPath: "validations", criterionIds: ["criterion-user-objective"], message: "Complete executable validation." }] });
  const record = load("src/lib/planDocumentRecords.ts").resolvePlanDraftFromAggregate(source.ledger.snapshot());
  assert.ok(record);
  const nextOwner = owner("next-turn");
  const next = await createLedger(nextOwner, record);
  const runner = { context: { sourcePlanDraft: record, runWorkspace: "/fixture", turnId: nextOwner.turnId, phaseLanguage: "en" }, get: () => ({ runtimeV2Checkpoints: checkpoints }) };
  const collect = () => load("src/store/runtimeV2/planDraftSource.ts").collectPlanDraftSource(runner, next.ledger, next.run);
  const prepareSeal = async () => {
    const decisionJournal = load("src/lib/planDecisionJournal.ts").buildPlanDecisionJournal(next.ledger.snapshot());
    const assessment = load("src/store/runtimeV2/planSubmissionAssessment.ts").assessPlanSubmission({ candidate: { ...candidate,
      validations: [{ kind: "finite_command", command: "npm test", expectedOutcome: "Collector assertions pass." }] }, evidence: [],
      objective: next.ledger.snapshot().objective.text, criterionIds: ["criterion-user-objective"], aggregate: next.ledger.snapshot(), decisionJournal });
    assert.equal(assessment.kind, "reviewable");
    const plan = assessment.sealedPlan;
    const documentRef = await load("src/store/runtimeV2/planReviewProjection.ts").writeReviewArtifact({ context: runner.context, ledger: next.ledger, run: next.run, plan });
    const adapter = load("src/store/runtimeV2/workPlanAdapter.ts");
    const commit = adapter.createRuntimeV2PlanReviewCommit({ plan, turn: nextOwner, run: next.run, requestId: "next-review", createdAt: Date.now(), documentRef });
    return { type: "work_plan.sealed", run: next.run, workPlan: adapter.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit: commit };
  };
  return { load, runtime, source, record, next, nextOwner, runner, reads, saves, stored, checkpoints, journal, collect, prepareSeal };
}

test("a precise draft-completion admission inherits the objective and choices, seals for review, and still requires approval", async () => {
  const f = await fixture();
  const context = JSON.parse(await f.collect()).sourcePlanDraftContext;
  assert.match(context.markdown, /Create a collector while preserving offline play/);
  assert.equal(context.confirmedChoices, f.journal);
  const seal = await f.prepareSeal();
  await f.next.ledger.append(seal);
  const aggregate = f.next.ledger.snapshot();
  assert.equal(aggregate.phase, "reviewing");
  assert.equal(aggregate.workPlan.status, "pending_review");
  assert.equal(aggregate.events.some(event => event.type === "work_plan.approved"), false);
  assert.equal(aggregate.events.some(event => event.type === "run.paused" && event.blocker.questionnaire), false);
  assert.equal(aggregate.sealedWorkPlan.decisionJournal, f.journal);
  assert.equal(aggregate.evidence.some(item => item.kind === "source"), false, "the prior plan cannot mint source-read coverage");
  const save = aggregate.events.find(event => event.type === "command.scheduled" && event.command.payload.runtimeOwnedPlanArtifact);
  const receipt = aggregate.events.find(event => event.type === "tool.completed" && event.idempotencyKey === save.command.idempotencyKey);
  assert.deepEqual(save.command.payload.derivedFrom, f.record.documentRef);
  assert.deepEqual(JSON.parse(receipt.modelContent).derivedFrom, f.record.documentRef);
  assert.equal(JSON.parse(receipt.modelContent).planDocument.owner.turnId, "next-turn");
  const persisted = f.runtime.serializeRuntimeV2CheckpointMap({ "next-turn": f.checkpoints["next-turn"] })["next-turn"];
  assert.ok(f.runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(persisted))));
});

test("a source binding without a verified observation cannot seal, even without an explicit plan purpose", async () => {
  for (const purpose of ["plan", null]) {
    const f = await fixture({ purpose });
    const seal = await f.prepareSeal();
    const state = f.next.ledger.snapshot();
    assert.equal(f.load("src/lib/runtime-v2/reducerGuards.ts").hasMatchingRuntimeV2SealedPlanAuthority({ state, event: seal }), false);
  }
});

test("a historical draft reuses only its versioned workspace reads, without granting current source authority", async () => {
  const f = await fixture({ includeWorkspaceEvidence: true });
  await f.collect();
  const { collectPlanDraftWorkspaceEvidence, restorePlanDraftWorkspaceEvidence } = f.load("src/store/runtimeV2/planDraftSource.ts");
  const source = f.source.ledger.snapshot();
  const reads = collectPlanDraftWorkspaceEvidence({ source, beforeSequence: f.record.source.providerSequence });
  assert.deepEqual(reads.map(read => read.arguments.path), ["Packages/manifest.json", "Assets/Scenes/CollectorTest.unity"]);

  const evidence = [];
  const evidenceContents = new Map();
  const oldManifest = { ...reads[0], evidence: { ...reads[0].evidence, id: "E0", version: "sha256-old-manifest" },
    modelContent: "[E0] Packages/manifest.json\nUnity Test Framework 1.4.0" };
  const laterSearch = { ...reads[0], toolName: "grep_search",
    evidence: { ...reads[0].evidence, id: "E4", version: "sha256-search-hits" }, modelContent: "[E4] Packages/manifest.json\nOnly search hits" };
  const context = restorePlanDraftWorkspaceEvidence({ reads: [oldManifest, ...reads, laterSearch],
    currentEvidence: [{ ...reads[1].evidence, id: "E1", version: "sha256-new-scene" }], evidence, evidenceContents });
  assert.match(context, /\[draft-E1\] Packages\/manifest.json\nUnity Test Framework 1.8.0/);
  assert.doesNotMatch(context, /CollectorTest\.unity|Unity Test Framework 1\.4\.0|Only search hits|Do not replay/);
  assert.deepEqual(evidence.map(({ id, version }) => ({ id, version })), [{ id: "draft-E1", version: reads[0].evidence.version }]);
  assert.equal(evidenceContents.get("draft-E1"), "Unity Test Framework 1.8.0");
  assert.equal(f.next.ledger.snapshot().evidence.some(item => item.kind === "source"), false);
  assert.deepEqual(f.reads, [f.record.documentRef], "the only storage read is exact verification of the saved draft revision");
});

test("source admission rejects foreign owners, current-Turn documents and rules drafting", async () => {
  const f = await fixture();
  const admitted = f.next.ledger.snapshot().events[0];
  for (const sourcePlanDraft of [
    { ...f.record, documentRef: { ...f.record.documentRef, owner: { ...f.record.documentRef.owner, sessionEpoch: "foreign" } } },
    { ...f.record, documentRef: { ...f.record.documentRef, owner: { ...f.record.documentRef.owner, turnId: "next-turn" } }, source: { ...f.record.source, turnId: "next-turn" } },
  ]) assert.equal(f.runtime.tryTransition(null, { ...admitted, sourcePlanDraft }).disposition, "rejected");
  assert.equal(f.runtime.tryTransition(null, { ...admitted, planPurpose: "rules" }).disposition, "rejected");
});

test("source proof, document content, and the typed observation must all match the frozen admission", async () => {
  const f = await fixture();
  const original = f.stored.get(f.record.documentRef.documentId);
  f.stored.set(f.record.documentRef.documentId, { ...original, markdown: "forged saved content" });
  await assert.rejects(f.collect(), /PLAN_DRAFT_SOURCE_CONTENT_MISMATCH/);
  f.stored.set(f.record.documentRef.documentId, original);
  await f.collect();
  const observation = f.next.ledger.snapshot().events.find(event => event.type === "observation.recorded" && event.evidence.id === "plan-draft-source");
  const before = f.runtime.replayRuntimeV2Events(f.next.ledger.snapshot().events.filter(event => event.sequence < observation.sequence));
  assert.equal(f.runtime.tryTransition(before, { ...observation, sourcePlanDraft: undefined }).disposition, "rejected");
  assert.equal(f.runtime.tryTransition(before, { ...observation, evidence: { ...observation.evidence, version: "stale" } }).disposition, "rejected");
  const forgedJournal = JSON.parse(observation.modelContent);
  forgedJournal.sourcePlanDraftContext.confirmedChoices = "Invented user decision";
  assert.equal(f.runtime.tryTransition(before, { ...observation, modelContent: JSON.stringify(forgedJournal) }).disposition, "rejected");
});

test("canonical draft completion survives missing UI context while keeping saved-document lineage", async () => {
  const f = await fixture();
  f.runner.context.sourcePlanDraft = undefined;
  const context = JSON.parse(await f.collect()).sourcePlanDraftContext;
  assert.equal(context.confirmedChoices, f.journal);
  await f.next.ledger.append(await f.prepareSeal());
  const saved = f.next.ledger.snapshot().events.find(event => event.type === "command.scheduled" && event.command.payload.runtimeOwnedPlanArtifact);
  assert.deepEqual(saved.command.payload.derivedFrom, f.record.documentRef);
  assert.equal(f.next.ledger.snapshot().workPlan.status, "pending_review");
});

test("a selected draft without its canonical saved partial receipt cannot become source authority", async () => {
  const f = await fixture();
  delete f.checkpoints["source-turn"];
  await assert.rejects(f.collect(), /PLAN_DRAFT_SOURCE_RECEIPT_MISMATCH/);
  assert.equal(f.reads.length, 0, "a UI-selected reference alone cannot authorize reading or inheritance");
  assert.equal(f.next.ledger.snapshot().events.some(event => event.type === "observation.recorded" && event.sourcePlanDraft), false);
});

test("a derived review cannot seal against a missing or unrelated saved-artifact lineage", async () => {
  const f = await fixture(); await f.collect();
  const seal = await f.prepareSeal();
  const saved = structuredClone(f.next.ledger.snapshot());
  const command = saved.events.find(event => event.type === "command.scheduled" && event.command.payload.runtimeOwnedPlanArtifact);
  const receipt = saved.events.find(event => event.type === "tool.completed" && event.idempotencyKey === command.command.idempotencyKey);
  const guard = f.load("src/lib/runtime-v2/reducerGuards.ts").hasMatchingRuntimeV2SealedPlanAuthority;
  assert.equal(guard({ state: saved, event: seal }), true);
  const record = JSON.parse(receipt.modelContent);
  delete record.derivedFrom; receipt.modelContent = JSON.stringify(record);
  assert.equal(guard({ state: saved, event: seal }), false);
});
