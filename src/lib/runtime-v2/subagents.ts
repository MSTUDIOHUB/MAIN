import type {
  RuntimeV2RunIdentity,
  RuntimeV2SubagentJob,
  RuntimeV2SubagentTelemetry,
} from "./contracts";

export const MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS = 2;

export interface RuntimeV2SubagentScopeCandidate {
  readonly scopeKey: string;
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
 * Materialize at most two genuinely independent, frozen read-only scopes from
 * provider-authored spawn_subagent calls. Runtime validates identity,
 * capacity and path isolation; it never invents a task name or objective.
 */
export function scheduleReadOnlySubagents(input: {
  readonly parentRun: RuntimeV2RunIdentity;
  readonly candidates: readonly RuntimeV2SubagentScopeCandidate[];
  readonly existingJobs?: readonly RuntimeV2SubagentJob[];
  readonly requestedAt: number;
  readonly nextId: (scope: string) => string;
}): RuntimeV2SubagentScheduleDecision {
  const jobs: RuntimeV2SubagentJob[] = [];
  const rejectedScopeKeys: string[] = [];
  const existingJobs = input.existingJobs || [];
  const seenScopeKeys = new Set(existingJobs.map((job) => job.scopeKey));
  for (const candidate of input.candidates) {
    const scopeKey = text(candidate.scopeKey, 256);
    const objective = text(candidate.objective, 2_000);
    const allowedPaths = [...new Set((candidate.allowedPaths || []).map(normalizedPath).filter(Boolean))].slice(0, 24);
    if (!scopeKey || !objective || allowedPaths.length === 0 || seenScopeKeys.has(scopeKey)) {
      if (scopeKey) rejectedScopeKeys.push(scopeKey);
      continue;
    }
    seenScopeKeys.add(scopeKey);
    if (
      existingJobs.length + jobs.length >= MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS ||
      [...existingJobs, ...jobs].some((job) =>
        !areReadOnlySubagentScopesDisjoint(job.allowedPaths, allowedPaths)
      )
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
