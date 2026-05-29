import { parseMainDebugShortcut, parseMainIntentShortcut, type ResolvedRunIntent } from "./runIntent";

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

export type FeishuApprovalAction = "approve" | "approve_session" | "reject";
export type FeishuApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface FeishuCardActionEvent {
  type: "card_action";
  adapter: "feishu";
  messageId: string;
  chatId: string;
  userId: string;
  userName: string;
  action: FeishuApprovalAction;
  approvalId: string;
  nonce: string;
  timestamp?: number;
}

export interface FeishuMessageSentEvent {
  type: "message_sent";
  adapter: "feishu";
  messageKind?: string;
  approvalId?: string;
  messageId?: string;
  chatId?: string;
  timestamp?: number;
}

export type FeishuAdapterEvent =
  | FeishuInboundMessage
  | FeishuCardActionEvent
  | FeishuMessageSentEvent
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
  | { kind: "approve_session"; code: string }
  | { kind: "reject"; code: string }
  | { kind: "pair"; code: string }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "help" }
  | { kind: "new" }
  | { kind: "follow" }
  | { kind: "message"; text: string };

export interface FeishuRemoteIntentOverride {
  resolvedIntent?: ResolvedRunIntent;
  skipIntentResolution?: boolean;
}

export interface FeishuApprovalRecord {
  approvalId: string;
  nonce: string;
  chatId: string;
  userId: string;
  expiresAt: number;
  status: FeishuApprovalStatus;
}

export interface FeishuApprovalActionRequest {
  approvalId: string;
  nonce: string;
  chatId: string;
  userId: string;
  action: FeishuApprovalAction;
}

export type FeishuApprovalResolution<T extends FeishuApprovalRecord> =
  | { ok: true; approval: T }
  | {
      ok: false;
      reason: "not_found" | "wrong_user" | "wrong_chat" | "nonce_mismatch" | "expired" | "already_resolved";
      approval?: T;
    };

export interface BuildFeishuApprovalCardInput {
  language: "zh" | "en";
  approvalId: string;
  nonce: string;
  code?: string;
  toolName: string;
  target?: string;
  workspace?: string;
  preview?: string;
  requestedAt: number;
  expiresAt: number;
  status?: FeishuApprovalStatus;
  resolvedBy?: string;
  resolvedAt?: number;
}

export type FeishuInteractiveCard = Record<string, unknown>;

// endregion

// region: 默认配置与归一化

export function createFeishuPairingCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createRandomToken(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = new Uint32Array(length);
  const cryptoSource = globalThis.crypto;
  if (cryptoSource?.getRandomValues) {
    cryptoSource.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * alphabet.length);
    }
  }
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

export const FEISHU_APPROVAL_TTL_MS = 10 * 60 * 1000;

export function createFeishuApprovalId(): string {
  return `apv_${createRandomToken(12).toLowerCase()}`;
}

export function createFeishuApprovalNonce(): string {
  return createRandomToken(24);
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
  const match = text.match(/^\/(approve|reject|pair|approve_session|always_allow)\s+([A-Za-z0-9_-]{4,16})$/i);
  if (match) {
    const action = match[1].toLowerCase();
    const code = match[2].trim();
    if (action === "approve") return { kind: "approve", code };
    if (action === "reject") return { kind: "reject", code };
    if (action === "approve_session" || action === "always_allow") return { kind: "approve_session", code };
    return { kind: "pair", code };
  }
  if (/^\/status$/i.test(text)) return { kind: "status" };
  if (/^\/stop$/i.test(text)) return { kind: "stop" };
  if (/^\/help$/i.test(text)) return { kind: "help" };
  if (/^\/(new|reset)$/i.test(text)) return { kind: "new" };
  if (/^\/follow$/i.test(text)) return { kind: "follow" };
  return { kind: "message", text };
}

function normalizeActionValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseFeishuApprovalCardActionValue(value: unknown):
  | { action: FeishuApprovalAction; approvalId: string; nonce: string }
  | null {
  const record = normalizeActionValue(value);
  if (!record || record.mainAction !== "feishu_approval") return null;
  const action = String(record.action || "").trim();
  const approvalId = String(record.approvalId || "").trim();
  const nonce = String(record.nonce || "").trim();
  if (action !== "approve" && action !== "approve_session" && action !== "reject") return null;
  if (!approvalId || !nonce) return null;
  return { action: action as FeishuApprovalAction, approvalId, nonce };
}

export function resolveFeishuApprovalAction<T extends FeishuApprovalRecord>(
  approvals: T[],
  request: FeishuApprovalActionRequest,
  now = Date.now(),
): FeishuApprovalResolution<T> {
  const approval = approvals.find((item) => item.approvalId === request.approvalId) || null;
  if (!approval) return { ok: false, reason: "not_found" };
  if (approval.status !== "pending") return { ok: false, reason: "already_resolved", approval };
  if (approval.userId !== request.userId) return { ok: false, reason: "wrong_user", approval };
  if (approval.chatId !== request.chatId) return { ok: false, reason: "wrong_chat", approval };
  if (approval.nonce !== request.nonce) return { ok: false, reason: "nonce_mismatch", approval };
  if (approval.expiresAt <= now) return { ok: false, reason: "expired", approval };
  return { ok: true, approval };
}

function formatCardDate(timestamp: number, language: "zh" | "en"): string {
  try {
    return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString();
  }
}

function escapeMarkdown(value: string): string {
  return String(value || "").replace(/```/g, "'''");
}

function truncateCardText(value: string, maxChars: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 18).trimEnd()}\n... <truncated>`;
}

function statusTemplate(status: FeishuApprovalStatus): string {
  if (status === "approved") return "green";
  if (status === "rejected") return "red";
  if (status === "expired") return "yellow";
  return "blue";
}

export function buildFeishuApprovalCard(input: BuildFeishuApprovalCardInput): FeishuInteractiveCard {
  const status = input.status || "pending";
  const isEn = input.language === "en";
  const statusLabel = status === "pending"
    ? isEn ? "Waiting for approval" : "等待审批"
    : status === "approved"
    ? isEn ? "Approved" : "已允许"
    : status === "rejected"
    ? isEn ? "Rejected" : "已拒绝"
    : isEn ? "Expired" : "已过期";
  const title = isEn ? `MAIN Tool Approval - ${statusLabel}` : `MAIN 工具审批 - ${statusLabel}`;
  const requestedAt = formatCardDate(input.requestedAt, input.language);
  const expiresAt = formatCardDate(input.expiresAt, input.language);
  const resolvedAt = input.resolvedAt ? formatCardDate(input.resolvedAt, input.language) : "";
  const target = truncateCardText(input.target || (isEn ? "No target" : "无目标"), 600);
  const workspace = truncateCardText(input.workspace || (isEn ? "Current workspace" : "当前工作区"), 260);
  const preview = truncateCardText(input.preview || target, 1100);
  const lines = [
    `**${isEn ? "Tool" : "工具"}**: ${escapeMarkdown(input.toolName)}`,
    `**${isEn ? "Target" : "目标"}**: ${escapeMarkdown(target)}`,
    `**${isEn ? "Workspace" : "工作区"}**: ${escapeMarkdown(workspace)}`,
    `**${isEn ? "Request ID" : "审批编号"}**: \`${escapeMarkdown(input.approvalId)}\``,
    `**${isEn ? "Requested" : "请求时间"}**: ${requestedAt}`,
    status === "pending"
      ? `**${isEn ? "Expires" : "过期时间"}**: ${expiresAt}`
      : `**${isEn ? "Handled" : "处理时间"}**: ${resolvedAt || requestedAt}`,
    status !== "pending" && input.resolvedBy
      ? `**${isEn ? "Operator" : "操作者"}**: ${escapeMarkdown(input.resolvedBy)}`
      : "",
    "",
    `**${isEn ? "Preview" : "预览"}**`,
    "```",
    escapeMarkdown(preview),
    "```",
  ].filter(Boolean);

  const elements: unknown[] = [
    {
      tag: "markdown",
      content: lines.join("\n"),
    },
  ];

  if (status === "pending") {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: isEn ? "Allow once" : "允许本次",
          },
          type: "primary",
          value: {
            mainAction: "feishu_approval",
            action: "approve",
            approvalId: input.approvalId,
            nonce: input.nonce,
          },
        },
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: isEn ? "Always allow" : "全部批准",
          },
          type: "default",
          value: {
            mainAction: "feishu_approval",
            action: "approve_session",
            approvalId: input.approvalId,
            nonce: input.nonce,
          },
        },
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: isEn ? "Reject" : "拒绝执行",
          },
          type: "danger",
          value: {
            mainAction: "feishu_approval",
            action: "reject",
            approvalId: input.approvalId,
            nonce: input.nonce,
          },
        },
      ],
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: statusTemplate(status),
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    elements,
  };
}

export function resolveFeishuRemoteIntentOverride(input: string): FeishuRemoteIntentOverride {
  return parseMainIntentShortcut(input) || parseMainDebugShortcut(input)
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
