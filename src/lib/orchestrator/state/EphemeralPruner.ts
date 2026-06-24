// src/lib/orchestrator/state/EphemeralPruner.ts

import type { AgentMessage } from "../types";

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
   * Prunes ephemeral content and reasoning text from message history.
   * Modifies the array in place or returns a pruned copy.
   */
  prune(
    messages: AgentMessage[],
    ephemeralItemIds: Set<string>,
    contextMemoryText?: string
  ): AgentMessage[] {
    const isZh = this.language === "zh";

    const prunedMessages = messages.map((msg, index) => {
      // Rule 1: Prune ephemeral tool results
      if (msg.role === "tool" && msg.tool_call_id && ephemeralItemIds.has(msg.tool_call_id)) {
        const textContent = typeof msg.content === "string" ? msg.content : "";
        if (textContent.length > this.maxToolChars) {
          const lines = textContent.split("\n").length;
          const replacement = isZh
            ? `[已剪枝：暂态工具输出已隐藏，共读取了 ${lines} 行，结果摘要已保存在上下文记忆中]`
            : `[Pruned: Ephemeral tool output hidden, read ${lines} lines, result summarized in context memory]`;
          return {
            ...msg,
            content: replacement,
          };
        }
      }

      // Rule 2: Prune long reasoning content from assistant messages in prior turns
      // (The last assistant message is the current turn and should not be pruned here)
      const isLastAssistant = msg.role === "assistant" && index === messages.length - 1;
      if (msg.role === "assistant" && !isLastAssistant) {
        let updated = { ...msg };
        let hasChanges = false;

        if (typeof msg.reasoning === "string" && msg.reasoning.length > this.maxReasoningChars) {
          updated.reasoning = isZh
            ? "[推理内容已修剪]"
            : "[Reasoning pruned]";
          hasChanges = true;
        }

        if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > this.maxReasoningChars) {
          updated.reasoning_content = isZh
            ? "[推理内容已修剪]"
            : "[Reasoning content pruned]";
          hasChanges = true;
        }

        if (hasChanges) {
          return updated;
        }
      }

      return msg;
    });

    // Rule 3: Inject context memory snapshot if provided and not already present
    if (contextMemoryText && contextMemoryText.trim()) {
      const hasMemory = prunedMessages.some(
        (m) => m.role === "system" && m.content && typeof m.content === "string" && m.content.includes("CONTEXT_MEMORY")
      );
      if (!hasMemory) {
        // Find the system message to append or inject after the first system message
        const systemIdx = prunedMessages.findIndex((m) => m.role === "system");
        const memoryMessage: AgentMessage = {
          role: "system",
          content: `[CONTEXT_MEMORY]\n${contextMemoryText}`,
        };
        if (systemIdx !== -1) {
          prunedMessages.splice(systemIdx + 1, 0, memoryMessage);
        } else {
          prunedMessages.unshift(memoryMessage);
        }
      }
    }

    return prunedMessages;
  }
}
