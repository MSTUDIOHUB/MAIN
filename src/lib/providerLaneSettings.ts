import type { AppConfig } from "./appTypes";
import type { RuntimeContextBudget } from "./runtimeContextBudget";
import {
  normalizeCloudProtocol,
  normalizeCloudToolProtocol,
  normalizeLocalToolProtocol,
  resolveEffectiveCloudApiFormat,
} from "./cloudProtocol";
import { shouldUseRustProxyForLocalProvider } from "./localProviderRouting";
import type { StreamSettings } from "./streaming";

export interface ProviderAdapterCapabilities {
  readonly nativeToolRoundTrip: boolean;
  readonly reasoningToggle: boolean;
}

export function deriveProviderAdapterCapabilities(
  settings: Pick<StreamSettings, "apiProtocol" | "provider">,
): ProviderAdapterCapabilities {
  const provider = String(settings.provider || "").trim().toLowerCase();
  const hasDocumentedReasoningControls = provider === "omlx";
  return {
    // Gemini support stays on the text-envelope lane until the adapter
    // implements declarations, calls, call history, and function responses.
    nativeToolRoundTrip:
      normalizeCloudProtocol(settings.apiProtocol) !== "gemini",
    reasoningToggle: hasDocumentedReasoningControls,
  };
}

export function deriveStreamSettings(config: AppConfig): StreamSettings {
  if (config.activeProfile === "local") {
    const toolProtocol = normalizeLocalToolProtocol(config.local.toolProtocol, config.local.provider);
    return {
      baseUrl: config.local.endpoint,
      apiKey: config.local.apiKey || "not-needed",
      model: config.local.model,
      sendSamplingParameters: true,
      temperature: 0.2,
      contextLimit: config.local.contextLimit,
      provider: config.local.provider,
      toolProtocol,
      // Local providers own the model's default reasoning capability. "auto"
      // sends no provider-specific override, so a thinking model may use its
      // advertised/default template while a non-thinking model remains
      // unchanged. Runtime v2 must not globally disable local reasoning.
      reasoningRequest: "auto",
      // LM Studio / OMLX 的本地流式接口在桌面 WebView 中可能触发
      // “Load Failed”，统一交给 Tauri 后端请求，避开 WebView 限制。
      // Ollama 原生端点保留前端直连；配置成 /v1 时也走后端代理。
      useRustProxy: shouldUseRustProxyForLocalProvider(config.local.provider, config.local.endpoint),
    };
  }
  const cloudAuthMode = config.cloudExperimentalLoginEnabled === true ? config.cloud.auth?.mode ?? "api_key" : "api_key";
  return {
    baseUrl: config.cloud.endpoint || "https://api.openai.com/v1",
    apiKey: config.cloud.apiKey,
    model: config.cloud.model,
    apiProtocol: config.cloud.protocol || "openai",
    apiFormat: resolveEffectiveCloudApiFormat({
      protocol: config.cloud.protocol || "openai",
      apiFormat: config.cloud.apiFormat || "chat_completions",
      authMode: cloudAuthMode,
    }),
    authMode: cloudAuthMode,
    tokenRef: config.cloudExperimentalLoginEnabled === true ? config.cloud.auth?.tokenRef : undefined,
    customHeaders: config.cloud.customHeaders || "",
    disableResponseStorage: config.cloud.disableResponseStorage ?? true,
    reasoningEffort: config.cloud.reasoningEffort ?? "none",
    toolProtocol: normalizeCloudToolProtocol(config.cloud.toolProtocol),
    // Cloud profile should not inherit the local KV-cache/context limit.
    contextLimit: undefined,
    provider: config.cloud.provider,
    useRustProxy: true, // Route through Rust to bypass WebView CORS
  };
}

export function deriveBudgetedStreamSettings(
  config: AppConfig,
  budget: RuntimeContextBudget | null | undefined,
): StreamSettings {
  const settings = deriveStreamSettings(config);
  if (config.activeProfile === "cloud" || !budget) return settings;
  return {
    ...settings,
    contextLimit: budget.contextLimit,
    preserveAssistantReasoning:
      budget.preserveAssistantReasoning === true,
  };
}
