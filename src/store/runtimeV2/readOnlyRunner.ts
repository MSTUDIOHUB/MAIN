import { normalizeNetworkRead } from "../../lib/networkRead";
import { awaitCanceledTurnTerminalProjection, getPendingSessionCancellation } from "../sessionCancellationBarrier";
import type { SubmitSessionPersistence } from "../persistSubmitRuntimeProjection";
import { buildLoadSkillToolDefinition } from "../../lib/agentSkills";
import { runRuntimeV2ReadOnlyLoop } from "../../lib/runtime-v2/readOnly";
import type { RuntimeV2Ports } from "../../lib/runtime-v2/ports";
import { restoreReadOnlyHistory } from "./readOnlyHistory";
import {
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
  type AgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import {
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
} from "../../lib/runtime-v2";
import { resolveSubagentCapacityPolicy } from "../../lib/subagents";
import { isProjectBaselineForWorkspace } from "../../lib/workspaceAdmission";
import { resolveRuntimeV2VisibleRunnerKind } from "../../lib/runtimeEngineSelection";
import type { ConversationTurn } from "../../lib/workflowModels";
import { getRuntimeV2Checkpoint, createRuntimeV2CheckpointPort } from "./checkpointPort";
import {
  createRuntimeV2LiveExecutionState,
  createRuntimeV2ProviderPort,
  createRuntimeV2SchedulerPort,
  createRuntimeV2ToolPort,
} from "./executionPorts";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import { deriveProactiveCollaboration } from "./proactiveSubagents";
import type { RuntimeV2SubmissionContext } from "./submissionContext";
import { resolveRuntimeV2SessionEpoch } from "./sessionIdentity";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2ReadOnlyRunnerInput {
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
  readonly now?: () => number;
  readonly deadlineMs?: number;
}

function currentTurn(state: any, turnId: string): ConversationTurn | null {
  return state?.conversationTurns?.find(
    (turn: ConversationTurn) => turn.id === turnId,
  ) || null;
}

export function buildRuntimeV2ReadOnlyIdentities(
  state: any,
  context: RuntimeV2SubmissionContext,
  turn: ConversationTurn,
): {
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
} {
  const sessionEpoch = resolveRuntimeV2SessionEpoch(state, context, turn);
  return {
    turn: {
      workspaceKey: String(context.runScopeKey).trim(),
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
 * Shared adapters and persistence for independent Chat/analyze policies.
 * The Session owner is independent of the strategy's permitted sources.
 */
export async function runSubmitRuntimeV2ReadOnly(
  input: RuntimeV2ReadOnlyRunnerInput,
  requestedStrategy: "chat" | "analyze",
): Promise<RuntimeRunSettlement> {
  const now = input.now || Date.now;
  const workspace = String(input.context.runWorkspace || "").trim();
  const signals = input.context.turnInputContextSignals;
  const hasAttachedFiles = !!(signals.attachedFilePaths?.length || signals.mentionedFilePaths?.length);
  const initialState = input.get();
  const turn = currentTurn(initialState, input.context.turnId);
  if (!turn) {
    throw new Error(`RUNTIME_V2_WORKSPACE_READ_TURN_MISSING:${input.context.turnId}`);
  }
  const identity = buildRuntimeV2ReadOnlyIdentities(initialState, input.context, turn);
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
  const savedStrategy = existing?.aggregate.strategy;
  if (savedStrategy && savedStrategy !== "chat" && savedStrategy !== "analyze") {
    throw new Error("RUNTIME_V2_READ_ONLY_REJECTS_NON_READ_ONLY_CHECKPOINT");
  }
  const strategy = savedStrategy ?? requestedStrategy;
  if (!existing && strategy === "analyze" && !workspace && !hasAttachedFiles) {
    throw new Error("RUNTIME_V2_BOUNDED_READ_REQUIRES_SOURCE_SCOPE");
  }
  if (!existing && strategy === "chat" && resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: input.context.effectiveRunIntent,
    runtimeIntent: input.context.runtimeRunIntent,
    runWorkspace: workspace,
    hasAttachedFiles,
    requiredCapabilities: input.context.requiredCapabilities,
  }) !== "chat") {
    throw new Error("RUNTIME_V2_CHAT_REQUIRES_SOURCE_FREE_ADMISSION");
  }

  // A checkpoint's admission fact wins over both UI state and a newer Turn projection.
  const preparedChatAnswer = input.context.preparedChatAnswer;
  input = { ...input, context: {
    ...input.context,
    readOnlyStrategy: strategy,
    networkRead: normalizeNetworkRead(existing ? existing.aggregate.networkRead : turn.networkRead),
    knowledgeContext: existing ? existing.aggregate.knowledgeContext : input.context.knowledgeContext,
    workspaceInstructionContext: strategy === "chat" ? undefined : existing?.aggregate.workspaceInstructionContext ?? input.context.workspaceInstructionContext,
    ...(strategy === "chat" ? { projectBaselineContext: null, workspaceMcpSnapshot: null } : {}),
    preparedChatAnswer: !existing && strategy === "chat" ? preparedChatAnswer : undefined,
    preparedWorkspaceRead: !existing && strategy === "analyze" ? input.context.preparedWorkspaceRead : undefined,
  } };
  const live = createRuntimeV2LiveExecutionState();
  if (existing) restoreReadOnlyHistory(live, existing.aggregate);
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
  const ports: RuntimeV2Ports = {
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
      set: input.set,
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
  };
  try {
    input.logStoreEvent(`runtime_v2_${strategy === "chat" ? "chat" : "workspace_read"}_${existing ? "resumed" : "admitted"}`, { turnId: identity.turn.turnId, runId: identity.run.runId, strategy });
    const result = await runRuntimeV2ReadOnlyLoop({
      ports, turn: identity.turn, run: identity.run, objective: turn.userPrompt,
      subagentRequirement: input.context.turnInputContextSignals?.subagentRequirement,
      capabilityRestrictions: input.context.capabilityRestrictions,
      approvalRequiredCapabilities: input.context.approvalRequiredCapabilities,
      // New code investigations choose a concrete source tool in the first
      // request. Keep overview collection for older unspecialized callers.
      strategy, collectWorkspace: strategy === "analyze" && input.context.requiredCapabilities === undefined &&
        !(existing?.aggregate.objective.capabilityRestrictions || input.context.capabilityRestrictions)?.includes("workspace_read") && !(existing ? existing.aggregate.objective.approvalRequiredCapabilities : input.context.approvalRequiredCapabilities)?.includes("workspace_read") && !!workspace && !isProjectBaselineForWorkspace(
        input.context.projectBaselineContext,
        workspace,
      ), networkRead: input.context.networkRead, knowledgeContext: input.context.knowledgeContext,
      workspaceInstructionContext: input.context.workspaceInstructionContext,
      allowSkillLoad: (strategy !== "chat" || !!existing || !!input.context.skillCatalog?.explicitSkillIds.length) &&
        !!buildLoadSkillToolDefinition(input.context.skillCatalog),
      signal: input.context.abortCtrl.signal,
      isExternalCancellationPending: () => getPendingSessionCancellation(identity.turn.sessionKey)?.turnId === identity.turn.turnId,
      logEvent: input.logStoreEvent,
      now, deadlineMs: input.deadlineMs,
      initial: existing ? { aggregate: existing.aggregate, revision: existing.revision } : undefined,
      blocked: () => live.permissionRejection,
      decisionInput: (state) => {
        if (strategy === "chat") return {};
        const policy = resolveSubagentCapacityPolicy(input.get().config);
        const preference = input.context.turnInputContextSignals.subagentPreference;
        const startedAt = state.events.find((event) => event.type === "run.started")?.at;
        return {
          subagentPreference: preference,
          subagentCapacity: policy.maxActiveRequests, subagentRequestMode: policy.modelRequestMode,
          proactiveCollaboration: deriveProactiveCollaboration({
            state, preference, capacity: policy.maxActiveRequests, requestMode: policy.modelRequestMode,
            baseline: input.context.projectBaselineContext, workspace, language: input.context.phaseLanguage, now: now(),
            lifecycleDeadlineAt: input.deadlineMs === undefined || startedAt === undefined ? undefined : startedAt + input.deadlineMs,
          }),
          settledProactiveJobIds: [...live.childTelemetry].filter(([, telemetry]) => telemetry.closedAt !== null).map(([id]) => id),
        };
      },
    });
    input.logStoreEvent(`runtime_v2_${strategy === "chat" ? "chat" : "workspace_read"}_terminal`, {
      turnId: identity.turn.turnId, runId: identity.run.runId, resultKind: result.resultKind, reason: result.reason,
      evidenceCount: result.aggregate.evidence.length,
      providerResponses: result.aggregate.events.filter((event) => event.type === "provider.responded").length,
    });
    return settlement(input.context, result.resultKind === "canceled" ? abortedAgentLoopOutcome(result.reason) : completedAgentLoopOutcome(result.reason, result.resultKind));
  } catch (error) {
    if (
      input.context.abortCtrl.signal.aborted &&
      await awaitCanceledTurnTerminalProjection({
        sessionKey: identity.turn.sessionKey,
        turnId: identity.turn.turnId,
        getProjection: () => {
          const state = input.get();
          return { runtimeEvents: state.runtimeEvents || [], taskFlow: state.taskFlow || [] };
        },
      })
    ) {
      return settlement(input.context, abortedAgentLoopOutcome("用户已停止本轮执行；取消事务已完成唯一终态收口。"));
    }
    throw error;
  } finally { clearInterval(input.context.timerInterval as ReturnType<typeof setInterval>); }
}
