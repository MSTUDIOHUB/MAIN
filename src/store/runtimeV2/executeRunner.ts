import { latestRuntimeV2Answer } from "../../lib/runtime-v2/providerAnswer";
import {
  abortedAgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import type { SubmitSessionPersistence } from "../persistSubmitRuntimeProjection";
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
  runtimeV2ProviderRecoveryStallExpired,
  runtimeV2CheckpointWriteFailureReason,
  summarizeRuntimeV2ExecuteEvidence,
  runtimeV2WorkspaceChangeReceipts,
  type RuntimeV2ProviderRecoveryStallLease,
} from "../../lib/runtime-v2";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import { approvedPlanExecutionRepair, retryableUnityEditorCheck, unresolvedUnityEditorCheck } from "../../lib/runtime-v2/unityCompilation";
import { normalizeNetworkRead } from "../../lib/networkRead";
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
  runtimeV2ExecuteAcceptanceEvidenceRequirements,
} from "./executionAcceptance";
import {
  runtimeV2ExecuteTerminalDecision,
  runtimeV2PhaseTransitionMessage,
} from "./executionOutcome";
import {
  createRuntimeV2RunnerIdentity,
  createRuntimeV2RunnerSettlement,
  runtimeV2TerminalOutcomeToLegacy,
} from "./executionRunnerIdentity";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import { restoreRuntimeV2SkillHistory } from "./executionSkillHistory";
import { restoreRuntimeV2ExecutionHistory } from "./executionProviderHistory";
import { projectFiniteValidationCommands } from "./executionProviderContext";
import { isProjectBaselineForWorkspace } from "../../lib/workspaceAdmission";
import { pausedAgentLoopOutcome } from "../../lib/runOutcome";
import { projectRuntimeV2ExecutionBlocker } from "./executionBlocker";
import { createRuntimeV2PlanReviewCommit, resolveApprovedRuntimeV2WorkPlanFromAggregate } from "./workPlanAdapter";
import { deriveProactiveCollaboration } from "./proactiveSubagents";
import { isRuntimeV2EditorDiagnosticRepair } from "../../lib/runtime-v2/editorConsoleEvidence";
import { checkApprovedPlanArtifact, checkCarriedWorkPlanTargets, resolveApprovedWorkPlanContinuation, verifyApprovedWorkPlanContinuation } from "./approvedPlanContinuation";
import {
  resolveRuntimeV2ObjectiveAdmission,
  type RuntimeV2SubmissionContext,
} from "./submissionContext";

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
  readonly persistSessionRecord: SubmitSessionPersistence;
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
 * continuations, and internal Goal slices. */
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
  const requestedContinuation = input.context.approvedPlanContinuation || turn.approvedPlanContinuation;
  const continuationReference = requestedContinuation?.revise ? undefined : requestedContinuation;
  const continuationSource = continuationReference && resolveApprovedWorkPlanContinuation(initialState, continuationReference, identity.turn);
  input = { ...input, context: { ...input.context,
    networkRead: normalizeNetworkRead(existing ? existing.aggregate.networkRead : turn.networkRead),
    ...(existing ? { knowledgeContext: existing.aggregate.knowledgeContext,
      workspaceInstructionContext: existing.aggregate.workspaceInstructionContext ?? input.context.workspaceInstructionContext } : {}) } };
  if (existing && !existing.aggregate.terminalOutcome) restoreRuntimeV2ExecutionHistory(live, existing.aggregate);
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
  let recordUserWait: (commandKey: string, requestId: string, waiting: boolean) => Promise<void> = async () => {};
  const executionPorts = {
    recordUserWait: (commandKey: string, requestId: string, waiting: boolean) => recordUserWait(commandKey, requestId, waiting),
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
    logEvent: input.logStoreEvent,
  });
  let providerRecoveryLease: RuntimeV2ProviderRecoveryStallLease | null = null;
  recordUserWait = (commandKey, requestId, waiting) => controller.recordUserWait(commandKey, requestId, waiting);

  try {
    if (!existing) {
      const admission = resolveRuntimeV2ObjectiveAdmission(
        input.context,
        turn.userPrompt,
      );
      input.logStoreEvent("runtime_v2_execute_admitted", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        sessionKey: identity.turn.sessionKey,
        workspaceKey: identity.turn.workspaceKey,
        strategy: continuationReference ? "plan" : "execute",
        completionRequirement: continuationReference ? null : admission.completionRequirement?.kind || null,
      });
      await controller.admit({
        turn: identity.turn,
        run: identity.run,
        strategy: continuationReference ? "plan" : "execute",
        objective: continuationSource ? continuationSource.aggregate.objective.text : admission.objective,
        completionRequirement: continuationSource ? undefined : admission.completionRequirement,
        networkRead: input.context.networkRead,
        knowledgeContext: input.context.knowledgeContext,
        workspaceInstructionContext: input.context.workspaceInstructionContext,
        capabilityRestrictions: admission.capabilityRestrictions,
        approvalRequiredCapabilities: admission.approvalRequiredCapabilities,
        constraints: continuationSource ? continuationSource.aggregate.objective.constraints : admission.constraints,
        acceptanceCriteria: continuationSource ? continuationSource.aggregate.objective.acceptanceCriteria : admission.acceptanceCriteria.map(
          (criterion) => criterion.text,
        ),
        acceptanceCriterionIds: continuationSource ? continuationSource.aggregate.objective.acceptanceCriterionIds : admission.acceptanceCriteria.map(
          (criterion) => criterion.id,
        ),
        acceptanceEvidenceRequirements:
          continuationSource ? continuationSource.aggregate.objective.acceptanceEvidenceRequirements : runtimeV2ExecuteAcceptanceEvidenceRequirements(
            admission.acceptanceCriteria,
          ),
        initialPhase: continuationReference ? "planning" : isProjectBaselineForWorkspace(input.context.projectBaselineContext, input.context.runWorkspace || "") || admission.capabilityRestrictions?.includes("workspace_read") || admission.approvalRequiredCapabilities?.includes("workspace_read") ? "observing" : "preparing",
      });
    } else if (existing.aggregate.terminalOutcome) {
      const terminal = existing.aggregate.terminalOutcome;
      await controller.resumeTerminalProjection();
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
    }

    if (continuationReference && !controller.snapshot().aggregate?.terminalOutcome) {
      const current = controller.snapshot().aggregate!;
      const signal = input.context.abortCtrl.signal;
      const workspace = input.context.runWorkspace || "";
      const en = input.context.phaseLanguage === "en";
      const checkingStarted = Date.now();
      if (!continuationSource || !workspace ||
          current.objective.capabilityRestrictions?.includes("workspace_read") ||
          current.objective.approvalRequiredCapabilities?.includes("workspace_read")) {
        await controller.finishTerminal("blocked", en ? "The approved plan or permission for its file checks is no longer valid."
          : "原计划的批准记录或文件核对权限已失效，请在 Plan 面板复核。");
      } else if (approvedPlanExecutionRepair(continuationSource.aggregate)) {
        await controller.finishTerminal("blocked", en ? "Review the pending repair in the Plan panel before continuing."
          : "请先在 Plan 面板复核待批准的修复，再继续执行。");
      } else {
        const verified = current.workPlan?.status === "approved"
          ? { changed: [
              ...await checkApprovedPlanArtifact(continuationSource, signal),
              ...await checkCarriedWorkPlanTargets(current, workspace, signal),
            ] }
          : await verifyApprovedWorkPlanContinuation(continuationSource, workspace, signal);
        signal.throwIfAborted();
        if ("changed" in verified && verified.changed.length) {
          for (const [index, target] of verified.changed.entries()) {
            await controller.recordObservation({ id: `approved-plan-drift:${index}`, kind: "tool", target });
          }
          const heading = en ? "Review these changes before continuing the approved plan."
            : "继续执行前，请在 Plan 面板复核以下文件。";
          await controller.finishTerminal("blocked", heading, [heading, "", ...verified.changed.map(target => `- ${target}`)].join("\n"));
        } else if ("continuation" in verified &&
            !resolveApprovedWorkPlanContinuation(input.get(), continuationReference, identity.turn)) {
          await controller.finishTerminal("blocked", en ? "The approved plan changed during continuation checks."
            : "核对期间原计划的批准状态已变化，请在 Plan 面板复核。");
        } else if ("continuation" in verified) {
          const commit = current.planReviewCommit || createRuntimeV2PlanReviewCommit({
            plan: continuationSource.plan, turn: identity.turn, run: identity.run,
            requestId: `runtime-v2-plan-continuation:${identity.run.runId}`, createdAt: Date.now(),
          });
          if (!current.workPlan) await controller.commitPlanContinuationEvent({
            type: "work_plan.sealed", run: identity.run,
            workPlan: { ...commit.authority, status: "pending_review" },
            sealedPlan: continuationSource.plan, reviewCommit: commit, continuation: verified.continuation,
          });
          await controller.commitPlanContinuationEvent({
            type: "work_plan.approved", run: identity.run,
            workPlan: { ...commit.authority, status: "approved" },
            continuationApprovalId: verified.continuation.source.approvalEventId,
          });
        }
        const bound = controller.snapshot().aggregate;
        if (bound?.planContinuation && bound.phase === "preparing" && !bound.terminalOutcome) {
          await controller.changePhase("observing", "Approved WorkPlan continuation verified against current file versions.");
        }
      }
      input.logStoreEvent("approved_work_plan_continuation_checked", {
        turnId: identity.turn.turnId, runId: identity.run.runId,
        sourceTurnId: continuationReference.turn?.turnId ?? null, elapsedMs: Date.now() - checkingStarted,
        outcome: controller.snapshot().aggregate?.terminalOutcome?.resultKind ?? "verified",
      });
    }

    if (existing && !controller.snapshot().aggregate?.terminalOutcome &&
        existing.migrationDisposition !== "active_uncontracted_mutation" &&
        existing.migrationDisposition !== "active_unmodified") {
      restoreRuntimeV2SkillHistory(live, existing.aggregate, identity.run);
      input.logStoreEvent("runtime_v2_execute_resuming_scheduled", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        checkpointRevision: existing.revision,
        scheduledKind: existing.aggregate.scheduledCommands[0]?.kind || null,
      });
      await controller.restoreProactiveSubagents();
      await controller.resumeScheduled();
    }

    while (true) {
      const before = controller.snapshot().aggregate;
      if (!before || before.terminalOutcome) break;
      if (before.run?.status === "paused") {
        if (before.run.blocker?.decision && before.run.blocker.decision !== "stop") {
          await controller.resumeRun(before.run.blocker.requestId);
          live.messages.push({ role: "system", content: before.run.blocker.decisionSource === "editor_reconnected"
            ? "The exact project Editor became available. Recheck the committed files under the existing authority."
            : "The user requested a recheck of the paused prerequisite. Re-observe the exact prerequisite before retrying; no extra permissions or acceptance were granted." });
          input.set((state: any) => ({ activeActionRequest: null, conversationTurns: state.conversationTurns.map((turn: any) => turn.id === before.turn.turnId ? { ...turn, status: "executing", runtimeOutcome: undefined } : turn) }));
          continue;
        }
        projectRuntimeV2ExecutionBlocker({ aggregate: before, get: input.get, set: input.set, language: input.context.phaseLanguage });
        return createRuntimeV2RunnerSettlement(input.context, pausedAgentLoopOutcome(before.run.blocker?.reasonCode || "action_required", "action_required"));
      }
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
        for (const [index, target] of (live.permissionRejection.continuationDriftTargets || []).entries()) {
          await controller.recordObservation({ id: `approved-plan-drift:${index}`, kind: "tool", target });
        }
        await controller.driveOnce({
          resultKind: "blocked",
          resultReason: live.permissionRejection.reason,
          finalMarkdown: live.permissionRejection.finalMarkdown,
        });
        continue;
      }
      const repair = approvedPlanExecutionRepair(before);
      if (repair) {
        const heading = input.context.phaseLanguage === "en"
          ? "The next fix requires a scoped Plan revision. Review it in the Plan panel."
          : "下一步需要修订已批准的范围，请在 Plan 面板复核。";
        await controller.driveOnce({ resultKind: "blocked", resultReason: heading,
          finalMarkdown: [heading, `\`${repair.target.replace(/\x60/g, "")}\``, repair.diagnostic].filter(Boolean).join("\n\n") });
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
        runtimeV2WorkspaceChangeReceipts(before).length === 0
      ) {
        const freshness = deriveRuntimeV2PlanSourceFreshness(before);
        const invalidTargets = freshness
          ? [...freshness.staleTargets]
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
      // Persist the compiler operation after the successful write receipt,
      // before the next provider decision or any pending test call.
      if (!before.recovery.exhausted && await controller.driveOnce({ checkUnityCompilation: true })) continue;
      const editorCheck = retryableUnityEditorCheck(before);
      const finishedProviderWork = editorCheck && latestRuntimeV2Answer(before);
      if (editorCheck && finishedProviderWork && !input.context.abortCtrl.signal.aborted && !before.recovery.exhausted) {
        const en = input.context.phaseLanguage === "en";
        const pending = before.run?.blocker;
        if (pending?.reasonCode === "unity_editor_verification_pending" &&
            pending.evidenceSequence === editorCheck.sequence && pending.decision === "continue") {
          const reason = en ? "Changes retained. Editor verification is pending." : "修改已保留，等待 Editor 验证。";
          await controller.driveOnce({ resultKind: "partial", resultReason: reason,
            finalMarkdown: [reason, editorCheck.result.message].filter(Boolean).join("\n\n") });
        } else {
          await controller.pauseRun({
            requestId: nextId("editor-verification"),
            reasonCode: "unity_editor_verification_pending",
            evidenceSequence: editorCheck.sequence,
            message: en ? "The current Editor did not return a verified result. Recheck when the exact project Editor is ready, or finish with the changes retained."
              : "当前 Editor 未返回可核验结果。对应项目的 Editor 就绪后可重新检查，也可以保留修改并结束本轮。",
            options: ["recheck", "continue", "stop"],
            independentWork: ["report_pending_editor_verification"],
          });
        }
        continue;
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
      if (
        providerRecoveryPressure &&
        runtimeV2ProviderRecoveryStallExpired(
          providerRecoveryLease,
          Date.now(),
        )
      ) {
        input.logStoreEvent(
          "runtime_v2_provider_recovery_stall_reached",
          {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            phase: before.phase,
            reason: providerRecoveryPressure.reason,
            occurrence: providerRecoveryPressure.occurrence,
            recoveryStartedAt: providerRecoveryLease?.startedAt || null,
          },
        );
        await controller.pauseRun({ requestId: nextId("execution-choice"), reasonCode: "recovery_stalled", evidenceSequence: before.events[before.events.length - 1]!.sequence,
          message: input.context.phaseLanguage === "zh" ? "恢复过程持续未产生新进展。请检查所需资源或权限后重新检查，或停止任务。" : "Recovery made no new progress. Check prerequisites and recheck, or stop.", options: ["recheck", "stop"] });
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
        await controller.changePhase("observing", "初始准备已处理，继续获取本轮任务所需的信息。");
        continue;
      }
      const subagentPolicy = resolveSubagentCapacityPolicy(
        input.get().config,
      );
      const subagentPreference = input.context.turnInputContextSignals.subagentPreference;
      const projectValidators = before.phase === "validating" && !isRuntimeV2EditorDiagnosticRepair(before) && providerRecoveryPressure?.reason === "non_actionable_response"
        ? projectFiniteValidationCommands(input).filter(option => option.capability === "test") : [];
      const drove = await controller.driveOnce({
        projectValidationRecovery: projectValidators.length === 1 ? projectValidators[0] : undefined,
        subagentPreference,
        subagentCapacity: subagentPolicy.maxActiveRequests,
        subagentRequestMode: subagentPolicy.modelRequestMode,
        proactiveCollaboration: deriveProactiveCollaboration({ state: before, preference: subagentPreference,
          capacity: subagentPolicy.maxActiveRequests, requestMode: subagentPolicy.modelRequestMode,
          baseline: input.context.projectBaselineContext, workspace: input.context.runWorkspace,
          language: input.context.phaseLanguage, now: Date.now() }),
        settledProactiveJobIds: [...live.childTelemetry].filter(([, telemetry]) => telemetry.closedAt !== null).map(([id]) => id),
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
      verificationComplete: !unresolvedUnityEditorCheck(finalAggregate) && (planCoverage
        ? planCoverage.allMutationTargetsCovered &&
          planCoverage.allRequiredValidationsPassed
        : executionEvidence.mutationCount > 0 &&
          runtimeV2DirectExecuteReadyForConclusion(finalAggregate) &&
          executionEvidence.failedValidationCount === 0),
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
      const hasMutation = runtimeV2WorkspaceChangeReceipts(aggregate).length > 0 || live.hasExecutedMutationEffect;
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
