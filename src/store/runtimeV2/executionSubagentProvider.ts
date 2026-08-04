import type { AgentMessage } from "../../lib/agentMessages";
import { acquireModelLane } from "../../lib/modelLaneCoordinator";
import { deriveBudgetedStreamSettings } from "../../lib/providerLaneSettings";
import { boundRuntimeMessagesToContext } from "../../lib/runtimeContextBudget";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { streamChatCompletion } from "../../lib/streaming";
import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  isRuntimeV2ProviderProtocolError,
  normalizeProviderResponseV1,
  recordProviderTransportAttempt,
  RuntimeV2ProviderProtocolError,
  runtimeV2ProviderProtocolErrorAllowsTransportFallback,
  selectNextProviderTransportAttempt,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2SubagentJob,
} from "../../lib/runtime-v2";
import {
  baseProviderProfile,
  compactTextEnvelopeCatalog,
  containsProviderTextEnvelopePrompt,
} from "./executionContext";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import {
  normalizeRuntimeV2ChildToolCalls,
  runtimeV2ChildOutputTokenLimit,
} from "./executionSubagentPolicy";
import {
  scopeRuntimeV2ProviderToolCallIds,
} from "./providerToolSurface";

/** One bounded child-model decision. Transport negotiation and lane telemetry
 * live outside the child evidence/effect loop so neither module becomes a
 * second orchestration super-module. */
export async function requestRuntimeV2ChildStep(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly recoveryOccurrence: number;
}): Promise<RuntimeV2NormalizedProviderResult> {
  const profile = {
    ...baseProviderProfile(input.ports.get()),
    requiredToolChoice: false,
  };
  let epoch: {
    actionKey: string;
    attempted: readonly (
      "native_required" | "native_auto" | "text_envelope"
    )[];
  } = {
    actionKey: `${input.job.id}:${input.messages.length}`,
    attempted: [],
  };
  let lastError: unknown = null;
  while (Date.now() < input.deadlineAt) {
    const attempt = selectNextProviderTransportAttempt(profile, epoch);
    if (!attempt) break;
    epoch = recordProviderTransportAttempt(epoch, attempt);
    const remainingMs = Math.max(1, input.deadlineAt - Date.now());
    const timeoutMs = Number.isFinite(remainingMs)
      ? remainingMs
      : undefined;
    try {
      const requestMessages: AgentMessage[] = [
        ...input.messages,
        ...(input.recoveryOccurrence > 0
          ? [{
              role: "system" as const,
              content:
                `CHILD_RECOVERY_PIVOT ${input.recoveryOccurrence}: the previous child step produced no new evidence. Use a genuinely different allowed read/validation action for one named missing fact, or conclude from retained evidence. Do not repeat the closed action.`,
            }]
          : []),
        ...(attempt.textEnvelope
          ? [{
              role: "system" as const,
              content: containsProviderTextEnvelopePrompt(
                input.ports.context.phaseLanguage,
                false,
              ),
            }, {
              role: "system" as const,
              content: compactTextEnvelopeCatalog(input.tools),
            }]
          : []),
      ];
      const budget = input.ports.context.runtimeContextBudget;
      const maxOutputTokens = runtimeV2ChildOutputTokenLimit(budget);
      const boundedRequestMessages = budget
        ? boundRuntimeMessagesToContext(requestMessages, {
            contextLimit: budget.contextLimit,
            reservedOutputTokens: maxOutputTokens,
          })
        : requestMessages;
      let streamedText = "";
      const state = input.ports.get();
      const requestTokenBudget = Math.max(
        2_048,
        Math.ceil(
          boundedRequestMessages.reduce(
            (total, message) =>
              total + (
                typeof message.content === "string"
                  ? message.content.length
                  : JSON.stringify(message.content).length
              ),
            0,
          ) / 4,
        ) + maxOutputTokens,
      );
      const requestController = new AbortController();
      const abortRequestFromParent = () =>
        requestController.abort(input.signal.reason);
      if (input.signal.aborted) abortRequestFromParent();
      else {
        input.signal.addEventListener(
          "abort",
          abortRequestFromParent,
          { once: true },
        );
      }
      const lane = await acquireModelLane({
        config: state.config,
        contextLimit: budget?.contextLimit,
        requestTokenBudget,
        agentKind: "subagent",
        subagentId: input.job.id,
        signal: requestController.signal,
        onDebugEvent: (event, data) =>
          input.ports.logStoreEvent(event, {
            turnId: input.job.run.turnId,
            runId: input.job.run.runId,
            jobId: input.job.id,
            ...data,
          }),
      });
      lane.setPressureHandler((error) =>
        requestController.abort(error)
      );
      let wire: Awaited<ReturnType<typeof streamChatCompletion>>;
      try {
        wire = await streamChatCompletion(
          boundedRequestMessages,
          deriveBudgetedStreamSettings(
            state.config,
            budget,
          ),
          {
            onToken: (token) => {
              lane.markFirstToken();
              streamedText += token;
              const telemetry =
                input.ports.live.childTelemetry.get(input.job.id);
              if (telemetry && telemetry.firstTokenAt === null) {
                telemetry.firstTokenAt = input.ports.now();
              }
            },
            onDone: () => undefined,
            onError: () => undefined,
            onLifecycle: (event) => {
              if (event.phase !== "first_chunk") return;
              lane.markFirstToken();
              const telemetry =
                input.ports.live.childTelemetry.get(input.job.id);
              if (telemetry && telemetry.firstTokenAt === null) {
                telemetry.firstTokenAt = input.ports.now();
              }
            },
          },
          requestController.signal,
          attempt.textEnvelope ? [] : [...input.tools],
          maxOutputTokens,
          {
            ...(attempt.toolChoice
              ? { toolChoice: attempt.toolChoice }
              : {}),
            timeoutMs,
            contextOwnership: "caller",
          },
        );
      } catch (error) {
        lane.reportFailure(error);
        throw error;
      } finally {
        lane.setPressureHandler(undefined);
        input.signal.removeEventListener(
          "abort",
          abortRequestFromParent,
        );
        lane.release();
      }
      let normalized = normalizeProviderResponseV1({
        visibleText: wire.semanticContent || streamedText,
        content: wire.actionableContent || wire.content || streamedText,
        toolCalls: wire.toolCalls,
        usage: wire.usage,
        diagnostics: wire.protocolViolation
          ? [{
              code: wire.protocolViolation,
              message: "Child provider tool protocol mismatch",
              retryable: true,
            }]
          : [],
      });
      normalized = {
        ...normalized,
        toolCalls: normalizeRuntimeV2ChildToolCalls(
          normalized.toolCalls,
          input.tools,
          input.ports.context.runWorkspace,
        ),
      };
      if (normalized.toolCalls.length > 0) {
        input.ports.live.provenStructuredToolTransports.add(
          attempt.variant,
        );
      }
      const allowed = new Set(
        input.tools.map((tool) => tool.function.name),
      );
      const unexpected = normalized.toolCalls.filter(
        (call) => !allowed.has(call.name),
      );
      const visibleText = sanitizeAssistantDisplayContent(
        normalized.visibleText || "",
      ).trim();
      if (
        unexpected.length > 0 ||
        normalized.diagnostics.length > 0
      ) {
        throw new RuntimeV2ProviderProtocolError(
          unexpected.length > 0
            ? "tool_surface_rejected"
            : "tool_arguments_rejected",
          unexpected.length > 0
            ? `child_tool_surface_rejected:${
                unexpected.map((call) => call.name).join(",")
              }`
            : "child_protocol_diagnostic",
        );
      }
      input.ports.logStoreEvent("runtime_v2_subagent_provider_result", {
        turnId: input.job.run.turnId,
        runId: input.job.run.runId,
        jobId: input.job.id,
        transport: attempt.variant,
        toolName: normalized.toolCalls[0]?.name || null,
        toolNames: normalized.toolCalls.map((call) => call.name),
        concluded: normalized.toolCalls.length === 0,
      });
      return {
        ...normalized,
        visibleText,
        toolCalls: scopeRuntimeV2ProviderToolCallIds(
          normalized.toolCalls,
          () => input.ports.nextId("subagent-tool-call"),
        ),
      };
    } catch (error) {
      lastError = error;
      const fallbackAllowed =
        runtimeV2ProviderProtocolErrorAllowsTransportFallback(
          error,
          {
            activeTransportProven:
              input.ports.live.provenStructuredToolTransports.has(
                attempt.variant,
              ),
          },
        );
      input.ports.logStoreEvent(
        isRuntimeV2ProviderProtocolError(error)
          ? "runtime_v2_subagent_protocol_drift"
          : "runtime_v2_subagent_transport_failed",
        {
          turnId: input.job.run.turnId,
          runId: input.job.run.runId,
          jobId: input.job.id,
          transport: attempt.variant,
          error: error instanceof Error ? error.message : String(error),
          transportFallbackAllowed: fallbackAllowed,
        },
      );
      if (!fallbackAllowed) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Runtime v2 child provider transports exhausted.");
}
