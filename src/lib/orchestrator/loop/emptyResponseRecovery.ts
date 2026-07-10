import { buildEmptyModelResponsePauseNotice } from "../../agentLoopSafety";
import { summarizeRepeatedExecuteTargets } from "../../executeRecoveryTools";
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
    rejectedVisibleChars?: number;
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
    logAgentEvent("plan_review_ready_after_empty_response", {
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
    logAgentEvent("tool_protocol_parse_failed", {
      iteration,
      workflowMode,
      turnIntent,
      reason: "unparsed_tool_use_block",
      preview: summarizeProtocolFragmentForLog(streamText),
    });
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: buildMalformedToolUseRecoveryPrompt(callbacks.getPreferredLanguage()),
    });
    return finish("continue");
  }

  consecutiveEmptyResponseCount += 1;
  emptyResponseCountThisTurn += 1;

  if (
    workflowMode === "chat" &&
    runtimeIntent === "respond" &&
    emptyResponseCountThisTurn >= 2
  ) {
    const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
    logAgentEvent("loop_stop", {
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
        logAgentEvent("plan_empty_after_closure_failed", {
          iteration,
          consecutiveEmptyResponseCount,
        });
      }
      logAgentEvent("loop_stop", {
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
      content: callbacks.getPreferredLanguage() === "zh"
        ? "上一条 Plan 回复是空的。请立即继续生成可审批的正式计划：复杂实现和修复类请求默认用 write_file 或 replace_in_file 创建/更新 `.MAIN/plans/plan.md`；如果信息不足，只能用 `<user_options>` 给出关键选择。不要只返回空消息、隐藏 thinking/analysis，或伪工具占位。"
        : "The previous Plan reply was empty. Continue now with a reviewable plan: complex implementation and fix plans should use write_file or replace_in_file to create/update `.MAIN/plans/plan.md`; if information is insufficient, offer key choices with `<user_options>`. Do not return an empty message, hidden thinking/analysis only, or pseudo-tool placeholders.",
    });
    return finish("continue");
  }

  if (consecutiveEmptyResponseCount >= 3) {
    const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
    logAgentEvent("loop_stop", {
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
            callbacks.getPreferredLanguage(),
            consecutiveEmptyResponseCount,
          )
        : workflowMode === "chat"
        ? "上一条回复是空的。请直接输出对用户可见的 Markdown 正文来回答用户；如果确实需要工具，请使用正式工具调用。不要只返回空消息，也不要只输出不可见的 thinking/analysis 标签。现在继续。"
        : "上一条回复是空的。请继续执行，并确保这次返回可见正文或正式工具调用；不要只返回空消息，也不要只输出不可见的 thinking/analysis 标签。现在继续。",
  });
  if (shouldForcePostWriteVerification) {
    recoveringFromEmptyAssistantReplyAfterWrite = true;
  }
  return finish("continue");
}

function buildEmptyAssistantPlaceholder(hiddenThought: string): string {
  return hiddenThought ? `<thought>\n${hiddenThought}\n</thought>` : "...";
}
