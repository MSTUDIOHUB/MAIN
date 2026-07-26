import {
  buildToolResultHistoryContentByFormat,
  createHookContextMessages,
  inferLifecycleStateFromToolResult,
} from "../../orchestrator";
import { buildRepeatLoopArgsKey } from "../../repetitionGuard";
import type { MainThreadEventInput, MainThreadItem, ToolFeedbackFormat } from "../../turnEvents";
import type { AgentMessage, OrchestratorCallbacks, ToolExecutionResult } from "../types";
import { getToolExecutionArgs } from "../../toolResultEffect";
import type { TurnIterationContext } from "./turnIterationContext";

/**
 * Commit one executor result batch to protocol history and lifecycle events.
 *
 * The Turn-owned completed set is the commit boundary: a result is claimed
 * before any history, hook, context, or event side effect is emitted. Recovery
 * policy may inspect a committed batch, but it must never commit it again.
 */
export function commitToolResultBatch(input: {
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
    if (completedToolCallIds.has(result.toolCallId)) continue;
    completedToolCallIds.add(result.toolCallId);

    try {
      const resultChars = typeof result.content === "string" ? result.content.length : 0;
      turnContext.registerToolExecution({
        toolCallId: result.toolCallId,
        toolName: result.name,
        argumentsHash: buildRepeatLoopArgsKey(getToolExecutionArgs(
          result,
          toolArgsByCallId.get(result.toolCallId) ?? {},
        )),
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
    // Hidden protocol feedback remains 0-start/0-complete. A user-visible
    // external preflight result, however, still owns a real lifecycle item;
    // synthesize its start immediately before completion so the event stream
    // can never contain an orphan completion.
    if (!started) {
      if (result.internalFeedback) continue;
      emitTurnEvent({
        type: "item.started",
        threadId: eventThreadId,
        turnId: eventTurnId,
        timestampMs: Date.now(),
        item: {
          id: result.toolCallId,
          details: {
            type: "tool_lifecycle",
            toolCallId: result.toolCallId,
            tool: result.name,
            target: result.target,
            status: inferLifecycleStateFromToolResult(result),
          },
        } as MainThreadItem,
      });
      startedToolCallIds.add(result.toolCallId);
    }

    startedToolCallIds.delete(result.toolCallId);

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
