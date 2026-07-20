import { createThread, createTurn, type ExecutionTurn, type LegacyConversationThread } from "../state/Thread";
import { TurnContext } from "../state/TurnContext";
import type { AgentMessage } from "../types";

export interface TurnIterationContext {
  iteration: number;
  eventThreadId: string;
  eventTurnId: string;
  iterationTurnId: string;
  thread: LegacyConversationThread;
  turn: ExecutionTurn;
  turnContext: TurnContext;
  /** Exact lifecycle ids emitted as item.started during this iteration. */
  startedToolCallIds: Set<string>;
  /** Prevent duplicate history folds from emitting a second terminal item. */
  completedToolCallIds: Set<string>;
}

export function startTurnIteration(input: {
  currentThread: LegacyConversationThread | null;
  eventThreadId: string;
  eventTurnId: string;
  iteration: number;
  messages: AgentMessage[];
}): TurnIterationContext {
  const thread =
    input.currentThread?.threadId === input.eventThreadId
      ? input.currentThread
      : createThread(input.eventThreadId);
  const iterationTurnId = `${input.eventTurnId}-${input.iteration}`;
  const turn = createTurn(iterationTurnId, input.messages);
  thread.turns.push(turn);

  const turnContext = new TurnContext(turn);
  turnContext.startTurn();

  return {
    iteration: input.iteration,
    eventThreadId: input.eventThreadId,
    eventTurnId: input.eventTurnId,
    iterationTurnId,
    thread,
    turn,
    turnContext,
    startedToolCallIds: new Set<string>(),
    completedToolCallIds: new Set<string>(),
  };
}
