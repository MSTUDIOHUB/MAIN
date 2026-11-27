import type { AgentMessage } from "../../lib/agentMessages";
import type { beginCapsuleModelActivity } from "../../lib/capsuleLiveActivity";
import { acquireModelLane } from "../../lib/modelLaneCoordinator";
import { RUNTIME_V2_LIFECYCLE_DEADLINE_CODE } from "../../lib/runtime-v2/lifecycle";
import type { OpenAiToolChoice, StreamResult, StreamSettings } from "../../lib/streaming";
import { streamChatCompletion } from "../../lib/streaming";
import type { ToolDefinition } from "../../lib/toolSchemas";
import { withRuntimeV2HardDeadline, withRuntimeV2ProgressDeadline } from "./hardDeadline";
import type { PlanProviderTransport } from "./planModelProtocol";

export interface PlanProviderStreamMetrics {
  readonly streamedText: string;
  readonly dispatchCount: number;
  readonly dispatchedAt: number;
  readonly firstTransportMs: number | null;
  readonly firstPromptProgressMs: number | null;
  readonly firstDecodedMs: number | null;
  readonly streamId?: string;
  readonly promptProgress?: { processedTokens?: number; totalTokens?: number; cachedTokens?: number };
  readonly requestTimedOut: boolean;
  readonly lifecycleTimedOut: boolean;
}

/** Executes one bounded Plan provider stream inside the shared model lane. */
export async function executePlanProviderStream(input: {
  readonly config: any;
  readonly contextLimit?: number;
  readonly requestTokenBudget: number;
  readonly parentRunId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly requestTrace: Record<string, unknown>;
  readonly deadlineAt: number;
  readonly requestTimeoutMs: number;
  readonly requestAbort: AbortController;
  readonly activity: ReturnType<typeof beginCapsuleModelActivity>;
  readonly requestMessages: AgentMessage[];
  readonly requestSettings: StreamSettings;
  readonly offeredTools: ToolDefinition[];
  readonly maxOutputTokens?: number;
  readonly toolChoice?: OpenAiToolChoice;
  readonly responseFormat?: Readonly<Record<string, unknown>>;
  readonly reasoningOnlyTimeoutMs?: number;
  readonly transport: PlanProviderTransport;
  readonly allowPublicText: boolean;
  readonly onPublicText?: (text: string) => void;
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}): Promise<{ readonly result: StreamResult; readonly metrics: PlanProviderStreamMetrics }> {
  let streamedText = "";
  let dispatchCount = 0;
  let dispatchedAt = 0;
  let firstTransportMs: number | null = null;
  let firstPromptProgressMs: number | null = null;
  let firstDecodedMs: number | null = null;
  let streamId: string | undefined;
  let promptProgress: { processedTokens?: number; totalTokens?: number; cachedTokens?: number } | undefined;
  let requestTimedOut = false;
  let lifecycleTimedOut = false;
  const lifecycleTimeoutMs = Math.max(1, input.deadlineAt - Date.now());
  try {
    const result = await withRuntimeV2HardDeadline({
      timeoutMs: lifecycleTimeoutMs,
      timeoutError: RUNTIME_V2_LIFECYCLE_DEADLINE_CODE,
      onTimeout: () => {
        lifecycleTimedOut = true;
        input.requestAbort.abort("runtime_v2_plan_lifecycle_deadline");
      },
      task: async () => {
        input.activity.acquiringLane();
        const lane = await acquireModelLane({
          config: input.config,
          contextLimit: input.contextLimit,
          requestTokenBudget: input.requestTokenBudget,
          agentKind: "parent",
          parentRunId: input.parentRunId,
          signal: input.requestAbort.signal,
          onDebugEvent: (event, data) => input.logStoreEvent(event, {
            ...input.requestTrace,
            ...data,
          }),
        });
        if (input.requestAbort.signal.aborted) {
          lane.release();
          throw new Error(lifecycleTimedOut
            ? "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT"
            : "Aborted");
        }
        lane.setPressureHandler((error) => input.requestAbort.abort(error));
        try {
          input.activity.preparing();
          return await withRuntimeV2ProgressDeadline({
            timeoutMs: input.requestTimeoutMs,
            timeoutError: "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT",
            onTimeout: () => {
              requestTimedOut = true;
              input.requestAbort.abort("runtime_v2_plan_provider_request_timeout");
            },
            task: ({ markProgress }) => streamChatCompletion(
              input.requestMessages,
              input.requestSettings,
              {
                onToken: (token) => {
                  lane.markFirstToken();
                  streamedText += token;
                },
                ...(input.allowPublicText && input.onPublicText
                  ? { onPublicText: input.onPublicText }
                  : {}),
                onDone: () => undefined,
                onError: () => undefined,
                onRequestDispatched: () => {
                  const dispatch = ++dispatchCount;
                  dispatchedAt = Date.now();
                  firstTransportMs = firstPromptProgressMs = firstDecodedMs = null;
                  streamId = undefined;
                  promptProgress = undefined;
                  streamedText = "";
                  const onDecodedOutput = input.activity.requestDispatched();
                  return () => {
                    if (dispatchCount !== dispatch) return;
                    firstDecodedMs ??= Date.now() - dispatchedAt;
                    onDecodedOutput();
                  };
                },
                onLifecycle: (event) => {
                  if (event.streamId) streamId = event.streamId;
                  if (event.phase === "first_chunk") {
                    firstTransportMs = event.elapsedMs ?? (dispatchedAt ? Date.now() - dispatchedAt : null);
                  }
                  if (event.phase === "first_chunk" || event.phase === "chunk_progress") {
                    markProgress();
                  }
                  if (event.phase === "prompt_progress") {
                    firstPromptProgressMs ??= event.elapsedMs ?? (dispatchedAt ? Date.now() - dispatchedAt : null);
                    promptProgress = {
                      processedTokens: event.processedTokens,
                      totalTokens: event.totalTokens,
                      cachedTokens: event.cachedTokens,
                    };
                    input.activity.reportPromptProgress({ ...promptProgress, percent: event.percent });
                    markProgress();
                  }
                  if (event.phase === "model_progress") {
                    firstDecodedMs ??= event.elapsedMs ?? (dispatchedAt ? Date.now() - dispatchedAt : null);
                    lane.markFirstToken();
                  }
                  if (event.phase === "response_format_downgraded") {
                    input.logStoreEvent("runtime_v2_plan_provider_response_format_downgraded", {
                      turnId: input.turnId,
                      runId: input.runId,
                      requestId: input.requestId,
                      transport: input.transport,
                      reason: event.status,
                    });
                  }
                },
              },
              input.requestAbort.signal,
              input.offeredTools,
              input.maxOutputTokens,
              {
                ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
                responseFormat: input.responseFormat,
                timeoutMs: input.requestTimeoutMs,
                contextOwnership: "caller",
                reasoningOnlyTimeoutMs: input.reasoningOnlyTimeoutMs,
              },
            ),
          });
        } catch (error) {
          lane.reportFailure(error);
          throw error;
        } finally {
          lane.setPressureHandler(undefined);
          lane.release();
        }
      },
    });
    return {
      result,
      metrics: {
        streamedText,
        dispatchCount,
        dispatchedAt,
        firstTransportMs,
        firstPromptProgressMs,
        firstDecodedMs,
        streamId,
        promptProgress,
        requestTimedOut,
        lifecycleTimedOut,
      },
    };
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error || "")),
      {
        planStreamMetrics: {
          streamedText,
          dispatchCount,
          dispatchedAt,
          firstTransportMs,
          firstPromptProgressMs,
          firstDecodedMs,
          streamId,
          promptProgress,
          requestTimedOut,
          lifecycleTimedOut,
        } satisfies PlanProviderStreamMetrics,
      },
    );
  }
}
