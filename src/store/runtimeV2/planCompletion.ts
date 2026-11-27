import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import { awaitCanceledTurnTerminalProjection, getPendingSessionCancellation } from "../sessionCancellationBarrier";
import {
  runtimeV2CheckpointWriteFailureReason,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
  type SealedWorkPlanV1,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import type { RuntimeV2PlanCollaboration } from "./planCollaboration";
import { PlanLedger } from "./planLedger";
import {
  applyReviewProjection,
  planReference,
  publishReviewMilestone,
  writeReviewArtifact,
} from "./planReviewProjection";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import type { RuntimeV2PlanTerminalFailure } from "./planRequirement";
import {
  finishPlanTerminal,
  planSettlement,
  terminalPlanOutcome,
} from "./planSettlement";
import {
  createRuntimeV2PlanReviewCommit,
  resolveRuntimeV2PlanReviewFromAggregate,
} from "./workPlanAdapter";
import { recoverRuntimeV2PlanDraft } from "./planDraftRunner";
import { recoverRuntimeV2PlanCheckpointBoundary } from "./planCheckpointRecovery";

type RuntimeV2PlanCompletion =
  | {
    readonly kind: "settled";
    readonly settlement: RuntimeRunSettlement;
  }
  | {
    readonly kind: "terminal";
    readonly terminal: Parameters<typeof finishPlanTerminal>[0];
  };

export async function settleRuntimeV2PlanCompletion(
  completion: RuntimeV2PlanCompletion,
): Promise<RuntimeRunSettlement> {
  if (completion.kind === "settled") return completion.settlement;
  try {
    return await finishPlanTerminal(completion.terminal);
  } catch (error) {
    const settlement = await recoverRuntimeV2PlanCheckpointBoundary({ ...completion.terminal, error });
    if (settlement) return settlement;
    throw error;
  }
}

export async function completeRuntimeV2Plan(input: {
  readonly runner: RuntimeV2PlanRunnerInput;
  readonly ledger: PlanLedger;
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly sealedPlan: SealedWorkPlanV1 | null;
  readonly terminalFailure: RuntimeV2PlanTerminalFailure | null;
  readonly collaboration: RuntimeV2PlanCollaboration;
}): Promise<RuntimeV2PlanCompletion> {
  if (!input.sealedPlan) {
    if (!await input.collaboration.abortAndDrain("plan_terminal_boundary")) {
      throw new Error("RUNTIME_V2_PLAN_ACTIVE_CHILD_TERMINAL_FENCE");
    }
    if (!input.terminalFailure) {
      throw new Error("RUNTIME_V2_PLAN_TERMINAL_DECISION_MISSING");
    }
    input.runner.logStoreEvent("runtime_v2_plan_review_not_produced", {
      turnId: input.turn.turnId,
      runId: input.run.runId,
      evidenceCount: input.evidence.length,
      terminal: true,
      detailCode: input.terminalFailure.detailCode,
    });
    return {
      kind: "terminal",
      terminal: {
        runner: input.runner,
        ledger: input.ledger,
        run: input.run,
        ...input.terminalFailure,
      },
    };
  }
  if (input.collaboration.activeChildCount() > 0) {
    throw new Error("RUNTIME_V2_PLAN_ACTIVE_CHILD_REVIEW_FENCE");
  }
  const requestId = [
    "runtime-v2-plan-review",
    input.run.runId,
    input.sealedPlan.id,
    input.sealedPlan.revision,
    input.sealedPlan.projectionHash.slice(-16),
  ].join(":");
  input.runner.context.abortCtrl.signal.throwIfAborted();
  const documentRef = await writeReviewArtifact({
    context: input.runner.context, ledger: input.ledger, run: input.run, plan: input.sealedPlan,
  });
  input.runner.context.abortCtrl.signal.throwIfAborted();
  const commit = createRuntimeV2PlanReviewCommit({
    plan: input.sealedPlan,
    turn: input.turn,
    run: input.run,
    requestId,
    createdAt: Date.now(),
    documentRef,
  });
  await input.ledger.append({
    type: "work_plan.sealed",
    run: input.run,
    workPlan: planReference(input.sealedPlan),
    sealedPlan: input.sealedPlan,
    reviewCommit: commit,
  });
  await publishReviewMilestone({
    ledger: input.ledger,
    commit,
  });
  // Expose the approval control only after every ReviewCommit projection is
  // durably appended, so a fast click cannot race the milestone checkpoint.
  applyReviewProjection(input.runner, commit);
  input.runner.logStoreEvent("runtime_v2_plan_review_committed", {
    turnId: input.turn.turnId,
    runId: input.run.runId,
    requestId: commit.review.requestId,
    workPlanId: commit.authority.id,
    revision: commit.authority.revision,
    digest: commit.authority.digest,
    projectionHash: commit.authority.projectionHash,
  });
  return {
    kind: "settled",
    settlement: planSettlement(input.runner.context),
  };
}

interface PlanFailureInput {
  readonly error: unknown;
  readonly runner: RuntimeV2PlanRunnerInput;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly collaboration: RuntimeV2PlanCollaboration;
}

export async function recoverRuntimeV2PlanFailure(input: PlanFailureInput): Promise<RuntimeV2PlanCompletion> {
  try {
    return await recoverPlanFailure(input);
  } catch (error) {
    if (!runtimeV2CheckpointWriteFailureReason(error)) throw error;
    const canUseReservedTerminal = input.collaboration.activeChildCount() === 0;
    input.collaboration.abortChildren("runtime_v2_plan_checkpoint_boundary");
    const settlement = await recoverRuntimeV2PlanCheckpointBoundary({ ...input, error, canUseReservedTerminal });
    if (settlement) return { kind: "settled", settlement };
    throw error;
  }
}

async function recoverPlanFailure(input: PlanFailureInput): Promise<RuntimeV2PlanCompletion> {
  if (runtimeV2CheckpointWriteFailureReason(input.error)) throw input.error;
  const aggregate = input.ledger.snapshot();
  if (!aggregate?.run || aggregate.phase === "acting") throw input.error;
  if (
    !aggregate.terminalOutcome &&
    input.runner.context.abortCtrl.signal.aborted &&
    getPendingSessionCancellation(input.run.sessionKey)?.turnId === input.run.turnId
  ) {
    input.collaboration.abortChildren("runtime_v2_plan_parent_canceled");
    if (
      await awaitCanceledTurnTerminalProjection({
        sessionKey: input.run.sessionKey,
        turnId: input.run.turnId,
        getProjection: () => {
          const state = input.runner.get();
          return {
            runtimeEvents: state.runtimeEvents || [],
            taskFlow: state.taskFlow || [],
          };
        },
      })
    ) {
      return {
        kind: "settled",
        settlement: planSettlement(
          input.runner.context,
          terminalPlanOutcome(
            "canceled",
            "用户已停止计划生成；取消事务已完成唯一终态收口。",
          ),
        ),
      };
    }
  }
  if (
    !aggregate.terminalOutcome &&
    !await input.collaboration.abortAndDrain(
      input.runner.context.abortCtrl.signal.aborted
        ? "plan_parent_aborted"
        : "plan_parent_failure",
    )
  ) {
    throw input.error;
  }
  if (aggregate.terminalOutcome) {
    await input.ledger.finishTerminal({ run: input.run, resultKind: aggregate.terminalOutcome.resultKind, reason: aggregate.terminalOutcome.reason });
    return {
      kind: "settled",
      settlement: planSettlement(
        input.runner.context,
        terminalPlanOutcome(
          aggregate.terminalOutcome.resultKind,
          aggregate.terminalOutcome.reason,
        ),
      ),
    };
  }
  if (aggregate.events.some(event => event.type === "command.scheduled" && event.command.payload.planDraftMetadata)) {
    const draft = await recoverRuntimeV2PlanDraft(input.runner, input.ledger, input.run);
    if (draft) return { kind: "settled", settlement: draft };
  }
  const recoveredReview = resolveRuntimeV2PlanReviewFromAggregate(aggregate);
  if (recoveredReview?.pending) {
    applyReviewProjection(input.runner, recoveredReview.commit);
    return {
      kind: "settled",
      settlement: planSettlement(input.runner.context),
    };
  }
  if (input.runner.context.abortCtrl.signal.aborted) {
    return {
      kind: "terminal",
      terminal: {
        runner: input.runner,
        ledger: input.ledger,
        run: input.run,
        resultKind: "canceled",
        reason: "用户已停止计划生成；已保留此前收集的证据并结束本轮。",
        detailCode: "runtime_v2_plan_aborted",
      },
    };
  }
  const detail = input.error instanceof Error
    ? input.error.message
    : String(input.error);
  await input.ledger.recordSoftSignal(input.run, "protocol_drift");
  input.runner.logStoreEvent("runtime_v2_plan_unhandled_failure", {
    turnId: input.run.turnId,
    runId: input.run.runId,
    error: detail,
  });
  return {
    kind: "terminal",
    terminal: {
      runner: input.runner,
      ledger: input.ledger,
      run: input.run,
      resultKind: "error",
      reason: "计划生成遇到运行时错误；已保留现有证据并明确结束本轮，没有留下悬空任务。",
      detailCode: "runtime_v2_plan_unhandled_failure",
    },
  };
}
