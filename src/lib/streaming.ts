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
  buildOpenAiResponsesInputCandidates,
  buildOpenAiResponsesRequestExtras,
  extractOpenAiResponsesInstructions,
  buildAnthropicRequestBody,
  buildCloudHeaders,
  buildCloudMessagesApiUrl,
  createAnthropicStreamProcessor,
  extractOpenAiResponseText,
  finalizeStreamedToolCalls,
  normalizeCloudApiFormat,
  normalizeCloudProtocol,
  type CloudApiProtocol,
  type OpenAiApiFormat,
  type OpenAiReasoningEffort,
  type ProtocolChatMessage,
} from "./cloudProtocol";
import { computeContextBudgets } from "./contextTrim";
import { toError } from "./errorUtils";
import { isProviderCompatibilityErrorMessage, PROVIDER_COMPATIBILITY_TAG } from "./providerCompatibility";

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
}

/** Flat connection params derived from AppConfig.local or AppConfig.cloud */
export interface StreamSettings {
  baseUrl: string;      // e.g. "http://127.0.0.1:8080/v1"
  apiKey: string;       // e.g. "ollama" / actual key
  model: string;
  apiProtocol?: CloudApiProtocol;
  apiFormat?: OpenAiApiFormat;
  customHeaders?: string;
  temperature?: number;
  topP?: number;
  disableResponseStorage?: boolean;
  reasoningEffort?: OpenAiReasoningEffort;
  contextLimit?: number; // total context window for the model (used to calculate max_tokens)
  provider?: string;    // "Ollama" | "LM Studio" | "OMLX" | "OpenAI" — controls SSE format
  useRustProxy?: boolean; // Route through Rust backend to bypass CORS (for cloud endpoints)
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
}

interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: (result: StreamResult) => void;
  onError: (err: Error) => void;
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

function extractOpenAiCompatibleDelta(payload: unknown): {
  content: string;
  reasoning: string;
  finishReason: "stop" | "length" | "tool_calls" | null;
  toolCalls: unknown[];
} {
  if (!payload || typeof payload !== "object") {
    return { content: "", reasoning: "", finishReason: null, toolCalls: [] };
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
  const rawFinishReason = choice?.finish_reason ?? root.done_reason;
  const normalizedFinishReason = rawFinishReason === "length" || rawFinishReason === "tool_calls" || rawFinishReason === "stop"
    ? rawFinishReason
    : root.done === true
      ? "stop"
      : null;

  return {
    content: extractTextLike(source.content ?? source.text ?? root.response),
    reasoning: extractTextLike(source.reasoning_content ?? source.reasoning ?? source.thinking ?? source.thought),
    finishReason: normalizedFinishReason,
    toolCalls: Array.isArray(source.tool_calls) ? source.tool_calls : [],
  };
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

/** Map a ChatMessage to the provider-specific format for the API request body. */
function mapMessageForApi(m: ChatMessage, isOllama: boolean): Record<string, unknown> {
  const isMultimodal = Array.isArray(m.content);

  if (m.role === "tool") {
    return { role: "tool", content: extractTextContent(m.content), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) };
  }

  if (m.role === "assistant" && m.tool_calls) {
    return {
      role: "assistant",
      content: extractTextContent(m.content) || "",
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id, type: tc.type,
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === "string"
            ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })()
            : tc.function.arguments,
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
    return { role: m.role, content: extractTextContent(m.content) };
  }

  // OpenAI-compatible: pass content as-is (string or multimodal array)
  return { role: m.role, content: typeof m.content === "string" ? m.content : m.content };
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

function isOpenAiResponsesApi(settings: StreamSettings): boolean {
  return !isAnthropicProvider(settings) && normalizeCloudApiFormat(settings.apiFormat) === "responses";
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
    try {
      result = await invoke<string>("proxy_request", {
        url,
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw toError(err, "Cloud request failed.");
    }
    if (signal?.aborted) throw createAbortError();
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
): Promise<StreamResult> {
  const { onToken, onDone, onError } = callbacks;

  try {
    const maxTokens = maxTokensOverride ?? computeInitialMaxTokens(settings.contextLimit);
    const apiFormat = normalizeCloudApiFormat(settings.apiFormat);
    const apiUrl = buildApiUrl(settings);
    const headers = buildCloudHeaders("openai", settings.apiKey, true, settings.customHeaders);
    const minimalCompatibilityMode = isTranscriptCompatibilityRequest(messages);
    let payload: unknown;

    if (apiFormat === "responses") {
      const protocolMessages = messages as ProtocolChatMessage[];
      const inputCandidates = buildOpenAiResponsesInputCandidates(protocolMessages);
      const instructions = extractOpenAiResponsesInstructions(protocolMessages);
      let lastCompatibilityError: Error | null = null;

      for (const candidate of inputCandidates) {
        try {
          payload = await postJsonRequest(
            apiUrl,
            headers,
            {
              model: settings.model,
              input: candidate.input,
              ...(instructions ? { instructions } : {}),
              ...buildOpenAiResponsesRequestExtras({
                disableResponseStorage: settings.disableResponseStorage,
                reasoningEffort: settings.reasoningEffort,
              }),
            },
            settings,
            signal,
          );
          if (candidate.mode !== "message_text") {
            console.log(`[streaming] OpenAI responses fallback succeeded with ${candidate.mode}`);
          }
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          lastCompatibilityError = err instanceof Error ? err : new Error(errMsg);
          if (!isProviderCompatibilityErrorMessage(errMsg)) {
            throw lastCompatibilityError;
          }
        }
      }

      if (payload == null) {
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
          ...(!minimalCompatibilityMode ? { max_tokens: maxTokens } : {}),
          ...(!minimalCompatibilityMode && settings.temperature != null ? { temperature: settings.temperature } : {}),
          ...(!minimalCompatibilityMode && settings.topP != null ? { top_p: settings.topP } : {}),
        },
        settings,
        signal,
      );
    }

    const content = extractOpenAiResponseText(payload, apiFormat);
    const result: StreamResult = {
      content,
      toolCalls: [],
      finishReason: "stop",
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
    isAnthropicProvider(settings) ? "anthropic" : "openai",
    normalizeCloudApiFormat(settings.apiFormat),
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
  const maxTokens = maxTokensOverride ?? computeInitialMaxTokens(settings.contextLimit);

  // Build the request body (same logic as streamChatCompletion)
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
          temperature: settings.temperature ?? 0.2,
          topP: settings.topP,
          tools,
        })
      : {
          model: settings.model,
          messages: messages.map((m) => mapMessageForApi(m, false)),
          stream: true,
          max_tokens: maxTokens,
          temperature: settings.temperature ?? 0.2,
          ...(settings.topP != null ? { top_p: settings.topP } : {}),
        };

  if (tools && tools.length > 0 && !isOllama && !isAnthropic) {
    body.tools = normalizeToolDefinitions(tools);
  }

  const apiUrl = buildApiUrl(settings);
  const protocol: CloudApiProtocol = isAnthropic ? "anthropic" : "openai";
  const headers: Record<string, string> = isOllama
    ? { "Content-Type": "application/json" }
    : buildCloudHeaders(protocol, settings.apiKey, true, settings.customHeaders);

  // Generate a unique stream ID
  const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
  let finishReason: "stop" | "length" | "tool_calls" | null = null;
  const toolCallsMap = new Map<number, StreamedToolCall>();

  let unlistenChunk: UnlistenFn | null = null;
  let unlistenDone: UnlistenFn | null = null;
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
          if (contentDelta) { fullContent += contentDelta; onToken(contentDelta); }
        } catch { /* skip */ }
      }
    } else {
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;

          // Handle reasoning_content from thinking models (Qwen3.5, DeepSeek-R1, etc.)
          // Buffer tokens until we can verify they're not garbled "?" output
          // from a llama.cpp server that can't decode the thinking tokens.
          const reasoningDelta = extractTextLike(
            delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? delta.thought,
          );
          if (reasoningDelta && !reasoningGarbled) {
            if (reasoningEmitted) {
              // Already verified as legitimate — emit directly
              fullContent += reasoningDelta;
              onToken(reasoningDelta);
            } else {
              // Accumulate in buffer until we can verify
              reasoningBuffer += reasoningDelta;
              if (!isGarbled(reasoningBuffer)) {
                // Content contains real characters — flush buffer + emit
                reasoningEmitted = true;
                reasoningActive = true;
                onToken("<thinking>");
                fullContent += reasoningBuffer;
                onToken(reasoningBuffer);
                reasoningBuffer = "";
              } else if (reasoningBuffer.length > 20) {
                // All '?' — the server cannot decode this model's thinking
                // tokens.  The model will never produce readable content.
                // Cancel the Rust stream to avoid waiting for a timeout,
                // then report the error.
                reasoningGarbled = true;
                reasoningBuffer = "";
                console.log("[streaming] reasoning_content is all '?' — cancelling stream");
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
          const textDelta = extractTextLike(delta.content ?? delta.text);
          if (textDelta) {
            // Close reasoning block if we were in one
            if (reasoningActive) {
              reasoningActive = false;
              onToken("</thinking>");
            }
            fullContent += textDelta;
            onToken(textDelta);
          }

          const choice = json.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
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
        } catch { /* skip */ }
      }
    }
  };

  const cleanup = () => {
    unlistenChunk?.();
    unlistenDone?.();
  };

  // ── Await listeners BEFORE starting stream ──────────────────────
  // This prevents the race condition where the Rust side emits
  // chat-stream-done before the JS listeners are registered.
  const [chunkUnlisten, doneUnlisten] = await Promise.all([
    listen<{ stream_id: string; chunk: string }>("chat-stream-chunk", (event) => {
      if (event.payload.stream_id !== streamId) return;
      try {
        processSseChunk(event.payload.chunk);
      } catch (err) {
        if (resolved) return;
        resolved = true;
        const error = toError(err, "Failed to parse streaming response.");
        onError(error);
        rejectResult?.(error);
        cleanup();
      }
    }),
    listen<{ stream_id: string; status: string; error?: string }>("chat-stream-done", (event) => {
      if (event.payload.stream_id !== streamId) return;
      if (resolved) return;
      resolved = true;

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
        const err = new Error(
          event.payload.error?.trim() || "The cloud stream ended with an error but did not include details.",
        );
        onError(err);
        rejectResult?.(err);
      } else if (event.payload.status === "cancelled") {
        const err = new Error("Stream cancelled");
        err.name = "AbortError";
        onError(err);
        rejectResult?.(err);
      } else {
        // Close any unclosed reasoning block before finalizing
        if (reasoningActive) {
          reasoningActive = false;
          onToken("</thinking>");
        }
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
          : {
              content: fullContent,
              toolCalls: finalizeStreamedToolCalls(toolCallsMap),
              finishReason,
            };
        onDone(result);
        resolveResult?.(result);
      }

      cleanup();
    }),
  ]);

  unlistenChunk = chunkUnlisten;
  unlistenDone = doneUnlisten;

  // Now safe to start the stream — listeners are fully registered
  console.log('[streamViaRustProxy] invoking start_chat_stream, url:', apiUrl, 'model:', settings.model, 'headers:', JSON.stringify(headers));
  invoke("start_chat_stream", {
    streamId,
    url: apiUrl,
    headers,
    body: JSON.stringify(body),
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
    && (isOpenAiResponsesApi(settings) || isTranscriptCompatibilityRequest(messages));

  if (shouldUseNonStreamingOpenAi) {
    return requestOpenAiNonStreaming(messages, settings, callbacks, signal, maxTokensOverride);
  }

  // Route through Rust proxy for cloud endpoints (bypasses CORS)
  if (settings.useRustProxy) {
    console.log('[streaming] routing through Rust proxy, url:', settings.baseUrl, 'model:', settings.model);
    return streamViaRustProxy(messages, settings, callbacks, signal, tools, maxTokensOverride);
  }

  const { onToken, onDone, onError } = callbacks;
  const maxTokens = maxTokensOverride ?? computeInitialMaxTokens(settings.contextLimit);

  // Build the request body based on provider
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
          temperature: settings.temperature ?? 0.2,
          topP: settings.topP,
          tools,
        })
      : {
          model: settings.model,
          messages: messages.map((m) => mapMessageForApi(m, false)),
          stream: true,
          max_tokens: maxTokens,
          temperature: settings.temperature ?? 0.2,
          ...(settings.topP != null ? { top_p: settings.topP } : {}),
        };

  // Include tools if provided (native function calling) — only for non-Ollama
  if (tools && tools.length > 0 && !isOllama && !isAnthropic) {
    body.tools = normalizeToolDefinitions(tools);
  }

  const apiUrl = buildApiUrl(settings);
  const protocol: CloudApiProtocol = isAnthropic ? "anthropic" : "openai";
  const headers: Record<string, string> = isOllama
    ? { "Content-Type": "application/json" }
    : buildCloudHeaders(protocol, settings.apiKey, true, settings.customHeaders);

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

  // Track finish_reason from the stream
  let finishReason: "stop" | "length" | "tool_calls" | null = null;

  // Track reasoning phase for thinking models (e.g., Qwen3.5 with reasoning_content)
  let reasoningActive = false;
  // Buffer reasoning tokens to detect garbled "?" output from llama.cpp
  let reasoningBuffer = "";
  let reasoningEmitted = false;
  let reasoningGarbled = false;
  const isGarbled = (s: string) => /^[?]+$/.test(s);

  // Accumulate tool calls across deltas, keyed by index
  const toolCallsMap = new Map<number, StreamedToolCall>();

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
          if (!trimmed.startsWith("data: ")) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta;

            if (!delta) continue;

            // Handle reasoning_content from thinking models (Qwen3.5, DeepSeek-R1, etc.)
            // Buffer tokens until we can verify they're not garbled "?" output
            const reasoningDelta = extractTextLike(
              delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? delta.thought,
            );
            if (reasoningDelta && !reasoningGarbled) {
              if (reasoningEmitted) {
                fullContent += reasoningDelta;
                onToken(reasoningDelta);
              } else {
                reasoningBuffer += reasoningDelta;
                if (!isGarbled(reasoningBuffer)) {
                  reasoningEmitted = true;
                  reasoningActive = true;
                  onToken("<thinking>");
                  fullContent += reasoningBuffer;
                  onToken(reasoningBuffer);
                  reasoningBuffer = "";
                } else if (reasoningBuffer.length > 20) {
                  reasoningGarbled = true;
                  reasoningBuffer = "";
                  console.log("[streaming] reasoning_content is all '?' — cancelling stream");
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
            const textDelta = extractTextLike(delta.content ?? delta.text);
            if (textDelta) {
              // Close reasoning block if we were in one
              if (reasoningActive) {
                reasoningActive = false;
                onToken("</thinking>");
              }
              fullContent += textDelta;
              onToken(textDelta);
            }

            // Detect finish_reason for truncation awareness
            const choice = json.choices?.[0];
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // Handle tool_call deltas (native function calling)
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
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
          const delta = json.choices?.[0]?.delta;
          const contentDelta = extractTextLike(delta?.content ?? delta?.text);
          if (contentDelta) {
            fullContent += contentDelta;
            onToken(contentDelta);
          }
        } catch { /* ignore */ }
      }
    }
  }

  // Close any unclosed reasoning block
  if (reasoningActive) {
    reasoningActive = false;
    onToken("</thinking>");
  }
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
    : {
        content: fullContent,
        toolCalls: finalizeStreamedToolCalls(toolCallsMap),
        finishReason,
      };

  if (result.finishReason === "length") {
    console.warn(`[streaming] Response truncated — finish_reason is "length". Consider increasing max_tokens.`);
  }

  onDone(result);
  return result;
}
