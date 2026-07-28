import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import {
  allocateProviderAttemptTimeoutMs,
  recordProviderTransportAttempt,
  isRuntimeV2ProviderProtocolError,
  selectNextProviderTransportAttempt,
  type ProviderPort,
  type RuntimeV2TransportVariant,
} from "../../lib/runtime-v2";
import {
  baseProviderProfile,
  latestCorrectiveSourceRefreshWindow,
  latestFailureReadWindow,
  providerProfileForProvenToolTransport,
  providerToolDefinitionsForCommand,
  preferredFiniteValidationCommand,
  recordModelContext,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import { finiteValidationCommandRejection } from "./executionAuthorization";
import {
  selectRuntimeOwnedSourceRefreshAction,
  selectRuntimeOwnedValidationAction,
} from "./executionDeterministicActions";
import {
  boundRuntimeV2ProviderToolCalls,
  unexpectedRuntimeV2ProviderToolNames,
} from "./providerToolSurface";
import { withRuntimeV2HardDeadline } from "./hardDeadline";
import {
  requestRuntimeV2ProviderOnce,
  runtimeV2ExecutionProviderOutputTokenLimit,
  runtimeV2ProviderProtocolError,
} from "./executionProviderRequest";

export const RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT_MS = 90_000;

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
      const profile = providerProfileForProvenToolTransport({
        ...input.live.providerLaneProfile,
        schemaVersion: "provider-lane.v1" as const,
        requiredToolChoice: requiresTool,
      }, input.live.lastProviderTransport, requiresTool);
      // Freeze one capability surface for the Turn. A UI toggle or config
      // refresh after admission cannot make the provider request a tool that
      // the executor's authorization catalog did not expose.
      const tools = providerToolDefinitionsForCommand(input, command);
      const preferredValidation =
        preferredFiniteValidationCommand(input);
      const allowedToolNames = tools.map((tool) => tool.function.name);
      const deterministicValidation = !signal.aborted
        ? selectRuntimeOwnedValidationAction({
            command,
            allowedToolNames,
            preferredCommand: preferredValidation,
          })
        : null;
      if (deterministicValidation) {
        input.live.latestProviderResult = deterministicValidation;
        input.live.latestVisibleText = "";
        input.logStoreEvent("runtime_v2_validation_fallback_selected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          phase: command.phase,
          command:
            deterministicValidation.toolCalls[0]?.arguments.command,
          providerAttempts: 0,
          selectionReason: "runtime_owned_preferred_validator",
          lastFailureKind: null,
          lastProtocolCode: null,
        });
        return deterministicValidation;
      }
      const deterministicSourceWindow =
        !signal.aborted &&
          command.payload.executePolicy === "source_refresh_required" &&
          allowedToolNames.includes("read_file")
        ? latestCorrectiveSourceRefreshWindow(
            input.live,
            input.context.runWorkspace || "",
          )
        : null;
      const deterministicSourceRefresh = !signal.aborted
        ? selectRuntimeOwnedSourceRefreshAction({
            command,
            allowedToolNames,
            sourceWindow: deterministicSourceWindow,
          })
        : null;
      if (deterministicSourceWindow && deterministicSourceRefresh) {
        const failureContext = input.live.modelContext.find(
          (entry) => entry.id === deterministicSourceWindow.evidenceId,
        );
        input.live.latestProviderResult = deterministicSourceRefresh;
        input.live.latestVisibleText = "";
        input.logStoreEvent(
          "runtime_v2_failure_read_window_selected",
          {
            turnId: command.run.turnId,
            runId: command.run.runId,
            requestedPath: deterministicSourceWindow.path,
            path: deterministicSourceWindow.path,
            startLine: deterministicSourceWindow.startLine,
            endLine: deterministicSourceWindow.endLine,
            failureLine: deterministicSourceWindow.failureLine,
            evidenceId: deterministicSourceWindow.evidenceId,
            failureLabel: failureContext?.label || null,
            selectionReason: "runtime_owned_source_refresh",
          },
        );
        input.logStoreEvent(
          "runtime_v2_source_refresh_fallback_selected",
          {
            turnId: command.run.turnId,
            runId: command.run.runId,
            phase: command.phase,
            path: deterministicSourceWindow.path,
            startLine: deterministicSourceWindow.startLine,
            endLine: deterministicSourceWindow.endLine,
            evidenceId: deterministicSourceWindow.evidenceId,
          },
        );
        return deterministicSourceRefresh;
      }
      const requestDeadlineAt = Math.min(
        Date.now() + RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT_MS,
        input.lifecycleDeadlineAt ?? Number.POSITIVE_INFINITY,
      );
      let epoch: { actionKey: string; attempted: readonly RuntimeV2TransportVariant[] } = {
        actionKey: command.idempotencyKey,
        attempted: [],
      };
      let lastError: unknown = null;
      while (true) {
        if (Date.now() >= requestDeadlineAt) {
          lastError = new Error(
            "RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT",
          );
          break;
        }
        const attempt = selectNextProviderTransportAttempt(profile, epoch);
        if (!attempt) break;
        epoch = recordProviderTransportAttempt(epoch, attempt);
        const requestAbort = new AbortController();
        let requestTimedOut = false;
        const forwardAbort = () => requestAbort.abort(signal.reason);
        if (signal.aborted) {
          forwardAbort();
        } else {
          signal.addEventListener("abort", forwardAbort, { once: true });
        }
        const remainingMs = Math.max(1, requestDeadlineAt - Date.now());
        const hasFallback =
          selectNextProviderTransportAttempt(profile, epoch) !== null;
        const timeoutMs = allocateProviderAttemptTimeoutMs(
          remainingMs,
          hasFallback,
        );
        try {
          input.logStoreEvent("runtime_v2_provider_request_opened", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            phase: command.phase,
            transport: attempt.variant,
            textEnvelope: attempt.textEnvelope,
            toolExpectation: requiresTool ? "required" : "optional",
            executePolicy: String(command.payload.executePolicy || ""),
            allowedToolCount: tools.length,
            nativeToolCount: attempt.textEnvelope ? 0 : tools.length,
            allowedToolNames: tools.map((tool) => tool.function.name),
            hasFallback,
            remainingRequestMs: remainingMs,
            timeoutMs,
            maxOutputTokens:
              runtimeV2ExecutionProviderOutputTokenLimit(
                command,
                attempt.textEnvelope,
              ),
          });
          let result = await withRuntimeV2HardDeadline({
            timeoutMs,
            timeoutError: "RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT",
            onTimeout: () => {
              requestTimedOut = true;
              requestAbort.abort(
                "runtime_v2_execution_provider_request_timeout",
              );
            },
            task: () => requestRuntimeV2ProviderOnce({
              live: input.live,
              ports: input,
              command,
              tools,
              textEnvelope: attempt.textEnvelope,
              toolChoice: attempt.toolChoice,
              signal: requestAbort.signal,
              timeoutMs,
            }),
          });
          if (requiresTool && result.toolCalls.length === 0) {
            const missingToolText = sanitizeAssistantDisplayContent(
              result.visibleText || "",
            ).replace(/\s+/g, " ").trim();
            input.logStoreEvent("runtime_v2_required_tool_missing", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              phase: command.phase,
              transport: attempt.variant,
              textEnvelope: attempt.textEnvelope,
              responseChars: missingToolText.length,
              responsePreview: missingToolText.slice(0, 600),
              responseTail: missingToolText.length > 600
                ? missingToolText.slice(-600)
                : "",
              diagnosticCodes: result.diagnostics
                .map((diagnostic) => diagnostic.code)
                .slice(0, 8),
              diagnosticMessages: result.diagnostics
                .map((diagnostic) => diagnostic.message)
                .slice(0, 4),
              startsWithJson: /^\s*\{/.test(result.visibleText || ""),
              hasJsonFence: /^\s*```(?:json)?/i.test(
                result.visibleText || "",
              ),
              mentionsToolCalls: /tool_?calls?|runtime-v2-tools/i.test(
                result.visibleText || "",
              ),
            });
            throw runtimeV2ProviderProtocolError({
              ports: input,
              command,
              code: "required_tool_missing",
              requestedToolNames: [],
              allowedToolNames: tools.map((tool) => tool.function.name),
            });
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
            throw runtimeV2ProviderProtocolError({
              ports: input,
              command,
              code: "tool_surface_rejected",
              requestedToolNames: unexpectedToolNames,
              allowedToolNames: tools.map((tool) => tool.function.name),
            });
          }
          const boundedBatch = boundRuntimeV2ProviderToolCalls(
            result.toolCalls,
          );
          if (boundedBatch.discarded.length > 0) {
            input.logStoreEvent(
              "runtime_v2_provider_tool_batch_normalized",
              {
                turnId: command.run.turnId,
                runId: command.run.runId,
                phase: command.phase,
                transport: attempt.variant,
                acceptedToolName: boundedBatch.accepted[0]?.name || null,
                discardedToolNames: boundedBatch.discarded.map(
                  (call) => call.name,
                ),
                originalToolCount: result.toolCalls.length,
              },
            );
            result = {
              ...result,
              toolCalls: boundedBatch.accepted,
            };
          }
          if (
            String(command.payload.mode || "") === "execute" &&
            (
              command.payload.executePolicy === "source_gap_allowed" ||
              command.payload.executePolicy ===
                "source_reorientation_required" ||
              command.payload.executePolicy === "source_refresh_required" ||
              command.payload.executePolicy === "mutation_required"
            )
          ) {
            let enriched = false;
            const toolCalls = result.toolCalls.map((call) => {
              const forceRuntimeWindow =
                command.payload.executePolicy === "source_refresh_required";
              const hasExplicitWindow =
                call.arguments.start_line !== undefined ||
                call.arguments.end_line !== undefined;
              if (
                call.name !== "read_file" ||
                (!forceRuntimeWindow && hasExplicitWindow)
              ) {
                return call;
              }
              const requestedPath = String(
                call.arguments.path || call.arguments.file_path || "",
              ).trim();
              const primaryWindow = forceRuntimeWindow
                ? latestCorrectiveSourceRefreshWindow(
                    input.live,
                    input.context.runWorkspace || "",
                  )
                : null;
              const window = primaryWindow || latestFailureReadWindow(
                input.live,
                requestedPath,
                input.context.runWorkspace || "",
              );
              if (!window) return call;
              enriched = true;
              const resolvedPath = "path" in window
                ? window.path
                : requestedPath;
              const failureContext = input.live.modelContext.find(
                (entry) => entry.id === window.evidenceId,
              );
              input.logStoreEvent(
                "runtime_v2_failure_read_window_selected",
                {
                  turnId: command.run.turnId,
                  runId: command.run.runId,
                  requestedPath,
                  path: resolvedPath,
                  startLine: window.startLine,
                  endLine: window.endLine,
                  failureLine: window.failureLine,
                  evidenceId: window.evidenceId,
                  failureLabel: failureContext?.label || null,
                },
              );
              return {
                ...call,
                arguments: {
                  ...call.arguments,
                  path: resolvedPath,
                  start_line: window.startLine,
                  end_line: window.endLine,
                  max_lines: window.endLine - window.startLine + 1,
                },
              };
            });
            if (enriched) result = { ...result, toolCalls };
          }
          if (String(command.payload.mode || "") === "validate") {
            const invalidValidationCall = result.toolCalls.find((call) => {
              if (call.name !== "run_command") return false;
              return !!finiteValidationCommandRejection(
                call.arguments.command || call.arguments.cmd,
              );
            });
            if (invalidValidationCall) {
              const rejection = finiteValidationCommandRejection(
                invalidValidationCall.arguments.command ||
                  invalidValidationCall.arguments.cmd,
              )!;
              const preferredValidation =
                preferredFiniteValidationCommand(input);
              input.logStoreEvent(
                "runtime_v2_provider_tool_arguments_rejected",
                {
                  turnId: command.run.turnId,
                  runId: command.run.runId,
                  phase: command.phase,
                  transport: attempt.variant,
                  toolName: invalidValidationCall.name,
                  reason: rejection.reasonCode,
                  rejectionReason: rejection.rejectionReason,
                  preferredValidationCommand: preferredValidation || null,
                },
              );
              throw runtimeV2ProviderProtocolError({
                ports: input,
                command,
                code: "tool_arguments_rejected",
                requestedToolNames: [invalidValidationCall.name],
                allowedToolNames: tools.map((tool) => tool.function.name),
                detail: [
                  "The proposed run_command is not a finite acceptance validator.",
                  rejection.message,
                ].join(" "),
                preferredValidationCommand: preferredValidation,
              });
            }
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
          if (result.toolCalls.length > 0) {
            input.live.lastProviderTransport = attempt.textEnvelope &&
                input.live.lastProviderTransport === "native"
              ? "native"
              : attempt.textEnvelope
                ? "text_envelope"
                : "native";
          }
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
          const normalizedError = requestTimedOut
            ? new Error("RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT")
            : error;
          lastError = normalizedError;
          input.logStoreEvent(isRuntimeV2ProviderProtocolError(normalizedError)
            ? "runtime_v2_provider_protocol_failed"
            : "runtime_v2_provider_transport_failed", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            transport: attempt.variant,
            ...(isRuntimeV2ProviderProtocolError(normalizedError)
              ? { protocolCode: normalizedError.code }
              : {}),
            timedOut: requestTimedOut,
            timeoutMs,
            error: normalizedError instanceof Error
              ? normalizedError.message
              : String(normalizedError),
          });
        } finally {
          signal.removeEventListener("abort", forwardAbort);
        }
      }
      const validationFallback = !signal.aborted
        ? selectRuntimeOwnedValidationAction({
            command,
            allowedToolNames,
            preferredCommand: preferredFiniteValidationCommand(input),
          })
        : null;
      if (validationFallback) {
        input.live.latestProviderResult = validationFallback;
        input.live.latestVisibleText = "";
        input.logStoreEvent("runtime_v2_validation_fallback_selected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          phase: command.phase,
          command: validationFallback.toolCalls[0]?.arguments.command,
          providerAttempts: epoch.attempted.length,
          lastFailureKind: isRuntimeV2ProviderProtocolError(lastError)
            ? "protocol"
            : "transport",
          lastProtocolCode: isRuntimeV2ProviderProtocolError(lastError)
            ? lastError.code
            : null,
        });
        return validationFallback;
      }
      if (isRuntimeV2ProviderProtocolError(lastError)) {
        input.logStoreEvent("runtime_v2_provider_protocol_exhausted", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          phase: command.phase,
          protocolCode: lastError.code,
        });
      }
      throw lastError instanceof Error ? lastError : new Error("Runtime v2 provider transport attempts exhausted.");
    },
  };
}
