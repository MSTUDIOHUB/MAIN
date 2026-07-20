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
  replay: (outcome: WorkspaceClearSettlementOutcome) => boolean | Promise<boolean>;
  onDiscard?: (reason: "workspace_removed" | "settings_reset" | "replay_failed") => void;
}

interface ActiveWorkspaceClearBarrier {
  generations: Set<number>;
  pending: WorkspaceClearDeferredSubmission[];
  clearedObserved: boolean;
}

export interface DeferredWorkspaceClearSubmission extends WorkspaceClearDeferredSubmission {
  outcome: WorkspaceClearSettlementOutcome;
}

let nextBarrierGeneration = 0;
const activeBarriers = new Map<string, ActiveWorkspaceClearBarrier>();
const settledSubmissions = new Map<string, DeferredWorkspaceClearSubmission[]>();

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
  reason: "workspace_removed" | "settings_reset" | "replay_failed",
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
  const previouslySettled = settledSubmissions.get(workspaceKey) || [];
  if (previouslySettled.length > 0) settledSubmissions.delete(workspaceKey);
  activeBarriers.set(workspaceKey, {
    generations: new Set([...(existing?.generations || []), generation]),
    pending: [
      ...previouslySettled,
      ...(existing?.pending || []),
    ],
    clearedObserved:
      existing?.clearedObserved === true ||
      previouslySettled.some((submission) => submission.outcome === "cleared"),
  });
  return { workspaceKey, generation };
}

export function isWorkspaceClearSubmissionBarrierActive(workspaceKeyInput: string): boolean {
  const workspaceKey = normalizeWorkspaceKey(workspaceKeyInput);
  return !!workspaceKey && activeBarriers.has(workspaceKey);
}

/**
 * A clear fence owns a strict FIFO per workspace. Every accepted submission is
 * retained in arrival order until the final nested clear generation settles.
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
      disposition: "queued";
      queuePosition: number;
    } {
  const workspaceKey = resolveWorkspaceClearBarrierForSubmission(input);
  if (!workspaceKey) return { deferred: false };
  const barrier = activeBarriers.get(workspaceKey);
  if (!barrier) return { deferred: false };
  barrier.pending.push({
    ...input.submission,
    workspaceKey,
  });
  return {
    deferred: true,
    workspaceKey,
    disposition: "queued",
    queuePosition: barrier.pending.length,
  };
}

/**
 * Release one clear generation. The final generation moves every pending
 * payload to the settled FIFO; replay remains gated by workspace activation.
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
    return { settled: false, pendingReplay: barrier.pending.length > 0 };
  }
  activeBarriers.delete(workspaceKey);
  if (barrier.pending.length > 0) {
    const outcome = barrier.clearedObserved ? "cleared" : "preserved";
    settledSubmissions.set(
      workspaceKey,
      barrier.pending.map((submission) => ({ ...submission, outcome })),
    );
  }
  return { settled: true, pendingReplay: barrier.pending.length > 0 };
}

export function peekSettledWorkspaceClearSubmission(
  workspaceKeyInput: string,
): DeferredWorkspaceClearSubmission | null {
  return settledSubmissions.get(normalizeWorkspaceKey(workspaceKeyInput))?.[0] || null;
}

/** Remove-before-replay gives exact-once invocation even if replay re-enters sendMessage. */
export function takeSettledWorkspaceClearSubmission(input: {
  workspaceKey: string;
  activeSessionKey: string | null;
}): DeferredWorkspaceClearSubmission | null {
  const workspaceKey = normalizeWorkspaceKey(input.workspaceKey);
  if (activeBarriers.has(workspaceKey)) return null;
  const pending = settledSubmissions.get(workspaceKey);
  const head = pending?.[0];
  if (!pending || !head) return null;
  if (
    head.outcome === "preserved" &&
    head.targetSessionKey &&
    head.targetSessionKey !== input.activeSessionKey
  ) {
    return null;
  }
  pending.shift();
  if (pending.length === 0) settledSubmissions.delete(workspaceKey);
  return head;
}

/** Restore a failed head before all later submissions so retries cannot overtake it. */
export function restoreSettledWorkspaceClearSubmission(
  submission: DeferredWorkspaceClearSubmission,
): boolean {
  const workspaceKey = normalizeWorkspaceKey(submission.workspaceKey);
  if (!workspaceKey) return false;
  const activeBarrier = activeBarriers.get(workspaceKey);
  if (activeBarrier) {
    if (activeBarrier.pending.some((pending) => pending.id === submission.id)) return false;
    activeBarrier.pending.unshift(submission);
    if (submission.outcome === "cleared") activeBarrier.clearedObserved = true;
    return true;
  }
  const settled = settledSubmissions.get(workspaceKey) || [];
  if (settled.some((pending) => pending.id === submission.id)) return false;
  settledSubmissions.set(workspaceKey, [submission, ...settled]);
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
  active?.pending.forEach((submission) => discardSubmission(submission, reason));
  settled?.forEach((submission) => discardSubmission(submission, reason));
  return true;
}

/** Return the number of workspace fence states invalidated by the reset. */
export function discardAllWorkspaceClearSubmissionStateForSettingsReset(): number {
  const workspaceKeys = new Set([
    ...activeBarriers.keys(),
    ...settledSubmissions.keys(),
  ]);
  const activePending = [...activeBarriers.values()]
    .flatMap((barrier) => barrier.pending);
  const settledPending = [...settledSubmissions.values()].flat();
  activeBarriers.clear();
  settledSubmissions.clear();
  activePending.forEach((submission) => discardSubmission(submission, "settings_reset"));
  settledPending.forEach((submission) => discardSubmission(submission, "settings_reset"));
  return workspaceKeys.size;
}
