import {
  buildLanguageMismatchRecoveryPrompt,
  buildPseudoToolCallRecoveryPrompt,
  buildToolProtocolDoomLoopStopMessage,
  buildToolUnavailableRecoveryPrompt,
} from "../../orchestrator/agentRecovery";
import {
  logAgentEvent,
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import type { LegacyWorkflowMode, ResolvedUserIntent } from "../../runIntent";
import type { OrchestratorCallbacks } from "../types";
import {
  countRecentReadOnlyActivityForChat,
  resolveAssistantNoToolRecoveryRoute,
} from "./assistantNoToolRecoveryRouting";
import {
  resolveAssistantLanguageRecoveryRoute,
} from "./assistantLanguageRecoveryRouting";
import {
  markLanguageMismatchRecoveryPromptUsed,
  markPseudoToolCallRecoveryPromptUsed,
  markToolUnavailableRecoveryPromptUsed,
  type AgentLoopRecoveryPromptRuntimeState,
} from "./recoveryPromptRuntimeState";

export type AssistantRecoveryHandlingStatus = "pass" | "continue" | "stopped";

type AssistantRecoveryCallbacks = Pick<
  OrchestratorCallbacks,
  | "appendMessage"
  | "getPreferredLanguage"
  | "onNonActionableStop"
  | "onStatusChange"
  | "onStreamToken"
>;

export function handleAssistantNoToolRecovery(input: {
  callbacks: AssistantRecoveryCallbacks;
  assistantMsgId: string;
  iteration: number;
  workflowMode: LegacyWorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  finishReason?: string | null;
  effectiveToolCallCount: number;
  finalReplyOptionCount: number;
  userVisibleText: string;
  normalizedVisibleText: string;
  normalizedHiddenThought: string;
  compactedProseCodeDump: boolean;
  chatFinalSynthesisActive: boolean;
  recentToolActivity: PlanToolActivitySummary[];
  consecutiveNoToolCount: number;
  isCloudProfile: boolean;
  iterationToolCount: number;
  llmToolCount: number;
  forceXmlTools: boolean;
  pseudoToolCallPlaceholder: boolean;
  pseudoToolNameCandidate: string | null;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  activateChatFinalSynthesis: (
    reason: string,
    logContext?: Record<string, unknown>,
  ) => void;
}): {
  status: AssistantRecoveryHandlingStatus;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  recentReadOnlyActivityCountForChat: number;
} {
  const recentReadOnlyActivityCountForChat = countRecentReadOnlyActivityForChat({
    recentToolActivity: input.recentToolActivity,
    readOnlyToolNames: PLAN_EXPLORATION_READ_ONLY_TOOLS,
  });
  const route = resolveAssistantNoToolRecoveryRoute({
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    finishReason: input.finishReason,
    effectiveToolCallCount: input.effectiveToolCallCount,
    finalReplyOptionCount: input.finalReplyOptionCount,
    userVisibleText: input.userVisibleText,
    normalizedHiddenThought: input.normalizedHiddenThought,
    compactedProseCodeDump: input.compactedProseCodeDump,
    chatFinalSynthesisActive: input.chatFinalSynthesisActive,
    recentReadOnlyActivityCountForChat,
    consecutiveNoToolCount: input.consecutiveNoToolCount,
    isCloudProfile: input.isCloudProfile,
    iterationToolCount: input.iterationToolCount,
    pseudoToolCallPlaceholder: input.pseudoToolCallPlaceholder,
    pseudoToolNameCandidate: input.pseudoToolNameCandidate,
    usedToolUnavailableRecoveryPrompt:
      input.recoveryPromptState.usedToolUnavailableRecoveryPrompt,
    usedPseudoToolCallRecoveryPrompt:
      input.recoveryPromptState.usedPseudoToolCallRecoveryPrompt,
  });

  if (route.action === "activate_chat_final_synthesis") {
    input.activateChatFinalSynthesis(route.reason, route.logContext);
    input.callbacks.onStreamToken("__ESCALATION_RESET__:", input.assistantMsgId);
    input.callbacks.onStatusChange("running");
    return {
      status: "continue",
      recoveryPromptState: input.recoveryPromptState,
      recentReadOnlyActivityCountForChat,
    };
  }

  if (route.action === "reprompt_tool_unavailable") {
    const recoveryPromptState = markToolUnavailableRecoveryPromptUsed(
      input.recoveryPromptState,
    );
    logAgentEvent("tool_unavailable_claim_reprompt", {
      iteration: input.iteration,
      allTools: input.iterationToolCount,
      llmTools: input.llmToolCount,
      xmlToolsEnabled: input.forceXmlTools,
      visibleChars: input.userVisibleText.length,
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: buildToolUnavailableRecoveryPrompt(
        MODEL_CONTROL_LANGUAGE,
        input.workflowMode,
        input.forceXmlTools,
      ),
    });
    return {
      status: "continue",
      recoveryPromptState,
      recentReadOnlyActivityCountForChat,
    };
  }

  if (route.action === "reprompt_pseudo_tool") {
    const recoveryPromptState = markPseudoToolCallRecoveryPromptUsed(
      input.recoveryPromptState,
    );
    logAgentEvent("pseudo_tool_repair_requested", {
      iteration: input.iteration,
      workflowMode: input.workflowMode,
      turnIntent: input.turnIntent,
      requestedToolName: route.requestedToolName,
      visibleChars: input.normalizedVisibleText.length,
      hiddenThoughtChars: input.normalizedHiddenThought.length,
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: buildPseudoToolCallRecoveryPrompt(
        MODEL_CONTROL_LANGUAGE,
        input.workflowMode,
        input.forceXmlTools,
      ),
    });
    return {
      status: "continue",
      recoveryPromptState,
      recentReadOnlyActivityCountForChat,
    };
  }

  if (route.action === "stop_pseudo_tool_doom_loop") {
    logAgentEvent("tool_protocol_doom_loop", {
      iteration: input.iteration,
      workflowMode: input.workflowMode,
      turnIntent: input.turnIntent,
      requestedToolName: route.requestedToolName,
      visibleChars: input.normalizedVisibleText.length,
      hiddenThoughtChars: input.normalizedHiddenThought.length,
    });
    input.callbacks.onStreamToken("__ESCALATION_RESET__:", input.assistantMsgId);
    input.callbacks.onNonActionableStop(
      buildToolProtocolDoomLoopStopMessage(
        input.callbacks.getPreferredLanguage(),
        route.messageToolName,
        input.forceXmlTools,
      ),
      "missing_tool_loop",
      {
        phase: "paused",
        recoveryReason: "tool_protocol_doom_loop",
        nextStep: input.callbacks.getPreferredLanguage() === "zh"
          ? "保留现有证据，重新开放当前阶段实际可调用的工具面"
          : "retain current evidence and reopen the actually callable tools for this phase",
      },
    );
    input.callbacks.onStatusChange("idle");
    return {
      status: "stopped",
      recoveryPromptState: input.recoveryPromptState,
      recentReadOnlyActivityCountForChat,
    };
  }

  return {
    status: "pass",
    recoveryPromptState: input.recoveryPromptState,
    recentReadOnlyActivityCountForChat,
  };
}

export function handleAssistantLanguageRecovery(input: {
  callbacks: AssistantRecoveryCallbacks;
  assistantMsgId: string;
  iteration: number;
  workflowMode: LegacyWorkflowMode;
  runtimeIntent: ResolvedUserIntent;
  userVisibleText: string;
  shouldSuppressApprovedPlanNoToolText: boolean;
  effectiveToolCallCount: number;
  injectedRequiredWebResearchCall: boolean;
  chatFinalSynthesisActive: boolean;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  recentReadOnlyActivityCountForChat: number;
  consecutiveNoToolCount: number;
  activateChatFinalSynthesis: (
    reason: string,
    logContext?: Record<string, unknown>,
  ) => void;
}): {
  status: Exclude<AssistantRecoveryHandlingStatus, "stopped">;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  visibleAssistantText: string;
} {
  const languageRecoveryRoute = resolveAssistantLanguageRecoveryRoute({
    text: input.userVisibleText,
    targetLanguage: input.callbacks.getPreferredLanguage(),
    suppressedByPlanGuard: input.shouldSuppressApprovedPlanNoToolText,
    toolCallCount: input.effectiveToolCallCount,
    alreadyRetried:
      input.recoveryPromptState.usedLanguageMismatchRecoveryPrompt ||
      input.chatFinalSynthesisActive,
    chatFinalSynthesisActive: input.chatFinalSynthesisActive,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    recentReadOnlyActivityCountForChat:
      input.recentReadOnlyActivityCountForChat,
    consecutiveNoToolCount: input.consecutiveNoToolCount,
  });
  const languageMismatchDecision = languageRecoveryRoute.decision;

  if (languageRecoveryRoute.action === "activate_chat_final_synthesis") {
    input.activateChatFinalSynthesis(
      languageRecoveryRoute.reason,
      languageRecoveryRoute.logContext,
    );
    input.callbacks.onStreamToken("__ESCALATION_RESET__:", input.assistantMsgId);
    input.callbacks.onStatusChange("running");
    return {
      status: "continue",
      recoveryPromptState: input.recoveryPromptState,
      visibleAssistantText: "",
    };
  }

  if (languageRecoveryRoute.action === "recover_once") {
    const recoveryPromptState = markLanguageMismatchRecoveryPromptUsed(
      input.recoveryPromptState,
    );
    input.callbacks.onStreamToken("__ESCALATION_RESET__:", input.assistantMsgId);
    logAgentEvent("language_mismatch_reprompt", {
      iteration: input.iteration,
      targetLanguage: input.callbacks.getPreferredLanguage(),
      detectedLanguage: languageMismatchDecision.detectedLanguage,
      hanCount: languageMismatchDecision.hanCount,
      latinLetters: languageMismatchDecision.latinLetters,
      latinWords: languageMismatchDecision.latinWords,
      visibleChars: input.userVisibleText.length,
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: buildLanguageMismatchRecoveryPrompt(
        input.callbacks.getPreferredLanguage(),
      ),
    });
    return {
      status: "continue",
      recoveryPromptState,
      visibleAssistantText: "",
    };
  }

  let visibleAssistantText = input.injectedRequiredWebResearchCall
    ? ""
    : input.userVisibleText;
  if (languageRecoveryRoute.action === "hide_text_continue") {
    input.callbacks.onStreamToken("__ESCALATION_RESET__:", input.assistantMsgId);
    visibleAssistantText = "";
    logAgentEvent("language_mismatch_text_hidden_for_tool_calls", {
      iteration: input.iteration,
      targetLanguage: input.callbacks.getPreferredLanguage(),
      detectedLanguage: languageMismatchDecision.detectedLanguage,
      hanCount: languageMismatchDecision.hanCount,
      latinLetters: languageMismatchDecision.latinLetters,
      latinWords: languageMismatchDecision.latinWords,
      visibleChars: input.userVisibleText.length,
      toolCalls: input.effectiveToolCallCount,
    });
  }

  if (languageMismatchDecision.exhausted) {
    logAgentEvent("language_mismatch_reprompt_exhausted", {
      iteration: input.iteration,
      targetLanguage: input.callbacks.getPreferredLanguage(),
      detectedLanguage: languageMismatchDecision.detectedLanguage,
      visibleChars: input.userVisibleText.length,
    });
  }

  return {
    status: "pass",
    recoveryPromptState: input.recoveryPromptState,
    visibleAssistantText,
  };
}
