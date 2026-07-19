export type WorkspaceClearSettlementOutcome = "cleared" | "preserved";

export interface WorkspaceClearBarrierToken {
  workspaceKey: string;
  generation: number;
}

export interface WorkspaceClearDeferredSubmission {
  id: string;
  workspaceKey: string;
  /** Exact pre-clear Session owner, when the submission came from one. */
  targetSessionKey: string | null;
  createdAt: number;
  replay: (outcome: WorkspaceClearSettlementOutcome) => boolean;
  onDiscard?: (reason: "replaced" | "workspace_removed" | "settings_reset") => void;
}

interface ActiveWorkspaceClearBarrier {
  generations: Set<number>;
  pending: WorkspaceClearDeferredSubmission | null;
  clearedObserved: boolean;
}

export interface DeferredWorkspaceClearSubmission extends WorkspaceClearDeferredSubmission {
  outcome: WorkspaceClearSettlementOutcome;
}

let nextBarrierGeneration = 0;
const activeBarriers = new Map<string, ActiveWorkspaceClearBarrier>();
const settledSubmissions = new Map<string, DeferredWorkspaceClearSubmission>();

function normalizeWorkspaceKey(value: unknown): string {
  return String(value || "").trim();
}

function isWorkspaceOnlySessionKey(sessionKey: string, workspaceKey: string): boolean {
  return sessionKey === `workspace-only:${workspaceKey}`;
}

function sessionKeyBelongsToWorkspace(sessionKey: string, workspaceKey: string): boolean {
  return isWorkspaceOnlySessionKey(sessionKey, workspaceKey) ||
    sessionKey.startsWith(`${workspaceKey}:`);
}

function discardSubmission(
  submission: WorkspaceClearDeferredSubmission,
  reason: "replaced" | "workspace_removed" | "settings_reset",
): void {
  try {
    submission.onDiscard?.(reason);
  } catch {
    // A diagnostic callback must never affect barrier ownership.
  }
}

export function resolveWorkspaceClearBarrierForSubmission(input: {
  currentWorkspaceKey: string;
  submissionOriginSessionKey?: string | null;
}): string | null {
  const originSessionKey = String(input.submissionOriginSessionKey || "").trim();
  if (originSessionKey) {
    const originMatch = [...activeBarriers.keys()]
      .filter((workspaceKey) => sessionKeyBelongsToWorkspace(originSessionKey, workspaceKey))
      .sort((left, right) => right.length - left.length)[0];
    if (originMatch) return originMatch;
  }
  const currentWorkspaceKey = normalizeWorkspaceKey(input.currentWorkspaceKey);
  return currentWorkspaceKey && activeBarriers.has(currentWorkspaceKey)
    ? currentWorkspaceKey
    : null;
}

/** Register synchronously before a workspace clear can yield to durable I/O. */
export function beginWorkspaceClearSubmissionBarrier(
  workspaceKeyInput: string,
): WorkspaceClearBarrierToken {
  const workspaceKey = normalizeWorkspaceKey(workspaceKeyInput);
  const generation = ++nextBarrierGeneration;
  const existing = activeBarriers.get(workspaceKey);
  const previouslySettled = settledSubmissions.get(workspaceKey) || null;
  if (previouslySettled) settledSubmissions.delete(workspaceKey);
  activeBarriers.set(workspaceKey, {
    generations: new Set([...(existing?.generations || []), generation]),
    pending: existing?.pending || previouslySettled || null,
    clearedObserved:
      existing?.clearedObserved === true || previouslySettled?.outcome === "cleared",
  });
  return { workspaceKey, generation };
}

export function isWorkspaceClearSubmissionBarrierActive(workspaceKeyInput: string): boolean {
  const workspaceKey = normalizeWorkspaceKey(workspaceKeyInput);
  return !!workspaceKey && activeBarriers.has(workspaceKey);
}

/**
 * A clear fence owns one explicit bounded slot per workspace. New input wins,
 * and callers must surface/log the replaced id so the policy is never silent.
 */
export function deferSubmissionForWorkspaceClear(input: {
  currentWorkspaceKey: string;
  submissionOriginSessionKey?: string | null;
  submission: Omit<WorkspaceClearDeferredSubmission, "workspaceKey">;
}):
  | { deferred: false }
  | {
      deferred: true;
      workspaceKey: string;
      disposition: "queued" | "replaced";
      replacedSubmissionId: string | null;
    } {
  const workspaceKey = resolveWorkspaceClearBarrierForSubmission(input);
  if (!workspaceKey) return { deferred: false };
  const barrier = activeBarriers.get(workspaceKey);
  if (!barrier) return { deferred: false };
  const previous = barrier.pending;
  if (previous) discardSubmission(previous, "replaced");
  barrier.pending = {
    ...input.submission,
    workspaceKey,
  };
  return {
    deferred: true,
    workspaceKey,
    disposition: previous ? "replaced" : "queued",
    replacedSubmissionId: previous?.id || null,
  };
}

/**
 * Release one clear generation. The final generation moves its latest payload
 * to a settled queue; replay remains separately gated by workspace activation.
 */
export function settleWorkspaceClearSubmissionBarrier(input: {
  token: WorkspaceClearBarrierToken;
  outcome: WorkspaceClearSettlementOutcome;
}): { settled: boolean; pendingReplay: boolean } {
  const workspaceKey = normalizeWorkspaceKey(input.token.workspaceKey);
  const barrier = activeBarriers.get(workspaceKey);
  if (!barrier || !barrier.generations.delete(input.token.generation)) {
    // An invalidated/previously-settled token never reports another
    // generation's payload as its own replay responsibility.
    return { settled: false, pendingReplay: false };
  }
  if (input.outcome === "cleared") barrier.clearedObserved = true;
  if (barrier.generations.size > 0) {
    return { settled: false, pendingReplay: !!barrier.pending };
  }
  activeBarriers.delete(workspaceKey);
  if (barrier.pending) {
    settledSubmissions.set(workspaceKey, {
      ...barrier.pending,
      outcome: barrier.clearedObserved ? "cleared" : "preserved",
    });
  }
  return { settled: true, pendingReplay: !!barrier.pending };
}

export function peekSettledWorkspaceClearSubmission(
  workspaceKeyInput: string,
): DeferredWorkspaceClearSubmission | null {
  return settledSubmissions.get(normalizeWorkspaceKey(workspaceKeyInput)) || null;
}

/** Remove-before-replay gives exact-once invocation even if replay re-enters sendMessage. */
export function takeSettledWorkspaceClearSubmission(input: {
  workspaceKey: string;
  activeSessionKey: string | null;
}): DeferredWorkspaceClearSubmission | null {
  const workspaceKey = normalizeWorkspaceKey(input.workspaceKey);
  if (activeBarriers.has(workspaceKey)) return null;
  const pending = settledSubmissions.get(workspaceKey);
  if (!pending) return null;
  if (
    pending.outcome === "preserved" &&
    pending.targetSessionKey &&
    pending.targetSessionKey !== input.activeSessionKey
  ) {
    return null;
  }
  settledSubmissions.delete(workspaceKey);
  return pending;
}

/** Retain an invocation that could not be accepted without overwriting newer input. */
export function restoreSettledWorkspaceClearSubmission(
  submission: DeferredWorkspaceClearSubmission,
): boolean {
  const workspaceKey = normalizeWorkspaceKey(submission.workspaceKey);
  if (!workspaceKey) return false;
  const activeBarrier = activeBarriers.get(workspaceKey);
  if (activeBarrier) {
    if (activeBarrier.pending) return false;
    activeBarrier.pending = submission;
    if (submission.outcome === "cleared") activeBarrier.clearedObserved = true;
    return true;
  }
  if (settledSubmissions.has(workspaceKey)) return false;
  settledSubmissions.set(workspaceKey, submission);
  return true;
}

/**
 * Invalidate the whole workspace fence, including in-flight generations.
 * A later settlement from an invalidated token is intentionally idempotent.
 */
export function discardWorkspaceClearSubmissionState(
  workspaceKeyInput: string,
  reason: "workspace_removed" | "settings_reset",
): boolean {
  const workspaceKey = normalizeWorkspaceKey(workspaceKeyInput);
  const active = activeBarriers.get(workspaceKey);
  const settled = settledSubmissions.get(workspaceKey);
  if (!active && !settled) return false;
  activeBarriers.delete(workspaceKey);
  settledSubmissions.delete(workspaceKey);
  if (active?.pending) discardSubmission(active.pending, reason);
  if (settled) discardSubmission(settled, reason);
  return true;
}

/** Return the number of workspace fence states invalidated by the reset. */
export function discardAllWorkspaceClearSubmissionStateForSettingsReset(): number {
  const workspaceKeys = new Set([
    ...activeBarriers.keys(),
    ...settledSubmissions.keys(),
  ]);
  const activePending = [...activeBarriers.values()]
    .map((barrier) => barrier.pending)
    .filter((submission): submission is WorkspaceClearDeferredSubmission => !!submission);
  const settledPending = [...settledSubmissions.values()];
  activeBarriers.clear();
  settledSubmissions.clear();
  activePending.forEach((submission) => discardSubmission(submission, "settings_reset"));
  settledPending.forEach((submission) => discardSubmission(submission, "settings_reset"));
  return workspaceKeys.size;
}
