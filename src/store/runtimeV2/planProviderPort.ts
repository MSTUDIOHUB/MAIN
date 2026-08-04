import type { AgentMessage } from "../../lib/agentMessages";
import {
  deriveBudgetedStreamSettings,
  deriveProviderAdapterCapabilities,
} from "../../lib/providerLaneSettings";
import { boundRuntimeMessagesToContext } from "../../lib/runtimeContextBudget";
import { streamChatCompletion } from "../../lib/streaming";
import {
  normalizeProviderResponseV1,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2RunIdentity,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import { PlanLedger } from "./planLedger";
import {
  PLAN_MODEL_REQUEST_TIMEOUT_MS,
  PLAN_MODEL_TOOLS,
  PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
  PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
  PLAN_SYNTHESIS_REQUEST_TIMEOUT_MS,
  SUBMIT_WORK_PLAN_TOOL,
  SUBMIT_WORK_PLAN_TOOL_NAME,
  WORK_PLAN_STRUCTURED_RESPONSE_FORMAT,
  boundedPlanTranscript,
  decodeExactStructuredPlanResponse,
  isPlanProviderRequestTimeout,
  isPlanSubmissionStage,
  synthesisPlanTranscript,
  type PlanModelStage,
  type PlanProviderTransport,
} from "./planModelProtocol";
import type { RuntimeV2SubmissionContext } from "./submissionContext";
import { withRuntimeV2HardDeadline } from "./hardDeadline";
import { containsProviderTextEnvelopePrompt } from "./executionProviderContext";
import { buildRuntimeV2TextEnvelopeCatalog } from "./executionProviderTools";

type StoreGet = () => any;
type RuntimeV2PlanLog = (
  event: string,
  data?: Record<string, unknown>,
) => void;

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
  readonly compactRecovery?: boolean;
  readonly transport?: PlanProviderTransport;
  readonly logStoreEvent: RuntimeV2PlanLog;
}): Promise<RuntimeV2NormalizedProviderResult> {
  const submissionStage = isPlanSubmissionStage(input.stage);
  const budget = input.context.runtimeContextBudget;
  const settings = deriveBudgetedStreamSettings(
    input.get().config,
    budget,
  );
  const requestedTransport = submissionStage
    ? input.transport || "native_tool"
    : "native_tool";
  const adapterCapabilities = deriveProviderAdapterCapabilities(settings);
  const transport =
    requestedTransport === "native_tool" &&
      !adapterCapabilities.nativeToolRoundTrip
      ? "text_envelope"
      : requestedTransport;
  const structuredResponse = transport === "structured_response";
  const textEnvelope = transport === "text_envelope";
  const planTools = submissionStage
    ? [SUBMIT_WORK_PLAN_TOOL]
    : PLAN_MODEL_TOOLS;
  const offeredTools = structuredResponse || textEnvelope ? [] : planTools;
  const toolChoice = structuredResponse || textEnvelope
    ? undefined
    : submissionStage
    ? {
        type: "function" as const,
        function: { name: SUBMIT_WORK_PLAN_TOOL_NAME },
      }
    : "required" as const;
  const command = await input.ledger.schedule(input.run, "request_model", {
    mode: "plan",
    stage: input.stage,
    toolExpectation: "required",
    objective: input.ledger.snapshot()?.objective.text || "",
    evidenceIds: input.ledger.snapshot()?.evidence.map((entry) => entry.id) || [],
    transport,
  });
  let streamedText = "";
  const requestAbort = new AbortController();
  let requestTimedOut = false;
  const forwardAbort = () => requestAbort.abort(input.context.abortCtrl.signal.reason);
  if (input.context.abortCtrl.signal.aborted) {
    forwardAbort();
  } else {
    input.context.abortCtrl.signal.addEventListener("abort", forwardAbort, { once: true });
  }
  const requestTimeoutMs = Math.max(1, Math.min(
    submissionStage
      ? input.compactRecovery
        ? PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS
        : PLAN_SYNTHESIS_REQUEST_TIMEOUT_MS
      : PLAN_MODEL_REQUEST_TIMEOUT_MS,
    input.deadlineAt - Date.now(),
  ));
  const planRequestMessages = input.stage === "synthesis"
    ? synthesisPlanTranscript({
        ...input,
        compactRecovery: !!input.compactRecovery,
        transport,
      })
    : boundedPlanTranscript(input.messages);
  const unboundedRequestMessages = textEnvelope
    ? [
        ...planRequestMessages,
        {
          role: "system" as const,
          content: containsProviderTextEnvelopePrompt(
            input.context.phaseLanguage,
            true,
          ),
        },
        {
          role: "system" as const,
          content: buildRuntimeV2TextEnvelopeCatalog(planTools),
        },
      ]
    : planRequestMessages;
  const maxOutputTokens = submissionStage
    ? Math.min(
        PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
        budget?.outputBudget ?? PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
      )
    : budget?.outputBudget;
  const requestMessages = budget
    ? boundRuntimeMessagesToContext(unboundedRequestMessages, {
        contextLimit: budget.contextLimit,
        reservedOutputTokens:
          maxOutputTokens || budget.outputBudget,
      })
    : unboundedRequestMessages;
  try {
    input.logStoreEvent("runtime_v2_plan_provider_request_opened", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      evidenceCount: input.ledger.snapshot()?.evidence.length || 0,
      stage: input.stage,
      compactRecovery: !!input.compactRecovery,
      requestedTransport,
      transport,
      adapterNativeToolRoundTrip:
        adapterCapabilities.nativeToolRoundTrip,
      offeredToolCount: offeredTools.length,
      offeredToolNames: offeredTools.map((tool) => tool.function.name),
      promptMessageCount: requestMessages.length,
      promptChars: requestMessages.reduce(
        (total, message) => total + String(message.content || "").length,
        0,
      ),
      contextLimit: budget?.contextLimit ?? null,
      maxOutputTokens: maxOutputTokens ?? null,
      timeoutMs: requestTimeoutMs,
    });
    const result = await withRuntimeV2HardDeadline({
      timeoutMs: requestTimeoutMs,
      timeoutError: "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT",
      onTimeout: () => {
        requestTimedOut = true;
        requestAbort.abort("runtime_v2_plan_provider_request_timeout");
      },
      task: () => streamChatCompletion(
        requestMessages,
        settings,
        {
          onToken: (token) => { streamedText += token; },
          onDone: () => undefined,
          onError: () => undefined,
        },
        requestAbort.signal,
        offeredTools,
        maxOutputTokens,
        {
          ...(toolChoice ? { toolChoice } : {}),
          ...(structuredResponse
            ? { responseFormat: WORK_PLAN_STRUCTURED_RESPONSE_FORMAT }
            : {}),
          timeoutMs: requestTimeoutMs,
        },
      ),
    });
    const rawVisibleText = result.content || streamedText;
    const structuredCandidate = structuredResponse
      ? decodeExactStructuredPlanResponse(rawVisibleText)
      : null;
    const adaptedToolCalls = structuredResponse
      ? structuredCandidate
        ? [{
            id: `${command.idempotencyKey}:structured-response`,
            name: SUBMIT_WORK_PLAN_TOOL_NAME,
            arguments: structuredCandidate,
          }]
        : []
      : result.toolCalls;
    const normalized = normalizeProviderResponseV1({
      visibleText: structuredCandidate ? "" : rawVisibleText,
      toolCalls: adaptedToolCalls,
      usage: result.usage,
      diagnostics: [
        ...(result.protocolViolation
          ? [{ code: result.protocolViolation, message: "Plan tool protocol mismatch", retryable: true }]
          : []),
        ...(structuredCandidate
          ? [{
              code: "structured_response_adapted",
              message: "A complete schema-bound response was normalized as the sole Plan submission.",
              retryable: false,
            }]
          : []),
      ],
    });
    input.logStoreEvent("runtime_v2_plan_provider_response_shape", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      stage: input.stage,
      transport,
      finishReason: result.finishReason || null,
      contentChars: String(rawVisibleText || "").length,
      reasoningChars: String(result.reasoningContent || "").length,
      nativeToolCallCount: result.toolCalls.length,
      normalizedToolCallCount: normalized.toolCalls.length,
      exactStructuredObject: !!structuredCandidate,
      protocolViolation: result.protocolViolation || null,
    });
    await input.ledger.settleCommand({
      type: "provider.responded",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      result: normalized,
    });
    input.messages.push({
      role: "assistant",
      content: structuredCandidate ? "" : rawVisibleText,
      ...(normalized.toolCalls.length > 0
        ? {
            tool_calls: normalized.toolCalls.map((call) => ({
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
    return normalized;
  } catch (error) {
    const providerRequestTimedOut = requestTimedOut || isPlanProviderRequestTimeout(
      error,
      requestAbort.signal,
      input.context.abortCtrl.signal,
    );
    await input.ledger.settleCommand({
      type: "command.completed",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      status: input.context.abortCtrl.signal.aborted ? "canceled" : "failed",
    });
    input.logStoreEvent("runtime_v2_plan_provider_request_closed", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      stage: input.stage,
      transport,
      timeoutMs: requestTimeoutMs,
      timedOut: providerRequestTimedOut,
      errorName: error instanceof Error ? error.name : "",
      error: error instanceof Error ? error.message : String(error || ""),
    });
    throw providerRequestTimedOut
      ? new Error("RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT")
      : error;
  } finally {
    input.context.abortCtrl.signal.removeEventListener("abort", forwardAbort);
  }
}
