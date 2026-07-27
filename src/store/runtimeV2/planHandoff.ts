import {
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  canRecordRuntimeV2Recovery,
  finishRuntimeV2CheckpointTerminal,
  isRuntimeV2TurnTerminallyClosed,
  type CheckpointPort,
  type ProjectionPort,
  type RuntimeV2CheckpointV3,
  type RuntimeV2Event,
} from "../../lib/runtime-v2";
import type {
  PlanReviewActionRequest,
  PlanReviewResolutionIdentity,
} from "../../lib/actionRequest";
import { approveRuntimeV2PlanReviewCheckpoint } from "./planApproval";
import {
  resolveApprovedRuntimeV2WorkPlanFromAggregate,
  type RuntimeV2ResolvedPlanReview,
  type RuntimeV2ResolvedApprovedWorkPlan,
} from "./workPlanAdapter";

export function buildRuntimeV2PlanExecutionPrompt(
  resolved: RuntimeV2ResolvedApprovedWorkPlan,
): string {
  return [
    "[APPROVED RUNTIME V2 WORKPLAN]",
    `WorkPlan id: ${resolved.commit.authority.id}`,
    `Revision: ${resolved.commit.authority.revision}`,
    `Digest: ${resolved.commit.authority.digest}`,
    `Projection: ${resolved.commit.authority.projectionHash}`,
    "",
    resolved.plan.markdown,
    "",
    "Execute this sealed WorkPlan now. Preserve its step dependencies and perform the declared finite validation. The checkpoint object, not this Markdown projection, remains approval authority.",
  ].join("\n");
}

export type RuntimeV2PlanHandoffFailureResult =
  | { readonly ok: true; readonly checkpoint: RuntimeV2CheckpointV3 }
  | {
      readonly ok: false;
      readonly reason:
        | "runtime_v2_plan_handoff_authority_invalid"
        | "runtime_v2_plan_handoff_checkpoint_conflict";
    };

/** A failed approved-Plan dispatch is terminal, never a recoverable UI pause. */
export async function finishRuntimeV2PlanHandoffFailure(input: {
  readonly checkpoint: RuntimeV2CheckpointV3;
  readonly checkpointPort: CheckpointPort;
  readonly projectionPort: ProjectionPort;
  readonly now: number;
  readonly eventIdBase: string;
  readonly reason: string;
}): Promise<RuntimeV2PlanHandoffFailureResult> {
  if (isRuntimeV2TurnTerminallyClosed(input.checkpoint.aggregate)) {
    return { ok: true, checkpoint: input.checkpoint };
  }
  const approved = resolveApprovedRuntimeV2WorkPlanFromAggregate(
    input.checkpoint.aggregate,
  );
  const run = input.checkpoint.aggregate.run?.identity;
  if (!approved || !run) {
    return { ok: false, reason: "runtime_v2_plan_handoff_authority_invalid" };
  }
  let current = input.checkpoint;
  const fingerprint = `plan-execution-handoff:${approved.commit.review.requestId}`;
  if (canRecordRuntimeV2Recovery(
    current.aggregate.recovery,
    "action",
    fingerprint,
  )) {
    const recoveryEvent: RuntimeV2Event = {
      schemaVersion: RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: current.aggregate.nextSequence,
      eventId: `${input.eventIdBase}:recovery`,
      at: Math.max(input.now, current.aggregate.updatedAt),
      type: "recovery.recorded",
      run,
      scope: "action",
      fingerprint,
    };
    const recovered = await input.checkpointPort.append({
      owner: current.owner,
      expectedRevision: current.revision,
      event: recoveryEvent,
    });
    if (recovered.disposition === "conflict" || !recovered.checkpoint) {
      return { ok: false, reason: "runtime_v2_plan_handoff_checkpoint_conflict" };
    }
    current = recovered.checkpoint;
  }
  let ordinal = 0;
  try {
    const checkpoint = await finishRuntimeV2CheckpointTerminal({
      checkpoint: input.checkpointPort,
      projection: input.projectionPort,
      owner: current.owner,
      run,
      current,
      resultKind: "error",
      reason: input.reason,
      now: () => input.now,
      nextId: (scope) => `${input.eventIdBase}:${scope}:${++ordinal}`,
    });
    return { ok: true, checkpoint };
  } catch {
    return { ok: false, reason: "runtime_v2_plan_handoff_checkpoint_conflict" };
  }
}

export async function approveAndDispatchRuntimeV2Plan(input: {
  readonly checkpoint: RuntimeV2CheckpointV3;
  readonly checkpointPort: CheckpointPort;
  readonly projectionPort: ProjectionPort;
  readonly review: RuntimeV2ResolvedPlanReview;
  readonly request: PlanReviewActionRequest | null;
  readonly expected?: PlanReviewResolutionIdentity | null;
  readonly language: "zh" | "en";
  readonly onApproved: () => void;
  readonly dispatch: (input: {
    readonly prompt: string;
    readonly turnId: string;
    readonly runId: string;
  }) => boolean;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
}): Promise<void> {
  const owner = input.review.commit.review;
  const approved = await approveRuntimeV2PlanReviewCheckpoint({
    checkpoint: input.checkpoint,
    port: input.checkpointPort,
    request: input.request,
    expected: input.expected,
    now: Date.now(),
    eventId: `runtime-v2-plan-approved:${owner.turnId}:${owner.requestId}`,
  });
  if (!approved.ok) {
    input.log("runtime_v2_plan_approval_rejected", {
      reason: approved.reason,
      detail: approved.detail || null,
      planTurnId: owner.turnId,
      requestId: owner.requestId,
    });
    return;
  }
  const fail = async (error: unknown) => {
    const reason = input.language === "en"
      ? "The WorkPlan was approved, but its Runtime v2 execution Run could not acquire ownership; this turn has been closed as an error."
      : "WorkPlan 已批准，但 Runtime v2 执行 Run 未能取得所有权；本轮已明确以错误终态结束。";
    const terminal = await finishRuntimeV2PlanHandoffFailure({
      checkpoint: approved.checkpoint,
      checkpointPort: input.checkpointPort,
      projectionPort: input.projectionPort,
      now: Date.now(),
      eventIdBase: `runtime-v2-plan-handoff-failed:${owner.turnId}:${owner.requestId}`,
      reason,
    });
    input.log("runtime_v2_plan_execution_dispatch_failed", {
      planTurnId: owner.turnId,
      runId: owner.runId,
      requestId: owner.requestId,
      terminalDisposition: terminal.ok ? "closed" : terminal.reason,
      error: error instanceof Error ? error.message : String(error || ""),
    });
  };
  try {
    input.onApproved();
    input.log("runtime_v2_plan_approval_committed", {
      planTurnId: owner.turnId,
      requestId: owner.requestId,
      workPlanId: input.review.commit.authority.id,
      revision: input.review.commit.authority.revision,
      digest: input.review.commit.authority.digest,
      projectionHash: input.review.commit.authority.projectionHash,
    });
    const started = input.dispatch({
      prompt: buildRuntimeV2PlanExecutionPrompt(input.review),
      turnId: owner.turnId,
      runId: owner.runId,
    });
    if (!started) {
      await fail("send_message_rejected");
      return;
    }
    input.log("runtime_v2_plan_execution_dispatched", {
      planTurnId: owner.turnId,
      runId: owner.runId,
      requestId: owner.requestId,
      runtimeIntent: "execute",
    });
  } catch (error) {
    await fail(error);
  }
}
