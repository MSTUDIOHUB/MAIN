export const WEB_SEARCH_PROVIDERS = ["yahoo", "quark", "duckduckgo", "bing", "baidu"] as const;
export type WebSearchProvider = typeof WEB_SEARCH_PROVIDERS[number];
export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProvider = "yahoo";

export function normalizeWebSearchProvider(value: unknown): WebSearchProvider {
  return (WEB_SEARCH_PROVIDERS as readonly unknown[]).includes(value)
    ? value as WebSearchProvider : DEFAULT_WEB_SEARCH_PROVIDER;
}

/** Immutable Turn capability. Missing historical snapshots never grant network access. */
export interface NetworkReadPolicy {
  readonly enabled: boolean;
  readonly provider: WebSearchProvider;
}

export function normalizeNetworkRead(value: unknown): NetworkReadPolicy {
  const candidate = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const provider = candidate.provider;
  const valid = (WEB_SEARCH_PROVIDERS as readonly unknown[]).includes(provider);
  return Object.freeze({
    enabled: candidate.enabled === true && valid,
    provider: normalizeWebSearchProvider(provider),
  });
}

export function captureNetworkRead(state: {
  readonly webSearchEnabled?: unknown;
  readonly webSearchProvider?: unknown;
}): NetworkReadPolicy {
  return normalizeNetworkRead({
    enabled: state.webSearchEnabled === true,
    provider: state.webSearchProvider || DEFAULT_WEB_SEARCH_PROVIDER,
  });
}
