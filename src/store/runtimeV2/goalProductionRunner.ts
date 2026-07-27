import {
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
  type AgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import {
  buildRuntimeV2CapsuleProjection,
  recordRuntimeV2GoalBoundary,
  RuntimeV2Controller,
  type RuntimeV2GoalOwnerIdentity,
  type RuntimeV2GoalSagaState,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
} from "../../lib/runtime-v2";
import type { GoalRuntimeSnapshot, GoalStatus } from "../../lib/goalState";
import type { ConversationTurn } from "../../lib/workflowModels";
import {
  createRuntimeV2CheckpointPort,
  getRuntimeV2Checkpoint,
} from "./checkpointPort";
import { createRuntimeV2GoalCheckpointFilePort } from "./goalCheckpointFilePort";
import {
  createRuntimeV2GoalSagaFromBoundary,
  driveRuntimeV2GoalSagaOnce,
  type RuntimeV2GoalSagaCheckpointPort,
} from "./goalRunner";
import {
  createRuntimeV2GoalProductionSlicePort,
  type RuntimeV2GoalProductionSlicePort,
} from "./goalSliceProductionPort";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import type { RuntimeV2ExecuteRunnerInput } from "./executeRunner";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

export interface RuntimeV2GoalProductionRunnerInput
  extends Omit<RuntimeV2ExecuteRunnerInput, "context"> {
  readonly context: RuntimeV2SubmissionContext;
  /** Test/recovery seams. Production uses the crash-safe file and Execute ports. */
  readonly goalCheckpoint?: RuntimeV2GoalSagaCheckpointPort;
  readonly goalSlice?: RuntimeV2GoalProductionSlicePort;
  readonly now?: () => number;
}

const GOAL_SUPERVISOR_DEADLINE_MS = 24 * 60 * 60_000;
const GOAL_LAUNCH_RECOVERY_LIMIT = 2;

function currentTurn(
  state: any,
  turnId: string,
): ConversationTurn | null {
  return state?.conversationTurns?.find(
    (turn: ConversationTurn) => turn.id === turnId,
  ) || null;
}

function identities(input: {
  readonly state: any;
  readonly context: RuntimeV2SubmissionContext;
  readonly turn: ConversationTurn;
}): {
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
} {
  const lifecycle = input.state?.planLifecycle;
  const sessionEpoch = lifecycle?.sessionKey === input.context.runSessionKey &&
    String(lifecycle.sessionEpoch || "").trim()
    ? String(lifecycle.sessionEpoch).trim()
    : `runtime-v2:${String(input.turn.clientSubmissionId || input.turn.id).trim()}`;
  return {
    turn: {
      workspaceKey: String(input.context.runWorkspace || "").trim(),
      sessionKey: input.context.runSessionKey,
      sessionEpoch,
      clientSubmissionId: String(
        input.turn.clientSubmissionId || input.turn.id,
      ).trim(),
      turnId: input.context.turnId,
    },
    run: {
      sessionKey: input.context.runSessionKey,
      sessionEpoch,
      turnId: input.context.turnId,
      runId: input.context.harnessRunId,
      parentRunId: null,
      attemptId: input.context.harnessRunId,
    },
  };
}

function legacyOutcome(
  resultKind: RuntimeV2ResultKind,
  reason: string,
): AgentLoopOutcome {
  return resultKind === "canceled"
    ? abortedAgentLoopOutcome(reason)
    : completedAgentLoopOutcome(reason, resultKind);
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

function goalRuntime(state: any): GoalRuntimeSnapshot {
  const runtime = state?.goalRuntime;
  if (!runtime?.goal || !runtime?.progress) {
    throw new Error("RUNTIME_V2_GOAL_RUNTIME_MISSING");
  }
  return runtime as GoalRuntimeSnapshot;
}

function initialSaga(input: {
  readonly state: any;
  readonly context: RuntimeV2SubmissionContext;
  readonly identity: ReturnType<typeof identities>;
  readonly now: number;
}): RuntimeV2GoalSagaState {
  return createRuntimeV2GoalSagaFromBoundary({
    runtime: goalRuntime(input.state),
    admission: {
      workspaceKey: input.identity.turn.workspaceKey,
      sessionKey: input.identity.turn.sessionKey,
      sessionEpoch: input.identity.turn.sessionEpoch,
      ownerTurnId: input.identity.turn.turnId,
      authority: input.context.goalContinuationAuthorization
        ? {
            kind: "legacy_continuation",
            authorization: input.context.goalContinuationAuthorization,
          }
        : {
            kind: "creation",
            authorized: !!input.context.goalCreationAuthorization,
          },
    },
    now: input.now,
  });
}

function projectedGoalStatus(resultKind: RuntimeV2ResultKind): GoalStatus {
  if (resultKind === "success") return "completed";
  if (resultKind === "canceled") return "cancelled";
  if (resultKind === "blocked") return "blocked";
  if (resultKind === "partial") return "budget_exceeded";
  return "failed";
}

function projectGoalTerminal(
  input: RuntimeV2GoalProductionRunnerInput,
  saga: RuntimeV2GoalSagaState,
): void {
  const terminal = saga.terminal;
  if (!terminal) return;
  const status = projectedGoalStatus(terminal.resultKind);
  input.set((state: any) => {
    const active = state.activeGoal;
    if (
      !active ||
      active.id !== saga.owner.goalId ||
      (active.revision || 1) !== saga.owner.goalRevision ||
      active.ownerTurnId !== saga.owner.ownerTurnId
    ) return {};
    const goal = {
      ...active,
      status,
      updatedAt: terminal.completedAt,
    };
    const progress = state.goalProgress
      ? {
          ...state.goalProgress,
          lastStopReason: terminal.reason,
          lastUpdatedAt: terminal.completedAt,
        }
      : state.goalProgress;
    return {
      activeGoal: goal,
      goalStatus: status,
      goalProgress: progress,
      // Compatibility projection only. Runtime v2 saga JSON remains the sole
      // writable Goal execution authority.
      goalRuntime: state.goalRuntime
        ? {
            ...state.goalRuntime,
            goal,
            progress: progress || state.goalRuntime.progress,
            status,
            phase: status === "completed" ? "observe" : "re_plan",
            updatedAt: terminal.completedAt,
          }
        : state.goalRuntime,
    };
  });
}

async function recordLaunchRecoveryBoundary(input: {
  readonly checkpoint: RuntimeV2GoalSagaCheckpointPort;
  readonly owner: RuntimeV2GoalOwnerIdentity;
  readonly reason: string;
  readonly now: number;
}): Promise<void> {
  const current = await input.checkpoint.load({ owner: input.owner });
  if (!current || current.state.terminal) return;
  await input.checkpoint.commit({
    owner: input.owner,
    expectedRevision: current.revision,
    state: recordRuntimeV2GoalBoundary(current.state, {
      kind: "recovery_exhausted",
      reason: input.reason,
      at: input.now,
    }),
  });
}

function goalFinalMarkdown(
  saga: RuntimeV2GoalSagaState,
  language: "zh" | "en",
): string {
  const terminal = saga.terminal!;
  if (language === "en") {
    return [
      "### Goal concluded",
      "",
      `- Result: ${terminal.resultKind}`,
      `- Work slices: ${saga.totalSlices}`,
      `- Durable evidence: ${saga.evidence.length}`,
      `- ${terminal.reason}`,
    ].join("\n");
  }
  return [
    "### Goal 已完成本轮收口",
    "",
    `- 结果：${terminal.resultKind}`,
    `- 工作切片：${saga.totalSlices}`,
    `- 已保留证据：${saga.evidence.length} 条`,
    `- ${terminal.reason}`,
  ].join("\n");
}

/**
 * Production Goal supervisor. Each work slice is an ordinary Runtime v2
 * Execute Turn; this runner owns only durable saga ordering and the one outer
 * visible conclusion.
 */
export async function runSubmitRuntimeV2Goal(
  input: RuntimeV2GoalProductionRunnerInput,
): Promise<RuntimeRunSettlement> {
  const now = input.now || Date.now;
  const workspace = String(input.context.runWorkspace || "").trim();
  if (!workspace) throw new Error("RUNTIME_V2_GOAL_REQUIRES_WORKSPACE");
  const state = input.get();
  const turn = currentTurn(state, input.context.turnId);
  if (!turn) throw new Error(`RUNTIME_V2_GOAL_TURN_MISSING:${input.context.turnId}`);
  const identity = identities({ state, context: input.context, turn });
  const checkpoint = createRuntimeV2CheckpointPort({
    get: input.get,
    set: input.set,
    scopeKey: input.context.runScopeKey,
    sessionId: input.context.runSessionId,
    getSessionRevisionToken: input.getSessionRevisionToken,
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    normalizeSessionRuntimeSnapshot: input.normalizeSessionRuntimeSnapshot,
    publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
    persistSessionRecord: input.persistSessionRecord,
    logStoreEvent: input.logStoreEvent,
  });
  const projection = createRuntimeV2ProjectionPort({
    get: input.get,
    set: input.set,
    nextTaskId: () => input.get()._nextTaskId(),
    language: input.context.phaseLanguage,
    logStoreEvent: input.logStoreEvent,
  });
  const existing = getRuntimeV2Checkpoint(state, identity.turn);
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) {
    throw new Error("RUNTIME_V2_GOAL_STALE_RUN_CHECKPOINT");
  }
  let ordinal = 0;
  const controller = new RuntimeV2Controller({
    checkpoint,
    provider: {
      async request() {
        throw new Error("RUNTIME_V2_GOAL_PROVIDER_SURFACE_DENIED");
      },
    },
    tool: {
      async execute() {
        throw new Error("RUNTIME_V2_GOAL_TOOL_SURFACE_DENIED");
      },
    },
    scheduler: {
      async execute() {
        throw new Error("RUNTIME_V2_GOAL_SCHEDULER_SURFACE_DENIED");
      },
    },
    projection,
    clockId: {
      now,
      nextId: (scope) => `${scope}:${identity.run.runId}:${++ordinal}`,
      nextIdempotencyKey: ({ run, kind }) =>
        `${run.runId}:${kind}:${++ordinal}`,
    },
  }, existing ? {
    aggregate: existing.aggregate,
    revision: existing.revision,
  } : undefined, {
    abortSignal: input.context.abortCtrl.signal,
  });

  if (existing?.aggregate.terminalOutcome) {
    clearInterval(
      input.context.timerInterval as ReturnType<typeof setInterval>,
    );
    const terminal = existing.aggregate.terminalOutcome;
    return settlement(
      input.context,
      legacyOutcome(terminal.resultKind, terminal.reason),
    );
  }

  const initial = initialSaga({
    state,
    context: input.context,
    identity,
    now: now(),
  });
  const sagaCheckpoint = input.goalCheckpoint ||
    createRuntimeV2GoalCheckpointFilePort({ workspace });
  const slice = input.goalSlice || createRuntimeV2GoalProductionSlicePort({
    get: input.get,
    set: input.set,
    workspace,
    sessionKey: input.context.runSessionKey,
    sessionId: input.context.runSessionId,
    scopeKey: input.context.runScopeKey,
    language: input.context.phaseLanguage,
    turnInputContextSignals: input.context.turnInputContextSignals,
    getSessionRevisionToken: input.getSessionRevisionToken,
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    normalizeSessionRuntimeSnapshot: input.normalizeSessionRuntimeSnapshot,
    publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
    persistSessionRecord: input.persistSessionRecord,
    logStoreEvent: input.logStoreEvent,
  });

  try {
    if (!existing) {
      await controller.admit({
        turn: identity.turn,
        run: identity.run,
        strategy: "goal",
        objective: initial.objective.text,
        constraints: initial.objective.constraints,
        acceptanceCriteria: initial.objective.acceptanceCriteria,
        initialPhase: "acting",
      });
      await controller.publishMilestoneStatus(
        input.context.phaseLanguage === "en"
          ? "### Goal execution started\n\n- MAIN will run finite Execute slices and preserve evidence between them."
          : "### Goal 执行已启动\n\n- MAIN 将使用有限的 Execute 工作切片，并在切片之间保留可信证据。",
        `goal-start:${initial.owner.goalId}:${initial.owner.goalRevision}`,
      );
    }

    const supervisorStartedAt = now();
    let launchFailures = 0;
    while (true) {
      if (now() - supervisorStartedAt >= GOAL_SUPERVISOR_DEADLINE_MS) {
        await recordLaunchRecoveryBoundary({
          checkpoint: sagaCheckpoint,
          owner: initial.owner,
          reason: "Goal supervisor lifecycle deadline reached.",
          now: now(),
        });
      }
      const step = await driveRuntimeV2GoalSagaOnce({
        ports: { checkpoint: sagaCheckpoint, slice },
        owner: initial.owner,
        initialState: initial,
        signal: input.context.abortCtrl.signal,
        now,
      });
      input.logStoreEvent("runtime_v2_goal_step", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        goalId: initial.owner.goalId,
        disposition: step.disposition,
        revision: step.checkpoint?.revision || null,
        sliceId: "request" in step ? step.request.sliceId : null,
      });
      if (step.disposition === "superseded") {
        await controller.driveOnce({
          resultKind: "error",
          resultReason: "Goal saga ownership changed before the current operation could commit.",
        });
        break;
      }
      if (step.disposition === "launch_uncertain") {
        launchFailures += 1;
        await controller.publishLiveStatus(
          input.context.phaseLanguage === "en"
            ? `The Goal slice launch is being reconciled from its durable identity.\n\n\`${step.request.sliceId}\``
            : `正在根据持久化身份核对 Goal 工作切片是否已经启动。\n\n\`${step.request.sliceId}\``,
          `goal-launch-recovery:${step.request.sliceId}:${launchFailures}`,
        );
        if (launchFailures >= GOAL_LAUNCH_RECOVERY_LIMIT) {
          await recordLaunchRecoveryBoundary({
            checkpoint: sagaCheckpoint,
            owner: initial.owner,
            reason: `Goal slice launch could not be reconciled: ${step.error}`,
            now: now(),
          });
        }
        continue;
      }
      if (
        step.disposition === "launched" ||
        step.disposition === "resumed_launch"
      ) {
        launchFailures = 0;
        await controller.publishMilestoneStatus(
          input.context.phaseLanguage === "en"
            ? `### Goal work slice started\n\n- Slice: \`${step.request.sliceId}\`\n- Remaining criteria: ${step.request.criteria.length}`
            : `### 已启动 Goal 工作切片\n\n- 切片：\`${step.request.sliceId}\`\n- 待满足条件：${step.request.criteria.length} 项`,
          `goal-slice-launched:${step.request.sliceId}`,
        );
      }
      if (
        step.disposition === "launched" ||
        step.disposition === "resumed_launch" ||
        step.disposition === "running"
      ) {
        const inner = getRuntimeV2Checkpoint(
          input.get(),
          step.request.turn,
        );
        const liveMarkdown = inner
          ? buildRuntimeV2CapsuleProjection(
              inner.aggregate,
              `goal-inner:${step.request.sliceId}`,
            ).markdown
          : input.context.phaseLanguage === "en"
            ? `Executing Goal work slice \`${step.request.sliceId}\`.`
            : `正在执行 Goal 工作切片 \`${step.request.sliceId}\`。`;
        await controller.publishLiveStatus(
          liveMarkdown,
          `goal-slice-live:${step.request.sliceId}:${inner?.revision || 0}`,
        );
        await slice.waitForChange({
          request: step.request,
          signal: input.context.abortCtrl.signal,
        });
        continue;
      }
      if (
        step.disposition === "slice_settled" ||
        step.disposition === "continued"
      ) {
        const saga = step.checkpoint.state;
        await controller.publishMilestoneStatus(
          input.context.phaseLanguage === "en"
            ? `### Goal evidence checkpoint\n\n- Completed slices: ${saga.totalSlices}\n- Durable evidence: ${saga.evidence.length}`
            : `### Goal 证据检查点\n\n- 已完成切片：${saga.totalSlices}\n- 已保留证据：${saga.evidence.length} 条`,
          `goal-slice-settled:${saga.totalSlices}:${saga.evidence.length}`,
        );
        continue;
      }
      if (step.disposition === "completed") {
        const saga = step.checkpoint.state;
        if (!saga.terminal) {
          throw new Error("RUNTIME_V2_GOAL_TERMINAL_MISSING");
        }
        projectGoalTerminal(input, saga);
        await controller.driveOnce({
          resultKind: saga.terminal.resultKind,
          resultReason: saga.terminal.reason,
          finalMarkdown: goalFinalMarkdown(
            saga,
            input.context.phaseLanguage,
          ),
        });
        break;
      }
    }

    const terminal = controller.snapshot().aggregate?.terminalOutcome;
    if (!terminal) throw new Error("RUNTIME_V2_GOAL_OUTER_TERMINAL_MISSING");
    return settlement(
      input.context,
      legacyOutcome(terminal.resultKind, terminal.reason),
    );
  } finally {
    clearInterval(
      input.context.timerInterval as ReturnType<typeof setInterval>,
    );
  }
}
