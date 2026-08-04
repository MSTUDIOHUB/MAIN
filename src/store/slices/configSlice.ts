import type { AppConfig, LocalConfig } from "../../lib/appTypes";
import {
  createDefaultAppConfig,
  resolveRuntimeLaneKey as resolveAppRuntimeLaneKey,
} from "../../lib/appConfig";
import {
  normalizeEventStreamMode,
  normalizeToolFeedbackFormat,
} from "../../lib/turnEvents";
import {
  normalizeLocalToolProtocol,
  type ReasoningDisplayMode,
} from "../../lib/cloudProtocol";
import {
  normalizeContextMemoryState,
  type ContextMemoryState,
} from "../../lib/contextMemory";
import { resolveWorkspaceAwareWorkflowMode } from "../../lib/runIntent";

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
    ...(
      Number.isSafeInteger(Number(input?.maxActiveRequests)) &&
        Number(input?.maxActiveRequests) > 0
        ? { maxActiveRequests: Number(input?.maxActiveRequests) }
        : Number.isSafeInteger(Number(fallback.maxActiveRequests)) &&
            Number(fallback.maxActiveRequests) > 0
          ? { maxActiveRequests: Number(fallback.maxActiveRequests) }
          : {}
    ),
  };
}

export function resolveRuntimeLaneKey(config: Partial<AppConfig> | null | undefined): string {
  return resolveAppRuntimeLaneKey(config);
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
        workflowMode: resolveWorkspaceAwareWorkflowMode(
          nextConfig.workflowMode,
          Boolean(String(s.currentWorkspace || "").trim()),
        ),
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
