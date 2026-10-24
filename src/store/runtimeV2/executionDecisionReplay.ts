import { normalizeRuntimeV2Checkpoint } from "../../lib/runtime-v2/checkpoint";
import { toUserChoiceResolutionIdentity } from "../../lib/actionRequest";

/** A committed choice survives a crash between persistence and dispatch. */
export function installRuntimeV2ExecutionDecisionReplay(store: {
  getState: () => any;
  subscribe: (listener: () => void) => () => void;
}): () => void {
  const scheduled = new Set<string>();
  const replay = () => {
    const state = store.getState();
    const request = state.activeActionRequest;
    if (state.isGenerating || !request?.executionBlocker || request.kind !== "user_choice") return;
    const checkpoint = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints?.[request.turnId]);
    const blocker = checkpoint?.aggregate.run?.blocker;
    if (checkpoint?.aggregate.run?.status !== "paused" || !blocker?.decision ||
      blocker.requestId !== request.requestId || checkpoint.owner.sessionEpoch !== request.executionBlocker.sessionEpoch ||
      state.currentTurnId !== request.turnId || state.harnessRunMarker?.runId !== request.runId || state.harnessRunMarker?.status !== "paused") return;
    const key = `${checkpoint.owner.sessionKey}:${checkpoint.owner.sessionEpoch}:${request.requestId}:${checkpoint.revision}`;
    if (scheduled.has(key)) return;
    scheduled.add(key);
    queueMicrotask(() => {
      const current = store.getState();
      if (current.activeActionRequest !== request || current.isGenerating || current.harnessRunMarker !== state.harnessRunMarker) {
        scheduled.delete(key);
        return;
      }
      const reply = blocker.decisionReply || blocker.decision;
      current.sendMessage(reply, undefined, { hidden: true, selectedReplyOptionText: reply,
        replyOptionRequestIdentity: toUserChoiceResolutionIdentity(request) });
    });
  };
  const unsubscribe = store.subscribe(replay);
  replay();
  return unsubscribe;
}
