import { summarizeThought, thoughtSummaryToString } from "../../chat/StreamingThoughtSummarizer";
import { ensureVisibleConclusionWithPolicy, normalizeAssistantTurn } from "../../normalizedTurn";
import { logAgentEvent } from "../../orchestrator";
import {
  extractExplicitPlanProtocolFromReasoning,
  hasExplicitPlanProposal,
} from "../../planProposal";
import type { ResolvedUserIntent } from "../../runIntent";
import type { StreamResult } from "../../streaming";
import type { NormalizedStreamState } from "../../workflowModels";

type WorkflowMode = "chat" | "edit" | "plan";

export type ProviderReasoningForHistory =
  | Pick<StreamResult, "reasoningContent" | "reasoningField">
  | null;

type ResponseTurnContext = {
  setSummary: (summary: string) => void;
  accumulateReasoning: (chars: number) => void;
};

export type AssistantResponseProcessingResult = {
  streamText: string;
  providerReasoningForHistory: ProviderReasoningForHistory;
  normalizedBase: NormalizedStreamState;
  normalized: NormalizedStreamState;
};

export function processAssistantStreamResponse(input: {
  streamResult: StreamResult;
  iteration: number;
  iterationRequestStartedAt: number;
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  activeProfile: string;
  provider: string | undefined;
  model: string | undefined;
  contextLimit: number | undefined;
  effectiveToolProtocol: string;
  forceXmlTools: boolean;
  reasoningDisplay: string;
  maxHiddenChars?: number;
  llmToolCount: number;
  managedMessageCount: number;
  currentMaxTokens: number | undefined;
  turnContext: ResponseTurnContext;
  onDebugEvent?: (event: string, data: Record<string, unknown>) => void;
}): AssistantResponseProcessingResult {
  const {
    streamResult,
    iteration,
    iterationRequestStartedAt,
    workflowMode,
    turnIntent,
    runtimeIntent,
    activeProfile,
    provider,
    model,
    contextLimit,
    effectiveToolProtocol,
    forceXmlTools,
    reasoningDisplay,
    maxHiddenChars,
    llmToolCount,
    managedMessageCount,
    currentMaxTokens,
    turnContext,
  } = input;

  const providerVisibleText = streamResult.content;
  const providerReasoningForHistory =
    typeof streamResult.reasoningContent === "string" && streamResult.reasoningContent.trim()
      ? {
          reasoningContent: streamResult.reasoningContent,
          reasoningField: streamResult.reasoningField,
        }
      : null;
  const recoveredReasoningPlan =
    workflowMode === "plan" &&
    !hasExplicitPlanProposal(providerVisibleText) &&
    providerReasoningForHistory
      ? extractExplicitPlanProtocolFromReasoning(
          providerReasoningForHistory.reasoningContent,
        )
      : null;
  // This channel is consumed by Plan protocol parsing/materialization only.
  // Normalization still receives the original provider response below, so no
  // hidden prose becomes user-visible.
  const streamText = recoveredReasoningPlan || providerVisibleText;
  const contentShort = providerVisibleText.length < 10;
  const toolCallsFew = streamResult.toolCalls.length < 2;
  const emitDebug = (event: string, data: Record<string, unknown>) => {
    if (input.onDebugEvent) input.onDebugEvent(`agent.${event}`, data);
    else logAgentEvent(event, data);
  };

  if (recoveredReasoningPlan) {
    emitDebug("plan_protocol_recovered_from_reasoning", {
      iteration,
      protocolChars: recoveredReasoningPlan.length,
      providerVisibleChars: providerVisibleText.length,
      reasoningChars: providerReasoningForHistory?.reasoningContent.length ?? 0,
      surroundingReasoningExposed: false,
    });
  }

  emitDebug("stream_done", {
    iteration,
    metricScope: "iteration",
    finishReason: streamResult.finishReason || "unknown",
    contentChars: providerVisibleText.length,
    providerReasoningChars: providerReasoningForHistory?.reasoningContent.length ?? 0,
    actionableChars: streamResult.actionableContent?.length ?? providerVisibleText.length,
    semanticVisibleChars: streamResult.streamDiagnostics?.semanticVisibleChars ?? streamResult.semanticContent?.length ?? providerVisibleText.length,
    mirrorKind: streamResult.streamDiagnostics?.mirrorKind ?? "none",
    overlapRatio: streamResult.streamDiagnostics?.overlapRatio ?? 0,
    contentHash: streamResult.streamDiagnostics?.contentHash ?? null,
    reasoningHash: streamResult.streamDiagnostics?.reasoningHash ?? null,
    normalizedContentHash: streamResult.streamDiagnostics?.normalizedContentHash ?? null,
    normalizedReasoningHash: streamResult.streamDiagnostics?.normalizedReasoningHash ?? null,
    firstSemanticVisibleElapsedMs: streamResult.streamDiagnostics?.firstSemanticVisibleElapsedMs ?? null,
    firstToolElapsedMs: streamResult.streamDiagnostics?.firstToolElapsedMs ?? null,
    toolCalls: streamResult.toolCalls.length,
    nativeToolCalls: streamResult.toolCalls.length,
    elapsedMs: Date.now() - iterationRequestStartedAt,
    emptyResult: providerVisibleText.length === 0 && streamResult.toolCalls.length === 0,
    semanticEmptyResult:
      (streamResult.semanticContent?.trim().length ?? providerVisibleText.trim().length) === 0 &&
      streamResult.toolCalls.length === 0,
    actionableEmptyResult:
      (streamResult.actionableContent?.trim().length ?? providerVisibleText.trim().length) === 0 &&
      streamResult.toolCalls.length === 0,
  });

  if (contentShort && toolCallsFew) {
    emitDebug("stream_low_content_diagnostic", {
      iteration,
      contentChars: providerVisibleText.length,
      contentPreview: providerVisibleText.slice(0, 200),
      toolCallCount: streamResult.toolCalls.length,
      toolCallNames: streamResult.toolCalls.map((tc) => tc.name).slice(0, 8),
      finishReason: streamResult.finishReason || "unknown",
      elapsedMs: Date.now() - iterationRequestStartedAt,
      provider: provider || "unknown",
      model,
      reasoningChars: providerReasoningForHistory?.reasoningContent.length ?? 0,
      messageCount: managedMessageCount,
      activeProfile,
    });
  }

  if (providerReasoningForHistory) {
    emitDebug("reasoning_suppressed", {
      iteration,
      chars: providerReasoningForHistory.reasoningContent.length,
      field: providerReasoningForHistory.reasoningField || "reasoning_content",
      replayInContext: false,
      display: reasoningDisplay,
    });
  }

  if (providerReasoningForHistory && providerReasoningForHistory.reasoningContent.length > 200) {
    const thoughtSummary = summarizeThought(providerReasoningForHistory.reasoningContent);
    const summaryText = thoughtSummaryToString(thoughtSummary);
    try { turnContext.setSummary(summaryText); } catch {}
    try { turnContext.accumulateReasoning(providerReasoningForHistory.reasoningContent.length); } catch {}
  }

  if (providerVisibleText.length === 0 && streamResult.toolCalls.length === 0 && !recoveredReasoningPlan) {
    emitDebug("llm_empty_response_diagnostic", {
      iteration,
      elapsedMs: Date.now() - iterationRequestStartedAt,
      workflowMode,
      turnIntent,
      runtimeIntent,
      activeProfile,
      provider: provider || "unknown",
      model,
      toolProtocol: effectiveToolProtocol,
      nativeToolsEnabled: llmToolCount > 0,
      llmToolCount,
      messageCount: managedMessageCount,
      contextLimit,
      currentMaxTokens: currentMaxTokens ?? "default",
      likelyCauses: [
        activeProfile === "local" ? "local_prefill_or_provider_empty_completion" : "gateway_or_provider_empty_completion",
        forceXmlTools ? "text_xml_tool_protocol_no_native_tool_call" : "native_tool_protocol",
        managedMessageCount > 12 ? "long_multi_turn_context" : "short_context",
      ],
    });
  }

  const normalizedBase = normalizeAssistantTurn(streamResult, { maxHiddenChars });
  const normalized = ensureVisibleConclusionWithPolicy(
    normalizedBase,
    true,
  );

  return {
    streamText,
    providerReasoningForHistory,
    normalizedBase,
    normalized,
  };
}
