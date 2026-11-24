import type { beginCapsuleModelActivity } from "../../lib/capsuleLiveActivity";
import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import type { RuntimeV2Command } from "../../lib/runtime-v2";
import {
  streamChatCompletion,
  type OpenAiToolChoice,
  type StreamResult,
  type StreamSettings,
} from "../../lib/streaming";
import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  appendRuntimeV2ProviderFeedbackHistory,
  materializedRuntimeV2SourceCoverage,
  type RuntimeV2ExecutionPortsInput,
  type RuntimeV2LiveExecutionState,
} from "./executionContext";
import {
  buildRuntimeV2LanguageRetryFeedback,
  evaluateRuntimeV2LanguageRetry,
  runtimeV2ProviderOutputWasTruncated,
} from "./executionProviderRequestPolicy";
import { runtimeV2TranscriptSkillGuidanceWindows } from "./executionProviderSkillTranscript";
import { boundReadOnlyHistory } from "./readOnlyHistory";

export function createRuntimeV2WireCallbacks(input: {
  lane: { markFirstToken: () => void };
  activity: ReturnType<typeof beginCapsuleModelActivity>;
  logRequestTiming: (stage: string, data?: Record<string, unknown>) => void;
  appendStreamedText: (token: string) => void;
}) {
  return (
    attempt: "initial" | "reasoning_retry" | "language_retry",
  ): Parameters<typeof streamChatCompletion>[2] => {
    let dispatchAt = 0;
    let dispatchCount = 0;
    let modelProgressSeen = false;
    const onModelProgress = () => {
      input.lane.markFirstToken();
      if (modelProgressSeen) return;
      modelProgressSeen = true;
      input.logRequestTiming("first_model_progress", {
        attempt,
        dispatchCount,
        elapsedMs: dispatchAt ? Date.now() - dispatchAt : null,
      });
    };
    return {
      onToken: (token) => {
        onModelProgress();
        input.appendStreamedText(token);
      },
      onDone: () => undefined,
      onError: () => undefined,
      onRequestDispatched() {
        dispatchAt = Date.now();
        dispatchCount += 1;
        modelProgressSeen = false;
        input.logRequestTiming("dispatched", { attempt, dispatchCount });
        return input.activity.requestDispatched();
      },
      onLifecycle(event) {
        if (event.phase === "model_progress") onModelProgress();
        if (event.phase === "first_chunk") {
          input.logRequestTiming("first_chunk", {
            attempt,
            dispatchCount,
            streamId: event.streamId,
            elapsedMs: event.elapsedMs,
          });
        }
      },
    };
  };
}

export function createRuntimeV2RetryMessageRebuilder(input: {
  live: RuntimeV2LiveExecutionState;
  ports: RuntimeV2ExecutionPortsInput;
  initialMessages: any[];
  canonicalDecisionConversation: any[];
  initialLiveMessageCount: number;
  readOnly: boolean;
  budget: RuntimeContextBudget | null | undefined;
  maxOutputTokens: number;
  providerTools: ToolDefinition[];
  providerEffectFacts: ReturnType<typeof import("./executionContext").deriveRuntimeV2ProviderEffectFacts>;
  assembleExecuteRequest: (conversation: any[]) => { messages: any[]; coverage: any } | null;
}) {
  let currentRequestMessages = input.initialMessages;
  return (retryHistoryStart: number) => {
    const unboundedRecoveryMessages = [
      ...currentRequestMessages,
      ...input.live.messages.slice(retryHistoryStart),
    ];
    const recoveredExecuteRequest = input.readOnly
      ? null
      : input.assembleExecuteRequest([
          ...input.canonicalDecisionConversation,
          ...input.live.messages.slice(input.initialLiveMessageCount),
        ]);
    const recoveryMessages =
      recoveredExecuteRequest?.messages ||
      (input.budget
        ? boundReadOnlyHistory(unboundedRecoveryMessages, {
            contextLimit: input.budget.contextLimit,
            reservedOutputTokens: input.maxOutputTokens,
            tools: input.providerTools,
            preserveUserMessages: unboundedRecoveryMessages.some(
              (message) => "runtimeGuidanceId" in message && !!message.runtimeGuidanceId,
            ),
          })
        : unboundedRecoveryMessages);
    currentRequestMessages = recoveryMessages;
    input.live.latestProviderRequestSourceCoverage =
      recoveredExecuteRequest?.coverage ||
      materializedRuntimeV2SourceCoverage(
        recoveryMessages,
        input.ports.context.runWorkspace || "",
        input.providerEffectFacts,
      );
    input.live.latestProviderRequestSkillGuidanceWindows =
      runtimeV2TranscriptSkillGuidanceWindows(recoveryMessages).map(
        ({ documentKey, version, returnedRange, readTarget }) => ({
          documentKey,
          version,
          returnedRange,
          readTarget,
        }),
      );
    return recoveryMessages;
  };
}

export async function retryRuntimeV2ProviderLanguageMismatch(input: {
  live: RuntimeV2LiveExecutionState;
  ports: RuntimeV2ExecutionPortsInput;
  command: RuntimeV2Command;
  requestMode: string;
  result: StreamResult;
  streamedText: string;
  resetStreamedText: () => void;
  providerTools: ToolDefinition[];
  requestSettings: StreamSettings;
  textEnvelope: boolean;
  effectiveToolChoice: OpenAiToolChoice | null;
  maxOutputTokens: number;
  timeoutMs?: number;
  signal: AbortSignal;
  reasoningOnlyCharLimit: number | null;
  actionOnlyCharLimit?: number;
  activity: ReturnType<typeof beginCapsuleModelActivity>;
  rebuildRetryMessages: (retryHistoryStart: number) => any[];
  wireCallbacks: (
    attempt: "initial" | "reasoning_retry" | "language_retry",
  ) => Parameters<typeof streamChatCompletion>[2];
}): Promise<StreamResult> {
  const languageRetryCheck = evaluateRuntimeV2LanguageRetry({
    text: input.result.semanticContent || input.streamedText,
    targetLanguage: input.ports.context.phaseLanguage,
    aborted: input.signal.aborted,
    toolCallCount: input.result.toolCalls.length,
    hasProtocolViolation: !!input.result.protocolViolation,
    outputTruncated: runtimeV2ProviderOutputWasTruncated({
      finishReason: input.result.finishReason,
      clientStopReason: input.result.clientStopReason,
      toolCallCount: input.result.toolCalls.length,
      availableToolCount: input.providerTools.length,
    }),
  });
  if (!languageRetryCheck.shouldRetry) {
    return input.result;
  }
  input.activity.preparing();
  const targetLanguage = input.ports.context.phaseLanguage;
  input.ports.logStoreEvent("runtime_v2_provider_language_retry", {
    turnId: input.command.run.turnId,
    runId: input.command.run.runId,
    commandKey: input.command.idempotencyKey,
    phase: input.command.phase,
    mode: input.requestMode,
    targetLanguage,
    detectedLanguage: languageRetryCheck.detectedLanguage,
    hanCount: languageRetryCheck.hanCount,
    latinWords: languageRetryCheck.latinWords,
  });
  const mismatchedVisibleText = (
    input.result.semanticContent || input.streamedText
  ).trim();
  input.resetStreamedText();
  const languageRetryHistoryStart = input.live.messages.length;
  appendRuntimeV2ProviderFeedbackHistory(input.live, {
    visibleText: mismatchedVisibleText,
    code: "language_mismatch",
    feedback: buildRuntimeV2LanguageRetryFeedback(targetLanguage),
  });
  const languageRetryMessages = input.rebuildRetryMessages(languageRetryHistoryStart);
  return streamChatCompletion(
    languageRetryMessages,
    input.requestSettings,
    input.wireCallbacks("language_retry"),
    input.signal,
    input.textEnvelope ? [] : input.providerTools,
    input.maxOutputTokens,
    {
      ...(input.effectiveToolChoice ? { toolChoice: input.effectiveToolChoice } : {}),
      timeoutMs: input.timeoutMs,
      contextOwnership: "caller",
      reasoningOnlyCharLimit: input.reasoningOnlyCharLimit,
      actionOnlyCharLimit: input.actionOnlyCharLimit,
    },
  );
}
