import {
  normalizeCloudApiFormat,
  normalizeCloudProtocol,
  normalizeCloudToolProtocol,
  normalizeOpenAiReasoningEffort,
  type CloudApiProtocol,
  type CloudToolProtocol,
  type OpenAiApiFormat,
  type OpenAiReasoningEffort,
} from "./cloudProtocol";

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
}

export interface CloudServerConfig extends CloudProfileConfig {
  id: string;
  name: string;
}

export const DEFAULT_CLOUD_SERVER_ID = "cloud-server-default";
const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1";

function cleanString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cleanNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaultEndpointForProtocol(protocol: CloudApiProtocol): string {
  return protocol === "anthropic" ? "https://api.anthropic.com" : DEFAULT_OPENAI_ENDPOINT;
}

function defaultProviderForProtocol(protocol: CloudApiProtocol): string {
  return protocol === "anthropic" ? "Anthropic" : "OpenAI";
}

export function createDefaultCloudConfig(): CloudProfileConfig {
  return {
    protocol: "openai",
    apiFormat: "chat_completions",
    provider: "OpenAI",
    endpoint: DEFAULT_OPENAI_ENDPOINT,
    model: "",
    apiKey: "",
    customHeaders: "",
    temperature: 0.6,
    topP: 0.95,
    disableResponseStorage: true,
    reasoningEffort: "none",
    toolProtocol: "auto",
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
    (endpoint.length > 0 && endpoint !== DEFAULT_OPENAI_ENDPOINT) ||
    cleanString(input.model).trim().length > 0 ||
    cleanString(input.apiKey).trim().length > 0 ||
    cleanString(input.customHeaders).trim().length > 0
  );
}

export function normalizeCloudConfig(input?: Partial<CloudProfileConfig> | null): CloudProfileConfig {
  const fallback = createDefaultCloudConfig();
  const protocol = normalizeCloudProtocol(input?.protocol);
  const apiFormat = protocol === "anthropic"
    ? "chat_completions"
    : normalizeCloudApiFormat(input?.apiFormat);
  const provider = cleanString(input?.provider).trim() || defaultProviderForProtocol(protocol);
  const endpoint = cleanString(input?.endpoint).trim() || defaultEndpointForProtocol(protocol);

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
