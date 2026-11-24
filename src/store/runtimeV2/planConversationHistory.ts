import type { AgentMessage } from "../../lib/agentMessages";
import type { ConversationTurn } from "../../lib/workflowModels";
import { serializeDurableTurnContextForModel } from "../../lib/durableTurnContext";

/** Reuse the Session's existing durable conversation projection. This is
 * conversation context only, never a fresh source receipt or approval. The
 * provider's shared history budget bounds it together with the current Run. */
export function priorPlanConversationMessages(state: any, turnId: string, sourceDraftTurnId?: string): AgentMessage[] {
  const turns: ConversationTurn[] = Array.isArray(state.conversationTurns) ? state.conversationTurns : [];
  const index = turns.findIndex(turn => turn.id === turnId);
  if (index >= 0 && turns.slice(0, index).some(turn => turn.uiVisibility !== "internal")) {
    return turns.slice(0, index).filter(turn => turn.uiVisibility !== "internal" && turn.id !== sourceDraftTurnId).flatMap(turn => {
      const user = String(turn.userPrompt || "").trim();
      const assistant = String(turn.durableContext?.finalAssistantAnswer || turn.summary || "").trim();
      const execution = serializeDurableTurnContextForModel(turn.durableContext);
      return [...(user ? [{ role: "user" as const, content: user }] : []),
        ...(assistant ? [{ role: "assistant" as const, content: assistant }] : []),
        ...(execution ? [{ role: "system" as const, content: execution }] : [])];
    });
  }
  const supplied: AgentMessage[] = Array.isArray(state.agentMessages) ? state.agentMessages : [];
  const exact = supplied.findIndex(message => message.role === "user" && message.runtimeTurnId === turnId);
  const reverse = [...supplied].reverse().findIndex(message => message.role === "user");
  const latestUser = reverse < 0 ? -1 : supplied.length - 1 - reverse;
  const boundary = exact >= 0 ? exact : latestUser;
  return supplied.slice(0, Math.max(0, boundary)).filter(message =>
    (message.role === "user" || message.role === "assistant") && !message.tool_calls?.length
  ).map(message => ({ role: message.role, content: typeof message.content === "string" ? message.content : message.content.map(part => ({ ...part })) }));
}
