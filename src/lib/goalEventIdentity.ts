import type { GoalDefinition } from "./goalState";
import {
  resolveSessionRuntimeKey,
  resolveSessionWorkspaceKey,
} from "./sessionTypes";

/**
 * Goal lifecycle events share the exact same thread identity namespace as
 * run/turn events and always remain attached to the Goal's logical owner turn.
 */
export function resolveGoalEventOwnerIdentity(input: {
  goal: Pick<GoalDefinition, "sessionKey" | "ownerTurnId">;
  currentWorkspace?: string | null;
  currentSessionId?: number | null;
  currentTurnId?: string | null;
}): { threadId: string; turnId?: string } {
  const threadId = String(input.goal.sessionKey || "").trim() ||
    resolveSessionRuntimeKey(resolveSessionWorkspaceKey(input.currentWorkspace), input.currentSessionId) ||
    resolveSessionWorkspaceKey(input.currentWorkspace) ||
    "session";
  const turnId = String(input.goal.ownerTurnId || input.currentTurnId || "").trim();
  return {
    threadId,
    ...(turnId ? { turnId } : {}),
  };
}
