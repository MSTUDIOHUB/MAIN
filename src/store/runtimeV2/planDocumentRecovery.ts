import type { RuntimeV2NormalizedToolCall, RuntimeV2RunIdentity } from "../../lib/runtime-v2";
import type { PlanLedger } from "./planLedger";
import { recoverPlanQuestion } from "./planQuestionControl";

/** Resume the original normalized invocation from the ledger, never regenerate
 * a completed document body. Safe reads may repeat; versioned document saves
 * use the native exact-content idempotency contract. */
export async function recoverPlanDocumentInvocations(ledger: PlanLedger, run: RuntimeV2RunIdentity): Promise<{
  calls: readonly RuntimeV2NormalizedToolCall[];
  settledQuestion?: boolean;
} | null> {
  const snapshot = ledger.snapshot()!;
  const pending = [...snapshot.pendingToolCalls];
  for (const command of [...snapshot.scheduledCommands]) {
    if (command.kind === "execute_tool" && pending.some(call => call.id === command.payload.toolCallId && call.name === command.payload.toolName)) continue;
    await ledger.settleCommand({ type: "command.completed", run, idempotencyKey: command.idempotencyKey, status: "failed" });
    await ledger.recordSoftSignal(run, command.kind === "request_model" ? "protocol_drift" : "repeated_action");
  }
  if (pending.length) return { calls: pending };
  const question = recoverPlanQuestion(snapshot, run);
  return question ? { calls: question.result.toolCalls, settledQuestion: question.settled } : null;
}
