import { containsToolUseBlock } from "../../orchestrator/agentRecovery";
import { hasExecutableProposalReplyOptions, shouldPauseForReplyOptions } from "../../replyOptions";
import type { LegacyWorkflowMode } from "../../runIntent";
import type { ReplyOption } from "../../workflowModels";

export interface ToolProtocolStreamClearDecision {
  shouldClear: boolean;
  preserveScopedPlanVisibleText: boolean;
}

export function resolveToolProtocolStreamClearDecision(input: {
  toolCallCount: number;
  streamText: string;
  workflowMode: LegacyWorkflowMode;
  isPlanApproved: boolean;
  visibleAssistantText: string;
}): ToolProtocolStreamClearDecision {
  if (input.toolCallCount === 0 || !containsToolUseBlock(input.streamText)) {
    return { shouldClear: false, preserveScopedPlanVisibleText: false };
  }

  return {
    shouldClear: true,
    preserveScopedPlanVisibleText:
      input.workflowMode === "plan" &&
      !input.isPlanApproved &&
      input.visibleAssistantText.trim().length > 0,
  };
}

export function shouldTrackAssistantCheckpoint(input: {
  historyAssistantText: string;
  runtimeNarrationInjected: boolean;
}): boolean {
  return input.historyAssistantText.trim().length > 0 && !input.runtimeNarrationInjected;
}

export function shouldAutoContinueNonBlockingPlanChoices(input: {
  suppressPlanContinuationReplyOptions: boolean;
  toolCallCount: number;
  workflowMode: LegacyWorkflowMode;
  isPlanApproved: boolean;
}): boolean {
  return input.suppressPlanContinuationReplyOptions &&
    input.toolCallCount === 0 &&
    input.workflowMode === "plan" &&
    !input.isPlanApproved;
}

export function resolveAssistantReplyOptionRouting(input: {
  rawFinalReplyOptions: ReplyOption[];
  finalReplyOptions: ReplyOption[];
  toolCallCount: number;
  workflowMode: LegacyWorkflowMode;
  hasStructuredProposal: boolean;
  hasReadyPlanArtifacts: boolean;
  isPlanApproved: boolean;
  forcePause: boolean;
  finishReason?: string | null;
}): {
  hasExecutablePlanProposalOptions: boolean;
  shouldPauseForUserChoice: boolean;
} {
  const finishReason =
    input.finishReason === "stop" ||
    input.finishReason === "length" ||
    input.finishReason === "tool_calls"
      ? input.finishReason
      : null;

  return {
    hasExecutablePlanProposalOptions:
      input.workflowMode === "plan" &&
      !input.isPlanApproved &&
      hasExecutableProposalReplyOptions(input.rawFinalReplyOptions),
    shouldPauseForUserChoice: shouldPauseForReplyOptions({
      replyOptions: input.finalReplyOptions,
      toolCallCount: input.toolCallCount,
      workflowMode: input.workflowMode,
      hasStructuredProposal: input.hasStructuredProposal,
      hasReadyPlanArtifacts: input.hasReadyPlanArtifacts,
      isPlanApproved: input.isPlanApproved,
      forcePause: input.forcePause,
      finishReason,
    }),
  };
}

export function isHiddenThoughtOnlyNoToolStop(input: {
  toolCallCount: number;
  replyOptionCount: number;
  hasMeaningfulVisibleText: boolean;
  hiddenThought: string;
}): boolean {
  return input.toolCallCount === 0 &&
    input.replyOptionCount === 0 &&
    !input.hasMeaningfulVisibleText &&
    input.hiddenThought.trim().length > 0;
}
