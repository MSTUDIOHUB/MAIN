export interface SessionTranscriptPageMetadata {
  transcriptPartial: boolean;
  transcriptLoadedTurns: number;
  transcriptTotalTurns: number;
}

function normalizeTurnCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0
    ? Math.floor(count)
    : 0;
}

/**
 * Derives the persistence metadata for a loaded transcript window. A backend
 * `hasMore` signal is authoritative even if legacy metadata under-reports the
 * total; marking that window partial is what prevents a later save from
 * replacing the unloaded JSONL rows.
 */
export function resolveSessionTranscriptPageMetadata(input: {
  loadedTurns: unknown;
  totalTurns: unknown;
  hasMore?: boolean;
}): SessionTranscriptPageMetadata {
  const transcriptLoadedTurns = normalizeTurnCount(input.loadedTurns);
  const transcriptTotalTurns = Math.max(
    transcriptLoadedTurns,
    normalizeTurnCount(input.totalTurns),
  );
  return {
    transcriptPartial: input.hasMore === true || transcriptTotalTurns > transcriptLoadedTurns,
    transcriptLoadedTurns,
    transcriptTotalTurns,
  };
}
