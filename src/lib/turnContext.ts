import { isContextMemoryText } from "./contextMemory";
import { looksLikeSyntheticContinuationText } from "./syntheticContinuation";
import { extractPrimaryUserRequestText } from "./turnIntake";

export interface TurnContextMessageLike {
  role?: string;
  content?: unknown;
}

export interface TurnContextBlockLike {
  type?: string;
  content?: string;
  hiddenProcess?: boolean;
  streaming?: boolean;
}

export interface CanonicalTurnUserContext {
  texts: string[];
  source: "turn_marker" | "latest_user_fallback" | "none";
  turnStartMessageIndex: number | null;
  inspectedUserMessages: number;
  filteredSyntheticMessages: number;
}

export function extractTurnContextTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: string }).text || ""))
    .join("\n")
    .trim();
}

export function isSyntheticRecoveryUserText(text: string): boolean {
  const value = String(text || "").trim();
  if (!value) return true;
  return (
    isContextMemoryText(value) ||
    looksLikeSyntheticContinuationText(value) ||
    /^\[(?:System|FORCED WRITE|PLAN_[A-Z_]+|EXECUTE_[A-Z_]+|TOOL_[A-Z_]+|APPROVED_PLAN_[A-Z_]+)\b/i.test(value) ||
    /^(?:PLAN_[A-Z_]+|EXECUTE_[A-Z_]+|TOOL_[A-Z_]+|APPROVED_PLAN_[A-Z_]+)\s*:/i.test(value) ||
    /^(?:计划已批准(?:[，。]|$)|The plan is approved(?:[,.]|$))/i.test(value) ||
    /^(?:请在新的恢复上下文中继续执行已批准计划|Continue the approved plan in a fresh recovery context)/i.test(value) ||
    /^(?:在新的恢复上下文中继续计划执行|Continue plan execution in a fresh recovery context)/i.test(value) ||
    /^(?:Resume execution from the remaining tasks in the approved plan|从已批准计划的剩余任务继续执行)/i.test(value) ||
    /^(?:Resume the active goal\s+[^\s]+\s+from its latest checkpoint|从最近检查点继续执行当前目标\s+[^\s]+)[。.]?$/i.test(value) ||
    /^\[goal_continuation\b/i.test(value) ||
    /^(?:执行有界目标切片\s*\d+\/\d+|Execute bounded goal slice\s*\d+\/\d+)/i.test(value) ||
    /^(?:这是 Goal Runtime 分配的一次有界执行切片|This is one bounded execution slice assigned by Goal Runtime)/i.test(value)
  );
}

export function canonicalizeVisibleUserText(text: string): string {
  const raw = String(text || "").trim();
  if (!raw) return "";
  // ContextState is a user-role transport packet. It can quote system
  // constraints containing the literal token `turn_intake`, so classify the
  // packet before looking for a nested intake block.
  if (isContextMemoryText(raw)) return "";
  const primary = (extractPrimaryUserRequestText(raw) || raw).trim();
  const approvalChoice = primary.match(
    /^(?:用户批准并选择：|The user approved and selected:\s*)([^\r\n]+)\r?\n(?:计划已批准|The plan is approved)/i,
  );
  if (approvalChoice?.[1]?.trim()) return approvalChoice[1].trim();
  // Submitted messages wrap their source in turn_intake. Classify the
  // extracted source so hidden approval/recovery prompts cannot become a
  // canonical user request merely because they were submitted through the
  // ordinary message pipeline.
  if (isSyntheticRecoveryUserText(primary)) return "";
  return primary;
}

function clampTurnStartIndex(value: number | null | undefined, length: number): number | null {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric >= length) return null;
  return numeric;
}

export function collectCanonicalTurnUserContext(input: {
  messages: TurnContextMessageLike[];
  turnStartMessageIndex?: number | null;
}): CanonicalTurnUserContext {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const turnStartMessageIndex = clampTurnStartIndex(input.turnStartMessageIndex, messages.length);
  const segment = turnStartMessageIndex == null ? [] : messages.slice(turnStartMessageIndex);
  const texts: string[] = [];
  let inspectedUserMessages = 0;
  let filteredSyntheticMessages = 0;

  for (const message of segment) {
    if (message.role !== "user") continue;
    inspectedUserMessages += 1;
    const raw = extractTurnContextTextContent(message.content);
    const canonical = canonicalizeVisibleUserText(raw);
    if (!canonical) {
      filteredSyntheticMessages += 1;
      continue;
    }
    // Submitted user messages carry turn_intake. A raw message in the segment can
    // be a legacy visible message, but bracketed recovery prompts must never be
    // promoted to the canonical user request.
    texts.push(canonical);
  }

  if (texts.length > 0) {
    return {
      texts,
      source: "turn_marker",
      turnStartMessageIndex,
      inspectedUserMessages,
      filteredSyntheticMessages,
    };
  }

  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  const latestCanonical = latestUser
    ? canonicalizeVisibleUserText(extractTurnContextTextContent(latestUser.content))
    : "";
  return {
    texts: latestCanonical ? [latestCanonical] : [],
    source: latestCanonical ? "latest_user_fallback" : "none",
    turnStartMessageIndex,
    inspectedUserMessages,
    filteredSyntheticMessages,
  };
}

export function buildCanonicalCompletedTurnMessages(input: {
  turnBlocks: TurnContextBlockLike[];
  fallbackAssistantText?: string;
}): Array<{ role: "user" | "assistant"; content: string }> {
  const blocks = Array.isArray(input.turnBlocks) ? input.turnBlocks : [];
  const userMessages = blocks
    .filter((block) => block?.type === "user")
    .map((block) => canonicalizeVisibleUserText(String(block.content || "")))
    .filter(Boolean)
    .map((content) => ({ role: "user" as const, content }));

  const finalAssistantBlock = [...blocks]
    .reverse()
    .find((block) =>
      block?.type === "agent" &&
      block.hiddenProcess !== true &&
      block.streaming !== true &&
      String(block.content || "").trim().length > 0
    );
  const assistantContent = finalAssistantBlock
    ? String(finalAssistantBlock.content || "").trim()
    : String(input.fallbackAssistantText || "").trim();

  if (userMessages.length === 0 || !assistantContent) return [];
  return [
    ...userMessages,
    { role: "assistant", content: assistantContent },
  ];
}

export function findCanonicalTurnStartMessageIndex(input: {
  messages: TurnContextMessageLike[];
  canonicalUserTexts: string[];
  fallbackStartIndex: number;
}): number {
  const targets = (input.canonicalUserTexts || []).map((text) => String(text || "").trim()).filter(Boolean);
  if (targets.length === 0) return input.fallbackStartIndex;

  let targetIndex = targets.length - 1;
  let earliestMatch = -1;
  for (let index = input.messages.length - 1; index >= 0 && targetIndex >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role !== "user") continue;
    const canonical = canonicalizeVisibleUserText(extractTurnContextTextContent(message.content));
    if (!canonical || canonical !== targets[targetIndex]) continue;
    earliestMatch = index;
    targetIndex -= 1;
  }

  return targetIndex < 0 && earliestMatch >= 0
    ? earliestMatch
    : input.fallbackStartIndex;
}

export function compactPlanReviewTurnMessages(input: {
  messages: TurnContextMessageLike[];
  turnStartMessageIndex: number;
  turnBlocks: TurnContextBlockLike[];
  reviewedPlanContent: string;
}): Array<{ role?: string; content?: unknown }> {
  const reviewedPlanContent = String(input.reviewedPlanContent || "").trim();
  if (!reviewedPlanContent) return input.messages;
  if (!Array.isArray(input.messages) || input.messages.length === 0) return input.messages;
  if (
    input.turnStartMessageIndex < 0 ||
    input.turnStartMessageIndex >= input.messages.length
  ) {
    return input.messages;
  }

  const canonical = buildCanonicalCompletedTurnMessages({
    turnBlocks: input.turnBlocks,
    fallbackAssistantText: reviewedPlanContent,
  });
  const canonicalUsers = canonical.filter((message) => message.role === "user");
  if (canonicalUsers.length === 0) return input.messages;
  const effectiveTurnStartIndex = findCanonicalTurnStartMessageIndex({
    messages: input.messages,
    canonicalUserTexts: canonicalUsers.map((message) => message.content),
    fallbackStartIndex: input.turnStartMessageIndex,
  });

  return [
    ...input.messages.slice(0, effectiveTurnStartIndex),
    ...canonicalUsers,
    // The reviewed artifact is the assistant handoff for the fresh child run.
    // Exploration prompts, hidden reasoning, and raw tool results remain owned
    // by the paused parent run rather than leaking into canonical history.
    { role: "assistant", content: reviewedPlanContent },
  ];
}
