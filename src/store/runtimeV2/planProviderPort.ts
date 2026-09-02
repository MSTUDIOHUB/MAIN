import type { AgentMessage } from "../../lib/agentMessages";
import { acquireModelLane } from "../../lib/modelLaneCoordinator";
import { deriveBudgetedStreamSettings, deriveProviderAdapterCapabilities } from "../../lib/providerLaneSettings";
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
  PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
  PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
  PLAN_SYNTHESIS_REQUEST_TIMEOUT_MS,
  SUBMIT_WORK_PLAN_TOOL_NAME,
  WORK_PLAN_STRUCTURED_RESPONSE_FORMAT,
  boundedPlanTranscript,
  decodeExactStructuredPlanResponse,
  isPlanProviderRequestTimeout,
  isPlanSubmissionStage,
  planModelTools,
  selectPlanModelTools,
  synthesisPlanTranscript,
  type PlanModelStage,
  type PlanProviderTransport,
} from "./planModelProtocol";
import type { RuntimeV2SubmissionContext } from "./submissionContext";
import { withRuntimeV2HardDeadline, withRuntimeV2ProgressDeadline } from "./hardDeadline";
import { containsProviderTextEnvelopePrompt } from "./executionProviderContext";
import {
  buildRuntimeV2TextEnvelopeCatalog,
  normalizeRuntimeV2ProviderToolCalls,
  runtimeV2ProviderToolArgumentViolation,
} from "./executionProviderTools";
import { PLAN_REQUIRED_COLLABORATION_PROVIDER_TIMEOUT_CODE } from "./planCollaborationAcquisition";
type StoreGet = () => any;
type RuntimeV2PlanLog = (event: string, data?: Record<string, unknown>) => void;
export interface RuntimeV2PlanProviderResult extends
  RuntimeV2NormalizedProviderResult {
  /** Exact request-local tool surface, independent of native versus text
   * transport. This port enforces it before durable settlement; the runner
   * retains the snapshot for structured recovery telemetry. */
  readonly advertisedToolNames: readonly string[];
}
export function isPlanRequiredCollaborationUnavailable(
  error: unknown,
): boolean {
  return error instanceof Error &&
    error.message === "RUNTIME_V2_PLAN_REQUIRED_COLLABORATION_UNAVAILABLE";
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
  readonly logStoreEvent: RuntimeV2PlanLog;
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
  const requestedTransport = submissionStage
    ? input.compactRecovery
      ? "structured_response"
      : input.transport || "native_tool"
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
  const textEnvelope = transport === "text_envelope";
  const activeSubagents = Array.isArray(input.collaboration.activeSubagents)
    ? input.collaboration.activeSubagents
    : [];
  const planTools = selectPlanModelTools({
    submissionStage,
    collaborationAllowed:
      input.collaboration.collaborationAllowed === true,
    collaborationRequired:
      input.collaboration.collaborationRequired === true,
    collaborationRequirementMet:
      input.collaboration.collaborationRequirementMet === true,
    remainingSubagentCapacity: Math.max(
      0,
      Math.floor(
        Number(input.collaboration.remainingSubagentCapacity) || 0,
      ),
    ),
    activeSubagentCount: activeSubagents.length,
    baseTools: planModelTools(input.context, input.get()),
  });
  const requiredSpawn = requiredCollaborationPending &&
    planTools.length === 1 &&
    planTools[0]?.function.name === "spawn_subagent";
  if (requiredCollaborationPending && !requiredSpawn) {
    throw new Error("RUNTIME_V2_PLAN_REQUIRED_COLLABORATION_UNAVAILABLE");
  }
  const advertisedToolNames = planTools.map((tool) => tool.function.name);
  const offeredTools = structuredResponse || textEnvelope ? [] : planTools;
  const toolChoice = structuredResponse || textEnvelope
    ? undefined
    : requiredSpawn
    ? {
        type: "function" as const,
        function: { name: "spawn_subagent" },
      }
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
    submissionRepairPending: input.submissionRepairPending,
    ...input.collaboration,
    requiredSpawn,
  });
  let streamedText = "";
  const requestAbort = new AbortController();
  let requestTimedOut = false;
  let lifecycleTimedOut = false;
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
  const planRequestMessages = submissionStage
    ? synthesisPlanTranscript({
        ...input,
        submissionRepairPending: input.submissionRepairPending,
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
    ? input.compactRecovery
      ? Math.min(
          budget?.outputBudget ?? PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
          PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
        )
      : budget?.outputBudget ?? PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS
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
      submissionRepairPending: input.submissionRepairPending,
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
      promptChars: requestMessages.reduce(
        (total, message) => total + String(message.content || "").length,
        0,
      ),
      contextLimit: budget?.contextLimit ?? null,
      maxOutputTokens: maxOutputTokens ?? null,
      timeoutMs: requestTimeoutMs,
    });
    const requestTokenBudget = Math.max(
      2_048,
      Math.ceil(requestMessages.reduce(
        (total, message) => total + String(message.content || "").length,
        0,
      ) / 4) + (maxOutputTokens || 4_096),
    );
    const lifecycleTimeoutMs = Math.max(1, input.deadlineAt - Date.now());
    const result = await withRuntimeV2HardDeadline({
      timeoutMs: lifecycleTimeoutMs,
      timeoutError: "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT",
      onTimeout: () => {
        requestTimedOut = true;
        lifecycleTimedOut = true;
        requestAbort.abort("runtime_v2_plan_lifecycle_deadline");
      },
      task: async () => {
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
        const streamTimeoutMs = Math.max(
          1,
          Math.min(requestTimeoutMs, input.deadlineAt - Date.now()),
        );
        try {
          return await withRuntimeV2ProgressDeadline({
            timeoutMs: streamTimeoutMs,
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
                },
              },
              requestAbort.signal,
              offeredTools,
              maxOutputTokens,
              {
                ...(toolChoice ? { toolChoice } : {}),
                ...(structuredResponse
                  ? { responseFormat: WORK_PLAN_STRUCTURED_RESPONSE_FORMAT }
                  : {}),
                timeoutMs: streamTimeoutMs,
                contextOwnership: "caller",
              },
            ),
          });
        } catch (error) {
          lane.reportFailure(error);
          throw error;
        } finally {
          lane.setPressureHandler(undefined);
          lane.release();
        }
      },
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
    const providerNormalized = normalizeProviderResponseV1({
      visibleText: structuredCandidate ? "" : rawVisibleText,
      toolCalls: adaptedToolCalls,
      usage: result.usage,
      diagnostics: [
        ...(result.protocolViolation
          ? [{ code: result.protocolViolation, message: "Plan tool protocol mismatch", retryable: true }]
          : []),
        ...(result.finishReason === "length" && adaptedToolCalls.length === 0
          ? [{
              code: "output_truncated",
              message: "Plan output reached its token limit before a complete structured submission.",
              retryable: true,
            }]
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
    const normalized: RuntimeV2NormalizedProviderResult = {
      ...providerNormalized,
      toolCalls: normalizeRuntimeV2ProviderToolCalls(
        providerNormalized.toolCalls,
        planTools,
        input.context.runWorkspace,
      ),
    };
    const unexpectedToolNames = [...new Set(
      normalized.toolCalls
        .map((call) => call.name)
        .filter((name) => !advertisedToolNames.includes(name)),
    )];
    const argumentViolation = unexpectedToolNames.length === 0
      ? runtimeV2ProviderToolArgumentViolation(
          normalized.toolCalls,
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
    };
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
      ...(providerRequestTimedOut && requiredSpawn && !lifecycleTimedOut
        ? {
            failureReasonCode:
              PLAN_REQUIRED_COLLABORATION_PROVIDER_TIMEOUT_CODE,
          }
        : {}),
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
