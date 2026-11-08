import { savePlanDocument } from "../../lib/ipc";
import { beginCapsuleToolActivity } from "../../lib/capsuleLiveActivity";
import { normalizePlanDocumentRef, type PlanDocumentRef, type SavePlanDocumentInput } from "../../lib/planDocuments";
import { GLOBAL_CHAT_KEY } from "../../lib/sessionTypes";
import { sha256Hex } from "../../lib/sha256";
import { pausedAgentLoopOutcome } from "../../lib/runOutcome";
import type { RuntimeV2Command, RuntimeV2NormalizedToolCall, RuntimeV2RunIdentity, TurnAggregateV1 } from "../../lib/runtime-v2";
import { projectRuntimeV2ExecutionBlocker } from "./executionBlocker";
import { createRuntimeV2RunnerSettlement } from "./executionRunnerIdentity";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import type { PlanLedger } from "./planLedger";
import { normalizePlanDraftRecord, type PlanDraftSaveMetadata } from "../../lib/planDrafts";

export const PLAN_DOCUMENT_SAVE_FAILED = "plan_document_save_failed";
export const DOCUMENT_SAVE_BLOCKER = "document_save_failed";

export function planDocumentSaveInput(aggregate: TurnAggregateV1, title: string, markdown: string): SavePlanDocumentInput {
  const turn = aggregate.turn;
  return { owner: { workspace: turn.workspaceKey === GLOBAL_CHAT_KEY ? null : turn.workspaceKey, sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId },
    documentId: `plan-${sha256Hex(`${turn.sessionKey}:${turn.sessionEpoch}:${turn.turnId}`).slice(0, 24)}`, expectedRevision: 0,
    title, markdown, kind: aggregate.planPurpose === "rules" ? "rules_draft" : "plan" };
}

function savedInput(command: RuntimeV2Command, aggregate: TurnAggregateV1): SavePlanDocumentInput | null {
  const value = command.payload.planDocumentSaveInput as SavePlanDocumentInput | undefined;
  if (command.kind !== "execute_tool" || command.payload.toolName !== "submit_plan_document" || command.payload.runtimeOwnedPlanDocumentSave !== true || !value ||
    typeof value.title !== "string" || !value.title.trim() || typeof value.markdown !== "string" || !value.markdown.trim()) return null;
  const expected = planDocumentSaveInput(aggregate, value.title, value.markdown);
  return value.expectedRevision === 0 && value.documentId === expected.documentId && value.kind === expected.kind &&
    value.owner?.sessionKey === expected.owner.sessionKey && value.owner.sessionEpoch === expected.owner.sessionEpoch && value.owner.turnId === expected.owner.turnId &&
    value.owner.workspace === expected.owner.workspace ? expected : null;
}

export function resolvePlanDocumentSaveRecovery(aggregate: TurnAggregateV1): {
  command: RuntimeV2Command; saveInput: SavePlanDocumentInput; pending: boolean; error?: string;
} | null {
  for (const event of [...aggregate.events].reverse()) {
    if (event.type !== "command.scheduled") continue;
    const saveInput = savedInput(event.command, aggregate);
    if (!saveInput) {
      if (event.command.payload.runtimeOwnedPlanDocumentSave === true) throw new Error("PLAN_DOCUMENT_SAVE_INPUT_INVALID");
      continue;
    }
    const receipt = aggregate.events.find(candidate => candidate.type === "tool.completed" && candidate.idempotencyKey === event.command.idempotencyKey);
    if (!receipt && aggregate.scheduledCommands.some(command => command.idempotencyKey === event.command.idempotencyKey)) return { command: event.command, saveInput, pending: true };
    if (receipt?.type === "tool.completed" && receipt.status === "failed" && receipt.failureReasonCode === PLAN_DOCUMENT_SAVE_FAILED) {
      let error = "Document storage did not acknowledge the save.";
      try { error = JSON.parse(receipt.modelContent || "").documentSaveFailure.error || error; } catch { /* The machine code, not prose, owns this boundary. */ }
      return { command: event.command, saveInput, pending: false, error };
    }
    return null;
  }
  return null;
}

export async function schedulePlanDocumentSave(input: {
  ledger: PlanLedger; run: RuntimeV2RunIdentity; saveInput: SavePlanDocumentInput; call?: RuntimeV2NormalizedToolCall; retryOf?: string;
  draftMetadata?: PlanDraftSaveMetadata;
}): Promise<RuntimeV2Command> {
  const old = input.call && input.ledger.snapshot()!.scheduledCommands.find(command => command.kind === "execute_tool" && command.payload.toolCallId === input.call!.id && command.payload.toolName === "submit_plan_document");
  if (old && savedInput(old, input.ledger.snapshot()!)) return old;
  if (old) await input.ledger.settleCommand({ type: "command.completed", run: input.run, idempotencyKey: old.idempotencyKey, status: "failed" });
  return input.ledger.schedule(input.run, "execute_tool", {
    toolName: "submit_plan_document", runtimeOwnedPlanDocumentSave: true, planDocumentSaveInput: input.saveInput,
    ...(input.draftMetadata ? { planDraftMetadata: input.draftMetadata } : {}),
    ...(input.call ? { toolCallId: input.call.id, arguments: input.call.arguments } : {}),
    ...(input.retryOf ? { runtimeDocumentRetryOf: input.retryOf } : {}),
  });
}

export async function writePlanDocumentOrPause(input: {
  runner: RuntimeV2PlanRunnerInput; ledger: PlanLedger; run: RuntimeV2RunIdentity; command: RuntimeV2Command; saveInput: SavePlanDocumentInput;
}) {
  const expected = input.saveInput;
  const metadata = input.command.payload.planDraftMetadata as PlanDraftSaveMetadata | undefined;
  if (metadata && !normalizePlanDraftRecord({ ...metadata, documentRef: { ...expected, revision: expected.expectedRevision + 1,
    contentHash: sha256Hex(expected.markdown), path: "pending-document-save" } })) throw new Error("PLAN_DRAFT_SAVE_METADATA_INVALID");
  let documentRef: PlanDocumentRef;
  const finishActivity = beginCapsuleToolActivity({
    run: input.run,
    commandKey: input.command.idempotencyKey,
    signal: input.runner.context.abortCtrl.signal,
    toolName: "submit_plan_document",
    target: "",
  });
  try {
    const received = normalizePlanDocumentRef(await savePlanDocument(expected).finally(finishActivity));
    if (!received || received.documentId !== expected.documentId || received.revision !== expected.expectedRevision + 1 || received.kind !== expected.kind || received.title !== expected.title || received.contentHash !== sha256Hex(expected.markdown) ||
      received.owner.workspace !== expected.owner.workspace || received.owner.sessionKey !== expected.owner.sessionKey || received.owner.sessionEpoch !== expected.owner.sessionEpoch || received.owner.turnId !== expected.owner.turnId) throw new Error("PLAN_DOCUMENT_SAVE_RECEIPT_MISMATCH");
    documentRef = received;
  } catch (error) {
    finishActivity();
    // Only the actual native save/acknowledgment is an I/O blocker. Checkpoint
    // append errors retain their existing persistence boundary and recovery.
    await input.ledger.settleCommand({ type: "tool.completed", run: input.run, idempotencyKey: input.command.idempotencyKey, status: "failed", evidence: [],
      failureKind: "execution_failed", failureReasonCode: PLAN_DOCUMENT_SAVE_FAILED, modelContent: JSON.stringify({ documentSaveFailure: { error: String(error) } }) });
    return { settlement: await pausePlanDocumentSave(input.runner, input.ledger, input.run, input.command, String(error)) };
  }
  await input.ledger.settleCommand({ type: "tool.completed", run: input.run, idempotencyKey: input.command.idempotencyKey, status: "succeeded", receiptOrigin: "executed",
    evidence: [{ id: `plan-document:${documentRef.documentId}:${documentRef.revision}`, kind: "tool", target: documentRef.path, version: documentRef.contentHash }],
    modelContent: JSON.stringify({ planDocument: documentRef, markdown: expected.markdown,
      ...(metadata ? { planDraft: { ...metadata, documentRef } } : {}) }) });
  return { documentRef, markdown: expected.markdown };
}

export async function pausePlanDocumentSave(runner: RuntimeV2PlanRunnerInput, ledger: PlanLedger, run: RuntimeV2RunIdentity, command: RuntimeV2Command, error: string) {
  const zh = runner.context.phaseLanguage === "zh";
  const message = zh ? `计划文档保存失败，完整正文已保留。处理存储错误后，可重新保存同一份文档。\n${error}`
    : `The plan document could not be saved. Its complete body is retained. Resolve the storage error, then retry saving the same document.\n${error}`;
  await ledger.append({ type: "run.paused", run, blocker: { requestId: ledger.nextId(`document-save-${ledger.snapshot()!.nextSequence}`), reasonCode: DOCUMENT_SAVE_BLOCKER,
    actionIdentity: command.idempotencyKey, evidenceSequence: ledger.snapshot()!.nextSequence - 1, message, options: ["recheck", "stop"] } });
  projectRuntimeV2ExecutionBlocker({ aggregate: ledger.snapshot()!, get: runner.get, set: runner.set, language: runner.context.phaseLanguage });
  return createRuntimeV2RunnerSettlement(runner.context, pausedAgentLoopOutcome(DOCUMENT_SAVE_BLOCKER, "action_required"));
}
