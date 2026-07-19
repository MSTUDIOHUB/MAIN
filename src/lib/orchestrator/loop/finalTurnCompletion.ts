import {
  buildAssistantHistoryMessage,
  buildNonActionableStopMessage,
  logAgentEvent,
  summarizeReplyOptionsForLog,
} from "../../orchestrator";
import type { ResolvedUserIntent } from "../../runIntent";
import type { MainThreadEventInput, MainThreadItem } from "../../turnEvents";
import type { ReplyOption } from "../../workflowModels";
import type { OrchestratorCallbacks } from "../types";
import type { TurnIterationContext } from "./turnIterationContext";
import { USER_CHOICE_PAUSE_REASON } from "../../runOutcome";

type WorkflowMode = "chat" | "edit" | "plan";
type CompletionStatus = "none" | "stopped";
type ProviderReasoningForHistory = Parameters<typeof buildAssistantHistoryMessage>[1];

type StagedTurnCompletionEmitter = (() => void) & {
  stageCompletion?: (commit: () => void) => void;
};

type AssistantTurnCompletionInput = {
  callbacks: OrchestratorCallbacks;
  assistantHistoryText: string;
  providerReasoningForHistory: ProviderReasoningForHistory;
  assistantMsgId: string;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId">;
  emitTurnEvent: (event: MainThreadEventInput) => void;
  emitTurnCompletedEvent: () => void;
  completionMode?: "completed" | "paused";
  pauseReason?: string;
  pauseMessage?: string;
  nonActionableStop?: {
    message: string;
    reason: "no_output" | "no_action" | "missing_tool_loop" | "incomplete_plan";
  };
};

export function completeAssistantTurn(input: AssistantTurnCompletionInput): void {
  const {
    callbacks,
    assistantHistoryText,
    providerReasoningForHistory,
    assistantMsgId,
    iterationContext,
    emitTurnEvent,
    emitTurnCompletedEvent,
    completionMode = "completed",
    pauseReason,
    pauseMessage,
    nonActionableStop,
  } = input;
  const { eventThreadId, eventTurnId } = iterationContext;

  const publishAssistantItem = () => {
    callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
    emitTurnEvent({
      type: "item.completed",
      threadId: eventThreadId,
      turnId: eventTurnId,
      timestampMs: Date.now(),
      item: {
        id: assistantMsgId,
        details: {
          type: "agent_message",
          text: assistantHistoryText,
        },
      } as MainThreadItem,
    });
    if (nonActionableStop) {
      callbacks.onNonActionableStop(nonActionableStop.message, nonActionableStop.reason);
    }
  };
  const publishPausedCompletion = () => {
    publishAssistantItem();
    const attachedRunIdentity = (
      emitTurnEvent as typeof emitTurnEvent & {
        runIdentity?: {
          runId: string;
          parentRunId: string | null;
          goalSliceId?: string;
        };
      }
    ).runIdentity;
    emitTurnEvent({
      type: "run.paused",
      threadId: eventThreadId,
      turnId: eventTurnId,
      timestampMs: Date.now(),
      runId: attachedRunIdentity?.runId || `run-untracked-${eventTurnId}`,
      parentRunId: attachedRunIdentity?.parentRunId ?? null,
      ...(attachedRunIdentity?.goalSliceId
        ? { goalSliceId: attachedRunIdentity.goalSliceId }
        : {}),
      reason: pauseReason || nonActionableStop?.reason || "awaiting_input",
      message: pauseMessage || nonActionableStop?.message || assistantHistoryText,
    });
    callbacks.onStatusChange("idle");
  };
  if (completionMode === "paused") {
    publishPausedCompletion();
    return;
  }

  const commitCompletedTurn = () => {
    publishAssistantItem();
    emitTurnCompletedEvent();
    callbacks.onStatusChange("idle");
  };
  const stagedEmitter = emitTurnCompletedEvent as StagedTurnCompletionEmitter;
  if (stagedEmitter.stageCompletion) {
    stagedEmitter.stageCompletion(commitCompletedTurn);
    return;
  }
  commitCompletedTurn();
}

export function handleReplyOptionsPause(input: {
  callbacks: OrchestratorCallbacks;
  iteration: number;
  shouldPauseForUserChoice: boolean;
  shouldSuppressApprovedPlanNoToolText: boolean;
  replyOptions: ReplyOption[];
  effectiveToolCallCount: number;
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
  hasStructuredProposal: boolean;
  planStage: ReturnType<OrchestratorCallbacks["getPlanStage"]>;
  isPlanApproved: boolean;
  completion: Omit<AssistantTurnCompletionInput, "callbacks">;
}): { status: CompletionStatus } {
  const {
    callbacks,
    iteration,
    shouldPauseForUserChoice,
    shouldSuppressApprovedPlanNoToolText,
    replyOptions,
    effectiveToolCallCount,
    workflowMode,
    turnIntent,
    hasStructuredProposal,
    planStage,
    isPlanApproved,
    completion,
  } = input;

  if (!shouldPauseForUserChoice || shouldSuppressApprovedPlanNoToolText) {
    return { status: "none" };
  }

  logAgentEvent("reply_options_pause", {
    iteration,
    reason: effectiveToolCallCount > 0
      ? "legacy_explicit_choice_precedes_tool_execution"
      : "awaiting_explicit_user_choice",
    replyOptions: replyOptions.length,
    optionPreview: summarizeReplyOptionsForLog(replyOptions),
    droppedToolCalls: effectiveToolCallCount,
    workflowMode,
    turnIntent,
  });
  if (workflowMode === "plan" && !isPlanApproved) {
    logAgentEvent("plan_user_choice_checkpoint", {
      iteration,
      replyOptions: replyOptions.length,
      optionPreview: summarizeReplyOptionsForLog(replyOptions),
      hasStructuredProposal,
      planStage,
    });
  }

  completeAssistantTurn({
    callbacks,
    ...completion,
    completionMode: "paused",
    pauseReason: USER_CHOICE_PAUSE_REASON,
    pauseMessage: callbacks.getPreferredLanguage() === "zh"
      ? "正在等待用户在当前回合中选择或补充信息。"
      : "Waiting for the user to choose or clarify within the current turn.",
  });
  return { status: "stopped" };
}

export function handleFinalNoToolAssistantTurn(input: {
  callbacks: OrchestratorCallbacks;
  iteration: number;
  workflowMode: WorkflowMode;
  isPlanApproved: boolean;
  normalizedVisibleChars: number;
  normalizedReplyOptionCount: number;
  completion: Omit<AssistantTurnCompletionInput, "callbacks">;
}): { status: CompletionStatus } {
  const {
    callbacks,
    iteration,
    workflowMode,
    isPlanApproved,
    normalizedVisibleChars,
    normalizedReplyOptionCount,
    completion,
  } = input;

  const currentPlanStage = callbacks.getPlanStage();
  if (workflowMode === "plan" && !isPlanApproved && currentPlanStage !== "ready_to_execute") {
    logAgentEvent("loop_stop", {
      reason: "plan_waiting_for_user_or_summary",
      iteration,
      visibleChars: normalizedVisibleChars,
      replyOptions: normalizedReplyOptionCount,
      planStage: currentPlanStage,
    });
    completeAssistantTurn({
      callbacks,
      ...completion,
      completionMode: "paused",
      pauseReason: "incomplete_plan",
      nonActionableStop: {
        message: buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
        reason: "incomplete_plan",
      },
    });
    return { status: "stopped" };
  }

  logAgentEvent("loop_stop", {
    reason: "assistant_text_done",
    iteration,
    visibleChars: normalizedVisibleChars,
    replyOptions: normalizedReplyOptionCount,
  });
  completeAssistantTurn({
    callbacks,
    ...completion,
  });
  return { status: "stopped" };
}
