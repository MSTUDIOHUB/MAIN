import { buildExecuteNoActionPauseMessage } from "../../orchestrator/agentRecovery";
import type { MainModeKey } from "../../mainModes";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import {
  buildMissingToolCallContinuationPrompt,
  buildTruncatedPlanContinuationPrompt,
  resolveMissingToolCallRepromptKind,
  type MissingToolCallRepromptKind,
} from "../../missingToolCallReprompt";
import {
  summarizeRepeatedPlanTargetsFromToolActivity,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import {
  buildHiddenThoughtOnlyContinuationPrompt,
  buildNonActionableStopMessage,
  isPlanArtifactPath,
  logAgentEvent,
} from "../../orchestrator";
import type { OrchestratorCallbacks } from "../types";
import {
  applyExecuteNoToolStrategyPivot,
  isExecuteRuntimeRequiringEvidence,
  resolveExecuteNoToolCheckpointLimit,
  resolveExecuteNoToolStrategyAtBoundary,
  resolveProviderNeutralExecuteNoToolCheckpointLimit,
} from "./executeNoToolRecovery";

export type MissingToolNoToolRecoveryResult = {
  status: "none" | "continue" | "stopped";
  consecutiveNoToolCount: number;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
};

export function resolveMissingToolNoToolKind(input: {
  workflowMode: "chat" | "edit" | "plan";
  visibleText: string;
  mainModeKey?: MainModeKey;
  compactedProseCodeDump: boolean;
  wasTruncated: boolean;
  normalizedFinishReason?: string | null;
  normalizedToolCallCount: number;
  recentSuccessfulProjectWrite?: {
    name?: string | null;
    target?: string | null;
  } | null;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
}): {
  missingToolCallRepromptKind: MissingToolCallRepromptKind;
  effectiveMissingToolKind: MissingToolCallRepromptKind;
} {
  const truncatedWithoutToolCall = input.wasTruncated && input.workflowMode !== "chat";
  const missingToolCallRepromptKind: MissingToolCallRepromptKind =
    input.compactedProseCodeDump || truncatedWithoutToolCall
      ? "generic"
      : resolveMissingToolCallRepromptKind({
          workflowMode: input.workflowMode,
          visibleText: input.visibleText,
          mainModeKey: input.mainModeKey,
          recentWrite: input.recentSuccessfulProjectWrite
            ? {
                lastSuccessfulToolName: input.recentSuccessfulProjectWrite.name,
                lastSuccessfulTargetPath: input.recentSuccessfulProjectWrite.target,
                lastSuccessfulTargetOutsidePlan: !isPlanArtifactPath(input.recentSuccessfulProjectWrite.target || ""),
                recoveringFromEmptyAssistantReply: input.recoveringFromEmptyAssistantReplyAfterWrite,
              }
            : {
                recoveringFromEmptyAssistantReply: input.recoveringFromEmptyAssistantReplyAfterWrite,
              },
        });
  const isTruncatedReasoningNoTool =
    input.normalizedFinishReason === "length" && input.normalizedToolCallCount === 0;
  const effectiveMissingToolKind: MissingToolCallRepromptKind = isTruncatedReasoningNoTool
    ? "truncated_reasoning_bridge"
    : missingToolCallRepromptKind;

  return {
    missingToolCallRepromptKind,
    effectiveMissingToolKind,
  };
}

export function handleMissingToolNoToolRecovery(input: {
  callbacks: OrchestratorCallbacks;
  activeProfile: string;
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  forceXmlTools: boolean;
  mainModeKey?: MainModeKey;
  hasMeaningfulVisibleText: boolean;
  compactedProseCodeDump: boolean;
  wasTruncated: boolean;
  normalizedFinishReason?: string | null;
  normalizedToolCallCount: number;
  visibleText: string;
  visibleFallbackText: string;
  assistantMsgId: string;
  hiddenThoughtOnlyNoToolStop: boolean;
  recentSuccessfulProjectWrite?: {
    name?: string | null;
    target?: string | null;
  } | null;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
  recentToolActivity: PlanToolActivitySummary[];
  sawExecuteOperationEvidence: boolean;
  consecutiveNoToolCount: number;
}): MissingToolNoToolRecoveryResult {
  const {
    callbacks,
    activeProfile,
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    forceXmlTools,
    mainModeKey,
    hasMeaningfulVisibleText,
    compactedProseCodeDump,
    wasTruncated,
    normalizedFinishReason,
    normalizedToolCallCount,
    visibleText,
    visibleFallbackText,
    assistantMsgId,
    hiddenThoughtOnlyNoToolStop,
    recentSuccessfulProjectWrite,
    recentToolActivity,
    sawExecuteOperationEvidence,
  } = input;
  let consecutiveNoToolCount = input.consecutiveNoToolCount;
  let recoveringFromEmptyAssistantReplyAfterWrite = input.recoveringFromEmptyAssistantReplyAfterWrite;
  const finish = (status: MissingToolNoToolRecoveryResult["status"]): MissingToolNoToolRecoveryResult => ({
    status,
    consecutiveNoToolCount,
    recoveringFromEmptyAssistantReplyAfterWrite,
  });

  const { missingToolCallRepromptKind, effectiveMissingToolKind } = resolveMissingToolNoToolKind({
    workflowMode,
    visibleText,
    mainModeKey,
    compactedProseCodeDump,
    wasTruncated,
    normalizedFinishReason,
    normalizedToolCallCount,
    recentSuccessfulProjectWrite,
    recoveringFromEmptyAssistantReplyAfterWrite,
  });

  const shouldRepromptForMissingToolCall =
    (!hasMeaningfulVisibleText && workflowMode !== "chat") ||
    effectiveMissingToolKind !== "none" ||
    hiddenThoughtOnlyNoToolStop;

  if (!shouldRepromptForMissingToolCall) {
    return finish("none");
  }

  callbacks.onStatusChange("running");
  consecutiveNoToolCount += 1;
  if (!hasMeaningfulVisibleText) {
    callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
  }
  logAgentEvent("missing_tool_reprompt", {
    iteration,
    kind: hiddenThoughtOnlyNoToolStop
      ? "hidden_thought_only"
      : effectiveMissingToolKind,
    consecutiveNoToolCount,
    visibleChars: visibleText.length,
    preservedVisibleText: hasMeaningfulVisibleText,
  });

  const isExecuteRuntime = isExecuteRuntimeRequiringEvidence({
    workflowMode,
    turnIntent,
    runtimeIntent,
  });
  const checkpointLimit = isExecuteRuntime
    ? resolveProviderNeutralExecuteNoToolCheckpointLimit()
    : resolveExecuteNoToolCheckpointLimit(activeProfile);
  if (consecutiveNoToolCount >= checkpointLimit) {
    if (isExecuteRuntime) {
      const strategyDecision = resolveExecuteNoToolStrategyAtBoundary({
        callbacks,
        consecutiveNoToolCount,
        checkpointLimit,
        cause: hiddenThoughtOnlyNoToolStop
          ? "hidden_thought_only"
          : effectiveMissingToolKind,
      });
      if (strategyDecision.action === "continue_with_pivot") {
        applyExecuteNoToolStrategyPivot({
          callbacks,
          decision: strategyDecision,
          assistantMsgId,
          iteration,
          cause: hiddenThoughtOnlyNoToolStop
            ? "hidden_thought_only"
            : effectiveMissingToolKind,
          runtimeAlreadyPrepared: true,
        });
        return finish("continue");
      }
    }
    if (
      isExecuteRuntime &&
      recentToolActivity.length >= 3 &&
      !sawExecuteOperationEvidence
    ) {
      const repeatedTargets = summarizeRepeatedPlanTargetsFromToolActivity(recentToolActivity);
      const pauseMessage = buildExecuteNoActionPauseMessage({
        language: callbacks.getPreferredLanguage(),
        recentToolActivity,
        visibleText: visibleFallbackText,
      });
      logAgentEvent("loop_stop", {
        reason: "execute_read_only_no_action_checkpoint",
        iteration,
        consecutiveNoToolCount,
        recentToolActivity: recentToolActivity.length,
        repeatedTargets,
      });
      callbacks.onNonActionableStop(
        pauseMessage,
        "no_action",
        {
          repeatedTargets,
          recoveryReason: "execute_read_only_no_action_checkpoint",
          nextStep: callbacks.getPreferredLanguage() === "zh"
            ? "复用已读上下文，转向写入/验证/明确阻塞"
            : "reuse read context and pivot to write/verify/a concrete blocker",
        },
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }

    logAgentEvent("loop_stop", {
      reason: "missing_tool_reprompt_limit",
      iteration,
      consecutiveNoToolCount,
      kind: hiddenThoughtOnlyNoToolStop
        ? "hidden_thought_only"
        : effectiveMissingToolKind,
    });
    callbacks.onNonActionableStop(
      buildNonActionableStopMessage(
        callbacks.getPreferredLanguage(),
        hiddenThoughtOnlyNoToolStop ? "no_output" : "missing_tool_loop",
      ),
      hiddenThoughtOnlyNoToolStop ? "no_output" : "missing_tool_loop",
    );
    callbacks.onStatusChange("idle");
    return finish("stopped");
  }

  callbacks.appendMessage({
    role: "user",
    content: hiddenThoughtOnlyNoToolStop
      ? buildHiddenThoughtOnlyContinuationPrompt(MODEL_CONTROL_LANGUAGE, consecutiveNoToolCount)
      : workflowMode === "plan" && effectiveMissingToolKind === "truncated_reasoning_bridge"
      ? buildTruncatedPlanContinuationPrompt(MODEL_CONTROL_LANGUAGE)
      : buildMissingToolCallContinuationPrompt(
          effectiveMissingToolKind === "none" ? "generic" : effectiveMissingToolKind,
          MODEL_CONTROL_LANGUAGE,
          consecutiveNoToolCount,
          forceXmlTools,
        ),
  });
  if (missingToolCallRepromptKind === "post_write_verify") {
    recoveringFromEmptyAssistantReplyAfterWrite = true;
  }

  return finish("continue");
}
