import {
  isExactUserChoiceResolutionIdentity,
  type ActionRequest,
} from "./actionRequest";
import { getHarnessActionRunId, type HarnessRunMarker } from "./harnessCrashTelemetry";
import type { TaskBlock } from "./taskTypes";
import {
  appendRuntimeEvent,
  isRunTerminalEvent,
  isTerminalTurnEvent,
  withEventSchema,
  type MainThreadEvent,
  type TerminalResultKind,
} from "./turnEvents";
import type { ConversationTurn } from "./workflowModels";
import { stripAssistantPublicProgress } from "./assistantPublicProgress";

export interface CanceledTurnProjectionState {
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  runtimeEvents: MainThreadEvent[];
  currentTurnId?: string | null;
  activeActionRequest?: ActionRequest | null;
  harnessRunMarker?: HarnessRunMarker | null;
  agentStatus?: string;
  isGenerating?: boolean;
  abortController?: AbortController | null;
  elapsedTime?: number;
  pendingReviewResolve?: ((decision: any) => void) | null;
  pendingReviewTaskId?: number | null;
  pendingToolCall?: unknown;
}

export interface CanceledTurnProjectionResult<TState> {
  state: TState;
  cancellationRunId: string;
  harnessRunMarker: HarnessRunMarker | null;
  disposition: "committed" | "already_closed" | "ownership_lost";
}

export interface CanceledTurnControlPlaneFence {
  /** Exact controller observed when the user requested Stop. */
  abortController: AbortController | null;
}

function createCancellationRunId(nowMs: number): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `run-cancel-${uuid}`
    : `run-cancel-${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
}

function canonicalTerminalCloseReason(
  resultKind: TerminalResultKind,
  cancellationReason: string,
): string {
  switch (resultKind) {
    case "success":
      return "agent_loop_completed";
    case "partial":
      return "agent_loop_partial";
    case "blocked":
      return "agent_loop_blocked";
    case "error":
      return "agent_loop_error";
    case "canceled":
      return cancellationReason;
  }
}

function reconcileAlreadyClosedControlPlane<
  TState extends CanceledTurnProjectionState,
>(input: {
  state: TState;
  sessionKey: string;
  turnIds: ReadonlySet<string>;
  requestedRunId: string;
  reason: string;
  timestampMs: number;
  controlPlaneFence?: CanceledTurnControlPlaneFence;
}): { state: TState; harnessRunMarker: HarnessRunMarker | null } {
  const currentTurnId = String(input.state.currentTurnId || "").trim();
  if (!currentTurnId || !input.turnIds.has(currentTurnId)) {
    return {
      state: input.state,
      harnessRunMarker: input.state.harnessRunMarker || null,
    };
  }

  const marker = input.state.harnessRunMarker || null;
  const actionRequest = input.state.activeActionRequest || null;
  if (
    !input.controlPlaneFence ||
    (input.state.abortController ?? null) !== input.controlPlaneFence.abortController
  ) {
    return { state: input.state, harnessRunMarker: marker };
  }
  const markerBelongsToSession = !!marker && marker.sessionKey === input.sessionKey;
  const actionBelongsToSession = !!actionRequest && actionRequest.sessionKey === input.sessionKey;
  const markerOwnsTarget = markerBelongsToSession &&
    !!marker.turnId &&
    input.turnIds.has(marker.turnId) &&
    (marker.status === "running" || marker.status === "paused") &&
    (!input.requestedRunId || getHarnessActionRunId(marker) === input.requestedRunId);
  const actionOwnsTarget = actionBelongsToSession &&
    actionRequest.status === "pending" &&
    input.turnIds.has(actionRequest.turnId) &&
    (!input.requestedRunId || actionRequest.runId === input.requestedRunId);
  const hasSameSessionSuccessorControl = (
    markerBelongsToSession &&
    (marker.status === "running" || marker.status === "paused") &&
    !markerOwnsTarget
  ) || (
    actionBelongsToSession &&
    actionRequest.status === "pending" &&
    !actionOwnsTarget
  );
  const terminalRunIds = new Set(input.state.runtimeEvents
    .filter((event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
      isRunTerminalEvent(event) &&
      event.threadId === input.sessionKey &&
      input.turnIds.has(event.turnId)
    )
    .map((event) => event.runId));
  const canonicalTurn = input.state.conversationTurns.find((turn) =>
    input.turnIds.has(turn.id)
  );
  const canonicalTurnConclusion = [...input.state.runtimeEvents].reverse().find(
    (event): event is Extract<MainThreadEvent, { type: "turn.completed" }> =>
      isTerminalTurnEvent(event) &&
      event.threadId === input.sessionKey &&
      input.turnIds.has(event.turnId),
  );
  const canonicalRunConclusion = [...input.state.runtimeEvents].reverse().find(
    (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
      isRunTerminalEvent(event) &&
      event.threadId === input.sessionKey &&
      input.turnIds.has(event.turnId) &&
      (!input.requestedRunId || event.runId === input.requestedRunId),
  );
  const canonicalResultKind = canonicalTurn?.runtimeOutcome?.resultKind ||
    canonicalTurnConclusion?.resultKind ||
    canonicalRunConclusion?.resultKind ||
    "canceled";
  const canonicalCloseReason = canonicalTurn?.runtimeOutcome?.reason ||
    canonicalTerminalCloseReason(canonicalResultKind, input.reason);
  const hasOpenSuccessorRun = input.state.runtimeEvents.some((event) =>
    event.type === "run.started" &&
    event.threadId === input.sessionKey &&
    input.turnIds.has(event.turnId) &&
    !terminalRunIds.has(event.runId) &&
    (!input.requestedRunId || event.runId !== input.requestedRunId)
  );
  if (hasSameSessionSuccessorControl || hasOpenSuccessorRun) {
    return { state: input.state, harnessRunMarker: marker };
  }

  const quarantinesCrossSessionMarker = !!marker && !markerBelongsToSession;
  const quarantinesCrossSessionAction = !!actionRequest && !actionBelongsToSession;
  const needsCleanup = input.state.isGenerating === true ||
    (typeof input.state.agentStatus === "string" && input.state.agentStatus !== "idle") ||
    !!input.state.abortController ||
    markerOwnsTarget ||
    actionOwnsTarget ||
    quarantinesCrossSessionMarker ||
    quarantinesCrossSessionAction ||
    !!input.state.pendingReviewResolve ||
    input.state.pendingReviewTaskId != null ||
    input.state.pendingToolCall != null;
  if (!needsCleanup) return { state: input.state, harnessRunMarker: marker };

  const harnessRunMarker = quarantinesCrossSessionMarker
    ? null
    : markerOwnsTarget && marker
      ? {
          ...marker,
          status: canonicalResultKind === "error" ? "error" as const : "completed" as const,
          terminalResultKind: canonicalResultKind,
          updatedAt: input.timestampMs,
          closedAt: input.timestampMs,
          closeReason: canonicalCloseReason,
        }
      : marker;
  return {
    state: {
      ...input.state,
      agentStatus: "idle",
      isGenerating: false,
      abortController: null,
      harnessRunMarker,
      activeActionRequest: actionOwnsTarget || quarantinesCrossSessionAction
        ? null
        : actionRequest,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
    },
    harnessRunMarker,
  };
}

/** Close a logical Turn after an explicit user cancellation. */
export function projectCanceledTurn<TState extends CanceledTurnProjectionState>(input: {
  state: TState;
  sessionKey: string;
  turnId: string;
  uiDisplayTurnId?: string | null;
  reason: string;
  message: string;
  nextTaskId: () => number;
  nowMs?: number;
  runId?: string | null;
  parentRunId?: string | null;
  cancellationRunId?: string | null;
  controlPlaneFence?: CanceledTurnControlPlaneFence;
}): CanceledTurnProjectionResult<TState> {
  const timestampMs = input.nowMs ?? Date.now();
  const turnIds = new Set([input.turnId, input.uiDisplayTurnId].filter(Boolean) as string[]);
  const alreadyClosed = input.state.runtimeEvents.some((event) =>
    isTerminalTurnEvent(event) &&
    event.threadId === input.sessionKey &&
    turnIds.has(event.turnId)
  );
  if (alreadyClosed) {
    const requestedRunId = String(input.runId || "").trim();
    const reconciled = reconcileAlreadyClosedControlPlane({
      state: input.state,
      sessionKey: input.sessionKey,
      turnIds,
      requestedRunId,
      reason: input.reason,
      timestampMs,
      controlPlaneFence: input.controlPlaneFence,
    });
    return {
      state: reconciled.state,
      cancellationRunId: requestedRunId,
      harnessRunMarker: reconciled.harnessRunMarker,
      disposition: "already_closed",
    };
  }

  const actionRequest = input.state.activeActionRequest;
  const marker = input.state.harnessRunMarker || null;
  const requestedRunId = String(input.runId || "").trim();
  const markerControlsTurn = !!marker &&
    marker.sessionKey === input.sessionKey &&
    !!marker.turnId &&
    turnIds.has(marker.turnId) &&
    (marker.status === "running" || marker.status === "paused");
  const actionControlsTurn = !!actionRequest &&
    actionRequest.status === "pending" &&
    actionRequest.sessionKey === input.sessionKey &&
    turnIds.has(actionRequest.turnId);
  const markerActionRunId = markerControlsTurn ? getHarnessActionRunId(marker) : null;
  const explicitOwnerWasSuperseded = !!requestedRunId && (
    (!!markerActionRunId && markerActionRunId !== requestedRunId) ||
    (actionControlsTurn && actionRequest.runId !== requestedRunId)
  );
  if (explicitOwnerWasSuperseded) {
    return {
      state: input.state,
      cancellationRunId: requestedRunId,
      harnessRunMarker: marker,
      disposition: "ownership_lost",
    };
  }
  const ownsActionRequest = !!actionRequest &&
    actionRequest.sessionKey === input.sessionKey &&
    turnIds.has(actionRequest.turnId) &&
    (!requestedRunId || actionRequest.runId === requestedRunId);
  const ownerRunId = String(
    requestedRunId ||
    (
      ownsActionRequest
        ? actionRequest.runId
        : ""
    ) ||
    (
      marker?.sessionKey === input.sessionKey && !!marker.turnId && turnIds.has(marker.turnId)
        ? getHarnessActionRunId(marker)
        : ""
    ) ||
    "",
  ).trim();
  const ownerConclusion = ownerRunId
    ? input.state.runtimeEvents.find((event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
        isRunTerminalEvent(event) &&
        event.threadId === input.sessionKey &&
        turnIds.has(event.turnId) &&
        event.runId === ownerRunId
      )
    : undefined;
  const ownerAbort = ownerRunId
    ? input.state.runtimeEvents.find((event): event is Extract<MainThreadEvent, { type: "run.aborted" }> =>
        event.type === "run.aborted" &&
        event.threadId === input.sessionKey &&
        turnIds.has(event.turnId) &&
        event.runId === ownerRunId
      )
    : undefined;
  const requestedCancellationRunId = String(input.cancellationRunId || "").trim();
  const ownerAlreadyCanceled = ownerConclusion?.resultKind === "canceled";
  const cancellationRunId = ownerAlreadyCanceled || ownerAbort
    ? ownerRunId
    : ownerConclusion
      ? requestedCancellationRunId && requestedCancellationRunId !== ownerRunId
        ? requestedCancellationRunId
        : createCancellationRunId(timestampMs)
      : ownerRunId || requestedCancellationRunId || createCancellationRunId(timestampMs);
  const ownsMarkerOwner = !!marker &&
    marker.sessionKey === input.sessionKey &&
    !!marker.turnId &&
    turnIds.has(marker.turnId) &&
    (!ownerRunId || getHarnessActionRunId(marker) === ownerRunId);
  const cancellationParentRunId = cancellationRunId === ownerRunId
    ? input.parentRunId ||
      (ownsActionRequest ? actionRequest.parentRunId : null) ||
      (ownsMarkerOwner ? marker.parentRunId : null) ||
      null
    : ownerRunId;
  const cancellationReason = ownerAbort
    ? ownerAbort.reason
    : input.reason;
  const cancellationMessage = ownerAbort?.message
    ? ownerAbort.message
    : input.message;
  let runtimeEvents = input.state.runtimeEvents;
  if (!runtimeEvents.some((event) =>
    event.type === "run.started" &&
    event.threadId === input.sessionKey &&
    event.turnId === input.turnId &&
    event.runId === cancellationRunId
  )) {
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
      type: "run.started",
      threadId: input.sessionKey,
      turnId: input.turnId,
      timestampMs,
      runId: cancellationRunId,
      parentRunId: cancellationParentRunId,
    }));
  }
  if (!runtimeEvents.some((event) =>
    event.type === "run.aborted" &&
    event.threadId === input.sessionKey &&
    event.turnId === input.turnId &&
    event.runId === cancellationRunId
  )) {
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
      type: "run.aborted",
      threadId: input.sessionKey,
      turnId: input.turnId,
      timestampMs,
      runId: cancellationRunId,
      parentRunId: cancellationParentRunId,
      reason: cancellationReason,
      message: cancellationMessage,
    }));
  }
  runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
    type: "run.completed",
    threadId: input.sessionKey,
    turnId: input.turnId,
    timestampMs,
    runId: cancellationRunId,
    parentRunId: cancellationParentRunId,
    resultKind: "canceled",
    summary: cancellationMessage,
  }));
  runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
    type: "turn.completed",
    threadId: input.sessionKey,
    turnId: input.turnId,
    timestampMs,
    resultKind: "canceled",
  }));

  const ownedUserChoiceRequest = ownsActionRequest && actionRequest?.kind === "user_choice"
    ? actionRequest
    : null;
  const archivedTaskFlow = ownedUserChoiceRequest
    ? input.state.taskFlow.map((block) => {
        if (
          block.type !== "agent" ||
          !Array.isArray(block.options) ||
          block.options.length === 0 ||
          !isExactUserChoiceResolutionIdentity(block.choiceRequest, ownedUserChoiceRequest)
        ) {
          return block;
        }
        const archivesProposal = block.options.some((option) =>
          option.action === "approve_operation_once" ||
          option.action === "execute_once" ||
          option.source === "proposal_follow_up" ||
          option.source === "operation_approval"
        );
        return {
          ...block,
          options: undefined,
          choiceRequest: undefined,
          archivedAfterChoice: true,
          ...(archivesProposal ? { archivedProposal: true } : {}),
        };
      })
    : input.state.taskFlow;

  const existingFinal = [...archivedTaskFlow].reverse().find((block) =>
    block.type === "agent" &&
    block.visibility === "assistant_final" &&
    !!block.turnId &&
    turnIds.has(block.turnId)
  );
  const finalBlockId = existingFinal?.id ?? input.nextTaskId();
  let foundFinal = false;
  let taskFlow = archivedTaskFlow.map((block) => {
    if (block.id === finalBlockId && block.type === "agent") {
      foundFinal = true;
      return {
        ...stripAssistantPublicProgress(block),
        content: cancellationMessage,
        streaming: false,
        hiddenProcess: false,
        visibility: "assistant_final" as const,
      };
    }
    if (
      block.type === "agent" &&
      block.visibility === "assistant_final" &&
      !!block.turnId &&
      turnIds.has(block.turnId)
    ) {
      return {
        ...stripAssistantPublicProgress(block),
        visibility: "assistant_update" as const,
      };
    }
    return block;
  });
  if (!foundFinal) {
    taskFlow = [...taskFlow, {
      id: finalBlockId,
      turnId: input.uiDisplayTurnId || input.turnId,
      type: "agent" as const,
      content: cancellationMessage,
      streaming: false,
      visibility: "assistant_final" as const,
    }];
  }

  const ownsMarkerTurn = !!marker &&
    marker.sessionKey === input.sessionKey &&
    !!marker.turnId &&
    turnIds.has(marker.turnId) &&
    (marker.status === "running" || marker.status === "paused") &&
    (!ownerRunId || getHarnessActionRunId(marker) === ownerRunId);
  const markerBelongsToSession = !!marker && marker.sessionKey === input.sessionKey;
  const actionBelongsToSession = !!actionRequest && actionRequest.sessionKey === input.sessionKey;
  const hasForeignMarkerOwner = markerBelongsToSession &&
    (marker.status === "running" || marker.status === "paused") &&
    !ownsMarkerTurn;
  const hasForeignActionOwner = actionBelongsToSession &&
    actionRequest.status === "pending" &&
    !ownsActionRequest;
  const hasForeignControlOwner = hasForeignMarkerOwner || hasForeignActionOwner;
  const ownsPendingReview = ownsActionRequest &&
    actionRequest.kind === "tool_permission" &&
    input.state.pendingReviewTaskId === actionRequest.taskId;
  const shouldClearPendingReview = !hasForeignControlOwner || ownsPendingReview;
  const harnessRunMarker = marker && !markerBelongsToSession
    ? null
    : ownsMarkerTurn && marker
    ? {
        ...marker,
        status: "completed" as const,
        terminalResultKind: "canceled" as const,
        activeRunId: cancellationRunId,
        activeParentRunId: cancellationParentRunId,
        updatedAt: timestampMs,
        closedAt: timestampMs,
        closeReason: cancellationReason,
      }
    : marker;
  const state = {
    ...input.state,
    taskFlow,
    runtimeEvents,
    harnessRunMarker,
    activeActionRequest: ownsActionRequest || (actionRequest && !actionBelongsToSession)
      ? null
      : actionRequest,
    conversationTurns: input.state.conversationTurns.map((turn) =>
      turnIds.has(turn.id)
        ? {
            ...turn,
            status: "done" as const,
            summary: cancellationMessage,
            collapsed: false,
            blockIds: turn.id === (input.uiDisplayTurnId || input.turnId) && !turn.blockIds.includes(finalBlockId)
              ? [...turn.blockIds, finalBlockId]
              : turn.blockIds,
            runtimeOutcome: {
              status: "completed" as const,
              reason: cancellationReason,
              resultKind: "canceled" as const,
              runId: cancellationRunId,
              parentRunId: cancellationParentRunId,
              updatedAt: timestampMs,
            },
          }
        : turn
    ),
    ...(!hasForeignControlOwner
      ? {
          agentStatus: "idle",
          isGenerating: false,
          abortController: null,
        }
      : {}),
    ...(shouldClearPendingReview
      ? {
          pendingReviewResolve: null,
          pendingReviewTaskId: null,
          pendingToolCall: null,
        }
      : {}),
  } as TState;
  return { state, cancellationRunId, harnessRunMarker, disposition: "committed" };
}
