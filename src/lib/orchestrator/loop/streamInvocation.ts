import { buildChatFinalSynthesisPrompt, buildMaxStepsFinalTextPrompt } from "../../agentLoopSafety";
import { describeExecuteRecoveryToolSurface, summarizeRepeatedExecuteTargets, type ExecuteRecoveryMode } from "../../executeRecoveryTools";
import { classifyAssistantCompletion } from "../../normalizedTurn";
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
import {
  applyPreapprovalPlanQualityRecoveryStreamOptions,
  capPreapprovalPlanQualityRecoveryMaxEscalations,
  capPreapprovalPlanQualityRecoveryMaxTokens,
  type PreapprovalPlanQualityRecoveryStreamPolicy,
} from "./preapprovalPlanRecoveryStreamPolicy";

export type PlanStreamWatchdogOptionsResolver = (
  nativeToolCount: number,
) => FetchLLMStreamOptions | undefined;

export const APPROVED_PLAN_ACTION_REQUIRED_STREAM_MAX_ELAPSED_MS = 45_000;

export function resolveRecoveryToolChoice(input: {
  isExecuteRecoveryEligible: boolean;
  executeRecoveryMode: ExecuteRecoveryMode;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  llmToolCount: number;
  forceXmlTools: boolean;
  preapprovalPlanQualityRecoveryToolChoice?: "required";
}): "required" | undefined {
  if (input.llmToolCount <= 0 || input.forceXmlTools) return undefined;
  const executeRecoveryRequiresAction =
    input.isExecuteRecoveryEligible && input.executeRecoveryMode !== "normal";
  const approvedPlanRecoveryRequiresAction =
    input.approvedPlanActionOnlyRecoveryActive ||
    input.approvedPlanNoToolRecoveryFileReadActive;
  return executeRecoveryRequiresAction ||
    approvedPlanRecoveryRequiresAction ||
    input.preapprovalPlanQualityRecoveryToolChoice === "required"
    ? "required"
    : undefined;
}

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
  preapprovalPlanQualityRecoveryStreamPolicy: PreapprovalPlanQualityRecoveryStreamPolicy;
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
    preapprovalPlanQualityRecoveryStreamPolicy,
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
  const recoveryStreamMaxElapsedMs =
    approvedPlanActionOnlyRecoveryActive || approvedPlanNoToolRecoveryFileReadActive
      ? Math.min(
          APPROVED_PLAN_ACTION_REQUIRED_STREAM_MAX_ELAPSED_MS,
          approvedPlanRecoveryStreamMaxElapsedMs,
        )
      : approvedPlanRecoveryStreamMaxElapsedMs;
  const childStreamBounded = (callbacks.getSubagentDepth?.() ?? 0) > 0;
  const normalApprovedLocalExecutionBounded =
    config.activeProfile === "local" &&
    workflowMode === "plan" &&
    callbacks.getIsPlanApproved() &&
    runtimeIntent === "execute";
  const boundedNoVisibleMs = childStreamBounded || normalApprovedLocalExecutionBounded ? 45_000 : 0;
  const boundedMaxElapsedMs = childStreamBounded || normalApprovedLocalExecutionBounded ? 120_000 : 0;
  const minPositive = (current: number | undefined, next: number): number | undefined => {
    if (next <= 0) return current;
    if (!current || current <= 0) return next;
    return Math.min(current, next);
  };
  const baseResolvedStreamWatchdogOptions: FetchLLMStreamOptions = {
    ...baseStreamWatchdogOptions,
    ...(boundedNoVisibleMs > 0
      ? {
          noVisibleTokenTimeoutMs: minPositive(
            baseStreamWatchdogOptions.noVisibleTokenTimeoutMs,
            boundedNoVisibleMs,
          ),
          noVisibleTokenTimeoutLabel: childStreamBounded
            ? "subagent_no_visible_progress"
            : "approved_plan_no_visible_progress",
          maxStreamElapsedMs: minPositive(
            baseStreamWatchdogOptions.maxStreamElapsedMs,
            boundedMaxElapsedMs,
          ),
          maxStreamElapsedLabel: childStreamBounded
            ? "subagent_stream_boundary"
            : "approved_plan_stream_boundary",
        }
      : {}),
    ...(approvedPlanRecoveryStreamHardTimeoutActive
      ? {
          maxStreamElapsedMs: minPositive(
            boundedMaxElapsedMs > 0 ? boundedMaxElapsedMs : baseStreamWatchdogOptions.maxStreamElapsedMs,
            recoveryStreamMaxElapsedMs,
          ),
          maxStreamElapsedLabel: "approved_plan_recovery",
        }
      : {}),
  };
  const streamWatchdogOptions =
    applyPreapprovalPlanQualityRecoveryStreamOptions(
      preapprovalPlanQualityRecoveryStreamPolicy,
      baseResolvedStreamWatchdogOptions,
      llmTools.length,
    );
  const recoveryToolChoice = resolveRecoveryToolChoice({
    isExecuteRecoveryEligible,
    executeRecoveryMode,
    approvedPlanActionOnlyRecoveryActive,
    approvedPlanNoToolRecoveryFileReadActive,
    llmToolCount: llmTools.length,
    forceXmlTools,
    preapprovalPlanQualityRecoveryToolChoice:
      preapprovalPlanQualityRecoveryStreamPolicy.toolChoice,
  });
  const policyCurrentMaxTokens =
    capPreapprovalPlanQualityRecoveryMaxTokens(
      preapprovalPlanQualityRecoveryStreamPolicy,
      currentMaxTokens,
    );
  const effectiveCurrentMaxTokens = childStreamBounded && finalTextOnlyStep
    ? Math.min(policyCurrentMaxTokens || 2_048, 2_048)
    : policyCurrentMaxTokens;
  const effectiveMaxOutputEscalations =
    capPreapprovalPlanQualityRecoveryMaxEscalations(
      preapprovalPlanQualityRecoveryStreamPolicy,
      maxOutputEscalations,
    );

  callbacks.onDebugEvent?.("agent.llm_request_shape", {
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
    currentMaxTokens: effectiveCurrentMaxTokens ?? "default",
    maxOutputEscalations: effectiveMaxOutputEscalations,
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
    preapprovalPlanQualityRecovery:
      preapprovalPlanQualityRecoveryStreamPolicy.active
        ? {
            stage: preapprovalPlanQualityRecoveryStreamPolicy.stage,
            maxOutputTokens:
              preapprovalPlanQualityRecoveryStreamPolicy.maxOutputTokens,
            maxStreamElapsedMs:
              preapprovalPlanQualityRecoveryStreamPolicy.maxStreamElapsedMs,
            toolChoice:
              preapprovalPlanQualityRecoveryStreamPolicy.toolChoice ?? null,
            stopClass: preapprovalPlanQualityRecoveryStreamPolicy.stopClass,
          }
        : null,
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
    effectiveCurrentMaxTokens,
    effectiveMaxOutputEscalations,
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
  const completionClass = classifyAssistantCompletion(streamResult);
  logAgentEvent("assistant_completion_classified", {
    iteration,
    completionClass,
    finishReason: streamResult.finishReason || null,
    contentChars: streamResult.content.length,
    reasoningChars: (streamResult.reasoningContent || "").length,
    toolCalls: streamResult.toolCalls?.length || 0,
    contextLimitUnchanged: snapshotContextLimit ?? null,
  });

  return { status: "streamed", streamResult };
}
