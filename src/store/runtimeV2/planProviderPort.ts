import type { AgentMessage } from "../../lib/agentMessages";
import { deriveStreamSettings } from "../../lib/providerLaneSettings";
import { streamChatCompletion } from "../../lib/streaming";
import {
  normalizeProviderResponseV1,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2RunIdentity,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import { PlanLedger } from "./planLedger";
import {
  PLAN_AUDIT_TOOLS,
  PLAN_MODEL_REQUEST_TIMEOUT_MS,
  PLAN_MODEL_TOOLS,
  PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
  PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
  PLAN_SYNTHESIS_REQUEST_TIMEOUT_MS,
  SUBMIT_WORK_PLAN_TOOL,
  SUBMIT_WORK_PLAN_TOOL_NAME,
  auditDiscoveryPlanTranscript,
  boundedPlanTranscript,
  isPlanProviderRequestTimeout,
  isPlanSubmissionStage,
  synthesisPlanTranscript,
  type PlanModelStage,
} from "./planModelProtocol";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

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
  readonly logStoreEvent: RuntimeV2PlanLog;
}): Promise<RuntimeV2NormalizedProviderResult> {
  const submissionStage = isPlanSubmissionStage(input.stage);
  const offeredTools = submissionStage
    ? [SUBMIT_WORK_PLAN_TOOL]
    : input.stage === "audit_discovery"
    ? PLAN_AUDIT_TOOLS
    : PLAN_MODEL_TOOLS;
  const toolChoice = submissionStage
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
  const requestTimeout = setTimeout(() => {
    requestTimedOut = true;
    requestAbort.abort("runtime_v2_plan_provider_request_timeout");
  }, requestTimeoutMs);
  const requestMessages = input.stage === "synthesis"
    ? synthesisPlanTranscript({
        ...input,
        audit: false,
        compactRecovery: !!input.compactRecovery,
      })
    : input.stage === "audit_synthesis"
    ? synthesisPlanTranscript({
        ...input,
        audit: true,
        compactRecovery: !!input.compactRecovery,
      })
    : input.stage === "audit_discovery"
    ? auditDiscoveryPlanTranscript(input)
    : boundedPlanTranscript(input.messages);
  try {
    input.logStoreEvent("runtime_v2_plan_provider_request_opened", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      evidenceCount: input.ledger.snapshot()?.evidence.length || 0,
      stage: input.stage,
      compactRecovery: !!input.compactRecovery,
      offeredToolCount: offeredTools.length,
      offeredToolNames: offeredTools.map((tool) => tool.function.name),
      promptMessageCount: requestMessages.length,
      promptChars: requestMessages.reduce(
        (total, message) => total + String(message.content || "").length,
        0,
      ),
      timeoutMs: requestTimeoutMs,
    });
    const result = await streamChatCompletion(
      requestMessages,
      deriveStreamSettings(input.get().config),
      {
        onToken: (token) => { streamedText += token; },
        onDone: () => undefined,
        onError: () => undefined,
      },
      requestAbort.signal,
      offeredTools,
      input.compactRecovery ? PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS : undefined,
      { toolChoice, timeoutMs: requestTimeoutMs },
    );
    const normalized = normalizeProviderResponseV1({
      visibleText: result.content || streamedText,
      toolCalls: result.toolCalls,
      usage: result.usage,
      diagnostics: result.protocolViolation
        ? [{ code: result.protocolViolation, message: "Plan tool protocol mismatch", retryable: true }]
        : [],
    });
    await input.ledger.append({
      type: "provider.responded",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      result: normalized,
    });
    input.messages.push({
      role: "assistant",
      content: result.content || streamedText,
      ...(result.toolCalls.length > 0
        ? {
            tool_calls: result.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
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
    await input.ledger.append({
      type: "command.completed",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      status: input.context.abortCtrl.signal.aborted ? "canceled" : "failed",
    });
    input.logStoreEvent("runtime_v2_plan_provider_request_closed", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      stage: input.stage,
      timeoutMs: requestTimeoutMs,
      timedOut: providerRequestTimedOut,
      errorName: error instanceof Error ? error.name : "",
      error: error instanceof Error ? error.message : String(error || ""),
    });
    throw providerRequestTimedOut
      ? new Error("RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT")
      : error;
  } finally {
    clearTimeout(requestTimeout);
    input.context.abortCtrl.signal.removeEventListener("abort", forwardAbort);
  }
}
