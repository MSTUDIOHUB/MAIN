import type { TaskBlock } from "../lib/taskTypes";
import {
  resolvePendingReviewSubmissionDecision,
  type SubmitPendingReviewDecision,
} from "../lib/submit/turnSubmission";
import type { ConversationTurn } from "../lib/workflowModels";
import type { ActionRequest } from "../lib/actionRequest";

type PendingReviewReject = (decision: { action: "reject" }) => void;

export interface SubmitPendingReviewTransitionState {
  agentStatus: string;
  currentTurnId: string | null;
  conversationTurns: ConversationTurn[];
  taskFlow: TaskBlock[];
  pendingReviewTaskId: number | null;
  activeActionRequest?: ActionRequest | null;
  abortController: { abort: () => void } | null;
  pendingReviewResolve: PendingReviewReject | null;
}

export interface ApplySubmitPendingReviewTransitionInput<TState extends SubmitPendingReviewTransitionState> {
  text: string;
  executionConsentGranted?: boolean;
  state: TState;
  getState: () => TState;
  setState: (patch: any) => void;
  setConversationTurnStatus: (turnId: string, status: "stopped_no_action") => void;
  logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
  logError?: (message: string, error: unknown) => void;
}

export interface SubmitPendingReviewTransitionResult<TState extends SubmitPendingReviewTransitionState> {
  decision: SubmitPendingReviewDecision;
  aborted: boolean;
  state: TState;
}

export function applySubmitPendingReviewTransition<TState extends SubmitPendingReviewTransitionState>(
  input: ApplySubmitPendingReviewTransitionInput<TState>,
): SubmitPendingReviewTransitionResult<TState> {
  const currentTurn = input.state.currentTurnId
    ? input.state.conversationTurns.find((turn) => turn.id === input.state.currentTurnId) || null
    : null;
  const decision = resolvePendingReviewSubmissionDecision({
    text: input.text,
    executionConsentGranted: input.executionConsentGranted,
    agentStatus: input.state.agentStatus,
    currentTurn,
    taskFlow: input.state.taskFlow,
  });

  if (!decision.shouldAbortAndStartNewTurn) {
    return {
      decision,
      aborted: false,
      state: input.state,
    };
  }

  input.logStoreEvent("send_pending_review_abort_and_new_turn", {
    textChars: input.text?.length ?? 0,
    pendingReviewTaskId: input.state.pendingReviewTaskId,
  });

  if (input.state.abortController) {
    try {
      input.state.abortController.abort();
    } catch (error) {
      (input.logError || console.error)(
        "Failed to abort controller during pending_review transition:",
        error,
      );
    }
  }

  if (input.state.pendingReviewResolve) {
    try {
      input.state.pendingReviewResolve({ action: "reject" });
    } catch (error) {
      (input.logError || console.error)(
        "Failed to resolve pendingReviewResolve during pending_review transition:",
        error,
      );
    }
  }

  input.setState({
    agentStatus: "idle",
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    activeActionRequest: null,
    pendingToolCall: null,
  });

  if (input.state.currentTurnId) {
    input.setConversationTurnStatus(input.state.currentTurnId, "stopped_no_action");
  }

  return {
    decision,
    aborted: true,
    state: input.getState(),
  };
}
