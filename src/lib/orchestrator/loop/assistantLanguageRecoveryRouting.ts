import { shouldTriggerChatFinalSynthesis } from "../../agentLoopSafety";
import { shouldRecoverLanguageMismatchTurn } from "../../orchestrator/agentRecovery";
import type { LegacyWorkflowMode, ResolvedUserIntent } from "../../runIntent";

export type AssistantLanguageMismatchDecision = ReturnType<typeof shouldRecoverLanguageMismatchTurn>;

export type AssistantLanguageRecoveryRoute =
  | {
      action: "activate_chat_final_synthesis";
      decision: AssistantLanguageMismatchDecision;
      reason: "language_mismatch_after_retry";
      logContext: {
        detectedLanguage: "zh" | "en" | null;
        visibleChars: number;
      };
    }
  | { action: "recover_once"; decision: AssistantLanguageMismatchDecision }
  | { action: "hide_text_continue"; decision: AssistantLanguageMismatchDecision }
  | { action: "pass"; decision: AssistantLanguageMismatchDecision };

export function resolveAssistantLanguageRecoveryRoute(input: {
  text: string;
  targetLanguage: "zh" | "en";
  suppressedByPlanGuard: boolean;
  toolCallCount: number;
  alreadyRetried: boolean;
  chatFinalSynthesisActive: boolean;
  workflowMode: LegacyWorkflowMode;
  runtimeIntent: ResolvedUserIntent;
  recentReadOnlyActivityCountForChat: number;
  consecutiveNoToolCount: number;
}): AssistantLanguageRecoveryRoute {
  const decision = shouldRecoverLanguageMismatchTurn({
    text: input.text,
    targetLanguage: input.targetLanguage,
    suppressedByPlanGuard: input.suppressedByPlanGuard,
    toolCallCount: input.toolCallCount,
    alreadyRetried: input.alreadyRetried,
  });

  if (
    decision.exhausted &&
    !input.chatFinalSynthesisActive &&
    shouldTriggerChatFinalSynthesis({
      workflowMode: input.workflowMode,
      runtimeIntent: input.runtimeIntent,
      wasLanguageMismatchRecovery: true,
      languageMismatchAlreadyRetried: true,
      toolCallCount: input.toolCallCount,
      visibleChars: input.text.length,
      recentReadOnlyActivityCount: input.recentReadOnlyActivityCountForChat,
      consecutiveNoToolCount: input.consecutiveNoToolCount,
    })
  ) {
    return {
      action: "activate_chat_final_synthesis",
      decision,
      reason: "language_mismatch_after_retry",
      logContext: {
        detectedLanguage: decision.detectedLanguage,
        visibleChars: input.text.length,
      },
    };
  }

  if (decision.action === "recover_once") {
    return { action: "recover_once", decision };
  }

  if (decision.action === "hide_text_continue") {
    return { action: "hide_text_continue", decision };
  }

  return { action: "pass", decision };
}
