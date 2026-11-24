import type { AppConfig } from "./appTypes";
import { resolveRuntimeLaneKey } from "./appConfig";
import { getSystemMemory, type SystemMemoryInfo } from "./ipc";
import {
  estimateLocalConcurrencyFromMemory,
  LOCAL_CONCURRENCY_HARD_CEILING,
} from "./localConcurrencyEstimate";

const GIB = 1024 ** 3;
const PRESSURE_SAMPLE_MS = 2_000;
const DEGRADE_DURATION_MS = 16_000;
const RECOVERY_HOLD_MS = 16_000;
const RECOVERY_HEALTHY_SAMPLES = 8;
const STAGGER_ADMISSION_MS = 200;
const BURST_HEALTH_TTL_MS = 30_000;
// Capability discovery is deliberately provider-neutral. Unknown lanes begin
// with one established request plus one empirical overlap probe, then expand to
// memory-estimated concurrency once real first chunks overlap. Local lanes
// additionally sample a live memory-reserve threshold before overlap admission.
const MODEL_LANE_AUTODISCOVERY_CEILING = LOCAL_CONCURRENCY_HARD_CEILING;

export type ModelLaneAgentKind = "parent" | "subagent";

interface LaneEntry {
  id: string;
  agentKind: ModelLaneAgentKind;
  subagentId?: string;
  parentRunId?: string;
  optionalOverlap?: true;
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
  contextLimit: number | null;
  requestLimitCeiling: number;
  requestLimitConfigured: boolean;
  maxConfirmedActiveRequests: number;
  maxConfirmedOverlappingChildren: number;
  concurrencyConfirmed: boolean;
  lastAdmittedAt: number;
  pressureReducedLimit: number | null;
  lastPressureEventAt: number;
  healthySamplesSinceReduce: number;
  active: LaneEntry[];
  queue: LaneWaiter[];
  degradedUntil: number;
  memoryUnavailable: boolean;
  lowMemorySamples: number;
  monitor: ReturnType<typeof setInterval> | null;
  admissionTimer: ReturnType<typeof setTimeout> | null;
  admissionTimerDueAt: number | null;
  overlapBaselineAvailableBytes: number | null;
  overlapStartedAt: number | null;
  overlapSampleCount: number;
  maxObservedOverlapDropBytes: number;
  draining: boolean;
  drainRequested: boolean;
  safeSubagentOverlapSamples: number;
  lastSafeSubagentOverlapAt: number;
  lastQueueReason:
    | "lane_full"
    | "waiting_for_parent"
    | "cold_start_first_token"
    | "stagger_launch"
    | "memory_reserve"
    | "memory_probe_unavailable"
    | null;
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
  readonly maxConfirmedOverlappingChildren: number;
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
let nowReader: () => number = Date.now;
let lastMemorySnapshot: SystemMemoryInfo | null = null;
let staggerAdmissionMs = STAGGER_ADMISSION_MS;

function isValidMemorySnapshot(memory: unknown): memory is SystemMemoryInfo {
  if (!memory || typeof memory !== "object") return false;
  const candidate = memory as Partial<SystemMemoryInfo>;
  return (
    typeof candidate.total_bytes === "number" &&
    Number.isFinite(candidate.total_bytes) &&
    candidate.total_bytes >= 0 &&
    typeof candidate.available_bytes === "number" &&
    Number.isFinite(candidate.available_bytes) &&
    candidate.available_bytes >= 0
  );
}

/**
 * Prime the shared system-memory snapshot used by local concurrency estimation
 * and UI capacity observation.
 */
export function primeModelLaneMemorySnapshot(
  memory: SystemMemoryInfo | null | undefined,
): void {
  if (memory === null) {
    lastMemorySnapshot = null;
    return;
  }
  if (isValidMemorySnapshot(memory)) {
    lastMemorySnapshot = { ...memory };
  }
}

/**
 * Refresh and cache the shared system-memory snapshot via the active memory reader.
 */
export async function refreshModelLaneMemorySnapshot(): Promise<SystemMemoryInfo | null> {
  try {
    const memory = await memoryReader();
    if (isValidMemorySnapshot(memory)) {
      lastMemorySnapshot = { ...memory };
    }
    return lastMemorySnapshot;
  } catch {
    return lastMemorySnapshot;
  }
}

function abortError(): Error {
  const error = new Error("Model lane admission was canceled.");
  error.name = "AbortError";
  return error;
}

export class ModelLaneResourceInterruption extends Error {
  constructor(readonly causeKind: "memory" | "provider_capacity", reason: string) {
    super(`SUBAGENT_MEMORY_PRESSURE_DEGRADED: ${reason}`);
  }
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

function resolveMemoryPressureThresholds(
  memory: SystemMemoryInfo,
  requestTokenBudget: number,
  contextLimit?: number | null,
): { reserve: number; critical: number } {
  const estimate = estimateLocalConcurrencyFromMemory({
    totalBytes: memory.total_bytes,
    availableBytes: memory.available_bytes,
    contextLimit,
  });
  return {
    reserve: estimate.memoryReserveBytes + estimateIncomingKvBytes(requestTokenBudget),
    critical: estimate.criticalMemoryBytes,
  };
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

function dynamicMemoryRequestLimit(contextLimit: number | null): number {
  const estimate = estimateLocalConcurrencyFromMemory({
    totalBytes: lastMemorySnapshot?.total_bytes ?? null,
    availableBytes: lastMemorySnapshot?.available_bytes ?? null,
    contextLimit,
  });
  return estimate.totalRequestsLimit;
}

function computeLaneBaseLimit(input: {
  readonly local: boolean;
  readonly requestLimitConfigured: boolean;
  readonly requestLimitCeiling: number;
  readonly maxConfirmedActiveRequests: number;
  readonly contextLimit: number | null;
}): number {
  if (input.requestLimitConfigured) return input.requestLimitCeiling;
  if (!input.local) {
    return input.maxConfirmedActiveRequests < 2
      ? Math.min(input.requestLimitCeiling, 2)
      : input.requestLimitCeiling;
  }
  const dynamicLimit = dynamicMemoryRequestLimit(input.contextLimit);
  if (input.maxConfirmedActiveRequests < 2) {
    return Math.min(input.requestLimitCeiling, Math.min(dynamicLimit, 2));
  }
  return Math.min(input.requestLimitCeiling, dynamicLimit);
}

function computeEffectiveLaneLimit(input: {
  readonly local: boolean;
  readonly requestLimitConfigured: boolean;
  readonly requestLimitCeiling: number;
  readonly maxConfirmedActiveRequests: number;
  readonly contextLimit: number | null;
  readonly degradedUntil: number;
  readonly pressureReducedLimit: number | null;
}): number {
  if (input.degradedUntil > nowReader()) return 1;
  const baseLimit = computeLaneBaseLimit(input);
  if (input.pressureReducedLimit !== null) {
    return Math.max(1, Math.min(baseLimit, input.pressureReducedLimit));
  }
  return baseLimit;
}

function laneBaseLimit(state: ModelLaneState): number {
  return computeLaneBaseLimit(state);
}

function laneLimit(state: ModelLaneState): number {
  return computeEffectiveLaneLimit(state);
}

function recordConfirmedOverlap(state: ModelLaneState): void {
  const confirmed = state.active.filter((entry) => entry.firstTokenSeen);
  state.maxConfirmedActiveRequests = Math.max(
    state.maxConfirmedActiveRequests,
    confirmed.length,
  );
  if (state.maxConfirmedActiveRequests >= 2) {
    state.concurrencyConfirmed = true;
  }
  for (const parent of confirmed.filter((entry) => entry.agentKind === "parent")) {
    state.maxConfirmedOverlappingChildren = Math.max(
      state.maxConfirmedOverlappingChildren,
      confirmed.filter(
        (entry) =>
          entry.agentKind === "subagent" &&
          entry.parentRunId === parent.parentRunId,
      ).length,
    );
  }
}

function newestSubagent(state: ModelLaneState): LaneEntry | null {
  return [...state.active]
    .filter((entry) => entry.agentKind === "subagent")
    .sort((a, b) => b.admittedAt - a.admittedAt)[0] || null;
}

function stepDownPressureLimit(state: ModelLaneState): number {
  const base = laneBaseLimit(state);
  const current = state.pressureReducedLimit !== null
    ? Math.min(base, state.pressureReducedLimit)
    : laneLimit(state);
  const minLimit = Math.max(1, state.active.length - 1);
  const next = Math.min(current, Math.max(minLimit, current - 1));
  state.pressureReducedLimit = next;
  state.lastPressureEventAt = nowReader();
  state.healthySamplesSinceReduce = 0;
  return next;
}

function stepUpPressureLimitIfReady(
  state: ModelLaneState,
  phase: "admission" | "overlap",
  now: number,
): void {
  if (state.pressureReducedLimit === null) return;
  if (state.degradedUntil > now) return;
  const elapsed = state.lastPressureEventAt > 0
    ? now - state.lastPressureEventAt
    : RECOVERY_HOLD_MS;
  const overlapSamplesReady =
    phase === "overlap" && state.healthySamplesSinceReduce >= RECOVERY_HEALTHY_SAMPLES;
  const elapsedWindowReady = elapsed >= RECOVERY_HOLD_MS;
  if (!overlapSamplesReady && !elapsedWindowReady) return;
  const baseLimit = laneBaseLimit(state);
  const next = state.pressureReducedLimit + 1;
  state.pressureReducedLimit = next >= baseLimit ? null : next;
  state.healthySamplesSinceReduce = 0;
  state.lastPressureEventAt = state.pressureReducedLimit === null ? 0 : now;
}

function degradeLane(
  state: ModelLaneState,
  reason: string,
  causeKind: "memory" | "provider_capacity" = "memory",
  options?: { readonly lockToOne?: boolean },
): boolean {
  const now = nowReader();
  const nextReducedLimit = Math.max(1, state.active.length - 1);
  state.pressureReducedLimit = state.pressureReducedLimit !== null
    ? Math.min(state.pressureReducedLimit, nextReducedLimit)
    : nextReducedLimit;
  state.lastPressureEventAt = now;
  state.healthySamplesSinceReduce = 0;
  if (options?.lockToOne) {
    state.degradedUntil = now + DEGRADE_DURATION_MS;
  }
  state.safeSubagentOverlapSamples = 0;
  state.lastSafeSubagentOverlapAt = 0;
  const child = newestSubagent(state);
  child?.onDebugEvent?.("model_lane_admission", {
    laneKey: state.laneKey,
    decision: "degraded",
    reason,
    causeKind,
    pressureReducedLimit: state.pressureReducedLimit,
    subagentId: child.subagentId || null,
    agentKind: child.agentKind,
  });
  child?.pressureHandler?.(new ModelLaneResourceInterruption(causeKind, reason));
  return !!child;
}

async function sampleLaneMemory(
  state: ModelLaneState,
  requestTokenBudget: number,
  phase: "admission" | "overlap",
  candidate?: LaneEntry,
): Promise<boolean> {
  try {
    const memory = await memoryReader();
    state.memoryUnavailable = false;
    if (isValidMemorySnapshot(memory)) {
      lastMemorySnapshot = { ...memory };
    }
    const now = nowReader();
    const { reserve, critical } = resolveMemoryPressureThresholds(
      memory,
      requestTokenBudget,
      state.contextLimit,
    );
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
    const criticalPressure = memory.available_bytes < critical;
    if (phase === "overlap") {
      state.lowMemorySamples = belowReserve && state.active.length > 1
        ? state.lowMemorySamples + 1
        : 0;
    }

    let action: "sample" | "hold" | "step_down" | "degrade" = "sample";
    if (criticalPressure && !(phase === "admission" && candidate?.optionalOverlap)) {
      action = "degrade";
      state.healthySamplesSinceReduce = 0;
    } else if (belowReserve) {
      state.healthySamplesSinceReduce = 0;
      if (phase === "overlap" && state.lowMemorySamples >= 2) {
        action = "step_down";
        stepDownPressureLimit(state);
      } else {
        action = "hold";
      }
    } else if (state.pressureReducedLimit !== null && state.degradedUntil <= now) {
      if (phase === "overlap") {
        state.healthySamplesSinceReduce += 1;
      }
      stepUpPressureLimitIfReady(state, phase, now);
    }

    recordConfirmedOverlap(state);
    const stableSubagentOverlap = state.active.filter(
      (entry) => entry.firstTokenSeen,
    ).length >= 2;
    if (action === "sample" && stableSubagentOverlap) {
      state.safeSubagentOverlapSamples += 1;
      state.lastSafeSubagentOverlapAt = now;
    } else if (action !== "sample") {
      state.safeSubagentOverlapSamples = 0;
      state.lastSafeSubagentOverlapAt = 0;
    }
    const shouldLog = phase === "admission" || action !== "sample" ||
      state.overlapSampleCount === 1 || state.overlapSampleCount % 15 === 0;
    if (shouldLog) {
      const owner = candidate || state.active[0];
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
        healthySamplesSinceReduce: state.healthySamplesSinceReduce,
        pressureReducedLimit: state.pressureReducedLimit,
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
      degradeLane(state, "critical memory threshold", "memory", { lockToOne: false });
      return false;
    }
    return !belowReserve;
  } catch (error) {
    state.memoryUnavailable = true;
    state.safeSubagentOverlapSamples = 0;
    state.lastSafeSubagentOverlapAt = 0;
    for (const entry of candidate ? [candidate] : state.active) {
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
  const durationMs = state.overlapStartedAt == null ? 0 : nowReader() - state.overlapStartedAt;
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
  state.overlapStartedAt = nowReader();
  state.monitor = setInterval(() => {
    void sampleLaneMemory(state, requestTokenBudget, "overlap");
  }, PRESSURE_SAMPLE_MS);
}

async function canAdmit(state: ModelLaneState, waiter: LaneWaiter): Promise<boolean> {
  const activeParent = () => state.active.some(
    (entry) =>
      entry.agentKind === "parent" &&
      (!waiter.entry.parentRunId || entry.parentRunId === waiter.entry.parentRunId),
  );
  const now = nowReader();
  const maxConfirmableLimit = state.requestLimitConfigured
    ? state.requestLimitCeiling
    : state.maxConfirmedActiveRequests < 2
      ? Math.min(state.requestLimitCeiling, 2)
      : state.requestLimitCeiling;
  const maxUncappedByStaleMemory = state.pressureReducedLimit !== null
    ? Math.min(maxConfirmableLimit, state.pressureReducedLimit)
    : maxConfirmableLimit;
  const canProbeRecoveryAtLimit =
    state.pressureReducedLimit !== null &&
    state.pressureReducedLimit < maxConfirmableLimit &&
    state.degradedUntil <= now &&
    state.lastPressureEventAt > 0 &&
    now - state.lastPressureEventAt >= RECOVERY_HOLD_MS;
  const canProbeStaleMemoryAtLimit =
    state.local &&
    !state.requestLimitConfigured &&
    state.degradedUntil <= now &&
    state.active.length < maxUncappedByStaleMemory;

  if (
    state.active.length >= laneLimit(state) &&
    !canProbeRecoveryAtLimit &&
    !canProbeStaleMemoryAtLimit
  ) {
    state.lastQueueReason = "lane_full";
    return false;
  }
  if (waiter.entry.optionalOverlap && !activeParent()) {
    state.lastQueueReason = "waiting_for_parent";
    return false;
  }
  if (!state.local) {
    if (canProbeRecoveryAtLimit) {
      stepUpPressureLimitIfReady(state, "admission", now);
    }
    if (state.active.length >= laneLimit(state)) {
      state.lastQueueReason = "lane_full";
      return false;
    }
    state.lastQueueReason = null;
    return true;
  }
  if (state.active.length === 0) {
    state.lastQueueReason = null;
    return true;
  }
  const usingParentReserve =
    waiter.entry.agentKind === "parent" &&
    state.active.every((entry) => entry.optionalOverlap);
  if (!usingParentReserve) {
    if (!state.concurrencyConfirmed) {
      if (!state.active.every((entry) => entry.firstTokenSeen)) {
        state.lastQueueReason = "cold_start_first_token";
        return false;
      }
    } else if (staggerAdmissionMs > 0 && state.lastAdmittedAt > 0) {
      const elapsedMs = nowReader() - state.lastAdmittedAt;
      if (elapsedMs < staggerAdmissionMs) {
        state.lastQueueReason = "stagger_launch";
        return false;
      }
    }
  }
  const memoryAvailable = await sampleLaneMemory(
    state,
    waiter.requestTokenBudget,
    "admission",
    waiter.entry,
  );
  if (waiter.entry.optionalOverlap && !activeParent()) {
    state.lastQueueReason = "waiting_for_parent";
    return false;
  }
  if (state.active.length === 0) {
    state.lastQueueReason = null;
    return true;
  }
  if (state.active.length >= laneLimit(state)) {
    state.lastQueueReason = !memoryAvailable
      ? state.memoryUnavailable ? "memory_probe_unavailable" : "memory_reserve"
      : "lane_full";
    return false;
  }
  state.lastQueueReason = memoryAvailable
    ? null
    : state.memoryUnavailable ? "memory_probe_unavailable" : "memory_reserve";
  return (
    memoryAvailable ||
    (usingParentReserve &&
      state.degradedUntil <= nowReader() &&
      !state.memoryUnavailable)
  );
}

function scheduleAdmissionRetry(
  state: ModelLaneState,
  delayMs = PRESSURE_SAMPLE_MS,
): void {
  if (state.queue.length === 0) return;
  const normalizedDelay = Math.max(1, Math.floor(delayMs));
  const targetDueAt = Date.now() + normalizedDelay;
  if (state.admissionTimer) {
    if (
      state.admissionTimerDueAt !== null &&
      state.admissionTimerDueAt <= targetDueAt + 5
    ) {
      return;
    }
    clearTimeout(state.admissionTimer);
    state.admissionTimer = null;
    state.admissionTimerDueAt = null;
  }
  state.admissionTimerDueAt = targetDueAt;
  state.admissionTimer = setTimeout(() => {
    state.admissionTimer = null;
    state.admissionTimerDueAt = null;
    void drainLane(state);
  }, normalizedDelay);
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
        // Optional exploration must never be ahead of work that owns the
        // parent's request slot. A blocked child keeps its place among peers.
        const waiter = state.queue.find((item) => !item.entry.optionalOverlap) || state.queue[0]!;
        let allowed = false;
        try {
          allowed = await canAdmit(state, waiter);
        } catch (error) {
          const index = state.queue.indexOf(waiter);
          if (index < 0) continue;
          state.queue.splice(index, 1);
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
          }
          waiter.reject(error instanceof Error ? error : new Error(String(error || "Model lane admission failed")));
          continue;
        }
        const index = state.queue.indexOf(waiter);
        if (index < 0) continue;
        if (waiter.entry.optionalOverlap && state.queue.some((item) => !item.entry.optionalOverlap)) continue;
        if (!allowed) {
          if (!waiter.queueLogged || waiter.queueReason !== state.lastQueueReason) {
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
          if (state.lastQueueReason === "stagger_launch") {
            const remainingMs = Math.max(
              1,
              staggerAdmissionMs - Math.max(0, nowReader() - state.lastAdmittedAt),
            );
            scheduleAdmissionRetry(state, remainingMs);
          } else if (
            state.active[0]?.firstTokenSeen ||
            state.lastQueueReason === "memory_reserve" ||
            state.lastQueueReason === "memory_probe_unavailable" ||
            (state.lastQueueReason === "lane_full" &&
              (state.pressureReducedLimit !== null || (state.local && !state.requestLimitConfigured)))
          ) {
            scheduleAdmissionRetry(state, PRESSURE_SAMPLE_MS);
          }
          break;
        }
        state.queue.splice(index, 1);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        const admittedNow = nowReader();
        waiter.entry.admittedAt = Math.max(
          admittedNow,
          ...state.active.map((entry) => entry.admittedAt + 1),
        );
        state.active.push(waiter.entry);
        state.lastAdmittedAt = admittedNow;
        if (
          state.requestLimitConfigured &&
          state.requestLimitCeiling > 1 &&
          state.active.length >= 2
        ) {
          state.concurrencyConfirmed = true;
        }
        waiter.resolve();
        startMonitor(state, waiter.requestTokenBudget);
      }
      if (state.queue.length === 0 && state.admissionTimer) {
        clearTimeout(state.admissionTimer);
        state.admissionTimer = null;
        state.admissionTimerDueAt = null;
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
  parentRunId?: string;
  optionalOverlap?: true;
  signal?: AbortSignal;
  onDebugEvent?: (event: string, data: Record<string, unknown>) => void;
}): Promise<ModelLaneLease> {
  if (input.signal?.aborted) throw abortError();
  const laneKey = resolveRuntimeLaneKey(input.config);
  const configuredLimit = configuredRequestLimit(input.config);
  const local = input.config.activeProfile !== "cloud";
  const requestLimitCeiling =
    configuredLimit || MODEL_LANE_AUTODISCOVERY_CEILING;
  const configuredContextLimit =
    typeof input.contextLimit === "number" &&
      Number.isFinite(input.contextLimit) &&
      input.contextLimit > 0
      ? input.contextLimit
      : typeof input.config.local?.contextLimit === "number" &&
          Number.isFinite(input.config.local.contextLimit) &&
          input.config.local.contextLimit > 0
        ? input.config.local.contextLimit
        : null;
  const state: ModelLaneState = lanes.get(laneKey) || {
    laneKey,
    local,
    contextLimit: configuredContextLimit,
    requestLimitCeiling,
    requestLimitConfigured: configuredLimit !== null,
    maxConfirmedActiveRequests: 0,
    maxConfirmedOverlappingChildren: 0,
    concurrencyConfirmed: false,
    lastAdmittedAt: 0,
    pressureReducedLimit: null,
    lastPressureEventAt: 0,
    healthySamplesSinceReduce: 0,
    active: [],
    queue: [],
    degradedUntil: 0,
    memoryUnavailable: false,
    lowMemorySamples: 0,
    monitor: null,
    admissionTimer: null,
    admissionTimerDueAt: null,
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
  if (configuredContextLimit !== null) {
    state.contextLimit = configuredContextLimit;
  }
  state.requestLimitCeiling = requestLimitCeiling;
  state.requestLimitConfigured = configuredLimit !== null;
  lanes.set(laneKey, state);
  const entry: LaneEntry = {
    id: `model-lane-${++sequence}`,
    agentKind: input.agentKind,
    subagentId: input.subagentId,
    parentRunId: input.parentRunId,
    ...(input.agentKind === "subagent" && input.optionalOverlap ? { optionalOverlap: true as const } : {}),
    admittedAt: nowReader(),
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
    queuedAt: nowReader(),
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
      void drainLane(state);
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
      waitMs: nowReader() - waiter.queuedAt,
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
      const memory = /\b(?:oom|out of memory|memory allocation)\b/i.test(error instanceof Error ? error.message : String(error));
      return degradeLane(
        state,
        memory ? "provider memory allocation failed" : "provider concurrency limit",
        memory ? "memory" : "provider_capacity",
        { lockToOne: true },
      );
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
  const local = config.activeProfile !== "cloud";
  const configuredLimit = configuredRequestLimit(config);
  const state = lanes.get(laneKey);
  const requestLimitCeiling =
    configuredLimit || MODEL_LANE_AUTODISCOVERY_CEILING;
  const maxConfirmedActiveRequests =
    state?.maxConfirmedActiveRequests || 0;
  const contextLimit =
    state?.contextLimit ??
    (typeof config.local?.contextLimit === "number" &&
      Number.isFinite(config.local.contextLimit) &&
      config.local.contextLimit > 0
      ? config.local.contextLimit
      : null);

  const maxActiveRequests = computeEffectiveLaneLimit({
    local,
    requestLimitConfigured: configuredLimit !== null,
    requestLimitCeiling,
    maxConfirmedActiveRequests,
    contextLimit,
    degradedUntil: state?.degradedUntil || 0,
    pressureReducedLimit: state?.pressureReducedLimit ?? null,
  });

  return {
    laneKey,
    configured: configuredLimit !== null,
    requestLimitCeiling,
    maxConfirmedActiveRequests,
    maxConfirmedOverlappingChildren: state?.maxConfirmedOverlappingChildren || 0,
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
  if (state.degradedUntil > nowReader()) return { allowed: false, reason: "degraded", ...base };
  if (state.memoryUnavailable) {
    return { allowed: false, reason: "memory_probe_unavailable", ...base };
  }
  if (state.safeSubagentOverlapSamples < 2 || state.lastSafeSubagentOverlapAt <= 0) {
    return { allowed: false, reason: "insufficient_safe_overlap", ...base };
  }
  if (nowReader() - state.lastSafeSubagentOverlapAt > BURST_HEALTH_TTL_MS) {
    return { allowed: false, reason: "safe_overlap_stale", ...base };
  }
  return { allowed: true, reason: "ready", ...base };
}

export function setModelLaneMemoryReaderForTests(reader?: () => Promise<SystemMemoryInfo>): void {
  memoryReader = reader || getSystemMemory;
}

export function setModelLaneStaggerMsForTests(ms?: number): void {
  staggerAdmissionMs = typeof ms === "number" && Number.isFinite(ms) && ms >= 0
    ? Math.floor(ms)
    : STAGGER_ADMISSION_MS;
}

export function setModelLaneClockForTests(clock?: () => number): void {
  nowReader = clock || Date.now;
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
  nowReader = Date.now;
  lastMemorySnapshot = null;
  staggerAdmissionMs = STAGGER_ADMISSION_MS;
}
