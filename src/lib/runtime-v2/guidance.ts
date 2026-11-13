import type { AgentMessage } from "../agentMessages";
import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2RunIdentity } from "./contracts";
import type { RuntimeV2Event } from "./events";

type GuidanceEvent = Extract<RuntimeV2Event, { type: "guidance.admitted" }>;

export class RuntimeV2GuidancePendingError extends Error {
  constructor() {
    super("New user guidance won the normal finalization boundary.");
  }
}

export function isRuntimeV2GuidanceForRun(event: GuidanceEvent, run: RuntimeV2RunIdentity): boolean {
  return event.run.sessionKey === run.sessionKey && event.run.sessionEpoch === run.sessionEpoch &&
    event.run.turnId === run.turnId && event.run.runId === run.runId &&
    event.run.parentRunId === run.parentRunId && event.run.attemptId === run.attemptId;
}

/** The first later model command owns delivery. Retries reuse that command's
 * ordering, while later decisions retain the same user input in their history. */
export function runtimeV2GuidanceForModelRequest(
  aggregate: TurnAggregateV1 | null | undefined,
  run: RuntimeV2RunIdentity,
  commandKey: string,
): GuidanceEvent[] {
  const events = aggregate?.events || [];
  const command = events.find(event => event.type === "command.scheduled" &&
    event.command.kind === "request_model" && event.command.idempotencyKey === commandKey);
  return command ? events.filter((event): event is GuidanceEvent =>
    event.type === "guidance.admitted" && event.sequence < command.sequence &&
    isRuntimeV2GuidanceForRun(event, run)) : [];
}

export function runtimeV2PendingGuidance(aggregate: TurnAggregateV1 | null | undefined): GuidanceEvent | undefined {
  if (!aggregate?.run) return undefined;
  const run = aggregate.run.identity;
  for (let index = aggregate.events.length - 1; index >= 0; index--) {
    const event = aggregate.events[index]!;
    if (event.type === "command.scheduled" && event.command.kind === "request_model" &&
      event.run.runId === run.runId && event.run.attemptId === run.attemptId) return undefined;
    if (event.type === "guidance.admitted" && isRuntimeV2GuidanceForRun(event, run)) return event;
  }
}

export function runtimeV2GuidanceDelivery(
  aggregate: TurnAggregateV1 | null | undefined,
  guidanceId: string,
): "waiting" | "applied" | "unapplied" | null {
  const events = aggregate?.events || [];
  const guidance = events.find((event): event is GuidanceEvent =>
    event.type === "guidance.admitted" && event.eventId === guidanceId);
  if (!guidance) return null;
  const modelCommands = new Set(events.flatMap(event => event.type === "command.scheduled" &&
    event.command.kind === "request_model" && event.sequence > guidance.sequence &&
    isRuntimeV2GuidanceForRun(guidance, event.run) ? [event.command.idempotencyKey] : []));
  if (events.some(event => event.type === "provider.responded" && modelCommands.has(event.idempotencyKey))) return "applied";
  const activeRun = aggregate?.run;
  return aggregate?.terminalOutcome || activeRun?.status === "reviewing" ||
    (activeRun && !isRuntimeV2GuidanceForRun(guidance, activeRun.identity)) ? "unapplied" : "waiting";
}

export function appendRuntimeV2GuidanceHistory(
  messages: AgentMessage[],
  aggregate: TurnAggregateV1 | null | undefined,
  run: RuntimeV2RunIdentity,
  commandKey: string,
): void {
  for (const item of runtimeV2GuidanceForModelRequest(aggregate, run, commandKey)) {
    if (messages.some(message => message.runtimeGuidanceId === item.eventId)) continue;
    messages.push({ role: "user", content: item.text, runtimeGuidanceId: item.eventId });
  }
}
