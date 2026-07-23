import { logAgentEvent } from "../../orchestrator";
import {
  USER_CHOICE_PAUSE_REASON,
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
  isErrorAgentLoopOutcome,
  pausedAgentLoopOutcome,
} from "../../runOutcome";
import type { AgentLoopOutcome, OrchestratorCallbacks } from "../types";
import { AgentOrchestrator } from "./AgentOrchestrator";
import {
  isRecoverableRuntimePauseReason,
  resolveNonActionableStopOutcome,
  runAgentLoopCompletionGuards,
} from "./completionGuards";

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
    if (outcome?.status === "aborted") return;
    if (next.status === "aborted") {
      outcome = next;
      return;
    }
    if (outcome && isErrorAgentLoopOutcome(outcome)) return;
    if (isErrorAgentLoopOutcome(next) || outcome === null) outcome = next;
  };
  const invokePresentationCallback = (
    callbackName: "onAssistantFinalText" | "onNonActionableStop" | "onStatusChange" | "onError",
    invoke: () => void,
  ) => {
    try {
      invoke();
    } catch (error) {
      logAgentEvent("agent_loop_presentation_callback_failed", {
        callbackName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const wrappedCallbacks: OrchestratorCallbacks = {
    ...callbacks,
    onAssistantFinalText: (text, replyOptions = [], meta) => {
      const isSubagent = (callbacks.getSubagentDepth?.() ?? 0) > 0;
      if (!isSubagent && meta?.awaitingInput === true && replyOptions.length > 0) {
        setOutcome(pausedAgentLoopOutcome(USER_CHOICE_PAUSE_REASON, "action_required"));
        logAgentEvent("agent_loop_awaiting_user_choice", {
          replyOptions: replyOptions.length,
        });
      }
      invokePresentationCallback("onAssistantFinalText", () => {
        callbacks.onAssistantFinalText(
          text,
          isSubagent ? [] : replyOptions,
          isSubagent ? { ...meta, awaitingInput: false } : meta,
        );
      });
    },
    onNonActionableStop: (message, reason, progress) => {
      const nonActionableOutcome = resolveNonActionableStopOutcome(reason, progress, {
        sawExecutionEvidence: orchestrator.hasExecuteOperationEvidence(),
      });
      setOutcome(nonActionableOutcome);
      // Commit the exact recoverable boundary before AgentOrchestrator's
      // generic stopped-run fallback can publish `assistant_stopped`.
      // Otherwise the terminal transaction sees two different run.paused
      // meanings, rejects the projection, and can leave the UI owner running.
      if (nonActionableOutcome.status === "paused") {
        orchestrator.pauseActiveRun?.(nonActionableOutcome.reason, message);
      }
      invokePresentationCallback("onNonActionableStop", () => {
        callbacks.onNonActionableStop(message, reason, progress);
      });
    },
    onError: (error) => {
      setOutcome(completedAgentLoopOutcome(buildAgentLoopErrorReason(error), "error"));
      invokePresentationCallback("onError", () => callbacks.onError(error));
    },
    onStatusChange: (status) => {
      invokePresentationCallback("onStatusChange", () => callbacks.onStatusChange(status));
    },
  };

  try {
    await orchestrator.execute(wrappedCallbacks, abortController);
  } catch (error) {
    const errorReason = buildAgentLoopErrorReason(error);
    if (!(outcome && isErrorAgentLoopOutcome(outcome))) {
      const visibleError = error instanceof Error
        ? error.message
        : String(error || errorReason);
      wrappedCallbacks.onError(visibleError || errorReason);
    }
    setOutcome(completedAgentLoopOutcome(errorReason, "error"));
  }

  const runPauseReason = orchestrator.getLatestRunPauseReason?.();
  if (runPauseReason && outcome === null) {
    if (isRecoverableRuntimePauseReason(runPauseReason)) {
      setOutcome(pausedAgentLoopOutcome(runPauseReason, "recoverable"));
    } else if (
      runPauseReason === "plan_review_required" ||
      runPauseReason === USER_CHOICE_PAUSE_REASON
    ) {
      setOutcome(pausedAgentLoopOutcome(runPauseReason, "action_required"));
    } else {
      setOutcome(completedAgentLoopOutcome(runPauseReason, "blocked"));
    }
  }

  if (abortController.signal.aborted) {
    orchestrator.discardPendingTurnCompletion?.();
    return abortedAgentLoopOutcome();
  }

  if (outcome === null && orchestrator.hasPendingTurnCompletion?.() === true) {
    setOutcome(completedAgentLoopOutcome("agent_loop_completed", "success"));
  }

  if (outcome === null) {
    const language = callbacks.getPreferredLanguage?.() === "zh" ? "zh" : "en";
    const message = language === "zh"
      ? "本轮执行已停止，但运行时没有提交完成、暂停或取消终态。任务保持未完成，请检查阻断原因后恢复。"
      : "The run stopped without committing a completed, paused, or aborted terminal state. The task remains incomplete; inspect the blocker and resume.";
    logAgentEvent("agent_loop_missing_terminal_outcome", {
      pendingTurnCompletion: orchestrator.hasPendingTurnCompletion?.() === true,
    });
    wrappedCallbacks.onNonActionableStop?.(message, "no_action", {
      phase: "paused",
      recoveryReason: "agent_loop_no_terminal_outcome",
      nextStep: message,
    });
    wrappedCallbacks.onStatusChange?.("idle");
    setOutcome(completedAgentLoopOutcome("agent_loop_no_terminal_outcome", "error"));
  }
  const resolvedOutcome = outcome as AgentLoopOutcome | null;
  if (resolvedOutcome === null) {
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
      wrappedCallbacks.onStatusChange(status);
    },
  };
  const guardedOutcome = resolvedOutcome.status === "completed" && resolvedOutcome.resultKind === "success"
    ? runAgentLoopCompletionGuards({
        outcome: resolvedOutcome,
        callbacks: completionGuardCallbacks,
        latestTurnContract: orchestrator.getLatestTurnContract(),
        sawExecutionEvidence: orchestrator.hasExecuteOperationEvidence(),
        executeRecoveryState: orchestrator.getLatestExecuteRecoveryState?.() ?? null,
      })
    : resolvedOutcome;
  if (guardedOutcome.status === "completed") {
    if (guardedOutcome.resultKind !== "success") {
      orchestrator.discardPendingTurnCompletion?.();
    } else {
      orchestrator.commitPendingTurnCompletion?.();
    }
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
      wrappedCallbacks.onStatusChange("idle");
    }
  }
  return guardedOutcome;
}
