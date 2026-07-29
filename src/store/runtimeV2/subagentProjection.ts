import {
  resolveSubagentCapacityPolicy,
  type SubagentActivity,
  type SubagentClosureEnvelope,
  type SubagentRunSnapshot,
  type SubagentStatus,
} from "../../lib/subagents";
import {
  appendRuntimeEvent,
  withEventSchema,
  type MainThreadEvent,
} from "../../lib/turnEvents";
import type { TurnAggregateV1 } from "../../lib/runtime-v2";

function runtimeV2SubagentLane(state: any): {
  profile: "local" | "cloud";
  provider: string;
  model: string;
} {
  if (state?.config) {
    const policy = resolveSubagentCapacityPolicy(state.config);
    return {
      profile: policy.profile,
      provider: policy.provider,
      model: policy.model,
    };
  }
  return {
    profile: "local",
    provider: "Runtime v2",
    model: "Parent model lane",
  };
}

function hasSubagentEvent(
  events: readonly MainThreadEvent[],
  type: MainThreadEvent["type"],
  subagentId: string,
): boolean {
  return events.some((event) =>
    event.type === type &&
    "subagentId" in event &&
    event.subagentId === subagentId
  );
}

function hasSubagentActivity(
  events: readonly MainThreadEvent[],
  activityId: string,
): boolean {
  return events.some((event) =>
    event.type === "subagent.updated" &&
    event.activity?.id === activityId
  );
}

function runtimeV2SubagentClosure(input: {
  aggregate: TurnAggregateV1;
  job: TurnAggregateV1["subagents"][number];
  status: Extract<
    SubagentStatus,
    "completed" | "degraded" | "failed" | "canceled"
  >;
  evidenceCount: number;
  reason: string;
}): SubagentClosureEnvelope {
  const run = input.aggregate.run!.identity;
  const completed = input.status === "completed";
  const degraded = input.status === "degraded";
  return {
    schemaVersion: 1,
    owner: {
      agentKind: "subagent",
      threadId: run.sessionKey,
      parentTurnId: run.turnId,
      subagentId: input.job.id,
      runId: input.job.run.runId,
      parentRunId: input.job.parentRunId,
    },
    scopeKey: input.job.scopeKey,
    status: input.status,
    state: completed ? "satisfied" : degraded ? "partial" : "blocked",
    remainingWork: completed ? null : input.job.objective,
    observationCount: input.evidenceCount,
    substantiveEvidenceCount: input.evidenceCount,
    acceptedEvidenceToolCallIds: [],
    requiredPaths: [],
    coveredPaths: [],
    failedPaths: [],
    uncoveredPaths: completed ? [] : [...input.job.allowedPaths],
    reasonCode: completed
      ? "runtime_v2_child_completed"
      : degraded
        ? "runtime_v2_child_degraded"
      : input.status === "canceled"
        ? "runtime_v2_child_canceled"
        : "runtime_v2_child_failed",
    reason: input.reason || input.status,
  };
}

/**
 * Runtime v2 owns child scheduling in its aggregate, while ChatArea and the
 * right panel consume the shared MainThreadEvent child protocol.
 */
export function reconcileRuntimeV2SubagentEvents(
  events: readonly MainThreadEvent[],
  aggregate: TurnAggregateV1,
  state: any,
  language: "zh" | "en",
): MainThreadEvent[] {
  const run = aggregate.run?.identity;
  if (!run) return [...events];
  let next = [...events];
  const lane = runtimeV2SubagentLane(state);
  const jobs = new Map(aggregate.subagents.map((job) => [job.id, job] as const));

  for (const runtimeEvent of aggregate.events) {
    if (runtimeEvent.type === "subagents.scheduled") {
      for (const job of runtimeEvent.jobs) {
        if (hasSubagentEvent(next, "subagent.created", job.id)) continue;
        const snapshot: SubagentRunSnapshot = {
          id: job.id,
          parentTurnId: run.turnId,
          threadId: run.sessionKey,
          name: job.name || job.scopeKey,
          role: job.role || (
            language === "zh" ? "只读调查" : "Read-only investigation"
          ),
          objective: job.objective,
          scopeKey: job.scopeKey,
          scope: job.allowedPaths.join(", "),
          allowedPaths: [...job.allowedPaths],
          expectedOutput: job.expectedOutput || (
            language === "zh"
              ? "返回带来源的只读调查证据"
              : "Return sourced read-only investigation evidence"
          ),
          runId: job.run.runId,
          parentRunId: job.parentRunId,
          status: "queued",
          ...lane,
          createdAt: job.requestedAt,
          updatedAt: job.requestedAt,
          progress: {
            phase: "queued",
            title: language === "zh" ? "等待模型通道" : "Waiting for model lane",
          },
        };
        next = appendRuntimeEvent(next, withEventSchema({
          type: "subagent.created",
          threadId: run.sessionKey,
          turnId: run.turnId,
          subagentId: job.id,
          runId: job.run.runId,
          parentRunId: job.parentRunId,
          timestampMs: job.requestedAt,
          subagent: snapshot,
        }));
      }
      continue;
    }

    if (runtimeEvent.type === "subagent.telemetry") {
      const job = jobs.get(runtimeEvent.telemetry.jobId);
      if (!job) continue;
      const activityId = `runtime-v2:${runtimeEvent.eventId}`;
      if (hasSubagentActivity(next, activityId)) continue;
      const phase = runtimeEvent.telemetry.phase;
      const title = phase === "request_opened"
        ? language === "zh" ? "已启动只读调查" : "Read-only investigation started"
        : phase === "first_token"
          ? language === "zh" ? "正在分析范围内证据" : "Analyzing scoped evidence"
          : language === "zh" ? "正在整理调查结果" : "Summarizing investigation";
      const activity: SubagentActivity = {
        id: activityId,
        timestampMs: runtimeEvent.telemetry.at,
        status: "running",
        title,
        target: job.allowedPaths.join(", "),
      };
      next = appendRuntimeEvent(next, withEventSchema({
        type: "subagent.updated",
        threadId: run.sessionKey,
        turnId: run.turnId,
        subagentId: job.id,
        runId: job.run.runId,
        parentRunId: job.parentRunId,
        timestampMs: runtimeEvent.telemetry.at,
        patch: {
          status: phase === "closed" ? "summarizing" : "running",
          updatedAt: runtimeEvent.telemetry.at,
          ...(phase === "request_opened"
            ? { startedAt: runtimeEvent.telemetry.at }
            : {}),
          progress: {
            phase: phase === "request_opened"
              ? "starting"
              : phase === "first_token"
                ? "thinking"
                : "summarizing",
            title,
          },
        },
        activity,
      }));
      continue;
    }

    if (runtimeEvent.type !== "subagent.completed") continue;
    const job = jobs.get(runtimeEvent.jobId);
    if (!job) continue;
    const status: Extract<
      SubagentStatus,
      "completed" | "degraded" | "failed" | "canceled"
    > = runtimeEvent.status;
    const evidenceCount = runtimeEvent.evidence.length;
    const closureAudit = runtimeV2SubagentClosure({
      aggregate,
      job,
      status,
      evidenceCount,
      reason: runtimeEvent.summary,
    });
    const activityId = `runtime-v2:${runtimeEvent.eventId}`;
    if (!hasSubagentActivity(next, activityId)) {
      next = appendRuntimeEvent(next, withEventSchema({
        type: "subagent.updated",
        threadId: run.sessionKey,
        turnId: run.turnId,
        subagentId: job.id,
        runId: job.run.runId,
        parentRunId: job.parentRunId,
        timestampMs: runtimeEvent.at,
        patch: {
          status,
          updatedAt: runtimeEvent.at,
          completedAt: runtimeEvent.at,
          summary: runtimeEvent.summary,
          evidenceCount,
          observationCount: evidenceCount,
          substantiveEvidenceCount: evidenceCount,
          closureState: closureAudit.state,
          closureAudit,
          remainingWork: closureAudit.remainingWork || undefined,
          parentHandoff: runtimeEvent.summary,
          progress: {
            phase: "done",
            title: status === "completed"
              ? language === "zh" ? "调查已完成" : "Investigation completed"
              : status === "degraded"
                ? language === "zh"
                  ? "已交由主体接管"
                  : "Handed back to main"
                : language === "zh"
                  ? "调查未完成"
                  : "Investigation did not complete",
          },
        },
        activity: {
          id: activityId,
          timestampMs: runtimeEvent.at,
          status: status === "completed" ? "completed" : status,
          title: runtimeEvent.summary,
          target: job.allowedPaths.join(", "),
        },
      }));
    }
    if (!hasSubagentEvent(next, "subagent.completed", job.id)) {
      next = appendRuntimeEvent(next, withEventSchema({
        type: "subagent.completed",
        threadId: run.sessionKey,
        turnId: run.turnId,
        subagentId: job.id,
        runId: job.run.runId,
        parentRunId: job.parentRunId,
        timestampMs: runtimeEvent.at,
        completedAt: runtimeEvent.at,
        status,
      }));
    }
    if (!hasSubagentEvent(next, "subagent.closed", job.id)) {
      next = appendRuntimeEvent(next, withEventSchema({
        type: "subagent.closed",
        threadId: run.sessionKey,
        turnId: run.turnId,
        subagentId: job.id,
        runId: job.run.runId,
        parentRunId: job.parentRunId,
        timestampMs: runtimeEvent.at,
        closedAt: runtimeEvent.at,
        reason: status,
      }));
    }
  }
  return next;
}
