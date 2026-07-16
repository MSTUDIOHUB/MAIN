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
  let outcome: AgentLoopOutcome | null = null;
  const setOutcome = (next: AgentLoopOutcome) => {
    if (outcome?.status === "error") return;
    if (outcome?.status === "aborted" && next.status !== "error") return;
    outcome = next;
  };
  const wrappedCallbacks: OrchestratorCallbacks = {
    ...callbacks,
    onAssistantFinalText: (text, replyOptions = [], meta) => {
      const isSubagent = (callbacks.getSubagentDepth?.() ?? 0) > 0;
      if (!isSubagent && meta?.awaitingInput === true && replyOptions.length > 0) {
        setOutcome({ status: "paused", reason: "awaiting_user_choice" });
        logAgentEvent("agent_loop_awaiting_user_choice", {
          replyOptions: replyOptions.length,
        });
      }
      callbacks.onAssistantFinalText(
        text,
        isSubagent ? [] : replyOptions,
        isSubagent ? { ...meta, awaitingInput: false } : meta,
      );
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
  if (runPauseReason && outcome === null) {
    setOutcome({ status: "paused", reason: runPauseReason });
  }

  if (abortController.signal.aborted) {
    orchestrator.discardPendingTurnCompletion?.();
    return { status: "aborted", reason: "agent_loop_aborted" };
  }

  if (outcome === null && orchestrator.hasPendingTurnCompletion?.() === true) {
    setOutcome({ status: "completed", reason: "agent_loop_completed" });
  }

  if (outcome === null) {
    const language = callbacks.getPreferredLanguage?.() === "zh" ? "zh" : "en";
    const message = language === "zh"
      ? "本轮执行已停止，但运行时没有提交完成、暂停、失败或取消终态。任务保持未完成，请检查阻断原因后恢复。"
      : "The run stopped without committing a completed, paused, failed, or aborted terminal state. The task remains incomplete; inspect the blocker and resume.";
    logAgentEvent("agent_loop_missing_terminal_outcome", {
      pendingTurnCompletion: orchestrator.hasPendingTurnCompletion?.() === true,
    });
    orchestrator.pauseActiveRun?.("agent_loop_no_terminal_outcome", message);
    callbacks.onNonActionableStop?.(message, "no_action", {
      phase: "paused",
      recoveryReason: "agent_loop_no_terminal_outcome",
      nextStep: message,
    });
    callbacks.onStatusChange?.("idle");
    setOutcome({
      status: "stopped_no_action",
      reason: "agent_loop_no_terminal_outcome",
    });
  }
  if (outcome === null) {
    throw new Error("Agent loop terminal outcome resolution failed");
  }

  let completionGuardRequestedIdle = false;
  const completionGuardCallbacks: OrchestratorCallbacks = {
    ...callbacks,
    onStatusChange: (status) => {
      if (status === "idle") {
        completionGuardRequestedIdle = true;
        return;
      }
      callbacks.onStatusChange(status);
    },
  };
  const guardedOutcome = runAgentLoopCompletionGuards({
    outcome,
    callbacks: completionGuardCallbacks,
    latestTurnContract: orchestrator.getLatestTurnContract(),
    sawExecutionEvidence: orchestrator.hasExecuteOperationEvidence(),
    executeRecoveryState: orchestrator.getLatestExecuteRecoveryState?.() ?? null,
  });
  if (guardedOutcome.status === "completed") {
    orchestrator.commitPendingTurnCompletion?.();
  } else {
    orchestrator.discardPendingTurnCompletion?.();
    const language = callbacks.getPreferredLanguage?.() === "zh" ? "zh" : "en";
    orchestrator.pauseActiveRun?.(
      guardedOutcome.reason,
      language === "zh"
        ? `本轮未提交为完成：${guardedOutcome.reason}。`
        : `The run was not committed as complete: ${guardedOutcome.reason}.`,
    );
    if (completionGuardRequestedIdle) {
      callbacks.onStatusChange("idle");
    }
  }
  return guardedOutcome;
}
