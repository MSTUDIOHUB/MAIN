// src/lib/orchestrator/state/ReasoningStrainer.ts

import type { AgentMessage } from "../types";

export interface ReasoningPurgeOptions {
  language?: "zh" | "en";
  maxReasoningChars?: number;
}

export class ReasoningStrainer {
  private language: "zh" | "en";

  constructor(options: ReasoningPurgeOptions = {}) {
    this.language = options.language ?? "zh";
  }

  /**
   * Purges reasoning fields from historical assistant messages, leaving only the current turn intact.
   */
  purgeReasoning(messages: AgentMessage[]): AgentMessage[] {
    const isZh = this.language === "zh";

    return messages.map((msg, index) => {
      // Keep the current/latest assistant message's reasoning intact so the orchestrator can display it
      const isLastAssistant = msg.role === "assistant" && index === messages.length - 1;
      if (msg.role === "assistant" && !isLastAssistant) {
        const updated = { ...msg };
        
        // Strip reasoning fields entirely for historical messages
        if (updated.reasoning !== undefined) {
          delete updated.reasoning;
        }
        if (updated.reasoning_content !== undefined) {
          delete updated.reasoning_content;
        }

        // Clean leaked thinking tags inside visual content if any
        if (typeof updated.content === "string") {
          let cleanedContent = updated.content;
          
          // Pattern matching for typical thinking tags: <thinking>...</thinking>
          const tags = ["thinking", "thought", "analysis", "reasoning"];
          for (const tag of tags) {
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
