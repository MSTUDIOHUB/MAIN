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
