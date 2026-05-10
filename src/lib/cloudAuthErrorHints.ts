import { normalizeCloudAuthMode, normalizeCloudProtocol, type CloudApiProtocol, type CloudAuthMode } from "./cloudProtocol";

function cleanErrorText(error: unknown): string {
  return String(error ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function isOpenAiOauth401(normalized: string): boolean {
  return hasAny(normalized, [
    "http 401",
    "\"code\":401",
    "unauthorized",
    "invalid_token",
    "token_expired",
    "token expired",
    "authentication failed",
  ]);
}

function isOpenAiOauth403(normalized: string): boolean {
  return hasAny(normalized, [
    "http 403",
    "\"code\":403",
    "permission denied",
    "insufficient permissions",
    "insufficient scope",
    "forbidden",
  ]);
}

function isGeminiScopeError(normalized: string): boolean {
  return hasAny(normalized, [
    "access_token_scope_insufficient",
    "insufficient authentication scopes",
  ]);
}

function isGeminiServiceDisabled(normalized: string): boolean {
  return hasAny(normalized, [
    "service_disabled",
    "cloud code private api has not been used",
    "cloudcode-pa.googleapis.com",
  ]);
}

function isGeminiPermissionDenied(normalized: string): boolean {
  return hasAny(normalized, [
    "permission_denied",
    "http 403",
    "\"code\":403",
    "forbidden",
  ]);
}

function isGeminiInternalError(normalized: string): boolean {
  return hasAny(normalized, [
    "http 500",
    "\"code\":500",
    "\"status\":\"internal\"",
    "internal error",
  ]);
}

export function summarizeCloudErrorMessage(error: unknown, maxChars = 280): string {
  const text = cleanErrorText(error);
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}...` : text;
}

export function getCloudAuthErrorHint(options: {
  protocol?: CloudApiProtocol | unknown;
  authMode?: CloudAuthMode | unknown;
  error: unknown;
  language?: "zh" | "en";
}): string | null {
  const language = options.language === "en" ? "en" : "zh";
  const protocol = normalizeCloudProtocol(options.protocol);
  const authMode = normalizeCloudAuthMode(options.authMode);
  const normalized = cleanErrorText(options.error).toLowerCase();

  if (authMode === "openai_chatgpt_oauth" && protocol === "openai") {
    if (normalized.includes("instructions are required")) {
      return language === "zh"
        ? "OpenAI 实验登录通道要求 Responses 请求携带 instructions。请保持 API Format 为 Responses 后重试。"
        : "OpenAI experimental login requires Responses requests to include instructions. Keep API Format on Responses and retry.";
    }
    if (isOpenAiOauth401(normalized)) {
      return language === "zh"
        ? "OpenAI 登录态可能已过期或失效。请退出后重新登录再测试。"
        : "Your OpenAI login token may be expired or invalid. Log out and sign in again, then retry.";
    }
    if (isOpenAiOauth403(normalized)) {
      return language === "zh"
        ? "OpenAI 登录账号缺少当前模型/接口权限。请切换可用模型，或确认账号订阅后重试。"
        : "Your OpenAI login account lacks permission for this model or endpoint. Try another model or verify account access.";
    }
  }

  if (authMode === "gemini_google_oauth" && protocol === "gemini") {
    if (isGeminiScopeError(normalized)) {
      return language === "zh"
        ? "Gemini 登录 token 缺少 cloud-platform 授权范围。请退出后重新登录 Gemini。"
        : "Your Gemini login token is missing cloud-platform scope. Log out and sign in again.";
    }
    if (isGeminiServiceDisabled(normalized)) {
      return language === "zh"
        ? "当前 Google Cloud Project 未启用 Cloud Code Private API。请在控制台启用 cloudcode-pa.googleapis.com 后重试。"
        : "The current Google Cloud project has not enabled Cloud Code Private API. Enable cloudcode-pa.googleapis.com and retry.";
    }
    if (isGeminiPermissionDenied(normalized)) {
      return language === "zh"
        ? "Gemini Code Assist 登录通道缺少项目权限或未完成 onboarding。请设置可用 GOOGLE_CLOUD_PROJECT 或重新登录。"
        : "Gemini Code Assist login lacks project permission or onboarding. Set a valid GOOGLE_CLOUD_PROJECT or sign in again.";
    }
    if (isGeminiInternalError(normalized)) {
      return language === "zh"
        ? "Gemini Code Assist 后端暂时不稳定。建议先试 gemini-2.5-pro/flash，或改用 Gemini API Key。"
        : "Gemini Code Assist backend is temporarily unstable. Try gemini-2.5-pro/flash first, or switch to Gemini API Key.";
    }
  }

  return null;
}

export function buildCloudAuthFriendlyError(options: {
  protocol?: CloudApiProtocol | unknown;
  authMode?: CloudAuthMode | unknown;
  error: unknown;
  language?: "zh" | "en";
  maxChars?: number;
}): string {
  const language = options.language === "en" ? "en" : "zh";
  const raw = summarizeCloudErrorMessage(options.error, options.maxChars ?? 280);
  const hint = getCloudAuthErrorHint(options);
  if (hint && raw) {
    return `${hint} ${language === "zh" ? "原始错误" : "Raw error"}: ${raw}`;
  }
  if (hint) return hint;
  return raw || (language === "zh" ? "未知错误" : "Unknown error");
}
