import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import type { OpenAiToolChoice, StreamSettings } from "../../lib/streaming";
import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  RuntimeV2ProviderProtocolError,
  type RuntimeV2Command,
} from "../../lib/runtime-v2";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2ProviderActionWindow,
} from "./executionTypes";

export const RUNTIME_V2_EXECUTION_PROVIDER_MAX_OUTPUT_TOKENS = 8_192;
export const RUNTIME_V2_EXECUTION_ACTION_MAX_OUTPUT_TOKENS = 4_096;
export const RUNTIME_V2_EXECUTION_RECOVERY_MAX_OUTPUT_TOKENS = 2_048;
export const RUNTIME_V2_EXECUTION_CONTRACT_MAX_OUTPUT_TOKENS = 4_096;
export const RUNTIME_V2_EXECUTION_VALIDATION_MAX_OUTPUT_TOKENS = 2_048;
export const RUNTIME_V2_EXECUTION_CONCLUSION_MAX_OUTPUT_TOKENS = 2_048;
export const RUNTIME_V2_EXECUTION_REASONING_ONLY_CHAR_LIMIT = 4_000;
export const RUNTIME_V2_EXECUTION_ACTIONLESS_CHAR_LIMIT = 3_000;
export const RUNTIME_V2_EXECUTION_REQUIRED_ACTIONLESS_CHAR_LIMIT = 1_000;
export const RUNTIME_V2_EXECUTION_CONTRACT_ACTIONLESS_CHAR_LIMIT = 1_200;
export const RUNTIME_V2_EXECUTION_CONTRACT_REASONING_RECOVERY_CHAR_LIMIT =
  12_000;

export function runtimeV2CurrentToolSurfaceInstruction(
  tools: readonly ToolDefinition[],
  actionRequired = false,
): string {
  const names = tools.map((tool) => tool.function.name);
  if (names.length === 0) {
    return [
      "CURRENT_TOOL_SURFACE: this decision exposes no tools.",
      "Do not emit a tool name, tool-call wrapper, or pseudo command; return only the concise evidence report requested above.",
    ].join(" ");
  }
  return [
    `CURRENT_TOOL_SURFACE: this decision exposes exactly ${names.length} tool${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`,
    "A tool mentioned in earlier conversation but absent from this exact list is unavailable now.",
    actionRequired
      ? names.length === 1
        ? `This decision requires exactly one structured action, and it must be ${names[0]}.`
        : "This decision requires exactly one structured action chosen from this exact list."
      : names.length === 1
        ? `If you take an action, it must be ${names[0]}.`
        : "If you take an action, choose only from this exact list.",
  ].join(" ");
}

export function runtimeV2ExecutionEffectiveToolChoice(input: {
  readonly requested: OpenAiToolChoice | null;
  readonly tools: readonly ToolDefinition[];
  readonly textEnvelope: boolean;
  readonly forceStructuredAction?: boolean;
}): OpenAiToolChoice | null {
  if (!input.textEnvelope && input.tools.length === 1) {
    const name = input.tools[0]?.function.name;
    if (name === "record_execution_contract") {
      return { type: "function", function: { name } };
    }
  }
  if (
    !input.textEnvelope &&
    input.forceStructuredAction &&
    input.tools.length > 0
  ) {
    if (input.tools.length === 1) {
      const name = input.tools[0]!.function.name;
      return { type: "function", function: { name } };
    }
    return "required";
  }
  return input.requested;
}

export function shouldRetryRuntimeV2WithoutReasoning(input: {
  readonly finishReason: string | null | undefined;
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
  return input.availableToolCount > 0 &&
    input.finishReason === "length" &&
    input.toolCallCount === 0 &&
    (boundedReasoningDraft || boundedVisibleDraft);
}

export function runtimeV2ProviderOutputWasTruncated(input: {
  readonly finishReason: string | null | undefined;
  readonly toolCallCount: number;
  readonly availableToolCount: number;
}): boolean {
  return input.availableToolCount > 0 &&
    input.finishReason === "length" &&
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
  contractOnlyAction = false,
): number {
  const mode = String(command.payload.mode || "").trim();
  const recoveryPressure = command.payload.recoveryPressure;
  const recovering = !!recoveryPressure &&
    typeof recoveryPressure === "object" &&
    !Array.isArray(recoveryPressure);
  const modeLimit = contractOnlyAction
    ? RUNTIME_V2_EXECUTION_CONTRACT_MAX_OUTPUT_TOKENS
    : actionWindow || recovering
    ? RUNTIME_V2_EXECUTION_RECOVERY_MAX_OUTPUT_TOKENS
    : mode === "validate"
      ? RUNTIME_V2_EXECUTION_VALIDATION_MAX_OUTPUT_TOKENS
      : mode === "execute"
        ? RUNTIME_V2_EXECUTION_ACTION_MAX_OUTPUT_TOKENS
        : mode === "conclude"
          ? RUNTIME_V2_EXECUTION_CONCLUSION_MAX_OUTPUT_TOKENS
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
 * Once exact source is visible but no workspace effect exists, a documented
 * reasoning toggle can switch the next request into action decoding. This is
 * capability- and state-based; model/provider names never enter the policy.
 */
export function runtimeV2ExecutionReasoningRequest(input: {
  readonly configured: StreamSettings["reasoningRequest"];
  readonly sourceOnlyFrontier: boolean;
  readonly hasMutationTool: boolean;
  readonly providerSupportsReasoningToggle: boolean;
  readonly contractOnlyAction?: boolean;
  readonly structuredActionRequired?: boolean;
  readonly recoveringFromRejectedAction?: boolean;
  readonly recoveryStage?: string;
  readonly actionWindow?: RuntimeV2ProviderActionWindow | null;
}): StreamSettings["reasoningRequest"] {
  // A state-machine-required action already has its causal boundary in the
  // durable transcript. Opening another hidden analysis phase here lets a
  // model reconsider a closed branch, repeat unavailable reads, or serialize
  // a required tool schema as prose. Decode the next structured action
  // directly when the adapter exposes a documented reasoning toggle.
  if (
    (input.contractOnlyAction || input.structuredActionRequired) &&
    input.providerSupportsReasoningToggle
  ) {
    return "off";
  }
  if (
    input.recoveringFromRejectedAction &&
    input.providerSupportsReasoningToggle &&
    input.configured !== "off"
  ) {
    return "off";
  }
  if (
    input.actionWindow &&
    input.providerSupportsReasoningToggle &&
    input.configured !== "off"
  ) {
    return "explicit";
  }
  return !input.recoveringFromRejectedAction &&
      input.sourceOnlyFrontier &&
      input.hasMutationTool &&
      input.providerSupportsReasoningToggle &&
      input.configured !== "off"
    ? "off"
    : input.configured;
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
