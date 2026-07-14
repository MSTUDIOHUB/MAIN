import type { PlanTask } from "./workflowModels";
import { workspacePathsReferToSameFile } from "./workspacePaths";
import {
  isWorkspaceMutationToolCall,
  resolveWorkspaceMutationTargets,
} from "./workspaceMutationTools";

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

function collectRequestedTargets(input: {
  toolName: string;
  args: Record<string, unknown>;
  target: string;
}): string[] {
  return resolveWorkspaceMutationTargets(input.toolName, input.args, input.target)
    .map(normalizePath)
    .filter(Boolean);
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
 * model may choose how to implement a task, but workspace mutations
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
    isWorkspaceMutationToolCall(input.toolName, input.args);
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
