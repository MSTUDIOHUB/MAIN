import type { AgentMessage } from "../../lib/agentMessages";
import { buildPlanDecisionJournal } from "../../lib/planDecisionJournal";
import { beginCapsuleModelActivity } from "../../lib/capsuleLiveActivity";
import type { ToolDefinition } from "../../lib/toolSchemas";
import { runtimeV2BuiltinCapabilityRestriction } from "./executionCapabilityRestrictions";
import { normalizeTurnCapabilityRestrictions } from "../../lib/turnCapabilities";
import { normalizeNetworkRead } from "../../lib/networkRead";
import { acquireModelLane } from "../../lib/modelLaneCoordinator";
import { deriveBudgetedStreamSettings, deriveProviderAdapterCapabilities } from "../../lib/providerLaneSettings";
import { boundReadOnlyHistory } from "./readOnlyHistory";
import { projectPlanSkillGuidance } from "./planSkillGuidance";
import { isStreamOutputLimited, streamChatCompletion } from "../../lib/streaming";
import {
  normalizeProviderResponseV1,
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
import { withRuntimeV2HardDeadline, withRuntimeV2ProgressDeadline } from "./hardDeadline";
import {
  normalizeRuntimeV2ProviderToolCalls,
  runtimeV2ProviderToolArgumentViolation,
} from "./executionProviderTools";
import { PLAN_REQUIRED_COLLABORATION_PROVIDER_TIMEOUT_CODE } from "./planCollaborationAcquisition";
import { RUNTIME_V2_LIFECYCLE_DEADLINE_CODE, RuntimeV2LifecycleDeadlineError } from "../../lib/runtime-v2/lifecycle";
import { planRequestMetrics } from "./planRequestMetrics";
import { adaptPlanBlockingQuestions, admittedPlanQuestionPurpose, ASK_PLAN_QUESTIONS } from "./planQuestionTool";
import { isPlanStreamRepetition, PLAN_REPETITION_FALLBACK_FAILED, PLAN_STREAM_REPETITION_CODE } from "./planRepetitionRecovery";
import { PLAN_VALIDATION_REPAIR_FAILED } from "./planValidationRecovery";
type StoreGet = () => any;
type RuntimeV2PlanLog = (event: string, data?: Record<string, unknown>) => void;
const PLAN_REASONING_ONLY_TIMEOUT_MS = 60_000;
export interface RuntimeV2PlanProviderResult extends RuntimeV2NormalizedProviderResult {
  /** Request-local admission surface shared by all provider transports. */
  readonly advertisedToolNames: readonly string[];
  readonly transport: PlanProviderTransport;
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
  readonly logStoreEvent: RuntimeV2PlanLog;
  readonly customTools?: readonly ToolDefinition[];
}): Promise<RuntimeV2PlanProviderResult> {
  const requiredCollaborationPending =
    input.collaboration.collaborationRequired === true &&
    input.collaboration.collaborationRequirementMet !== true;
  const submissionStage = !requiredCollaborationPending && (
    input.submissionRepairPending || isPlanSubmissionStage(input.stage)
  );
  const budget = input.context.runtimeContextBudget;
  const settings = deriveBudgetedStreamSettings(
    input.get().config,
    budget,
  );
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
  const activeSubagents = Array.isArray(input.collaboration.activeSubagents)
    ? input.collaboration.activeSubagents
    : [];
  const remainingSubagentCapacity = Math.max(0, Math.floor(Number(input.collaboration.remainingSubagentCapacity) || 0));
  const collaborationAllowed = input.collaboration.collaborationAllowed === true;
  const planTools = selectPlanModelTools({
    submissionStage,
    submissionRepairPending: input.submissionRepairPending,
    collaborationAllowed,
    collaborationRequired:
      input.collaboration.collaborationRequired === true,
    collaborationRequirementMet:
      input.collaboration.collaborationRequirementMet === true,
    remainingSubagentCapacity,
    activeSubagentCount: activeSubagents.length,
    baseTools: (input.customTools || planModelTools({
      ...input.context,
      planPurpose: admittedPlanQuestionPurpose(input.ledger.snapshot()) ?? input.context.planPurpose,
      networkRead: normalizeNetworkRead(input.ledger.snapshot()?.networkRead),
    })).filter((tool) =>
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
  });
  let streamedText = "";
  const requestAbort = new AbortController();
  let requestTimedOut = false;
  let lifecycleTimedOut = false;
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
    const planRequestMessages = input.validationRepair
      ? validationRepairTranscript({ ...input.validationRepair, objective: input.ledger.snapshot()?.objective, decisionJournal: buildPlanDecisionJournal(input.ledger.snapshot()) })
      : submissionStage
      ? synthesisPlanTranscript({
          ...input,
          submissionRepairPending: input.submissionRepairPending,
          compactRecovery: !!input.compactRecovery,
          transport,
          canAskPlanQuestions,
        })
      : boundedPlanTranscript(input.messages);
    const unboundedRequestMessages = textEnvelope
      ? planTextEnvelopeTranscript(planRequestMessages, planTools, input.context.phaseLanguage)
      : planRequestMessages;
    const maxOutputTokens = input.compactRecovery
      ? Math.min(budget?.outputBudget ?? PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS, PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS)
      : budget?.outputBudget ?? (submissionStage ? PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS : undefined);
    const requestMessages = budget
      ? boundReadOnlyHistory(unboundedRequestMessages, {
          contextLimit: budget.contextLimit,
          reservedOutputTokens:
            maxOutputTokens || budget.outputBudget,
          tools: offeredTools,
          preserveUserMessages: true,
          compactSkillGuidance: true,
        })
      : projectPlanSkillGuidance(unboundedRequestMessages);
    const requestMetrics = planRequestMetrics({ messages: requestMessages, tools: offeredTools,
      responseFormat });
    input.logStoreEvent("runtime_v2_plan_provider_request_opened", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      evidenceCount: input.ledger.snapshot()?.evidence.length || 0,
      stage: input.stage,
      compactRecovery: !!input.compactRecovery,
      submissionRepairPending: input.submissionRepairPending,
      canAskPlanQuestions,
      collaborationPreferred: input.collaboration.collaborationPreferred === true,
      collaborationAllowed,
      remainingSubagentCapacity,
      collaborationRequired:
        input.collaboration.collaborationRequired === true,
      collaborationRequirementMet:
        input.collaboration.collaborationRequirementMet === true,
      requiredSpawn,
      requestedTransport,
      transport,
      adapterNativeToolRoundTrip:
        adapterCapabilities.nativeToolRoundTrip,
      repairReasoningDisabled,
      offeredToolCount: offeredTools.length,
      offeredToolNames: offeredTools.map((tool) => tool.function.name),
      catalogToolNames: advertisedToolNames,
      promptMessageCount: requestMessages.length,
      ...requestMetrics,
      contextLimit: budget?.contextLimit ?? null,
      maxOutputTokens: maxOutputTokens ?? null,
      timeoutMs: requestTimeoutMs,
      reasoningOnlyTimeoutMs: reasoningOnlyTimeoutMs ?? null,
    });
    const requestTokenBudget = Math.max(2_048, Math.ceil(requestMetrics.promptChars / 4) + (maxOutputTokens || 4_096));
    const lifecycleTimeoutMs = Math.max(1, input.deadlineAt - Date.now());
    const result = await withRuntimeV2HardDeadline({
      timeoutMs: lifecycleTimeoutMs,
      timeoutError: RUNTIME_V2_LIFECYCLE_DEADLINE_CODE,
      onTimeout: () => {
        lifecycleTimedOut = true;
        requestAbort.abort("runtime_v2_plan_lifecycle_deadline");
      },
      task: async () => {
        activity.acquiringLane();
        const lane = await acquireModelLane({
          config: input.get().config,
          contextLimit: budget?.contextLimit,
          requestTokenBudget,
          agentKind: "parent",
          signal: requestAbort.signal,
          onDebugEvent: (event, data) => input.logStoreEvent(event, {
            turnId: input.run.turnId,
            runId: input.run.runId,
            ...data,
          }),
        });
        if (requestAbort.signal.aborted) {
          lane.release();
          throw new Error(lifecycleTimedOut
            ? "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT" : "Aborted");
        }
        lane.setPressureHandler((error) => requestAbort.abort(error));
        try {
          activity.preparing();
          return await withRuntimeV2ProgressDeadline({
            timeoutMs: requestTimeoutMs,
            timeoutError: "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT",
            onTimeout: () => {
              requestTimedOut = true;
              requestAbort.abort("runtime_v2_plan_provider_request_timeout");
            },
            task: ({ markProgress }) => streamChatCompletion(
              requestMessages,
              requestSettings,
              {
                onToken: (token) => {
                  lane.markFirstToken();
                  streamedText += token;
                },
                onDone: () => undefined,
                onError: () => undefined,
                onRequestDispatched: activity.requestDispatched,
                onLifecycle: (event) => {
                  if (
                    event.phase === "first_chunk" ||
                    event.phase === "chunk_progress"
                  ) {
                    markProgress();
                  }
                  if (event.phase === "model_progress") {
                    lane.markFirstToken();
                  }
                  if (event.phase === "response_format_downgraded") {
                    input.logStoreEvent("runtime_v2_plan_provider_response_format_downgraded", {
                      turnId: input.run.turnId,
                      runId: input.run.runId,
                      requestId: command.idempotencyKey,
                      transport,
                      reason: event.status,
                    });
                  }
                },
              },
              requestAbort.signal,
              offeredTools,
              maxOutputTokens,
              {
                ...(toolChoice ? { toolChoice } : {}),
                responseFormat,
                timeoutMs: requestTimeoutMs,
                contextOwnership: "caller",
                reasoningOnlyTimeoutMs,
              },
            ),
          });
        } catch (error) {
          lane.reportFailure(error);
          throw error;
        } finally {
          activity.finish();
          lane.setPressureHandler(undefined);
          lane.release();
        }
      },
    });
    if (input.context.abortCtrl.signal.aborted) throw new Error("RUNTIME_V2_PLAN_ABORTED");
    const outputTruncated = isStreamOutputLimited(result);
    const rawVisibleText = result.clientStopReason === "reasoning_only_timeout"
      ? ""
      : result.content || streamedText;
    const decoded = (structuredResponse || input.submissionRepairPending) && !result.toolCalls?.length
      ? decodeExactStructuredPlanResponse(rawVisibleText)
      : null;
    const structuredCandidate = input.validationRepair ? applyWorkPlanValidationRepair(input.validationRepair, decoded) : decoded;
    const adaptedToolCalls = structuredCandidate
      ? [{
            id: `${command.idempotencyKey}:structured-response`,
            name: SUBMIT_WORK_PLAN_TOOL_NAME,
            arguments: structuredCandidate,
          }]
      : structuredResponse ? [] : result.toolCalls;
    const providerNormalized = normalizeProviderResponseV1({
      visibleText: structuredCandidate ? "" : rawVisibleText,
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
                  message: [
                    `${argumentViolation.call.name} did not satisfy its exact advertised Plan schema: ${argumentViolation.reason}.`,
                    `Allowed tools: ${advertisedToolNames.join(", ")}.`,
                    "The entire provider-selected batch was rejected; no tool was admitted or executed.",
                  ].join(" "),
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
      turnId: input.run.turnId,
      runId: input.run.runId,
      stage: input.stage,
      transport,
      finishReason: result.finishReason || null,
      clientStopReason: result.clientStopReason || null,
      stopSource: result.clientStopReason ? "client_guard" : outputTruncated ? "provider" : null,
      contentChars: String(rawVisibleText || "").length,
      reasoningChars: String(result.reasoningContent || "").length,
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
      input.messages.push({
        role: "assistant",
        content: "",
        tool_calls: normalized.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: JSON.stringify({
              runtime_v2_rejected_tool_surface: true,
              effect: "none",
            }),
          },
        })),
      });
      for (const call of normalized.toolCalls) {
        const argumentRejection = !!argumentViolation;
        const rejection = argumentRejection
          ? {
              schemaVersion: "runtime-v2.plan-tool-rejection.v1",
              code: call.id === argumentViolation.call.id
                ? "PLAN_TOOL_ARGUMENTS_REJECTED"
                : "PLAN_TOOL_BATCH_REJECTED",
              effect: "none",
              requestedTool: call.name,
              rejectedTool: argumentViolation.call.name,
              reason: argumentViolation.reason,
              allowedToolNames: advertisedToolNames,
              responseDisposition: "rejected_before_dispatch",
              instruction:
                "Submit exactly one currently advertised structured tool action with schema-valid arguments next.",
            }
          : {
              schemaVersion: "runtime-v2.plan-tool-rejection.v1",
              code: unexpectedToolNames.includes(call.name)
                ? "PLAN_TOOL_SURFACE_REJECTED"
                : "PLAN_TOOL_BATCH_REJECTED",
              effect: "none",
              requestedTool: call.name,
              unexpectedToolNames,
              allowedToolNames: advertisedToolNames,
              responseDisposition: "rejected_before_dispatch",
              instruction:
                "Submit exactly one currently advertised structured tool action next.",
            };
        input.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `${argumentRejection
            ? "PLAN_TOOL_ARGUMENTS_REJECTED"
            : "PLAN_TOOL_NOT_ADVERTISED"}: ${JSON.stringify(rejection)}`,
        });
      }
    } else {
      input.messages.push({
        role: "assistant",
        content: structuredCandidate ? "" : rawVisibleText,
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
    };
  } catch (error) {
    activity.finish();
    const providerRequestTimedOut = !lifecycleTimedOut && (requestTimedOut || isPlanProviderRequestTimeout(
      error,
      requestAbort.signal,
      input.context.abortCtrl.signal,
    ));
    const canceled = input.context.abortCtrl.signal.aborted;
    const failureReasonCode = canceled ? undefined
      : lifecycleTimedOut ? RUNTIME_V2_LIFECYCLE_DEADLINE_CODE
      : providerRequestTimedOut && requiredSpawn ? PLAN_REQUIRED_COLLABORATION_PROVIDER_TIMEOUT_CODE
      : input.validationRepair ? PLAN_VALIDATION_REPAIR_FAILED
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
      turnId: input.run.turnId,
      runId: input.run.runId,
      stage: input.stage,
      transport,
      timeoutMs: requestTimeoutMs,
      timedOut: providerRequestTimedOut,
      lifecycleTimedOut,
      errorName: error instanceof Error ? error.name : "",
      error: error instanceof Error ? error.message : String(error || ""),
    });
    if (lifecycleTimedOut) throw new RuntimeV2LifecycleDeadlineError();
    throw providerRequestTimedOut
      ? new Error("RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT")
      : error;
  } finally {
    input.context.abortCtrl.signal.removeEventListener("abort", forwardAbort);
  }
}
