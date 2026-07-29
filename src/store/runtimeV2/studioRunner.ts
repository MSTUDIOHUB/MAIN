import {
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
  type AgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import {
  RuntimeV2Controller,
  deriveRuntimeV2StudioLedgerState,
  runtimeV2StudioActionDigest,
  runtimeV2StudioActionFromCommand,
  runtimeV2StudioActionPlanDigest,
  validateRuntimeV2StudioActionPlan,
  RUNTIME_V2_STUDIO_TOOL_NAME,
  type RuntimeV2Command,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2StudioAction,
  type RuntimeV2TurnIdentity,
} from "../../lib/runtime-v2";
import type { ConversationTurn } from "../../lib/workflowModels";
import {
  createRuntimeV2CheckpointPort,
  getRuntimeV2Checkpoint,
} from "./checkpointPort";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import {
  createGameStudioRuntimeV2ExternalPort,
  executeRuntimeV2StudioAction,
  type RuntimeV2GameStudioServicePort,
  type RuntimeV2StudioReceiptPort,
} from "./studioAdapter";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2StudioRunnerInput {
  readonly get: StoreGet;
  readonly set: StoreSet;
  readonly context: RuntimeV2SubmissionContext;
  /** Frozen by the submission boundary; runtime validates it again. */
  readonly actions: readonly RuntimeV2StudioAction[];
  readonly runtimeService: RuntimeV2GameStudioServicePort;
  readonly studioReceipts: RuntimeV2StudioReceiptPort;
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
  readonly persistSessionRecord: (
    scopeKey: string,
    session: unknown,
  ) => Promise<unknown>;
  readonly logStoreEvent: (
    event: string,
    data?: Record<string, unknown>,
  ) => void;
  readonly now?: () => number;
  readonly deadlineMs?: number;
}

const STUDIO_DEADLINE_MS = 4 * 60_000;
const STUDIO_PLAN_CONSTRAINT_PREFIX = "runtime-v2-studio-plan:";

function currentTurn(state: any, turnId: string): ConversationTurn | null {
  return state?.conversationTurns?.find(
    (turn: ConversationTurn) => turn.id === turnId,
  ) || null;
}

function identities(
  state: any,
  context: RuntimeV2SubmissionContext,
  turn: ConversationTurn,
): {
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
} {
  const lifecycle = state?.planLifecycle;
  const sessionEpoch = lifecycle?.sessionKey === context.runSessionKey &&
    String(lifecycle.sessionEpoch || "").trim()
    ? String(lifecycle.sessionEpoch).trim()
    : `runtime-v2:${String(turn.clientSubmissionId || turn.id).trim()}`;
  return {
    turn: {
      workspaceKey: String(context.runWorkspace || "").trim(),
      sessionKey: context.runSessionKey,
      sessionEpoch,
      clientSubmissionId: String(turn.clientSubmissionId || turn.id).trim(),
      turnId: context.turnId,
    },
    run: {
      sessionKey: context.runSessionKey,
      sessionEpoch,
      turnId: context.turnId,
      runId: context.harnessRunId,
      parentRunId: null,
      attemptId: context.harnessRunId,
    },
  };
}

function toLegacyOutcome(
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

function actionPlanConstraint(
  actions: readonly RuntimeV2StudioAction[],
): string {
  return `${STUDIO_PLAN_CONSTRAINT_PREFIX}${runtimeV2StudioActionPlanDigest(actions)}`;
}

function studioCommand(input: {
  readonly run: RuntimeV2RunIdentity;
  readonly action: RuntimeV2StudioAction;
  readonly index: number;
  readonly planConstraint: string;
}): RuntimeV2Command {
  const digest = runtimeV2StudioActionDigest(input.action);
  return {
    idempotencyKey: [
      input.run.runId,
      "studio",
      input.index,
      digest,
    ].join(":"),
    kind: "execute_tool",
    run: input.run,
    phase: "acting",
    payload: {
      toolCallId: `studio-action-${input.index}`,
      toolName: RUNTIME_V2_STUDIO_TOOL_NAME,
      arguments: input.action,
      actionFingerprint: `${input.planConstraint}:${input.index}:${digest}`,
      attempt: 1,
    },
  };
}

function checkpointOwnsPlan(
  aggregate: NonNullable<
    ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"]
  >,
  planConstraint: string,
): boolean {
  return aggregate.strategy === "execute" &&
    aggregate.objective.constraints.length === 1 &&
    aggregate.objective.constraints[0] === planConstraint &&
    (aggregate.phase === "acting" ||
      aggregate.phase === "finalizing" ||
      aggregate.phase === "completed") &&
    aggregate.events.every((event) =>
      event.type !== "command.scheduled" ||
      event.command.kind === "finalize_turn" ||
      !!runtimeV2StudioActionFromCommand(event.command)
    );
}

function completedPlanPrefixMatches(
  aggregate: NonNullable<
    ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"]
  >,
  actions: readonly RuntimeV2StudioAction[],
): boolean {
  const completed = deriveRuntimeV2StudioLedgerState(aggregate).successfulActions;
  return completed.length <= actions.length &&
    completed.every((action, index) =>
      runtimeV2StudioActionDigest(action) ===
      runtimeV2StudioActionDigest(actions[index]!)
    );
}

function latestStudioToolStatus(
  aggregate: NonNullable<
    ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"]
  >,
): "succeeded" | "failed" | "blocked" | null {
  const studioCommands = new Set(
    aggregate.events.flatMap((event) =>
      event.type === "command.scheduled" &&
      runtimeV2StudioActionFromCommand(event.command)
        ? [event.command.idempotencyKey]
        : []
    ),
  );
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (
      event.type === "tool.completed" &&
      studioCommands.has(event.idempotencyKey)
    ) return event.status;
  }
  return null;
}

function blockedToolEvent(
  command: RuntimeV2Command,
  reason: string,
) {
  return {
    type: "tool.completed" as const,
    run: command.run,
    idempotencyKey: command.idempotencyKey,
    status: "blocked" as const,
    evidence: [{
      id: `studio-runner-${command.idempotencyKey}`,
      kind: "tool" as const,
      target: "game-studio:workspace:audit",
      version: `studio-runner:${reason}`,
    }],
  };
}

/**
 * Top-level deterministic Studio runner. The submission layer supplies one
 * frozen structured action plan; this function owns neither model parsing nor
 * Store/UI state and concludes through the ordinary Runtime v2 controller.
 */
export async function runSubmitRuntimeV2Studio(
  input: RuntimeV2StudioRunnerInput,
): Promise<RuntimeRunSettlement> {
  const now = input.now || Date.now;
  const workspace = String(input.context.runWorkspace || "").trim();
  if (!workspace) throw new Error("RUNTIME_V2_STUDIO_REQUIRES_WORKSPACE");
  const validatedPlan = validateRuntimeV2StudioActionPlan(input.actions);
  if (!validatedPlan.ok) {
    throw new Error(`RUNTIME_V2_STUDIO_${validatedPlan.reason.toUpperCase()}`);
  }
  const actions = validatedPlan.actions;
  const planConstraint = actionPlanConstraint(actions);
  const initialState = input.get();
  const turn = currentTurn(initialState, input.context.turnId);
  if (!turn) {
    throw new Error(`RUNTIME_V2_STUDIO_TURN_MISSING:${input.context.turnId}`);
  }
  const identity = identities(initialState, input.context, turn);
  const existing = getRuntimeV2Checkpoint(initialState, identity.turn);
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) {
    input.logStoreEvent("runtime_v2_studio_stale_checkpoint_quarantined", {
      turnId: identity.turn.turnId,
      requestedRunId: identity.run.runId,
      checkpointRunId: existing.aggregate.run?.identity.runId || null,
      revision: existing.revision,
    });
    throw new Error("RUNTIME_V2_STUDIO_STALE_RUN_CHECKPOINT");
  }
  if (existing?.aggregate.terminalOutcome) {
    const terminal = existing.aggregate.terminalOutcome;
    return settlement(
      input.context,
      toLegacyOutcome(terminal.resultKind, terminal.reason),
    );
  }

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
  const external = createGameStudioRuntimeV2ExternalPort(input.runtimeService);
  const coldCommandKeys = new Set(
    existing?.aggregate.scheduledCommands.map(
      (command) => command.idempotencyKey,
    ) || [],
  );
  const authorityCompatible = !existing ||
    checkpointOwnsPlan(existing.aggregate, planConstraint);
  let ordinal = 0;
  const nextId = (scope: string) =>
    `${scope}:${now().toString(36)}:${++ordinal}`;
  let controller: RuntimeV2Controller;
  controller = new RuntimeV2Controller({
    checkpoint,
    provider: {
      async request() {
        throw new Error("RUNTIME_V2_STUDIO_PROVIDER_SURFACE_DENIED");
      },
    },
    tool: {
      async execute({ command, signal }) {
        if (!authorityCompatible || !runtimeV2StudioActionFromCommand(command)) {
          return blockedToolEvent(
            command,
            authorityCompatible
              ? "non_studio_command"
              : "action_plan_authority_mismatch",
          );
        }
        const aggregate = controller.snapshot().aggregate;
        if (!aggregate) return blockedToolEvent(command, "aggregate_missing");
        const cold = coldCommandKeys.delete(command.idempotencyKey);
        return executeRuntimeV2StudioAction({
          aggregate,
          command,
          mode: cold ? "cold_resume" : "fresh",
          signal,
          external,
          receipts: input.studioReceipts,
          now,
        });
      },
    },
    scheduler: {
      async execute() {
        throw new Error("RUNTIME_V2_STUDIO_SCHEDULER_SURFACE_DENIED");
      },
    },
    projection: createRuntimeV2ProjectionPort({
      get: input.get,
      set: input.set,
      nextTaskId: () => input.get()._nextTaskId(),
      language: input.context.phaseLanguage,
      logStoreEvent: input.logStoreEvent,
    }),
    clockId: {
      now,
      nextId,
      nextIdempotencyKey: ({ run, kind }) =>
        `${run.runId}:${kind}:${nextId("idempotency")}`,
    },
  }, existing ? {
    aggregate: existing.aggregate,
    revision: existing.revision,
  } : undefined, {
    abortSignal: input.context.abortCtrl.signal,
  });

  try {
    if (!existing) {
      await controller.admit({
        turn: identity.turn,
        run: identity.run,
        strategy: "execute",
        objective: turn.userPrompt,
        constraints: [planConstraint],
        acceptanceCriteria: [
          "The frozen Studio action sequence ends with a durable observation.",
        ],
        initialPhase: "acting",
      });
      input.logStoreEvent("runtime_v2_studio_admitted", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        actionCount: actions.length,
        planDigest: runtimeV2StudioActionPlanDigest(actions),
      });
    } else if (existing.aggregate.scheduledCommands.length > 0) {
      await controller.resumeScheduled();
    }

    const admittedAt = controller.snapshot().aggregate?.events.find(
      (event) => event.type === "run.started",
    )?.at || now();
    const deadlineMs = Math.max(1, input.deadlineMs ?? STUDIO_DEADLINE_MS);
    while (true) {
      const aggregate = controller.snapshot().aggregate;
      if (!aggregate || aggregate.terminalOutcome) break;
      if (!authorityCompatible || !completedPlanPrefixMatches(aggregate, actions)) {
        await controller.driveOnce({
          resultKind: "error",
          resultReason: "Studio 动作计划的身份或已提交前缀不一致；运行时未执行未获授权的外部效果。",
        });
        break;
      }
      if (input.context.abortCtrl.signal.aborted) {
        await controller.driveOnce();
        break;
      }
      if (now() - admittedAt >= deadlineMs) {
        await controller.driveOnce({
          resultKind: "partial",
          resultReason: "Studio 动作已到达运行生命周期时限；已保留收据和观察证据，并完成终态收口。",
        });
        break;
      }
      const lifecycle = deriveRuntimeV2StudioLedgerState(aggregate);
      const completedCount = lifecycle.successfulActions.length;
      const latestStatus = latestStudioToolStatus(aggregate);
      if (latestStatus && latestStatus !== "succeeded") {
        await controller.driveOnce({
          resultKind: completedCount > 0 ? "partial" : "error",
          resultReason: latestStatus === "blocked"
            ? "Studio 外部效果没有获得可确认的 durable 收据；运行时已停止未知写入重放并保留现有证据。"
            : "Studio 外部端口未完成当前结构化动作；运行时已保留先前证据并完成终态收口。",
        });
        break;
      }
      if (completedCount === actions.length) {
        await controller.driveOnce({
          resultKind: "success",
          resultReason: "已按冻结顺序完成 Studio 动作，并以最终只读观察确认外部状态。",
        });
        break;
      }
      const command = studioCommand({
        run: identity.run,
        action: actions[completedCount]!,
        index: completedCount,
        planConstraint,
      });
      await controller.schedule(command);
      await controller.resumeScheduled();
    }

    const terminal = controller.snapshot().aggregate?.terminalOutcome;
    if (!terminal) throw new Error("RUNTIME_V2_STUDIO_TERMINAL_MISSING");
    input.logStoreEvent("runtime_v2_studio_terminal", {
      turnId: identity.turn.turnId,
      runId: identity.run.runId,
      resultKind: terminal.resultKind,
      reason: terminal.reason,
      completedActions: deriveRuntimeV2StudioLedgerState(
        controller.snapshot().aggregate!,
      ).successfulActions.length,
    });
    return settlement(
      input.context,
      toLegacyOutcome(terminal.resultKind, terminal.reason),
    );
  } finally {
    clearInterval(input.context.timerInterval as ReturnType<typeof setInterval>);
  }
}
