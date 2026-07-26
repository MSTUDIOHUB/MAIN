import {
  buildExecuteXmlTextActionRecoveryPrompt,
  shouldRecoverExecuteXmlTextWithoutAction,
} from "../../orchestrator/agentRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import {
  EXECUTE_NO_PROGRESS_STRATEGY_PIVOTS,
  resolveExecuteNoProgressStrategyDecision,
  type ExecuteNoProgressStrategyDecision,
} from "../../executeRecoveryTools";
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

export function resolveExecuteNoToolCheckpointLimit(_activeProfile: string): number {
  return MAX_NO_ACTION_RETRIES;
}

/** Execution recovery budgets are capability-driven, never provider/profile-driven. */
export function resolveProviderNeutralExecuteNoToolCheckpointLimit(): number {
  return resolveExecuteNoToolCheckpointLimit("");
}

export function resolveExecuteNoToolStrategyAtBoundary(input: {
  callbacks: OrchestratorCallbacks;
  consecutiveNoToolCount: number;
  checkpointLimit: number;
  availableToolNames?: Iterable<string> | null;
  cause: string;
}): ExecuteNoProgressStrategyDecision {
  const recoveryState = input.callbacks.getForcedExecuteRecoveryState?.() || null;
  const planTaskId = recoveryState?.decisionCheckpoint?.planTaskId || null;
  const planTasks = input.callbacks.getPlanTasks?.() || [];
  const checkpointTask = planTaskId
    ? planTasks.find((task) => String(task.id || "") === planTaskId) || null
    : null;
  const inProgressTasks = planTasks.filter((task) => task.status === "in_progress");
  const currentTask = checkpointTask || (inProgressTasks.length === 1 ? inProgressTasks[0] : null);
  const attemptedCount = Math.max(
    0,
    input.consecutiveNoToolCount - input.checkpointLimit,
  );
  const countedAttempts = EXECUTE_NO_PROGRESS_STRATEGY_PIVOTS.slice(0, attemptedCount);
  const checkpointAttempts = recoveryState?.decisionCheckpoint?.noProgressStrategyPivots || [];
  return resolveExecuteNoProgressStrategyDecision({
    attemptedStrategies: [...checkpointAttempts, ...countedAttempts],
    currentTaskId: planTaskId || currentTask?.id || null,
    expectedTarget: recoveryState?.expectedTarget || null,
    unfinishedObjective: currentTask?.text || null,
    availableToolNames: input.availableToolNames,
    cause: input.cause,
    language: input.callbacks.getPreferredLanguage(),
  });
}

export function applyExecuteNoToolStrategyPivot(input: {
  callbacks: OrchestratorCallbacks;
  decision: Extract<ExecuteNoProgressStrategyDecision, { action: "continue_with_pivot" }>;
  assistantMsgId?: string;
  iteration: number;
  cause: string;
  runtimeAlreadyPrepared?: boolean;
}): void {
  if (!input.runtimeAlreadyPrepared) {
    if (input.assistantMsgId) {
      input.callbacks.onStreamToken("__ESCALATION_RESET__:", input.assistantMsgId);
    }
    input.callbacks.onStatusChange("running");
  }
  input.callbacks.appendMessage({ role: "user", content: input.decision.prompt });
  logAgentEvent("execute_no_progress_strategy_pivot", {
    iteration: input.iteration,
    cause: input.cause,
    strategy: input.decision.strategy,
    attemptedStrategies: input.decision.attemptedStrategies,
  });
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
  protocolActualTools?: string[];
  protocolExpectedTool?: string;
  /** Active evidence recovery owns the capability and treats XML prose as a protocol miss. */
  protocolViolationOnly?: boolean;
  assistantMsgId: string;
  consecutiveNoToolCount: number;
  onStrategyPivot?: (
    decision: Extract<ExecuteNoProgressStrategyDecision, { action: "continue_with_pivot" }>,
  ) => boolean;
}): ExecuteNoToolRecoveryResult {
  const {
    callbacks,
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
    const availableTools = Array.from(availableToolNames);
    const actualTools = Array.from(new Set(
      (input.protocolActualTools || [])
        .map((name) => String(name || "").trim())
        .filter(Boolean),
    ));
    const expectedTool = String(input.protocolExpectedTool || "").trim();
    logAgentEvent("execute_required_tool_protocol_repair", {
      iteration,
      workflowMode,
      turnIntent,
      runtimeIntent,
      protocolViolation: input.protocolViolation,
      actualTools,
      expectedTool: expectedTool || null,
      availableTools,
      transport: forceXmlTools ? "xml" : "native",
      action: "retry_active_transport",
      providerLaneFallbackChanged: false,
      providerNeutral: true,
    });
    const protocolCheckpointLimit = resolveProviderNeutralExecuteNoToolCheckpointLimit();
    if (consecutiveNoToolCount >= protocolCheckpointLimit) {
      const strategyDecision = resolveExecuteNoToolStrategyAtBoundary({
        callbacks,
        consecutiveNoToolCount,
        checkpointLimit: protocolCheckpointLimit,
        availableToolNames,
        cause: input.protocolViolation,
      });
      if (strategyDecision.action === "continue_with_pivot") {
        const runtimeContractChanged = input.onStrategyPivot?.(strategyDecision) === true;
        applyExecuteNoToolStrategyPivot({
          callbacks,
          decision: strategyDecision,
          assistantMsgId,
          iteration,
          cause: input.protocolViolation,
          runtimeAlreadyPrepared: true,
        });
        if (runtimeContractChanged) {
          logAgentEvent("execute_no_progress_source_window_reopened", {
            iteration,
            cause: input.protocolViolation,
            strategy: strategyDecision.strategy,
            providerNeutral: true,
          });
        }
        return finish("continue");
      }
      const stoppedAfterDurableChange = sawExecuteOperationEvidence;
      const stopMessage = stoppedAfterDurableChange
        ? callbacks.getPreferredLanguage() === "zh"
          ? "执行已暂停：工作区已经产生真实变更，但模型未能完成后续工具协议或验证。现有变更和检查点均已保留；这不是“未执行任何操作”。"
          : "Execution paused after real workspace changes because the model could not complete the follow-up tool protocol or validation. Existing changes and the checkpoint were preserved; this is not a no-action outcome."
        : buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution");
      const nextStep = input.protocolViolation === "required_function_call_mismatch"
        ? callbacks.getPreferredLanguage() === "zh"
          ? "模型在具名工具阶段连续返回了其他工具；这些调用未执行。请从当前证据检查点恢复并调用契约指定的工具。"
          : "The model repeatedly returned a different tool during a named-tool phase; those calls were not executed. Resume from the evidence checkpoint and call the contracted tool."
        : input.protocolViolation === "required_tool_call_not_available"
          ? callbacks.getPreferredLanguage() === "zh"
            ? "模型连续返回当前契约未开放的工具；这些调用未执行。请从当前检查点选择工具面中实际可用的能力。"
            : "The model repeatedly returned tools outside the active contract; those calls were not executed. Resume from the checkpoint and choose an exposed capability."
          : callbacks.getPreferredLanguage() === "zh"
            ? "模型在 required 工具阶段连续返回零工具调用；从当前证据检查点恢复，不能把 stop 当作完成。"
            : "The model repeatedly returned no tool call while tool use was required; resume from the evidence checkpoint instead of treating stop as completion.";
      callbacks.onNonActionableStop(
        stopMessage,
        "missing_tool_loop",
        {
          phase: "paused",
          recoveryReason: stoppedAfterDurableChange
            ? "required_tool_call_protocol_violation_after_change"
            : "required_tool_call_protocol_violation",
          nextStep,
        },
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }
    callbacks.appendMessage({
      role: "user",
      content: [
        input.protocolViolation === "required_function_call_mismatch"
          ? "TOOL_PROTOCOL_RECOVERY: The runtime required one specific function, but the model returned a different tool. The mismatched call was not executed."
          : input.protocolViolation === "required_tool_call_not_available"
          ? "TOOL_PROTOCOL_RECOVERY: The model returned a tool outside the active recovery surface. That call was not executed."
          : "TOOL_PROTOCOL_RECOVERY: The previous response returned no tool call while one action was required.",
        actualTools.length > 0
          ? `Rejected historical/out-of-surface tools: ${actualTools.join(", ")}.`
          : "",
        expectedTool ? `The required function is: ${expectedTool}.` : "",
        `The exact currently callable surface is: ${availableTools.join(", ") || "(active recovery contract)"}.`,
        forceXmlTools
          ? "Keep the active XML transport and emit exactly one formal tool envelope from that surface."
          : "Keep native function calling and call exactly one function from that surface; do not copy a tool name from earlier history.",
        "Do not restart analysis, emit a progress paragraph, or claim completion before the tool result.",
      ].filter(Boolean).join("\n"),
    });
    return finish("continue");
  }
  const activeRecoveryXmlTextWithoutAction = Boolean(
    input.protocolViolationOnly &&
    isExecuteRuntime &&
    forceXmlTools &&
    availableToolNames.size > 0 &&
    effectiveToolCallCount === 0 &&
    (!shouldPauseForUserChoice || finalReplyOptionsCount === 0) &&
    visibleText.replace(/\s+/g, " ").trim(),
  );
  const shouldRecoverExecuteXmlText =
    activeRecoveryXmlTextWithoutAction ||
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
      activeRecoveryContract: activeRecoveryXmlTextWithoutAction,
    });

    const executeCheckpointLimit = resolveProviderNeutralExecuteNoToolCheckpointLimit();
    if (consecutiveNoToolCount >= executeCheckpointLimit) {
      const strategyDecision = resolveExecuteNoToolStrategyAtBoundary({
        callbacks,
        consecutiveNoToolCount,
        checkpointLimit: executeCheckpointLimit,
        availableToolNames,
        cause: "execute_xml_text_without_action",
      });
      if (strategyDecision.action === "continue_with_pivot") {
        const runtimeContractChanged = input.onStrategyPivot?.(strategyDecision) === true;
        applyExecuteNoToolStrategyPivot({
          callbacks,
          decision: strategyDecision,
          assistantMsgId,
          iteration,
          cause: "execute_xml_text_without_action",
          runtimeAlreadyPrepared: true,
        });
        if (runtimeContractChanged) {
          logAgentEvent("execute_no_progress_source_window_reopened", {
            iteration,
            cause: "execute_xml_text_without_action",
            strategy: strategyDecision.strategy,
            providerNeutral: true,
          });
        }
        return finish("continue");
      }
      const stoppedAfterDurableChange = sawExecuteOperationEvidence;
      const stopMessage = stoppedAfterDurableChange
        ? callbacks.getPreferredLanguage() === "zh"
          ? "执行已暂停：工作区已有真实变更，但模型连续没有产生可执行的后续动作。现有变更已保留，可从当前检查点恢复。"
          : "Execution paused after real workspace changes because the model repeatedly produced no executable follow-up action. Existing changes were preserved and the run can resume from this checkpoint."
        : buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution");
      const nextStep = callbacks.getPreferredLanguage() === "zh"
        ? "从保留的检查点继续当前阶段的真实工具动作，不接受纯文本代替执行。"
        : "Continue the current phase from the retained checkpoint with a real tool action; prose cannot substitute for execution.";
      logAgentEvent("loop_stop", {
        reason: "execute_xml_text_without_action",
        iteration,
        consecutiveNoToolCount,
      });
      callbacks.onNonActionableStop(
        stopMessage,
        "no_action",
        {
          phase: "paused",
          recoveryReason: stoppedAfterDurableChange
            ? "execute_no_action_after_change"
            : "execute_xml_text_without_action",
          nextStep,
        },
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

  if (input.protocolViolationOnly) return finish("none");

  return finish("none");
}
