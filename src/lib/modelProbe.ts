import type { Lang } from "../store/useAppStore";

export interface ModelCapabilities {
  instructionLanguage: "en" | "zh";
  responseLanguage: "en" | "zh";
  capabilityLevel: 0 | 1 | 2 | 3;
  likelyQuantized: boolean;
  cacheKey: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let _cache = new Map<string, { caps: ModelCapabilities; ts: number }>();

export function analyzeProbeResponse(
  response: string,
  probeLanguage: "zh" | "en",
): Partial<ModelCapabilities> {
  const trimmed = response.trim();
  const result: Partial<ModelCapabilities> = {};

  if (response.includes("中文") || response.includes("简体中文")) {
    result.responseLanguage = "zh";
    if (probeLanguage === "zh") result.instructionLanguage = "zh";
  } else if (/english|en/i.test(response)) {
    result.responseLanguage = "en";
    if (probeLanguage === "en") result.instructionLanguage = "en";
  }

  // Length compliance as quantization indicator
  if (probeLanguage === "zh" && trimmed.length > 80) {
    result.likelyQuantized = true;
    result.capabilityLevel = (trimmed.length > 300 ? 0 : 1) as 0 | 1;
  } else if (probeLanguage === "en" && trimmed.length > 50) {
    result.likelyQuantized = true;
    result.capabilityLevel = (trimmed.length > 200 ? 0 : 1) as 0 | 1;
  } else if (trimmed.length <= 5) {
    result.capabilityLevel = Math.max(result.capabilityLevel ?? 2, 2) as 2 | 3;
    result.likelyQuantized = false;
  }

  if (!result.instructionLanguage) result.instructionLanguage = probeLanguage;
  if (!result.responseLanguage) result.responseLanguage = probeLanguage;

  return result;
}

export type ProbeRunner = (
  probeMessage: string,
  model: string,
  provider: string,
) => Promise<string>;

const ZH_PROBE = "你只能输出 3 个字符以内：中文，然后结束。";
const EN_PROBE = "Only output 3 characters or less: English, then stop.";

export async function runModelProbe(
  runner: ProbeRunner,
  model: string,
  provider: string,
): Promise<ModelCapabilities> {
  const cacheKey = `probe:${provider.toLowerCase()}:${model.toLowerCase()}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.caps;

  let result: string;
  let used: "zh" | "en";

  try {
    result = await runner(ZH_PROBE, model, provider);
    used = "zh";
  } catch {
    try {
      result = await runner(EN_PROBE, model, provider);
      used = "en";
    } catch {
      const fallback = buildFallback(model, provider);
      _cache.set(cacheKey, { caps: fallback, ts: Date.now() });
      return fallback;
    }
  }

  const analysis = analyzeProbeResponse(result, used);
  const caps: ModelCapabilities = {
    instructionLanguage: analysis.instructionLanguage ?? used,
    responseLanguage: analysis.responseLanguage ?? used,
    capabilityLevel: (analysis.capabilityLevel ?? 2) as 0 | 1 | 2 | 3,
    likelyQuantized: analysis.likelyQuantized ?? false,
    cacheKey,
  };

  _cache.set(cacheKey, { caps, ts: Date.now() });
  return caps;
}

function buildFallback(model: string, provider: string): ModelCapabilities {
  const key = `fallback:${provider.toLowerCase()}:${model.toLowerCase()}`;
  return {
    instructionLanguage: "zh",
    responseLanguage: "zh",
    capabilityLevel: 2,
    likelyQuantized: false,
    cacheKey: key,
  };
}

export function getCachedCapabilities(cacheKey: string): ModelCapabilities | null {
  const cached = _cache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.ts >= CACHE_TTL_MS) {
    _cache.delete(cacheKey);
    return null;
  }
  return cached.caps;
}

export function heuristicDetectCapabilities(
  model: string,
  userLang: Lang,
): ModelCapabilities {
  const key = `heur:${model.toLowerCase()}`;
  const lower = model.toLowerCase();
  const isQuantized = /q[2-8]|8bit|6bit|4bit|nf4|awq|gptq|it[2-4]|gguf/i.test(lower);

  if (isQuantized) {
    return {
      instructionLanguage: userLang === "en" ? "en" : "zh",
      responseLanguage: userLang === "en" ? "en" : "zh",
      capabilityLevel: 1,
      likelyQuantized: true,
      cacheKey: key,
    };
  }

  const enPrimary = /gpt|claude|gemini|llama|mistral|deepseek|yi|internlm|mixtral/i.test(lower);
  const zhPrimary = /qwen[0-9]|glm|chatglm/i.test(lower);

  if (zhPrimary) {
    return {
      instructionLanguage: "zh",
      responseLanguage: userLang === "en" ? "en" : "zh",
      capabilityLevel: 3,
      likelyQuantized: false,
      cacheKey: key,
    };
  }
  if (enPrimary) {
    return {
      instructionLanguage: "en",
      responseLanguage: userLang === "en" ? "en" : "zh",
      capabilityLevel: 3,
      likelyQuantized: false,
      cacheKey: key,
    };
  }

  return {
    instructionLanguage: userLang === "en" ? "en" : "zh",
    responseLanguage: userLang === "en" ? "en" : "zh",
    capabilityLevel: 2,
    likelyQuantized: false,
    cacheKey: key,
  };
}

export function getAllCapabilities(): Record<string, ModelCapabilities> {
  const out: Record<string, ModelCapabilities> = {};
  for (const [key, { caps }] of _cache) {
    out[key] = caps;
  }
  return out;
}

export function loadCapabilities(data: Record<string, ModelCapabilities>): void {
  for (const [key, caps] of Object.entries(data)) {
    _cache.set(key, { caps, ts: Date.now() });
  }
}

export function clearCapabilities(): void {
  _cache.clear();
}

// ── Probe Runner Implementation ─────────────────────────────────────
// Makes a lightweight LLM call to probe model capabilities.
// Uses the same API pattern as the streaming module but without the complexity.


export async function makeProbeCall(
  provider: string,
  model: string,
  probeMessage: string,
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const isAnthropic = provider.toLowerCase().includes("anthropic") ||
    provider.toLowerCase().includes("claude");

  let body: Record<string, unknown>;
  let url: string;

  if (isAnthropic) {
    url = `${baseUrl.replace(/\/v\d+\/?$/, "")}/v1/messages`;
    body = {
      model,
      max_tokens: 50,
      messages: [{ role: "user", content: probeMessage }],
    };
  } else {
    // OpenAI-compatible (Ollama, OpenRouter, etc.)
    url = `${baseUrl.replace(/\/?$/, "")}/chat/completions`;
    body = {
      model,
      messages: [{ role: "user", content: probeMessage }],
      max_tokens: 50,
      stream: false,
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  // Anthropic-specific header
  if (isAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`Probe call failed: ${resp.status} ${resp.statusText}`);
  }

  const json = await resp.json();
  if (isAnthropic) {
    return json.content?.[0]?.text ?? "";
  }
  return json.choices?.[0]?.message?.content ?? "";
}

export type ProbeCallFactory = (
  provider: string,
  model: string,
  baseUrl: string,
  apiKey: string,
) => (probeMessage: string) => Promise<string>;

export function createProbeRunner(
  provider: string,
  model: string,
  baseUrl: string,
  apiKey: string,
): ProbeRunner {
  return (probeMessage: string) =>
    makeProbeCall(provider, model, probeMessage, baseUrl, apiKey);
}
