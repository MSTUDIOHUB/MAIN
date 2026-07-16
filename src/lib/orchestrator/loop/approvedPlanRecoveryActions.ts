import {
  buildPlanProgressSignatureFromToolActivity,
  summarizeRepeatedPlanTargetsFromToolActivity,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import type {
  PlanExecutionProgressPhase,
  PlanExecutionProgressUpdate,
} from "../../workflowModels";
import type { TaskOrchestratorPhase } from "../../taskTargeting";
import {
  isStreamWatchdogTimeoutMessage,
  logAgentEvent,
  truncateForLog,
} from "../../orchestrator";
import type { OrchestratorCallbacks } from "../types";

type EmitPlanExecutionProgress = (
  phase: PlanExecutionProgressPhase,
  overrides?: Partial<PlanExecutionProgressUpdate>,
) => void;

type EmitTaskOrchestratorPhase = (
  phase: TaskOrchestratorPhase,
  extra?: Record<string, unknown>,
) => void;

export function pauseApprovedPlanStreamWatchdog(input: {
  callbacks: OrchestratorCallbacks;
  iteration: number;
  recentPlanToolActivity: PlanToolActivitySummary[];
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  emitPlanExecutionProgress: EmitPlanExecutionProgress;
  message: string;
  logContext?: Record<string, unknown>;
}): boolean {
  const {
    callbacks,
    iteration,
    recentPlanToolActivity,
    emitTaskOrchestratorPhase,
    emitPlanExecutionProgress,
    message,
    logContext,
  } = input;
  if (!callbacks.getIsPlanApproved() || !isStreamWatchdogTimeoutMessage(message)) {
    return false;
  }

  const language = callbacks.getPreferredLanguage();
  const normalizedMessage = String(message || "").toLowerCase();
  const recoveryReason = normalizedMessage.includes("stream_max_elapsed_timeout")
    ? "stream_max_elapsed_timeout"
    : "stream_no_visible_progress_timeout";
  const repeatedTargets = summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
  const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
  const nextStep = language === "zh"
    ? "恢复后直接调用真实工具执行下一项计划任务，或说明具体阻塞"
    : "resume by calling real tools for the next plan task, or state the concrete blocker";
  const pauseNotice = language === "zh"
    ? [
        recoveryReason === "stream_max_elapsed_timeout"
          ? "执行已暂停：恢复期流式输出超过时间边界，但没有产生可执行工具结果。"
          : "执行已暂停：模型持续返回流式内容，但没有产生可见说明或工具调用。",
        "MAIN 已保留当前 workspace 状态，没有把这次不可见输出当作执行失败。",
        `最近工具目标：${repeatedTargets.length > 0 ? repeatedTargets.join("、") : "未定位到单一目标"}`,
        `建议恢复动作：${nextStep}。`,
      ].join("\n")
    : [
        recoveryReason === "stream_max_elapsed_timeout"
          ? "Execution paused: the recovery stream exceeded its time boundary without producing an executable tool result."
          : "Execution paused: the model kept streaming content but produced no visible explanation or tool call.",
        "MAIN kept the current workspace state and did not treat this invisible-output stall as an execution failure.",
        `Recent targets: ${repeatedTargets.length > 0 ? repeatedTargets.join(", ") : "no single target identified"}`,
        `Suggested recovery: ${nextStep}.`,
      ].join("\n");

  logAgentEvent("approved_plan_stream_watchdog_paused", {
    iteration,
    message: message.slice(0, 240),
    progressSignature: truncateForLog(progressSignature, 220),
    repeatedTargets,
    ...(logContext || {}),
  });
  emitTaskOrchestratorPhase("PAUSED", {
    reason: recoveryReason,
    iteration,
    repeatedTargets,
  });
  emitPlanExecutionProgress("paused", {
    progressSignature,
    repeatedTargets,
    recoveryReason,
    nextStep,
  });
  callbacks.onNonActionableStop(
    pauseNotice,
    "no_output",
    {
      progressSignature,
      repeatedTargets,
      recoveryReason,
      nextStep,
    },
  );
  callbacks.onStatusChange("idle");
  return true;
}
