import type { AgentMessage } from "../../lib/agentMessages";
import { executeTool } from "../../lib/toolExecutor";
import { getToolTarget } from "../../lib/toolTarget";
import {
  advanceRuntimeV2ChildRecoveryStallLease,
  compileRuntimeV2SubagentTextReport,
  runtimeV2ChildRecoveryStallExpired,
  runtimeV2EvidenceVersion,
  runtimeV2SubagentFailureSummary,
  type RuntimeV2EvidenceReference,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2ChildRecoveryStallLease,
  type RuntimeV2SubagentJob,
} from "../../lib/runtime-v2";
import { analyzeValidationCommand } from "../../lib/validationContract";
import {
  authorizationFor,
  authorizeToolForCurrentTurn,
  childScopeAllows,
  runtimeV2ContextBoundToolArguments,
  runtimeV2ParallelReadCount,
  type RuntimeV2ChildResult,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import type { RuntimeV2StagedChildMutation } from "./executionTypes";
import { aggregateForCurrentTurn } from "./executionAggregate";
import {
  deriveRuntimeV2ProviderEffectFacts,
} from "./executionProviderEffectFacts";
import {
  isRuntimeV2ValidationPassed,
  runtimeV2ValidationEvidenceVersion,
} from "./executionEvidence";
import {
  buildRuntimeV2SubagentContextCapsule,
  runtimeV2SubagentInheritedSourceTargets,
} from "./executionSubagentContext";
import { stageRuntimeV2ChildMutation } from "./executionSubagentMutation";
import {
  normalizedRuntimeV2SubagentPath,
} from "./executionSubagentWriteScope";
import {
  completedRuntimeV2ProviderToolCallIdentities,
  runtimeV2ProviderToolCallIdentity,
} from "./providerToolSurface";
import {
  boundRuntimeV2ChildToolCalls,
  MUTATION_CHILD_TOOL_NAMES,
  READ_ONLY_CHILD_TOOL_NAMES,
  runtimeV2ChildClosedActionLoopDetected,
  runtimeV2ChildClosedObservationLoopDetected,
  runtimeV2ChildDeadlineAt,
  runtimeV2ChildDeadlineExceeded,
  runtimeV2ChildToolOutputContent,
  runtimeV2ChildTools,
  RuntimeV2ChildDeadlineError,
  VALIDATION_CHILD_TOOL_NAMES,
} from "./executionSubagentPolicy";
import { requestRuntimeV2ChildStep } from "./executionSubagentProvider";

export {
  boundRuntimeV2ChildToolCalls,
  normalizeRuntimeV2ChildToolCalls,
  runtimeV2ChildClosedActionLoopDetected,
  runtimeV2ChildClosedObservationLoopDetected,
  runtimeV2ChildDeadlineAt,
  runtimeV2ChildDeadlineExceeded,
  runtimeV2ChildOutputTokenLimit,
  runtimeV2ChildToolOutputContent,
} from "./executionSubagentPolicy";

async function childToolAllowed(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly name: string;
  readonly args: Record<string, unknown>;
}): Promise<boolean> {
  if (READ_ONLY_CHILD_TOOL_NAMES.has(input.name)) {
    return childScopeAllows(input.job, input.args);
  }
  if (MUTATION_CHILD_TOOL_NAMES.has(input.name)) {
    return input.job.taskKind === "implement" &&
      input.job.accessMode === "write";
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
  readonly stagedMutations: readonly RuntimeV2StagedChildMutation[];
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
    stagedMutations: input.stagedMutations,
  };
}

async function runRuntimeV2Child(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly signal: AbortSignal;
}): Promise<RuntimeV2ChildResult> {
  const telemetry = input.ports.live.childTelemetry.get(input.job.id);
  const tools = runtimeV2ChildTools(input.job);
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
    scopeKey: input.job.scopeKey,
    taskKind: input.job.taskKind || "explore",
    accessMode: input.job.accessMode || "read",
    implementationOperation: input.job.implementationOperation || null,
    implementationPlan:
      input.job.implementationPlan?.slice(0, 2_000) || null,
    objective: input.job.objective.slice(0, 1_000),
    allowedPaths: input.job.allowedPaths,
    parentContextChars: context.length,
    inheritedContext: context.length > 0,
  });
  const deadlineAt = runtimeV2ChildDeadlineAt(
    input.ports.lifecycleDeadlineAt,
  );
  const messages: AgentMessage[] = [{
    role: "system",
    content: [
      input.job.taskKind === "implement"
        ? "You are a transaction-scoped implementation child of the current MAIN turn."
        : "You are a read-only child of the current MAIN turn.",
      `Task kind: ${input.job.taskKind || "explore"}`,
      `Access mode: ${input.job.accessMode || "read"}`,
      `Role: ${input.job.role || (input.job.taskKind === "implement" ? "implementation owner" : "read-only reviewer")}`,
      `Allowed paths: ${input.job.allowedPaths.join(", ")}`,
      input.job.implementationOperation
        ? `Implementation operation: ${input.job.implementationOperation}`
        : "",
      input.job.implementationPlan
        ? `Parent implementation plan: ${input.job.implementationPlan}`
        : "",
      input.job.successCriteria
        ? `Success criteria: ${input.job.successCriteria}`
        : "",
      input.job.taskKind === "implement"
        ? "You may submit exactly one provided mutation tool call matching the assigned operation and exclusive paths. Runtime stages it without changing the live workspace; after CHILD_MUTATION_STAGED, cite its evidence id and conclude. Do not broaden or redesign the parent plan."
        : "This child is read-only. Never request or simulate file changes.",
      "Use the parent context as current context; do not reread an unchanged fact merely to reconstruct the task.",
      input.job.taskKind === "validate"
        ? "You may use the provided finite validation tools. Your result is advisory until the parent validates the final mutation."
        : input.job.taskKind === "implement"
          ? "Use the provided read/search tools only for the assigned source, then stage one coherent mutation transaction. Final project validation remains the parent's responsibility."
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
  const stagedMutations: RuntimeV2StagedChildMutation[] = [];
  const observedTargets = new Set(
    runtimeV2SubagentInheritedSourceTargets({
      messages: input.ports.live.messages,
      effectFacts: deriveRuntimeV2ProviderEffectFacts(aggregate),
      workspace: input.ports.context.runWorkspace || "",
      allowedPaths: input.job.allowedPaths,
    }).map(normalizedRuntimeV2SubagentPath),
  );
  const fingerprints = new Set(
    inheritedEvidence.map((item) =>
      `${item.kind}:${item.target}:${item.version || "unversioned"}`
    ),
  );
  let ordinal = 0;
  let recoveryLease: RuntimeV2ChildRecoveryStallLease | null = null;
  let recoveryStalled = false;
  const rejectedClosedActionIdentities = new Set<string>();
  const rejectedClosedObservationFingerprints = new Set<string>();
  try {
    while (!input.signal.aborted && Date.now() < deadlineAt) {
      let result: RuntimeV2NormalizedProviderResult;
      try {
        result = await requestRuntimeV2ChildStep({
          ...input,
          messages,
          tools: stagedMutations.length > 0 ? [] : tools,
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
          stagedMutations,
        });
      }
      const acceptedCalls = boundRuntimeV2ChildToolCalls(
        calls,
        completedRuntimeV2ProviderToolCallIdentities(messages),
      );
      const acceptedCallIds = new Set(
        acceptedCalls.map((call) => call.id),
      );
      const closedActionLoopDetected =
        runtimeV2ChildClosedActionLoopDetected({
          calls,
          acceptedCallIds,
          previouslyRejectedIdentities:
            rejectedClosedActionIdentities,
        });
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
      let closedObservationLoopDetected = false;
      for (const call of calls) {
        if (!acceptedCallIds.has(call.id)) {
          rejectedClosedActionIdentities.add(
            runtimeV2ProviderToolCallIdentity(call),
          );
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
        if (MUTATION_CHILD_TOOL_NAMES.has(call.name)) {
          if (stagedMutations.length > 0) {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content:
                "CHILD_MUTATION_REJECTED: this implementation child already staged its one transaction. Cite the retained evidence id and conclude.",
            });
            continue;
          }
          const evidenceId = `child:${input.job.id}:E${++ordinal}`;
          const stage = await stageRuntimeV2ChildMutation({
            ports: input.ports,
            job: input.job,
            call,
            observedTargets,
            evidenceId,
          });
          if (!stage.allowed || !stage.staged) {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: stage.message,
            });
            continue;
          }
          stagedMutations.push(stage.staged);
          const stagedEvidence: RuntimeV2EvidenceReference = {
            id: evidenceId,
            kind: "subagent",
            target: stage.staged.targets.join(", "),
            version: `staged:${runtimeV2EvidenceVersion(JSON.stringify({
              toolName: stage.staged.toolName,
              targets: stage.staged.targets,
              baseVersions: stage.staged.baseVersions,
            }))}`,
          };
          evidence.push(stagedEvidence);
          fingerprints.add(
            `${stagedEvidence.kind}:${stagedEvidence.target}:${stagedEvidence.version}`,
          );
          progressed = true;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: stage.message,
          });
          input.ports.logStoreEvent(
            "runtime_v2_subagent_mutation_staged",
            {
              turnId: input.job.run.turnId,
              runId: input.job.run.runId,
              jobId: input.job.id,
              evidenceId,
              operation: input.job.implementationOperation,
              toolName: stage.staged.toolName,
              targets: stage.staged.targets,
            },
          );
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
          if (call.name === "read_file") {
            observedTargets.add(normalizedRuntimeV2SubagentPath(target));
          }
          const isNewEvidence = !fingerprints.has(fingerprint);
          if (
            runtimeV2ChildClosedObservationLoopDetected({
              fingerprint,
              isNewEvidence,
              previouslyRejectedFingerprints:
                rejectedClosedObservationFingerprints,
            })
          ) {
            closedObservationLoopDetected = true;
          }
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
            rejectedClosedObservationFingerprints.clear();
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
          } else {
            rejectedClosedObservationFingerprints.add(fingerprint);
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
              childEvidence
                ? output
                : [
                    `VERSION: ${version || "unversioned"}`,
                    "The unchanged result is already retained in this child context; use it or conclude instead of rereading it.",
                  ].join("\n"),
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
      if (closedActionLoopDetected || closedObservationLoopDetected) {
        recoveryStalled = true;
        input.ports.logStoreEvent(
          closedObservationLoopDetected
            ? "runtime_v2_subagent_closed_observation_loop"
            : "runtime_v2_subagent_closed_action_loop",
          {
            turnId: input.job.run.turnId,
            runId: input.job.run.runId,
            jobId: input.job.id,
            actionIdentities: calls.map(
              runtimeV2ProviderToolCallIdentity,
            ),
            closedObservationLoopDetected,
            evidenceCount: evidence.length,
          },
        );
        break;
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
    const deadlineExceeded = runtimeV2ChildDeadlineExceeded({
      signal: input.signal,
      deadlineAt,
    });
    const canceled = input.signal.aborted && !deadlineExceeded;
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
        deadlineExceeded,
        evidence,
      }),
      report: null,
      inheritedEvidence,
      evidence,
    };
  }
  const deadlineExceeded = runtimeV2ChildDeadlineExceeded({
    signal: input.signal,
    deadlineAt,
  });
  const canceled = input.signal.aborted && !deadlineExceeded;
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
      deadlineExceeded,
      evidence,
    }),
    report: null,
    inheritedEvidence,
    evidence,
  };
}

export async function startRuntimeV2Child(
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

/** Compatibility alias for callers persisted before implement/write jobs. */
export const startRuntimeV2ReadOnlyChild = startRuntimeV2Child;
