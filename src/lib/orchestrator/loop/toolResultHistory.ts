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
  iterationContext: Pick<
    TurnIterationContext,
    | "eventThreadId"
    | "eventTurnId"
    | "turnContext"
    | "startedToolCallIds"
    | "completedToolCallIds"
  >;
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
  // Older replay/unit fixtures can predate lifecycle ownership tracking. They
  // must remain readable without weakening the production Turn-owned sets.
  const startedToolCallIds = iterationContext.startedToolCallIds || new Set<string>();
  const completedToolCallIds = iterationContext.completedToolCallIds || new Set<string>();

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
    const started = startedToolCallIds.has(result.toolCallId);
    if (completedToolCallIds.has(result.toolCallId)) continue;
    // Some pre-execution protocol feedback is synthesized before any visible
    // lifecycle item exists. Keep it in model history without inventing an
    // orphan completion. Once item.started was emitted, however, every policy
    // deferral must close that exact id even though it is not execution
    // evidence and its internal prose must stay out of the user-facing event.
    if (result.internalFeedback && !started) continue;

    startedToolCallIds.delete(result.toolCallId);
    completedToolCallIds.add(result.toolCallId);

    emitTurnEvent({
      type: "item.completed",
      threadId: eventThreadId,
      turnId: eventTurnId,
      timestampMs: Date.now(),
      item: {
        id: result.toolCallId,
        details: result.internalFeedback
          ? {
              type: "tool_lifecycle",
              toolCallId: result.toolCallId,
              tool: result.name,
              target: result.target,
              status: inferLifecycleStateFromToolResult(result),
              reason: result.qualityGateReason || result.lifecycleState || "policy_deferred",
            }
          : {
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
