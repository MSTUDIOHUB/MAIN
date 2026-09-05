/** Immutable Turn capability. Missing historical snapshots never grant network access. */
export interface NetworkReadPolicy {
  readonly enabled: boolean;
  readonly provider: "duckduckgo" | "bing" | "baidu";
}

export function normalizeNetworkRead(value: unknown): NetworkReadPolicy {
  const candidate = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const provider = candidate.provider;
  const valid = provider === "duckduckgo" || provider === "bing" || provider === "baidu";
  return Object.freeze({
    enabled: candidate.enabled === true && valid,
    provider: valid ? provider : "duckduckgo",
  });
}

export function captureNetworkRead(state: {
  readonly webSearchEnabled?: unknown;
  readonly webSearchProvider?: unknown;
}): NetworkReadPolicy {
  return normalizeNetworkRead({
    enabled: state.webSearchEnabled === true,
    provider: state.webSearchProvider || "duckduckgo",
  });
}
