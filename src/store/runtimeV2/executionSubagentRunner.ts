import type { AgentMessage } from "../../lib/agentMessages";
import { deriveStreamSettings } from "../../lib/providerLaneSettings";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { streamChatCompletion } from "../../lib/streaming";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import { executeTool } from "../../lib/toolExecutor";
import { getToolTarget } from "../../lib/toolTarget";
import {
  allocateProviderAttemptTimeoutMs,
  compileRuntimeV2SubagentReport,
  deriveRuntimeV2ValidationBoundary,
  normalizeProviderResponseV1,
  recordProviderTransportAttempt,
  resolveRuntimeV2ExecutionContractValidation,
  resolveRuntimeV2PlanValidationScope,
  RUNTIME_V2_SUBAGENT_VALIDATION_RECEIPT_SCHEMA_VERSION,
  runtimeV2SubagentFailureSummary,
  runtimeV2ExecutionValidationAuthority,
  runtimeV2EvidenceVersion,
  runtimeV2PlanValidationAuthority,
  selectNextProviderTransportAttempt,
  shouldRequestRuntimeV2SubagentReport,
  type RuntimeV2EvidenceReference,
  type RuntimeV2ExecutionValidationAuthority,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2SubagentJob,
  type RuntimeV2SubagentValidationReceiptV1,
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
  type RuntimeV2ChildResult,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import { aggregateForCurrentTurn } from "./executionAggregate";
import {
  isRuntimeV2ValidationPassed,
  runtimeV2ValidationEvidenceVersion,
} from "./executionEvidence";
import {
  buildRuntimeV2SubagentContextCapsule,
} from "./executionSubagentContext";

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
const SUBMIT_SUBAGENT_REPORT_TOOL_NAME = "submit_subagent_report";
const SUBMIT_SUBAGENT_REPORT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: SUBMIT_SUBAGENT_REPORT_TOOL_NAME,
    description:
      "Submit the final structured child report. Every finding must cite evidence ids returned by successful child tools. This is the only path to completed status.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        findings: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              statement: { type: "string" },
              evidence_ids: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
              },
            },
            required: ["statement", "evidence_ids"],
          },
        },
        unresolved: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["summary", "findings", "unresolved"],
    },
  },
};
const READ_ONLY_CHILD_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(
  (definition) =>
    READ_ONLY_CHILD_TOOL_NAMES.has(definition.function.name),
);
const VALIDATION_CHILD_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(
  (definition) =>
    VALIDATION_CHILD_TOOL_NAMES.has(definition.function.name),
);
const RUNTIME_V2_CHILD_DEADLINE_MS = 90_000;

class RuntimeV2ChildProtocolDriftError extends Error {}
class RuntimeV2ChildDeadlineError extends Error {}

function childToolDefinitions(job: RuntimeV2SubagentJob): ToolDefinition[] {
  return [
    ...READ_ONLY_CHILD_TOOL_DEFINITIONS,
    ...(job.taskKind === "validate"
      ? VALIDATION_CHILD_TOOL_DEFINITIONS
      : []),
    SUBMIT_SUBAGENT_REPORT_TOOL,
  ];
}

function resolveChildValidationAuthority(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}): RuntimeV2ExecutionValidationAuthority | null {
  const aggregate = aggregateForCurrentTurn(input.ports);
  if (!aggregate) return null;
  if (
    aggregate.strategy === "execute" &&
    aggregate.executionContract?.status === "active"
  ) {
    const validation = resolveRuntimeV2ExecutionContractValidation({
      contract: aggregate.executionContract,
      toolName: input.toolName,
      args: input.args,
    });
    return validation
      ? runtimeV2ExecutionValidationAuthority({
          contract: aggregate.executionContract,
          validation,
        })
      : null;
  }
  if (
    aggregate.strategy === "plan" &&
    aggregate.workPlan?.status === "approved" &&
    aggregate.sealedWorkPlan
  ) {
    const scope = resolveRuntimeV2PlanValidationScope({
      plan: aggregate.sealedWorkPlan,
      toolName: input.toolName,
      args: input.args,
    });
    const validationIndex = scope.matchingValidationIndexes[0];
    return validationIndex === undefined
      ? null
      : runtimeV2PlanValidationAuthority({
          plan: aggregate.sealedWorkPlan,
          validationIndex,
        });
  }
  return null;
}

function childExecutionValidationPrimitive(
  ports: RuntimeV2ExecutionPortsInput,
  authority: RuntimeV2ExecutionValidationAuthority,
) {
  const aggregate = aggregateForCurrentTurn(ports);
  const contract = aggregate?.executionContract;
  if (
    authority.kind !== "execution_contract" ||
    !contract ||
    contract.status !== "active" ||
    authority.id !== contract.id ||
    authority.revision !== contract.revision ||
    authority.digest !== contract.digest
  ) {
    return undefined;
  }
  return contract.validations.find((validation) =>
    validation.id === authority.validationId
  )?.primitive;
}

async function admitChildTool(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}): Promise<{
  readonly allowed: boolean;
  readonly validationAuthority: RuntimeV2ExecutionValidationAuthority | null;
}> {
  if (READ_ONLY_CHILD_TOOL_NAMES.has(input.toolName)) {
    return {
      allowed: childScopeAllows(input.job, input.args),
      validationAuthority: null,
    };
  }
  if (
    input.job.taskKind !== "validate" ||
    !VALIDATION_CHILD_TOOL_NAMES.has(input.toolName)
  ) {
    return { allowed: false, validationAuthority: null };
  }
  if (input.toolName === "run_command") {
    const analysis = analyzeValidationCommand(
      String(input.args.command ?? input.args.cmd ?? ""),
      {
        cwd: String(input.args.cwd ?? input.args.workdir ?? "."),
      },
    );
    if (
      analysis.spec?.kind !== "finite_command" ||
      !childScopeAllows(input.job, {
        cwd: analysis.spec.cwd || ".",
      })
    ) {
      return { allowed: false, validationAuthority: null };
    }
  }
  const validationAuthority = resolveChildValidationAuthority(input);
  if (!validationAuthority) {
    return { allowed: false, validationAuthority: null };
  }
  const authorization = await authorizeToolForCurrentTurn(
    input.ports,
    input.toolName,
    input.args,
  );
  return {
    allowed: authorization.allowed,
    validationAuthority: authorization.allowed
      ? validationAuthority
      : null,
  };
}

async function requestReadOnlyChildAction(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}): Promise<RuntimeV2NormalizedProviderResult> {
  const profile = {
    ...baseProviderProfile(input.ports.get()),
    requiredToolChoice: true,
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
  let protocolOnly = true;
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
                true,
              ),
            }, {
              role: "system" as const,
              content: compactTextEnvelopeCatalog(input.tools),
            }]
          : []),
      ];
      let streamedText = "";
      const wire = await streamChatCompletion(
        requestMessages,
        deriveStreamSettings(input.ports.get().config),
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
        4_096,
        {
          ...(attempt.toolChoice
            ? { toolChoice: attempt.toolChoice }
            : {}),
          timeoutMs,
        },
      );
      const protocolContent =
        wire.actionableContent || wire.content || streamedText;
      const normalized = normalizeProviderResponseV1({
        visibleText: wire.semanticContent || streamedText,
        content: protocolContent,
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
      const allowedNames = new Set(
        input.tools.map((tool) => tool.function.name),
      );
      const unexpected = normalized.toolCalls.filter(
        (call) => !allowedNames.has(call.name),
      );
      if (
        normalized.toolCalls.length === 0 ||
        unexpected.length > 0 ||
        normalized.diagnostics.length > 0
      ) {
        throw new RuntimeV2ChildProtocolDriftError(
          normalized.toolCalls.length === 0
            ? "child_required_tool_missing"
            : unexpected.length > 0
              ? `child_tool_surface_rejected:${
                  unexpected.map((call) => call.name).join(",")
                }`
              : `child_protocol_diagnostic:${
                  normalized.diagnostics
                    .map((diagnostic) => diagnostic.code).join(",")
                }`,
        );
      }
      input.ports.logStoreEvent("runtime_v2_subagent_provider_result", {
        turnId: input.job.run.turnId,
        runId: input.job.run.runId,
        jobId: input.job.id,
        transport: attempt.variant,
        toolName: normalized.toolCalls[0]!.name,
      });
      return {
        ...normalized,
        toolCalls: normalized.toolCalls.slice(0, 1),
      };
    } catch (error) {
      lastError = error;
      if (!(error instanceof RuntimeV2ChildProtocolDriftError)) {
        protocolOnly = false;
      }
      input.ports.logStoreEvent(
        error instanceof RuntimeV2ChildProtocolDriftError
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
  if (protocolOnly) {
    throw new RuntimeV2ChildProtocolDriftError(
      lastError instanceof Error
        ? lastError.message
        : "child_provider_protocol_unavailable",
    );
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Runtime v2 child provider transports exhausted.");
}

async function runRuntimeV2Child(input: {
  job: RuntimeV2SubagentJob;
  ports: RuntimeV2ExecutionPortsInput;
  signal: AbortSignal;
}): Promise<RuntimeV2ChildResult> {
  const telemetry = input.ports.live.childTelemetry.get(input.job.id);
  const language =
    input.ports.context.phaseLanguage === "en" ? "English" : "简体中文";
  const tools = childToolDefinitions(input.job);
  const parentContextCapsule = buildRuntimeV2SubagentContextCapsule({
    aggregate: aggregateForCurrentTurn(input.ports),
    job: input.job,
    modelContext: input.ports.live.modelContext,
  });
  input.ports.logStoreEvent("runtime_v2_subagent_context_handoff", {
    turnId: input.job.run.turnId,
    runId: input.job.parentRunId,
    childRunId: input.job.run.runId,
    jobId: input.job.id,
    taskKind: input.job.taskKind || "explore",
    parentContextChars: parentContextCapsule.length,
    inheritedContext: parentContextCapsule.length > 0,
  });
  const deadlineAt = Math.min(
    Date.now() + RUNTIME_V2_CHILD_DEADLINE_MS,
    input.ports.lifecycleDeadlineAt || Number.POSITIVE_INFINITY,
  );
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: [
        "You are a read-only child in MAIN Runtime v2.",
        `Task kind: ${input.job.taskKind || "explore"}`,
        `Name: ${input.job.name || input.job.scopeKey}`,
        `Role: ${input.job.role || "read-only investigator"}`,
        `Scope key: ${input.job.scopeKey}`,
        `Allowed paths: ${input.job.allowedPaths.join(", ")}`,
        input.job.successCriteria
          ? `Success criteria: ${input.job.successCriteria}`
          : "",
        input.job.expectedOutput
          ? `Expected output: ${input.job.expectedOutput}`
          : "",
        "The parent is the only writer. Never request or simulate a file mutation.",
        input.job.taskKind === "validate"
          ? "You may run only a finite validator already declared by the active parent execution authority."
          : "Use only the provided read/search tools.",
        parentContextCapsule
          ? [
              "PARENT_CONTEXT_CAPSULE follows. It is the current handoff, not child-owned evidence.",
              "Do not restart a workspace survey or reread facts already present in this capsule. Use it to identify the smallest missing independent fact.",
              "PARENT_CONTEXT_ONLY_NOT_CITABLE: report findings must still cite at least one new CHILD_EVIDENCE_ID produced by this child.",
              parentContextCapsule,
            ].join("\n")
          : "",
        "Every successful tool result returns an evidence id. Finish only by calling submit_subagent_report; every finding must cite real ids from this child. Include an unresolved array, even when empty.",
        `Write report content in ${language}.`,
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: input.job.objective },
  ];
  const evidence: RuntimeV2EvidenceReference[] = [];
  const validationReceipts: RuntimeV2SubagentValidationReceiptV1[] = [];
  const evidenceFingerprints = new Set<string>();
  let evidenceOrdinal = 0;
  let reportModeAnnounced = false;
  try {
    while (!input.signal.aborted && Date.now() < deadlineAt) {
      const reportOnly = shouldRequestRuntimeV2SubagentReport({
        evidenceCount: evidence.length,
      });
      if (reportOnly && !reportModeAnnounced) {
        reportModeAnnounced = true;
        messages.push({
          role: "system",
          content: [
            "CHILD_REPORT_REQUIRED: this bounded child probe now has independent evidence.",
            "Stop investigating. Call submit_subagent_report now using only CHILD_EVIDENCE_ID values already returned by successful tools; do not reread the parent handoff or widen scope.",
            "List anything still unknown in unresolved; do not perform another read or search.",
          ].join(" "),
        });
        input.ports.logStoreEvent(
          "runtime_v2_subagent_report_mode_entered",
          {
            turnId: input.job.run.turnId,
            runId: input.job.run.runId,
            jobId: input.job.id,
            evidenceCount: evidence.length,
            parentRequested:
              input.ports.live.childReportRequests?.has(input.job.id) ===
                true,
            reason: "first_independent_evidence",
          },
        );
      }
      let result: RuntimeV2NormalizedProviderResult;
      try {
        result = await requestReadOnlyChildAction({
          ...input,
          messages,
          tools: reportOnly
            ? [SUBMIT_SUBAGENT_REPORT_TOOL]
            : tools,
          deadlineAt,
        });
      } catch (error) {
        if (!(error instanceof RuntimeV2ChildProtocolDriftError)) throw error;
        // requestReadOnlyChildAction already exhausted every compatible
        // transport for this structural action. Restarting the same epoch
        // merely makes a failed child consume its whole lifecycle while the
        // parent waits. Fail this child truthfully and let the parent continue.
        throw error;
      }
      const call = result.toolCalls[0]!;
      messages.push({
        role: "assistant",
        content: sanitizeAssistantDisplayContent(
          result.visibleText || "",
        ),
        tool_calls: [{
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        }],
      });
      if (call.name === SUBMIT_SUBAGENT_REPORT_TOOL_NAME) {
        try {
          const report = compileRuntimeV2SubagentReport({
            draft: call.arguments,
            evidence,
          });
          if (telemetry) telemetry.closedAt = input.ports.now();
          return {
            job: input.job,
            status: "completed",
            summary: report.summary,
            report,
            evidence,
            validationReceipts,
          };
        } catch (error) {
          throw new RuntimeV2ChildProtocolDriftError(
            `SUBAGENT_REPORT_REJECTED: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const admission = await admitChildTool({
        job: input.job,
        ports: input.ports,
        toolName: call.name,
        args: { ...call.arguments },
      });
      if (!admission.allowed) {
        throw new RuntimeV2ChildProtocolDriftError(
          `CHILD_SCOPE_BLOCKED:${call.name}`,
        );
      }
      try {
        const target = getToolTarget(call.name, call.arguments) ||
          call.name;
        const aggregate = admission.validationAuthority
          ? aggregateForCurrentTurn(input.ports)
          : null;
        const validationBoundary =
          admission.validationAuthority && aggregate
            ? deriveRuntimeV2ValidationBoundary(
                aggregate,
                admission.validationAuthority.targetPaths,
              )
            : null;
        const startedAt = input.ports.now();
        const rawOutput = await executeTool(
          call.name,
          { ...call.arguments },
          input.ports.context.runWorkspace || "",
          input.ports.context.runSessionKey,
          { toolCatalog: authorizationFor(input.ports).toolCatalog },
        );
        const completedAt = input.ports.now();
        const output = boundedToolContent(rawOutput, 8_000);
        const validationCall = !!(
          admission.validationAuthority && validationBoundary
        );
        const childEvidence: RuntimeV2EvidenceReference = {
          id: `child:${input.job.id}:E${++evidenceOrdinal}`,
          kind: validationCall ? "validation" : "subagent",
          target,
          version: validationCall
            ? runtimeV2ValidationEvidenceVersion(rawOutput)
            : runtimeV2EvidenceVersion(output),
        };
        const evidenceFingerprint = [
          childEvidence.kind,
          childEvidence.target,
          childEvidence.version || "unversioned",
        ].join(":");
        if (evidenceFingerprints.has(evidenceFingerprint)) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: [
              "CHILD_EVIDENCE_REPEAT: this target returned the same committed version already held by the child.",
              "No new evidence id was created. Submit the structured report using the existing CHILD_EVIDENCE_ID and list unresolved work instead of repeating the tool.",
            ].join(" "),
          });
          continue;
        }
        evidenceFingerprints.add(evidenceFingerprint);
        evidence.push(childEvidence);
        input.ports.logStoreEvent(
          "runtime_v2_subagent_evidence_recorded",
          {
            turnId: input.job.run.turnId,
            runId: input.job.run.runId,
            jobId: input.job.id,
            evidenceId: childEvidence.id,
            evidenceKind: childEvidence.kind,
            target: childEvidence.target,
            evidenceCount: evidence.length,
          },
        );
        if (admission.validationAuthority && validationBoundary) {
          validationReceipts.push({
            schemaVersion:
              RUNTIME_V2_SUBAGENT_VALIDATION_RECEIPT_SCHEMA_VERSION,
            evidenceId: childEvidence.id,
            passed: isRuntimeV2ValidationPassed(
              call.name,
              rawOutput,
              childExecutionValidationPrimitive(
                input.ports,
                admission.validationAuthority,
              ),
            ),
            authority: admission.validationAuthority,
            ...validationBoundary,
            startedAt,
            completedAt,
          });
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: [
            `CHILD_EVIDENCE_ID: ${childEvidence.id}`,
            `TARGET: ${childEvidence.target}`,
            `VERSION: ${childEvidence.version}`,
            output,
          ].join("\n"),
        });
      } catch (error) {
        throw new Error(
          `CHILD_TOOL_ERROR:${call.name}:${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (telemetry) telemetry.closedAt = input.ports.now();
    const canceled = input.signal.aborted &&
      !(input.signal.reason instanceof RuntimeV2ChildDeadlineError);
    const deadlineExceeded =
      input.signal.reason instanceof RuntimeV2ChildDeadlineError ||
      Date.now() >= deadlineAt;
    return {
      job: input.job,
      status: canceled ? "canceled" : "failed",
      summary: runtimeV2SubagentFailureSummary({
        canceled,
        deadlineExceeded,
        evidence,
      }),
      report: null,
      evidence,
      validationReceipts,
    };
  } catch (error) {
    if (telemetry) telemetry.closedAt = input.ports.now();
    const canceled = input.signal.aborted &&
      !(input.signal.reason instanceof RuntimeV2ChildDeadlineError);
    return {
      job: input.job,
      status: canceled ? "canceled" : "failed",
      summary: canceled
        ? runtimeV2SubagentFailureSummary({
            canceled: true,
            deadlineExceeded: false,
            evidence,
          })
        : [
            runtimeV2SubagentFailureSummary({
              canceled: false,
              deadlineExceeded:
                input.signal.reason instanceof
                  RuntimeV2ChildDeadlineError,
              evidence,
            }),
            `失败原因：${
              error instanceof Error ? error.message : String(error)
            }`,
          ].join(" ").slice(0, 2_000),
      report: null,
      evidence,
      validationReceipts,
    };
  }
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
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new RuntimeV2ChildDeadlineError(
        "Runtime v2 child deadline exceeded.",
      ),
    );
  }, deadlineMs);
  try {
    return await runRuntimeV2Child({
      job,
      ports: input,
      signal: controller.signal,
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    parentSignal.removeEventListener("abort", abortFromParent);
    input.live.childAbortControllers.delete(job.id);
    input.live.childReportRequests?.delete(job.id);
  }
}
