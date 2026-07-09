import type { AppConfig, LocalConfig } from "../../lib/appTypes";
import { createDefaultAppConfig } from "../../lib/appConfig";
import {
  normalizeEventStreamMode,
  normalizeToolFeedbackFormat,
} from "../../lib/turnEvents";
import {
  normalizeLocalToolProtocol,
  normalizeCloudToolProtocol,
  resolveEffectiveCloudApiFormat,
  normalizeCloudProtocol,
  type ReasoningDisplayMode,
} from "../../lib/cloudProtocol";
import {
  normalizeContextMemoryState,
  type ContextMemoryState,
} from "../../lib/contextMemory";

export interface ConfigSlice {
  config: AppConfig;
  setConfig: (patch: Partial<AppConfig> | ((prev: AppConfig) => AppConfig)) => void;
}

export const PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS = 12 * 60 * 1000;
export const PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK = 2;

export const defaultConfig: AppConfig = createDefaultAppConfig();

export function normalizeAppIconVariant(value: unknown): AppConfig["appIconVariant"] {
  return value === "light" ? "light" : "dark";
}

export function normalizeReasoningDisplay(value: unknown, fallback: ReasoningDisplayMode = "hidden"): ReasoningDisplayMode {
  return value === "debug_summary" || value === "raw_debug" || value === "hidden"
    ? (value as ReasoningDisplayMode)
    : fallback;
}

export function normalizeLocalConfig(
  input?: Partial<LocalConfig> | null,
  fallback: LocalConfig = defaultConfig.local,
): LocalConfig {
  const provider = typeof input?.provider === "string" && input.provider.trim()
    ? input.provider
    : fallback.provider;
  const endpoint = typeof input?.endpoint === "string" ? input.endpoint : fallback.endpoint;
  const model = typeof input?.model === "string" ? input.model : fallback.model;
  const contextLimit = typeof input?.contextLimit === "number" && Number.isFinite(input.contextLimit)
    ? input.contextLimit
    : fallback.contextLimit;
  const apiKey = typeof input?.apiKey === "string" ? input.apiKey : fallback.apiKey;
  const hasStoredToolProtocol = !!input && Object.prototype.hasOwnProperty.call(input, "toolProtocol");

  return {
    provider,
    endpoint,
    model,
    contextLimit,
    apiKey,
    toolProtocol: normalizeLocalToolProtocol(
      hasStoredToolProtocol ? input?.toolProtocol : undefined,
      provider,
    ),
  };
}

export function normalizeRuntimeLaneToken(value: unknown): string {
  const compacted = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[|\s]+/g, "_");
  return compacted || "-";
}

export function resolveRuntimeLaneKey(config: Partial<AppConfig> | null | undefined): string {
  const activeProfile = config?.activeProfile === "cloud" ? "cloud" : "local";
  if (activeProfile === "local") {
    const localProvider =
      typeof config?.local?.provider === "string" && config.local.provider.trim()
        ? config.local.provider
        : defaultConfig.local.provider;
    const localModel =
      typeof config?.local?.model === "string" && config.local.model.trim()
        ? config.local.model
        : defaultConfig.local.model;
    const localToolProtocol = normalizeLocalToolProtocol(config?.local?.toolProtocol, localProvider);
    return [
      "profile=local",
      `provider=${normalizeRuntimeLaneToken(localProvider)}`,
      `model=${normalizeRuntimeLaneToken(localModel)}`,
      `tool=${normalizeRuntimeLaneToken(localToolProtocol)}`,
      "protocol=local",
      "api_format=chat_completions",
    ].join("|");
  }

  const cloudProtocolInput =
    typeof config?.cloud?.protocol === "string" ? config.cloud.protocol : "openai";
  const cloudExperimentalLoginEnabled = false;
  const cloudAuthMode = cloudExperimentalLoginEnabled
    ? config?.cloud?.auth?.mode ?? "api_key"
    : "api_key";
  const cloudApiFormat = resolveEffectiveCloudApiFormat({
    protocol: cloudProtocolInput,
    apiFormat:
      typeof config?.cloud?.apiFormat === "string"
        ? config.cloud.apiFormat
        : "chat_completions",
    authMode: cloudAuthMode,
  });
  const cloudProvider =
    typeof config?.cloud?.provider === "string" && config.cloud.provider.trim()
      ? config.cloud.provider
      : defaultConfig.cloud.provider;
  const cloudModel =
    typeof config?.cloud?.model === "string" && config.cloud.model.trim()
      ? config.cloud.model
      : defaultConfig.cloud.model;
  const cloudToolProtocol = normalizeCloudToolProtocol(config?.cloud?.toolProtocol);
  const cloudProtocol = normalizeCloudProtocol(cloudProtocolInput);
  return [
    "profile=cloud",
    `provider=${normalizeRuntimeLaneToken(cloudProvider)}`,
    `model=${normalizeRuntimeLaneToken(cloudModel)}`,
    `tool=${normalizeRuntimeLaneToken(cloudToolProtocol)}`,
    `protocol=${normalizeRuntimeLaneToken(cloudProtocol)}`,
    `api_format=${normalizeRuntimeLaneToken(cloudApiFormat)}`,
    `auth=${normalizeRuntimeLaneToken(cloudAuthMode)}`,
  ].join("|");
}

export function normalizeContextMemoryStateByRuntimeKey(value: unknown): Record<string, ContextMemoryState | null> {
  if (!value || typeof value !== "object") return {};
  const normalized: Record<string, ContextMemoryState | null> = {};
  for (const [rawLaneKey, laneState] of Object.entries(value as Record<string, unknown>)) {
    const laneKey = String(rawLaneKey || "").trim();
    if (!laneKey) continue;
    const normalizedState = normalizeContextMemoryState(laneState);
    if (normalizedState) normalized[laneKey] = normalizedState;
  }
  return normalized;
}

export function resolveContextMemoryStateForRuntimeLane(
  laneKey: string,
  laneMap: Record<string, ContextMemoryState | null> | null | undefined,
  legacyState: ContextMemoryState | null | undefined,
): ContextMemoryState | null {
  const normalizedLaneMap = normalizeContextMemoryStateByRuntimeKey(laneMap);
  const laneState = normalizeContextMemoryState(normalizedLaneMap[laneKey]);
  if (laneState) return laneState;
  return Object.keys(normalizedLaneMap).length === 0
    ? normalizeContextMemoryState(legacyState)
    : null;
}

export const createConfigSlice = (set: any, _get: any) => ({
  config: defaultConfig,
  setConfig: (patch: any) =>
    set((s: any) => {
      const nextConfig = typeof patch === "function" ? patch(s.config) : { ...s.config, ...patch };
      const normalizedConfig: AppConfig = {
        ...nextConfig,
        eventStreamMode: normalizeEventStreamMode(nextConfig.eventStreamMode, s.config.eventStreamMode),
        toolFeedbackFormat: normalizeToolFeedbackFormat(nextConfig.toolFeedbackFormat, s.config.toolFeedbackFormat),
        reasoningDisplay: normalizeReasoningDisplay(nextConfig.reasoningDisplay, s.config.reasoningDisplay),
        local: normalizeLocalConfig(nextConfig.local, s.config.local),
      };
      const runtimeLaneKey = resolveRuntimeLaneKey(normalizedConfig);
      return {
        config: normalizedConfig,
        contextMemoryState: resolveContextMemoryStateForRuntimeLane(
          runtimeLaneKey,
          s.contextMemoryStateByRuntimeKey,
          s.contextMemoryState,
        ),
      };
    }),
});
