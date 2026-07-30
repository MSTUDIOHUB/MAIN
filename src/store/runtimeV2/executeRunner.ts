import {
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
  type AgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import {
  RuntimeV2Controller,
  createRuntimeV2EmergencyTerminalEnvelope,
  decideRuntimeV2ExecutePhaseTransition,
  decideRuntimeV2TerminalOutcome,
  deriveRuntimeV2PlanExecutionCoverage,
  deriveRuntimeV2PlanSourceFreshness,
  hasCompletedRuntimeV2InitialObservation,
  isRuntimeV2TurnTerminallyClosed,
  runtimeV2DirectExecuteReadyForConclusion,
  runtimeV2CheckpointWriteFailureReason,
  summarizeRuntimeV2ExecuteEvidence,
  type RuntimeV2ExecutePhaseTransition,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
} from "../../lib/runtime-v2";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { resolveSubagentCapacityPolicy } from "../../lib/subagents";
import type { ConversationTurn } from "../../lib/workflowModels";
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

// Leave enough time for the longest in-flight provider/tool deadline and the
// terminal checkpoint to settle before the outer submission lease expires.
const RUNTIME_V2_EXECUTION_DEADLINE_MS = 10 * 60_000;

function nowIdFactory() {
  let ordinal = 0;
  return (scope: string) => `${scope}:${Date.now().toString(36)}:${++ordinal}`;
}

function currentTurn(state: any, turnId: string): ConversationTurn | null {
  return state?.conversationTurns?.find((turn: ConversationTurn) => turn.id === turnId) || null;
}

function sessionEpochFor(state: any, context: RuntimeV2SubmissionContext, turn: ConversationTurn): string {
  const lifecycle = state?.planLifecycle;
  if (lifecycle?.sessionKey === context.runSessionKey && String(lifecycle.sessionEpoch || "").trim()) {
    return String(lifecycle.sessionEpoch).trim();
  }
  return `runtime-v2:${String(turn.clientSubmissionId || turn.id).trim()}`;
}

function identityFor(state: any, context: RuntimeV2SubmissionContext, turn: ConversationTurn): {
  turn: RuntimeV2TurnIdentity;
  run: RuntimeV2RunIdentity;
} {
  const sessionEpoch = sessionEpochFor(state, context, turn);
  const workspaceKey = String(context.runWorkspace || "global").trim() || "global";
  const turnIdentity: RuntimeV2TurnIdentity = {
    workspaceKey,
    sessionKey: context.runSessionKey,
    sessionEpoch,
    clientSubmissionId: String(turn.clientSubmissionId || turn.id).trim(),
    turnId: context.turnId,
  };
  const run: RuntimeV2RunIdentity = {
    sessionKey: context.runSessionKey,
    sessionEpoch,
    turnId: context.turnId,
    runId: context.harnessRunId,
    parentRunId: null,
    attemptId: context.harnessRunId,
  };
  return { turn: turnIdentity, run };
}

function terminalOutcomeToLegacy(
  resultKind: RuntimeV2ResultKind,
  reason: string,
): AgentLoopOutcome {
  return resultKind === "canceled"
    ? abortedAgentLoopOutcome(reason)
    : completedAgentLoopOutcome(reason, resultKind);
}

function latestDurableProviderConclusion(
  aggregate: NonNullable<ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"]>,
): string {
  const scheduledModes = new Map<string, string>();
  for (const event of aggregate.events) {
    if (
      event.type === "command.scheduled" &&
      event.command.kind === "request_model"
    ) {
      scheduledModes.set(
        event.command.idempotencyKey,
        String(event.command.payload.mode || "").trim(),
      );
    }
  }
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (
      event.type === "provider.responded" &&
      scheduledModes.get(event.idempotencyKey) === "conclude" &&
      event.result.toolCalls.length === 0
    ) {
      return sanitizeAssistantDisplayContent(event.result.visibleText || "")
        .trim()
        .slice(0, 24_000);
    }
  }
  return "";
}

function terminalDecision(input: {
  aggregate: ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"];
  signal: AbortSignal;
}): { resultKind: RuntimeV2ResultKind; resultReason: string; finalMarkdown?: string } | null {
  const { aggregate, signal } = input;
  if (!aggregate) return null;
  const evidence = summarizeRuntimeV2ExecuteEvidence(aggregate, {
    isMutationToolName: isWorkspaceMutationToolName,
  });
  const finalMarkdown = latestDurableProviderConclusion(aggregate);
  const decision = decideRuntimeV2TerminalOutcome(aggregate, {
    canceled: signal.aborted,
    mutationCount: evidence.mutationCount,
    passedValidationCount: evidence.passedValidationCount,
    hasAcceptanceValidation:
      runtimeV2DirectExecuteReadyForConclusion(aggregate),
    failedValidationCount: evidence.failedValidationCount,
    stalledValidationCount: evidence.stalledValidationCount,
    hasProviderConclusion: !!finalMarkdown,
  });
  if (!decision) return null;
  return {
    ...decision,
    ...(finalMarkdown ? { finalMarkdown } : {}),
  };
}

function truthfulIncompleteDecision(input: {
  aggregate: NonNullable<
    ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"]
  >;
}): { resultKind: "partial" | "error"; resultReason: string } {
  const hasMutation = input.aggregate.evidence.some(
    (evidence) => evidence.kind === "mutation",
  );
  const evidence = summarizeRuntimeV2ExecuteEvidence(input.aggregate, {
    isMutationToolName: isWorkspaceMutationToolName,
  });
  const planCoverage =
    deriveRuntimeV2PlanExecutionCoverage(input.aggregate);
  const missingTargets = planCoverage?.missingMutationTargets || [];
  const missingValidations =
    planCoverage?.missingRequiredValidationIndexes.map(
      (index) => `work-plan-validation-${index + 1}`,
    ) ||
    [];
  const readOnlyEvidenceCount = input.aggregate.evidence.filter(
    (item) =>
      item.kind === "source" ||
      item.kind === "tool" ||
      item.kind === "subagent",
  ).length;
  const details = [
    missingTargets.length > 0
      ? `未修改目标：${missingTargets.join("、")}`
      : "",
    missingValidations.length > 0
      ? `缺少验证：${missingValidations.join("、")}`
      : "",
    hasMutation && evidence.passedValidationCount === 0
      ? "最新修改之后没有通过有限验证"
      : "",
    evidence.failedValidationCount > 0
      ? "最近一次验证仍未通过"
      : "",
    !hasMutation && readOnlyEvidenceCount > 0
      ? `已完成 ${readOnlyEvidenceCount} 条只读证据收集`
      : "",
    evidence.failedProviderRequestCount > 0
      ? `模型有 ${evidence.failedProviderRequestCount} 次决策请求未形成可执行结果`
      : "",
    evidence.failedOperationCount > 0
      ? `${evidence.failedOperationCount} 个动作被拒绝或执行失败`
      : "",
  ].filter(Boolean);
  return {
    resultKind: hasMutation ? "partial" : "error",
    resultReason: [
      "本轮已到达运行生命周期时限。",
      hasMutation
        ? "已保留实际修改，但没有把未覆盖目标或条件表述为成功。"
        : "本轮没有形成可验收的实际修改。",
      ...details,
    ].join(" "),
  };
}

function phaseTransitionMessage(
  reason: RuntimeV2ExecutePhaseTransition["reason"],
): string {
  const messages = {
    pending_mutation_call: "模型已经提交结构化修改动作，开始实施最小修复。",
    pending_validation_call: "模型已经提交验证动作，开始检查当前工作区结果。",
    mutation_committed: "工作区修改已经真实落账；下一步执行有限验证。",
    validation_failed: "有限验证未通过；返回修改阶段，根据失败证据进行一次针对性修复。",
  } as const;
  return messages[reason];
}

function settlement(
  context: RuntimeV2SubmissionContext,
  outcome: AgentLoopOutcome,
): RuntimeRunSettlement {
  return {
    disposition: "projected",
    reason: outcome.reason,
    identity: {
      sessionKey: context.runSessionKey,
      turnId: context.turnId,
      runId: context.harnessRunId,
      parentRunId: null,
      outerRunId: context.harnessRunId,
    },
    outcome,
  };
}

/** Production adapter shared by visible Execute Turns, approved Plan
 * continuations, ordinary Studio workflows, and internal Goal slices. */
export async function runSubmitRuntimeV2Execute(
  input: RuntimeV2ExecuteRunnerInput,
): Promise<RuntimeRunSettlement> {
  const initialState = input.get();
  const turn = currentTurn(initialState, input.context.turnId);
  if (!turn) throw new Error(`RUNTIME_V2_TURN_MISSING:${input.context.turnId}`);
  const identity = identityFor(initialState, input.context, turn);
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
    return settlement(
      input.context,
      terminalOutcomeToLegacy(
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
  const admittedAt = existing?.aggregate.events.find((event) =>
    event.type === "run.started"
  )?.at || Date.now();
  const lifecycleDeadlineAt =
    admittedAt + RUNTIME_V2_EXECUTION_DEADLINE_MS;
  const executionPorts = {
    get: input.get,
    set: input.set,
    context: input.context,
    live,
    nextId,
    now: Date.now,
    lifecycleDeadlineAt,
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
          input.context.executeAdmission?.acceptanceCriteria.every(
              (criterion) => !!criterion.evidenceRequirement,
            )
            ? input.context.executeAdmission.acceptanceCriteria.map(
                (criterion) => criterion.evidenceRequirement!,
              )
            : undefined,
        initialPhase: "preparing",
      });
    } else if (existing.aggregate.terminalOutcome) {
      const terminal = existing.aggregate.terminalOutcome;
      return settlement(input.context, terminalOutcomeToLegacy(terminal.resultKind, terminal.reason));
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
      if (Date.now() - admittedAt >= RUNTIME_V2_EXECUTION_DEADLINE_MS) {
        await controller.driveOnce(truthfulIncompleteDecision({
          aggregate: before,
        }));
        if (controller.snapshot().aggregate?.terminalOutcome) break;
        continue;
      }
      const terminal = terminalDecision({
        aggregate: before,
        signal: input.context.abortCtrl.signal,
      });
      if (terminal) {
        await controller.driveOnce(terminal);
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
          phaseTransitionMessage(phaseTransition.reason),
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
      const drove = await controller.driveOnce({
        subagentPreference:
          input.context.turnInputContextSignals.subagentPreference,
        subagentCapacity:
          resolveSubagentCapacityPolicy(
            input.get().config,
          ).maxActiveRequests,
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
      evidenceCount: controller.snapshot().aggregate?.evidence.length || 0,
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
    return settlement(input.context, terminalOutcomeToLegacy(outcome.resultKind, outcome.reason));
  } catch (error) {
    const aggregate = controller.snapshot().aggregate;
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
        return settlement(
          input.context,
          terminalOutcomeToLegacy(
            emergency.envelope.resultKind,
            emergency.envelope.reason,
          ),
        );
      }
      const terminal = controller.snapshot().aggregate?.terminalOutcome;
      if (terminal) {
        return settlement(
          input.context,
          terminalOutcomeToLegacy(
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
