import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import { isStreamOutputLimited, type OpenAiToolChoice, type StreamResult, type StreamSettings } from "../../lib/streaming";
import type { ToolDefinition } from "../../lib/toolSchemas";
import { detectResponseLanguageMismatch } from "../../lib/workflowModels";
import {
  deriveRuntimeV2PlanExecutionCoverage,
  RuntimeV2ProviderProtocolError,
  runtimeV2CommandTaskReadyForConclusion,
  runtimeV2DirectExecuteReadyForConclusion,
  type RuntimeV2Command,
  type RuntimeV2ProviderRecoveryPressure,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2ProviderActionWindow,
} from "./executionTypes";

export const RUNTIME_V2_EXECUTION_PROVIDER_MAX_OUTPUT_TOKENS = 8_192;
export const RUNTIME_V2_EXECUTION_ACTION_MAX_OUTPUT_TOKENS = 8_192;
export const RUNTIME_V2_EXECUTION_RECOVERY_MAX_OUTPUT_TOKENS = 4_096;
export const RUNTIME_V2_EXECUTION_VALIDATION_MAX_OUTPUT_TOKENS = 4_096;
export const RUNTIME_V2_EXECUTION_CONCLUSION_MAX_OUTPUT_TOKENS = 4_096;
export const RUNTIME_V2_EXECUTION_REASONING_ONLY_CHAR_LIMIT = 32_000;
export const RUNTIME_V2_EXECUTION_REASONING_ONLY_TIMEOUT_MS = 60_000;
export const RUNTIME_V2_EXECUTION_ACTIONLESS_CHAR_LIMIT = 16_000;
export const RUNTIME_V2_EXECUTION_REQUIRED_ACTIONLESS_CHAR_LIMIT = 12_000;

export function runtimeV2CurrentToolSurfaceInstruction(
  tools: readonly ToolDefinition[],
  actionRequired = false,
): string {
  const names = tools.map((tool) => tool.function.name);
  if (names.length === 0) {
    return "CURRENT_TOOL_SURFACE: this decision exposes no tools. Return your response directly; do not emit a tool name.";
  }
  return [
    `CURRENT_TOOL_SURFACE: this decision exposes exactly ${names.length} ${names.length === 1 ? "tool" : "tools"}: ${names.join(", ")}.`,
    names.includes("tool_search")
      ? "Call tool_search if you need specialized or MCP tools not listed above."
      : "",
    actionRequired
      ? names.length === 1
        ? `This decision requires exactly one structured action, and it must be ${names[0]}.`
        : "This decision requires exactly one structured action from the list above."
      : "",
  ].filter(Boolean).join(" ");
}

export function runtimeV2ExecutionEffectiveToolChoice(input: {
  readonly requested: OpenAiToolChoice | null;
  readonly tools: readonly ToolDefinition[];
  readonly textEnvelope: boolean;
  readonly forceStructuredAction?: boolean;
}): OpenAiToolChoice | null {
  if (
    !input.textEnvelope &&
    input.forceStructuredAction &&
    input.tools.length > 0
  ) {
    return "required";
  }
  return input.requested;
}

export function runtimeV2RecoveryRequiresStructuredAction(
  pressure: RuntimeV2ProviderRecoveryPressure | null | undefined,
): boolean {
  // A complete ordinary reply carries a strategy/acceptance gap, not a failed
  // structured decoding attempt. Keep prose and optional authorized actions
  // available so recovery can use its exact causal feedback.
  return !!pressure && ["empty_response", "provider_response_rejected", "output_truncated"].includes(pressure.reason);
}

export function shouldRetryRuntimeV2WithoutReasoning(input: {
  readonly finishReason: string | null | undefined;
  readonly clientStopReason?: StreamResult["clientStopReason"];
  readonly reasoningChars: number;
  readonly actionChars?: number;
  readonly toolCallCount: number;
  readonly availableToolCount: number;
  readonly reasoningRequest: string | null | undefined;
  readonly providerSupportsReasoningToggle: boolean;
  readonly structuredActionRequired?: boolean;
}): boolean {
  const boundedReasoningDraft =
    input.providerSupportsReasoningToggle && input.reasoningChars > 0;
  const boundedVisibleDraft =
    input.structuredActionRequired === true &&
    Number(input.actionChars) > 0;
  return isStreamOutputLimited(input) &&
    input.toolCallCount === 0 &&
    (boundedReasoningDraft ||
      (input.availableToolCount > 0 && boundedVisibleDraft));
}

export function runtimeV2ProviderOutputWasTruncated(input: {
  readonly finishReason: string | null | undefined;
  readonly clientStopReason?: StreamResult["clientStopReason"];
  readonly toolCallCount: number;
  readonly availableToolCount: number;
}): boolean {
  return isStreamOutputLimited(input) &&
    input.toolCallCount === 0;
}

export function providerMessageChars(
  message: {
    readonly content: string | readonly {
      readonly type: string;
      readonly text?: string;
    }[];
    readonly reasoning_content?: string;
    readonly reasoning?: string;
  },
): number {
  const contentChars = typeof message.content === "string"
    ? message.content.length
    : message.content.reduce(
        (sum, part) =>
          sum + (part.type === "text" ? String(part.text || "").length : 128),
        0,
      );
  return contentChars +
    String(message.reasoning_content || message.reasoning || "").length;
}

export function runtimeV2ExecutionProviderOutputTokenLimit(
  command: RuntimeV2Command,
  _textEnvelope: boolean,
  budget?: Pick<RuntimeContextBudget, "outputBudget"> | null,
  actionWindow?: RuntimeV2ProviderActionWindow | null,
): number {
  const mode = String(command.payload.mode || "").trim();
  const recoveryPressure = command.payload.recoveryPressure;
  const recovering = !!recoveryPressure &&
    typeof recoveryPressure === "object" &&
    !Array.isArray(recoveryPressure) &&
    (recoveryPressure as Record<string, unknown>).reason !== "non_actionable_response";
  const answering = mode === "chat" || mode === "analyze" || mode === "conclude";
  // Answer synthesis uses the Run's output allocation, bounded by the same
  // parent-request ceiling as an ordinary observation. An action recovery
  // cap must not consume the answer budget merely because prior output was
  // truncated. The smaller conclusion value is only a no-budget fallback.
  const modeLimit = answering
    ? mode === "conclude" && !budget
      ? RUNTIME_V2_EXECUTION_CONCLUSION_MAX_OUTPUT_TOKENS
      : RUNTIME_V2_EXECUTION_PROVIDER_MAX_OUTPUT_TOKENS
    : actionWindow || recovering
    ? RUNTIME_V2_EXECUTION_RECOVERY_MAX_OUTPUT_TOKENS
    : mode === "validate"
      ? RUNTIME_V2_EXECUTION_VALIDATION_MAX_OUTPUT_TOKENS
      : mode === "execute"
        ? RUNTIME_V2_EXECUTION_ACTION_MAX_OUTPUT_TOKENS
        : RUNTIME_V2_EXECUTION_PROVIDER_MAX_OUTPUT_TOKENS;
  return Math.max(
    1,
    Math.min(
      budget?.outputBudget ??
        modeLimit,
      modeLimit,
    ),
  );
}

/**
 * Preserve configured reasoning outside a real action/recovery boundary.
 * Visible source alone does not require action decoding or a workspace effect.
 */
export function runtimeV2ExecutionReasoningRequest(input: {
  readonly configured: StreamSettings["reasoningRequest"];
  readonly providerSupportsReasoningToggle: boolean;
  readonly structuredActionRequired?: boolean;
  readonly recoveringFromRejectedAction?: boolean;
  readonly recoveryStage?: string;
  readonly actionWindow?: RuntimeV2ProviderActionWindow | null;
}): StreamSettings["reasoningRequest"] {
  // Semantic rejection is not evidence of a reasoning/decoder failure. Only
  // the request-local, output-limited retry below may disable reasoning.
  if (
    input.actionWindow &&
    input.providerSupportsReasoningToggle &&
    input.configured !== "off"
  ) {
    return "explicit";
  }
  return input.configured;
}

export function runtimeV2ProviderProtocolError(input: {
  ports: RuntimeV2ExecutionPortsInput;
  command: RuntimeV2Command;
  code:
    | "required_tool_missing"
    | "output_truncated"
    | "tool_surface_rejected"
    | "tool_arguments_rejected"
    | "repeated_action_rejected";
  requestedToolNames: readonly string[];
  allowedToolNames: readonly string[];
  detail?: string;
  preferredValidationCommand?: string;
}): RuntimeV2ProviderProtocolError {
  const message = input.detail || (
    input.code === "required_tool_missing"
      ? "The previous response did not submit the structured tool call required by the current phase."
      : input.code === "output_truncated"
        ? "The previous response reached the provider output limit before it produced a complete action or conclusion."
      : `The previous response requested unavailable tools: ${input.requestedToolNames.join(", ") || "unknown"}.`
  );
  return new RuntimeV2ProviderProtocolError(input.code, message);
}


export function runtimeV2ExecutionProviderDeadlineAt(
  _now: number,
  lifecycleDeadlineAt?: number,
): number | undefined {
  // Ordinary Execute has no whole-request wall-clock budget. Streaming owns a
  // phase watchdog, so a slow but active local model can keep producing output
  // without its request being canceled merely because total generation time is
  // long. An explicit caller-owned lifecycle budget remains enforceable.
  return Number.isFinite(lifecycleDeadlineAt)
    ? Number(lifecycleDeadlineAt)
    : undefined;
}

export function buildRuntimeV2ConcludePrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return "All tools are closed. Deliver the final Markdown answer directly from the conversation and available evidence, and do not output <tool_call> tags.";
  }
  return "工具调用已结束。请直接基于本轮对话和已确认的真实证据，用简体中文输出清晰、完整、结构化的最终 Markdown 总结（按任务复杂度自适应详略，说明关键改动/结论、原因与验证结果），不要输出 <tool_call> 标签。";
}

export function canRuntimeV2RequestConcludeWithProse(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly requestMode: string;
  readonly readOnly?: boolean;
}): boolean {
  if (
    input.readOnly === true ||
    input.requestMode === "conclude" ||
    input.aggregate?.phase === "finalizing" ||
    input.aggregate?.strategy === "chat" ||
    input.aggregate?.strategy === "analyze"
  ) {
    return true;
  }
  if (input.requestMode === "validate" || input.requestMode === "observe") {
    return false;
  }
  if (input.requestMode === "execute") {
    if (!input.aggregate) return false;
    if (input.aggregate.strategy === "plan") {
      const coverage = deriveRuntimeV2PlanExecutionCoverage(input.aggregate);
      return Boolean(
        coverage &&
          coverage.allMutationTargetsCovered &&
          coverage.allRequiredValidationsPassed,
      );
    }
    return (
      runtimeV2DirectExecuteReadyForConclusion(input.aggregate) ||
      runtimeV2CommandTaskReadyForConclusion(input.aggregate)
    );
  }
  return true;
}

export function buildRuntimeV2LanguageRetryFeedback(
  language: "zh" | "en",
  options?: { readonly hasToolsAvailable?: boolean },
): string {
  if (options?.hasToolsAvailable) {
    return language === "en"
      ? "The previous reply used the wrong natural language. If actions remain, call the next required structured tool directly; otherwise rewrite the complete, well-structured final Markdown answer in English while keeping code, paths, identifiers, and commands unchanged, without mentioning the retry."
      : "上一次回复使用了错误的自然语言（英文）。如果仍有待执行步骤，请直接调用所需的工具；若已可收尾，请用简体中文重新输出完整、结构清晰的最终 Markdown 答复，并保留代码、路径、标识符和命令原样，不要提及语言纠错。";
  }
  if (language === "en") {
    return "The previous reply used the wrong natural language. Rewrite the complete, well-structured final Markdown answer in English; keep code, paths, identifiers, and commands unchanged, and do not mention the retry.";
  }
  return "上一次回复使用了错误的自然语言（英文）。请直接用简体中文重新输出完整、结构清晰的最终 Markdown 答复；保留代码、路径、标识符和命令原样，不要提及语言纠错或重试过程。";
}

export function evaluateRuntimeV2LanguageRetry(input: {
  readonly text: string;
  readonly targetLanguage: "zh" | "en";
  readonly aborted: boolean;
  readonly toolCallCount: number;
  readonly hasProtocolViolation: boolean;
  readonly outputTruncated: boolean;
  readonly proseConclusionAllowed?: boolean;
}): {
  readonly shouldRetry: boolean;
  readonly detectedLanguage: "zh" | "en" | null;
  readonly hanCount: number;
  readonly latinWords: number;
} {
  const candidate = String(input.text || "").trim();
  if (
    input.aborted ||
    input.toolCallCount > 0 ||
    input.hasProtocolViolation ||
    input.outputTruncated ||
    input.proseConclusionAllowed === false ||
    !candidate
  ) {
    return { shouldRetry: false, detectedLanguage: null, hanCount: 0, latinWords: 0 };
  }
  const check = detectResponseLanguageMismatch({
    text: candidate,
    targetLanguage: input.targetLanguage,
  });
  return {
    shouldRetry: check.mismatch,
    detectedLanguage: check.detectedLanguage,
    hanCount: check.hanCount,
    latinWords: check.latinWords,
  };
}
