export function endpointLooksOpenAiCompatible(endpoint?: string | null): boolean {
  const raw = String(endpoint || "").trim();
  if (!raw) return false;

  try {
    const parsed = new URL(raw);
    return parsed.pathname.replace(/\/+$/, "").toLowerCase().endsWith("/v1");
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase().endsWith("/v1");
  }
}

export function shouldUseRustProxyForLocalProvider(provider?: string | null, endpoint?: string | null): boolean {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider !== "ollama") return true;

  // Native Ollama /api/chat can stay frontend-direct; OpenAI-compatible /v1
  // endpoints have hit WebView "Load failed" and should use the Rust proxy.
  return endpointLooksOpenAiCompatible(endpoint);
}
