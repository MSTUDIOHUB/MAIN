function pickFirstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function getErrorMessage(error: unknown, fallback = "Operation failed"): string {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (error instanceof Error) {
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message.trim();
    }

    const withExtra = error as Error & {
      reason?: unknown;
      cause?: unknown;
      detail?: unknown;
      details?: unknown;
    };
    const nested =
      getErrorMessage(withExtra.reason, "") ||
      getErrorMessage(withExtra.cause, "") ||
      getErrorMessage(withExtra.detail, "") ||
      getErrorMessage(withExtra.details, "");
    if (nested) return nested;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const direct = pickFirstString(record, ["message", "error", "reason", "detail", "details"]);
    if (direct) return direct;

    for (const key of ["cause", "data", "payload"]) {
      const nested = getErrorMessage(record[key], "");
      if (nested) return nested;
    }

    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Ignore JSON stringify failures and fall back below.
    }
  }

  return fallback;
}

export function toError(error: unknown, fallback = "Operation failed"): Error {
  const normalized = new Error(getErrorMessage(error, fallback));
  if (error instanceof Error && error.name) {
    normalized.name = error.name;
  }
  return normalized;
}
