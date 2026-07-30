import {
  deriveRuntimeV2SubagentConcurrency,
  runtimeV2SubagentModelHandle,
  scheduleReadOnlySubagents,
  type RuntimeV2EventDraft,
  type RuntimeV2SubagentJob,
  type SchedulerPort,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import type { RuntimeV2ExecutionPortsInput } from "./executionContext";
import { aggregateForCurrentTurn } from "./executionAggregate";
import {
  appendRuntimeV2ToolResultHistory,
  upsertRuntimeV2ContextAnchor,
} from "./executionProviderHistory";
import {
  runtimeV2ModelSelectedSubagentCandidate,
  runtimeV2SubagentCapacityFromCommand,
} from "./executionSubagentCandidate";
import { startRuntimeV2ReadOnlyChild } from "./executionSubagentRunner";

function boundedArgument(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function closeCollaborationToolCall(
  input: RuntimeV2ExecutionPortsInput,
  command: Parameters<SchedulerPort["execute"]>[0]["command"],
  content: string,
): void {
  appendRuntimeV2ToolResultHistory(
    input.live,
    boundedArgument(command.payload.toolCallId, 256),
    content.trim().slice(0, 8_000),
  );
}

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

function totalOverlapDuration(
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

export function createRuntimeV2SchedulerPort(
  input: RuntimeV2ExecutionPortsInput,
): SchedulerPort {
  return {
    async prepareSchedule({ command }) {
      if (command.kind !== "schedule_subagents") return null;
      const existingJobs =
        aggregateForCurrentTurn(input)?.subagents || [];
      let decision;
      try {
        decision = scheduleReadOnlySubagents({
          parentRun: command.run,
          candidates: [runtimeV2ModelSelectedSubagentCandidate(command)],
          existingJobs,
          maxActiveJobs:
            runtimeV2SubagentCapacityFromCommand(command),
          requestedAt: input.now(),
          nextId: input.nextId,
        });
      } catch (error) {
        closeCollaborationToolCall(
          input,
          command,
          `SUBAGENT_SCHEDULE_REJECTED: ${
            error instanceof Error ? error.message : String(error)
          } Continue the parent task directly or submit a valid, genuinely independent read-only task.`,
        );
        throw error;
      }
      if (decision.jobs.length !== 1) {
        const detail =
          `The requested child duplicates an existing semantic task, exceeds ` +
          `the current provider-lane capacity, or violates the read-only scope contract: ${
            decision.rejectedScopeKeys.join(", ") || "invalid scope"
          }. Continue the parent task directly or delegate a genuinely different task.`;
        closeCollaborationToolCall(
          input,
          command,
          `SUBAGENT_SCHEDULE_REJECTED: ${detail}`,
        );
        input.logStoreEvent("runtime_v2_subagent_schedule_rejected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          rejectedScopeKeys: decision.rejectedScopeKeys,
          activeTaskHandles: existingJobs
            .filter((job) =>
              job.status === "queued" || job.status === "running"
            )
            .map(runtimeV2SubagentModelHandle),
        });
        throw new Error(
          detail,
        );
      }
      return {
        type: "subagents.scheduled",
        run: command.run,
        maxActiveSubagents:
          runtimeV2SubagentCapacityFromCommand(command),
        jobs: decision.jobs,
      };
    },
    async execute({ command, signal, scheduledSubagents }) {
      if (command.kind === "schedule_subagents") {
        const sourceToolCallId = boundedArgument(
          command.payload.toolCallId,
          256,
        );
        const jobs = (scheduledSubagents || []).filter((job) =>
          (job.status === "queued" || job.status === "running") &&
          (!sourceToolCallId || job.sourceToolCallId === sourceToolCallId)
        );
        if (jobs.length === 0) {
          closeCollaborationToolCall(
            input,
            command,
            "SUBAGENT_SCHEDULE_REJECTED: no committed child matched this request. Continue the parent task directly.",
          );
          throw new Error(
            "Runtime v2 scheduler could not resolve the child job committed for this spawn_subagent call.",
          );
        }
        const events: RuntimeV2EventDraft[] = [];
        input.logStoreEvent("runtime_v2_subagent_batch_starting", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          jobCount: jobs.length,
          scopes: jobs.map((job) => job.scopeKey),
          concurrent: (scheduledSubagents || []).filter((job) =>
            job.status === "queued" || job.status === "running"
          ).length > 1,
          resumed: jobs.some((job) => job.status === "running"),
        });
        for (const job of jobs) {
          if (!input.live.childRuns.has(job.id)) {
            input.live.childTelemetry.set(job.id, {
              firstTokenAt: job.firstTokenAt,
              closedAt: job.closedAt,
            });
            input.live.childRuns.set(
              job.id,
              startRuntimeV2ReadOnlyChild(input, job, signal),
            );
          }
          if (job.status === "queued") {
            input.logStoreEvent("runtime_v2_subagent_request_opened", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              jobId: job.id,
              scopeKey: job.scopeKey,
              allowedPaths: job.allowedPaths,
              taskKind: job.taskKind || "explore",
              startedInPhase: command.phase,
            });
            events.push({
              type: "subagent.telemetry",
              run: command.run,
              telemetry: {
                jobId: job.id,
                phase: "request_opened",
                at: input.now(),
              },
            });
          } else {
            input.logStoreEvent("runtime_v2_subagent_request_resumed", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              jobId: job.id,
              scopeKey: job.scopeKey,
            });
          }
        }
        closeCollaborationToolCall(
          input,
          command,
          [
            "SUBAGENT_STARTED",
            `Handles: ${jobs.map(runtimeV2SubagentModelHandle).join(", ")}`,
            "Continue independent parent work. Use wait_subagents only when a child result becomes a dependency.",
          ].join("\n"),
        );
        return events;
      }
      if (command.kind === "join_subagents") {
        const jobIds = Array.isArray(command.payload.jobIds)
          ? command.payload.jobIds
              .map((value) => String(value || "")).filter(Boolean)
          : [];
        const requestedJobIds =
          Array.isArray(command.payload.requestedJobIds)
            ? command.payload.requestedJobIds
                .map((value) => String(value || "").trim())
                .filter(Boolean)
            : [];
        if (requestedJobIds.length > 0 && jobIds.length === 0) {
          const activeTaskHandles = (scheduledSubagents || [])
            .filter((job) =>
              job.status === "queued" || job.status === "running"
            )
            .map(runtimeV2SubagentModelHandle);
          const detail =
            `wait_subagents did not match an active child task handle: ${
              requestedJobIds.join(", ")
            }. Active handles: ${activeTaskHandles.join(", ") || "none"}.`;
          input.logStoreEvent("runtime_v2_subagent_reference_rejected", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            requestedJobIds,
            activeTaskHandles,
          });
          closeCollaborationToolCall(
            input,
            command,
            `SUBAGENT_WAIT_REJECTED: ${detail} Continue independent parent work.`,
          );
          throw new Error(
            detail,
          );
        }
        if (jobIds.length > 0) {
          input.logStoreEvent("runtime_v2_subagent_wait_requested", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            jobIds,
            finalJoin: command.payload.finalJoin === true,
          });
        }
        const results = await Promise.all(jobIds.map(async (jobId) => {
          const promise = input.live.childRuns.get(jobId);
          if (promise) return await promise;
          const job = (scheduledSubagents || []).find(
            (candidate) => candidate.id === jobId,
          );
          return job
            ? {
                job,
                status: "failed" as const,
                summary:
                  "子智能体请求在进程重启后无法继续；已结束该只读子任务并保留父任务证据。",
                report: null,
                inheritedEvidence: [],
                evidence: [],
              }
            : null;
        }));
        const events: RuntimeV2EventDraft[] = [];
        const observedJobs: RuntimeV2SubagentJob[] = [];
        for (const result of results) {
          if (!result) continue;
          const committedJob = (scheduledSubagents || []).find(
            (job) => job.id === result.job.id,
          );
          const telemetry =
            input.live.childTelemetry.get(result.job.id);
          if (committedJob?.status === "queued") {
            events.push({
              type: "subagent.telemetry",
              run: command.run,
              telemetry: {
                jobId: result.job.id,
                phase: "request_opened",
                at: input.now(),
              },
            });
          }
          if (telemetry && telemetry.firstTokenAt !== null) {
            events.push({
              type: "subagent.telemetry",
              run: command.run,
              telemetry: {
                jobId: result.job.id,
                phase: "first_token",
                at: telemetry.firstTokenAt,
              },
            });
          }
          events.push({
            type: "subagent.telemetry",
            run: command.run,
            telemetry: {
              jobId: result.job.id,
              phase: "closed",
              at: telemetry?.closedAt || input.now(),
            },
          });
          events.push({
            type: "subagent.completed",
            run: command.run,
            jobId: result.job.id,
            status: result.status,
            summary: result.summary,
            ...(result.inheritedEvidence.length > 0
              ? { inheritedEvidence: result.inheritedEvidence }
              : {}),
            evidence: result.evidence,
            ...(result.report ? { report: result.report } : {}),
          });
          observedJobs.push({
            ...result.job,
            status: result.status,
            firstTokenAt: telemetry?.firstTokenAt || null,
            closedAt: telemetry?.closedAt || input.now(),
            summary: result.summary,
            report: result.report,
          });
          const contextEntryId = `child:${result.job.id}`;
          const evidenceIds = [...new Set(
            result.evidence.map((evidence) => evidence.id),
          )];
          const contextContent = [
            `Scope: ${result.job.scopeKey} (${
              result.job.allowedPaths.join(", ")
            })`,
            `Status: ${result.status}`,
            `Evidence ids: ${evidenceIds.join(", ") || "none"}`,
            `Report: ${result.summary.slice(0, 4_000)}`,
            evidenceIds.length > 0
              ? "When relying on a child fact, explicitly cite its exact evidence id in the next structured action or final answer."
              : "No child evidence id is available for parent adoption; continue the objective directly.",
          ].join("\n");
          upsertRuntimeV2ContextAnchor(input.live, {
            key: contextEntryId,
            content: contextContent,
          });
          const deliveredContext = input.live.messages.find((message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.startsWith(
              `[runtime-v2 context: ${contextEntryId}]`,
            ) &&
            message.content.includes(
              `Report: ${result.summary.slice(0, 4_000)}`,
            ) &&
            message.content.includes(
              `Evidence ids: ${evidenceIds.join(", ") || "none"}`,
            )
          );
          if (deliveredContext) {
            events.push({
              type: "subagent.handoff_delivered",
              run: command.run,
              jobId: result.job.id,
              contextEntryId,
              evidenceIds,
            });
          }
          input.logStoreEvent("runtime_v2_subagent_joined", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            jobId: result.job.id,
            status: result.status,
            firstTokenAt: telemetry?.firstTokenAt || null,
            closedAt: telemetry?.closedAt || null,
            evidenceTargets: result.evidence.map(
              (evidence) => evidence.target,
            ),
            structuredReport: !!result.report,
          });
          input.live.childRuns.delete(result.job.id);
        }
        const aggregate = aggregateForCurrentTurn(input);
        const observedById = new Map(
          observedJobs.map((job) => [job.id, job]),
        );
        const allObservedJobs = (aggregate?.subagents || [])
          .map((job) => observedById.get(job.id) || job);
        for (const job of observedJobs) {
          if (!allObservedJobs.some((candidate) => candidate.id === job.id)) {
            allObservedJobs.push(job);
          }
        }
        const concurrency =
          deriveRuntimeV2SubagentConcurrency(allObservedJobs);
        const parentChildOverlapMs = totalOverlapDuration(
          allObservedJobs,
          parentCommandIntervals(aggregate),
          input.now(),
        );
        input.logStoreEvent("runtime_v2_subagent_batch_joined", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          jobCount: observedJobs.length,
          peakInFlight: concurrency.peakInFlight,
          hasRequestOverlap: concurrency.hasRequestOverlap,
          parentChildOverlap: parentChildOverlapMs > 0,
          parentChildOverlapMs,
        });
        closeCollaborationToolCall(
          input,
          command,
          [
            "SUBAGENT_RESULTS",
            ...results.flatMap((result) => result
              ? [
                  `Handle: ${runtimeV2SubagentModelHandle(result.job)}`,
                  `Status: ${result.status}`,
                  `Evidence ids: ${
                    result.evidence.map((evidence) => evidence.id)
                      .join(", ") || "none"
                  }`,
                  `Summary: ${result.summary.slice(0, 2_000)}`,
                ]
              : []),
            observedJobs.some((job) => job.status !== "completed")
              ? "One or more child tasks did not complete. Continue the objective directly using any retained evidence."
              : "Apply child findings only when they are relevant to the parent objective.",
            "When relying on a child fact, explicitly cite its exact evidence id. An uncited child result remains delivered but not adopted.",
          ].join("\n"),
        );
        return events;
      }
      throw new Error(
        `Unsupported Runtime v2 scheduler command: ${command.kind}`,
      );
    },
  };
}
