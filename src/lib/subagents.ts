import type { AppConfig } from "./appTypes";
import { resolveRuntimeLaneKey } from "./appConfig";
import type { MainThreadEvent } from "./turnEvents";
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
      records.set(event.subagentId, {
        ...current,
        closedAt: event.closedAt,
        updatedAt: Math.max(current.updatedAt, event.closedAt),
      });
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

function coordinationKey(threadId: string, parentTurnId: string, subagentId: string): string {
  return `${threadId}::${parentTurnId}::${subagentId}`;
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
  coordinatedRuns.set(key, input);
  void input.completion.then((result) => {
    const current = coordinatedRuns.get(key);
    if (current) current.result = result;
  });
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
  return { results, pendingIds: [] };
}

export function getCoordinatedSubagentRunCount(threadId: string, parentTurnId: string): number {
  return [...coordinatedRuns.values()].filter((run) =>
    run.threadId === threadId && run.parentTurnId === parentTurnId
  ).length;
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
  return policy.maxActiveRequests;
}

function drainCapacityLane(state: CapacityLaneState): void {
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
}

async function acquireSubagentCapacity(
  policy: SubagentCapacityPolicy,
  signal?: AbortSignal,
): Promise<{ queued: boolean; release: () => void }> {
  if (signal?.aborted) throw makeAbortError();
  const limit = effectiveLaneLimit(policy);
  const state = capacityLanes.get(policy.laneKey) || { active: 0, limit, queue: [] };
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
  if (lane) lane.limit = 1;
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

export function resetSubagentRuntimeForTests(): void {
  capacityLanes.clear();
  degradedUntilByLane.clear();
  childAbortControllers.clear();
  coordinatedRuns.clear();
  scopeLeases.clear();
}
