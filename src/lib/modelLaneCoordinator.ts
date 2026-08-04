import type { AppConfig } from "./appTypes";
import { resolveRuntimeLaneKey } from "./appConfig";
import { getSystemMemory, type SystemMemoryInfo } from "./ipc";

const GIB = 1024 ** 3;
const PRESSURE_SAMPLE_MS = 2_000;
const DEGRADE_DURATION_MS = 5 * 60_000;
const BURST_HEALTH_TTL_MS = 30_000;
// Capability discovery is deliberately provider-neutral. Cloud lanes may
// open one empirical overlap probe. Local lanes stay serial unless the
// provider/user explicitly supplies a concurrency fact; free memory alone
// does not prove that a local inference server supports overlapping streams.
const MODEL_LANE_AUTODISCOVERY_CEILING = 4;

export type ModelLaneAgentKind = "parent" | "subagent";

interface LaneEntry {
  id: string;
  agentKind: ModelLaneAgentKind;
  subagentId?: string;
  admittedAt: number;
  firstTokenSeen: boolean;
  pressureHandler?: (error: Error) => void;
  onDebugEvent?: (event: string, data: Record<string, unknown>) => void;
}

interface LaneWaiter {
  entry: LaneEntry;
  requestTokenBudget: number;
  queuedAt: number;
  queueLogged: boolean;
  queueReason?: ModelLaneState["lastQueueReason"];
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

interface ModelLaneState {
  laneKey: string;
  local: boolean;
  requestLimitCeiling: number;
  requestLimitConfigured: boolean;
  maxConfirmedActiveRequests: number;
  active: LaneEntry[];
  queue: LaneWaiter[];
  degradedUntil: number;
  memoryUnavailable: boolean;
  lowMemorySamples: number;
  monitor: ReturnType<typeof setInterval> | null;
  admissionTimer: ReturnType<typeof setTimeout> | null;
  overlapBaselineAvailableBytes: number | null;
  overlapStartedAt: number | null;
  overlapSampleCount: number;
  maxObservedOverlapDropBytes: number;
  draining: boolean;
  drainRequested: boolean;
  safeSubagentOverlapSamples: number;
  lastSafeSubagentOverlapAt: number;
  lastQueueReason: "lane_full" | "cold_start_first_token" | "memory_reserve" | "memory_probe_unavailable" | null;
}

export interface ModelLaneBurstAdmission {
  allowed: boolean;
  reason: "ready" | "no_lane_activity" | "not_local" | "degraded" | "memory_probe_unavailable" | "insufficient_safe_overlap" | "safe_overlap_stale";
  safeOverlapSamples: number;
  lastSafeOverlapAt: number | null;
  activeRequests: number;
}

export interface ModelLaneLease {
  laneKey: string;
  markFirstToken: () => void;
  setPressureHandler: (handler?: (error: Error) => void) => void;
  reportFailure: (error: unknown) => boolean;
  release: () => void;
}

export interface ModelLaneCapacityObservation {
  readonly laneKey: string;
  readonly configured: boolean;
  readonly requestLimitCeiling: number;
  readonly maxConfirmedActiveRequests: number;
  /** Current provider-request admission limit, including the parent. */
  readonly maxActiveRequests: number;
  /** Whether provider calls can overlap or must take turns on this lane. */
  readonly requestMode: "parallel" | "serialized";
  /** Current child-request capacity after reserving one parent request. */
  readonly maxActiveSubagents: number;
}

const lanes = new Map<string, ModelLaneState>();
let sequence = 0;
let memoryReader: () => Promise<SystemMemoryInfo> = getSystemMemory;

function abortError(): Error {
  const error = new Error("Model lane admission was canceled.");
  error.name = "AbortError";
  return error;
}

function pressureError(reason: string): Error {
  return new Error(`SUBAGENT_MEMORY_PRESSURE_DEGRADED: ${reason}`);
}

function isCapacityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /\b(?:oom|out of memory|memory allocation|429)\b|too many requests|rate limit|concurren(?:cy|t)|max(?:imum)? active requests|server busy/i.test(message);
}

function estimateIncomingKvBytes(requestTokenBudget: number): number {
  const normalizedBudget = Math.max(2_048, Number(requestTokenBudget) || 8_192);
  // OMLX shares model weights across requests and grows KV with actual usage.
  // Reserve a bounded request delta instead of pricing the full configured
  // context window as if it were allocated at admission time.
  return Math.min(4 * GIB, Math.max(1 * GIB, normalizedBudget * 16 * 1024));
}

function reserveBytes(memory: SystemMemoryInfo, requestTokenBudget: number): number {
  return Math.max(8 * GIB, memory.total_bytes * 0.15) + estimateIncomingKvBytes(requestTokenBudget);
}

function criticalBytes(memory: SystemMemoryInfo): number {
  return Math.max(4 * GIB, memory.total_bytes * 0.08);
}

function configuredRequestLimit(config: AppConfig): number | null {
  const active = config.activeProfile === "cloud"
    ? (
        config.cloudServers.find(
          (server) => server.id === config.activeCloudServerId,
        ) || config.cloud
      )
    : config.local;
  const value = Number(active?.maxActiveRequests);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MODEL_LANE_AUTODISCOVERY_CEILING)
    : null;
}

function laneLimit(state: ModelLaneState): number {
  if (state.degradedUntil > Date.now()) return 1;
  if (state.requestLimitConfigured) return state.requestLimitCeiling;
  if (state.local) return 1;
  // Unknown providers advance one slot at a time. Two requests are the first
  // useful probe: one established stream plus one candidate overlap.
  return Math.min(
    state.requestLimitCeiling,
    Math.max(2, state.maxConfirmedActiveRequests + 1),
  );
}

function recordConfirmedOverlap(state: ModelLaneState): void {
  const confirmed = state.active.filter(
    (entry) => entry.firstTokenSeen,
  ).length;
  state.maxConfirmedActiveRequests = Math.max(
    state.maxConfirmedActiveRequests,
    confirmed,
  );
}

function newestSubagent(state: ModelLaneState): LaneEntry | null {
  return [...state.active]
    .filter((entry) => entry.agentKind === "subagent")
    .sort((a, b) => b.admittedAt - a.admittedAt)[0] || null;
}

function degradeLane(state: ModelLaneState, reason: string): boolean {
  state.degradedUntil = Date.now() + DEGRADE_DURATION_MS;
  state.safeSubagentOverlapSamples = 0;
  state.lastSafeSubagentOverlapAt = 0;
  const child = newestSubagent(state);
  child?.onDebugEvent?.("model_lane_admission", {
    laneKey: state.laneKey,
    decision: "degraded",
    reason,
    subagentId: child.subagentId || null,
    agentKind: child.agentKind,
  });
  child?.pressureHandler?.(pressureError(reason));
  return !!child;
}

async function sampleLaneMemory(
  state: ModelLaneState,
  requestTokenBudget: number,
  phase: "admission" | "overlap",
): Promise<boolean> {
  try {
    const memory = await memoryReader();
    state.memoryUnavailable = false;
    const reserve = reserveBytes(memory, requestTokenBudget);
    const critical = criticalBytes(memory);
    if (phase === "admission" && state.active.length === 1) {
      state.overlapBaselineAvailableBytes = memory.available_bytes;
    }
    if (phase === "overlap") state.overlapSampleCount += 1;
    const observedOverlapDropBytes = state.overlapBaselineAvailableBytes == null
      ? 0
      : Math.max(0, state.overlapBaselineAvailableBytes - memory.available_bytes);
    state.maxObservedOverlapDropBytes = Math.max(
      state.maxObservedOverlapDropBytes,
      observedOverlapDropBytes,
    );
    const belowReserve = memory.available_bytes < reserve;
    state.lowMemorySamples = belowReserve ? state.lowMemorySamples + 1 : 0;
    const action = memory.available_bytes < critical || state.lowMemorySamples >= 2
      ? "degrade"
      : belowReserve ? "hold" : "sample";
    recordConfirmedOverlap(state);
    const stableSubagentOverlap = state.active.filter(
      (entry) => entry.firstTokenSeen,
    ).length >= 2;
    if (action === "sample" && stableSubagentOverlap) {
      state.safeSubagentOverlapSamples += 1;
      state.lastSafeSubagentOverlapAt = Date.now();
    } else if (action !== "sample") {
      state.safeSubagentOverlapSamples = 0;
      state.lastSafeSubagentOverlapAt = 0;
    }
    const shouldLog = phase === "admission" || action !== "sample" ||
      state.overlapSampleCount === 1 || state.overlapSampleCount % 15 === 0;
    if (shouldLog) {
      const owner = state.active[0];
      owner?.onDebugEvent?.("memory_pressure_sample", {
        laneKey: state.laneKey,
        phase,
        availableBytes: memory.available_bytes,
        totalBytes: memory.total_bytes,
        reserveBytes: reserve,
        criticalBytes: critical,
        requestTokenBudget,
        estimatedRequestBytes: estimateIncomingKvBytes(requestTokenBudget),
        overlapBaselineAvailableBytes: state.overlapBaselineAvailableBytes,
        observedOverlapDropBytes,
        maxObservedOverlapDropBytes: state.maxObservedOverlapDropBytes,
        overlapSampleCount: state.overlapSampleCount,
        lowMemorySamples: state.lowMemorySamples,
        safeSubagentOverlapSamples: state.safeSubagentOverlapSamples,
        stableSubagentOverlap,
        action,
        activeRequests: state.active.map((entry) => ({
          requestId: entry.id,
          agentKind: entry.agentKind,
          subagentId: entry.subagentId || null,
          firstTokenSeen: entry.firstTokenSeen,
        })),
      });
    }
    if (action === "degrade") {
      degradeLane(state, memory.available_bytes < critical ? "critical memory threshold" : "sustained low memory");
      return false;
    }
    return !belowReserve;
  } catch (error) {
    state.memoryUnavailable = true;
    state.safeSubagentOverlapSamples = 0;
    state.lastSafeSubagentOverlapAt = 0;
    for (const entry of state.active) {
      entry.onDebugEvent?.("memory_pressure_sample", {
        laneKey: state.laneKey,
        action: "hold",
        error: error instanceof Error ? error.message : String(error || "memory probe unavailable"),
      });
    }
    return false;
  }
}

function stopMonitorIfIdle(state: ModelLaneState): void {
  if (state.active.length > 1 || !state.monitor) return;
  clearInterval(state.monitor);
  state.monitor = null;
  const durationMs = state.overlapStartedAt == null ? 0 : Date.now() - state.overlapStartedAt;
  state.active[0]?.onDebugEvent?.("model_lane_overlap_summary", {
    laneKey: state.laneKey,
    durationMs,
    samples: state.overlapSampleCount,
    baselineAvailableBytes: state.overlapBaselineAvailableBytes,
    maxObservedDropBytes: state.maxObservedOverlapDropBytes,
    remainingActiveRequests: state.active.length,
  });
  state.lowMemorySamples = 0;
  state.overlapBaselineAvailableBytes = null;
  state.overlapStartedAt = null;
  state.overlapSampleCount = 0;
  state.maxObservedOverlapDropBytes = 0;
}

function startMonitor(state: ModelLaneState, requestTokenBudget: number): void {
  if (!state.local || state.monitor || state.active.length < 2) return;
  state.overlapStartedAt = Date.now();
  state.monitor = setInterval(() => {
    void sampleLaneMemory(state, requestTokenBudget, "overlap");
  }, PRESSURE_SAMPLE_MS);
}

async function canAdmit(state: ModelLaneState, waiter: LaneWaiter): Promise<boolean> {
  if (state.active.length >= laneLimit(state)) {
    state.lastQueueReason = "lane_full";
    return false;
  }
  if (!state.local || state.active.length === 0) {
    state.lastQueueReason = null;
    return true;
  }
  if (!state.active.every((entry) => entry.firstTokenSeen)) {
    state.lastQueueReason = "cold_start_first_token";
    return false;
  }
  const memoryAvailable = await sampleLaneMemory(state, waiter.requestTokenBudget, "admission");
  if (!memoryAvailable && state.degradedUntil > Date.now() && waiter.entry.agentKind === "subagent") {
    throw pressureError("model lane admission degraded after memory pressure");
  }
  state.lastQueueReason = memoryAvailable
    ? null
    : state.memoryUnavailable ? "memory_probe_unavailable" : "memory_reserve";
  return memoryAvailable;
}

function scheduleAdmissionRetry(state: ModelLaneState): void {
  if (state.admissionTimer || state.queue.length === 0) return;
  state.admissionTimer = setTimeout(() => {
    state.admissionTimer = null;
    void drainLane(state);
  }, PRESSURE_SAMPLE_MS);
}

async function drainLane(state: ModelLaneState): Promise<void> {
  if (state.draining) {
    state.drainRequested = true;
    return;
  }
  state.draining = true;
  try {
    do {
      state.drainRequested = false;
      while (state.queue.length > 0) {
        const waiter = state.queue[0];
        let allowed = false;
        try {
          allowed = await canAdmit(state, waiter);
        } catch (error) {
          state.queue.shift();
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
          }
          waiter.reject(error instanceof Error ? error : pressureError(String(error || "admission failed")));
          continue;
        }
        if (!allowed) {
          if (!waiter.queueLogged) {
            waiter.queueLogged = true;
            waiter.queueReason = state.lastQueueReason;
            waiter.entry.onDebugEvent?.("model_lane_admission", {
              laneKey: state.laneKey,
              decision: "queued",
              queueReason: state.lastQueueReason || "admission_pending",
              activeRequests: state.active.length,
              limit: laneLimit(state),
              requestTokenBudget: waiter.requestTokenBudget,
              agentKind: waiter.entry.agentKind,
              subagentId: waiter.entry.subagentId || null,
              liveRequests: state.active.map((entry) => ({
                requestId: entry.id,
                agentKind: entry.agentKind,
                subagentId: entry.subagentId || null,
                firstTokenSeen: entry.firstTokenSeen,
              })),
            });
          }
          if (state.active[0]?.firstTokenSeen) scheduleAdmissionRetry(state);
          break;
        }
        state.queue.shift();
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.entry.admittedAt = Math.max(
          Date.now(),
          ...state.active.map((entry) => entry.admittedAt + 1),
        );
        state.active.push(waiter.entry);
        waiter.resolve();
        startMonitor(state, waiter.requestTokenBudget);
      }
    } while (state.drainRequested);
  } finally {
    state.draining = false;
  }
}

export async function acquireModelLane(input: {
  config: AppConfig;
  contextLimit?: number;
  requestTokenBudget?: number;
  agentKind: ModelLaneAgentKind;
  subagentId?: string;
  signal?: AbortSignal;
  onDebugEvent?: (event: string, data: Record<string, unknown>) => void;
}): Promise<ModelLaneLease> {
  if (input.signal?.aborted) throw abortError();
  const laneKey = resolveRuntimeLaneKey(input.config);
  const configuredLimit = configuredRequestLimit(input.config);
  const local = input.config.activeProfile !== "cloud";
  const requestLimitCeiling =
    configuredLimit || (
      local ? 1 : MODEL_LANE_AUTODISCOVERY_CEILING
    );
  const state = lanes.get(laneKey) || {
    laneKey,
    local,
    requestLimitCeiling,
    requestLimitConfigured: configuredLimit !== null,
    maxConfirmedActiveRequests: 0,
    active: [],
    queue: [],
    degradedUntil: 0,
    memoryUnavailable: false,
    lowMemorySamples: 0,
    monitor: null,
    admissionTimer: null,
    overlapBaselineAvailableBytes: null,
    overlapStartedAt: null,
    overlapSampleCount: 0,
    maxObservedOverlapDropBytes: 0,
    draining: false,
    drainRequested: false,
    safeSubagentOverlapSamples: 0,
    lastSafeSubagentOverlapAt: 0,
    lastQueueReason: null,
  };
  state.local = local;
  state.requestLimitCeiling = requestLimitCeiling;
  state.requestLimitConfigured = configuredLimit !== null;
  lanes.set(laneKey, state);
  const entry: LaneEntry = {
    id: `model-lane-${++sequence}`,
    agentKind: input.agentKind,
    subagentId: input.subagentId,
    admittedAt: Date.now(),
    firstTokenSeen: false,
    onDebugEvent: input.onDebugEvent,
  };
  const requestTokenBudget = Math.min(
    input.contextLimit || 32_768,
    Math.max(2_048, input.requestTokenBudget || input.contextLimit || 8_192),
  );
  let admitted = false;
  const waiter: LaneWaiter = {
    entry,
    requestTokenBudget,
    queuedAt: Date.now(),
    queueLogged: false,
    signal: input.signal,
    resolve: () => { admitted = true; },
    reject: () => {},
  };
  await new Promise<void>((resolve, reject) => {
    waiter.resolve = () => { admitted = true; resolve(); };
    waiter.reject = reject;
    waiter.onAbort = () => {
      const index = state.queue.indexOf(waiter);
      if (index >= 0) state.queue.splice(index, 1);
      reject(abortError());
    };
    input.signal?.addEventListener("abort", waiter.onAbort, { once: true });
    state.queue.push(waiter);
    void drainLane(state);
  });
  if (!admitted) throw new Error("Model lane admission failed.");
  if (waiter.queueLogged || state.active.length > 1) {
    input.onDebugEvent?.("model_lane_admission", {
      laneKey,
      decision: "admitted",
      activeRequests: state.active.length,
      limit: laneLimit(state),
      waitMs: Date.now() - waiter.queuedAt,
      requestTokenBudget,
      overlapping: state.active.length > 1,
      queueReason: waiter.queueLogged ? waiter.queueReason || "admission_pending" : null,
      agentKind: input.agentKind,
      subagentId: input.subagentId || null,
      liveRequests: state.active.map((activeEntry) => ({
        requestId: activeEntry.id,
        agentKind: activeEntry.agentKind,
        subagentId: activeEntry.subagentId || null,
        firstTokenSeen: activeEntry.firstTokenSeen,
      })),
    });
  }

  let released = false;
  return {
    laneKey,
    markFirstToken: () => {
      if (entry.firstTokenSeen) return;
      entry.firstTokenSeen = true;
      recordConfirmedOverlap(state);
      void drainLane(state);
    },
    setPressureHandler: (handler) => { entry.pressureHandler = handler; },
    reportFailure: (error) => {
      if (!isCapacityFailure(error)) return false;
      return degradeLane(state, error instanceof Error ? error.message : String(error || "model request failure"));
    },
    release: () => {
      if (released) return;
      released = true;
      const index = state.active.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) state.active.splice(index, 1);
      stopMonitorIfIdle(state);
      void drainLane(state);
    },
  };
}

export function getModelLaneCapacityObservation(
  config: AppConfig,
): ModelLaneCapacityObservation {
  const laneKey = resolveRuntimeLaneKey(config);
  const configuredLimit = configuredRequestLimit(config);
  const local = config.activeProfile !== "cloud";
  const state = lanes.get(laneKey);
  const requestLimitCeiling =
    configuredLimit ||
    state?.requestLimitCeiling ||
    (local ? 1 : MODEL_LANE_AUTODISCOVERY_CEILING);
  const maxConfirmedActiveRequests =
    state?.maxConfirmedActiveRequests || 0;
  const maxActiveRequests = state
    ? laneLimit(state)
    : configuredLimit || (
        local ? 1 : Math.min(requestLimitCeiling, 2)
      );
  return {
    laneKey,
    configured: configuredLimit !== null,
    requestLimitCeiling,
    maxConfirmedActiveRequests,
    maxActiveRequests,
    requestMode: maxActiveRequests > 1 ? "parallel" : "serialized",
    maxActiveSubagents: Math.max(0, maxActiveRequests - 1),
  };
}

export function getModelLaneBurstAdmission(laneKey: string): ModelLaneBurstAdmission {
  const state = lanes.get(laneKey);
  const base = {
    safeOverlapSamples: state?.safeSubagentOverlapSamples || 0,
    lastSafeOverlapAt: state?.lastSafeSubagentOverlapAt || null,
    activeRequests: state?.active.length || 0,
  };
  if (!state) return { allowed: false, reason: "no_lane_activity", ...base };
  if (!state.local) return { allowed: false, reason: "not_local", ...base };
  if (state.degradedUntil > Date.now()) return { allowed: false, reason: "degraded", ...base };
  if (state.memoryUnavailable) {
    return { allowed: false, reason: "memory_probe_unavailable", ...base };
  }
  if (state.safeSubagentOverlapSamples < 2 || state.lastSafeSubagentOverlapAt <= 0) {
    return { allowed: false, reason: "insufficient_safe_overlap", ...base };
  }
  if (Date.now() - state.lastSafeSubagentOverlapAt > BURST_HEALTH_TTL_MS) {
    return { allowed: false, reason: "safe_overlap_stale", ...base };
  }
  return { allowed: true, reason: "ready", ...base };
}

export function setModelLaneMemoryReaderForTests(reader?: () => Promise<SystemMemoryInfo>): void {
  memoryReader = reader || getSystemMemory;
}

export async function sampleModelLaneMemoryForTests(
  laneKey: string,
  requestTokenBudget = 8_192,
): Promise<boolean> {
  const state = lanes.get(laneKey);
  if (!state) return false;
  return sampleLaneMemory(state, requestTokenBudget, "overlap");
}

export function resetModelLaneCoordinatorForTests(): void {
  for (const state of lanes.values()) {
    if (state.monitor) clearInterval(state.monitor);
    if (state.admissionTimer) clearTimeout(state.admissionTimer);
  }
  lanes.clear();
  sequence = 0;
  memoryReader = getSystemMemory;
}
