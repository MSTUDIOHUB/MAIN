import {
  isRuntimeV2LifecycleDeadlineError,
  isRuntimeV2ProviderProtocolError,
  runtimeV2ProviderAttemptFailure,
  type RuntimeV2Command,
  type RuntimeV2NormalizedProviderResult,
} from "../../lib/runtime-v2";
import {
  executeRuntimeV2ProviderWithDeadline,
} from "./executionProviderDeadline";
import {
  rememberRuntimeV2ProviderResult,
} from "./executionProviderHistory";
import {
  requestRuntimeV2ProviderOnce,
} from "./executionProviderRequest";
import {
  rejectRuntimeV2UnexpectedProviderTool,
} from "./executionProviderSurfaceRejection";
import type {
  RuntimeV2ExecutionPortsInput,
} from "./executionTypes";
import {
  scopeRuntimeV2ProviderToolCallIds,
} from "./providerToolSurface";

/**
 * Execute may legitimately expose no tools while asking for a concise final
 * response. Keep that request path separate from transport negotiation, but
 * still quarantine any structured action the provider emits against the
 * authoritative empty surface before it can receive an executable call id.
 */
export async function requestRuntimeV2ProviderWithEmptySurface(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly requestDeadlineAt?: number;
  readonly signal: AbortSignal;
}): Promise<RuntimeV2NormalizedProviderResult> {
  let result: RuntimeV2NormalizedProviderResult;
  try {
    result = await executeRuntimeV2ProviderWithDeadline({
      ports: input.ports,
      command: input.command,
      requestDeadlineAt: input.requestDeadlineAt,
      transport: null,
      signal: input.signal,
      task: (request) => requestRuntimeV2ProviderOnce({
        live: input.ports.live,
        ports: input.ports,
        command: input.command,
        tools: [],
        textEnvelope: false,
        toolChoice: null,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
      }),
    });
  } catch (error) {
    if (isRuntimeV2LifecycleDeadlineError(error)) throw error;
    if (isRuntimeV2ProviderProtocolError(error)) throw error;
    throw runtimeV2ProviderAttemptFailure(error);
  }
  const surfaceRejection = rejectRuntimeV2UnexpectedProviderTool({
    ports: input.ports,
    command: input.command,
    tools: [],
    result,
  });
  if (surfaceRejection) return surfaceRejection;
  result = {
    ...result,
    toolCalls: scopeRuntimeV2ProviderToolCallIds(
      result.toolCalls,
      () => input.ports.nextId("provider-tool-call"),
    ),
  };
  rememberRuntimeV2ProviderResult(input.ports, result);
  return result;
}
