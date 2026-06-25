// src/lib/orchestrator/state/EphemeralPruner.ts
// "Burn After Reading" — prunes ephemeral tool outputs and replaces
// them with compact placeholders before the next turn's prompt is built.
// Provides both class-based (backward compat) and functional APIs.
// ────────────────────────────────────────────────────────────────────

import type { AgentMessage } from "../types";
import type { TurnContext } from "./TurnContext";

// ── Functional API (new) ──────────────────────────────────────────────

export interface PruneOptions {
  maxToolChars?: number;
  maxReasoningChars?: number;
  purgeReasoningFromPriorTurns?: boolean;
}

export interface PrunedResult {
  messages: AgentMessage[];
  burnedToolResults: number;
  purgedReasoning: number;
  replacedAssistantReasoning: number;
}

const DEFAULTS: Required<PruneOptions> = {
  maxToolChars: 2000,
  maxReasoningChars: 500,
  purgeReasoningFromPriorTurns: true,
};

function estimateContentChars(msg: AgentMessage): number {
  if (typeof msg.content === "string") return msg.content.length;
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, p) => {
      if (p.type === "text" && typeof p.text === "string") return sum + p.text.length;
      return sum;
    }, 0);
  }
  return 0;
}

function buildBurnedToolStub(msg: AgentMessage, originalChars: number): string {
  const toolCallId = msg.tool_call_id || "unknown";
  return `[Burned: tool result for ${toolCallId} (${originalChars.toLocaleString()} chars → replaced with compact summary in context memory)]`;
}

function buildBurnedReasoningStub(originalReasoningChars: number): string {
  return `[Burned: ${originalReasoningChars.toLocaleString()} chars of internal reasoning → summarized in context memory]`;
}

function compactReasoningSummary(reasoning: string): string {
  const lines = reasoning.split(/\n/).map(l => l.trim()).filter(Boolean);
  const paths = lines.filter(l => /\.(ts|tsx|js|jsx|py|rs|go|json|toml|yaml|yml|md|css|html|sql)/.test(l));
  const actions = lines.filter(l => /^(read|write|edit|apply|run|execute|check|verify|analyze|explore|search)/i.test(l));
  const parts: string[] = [];
  if (actions.length > 0) parts.push(actions[0].slice(0, 120));
  if (paths.length > 0) parts.push(`files: ${paths[0].slice(0, 80)}`);
  return parts.join(" — ") || "Processed internal reasoning";
}

export function pruneEphemeralItems(
  messages: AgentMessage[],
  turnContext: TurnContext | null,
  options: PruneOptions = {},
): PrunedResult {
  const cfg = { ...DEFAULTS, ...options };
  const result: PrunedResult = { messages, burnedToolResults: 0, purgedReasoning: 0, replacedAssistantReasoning: 0 };

  const assistantToolCallIds = new Map<number, Set<string>>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const ids = new Set(msg.tool_calls.map(tc => tc.id).filter(Boolean));
      if (ids.size > 0) assistantToolCallIds.set(i, ids);
    }
  }

  let latestAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") { latestAssistantIdx = i; break; }
  }

  const newMessages: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = { ...messages[i] } as AgentMessage;
    const isPriorAssistant = msg.role === "assistant" && i !== latestAssistantIdx;

    if (msg.role === "tool") {
      const contentChars = estimateContentChars(msg);
      if (contentChars > cfg.maxToolChars) {
        msg.content = buildBurnedToolStub(msg, contentChars);
        result.burnedToolResults++;
        if (turnContext) {
          turnContext.recordBurnedReplacement({ replacementText: msg.content as string, originalLength: contentChars });
        }
      }
    }

    if (isPriorAssistant) {
      if (cfg.purgeReasoningFromPriorTurns) {
        if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > cfg.maxReasoningChars) {
          const summary = compactReasoningSummary(msg.reasoning_content);
          if (typeof msg.content === "string") msg.content += "\n\n" + buildBurnedReasoningStub(msg.reasoning_content.length);
          else if (Array.isArray(msg.content)) msg.content = [...msg.content, { type: "text", text: "\n\n" + buildBurnedReasoningStub(msg.reasoning_content.length) }];
          msg.reasoning_content = summary;
          result.purgedReasoning++;
          if (turnContext) turnContext.accumulateReasoning(msg.reasoning_content.length);
        } else if (msg.reasoning_content && typeof msg.reasoning_content === "string") {
          msg.reasoning_content = "";
        }
        if (typeof msg.reasoning === "string") msg.reasoning = "";
      }
    }

    if (msg.role === "assistant" && i === latestAssistantIdx) {
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > cfg.maxReasoningChars) {
        if (turnContext) turnContext.accumulateReasoning(msg.reasoning_content.length);
        result.replacedAssistantReasoning++;
      }
    }

    newMessages.push(msg);
  }

  result.messages = newMessages;
  return result;
}

// ── Class-based API (backward compat) ────────────────────────────────

export interface EphemeralPrunerOptions {
  maxToolChars?: number;
  maxReasoningChars?: number;
  language?: "zh" | "en";
}

export class EphemeralPruner {
  private maxToolChars: number;
  private maxReasoningChars: number;
  private language: "zh" | "en";

  constructor(options: EphemeralPrunerOptions = {}) {
    this.maxToolChars = options.maxToolChars ?? 2000;
    this.maxReasoningChars = options.maxReasoningChars ?? 500;
    this.language = options.language ?? "zh";
  }

  /**
   * Legacy: prune ephemeral tool results and reasoning from messages.
   * Uses ephemeralItemIds set to identify which tool results to prune.
   */
  prune(messages: AgentMessage[], ephemeralItemIds: Set<string>, contextMemoryText?: string): AgentMessage[] {
    const isZh = this.language === "zh";
    const pruned = messages.map((msg, index) => {
      // Prune ephemeral tool results
      if (msg.role === "tool" && msg.tool_call_id && ephemeralItemIds.has(msg.tool_call_id)) {
        const textContent = typeof msg.content === "string" ? msg.content : "";
        if (textContent.length > this.maxToolChars) {
          const lines = textContent.split("\n").length;
          const replacement = isZh
            ? `[已剪枝：暂态工具输出已隐藏，共读取了 ${lines} 行，结果摘要已保存在上下文记忆中]`
            : `[Pruned: Ephemeral tool output hidden, read ${lines} lines, result summarized in context memory]`;
          return { ...msg, content: replacement };
        }
      }
      // Prune long reasoning from prior assistant messages
      const isLastAssistant = msg.role === "assistant" && index === messages.length - 1;
      if (msg.role === "assistant" && !isLastAssistant) {
        let updated = { ...msg };
        let hasChanges = false;
        if (typeof msg.reasoning === "string" && msg.reasoning.length > this.maxReasoningChars) {
          updated.reasoning = isZh ? "[推理内容已修剪]" : "[Reasoning pruned]";
          hasChanges = true;
        }
        if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > this.maxReasoningChars) {
          updated.reasoning_content = isZh ? "[推理内容已修剪]" : "[Reasoning content pruned]";
          hasChanges = true;
        }
        if (hasChanges) return updated;
      }
      return msg;
    });

    // Inject context memory if provided
    if (contextMemoryText && contextMemoryText.trim()) {
      const hasMemory = pruned.some(m =>
        m.role === "user" && typeof m.content === "string" && m.content.includes("[System: ContextState")
      );
      if (!hasMemory) {
        pruned.push({ role: "user", content: contextMemoryText });
      }
    }

    return pruned;
  }
}
