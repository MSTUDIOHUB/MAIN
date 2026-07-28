import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type DebugLogLevel = "debug" | "info" | "warn" | "error";

export interface DebugLogEntry {
  timestamp: string;
  level: DebugLogLevel | string;
  source: string;
  message: string;
}

export interface DebugLogSnapshot {
  path: string;
  content: string;
  truncated: boolean;
}

const STORAGE_KEY = "main.debugLog.v1";
// The native log is the durable desktop record. This browser ring only backs
// diagnostics when IPC is unavailable and must stay small enough that a busy
// agent cannot make localStorage serialization block the UI thread.
const MAX_LOCAL_ENTRIES = 160;
const LOCAL_LOG_FLUSH_DELAY_MS = 40;

let captureInstalled = false;
let rustLogUnlisten: UnlistenFn | null = null;
let performanceDiagnosticsInstalled = false;
let localEntriesCache: DebugLogEntry[] | null = null;
let localEntriesSerialized: string | null = null;
let localEntriesDirty = false;
let localLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
const DEBUG_LOG_BOOT_TIME = typeof performance !== "undefined" ? performance.now() : Date.now();

interface DebugLogWindow extends Window {
  __MAIN_DEBUG_LOG_CAPTURE_INSTALLED__?: boolean;
  __MAIN_NATIVE_CONSOLE__?: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

const debugWindow = typeof window !== "undefined" ? (window as DebugLogWindow) : null;
const nativeConsole = debugWindow?.__MAIN_NATIVE_CONSOLE__ ?? {
  debug: console.debug.bind(console) as (...args: unknown[]) => void,
  info: console.info.bind(console) as (...args: unknown[]) => void,
  log: console.log.bind(console) as (...args: unknown[]) => void,
  warn: console.warn.bind(console) as (...args: unknown[]) => void,
  error: console.error.bind(console) as (...args: unknown[]) => void,
};
if (debugWindow && !debugWindow.__MAIN_NATIVE_CONSOLE__) {
  debugWindow.__MAIN_NATIVE_CONSOLE__ = nativeConsole;
}

function toIsoTimestamp() {
  return new Date().toISOString();
}

const SECRET_DEBUG_KEYS = new Set([
  "authorization",
  "apikey",
  "xapikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "password",
  "secret",
  "clientsecret",
]);

function isSecretDebugKey(key: string): boolean {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SECRET_DEBUG_KEYS.has(normalized) ||
    normalized.startsWith("authorization") ||
    normalized.includes("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret");
}

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[\w.+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/("(?:authorization|api[-_]?key|x-api-key|token|password|secret)"\s*:\s*)"[^"]*"/gi, "$1\"[REDACTED]\"")
    .replace(/((?:authorization|api[-_]?key|x-api-key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function stableDebugHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function compactDebugString(value: string, maxChars = 900): string {
  const normalized = redactSecrets(value)
    .replace(/\[MAIN_TOOL_FEEDBACK_V1\]\{[^\n]*\}/g, "[tool-feedback-envelope]")
    .replace(/READ_FILE_RESULT[\s\S]{300,}/gi, "READ_FILE_RESULT...[digest-truncated]")
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, "<tool_use>...[tool-call-template]</tool_use>")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trim()}...<chars:${normalized.length};hash:${stableDebugHash(normalized)}>`;
}

function summarizeStringArray(values: unknown[], maxItems = 12): string[] {
  return values
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, maxItems)
    .map((item) => compactDebugString(item, 180));
}

function summarizeMessageArray(messages: unknown[]): Record<string, unknown> {
  const roles: Record<string, number> = {};
  let textChars = 0;
  let hiddenReasoningChars = 0;
  let toolCallMessages = 0;
  let toolResultMessages = 0;
  const largest: Array<{ index: number; role: string; chars: number; hash: string }> = [];

  messages.forEach((item, index) => {
    const message = item as any;
    const role = String(message?.role || "unknown");
    roles[role] = (roles[role] || 0) + 1;
    const content = typeof message?.content === "string" ? message.content : stringifyArg(message?.content ?? "");
    const chars = content.length;
    textChars += chars;
    if (typeof message?.reasoning === "string") hiddenReasoningChars += message.reasoning.length;
    if (typeof message?.reasoning_content === "string") hiddenReasoningChars += message.reasoning_content.length;
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) toolCallMessages += 1;
    if (role === "tool") toolResultMessages += 1;
    largest.push({ index, role, chars, hash: stableDebugHash(content) });
  });

  largest.sort((left, right) => right.chars - left.chars);
  return {
    count: messages.length,
    roles,
    textChars,
    estimatedTokens: Math.ceil(textChars / 4),
    hiddenReasoningChars,
    toolCallMessages,
    toolResultMessages,
    largestMessages: largest.slice(0, 5),
  };
}

function summarizeToolResultLike(value: Record<string, unknown>): Record<string, unknown> | null {
  const name = typeof value.name === "string" ? value.name : typeof value.toolName === "string" ? value.toolName : "";
  const target = typeof value.target === "string" ? value.target : "";
  const content = typeof value.content === "string"
    ? value.content
    : typeof value.result === "string"
    ? value.result
    : typeof value.output === "string"
    ? value.output
    : "";
  if (!name && !target && !content) return null;
  const feedbackStatus = content.match(/\[MAIN_TOOL_FEEDBACK_V1\]\{[^}]*"status"\s*:\s*"([^"]+)"/)?.[1] || null;
  return {
    ...(name ? { name } : {}),
    ...(target ? { target: compactDebugString(target, 180) } : {}),
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
    ...(typeof value.lifecycleState === "string" ? { lifecycleState: value.lifecycleState } : {}),
    ...(feedbackStatus ? { feedbackStatus } : {}),
    contentChars: content.length,
    contentHash: content ? stableDebugHash(content) : null,
    preview: compactDebugString(content, 360),
  };
}

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }
  if (typeof arg === "string") {
    return arg;
  }
  if (arg == null || typeof arg === "number" || typeof arg === "boolean") {
    return String(arg);
  }

  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(arg, (key, value) => {
      if (isSecretDebugKey(key)) {
        return "[REDACTED]";
      }
      if (value && typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    return Object.prototype.toString.call(arg);
  }
}

function summarizeDebugArray(value: unknown[], depth: number): unknown {
  if (value.length === 0) return [];
  const summarizeItem = (item: unknown) => compactDebugValue(item, depth + 1);
  if (value.length <= 8) return value.map(summarizeItem);
  return {
    count: value.length,
    head: value.slice(0, 4).map(summarizeItem),
    tail: value.slice(-2).map(summarizeItem),
  };
}

function compactDebugValue(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return compactDebugString(value.stack || value.message, 1200);
  }
  if (typeof value === "string") {
    return compactDebugString(value, depth === 0 ? 1600 : 900);
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= 4) {
    return `[Object depth-limit hash:${stableDebugHash(stringifyArg(value))}]`;
  }
  if (Array.isArray(value)) {
    return summarizeDebugArray(value, depth);
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const valueRecord = value as Record<string, unknown>;
  const toolResultSummary = summarizeToolResultLike(valueRecord);
  if (toolResultSummary && depth > 0 && ("content" in valueRecord || "result" in valueRecord || "output" in valueRecord)) {
    return toolResultSummary;
  }

  const compacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(valueRecord)) {
    if (isSecretDebugKey(key)) {
      compacted[key] = "[REDACTED]";
      continue;
    }
    if (/^(?:messages|agentMessages|preparedMessages|conversation|history|transcript)$/i.test(key) && Array.isArray(nested)) {
      compacted[key] = summarizeMessageArray(nested);
      continue;
    }
    if (/^(?:tools|llmTools|allTools|toolDefinitions)$/i.test(key) && Array.isArray(nested)) {
      compacted[key] = {
        count: nested.length,
        names: nested
          .map((item) => String((item as any)?.function?.name || (item as any)?.name || ""))
          .filter(Boolean)
          .slice(0, 24),
      };
      continue;
    }
    if (/^(?:availableTools|availableToolNames|toolNames|requestedTools|suppressedToolNames)$/i.test(key) && Array.isArray(nested)) {
      compacted[key] = {
        count: nested.length,
        names: summarizeStringArray(nested, 32),
      };
      continue;
    }
    if (/^(?:toolResults|allResults|results|recentToolActivity)$/i.test(key) && Array.isArray(nested)) {
      compacted[key] = {
        count: nested.length,
        items: nested.slice(-12).map((item) =>
          item && typeof item === "object"
            ? summarizeToolResultLike(item as Record<string, unknown>) ?? compactDebugValue(item, depth + 1)
            : compactDebugValue(item, depth + 1)
        ),
      };
      continue;
    }
    if (/prompt|systemPrompt|content|body|output|stdout|stderr|reasoning|hiddenThought|message/i.test(key) && typeof nested === "string") {
      compacted[key] = compactDebugString(
        nested,
        /prompt|systemPrompt|body|reasoning|hiddenThought/i.test(key) ? 700 : 1000,
      );
      continue;
    }
    compacted[key] = compactDebugValue(nested, depth + 1);
  }
  return compacted;
}

function normalizeMessage(input: unknown): string {
  const compacted = compactDebugValue(input);
  const text = Array.isArray(compacted)
    ? compacted.map(stringifyArg).join(" ")
    : stringifyArg(compacted);
  const redacted = redactSecrets(text);
  return redacted.length > 8_000 ? `${redacted.slice(0, 8_000)}...<truncated>` : redacted;
}

function shouldSkipConsoleLog(level: DebugLogLevel, args: unknown[]): boolean {
  if (level !== "debug") return false;
  const first = typeof args[0] === "string" ? args[0] : "";
  return first.startsWith("[vite]") || first.includes("hot updated:");
}

function classifyConsoleLog(args: unknown[]): {
  source: string;
  messageArgs: unknown[];
  suppressNativeConsole: boolean;
} {
  const first = typeof args[0] === "string" ? args[0] : "";
  const agentMatch = first.match(/^\[agent\.([^\]]+)\]\s*(.*)$/);
  if (agentMatch) {
    const tail = agentMatch[2]?.trim();
    return {
      source: `agent.${agentMatch[1]}`,
      messageArgs: tail ? [tail, ...args.slice(1)] : args.slice(1),
      suppressNativeConsole: true,
    };
  }

  const bracketMatch = first.match(/^\[(orchestrator|streaming|streamViaRustProxy|sendMessage|contextTrim|gitCommitMessage)\]\s*(.*)$/);
  if (bracketMatch) {
    const source = bracketMatch[1] === "sendMessage" ? "store.sendMessage" : bracketMatch[1];
    const tail = bracketMatch[2]?.trim();
    return {
      source,
      messageArgs: tail ? [tail, ...args.slice(1)] : args.slice(1),
      suppressNativeConsole: true,
    };
  }

  if (first.startsWith("Agent loop crashed:")) {
    return {
      source: "store.agent_loop_crashed",
      messageArgs: args,
      suppressNativeConsole: true,
    };
  }

  return {
    source: "console",
    messageArgs: args,
    suppressNativeConsole: false,
  };
}

function readLocalEntries(): DebugLogEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (
      localEntriesCache &&
      (localEntriesDirty || raw === localEntriesSerialized)
    ) {
      return localEntriesCache;
    }
    if (!raw) {
      localEntriesCache = [];
      localEntriesSerialized = null;
      localEntriesDirty = false;
      return localEntriesCache;
    }
    const parsed = JSON.parse(raw);
    localEntriesCache = Array.isArray(parsed)
      ? parsed.slice(-MAX_LOCAL_ENTRIES)
      : [];
    localEntriesSerialized = raw;
    localEntriesDirty = false;
    return localEntriesCache;
  } catch {
    return localEntriesCache || [];
  }
}

function flushLocalEntries() {
  if (localLogFlushTimer) {
    clearTimeout(localLogFlushTimer);
    localLogFlushTimer = null;
  }
  if (!localEntriesDirty || !localEntriesCache) return;
  try {
    const serialized = JSON.stringify(localEntriesCache);
    window.localStorage.setItem(STORAGE_KEY, serialized);
    localEntriesSerialized = serialized;
    localEntriesDirty = false;
  } catch {
    // localStorage can be unavailable in restricted WebView states.
  }
}

function scheduleLocalEntriesFlush() {
  if (localLogFlushTimer) return;
  localLogFlushTimer = setTimeout(() => {
    localLogFlushTimer = null;
    flushLocalEntries();
  }, LOCAL_LOG_FLUSH_DELAY_MS);
}

function writeLocalEntries(entries: DebugLogEntry[]) {
  localEntriesCache = entries.slice(-MAX_LOCAL_ENTRIES);
  localEntriesDirty = true;
  flushLocalEntries();
}

function appendLocalEntry(entry: DebugLogEntry) {
  localEntriesCache = [...readLocalEntries(), entry].slice(-MAX_LOCAL_ENTRIES);
  localEntriesDirty = true;
  if (entry.level === "warn" || entry.level === "error") {
    flushLocalEntries();
  } else {
    scheduleLocalEntriesFlush();
  }
}

function formatEntry(entry: DebugLogEntry): string {
  return `[${entry.timestamp}] [${entry.level}] [${entry.source}] ${entry.message}`;
}

function isRoutineDebugEntry(entry: DebugLogEntry): boolean {
  if (entry.level === "warn" || entry.level === "error") return false;
  const source = String(entry.source || "");
  const message = String(entry.message || "");

  if (
    source === "store.append_agent_message" ||
    source === "store.replace_agent_messages" ||
    source === "stream_chunk_progress" ||
    source === "harness.chunk_progress" ||
    source === "store.stream_first_token" ||
    source === "agent.reasoning_suppressed" ||
    source === "store.reasoning_suppressed" ||
    source === "store.stream_reset" ||
    source === "agent.synthetic_visible_conclusion_suppressed" ||
    source === "agent.tool_action_narration_injected" ||
    source === "agent.plan_runtime_tool_scope_applied" ||
    source === "agent.post_tool_result_continuation"
  ) {
    return true;
  }

  // These are immediately followed by richer lifecycle summaries. Keeping
  // both versions makes a single model iteration look like several distinct
  // events and obscures the actual stop or recovery decision.
  if (
    source === "agent.assistant_completion_classified" ||
    source === "agent.plan_quality_recovery_action" ||
    source === "agent.plan_text_materialization_rejected" ||
    source === "agent.plan_structured_proposal_materialization_rejected"
  ) {
    return true;
  }

  if (
    source === "store.stream_done" &&
    /"truncated":false/i.test(message) &&
    /"truncationReason":null/i.test(message) &&
    /"mirrorKind":"none"/i.test(message)
  ) {
    return true;
  }

  if (
    source === "agent.normalized_turn" &&
    /"replyOptions":0/i.test(message) &&
    /"hasStructuredProposal":false/i.test(message)
  ) {
    return true;
  }

  // `agent.llm_request_shape` already carries the iteration, intent, model,
  // message and tool counts. Keeping the adjacent iteration marker doubles
  // every model step without adding a diagnostic field.
  if (source === "agent.iteration_start") return true;

  if (
    source === "agent.mcp_discovery_start" &&
    /"enabledServers":0/i.test(message)
  ) {
    return true;
  }

  if (
    source === "agent.mcp_discovery_done" &&
    /"discoveryRelevantToTurn":false/i.test(message)
  ) {
    return true;
  }

  if (
    source === "agent.mcp_server_status" &&
    /"discoveryRelevantToTurn":false/i.test(message)
  ) {
    return true;
  }

  if (
    source === "agent.mcp_server_status" &&
    /"requestedUnityRouting":false/i.test(message) &&
    /"requestedGameStudioMcpRouting":false/i.test(message) &&
    /"unityConsoleDiagnosticsRequested":false/i.test(message) &&
    /"state":"disabled"/i.test(message)
  ) {
    return true;
  }

  if (
    source === "agent.mcp_routing" &&
    /"selectedToolCount":0/i.test(message) &&
    /"routingRan":false/i.test(message)
  ) {
    return true;
  }

  if (
    source === "agent.context_pack_built" &&
    /"forceManaged":false/i.test(message) &&
    /"droppedMessageCount":0/i.test(message) &&
    /"microCompactionKind":"none"/i.test(message)
  ) {
    return true;
  }

  if (
    source === "agent.ephemeral_prune_summary" &&
    /"burnedToolResults":0/i.test(message) &&
    /"restoredToolResults":0/i.test(message)
  ) {
    return true;
  }

  if (
    source === "agent.stream_low_content_diagnostic" &&
    /"toolCallCount":0/i.test(message) &&
    /"contentChars":[01](?:,|})/i.test(message)
  ) {
    return true;
  }

  if (source === "streaming" && /routing through Rust proxy/i.test(message)) {
    return true;
  }

  if (source === "delegation_scope_decision" && /"decision":"allowed"/i.test(message)) {
    return true;
  }

  if (
    source === "agent.tool_permission_plan" &&
    /"risk":"read_only"/i.test(message) &&
    /"(?:policy|plannedAction)":"auto_execute"/i.test(message)
  ) {
    return true;
  }

  if (source === "store.status_change" && /"status":"running"/i.test(message)) {
    return true;
  }

  if (source === "streamViaRustProxy" && /invoking start_chat_stream/i.test(message)) {
    return true;
  }

  if (source === "start_chat_stream" && /^first_chunk\b/i.test(message)) {
    return true;
  }

  return false;
}

function elapsedSinceBootMs() {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return Math.round(now - DEBUG_LOG_BOOT_TIME);
}

function estimateLocalStorageBytes() {
  try {
    let total = 0;
    let appStateBytes = 0;
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i) || "";
      const value = window.localStorage.getItem(key) || "";
      const bytes = key.length + value.length;
      total += bytes;
      if (key === "local-agent-ide") {
        appStateBytes = bytes;
      }
    }
    return {
      keys: window.localStorage.length,
      totalApproxBytes: total,
      appStateApproxBytes: appStateBytes,
    };
  } catch {
    return null;
  }
}

function installPerformanceDiagnostics() {
  if (performanceDiagnosticsInstalled || typeof window === "undefined") return;
  performanceDiagnosticsInstalled = true;

  appendDebugLog("info", "app.startup", {
    phase: "debug_capture_installed",
    elapsedMs: elapsedSinceBootMs(),
    readyState: document.readyState,
    localStorage: estimateLocalStorageBytes(),
  });

  let longTaskCount = 0;
  try {
    const PerformanceObserverCtor = window.PerformanceObserver;
    if (PerformanceObserverCtor) {
      const observer = new PerformanceObserverCtor((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < 80 || longTaskCount >= 30) continue;
          longTaskCount++;
          appendDebugLog("warn", "perf.longtask", {
            name: entry.name,
            startTimeMs: Math.round(entry.startTime),
            durationMs: Math.round(entry.duration),
            count: longTaskCount,
          });
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    }
  } catch {
    // Some WebViews may not expose longtask entries.
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      appendDebugLog("info", "app.startup", {
        phase: "second_animation_frame",
        elapsedMs: elapsedSinceBootMs(),
        readyState: document.readyState,
        localStorage: estimateLocalStorageBytes(),
      });
    });
  });

  window.addEventListener("load", () => {
    appendDebugLog("info", "app.startup", {
      phase: "window_load",
      elapsedMs: elapsedSinceBootMs(),
      readyState: document.readyState,
    });
  }, { once: true });
}

export function appendDebugLog(
  level: DebugLogLevel,
  source: string,
  message: unknown,
  options: { persistToRust?: boolean } = {},
) {
  const entry: DebugLogEntry = {
    timestamp: toIsoTimestamp(),
    level,
    source,
    message: normalizeMessage(message),
  };

  if (isRoutineDebugEntry(entry)) return;

  appendLocalEntry(entry);

  if (options.persistToRust === false) return;
  invoke("append_debug_log", {
    level: entry.level,
    source: entry.source,
    message: entry.message,
  }).catch(() => {});
}

export function getLocalDebugLogText() {
  flushLocalEntries();
  return readLocalEntries().map(formatEntry).join("\n");
}

export async function readDebugLogSnapshot(maxBytes = 256 * 1024): Promise<DebugLogSnapshot> {
  try {
    return await invoke<DebugLogSnapshot>("read_debug_log", { maxBytes });
  } catch {
    return {
      path: "localStorage:main.debugLog.v1",
      content: getLocalDebugLogText(),
      truncated: false,
    };
  }
}

export async function clearDebugLog() {
  writeLocalEntries([]);
  await invoke("clear_debug_log").catch(() => {});
}

export async function copyDebugLogToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}

export function installDebugLogCapture() {
  if (captureInstalled || typeof window === "undefined") return;
  const targetWindow = window as DebugLogWindow;
  if (targetWindow.__MAIN_DEBUG_LOG_CAPTURE_INSTALLED__) return;
  captureInstalled = true;
  targetWindow.__MAIN_DEBUG_LOG_CAPTURE_INSTALLED__ = true;
  window.addEventListener("pagehide", flushLocalEntries);

  const wrapConsole = (level: DebugLogLevel, original: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      if (shouldSkipConsoleLog(level, args)) {
        original(...args);
        return;
      }
      const classified = classifyConsoleLog(args);
      if (!classified.suppressNativeConsole) {
        original(...args);
      }
      appendDebugLog(level, classified.source, classified.messageArgs);
    };
  };

  console.debug = wrapConsole("debug", nativeConsole.debug);
  console.info = wrapConsole("info", nativeConsole.info);
  console.log = wrapConsole("info", nativeConsole.log);
  console.warn = wrapConsole("warn", nativeConsole.warn);
  console.error = wrapConsole("error", nativeConsole.error);

  window.addEventListener("error", (event) => {
    appendDebugLog("error", "window.error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error instanceof Error ? event.error.stack || event.error.message : event.error,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    appendDebugLog("error", "window.unhandledrejection", event.reason);
  });

  void listen<DebugLogEntry>("main-debug-log", (event) => {
    const entry = {
      timestamp: String(event.payload.timestamp || toIsoTimestamp()),
      level: (event.payload.level as DebugLogLevel) || "info",
      source: event.payload.source || "rust",
      message: normalizeMessage(event.payload.message || ""),
    };
    if (!isRoutineDebugEntry(entry)) {
      appendLocalEntry(entry);
    }
  })
    .then((unlisten) => {
      rustLogUnlisten = unlisten;
    })
    .catch(() => {});

  appendDebugLog("info", "debugLog", "frontend debug log capture started");
  installPerformanceDiagnostics();
}

export function uninstallDebugLogCaptureForTests() {
  if (rustLogUnlisten) {
    rustLogUnlisten();
    rustLogUnlisten = null;
  }
}
