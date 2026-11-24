export const LOCAL_CONCURRENCY_HARD_CEILING = 8;

const GIB = 1024 ** 3;
const MIN_MEMORY_RESERVE_BYTES = 4 * GIB;
const MEMORY_RESERVE_RATIO = 0.10;
const MIN_CRITICAL_MEMORY_BYTES = 4 * GIB;
const CRITICAL_MEMORY_RATIO = 0.08;
const MIN_PER_STREAM_BUDGET_BYTES = 1.75 * GIB;
const DEFAULT_PER_STREAM_BUDGET_BYTES = 2.25 * GIB;
const MAX_PER_STREAM_BUDGET_BYTES = 3.0 * GIB;
const MIN_CONTEXT_TOKENS = 16_384;
const MID_LOW_CONTEXT_TOKENS = 131_072;
const MID_HIGH_CONTEXT_TOKENS = 150_000;
const MAX_CONTEXT_TOKENS = 262_144;
const FALLBACK_TOTAL_REQUESTS_LIMIT = 2;

export interface LocalConcurrencyEstimate {
  readonly totalRequestsLimit: number;   // 1..8 (includes parent)
  readonly recommendedSubagents: number; // Math.max(0, totalRequestsLimit - 1)
  readonly memoryReserveBytes: number;   // max(4 GiB, totalBytes * 0.10)
  readonly criticalMemoryBytes: number;  // max(4 GiB, totalBytes * 0.08)
  readonly perStreamBudgetBytes: number; // ~2.25 GiB bounded KV delta per extra stream (smoothly scaled [1.75 GiB, 3.0 GiB] with contextLimit, defaulting to 2.25 GiB at ~128K-150K)
  readonly source: "configured" | "memory" | "fallback";
  readonly totalGb: number | null;
  readonly availableGb: number | null;
}

function finitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

function estimatePerStreamBudgetBytes(contextLimit?: number | null): number {
  const tokens = finitePositiveNumber(contextLimit);
  if (tokens === null) return DEFAULT_PER_STREAM_BUDGET_BYTES;
  if (tokens <= MIN_CONTEXT_TOKENS) return MIN_PER_STREAM_BUDGET_BYTES;
  if (tokens < MID_LOW_CONTEXT_TOKENS) {
    const ratio = (tokens - MIN_CONTEXT_TOKENS) / (MID_LOW_CONTEXT_TOKENS - MIN_CONTEXT_TOKENS);
    return MIN_PER_STREAM_BUDGET_BYTES +
      ratio * (DEFAULT_PER_STREAM_BUDGET_BYTES - MIN_PER_STREAM_BUDGET_BYTES);
  }
  if (tokens <= MID_HIGH_CONTEXT_TOKENS) return DEFAULT_PER_STREAM_BUDGET_BYTES;
  if (tokens >= MAX_CONTEXT_TOKENS) return MAX_PER_STREAM_BUDGET_BYTES;
  const ratio = (tokens - MID_HIGH_CONTEXT_TOKENS) / (MAX_CONTEXT_TOKENS - MID_HIGH_CONTEXT_TOKENS);
  return DEFAULT_PER_STREAM_BUDGET_BYTES +
    ratio * (MAX_PER_STREAM_BUDGET_BYTES - DEFAULT_PER_STREAM_BUDGET_BYTES);
}

/**
 * Estimate safe local model concurrency (total requests including the parent)
 * from system memory headroom and safety reserves, or honor an explicit positive
 * user override capped at LOCAL_CONCURRENCY_HARD_CEILING.
 */
export function estimateLocalConcurrencyFromMemory(input: {
  readonly totalBytes?: number | null;
  readonly availableBytes?: number | null;
  readonly contextLimit?: number | null;
  readonly configuredMaxActiveRequests?: number | null;
}): LocalConcurrencyEstimate {
  const totalBytes = finitePositiveNumber(input.totalBytes);
  const availableBytes = finitePositiveNumber(input.availableBytes);
  const configured = positiveSafeInteger(input.configuredMaxActiveRequests);
  const effectiveTotalBytes = totalBytes ?? availableBytes;
  const memoryReserveBytes = effectiveTotalBytes !== null
    ? Math.max(MIN_MEMORY_RESERVE_BYTES, effectiveTotalBytes * MEMORY_RESERVE_RATIO)
    : MIN_MEMORY_RESERVE_BYTES;
  const criticalMemoryBytes = effectiveTotalBytes !== null
    ? Math.max(MIN_CRITICAL_MEMORY_BYTES, effectiveTotalBytes * CRITICAL_MEMORY_RATIO)
    : MIN_CRITICAL_MEMORY_BYTES;
  const perStreamBudgetBytes = estimatePerStreamBudgetBytes(input.contextLimit);
  const totalGb = totalBytes !== null ? totalBytes / GIB : null;
  const availableGb = availableBytes !== null ? availableBytes / GIB : null;

  if (configured !== null) {
    const totalRequestsLimit = Math.min(LOCAL_CONCURRENCY_HARD_CEILING, configured);
    return {
      totalRequestsLimit,
      recommendedSubagents: Math.max(0, totalRequestsLimit - 1),
      memoryReserveBytes,
      criticalMemoryBytes,
      perStreamBudgetBytes,
      source: "configured",
      totalGb,
      availableGb,
    };
  }

  if (availableBytes !== null) {
    const headroom = Math.max(0, availableBytes - memoryReserveBytes);
    const totalRequestsLimit = Math.min(
      LOCAL_CONCURRENCY_HARD_CEILING,
      Math.max(1, Math.floor(headroom / perStreamBudgetBytes) + 1),
    );
    return {
      totalRequestsLimit,
      recommendedSubagents: Math.max(0, totalRequestsLimit - 1),
      memoryReserveBytes,
      criticalMemoryBytes,
      perStreamBudgetBytes,
      source: "memory",
      totalGb,
      availableGb,
    };
  }

  return {
    totalRequestsLimit: FALLBACK_TOTAL_REQUESTS_LIMIT,
    recommendedSubagents: Math.max(0, FALLBACK_TOTAL_REQUESTS_LIMIT - 1),
    memoryReserveBytes,
    criticalMemoryBytes,
    perStreamBudgetBytes,
    source: "fallback",
    totalGb,
    availableGb,
  };
}
