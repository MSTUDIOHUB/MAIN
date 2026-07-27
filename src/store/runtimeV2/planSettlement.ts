import {
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
  pausedAgentLoopOutcome,
  type AgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import type {
  RuntimeV2ResultKind,
  RuntimeV2RunIdentity,
} from "../../lib/runtime-v2";
import { PlanLedger } from "./planLedger";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

export function planSettlement(
  context: RuntimeV2SubmissionContext,
  outcome: AgentLoopOutcome = pausedAgentLoopOutcome(
    "runtime_v2_plan_review_required",
    "action_required",
  ),
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

export function terminalPlanOutcome(
  resultKind: RuntimeV2ResultKind,
  reason: string,
): AgentLoopOutcome {
  return resultKind === "canceled"
    ? abortedAgentLoopOutcome(reason)
    : completedAgentLoopOutcome(reason, resultKind);
}

export async function finishPlanTerminal(input: {
  readonly runner: RuntimeV2PlanRunnerInput;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly resultKind: RuntimeV2ResultKind;
  readonly reason: string;
  readonly detailCode: string;
}): Promise<RuntimeRunSettlement> {
  await input.ledger.finishTerminal({
    run: input.run,
    resultKind: input.resultKind,
    reason: input.reason,
  });
  input.runner.logStoreEvent("runtime_v2_plan_terminal", {
    turnId: input.run.turnId,
    runId: input.run.runId,
    resultKind: input.resultKind,
    reason: input.reason,
    detailCode: input.detailCode,
    evidenceCount: input.ledger.snapshot()?.evidence.length || 0,
  });
  return planSettlement(
    input.runner.context,
    terminalPlanOutcome(input.resultKind, input.reason),
  );
}
