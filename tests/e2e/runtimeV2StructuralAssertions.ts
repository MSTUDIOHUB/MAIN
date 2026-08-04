import { expect } from "@playwright/test";

type RuntimeV2SubagentSnapshot = {
  scopeKey?: string;
  sourceToolCallId?: string;
  name?: string;
  role?: string;
  taskKind?: string;
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

export function expectRuntimeV2ReadOnlyCollaboration(
  runtime: any,
  options: { readonly requireObservedChild?: boolean } = {},
): void {
  const jobs = (Array.isArray(runtime?.subagents)
    ? runtime.subagents
    : []) as RuntimeV2SubagentSnapshot[];
  if (options.requireObservedChild) {
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  }
  expect(jobs.every((job) =>
    ["completed", "failed", "canceled"].includes(String(job.status || "")) &&
    String(job.sourceToolCallId || "").trim().length > 0 &&
    String(job.scopeKey || "").trim().length > 0 &&
    String(job.name || "").trim().length > 0 &&
    String(job.role || "").trim().length > 0 &&
    ["explore", "review", "validate"].includes(
      String(job.taskKind || ""),
    ) &&
    String(job.objective || "").trim().length > 0 &&
    String(job.successCriteria || "").trim().length > 0 &&
    Array.isArray(job.allowedPaths) &&
    job.allowedPaths.length > 0 &&
    Number.isFinite(job.requestOpenedAt) &&
    Number.isFinite(job.closedAt) &&
    Number(job.requestOpenedAt) <= Number(job.closedAt) &&
    ["observing", "acting", "validating", "finalizing"].includes(
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
  expect(runtime.subagentConcurrency.peakInFlight).toBeLessThanOrEqual(2);
  if (jobs.length > 1 && runtime.subagentConcurrency.hasRequestOverlap) {
    expect(Math.max(
      ...jobs.map((job) => Number(job.requestOpenedAt)),
    )).toBeLessThan(Math.min(
      ...jobs.map((job) => Number(job.closedAt)),
    ));
  }

  const joinedBatchDebug = (runtime?.debug || []).filter(
    (entry: { source?: string }) =>
      entry.source === "store.runtime_v2_subagent_batch_joined",
  );
  expect(joinedBatchDebug.length).toBeGreaterThanOrEqual(
    jobs.length > 0 ? 1 : 0,
  );
  expect(joinedBatchDebug.every((entry: { data?: any }) =>
    Number(entry.data?.jobCount || 0) >= 1 &&
    Number(entry.data?.peakInFlight || 0) >= 1
  )).toBe(true);

  const milestones = runtime?.presentation?.chatMilestones || [];
  expect(milestones.some((entry: { markdown?: string }) =>
    /### (?:已启动并行只读调查|并行只读调查已汇合|当前阶段：)/.test(
      String(entry.markdown || ""),
    )
  )).toBe(false);
}
