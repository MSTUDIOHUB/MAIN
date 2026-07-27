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

export function collectApprovedPlanMutationTargets(tasks: PlanTask[]): string[] {
  return Array.from(new Set((tasks || []).flatMap((task) =>
    (task.evidence || [])
      .filter((evidence) => evidence.kind === "file" || evidence.kind === "deliverable")
      .map((evidence) => normalizePath(evidence.value))
      .filter(Boolean),
  )));
}

export function resolveApprovedPlanDelegatedWriteScope(input: {
  isPlanApproved: boolean;
  accessMode: "read" | "write";
  allowedPaths: string[];
  tasks: PlanTask[];
}): ApprovedPlanMutationScopeDecision {
  const applies = input.isPlanApproved && input.accessMode === "write";
  if (!applies) {
    return {
      applies: false,
      allowed: true,
      requestedTargets: [],
      plannedTargets: [],
      unexpectedTargets: [],
    };
  }
  const plannedTargets = collectApprovedPlanMutationTargets(input.tasks);
  const requestedTargets = Array.from(new Set(
    (input.allowedPaths || []).map(normalizePath).filter(Boolean),
  ));
  const unexpectedTargets = requestedTargets.filter((requested) =>
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

export interface ApprovedPlanScopeConflictIdentity {
  planRevision: number | null;
  unexpectedTargets: string[];
  plannedTargets: string[];
}

export interface ApprovedPlanCommandScopeDecision {
  applies: boolean;
  allowed: boolean;
  requestedCommand: string;
  plannedCommands: string[];
}

function normalizeScopeIdentityTargets(values: string[]): string[] {
  return Array.from(new Set(
    (values || []).map(normalizePath).filter(Boolean),
  )).sort();
}

/**
 * Identify one approved-Plan scope conflict independently of the mutation tool
 * the model happened to choose. Recovery counters must survive a switch from
 * write_file to apply_patch (or another editor) when the reviewed revision,
 * blocked target, and allowed scope are unchanged.
 */
export function buildApprovedPlanScopeConflictFingerprint(
  input: ApprovedPlanScopeConflictIdentity,
): string {
  const revision = input.planRevision == null
    ? null
    : Math.max(1, Math.floor(Number(input.planRevision) || 1));
  return JSON.stringify({
    kind: "approved_plan_scope_conflict",
    revision,
    blocked: normalizeScopeIdentityTargets(input.unexpectedTargets),
    planned: normalizeScopeIdentityTargets(input.plannedTargets),
  });
}

function commandFromArgs(args: Record<string, unknown>): string {
  const command = args.command ?? args.cmd ?? args.input;
  return typeof command === "string"
    ? command.replace(/\s+/g, " ").trim()
    : "";
}

/**
 * Plan approval authorizes reviewed commands, not an unrestricted shell.
 * Shell syntax is too broad to prove read-only with a deny-list (`find
 * -delete`, `git diff --output`, interpreters, and compound commands can all
 * mutate). Dedicated read tools remain available; every shell command must be
 * present verbatim in structured Plan evidence.
 */
export function resolveApprovedPlanCommandScope(input: {
  isPlanApproved: boolean;
  toolName: string;
  args: Record<string, unknown>;
  tasks: PlanTask[];
}): ApprovedPlanCommandScopeDecision {
  const isShellTool = input.toolName === "run_command" || input.toolName === "execute_command";
  const applies = input.isPlanApproved && isShellTool;
  if (!applies) {
    return { applies: false, allowed: true, requestedCommand: "", plannedCommands: [] };
  }
  const requestedCommand = commandFromArgs(input.args);
  const plannedCommands = Array.from(new Set(input.tasks.flatMap((task) =>
    (task.evidence || [])
      .filter((evidence) => evidence.kind === "cmd")
      .map((evidence) => String(evidence.value || "").replace(/\s+/g, " ").trim())
      .filter(Boolean),
  )));
  return {
    applies: true,
    allowed: !!requestedCommand && plannedCommands.includes(requestedCommand),
    requestedCommand,
    plannedCommands,
  };
}

/**
 * Enforce the approved Plan as an execution scope, not merely a prompt.  The
 * model may choose how to implement a task, but workspace mutations
 * cannot touch files absent from the reviewed runtime task projection.
 */
export function resolveApprovedPlanMutationScope(input: {
  isPlanApproved: boolean;
  toolName: string;
  args: Record<string, unknown>;
  target: string;
  tasks: PlanTask[];
}): ApprovedPlanMutationScopeDecision {
  const applies = input.isPlanApproved &&
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

  const plannedTargets = collectApprovedPlanMutationTargets(input.tasks);
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
