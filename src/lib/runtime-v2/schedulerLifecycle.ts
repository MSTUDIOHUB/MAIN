import type {
  RuntimeV2Command,
  RuntimeV2SubagentJob,
} from "./contracts";
import type { RuntimeV2EventDraft } from "./events";
import type { SchedulerPort } from "./ports";

function sourceToolCallId(command: RuntimeV2Command): string {
  return typeof command.payload.toolCallId === "string"
    ? command.payload.toolCallId
    : "";
}

function hasCommittedChildForCommand(
  command: RuntimeV2Command,
  jobs: readonly RuntimeV2SubagentJob[],
): boolean {
  const sourceCallId = sourceToolCallId(command);
  return jobs.some((job) =>
    job.parentRunId === command.run.runId &&
    (job.status === "queued" || job.status === "running") &&
    (!sourceCallId || job.sourceToolCallId === sourceCallId)
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
