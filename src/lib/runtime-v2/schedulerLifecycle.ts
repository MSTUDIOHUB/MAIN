import type {
  RuntimeV2Command,
  RuntimeV2SubagentJob,
} from "./contracts";
import type { RuntimeV2EventDraft } from "./events";
import type { SchedulerPort } from "./ports";
import type { TurnAggregateV1 } from "./aggregate";

export function runtimeV2JobMatchesSchedule(job: RuntimeV2SubagentJob, command: RuntimeV2Command): boolean {
  if (job.parentRunId !== command.run.runId) return false;
  if (typeof command.payload.proactiveKey === "string") return job.proactiveKey === command.payload.proactiveKey;
  const callId = command.payload.toolCallId;
  return typeof callId === "string" && callId ? job.sourceToolCallId === callId : !job.proactiveKey;
}

/** A resumed owner may reopen its existing read-only job with the original identity. */
export function runtimeV2ProactiveSchedulesToRestore(state: TurnAggregateV1): RuntimeV2Command[] {
  const scheduled = new Set(state.scheduledCommands.map(command => command.idempotencyKey));
  return state.events.flatMap(event => event.type === "command.scheduled" && event.command.kind === "schedule_subagents" &&
    typeof event.command.payload.proactiveKey === "string" && !scheduled.has(event.command.idempotencyKey) &&
    state.subagents.some(job => (job.status === "queued" || job.status === "running") && runtimeV2JobMatchesSchedule(job, event.command))
    ? [event.command] : []);
}

export async function restoreRuntimeV2ProactiveSchedules(input: {
  readonly state: TurnAggregateV1;
  readonly scheduler: SchedulerPort;
  readonly signal: AbortSignal;
  readonly commit: (event: RuntimeV2EventDraft) => Promise<unknown>;
}): Promise<void> {
  if (input.state.run?.status !== "running" || input.signal.aborted) return;
  for (const command of runtimeV2ProactiveSchedulesToRestore(input.state)) {
    const events = await input.scheduler.execute({
      command, run: command.run, signal: input.signal, scheduledSubagents: input.state.subagents,
    });
    for (const event of Array.isArray(events) ? events : [events]) await input.commit(event);
  }
}

function hasCommittedChildForCommand(
  command: RuntimeV2Command,
  jobs: readonly RuntimeV2SubagentJob[],
): boolean {
  return jobs.some((job) =>
    (job.status === "queued" || job.status === "running") &&
    runtimeV2JobMatchesSchedule(job, command)
  );
}

/**
 * Execute the canonical scheduler-side lifecycle after a collaboration
 * command has been durably scheduled. Both the Runtime controller and the
 * Plan adapter use this helper so child identities are committed before a
 * request starts and command completion is ordered before emitted telemetry.
 */
export async function executeRuntimeV2SchedulerLifecycle(input: {
  readonly command: RuntimeV2Command;
  readonly scheduler: SchedulerPort;
  readonly signal: AbortSignal;
  readonly getScheduledSubagents: () => readonly RuntimeV2SubagentJob[];
  readonly commitPrepared: (
    event: RuntimeV2EventDraft,
  ) => Promise<void>;
}): Promise<readonly RuntimeV2EventDraft[]> {
  if (
    input.command.kind !== "schedule_subagents" &&
    input.command.kind !== "join_subagents"
  ) {
    throw new Error(
      `Unsupported Runtime v2 scheduler lifecycle command: ${input.command.kind}`,
    );
  }
  let scheduledSubagents = input.getScheduledSubagents();
  if (
    input.command.kind === "schedule_subagents" &&
    !hasCommittedChildForCommand(input.command, scheduledSubagents)
  ) {
    const prepared = await input.scheduler.prepareSchedule?.({
      run: input.command.run,
      command: input.command,
      signal: input.signal,
    });
    if (prepared) {
      await input.commitPrepared(prepared);
      scheduledSubagents = input.getScheduledSubagents();
    }
  }
  const emitted = await input.scheduler.execute({
    run: input.command.run,
    command: input.command,
    signal: input.signal,
    scheduledSubagents,
  });
  return [{
    type: "command.completed",
    run: input.command.run,
    idempotencyKey: input.command.idempotencyKey,
    status: "succeeded",
  }, ...(
    Array.isArray(emitted) ? emitted : [emitted]
  ).filter((event) => event.type !== "command.completed")];
}
