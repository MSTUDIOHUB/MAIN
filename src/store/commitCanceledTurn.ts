import {
  projectCanceledTurn,
  type CanceledTurnControlPlaneFence,
  type CanceledTurnProjectionState,
} from "../lib/canceledTurnProjection";
import type { HarnessRunMarker } from "../lib/harnessCrashTelemetry";
import type {
  SubmitOwnerScopedRuntimeProjectionInput,
  SubmitOwnerScopedRuntimePublicationResult,
} from "./submitRuntimeFacade";

export interface CommitCanceledTurnInput<
  TState extends CanceledTurnProjectionState,
> {
  sessionKey: string;
  scopeKey: string;
  sessionId: number | string | null | undefined;
  turnId: string;
  uiDisplayTurnId?: string | null;
  runId?: string | null;
  parentRunId?: string | null;
  reason: string;
  message: string;
  expectedAbortController: AbortController | null;
  nextTaskId: () => number;
  sessionGet: () => TState;
  getSessionRevisionToken: () => unknown;
  persistProjection: (state: TState) => Promise<TState>;
  publishProjection: (
    input: SubmitOwnerScopedRuntimeProjectionInput<TState>,
  ) => SubmitOwnerScopedRuntimePublicationResult;
  persistHarnessMarker?: (
    projected: HarnessRunMarker,
    source: HarnessRunMarker | null,
  ) => HarnessRunMarker | null;
  log?: (event: string, data?: Record<string, unknown>) => void;
  nowMs?: () => number;
  maxAttempts?: number;
}

export interface CommitCanceledTurnResult {
  committed: boolean;
  disposition:
    | "committed_durable"
    | "committed_memory_fallback"
    | "already_closed"
    | "already_closed_durable"
    | "already_closed_memory_fallback"
    | "ownership_lost"
    | "durable_session_missing"
    | "concurrent_update_limit";
  cancellationRunId: string;
  attempts: number;
}

/**
 * Close a canceled Turn as one owner-scoped transaction. Persistence is
 * attempted before the terminal state becomes visible. A memory publication
 * is used only after persistence is unavailable, so every accepted cancel
 * still reaches a conclusion without pretending it was durable.
 */
export async function commitCanceledTurn<TState extends CanceledTurnProjectionState>(
  input: CommitCanceledTurnInput<TState>,
): Promise<CommitCanceledTurnResult> {
  const maxAttempts = Math.max(1, Math.min(5, input.maxAttempts ?? 3));
  let stableCancellationRunId = "";
  const controlPlaneFence: CanceledTurnControlPlaneFence = {
    abortController: input.expectedAbortController,
  };

  const createHarnessSettlement = (
    projectedMarker: HarnessRunMarker | null | undefined,
    sourceMarker: HarnessRunMarker | null | undefined,
  ): (() => void) | undefined => {
    if (
      !input.persistHarnessMarker ||
      !projectedMarker ||
      projectedMarker === sourceMarker
    ) {
      return undefined;
    }
    return () => {
      try {
        input.persistHarnessMarker?.(projectedMarker, sourceMarker || null);
      } catch (error) {
        input.log?.("canceled_turn_harness_persist_unavailable", {
          sessionKey: input.sessionKey,
          turnId: input.turnId,
          runId: stableCancellationRunId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const revisionToken = input.getSessionRevisionToken();
    const baseState = input.sessionGet();
    const projection = projectCanceledTurn({
      state: baseState,
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      uiDisplayTurnId: input.uiDisplayTurnId,
      runId: input.runId,
      parentRunId: input.parentRunId,
      cancellationRunId: stableCancellationRunId,
      reason: input.reason,
      message: input.message,
      nextTaskId: input.nextTaskId,
      nowMs: (input.nowMs || Date.now)(),
      controlPlaneFence,
    });
    stableCancellationRunId = projection.cancellationRunId || stableCancellationRunId;

    if (projection.disposition === "already_closed") {
      let durableState: TState | undefined;
      let persistError: unknown = null;
      try {
        durableState = await input.persistProjection(projection.state);
      } catch (error) {
        persistError = error;
        input.log?.("canceled_turn_closed_projection_persist_unavailable", {
          sessionKey: input.sessionKey,
          turnId: input.turnId,
          runId: stableCancellationRunId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (input.getSessionRevisionToken() !== revisionToken) {
        input.log?.("canceled_turn_closed_projection_retry", {
          sessionKey: input.sessionKey,
          turnId: input.turnId,
          runId: stableCancellationRunId,
          attempt,
        });
        continue;
      }
      if (projection.state !== baseState) {
        const beforePublish = createHarnessSettlement(
          projection.harnessRunMarker,
          baseState.harnessRunMarker,
        );
        const publication = input.publishProjection({
          projectedState: projection.state,
          ...(durableState ? { durableState } : {}),
          scopeKey: input.scopeKey,
          sessionId: input.sessionId,
          expectedRevisionToken: revisionToken,
          ...(beforePublish ? { beforePublish } : {}),
        });
        if (!publication.published) {
          if (publication.disposition === "revision_conflict") continue;
          return {
            committed: false,
            disposition: publication.disposition,
            cancellationRunId: stableCancellationRunId,
            attempts: attempt,
          };
        }
      }
      return {
        committed: true,
        disposition: persistError
          ? "already_closed_memory_fallback"
          : "already_closed_durable",
        cancellationRunId: stableCancellationRunId,
        attempts: attempt,
      };
    }
    if (projection.disposition === "ownership_lost") {
      return {
        committed: false,
        disposition: "ownership_lost",
        cancellationRunId: stableCancellationRunId,
        attempts: attempt,
      };
    }

    let durableState: TState | undefined;
    let persistError: unknown = null;
    try {
      durableState = await input.persistProjection(projection.state);
    } catch (error) {
      persistError = error;
      input.log?.("canceled_turn_projection_persist_unavailable", {
        sessionKey: input.sessionKey,
        turnId: input.turnId,
        runId: stableCancellationRunId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (input.getSessionRevisionToken() !== revisionToken) {
      input.log?.("canceled_turn_projection_retry", {
        sessionKey: input.sessionKey,
        turnId: input.turnId,
        runId: stableCancellationRunId,
        attempt,
      });
      continue;
    }

    const beforePublish = createHarnessSettlement(
      projection.harnessRunMarker,
      baseState.harnessRunMarker,
    );

    const publication = input.publishProjection({
      projectedState: projection.state,
      ...(durableState ? { durableState } : {}),
      scopeKey: input.scopeKey,
      sessionId: input.sessionId,
      expectedRevisionToken: revisionToken,
      ...(beforePublish ? { beforePublish } : {}),
    });
    if (publication.published) {
      return {
        committed: true,
        disposition: persistError
          ? "committed_memory_fallback"
          : "committed_durable",
        cancellationRunId: stableCancellationRunId,
        attempts: attempt,
      };
    }
    if (publication.disposition === "revision_conflict") continue;
    return {
      committed: false,
      disposition: publication.disposition,
      cancellationRunId: stableCancellationRunId,
      attempts: attempt,
    };
  }

  // Last-resort memory closure has no async boundary: project from the latest
  // owner snapshot and publish under that exact token. This avoids leaving a
  // Turn open merely because unrelated runtime progress repeatedly raced the
  // durable attempts; the durability downgrade remains explicit in logs.
  const finalRevisionToken = input.getSessionRevisionToken();
  const finalBaseState = input.sessionGet();
  const finalProjection = projectCanceledTurn({
    state: finalBaseState,
    sessionKey: input.sessionKey,
    turnId: input.turnId,
    uiDisplayTurnId: input.uiDisplayTurnId,
    runId: input.runId,
    parentRunId: input.parentRunId,
    cancellationRunId: stableCancellationRunId,
    reason: input.reason,
    message: input.message,
    nextTaskId: input.nextTaskId,
    nowMs: (input.nowMs || Date.now)(),
    controlPlaneFence,
  });
  if (finalProjection.disposition === "already_closed") {
    if (finalProjection.state !== finalBaseState) {
      const finalBeforePublish = createHarnessSettlement(
        finalProjection.harnessRunMarker,
        finalBaseState.harnessRunMarker,
      );
      const publication = input.publishProjection({
        projectedState: finalProjection.state,
        scopeKey: input.scopeKey,
        sessionId: input.sessionId,
        expectedRevisionToken: finalRevisionToken,
        ...(finalBeforePublish ? { beforePublish: finalBeforePublish } : {}),
      });
      if (!publication.published) {
        return {
          committed: false,
          disposition: publication.disposition === "revision_conflict"
            ? "concurrent_update_limit"
            : publication.disposition,
          cancellationRunId: finalProjection.cancellationRunId || stableCancellationRunId,
          attempts: maxAttempts,
        };
      }
    }
    return {
      committed: true,
      disposition: "already_closed_memory_fallback",
      cancellationRunId: finalProjection.cancellationRunId || stableCancellationRunId,
      attempts: maxAttempts,
    };
  }
  if (finalProjection.disposition === "ownership_lost") {
    return {
      committed: false,
      disposition: "ownership_lost",
      cancellationRunId: finalProjection.cancellationRunId || stableCancellationRunId,
      attempts: maxAttempts,
    };
  }
  const finalBeforePublish = createHarnessSettlement(
    finalProjection.harnessRunMarker,
    finalBaseState.harnessRunMarker,
  );
  const finalPublication = input.publishProjection({
    projectedState: finalProjection.state,
    scopeKey: input.scopeKey,
    sessionId: input.sessionId,
    expectedRevisionToken: finalRevisionToken,
    ...(finalBeforePublish ? { beforePublish: finalBeforePublish } : {}),
  });
  if (finalPublication.published) {
    input.log?.("canceled_turn_projection_memory_fallback", {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      runId: finalProjection.cancellationRunId,
      attempts: maxAttempts,
    });
    return {
      committed: true,
      disposition: "committed_memory_fallback",
      cancellationRunId: finalProjection.cancellationRunId,
      attempts: maxAttempts,
    };
  }
  return {
    committed: false,
    disposition: finalPublication.disposition === "revision_conflict"
      ? "concurrent_update_limit"
      : finalPublication.disposition,
    cancellationRunId: finalProjection.cancellationRunId || stableCancellationRunId,
    attempts: maxAttempts,
  };
}
