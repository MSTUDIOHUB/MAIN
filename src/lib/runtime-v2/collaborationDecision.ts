import type { TurnAggregateV1 } from "./aggregate";

const proactiveSkipReasons = ["no_independent_scope", "no_parallel_capacity", "slots_in_use", "workspace_read_restricted", "insufficient_runway"] as const;
export type RuntimeV2ProactiveSkipReason = typeof proactiveSkipReasons[number];

export function latestRuntimeV2ProactiveSkipReason(state: TurnAggregateV1 | null | undefined): RuntimeV2ProactiveSkipReason | undefined {
  if (!state?.run) return;
  for (let index = state.events.length - 1; index >= 0; index--) {
    const event = state.events[index];
    if (event.type === "command.scheduled" && event.command.kind === "request_model" && event.run.runId === state.run.identity.runId) {
      return proactiveSkipReasons.find(reason => reason === event.command.payload.proactiveSkipReason);
    }
  }
}
