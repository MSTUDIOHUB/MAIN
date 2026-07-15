import type { PlanExecutionEvidenceEntry } from "./workflowModels";
import { resolvePtyForegroundState } from "./ptyCommandRuntime";

export type PtyObservationStatus = "unknown" | "running" | "ready" | "failed" | "stopped";

export type DevServerNextCapability = "launch" | "observe_pty" | "browser" | "reconcile";

export interface PtyObservationAnalysis {
  status: PtyObservationStatus;
  url?: string;
  text: string;
  foregroundGeneration?: number;
  outputSequence?: number;
  terminalBusy: boolean;
  portConflict: boolean;
}

export interface DevServerRuntimeState {
  status: "none" | "pending" | PtyObservationStatus;
  url: string | null;
  foregroundGeneration: number | null;
  outputSequence: number | null;
  terminalBusy: boolean;
  portConflict: boolean;
  nextCapability: DevServerNextCapability;
}

export interface PtyCommandFailureSemantics {
  kind: "pty_occupied" | "port_conflict" | "other";
  terminalBusy: boolean;
  portConflict: boolean;
  nextCapability: "observe_pty" | "probe_existing_service" | "launch";
}

const LOCAL_DEV_SERVER_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s'"`<>()\]}]*)?/gi;
const READY_MARKER_RE = /(?:\bready\s+in\b|\blocal:\s*https?:\/\/|\blistening\s+(?:at|on)\b|\bserver\s+(?:is\s+)?(?:ready|running|started)\b|\bdev\s+server\s+(?:is\s+)?(?:ready|running|started)\b|\bcompiled\s+successfully\b|\brunning\s+[`'"].*?(?:target\/debug|target\/release)|\bapplication\s+started\b)/i;
const WAITING_MARKER_RE = /(?:waiting\s+for\s+your\s+frontend\s+dev\s+server|still\s+waiting|starting\s+development\s+server)/i;
const FAILURE_MARKER_RE = /(?:could\s+not\s+connect|connection\s+refused|address\s+already\s+in\s+use|command\s+not\s+found|failed\s+to\s+(?:start|compile|build|connect)|timed?\s*out|exited?\s+with\s+(?:code|status)\s*[1-9]\d*|\b(?:error|fatal):)/i;
const PTY_OCCUPIED_MARKER_RE = /\b(?:PTY_BUSY|PTY_FOREGROUND_UNKNOWN)\b/i;
const PORT_CONFLICT_MARKER_RE = /\b(?:address\s+already\s+in\s+use|EADDRINUSE)\b/i;
const LOCAL_HEALTH_PROBE_RE = /\b(?:curl|wget|http(?:ie)?)\b[\s\S]{0,180}\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?/i;

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

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function resolvePtyRuntimeMetadata(parsed: Record<string, unknown> | null): {
  foregroundGeneration?: number;
  outputSequence?: number;
} {
  if (!parsed) return {};
  const foregroundGeneration = finiteNumber(
    parsed.foregroundGeneration,
    parsed.generation,
  );
  const outputSequence = finiteNumber(
    parsed.endOffset,
    parsed.bufferEndOffset,
    parsed.outputSequence,
    parsed.sequence,
  );
  return {
    ...(foregroundGeneration !== undefined ? { foregroundGeneration } : {}),
    ...(outputSequence !== undefined ? { outputSequence } : {}),
  };
}

/**
 * A busy integrated PTY means that its foreground process is still alive. It
 * is an observation requirement, not proof that the dev-server port is in use
 * and not proof that every command channel is unavailable.
 */
export function classifyPtyCommandFailure(value: string): PtyCommandFailureSemantics {
  const text = String(value || "");
  if (PTY_OCCUPIED_MARKER_RE.test(text)) {
    return {
      kind: "pty_occupied",
      terminalBusy: true,
      portConflict: false,
      nextCapability: "observe_pty",
    };
  }
  if (PORT_CONFLICT_MARKER_RE.test(text)) {
    return {
      kind: "port_conflict",
      terminalBusy: false,
      portConflict: true,
      nextCapability: "probe_existing_service",
    };
  }
  return {
    kind: "other",
    terminalBusy: false,
    portConflict: false,
    nextCapability: "launch",
  };
}

export function isLocalDevServerHealthProbeCommand(value: string): boolean {
  return LOCAL_HEALTH_PROBE_RE.test(String(value || ""));
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
  const occupiedIndex = lastMarkerIndex(text, PTY_OCCUPIED_MARKER_RE);
  const portConflictIndex = lastMarkerIndex(text, PORT_CONFLICT_MARKER_RE);
  const metadata = resolvePtyRuntimeMetadata(parsed);
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
  if (
    occupiedIndex >= 0 &&
    occupiedIndex >= failureIndex &&
    occupiedIndex >= readyIndex &&
    occupiedIndex >= waitingIndex
  ) {
    return {
      status: "running",
      url: urls[urls.length - 1],
      text,
      ...metadata,
      terminalBusy: true,
      portConflict: false,
    };
  }
  if (failureIndex >= 0 && failureIndex >= readyIndex && failureIndex >= waitingIndex) {
    return {
      status: "failed",
      url: urls[urls.length - 1],
      text,
      ...metadata,
      terminalBusy: false,
      portConflict: portConflictIndex >= 0 && portConflictIndex >= readyIndex,
    };
  }
  // The PTY login shell can remain alive after the managed foreground process
  // exits. Only explicit idle/stopped ownership proves that the server ended;
  // unsupported foreground inspection remains unknown on Windows.
  if (foregroundState === "idle" || foregroundState === "stopped") {
    return {
      status: "stopped",
      url: urls[urls.length - 1],
      text,
      ...metadata,
      terminalBusy: false,
      portConflict: false,
    };
  }
  if (readyIndex >= 0 && readyIndex > failureIndex && readyIndex >= waitingIndex) {
    return {
      status: "ready",
      url: urls[urls.length - 1],
      text,
      ...metadata,
      terminalBusy: foregroundState === "busy",
      portConflict: false,
    };
  }
  if (waitingIndex >= 0 && waitingIndex > failureIndex && waitingIndex > readyIndex) {
    return {
      status: "running",
      url: urls[urls.length - 1],
      text,
      ...metadata,
      terminalBusy: foregroundState === "busy" || running || active,
      portConflict: false,
    };
  }
  if (foregroundState === "busy" || foregroundState === "unknown" || running || active) {
    return {
      status: "running",
      url: urls[urls.length - 1],
      text,
      ...metadata,
      terminalBusy: foregroundState === "busy" || running || active,
      portConflict: false,
    };
  }
  if (exitCode !== null || parsed?.running === false || parsed?.active === false) {
    return {
      status: exitCode === 0 ? "stopped" : "failed",
      url: urls[urls.length - 1],
      text,
      ...metadata,
      terminalBusy: false,
      portConflict: false,
    };
  }
  return {
    status: "unknown",
    url: urls[urls.length - 1],
    text,
    ...metadata,
    terminalBusy: false,
    portConflict: false,
  };
}

export function resolveLatestObservedDevServerUrl(
  ledger: PlanExecutionEvidenceEntry[],
): string | null {
  const state = resolveDevServerRuntimeState(ledger);
  return state.status === "ready" ? state.url : null;
}

function observationBelongsToLaunch(
  entry: PlanExecutionEvidenceEntry,
  launch: PlanExecutionEvidenceEntry | null,
): boolean {
  if (!launch) return true;
  if (Number(entry.createdAt || 0) < Number(launch.createdAt || 0)) return false;
  if (
    typeof launch.foregroundGeneration === "number" &&
    entry.foregroundGeneration !== launch.foregroundGeneration
  ) {
    // Once the launch has a generation identity, an unversioned terminal tail
    // is not allowed to prove readiness. It may contain stale ready text from
    // an older foreground process.
    return false;
  }
  return true;
}

export function resolveDevServerRuntimeState(
  ledger: PlanExecutionEvidenceEntry[],
): DevServerRuntimeState {
  let latestLaunch: PlanExecutionEvidenceEntry | null = null;
  let status: DevServerRuntimeState["status"] = "none";
  let url: string | null = null;
  let foregroundGeneration: number | null = null;
  let outputSequence: number | null = null;
  let terminalBusy = false;
  let portConflict = false;

  for (const entry of ledger) {
    if (entry.sourceTool === "execute_command" && entry.observationStatus === "pending") {
      latestLaunch = entry;
      status = "pending";
      url = null;
      foregroundGeneration = entry.foregroundGeneration ?? null;
      outputSequence = entry.outputSequence ?? null;
      terminalBusy = entry.terminalBusy === true;
      portConflict = entry.portConflict === true;
      continue;
    }
    if (entry.sourceTool === "execute_command" && entry.observationStatus === "failed") {
      latestLaunch = entry;
      status = "failed";
      url = null;
      foregroundGeneration = entry.foregroundGeneration ?? foregroundGeneration;
      outputSequence = entry.outputSequence ?? outputSequence;
      terminalBusy = false;
      portConflict = entry.portConflict === true;
      continue;
    }
    if (entry.sourceTool === "execute_command" && entry.observationStatus === "running") {
      // A running execute_command entry is itself a launch boundary. Record it
      // exactly like a pending launch so later PTY observations must match its
      // generation; otherwise an old ready tail can incorrectly validate the
      // newly started server. Readiness is sticky only for PTY observations
      // inside one generation, never across a new execute_command launch.
      latestLaunch = entry;
      status = "running";
      url = null;
      foregroundGeneration = entry.foregroundGeneration ?? null;
      outputSequence = entry.outputSequence ?? null;
      terminalBusy = true;
      portConflict = false;
      continue;
    }
    if (
      entry.sourceTool === "run_command" &&
      entry.observationStatus !== "failed" &&
      status === "failed" &&
      portConflict &&
      isLocalDevServerHealthProbeCommand(entry.value || entry.target || "")
    ) {
      const probeUrls = extractLocalDevServerUrls(entry.value || entry.target || "");
      status = "ready";
      url = probeUrls[probeUrls.length - 1] || url;
      portConflict = false;
      continue;
    }
    if (
      !entry.observationStatus ||
      !["read_pty_buffer", "read_pty_tail", "read_pty_since", "get_pty_status"].includes(entry.sourceTool) ||
      !observationBelongsToLaunch(entry, latestLaunch)
    ) {
      continue;
    }
    if (entry.observationStatus === "unknown" && status !== "none" && status !== "unknown") {
      continue;
    }
    // Readiness is sticky for the current generation. A later incremental
    // observation that merely says the process is still running must not send
    // the lifecycle backwards to starting; only stopped/failed or a new launch
    // can invalidate a ready state.
    status = status === "ready" && entry.observationStatus === "running"
      ? "ready"
      : entry.observationStatus;
    foregroundGeneration = entry.foregroundGeneration ?? foregroundGeneration;
    outputSequence = entry.outputSequence ?? outputSequence;
    terminalBusy = entry.terminalBusy === true || entry.observationStatus === "running";
    portConflict = entry.portConflict === true;
    if (entry.observationStatus === "ready") {
      url = extractLocalDevServerUrls(entry.value)[0] || url;
    } else if (entry.observationStatus === "failed" || entry.observationStatus === "stopped") {
      url = null;
      terminalBusy = false;
    }
  }

  const nextCapability: DevServerNextCapability =
    status === "pending" || status === "running" || status === "unknown"
      ? "observe_pty"
      : status === "ready"
      ? "browser"
      : status === "failed" && portConflict
      ? "reconcile"
      : status === "failed" || status === "stopped" || status === "none"
      ? "launch"
      : "reconcile";
  return {
    status,
    url,
    foregroundGeneration,
    outputSequence,
    terminalBusy,
    portConflict,
    nextCapability,
  };
}

export function resolveDevServerRuntimeObservation(
  ledger: PlanExecutionEvidenceEntry[],
): { status: "none" | "pending" | PtyObservationStatus; url: string | null } {
  const state = resolveDevServerRuntimeState(ledger);
  return { status: state.status, url: state.url };
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
  reason: "PTY_OBSERVATION_REQUIRED" | "DEV_SERVER_PORT_CONFLICT_UNCONFIRMED" | "DEV_SERVER_START_FAILED" | "DEV_SERVER_STOPPED" | null;
  nextCapability: DevServerNextCapability;
} {
  const observation = resolveDevServerRuntimeState(input.ledger);
  if (
    observation.url === null &&
    ["pending", "running", "failed", "stopped"].includes(observation.status)
  ) {
    return {
      action: "block",
      url: input.requestedUrl,
      runtimeStatus: observation.status,
      reason: observation.status === "failed" && observation.portConflict
        ? "DEV_SERVER_PORT_CONFLICT_UNCONFIRMED"
        : observation.status === "failed"
        ? "DEV_SERVER_START_FAILED"
        : observation.status === "stopped"
        ? "DEV_SERVER_STOPPED"
        : "PTY_OBSERVATION_REQUIRED",
      nextCapability: observation.nextCapability,
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
    reason: null,
    nextCapability: observation.status === "ready" ? "browser" : "reconcile",
  };
}
