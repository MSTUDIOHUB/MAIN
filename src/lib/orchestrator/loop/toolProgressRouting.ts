import { isPreApprovalPlanDraftWrite, parseToolCallArguments } from "../../orchestrator";
import { isThinModelToolNarration } from "../../modelFeedbackDedupe";
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
  visibility: "substantive_plan_text" | "assistant_update" | "user_progress" | "hidden_process" | undefined;
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
  unsupportedToolCallCount: number;
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
  const unsupportedOnlyToolNarration =
    input.unsupportedToolCallCount > 0 &&
    input.progressEligibleToolCallCount === 0;
  const thinToolNarration = isThinModelToolNarration(input.visibleAssistantText);
  // Model-authored prose emitted with a real tool call is the assistant's
  // public update channel. Runtime-injected tool narration and unsupported-tool
  // corrections remain process-only; the UI must not infer this identity from
  // words such as "confirmed" or "next".
  const assistantUpdate =
    modelAuthoredToolNarration &&
    !unsupportedOnlyToolNarration &&
    !thinToolNarration;
  const shouldPreserveApprovedExecutionText = assistantUpdate;

  return {
    shouldRenderToolProgress,
    shouldPreserveApprovedExecutionText,
    visibility: input.hasSubstantivePlanAssistantText
      ? "substantive_plan_text"
      : assistantUpdate
      ? "assistant_update"
      : unsupportedOnlyToolNarration
      ? "hidden_process"
      : thinToolNarration
      ? "user_progress"
      : modelAuthoredToolNarration
      ? "hidden_process"
      : shouldRenderToolProgress || input.shouldSuppressApprovedPlanNoToolText
      ? "user_progress"
      : undefined,
    capsuleCandidate: false,
    modelAuthored: !input.runtimeNarrationInjected,
  };
}
