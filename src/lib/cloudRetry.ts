export function isRetryableCloudErrorMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("http 502") ||
    normalized.includes("http 503") ||
    normalized.includes("http 504") ||
    normalized.includes("http 524") ||
    normalized.includes("bad gateway") ||
    normalized.includes("gateway timeout") ||
    normalized.includes("error code: 524") ||
    normalized.includes("upstream_error") ||
    normalized.includes("\"type\":\"server_error\"")
  );
}

export function isCloudGatewayTimeoutMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("http 524") || normalized.includes("error code: 524");
}
