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
  contextLimit: number;
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

function estimateIncomingKvBytes(contextLimit: number): number {
  const normalizedLimit = Math.max(4_096, Number(contextLimit) || 32_768);
  return Math.max(2 * GIB, normalizedLimit * 136 * 1024);
}

function reserveBytes(memory: SystemMemoryInfo, contextLimit: number): number {
  return Math.max(8 * GIB, memory.total_bytes * 0.15) + estimateIncomingKvBytes(contextLimit);
}

function criticalBytes(memory: SystemMemoryInfo): number {
  return Math.max(4 * GIB, memory.total_bytes * 0.08);
}

function laneLimit(state: ModelLaneState): number {
  if (state.degradedUntil > Date.now()) return 1;
  if (!state.local) return 4;
  if (state.memoryUnavailable) return 1;
  return 2;
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

async function sampleLaneMemory(state: ModelLaneState, contextLimit: number): Promise<boolean> {
  try {
    const memory = await memoryReader();
    const reserve = reserveBytes(memory, contextLimit);
    const critical = criticalBytes(memory);
    const belowReserve = memory.available_bytes < reserve;
    state.lowMemorySamples = belowReserve ? state.lowMemorySamples + 1 : 0;
    const action = memory.available_bytes < critical || state.lowMemorySamples >= 2
      ? "degrade"
      : belowReserve ? "hold" : "sample";
    state.active.forEach((entry, index) => {
      entry.onDebugEvent?.("memory_pressure_sample", {
        laneKey: state.laneKey,
        availableBytes: memory.available_bytes,
        totalBytes: memory.total_bytes,
        reserveBytes: reserve,
        criticalBytes: critical,
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
  state.lowMemorySamples = 0;
}

function startMonitor(state: ModelLaneState, contextLimit: number): void {
  if (!state.local || state.monitor || state.active.length < 2) return;
  state.monitor = setInterval(() => {
    void sampleLaneMemory(state, contextLimit);
  }, PRESSURE_SAMPLE_MS);
}

async function canAdmit(state: ModelLaneState, waiter: LaneWaiter): Promise<boolean> {
  if (state.active.length >= laneLimit(state)) return false;
  if (!state.local || state.active.length === 0) return true;
  if (!state.active[0]?.firstTokenSeen) return false;
  const memoryAvailable = await sampleLaneMemory(state, waiter.contextLimit);
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
      if (state.active[0]?.firstTokenSeen) scheduleAdmissionRetry(state);
      return;
    }
    state.queue.shift();
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    state.active.push(waiter.entry);
    waiter.entry.onDebugEvent?.("model_lane_admission", {
      laneKey: state.laneKey,
      decision: "admitted",
      activeRequests: state.active.length,
      limit: laneLimit(state),
      agentKind: waiter.entry.agentKind,
      subagentId: waiter.entry.subagentId || null,
    });
    waiter.resolve();
    startMonitor(state, waiter.contextLimit);
  }
}

export async function acquireModelLane(input: {
  config: AppConfig;
  contextLimit?: number;
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
  const contextLimit = input.contextLimit || 32_768;
  let admitted = false;
  const waiter: LaneWaiter = {
    entry,
    contextLimit,
    signal: input.signal,
    resolve: () => { admitted = true; },
    reject: () => {},
  };
  if (await canAdmit(state, waiter)) {
    state.active.push(entry);
    admitted = true;
  } else {
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
      if (state.active[0]?.firstTokenSeen) scheduleAdmissionRetry(state);
      input.onDebugEvent?.("model_lane_admission", {
        laneKey,
        decision: "queued",
        activeRequests: state.active.length,
        limit: laneLimit(state),
        agentKind: input.agentKind,
        subagentId: input.subagentId || null,
      });
    });
  }
  if (!admitted) throw new Error("Model lane admission failed.");
  input.onDebugEvent?.("model_lane_admission", {
    laneKey,
    decision: "admitted",
    activeRequests: state.active.length,
    limit: laneLimit(state),
    agentKind: input.agentKind,
    subagentId: input.subagentId || null,
  });

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
