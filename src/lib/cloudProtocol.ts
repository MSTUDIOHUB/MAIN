import {
  normalizeToolDefinitions,
  normalizeToolParametersSchema,
  type ToolDefinition,
} from "./toolSchemas";

export type CloudApiProtocol = "openai" | "anthropic";
export type OpenAiApiFormat = "chat_completions" | "responses";
export type OpenAiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

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

export interface AnthropicStreamProcessor {
  processChunk: (chunk: string) => void;
  flush: () => void;
  getResult: () => StreamResultLike;
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
  return protocol === "anthropic" ? "anthropic" : "openai";
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
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) headers["Content-Type"] = "application/json";

  if (protocol === "anthropic") {
    headers["anthropic-version"] = DEFAULT_ANTHROPIC_VERSION;
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
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
        return typeof candidate === "string" && candidate.trim() ? candidate : null;
      })
      .filter((id): id is string => typeof id === "string");
    if (extracted.length > 0) return Array.from(new Set(extracted));
  }

  return [];
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
      };
    },
  };
}
