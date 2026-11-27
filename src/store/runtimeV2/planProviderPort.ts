import { buildCommentaryLanguageAnchor, shouldPublishPublicCommentary } from "../../lib/languageContract";
import { upsertRuntimeV2ContextAnchor } from "./executionProviderHistory";
import { appendRuntimeV2GuidanceHistory } from "../../lib/runtime-v2/guidance";
import type { AgentMessage } from "../../lib/agentMessages";
import { buildPlanDecisionJournal } from "../../lib/planDecisionJournal";
import { beginCapsuleModelActivity } from "../../lib/capsuleLiveActivity";
import { buildCapsuleModelActivityContext } from "../../lib/capsuleModelContext";
import type { ToolDefinition } from "../../lib/toolSchemas";
import { TOOL_SEARCH_TOOL_NAME } from "../../lib/toolSearch";
import { runtimeV2BuiltinCapabilityRestriction } from "./executionCapabilityRestrictions";
import { normalizeTurnCapabilityRestrictions } from "../../lib/turnCapabilities";
import { normalizeNetworkRead } from "../../lib/networkRead";
import { deriveBudgetedStreamSettings, deriveProviderAdapterCapabilities } from "../../lib/providerLaneSettings";
import { boundReadOnlyHistory } from "./readOnlyHistory";
import { projectPlanSkillGuidance } from "./planSkillGuidance";
import { isStreamOutputLimited } from "../../lib/streaming";
import {
  normalizeProviderResponseV1,
  runtimeV2CheckpointWriteFailureReason,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2RunIdentity,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import { PlanLedger } from "./planLedger";
import {
  PLAN_MODEL_REQUEST_TIMEOUT_MS,
  PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
  PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
  PLAN_SYNTHESIS_REQUEST_TIMEOUT_MS,
  SUBMIT_WORK_PLAN_TOOL_NAME,
  WORK_PLAN_STRUCTURED_RESPONSE_FORMAT,
  WORK_PLAN_VALIDATION_REPAIR_FORMAT,
  applyWorkPlanValidationRepair,
  boundedPlanTranscript,
  decodeExactStructuredPlanResponse,
  isPlanProviderRequestTimeout,
  isPlanSubmissionStage,
  planModelTools,
  planProviderResponseDiagnostics,
  planTextEnvelopeTranscript,
  selectPlanModelTools,
  synthesisPlanTranscript,
  validationRepairTranscript,
  type PlanModelStage,
  type PlanProviderTransport,
} from "./planModelProtocol";
import type { RuntimeV2SubmissionContext } from "./submissionContext";
import { formatRuntimeV2ToolSchemaHint, normalizeRuntimeV2ProviderToolCalls, runtimeV2ProviderToolArgumentViolation } from "./executionProviderTools";
import { PLAN_REQUIRED_COLLABORATION_PROVIDER_TIMEOUT_CODE } from "./planCollaborationAcquisition";
import { RUNTIME_V2_LIFECYCLE_DEADLINE_CODE, RuntimeV2LifecycleDeadlineError } from "../../lib/runtime-v2/lifecycle";
import { planRequestMetrics } from "./planRequestMetrics";
import { adaptPlanBlockingQuestions, admittedPlanQuestionPurpose, ASK_PLAN_QUESTIONS } from "./planQuestionTool";
import { isPlanStreamRepetition, PLAN_REPETITION_FALLBACK_FAILED, PLAN_STREAM_REPETITION_CODE } from "./planRepetitionRecovery";
import { buildPlanToolAdmissionRejectionMessages, replaceTrailingPlanAdmissionRejectionGroup } from "./planProviderAdmission";
import { PLAN_VALIDATION_REPAIR_FAILED } from "./planValidationRecovery";
import { executePlanProviderStream, type PlanProviderStreamMetrics } from "./planProviderStream";
type StoreGet = () => any;
type RuntimeV2PlanLog = (event: string, data?: Record<string, unknown>) => void;
const PLAN_REASONING_ONLY_TIMEOUT_MS = 60_000;
export interface RuntimeV2PlanProviderResult extends RuntimeV2NormalizedProviderResult {
  /** Request-local admission surface shared by all provider transports. */
  readonly advertisedToolNames: readonly string[];
  readonly transport: PlanProviderTransport;
  readonly rejectedAdmission?: boolean;
  readonly unexpectedToolNames?: readonly string[];
}
export async function requestPlanModel(input: {
  readonly get: StoreGet;
  readonly context: RuntimeV2SubmissionContext;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly messages: AgentMessage[];
  readonly deadlineAt: number;
  readonly stage: PlanModelStage;
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly evidenceContents: ReadonlyMap<string, string>;
  readonly collaboration: Readonly<Record<string, unknown>>;
  readonly submissionRepairPending: boolean;
  readonly compactRecovery?: boolean;
  readonly transport?: PlanProviderTransport;
  readonly explicitFallback?: boolean;
  readonly repetitionFallback?: boolean;
  readonly validationRepair?: { candidate: Record<string, unknown>; feedback: string; rejectedCommands: readonly string[] };
  readonly validationDiscoveryFocus?: boolean;
  readonly logStoreEvent: RuntimeV2PlanLog;
  readonly customTools?: readonly ToolDefinition[];
  readonly focusedRevision?: boolean;
}): Promise<RuntimeV2PlanProviderResult> {
  const collaborationRequired = input.collaboration.collaborationRequired === true;
  const collaborationRequirementMet = input.collaboration.collaborationRequirementMet === true;
  const requiredCollaborationPending = collaborationRequired && !collaborationRequirementMet;
  const submissionStage = !requiredCollaborationPending && (
    input.submissionRepairPending || isPlanSubmissionStage(input.stage)
  );
  const budget = input.context.runtimeContextBudget;
  const settings = deriveBudgetedStreamSettings(input.get().config, budget);
  const requestedTransport = submissionStage && (!input.submissionRepairPending || input.explicitFallback)
    ? input.transport ?? "native_tool"
    : "native_tool";
  const adapterCapabilities = deriveProviderAdapterCapabilities(settings);
  const repairReasoningDisabled = (
    input.submissionRepairPending || input.compactRecovery === true
  ) &&
    adapterCapabilities.reasoningToggle;
  const requestSettings = repairReasoningDisabled
    ? { ...settings, reasoningRequest: "off" as const, preserveAssistantReasoning: false }
    : settings;
  const transport =
    requestedTransport === "native_tool" &&
      !adapterCapabilities.nativeToolRoundTrip
      ? "text_envelope"
      : requestedTransport;
  const structuredResponse = transport === "structured_response";
  const responseFormat = structuredResponse ? input.validationRepair ? WORK_PLAN_VALIDATION_REPAIR_FORMAT : WORK_PLAN_STRUCTURED_RESPONSE_FORMAT : undefined;
  const textEnvelope = transport === "text_envelope";
  const activeSubagents = Array.isArray(input.collaboration.activeSubagents) ? input.collaboration.activeSubagents : [];
  const remainingSubagentCapacity = Math.max(0, Math.floor(Number(input.collaboration.remainingSubagentCapacity) || 0));
  const collaborationAllowed = input.collaboration.collaborationAllowed === true;
  const planTools = selectPlanModelTools({
    submissionStage,
    submissionRepairPending: input.submissionRepairPending,
    collaborationAllowed,
    collaborationRequired,
    collaborationRequirementMet,
    remainingSubagentCapacity,
    activeSubagentCount: activeSubagents.length,
    baseTools: (input.customTools || planModelTools({
      ...input.context,
      planPurpose: admittedPlanQuestionPurpose(input.ledger.snapshot()) ?? input.context.planPurpose,
      networkRead: normalizeNetworkRead(input.ledger.snapshot()?.networkRead),
    })).filter((tool) =>
      (!input.focusedRevision || ["read_file", "load_skill", SUBMIT_WORK_PLAN_TOOL_NAME].includes(tool.function.name)) &&
      (!input.validationDiscoveryFocus || tool.function.name !== TOOL_SEARCH_TOOL_NAME) &&
      !runtimeV2BuiltinCapabilityRestriction(normalizeTurnCapabilityRestrictions(
        input.ledger.snapshot()?.objective.capabilityRestrictions,
      ), tool.function.name)
    ),
  });
  const requiredSpawn = requiredCollaborationPending &&
    planTools.length === 1 &&
    planTools[0]?.function.name === "spawn_subagent";
  if (requiredCollaborationPending && !requiredSpawn) {
    throw new Error("RUNTIME_V2_PLAN_REQUIRED_COLLABORATION_UNAVAILABLE");
  }
  const advertisedToolNames = planTools.map((tool) => tool.function.name);
  const canAskPlanQuestions = advertisedToolNames.includes(ASK_PLAN_QUESTIONS);
  const offeredTools = structuredResponse || textEnvelope ? [] : planTools;
  const toolChoice = structuredResponse || textEnvelope
    ? undefined
    : requiredSpawn ? { type: "function" as const, function: { name: "spawn_subagent" } } : "required" as const;
  const command = await input.ledger.schedule(input.run, "request_model", {
    mode: "plan",
    stage: input.stage,
    toolExpectation: "required",
    objective: input.ledger.snapshot()?.objective.text || "",
    evidenceIds: input.ledger.snapshot()?.evidence.map((entry) => entry.id) || [],
    transport,
    submissionRepairPending: input.submissionRepairPending,
    compactRecovery: !!input.compactRecovery,
    ...input.collaboration,
    requiredSpawn,
    ...(input.explicitFallback ? { planExplicitFallback: true } : {}),
    ...(input.repetitionFallback ? { planRepetitionFallback: true } : {}),
    ...(input.validationRepair ? { planValidationOnlyRepair: true } : {}),
    ...(input.validationDiscoveryFocus ? { planValidationDiscoveryFocus: true } : {}),
  });
  const requestTrace = {
    sessionKey: input.run.sessionKey,
    sessionEpoch: input.run.sessionEpoch,
    turnId: input.run.turnId,
    runId: input.run.runId,
    attemptId: input.run.attemptId,
    commandKey: command.idempotencyKey,
  };
  let streamMetrics: PlanProviderStreamMetrics = {
    streamedText: "",
    dispatchCount: 0,
    dispatchedAt: 0,
    firstTransportMs: null,
    firstPromptProgressMs: null,
    firstDecodedMs: null,
    streamId: undefined,
    promptProgress: undefined,
    requestTimedOut: false,
    lifecycleTimedOut: false,
  };
  const requestAbort = new AbortController();
  const forwardAbort = () => requestAbort.abort(input.context.abortCtrl.signal.reason);
  input.context.abortCtrl.signal.addEventListener("abort", forwardAbort, { once: true });
  if (input.context.abortCtrl.signal.aborted) forwardAbort();
  const requestTimeoutMs = Math.max(1,
    submissionStage
      ? input.compactRecovery || input.submissionRepairPending
        ? PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS
        : PLAN_SYNTHESIS_REQUEST_TIMEOUT_MS
      : PLAN_MODEL_REQUEST_TIMEOUT_MS,
  );
  const reasoningOnlyTimeoutMs = input.customTools ? undefined : PLAN_REASONING_ONLY_TIMEOUT_MS;
  const activity = beginCapsuleModelActivity(input.run, command.idempotencyKey, requestAbort.signal);
  try {
    appendRuntimeV2GuidanceHistory(input.messages, input.ledger.snapshot(), input.run, command.idempotencyKey);
    const planRequestMessages = input.validationRepair
      ? validationRepairTranscript({ ...input.validationRepair, objective: input.ledger.snapshot()?.objective, decisionJournal: buildPlanDecisionJournal(input.ledger.snapshot()) })
      : submissionStage
      ? synthesisPlanTranscript({
          ...input,
          submissionRepairPending: input.submissionRepairPending,
          compactRecovery: !!input.compactRecovery,
          transport,
          canAskPlanQuestions,
          phaseLanguage: input.context.phaseLanguage,
        })
      : boundedPlanTranscript(input.messages);
    if (input.validationRepair) {
      appendRuntimeV2GuidanceHistory(planRequestMessages, input.ledger.snapshot(), input.run, command.idempotencyKey);
    }
    const unboundedRequestMessages = textEnvelope
      ? planTextEnvelopeTranscript(planRequestMessages, planTools, input.context.phaseLanguage)
      : planRequestMessages;
    const maxOutputTokens = input.compactRecovery
      ? Math.min(budget?.outputBudget ?? PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS, PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS)
      : budget?.outputBudget ?? (submissionStage ? PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS : undefined);
    const requestMessages = budget
      ? boundReadOnlyHistory(unboundedRequestMessages, {
          contextLimit: budget.contextLimit,
          reservedOutputTokens: maxOutputTokens || budget.outputBudget,
          tools: offeredTools,
          preserveUserMessages: true,
          compactSkillGuidance: true,
        })
      : projectPlanSkillGuidance(unboundedRequestMessages);
    const requestMetrics = planRequestMetrics({ messages: requestMessages, tools: offeredTools, responseFormat });
    const requestTokenBudget = Math.max(2_048, Math.ceil(requestMetrics.promptChars / 4) + (maxOutputTokens || 4_096));
    activity.setContext(buildCapsuleModelActivityContext({
      aggregate: input.ledger.snapshot(),
      messages: requestMessages,
      mode: input.validationRepair ? "validation_repair" : input.submissionRepairPending ? "submission_repair" : input.stage,
      estimatedInputTokens: requestMetrics.estimatedInputTokens,
      objectiveText: input.ledger.snapshot()?.objective.text,
    }));
    input.logStoreEvent("runtime_v2_plan_provider_request_opened", {
      ...requestTrace,
      guidanceIds: requestMessages.flatMap(message => message.runtimeGuidanceId ? [message.runtimeGuidanceId] : []),
      evidenceCount: input.ledger.snapshot()?.evidence.length || 0,
      stage: input.stage,
      compactRecovery: !!input.compactRecovery,
      submissionRepairPending: input.submissionRepairPending,
      canAskPlanQuestions,
      collaborationPreferred: input.collaboration.collaborationPreferred === true,
      focusedRevision: input.focusedRevision === true,
      proactiveSkipReason: input.collaboration.proactiveSkipReason ?? null,
      collaborationAllowed,
      activeSubagentCount: activeSubagents.length,
      spawnAdvertised: advertisedToolNames.includes("spawn_subagent"),
      waitAdvertised: advertisedToolNames.includes("wait_subagents"),
      remainingSubagentCapacity,
      collaborationRequired,
      collaborationRequirementMet,
      requiredSpawn,
      requestedTransport,
      transport,
      adapterNativeToolRoundTrip:
        adapterCapabilities.nativeToolRoundTrip,
      repairReasoningDisabled,
      offeredToolCount: offeredTools.length,
      offeredToolNames: offeredTools.map((tool) => tool.function.name),
      editorObservationTools: offeredTools.map(tool => tool.function.name).filter(name => name.startsWith("unity_mcp_")),
      projectBaselineFingerprint: input.context.projectBaselineContext?.fingerprints.overall || null,
      catalogToolNames: advertisedToolNames,
      promptMessageCount: requestMessages.length,
      messagesBeforeBudget: unboundedRequestMessages.length,
      ...requestMetrics,
      laneTokenBudget: requestTokenBudget,
      contextLimit: budget?.contextLimit ?? null,
      maxOutputTokens: maxOutputTokens ?? null,
      timeoutMs: requestTimeoutMs,
      reasoningOnlyTimeoutMs: reasoningOnlyTimeoutMs ?? null,
    });
    const streamOutcome = await executePlanProviderStream({
      config: input.get().config,
      contextLimit: budget?.contextLimit,
      requestTokenBudget,
      parentRunId: input.run.runId,
      runId: input.run.runId,
      turnId: input.run.turnId,
      requestId: command.idempotencyKey,
      requestTrace,
      deadlineAt: input.deadlineAt,
      requestTimeoutMs,
      requestAbort,
      activity,
      requestMessages,
      requestSettings,
      offeredTools,
      maxOutputTokens,
      toolChoice,
      responseFormat,
      reasoningOnlyTimeoutMs,
      transport,
      allowPublicText: !structuredResponse && !textEnvelope && !input.submissionRepairPending,
      onPublicText: (text) => {
        if (shouldPublishPublicCommentary(text, input.context.phaseLanguage).allow) {
          activity.reportPublicCommentary(text);
        }
      },
      logStoreEvent: input.logStoreEvent,
    });
    const result = streamOutcome.result;
    streamMetrics = streamOutcome.metrics;
    if (input.context.abortCtrl.signal.aborted) throw new Error("RUNTIME_V2_PLAN_ABORTED");
    const outputTruncated = isStreamOutputLimited(result);
    const rawVisibleText = result.clientStopReason === "reasoning_only_timeout"
      ? ""
      : result.content || streamMetrics.streamedText;
    const actionableText = result.clientStopReason === "reasoning_only_timeout"
      ? "" : result.actionableContent ?? rawVisibleText;
    const decoded = (structuredResponse || input.submissionRepairPending) && !result.toolCalls?.length
      ? decodeExactStructuredPlanResponse(actionableText)
      : null;
    const structuredCandidate = input.validationRepair ? applyWorkPlanValidationRepair(input.validationRepair, decoded) : decoded;
    const adaptedToolCalls = structuredCandidate
      ? [{
            id: `${command.idempotencyKey}:structured-response`,
            name: SUBMIT_WORK_PLAN_TOOL_NAME,
            arguments: structuredCandidate,
          }]
      : structuredResponse ? [] : result.toolCalls;
    const commentaryText = !structuredCandidate && actionableText
      ? result.semanticContent || actionableText
      : "";
    const commentaryCheck = adaptedToolCalls.length > 0 && commentaryText.trim()
      ? shouldPublishPublicCommentary(commentaryText, input.context.phaseLanguage)
      : null;
    const commentarySuppressed = commentaryCheck !== null && !commentaryCheck.allow && commentaryCheck.reason === "language_mismatch";
    if (commentarySuppressed && !outputTruncated && !result.protocolViolation) {
      input.logStoreEvent("runtime_v2_commentary_language_suppressed", {
        ...requestTrace,
        phase: "planning",
        targetLanguage: input.context.phaseLanguage,
        detectedLanguage: commentaryCheck.detectedLanguage,
        hanCount: commentaryCheck.hanCount,
        latinWords: commentaryCheck.latinWords,
        toolCount: adaptedToolCalls.length,
      });
      upsertRuntimeV2ContextAnchor({ messages: input.messages } as any, {
        key: "language-contract",
        content: buildCommentaryLanguageAnchor(input.context.phaseLanguage),
      });
    }
    const providerNormalized = normalizeProviderResponseV1({
      visibleText: structuredCandidate ? "" : actionableText,
      ...(!structuredCandidate && !commentarySuppressed && actionableText && result.semanticContent ? { commentary: result.semanticContent } : {}),
      toolCalls: adaptedToolCalls,
      usage: result.usage,
      diagnostics: planProviderResponseDiagnostics({
        protocolViolation: result.protocolViolation,
        clientStopReason: result.clientStopReason,
        outputTruncated,
        adaptedToolCallCount: adaptedToolCalls.length,
        structuredResponseAdapted: !!structuredCandidate,
      }),
    });
    const normalizedCalls = normalizeRuntimeV2ProviderToolCalls(providerNormalized.toolCalls, planTools, input.context.runWorkspace);
    const normalized: RuntimeV2NormalizedProviderResult = { ...providerNormalized, toolCalls:
      canAskPlanQuestions && advertisedToolNames.includes(SUBMIT_WORK_PLAN_TOOL_NAME)
        ? adaptPlanBlockingQuestions(normalizedCalls, SUBMIT_WORK_PLAN_TOOL_NAME, input.context.phaseLanguage)
        : normalizedCalls };
    const unexpectedToolNames = [...new Set(
      normalized.toolCalls
        .map((call) => call.name)
        .filter((name) => !advertisedToolNames.includes(name)),
    )];
    const argumentViolation = unexpectedToolNames.length === 0
      ? runtimeV2ProviderToolArgumentViolation(
          // Effect-free WorkPlan readiness belongs to assessment; preserve
          // useful Markdown. Ordinary tools retain exact schema admission.
          normalized.toolCalls.filter(call => !(call.name === SUBMIT_WORK_PLAN_TOOL_NAME &&
            typeof call.arguments.planMarkdown === "string" && call.arguments.planMarkdown.trim())),
          planTools,
        )
      : null;
    const admitted = unexpectedToolNames.length === 0 && !argumentViolation
      ? normalized
      : {
          ...normalized,
          toolCalls: [],
          diagnostics: [
            ...normalized.diagnostics,
            argumentViolation
              ? {
                  code: "tool_arguments_rejected",
                  message: [`${argumentViolation.call.name} did not satisfy its exact advertised Plan schema: ${argumentViolation.reason}.`,
                    formatRuntimeV2ToolSchemaHint(argumentViolation.call.name, planTools), `Allowed tools: ${advertisedToolNames.join(", ")}.`,
                    "The entire provider-selected batch was rejected; no tool was admitted or executed."].filter(Boolean).join(" "),
                  retryable: true,
                }
              : {
                  code: "tool_surface_rejected",
                  message: [
                    `Provider returned tools outside the advertised Plan surface: ${unexpectedToolNames.join(", ")}.`,
                    `Allowed tools: ${advertisedToolNames.join(", ")}.`,
                    "No tool was admitted or executed.",
                  ].join(" "),
                  retryable: true,
                },
          ],
        };
    input.logStoreEvent("runtime_v2_plan_provider_response_shape", {
      ...requestTrace,
      streamId: streamMetrics.streamId,
      dispatchCount: streamMetrics.dispatchCount,
      dispatchElapsedMs: streamMetrics.dispatchedAt ? Date.now() - streamMetrics.dispatchedAt : null,
      firstTransportMs: streamMetrics.firstTransportMs,
      firstPromptProgressMs: streamMetrics.firstPromptProgressMs,
      firstDecodedMs: streamMetrics.firstDecodedMs,
      firstPublicTextMs: result.streamDiagnostics?.firstSemanticVisibleElapsedMs ?? null,
      firstToolMs: result.streamDiagnostics?.firstToolElapsedMs ?? null,
      providerUsage: result.usage,
      promptProgress: streamMetrics.promptProgress,
      stage: input.stage,
      transport,
      finishReason: result.finishReason || null,
      clientStopReason: result.clientStopReason || null,
      stopSource: result.clientStopReason ? "client_guard" : outputTruncated ? "provider" : null,
      contentChars: String(rawVisibleText || "").length,
      reasoningChars: String(result.reasoningContent || "").length,
      publicTextChars: structuredCandidate ? 0 : result.semanticContent?.length ?? String(rawVisibleText || "").length,
      nativeToolArgumentChars: result.toolCalls.reduce((sum, call) => sum + String(call.arguments || "").length, 0),
      nativeToolCallCount: result.toolCalls.length,
      normalizedToolCallCount: normalized.toolCalls.length,
      admittedToolCallCount: admitted.toolCalls.length,
      unexpectedToolNames,
      argumentViolation: argumentViolation?.reason || null,
      argumentViolationToolName: argumentViolation?.call.name || null,
      exactStructuredObject: !!structuredCandidate,
      protocolViolation: result.protocolViolation || null,
    });
    await input.ledger.settleCommand({
      type: "provider.responded",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      result: admitted,
    });
    if (unexpectedToolNames.length > 0 || argumentViolation) {
      replaceTrailingPlanAdmissionRejectionGroup(
        input.messages,
        buildPlanToolAdmissionRejectionMessages({
          toolCalls: normalized.toolCalls,
          unexpectedToolNames,
          argumentViolation,
          advertisedToolNames,
          activeSubagentCount: activeSubagents.length,
        }),
      );
    } else {
      input.messages.push({
        role: "assistant",
        content: structuredCandidate ? "" : actionableText,
        ...(admitted.toolCalls.length > 0
          ? {
              tool_calls: admitted.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }
          : {}),
      });
    }
    return {
      ...admitted,
      advertisedToolNames,
      transport,
      ...(unexpectedToolNames.length > 0 || argumentViolation ? { rejectedAdmission: true, unexpectedToolNames } : {}),
    };
  } catch (error) {
    const failedMetrics = (
      error &&
      typeof error === "object" &&
      "planStreamMetrics" in error
        ? (error as { planStreamMetrics?: PlanProviderStreamMetrics }).planStreamMetrics
        : undefined
    ) ?? streamMetrics;
    if (runtimeV2CheckpointWriteFailureReason(error)) throw error;
    const providerRequestTimedOut = !failedMetrics.lifecycleTimedOut && (failedMetrics.requestTimedOut || isPlanProviderRequestTimeout(
      error,
      requestAbort.signal,
      input.context.abortCtrl.signal,
    ));
    const canceled = input.context.abortCtrl.signal.aborted;
    const failureReasonCode = canceled ? undefined
      : failedMetrics.lifecycleTimedOut ? RUNTIME_V2_LIFECYCLE_DEADLINE_CODE
      : providerRequestTimedOut && requiredSpawn ? PLAN_REQUIRED_COLLABORATION_PROVIDER_TIMEOUT_CODE
      : input.validationRepair || input.validationDiscoveryFocus ? PLAN_VALIDATION_REPAIR_FAILED
      : isPlanStreamRepetition(error) ? PLAN_STREAM_REPETITION_CODE
      : input.repetitionFallback ? PLAN_REPETITION_FALLBACK_FAILED : undefined;
    await input.ledger.settleCommand({
      type: "command.completed",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      status: canceled ? "canceled" : "failed",
      ...(failureReasonCode ? { failureReasonCode } : {}),
    });
    input.logStoreEvent("runtime_v2_plan_provider_request_closed", {
      ...requestTrace,
      streamId: failedMetrics.streamId,
      dispatchCount: failedMetrics.dispatchCount,
      dispatchElapsedMs: failedMetrics.dispatchedAt ? Date.now() - failedMetrics.dispatchedAt : null,
      firstTransportMs: failedMetrics.firstTransportMs,
      firstPromptProgressMs: failedMetrics.firstPromptProgressMs,
      firstDecodedMs: failedMetrics.firstDecodedMs,
      failureReasonCode,
      stage: input.stage,
      transport,
      timeoutMs: requestTimeoutMs,
      timedOut: providerRequestTimedOut,
      lifecycleTimedOut: failedMetrics.lifecycleTimedOut,
      errorName: error instanceof Error ? error.name : "",
      error: error instanceof Error ? error.message : String(error || ""),
    });
    if (failedMetrics.lifecycleTimedOut) throw new RuntimeV2LifecycleDeadlineError();
    throw providerRequestTimedOut
      ? new Error("RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT")
      : error;
  } finally {
    activity.finish();
    input.context.abortCtrl.signal.removeEventListener("abort", forwardAbort);
  }
}
