import fs from "node:fs";

// #region 错误与环境配置
const TEXT_CONTENT_TYPES = new Set(["input_text", "output_text", "text"]);

export class GatewayError extends Error {
  constructor(message, { status = 500, code = "gateway_error", details } = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function loadEnvFile(filePath = ".env") {
  try {
    const text = readTextFile(filePath);
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const equalsIndex = trimmed.indexOf("=");
      const key = trimmed.slice(0, equalsIndex).trim();
      let value = trimmed.slice(equalsIndex + 1).trim();
      if (!key || process.env[key] !== undefined) continue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

export function getConfig(env = process.env) {
  return {
    port: Number(env.PORT || 8787),
    model: env.UPSTREAM_MODEL || "ai-max-cloud",
    upstreamBaseUrl: stripTrailingSlash(env.UPSTREAM_BASE_URL || ""),
    upstreamPath: env.UPSTREAM_PATH || "/chat/completions",
    upstreamApiKey: env.UPSTREAM_API_KEY || env.AIMAX_API_KEY || "",
    upstreamAuthHeader: env.UPSTREAM_AUTH_HEADER || "Authorization",
    upstreamAuthScheme: env.UPSTREAM_AUTH_SCHEME === undefined ? "Bearer" : env.UPSTREAM_AUTH_SCHEME,
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 300000),
  };
}
// #endregion

// #region Codex Responses 输入转换
export function buildPromptFromResponsesInput({ input, instructions }) {
  const messages = [];

  if (instructions) {
    messages.push({ role: "system", content: stringifyText(instructions) });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (!Array.isArray(input)) {
    throw new GatewayError("Only string or array `input` is supported.", { status: 400, code: "unsupported_input" });
  }

  for (const item of input) {
    if (!item || typeof item !== "object") {
      throw new GatewayError("Every input item must be an object.", { status: 400, code: "invalid_input_item" });
    }

    if (item.type && item.type !== "message") {
      throw new GatewayError(`Unsupported input item type: ${item.type}`, { status: 400, code: "unsupported_input_type" });
    }

    const role = normalizeRole(item.role);
    const content = extractTextContent(item.content);
    if (content.trim()) messages.push({ role, content });
  }

  if (messages.length === 0) {
    throw new GatewayError("No text input was provided.", { status: 400, code: "empty_input" });
  }

  return messages;
}
// #endregion

// #region 上游请求构造
export function buildUpstreamRequestBody(codexBody, config) {
  return {
    model: config.upstreamModelOverride || config.model,
    messages: buildPromptFromResponsesInput({
      input: codexBody.input,
      instructions: codexBody.instructions,
    }),
    stream: Boolean(codexBody.stream),
    temperature: codexBody.temperature,
    max_tokens: codexBody.max_output_tokens,
  };
}

export function buildUpstreamHeaders(config) {
  const headers = { "Content-Type": "application/json" };
  if (!config.upstreamApiKey) return headers;

  const authValue = config.upstreamAuthScheme
    ? `${config.upstreamAuthScheme} ${config.upstreamApiKey}`
    : config.upstreamApiKey;
  headers[config.upstreamAuthHeader] = authValue;
  return headers;
}

export function buildUpstreamUrl(config) {
  if (!config.upstreamBaseUrl) {
    throw new GatewayError("UPSTREAM_BASE_URL is required.", { status: 500, code: "missing_upstream_base_url" });
  }
  return `${config.upstreamBaseUrl}${config.upstreamPath.startsWith("/") ? "" : "/"}${config.upstreamPath}`;
}
// #endregion

// #region 上游流式输出解析
export function extractTextDeltaFromUpstreamPayload(payload) {
  if (payload === "[DONE]") return { done: true, text: "" };
  if (!payload || typeof payload !== "object") return { done: false, text: "" };

  const text = firstString([
    payload.text,
    payload.delta,
    payload.content,
    payload.output_text,
    payload.response,
    payload.message?.content,
    payload.choices?.[0]?.delta?.content,
    payload.choices?.[0]?.text,
    payload.choices?.[0]?.message?.content,
  ]);

  const finishReason = payload.finish_reason || payload.choices?.[0]?.finish_reason;
  return { done: Boolean(finishReason), text };
}

export async function* parseUpstreamTextStream(readableStream) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of readableStream) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      for (const payload of parseStreamBlock(part)) {
        yield payload;
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const payload of parseStreamBlock(buffer)) {
      yield payload;
    }
  }
}

function parseStreamBlock(block) {
  const lines = block.split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    const trimmed = block.trim();
    if (!trimmed) return [];
    return trimmed.split(/\r?\n/).map(parseJsonOrText);
  }

  return [parseJsonOrText(dataLines.join("\n"))];
}

function parseJsonOrText(value) {
  const trimmed = value.trim();
  if (trimmed === "[DONE]") return "[DONE]";
  try {
    return JSON.parse(trimmed);
  } catch {
    return { text: value };
  }
}
// #endregion

// #region 通用工具
function normalizeRole(role) {
  if (["system", "developer", "user", "assistant"].includes(role)) {
    return role === "developer" ? "system" : role;
  }
  throw new GatewayError(`Unsupported role: ${role || "missing"}`, { status: 400, code: "unsupported_role" });
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new GatewayError("Only text message content is supported.", { status: 400, code: "unsupported_content" });
  }

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object" || !TEXT_CONTENT_TYPES.has(part.type)) {
      throw new GatewayError("Images, files, tool calls, and non-text content are not supported yet.", {
        status: 400,
        code: "unsupported_content_part",
      });
    }
    parts.push(stringifyText(part.text));
  }
  return parts.filter(Boolean).join("\n");
}

function stringifyText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
// #endregion
