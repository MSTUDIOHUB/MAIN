// src/lib/chat/streamBuffer.ts

import { StreamingThinkingInterceptor } from "./StreamingThinkingInterceptor";

export interface StreamFlushData {
  agentDelta: string;
  thinkingDelta: string;
  thoughtStarted: boolean;
  thoughtEnded: boolean;
  rawChunk: string;
}

export class StreamingCadenceBuffer {
  private tokenBuffer = "";
  private flushTimerHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs: number;
  private readonly interceptor: StreamingThinkingInterceptor;
  private readonly onFlush: (data: StreamFlushData) => void;

  constructor(options: {
    flushIntervalMs?: number;
    interceptor: StreamingThinkingInterceptor;
    onFlush: (data: StreamFlushData) => void;
  }) {
    this.flushIntervalMs = options.flushIntervalMs ?? 90;
    this.interceptor = options.interceptor;
    this.onFlush = options.onFlush;
  }

  /** Append a new chunk/token of text. */
  append(token: string) {
    this.tokenBuffer += token;
    if (this.flushTimerHandle === null) {
      this.flushTimerHandle = setTimeout(() => this.flushBuffer(), this.flushIntervalMs);
    }
  }

  /** Force a flush of the current buffer. */
  flush() {
    if (this.flushTimerHandle !== null) {
      clearTimeout(this.flushTimerHandle);
      this.flushTimerHandle = null;
    }
    this.flushBuffer();
  }

  private flushBuffer() {
    const chunk = this.tokenBuffer;
    this.tokenBuffer = "";
    this.flushTimerHandle = null;

    if (!chunk) return;

    // Run through the interceptor
    const { agent, thinking, thoughtStarted, thoughtEnded } = this.interceptor.feed(chunk);

    this.onFlush({
      agentDelta: agent,
      thinkingDelta: thinking,
      thoughtStarted,
      thoughtEnded,
      rawChunk: chunk,
    });
  }

  /** Reset internal buffer and timers. */
  reset() {
    if (this.flushTimerHandle !== null) {
      clearTimeout(this.flushTimerHandle);
      this.flushTimerHandle = null;
    }
    this.tokenBuffer = "";
  }
}
