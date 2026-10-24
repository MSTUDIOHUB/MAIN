import type { TaskBlock } from "../../lib/taskTypes";
import type { TurnAggregateV1 } from "../../lib/runtime-v2";
import { withTurnRuntimePhaseStatus } from "../../lib/turnPhase";
import { isRuntimeV2ValidationAttempt } from "../../lib/runtime-v2/validationAttempt";
import { runtimeV2ToolOutcomePresentation } from "./toolOutcomePresentation";

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
      block.runId !== run.runId
    ) {
      return [block];
    }
    const receipt = block.toolCallId ? receipts.get(block.toolCallId) : undefined;
    const blockRunning = block.type === "progress"
      ? block.status === "running"
      : block.toolStatus === "running" || block.toolStatus === "pending";
    // Permission-created and timeline-created rows share the exact command
    // receipt owner. Their presentation dedupe keys do not change execution
    // truth, including a canceled row that was still awaiting approval.
    if (!receipt) return [block];
    // A canceled command remains canonical in the runtime ledger and final
    // projection. Remove only its provisional UI row instead of relabeling it
    // as either a successful or failed operation.
    if (receipt === "canceled") return blockRunning ? [] : [block];
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
      const outcome = completion ? runtimeV2ToolOutcomePresentation(completion, language) : undefined;
      const notExecuted = outcome?.toolOutcome === "not_executed";
      const blocked = outcome?.toolOutcome === "blocked";
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
        target: outcome?.target || presentation?.target || block.target,
        status: notExecuted ? "not_executed" : blocked ? "blocked" : terminalFailed ? "error" : "done",
        toolStatus: notExecuted || blocked ? "rejected" : terminalFailed ? "failed" : "executed",
        toolOutcome: outcome?.toolOutcome,
        diagnosticDetails: outcome?.diagnosticDetails,
        turnPhase: withTurnRuntimePhaseStatus(
          block.turnPhase,
          terminalFailed && !notExecuted && !blocked ? "failed" : "done",
          language,
        ),
        message: outcome?.message || fallbackMessage,
        observationSummary:
          outcome?.observationSummary ||
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
    if (!blockRunning) return [block];
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
