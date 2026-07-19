import type { HarnessRunMarker } from "../lib/harnessCrashTelemetry";

export interface RevocableSessionRuntime {
  currentTurnId?: string | null;
  agentStatus?: string;
  abortController?: { abort: () => void } | null;
  pendingRunDecisionResolver?: ((choice: "cancel") => unknown) | null;
  pendingReviewResolve?: ((decision: { action: "reject" }) => unknown) | null;
  harnessRunMarker?: HarnessRunMarker | null;
}

export interface SessionRuntimeRevocationResult {
  aborted: boolean;
  runDecisionSettled: boolean;
  reviewSettled: boolean;
  harnessClosed: boolean;
}

export interface WorkspaceSessionRuntimeRevocationResult extends SessionRuntimeRevocationResult {
  sessionKey: string;
}

export type SettingsResetRuntimeOwnerSource = "active" | "cached";

/** Stable, serializable owner data that can be written directly to debug logs. */
export interface SettingsResetRuntimeRevocationIdentity {
  ownerId: string;
  source: SettingsResetRuntimeOwnerSource;
  /** Null means the visible runtime was not bound to a Session when reset began. */
  sessionKey: string | null;
  currentTurnId: string | null;
  agentStatus: string | null;
  harnessRunId: string | null;
  harnessSessionKey: string | null;
  harnessTurnId: string | null;
}

export interface SettingsResetRuntimeRevocationResult extends SessionRuntimeRevocationResult {
  identity: SettingsResetRuntimeRevocationIdentity;
}

/** Revoke transient execution capabilities before deleting their Session. */
export function revokeSessionRuntimeBeforeDelete(input: {
  runtime: RevocableSessionRuntime;
  sessionKey: string;
  closeHarness: (marker: HarnessRunMarker) => boolean;
  onError?: (phase: "abort" | "run_decision" | "review" | "harness", error: unknown) => void;
}): SessionRuntimeRevocationResult {
  let aborted = false;
  let runDecisionSettled = false;
  let reviewSettled = false;
  let harnessClosed = false;
  try {
    if (input.runtime.abortController) {
      input.runtime.abortController.abort();
      aborted = true;
    }
  } catch (error) {
    input.onError?.("abort", error);
  }
  try {
    if (input.runtime.pendingRunDecisionResolver) {
      input.runtime.pendingRunDecisionResolver("cancel");
      runDecisionSettled = true;
    }
  } catch (error) {
    input.onError?.("run_decision", error);
  }
  try {
    if (input.runtime.pendingReviewResolve) {
      input.runtime.pendingReviewResolve({ action: "reject" });
      reviewSettled = true;
    }
  } catch (error) {
    input.onError?.("review", error);
  }
  const marker = input.runtime.harnessRunMarker;
  if (
    (marker?.status === "running" || marker?.status === "paused") &&
    !!marker.runId &&
    marker.sessionKey === input.sessionKey &&
    !!marker.turnId
  ) {
    try {
      harnessClosed = input.closeHarness(marker);
    } catch (error) {
      input.onError?.("harness", error);
    }
  }
  return { aborted, runDecisionSettled, reviewSettled, harnessClosed };
}

function isRuntimeSessionOwnedByWorkspace(sessionKey: string, workspaceKey: string): boolean {
  return sessionKey.startsWith(`${workspaceKey}:`) && sessionKey.length > workspaceKey.length + 1;
}

/**
 * Revoke every live Session runtime owned by one workspace. The visible active
 * runtime overrides its cached snapshot so each owner is settled exactly once.
 */
export function revokeWorkspaceSessionRuntimesBeforeClear(input: {
  workspaceKey: string;
  activeSessionKey?: string | null;
  activeRuntime?: RevocableSessionRuntime | null;
  runtimeBySessionKey: Record<string, RevocableSessionRuntime | null | undefined>;
  closeHarness: (marker: HarnessRunMarker) => boolean;
  onError?: (
    sessionKey: string,
    phase: "abort" | "run_decision" | "review" | "harness",
    error: unknown,
  ) => void;
}): WorkspaceSessionRuntimeRevocationResult[] {
  const workspaceKey = String(input.workspaceKey || "").trim();
  if (!workspaceKey) return [];
  const ownedRuntimes = new Map<string, RevocableSessionRuntime>();
  Object.entries(input.runtimeBySessionKey).forEach(([sessionKey, runtime]) => {
    if (runtime && isRuntimeSessionOwnedByWorkspace(sessionKey, workspaceKey)) {
      ownedRuntimes.set(sessionKey, runtime);
    }
  });
  if (
    input.activeSessionKey &&
    input.activeRuntime &&
    isRuntimeSessionOwnedByWorkspace(input.activeSessionKey, workspaceKey)
  ) {
    ownedRuntimes.set(input.activeSessionKey, input.activeRuntime);
  }

  return Array.from(ownedRuntimes.entries()).map(([sessionKey, runtime]) => ({
    sessionKey,
    ...revokeSessionRuntimeBeforeDelete({
      runtime,
      sessionKey,
      closeHarness: input.closeHarness,
      onError: (phase, error) => input.onError?.(sessionKey, phase, error),
    }),
  }));
}

interface SettingsResetRuntimeOwner {
  source: SettingsResetRuntimeOwnerSource;
  sessionKey: string | null;
  runtime: RevocableSessionRuntime;
}

function normalizeOwnedSessionKey(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function buildSettingsResetRuntimeOwnerId(
  source: SettingsResetRuntimeOwnerSource,
  sessionKey: string | null,
): string {
  return `${source}:${sessionKey || "unbound"}`;
}

function buildSettingsResetRuntimeIdentity(
  owner: SettingsResetRuntimeOwner,
): SettingsResetRuntimeRevocationIdentity {
  const marker = owner.runtime.harnessRunMarker;
  return {
    ownerId: buildSettingsResetRuntimeOwnerId(owner.source, owner.sessionKey),
    source: owner.source,
    sessionKey: owner.sessionKey,
    currentTurnId: normalizeOwnedSessionKey(owner.runtime.currentTurnId),
    agentStatus: normalizeOwnedSessionKey(owner.runtime.agentStatus),
    harnessRunId: normalizeOwnedSessionKey(marker?.runId),
    harnessSessionKey: normalizeOwnedSessionKey(marker?.sessionKey),
    harnessTurnId: normalizeOwnedSessionKey(marker?.turnId),
  };
}

function buildExactHarnessGenerationKey(
  marker: HarnessRunMarker | null | undefined,
  revocationSessionKey: string,
): string | null {
  if (
    !marker ||
    (marker.status !== "running" && marker.status !== "paused") ||
    !marker.runId ||
    !marker.turnId ||
    marker.sessionKey !== revocationSessionKey
  ) {
    return null;
  }
  return JSON.stringify([
    marker.runId,
    marker.sessionKey,
    marker.turnId,
    marker.instanceId,
    marker.startedAt,
  ]);
}

/**
 * Revoke every in-process Session capability before a settings reset clears
 * the Session index. The visible runtime is authoritative for its active
 * Session, while an unbound visible runtime is still revoked without
 * inventing Session ownership.
 */
export function revokeAllSessionRuntimesBeforeSettingsReset(input: {
  activeSessionKey?: string | null;
  activeRuntime?: RevocableSessionRuntime | null;
  runtimeBySessionKey: Record<string, RevocableSessionRuntime | null | undefined>;
  closeHarness: (marker: HarnessRunMarker) => boolean;
  onError?: (
    identity: SettingsResetRuntimeRevocationIdentity,
    phase: "abort" | "run_decision" | "review" | "harness",
    error: unknown,
  ) => void;
}): SettingsResetRuntimeRevocationResult[] {
  const activeSessionKey = normalizeOwnedSessionKey(input.activeSessionKey);
  const owners: SettingsResetRuntimeOwner[] = [];
  const claimedSessionKeys = new Set<string>();

  // Revoke the live projection first. This both prioritizes user-visible work
  // when capability references are aliased and replaces a stale cached copy.
  if (input.activeRuntime) {
    owners.push({
      source: "active",
      sessionKey: activeSessionKey,
      runtime: input.activeRuntime,
    });
    if (activeSessionKey) claimedSessionKeys.add(activeSessionKey);
  }

  Object.entries(input.runtimeBySessionKey).forEach(([rawSessionKey, runtime]) => {
    if (!runtime) return;
    const sessionKey = normalizeOwnedSessionKey(rawSessionKey);
    if (sessionKey && claimedSessionKeys.has(sessionKey)) return;
    if (sessionKey) claimedSessionKeys.add(sessionKey);
    owners.push({ source: "cached", sessionKey, runtime });
  });

  const claimedAbortControllers = new Set<object>();
  const claimedRunDecisionResolvers = new Set<NonNullable<RevocableSessionRuntime["pendingRunDecisionResolver"]>>();
  const claimedReviewResolvers = new Set<NonNullable<RevocableSessionRuntime["pendingReviewResolve"]>>();
  const claimedHarnessGenerations = new Set<string>();

  return owners.map((owner) => {
    const identity = buildSettingsResetRuntimeIdentity(owner);
    // An unbound active runtime may use the marker's own exact Session key for
    // Harness closure. No Session key is fabricated for a cached owner.
    const revocationSessionKey = owner.sessionKey || (
      owner.source === "active"
        ? normalizeOwnedSessionKey(owner.runtime.harnessRunMarker?.sessionKey) || ""
        : ""
    );

    const abortController = owner.runtime.abortController;
    const pendingRunDecisionResolver = owner.runtime.pendingRunDecisionResolver;
    const pendingReviewResolve = owner.runtime.pendingReviewResolve;
    const harnessRunMarker = owner.runtime.harnessRunMarker;
    const harnessGenerationKey = buildExactHarnessGenerationKey(
      harnessRunMarker,
      revocationSessionKey,
    );

    const deduplicatedRuntime: RevocableSessionRuntime = {
      ...owner.runtime,
      abortController: abortController && !claimedAbortControllers.has(abortController)
        ? abortController
        : null,
      pendingRunDecisionResolver:
        pendingRunDecisionResolver && !claimedRunDecisionResolvers.has(pendingRunDecisionResolver)
          ? pendingRunDecisionResolver
          : null,
      pendingReviewResolve:
        pendingReviewResolve && !claimedReviewResolvers.has(pendingReviewResolve)
          ? pendingReviewResolve
          : null,
      harnessRunMarker:
        harnessGenerationKey && claimedHarnessGenerations.has(harnessGenerationKey)
          ? null
          : harnessRunMarker,
    };

    if (deduplicatedRuntime.abortController) {
      claimedAbortControllers.add(deduplicatedRuntime.abortController);
    }
    if (deduplicatedRuntime.pendingRunDecisionResolver) {
      claimedRunDecisionResolvers.add(deduplicatedRuntime.pendingRunDecisionResolver);
    }
    if (deduplicatedRuntime.pendingReviewResolve) {
      claimedReviewResolvers.add(deduplicatedRuntime.pendingReviewResolve);
    }
    if (harnessGenerationKey) claimedHarnessGenerations.add(harnessGenerationKey);

    return {
      identity,
      ...revokeSessionRuntimeBeforeDelete({
        runtime: deduplicatedRuntime,
        sessionKey: revocationSessionKey,
        closeHarness: input.closeHarness,
        onError: (phase, error) => input.onError?.(identity, phase, error),
      }),
    };
  });
}
