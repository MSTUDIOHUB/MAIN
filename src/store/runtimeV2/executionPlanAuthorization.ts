import { approvedRuntimeV2PlanContinuation, deriveRuntimeV2PlanExecutionFrontier, resolveRuntimeV2PlanMutationScope, resolveRuntimeV2PlanValidationScope } from "../../lib/runtime-v2";
import { getShellToolCwd } from "../../lib/toolExecutionContract";
import { normalizeValidationWorkspaceCwd, unityValidationInvocations } from "../../lib/validationContract";
import { isWorkspaceMutationToolName, resolveWorkspaceMutationRequests, UNITY_CREATE_SCENE_TOOL } from "../../lib/workspaceMutationTools";
import type { WorkspaceWriteFileTargetFact } from "../../lib/workspaceMutationPreflight";
import type {
  RuntimeV2Command,
  TurnAggregateV1,
} from "../../lib/runtime-v2";
import { approvedPlanForCurrentTurn } from "./executionAggregate";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import { deriveUnityCompilation, deriveUnityShaderImport, unityCompilationTarget, unityShaderImportTarget } from "../../lib/runtime-v2/unityCompilation";

/** Correct the exact compiler-diagnosed post-image created in this Run.
 * Carried files and previously preserved work require their own approval. */
export function isApprovedUnityCorrection(aggregate: TurnAggregateV1, target: string): boolean {
  const workspace = aggregate.turn.workspaceKey;
  const shader = unityShaderImportTarget(target, workspace);
  const resolveTarget = shader ? unityShaderImportTarget : unityCompilationTarget;
  const path = resolveTarget(target, workspace);
  const check = (shader ? deriveUnityShaderImport(aggregate) : deriveUnityCompilation(aggregate))?.receipt?.result;
  if (!path || check?.status !== "failed" ||
      !check.diagnostics?.some(error => error.file && resolveTarget(error.file, workspace) === path)) return false;
  const approval = [...aggregate.events].reverse().find(event => event.type === "work_plan.approved");
  return !!approval && !!deriveRuntimeV2PlanExecutionFrontier(aggregate)?.steps.some(step =>
    step.status === "completed" && step.operation !== "delete" && step.operation !== "preserve" &&
    (step.completionSequence ?? -1) > approval.sequence &&
    step.targets.some(target => resolveTarget(target, workspace) === path));
}

export interface RuntimeV2PlanToolAuthorizationResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly failureKind:
    | "not_authorized"
    | "protocol_invalid"
    | "source_mismatch"
    | null;
  readonly reasonCode: string | null;
}

export function validateToolAgainstApprovedPlan(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly aggregate: TurnAggregateV1;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly writeFileTarget?: WorkspaceWriteFileTargetFact;
}): RuntimeV2PlanToolAuthorizationResult {
  const approved = approvedPlanForCurrentTurn(input.ports);
  if (!approved) {
    return {
      allowed: false,
      reason: "当前 Plan 的批准权威无效或已过期，运行时拒绝执行外部效果。",
      failureKind: "not_authorized",
      reasonCode: "approved_plan_authority_missing",
    };
  }
  const continued = approvedRuntimeV2PlanContinuation(input.aggregate.events);
  if (continued && input.command.kind === "execute_tool" && isWorkspaceMutationToolName(input.toolName)) {
    const requests = input.writeFileTarget ? [{ target: input.writeFileTarget.path,
      operation: input.writeFileTarget.exists ? "modify" : "create" }] :
      resolveWorkspaceMutationRequests(input.toolName, input.args, input.target);
    const ready = deriveRuntimeV2PlanExecutionFrontier(input.aggregate)?.steps.filter(step => step.status === "ready") || [];
    const workspace = input.aggregate.turn.workspaceKey;
    const unresolvedWrite = input.toolName === "write_file" && !input.writeFileTarget;
    const scoped = requests.length > 0 && requests.every(request => {
      const target = normalizeValidationWorkspaceCwd(request.target, workspace);
      return target !== null && target !== "." && (ready.some(step =>
        (unresolvedWrite ? step.operation === "create" || step.operation === "modify" : step.operation === request.operation) &&
        step.targets.some(path => normalizeValidationWorkspaceCwd(path, workspace) === target)) ||
        (request.operation === "modify" || unresolvedWrite) && isApprovedUnityCorrection(input.aggregate, target));
    });
    if (!scoped) return { allowed: false, reason: "A continued Plan allows only the exact pending, dependency-ready file operations in its approval.",
      failureKind: "not_authorized", reasonCode: "continued_plan_mutation_scope" };
  }
  if (continued && ["run_command", "execute_command", "send_pty_input"].includes(input.toolName)) {
    const command = typeof input.args.command === "string" ? input.args.command.trim() : "";
    const workspace = input.aggregate.turn.workspaceKey;
    const cwd = normalizeValidationWorkspaceCwd(getShellToolCwd(input.args), workspace);
    const exact = command && (input.args.input === undefined || input.args.input === "") && cwd !== null && approved.plan.draft.validations.some(validation =>
      validation.kind === "finite_command" && command === validation.command?.trim() &&
      cwd === normalizeValidationWorkspaceCwd(validation.cwd, workspace));
    if (input.command.kind !== "execute_validation" || !exact ||
      !resolveRuntimeV2PlanValidationScope({ plan: approved.plan, aggregate: input.aggregate, toolName: input.toolName, args: input.args }).allowed) {
      return { allowed: false, reason: "A continued Plan allows only an exact approved finite command from its reviewed validation scope.",
        failureKind: "not_authorized", reasonCode: "continued_plan_command_scope" };
    }
  }
  if (input.toolName === UNITY_CREATE_SCENE_TOOL) {
    const workspace = input.ports.context.runWorkspace || "";
    const scene = typeof input.args.path === "string" ? input.args.path : "";
    const script = typeof input.args.script_path === "string" ? input.args.script_path : "";
    const frontier = deriveRuntimeV2PlanExecutionFrontier(input.aggregate);
    const exactTarget = (paths: readonly string[], target: string) => {
      const normalized = normalizeValidationWorkspaceCwd(target, workspace);
      return normalized !== null && paths.some(path => normalizeValidationWorkspaceCwd(path, workspace) === normalized);
    };
    const sceneReady = scene.startsWith("Assets/") && scene.endsWith(".unity") &&
      frontier?.steps.some(step => step.operation === "create" && step.status === "ready" && exactTarget(step.targets, scene));
    const scriptReady = script.startsWith("Assets/") && script.endsWith(".cs") &&
      frontier?.steps.some(step => step.status === "completed" &&
        step.operation !== "delete" && exactTarget(step.targets, script));
    if (!sceneReady || !scriptReady) return {
      allowed: false, reason: "Unity scene authoring needs the exact approved ready scene and an already committed or preserved script from the Plan. Continue the listed file steps first.",
      failureKind: "not_authorized", reasonCode: "approved_plan_unity_scene_scope",
    };
  }
  if (input.toolName === "run_command" && input.command.kind === "execute_validation" &&
    unityValidationInvocations(String(input.args.command || "")).length > 0 &&
    !resolveRuntimeV2PlanValidationScope({ plan: approved.plan, aggregate: input.aggregate, toolName: input.toolName, args: input.args }).allowed) {
    return { allowed: false, reason: "Run the exact reviewed Unity validator after the approved implementation is complete.",
      failureKind: "not_authorized", reasonCode: "approved_plan_unity_validation_scope" };
  }
  if (input.toolName === "write_file" && input.writeFileTarget) {
    const scope = resolveRuntimeV2PlanMutationScope({
      plan: approved.plan,
      requestedTargets: [input.writeFileTarget.path],
      requestedMutations: [{ target: input.writeFileTarget.path, operation: input.writeFileTarget.exists ? "modify" : "create" }],
    });
    if (!scope.allowed && !(input.writeFileTarget.exists && isApprovedUnityCorrection(input.aggregate, input.writeFileTarget.path))) return {
      allowed: false, reason: "The actual write_file operation does not match the approved Plan's exact target and create/modify scope.",
      failureKind: "not_authorized", reasonCode: "approved_plan_write_file_operation_scope",
    };
  }
  if (!continued && input.toolName !== "write_file" && input.command.kind === "execute_tool" &&
      isWorkspaceMutationToolName(input.toolName) &&
      [deriveUnityCompilation(input.aggregate), deriveUnityShaderImport(input.aggregate)]
        .some(check => check?.receipt?.result.status === "failed")) {
    const workspace = input.aggregate.turn.workspaceKey;
    const requests = resolveWorkspaceMutationRequests(input.toolName, input.args, input.target);
    if (requests.some(request => unityCompilationTarget(request.target, workspace) || unityShaderImportTarget(request.target, workspace)) &&
        !requests.every(request => resolveRuntimeV2PlanMutationScope({
          plan: approved.plan, requestedTargets: [request.target], requestedMutations: [request],
        }).allowed || request.operation === "modify" && isApprovedUnityCorrection(input.aggregate, request.target))) {
      return { allowed: false, reason: "Editor diagnostic fixes must stay within the exact reviewed Plan changes.",
        failureKind: "not_authorized", reasonCode: "approved_plan_mutation_scope" };
    }
  }
  return { allowed: true, reason: null, failureKind: null, reasonCode: null };
}
