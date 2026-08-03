import type {
  RuntimeV2Command,
  RuntimeV2TransportVariant,
} from "../../lib/runtime-v2/contracts";
import {
  RuntimeV2LifecycleDeadlineError,
} from "../../lib/runtime-v2/lifecycle";
import { withRuntimeV2HardDeadline } from "./hardDeadline";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export const RUNTIME_V2_EXECUTION_PROVIDER_TIMEOUT_ERROR =
  "RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT";

function usesSharedLifecycleDeadline(
  ports: RuntimeV2ExecutionPortsInput,
  requestDeadlineAt?: number,
): boolean {
  return Number.isFinite(requestDeadlineAt) &&
    Number.isFinite(ports.lifecycleDeadlineAt) &&
    Number(ports.lifecycleDeadlineAt) === requestDeadlineAt;
}

function lifecycleDeadlineFailure(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly requestDeadlineAt: number;
  readonly transport: RuntimeV2TransportVariant | null;
}): RuntimeV2LifecycleDeadlineError {
  input.ports.logStoreEvent("runtime_v2_lifecycle_deadline_reached", {
    turnId: input.command.run.turnId,
    runId: input.command.run.runId,
    phase: input.command.phase,
    commandKind: input.command.kind,
    transport: input.transport,
    lifecycleDeadlineAt: input.requestDeadlineAt,
  });
  return new RuntimeV2LifecycleDeadlineError();
}

export function assertRuntimeV2ProviderRequestDeadline(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly requestDeadlineAt?: number;
  readonly transport: RuntimeV2TransportVariant | null;
}): void {
  const requestDeadlineAt = Number(input.requestDeadlineAt);
  if (
    Number.isFinite(requestDeadlineAt) &&
    usesSharedLifecycleDeadline(input.ports, requestDeadlineAt) &&
    Date.now() >= requestDeadlineAt
  ) {
    throw lifecycleDeadlineFailure({
      ...input,
      requestDeadlineAt,
    });
  }
}

export function isRuntimeV2ExecutionProviderTimeout(
  error: unknown,
): boolean {
  return error instanceof Error &&
    error.message === RUNTIME_V2_EXECUTION_PROVIDER_TIMEOUT_ERROR;
}

export async function executeRuntimeV2ProviderWithDeadline<T>(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly requestDeadlineAt?: number;
  readonly transport: RuntimeV2TransportVariant | null;
  readonly signal: AbortSignal;
  readonly task: (request: {
    readonly signal: AbortSignal;
    readonly timeoutMs?: number;
  }) => Promise<T>;
}): Promise<T> {
  assertRuntimeV2ProviderRequestDeadline(input);
  if (!Number.isFinite(input.requestDeadlineAt)) {
    return input.task({
      signal: input.signal,
      timeoutMs: undefined,
    });
  }
  const requestDeadlineAt = Number(input.requestDeadlineAt);
  const sharedLifecycleDeadline = usesSharedLifecycleDeadline(
    input.ports,
    requestDeadlineAt,
  );
  const timeoutMs = Math.max(1, requestDeadlineAt - Date.now());
  const requestAbort = new AbortController();
  const forwardAbort = () => requestAbort.abort(input.signal.reason);
  if (input.signal.aborted) forwardAbort();
  else input.signal.addEventListener("abort", forwardAbort, { once: true });
  let timedOut = false;
  try {
    return await withRuntimeV2HardDeadline({
      timeoutMs,
      timeoutError: RUNTIME_V2_EXECUTION_PROVIDER_TIMEOUT_ERROR,
      onTimeout: () => {
        timedOut = true;
        requestAbort.abort(
          sharedLifecycleDeadline
            ? "runtime_v2_lifecycle_deadline"
            : "runtime_v2_execution_provider_request_timeout",
        );
      },
      task: () => input.task({
        signal: requestAbort.signal,
        timeoutMs,
      }),
    });
  } catch (error) {
    if (timedOut && sharedLifecycleDeadline) {
      throw lifecycleDeadlineFailure({
        ...input,
        requestDeadlineAt,
      });
    }
    throw error;
  } finally {
    input.signal.removeEventListener("abort", forwardAbort);
  }
}
