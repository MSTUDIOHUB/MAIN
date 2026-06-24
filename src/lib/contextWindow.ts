function parseTokenCount(value: string): number | null {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 1024 ? parsed : null;
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
      ? Math.min(configuredLimit, 4096)
      : Math.min(configuredLimit, reportedContextLimit),
    reportedContextLimit,
  };
}
