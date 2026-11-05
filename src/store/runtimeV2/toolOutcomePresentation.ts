import type { RuntimeV2Event } from "../../lib/runtime-v2/events";
import { isRuntimeV2UnexecutedToolReceipt } from "../../lib/runtime-v2/toolReceipt";
import { isRuntimeV2ValidationAttempt } from "../../lib/runtime-v2/validationAttempt";
import { buildToolResultPresentation } from "../../lib/toolResultPresentation";

type Completion = Extract<RuntimeV2Event, { type: "tool.completed" | "validation.completed" }>;

/** UI copy only. Canonical receipts and provider feedback retain their exact
 * contents; a transport settlement never becomes an attempted operation. */
export function runtimeV2ToolOutcomePresentation(completion: Completion, language: "zh" | "en") {
  const notExecuted = isRuntimeV2UnexecutedToolReceipt(completion) ||
    (completion.type === "validation.completed" && !isRuntimeV2ValidationAttempt(completion));
  const blocked = completion.type === "tool.completed" && completion.status === "blocked";
  const failed = completion.type === "tool.completed" ? completion.status === "failed" : !completion.passed;
  const toolOutcome = notExecuted ? "not_executed" : blocked ? "blocked" : failed ? "failed" : "succeeded";
  const presentation = completion.presentation;
  // Display previews may be truncated in the middle of an owned JSON/read
  // envelope. Parse its intact canonical model receipt before formatting;
  // neither the receipt nor the execution outcome is changed here.
  const readMessage = completion.type === "tool.completed" ? completion.modelContent || presentation?.message : presentation?.message;
  const readPresentation = toolOutcome === "succeeded" && presentation
    ? buildToolResultPresentation({ toolName: presentation.toolName, message: readMessage || "", language }) : undefined;
  const readableRead = readPresentation?.kind === "text" && readPresentation.parsed ? readPresentation : undefined;
  const message = toolOutcome === "not_executed"
    ? language === "zh" ? "本操作未执行，没有产生成功或失败结果。" : "This operation was not executed and produced no success or failure result."
    : toolOutcome === "blocked"
    ? language === "zh" ? "本操作被阻止，未执行。请根据权限或前置条件调整后续操作。" : "This operation was blocked before execution. Adjust the next action to its permissions and prerequisites."
    : toolOutcome === "failed" && completion.type === "tool.completed"
    ? language === "zh" ? "执行失败，原始输出已保留在调试详情中。" : "Execution failed. The original output is available in debug details."
    : readableRead ? readMessage || "" : presentation?.message || (failed
      ? language === "zh" ? "验证未通过，请检查失败输出。" : "Validation did not pass; inspect the failure output."
      : "");
  const diagnosticDetails = toolOutcome === "succeeded" && !readableRead ? undefined : [
    completion.failureKind,
    completion.failureReasonCode,
    presentation?.message,
    presentation?.observationSummary,
    completion.type === "tool.completed" ? completion.modelContent : undefined,
  ].filter((value, index, all) => value && all.indexOf(value) === index).join("\n");
  return { toolOutcome, message, diagnosticDetails, target: readableRead?.displayTarget,
    observationSummary: completion.type === "validation.completed" && !notExecuted
      ? presentation?.observationSummary || message : readableRead?.meta[0] || message } as const;
}
