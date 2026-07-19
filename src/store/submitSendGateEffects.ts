import {
  normalizeAttachedFile,
  type AttachedFile,
} from "../lib/attachments";
import {
  resolveSubmitSendGateDecision,
  type SubmitSendGateDecision,
} from "../lib/submit/turnSubmission";
import type { ResolvedRunIntent } from "../lib/runIntent";
import type {
  GoalContinuationAuthorization,
  GoalCreationAuthorization,
} from "../lib/submit/turnSubmission";

export interface SubmitSendGateEffectsState {
  isGenerating: boolean;
  agentStatus: string;
  abortController: unknown | null;
  currentTurnId: string | null;
  pendingReviewResolve: unknown | null;
  pendingReviewTaskId: number | null;
}

export interface SubmitSendGateEffectOptions {
  executionConsentGranted?: boolean;
  runtimeIntentOverride?: string | null;
  turnIdOverride?: string | null;
}

export interface ApplySubmitSendGateEffectsInput<TState extends SubmitSendGateEffectsState> {
  text: string;
  images?: string[];
  hasSupplementalInput: boolean;
  isHidden: boolean;
  options?: SubmitSendGateEffectOptions;
  shouldExecuteOnceFromReplyOption: boolean;
  state: TState;
  mentionSnapshot: string[];
  attachedFilesSnapshot: Array<AttachedFile | string>;
  queuedWorkflowContext?: {
    runtimeIntentOverride?: ResolvedRunIntent;
    goalSourceContextSnapshot?: string;
    goalCreationAuthorization?: GoalCreationAuthorization;
    goalContinuationAuthorization?: GoalContinuationAuthorization;
    goalContinuationGuidance?: string;
  };
  queueUserMessage: (
    text: string,
    images?: string[],
    options?: {
      contextMentions?: string[];
      attachedFiles?: AttachedFile[];
      runtimeIntentOverride?: ResolvedRunIntent;
      goalSourceContextSnapshot?: string;
      goalCreationAuthorization?: GoalCreationAuthorization;
      goalContinuationAuthorization?: GoalContinuationAuthorization;
      goalContinuationGuidance?: string;
    },
  ) => void;
  approvePendingReviewOnce: () => void;
  approvePlan: (approvalChoice?: string) => void;
  setState: (patch: any) => void;
  closeTurnAsCanceled: (turnId: string, options: { reason: string; message: string }) => boolean;
  logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

export interface SubmitSendGateEffectsResult<TState extends SubmitSendGateEffectsState> {
  decision: SubmitSendGateDecision;
  shouldContinue: boolean;
  returnValue?: boolean;
  state: TState;
}

export function applySubmitSendGateEffects<TState extends SubmitSendGateEffectsState>(
  input: ApplySubmitSendGateEffectsInput<TState>,
): SubmitSendGateEffectsResult<TState> {
  const decision = resolveSubmitSendGateDecision({
    text: input.text,
    imagesLength: input.images?.length ?? 0,
    hasSupplementalInput: input.hasSupplementalInput,
    isHidden: input.isHidden,
    executionConsentGranted: input.options?.executionConsentGranted,
    shouldExecuteOnceFromReplyOption: input.shouldExecuteOnceFromReplyOption,
    isGenerating: input.state.isGenerating,
    agentStatus: input.state.agentStatus,
    hasAbortController: !!input.state.abortController,
    hasCurrentTurn: !!input.state.currentTurnId,
  });

  for (const reason of decision.allowedBusyReasons) {
    input.logStoreEvent("send_busy_hidden_execution_allowed", {
      reason,
      runtimeIntentOverride: input.options?.runtimeIntentOverride ?? null,
      turnIdOverride: input.options?.turnIdOverride ?? null,
    });
  }

  if (decision.action.kind === "block_empty") {
    input.logStoreEvent("send_blocked", { reason: decision.action.reason });
    return {
      decision,
      shouldContinue: false,
      returnValue: false,
      state: input.state,
    };
  }

  if (decision.action.kind === "queue") {
    if (input.isHidden && input.options?.executionConsentGranted === true) {
      input.logStoreEvent("send_busy_hidden_execution_rejected", {
        reason: decision.action.reason,
        runtimeIntentOverride: input.options?.runtimeIntentOverride ?? null,
        turnIdOverride: input.options?.turnIdOverride ?? null,
      });
      return {
        decision,
        shouldContinue: false,
        returnValue: false,
        state: input.state,
      };
    }
    input.queueUserMessage(input.text, input.images, {
      contextMentions: input.mentionSnapshot,
      attachedFiles: input.attachedFilesSnapshot.map((file) => normalizeAttachedFile(file)),
      ...input.queuedWorkflowContext,
    });
    input.logStoreEvent("send_queued", {
      reason: decision.action.reason,
      ...(decision.action.agentStatus ? { agentStatus: decision.action.agentStatus } : {}),
    });
    return {
      decision,
      shouldContinue: false,
      returnValue: false,
      state: input.state,
    };
  }

  if (decision.action.kind === "approve_pending_review") {
    input.logStoreEvent("send_pending_review_approve_bypass", {
      textChars: input.text?.length ?? 0,
      executionConsentGranted: input.options?.executionConsentGranted,
      shouldExecuteOnceFromReplyOption: input.shouldExecuteOnceFromReplyOption,
      pendingReviewTaskId: input.state.pendingReviewTaskId,
    });
    if (input.state.pendingReviewResolve && input.state.pendingReviewTaskId != null) {
      input.approvePendingReviewOnce();
    } else {
      input.approvePlan(input.text);
    }
    return {
      decision,
      shouldContinue: false,
      returnValue: true,
      state: input.state,
    };
  }

  if (decision.action.kind === "reset_stuck_state") {
    input.logStoreEvent("send_stuck_state_reset", {
      previousStatus: decision.action.previousStatus,
    });
    const closed = input.state.currentTurnId
      ? input.closeTurnAsCanceled(input.state.currentTurnId, {
          reason: "stale_runtime_superseded",
          message: /[^\x00-\x7F]/.test(input.text)
            ? "检测到旧回合的运行租约已经丢失；旧回合已取消并完成收口。"
            : "The previous turn lost its run lease; it was canceled and closed.",
        })
      : false;
    if (!closed) {
      input.setState({ agentStatus: "idle", isGenerating: false });
    }
  }

  return {
    decision,
    shouldContinue: true,
    state: input.state,
  };
}
