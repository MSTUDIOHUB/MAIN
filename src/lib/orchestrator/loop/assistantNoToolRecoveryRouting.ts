import { shouldTriggerChatFinalSynthesis } from "../../agentLoopSafety";
import { looksLikeToolUnavailableClaim } from "../../orchestrator/agentRecovery";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { LegacyWorkflowMode, ResolvedUserIntent } from "../../runIntent";

export type AssistantNoToolRecoveryRoute =
  | {
      action: "activate_chat_final_synthesis";
      reason: "length_no_tool_chat";
      logContext: {
        finishReason: string;
        visibleChars: number;
        hiddenThoughtChars: number;
        replyOptions: number;
        recentReadOnlyActivityCount: number;
      };
    }
  | { action: "reprompt_tool_unavailable" }
  | { action: "reprompt_pseudo_tool"; requestedToolName: string }
  | {
      action: "stop_pseudo_tool_doom_loop";
      requestedToolName: string;
      messageToolName: string | null;
    }
  | { action: "pass" };

export function countRecentReadOnlyActivityForChat(input: {
  recentToolActivity: PlanToolActivitySummary[];
  readOnlyToolNames: Set<string>;
}): number {
  return input.recentToolActivity.filter((activity) =>
    activity.status === "succeeded" && input.readOnlyToolNames.has(activity.name || "")
  ).length;
}

export function resolveAssistantNoToolRecoveryRoute(input: {
  workflowMode: LegacyWorkflowMode;
  runtimeIntent: ResolvedUserIntent;
  finishReason?: string | null;
  effectiveToolCallCount: number;
  finalReplyOptionCount: number;
  userVisibleText: string;
  normalizedHiddenThought: string;
  compactedProseCodeDump: boolean;
  chatFinalSynthesisActive: boolean;
  recentReadOnlyActivityCountForChat: number;
  consecutiveNoToolCount: number;
  isCloudProfile: boolean;
  iterationToolCount: number;
  pseudoToolCallPlaceholder: boolean;
  pseudoToolNameCandidate: string | null;
  usedToolUnavailableRecoveryPrompt: boolean;
  usedPseudoToolCallRecoveryPrompt: boolean;
}): AssistantNoToolRecoveryRoute {
  if (
    !input.chatFinalSynthesisActive &&
    shouldTriggerChatFinalSynthesis({
      workflowMode: input.workflowMode,
      runtimeIntent: input.runtimeIntent,
      finishReason: input.finishReason,
      toolCallCount: input.effectiveToolCallCount,
      visibleChars: input.userVisibleText.length,
      recentReadOnlyActivityCount: input.recentReadOnlyActivityCountForChat,
      consecutiveNoToolCount: input.consecutiveNoToolCount,
    })
  ) {
    return {
      action: "activate_chat_final_synthesis",
      reason: "length_no_tool_chat",
      logContext: {
        finishReason: input.finishReason || "unknown",
        visibleChars: input.userVisibleText.length,
        hiddenThoughtChars: input.normalizedHiddenThought.length,
        replyOptions: input.finalReplyOptionCount,
        recentReadOnlyActivityCount: input.recentReadOnlyActivityCountForChat,
      },
    };
  }

  const shouldRecoverToolUnavailableClaim =
    input.isCloudProfile &&
    input.iterationToolCount > 0 &&
    input.effectiveToolCallCount === 0 &&
    input.finalReplyOptionCount === 0 &&
    !input.compactedProseCodeDump &&
    looksLikeToolUnavailableClaim(input.userVisibleText);

  if (shouldRecoverToolUnavailableClaim && !input.usedToolUnavailableRecoveryPrompt) {
    return { action: "reprompt_tool_unavailable" };
  }

  if (input.pseudoToolCallPlaceholder && !input.usedPseudoToolCallRecoveryPrompt) {
    return {
      action: "reprompt_pseudo_tool",
      requestedToolName: input.pseudoToolNameCandidate || "unknown",
    };
  }

  if (input.pseudoToolCallPlaceholder && input.usedPseudoToolCallRecoveryPrompt) {
    return {
      action: "stop_pseudo_tool_doom_loop",
      requestedToolName: input.pseudoToolNameCandidate || "unknown",
      messageToolName: input.pseudoToolNameCandidate,
    };
  }

  return { action: "pass" };
}
