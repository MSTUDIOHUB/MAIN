import type { ActionRequest } from "./actionRequest";
import { isActionRequestOwnedByRun } from "./actionRequest";
import { appendRuntimeEventWithResult, type MainThreadEvent } from "./turnEvents";

export interface RunTransitionState {
  activeActionRequest: ActionRequest | null;
  runtimeEvents: MainThreadEvent[];
  conversationTurns?: Array<{
    id: string;
    status: string;
    runtimeOutcome?: {
      status: string;
      runId: string;
    } | null;
  }>;
}

export type RunTransition =
  | { type: "action_required"; request: ActionRequest; events: MainThreadEvent[] }
  | { type: "runtime_event"; event: MainThreadEvent };

function isRunControlClearingEvent(
  event: MainThreadEvent,
): event is Extract<MainThreadEvent, { type: "run.completed" | "run.aborted" }> {
  return event.type === "run.completed" || event.type === "run.aborted";
}

function isControlClearingEventOwnedByRequest(event: MainThreadEvent, request: ActionRequest): boolean {
  return isRunControlClearingEvent(event) && isActionRequestOwnedByRun(request, {
    sessionKey: event.threadId,
    turnId: event.turnId,
    runId: event.runId,
  });
}

/** Single reducer for the coupled run-event/action-request lifecycle. */
export function reduceRunTransition<T extends RunTransitionState>(state: T, transition: RunTransition): T {
  if (transition.type === "action_required") {
    const alreadyControlCleared = state.runtimeEvents.some((event) =>
      isControlClearingEventOwnedByRequest(event, transition.request)
    );
    let runtimeEvents = state.runtimeEvents;
    let transitionClearedControl = false;
    for (const event of transition.events) {
      const appendResult = appendRuntimeEventWithResult(runtimeEvents, event);
      runtimeEvents = appendResult.events;
      if (
        appendResult.disposition !== "conflict" &&
        isControlClearingEventOwnedByRequest(event, transition.request)
      ) {
        transitionClearedControl = true;
      }
    }
    return {
      ...state,
      activeActionRequest: alreadyControlCleared || transitionClearedControl ? null : transition.request,
      runtimeEvents,
    };
  }

  const appendResult = appendRuntimeEventWithResult(state.runtimeEvents, transition.event);
  const runtimeEvents = appendResult.events;
  const transitionAccepted = appendResult.disposition !== "conflict";
  const shouldClearRequest = !!state.activeActionRequest && (
    (
      transitionAccepted &&
      isRunControlClearingEvent(transition.event) &&
      isActionRequestOwnedByRun(state.activeActionRequest, {
        sessionKey: transition.event.threadId,
        turnId: transition.event.turnId,
        runId: transition.event.runId,
      })
    ) || (
      transitionAccepted &&
      transition.event.type === "run.started" &&
      transition.event.threadId === state.activeActionRequest.sessionKey &&
      transition.event.turnId === state.activeActionRequest.turnId &&
      transition.event.parentRunId === state.activeActionRequest.runId
    )
  );
  const startedParentRunId = transition.event.type === "run.started"
    ? transition.event.parentRunId
    : null;
  const conversationTurns = transitionAccepted &&
    !!startedParentRunId &&
    state.conversationTurns
    ? state.conversationTurns.map((turn) =>
        turn.runtimeOutcome?.status === "paused" &&
        turn.runtimeOutcome.runId === startedParentRunId
          ? {
              ...turn,
              status: "executing",
              runtimeOutcome: undefined,
            }
          : turn
      )
    : state.conversationTurns;
  return {
    ...state,
    runtimeEvents,
    ...(shouldClearRequest ? { activeActionRequest: null } : {}),
    ...(conversationTurns ? { conversationTurns } : {}),
  } as T;
}
