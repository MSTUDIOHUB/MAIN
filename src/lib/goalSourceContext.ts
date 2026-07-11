import type { AgentMessage } from "./orchestrator";
import { canonicalizeGoalInput } from "./goalState";
import type { DurableTurnContext, PlanArtifact } from "./workflowModels";

export interface GoalSourceConversationTurn {
  userPrompt?: string;
  summary?: string;
  status?: string;
  durableContext?: DurableTurnContext | null;
}

function messageText(content: AgentMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.type === "text" ? String(part.text || "") : "")
    .join("\n")
    .trim();
}

function compactSourceItem(value: string, maxChars = 1_600): string {
  const normalized = String(value || "").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) return normalized;
  const marker = "\n...[summary truncated]...\n";
  const remaining = maxChars - marker.length;
  return `${normalized.slice(0, Math.floor(remaining * 0.7))}${marker}${normalized.slice(-Math.ceil(remaining * 0.3))}`;
}

function isRuntimeOnlyUserMessage(text: string): boolean {
  return /^(?:\[System:\s*ContextState|\[GoalTurnContract|\[goal_runtime|Execute bounded goal slice|执行有界目标切片)/i.test(
    text.trim(),
  );
}

/**
 * Build a bounded, human-authored continuation snapshot before a new Goal is
 * started. System/tool payloads and turn-intake wrappers are deliberately not
 * copied into the persisted Goal definition.
 */
export function buildGoalSourceContextSnapshot(input: {
  objective: string;
  agentMessages: AgentMessage[];
  conversationTurns?: GoalSourceConversationTurn[];
  planArtifacts?: PlanArtifact[];
}): string | undefined {
  const items: string[] = [];
  let userCount = 0;
  let assistantCount = 0;

  const unfinishedCriteria = [...new Set(
    (input.conversationTurns || [])
      .slice(-4)
      .flatMap((turn) => turn.durableContext?.execution?.unfinished || [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )].slice(0, 20);
  if (unfinishedCriteria.length > 0) {
    items.push(`[unfinished_criteria]\n${unfinishedCriteria.map((item) => `- ${compactSourceItem(item, 320)}`).join("\n")}\n[/unfinished_criteria]`);
  }

  for (let index = input.agentMessages.length - 1; index >= 0; index -= 1) {
    const message = input.agentMessages[index];
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "assistant" && message.tool_calls?.length) continue;
    const rawText = messageText(message.content);
    if (!rawText) continue;

    if (message.role === "user") {
      if (userCount >= 2 || isRuntimeOnlyUserMessage(rawText)) continue;
      const canonical = canonicalizeGoalInput(rawText).objective;
      if (!canonical || isRuntimeOnlyUserMessage(canonical)) continue;
      items.unshift(`[prior_user]\n${compactSourceItem(canonical)}\n[/prior_user]`);
      userCount += 1;
      continue;
    }

    if (assistantCount >= 3) continue;
    items.unshift(`[prior_assistant_summary]\n${compactSourceItem(rawText)}\n[/prior_assistant_summary]`);
    assistantCount += 1;
  }

  const turnSummaries = (input.conversationTurns || [])
    .filter((turn) => String(turn.summary || "").trim())
    .slice(-3)
    .map((turn) => compactSourceItem(String(turn.summary || "").trim(), 1_200))
    .filter((summary) => !items.some((item) => item.includes(summary)));
  for (const summary of turnSummaries) {
    items.push(`[prior_turn_final]\n${summary}\n[/prior_turn_final]`);
  }

  for (const artifact of (input.planArtifacts || []).filter((item) =>
    item.kind === "plan" || item.kind === "design" || item.kind === "bugfix" || item.kind === "tasks"
  ).slice(-2)) {
    const content = compactSourceItem(String(artifact.content || ""), 1_400);
    if (!content) continue;
    items.push(`[plan_artifact path="${String(artifact.path || "").replace(/"/g, "")}"]\n${content}\n[/plan_artifact]`);
  }

  if (items.length === 0) return undefined;
  return canonicalizeGoalInput(input.objective, items.join("\n\n")).sourceContext;
}
