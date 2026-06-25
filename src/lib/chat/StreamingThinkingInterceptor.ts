// src/lib/chat/StreamingThinkingInterceptor.ts
// Enhanced with non-tag thinking detection and thought-to-summary callback.
// ────────────────────────────────────────────────────────────────────

export const THINKING_TAG_NAMES = new Set(["thinking", "thought", "analysis", "reasoning"]);

/**
 * Non-tag thinking patterns used by Qwen and similar local models.
 */
const NON_TAG_THINKING_PREFIXES = [
  /^Thinking:/i,
  /^REASONING:/i,
  /^THOUGHT:/i,
  /^思考[：:]\s*/,
  /^INTERNAL_THINKING:/i,
  /^\[.*?reasoning.*?\]:\s*/i,
];

/**
 * Detect if text starts with a non-tag thinking pattern.
 */
function detectNonTagThinking(text: string): boolean {
  return NON_TAG_THINKING_PREFIXES.some(pat => pat.test(text));
}

export class StreamingThinkingInterceptor {
  private buffer = "";
  private inThinking = false;
  private pendingClose = "";
  private thinkingContent = "";
  private nonTagThinking = false;
  private onDroppedToken?: (token: string) => void;

  /**
   * Register a callback for dropped thinking tokens.
   * Useful for logging or accumulating a reasoning log.
   */
  setDroppedTokenCallback(cb: (token: string) => void): void {
    this.onDroppedToken = cb;
  }

  feed(
    token: string,
  ): {
    agent: string;
    thinking: string;
    thoughtStarted: boolean;
    thoughtEnded: boolean;
  } {
    let agent = "";
    let thinking = "";
    let thoughtStarted = false;
    let thoughtEnded = false;

    for (const ch of token) {
      if (this.inThinking) {
        this.pendingClose += ch;

        const closeRe = new RegExp(`^<\\/(${[...THINKING_TAG_NAMES].join("|")})>\\s*$`, "i");
        const m = this.pendingClose.match(closeRe);
        if (m) {
          this.inThinking = false;
          this.pendingClose = "";
          thoughtEnded = true;
          continue;
        }

        const couldBeCloseTag = /^<\/[a-zA-Z]*>?\s*$/.test(this.pendingClose);
        if (!couldBeCloseTag || this.pendingClose.length > 30) {
          thinking += this.pendingClose;
          this.thinkingContent += this.pendingClose;
          this.pendingClose = "";
        }
      } else if (this.nonTagThinking) {
        // Inside a non-tag thinking block (e.g., "Thinking: ...")
        thinking += ch;
        this.thinkingContent += ch;

        // End non-tag thinking if we detect a code block or substantial content shift
        if (thinking.includes("```") || ch === "\n" && this.thinkingContent.split("\n").length > 10) {
          // Check if we've seen actionable output after thinking
          const recentThinking = this.thinkingContent.slice(-200);
          if (/(?:apply|write|edit|run|execute|create|modify|use|call)/i.test(recentThinking)) {
            this.nonTagThinking = false;
          }
        }
      } else {
        // ── Normal mode — detect opening tags ──────────────────────
        this.buffer += ch;

        // Check for non-tag thinking prefixes first
        const fullBuffer = this.buffer;
        if (fullBuffer.length >= 7 && detectNonTagThinking(fullBuffer.trimEnd())) {
          this.nonTagThinking = true;
          this.buffer = "";
          this.thinkingContent = "";
          thoughtStarted = true;
          continue;
        }

        // Check for XML opening tags
        const openMatch = this.buffer.match(/^(<(?:thinking|thought|analysis|reasoning)(?:\s[^>]*)?>)([\s\S]*)/i);
        if (openMatch) {
          this.inThinking = true;
          this.buffer = "";
          this.thinkingContent = "";
          thoughtStarted = true;
          if (openMatch[2]) {
            thinking += openMatch[2];
            this.thinkingContent += openMatch[2];
          }
          continue;
        }

        // If buffer can't possibly form a tag, flush it as agent content
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

    // Notify callback about dropped tokens
    if (this.onDroppedToken && thinking) {
      this.onDroppedToken(thinking);
    }

    return { agent, thinking, thoughtStarted, thoughtEnded };
  }

  getThinkingContent(): string {
    return this.thinkingContent;
  }

  flush(): { agent: string; thinking: string; thoughtEnded: boolean } {
    let agent = "";
    let thinking = "";
    let thoughtEnded = false;

    if (this.inThinking) {
      if (this.pendingClose) {
        this.thinkingContent += this.pendingClose;
        this.pendingClose = "";
      }
      thoughtEnded = true;
      this.inThinking = false;
    }

    if (this.nonTagThinking) {
      thoughtEnded = true;
      this.nonTagThinking = false;
    }

    if (this.buffer) {
      agent = this.buffer;
      this.buffer = "";
    }

    return { agent, thinking, thoughtEnded };
  }

  reset() {
    this.buffer = "";
    this.inThinking = false;
    this.pendingClose = "";
    this.thinkingContent = "";
    this.nonTagThinking = false;
  }
}
