import {
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
  type AgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import type {
  RuntimeV2ResultKind,
  RuntimeV2RunIdentity,
  RuntimeV2TurnIdentity,
} from "../../lib/runtime-v2";
import type { ConversationTurn } from "../../lib/workflowModels";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

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

export function createRuntimeV2RunnerIdentity(
  state: any,
  context: RuntimeV2SubmissionContext,
  turn: ConversationTurn,
): {
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

export function runtimeV2TerminalOutcomeToLegacy(
  resultKind: RuntimeV2ResultKind,
  reason: string,
): AgentLoopOutcome {
  return resultKind === "canceled"
    ? abortedAgentLoopOutcome(reason)
    : completedAgentLoopOutcome(reason, resultKind);
}

export function createRuntimeV2RunnerSettlement(
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
