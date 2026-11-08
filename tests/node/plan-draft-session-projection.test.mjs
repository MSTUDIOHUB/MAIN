import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const native = { invoke: async () => null, isTauri: () => false, listen: async () => () => {}, open: async () => null, relaunch: async () => {}, exit: async () => {}, check: async () => null };
const load = createTsModuleLoader(Object.fromEntries(["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener", "@tauri-apps/plugin-process", "@tauri-apps/plugin-updater"].map(name => [name, native])));
const runtime = load("src/lib/runtime-v2/index.ts");
const { PlanLedger } = load("src/store/runtimeV2/planLedger.ts");
const records = load("src/lib/planDocumentRecords.ts");
const { hashPlanDraftCandidate } = load("src/lib/planDrafts.ts");
const { normalizeSessionRuntimeSnapshot } = load("src/store/useAppStore.ts");
const { buildWorkspaceInstructionConversationTurn } = load("src/store/workspaceInstructionProjection.ts");
const hash = text => createHash("sha256").update(text).digest("hex");

async function savedDraftFixture() {
  const owner = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch-1", clientSubmissionId: "source-submission", turnId: "source-turn" };
  const run = { sessionKey: owner.sessionKey, sessionEpoch: owner.sessionEpoch, turnId: owner.turnId, runId: "source-run", parentRunId: null, attemptId: "source-run" };
  let checkpoint = null;
  const port = { append: async input => { const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input }); assert.equal(result.disposition, "committed", result.reason); checkpoint = result.checkpoint; return result; } };
  const ledger = new PlanLedger(owner, port, { publish: async () => {} }, null);
  await ledger.append({ type: "turn.admitted", turn: owner, strategy: "plan", objective: "Create a collector", constraints: [], acceptanceCriteria: ["Collector works"], acceptanceCriterionIds: ["criterion-user-objective"] });
  await ledger.append({ type: "run.started", run, phase: "planning" });
  const candidate = { planMarkdown: "# Collector plan", changes: [{ targets: ["Assets/Collector.cs"], change: "Implement collector" }], validations: [{ kind: "advisory", expectedOutcome: "Inspect the game" }] };
  const call = { id: "submit-1", name: "submit_runtime_v2_work_plan", arguments: candidate };
  const request = await ledger.schedule(run, "request_model", {});
  await ledger.settleCommand({ type: "provider.responded", run, idempotencyKey: request.idempotencyKey, result: { visibleText: "", toolCalls: [call], diagnostics: [] } });
  const providerSequence = ledger.snapshot().events.find(event => event.type === "provider.responded").sequence;
  const submission = await ledger.schedule(run, "execute_tool", { toolName: call.name, toolCallId: call.id, arguments: candidate, runtimeControlPlane: true });
  await ledger.settleCommand({ type: "tool.completed", run, idempotencyKey: submission.idempotencyKey, status: "failed", evidence: [], failureKind: "protocol_invalid" });
  const markdown = "# Collector plan\n\nValidation needs completion.\n";
  const ref = { owner: { workspace: owner.workspaceKey, sessionKey: owner.sessionKey, sessionEpoch: owner.sessionEpoch, turnId: owner.turnId }, documentId: "source-plan", revision: 1, contentHash: hash(markdown), path: "/app-data/plan/source-plan.md", title: "Collector plan", kind: "plan" };
  const metadata = { schemaVersion: 1, source: { turnId: owner.turnId, runId: run.runId, providerSequence, toolCallId: call.id, candidateHash: hashPlanDraftCandidate(candidate) }, diagnostics: [{ code: "plan_validation_missing", fieldPath: "validations", criterionIds: ["criterion-user-objective"], message: "Complete validation" }] };
  const record = { ...metadata, documentRef: ref };
  const command = await ledger.schedule(run, "execute_tool", { toolName: "submit_plan_document", runtimeOwnedPlanDocumentSave: true, planDraftMetadata: metadata,
    planDocumentSaveInput: { owner: ref.owner, documentId: ref.documentId, expectedRevision: 0, title: ref.title, markdown, kind: ref.kind } });
  await ledger.settleCommand({ type: "tool.completed", run, idempotencyKey: command.idempotencyKey, status: "succeeded", evidence: [{ id: "saved-draft", kind: "tool", target: ref.path, version: ref.contentHash }], modelContent: JSON.stringify({ planDocument: ref, markdown, planDraft: record }) });
  await ledger.finishTerminal({ run, resultKind: "partial", reason: "Draft saved, validation missing", finalMarkdown: markdown });
  assert.deepEqual(records.resolvePlanDraftFromAggregate(ledger.snapshot()), record);
  return { owner, record, checkpoint, markdown };
}

test("cold Session restore derives draft readiness and source bindings after native JSON reorders keys", async () => {
  const f = await savedDraftFixture();
  const source = { id: f.owner.turnId, userPrompt: "Create a collector", title: "Collector", status: "done", mode: "plan", blockIds: [], createdAt: 1,
    planDraft: { forged: true }, planDocument: { ...f.record.documentRef, revision: 99 } };
  const next = { ...source, id: "next-turn", sourcePlanDraft: f.record };
  const raw = JSON.parse(JSON.stringify({ conversationTurns: [source, next],
    runtimeV2Checkpoints: runtime.serializeRuntimeV2CheckpointMap({ [f.owner.turnId]: f.checkpoint }) }, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value));
  const restored = normalizeSessionRuntimeSnapshot(raw, {
    workspacePath: "/fixture", expectedSessionKey: "/fixture:1", expectedSessionEpoch: "epoch-1", coldRestore: true,
  });
  assert.deepEqual(restored.conversationTurns[0].planDraft, f.record);
  assert.deepEqual(restored.conversationTurns[0].planDocument, f.record.documentRef);
  assert.deepEqual(restored.conversationTurns[1].sourcePlanDraft, f.record);
  assert.equal(restored.activeActionRequest, null);
  assert.equal(restored.isPlanApproved, false);
  const stale = normalizeSessionRuntimeSnapshot(raw, {
    workspacePath: "/fixture", expectedSessionKey: "/fixture:1", expectedSessionEpoch: "replacement-epoch", coldRestore: true,
  });
  assert.equal(stale.conversationTurns[0].planDraft, undefined);
  assert.equal(stale.conversationTurns[1].sourcePlanDraft, undefined);
});

test("workspace admission projects the exact source draft as data and refuses a foreign source owner", async () => {
  const f = await savedDraftFixture();
  const instruction = { schemaVersion: 1, kind: "workspace_instruction", clientSubmissionId: "next-submission", sessionKey: "/fixture:1", sessionEpoch: "epoch-1", source: "plan_adjustment", submittedAt: 1,
    payload: { text: "Create a collector", dispatchHints: { explicitIntent: "plan", sourcePlanDraft: f.record } } };
  const receipt = { schemaVersion: 1, kind: "workspace_turn_receipt", receiptId: "receipt-next", clientSubmissionId: "next-submission", sessionKey: "/fixture:1", sessionEpoch: "epoch-1", turnId: "next-turn", userBlockId: 2, acceptedAt: 2 };
  const projected = buildWorkspaceInstructionConversationTurn({ instruction, receipt, language: "en" });
  assert.deepEqual(projected.sourcePlanDraft, f.record);
  assert.equal(projected.intent, "plan"); assert.equal(projected.runtimeOutcome, undefined);
  const foreign = buildWorkspaceInstructionConversationTurn({ instruction: { ...instruction, sessionEpoch: "replacement-epoch" }, receipt: { ...receipt, sessionEpoch: "replacement-epoch" }, language: "en" });
  assert.equal(foreign.sourcePlanDraft, undefined);
});

test("the Plan panel finds the latest owned versioned document instead of a stale workspace draft", async () => {
  const { owner, record } = await savedDraftFixture();
  const first = { id: owner.turnId, planDocument: record.documentRef };
  const stale = { id: "stale", planDocument: { ...record.documentRef, owner: { ...record.documentRef.owner, turnId: "stale", sessionEpoch: "replaced" } } };
  const latest = { id: "latest", planDocument: { ...record.documentRef, owner: { ...record.documentRef.owner, turnId: "latest" } } };
  assert.equal(records.resolveSessionPlanDocument([first, latest, stale], owner), latest);
  assert.equal(records.resolveSessionPlanDocument([first, stale], owner), first);
  assert.equal(records.resolveSessionPlanDocument([stale], owner), null);
});
