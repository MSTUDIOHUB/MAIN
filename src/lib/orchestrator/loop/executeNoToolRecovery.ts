import {
  buildExecuteXmlTextActionRecoveryPrompt,
  shouldRecoverExecuteXmlTextWithoutAction,
} from "../../orchestrator/agentRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import {
  buildExecuteCompletionEvidencePrompt,
  buildExecuteReplanningEvidencePrompt,
  buildNonActionableStopMessage,
  logAgentEvent,
  looksLikeExecutionReplanningText,
  looksLikeOperationCompletionClaim,
  MAX_NO_ACTION_RETRIES,
} from "../../orchestrator";
import type { OrchestratorCallbacks } from "../types";

export type ExecuteNoToolRecoveryResult = {
  status: "none" | "continue" | "stopped";
  consecutiveNoToolCount: number;
};

export function resolveExecuteNoToolCheckpointLimit(activeProfile: string): number {
  return activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES;
}

export function isExecuteRuntimeRequiringEvidence(input: {
  workflowMode: "chat" | "edit" | "plan";
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
}): boolean {
  return (
    input.workflowMode === "edit" ||
    input.turnIntent === "execute" ||
    input.runtimeIntent === "execute" ||
    input.runtimeIntent === "studio_workflow"
  );
}

export function handleExecuteNoToolRecovery(input: {
  callbacks: OrchestratorCallbacks;
  activeProfile: string;
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  forceXmlTools: boolean;
  availableToolNames: Set<string>;
  effectiveToolCallCount: number;
  finalReplyOptionsCount: number;
  shouldPauseForUserChoice: boolean;
  sawExecuteOperationEvidence: boolean;
  visibleText: string;
  protocolViolation?: "required_tool_call_missing";
  assistantMsgId: string;
  consecutiveNoToolCount: number;
}): ExecuteNoToolRecoveryResult {
  const {
    callbacks,
    activeProfile,
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    forceXmlTools,
    availableToolNames,
    effectiveToolCallCount,
    finalReplyOptionsCount,
    shouldPauseForUserChoice,
    sawExecuteOperationEvidence,
    visibleText,
    assistantMsgId,
  } = input;

  let consecutiveNoToolCount = input.consecutiveNoToolCount;
  const finish = (status: ExecuteNoToolRecoveryResult["status"]): ExecuteNoToolRecoveryResult => ({
    status,
    consecutiveNoToolCount,
  });

  if (effectiveToolCallCount > 0) return finish("none");

  const isExecuteRuntimeWithoutEvidence = isExecuteRuntimeRequiringEvidence({
    workflowMode,
    turnIntent,
    runtimeIntent,
  });
  if (
    isExecuteRuntimeWithoutEvidence &&
    input.protocolViolation === "required_tool_call_missing"
  ) {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    callbacks.onStatusChange("running");
    consecutiveNoToolCount += 1;
    logAgentEvent("execute_required_tool_call_missing", {
      iteration,
      consecutiveNoToolCount,
      workflowMode,
      turnIntent,
      runtimeIntent,
      availableTools: Array.from(availableToolNames),
    });
    if (consecutiveNoToolCount >= resolveExecuteNoToolCheckpointLimit(activeProfile)) {
      callbacks.onNonActionableStop(
        buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution"),
        "missing_tool_loop",
        {
          phase: "paused",
          recoveryReason: "required_tool_call_protocol_violation",
          nextStep: callbacks.getPreferredLanguage() === "zh"
            ? "模型在 required 工具阶段连续返回零工具调用；从当前证据检查点恢复，不能把 stop 当作完成。"
            : "The model repeatedly returned no tool call while tool use was required; resume from the evidence checkpoint instead of treating stop as completion.",
        },
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }
    callbacks.appendMessage({
      role: "user",
      content: "TOOL_PROTOCOL_RECOVERY: The previous response violated required tool use by returning no tool call. Do not restart analysis or claim completion; call exactly one currently available tool that closes the active evidence gap.",
    });
    return finish("continue");
  }
  const rejectedExecuteCompletionClaim =
    isExecuteRuntimeWithoutEvidence &&
    finalReplyOptionsCount === 0 &&
    !sawExecuteOperationEvidence &&
    looksLikeOperationCompletionClaim(visibleText);
  if (rejectedExecuteCompletionClaim) {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    callbacks.onStatusChange("running");
    consecutiveNoToolCount += 1;
    logAgentEvent("execute_completion_claim_without_evidence", {
      iteration,
      consecutiveNoToolCount,
      workflowMode,
      turnIntent,
      runtimeIntent,
      visibleChars: visibleText.length,
    });

    if (consecutiveNoToolCount >= resolveExecuteNoToolCheckpointLimit(activeProfile)) {
      logAgentEvent("loop_stop", {
        reason: "execute_completion_claim_without_evidence",
        iteration,
        consecutiveNoToolCount,
      });
      callbacks.onNonActionableStop(
        buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution"),
        "no_action",
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }

    callbacks.appendMessage({
      role: "user",
      content: buildExecuteCompletionEvidencePrompt(MODEL_CONTROL_LANGUAGE, consecutiveNoToolCount),
    });
    return finish("continue");
  }

  const rejectedExecuteReplanningText =
    isExecuteRuntimeWithoutEvidence &&
    finalReplyOptionsCount === 0 &&
    !sawExecuteOperationEvidence &&
    looksLikeExecutionReplanningText(visibleText);
  if (rejectedExecuteReplanningText) {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    callbacks.onStatusChange("running");
    consecutiveNoToolCount += 1;
    logAgentEvent("execute_replanning_text_without_evidence", {
      iteration,
      consecutiveNoToolCount,
      workflowMode,
      turnIntent,
      runtimeIntent,
      visibleChars: visibleText.length,
    });

    if (consecutiveNoToolCount >= resolveExecuteNoToolCheckpointLimit(activeProfile)) {
      logAgentEvent("loop_stop", {
        reason: "execute_replanning_text_without_evidence",
        iteration,
        consecutiveNoToolCount,
      });
      callbacks.onNonActionableStop(
        buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution"),
        "no_action",
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }

    callbacks.appendMessage({
      role: "user",
      content: buildExecuteReplanningEvidencePrompt(MODEL_CONTROL_LANGUAGE, consecutiveNoToolCount),
    });
    return finish("continue");
  }

  const shouldRecoverExecuteXmlText =
    shouldRecoverExecuteXmlTextWithoutAction({
      workflowMode,
      turnIntent,
      runtimeIntent,
      forceXmlTools,
      availableToolCount: availableToolNames.size,
      toolCallCount: effectiveToolCallCount,
      replyOptionCount: shouldPauseForUserChoice ? finalReplyOptionsCount : 0,
      sawExecuteOperationEvidence,
      visibleText,
    });
  if (shouldRecoverExecuteXmlText) {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    callbacks.onStatusChange("running");
    consecutiveNoToolCount += 1;
    logAgentEvent("execute_xml_text_without_action", {
      iteration,
      consecutiveNoToolCount,
      workflowMode,
      turnIntent,
      runtimeIntent,
      visibleChars: visibleText.length,
      availableToolCount: availableToolNames.size,
    });

    if (consecutiveNoToolCount >= resolveExecuteNoToolCheckpointLimit(activeProfile)) {
      logAgentEvent("loop_stop", {
        reason: "execute_xml_text_without_action",
        iteration,
        consecutiveNoToolCount,
      });
      callbacks.onNonActionableStop(
        buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution"),
        "no_action",
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }

    callbacks.appendMessage({
      role: "user",
      content: buildExecuteXmlTextActionRecoveryPrompt({
        language: MODEL_CONTROL_LANGUAGE,
        retryCount: consecutiveNoToolCount,
        availableTools: Array.from(availableToolNames),
      }),
    });
    return finish("continue");
  }

  return finish("none");
}
