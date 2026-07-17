import {
  buildExecuteXmlTextActionRecoveryPrompt,
  shouldRecoverExecuteXmlTextWithoutAction,
} from "../../orchestrator/agentRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import {
  buildNonActionableStopMessage,
  logAgentEvent,
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
  protocolViolation?:
    | "required_tool_call_missing"
    | "required_function_call_mismatch"
    | "required_tool_call_not_available";
  /** Active evidence recovery only needs transport correction here. */
  protocolViolationOnly?: boolean;
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

  const isExecuteRuntime = isExecuteRuntimeRequiringEvidence({
    workflowMode,
    turnIntent,
    runtimeIntent,
  });
  if (
    isExecuteRuntime &&
    (input.protocolViolation === "required_tool_call_missing" ||
      input.protocolViolation === "required_function_call_mismatch" ||
      input.protocolViolation === "required_tool_call_not_available")
  ) {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
    callbacks.onStatusChange("running");
    consecutiveNoToolCount += 1;
    logAgentEvent(
      input.protocolViolation === "required_function_call_mismatch"
        ? "execute_required_function_call_mismatch"
        : input.protocolViolation === "required_tool_call_not_available"
        ? "execute_required_tool_call_not_available"
        : "execute_required_tool_call_missing",
      {
        iteration,
        consecutiveNoToolCount,
        workflowMode,
        turnIntent,
        runtimeIntent,
        availableTools: Array.from(availableToolNames),
        protocolViolation: input.protocolViolation,
      },
    );
    if (consecutiveNoToolCount >= resolveExecuteNoToolCheckpointLimit(activeProfile)) {
      callbacks.onNonActionableStop(
        buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution"),
        "missing_tool_loop",
        {
          phase: "paused",
          recoveryReason: "required_tool_call_protocol_violation",
          nextStep: input.protocolViolation === "required_function_call_mismatch"
            ? callbacks.getPreferredLanguage() === "zh"
              ? "模型在具名工具阶段连续返回了其他工具；这些调用未执行。请从当前证据检查点恢复并调用契约指定的工具。"
              : "The model repeatedly returned a different tool during a named-tool phase; those calls were not executed. Resume from the evidence checkpoint and call the contracted tool."
            : input.protocolViolation === "required_tool_call_not_available"
              ? callbacks.getPreferredLanguage() === "zh"
                ? "模型连续返回当前契约未开放的工具；这些调用未执行。请从当前检查点选择工具面中实际可用的能力。"
                : "The model repeatedly returned tools outside the active contract; those calls were not executed. Resume from the checkpoint and choose an exposed capability."
            : callbacks.getPreferredLanguage() === "zh"
              ? "模型在 required 工具阶段连续返回零工具调用；从当前证据检查点恢复，不能把 stop 当作完成。"
              : "The model repeatedly returned no tool call while tool use was required; resume from the evidence checkpoint instead of treating stop as completion.",
        },
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }
    callbacks.appendMessage({
      role: "user",
      content: input.protocolViolation === "required_function_call_mismatch"
        ? "TOOL_PROTOCOL_RECOVERY: The runtime required one specific function, but the provider returned a different tool. The mismatched call was not executed. Do not restart analysis; call exactly the named tool currently exposed by the active recovery contract."
        : input.protocolViolation === "required_tool_call_not_available"
        ? "TOOL_PROTOCOL_RECOVERY: The provider returned a tool outside the active recovery surface. That call was not executed. Do not restart analysis; call one tool that is actually exposed by the current capability contract."
        : "TOOL_PROTOCOL_RECOVERY: The previous response violated required tool use by returning no tool call. Do not restart analysis or claim completion; call exactly one currently available tool that closes the active evidence gap.",
    });
    return finish("continue");
  }
  if (input.protocolViolationOnly) return finish("none");

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
