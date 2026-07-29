import { deriveBudgetedStreamSettings } from "../../lib/providerLaneSettings";
import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import {
  streamChatCompletion,
  type OpenAiToolChoice,
} from "../../lib/streaming";
import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  normalizeProviderResponseV1,
  RuntimeV2ProviderProtocolError,
  type RuntimeV2Command,
  type RuntimeV2NormalizedProviderResult,
} from "../../lib/runtime-v2";
import {
  compactTextEnvelopeCatalog,
  boundRuntimeV2ProviderConversation,
  containsProviderTextEnvelopePrompt,
  latestAcceptanceFailureSourceWindow,
  preferredFiniteValidationCommand,
  providerHistory,
  recordApprovedPlanContext,
  recordModelContext,
  type RuntimeV2ExecutionPortsInput,
  type RuntimeV2LiveExecutionState,
} from "./executionContext";

export const RUNTIME_V2_EXECUTION_PROVIDER_MAX_OUTPUT_TOKENS = 8_192;
export const RUNTIME_V2_EXECUTION_TOOL_ENVELOPE_MAX_OUTPUT_TOKENS = 4_096;

export function runtimeV2ExecutionProviderOutputTokenLimit(
  command: RuntimeV2Command,
  textEnvelope: boolean,
  budget?: Pick<RuntimeContextBudget, "outputBudget"> | null,
): number {
  const phaseLimit =
    textEnvelope && command.payload.toolExpectation === "required"
      ? RUNTIME_V2_EXECUTION_TOOL_ENVELOPE_MAX_OUTPUT_TOKENS
      : budget?.outputBudget ??
        RUNTIME_V2_EXECUTION_PROVIDER_MAX_OUTPUT_TOKENS;
  return Math.max(
    1,
    Math.min(phaseLimit, budget?.outputBudget ?? phaseLimit),
  );
}

export function runtimeV2ProviderProtocolError(input: {
  ports: RuntimeV2ExecutionPortsInput;
  command: RuntimeV2Command;
  code:
    | "required_tool_missing"
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
      : `The previous response requested unavailable tools: ${input.requestedToolNames.join(", ") || "unknown"}.`
  );
  recordModelContext(input.ports.live, {
    id: `provider-protocol:${input.command.idempotencyKey}:${input.code}`,
    source: "provider",
    label: input.code,
    target: `${input.command.phase}:${String(input.command.payload.mode || "unknown")}`,
    status: "failed",
    content: [
      message,
      `Allowed tools for this phase: ${input.allowedToolNames.join(", ") || "none"}.`,
      input.preferredValidationCommand
        ? `Preferred finite validation: ${input.preferredValidationCommand}.`
        : "",
      "Retry with exactly one allowed structured tool. Do not repeat an unavailable tool or replace the call with narration.",
    ].filter(Boolean).join("\n"),
  });
  return new RuntimeV2ProviderProtocolError(input.code, message);
}

export function providerModeInstruction(
  command: RuntimeV2Command,
  preferredValidationCommand = "",
  toolSurface: {
    readonly hasReadFile: boolean;
    readonly hasMutation: boolean;
    readonly hasSpawnSubagent: boolean;
    readonly hasWaitSubagents: boolean;
    readonly rejectedActions?: readonly string[];
  } = {
    hasReadFile: false,
    hasMutation: false,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
  },
): string {
  const mode = String(command.payload.mode || "").trim();
  const activeSubagents = Array.isArray(command.payload.activeSubagents)
    ? command.payload.activeSubagents
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          const record = entry as Record<string, unknown>;
          const id = String(record.id || "").trim();
          const name = String(record.name || "").trim();
          const objective = String(record.objective || "").trim();
          return id
            ? `${name || id} (${id}): ${objective}`.slice(0, 600)
            : "";
        })
        .filter(Boolean)
    : [];
  const failedSubagents = Array.isArray(command.payload.failedSubagents)
    ? command.payload.failedSubagents
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          const record = entry as Record<string, unknown>;
          const id = String(record.id || "").trim();
          const summary = String(record.summary || "").trim();
          return id
            ? `${id}: ${summary || "no structured report"}`.slice(0, 600)
            : "";
        })
        .filter(Boolean)
    : [];
  const collaborationGuidance = [
    failedSubagents.length > 0
      ? `Previous read-only child work did not complete (${failedSubagents.join("; ")}). Continue the objective directly; child failure is never a blocker.`
      : "",
    toolSurface.hasWaitSubagents
      ? `Read-only child work is active (${activeSubagents.join("; ")}). Continue independent parent work and call wait_subagents only when its result becomes a dependency.`
      : "",
    toolSurface.hasSpawnSubagent
      ? [
          command.payload.collaborationPreferred === true
            ? "Delegation is encouraged when a genuinely independent investigation, review, or validation would shorten the critical path; it is never mandatory."
            : "Delegation is optional.",
          "Use spawn_subagent only for a semantic independent explore, review, or validate task with concrete success criteria. The parent remains the only writer.",
        ].join(" ")
      : "",
  ].filter(Boolean).join(" ");
  const rejectedActions = (toolSurface.rejectedActions || [])
    .filter(Boolean)
    .slice(-6);
  const rejectedActionGuidance = rejectedActions.length > 0
    ? [
        "These exact actions are currently ineligible at the current source boundary because the runtime already rejected them:",
        rejectedActions.join("; "),
        "Do not submit any of them again. Choose a different allowed action; the tool itself remains available for different arguments.",
      ].join(" ")
    : "";
  if (mode === "analyze") {
    return [
      "Perform a bounded read-only workspace analysis. Use a focused read/search only when a concrete fact is missing, then return one complete evidence-backed Markdown answer.",
      rejectedActionGuidance,
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  if (mode === "conclude") {
    return [
      "Return the final evidence report now. State only the confirmed cause, files actually changed, validations actually run, and any remaining limitation. Do not request another workspace action.",
      rejectedActionGuidance,
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  if (mode === "validate") {
    return [
      "Validate the latest committed mutation now with a finite test, assertion, build, lint, typecheck, browser, or desktop interaction appropriate to the user's observable acceptance criteria.",
      "Do not repeat the mutation before validation. Safe reads remain available when a genuinely missing post-edit fact is required; a read or diff alone is not validation.",
      "Static checks prove only static properties. User-visible behavior requires a test, browser interaction, or desktop interaction that observes that behavior.",
      preferredValidationCommand
        ? `A suitable finite workspace validation is ${JSON.stringify(preferredValidationCommand)}.`
        : "",
      command.payload.toolExpectation === "required"
        ? "This iteration requires one real structured validation action; do not replace it with narration."
        : "",
      rejectedActionGuidance,
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  return [
    "Continue one inspect-edit-verify loop for the user's complete objective.",
    toolSurface.hasReadFile
      ? command.payload.hasVersionedSourceEvidence === true
        ? "Versioned source evidence is already committed. Reuse it: do not reread the same path and range. Choose a mutation or validation now, unless a genuinely different target or missing range is required. Safe reads remain available after every edit and failed validation."
        : "No versioned source evidence is committed yet. Read the exact existing file before changing it. Safe reads remain available after every edit and failed validation."
      : "",
    toolSurface.hasMutation
      ? "Make the smallest coherent change that addresses all currently supported gaps, preserving unrelated behavior."
      : "",
    "After the latest mutation, run a finite test, build, lint, typecheck, browser, or desktop validation appropriate to the observable claim. Text inspection alone is not validation.",
    preferredValidationCommand
      ? `A suitable finite workspace validation is ${JSON.stringify(preferredValidationCommand)}.`
      : "",
    command.payload.toolExpectation === "required"
      ? "This iteration requires one real structured tool action; do not replace it with narration."
      : "If the objective is fully verified, the runtime will ask separately for the final report.",
    rejectedActionGuidance,
    collaborationGuidance,
  ].filter(Boolean).join(" ");
}

export async function requestRuntimeV2ProviderOnce(input: {
  live: RuntimeV2LiveExecutionState;
  ports: RuntimeV2ExecutionPortsInput;
  command: RuntimeV2Command;
  tools: ToolDefinition[];
  textEnvelope: boolean;
  toolChoice: OpenAiToolChoice | null;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<RuntimeV2NormalizedProviderResult> {
  const state = input.ports.get();
  const budget = input.ports.context.runtimeContextBudget;
  const settings = deriveBudgetedStreamSettings(state.config, budget);
  const envelopeOnly =
    input.textEnvelope &&
    input.command.payload.toolExpectation === "required";
  const requestSettings = envelopeOnly
    ? { ...settings, reasoningRequest: "off" as const }
    : settings;
  const maxOutputTokens = runtimeV2ExecutionProviderOutputTokenLimit(
    input.command,
    input.textEnvelope,
    budget,
  );
  let streamedText = "";
  recordApprovedPlanContext(input.ports);
  const correctiveSource =
    String(input.command.payload.mode || "") === "execute"
      ? latestAcceptanceFailureSourceWindow(
          input.live,
          input.ports.context.runWorkspace || "",
        )
      : null;
  const history = providerHistory(
    input.live,
    input.ports,
    correctiveSource
      ? {
          kind: "corrective_mutation",
          target: correctiveSource.path,
          evidenceId: correctiveSource.evidenceId,
        }
      : null,
  );
  const preferredValidation = String(input.command.payload.mode || "") === "validate"
    ? preferredFiniteValidationCommand(input.ports)
    : "";
  const toolNames = new Set(input.tools.map((tool) => tool.function.name));
  const boundedConversation = budget
    ? boundRuntimeV2ProviderConversation(
        history.messages,
        {
          contextLimit: budget.contextLimit,
          reservedOutputTokens: maxOutputTokens,
        },
      )
    : [...history.messages];
  const messages = [
    ...boundedConversation,
    {
      role: "system" as const,
      content: providerModeInstruction(
        input.command,
        preferredValidation,
        {
          hasReadFile: toolNames.has("read_file"),
          hasMutation:
            toolNames.has("replace_in_file") ||
            toolNames.has("apply_patch") ||
            toolNames.has("write_file"),
          hasSpawnSubagent: toolNames.has("spawn_subagent"),
          hasWaitSubagents: toolNames.has("wait_subagents"),
          rejectedActions: [
            ...input.live.rejectedProviderActions.values(),
          ],
        },
      ),
    },
    ...(input.textEnvelope
      ? [{
          role: "system" as const,
          content: containsProviderTextEnvelopePrompt(
            input.ports.context.phaseLanguage,
            input.command.payload.toolExpectation === "required",
          ),
        }, {
          role: "system" as const,
          content: compactTextEnvelopeCatalog(input.tools),
        }]
      : []),
  ];
  input.ports.logStoreEvent("runtime_v2_context_prepared", {
    turnId: input.command.run.turnId,
    runId: input.command.run.runId,
    phase: input.command.phase,
    mode: String(input.command.payload.mode || ""),
    sourceReadAvailable: toolNames.has("read_file"),
    mutationToolAvailable:
      toolNames.has("replace_in_file") ||
      toolNames.has("apply_patch") ||
      toolNames.has("write_file"),
    retainedEvidenceEntries: history.retained,
    droppedEvidenceEntries: history.dropped,
    conversationHistoryMessages: boundedConversation.length,
    unboundedConversationHistoryMessages: history.historyMessages,
    priorConversationTurns: history.priorTurns,
    availableContextEntries: input.live.modelContext.length,
    contextSources: Object.fromEntries(
      ["workspace", "tool", "subagent", "provider", "plan"].map((source) => [
        source,
        input.live.modelContext.filter((entry) => entry.source === source).length,
      ]),
    ),
    retainedContextSources: history.retainedSources,
    contextFocus: history.focus?.kind || null,
    focusedTarget: history.focus?.target || null,
    focusedEvidenceId: history.focus?.evidenceId || null,
    approximateMessageChars: messages.reduce(
      (total, message) =>
        total + (
          typeof message.content === "string"
            ? message.content.length
            : message.content.reduce(
                (sum, part) =>
                  sum + (part.type === "text" ? part.text.length : 128),
                0,
              )
        ),
      0,
    ),
    preferredValidationCommand: preferredValidation || null,
    allowedToolCount: input.tools.length,
    nativeToolCount: input.textEnvelope ? 0 : input.tools.length,
    allowedToolNames: input.tools.map((tool) => tool.function.name),
    maxOutputTokens,
    reasoningRequest: requestSettings.reasoningRequest || null,
  });
  const result = await streamChatCompletion(
    messages,
    requestSettings,
    {
      onToken: (token) => { streamedText += token; },
      onDone: () => undefined,
      onError: () => undefined,
    },
    input.signal,
    input.textEnvelope ? [] : input.tools,
    maxOutputTokens,
    {
      ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
      timeoutMs: input.timeoutMs,
    },
  );
  const protocolContent =
    result.actionableContent || result.content || streamedText;
  const visibleText =
    result.semanticContent || streamedText;
  input.ports.logStoreEvent("runtime_v2_provider_wire_shape", {
    turnId: input.command.run.turnId,
    runId: input.command.run.runId,
    phase: input.command.phase,
    mode: String(input.command.payload.mode || ""),
    textEnvelope: input.textEnvelope,
    finishReason: result.finishReason || null,
    rawContentChars: result.content.length,
    actionableContentChars: result.actionableContent?.length || 0,
    semanticContentChars: result.semanticContent?.length || 0,
    reasoningChars: result.reasoningContent?.length || 0,
    mirrorKind: result.streamDiagnostics?.mirrorKind || null,
    nativeToolCalls: result.toolCalls.length,
    envelopeOpenMarkers:
      protocolContent.match(/<runtime-v2-tools>/g)?.length || 0,
    envelopeCloseMarkers:
      protocolContent.match(/<\/runtime-v2-tools>/g)?.length || 0,
    protocolViolation: result.protocolViolation || null,
  });
  return normalizeProviderResponseV1({
    visibleText,
    content: protocolContent,
    toolCalls: result.toolCalls,
    usage: result.usage,
    diagnostics: result.protocolViolation
      ? [{
          code: result.protocolViolation,
          message: "Provider tool protocol mismatch",
          retryable: true,
        }]
      : [],
  });
}
