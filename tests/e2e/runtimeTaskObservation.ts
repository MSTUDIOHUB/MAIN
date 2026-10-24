import { isConversationTurnRuntimeClosed } from "../../src/lib/workflowModels";
import { isRunTerminalEvent, isTerminalTurnEvent } from "../../src/lib/turnEvents";
import { normalizeRuntimeV2Checkpoint } from "../../src/lib/runtime-v2/checkpoint";

/** Observe the app's canonical conclusion, including admission-only Runs.
 * Cleanup eligibility is separate from task success and never inferred from idle. */
export function observeRuntimeTask(snapshot: any): {
  state: "running" | "paused" | "terminal" | "dispatch_error";
  outcome: any; shouldCancel: boolean; consistencyErrors: string[];
} {
  // The UI may clear its active pointer after an admission-only conclusion.
  // A test observing a submission keeps the exact receipt owner; it must
  // never guess a different/latest Turn from the transcript.
  const turnId = snapshot.targetTurnId || snapshot.currentTurnId;
  const turn = snapshot.conversationTurns?.find((item: any) => item.id === turnId);
  const checkpoint = normalizeRuntimeV2Checkpoint(snapshot.checkpoint);
  const aggregate = checkpoint?.owner.turnId === turnId ? checkpoint.aggregate : null;
  const canonical = isConversationTurnRuntimeClosed(turn?.runtimeOutcome) ? turn.runtimeOutcome : null;
  const outcome = canonical || aggregate?.terminalOutcome || null;
  const events = (snapshot.runtimeEvents || []).filter((event: any) => event.turnId === turnId);
  const conclusions = events.filter((event: any) => isRunTerminalEvent(event) && event.parentRunId == null &&
    (!outcome?.runId || event.runId === outcome.runId));
  const turns = events.filter(isTerminalTurnEvent);
  const finals = (snapshot.taskFlow || []).filter((block: any) => block.turnId === turnId && block.type === "agent" && block.visibility === "assistant_final");
  if (outcome || (conclusions.length && turns.length)) {
    const result = outcome || { status: "completed", runId: conclusions[0].runId, resultKind: conclusions[0].resultKind };
    const errors: string[] = [];
    if (conclusions.length !== 1) errors.push(`Expected one parent Run conclusion, observed ${conclusions.length}`);
    if (turns.length !== 1) errors.push(`Expected one Turn conclusion, observed ${turns.length}`);
    if (finals.length !== 1) errors.push(`Expected one final, observed ${finals.length}`);
    if (conclusions.some((event: any) => event.resultKind !== result.resultKind) || turns.some((event: any) => event.resultKind !== result.resultKind)) errors.push("Canonical conclusion result kinds disagree");
    if (aggregate?.terminalOutcome && aggregate.terminalOutcome.resultKind !== result.resultKind) errors.push("Runtime and Turn outcomes disagree");
    // Checkpoint commit precedes UI/main-event publication. Wait for that
    // projection while already fencing cleanup from canceling a closed Run.
    if (!conclusions.length || !turns.length || !finals.length) return { state: "running", outcome: result, shouldCancel: false, consistencyErrors: errors };
    return { state: "terminal", outcome: result, shouldCancel: false, consistencyErrors: errors };
  }
  if (snapshot.dispatchError) return { state: "dispatch_error", outcome: null, shouldCancel: true, consistencyErrors: [] };
  if (aggregate?.run?.status === "paused" && !snapshot.isGenerating) return { state: "paused", outcome: null, shouldCancel: true, consistencyErrors: [] };
  return { state: "running", outcome: null, shouldCancel: true, consistencyErrors: [] };
}
