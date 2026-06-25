// src/lib/orchestrator/state/ReasoningStrainer.ts
// Purges reasoning_content and reasoning fields from prior-turn
// assistant messages to prevent "thinking loop" in-context learning.
// Provides both class-based (backward compat) and functional APIs.
// ────────────────────────────────────────────────────────────────────

import type { AgentMessage } from "../types";
import { REASONING_TAG_RE } from "../../normalizedTurn";

// ── Functional API (new) ──────────────────────────────────────────────

export interface ReasoningStrainOptions {
  currentTurnReasoningThreshold?: number;
}

export interface ReasoningStrainResult {
  messages: AgentMessage[];
  isReasoningDominated: boolean;
  totalPurgedReasoningChars: number;
  messagesStrained: number;
}

const DEFAULT_THRESHOLD = 1500;

function estimateReasoningRatio(msg: AgentMessage): number {
  let totalChars = 0;
  let reasoningChars = 0;
  if (msg.reasoning_content && typeof msg.reasoning_content === "string") reasoningChars += msg.reasoning_content.length;
  if (msg.reasoning && typeof msg.reasoning === "string") reasoningChars += msg.reasoning.length;
  if (typeof msg.content === "string") {
    totalChars = msg.content.length;
    const tagMatches = msg.content.match(REASONING_TAG_RE);
    if (tagMatches) reasoningChars += tagMatches.reduce((s, m) => s + m.length, 0);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text" && typeof part.text === "string") {
        totalChars += part.text.length;
        const tagMatches = part.text.match(REASONING_TAG_RE);
        if (tagMatches) reasoningChars += tagMatches.reduce((s, m) => s + m.length, 0);
      }
    }
  }
  if (totalChars === 0) return 0;
  return Math.min(1, reasoningChars / totalChars);
}

function reasoningToSummary(reasoning: string): string {
  const lines = reasoning.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const summaryParts: string[] = [];
  for (const line of lines) {
    if (/\.(ts|tsx|js|jsx|py|rs|go|css|html|json|toml|yaml|yml|md|sh|bash)\b/.test(line)) {
      summaryParts.push(`examines: ${line.slice(0, 100)}`);
    }
    if (summaryParts.length >= 2) break;
  }
  if (summaryParts.length === 0) return `Processed internal reasoning (${reasoning.length.toLocaleString()} chars)`;
  return summaryParts.join(". ");
}

function stripNonTagThinking(text: string): string {
  const patterns = [
    /^Thinking:\s*/i, /^REASONING:\s*/i, /^THOUGHT:\s*/i,
    /^思考[：:]\s*/, /^INTERNAL_THINKING:\s*/i,
  ];
  let cleaned = text;
  for (const pat of patterns) cleaned = cleaned.replace(pat, "");
  const lines = cleaned.split("\n");
  const filtered: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const alphaChars = trimmed.replace(/[^a-zA-Z]/g, "");
    if (alphaChars.length > 10 && alphaChars === alphaChars.toUpperCase()) continue;
    filtered.push(line);
  }
  return filtered.join("\n");
}

export function strainReasoning(
  messages: AgentMessage[],
  options: ReasoningStrainOptions = {},
): ReasoningStrainResult {
  const threshold = options.currentTurnReasoningThreshold ?? DEFAULT_THRESHOLD;
  let latestAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") { latestAssistantIdx = i; break; }
  }

  let totalPurgedChars = 0;
  let messagesStrained = 0;
  const newMessages: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isPrior = msg.role === "assistant" && i !== latestAssistantIdx;
    const cloned = { ...msg } as AgentMessage;

    if (isPrior) {
      const priorReasoningLen =
        (typeof msg.reasoning_content === "string" ? msg.reasoning_content.length : 0) +
        (typeof msg.reasoning === "string" ? msg.reasoning.length : 0);
      const ratio = estimateReasoningRatio(msg);
      if (ratio > 0.8) {
        const reasoning = msg.reasoning_content || msg.reasoning || "";
        const summary = reasoningToSummary(reasoning);
        if (typeof msg.content === "string") {
          cloned.content = summary;
        } else if (Array.isArray(msg.content)) {
          cloned.content = [{ type: "text", text: summary }];
        }
      }
      cloned.reasoning_content = "";
      cloned.reasoning = "";
      totalPurgedChars += priorReasoningLen;
      messagesStrained++;
    } else if (msg.role === "assistant" && i === latestAssistantIdx) {
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > threshold) {
        cloned.reasoning_content = msg.reasoning_content.slice(0, threshold) +
          `\n[Truncated: ${msg.reasoning_content.length - threshold} chars removed]`;
      }
      if (typeof msg.content === "string") {
        cloned.content = stripNonTagThinking(msg.content);
      } else if (Array.isArray(msg.content)) {
        cloned.content = msg.content.map(part => {
          if (part.type === "text" && typeof part.text === "string") {
            return { ...part, text: stripNonTagThinking(part.text) };
          }
          return part;
        });
      }
    }
    newMessages.push(cloned);
  }

  const latestAssistant = messages[latestAssistantIdx];
  const isDominated = latestAssistant
    ? estimateReasoningRatio(latestAssistant) > 0.8 && !latestAssistant.tool_calls
    : false;

  return {
    messages: newMessages,
    isReasoningDominated: isDominated,
    totalPurgedReasoningChars: totalPurgedChars,
    messagesStrained,
  };
}

// ── Class-based API (backward compat) ────────────────────────────────

export interface ReasoningPurgeOptions {
  language?: "zh" | "en";
  maxReasoningChars?: number;
}

export class ReasoningStrainer {
  private language: "zh" | "en";

  constructor(options: ReasoningPurgeOptions = {}) {
    this.language = options.language ?? "zh";
  }

  purgeReasoning(messages: AgentMessage[]): AgentMessage[] {
    const isZh = this.language === "zh";
    return messages.map((msg, index) => {
      const isLastAssistant = msg.role === "assistant" && index === messages.length - 1;
      if (msg.role === "assistant" && !isLastAssistant) {
        const updated = { ...msg };
        if (updated.reasoning !== undefined) delete updated.reasoning;
        if (updated.reasoning_content !== undefined) delete updated.reasoning_content;

        if (typeof updated.content === "string") {
          let cleanedContent = updated.content;
          for (const tag of ["thinking", "thought", "analysis", "reasoning"]) {
            const openRegex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
            if (openRegex.test(cleanedContent)) {
              cleanedContent = cleanedContent.replace(openRegex, (match) => {
                const charCount = match.length;
                return isZh
                  ? `[已执行操作：内部思考过程已净化 (${charCount} 字符)]`
                  : `[Action taken: Internal monologue purged (${charCount} chars)]`;
              });
            }
          }
          updated.content = cleanedContent;
        }
        return updated;
      }
      return msg;
    });
  }
}
