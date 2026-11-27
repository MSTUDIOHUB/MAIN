import { runtimeV2ProviderOmittedKnowledgeCanReplay } from "./providerReadReceipts";
import { runtimeV2BoundEditorObservation } from "./executionAuthorizationContext";
import { UNITY_GAME_VIEW_TOOL } from "../../lib/runtime-v2/workspaceReadPolicy";
import { runtimeV2UnityGameViewMessage } from "./executionUnityGameView";
import { isReadOnlyContext, readOnlyNetworkPolicy } from "./readOnlyPolicy";
import { runtimeV2TranscriptSkillGuidanceWindows } from "./executionProviderSkillTranscript";
import { normalizePreparedWorkspaceRead } from "./preparedReadOnlyResponse";
import {
  providerActionEpochExhausted,
  recordProviderTransportAttempt,
  isRuntimeV2ProviderProtocolError,
  RuntimeV2ProviderTransportsUnavailableError,
  isRuntimeV2LifecycleDeadlineError,
  runtimeV2ProviderAttemptFailure,
  selectNextProviderTransportAttempt,
  type ProviderPort,
  type RuntimeV2TransportVariant,
} from "../../lib/runtime-v2";
import {
  appendRuntimeV2RejectedToolCallBatchHistory,
  appendRuntimeV2ProviderFeedbackHistory,
  aggregateForCurrentTurn,
  baseProviderProfile,
  deriveRuntimeV2ProviderEffectFacts,
  providerToolDefinitionsForCommand,
  rememberRuntimeV2ProviderResult,
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
} from "./providerToolSurface";
import {
  assertRuntimeV2ProviderRequestDeadline,
  executeRuntimeV2ProviderWithDeadline,
} from "./executionProviderDeadline";
import { classifyAndRecordRuntimeV2ProviderAttemptError } from "./executionProviderErrorClassification";
import { requestRuntimeV2ProviderWithEmptySurface } from "./executionProviderEmptySurface";
import {
  requestRuntimeV2ProviderOnce,
  runtimeV2ExecutionProviderOutputTokenLimit,
  runtimeV2ProviderProtocolError,
} from "./executionProviderRequest";
import { runtimeV2ExecutionProviderDeadlineAt } from "./executionProviderRequestPolicy";
import { normalizeRuntimeV2ProviderToolCalls } from "./executionProviderTools";
import {
  buildRuntimeV2RepeatedActionReceipts,
  runtimeV2DeferredToolReceipts,
} from "./executionProviderFeedback";
import {
  rejectRuntimeV2InvalidCorrectiveSourceRead,
  rejectRuntimeV2InvalidProviderToolArguments,
  rejectRuntimeV2UnexpectedProviderTool,
  rejectRuntimeV2FailedShellPredecessor,
} from "./executionProviderSurfaceRejection";

export { runtimeV2RepeatedActionFeedback } from "./executionProviderFeedback";
export { runtimeV2ExecutionProviderDeadlineAt };

export function createRuntimeV2ProviderPort(
  input: RuntimeV2ExecutionPortsInput,
): ProviderPort {
  let preparedChatAnswer = input.context.preparedChatAnswer;
  let preparedWorkspaceRead = input.context.preparedWorkspaceRead;
  return {
    async request({ command, signal }) {
      signal.throwIfAborted();
      input.logStoreEvent("runtime_v2_provider_request_timing", {
        turnId: command.run.turnId,
        runId: command.run.runId,
        commandKey: command.idempotencyKey,
        phase: command.phase,
        stage: "provider_entered",
      });
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
      const preparedAnswer = preparedChatAnswer;
      preparedChatAnswer = undefined;
      const allowedToolNames = tools.map((tool) => tool.function.name);
      const requestDeadlineAt = runtimeV2ExecutionProviderDeadlineAt(
        Date.now(),
        input.lifecycleDeadlineAt,
      );
      assertRuntimeV2ProviderRequestDeadline({
        ports: input,
        command,
        requestDeadlineAt,
        transport: null,
      });
      const workspace = String(input.context.runWorkspace || "").trim();
      const preparedRead = preparedWorkspaceRead && command.payload.mode === "analyze" && workspace
        ? normalizePreparedWorkspaceRead(preparedWorkspaceRead, tools, workspace)
        : null;
      preparedWorkspaceRead = undefined;

      if (tools.length === 0) {
        return requestRuntimeV2ProviderWithEmptySurface({
          ports: input,
          command,
          requestDeadlineAt,
          signal,
          preparedChatAnswer: command.payload.mode === "chat" ? preparedAnswer : undefined,
        });
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
      while (
        !Number.isFinite(requestDeadlineAt) ||
        Date.now() < Number(requestDeadlineAt)
      ) {
        const preparedResult = epoch.attempted.length === 0 ? preparedRead : null;
        const attempt = selectNextProviderTransportAttempt(profile, epoch);
        if (!attempt) break;
        epoch = recordProviderTransportAttempt(epoch, attempt);
        const hasFallback =
          selectNextProviderTransportAttempt(profile, epoch) !== null;
        // A fallback is a capability negotiation path after an explicit
        // protocol error, not a retry for a slow or timed-out request.
        // Therefore the current supported transport is never interrupted by a
        // shorter adapter retry timer.
        try {
          const { reasoningActionScope, ...providerResult } = await executeRuntimeV2ProviderWithDeadline<Awaited<ReturnType<typeof requestRuntimeV2ProviderOnce>>>({
            ports: input,
            command,
            requestDeadlineAt,
            transport: attempt.variant,
            signal,
            task: (request) => {
              if (preparedResult) {
                request.signal.throwIfAborted();
                input.logStoreEvent("runtime_v2_prepared_workspace_read_adopted", {
                  turnId: command.run.turnId,
                  runId: command.run.runId,
                  commandKey: command.idempotencyKey,
                  toolNames: preparedResult.toolCalls.map(call => call.name),
                });
                return Promise.resolve(preparedResult);
              }
              input.logStoreEvent("runtime_v2_provider_request_opened", {
                turnId: command.run.turnId,
                runId: command.run.runId,
                commandKey: command.idempotencyKey,
                phase: command.phase,
                transport: attempt.variant,
                allowedToolNames,
                hasFallback,
                timeoutMs: request.timeoutMs ?? null,
                maxOutputTokens: runtimeV2ExecutionProviderOutputTokenLimit(
                  command,
                  attempt.textEnvelope,
                  input.context.runtimeContextBudget,
                  input.live.latestProviderActionWindow,
                ),
              });
              return requestRuntimeV2ProviderOnce({
                live: input.live,
                ports: input,
                command,
                tools,
                textEnvelope: attempt.textEnvelope,
                toolChoice: attempt.toolChoice,
                signal: request.signal,
                timeoutMs: request.timeoutMs,
              });
            },
          });
          signal.throwIfAborted();
          let result = {
            ...providerResult,
            toolCalls: normalizeRuntimeV2ProviderToolCalls(
              providerResult.toolCalls,
              tools,
              input.context.runWorkspace,
            ).map((call) => isReadOnlyContext(input) && call.name === "web_search"
              ? { ...call, arguments: { ...call.arguments, provider: readOnlyNetworkPolicy(input).provider } }
              : call),
          };
          if (result.toolCalls.length > 0 && !preparedResult) {
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
          const surfaceRejection = rejectRuntimeV2UnexpectedProviderTool({
            ports: input,
            command,
            tools,
            result,
          });
          if (surfaceRejection) return surfaceRejection;
          const argumentRejection =
            rejectRuntimeV2InvalidProviderToolArguments({
              ports: input,
              command,
              tools,
              result,
            });
          if (argumentRejection) return argumentRejection;
          const providerEffectFacts =
            deriveRuntimeV2ProviderEffectFacts(
              aggregateForCurrentTurn(input),
            );
          const correctiveSourceRejection =
            rejectRuntimeV2InvalidCorrectiveSourceRead({
              ports: input,
              command,
              result,
              effects: providerEffectFacts,
            });
          if (correctiveSourceRejection) {
            return correctiveSourceRejection;
          }
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
          const schedulingCalls = result.toolCalls.map(call => runtimeV2BoundEditorObservation(input, call.name, call.arguments)
            ? { ...call, boundEditorObservation: true as const } : call);
          result = { ...result, toolCalls: schedulingCalls };
          const completedIdentities = new Set(
            completedRuntimeV2ProviderToolCallIdentities(
              input.live.messages,
              providerEffectFacts,
            ),
          );
          for (const rejected of providerEffectFacts.rejectedActionIdentities) completedIdentities.delete(rejected);
          if (schedulingCalls.some(call => call.name === UNITY_GAME_VIEW_TOOL) &&
              !runtimeV2UnityGameViewMessage(aggregateForCurrentTurn(input), command.run, input.live.unityGameViewCapture)) {
            completedIdentities.delete(runtimeV2ProviderToolCallIdentity({ name: UNITY_GAME_VIEW_TOOL, arguments: {} }));
          }
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
          const skillWindows = runtimeV2TranscriptSkillGuidanceWindows(input.live.messages);
          for (const call of schedulingCalls.filter(call => call.name === "load_skill")) {
            const identity = runtimeV2ProviderToolCallIdentity(call);
            const prior = skillWindows.filter(window => runtimeV2ProviderToolCallIdentity({
              name: window.call.function.name, arguments: JSON.parse(window.call.function.arguments),
            }) === identity);
            const latest = prior[prior.length - 1];
            if (!latest) continue;
            const missing = prior.filter(window => window.documentKey === latest.documentKey && window.version === latest.version).some(window => {
              const coveredEnd = (input.live.latestProviderRequestSkillGuidanceWindows || [])
                .filter(visible => visible.documentKey === window.documentKey && visible.version === window.version)
                .sort((a, b) => a.returnedRange.startChar - b.returnedRange.startChar)
                .reduce((end, visible) => visible.returnedRange.startChar <= end
                  ? Math.max(end, visible.returnedRange.endChar) : end, window.returnedRange.startChar);
              return coveredEnd < window.returnedRange.endChar;
            });
            if (missing) completedIdentities.delete(identity);
          }
          const rejectedIdentities = new Set(
            providerEffectFacts.rejectedActionIdentities,
          );
          const knowledgeReadShare = Math.floor((input.context.runtimeContextBudget?.readWindowChars ?? 12_000) / runtimeV2ParallelReadCount(schedulingCalls));
          for (const call of schedulingCalls) {
            if (runtimeV2ProviderOmittedKnowledgeCanReplay(call, input.live.messages,
              input.context.knowledgeContext?.references || [], knowledgeReadShare)) {
              const identity = runtimeV2ProviderToolCallIdentity(call);
              completedIdentities.delete(identity);
              rejectedIdentities.delete(identity);
            }
          }
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
          const failedPredecessor = rejectRuntimeV2FailedShellPredecessor({ ports: input, command, result, rejectedIdentities });
          if (failedPredecessor) return failedPredecessor;
          const batch = boundRuntimeV2ProviderToolCalls(
            schedulingCalls,
            completedIdentities,
            rejectedIdentities,
            {
              allowMixedObservationShellBatch: true,
              maxSpawnSubagents:
                Number(command.payload.remainingSubagentCapacity) > 0
                  ? schedulingCalls.filter((call) => call.name === "spawn_subagent").length
                  : 0,
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
            const actionReceipts = buildRuntimeV2RepeatedActionReceipts({
              calls: schedulingCalls, aggregate: aggregateForCurrentTurn(input), reason: runtimeRejectedReason,
              workspace: input.context.runWorkspace || "", visibleSourceTargets: input.live.latestProviderRequestSourceCoverage.map(coverage => coverage.target),
              observed: input.live.latestProviderRequestRejectedIdentities, nextId: () => input.nextId("provider-rejected-tool-call"),
            });
            const feedback = actionReceipts.map(receipt => receipt.feedback).join("\n");
            appendRuntimeV2RejectedToolCallBatchHistory(input.live, actionReceipts);
            appendRuntimeV2ProviderFeedbackHistory(input.live, {
              code: "repeated_action_rejected",
              feedback,
            });
            input.live.latestProviderAssistantReasoning = null;
            result = {
              ...result,
              visibleText: "",
              toolCalls: [],
              actionReceipts,
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
            rememberRuntimeV2ProviderResult(input, result, command, tools);
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
          const freshReadCalls = new Set(batch.freshReadCalls);
          const coveredReads = selectedCalls.map((call) => ({
            receipt: freshReadCalls.has(call) ? null : coveredReadReceipts.get(
              runtimeV2ProviderToolCallIdentity(call),
            ) || null,
          }));
          const scopedCalls = scopeRuntimeV2ProviderToolCallIds(
            selectedCalls,
            () => input.nextId("provider-tool-call"),
          );
          if (!signal.aborted && scopedCalls.length > 0 && reasoningActionScope) {
            input.live.actionReasoningScope = reasoningActionScope;
          }
          const parallelReadCount =
            runtimeV2ParallelReadCount(scopedCalls);
          scopedCalls.forEach((call) => {
            input.live.parallelReadCountByToolCallId.set(
              call.id,
              parallelReadCount,
            );
          });
          result = {
            ...result,
            toolCalls: scopedCalls,
            ...(discardedCalls.length ? { actionReceipts: runtimeV2DeferredToolReceipts(discardedCalls, () => input.nextId("provider-deferred-tool-call")) } : {}),
          };
          if (result.actionReceipts?.length) appendRuntimeV2RejectedToolCallBatchHistory(input.live, result.actionReceipts);
          scopedCalls.forEach((call, index) => {
            const covered = coveredReads[index];
            if (!covered?.receipt) return;
            input.live.coveredReadToolResults.set(call.id, covered.receipt);
          });
          rememberRuntimeV2ProviderResult(input, result, command, tools);
          input.logStoreEvent("runtime_v2_provider_result", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            commandKey: command.idempotencyKey,
            transport: attempt.variant,
            toolNames: result.toolCalls.map((call) => call.name),
            visibleChars: input.live.latestVisibleText.length,
          });
          return result;
        } catch (error) {
          if (isRuntimeV2LifecycleDeadlineError(error)) {
            lastError = error;
            break;
          }
          const classified = classifyAndRecordRuntimeV2ProviderAttemptError({
            error,
            signal,
            textEnvelope: attempt.textEnvelope,
            attemptVariant: attempt.variant,
            command,
            live: input.live,
            logStoreEvent: input.logStoreEvent,
          });
          lastError = classified.lastError;
          // Changing the tool-call wire format is capability negotiation,
          // not a generic retry. A timeout, network failure, or semantic
          // rejection says nothing about whether text envelopes are safer.
          if (!classified.protocolFallbackAllowed) {
            break;
          }
        }
      }
      signal.throwIfAborted();
      if (isRuntimeV2LifecycleDeadlineError(lastError)) throw lastError;
      if (isRuntimeV2ProviderProtocolError(lastError)) throw lastError;
      throw runtimeV2ProviderAttemptFailure(lastError);
    },
  };
}
