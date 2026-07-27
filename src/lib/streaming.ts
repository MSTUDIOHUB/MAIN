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
  parseOpenAiResponsesSsePayload,
  resolveOpenAiResponsesTerminalState,
  type CloudApiProtocol,
  type CloudAuthMode,
  type CloudToolProtocol,
  type OpenAiApiFormat,
  type OpenAiReasoningEffort,
  type OpenAiResponsesTerminalStatus,
  type ProtocolChatMessage,
  type ReasoningRequestMode,
} from "./cloudProtocol";
import { computeContextBudgets } from "./contextTrim";
import { isRetryableCloudErrorMessage } from "./cloudRetry";
import { toError } from "./errorUtils";
import { isNativeToolCompatibilityErrorMessage, isProviderCompatibilityErrorMessage, PROVIDER_COMPATIBILITY_TAG } from "./providerCompatibility";
import { sanitizeAssistantDisplayContent } from "./sanitize";
import {
  detectVisibleTextRepetition,
  type VisibleTextRepetitionMatch,
} from "./visibleTextRepetition";
import {
  countProviderOmittedVisualParts,
  digestVisualPayloadIdentities,
  visualPayloadIdentitiesFromContent,
  type VisualTransportRequestBinding,
  type VisualTransportReceipt,
} from "./visualContext";

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

function createVisibleTextRepetitionError(match: VisibleTextRepetitionMatch): Error {
  const error = new Error(
    `STREAM_VISIBLE_TEXT_REPETITION: model repeated a ${match.cycleChars}-character visible cycle ` +
    `${match.repetitions} times without a tool call.`,
  );
  (error as Error & { code?: string }).code = "STREAM_VISIBLE_TEXT_REPETITION";
  return error;
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
  runtimeTurnId?: string;
  runtimeVisualImageParts?: number;
  runtimeVisualPayloadDigest?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
}

/** Flat connection params derived from AppConfig.local or AppConfig.cloud */
export interface StreamSettings {
  baseUrl: string;      // e.g. "http://127.0.0.1:8000/v1"
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
  reasoningRequest?: ReasoningRequestMode;
  toolProtocol?: CloudToolProtocol;
  contextLimit?: number; // total context window for the model (used to calculate max_tokens)
  provider?: string;    // "Ollama" | "LM Studio" | "OMLX" | "OpenAI" — controls SSE format
  useRustProxy?: boolean; // Route through Rust backend to bypass WebView/CORS transport limits.
}

export type OpenAiToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface StreamRequestOptions {
  toolChoice?: OpenAiToolChoice;
  responseFormat?: Record<string, unknown>;
  visualTransportBinding?: VisualTransportRequestBinding;
  timeoutMs?: number;
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
  /** Mirror-stripped model content retained for tool/options normalization. */
  actionableContent?: string;
  /** Content after reasoning/protocol mirror removal. Raw provider text remains in `content`. */
  semanticContent?: string;
  toolCalls: StreamedToolCall[];
  finishReason: "stop" | "length" | "tool_calls" | null;
  reasoningContent?: string;
  reasoningField?: "reasoning_content" | "reasoning";
  /** Provider returned a terminal response that violated the requested tool protocol. */
  protocolViolation?:
    | "required_tool_call_missing"
    | "required_function_call_mismatch"
    | "required_tool_call_not_available";
  /** Named tool requested by the runtime when a provider returned another tool. */
  protocolExpectedTool?: string;
  /** Tool names returned by the provider before the mismatched calls were quarantined. */
  protocolActualTools?: string[];
  /** Structured calls retained only for recovery targeting after quarantine. */
  protocolActualToolCalls?: StreamedToolCall[];
  /** Tools exposed by the active capability contract when returned calls were outside it. */
  protocolAllowedTools?: string[];
  /** Exact typed Plan envelope accepted as a transport fallback on the sole Plan submission surface. */
  protocolTransportAdaptation?: "typed_plan_text_envelope";
  /** The provider channel that carried the exact typed Plan envelope. */
  protocolTransportSource?: "content";
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  streamDiagnostics?: StreamSemanticDiagnostics;
  /** Receipt for the exact accepted request that produced this response. */
  visualTransportReceipt?: VisualTransportReceipt;
  /** Explicit terminal state reported by the OpenAI Responses API. */
  responseStatus?: OpenAiResponsesTerminalStatus;
  /** Provider reason when a Responses result ended before completion. */
  responseIncompleteReason?: string;
}

export type StreamMirrorKind =
  | "none"
  | "exact"
  | "normalized_exact"
  | "reasoning_prefix"
  | "content_prefix"
  | "near";

export interface StreamSemanticDiagnostics {
  rawContentChars: number;
  reasoningChars: number;
  semanticVisibleChars: number;
  mirrorKind: StreamMirrorKind;
  overlapRatio: number;
  contentHash: string | null;
  reasoningHash: string | null;
  normalizedContentHash: string | null;
  normalizedReasoningHash: string | null;
  firstSemanticVisibleElapsedMs: number | null;
  firstToolElapsedMs: number | null;
}

export interface SemanticStreamProgress extends Omit<StreamSemanticDiagnostics, "firstSemanticVisibleElapsedMs" | "firstToolElapsedMs"> {
  rawContent: string;
  actionableContent: string;
  semanticContent: string;
}

const CROSS_CHANNEL_MIRROR_MIN_CHARS = 512;
const CROSS_CHANNEL_NEAR_MIRROR_RATIO = 0.92;

function hashDiagnosticText(value: string): string | null {
  if (!value) return null;
  // FNV-1a is intentionally non-cryptographic. It lets diagnostics compare
  // channels without persisting any hidden reasoning text.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeMirrorText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

function commonSuffixLength(a: string, b: string, prefixLength: number): number {
  const limit = Math.min(a.length, b.length) - prefixLength;
  let count = 0;
  while (
    count < limit &&
    a.charCodeAt(a.length - 1 - count) === b.charCodeAt(b.length - 1 - count)
  ) {
    count += 1;
  }
  return count;
}

/**
 * Separate provider transport text from user-visible progress.
 *
 * Some OpenAI-compatible servers emit reasoning in `reasoning_content` and,
 * when a thinking block never closes, replay that same transcript as
 * `content`. That recovery text must remain available for diagnostics but it
 * is neither a user-visible conclusion nor forward progress.
 */
export function analyzeSemanticStreamProgress(input: {
  content?: string | null;
  reasoningContent?: string | null;
}): SemanticStreamProgress {
  const rawContent = String(input.content || "");
  const reasoningContent = String(input.reasoningContent || "");
  const normalizedContent = normalizeMirrorText(rawContent);
  const normalizedReasoning = normalizeMirrorText(reasoningContent);
  const shorterLength = Math.min(rawContent.length, reasoningContent.length);
  const longerLength = Math.max(rawContent.length, reasoningContent.length);
  const eligibleForMirror = shorterLength >= CROSS_CHANNEL_MIRROR_MIN_CHARS;
  let mirrorKind: StreamMirrorKind = "none";
  let semanticCandidate = rawContent;
  let overlapRatio = 0;

  if (eligibleForMirror && rawContent === reasoningContent) {
    mirrorKind = "exact";
    semanticCandidate = "";
    overlapRatio = 1;
  } else if (
    eligibleForMirror &&
    normalizedContent &&
    normalizedContent === normalizedReasoning
  ) {
    mirrorKind = "normalized_exact";
    semanticCandidate = "";
    overlapRatio = 1;
  } else if (
    eligibleForMirror &&
    rawContent.startsWith(reasoningContent) &&
    reasoningContent.length / Math.max(1, rawContent.length) >= 0.8
  ) {
    mirrorKind = "reasoning_prefix";
    semanticCandidate = rawContent.slice(reasoningContent.length);
    overlapRatio = reasoningContent.length / Math.max(1, rawContent.length);
  } else if (
    eligibleForMirror &&
    reasoningContent.startsWith(rawContent) &&
    rawContent.length / Math.max(1, reasoningContent.length) >= 0.8
  ) {
    mirrorKind = "content_prefix";
    semanticCandidate = "";
    overlapRatio = rawContent.length / Math.max(1, reasoningContent.length);
  } else if (eligibleForMirror && longerLength > 0) {
    const prefixLength = commonPrefixLength(normalizedContent, normalizedReasoning);
    const suffixLength = commonSuffixLength(normalizedContent, normalizedReasoning, prefixLength);
    overlapRatio = Math.min(1, (prefixLength + suffixLength) / Math.max(1, Math.min(normalizedContent.length, normalizedReasoning.length)));
    const lengthRatio = Math.min(normalizedContent.length, normalizedReasoning.length) /
      Math.max(1, Math.max(normalizedContent.length, normalizedReasoning.length));
    if (overlapRatio >= CROSS_CHANNEL_NEAR_MIRROR_RATIO && lengthRatio >= 0.85) {
      mirrorKind = "near";
      semanticCandidate = "";
    }
  }

  const semanticContent = sanitizeAssistantDisplayContent(semanticCandidate).trim();
  return {
    rawContent,
    actionableContent: semanticCandidate,
    semanticContent,
    rawContentChars: rawContent.length,
    reasoningChars: reasoningContent.length,
    semanticVisibleChars: semanticContent.length,
    mirrorKind,
    overlapRatio: Math.round(overlapRatio * 1000) / 1000,
    contentHash: hashDiagnosticText(rawContent),
    reasoningHash: hashDiagnosticText(reasoningContent),
    normalizedContentHash: hashDiagnosticText(normalizedContent),
    normalizedReasoningHash: hashDiagnosticText(normalizedReasoning),
  };
}

function extractProviderTokenUsage(payload: unknown): StreamResult["usage"] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const usage = (record.usage && typeof record.usage === "object"
    ? record.usage
    : record.usageMetadata && typeof record.usageMetadata === "object"
      ? record.usageMetadata
      : record) as Record<string, unknown>;
  const finite = (...values: unknown[]): number => {
    for (const value of values) {
      const numberValue = Number(value);
      if (Number.isFinite(numberValue) && numberValue >= 0) return Math.floor(numberValue);
    }
    return 0;
  };
  const inputTokens = finite(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.promptTokenCount,
    usage.prompt_eval_count,
    record.prompt_eval_count,
  );
  const outputTokens = finite(
    usage.output_tokens,
    usage.completion_tokens,
    usage.candidatesTokenCount,
    usage.eval_count,
    record.eval_count,
  );
  const totalTokens = finite(
    usage.total_tokens,
    usage.totalTokenCount,
    record.total_tokens,
    inputTokens + outputTokens,
  );
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return undefined;
  return { inputTokens, outputTokens, totalTokens: totalTokens || inputTokens + outputTokens };
}

const REASONING_ONLY_STREAM_GUARD_CHAR_LIMIT = 12_000;
const STREAM_NO_VISIBLE_PROGRESS_TIMEOUT_MS = 120_000;

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
  return Math.max(4096, computeContextBudgets(contextLimit).outputBudget);
}

function computeMaxTokensCeiling(contextLimit?: number): number {
  if (!contextLimit) return 65536;
  return Math.max(
    computeInitialMaxTokens(contextLimit),
    Math.min(32768, Math.floor(contextLimit * 0.35)),
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

function visualPayloadIdentity(value: unknown, rawBase64 = false): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const dataUrl = text.match(/^data:image\/[^;]+;base64,(.+)$/s);
  if (dataUrl) return `base64:${dataUrl[1]}`;
  if (/^https?:\/\//i.test(text)) return `url:${text}`;
  return rawBase64 ? `base64:${text}` : null;
}

function visualPayloadIdentitiesFromMessage(message: ChatMessage): string[] {
  return visualPayloadIdentitiesFromContent(message.content);
}

function latestLogicalVisualPayload(
  messages: ChatMessage[],
  binding?: VisualTransportRequestBinding,
): {
  identities: string[];
  omittedParts: number;
} {
  if (binding) {
    // Exact runtime ownership disables the historical fallback entirely. A
    // missing/compacted current payload must produce a failed receipt, never
    // borrow an older Turn's screenshot.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message.role !== "user" ||
        String(message.runtimeTurnId || "").trim() !== binding.owner.turnId
      ) continue;
      return {
        identities: visualPayloadIdentitiesFromMessage(message),
        omittedParts: countProviderOmittedVisualParts([message]),
      };
    }
    return { identities: [], omittedParts: 0 };
  }
  // Bind the receipt to the newest visual-bearing logical message. An image
  // left in history must never make a newer image that was dropped during
  // provider serialization look delivered.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const identities = visualPayloadIdentitiesFromMessage(message);
    const omittedParts = countProviderOmittedVisualParts([message]);
    if (identities.length > 0 || omittedParts > 0) return { identities, omittedParts };
  }
  return { identities: [], omittedParts: 0 };
}

function collectSerializedVisualPayloadIdentities(
  value: unknown,
  output: string[] = [],
  seen = new Set<object>(),
): string[] {
  if (!value || typeof value !== "object") return output;
  if (seen.has(value as object)) return output;
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((item) => collectSerializedVisualPayloadIdentities(item, output, seen));
    return output;
  }

  const record = value as Record<string, unknown>;
  const type = String(record.type || "").toLowerCase();
  if (type === "image_url" || type === "input_image") {
    const imageUrl = typeof record.image_url === "string"
      ? record.image_url
      : (record.image_url as Record<string, unknown> | undefined)?.url;
    const identity = visualPayloadIdentity(imageUrl);
    if (identity) output.push(identity);
  }
  if (type === "image") {
    const source = record.source as Record<string, unknown> | undefined;
    const sourceType = String(source?.type || "").toLowerCase();
    const identity = sourceType === "base64"
      ? visualPayloadIdentity(source?.data, true)
      : visualPayloadIdentity(source?.url);
    if (identity) output.push(identity);
  }
  const inlineData = (record.inlineData || record.inline_data) as Record<string, unknown> | undefined;
  if (inlineData && typeof inlineData.data === "string") {
    const identity = visualPayloadIdentity(inlineData.data, true);
    if (identity) output.push(identity);
  }
  if (Array.isArray(record.images)) {
    for (const image of record.images) {
      const identity = visualPayloadIdentity(image, true);
      if (identity) output.push(identity);
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (
      key === "image_url" ||
      key === "source" ||
      key === "inlineData" ||
      key === "inline_data" ||
      key === "images"
    ) continue;
    collectSerializedVisualPayloadIdentities(child, output, seen);
  }
  return output;
}

function countCurrentSerializedVisualParts(
  logicalIdentities: string[],
  body: Record<string, unknown>,
): number {
  const serializedCounts = new Map<string, number>();
  for (const identity of collectSerializedVisualPayloadIdentities(body)) {
    serializedCounts.set(identity, (serializedCounts.get(identity) || 0) + 1);
  }
  let matched = 0;
  for (const identity of logicalIdentities) {
    const remaining = serializedCounts.get(identity) || 0;
    if (remaining <= 0) continue;
    serializedCounts.set(identity, remaining - 1);
    matched += 1;
  }
  return matched;
}

function buildVisualTransportReceipt(
  messages: ChatMessage[],
  body: Record<string, unknown>,
  protocol: string,
  binding?: VisualTransportRequestBinding,
): VisualTransportReceipt {
  const currentVisual = latestLogicalVisualPayload(messages, binding);
  const logicalImageParts = currentVisual.identities.length > 0
    ? currentVisual.identities.length
    : binding && currentVisual.omittedParts >= binding.expectedImageParts
    ? binding.expectedImageParts
    : 0;
  const serializedImageParts = countCurrentSerializedVisualParts(currentVisual.identities, body);
  const providerOmittedParts = currentVisual.omittedParts;
  const omittedImageParts = Math.max(
    providerOmittedParts,
    logicalImageParts - serializedImageParts,
  );
  return {
    protocol,
    requestAccepted: true,
    ...(binding
      ? {
          owner: { ...binding.owner },
          expectedImageParts: binding.expectedImageParts,
          payloadDigest: currentVisual.identities.length > 0
            ? digestVisualPayloadIdentities(currentVisual.identities)
            : logicalImageParts > 0
            ? binding.payloadDigest
            : digestVisualPayloadIdentities([]),
        }
      : {}),
    logicalImageParts,
    serializedImageParts,
    omittedImageParts,
    ...(providerOmittedParts > 0
      ? { omissionReason: "provider_unsupported" }
      : omittedImageParts > 0
      ? { omissionReason: "serialization_omitted_images" }
      : {}),
  };
}

function attachVisualTransportReceipt(
  result: StreamResult,
  messages: ChatMessage[],
  body: Record<string, unknown>,
  protocol: string,
  binding?: VisualTransportRequestBinding,
): StreamResult {
  return {
    ...result,
    visualTransportReceipt: buildVisualTransportReceipt(messages, body, protocol, binding),
  };
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

function isOmlxProvider(settings: StreamSettings): boolean {
  return String(settings.provider || "").trim().toLowerCase() === "omlx";
}

export function buildOpenAiCompatibleReasoningRequestExtras(
  settings: StreamSettings,
): Record<string, unknown> {
  if (settings.reasoningRequest !== "off" || !isOmlxProvider(settings)) return {};
  // oMLX exposes this as a documented ChatCompletionRequest capability. Do
  // not send it to arbitrary OpenAI-compatible endpoints: many reject
  // unknown top-level request keys.
  return { chat_template_kwargs: { enable_thinking: false } };
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

function shouldAttachOpenAiToolChoice(
  settings: StreamSettings,
  tools: ToolDefinition[] | undefined,
  toolChoice: OpenAiToolChoice | undefined,
  minimalCompatibilityMode = false,
): boolean {
  if (!toolChoice || minimalCompatibilityMode) return false;
  if (!tools || tools.length === 0) return false;
  return !isOllamaProvider(settings) &&
    !isAnthropicProvider(settings) &&
    !isGeminiProvider(settings) &&
    shouldSendNativeTools(settings);
}

function applyOpenAiToolChoice(
  body: Record<string, unknown>,
  settings: StreamSettings,
  tools: ToolDefinition[] | undefined,
  toolChoice: OpenAiToolChoice | undefined,
  minimalCompatibilityMode = false,
): void {
  if (!shouldAttachOpenAiToolChoice(settings, tools, toolChoice, minimalCompatibilityMode)) return;
  body.tool_choice = toolChoice;
}

function isTranscriptCompatibilityRequest(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    typeof message.content === "string"
    && message.content.includes(PROVIDER_COMPATIBILITY_TAG)
    && message.content.includes("transcript_mode=true"),
  );
}

function isXmlProviderCompatibilityRequest(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    typeof message.content === "string"
    && message.content.includes(PROVIDER_COMPATIBILITY_TAG)
    && message.content.includes("native_tools_disabled=true"),
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

function createOpenAiResponsesFailureError(payload: unknown): Error {
  const terminal = resolveOpenAiResponsesTerminalState(payload);
  const error = new Error(
    `OPENAI_RESPONSES_FAILED: ${terminal.error || "The provider returned a failed Responses result."}`,
  );
  (error as Error & { code?: string }).code = "OPENAI_RESPONSES_FAILED";
  return error;
}

function isRecoverableRustStreamReadError(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("流读取错误") ||
    normalized.includes("error decoding response body") ||
    normalized.includes("error reading a body from connection") ||
    normalized.includes("error reading response body") ||
    normalized.includes("connection closed before message completed") ||
    normalized.includes("unexpected eof") ||
    normalized.includes("incomplete chunked encoding") ||
    normalized.includes("premature eof") ||
    normalized.includes("premature close") ||
    normalized === "terminated"
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
    normalized.includes("network request failed") ||
    normalized.includes("incomplete chunked encoding") ||
    normalized.includes("connection closed before message completed") ||
    normalized.includes("unexpected eof") ||
    normalized.includes("premature eof") ||
    normalized.includes("premature close") ||
    normalized === "terminated"
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
    const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const cancelProxyRequest = () => {
      invoke("cancel_proxy_request", { requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", cancelProxyRequest, { once: true });
    // Close the check/listener race: cancellation may occur after the initial
    // preflight but before the listener is installed. Rust remembers this
    // request-scoped early cancellation until the matching lease is acquired.
    if (signal?.aborted) {
      signal.removeEventListener("abort", cancelProxyRequest);
      throw createAbortError();
    }
    try {
      result = await invoke<string>("proxy_request", {
        url,
        method: "POST",
        headers,
        body: JSON.stringify(body),
        authMode: settings.authMode,
        tokenRef: settings.tokenRef,
        requestId,
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
      return parseOpenAiResponsesSsePayload(result.replace(/^__CONTENT_TYPE__:.*\n/, ""));
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

  const responseContentType = response.headers.get("content-type") || "";
  if (responseContentType.includes("text/event-stream")) {
    return parseOpenAiResponsesSsePayload(await response.text());
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
  options: StreamRequestOptions = {},
): Promise<StreamResult> {
  const { onToken, onDone, onError } = callbacks;
  const streamStartedAt = Date.now();

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
    let acceptedRequestBody: Record<string, unknown> | null = null;
    let acceptedRequestProtocol = isGemini ? "gemini" : apiFormat === "responses"
      ? "openai_responses"
      : "openai_chat_completions";

    if (isGemini) {
      const requestBody = geminiRequest?.body ?? {};
      payload = await postJsonRequest(
        apiUrl,
        headers,
        requestBody,
        settings,
        signal,
      );
      acceptedRequestBody = requestBody;
    } else if (apiFormat === "responses") {
      const shouldIncludeTools = !minimalCompatibilityMode && shouldSendNativeTools(settings);
      const usesXmlToolProtocol =
        normalizeCloudToolProtocol(settings.toolProtocol) === "xml" ||
        isXmlProviderCompatibilityRequest(messages);
      const requestCandidates = buildOpenAiResponsesRequestCandidates({
        messages: messages as ProtocolChatMessage[],
        model: settings.model,
        tools,
        disableResponseStorage: settings.disableResponseStorage,
        reasoningEffort: settings.reasoningEffort,
        compact: true,
        includeTools: shouldIncludeTools,
        toolProtocol: usesXmlToolProtocol
          ? "xml"
          : shouldIncludeTools && (tools?.length || 0) > 0
          ? "native"
          : "none",
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
      let gatewayCompactStructuredCandidate: (typeof requestCandidates)[number] | null = null;
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
          const candidateBody = settings.authMode === "openai_chatgpt_oauth"
            ? ensureOpenAiChatGptCodexRequestBody(candidate.body)
            : candidate.body;
          const candidatePayload = await postJsonRequest(
            apiUrl,
            headers,
            candidateBody,
            settings,
            signal,
          );
          const candidateTerminal = resolveOpenAiResponsesTerminalState(candidatePayload);
          if (candidateTerminal.status === "failed") {
            throw createOpenAiResponsesFailureError(candidatePayload);
          }
          if (candidateTerminal.status === "incomplete" || candidateTerminal.status === "in_progress") {
            payload = candidatePayload;
            acceptedRequestBody = candidateBody;
            emitStreamingConsole(
              "streaming",
              "warn",
              `OpenAI responses ended ${candidateTerminal.status}; preserving partial output as truncated`,
              candidateTerminal.incompleteReason || undefined,
            );
            break;
          }
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
          acceptedRequestBody = candidateBody;
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
                tools,
                disableResponseStorage: settings.disableResponseStorage,
                reasoningEffort: "none",
                compact: true,
                compactionMode: "aggressive",
                includeTools: false,
                toolProtocol: usesXmlToolProtocol ? "xml" : "none",
                targetInputTokens: settings.contextLimit
                  ? Math.min(6000, computeContextBudgets(settings.contextLimit, maxTokens).inputBudget)
                  : 6000,
              });
              const compactStructuredCandidate = gatewayCompactCandidates.find((item) => item.mode === "message_text");
              const compactTranscriptCandidate = gatewayCompactCandidates.find((item) => item.mode === "transcript_text");
              gatewayCompactStructuredCandidate = compactStructuredCandidate || null;
              gatewayCompactTranscriptCandidate = compactTranscriptCandidate || null;
              requestCandidates.splice(
                candidateIndex + 1,
                0,
                ...[gatewayCompactStructuredCandidate, gatewayCompactTranscriptCandidate].filter(
                  (item): item is (typeof requestCandidates)[number] => !!item,
                ),
              );
              emitStreamingConsole(
                "streaming",
                "warn",
                `OpenAI responses retryable gateway failure with ${candidate.mode}; retrying with aggressive compact structured input before transcript fallback`,
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
      const chatBody: Record<string, unknown> = {
        model: settings.model,
        messages: messages.map((message) => {
          const mapped = mapMessageForApi(message, false);
          return mapped.role === "tool"
            ? { role: "user", content: mapped.content }
            : mapped;
        }),
        stream: false,
        ...(!minimalCompatibilityMode && tools && tools.length > 0 ? { tools: normalizeToolDefinitions(tools) } : {}),
        ...(!minimalCompatibilityMode ? { max_tokens: maxTokens } : {}),
        ...(!minimalCompatibilityMode && settings.sendSamplingParameters === true && settings.temperature != null ? { temperature: settings.temperature } : {}),
        ...(!minimalCompatibilityMode && settings.sendSamplingParameters === true && settings.topP != null ? { top_p: settings.topP } : {}),
        ...(!minimalCompatibilityMode ? buildOpenAiCompatibleReasoningRequestExtras(settings) : {}),
      };
      applyOpenAiToolChoice(chatBody, settings, tools, options.toolChoice, minimalCompatibilityMode);
      payload = await postJsonRequest(
        apiUrl,
        headers,
        chatBody,
        settings,
        signal,
      );
      acceptedRequestBody = chatBody;
    }

    const responsesTerminal = !isGemini && apiFormat === "responses"
      ? resolveOpenAiResponsesTerminalState(payload)
      : null;
    if (responsesTerminal?.status === "failed") {
      throw createOpenAiResponsesFailureError(payload);
    }
    const responsesIncomplete = responsesTerminal?.status === "incomplete" || responsesTerminal?.status === "in_progress";
    const content = isGemini ? extractGeminiResponseText(payload) : extractOpenAiResponseText(payload, apiFormat);
    const parsedToolCalls = isGemini
      ? []
      : apiFormat === "chat_completions"
      ? extractOpenAiChatCompletionToolCalls(payload)
      : extractOpenAiResponsesToolCalls(payload);
    // A function call inside an incomplete response may have truncated JSON
    // arguments. Keep it out of the executable tool channel until a completed
    // retry produces a terminal response.
    const toolCalls = responsesIncomplete ? [] : parsedToolCalls;
    const reasoning = !isGemini && apiFormat === "chat_completions"
      ? extractOpenAiChatCompletionReasoning(payload)
      : {};
    const semanticProgress = analyzeSemanticStreamProgress({
      content,
      reasoningContent: reasoning.reasoningContent,
    });
    const completedAt = Date.now();
    const baseResult: StreamResult = {
      content,
      actionableContent: semanticProgress.actionableContent,
      semanticContent: semanticProgress.semanticContent,
      toolCalls,
      finishReason: responsesIncomplete
        ? "length"
        : toolCalls.length > 0
        ? "tool_calls"
        : apiFormat === "chat_completions"
          ? extractOpenAiChatCompletionFinishReason(payload)
          : "stop",
      ...reasoning,
      ...(responsesTerminal && responsesTerminal.status !== "unknown"
        ? {
            responseStatus: responsesTerminal.status,
            ...(responsesTerminal.incompleteReason
              ? { responseIncompleteReason: responsesTerminal.incompleteReason }
              : {}),
          }
        : {}),
      streamDiagnostics: {
        rawContentChars: semanticProgress.rawContentChars,
        reasoningChars: semanticProgress.reasoningChars,
        semanticVisibleChars: semanticProgress.semanticVisibleChars,
        mirrorKind: semanticProgress.mirrorKind,
        overlapRatio: semanticProgress.overlapRatio,
        contentHash: semanticProgress.contentHash,
        reasoningHash: semanticProgress.reasoningHash,
        normalizedContentHash: semanticProgress.normalizedContentHash,
        normalizedReasoningHash: semanticProgress.normalizedReasoningHash,
        firstSemanticVisibleElapsedMs: semanticProgress.semanticVisibleChars > 0
          ? Math.max(0, completedAt - streamStartedAt)
          : null,
        firstToolElapsedMs: toolCalls.length > 0
          ? Math.max(0, completedAt - streamStartedAt)
          : null,
      },
      ...(extractProviderTokenUsage(payload) ? { usage: extractProviderTokenUsage(payload) } : {}),
    };
    const result = acceptedRequestBody
      ? attachVisualTransportReceipt(
          baseResult,
          messages,
          acceptedRequestBody,
          acceptedRequestProtocol,
          options.visualTransportBinding,
        )
      : baseResult;

    const displayContent = semanticProgress.mirrorKind === "none"
      ? content
      : semanticProgress.semanticContent;
    if (displayContent) onToken(displayContent);
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
  options: StreamRequestOptions = {},
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
          ...buildOpenAiCompatibleReasoningRequestExtras(settings),
        };

  if (tools && tools.length > 0 && !isOllama && !isAnthropic && !isGemini && shouldSendNativeTools(settings)) {
    body.tools = normalizeToolDefinitions(tools);
  }
  applyOpenAiToolChoice(body, settings, tools, options.toolChoice);
  const visualProtocol = isOllama
    ? "ollama"
    : isAnthropic
    ? "anthropic"
    : isGemini
    ? "gemini"
    : "openai_chat_completions";

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
      const result = attachVisualTransportReceipt({
        content,
        toolCalls: [],
        finishReason: "stop",
        ...(extractProviderTokenUsage(payload) ? { usage: extractProviderTokenUsage(payload) } : {}),
      }, messages, body, visualProtocol, options.visualTransportBinding);
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
  const STREAM_PROGRESS_LIFECYCLE_INTERVAL_MS = 5_000;
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
  let providerTokenUsage: StreamResult["usage"] | undefined;
  let semanticProgress = analyzeSemanticStreamProgress({ content: "", reasoningContent: "" });
  let firstSemanticVisibleAt: number | null = null;
  let firstToolAt: number | null = null;
  let emittedMirrorSemanticContent = "";
  let finishReason: "stop" | "length" | "tool_calls" | null = null;
  const toolCallsMap = new Map<number, StreamedToolCall>();

  let unlistenChunk: UnlistenFn | null = null;
  let unlistenDone: UnlistenFn | null = null;
  let noProgressInterval: ReturnType<typeof setInterval> | null = null;
  let abortSignalHandler: (() => void) | null = null;
  let startStreamInvoked = false;
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

  const refreshSemanticProgress = () => {
    semanticProgress = analyzeSemanticStreamProgress({
      content: fullContent,
      reasoningContent: providerReasoningContent,
    });
    if (semanticProgress.semanticVisibleChars > 0 && firstSemanticVisibleAt === null) {
      firstSemanticVisibleAt = Date.now();
    }
  };

  const buildSemanticDiagnostics = (): StreamSemanticDiagnostics => ({
    rawContentChars: semanticProgress.rawContentChars,
    reasoningChars: semanticProgress.reasoningChars,
    semanticVisibleChars: semanticProgress.semanticVisibleChars,
    mirrorKind: semanticProgress.mirrorKind,
    overlapRatio: semanticProgress.overlapRatio,
    contentHash: semanticProgress.contentHash,
    reasoningHash: semanticProgress.reasoningHash,
    normalizedContentHash: semanticProgress.normalizedContentHash,
    normalizedReasoningHash: semanticProgress.normalizedReasoningHash,
    firstSemanticVisibleElapsedMs: firstSemanticVisibleAt === null
      ? null
      : Math.max(0, firstSemanticVisibleAt - streamStartedAt),
    firstToolElapsedMs: firstToolAt === null
      ? null
      : Math.max(0, firstToolAt - streamStartedAt),
  });

  const emitContentForDisplay = (rawDelta: string) => {
    if (!rawDelta) return;
    if (semanticProgress.mirrorKind === "none") {
      onToken(rawDelta);
      return;
    }
    const nextSemantic = semanticProgress.semanticContent;
    const semanticDelta = nextSemantic.startsWith(emittedMirrorSemanticContent)
      ? nextSemantic.slice(emittedMirrorSemanticContent.length)
      : emittedMirrorSemanticContent
        ? ""
        : nextSemantic;
    emittedMirrorSemanticContent = nextSemantic;
    if (semanticDelta) onToken(semanticDelta);
  };

  const buildCurrentOpenAiCompatibleResult = (): StreamResult => attachVisualTransportReceipt({
    content: fullContent,
    actionableContent: semanticProgress.actionableContent,
    semanticContent: semanticProgress.semanticContent,
    toolCalls: finalizeStreamedToolCalls(toolCallsMap),
    finishReason,
    streamDiagnostics: buildSemanticDiagnostics(),
    ...(providerTokenUsage ? { usage: providerTokenUsage } : {}),
    ...(providerReasoningContent.trim()
      ? {
          reasoningContent: providerReasoningContent,
          ...(providerReasoningField ? { reasoningField: providerReasoningField } : {}),
        }
      : {}),
  }, messages, body, visualProtocol, options.visualTransportBinding);

  const stopReasoningOnlyRunaway = () => {
    if (resolved || anthropicProcessor) return false;
    if (!shouldStopReasoningOnlyStream({
      reasoningChars: providerReasoningContent.length,
      visibleChars: semanticProgress.semanticVisibleChars,
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
    invoke("cancel_chat_stream", { streamId }).catch(() => {});
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
      visibleChars: semanticProgress.semanticVisibleChars,
      toolCallCount: toolCallsMap.size,
      reasoningChars: providerReasoningContent.length,
    })) {
      return false;
    }

    resolved = true;
    finishReason = "length";
    closeReasoningBlock();
    reasoningBuffer = "";
    const message = `STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream produced chunks for ${elapsedMs}ms without semantic-visible output or tool calls.`;
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
    invoke("cancel_chat_stream", { streamId }).catch(() => {});
    const error = new Error(message);
    onError(error);
    rejectResult?.(error);
    cleanup();
    return true;
  };

  const stopVisibleTextRepetition = () => {
    if (resolved || anthropicProcessor || toolCallsMap.size > 0) return false;
    const match = detectVisibleTextRepetition(semanticProgress.semanticContent);
    if (!match) return false;

    resolved = true;
    finishReason = "length";
    closeReasoningBlock();
    const error = createVisibleTextRepetitionError(match);
    emitStreamingConsole(
      "streaming",
      "warn",
      "Visible stream repetition detected; cancelling before further duplicate output.",
      match,
    );
    callbacks.onLifecycle?.({
      phase: "stream_error",
      streamId,
      elapsedMs: Date.now() - streamStartedAt,
      chunkCount: rustProxyChunkCount,
      byteCount: rustProxyByteCount,
      status: "visible_text_repetition",
      error: error.message,
    });
    invoke("cancel_chat_stream", { streamId }).catch(() => {});
    onToken("__ESCALATION_RESET__:");
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
          providerTokenUsage = extractProviderTokenUsage(json) || providerTokenUsage;
          if (json.done) { finishReason = "stop"; continue; }
          const contentDelta = json.message?.content ?? "";
          if (contentDelta) {
            fullContent += contentDelta;
            refreshSemanticProgress();
            if (stopVisibleTextRepetition()) return;
            emitContentForDisplay(contentDelta);
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
          providerTokenUsage = extractProviderTokenUsage(json) || providerTokenUsage;
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
            refreshSemanticProgress();
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
                invoke("cancel_chat_stream", { streamId }).catch(() => {});
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
            refreshSemanticProgress();
            if (stopVisibleTextRepetition()) return;
            emitContentForDisplay(textDelta);
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
              if (firstToolAt === null) firstToolAt = Date.now();
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
    if (signal && abortSignalHandler) {
      signal.removeEventListener("abort", abortSignalHandler);
      abortSignalHandler = null;
    }
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
                options,
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
          ? attachVisualTransportReceipt(
              anthropicProcessor.getResult(),
              messages,
              body,
              visualProtocol,
              options.visualTransportBinding,
            )
          : buildCurrentOpenAiCompatibleResult();
        onDone(result);
        resolveResult?.(result);
      }

      cleanup();
    }),
  ]);

  unlistenChunk = chunkUnlisten;
  unlistenDone = doneUnlisten;

  // Install cancellation before dispatching start_chat_stream. Tauri commands
  // can be scheduled independently, so Rust also keeps an early-cancel
  // tombstone for this exact streamId until the stream lease is registered.
  if (signal) {
    abortSignalHandler = () => {
      if (resolved) return;
      resolved = true;
      if (startStreamInvoked) {
        invoke("cancel_chat_stream", { streamId }).catch(() => {});
      }
      callbacks.onLifecycle?.({
        phase: "stream_cancelled",
        streamId,
        elapsedMs: Date.now() - streamStartedAt,
        chunkCount: rustProxyChunkCount,
        byteCount: rustProxyByteCount,
        status: "cancelled",
      });
      const error = createAbortError();
      onError(error);
      rejectResult?.(error);
      cleanup();
    };
    signal.addEventListener("abort", abortSignalHandler, { once: true });
    if (signal.aborted) {
      abortSignalHandler();
      return resultPromise;
    }
  }

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
  startStreamInvoked = true;
  invoke("start_chat_stream", {
    streamId,
    url: apiUrl,
    headers,
    body: JSON.stringify(body),
    authMode: settings.authMode,
    tokenRef: settings.tokenRef,
    timeoutMs: options.timeoutMs,
  }).catch(err => {
    if (resolved) return;
    resolved = true;
    const error = toError(err, "Failed to start the cloud stream.");
    onError(error);
    rejectResult?.(error);
    cleanup();
  });

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
  options: StreamRequestOptions = {},
): Promise<StreamResult> {
  const isOllama = isOllamaProvider(settings);
  const isAnthropic = isAnthropicProvider(settings);
  const shouldUseNonStreamingOpenAi =
    !isOllama
    && !isAnthropic
    && (isGeminiProvider(settings) || isOpenAiResponsesApi(settings) || isTranscriptCompatibilityRequest(messages));

  if (shouldUseNonStreamingOpenAi) {
    return requestOpenAiNonStreaming(messages, settings, callbacks, signal, maxTokensOverride, tools, options);
  }

  // Route through Rust proxy for cloud endpoints (bypasses CORS)
  if (settings.useRustProxy) {
    emitStreamingConsole("streaming", "info", "routing through Rust proxy", {
      url: settings.baseUrl,
      model: settings.model,
    });
    return streamViaRustProxy(messages, settings, callbacks, signal, tools, maxTokensOverride, options);
  }

  const { onToken, onDone, onError } = callbacks;
  const streamStartedAt = Date.now();
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
        ...(options.responseFormat ? { format: options.responseFormat } : {}),
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
          ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
          ...buildOpenAiCompatibleReasoningRequestExtras(settings),
        };

  // Include tools if provided (native function calling) — only for non-Ollama
  if (tools && tools.length > 0 && !isOllama && !isAnthropic && !isGemini && shouldSendNativeTools(settings)) {
    body.tools = normalizeToolDefinitions(tools);
  }
  applyOpenAiToolChoice(body, settings, tools, options.toolChoice);
  const visualProtocol = isOllama
    ? "ollama"
    : isAnthropic
    ? "anthropic"
    : isGemini
    ? "gemini"
    : "openai_chat_completions";

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
      const result = attachVisualTransportReceipt({
        content,
        toolCalls: [],
        finishReason: "stop",
        ...(extractProviderTokenUsage(payload) ? { usage: extractProviderTokenUsage(payload) } : {}),
      }, messages, body, visualProtocol, options.visualTransportBinding);
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
        options,
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
      errorBody.includes("context length") ||
      errorBody.includes("token limit") ||
      errorBody.includes("prefill memory guard") ||
      errorBody.includes("context too large");

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
  let providerTokenUsage: StreamResult["usage"] | undefined;
  let semanticProgress = analyzeSemanticStreamProgress({ content: "", reasoningContent: "" });
  let firstSemanticVisibleAt: number | null = null;
  let firstToolAt: number | null = null;
  let emittedMirrorSemanticContent = "";

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

  const refreshSemanticProgress = () => {
    semanticProgress = analyzeSemanticStreamProgress({
      content: fullContent,
      reasoningContent: providerReasoningContent,
    });
    if (semanticProgress.semanticVisibleChars > 0 && firstSemanticVisibleAt === null) {
      firstSemanticVisibleAt = Date.now();
    }
  };

  const buildSemanticDiagnostics = (): StreamSemanticDiagnostics => ({
    rawContentChars: semanticProgress.rawContentChars,
    reasoningChars: semanticProgress.reasoningChars,
    semanticVisibleChars: semanticProgress.semanticVisibleChars,
    mirrorKind: semanticProgress.mirrorKind,
    overlapRatio: semanticProgress.overlapRatio,
    contentHash: semanticProgress.contentHash,
    reasoningHash: semanticProgress.reasoningHash,
    normalizedContentHash: semanticProgress.normalizedContentHash,
    normalizedReasoningHash: semanticProgress.normalizedReasoningHash,
    firstSemanticVisibleElapsedMs: firstSemanticVisibleAt === null
      ? null
      : Math.max(0, firstSemanticVisibleAt - streamStartedAt),
    firstToolElapsedMs: firstToolAt === null
      ? null
      : Math.max(0, firstToolAt - streamStartedAt),
  });

  const emitContentForDisplay = (rawDelta: string) => {
    if (!rawDelta) return;
    if (semanticProgress.mirrorKind === "none") {
      onToken(rawDelta);
      return;
    }
    const nextSemantic = semanticProgress.semanticContent;
    const semanticDelta = nextSemantic.startsWith(emittedMirrorSemanticContent)
      ? nextSemantic.slice(emittedMirrorSemanticContent.length)
      : emittedMirrorSemanticContent
        ? ""
        : nextSemantic;
    emittedMirrorSemanticContent = nextSemantic;
    if (semanticDelta) onToken(semanticDelta);
  };

  // Accumulate tool calls across deltas, keyed by index
  const toolCallsMap = new Map<number, StreamedToolCall>();

  const buildCurrentOpenAiCompatibleResult = (): StreamResult => attachVisualTransportReceipt({
    content: fullContent,
    actionableContent: semanticProgress.actionableContent,
    semanticContent: semanticProgress.semanticContent,
    toolCalls: finalizeStreamedToolCalls(toolCallsMap),
    finishReason,
    streamDiagnostics: buildSemanticDiagnostics(),
    ...(providerTokenUsage ? { usage: providerTokenUsage } : {}),
    ...(providerReasoningContent.trim()
      ? {
          reasoningContent: providerReasoningContent,
          ...(providerReasoningField ? { reasoningField: providerReasoningField } : {}),
        }
      : {}),
  }, messages, body, visualProtocol, options.visualTransportBinding);

  const throwIfVisibleTextRepetition = () => {
    if (toolCallsMap.size > 0) return;
    const match = detectVisibleTextRepetition(semanticProgress.semanticContent);
    if (!match) return;
    const error = createVisibleTextRepetitionError(match);
    emitStreamingConsole(
      "streaming",
      "warn",
      "Visible stream repetition detected; cancelling before further duplicate output.",
      match,
    );
    onToken("__ESCALATION_RESET__:");
    reader.cancel().catch(() => {});
    throw Object.assign(error, { _visibleTextRepetitionAbort: true });
  };

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
            providerTokenUsage = extractProviderTokenUsage(json) || providerTokenUsage;
            if (json.done) {
              finishReason = "stop";
              continue;
            }

            const contentDelta = json.message?.content ?? "";
            if (contentDelta) {
              fullContent += contentDelta;
              refreshSemanticProgress();
              throwIfVisibleTextRepetition();
              emitContentForDisplay(contentDelta);
            }
          } catch (error) {
            if (error && (error as any)._visibleTextRepetitionAbort) throw error;
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
            providerTokenUsage = extractProviderTokenUsage(json) || providerTokenUsage;
            const extracted = extractOpenAiCompatibleDelta(json);

            // Handle reasoning_content from thinking models (Qwen3.5, DeepSeek-R1, etc.)
            // Buffer tokens until we can verify they're not garbled "?" output
            const resolvedReasoning = resolveOpenAiCompatibleReasoningDelta(extracted, emittedOpenAiCompatibleReasoning);
            emittedOpenAiCompatibleReasoning = resolvedReasoning.emittedText;
            const reasoningDelta = resolvedReasoning.delta;
            if (reasoningDelta && !reasoningGarbled) {
              providerReasoningContent += reasoningDelta;
              providerReasoningField = providerReasoningField ?? extracted.reasoningField;
              refreshSemanticProgress();
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
              refreshSemanticProgress();
              throwIfVisibleTextRepetition();
              emitContentForDisplay(textDelta);
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
                if (firstToolAt === null) firstToolAt = Date.now();
              }
            }
            if (shouldStopReasoningOnlyStream({
              reasoningChars: providerReasoningContent.length,
              visibleChars: semanticProgress.semanticVisibleChars,
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
            const elapsedMs = Date.now() - streamStartedAt;
            if (shouldStopNoVisibleStreamStall({
              elapsedMs,
              visibleChars: semanticProgress.semanticVisibleChars,
              toolCallCount: toolCallsMap.size,
              reasoningChars: providerReasoningContent.length,
            })) {
              await reader.cancel().catch(() => {});
              throw Object.assign(new Error(
                `STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream produced chunks for ${elapsedMs}ms without semantic-visible output or tool calls.`,
              ), { _semanticProgressAbort: true });
            }
          } catch (e) {
            // Re-throw garbled-reasoning abort — must not be swallowed
            if (e && ((e as any)._garbledAbort || (e as any)._semanticProgressAbort || (e as any)._visibleTextRepetitionAbort)) throw e;
            // malformed SSE chunk — skip
          }
        }
      }
    }
  } catch (err) {
    if (
      (err as Error).name !== "AbortError" &&
      isLocalProfile(settings) &&
      isRecoverableFrontendTransportError(err)
    ) {
      const normalizedError = toError(err, "Streaming request failed.");
      emitStreamingConsole("streaming", "warn", "frontend response body ended early; retrying once through Rust proxy", {
        url: apiUrl,
        model: settings.model,
        error: normalizedError.message,
      });
      callbacks.onLifecycle?.({
        phase: "stream_error",
        status: "frontend_body_retry_rust_proxy",
        error: normalizedError.message,
      });
      await reader.cancel().catch(() => {});
      onToken("__ESCALATION_RESET__:");
      return streamViaRustProxy(
        messages,
        { ...settings, useRustProxy: true },
        callbacks,
        signal,
        tools,
        maxTokensOverride,
        options,
      );
    }
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
          refreshSemanticProgress();
          emitContentForDisplay(json.message.content);
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
            refreshSemanticProgress();
          }
          const resolvedText = resolveOpenAiCompatibleTextDelta(extracted, emittedOpenAiCompatibleText);
          emittedOpenAiCompatibleText = resolvedText.emittedText;
          const contentDelta = resolvedText.delta;
          if (contentDelta) {
            fullContent += contentDelta;
            refreshSemanticProgress();
            emitContentForDisplay(contentDelta);
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
    ? attachVisualTransportReceipt(
        anthropicProcessor.getResult(),
        messages,
        body,
        visualProtocol,
        options.visualTransportBinding,
      )
    : buildCurrentOpenAiCompatibleResult();

  if (result.finishReason === "length") {
    emitStreamingConsole("streaming", "warn", `Response truncated — finish_reason is "length". Consider increasing max_tokens.`);
  }

  onDone(result);
  return result;
}
