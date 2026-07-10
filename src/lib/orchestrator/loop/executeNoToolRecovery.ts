import {
  buildExecuteXmlTextActionRecoveryPrompt,
  shouldRecoverExecuteXmlTextWithoutAction,
} from "../../orchestrator/agentRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
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
      content: buildExecuteCompletionEvidencePrompt(callbacks.getPreferredLanguage(), consecutiveNoToolCount),
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
      content: buildExecuteReplanningEvidencePrompt(callbacks.getPreferredLanguage(), consecutiveNoToolCount),
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
        language: callbacks.getPreferredLanguage(),
        retryCount: consecutiveNoToolCount,
        availableTools: Array.from(availableToolNames),
      }),
    });
    return finish("continue");
  }

  return finish("none");
}
