import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import {
  allocateProviderAttemptTimeoutMs,
  recordProviderTransportAttempt,
  isRuntimeV2ProviderProtocolError,
  selectNextProviderTransportAttempt,
  type ProviderPort,
  type RuntimeV2TransportVariant,
} from "../../lib/runtime-v2";
import {
  appendRuntimeV2ProtocolDriftHistory,
  appendRuntimeV2AssistantToolCallHistory,
  baseProviderProfile,
  providerToolDefinitionsForCommand,
  recordModelContext,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import {
  boundRuntimeV2ProviderToolCalls,
  completedRuntimeV2ProviderToolCallIdentities,
  runtimeV2ProviderCoveredReadReceipt,
  runtimeV2ProviderReadIsFullyCovered,
  runtimeV2ProviderToolCallConstraint,
  scopeRuntimeV2ProviderToolCallIds,
  unexpectedRuntimeV2ProviderToolNames,
} from "./providerToolSurface";
import { withRuntimeV2HardDeadline } from "./hardDeadline";
import {
  requestRuntimeV2ProviderOnce,
  runtimeV2ExecutionProviderOutputTokenLimit,
  runtimeV2ProviderProtocolError,
} from "./executionProviderRequest";

export const RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT_MS = 90_000;

function rememberResult(
  input: RuntimeV2ExecutionPortsInput,
  command: Parameters<ProviderPort["request"]>[0]["command"],
  result: Awaited<ReturnType<typeof requestRuntimeV2ProviderOnce>>,
): void {
  input.live.latestProviderResult = result;
  input.live.latestVisibleText = result.toolCalls.length === 0
    ? sanitizeAssistantDisplayContent(result.visibleText || "")
      .trim()
      .slice(0, 24_000)
    : "";
  if (input.live.latestVisibleText) {
    recordModelContext(input.live, {
      id: `provider:${command.idempotencyKey}`,
      source: "provider",
      label: `synthesis:${String(command.payload.mode || "unknown")}`,
      target: "current-turn",
      status: "succeeded",
      content: input.live.latestVisibleText,
    });
  }
  if (result.toolCalls.length > 0) {
    appendRuntimeV2AssistantToolCallHistory(input.live, result);
  }
}

export function createRuntimeV2ProviderPort(
  input: RuntimeV2ExecutionPortsInput,
): ProviderPort {
  return {
    async request({ command, signal }) {
      const state = input.get();
      const requiresTool = command.payload.toolExpectation === "required";
      if (!input.live.providerLaneProfile) {
        input.live.providerLaneProfile = baseProviderProfile(state);
      }
      const profile = {
        ...input.live.providerLaneProfile,
        schemaVersion: "provider-lane.v1" as const,
        requiredToolChoice: requiresTool,
      };
      const tools = providerToolDefinitionsForCommand(input, command);
      const allowedToolNames = tools.map((tool) => tool.function.name);
      if (requiresTool && tools.length === 0) {
        throw new Error("RUNTIME_V2_REQUIRED_TOOL_SURFACE_EMPTY");
      }
      const requestDeadlineAt = Math.min(
        Date.now() + RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT_MS,
        input.lifecycleDeadlineAt ?? Number.POSITIVE_INFINITY,
      );

      if (tools.length === 0) {
        const timeoutMs = Math.max(1, requestDeadlineAt - Date.now());
        let result = await requestRuntimeV2ProviderOnce({
          live: input.live,
          ports: input,
          command,
          tools: [],
          textEnvelope: false,
          toolChoice: null,
          signal,
          timeoutMs,
        });
        result = {
          ...result,
          toolCalls: scopeRuntimeV2ProviderToolCallIds(
            result.toolCalls,
            () => input.nextId("provider-tool-call"),
          ),
        };
        rememberResult(input, command, result);
        return result;
      }

      let epoch: {
        actionKey: string;
        attempted: readonly RuntimeV2TransportVariant[];
      } = {
        actionKey: command.idempotencyKey,
        attempted: [],
      };
      let lastError: unknown = null;
      while (Date.now() < requestDeadlineAt) {
        const attempt = selectNextProviderTransportAttempt(profile, epoch);
        if (!attempt) break;
        epoch = recordProviderTransportAttempt(epoch, attempt);
        const requestAbort = new AbortController();
        const forwardAbort = () => requestAbort.abort(signal.reason);
        if (signal.aborted) forwardAbort();
        else signal.addEventListener("abort", forwardAbort, { once: true });
        const remainingMs = Math.max(1, requestDeadlineAt - Date.now());
        const hasFallback =
          selectNextProviderTransportAttempt(profile, epoch) !== null;
        const timeoutMs = allocateProviderAttemptTimeoutMs(
          remainingMs,
          hasFallback,
        );
        let requestTimedOut = false;
        try {
          input.logStoreEvent("runtime_v2_provider_request_opened", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            phase: command.phase,
            transport: attempt.variant,
            toolExpectation: requiresTool ? "required" : "optional",
            allowedToolNames,
            hasFallback,
            timeoutMs,
            maxOutputTokens: runtimeV2ExecutionProviderOutputTokenLimit(
              command,
              attempt.textEnvelope,
              input.context.runtimeContextBudget,
            ),
          });
          let result = await withRuntimeV2HardDeadline({
            timeoutMs,
            timeoutError: "RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT",
            onTimeout: () => {
              requestTimedOut = true;
              requestAbort.abort("runtime_v2_execution_provider_request_timeout");
            },
            task: () => requestRuntimeV2ProviderOnce({
              live: input.live,
              ports: input,
              command,
              tools,
              textEnvelope: attempt.textEnvelope,
              toolChoice: attempt.toolChoice,
              signal: requestAbort.signal,
              timeoutMs,
            }),
          });
          if (requiresTool && result.toolCalls.length === 0) {
            const protocolError = runtimeV2ProviderProtocolError({
              ports: input,
              command,
              code: "required_tool_missing",
              requestedToolNames: [],
              allowedToolNames,
            });
            appendRuntimeV2ProtocolDriftHistory(input.live, {
              visibleText: result.visibleText || "",
              code: "required_tool_missing",
              feedback: [
                protocolError.message,
                `Allowed tools: ${allowedToolNames.join(", ")}.`,
                "The response did not advance the task. Submit exactly one different allowed structured action.",
              ].join("\n"),
            });
            throw protocolError;
          }
          const unexpected = unexpectedRuntimeV2ProviderToolNames(
            tools,
            result.toolCalls,
          );
          if (unexpected.length > 0) {
            const protocolError = runtimeV2ProviderProtocolError({
              ports: input,
              command,
              code: "tool_surface_rejected",
              requestedToolNames: unexpected,
              allowedToolNames,
            });
            appendRuntimeV2ProtocolDriftHistory(input.live, {
              visibleText: result.visibleText || "",
              code: "tool_surface_rejected",
              feedback: [
                protocolError.message,
                `Allowed tools: ${allowedToolNames.join(", ")}.`,
                "The response did not advance the task. Submit exactly one allowed structured action.",
              ].join("\n"),
            });
            throw protocolError;
          }
          const uncoveredCalls = result.toolCalls.filter((call) =>
            !runtimeV2ProviderReadIsFullyCovered(
              call,
              input.live.messages,
            )
          );
          const batch = boundRuntimeV2ProviderToolCalls(
            uncoveredCalls.length > 0 ? uncoveredCalls : result.toolCalls,
            completedRuntimeV2ProviderToolCallIdentities(
              input.live.messages,
            ),
            new Set(input.live.rejectedProviderActions.keys()),
          );
          if (batch.selection === "all_rejected") {
            const protocolError = runtimeV2ProviderProtocolError({
              ports: input,
              command,
              code: "repeated_action_rejected",
              requestedToolNames: result.toolCalls.map((call) => call.name),
              allowedToolNames,
              detail: [
                "The provider returned only exact actions already rejected at the current source boundary.",
                ...result.toolCalls.map(
                  runtimeV2ProviderToolCallConstraint,
                ),
                "Return a different allowed structured action.",
              ].join("\n"),
            });
            appendRuntimeV2ProtocolDriftHistory(input.live, {
              visibleText: result.visibleText || "",
              code: "repeated_action_rejected",
              feedback: [
                protocolError.message,
                `Allowed tools: ${allowedToolNames.join(", ")}.`,
                "The response did not advance the task. Submit exactly one different allowed structured action.",
              ].join("\n"),
            });
            throw protocolError;
          }
          const acceptedCall = batch.accepted[0];
          const discardedCalls = result.toolCalls.filter(
            (call) => call !== acceptedCall,
          );
          if (discardedCalls.length > 0) {
            input.logStoreEvent("runtime_v2_provider_tool_batch_normalized", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              acceptedToolName: acceptedCall?.name || null,
              discardedToolNames: discardedCalls.map((call) => call.name),
            });
          }
          const coveredReadRejected = !!acceptedCall &&
            runtimeV2ProviderReadIsFullyCovered(
              acceptedCall,
              input.live.messages,
            );
          const coveredReadReceipt = acceptedCall
            ? runtimeV2ProviderCoveredReadReceipt(
                acceptedCall,
                input.live.messages,
              )
            : null;
          result = {
            ...result,
            toolCalls: scopeRuntimeV2ProviderToolCallIds(
              batch.accepted,
              () => input.nextId("provider-tool-call"),
            ),
          };
          if (coveredReadRejected && result.toolCalls[0]) {
            input.live.coveredReadToolResults.set(
              result.toolCalls[0].id,
              coveredReadReceipt,
            );
          }
          rememberResult(input, command, result);
          input.logStoreEvent("runtime_v2_provider_result", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            transport: attempt.variant,
            toolNames: result.toolCalls.map((call) => call.name),
            visibleChars: input.live.latestVisibleText.length,
          });
          return result;
        } catch (error) {
          lastError = requestTimedOut
            ? new Error("RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT")
            : error;
          input.logStoreEvent(
            isRuntimeV2ProviderProtocolError(lastError)
              ? "runtime_v2_provider_protocol_failed"
              : "runtime_v2_provider_transport_failed",
            {
              turnId: command.run.turnId,
              runId: command.run.runId,
              transport: attempt.variant,
              error: lastError instanceof Error
                ? lastError.message
                : String(lastError),
            },
          );
        } finally {
          signal.removeEventListener("abort", forwardAbort);
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error("RUNTIME_V2_PROVIDER_TRANSPORTS_UNAVAILABLE");
    },
  };
}
