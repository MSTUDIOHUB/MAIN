// lib/modelDiscovery.ts
// 发现本地 Provider 可用模型（Ollama / LM Studio / OMLX）
// 优先走各自官方接口，失败后回退到 OpenAI 兼容接口。

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function stripV1Suffix(endpoint: string): string {
  return endpoint.replace(/\/v1\/?$/i, "");
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} @ ${url}`);
  }
  return await response.json();
}

function dedupModels(list: string[]): string[] {
  return Array.from(new Set(list.map((m) => m.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function extractOpenAiModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) models.push(id);
  }
  return models;
}

async function fetchOpenAiCompatibleModels(endpoint: string): Promise<string[]> {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized) return [];
  const candidates = normalized.endsWith("/v1")
    ? [`${normalized}/models`, `${stripV1Suffix(normalized)}/models`]
    : [`${normalized}/v1/models`, `${normalized}/models`];

  for (const url of candidates) {
    try {
      const payload = await fetchJson(url);
      const models = extractOpenAiModelIds(payload);
      if (models.length > 0) return dedupModels(models);
    } catch {
      // 尝试下一个候选 URL
    }
  }
  return [];
}

async function fetchOllamaModels(endpoint: string): Promise<string[]> {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized) return [];
  const base = stripV1Suffix(normalized);
  const candidates = [`${base}/api/tags`, `${base}/api/ps`];

  for (const url of candidates) {
    try {
      const payload = await fetchJson(url);
      if (!payload || typeof payload !== "object") continue;
      const modelsRaw = (payload as { models?: unknown }).models;
      if (!Array.isArray(modelsRaw)) continue;
      const models: string[] = [];
      for (const item of modelsRaw) {
        if (!item || typeof item !== "object") continue;
        const name = (item as { name?: unknown; model?: unknown }).name ?? (item as { model?: unknown }).model;
        if (typeof name === "string" && name.trim()) models.push(name);
      }
      if (models.length > 0) return dedupModels(models);
    } catch {
      // 尝试下一个候选 URL
    }
  }

  // Ollama 也支持 OpenAI 兼容接口，作为回退
  return await fetchOpenAiCompatibleModels(normalized);
}

export async function discoverLocalModels(provider: string, endpoint: string): Promise<string[]> {
  if (provider === "Ollama") {
    return await fetchOllamaModels(endpoint);
  }
  // LM Studio / OMLX 默认走 OpenAI 兼容接口
  return await fetchOpenAiCompatibleModels(endpoint);
}

