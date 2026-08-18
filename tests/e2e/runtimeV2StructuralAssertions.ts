import { expect } from "@playwright/test";

type RuntimeV2SubagentSnapshot = {
  id?: string;
  parentRunId?: string;
  scopeKey?: string;
  sourceToolCallId?: string;
  name?: string;
  role?: string;
  taskKind?: string;
  accessMode?: string;
  objective?: string;
  successCriteria?: string;
  status?: string;
  allowedPaths?: string[];
  requestOpenedAt?: number;
  firstTokenAt?: number | null;
  closedAt?: number;
  startedInPhase?: string | null;
  reportSubmitted?: boolean;
};

type RuntimeV2Interval = {
  readonly start: number;
  readonly end: number;
};

export type RuntimeV2CollaborationDiagnostics = {
  /** Null means this E2E snapshot does not contain model-lane telemetry. */
  readonly modelLaneOverlapObserved: boolean | null;
  /** Useful parent evidence committed while a child request was open. */
  readonly parentEvidenceProgressOverlapMs: number;
};

function boundedDebugNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (!value || typeof value !== "object") return [];
  const summary = value as {
    names?: unknown;
    head?: unknown;
    tail?: unknown;
  };
  return [...new Set([
    ...(Array.isArray(summary.names) ? summary.names : []),
    ...(Array.isArray(summary.head) ? summary.head : []),
    ...(Array.isArray(summary.tail) ? summary.tail : []),
  ].map(String))];
}

function mergedIntervalDuration(intervals: readonly RuntimeV2Interval[]): number {
  const ordered = [...intervals]
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let open: RuntimeV2Interval | null = null;
  for (const interval of ordered) {
    if (!open) {
      open = interval;
      continue;
    }
    if (interval.start <= open.end) {
      open = { start: open.start, end: Math.max(open.end, interval.end) };
      continue;
    }
    total += open.end - open.start;
    open = interval;
  }
  return open ? total + open.end - open.start : 0;
}

function debugArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const summary = value as { head?: unknown; tail?: unknown };
  return [
    ...(Array.isArray(summary.head) ? summary.head : []),
    ...(Array.isArray(summary.tail) ? summary.tail : []),
  ];
}

export function runtimeV2CollaborationDiagnostics(
  runtime: any,
): RuntimeV2CollaborationDiagnostics {
  const jobs = (Array.isArray(runtime?.subagents)
    ? runtime.subagents
    : []) as RuntimeV2SubagentSnapshot[];
  const commands = Array.isArray(runtime?.commands) ? runtime.commands : [];
  const commandByKey = new Map(commands.map((command: any) => [
    String(command.idempotencyKey || ""),
    command,
  ]));
  const seenEvidenceIds = new Set<string>();
  const progressIntervals: RuntimeV2Interval[] = [];
  for (const event of Array.isArray(runtime?.events) ? runtime.events : []) {
    const evidence = Array.isArray(event?.evidence) ? event.evidence : [];
    const hasNovelEvidence = evidence.some((entry: { id?: string }) => {
      const id = String(entry?.id || "");
      return !!id && !seenEvidenceIds.has(id);
    });
    const successfulTool = event?.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.receiptOrigin !== "replayed";
    const successfulValidation = event?.type === "validation.completed" &&
      event.passed === true;
    if (hasNovelEvidence && (successfulTool || successfulValidation)) {
      const command: any = commandByKey.get(String(event.idempotencyKey || ""));
      if (
        command?.status === "succeeded" &&
        Number.isFinite(command.at) &&
        Number.isFinite(command.completedAt)
      ) {
        for (const job of jobs) {
          if (
            !Number.isFinite(job.requestOpenedAt) ||
            !Number.isFinite(job.closedAt)
          ) {
            continue;
          }
          const start = Math.max(
            Number(command.at),
            Number(job.requestOpenedAt),
          );
          const end = Math.min(
            Number(command.completedAt),
            Number(job.closedAt),
          );
          if (end > start) progressIntervals.push({ start, end });
        }
      }
    }
    for (const entry of evidence) {
      const id = String(entry?.id || "");
      if (id) seenEvidenceIds.add(id);
    }
  }

  const laneAdmissions = (Array.isArray(runtime?.debug) ? runtime.debug : [])
    .filter((entry: { source?: string; data?: any }) => {
      if (!String(entry.source || "").endsWith(".model_lane_admission")) {
        return false;
      }
      const data = entry.data || {};
      return (!runtime?.turnId || data.turnId === runtime.turnId) &&
        (!data.runId ||
          data.runId === runtime?.runId ||
          String(data.runId).startsWith(`${runtime?.runId}:child:`));
    });
  const modelLaneOverlapObserved = laneAdmissions.length === 0
    ? null
    : laneAdmissions.some((entry: { data?: any }) => {
        const data = entry.data || {};
        const liveRequests = debugArray(data.liveRequests);
        return data.overlapping === true &&
          liveRequests.some((request) => request?.agentKind === "parent") &&
          liveRequests.some((request) => request?.agentKind === "subagent");
      });

  return {
    modelLaneOverlapObserved,
    parentEvidenceProgressOverlapMs:
      mergedIntervalDuration(progressIntervals),
  };
}

export function expectRuntimeV2ReadOnlyCollaboration(
  runtime: any,
  options: {
    readonly requireObservedChild?: boolean;
    readonly requireAdoptedChildEvidence?: boolean;
  } = {},
): void {
  const jobs = (Array.isArray(runtime?.subagents)
    ? runtime.subagents
    : []) as RuntimeV2SubagentSnapshot[];
  const events = Array.isArray(runtime?.events) ? runtime.events : [];
  if (options.requireObservedChild) {
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const successfulCompletions = events.filter((event: any) =>
      event.type === "subagent.completed" &&
      event.status === "completed" &&
      !!event.report
    );
    expect(
      successfulCompletions.length,
      `Expected a successful evidence-linked child completion; observed ${JSON.stringify(
        jobs.map((job) => ({
          id: job.id,
          status: job.status,
          reportSubmitted: job.reportSubmitted,
        })),
      )}`,
    ).toBeGreaterThanOrEqual(1);
    expect(successfulCompletions.every((event: any) =>
      jobs.some((job) =>
        job.id === event.jobId &&
        job.status === "completed" &&
        job.reportSubmitted === true
      )
    )).toBe(true);
  }
  expect(jobs.every((job) =>
    ["completed", "degraded", "failed", "canceled"].includes(String(job.status || "")) &&
    String(job.sourceToolCallId || "").trim().length > 0 &&
    job.parentRunId === runtime?.runId &&
    String(job.scopeKey || "").trim().length > 0 &&
    ["explore", "review", "validate"].includes(
      String(job.taskKind || ""),
    ) &&
    job.accessMode === "read" &&
    String(job.objective || "").trim().length > 0 &&
    Array.isArray(job.allowedPaths) &&
    job.allowedPaths.length > 0 &&
    Number.isFinite(job.requestOpenedAt) &&
    Number.isFinite(job.closedAt) &&
    Number(job.requestOpenedAt) <= Number(job.closedAt) &&
    ["planning", "observing", "acting", "validating", "finalizing"].includes(
      String(job.startedInPhase || ""),
    ) &&
    (
      job.status !== "completed" ||
      job.reportSubmitted === true
    ) &&
    (
      job.firstTokenAt == null ||
      (
        Number.isFinite(job.firstTokenAt) &&
        Number(job.requestOpenedAt) <= Number(job.firstTokenAt) &&
        Number(job.firstTokenAt) <= Number(job.closedAt)
      )
    )
  )).toBe(true);

  expect(runtime?.subagentConcurrency).toMatchObject({
    requestCount: jobs.length,
  });
  expect(runtime.subagentConcurrency.peakInFlight).toBeGreaterThanOrEqual(
    jobs.length > 0 ? 1 : 0,
  );
  if (jobs.length > 1 && runtime.subagentConcurrency.hasRequestOverlap) {
    expect(Math.max(
      ...jobs.map((job) => Number(job.requestOpenedAt)),
    )).toBeLessThan(Math.min(
      ...jobs.map((job) => Number(job.closedAt)),
    ));
  }

  const commands = Array.isArray(runtime?.commands) ? runtime.commands : [];
  const sealedEvent = events.find(
    (event: { type?: string }) => event.type === "work_plan.sealed",
  );
  const sealedSequence = Number(
    sealedEvent?.sequence || Number.POSITIVE_INFINITY,
  );
  const sealedEvidenceIds = new Set(
    (runtime?.sealedWorkPlan?.evidence || []).map(
      (entry: { id?: string }) => String(entry.id || ""),
    ),
  );
  const executableStepBasis = new Set(
    (runtime?.sealedWorkPlan?.draft?.steps || []).flatMap((step: any) =>
      step?.operation === "preserve" ? [] : step?.basis || []
    ),
  );
  const structuredPlanBasis = new Set([
    ...(runtime?.sealedWorkPlan?.draft?.findings || []).flatMap(
      (finding: any) => finding?.basis || [],
    ),
    ...(runtime?.sealedWorkPlan?.draft?.steps || []).flatMap(
      (step: any) => step?.basis || [],
    ),
  ]);
  const appliedChildEvidenceIds: string[] = [];
  for (const job of jobs) {
    const scheduledEvent = events.find((event: any) =>
      event.type === "subagents.scheduled" &&
      (event.jobs || []).some((entry: { id?: string }) => entry.id === job.id)
    );
    const scheduleCommand = commands.find((command: any) =>
      command.kind === "schedule_subagents" &&
      command.sourceToolCallId === job.sourceToolCallId
    );
    const joinCommand = commands.find((command: any) =>
      command.kind === "join_subagents" &&
      (command.jobIds || []).includes(job.id)
    );
    const completedEvent = events.find((event: any) =>
      event.type === "subagent.completed" && event.jobId === job.id
    );
    const deliveredEvent = events.find((event: any) =>
      event.type === "subagent.handoff_delivered" && event.jobId === job.id
    );
    const appliedEvents = events.filter((event: any) =>
      event.type === "subagent.handoff_applied" && event.jobId === job.id
    );

    expect(scheduledEvent).toBeTruthy();
    expect(scheduleCommand).toMatchObject({ status: "succeeded" });
    expect(joinCommand).toMatchObject({ status: "succeeded" });
    expect(completedEvent).toBeTruthy();
    expect(Number(completedEvent?.sequence || 0)).toBeLessThan(sealedSequence);
    if (job.status === "completed") {
      expect(appliedEvents).toHaveLength(1);
      const appliedEvent = appliedEvents[0];
      expect(deliveredEvent).toBeTruthy();
      expect(Number(deliveredEvent?.sequence || 0))
        .toBeLessThan(sealedSequence);
      expect(sealedSequence)
        .toBeLessThan(Number(appliedEvent?.sequence || 0));
      expect(appliedEvent?.handoffSource).toBe("work_plan");
      expect(appliedEvent?.sourceEventId).toBe(sealedEvent?.eventId);
      expect((appliedEvent?.evidenceIds || []).length).toBeGreaterThan(0);
      expect((appliedEvent?.evidenceIds || []).every(
        (id: string) => sealedEvidenceIds.has(id),
      )).toBe(true);
      expect((appliedEvent?.evidenceIds || []).every(
        (id: string) => structuredPlanBasis.has(id),
      )).toBe(true);
      appliedChildEvidenceIds.push(...(appliedEvent?.evidenceIds || []));
    }
  }

  if (options.requireAdoptedChildEvidence) {
    expect(
      appliedChildEvidenceIds.some((id) => executableStepBasis.has(id)),
      "At least one applied child evidence ID must be adopted by an executable WorkPlan step basis.",
    ).toBe(true);
  }

  if (options.requireObservedChild) {
    const diagnostics = runtimeV2CollaborationDiagnostics(runtime);
    expect(
      diagnostics.modelLaneOverlapObserved,
      [
        diagnostics.modelLaneOverlapObserved === null
          ? "No current-Turn model_lane_admission telemetry was projected."
          : "Model-lane telemetry did not prove an admitted parent/child overlap.",
        `Parent evidence progress during the child request: ${diagnostics.parentEvidenceProgressOverlapMs}ms.`,
      ].join(" "),
    ).toBe(true);

    const planProviderRequests = (runtime?.debug || []).filter(
      (entry: { source?: string }) =>
        entry.source === "store.runtime_v2_plan_provider_request_opened",
    );
    expect(planProviderRequests.some((entry: { data?: any }) =>
      boundedDebugNames(entry.data?.offeredToolNames)
        .includes("spawn_subagent")
    )).toBe(true);
  }

  const milestones = runtime?.presentation?.chatMilestones || [];
  expect(milestones.some((entry: { markdown?: string }) =>
    /### (?:已启动并行只读调查|并行只读调查已汇合|当前阶段：)/.test(
      String(entry.markdown || ""),
    )
  )).toBe(false);
}
