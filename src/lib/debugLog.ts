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
const MAX_LOCAL_ENTRIES = 500;

let captureInstalled = false;
let rustLogUnlisten: UnlistenFn | null = null;
let performanceDiagnosticsInstalled = false;
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

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[\w.+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/("(?:authorization|api[-_]?key|x-api-key|token|password|secret)"\s*:\s*)"[^"]*"/gi, "$1\"[REDACTED]\"")
    .replace(/((?:authorization|api[-_]?key|x-api-key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
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
      if (/authorization|api[-_]?key|x-api-key|token|password|secret/i.test(key)) {
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

function normalizeMessage(input: unknown): string {
  const text = Array.isArray(input)
    ? input.map(stringifyArg).join(" ")
    : stringifyArg(input);
  const redacted = redactSecrets(text);
  return redacted.length > 8_000 ? `${redacted.slice(0, 8_000)}...<truncated>` : redacted;
}

function shouldSkipConsoleLog(level: DebugLogLevel, args: unknown[]): boolean {
  if (level !== "debug") return false;
  const first = typeof args[0] === "string" ? args[0] : "";
  return first.startsWith("[vite]") || first.includes("hot updated:");
}

function readLocalEntries(): DebugLogEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalEntries(entries: DebugLogEntry[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_LOCAL_ENTRIES)));
  } catch {
    // localStorage can be unavailable in restricted WebView states.
  }
}

function appendLocalEntry(entry: DebugLogEntry) {
  writeLocalEntries([...readLocalEntries(), entry]);
}

function formatEntry(entry: DebugLogEntry): string {
  return `[${entry.timestamp}] [${entry.level}] [${entry.source}] ${entry.message}`;
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

  appendLocalEntry(entry);

  if (options.persistToRust === false) return;
  invoke("append_debug_log", {
    level: entry.level,
    source: entry.source,
    message: entry.message,
  }).catch(() => {});
}

export function getLocalDebugLogText() {
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

  const wrapConsole = (level: DebugLogLevel, original: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      original(...args);
      if (shouldSkipConsoleLog(level, args)) return;
      appendDebugLog(level, "console", args);
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
    appendLocalEntry({
      timestamp: String(event.payload.timestamp || toIsoTimestamp()),
      level: (event.payload.level as DebugLogLevel) || "info",
      source: event.payload.source || "rust",
      message: normalizeMessage(event.payload.message || ""),
    });
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
