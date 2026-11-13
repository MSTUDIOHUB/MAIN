import type { RuntimeV2Command, RuntimeV2EventDraft, RuntimeV2ExecutionValidationAuthority } from "../../lib/runtime-v2";
import { runtimeV2ToolApprovalCapability, runtimeV2ToolCapabilityRestriction } from "./executionAuthorizationContext";
import { recordToolResultHistory, toolCompletionFor } from "./executionEvidence";
import { interruptedRuntimeV2ShellBatchReceipt } from "./executionSequentialShellBatchReceipt";
import type { RuntimeV2PlanToolAuthorizationResult } from "./executionPlanAuthorization";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import { isWorkspaceMutationToolName, resolveWorkspaceMutationRequests } from "../../lib/workspaceMutationTools";
import { checkCarriedWorkPlanTargets } from "./approvedPlanContinuation";
import { aggregateForCurrentTurn } from "./executionAggregate";
import { deriveUnityCompilation, unityCompilationMessage, unityCompilationTarget, type ApprovedPlanExecutionRepair } from "../../lib/runtime-v2/unityCompilation";
import { projectEditorPlayModeFilter, unityCommandArguments } from "../../lib/unityValidation";
import { unityValidationInvocations } from "../../lib/validationContract";
import { readFileWindow } from "../../lib/ipc";

export async function projectValidationManifestDriftReceipt(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly signal: AbortSignal;
}): Promise<RuntimeV2EventDraft | null> {
  const { ports, command, toolName, args, target, signal } = input;
  const expected = command.payload.projectValidationManifestVersion;
  if (command.kind !== "execute_validation" || toolName !== "run_command" || typeof expected !== "string") return null;
  signal.throwIfAborted();
  const workspace = ports.context.runWorkspace;
  const current = workspace ? await readFileWindow("package.json", workspace, 1, 1, 1, 1).catch(() => null) : null;
  signal.throwIfAborted();
  if (current?.contentVersion === expected) return null;
  const message = "PROJECT_VALIDATION_MANIFEST_CHANGED: Re-read package.json and confirm the current validation entry.";
  const receipt = toolCompletionFor(ports, command, toolName, args, target, message, "blocked", "not_executed",
    undefined, undefined, "project_validation_manifest_changed");
  return receipt.type === "validation.completed" ? { ...receipt, evidence: [] } : receipt;
}

export async function continuedPlanDriftReceipt(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly signal: AbortSignal;
}): Promise<RuntimeV2EventDraft | null> {
  const { ports, command, toolName, args, target } = input;
  if (!isWorkspaceMutationToolName(toolName) && command.kind !== "execute_validation") return null;
  const aggregate = aggregateForCurrentTurn(ports);
  if (!aggregate?.planContinuation) return null;
  const changed = await checkCarriedWorkPlanTargets(aggregate, ports.context.runWorkspace || "", input.signal);
  if (!changed.length) return null;
  const reason = ports.context.phaseLanguage === "en"
    ? "Previously committed files changed. Review them before continuing the plan."
    : "已提交的文件发生变化，请复核后继续计划。";
  const detail = [reason, "", ...changed.map(path => `- ${path}`)].join("\n");
  ports.live.permissionRejection = { reason, finalMarkdown: detail, continuationDriftTargets: changed };
  recordToolResultHistory({ ports, command, toolName, target, status: "blocked", content: detail });
  return toolCompletionFor(ports, command, toolName, args, target, detail, "blocked", "source_mismatch");
}

/** Gate before cached observations, approval and execution. A prior approval
 * cannot override the current Turn's durable capability restrictions. */
export function runtimeV2ToolPreExecutionReceipt(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): RuntimeV2EventDraft | null {
  const { ports, command, toolName, args, target } = input;
  ports.logStoreEvent("runtime_v2_tool_execution_started", {
    turnId: command.run.turnId, runId: command.run.runId,
    commandKind: command.kind, toolName, target: target || null,
  });
  const interrupted = interruptedRuntimeV2ShellBatchReceipt(input);
  if (interrupted) return interrupted;
  const restriction = runtimeV2ToolCapabilityRestriction(ports, toolName, args);
  if (!restriction) return null;
  const content = `TURN_CAPABILITY_RESTRICTED: ${restriction}`;
  recordToolResultHistory({ ports, command, toolName, target, status: "blocked", content });
  const receipt = toolCompletionFor(ports, command, toolName, args, target, content,
    "blocked", "not_authorized", undefined, undefined, "turn_capability_restricted");
  return receipt.type === "validation.completed"
    ? { ...receipt, evidence: [], failureKind: "not_executed", failureReasonCode: "turn_capability_restricted" }
    : receipt;
}

/** Automatic preparation requires a real project scope and cannot exercise a
 * capability requiring an explicit proposal. Settle preparation without claiming
 * an observation; model-proposed reads keep the ordinary deny/review gate. */
export function runtimeV2AutomaticObservationDeferredReceipt(
  ports: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
): RuntimeV2EventDraft | null {
  const hasWorkspace = !!String(ports.context.runWorkspace || "").trim();
  const restriction = runtimeV2ToolCapabilityRestriction(ports, "get_project_skeleton");
  const requiredReview = runtimeV2ToolApprovalCapability(ports, "get_project_skeleton");
  if (hasWorkspace && !restriction && !requiredReview) return null;
  ports.logStoreEvent("runtime_v2_automatic_observation_deferred", {
    turnId: command.run.turnId, runId: command.run.runId,
    reason: !hasWorkspace ? "no_workspace" : restriction ? "turn_capability_restricted" : "turn_requires_human_review",
    capability: restriction || requiredReview,
  });
  return { type: "command.completed", run: command.run, idempotencyKey: command.idempotencyKey, status: "succeeded" };
}

export function unityPlayModePreExecutionReceipt(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): RuntimeV2EventDraft | null {
  const { ports, command, toolName, args, target } = input;
  if (toolName !== "run_command") return null;
  const shell = String(args.command || "");
  const checks = unityValidationInvocations(shell);
  const testCall = checks.some(check => check.kind !== "recompile") ||
    unityCommandArguments(shell)?.slice(0, 3).join(" ").toLowerCase() === "command test run";
  if (!testCall) return null;
  const aggregate = aggregateForCurrentTurn(ports);
  const compile = deriveUnityCompilation(aggregate)?.receipt?.result;
  const authority = command.payload.validationAuthority as RuntimeV2ExecutionValidationAuthority | undefined;
  const needsRevision = command.kind === "execute_validation" && authority?.kind === "work_plan" &&
    !authority.useProjectEditor && compile?.editor === "connected" && projectEditorPlayModeFilter(shell);
  const repair: ApprovedPlanExecutionRepair | undefined = needsRevision && compile?.status !== "failed" ? {
    kind: "playmode_route", target: shell,
    diagnostic: "The project is already open. Review the same suite with the project Editor route and the expected case count.",
  } : undefined;
  if (compile?.status !== "failed" && !repair) return null;
  const reason = repair ? "unity_playmode_route_requires_revision" : "unity_compilation_failed";
  const content = repair ? repair.diagnostic! : `Unity compilation must pass before tests run.\n${unityCompilationMessage(compile!)}`;
  recordToolResultHistory({ ports, command, toolName, target, status: "blocked", content });
  const receipt = toolCompletionFor(ports, command, toolName, args, target, content, "blocked", "not_executed", undefined, undefined, reason);
  return receipt.type === "validation.completed"
    ? { ...receipt, evidence: [], failureKind: "not_executed", failureReasonCode: reason, ...(repair ? { approvedPlanRepair: repair } : {}) }
    : receipt;
}

/** The same causal rejection receipt is used before approval and after
 * trusted mutation preparation has resolved the actual file operation. */
export function runtimeV2ToolAuthorizationRejectionReceipt(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly failureContextTarget: string;
  readonly rejection: RuntimeV2PlanToolAuthorizationResult;
}): RuntimeV2EventDraft {
  const { ports, command, toolName, args, target, failureContextTarget, rejection } = input;
  const content = `TOOL_BLOCKED: ${rejection.reason}`;
  recordToolResultHistory({ ports, command, toolName, target: failureContextTarget, status: "blocked", content });
  ports.logStoreEvent("runtime_v2_tool_execution_blocked", {
    turnId: command.run.turnId,
    runId: command.run.runId,
    commandKind: command.kind,
    toolName,
    target: target || null,
    reason: rejection.reasonCode,
  });
  const receipt = toolCompletionFor(ports, command, toolName, args, failureContextTarget, content,
    "blocked", rejection.failureKind || "not_authorized", undefined, undefined, rejection.reasonCode || undefined);
  if (receipt.type !== "tool.completed" || !["approved_plan_write_file_operation_scope", "approved_plan_mutation_scope",
      "continued_plan_mutation_scope"].includes(rejection.reasonCode || "")) return receipt;
  const aggregate = aggregateForCurrentTurn(ports);
  const compile = deriveUnityCompilation(aggregate)?.receipt?.result;
  if (aggregate?.workPlan?.status !== "approved" || compile?.status !== "failed") return receipt;
  const workspace = aggregate.turn.workspaceKey;
  const requested = resolveWorkspaceMutationRequests(toolName, args, target);
  const planned = new Set(aggregate.sealedWorkPlan?.draft.steps
    .filter(step => step.operation !== "preserve").flatMap(step => step.targets.map(path => unityCompilationTarget(path, workspace))));
  const repairTarget = requested.flatMap(request => {
    const path = unityCompilationTarget(request.target, workspace);
    return path && !planned.has(path) && (request.operation === "create" && /\.asm(?:def|ref)$/i.test(path) ||
      compile.diagnostics?.some(diagnostic => diagnostic.file && unityCompilationTarget(diagnostic.file, workspace) === path))
      ? [path] : [];
  })[0];
  return repairTarget ? { ...receipt, approvedPlanRepair: {
    kind: "compiler_scope", target: repairTarget, diagnostic: unityCompilationMessage(compile).slice(0, 1_600),
  } } : receipt;
}
