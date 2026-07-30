import type {
  RuntimeV2RunIdentity,
  RuntimeV2SubagentJob,
  RuntimeV2SubagentTelemetry,
} from "./contracts";

// A new child needs enough of the shared lifecycle to collect one independent
// fact, submit its structured report, and still leave the parent a useful
// takeover window. Near-deadline delegation only steals time from the writer.
export const RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS = 2 * 60_000;

export interface RuntimeV2SubagentScopeCandidate {
  readonly scopeKey: string;
  readonly taskKind?: "explore" | "review" | "validate";
  readonly sourceToolCallId?: string;
  readonly name?: string;
  readonly role?: string;
  readonly objective: string;
  readonly successCriteria?: string;
  readonly expectedOutput?: string;
  readonly allowedPaths: readonly string[];
}

export interface RuntimeV2SubagentScheduleDecision {
  readonly jobs: readonly RuntimeV2SubagentJob[];
  readonly rejectedScopeKeys: readonly string[];
}

export interface RuntimeV2SubagentConcurrency {
  readonly inFlight: number;
  readonly peakInFlight: number;
  readonly hasRequestOverlap: boolean;
}

function text(value: unknown, max = 1_024): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizedPath(value: string): string {
  return text(value).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function normalizedSemanticText(value: unknown, max: number): string {
  return text(value, max).replace(/\s+/g, " ").toLowerCase();
}

export function runtimeV2SubagentModelHandle(
  job: Pick<RuntimeV2SubagentJob, "id" | "scopeKey">,
): string {
  return text(job.scopeKey, 256) || text(job.id, 256);
}

export function runtimeV2SubagentSemanticIdentity(input: {
  readonly taskKind?: "explore" | "review" | "validate";
  readonly name?: string;
  readonly role?: string;
  readonly objective: string;
  readonly successCriteria?: string;
  readonly allowedPaths: readonly string[];
}): string {
  return JSON.stringify([
    input.taskKind || "explore",
    normalizedSemanticText(input.name, 128),
    normalizedSemanticText(input.role, 128),
    normalizedSemanticText(input.objective, 2_000),
    normalizedSemanticText(input.successCriteria, 1_000),
    [...new Set(input.allowedPaths.map(normalizedPath).filter(Boolean))]
      .sort(),
  ]);
}

export function resolveRuntimeV2SubagentReferences(input: {
  readonly jobs: readonly RuntimeV2SubagentJob[];
  readonly requested: readonly string[];
}): {
  readonly jobIds: readonly string[];
  readonly unresolved: readonly string[];
} {
  const active = input.jobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  );
  const jobIds: string[] = [];
  const unresolved: string[] = [];
  for (const raw of input.requested) {
    const reference = text(raw, 256);
    if (!reference) continue;
    const exact = active.filter((job) =>
      job.id === reference ||
      runtimeV2SubagentModelHandle(job) === reference
    );
    const segment = exact.length > 0
      ? exact
      : active.filter((job) => job.id.split(":").includes(reference));
    if (segment.length !== 1) {
      unresolved.push(reference);
      continue;
    }
    if (!jobIds.includes(segment[0]!.id)) jobIds.push(segment[0]!.id);
  }
  return { jobIds, unresolved };
}

export function runtimeV2SubagentFailureSummary(input: {
  readonly canceled: boolean;
  readonly deadlineExceeded: boolean;
  readonly evidence: readonly { readonly target: string }[];
}): string {
  const targets = [...new Set(
    input.evidence.map((evidence) => text(evidence.target, 256))
      .filter(Boolean),
  )].slice(0, 8);
  const retained = input.evidence.length > 0
    ? `已保留 ${input.evidence.length} 条只读证据供父任务接管${
        targets.length > 0 ? `（${targets.join("、")}）` : ""
      }。`
    : "没有形成可交接的只读证据。";
  if (input.canceled) {
    return `子任务已因父任务取消而停止；没有提交可确认的结构化报告。${retained}`;
  }
  if (input.evidence.length > 0) {
    return `${
      input.deadlineExceeded
        ? "子任务在生命周期截止前"
        : "子任务在收口前"
    }未提交引用真实证据的结构化报告；已降级由父任务接管。${retained}`;
  }
  return `${
    input.deadlineExceeded
      ? "子任务在生命周期截止前"
      : "子任务失败前"
  }未提交引用真实证据的结构化报告。${retained}`;
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  if (!a || !b) return true;
  if (a === "." || b === ".") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function areReadOnlySubagentScopesDisjoint(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftPaths = left.map(normalizedPath).filter(Boolean);
  const rightPaths = right.map(normalizedPath).filter(Boolean);
  if (leftPaths.length === 0 || rightPaths.length === 0) return false;
  return !leftPaths.some((leftPath) => rightPaths.some((rightPath) => pathsOverlap(leftPath, rightPath)));
}

/**
 * Materialize frozen read-only jobs from provider-authored spawn_subagent
 * calls within the capacity admitted by the provider lane. Completed jobs
 * release capacity. Read-only jobs may intentionally overlap paths because
 * the parent is the only writer; semantic task identity still prevents
 * accidental duplicate delegation.
 */
export function scheduleReadOnlySubagents(input: {
  readonly parentRun: RuntimeV2RunIdentity;
  readonly candidates: readonly RuntimeV2SubagentScopeCandidate[];
  readonly existingJobs?: readonly RuntimeV2SubagentJob[];
  readonly maxActiveJobs: number;
  readonly requestedAt: number;
  readonly nextId: (scope: string) => string;
}): RuntimeV2SubagentScheduleDecision {
  const jobs: RuntimeV2SubagentJob[] = [];
  const rejectedScopeKeys: string[] = [];
  const existingJobs = input.existingJobs || [];
  const seenScopeKeys = new Set(existingJobs.map((job) => job.scopeKey));
  const seenSemanticIdentities = new Set(
    existingJobs.map(runtimeV2SubagentSemanticIdentity),
  );
  const activeExistingJobs = existingJobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  );
  const maxActiveJobs = Math.max(
    0,
    Math.floor(Number(input.maxActiveJobs) || 0),
  );
  for (const candidate of input.candidates) {
    const scopeKey = text(candidate.scopeKey, 256);
    const objective = text(candidate.objective, 2_000);
    const allowedPaths = [...new Set((candidate.allowedPaths || []).map(normalizedPath).filter(Boolean))].slice(0, 24);
    const semanticIdentity = runtimeV2SubagentSemanticIdentity({
      ...candidate,
      objective,
      allowedPaths,
    });
    if (
      !scopeKey ||
      !objective ||
      allowedPaths.length === 0 ||
      seenScopeKeys.has(scopeKey) ||
      seenSemanticIdentities.has(semanticIdentity)
    ) {
      if (scopeKey) rejectedScopeKeys.push(scopeKey);
      continue;
    }
    seenScopeKeys.add(scopeKey);
    seenSemanticIdentities.add(semanticIdentity);
    if (
      activeExistingJobs.length + jobs.length >=
        maxActiveJobs
    ) {
      rejectedScopeKeys.push(scopeKey);
      continue;
    }
    const id = text(input.nextId("runtime-v2-child"), 256);
    if (!id) throw new Error("Runtime v2 scheduler must provide a child job id.");
    jobs.push({
      id,
      run: {
        sessionKey: input.parentRun.sessionKey,
        sessionEpoch: input.parentRun.sessionEpoch,
        turnId: input.parentRun.turnId,
        runId: `${input.parentRun.runId}:child:${id}`,
        parentRunId: input.parentRun.runId,
        attemptId: `${input.parentRun.attemptId}:child:${id}`,
      },
      parentRunId: input.parentRun.runId,
      ...(text(candidate.sourceToolCallId, 256)
        ? { sourceToolCallId: text(candidate.sourceToolCallId, 256) }
        : {}),
      scopeKey,
      taskKind: candidate.taskKind || "explore",
      ...(text(candidate.name, 128)
        ? { name: text(candidate.name, 128) }
        : {}),
      ...(text(candidate.role, 128)
        ? { role: text(candidate.role, 128) }
        : {}),
      objective,
      ...(text(candidate.successCriteria, 1_000)
        ? { successCriteria: text(candidate.successCriteria, 1_000) }
        : {}),
      ...(text(candidate.expectedOutput, 1_000)
        ? { expectedOutput: text(candidate.expectedOutput, 1_000) }
        : {}),
      allowedPaths,
      status: "queued",
      requestedAt: input.requestedAt,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
      report: null,
    });
  }
  return { jobs, rejectedScopeKeys };
}

export function applyRuntimeV2SubagentTelemetry(
  job: RuntimeV2SubagentJob,
  telemetry: RuntimeV2SubagentTelemetry,
): RuntimeV2SubagentJob | null {
  if (job.id !== telemetry.jobId || telemetry.at < job.requestedAt) return null;
  if (telemetry.phase === "request_opened") {
    if (job.status !== "queued") return null;
    return { ...job, status: "running" };
  }
  if (telemetry.phase === "first_token") {
    if (job.status !== "running" || job.firstTokenAt !== null) return null;
    return { ...job, firstTokenAt: telemetry.at };
  }
  if (job.status !== "running" || job.closedAt !== null) return null;
  return { ...job, closedAt: telemetry.at };
}

/** Derive actual request overlap from durable child telemetry, not an intent. */
export function deriveRuntimeV2SubagentConcurrency(
  jobs: readonly RuntimeV2SubagentJob[],
): RuntimeV2SubagentConcurrency {
  const intervals = jobs
    .filter((job) => job.status !== "queued")
    .map((job) => ({
      start: job.requestedAt,
      end: job.closedAt ?? Number.POSITIVE_INFINITY,
    }))
    .filter((interval) => Number.isFinite(interval.start) && interval.end >= interval.start);
  const points: Array<{ at: number; delta: number }> = [];
  for (const interval of intervals) {
    points.push({ at: interval.start, delta: 1 });
    if (Number.isFinite(interval.end)) points.push({ at: interval.end, delta: -1 });
  }
  // Closes sort before opens at the same timestamp: a handoff at one instant
  // is not counted as an overlap.
  points.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let peak = 0;
  for (const point of points) {
    current += point.delta;
    peak = Math.max(peak, current);
  }
  return {
    inFlight: intervals.filter((interval) => !Number.isFinite(interval.end)).length,
    peakInFlight: peak,
    hasRequestOverlap: peak >= 2,
  };
}
