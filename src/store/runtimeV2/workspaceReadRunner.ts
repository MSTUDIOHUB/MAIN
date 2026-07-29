import {
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
  type AgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import {
  RuntimeV2Controller,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
} from "../../lib/runtime-v2";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import type { ConversationTurn } from "../../lib/workflowModels";
import { getRuntimeV2Checkpoint, createRuntimeV2CheckpointPort } from "./checkpointPort";
import {
  createRuntimeV2LiveExecutionState,
  createRuntimeV2ProviderPort,
  createRuntimeV2SchedulerPort,
  createRuntimeV2ToolPort,
} from "./executionPorts";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2WorkspaceReadRunnerInput {
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
  readonly now?: () => number;
  readonly deadlineMs?: number;
}

const WORKSPACE_READ_DEADLINE_MS = 8 * 60_000;
const WORKSPACE_READ_SOFT_STEP_SIGNAL = 20;

function currentTurn(state: any, turnId: string): ConversationTurn | null {
  return state?.conversationTurns?.find(
    (turn: ConversationTurn) => turn.id === turnId,
  ) || null;
}

function sessionEpochFor(
  state: any,
  context: RuntimeV2SubmissionContext,
  turn: ConversationTurn,
): string {
  const lifecycle = state?.planLifecycle;
  if (
    lifecycle?.sessionKey === context.runSessionKey &&
    String(lifecycle.sessionEpoch || "").trim()
  ) {
    return String(lifecycle.sessionEpoch).trim();
  }
  return `runtime-v2:${String(turn.clientSubmissionId || turn.id).trim()}`;
}

function identities(
  state: any,
  context: RuntimeV2SubmissionContext,
  turn: ConversationTurn,
): {
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
} {
  const sessionEpoch = sessionEpochFor(state, context, turn);
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

function latestEvidenceBackedAnswer(
  aggregate: NonNullable<ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"]>,
): string {
  const analyzeCommands = new Set(
    aggregate.events.flatMap((event) =>
      event.type === "command.scheduled" &&
      event.command.kind === "request_model" &&
      event.command.payload.mode === "analyze"
        ? [event.command.idempotencyKey]
        : []
    ),
  );
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (
      event.type === "provider.responded" &&
      analyzeCommands.has(event.idempotencyKey) &&
      event.result.toolCalls.length === 0
    ) {
      return sanitizeAssistantDisplayContent(event.result.visibleText || "")
        .trim()
        .slice(0, 24_000);
    }
  }
  return "";
}

function hasActiveChildren(
  aggregate: NonNullable<ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"]>,
): boolean {
  return aggregate.subagents.some(
    (job) => job.status === "queued" || job.status === "running",
  );
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

/**
 * Workspace-bound non-mutating Turns are tasks, not Chat. They receive a
 * finite read-only tool/scheduler surface and a distinct runtime strategy.
 */
export async function runSubmitRuntimeV2WorkspaceRead(
  input: RuntimeV2WorkspaceReadRunnerInput,
): Promise<RuntimeRunSettlement> {
  const now = input.now || Date.now;
  const workspace = String(input.context.runWorkspace || "").trim();
  if (!workspace) {
    throw new Error("RUNTIME_V2_WORKSPACE_READ_REQUIRES_WORKSPACE");
  }
  const initialState = input.get();
  const turn = currentTurn(initialState, input.context.turnId);
  if (!turn) {
    throw new Error(`RUNTIME_V2_WORKSPACE_READ_TURN_MISSING:${input.context.turnId}`);
  }
  const identity = identities(initialState, input.context, turn);
  const existing = getRuntimeV2Checkpoint(initialState, identity.turn);
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) {
    input.logStoreEvent("runtime_v2_workspace_read_stale_checkpoint_quarantined", {
      turnId: identity.turn.turnId,
      requestedRunId: identity.run.runId,
      checkpointRunId: existing.aggregate.run?.identity.runId || null,
      revision: existing.revision,
    });
    throw new Error("RUNTIME_V2_WORKSPACE_READ_STALE_RUN_CHECKPOINT");
  }

  const live = createRuntimeV2LiveExecutionState();
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
  let ordinal = 0;
  const nextId = (scope: string) => `${scope}:${now().toString(36)}:${++ordinal}`;
  const controller = new RuntimeV2Controller({
    checkpoint,
    provider: createRuntimeV2ProviderPort({
      get: input.get,
      context: input.context,
      live,
      nextId,
      now,
      logStoreEvent: input.logStoreEvent,
    }),
    tool: createRuntimeV2ToolPort({
      get: input.get,
      context: input.context,
      live,
      nextId,
      now,
      logStoreEvent: input.logStoreEvent,
    }),
    scheduler: createRuntimeV2SchedulerPort({
      get: input.get,
      context: input.context,
      live,
      nextId,
      now,
      logStoreEvent: input.logStoreEvent,
    }),
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
        strategy: "analyze",
        objective: turn.userPrompt,
        initialPhase: "preparing",
      });
      input.logStoreEvent("runtime_v2_workspace_read_admitted", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        workspace,
        strategy: "analyze",
      });
    } else if (existing.aggregate.terminalOutcome) {
      const terminal = existing.aggregate.terminalOutcome;
      return settlement(
        input.context,
        toLegacyOutcome(terminal.resultKind, terminal.reason),
      );
    } else {
      await controller.resumeScheduled();
    }

    const admittedAt = controller.snapshot().aggregate?.events.find(
      (event) => event.type === "run.started",
    )?.at || now();
    const deadlineMs = Math.max(1, input.deadlineMs ?? WORKSPACE_READ_DEADLINE_MS);
    let step = 0;
    let softSignalRecorded = controller.snapshot().aggregate?.events.some(
      (event) =>
        event.type === "soft_signal.observed" &&
        event.signal === "iteration_limit",
    ) || false;

    while (true) {
      const before = controller.snapshot().aggregate;
      if (!before || before.terminalOutcome) break;
      if (now() - admittedAt >= deadlineMs) {
        await controller.driveOnce({
          resultKind: "partial",
          resultReason: "工作区只读任务已到达生命周期时限；已保留读取到的证据并完成终态收口。",
        });
        break;
      }
      if (step >= WORKSPACE_READ_SOFT_STEP_SIGNAL && !softSignalRecorded) {
        await controller.recordSoftSignal("iteration_limit");
        softSignalRecorded = true;
      }
      step += 1;

      if (before.phase === "preparing" && before.evidence.length > 0) {
        await controller.changePhase(
          "observing",
          "已取得工作区概览，开始执行有限的只读证据检查。",
        );
        continue;
      }

      const answer = latestEvidenceBackedAnswer(before);
      if (answer && !hasActiveChildren(before)) {
        await controller.driveOnce({
          resultKind: "success",
          resultReason: "已根据本轮实际读取的工作区证据完成答复。",
          finalMarkdown: answer,
        });
        break;
      }

      const drove = await controller.driveOnce({
        subagentPreference:
          input.context.turnInputContextSignals.subagentPreference,
      });
      if (!drove) {
        await controller.driveOnce({
          resultKind: "partial",
          resultReason: "当前没有可继续的只读结构化动作；已保留现有证据并完成终态收口。",
        });
        break;
      }
    }

    const terminal = controller.snapshot().aggregate?.terminalOutcome;
    if (!terminal) {
      throw new Error("RUNTIME_V2_WORKSPACE_READ_TERMINAL_MISSING");
    }
    input.logStoreEvent("runtime_v2_workspace_read_terminal", {
      turnId: identity.turn.turnId,
      runId: identity.run.runId,
      resultKind: terminal.resultKind,
      reason: terminal.reason,
      evidenceCount: controller.snapshot().aggregate?.evidence.length || 0,
      childRuns: controller.snapshot().aggregate?.subagents.length || 0,
    });
    return settlement(
      input.context,
      toLegacyOutcome(terminal.resultKind, terminal.reason),
    );
  } finally {
    clearInterval(input.context.timerInterval as ReturnType<typeof setInterval>);
  }
}
