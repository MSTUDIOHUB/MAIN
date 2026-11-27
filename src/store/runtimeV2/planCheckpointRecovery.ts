import { getHarnessActionRunId } from "../../lib/harnessCrashTelemetry";
import { resolvePlanDocumentFromAggregate } from "../../lib/planDocumentRecords";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import type { MainThreadEvent } from "../../lib/turnEvents";
import {
  runtimeV2CheckpointWriteFailureReason,
  sameRuntimeV2EmergencyTerminalRun,
  type RuntimeV2EmergencyTerminalReasonCode,
  type RuntimeV2RunIdentity,
} from "../../lib/runtime-v2";
import { awaitCanceledTurnTerminalProjection } from "../sessionCancellationBarrier";
import { getRuntimeV2Checkpoint, getRuntimeV2EmergencyTerminalEnvelope } from "./checkpointPort";
import { PlanCheckpointTerminalReserveError, type PlanLedger } from "./planLedger";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import { planSettlement, terminalPlanOutcome } from "./planSettlement";

interface PlanCheckpointRecoveryInput {
  readonly runner: RuntimeV2PlanRunnerInput;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
}

function checkpointProjectionFailure(
  { runner, run }: PlanCheckpointRecoveryInput,
  reason: RuntimeV2EmergencyTerminalReasonCode,
  disposition: "projection_failed" | "superseded",
): RuntimeRunSettlement {
  const state = runner.get();
  const marker = state.harnessRunMarker;
  const outcome = terminalPlanOutcome(runner.context.abortCtrl.signal.aborted ? "canceled" : "error", reason);
  return {
    ...planSettlement(runner.context, outcome),
    disposition,
    currentOwner: {
      harnessRunId: marker?.runId ?? null,
      actionRunId: getHarnessActionRunId(marker),
      actionRequestRunId: state.activeActionRequest?.runId ?? null,
      sessionKey: marker?.sessionKey ?? null,
      turnId: marker?.turnId ?? null,
      status: marker?.status ?? null,
      instanceId: marker?.instanceId ?? null,
      startedAt: marker?.startedAt ?? null,
    },
    // The submitted run is the only generation this result may settle.
    identity: { sessionKey: run.sessionKey, turnId: run.turnId, runId: run.runId, parentRunId: run.parentRunId,
      outerRunId: runner.context.harnessRunId },
  };
}

async function settlePlanCheckpointBoundary(
  input: PlanCheckpointRecoveryInput,
  reasonCode: RuntimeV2EmergencyTerminalReasonCode,
  useReservedTerminal: boolean,
): Promise<RuntimeRunSettlement> {
  const { runner, ledger, run } = input;
  const local = ledger.snapshot()!;
  const language = runner.context.phaseLanguage;
  let lastCheckpoint: ReturnType<typeof getRuntimeV2Checkpoint> = null;
  if (runner.context.abortCtrl.signal.aborted) {
    const canceled = await awaitCanceledTurnTerminalProjection({
      sessionKey: run.sessionKey,
      turnId: run.turnId,
      getProjection: () => {
        const state = runner.get();
        return { runtimeEvents: state.runtimeEvents || [], taskFlow: state.taskFlow || [] };
      },
    });
    if (canceled) {
      const settlement = (runner.get().runtimeEvents as MainThreadEvent[] | undefined)?.find((event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
        event.type === "run.completed" && event.turnId === run.turnId && event.threadId === run.sessionKey && event.runId === run.runId,
      );
      if (settlement?.resultKind === "canceled" && settlement.summary) {
        return planSettlement(runner.context, terminalPlanOutcome("canceled", settlement.summary));
      }
    }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = runner.get();
    const checkpoint = getRuntimeV2Checkpoint(state, local.turn);
    const marker = state.harnessRunMarker;
    if (marker && (marker.sessionKey !== run.sessionKey || marker.turnId !== run.turnId || marker.runId !== run.runId)) {
      return checkpointProjectionFailure(input, reasonCode, "superseded");
    }
    if (!checkpoint?.aggregate.run || !sameRuntimeV2EmergencyTerminalRun(checkpoint.aggregate.run.identity, run)) {
      return checkpointProjectionFailure(input, reasonCode, checkpoint ? "superseded" : "projection_failed");
    }
    lastCheckpoint = checkpoint;
    const candidate = getRuntimeV2EmergencyTerminalEnvelope(state, local.turn);
    const existingEnvelope = candidate?.lastRevision === checkpoint.revision && sameRuntimeV2EmergencyTerminalRun(candidate.run, run)
      ? candidate
      : null;
    const document = resolvePlanDocumentFromAggregate(checkpoint.aggregate);
    const hasSavedPlan = !!document || !!checkpoint.aggregate.sealedWorkPlan;
    const resultKind = runner.context.abortCtrl.signal.aborted ? "canceled" : hasSavedPlan ? "partial" : "error";
    if (useReservedTerminal && attempt === 0 && !existingEnvelope && !checkpoint.aggregate.terminalOutcome) {
      const reason = language === "zh"
        ? resultKind === "canceled" ? "用户已停止本轮计划生成。" : "运行时事件账本已接近容量上限，计划生成提前结束，已保存的证据仍予保留。"
        : resultKind === "canceled" ? "The user stopped plan generation." : "The runtime event ledger was near capacity. Plan generation ended early and saved evidence was retained.";
      try {
        await ledger.finishTerminal({ run, resultKind, reason, finalMarkdown: document && resultKind === "partial" ? `${document.markdown}\n\n${reason}` : undefined });
        return planSettlement(runner.context, terminalPlanOutcome(resultKind, reason));
      } catch (error) {
        reasonCode = runtimeV2CheckpointWriteFailureReason(error) ?? reasonCode;
        // The normal close may have persisted part of its transaction.
        continue;
      }
    }
    try {
      const outcome = await ledger.finishEmergencyTerminal({ checkpoint, run, reasonCode, resultKind, language, existingEnvelope });
      if (!outcome) continue;
      const latest = runner.get();
      const projected = (latest.runtimeEvents as MainThreadEvent[] | undefined)?.some(event =>
        event.type === "run.completed" && event.threadId === run.sessionKey && event.turnId === run.turnId &&
        event.runId === run.runId && event.resultKind === outcome.resultKind,
      );
      if (!projected) continue;
      runner.logStoreEvent("runtime_v2_plan_checkpoint_terminal", {
        turnId: run.turnId, runId: run.runId, reasonCode: existingEnvelope?.reasonCode ?? reasonCode, resultKind: outcome.resultKind,
        checkpointRevision: checkpoint.revision, checkpointEventCount: checkpoint.aggregate.events.length,
        canonicalOutcome: !!checkpoint.aggregate.terminalOutcome,
      });
      return planSettlement(runner.context, terminalPlanOutcome(outcome.resultKind, outcome.reason));
    } catch {
      // Diagnostics and recovery must never append to the failing ledger.
      // A successful envelope write can still be restored if presentation fails.
    }
  }
  runner.logStoreEvent("runtime_v2_plan_checkpoint_terminal_failed", {
    turnId: run.turnId, runId: run.runId, reasonCode,
    checkpointRevision: lastCheckpoint?.revision,
    checkpointEventCount: lastCheckpoint?.aggregate.events.length,
  });
  return checkpointProjectionFailure(input, reasonCode, "projection_failed");
}

export async function recoverRuntimeV2PlanCheckpointBoundary(input: PlanCheckpointRecoveryInput & {
  readonly error: unknown;
  readonly canUseReservedTerminal?: boolean;
}): Promise<RuntimeRunSettlement | null> {
  const reasonCode = runtimeV2CheckpointWriteFailureReason(input.error);
  const aggregate = input.ledger.snapshot();
  const run = aggregate?.run?.identity;
  if (!reasonCode || !run || aggregate.strategy !== "plan" || aggregate.phase === "acting" ||
    !sameRuntimeV2EmergencyTerminalRun(run, input.run)) return null;
  return settlePlanCheckpointBoundary(input, reasonCode, Boolean(
    input.canUseReservedTerminal && input.error instanceof PlanCheckpointTerminalReserveError,
  ));
}

export async function restoreRuntimeV2PlanEmergencyTerminal(input: PlanCheckpointRecoveryInput): Promise<RuntimeRunSettlement | null> {
  const aggregate = input.ledger.snapshot();
  if (!aggregate?.run || !sameRuntimeV2EmergencyTerminalRun(aggregate.run.identity, input.run)) return null;
  const state = input.runner.get();
  const envelope = getRuntimeV2EmergencyTerminalEnvelope(state, aggregate.turn);
  if (!envelope || !sameRuntimeV2EmergencyTerminalRun(envelope.run, input.run)) return null;
  const checkpoint = getRuntimeV2Checkpoint(state, aggregate.turn);
  if (!checkpoint || checkpoint.revision !== envelope.lastRevision) return null;
  return settlePlanCheckpointBoundary(input, envelope.reasonCode, false);
}
