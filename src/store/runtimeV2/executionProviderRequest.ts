import { deriveStreamSettings } from "../../lib/providerLaneSettings";
import { streamChatCompletion } from "../../lib/streaming";
import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  normalizeProviderResponseV1,
  RuntimeV2ProviderProtocolError,
  type RuntimeV2Command,
  type RuntimeV2NormalizedProviderResult,
} from "../../lib/runtime-v2";
import {
  compactTextEnvelopeCatalog,
  containsProviderTextEnvelopePrompt,
  latestAcceptanceFailureSourceWindow,
  preferredFiniteValidationCommand,
  providerHistory,
  recordApprovedPlanContext,
  recordModelContext,
  type RuntimeV2ExecutionPortsInput,
  type RuntimeV2LiveExecutionState,
} from "./executionContext";
import {
  latestFailedMutationToolForLease,
  runtimeV2MutationLease,
  type RuntimeV2MutationLease,
} from "./correctiveMutationPolicy";

export const RUNTIME_V2_EXECUTION_PROVIDER_MAX_OUTPUT_TOKENS = 8_192;
export const RUNTIME_V2_EXECUTION_TOOL_ENVELOPE_MAX_OUTPUT_TOKENS = 4_096;

export function runtimeV2ExecutionProviderOutputTokenLimit(
  command: RuntimeV2Command,
  textEnvelope: boolean,
): number {
  return textEnvelope &&
      command.payload.toolExpectation === "required"
    ? RUNTIME_V2_EXECUTION_TOOL_ENVELOPE_MAX_OUTPUT_TOKENS
    : RUNTIME_V2_EXECUTION_PROVIDER_MAX_OUTPUT_TOKENS;
}

export function runtimeV2ProviderProtocolError(input: {
  ports: RuntimeV2ExecutionPortsInput;
  command: RuntimeV2Command;
  code:
    | "required_tool_missing"
    | "tool_surface_rejected"
    | "tool_arguments_rejected";
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

function providerModeInstruction(
  command: RuntimeV2Command,
  preferredValidationCommand = "",
  toolSurface: {
    readonly hasReadFile: boolean;
    readonly hasMutation: boolean;
    readonly mutationLease: RuntimeV2MutationLease | null;
  } = {
    hasReadFile: false,
    hasMutation: false,
    mutationLease: null,
  },
): string {
  const mode = String(command.payload.mode || "").trim();
  switch (mode) {
    case "observe":
      return "Current phase: bounded read-only investigation. Use exactly one focused read or search action to collect a concrete missing fact. Mutation and validation tools are unavailable; do not propose or simulate an edit.";
    case "analyze":
      return "Current phase: bounded read-only workspace analysis. Use at most one focused read/search action when a concrete fact is missing. When the evidence is sufficient, return one complete Markdown answer with no tool call. Never request a mutation, shell command, browser action, or validation.";
    case "execute":
      return command.payload.executePolicy === "source_refresh_required"
        ? "Current phase: corrective source refresh. Read the exact primary file window reported by the latest failed validator or stale mutation. Only read_file is available; do not survey other files or propose a mutation until this source snapshot is committed."
        : command.payload.executePolicy === "source_reorientation_required"
        ? "Current phase: target recovery. The previous mutation named a target that is not valid in the active workspace. Use exactly one available source read, search, or directory action to locate authoritative code. Mutation and validation tools are temporarily unavailable; do not repeat the rejected path."
        : command.payload.executePolicy === "mutation_required"
        ? !toolSurface.hasMutation && toolSurface.hasReadFile
          ? "Current phase: exact source acquisition. No mutation is authorized until the parent reads the precise file it intends to change. Call read_file once for that file; do not narrate a fix or survey unrelated files."
          : toolSurface.mutationLease?.authority === "acceptance_failure"
          ? [
              "Current phase: corrective implementation.",
              toolSurface.hasReadFile
                ? "The validator-reported file is leased. If exact replacement bytes are still unclear, use the single read_file once; otherwise mutate now."
                : "The validator-reported source is attached and read capabilities are closed. Call the one available minimal mutation tool now.",
              "Repair only the concrete acceptance gaps in the leased file and preserve unrelated behavior.",
            ].join(" ")
          : toolSurface.mutationLease?.authority === "fresh_parent_read"
          ? [
              "Current phase: implementation.",
              `The mutation is leased to the exact file most recently read by the parent: ${toolSurface.mutationLease.target}.`,
              "Call one available minimal mutation tool now and preserve unrelated code.",
            ].join(" ")
          : "Current phase: approved-plan implementation. Call exactly one minimal mutation within the sealed plan scope and preserve unrelated code."
        : "Current phase: source acquisition before implementation. Mutation tools are closed for this request. Use one focused source action; finish with read_file on the exact file you intend to change. Never replace the tool call with narration.";
    case "validate":
      return [
        "Current phase: validate. Call one acceptance-capable finite validation tool and wait for its actual result before concluding.",
        "A run_command must be a bounded build, test, lint, typecheck, check, or assertion command. cat, grep, sed, head, tail, and wc only inspect text and are not validation.",
        preferredValidationCommand
          ? `Preferred workspace validation command: ${JSON.stringify(preferredValidationCommand)}. Use it unless retained evidence proves another bounded validator is more appropriate.`
          : "Prefer run_command or browser_evaluate according to the observable acceptance boundary.",
      ].join(" ");
    case "conclude":
      return "Current phase: final evidence report. Do not call another tool. State only the confirmed root cause, files actually changed, validation that actually passed, and any remaining limitation.";
    default:
      return "Current phase: choose the next action from concrete evidence. Use a structured tool whenever another fact, edit, or validation is required.";
  }
}

export async function requestRuntimeV2ProviderOnce(input: {
  live: RuntimeV2LiveExecutionState;
  ports: RuntimeV2ExecutionPortsInput;
  command: RuntimeV2Command;
  tools: ToolDefinition[];
  textEnvelope: boolean;
  toolChoice: "required" | "auto" | null;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<RuntimeV2NormalizedProviderResult> {
  const state = input.ports.get();
  const settings = deriveStreamSettings(state.config);
  const envelopeOnly =
    input.textEnvelope &&
    input.command.payload.toolExpectation === "required";
  const requestSettings = envelopeOnly
    ? { ...settings, reasoningRequest: "off" as const }
    : settings;
  const maxOutputTokens = runtimeV2ExecutionProviderOutputTokenLimit(
    input.command,
    input.textEnvelope,
  );
  let streamedText = "";
  recordApprovedPlanContext(input.ports);
  const correctiveSource =
    String(input.command.payload.mode || "") === "execute" &&
      input.command.payload.executePolicy === "mutation_required"
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
  const mutationLease =
    String(input.command.payload.mode || "") === "execute" &&
      input.command.payload.executePolicy === "mutation_required"
      ? runtimeV2MutationLease(input.ports)
      : null;
  const toolNames = new Set(input.tools.map((tool) => tool.function.name));
  const excludedMutationTool = mutationLease
    ? latestFailedMutationToolForLease(input.ports, mutationLease)
    : null;
  const messages = [
    ...history.messages,
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
          mutationLease,
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
    executePolicy: String(input.command.payload.executePolicy || ""),
    sourceReadAvailable: toolNames.has("read_file"),
    mutationToolAvailable:
      toolNames.has("replace_in_file") ||
      toolNames.has("apply_patch") ||
      toolNames.has("write_file"),
    mutationLeaseAuthority: mutationLease?.authority || null,
    mutationLeaseTarget: mutationLease?.target || null,
    mutationLeaseEvidenceId: mutationLease?.evidenceId || null,
    excludedMutationTool,
    retainedEvidenceEntries: history.retained,
    droppedEvidenceEntries: history.dropped,
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
    approximateMessageChars: history.chars,
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
    executePolicy: String(input.command.payload.executePolicy || ""),
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
