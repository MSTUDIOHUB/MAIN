import type { AppConfig, LocalConfig } from "./appTypes";
import { normalizeContextMemoryState, type ContextMemoryState } from "./contextMemory";
import {
  normalizeCloudProtocol,
  normalizeCloudToolProtocol,
  getDefaultLocalProviderEndpoint,
  normalizeLocalToolProtocol,
  resolveEffectiveCloudApiFormat,
} from "./cloudProtocol";
import { createDefaultCloudConfig } from "./cloudServers";
import {
  createDefaultMcpRoutingConfig,
  createDefaultToolPermissionPolicy,
} from "./toolCapabilities";
import { createDefaultImAdaptersConfig } from "./imAdapters";

export const CLOUD_EXPERIMENTAL_LOGIN_AVAILABLE = false;

export const DEFAULT_LOCAL_CONFIG: LocalConfig = {
  provider: "OMLX",
  endpoint: getDefaultLocalProviderEndpoint("OMLX"),
  model: "",
  contextLimit: 16384,
  apiKey: "",
  toolProtocol: "auto",
};

export function createDefaultAppConfig(): AppConfig {
  return {
    language: "zh",
    responseLanguagePolicy: "follow_input_language",
    theme: "purple",
    themeMode: "dark",
    appIconVariant: "dark",
    workflowMode: "chat",
    promptLanguageStrategy: "model_aware",
    toolPermissionPolicy: createDefaultToolPermissionPolicy(),
    mcpRouting: createDefaultMcpRoutingConfig(),
    instructionsEnabled: true,
    hooksEnabled: true,
    activeProfile: "local",
    chatFontSize: 13,
    sessionRecordingEnabled: true,
    debugRecordFullTurnProcess: false,
    reasoningDisplay: "hidden",
    eventStreamMode: "dual",
    toolFeedbackFormat: "envelope_v1",
    local: { ...DEFAULT_LOCAL_CONFIG },
    cloud: createDefaultCloudConfig(),
    cloudServers: [],
    activeCloudServerId: "",
    cloudExperimentalLoginEnabled: CLOUD_EXPERIMENTAL_LOGIN_AVAILABLE,
    imAdapters: createDefaultImAdaptersConfig(),
    workspace: "",
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
        : DEFAULT_LOCAL_CONFIG.provider;
    const localModel =
      typeof config?.local?.model === "string" && config.local.model.trim()
        ? config.local.model
        : DEFAULT_LOCAL_CONFIG.model;
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
  const cloudExperimentalLoginEnabled =
    CLOUD_EXPERIMENTAL_LOGIN_AVAILABLE && config?.cloudExperimentalLoginEnabled === true;
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
      : "OpenAI";
  const cloudModel =
    typeof config?.cloud?.model === "string" && config.cloud.model.trim()
      ? config.cloud.model
      : "";
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
