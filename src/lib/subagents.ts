import type { AppConfig } from "./appTypes";
import { resolveRuntimeLaneKey } from "./appConfig";
import { getModelLaneBurstAdmission } from "./modelLaneCoordinator";
import type {
  FileReadObservationIdentity,
  FileReadWindowIdentity,
} from "./orchestrator/fileReadCache";
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

export type SubagentDelegationPreference =
  | "unspecified"
  | "forbidden"
  | "allowed"
  | "preferred";

export type DelegationRuntimePhase =
  | "context"
  | "diagnostic"
  | "mutation"
  | "validation"
  | "finalization";

export type DelegationDecisionAction = "admit" | "defer" | "deny";

export type DelegationDecisionReason =
  | "explicit_preference"
  | "explicit_permission"
  | "adaptive_multi_scope"
  | "insufficient_independent_scope"
  | "pending_subagents_require_join"
  | "phase_not_eligible"
  | "user_forbidden"
  | "workspace_unavailable"
  | "subagent_recursion_forbidden"
  | "turn_capacity_reached"
  | "overlapping_active_scope"
  | "parent_scope_already_observed"
  | "runtime_health_unavailable"
  | "runtime_capacity_busy"
  | "runtime_capacity_degraded";

export interface DelegationRuntimeHealth {
  laneKey: string;
  profile: "local" | "cloud";
  state: "ready" | "busy" | "degraded" | "unknown";
  activeChildren: number;
  queuedChildren: number;
  capacityLimit: number;
  memorySafety: "safe" | "unsafe" | "unknown" | "not_applicable";
  recentSuccessfulRuns: number;
  latestStartupMs: number | null;
  latestCapacityWaitMs: number | null;
}

export interface DelegationDecision {
  action: DelegationDecisionAction;
  reason: DelegationDecisionReason;
  phase: DelegationRuntimePhase;
  preference: SubagentDelegationPreference;
  independentScopeCount: number;
  explicitScopeCount: number;
  observedScopeCount: number;
  plannedWorkItemCount: number;
  pendingSubagentCount: number;
  runtimeHealthState: DelegationRuntimeHealth["state"] | "not_provided";
}

export type SpawnSubagentResult =
  | {
      subagentId: string;
      name: string;
      status: "queued" | "running";
      scopeKey: string;
    }
  | {
      subagentId: null;
      name: string;
      status: "deferred";
      scopeKey: string;
      reason: DelegationDecisionReason;
      conflictingSubagentId?: string;
      conflictingScopeKey?: string;
    };

export interface SubagentEvidenceFactReference {
  fact: string;
  sourceToolCallId?: string;
  sourceObservationKey?: string;
  sourceVersion?: string;
  sourceRange?: FileReadWindowIdentity;
}

export interface SubagentObservationOwner {
  agentKind: "subagent";
  subagentId: string;
  parentTurnId?: string;
  runId?: string;
}

export interface SubagentEvidenceProvenance {
  source: "tool_observation";
  /** The child run that actually observed this source. */
  owner: SubagentObservationOwner;
  sourceToolCallId?: string;
  sourceObservation?: FileReadObservationIdentity;
  sourceVersion?: string;
  sourceRange?: FileReadWindowIdentity;
  factReferences?: SubagentEvidenceFactReference[];
}

export interface SubagentEvidenceItem {
  tool: string;
  target: string;
  detail: string;
  facts?: string[];
  provenance: SubagentEvidenceProvenance;
}

export interface SubagentResultEnvelope {
  subagentId: string;
  name: string;
  scopeKey: string;
  status: SubagentStatus;
  summary: string;
  /** Child-authored synthesis is a hypothesis; only provenance-backed evidence is trusted. */
  summaryTrust: "unverified_hypothesis";
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

function boundedCount(value: unknown): number {
  return Math.max(0, Math.floor(Number(value || 0)));
}

/**
 * Reduce path-like delegation hints to non-overlapping, canonical scopes.
 * Task count is deliberately excluded: several checklist items can still own
 * the same file and therefore do not prove that parallel work is independent.
 */
export function normalizeIndependentDelegationScopeKeys(values: unknown[]): string[] {
  const normalized = [...new Set(values
    .map((value) => normalizeWorkspacePathIdentity(String(value || "")))
    .filter((value) => value && value !== "."))]
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  const independent: string[] = [];
  for (const candidate of normalized) {
    if (independent.some((scope) => pathContains(scope, candidate) || pathContains(candidate, scope))) {
      continue;
    }
    independent.push(candidate);
  }
  return independent;
}

/**
 * Provider-neutral delegation admission. The runtime exposes delegation only
 * while independent read-only work can still improve context or diagnosis;
 * model/provider identity never participates in the decision.
 */
export function resolveDelegationDecision(input: {
  preference?: SubagentDelegationPreference;
  phase: DelegationRuntimePhase;
  hasWorkspace: boolean;
  explicitScopeCount?: number;
  observedScopeCount?: number;
  plannedWorkItemCount?: number;
  independentScopeKeys?: string[];
  pendingSubagentCount?: number;
  subagentDepth?: number;
  runtimeHealth?: DelegationRuntimeHealth | null;
}): DelegationDecision {
  const preference = input.preference || "unspecified";
  const explicitScopeCount = boundedCount(input.explicitScopeCount);
  const observedScopeCount = boundedCount(input.observedScopeCount);
  const plannedWorkItemCount = boundedCount(input.plannedWorkItemCount);
  const pendingSubagentCount = boundedCount(input.pendingSubagentCount);
  const independentScopeCount = normalizeIndependentDelegationScopeKeys(
    input.independentScopeKeys || [],
  ).length;
  const decision = (
    action: DelegationDecisionAction,
    reason: DelegationDecisionReason,
  ): DelegationDecision => ({
    action,
    reason,
    phase: input.phase,
    preference,
    independentScopeCount,
    explicitScopeCount,
    observedScopeCount,
    plannedWorkItemCount,
    pendingSubagentCount,
    runtimeHealthState: input.runtimeHealth?.state || "not_provided",
  });

  if (boundedCount(input.subagentDepth) > 0) {
    return decision("deny", "subagent_recursion_forbidden");
  }
  if (!input.hasWorkspace) return decision("deny", "workspace_unavailable");
  if (preference === "forbidden") return decision("deny", "user_forbidden");
  if (input.phase !== "context" && input.phase !== "diagnostic") {
    return decision("defer", "phase_not_eligible");
  }
  if (pendingSubagentCount > 0) {
    return decision("defer", "pending_subagents_require_join");
  }
  if (preference === "preferred") return decision("admit", "explicit_preference");
  if (preference === "allowed") return decision("admit", "explicit_permission");
  // Auto delegation is an initial-context optimization only. Files already
  // read by the parent and checklist length are evidence/telemetry, not a
  // reason to reopen fan-out during diagnosis.
  if (
    input.phase === "context" &&
    explicitScopeCount >= 2 &&
    independentScopeCount >= 2
  ) {
    if (!input.runtimeHealth || input.runtimeHealth.state === "unknown") {
      return decision("defer", "runtime_health_unavailable");
    }
    if (input.runtimeHealth.state === "degraded") {
      return decision("defer", "runtime_capacity_degraded");
    }
    if (input.runtimeHealth.state === "busy") {
      return decision("defer", "runtime_capacity_busy");
    }
    return decision("admit", "adaptive_multi_scope");
  }
  return decision("defer", "insufficient_independent_scope");
}

export function buildSubagentPolicyDeferral(input: {
  name?: string;
  scopeKey?: string;
  reason: DelegationDecisionReason;
  conflictingSubagentId?: string;
  conflictingScopeKey?: string;
}): Extract<SpawnSubagentResult, { status: "deferred" }> {
  return {
    subagentId: null,
    name: String(input.name || "delegation").trim().slice(0, 32) || "delegation",
    status: "deferred",
    scopeKey: String(input.scopeKey || "delegation").trim().slice(0, 96) || "delegation",
    reason: input.reason,
    ...(input.conflictingSubagentId
      ? { conflictingSubagentId: input.conflictingSubagentId }
      : {}),
    ...(input.conflictingScopeKey
      ? { conflictingScopeKey: input.conflictingScopeKey }
      : {}),
  };
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
const SUBAGENT_RUNTIME_HEALTH_TTL_MS = 10 * 60_000;

interface SubagentRuntimeSample {
  recordedAt: number;
  startupMs: number;
  capacityWaitMs: number;
  successful: boolean;
}

const runtimeSamplesByLane = new Map<string, SubagentRuntimeSample[]>();

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
// Reservations serialize child ownership without blocking the parent. They
// become active leases only when a child begins a real source-tool operation.
const scopeReservations = new Map<string, SubagentScopeLease>();
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
  // Coordination records can be released by join, TTL cleanup, or parent
  // finalization. All are terminal ownership boundaries for this parent turn,
  // so a stale scope lease must never survive the record that owned it.
  releaseSubagentScopeLease(run.subagentId);
  return true;
}

export function parseSubagentAllowedPaths(value: unknown, workspace = ""): string[] {
  const paths = String(value || "")
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => relativizeToWorkspacePath(entry, workspace))
    .map((entry) => String(entry || "")
      .replace(/\\/g, "/")
      .replace(/^[`'\"]+|[`'\"]+$/g, "")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "")
      .trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return paths.filter((path) => {
    const identity = normalizeWorkspacePathIdentity(path);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Count delegated paths already covered by parent-owned source observations.
 * `path:` is the canonical runtime evidence key; `file:` remains accepted for
 * snapshots created before the targeting-ledger rename.
 */
export function countParentObservedDelegationPaths(input: {
  allowedPaths: string[];
  evidenceKeys: Iterable<string>;
}): number {
  const observedPaths = [...input.evidenceKeys]
    .map((entry) => {
      if (entry.startsWith("path:")) return entry.slice("path:".length);
      if (entry.startsWith("file:")) return entry.slice("file:".length);
      return "";
    })
    .map(normalizeWorkspacePathIdentity)
    .filter(Boolean);
  return input.allowedPaths
    .map(normalizeWorkspacePathIdentity)
    .filter(Boolean)
    .filter((allowed) => observedPaths.some((observed) =>
      pathContains(allowed, observed) || pathContains(observed, allowed)
    )).length;
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

export function reserveSubagentScope(input: SubagentScopeLease): void {
  scopeReservations.set(input.subagentId, {
    ...input,
    allowedPaths: input.allowedPaths.map(normalizeWorkspacePathIdentity).filter(Boolean),
  });
}

export function activateSubagentScopeLease(subagentId: string): boolean {
  if (scopeLeases.has(subagentId)) return true;
  const reservation = scopeReservations.get(subagentId);
  if (!reservation) return false;
  scopeLeases.set(subagentId, reservation);
  return true;
}

export function releaseSubagentScopeLease(subagentId: string): void {
  scopeLeases.delete(subagentId);
  scopeReservations.delete(subagentId);
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
  const childOwnership = new Map<string, SubagentScopeLease>([
    ...scopeReservations.entries(),
    ...scopeLeases.entries(),
  ]);
  for (const lease of childOwnership.values()) {
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

export function recordSubagentRuntimeSample(input: {
  laneKey: string;
  startupMs: number;
  capacityWaitMs: number;
  successful: boolean;
  recordedAt?: number;
}): void {
  const recordedAt = input.recordedAt || Date.now();
  const samples = runtimeSamplesByLane.get(input.laneKey) || [];
  runtimeSamplesByLane.set(input.laneKey, [
    ...samples.filter((sample) =>
      recordedAt - sample.recordedAt <= SUBAGENT_RUNTIME_HEALTH_TTL_MS
    ),
    {
      recordedAt,
      startupMs: Math.max(0, Math.floor(input.startupMs)),
      capacityWaitMs: Math.max(0, Math.floor(input.capacityWaitMs)),
      successful: input.successful,
    },
  ].slice(-8));
}

/**
 * A read-only snapshot used by Auto delegation. Missing runtime observations
 * stay unknown; policy limits are not fabricated into proof that a local
 * model has enough memory or that child startup is inexpensive.
 */
export function getSubagentAdmissionHealth(
  policy: SubagentCapacityPolicy,
  now = Date.now(),
): DelegationRuntimeHealth {
  const lane = capacityLanes.get(policy.laneKey);
  const capacityLimit = effectiveLaneLimit(policy);
  const activeChildren = lane?.active || 0;
  const queuedChildren = lane?.queue.length || 0;
  const degraded = (degradedUntilByLane.get(policy.laneKey) || 0) > now;
  const recentSamples = (runtimeSamplesByLane.get(policy.laneKey) || [])
    .filter((sample) => now - sample.recordedAt <= SUBAGENT_RUNTIME_HEALTH_TTL_MS);
  const successfulSamples = recentSamples.filter((sample) => sample.successful);
  const latestSuccessfulSample = successfulSamples[successfulSamples.length - 1] || null;
  const burstAdmission = getModelLaneBurstAdmission(policy.laneKey);
  const memorySafety: DelegationRuntimeHealth["memorySafety"] = policy.profile === "cloud"
    ? "not_applicable"
    : burstAdmission.allowed
      ? "safe"
      : burstAdmission.reason === "degraded" || burstAdmission.reason === "memory_probe_unavailable"
        ? "unsafe"
        : "unknown";
  const state: DelegationRuntimeHealth["state"] = degraded || memorySafety === "unsafe"
    ? "degraded"
    : queuedChildren > 0 || activeChildren >= capacityLimit
      ? "busy"
      : latestSuccessfulSample || memorySafety === "safe"
        ? "ready"
        : "unknown";
  return {
    laneKey: policy.laneKey,
    profile: policy.profile,
    state,
    activeChildren,
    queuedChildren,
    capacityLimit,
    memorySafety,
    recentSuccessfulRuns: successfulSamples.length,
    latestStartupMs: latestSuccessfulSample?.startupMs ?? null,
    latestCapacityWaitMs: latestSuccessfulSample?.capacityWaitMs ?? null,
  };
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
    releaseSubagentScopeLease(run.id);
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
  runtimeSamplesByLane.clear();
  coordinatedRuns.clear();
  createdRunCounts.clear();
  scopeLeases.clear();
  scopeReservations.clear();
}
