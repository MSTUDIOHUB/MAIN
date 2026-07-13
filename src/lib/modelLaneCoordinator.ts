import type { AppConfig } from "./appTypes";
import { resolveRuntimeLaneKey } from "./appConfig";
import { getSystemMemory, type SystemMemoryInfo } from "./ipc";

const GIB = 1024 ** 3;
const PRESSURE_SAMPLE_MS = 2_000;
const DEGRADE_DURATION_MS = 5 * 60_000;

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
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

interface ModelLaneState {
  laneKey: string;
  local: boolean;
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
}

export interface ModelLaneLease {
  laneKey: string;
  markFirstToken: () => void;
  setPressureHandler: (handler?: (error: Error) => void) => void;
  reportFailure: (error: unknown) => boolean;
  release: () => void;
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
  return /\b(?:oom|out of memory|memory allocation|429|524)\b|connection reset|socket hang up|gateway timeout|stream.*timeout|no visible progress/i.test(message);
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

function laneLimit(state: ModelLaneState): number {
  if (state.degradedUntil > Date.now()) return 1;
  if (!state.local) return 4;
  if (state.memoryUnavailable) return 1;
  return 3;
}

function newestSubagent(state: ModelLaneState): LaneEntry | null {
  return [...state.active]
    .filter((entry) => entry.agentKind === "subagent")
    .sort((a, b) => b.admittedAt - a.admittedAt)[0] || null;
}

function degradeLane(state: ModelLaneState, reason: string): boolean {
  state.degradedUntil = Date.now() + DEGRADE_DURATION_MS;
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
    const shouldLog = phase === "admission" || action !== "sample" ||
      state.overlapSampleCount === 1 || state.overlapSampleCount % 15 === 0;
    if (shouldLog) state.active.forEach((entry, index) => {
      entry.onDebugEvent?.("memory_pressure_sample", {
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
        action,
        runtimeEventOwner: index === 0,
      });
    });
    if (action === "degrade") {
      degradeLane(state, memory.available_bytes < critical ? "critical memory threshold" : "sustained low memory");
      return false;
    }
    return !belowReserve;
  } catch (error) {
    state.memoryUnavailable = true;
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
  if (state.active.length >= laneLimit(state)) return false;
  if (!state.local || state.active.length === 0) return true;
  if (!state.active[0]?.firstTokenSeen) return false;
  const memoryAvailable = await sampleLaneMemory(state, waiter.requestTokenBudget, "admission");
  if (!memoryAvailable && state.degradedUntil > Date.now() && waiter.entry.agentKind === "subagent") {
    throw pressureError("model lane admission degraded after memory pressure");
  }
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
            waiter.entry.onDebugEvent?.("model_lane_admission", {
              laneKey: state.laneKey,
              decision: "queued",
              activeRequests: state.active.length,
              limit: laneLimit(state),
              requestTokenBudget: waiter.requestTokenBudget,
              agentKind: waiter.entry.agentKind,
              subagentId: waiter.entry.subagentId || null,
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
  const state = lanes.get(laneKey) || {
    laneKey,
    local: input.config.activeProfile !== "cloud",
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
  };
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
      agentKind: input.agentKind,
      subagentId: input.subagentId || null,
    });
  }

  let released = false;
  return {
    laneKey,
    markFirstToken: () => {
      if (entry.firstTokenSeen) return;
      entry.firstTokenSeen = true;
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

export function setModelLaneMemoryReaderForTests(reader?: () => Promise<SystemMemoryInfo>): void {
  memoryReader = reader || getSystemMemory;
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
