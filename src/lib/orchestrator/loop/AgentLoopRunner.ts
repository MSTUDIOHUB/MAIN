import { logAgentEvent } from "../../orchestrator";
import type { AgentLoopOutcome, OrchestratorCallbacks } from "../types";
import { AgentOrchestrator } from "./AgentOrchestrator";
import { resolveNonActionableStopOutcome, runAgentLoopCompletionGuards } from "./completionGuards";

function buildAgentLoopErrorReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error || "");
  const normalized = detail.trim().replace(/\s+/g, " ");
  return normalized ? `agent_loop_error: ${normalized.slice(0, 500)}` : "agent_loop_error";
}

export async function executeAgentLoop(
  callbacks: OrchestratorCallbacks,
  abortController: AbortController,
): Promise<AgentLoopOutcome> {
  const orchestrator = new AgentOrchestrator();
  let outcome: AgentLoopOutcome = { status: "completed", reason: "agent_loop_completed" };
  const setOutcome = (next: AgentLoopOutcome) => {
    if (outcome.status === "error") return;
    if (outcome.status === "aborted" && next.status !== "error") return;
    outcome = next;
  };
  const wrappedCallbacks: OrchestratorCallbacks = {
    ...callbacks,
    onAssistantFinalText: (text, replyOptions = [], meta) => {
      if (meta?.awaitingInput === true && replyOptions.length > 0) {
        setOutcome({ status: "paused", reason: "awaiting_user_choice" });
        logAgentEvent("agent_loop_awaiting_user_choice", {
          replyOptions: replyOptions.length,
        });
      }
      callbacks.onAssistantFinalText(text, replyOptions, meta);
    },
    onNonActionableStop: (message, reason, progress) => {
      setOutcome(resolveNonActionableStopOutcome(reason, progress));
      callbacks.onNonActionableStop(message, reason, progress);
    },
    onError: (error) => {
      setOutcome({ status: "error", reason: buildAgentLoopErrorReason(error) });
      callbacks.onError(error);
    },
  };

  try {
    await orchestrator.execute(wrappedCallbacks, abortController);
  } catch (error) {
    const errorReason = buildAgentLoopErrorReason(error);
    orchestrator.failActiveRun(errorReason);
    setOutcome({ status: "error", reason: errorReason });
    throw error;
  }

  const runPauseReason = orchestrator.getLatestRunPauseReason?.();
  if (runPauseReason && outcome.status === "completed") {
    setOutcome({ status: "paused", reason: runPauseReason });
  }

  if (abortController.signal.aborted) {
    return { status: "aborted", reason: "agent_loop_aborted" };
  }

  return runAgentLoopCompletionGuards({
    outcome,
    callbacks,
    latestTurnContract: orchestrator.getLatestTurnContract(),
    sawExecutionEvidence: orchestrator.hasExecuteOperationEvidence(),
  });
}
