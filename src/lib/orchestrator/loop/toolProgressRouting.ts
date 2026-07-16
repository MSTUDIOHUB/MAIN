import { isPreApprovalPlanDraftWrite, parseToolCallArguments } from "../../orchestrator";
import type { LegacyWorkflowMode } from "../../runIntent";
import { looksLikeSubstantivePlanAssistantText } from "../../workflowModels";
import type { ToolCallToExecute } from "../types";

export interface ToolProgressRoutingDecision {
  unsupportedToolCalls: ToolCallToExecute[];
  progressEligibleToolCalls: ToolCallToExecute[];
  hasSuppressedUnsupportedPlanToolCalls: boolean;
  hasSubstantivePlanAssistantText: boolean;
}

export interface ToolProgressPresentationDecision {
  shouldRenderToolProgress: boolean;
  shouldPreserveApprovedExecutionText: boolean;
  visibility: "substantive_plan_text" | "user_progress" | "hidden_process" | undefined;
  capsuleCandidate: boolean;
  modelAuthored: boolean;
}

export function isAllowedUnapprovedPlanDraftMutationCallForRuntime(input: {
  call: ToolCallToExecute;
  workflowMode: LegacyWorkflowMode;
  isPlanApproved: boolean;
  workspace: string;
}): boolean {
  return input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    isPreApprovalPlanDraftWrite(
      input.call.name,
      parseToolCallArguments(input.call, input.workspace),
    );
}

export function resolveToolProgressRouting(input: {
  effectiveToolCalls: ToolCallToExecute[];
  availableToolNames: Set<string>;
  workflowMode: LegacyWorkflowMode;
  isPlanApproved: boolean;
  workspace: string;
  visibleAssistantText: string;
}): ToolProgressRoutingDecision {
  const isAllowedUnapprovedPlanDraftMutationCall = (call: ToolCallToExecute) =>
    isAllowedUnapprovedPlanDraftMutationCallForRuntime({
      call,
      workflowMode: input.workflowMode,
      isPlanApproved: input.isPlanApproved,
      workspace: input.workspace,
    });
  const unsupportedToolCalls = input.effectiveToolCalls.filter((call) =>
    !input.availableToolNames.has(call.name) &&
    !isAllowedUnapprovedPlanDraftMutationCall(call)
  );
  const progressEligibleToolCalls = input.effectiveToolCalls.filter((call) =>
    input.availableToolNames.has(call.name) ||
    isAllowedUnapprovedPlanDraftMutationCall(call)
  );
  const hasSuppressedUnsupportedPlanToolCalls =
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    unsupportedToolCalls.length > 0;
  const hasSubstantivePlanAssistantText =
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    looksLikeSubstantivePlanAssistantText(input.visibleAssistantText);

  return {
    unsupportedToolCalls,
    progressEligibleToolCalls,
    hasSuppressedUnsupportedPlanToolCalls,
    hasSubstantivePlanAssistantText,
  };
}

export function shouldInjectRuntimeToolNarration(input: {
  progressEligibleToolCallCount: number;
  visibleAssistantText: string;
  hasToolActionNarration: boolean;
}): boolean {
  return input.progressEligibleToolCallCount > 0 &&
    !input.visibleAssistantText.trim() &&
    input.hasToolActionNarration;
}

export function resolveToolProgressPresentation(input: {
  progressEligibleToolCallCount: number;
  finalReplyOptionCount: number;
  hasSubstantivePlanAssistantText: boolean;
  workflowMode: LegacyWorkflowMode;
  isPlanApproved: boolean;
  runtimeNarrationInjected: boolean;
  visibleAssistantText: string;
  shouldSuppressApprovedPlanNoToolText: boolean;
}): ToolProgressPresentationDecision {
  const shouldRenderToolProgress =
    input.progressEligibleToolCallCount > 0 &&
    input.finalReplyOptionCount === 0 &&
    !input.hasSubstantivePlanAssistantText;
  const modelAuthoredToolNarration =
    shouldRenderToolProgress &&
    !input.runtimeNarrationInjected &&
    input.visibleAssistantText.trim().length > 0;
  // Model text emitted alongside a tool call is protocol narration, not an
  // evidence-backed stage checkpoint. Keep it in the assistant/tool transcript
  // for the next model turn, but hide it from the primary ChatArea projection;
  // structured tool/progress events carry the user-visible activity instead.
  const shouldPreserveApprovedExecutionText = false;

  return {
    shouldRenderToolProgress,
    shouldPreserveApprovedExecutionText,
    visibility: input.hasSubstantivePlanAssistantText
      ? "substantive_plan_text"
      : modelAuthoredToolNarration
      ? "hidden_process"
      : shouldRenderToolProgress || input.shouldSuppressApprovedPlanNoToolText
      ? "user_progress"
      : undefined,
    capsuleCandidate: false,
    modelAuthored: !input.runtimeNarrationInjected,
  };
}
