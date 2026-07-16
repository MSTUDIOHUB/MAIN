import { buildChatFinalSynthesisPrompt, buildMaxStepsFinalTextPrompt } from "../../agentLoopSafety";
import {
  resolveExecuteRecoveryActionContract,
  summarizeRepeatedExecuteTargets,
  type ExecuteRecoveryMode,
  type RecoveryActionContract,
} from "../../executeRecoveryTools";
import { classifyAssistantCompletion } from "../../normalizedTurn";
import {
  fetchLLMStream,
  logAgentEvent,
  prepareMessagesForToolProtocol,
  summarizeMessagesForDiagnostics,
  summarizeToolsForDiagnostics,
} from "../../orchestrator";
import type { ResolvedUserIntent } from "../../runIntent";
import type { OpenAiToolChoice, StreamResult } from "../../streaming";
import { annotateRequiredToolCallProtocolResult } from "../../requiredToolProtocol";
import type { ToolDefinition } from "../../toolSchemas";
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

// Shared timeout policy for the bounded approved-Plan watchdog retry. It no
// longer activates or narrows an action-only tool surface.
export const APPROVED_PLAN_ACTION_REQUIRED_STREAM_MAX_ELAPSED_MS = 45_000;

export function resolveRecoveryToolChoice(input: {
  isExecuteRecoveryEligible: boolean;
  executeRecoveryMode: ExecuteRecoveryMode;
  llmToolNames: string[];
  forceXmlTools: boolean;
  preferExplicitFunction?: boolean;
  preapprovalPlanQualityRecoveryToolChoice?: "required";
  recoveryActionContract?: RecoveryActionContract;
}): OpenAiToolChoice | undefined {
  const availableToolNames = new Set(input.llmToolNames);
  if (availableToolNames.size <= 0 || input.forceXmlTools) return undefined;
  const recoveryActionContract = input.recoveryActionContract ||
    resolveExecuteRecoveryActionContract(input.executeRecoveryMode);
  const executeRecoveryRequiresAction =
    input.isExecuteRecoveryEligible && recoveryActionContract.phase !== "normal";
  const requiresTool = executeRecoveryRequiresAction ||
    input.preapprovalPlanQualityRecoveryToolChoice === "required";
  if (!requiresTool) return undefined;

  if (input.preferExplicitFunction) {
    // Joining a running child releases a scope lease and must remain eligible
    // ahead of any new parent action. A named function choice would wrongly
    // quarantine this contract-owned coordination call.
    if (availableToolNames.has("wait_subagents")) return "required";
    const requirement = recoveryActionContract.toolCallRequirement;
    if (
      input.isExecuteRecoveryEligible &&
      requirement.kind === "required_named" &&
      availableToolNames.has(requirement.toolName)
    ) {
      return { type: "function", function: { name: requirement.toolName } };
    }
  }

  return "required";
}

export type InitialStreamInvocationResult =
  | {
      status: "streamed";
      streamResult: StreamResult;
      /** Exact logical message array passed to fetchLLMStream for this result. */
      messagesSentToLLM: AgentMessage[];
    };

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
  recoveryActionContract: RecoveryActionContract;
  isExecuteRecoveryEligible: boolean;
  finalTextOnlyStep: boolean;
  chatFinalSynthesisActive: boolean;
  chatFinalSynthesisReason: string;
  usedChatFinalSynthesisPrompt: boolean;
  markChatFinalSynthesisPromptUsed: () => void;
  recentToolActivity: PlanToolActivitySummary[];
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
    recoveryActionContract,
    isExecuteRecoveryEligible,
    finalTextOnlyStep,
    chatFinalSynthesisActive,
    chatFinalSynthesisReason,
    usedChatFinalSynthesisPrompt,
    markChatFinalSynthesisPromptUsed,
    recentToolActivity,
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
    callbacks.getIsPlanApproved() &&
    runtimeIntent === "execute" &&
    isExecuteRecoveryEligible && recoveryActionContract.phase !== "normal";
  const recoveryStreamMaxElapsedMs = approvedPlanRecoveryStreamMaxElapsedMs;
  const childStreamBounded = (callbacks.getSubagentDepth?.() ?? 0) > 0;
  const normalApprovedLocalExecutionBounded =
    config.activeProfile === "local" &&
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
    llmToolNames: llmTools.map((tool) => tool.function.name),
    forceXmlTools,
    preferExplicitFunction: config.activeProfile === "local",
    preapprovalPlanQualityRecoveryToolChoice:
      preapprovalPlanQualityRecoveryStreamPolicy.toolChoice,
    recoveryActionContract,
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
    recoveryPhase: recoveryActionContract.phase,
    nextRequiredCapability: recoveryActionContract.nextRequiredCapability,
    recoveryToolSurface: recoveryActionContract.surfaceDescription,
    allowExecuteRecoveryFileRead,
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

  const rawStreamResult = await fetchLLMStream(
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
    },
  );
  const streamResult = annotateRequiredToolCallProtocolResult(
    rawStreamResult,
    recoveryToolChoice,
    llmTools.map((tool) => tool.function.name),
  );
  if (streamResult.protocolViolation) {
    logAgentEvent("required_tool_call_protocol_violation", {
      iteration,
      violation: streamResult.protocolViolation,
      toolChoice: recoveryToolChoice ?? null,
      expectedTool: streamResult.protocolExpectedTool || null,
      actualTools: streamResult.protocolActualTools || [],
      allowedTools: streamResult.protocolAllowedTools || llmTools.map((tool) => tool.function.name),
      availableTools: llmTools.map((tool) => tool.function.name),
      finishReason: streamResult.finishReason || null,
      visibleChars: streamResult.content.length,
    });
  }

  if (llmTools.length > 0) {
    callbacks.onProviderNativeToolSuccess?.();
  }
  const completionClass = classifyAssistantCompletion(streamResult);
  if (callbacks.onDebugEvent) callbacks.onDebugEvent("agent.assistant_completion_classified", {
    iteration,
    completionClass,
    finishReason: streamResult.finishReason || null,
    contentChars: streamResult.content.length,
    reasoningChars: (streamResult.reasoningContent || "").length,
    toolCalls: streamResult.toolCalls?.length || 0,
    protocolViolation: streamResult.protocolViolation ?? null,
    contextLimitUnchanged: snapshotContextLimit ?? null,
  });
  else logAgentEvent("assistant_completion_classified", {
    iteration,
    completionClass,
    finishReason: streamResult.finishReason || null,
    contentChars: streamResult.content.length,
    reasoningChars: (streamResult.reasoningContent || "").length,
    toolCalls: streamResult.toolCalls?.length || 0,
    contextLimitUnchanged: snapshotContextLimit ?? null,
  });

  return { status: "streamed", streamResult, messagesSentToLLM: messagesForLLM };
}
