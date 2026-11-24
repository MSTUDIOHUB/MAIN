import { canonicalJson } from "./canonicalJson";
import type { TurnAggregateV1 } from "./runtime-v2/aggregate";
import { normalizePlanDocumentRef, samePlanDocumentRef, type PlanDocumentRef } from "./planDocuments";
import { resolveSessionWorkspaceKey } from "./sessionTypes";
import { sha256Hex } from "./sha256";
import { buildProjectRulesPreview, type ProjectInitInspection, type RulesDraftReview } from "./projectInit";
import { hashPlanDraftCandidate, normalizePlanDraftRecord, type PlanDraftRecord } from "./planDrafts";
import type { ConversationTurn } from "./workflowModels";

/** A session document is a display reference. Approval still uses the
 * separately validated runtime review request. */
export function resolveSessionPlanDocument(turns: readonly ConversationTurn[], owner: {
  sessionKey: string | null | undefined;
  sessionEpoch: string | null | undefined;
}): ConversationTurn | null {
  if (!owner.sessionKey || !owner.sessionEpoch) return null;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const ref = turn.uiVisibility !== "internal" && normalizePlanDocumentRef(turn.planDocument);
    if (ref && ref.kind === "plan" && ref.owner.turnId === turn.id &&
      ref.owner.sessionKey === owner.sessionKey && ref.owner.sessionEpoch === owner.sessionEpoch) return turn;
  }
  return null;
}

/** A draft must be bound both to its exact saved bytes and the normalized
 * provider invocation that produced them. UI copies cannot mint a draft. */
export function resolvePlanDraftFromAggregate(aggregate: TurnAggregateV1 | null | undefined): PlanDraftRecord | null {
  if (!aggregate) return null;
  for (const receipt of [...aggregate.events].reverse()) {
    if (receipt.type !== "tool.completed" || receipt.status !== "succeeded" || !receipt.modelContent) continue;
    try {
      const value = JSON.parse(receipt.modelContent);
      const record = normalizePlanDraftRecord(value.planDraft);
      if (!record || record.documentRef.kind !== "plan" || receipt.run.runId !== record.source.runId || !samePlanDocumentRef(record.documentRef, value.planDocument) ||
        record.documentRef.contentHash !== sha256Hex(value.markdown) ||
        record.documentRef.owner.sessionKey !== aggregate.turn.sessionKey || record.documentRef.owner.sessionEpoch !== aggregate.turn.sessionEpoch ||
        record.documentRef.owner.turnId !== aggregate.turn.turnId || resolveSessionWorkspaceKey(record.documentRef.owner.workspace) !== aggregate.turn.workspaceKey) continue;
      const command = aggregate.events.find(event => event.type === "command.scheduled" && event.command.idempotencyKey === receipt.idempotencyKey);
      if (command?.type !== "command.scheduled" || command.command.payload.toolName !== "submit_plan_document" || command.command.payload.runtimeOwnedPlanDocumentSave !== true ||
        canonicalJson(normalizePlanDraftRecord({ ...(command.command.payload.planDraftMetadata as object), documentRef: record.documentRef })) !== canonicalJson(record)) continue;
      const save = command.command.payload.planDocumentSaveInput as Record<string, unknown> | undefined;
      if (!save || save.markdown !== value.markdown || save.documentId !== record.documentRef.documentId || save.title !== record.documentRef.title ||
        save.kind !== record.documentRef.kind || canonicalJson(save.owner) !== canonicalJson(record.documentRef.owner) ||
        command.run.runId !== receipt.run.runId || command.sequence >= receipt.sequence) continue;
      const source = aggregate.events.find(event => event.type === "provider.responded" && event.sequence === record.source.providerSequence);
      if (source?.type !== "provider.responded" || source.run.runId !== record.source.runId || source.sequence >= command.sequence) continue;
      const call = source.result.toolCalls.find(item => item.id === record.source.toolCallId && item.name === "submit_runtime_v2_work_plan");
      if (!call || hashPlanDraftCandidate(call.arguments) !== record.source.candidateHash) continue;
      return record;
    } catch { /* Other tool receipts are not draft authority. */ }
  }
  return null;
}

/** Only a runtime-handled submit receipt can prove a saved document. Source
 * text containing similar JSON is never a document receipt. */
export function resolvePlanDocumentFromAggregate(aggregate: TurnAggregateV1 | null | undefined): { documentRef: PlanDocumentRef; markdown: string } | null {
  if (!aggregate) return null;
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index];
    if (event.type !== "tool.completed" || event.status !== "succeeded" || !event.modelContent) continue;
    if (!aggregate.events.some(command => command.type === "command.scheduled" && command.command.idempotencyKey === event.idempotencyKey && ["submit_plan_document", "save_plan_document"].includes(String(command.command.payload.toolName)))) continue;
    try {
      const value = JSON.parse(event.modelContent);
      const ref = normalizePlanDocumentRef(value.planDocument);
      if (typeof value.markdown !== "string" || !ref || resolveSessionWorkspaceKey(ref.owner.workspace) !== aggregate.turn.workspaceKey || ref.owner.sessionKey !== aggregate.turn.sessionKey || ref.owner.sessionEpoch !== aggregate.turn.sessionEpoch ||
        ref.owner.turnId !== aggregate.turn.turnId || ref.kind !== (aggregate.planPurpose === "rules" ? "rules_draft" : "plan") || !Number.isSafeInteger(ref.revision) || ref.revision < 1 ||
        !ref.documentId || !ref.path || ref.contentHash !== sha256Hex(value.markdown)) continue;
      return { documentRef: ref, markdown: value.markdown };
    } catch { /* Other receipts are not document records. */ }
  }
  return null;
}

export function resolveRulesDraftReviewFromAggregate(aggregate: TurnAggregateV1 | null | undefined): RulesDraftReview | null {
  const document = resolvePlanDocumentFromAggregate(aggregate);
  if (!aggregate || document?.documentRef.kind !== "rules_draft") return null;
  const source = aggregate.events.find(event => event.type === "observation.recorded" && event.evidence.id === "rules-source-snapshot");
  if (source?.type !== "observation.recorded" || !source.modelContent) return null;
  try {
    const inspection: ProjectInitInspection = JSON.parse(source.modelContent).rulesInspection;
    buildProjectRulesPreview(inspection, document.markdown);
    return { ...document, inspection };
  } catch { return null; }
}
