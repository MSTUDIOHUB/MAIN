import { StreamingThoughtSummarizer } from "./StreamingThoughtSummarizer";

export const THINKING_TAG_NAMES = new Set(["thinking", "thought", "analysis", "reasoning"]);

export class StreamingThinkingInterceptor {
  private buffer = "";          // raw token accumulation for tag detection
  private inThinking = false;   // currently inside a thinking tag?
  private pendingClose = "";    // partial closing tag being accumulated
  private thinkingContent = ""; // accumulated content inside the thinking tag
  private onTokenDroppedCallback?: (token: string) => void;
  private language: "zh" | "en" = "zh";

  constructor(options?: { onTokenDropped?: (token: string) => void; language?: "zh" | "en" }) {
    this.onTokenDroppedCallback = options?.onTokenDropped;
    this.language = options?.language ?? "zh";
  }

  /** Feed a new token; returns { agent, thinking, thoughtStarted, thoughtEnded } with the split content. */
  feed(token: string): { agent: string; thinking: string; thoughtStarted: boolean; thoughtEnded: boolean } {
    let agent = "";
    let thinking = "";
    let thoughtStarted = false;
    let thoughtEnded = false;

    // Detect non-tagged thinking start patterns e.g., "Thinking:", "REASONING:", "THOUGHT:", "思考：", "思考"
    const untaggedPatterns = [
      /^Thinking:\s*/i,
      /^REASONING:\s*/i,
      /^THOUGHT:\s*/i,
      /^思考：\s*/,
      /^思考\s*/
    ];

    for (const ch of token) {
      if (this.inThinking) {
        // ── Inside a thinking block ──
        this.pendingClose += ch;

        // Try to match a complete closing tag
        const closeRe = new RegExp(`^<\\/(${[...THINKING_TAG_NAMES].join("|")})>\\s*$`, "i");
        const m = this.pendingClose.match(closeRe);
        if (m) {
          this.inThinking = false;
          this.pendingClose = "";
          thoughtEnded = true;
          continue;
        }

        // If it looks like we're encountering a new codeblock or tag and it can't possibly close, flush it
        const couldBeCloseTag = /^<\/[a-zA-Z]*>?\s*$/.test(this.pendingClose);
        if (!couldBeCloseTag || this.pendingClose.length > 30) {
          thinking += this.pendingClose;
          this.thinkingContent += this.pendingClose;
          if (this.onTokenDroppedCallback) {
            this.onTokenDroppedCallback(this.pendingClose);
          }
          this.pendingClose = "";
        }
      } else {
        // ── Normal mode ──
        this.buffer += ch;

        // Check if buffer forms a complete opening tag
        const openMatch = this.buffer.match(/^(<(?:thinking|thought|analysis|reasoning)(?:\s[^>]*)?>)([\s\S]*)/i);
        if (openMatch) {
          this.inThinking = true;
          this.buffer = "";
          this.thinkingContent = "";
          thoughtStarted = true;
          if (openMatch[2]) {
            thinking += openMatch[2];
            this.thinkingContent += openMatch[2];
            if (this.onTokenDroppedCallback) {
              this.onTokenDroppedCallback(openMatch[2]);
            }
          }
          continue;
        }

        // Detect non-tagged thinking prefix patterns
        let matchedUntagged = false;
        for (const pattern of untaggedPatterns) {
          if (pattern.test(this.buffer)) {
            this.inThinking = true;
            this.buffer = "";
            this.thinkingContent = "";
            thoughtStarted = true;
            matchedUntagged = true;
            break;
          }
        }
        if (matchedUntagged) {
          continue;
        }

        // Flush buffer to agent content
        if (this.buffer.length > 0) {
          const couldBeTag = /^<[a-zA-Z]*$/.test(this.buffer) ||
                             /^<[a-zA-Z]+\s*$/.test(this.buffer) ||
                             /^<[a-zA-Z]+[^>]*$/.test(this.buffer);
          if (!couldBeTag || this.buffer.length > 30) {
            agent += this.buffer;
            this.buffer = "";
          }
        }
      }
    }

    return { agent, thinking, thoughtStarted, thoughtEnded };
  }

  /** Get the accumulated thinking content so far. */
  getThinkingContent(): string { return this.thinkingContent; }

  /** Convert raw thinking content to compact heuristic summary. */
  thoughtToSummary(maxChars: number = 100): string {
    return StreamingThoughtSummarizer.thoughtToSummary(this.thinkingContent, maxChars, this.language);
  }

  /** Flush any remaining buffer (call at stream end). */
  flush(): { agent: string; thinking: string; thoughtEnded: boolean } {
    let agent = "";
    let thinking = "";
    let thoughtEnded = false;

    if (this.inThinking) {
      if (this.pendingClose) {
        this.thinkingContent += this.pendingClose;
        if (this.onTokenDroppedCallback) {
          this.onTokenDroppedCallback(this.pendingClose);
        }
        this.pendingClose = "";
      }
      thoughtEnded = true;
      this.inThinking = false;
    }

    if (this.buffer) {
      agent = this.buffer;
      this.buffer = "";
    }

    return { agent, thinking, thoughtEnded };
  }

  /** Reset state for reuse. */
  reset() {
    this.buffer = "";
    this.inThinking = false;
    this.pendingClose = "";
    this.thinkingContent = "";
  }
}
