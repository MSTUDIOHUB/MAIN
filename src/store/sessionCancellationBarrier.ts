export interface SessionCancellationSettlement {
  sessionKey: string;
  turnId: string;
  terminalSettled: boolean;
  disposition: string;
  queueDisposition?: "replay" | "discard";
}

export interface PendingSessionCancellation {
  sessionKey: string;
  turnId: string;
  promise: Promise<SessionCancellationSettlement>;
  status: "settling" | "reconciling";
  reconciliationAttempts: number;
  settlement?: SessionCancellationSettlement;
  error?: unknown;
}

export type DeferredSessionSubmissionDecision =
  | "replay"
  | "discard_session_deleted"
  | "superseded_by_latest"
  | "retain_for_reconciliation"
  | "retain_for_target_session";

export interface SessionCancellationReconciliationInput {
  sessionKey: string;
  turnId: string;
  attempt: number;
  previousSettlement?: SessionCancellationSettlement;
  error?: unknown;
}

export interface SessionCancellationOptions {
  maxReconciliationAttempts?: number;
  reconcile?: (
    input: SessionCancellationReconciliationInput,
  ) => Promise<SessionCancellationSettlement>;
}

export function hasCanceledTurnTerminalProjection(input: {
  sessionKey: string;
  turnId: string;
  runtimeEvents: Array<{
    type?: string;
    threadId?: string;
    turnId?: string;
    runId?: string;
    resultKind?: string;
  }>;
  taskFlow: Array<{
    type?: string;
    turnId?: string;
    visibility?: string;
  }>;
}): boolean {
  const abortedRunIndex = input.runtimeEvents.findIndex((event) =>
    event.type === "run.aborted" &&
    event.threadId === input.sessionKey &&
    event.turnId === input.turnId
  );
  const abortedRunId = abortedRunIndex >= 0
    ? input.runtimeEvents[abortedRunIndex]?.runId
    : undefined;
  const canceledRunIndex = input.runtimeEvents.findIndex((event, index) =>
    index > abortedRunIndex &&
    event.type === "run.completed" &&
    event.threadId === input.sessionKey &&
    event.turnId === input.turnId &&
    event.resultKind === "canceled" &&
    (!abortedRunId || event.runId === abortedRunId)
  );
  const canceledTurnIndex = input.runtimeEvents.findIndex((event, index) =>
    index > canceledRunIndex &&
    event.type === "turn.completed" &&
    event.threadId === input.sessionKey &&
    event.turnId === input.turnId &&
    event.resultKind === "canceled"
  );
  const hasVisibleFinal = input.taskFlow.some((block) =>
    block.type === "agent" &&
    block.turnId === input.turnId &&
    block.visibility === "assistant_final"
  );
  return abortedRunIndex >= 0 && canceledRunIndex > abortedRunIndex &&
    canceledTurnIndex > canceledRunIndex && hasVisibleFinal;
}

const pendingBySessionKey = new Map<string, PendingSessionCancellation>();

function normalizeSessionKey(sessionKey: string): string {
  return String(sessionKey || "").trim();
}

/** Return the exact cancel transaction that currently fences this Session. */
export function getPendingSessionCancellation(
  sessionKey: string,
): PendingSessionCancellation | null {
  return pendingBySessionKey.get(normalizeSessionKey(sessionKey)) || null;
}

/**
 * Let an in-flight runtime observe the terminal transaction that now owns a
 * user cancellation. The cancellation publisher may have removed its pending
 * fence just before a stale provider/checkpoint callback unwinds, so callers
 * must accept either the exact settlement or its already-published canonical
 * projection. No second terminal write is attempted here.
 */
export async function awaitCanceledTurnTerminalProjection(input: {
  sessionKey: string;
  turnId: string;
  getProjection: () => {
    runtimeEvents: Array<{
      type?: string;
      threadId?: string;
      turnId?: string;
      runId?: string;
      resultKind?: string;
    }>;
    taskFlow: Array<{
      type?: string;
      turnId?: string;
      visibility?: string;
    }>;
  };
}): Promise<boolean> {
  const sessionKey = normalizeSessionKey(input.sessionKey);
  const turnId = String(input.turnId || "").trim();
  const pending = getPendingSessionCancellation(sessionKey);
  if (pending?.turnId === turnId) {
    try {
      const settlement = await pending.promise;
      if (settlement.terminalSettled) return true;
    } catch {
      // Reconciliation may have exhausted after another owner already
      // published the terminal projection. Verify the projection below.
    }
  }
  const projection = input.getProjection();
  return hasCanceledTurnTerminalProjection({
    sessionKey,
    turnId,
    runtimeEvents: projection.runtimeEvents || [],
    taskFlow: projection.taskFlow || [],
  });
}

/**
 * Publish a Session cancellation fence synchronously, then start its terminal
 * transaction in a microtask. Consumers can therefore accept a user submit
 * synchronously while deferring all new runtime ownership until this promise
 * resolves with a verified terminal projection. An unverified result or
 * exception enters a bounded reconciliation loop; the fence is always
 * released after the final result so a settled promise can never deadlock the
 * Session permanently.
 */
export function beginSessionCancellation(
  sessionKey: string,
  turnId: string,
  settle: () => Promise<SessionCancellationSettlement>,
  options: SessionCancellationOptions = {},
): { started: boolean; cancellation: PendingSessionCancellation } {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  const existing = pendingBySessionKey.get(normalizedSessionKey);
  if (existing) return { started: false, cancellation: existing };

  const cancellation: PendingSessionCancellation = {
    sessionKey: normalizedSessionKey,
    turnId,
    promise: Promise.resolve(null as unknown as SessionCancellationSettlement),
    status: "settling",
    reconciliationAttempts: 0,
  };
  const maxReconciliationAttempts = Math.max(
    0,
    Math.min(3, options.reconcile ? options.maxReconciliationAttempts ?? 2 : 0),
  );
  const isReleaseable = (result: SessionCancellationSettlement): boolean =>
    result.terminalSettled || result.queueDisposition === "discard";
  const runSettlement = async (): Promise<SessionCancellationSettlement> => {
    let previousSettlement: SessionCancellationSettlement | undefined;
    let previousError: unknown;
    try {
      previousSettlement = await settle();
      if (isReleaseable(previousSettlement)) return previousSettlement;
    } catch (error) {
      previousError = error;
    }

    for (let attempt = 1; attempt <= maxReconciliationAttempts; attempt += 1) {
      cancellation.status = "reconciling";
      cancellation.reconciliationAttempts = attempt;
      try {
        previousSettlement = await options.reconcile!({
          sessionKey: normalizedSessionKey,
          turnId,
          attempt,
          previousSettlement,
          ...(previousError !== undefined ? { error: previousError } : {}),
        });
        previousError = undefined;
        if (isReleaseable(previousSettlement)) return previousSettlement;
      } catch (error) {
        previousError = error;
      }
    }

    if (previousSettlement) {
      return {
        ...previousSettlement,
        disposition: `reconciliation_exhausted:${previousSettlement.disposition}`,
      };
    }
    throw previousError || new Error("Session cancellation reconciliation exhausted");
  };
  const settlement = Promise.resolve()
    .then(runSettlement)
    .then(
      (result) => {
        cancellation.settlement = result;
        if (pendingBySessionKey.get(normalizedSessionKey) === cancellation) {
          pendingBySessionKey.delete(normalizedSessionKey);
        }
        return result;
      },
      (error) => {
        cancellation.error = error;
        if (pendingBySessionKey.get(normalizedSessionKey) === cancellation) {
          pendingBySessionKey.delete(normalizedSessionKey);
        }
        throw error;
      },
    );
  cancellation.promise = settlement;
  // A cancellation caller may not have registered its deferred submit yet.
  // Keep a rejection observed while retaining the original rejecting promise
  // for later reconciliation callbacks.
  void settlement.catch(() => {});
  pendingBySessionKey.set(normalizedSessionKey, cancellation);
  return { started: true, cancellation };
}

/**
 * Resolve an exact queued submit after a cancellation transaction. The queue
 * is intentionally a single latest-wins slot: callbacks for replaced ids do
 * nothing, while an unsettled terminal or inactive target Session keeps the
 * current payload visible and retryable instead of dropping it.
 */
export function resolveDeferredSessionSubmissionDecision(input: {
  expectedQueueId: string;
  currentQueueId: string | null | undefined;
  targetSessionKey: string;
  activeSessionKey: string | null | undefined;
  terminalSettled: boolean;
  queueDisposition?: SessionCancellationSettlement["queueDisposition"];
}): DeferredSessionSubmissionDecision {
  if (input.queueDisposition === "discard") return "discard_session_deleted";
  if (!input.currentQueueId || input.currentQueueId !== input.expectedQueueId) {
    return "superseded_by_latest";
  }
  if (!input.terminalSettled) return "retain_for_reconciliation";
  if (input.activeSessionKey !== input.targetSessionKey) {
    return "retain_for_target_session";
  }
  return "replay";
}

/**
 * Keep synchronous submit APIs intact while linearizing their ownership work
 * after the active cancel transaction. Returns false when no fence exists.
 */
export function deferUntilSessionCancellationSettled(input: {
  sessionKey: string;
  onSettled: (settlement: SessionCancellationSettlement) => void;
  onError?: (error: unknown) => void;
}): boolean {
  const pending = getPendingSessionCancellation(input.sessionKey);
  if (!pending) return false;
  void pending.promise.then(input.onSettled, input.onError).catch(() => {});
  return true;
}
