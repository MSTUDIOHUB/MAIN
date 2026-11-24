import { sha256Hex } from "../sha256";
import { normalizeValidationWorkspaceCwd } from "../validationContract";
import { resolveWorkspaceMutationRequests } from "../workspaceMutationTools";
import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2WorkPlanReference } from "./contracts";
import type { RuntimeV2Event } from "./events";
import { approvedRuntimeV2PlanContinuation } from "./planContinuationBaseline";
import { isWorkPlanArtifactProjectionBound } from "./workPlan";

const EXACT_VERSION = /^sha256-[a-f0-9]{64}$/;

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && !!value.trim();
}

function samePlan(left: RuntimeV2WorkPlanReference, right: RuntimeV2WorkPlanReference): boolean {
  return left.id === right.id && left.revision === right.revision && left.digest === right.digest &&
    left.projectionHash === right.projectionHash;
}

/** Validate the shape and same-owner lineage of a runtime-owned seal. The
 * admission port verifies the historical checkpoint and current disk bytes. */
export function isValidRuntimeV2PlanContinuation(
  state: TurnAggregateV1,
  event: Extract<RuntimeV2Event, { type: "work_plan.sealed" }>,
): boolean {
  const continuation = event.continuation;
  const source = continuation?.source;
  if (!continuation || !source?.turn || !source.run || !source.workPlan ||
    !nonEmptyText(source.approvalEventId) || event.reviewCommit.artifact.documentRef || state.workPlan || state.planPurpose === "rules" ||
    state.events.some(item => item.type === "provider.responded" || item.type === "tool.completed") ||
    source.turn.workspaceKey !== state.turn.workspaceKey || source.turn.sessionKey !== state.turn.sessionKey ||
    source.turn.sessionEpoch !== state.turn.sessionEpoch || !nonEmptyText(source.turn.turnId) ||
    source.turn.turnId === state.turn.turnId || !nonEmptyText(source.turn.clientSubmissionId) ||
    source.turn.clientSubmissionId === state.turn.clientSubmissionId || source.run.turnId !== source.turn.turnId ||
    source.run.sessionKey !== source.turn.sessionKey || source.run.sessionEpoch !== source.turn.sessionEpoch ||
    source.run.parentRunId !== null || !nonEmptyText(source.run.runId) || source.run.runId === event.run.runId ||
    !nonEmptyText(source.run.attemptId) || source.workPlan.status !== "approved" || !samePlan(source.workPlan, event.workPlan) ||
    !Array.isArray(continuation.completedStepIndexes) || !Array.isArray(continuation.carriedTargets)) return false;
  const plan = event.sealedPlan;
  const documentTurn = source.documentTurn || source.turn;
  if (source.documentTurn && (!source.documentRef || documentTurn.workspaceKey !== source.turn.workspaceKey ||
    documentTurn.sessionKey !== source.turn.sessionKey || documentTurn.sessionEpoch !== source.turn.sessionEpoch ||
    !nonEmptyText(documentTurn.turnId) || !nonEmptyText(documentTurn.clientSubmissionId) ||
    documentTurn.turnId === state.turn.turnId)) return false;
  if (source.documentRef && !isWorkPlanArtifactProjectionBound({ path: source.documentRef.path,
    documentRef: source.documentRef, content: plan.markdown, projectionHash: plan.projectionHash }, plan, documentTurn)) return false;

  const carriedIndexes = new Set(continuation.completedStepIndexes);
  if (carriedIndexes.size !== continuation.completedStepIndexes.length) return false;
  const completed = new Set<number>();
  const plannedTargets = new Map<string, Set<string>>();
  const workspace = state.turn.workspaceKey;
  for (const [index, step] of plan.draft.steps.entries()) {
    const dependenciesMet = step.dependsOn.every(dependency => completed.has(dependency));
    if (step.operation === "preserve" && dependenciesMet) completed.add(index);
    if (!carriedIndexes.has(index)) continue;
    if (step.operation === "preserve" || !dependenciesMet) return false;
    completed.add(index);
    carriedIndexes.delete(index);
    for (const target of step.targets) {
      const path = normalizeValidationWorkspaceCwd(target, workspace);
      if (!path || path === ".") return false;
      const operations = plannedTargets.get(path) || new Set<string>();
      operations.add(step.operation);
      plannedTargets.set(path, operations);
    }
  }
  if (carriedIndexes.size || continuation.carriedTargets.length !== plannedTargets.size) return false;
  for (const receipt of continuation.carriedTargets) {
    const path = normalizeValidationWorkspaceCwd(receipt?.target, workspace);
    const operations = path && plannedTargets.get(path);
    if (!path || !operations || typeof receipt.receiptId !== "string" || !receipt.receiptId.trim() ||
      (receipt.version === null ? !operations.has("delete") : !EXACT_VERSION.test(String(receipt.version)))) return false;
    plannedTargets.delete(path);
  }
  return plannedTargets.size === 0;
}

export interface RuntimeV2PlanContinuationPostImage {
  readonly target: string;
  readonly receiptId: string;
  /** undefined means this receipt cannot prove exact bytes or absence. */
  readonly version: string | null | undefined;
}

/** Return the latest trusted post-image for each previously committed path.
 * Legacy full writes have exact command bytes even without a version field. */
export function resolveRuntimeV2PlanContinuationPostImages(aggregate: TurnAggregateV1): readonly RuntimeV2PlanContinuationPostImage[] {
  let approval = aggregate.events.length - 1;
  while (approval >= 0 && aggregate.events[approval]!.type !== "work_plan.approved") approval -= 1;
  if (approval < 0 || aggregate.workPlan?.status !== "approved") return [];
  const baseline = approvedRuntimeV2PlanContinuation(aggregate.events);
  const byTarget = new Map<string, RuntimeV2PlanContinuationPostImage>();
  const targetKey = (path: string) => normalizeValidationWorkspaceCwd(path, aggregate.turn.workspaceKey);
  for (const target of baseline?.continuation.carriedTargets || []) {
    const key = targetKey(target.target);
    if (key) byTarget.set(key, target);
  }
  const commands = new Map(aggregate.events.flatMap(event => event.type === "command.scheduled" &&
    event.command.kind === "execute_tool" ? [[event.command.idempotencyKey, event.command] as const] : []));
  for (const event of aggregate.events.slice(approval + 1)) {
    const tool = event.type === "tool.completed" && event.status === "succeeded" ? event : null;
    const child = event.type === "subagent.completed" && event.status === "completed" ? event : null;
    if (!tool && !child) continue;
    const command = tool ? commands.get(tool.idempotencyKey) : undefined;
    const args = command?.payload.arguments as Record<string, unknown> | undefined;
    const name = String(command?.payload.toolName || "");
    const mutations = tool?.mutationRequests ?? resolveWorkspaceMutationRequests(name, args);
    for (const evidence of (tool || child)!.evidence) {
      if (evidence.kind !== "mutation") continue;
      const key = targetKey(evidence.target);
      if (!key || key === ".") continue;
      const operation = child ? aggregate.subagents.find(job => job.id === child.jobId)?.implementationOperation :
        mutations.find(mutation => targetKey(mutation.target) === key)?.operation;
      const version = operation === "delete" ? null : EXACT_VERSION.test(evidence.version || "") ? evidence.version :
        name === "write_file" && (operation === "create" || operation === "modify") && typeof args?.content === "string" &&
          targetKey(String(args.path || "")) === key ? `sha256-${sha256Hex(args.content)}` : undefined;
      byTarget.set(key, { target: key, receiptId: evidence.id, version });
    }
  }
  return [...byTarget.values()];
}
