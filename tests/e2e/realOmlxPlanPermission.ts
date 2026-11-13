import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolPermissionActionRequest, ToolPermissionResolutionIdentity } from "../../src/lib/actionRequest";
import type { TurnAggregateV1, RuntimeV2PlanReviewCommit, SealedWorkPlanV1 } from "../../src/lib/runtime-v2";
import { resolveApprovedRuntimeV2WorkPlanFromAggregate } from "../../src/store/runtimeV2/workPlanAdapter";
import { derivePendingReviewTarget } from "../../src/lib/pendingToolReview";
import { parseApplyPatch } from "../../src/lib/applyPatchTool";
import { isFinitePlanValidationCommand } from "../../src/lib/workflowModels";

/** Raw Store/canonical values, never getSnapshot()'s display summaries. */
export interface RealOmlxPlanPermissionObservation {
  currentWorkspace: string | null;
  currentSessionKey: string | null;
  currentTurnId: string | null;
  sessionEpoch: string | null;
  marker: { sessionKey: string; turnId: string | null; runId: string; parentRunId?: string | null; status: string } | null;
  request: ToolPermissionActionRequest | null;
  pendingReviewTaskId: number | null;
  hasPendingResolver: boolean;
  pendingToolCall: { toolCallId?: string; name?: string; arguments?: Record<string, unknown>; risk?: string } | null;
  aggregate: TurnAggregateV1 | null;
}

export interface RealOmlxApprovedPlanBinding {
  plan: SealedWorkPlanV1;
  commit: RuntimeV2PlanReviewCommit;
}

function sameJson(left: unknown, right: unknown): boolean {
  const stable = (value: any): string => value && typeof value === "object"
    ? Array.isArray(value) ? `[${value.map(stable).join(",")}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
  return stable(left) === stable(right);
}

function requireFact(fact: unknown, reason: string): asserts fact {
  if (!fact) throw new Error(`REAL_OMLX_UNEXPECTED_PLAN_PERMISSION: ${reason}`);
}

async function exactWorkspacePath(workspace: string, raw: unknown, allowRoot = false): Promise<string> {
  requireFact(typeof raw === "string" && raw.length > 0 && raw === raw.trim(), "missing or padded path");
  const normalized = raw.replace(/\\/g, "/");
  requireFact(!normalized.includes("\0") && !normalized.split("/").includes("..") &&
    !/[?*\[\]{}]/.test(normalized) && !/^[a-z]+:/i.test(normalized), "unsafe path");
  const absolute = path.resolve(workspace, normalized);
  const relative = path.relative(workspace, absolute);
  requireFact((allowRoot || relative !== "") && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "path outside approved workspace");
  // Check existing ancestors too: a new file inside an escaping symlink is not
  // made safe merely because the final file does not exist yet.
  let cursor = workspace;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const metadata = await fs.lstat(cursor).catch(error => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    requireFact(!metadata?.isSymbolicLink(), "symlink target or ancestor");
  }
  return absolute;
}

/** The test acts as this case's user, approving only the exact reviewed work. */
export async function validateRealOmlxPlannedPermission(
  observed: RealOmlxPlanPermissionObservation,
  expected: RealOmlxApprovedPlanBinding,
  workspace: string,
): Promise<{ identity: ToolPermissionResolutionIdentity; commandKey: string; targets: string[] }> {
  const root = await fs.realpath(workspace);
  const aggregate = observed.aggregate;
  const request = observed.request;
  const pending = observed.pendingToolCall;
  requireFact(root === workspace && observed.currentWorkspace === root, "workspace is not the canonical fixture root");
  requireFact(aggregate?.run && request?.kind === "tool_permission" && request.status === "pending", "no current canonical permission");
  const run = aggregate.run.identity;
  const turn = aggregate.turn;
  requireFact(observed.currentSessionKey === turn.sessionKey && observed.currentTurnId === turn.turnId &&
    observed.sessionEpoch === turn.sessionEpoch && run.sessionKey === turn.sessionKey &&
    run.sessionEpoch === turn.sessionEpoch && run.turnId === turn.turnId && turn.workspaceKey === root,
  "active Session/epoch/Turn owner mismatch");
  requireFact(request.sessionKey === run.sessionKey && request.turnId === run.turnId && request.runId === run.runId &&
    (request.parentRunId ?? null) === run.parentRunId, "request Run/parent owner mismatch");
  requireFact(observed.marker?.sessionKey === run.sessionKey && observed.marker.turnId === run.turnId &&
    observed.marker.runId === run.runId && (observed.marker.parentRunId ?? null) === run.parentRunId &&
    observed.marker.status === "running", "process Run owner mismatch");
  requireFact(observed.hasPendingResolver && observed.pendingReviewTaskId === request.taskId &&
    Number.isSafeInteger(request.taskId) && pending && request.toolCallId &&
    pending.toolCallId === request.toolCallId && pending.name === request.toolName && pending.risk === request.risk,
  "pending resolver/call identity mismatch");

  const approved = resolveApprovedRuntimeV2WorkPlanFromAggregate(aggregate);
  requireFact(approved && sameJson(approved.plan, expected.plan) && sameJson(approved.commit, expected.commit),
    "approved sealed Plan/commit/documentRef changed since this case's review");
  const review = approved.commit.review;
  requireFact(review.sessionKey === run.sessionKey && review.sessionEpoch === run.sessionEpoch && review.turnId === run.turnId &&
    review.runId === run.runId && review.parentRunId === run.parentRunId, "review owner mismatch");
  const approval = aggregate.events.find(event => event.type === "work_plan.approved" &&
    sameJson(event.run, run) && event.workPlan.status === "approved" &&
    event.workPlan.id === approved.commit.authority.id && event.workPlan.revision === approved.commit.authority.revision &&
    event.workPlan.digest === approved.commit.authority.digest && event.workPlan.projectionHash === approved.commit.authority.projectionHash);
  requireFact(approval, "missing matching canonical work_plan.approved receipt");

  const command = aggregate.scheduledCommands.find(candidate => candidate.idempotencyKey === request.toolCallId);
  requireFact(command && ["execute_tool", "execute_validation"].includes(command.kind) && sameJson(command.run, run) &&
    command.phase === aggregate.phase && command.payload.toolName === request.toolName &&
    !aggregate.completedCommands.some(receipt => receipt.idempotencyKey === command.idempotencyKey),
  "permission is not the exact unsettled canonical command");
  const args = command.payload.arguments as Record<string, unknown>;
  requireFact(args && typeof args === "object" && !Array.isArray(args) && sameJson(args, pending.arguments),
    "pending arguments differ from the canonical command payload");
  requireFact(request.target === derivePendingReviewTarget(request.toolName, args), "permission disclosure differs from actual arguments");
  const providerCall = aggregate.pendingToolCalls.find(call => call.id === command.payload.toolCallId);
  requireFact(providerCall && providerCall.name === request.toolName && sameJson(providerCall.arguments, args),
    "canonical provider call does not match the pending effect");

  if (request.toolName === "run_command") {
    requireFact(request.risk === "shell" && typeof args.command === "string" && isFinitePlanValidationCommand(args.command) &&
      (args.input === undefined || args.input === ""), "not a finite validation command without extra stdin");
    const cwd = await exactWorkspacePath(root, args.cwd ?? args.workdir ?? ".", true);
    if (args.cwd !== undefined && args.workdir !== undefined) {
      requireFact(cwd === await exactWorkspacePath(root, args.workdir, true), "conflicting command directories");
    }
    const validation = approved.plan.draft.validations.find(entry => entry.required && entry.kind === "finite_command" && entry.command === args.command);
    requireFact(validation && cwd === await exactWorkspacePath(root, validation.cwd || ".", true),
      "command bytes/directory are not an exact sealed required validation");
    return { identity: permissionIdentity(request), commandKey: command.idempotencyKey, targets: [cwd] };
  }

  requireFact(["write_file", "replace_in_file", "apply_patch"].includes(request.toolName) &&
    ["workspace_write", "write"].includes(String(request.risk)), "tool/risk is outside this test's approved write scope");
  const changes: { target: string; operation: string }[] = [];
  if (request.toolName === "apply_patch") {
    const parsed = parseApplyPatch(String(args.patch || ""));
    requireFact(parsed.ok && parsed.operations.length > 0, "invalid patch");
    for (const operation of parsed.operations) {
      changes.push({ target: operation.path, operation: operation.kind === "add" ? "create" : operation.kind === "delete" || operation.newPath ? "delete" : "modify" });
      if (operation.newPath) changes.push({ target: operation.newPath, operation: "create" });
    }
  } else {
    const target = await exactWorkspacePath(root, args.path);
    const exists = await fs.lstat(target).then(() => true, error => { if (error?.code === "ENOENT") return false; throw error; });
    changes.push({ target: String(args.path), operation: request.toolName === "write_file" && !exists ? "create" : "modify" });
  }
  const targets: string[] = [];
  for (const change of changes) {
    const target = await exactWorkspacePath(root, change.target);
    let covered = false;
    for (const step of approved.plan.draft.steps) {
      if (step.operation !== change.operation) continue;
      for (const planned of step.targets) if (await exactWorkspacePath(root, planned) === target) covered = true;
    }
    requireFact(covered, "mutation target/operation is not an exact reviewed step target");
    targets.push(target);
  }
  return { identity: permissionIdentity(request), commandKey: command.idempotencyKey, targets };
}

function permissionIdentity(request: ToolPermissionActionRequest): ToolPermissionResolutionIdentity {
  return { sessionKey: request.sessionKey, turnId: request.turnId, runId: request.runId, requestId: request.requestId, taskId: request.taskId };
}
