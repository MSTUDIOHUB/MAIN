import { resolveSessionRuntimeKey } from "../../lib/sessionTypes";
import type { ConversationTurn } from "../../lib/workflowModels";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

type SessionContext = Pick<RuntimeV2SubmissionContext,
  "runSessionKey" | "runSessionId" | "runScopeKey" | "runSessionEpoch">;

/** Resolve the accepted Session owner once; a Turn never creates its epoch. */
export function resolveRuntimeV2SessionEpoch(
  state: any,
  context: SessionContext,
  turn: Pick<ConversationTurn, "id" | "clientSubmissionId" | "workspaceInstructionReceiptId">,
): string {
  const frozenEpoch = String(context.runSessionEpoch || "").trim();
  if (frozenEpoch) return frozenEpoch;
  const session = state?.sessionsByWorkspace?.[context.runScopeKey]?.find(
    (candidate: any) => candidate.id === context.runSessionId,
  );
  if (session && resolveSessionRuntimeKey(context.runScopeKey, session.id) !== context.runSessionKey) {
    throw new Error("RUNTIME_V2_SESSION_OWNER_MISMATCH");
  }
  const canonicalEpoch = String(session?.planLifecycleEpoch || "").trim();
  const matchesTurn = (receipt: any) =>
    receipt?.sessionKey === context.runSessionKey && receipt.turnId === turn.id &&
    (!turn.clientSubmissionId || receipt.clientSubmissionId === turn.clientSubmissionId) &&
    (!turn.workspaceInstructionReceiptId || receipt.receiptId === turn.workspaceInstructionReceiptId);
  const ledgerReceipt = state?.workspaceInstructionLedger?.find(
    (entry: any) => matchesTurn(entry.receipt),
  )?.receipt;
  const queue = state?.workspaceTurnQueue;
  const queueReceipt = queue?.sessionKey === context.runSessionKey
    ? queue.entries?.find((entry: any) =>
        matchesTurn(entry.receipt) && entry.receipt.sessionEpoch === queue.sessionEpoch)?.receipt
    : null;
  const receiptEpochs = [ledgerReceipt, queueReceipt]
    .filter(Boolean).map((receipt) => String(receipt.sessionEpoch || "").trim());
  const receiptEpoch = receiptEpochs[0];
  if (receiptEpochs.some((epoch) => !epoch || epoch !== receiptEpoch) ||
    (canonicalEpoch && receiptEpoch && canonicalEpoch !== receiptEpoch)) {
    throw new Error("RUNTIME_V2_SESSION_OWNER_MISMATCH");
  }
  if (receiptEpoch || canonicalEpoch) return receiptEpoch || canonicalEpoch;
  const lifecycle = state?.planLifecycle;
  if (lifecycle?.sessionKey === context.runSessionKey && String(lifecycle.sessionEpoch || "").trim()) {
    return String(lifecycle.sessionEpoch).trim();
  }
  if (session) throw new Error("RUNTIME_V2_SESSION_EPOCH_REQUIRED");
  // Isolated legacy fixtures without a Session container have no durable
  // Session owner. Production admission always supplies metadata or a receipt.
  return `runtime-v2:${String(turn.clientSubmissionId || turn.id).trim()}`;
}
