import {
  normalizeToolDefinitions,
  normalizeToolParametersSchema,
  type ToolDefinition,
} from "./toolSchemas";
import {
  buildContextMemoryState,
  contextMemoryContentToText,
  formatContextMemoryPacket,
  isContextMemoryMessage,
  type ContextMemoryState,
} from "./contextMemory";

export type CloudApiProtocol = "openai" | "anthropic" | "gemini";
export type OpenAiApiFormat = "chat_completions" | "responses";
export type OpenAiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type CloudToolProtocol = "auto" | "native" | "xml";
export type CloudAuthMode = "api_key" | "openai_chatgpt_oauth" | "gemini_google_oauth";

export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
export const OPENAI_CHATGPT_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const GEMINI_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:generateContent";
export const OPENAI_CHATGPT_CODEX_DEFAULT_INSTRUCTIONS = "You are MAIN, a concise coding assistant. Follow the user request exactly.";
export const OPENAI_CHATGPT_CODEX_MAX_INSTRUCTIONS_CHARS = 24_000;
export const OPENAI_CHATGPT_EXPERIMENTAL_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
];
export const GEMINI_EXPERIMENTAL_MODELS = [
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

interface TextContentPart {
  type: "text";
  text: string;
}

interface ImageUrlContentPart {
  type: "image_url";
  image_url: { url: string };
}

export type ProtocolContentPart = TextContentPart | ImageUrlContentPart;

export interface ProtocolToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ProtocolChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ProtocolContentPart[];
  tool_calls?: ProtocolToolCall[];
  tool_call_id?: string;
}

export interface StreamedToolCallLike {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export interface StreamResultLike {
  content: string;
  toolCalls: StreamedToolCallLike[];
  finishReason: "stop" | "length" | "tool_calls" | null;
}

export interface OpenAiResponsesInputCandidate {
  mode: "message_text" | "input_text_array" | "transcript_text";
  input: string | Record<string, unknown>[];
}

export interface OpenAiResponsesProbeRequestCandidate {
  mode: OpenAiResponsesInputCandidate["mode"];
  body: Record<string, unknown>;
}

export interface ModelInstructionProfile {
  provider: "openai" | "anthropic" | "qwen" | "deepseek" | "kimi" | "generic";
  visibleLanguage: "follow_user" | "localized";
  reasoning: "native_hidden" | "tagged" | "none";
  toolProtocolPreference: CloudToolProtocol;
  noiseRules: string[];
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicImageBlock {
  type: "image";
  source:
    | {
        type: "base64";
        media_type: string;
        data: string;
      }
    | {
        type: "url";
        url: string;
      };
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: ToolDefinition["function"]["parameters"];
}

export interface BuildAnthropicRequestOptions {
  messages: ProtocolChatMessage[];
  model: string;
  maxTokens: number;
  stream: boolean;
  temperature?: number;
  topP?: number;
  tools?: ToolDefinition[];
}

export interface BuildGeminiRequestOptions {
  messages: ProtocolChatMessage[];
  model: string;
  maxTokens?: number;
  tools?: ToolDefinition[];
  stream?: boolean;
  projectId?: string;
}

export interface AnthropicStreamProcessor {
  processChunk: (chunk: string) => void;
  flush: () => void;
  getResult: () => StreamResultLike;
}

const ANTHROPIC_THINKING_TAG_OPEN = "<thinking>";
const ANTHROPIC_THINKING_TAG_CLOSE = "</thinking>";

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars).trimEnd();
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function stripOpenAiChatPath(url: string): string {
  return url
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/chat\/completions$/i, "");
}

function stripOpenAiResponsesPath(url: string): string {
  return url
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/responses$/i, "");
}

function stripAnthropicMessagesPath(url: string): string {
  return url
    .replace(/\/v1\/messages$/i, "")
    .replace(/\/messages$/i, "");
}

function extractTextContent(content: string | ProtocolContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContentPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function extractAnthropicTextBlocks(content: string | ProtocolContentPart[]): AnthropicTextBlock[] {
  const text = extractTextContent(content);
  return text ? [{ type: "text", text }] : [];
}

function parseDataUrlImage(url: string): AnthropicImageBlock | null {
  const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) {
    if (/^https?:\/\//i.test(url)) {
      return {
        type: "image",
        source: {
          type: "url",
          url,
        },
      };
    }
    return null;
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: match[1],
      data: match[2],
    },
  };
}

function extractAnthropicUserBlocks(content: string | ProtocolContentPart[]): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      const imageBlock = parseDataUrlImage(part.image_url.url);
      if (imageBlock) blocks.push(imageBlock);
    }
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function safeParseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw_arguments: raw };
  }
}

function appendMergedMessage(
  target: AnthropicRequestMessage[],
  role: AnthropicRequestMessage["role"],
  blocks: AnthropicContentBlock[],
) {
  if (blocks.length === 0) return;
  const last = target[target.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
    return;
  }
  target.push({ role, content: [...blocks] });
}

function ensureAlternatingAnthropicMessages(messages: AnthropicRequestMessage[]): AnthropicRequestMessage[] {
  if (messages.length === 0) {
    return [{ role: "user", content: [{ type: "text", text: "" }] }];
  }
  if (messages[0]?.role !== "user") {
    return [
      { role: "user", content: [{ type: "text", text: "" }] },
      ...messages,
    ];
  }
  return messages;
}

export function normalizeCloudProtocol(protocol: unknown): CloudApiProtocol {
  if (protocol === "anthropic") return "anthropic";
  if (protocol === "gemini") return "gemini";
  return "openai";
}

export function normalizeCloudApiFormat(format: unknown): OpenAiApiFormat {
  return format === "responses" ? "responses" : "chat_completions";
}

export function normalizeOpenAiReasoningEffort(value: unknown): OpenAiReasoningEffort {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return "none";
  }
}

export function normalizeCloudToolProtocol(value: unknown): CloudToolProtocol {
  return value === "native" || value === "xml" ? value : "auto";
}

export function getDefaultLocalToolProtocol(provider: unknown): CloudToolProtocol {
  const normalized = String(provider || "").trim().toLowerCase();
  if (normalized === "lm studio") return "xml";
  if (normalized === "ollama") return "xml";
  return "auto";
}

export function normalizeLocalToolProtocol(value: unknown, provider: unknown): CloudToolProtocol {
  return value === "native" || value === "xml" || value === "auto"
    ? value
    : getDefaultLocalToolProtocol(provider);
}

export function normalizeCloudAuthMode(value: unknown): CloudAuthMode {
  if (value === "openai_chatgpt_oauth" || value === "gemini_google_oauth") return value;
  return "api_key";
}

export function getModelInstructionProfile(input: {
  protocol?: unknown;
  provider?: unknown;
  model?: unknown;
}): ModelInstructionProfile {
  const protocol = normalizeCloudProtocol(input.protocol);
  const providerText = String(input.provider || "").toLowerCase();
  const modelText = String(input.model || "").toLowerCase();
  const haystack = `${providerText} ${modelText}`;

  if (protocol === "anthropic" || /claude|anthropic/.test(haystack)) {
    return {
      provider: "anthropic",
      visibleLanguage: "follow_user",
      reasoning: "native_hidden",
      toolProtocolPreference: "native",
      noiseRules: [
        "Map thinking deltas to the thought block, not the assistant body.",
        "Hide repeated assistant prefaces and duplicate thought summaries.",
      ],
    };
  }

  if (/qwen|qwq/.test(haystack)) {
    return {
      provider: "qwen",
      visibleLanguage: "localized",
      reasoning: "tagged",
      toolProtocolPreference: "auto",
      noiseRules: [
        "Treat reasoning_content as hidden thought.",
        "Suppress repeated XML tool tags from visible text.",
      ],
    };
  }

  if (/deepseek/.test(haystack)) {
    return {
      provider: "deepseek",
      visibleLanguage: "localized",
      reasoning: "tagged",
      toolProtocolPreference: "auto",
      noiseRules: [
        "Treat reasoning deltas as hidden thought.",
        "Collapse duplicate assistant prefixes.",
      ],
    };
  }

  if (/kimi|moonshot/.test(haystack)) {
    return {
      provider: "kimi",
      visibleLanguage: "localized",
      reasoning: "none",
      toolProtocolPreference: "xml",
      noiseRules: [
        "Prefer XML tools on gateways with weak function-calling compatibility.",
        "Remove duplicated tool prose from visible answers.",
      ],
    };
  }

  if (protocol === "gemini" || /gemini|google/.test(haystack)) {
    return {
      provider: "generic",
      visibleLanguage: "follow_user",
      reasoning: "none",
      toolProtocolPreference: "xml",
      noiseRules: [
        "Prefer XML tools for Gemini until native tool compatibility is explicitly enabled.",
        "Keep visible replies concise and avoid repeating tool call prose.",
      ],
    };
  }

  return {
    provider: protocol === "openai" ? "openai" : "generic",
    visibleLanguage: "follow_user",
    reasoning: protocol === "openai" ? "native_hidden" : "none",
    toolProtocolPreference: "auto",
    noiseRules: [
      "Separate visible text, reasoning text, and tool calls before rendering.",
      "Deduplicate repeated thought summaries and assistant prefixes.",
    ],
  };
}

export function buildCloudMessagesApiUrl(
  endpoint: string,
  protocol: CloudApiProtocol,
  apiFormat: OpenAiApiFormat = "chat_completions",
): string {
  const normalized = normalizeUrl(endpoint);
  if (!normalized) return "";

  if (protocol === "anthropic") {
    const base = stripAnthropicMessagesPath(normalized);
    if (normalized.endsWith("/messages")) return normalized;
    if (base.endsWith("/v1")) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  if (protocol === "gemini") {
    const base = normalized
      .replace(/\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/i, "")
      .replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/i, "");
    return base.endsWith("/v1beta") ? base : `${base}/v1beta`;
  }

  const normalizedApiFormat = normalizeCloudApiFormat(apiFormat);
  const base = stripOpenAiResponsesPath(stripOpenAiChatPath(normalized));

  if (normalizedApiFormat === "responses") {
    if (normalized.endsWith("/responses")) return normalized;
    if (base.endsWith("/v1")) return `${base}/responses`;
    return `${base}/v1/responses`;
  }

  if (normalized.endsWith("/chat/completions")) return normalized;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function buildCloudModelListCandidates(endpoint: string, protocol: CloudApiProtocol): string[] {
  const normalized = normalizeUrl(endpoint);
  if (!normalized) return [];

  if (protocol === "anthropic") {
    const base = stripAnthropicMessagesPath(normalized);
    if (normalized.endsWith("/models")) return [normalized];
    if (base.endsWith("/v1")) return [`${base}/models`];
    return [`${base}/v1/models`];
  }

  if (protocol === "gemini") {
    const base = normalized
      .replace(/\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/i, "")
      .replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/i, "");
    if (normalized.endsWith("/models")) return [normalized];
    if (base.endsWith("/v1beta")) return [`${base}/models`];
    return [`${base}/v1beta/models`];
  }

  const base = stripOpenAiChatPath(normalized);
  if (normalized.endsWith("/models")) return [normalized];
  if (base.endsWith("/v1")) {
    return [`${base}/models`, `${base.replace(/\/v1$/i, "")}/models`];
  }
  return [`${base}/v1/models`, `${base}/models`];
}

export function buildCloudHeaders(
  protocol: CloudApiProtocol,
  apiKey: string,
  includeContentType = false,
  customHeadersInput?: unknown,
  authMode?: CloudAuthMode,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) headers["Content-Type"] = "application/json";

  if (protocol === "anthropic") {
    headers["anthropic-version"] = DEFAULT_ANTHROPIC_VERSION;
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (protocol === "gemini") {
    if (apiKey && normalizeCloudAuthMode(authMode) === "gemini_google_oauth") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (apiKey) {
      headers["x-goog-api-key"] = apiKey;
    }
  } else if (apiKey && normalizeCloudAuthMode(authMode) !== "openai_chatgpt_oauth") {
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
  }

  const { headers: customHeaders } = parseCloudCustomHeaders(customHeadersInput);
  Object.assign(headers, customHeaders);
  return headers;
}

export function parseCloudCustomHeaders(input: unknown): {
  headers: Record<string, string>;
  error: string | null;
} {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return { headers: {}, error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      headers: {},
      error: "额外请求头不是合法 JSON。请使用对象格式，例如 {\"HTTP-Referer\":\"https://example.com\"}。",
    };
  }

  const headers: Record<string, string> = {};
  const assignHeader = (name: unknown, value: unknown) => {
    if (typeof name !== "string" || !name.trim()) return;
    if (value == null) return;
    headers[name.trim()] = String(value);
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const header = (item as { header?: unknown; key?: unknown; name?: unknown }).header
        ?? (item as { key?: unknown }).key
        ?? (item as { name?: unknown }).name;
      const value = (item as { value?: unknown }).value;
      assignHeader(header, value);
    }
    return { headers, error: null };
  }

  if (parsed && typeof parsed === "object") {
    Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => assignHeader(key, value));
    return { headers, error: null };
  }

  return {
    headers: {},
    error: "额外请求头必须是 JSON 对象，或由 {header,value} 组成的 JSON 数组。",
  };
}

export function extractCloudModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const data = (payload as { data?: unknown }).data;
  if (Array.isArray(data)) {
    const models = data
      .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    if (models.length > 0) return Array.from(new Set(models));
  }

  const models = (payload as { models?: unknown }).models;
  if (Array.isArray(models)) {
    const extracted = models
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const candidate = (item as { id?: unknown; name?: unknown; model?: unknown }).id
          ?? (item as { name?: unknown }).name
          ?? (item as { model?: unknown }).model;
        if (typeof candidate !== "string" || !candidate.trim()) return null;
        return candidate.replace(/^models\//, "");
      })
      .filter((id): id is string => typeof id === "string");
    if (extracted.length > 0) return Array.from(new Set(extracted));
  }

  return [];
}

export function extractGeminiResponseText(payload: unknown): string {
  const responsePayload = extractGeminiResponsePayload(payload);
  if (!responsePayload || typeof responsePayload !== "object") return "";
  const candidates = (responsePayload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return "";
  return candidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") return "";
      const content = (candidate as { content?: { parts?: unknown } }).content;
      const parts = content?.parts;
      if (!Array.isArray(parts)) return "";
      return parts
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        })
        .join("");
    })
    .filter(Boolean)
    .join("");
}

export function extractAnthropicResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if ((block as { type?: unknown }).type !== "text") return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("");
}

function extractTextFromOpenAiContentArray(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const candidate = (part as { text?: unknown }).text;
      if (typeof candidate === "string") return candidate;
      const nestedText = (part as { text?: { value?: unknown } }).text?.value;
      return typeof nestedText === "string" ? nestedText : "";
    })
    .filter(Boolean)
    .join("");
}

export function extractOpenAiResponseText(
  payload: unknown,
  apiFormat: OpenAiApiFormat = "chat_completions",
): string {
  const normalizedApiFormat = normalizeCloudApiFormat(apiFormat);
  if (!payload || typeof payload !== "object") return "";

  if (normalizedApiFormat === "responses") {
    const outputText = (payload as { output_text?: unknown }).output_text;
    if (typeof outputText === "string" && outputText.trim()) return outputText;

    const output = (payload as { output?: unknown }).output;
    if (!Array.isArray(output)) return "";

    return output
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const content = (item as { content?: unknown }).content;
        const text = extractTextFromOpenAiContentArray(content);
        if (text) return text;
        const candidate = (item as { text?: unknown }).text;
        return typeof candidate === "string" ? candidate : "";
      })
      .filter(Boolean)
      .join("");
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const msg = message as {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
  };
  const content = msg.content;
  if (typeof content === "string") return content;
  const contentText = extractTextFromOpenAiContentArray(content);
  if (contentText) return contentText;

  // 部分 LM Studio / Qwen thinking 模型会把输出放在 reasoning 字段，
  // content 则为空；这里保留为可提取文本，后续会折叠到思考块或生成摘要。
  if (typeof msg.reasoning_content === "string") return `<thinking>${msg.reasoning_content}</thinking>`;
  if (typeof msg.reasoning === "string") return `<thinking>${msg.reasoning}</thinking>`;
  return "";
}

function mapMessageForResponsesLegacyInput(message: ProtocolChatMessage): Record<string, unknown> {
  const role = message.role === "tool" ? "user" : message.role;
  return {
    type: "message",
    role,
    content: extractTextContent(message.content),
  };
}

function mapMessageForResponsesInputTextArray(message: ProtocolChatMessage): Record<string, unknown> {
  const role = message.role === "tool" ? "user" : message.role;
  return {
    role,
    content: [
      {
        type: "input_text",
        text: extractTextContent(message.content),
      },
    ],
  };
}

function labelForResponsesTranscript(role: ProtocolChatMessage["role"]): string {
  switch (role) {
    case "system":
      return "System";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    default:
      return "User";
  }
}

export function buildOpenAiResponsesTranscript(messages: ProtocolChatMessage[]): string {
  return messages
    .filter((message) => message.role !== "system")
    .map((message, index) => {
      const text = extractTextContent(message.content).trim();
      if (!text) return "";
      return `[${labelForResponsesTranscript(message.role)} ${index + 1}]\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

const CLOUD_RESPONSES_INSTRUCTION_MAX_CHARS = 8000;
const CLOUD_RESPONSES_MESSAGE_KEEP_TAIL = 8;
const OPENAI_CHATGPT_PROBE_USER_PROMPT_ID = "main-cloud-test";

export interface CloudResponsesMessageCompactionOptions {
  contextMemoryState?: ContextMemoryState | null;
  maxInputMessages?: number;
  targetInputTokens?: number;
}

function truncateTextForCloud(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars for faster cloud response]`;
}

function compactProtocolMessageForCloud(message: ProtocolChatMessage): ProtocolChatMessage {
  const text = extractTextContent(message.content);
  const maxChars = message.role === "tool"
    ? 700
    : message.role === "assistant"
      ? 1200
      : 2200;

  return {
    ...message,
    content: truncateTextForCloud(text, maxChars),
    ...(message.tool_calls ? { tool_calls: message.tool_calls.slice(-3) } : {}),
  };
}

function buildCloudMemoryMessage(
  messages: ProtocolChatMessage[],
  options: CloudResponsesMessageCompactionOptions = {},
): ProtocolChatMessage | null {
  const explicitPacket = options.contextMemoryState
    ? formatContextMemoryPacket(options.contextMemoryState, 3200)
    : "";
  const existingMemoryMessage = [...messages].reverse().find((message) => isContextMemoryMessage(message));
  const existingPacket = existingMemoryMessage
    ? contextMemoryContentToText(existingMemoryMessage.content)
    : "";
  const packet = existingPacket || formatContextMemoryPacket(buildContextMemoryState(messages), 3200);
  const effectivePacket = explicitPacket || packet;
  return effectivePacket ? { role: "user", content: effectivePacket } : null;
}

export function compactCloudResponsesMessages(
  messages: ProtocolChatMessage[],
  options: CloudResponsesMessageCompactionOptions = {},
): ProtocolChatMessage[] {
  const systemMessages = messages.filter((message) => message.role === "system");
  const memoryMessage = buildCloudMemoryMessage(messages, options);
  const conversationMessages = messages.filter((message) => message.role !== "system" && !isContextMemoryMessage(message));
  const maxInputMessages = Math.max(
    6,
    options.maxInputMessages ||
      Math.min(18, Math.max(10, Math.floor((options.targetInputTokens || 9000) / 700))),
  );
  const reservedForMemoryAndSummary = (memoryMessage ? 1 : 0) + 1;
  const keepTail = Math.max(4, Math.min(CLOUD_RESPONSES_MESSAGE_KEEP_TAIL, maxInputMessages - reservedForMemoryAndSummary));

  if (conversationMessages.length <= keepTail + 2) {
    return [
      ...systemMessages,
      ...(memoryMessage ? [memoryMessage] : []),
      ...conversationMessages.map(compactProtocolMessageForCloud),
    ];
  }

  const omitted = conversationMessages.slice(0, -keepTail);
  const recent = conversationMessages.slice(-keepTail);
  const summary = omitted
    .filter((message) => {
      const text = extractTextContent(message.content);
      return (
        message.role === "user" ||
        message.role === "tool" ||
        /目标|必须|不要|错误|失败|next|todo|must|error|failed|path|file/i.test(text)
      );
    })
    .slice(-10)
    .map((message, index) => {
      const text = truncateTextForCloud(extractTextContent(message.content).replace(/\s+/g, " ").trim(), 260);
      return `${index + 1}. ${labelForResponsesTranscript(message.role)}: ${text}`;
    })
    .join("\n");

  return [
    ...systemMessages,
    ...(memoryMessage ? [memoryMessage] : []),
    {
      role: "user",
      content: [
        `[Cloud history summary: ${omitted.length} older non-pinned messages compacted for faster response; ContextState above is pinned task memory]`,
        summary,
      ].filter(Boolean).join("\n"),
    },
    ...recent.map(compactProtocolMessageForCloud),
  ];
}

export function compactCloudResponsesInstructions(instructions: string | undefined): string | undefined {
  if (!instructions) return undefined;
  if (instructions.length <= CLOUD_RESPONSES_INSTRUCTION_MAX_CHARS) return instructions;

  const lines = instructions.split(/\r?\n/);
  const keepPatterns = [
    /当前工作区|相对路径|workspace|工作区/i,
    /M Studio|Unity|游戏开发|教程|中文|Region|注释/i,
    /工具调用格式|tool_use|<tool>|parameter|XML/i,
    /write_file|replace_in_file|run_command|read_file|list_directory|get_project_skeleton|glob_search|grep_search/i,
    /不要声称.*没有写入|写入工具可用|文件访问|工作区权限/i,
    /TURN INTENT|USER INTENT|执行|修复|实现|计划|报告/i,
    /AGENTS|WORKSPACE INSTRUCTIONS|rules|instructions/i,
  ];
  const requiredToolReminder = [
    "[Cloud Compact Instructions]",
    "Use concise responses and prefer small tool-driven steps to avoid cloud gateway timeouts.",
    "Tool access is available through XML <tool_use> calls. Workspace read/write tools are available when the user asks for implementation.",
    "Available key tools: get_project_skeleton, list_directory, read_file, glob_search, grep_search, write_file, replace_in_file, run_command.",
    "Never claim write tools or folder access are unavailable; emit XML tool calls instead.",
  ];

  const keptLines: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (!keepPatterns.some((pattern) => pattern.test(trimmed))) continue;
    const normalized = trimmed.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    keptLines.push(trimmed);
  }

  const compact = [
    ...requiredToolReminder,
    "",
    ...keptLines,
    "",
    `[Cloud compacted ${instructions.length} chars of system instructions to reduce 524 timeout risk.]`,
  ].join("\n");

  return truncateTextForCloud(compact, CLOUD_RESPONSES_INSTRUCTION_MAX_CHARS);
}

export function buildOpenAiResponsesInputCandidates(
  messages: ProtocolChatMessage[],
): OpenAiResponsesInputCandidate[] {
  const filteredMessages = messages.filter((message) => message.role !== "system");
  const inputMessages = filteredMessages.length > 0
    ? filteredMessages
    : [{ role: "user", content: "" } as ProtocolChatMessage];
  const transcript = buildOpenAiResponsesTranscript(inputMessages);

  return [
    {
      mode: "message_text",
      input: inputMessages.map(mapMessageForResponsesLegacyInput),
    },
    {
      mode: "input_text_array",
      input: inputMessages.map(mapMessageForResponsesInputTextArray),
    },
    {
      mode: "transcript_text",
      input: transcript,
    },
  ];
}

export function extractOpenAiResponsesInstructions(
  messages: ProtocolChatMessage[],
): string | undefined {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => extractTextContent(message.content).trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return instructions || undefined;
}

export function buildOpenAiResponsesRequestExtras(options?: {
  disableResponseStorage?: boolean;
  reasoningEffort?: unknown;
}): Record<string, unknown> {
  const extras: Record<string, unknown> = {
    stream: false,
  };

  if (options?.disableResponseStorage) {
    extras.store = false;
  }

  const reasoningEffort = normalizeOpenAiReasoningEffort(options?.reasoningEffort);
  if (reasoningEffort !== "none") {
    extras.reasoning = { effort: reasoningEffort };
  }

  return extras;
}

export function buildOpenAiResponsesRequestCandidates(options: {
  messages: ProtocolChatMessage[];
  model: string;
  tools?: ToolDefinition[];
  disableResponseStorage?: boolean;
  reasoningEffort?: unknown;
  compact?: boolean;
  includeTools?: boolean;
  contextMemoryState?: ContextMemoryState | null;
  targetInputTokens?: number;
}): OpenAiResponsesProbeRequestCandidate[] {
  const protocolMessages = options.compact
    ? compactCloudResponsesMessages(options.messages, {
        contextMemoryState: options.contextMemoryState,
        targetInputTokens: options.targetInputTokens,
      })
    : options.messages;
  const rawInstructions = extractOpenAiResponsesInstructions(protocolMessages);
  const instructions = options.compact
    ? compactCloudResponsesInstructions(rawInstructions)
    : rawInstructions;
  const tools = options.includeTools === false ? [] : convertOpenAiToolsToResponses(options.tools);

  return buildOpenAiResponsesInputCandidates(protocolMessages).map((candidate) => {
    const candidateTools = candidate.mode !== "transcript_text" ? tools : [];
    return {
      mode: candidate.mode,
      body: {
        model: options.model,
        input: candidate.input,
        ...(instructions ? { instructions } : {}),
        ...(candidateTools.length > 0 ? { tools: candidateTools } : {}),
        ...buildOpenAiResponsesRequestExtras({
          disableResponseStorage: options.disableResponseStorage,
          reasoningEffort: options.reasoningEffort,
        }),
      },
    };
  });
}

export function buildOpenAiResponsesProbeRequestCandidates(options: {
  messages: ProtocolChatMessage[];
  model: string;
  includeAdvanced?: boolean;
  disableResponseStorage?: boolean;
  reasoningEffort?: unknown;
  authMode?: CloudAuthMode;
}): OpenAiResponsesProbeRequestCandidate[] {
  const inputCandidates = buildOpenAiResponsesInputCandidates(options.messages);
  const isChatGptOauth = normalizeCloudAuthMode(options.authMode) === "openai_chatgpt_oauth";
  const orderedCandidates = isChatGptOauth
    ? [
        ...inputCandidates.filter((candidate) => candidate.mode === "input_text_array"),
        ...inputCandidates.filter((candidate) => candidate.mode !== "input_text_array"),
      ]
    : [
        ...inputCandidates.filter((candidate) => candidate.mode === "transcript_text"),
        ...inputCandidates.filter((candidate) => candidate.mode !== "transcript_text"),
      ];
  const extras = options.includeAdvanced
    ? buildOpenAiResponsesRequestExtras({
        disableResponseStorage: options.disableResponseStorage,
        reasoningEffort: options.reasoningEffort,
      })
    : buildOpenAiResponsesRequestExtras();

  return orderedCandidates.map((candidate) => ({
    mode: candidate.mode,
    body: {
      model: options.model,
      input: candidate.input,
      ...(isChatGptOauth ? { user_prompt_id: OPENAI_CHATGPT_PROBE_USER_PROMPT_ID } : {}),
      ...extras,
    },
  }));
}

export function ensureOpenAiChatGptCodexRequestBody(
  body: Record<string, unknown>,
  options: {
    userPromptId?: string;
    instructions?: string;
  } = {},
): Record<string, unknown> {
  const rawInstructions = typeof options.instructions === "string" && options.instructions.trim()
    ? options.instructions.trim()
    : typeof body.instructions === "string" && body.instructions.trim()
      ? body.instructions.trim()
      : OPENAI_CHATGPT_CODEX_DEFAULT_INSTRUCTIONS;
  const instructions = truncateText(rawInstructions, OPENAI_CHATGPT_CODEX_MAX_INSTRUCTIONS_CHARS);
  return {
    ...body,
    instructions,
    stream: true,
    store: false,
    ...(typeof body.user_prompt_id === "string" && body.user_prompt_id.trim()
      ? {}
      : { user_prompt_id: options.userPromptId || OPENAI_CHATGPT_PROBE_USER_PROMPT_ID }),
  };
}

export function parseOpenAiResponsesSseText(streamText: string): string {
  const lines = String(streamText || "").split(/\r?\n/);
  let eventName = "";
  let text = "";
  const flushData = (rawData: string) => {
    const data = rawData.trim();
    if (!data || data === "[DONE]") return;
    try {
      const payload = JSON.parse(data);
      const delta = (payload as { delta?: unknown }).delta;
      if (typeof delta === "string" && (eventName === "response.output_text.delta" || !eventName)) {
        text += delta;
        return;
      }
      const outputText = (payload as { output_text?: unknown }).output_text;
      if (typeof outputText === "string") {
        text += outputText;
        return;
      }
      const responseText = extractOpenAiResponseText(payload, "responses");
      if (responseText) text += responseText;
    } catch {
      // Ignore malformed SSE data lines.
    }
  };

  let dataLines: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      flushData(dataLines.join("\n"));
      dataLines = [];
      eventName = "";
      continue;
    }
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flushData(dataLines.join("\n"));
  return text;
}

function mapGeminiRole(role: ProtocolChatMessage["role"]): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

export function buildGeminiRequestBody(options: BuildGeminiRequestOptions): Record<string, unknown> {
  const systemInstruction = extractOpenAiResponsesInstructions(options.messages);
  const contents = options.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: mapGeminiRole(message.role),
      parts: [{ text: extractTextContent(message.content) }],
    }))
    .filter((item) => String(item.parts[0].text || "").trim().length > 0);

  const body: Record<string, unknown> = {
    contents: contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "" }] }],
  };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (options.maxTokens) body.generationConfig = { maxOutputTokens: options.maxTokens };
  return body;
}

export function buildGeminiCodeAssistRequestBody(options: BuildGeminiRequestOptions): Record<string, unknown> {
  const cleanModel = options.model.replace(/^models\//, "").trim();
  return {
    model: cleanModel,
    ...(options.projectId ? { project: options.projectId } : {}),
    user_prompt_id: `main-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    request: buildGeminiRequestBody({
      ...options,
      model: cleanModel,
    }),
  };
}

export function buildGeminiGenerateContentUrl(endpoint: string, model: string, stream = false): string {
  const base = buildCloudMessagesApiUrl(endpoint, "gemini");
  const cleanModel = model.replace(/^models\//, "").trim();
  const action = stream ? "streamGenerateContent" : "generateContent";
  return `${base}/models/${encodeURIComponent(cleanModel)}:${action}`;
}

export function buildGeminiRequestForAuthMode(
  endpoint: string,
  options: BuildGeminiRequestOptions,
  authMode?: CloudAuthMode,
): { url: string; body: Record<string, unknown>; responseMode: "native" | "code_assist" } {
  if (normalizeCloudAuthMode(authMode) === "gemini_google_oauth") {
    return {
      url: GEMINI_CODE_ASSIST_ENDPOINT,
      body: buildGeminiCodeAssistRequestBody(options),
      responseMode: "code_assist",
    };
  }
  return {
    url: buildGeminiGenerateContentUrl(endpoint, options.model, Boolean(options.stream)),
    body: buildGeminiRequestBody(options),
    responseMode: "native",
  };
}

export function extractGeminiResponsePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const response = (payload as { response?: unknown }).response;
  return response && typeof response === "object" ? response : payload;
}

export function convertOpenAiToolsToResponses(tools: ToolDefinition[] | undefined): Record<string, unknown>[] {
  if (!tools || tools.length === 0) return [];
  return normalizeToolDefinitions(tools).map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: normalizeToolParametersSchema(tool.function.parameters),
  }));
}

export function convertOpenAiToolsToAnthropic(tools: ToolDefinition[] | undefined): AnthropicToolDefinition[] {
  if (!tools || tools.length === 0) return [];
  return normalizeToolDefinitions(tools).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: normalizeToolParametersSchema(tool.function.parameters),
  }));
}

export function mapMessagesForAnthropic(messages: ProtocolChatMessage[]): {
  system?: string;
  messages: AnthropicRequestMessage[];
} {
  const systemParts: string[] = [];
  const mapped: AnthropicRequestMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = extractTextContent(message.content).trim();
      if (text) systemParts.push(text);
      continue;
    }

    if (message.role === "user") {
      appendMergedMessage(mapped, "user", extractAnthropicUserBlocks(message.content));
      continue;
    }

    if (message.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [
        ...extractAnthropicTextBlocks(message.content),
      ];
      for (const toolCall of message.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: safeParseToolArguments(toolCall.function.arguments),
        });
      }
      appendMergedMessage(mapped, "assistant", blocks);
      continue;
    }

    if (message.role === "tool") {
      appendMergedMessage(mapped, "user", [{
        type: "tool_result",
        tool_use_id: message.tool_call_id || "tool_result_missing_id",
        content: extractTextContent(message.content),
      }]);
    }
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: ensureAlternatingAnthropicMessages(mapped),
  };
}

export function buildAnthropicRequestBody(options: BuildAnthropicRequestOptions): Record<string, unknown> {
  const mapped = mapMessagesForAnthropic(options.messages);
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxTokens,
    stream: options.stream,
    messages: mapped.messages,
  };

  if (mapped.system) body.system = mapped.system;

  const anthropicTools = convertOpenAiToolsToAnthropic(options.tools);
  if (anthropicTools.length > 0) body.tools = anthropicTools;
  if (options.temperature != null) body.temperature = options.temperature;
  if (options.topP != null) body.top_p = options.topP;

  return body;
}

export function finalizeStreamedToolCalls(
  toolCallsMap: Map<number, StreamedToolCallLike>,
): StreamedToolCallLike[] {
  return Array.from(toolCallsMap.values())
    .sort((a, b) => a.index - b.index)
    .map((call, index) => ({
      ...call,
      id: call.id?.trim() || `stream_call_${index + 1}`,
      name: call.name?.trim() || `unknown_tool_${index + 1}`,
      arguments: call.arguments || "{}",
    }));
}

function mapAnthropicStopReason(stopReason: unknown): StreamResultLike["finishReason"] {
  if (stopReason === "end_turn" || stopReason === "stop_sequence" || stopReason === "pause_turn") {
    return "stop";
  }
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return null;
}

export function createAnthropicStreamProcessor(onToken: (token: string) => void): AnthropicStreamProcessor {
  let buffer = "";
  let currentEvent: string | null = null;
  let currentDataLines: string[] = [];
  let fullContent = "";
  let thinkingOpen = false;
  let finishReason: StreamResultLike["finishReason"] = null;

  const toolCallsMap = new Map<number, StreamedToolCallLike>();
  const toolInputFallbacks = new Map<number, unknown>();

  function finalizePendingEvent() {
    if (!currentEvent && currentDataLines.length === 0) return;

    const eventType = currentEvent;
    const rawData = currentDataLines.join("\n").trim();
    currentEvent = null;
    currentDataLines = [];

    if (!eventType || !rawData || rawData === "[DONE]") return;

    let payload: any;
    try {
      payload = JSON.parse(rawData);
    } catch {
      return;
    }

    switch (eventType) {
      case "content_block_start": {
        const index = typeof payload?.index === "number" ? payload.index : 0;
        const contentBlock = payload?.content_block;
        if (!contentBlock || typeof contentBlock !== "object") return;
        if (contentBlock.type === "tool_use") {
          toolCallsMap.set(index, {
            index,
            id: typeof contentBlock.id === "string" ? contentBlock.id : "",
            name: typeof contentBlock.name === "string" ? contentBlock.name : "",
            arguments: "",
          });
          if (contentBlock.input !== undefined) {
            toolInputFallbacks.set(index, contentBlock.input);
          }
        }
        return;
      }
      case "content_block_delta": {
        const index = typeof payload?.index === "number" ? payload.index : 0;
        const delta = payload?.delta;
        if (!delta || typeof delta !== "object") return;

        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (thinkingOpen) {
            thinkingOpen = false;
            fullContent += ANTHROPIC_THINKING_TAG_CLOSE;
            onToken(ANTHROPIC_THINKING_TAG_CLOSE);
          }
          fullContent += delta.text;
          onToken(delta.text);
          return;
        }

        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          if (!thinkingOpen) {
            thinkingOpen = true;
            fullContent += ANTHROPIC_THINKING_TAG_OPEN;
            onToken(ANTHROPIC_THINKING_TAG_OPEN);
          }
          fullContent += delta.thinking;
          onToken(delta.thinking);
          return;
        }

        if (delta.type === "thinking_delta" && typeof delta.text === "string") {
          if (!thinkingOpen) {
            thinkingOpen = true;
            fullContent += ANTHROPIC_THINKING_TAG_OPEN;
            onToken(ANTHROPIC_THINKING_TAG_OPEN);
          }
          fullContent += delta.text;
          onToken(delta.text);
          return;
        }

        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const existing = toolCallsMap.get(index) ?? {
            index,
            id: "",
            name: "",
            arguments: "",
          };
          existing.arguments += delta.partial_json;
          toolCallsMap.set(index, existing);
          return;
        }
        return;
      }
      case "message_delta": {
        finishReason = mapAnthropicStopReason(payload?.delta?.stop_reason ?? payload?.stop_reason);
        return;
      }
      case "error": {
        const message = payload?.error?.message;
        throw new Error(typeof message === "string" && message.trim() ? message : rawData);
      }
      case "ping":
      case "message_start":
      case "content_block_stop":
      case "message_stop":
      default:
        return;
    }
  }

  function processLine(rawLine: string) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) {
      finalizePendingEvent();
      return;
    }
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      currentDataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    processChunk(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    },
    flush() {
      if (buffer) {
        processLine(buffer);
        buffer = "";
      }
      finalizePendingEvent();
      if (thinkingOpen) {
        thinkingOpen = false;
        fullContent += ANTHROPIC_THINKING_TAG_CLOSE;
        onToken(ANTHROPIC_THINKING_TAG_CLOSE);
      }

      for (const [index, fallbackInput] of toolInputFallbacks.entries()) {
        const existing = toolCallsMap.get(index);
        if (!existing || existing.arguments) continue;
        try {
          existing.arguments = JSON.stringify(fallbackInput ?? {});
        } catch {
          existing.arguments = "{}";
        }
      }
    },
    getResult() {
      return {
        content: fullContent,
        toolCalls: finalizeStreamedToolCalls(toolCallsMap),
        finishReason,
      };
    },
  };
}
