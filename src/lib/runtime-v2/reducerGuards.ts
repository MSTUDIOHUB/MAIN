import type { TurnAggregateV1 } from "./aggregate";
import type {
  RuntimeV2EvidenceReference,
  RuntimeV2RunIdentity,
  RuntimeV2SubagentJob,
} from "./contracts";
import type { RuntimeV2Event } from "./events";
import { validateRuntimeV2SubagentReport } from "./subagentReport";

export function appendNovelRuntimeV2Evidence(
  existing: readonly RuntimeV2EvidenceReference[],
  additions: readonly RuntimeV2EvidenceReference[],
): readonly RuntimeV2EvidenceReference[] {
  const next = [...existing];
  const known = new Set(existing.map((item) =>
    `${item.id}\u0000${item.target}\u0000${item.version || ""}`
  ));
  for (const evidence of additions) {
    const key =
      `${evidence.id}\u0000${evidence.target}\u0000${evidence.version || ""}`;
    if (known.has(key)) continue;
    known.add(key);
    next.push(evidence);
  }
  return next;
}

export function isValidRuntimeV2SubagentCompletion(input: {
  readonly state: TurnAggregateV1;
  readonly event: Extract<
    RuntimeV2Event,
    { readonly type: "subagent.completed" }
  >;
  readonly job: RuntimeV2SubagentJob;
}): boolean {
  const inheritedEvidence = input.event.inheritedEvidence || [];
  const known = new Map(input.state.evidence.map((item) => [item.id, item]));
  const inheritedIsKnown = inheritedEvidence.every((item) => {
    const candidate = known.get(item.id);
    return candidate?.kind === item.kind &&
      candidate.target === item.target &&
      candidate.version === item.version;
  });
  const mutationEvidence = input.event.evidence.filter((item) =>
    item.kind === "mutation"
  );
  const writeJob = input.job.taskKind === "implement" &&
    input.job.accessMode === "write";
  const mutationScopeValid = mutationEvidence.every((item) =>
    input.job.allowedPaths.some((path) =>
      item.target === path || item.target.startsWith(`${path.replace(/\/$/, "")}/`)
    )
  );
  return inheritedIsKnown &&
    mutationScopeValid &&
    (writeJob || mutationEvidence.length === 0) &&
    (
      input.event.status !== "completed" ||
      !writeJob ||
      mutationEvidence.length > 0
    ) &&
    (
      input.event.status !== "completed" ||
      validateRuntimeV2SubagentReport({
        report: input.event.report,
        evidence: input.event.evidence,
        inheritedEvidence,
      })
    ) &&
    (input.event.status !== "degraded" || input.event.evidence.length > 0);
}

export function isValidRuntimeV2SubagentJob(
  job: RuntimeV2SubagentJob,
  parent: RuntimeV2RunIdentity,
): boolean {
  return !!job.id &&
    job.parentRunId === parent.runId &&
    job.run.parentRunId === parent.runId &&
    job.run.sessionKey === parent.sessionKey &&
    job.run.sessionEpoch === parent.sessionEpoch &&
    job.run.turnId === parent.turnId &&
    !!job.scopeKey &&
    !!job.objective &&
    job.allowedPaths.length > 0 &&
    (
      job.taskKind === "implement"
        ? job.accessMode === "write" &&
          !!job.implementationOperation &&
          !!job.implementationPlan &&
          !job.allowedPaths.includes(".")
        : (job.accessMode || "read") === "read"
    ) &&
    job.status === "queued" &&
    job.firstTokenAt === null &&
    job.closedAt === null &&
    job.summary === null;
}

export function hasMatchingRuntimeV2SealedPlanAuthority(input: {
  readonly event: Extract<
    RuntimeV2Event,
    { readonly type: "work_plan.sealed" }
  >;
  readonly state: TurnAggregateV1;
}): boolean {
  const { event, state } = input;
  const plan = event.sealedPlan;
  const commit = event.reviewCommit;
  return plan.status === "pending_review" &&
    event.workPlan.id === plan.id &&
    event.workPlan.revision === plan.revision &&
    event.workPlan.digest === plan.digest &&
    event.workPlan.projectionHash === plan.projectionHash &&
    commit.schemaVersion === "runtime-v2-plan-review-commit.v1" &&
    commit.authority.id === plan.id &&
    commit.authority.revision === plan.revision &&
    commit.authority.digest === plan.digest &&
    commit.authority.projectionHash === plan.projectionHash &&
    commit.artifact.path === ".MAIN/plans/plan.md" &&
    commit.artifact.content === plan.markdown &&
    commit.artifact.projectionHash === plan.projectionHash &&
    commit.panel.markdown === plan.markdown &&
    commit.review.requestId.trim().length > 0 &&
    commit.review.sessionKey === state.turn.sessionKey &&
    commit.review.sessionEpoch === state.turn.sessionEpoch &&
    commit.review.turnId === state.turn.turnId &&
    commit.review.runId === event.run.runId &&
    commit.review.parentRunId === event.run.parentRunId;
}
