import { normalizeNetworkRead } from "../../lib/networkRead";
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
  readonly persistSessionRecord: (scopeKey: string, session: unknown) => Promise<unknown>;
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly deadlineMs?: number;
}

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

export function buildRuntimeV2ReadOnlyIdentities(
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
 * Workspace and attachment scope, not the network switch, selects analyze.
 */
export async function runSubmitRuntimeV2ReadOnly(
  input: RuntimeV2ReadOnlyRunnerInput,
  strategy: "chat" | "analyze",
): Promise<RuntimeRunSettlement> {
  const now = input.now || Date.now;
  const workspace = String(input.context.runWorkspace || "").trim();
  const hasAttachedFiles =
    input.context.turnInputContextSignals.attachedFilePaths.length > 0;
  if (strategy === "analyze" && !workspace && !hasAttachedFiles) {
    throw new Error("RUNTIME_V2_BOUNDED_READ_REQUIRES_SOURCE_SCOPE");
  }
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

  // A checkpoint's admission fact wins over both UI state and a newer Turn projection.
  input = { ...input, context: { ...input.context, networkRead: normalizeNetworkRead(existing ? existing.aggregate.networkRead : turn.networkRead) } };
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
      strategy, collectWorkspace: !!workspace, networkRead: input.context.networkRead,
      allowSkillLoad: !!buildLoadSkillToolDefinition(input.context.skillCatalog),
      signal: input.context.abortCtrl.signal, now, deadlineMs: input.deadlineMs,
      initial: existing ? { aggregate: existing.aggregate, revision: existing.revision } : undefined,
      blocked: () => live.permissionRejection,
      decisionInput: () => {
        const policy = resolveSubagentCapacityPolicy(input.get().config);
        return strategy === "analyze" ? {
          subagentPreference: input.context.turnInputContextSignals.subagentPreference,
          subagentCapacity: policy.maxActiveRequests, subagentRequestMode: policy.modelRequestMode,
        } : {};
      },
    });
    input.logStoreEvent(`runtime_v2_${strategy === "chat" ? "chat" : "workspace_read"}_terminal`, {
      turnId: identity.turn.turnId, runId: identity.run.runId, resultKind: result.resultKind, reason: result.reason,
      evidenceCount: result.aggregate.evidence.length,
      providerResponses: result.aggregate.events.filter((event) => event.type === "provider.responded").length,
    });
    return settlement(input.context, result.resultKind === "canceled" ? abortedAgentLoopOutcome(result.reason) : completedAgentLoopOutcome(result.reason, result.resultKind));
  } finally { clearInterval(input.context.timerInterval as ReturnType<typeof setInterval>); }
}
