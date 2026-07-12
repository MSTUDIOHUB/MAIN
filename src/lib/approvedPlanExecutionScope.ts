import type { PlanTask } from "./workflowModels";
import { workspacePathsReferToSameFile } from "./workspacePaths";

const BUILTIN_WORKSPACE_MUTATION_TOOLS = new Set([
  "write_file",
  "replace_in_file",
  "apply_patch",
]);

function normalizePath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .toLocaleLowerCase();
}

function pathsMatch(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  return workspacePathsReferToSameFile(a, b);
}

function extractApplyPatchTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const match of String(patch || "").matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/gmi)) {
    if (match[1]) targets.push(match[1].trim());
  }
  for (const match of String(patch || "").matchAll(/^\+\+\+\s+(?:b\/)?([^\s]+)$/gmi)) {
    if (match[1] && match[1] !== "/dev/null") targets.push(match[1].trim());
  }
  return Array.from(new Set(targets.map(normalizePath).filter(Boolean)));
}

function collectRequestedTargets(input: {
  toolName: string;
  args: Record<string, unknown>;
  target: string;
}): string[] {
  if (input.toolName === "apply_patch") {
    const targets = extractApplyPatchTargets(String(input.args.patch || ""));
    return targets.length > 0 ? targets : [normalizePath(input.target)].filter(Boolean);
  }
  return [normalizePath(String(input.args.path || input.target || ""))].filter(Boolean);
}

export interface ApprovedPlanMutationScopeDecision {
  applies: boolean;
  allowed: boolean;
  requestedTargets: string[];
  plannedTargets: string[];
  unexpectedTargets: string[];
}

/**
 * Enforce the approved Plan as an execution scope, not merely a prompt.  The
 * model may choose how to implement a task, but built-in workspace mutations
 * cannot touch files absent from the reviewed runtime task projection.
 */
export function resolveApprovedPlanMutationScope(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  toolName: string;
  args: Record<string, unknown>;
  target: string;
  tasks: PlanTask[];
}): ApprovedPlanMutationScopeDecision {
  const applies = input.workflowMode === "plan" &&
    input.isPlanApproved &&
    BUILTIN_WORKSPACE_MUTATION_TOOLS.has(input.toolName);
  if (!applies) {
    return {
      applies: false,
      allowed: true,
      requestedTargets: [],
      plannedTargets: [],
      unexpectedTargets: [],
    };
  }

  const plannedTargets = Array.from(new Set(input.tasks.flatMap((task) =>
    (task.evidence || [])
      .filter((evidence) => evidence.kind === "file" || evidence.kind === "deliverable")
      .map((evidence) => normalizePath(evidence.value))
      .filter(Boolean),
  )));
  const requestedTargets = collectRequestedTargets(input);
  const unexpectedTargets = requestedTargets.filter((requested) =>
    !/^\.main\/plans\/tasks\.md$/i.test(requested) &&
    !plannedTargets.some((planned) => pathsMatch(requested, planned)),
  );

  return {
    applies: true,
    allowed: requestedTargets.length > 0 && unexpectedTargets.length === 0,
    requestedTargets,
    plannedTargets,
    unexpectedTargets,
  };
}
