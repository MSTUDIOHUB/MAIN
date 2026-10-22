import { boundReadOnlyHistory } from "./readOnlyHistory";
import { runtimeV2TranscriptSkillGuidanceWindows } from "./executionProviderSkillTranscript";
import { computeContextBudgets, estimateMessagesTokens, estimateTokens, type TrimMessage } from "../../lib/contextTrim";
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
  runtimeV2DirectExecuteContractCoverage,
  type RuntimeV2Command,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2ProviderRecoveryPressure,
} from "../../lib/runtime-v2";
import {
  appendRuntimeV2ProviderFeedbackHistory,
  aggregateForCurrentTurn,
  compactTextEnvelopeCatalog,
  boundRuntimeV2ProviderConversation,
  containsProviderTextEnvelopePrompt,
  deriveRuntimeV2ProviderEffectFacts,
  materializedRuntimeV2SourceCoverage,
  preferredFiniteValidationCommand,
  providerHistory,
  recordApprovedPlanContext,
  restoreRuntimeV2ProviderRecoveryHistory,
  type RuntimeV2ExecutionPortsInput,
  type RuntimeV2LiveExecutionState,
} from "./executionContext";
import {
  prioritizeRuntimeV2ProviderToolDefinitions,
} from "./executionProviderTools";
import {
  deriveRuntimeV2ExecutionContract,
} from "./executionContract";
import { deriveRuntimeV2ExecutionContractAdvance } from "./executionContractAdvance";
import {
  deriveRuntimeV2ValidationCorrectionWindow,
} from "./executionValidationCorrection";
import {
  providerModeInstruction,
} from "./executionProviderInstruction";
import {
  RUNTIME_V2_EXECUTION_ACTIONLESS_CHAR_LIMIT,
  RUNTIME_V2_EXECUTION_REASONING_ONLY_CHAR_LIMIT,
  RUNTIME_V2_EXECUTION_REQUIRED_ACTIONLESS_CHAR_LIMIT,
  providerMessageChars,
  runtimeV2CurrentToolSurfaceInstruction,
  runtimeV2ExecutionEffectiveToolChoice,
  runtimeV2ExecutionProviderOutputTokenLimit,
  runtimeV2ExecutionReasoningRequest,
  runtimeV2ProviderOutputWasTruncated,
  runtimeV2RecoveryRequiresStructuredAction,
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
  input.live.latestProviderRequestSkillGuidanceWindows = [];
  const requestMode = String(input.command.payload.mode || "").trim();
  let streamedText = "";
  recordApprovedPlanContext(input.ports);
  const aggregate = aggregateForCurrentTurn(input.ports);
  restoreRuntimeV2ProviderRecoveryHistory(input.ports, aggregate, input.command);
  const history = providerHistory(input.live, input.ports);
  const sealedPreferredValidation = String(input.command.payload.mode || "") === "validate"
    ? preferredFiniteValidationCommand(input.ports)
    : "";
  const providerEffectFacts = deriveRuntimeV2ProviderEffectFacts(aggregate);
  const executionContract = deriveRuntimeV2ExecutionContract(aggregate);
  const executionContractAdvance =
    deriveRuntimeV2ExecutionContractAdvance(aggregate);
  const validationCorrection =
    deriveRuntimeV2ValidationCorrectionWindow(aggregate);
  const preferredValidation = validationCorrection.validationCommandUnavailable
    ? ""
    : sealedPreferredValidation;
  const maxOutputTokens = runtimeV2ExecutionProviderOutputTokenLimit(
    input.command,
    input.textEnvelope,
    budget,
    input.live.latestProviderActionWindow,
  );
  const readOnly = requestMode === "chat" || requestMode === "analyze" || input.command.payload.conclusionKind === "read_only";
  const canonicalDecisionConversation = history.messages;
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
  let sourceOnlyFrontier =
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
  const structuredActionRequired = !readOnly && (
    !!actionWindow ||
    executionContractAdvance.required ||
    validationCorrection.active ||
    validationCorrection.validationCommandUnavailable ||
    recoveringFromRejectedAction ||
    runtimeV2RecoveryRequiresStructuredAction(
      recoveryPressure as RuntimeV2ProviderRecoveryPressure | null,
    ));
  const recoveryStage = String(recoveryPressure?.stage || "").trim();
  const reasoningOnlyCharLimit = structuredActionRequired
    ? RUNTIME_V2_EXECUTION_REASONING_ONLY_CHAR_LIMIT
    : null;
  const forceStructuredAction = structuredActionRequired;
  const effectiveToolChoice = runtimeV2ExecutionEffectiveToolChoice({
    requested: input.toolChoice,
    tools: providerTools,
    textEnvelope: input.textEnvelope,
    forceStructuredAction,
  });
  const actionOnlyCharLimit =
    requestMode === "execute" || requestMode === "validate"
      ? structuredActionRequired
        ? RUNTIME_V2_EXECUTION_REQUIRED_ACTIONLESS_CHAR_LIMIT
        : RUNTIME_V2_EXECUTION_ACTIONLESS_CHAR_LIMIT
      : undefined;
  const derivedReasoningRequest = runtimeV2ExecutionReasoningRequest({
    configured: settings.reasoningRequest,
    providerSupportsReasoningToggle:
      adapterCapabilities.reasoningToggle,
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
  const decisionInstructionFor = (coverage: typeof input.live.latestProviderRequestSourceCoverage) => ({
    role: "system" as const,
    content: [
      aggregate?.strategy === "execute" && executionContract
        ? `Execution contract coverage (current mutation boundary): ${JSON.stringify(runtimeV2DirectExecuteContractCoverage(aggregate))}. Complete the missing targets and declared checks before a success report.`
        : "",
      providerModeInstruction(
        input.command,
        preferredValidation,
        {
          hasReadFile: toolNames.has("read_file"),
          hasMutation: hasMutationTool,
          hasCreateFile: toolNames.has("write_file"),
          hasSpawnSubagent: toolNames.has("spawn_subagent"),
          hasWaitSubagents: toolNames.has("wait_subagents"),
          hasMaterializedSourceEvidence:
            coverage.length > 0,
          sourceOnlyFrontier: effectPressure?.reason === "source_only_frontier" && coverage.length > 0,
          materializedSourceCoverage:
            coverage,
          actionWindow,
          executionContract: validationCorrection.active
            ? null
            : executionContract,
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
  });
  const textEnvelopeInstructions = input.textEnvelope
    ? [{
        role: "system" as const,
        content: containsProviderTextEnvelopePrompt(
          input.ports.context.phaseLanguage,
          structuredActionRequired,
        ),
      }, {
        role: "system" as const,
        content: compactTextEnvelopeCatalog(providerTools),
      }]
    : [];
  const toolsClosed =
    requestMode === "conclude" ||
    input.command.payload.conclusionKind === "read_only" ||
    providerTools.length === 0 ||
    (Array.isArray(input.command.payload.allowedToolNames) && input.command.payload.allowedToolNames.length === 0);
  const concludePrompt =
    "All tools are closed. Deliver the final Markdown answer directly from the conversation and available evidence, and do not output <tool_call> tags.";
  const concludeInstructions = toolsClosed ? [{ role: "user" as const, content: concludePrompt }] : [];
  const initialCoverage = input.live.latestProviderRequestSourceCoverage;
  const inputBudget = budget ? budget.inputBudget ?? computeContextBudgets(budget.contextLimit, maxOutputTokens).inputBudget : null;
  const toolSchemaTokens = estimateTokens(JSON.stringify(input.textEnvelope ? [] : providerTools));
  const assembleExecuteRequest = (conversation: typeof canonicalDecisionConversation) => {
    const sourceCoverage = materializedRuntimeV2SourceCoverage(
      conversation, input.ports.context.runWorkspace || "", providerEffectFacts,
    );
    // Reserve both guidance shapes before pressure eviction. The empty-source
    // branch may be longer than a short source anchor.
    const fixedTokens = Math.max(...[sourceCoverage, []].map((coverage) =>
      estimateMessagesTokens([decisionInstructionFor(coverage), ...textEnvelopeInstructions, ...concludeInstructions] as TrimMessage[])
    ));
    const standard = budget && inputBudget !== null
      ? boundRuntimeV2ProviderConversation(conversation, {
          contextLimit: budget.contextLimit, reservedOutputTokens: maxOutputTokens,
          inputBudget: inputBudget - toolSchemaTokens - fixedTokens,
        }, providerEffectFacts)
      : conversation;
    const coverage = materializedRuntimeV2SourceCoverage(
      standard, input.ports.context.runWorkspace || "", providerEffectFacts,
    );
    // Recovery changes the frontier guidance, never the roles or bytes of
    // surviving canonical assistant/tool groups. Source authority derives
    // only from those exact receipts in the request being sent.
    const assembled = [...standard, decisionInstructionFor(coverage), ...textEnvelopeInstructions, ...concludeInstructions];
    const tokens = estimateMessagesTokens(assembled as TrimMessage[]) + toolSchemaTokens;
    if (inputBudget !== null && tokens > inputBudget) {
      input.live.latestProviderRequestSourceCoverage = [];
      throw new Error("RUNTIME_CONTEXT_BUDGET_EXCEEDED: complete provider request exceeds the Run input budget");
    }
    return { standard, messages: assembled, coverage, tokens };
  };
  const executeRequest = readOnly ? null : assembleExecuteRequest(canonicalDecisionConversation);
  const standardConversation = executeRequest?.standard || canonicalDecisionConversation;
  const boundedConversation = executeRequest?.standard || canonicalDecisionConversation;
  const decisionInstruction = decisionInstructionFor(initialCoverage);
  const unboundedMessages = [
    // Keep stable instructions, objectives and receipt pairs as the cacheable
    // prefix. Per-decision authority and protocol guidance belong at the
    // current frontier, after the evidence they govern.
    ...boundedConversation,
    decisionInstruction,
    ...textEnvelopeInstructions,
  ];
  const boundedMessages = readOnly && budget ? boundReadOnlyHistory(unboundedMessages, {
    contextLimit: budget.contextLimit,
    reservedOutputTokens: maxOutputTokens + (toolsClosed ? 40 : 0),
    tools: providerTools,
  }) : unboundedMessages;
  const messages = executeRequest?.messages || (
    toolsClosed && boundedMessages[boundedMessages.length - 1]?.content !== concludePrompt
      ? [...boundedMessages, { role: "user" as const, content: concludePrompt }]
      : boundedMessages);
  input.live.latestProviderRequestSourceCoverage = executeRequest?.coverage || materializedRuntimeV2SourceCoverage(
      messages, input.ports.context.runWorkspace || "", providerEffectFacts,
    );
  input.live.latestProviderRequestSkillGuidanceWindows = runtimeV2TranscriptSkillGuidanceWindows(messages)
    .map(({ documentKey, version, returnedRange, readTarget }) => ({ documentKey, version, returnedRange, readTarget }));
  sourceOnlyFrontier = effectPressure?.reason === "source_only_frontier" && input.live.latestProviderRequestSourceCoverage.length > 0;
  const estimatedInputTokens = estimateMessagesTokens(messages as TrimMessage[]) + toolSchemaTokens;
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
    approximateToolSchemaChars: JSON.stringify(providerTools).length,
    preferredValidationCommand: preferredValidation || null,
    allowedToolCount: providerTools.length,
    nativeToolCount: input.textEnvelope ? 0 : providerTools.length,
    allowedToolNames: providerTools.map((tool) => tool.function.name),
    toolChoice: effectiveToolChoice || null,
    collaborationAllowed:
      input.command.payload.collaborationAllowed === true,
    collaborationPreferred:
      input.command.payload.collaborationPreferred === true,
    spawnSubagentAvailable: toolNames.has("spawn_subagent"),
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
    structuredActionRequired,
    forceStructuredAction,
    actionOnlyCharLimit: actionOnlyCharLimit || null,
    maxOutputTokens,
    inputBudget,
    estimatedInputTokens,
    reasoningRequest: requestSettings.reasoningRequest || null,
    effectPressureActionDecoding:
      reasoningRequest === "off" &&
      settings.reasoningRequest !== "off",
    recoveryStage: recoveryPressure?.stage || null,
    recoveryOccurrence: Number(recoveryPressure?.occurrence) || 0,
    recoveryReasoningEscalated:
      reasoningRequest === "explicit" &&
      settings.reasoningRequest !== "explicit",
    decisionViewApplied: !readOnly && (standardConversation.length !== canonicalDecisionConversation.length || standardConversation.some((message, index) => message !== canonicalDecisionConversation[index])),
    contextPolicy: readOnly ? "read_only_budget" : "execute_decision",
    canonicalConversationMessages: history.messages.length,
    visibleSkillGuidanceWindows: input.live.latestProviderRequestSkillGuidanceWindows.length,
    visibleSkillGuidanceDocuments: new Set(input.live.latestProviderRequestSkillGuidanceWindows.map(window => window.documentKey)).size,
    removedDecisionMessages: Math.max(
      0,
      readOnly ? unboundedMessages.length - messages.length : history.messages.length - boundedConversation.length,
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
          if (event.phase === "model_progress") lane.markFirstToken();
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
        clientStopReason: result.clientStopReason,
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
          stopSource: result.clientStopReason ? "client_guard" : "provider",
          clientStopReason: result.clientStopReason || null,
          reasoningChars: result.reasoningContent?.length || 0,
            actionChars:
              result.actionableContent?.length ||
              result.semanticContent?.length ||
              result.content.length,
            truncationKind: (result.reasoningContent?.length || 0) > 0
              ? "reasoning_without_action"
              : "visible_prose_without_action",
            recovery: adapterCapabilities.reasoningToggle
              ? "provider_reasoning_toggle_off"
              : "bounded_structured_action_feedback",
        },
      );
      const truncatedVisibleText = result.semanticContent || streamedText;
      streamedText = "";
      const recoveryRequiresAction = !toolsClosed &&
        (structuredActionRequired || !readOnly);
      const recoveryHistoryStart = input.live.messages.length;
      appendRuntimeV2ProviderFeedbackHistory(input.live, {
        visibleText: truncatedVisibleText,
        code: "output_truncated",
        feedback: recoveryRequiresAction
          ? [
              result.clientStopReason
                ? `CLIENT_OUTPUT_GUARD_REACHED: the client's ${result.clientStopReason} guard ended the previous decision before a tool call.`
                : "ACTION_OUTPUT_BUDGET_EXHAUSTED: the previous attempt spent the bounded action output on reasoning or visible prose without producing a tool call.",
              "Do not repeat or explain the analysis. Submit exactly one currently advertised structured tool action now.",
            ].join(" ")
          : [
              result.clientStopReason
                ? `CLIENT_OUTPUT_GUARD_REACHED: the client's ${result.clientStopReason} guard ended the previous incomplete answer.`
                : "ANSWER_OUTPUT_BUDGET_EXHAUSTED: the previous attempt reached the output limit without a complete answer. Its draft is incomplete and is not an accepted conclusion.",
              "Do not repeat the analysis or continue the unfinished draft. Return one complete concise answer from the available evidence, stating any uncertainty.",
              toolsClosed
                ? "No tools are available in this decision."
                : "If a specific missing fact still requires verification, the currently advertised tools remain available.",
            ].join(" "),
      });
      const unboundedRecoveryMessages = [
        ...messages,
        ...input.live.messages.slice(recoveryHistoryStart),
      ];
      const recoveredExecuteRequest = readOnly ? null : assembleExecuteRequest([
        ...canonicalDecisionConversation, ...input.live.messages.slice(recoveryHistoryStart),
      ]);
      const recoveryMessages = recoveredExecuteRequest?.messages || (budget
          ? boundReadOnlyHistory(unboundedRecoveryMessages, {
              contextLimit: budget.contextLimit,
              reservedOutputTokens: maxOutputTokens,
              tools: providerTools,
            })
        : unboundedRecoveryMessages);
      input.live.latestProviderRequestSourceCoverage = recoveredExecuteRequest?.coverage ||
        materializedRuntimeV2SourceCoverage(
          recoveryMessages,
          input.ports.context.runWorkspace || "",
          providerEffectFacts,
        );
      input.live.latestProviderRequestSkillGuidanceWindows = runtimeV2TranscriptSkillGuidanceWindows(recoveryMessages)
        .map(({ documentKey, version, returnedRange, readTarget }) => ({ documentKey, version, returnedRange, readTarget }));
      result = await streamChatCompletion(
        recoveryMessages,
        adapterCapabilities.reasoningToggle
          ? {
              ...requestSettings,
              reasoningRequest: "off",
              preserveAssistantReasoning: false,
            }
          : requestSettings,
        {
          onToken: (token) => {
            lane.markFirstToken();
            streamedText += token;
          },
          onDone: () => undefined,
          onError: () => undefined,
          onLifecycle: (event) => {
            if (event.phase === "model_progress") lane.markFirstToken();
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
    clientStopReason: result.clientStopReason || null,
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
    !reasoningFallbackApplied &&
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
    clientStopReason: result.clientStopReason,
    toolCallCount: result.toolCalls.length,
    availableToolCount: providerTools.length,
  });
  const normalized = normalizeProviderResponseV1({
    visibleText,
    content: protocolContent,
    toolCalls: result.toolCalls,
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
            result.clientStopReason
              ? `Client ${result.clientStopReason} guard ended output before a structured action or complete conclusion.`
              : "Provider output reached its token limit before a structured action or complete conclusion.",
          retryable: true,
        }]
        : []),
    ],
  });
  input.ports.logStoreEvent("runtime_v2_provider_normalized_shape", {
    turnId: input.command.run.turnId, runId: input.command.run.runId,
    mode: input.command.payload.mode,
    toolNames: normalized.toolCalls.map((call) => call.name),
    diagnosticCodes: normalized.diagnostics.map((item) => item.code),
    explicitActionMarkers: [...new Set(protocolContent.match(/<\/?(?:runtime-v2-tools|tool_call|function_call|tool_use|tool_code)\b/gi) || [])],
    visibleTextChars: normalized.visibleText?.length || 0,
  });
  return normalized;
}
