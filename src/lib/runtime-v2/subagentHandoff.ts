import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Event } from "./events";
import type {
  RuntimeV2RunIdentity,
  RuntimeV2SubagentHandoffApplicationSource,
} from "./contracts";

type HandoffDeliveredEvent = Extract<
  RuntimeV2Event,
  { type: "subagent.handoff_delivered" }
>;
type HandoffAppliedEvent = Extract<
  RuntimeV2Event,
  { type: "subagent.handoff_applied" }
>;

function boundedEvidenceIds(
  values: readonly string[],
): readonly string[] {
  return [...new Set(values
    .map((value) => String(value || "").trim().slice(0, 512))
    .filter(Boolean))]
    .slice(0, 64);
}

function normalizedEvidenceIds(
  evidenceIds: readonly string[],
): readonly string[] | null {
  if (!Array.isArray(evidenceIds) || evidenceIds.length > 64) return null;
  const normalized = evidenceIds.map((id) =>
    typeof id === "string" ? id.trim() : ""
  );
  if (
    normalized.some((id) => !id || id.length > 512) ||
    new Set(normalized).size !== normalized.length
  ) {
    return null;
  }
  return normalized;
}

function sameEvidenceIdSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((id) => right.includes(id));
}

function sameRun(
  left: RuntimeV2RunIdentity,
  right: RuntimeV2RunIdentity,
): boolean {
  return left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.parentRunId === right.parentRunId &&
    left.attemptId === right.attemptId;
}

function scalarStrings(
  value: unknown,
  depth = 0,
): readonly string[] {
  if (depth > 8 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => scalarStrings(entry, depth + 1));
  }
  if (typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>)
    .flatMap((entry) => scalarStrings(entry, depth + 1));
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function explicitlyReferencesEvidenceId(
  values: readonly string[],
  evidenceId: string,
): boolean {
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_.:/-])${escapedPattern(evidenceId)}(?=$|[^A-Za-z0-9_.:/-])`,
  );
  return values.some((value) =>
    value === evidenceId || pattern.test(value)
  );
}

export function runtimeV2SubagentHandoffApplicationSource(
  event: RuntimeV2Event,
): RuntimeV2SubagentHandoffApplicationSource | null {
  if (event.type === "provider.responded") return "provider_result";
  if (event.type === "command.scheduled") {
    return event.command.kind === "finalize_turn" ? "final" : "command";
  }
  if (
    event.type === "projection.published" &&
    event.audience === "final"
  ) {
    return "final";
  }
  return null;
}

function referenceValues(event: RuntimeV2Event): readonly string[] {
  if (event.type === "provider.responded") {
    return [
      ...scalarStrings(event.result.visibleText),
      ...scalarStrings(event.result.commentary),
      ...event.result.toolCalls.flatMap((call) =>
        scalarStrings(call.arguments)
      ),
    ];
  }
  if (event.type === "command.scheduled") {
    if (event.command.kind === "request_model") return [];
    if (event.command.kind === "finalize_turn") {
      return scalarStrings({
        finalMarkdown: event.command.payload.finalMarkdown,
        resultReason: event.command.payload.resultReason,
      });
    }
    return scalarStrings(event.command.payload.arguments);
  }
  if (
    event.type === "projection.published" &&
    event.audience === "final"
  ) {
    return [event.projection.markdown];
  }
  return [];
}

/**
 * A child fact is adopted only when a later durable parent event names its
 * exact evidence id. Runtime-injected request metadata and broad prose
 * similarity are intentionally excluded.
 */
export function referencedRuntimeV2SubagentEvidenceIds(input: {
  readonly sourceEvent: RuntimeV2Event;
  readonly evidenceIds: readonly string[];
}): readonly string[] {
  if (!runtimeV2SubagentHandoffApplicationSource(input.sourceEvent)) {
    return [];
  }
  const values = referenceValues(input.sourceEvent);
  return boundedEvidenceIds(input.evidenceIds).filter((evidenceId) =>
    explicitlyReferencesEvidenceId(values, evidenceId)
  );
}

export function isValidRuntimeV2SubagentHandoffDelivery(input: {
  readonly state: TurnAggregateV1;
  readonly event: HandoffDeliveredEvent;
}): boolean {
  const { state, event } = input;
  const job = state.subagents.find((candidate) =>
    candidate.id === event.jobId
  );
  const completion = [...state.events].reverse().find((candidate) =>
    candidate.type === "subagent.completed" &&
    candidate.jobId === event.jobId
  );
  const evidenceIds = normalizedEvidenceIds(event.evidenceIds);
  const completionEvidenceIds = completion?.type === "subagent.completed"
    ? completion.evidence.map((evidence) => evidence.id)
    : [];
  return Boolean(
    job &&
    completion &&
    evidenceIds &&
    event.contextEntryId === `child:${event.jobId}` &&
    sameEvidenceIdSet(evidenceIds, completionEvidenceIds) &&
    !state.events.some((candidate) =>
      candidate.type === "subagent.handoff_delivered" &&
      candidate.jobId === event.jobId
    )
  );
}

export function isValidRuntimeV2SubagentHandoffApplication(input: {
  readonly state: TurnAggregateV1;
  readonly event: HandoffAppliedEvent;
}): boolean {
  const { state, event } = input;
  const delivered = [...state.events].reverse().find((candidate) =>
    candidate.type === "subagent.handoff_delivered" &&
    candidate.jobId === event.jobId
  );
  const sourceEvent = state.events.find((candidate) =>
    candidate.eventId === event.sourceEventId
  );
  const evidenceIds = normalizedEvidenceIds(event.evidenceIds);
  const deliveredEvidenceIds =
    delivered?.type === "subagent.handoff_delivered"
      ? delivered.evidenceIds
      : [];
  const previouslyApplied = new Set(state.events.flatMap((candidate) =>
    candidate.type === "subagent.handoff_applied" &&
      candidate.jobId === event.jobId
      ? candidate.evidenceIds
      : []
  ));
  const actualSource = sourceEvent
    ? runtimeV2SubagentHandoffApplicationSource(sourceEvent)
    : null;
  const actuallyReferenced =
    sourceEvent && evidenceIds
      ? referencedRuntimeV2SubagentEvidenceIds({
          sourceEvent,
          evidenceIds,
        })
      : [];
  return Boolean(
    delivered &&
    sourceEvent &&
    sourceEvent.type !== "turn.admitted" &&
    sourceEvent.type !== "turn.completed" &&
    sourceEvent.sequence > delivered.sequence &&
    sameRun(sourceEvent.run, event.run) &&
    evidenceIds &&
    evidenceIds.length > 0 &&
    actualSource === event.source &&
    evidenceIds.every((id) =>
      deliveredEvidenceIds.includes(id) &&
      !previouslyApplied.has(id) &&
      actuallyReferenced.includes(id)
    ) &&
    !state.events.some((candidate) =>
      candidate.type === "subagent.handoff_applied" &&
      candidate.jobId === event.jobId &&
      candidate.sourceEventId === event.sourceEventId
    )
  );
}
