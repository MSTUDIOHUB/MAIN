import type { AgentMessage } from "../../lib/agentMessages";
import { deriveBudgetedStreamSettings } from "../../lib/providerLaneSettings";
import { boundRuntimeMessagesToContext } from "../../lib/runtimeContextBudget";
import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import { acquireModelLane } from "../../lib/modelLaneCoordinator";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { streamChatCompletion } from "../../lib/streaming";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import { executeTool } from "../../lib/toolExecutor";
import { getToolTarget } from "../../lib/toolTarget";
import {
  advanceRuntimeV2ChildRecoveryStallLease,
  compileRuntimeV2SubagentTextReport,
  isRuntimeV2ProviderProtocolError,
  normalizeProviderResponseV1,
  recordProviderTransportAttempt,
  RuntimeV2ProviderProtocolError,
  runtimeV2ProviderProtocolErrorAllowsTransportFallback,
  runtimeV2ChildRecoveryStallExpired,
  runtimeV2EvidenceVersion,
  runtimeV2SubagentFailureSummary,
  selectNextProviderTransportAttempt,
  type RuntimeV2EvidenceReference,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2NormalizedToolCall,
  type RuntimeV2ChildRecoveryStallLease,
  type RuntimeV2SubagentJob,
} from "../../lib/runtime-v2";
import { analyzeValidationCommand } from "../../lib/validationContract";
import {
  authorizationFor,
  authorizeToolForCurrentTurn,
  baseProviderProfile,
  boundedRuntimeV2ToolContent,
  childScopeAllows,
  compactTextEnvelopeCatalog,
  containsProviderTextEnvelopePrompt,
  runtimeV2ContextBoundToolArguments,
  runtimeV2ParallelReadCount,
  type RuntimeV2ChildResult,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import { aggregateForCurrentTurn } from "./executionAggregate";
import {
  deriveRuntimeV2ProviderEffectFacts,
} from "./executionProviderEffectFacts";
import {
  isRuntimeV2ValidationPassed,
  runtimeV2ValidationEvidenceVersion,
} from "./executionEvidence";
import { buildRuntimeV2SubagentContextCapsule } from "./executionSubagentContext";
import {
  boundRuntimeV2ProviderToolCalls,
  completedRuntimeV2ProviderToolCallIdentities,
  scopeRuntimeV2ProviderToolCallIds,
} from "./providerToolSurface";

const READ_ONLY_CHILD_TOOL_NAMES = new Set([
  "list_directory",
  "read_file",
  "grep_search",
  "get_file_outline",
  "code_ast_query",
  "find_symbol_references",
]);
const VALIDATION_CHILD_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "computer_use",
]);
const CHILD_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((definition) =>
  READ_ONLY_CHILD_TOOL_NAMES.has(definition.function.name) ||
  VALIDATION_CHILD_TOOL_NAMES.has(definition.function.name)
);

export function runtimeV2ChildDeadlineAt(
  parentLifecycleDeadlineAt?: number,
): number {
  return Number.isFinite(parentLifecycleDeadlineAt)
    ? Number(parentLifecycleDeadlineAt)
    : Number.POSITIVE_INFINITY;
}

class RuntimeV2ChildDeadlineError extends Error {}

export function boundRuntimeV2ChildToolCalls(
  calls: readonly RuntimeV2NormalizedToolCall[],
  attemptedIdentities: ReadonlySet<string> = new Set(),
): RuntimeV2NormalizedToolCall[] {
  return boundRuntimeV2ProviderToolCalls(
    calls,
    attemptedIdentities,
  ).accepted;
}

export function runtimeV2ChildToolOutputContent(
  toolName: string,
  value: unknown,
  budget?: RuntimeContextBudget | null,
): string {
  return boundedRuntimeV2ToolContent(toolName, value, budget);
}

export function runtimeV2ChildOutputTokenLimit(
  budget?: Pick<RuntimeContextBudget, "outputBudget"> | null,
): number {
  const admitted = Math.floor(Number(budget?.outputBudget));
  return Number.isFinite(admitted) && admitted > 0
    ? admitted
    : 4_096;
}

function childTools(job: RuntimeV2SubagentJob): ToolDefinition[] {
  return CHILD_TOOL_DEFINITIONS.filter((definition) =>
    READ_ONLY_CHILD_TOOL_NAMES.has(definition.function.name) ||
    job.taskKind === "validate"
  );
}

async function childToolAllowed(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly name: string;
  readonly args: Record<string, unknown>;
}): Promise<boolean> {
  if (READ_ONLY_CHILD_TOOL_NAMES.has(input.name)) {
    return childScopeAllows(input.job, input.args);
  }
  if (
    input.job.taskKind !== "validate" ||
    !VALIDATION_CHILD_TOOL_NAMES.has(input.name)
  ) {
    return false;
  }
  if (input.name === "run_command") {
    const analysis = analyzeValidationCommand(
      String(input.args.command ?? input.args.cmd ?? ""),
      { cwd: String(input.args.cwd ?? input.args.workdir ?? ".") },
    );
    if (
      analysis.spec?.kind !== "finite_command" ||
      !childScopeAllows(input.job, { cwd: analysis.spec.cwd || "." })
    ) {
      return false;
    }
  }
  return (await authorizeToolForCurrentTurn(
    input.ports,
    input.name,
    input.args,
  )).allowed;
}

async function requestChildStep(input: {
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
      const normalized = normalizeProviderResponseV1({
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

function pathsOverlap(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return !a || !b || a === "." || b === "." ||
    a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function inheritedReviewEvidence(
  ports: RuntimeV2ExecutionPortsInput,
  job: RuntimeV2SubagentJob,
): RuntimeV2EvidenceReference[] {
  if (job.taskKind !== "review") return [];
  return (aggregateForCurrentTurn(ports)?.evidence || [])
    .filter((evidence) =>
      job.allowedPaths.some((path) => pathsOverlap(evidence.target, path))
    )
    .slice(-16);
}

function completedChildResult(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly summary: string;
  readonly inheritedEvidence: readonly RuntimeV2EvidenceReference[];
  readonly evidence: readonly RuntimeV2EvidenceReference[];
}): RuntimeV2ChildResult {
  const report = compileRuntimeV2SubagentTextReport({
    summary: input.summary,
    evidence: input.evidence,
    inheritedEvidence: input.inheritedEvidence,
  });
  return {
    job: input.job,
    status: "completed",
    summary: report.summary,
    report,
    inheritedEvidence: input.inheritedEvidence,
    evidence: input.evidence,
  };
}

async function runRuntimeV2Child(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly signal: AbortSignal;
}): Promise<RuntimeV2ChildResult> {
  const telemetry = input.ports.live.childTelemetry.get(input.job.id);
  const tools = childTools(input.job);
  const aggregate = aggregateForCurrentTurn(input.ports);
  const context = buildRuntimeV2SubagentContextCapsule({
    aggregate,
    job: input.job,
    messages: input.ports.live.messages,
    effectFacts: deriveRuntimeV2ProviderEffectFacts(aggregate),
    workspace: input.ports.context.runWorkspace || "",
    contextBudget:
      input.ports.context.runtimeContextBudget || undefined,
  });
  input.ports.logStoreEvent("runtime_v2_subagent_context_handoff", {
    turnId: input.job.run.turnId,
    runId: input.job.parentRunId,
    childRunId: input.job.run.runId,
    jobId: input.job.id,
    taskKind: input.job.taskKind || "explore",
    parentContextChars: context.length,
    inheritedContext: context.length > 0,
  });
  const deadlineAt = runtimeV2ChildDeadlineAt(
    input.ports.lifecycleDeadlineAt,
  );
  const messages: AgentMessage[] = [{
    role: "system",
    content: [
      "You are a read-only child of the current MAIN turn.",
      `Task kind: ${input.job.taskKind || "explore"}`,
      `Role: ${input.job.role || "read-only reviewer"}`,
      `Allowed paths: ${input.job.allowedPaths.join(", ")}`,
      input.job.successCriteria
        ? `Success criteria: ${input.job.successCriteria}`
        : "",
      "The parent is the only writer. Never request or simulate file changes.",
      "Use the parent context as current context; do not reread an unchanged fact merely to reconstruct the task.",
      input.job.taskKind === "validate"
        ? "You may use the provided finite validation tools. Your result is advisory until the parent validates the final mutation."
        : "Use only the provided read/search tools.",
      "When the bounded task is answered, return one concise final summary in ordinary text. Name every exact evidence id that supports the summary; uncited context cannot be adopted. There is no report tool.",
      input.ports.context.workspaceInstructionContext
        ? [
            "LIVE_WORKSPACE_INSTRUCTIONS:",
            input.ports.context.workspaceInstructionContext,
          ].join("\n")
        : "",
      context ? `PARENT_CONTEXT_CAPSULE:\n${context}` : "",
    ].filter(Boolean).join("\n"),
  }, {
    role: "user",
    content: input.job.objective,
  }];
  const inheritedEvidence = inheritedReviewEvidence(input.ports, input.job);
  const evidence: RuntimeV2EvidenceReference[] = [];
  const fingerprints = new Set(
    inheritedEvidence.map((item) =>
      `${item.kind}:${item.target}:${item.version || "unversioned"}`
    ),
  );
  let ordinal = 0;
  let recoveryLease: RuntimeV2ChildRecoveryStallLease | null = null;
  let recoveryStalled = false;
  try {
    while (!input.signal.aborted && Date.now() < deadlineAt) {
      let result: RuntimeV2NormalizedProviderResult;
      try {
        result = await requestChildStep({
          ...input,
          messages,
          tools,
          deadlineAt,
          recoveryOccurrence: recoveryLease?.occurrence || 0,
        });
      } catch (error) {
        if (
          evidence.length + inheritedEvidence.length > 0 &&
          !input.signal.aborted
        ) break;
        throw error;
      }
      const calls = result.toolCalls;
      if (calls.length === 0) {
        if (telemetry) telemetry.closedAt = input.ports.now();
        return completedChildResult({
          job: input.job,
          summary: result.visibleText || "",
          inheritedEvidence,
          evidence,
        });
      }
      const acceptedCalls = boundRuntimeV2ChildToolCalls(
        calls,
        completedRuntimeV2ProviderToolCallIdentities(messages),
      );
      const acceptedCallIds = new Set(
        acceptedCalls.map((call) => call.id),
      );
      messages.push({
        role: "assistant",
        content: result.visibleText || "",
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      });
      const parallelReadCount = runtimeV2ParallelReadCount(calls);
      let progressed = false;
      for (const call of calls) {
        if (!acceptedCallIds.has(call.id)) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content:
              "REPEATED_ACTION_REJECTED: this exact action already completed in the current child boundary. Use retained evidence, choose a different missing source, or conclude.",
          });
          continue;
        }
        if (!await childToolAllowed({
          job: input.job,
          ports: input.ports,
          name: call.name,
          args: { ...call.arguments },
        })) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content:
              "TOOL_BLOCKED: this action is outside the child's read-only scope. Choose an allowed bounded action or conclude from inherited evidence.",
          });
          continue;
        }
        try {
          const target = getToolTarget(
            call.name,
            call.arguments,
          ) || call.name;
          const rawOutput = await executeTool(
            call.name,
            runtimeV2ContextBoundToolArguments(
              call.name,
              { ...call.arguments },
              input.ports.context.runtimeContextBudget,
              { parallelReadCount },
            ),
            input.ports.context.runWorkspace || "",
            input.ports.context.runSessionKey,
            { toolCatalog: authorizationFor(input.ports).toolCatalog },
          );
          const output = runtimeV2ChildToolOutputContent(
            call.name,
            rawOutput,
            input.ports.context.runtimeContextBudget,
          );
          const isValidation = VALIDATION_CHILD_TOOL_NAMES.has(
            call.name,
          );
          const passed = isValidation
            ? isRuntimeV2ValidationPassed(call.name, rawOutput)
            : true;
          const version = isValidation
            ? runtimeV2ValidationEvidenceVersion(rawOutput)
            : runtimeV2EvidenceVersion(output);
          const fingerprint =
            `subagent:${target}:${version || "unversioned"}`;
          const isNewEvidence = !fingerprints.has(fingerprint);
          const childEvidence: RuntimeV2EvidenceReference | null =
            isNewEvidence
              ? {
                  id: `child:${input.job.id}:E${++ordinal}`,
                  kind: "subagent",
                  target,
                  version,
                }
              : null;
          if (childEvidence) {
            progressed = true;
            fingerprints.add(fingerprint);
            evidence.push(childEvidence);
            input.ports.logStoreEvent(
              "runtime_v2_subagent_evidence_recorded",
              {
                turnId: input.job.run.turnId,
                runId: input.job.run.runId,
                jobId: input.job.id,
                evidenceId: childEvidence.id,
                target,
                validationPassed: isValidation ? passed : null,
              },
            );
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: [
              childEvidence
                ? `CHILD_EVIDENCE_ID: ${childEvidence.id}`
                : "CHILD_EVIDENCE_REPEAT",
              `TARGET: ${target}`,
              isValidation
                ? `VALIDATION_PASSED: ${passed}`
                : "",
              output,
            ].filter(Boolean).join("\n"),
          });
        } catch (error) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `TOOL_FAILED: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }
      recoveryLease = advanceRuntimeV2ChildRecoveryStallLease({
        current: recoveryLease,
        progressed,
        now: input.ports.now(),
      });
      if (
        runtimeV2ChildRecoveryStallExpired(
          recoveryLease,
          input.ports.now(),
        )
      ) {
        recoveryStalled = true;
        input.ports.logStoreEvent(
          "runtime_v2_subagent_recovery_stall_reached",
          {
            turnId: input.job.run.turnId,
            runId: input.job.run.runId,
            jobId: input.job.id,
            occurrence: recoveryLease?.occurrence || 0,
            recoveryStartedAt: recoveryLease?.startedAt || null,
          },
        );
        break;
      }
    }
  } catch {
    const canceled = input.signal.aborted &&
      !(input.signal.reason instanceof RuntimeV2ChildDeadlineError);
    const status = canceled
      ? "canceled"
      : evidence.length > 0
        ? "degraded"
        : "failed";
    if (telemetry) telemetry.closedAt = input.ports.now();
    return {
      job: input.job,
      status,
      summary: runtimeV2SubagentFailureSummary({
        canceled,
        recoveryStalled,
        deadlineExceeded:
          input.signal.reason instanceof RuntimeV2ChildDeadlineError ||
          Date.now() >= deadlineAt,
        evidence,
      }),
      report: null,
      inheritedEvidence,
      evidence,
    };
  }
  const canceled = input.signal.aborted &&
    !(input.signal.reason instanceof RuntimeV2ChildDeadlineError);
  const status = canceled
    ? "canceled"
    : evidence.length > 0
      ? "degraded"
      : "failed";
  if (telemetry) telemetry.closedAt = input.ports.now();
  return {
    job: input.job,
    status,
    summary: runtimeV2SubagentFailureSummary({
      canceled,
      recoveryStalled,
      deadlineExceeded: !canceled && !recoveryStalled,
      evidence,
    }),
    report: null,
    inheritedEvidence,
    evidence,
  };
}

export async function startRuntimeV2ReadOnlyChild(
  input: RuntimeV2ExecutionPortsInput,
  job: RuntimeV2SubagentJob,
  parentSignal: AbortSignal,
): Promise<RuntimeV2ChildResult> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  input.live.childAbortControllers.set(job.id, controller);
  const deadlineAt = runtimeV2ChildDeadlineAt(
    input.lifecycleDeadlineAt,
  );
  const timeout = Number.isFinite(deadlineAt)
    ? setTimeout(() => {
        controller.abort(new RuntimeV2ChildDeadlineError(
          "Runtime v2 child deadline exceeded.",
        ));
      }, Math.max(1, deadlineAt - Date.now()))
    : null;
  try {
    return await runRuntimeV2Child({
      job,
      ports: input,
      signal: controller.signal,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
    input.live.childAbortControllers.delete(job.id);
  }
}
