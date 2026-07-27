import { expect } from "@playwright/test";

type RuntimeV2SubagentSnapshot = {
  scopeKey?: string;
  status?: string;
  allowedPaths?: string[];
  requestOpenedAt?: number;
  firstTokenAt?: number | null;
  closedAt?: number;
};

export function expectRuntimeV2ReadOnlyCollaboration(
  runtime: any,
  expectedScopeKeys: readonly string[] = [],
): void {
  const jobs = (Array.isArray(runtime?.subagents)
    ? runtime.subagents
    : []) as RuntimeV2SubagentSnapshot[];
  expect(jobs).toHaveLength(2);
  if (expectedScopeKeys.length > 0) {
    expect(jobs.map((job) => String(job.scopeKey || "")).sort())
      .toEqual([...expectedScopeKeys].sort());
  }
  expect(jobs.every((job) =>
    ["completed", "failed", "canceled"].includes(String(job.status || "")) &&
    Array.isArray(job.allowedPaths) &&
    job.allowedPaths.length > 0 &&
    Number.isFinite(job.requestOpenedAt) &&
    Number.isFinite(job.closedAt) &&
    Number(job.requestOpenedAt) <= Number(job.closedAt) &&
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
    requestCount: 2,
    hasRequestOverlap: true,
  });
  expect(runtime.subagentConcurrency.peakInFlight).toBeGreaterThanOrEqual(2);
  expect(Math.max(
    ...jobs.map((job) => Number(job.requestOpenedAt)),
  )).toBeLessThan(Math.min(
    ...jobs.map((job) => Number(job.closedAt)),
  ));

  const joinedBatchDebug = (runtime?.debug || []).filter(
    (entry: { source?: string }) =>
      entry.source === "store.runtime_v2_subagent_batch_joined",
  );
  expect(joinedBatchDebug).toHaveLength(1);
  expect(joinedBatchDebug[0]?.data).toMatchObject({
    jobCount: 2,
    peakInFlight: expect.any(Number),
    hasRequestOverlap: true,
  });

  const milestones = runtime?.presentation?.chatMilestones || [];
  const allocationMilestones = milestones.filter((entry: { markdown?: string }) =>
    /### 已启动并行只读调查/.test(String(entry.markdown || ""))
  );
  const joinedMilestones = milestones.filter((entry: { markdown?: string }) =>
    /### 并行只读调查已汇合/.test(String(entry.markdown || ""))
  );
  expect(allocationMilestones).toHaveLength(1);
  expect(joinedMilestones).toHaveLength(1);
  for (const job of jobs) {
    expect(allocationMilestones[0]?.markdown)
      .toContain(String(job.scopeKey || ""));
  }
}
