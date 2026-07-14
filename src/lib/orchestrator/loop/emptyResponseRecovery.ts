import { buildEmptyModelResponsePauseNotice } from "../../agentLoopSafety";
import { summarizeRepeatedExecuteTargets } from "../../executeRecoveryTools";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import { buildMissingToolCallContinuationPrompt } from "../../missingToolCallReprompt";
import { isAssistantTurnEmpty } from "../../normalizedTurn";
import {
  buildMalformedToolUseRecoveryPrompt,
  containsToolUseBlock,
  summarizeProtocolFragmentForLog,
} from "../../orchestrator/agentRecovery";
import {
  buildNonActionableStopMessage,
  isReviewablePlanStage,
  logAgentEvent,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import type { NormalizedStreamState } from "../../workflowModels";
import type { OrchestratorCallbacks } from "../types";

type WorkflowMode = "chat" | "edit" | "plan";

type PlanClosureAttemptResult =
  | "not_attempted"
  | "failed"
  | "stopped"
  | "approved_continue";

type PauseForReviewablePlanArtifact = (
  trigger: string,
) => Promise<"not_reviewable" | "stopped" | "approved_continue">;

type TryClosePlanWithEvidence = (
  trigger: string,
  details?: {
    consecutiveEmptyResponseCount?: number;
    rejectedVisibleCandidate?: boolean;
    toolCallCount?: number;
    replyOptionCount?: number;
  },
) => Promise<PlanClosureAttemptResult>;

type RecentSuccessfulProjectWrite = { name: string; target: string } | null;

export type EmptyResponseRecoveryResult = {
  status: "none" | "continue" | "stopped";
  consecutiveEmptyResponseCount: number;
  emptyResponseCountThisTurn: number;
  usedMalformedToolUseRecoveryPrompt: boolean;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
};

export async function handleEmptyResponseRecovery(input: {
  callbacks: OrchestratorCallbacks;
  activeProfile: string;
  iteration: number;
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  streamText: string;
  normalized: NormalizedStreamState;
  normalizedBaseToolCallCount: number;
  recentToolActivity: PlanToolActivitySummary[];
  recentSuccessfulProjectWrite: RecentSuccessfulProjectWrite;
  consecutiveEmptyResponseCount: number;
  emptyResponseCountThisTurn: number;
  usedMalformedToolUseRecoveryPrompt: boolean;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
  pauseForReviewablePlanArtifact: PauseForReviewablePlanArtifact;
  tryClosePlanWithEvidence: TryClosePlanWithEvidence;
}): Promise<EmptyResponseRecoveryResult> {
  const {
    callbacks,
    activeProfile,
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    streamText,
    normalized,
    normalizedBaseToolCallCount,
    recentToolActivity,
    recentSuccessfulProjectWrite,
    pauseForReviewablePlanArtifact,
    tryClosePlanWithEvidence,
  } = input;

  let consecutiveEmptyResponseCount = input.consecutiveEmptyResponseCount;
  let emptyResponseCountThisTurn = input.emptyResponseCountThisTurn;
  let usedMalformedToolUseRecoveryPrompt = input.usedMalformedToolUseRecoveryPrompt;
  let recoveringFromEmptyAssistantReplyAfterWrite =
    input.recoveringFromEmptyAssistantReplyAfterWrite;
  const emitDebug = (event: string, data: Record<string, unknown>) => {
    if (callbacks.onDebugEvent) callbacks.onDebugEvent(`agent.${event}`, data);
    else logAgentEvent(event, data);
  };

  const finish = (status: EmptyResponseRecoveryResult["status"]): EmptyResponseRecoveryResult => ({
    status,
    consecutiveEmptyResponseCount,
    emptyResponseCountThisTurn,
    usedMalformedToolUseRecoveryPrompt,
    recoveringFromEmptyAssistantReplyAfterWrite,
  });

  if (!isAssistantTurnEmpty(normalized)) {
    return finish("none");
  }

  if (
    workflowMode === "plan" &&
    !callbacks.getIsPlanApproved() &&
    isReviewablePlanStage(callbacks.getPlanStage())
  ) {
    emitDebug("plan_review_ready_after_empty_response", {
      iteration,
      planStage: callbacks.getPlanStage(),
      consecutiveEmptyResponseCount,
    });
    const reviewResult = await pauseForReviewablePlanArtifact("empty_response_with_reviewable_artifact");
    if (reviewResult === "approved_continue") return finish("continue");
    if (reviewResult === "stopped") return finish("stopped");
  }

  const malformedToolUseBlock =
    workflowMode === "plan" &&
    !callbacks.getIsPlanApproved() &&
    containsToolUseBlock(streamText) &&
    normalizedBaseToolCallCount === 0;
  if (malformedToolUseBlock && !usedMalformedToolUseRecoveryPrompt) {
    usedMalformedToolUseRecoveryPrompt = true;
    emitDebug("tool_protocol_parse_failed", {
      iteration,
      workflowMode,
      turnIntent,
      reason: "unparsed_tool_use_block",
      preview: summarizeProtocolFragmentForLog(streamText),
    });
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: buildMalformedToolUseRecoveryPrompt(MODEL_CONTROL_LANGUAGE),
    });
    return finish("continue");
  }

  consecutiveEmptyResponseCount += 1;
  emptyResponseCountThisTurn += 1;

  if (
    (callbacks.getSubagentDepth?.() || 0) > 0 &&
    activeProfile === "local" &&
    consecutiveEmptyResponseCount === 1 &&
    !input.normalized.toolCalls.length &&
    !callbacks.shouldForceXmlForProviderCompatibility?.()
  ) {
    callbacks.onProviderCompatibilityFallback?.("subagent_empty_native_completion");
    emitDebug("subagent_empty_response_fallback", {
      iteration,
      action: "switch_to_xml_tools",
      workflowMode,
      runtimeIntent,
    });
    callbacks.appendMessage({
      role: "assistant",
      content: buildEmptyAssistantPlaceholder(normalized.hiddenThought),
    });
    callbacks.appendMessage({
      role: "user",
      content: "The previous subagent response was empty. The runtime switched to the XML tool protocol; call one allowed read/search tool now without approval choices or another empty reply.",
    });
    return finish("continue");
  }

  if (
    workflowMode === "chat" &&
    runtimeIntent === "respond" &&
    emptyResponseCountThisTurn >= 2
  ) {
    const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
    emitDebug("loop_stop", {
      reason: "empty_model_response",
      iteration,
      consecutiveEmptyResponseCount,
      emptyResponseCountThisTurn,
      repeatedTargets,
    });
    callbacks.onNonActionableStop(
      buildEmptyModelResponsePauseNotice({
        language: callbacks.getPreferredLanguage(),
        emptyResponses: emptyResponseCountThisTurn,
        repeatedTargets,
        localProfile: activeProfile === "local",
      }),
      "no_output",
      {
        repeatedTargets,
        recoveryReason: "empty_model_response",
        nextStep: callbacks.getPreferredLanguage() === "zh"
          ? "复用已读上下文，要求直接总结、换目标或说明具体阻塞"
          : "reuse cached context and ask for a direct summary, a different target, or the concrete blocker",
      },
    );
    callbacks.onStatusChange("idle");
    return finish("stopped");
  }

  if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
    if (consecutiveEmptyResponseCount >= 2) {
      const closureResult = await tryClosePlanWithEvidence("empty_response_checkpoint", {
        consecutiveEmptyResponseCount,
        toolCallCount: 0,
        replyOptionCount: 0,
      });
      if (closureResult === "approved_continue") return finish("continue");
      if (closureResult === "stopped") return finish("stopped");
      if (closureResult === "failed") {
        emitDebug("plan_empty_after_closure_failed", {
          iteration,
          consecutiveEmptyResponseCount,
        });
      }
    }

    if (consecutiveEmptyResponseCount >= 3) {
      emitDebug("loop_stop", {
        reason: "plan_empty_response_checkpoint",
        iteration,
        consecutiveEmptyResponseCount,
      });
      callbacks.onNonActionableStop(
        buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
        "incomplete_plan",
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }

    callbacks.appendMessage({
      role: "assistant",
      content: buildEmptyAssistantPlaceholder(normalized.hiddenThought),
    });

    callbacks.appendMessage({
      role: "user",
      content: consecutiveEmptyResponseCount === 1
        ? "The previous Plan reply was empty or protocol-only. Retry once with the same context and evidence bundle, and output a reviewable `<proposed_plan>`; MAIN runtime owns materialization. Use `<user_options>` only for a real blocking choice. Do not return hidden reasoning or pseudo-tool placeholders."
        : "Two consecutive Plan replies produced no usable content, but the task must continue. Reuse the current context: if evidence is missing, call exactly one targeted read-only tool now; otherwise output the complete `<proposed_plan>`. Do not ask whether to continue, emit `<user_options>`, or return another blank/protocol placeholder.",
    });
    return finish("continue");
  }

  if (consecutiveEmptyResponseCount >= 3) {
    const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
    emitDebug("loop_stop", {
      reason: "empty_model_response",
      iteration,
      consecutiveEmptyResponseCount,
      emptyResponseCountThisTurn,
      repeatedTargets,
    });
    callbacks.onNonActionableStop(
      buildEmptyModelResponsePauseNotice({
        language: callbacks.getPreferredLanguage(),
        emptyResponses: consecutiveEmptyResponseCount,
        repeatedTargets,
        localProfile: activeProfile === "local",
      }),
      "no_output",
      {
        repeatedTargets,
        recoveryReason: "empty_model_response",
        nextStep: callbacks.getPreferredLanguage() === "zh"
          ? "复用已读上下文，要求直接总结、换目标或说明具体阻塞"
          : "reuse cached context and ask for a direct summary, a different target, or the concrete blocker",
      },
    );
    callbacks.onStatusChange("idle");
    return finish("stopped");
  }

  const shouldForcePostWriteVerification =
    workflowMode === "edit" &&
    !!recentSuccessfulProjectWrite;

  callbacks.appendMessage({
    role: "assistant",
    content: buildEmptyAssistantPlaceholder(normalized.hiddenThought),
  });

  callbacks.appendMessage({
    role: "user",
    content:
      shouldForcePostWriteVerification
        ? buildMissingToolCallContinuationPrompt(
            "post_write_verify",
            MODEL_CONTROL_LANGUAGE,
            consecutiveEmptyResponseCount,
          )
        : workflowMode === "chat"
        ? "The previous reply was empty. Answer the user with visible Markdown, or use a formal tool call when a tool is genuinely needed. Do not return another empty message or hidden reasoning only. Continue now and keep the final user-visible response in MAIN's configured response language."
        : "The previous reply was empty. Continue execution and return either a visible response or a formal tool call; do not return another empty message or hidden reasoning only. Keep user-visible text in MAIN's configured response language.",
  });
  if (shouldForcePostWriteVerification) {
    recoveringFromEmptyAssistantReplyAfterWrite = true;
  }
  return finish("continue");
}

function buildEmptyAssistantPlaceholder(hiddenThought: string): string {
  return hiddenThought ? `<thought>\n${hiddenThought}\n</thought>` : "...";
}
