import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { isNativeToolCompatibilityErrorMessage } from "../../lib/providerCompatibility";
import {
  isWorkspaceMutationToolName,
} from "../../lib/workspaceMutationTools";
import {
  providerActionEpochExhausted,
  recordProviderTransportAttempt,
  isRuntimeV2ProviderProtocolError,
  RuntimeV2ProviderProtocolError,
  RuntimeV2ProviderTransportsUnavailableError,
  runtimeV2ProviderAttemptFailure,
  runtimeV2ProviderProtocolErrorAllowsTransportFallback,
  selectNextProviderTransportAttempt,
  type ProviderPort,
  type RuntimeV2TransportVariant,
} from "../../lib/runtime-v2";
import {
  appendRuntimeV2ProviderFeedbackHistory,
  appendRuntimeV2AssistantToolCallHistory,
  appendRuntimeV2AssistantTextHistory,
  aggregateForCurrentTurn,
  baseProviderProfile,
  deriveRuntimeV2ProviderEffectFacts,
  providerToolDefinitionsForCommand,
  runtimeV2ParallelReadCount,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import {
  boundRuntimeV2ProviderToolCalls,
  completedRuntimeV2ProviderToolCallIdentities,
  runtimeV2ProviderCachedReadCanReplay,
  runtimeV2ProviderCoveredSourceReplayIsClosed,
  runtimeV2ProviderCoveredReadReceipt,
  runtimeV2ProviderReadIsMaterialized,
  runtimeV2ProviderReusableReadReceipt,
  runtimeV2ProviderToolCallIdentity,
  scopeRuntimeV2ProviderToolCallIds,
  unexpectedRuntimeV2ProviderToolNames,
} from "./providerToolSurface";
import { withRuntimeV2HardDeadline } from "./hardDeadline";
import {
  requestRuntimeV2ProviderOnce,
  runtimeV2ExecutionProviderOutputTokenLimit,
  runtimeV2ProviderProtocolError,
} from "./executionProviderRequest";
import {
  normalizeRuntimeV2ProviderToolCalls,
} from "./executionProviderTools";
import {
  runtimeV2RepeatedActionFeedback,
} from "./executionProviderFeedback";

export { runtimeV2RepeatedActionFeedback } from "./executionProviderFeedback";

export const RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT_MS = 90_000;

export function runtimeV2ExecutionProviderDeadlineAt(
  now: number,
  lifecycleDeadlineAt?: number,
): number {
  // Production Execute always owns one absolute lifecycle deadline. A local
  // model's prefill time grows with the exact context it was asked to consume;
  // restarting an otherwise healthy request at a shorter fixed interval only
  // repeats that work and can make completion impossible.
  return Number.isFinite(lifecycleDeadlineAt)
    ? Number(lifecycleDeadlineAt)
    : now + RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT_MS;
}

function rememberResult(
  input: RuntimeV2ExecutionPortsInput,
  result: Awaited<ReturnType<typeof requestRuntimeV2ProviderOnce>>,
): void {
  input.live.latestProviderResult = result;
  input.live.latestVisibleText = result.toolCalls.length === 0
    ? sanitizeAssistantDisplayContent(result.visibleText || "")
      .trim()
      .slice(0, 24_000)
    : "";
  if (input.live.latestVisibleText) {
    appendRuntimeV2AssistantTextHistory(
      input.live,
      input.live.latestVisibleText,
    );
  }
  if (result.toolCalls.length > 0) {
    for (const call of result.toolCalls) {
      if (!isWorkspaceMutationToolName(call.name)) continue;
      input.live.mutationSourceCoverageByToolCallId.set(
        call.id,
        input.live.latestProviderRequestSourceCoverage,
      );
    }
    appendRuntimeV2AssistantToolCallHistory(input.live, result);
  }
}

export function createRuntimeV2ProviderPort(
  input: RuntimeV2ExecutionPortsInput,
): ProviderPort {
  return {
    async request({ command, signal }) {
      const state = input.get();
      if (!input.live.providerLaneProfile) {
        input.live.providerLaneProfile = baseProviderProfile(state);
      }
      const profile = {
        ...input.live.providerLaneProfile,
        schemaVersion: "provider-lane.v1" as const,
        // Execute always lets the provider choose between a structured action
        // and an ordinary no-tool response. Completion remains evidence-gated.
        requiredToolChoice: false,
      };
      const tools = providerToolDefinitionsForCommand(input, command);
      const allowedToolNames = tools.map((tool) => tool.function.name);
      const requestDeadlineAt = runtimeV2ExecutionProviderDeadlineAt(
        Date.now(),
        input.lifecycleDeadlineAt,
      );

      if (tools.length === 0) {
        const timeoutMs = Math.max(1, requestDeadlineAt - Date.now());
        let result;
        try {
          result = await requestRuntimeV2ProviderOnce({
            live: input.live,
            ports: input,
            command,
            tools: [],
            textEnvelope: false,
            toolChoice: null,
            signal,
            timeoutMs,
          });
        } catch (error) {
          if (isRuntimeV2ProviderProtocolError(error)) throw error;
          throw runtimeV2ProviderAttemptFailure(error);
        }
        result = {
          ...result,
          toolCalls: scopeRuntimeV2ProviderToolCallIds(
            result.toolCalls,
            () => input.nextId("provider-tool-call"),
          ),
        };
        rememberResult(input, result);
        return result;
      }

      let epoch: {
        actionKey: string;
        attempted: readonly RuntimeV2TransportVariant[];
      } = {
        actionKey: command.idempotencyKey,
        attempted: [],
      };
      if (providerActionEpochExhausted(profile, epoch)) {
        // The adapter profile produced no compatible candidate before any
        // request was attempted. This structured capability fact, rather than
        // a nullish promise rejection, is the only hard transport boundary.
        throw new RuntimeV2ProviderTransportsUnavailableError();
      }
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
        // A fallback is a capability negotiation path after an explicit
        // protocol error, not a retry for a slow or timed-out request.
        // Therefore the current supported transport owns the full remaining
        // request deadline.
        const timeoutMs = remainingMs;
        let requestTimedOut = false;
        try {
          input.logStoreEvent("runtime_v2_provider_request_opened", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            phase: command.phase,
            transport: attempt.variant,
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
          result = {
            ...result,
            toolCalls: normalizeRuntimeV2ProviderToolCalls(
              result.toolCalls,
              tools,
              input.context.runWorkspace,
            ),
          };
          if (result.toolCalls.length > 0) {
            input.live.provenStructuredToolTransports.add(attempt.variant);
          }
          if (
            result.toolCalls.length === 0 &&
            result.diagnostics.some((diagnostic) =>
              diagnostic.code === "output_truncated"
            )
          ) {
            const responseMode = String(
              command.payload.mode || "",
            ).trim();
            const protocolError = runtimeV2ProviderProtocolError({
              ports: input,
              command,
              code: "output_truncated",
              requestedToolNames: [],
              allowedToolNames,
              detail:
                "The provider output reached its token limit before it produced a complete structured action or conclusion.",
            });
            appendRuntimeV2ProviderFeedbackHistory(input.live, {
              // A length-truncated draft is not a conclusion and often
              // contains a long unfinished analysis. Keep only the causal
              // transport fact so the retry does not inflate its own prompt.
              visibleText: "",
              code: "output_truncated",
              feedback: [
                protocolError.message,
                ["conclude", "analyze", "chat"].includes(responseMode)
                  ? "Return only a concise complete evidence-backed answer within the current output budget."
                  : "Continue from the committed source and submit exactly one allowed structured tool call without narration.",
                `Allowed tools: ${allowedToolNames.join(", ")}.`,
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
            appendRuntimeV2ProviderFeedbackHistory(input.live, {
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
          const providerEffectFacts =
            deriveRuntimeV2ProviderEffectFacts(
              aggregateForCurrentTurn(input),
            );
          const reusableReadReceipts = new Map(
            result.toolCalls.flatMap((call) => {
              const receipt =
                runtimeV2ProviderReusableReadReceipt(
                  call,
                  input.live.messages,
                  providerEffectFacts,
                );
              return receipt
                ? [[
                    runtimeV2ProviderToolCallIdentity(call),
                    receipt,
                  ] as const]
                : [];
            }),
          );
          const coveredReadReceipts = new Map(
            result.toolCalls.flatMap((call) => {
              const identity =
                runtimeV2ProviderToolCallIdentity(call);
              const receipt =
                reusableReadReceipts.get(identity) ||
                runtimeV2ProviderCoveredReadReceipt(
                  call,
                  input.live.messages,
                  providerEffectFacts,
                );
              return receipt
                ? [[identity, receipt] as const]
                : [];
            }),
          );
          const schedulingCalls = result.toolCalls;
          const completedIdentities = new Set(
            completedRuntimeV2ProviderToolCallIdentities(
              input.live.messages,
              providerEffectFacts,
            ),
          );
          for (const call of schedulingCalls) {
            if (
              !coveredReadReceipts.has(
                runtimeV2ProviderToolCallIdentity(call),
              ) ||
              !runtimeV2ProviderCachedReadCanReplay(call)
            ) {
              continue;
            }
            completedIdentities.delete(
              runtimeV2ProviderToolCallIdentity(call),
            );
          }
          const rejectedIdentities = new Set(
            providerEffectFacts.rejectedActionIdentities,
          );
          for (const call of schedulingCalls) {
            if (
              coveredReadReceipts.has(
                runtimeV2ProviderToolCallIdentity(call),
              ) &&
              runtimeV2ProviderReadIsMaterialized(
                call,
                input.live.latestProviderRequestSourceCoverage,
              ) &&
              runtimeV2ProviderCoveredSourceReplayIsClosed(
                call,
                input.live.messages,
                providerEffectFacts,
              )
            ) {
              rejectedIdentities.add(
                runtimeV2ProviderToolCallIdentity(call),
              );
            }
          }
          const batch = boundRuntimeV2ProviderToolCalls(
            schedulingCalls,
            completedIdentities,
            rejectedIdentities,
            {
              maxSpawnSubagents: Math.max(
                0,
                Math.floor(
                  Number(command.payload.remainingSubagentCapacity) || 0,
                ),
              ),
            },
          );
          const runtimeRejectedReason =
            batch.selection === "all_attempted"
              ? "already_completed" as const
              : batch.selection === "all_rejected"
                ? "already_rejected" as const
                : null;
          if (runtimeRejectedReason) {
            const rejectedCall = schedulingCalls[0]!;
            const actionIdentity =
              runtimeV2ProviderToolCallIdentity(rejectedCall);
            const feedback = runtimeV2RepeatedActionFeedback({
              call: rejectedCall,
              reason: runtimeRejectedReason,
              workspace: input.context.runWorkspace || "",
              visibleSourceTargets:
                input.live.latestProviderRequestSourceCoverage.map(
                  (coverage) => coverage.target,
                ),
            });
            appendRuntimeV2ProviderFeedbackHistory(input.live, {
              code: "repeated_action_rejected",
              feedback,
            });
            input.live.latestProviderAssistantReasoning = null;
            result = {
              ...result,
              visibleText: "",
              toolCalls: [],
              diagnostics: [
                ...result.diagnostics,
                {
                  code: "repeated_action_rejected",
                  message:
                    `${runtimeRejectedReason}:${rejectedCall.name}:${actionIdentity}`,
                  retryable: true,
                },
              ],
            };
            rememberResult(input, result);
            input.logStoreEvent("runtime_v2_provider_action_rejected", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              toolName: rejectedCall.name,
              reason: runtimeRejectedReason,
              actionIdentity,
            });
            input.logStoreEvent("runtime_v2_provider_result", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              transport: attempt.variant,
              toolNames: [],
              visibleChars: 0,
            });
            return result;
          }
          const selectedCalls = batch.accepted;
          const acceptedCalls = new Set(selectedCalls);
          const discardedCalls = result.toolCalls.filter(
            (call) => !acceptedCalls.has(call),
          );
          if (discardedCalls.length > 0) {
            input.logStoreEvent("runtime_v2_provider_tool_batch_normalized", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              acceptedToolName: selectedCalls[0]?.name || null,
              acceptedToolNames: selectedCalls.map((call) => call.name),
              discardedToolNames: discardedCalls.map((call) => call.name),
              batchSelection: batch.selection,
            });
          }
          const coveredReads = selectedCalls.map((call) => ({
            receipt: coveredReadReceipts.get(
              runtimeV2ProviderToolCallIdentity(call),
            ) || null,
          }));
          const scopedCalls = scopeRuntimeV2ProviderToolCallIds(
            selectedCalls,
            () => input.nextId("provider-tool-call"),
          );
          const parallelReadCount =
            runtimeV2ParallelReadCount(scopedCalls);
          scopedCalls.forEach((call) => {
            if (call.name === "read_file") {
              input.live.parallelReadCountByToolCallId.set(
                call.id,
                parallelReadCount,
              );
            }
          });
          result = {
            ...result,
            toolCalls: scopedCalls,
          };
          scopedCalls.forEach((call, index) => {
            const covered = coveredReads[index];
            if (!covered?.receipt) return;
            input.live.coveredReadToolResults.set(call.id, covered.receipt);
          });
          rememberResult(input, result);
          input.logStoreEvent("runtime_v2_provider_result", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            transport: attempt.variant,
            toolNames: result.toolCalls.map((call) => call.name),
            visibleChars: input.live.latestVisibleText.length,
          });
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error
            ? error.message
            : String(error);
          const nativeCapabilityError =
            !attempt.textEnvelope &&
            isNativeToolCompatibilityErrorMessage(errorMessage)
              ? new RuntimeV2ProviderProtocolError(
                  "native_tools_unsupported",
                  errorMessage,
                )
              : error;
          lastError = requestTimedOut
            ? new Error("RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT")
            : nativeCapabilityError;
          const protocolFallbackAllowed =
            runtimeV2ProviderProtocolErrorAllowsTransportFallback(
              lastError,
              {
                activeTransportProven:
                  input.live.provenStructuredToolTransports.has(
                    attempt.variant,
                  ),
              },
            );
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
              ...(isRuntimeV2ProviderProtocolError(lastError)
                ? {
                    protocolCode: lastError.code,
                    transportFallbackAllowed:
                      protocolFallbackAllowed,
                  }
                : {}),
            },
          );
          // Changing the tool-call wire format is capability negotiation,
          // not a generic retry. A timeout, network failure, or semantic
          // rejection says nothing about whether text envelopes are safer.
          if (!protocolFallbackAllowed) {
            break;
          }
        } finally {
          signal.removeEventListener("abort", forwardAbort);
        }
      }
      if (isRuntimeV2ProviderProtocolError(lastError)) throw lastError;
      throw runtimeV2ProviderAttemptFailure(lastError);
    },
  };
}
