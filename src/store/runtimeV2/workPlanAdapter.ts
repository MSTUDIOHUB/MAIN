import type {
  RuntimeV2RunIdentity,
  RuntimeV2TurnIdentity,
  RuntimeV2WorkPlanReference,
} from "../../lib/runtime-v2/contracts";
import type { TurnAggregateV1 } from "../../lib/runtime-v2/aggregate";
import {
  RUNTIME_V2_PLAN_ARTIFACT_PATH,
  RUNTIME_V2_PLAN_REVIEW_COMMIT_SCHEMA_VERSION,
  sealWorkPlanV1,
  type RuntimeV2PlanArtifactProjection,
  type RuntimeV2PlanAuthority,
  type RuntimeV2PlanChatProjection,
  type RuntimeV2PlanPanelProjection,
  type RuntimeV2PlanReviewBinding,
  type RuntimeV2PlanReviewCommit,
  type SealedWorkPlanV1,
} from "../../lib/runtime-v2/workPlan";

export {
  RUNTIME_V2_PLAN_ARTIFACT_PATH,
  RUNTIME_V2_PLAN_REVIEW_COMMIT_SCHEMA_VERSION,
};
export type {
  RuntimeV2PlanArtifactProjection,
  RuntimeV2PlanAuthority,
  RuntimeV2PlanChatProjection,
  RuntimeV2PlanPanelProjection,
  RuntimeV2PlanReviewBinding,
  RuntimeV2PlanReviewCommit,
};

export type RuntimeV2PlanIntegrityResult =
  | { readonly ok: true; readonly authority: RuntimeV2PlanAuthority }
  | {
      readonly ok: false;
      readonly reason: RuntimeV2PlanIntegrityFailureReason;
    };

export type RuntimeV2PlanIntegrityFailureReason =
  | "work_plan_invalid"
  | "work_plan_digest_mismatch"
  | "work_plan_markdown_mismatch"
  | "work_plan_projection_hash_mismatch";

export type RuntimeV2PlanReviewValidationResult =
  | { readonly ok: true; readonly authority: RuntimeV2PlanAuthority }
  | {
      readonly ok: false;
      readonly reason:
        | RuntimeV2PlanIntegrityFailureReason
        | "plan_not_pending_review"
        | "plan_review_commit_schema_mismatch"
        | "plan_review_request_mismatch"
        | "plan_review_owner_mismatch"
        | "plan_review_identity_mismatch"
        | "plan_artifact_projection_mismatch"
        | "plan_panel_projection_mismatch"
        | "plan_chat_projection_mismatch";
    };

export interface RuntimeV2ResolvedPlanReview {
  readonly plan: SealedWorkPlanV1;
  readonly commit: RuntimeV2PlanReviewCommit;
  readonly pending: boolean;
}

export interface RuntimeV2ResolvedApprovedWorkPlan {
  readonly plan: SealedWorkPlanV1;
  readonly commit: RuntimeV2PlanReviewCommit;
}

function authorityFor(plan: SealedWorkPlanV1): RuntimeV2PlanAuthority {
  return {
    id: plan.id,
    revision: plan.revision,
    digest: plan.digest,
    projectionHash: plan.projectionHash,
  };
}

function sameAuthority(
  left: RuntimeV2PlanAuthority,
  right: RuntimeV2PlanAuthority,
): boolean {
  return left.id === right.id &&
    left.revision === right.revision &&
    left.digest === right.digest &&
    left.projectionHash === right.projectionHash;
}

function sameOwner(
  binding: RuntimeV2PlanReviewBinding,
  turn: RuntimeV2TurnIdentity,
  run: RuntimeV2RunIdentity,
): boolean {
  return binding.sessionKey === turn.sessionKey &&
    binding.sessionEpoch === turn.sessionEpoch &&
    binding.turnId === turn.turnId &&
    binding.runId === run.runId &&
    binding.parentRunId === run.parentRunId &&
    run.sessionKey === turn.sessionKey &&
    run.sessionEpoch === turn.sessionEpoch &&
    run.turnId === turn.turnId;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function requiredIdentity(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Runtime v2 Plan review requires ${field}.`);
  return normalized;
}

export function validateSealedWorkPlanV1Integrity(
  plan: SealedWorkPlanV1,
): RuntimeV2PlanIntegrityResult {
  let rebuilt: SealedWorkPlanV1;
  try {
    rebuilt = sealWorkPlanV1({
      draft: plan.draft,
      evidence: plan.evidence,
      revision: plan.revision,
      id: plan.id,
      createdAt: plan.createdAt,
      ...(plan.legacy ? { legacy: plan.legacy } : {}),
    });
  } catch {
    return { ok: false, reason: "work_plan_invalid" };
  }
  if (rebuilt.digest !== plan.digest) {
    return { ok: false, reason: "work_plan_digest_mismatch" };
  }
  if (rebuilt.markdown !== plan.markdown) {
    return { ok: false, reason: "work_plan_markdown_mismatch" };
  }
  if (rebuilt.projectionHash !== plan.projectionHash) {
    return { ok: false, reason: "work_plan_projection_hash_mismatch" };
  }
  return { ok: true, authority: authorityFor(plan) };
}

export function toRuntimeV2WorkPlanReference(
  plan: SealedWorkPlanV1,
  status: RuntimeV2WorkPlanReference["status"] = plan.status,
): RuntimeV2WorkPlanReference {
  return {
    ...authorityFor(plan),
    status,
  };
}

function buildPlanPanelProjection(
  plan: SealedWorkPlanV1,
  authority: RuntimeV2PlanAuthority,
): RuntimeV2PlanPanelProjection {
  return {
    audience: "plan_panel",
    status: "pending_review",
    authority,
    title: plan.draft.objective,
    markdown: plan.markdown,
    steps: plan.draft.steps.map((step, index) => ({
      id: `S${index + 1}`,
      title: step.title,
      operation: step.operation,
      targets: [...step.targets],
      expectedOutcome: step.expectedOutcome,
    })),
    validationCount: plan.draft.validations.length,
  };
}

function buildPlanChatProjection(
  plan: SealedWorkPlanV1,
  authority: RuntimeV2PlanAuthority,
): RuntimeV2PlanChatProjection {
  const narrativeLead = plan.draft.summary
    .replace(/\r\n?/g, "\n")
    .replace(/^#{1,6}\s+.*$/gm, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph
      .replace(/\s+/g, " ")
      .trim())
    .find(Boolean)
    ?.slice(0, 600) || plan.draft.objective;
  const stepLines = plan.draft.steps
    .slice(0, 4)
    .map((step, index) => `- S${index + 1} · ${step.title}`);
  const remaining = Math.max(0, plan.draft.steps.length - stepLines.length);
  return {
    audience: "chat_milestone",
    authority,
    markdown: [
      "### 修复计划已准备好",
      "",
      narrativeLead,
      "",
      ...stepLines,
      ...(remaining > 0 ? [`- 其余 ${remaining} 个步骤请在计划面板中查看。`] : []),
      "",
      `已绑定 ${plan.evidence.length} 条可信证据和 ${plan.draft.validations.length} 项验证；批准前不会修改项目。`,
    ].join("\n"),
    dedupeKey: `work-plan:${authority.id}:${authority.revision}:${authority.digest}:${authority.projectionHash}`,
  };
}

function buildReviewCommitUnchecked(input: {
  readonly plan: SealedWorkPlanV1;
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly requestId: string;
  readonly createdAt: number;
}): RuntimeV2PlanReviewCommit {
  const authority = authorityFor(input.plan);
  return {
    schemaVersion: RUNTIME_V2_PLAN_REVIEW_COMMIT_SCHEMA_VERSION,
    authority,
    artifact: {
      path: RUNTIME_V2_PLAN_ARTIFACT_PATH,
      content: input.plan.markdown,
      projectionHash: authority.projectionHash,
    },
    panel: buildPlanPanelProjection(input.plan, authority),
    chat: buildPlanChatProjection(input.plan, authority),
    review: {
      requestId: requiredIdentity(input.requestId, "requestId"),
      sessionKey: input.turn.sessionKey,
      sessionEpoch: input.turn.sessionEpoch,
      turnId: input.turn.turnId,
      runId: input.run.runId,
      parentRunId: input.run.parentRunId,
      authority,
      createdAt: Math.max(0, Math.floor(input.createdAt)),
    },
  };
}

export function createRuntimeV2PlanReviewCommit(input: {
  readonly plan: SealedWorkPlanV1;
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly requestId: string;
  readonly createdAt: number;
}): RuntimeV2PlanReviewCommit {
  const integrity = validateSealedWorkPlanV1Integrity(input.plan);
  if (integrity.ok === false) throw new Error(integrity.reason);
  if (input.plan.status !== "pending_review") {
    throw new Error("plan_not_pending_review");
  }
  requiredIdentity(input.turn.sessionKey, "turn.sessionKey");
  requiredIdentity(input.turn.sessionEpoch, "turn.sessionEpoch");
  requiredIdentity(input.turn.turnId, "turn.turnId");
  requiredIdentity(input.run.runId, "run.runId");
  if (
    input.run.sessionKey !== input.turn.sessionKey ||
    input.run.sessionEpoch !== input.turn.sessionEpoch ||
    input.run.turnId !== input.turn.turnId
  ) {
    throw new Error("plan_review_owner_mismatch");
  }
  return buildReviewCommitUnchecked(input);
}

function validateRuntimeV2PlanReviewCommitIntegrity(input: {
  readonly commit: RuntimeV2PlanReviewCommit;
  readonly currentPlan: SealedWorkPlanV1;
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
}): RuntimeV2PlanReviewValidationResult {
  if (input.commit.schemaVersion !== RUNTIME_V2_PLAN_REVIEW_COMMIT_SCHEMA_VERSION) {
    return { ok: false, reason: "plan_review_commit_schema_mismatch" };
  }
  const integrity = validateSealedWorkPlanV1Integrity(input.currentPlan);
  if (integrity.ok === false) return integrity;
  // sealedWorkPlan is the immutable snapshot committed at the review boundary.
  // Approval advances the aggregate reference to approved; it must not rewrite
  // this snapshot and thereby invalidate the digest/projection proof.
  if (input.currentPlan.status !== "pending_review") {
    return { ok: false, reason: "plan_not_pending_review" };
  }
  if (!sameOwner(input.commit.review, input.turn, input.run)) {
    return { ok: false, reason: "plan_review_owner_mismatch" };
  }
  if (
    !sameAuthority(input.commit.authority, integrity.authority) ||
    !sameAuthority(input.commit.review.authority, integrity.authority)
  ) {
    return { ok: false, reason: "plan_review_identity_mismatch" };
  }

  const expected = buildReviewCommitUnchecked({
    plan: input.currentPlan,
    turn: input.turn,
    run: input.run,
    requestId: input.commit.review.requestId,
    createdAt: input.commit.review.createdAt,
  });
  if (!sameJson(input.commit.artifact, expected.artifact)) {
    return { ok: false, reason: "plan_artifact_projection_mismatch" };
  }
  if (!sameJson(input.commit.panel, expected.panel)) {
    return { ok: false, reason: "plan_panel_projection_mismatch" };
  }
  if (!sameJson(input.commit.chat, expected.chat)) {
    return { ok: false, reason: "plan_chat_projection_mismatch" };
  }
  return { ok: true, authority: integrity.authority };
}

/**
 * Approval must call this against the current SealedWorkPlanV1 and current
 * owner. Matching request prose or matching plan.md bytes is insufficient.
 */
export function validateRuntimeV2PlanReviewBinding(input: {
  readonly commit: RuntimeV2PlanReviewCommit;
  readonly currentPlan: SealedWorkPlanV1;
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly requestId: string;
}): RuntimeV2PlanReviewValidationResult {
  if (
    !String(input.requestId || "").trim() ||
    input.commit.review.requestId !== String(input.requestId).trim()
  ) {
    return { ok: false, reason: "plan_review_request_mismatch" };
  }
  return validateRuntimeV2PlanReviewCommitIntegrity(input);
}

/** Resolve only from the event-sourced aggregate. A persisted plan.md or a
 * legacy PlanArtifact can never recreate this approval authority. */
export function resolveRuntimeV2PlanReviewFromAggregate(
  aggregate: TurnAggregateV1 | null | undefined,
): RuntimeV2ResolvedPlanReview | null {
  const plan = aggregate?.sealedWorkPlan;
  const commit = aggregate?.planReviewCommit;
  const run = aggregate?.run?.identity;
  if (!aggregate || aggregate.strategy !== "plan" || !plan || !commit || !run) return null;
  const validation = validateRuntimeV2PlanReviewBinding({
    commit,
    currentPlan: plan,
    turn: aggregate.turn,
    run,
    requestId: commit.review.requestId,
  });
  if (!validation.ok) return null;
  const pending = aggregate.phase === "reviewing" &&
    aggregate.workPlan?.status === "pending_review";
  return { plan, commit, pending };
}

/**
 * Resolve the immutable approved execution input while the same Run is
 * acting, validating or finalizing. This deliberately does not call the
 * pending-review validator: approval authority is re-proven from the sealed
 * plan, commit owner and all three projections.
 */
export function resolveApprovedRuntimeV2WorkPlanFromAggregate(
  aggregate: TurnAggregateV1 | null | undefined,
): RuntimeV2ResolvedApprovedWorkPlan | null {
  const plan = aggregate?.sealedWorkPlan;
  const commit = aggregate?.planReviewCommit;
  const run = aggregate?.run?.identity;
  const workPlan = aggregate?.workPlan;
  const executionPhase = aggregate?.phase === "acting" ||
    aggregate?.phase === "validating" ||
    aggregate?.phase === "finalizing";
  if (
    !aggregate ||
    aggregate.strategy !== "plan" ||
    !executionPhase ||
    aggregate.run?.phase !== aggregate.phase ||
    aggregate.run.status !== "running" ||
    !plan ||
    !commit ||
    !run ||
    !workPlan ||
    workPlan.status !== "approved"
  ) {
    return null;
  }
  const validation = validateRuntimeV2PlanReviewCommitIntegrity({
    commit,
    currentPlan: plan,
    turn: aggregate.turn,
    run,
  });
  if (!validation.ok) return null;
  if (!sameAuthority(workPlan, validation.authority)) return null;
  return { plan, commit };
}
