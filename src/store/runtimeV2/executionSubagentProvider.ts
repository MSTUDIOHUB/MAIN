import type { AgentMessage } from "../../lib/agentMessages";
import { acquireModelLane } from "../../lib/modelLaneCoordinator";
import { deriveBudgetedStreamSettings } from "../../lib/providerLaneSettings";
import { boundRuntimeMessagesToContext } from "../../lib/runtimeContextBudget";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { streamChatCompletion } from "../../lib/streaming";
import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  isRequiredToolChoiceCompatibilityErrorMessage,
} from "../../lib/providerCompatibility";
import {
  isRuntimeV2ProviderProtocolError,
  normalizeProviderResponseV1,
  recordProviderTransportAttempt,
  RuntimeV2ProviderProtocolError,
  runtimeV2ProviderProtocolErrorAllowsTransportFallback,
  selectNextProviderTransportAttempt,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2SubagentJob,
  type RuntimeV2TransportVariant,
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
import { withRuntimeV2HardDeadline } from "./hardDeadline";

const RUNTIME_V2_SUBAGENT_PROVIDER_TIMEOUT_ERROR =
  "RUNTIME_V2_SUBAGENT_PROVIDER_REQUEST_TIMEOUT";

export type RuntimeV2ChildResponseMode =
  | "action_or_final"
  | "report_required";

/** One bounded child-model decision. Transport negotiation and lane telemetry
 * live outside the child evidence/effect loop so neither module becomes a
 * second orchestration super-module. */
export async function requestRuntimeV2ChildStep(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly responseMode: RuntimeV2ChildResponseMode;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly recoveryOccurrence: number;
}): Promise<RuntimeV2NormalizedProviderResult> {
  const profile = {
    ...baseProviderProfile(input.ports.get()),
    requiredToolChoice: input.responseMode === "report_required",
  };
  let epoch: {
    actionKey: string;
    attempted: readonly RuntimeV2TransportVariant[];
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
    try {
      const requestMessages: AgentMessage[] = [
        ...input.messages,
        ...(input.responseMode === "action_or_final" &&
            input.recoveryOccurrence > 0
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
                input.responseMode === "report_required",
              ),
            }, {
              role: "system" as const,
              content: compactTextEnvelopeCatalog(input.tools),
            }]
          : []),
      ];
      const budget = input.ports.context.runtimeContextBudget;
      const admittedOutputTokens = runtimeV2ChildOutputTokenLimit(budget);
      const maxOutputTokens = input.responseMode === "report_required"
        ? Math.min(4_096, admittedOutputTokens)
        : admittedOutputTokens;
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
      let lane: Awaited<ReturnType<typeof acquireModelLane>> | null = null;
      const releaseLane = () => {
        const activeLane = lane;
        if (!activeLane) return;
        lane = null;
        activeLane.setPressureHandler(undefined);
        activeLane.release();
      };
      try {
        const wire = await withRuntimeV2HardDeadline({
          timeoutMs: remainingMs,
          timeoutError: RUNTIME_V2_SUBAGENT_PROVIDER_TIMEOUT_ERROR,
          onTimeout: () => {
            requestController.abort(
              RUNTIME_V2_SUBAGENT_PROVIDER_TIMEOUT_ERROR,
            );
            releaseLane();
          },
          task: async () => {
            lane = await acquireModelLane({
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
            const activeLane = lane;
            activeLane.setPressureHandler((error) =>
              requestController.abort(error)
            );
            const streamTimeoutMs = Math.max(
              1,
              Math.min(remainingMs, input.deadlineAt - Date.now()),
            );
            try {
              return await streamChatCompletion(
                boundedRequestMessages,
                deriveBudgetedStreamSettings(
                  state.config,
                  budget,
                ),
                {
                  onToken: (token) => {
                    activeLane.markFirstToken();
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
                    if (event.phase !== "model_progress") return;
                    activeLane.markFirstToken();
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
                  timeoutMs: streamTimeoutMs,
                  contextOwnership: "caller",
                },
              );
            } catch (error) {
              activeLane.reportFailure(error);
              throw error;
            }
          },
        });

        let normalized = normalizeProviderResponseV1({
          visibleText: wire.semanticContent || streamedText,
          content: wire.actionableContent || wire.content || streamedText,
          toolCalls: wire.toolCalls,
          usage: wire.usage,
          ...(input.responseMode === "report_required" &&
              !attempt.textEnvelope &&
              input.tools.length === 1
            ? { requiredSingleTool: input.tools[0] }
            : {}),
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
        if (
          !attempt.textEnvelope &&
          wire.toolCalls.length > 0 &&
          normalized.toolCalls.length > 0
        ) {
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
          input.responseMode === "report_required" &&
          normalized.toolCalls.length === 0
        ) {
          throw new RuntimeV2ProviderProtocolError(
            "required_tool_missing",
            "child_report_submission_missing",
          );
        }
        if (
          input.responseMode === "report_required" &&
          normalized.toolCalls.length !== 1
        ) {
          throw new RuntimeV2ProviderProtocolError(
            "tool_surface_rejected",
            "child_report_submission_cardinality_invalid",
          );
        }
        if (
          unexpected.length > 0 ||
          normalized.diagnostics.some((diagnostic) => diagnostic.retryable)
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
      } finally {
        input.signal.removeEventListener(
          "abort",
          abortRequestFromParent,
        );
        releaseLane();
      }
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      lastError = !attempt.textEnvelope &&
          attempt.toolChoice === "required" &&
          isRequiredToolChoiceCompatibilityErrorMessage(errorMessage)
        ? new RuntimeV2ProviderProtocolError(
            "required_tool_missing",
            errorMessage,
          )
        : error;
      const fallbackAllowed =
        runtimeV2ProviderProtocolErrorAllowsTransportFallback(
          lastError,
          {
            activeTransportProven:
              input.ports.live.provenStructuredToolTransports.has(
                attempt.variant,
              ),
          },
        );
      input.ports.logStoreEvent(
        isRuntimeV2ProviderProtocolError(lastError)
          ? "runtime_v2_subagent_protocol_drift"
          : "runtime_v2_subagent_transport_failed",
        {
          turnId: input.job.run.turnId,
          runId: input.job.run.runId,
          jobId: input.job.id,
          transport: attempt.variant,
          error: lastError instanceof Error
            ? lastError.message
            : String(lastError),
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
