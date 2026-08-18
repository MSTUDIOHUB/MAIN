import type {
  RuntimeV2Event,
  RuntimeV2SubagentJob,
  TurnAggregateV1,
} from "../../lib/runtime-v2";

type RuntimeV2Interval = { readonly start: number; readonly end: number };

/** Command scheduling includes lane admission and provider wait time. This is
 * lifecycle overlap only; it is deliberately not transport-concurrency proof
 * and does not imply that the parent produced useful evidence. */
function parentCommandLifecycleIntervals(
  aggregate: TurnAggregateV1 | null,
): RuntimeV2Interval[] {
  if (!aggregate) return [];
  return aggregate.events.flatMap((event) => {
    if (
      event.type !== "command.scheduled" ||
      event.command.kind === "schedule_subagents" ||
      event.command.kind === "join_subagents"
    ) {
      return [];
    }
    const completed = aggregate.events.find((candidate) =>
      candidate.sequence > event.sequence &&
      (
        candidate.type === "command.completed" ||
        candidate.type === "provider.responded" ||
        candidate.type === "tool.completed" ||
        candidate.type === "validation.completed"
      ) &&
      candidate.idempotencyKey === event.command.idempotencyKey
    );
    return completed && completed.at >= event.at
      ? [{ start: event.at, end: completed.at }]
      : [];
  });
}

function eventEvidence(
  event: RuntimeV2Event,
): readonly { readonly id: string }[] {
  if (
    event.type === "observation.recorded" ||
    event.type === "tool.completed" ||
    event.type === "validation.completed" ||
    event.type === "subagent.completed"
  ) {
    return event.type === "observation.recorded"
      ? [event.evidence]
      : event.evidence;
  }
  return [];
}

/** Only an effect-boundary receipt with a previously unseen evidence id is
 * parent progress. Model requests, scheduler calls, replayed reads, rejected
 * tools, and failed validations remain observable lifecycle facts but cannot
 * manufacture useful work. */
function parentEvidenceProgressIntervals(
  aggregate: TurnAggregateV1 | null,
): RuntimeV2Interval[] {
  if (!aggregate) return [];
  const scheduledByKey = new Map(
    aggregate.events.flatMap((event) =>
      event.type === "command.scheduled"
        ? [[event.command.idempotencyKey, event] as const]
        : []
    ),
  );
  const seenEvidenceIds = new Set<string>();
  const intervals: RuntimeV2Interval[] = [];
  for (const event of aggregate.events) {
    const evidence = eventEvidence(event);
    const hasNovelEvidence = evidence.some((entry) =>
      !!entry.id && !seenEvidenceIds.has(entry.id)
    );
    const successfulTool = event.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.receiptOrigin !== "replayed";
    const successfulValidation = event.type === "validation.completed" &&
      event.passed;
    if (hasNovelEvidence && (successfulTool || successfulValidation)) {
      const scheduled = scheduledByKey.get(event.idempotencyKey);
      if (
        scheduled &&
        (
          scheduled.command.kind === "execute_tool" ||
          scheduled.command.kind === "execute_validation"
        ) &&
        event.at >= scheduled.at
      ) {
        intervals.push({ start: scheduled.at, end: event.at });
      }
    }
    for (const entry of evidence) {
      if (entry.id) seenEvidenceIds.add(entry.id);
    }
  }
  return intervals;
}

function requestOpenedAt(
  aggregate: TurnAggregateV1 | null,
  job: RuntimeV2SubagentJob,
): number {
  const opened = aggregate?.events.find((event) =>
    event.type === "subagent.telemetry" &&
    event.telemetry.jobId === job.id &&
    event.telemetry.phase === "request_opened"
  );
  return opened?.type === "subagent.telemetry"
    ? opened.telemetry.at
    : job.requestedAt;
}

function mergedOverlapDuration(
  jobs: readonly RuntimeV2SubagentJob[],
  parentIntervals: readonly RuntimeV2Interval[],
  measuredAt: number,
  startedAt: (job: RuntimeV2SubagentJob) => number,
): number {
  const intersections = jobs.flatMap((job) => {
    if (job.status === "queued") return [];
    const childEnd = job.closedAt ?? measuredAt;
    return parentIntervals.flatMap((parent) => {
      const start = Math.max(startedAt(job), parent.start);
      const end = Math.min(childEnd, parent.end);
      return end > start ? [{ start, end }] : [];
    });
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let openStart = -1;
  let openEnd = -1;
  for (const interval of intersections) {
    if (openStart < 0) {
      openStart = interval.start;
      openEnd = interval.end;
      continue;
    }
    if (interval.start <= openEnd) {
      openEnd = Math.max(openEnd, interval.end);
      continue;
    }
    total += openEnd - openStart;
    openStart = interval.start;
    openEnd = interval.end;
  }
  return openStart < 0 ? 0 : total + openEnd - openStart;
}

export function runtimeV2ParentCommandLifecycleOverlapMs(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly jobs: readonly RuntimeV2SubagentJob[];
  readonly measuredAt: number;
}): number {
  return mergedOverlapDuration(
    input.jobs,
    parentCommandLifecycleIntervals(input.aggregate),
    input.measuredAt,
    (job) => job.requestedAt,
  );
}

export function runtimeV2ParentEvidenceProgressOverlapMs(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly jobs: readonly RuntimeV2SubagentJob[];
  readonly measuredAt: number;
}): number {
  return mergedOverlapDuration(
    input.jobs,
    parentEvidenceProgressIntervals(input.aggregate),
    input.measuredAt,
    (job) => requestOpenedAt(input.aggregate, job),
  );
}

/** Bounded join diagnostics. Neither field is provider transport authority;
 * modelLaneCoordinator owns real request-admission and first-chunk overlap. */
export function runtimeV2ParentOverlapDiagnostics(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly jobs: readonly RuntimeV2SubagentJob[];
  readonly measuredAt: number;
}): Readonly<Record<string, number | boolean>> {
  const parentCommandLifecycleOverlapMs =
    runtimeV2ParentCommandLifecycleOverlapMs(input);
  const parentEvidenceProgressOverlapMs =
    runtimeV2ParentEvidenceProgressOverlapMs(input);
  return {
    parentCommandLifecycleOverlap: parentCommandLifecycleOverlapMs > 0,
    parentCommandLifecycleOverlapMs,
    parentEvidenceProgressOverlap: parentEvidenceProgressOverlapMs > 0,
    parentEvidenceProgressOverlapMs,
  };
}
