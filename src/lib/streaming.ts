// lib/streaming.ts
// SSE-based streaming helper for OpenAI-compatible chat completions
// Supports native function calling via `tools` parameter.
//
// Enhanced with patterns from claude-code-haha:
//   - Multi-provider support (OpenAI-compatible + Ollama native)
//   - Max output tokens escalation (8k → 16k → 32k → 64k)
//   - Proper tool_call delta accumulation
//   - Context-length-exceeded error detection
// ─────────────────────────────────────────────────────────────────

import { normalizeToolDefinitions, type ToolDefinition } from "./toolSchemas";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  buildOpenAiResponsesRequestCandidates,
  buildAnthropicRequestBody,
  buildCloudHeaders,
  buildCloudMessagesApiUrl,
  buildGeminiRequestForAuthMode,
  createAnthropicStreamProcessor,
  ensureOpenAiChatGptCodexRequestBody,
  extractGeminiResponseText,
  extractOpenAiResponseText,
  finalizeStreamedToolCalls,
  normalizeCloudProtocol,
  normalizeCloudToolProtocol,
  resolveEffectiveCloudApiFormat,
  parseOpenAiResponsesSseText,
  type CloudApiProtocol,
  type CloudAuthMode,
  type CloudToolProtocol,
  type OpenAiApiFormat,
  type OpenAiReasoningEffort,
  type ProtocolChatMessage,
} from "./cloudProtocol";
import { computeContextBudgets } from "./contextTrim";
import { isRetryableCloudErrorMessage } from "./cloudRetry";
import { toError } from "./errorUtils";
import { isNativeToolCompatibilityErrorMessage, isProviderCompatibilityErrorMessage, PROVIDER_COMPATIBILITY_TAG } from "./providerCompatibility";

function emitStreamingConsole(
  source: "streaming" | "streamViaRustProxy",
  level: "info" | "warn",
  message: string,
  data?: unknown,
) {
  if (typeof window === "undefined") return;
  const writer = level === "warn" ? console.warn : console.log;
  if (data === undefined) {
    writer(`[${source}] ${message}`);
  } else {
    writer(`[${source}] ${message}`, data);
  }
}

/** Multimodal content parts (OpenAI-compatible). */
interface TextContentPart {
  type: "text";
  text: string;
}

interface ImageUrlContentPart {
  type: "image_url";
  image_url: { url: string };
}

type ContentPart = TextContentPart | ImageUrlContentPart;

/** Minimal message shape for the streaming layer (avoids circular import). */
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
}

/** Flat connection params derived from AppConfig.local or AppConfig.cloud */
export interface StreamSettings {
  baseUrl: string;      // e.g. "http://127.0.0.1:8080/v1"
  apiKey: string;       // e.g. "ollama" / actual key
  model: string;
  apiProtocol?: CloudApiProtocol;
  apiFormat?: OpenAiApiFormat;
  authMode?: CloudAuthMode;
  tokenRef?: string;
  customHeaders?: string;
  sendSamplingParameters?: boolean;
  temperature?: number;
  topP?: number;
  disableResponseStorage?: boolean;
  reasoningEffort?: OpenAiReasoningEffort;
  toolProtocol?: CloudToolProtocol;
  contextLimit?: number; // total context window for the model (used to calculate max_tokens)
  provider?: string;    // "Ollama" | "LM Studio" | "OMLX" | "OpenAI" — controls SSE format
  useRustProxy?: boolean; // Route through Rust backend to bypass WebView/CORS transport limits.
}

/** A tool call accumulated from streaming deltas. */
export interface StreamedToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;  // accumulated JSON string
}

/** Result of a completed stream — includes both text and any tool calls. */
export interface StreamResult {
  content: string;
  toolCalls: StreamedToolCall[];
  finishReason: "stop" | "length" | "tool_calls" | null;
  reasoningContent?: string;
  reasoningField?: "reasoning_content" | "reasoning";
}

const REASONING_ONLY_STREAM_GUARD_CHAR_LIMIT = 12_000;
const STREAM_NO_VISIBLE_PROGRESS_TIMEOUT_MS = 180_000;

export function isLocalProfile(settings: StreamSettings): boolean {
  if (settings.provider === "Ollama" || settings.provider === "LM Studio" || settings.provider === "OMLX") return true;
  const url = String(settings.baseUrl || "").toLowerCase();
  return url.includes("localhost") || url.includes("127.0.0.1") || url.includes("::1") || url.includes("ollama") || url.includes(":11434");
}

export function shouldStopReasoningOnlyStream(input: {
  reasoningChars: number;
  visibleChars: number;
  toolCallCount: number;
  settings?: StreamSettings;
}): boolean {
  const limit = input.settings && isLocalProfile(input.settings)
    ? 96_000
    : REASONING_ONLY_STREAM_GUARD_CHAR_LIMIT;
  return (
    input.reasoningChars >= limit &&
    input.visibleChars === 0 &&
    input.toolCallCount === 0
  );
}

export function shouldStopNoVisibleStreamStall(input: {
  elapsedMs: number;
  visibleChars: number;
  toolCallCount: number;
  reasoningChars?: number;
}): boolean {
  if (input.reasoningChars && input.reasoningChars > 0) {
    return false;
  }
  return (
    input.elapsedMs >= STREAM_NO_VISIBLE_PROGRESS_TIMEOUT_MS &&
    input.visibleChars === 0 &&
    input.toolCallCount === 0
  );
}

interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: (result: StreamResult) => void;
  onError: (err: Error) => void;
  onLifecycle?: (event: {
    phase: "stream_started" | "first_chunk" | "chunk_progress" | "no_chunk_progress_warning" | "stream_done" | "stream_error" | "stream_cancelled";
    streamId?: string;
    elapsedMs?: number;
    chunkCount?: number;
    byteCount?: number;
    status?: string;
    error?: string;
  }) => void;
}

// ── Max Output Tokens Escalation ────────────────────────────────────
// From claude-code-haha: when the model hits max_tokens (finish_reason: "length"),
// we can retry with a higher limit. Escalation ladder: 4k → 8k → 16k → 32k → 64k.

const MAX_TOKENS_LADDER = [4096, 8192, 16384, 32768, 65536];

/**
 * Determine the initial max_tokens based on context limit.
 * Reuses the same output budget as the context compactor so input/output
 * budgets stay aligned for local models.
 */
export function computeInitialMaxTokens(contextLimit?: number): number {
  if (!contextLimit) return 4096;
  return computeContextBudgets(contextLimit).outputBudget;
}

function computeMaxTokensCeiling(contextLimit?: number): number {
  if (!contextLimit) return 65536;
  return Math.max(
    computeInitialMaxTokens(contextLimit),
    Math.min(16384, Math.floor(contextLimit * 0.35)),
  );
}

/**
 * Get the next escalation level for max_tokens.
 * Returns null if already at maximum.
 */
export function escalateMaxTokens(currentMaxTokens: number, contextLimit?: number): number | null {
  const ceiling = computeMaxTokensCeiling(contextLimit);
  for (const level of MAX_TOKENS_LADDER) {
    if (level > currentMaxTokens && level <= ceiling) return level;
  }
  return null; // Already at maximum
}

// ── Multimodal Content Helpers ───────────────────────────────────────

/** Extract text from content (string or multimodal array). */
function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextContentPart => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function hasImageContent(content: string | ContentPart[]): boolean {
  return Array.isArray(content) && content.some((part) => part.type === "image_url");
}

/**
 * 提取 OpenAI 兼容接口里可能出现的文本字段。
 * LM Studio / MLX 的部分 Qwen thinking 模型会返回非标准字段，
 * 比如 reasoning，而不是 reasoning_content。
 */
function extractTextLike(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const item = part as { text?: unknown; content?: unknown };
      return typeof item.text === "string"
        ? item.text
        : typeof item.content === "string"
          ? item.content
          : "";
    })
    .join("");
}

type OpenAiCompatibleContentMode = "delta" | "cumulative" | "none";
type OpenAiCompatibleReasoningField = "reasoning_content" | "reasoning" | "thinking" | "thought";

function extractFirstTextField(
  source: Record<string, unknown> | undefined,
  fields: OpenAiCompatibleReasoningField[],
): { text: string; field: OpenAiCompatibleReasoningField | null } {
  if (!source) return { text: "", field: null };
  for (const field of fields) {
    const text = extractTextLike(source[field]);
    if (text) return { text, field };
  }
  return { text: "", field: null };
}

function normalizeReasoningFieldForHistory(
  field: OpenAiCompatibleReasoningField | null,
): "reasoning_content" | "reasoning" | null {
  if (field === "reasoning_content" || field === "reasoning") return field;
  return null;
}

function extractOpenAiCompatibleDelta(payload: unknown): {
  content: string;
  contentMode: OpenAiCompatibleContentMode;
  reasoning: string;
  reasoningMode: OpenAiCompatibleContentMode;
  reasoningField: "reasoning_content" | "reasoning" | null;
  finishReason: "stop" | "length" | "tool_calls" | null;
  toolCalls: unknown[];
} {
  if (!payload || typeof payload !== "object") {
    return { content: "", contentMode: "none", reasoning: "", reasoningMode: "none", reasoningField: null, finishReason: null, toolCalls: [] };
  }

  const root = payload as Record<string, unknown>;
  const choice = Array.isArray(root.choices) ? root.choices[0] as Record<string, unknown> | undefined : undefined;
  const delta = choice?.delta && typeof choice.delta === "object"
    ? choice.delta as Record<string, unknown>
    : undefined;
  const message = choice?.message && typeof choice.message === "object"
    ? choice.message as Record<string, unknown>
    : undefined;
  const source = delta ?? message ?? root;
  const deltaContent = extractTextLike(delta?.content ?? delta?.text);
  const messageContent = extractTextLike(message?.content ?? message?.text);
  const rootContent = extractTextLike(root.content ?? root.text ?? root.response);
  const content = deltaContent || messageContent || rootContent;
  const reasoningFields: OpenAiCompatibleReasoningField[] = ["reasoning_content", "reasoning", "thinking", "thought"];
  const deltaReasoning = extractFirstTextField(delta, reasoningFields);
  const messageReasoning = extractFirstTextField(message, reasoningFields);
  const rootReasoning = extractFirstTextField(root, reasoningFields);
  const reasoning = deltaReasoning.text || messageReasoning.text || rootReasoning.text;
  const rawReasoningField = deltaReasoning.text
    ? deltaReasoning.field
    : messageReasoning.text
      ? messageReasoning.field
      : rootReasoning.field;
  const rawFinishReason = choice?.finish_reason ?? root.done_reason;
  const normalizedFinishReason = rawFinishReason === "length" || rawFinishReason === "tool_calls" || rawFinishReason === "stop"
    ? rawFinishReason
    : root.done === true
      ? "stop"
      : null;

  return {
    content,
    contentMode: deltaContent ? "delta" : content ? "cumulative" : "none",
    reasoning,
    reasoningMode: deltaReasoning.text ? "delta" : reasoning ? "cumulative" : "none",
    reasoningField: normalizeReasoningFieldForHistory(rawReasoningField),
    finishReason: normalizedFinishReason,
    toolCalls: Array.isArray(source.tool_calls) ? source.tool_calls : [],
  };
}

function resolveOpenAiCompatibleDeltaText(
  content: string,
  contentMode: OpenAiCompatibleContentMode,
  emittedText: string,
): { delta: string; emittedText: string } {
  if (!content) return { delta: "", emittedText };
  if (contentMode !== "cumulative") {
    return { delta: content, emittedText: emittedText + content };
  }
  if (content === emittedText) return { delta: "", emittedText };
  if (content.startsWith(emittedText)) {
    return { delta: content.slice(emittedText.length), emittedText: content };
  }
  return { delta: content, emittedText: emittedText + content };
}

function resolveOpenAiCompatibleTextDelta(
  extracted: ReturnType<typeof extractOpenAiCompatibleDelta>,
  emittedText: string,
): { delta: string; emittedText: string } {
  return resolveOpenAiCompatibleDeltaText(extracted.content, extracted.contentMode, emittedText);
}

function resolveOpenAiCompatibleReasoningDelta(
  extracted: ReturnType<typeof extractOpenAiCompatibleDelta>,
  emittedReasoning: string,
): { delta: string; emittedText: string } {
  return resolveOpenAiCompatibleDeltaText(extracted.reasoning, extracted.reasoningMode, emittedReasoning);
}

/** Extract base64 images from multimodal content array (without data URL prefix). */
function extractBase64Images(content: string | ContentPart[]): string[] {
  if (typeof content === "string") return [];
  return content
    .filter((p): p is ImageUrlContentPart => p.type === "image_url")
    .map((p) => {
      const url = p.image_url.url;
      // Strip data:image/xxx;base64, prefix for Ollama
      const base64Match = url.match(/^data:image\/[^;]+;base64,(.+)$/);
      return base64Match ? base64Match[1] : url;
    });
}

function messageReasoningForApi(m: ChatMessage): Record<string, string> {
  if (m.role !== "assistant") return {};
  const reasoningContent = typeof m.reasoning_content === "string" ? m.reasoning_content.trim() : "";
  if (reasoningContent) return { reasoning_content: reasoningContent };
  const reasoning = typeof m.reasoning === "string" ? m.reasoning.trim() : "";
  return reasoning ? { reasoning } : {};
}

/** Map a ChatMessage to the provider-specific format for the API request body. */
function mapMessageForApi(
  m: ChatMessage,
  isOllama: boolean,
  options: { includeAssistantReasoning?: boolean } = {},
): Record<string, unknown> {
  const isMultimodal = Array.isArray(m.content);
  const assistantReasoning = options.includeAssistantReasoning ? messageReasoningForApi(m) : {};

  if (m.role === "tool") {
    return { role: "tool", content: extractTextContent(m.content), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) };
  }

  if (m.role === "assistant" && m.tool_calls) {
    return {
      role: "assistant",
      content: extractTextContent(m.content) || "",
      ...assistantReasoning,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id, type: tc.type,
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {}),
        },
      })),
    };
  }

  // User / system messages — handle multimodal
  if (isOllama && isMultimodal) {
    // Ollama format: { role, content: "text", images: ["base64", ...] }
    const images = extractBase64Images(m.content);
    return {
      role: m.role,
      content: extractTextContent(m.content),
      ...(images.length > 0 ? { images } : {}),
    };
  }

  if (isMultimodal && !hasImageContent(m.content)) {
    return { role: m.role, content: extractTextContent(m.content), ...assistantReasoning };
  }

  // OpenAI-compatible: pass content as-is (string or multimodal array)
  return { role: m.role, content: typeof m.content === "string" ? m.content : m.content, ...assistantReasoning };
}

function buildOllamaOptions(settings: StreamSettings, maxTokens: number): Record<string, unknown> {
  return {
    num_predict: maxTokens,
    ...(settings.contextLimit ? { num_ctx: settings.contextLimit } : {}),
  };
}

// ── Provider Detection ──────────────────────────────────────────────

function isOllamaProvider(settings: StreamSettings): boolean {
  if (settings.provider === "Ollama") return true;
  // Fallback: detect from URL
  const url = settings.baseUrl.toLowerCase();
  return url.includes("ollama") || url.includes(":11434");
}

function isAnthropicProvider(settings: StreamSettings): boolean {
  return normalizeCloudProtocol(settings.apiProtocol) === "anthropic";
}

function isGeminiProvider(settings: StreamSettings): boolean {
  return normalizeCloudProtocol(settings.apiProtocol) === "gemini";
}

function isOpenAiResponsesApi(settings: StreamSettings): boolean {
  return !isAnthropicProvider(settings) && !isGeminiProvider(settings) && resolveEffectiveCloudApiFormat({
    protocol: settings.apiProtocol,
    apiFormat: settings.apiFormat,
    authMode: settings.authMode,
  }) === "responses";
}

function shouldSendNativeTools(settings: StreamSettings): boolean {
  return normalizeCloudToolProtocol(settings.toolProtocol) !== "xml";
}

function isTranscriptCompatibilityRequest(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    typeof message.content === "string"
    && message.content.includes(PROVIDER_COMPATIBILITY_TAG)
    && message.content.includes("transcript_mode=true"),
  );
}

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function buildHttpErrorMessage(status: number, statusText: string, errorBody: string): string {
  const detail = String(errorBody || statusText || "").trim().slice(0, 500);
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}: Request failed`;
}

function isRecoverableRustStreamReadError(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("流读取错误") ||
    normalized.includes("error decoding response body") ||
    normalized.includes("error reading a body from connection") ||
    normalized.includes("error reading response body") ||
    normalized.includes("connection closed before message completed") ||
    normalized.includes("unexpected eof")
  );
}

function shouldRetryRustStreamAsNonStreaming(settings: StreamSettings, errorMessage: string): boolean {
  return (
    settings.useRustProxy === true &&
    !settings.apiProtocol &&
    !isOllamaProvider(settings) &&
    !isAnthropicProvider(settings) &&
    !isOpenAiResponsesApi(settings) &&
    isRecoverableRustStreamReadError(errorMessage)
  );
}

function isRecoverableFrontendTransportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("load failed") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("network request failed")
  );
}

function extractOpenAiChatCompletionToolCalls(payload: unknown): StreamedToolCall[] {
  if (!payload || typeof payload !== "object") return [];
  const choices = (payload as { choices?: unknown }).choices;
  const choice = Array.isArray(choices) ? choices[0] as { message?: unknown } | undefined : undefined;
  const message = choice?.message && typeof choice.message === "object"
    ? choice.message as { tool_calls?: unknown }
    : undefined;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

  return toolCalls.map((toolCall, index) => {
    const call = toolCall && typeof toolCall === "object"
      ? toolCall as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
      : {};
    const rawArguments = call.function?.arguments;
    return {
      index,
      id: typeof call.id === "string" && call.id.trim() ? call.id : `nonstream_call_${index + 1}`,
      name: typeof call.function?.name === "string" && call.function.name.trim()
        ? call.function.name
        : `unknown_tool_${index + 1}`,
      arguments: typeof rawArguments === "string"
        ? rawArguments
        : JSON.stringify(rawArguments ?? {}),
    };
  });
}

function extractOpenAiResponsesToolCalls(payload: unknown): StreamedToolCall[] {
  const calls: StreamedToolCall[] = [];
  const visited = new Set<unknown>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const item = value as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const rawArguments = item.arguments ?? item.input;
    const looksLikeFunctionCall =
      type === "function_call" ||
      type === "tool_call" ||
      (name && Object.prototype.hasOwnProperty.call(item, "arguments"));

    if (looksLikeFunctionCall && name) {
      const index = calls.length;
      const callId =
        typeof item.call_id === "string" && item.call_id.trim()
          ? item.call_id
          : typeof item.id === "string" && item.id.trim()
          ? item.id
          : `responses_call_${index + 1}`;
      calls.push({
        index,
        id: callId,
        name,
        arguments: typeof rawArguments === "string"
          ? rawArguments
          : JSON.stringify(rawArguments ?? {}),
      });
      return;
    }

    Object.values(item).forEach(visit);
  };

  visit(payload);
  return calls;
}

function extractOpenAiChatCompletionFinishReason(payload: unknown): StreamResult["finishReason"] {
  if (!payload || typeof payload !== "object") return "stop";
  const choices = (payload as { choices?: unknown }).choices;
  const choice = Array.isArray(choices) ? choices[0] as { finish_reason?: unknown } | undefined : undefined;
  const raw = choice?.finish_reason;
  if (raw === "length" || raw === "tool_calls" || raw === "stop") return raw;
  if (raw === "function_call") return "tool_calls";
  return "stop";
}

function extractOpenAiChatCompletionReasoning(payload: unknown): Pick<StreamResult, "reasoningContent" | "reasoningField"> {
  if (!payload || typeof payload !== "object") return {};
  const choices = (payload as { choices?: unknown }).choices;
  const choice = Array.isArray(choices) ? choices[0] as { message?: unknown } | undefined : undefined;
  const message = choice?.message && typeof choice.message === "object"
    ? choice.message as Record<string, unknown>
    : undefined;
  const reasoningContent = extractTextLike(message?.reasoning_content);
  if (reasoningContent) {
    return { reasoningContent, reasoningField: "reasoning_content" };
  }
  const reasoning = extractTextLike(message?.reasoning);
  return reasoning ? { reasoningContent: reasoning, reasoningField: "reasoning" } : {};
}

function buildGeminiRuntimeRequest(
  settings: StreamSettings,
  messages: ChatMessage[],
  maxTokens: number,
): { url: string; body: Record<string, unknown> } {
  const request = buildGeminiRequestForAuthMode(settings.baseUrl, {
    messages: messages as ProtocolChatMessage[],
    model: settings.model,
    maxTokens,
    stream: false,
  }, settings.authMode);
  return { url: request.url, body: request.body };
}

async function postJsonRequest(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  settings: StreamSettings,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw createAbortError();

    if (settings.useRustProxy) {
      let result: string;
    const cancelProxyRequest = () => {
      invoke("cancel_proxy_request").catch(() => {});
    };
    if (signal?.aborted) {
      cancelProxyRequest();
      throw createAbortError();
    }
    signal?.addEventListener("abort", cancelProxyRequest, { once: true });
    try {
      result = await invoke<string>("proxy_request", {
        url,
        method: "POST",
        headers,
        body: JSON.stringify(body),
        authMode: settings.authMode,
        tokenRef: settings.tokenRef,
      });
    } catch (err) {
      if (signal?.aborted) throw createAbortError();
      throw toError(err, "Cloud request failed.");
    } finally {
      signal?.removeEventListener("abort", cancelProxyRequest);
    }
    if (signal?.aborted) throw createAbortError();
    const contentType = (result.match(/^__CONTENT_TYPE__:(.*)\n/) || [])[1]?.trim() || "";
    if (contentType.includes("text/event-stream")) {
      return { output_text: parseOpenAiResponsesSseText(result.replace(/^__CONTENT_TYPE__:.*\n/, "")) };
    }
    return JSON.parse(result);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch {
      // Ignore body-read failures and fall back to status text.
    }
    throw new Error(buildHttpErrorMessage(response.status, response.statusText, errorBody));
  }

  return response.json();
}

async function requestOpenAiNonStreaming(
  messages: ChatMessage[],
  settings: StreamSettings,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  maxTokensOverride?: number,
  tools?: ToolDefinition[],
): Promise<StreamResult> {
  const { onToken, onDone, onError } = callbacks;

  try {
    const maxTokens = maxTokensOverride ?? computeInitialMaxTokens(settings.contextLimit);
    const isGemini = isGeminiProvider(settings);
    const apiFormat = resolveEffectiveCloudApiFormat({
      protocol: settings.apiProtocol,
      apiFormat: settings.apiFormat,
      authMode: settings.authMode,
    });
    const geminiRequest = isGemini ? buildGeminiRuntimeRequest(settings, messages, maxTokens) : null;
    const apiUrl = geminiRequest?.url ?? buildApiUrl(settings);
    const headers = isGemini
      ? buildCloudHeaders("gemini", settings.apiKey, true, settings.customHeaders, settings.authMode)
      : buildCloudHeaders("openai", settings.apiKey, true, settings.customHeaders, settings.authMode);
    const minimalCompatibilityMode = isTranscriptCompatibilityRequest(messages);
    let payload: unknown;

    if (isGemini) {
      payload = await postJsonRequest(
        apiUrl,
        headers,
        geminiRequest?.body ?? {},
        settings,
        signal,
      );
    } else if (apiFormat === "responses") {
      const shouldIncludeTools = !minimalCompatibilityMode && shouldSendNativeTools(settings);
      const requestCandidates = buildOpenAiResponsesRequestCandidates({
        messages: messages as ProtocolChatMessage[],
        model: settings.model,
        tools,
        disableResponseStorage: settings.disableResponseStorage,
        reasoningEffort: settings.reasoningEffort,
        compact: true,
        includeTools: shouldIncludeTools,
        targetInputTokens: settings.contextLimit
          ? computeContextBudgets(settings.contextLimit, maxTokens).inputBudget
          : undefined,
      });
      const responseTools = shouldIncludeTools && tools && tools.length > 0
        ? tools
        : [];
      let lastCompatibilityError: Error | null = null;
      let sawRetryableGatewayError = false;
      let gatewayCompactCandidates: ReturnType<typeof buildOpenAiResponsesRequestCandidates> | null = null;
      let gatewayCompactTranscriptCandidate: (typeof requestCandidates)[number] | null = null;
      let sawEmptyResponseCandidate = false;
      let lastEmptyResponseMode: string | null = null;

      for (let candidateIndex = 0; candidateIndex < requestCandidates.length; candidateIndex += 1) {
        const candidate = requestCandidates[candidateIndex];
        if (signal?.aborted) throw createAbortError();
        if (sawRetryableGatewayError && candidate.mode === "input_text_array") {
          continue;
        }
        try {
          const input = candidate.body.input;
          const instructions = candidate.body.instructions;
          const candidateTools = Array.isArray(candidate.body.tools) ? candidate.body.tools : [];
          emitStreamingConsole("streaming", "info", "OpenAI responses request", {
            url: apiUrl,
            model: settings.model,
            mode: candidate.mode,
            inputType: Array.isArray(input) ? "array" : typeof input,
            inputLen: Array.isArray(input) ? input.length : String(input ?? "").length,
            instructionsLen: typeof instructions === "string" ? instructions.length : 0,
            reasoningEffort: settings.reasoningEffort ?? "none",
            nativeTools: candidateTools.length,
          });
          const candidatePayload = await postJsonRequest(
            apiUrl,
            headers,
            settings.authMode === "openai_chatgpt_oauth"
              ? ensureOpenAiChatGptCodexRequestBody(candidate.body)
              : candidate.body,
            settings,
            signal,
          );
          const candidateContent = extractOpenAiResponseText(candidatePayload, "responses");
          const candidateToolCalls = extractOpenAiResponsesToolCalls(candidatePayload);
          if (!candidateContent && candidateToolCalls.length === 0) {
            sawEmptyResponseCandidate = true;
            lastEmptyResponseMode = candidate.mode;
            emitStreamingConsole("streaming", "warn", `OpenAI responses empty output for ${candidate.mode}; trying next compatibility candidate`);
            lastCompatibilityError = new Error(`responses_empty_candidate:${candidate.mode}`);
            continue;
          }
          payload = candidatePayload;
          if (candidate.mode !== "message_text") {
            emitStreamingConsole("streaming", "info", `OpenAI responses fallback succeeded with ${candidate.mode}`);
          }
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          lastCompatibilityError = err instanceof Error ? err : new Error(errMsg);
          if (responseTools.length > 0 && candidate.mode !== "transcript_text" && isNativeToolCompatibilityErrorMessage(errMsg)) {
            throw lastCompatibilityError;
          }
          const isRetryableGatewayError = isRetryableCloudErrorMessage(errMsg);
          if (isRetryableGatewayError) {
            if (gatewayCompactTranscriptCandidate && candidate === gatewayCompactTranscriptCandidate) {
              throw lastCompatibilityError;
            }
            sawRetryableGatewayError = true;
            if (!gatewayCompactCandidates) {
              gatewayCompactCandidates = buildOpenAiResponsesRequestCandidates({
                messages: messages as ProtocolChatMessage[],
                model: settings.model,
                disableResponseStorage: settings.disableResponseStorage,
                reasoningEffort: "none",
                compact: true,
                compactionMode: "aggressive",
                includeTools: false,
                targetInputTokens: settings.contextLimit
                  ? Math.min(6000, computeContextBudgets(settings.contextLimit, maxTokens).inputBudget)
                  : 6000,
              });
              const compactTranscriptCandidate = gatewayCompactCandidates.find((item) => item.mode === "transcript_text");
              if (compactTranscriptCandidate) {
                gatewayCompactTranscriptCandidate = compactTranscriptCandidate;
                requestCandidates.splice(candidateIndex + 1, 0, compactTranscriptCandidate);
              }
              emitStreamingConsole(
                "streaming",
                "warn",
                `OpenAI responses retryable gateway failure with ${candidate.mode}; retrying with aggressive compact transcript input`,
                errMsg,
              );
            }
            continue;
          }
          if (!isProviderCompatibilityErrorMessage(errMsg)) {
            throw lastCompatibilityError;
          }
        }
        if (payload != null) break;
      }

      if (payload == null) {
        if (sawEmptyResponseCandidate) {
          const emptyModeSuffix = lastEmptyResponseMode ? ` mode=${lastEmptyResponseMode}` : "";
          throw new Error(
            `${PROVIDER_COMPATIBILITY_TAG} unsupported responses empty_body responses_empty_after_fallbacks${emptyModeSuffix}`,
          );
        }
        throw lastCompatibilityError ?? new Error("Responses request failed without a compatibility fallback result.");
      }
    } else {
      payload = await postJsonRequest(
        apiUrl,
        headers,
        {
          model: settings.model,
          messages: messages.map((message) => ({
            role: message.role === "tool" ? "user" : message.role,
            content: extractTextContent(message.content),
          })),
          stream: false,
          ...(!minimalCompatibilityMode && tools && tools.length > 0 ? { tools: normalizeToolDefinitions(tools) } : {}),
          ...(!minimalCompatibilityMode ? { max_tokens: maxTokens } : {}),
          ...(!minimalCompatibilityMode && settings.sendSamplingParameters === true && settings.temperature != null ? { temperature: settings.temperature } : {}),
          ...(!minimalCompatibilityMode && settings.sendSamplingParameters === true && settings.topP != null ? { top_p: settings.topP } : {}),
        },
        settings,
        signal,
      );
    }

    const content = isGemini ? extractGeminiResponseText(payload) : extractOpenAiResponseText(payload, apiFormat);
    const toolCalls = isGemini
      ? []
      : apiFormat === "chat_completions"
      ? extractOpenAiChatCompletionToolCalls(payload)
      : extractOpenAiResponsesToolCalls(payload);
    const reasoning = !isGemini && apiFormat === "chat_completions"
      ? extractOpenAiChatCompletionReasoning(payload)
      : {};
    const result: StreamResult = {
      content,
      toolCalls,
      finishReason: toolCalls.length > 0
        ? "tool_calls"
        : apiFormat === "chat_completions"
          ? extractOpenAiChatCompletionFinishReason(payload)
          : "stop",
      ...reasoning,
    };

    if (content) onToken(content);
    onDone(result);
    return result;
  } catch (err) {
    const normalizedError = toError(err, "LLM request failed.");
    onError(normalizedError);
    throw normalizedError;
  }
}

/**
 * Determine the API endpoint URL based on provider.
 * - Ollama: uses /api/chat (native format)
 * - Others: uses /v1/chat/completions (OpenAI-compatible)
 */
function buildApiUrl(settings: StreamSettings): string {
  const base = settings.baseUrl.replace(/\/+$/, "");

  if (isOllamaProvider(settings)) {
    // Ollama native API
    if (base.endsWith("/v1")) {
      return `${base.slice(0, -3)}/api/chat`;
    }
    if (base.includes("/api/chat")) return base;
    return `${base}/api/chat`;
  }

  return buildCloudMessagesApiUrl(
    base,
    isAnthropicProvider(settings) ? "anthropic" : isGeminiProvider(settings) ? "gemini" : "openai",
    resolveEffectiveCloudApiFormat({
      protocol: settings.apiProtocol,
      apiFormat: settings.apiFormat,
      authMode: settings.authMode,
    }),
  );
}

// ── Rust SSE Proxy (bypasses CORS for cloud endpoints) ────────────────
// When useRustProxy is true, the POST request is made from Rust.
// Chunks arrive as Tauri events and are parsed using the same SSE logic.

async function streamViaRustProxy(
  messages: ChatMessage[],
  settings: StreamSettings,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  tools?: ToolDefinition[],
  maxTokensOverride?: number,
): Promise<StreamResult> {
  const { onToken, onDone, onError } = callbacks;
  const isOllama = isOllamaProvider(settings);
  const isAnthropic = isAnthropicProvider(settings);
  const isGemini = isGeminiProvider(settings);
  const maxTokens = maxTokensOverride ?? computeInitialMaxTokens(settings.contextLimit);

  // Build the request body (same logic as streamChatCompletion)
  const geminiRequest = isGemini ? buildGeminiRuntimeRequest(settings, messages, maxTokens) : null;
  const body: Record<string, unknown> = isOllama
    ? {
        model: settings.model,
        messages: messages.map((m) => mapMessageForApi(m, true)),
        stream: true,
        options: buildOllamaOptions(settings, maxTokens),
      }
    : isAnthropic
      ? buildAnthropicRequestBody({
          messages: messages as ProtocolChatMessage[],
          model: settings.model,
          maxTokens,
          stream: true,
          tools,
        })
      : isGemini
        ? geminiRequest?.body ?? {}
      : {
          model: settings.model,
          messages: messages.map((m) => mapMessageForApi(m, false)),
          stream: true,
          max_tokens: maxTokens,
          ...(settings.sendSamplingParameters === true && settings.temperature != null ? { temperature: settings.temperature } : {}),
          ...(settings.sendSamplingParameters === true && settings.topP != null ? { top_p: settings.topP } : {}),
        };

  if (tools && tools.length > 0 && !isOllama && !isAnthropic && !isGemini && shouldSendNativeTools(settings)) {
    body.tools = normalizeToolDefinitions(tools);
  }

  const apiUrl = geminiRequest?.url ?? buildApiUrl(settings);
  const protocol: CloudApiProtocol = isAnthropic ? "anthropic" : isGemini ? "gemini" : "openai";
  const headers: Record<string, string> = isOllama
    ? { "Content-Type": "application/json" }
    : buildCloudHeaders(protocol, settings.apiKey, true, settings.customHeaders, settings.authMode);

  if (isGemini) {
    try {
      const payload = await postJsonRequest(apiUrl, headers, body, settings, signal);
      const content = extractGeminiResponseText(payload);
      if (content) onToken(content);
      const result: StreamResult = { content, toolCalls: [], finishReason: "stop" };
      onDone(result);
      return result;
    } catch (err) {
      const normalizedError = toError(err, "Gemini request failed.");
      onError(normalizedError);
      throw normalizedError;
    }
  }

  // Generate a unique stream ID
  const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const streamStartedAt = Date.now();
  let rustProxyChunkCount = 0;
  let rustProxyByteCount = 0;
  let lastChunkAt = streamStartedAt;
  let lastProgressLifecycleAt = 0;
  let lastNoProgressWarningAt = 0;
  const STREAM_PROGRESS_LIFECYCLE_INTERVAL_MS = 15_000;
  const STREAM_NO_PROGRESS_WARNING_MS = 45_000;
  callbacks.onLifecycle?.({
    phase: "stream_started",
    streamId,
    elapsedMs: 0,
    chunkCount: 0,
    byteCount: 0,
    status: "started",
  });

  // ── Deferred pattern: resolve/reject from outside the Promise ─────
  let resolveResult: ((result: StreamResult) => void) | null = null;
  let rejectResult: ((err: Error) => void) | null = null;
  const resultPromise = new Promise<StreamResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const anthropicProcessor = isAnthropic ? createAnthropicStreamProcessor(onToken) : null;

  // Accumulate results
  let fullContent = "";
  let emittedOpenAiCompatibleText = "";
  let emittedOpenAiCompatibleReasoning = "";
  let providerReasoningContent = "";
  let providerReasoningField: StreamResult["reasoningField"] | null = null;
  let visibleContentChars = 0;
  let finishReason: "stop" | "length" | "tool_calls" | null = null;
  const toolCallsMap = new Map<number, StreamedToolCall>();

  let unlistenChunk: UnlistenFn | null = null;
  let unlistenDone: UnlistenFn | null = null;
  let noProgressInterval: ReturnType<typeof setInterval> | null = null;
  let resolved = false;

  // Buffer for partial SSE lines
  let sseBuffer = "";

  // Track reasoning phase for thinking models (e.g., Qwen3.5 with reasoning_content)
  let reasoningActive = false;
  // Some llama.cpp servers cannot properly decode thinking tokens and emit
  // a single "?" per token instead of real text.  We buffer reasoning tokens
  // until we can verify the content is legitimate.  If it's all "?" we
  // silently discard it so the user doesn't see a wall of "?????".
  let reasoningBuffer = "";
  let reasoningEmitted = false;
  let reasoningGarbled = false;

  /** Check whether a string consists entirely of '?' (garbled reasoning) */
  const isGarbled = (s: string) => /^[?]+$/.test(s);

  const openReasoningBlock = () => {
    if (reasoningActive) return;
    reasoningActive = true;
  };

  const closeReasoningBlock = () => {
    if (!reasoningActive) return;
    reasoningActive = false;
  };

  const buildCurrentOpenAiCompatibleResult = (): StreamResult => ({
    content: fullContent,
    toolCalls: finalizeStreamedToolCalls(toolCallsMap),
    finishReason,
    ...(providerReasoningContent.trim()
      ? {
          reasoningContent: providerReasoningContent,
          ...(providerReasoningField ? { reasoningField: providerReasoningField } : {}),
        }
      : {}),
  });

  const stopReasoningOnlyRunaway = () => {
    if (resolved || anthropicProcessor) return false;
    if (!shouldStopReasoningOnlyStream({
      reasoningChars: providerReasoningContent.length,
      visibleChars: visibleContentChars,
      toolCallCount: toolCallsMap.size,
      settings,
    })) {
      return false;
    }

    resolved = true;
    finishReason = "length";
    closeReasoningBlock();
    reasoningBuffer = "";
    const dynamicLimit = isLocalProfile(settings) ? 96_000 : REASONING_ONLY_STREAM_GUARD_CHAR_LIMIT;
    emitStreamingConsole(
      "streaming",
      "warn",
      `Reasoning-only stream exceeded ${dynamicLimit} chars without visible output or tool calls; cancelling stream.`,
    );
    callbacks.onLifecycle?.({
      phase: "stream_cancelled",
      streamId,
      elapsedMs: Date.now() - streamStartedAt,
      chunkCount: rustProxyChunkCount,
      byteCount: rustProxyByteCount,
      status: "reasoning_guard",
    });
    invoke("cancel_chat_stream").catch(() => {});
    const result = buildCurrentOpenAiCompatibleResult();
    onDone(result);
    resolveResult?.(result);
    cleanup();
    return true;
  };

  const stopNoVisibleProgressStall = () => {
    if (resolved || anthropicProcessor) return false;
    const elapsedMs = Date.now() - streamStartedAt;
    if (!shouldStopNoVisibleStreamStall({
      elapsedMs,
      visibleChars: visibleContentChars,
      toolCallCount: toolCallsMap.size,
      reasoningChars: providerReasoningContent.length,
    })) {
      return false;
    }

    resolved = true;
    finishReason = "length";
    closeReasoningBlock();
    reasoningBuffer = "";
    const message = `STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream produced chunks for ${elapsedMs}ms without visible output or tool calls.`;
    emitStreamingConsole(
      "streaming",
      "warn",
      "Stream produced chunks but no visible content or tool calls; cancelling.",
      { elapsedMs, chunkCount: rustProxyChunkCount, byteCount: rustProxyByteCount },
    );
    callbacks.onLifecycle?.({
      phase: "stream_error",
      streamId,
      elapsedMs,
      chunkCount: rustProxyChunkCount,
      byteCount: rustProxyByteCount,
      status: "no_visible_progress_timeout",
      error: message,
    });
    invoke("cancel_chat_stream").catch(() => {});
    const error = new Error(message);
    onError(error);
    rejectResult?.(error);
    cleanup();
    return true;
  };

  const processSseChunk = (rawChunk: string) => {
    if (anthropicProcessor) {
      anthropicProcessor.processChunk(rawChunk);
      return;
    }

    sseBuffer += rawChunk;

    if (isOllama) {
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        try {
          const json = JSON.parse(trimmed);
          if (json.done) { finishReason = "stop"; continue; }
          const contentDelta = json.message?.content ?? "";
          if (contentDelta) {
            fullContent += contentDelta;
            if (contentDelta.trim()) visibleContentChars += contentDelta.length;
            onToken(contentDelta);
          }
        } catch { /* skip */ }
      }
    } else {
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        try {
          const jsonText = trimmed.startsWith("data: ")
            ? trimmed.slice(6)
            : trimmed.startsWith("data:")
              ? trimmed.slice(5).trimStart()
              : trimmed;
          const json = JSON.parse(jsonText);
          const extracted = extractOpenAiCompatibleDelta(json);

          // Handle reasoning_content from thinking models (Qwen3.5, DeepSeek-R1, etc.)
          // Buffer tokens until we can verify they're not garbled "?" output
          // from a llama.cpp server that can't decode the thinking tokens.
          const resolvedReasoning = resolveOpenAiCompatibleReasoningDelta(extracted, emittedOpenAiCompatibleReasoning);
          emittedOpenAiCompatibleReasoning = resolvedReasoning.emittedText;
          const reasoningDelta = resolvedReasoning.delta;
          if (reasoningDelta && !reasoningGarbled) {
            providerReasoningContent += reasoningDelta;
            providerReasoningField = providerReasoningField ?? extracted.reasoningField;
            if (reasoningEmitted) {
              openReasoningBlock();
            } else {
              // Accumulate in buffer until we can verify
              reasoningBuffer += reasoningDelta;
              if (!isGarbled(reasoningBuffer)) {
                // Content contains real characters — flush buffer + emit
                reasoningEmitted = true;
                openReasoningBlock();
                reasoningBuffer = "";
              } else if (reasoningBuffer.length > 20) {
                // All '?' — the server cannot decode this model's thinking
                // tokens.  The model will never produce readable content.
                // Cancel the Rust stream to avoid waiting for a timeout,
                // then report the error.
                reasoningGarbled = true;
                reasoningBuffer = "";
                emitStreamingConsole("streaming", "info", "reasoning_content is all '?' — cancelling stream");
                invoke("cancel_chat_stream").catch(() => {});
                const garbledErr = new Error(
                  "模型的思考令牌无法被服务器解码（reasoning_content 全为 '?'），无法产生回复。\n" +
                  "建议：1) 更新 llama.cpp 至最新版本  2) 在服务端启动时加 --reasoning off  3) 更换模型"
                );
                onError(garbledErr);
                rejectResult?.(garbledErr);
                cleanup();
                return;
              }
            }
          }

          // Handle regular content
          const resolvedText = resolveOpenAiCompatibleTextDelta(extracted, emittedOpenAiCompatibleText);
          emittedOpenAiCompatibleText = resolvedText.emittedText;
          const textDelta = resolvedText.delta;
          if (textDelta) {
            // Close reasoning block if we were in one
            closeReasoningBlock();
            fullContent += textDelta;
            if (textDelta.trim()) visibleContentChars += textDelta.length;
            onToken(textDelta);
          }

          if (extracted.finishReason) finishReason = extracted.finishReason;
          if (extracted.toolCalls.length > 0) {
            for (const tc of extracted.toolCalls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
              const idx: number = tc.index ?? 0;
              const existing = toolCallsMap.get(idx);
              if (existing) {
                if (!existing.id && tc.id) existing.id = tc.id;
                if (!existing.name && tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              } else {
                toolCallsMap.set(idx, {
                  index: idx,
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "",
                });
              }
            }
          }
          if (stopReasoningOnlyRunaway()) return;
          if (stopNoVisibleProgressStall()) return;
        } catch { /* skip */ }
      }
    }
  };

  const cleanup = () => {
    unlistenChunk?.();
    unlistenDone?.();
    if (noProgressInterval !== null) {
      clearInterval(noProgressInterval);
      noProgressInterval = null;
    }
  };

  // ── Await listeners BEFORE starting stream ──────────────────────
  // This prevents the race condition where the Rust side emits
  // chat-stream-done before the JS listeners are registered.
  const [chunkUnlisten, doneUnlisten] = await Promise.all([
    listen<{ stream_id: string; chunk: string }>("chat-stream-chunk", (event) => {
      if (event.payload.stream_id !== streamId) return;
      try {
        const now = Date.now();
        rustProxyChunkCount++;
        rustProxyByteCount += event.payload.chunk.length;
        lastChunkAt = now;
        if (rustProxyChunkCount === 1) {
          callbacks.onLifecycle?.({
            phase: "first_chunk",
            streamId,
            elapsedMs: now - streamStartedAt,
            chunkCount: rustProxyChunkCount,
            byteCount: rustProxyByteCount,
            status: "streaming",
          });
        } else if (now - lastProgressLifecycleAt >= STREAM_PROGRESS_LIFECYCLE_INTERVAL_MS) {
          lastProgressLifecycleAt = now;
          callbacks.onLifecycle?.({
            phase: "chunk_progress",
            streamId,
            elapsedMs: now - streamStartedAt,
            chunkCount: rustProxyChunkCount,
            byteCount: rustProxyByteCount,
            status: "streaming",
          });
        }
        processSseChunk(event.payload.chunk);
      } catch (err) {
        if (resolved) return;
        resolved = true;
        const error = toError(err, "Failed to parse streaming response.");
        callbacks.onLifecycle?.({
          phase: "stream_error",
          streamId,
          elapsedMs: Date.now() - streamStartedAt,
          chunkCount: rustProxyChunkCount,
          byteCount: rustProxyByteCount,
          status: "error",
          error: error.message,
        });
        onError(error);
        rejectResult?.(error);
        cleanup();
      }
    }),
    listen<{ stream_id: string; status: string; error?: string }>("chat-stream-done", (event) => {
      if (event.payload.stream_id !== streamId) return;
      if (resolved) return;
      resolved = true;
      callbacks.onLifecycle?.({
        phase: event.payload.status === "cancelled"
          ? "stream_cancelled"
          : event.payload.status === "error"
          ? "stream_error"
          : "stream_done",
        streamId,
        elapsedMs: Date.now() - streamStartedAt,
        chunkCount: rustProxyChunkCount,
        byteCount: rustProxyByteCount,
        status: event.payload.status,
        error: event.payload.error,
      });

      // Process any remaining buffer
      try {
        if (anthropicProcessor) {
          anthropicProcessor.flush();
        } else if (sseBuffer.trim()) {
          processSseChunk("\n"); // Force flush by adding newline
        }
      } catch (err) {
        const error = toError(err, "Failed to finalize streaming response.");
        onError(error);
        rejectResult?.(error);
        cleanup();
        return;
      }

      if (event.payload.status === "error") {
        const errorMessage = event.payload.error?.trim() || "The cloud stream ended with an error but did not include details.";
        if (shouldRetryRustStreamAsNonStreaming(settings, errorMessage)) {
          emitStreamingConsole("streaming", "warn", "Rust stream read failed; retrying once with non-streaming local request", errorMessage);
          cleanup();
          onToken("__ESCALATION_RESET__:");
          void (async () => {
            try {
              const fallbackResult = await requestOpenAiNonStreaming(
                messages,
                settings,
                callbacks,
                signal,
                maxTokens,
                tools,
              );
              resolveResult?.(fallbackResult);
            } catch (fallbackErr) {
              rejectResult?.(toError(fallbackErr, "Local non-streaming fallback failed."));
            }
          })();
          return;
        }

        const err = new Error(errorMessage);
        onError(err);
        rejectResult?.(err);
      } else if (event.payload.status === "cancelled") {
        const err = new Error("Stream cancelled");
        err.name = "AbortError";
        onError(err);
        rejectResult?.(err);
      } else {
        // Close any unclosed reasoning block before finalizing
        closeReasoningBlock();
        // If reasoning was still buffered (never emitted, never garbled-detected),
        // it was too short to decide — discard it silently.
        reasoningBuffer = "";

        // If the entire stream produced only garbled reasoning with no
        // actual content, surface a helpful error instead of an empty reply.
        if (reasoningGarbled && !fullContent.trim()) {
          const garbledErr = new Error(
            "模型只输出了无法解码的思考令牌（reasoning_content 全为 '?'），没有产生实际回复内容。\n" +
            "可能原因：llama.cpp 版本不支持该模型的 thinking 模式。\n" +
            "建议：更新 llama.cpp 至最新版本，或更换不启用 thinking 的模型。"
          );
          onError(garbledErr);
          rejectResult?.(garbledErr);
          cleanup();
          return;
        }

        reasoningGarbled = true; // prevent further buffering

        const result: StreamResult = anthropicProcessor
          ? anthropicProcessor.getResult()
          : buildCurrentOpenAiCompatibleResult();
        onDone(result);
        resolveResult?.(result);
      }

      cleanup();
    }),
  ]);

  unlistenChunk = chunkUnlisten;
  unlistenDone = doneUnlisten;
  noProgressInterval = setInterval(() => {
    if (resolved) return;
    const now = Date.now();
    if (now - lastChunkAt < STREAM_NO_PROGRESS_WARNING_MS) return;
    if (now - lastNoProgressWarningAt < STREAM_NO_PROGRESS_WARNING_MS) return;
    lastNoProgressWarningAt = now;
    callbacks.onLifecycle?.({
      phase: "no_chunk_progress_warning",
      streamId,
      elapsedMs: now - streamStartedAt,
      chunkCount: rustProxyChunkCount,
      byteCount: rustProxyByteCount,
      status: "waiting_for_chunk",
    });
  }, 5_000);
  (noProgressInterval as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();

  // Now safe to start the stream: listeners are fully registered before Rust emits chunks.
  invoke("start_chat_stream", {
    streamId,
    url: apiUrl,
    headers,
    body: JSON.stringify(body),
    authMode: settings.authMode,
    tokenRef: settings.tokenRef,
  }).catch(err => {
    if (resolved) return;
    resolved = true;
    const error = toError(err, "Failed to start the cloud stream.");
    onError(error);
    rejectResult?.(error);
    cleanup();
  });

  // Handle abort signal
  if (signal) {
    const onAbort = () => {
      invoke("cancel_chat_stream").catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return resultPromise;
}

// ── Main streaming function ─────────────────────────────────────────
export async function streamChatCompletion(
  messages: ChatMessage[],
  settings: StreamSettings,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  tools?: ToolDefinition[],
  maxTokensOverride?: number,
): Promise<StreamResult> {
  const isOllama = isOllamaProvider(settings);
  const isAnthropic = isAnthropicProvider(settings);
  const shouldUseNonStreamingOpenAi =
    !isOllama
    && !isAnthropic
    && (isGeminiProvider(settings) || isOpenAiResponsesApi(settings) || isTranscriptCompatibilityRequest(messages));

  if (shouldUseNonStreamingOpenAi) {
    return requestOpenAiNonStreaming(messages, settings, callbacks, signal, maxTokensOverride, tools);
  }

  // Route through Rust proxy for cloud endpoints (bypasses CORS)
  if (settings.useRustProxy) {
    emitStreamingConsole("streaming", "info", "routing through Rust proxy", {
      url: settings.baseUrl,
      model: settings.model,
    });
    return streamViaRustProxy(messages, settings, callbacks, signal, tools, maxTokensOverride);
  }

  const { onToken, onDone, onError } = callbacks;
  const maxTokens = maxTokensOverride ?? computeInitialMaxTokens(settings.contextLimit);
  const isGemini = isGeminiProvider(settings);

  // Build the request body based on provider
  const geminiRequest = isGemini ? buildGeminiRuntimeRequest(settings, messages, maxTokens) : null;
  const body: Record<string, unknown> = isOllama
    ? {
        model: settings.model,
        messages: messages.map((m) => mapMessageForApi(m, true)),
        stream: true,
        options: buildOllamaOptions(settings, maxTokens),
      }
    : isAnthropic
      ? buildAnthropicRequestBody({
          messages: messages as ProtocolChatMessage[],
          model: settings.model,
          maxTokens,
          stream: true,
          tools,
        })
      : isGemini
        ? geminiRequest?.body ?? {}
      : {
          model: settings.model,
          messages: messages.map((m) => mapMessageForApi(m, false)),
          stream: true,
          max_tokens: maxTokens,
          ...(settings.sendSamplingParameters === true && settings.temperature != null ? { temperature: settings.temperature } : {}),
          ...(settings.sendSamplingParameters === true && settings.topP != null ? { top_p: settings.topP } : {}),
        };

  // Include tools if provided (native function calling) — only for non-Ollama
  if (tools && tools.length > 0 && !isOllama && !isAnthropic && !isGemini && shouldSendNativeTools(settings)) {
    body.tools = normalizeToolDefinitions(tools);
  }

  const apiUrl = geminiRequest?.url ?? buildApiUrl(settings);
  const protocol: CloudApiProtocol = isAnthropic ? "anthropic" : isGemini ? "gemini" : "openai";
  const headers: Record<string, string> = isOllama
    ? { "Content-Type": "application/json" }
    : buildCloudHeaders(protocol, settings.apiKey, true, settings.customHeaders, settings.authMode);

  if (isGemini) {
    try {
      const payload = await postJsonRequest(apiUrl, headers, body, settings, signal);
      const content = extractGeminiResponseText(payload);
      if (content) onToken(content);
      const result: StreamResult = { content, toolCalls: [], finishReason: "stop" };
      onDone(result);
      return result;
    } catch (err) {
      const normalizedError = toError(err, "Gemini request failed.");
      onError(normalizedError);
      throw normalizedError;
    }
  }

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      onError(toError(err, "Aborted"));
      throw err;
    }
    if (isLocalProfile(settings) && isRecoverableFrontendTransportError(err)) {
      const normalizedError = toError(err, "Request failed.");
      emitStreamingConsole("streaming", "warn", "frontend stream transport failed; retrying through Rust proxy", {
        url: apiUrl,
        model: settings.model,
        error: normalizedError.message,
      });
      callbacks.onLifecycle?.({
        phase: "stream_error",
        status: "frontend_transport_retry_rust_proxy",
        error: normalizedError.message,
      });
      return streamViaRustProxy(
        messages,
        { ...settings, useRustProxy: true },
        callbacks,
        signal,
        tools,
        maxTokensOverride,
      );
    }
    const normalizedError = toError(err, "Request failed.");
    onError(normalizedError);
    throw normalizedError;
  }

  if (!response.ok || !response.body) {
    // Check for context_length_exceeded error (common with local models)
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch { /* ignore */ }

    const isContextError =
      errorBody.includes("context_length_exceeded") ||
      errorBody.includes("context window") ||
      errorBody.includes("maximum context length") ||
      errorBody.includes("token limit");

    const httpErr = new Error(
      isContextError
        ? `CONTEXT_LENGTH_EXCEEDED: ${errorBody.slice(0, 500)}`
        : buildHttpErrorMessage(response.status, response.statusText, errorBody),
    );
    if (isContextError) {
      (httpErr as Error & { isContextError?: boolean }).isContextError = true;
    }
    onError(httpErr);
    throw httpErr;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const anthropicProcessor = isAnthropic ? createAnthropicStreamProcessor(onToken) : null;
  let buffer = "";

  // Accumulate text content
  let fullContent = "";
  let emittedOpenAiCompatibleText = "";
  let emittedOpenAiCompatibleReasoning = "";
  let providerReasoningContent = "";
  let providerReasoningField: StreamResult["reasoningField"] | null = null;
  let visibleContentChars = 0;

  // Track finish_reason from the stream
  let finishReason: "stop" | "length" | "tool_calls" | null = null;

  // Track reasoning phase for thinking models (e.g., Qwen3.5 with reasoning_content)
  let reasoningActive = false;
  // Buffer reasoning tokens to detect garbled "?" output from llama.cpp
  let reasoningBuffer = "";
  let reasoningEmitted = false;
  let reasoningGarbled = false;
  const isGarbled = (s: string) => /^[?]+$/.test(s);

  const openReasoningBlock = () => {
    if (reasoningActive) return;
    reasoningActive = true;
  };

  const closeReasoningBlock = () => {
    if (!reasoningActive) return;
    reasoningActive = false;
  };

  // Accumulate tool calls across deltas, keyed by index
  const toolCallsMap = new Map<number, StreamedToolCall>();

  const buildCurrentOpenAiCompatibleResult = (): StreamResult => ({
    content: fullContent,
    toolCalls: finalizeStreamedToolCalls(toolCallsMap),
    finishReason,
    ...(providerReasoningContent.trim()
      ? {
          reasoningContent: providerReasoningContent,
          ...(providerReasoningField ? { reasoningField: providerReasoningField } : {}),
        }
      : {}),
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });

      if (anthropicProcessor) {
        anthropicProcessor.processChunk(chunkText);
        continue;
      }

      buffer += chunkText;

      if (isOllama) {
        // ── Ollama native SSE format ────────────────────────────
        // Each line is a JSON object: {"message":{"content":"..."},"done":false}
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("{")) continue;

          try {
            const json = JSON.parse(trimmed);
            if (json.done) {
              finishReason = "stop";
              continue;
            }

            const contentDelta = json.message?.content ?? "";
            if (contentDelta) {
              fullContent += contentDelta;
              if (contentDelta.trim()) visibleContentChars += contentDelta.length;
              onToken(contentDelta);
            }
          } catch {
            // malformed JSON — skip
          }
        }
      } else {
        // ── OpenAI-compatible SSE format ─────────────────────────
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;

          try {
            const jsonText = trimmed.startsWith("data: ")
              ? trimmed.slice(6)
              : trimmed.startsWith("data:")
                ? trimmed.slice(5).trimStart()
                : trimmed;
            const json = JSON.parse(jsonText);
            const extracted = extractOpenAiCompatibleDelta(json);

            // Handle reasoning_content from thinking models (Qwen3.5, DeepSeek-R1, etc.)
            // Buffer tokens until we can verify they're not garbled "?" output
            const resolvedReasoning = resolveOpenAiCompatibleReasoningDelta(extracted, emittedOpenAiCompatibleReasoning);
            emittedOpenAiCompatibleReasoning = resolvedReasoning.emittedText;
            const reasoningDelta = resolvedReasoning.delta;
            if (reasoningDelta && !reasoningGarbled) {
              providerReasoningContent += reasoningDelta;
              providerReasoningField = providerReasoningField ?? extracted.reasoningField;
              if (reasoningEmitted) {
                openReasoningBlock();
              } else {
                reasoningBuffer += reasoningDelta;
                if (!isGarbled(reasoningBuffer)) {
                  reasoningEmitted = true;
                  openReasoningBlock();
                  reasoningBuffer = "";
                } else if (reasoningBuffer.length > 20) {
                  reasoningGarbled = true;
                  reasoningBuffer = "";
                  emitStreamingConsole("streaming", "info", "reasoning_content is all '?' — cancelling stream");
                  reader.cancel().catch(() => {});
                  const garbledErr = new Error(
                    "模型的思考令牌无法被服务器解码（reasoning_content 全为 '?'），无法产生回复。\n" +
                    "建议：1) 更新 llama.cpp 至最新版本  2) 在服务端启动时加 --reasoning off  3) 更换模型"
                  );
                  onError(garbledErr);
                  throw Object.assign(garbledErr, { _garbledAbort: true });
                }
              }
            }

            // Handle text content deltas
            const resolvedText = resolveOpenAiCompatibleTextDelta(extracted, emittedOpenAiCompatibleText);
            emittedOpenAiCompatibleText = resolvedText.emittedText;
            const textDelta = resolvedText.delta;
            if (textDelta) {
              // Close reasoning block if we were in one
              closeReasoningBlock();
              fullContent += textDelta;
              if (textDelta.trim()) visibleContentChars += textDelta.length;
              onToken(textDelta);
            }

            // Detect finish_reason for truncation awareness
            if (extracted.finishReason) finishReason = extracted.finishReason;

            // Handle tool_call deltas (native function calling)
            if (extracted.toolCalls.length > 0) {
              for (const tc of extracted.toolCalls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
                const idx: number = tc.index ?? 0;
                const existing = toolCallsMap.get(idx);

                if (existing) {
                  if (!existing.id && tc.id) existing.id = tc.id;
                  if (!existing.name && tc.function?.name) existing.name = tc.function.name;
                  // Accumulate arguments fragments
                  if (tc.function?.arguments) {
                    existing.arguments += tc.function.arguments;
                  }
                } else {
                  // New tool call entry
                  toolCallsMap.set(idx, {
                    index: idx,
                    id: tc.id ?? "",
                    name: tc.function?.name ?? "",
                    arguments: tc.function?.arguments ?? "",
                  });
                }
              }
            }
            if (shouldStopReasoningOnlyStream({
              reasoningChars: providerReasoningContent.length,
              visibleChars: visibleContentChars,
              toolCallCount: toolCallsMap.size,
              settings,
            })) {
              finishReason = "length";
              closeReasoningBlock();
              reasoningBuffer = "";
              const dynamicLimit = isLocalProfile(settings) ? 96_000 : REASONING_ONLY_STREAM_GUARD_CHAR_LIMIT;
              emitStreamingConsole(
                "streaming",
                "warn",
                `Reasoning-only stream exceeded ${dynamicLimit} chars without visible output or tool calls; cancelling stream.`,
              );
              await reader.cancel().catch(() => {});
              const result = buildCurrentOpenAiCompatibleResult();
              onDone(result);
              return result;
            }
          } catch (e) {
            // Re-throw garbled-reasoning abort — must not be swallowed
            if (e && (e as any)._garbledAbort) throw e;
            // malformed SSE chunk — skip
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") onError(toError(err, "Streaming request failed."));
    throw err;
  }

  // Flush any remaining buffer
  if (anthropicProcessor) {
    anthropicProcessor.flush();
  } else if (buffer.trim()) {
    if (isOllama) {
      try {
        const json = JSON.parse(buffer.trim());
        if (json.message?.content) {
          fullContent += json.message.content;
          if (json.message.content.trim()) visibleContentChars += json.message.content.length;
          onToken(json.message.content);
        }
      } catch { /* ignore */ }
    } else {
      const remaining = buffer.trim();
      for (const line of remaining.split("\n")) {
        const t = line.trim();
        if (!t || t === "data: [DONE]") continue;
        const d = t.startsWith("data: ") ? t.slice(6) : t.startsWith("data:") ? t.slice(5).trimStart() : null;
        if (!d) continue;
        try {
          const json = JSON.parse(d);
          const extracted = extractOpenAiCompatibleDelta(json);
          const resolvedReasoning = resolveOpenAiCompatibleReasoningDelta(extracted, emittedOpenAiCompatibleReasoning);
          emittedOpenAiCompatibleReasoning = resolvedReasoning.emittedText;
          if (resolvedReasoning.delta) {
            providerReasoningContent += resolvedReasoning.delta;
            providerReasoningField = providerReasoningField ?? extracted.reasoningField;
          }
          const resolvedText = resolveOpenAiCompatibleTextDelta(extracted, emittedOpenAiCompatibleText);
          emittedOpenAiCompatibleText = resolvedText.emittedText;
          const contentDelta = resolvedText.delta;
          if (contentDelta) {
            fullContent += contentDelta;
            if (contentDelta.trim()) visibleContentChars += contentDelta.length;
            onToken(contentDelta);
          }
        } catch { /* ignore */ }
      }
    }
  }

  // Close any unclosed reasoning block
  closeReasoningBlock();
  // Discard any buffered (never-verified) reasoning content
  reasoningBuffer = "";

  // If the entire stream produced only garbled reasoning with no actual
  // content, throw a descriptive error instead of returning an empty result.
  if (reasoningGarbled && !fullContent.trim()) {
    throw new Error(
      "模型只输出了无法解码的思考令牌（reasoning_content 全为 '?'），没有产生实际回复内容。\n" +
      "可能原因：llama.cpp 版本不支持该模型的 thinking 模式。\n" +
      "建议：更新 llama.cpp 至最新版本，或更换不启用 thinking 的模型。"
    );
  }

  reasoningGarbled = true;

  const result: StreamResult = anthropicProcessor
    ? anthropicProcessor.getResult()
    : buildCurrentOpenAiCompatibleResult();

  if (result.finishReason === "length") {
    emitStreamingConsole("streaming", "warn", `Response truncated — finish_reason is "length". Consider increasing max_tokens.`);
  }

  onDone(result);
  return result;
}
