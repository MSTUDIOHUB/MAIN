import {
  normalizeCloudApiFormat,
  normalizeCloudAuthMode,
  normalizeCloudProtocol,
  normalizeCloudToolProtocol,
  normalizeOpenAiReasoningEffort,
  resolveEffectiveCloudApiFormat,
  type CloudAuthMode,
  type CloudApiProtocol,
  type CloudToolProtocol,
  type OpenAiApiFormat,
  type OpenAiReasoningEffort,
} from "./cloudProtocol";

export interface CloudAuthSummary {
  mode: CloudAuthMode;
  status: "disconnected" | "connected" | "expired" | "error";
  accountId?: string;
  email?: string;
  tokenRef?: string;
  expiresAt?: number;
  storage?: "keychain" | "file";
  message?: string;
  projectId?: string;
  tier?: string;
  onboarded?: boolean;
  codeAssistMessage?: string;
}

export interface CloudProfileConfig {
  protocol: CloudApiProtocol;
  apiFormat: OpenAiApiFormat;
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  customHeaders: string;
  temperature: number;
  topP: number;
  disableResponseStorage: boolean;
  reasoningEffort: OpenAiReasoningEffort;
  toolProtocol: CloudToolProtocol;
  auth: CloudAuthSummary;
}

export interface CloudServerConfig extends CloudProfileConfig {
  id: string;
  name: string;
}

export const DEFAULT_CLOUD_SERVER_ID = "cloud-server-default";
export const DEFAULT_CLOUD_ENDPOINTS: Record<CloudApiProtocol, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

function cleanString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cleanNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function getDefaultCloudEndpoint(protocol: CloudApiProtocol): string {
  return DEFAULT_CLOUD_ENDPOINTS[protocol];
}

function defaultProviderForProtocol(protocol: CloudApiProtocol): string {
  if (protocol === "gemini") return "Gemini";
  return protocol === "anthropic" ? "Anthropic" : "OpenAI";
}

export function createDefaultCloudAuth(mode: CloudAuthMode = "api_key"): CloudAuthSummary {
  return {
    mode,
    status: "disconnected",
  };
}

export function normalizeCloudAuth(input?: Partial<CloudAuthSummary> | null, protocol?: CloudApiProtocol): CloudAuthSummary {
  const inferredMode = protocol === "gemini" ? "api_key" : "api_key";
  const mode = normalizeCloudAuthMode(input?.mode ?? inferredMode);
  const rawStatus = input?.status;
  const status = rawStatus === "connected" || rawStatus === "expired" || rawStatus === "error"
    ? rawStatus
    : "disconnected";
  const auth: CloudAuthSummary = { mode, status };
  if (typeof input?.accountId === "string" && input.accountId.trim()) auth.accountId = input.accountId.trim();
  if (typeof input?.email === "string" && input.email.trim()) auth.email = input.email.trim();
  if (typeof input?.tokenRef === "string" && input.tokenRef.trim()) auth.tokenRef = input.tokenRef.trim();
  if (typeof input?.expiresAt === "number" && Number.isFinite(input.expiresAt)) auth.expiresAt = input.expiresAt;
  if (input?.storage === "keychain" || input?.storage === "file") auth.storage = input.storage;
  if (typeof input?.message === "string" && input.message.trim()) auth.message = input.message.trim();
  if (typeof input?.projectId === "string" && input.projectId.trim()) auth.projectId = input.projectId.trim();
  if (typeof input?.tier === "string" && input.tier.trim()) auth.tier = input.tier.trim();
  if (typeof input?.onboarded === "boolean") auth.onboarded = input.onboarded;
  if (typeof input?.codeAssistMessage === "string" && input.codeAssistMessage.trim()) auth.codeAssistMessage = input.codeAssistMessage.trim();
  return auth;
}

export function createDefaultCloudConfig(): CloudProfileConfig {
  return {
    protocol: "openai",
    apiFormat: "chat_completions",
    provider: "OpenAI",
    endpoint: getDefaultCloudEndpoint("openai"),
    model: "",
    apiKey: "",
    customHeaders: "",
    temperature: 0.6,
    topP: 0.95,
    disableResponseStorage: true,
    reasoningEffort: "none",
    toolProtocol: "auto",
    auth: createDefaultCloudAuth(),
  };
}

function hasMeaningfulLegacyCloudConfig(input?: Partial<CloudProfileConfig> | null): boolean {
  if (!input) return false;
  const protocol = normalizeCloudProtocol(input.protocol);
  const apiFormat = normalizeCloudApiFormat(input.apiFormat);
  const provider = cleanString(input.provider).trim();
  const endpoint = cleanString(input.endpoint).trim();
  return (
    protocol !== "openai" ||
    apiFormat !== "chat_completions" ||
    (provider.length > 0 && provider !== "OpenAI") ||
    (endpoint.length > 0 && endpoint !== getDefaultCloudEndpoint("openai")) ||
    cleanString(input.model).trim().length > 0 ||
    cleanString(input.apiKey).trim().length > 0 ||
    cleanString(input.customHeaders).trim().length > 0
  );
}

export function normalizeCloudConfig(input?: Partial<CloudProfileConfig> | null): CloudProfileConfig {
  const fallback = createDefaultCloudConfig();
  const protocol = normalizeCloudProtocol(input?.protocol);
  const auth = normalizeCloudAuth(input?.auth, protocol);
  const apiFormat = protocol === "anthropic"
    ? "chat_completions"
    : resolveEffectiveCloudApiFormat({
      protocol,
      apiFormat: input?.apiFormat,
      authMode: auth.mode,
    });
  const provider = cleanString(input?.provider).trim() || defaultProviderForProtocol(protocol);
  const endpoint = cleanString(input?.endpoint).trim() || getDefaultCloudEndpoint(protocol);

  return {
    protocol,
    apiFormat,
    provider,
    endpoint,
    model: cleanString(input?.model),
    apiKey: cleanString(input?.apiKey),
    customHeaders: cleanString(input?.customHeaders),
    temperature: cleanNumber(input?.temperature, fallback.temperature),
    topP: cleanNumber(input?.topP, fallback.topP),
    disableResponseStorage: input?.disableResponseStorage ?? fallback.disableResponseStorage,
    reasoningEffort: normalizeOpenAiReasoningEffort(input?.reasoningEffort),
    toolProtocol: normalizeCloudToolProtocol(input?.toolProtocol),
    auth,
  };
}

export function cloudConfigFromServer(server: CloudServerConfig): CloudProfileConfig {
  const {
    id: _id,
    name: _name,
    ...cloud
  } = server;
  return normalizeCloudConfig(cloud);
}

export function createCloudServerConfig(
  input?: Partial<CloudServerConfig> | null,
  fallbackName = "Cloud Server",
): CloudServerConfig {
  const cloud = normalizeCloudConfig(input);
  const name = cleanString(input?.name).trim() || cleanString(cloud.provider).trim() || fallbackName;
  return {
    id: cleanString(input?.id).trim() || DEFAULT_CLOUD_SERVER_ID,
    name,
    ...cloud,
  };
}

function uniqueServerId(rawId: string, usedIds: Set<string>, index: number): string {
  const base = rawId.trim() || (index === 0 ? DEFAULT_CLOUD_SERVER_ID : `cloud-server-${index + 1}`);
  if (!usedIds.has(base)) return base;
  let suffix = 2;
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function normalizeCloudServerList(
  rawServers: unknown,
  legacyCloud?: Partial<CloudProfileConfig> | null,
): CloudServerConfig[] {
  const legacy = normalizeCloudConfig(legacyCloud);
  const sourceServers = Array.isArray(rawServers)
    ? rawServers
    : hasMeaningfulLegacyCloudConfig(legacyCloud)
      ? [{
          id: DEFAULT_CLOUD_SERVER_ID,
          name: legacy.provider || "Cloud Server",
          ...legacy,
        }]
      : [];
  const usedIds = new Set<string>();

  return sourceServers.map((raw, index) => {
    const source = raw && typeof raw === "object"
      ? raw as Partial<CloudServerConfig>
      : {};
    const cloud = normalizeCloudConfig(source);
    const id = uniqueServerId(cleanString(source.id), usedIds, index);
    usedIds.add(id);
    const name = cleanString(source.name).trim()
      || cleanString(source.provider).trim()
      || `Cloud Server ${index + 1}`;
    return {
      id,
      name,
      ...cloud,
    };
  });
}

export function normalizeCloudServerState(input: {
  cloud?: Partial<CloudProfileConfig> | null;
  cloudServers?: unknown;
  activeCloudServerId?: unknown;
}): {
  cloud: CloudProfileConfig;
  cloudServers: CloudServerConfig[];
  activeCloudServerId: string;
} {
  const cloudServers = normalizeCloudServerList(input.cloudServers, input.cloud);
  if (cloudServers.length === 0) {
    return {
      cloud: createDefaultCloudConfig(),
      cloudServers: [],
      activeCloudServerId: "",
    };
  }
  const requestedActiveId = cleanString(input.activeCloudServerId).trim();
  const activeServer = cloudServers.find((server) => server.id === requestedActiveId) || cloudServers[0];
  return {
    cloud: cloudConfigFromServer(activeServer),
    cloudServers,
    activeCloudServerId: activeServer.id,
  };
}
