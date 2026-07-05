import { getSystemMemory } from "./ipc";
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

/**
 * Attempt to discover the physical size (in bytes) of a specific model.
 * Important for calculating dynamic KV cache limits.
 */
export async function fetchLocalModelSize(provider: string, endpoint: string, model: string): Promise<number | null> {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized || !model) return null;

  if (provider === "Ollama") {
    try {
      const base = stripV1Suffix(normalized);
      const payload = await fetchJson(`${base}/api/tags`);
      if (payload && typeof payload === "object") {
        const modelsRaw = (payload as { models?: unknown }).models;
        if (Array.isArray(modelsRaw)) {
          const match = modelsRaw.find((item) => {
            if (!item || typeof item !== "object") return false;
            const name = (item as { name?: unknown }).name ?? (item as { model?: unknown }).model;
            return name === model;
          });
          if (match && typeof (match as any).size === "number") {
            return (match as any).size as number;
          }
        }
      }
    } catch {
      // Fall through to null on error
    }
  }

  // OMLX / LM Studio currently do not expose a reliable universal endpoint for model byte size
  return null;
}

/**
 * Dynamically computes a safe local context limit based on hardware RAM and model size.
 * Handles the "late-loading" problem where models are not in memory until the first API call.
 * 
 * @param provider "Ollama" or "OMLX"
 * @param endpoint The API endpoint
 * @param model The model name
 * @param configuredLimit The fallback limit configured by the user (e.g. 16384)
 * @returns The dynamically calculated context limit.
 */
export async function computeDynamicLocalContextLimit(
  provider: string,
  endpoint: string,
  model: string,
  configuredLimit: number
): Promise<number> {
  try {
    // 1. Get physical memory stats
    const memInfo = await getSystemMemory();
    const availableRamBytes = memInfo.available_bytes;
    
    // 2. Estimate or fetch model size
    let modelSizeBytes = await fetchLocalModelSize(provider, endpoint, model);
    if (modelSizeBytes === null) {
      // Fallback: Assume an 8B model size (approx 5GB)
      modelSizeBytes = 5 * 1024 * 1024 * 1024;
    }

    // 3. Calculate safe KV cache RAM
    // If available RAM is large enough to hold the model AND leave room, it's not loaded yet.
    // We use a strict safe formula: Max(0, Available RAM - Model Size - 1.5GB Safety Buffer)
    const safetyBufferBytes = 1.5 * 1024 * 1024 * 1024; // 1.5GB for OS spikes
    let safeKvCacheBytes = availableRamBytes - modelSizeBytes - safetyBufferBytes;

    // If safeKvCacheBytes is negative, it might be because the model is ALREADY loaded.
    // Let's check if the Available RAM itself (minus safety) is large enough for KV cache.
    // If model is already loaded, `availableRamBytes` is what we actually have left for KV cache.
    if (safeKvCacheBytes < 0) {
      safeKvCacheBytes = Math.max(0, availableRamBytes - safetyBufferBytes);
    }

    if (safeKvCacheBytes <= 0) {
      // Extremely low memory, fallback to absolute minimum safe limit
      return Math.min(configuredLimit, 4096);
    }

    // 4. Convert Bytes to Tokens (Heuristic)
    // 1GB of KV Cache ≈ 16384 tokens for an 8B model (very roughly)
    // safeKvCacheBytes / 1GB * 16384
    const ONE_GB = 1024 * 1024 * 1024;
    const tokensPerGb = 16384;
    const dynamicTokens = Math.floor((safeKvCacheBytes / ONE_GB) * tokensPerGb);

    // 5. Clamp the result
    // Don't exceed 131072 (128K) arbitrarily for local models to prevent extreme slow down, 
    // and never drop below 4096.
    const clampedLimit = Math.max(4096, Math.min(131072, dynamicTokens));

    // If the dynamic limit allows MORE than the configured limit, use the dynamic one!
    // This achieves the "dynamically release performance" goal.
    return Math.max(configuredLimit, clampedLimit);

  } catch (err) {
    console.warn("Failed to dynamically compute local context limit, using configured fallback:", err);
    return configuredLimit;
  }
}

