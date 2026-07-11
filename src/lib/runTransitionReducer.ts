import type { ActionRequest } from "./actionRequest";
import { isActionRequestOwnedByRun } from "./actionRequest";
import { appendRuntimeEvent, type MainThreadEvent } from "./turnEvents";

export interface RunTransitionState {
  activeActionRequest: ActionRequest | null;
  runtimeEvents: MainThreadEvent[];
}

export type RunTransition =
  | { type: "action_required"; request: ActionRequest; events: MainThreadEvent[] }
  | { type: "runtime_event"; event: MainThreadEvent }
  | { type: "terminal_cleanup"; owner: { sessionKey: string; turnId: string; runId: string } };

function isHardRunTerminal(event: MainThreadEvent): event is Extract<MainThreadEvent, { type: "run.completed" | "run.failed" }> {
  return event.type === "run.completed" || event.type === "run.failed";
}

/** Single reducer for the coupled run-event/action-request lifecycle. */
export function reduceRunTransition<T extends RunTransitionState>(state: T, transition: RunTransition): T {
  if (transition.type === "terminal_cleanup") {
    return isActionRequestOwnedByRun(state.activeActionRequest, transition.owner)
      ? { ...state, activeActionRequest: null }
      : state;
  }

  if (transition.type === "action_required") {
    const alreadyTerminal = state.runtimeEvents.some((event) =>
      isHardRunTerminal(event) &&
      event.threadId === transition.request.sessionKey &&
      event.turnId === transition.request.turnId &&
      event.runId === transition.request.runId
    );
    const runtimeEvents = transition.events.reduce(
      (events, event) => appendRuntimeEvent(events, event),
      state.runtimeEvents,
    );
    return {
      ...state,
      activeActionRequest: alreadyTerminal ? null : transition.request,
      runtimeEvents,
    };
  }

  const runtimeEvents = appendRuntimeEvent(state.runtimeEvents, transition.event);
  const shouldClearRequest = !!state.activeActionRequest && (
    (
      isHardRunTerminal(transition.event) &&
      isActionRequestOwnedByRun(state.activeActionRequest, {
        sessionKey: transition.event.threadId,
        turnId: transition.event.turnId,
        runId: transition.event.runId,
      })
    ) || (
      transition.event.type === "run.started" &&
      transition.event.threadId === state.activeActionRequest.sessionKey &&
      transition.event.turnId === state.activeActionRequest.turnId &&
      transition.event.parentRunId === state.activeActionRequest.runId
    )
  );
  return {
    ...state,
    runtimeEvents,
    ...(shouldClearRequest ? { activeActionRequest: null } : {}),
  };
}
