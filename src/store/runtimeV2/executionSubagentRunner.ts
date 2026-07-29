import type { AgentMessage } from "../../lib/agentMessages";
import { deriveBudgetedStreamSettings } from "../../lib/providerLaneSettings";
import { boundRuntimeMessagesToContext } from "../../lib/runtimeContextBudget";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { streamChatCompletion } from "../../lib/streaming";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import { executeTool } from "../../lib/toolExecutor";
import { getToolTarget } from "../../lib/toolTarget";
import {
  allocateProviderAttemptTimeoutMs,
  compileRuntimeV2SubagentReport,
  normalizeProviderResponseV1,
  recordProviderTransportAttempt,
  runtimeV2EvidenceVersion,
  runtimeV2SubagentFailureSummary,
  selectNextProviderTransportAttempt,
  type RuntimeV2EvidenceReference,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2SubagentJob,
} from "../../lib/runtime-v2";
import { analyzeValidationCommand } from "../../lib/validationContract";
import {
  authorizationFor,
  authorizeToolForCurrentTurn,
  baseProviderProfile,
  boundedToolContent,
  childScopeAllows,
  compactTextEnvelopeCatalog,
  containsProviderTextEnvelopePrompt,
  runtimeV2ContextBoundToolArguments,
  type RuntimeV2ChildResult,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import { aggregateForCurrentTurn } from "./executionAggregate";
import {
  isRuntimeV2ValidationPassed,
  runtimeV2ValidationEvidenceVersion,
} from "./executionEvidence";
import { buildRuntimeV2SubagentContextCapsule } from "./executionSubagentContext";

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
const RUNTIME_V2_CHILD_DEADLINE_MS = 90_000;
const RUNTIME_V2_CHILD_SYNTHESIS_RESERVE_MS = 30_000;
const RUNTIME_V2_CHILD_SYNTHESIS_MAX_OUTPUT_TOKENS = 1_024;

export function runtimeV2ChildStepPhase(input: {
  readonly now: number;
  readonly deadlineAt: number;
  readonly evidenceCount: number;
}): "investigate" | "synthesize" | "expired" {
  if (input.now >= input.deadlineAt) return "expired";
  return input.evidenceCount > 0 &&
      input.deadlineAt - input.now <=
        RUNTIME_V2_CHILD_SYNTHESIS_RESERVE_MS
    ? "synthesize"
    : "investigate";
}

class RuntimeV2ChildProtocolError extends Error {}
class RuntimeV2ChildDeadlineError extends Error {}

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
  readonly requiresTool: boolean;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly maxOutputTokens?: number;
}): Promise<RuntimeV2NormalizedProviderResult> {
  const profile = {
    ...baseProviderProfile(input.ports.get()),
    requiredToolChoice: input.requiresTool,
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
    const hasFallback =
      selectNextProviderTransportAttempt(profile, epoch) !== null;
    const timeoutMs = allocateProviderAttemptTimeoutMs(
      remainingMs,
      hasFallback,
    );
    try {
      const requestMessages: AgentMessage[] = [
        ...input.messages,
        ...(attempt.textEnvelope
          ? [{
              role: "system" as const,
              content: containsProviderTextEnvelopePrompt(
                input.ports.context.phaseLanguage,
                input.requiresTool,
              ),
            }, {
              role: "system" as const,
              content: compactTextEnvelopeCatalog(input.tools),
            }]
          : []),
      ];
      const budget = input.ports.context.runtimeContextBudget;
      const maxOutputTokens = Math.min(
        input.maxOutputTokens ||
          4_096,
        budget?.outputBudget ?? 4_096,
      );
      const boundedRequestMessages = budget
        ? boundRuntimeMessagesToContext(requestMessages, {
            contextLimit: budget.contextLimit,
            reservedOutputTokens: maxOutputTokens,
          })
        : requestMessages;
      let streamedText = "";
      const wire = await streamChatCompletion(
        boundedRequestMessages,
        deriveBudgetedStreamSettings(
          input.ports.get().config,
          budget,
        ),
        {
          onToken: (token) => {
            streamedText += token;
            const telemetry =
              input.ports.live.childTelemetry.get(input.job.id);
            if (telemetry && telemetry.firstTokenAt === null) {
              telemetry.firstTokenAt = input.ports.now();
            }
          },
          onDone: () => undefined,
          onError: () => undefined,
        },
        input.signal,
        attempt.textEnvelope ? [] : [...input.tools],
        maxOutputTokens,
        {
          ...(attempt.toolChoice
            ? { toolChoice: attempt.toolChoice }
            : {}),
          timeoutMs,
        },
      );
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
        normalized.diagnostics.length > 0 ||
        (
          normalized.toolCalls.length === 0 &&
          (input.requiresTool || !visibleText)
        )
      ) {
        throw new RuntimeV2ChildProtocolError(
          unexpected.length > 0
            ? `child_tool_surface_rejected:${
                unexpected.map((call) => call.name).join(",")
              }`
            : normalized.toolCalls.length === 0
              ? "child_required_tool_missing"
              : "child_protocol_diagnostic",
        );
      }
      input.ports.logStoreEvent("runtime_v2_subagent_provider_result", {
        turnId: input.job.run.turnId,
        runId: input.job.run.runId,
        jobId: input.job.id,
        transport: attempt.variant,
        toolName: normalized.toolCalls[0]?.name || null,
        concluded: normalized.toolCalls.length === 0,
      });
      return {
        ...normalized,
        visibleText,
        toolCalls: normalized.toolCalls.slice(0, 1),
      };
    } catch (error) {
      lastError = error;
      input.ports.logStoreEvent(
        error instanceof RuntimeV2ChildProtocolError
          ? "runtime_v2_subagent_protocol_drift"
          : "runtime_v2_subagent_transport_failed",
        {
          turnId: input.job.run.turnId,
          runId: input.job.run.runId,
          jobId: input.job.id,
          transport: attempt.variant,
          error: error instanceof Error ? error.message : String(error),
        },
      );
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
  readonly evidence: readonly RuntimeV2EvidenceReference[];
}): RuntimeV2ChildResult {
  const report = compileRuntimeV2SubagentReport({
    draft: {
      summary: input.summary,
      findings: [{
        statement: input.summary,
        evidence_ids: input.evidence.map((item) => item.id),
      }],
      unresolved: [],
    },
    evidence: input.evidence,
  });
  return {
    job: input.job,
    status: "completed",
    summary: report.summary,
    report,
    evidence: input.evidence,
    validationReceipts: [],
  };
}

async function runRuntimeV2Child(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly signal: AbortSignal;
}): Promise<RuntimeV2ChildResult> {
  const telemetry = input.ports.live.childTelemetry.get(input.job.id);
  const tools = childTools(input.job);
  const context = buildRuntimeV2SubagentContextCapsule({
    aggregate: aggregateForCurrentTurn(input.ports),
    job: input.job,
    modelContext: input.ports.live.modelContext,
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
  const deadlineAt = Math.min(
    Date.now() + RUNTIME_V2_CHILD_DEADLINE_MS,
    input.ports.lifecycleDeadlineAt || Number.POSITIVE_INFINITY,
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
      "When the bounded task is answered, return one concise final summary in ordinary text. There is no report tool.",
      context ? `PARENT_CONTEXT_CAPSULE:\n${context}` : "",
    ].filter(Boolean).join("\n"),
  }, {
    role: "user",
    content: input.job.objective,
  }];
  const evidence = inheritedReviewEvidence(input.ports, input.job);
  const fingerprints = new Set(
    evidence.map((item) =>
      `${item.kind}:${item.target}:${item.version || "unversioned"}`
    ),
  );
  let ordinal = 0;
  try {
    while (!input.signal.aborted && Date.now() < deadlineAt) {
      const phase = runtimeV2ChildStepPhase({
        now: Date.now(),
        deadlineAt,
        evidenceCount: evidence.length,
      });
      if (phase !== "investigate") break;
      let result: RuntimeV2NormalizedProviderResult;
      try {
        result = await requestChildStep({
          ...input,
          messages,
          tools,
          requiresTool: evidence.length === 0,
          deadlineAt: evidence.length > 0
            ? deadlineAt - RUNTIME_V2_CHILD_SYNTHESIS_RESERVE_MS
            : deadlineAt,
        });
      } catch (error) {
        if (evidence.length > 0 && !input.signal.aborted) break;
        throw error;
      }
      const call = result.toolCalls[0];
      if (!call) {
        if (telemetry) telemetry.closedAt = input.ports.now();
        return completedChildResult({
          job: input.job,
          summary: result.visibleText || "",
          evidence,
        });
      }
      messages.push({
        role: "assistant",
        content: result.visibleText || "",
        tool_calls: [{
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        }],
      });
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
        const target = getToolTarget(call.name, call.arguments) || call.name;
        const rawOutput = await executeTool(
          call.name,
          runtimeV2ContextBoundToolArguments(
            call.name,
            { ...call.arguments },
            input.ports.context.runtimeContextBudget,
          ),
          input.ports.context.runWorkspace || "",
          input.ports.context.runSessionKey,
          { toolCatalog: authorizationFor(input.ports).toolCatalog },
        );
        const output = boundedToolContent(rawOutput, 8_000);
        const isValidation = VALIDATION_CHILD_TOOL_NAMES.has(call.name);
        const passed = isValidation
          ? isRuntimeV2ValidationPassed(call.name, rawOutput)
          : true;
        const version = isValidation
          ? runtimeV2ValidationEvidenceVersion(rawOutput)
          : runtimeV2EvidenceVersion(output);
        const fingerprint =
          `subagent:${target}:${version || "unversioned"}`;
        const isNewEvidence = !fingerprints.has(fingerprint);
        const childEvidence: RuntimeV2EvidenceReference | null = isNewEvidence
          ? {
              id: `child:${input.job.id}:E${++ordinal}`,
              kind: "subagent",
              target,
              version,
            }
          : null;
        if (childEvidence) {
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
            isValidation ? `VALIDATION_PASSED: ${passed}` : "",
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
    if (
      evidence.length > 0 &&
      !input.signal.aborted &&
      Date.now() < deadlineAt
    ) {
      messages.push({
        role: "system",
        content: [
          "The investigation window is closed. Do not call another tool.",
          "Return one concise final summary now. Cite the CHILD_EVIDENCE_ID values already present in the transcript, distinguish findings from unresolved questions, and do not claim a mutation.",
        ].join(" "),
      });
      const result = await requestChildStep({
        ...input,
        messages,
        tools: [],
        requiresTool: false,
        deadlineAt,
        maxOutputTokens: RUNTIME_V2_CHILD_SYNTHESIS_MAX_OUTPUT_TOKENS,
      });
      if (telemetry) telemetry.closedAt = input.ports.now();
      return completedChildResult({
        job: input.job,
        summary: result.visibleText || "",
        evidence,
      });
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
        deadlineExceeded:
          input.signal.reason instanceof RuntimeV2ChildDeadlineError ||
          Date.now() >= deadlineAt,
        evidence,
      }),
      report: null,
      evidence,
      validationReceipts: [],
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
      deadlineExceeded: !canceled,
      evidence,
    }),
    report: null,
    evidence,
    validationReceipts: [],
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
  const deadlineMs = Math.max(
    1,
    Math.min(
      RUNTIME_V2_CHILD_DEADLINE_MS,
      (input.lifecycleDeadlineAt || Number.POSITIVE_INFINITY) - Date.now(),
    ),
  );
  const timeout = setTimeout(() => {
    controller.abort(new RuntimeV2ChildDeadlineError(
      "Runtime v2 child deadline exceeded.",
    ));
  }, deadlineMs);
  try {
    return await runRuntimeV2Child({
      job,
      ports: input,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
    input.live.childAbortControllers.delete(job.id);
  }
}
