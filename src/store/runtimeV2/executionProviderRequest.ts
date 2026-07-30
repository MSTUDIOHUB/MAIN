import {
  deriveBudgetedStreamSettings,
  deriveProviderAdapterCapabilities,
} from "../../lib/providerLaneSettings";
import { acquireModelLane } from "../../lib/modelLaneCoordinator";
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
  aggregateForCurrentTurn,
  compactTextEnvelopeCatalog,
  buildRuntimeV2DecisionView,
  boundRuntimeV2ProviderConversation,
  containsProviderTextEnvelopePrompt,
  deriveRuntimeV2ProviderEffectFacts,
  materializedRuntimeV2SourceCoverage,
  preferredFiniteValidationCommand,
  providerHistory,
  recordApprovedPlanContext,
  type RuntimeV2ExecutionPortsInput,
  type RuntimeV2LiveExecutionState,
} from "./executionContext";
import {
  prioritizeRuntimeV2ProviderToolDefinitions,
} from "./executionProviderTools";

export const RUNTIME_V2_EXECUTION_PROVIDER_MAX_OUTPUT_TOKENS = 8_192;

export function shouldRetryRuntimeV2WithoutReasoning(input: {
  readonly finishReason: string | null | undefined;
  readonly reasoningChars: number;
  readonly toolCallCount: number;
  readonly availableToolCount: number;
  readonly reasoningRequest: string | null | undefined;
  readonly providerSupportsReasoningToggle: boolean;
}): boolean {
  return input.providerSupportsReasoningToggle &&
    input.availableToolCount > 0 &&
    input.reasoningRequest !== "off" &&
    input.finishReason === "length" &&
    input.reasoningChars > 0 &&
    input.toolCallCount === 0;
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

function providerMessageChars(
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
  _command: RuntimeV2Command,
  _textEnvelope: boolean,
  budget?: Pick<RuntimeContextBudget, "outputBudget"> | null,
): number {
  return Math.max(
    1,
    budget?.outputBudget ??
      RUNTIME_V2_EXECUTION_PROVIDER_MAX_OUTPUT_TOKENS,
  );
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

function mergedVisibleLineRanges(
  windows: readonly {
    readonly startLine: number;
    readonly endLine: number;
  }[],
): string[] {
  const ordered = [...windows]
    .filter((window) =>
      window.startLine >= 0 && window.endLine >= window.startLine
    )
    .sort((left, right) =>
      left.startLine - right.startLine ||
      left.endLine - right.endLine
    );
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const window of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && window.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, window.endLine);
    } else {
      merged.push({
        startLine: window.startLine,
        endLine: window.endLine,
      });
    }
  }
  return merged.map((range) =>
    range.startLine === range.endLine
      ? String(range.startLine)
      : `${range.startLine}-${range.endLine}`
  );
}

export function runtimeV2EditableSourceAnchor(
  coverage: readonly {
    readonly target: string;
    readonly version: string;
    readonly complete: boolean;
    readonly windows: readonly {
      readonly startLine: number;
      readonly endLine: number;
    }[];
  }[],
): string {
  if (coverage.length === 0) return "";
  return [
    "[editable_source_v1]",
    JSON.stringify({
      existingTargets: coverage.map((entry) => ({
        target: entry.target,
        version: entry.version,
        visibleLineRanges: mergedVisibleLineRanges(entry.windows),
        complete: entry.complete,
        eligibleEditors: ["replace_in_file", "apply_patch"],
      })),
    }),
  ].join(" ");
}

export function providerModeInstruction(
  command: RuntimeV2Command,
  preferredValidationCommand = "",
  toolSurface: {
    readonly hasReadFile: boolean;
    readonly hasMutation: boolean;
    readonly hasSpawnSubagent: boolean;
    readonly hasWaitSubagents: boolean;
    readonly hasMaterializedSourceEvidence?: boolean;
    readonly sourceOnlyFrontier?: boolean;
    readonly materializedSourceCoverage?: readonly {
      readonly target: string;
      readonly version: string;
      readonly complete: boolean;
      readonly windows: readonly {
        readonly startLine: number;
        readonly endLine: number;
      }[];
    }[];
  } = {
    hasReadFile: false,
    hasMutation: false,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    hasMaterializedSourceEvidence: false,
    sourceOnlyFrontier: false,
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
  const editableSourceGuidance =
    toolSurface.hasMutation &&
      toolSurface.hasMaterializedSourceEvidence
      ? runtimeV2EditableSourceAnchor(
          toolSurface.materializedSourceCoverage || [],
        )
      : "";
  if (mode === "analyze") {
    return [
      "Perform a bounded read-only analysis of the admitted file context. Use a focused read or search only when a concrete fact is missing, then return one complete evidence-backed Markdown answer.",
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  if (mode === "conclude") {
    return [
      "Return the final evidence report now. State only the confirmed cause, files actually changed, validations actually run, and any remaining limitation. Do not request another workspace action.",
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
      collaborationGuidance,
    ].filter(Boolean).join(" ");
  }
  return [
    "Continue one inspect-edit-verify loop for the user's complete objective.",
    toolSurface.sourceOnlyFrontier
      ? "The current mutation boundary already has exact versioned source but no committed workspace effect. If the visible source supports a safe coherent repair, submit the mutation now. Continue reading only when you can name one missing path, range, or fact required to edit safely; broad exploration does not advance the objective."
      : "",
    toolSurface.hasReadFile
      ? toolSurface.hasMaterializedSourceEvidence
        ? "Exact versioned source is visible in this decision request. Use only that visible source for a mutation or validation; request a different target or missing range when needed. Safe reads remain available after every edit and failed validation."
        : command.payload.hasVersionedSourceEvidence === true
          ? "Versioned source exists in the runtime cache but is not visible in this decision request, so it is not write authority. Request the exact intended path or range again; MAIN may replay it without another disk read."
          : "No versioned source evidence is committed yet. Read the exact existing file before changing it. Safe reads remain available after every edit and failed validation."
      : "",
    toolSurface.hasMutation
      ? "Make the smallest coherent change that addresses all currently supported gaps, preserving unrelated behavior."
      : "",
    editableSourceGuidance,
    "After the latest mutation, run a finite test, build, lint, typecheck, browser, or desktop validation appropriate to the observable claim. Text inspection alone is not validation.",
    preferredValidationCommand
      ? `A suitable finite workspace validation is ${JSON.stringify(preferredValidationCommand)}.`
      : "",
    "If work remains, choose one real structured tool action. A response without a tool call ends the Run and will be judged only by committed mutation and validation evidence; return prose only when you are done.",
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
  const requestSettings = settings;
  const adapterCapabilities = deriveProviderAdapterCapabilities(
    requestSettings,
  );
  input.live.latestProviderAssistantReasoning = null;
  const maxOutputTokens = runtimeV2ExecutionProviderOutputTokenLimit(
    input.command,
    input.textEnvelope,
    budget,
  );
  let streamedText = "";
  recordApprovedPlanContext(input.ports);
  const history = providerHistory(input.live, input.ports);
  const preferredValidation = String(input.command.payload.mode || "") === "validate"
    ? preferredFiniteValidationCommand(input.ports)
    : "";
  const providerEffectFacts = deriveRuntimeV2ProviderEffectFacts(
    aggregateForCurrentTurn(input.ports),
  );
  const boundedConversation = budget
    ? boundRuntimeV2ProviderConversation(
        history.messages,
        {
          contextLimit: budget.contextLimit,
          reservedOutputTokens: maxOutputTokens,
        },
        providerEffectFacts,
      )
    : buildRuntimeV2DecisionView(
        history.messages,
        providerEffectFacts,
      );
  input.live.latestProviderRequestSourceCoverage =
    materializedRuntimeV2SourceCoverage(
      boundedConversation,
      input.ports.context.runWorkspace || "",
      providerEffectFacts,
    );
  const providerTools = prioritizeRuntimeV2ProviderToolDefinitions({
    command: input.command,
    tools: input.tools,
    hasMaterializedSourceEvidence:
      input.live.latestProviderRequestSourceCoverage.length > 0,
  });
  const toolNames = new Set(
    providerTools.map((tool) => tool.function.name),
  );
  const effectPressure =
    input.command.payload.effectPressure &&
      typeof input.command.payload.effectPressure === "object" &&
      !Array.isArray(input.command.payload.effectPressure)
      ? input.command.payload.effectPressure as Record<string, unknown>
      : null;
  const sourceOnlyFrontier =
    effectPressure?.reason === "source_only_frontier" &&
    input.live.latestProviderRequestSourceCoverage.length > 0;
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
          hasMaterializedSourceEvidence:
            input.live.latestProviderRequestSourceCoverage.length > 0,
          sourceOnlyFrontier,
          materializedSourceCoverage:
            input.live.latestProviderRequestSourceCoverage,
        },
      ),
    },
    ...(input.textEnvelope
      ? [{
          role: "system" as const,
          content: containsProviderTextEnvelopePrompt(
            input.ports.context.phaseLanguage,
            false,
          ),
        }, {
          role: "system" as const,
          content: compactTextEnvelopeCatalog(providerTools),
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
    conversationHistoryMessages: boundedConversation.length,
    unboundedConversationHistoryMessages: history.historyMessages,
    priorConversationTurns: history.priorTurns,
    approximateMessageChars: messages.reduce(
      (total, message) => total + providerMessageChars(message),
      0,
    ),
    preferredValidationCommand: preferredValidation || null,
    allowedToolCount: providerTools.length,
    nativeToolCount: input.textEnvelope ? 0 : providerTools.length,
    allowedToolNames: providerTools.map((tool) => tool.function.name),
    sourceOnlyFrontier,
    maxOutputTokens,
    reasoningRequest: requestSettings.reasoningRequest || null,
    decisionViewApplied: true,
    canonicalConversationMessages: history.messages.length,
    removedDecisionMessages: Math.max(
      0,
      history.messages.length - boundedConversation.length,
    ),
  });
  const requestTokenBudget = Math.max(
    2_048,
    Math.ceil(
      messages.reduce(
        (total, message) => total + providerMessageChars(message),
        0,
      ) / 4,
    ) + maxOutputTokens,
  );
  const lane = await acquireModelLane({
    config: state.config,
    contextLimit: budget?.contextLimit,
    requestTokenBudget,
    agentKind: "parent",
    signal: input.signal,
    onDebugEvent: (event, data) =>
      input.ports.logStoreEvent(event, {
        turnId: input.command.run.turnId,
        runId: input.command.run.runId,
        ...data,
      }),
  });
  let result: Awaited<ReturnType<typeof streamChatCompletion>>;
  let reasoningFallbackApplied = false;
  try {
    result = await streamChatCompletion(
      messages,
      requestSettings,
      {
        onToken: (token) => {
          lane.markFirstToken();
          streamedText += token;
        },
        onDone: () => undefined,
        onError: () => undefined,
        onLifecycle: (event) => {
          if (event.phase === "first_chunk") lane.markFirstToken();
        },
      },
      input.signal,
      input.textEnvelope ? [] : providerTools,
      maxOutputTokens,
      {
        ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
        timeoutMs: input.timeoutMs,
        contextOwnership: "caller",
      },
    );
    if (
      shouldRetryRuntimeV2WithoutReasoning({
        finishReason: result.finishReason,
        reasoningChars: result.reasoningContent?.length || 0,
        toolCallCount: result.toolCalls.length,
        availableToolCount: providerTools.length,
        reasoningRequest: requestSettings.reasoningRequest,
        providerSupportsReasoningToggle:
          adapterCapabilities.reasoningToggle,
      })
    ) {
      reasoningFallbackApplied = true;
      input.ports.logStoreEvent(
        "runtime_v2_provider_reasoning_truncated",
        {
          turnId: input.command.run.turnId,
          runId: input.command.run.runId,
          phase: input.command.phase,
          mode: String(input.command.payload.mode || ""),
          finishReason: result.finishReason,
          reasoningChars: result.reasoningContent?.length || 0,
          actionChars:
            result.actionableContent?.length ||
            result.semanticContent?.length ||
            result.content.length,
          recovery: "provider_reasoning_toggle_off",
        },
      );
      streamedText = "";
      result = await streamChatCompletion(
        messages,
        {
          ...requestSettings,
          reasoningRequest: "off",
          preserveAssistantReasoning: false,
        },
        {
          onToken: (token) => {
            lane.markFirstToken();
            streamedText += token;
          },
          onDone: () => undefined,
          onError: () => undefined,
          onLifecycle: (event) => {
            if (event.phase === "first_chunk") lane.markFirstToken();
          },
        },
        input.signal,
        input.textEnvelope ? [] : providerTools,
        maxOutputTokens,
        {
          ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
          timeoutMs: input.timeoutMs,
          contextOwnership: "caller",
        },
      );
    }
  } catch (error) {
    lane.reportFailure(error);
    throw error;
  } finally {
    lane.release();
  }
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
    reasoningFallbackApplied,
  });
  const providerReasoning = String(result.reasoningContent || "").trim();
  if (
    requestSettings.preserveAssistantReasoning === true &&
    providerReasoning
  ) {
    input.live.latestProviderAssistantReasoning = {
      content: providerReasoning,
      field: result.reasoningField === "reasoning"
        ? "reasoning"
        : "reasoning_content",
    };
  }
  const outputTruncated = runtimeV2ProviderOutputWasTruncated({
    finishReason: result.finishReason,
    toolCallCount: result.toolCalls.length,
    availableToolCount: providerTools.length,
  });
  return normalizeProviderResponseV1({
    visibleText,
    content: protocolContent,
    toolCalls: result.toolCalls,
    usage: result.usage,
    diagnostics: [
      ...(result.protocolViolation
        ? [{
          code: result.protocolViolation,
          message: "Provider tool protocol mismatch",
          retryable: true,
        }]
        : []),
      ...(outputTruncated
        ? [{
          code: "output_truncated",
          message:
            "Provider output reached its token limit before a structured action or complete conclusion.",
          retryable: true,
        }]
        : []),
    ],
  });
}
