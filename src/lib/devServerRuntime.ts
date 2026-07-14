import type { PlanExecutionEvidenceEntry } from "./workflowModels";
import { resolvePtyForegroundState } from "./ptyCommandRuntime";

export type PtyObservationStatus = "unknown" | "running" | "ready" | "failed" | "stopped";

export interface PtyObservationAnalysis {
  status: PtyObservationStatus;
  url?: string;
  text: string;
}

const LOCAL_DEV_SERVER_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s'"`<>()\]}]*)?/gi;
const READY_MARKER_RE = /(?:\bready\s+in\b|\blocal:\s*https?:\/\/|\blistening\s+(?:at|on)\b|\bserver\s+(?:is\s+)?(?:ready|running|started)\b|\bdev\s+server\s+(?:is\s+)?(?:ready|running|started)\b|\bcompiled\s+successfully\b|\brunning\s+[`'"].*?(?:target\/debug|target\/release)|\bapplication\s+started\b)/i;
const WAITING_MARKER_RE = /(?:waiting\s+for\s+your\s+frontend\s+dev\s+server|still\s+waiting|starting\s+development\s+server)/i;
const FAILURE_MARKER_RE = /(?:could\s+not\s+connect|connection\s+refused|address\s+already\s+in\s+use|command\s+not\s+found|failed\s+to\s+(?:start|compile|build|connect)|timed?\s*out|exited?\s+with\s+(?:code|status)\s*[1-9]\d*|\b(?:error|fatal):)/i;

function normalizeLocalDevServerUrl(value: string): string {
  return value.replace(/[.,;:!?]+$/g, "");
}

export function extractLocalDevServerUrls(value: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of String(value || "").matchAll(LOCAL_DEV_SERVER_URL_RE)) {
    const url = normalizeLocalDevServerUrl(String(match[0] || ""));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function parsePtyPayload(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function collectPtyText(raw: string, parsed: Record<string, unknown> | null): string {
  if (!parsed) return raw;
  return [parsed.output, parsed.text, parsed.tail, parsed.stdout, parsed.stderr]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

function lastMarkerIndex(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  let latest = -1;
  for (const match of text.matchAll(globalPattern)) latest = match.index ?? latest;
  return latest;
}

export function analyzePtyObservationResult(value: string): PtyObservationAnalysis {
  const raw = String(value || "");
  const parsed = parsePtyPayload(raw);
  const text = collectPtyText(raw, parsed);
  const urls = extractLocalDevServerUrls(text);
  const readyIndex = lastMarkerIndex(text, READY_MARKER_RE);
  const waitingIndex = lastMarkerIndex(text, WAITING_MARKER_RE);
  const failureIndex = lastMarkerIndex(text, FAILURE_MARKER_RE);
  const running = parsed?.running === true;
  const active = parsed?.active === true || running;
  const exitCode = typeof parsed?.exitCode === "number" ? parsed.exitCode : null;
  // read_pty_since/read_pty_tail return structured output objects, but they do
  // not own process lifecycle state. Treating their missing active/running
  // fields as false turns a valid "VITE ready" observation into "stopped".
  const hasLifecycleState = Boolean(parsed) && (
    typeof parsed?.active === "boolean" ||
    typeof parsed?.running === "boolean" ||
    typeof parsed?.foregroundState === "string" ||
    typeof parsed?.pid === "number" ||
    typeof parsed?.foregroundPid === "number" ||
    typeof parsed?.shellAvailable === "boolean" ||
    typeof parsed?.exitCode === "number"
  );
  const foregroundState = parsed && hasLifecycleState
    ? resolvePtyForegroundState({
      active,
      running,
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      foregroundPid: typeof parsed.foregroundPid === "number" ? parsed.foregroundPid : null,
      shellAvailable: typeof parsed.shellAvailable === "boolean" ? parsed.shellAvailable : undefined,
      foregroundState: typeof parsed.foregroundState === "string"
        ? parsed.foregroundState as "busy" | "idle" | "unknown" | "stopped"
        : undefined,
    })
    : "unknown";

  // Terminal tails can contain old failures followed by a later successful
  // restart. The newest semantic marker owns the observation state.
  if (failureIndex >= 0 && failureIndex >= readyIndex && failureIndex >= waitingIndex) {
    return { status: "failed", url: urls[urls.length - 1], text };
  }
  // The PTY login shell can remain alive after the managed foreground process
  // exits. Only explicit idle/stopped ownership proves that the server ended;
  // unsupported foreground inspection remains unknown on Windows.
  if (foregroundState === "idle" || foregroundState === "stopped") {
    return { status: "stopped", url: urls[urls.length - 1], text };
  }
  if (readyIndex >= 0 && readyIndex > failureIndex && readyIndex >= waitingIndex) {
    return { status: "ready", url: urls[urls.length - 1], text };
  }
  if (waitingIndex >= 0 && waitingIndex > failureIndex && waitingIndex > readyIndex) {
    return { status: "running", url: urls[urls.length - 1], text };
  }
  if (foregroundState === "busy" || foregroundState === "unknown" || running || active) {
    return { status: "running", url: urls[urls.length - 1], text };
  }
  if (exitCode !== null || parsed?.running === false || parsed?.active === false) {
    return { status: exitCode === 0 ? "stopped" : "failed", url: urls[urls.length - 1], text };
  }
  return { status: "unknown", url: urls[urls.length - 1], text };
}

export function resolveLatestObservedDevServerUrl(
  ledger: PlanExecutionEvidenceEntry[],
): string | null {
  let latestReadyIndex = -1;
  let latestReadyUrl: string | null = null;
  let latestPendingCommandIndex = -1;

  ledger.forEach((entry, index) => {
    if (entry.sourceTool === "execute_command" && entry.observationStatus === "pending") {
      latestPendingCommandIndex = index;
    }
    if (entry.kind === "dev_server_url" && entry.observationStatus === "ready") {
      latestReadyIndex = index;
      const urls = extractLocalDevServerUrls(entry.value);
      latestReadyUrl = urls[urls.length - 1] || entry.value;
    }
  });

  return latestReadyUrl && latestReadyIndex > latestPendingCommandIndex
    ? latestReadyUrl
    : null;
}

export function resolveDevServerRuntimeObservation(
  ledger: PlanExecutionEvidenceEntry[],
): { status: "none" | "pending" | PtyObservationStatus; url: string | null } {
  let status: "none" | "pending" | PtyObservationStatus = "none";
  let url: string | null = null;
  for (const entry of ledger) {
    if (entry.sourceTool === "execute_command" && entry.observationStatus === "pending") {
      status = "pending";
      url = null;
      continue;
    }
    if (
      entry.observationStatus &&
      ["read_pty_buffer", "read_pty_tail", "read_pty_since", "get_pty_status"].includes(entry.sourceTool)
    ) {
      // An observation without a readiness/failure marker is inconclusive. It
      // must not erase a pending launch or a known running state and thereby
      // release browser validation against a guessed localhost port.
      if (entry.observationStatus === "unknown" && status !== "none" && status !== "unknown") {
        continue;
      }
      status = entry.observationStatus;
      if (entry.observationStatus === "ready") {
        url = extractLocalDevServerUrls(entry.value)[0] || url;
      } else if (entry.observationStatus === "failed" || entry.observationStatus === "stopped") {
        url = null;
      }
    }
  }
  return { status, url };
}

function localUrlOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function reconcileBrowserValidationUrl(input: {
  requestedUrl: string;
  observedUrl: string | null;
}): { url: string; corrected: boolean } {
  const requested = String(input.requestedUrl || "").trim();
  const observed = String(input.observedUrl || "").trim();
  const requestedOrigin = localUrlOrigin(requested);
  const observedOrigin = localUrlOrigin(observed);
  if (!requestedOrigin || !observedOrigin || requestedOrigin === observedOrigin) {
    return { url: requested, corrected: false };
  }

  try {
    const requestedParsed = new URL(requested);
    const observedParsed = new URL(observed);
    observedParsed.pathname = requestedParsed.pathname || observedParsed.pathname;
    observedParsed.search = requestedParsed.search;
    observedParsed.hash = requestedParsed.hash;
    return { url: observedParsed.toString(), corrected: true };
  } catch {
    return { url: observed, corrected: true };
  }
}

export function resolveBrowserValidationPreflight(input: {
  requestedUrl: string;
  ledger: PlanExecutionEvidenceEntry[];
}): {
  action: "allow" | "block" | "correct";
  url: string;
  runtimeStatus: "none" | "pending" | PtyObservationStatus;
} {
  const observation = resolveDevServerRuntimeObservation(input.ledger);
  if (
    observation.url === null &&
    ["pending", "running", "failed", "stopped"].includes(observation.status)
  ) {
    return {
      action: "block",
      url: input.requestedUrl,
      runtimeStatus: observation.status,
    };
  }
  const corrected = reconcileBrowserValidationUrl({
    requestedUrl: input.requestedUrl,
    observedUrl: resolveLatestObservedDevServerUrl(input.ledger),
  });
  return {
    action: corrected.corrected ? "correct" : "allow",
    url: corrected.url,
    runtimeStatus: observation.status,
  };
}
