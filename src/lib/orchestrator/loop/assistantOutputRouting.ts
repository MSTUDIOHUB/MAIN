import { containsToolUseBlock } from "../../orchestrator/agentRecovery";
import {
  hasExecutableProposalReplyOptions,
  hasOnlyNonBlockingPlanReplyOptions,
  hasOnlyReadOnlyPermissionReplyOptions,
  shouldPauseForReplyOptions,
} from "../../replyOptions";
import {
  isPlanRuntimeFinalizationPhase,
  resolvePlanSuppressedToolRecovery,
} from "../../planRuntime";
import type { LegacyWorkflowMode } from "../../runIntent";
import type { PlanRuntimePhase, ReplyOption } from "../../workflowModels";

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
  hasSubstantivePlanAssistantText?: boolean;
}): boolean {
  return input.suppressPlanContinuationReplyOptions &&
    input.toolCallCount === 0 &&
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    !input.hasSubstantivePlanAssistantText;
}

export function resolveNonBlockingPlanChoiceLoop(input: {
  consecutiveNoToolCount: number;
  maxAutoContinues: number;
}): {
  action: "continue" | "force_finalize";
  nextConsecutiveNoToolCount: number;
} {
  const nextConsecutiveNoToolCount = Math.max(0, input.consecutiveNoToolCount) + 1;
  const maxAutoContinues = Math.max(1, input.maxAutoContinues);
  return {
    action: nextConsecutiveNoToolCount >= maxAutoContinues ? "force_finalize" : "continue",
    nextConsecutiveNoToolCount,
  };
}

/**
 * A plan can enter its text-only drafting phase with a sufficient evidence
 * bundle, then discover that the model still needs one concrete fact.  Do not
 * continue by merely telling the model to call a tool: that would be
 * impossible while the tool surface is intentionally empty.  Instead, return
 * the bounded runtime transition that reopens the targeted-evidence phase.
 */
export function resolveClosedPlanReadOnlyContinuation(input: {
  suppressPlanContinuationReplyOptions: boolean;
  replyOptions: ReplyOption[];
  toolCallCount: number;
  workflowMode: LegacyWorkflowMode;
  isPlanApproved: boolean;
  availableToolCount: number;
  planRuntimePhase: PlanRuntimePhase;
  targetedRecoveryPasses: number;
}): {
  action: "none" | "targeted_evidence" | "defer";
  reason?: string;
} {
  if (!shouldAutoContinueNonBlockingPlanChoices(input)) {
    return { action: "none" };
  }
  if (
    input.availableToolCount > 0 ||
    !isPlanRuntimeFinalizationPhase(input.planRuntimePhase) ||
    !hasOnlyReadOnlyPermissionReplyOptions(input.replyOptions) &&
    !hasOnlyNonBlockingPlanReplyOptions(input.replyOptions)
  ) {
    return { action: "none" };
  }
  const recovery = resolvePlanSuppressedToolRecovery({
    workflowMode: input.workflowMode,
    isPlanApproved: input.isPlanApproved,
    // The runtime intentionally closed this finalization phase only after it
    // had frozen a usable evidence bundle.  A model request here gets one
    // bounded re-open, not the broader insufficient-evidence retry budget.
    evidenceReadiness: "ready_for_plan",
    targetedRecoveryPasses: input.targetedRecoveryPasses,
  });
  return recovery.action === "targeted_evidence"
    ? { action: "targeted_evidence", reason: recovery.reason }
    : { action: "defer", reason: recovery.reason };
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
