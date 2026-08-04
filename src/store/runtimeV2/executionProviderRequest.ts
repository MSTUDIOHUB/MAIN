import {
  deriveBudgetedStreamSettings,
  deriveProviderAdapterCapabilities,
} from "../../lib/providerLaneSettings";
import { acquireModelLane } from "../../lib/modelLaneCoordinator";
import {
  streamChatCompletion,
  type OpenAiToolChoice,
} from "../../lib/streaming";
import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  normalizeProviderResponseV1,
  type RuntimeV2Command,
  type RuntimeV2NormalizedProviderResult,
} from "../../lib/runtime-v2";
import {
  aggregateForCurrentTurn,
  compactTextEnvelopeCatalog,
  buildRuntimeV2DecisionView,
  boundRuntimeV2ProviderConversation,
  containsProviderTextEnvelopePrompt,
  deriveRuntimeV2ProviderEffectFacts,
  materializedRuntimeV2SourceCoverage,
  preferredFiniteValidationCommand,
  providerHistory,
  recordApprovedPlanContext,
  type RuntimeV2ExecutionPortsInput,
  type RuntimeV2LiveExecutionState,
} from "./executionContext";
import {
  prioritizeRuntimeV2ProviderToolDefinitions,
} from "./executionProviderTools";
import {
  deriveRuntimeV2ExecutionContract,
  deriveRuntimeV2ExecutionContractRepair,
  runtimeV2ExecutionContractReadWindow,
  runtimeV2ExecutionContractRequired,
} from "./executionContract";
import { deriveRuntimeV2ExecutionContractAdvance } from "./executionContractAdvance";
import {
  runtimeV2EvidenceOnlyDecisionConversation,
} from "./executionContractFormation";
import {
  deriveRuntimeV2ValidationCorrectionWindow,
} from "./executionValidationCorrection";
import {
  providerModeInstruction,
} from "./executionProviderInstruction";
import {
  RUNTIME_V2_EXECUTION_ACTIONLESS_CHAR_LIMIT,
  RUNTIME_V2_EXECUTION_CONTRACT_ACTIONLESS_CHAR_LIMIT,
  RUNTIME_V2_EXECUTION_CONTRACT_REASONING_RECOVERY_CHAR_LIMIT,
  RUNTIME_V2_EXECUTION_REASONING_ONLY_CHAR_LIMIT,
  RUNTIME_V2_EXECUTION_REQUIRED_ACTIONLESS_CHAR_LIMIT,
  providerMessageChars,
  runtimeV2CurrentToolSurfaceInstruction,
  runtimeV2ExecutionEffectiveToolChoice,
  runtimeV2ExecutionProviderOutputTokenLimit,
  runtimeV2ExecutionReasoningRequest,
  runtimeV2ProviderOutputWasTruncated,
  shouldRetryRuntimeV2WithoutReasoning,
} from "./executionProviderRequestPolicy";

export * from "./executionProviderRequestPolicy";

export {
  providerModeInstruction,
  runtimeV2EditableSourceAnchor,
} from "./executionProviderInstruction";

export async function requestRuntimeV2ProviderOnce(input: {
  live: RuntimeV2LiveExecutionState;
  ports: RuntimeV2ExecutionPortsInput;
  command: RuntimeV2Command;
  tools: ToolDefinition[];
  textEnvelope: boolean;
  toolChoice: OpenAiToolChoice | null;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<RuntimeV2NormalizedProviderResult> {
  const state = input.ports.get();
  const budget = input.ports.context.runtimeContextBudget;
  const settings = deriveBudgetedStreamSettings(state.config, budget);
  const adapterCapabilities = deriveProviderAdapterCapabilities(
    settings,
  );
  input.live.latestProviderAssistantReasoning = null;
  const requestMode = String(input.command.payload.mode || "").trim();
  const reasoningOnlyCharLimit =
    requestMode === "execute" || requestMode === "validate"
      ? RUNTIME_V2_EXECUTION_REASONING_ONLY_CHAR_LIMIT
      : undefined;
  let streamedText = "";
  recordApprovedPlanContext(input.ports);
  const history = providerHistory(input.live, input.ports);
  const sealedPreferredValidation = String(input.command.payload.mode || "") === "validate"
    ? preferredFiniteValidationCommand(input.ports)
    : "";
  const aggregate = aggregateForCurrentTurn(input.ports);
  const providerEffectFacts = deriveRuntimeV2ProviderEffectFacts(aggregate);
  const executionContract = deriveRuntimeV2ExecutionContract(aggregate);
  const executionContractRequired =
    runtimeV2ExecutionContractRequired(aggregate);
  const executionContractReadWindow =
    runtimeV2ExecutionContractReadWindow(aggregate);
  const executionContractAdvance =
    deriveRuntimeV2ExecutionContractAdvance(aggregate);
  const executionContractRepair =
    deriveRuntimeV2ExecutionContractRepair(aggregate);
  const validationCorrection =
    deriveRuntimeV2ValidationCorrectionWindow(aggregate);
  const preferredValidation = validationCorrection.validationCommandUnavailable
    ? ""
    : sealedPreferredValidation;
  const contractFormationDecision =
    (executionContractRequired && executionContractReadWindow.closed) ||
    !!executionContractRepair;
  const contractOnlyAction =
    contractFormationDecision &&
    input.tools.length === 1 &&
    input.tools[0]?.function.name === "record_execution_contract";
  const maxOutputTokens = runtimeV2ExecutionProviderOutputTokenLimit(
    input.command,
    input.textEnvelope,
    budget,
    input.live.latestProviderActionWindow,
    contractOnlyAction,
  );
  const canonicalDecisionConversation = budget
    ? boundRuntimeV2ProviderConversation(
        history.messages,
        {
          contextLimit: budget.contextLimit,
          reservedOutputTokens: maxOutputTokens,
        },
        providerEffectFacts,
      )
    : buildRuntimeV2DecisionView(
        history.messages,
        providerEffectFacts,
      );
  input.live.latestProviderRequestSourceCoverage =
    materializedRuntimeV2SourceCoverage(
      canonicalDecisionConversation,
      input.ports.context.runWorkspace || "",
      providerEffectFacts,
    );
  const providerTools = prioritizeRuntimeV2ProviderToolDefinitions({
    command: input.command,
    tools: input.tools,
    hasMaterializedSourceEvidence:
      input.live.latestProviderRequestSourceCoverage.length > 0,
  });
  const toolNames = new Set(
    providerTools.map((tool) => tool.function.name),
  );
  const effectPressure =
    input.command.payload.effectPressure &&
      typeof input.command.payload.effectPressure === "object" &&
      !Array.isArray(input.command.payload.effectPressure)
      ? input.command.payload.effectPressure as Record<string, unknown>
      : null;
  const sourceOnlyFrontier =
    effectPressure?.reason === "source_only_frontier" &&
    input.live.latestProviderRequestSourceCoverage.length > 0;
  const recoveryPressure =
    input.command.payload.recoveryPressure &&
      typeof input.command.payload.recoveryPressure === "object" &&
      !Array.isArray(input.command.payload.recoveryPressure)
      ? input.command.payload.recoveryPressure as Record<string, unknown>
      : null;
  const recoveringFromRejectedAction =
    recoveryPressure?.reason === "repeated_action_rejected";
  const actionWindow = input.live.latestProviderActionWindow;
  const hasMutationTool =
    toolNames.has("replace_in_file") ||
    toolNames.has("apply_patch") ||
    toolNames.has("write_file");
  const structuredActionRequired =
    contractOnlyAction ||
    !!actionWindow ||
    executionContractAdvance.required ||
    validationCorrection.active ||
    validationCorrection.validationCommandUnavailable ||
    recoveringFromRejectedAction;
  const recoveryStage = String(recoveryPressure?.stage || "").trim();
  const forceStructuredAction = structuredActionRequired;
  const boundedConversation = structuredActionRequired
    ? runtimeV2EvidenceOnlyDecisionConversation(
        canonicalDecisionConversation,
      )
    : canonicalDecisionConversation;
  const effectiveToolChoice = runtimeV2ExecutionEffectiveToolChoice({
    requested: input.toolChoice,
    tools: providerTools,
    textEnvelope: input.textEnvelope,
    forceStructuredAction,
  });
  const actionOnlyCharLimit =
    requestMode === "execute" || requestMode === "validate"
      ? structuredActionRequired
        ? contractOnlyAction
          ? RUNTIME_V2_EXECUTION_CONTRACT_ACTIONLESS_CHAR_LIMIT
          : RUNTIME_V2_EXECUTION_REQUIRED_ACTIONLESS_CHAR_LIMIT
        : RUNTIME_V2_EXECUTION_ACTIONLESS_CHAR_LIMIT
      : undefined;
  const derivedReasoningRequest = runtimeV2ExecutionReasoningRequest({
    configured: settings.reasoningRequest,
    sourceOnlyFrontier,
    hasMutationTool,
    providerSupportsReasoningToggle:
      adapterCapabilities.reasoningToggle,
    contractOnlyAction,
    structuredActionRequired,
    recoveringFromRejectedAction,
    recoveryStage,
    actionWindow,
  });
  const reasoningRequest = derivedReasoningRequest;
  const requestSettings = reasoningRequest === settings.reasoningRequest
    ? settings
    : {
        ...settings,
        reasoningRequest,
        preserveAssistantReasoning: false,
      };
  const decisionInstruction = {
    role: "system" as const,
    content: [
      providerModeInstruction(
        input.command,
        preferredValidation,
        {
          hasReadFile: toolNames.has("read_file"),
          hasMutation: hasMutationTool,
          hasSpawnSubagent: toolNames.has("spawn_subagent"),
          hasWaitSubagents: toolNames.has("wait_subagents"),
          hasMaterializedSourceEvidence:
            input.live.latestProviderRequestSourceCoverage.length > 0,
          sourceOnlyFrontier,
          materializedSourceCoverage:
            input.live.latestProviderRequestSourceCoverage,
          actionWindow,
          executionContract: validationCorrection.active
            ? null
            : executionContract,
          executionContractRequired,
          executionContractReadWindowClosed:
            executionContractReadWindow.closed,
          executionContractRepairAttempts:
            executionContractRepair?.attempts || 0,
          executionContractAdvanceRequired:
            executionContractAdvance.required,
          executionContractCommittedTargets:
            executionContractAdvance.committedTargets,
          executionContractPendingTargets:
            executionContractAdvance.pendingTargets,
          executionContractSourceReviewAvailable:
            executionContractAdvance.sourceReviewAvailable,
          executionContractSourceReviewTargets:
            executionContractAdvance.sourceReviewTargets,
          validationCorrectionActive: validationCorrection.active,
          validationCommandUnavailable:
            validationCorrection.validationCommandUnavailable,
          failedValidationCommand:
            validationCorrection.failedValidationCommand,
          replacementValidationExhausted:
            validationCorrection.validationCommandUnavailable &&
            validationCorrection.repeatedFailedValidations >= 1,
        },
      ),
      runtimeV2CurrentToolSurfaceInstruction(
        providerTools,
        structuredActionRequired,
      ),
    ].join(" "),
  };
  const textEnvelopeInstructions = input.textEnvelope
    ? [{
        role: "system" as const,
        content: containsProviderTextEnvelopePrompt(
          input.ports.context.phaseLanguage,
          false,
        ),
      }, {
        role: "system" as const,
        content: compactTextEnvelopeCatalog(providerTools),
      }]
    : [];
  const firstNonSystemIndex = boundedConversation.findIndex((message) =>
    message.role !== "system"
  );
  const instructionIndex = firstNonSystemIndex < 0
    ? boundedConversation.length
    : firstNonSystemIndex;
  const messages = [
    ...boundedConversation.slice(0, instructionIndex),
    decisionInstruction,
    ...textEnvelopeInstructions,
    ...boundedConversation.slice(instructionIndex),
  ];
  input.ports.logStoreEvent("runtime_v2_context_prepared", {
    turnId: input.command.run.turnId,
    runId: input.command.run.runId,
    phase: input.command.phase,
    mode: String(input.command.payload.mode || ""),
    sourceReadAvailable: toolNames.has("read_file"),
    mutationToolAvailable: hasMutationTool,
    conversationHistoryMessages: boundedConversation.length,
    unboundedConversationHistoryMessages: history.historyMessages,
    priorConversationTurns: history.priorTurns,
    approximateMessageChars: messages.reduce(
      (total, message) => total + providerMessageChars(message),
      0,
    ),
    preferredValidationCommand: preferredValidation || null,
    allowedToolCount: providerTools.length,
    nativeToolCount: input.textEnvelope ? 0 : providerTools.length,
    allowedToolNames: providerTools.map((tool) => tool.function.name),
    toolChoice: effectiveToolChoice || null,
    collaborationAllowed:
      input.command.payload.collaborationAllowed === true,
    collaborationRequestMode:
      String(input.command.payload.collaborationRequestMode || "serialized"),
    remainingSubagentCapacity: Math.max(
      0,
      Math.floor(
        Number(input.command.payload.remainingSubagentCapacity) || 0,
      ),
    ),
    sourceOnlyFrontier,
    providerActionWindow: actionWindow,
    executionContractRevision: executionContract?.revision || null,
    executionContractRequired,
    executionContractSupplementalReadBatches:
      executionContractReadWindow.supplementalReadBatches,
    executionContractReadWindowClosed:
      executionContractReadWindow.closed,
    executionContractRepairAttempts:
      executionContractRepair?.attempts || 0,
    executionContractAdvanceRequired: executionContractAdvance.required,
    executionContractCommittedTargets:
      executionContractAdvance.committedTargets,
    executionContractPendingTargets:
      executionContractAdvance.pendingTargets,
    executionContractSourceReviewAvailable:
      executionContractAdvance.sourceReviewAvailable,
    executionContractSourceReviewTargets:
      executionContractAdvance.sourceReviewTargets,
    executionContractSourceReviewReceiptCount:
      executionContractAdvance.sourceReviewReceiptCount,
    validationCorrectionActive: validationCorrection.active,
    validationCorrectionRepeatedFailures:
      validationCorrection.repeatedFailedValidations,
    validationCommandUnavailable:
      validationCorrection.validationCommandUnavailable,
    failedValidationCommand:
      validationCorrection.failedValidationCommand,
    contractOnlyAction,
    structuredActionRequired,
    forceStructuredAction,
    actionOnlyCharLimit: actionOnlyCharLimit || null,
    maxOutputTokens,
    reasoningRequest: requestSettings.reasoningRequest || null,
    effectPressureActionDecoding:
      reasoningRequest === "off" &&
      settings.reasoningRequest !== "off",
    recoveryStage: recoveryPressure?.stage || null,
    recoveryOccurrence: Number(recoveryPressure?.occurrence) || 0,
    recoveryReasoningEscalated:
      reasoningRequest === "explicit" &&
      settings.reasoningRequest !== "explicit",
    decisionViewApplied: true,
    canonicalConversationMessages: history.messages.length,
    removedDecisionMessages: Math.max(
      0,
      history.messages.length - boundedConversation.length,
    ),
  });
  const requestTokenBudget = Math.max(
    2_048,
    Math.ceil(
      messages.reduce(
        (total, message) => total + providerMessageChars(message),
        0,
      ) / 4,
    ) + maxOutputTokens,
  );
  const lane = await acquireModelLane({
    config: state.config,
    contextLimit: budget?.contextLimit,
    requestTokenBudget,
    agentKind: "parent",
    signal: input.signal,
    onDebugEvent: (event, data) =>
      input.ports.logStoreEvent(event, {
        turnId: input.command.run.turnId,
        runId: input.command.run.runId,
        ...data,
      }),
  });
  let result: Awaited<ReturnType<typeof streamChatCompletion>>;
  let reasoningFallbackApplied = false;
  try {
    result = await streamChatCompletion(
      messages,
      requestSettings,
      {
        onToken: (token) => {
          lane.markFirstToken();
          streamedText += token;
        },
        onDone: () => undefined,
        onError: () => undefined,
        onLifecycle: (event) => {
          if (event.phase === "first_chunk") lane.markFirstToken();
        },
      },
      input.signal,
      input.textEnvelope ? [] : providerTools,
      maxOutputTokens,
      {
        ...(effectiveToolChoice ? { toolChoice: effectiveToolChoice } : {}),
        timeoutMs: input.timeoutMs,
        contextOwnership: "caller",
        reasoningOnlyCharLimit,
        actionOnlyCharLimit,
      },
    );
    if (
      shouldRetryRuntimeV2WithoutReasoning({
        finishReason: result.finishReason,
        reasoningChars: result.reasoningContent?.length || 0,
        actionChars:
          result.actionableContent?.length ||
          result.semanticContent?.length ||
          result.content.length,
        toolCallCount: result.toolCalls.length,
        availableToolCount: providerTools.length,
        reasoningRequest: requestSettings.reasoningRequest,
        providerSupportsReasoningToggle:
          adapterCapabilities.reasoningToggle,
        structuredActionRequired,
      })
    ) {
      reasoningFallbackApplied = true;
      input.ports.logStoreEvent(
        "runtime_v2_provider_reasoning_truncated",
        {
          turnId: input.command.run.turnId,
          runId: input.command.run.runId,
          phase: input.command.phase,
          mode: String(input.command.payload.mode || ""),
          finishReason: result.finishReason,
          reasoningChars: result.reasoningContent?.length || 0,
            actionChars:
              result.actionableContent?.length ||
              result.semanticContent?.length ||
              result.content.length,
            truncationKind: (result.reasoningContent?.length || 0) > 0
              ? "reasoning_without_action"
              : "visible_prose_without_action",
            recovery: "provider_reasoning_toggle_off",
        },
      );
      streamedText = "";
      const recoveryMessages = [
        ...messages,
        {
          role: "system" as const,
          content: [
            "ACTION_OUTPUT_BUDGET_EXHAUSTED: the previous attempt spent the bounded action output on reasoning or visible prose without producing a tool call.",
            "Do not repeat or explain the analysis. Submit exactly one currently advertised structured tool action now.",
          ].join(" "),
        },
      ];
      result = await streamChatCompletion(
        recoveryMessages,
        {
          ...requestSettings,
          reasoningRequest: "off",
          preserveAssistantReasoning: false,
        },
        {
          onToken: (token) => {
            lane.markFirstToken();
            streamedText += token;
          },
          onDone: () => undefined,
          onError: () => undefined,
          onLifecycle: (event) => {
            if (event.phase === "first_chunk") lane.markFirstToken();
          },
        },
        input.signal,
        input.textEnvelope ? [] : providerTools,
        maxOutputTokens,
        {
          ...(effectiveToolChoice ? { toolChoice: effectiveToolChoice } : {}),
          timeoutMs: input.timeoutMs,
          contextOwnership: "caller",
          // Some OpenAI-compatible local adapters acknowledge the reasoning
          // toggle but still emit hidden reasoning. The first 4k guard catches
          // that capability drift quickly; a sole schema-bound contract gets
          // one larger bounded retry so MAIN does not cancel the model just
          // before it emits the required JSON tool arguments.
          reasoningOnlyCharLimit: contractOnlyAction
            ? RUNTIME_V2_EXECUTION_CONTRACT_REASONING_RECOVERY_CHAR_LIMIT
            : reasoningOnlyCharLimit,
          actionOnlyCharLimit:
            actionOnlyCharLimit === undefined
              ? undefined
              : Math.min(actionOnlyCharLimit, 1_000),
        },
      );
    }
  } catch (error) {
    lane.reportFailure(error);
    throw error;
  } finally {
    lane.release();
  }
  const protocolContent =
    result.actionableContent || result.content || streamedText;
  const visibleText =
    result.semanticContent || streamedText;
  input.ports.logStoreEvent("runtime_v2_provider_wire_shape", {
    turnId: input.command.run.turnId,
    runId: input.command.run.runId,
    phase: input.command.phase,
    mode: String(input.command.payload.mode || ""),
    textEnvelope: input.textEnvelope,
    finishReason: result.finishReason || null,
    rawContentChars: result.content.length,
    actionableContentChars: result.actionableContent?.length || 0,
    semanticContentChars: result.semanticContent?.length || 0,
    reasoningChars: result.reasoningContent?.length || 0,
    mirrorKind: result.streamDiagnostics?.mirrorKind || null,
    nativeToolCalls: result.toolCalls.length,
    envelopeOpenMarkers:
      protocolContent.match(/<runtime-v2-tools>/g)?.length || 0,
    envelopeCloseMarkers:
      protocolContent.match(/<\/runtime-v2-tools>/g)?.length || 0,
    protocolViolation: result.protocolViolation || null,
    reasoningFallbackApplied,
  });
  const providerReasoning = String(result.reasoningContent || "").trim();
  if (
    requestSettings.preserveAssistantReasoning === true &&
    providerReasoning
  ) {
    input.live.latestProviderAssistantReasoning = {
      content: providerReasoning,
      field: result.reasoningField === "reasoning"
        ? "reasoning"
        : "reasoning_content",
    };
  }
  const outputTruncated = runtimeV2ProviderOutputWasTruncated({
    finishReason: result.finishReason,
    toolCallCount: result.toolCalls.length,
    availableToolCount: providerTools.length,
  });
  return normalizeProviderResponseV1({
    visibleText,
    content: protocolContent,
    toolCalls: result.toolCalls,
    ...(!input.textEnvelope &&
        contractOnlyAction &&
        providerTools.length === 1
      ? { requiredSingleTool: providerTools[0] }
      : {}),
    usage: result.usage,
    diagnostics: [
      ...(result.protocolViolation
        ? [{
          code: result.protocolViolation,
          message: "Provider tool protocol mismatch",
          retryable: true,
        }]
        : []),
      ...(outputTruncated
        ? [{
          code: "output_truncated",
          message:
            "Provider output reached its token limit before a structured action or complete conclusion.",
          retryable: true,
        }]
        : []),
    ],
  });
}
