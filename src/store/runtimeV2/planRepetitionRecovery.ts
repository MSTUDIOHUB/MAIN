import type { RuntimeV2Event, RuntimeV2RunIdentity, TurnAggregateV1 } from "../../lib/runtime-v2";
import type { PlanProviderTransport } from "./planModelProtocol";

export const PLAN_STREAM_REPETITION_CODE = "STREAM_VISIBLE_TEXT_REPETITION";
export const PLAN_REPETITION_FALLBACK_FAILED = "runtime_v2_plan_repetition_fallback_failed";

export function isPlanStreamRepetition(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { code?: string }).code === PLAN_STREAM_REPETITION_CODE;
}

export function restorePlanSynthesisTransport(
  events: readonly RuntimeV2Event[],
  request: RuntimeV2Event | undefined,
  compactRecovery: boolean,
  restoreBoundedOutput: boolean,
): { transport: PlanProviderTransport; explicitFallback: boolean } {
  if (request?.type !== "command.scheduled" || restoreBoundedOutput) {
    return { transport: "native_tool", explicitFallback: false };
  }
  const { idempotencyKey, payload } = request.command;
  const transport = payload.transport === "structured_response" ? "structured_response" : "native_tool";
  const settled = events.find(event => "idempotencyKey" in event && event.idempotencyKey === idempotencyKey &&
    (event.type === "command.completed" || event.type === "provider.responded"));
  const failed = settled?.type === "command.completed" && settled.status === "failed" &&
    (compactRecovery || payload.stage === "synthesis");
  const noAction = compactRecovery && settled?.type === "provider.responded" && !settled.result.toolCalls.length &&
    !settled.result.diagnostics.some(item => item.code === "tool_arguments_rejected" || item.code === "tool_surface_rejected");
  if (failed || noAction) {
    return { transport: transport === "structured_response" ? "native_tool" : "structured_response", explicitFallback: true };
  }
  // A successful structured fallback may have asked a real user question.
  // Resume with investigation tools on the next request, including after reload.
  if (settled?.type === "provider.responded" && payload.planRepetitionFallback === true) {
    return { transport: "native_tool", explicitFallback: false };
  }
  return { transport, explicitFallback: !settled && payload.planExplicitFallback === true };
}

/** A repeat guard is deterministic for a request. Try the alternate contract
 * once on the current evidence frontier, and keep that decision across reloads. */
export function planRepetitionRecovery(
  aggregate: TurnAggregateV1,
  run: RuntimeV2RunIdentity,
  recoveryStartedSequence: number | undefined,
): { kind: "alternate"; from: PlanProviderTransport; to: PlanProviderTransport } | { kind: "exhausted" } | null {
  if (recoveryStartedSequence === undefined) return null;
  const requests = new Map(aggregate.events.flatMap(event =>
    event.type === "command.scheduled" && event.command.kind === "request_model" &&
      event.run.runId === run.runId && event.run.attemptId === run.attemptId
      ? [[event.command.idempotencyKey, event.command.payload] as const] : [],
  ));
  let failedTransport: PlanProviderTransport | null = null;
  for (const event of aggregate.events) {
    if (event.sequence < recoveryStartedSequence ||
      (event.type !== "command.completed" && event.type !== "provider.responded")) continue;
    const request = requests.get(event.idempotencyKey);
    if (!request) continue;
    if (request.planRepetitionFallback === true) {
      // Bootstrap retires an interrupted request without a provider failure
      // code. It has not consumed this recovery option.
      if (event.type === "command.completed" && event.status === "failed" &&
        (event.failureReasonCode === PLAN_STREAM_REPETITION_CODE ||
          event.failureReasonCode === PLAN_REPETITION_FALLBACK_FAILED)) return { kind: "exhausted" };
      if (event.type === "provider.responded") {
        if (!event.result.toolCalls.length) return { kind: "exhausted" };
        failedTransport = null;
      }
    }
    if (event.type === "command.completed" && event.status === "failed" &&
      event.failureReasonCode === PLAN_STREAM_REPETITION_CODE &&
      (request.transport === "native_tool" || request.transport === "text_envelope" || request.transport === "structured_response")) {
      failedTransport = request.transport;
    }
  }
  return failedTransport && {
    kind: "alternate",
    from: failedTransport,
    to: failedTransport === "structured_response" ? "native_tool" : "structured_response",
  };
}
