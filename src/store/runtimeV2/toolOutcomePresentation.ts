import type { RuntimeV2Event } from "../../lib/runtime-v2/events";
import type { RuntimeV2ToolPresentation } from "../../lib/runtime-v2/contracts";
import type { ToolDiffPreview } from "../../lib/toolDiff";
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

function compactDiffText(
  value: string,
  start: number,
  end: number,
): string {
  const prefixOmitted = start > 0;
  const suffixOmitted = end < value.length;
  return [
    prefixOmitted ? "[... earlier unchanged content omitted ...]\n" : "",
    value.slice(start, end),
    suffixOmitted ? "\n[... later unchanged content omitted ...]" : "",
  ].join("");
}

export function boundedPresentationDiff(
  preview: ToolDiffPreview | undefined,
): RuntimeV2ToolPresentation["diff"] | undefined {
  if (!preview) return undefined;
  const oldText = String(preview.old || "");
  const newText = String(preview.new || "");
  const maxCombinedChars = 120_000;
  if (oldText.length + newText.length <= maxCombinedChars) {
    return {
      old: oldText,
      new: newText,
      ...(preview.path ? { path: preview.path } : {}),
      ...(typeof preview.existed === "boolean"
        ? { existed: preview.existed }
        : {}),
      ...(typeof preview.fullFile === "boolean"
        ? { fullFile: preview.fullFile }
        : {}),
    };
  }
  let commonPrefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (
    commonPrefix < maxPrefix &&
    oldText.charCodeAt(commonPrefix) === newText.charCodeAt(commonPrefix)
  ) {
    commonPrefix += 1;
  }
  let commonSuffix = 0;
  while (
    commonSuffix < oldText.length - commonPrefix &&
    commonSuffix < newText.length - commonPrefix &&
    oldText.charCodeAt(oldText.length - 1 - commonSuffix) ===
      newText.charCodeAt(newText.length - 1 - commonSuffix)
  ) {
    commonSuffix += 1;
  }
  const contextChars = 24_000;
  const oldStart = Math.max(0, commonPrefix - contextChars);
  const newStart = Math.max(0, commonPrefix - contextChars);
  const oldEnd = Math.min(
    oldText.length,
    oldText.length - commonSuffix + contextChars,
  );
  const newEnd = Math.min(
    newText.length,
    newText.length - commonSuffix + contextChars,
  );
  return {
    old: compactDiffText(oldText, oldStart, oldEnd),
    new: compactDiffText(newText, newStart, newEnd),
    ...(preview.path ? { path: preview.path } : {}),
    ...(typeof preview.existed === "boolean"
      ? { existed: preview.existed }
      : {}),
    ...(typeof preview.fullFile === "boolean"
      ? { fullFile: preview.fullFile }
      : {}),
  };
}
