import type { RuntimeV2RunIdentity, TurnAggregateV1 } from "../../lib/runtime-v2";
import { MAX_RUNTIME_V2_CHECKPOINT_EVENTS, runtimeV2PublicProgressCommentary } from "../../lib/runtime-v2";

/** One record per concluded Plan Run, projected from its existing ledger. */
export function summarizePlanRun(aggregate: TurnAggregateV1, run: RuntimeV2RunIdentity) {
  const events = aggregate.events.filter(event => "run" in event && event.run.runId === run.runId);
  const modelRequests = new Map(events.flatMap(event =>
    event.type === "command.scheduled" && event.command.kind === "request_model"
      ? [[event.command.idempotencyKey, event] as const] : [],
  ));
  const responses = events.filter(event => event.type === "provider.responded");
  const toolRequests = events.flatMap(event =>
    event.type === "command.scheduled" && event.command.kind === "execute_tool"
      ? [event.command.payload.toolName] : [],
  );
  const sumUsage = (field: "inputTokens" | "cachedInputTokens" | "outputTokens") => {
    const values = responses.flatMap(event => {
      const value = event.result.usage?.[field];
      return typeof value === "number" ? [value] : [];
    });
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const terminal = aggregate.terminalOutcome;
  const startedAt = events.find(event => event.type === "run.started")?.at;
  return {
    sessionKey: run.sessionKey, sessionEpoch: run.sessionEpoch, turnId: run.turnId,
    runId: run.runId, attemptId: run.attemptId,
    resultKind: terminal?.resultKind,
    finalProjectionId: terminal?.finalProjectionId,
    elapsedMs: terminal && startedAt !== undefined ? terminal.completedAt - startedAt : null,
    checkpointEventCount: aggregate.events.length,
    checkpointEventLimit: MAX_RUNTIME_V2_CHECKPOINT_EVENTS,
    modelRequestCount: modelRequests.size,
    modelResponseCount: responses.length,
    modelRequestToResponseMs: responses.reduce((sum, event) => {
      const request = modelRequests.get(event.idempotencyKey);
      return sum + (request ? event.at - request.at : 0);
    }, 0),
    responsesWithPublicCommentary: responses.filter(event => runtimeV2PublicProgressCommentary(event.result)).length,
    commentaryProjectionCount: events.filter(event => event.type === "projection.published" &&
      event.audience === "chat_milestone" && event.projection?.dedupeKey.includes(":provider-commentary:")).length,
    providerInputTokens: sumUsage("inputTokens"),
    providerCachedInputTokens: sumUsage("cachedInputTokens"),
    providerOutputTokens: sumUsage("outputTokens"),
    toolDiscoveryCount: toolRequests.filter(name => name === "tool_search").length,
    sourceEvidenceCount: aggregate.evidence.filter(evidence => evidence.kind === "source").length,
    rejectedProviderResponseCount: responses.filter(event => event.result.diagnostics.some(item =>
      item.code === "tool_surface_rejected" || item.code === "tool_arguments_rejected",
    )).length,
    scheduledChildCount: aggregate.subagents.filter(job => job.parentRunId === run.runId).length,
    completedChildCount: events.filter(event => event.type === "subagent.completed").length,
    deliveredChildCount: new Set(events.flatMap(event => event.type === "subagent.handoff_delivered" ? [event.jobId] : [])).size,
    questionPauseCount: events.filter(event => event.type === "run.paused" && event.blocker.questionnaire).length,
  };
}
