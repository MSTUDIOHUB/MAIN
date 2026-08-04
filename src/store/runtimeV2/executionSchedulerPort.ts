import {
  deriveRuntimeV2SubagentConcurrency,
  runtimeV2SubagentModelHandle,
  scheduleRuntimeV2Subagents,
  type RuntimeV2EventDraft,
  type RuntimeV2SubagentJob,
  type SchedulerPort,
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
  runtimeV2SubagentTotalBudgetFromCommand,
} from "./executionSubagentCandidate";
import { startRuntimeV2Child } from "./executionSubagentRunner";
import { commitCompletedRuntimeV2ChildTransaction } from "./executionSubagentJoin";
import { runtimeV2ParentChildOverlapMs } from "./executionSubagentOverlap";
import {
  parentHasImplementationSourceAuthority,
} from "./executionSubagentAuthority";
import type { RuntimeV2ChildResult } from "./executionTypes";
import {
  deriveRuntimeV2ExecutionContract,
  runtimeV2ExecutionContractAllowsTargets,
} from "./executionContract";
import {
  deriveRuntimeV2ValidationCorrectionWindow,
} from "./executionValidationCorrection";

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



export function createRuntimeV2SchedulerPort(
  input: RuntimeV2ExecutionPortsInput,
): SchedulerPort {
  return {
    async prepareSchedule({ command }) {
      if (command.kind !== "schedule_subagents") return null;
      const existingJobs =
        (aggregateForCurrentTurn(input)?.subagents || []).filter((job) =>
          job.parentRunId === command.run.runId
        );
      const turnChildLimit =
        runtimeV2SubagentTotalBudgetFromCommand(command);
      if (existingJobs.length >= turnChildLimit) {
        const detail =
          `This Run has already used its bounded collaboration budget of ` +
          `${turnChildLimit} child task(s). Continue the parent task directly.`;
        closeCollaborationToolCall(
          input,
          command,
          `SUBAGENT_SCHEDULE_REJECTED: ${detail}`,
        );
        input.logStoreEvent("runtime_v2_subagent_schedule_rejected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          reason: "turn_child_budget_exhausted",
          childRuns: existingJobs.length,
          turnChildLimit,
        });
        throw new Error(detail);
      }
      let decision;
      try {
        const candidate = runtimeV2ModelSelectedSubagentCandidate(command);
        const aggregate = aggregateForCurrentTurn(input);
        if (
          candidate.taskKind === "implement" &&
          candidate.accessMode === "write" &&
          aggregate?.strategy === "execute"
        ) {
          const executionContract =
            deriveRuntimeV2ExecutionContract(aggregate);
          const validationCorrection =
            deriveRuntimeV2ValidationCorrectionWindow(aggregate);
          if (!executionContract && !validationCorrection.active) {
            throw new Error(
              "implement subagents require a recorded parent execution contract; use a read-only child until the parent has an evidence-backed solution.",
            );
          }
          if (
            executionContract &&
            !validationCorrection.active &&
            !runtimeV2ExecutionContractAllowsTargets({
              contract: executionContract,
              targets: candidate.allowedPaths,
            })
          ) {
            throw new Error(
              "implement subagent write paths must be exact mutation targets in the current parent execution contract.",
            );
          }
        }
        if (!parentHasImplementationSourceAuthority({
          ports: input,
          candidate,
        })) {
          throw new Error(
            "implement subagents may modify or delete only after the parent has versioned source evidence for every exact assigned file path.",
          );
        }
        decision = scheduleRuntimeV2Subagents({
          parentRun: command.run,
          candidates: [candidate],
          existingJobs,
          maxActiveJobs:
            turnChildLimit,
          requestedAt: input.now(),
          nextId: input.nextId,
        });
      } catch (error) {
        closeCollaborationToolCall(
          input,
          command,
          `SUBAGENT_SCHEDULE_REJECTED: ${
            error instanceof Error ? error.message : String(error)
          } Continue the parent task directly or submit a valid, genuinely independent scoped task.`,
        );
        throw error;
      }
      if (decision.jobs.length !== 1) {
        const detail =
          `The requested child duplicates an existing semantic task, exceeds ` +
          `the current provider-lane capacity, or violates the access/scope contract: ${
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
      const runSubagents = (scheduledSubagents || []).filter((job) =>
        job.parentRunId === command.run.runId
      );
      if (command.kind === "schedule_subagents") {
        const sourceToolCallId = boundedArgument(
          command.payload.toolCallId,
          256,
        );
        const jobs = runSubagents.filter((job) =>
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
          modelRequestMode: String(
            command.payload.collaborationRequestMode || "serialized",
          ),
          scopes: jobs.map((job) => job.scopeKey),
          tasks: jobs.map((job) => ({
            id: job.id,
            taskKind: job.taskKind,
            objective: job.objective.slice(0, 1_000),
            successCriteria:
              job.successCriteria?.slice(0, 1_000) || null,
            allowedPaths: job.allowedPaths,
          })),
          concurrent: runSubagents.filter((job) =>
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
            if (job.taskKind === "implement" && job.accessMode === "write") {
              input.live.childWriteScopes.set(job.id, [...job.allowedPaths]);
            }
            input.live.childRuns.set(
              job.id,
              startRuntimeV2Child(input, job, signal),
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
              accessMode: job.accessMode || "read",
              implementationOperation:
                job.implementationOperation || null,
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
        const runSubagentIds = new Set(runSubagents.map((job) => job.id));
        const jobIds = Array.isArray(command.payload.jobIds)
          ? command.payload.jobIds
              .map((value) => String(value || ""))
              .filter((jobId) => !!jobId && runSubagentIds.has(jobId))
          : [];
        const requestedJobIds =
          Array.isArray(command.payload.requestedJobIds)
            ? command.payload.requestedJobIds
                .map((value) => String(value || "").trim())
                .filter(Boolean)
            : [];
        const automaticJoinReason =
          typeof command.payload.automaticJoinReason === "string"
            ? command.payload.automaticJoinReason
            : "";
        if (requestedJobIds.length > 0 && jobIds.length === 0) {
          const activeTaskHandles = runSubagents
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
          if (automaticJoinReason) {
            input.logStoreEvent("runtime_v2_subagent_auto_join", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              jobIds,
              reason: automaticJoinReason,
            });
          }
          input.logStoreEvent("runtime_v2_subagent_wait_requested", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            jobIds,
            finalJoin: command.payload.finalJoin === true,
            automaticJoinReason: automaticJoinReason || null,
          });
        }
        const rawResults = await Promise.all(jobIds.map(async (jobId) => {
          const promise = input.live.childRuns.get(jobId);
          if (promise) return await promise;
          const job = runSubagents.find(
            (candidate) => candidate.id === jobId,
          );
          return job
            ? {
                job,
                status: "failed" as const,
                summary:
                  "子智能体请求在进程重启后无法继续；已结束该子任务并保留父任务证据。",
                report: null,
                inheritedEvidence: [],
                evidence: [],
              }
            : null;
        }));
        const results: Array<RuntimeV2ChildResult | null> = [];
        for (const result of rawResults) {
          if (!result) {
            results.push(null);
            continue;
          }
          try {
            results.push(await commitCompletedRuntimeV2ChildTransaction({
              ports: input,
              command,
              result,
              signal,
            }));
          } finally {
            input.live.childWriteScopes.delete(result.job.id);
          }
        }
        const events: RuntimeV2EventDraft[] = [];
        const observedJobs: RuntimeV2SubagentJob[] = [];
        for (const result of results) {
          if (!result) continue;
          const committedJob = runSubagents.find(
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
          .filter((job) => job.parentRunId === command.run.runId)
          .map((job) => observedById.get(job.id) || job);
        for (const job of observedJobs) {
          if (!allObservedJobs.some((candidate) => candidate.id === job.id)) {
            allObservedJobs.push(job);
          }
        }
        const concurrency =
          deriveRuntimeV2SubagentConcurrency(allObservedJobs);
        const parentChildOverlapMs = runtimeV2ParentChildOverlapMs({
          jobs: allObservedJobs,
          aggregate,
          measuredAt: input.now(),
        });
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
