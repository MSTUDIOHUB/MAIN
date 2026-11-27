import type { TurnAggregateV1 } from "./aggregate";
import { areRuntimeV2SubagentWriteScopesDisjoint, type RuntimeV2SubagentScopeCandidate } from "./subagents";

const proactiveSkipReasons = ["no_independent_scope", "no_parallel_capacity", "slots_in_use", "workspace_read_restricted", "insufficient_runway"] as const;
export type RuntimeV2ProactiveSkipReason = typeof proactiveSkipReasons[number];

export interface RuntimeV2OptionalDelegationScope extends RuntimeV2SubagentScopeCandidate {
  readonly proactiveKey: string;
  readonly primaryEvidence: readonly { readonly path: string; readonly id: string }[];
  readonly parentPaths: readonly string[];
}

export type RuntimeV2ProactiveCollaboration =
  | { readonly candidate: RuntimeV2OptionalDelegationScope; readonly alternatives?: readonly RuntimeV2OptionalDelegationScope[] }
  | { readonly reason: RuntimeV2ProactiveSkipReason };

function delegationScopes(value?: RuntimeV2ProactiveCollaboration): readonly RuntimeV2OptionalDelegationScope[] {
  return value && "candidate" in value ? [value.candidate, ...value.alternatives || []] : [];
}

export function runtimeV2DelegationRequiresProposal(preference: string | undefined, requirement: TurnAggregateV1["subagentRequirement"]): boolean {
  return requirement !== "required" && (preference === "preferred" || preference === "allowed" && requirement === "optional");
}

export function runtimeV2CanAdvertiseSubagentSpawn(payload: Readonly<Record<string, unknown>>): boolean {
  const requiresProposal = payload.collaborationRequiresProposal === true ||
    payload.collaborationRequiresProposal === undefined && payload.collaborationPreferred === true && payload.collaborationRequired !== true;
  return payload.collaborationAllowed === true && (!requiresProposal ||
    Array.isArray(payload.delegationHints) && payload.delegationHints.length > 0);
}

export function runtimeV2DelegationHints(value?: RuntimeV2ProactiveCollaboration) {
  return delegationScopes(value).slice(0, 6).map(scope => ({
    taskKind: scope.taskKind,
    objective: scope.objective,
    primaryEvidence: scope.primaryEvidence,
    allowedPaths: scope.allowedPaths,
    parentPaths: scope.parentPaths,
  }));
}

function proposedList(value: unknown): readonly string[] {
  return typeof value === "string" ? [...new Set(value.split(/[,\n]/).map(item => item.trim()).filter(Boolean))] : [];
}

/** A preferred turn may send a concrete proposal through spawn_subagent. The
 * decision binds its primary targets to a live, independent ledger scope. */
export function runtimeV2OptionalDelegationProposal(input: {
  readonly state: TurnAggregateV1;
  readonly collaboration?: RuntimeV2ProactiveCollaboration;
  readonly arguments: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
  const args = input.arguments;
  const reject = (reason: string) => ({ optionalDelegationRejected: reason });
  if (!input.collaboration) return reject("no_independent_scope");
  if ("reason" in input.collaboration) return reject(input.collaboration.reason);
  const paths = proposedList(args.required_paths);
  const allowed = proposedList(args.allowed_paths);
  const references = proposedList(args.evidence_refs);
  const deliverable = typeof args.success_criteria === "string" ? args.success_criteria.trim() : "";
  const parentWork = typeof args.parent_work === "string" ? args.parent_work.trim() : "";
  if (!paths.length || !references.length || !deliverable || !parentWork ||
      typeof args.objective !== "string" || !args.objective.trim()) return reject("incomplete_proposal");
  if (args.access_mode === "write" || args.task_kind === "implement") return reject("optional_requires_read_scope");
  const scope = delegationScopes(input.collaboration).find(candidate =>
    (!args.task_kind || args.task_kind === candidate.taskKind) && candidate.primaryEvidence.length === paths.length &&
    candidate.primaryEvidence.every(evidence => paths.includes(evidence.path) &&
      (references.includes(evidence.id) || references.includes(evidence.path))) &&
    references.every(ref => candidate.primaryEvidence.some(evidence => ref === evidence.id || ref === evidence.path)) &&
    allowed.every(path => candidate.allowedPaths.includes(path)) &&
    candidate.allowedPaths.length > 0);
  if (!scope || (allowed.length && !paths.every(path => allowed.includes(path)))) return reject("no_independent_scope");
  if (scope.parentPaths.length && !scope.parentPaths.some(path => parentWork.includes(path))) return reject("parent_work_not_in_scope");
  const jobs = input.state.subagents.filter(job => job.parentRunId === input.state.run?.identity.runId);
  if (jobs.some(job => job.proactiveKey === scope.proactiveKey || job.scopeKey === scope.scopeKey)) return reject("already_delegated");
  if (jobs.some(job => (job.status === "queued" || job.status === "running") &&
      !areRuntimeV2SubagentWriteScopesDisjoint(job.allowedPaths, allowed.length ? allowed : paths))) return reject("overlapping_scope");
  return {
    proactiveKey: scope.proactiveKey,
    arguments: {
      ...args,
      task_key: scope.scopeKey,
      task_kind: scope.taskKind,
      objective: `${scope.objective}\nModel's requested deliverable: ${args.objective}`,
    },
  };
}

export function latestRuntimeV2ProactiveSkipReason(state: TurnAggregateV1 | null | undefined): RuntimeV2ProactiveSkipReason | undefined {
  if (!state?.run) return;
  for (let index = state.events.length - 1; index >= 0; index--) {
    const event = state.events[index];
    if (event.type === "command.scheduled" && event.command.kind === "schedule_subagents" &&
        event.run.runId === state.run.identity.runId && typeof event.command.payload.proactiveKey === "string") return;
    if (event.type === "command.scheduled" && event.command.kind === "request_model" && event.run.runId === state.run.identity.runId) {
      return proactiveSkipReasons.find(reason => reason === event.command.payload.proactiveSkipReason);
    }
  }
}
