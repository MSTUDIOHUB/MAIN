import {
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  type CheckpointPort,
  type RuntimeV2CheckpointV3,
  type RuntimeV2Event,
} from "../../lib/runtime-v2";
import type {
  PlanReviewActionRequest,
  PlanReviewResolutionIdentity,
} from "../../lib/actionRequest";
import {
  resolveRuntimeV2PlanReviewFromAggregate,
  validateRuntimeV2PlanReviewBinding,
} from "./workPlanAdapter";

export type RuntimeV2PlanApprovalFailure =
  | "runtime_v2_plan_review_missing"
  | "runtime_v2_plan_review_not_pending"
  | "runtime_v2_plan_request_mismatch"
  | "runtime_v2_plan_expected_identity_mismatch"
  | "runtime_v2_plan_binding_invalid"
  | "runtime_v2_plan_already_approved"
  | "runtime_v2_plan_checkpoint_conflict";

export type RuntimeV2PlanApprovalResult =
  | {
      readonly ok: true;
      readonly checkpoint: RuntimeV2CheckpointV3;
    }
  | {
      readonly ok: false;
      readonly reason: RuntimeV2PlanApprovalFailure;
      readonly detail?: string;
    };

function sameExpectedIdentity(
  request: PlanReviewActionRequest,
  expected: PlanReviewResolutionIdentity | null | undefined,
): boolean {
  return !expected || (
    expected.requestId === request.requestId &&
    expected.sessionKey === request.sessionKey &&
    (expected.sessionEpoch || null) === (request.sessionEpoch || null) &&
    expected.turnId === request.turnId &&
    expected.runId === request.runId &&
    (expected.parentRunId || null) === (request.parentRunId || null) &&
    expected.planRevision === request.planRevision &&
    expected.artifactHash === request.artifactHash
  );
}

/**
 * Append approval only after the exact pending request and all durable owner
 * and WorkPlan authority fields agree. No PlanArtifact or Markdown content is
 * consulted at this boundary.
 */
export async function approveRuntimeV2PlanReviewCheckpoint(input: {
  readonly checkpoint: RuntimeV2CheckpointV3;
  readonly port: CheckpointPort;
  readonly request: PlanReviewActionRequest | null | undefined;
  readonly expected?: PlanReviewResolutionIdentity | null;
  readonly now: number;
  readonly eventId: string;
}): Promise<RuntimeV2PlanApprovalResult> {
  const resolved = resolveRuntimeV2PlanReviewFromAggregate(input.checkpoint.aggregate);
  if (!resolved) return { ok: false, reason: "runtime_v2_plan_review_missing" };
  if (!resolved.pending) return { ok: false, reason: "runtime_v2_plan_review_not_pending" };
  const request = input.request;
  if (!request || request.kind !== "plan_review" || request.status !== "pending") {
    return { ok: false, reason: "runtime_v2_plan_request_mismatch" };
  }
  const commit = resolved.commit;
  if (
    request.requestId !== commit.review.requestId ||
    request.sessionKey !== commit.review.sessionKey ||
    request.sessionEpoch !== commit.review.sessionEpoch ||
    request.turnId !== commit.review.turnId ||
    request.runId !== commit.review.runId ||
    (request.parentRunId || null) !== commit.review.parentRunId ||
    request.planRevision !== commit.authority.revision ||
    request.artifactHash !== commit.authority.projectionHash ||
    request.artifactPaths.length !== 1 ||
    request.artifactPaths[0] !== commit.artifact.path
  ) {
    return { ok: false, reason: "runtime_v2_plan_request_mismatch" };
  }
  if (!sameExpectedIdentity(request, input.expected)) {
    return { ok: false, reason: "runtime_v2_plan_expected_identity_mismatch" };
  }
  const run = input.checkpoint.aggregate.run?.identity;
  if (!run) return { ok: false, reason: "runtime_v2_plan_binding_invalid" };
  const binding = validateRuntimeV2PlanReviewBinding({
    commit,
    currentPlan: resolved.plan,
    turn: input.checkpoint.owner,
    run,
    requestId: request.requestId,
  });
  if (!binding.ok) {
    return {
      ok: false,
      reason: "runtime_v2_plan_binding_invalid",
      detail: binding.reason,
    };
  }
  const event: RuntimeV2Event = {
    schemaVersion: RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: input.checkpoint.aggregate.nextSequence,
    eventId: input.eventId,
    at: Math.max(input.now, input.checkpoint.aggregate.updatedAt),
    type: "work_plan.approved",
    run,
    workPlan: {
      ...input.checkpoint.aggregate.workPlan!,
      status: "approved",
    },
  };
  const appended = await input.port.append({
    owner: input.checkpoint.owner,
    expectedRevision: input.checkpoint.revision,
    event,
  });
  if (appended.disposition === "idempotent") {
    return { ok: false, reason: "runtime_v2_plan_already_approved" };
  }
  if (appended.disposition === "conflict" || !appended.checkpoint) {
    return { ok: false, reason: "runtime_v2_plan_checkpoint_conflict" };
  }
  return { ok: true, checkpoint: appended.checkpoint };
}
