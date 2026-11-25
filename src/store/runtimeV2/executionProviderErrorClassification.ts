import { isNativeToolCompatibilityErrorMessage } from "../../lib/providerCompatibility";
import {
  isRuntimeV2ProviderProtocolError,
  RuntimeV2ProviderProtocolError,
  runtimeV2ProviderProtocolErrorAllowsTransportFallback,
  type RuntimeV2Command,
  type RuntimeV2TransportVariant,
} from "../../lib/runtime-v2";
import { isRuntimeV2ExecutionProviderTimeout } from "./executionProviderDeadline";
import { appendRuntimeV2ProviderFeedbackHistory } from "./executionProviderHistory";
import type { RuntimeV2LiveExecutionState } from "./executionTypes";

const VISIBLE_REPETITION_FEEDBACK_PREFIX =
  "[runtime-v2 provider feedback: visible_stream_repetition]";

function isVisibleStreamRepetitionError(error: unknown, errorMessage: string): boolean {
  return (
    /STREAM_VISIBLE_TEXT_REPETITION/i.test(errorMessage) ||
    (error instanceof Error &&
      (error as Error & { code?: string }).code === "STREAM_VISIBLE_TEXT_REPETITION")
  );
}

/**
 * Normalize one failed provider attempt into a durable protocol or transport
 * error and record causal feedback before retry decisions run.
 */
export function classifyAndRecordRuntimeV2ProviderAttemptError(input: {
  readonly error: unknown;
  readonly textEnvelope: boolean;
  readonly attemptVariant: RuntimeV2TransportVariant;
  readonly command: RuntimeV2Command;
  readonly live: RuntimeV2LiveExecutionState;
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}): {
  readonly lastError: unknown;
  readonly protocolFallbackAllowed: boolean;
} {
  const requestTimedOut = isRuntimeV2ExecutionProviderTimeout(input.error);
  const errorMessage = input.error instanceof Error
    ? input.error.message
    : String(input.error);
  const visibleRepetition = isVisibleStreamRepetitionError(
    input.error,
    errorMessage,
  );

  let normalizedError: unknown;
  if (requestTimedOut) {
    normalizedError = new Error("RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT");
  } else if (visibleRepetition) {
    for (let index = input.live.messages.length - 1; index >= 0; index -= 1) {
      const content = input.live.messages[index]?.content;
      if (
        typeof content === "string" &&
        content.includes(VISIBLE_REPETITION_FEEDBACK_PREFIX)
      ) {
        input.live.messages.splice(index, 1);
      }
    }
    appendRuntimeV2ProviderFeedbackHistory(input.live, {
      code: "visible_stream_repetition",
      feedback:
        "Previous response entered a repetitive text loop and was aborted. Do not repeat prose or restate prior plans; emit one concrete tool call now, or output a concise non-repetitive conclusion only if all required mutations and validations are already complete.",
    });
    normalizedError = new RuntimeV2ProviderProtocolError(
      "provider_response_rejected",
      errorMessage,
    );
  } else if (!input.textEnvelope && isNativeToolCompatibilityErrorMessage(errorMessage)) {
    normalizedError = new RuntimeV2ProviderProtocolError(
      "native_tools_unsupported",
      errorMessage,
    );
  } else {
    normalizedError = input.error;
  }

  const protocolFallbackAllowed = runtimeV2ProviderProtocolErrorAllowsTransportFallback(
    normalizedError,
    {
      activeTransportProven:
        input.live.provenStructuredToolTransports?.has(input.attemptVariant) ===
          true,
    },
  );
  input.logStoreEvent(
    isRuntimeV2ProviderProtocolError(normalizedError)
      ? "runtime_v2_provider_protocol_failed"
      : "runtime_v2_provider_transport_failed",
    {
      turnId: input.command.run.turnId,
      runId: input.command.run.runId,
      commandKey: input.command.idempotencyKey,
      transport: input.attemptVariant,
      error: normalizedError instanceof Error
        ? normalizedError.message
        : String(normalizedError),
      ...(visibleRepetition ? { repetitionAborted: true } : {}),
      ...(isRuntimeV2ProviderProtocolError(normalizedError)
        ? {
            protocolCode: normalizedError.code,
            transportFallbackAllowed: protocolFallbackAllowed,
          }
        : {}),
    },
  );
  return {
    lastError: normalizedError,
    protocolFallbackAllowed,
  };
}
