function parseTokenCount(value: string): number | null {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 1024 ? parsed : null;
}

const UNKNOWN_CONTEXT_RETRY_HEADROOM_RATIO = 0.7;
const MIN_REACTIVE_CONTEXT_LIMIT = 4096;

const EXPLICIT_CONTEXT_ERROR_PATTERNS = [
  /CONTEXT_LENGTH_EXCEEDED/i,
  /context_length_exceeded/i,
  /maximum context length/i,
  /max(?:imum)? context window/i,
  /prompt too long/i,
  /context too (?:large|long)/i,
  /prefill memory guard/i,
  /token limit(?: exceeded)?/i,
  /number of tokens to keep.*context length/i,
];

export function isExplicitContextWindowError(message: string): boolean {
  const text = String(message || "");
  if (!text.trim()) return false;
  if (/empty completion/i.test(text)) return false;
  return EXPLICIT_CONTEXT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export function extractReportedContextWindowLimit(message: string): number | null {
  const text = String(message || "");
  const patterns = [
    /max(?:imum)?\s+context\s+window\s+of\s+([\d,]+)/i,
    /max(?:imum)?\s+context\s+length\s+(?:is|of)\s+([\d,]+)/i,
    /context\s+window\s+(?:is|of)\s+([\d,]+)/i,
    /context\s+length\s+(?:is|of)\s+([\d,]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const limit = match?.[1] ? parseTokenCount(match[1]) : null;
    if (limit != null) return limit;
  }

  return null;
}

export function clampContextLimitToReported(
  configuredLimit: number,
  errorMessage: string,
): { contextLimit: number; reportedContextLimit: number | null } {
  const reportedContextLimit = extractReportedContextWindowLimit(errorMessage);
  return {
    contextLimit: reportedContextLimit == null
      ? configuredLimit
      : Math.min(configuredLimit, reportedContextLimit),
    reportedContextLimit,
  };
}

export function resolveReactiveContextLimit(
  estimatedCurrentTokens: number,
  errorMessage: string,
): {
  contextLimit: number;
  reportedContextLimit: number | null;
  source: "reported" | "estimated_headroom";
} {
  const reportedContextLimit = extractReportedContextWindowLimit(errorMessage);
  if (reportedContextLimit != null) {
    return {
      contextLimit: reportedContextLimit,
      reportedContextLimit,
      source: "reported",
    };
  }
  const safeEstimatedTokens = Number.isFinite(estimatedCurrentTokens)
    ? Math.max(0, estimatedCurrentTokens)
    : 0;
  return {
    contextLimit: Math.max(
      MIN_REACTIVE_CONTEXT_LIMIT,
      Math.floor(safeEstimatedTokens * UNKNOWN_CONTEXT_RETRY_HEADROOM_RATIO),
    ),
    reportedContextLimit: null,
    source: "estimated_headroom",
  };
}
