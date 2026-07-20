import { appendDebugLog } from "./debugLog";
import {
  isPlanExecutionRunProvenanceForOwner,
  normalizePlanExecutionRunProvenance,
  type PlanExecutionRunProvenance,
} from "./planExecutionProvenance";
import type { TerminalResultKind } from "./turnEvents";

export const HARNESS_RUN_MARKER_STORAGE_KEY = "main.harnessRunMarker.v1";
const HARNESS_INSTANCE_STORAGE_KEY = "main.harnessInstance.v1";
const HARNESS_PENDING_UNCLEAN_RESTART_KEY = "main.harnessPendingUncleanRestart.v1";

export type HarnessRunStatus = "running" | "completed" | "paused" | "error" | "idle" | "closed";

export interface HarnessRunMarker {
  schemaVersion: 1;
  /** Outer process lease used for crash-safe persistence ownership. */
  runId: string;
  /** Current child run that owns any actionable request shown in the UI. */
  activeRunId?: string | null;
  activeParentRunId?: string | null;
  /** Historical classification of the active child Run; revocation never reclassifies it as generic. */
  activePlanExecutionProvenance?: PlanExecutionRunProvenance | null;
  /** Previous execution run in the same logical turn. Absent on legacy markers. */
  parentRunId?: string | null;
  /** Earliest durable message index for this logical turn across resumed runs. */
  turnStartMessageIndex?: number;
  /** Last derived Goal slice run, used to preserve slice lineage across iterations. */
  lastGoalSliceRunId?: string | null;
  instanceId: string;
  sessionKey: string;
  workspace: string | null;
  sessionId: number | null;
  turnId: string | null;
  status: HarnessRunStatus;
  /** Exact completed result for crash restore; Harness status alone is lossy. */
  terminalResultKind?: TerminalResultKind | null;
  workflowMode: string;
  runtimeIntent: string;
  planStage: string;
  isPlanApproved: boolean;
  iteration: number;
  maxIterations: number;
  messagesLen: number;
  toolCount: number;
  latestTool: string | null;
  latestToolTarget: string | null;
  activeStreamId: string | null;
  streamStatus: string | null;
  streamChunkCount: number;
  streamByteCount: number;
  streamElapsedMs: number | null;
  streamLifecycleStatus: string | null;
  lastStreamError: string | null;
  startedAt: number;
  updatedAt: number;
  closedAt: number | null;
  closeReason: string | null;
}

export interface HarnessRunOwner {
  runId: string;
  sessionKey: string;
  turnId: string;
  /** Optional exact-process fence for async close paths. */
  instanceId?: string;
  /** Optional lease-generation fence for a reused logical identity. */
  startedAt?: number;
}

export interface ExactHarnessRunOwner extends HarnessRunOwner {
  instanceId: string;
  startedAt: number;
}

export function isHarnessRunMarkerOwnedByRun(
  marker: HarnessRunMarker | null | undefined,
  owner: HarnessRunOwner,
): boolean {
  return !!marker &&
    marker.status === "running" &&
    marker.runId === owner.runId &&
    marker.sessionKey === owner.sessionKey &&
    marker.turnId === owner.turnId &&
    (owner.instanceId == null || marker.instanceId === owner.instanceId) &&
    (owner.startedAt == null || marker.startedAt === owner.startedAt);
}

/** The outer harness lease and the currently actionable child run are
 * intentionally separate. UI/request identity must use this projection while
 * persistence ownership continues to use `marker.runId`. */
export function getHarnessActionRunId(
  marker: HarnessRunMarker | null | undefined,
): string | null {
  const activeRunId = typeof marker?.activeRunId === "string"
    ? marker.activeRunId.trim()
    : "";
  if (activeRunId) return activeRunId;
  const outerRunId = typeof marker?.runId === "string" ? marker.runId.trim() : "";
  return outerRunId || null;
}

export interface HarnessUncleanRestartDiagnostic {
  detectedAt: number;
  previousInstanceId: string | null;
  marker: HarnessRunMarker;
}

interface HarnessInstanceMarker {
  schemaVersion: 1;
  instanceId: string;
  startedAt: number;
  updatedAt: number;
  closedAt: number | null;
  closeReason: string | null;
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function canUseLocalStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function writeJson(key: string, value: unknown): boolean {
  if (!canUseLocalStorage()) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // localStorage can be unavailable in restricted WebView states.
    return false;
  }
}

function readJson<T>(key: string): T | null {
  if (!canUseLocalStorage()) return null;
  try {
    return safeJsonParse<T>(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

function removeKey(key: string) {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function createInstanceId() {
  return `main-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeHarnessRunMarker(value: unknown): HarnessRunMarker | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<HarnessRunMarker>;
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : "";
  if (!sessionKey) return null;
  const startedAt = Math.max(0, Number(record.startedAt) || Date.now());
  const turnId = typeof record.turnId === "string" ? record.turnId : null;
  const runId = typeof record.runId === "string" && record.runId.trim()
    ? record.runId
    : `legacy-${sessionKey}-${turnId || "no-turn"}-${startedAt}`;
  const activeRunId = typeof record.activeRunId === "string" && record.activeRunId.trim()
    ? record.activeRunId.trim()
    : runId;
  const activeParentRunId = typeof record.activeParentRunId === "string" && record.activeParentRunId.trim()
    ? record.activeParentRunId.trim()
    : null;
  const status: HarnessRunStatus = record.status || "running";
  const explicitTerminalResultKind = record.terminalResultKind === "success" ||
    record.terminalResultKind === "partial" ||
    record.terminalResultKind === "blocked" ||
    record.terminalResultKind === "error" ||
    record.terminalResultKind === "canceled"
      ? record.terminalResultKind
      : null;
  const terminalResultKind = status === "error"
    ? explicitTerminalResultKind || "error"
    : status === "completed" || status === "closed"
    ? explicitTerminalResultKind
    : null;
  const hasPlanExecutionProvenance = Object.prototype.hasOwnProperty.call(
    record,
    "activePlanExecutionProvenance",
  );
  const candidatePlanExecutionProvenance = normalizePlanExecutionRunProvenance(
    record.activePlanExecutionProvenance,
  );
  const activePlanExecutionProvenance =
    candidatePlanExecutionProvenance &&
    turnId &&
    isPlanExecutionRunProvenanceForOwner(candidatePlanExecutionProvenance, {
      sessionKey,
      turnId,
      runId: activeRunId,
      parentRunId: activeParentRunId,
    })
      ? candidatePlanExecutionProvenance
      : null;
  return {
    schemaVersion: 1,
    runId,
    activeRunId,
    activeParentRunId,
    ...(hasPlanExecutionProvenance ? { activePlanExecutionProvenance } : {}),
    parentRunId: typeof record.parentRunId === "string" && record.parentRunId.trim()
      ? record.parentRunId.trim()
      : null,
    turnStartMessageIndex: Math.max(
      0,
      Number.isInteger(Number(record.turnStartMessageIndex))
        ? Number(record.turnStartMessageIndex)
        : Math.max(0, (Number(record.messagesLen) || 1) - 1),
    ),
    lastGoalSliceRunId: typeof record.lastGoalSliceRunId === "string" && record.lastGoalSliceRunId.trim()
      ? record.lastGoalSliceRunId.trim()
      : null,
    instanceId: typeof record.instanceId === "string" ? record.instanceId : "unknown",
    sessionKey,
    workspace: typeof record.workspace === "string" ? record.workspace : null,
    sessionId: typeof record.sessionId === "number" ? record.sessionId : null,
    turnId,
    status,
    ...(terminalResultKind ? { terminalResultKind } : {}),
    workflowMode: typeof record.workflowMode === "string" ? record.workflowMode : "unknown",
    runtimeIntent: typeof record.runtimeIntent === "string" ? record.runtimeIntent : "unknown",
    planStage: typeof record.planStage === "string" ? record.planStage : "idle",
    isPlanApproved: record.isPlanApproved === true,
    iteration: Math.max(0, Number(record.iteration) || 0),
    maxIterations: Math.max(0, Number(record.maxIterations) || 0),
    messagesLen: Math.max(0, Number(record.messagesLen) || 0),
    toolCount: Math.max(0, Number(record.toolCount) || 0),
    latestTool: typeof record.latestTool === "string" ? record.latestTool : null,
    latestToolTarget: typeof record.latestToolTarget === "string" ? record.latestToolTarget : null,
    activeStreamId: typeof record.activeStreamId === "string" ? record.activeStreamId : null,
    streamStatus: typeof record.streamStatus === "string" ? record.streamStatus : null,
    streamChunkCount: Math.max(0, Number(record.streamChunkCount) || 0),
    streamByteCount: Math.max(0, Number(record.streamByteCount) || 0),
    streamElapsedMs: Number.isFinite(Number(record.streamElapsedMs)) ? Math.max(0, Number(record.streamElapsedMs)) : null,
    streamLifecycleStatus: typeof record.streamLifecycleStatus === "string" ? record.streamLifecycleStatus : null,
    lastStreamError: typeof record.lastStreamError === "string" ? record.lastStreamError : null,
    startedAt,
    updatedAt: Math.max(0, Number(record.updatedAt) || Date.now()),
    closedAt: typeof record.closedAt === "number" ? record.closedAt : null,
    closeReason: typeof record.closeReason === "string" ? record.closeReason : null,
  };
}

export function readHarnessRunMarker(): HarnessRunMarker | null {
  return normalizeHarnessRunMarker(readJson<unknown>(HARNESS_RUN_MARKER_STORAGE_KEY));
}

export function getCurrentHarnessInstanceId(): string {
  const instance = readJson<HarnessInstanceMarker>(HARNESS_INSTANCE_STORAGE_KEY);
  return instance?.instanceId || "unknown";
}

export function persistHarnessRunMarker(marker: HarnessRunMarker): HarnessRunMarker | null {
  const normalized = normalizeHarnessRunMarker({
    ...marker,
    updatedAt: Date.now(),
    status: marker.status || "running",
  }) || marker;
  return writeJson(HARNESS_RUN_MARKER_STORAGE_KEY, normalized)
    ? normalized
    : null;
}

function hasSameHarnessLeaseIdentity(
  current: HarnessRunMarker | null,
  expected: HarnessRunMarker | null,
): boolean {
  if (!current || !expected) return current === expected;
  return current.runId === expected.runId &&
    current.sessionKey === expected.sessionKey &&
    current.turnId === expected.turnId &&
    current.instanceId === expected.instanceId &&
    current.startedAt === expected.startedAt;
}

function hasSamePlanExecutionProvenance(
  current: PlanExecutionRunProvenance | null | undefined,
  expected: PlanExecutionRunProvenance | null | undefined,
): boolean {
  if (!current || !expected) return current == null && expected == null;
  return current.schemaVersion === expected.schemaVersion &&
    current.sessionKey === expected.sessionKey &&
    current.sessionEpoch === expected.sessionEpoch &&
    current.planTurnId === expected.planTurnId &&
    current.approvalLeaseId === expected.approvalLeaseId &&
    current.planRevision === expected.planRevision &&
    current.artifactHash === expected.artifactHash &&
    current.executionLeaseId === expected.executionLeaseId &&
    current.executionTurnId === expected.executionTurnId &&
    current.executionRunId === expected.executionRunId &&
    current.parentRunId === expected.parentRunId &&
    current.attempt === expected.attempt &&
    current.instructionHash === expected.instructionHash;
}

/**
 * Verify the authority-bearing fields that make a persisted Harness marker a
 * valid admission fence. Mutable telemetry can advance independently, but a
 * caller must never observe success for another outer generation, lifecycle
 * status, actionable child Run, or Plan execution provenance.
 */
function hasSameHarnessPersistenceAuthority(
  current: HarnessRunMarker | null,
  expected: HarnessRunMarker,
): current is HarnessRunMarker {
  return !!current &&
    hasSameHarnessLeaseIdentity(current, expected) &&
    current.status === expected.status &&
    current.activeRunId === expected.activeRunId &&
    current.activeParentRunId === expected.activeParentRunId &&
    (current.terminalResultKind || null) === (expected.terminalResultKind || null) &&
    hasSamePlanExecutionProvenance(
      current.activePlanExecutionProvenance,
      expected.activePlanExecutionProvenance,
    );
}

/**
 * Acquire the global Harness slot only if its exact predecessor owner is still
 * current, then verify the authority-bearing postcondition from storage.
 * This fences competing async bootstraps observed by this renderer; localStorage
 * does not provide a cross-renderer atomic compare-and-swap. Mutable progress
 * fields intentionally do not invalidate the predecessor; a different
 * run/session/turn/process generation does.
 */
export function acquireHarnessRunMarker(
  marker: HarnessRunMarker,
  expectedCurrent: HarnessRunMarker | null,
): HarnessRunMarker | null {
  const current = readHarnessRunMarker();
  if (!hasSameHarnessLeaseIdentity(current, expectedCurrent)) return null;
  const persisted = persistHarnessRunMarker(marker);
  if (!persisted) return null;
  const verified = readHarnessRunMarker();
  return hasSameHarnessPersistenceAuthority(verified, persisted)
    ? verified
    : null;
}

export function persistHarnessRunMarkerIfOwned(
  marker: HarnessRunMarker,
  owner: HarnessRunOwner,
): HarnessRunMarker | null {
  const current = readHarnessRunMarker();
  if (!current || !isHarnessRunMarkerOwnedByRun(current, owner)) return null;
  if (
    marker.runId !== owner.runId ||
    marker.sessionKey !== owner.sessionKey ||
    marker.turnId !== owner.turnId ||
    (owner.instanceId != null && marker.instanceId !== owner.instanceId) ||
    (owner.startedAt != null && marker.startedAt !== owner.startedAt)
  ) {
    return null;
  }
  const persisted = persistHarnessRunMarker(marker);
  if (!persisted) return null;
  const verified = readHarnessRunMarker();
  return hasSameHarnessPersistenceAuthority(verified, persisted)
    ? verified
    : null;
}

export function isExactHarnessRunGeneration(
  marker: HarnessRunMarker | null | undefined,
  owner: ExactHarnessRunOwner,
): boolean {
  return !!marker &&
    marker.runId === owner.runId &&
    marker.sessionKey === owner.sessionKey &&
    marker.turnId === owner.turnId &&
    marker.instanceId === owner.instanceId &&
    marker.startedAt === owner.startedAt;
}

/**
 * Settle one exact Harness generation. A retry of the same terminal meaning is
 * idempotent, while a marker from another process generation is never touched
 * even when its logical run/session/turn ids were reused.
 */
export function settleHarnessRunMarkerIfOwned(
  marker: HarnessRunMarker,
  owner: ExactHarnessRunOwner,
): HarnessRunMarker | null {
  const current = readHarnessRunMarker();
  if (
    !current ||
    marker.status === "running" ||
    !isExactHarnessRunGeneration(current, owner) ||
    !isExactHarnessRunGeneration(marker, owner)
  ) {
    return null;
  }
  const hasSameTerminalMeaning = current.status === marker.status &&
    current.closeReason === marker.closeReason;
  if (hasSameTerminalMeaning) {
    const currentResultKind = current.terminalResultKind || null;
    const requestedResultKind = marker.terminalResultKind || null;
    if (
      currentResultKind &&
      requestedResultKind &&
      currentResultKind !== requestedResultKind
    ) return null;
    const effectiveResultKind = requestedResultKind || currentResultKind;
    const resultKindNeedsRepair = !currentResultKind && !!requestedResultKind;
    const sameAuthorityWithoutRepairableResult = hasSameHarnessLeaseIdentity(current, marker) &&
      current.status === marker.status &&
      current.activeRunId === marker.activeRunId &&
      current.activeParentRunId === marker.activeParentRunId &&
      hasSamePlanExecutionProvenance(
        current.activePlanExecutionProvenance,
        marker.activePlanExecutionProvenance,
      );
    if (!sameAuthorityWithoutRepairableResult) return null;
    if (
      !resultKindNeedsRepair &&
      current.planStage === marker.planStage &&
      current.isPlanApproved === marker.isPlanApproved
    ) {
      return current;
    }
    const repairMarker = {
      ...current,
      ...(effectiveResultKind ? { terminalResultKind: effectiveResultKind } : {}),
      planStage: marker.planStage,
      isPlanApproved: marker.isPlanApproved,
      updatedAt: Math.max(current.updatedAt, marker.updatedAt),
    };
    const repaired = persistHarnessRunMarker(repairMarker);
    if (!repaired) return null;
    const verifiedRepair = readHarnessRunMarker();
    return verifiedRepair &&
        hasSameHarnessPersistenceAuthority(verifiedRepair, repairMarker) &&
        verifiedRepair.closeReason === marker.closeReason &&
        (verifiedRepair.terminalResultKind || null) === effectiveResultKind &&
        verifiedRepair.planStage === marker.planStage &&
        verifiedRepair.isPlanApproved === marker.isPlanApproved
      ? verifiedRepair
      : null;
  }
  if (
    current.status !== "running" &&
    !(current.status === "paused" && marker.status !== "paused")
  ) {
    return null;
  }
  const persisted = persistHarnessRunMarker(marker);
  if (!persisted) return null;
  const verified = readHarnessRunMarker();
  return verified &&
      hasSameHarnessPersistenceAuthority(verified, marker) &&
      verified.closeReason === marker.closeReason &&
      verified.planStage === marker.planStage &&
      verified.isPlanApproved === marker.isPlanApproved
    ? verified
    : null;
}

export function closeHarnessRunMarker(
  patch: Partial<HarnessRunMarker> & { closeReason: string; status?: HarnessRunStatus },
  owner: HarnessRunOwner,
): HarnessRunMarker | null {
  const current = readHarnessRunMarker();
  if (!current || !isHarnessRunMarkerOwnedByRun(current, owner)) return null;
  const next = persistHarnessRunMarker({
    ...current,
    ...patch,
    status: patch.status || "closed",
    closedAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!next) return null;
  appendDebugLog("info", "app.instance.closed", {
    reason: next.closeReason,
    status: next.status,
    turnId: next.turnId,
    iteration: next.iteration,
    streamStatus: next.streamStatus,
    streamElapsedMs: next.streamElapsedMs,
    streamLifecycleStatus: next.streamLifecycleStatus,
  });
  return next;
}

/**
 * Revoke the exact Harness owner when its Session is deleted. A paused marker
 * no longer owns the ordinary persistence write lease, but it still needs this
 * deletion-only CAS so it cannot remain as an orphaned global marker.
 */
export function closeHarnessRunMarkerForSessionDeletion(
  owner: HarnessRunOwner,
): HarnessRunMarker | null {
  const current = readHarnessRunMarker();
  const ownsDeletableMarker = !!current &&
    (current.status === "running" || current.status === "paused") &&
    current.runId === owner.runId &&
    current.sessionKey === owner.sessionKey &&
    current.turnId === owner.turnId &&
    (owner.instanceId == null || current.instanceId === owner.instanceId) &&
    (owner.startedAt == null || current.startedAt === owner.startedAt);
  if (!current || !ownsDeletableMarker) return null;
  const next = persistHarnessRunMarker({
    ...current,
    status: "completed",
    terminalResultKind: "canceled",
    closeReason: "session_deleted",
    closedAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!next) return null;
  appendDebugLog("info", "app.instance.closed", {
    reason: next.closeReason,
    status: next.status,
    turnId: next.turnId,
    iteration: next.iteration,
    streamStatus: next.streamStatus,
    streamElapsedMs: next.streamElapsedMs,
    streamLifecycleStatus: next.streamLifecycleStatus,
  });
  return next;
}

export function markHarnessInstanceStarted(): HarnessUncleanRestartDiagnostic | null {
  const previousInstance = readJson<HarnessInstanceMarker>(HARNESS_INSTANCE_STORAGE_KEY);
  const previousRun = readHarnessRunMarker();
  const now = Date.now();
  const instance: HarnessInstanceMarker = {
    schemaVersion: 1,
    instanceId: createInstanceId(),
    startedAt: now,
    updatedAt: now,
    closedAt: null,
    closeReason: null,
  };
  const instancePersisted = writeJson(HARNESS_INSTANCE_STORAGE_KEY, instance);
  appendDebugLog(instancePersisted ? "info" : "error", "app.instance.started", {
    instanceId: instance.instanceId,
    previousInstanceId: previousInstance?.instanceId || null,
    previousClosedAt: previousInstance?.closedAt || null,
    persistenceSucceeded: instancePersisted,
  });

  if (previousRun?.status === "running") {
    const diagnostic: HarnessUncleanRestartDiagnostic = {
      detectedAt: now,
      previousInstanceId: previousInstance?.instanceId || previousRun.instanceId || null,
      marker: previousRun,
    };
    const diagnosticPersisted = writeJson(HARNESS_PENDING_UNCLEAN_RESTART_KEY, diagnostic);
    appendDebugLog("error", "app.unclean_restart_detected", {
      previousInstanceId: diagnostic.previousInstanceId,
      sessionKey: previousRun.sessionKey,
      workspace: previousRun.workspace,
      sessionId: previousRun.sessionId,
      turnId: previousRun.turnId,
      runtimeIntent: previousRun.runtimeIntent,
      workflowMode: previousRun.workflowMode,
      planStage: previousRun.planStage,
      isPlanApproved: previousRun.isPlanApproved,
      iteration: previousRun.iteration,
      maxIterations: previousRun.maxIterations,
      activeStreamId: previousRun.activeStreamId,
      streamStatus: previousRun.streamStatus,
      streamChunkCount: previousRun.streamChunkCount,
      streamByteCount: previousRun.streamByteCount,
      streamElapsedMs: previousRun.streamElapsedMs,
      streamLifecycleStatus: previousRun.streamLifecycleStatus,
      latestTool: previousRun.latestTool,
      latestToolTarget: previousRun.latestToolTarget,
      updatedAt: previousRun.updatedAt,
      diagnosticPersisted,
    });
    const previousRunClosed = !!persistHarnessRunMarker({
      ...previousRun,
      status: "error",
      closedAt: now,
      closeReason: "unclean_restart_detected",
      updatedAt: now,
    });
    if (!diagnosticPersisted || !previousRunClosed) {
      appendDebugLog("error", "app.harness_persistence_degraded", {
        phase: "unclean_restart_reconciliation",
        instancePersisted,
        diagnosticPersisted,
        previousRunClosed,
        previousRunId: previousRun.runId,
        previousSessionKey: previousRun.sessionKey,
        previousTurnId: previousRun.turnId,
      });
    }
    return diagnostic;
  }

  return null;
}

export function markHarnessInstanceClosed(reason: string) {
  const instance = readJson<HarnessInstanceMarker>(HARNESS_INSTANCE_STORAGE_KEY);
  if (!instance || instance.closedAt != null) return;
  const next: HarnessInstanceMarker = {
    ...instance,
    updatedAt: Date.now(),
    closedAt: Date.now(),
    closeReason: reason,
  };
  const instancePersisted = writeJson(HARNESS_INSTANCE_STORAGE_KEY, next);
  const currentRun = readHarnessRunMarker();
  appendDebugLog(instancePersisted ? "info" : "error", "app.instance.closed", {
    reason,
    instanceId: next.instanceId,
    activeRun: currentRun?.status === "running",
    activeTurnId: currentRun?.turnId || null,
    activeStreamId: currentRun?.activeStreamId || null,
    activeIteration: currentRun?.iteration || 0,
    persistenceSucceeded: instancePersisted,
  });
}

export function consumePendingUncleanRestartDiagnostic(): HarnessUncleanRestartDiagnostic | null {
  const diagnostic = readJson<HarnessUncleanRestartDiagnostic>(HARNESS_PENDING_UNCLEAN_RESTART_KEY);
  removeKey(HARNESS_PENDING_UNCLEAN_RESTART_KEY);
  if (!diagnostic?.marker) return null;
  const marker = normalizeHarnessRunMarker(diagnostic.marker);
  if (!marker) return null;
  return {
    detectedAt: Math.max(0, Number(diagnostic.detectedAt) || Date.now()),
    previousInstanceId: typeof diagnostic.previousInstanceId === "string" ? diagnostic.previousInstanceId : null,
    marker,
  };
}
