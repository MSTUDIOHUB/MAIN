import type {
  RuntimeV2SubagentJob,
  TurnAggregateV1,
} from "../../lib/runtime-v2";

function parentCommandIntervals(
  aggregate: TurnAggregateV1 | null,
): Array<{ start: number; end: number }> {
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

function mergedOverlapDuration(
  jobs: readonly RuntimeV2SubagentJob[],
  parentIntervals: readonly { start: number; end: number }[],
  measuredAt: number,
): number {
  const intersections = jobs.flatMap((job) => {
    if (job.status === "queued") return [];
    const childEnd = job.closedAt ?? measuredAt;
    return parentIntervals.flatMap((parent) => {
      const start = Math.max(job.requestedAt, parent.start);
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

export function runtimeV2ParentChildOverlapMs(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly jobs: readonly RuntimeV2SubagentJob[];
  readonly measuredAt: number;
}): number {
  return mergedOverlapDuration(
    input.jobs,
    parentCommandIntervals(input.aggregate),
    input.measuredAt,
  );
}
