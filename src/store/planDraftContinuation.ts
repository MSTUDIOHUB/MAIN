import { readPlanDocument } from "../lib/ipc";
import { normalizePlanDraftRecord, type PlanDraftRecord } from "../lib/planDrafts";
import { samePlanDocumentRef, type PlanDocumentRef } from "../lib/planDocuments";
import { resolvePlanDraftFromAggregate } from "../lib/planDocumentRecords";
import { normalizeRuntimeV2Checkpoint } from "../lib/runtime-v2";
import { GLOBAL_CHAT_KEY, resolveSessionRuntimeKey, resolveSessionWorkspaceKey } from "../lib/sessionTypes";
import { sha256Hex } from "../lib/sha256";
import type { ConversationTurn } from "../lib/workflowModels";
import type { WorkspaceJsonObject } from "../lib/workspaceInstruction";

interface PlanDraftContinuationState {
  currentWorkspace: string | null | undefined;
  currentSessionId: number | null;
  currentTurnId?: string | null;
  sessionsByWorkspace: Record<string, readonly { id: number; planLifecycleEpoch?: string }[]>;
  conversationTurns: readonly ConversationTurn[];
  runtimeV2Checkpoints: Record<string, unknown>;
  isGenerating?: boolean;
  activeActionRequest?: { status?: string } | null;
  config?: { language?: string };
  sendMessage?: (text: string, images: undefined, options: {
    explicitIntent: "plan"; resolvedIntent: "plan"; skipIntentResolution: true; reuseCurrentTurn: false;
    sourcePlanDraft: PlanDraftRecord; turnTitle: string; intentSummary: string;
  }) => boolean;
  acceptWorkspaceInstruction: (input: {
    text: string; source: "plan_adjustment"; contextMentions: string[]; attachedFiles: [];
    dispatchHints: WorkspaceJsonObject;
  }) => Promise<{ accepted: boolean }>;
}

/** A button and dispatch hint are data. Only a same-owner canonical saved
 * receipt can identify the source of a new Plan Turn. */
export function resolvePlanDraftContinuationSource(state: PlanDraftContinuationState, value: unknown): {
  record: PlanDraftRecord; objective: string;
} | null {
  const record = normalizePlanDraftRecord(value);
  if (!record) return null;
  const workspaceKey = resolveSessionWorkspaceKey(state.currentWorkspace);
  const sessionKey = resolveSessionRuntimeKey(workspaceKey, state.currentSessionId);
  const epoch = String((state.sessionsByWorkspace[workspaceKey] || []).find(session => session.id === state.currentSessionId)?.planLifecycleEpoch || "").trim();
  const owner = record.documentRef.owner;
  if (resolveSessionWorkspaceKey(owner.workspace) !== workspaceKey || owner.sessionKey !== sessionKey || !epoch || owner.sessionEpoch !== epoch) return null;
  const checkpoint = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[owner.turnId], {
    workspaceKey, sessionKey: owner.sessionKey, sessionEpoch: epoch, turnId: owner.turnId,
  });
  if (checkpoint?.aggregate.strategy !== "plan" || checkpoint.aggregate.terminalOutcome?.resultKind !== "partial") return null;
  const canonical = resolvePlanDraftFromAggregate(checkpoint.aggregate);
  if (!canonical || JSON.stringify(canonical) !== JSON.stringify(record)) return null;
  const sourceTurn = state.conversationTurns.find(turn => turn.id === owner.turnId);
  if (!sourceTurn?.userPrompt.trim()) return null;
  return { record: canonical, objective: sourceTurn.userPrompt };
}

/** Read the exact revision before admission, then recheck the captured visible
 * owner. No draft, read receipt, or user click grants execution approval. */
export async function continuePlanDraft(input: {
  get: () => PlanDraftContinuationState;
  record: PlanDraftRecord;
  supplement?: string;
  readDocument?: (reference: PlanDocumentRef) => Promise<PlanDocumentRef & { markdown: string }>;
}): Promise<{ accepted: boolean }> {
  const initial = input.get();
  const source = resolvePlanDraftContinuationSource(initial, input.record);
  if (!source || initial.isGenerating || initial.activeActionRequest?.status === "pending") return { accepted: false };
  const visibleTurnId = initial.currentTurnId;
  try {
    const content = await (input.readDocument || readPlanDocument)(source.record.documentRef);
    if (!samePlanDocumentRef(content, source.record.documentRef) || sha256Hex(content.markdown) !== source.record.documentRef.contentHash) return { accepted: false };
  } catch { return { accepted: false }; }
  const current = input.get();
  const checked = resolvePlanDraftContinuationSource(current, source.record);
  if (!checked || current.currentTurnId !== visibleTurnId || current.isGenerating || current.activeActionRequest?.status === "pending") return { accepted: false };
  const zh = current.config?.language !== "en";
  const title = zh ? "补全计划验证" : "Complete plan validation";
  const summary = zh ? "保留原始目标与已确认选择，补全已保存草稿的验证方式。" : "Complete validation for the saved draft while retaining its objective and confirmed choices.";
  const supplement = input.supplement?.trim();
  const text = supplement
    ? `${checked.objective}\n\n${zh ? "本轮补充要求" : "Additional requirements for this turn"}\n${supplement}`
    : checked.objective;
  if (resolveSessionWorkspaceKey(current.currentWorkspace) === GLOBAL_CHAT_KEY) {
    return { accepted: current.sendMessage?.(text, undefined, {
      explicitIntent: "plan", resolvedIntent: "plan", skipIntentResolution: true, reuseCurrentTurn: false,
      sourcePlanDraft: checked.record, turnTitle: title, intentSummary: summary,
    }) === true };
  }
  return current.acceptWorkspaceInstruction({
    text, source: "plan_adjustment", contextMentions: [], attachedFiles: [],
    dispatchHints: {
      explicitIntent: "plan", resolvedIntent: "plan", skipIntentResolution: true,
      turnTitle: title, intentSummary: summary,
      sourcePlanDraft: JSON.parse(JSON.stringify(checked.record)) as WorkspaceJsonObject,
    },
  });
}
