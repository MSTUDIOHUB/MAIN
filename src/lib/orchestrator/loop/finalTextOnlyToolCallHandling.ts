import { buildMaxStepsToolCallIgnoredNotice } from "../../agentLoopSafety";
import {
  buildExecuteNoProgressLoopPauseNotice,
  summarizeRepeatedExecuteTargets,
} from "../../executeRecoveryTools";
import { logAgentEvent } from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { serializeAssistantReplyForHistory } from "../../replyOptions";
import type { ResolvedUserIntent } from "../../runIntent";
import type { OrchestratorCallbacks, ToolCallToExecute } from "../types";
import { completeAssistantTurn } from "./finalTurnCompletion";

type CompleteAssistantTurnInput = Parameters<typeof completeAssistantTurn>[0];

export type FinalTextOnlyToolCallHandlingResult =
  | { status: "none" }
  | { status: "stopped" };

export function handleFinalTextOnlyToolCalls(input: {
  callbacks: OrchestratorCallbacks;
  assistantMsgId: string;
  iteration: number;
  effectiveMaxIterations: number;
  runtimeIntent: ResolvedUserIntent;
  finalTextOnlyStep: boolean;
  chatFinalSynthesisActive: boolean;
  chatFinalSynthesisReason: string;
  repairExecutionRequestInChat: boolean;
  normalizedVisibleText: string;
  effectiveToolCalls: ToolCallToExecute[];
  recentToolActivity: PlanToolActivitySummary[];
  noProgressBatchRepeatCount: number;
  providerReasoningForHistory: CompleteAssistantTurnInput["providerReasoningForHistory"];
  iterationContext: CompleteAssistantTurnInput["iterationContext"];
  emitTurnEvent: CompleteAssistantTurnInput["emitTurnEvent"];
  emitTurnCompletedEvent: CompleteAssistantTurnInput["emitTurnCompletedEvent"];
}): FinalTextOnlyToolCallHandlingResult {
  const {
    callbacks,
    assistantMsgId,
    iteration,
    effectiveMaxIterations,
    runtimeIntent,
    finalTextOnlyStep,
    chatFinalSynthesisActive,
    chatFinalSynthesisReason,
    repairExecutionRequestInChat,
    normalizedVisibleText,
    effectiveToolCalls,
    recentToolActivity,
    noProgressBatchRepeatCount,
    providerReasoningForHistory,
    iterationContext,
    emitTurnEvent,
    emitTurnCompletedEvent,
  } = input;

  if ((!finalTextOnlyStep && !chatFinalSynthesisActive) || effectiveToolCalls.length === 0) {
    return { status: "none" };
  }

  callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
  const finalText = normalizedVisibleText.trim();
  const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
  const shouldPauseUnresolvedChatRepair =
    chatFinalSynthesisActive &&
    repairExecutionRequestInChat &&
    runtimeIntent === "respond";

  logAgentEvent(chatFinalSynthesisActive ? "chat_final_synthesis_tool_calls_ignored" : "max_steps_tool_calls_ignored", {
    iteration,
    maxIterations: effectiveMaxIterations,
    reason: chatFinalSynthesisReason,
    toolCalls: effectiveToolCalls.length,
    toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
    visibleChars: finalText.length,
    repeatedTargets,
    unresolvedRepairRequest: shouldPauseUnresolvedChatRepair,
  });

  if (shouldPauseUnresolvedChatRepair) {
    const language = callbacks.getPreferredLanguage();
    const pauseMessage = buildExecuteNoProgressLoopPauseNotice({
      language,
      scope: "chat",
      repeats: Math.max(1, noProgressBatchRepeatCount),
      remainingTask: language === "zh"
        ? "用户要求找到问题并修复，但本轮仍停留在重复只读探索，没有产生真实修改、验证或明确阻塞。请继续时按执行意图恢复，基于已读上下文直接修改/验证，或说明缺少哪个关键输入。"
        : "The user asked to find and fix the issue, but this turn stayed in repeated read-only exploration without a real change, validation, or concrete blocker. Resume as an execution intent: patch/validate from cached context, or state the exact missing input.",
      recentActivity: recentToolActivity,
      repeatedTargets,
    });
    callbacks.onNonActionableStop(pauseMessage, "no_action", {
      phase: "paused",
      recoveryReason: "execute_chat_repair_no_progress",
      nextStep: language === "zh"
        ? "继续时应进入执行能力，复用已读证据直接修复或给出精确阻塞。"
        : "Resume with execution capabilities, reuse cached evidence, and patch or state the exact blocker.",
      repeatedTargets,
    });
    callbacks.onStatusChange("idle");
    return { status: "stopped" };
  }

  if (finalText) {
    callbacks.onAssistantFinalText(finalText, [], {
      hasToolCalls: false,
      modelAuthored: true,
    });
    const assistantHistoryText = serializeAssistantReplyForHistory(finalText, []);
    completeAssistantTurn({
      callbacks,
      assistantHistoryText,
      providerReasoningForHistory,
      assistantMsgId,
      iterationContext,
      emitTurnEvent,
      emitTurnCompletedEvent,
    });
    return { status: "stopped" };
  }

  callbacks.onNonActionableStop(
    chatFinalSynthesisActive
      ? callbacks.getPreferredLanguage() === "zh"
        ? [
            "本轮已进入收束回答模式，但模型仍尝试继续调用工具。",
            "MAIN 已忽略这些工具调用并停止，避免继续扩大同一轮循环。",
            repeatedTargets.length ? `重复目标：${repeatedTargets.join("、")}` : "重复目标：未定位到单一目标",
            "下一步：请继续时要求基于已读上下文直接总结，或明确新的执行目标。",
          ].join("\n")
        : [
            "This turn entered final-answer synthesis mode, but the model still attempted tool calls.",
            "MAIN ignored those calls and stopped to avoid extending the same turn loop.",
            repeatedTargets.length ? `Repeated targets: ${repeatedTargets.join(", ")}` : "Repeated targets: none isolated",
            "Next: resume by asking for a direct summary from existing context, or provide a new execution target.",
          ].join("\n")
      : buildMaxStepsToolCallIgnoredNotice({
          language: callbacks.getPreferredLanguage(),
          iteration,
          maxIterations: effectiveMaxIterations,
          repeatedTargets,
        }),
    "no_action",
    {
      repeatedTargets,
      recoveryReason: chatFinalSynthesisActive ? "chat_final_synthesis_tool_call" : "max_iterations_boundary",
      nextStep: callbacks.getPreferredLanguage() === "zh"
        ? "复用已读上下文，直接总结、换目标或说明具体阻塞"
        : "reuse cached context, summarize directly, switch targets, or state the concrete blocker",
    },
  );
  callbacks.onStatusChange("idle");
  return { status: "stopped" };
}
