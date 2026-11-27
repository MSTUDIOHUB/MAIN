import type { beginCapsuleModelActivity } from "../../lib/capsuleLiveActivity";
import { compactDebugString } from "../../lib/debugLog";
import { buildCommentaryLanguageAnchor, shouldPublishPublicCommentary } from "../../lib/languageContract";
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
  aggregateForCurrentTurn,
  appendRuntimeV2ProviderFeedbackHistory,
  materializedRuntimeV2SourceCoverage,
  upsertRuntimeV2ContextAnchor,
  type RuntimeV2ExecutionPortsInput,
  type RuntimeV2LiveExecutionState,
} from "./executionContext";
import {
  buildRuntimeV2LanguageRetryFeedback,
  canRuntimeV2RequestConcludeWithProse,
  evaluateRuntimeV2LanguageRetry,
  runtimeV2ProviderOutputWasTruncated,
} from "./executionProviderRequestPolicy";
import { runtimeV2TranscriptSkillGuidanceWindows } from "./executionProviderSkillTranscript";
import { boundReadOnlyHistory } from "./readOnlyHistory";
import type { VisualTransportRequestBinding } from "../../lib/visualContext";

export function createRuntimeV2WireCallbacks(input: {
  lane: { markFirstToken: () => void };
  activity: ReturnType<typeof beginCapsuleModelActivity>;
  logRequestTiming: (stage: string, data?: Record<string, unknown>) => void;
  appendStreamedText: (token: string) => void;
  allowPublicText?: boolean;
  phaseLanguage?: "zh" | "en";
}) {
  return (
    attempt: "initial" | "reasoning_retry" | "language_retry",
  ): Parameters<typeof streamChatCompletion>[2] => {
    let dispatchAt = 0;
    let dispatchCount = 0;
    let modelProgressSeen = false;
    let publicTextSeen = false;
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
      ...(input.allowPublicText
        ? {
            onPublicText: (text: string) => {
              if (!input.phaseLanguage || shouldPublishPublicCommentary(text, input.phaseLanguage).allow) {
                input.activity.reportPublicCommentary(text);
                if (!publicTextSeen && text.trim()) {
                  publicTextSeen = true;
                  input.logRequestTiming("first_public_text", {
                    attempt,
                    dispatchCount,
                    elapsedMs: dispatchAt ? Date.now() - dispatchAt : null,
                  });
                }
              }
            },
          }
        : {}),
      onDone: () => undefined,
      onError: () => undefined,
      onRequestDispatched() {
        dispatchAt = Date.now();
        dispatchCount += 1;
        modelProgressSeen = false;
        publicTextSeen = false;
        input.logRequestTiming("dispatched", { attempt, dispatchCount });
        return input.activity.requestDispatched();
      },
      onLifecycle(event) {
        if (event.phase === "prompt_progress") {
          input.activity.reportPromptProgress({
            processedTokens: event.processedTokens,
            totalTokens: event.totalTokens,
            cachedTokens: event.cachedTokens,
            percent: event.percent,
          });
        }
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
  visualTransportBinding?: VisualTransportRequestBinding;
  wireCallbacks: (
    attempt: "initial" | "reasoning_retry" | "language_retry",
  ) => Parameters<typeof streamChatCompletion>[2];
}): Promise<StreamResult> {
  const proseConclusionAllowed = canRuntimeV2RequestConcludeWithProse({
    aggregate: aggregateForCurrentTurn(input.ports),
    requestMode: input.requestMode,
    readOnly: input.command.payload.readOnly === true,
  });
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
    proseConclusionAllowed,
  });
  if (!languageRetryCheck.shouldRetry) {
    return input.result;
  }
  input.activity.preparing();
  const targetLanguage = input.ports.context.phaseLanguage;
  const mismatchedVisibleText = (
    input.result.semanticContent || input.streamedText
  ).trim();
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
    samplePreview: compactDebugString(mismatchedVisibleText, 160),
  });
  input.resetStreamedText();
  const languageRetryHistoryStart = input.live.messages.length;
  appendRuntimeV2ProviderFeedbackHistory(input.live, {
    visibleText: mismatchedVisibleText,
    code: "language_mismatch",
    feedback: buildRuntimeV2LanguageRetryFeedback(targetLanguage, {
      hasToolsAvailable: !input.textEnvelope && input.providerTools.length > 0,
    }),
  });
  const languageRetryMessages = input.rebuildRetryMessages(languageRetryHistoryStart);
  try {
    return await streamChatCompletion(
      languageRetryMessages,
      input.requestSettings,
      input.wireCallbacks("language_retry"),
      input.signal,
      input.textEnvelope ? [] : input.providerTools,
      input.maxOutputTokens,
      {
        ...(input.effectiveToolChoice ? { toolChoice: input.effectiveToolChoice } : {}),
        ...(input.visualTransportBinding ? { visualTransportBinding: input.visualTransportBinding } : {}),
        timeoutMs: input.timeoutMs,
        contextOwnership: "caller",
        reasoningOnlyCharLimit: input.reasoningOnlyCharLimit,
        actionOnlyCharLimit: input.actionOnlyCharLimit,
      },
    );
  } finally {
    input.live.messages.splice(languageRetryHistoryStart);
  }
}

export function suppressMismatchedToolCommentary(input: {
  readonly visibleText: string;
  readonly toolCallCount: number;
  readonly targetLanguage: "zh" | "en";
  readonly live: RuntimeV2LiveExecutionState;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly mode: string;
}): string {
  if (input.toolCallCount === 0 || !input.visibleText.trim()) {
    return input.visibleText;
  }
  const check = shouldPublishPublicCommentary(
    input.visibleText,
    input.targetLanguage,
  );
  if (check.allow || check.reason !== "language_mismatch") {
    return input.visibleText;
  }
  input.ports.logStoreEvent("runtime_v2_commentary_language_suppressed", {
    turnId: input.command.run.turnId,
    runId: input.command.run.runId,
    commandKey: input.command.idempotencyKey,
    phase: input.command.phase,
    mode: input.mode,
    targetLanguage: input.targetLanguage,
    detectedLanguage: check.detectedLanguage,
    hanCount: check.hanCount,
    latinWords: check.latinWords,
    toolCount: input.toolCallCount,
  });
  upsertRuntimeV2ContextAnchor(input.live, {
    key: "language-contract",
    content: buildCommentaryLanguageAnchor(input.targetLanguage),
  });
  return input.visibleText;
}
