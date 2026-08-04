import {
  abortedAgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import {
  RuntimeV2Controller,
  advanceRuntimeV2ProviderRecoveryStallLease,
  createRuntimeV2EmergencyTerminalEnvelope,
  countDistinctRuntimeV2EvidenceFacts,
  decideRuntimeV2ExecutePhaseTransition,
  deriveRuntimeV2ProviderRecoveryWindow,
  deriveRuntimeV2PlanExecutionCoverage,
  deriveRuntimeV2PlanSourceFreshness,
  hasCompletedRuntimeV2InitialObservation,
  isRuntimeV2TurnTerminallyClosed,
  runtimeV2DirectExecuteReadyForConclusion,
  runtimeV2ProviderRecoveryOccurrenceLimitReached,
  runtimeV2ProviderRecoveryStallExpired,
  RUNTIME_V2_STALLED_VALIDATION_FAILURE_LIMIT,
  runtimeV2CheckpointWriteFailureReason,
  summarizeRuntimeV2ExecuteEvidence,
  type RuntimeV2ProviderRecoveryStallLease,
} from "../../lib/runtime-v2";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import { resolveSubagentCapacityPolicy } from "../../lib/subagents";
import type { ConversationTurn } from "../../lib/workflowModels";
import { awaitCanceledTurnTerminalProjection } from "../sessionCancellationBarrier";
import {
  createRuntimeV2CheckpointPort,
  getRuntimeV2Checkpoint,
  getRuntimeV2EmergencyTerminalEnvelope,
} from "./checkpointPort";
import {
  createRuntimeV2LiveExecutionState,
  createRuntimeV2ProviderPort,
  createRuntimeV2SchedulerPort,
  createRuntimeV2ToolPort,
} from "./executionPorts";
import {
  RUNTIME_V2_EXECUTION_CONTRACT_MAX_REPAIR_ATTEMPTS,
  deriveRuntimeV2ExecutionContractRepair,
} from "./executionContract";
import {
  runtimeV2ExecuteAcceptanceEvidenceRequirements,
} from "./executionAcceptance";
import {
  deriveRuntimeV2ProviderEffectFacts,
} from "./executionProviderEffectFacts";
import {
  RUNTIME_V2_CORRECTIVE_MUTATION_MAX_FAILURES,
  runtimeV2CorrectiveMutationFailureLimitReached,
} from "./executionProviderActionWindow";
import {
  runtimeV2ExecuteTerminalDecision,
  runtimeV2PhaseTransitionMessage,
  truthfulRuntimeV2RecoveryStallDecision,
} from "./executionOutcome";
import {
  createRuntimeV2RunnerIdentity,
  createRuntimeV2RunnerSettlement,
  runtimeV2TerminalOutcomeToLegacy,
} from "./executionRunnerIdentity";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import { resolveApprovedRuntimeV2WorkPlanFromAggregate } from "./workPlanAdapter";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2ExecuteRunnerInput {
  readonly get: StoreGet;
  readonly set: StoreSet;
  readonly context: RuntimeV2SubmissionContext;
  readonly getSessionRevisionToken: () => unknown;
  readonly sanitizeTaskBlocksForPersist: (blocks: any[]) => any[];
  readonly buildSessionRuntimeSnapshot: (state: any) => unknown;
  readonly publishOwnerScopedRuntimeProjection: (input: {
    projectedState: any;
    durableState?: any;
    scopeKey: string;
    sessionId: number | string | null | undefined;
    expectedRevisionToken: unknown;
  }) => { published: boolean; disposition: string };
  readonly persistSessionRecord: (scopeKey: string, session: unknown) => Promise<unknown>;
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

function nowIdFactory() {
  let ordinal = 0;
  return (scope: string) => `${scope}:${Date.now().toString(36)}:${++ordinal}`;
}

function currentTurn(state: any, turnId: string): ConversationTurn | null {
  return state?.conversationTurns?.find((turn: ConversationTurn) => turn.id === turnId) || null;
}

/** Production adapter shared by visible Execute Turns, approved Plan
 * continuations, ordinary Studio workflows, and internal Goal slices. */
export async function runSubmitRuntimeV2Execute(
  input: RuntimeV2ExecuteRunnerInput,
): Promise<RuntimeRunSettlement> {
  const initialState = input.get();
  const turn = currentTurn(initialState, input.context.turnId);
  if (!turn) throw new Error(`RUNTIME_V2_TURN_MISSING:${input.context.turnId}`);
  const identity = createRuntimeV2RunnerIdentity(
    initialState,
    input.context,
    turn,
  );
  const live = createRuntimeV2LiveExecutionState();
  const nextId = nowIdFactory();
  const checkpoint = createRuntimeV2CheckpointPort({
    get: input.get,
    set: input.set,
    scopeKey: input.context.runScopeKey,
    sessionId: input.context.runSessionId,
    getSessionRevisionToken: input.getSessionRevisionToken,
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    buildSessionRuntimeSnapshot: input.buildSessionRuntimeSnapshot,
    persistSessionRecord: input.persistSessionRecord,
    publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
    logStoreEvent: input.logStoreEvent,
  });
  const existing = getRuntimeV2Checkpoint(initialState, identity.turn);
  const emergencyTerminal =
    getRuntimeV2EmergencyTerminalEnvelope(
      initialState,
      identity.turn,
    );
  if (emergencyTerminal) {
    input.logStoreEvent(
      "runtime_v2_execute_emergency_terminal_restored",
      {
        turnId: identity.turn.turnId,
        runId: emergencyTerminal.run.runId,
        resultKind: emergencyTerminal.resultKind,
        reasonCode: emergencyTerminal.reasonCode,
        lastRevision: emergencyTerminal.lastRevision,
        hasMutation: emergencyTerminal.hasMutation,
      },
    );
    return createRuntimeV2RunnerSettlement(
      input.context,
      runtimeV2TerminalOutcomeToLegacy(
        emergencyTerminal.resultKind,
        emergencyTerminal.reason,
      ),
    );
  }
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) {
    // The current harness generation cannot safely adopt an old effect run
    // whose UI owner is no longer current. Let the outer bootstrap finalizer
    // create a truthful recovery conclusion instead of replaying it twice.
    input.logStoreEvent("runtime_v2_stale_checkpoint_quarantined", {
      turnId: identity.turn.turnId,
      requestedRunId: identity.run.runId,
      checkpointRunId: existing.aggregate.run?.identity.runId || null,
      revision: existing.revision,
    });
    throw new Error("RUNTIME_V2_STALE_RUN_CHECKPOINT: checkpoint belongs to a different harness run.");
  }
  const executionPorts = {
    get: input.get,
    set: input.set,
    context: input.context,
    live,
    nextId,
    now: Date.now,
    logStoreEvent: input.logStoreEvent,
  };
  const controller = new RuntimeV2Controller({
    checkpoint,
    provider: createRuntimeV2ProviderPort(executionPorts),
    tool: createRuntimeV2ToolPort(executionPorts),
    scheduler: createRuntimeV2SchedulerPort(executionPorts),
    projection: createRuntimeV2ProjectionPort({
      get: input.get,
      set: input.set,
      nextTaskId: () => input.get()._nextTaskId(),
      language: input.context.phaseLanguage,
      logStoreEvent: input.logStoreEvent,
    }),
    clockId: {
      now: Date.now,
      nextId,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${nextId("idempotency")}`,
    },
  }, existing ? { aggregate: existing.aggregate, revision: existing.revision } : undefined, {
    abortSignal: input.context.abortCtrl.signal,
  });
  let providerRecoveryLease: RuntimeV2ProviderRecoveryStallLease | null = null;

  try {
    if (!existing) {
      input.logStoreEvent("runtime_v2_execute_admitted", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        workspaceKey: identity.turn.workspaceKey,
        strategy: "execute",
      });
      await controller.admit({
        turn: identity.turn,
        run: identity.run,
        strategy: "execute",
        objective:
          input.context.executeAdmission?.objective ||
          turn.userPrompt,
        constraints:
          input.context.executeAdmission?.constraints || [],
        acceptanceCriteria:
          input.context.executeAdmission?.acceptanceCriteria.map(
            (criterion) => criterion.text,
          ) || [turn.userPrompt],
        acceptanceCriterionIds:
          input.context.executeAdmission?.acceptanceCriteria.map(
            (criterion) => criterion.id,
          ) || ["criterion-user-objective"],
        acceptanceEvidenceRequirements:
          runtimeV2ExecuteAcceptanceEvidenceRequirements(
            input.context.executeAdmission?.acceptanceCriteria,
          ),
        initialPhase: "preparing",
      });
    } else if (existing.aggregate.terminalOutcome) {
      const terminal = existing.aggregate.terminalOutcome;
      return createRuntimeV2RunnerSettlement(
        input.context,
        runtimeV2TerminalOutcomeToLegacy(terminal.resultKind, terminal.reason),
      );
    } else if (
      existing.migrationDisposition ===
        "active_uncontracted_mutation"
    ) {
      input.logStoreEvent(
        "runtime_v2_v3_uncontracted_mutation_quarantined",
        {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          checkpointRevision: existing.revision,
        },
      );
      await controller.discardScheduledForMigration();
    } else if (
      existing.migrationDisposition === "active_unmodified"
    ) {
      input.logStoreEvent(
        "runtime_v2_v3_unmodified_reobserving",
        {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          checkpointRevision: existing.revision,
          previousPhase: existing.aggregate.phase,
          discardedScheduledEffects:
            existing.aggregate.scheduledCommands.length,
        },
      );
      await controller.reobserveAfterLegacyMigration();
    } else {
      input.logStoreEvent("runtime_v2_execute_resuming_scheduled", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        checkpointRevision: existing.revision,
        scheduledKind: existing.aggregate.scheduledCommands[0]?.kind || null,
      });
      await controller.resumeScheduled();
    }

    while (true) {
      const before = controller.snapshot().aggregate;
      if (!before || before.terminalOutcome) break;
      const providerRecoveryWindow =
        deriveRuntimeV2ProviderRecoveryWindow(before);
      const providerRecoveryPressure =
        providerRecoveryWindow?.pressure || null;
      providerRecoveryLease = advanceRuntimeV2ProviderRecoveryStallLease({
        current: providerRecoveryLease,
        pressure: providerRecoveryPressure,
        startedAt: providerRecoveryWindow?.startedAt,
        now: Date.now(),
      });
      if (live.permissionRejection) {
        await controller.driveOnce({
          resultKind: "blocked",
          resultReason: live.permissionRejection.reason,
          finalMarkdown: live.permissionRejection.finalMarkdown,
        });
        continue;
      }
      if (
        existing?.migrationDisposition ===
          "active_uncontracted_mutation"
      ) {
        await controller.driveOnce({
          resultKind: "partial",
          resultReason:
            "该在途 v3 Execute 已产生修改但没有执行契约；迁移不会补造授权或验收回执，现有修改已保留并以明确 partial 收口。",
        });
        if (controller.snapshot().aggregate?.terminalOutcome) break;
        continue;
      }
      if (
        before.strategy === "plan" &&
        before.workPlan?.status === "approved" &&
        !resolveApprovedRuntimeV2WorkPlanFromAggregate(before)
      ) {
        await controller.driveOnce({
          resultKind: "error",
          resultReason: "已批准 WorkPlan 的身份、内容摘要或投影绑定无法通过校验；运行时未执行未获授权的后续效果。",
        });
        if (controller.snapshot().aggregate?.terminalOutcome) break;
        continue;
      }
      if (
        before.strategy === "plan" &&
        before.workPlan?.status === "approved" &&
        !before.evidence.some((evidence) => evidence.kind === "mutation")
      ) {
        const freshness = deriveRuntimeV2PlanSourceFreshness(before);
        const invalidTargets = freshness
          ? [...freshness.staleTargets, ...freshness.unversionedTargets]
          : [];
        if (invalidTargets.length > 0) {
          await controller.invalidateWorkPlan(
            `source_version_changed:${invalidTargets.join(",")}`,
          );
          await controller.driveOnce({
            resultKind: "error",
            resultReason: `已批准计划的源文件版本发生变化或缺少可验证版本：${invalidTargets.join("、")}。本轮未执行过期修改，请重新审核更新后的计划。`,
          });
          if (controller.snapshot().aggregate?.terminalOutcome) break;
          continue;
        }
      }
      const terminal = runtimeV2ExecuteTerminalDecision({
        aggregate: before,
        signal: input.context.abortCtrl.signal,
      });
      if (terminal) {
        await controller.driveOnce(terminal);
        if (controller.snapshot().aggregate?.terminalOutcome) break;
        continue;
      }
      const validationProgress = summarizeRuntimeV2ExecuteEvidence(before, {
        isMutationToolName: isWorkspaceMutationToolName,
      });
      if (
        validationProgress.stalledValidationCount >=
          RUNTIME_V2_STALLED_VALIDATION_FAILURE_LIMIT
      ) {
        const latestFailure = [...before.events].reverse().find(
          (event): event is Extract<
            (typeof before.events)[number],
            { type: "validation.completed" }
          > => event.type === "validation.completed" && !event.passed,
        );
        const latestDetail = String(
          latestFailure?.presentation?.message || "",
        ).trim().slice(0, 1_000);
        input.logStoreEvent(
          "runtime_v2_stalled_validation_limit_reached",
          {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            phase: before.phase,
            consecutiveFailures:
              validationProgress.stalledValidationCount,
            limit: RUNTIME_V2_STALLED_VALIDATION_FAILURE_LIMIT,
            validationTarget:
              latestFailure?.presentation?.target || null,
          },
        );
        await controller.driveOnce({
          resultKind: before.evidence.some((evidence) =>
              evidence.kind === "mutation"
            )
            ? "partial"
            : "error",
          resultReason: [
            `连续 ${validationProgress.stalledValidationCount} 次修改后得到相同的验收失败，MAIN 已停止无效的“修改—重试”循环；这不是执行时长限制。`,
            "已保留实际修改，但没有将尚未通过验收的结果表述为成功。",
            latestDetail,
          ].filter(Boolean).join(" "),
        });
        if (controller.snapshot().aggregate?.terminalOutcome) break;
        continue;
      }
      const providerEffectFacts = deriveRuntimeV2ProviderEffectFacts(before);
      if (
        runtimeV2CorrectiveMutationFailureLimitReached(providerEffectFacts)
      ) {
        const correctiveFailureCount =
          providerEffectFacts.correctiveMutationFailureToolCallIds?.size || 0;
        const latestFailure = [...before.events].reverse().find(
          (event): event is Extract<
            (typeof before.events)[number],
            { type: "tool.completed" }
          > =>
            event.type === "tool.completed" &&
            (
              event.failureReasonCode === "mutation_source_lease_missing" ||
              event.failureReasonCode === "mutation_source_text_mismatch" ||
              event.failureReasonCode === "mutation_target_lease_mismatch"
            ),
        );
        const latestDetail = String(
          latestFailure?.presentation?.message || "",
        ).trim().slice(0, 1_000);
        input.logStoreEvent(
          "runtime_v2_corrective_mutation_failure_limit_reached",
          {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            phase: before.phase,
            failures: correctiveFailureCount,
            limit: RUNTIME_V2_CORRECTIVE_MUTATION_MAX_FAILURES,
            latestFailureReasonCode:
              latestFailure?.failureReasonCode || null,
          },
        );
        await controller.driveOnce({
          resultKind: before.evidence.some((evidence) =>
              evidence.kind === "mutation"
            )
            ? "partial"
            : "error",
          resultReason: [
            `连续 ${correctiveFailureCount} 次源码纠错修改均未执行，MAIN 已停止“补读—重试”循环；正常长任务仍可在产生真实修改或验证进展时继续运行。`,
            latestDetail,
          ].filter(Boolean).join(" "),
        });
        if (controller.snapshot().aggregate?.terminalOutcome) break;
        continue;
      }
      const executionContractRepair =
        deriveRuntimeV2ExecutionContractRepair(before);
      if (
        executionContractRepair &&
        executionContractRepair.attempts >=
          RUNTIME_V2_EXECUTION_CONTRACT_MAX_REPAIR_ATTEMPTS
      ) {
        const latestContractFailure = [...before.events].reverse().find(
          (event): event is Extract<
            (typeof before.events)[number],
            { type: "tool.completed" }
          > =>
            event.type === "tool.completed" &&
            event.failureReasonCode === "execution_contract_rejected",
        );
        const rejectionDetail = latestContractFailure?.presentation?.message
          ? ` ${String(latestContractFailure.presentation.message).slice(0, 1_000)}`
          : "";
        input.logStoreEvent(
          "runtime_v2_execution_contract_repair_limit_reached",
          {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            phase: before.phase,
            attempts: executionContractRepair.attempts,
            latestSequence: executionContractRepair.latestSequence,
            rejectionDetail: rejectionDetail.trim() || null,
          },
        );
        await controller.driveOnce({
          resultKind: before.evidence.some((evidence) =>
              evidence.kind === "mutation"
            )
            ? "partial"
            : "error",
          resultReason: [
            `执行契约连续 ${executionContractRepair.attempts} 次未通过结构或证据校验，MAIN 已停止重复生成，且没有把未获授权的方案当作成功。`,
            rejectionDetail.trim(),
          ].filter(Boolean).join(" "),
        });
        if (controller.snapshot().aggregate?.terminalOutcome) break;
        continue;
      }
      if (
        providerRecoveryPressure &&
        (
          runtimeV2ProviderRecoveryOccurrenceLimitReached(
            providerRecoveryPressure,
          ) ||
          runtimeV2ProviderRecoveryStallExpired(
            providerRecoveryLease,
            Date.now(),
          )
        )
      ) {
        const occurrenceLimitReached =
          runtimeV2ProviderRecoveryOccurrenceLimitReached(
            providerRecoveryPressure,
          );
        input.logStoreEvent(
          occurrenceLimitReached
            ? "runtime_v2_provider_recovery_occurrence_limit_reached"
            : "runtime_v2_provider_recovery_stall_reached",
          {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          phase: before.phase,
          reason: providerRecoveryPressure.reason,
          occurrence: providerRecoveryPressure.occurrence,
          recoveryStartedAt: providerRecoveryLease?.startedAt || null,
          },
        );
        await controller.driveOnce(truthfulRuntimeV2RecoveryStallDecision({
          aggregate: before,
          recoveryOccurrence: providerRecoveryPressure.occurrence,
        }));
        if (controller.snapshot().aggregate?.terminalOutcome) break;
        continue;
      }
      const phaseTransition = decideRuntimeV2ExecutePhaseTransition(before, {
        isMutationToolName: isWorkspaceMutationToolName,
      });
      if (phaseTransition) {
        input.logStoreEvent("runtime_v2_phase_transition", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          from: phaseTransition.from,
          to: phaseTransition.to,
          reasonCode: phaseTransition.reason,
          evidenceCount: before.evidence.length,
          pendingToolCalls: before.pendingToolCalls.length,
          childStatuses: before.subagents.map((job) => job.status),
        });
        await controller.changePhase(
          phaseTransition.to,
          runtimeV2PhaseTransitionMessage(phaseTransition.reason),
        );
        continue;
      }
      if (
        before.phase === "preparing" &&
        hasCompletedRuntimeV2InitialObservation(before)
      ) {
        input.logStoreEvent("runtime_v2_phase_transition", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          from: "preparing",
          to: "observing",
          reasonCode: "initial_observation_committed",
          evidenceCount: before.evidence.length,
        });
        await controller.changePhase("observing", "已完成初始工作区观察，开始基于证据定位问题。");
        continue;
      }
      const subagentPolicy = resolveSubagentCapacityPolicy(
        input.get().config,
      );
      const drove = await controller.driveOnce({
        subagentPreference:
          input.context.turnInputContextSignals.subagentPreference,
        subagentCapacity: subagentPolicy.maxActiveRequests,
        subagentRequestMode: subagentPolicy.modelRequestMode,
      });
      if (!drove) {
        if (before.phase === "reviewing") {
          await controller.driveOnce({
            resultKind: "blocked",
            resultReason:
              "当前 WorkPlan 正在等待用户审批；运行时没有代替用户批准或扩大授权。",
          });
          continue;
        }
        throw new Error(
          `RUNTIME_V2_ACTIVE_DECISION_MISSING:${before.phase}`,
        );
      }
    }
    const final = controller.snapshot().aggregate?.terminalOutcome;
    const outcome = controller.snapshot().aggregate?.terminalOutcome;
    if (!final || !outcome) throw new Error("RUNTIME_V2_TERMINAL_PROJECTION_MISSING");
    const executionEvidence = summarizeRuntimeV2ExecuteEvidence(
      controller.snapshot().aggregate,
      { isMutationToolName: isWorkspaceMutationToolName },
    );
    const finalAggregate = controller.snapshot().aggregate!;
    const planCoverage =
      deriveRuntimeV2PlanExecutionCoverage(finalAggregate);
    input.logStoreEvent("runtime_v2_execute_terminal", {
      turnId: identity.turn.turnId,
      runId: identity.run.runId,
      resultKind: outcome.resultKind,
      reason: outcome.reason,
      evidenceCount: countDistinctRuntimeV2EvidenceFacts(
        controller.snapshot().aggregate?.evidence || [],
      ),
      mutations: executionEvidence.mutationCount,
      passedValidations: executionEvidence.passedValidationCount,
      acceptanceValidation:
        runtimeV2DirectExecuteReadyForConclusion(finalAggregate),
      failedValidations: executionEvidence.failedValidationCount,
      stalledValidations: executionEvidence.stalledValidationCount,
      failedOperations: executionEvidence.failedOperationCount,
      failedProviderRequests:
        executionEvidence.failedProviderRequestCount,
      childRuns: controller.snapshot().aggregate?.subagents.length || 0,
      executionAuthorityKind: planCoverage ? "work_plan" : "direct_execute",
      executionAuthorityId:
        finalAggregate.sealedWorkPlan?.id || finalAggregate.turn.turnId,
      verificationComplete: planCoverage
        ? planCoverage.allMutationTargetsCovered &&
          planCoverage.allRequiredValidationsPassed
        : executionEvidence.mutationCount > 0 &&
          runtimeV2DirectExecuteReadyForConclusion(finalAggregate) &&
          executionEvidence.failedValidationCount === 0,
      missingMutationTargets:
        planCoverage?.missingMutationTargets ||
        [],
      missingValidationIds:
        planCoverage?.missingRequiredValidationIndexes.map(
          (index) => `work-plan-validation-${index + 1}`,
        ) ||
        [],
    });
    return createRuntimeV2RunnerSettlement(
      input.context,
      runtimeV2TerminalOutcomeToLegacy(outcome.resultKind, outcome.reason),
    );
  } catch (error) {
    const aggregate = controller.snapshot().aggregate;
    const externallySettledCancellation =
      input.context.abortCtrl.signal.aborted &&
      await awaitCanceledTurnTerminalProjection({
        sessionKey: identity.turn.sessionKey,
        turnId: identity.turn.turnId,
        getProjection: () => {
          const state = input.get();
          return {
            runtimeEvents: state.runtimeEvents || [],
            taskFlow: state.taskFlow || [],
          };
        },
      });
    if (externallySettledCancellation) {
      for (const childAbort of live.childAbortControllers.values()) {
        childAbort.abort("runtime_v2_parent_canceled");
      }
      input.logStoreEvent(
        "runtime_v2_execute_cancellation_terminal_observed",
        {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          checkpointRevision: controller.snapshot().revision,
        },
      );
      return createRuntimeV2RunnerSettlement(
        input.context,
        abortedAgentLoopOutcome(
          "用户已停止本轮执行；取消事务已完成唯一终态收口。",
        ),
      );
    }
    if (
      aggregate?.run &&
      !isRuntimeV2TurnTerminallyClosed(aggregate)
    ) {
      for (const childAbort of live.childAbortControllers.values()) {
        childAbort.abort("runtime_v2_parent_infrastructure_failure");
      }
      const detail = (error instanceof Error
        ? error.message
        : String(error || "unknown error"))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1_000);
      const hasMutation = aggregate.evidence.some(
        (evidence) => evidence.kind === "mutation",
      ) || live.hasExecutedMutationEffect;
      const resultKind = input.context.abortCtrl.signal.aborted
        ? "canceled"
        : hasMutation
          ? "partial"
          : "error";
      const reason = input.context.abortCtrl.signal.aborted
        ? "用户已停止本轮执行；已保留此前提交的证据和修改。"
        : [
            "Runtime v2 执行基础设施异常，父任务已在同一 checkpoint 中收口。",
            hasMutation
              ? "已保留实际修改，但未把未完成验收表述为成功。"
              : "本轮未形成可验收的实际修改。",
            detail ? `原因：${detail}` : "",
          ].filter(Boolean).join(" ");
      input.logStoreEvent("runtime_v2_execute_infrastructure_failure", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        resultKind,
        hasMutation,
        error: detail,
      });
      let terminalWriteError: unknown = null;
      if (!aggregate.terminalOutcome) {
        try {
          await controller.finishTerminal(resultKind, reason);
        } catch (terminalError) {
          terminalWriteError = terminalError;
        }
      } else {
        terminalWriteError = error;
      }
      if (terminalWriteError) {
        input.logStoreEvent(
          "runtime_v2_execute_infrastructure_terminal_failed",
          {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            originalError: detail,
            terminalError: terminalWriteError instanceof Error
              ? terminalWriteError.message
              : String(terminalWriteError),
          },
        );
        const reasonCode =
          runtimeV2CheckpointWriteFailureReason(terminalWriteError) ||
          runtimeV2CheckpointWriteFailureReason(error);
        if (!reasonCode) throw error;
        const emergencyResultKind = input.context.abortCtrl.signal.aborted
          ? "canceled" as const
          : hasMutation
            ? "partial" as const
            : "error" as const;
        const emergencySnapshot = controller.snapshot();
        const envelope = createRuntimeV2EmergencyTerminalEnvelope({
          owner: identity.turn,
          run: identity.run,
          resultKind: emergencyResultKind,
          reasonCode,
          language: input.context.phaseLanguage,
          at: Date.now(),
          lastRevision: emergencySnapshot.revision,
          hasMutation,
        });
        const emergency = await checkpoint.commitEmergencyTerminal({
          owner: identity.turn,
          run: identity.run,
          expectedRevision: emergencySnapshot.revision,
          envelope,
        });
        if (
          emergency.disposition === "conflict" ||
          !emergency.envelope
        ) {
          input.logStoreEvent(
            "runtime_v2_execute_emergency_terminal_conflict",
            {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              lastRevision: emergencySnapshot.revision,
              reasonCode,
            },
          );
          throw error;
        }
        return createRuntimeV2RunnerSettlement(
          input.context,
          runtimeV2TerminalOutcomeToLegacy(
            emergency.envelope.resultKind,
            emergency.envelope.reason,
          ),
        );
      }
      const terminal = controller.snapshot().aggregate?.terminalOutcome;
      if (terminal) {
        return createRuntimeV2RunnerSettlement(
          input.context,
          runtimeV2TerminalOutcomeToLegacy(
            terminal.resultKind,
            terminal.reason,
          ),
        );
      }
    }
    throw error;
  } finally {
    clearInterval(input.context.timerInterval as ReturnType<typeof setInterval>);
  }
}
