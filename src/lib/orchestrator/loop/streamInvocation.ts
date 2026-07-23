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
import {
  isMutationRuntimeIntent,
  type ResolvedUserIntent,
} from "../../runIntent";
import type { OpenAiToolChoice, StreamResult } from "../../streaming";
import {
  adaptRequiredPreferredDelegationReadIntent,
  annotateRequiredToolCallProtocolResult,
  hasSuccessfulAllowedRawNativeToolCall,
} from "../../requiredToolProtocol";
import {
  SUBMIT_PLAN_CANDIDATE_TOOL_NAME,
  type ToolDefinition,
} from "../../toolSchemas";
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

// Execute streams are transactions, not open-ended prose generation. Keep the
// initial request large enough for local reasoning, then make the one recovery
// request deliberately smaller and action-only.
export const EXECUTE_STREAM_NO_VISIBLE_PROGRESS_MS = 105_000;
export const EXECUTE_STREAM_MAX_ELAPSED_MS = 120_000;
export const EXECUTE_ACTION_RETRY_MAX_ELAPSED_MS = 90_000;
export const SUBAGENT_TOOL_STREAM_MAX_OUTPUT_TOKENS = 4_096;
export const SUBAGENT_FINAL_STREAM_MAX_OUTPUT_TOKENS = 2_048;

export function capSubagentStreamMaxTokens(
  subagentDepth: number,
  currentMaxTokens: number | undefined,
  finalTextOnlyStep = false,
): number | undefined {
  if (subagentDepth <= 0) return currentMaxTokens;
  const budget = finalTextOnlyStep
    ? SUBAGENT_FINAL_STREAM_MAX_OUTPUT_TOKENS
    : SUBAGENT_TOOL_STREAM_MAX_OUTPUT_TOKENS;
  return Math.min(
    currentMaxTokens || budget,
    budget,
  );
}

export function capSubagentStreamMaxEscalations(
  subagentDepth: number,
  maxOutputEscalations: number,
  finalTextOnlyStep = false,
): number {
  if (subagentDepth <= 0) return maxOutputEscalations;
  return finalTextOnlyStep ? 0 : Math.min(maxOutputEscalations, 1);
}

export function resolveRecoveryToolChoice(input: {
  isExecuteRecoveryEligible: boolean;
  executeRecoveryMode: ExecuteRecoveryMode;
  llmToolNames: string[];
  forceXmlTools: boolean;
  preferredDelegationRequired?: boolean;
  planEvidenceObligationRequired?: boolean;
  preapprovalPlanQualityRecoveryToolChoice?: "required";
  recoveryActionContract?: RecoveryActionContract;
}): OpenAiToolChoice | undefined {
  const availableToolNames = new Set(input.llmToolNames);
  if (availableToolNames.size <= 0 || input.forceXmlTools) return undefined;
  // Drafting and rewrite expose only this runtime-control capability. Use the
  // portable required-any shape because the real schema surface already makes
  // the required function exact across OpenAI-compatible providers.
  if (
    availableToolNames.size === 1 &&
    availableToolNames.has(SUBMIT_PLAN_CANDIDATE_TOOL_NAME)
  ) {
    return "required";
  }
  if (input.planEvidenceObligationRequired && availableToolNames.size === 1) {
    return "required";
  }
  if (
    input.preferredDelegationRequired &&
    availableToolNames.has("spawn_subagent")
  ) {
    return "required";
  }
  const recoveryActionContract = input.recoveryActionContract ||
    resolveExecuteRecoveryActionContract(input.executeRecoveryMode);
  const executeRecoveryRequiresAction =
    input.isExecuteRecoveryEligible && recoveryActionContract.phase !== "normal";
  const preapprovalRequiresTool =
    input.preapprovalPlanQualityRecoveryToolChoice === "required";
  if (!executeRecoveryRequiresAction) {
    return preapprovalRequiresTool ? "required" : undefined;
  }

  const requirement = recoveryActionContract.toolCallRequirement;
  if (requirement.kind === "optional") {
    return preapprovalRequiresTool ? "required" : undefined;
  }
  if (requirement.kind === "required_named") {
    // Never translate a missing exact capability into required-any. That would
    // force the model to call an unrelated visible tool and manufacture a
    // protocol loop. XML remains prompt-driven and returned above.
    if (!availableToolNames.has(requirement.toolName)) return undefined;
    // The schema surface is already narrowed to the exact capability. Use
    // portable required-any for every provider; named function choice is not
    // part of MAIN's execution semantics and is inconsistently implemented by
    // OpenAI-compatible local servers.
    return "required";
  }

  const hasExecutableRecoveryTool = recoveryActionContract.allowsAllTools
    ? availableToolNames.size > 0
    : [...availableToolNames].some((name) =>
        recoveryActionContract.allowedToolNames.has(name) ||
        name === "wait_subagents"
      );
  if (!hasExecutableRecoveryTool) return undefined;
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
  executeRecoveryStreamMaxElapsedMs: number;
  preapprovalPlanQualityRecoveryStreamPolicy: PreapprovalPlanQualityRecoveryStreamPolicy;
  preferredDelegationRequired: boolean;
  planEvidenceObligationRequired?: boolean;
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
    executeRecoveryStreamMaxElapsedMs,
    preapprovalPlanQualityRecoveryStreamPolicy,
    preferredDelegationRequired,
    planEvidenceObligationRequired,
  } = input;
  const {
    config,
    settings,
    effectiveToolProtocol,
    runtimeProtocolProfile,
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
  const executeEvidenceRuntime =
    workflowMode === "edit" ||
    isMutationRuntimeIntent(runtimeIntent) ||
    runtimeIntent === "studio_workflow";
  const executeRecoveryStreamHardTimeoutActive =
    executeEvidenceRuntime &&
    isExecuteRecoveryEligible && recoveryActionContract.phase !== "normal";
  const recoveryStreamMaxElapsedMs = executeRecoveryStreamMaxElapsedMs;
  const subagentDepth = callbacks.getSubagentDepth?.() ?? 0;
  const childStreamBounded = subagentDepth > 0;
  const executeStreamBounded = executeEvidenceRuntime;
  const boundedNoVisibleMs = childStreamBounded || executeStreamBounded
    ? EXECUTE_STREAM_NO_VISIBLE_PROGRESS_MS
    : 0;
  const boundedMaxElapsedMs = childStreamBounded || executeStreamBounded
    ? EXECUTE_STREAM_MAX_ELAPSED_MS
    : 0;
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
            : "execute_no_visible_progress",
          maxStreamElapsedMs: minPositive(
            baseStreamWatchdogOptions.maxStreamElapsedMs,
            boundedMaxElapsedMs,
          ),
          maxStreamElapsedLabel: childStreamBounded
            ? "subagent_stream_boundary"
            : "execute_stream_boundary",
        }
      : {}),
    ...(executeRecoveryStreamHardTimeoutActive
      ? {
          maxStreamElapsedMs: minPositive(
            boundedMaxElapsedMs > 0 ? boundedMaxElapsedMs : baseStreamWatchdogOptions.maxStreamElapsedMs,
            recoveryStreamMaxElapsedMs,
          ),
          maxStreamElapsedLabel: "execute_recovery",
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
    preferredDelegationRequired,
    planEvidenceObligationRequired,
    preapprovalPlanQualityRecoveryToolChoice:
      preapprovalPlanQualityRecoveryStreamPolicy.toolChoice,
    recoveryActionContract,
  });
  const policyCurrentMaxTokens =
    capPreapprovalPlanQualityRecoveryMaxTokens(
      preapprovalPlanQualityRecoveryStreamPolicy,
      currentMaxTokens,
    );
  // Child work is deliberately narrow, but the tool phase still needs room for
  // models that reason before emitting a call. Keep that phase bounded with
  // one finite escalation; make the forced final-prose phase smaller and
  // non-escalating so report synthesis cannot become a second parent run.
  const effectiveCurrentMaxTokens = capSubagentStreamMaxTokens(
    subagentDepth,
    policyCurrentMaxTokens,
    finalTextOnlyStep,
  );
  const policyMaxOutputEscalations =
    capPreapprovalPlanQualityRecoveryMaxEscalations(
      preapprovalPlanQualityRecoveryStreamPolicy,
      maxOutputEscalations,
    );
  const effectiveMaxOutputEscalations = capSubagentStreamMaxEscalations(
    subagentDepth,
    policyMaxOutputEscalations,
    finalTextOnlyStep,
  );

  callbacks.onDebugEvent?.("agent.llm_request_shape", {
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    activeProfile: config.activeProfile,
    provider: settings.provider || "unknown",
    providerFamily: runtimeProtocolProfile.providerFamily,
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
    preferredDelegationRequired,
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
  const preferredDelegationAdaptation =
    adaptRequiredPreferredDelegationReadIntent({
      result: rawStreamResult,
      preferredDelegationRequired,
      allowedToolNames: llmTools.map((tool) => tool.function.name),
    });
  if (preferredDelegationAdaptation.adapted) {
    logAgentEvent("preferred_delegation_read_intent_adapted", {
      iteration,
      sourceToolName: preferredDelegationAdaptation.sourceToolName,
      target: preferredDelegationAdaptation.target,
      toolCallId: preferredDelegationAdaptation.toolCallId,
      adaptedToolName: "spawn_subagent",
      boundedReadOnlyIntent: true,
      providerNeutral: true,
    });
  }
  const streamResult = annotateRequiredToolCallProtocolResult(
    preferredDelegationAdaptation.result,
    recoveryToolChoice,
    llmTools.map((tool) => tool.function.name),
  );
  if (streamResult.protocolTransportAdaptation) {
    logAgentEvent("required_plan_submission_transport_adapted", {
      iteration,
      adaptation: streamResult.protocolTransportAdaptation,
      source: streamResult.protocolTransportSource || "content",
      protocolChars: streamResult.content.length,
      allowedTools: llmTools.map((tool) => tool.function.name),
      typedIngressStillRequired: true,
      providerNeutral: true,
    });
  }
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

  if (hasSuccessfulAllowedRawNativeToolCall({
    rawResult: rawStreamResult,
    normalizedResult: streamResult,
    allowedToolNames: llmTools.map((tool) => tool.function.name),
  })) {
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
