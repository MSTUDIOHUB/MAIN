import {
  resolveApprovedPlanCommandScope,
  resolveApprovedPlanMutationScope,
  type ApprovedPlanCommandScopeDecision,
  type ApprovedPlanMutationScopeDecision,
} from "./approvedPlanExecutionScope";
import {
  findSubagentScopeConflict,
  validateSubagentScopeTarget,
  type SubagentExecutionScope,
  type SubagentScopeLease,
} from "./subagents";
import { getShellMutationTargetForLoopGuard } from "./repetitionGuard";
import type { PlanTask } from "./workflowModels";
import { resolveWorkspaceMutationTargets } from "./workspaceMutationTools";

const PATH_SCOPED_TOOL_NAMES = new Set([
  "read_file",
  "read_file_window",
  "read_document",
  "get_file_outline",
  "code_ast_query",
  "list_directory",
  "grep_search",
  "find_symbol_references",
  "git_diff",
]);

export type ToolArgumentAuthorizationBlockReason =
  | "approved_plan_command_scope"
  | "approved_plan_mutation_scope"
  | "subagent_path_scope"
  | "parent_subagent_scope_overlap";

export interface ToolArgumentAuthorizationDecision {
  allowed: boolean;
  blockReason: ToolArgumentAuthorizationBlockReason | null;
  approvedPlanCommandScope: ApprovedPlanCommandScopeDecision;
  approvedPlanMutationScope: ApprovedPlanMutationScopeDecision;
  scopeTargets: string[];
  blockedSubagentTargets: string[];
  parentScopeConflict: SubagentScopeLease | null;
  parentScopeConflictTarget: string;
}

/**
 * Resolve every path whose value participates in the runtime's delegated
 * workspace authorization. The execution identity is intentional: an MCP
 * alias such as `mcp__unity__manage_script` must inherit the canonical
 * `manage_script` mutation contract instead of bypassing it under its display
 * name.
 */
export function resolveToolArgumentAuthorizationTargets(input: {
  executionName: string;
  args: Record<string, unknown>;
  target?: string;
}): string[] {
  const mutationTargets = resolveWorkspaceMutationTargets(
    input.executionName,
    input.args,
    input.target || "",
  );
  if (mutationTargets.length > 0) return mutationTargets;
  if (input.executionName === "run_command" || input.executionName === "execute_command") {
    const shellMutationTarget = getShellMutationTargetForLoopGuard(
      input.executionName,
      input.args,
    );
    // A concrete shell write participates in the exact delegated path lease.
    // Commands whose effects cannot be attributed to one path conservatively
    // cover the workspace root, so a parent cannot race any active child lease
    // and a scoped child cannot escape through an opaque shell command.
    return [shellMutationTarget?.replace(/^shell-write:/, "") || "."];
  }
  if (!PATH_SCOPED_TOOL_NAMES.has(input.executionName)) return [];
  const path = typeof input.args.path === "string" ? input.args.path.trim() : "";
  // A missing path is retained so child-scope authorization fails closed. The
  // execution contract will provide the more specific missing-argument error.
  return [path];
}

/**
 * Re-evaluate immutable scope grants against the arguments that will actually
 * execute. User/session approval may authorize risk, but it cannot widen an
 * approved Plan or a child agent's runtime-owned workspace lease.
 */
export function resolveToolArgumentAuthorization(input: {
  executionName: string;
  args: Record<string, unknown>;
  target?: string;
  isPlanApproved: boolean;
  planTasks: PlanTask[];
  subagentScope?: SubagentExecutionScope | null;
  threadId?: string;
  sessionEpoch?: string;
}): ToolArgumentAuthorizationDecision {
  const approvedPlanCommandScope = resolveApprovedPlanCommandScope({
    isPlanApproved: input.isPlanApproved,
    toolName: input.executionName,
    args: input.args,
    tasks: input.planTasks,
  });
  const approvedPlanMutationScope = resolveApprovedPlanMutationScope({
    isPlanApproved: input.isPlanApproved,
    toolName: input.executionName,
    args: input.args,
    target: input.target || "",
    tasks: input.planTasks,
  });
  const scopeTargets = resolveToolArgumentAuthorizationTargets({
    executionName: input.executionName,
    args: input.args,
    target: input.target,
  });
  const blockedSubagentTargets = input.subagentScope
    ? scopeTargets.filter((scopeTarget) =>
        !scopeTarget || !validateSubagentScopeTarget(input.subagentScope!, scopeTarget)
      )
    : [];
  let parentScopeConflict: SubagentScopeLease | null = null;
  let parentScopeConflictTarget = "";
  if (!input.subagentScope && input.threadId) {
    for (const scopeTarget of scopeTargets) {
      if (!scopeTarget) continue;
      const conflict = findSubagentScopeConflict({
        threadId: input.threadId,
        sessionEpoch: input.sessionEpoch,
        targetPath: scopeTarget,
      });
      if (!conflict) continue;
      parentScopeConflict = conflict;
      parentScopeConflictTarget = scopeTarget;
      break;
    }
  }

  const blockReason: ToolArgumentAuthorizationBlockReason | null =
    approvedPlanCommandScope.applies && !approvedPlanCommandScope.allowed
      ? "approved_plan_command_scope"
      : approvedPlanMutationScope.applies && !approvedPlanMutationScope.allowed
      ? "approved_plan_mutation_scope"
      : blockedSubagentTargets.length > 0
      ? "subagent_path_scope"
      : parentScopeConflict
      ? "parent_subagent_scope_overlap"
      : null;

  return {
    allowed: blockReason === null,
    blockReason,
    approvedPlanCommandScope,
    approvedPlanMutationScope,
    scopeTargets,
    blockedSubagentTargets,
    parentScopeConflict,
    parentScopeConflictTarget,
  };
}
