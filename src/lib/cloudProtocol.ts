import {
  normalizeToolDefinitions,
  normalizeToolParametersSchema,
  type ToolDefinition,
} from "./toolSchemas";
import { buildToolProtocolCard } from "./systemPrompt";
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
export type ModelReasoningMode = "disabled" | "passive_hidden" | "native_enabled";
export type ReasoningDisplayMode = "hidden" | "debug_summary" | "raw_debug";
export type ReasoningRequestMode = "auto" | "off" | "explicit";

export interface ReasoningPolicy {
  mode: ModelReasoningMode;
  request: ReasoningRequestMode;
  display: ReasoningDisplayMode;
  replayInContext: boolean;
  maxHiddenChars: number;
}

export function resolveReasoningPolicy(input: {
  activeProfile?: "local" | "cloud";
  requestedMode?: ModelReasoningMode | null;
  reasoningRequest?: ReasoningRequestMode | null;
  reasoningDisplay?: ReasoningDisplayMode | null;
  reasoningEffort?: OpenAiReasoningEffort | null;
} = {}): ReasoningPolicy {
  const request = input.reasoningRequest === "explicit" || input.reasoningRequest === "auto"
    ? input.reasoningRequest
    : "off";
  const display = input.reasoningDisplay === "debug_summary" || input.reasoningDisplay === "raw_debug"
    ? input.reasoningDisplay
    : "hidden";
  const nativeRequested =
    input.activeProfile === "cloud" &&
    request !== "off" &&
    !!input.reasoningEffort &&
    input.reasoningEffort !== "none";
  const mode = input.requestedMode === "native_enabled" || nativeRequested
    ? "native_enabled"
    : input.requestedMode === "disabled"
    ? "disabled"
    : "passive_hidden";
  return {
    mode,
    request,
    display,
    replayInContext: mode === "native_enabled" && request === "explicit",
    maxHiddenChars: display === "raw_debug" ? 36_000 : 8_000,
  };
}

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

export const DEFAULT_LOCAL_PROVIDER_ENDPOINTS = {
  "LM Studio": "http://127.0.0.1:1234/v1",
  Ollama: "http://127.0.0.1:11434/v1",
  OMLX: "http://127.0.0.1:8000/v1",
} as const;

export function getDefaultLocalProviderEndpoint(
  provider: string,
  fallback = "",
): string {
  return DEFAULT_LOCAL_PROVIDER_ENDPOINTS[
    provider as keyof typeof DEFAULT_LOCAL_PROVIDER_ENDPOINTS
  ] ?? fallback;
}

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
  reasoning_content?: string;
  reasoning?: string;
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
  reasoningContent?: string;
  reasoningField?: "reasoning_content" | "reasoning";
}

export interface OpenAiResponsesInputCandidate {
  mode: "message_text" | "input_text_array" | "transcript_text";
  input: string | Record<string, unknown>[];
}

export interface OpenAiResponsesProbeRequestCandidate {
  mode: OpenAiResponsesInputCandidate["mode"];
  body: Record<string, unknown>;
}

export type OpenAiResponsesTerminalStatus =
  | "completed"
  | "failed"
  | "incomplete"
  | "in_progress"
  | "unknown";

export interface OpenAiResponsesTerminalState {
  status: OpenAiResponsesTerminalStatus;
  error: string | null;
  incompleteReason: string | null;
}

export interface ProtocolInstructionProfile {
  provider: "openai" | "anthropic" | "gemini" | "generic";
  visibleLanguage: "follow_user";
  reasoning: ModelReasoningMode;
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

function parseBase64DataUrlImage(url: string): { mimeType: string; data: string } | null {
  const match = String(url || "").match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function extractAnthropicTextBlocks(content: string | ProtocolContentPart[]): AnthropicTextBlock[] {
  const text = extractTextContent(content);
  return text ? [{ type: "text", text }] : [];
}

function parseDataUrlImage(url: string): AnthropicImageBlock | null {
  const dataUrl = parseBase64DataUrlImage(url);
  if (!dataUrl) {
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
      media_type: dataUrl.mimeType,
      data: dataUrl.data,
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

export function resolveEffectiveCloudApiFormat(options: {
  protocol?: unknown;
  apiFormat?: unknown;
  authMode?: unknown;
}): OpenAiApiFormat {
  const protocol = normalizeCloudProtocol(options.protocol);
  const authMode = normalizeCloudAuthMode(options.authMode);
  if (protocol === "openai" && authMode === "openai_chatgpt_oauth") {
    return "responses";
  }
  return normalizeCloudApiFormat(options.apiFormat);
}

export function getProtocolInstructionProfile(input: {
  protocol?: unknown;
}): ProtocolInstructionProfile {
  const protocol = normalizeCloudProtocol(input.protocol);

  if (protocol === "anthropic") {
    return {
      provider: "anthropic",
      visibleLanguage: "follow_user",
      reasoning: "passive_hidden",
      toolProtocolPreference: "native",
      noiseRules: [
        "Treat provider thinking deltas as hidden metadata, not assistant body text or progress evidence.",
        "Keep visible replies to public progress, tool calls, or final answers.",
      ],
    };
  }

  if (protocol === "gemini") {
    return {
      provider: "gemini",
      visibleLanguage: "follow_user",
      reasoning: "disabled",
      toolProtocolPreference: "xml",
      noiseRules: [
        "Prefer XML tools for Gemini until native tool compatibility is explicitly enabled.",
        "Keep visible replies concise and avoid repeating tool call prose.",
      ],
    };
  }

  return {
    provider: "openai",
    visibleLanguage: "follow_user",
    reasoning: "passive_hidden",
    toolProtocolPreference: "auto",
    noiseRules: [
      "Separate visible text, hidden reasoning metadata, and tool calls before rendering.",
      "Do not treat hidden reasoning as completion or progress evidence.",
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

  // Some local OpenAI-compatible servers return only reasoning fields with
  // empty content. Hidden reasoning must stay metadata; callers extract it
  // separately when the endpoint exposes structured fields.
  return "";
}

type ResponsesInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

function responsesInputContentParts(content: ProtocolContentPart[]): ResponsesInputContentPart[] {
  const parts: ResponsesInputContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "input_text", text: part.text });
    } else {
      parts.push({ type: "input_image", image_url: part.image_url.url });
    }
  }
  return parts;
}

function hasImageContentPart(content: ProtocolChatMessage["content"]): content is ProtocolContentPart[] {
  return Array.isArray(content) && content.some((part) => part.type === "image_url");
}

function mapMessageForResponsesLegacyInput(message: ProtocolChatMessage): Record<string, unknown> {
  const role = message.role === "tool" ? "user" : message.role;
  return {
    type: "message",
    role,
    content: hasImageContentPart(message.content)
      ? responsesInputContentParts(message.content)
      : extractTextContent(message.content),
  };
}

function mapMessageForResponsesInputTextArray(message: ProtocolChatMessage): Record<string, unknown> {
  const role = message.role === "tool" ? "user" : message.role;
  return {
    role,
    content: hasImageContentPart(message.content)
      ? responsesInputContentParts(message.content)
      : [{ type: "input_text", text: extractTextContent(message.content) }],
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
  aggressive?: boolean;
}

function truncateTextForCloud(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars for faster cloud response]`;
}

function compactProtocolMessageForCloud(
  message: ProtocolChatMessage,
  options: Pick<CloudResponsesMessageCompactionOptions, "aggressive"> & {
    preserveImages?: boolean;
  } = {},
): ProtocolChatMessage {
  const text = extractTextContent(message.content);
  const maxChars = options.aggressive
    ? message.role === "tool"
      ? 900
      : message.role === "assistant"
        ? 700
        : 1000
    : message.role === "tool"
      ? 2200
      : message.role === "assistant"
        ? 1200
        : 2200;

  const compactedText = truncateTextForCloud(text, maxChars);
  const messageContent = message.content;
  let compactedContent: ProtocolChatMessage["content"] = compactedText;
  if (options.preserveImages && hasImageContentPart(messageContent)) {
    const parts: ProtocolContentPart[] = [];
    const firstTextIndex = messageContent.findIndex((candidate) => candidate.type === "text");
    for (let index = 0; index < messageContent.length; index += 1) {
      const part = messageContent[index];
      if (part.type === "image_url") {
        parts.push({ type: "image_url", image_url: { url: part.image_url.url } });
      } else if (index === firstTextIndex && compactedText) {
        parts.push({ type: "text", text: compactedText });
      }
    }
    compactedContent = parts;
  }

  return {
    ...message,
    content: compactedContent,
    ...(message.tool_calls ? { tool_calls: message.tool_calls.slice(-3) } : {}),
  };
}

function buildCloudMemoryMessage(
  messages: ProtocolChatMessage[],
  options: CloudResponsesMessageCompactionOptions = {},
): ProtocolChatMessage | null {
  const maxPacketChars = options.aggressive ? 1800 : 3200;
  const explicitPacket = options.contextMemoryState
    ? formatContextMemoryPacket(options.contextMemoryState, maxPacketChars)
    : "";
  const existingMemoryMessage = [...messages].reverse().find((message) => isContextMemoryMessage(message));
  const existingPacket = existingMemoryMessage
    ? contextMemoryContentToText(existingMemoryMessage.content)
    : "";
  const packet = existingPacket || formatContextMemoryPacket(buildContextMemoryState(messages), maxPacketChars);
  const effectivePacket = truncateTextForCloud(explicitPacket || packet, maxPacketChars);
  return effectivePacket ? { role: "user", content: effectivePacket } : null;
}

export function compactCloudResponsesMessages(
  messages: ProtocolChatMessage[],
  options: CloudResponsesMessageCompactionOptions = {},
): ProtocolChatMessage[] {
  const aggressive = options.aggressive === true;
  const systemMessages = messages.filter((message) => message.role === "system");
  const memoryMessage = buildCloudMemoryMessage(messages, options);
  const conversationMessages = messages.filter((message) => message.role !== "system" && !isContextMemoryMessage(message));
  const latestImageMessage = [...conversationMessages]
    .reverse()
    .find((message) => hasImageContentPart(message.content));
  const maxInputMessages = Math.max(
    aggressive ? 4 : 6,
    options.maxInputMessages ||
      (aggressive
        ? Math.min(8, Math.max(5, Math.floor((options.targetInputTokens || 6000) / 900)))
        : Math.min(18, Math.max(10, Math.floor((options.targetInputTokens || 9000) / 700)))),
  );
  const reservedForMemoryAndSummary = (memoryMessage ? 1 : 0) + 1;
  const keepTail = Math.max(
    aggressive ? 3 : 4,
    Math.min(aggressive ? 4 : CLOUD_RESPONSES_MESSAGE_KEEP_TAIL, maxInputMessages - reservedForMemoryAndSummary),
  );

  if (conversationMessages.length <= keepTail + 2) {
    return [
      ...systemMessages,
      ...(memoryMessage ? [memoryMessage] : []),
      ...conversationMessages.map((message) => compactProtocolMessageForCloud(message, {
        aggressive,
        preserveImages: message === latestImageMessage,
      })),
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
    .slice(aggressive ? -6 : -10)
    .map((message, index) => {
      const text = truncateTextForCloud(extractTextContent(message.content).replace(/\s+/g, " ").trim(), aggressive ? 180 : 260);
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
    ...recent.map((message) => compactProtocolMessageForCloud(message, {
      aggressive,
      preserveImages: message === latestImageMessage,
    })),
  ];
}

export type CompactResponsesToolProtocol = "native" | "xml" | "none";

export function compactCloudResponsesInstructions(
  instructions: string | undefined,
  options: Pick<CloudResponsesMessageCompactionOptions, "aggressive"> & {
    toolProtocol?: CompactResponsesToolProtocol;
    toolDefinitions?: ToolDefinition[];
  } = {},
): string | undefined {
  if (!instructions) return undefined;
  const maxChars = options.aggressive ? 3000 : CLOUD_RESPONSES_INSTRUCTION_MAX_CHARS;
  if (!options.aggressive && instructions.length <= maxChars && !options.toolProtocol) return instructions;

  // Visual observations are an execution contract, not ordinary prompt
  // prose. If compaction keeps the image but drops this block, transport can
  // truthfully report `delivered` while the model is never asked to emit the
  // observation receipt that distinguishes pixel inspection from a guess.
  // Preserve the newest block verbatim and compact only the remaining prose.
  const visualProtocolPattern = /\[visual_observation_protocol\][\s\S]*?\[\/visual_observation_protocol\]/gi;
  const visualProtocolBlocks = [...instructions.matchAll(visualProtocolPattern)]
    .map((match) => String(match[0] || "").trim())
    .filter(Boolean);
  const protectedVisualProtocol = visualProtocolBlocks[visualProtocolBlocks.length - 1] || "";
  const toolProtocolPattern = /(?:^|\n)\[TOOLS\]\n[\s\S]*?(?=\n\n\[[A-Z0-9 _():/.-]+\]\n|$)/g;
  const existingToolProtocolBlocks = [...instructions.matchAll(toolProtocolPattern)]
    .map((match) => String(match[0] || "").trim())
    .filter(Boolean);
  const existingToolProtocol = existingToolProtocolBlocks[existingToolProtocolBlocks.length - 1] || "";
  const compactableInstructions = instructions
    .replace(visualProtocolPattern, "")
    .replace(toolProtocolPattern, "");
  const lines = compactableInstructions.split(/\r?\n/);
  const keepPatterns = [
    /当前工作区|相对路径|workspace|工作区/i,
    /M Studio|Unity|游戏开发|教程|中文|Region|注释/i,
    /TURN INTENT|USER INTENT|执行|修复|实现|计划|报告/i,
    /AGENTS|WORKSPACE INSTRUCTIONS|rules|instructions/i,
  ];
  const compactReminder = options.aggressive
    ? [
        "[Cloud Gateway Compact Instructions]",
        "Answer using the compact transcript and ContextState only; keep output short to avoid gateway timeouts.",
        "Follow the retained [TOOLS] contract exactly. It is the sole source of truth for this request's protocol, names, and arguments.",
      ]
    : [
        "[Cloud Compact Instructions]",
        "Use concise responses and prefer small tool-driven steps to avoid cloud gateway timeouts.",
        "Follow the retained [TOOLS] contract exactly. Do not invent a protocol or capability that is absent from the current request.",
      ];
  const activeToolDefinitions = options.toolDefinitions || [];
  const activeToolNames = activeToolDefinitions.map((tool) => tool.function.name);
  const generatedToolProtocol = options.toolProtocol === "xml" && activeToolDefinitions.length === 0 && existingToolProtocol
    ? existingToolProtocol
    : options.toolProtocol === "none"
    ? [
        "[TOOLS]",
        "profile=cloud/openai-responses; protocol=none; available=none.",
        "No tools are attached to this compact fallback. Do not emit pseudo calls or claim that a tool ran.",
      ].join("\n")
    : options.toolProtocol
    ? buildToolProtocolCard({
        activeProfile: "cloud",
        provider: "openai-responses",
        toolProtocol: options.toolProtocol,
        nativeToolsEnabled: options.toolProtocol === "native",
        availableToolNames: activeToolNames,
        toolDefinitions: activeToolDefinitions,
        descriptionMaxChars: options.aggressive ? 0 : 120,
        language: "en",
      })
    : existingToolProtocol;

  if (!options.aggressive && instructions.length <= maxChars && options.toolProtocol) {
    const reconciled = existingToolProtocol
      ? instructions.replace(toolProtocolPattern, (match) => (
          match.startsWith("\n") ? `\n${generatedToolProtocol}` : generatedToolProtocol
        ))
      : `${instructions.trim()}\n\n${generatedToolProtocol}`;
    return reconciled.trim();
  }

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

  const protectedPrefix = [
    ...compactReminder,
    ...(generatedToolProtocol ? ["", generatedToolProtocol] : []),
    ...(protectedVisualProtocol ? ["", protectedVisualProtocol] : []),
  ].join("\n");
  const compactSuffix = [
    ...keptLines,
    `[Cloud compacted ${instructions.length} chars of system instructions to reduce 524 timeout risk.]`,
  ].join("\n");
  const suffixBudget = Math.max(0, maxChars - protectedPrefix.length - 2);
  if (suffixBudget === 0) return protectedPrefix;
  return `${protectedPrefix}\n\n${truncateTextForCloud(compactSuffix, suffixBudget)}`.trim();
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
  stream?: boolean;
}): Record<string, unknown> {
  const extras: Record<string, unknown> = {
    stream: options?.stream === true,
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
  compactionMode?: "standard" | "aggressive";
  includeTools?: boolean;
  toolProtocol?: CompactResponsesToolProtocol;
  contextMemoryState?: ContextMemoryState | null;
  targetInputTokens?: number;
}): OpenAiResponsesProbeRequestCandidate[] {
  const aggressive = options.compactionMode === "aggressive";
  const protocolMessages = options.compact
    ? compactCloudResponsesMessages(options.messages, {
        contextMemoryState: options.contextMemoryState,
        targetInputTokens: options.targetInputTokens,
        aggressive,
      })
    : options.messages;
  const rawInstructions = extractOpenAiResponsesInstructions(protocolMessages);
  const tools = options.includeTools === false ? [] : convertOpenAiToolsToResponses(options.tools);

  return buildOpenAiResponsesInputCandidates(protocolMessages).map((candidate) => {
    const candidateTools = candidate.mode !== "transcript_text" ? tools : [];
    const candidateToolProtocol: CompactResponsesToolProtocol = options.toolProtocol === "xml"
      ? "xml"
      : candidateTools.length > 0 && options.toolProtocol !== "none"
      ? "native"
      : "none";
    const instructions = options.compact
      ? compactCloudResponsesInstructions(rawInstructions, {
          aggressive,
          toolProtocol: candidateToolProtocol,
          toolDefinitions: options.tools,
        })
      : rawInstructions;
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
    includeUserPromptId?: boolean;
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
    ...(options.includeUserPromptId === false
      ? {}
      : typeof body.user_prompt_id === "string" && body.user_prompt_id.trim()
        ? {}
        : { user_prompt_id: options.userPromptId || OPENAI_CHATGPT_PROBE_USER_PROMPT_ID }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractResponseErrorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["message", "detail", "code"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * Resolve the terminal state carried by an OpenAI Responses JSON object or an
 * SSE terminal-event envelope. A missing status is intentionally `unknown` so
 * older OpenAI-compatible JSON gateways remain usable; an explicit failure or
 * incomplete response is never normalized to successful completion.
 */
export function resolveOpenAiResponsesTerminalState(payload: unknown): OpenAiResponsesTerminalState {
  const envelope = asRecord(payload);
  const nestedResponse = asRecord(envelope?.response);
  const response = nestedResponse || envelope;
  const rawStatus = String(response?.status ?? envelope?.status ?? "").trim().toLowerCase();
  const status: OpenAiResponsesTerminalStatus = rawStatus === "completed"
    ? "completed"
    : rawStatus === "failed" || rawStatus === "cancelled" || rawStatus === "canceled"
    ? "failed"
    : rawStatus === "incomplete"
    ? "incomplete"
    : rawStatus === "in_progress" || rawStatus === "queued"
    ? "in_progress"
    : "unknown";
  const incompleteDetails = asRecord(response?.incomplete_details ?? envelope?.incomplete_details);
  const rawIncompleteReason = incompleteDetails?.reason;
  const incompleteReason = typeof rawIncompleteReason === "string" && rawIncompleteReason.trim()
    ? rawIncompleteReason.trim()
    : null;
  const error = extractResponseErrorMessage(response?.error)
    || extractResponseErrorMessage(envelope?.error);
  return { status, error, incompleteReason };
}

function mergeOpenAiResponsesStreamText(deltaText: string, snapshotText: string): string {
  if (!deltaText) return snapshotText;
  if (!snapshotText) return deltaText;
  if (snapshotText === deltaText || snapshotText.startsWith(deltaText)) return snapshotText;
  if (deltaText.startsWith(snapshotText) || deltaText.endsWith(snapshotText)) return deltaText;
  return `${deltaText}${snapshotText}`;
}

/** Parse a complete Responses SSE body without discarding its terminal state. */
export function parseOpenAiResponsesSsePayload(streamText: string): Record<string, unknown> {
  const lines = String(streamText || "").split(/\r?\n/);
  let eventName = "";
  let deltaText = "";
  let snapshotText = "";
  let latestResponse: Record<string, unknown> | null = null;
  let terminalEnvelope: Record<string, unknown> | null = null;
  let terminalStatus: "completed" | "failed" | "incomplete" | null = null;

  const flushData = (rawData: string) => {
    const data = rawData.trim();
    if (!data || data === "[DONE]") return;
    try {
      const payload = asRecord(JSON.parse(data));
      if (!payload) return;
      const payloadType = typeof payload.type === "string" ? payload.type.trim() : "";
      const effectiveEvent = eventName || payloadType;
      const nestedResponse = asRecord(payload.response);
      if (nestedResponse) latestResponse = nestedResponse;

      const delta = payload.delta;
      if (typeof delta === "string" && effectiveEvent === "response.output_text.delta") {
        deltaText += delta;
      }

      if (effectiveEvent === "response.completed") terminalStatus = "completed";
      if (effectiveEvent === "response.failed" || effectiveEvent === "response.cancelled") terminalStatus = "failed";
      if (effectiveEvent === "response.incomplete") terminalStatus = "incomplete";
      if (terminalStatus && (
        effectiveEvent === "response.completed" ||
        effectiveEvent === "response.failed" ||
        effectiveEvent === "response.cancelled" ||
        effectiveEvent === "response.incomplete"
      )) {
        terminalEnvelope = payload;
        latestResponse = nestedResponse || payload;
      }

      const candidatePayload = nestedResponse || payload;
      const responseText = extractOpenAiResponseText(candidatePayload, "responses");
      const directText = typeof payload.text === "string"
        ? payload.text
        : typeof payload.output_text === "string"
        ? payload.output_text
        : "";
      const candidateSnapshot = responseText || directText;
      if (candidateSnapshot && effectiveEvent !== "response.output_text.delta") {
        snapshotText = candidateSnapshot;
      }
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

  const resolvedLatestState = resolveOpenAiResponsesTerminalState(latestResponse);
  if (!terminalStatus) {
    if (resolvedLatestState.status === "completed") terminalStatus = "completed";
    if (resolvedLatestState.status === "failed") terminalStatus = "failed";
    if (resolvedLatestState.status === "incomplete") terminalStatus = "incomplete";
  }

  const outputText = mergeOpenAiResponsesStreamText(deltaText, snapshotText);
  // Assignments made while flushing event blocks are opaque to TypeScript's
  // outer control-flow analysis, so capture their runtime types explicitly.
  const capturedResponse = latestResponse as Record<string, unknown> | null;
  const capturedTerminalEnvelope = terminalEnvelope as Record<string, unknown> | null;
  const result: Record<string, unknown> = capturedResponse ? { ...capturedResponse } : {};
  if (capturedTerminalEnvelope && result.error == null && capturedTerminalEnvelope.error != null) {
    result.error = capturedTerminalEnvelope.error;
  }
  if (capturedTerminalEnvelope && result.incomplete_details == null && capturedTerminalEnvelope.incomplete_details != null) {
    result.incomplete_details = capturedTerminalEnvelope.incomplete_details;
  }
  if (terminalStatus) {
    result.status = terminalStatus;
  } else {
    // Receiving EOF/[DONE] without a Responses terminal event is a transport
    // truncation, not successful completion. Preserve any partial text while
    // making the non-terminal state explicit to downstream orchestration.
    result.status = "incomplete";
    result.incomplete_details = { reason: "missing_terminal_event" };
  }
  if (outputText) result.output_text = outputText;
  return result;
}

export function parseOpenAiResponsesSseText(streamText: string): string {
  const payload = parseOpenAiResponsesSsePayload(streamText);
  const terminal = resolveOpenAiResponsesTerminalState(payload);
  if (terminal.status === "failed") {
    throw new Error(`OPENAI_RESPONSES_FAILED: ${terminal.error || "The response failed before completion."}`);
  }
  if (terminal.status === "incomplete" || terminal.status === "in_progress") {
    throw new Error(
      `OPENAI_RESPONSES_INCOMPLETE: ${terminal.incompleteReason || "The response ended without a completed terminal event."}`,
    );
  }
  return extractOpenAiResponseText(payload, "responses");
}

function mapGeminiRole(role: ProtocolChatMessage["role"]): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

type GeminiRequestContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

function mapGeminiContentParts(content: ProtocolChatMessage["content"]): GeminiRequestContentPart[] {
  if (typeof content === "string") return [{ text: content }];
  if (!hasImageContentPart(content)) return [{ text: extractTextContent(content) }];
  const parts: GeminiRequestContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ text: part.text });
      continue;
    }
    const image = parseBase64DataUrlImage(part.image_url.url);
    if (image) {
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }
  }
  return parts;
}

function geminiPartHasContent(part: GeminiRequestContentPart): boolean {
  if ("text" in part) return part.text.trim().length > 0;
  return true;
}

export function buildGeminiRequestBody(options: BuildGeminiRequestOptions): Record<string, unknown> {
  const systemInstruction = extractOpenAiResponsesInstructions(options.messages);
  const contents = options.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: mapGeminiRole(message.role),
      parts: mapGeminiContentParts(message.content),
    }))
    .filter((item) => item.parts.some(geminiPartHasContent));

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
  const effectiveEndpoint = endpoint.trim() || "https://generativelanguage.googleapis.com";
  const base = buildCloudMessagesApiUrl(effectiveEndpoint, "gemini");
  const cleanModel = model.replace(/^models\//, "").trim();
  const action = stream ? "streamGenerateContent" : "generateContent";
  return `${base}/models/${encodeURIComponent(cleanModel)}:${action}`;
}

export function buildGeminiRequestForAuthMode(
  endpoint: string,
  options: BuildGeminiRequestOptions,
  authMode?: CloudAuthMode,
): { url: string; body: Record<string, unknown>; responseMode: "native" | "code_assist" } {
  const isCodeAssist =
    normalizeCloudAuthMode(authMode) === "gemini_google_oauth" &&
    (Boolean(options.projectId) || (!options.model.startsWith("gemini-") && !options.model.startsWith("models/gemini-")));
  if (isCodeAssist) {
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
  let reasoningContent = "";
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
          fullContent += delta.text;
          onToken(delta.text);
          return;
        }

        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          reasoningContent += delta.thinking;
          return;
        }

        if (delta.type === "thinking_delta" && typeof delta.text === "string") {
          reasoningContent += delta.text;
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
        ...(reasoningContent.trim()
          ? { reasoningContent, reasoningField: "reasoning" as const }
          : {}),
      };
    },
  };
}
