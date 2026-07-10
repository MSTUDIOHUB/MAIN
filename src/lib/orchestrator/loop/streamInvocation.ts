import { buildChatFinalSynthesisPrompt, buildMaxStepsFinalTextPrompt } from "../../agentLoopSafety";
import { describeExecuteRecoveryToolSurface, summarizeRepeatedExecuteTargets, type ExecuteRecoveryMode } from "../../executeRecoveryTools";
import { isAssistantTurnEmpty, normalizeAssistantTurn } from "../../normalizedTurn";
import {
  fetchLLMStream,
  logAgentEvent,
  MAX_NO_ACTION_RETRIES,
  prepareMessagesForToolProtocol,
  summarizeMessagesForDiagnostics,
  summarizeToolsForDiagnostics,
} from "../../orchestrator";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import type { StreamResult } from "../../streaming";
import type { ToolDefinition } from "../../toolSchemas";
import { PolicyFactory } from "../policies/PolicyFactory";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { AgentMessage, FetchLLMStreamOptions, OrchestratorCallbacks } from "../types";
import type { AgentLoopRuntimeState } from "./turnPreparation";

export type PlanStreamWatchdogOptionsResolver = (
  nativeToolCount: number,
) => FetchLLMStreamOptions | undefined;

export type InitialStreamInvocationResult =
  | { status: "streamed"; streamResult: StreamResult }
  | { status: "stopped"; reason: "reasoning_dominated" };

export async function invokeInitialStreamForIteration(input: {
  callbacks: OrchestratorCallbacks;
  abortSignal: AbortSignal;
  runtimeState: AgentLoopRuntimeState;
  assistantMsgId: string;
  iteration: number;
  effectiveMaxIterations: number;
  runtimeIntent: ResolvedUserIntent;
  managedAgentMessages: AgentMessage[];
  iterationAllTools: ToolDefinition[];
  llmTools: ToolDefinition[];
  currentMaxTokens: number | undefined;
  maxOutputEscalations: number;
  forceXmlTools: boolean;
  providerCompatibilityOverride: boolean | undefined;
  snapshotContextLimit: number | undefined;
  executeRecoveryMode: ExecuteRecoveryMode;
  executeRecoveryReason: string | null;
  allowExecuteRecoveryFileRead: boolean;
  isExecuteRecoveryEligible: boolean;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  finalTextOnlyStep: boolean;
  chatFinalSynthesisActive: boolean;
  chatFinalSynthesisReason: string;
  usedChatFinalSynthesisPrompt: boolean;
  markChatFinalSynthesisPromptUsed: () => void;
  recentToolActivity: PlanToolActivitySummary[];
  consecutiveNoToolCount: number;
  getPlanStreamWatchdogOptions: PlanStreamWatchdogOptionsResolver;
  approvedPlanRecoveryStreamMaxElapsedMs: number;
}): Promise<InitialStreamInvocationResult> {
  const {
    callbacks,
    abortSignal,
    runtimeState,
    assistantMsgId,
    iteration,
    effectiveMaxIterations,
    runtimeIntent,
    managedAgentMessages,
    iterationAllTools,
    llmTools,
    currentMaxTokens,
    maxOutputEscalations,
    forceXmlTools,
    providerCompatibilityOverride,
    snapshotContextLimit,
    executeRecoveryMode,
    executeRecoveryReason,
    allowExecuteRecoveryFileRead,
    isExecuteRecoveryEligible,
    approvedPlanActionOnlyRecoveryActive,
    approvedPlanNoToolRecoveryFileReadActive,
    finalTextOnlyStep,
    chatFinalSynthesisActive,
    chatFinalSynthesisReason,
    usedChatFinalSynthesisPrompt,
    markChatFinalSynthesisPromptUsed,
    recentToolActivity,
    consecutiveNoToolCount,
    getPlanStreamWatchdogOptions,
    approvedPlanRecoveryStreamMaxElapsedMs,
  } = input;
  const {
    config,
    settings,
    effectiveToolProtocol,
    modelProtocolProfile,
    turnIntent,
    workflowMode,
  } = runtimeState;

  const protocolMessagesForLLM = prepareMessagesForToolProtocol(
    managedAgentMessages,
    config,
    settings,
    providerCompatibilityOverride,
  );
  const finalTextOnlyPrompt = finalTextOnlyStep
    ? buildMaxStepsFinalTextPrompt({
        language: callbacks.getPreferredLanguage(),
        iteration,
        maxIterations: effectiveMaxIterations,
        repeatedTargets: summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
      })
    : "";
  const chatFinalSynthesisPrompt = chatFinalSynthesisActive && !usedChatFinalSynthesisPrompt
    ? buildChatFinalSynthesisPrompt({
        language: callbacks.getPreferredLanguage(),
        reason: chatFinalSynthesisReason,
        iteration,
        repeatedTargets: summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
        recentActivity: recentToolActivity,
      })
    : "";
  const recoveryPromptForLLM = finalTextOnlyPrompt || chatFinalSynthesisPrompt;
  const messagesForLLM = recoveryPromptForLLM
    ? [...protocolMessagesForLLM, { role: "user" as const, content: recoveryPromptForLLM }]
    : protocolMessagesForLLM;
  if (chatFinalSynthesisPrompt) {
    markChatFinalSynthesisPromptUsed();
  }

  const baseStreamWatchdogOptions = getPlanStreamWatchdogOptions(llmTools.length) ?? {};
  const approvedPlanRecoveryStreamHardTimeoutActive =
    config.activeProfile === "local" &&
    workflowMode === "plan" &&
    callbacks.getIsPlanApproved() &&
    runtimeIntent === "execute" &&
    (isExecuteRecoveryEligible || approvedPlanActionOnlyRecoveryActive || approvedPlanNoToolRecoveryFileReadActive);
  const streamWatchdogOptions: FetchLLMStreamOptions = {
    ...baseStreamWatchdogOptions,
    ...(approvedPlanRecoveryStreamHardTimeoutActive
      ? {
          maxStreamElapsedMs: approvedPlanRecoveryStreamMaxElapsedMs,
          maxStreamElapsedLabel: "approved_plan_recovery",
        }
      : {}),
  };
  const recoveryToolChoice =
    isExecuteRecoveryEligible && executeRecoveryMode !== "normal" && llmTools.length > 0 && !forceXmlTools
      ? "required"
      : undefined;

  logAgentEvent("llm_request_shape", {
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    activeProfile: config.activeProfile,
    provider: settings.provider || "unknown",
    providerFamily: modelProtocolProfile.providerFamily,
    model: settings.model,
    apiProtocol: settings.apiProtocol,
    useRustProxy: settings.useRustProxy,
    contextLimit: settings.contextLimit,
    configuredContextLimit: snapshotContextLimit ?? null,
    currentMaxTokens: currentMaxTokens ?? "default",
    maxOutputEscalations,
    forceXmlTools,
    toolProtocol: effectiveToolProtocol,
    nativeToolsEnabled: !forceXmlTools,
    compatibilityOverride: !!providerCompatibilityOverride,
    executeRecoveryMode,
    executeRecoveryReason,
    recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, allowExecuteRecoveryFileRead),
    finalTextOnlyStep,
    chatFinalSynthesisActive,
    chatFinalSynthesisReason,
    messages: summarizeMessagesForDiagnostics(messagesForLLM),
    allTools: summarizeToolsForDiagnostics(iterationAllTools),
    llmTools: summarizeToolsForDiagnostics(llmTools),
    toolChoice: recoveryToolChoice ?? null,
    watchdog: {
      hardTimeoutMs: streamWatchdogOptions.noVisibleTokenTimeoutMs ?? null,
      label: streamWatchdogOptions.noVisibleTokenTimeoutLabel ?? null,
      maxStreamElapsedMs: streamWatchdogOptions.maxStreamElapsedMs ?? null,
      maxStreamElapsedLabel: streamWatchdogOptions.maxStreamElapsedLabel ?? null,
      noticeOnlyForLocalPlan:
        workflowMode === "plan" &&
        !callbacks.getIsPlanApproved() &&
        config.activeProfile === "local" &&
        forceXmlTools,
    },
  });

  const isExecute = isMutationRuntimeIntent(runtimeIntent);
  const executionPolicy = PolicyFactory.createPolicy(config);
  const responseSchema = (isExecute && config.activeProfile === "local")
    ? executionPolicy.getResponseFormatSchema?.()
    : undefined;

  const streamResult = await fetchLLMStream(
    messagesForLLM,
    settings,
    assistantMsgId,
    callbacks,
    abortSignal,
    llmTools,
    currentMaxTokens,
    maxOutputEscalations,
    {
      ...streamWatchdogOptions,
      toolChoice: recoveryToolChoice,
      workflowMode,
      runtimeIntent,
      responseFormat: responseSchema,
    },
  );

  const totalOutputChars = streamResult.content.length + (streamResult.reasoningContent || "").length;
  const isLengthTruncated = streamResult.finishReason === "length";
  if (!isLengthTruncated && totalOutputChars > 200 && (!streamResult.toolCalls || streamResult.toolCalls.length === 0)) {
    const reasoningRatio = (streamResult.reasoningContent || "").length / totalOutputChars;
    if (reasoningRatio > 0.8 && consecutiveNoToolCount >= (config.activeProfile === "local" ? 4 : MAX_NO_ACTION_RETRIES)) {
      const stopMessage = executionPolicy.getReasoningDominatedStopMessage?.(
        callbacks.getPreferredLanguage(),
        reasoningRatio,
      ) || "Halted: reasoning-dominated output.";
      callbacks.onNonActionableStop(stopMessage, "no_action");
      callbacks.onStatusChange("idle");
      return { status: "stopped", reason: "reasoning_dominated" };
    }
  }

  if (llmTools.length > 0) {
    callbacks.onProviderNativeToolSuccess?.();
  }
  if (
    config.activeProfile === "local" &&
    snapshotContextLimit != null &&
    isAssistantTurnEmpty(normalizeAssistantTurn(streamResult))
  ) {
    const contextErr = new Error(
      "Local model returned an empty completion. Treating as context window limit exceeded to trigger reactive compaction.",
    );
    (contextErr as any).isContextError = true;
    throw contextErr;
  }

  return { status: "streamed", streamResult };
}
