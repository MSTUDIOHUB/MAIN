import { containsToolNameParameterFallback } from "../../orchestrator/agentRecovery";
import {
  logAgentEvent,
  normalizeToolCallToExecute,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import type { StreamResult } from "../../streaming";
import type { TurnInputContextSignals } from "../../turnIntake";
import { generateId } from "../../utils";
import type { NormalizedStreamState } from "../../workflowModels";
import type { OrchestratorCallbacks, ToolCallToExecute } from "../types";
import type {
  AgentLoopRuntimeState,
} from "./turnPreparation";
import { processAssistantStreamResponse } from "./assistantResponseProcessing";
import type {
  ProviderReasoningForHistory,
} from "./assistantResponseProcessing";
import { handleEmptyResponseRecovery } from "./emptyResponseRecovery";
import { handleFinalTextOnlyToolCalls } from "./finalTextOnlyToolCallHandling";
import type {
  AgentLoopNoToolRuntimeState,
} from "./noToolRuntimeState";
import {
  applyEmptyResponseNoToolRuntimeState,
  applyReasoningDominatedNoToolRuntimeState,
  resetEmptyAndReasoningNoToolRuntimeState,
} from "./noToolRuntimeState";
import type {
  ApprovedPlanRecoveryRuntimeState,
} from "./approvedPlanRecoveryRuntime";
import {
  applyApprovedPlanActionOnlyRecoveryState,
} from "./approvedPlanRecoveryRuntime";
import type {
  AgentLoopRecoveryPromptRuntimeState,
} from "./recoveryPromptRuntimeState";
import {
  applyMalformedToolUseRecoveryPromptState,
} from "./recoveryPromptRuntimeState";
import type { PlanLoopRuntimeState } from "./planRuntimeState";
import {
  applyReasoningNoToolPlanRuntimeState,
} from "./planRuntimeState";
import { handleReasoningDominatedNoToolRecovery } from "./reasoningNoToolRecovery";
import type { TurnIterationContext } from "./turnIterationContext";

type SetPlanRuntimePhase = Parameters<typeof handleReasoningDominatedNoToolRecovery>[0]["setPlanRuntimePhase"];
type ActivateExecuteRecovery = Parameters<typeof handleReasoningDominatedNoToolRecovery>[0]["activateExecuteRecovery"];
type PauseForReviewablePlanArtifact = Parameters<typeof handleEmptyResponseRecovery>[0]["pauseForReviewablePlanArtifact"];
type TryClosePlanWithEvidence = Parameters<typeof handleEmptyResponseRecovery>[0]["tryClosePlanWithEvidence"];

type AssistantStreamPostProcessingBaseResult = {
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
};

export type AssistantStreamPostProcessingPhaseResult =
  | (AssistantStreamPostProcessingBaseResult & { status: "continue" })
  | (AssistantStreamPostProcessingBaseResult & { status: "stopped" })
  | (AssistantStreamPostProcessingBaseResult & {
      status: "completed";
      streamText: string;
      providerReasoningForHistory: ProviderReasoningForHistory;
      normalizedBase: NormalizedStreamState;
      normalized: NormalizedStreamState;
      effectiveToolCalls: ToolCallToExecute[];
    });

export async function handleAssistantStreamPostProcessingPhase(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: Pick<
    AgentLoopRuntimeState,
    | "config"
    | "settings"
    | "effectiveToolProtocol"
    | "reasoningPolicy"
    | "workflowMode"
    | "turnIntent"
    | "workspace"
  >;
  streamResult: StreamResult;
  iteration: number;
  iterationRequestStartedAt: number;
  runtimeIntent: ResolvedUserIntent;
  forceXmlTools: boolean;
  llmToolCount: number;
  managedMessageCount: number;
  currentMaxTokens: number | undefined;
  turnContext: Parameters<typeof processAssistantStreamResponse>[0]["turnContext"];
  assistantMsgId: string;
  effectiveMaxIterations: number;
  finalTextOnlyStep: boolean;
  chatFinalSynthesisActive: boolean;
  chatFinalSynthesisReason: string;
  repairExecutionRequestInChat: boolean;
  noProgressBatchRepeatCount: number;
  turnInputContextSignals: TurnInputContextSignals;
  recentPlanToolActivity: PlanToolActivitySummary[];
  recentToolActivity: PlanToolActivitySummary[];
  lastAssistantTextForCheckpoint: string;
  recentSuccessfulProjectWrite: Parameters<typeof handleEmptyResponseRecovery>[0]["recentSuccessfulProjectWrite"];
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId">;
  emitTurnEvent: Parameters<typeof handleFinalTextOnlyToolCalls>[0]["emitTurnEvent"];
  emitTurnCompletedEvent: Parameters<typeof handleFinalTextOnlyToolCalls>[0]["emitTurnCompletedEvent"];
  setPlanRuntimePhase: SetPlanRuntimePhase;
  activateExecuteRecovery: ActivateExecuteRecovery;
  pauseForReviewablePlanArtifact: PauseForReviewablePlanArtifact;
  tryClosePlanWithEvidence: TryClosePlanWithEvidence;
}): Promise<AssistantStreamPostProcessingPhaseResult> {
  let noToolRuntimeState = input.noToolRuntimeState;
  let planRuntimeState = input.planRuntimeState;
  let approvedPlanRecoveryState = input.approvedPlanRecoveryState;
  let recoveryPromptState = input.recoveryPromptState;

  const {
    callbacks,
    runtimeState,
    iteration,
    runtimeIntent,
    streamResult,
  } = input;
  const {
    config,
    settings,
    effectiveToolProtocol,
    reasoningPolicy,
    workflowMode,
    turnIntent,
    workspace,
  } = runtimeState;

  const assistantResponse = processAssistantStreamResponse({
    streamResult,
    iteration,
    iterationRequestStartedAt: input.iterationRequestStartedAt,
    workflowMode,
    turnIntent,
    runtimeIntent,
    activeProfile: config.activeProfile,
    provider: settings.provider,
    model: settings.model,
    contextLimit: settings.contextLimit,
    effectiveToolProtocol,
    forceXmlTools: input.forceXmlTools,
    reasoningDisplay: reasoningPolicy.display,
    llmToolCount: input.llmToolCount,
    managedMessageCount: input.managedMessageCount,
    currentMaxTokens: input.currentMaxTokens,
    turnContext: input.turnContext,
  });
  const {
    streamText,
    providerReasoningForHistory,
    normalizedBase,
    normalized,
  } = assistantResponse;

  const reasoningDominatedNoToolRecovery = handleReasoningDominatedNoToolRecovery({
    callbacks,
    workflowMode,
    turnIntent,
    runtimeIntent,
    iteration,
    streamResult,
    normalizedToolCallCount: normalized.toolCalls.length,
    normalizedReplyOptionCount: normalized.replyOptions.length,
    assistantMsgId: input.assistantMsgId,
    turnInputContextSignals: input.turnInputContextSignals,
    recentPlanToolActivity: input.recentPlanToolActivity,
    lastAssistantTextForCheckpoint: input.lastAssistantTextForCheckpoint,
    ...planRuntimeState,
    consecutiveReasoningDominatedCount:
      noToolRuntimeState.consecutiveReasoningDominatedCount,
    ...approvedPlanRecoveryState,
    setPlanRuntimePhase: input.setPlanRuntimePhase,
    activateExecuteRecovery: input.activateExecuteRecovery,
  });
  noToolRuntimeState = applyReasoningDominatedNoToolRuntimeState(
    noToolRuntimeState,
    reasoningDominatedNoToolRecovery,
  );
  planRuntimeState = applyReasoningNoToolPlanRuntimeState(
    planRuntimeState,
    reasoningDominatedNoToolRecovery,
  );
  approvedPlanRecoveryState = applyApprovedPlanActionOnlyRecoveryState(
    approvedPlanRecoveryState,
    reasoningDominatedNoToolRecovery,
  );
  if (reasoningDominatedNoToolRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (reasoningDominatedNoToolRecovery.status === "continue") {
    return finish("continue");
  }

  const emptyResponseRecovery = await handleEmptyResponseRecovery({
    callbacks,
    activeProfile: config.activeProfile,
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    streamText,
    normalized,
    normalizedBaseToolCallCount: normalizedBase.toolCalls.length,
    recentToolActivity: input.recentToolActivity,
    recentSuccessfulProjectWrite: input.recentSuccessfulProjectWrite,
    consecutiveEmptyResponseCount:
      noToolRuntimeState.consecutiveEmptyResponseCount,
    emptyResponseCountThisTurn: noToolRuntimeState.emptyResponseCountThisTurn,
    usedMalformedToolUseRecoveryPrompt:
      recoveryPromptState.usedMalformedToolUseRecoveryPrompt,
    recoveringFromEmptyAssistantReplyAfterWrite:
      noToolRuntimeState.recoveringFromEmptyAssistantReplyAfterWrite,
    pauseForReviewablePlanArtifact: input.pauseForReviewablePlanArtifact,
    tryClosePlanWithEvidence: input.tryClosePlanWithEvidence,
  });
  noToolRuntimeState = applyEmptyResponseNoToolRuntimeState(
    noToolRuntimeState,
    emptyResponseRecovery,
  );
  recoveryPromptState = applyMalformedToolUseRecoveryPromptState(
    recoveryPromptState,
    emptyResponseRecovery,
  );
  if (emptyResponseRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (emptyResponseRecovery.status === "continue") {
    return finish("continue");
  }
  noToolRuntimeState = resetEmptyAndReasoningNoToolRuntimeState(noToolRuntimeState);

  const effectiveToolCalls = normalized.toolCalls.map((call) => normalizeToolCallToExecute({
    id: call.id || `call_${generateId()}`,
    name: call.name,
    arguments: call.arguments,
  }, workspace));
  if (effectiveToolCalls.length > 0 && containsToolNameParameterFallback(streamText)) {
    const recoveredArgKeys = (() => {
      try {
        const parsedArgs = JSON.parse(effectiveToolCalls[0].arguments || "{}");
        return parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
          ? Object.keys(parsedArgs).sort()
          : [];
      } catch {
        return [];
      }
    })();
    logAgentEvent("tool_protocol_parse_recovered", {
      iteration,
      toolName: effectiveToolCalls[0].name,
      argumentKeys: recoveredArgKeys,
      workflowMode,
      turnIntent,
    });
  }

  const finalTextOnlyToolCallHandling = handleFinalTextOnlyToolCalls({
    callbacks,
    assistantMsgId: input.assistantMsgId,
    iteration,
    effectiveMaxIterations: input.effectiveMaxIterations,
    runtimeIntent,
    finalTextOnlyStep: input.finalTextOnlyStep,
    chatFinalSynthesisActive: input.chatFinalSynthesisActive,
    chatFinalSynthesisReason: input.chatFinalSynthesisReason,
    repairExecutionRequestInChat: input.repairExecutionRequestInChat,
    normalizedVisibleText: normalized.visibleText,
    effectiveToolCalls,
    recentToolActivity: input.recentToolActivity,
    noProgressBatchRepeatCount: input.noProgressBatchRepeatCount,
    providerReasoningForHistory,
    iterationContext: input.iterationContext,
    emitTurnEvent: input.emitTurnEvent,
    emitTurnCompletedEvent: input.emitTurnCompletedEvent,
  });
  if (finalTextOnlyToolCallHandling.status === "stopped") {
    return finish("stopped");
  }

  return {
    status: "completed",
    ...baseResult(),
    streamText,
    providerReasoningForHistory,
    normalizedBase,
    normalized,
    effectiveToolCalls,
  };

  function finish<TStatus extends "continue" | "stopped">(
    status: TStatus,
  ): AssistantStreamPostProcessingBaseResult & { status: TStatus } {
    return {
      status,
      ...baseResult(),
    };
  }

  function baseResult(): AssistantStreamPostProcessingBaseResult {
    return {
      noToolRuntimeState,
      planRuntimeState,
      approvedPlanRecoveryState,
      recoveryPromptState,
    };
  }
}
