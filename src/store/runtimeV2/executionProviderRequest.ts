import { deriveStreamSettings } from "../../lib/providerLaneSettings";
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
    readonly hasSpawnSubagent: boolean;
    readonly hasWaitSubagents: boolean;
    readonly hasExecutionContract: boolean;
    readonly mutationLease: RuntimeV2MutationLease | null;
  } = {
    hasReadFile: false,
    hasMutation: false,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    hasExecutionContract: false,
    mutationLease: null,
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
    command.payload.collaborationAction === "parent_takeover_required"
      ? [
          `Previous read-only child tasks failed (${failedSubagents.join("; ") || "no structured report"}).`,
          "Child failure is not a blocker. The parent must continue the remaining objective directly with the tools and authority available in the current phase.",
          "Do not recreate the same semantic child task.",
        ].join(" ")
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
  switch (mode) {
    case "observe":
      return [
        command.payload.requiredExecutionContractSourceTarget
          ? [
              "Current phase: exact execution-contract source acquisition.",
              `The runtime will read exactly ${JSON.stringify(String(command.payload.requiredExecutionContractSourceTarget))} because the rejected modify/delete target has no matching versioned receipt.`,
              "Do not resubmit the contract, delegate, survey another file, or propose a mutation until this receipt is committed.",
            ].join(" ")
          : command.payload.observationPolicy ===
            "execution_contract_required"
          ? [
              "Current phase: execution contract required.",
              "Investigation already produced versioned source evidence and then repeated or pivoted under pressure. Do not read, search, delegate, or narrate another diagnosis.",
              "Call submit_execution_contract now. Use canonical E-prefixed source evidence ids below. When the runtime catalog has one criterion, omit criteria and criterion_ids; the runtime binds that sole identity and evidence class.",
              "For behavioral UI acceptance, declare a browser or desktop validation with a supported action and an assertion linked by after_action_id, or a real automated test/executable assertion. Never use echo, grep, sed, cat, head, tail, or wc as validation.",
              command.payload.executionContractRejection
                ? `Correct this exact prior rejection: ${String(command.payload.executionContractRejection)}.`
                : "",
            ].join(" ")
          : command.payload.observationPolicy ===
            "different_action_or_contract_required"
          ? [
              "Current phase: investigation pivot required.",
              `The unchanged source action for ${JSON.stringify(String(command.payload.repeatedSourceTarget || "the previous target"))} already returned committed evidence and must not be repeated.`,
              "Call submit_execution_contract now if target evidence is sufficient; otherwise choose exactly one different source/search action that supplies a concrete missing fact.",
            ].join(" ")
          : "Current phase: bounded investigation. Use one focused read/search action to collect a concrete missing fact.",
        toolSurface.hasExecutionContract
          ? [
              `Runtime-owned acceptance criteria: ${JSON.stringify(command.payload.acceptanceCriteria || [])}.`,
              `Canonical versioned source evidence catalog: ${JSON.stringify(command.payload.executionEvidenceCatalog || [])}.`,
              command.payload.executionContractRejection
                ? `Previous execution contract rejection: ${String(command.payload.executionContractRejection)}. Correct it instead of resubmitting the same validation.`
                : "",
              command.payload.executionContractRevision
                ? "The active execution contract may be revised only after genuinely new versioned source evidence."
                : "Once target scope is evidenced, call submit_execution_contract before the first mutation. Multi-criterion objectives require exact runtime ids; a sole criterion is bound by the runtime.",
            ].join(" ")
          : "Mutation and validation tools are unavailable; do not propose or simulate an edit.",
        collaborationGuidance,
      ].filter(Boolean).join(" ");
    case "analyze":
      return [
        "Current phase: bounded read-only workspace analysis. Use at most one focused read/search action when a concrete fact is missing. When the evidence is sufficient, return one complete Markdown answer with no tool call. Never request a mutation, shell command, browser action, or validation.",
        collaborationGuidance,
      ].filter(Boolean).join(" ");
    case "execute":
      return [
        command.payload.requiredMutationSourceTarget
        ? [
            "Current phase: exact contracted target acquisition.",
            `Call read_file now for exactly ${JSON.stringify(String(command.payload.requiredMutationSourceTarget))}.`,
            "The previous lease points at an already-covered or unrelated target. No mutation or broader survey is available until this source receipt establishes authority for the remaining contracted change.",
          ].join(" ")
        : command.payload.executePolicy === "source_refresh_required"
        ? "Current phase: corrective source refresh. Read the exact primary file window reported by the latest failed validator or stale mutation before choosing the next bounded action."
        : command.payload.executePolicy === "source_reorientation_required"
        ? "Current phase: target recovery. The previous mutation named a target that is not valid in the active workspace. Use exactly one available source read, search, or directory action to locate authoritative code. Mutation and validation tools are temporarily unavailable; do not repeat the rejected path."
        : command.payload.executePolicy === "mutation_required"
        ? !toolSurface.hasMutation && toolSurface.hasReadFile
          ? "Current phase: exact source acquisition. No mutation is authorized until the parent reads the precise file it intends to change. Call read_file once for that file; do not narrate a fix or survey unrelated files."
          : toolSurface.mutationLease?.authority === "acceptance_failure"
          ? [
              "Current phase: corrective implementation.",
              toolSurface.hasReadFile
                ? "Safe reads remain available. Refresh only evidence needed for the next bounded mutation."
                : "",
              "Repair only the concrete acceptance gaps in the leased file and preserve unrelated behavior.",
            ].join(" ")
          : toolSurface.mutationLease?.authority === "fresh_parent_read"
          ? [
              "Current phase: implementation.",
              `The mutation is leased to the exact file most recently read by the parent: ${toolSurface.mutationLease.target}.`,
              command.payload.forcedMutationToolName
                ? `The unchanged read loop was rejected. Call ${String(command.payload.forcedMutationToolName)} now; another read is not a different action.`
                : "Call one available minimal mutation tool now and preserve unrelated code.",
            ].join(" ")
          : "Current phase: approved-plan implementation. Call exactly one minimal mutation within the sealed plan scope and preserve unrelated code."
        : "Current phase: source acquisition before implementation. Use one focused source action; finish with read_file on the exact file you intend to change.",
        toolSurface.hasExecutionContract
          ? [
              "Every mutation must remain inside the active execution contract. If new versioned evidence changes the target or acceptance approach, revise the contract before the next mutation; prior validation receipts become stale.",
              `Active execution contract draft: ${JSON.stringify(command.payload.activeExecutionContractDraft || {})}.`,
              command.payload.executionContractRejection
                ? `Correct this exact prior contract rejection before resubmitting: ${String(command.payload.executionContractRejection)}.`
                : "",
              `Canonical versioned source evidence catalog: ${JSON.stringify(command.payload.executionEvidenceCatalog || [])}.`,
            ].filter(Boolean).join(" ")
          : "",
        collaborationGuidance,
      ].filter(Boolean).join(" ");
    case "validate":
      return [
        "Current phase: validate. Call one acceptance-capable finite validation tool and wait for its actual result before concluding.",
        toolSurface.hasReadFile
          ? "Safe source reads remain available for a focused parent takeover after a child failure. A read is supporting evidence only: it never counts as validation, and after resolving the missing fact you must run the declared validator."
          : "",
        "A run_command must be a bounded build, test, lint, typecheck, check, or assertion command. cat, grep, sed, head, tail, and wc only inspect text and are not validation.",
        preferredValidationCommand
          ? `Preferred workspace validation command: ${JSON.stringify(preferredValidationCommand)}. Use it unless retained evidence proves another bounded validator is more appropriate.`
          : "Prefer run_command or browser_evaluate according to the observable acceptance boundary.",
        "Use only a validator declared by the active execution authority. A static build/lint/typecheck/check cannot prove a behavioral or interaction criterion.",
        command.payload.activeExecutionContractDraft
          ? [
              `Active execution contract and declared validation primitives: ${JSON.stringify(command.payload.activeExecutionContractDraft)}.`,
              "For browser_evaluate, translate the declared actions to its action DSL (for example click: selector or fill: selector => value) and the declared assertions to its checks DSL. Preserve the declared action/assertion causal intent; do not invent a different validator.",
              command.payload.validationRetryTarget
                ? `Reuse this previously authorized URL exactly: ${JSON.stringify(String(command.payload.validationRetryTarget))}.`
                : "",
            ].filter(Boolean).join(" ")
          : "",
        collaborationGuidance,
      ].filter(Boolean).join(" ");
    case "conclude":
      return [
        "Current phase: final evidence report. State only the confirmed root cause, files actually changed, matching validations that actually passed, and any remaining limitation.",
        collaborationGuidance,
      ].filter(Boolean).join(" ");
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
  toolChoice: OpenAiToolChoice | null;
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
          hasSpawnSubagent: toolNames.has("spawn_subagent"),
          hasWaitSubagents: toolNames.has("wait_subagents"),
          hasExecutionContract:
            toolNames.has("submit_execution_contract"),
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
    forcedMutationToolName:
      String(input.command.payload.forcedMutationToolName || "") || null,
    retainedEvidenceEntries: history.retained,
    droppedEvidenceEntries: history.dropped,
    conversationHistoryMessages: history.historyMessages,
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
