import { deriveStreamSettings } from "../../lib/providerLaneSettings";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { streamChatCompletion } from "../../lib/streaming";
import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  normalizeProviderResponseV1,
  recordProviderTransportAttempt,
  selectNextProviderTransportAttempt,
  type ProviderPort,
  type RuntimeV2Command,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2TransportVariant,
} from "../../lib/runtime-v2";
import {
  baseProviderProfile,
  compactTextEnvelopeCatalog,
  containsProviderTextEnvelopePrompt,
  providerHistory,
  providerToolDefinitionsForCommand,
  recordApprovedPlanContext,
  recordModelContext,
  type RuntimeV2ExecutionPortsInput,
  type RuntimeV2LiveExecutionState,
} from "./executionContext";
import { unexpectedRuntimeV2ProviderToolNames } from "./providerToolSurface";

function providerModeInstruction(command: RuntimeV2Command): string {
  const mode = String(command.payload.mode || "").trim();
  switch (mode) {
    case "observe":
      return "Current phase: bounded investigation. Use at most one focused read/search action when a concrete fact is missing. If the supplied evidence already identifies a safe fix, call the smallest workspace mutation now.";
    case "analyze":
      return "Current phase: bounded read-only workspace analysis. Use at most one focused read/search action when a concrete fact is missing. When the evidence is sufficient, return one complete Markdown answer with no tool call. Never request a mutation, shell command, browser action, or validation.";
    case "execute":
      return "Current phase: implementation. The bounded investigation window has ended. Use one focused read only when an exact source byte is missing; otherwise call one minimal workspace mutation. Never replace the tool call with a narration or another broad survey.";
    case "validate":
      return "Current phase: validate. Call a finite validation tool (prefer run_command or browser_evaluate) and wait for its actual result before concluding.";
    case "conclude":
      return "Current phase: final evidence report. Do not call another tool. State only the confirmed root cause, files actually changed, validation that actually passed, and any remaining limitation.";
    default:
      return "Current phase: choose the next action from concrete evidence. Use a structured tool whenever another fact, edit, or validation is required.";
  }
}

async function requestProviderOnce(input: {
  live: RuntimeV2LiveExecutionState;
  ports: RuntimeV2ExecutionPortsInput;
  command: RuntimeV2Command;
  tools: ToolDefinition[];
  textEnvelope: boolean;
  toolChoice: "required" | "auto" | null;
  signal: AbortSignal;
}): Promise<RuntimeV2NormalizedProviderResult> {
  const state = input.ports.get();
  const settings = deriveStreamSettings(state.config);
  let streamedText = "";
  recordApprovedPlanContext(input.ports);
  const history = providerHistory(input.live, input.ports);
  const messages = [
    ...history.messages,
    { role: "system" as const, content: providerModeInstruction(input.command) },
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
    retainedEvidenceEntries: history.retained,
    droppedEvidenceEntries: history.dropped,
    availableContextEntries: input.live.modelContext.length,
    contextSources: Object.fromEntries(
      ["workspace", "tool", "subagent", "provider", "plan"].map((source) => [
        source,
        input.live.modelContext.filter((entry) => entry.source === source).length,
      ]),
    ),
    approximateMessageChars: history.chars,
    allowedToolCount: input.tools.length,
    nativeToolCount: input.textEnvelope ? 0 : input.tools.length,
    allowedToolNames: input.tools.map((tool) => tool.function.name),
  });
  const result = await streamChatCompletion(
    messages,
    settings,
    {
      onToken: (token) => { streamedText += token; },
      onDone: () => undefined,
      onError: () => undefined,
    },
    input.signal,
    input.textEnvelope ? [] : input.tools,
    undefined,
    input.toolChoice ? { toolChoice: input.toolChoice } : {},
  );
  return normalizeProviderResponseV1({
    visibleText: result.content || streamedText,
    toolCalls: result.toolCalls,
    usage: result.usage,
    diagnostics: result.protocolViolation
      ? [{ code: result.protocolViolation, message: "Provider tool protocol mismatch", retryable: true }]
      : [],
  });
}

export function createRuntimeV2ProviderPort(
  input: RuntimeV2ExecutionPortsInput,
): ProviderPort {
  return {
    async request({ command, signal }) {
      const state = input.get();
      const requiresTool = command.payload.toolExpectation === "required";
      if (!input.live.providerLaneProfile) {
        input.live.providerLaneProfile = baseProviderProfile(state);
      }
      const profile = {
        ...input.live.providerLaneProfile,
        schemaVersion: "provider-lane.v1" as const,
        requiredToolChoice: requiresTool,
      };
      // Freeze one capability surface for the Turn. A UI toggle or config
      // refresh after admission cannot make the provider request a tool that
      // the executor's authorization catalog did not expose.
      const tools = providerToolDefinitionsForCommand(input, command);
      let epoch: { actionKey: string; attempted: readonly RuntimeV2TransportVariant[] } = {
        actionKey: command.idempotencyKey,
        attempted: [],
      };
      let lastError: unknown = null;
      while (true) {
        const attempt = selectNextProviderTransportAttempt(profile, epoch);
        if (!attempt) break;
        epoch = recordProviderTransportAttempt(epoch, attempt);
        try {
          input.logStoreEvent("runtime_v2_provider_request_opened", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            phase: command.phase,
            transport: attempt.variant,
            textEnvelope: attempt.textEnvelope,
            toolExpectation: requiresTool ? "required" : "optional",
            allowedToolCount: tools.length,
            nativeToolCount: attempt.textEnvelope ? 0 : tools.length,
            allowedToolNames: tools.map((tool) => tool.function.name),
          });
          const result = await requestProviderOnce({
            live: input.live,
            ports: input,
            command,
            tools,
            textEnvelope: attempt.textEnvelope,
            toolChoice: attempt.toolChoice,
            signal,
          });
          if (requiresTool && result.toolCalls.length === 0) {
            throw new Error("Provider returned no structured tool call for a tool-required runtime command.");
          }
          const unexpectedToolNames = unexpectedRuntimeV2ProviderToolNames(
            tools,
            result.toolCalls,
          );
          if (unexpectedToolNames.length > 0) {
            input.logStoreEvent("runtime_v2_provider_tool_surface_rejected", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              phase: command.phase,
              transport: attempt.variant,
              unexpectedToolNames,
              allowedToolNames: tools.map((tool) => tool.function.name),
            });
            throw new Error(
              `Provider requested tools outside the current Runtime v2 phase surface: ${unexpectedToolNames.join(", ")}`,
            );
          }
          input.live.latestProviderResult = result;
          // A tool envelope (or a native response that bundles an action with
          // prose) is not a user-facing conclusion. Keeping it here would let
          // a later recovery final repeat raw "let me edit" text after the
          // structured action has already been handled by the Capsule.
          input.live.latestVisibleText = result.toolCalls.length === 0
            ? sanitizeAssistantDisplayContent(result.visibleText || "").trim().slice(0, 24_000)
            : "";
          if (input.live.latestVisibleText) {
            recordModelContext(input.live, {
              id: `provider:${command.idempotencyKey}`,
              source: "provider",
              label: `synthesis:${String(command.payload.mode || "unknown")}`,
              target: "current-turn",
              status: "succeeded",
              content: input.live.latestVisibleText,
            });
          }
          input.live.lastProviderTransport = attempt.textEnvelope ? "text_envelope" : "native";
          input.logStoreEvent("runtime_v2_provider_result", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            transport: attempt.variant,
            toolCalls: result.toolCalls.length,
            toolNames: result.toolCalls.map((call) => call.name),
            visibleChars: input.live.latestVisibleText.length,
            diagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code).slice(0, 8),
          });
          return result;
        } catch (error) {
          lastError = error;
          input.logStoreEvent("runtime_v2_provider_transport_failed", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            transport: attempt.variant,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Runtime v2 provider transport attempts exhausted.");
    },
  };
}
