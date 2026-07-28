import type { TurnAggregateV1 } from "./aggregate";
import type {
  RuntimeV2EvidenceReference,
  RuntimeV2RunIdentity,
  RuntimeV2SubagentJob,
} from "./contracts";
import type { RuntimeV2Event } from "./events";
import { validateRuntimeV2ExecutionContract } from "./executionContract";
import { workspacePathsReferToSameFile } from "../workspacePaths";

export function hasNovelRuntimeV2Evidence(
  existing: readonly RuntimeV2EvidenceReference[],
  incoming: readonly RuntimeV2EvidenceReference[],
): boolean {
  const known = new Set(existing.map((item) =>
    `${item.id}\u0000${item.target}\u0000${item.version || ""}`
  ));
  return incoming.some((item) =>
    !known.has(`${item.id}\u0000${item.target}\u0000${item.version || ""}`)
  );
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
    job.status === "queued" &&
    job.firstTokenAt === null &&
    job.closedAt === null &&
    job.summary === null;
}

export function isValidRuntimeV2ExecutionContractCommit(input: {
  readonly state: TurnAggregateV1;
  readonly event: Extract<
    RuntimeV2Event,
    { readonly type: "execution_contract.committed" }
  >;
}): boolean {
  const { state, event } = input;
  if (
    state.strategy !== "execute" ||
    (state.phase !== "observing" && state.phase !== "acting") ||
    !validateRuntimeV2ExecutionContract({
      contract: event.contract,
      objective: state.objective,
      evidence: state.evidence,
      previous: state.executionContract,
    })
  ) {
    return false;
  }
  const hasCommittedMutation = state.evidence.some(
    (evidence) => evidence.kind === "mutation",
  );
  if (hasCommittedMutation && !state.executionContract) {
    return false;
  }
  if (!state.executionContract) return true;
  // Before the first mutation the model may freely refine scope. Once a
  // mutation exists, every revision must be grounded in source evidence
  // collected after the previous contract commit; a new target needs its own
  // newly cited basis rather than borrowing an unrelated refresh.
  if (!hasCommittedMutation) return true;
  const previousCommitIndex = state.events.findIndex(
    (candidate) =>
      candidate.type === "execution_contract.committed" &&
      candidate.contract.id === state.executionContract!.id &&
      candidate.contract.revision ===
        state.executionContract!.revision,
  );
  const postCommitSources = new Map(
    state.events.slice(previousCommitIndex + 1).flatMap((candidate) => {
      if (
        candidate.type === "observation.recorded" &&
        candidate.evidence.kind === "source" &&
        !!candidate.evidence.version
      ) {
        return [[
          candidate.evidence.id,
          candidate.evidence.target,
        ] as const];
      }
      if (candidate.type === "tool.completed") {
        return candidate.evidence.filter((evidence) =>
          evidence.kind === "source" && !!evidence.version
        ).map((evidence) => [evidence.id, evidence.target] as const);
      }
      return [];
    }),
  );
  const newTargets = event.contract.changes.filter((change) =>
    !state.executionContract!.changes.some((previous) =>
      previous.operation === change.operation &&
      previous.target === change.target
    )
  );
  const changesNeedingFreshBasis =
    newTargets.length > 0 ? newTargets : event.contract.changes;
  return changesNeedingFreshBasis.every((change) =>
    change.basisEvidenceIds.some((id) => {
      const evidenceTarget = postCommitSources.get(id);
      return !!evidenceTarget &&
        (
          change.operation === "create" ||
          workspacePathsReferToSameFile(evidenceTarget, change.target)
        );
    })
  );
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
