import type { ActionRequest, UserChoiceResolutionIdentity } from "./actionRequest";
import type { GoalDefinition, GoalStatus } from "./goalState";
import type { ResolvedRunIntent } from "./runIntent";

export function shouldContinueGoalFromUserChoice(input: {
  sourceIntent: ResolvedRunIntent;
  sourceTurnId?: string | null;
  activeGoal?: Pick<GoalDefinition, "id" | "ownerTurnId"> | null;
  goalStatus?: GoalStatus | null;
  activeActionRequest?: ActionRequest | null;
  choiceRequest?: UserChoiceResolutionIdentity | null;
}): boolean {
  if (input.sourceIntent !== "goal" || !input.sourceTurnId || !input.activeGoal) return false;
  if (input.activeGoal.ownerTurnId !== input.sourceTurnId) return false;
  if (input.goalStatus !== "awaiting_input" && input.goalStatus !== "paused") return false;
  const activeRequest = input.activeActionRequest;
  const choiceRequest = input.choiceRequest;
  return activeRequest?.kind === "user_choice" &&
    activeRequest.status === "pending" &&
    !!choiceRequest &&
    choiceRequest.status === "pending" &&
    activeRequest.requestId === choiceRequest.requestId &&
    activeRequest.runId === choiceRequest.runId &&
    activeRequest.turnId === input.sourceTurnId;
}
