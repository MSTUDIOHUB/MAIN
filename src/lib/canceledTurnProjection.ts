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
} from "./turnEvents";
import type { ConversationTurn } from "./workflowModels";

export interface CanceledTurnProjectionState {
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  runtimeEvents: MainThreadEvent[];
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

function createCancellationRunId(nowMs: number): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `run-cancel-${uuid}`
    : `run-cancel-${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
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
}): CanceledTurnProjectionResult<TState> {
  const timestampMs = input.nowMs ?? Date.now();
  const turnIds = new Set([input.turnId, input.uiDisplayTurnId].filter(Boolean) as string[]);
  const alreadyClosed = input.state.runtimeEvents.some((event) =>
    isTerminalTurnEvent(event) &&
    event.threadId === input.sessionKey &&
    turnIds.has(event.turnId)
  );
  if (alreadyClosed) {
    return {
      state: input.state,
      cancellationRunId: String(input.runId || ""),
      harnessRunMarker: input.state.harnessRunMarker || null,
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
        ...block,
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
      return { ...block, visibility: "assistant_update" as const };
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
  const hasForeignMarkerOwner = !!marker &&
    (marker.status === "running" || marker.status === "paused") &&
    !ownsMarkerTurn;
  const hasForeignActionOwner = !!actionRequest &&
    actionRequest.status === "pending" &&
    !ownsActionRequest;
  const hasForeignControlOwner = hasForeignMarkerOwner || hasForeignActionOwner;
  const ownsPendingReview = ownsActionRequest &&
    actionRequest.kind === "tool_permission" &&
    input.state.pendingReviewTaskId === actionRequest.taskId;
  const shouldClearPendingReview = !hasForeignControlOwner || ownsPendingReview;
  const harnessRunMarker = ownsMarkerTurn && marker
    ? {
        ...marker,
        status: "completed" as const,
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
    activeActionRequest: ownsActionRequest ? null : actionRequest,
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
