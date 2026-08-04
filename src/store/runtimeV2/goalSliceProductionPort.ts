import {
  acquireHarnessRunMarker,
  readHarnessRunMarker,
  type HarnessRunMarker,
} from "../../lib/harnessCrashTelemetry";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import {
  finishRuntimeV2CheckpointTerminal,
  isRuntimeV2TurnTerminallyClosed,
  normalizeRuntimeV2CheckpointMap,
  runtimeV2GoalSliceExecuteAdmission,
  type RuntimeV2GoalSliceOutcome,
  type RuntimeV2GoalSliceRequest,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import {
  normalizeTurnInputContextSignals,
  type TurnInputContextSignals,
} from "../../lib/turnIntake";
import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import type { ConversationTurn } from "../../lib/workflowModels";
import { createRuntimeV2CheckpointPort } from "./checkpointPort";
import {
  runSubmitRuntimeV2Execute,
  type RuntimeV2ExecuteRunnerInput,
} from "./executeRunner";
import type { RuntimeV2GoalSlicePort } from "./goalRunner";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

export interface RuntimeV2GoalHarnessMarkerLease {
  read(): HarnessRunMarker | null;
  swap(
    marker: HarnessRunMarker,
    expectedCurrent: HarnessRunMarker | null,
  ): HarnessRunMarker | null;
}

export interface RuntimeV2GoalProductionSlicePortInput
  extends Omit<RuntimeV2ExecuteRunnerInput, "context"> {
  readonly workspace: string;
  readonly sessionKey: string;
  readonly sessionId: number | null | undefined;
  readonly scopeKey: string;
  readonly language: "zh" | "en";
  readonly turnInputContextSignals?: TurnInputContextSignals;
  readonly runtimeContextBudget?: RuntimeContextBudget | null;
  readonly markerLease?: RuntimeV2GoalHarnessMarkerLease;
  readonly execute?: (
    input: RuntimeV2ExecuteRunnerInput,
  ) => Promise<RuntimeRunSettlement>;
  readonly now?: () => number;
}

export interface RuntimeV2GoalProductionSlicePort
  extends RuntimeV2GoalSlicePort {
  waitForChange(input: {
    readonly request: RuntimeV2GoalSliceRequest;
    readonly signal: AbortSignal;
    readonly maxWaitMs?: number;
  }): Promise<void>;
}

interface OuterStoreOwnerSnapshot {
  readonly marker: HarnessRunMarker;
  readonly currentTurnExecutionConsent: unknown;
  readonly abortController: unknown;
  readonly agentStatus: unknown;
  readonly isGenerating: unknown;
  readonly activeActionRequest: unknown;
  readonly pendingToolCall: unknown;
}

interface SliceExecutionRecord {
  readonly request: RuntimeV2GoalSliceRequest;
  promise: Promise<void>;
  readonly abortController: AbortController;
  abortCause: "parent" | "deadline" | null;
  settled: boolean;
  error: string | null;
  ownerLost: boolean;
}

function defaultMarkerLease(): RuntimeV2GoalHarnessMarkerLease {
  return {
    read: readHarnessRunMarker,
    swap: acquireHarnessRunMarker,
  };
}

function sameMarkerIdentity(
  marker: HarnessRunMarker | null | undefined,
  expected: HarnessRunMarker | null | undefined,
): boolean {
  if (!marker || !expected) return marker === expected;
  return marker.runId === expected.runId &&
    marker.sessionKey === expected.sessionKey &&
    marker.turnId === expected.turnId &&
    marker.instanceId === expected.instanceId &&
    marker.startedAt === expected.startedAt;
}

function sameSliceMarker(
  marker: HarnessRunMarker | null | undefined,
  request: RuntimeV2GoalSliceRequest,
): boolean {
  return !!marker &&
    marker.sessionKey === request.run.sessionKey &&
    marker.turnId === request.run.turnId &&
    marker.runId === request.run.runId;
}

function buildSliceMarker(
  outer: HarnessRunMarker,
  request: RuntimeV2GoalSliceRequest,
  now: number,
): HarnessRunMarker {
  return {
    ...outer,
    runId: request.run.runId,
    activeRunId: request.run.runId,
    activeParentRunId: null,
    parentRunId: null,
    activePlanExecutionProvenance: null,
    lastGoalSliceRunId: request.run.runId,
    sessionKey: request.run.sessionKey,
    workspace: request.turn.workspaceKey,
    turnId: request.run.turnId,
    status: "running",
    terminalResultKind: null,
    workflowMode: "edit",
    runtimeIntent: "execute",
    planStage: "idle",
    isPlanApproved: false,
    iteration: 0,
    maxIterations: 0,
    messagesLen: 0,
    toolCount: 0,
    latestTool: null,
    latestToolTarget: null,
    activeStreamId: null,
    streamStatus: null,
    streamChunkCount: 0,
    streamByteCount: 0,
    streamElapsedMs: null,
    streamLifecycleStatus: null,
    lastStreamError: null,
    startedAt: now,
    updatedAt: now,
    closedAt: null,
    closeReason: null,
  };
}

function slicePrompt(request: RuntimeV2GoalSliceRequest): string {
  const criteria = request.criteria.map((criterion) => ({
    id: criterion.id,
    text: criterion.text,
  }));
  return [
    "[Runtime v2 Goal work slice]",
    `Goal: ${request.objective.text}`,
    request.objective.constraints.length > 0
      ? `Constraints:\n${request.objective.constraints.map((item) => `- ${item}`).join("\n")}`
      : "",
    criteria.length > 0
      ? `Remaining acceptance criteria:\n${JSON.stringify(criteria, null, 2)}`
      : "",
    request.priorEvidence.length > 0
      ? `Prior durable evidence references:\n${JSON.stringify(
          request.priorEvidence.slice(-32),
          null,
          2,
        )}`
      : "",
    "Continue from actual workspace state. Use tools for every read, mutation, and validation.",
  ].filter(Boolean).join("\n\n").slice(0, 12_000);
}

function internalTurn(request: RuntimeV2GoalSliceRequest): ConversationTurn {
  return {
    id: request.turn.turnId,
    clientSubmissionId: request.turn.clientSubmissionId,
    runtimeEngineVersion: "v2",
    userPrompt: slicePrompt(request),
    title: request.objective.text.replace(/\s+/g, " ").trim().slice(0, 120),
    intentSummary: "Runtime v2 Goal work slice",
    uiVisibility: "internal",
    mode: "edit",
    intent: "execute",
    displayIntent: "execute",
    status: "executing",
    summary: "",
    blockIds: [],
    processCollapsed: false,
    collapsed: false,
    createdAt: Date.now(),
  };
}

function turnCompatible(
  turn: ConversationTurn,
  request: RuntimeV2GoalSliceRequest,
): boolean {
  return turn.id === request.turn.turnId &&
    turn.clientSubmissionId === request.turn.clientSubmissionId &&
    turn.runtimeEngineVersion === "v2" &&
    turn.uiVisibility === "internal";
}

function providerUsage(aggregate: TurnAggregateV1): {
  readonly tokensUsed: number;
  readonly toolCalls: number;
} {
  let tokensUsed = 0;
  for (const event of aggregate.events) {
    if (event.type !== "provider.responded" || !event.result.usage) continue;
    const usage = event.result.usage;
    const explicitTotal = Number(
      usage.total_tokens ??
      usage.totalTokens ??
      usage.tokens,
    );
    tokensUsed += Number.isFinite(explicitTotal)
      ? Math.max(0, explicitTotal)
      : Math.max(0, Number(usage.prompt_tokens ?? usage.input_tokens) || 0) +
        Math.max(0, Number(usage.completion_tokens ?? usage.output_tokens) || 0);
  }
  return {
    tokensUsed: Math.floor(tokensUsed),
    toolCalls: aggregate.events.filter((event) =>
      event.type === "tool.completed" ||
      event.type === "validation.completed"
    ).length,
  };
}

function recoveryFingerprint(aggregate: TurnAggregateV1): string {
  if (aggregate.recovery.exhausted) {
    return [
      aggregate.recovery.exhausted.scope,
      aggregate.recovery.exhausted.fingerprint,
    ].join(":");
  }
  const latestReceipt = aggregate.completedCommands[aggregate.completedCommands.length - 1];
  if (latestReceipt?.actionFingerprint) return latestReceipt.actionFingerprint;
  return [
    aggregate.terminalOutcome?.resultKind || "unknown",
    ...aggregate.evidence.slice(-8).map((evidence) =>
      `${evidence.kind}:${evidence.target}:${evidence.version || ""}`
    ),
  ].join("|");
}

function sliceOutcome(input: {
  readonly request: RuntimeV2GoalSliceRequest;
  readonly aggregate: TurnAggregateV1;
  readonly abortCause: SliceExecutionRecord["abortCause"];
}): RuntimeV2GoalSliceOutcome {
  const terminal = input.aggregate.terminalOutcome!;
  const reachedSliceDeadline = input.abortCause === "deadline" ||
    terminal.completedAt >= input.request.deadlineAt;
  const reachedGoalDeadline = reachedSliceDeadline &&
    input.request.deadlineAt >= input.request.goalDeadlineAt;
  const acceptanceEvidence = input.aggregate.evidence.filter((evidence) =>
    evidence.kind === "mutation" || evidence.kind === "validation"
  );
  const hasMutationEvidence = acceptanceEvidence.some(
    (evidence) => evidence.kind === "mutation",
  );
  const hasValidationEvidence = acceptanceEvidence.some(
    (evidence) => evidence.kind === "validation",
  );
  const structurallyAccepted = terminal.resultKind === "success" &&
    hasMutationEvidence &&
    hasValidationEvidence;
  const reasonCode: RuntimeV2GoalSliceOutcome["reasonCode"] =
    input.abortCause === "parent" ||
      (terminal.resultKind === "canceled" && !reachedSliceDeadline)
      ? "canceled"
      : reachedGoalDeadline
        ? "deadline_exceeded"
        : reachedSliceDeadline
          ? "slice_boundary"
          : structurallyAccepted
              ? "objective_satisfied"
              : terminal.resultKind === "blocked"
                ? "external_blocked"
                : terminal.resultKind === "error"
                  ? "execution_error"
                  : hasMutationEvidence && !hasValidationEvidence
                    ? "validation_incomplete"
                    : "slice_boundary";
  const acceptance = structurallyAccepted
    ? input.request.criteria.map((criterion) => ({
        criterionId: criterion.id,
        status: "satisfied" as const,
        evidenceIds: acceptanceEvidence.map((evidence) => evidence.id),
      }))
    : [];
  return {
    outcomeId: terminal.finalProjectionId,
    sliceId: input.request.sliceId,
    turnId: input.request.turn.turnId,
    runId: input.request.run.runId,
    resultKind: reachedSliceDeadline && terminal.resultKind === "canceled"
      ? "partial"
      : terminal.resultKind,
    reasonCode,
    reason: terminal.reason,
    evidence: input.aggregate.evidence,
    acceptance,
    recoveryFingerprint: recoveryFingerprint(input.aggregate),
    recoverable: reasonCode === "slice_boundary" ||
      reasonCode === "validation_incomplete",
    usage: providerUsage(input.aggregate),
    completedAt: terminal.completedAt,
  };
}

function runtimeCheckpoint(
  state: any,
  request: RuntimeV2GoalSliceRequest,
) {
  const checkpoint = normalizeRuntimeV2CheckpointMap(
    state?.runtimeV2Checkpoints,
  )[request.turn.turnId];
  if (!checkpoint) return null;
  return checkpoint.aggregate.turn.workspaceKey === request.turn.workspaceKey &&
    checkpoint.aggregate.turn.sessionKey === request.turn.sessionKey &&
    checkpoint.aggregate.turn.sessionEpoch === request.turn.sessionEpoch &&
    checkpoint.aggregate.turn.clientSubmissionId === request.turn.clientSubmissionId
      ? checkpoint
      : null;
}

/**
 * Adapt one Goal slice to the existing production Execute runner. No execution
 * loop is duplicated here: this layer only installs exact Turn ownership,
 * invokes the shared runner, and translates its durable terminal ledger.
 */
export function createRuntimeV2GoalProductionSlicePort(
  input: RuntimeV2GoalProductionSlicePortInput,
): RuntimeV2GoalProductionSlicePort {
  const markerLease = input.markerLease || defaultMarkerLease();
  const execute = input.execute || runSubmitRuntimeV2Execute;
  const now = input.now || Date.now;
  const records = new Map<string, SliceExecutionRecord>();

  const restoreOuterOwner = (
    request: RuntimeV2GoalSliceRequest,
    outer: OuterStoreOwnerSnapshot,
  ): boolean => {
    const currentPersistent = markerLease.read();
    if (!sameSliceMarker(currentPersistent, request)) return false;
    const restoredPersistent = markerLease.swap(outer.marker, currentPersistent);
    if (!restoredPersistent || !sameMarkerIdentity(restoredPersistent, outer.marker)) {
      return false;
    }
    let restored = false;
    input.set((state: any) => {
      if (!sameSliceMarker(state.harnessRunMarker, request)) return {};
      restored = true;
      return {
        harnessRunMarker: outer.marker,
        currentTurnExecutionConsent: outer.currentTurnExecutionConsent,
        abortController: outer.abortController,
        agentStatus: outer.agentStatus,
        isGenerating: outer.isGenerating,
        activeActionRequest: outer.activeActionRequest,
        pendingToolCall: outer.pendingToolCall,
      };
    });
    return restored;
  };

  const finalizeRejectedExecution = async (
    request: RuntimeV2GoalSliceRequest,
    reason: string,
  ): Promise<void> => {
    const current = runtimeCheckpoint(input.get(), request);
    if (!current || current.aggregate.terminalOutcome) return;
    const checkpoint = createRuntimeV2CheckpointPort({
      get: input.get,
      set: input.set,
      scopeKey: input.scopeKey,
      sessionId: input.sessionId,
      getSessionRevisionToken: input.getSessionRevisionToken,
      sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
      buildSessionRuntimeSnapshot: input.buildSessionRuntimeSnapshot,
      publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
      persistSessionRecord: input.persistSessionRecord,
      logStoreEvent: input.logStoreEvent,
    });
    let ordinal = 0;
    await finishRuntimeV2CheckpointTerminal({
      checkpoint,
      projection: createRuntimeV2ProjectionPort({
        get: input.get,
        set: input.set,
        nextTaskId: () => input.get()._nextTaskId(),
        language: input.language,
        logStoreEvent: input.logStoreEvent,
      }),
      owner: current.aggregate.turn,
      run: current.aggregate.run!.identity,
      current,
      resultKind: "error",
      reason,
      now,
      nextId: (scope) => `${scope}:${request.sliceId}:${++ordinal}`,
    });
  };

  const installSliceOwner = (
    request: RuntimeV2GoalSliceRequest,
    abortController: AbortController,
  ): {
    readonly outer: OuterStoreOwnerSnapshot;
    readonly marker: HarnessRunMarker;
  } => {
    const state = input.get();
    const outerMarker = state.harnessRunMarker as HarnessRunMarker | null;
    if (
      !outerMarker ||
      outerMarker.status !== "running" ||
      outerMarker.sessionKey !== request.goal.sessionKey ||
      outerMarker.turnId !== request.goal.ownerTurnId ||
      outerMarker.runtimeIntent !== "goal" ||
      state.activeActionRequest
    ) {
      throw new Error("RUNTIME_V2_GOAL_SLICE_OUTER_OWNER_LOST");
    }
    const lifecycleEpoch = state.planLifecycle?.sessionKey === request.turn.sessionKey
      ? String(state.planLifecycle.sessionEpoch || "").trim()
      : `runtime-v2:${request.turn.clientSubmissionId}`;
    if (lifecycleEpoch !== request.turn.sessionEpoch) {
      throw new Error("RUNTIME_V2_GOAL_SLICE_SESSION_EPOCH_MISMATCH");
    }
    const existingTurn = state.conversationTurns?.find(
      (turn: ConversationTurn) => turn.id === request.turn.turnId,
    );
    if (existingTurn && !turnCompatible(existingTurn, request)) {
      throw new Error("RUNTIME_V2_GOAL_SLICE_TURN_COLLISION");
    }
    const marker = buildSliceMarker(outerMarker, request, now());
    const currentPersistent = markerLease.read();
    if (!sameMarkerIdentity(currentPersistent, outerMarker)) {
      throw new Error("RUNTIME_V2_GOAL_SLICE_PERSISTED_OWNER_LOST");
    }
    const acquired = markerLease.swap(marker, currentPersistent);
    if (!acquired || !sameMarkerIdentity(acquired, marker)) {
      throw new Error("RUNTIME_V2_GOAL_SLICE_MARKER_ACQUIRE_FAILED");
    }
    const outer: OuterStoreOwnerSnapshot = {
      marker: outerMarker,
      currentTurnExecutionConsent: state.currentTurnExecutionConsent,
      abortController: state.abortController,
      agentStatus: state.agentStatus,
      isGenerating: state.isGenerating,
      activeActionRequest: state.activeActionRequest,
      pendingToolCall: state.pendingToolCall,
    };
    let installed = false;
    input.set((latest: any) => {
      if (!sameMarkerIdentity(latest.harnessRunMarker, outerMarker)) return {};
      const latestTurn = latest.conversationTurns?.find(
        (turn: ConversationTurn) => turn.id === request.turn.turnId,
      );
      if (latestTurn && !turnCompatible(latestTurn, request)) return {};
      installed = true;
      return {
        conversationTurns: latestTurn
          ? latest.conversationTurns
          : [...(latest.conversationTurns || []), internalTurn(request)],
        harnessRunMarker: acquired,
        currentTurnExecutionConsent: {
          turnId: request.turn.turnId,
          granted: true,
        },
        abortController,
        agentStatus: "working",
        isGenerating: true,
        activeActionRequest: null,
        pendingToolCall: null,
      };
    });
    if (!installed) {
      markerLease.swap(outerMarker, acquired);
      throw new Error("RUNTIME_V2_GOAL_SLICE_STORE_OWNER_LOST");
    }
    return { outer, marker: acquired };
  };

  const launch = async (
    request: RuntimeV2GoalSliceRequest,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const existing = records.get(request.sliceId);
    if (existing && !existing.settled) return;
    if (existing?.settled) records.delete(request.sliceId);
    const abortController = new AbortController();
    const record = {
      request,
      promise: Promise.resolve(),
      abortController,
      abortCause: null,
      settled: false,
      error: null,
      ownerLost: false,
    } as SliceExecutionRecord;
    const onParentAbort = () => {
      record.abortCause = "parent";
      abortController.abort(parentSignal.reason);
    };
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    const deadlineDelay = Math.max(1, request.deadlineAt - now());
    const deadlineTimer = setTimeout(() => {
      if (!abortController.signal.aborted) {
        record.abortCause = "deadline";
        abortController.abort("runtime_v2_goal_slice_deadline");
      }
    }, deadlineDelay);
    let ownership: ReturnType<typeof installSliceOwner>;
    try {
      ownership = installSliceOwner(request, abortController);
    } catch (error) {
      clearTimeout(deadlineTimer);
      parentSignal.removeEventListener("abort", onParentAbort);
      throw error;
    }
    const timerInterval = setInterval(() => undefined, 60_000);
    const context: RuntimeV2SubmissionContext = {
      turnId: request.turn.turnId,
      uiDisplayTurnId: request.turn.turnId,
      runWorkspace: input.workspace,
      runSessionKey: input.sessionKey,
      runSessionId: input.sessionId,
      runScopeKey: input.scopeKey,
      phaseLanguage: input.language,
      effectiveRunIntent: "execute",
      runtimeRunIntent: "execute",
      abortCtrl: abortController,
      timerInterval,
      harnessRunId: request.run.runId,
      turnInputContextSignals: normalizeTurnInputContextSignals(
        input.turnInputContextSignals,
      ),
      runtimeContextBudget: input.runtimeContextBudget,
      executeAdmission: runtimeV2GoalSliceExecuteAdmission(request),
    };
    const execution = Promise.resolve()
      .then(() => execute({ ...input, context }))
      .then(() => undefined)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        record.error = message;
        try {
          await finalizeRejectedExecution(
            request,
            `Goal slice Execute runner failed: ${message}`,
          );
        } catch (finalizeError) {
          record.error = `${message}; terminal finalize failed: ${
            finalizeError instanceof Error ? finalizeError.message : String(finalizeError)
          }`;
        }
      })
      .finally(() => {
        clearTimeout(deadlineTimer);
        clearInterval(timerInterval);
        parentSignal.removeEventListener("abort", onParentAbort);
        record.ownerLost = !restoreOuterOwner(
          request,
          ownership.outer,
        );
        record.settled = true;
      });
    record.promise = execution;
    records.set(request.sliceId, record);
  };

  return {
    async launch({ request, signal }) {
      await launch(request, signal);
    },

    async observe({ request }) {
      const checkpoint = runtimeCheckpoint(input.get(), request);
      if (
        checkpoint &&
        isRuntimeV2TurnTerminallyClosed(checkpoint.aggregate)
      ) {
        const record = records.get(request.sliceId);
        return {
          status: "completed" as const,
          outcome: sliceOutcome({
            request,
            aggregate: checkpoint.aggregate,
            abortCause: record?.abortCause || null,
          }),
        };
      }
      const record = records.get(request.sliceId);
      if (record && !record.settled) return { status: "running" as const };
      return { status: "missing" as const };
    },

    async waitForChange({ request, signal, maxWaitMs = 1_000 }) {
      const record = records.get(request.sliceId);
      if (record?.settled || signal.aborted) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(
          finish,
          Math.max(1, Math.min(maxWaitMs, 5_000)),
        );
        signal.addEventListener("abort", finish, { once: true });
        record?.promise.then(finish, finish);
      });
    },
  };
}
