import { parseMainIntentShortcut, type ResolvedRunIntent } from "./runIntent";

// region: 飞书 IM Adapter 类型

export type FeishuAdapterChatScope = "dm_only";
export type FeishuAdapterAccessPolicy = "pairing";
export type FeishuAdapterRouting = "current_workspace";
export type FeishuAdapterStatusValue = "idle" | "starting" | "connected" | "stopped" | "error";

export interface FeishuPairedUser {
  openId: string;
  name: string;
  chatId: string;
  pairedAt: number;
  lastSeenAt?: number;
}

export interface FeishuPendingPairing {
  openId: string;
  name: string;
  chatId: string;
  messageId?: string;
  requestedAt: number;
}

export interface FeishuAdapterConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: string;
  pairingCode: string;
  pairedUsers: FeishuPairedUser[];
  routing: FeishuAdapterRouting;
  chatScope: FeishuAdapterChatScope;
  accessPolicy: FeishuAdapterAccessPolicy;
}

export interface ImAdaptersConfig {
  feishu: FeishuAdapterConfig;
}

export interface FeishuAdapterRuntimeStatus {
  status: FeishuAdapterStatusValue;
  running: boolean;
  message: string;
  updatedAt: number;
  pid?: number | null;
}

export interface FeishuInboundMessage {
  type: "message";
  adapter: "feishu";
  messageId: string;
  chatId: string;
  chatType: string;
  userId: string;
  userName: string;
  text: string;
  timestamp?: number;
}

export type FeishuAdapterEvent =
  | FeishuInboundMessage
  | {
      type: "status" | "error" | "log";
      adapter: "feishu";
      status?: FeishuAdapterStatusValue;
      running?: boolean;
      message?: string;
      pid?: number | null;
      timestamp?: number;
    };

export type FeishuTextCommand =
  | { kind: "approve"; code: string }
  | { kind: "reject"; code: string }
  | { kind: "pair"; code: string }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "message"; text: string };

export interface FeishuRemoteIntentOverride {
  resolvedIntent?: ResolvedRunIntent;
  skipIntentResolution?: boolean;
}

// endregion

// region: 默认配置与归一化

export function createFeishuPairingCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function createDefaultFeishuAdapterConfig(): FeishuAdapterConfig {
  return {
    enabled: false,
    appId: "",
    appSecret: "",
    domain: "https://open.feishu.cn",
    pairingCode: createFeishuPairingCode(),
    pairedUsers: [],
    routing: "current_workspace",
    chatScope: "dm_only",
    accessPolicy: "pairing",
  };
}

export function createDefaultImAdaptersConfig(): ImAdaptersConfig {
  return {
    feishu: createDefaultFeishuAdapterConfig(),
  };
}

export function createDefaultFeishuAdapterRuntimeStatus(): FeishuAdapterRuntimeStatus {
  return {
    status: "idle",
    running: false,
    message: "",
    updatedAt: Date.now(),
    pid: null,
  };
}

export function normalizeFeishuPairedUsers(value: unknown): FeishuPairedUser[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Partial<FeishuPairedUser>;
      const openId = String(candidate.openId || "").trim();
      if (!openId || seen.has(openId)) return null;
      seen.add(openId);
      const normalized: FeishuPairedUser = {
        openId,
        name: String(candidate.name || openId).trim() || openId,
        chatId: String(candidate.chatId || "").trim(),
        pairedAt: Number.isFinite(candidate.pairedAt) ? Number(candidate.pairedAt) : Date.now(),
      };
      if (Number.isFinite(candidate.lastSeenAt)) {
        normalized.lastSeenAt = Number(candidate.lastSeenAt);
      }
      return normalized;
    })
    .filter((item): item is FeishuPairedUser => !!item);
}

export function normalizeFeishuAdapterConfig(value: unknown): FeishuAdapterConfig {
  const defaults = createDefaultFeishuAdapterConfig();
  if (!value || typeof value !== "object") return defaults;
  const candidate = value as Partial<FeishuAdapterConfig>;
  const pairingCode = String(candidate.pairingCode || "").trim();
  return {
    ...defaults,
    enabled: candidate.enabled === true,
    appId: String(candidate.appId || "").trim(),
    appSecret: String(candidate.appSecret || ""),
    domain: String(candidate.domain || defaults.domain).trim() || defaults.domain,
    pairingCode: /^\d{6}$/.test(pairingCode) ? pairingCode : defaults.pairingCode,
    pairedUsers: normalizeFeishuPairedUsers(candidate.pairedUsers),
    routing: "current_workspace",
    chatScope: "dm_only",
    accessPolicy: "pairing",
  };
}

export function normalizeImAdaptersConfig(value: unknown): ImAdaptersConfig {
  const candidate = value && typeof value === "object" ? value as Partial<ImAdaptersConfig> : {};
  return {
    feishu: normalizeFeishuAdapterConfig(candidate.feishu),
  };
}

// endregion

// region: 配对与命令解析

export function findFeishuPairedUser(config: FeishuAdapterConfig, openId: string): FeishuPairedUser | null {
  return config.pairedUsers.find((user) => user.openId === openId) || null;
}

export function upsertFeishuPairedUser(
  users: FeishuPairedUser[],
  nextUser: FeishuPairedUser,
): FeishuPairedUser[] {
  const index = users.findIndex((user) => user.openId === nextUser.openId);
  if (index < 0) return [...users, nextUser];
  return users.map((user, itemIndex) => itemIndex === index ? { ...user, ...nextUser } : user);
}

export function upsertFeishuPairingRequest(
  requests: FeishuPendingPairing[],
  nextRequest: FeishuPendingPairing,
): FeishuPendingPairing[] {
  const index = requests.findIndex((request) => request.openId === nextRequest.openId);
  if (index < 0) return [...requests, nextRequest];
  return requests.map((request, itemIndex) =>
    itemIndex === index ? { ...request, ...nextRequest, requestedAt: nextRequest.requestedAt } : request,
  );
}

export function parseFeishuTextCommand(input: string): FeishuTextCommand {
  const text = input.trim();
  const match = text.match(/^\/(approve|reject|pair)\s+([A-Za-z0-9_-]{4,16})$/i);
  if (match) {
    const action = match[1].toLowerCase();
    const code = match[2].trim();
    if (action === "approve") return { kind: "approve", code };
    if (action === "reject") return { kind: "reject", code };
    return { kind: "pair", code };
  }
  if (/^\/status$/i.test(text)) return { kind: "status" };
  if (/^\/stop$/i.test(text)) return { kind: "stop" };
  return { kind: "message", text };
}

export function resolveFeishuRemoteIntentOverride(input: string): FeishuRemoteIntentOverride {
  return parseMainIntentShortcut(input)
    ? {}
    : {
        resolvedIntent: "analyze",
        skipIntentResolution: true,
      };
}

export function createFeishuPairingRequest(message: FeishuInboundMessage): FeishuPendingPairing {
  return {
    openId: message.userId,
    name: message.userName || message.userId,
    chatId: message.chatId,
    messageId: message.messageId,
    requestedAt: message.timestamp || Date.now(),
  };
}

export function createFeishuPairedUserFromMessage(message: FeishuInboundMessage): FeishuPairedUser {
  const now = Date.now();
  return {
    openId: message.userId,
    name: message.userName || message.userId,
    chatId: message.chatId,
    pairedAt: now,
    lastSeenAt: now,
  };
}

export function createFeishuRemoteSessionTitle(user: FeishuPairedUser | FeishuInboundMessage): string {
  const name = "name" in user ? user.name : user.userName;
  const fallback = "openId" in user ? user.openId : user.userId;
  return `[Feishu] ${name || fallback}`;
}

// endregion
