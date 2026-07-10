import {
  PLAN_NO_VISIBLE_TOKEN_TIMEOUT_MS,
  shouldUsePlanNoVisibleTokenWatchdog,
} from "../../orchestrator";
import { shouldUseMaxStepsFinalTextOnly } from "../../agentLoopSafety";
import type { ExecuteRecoveryMode } from "../../executeRecoveryTools";
import type { ResolvedUserIntent } from "../../runIntent";
import type { FetchLLMStreamOptions } from "../types";

export interface AgentLoopStreamRuntimeState {
  usedMaxStepsFinalTextPrompt: boolean;
  chatFinalSynthesisActive: boolean;
  chatFinalSynthesisReason: string;
  usedChatFinalSynthesisPrompt: boolean;
  currentMaxTokens: number | undefined;
  loggedLocalPlanNoVisibleTokenNoticeOnly: boolean;
}

export function createAgentLoopStreamRuntimeState(): AgentLoopStreamRuntimeState {
  return {
    usedMaxStepsFinalTextPrompt: false,
    chatFinalSynthesisActive: false,
    chatFinalSynthesisReason: "",
    usedChatFinalSynthesisPrompt: false,
    currentMaxTokens: undefined,
    loggedLocalPlanNoVisibleTokenNoticeOnly: false,
  };
}

export function resolveMaxOutputEscalations(input: {
  executeRecoveryMode: ExecuteRecoveryMode;
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
}): number {
  if (input.executeRecoveryMode !== "normal") return 0;
  return input.workflowMode === "plan" && !input.isPlanApproved ? 0 : 2;
}

export function resolveFinalTextOnlyStepState(
  state: AgentLoopStreamRuntimeState,
  input: {
    workflowMode: "chat" | "edit" | "plan";
    runtimeIntent: ResolvedUserIntent;
    isPlanApproved: boolean;
    iteration: number;
    maxIterations: number;
  },
): {
  state: AgentLoopStreamRuntimeState;
  finalTextOnlyStep: boolean;
} {
  const finalTextOnlyStep = shouldUseMaxStepsFinalTextOnly({
    ...input,
    alreadyPrompted: state.usedMaxStepsFinalTextPrompt,
  });
  if (!finalTextOnlyStep) {
    return { state, finalTextOnlyStep };
  }
  return {
    state: {
      ...state,
      usedMaxStepsFinalTextPrompt: true,
    },
    finalTextOnlyStep,
  };
}

export function activateChatFinalSynthesisState(
  state: AgentLoopStreamRuntimeState,
  input: {
    reason: string;
    maxTokensCeiling?: number;
  },
): {
  state: AgentLoopStreamRuntimeState;
  changed: boolean;
} {
  if (state.chatFinalSynthesisActive) {
    return { state, changed: false };
  }
  const maxTokensCeiling = input.maxTokensCeiling ?? 2048;
  return {
    state: {
      ...state,
      chatFinalSynthesisActive: true,
      chatFinalSynthesisReason: input.reason || "chat_final_synthesis",
      currentMaxTokens: Math.min(state.currentMaxTokens ?? maxTokensCeiling, maxTokensCeiling),
    },
    changed: true,
  };
}

export function markChatFinalSynthesisPromptUsed(
  state: AgentLoopStreamRuntimeState,
): AgentLoopStreamRuntimeState {
  if (state.usedChatFinalSynthesisPrompt) return state;
  return {
    ...state,
    usedChatFinalSynthesisPrompt: true,
  };
}

export function resolvePlanStreamWatchdogState(
  state: AgentLoopStreamRuntimeState,
  input: {
    workflowMode: "chat" | "edit" | "plan";
    isPlanApproved: boolean;
    nativeToolCount: number;
    activeProfile: "local" | "cloud";
    provider?: string | null;
    toolProtocol: string;
  },
): {
  state: AgentLoopStreamRuntimeState;
  options: FetchLLMStreamOptions | undefined;
  shouldLogLocalPlanNotice: boolean;
} {
  const watchdogEnabled = shouldUsePlanNoVisibleTokenWatchdog({
    workflowMode: input.workflowMode,
    isPlanApproved: input.isPlanApproved,
    nativeToolCount: input.nativeToolCount,
    activeProfile: input.activeProfile,
    provider: input.provider,
    toolProtocol: input.toolProtocol,
  });
  const shouldLogLocalPlanNotice =
    !watchdogEnabled &&
    !state.loggedLocalPlanNoVisibleTokenNoticeOnly &&
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    input.nativeToolCount === 0 &&
    input.activeProfile === "local";
  const nextState = shouldLogLocalPlanNotice
    ? {
        ...state,
        loggedLocalPlanNoVisibleTokenNoticeOnly: true,
      }
    : state;
  return {
    state: nextState,
    options: watchdogEnabled
      ? {
          noVisibleTokenTimeoutMs: PLAN_NO_VISIBLE_TOKEN_TIMEOUT_MS,
          noVisibleTokenTimeoutLabel: `${input.workflowMode}:preapproval_xml_tools`,
        }
      : undefined,
    shouldLogLocalPlanNotice,
  };
}
