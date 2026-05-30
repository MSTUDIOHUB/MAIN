// src/lib/chat/StreamingThinkingInterceptor.ts

export const THINKING_TAG_NAMES = new Set(["thinking", "thought", "analysis", "reasoning"]);

export class StreamingThinkingInterceptor {
  private buffer = "";          // raw token accumulation for tag detection
  private inThinking = false;   // currently inside a thinking tag?
  private pendingClose = "";    // partial closing tag being accumulated
  private thinkingContent = ""; // accumulated content inside the thinking tag

  /** Feed a new token; returns { agent, thinking, thoughtStarted, thoughtEnded } with the split content. */
  feed(token: string): { agent: string; thinking: string; thoughtStarted: boolean; thoughtEnded: boolean } {
    let agent = "";
    let thinking = "";
    let thoughtStarted = false;
    let thoughtEnded = false;

    for (const ch of token) {
      if (this.inThinking) {
        // ── Inside a thinking block ──
        // Accumulate into pendingClose buffer for closing tag detection.
        // Only flush when we're certain it can't form a closing tag.
        this.pendingClose += ch;

        // Try to match a complete closing tag
        const closeRe = new RegExp(`^<\\/(${[...THINKING_TAG_NAMES].join("|")})>\\s*$`, "i");
        const m = this.pendingClose.match(closeRe);
        if (m) {
          // Full closing tag found — end thinking mode
          this.inThinking = false;
          this.pendingClose = "";
          thoughtEnded = true;
          continue;
        }

        // If the buffer can't possibly form a closing tag anymore, flush as thinking content
        // A potential closing tag looks like: </word> with optional trailing whitespace
        const couldBeCloseTag = /^<\/[a-zA-Z]*>?\s*$/.test(this.pendingClose);
        if (!couldBeCloseTag || this.pendingClose.length > 30) {
          thinking += this.pendingClose;
          this.thinkingContent += this.pendingClose;
          this.pendingClose = "";
        }
        // Otherwise keep buffering — it might still become a closing tag
      } else {
        // ── Normal mode — detect opening tags ──
        this.buffer += ch;

        // Check if buffer forms a complete opening tag
        const openMatch = this.buffer.match(/^(<(?:thinking|thought|analysis|reasoning)(?:\s[^>]*)?>)([\s\S]*)/i);
        if (openMatch) {
          // Switch to thinking mode
          this.inThinking = true;
          this.buffer = "";
          this.thinkingContent = "";
          thoughtStarted = true;
          // Any content after the tag is thinking content
          if (openMatch[2]) {
            thinking += openMatch[2];
            this.thinkingContent += openMatch[2];
          }
          continue;
        }

        // If buffer can't possibly form a tag anymore, flush it as agent content
        // A potential tag starts with '<' and contains only alpha chars so far
        if (this.buffer.length > 0) {
          const couldBeTag = /^<[a-zA-Z]*$/.test(this.buffer) ||
                             /^<[a-zA-Z]+\s*$/.test(this.buffer) ||
                             /^<[a-zA-Z]+[^>]*$/.test(this.buffer);
          if (!couldBeTag || this.buffer.length > 30) {
            agent += this.buffer;
            this.buffer = "";
          }
          // Otherwise keep buffering — it might become a tag
        }
      }
    }

    return { agent, thinking, thoughtStarted, thoughtEnded };
  }

  /** Get the accumulated thinking content so far. */
  getThinkingContent(): string { return this.thinkingContent; }

  /** Flush any remaining buffer (call at stream end). */
  flush(): { agent: string; thinking: string; thoughtEnded: boolean } {
    let agent = "";
    let thinking = "";
    let thoughtEnded = false;

    if (this.inThinking) {
      // Unclosed thinking tag — treat remaining as thinking content and close
      if (this.pendingClose) {
        this.thinkingContent += this.pendingClose;
        this.pendingClose = "";
      }
      thinking = ""; // no new content, but signal that the thought ended
      thoughtEnded = true;
      this.inThinking = false;
    }

    // Flush any remaining agent buffer
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
