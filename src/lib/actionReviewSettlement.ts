export interface AbortableReviewSettlement<TDecision> {
  arm: () => void;
  resolve: (decision: TDecision) => boolean;
  isSettled: () => boolean;
}

/**
 * Owns exactly one permission-wait settlement. Abort always releases the
 * waiting Promise and never creates a continuation run; an explicit review
 * decision may continue only while the original signal is still live.
 */
export function createAbortableReviewSettlement<TDecision>(input: {
  signal: AbortSignal;
  abortedDecision: TDecision;
  onContinue: () => boolean | void;
  onAbort: () => void;
  onDecision: (decision: TDecision) => void;
}): AbortableReviewSettlement<TDecision> {
  let settled = false;
  let armed = false;

  const settle = (decision: TDecision, continueRun: boolean): boolean => {
    if (settled) return false;
    settled = true;
    if (armed) input.signal.removeEventListener("abort", handleAbort);
    if (continueRun && !input.signal.aborted) {
      const continuationAccepted = input.onContinue();
      if (continuationAccepted === false) {
        input.onAbort();
        input.onDecision(input.abortedDecision);
        return true;
      }
    } else {
      input.onAbort();
    }
    input.onDecision(decision);
    return true;
  };
  const handleAbort = () => {
    settle(input.abortedDecision, false);
  };

  return {
    arm() {
      if (armed || settled) return;
      armed = true;
      if (input.signal.aborted) {
        handleAbort();
        return;
      }
      input.signal.addEventListener("abort", handleAbort, { once: true });
    },
    resolve(decision) {
      return settle(decision, true);
    },
    isSettled: () => settled,
  };
}
