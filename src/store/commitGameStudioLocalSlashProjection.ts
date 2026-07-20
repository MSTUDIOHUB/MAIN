import type { TaskBlock } from "../lib/taskTypes";
import type { MainThreadEvent } from "../lib/turnEvents";
import type { ConversationTurn } from "../lib/workflowModels";
import type { WorkspaceTurnQueueState } from "../lib/workspaceInstruction";
import type { GameStudioLocalSlashProjectionCommitContext } from "./gameStudioLocalSlashBridge";
import type {
  SubmitOwnerScopedRuntimeProjectionInput,
  SubmitOwnerScopedRuntimePublicationResult,
} from "./submitRuntimeFacade";

export interface LocalSlashWorkspaceInstructionClaim {
  claimId: string;
  receiptId: string;
  clientSubmissionId: string;
  sessionKey: string;
  sessionEpoch: string;
  turnId: string;
  admittedUserBlockId: number;
}

export interface LocalSlashProjectionState {
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  runtimeEvents: MainThreadEvent[];
  workspaceTurnQueue?: WorkspaceTurnQueueState | null;
}

export interface CommitGameStudioLocalSlashProjectionInput<
  TState extends LocalSlashProjectionState,
> {
  context: GameStudioLocalSlashProjectionCommitContext;
  claim: LocalSlashWorkspaceInstructionClaim | null;
  sessionGet: () => TState;
  getSessionRevisionToken: () => unknown;
  hasSessionRuntimeOwnership: () => boolean;
  persistProjection: (
    projectedState: TState,
    expectedRevisionToken: unknown,
  ) => Promise<TState>;
  publishProjection: (
    input: SubmitOwnerScopedRuntimeProjectionInput<TState>,
  ) => SubmitOwnerScopedRuntimePublicationResult;
  scopeKey: string;
  sessionId: number | string | null | undefined;
  decorateProjection?: (
    projectedState: TState,
    context: GameStudioLocalSlashProjectionCommitContext,
  ) => TState;
  /**
   * Build the Session metadata/runtime snapshot used when durable persistence
   * remains unavailable. This must be synchronous so the final owner CAS has no
   * async gap; it must not claim durable storage succeeded.
   */
  buildMemoryFallbackProjection?: (
    projectedState: TState,
    context: GameStudioLocalSlashProjectionCommitContext,
  ) => TState;
  rememberDurableState?: (durableState: TState) => void;
  waitForRetry?: (delayMs: number, abortSignal?: AbortSignal) => Promise<void>;
  abortSignal?: AbortSignal;
  maxAttempts?: number;
  persistenceAttemptTimeoutMs?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

function hasCanonicalConclusion(
  state: LocalSlashProjectionState,
  context: GameStudioLocalSlashProjectionCommitContext,
  claim: LocalSlashWorkspaceInstructionClaim | null,
): boolean {
  const owner = context.conclusionOwner;
  const turn = state.conversationTurns.find((candidate) => candidate.id === owner.turnId);
  const outcome = turn?.runtimeOutcome;
  const runConclusions = state.runtimeEvents.filter((event) =>
    event.type === "run.completed" &&
    event.threadId === context.sessionKey &&
    event.turnId === owner.turnId &&
    event.runId === owner.runId
  );
  const exactRunConclusions = runConclusions.filter((event) =>
    event.type === "run.completed" &&
    event.turnId === owner.turnId &&
    event.runId === owner.runId
  );
  const turnConclusions = state.runtimeEvents.filter((event) =>
    event.type === "turn.completed" &&
    event.threadId === context.sessionKey &&
    event.turnId === owner.turnId
  );
  const finals = state.taskFlow.filter(
    (block): block is Extract<TaskBlock, { type: "agent" }> =>
      block.type === "agent" &&
      block.turnId === owner.turnId &&
      block.visibility === "assistant_final",
  );
  const runConclusion = exactRunConclusions[0];
  const turnConclusion = turnConclusions[0];
  if (
    !turn ||
    outcome?.status !== "completed" ||
    outcome.runId !== owner.runId ||
    outcome.parentRunId !== owner.parentRunId ||
    outcome.resultKind !== owner.resultKind ||
    exactRunConclusions.length !== 1 ||
    runConclusion?.type !== "run.completed" ||
    runConclusion.parentRunId !== owner.parentRunId ||
    runConclusion.resultKind !== owner.resultKind ||
    runConclusion.summary !== owner.summary ||
    turnConclusions.length !== 1 ||
    turnConclusion?.type !== "turn.completed" ||
    turnConclusion.resultKind !== owner.resultKind ||
    finals.length !== 1 ||
    finals[0].content !== owner.summary ||
    finals[0].streaming === true
  ) {
    return false;
  }
  if (claim && owner.disposition !== "recovery_completed") {
    if (
      turn.clientSubmissionId !== claim.clientSubmissionId ||
      turn.workspaceInstructionReceiptId !== claim.receiptId
    ) return false;
  }
  if (owner.disposition !== "recovery_completed") return true;
  return state.runtimeEvents.some((event) =>
    event.type === "run.completed" &&
    event.threadId === context.sessionKey &&
    event.turnId === context.sourceTurnId &&
    event.runId === context.sourceRunId
  );
}

function assertExactWorkspaceReceiptOwner<TState extends LocalSlashProjectionState>(
  state: TState,
  claim: LocalSlashWorkspaceInstructionClaim | null,
): TState {
  if (!claim) return state;
  const queue = state.workspaceTurnQueue;
  if (!queue) {
    throw new Error("LOCAL_SLASH_DURABLE_QUEUE_MISSING");
  }
  const matchingEntries = queue.entries.filter(
    (entry) => entry.receipt.receiptId === claim.receiptId,
  );
  const head = queue.entries[0];
  if (
    matchingEntries.length !== 1 ||
    head !== matchingEntries[0] ||
    head.status !== "dispatching" ||
    head.claim?.claimId !== claim.claimId ||
    head.receipt.turnId !== claim.turnId ||
    head.instruction.clientSubmissionId !== claim.clientSubmissionId ||
    queue.sessionKey !== claim.sessionKey ||
    queue.sessionEpoch !== claim.sessionEpoch
  ) {
    throw new Error("LOCAL_SLASH_DURABLE_QUEUE_OWNER_CONFLICT");
  }
  return state;
}

function defaultWaitForRetry(
  delayMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      abortSignal?.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, delayMs);
    abortSignal?.addEventListener("abort", finish, { once: true });
  });
}

class LocalSlashPersistenceBoundaryError extends Error {
  readonly reason: "aborted" | "timed_out";

  constructor(reason: "aborted" | "timed_out") {
    super(reason === "aborted"
      ? "Local slash persistence interrupted by stop"
      : "Local slash persistence attempt timed out");
    this.name = "LocalSlashPersistenceBoundaryError";
    this.reason = reason;
  }
}

function awaitPersistenceAttempt<T>(input: {
  start: () => Promise<T>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<T> {
  if (input.abortSignal?.aborted) {
    return Promise.reject(new LocalSlashPersistenceBoundaryError("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.abortSignal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() =>
      reject(new LocalSlashPersistenceBoundaryError("aborted"))
    );
    const timer = setTimeout(
      () => finish(() => reject(new LocalSlashPersistenceBoundaryError("timed_out"))),
      input.timeoutMs,
    );
    input.abortSignal?.addEventListener("abort", onAbort, { once: true });
    let persistence: Promise<T>;
    try {
      persistence = input.start();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    Promise.resolve(persistence).then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}

/**
 * Persist and publish a local-fast conclusion under its captured Session
 * revision. A workspace receipt remains dispatching in this first durable
 * snapshot. The dispatcher retires it only after this barrier resolves; if a
 * crash lands between those two steps, cold restore observes the durable
 * terminal evidence and removes the head without rerunning the handler.
 *
 * Durable storage is retried only within a small bounded budget. Once that
 * budget is exhausted (or a late stop interrupts backoff), the already-final
 * Turn is published as an explicitly temporary, memory-only projection. The
 * handler is never invoked here, so the current process cannot repeat an
 * already-committed local side effect.
 */
export async function commitGameStudioLocalSlashProjection<
  TState extends LocalSlashProjectionState,
>(input: CommitGameStudioLocalSlashProjectionInput<TState>): Promise<void> {
  const waitForRetry = input.waitForRetry || defaultWaitForRetry;
  const maxAttempts = Math.max(1, Math.min(5, input.maxAttempts ?? 3));
  const persistenceAttemptTimeoutMs = Math.max(
    1,
    // The real Project Session coordinator closes its Rust CAS lease at five
    // seconds. Keep this outer boundary slightly wider so retries never stack
    // behind a queue head that has not released yet.
    Math.min(60_000, input.persistenceAttemptTimeoutMs ?? 6_000),
  );
  let lastPersistenceError: unknown = null;

  const publishMemoryFallback = (reason: string, attempts: number): void => {
    for (let fallbackAttempt = 1; fallbackAttempt <= maxAttempts; fallbackAttempt += 1) {
      if (!input.hasSessionRuntimeOwnership()) {
        throw new Error("LOCAL_SLASH_DURABLE_OWNER_LOST");
      }
      const expectedRevisionToken = input.getSessionRevisionToken();
      const baseState = input.sessionGet();
      if (!hasCanonicalConclusion(baseState, input.context, input.claim)) {
        throw new Error("LOCAL_SLASH_DURABLE_CONCLUSION_OWNER_CONFLICT");
      }
      let projectedState = assertExactWorkspaceReceiptOwner(baseState, input.claim);
      if (input.decorateProjection) {
        projectedState = input.decorateProjection(projectedState, input.context);
      }
      const memoryFallbackState = input.buildMemoryFallbackProjection?.(
        projectedState,
        input.context,
      );
      const publication = input.publishProjection({
        projectedState,
        ...(memoryFallbackState ? { durableState: memoryFallbackState } : {}),
        scopeKey: input.scopeKey,
        sessionId: input.sessionId,
        expectedRevisionToken,
      });
      if (publication.published) {
        input.log?.("game_studio_local_slash_memory_fallback_committed", {
          sourceTurnId: input.context.sourceTurnId,
          sourceRunId: input.context.sourceRunId,
          attempts,
          fallbackAttempt,
          reason,
          durability: "memory_only_after_retry_exhaustion",
          storageStatus: "temporary",
          error: lastPersistenceError instanceof Error
            ? lastPersistenceError.message
            : lastPersistenceError == null
            ? null
            : String(lastPersistenceError),
        });
        return;
      }
      if (publication.disposition !== "revision_conflict") {
        throw new Error(
          `LOCAL_SLASH_MEMORY_FALLBACK_PUBLISH_${publication.disposition.toUpperCase()}`,
        );
      }
      input.log?.("game_studio_local_slash_memory_fallback_retry", {
        sourceTurnId: input.context.sourceTurnId,
        sourceRunId: input.context.sourceRunId,
        fallbackAttempt,
        reason: publication.disposition,
      });
    }
    throw new Error("LOCAL_SLASH_MEMORY_FALLBACK_CONCURRENT_UPDATE_LIMIT");
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (input.abortSignal?.aborted) {
      publishMemoryFallback("abort_interrupted_durable_retry", attempt - 1);
      return;
    }
    if (!input.hasSessionRuntimeOwnership()) {
      throw new Error("LOCAL_SLASH_DURABLE_OWNER_LOST");
    }
    const expectedRevisionToken = input.getSessionRevisionToken();
    const baseState = input.sessionGet();
    if (!hasCanonicalConclusion(baseState, input.context, input.claim)) {
      throw new Error("LOCAL_SLASH_DURABLE_CONCLUSION_OWNER_CONFLICT");
    }
    let projectedState = assertExactWorkspaceReceiptOwner(baseState, input.claim);
    if (input.decorateProjection) {
      projectedState = input.decorateProjection(projectedState, input.context);
    }

    let durableState: TState;
    try {
      durableState = await awaitPersistenceAttempt({
        start: () => input.persistProjection(
          projectedState,
          expectedRevisionToken,
        ),
        timeoutMs: persistenceAttemptTimeoutMs,
        abortSignal: input.abortSignal,
      });
      input.rememberDurableState?.(durableState);
    } catch (error) {
      lastPersistenceError = error;
      if (!input.hasSessionRuntimeOwnership()) {
        const ownerLost = new Error("LOCAL_SLASH_DURABLE_OWNER_LOST");
        (ownerLost as Error & { cause?: unknown }).cause = error;
        throw ownerLost;
      }
      if (
        error instanceof LocalSlashPersistenceBoundaryError &&
        error.reason === "aborted"
      ) {
        publishMemoryFallback("abort_interrupted_persistence", attempt);
        return;
      }
      if (input.getSessionRevisionToken() !== expectedRevisionToken) {
        input.log?.("game_studio_local_slash_durable_retry", {
          sourceTurnId: input.context.sourceTurnId,
          sourceRunId: input.context.sourceRunId,
          attempt,
          reason: "revision_changed_during_save",
        });
        if (attempt >= maxAttempts) {
          publishMemoryFallback("revision_retry_exhausted", attempt);
          return;
        }
        continue;
      }
      const delayMs = Math.min(2_000, 100 * (2 ** Math.min(5, attempt - 1)));
      input.log?.("game_studio_local_slash_persist_unavailable", {
        sourceTurnId: input.context.sourceTurnId,
        sourceRunId: input.context.sourceRunId,
        attempt,
        retryDelayMs: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt >= maxAttempts) {
        publishMemoryFallback("persistence_retry_exhausted", attempt);
        return;
      }
      await waitForRetry(delayMs, input.abortSignal);
      if (input.abortSignal?.aborted) {
        publishMemoryFallback("abort_interrupted_durable_retry", attempt);
        return;
      }
      continue;
    }

    const publication = input.publishProjection({
      projectedState,
      durableState,
      scopeKey: input.scopeKey,
      sessionId: input.sessionId,
      expectedRevisionToken,
    });
    if (publication.published) return;
    if (publication.disposition === "revision_conflict") {
      input.log?.("game_studio_local_slash_durable_retry", {
        sourceTurnId: input.context.sourceTurnId,
        sourceRunId: input.context.sourceRunId,
        attempt,
        reason: publication.disposition,
      });
      if (attempt >= maxAttempts) {
        publishMemoryFallback("publication_retry_exhausted", attempt);
        return;
      }
      continue;
    }
    throw new Error(
      `LOCAL_SLASH_DURABLE_PUBLISH_${publication.disposition.toUpperCase()}`,
    );
  }
}
