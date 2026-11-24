import { writeFile } from "node:fs/promises";

export type RealOmlxStreamPhase = "response_headers" | "first_chunk" | "idle_chunk";

/** Test transport counterpart of Rust's per-phase inactivity watchdog. */
export function createRealOmlxStreamInactivity(timeoutMs: number | null, now = Date.now) {
  let phase: RealOmlxStreamPhase = "response_headers";
  let deadlineAt = timeoutMs === null ? null : now() + timeoutMs;
  return {
    get phase() { return phase; },
    headersReceived() {
      phase = "first_chunk";
      deadlineAt = timeoutMs === null ? null : now() + timeoutMs;
    },
    observeChunk(bytes: number) {
      // Byte progress includes split UTF-8, reasoning-only and tool-only SSE.
      if (bytes <= 0) return;
      phase = "idle_chunk";
      deadlineAt = timeoutMs === null ? null : now() + timeoutMs;
    },
    async wait<T>(task: () => Promise<T>): Promise<T> {
      if (deadlineAt === null) return task();
      const remaining = deadlineAt - now();
      const error = () => new Error(`STREAM_REQUEST_TIMEOUT: ${phase} exceeded the ${timeoutMs}ms inactivity deadline`);
      if (remaining <= 0) throw error();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([task(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(error()), remaining);
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
}

/** Finalization is first-writer-only: cancellation cannot become a complete SSE. */
export function createRealOmlxStreamCapture(evidencePath?: string, maxChars = 200_000) {
  let totalChars = 0;
  let totalBytes = 0;
  let chunks = 0;
  let responseText = "";
  let finalization: Promise<void> | undefined;
  return {
    get chars() { return totalChars; },
    get responseText() { return responseText; },
    get preview() { return responseText.slice(0, 180); },
    append(text: string, bytes: number) {
      if (finalization) return;
      totalChars += text.length;
      totalBytes += bytes;
      if (bytes > 0) chunks += 1;
      responseText = (responseText + text).slice(0, maxChars);
    },
    finish(complete: boolean, reason: string | null, phase?: RealOmlxStreamPhase): Promise<void> {
      if (finalization) return finalization;
      const metadata = { totalChars, recordedChars: responseText.length, totalBytes, chunks,
        truncated: !complete || totalChars > responseText.length, complete, incomplete: !complete,
        incompleteReason: complete ? null : reason, phase: phase ?? null };
      finalization = evidencePath ? (async () => {
        await writeFile(`${evidencePath}.response.sse`, responseText);
        await writeFile(`${evidencePath}.response-meta.json`, JSON.stringify(metadata, null, 2));
      })() : Promise.resolve();
      return finalization;
    },
  };
}
