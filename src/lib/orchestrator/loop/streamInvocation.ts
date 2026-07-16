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
  MAX_NO_ACTION_RETRIES,
  prepareMessagesForToolProtocol,
  summarizeMessagesForDiagnostics,
  summarizeToolsForDiagnostics,
} from "../../orchestrator";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import type { OpenAiToolChoice, StreamResult } from "../../streaming";
import { annotateRequiredToolCallProtocolResult } from "../../requiredToolProtocol";
import type { ToolDefinition } from "../../toolSchemas";
import {
  buildPlanTaskEvidenceAudit,
  type PlanExecutionEvidenceEntry,
  type PlanTask,
} from "../../workflowModels";
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

export function resolveApprovedPlanRecoveryPreferredToolNames(input: {
  tasks: PlanTask[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
}): string[] {
  const audit = buildPlanTaskEvidenceAudit({
    tasks: input.tasks,
    evidenceLedger: input.evidenceLedger,
    preserveMissing: true,
    highlightNext: true,
  });
  const evidenceKinds = new Set(
    audit.remainingTasks.flatMap((task) => (task.evidence || []).map((item) => item.kind)),
  );
  const namedTools = audit.remainingTasks
    .flatMap((task) => task.evidence || [])
    .filter((item) => item.kind === "tool")
    .map((item) => item.value)
    .filter(Boolean);

  const preferred: string[] = [...namedTools];
  if (evidenceKinds.has("browser_dom") || evidenceKinds.has("browser_screenshot")) {
    preferred.push("browser_evaluate");
  }
  if (evidenceKinds.has("cmd")) {
    preferred.push("run_command", "execute_command");
  }
  if (evidenceKinds.has("dev_server_url")) {
    preferred.push("execute_command", "browser_evaluate");
  }
  if (evidenceKinds.has("file") || evidenceKinds.has("deliverable") || evidenceKinds.has("text")) {
    preferred.push("apply_patch", "replace_in_file", "write_file");
  }

  return [...new Set(preferred)];
}

export function resolveRecoveryToolChoice(input: {
  isExecuteRecoveryEligible: boolean;
  executeRecoveryMode: ExecuteRecoveryMode;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  llmToolNames: string[];
  forceXmlTools: boolean;
  preferExplicitFunction?: boolean;
  preapprovalPlanQualityRecoveryToolChoice?: "required";
  approvedPlanRecoveryPreferredToolNames?: string[];
  recoveryActionContract?: RecoveryActionContract;
}): OpenAiToolChoice | undefined {
  const availableToolNames = new Set(input.llmToolNames);
  if (availableToolNames.size <= 0 || input.forceXmlTools) return undefined;
  const recoveryActionContract = input.recoveryActionContract ||
    resolveExecuteRecoveryActionContract(input.executeRecoveryMode);
  const executeRecoveryRequiresAction =
    input.isExecuteRecoveryEligible && recoveryActionContract.phase !== "normal";
  const approvedPlanRecoveryRequiresAction =
    input.approvedPlanActionOnlyRecoveryActive ||
    input.approvedPlanNoToolRecoveryFileReadActive;
  const requiresTool = executeRecoveryRequiresAction ||
    approvedPlanRecoveryRequiresAction ||
    input.preapprovalPlanQualityRecoveryToolChoice === "required";
  if (!requiresTool) return undefined;

  if (input.preferExplicitFunction) {
    // Joining a running child releases a scope lease and must remain eligible
    // ahead of any new parent action. A named function choice would wrongly
    // quarantine this contract-owned coordination call.
    if (availableToolNames.has("wait_subagents")) return "required";
    const firstAvailable = (candidates: string[]): string | null =>
      candidates.find((name) => availableToolNames.has(name)) || null;
    let selectedTool: string | null = null;
    if (input.isExecuteRecoveryEligible) {
      if (recoveryActionContract.nextRequiredCapability === "targeted_read") {
        selectedTool = firstAvailable(["read_file"]);
      } else if (recoveryActionContract.nextRequiredCapability === "mutation") {
        // Mutation is a capability, not one concrete function. apply_patch,
        // replace_in_file, write_file, and scoped MCP edits are equivalent
        // legal implementations of this phase, so keep the call required but
        // let the model choose from the already-filtered tool surface.
        selectedTool = null;
      } else if (recoveryActionContract.nextRequiredCapability === "observe_pty") {
        // A running foreground process may be waiting for interactive input.
        // Keep the call required, but do not bind compatibility models to a
        // read-only observer and thereby hide send_pty_input forever.
        selectedTool = null;
      } else if (recoveryActionContract.nextRequiredCapability === "browser_validation") {
        selectedTool = firstAvailable(["browser_evaluate"]);
      } else if (recoveryActionContract.nextRequiredCapability === "launch_long_process") {
        selectedTool = firstAvailable(["execute_command"]);
      } else if (recoveryActionContract.nextRequiredCapability === "recover_process") {
        // Failed/stopped processes need a choice between reading retained PTY
        // diagnostics, repairing the current target, running a bounded check,
        // or restarting. A forced execute_command would skip that evidence.
        selectedTool = null;
      } else if (recoveryActionContract.nextRequiredCapability === "reconcile_server") {
        selectedTool = firstAvailable(["run_command"]);
      } else if (input.executeRecoveryMode === "finite_validation_only") {
        selectedTool = firstAvailable(["run_command"]);
      } else if (recoveryActionContract.nextRequiredCapability === "validation") {
        // This state can require a finite test, a long-lived dev server, a
        // browser assertion, or a diff check. Binding local models to the
        // first available function previously forced long-running `npm run
        // dev` through run_command. Keep the call required but let the model
        // select from the already-scoped validation surface.
        selectedTool = null;
      }
    }
    // Action-only Plan recovery can close different evidence kinds. Preferred
    // names order the prompt/surface but do not turn a multi-capability phase
    // into an exact function contract.
    if (!selectedTool && input.approvedPlanNoToolRecoveryFileReadActive) {
      selectedTool = firstAvailable(["read_file"]);
    }
    if (selectedTool) {
      return { type: "function", function: { name: selectedTool } };
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
    }
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
  recoveryActionContract: RecoveryActionContract;
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
    recoveryActionContract,
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
  const approvedPlanRecoveryPreferredToolNames = approvedPlanActionOnlyRecoveryActive
    ? resolveApprovedPlanRecoveryPreferredToolNames({
        tasks: callbacks.getPlanTasks(),
        evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
      })
    : [];
  const recoveryToolChoice = resolveRecoveryToolChoice({
    isExecuteRecoveryEligible,
    executeRecoveryMode,
    approvedPlanActionOnlyRecoveryActive,
    approvedPlanNoToolRecoveryFileReadActive,
    llmToolNames: llmTools.map((tool) => tool.function.name),
    forceXmlTools,
    preferExplicitFunction: config.activeProfile === "local",
    preapprovalPlanQualityRecoveryToolChoice:
      preapprovalPlanQualityRecoveryStreamPolicy.toolChoice,
    approvedPlanRecoveryPreferredToolNames,
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
    approvedPlanRecoveryPreferredToolNames,
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
      responseFormat: responseSchema,
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
