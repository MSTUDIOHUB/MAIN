import type { Lang } from "./appTypes";

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

  // Language detection
  if (response.includes("中文") || response.includes("简体中文")) {
    result.responseLanguage = "zh";
    if (probeLanguage === "zh") result.instructionLanguage = "zh";
  } else if (/english|en/i.test(response)) {
    result.responseLanguage = "en";
    if (probeLanguage === "en") result.instructionLanguage = "en";
  }

  // Capability detection: model was asked to output ≤3 chars
  // Clean response (only the target word, minimal or zero extra chars) → strong
  // Verbose response (explanations, greetings, extra text) → weaker
  const isClean = (probeLanguage === "zh" && 
    /^中文[。,.!！\s]*$/i.test(trimmed)) ||
    (probeLanguage === "en" && 
    /^english[。,.!!\s]*$/i.test(trimmed));

  if (isClean) {
    result.capabilityLevel = 3;
    result.likelyQuantized = false;
  } else if (trimmed.length > 0) {
    // Some response was given, but not clean — weak compliance
    // Distinguish between quantized weakness (very short garbled) vs capability (verbose)
    if (trimmed.length < 4) {
      result.capabilityLevel = 1;
      result.likelyQuantized = true;
    } else {
      result.capabilityLevel = 2;
      result.likelyQuantized = false;
    }
  } else {
    // Empty response
    result.capabilityLevel = 1;
    result.likelyQuantized = true;
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

  // Detect model architecture size to determine base capability
  // Strong models: identified by architecture name (GPT-4o, Claude, etc.) AND parameter count
  const strongModelPattern = /(?:gpt-4o|gpt-4\b[^.0-9]|claude[-_]3\.?5?|gemma[._-]?2[._-]?27b|deepseek-v3|deepseek-r1|glm[-_]4)/i;
  const strongSizePattern = /(?:qwen[2-9][._-]?[0-9]+[._-]?(?:72b|32b|14b|o[a-z]?)|qwen3(?:\.?[0-9]+)?[._-]?(?:35b|14b|32b|72b)|llama[._-]?3(?:\.1)?[._-]?(?:70b|67b|405b)|yi[._-]?(?:34b|34))/i;

  // Clean model name for size detection (remove quantization suffixes)
  const cleanName = lower.replace(/(?:[-_][0-9]*bit|q[2-8]|nf4|awq|gptq|gguf|it[2-4]|fp[0-9])/g, "");

  let baseCapability: number = 2; // default medium
  if (strongModelPattern.test(cleanName) || strongModelPattern.test(lower)) {
    baseCapability = 3;
  } else if (strongSizePattern.test(cleanName) || strongSizePattern.test(lower)) {
    baseCapability = 3;
  } else if (/qwen[0-9]|glm[._-]?4|chatglm|llama[._-]?3\.0|llama[._-]?2|mistral[._-]?7b|yi[._-]?34|mixtral[._-]?8x7b|deepseek[-_]v2/i.test(cleanName) || /qwen[0-9]|glm[._-]?4|chatglm|llama[._-]?3\.0|llama[._-]?2|mistral[._-]?7b|yi[._-]?34|mixtral[._-]?8x7b|deepseek[-_]v2/i.test(lower)) {
    baseCapability = 2;
  }

  return {
    instructionLanguage: lower.includes("qwen") || lower.includes("glm") || lower.includes("chatglm") ? "zh" : userLang === "en" ? "en" : "zh",
    responseLanguage: userLang === "en" ? "en" : "zh",
    capabilityLevel: baseCapability as 0 | 1 | 2 | 3,
    likelyQuantized: isQuantized,
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
  // Defensive check: refuse to probe known cloud providers
  // (Orchestrator should skip probes for cloud profiles, but guard here too)
  const providerLower = provider.toLowerCase();
  if (/^openai|open_router|anthropic|google(?!ai_studio)/.test(providerLower)) {
    throw new Error(`Probing cloud provider "${provider}" is not supported. Use heuristic fallback instead.`);
  }

  const isAnthropic = providerLower.includes("anthropic") ||
    providerLower.includes("claude");

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
