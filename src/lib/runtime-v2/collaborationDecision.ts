import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2SubagentScopeCandidate } from "./subagents";

const proactiveSkipReasons = ["no_independent_scope", "no_parallel_capacity", "slots_in_use", "workspace_read_restricted", "insufficient_runway"] as const;
export type RuntimeV2ProactiveSkipReason = typeof proactiveSkipReasons[number];
export type RuntimeV2ProactiveCollaboration =
  | { readonly candidate: RuntimeV2SubagentScopeCandidate }
  | { readonly reason: RuntimeV2ProactiveSkipReason };

export function runtimeV2ProactiveSchedulePayload(
  state: TurnAggregateV1,
  input: {
    readonly subagentPreference?: string;
    readonly subagentRequestMode?: string;
    readonly subagentCapacity?: number;
    readonly proactiveCollaboration?: RuntimeV2ProactiveCollaboration;
  },
): Readonly<Record<string, unknown>> | undefined {
  const run = state.run;
  if (!run || state.strategy === "chat" || state.subagentRequirement === "required" ||
      input.subagentPreference !== "preferred" || input.subagentRequestMode !== "parallel" ||
      !input.proactiveCollaboration || !("candidate" in input.proactiveCollaboration)) return;
  const capacity = Math.max(0, Math.floor(Number(input.subagentCapacity) || 0));
  const activeCount = state.subagents.filter(job => job.parentRunId === run.identity.runId &&
    (job.status === "queued" || job.status === "running")).length;
  const candidate = input.proactiveCollaboration.candidate;
  if (activeCount >= capacity || !candidate.proactiveKey || candidate.accessMode !== "read" ||
      candidate.taskKind === "implement") return;
  return {
    proactiveKey: candidate.proactiveKey,
    arguments: {
      task_key: candidate.scopeKey, name: candidate.name, task_kind: candidate.taskKind, access_mode: "read",
      objective: candidate.objective, success_criteria: candidate.successCriteria, allowed_paths: candidate.allowedPaths.join("\n"),
    },
    maxActiveSubagents: capacity,
    collaborationRequestMode: input.subagentRequestMode,
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
