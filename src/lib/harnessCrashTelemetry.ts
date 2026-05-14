import { appendDebugLog } from "./debugLog";

export const HARNESS_RUN_MARKER_STORAGE_KEY = "main.harnessRunMarker.v1";
const HARNESS_INSTANCE_STORAGE_KEY = "main.harnessInstance.v1";
const HARNESS_PENDING_UNCLEAN_RESTART_KEY = "main.harnessPendingUncleanRestart.v1";

export type HarnessRunStatus = "running" | "completed" | "error" | "idle" | "closed";

export interface HarnessRunMarker {
  schemaVersion: 1;
  instanceId: string;
  sessionKey: string;
  workspace: string | null;
  sessionId: number | null;
  turnId: string | null;
  status: HarnessRunStatus;
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
  lastStreamError: string | null;
  startedAt: number;
  updatedAt: number;
  closedAt: number | null;
  closeReason: string | null;
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

function writeJson(key: string, value: unknown) {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage can be unavailable in restricted WebView states.
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
  return {
    schemaVersion: 1,
    instanceId: typeof record.instanceId === "string" ? record.instanceId : "unknown",
    sessionKey,
    workspace: typeof record.workspace === "string" ? record.workspace : null,
    sessionId: typeof record.sessionId === "number" ? record.sessionId : null,
    turnId: typeof record.turnId === "string" ? record.turnId : null,
    status: record.status || "running",
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
    lastStreamError: typeof record.lastStreamError === "string" ? record.lastStreamError : null,
    startedAt: Math.max(0, Number(record.startedAt) || Date.now()),
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

export function persistHarnessRunMarker(marker: HarnessRunMarker): HarnessRunMarker {
  const normalized = normalizeHarnessRunMarker({
    ...marker,
    updatedAt: Date.now(),
    status: marker.status || "running",
  }) || marker;
  writeJson(HARNESS_RUN_MARKER_STORAGE_KEY, normalized);
  return normalized;
}

export function closeHarnessRunMarker(
  patch: Partial<HarnessRunMarker> & { closeReason: string; status?: HarnessRunStatus },
): HarnessRunMarker | null {
  const current = readHarnessRunMarker();
  if (!current) return null;
  const next = persistHarnessRunMarker({
    ...current,
    ...patch,
    status: patch.status || "closed",
    closedAt: Date.now(),
    updatedAt: Date.now(),
  });
  appendDebugLog("info", "app.instance.closed", {
    reason: next.closeReason,
    status: next.status,
    turnId: next.turnId,
    iteration: next.iteration,
    streamStatus: next.streamStatus,
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
  writeJson(HARNESS_INSTANCE_STORAGE_KEY, instance);
  appendDebugLog("info", "app.instance.started", {
    instanceId: instance.instanceId,
    previousInstanceId: previousInstance?.instanceId || null,
    previousClosedAt: previousInstance?.closedAt || null,
  });

  if (previousRun?.status === "running") {
    const diagnostic: HarnessUncleanRestartDiagnostic = {
      detectedAt: now,
      previousInstanceId: previousInstance?.instanceId || previousRun.instanceId || null,
      marker: previousRun,
    };
    writeJson(HARNESS_PENDING_UNCLEAN_RESTART_KEY, diagnostic);
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
      latestTool: previousRun.latestTool,
      latestToolTarget: previousRun.latestToolTarget,
      updatedAt: previousRun.updatedAt,
    });
    persistHarnessRunMarker({
      ...previousRun,
      status: "error",
      closedAt: now,
      closeReason: "unclean_restart_detected",
      updatedAt: now,
    });
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
  writeJson(HARNESS_INSTANCE_STORAGE_KEY, next);
  const currentRun = readHarnessRunMarker();
  appendDebugLog("info", "app.instance.closed", {
    reason,
    instanceId: next.instanceId,
    activeRun: currentRun?.status === "running",
    activeTurnId: currentRun?.turnId || null,
    activeStreamId: currentRun?.activeStreamId || null,
    activeIteration: currentRun?.iteration || 0,
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
