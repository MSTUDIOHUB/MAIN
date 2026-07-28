import type { AgentMessage } from "../../lib/agentMessages";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import { executeTool } from "../../lib/toolExecutor";
import {
  runtimeV2EvidenceVersion,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import type { ConversationTurn } from "../../lib/workflowModels";
import {
  createRuntimeV2CheckpointPort,
  getRuntimeV2Checkpoint,
} from "./checkpointPort";
import { PlanLedger } from "./planLedger";
import {
  boundedPlanContent,
  providerPlanMessages,
} from "./planModelProtocol";
import {
  applyReviewProjection,
} from "./planReviewProjection";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import { planSettlement, terminalPlanOutcome } from "./planSettlement";
import {
  resolveRuntimeV2PlanReviewFromAggregate,
} from "./workPlanAdapter";

interface PlanBootstrapReady {
  readonly settlement: null;
  readonly turn: ConversationTurn;
  readonly identity: {
    readonly turn: RuntimeV2TurnIdentity;
    readonly run: RuntimeV2RunIdentity;
  };
  readonly ledger: PlanLedger;
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
  readonly messages: AgentMessage[];
}

interface PlanBootstrapSettled {
  readonly settlement: RuntimeRunSettlement;
}

export type PlanBootstrapResult =
  | PlanBootstrapReady
  | PlanBootstrapSettled;

function currentTurn(state: any, turnId: string): ConversationTurn | null {
  return state?.conversationTurns?.find(
    (turn: ConversationTurn) => turn.id === turnId,
  ) || null;
}

function identities(
  state: any,
  input: RuntimeV2PlanRunnerInput,
  turn: ConversationTurn,
): PlanBootstrapReady["identity"] {
  const lifecycle = state?.planLifecycle;
  const sessionEpoch = lifecycle?.sessionKey === input.context.runSessionKey &&
      String(lifecycle.sessionEpoch || "").trim()
    ? String(lifecycle.sessionEpoch).trim()
    : `runtime-v2:${String(turn.clientSubmissionId || turn.id).trim()}`;
  return {
    turn: {
      workspaceKey: String(input.context.runWorkspace || "global").trim() ||
        "global",
      sessionKey: input.context.runSessionKey,
      sessionEpoch,
      clientSubmissionId: String(turn.clientSubmissionId || turn.id).trim(),
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

async function collectInitialOverview(input: {
  readonly runner: RuntimeV2PlanRunnerInput;
  readonly turn: ConversationTurn;
  readonly identity: PlanBootstrapReady["identity"];
  readonly ledger: PlanLedger;
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
}): Promise<{ readonly overview: string; readonly settlement?: RuntimeRunSettlement }> {
  const collect = await input.ledger.schedule(
    input.identity.run,
    "collect_observation",
    { objective: input.turn.userPrompt },
  );
  try {
    const result = await executeTool(
      "get_project_skeleton",
      {},
      input.runner.context.runWorkspace || "",
      input.runner.context.runSessionKey,
    );
    const overview = boundedPlanContent(result, 12_000);
    await input.ledger.settleCommand({
      type: "command.completed",
      run: input.identity.run,
      idempotencyKey: collect.idempotencyKey,
      status: "succeeded",
    });
    input.evidence.push({
      id: "E1",
      target: input.runner.context.runWorkspace || "workspace",
      version: runtimeV2EvidenceVersion(result),
      statement: "已读取工作区结构概览。",
    });
    input.evidenceContents.set("E1", overview);
    await input.ledger.append({
      type: "observation.recorded",
      run: input.identity.run,
      evidence: {
        id: "E1",
        kind: "source",
        target: input.runner.context.runWorkspace || "workspace",
        version: input.evidence[0]!.version,
      },
    });
    return { overview };
  } catch (error) {
    await input.ledger.settleCommand({
      type: "command.completed",
      run: input.identity.run,
      idempotencyKey: collect.idempotencyKey,
      status: "failed",
    });
    await input.ledger.recordSoftSignal(
      input.identity.run,
      "repeated_action",
    );
    input.runner.logStoreEvent("runtime_v2_plan_overview_failed", {
      turnId: input.identity.turn.turnId,
      runId: input.identity.run.runId,
      error: error instanceof Error ? error.message : String(error),
      action: "continue_with_targeted_read_tools",
    });
    return {
      overview: "Runtime v2 could not collect the initial workspace overview. Use the available read-only tools to gather targeted evidence.",
    };
  }
}

export async function bootstrapRuntimeV2Plan(
  input: RuntimeV2PlanRunnerInput,
): Promise<PlanBootstrapResult> {
  const initialState = input.get();
  const turn = currentTurn(initialState, input.context.turnId);
  if (!turn) {
    throw new Error(`RUNTIME_V2_PLAN_TURN_MISSING:${input.context.turnId}`);
  }
  const identity = identities(initialState, input, turn);
  const checkpointPort = createRuntimeV2CheckpointPort({
    get: input.get,
    set: input.set,
    scopeKey: input.context.runScopeKey,
    sessionId: input.context.runSessionId,
    getSessionRevisionToken: input.getSessionRevisionToken,
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    normalizeSessionRuntimeSnapshot: input.normalizeSessionRuntimeSnapshot,
    persistSessionRecord: input.persistSessionRecord,
    publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
    logStoreEvent: input.logStoreEvent,
  });
  const existing = getRuntimeV2Checkpoint(initialState, identity.turn);
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) {
    throw new Error("RUNTIME_V2_PLAN_STALE_RUN_CHECKPOINT");
  }
  const ledger = new PlanLedger(
    identity.turn,
    checkpointPort,
    createRuntimeV2ProjectionPort({
      get: input.get,
      set: input.set,
      nextTaskId: () => input.get()._nextTaskId(),
      language: input.context.phaseLanguage,
      logStoreEvent: input.logStoreEvent,
    }),
    existing
      ? { revision: existing.revision, aggregate: existing.aggregate }
      : null,
  );
  if (existing?.aggregate.terminalOutcome) {
    const terminal = existing.aggregate.terminalOutcome;
    return {
      settlement: planSettlement(
        input.context,
        terminalPlanOutcome(terminal.resultKind, terminal.reason),
      ),
    };
  }
  if (existing?.aggregate.phase === "reviewing") {
    const review = resolveRuntimeV2PlanReviewFromAggregate(existing.aggregate);
    if (!review?.pending) {
      throw new Error("RUNTIME_V2_PLAN_REVIEW_AUTHORITY_INVALID");
    }
    applyReviewProjection(input, review.commit);
    return { settlement: planSettlement(input.context) };
  }
  if (!existing) {
    await ledger.append({
      type: "turn.admitted",
      turn: identity.turn,
      strategy: "plan",
      objective: turn.userPrompt,
      constraints: [],
      acceptanceCriteria: [],
    });
    await ledger.append({
      type: "run.started",
      run: identity.run,
      phase: "planning",
    });
  } else if (
    existing.aggregate.strategy !== "plan" ||
    existing.aggregate.phase !== "planning"
  ) {
    throw new Error(`RUNTIME_V2_PLAN_PHASE_INVALID:${existing.aggregate.phase}`);
  } else if (existing.aggregate.scheduledCommands.length > 0) {
    const interrupted = [...existing.aggregate.scheduledCommands];
    await ledger.settleScheduled(identity.run, "failed");
    for (const command of interrupted) {
      await ledger.recordSoftSignal(
        identity.run,
        command.kind === "request_model"
          ? "protocol_drift"
          : "repeated_action",
      );
    }
    input.logStoreEvent("runtime_v2_plan_cold_recovery_settled", {
      turnId: identity.turn.turnId,
      runId: identity.run.runId,
      interruptedKinds: interrupted.map((command) => command.kind),
    });
  }

  const evidence: WorkPlanRuntimeEvidence[] = [];
  const evidenceContents = new Map<string, string>();
  const collected = await collectInitialOverview({
    runner: input,
    turn,
    identity,
    ledger,
    evidence,
    evidenceContents,
  });
  if (collected.settlement) {
    return { settlement: collected.settlement };
  }
  return {
    settlement: null,
    turn,
    identity,
    ledger,
    evidence,
    evidenceContents,
    messages: providerPlanMessages({
      turn,
      context: input.context,
      overview: collected.overview,
    }),
  };
}
