import type { AppConfig } from "./appTypes";
import {
  normalizeCloudToolProtocol,
  normalizeLocalToolProtocol,
  resolveEffectiveCloudApiFormat,
} from "./cloudProtocol";
import { shouldUseRustProxyForLocalProvider } from "./localProviderRouting";
import type { StreamSettings } from "./streaming";

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
      reasoningRequest: "off",
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
