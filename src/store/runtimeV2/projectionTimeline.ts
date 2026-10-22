import type { TaskBlock } from "../../lib/taskTypes";
import type { TurnAggregateV1 } from "../../lib/runtime-v2";
import { withTurnRuntimePhaseStatus } from "../../lib/turnPhase";
import { isRuntimeV2ValidationAttempt } from "../../lib/runtime-v2/validationAttempt";

/** Derive settled timeline rows from canonical command and effect receipts.
 * This projection has no store or lifecycle authority of its own. */
export function reconcileRuntimeV2TimelineBlocks(
  taskFlow: readonly TaskBlock[],
  aggregate: TurnAggregateV1,
  timestampMs: number,
  language: "zh" | "en",
): TaskBlock[] {
  const run = aggregate.run?.identity;
  if (!run) return [...taskFlow];
  const receipts = new Map(
    aggregate.completedCommands.map((receipt) => [receipt.idempotencyKey, receipt.status] as const),
  );
  const validationOutcomes = new Map(
    aggregate.events
      .filter((event) => event.type === "validation.completed")
      .map((event) => [event.idempotencyKey, isRuntimeV2ValidationAttempt(event) && event.passed] as const),
  );
  const completions = new Map(
    aggregate.events
      .filter((event) =>
        event.type === "tool.completed" ||
        event.type === "validation.completed"
      )
      .map((event) => [event.idempotencyKey, event] as const),
  );
  return taskFlow.flatMap((block) => {
    if (
      (block.type !== "progress" && block.type !== "tool") ||
      block.turnId !== run.turnId ||
      block.runId !== run.runId ||
      !String(block.dedupeKey || "").startsWith("runtime-v2-timeline:")
    ) {
      return [block];
    }
    const receipt = block.toolCallId ? receipts.get(block.toolCallId) : undefined;
    const blockRunning = block.type === "progress"
      ? block.status === "running"
      : block.toolStatus === "running";
    if (!receipt || !blockRunning) return [block];
    // A canceled command remains canonical in the runtime ledger and final
    // projection. Remove only its provisional UI row instead of relabeling it
    // as either a successful or failed operation.
    if (receipt === "canceled") return [];
    const validationPassed = block.toolCallId
      ? validationOutcomes.get(block.toolCallId)
      : undefined;
    const failed = receipt === "failed" || validationPassed === false;
    if (block.type === "tool") {
      const completion = block.toolCallId
        ? completions.get(block.toolCallId)
        : undefined;
      const toolFailed =
        completion?.type === "tool.completed" &&
        completion.status !== "succeeded";
      const terminalFailed = failed || toolFailed;
      const presentation = completion?.presentation;
      const notExecuted = completion?.type === "validation.completed" && !isRuntimeV2ValidationAttempt(completion);
      const fallbackMessage = notExecuted
        ? language === "zh" ? "该验证未执行，没有产生通过或失败结果。" : "This validator was not executed and produced no pass or failure result."
        : terminalFailed
        ? validationPassed === false
          ? language === "zh"
            ? "有限验证未通过；运行时已保留真实失败输出供后续修复。"
            : "Validation did not pass; Runtime retained the real failure output for the next repair."
          : language === "zh"
            ? "该结构化工具动作未成功完成。"
            : "The structured tool action did not complete successfully."
        : "";
      return [{
        ...block,
        toolName: presentation?.toolName || block.toolName,
        executionName: presentation?.toolName || block.executionName,
        target: presentation?.target || block.target,
        status: terminalFailed ? "error" : "done",
        toolStatus: notExecuted ? "rejected" : terminalFailed ? "failed" : "executed",
        turnPhase: withTurnRuntimePhaseStatus(
          block.turnPhase,
          terminalFailed ? "failed" : "done",
          language,
        ),
        message: presentation?.message || fallbackMessage,
        observationSummary:
          presentation?.observationSummary ||
          presentation?.message ||
          fallbackMessage,
        ...(presentation?.diff
          ? {
              diff: { ...presentation.diff },
              workspaceEffect: terminalFailed
                ? "partial" as const
                : "verified" as const,
            }
          : {}),
      }];
    }
    return [{
      ...block,
      status: failed ? "failed" as const : "done" as const,
      evidence: !failed
        ? ""
        : validationPassed === false
          ? language === "zh"
            ? "有限验证未通过；运行时将根据已保留的失败证据继续修复。"
            : "Validation did not pass; Runtime will continue from the retained failure evidence."
        : language === "zh"
          ? "该结构化动作已记录为失败，运行时将从已保留的证据继续恢复。"
          : "The structured action was recorded as failed; recovery will continue from retained evidence.",
      updatedAt: timestampMs,
    }];
  });
}
