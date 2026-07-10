import {
  buildToolResultHistoryContentByFormat,
  createHookContextMessages,
  inferLifecycleStateFromToolResult,
} from "../../orchestrator";
import { buildRepeatLoopArgsKey } from "../../repetitionGuard";
import type { MainThreadEventInput, MainThreadItem, ToolFeedbackFormat } from "../../turnEvents";
import type { AgentMessage, OrchestratorCallbacks, ToolExecutionResult } from "../types";
import type { TurnIterationContext } from "./turnIterationContext";

export function appendToolResultsToHistory(input: {
  callbacks: OrchestratorCallbacks;
  toolFeedbackFormat: ToolFeedbackFormat;
  results: ToolExecutionResult[];
  toolArgsByCallId: Map<string, Record<string, unknown>>;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId" | "turnContext">;
  emitTurnEvent: (event: MainThreadEventInput) => void;
}) {
  const {
    callbacks,
    toolFeedbackFormat,
    results,
    toolArgsByCallId,
    iterationContext,
    emitTurnEvent,
  } = input;
  const { eventThreadId, eventTurnId, turnContext } = iterationContext;

  for (const result of results) {
    try {
      const resultChars = typeof result.content === "string" ? result.content.length : 0;
      turnContext.registerToolExecution({
        toolCallId: result.toolCallId,
        toolName: result.name,
        argumentsHash: buildRepeatLoopArgsKey(toolArgsByCallId.get(result.toolCallId) ?? {}),
        resultLength: resultChars,
        resultTruncated: resultChars > 2000,
      });
      turnContext.addItem({
        category: "tool",
        burned: false,
        scope: "ephemeral",
        purpose: `${result.name} tool result`,
        source: { toolName: result.name },
      });
    } catch {
      // TurnContext registration is best-effort.
    }

    const toolHistoryContent = buildToolResultHistoryContentByFormat(result, toolFeedbackFormat);
    callbacks.appendMessage({
      role: "tool",
      content: toolHistoryContent,
      tool_call_id: result.toolCallId,
    });
    if (result.internalFeedback) continue;

    emitTurnEvent({
      type: "item.completed",
      threadId: eventThreadId,
      turnId: eventTurnId,
      timestampMs: Date.now(),
      item: {
        id: result.toolCallId,
        details: {
          type: "tool_result",
          toolCallId: result.toolCallId,
          tool: result.name,
          target: result.target,
          status: inferLifecycleStateFromToolResult(result),
          text: result.displayContent || result.content,
        },
      } as MainThreadItem,
    });
    if (result.additionalContexts?.length) {
      createHookContextMessages("PostToolUse", result.additionalContexts)
        .forEach((message: AgentMessage) => callbacks.appendMessage(message));
    }
  }
}
