import type { OpenAiToolChoice, StreamResult } from "./streaming";
import { extractTypedPlanDraftProtocolBlock } from "./planDraftIngress";
import { SUBMIT_PLAN_CANDIDATE_TOOL_NAME } from "./toolSchemas";

export interface NativePlanCandidateSubmissionAdaptation {
  result: StreamResult;
  consumed: boolean;
  callIds: string[];
  discardedVisibleChars: number;
  quarantinedToolNames: string[];
}

/**
 * Convert the native control-plane call into the exact text envelope consumed
 * by typed Plan ingress.  No ordinary tool result is manufactured and no
 * executor sees this call.  Surrounding model prose is deliberately dropped;
 * Markdown remains a one-way runtime projection after graph validation.
 */
export function consumeNativePlanCandidateSubmission(input: {
  result: StreamResult;
  enabled: boolean;
}): NativePlanCandidateSubmissionAdaptation {
  const unchanged = (): NativePlanCandidateSubmissionAdaptation => ({
    result: input.result,
    consumed: false,
    callIds: [],
    discardedVisibleChars: 0,
    quarantinedToolNames: [],
  });
  if (!input.enabled) return unchanged();
  const calls = input.result.toolCalls || [];
  const submissionCalls = calls.filter((call) =>
    call.name === SUBMIT_PLAN_CANDIDATE_TOOL_NAME
  );
  if (submissionCalls.length === 0) return unchanged();

  const unrelatedCalls = calls.filter((call) =>
    call.name !== SUBMIT_PLAN_CANDIDATE_TOOL_NAME
  );
  if (unrelatedCalls.length > 0) {
    return {
      result: {
        ...input.result,
        content: "",
        semanticContent: "",
        actionableContent: "",
        toolCalls: [],
        protocolViolation: "required_tool_call_not_available",
        protocolAllowedTools: [SUBMIT_PLAN_CANDIDATE_TOOL_NAME],
        protocolActualTools: calls.map((call) => call.name),
        protocolActualToolCalls: calls.map((call) => ({ ...call })),
      },
      consumed: false,
      callIds: submissionCalls.map((call) => String(call.id || "")),
      discardedVisibleChars: String(input.result.content || "").length,
      quarantinedToolNames: unrelatedCalls.map((call) => call.name),
    };
  }

  // Multiple submissions intentionally become multiple envelopes. Shared
  // ingress rejects them as ambiguous instead of choosing a provider-order
  // winner and silently changing Plan authority.
  const protocol = submissionCalls.map((call) =>
    `<plan_candidate>${String(call.arguments || "")}</plan_candidate>`
  ).join("\n");
  return {
    result: {
      ...input.result,
      content: protocol,
      semanticContent: protocol,
      actionableContent: protocol,
      toolCalls: [],
      finishReason: "stop",
    },
    consumed: true,
    callIds: submissionCalls.map((call) => String(call.id || "")),
    discardedVisibleChars: String(input.result.content || "").length,
    quarantinedToolNames: [],
  };
}

/**
 * Provider capability state advances only from the raw wire response. Prompt
 * exposure, visible-text adaptation, or a quarantined mixed transaction is
 * not evidence that native function calling worked.
 */
export function hasSuccessfulAllowedRawNativeToolCall(input: {
  rawResult: StreamResult;
  normalizedResult?: StreamResult;
  allowedToolNames: Iterable<string>;
}): boolean {
  const allowed = new Set(
    [...input.allowedToolNames]
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  );
  if (allowed.size === 0) return false;
  const normalized = input.normalizedResult || input.rawResult;
  if (normalized.protocolViolation || normalized.protocolTransportAdaptation) {
    return false;
  }
  const rawCalls = input.rawResult.toolCalls || [];
  return rawCalls.length > 0 && rawCalls.every((call) => allowed.has(call.name));
}

/**
 * OpenAI-compatible providers do not all enforce tool_choice=required. Preserve
 * that provider response for diagnostics, but mark it as a protocol violation
 * so the execution loop can recover instead of accepting a text stop as task
 * completion.
 */
export function annotateRequiredToolCallProtocolResult(
  result: StreamResult,
  toolChoice: OpenAiToolChoice | undefined,
  allowedToolNames?: Iterable<string>,
): StreamResult {
  const toolRequired = toolChoice === "required" ||
    (typeof toolChoice === "object" && toolChoice?.type === "function");
  if (!toolRequired) return result;
  const calls = result.toolCalls || [];
  if (calls.length === 0) {
    const allowed = allowedToolNames
      ? [...allowedToolNames].map((name) => String(name || "").trim()).filter(Boolean)
      : [];
    const expectedTool = typeof toolChoice === "object" && toolChoice.type === "function"
      ? String(toolChoice.function?.name || "").trim()
      : "";
    const soleTypedPlanSubmissionSurface =
      (allowed.length === 1 && allowed[0] === SUBMIT_PLAN_CANDIDATE_TOOL_NAME) ||
      expectedTool === SUBMIT_PLAN_CANDIDATE_TOOL_NAME;
    if (soleTypedPlanSubmissionSurface) {
      const contentProtocol = extractTypedPlanDraftProtocolBlock(result.content || "");
      if (contentProtocol) {
        // This is a transport adaptation, not a text-to-state shortcut. Only
        // a complete visible envelope on the sole Plan submission surface is
        // retained. Hidden provider reasoning is never promoted into Plan
        // authority; any provider channel repair belongs in its wire adapter.
        return {
          ...result,
          content: contentProtocol,
          semanticContent: contentProtocol,
          actionableContent: contentProtocol,
          finishReason: "stop",
          protocolTransportAdaptation: "typed_plan_text_envelope",
          protocolTransportSource: "content",
        };
      }
    }
    return { ...result, protocolViolation: "required_tool_call_missing" };
  }
  const allowed = allowedToolNames
    ? new Set([...allowedToolNames].map((name) => String(name || "").trim()).filter(Boolean))
    : null;
  const soleTypedPlanSubmissionSurface =
    allowed?.size === 1 && allowed.has(SUBMIT_PLAN_CANDIDATE_TOOL_NAME);
  if (
    soleTypedPlanSubmissionSurface &&
    calls.some((call) => call.name !== SUBMIT_PLAN_CANDIDATE_TOOL_NAME)
  ) {
    // A Plan proposal and an ordinary tool call are not one atomic intent.
    // Quarantine the entire provider transaction before the later native
    // submission adapter can accidentally accept only the safe-looking call.
    return {
      ...result,
      content: "",
      semanticContent: "",
      actionableContent: "",
      toolCalls: [],
      protocolViolation: "required_tool_call_not_available",
      protocolAllowedTools: [SUBMIT_PLAN_CANDIDATE_TOOL_NAME],
      protocolActualTools: calls.map((call) => call.name),
      protocolActualToolCalls: calls.map((call) => ({ ...call })),
    };
  }
  const surfaceCalls = allowed && allowed.size > 0
    ? calls.filter((call) => allowed.has(call.name))
    : calls;
  if (surfaceCalls.length === 0) {
    return {
      ...result,
      toolCalls: [],
      protocolViolation: "required_tool_call_not_available",
      protocolAllowedTools: allowed ? [...allowed] : [],
      protocolActualTools: calls.map((call) => call.name),
      protocolActualToolCalls: calls.map((call) => ({ ...call })),
    };
  }
  if (typeof toolChoice !== "object" || toolChoice.type !== "function") {
    return surfaceCalls.length === calls.length
      ? result
      : { ...result, toolCalls: surfaceCalls };
  }

  const expectedTool = String(toolChoice.function?.name || "").trim();
  if (!expectedTool) return result;
  const matchingCalls = surfaceCalls.filter((call) => call.name === expectedTool);
  if (matchingCalls.length > 0) {
    // Quarantine any extra provider call instead of letting a named function
    // choice execute unrelated work in the same transaction.
    return matchingCalls.length === calls.length
      ? result
      : { ...result, toolCalls: matchingCalls };
  }
  return {
    ...result,
    toolCalls: [],
    protocolViolation: "required_function_call_mismatch",
    protocolExpectedTool: expectedTool,
    protocolActualTools: calls.map((call) => call.name),
    protocolActualToolCalls: calls.map((call) => ({ ...call })),
  };
}
