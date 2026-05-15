export type ChatFeedbackLanguage = "zh" | "en";

export type ChatFeedbackStatus =
  | "pending_approval"
  | "running"
  | "completed"
  | "failed"
  | "rejected";

export type ChatErrorCategory =
  | "auth"
  | "model"
  | "quota"
  | "context_length"
  | "payload"
  | "network"
  | "proxy"
  | "stream"
  | "content"
  | "server"
  | "deprecated"
  | "mcp"
  | "parse"
  | "unknown";

export interface ChatErrorClassification {
  category: ChatErrorCategory;
  title: string;
  detail: string;
  actionLabel?: string;
  settingsTab?: "local" | "cloud" | "general" | "context" | "mcp";
}

type ChatErrorCopy = Omit<ChatErrorClassification, "category">;

const STATUS_COPY: Record<ChatFeedbackStatus, Record<ChatFeedbackLanguage, { label: string; shortLabel: string }>> = {
  pending_approval: {
    zh: { label: "待批准", shortLabel: "待批准" },
    en: { label: "Awaiting approval", shortLabel: "Approval" },
  },
  running: {
    zh: { label: "执行中", shortLabel: "执行中" },
    en: { label: "Running", shortLabel: "Running" },
  },
  completed: {
    zh: { label: "已完成", shortLabel: "完成" },
    en: { label: "Completed", shortLabel: "Done" },
  },
  failed: {
    zh: { label: "失败", shortLabel: "失败" },
    en: { label: "Failed", shortLabel: "Failed" },
  },
  rejected: {
    zh: { label: "已拒绝", shortLabel: "拒绝" },
    en: { label: "Rejected", shortLabel: "Rejected" },
  },
};

function getMessageText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input) return "";
  if (typeof input === "object" && "message" in input) {
    return String((input as { message?: unknown }).message || "");
  }
  return String(input);
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function statusFromHttpMessage(text: string): number | undefined {
  const match = text.match(/\b(?:status|statusCode|HTTP)\D{0,8}(400|401|403|404|413|429|500|502|503|504)\b/i);
  return match ? Number(match[1]) : undefined;
}

function buildCopy(language: ChatFeedbackLanguage, category: ChatErrorCategory, activeProfile: "local" | "cloud" = "local"): ChatErrorCopy {
  const providerTab = activeProfile === "cloud" ? "cloud" : "local";
  const isZh = language === "zh";
  const openProvider = isZh ? "打开模型设置" : "Open model settings";

  switch (category) {
    case "auth":
      return {
        title: isZh ? "模型认证失败" : "Model authentication failed",
        detail: isZh ? "模型服务拒绝了请求，通常是 API Key、Token 或登录状态失效。" : "The provider rejected the request, usually because the API key, token, or login state is invalid.",
        actionLabel: openProvider,
        settingsTab: providerTab,
      };
    case "model":
      return {
        title: isZh ? "模型不可用" : "Model unavailable",
        detail: isZh ? "当前模型 ID 可能不存在、已下线，或这个账号没有权限调用。" : "The model ID may be unavailable, retired, or not enabled for this account.",
        actionLabel: openProvider,
        settingsTab: providerTab,
      };
    case "quota":
      return {
        title: isZh ? "额度或频率受限" : "Quota or rate limit reached",
        detail: isZh ? "服务端提示额度不足或请求过快。可以换模型、稍后重试，或检查服务商额度。" : "The provider reported insufficient quota or too many requests. Try another model, retry later, or check provider quota.",
        actionLabel: openProvider,
        settingsTab: providerTab,
      };
    case "context_length":
      return {
        title: isZh ? "上下文过长" : "Context is too long",
        detail: isZh ? "当前请求超过了模型上下文限制，需要压缩历史、减少附件或调低上下文窗口。" : "The request exceeds the model context window. Compress history, reduce attachments, or lower the context window.",
        actionLabel: isZh ? "打开上下文设置" : "Open context settings",
        settingsTab: "context",
      };
    case "payload":
      return {
        title: isZh ? "请求内容过大" : "Request is too large",
        detail: isZh ? "发送给模型的正文、图片或工具结果过大，服务端拒绝处理。" : "The prompt, image payload, or tool result is too large for the provider to accept.",
        actionLabel: isZh ? "打开上下文设置" : "Open context settings",
        settingsTab: "context",
      };
    case "network":
      return {
        title: isZh ? "网络连接失败" : "Network connection failed",
        detail: isZh ? "MAIN 没有连上模型服务，可能是服务未启动、地址错误、DNS 或网络中断。" : "MAIN could not reach the model service. The service may be stopped, misconfigured, or blocked by DNS/network issues.",
        actionLabel: isZh ? "打开通用设置" : "Open general settings",
        settingsTab: "general",
      };
    case "proxy":
      return {
        title: isZh ? "代理或证书异常" : "Proxy or certificate issue",
        detail: isZh ? "请求被代理、证书或 TLS 配置拦住了。请检查系统代理和自定义端点。" : "The request appears blocked by proxy, certificate, or TLS configuration. Check proxy and endpoint settings.",
        actionLabel: isZh ? "打开通用设置" : "Open general settings",
        settingsTab: "general",
      };
    case "stream":
      return {
        title: isZh ? "连接中断，回复可能不完整" : "Connection interrupted; reply may be incomplete",
        detail: isZh ? "模型流式传输过程中断，已保留当前可见内容。" : "The model stream was interrupted. The visible partial response has been kept.",
      };
    case "content":
      return {
        title: isZh ? "内容被服务端拦截" : "Content blocked by provider",
        detail: isZh ? "服务端内容策略拒绝了这次请求。调整输入后再试。" : "The provider rejected the request under its content policy. Adjust the input and retry.",
      };
    case "server":
      return {
        title: isZh ? "模型服务端错误" : "Provider server error",
        detail: isZh ? "服务端返回 5xx 错误，通常不是本地配置问题。" : "The provider returned a 5xx error. This is usually not caused by local settings.",
      };
    case "deprecated":
      return {
        title: isZh ? "模型已弃用" : "Model is deprecated",
        detail: isZh ? "当前模型可能已被服务商下线或迁移。请选择仍可用的模型。" : "The selected model may have been retired or moved. Choose an available replacement.",
        actionLabel: openProvider,
        settingsTab: providerTab,
      };
    case "mcp":
      return {
        title: isZh ? "MCP 工具连接失败" : "MCP tool connection failed",
        detail: isZh ? "MCP 服务未响应、配置不匹配，或工具执行返回错误。" : "The MCP server did not respond, configuration mismatched, or the tool returned an error.",
        actionLabel: isZh ? "打开 MCP 设置" : "Open MCP settings",
        settingsTab: "mcp",
      };
    case "parse":
      return {
        title: isZh ? "模型返回格式无法解析" : "Model response could not be parsed",
        detail: isZh ? "服务端返回了不符合预期的数据，可能是兼容层或流式协议异常。" : "The provider returned data in an unexpected shape, likely from a compatibility or streaming protocol issue.",
      };
    default:
      return {
        title: isZh ? "请求失败" : "Request failed",
        detail: isZh ? "这次模型请求没有成功。展开详情可查看原始错误。" : "The model request failed. Expand details to inspect the raw error.",
      };
  }
}

export function normalizeChatFeedbackStatus(status: string): ChatFeedbackStatus {
  switch (status) {
    case "pending":
      return "pending_approval";
    case "running":
      return "running";
    case "executed":
    case "done":
    case "success":
      return "completed";
    case "rejected":
    case "cancelled":
      return "rejected";
    case "failed":
    case "error":
      return "failed";
    default:
      return "running";
  }
}

export function getChatFeedbackStatusCopy(status: ChatFeedbackStatus, language: ChatFeedbackLanguage = "zh") {
  return STATUS_COPY[status]?.[language] || STATUS_COPY.running[language];
}

export function classifyChatError(input: unknown, options?: {
  language?: ChatFeedbackLanguage;
  activeProfile?: "local" | "cloud";
}): ChatErrorClassification {
  const language = options?.language === "en" ? "en" : "zh";
  const activeProfile = options?.activeProfile === "cloud" ? "cloud" : "local";
  const raw = getMessageText(input);
  const msg = raw.toLowerCase();
  const status = statusFromHttpMessage(raw);
  let category: ChatErrorCategory = "unknown";

  if (
    status === 401 ||
    status === 403 ||
    includesAny(msg, ["invalid_api_key", "api key", "unauthorized", "forbidden", "authentication", "permission denied"])
  ) {
    category = "auth";
  } else if (
    status === 404 ||
    includesAny(msg, ["model_not_found", "model not found", "model does not exist", "unknown model"])
  ) {
    category = "model";
  } else if (
    status === 429 ||
    includesAny(msg, ["quota", "rate_limit", "rate limit", "insufficient_balance", "insufficient_quota", "too many requests"])
  ) {
    category = "quota";
  } else if (
    includesAny(msg, ["context_length_exceeded", "maximum context length", "too many tokens", "context window"])
  ) {
    category = "context_length";
  } else if (
    status === 413 ||
    includesAny(msg, ["payload too large", "request entity too large", "body too large"])
  ) {
    category = "payload";
  } else if (
    includesAny(msg, ["proxy", "socks", "certificate", "self-signed", "unable_to_verify_leaf_signature", "tls"])
  ) {
    category = "proxy";
  } else if (
    includesAny(msg, ["econnrefused", "etimedout", "timeout", "network", "fetch failed", "enotfound", "dns"])
  ) {
    category = "network";
  } else if (
    includesAny(msg, ["econnreset", "stream", "connection reset", "error decoding response body"])
  ) {
    category = "stream";
  } else if (
    status === 400 &&
    includesAny(msg, ["content_filter", "content policy", "safety"])
  ) {
    category = "content";
  } else if (typeof status === "number" && status >= 500) {
    category = "server";
  } else if (
    includesAny(msg, ["deprecated", "retired", "sunset", "decommission"])
  ) {
    category = "deprecated";
  } else if (
    includesAny(msg, ["mcp server", "mcp connection", "mcp error", "model context protocol"])
  ) {
    category = "mcp";
  } else if (
    includesAny(msg, ["unexpected token", "invalid response", "parse error", "json", "malformed"])
  ) {
    category = "parse";
  }

  const copy = buildCopy(language, category, activeProfile);
  return {
    category,
    title: copy.title,
    detail: copy.detail,
    actionLabel: copy.actionLabel,
    settingsTab: copy.settingsTab,
  };
}
