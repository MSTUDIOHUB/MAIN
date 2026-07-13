import type { AppConfig } from "./appTypes";
import { resolveRuntimeLaneKey } from "./appConfig";
import { getModelLaneBurstAdmission } from "./modelLaneCoordinator";
import { appendRuntimeEvent, withEventSchema, type MainThreadEvent } from "./turnEvents";
import {
  normalizeWorkspacePathIdentity,
  relativizeToWorkspacePath,
} from "./workspacePaths";

export type SubagentStatus =
  | "queued"
  | "starting"
  | "running"
  | "summarizing"
  | "completed"
  | "blocked"
  | "degraded"
  | "failed"
  | "canceled";

export type SubagentActivityStatus = "running" | "completed" | "failed" | "canceled";

export interface SubagentActivity {
  id: string;
  timestampMs: number;
  status: SubagentActivityStatus;
  title: string;
  tool?: string;
  target?: string;
  detail?: string;
}

export interface SubagentProgress {
  phase: "queued" | "starting" | "waiting" | "thinking" | "tool" | "summarizing" | "done";
  title: string;
  tool?: string;
  target?: string;
  completedToolCalls?: number;
}

export interface SubagentRunSnapshot {
  id: string;
  parentTurnId: string;
  threadId: string;
  name: string;
  role: string;
  objective: string;
  scopeKey?: string;
  scope?: string;
  allowedPaths?: string[];
  expectedOutput?: string;
  status: SubagentStatus;
  profile: "local" | "cloud";
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  closedAt?: number;
  summary?: string;
  error?: string;
  progress?: SubagentProgress;
}

export type SubagentRunPatch = Partial<Pick<
  SubagentRunSnapshot,
  | "status"
  | "updatedAt"
  | "startedAt"
  | "completedAt"
  | "closedAt"
  | "summary"
  | "error"
  | "progress"
>>;

export interface SubagentRunRecord extends SubagentRunSnapshot {
  activities: SubagentActivity[];
}

export interface SpawnSubagentRequest {
  name?: string;
  role?: string;
  objective: string;
  scopeKey?: string;
  scope?: string;
  contextHints?: string;
  allowedPaths?: string;
  expectedOutput?: string;
}

export interface SpawnSubagentResult {
  subagentId: string;
  name: string;
  status: "queued" | "running";
  scopeKey: string;
}

export interface SubagentEvidenceItem {
  tool: string;
  target: string;
  detail: string;
}

export interface SubagentResultEnvelope {
  subagentId: string;
  name: string;
  scopeKey: string;
  status: SubagentStatus;
  summary: string;
  evidence: SubagentEvidenceItem[];
  blocker?: string;
  remainingWork?: string;
  error?: string;
}

export interface WaitSubagentsRequest {
  subagentIds?: string[];
}

export interface WaitSubagentsResult {
  results: SubagentResultEnvelope[];
  pendingIds: string[];
}

export interface SubagentExecutionScope {
  subagentId: string;
  parentSessionKey: string;
  scopeKey: string;
  workspace: string;
  allowedPaths: string[];
}

export interface RuntimeTraceContext {
  threadId: string;
  turnId: string;
  runId: string;
  parentRunId: string | null;
  agentKind: "parent" | "subagent";
  subagentId?: string;
}

export interface SubagentCapacityPolicy {
  laneKey: string;
  profile: "local" | "cloud";
  provider: string;
  model: string;
  maxActiveRequests: number;
  maxBurstActiveRequests: number;
  maxCreatedPerTurn: number;
  childMaxIterations: number;
}

const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentStatus>([
  "completed",
  "blocked",
  "degraded",
  "failed",
  "canceled",
]);

const ACTIVE_SUBAGENT_STATUSES = new Set<SubagentStatus>([
  "queued",
  "starting",
  "running",
  "summarizing",
]);

function resolveConfiguredModel(config: AppConfig): { provider: string; model: string } {
  if (config.activeProfile === "local") {
    return {
      provider: String(config.local.provider || "Local"),
      model: String(config.local.model || "Unselected local model"),
    };
  }

  const activeServer = config.cloudServers.find((server) => server.id === config.activeCloudServerId);
  return {
    provider: String(activeServer?.provider || config.cloud.provider || "Cloud"),
    model: String(activeServer?.model || config.cloud.model || "Unselected cloud model"),
  };
}

export function resolveSubagentCapacityPolicy(config: AppConfig): SubagentCapacityPolicy {
  const profile = config.activeProfile === "cloud" ? "cloud" : "local";
  const configured = resolveConfiguredModel(config);
  return {
    laneKey: resolveRuntimeLaneKey(config),
    profile,
    provider: configured.provider,
    model: configured.model,
    // This is the number of child workflows. Model-request concurrency is
    // coordinated separately and reserves capacity for the parent thread.
    maxActiveRequests: profile === "local" ? 2 : 3,
    maxBurstActiveRequests: 3,
    maxCreatedPerTurn: profile === "local" ? 3 : 6,
    childMaxIterations: profile === "local" ? 6 : 8,
  };
}

export function isSubagentTerminalStatus(status: SubagentStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(status);
}

export function isSubagentActiveStatus(status: SubagentStatus): boolean {
  return ACTIVE_SUBAGENT_STATUSES.has(status);
}

export function projectSubagentRuns(events: readonly MainThreadEvent[]): SubagentRunRecord[] {
  const records = new Map<string, SubagentRunRecord>();

  for (const event of events) {
    if (event.type === "subagent.created") {
      records.set(event.subagent.id, {
        ...event.subagent,
        activities: [],
      });
      continue;
    }

    if (event.type === "subagent.updated") {
      const current = records.get(event.subagentId);
      if (!current) continue;
      const activities = event.activity
        ? [...current.activities, event.activity].slice(-80)
        : current.activities;
      records.set(event.subagentId, {
        ...current,
        ...event.patch,
        activities,
      });
      continue;
    }

    if (event.type === "subagent.closed") {
      const current = records.get(event.subagentId);
      if (!current) continue;
      const terminalStatus = isSubagentTerminalStatus(event.reason as SubagentStatus)
        ? event.reason as SubagentStatus
        : event.reason === "orphaned_after_restart" || event.reason === "runtime_controller_missing"
          ? "canceled"
          : current.status;
      records.set(event.subagentId, {
        ...current,
        status: terminalStatus,
        closedAt: event.closedAt,
        ...(isSubagentTerminalStatus(terminalStatus) && !current.completedAt
          ? { completedAt: event.closedAt }
          : {}),
        updatedAt: Math.max(current.updatedAt, event.closedAt),
      });
      continue;
    }

    if (event.type === "subagent.dismissed") {
      records.delete(event.subagentId);
    }
  }

  return [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function getSubagentRunsForTurn(
  events: readonly MainThreadEvent[],
  parentTurnId: string,
): SubagentRunRecord[] {
  return projectSubagentRuns(events).filter((run) => run.parentTurnId === parentTurnId);
}

interface CapacityWaiter {
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

interface CapacityLaneState {
  active: number;
  limit: number;
  queue: CapacityWaiter[];
  policy: SubagentCapacityPolicy;
  reevaluationTimer: ReturnType<typeof setTimeout> | null;
}

const capacityLanes = new Map<string, CapacityLaneState>();
const degradedUntilByLane = new Map<string, number>();
const childAbortControllers = new Map<string, AbortController>();

export interface CoordinatedSubagentRun {
  threadId: string;
  parentTurnId: string;
  subagentId: string;
  name: string;
  scopeKey: string;
  completion: Promise<SubagentResultEnvelope>;
  result?: SubagentResultEnvelope;
  createdAt?: number;
  completedAt?: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface SubagentScopeLease {
  threadId: string;
  parentTurnId: string;
  subagentId: string;
  scopeKey: string;
  workspace: string;
  allowedPaths: string[];
  createdAt: number;
}

const coordinatedRuns = new Map<string, CoordinatedSubagentRun>();
const scopeLeases = new Map<string, SubagentScopeLease>();
const createdRunCounts = new Map<string, number>();
const COORDINATED_RESULT_TTL_MS = 10 * 60_000;

function coordinationKey(threadId: string, parentTurnId: string, subagentId: string): string {
  return `${threadId}::${parentTurnId}::${subagentId}`;
}

function parentCoordinationKey(threadId: string, parentTurnId: string): string {
  return `${threadId}::${parentTurnId}`;
}

function releaseCoordinatedRun(key: string): boolean {
  const run = coordinatedRuns.get(key);
  if (!run) return false;
  if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
  coordinatedRuns.delete(key);
  return true;
}

export function parseSubagentAllowedPaths(value: unknown, workspace = ""): string[] {
  const paths = String(value || "")
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => relativizeToWorkspacePath(entry, workspace))
    .map(normalizeWorkspacePathIdentity)
    .filter(Boolean);
  return [...new Set(paths)];
}

function pathContains(scopePath: string, targetPath: string): boolean {
  const scope = normalizeWorkspacePathIdentity(scopePath);
  const target = normalizeWorkspacePathIdentity(targetPath);
  if (!scope || !target) return false;
  if (scope === ".") return true;
  return target === scope || target.startsWith(`${scope}/`);
}

export function acquireSubagentScopeLease(input: SubagentScopeLease): void {
  scopeLeases.set(input.subagentId, {
    ...input,
    allowedPaths: input.allowedPaths.map(normalizeWorkspacePathIdentity).filter(Boolean),
  });
}

export function releaseSubagentScopeLease(subagentId: string): void {
  scopeLeases.delete(subagentId);
}

export function findSubagentScopeConflict(input: {
  threadId: string;
  targetPath: string;
  currentSubagentId?: string | null;
}): SubagentScopeLease | null {
  for (const lease of scopeLeases.values()) {
    if (lease.threadId !== input.threadId) continue;
    if (lease.subagentId === input.currentSubagentId) continue;
    const target = normalizeWorkspacePathIdentity(
      relativizeToWorkspacePath(input.targetPath, lease.workspace),
    );
    if (!target) continue;
    if (lease.allowedPaths.some((allowed) =>
      pathContains(allowed, target) || pathContains(target, allowed)
    )) return lease;
  }
  return null;
}

export function findSubagentLeaseOverlap(input: {
  threadId: string;
  workspace: string;
  allowedPaths: string[];
}): SubagentScopeLease | null {
  const candidates = input.allowedPaths
    .map((path) => normalizeWorkspacePathIdentity(relativizeToWorkspacePath(path, input.workspace)))
    .filter(Boolean);
  for (const lease of scopeLeases.values()) {
    if (lease.threadId !== input.threadId) continue;
    if (candidates.some((candidate) => lease.allowedPaths.some((allowed) =>
      pathContains(allowed, candidate) || pathContains(candidate, allowed)
    ))) return lease;
  }
  return null;
}

export function validateSubagentScopeTarget(
  scope: SubagentExecutionScope,
  targetPath: string,
): boolean {
  const target = normalizeWorkspacePathIdentity(
    relativizeToWorkspacePath(targetPath, scope.workspace),
  );
  return !!target && scope.allowedPaths.some((allowed) => pathContains(allowed, target));
}

export function registerCoordinatedSubagentRun(input: CoordinatedSubagentRun): void {
  const key = coordinationKey(input.threadId, input.parentTurnId, input.subagentId);
  const parentKey = parentCoordinationKey(input.threadId, input.parentTurnId);
  if (!coordinatedRuns.has(key)) {
    createdRunCounts.set(parentKey, (createdRunCounts.get(parentKey) || 0) + 1);
  }
  const run: CoordinatedSubagentRun = {
    ...input,
    createdAt: input.createdAt || Date.now(),
  };
  coordinatedRuns.set(key, run);
  void input.completion.then((result) => {
    const current = coordinatedRuns.get(key);
    if (!current) return;
    current.result = result;
    current.completedAt = Date.now();
    current.cleanupTimer = setTimeout(() => {
      releaseCoordinatedRun(key);
    }, COORDINATED_RESULT_TTL_MS);
  });
}

export function getPendingCoordinatedSubagentIds(threadId: string, parentTurnId: string): string[] {
  return [...coordinatedRuns.values()]
    .filter((run) =>
      run.threadId === threadId &&
      run.parentTurnId === parentTurnId
    )
    .map((run) => run.subagentId);
}

export async function waitForCoordinatedSubagents(input: {
  threadId: string;
  parentTurnId: string;
  subagentIds?: string[];
}): Promise<WaitSubagentsResult> {
  const requestedIds = new Set((input.subagentIds || []).filter(Boolean));
  const runs = [...coordinatedRuns.values()].filter((run) =>
    run.threadId === input.threadId &&
    run.parentTurnId === input.parentTurnId &&
    (requestedIds.size === 0 || requestedIds.has(run.subagentId))
  );
  if (runs.length === 0) return { results: [], pendingIds: [...requestedIds] };
  const results = await Promise.all(runs.map((run) => run.completion));
  for (const run of runs) {
    releaseCoordinatedRun(coordinationKey(run.threadId, run.parentTurnId, run.subagentId));
  }
  return { results, pendingIds: [] };
}

export function getCoordinatedSubagentRunCount(threadId: string, parentTurnId: string): number {
  return createdRunCounts.get(parentCoordinationKey(threadId, parentTurnId)) || 0;
}

export interface ParentSubagentFinalizationResult {
  requestedIds: string[];
  canceledIds: string[];
  controllerMissingIds: string[];
  settledIds: string[];
  timedOutIds: string[];
  releasedCount: number;
}

export async function finalizeCoordinatedSubagentsForParent(input: {
  threadId: string;
  parentTurnId: string;
  graceMs?: number;
}): Promise<ParentSubagentFinalizationResult> {
  const runs = [...coordinatedRuns.values()].filter((run) =>
    run.threadId === input.threadId && run.parentTurnId === input.parentTurnId
  );
  const requestedIds = runs.filter((run) => !run.result).map((run) => run.subagentId);
  const canceledIds: string[] = [];
  const controllerMissingIds: string[] = [];
  for (const id of requestedIds) {
    if (cancelSubagentRun(id)) canceledIds.push(id);
    else controllerMissingIds.push(id);
  }

  const graceMs = Math.max(0, input.graceMs ?? 2_000);
  const completions = runs.map(async (run) => {
    await run.completion.catch(() => undefined);
    return run.subagentId;
  });
  const settledIds = new Set<string>();
  if (completions.length > 0 && graceMs > 0) {
    await Promise.race([
      Promise.all(completions.map(async (completion) => {
        const id = await completion;
        settledIds.add(id);
      })),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
  }

  let releasedCount = 0;
  for (const run of runs) {
    if (releaseCoordinatedRun(coordinationKey(run.threadId, run.parentTurnId, run.subagentId))) {
      releasedCount += 1;
    }
  }
  createdRunCounts.delete(parentCoordinationKey(input.threadId, input.parentTurnId));
  return {
    requestedIds,
    canceledIds,
    controllerMissingIds,
    settledIds: [...settledIds],
    timedOutIds: requestedIds.filter((id) => !settledIds.has(id)),
    releasedCount,
  };
}

function makeAbortError(): Error {
  const error = new Error("Subagent execution was canceled.");
  error.name = "AbortError";
  return error;
}

function effectiveLaneLimit(policy: SubagentCapacityPolicy): number {
  const degradedUntil = degradedUntilByLane.get(policy.laneKey) || 0;
  if (degradedUntil > Date.now()) return 1;
  if (degradedUntil > 0) degradedUntilByLane.delete(policy.laneKey);
  if (
    policy.profile === "local" &&
    policy.maxBurstActiveRequests > policy.maxActiveRequests &&
    getModelLaneBurstAdmission(policy.laneKey).allowed
  ) {
    return policy.maxBurstActiveRequests;
  }
  return policy.maxActiveRequests;
}

export function getSubagentBurstAdmission(policy: SubagentCapacityPolicy) {
  const degradedUntil = degradedUntilByLane.get(policy.laneKey) || 0;
  if (degradedUntil > Date.now()) {
    return {
      allowed: false,
      reason: "capacity_degraded",
      safeOverlapSamples: 0,
      lastSafeOverlapAt: null,
      activeRequests: 0,
    };
  }
  return getModelLaneBurstAdmission(policy.laneKey);
}

function scheduleCapacityReevaluation(state: CapacityLaneState): void {
  if (state.reevaluationTimer || state.queue.length === 0) return;
  state.reevaluationTimer = setTimeout(() => {
    state.reevaluationTimer = null;
    state.limit = effectiveLaneLimit(state.policy);
    drainCapacityLane(state);
  }, 1_000);
}

function drainCapacityLane(state: CapacityLaneState): void {
  state.limit = effectiveLaneLimit(state.policy);
  while (state.active < state.limit && state.queue.length > 0) {
    const waiter = state.queue.shift()!;
    if (waiter.signal?.aborted) {
      waiter.reject(makeAbortError());
      continue;
    }
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    state.active += 1;
    waiter.resolve();
  }
  if (state.queue.length > 0) scheduleCapacityReevaluation(state);
  else if (state.reevaluationTimer) {
    clearTimeout(state.reevaluationTimer);
    state.reevaluationTimer = null;
  }
}

async function acquireSubagentCapacity(
  policy: SubagentCapacityPolicy,
  signal?: AbortSignal,
): Promise<{ queued: boolean; release: () => void }> {
  if (signal?.aborted) throw makeAbortError();
  const limit = effectiveLaneLimit(policy);
  const state = capacityLanes.get(policy.laneKey) || {
    active: 0,
    limit,
    queue: [],
    policy,
    reevaluationTimer: null,
  };
  state.policy = policy;
  state.limit = limit;
  capacityLanes.set(policy.laneKey, state);

  let queued = false;
  if (state.active < state.limit) {
    state.active += 1;
  } else {
    queued = true;
    await new Promise<void>((resolve, reject) => {
      const waiter: CapacityWaiter = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = state.queue.indexOf(waiter);
          if (index >= 0) state.queue.splice(index, 1);
          reject(makeAbortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      state.queue.push(waiter);
      scheduleCapacityReevaluation(state);
    });
  }

  let released = false;
  return {
    queued,
    release: () => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      drainCapacityLane(state);
    },
  };
}

export async function withSubagentCapacity<T>(input: {
  policy: SubagentCapacityPolicy;
  signal?: AbortSignal;
  onQueued?: () => void;
  task: () => Promise<T>;
}): Promise<T> {
  const existingLane = capacityLanes.get(input.policy.laneKey);
  if (existingLane && existingLane.active >= effectiveLaneLimit(input.policy)) {
    input.onQueued?.();
  }
  const acquisitionPromise = acquireSubagentCapacity(input.policy, input.signal);
  const acquisition = await acquisitionPromise;
  try {
    return await input.task();
  } finally {
    acquisition.release();
  }
}

export function reportSubagentCapacityFailure(
  policy: SubagentCapacityPolicy,
  error: unknown,
): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const shouldDegrade = /SUBAGENT_MEMORY_PRESSURE_DEGRADED|\b(?:oom|out of memory|memory allocation|429|524)\b|connection reset|socket hang up|gateway timeout|no visible progress|stream.*timeout/i.test(message);
  if (!shouldDegrade) return false;
  degradedUntilByLane.set(policy.laneKey, Date.now() + 5 * 60_000);
  const lane = capacityLanes.get(policy.laneKey);
  if (lane) {
    lane.limit = 1;
    drainCapacityLane(lane);
  }
  return true;
}

export function registerSubagentAbortController(id: string, controller: AbortController): void {
  childAbortControllers.set(id, controller);
}

export function unregisterSubagentAbortController(id: string): void {
  childAbortControllers.delete(id);
}

export function cancelSubagentRun(id: string): boolean {
  const controller = childAbortControllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function hasLiveSubagentController(id: string): boolean {
  return childAbortControllers.has(id);
}

export function reconcileOrphanedSubagentEvents(
  events: readonly MainThreadEvent[],
  now = Date.now(),
): MainThreadEvent[] {
  let reconciled = [...events];
  for (const run of projectSubagentRuns(events)) {
    if (!isSubagentActiveStatus(run.status) || hasLiveSubagentController(run.id)) continue;
    const error = "SUBAGENT_ORPHANED_AFTER_RESTART: the persisted run has no live runtime controller and was closed during session restore.";
    reconciled = appendRuntimeEvent(reconciled, withEventSchema({
      type: "subagent.updated",
      threadId: run.threadId,
      turnId: run.parentTurnId,
      timestampMs: now,
      subagentId: run.id,
      patch: {
        status: "canceled",
        updatedAt: now,
        completedAt: now,
        error,
        progress: {
          phase: "done",
          title: "Runtime record reconciled after restart",
          completedToolCalls: run.progress?.completedToolCalls || 0,
        },
      },
      activity: {
        id: `${run.id}-orphan-${now}`,
        timestampMs: now,
        status: "canceled",
        title: "Orphaned runtime record closed during restore",
        detail: error,
      },
    }));
    reconciled = appendRuntimeEvent(reconciled, withEventSchema({
      type: "subagent.closed",
      threadId: run.threadId,
      turnId: run.parentTurnId,
      timestampMs: now,
      subagentId: run.id,
      closedAt: now,
      reason: "orphaned_after_restart",
    }));
  }
  return reconciled;
}

export function resetSubagentRuntimeForTests(): void {
  for (const lane of capacityLanes.values()) {
    if (lane.reevaluationTimer) clearTimeout(lane.reevaluationTimer);
  }
  capacityLanes.clear();
  degradedUntilByLane.clear();
  childAbortControllers.clear();
  coordinatedRuns.clear();
  createdRunCounts.clear();
  scopeLeases.clear();
}
