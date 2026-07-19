import type { AttachedFile } from "../lib/attachments";
import type { FeishuRemoteContext } from "../lib/remoteContextTypes";
import type {
  HarnessRunMarker,
  HarnessRunOwner,
} from "../lib/harnessCrashTelemetry";
import type {
  PendingSlashCommand,
  ParsedSetupEngineArgs,
  StudioAgentKey,
} from "../lib/gameStudio/catalog";
import type { MainModeKey } from "../lib/mainModes";
import type {
  CommandDirective,
  LegacyWorkflowMode,
  ResolvedRunIntent,
} from "../lib/runIntent";
import type { AgentMessage } from "../lib/orchestrator";
import type { WorkflowEngineStoreHelpers } from "../lib/orchestrator/workflowEngine";
import type { TaskBlock } from "../lib/taskTypes";
import type {
  ConversationTurn,
  PendingOperationProposal,
  PlanArtifact,
  PlanStage,
} from "../lib/workflowModels";
import type { SubagentDelegationPreference, TurnInputContextSignals } from "../lib/turnIntake";
import type {
  GoalContinuationAuthorization,
  GoalCreationAuthorization,
} from "../lib/submit/turnSubmission";
import { buildGoalSourceContextSnapshot } from "../lib/goalSourceContext";
import {
  buildSubmitAttachmentContext,
  type SubmitAttachmentContextInput,
} from "./submitAttachmentContext";
import { buildSubmitPromptContext } from "./submitPromptContext";
import {
  runSubmitGameStudioPreparation,
  type SubmitGameStudioPreparationState,
} from "./submitGameStudioPreparation";
import {
  createSubmitHarnessRunId,
  startSubmitRunLease,
  type StartSubmitRunLeaseInput,
} from "./submitRunLease";
import {
  createSubmitWorkflowContext,
  type CreateSubmitWorkflowContextInput,
} from "./submitWorkflowContext";
import {
  startSubmitStreamingUi,
  type StartSubmitStreamingUiInput,
} from "./submitStreamingUi";
import {
  runSubmitWorkflowEngine,
  type RunSubmitWorkflowEngineInput,
} from "./submitWorkflowEngineRunner";
import type { GameStudioTurnRuntimeService } from "./gameStudioTurnPreparation";
import {
  appendRuntimeEvent,
  isRunTerminalEvent,
  isTerminalTurnEvent,
  withEventSchema,
} from "../lib/turnEvents";

type SubmitAsyncWorkflowSet = (patchOrUpdater: any) => void;

export interface SubmitAsyncWorkflowRunState extends SubmitGameStudioPreparationState {
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  isPlanApproved: boolean;
  planStage: PlanStage;
  planArtifacts: PlanArtifact[];
  agentMessages: AgentMessage[];
  conversationTurns: ConversationTurn[];
  harnessRunMarker?: HarnessRunMarker | null;
  taskFlow: TaskBlock[];
  runtimeEvents: ReturnType<typeof withEventSchema>[];
  activeActionRequest?: {
    sessionKey: string;
    turnId: string;
    runId: string;
  } | null;
  agentStatus?: "idle" | "running" | "pending_review" | "error";
  isGenerating?: boolean;
  abortController?: AbortController | null;
  config: {
    sessionRecordingEnabled?: boolean;
    reasoningDisplay?: string;
  };
  startGoal: (objective: string, options: { sessionKey: string; sourceContext?: string; ownerTurnId: string; subagentPreference?: SubagentDelegationPreference }) => void;
}

export interface SubmitAsyncWorkflowElapsedTimer {
  timerInterval: unknown;
  getElapsedSeconds: () => number;
  dispose: () => void;
}

export interface SubmitAsyncWorkflowRunPhaseRunners<
  TState extends SubmitAsyncWorkflowRunState,
  TAbortController extends AbortController,
> {
  buildAttachmentContext?: typeof buildSubmitAttachmentContext;
  buildPromptContext?: typeof buildSubmitPromptContext;
  runGameStudioPreparation?: typeof runSubmitGameStudioPreparation<TState>;
  startRunLease?: typeof startSubmitRunLease<TAbortController>;
  createWorkflowContext?: typeof createSubmitWorkflowContext;
  startStreamingUi?: typeof startSubmitStreamingUi;
  runWorkflowEngine?: typeof runSubmitWorkflowEngine;
}

export interface StartSubmitAsyncWorkflowRunInput<
  TState extends SubmitAsyncWorkflowRunState,
  TAbortController extends AbortController,
> extends Omit<WorkflowEngineStoreHelpers, "persistSessionRecord"> {
  text: string;
  turnId: string;
  uiDisplayTurnId: string;
  currentImages: string[];
  mentionSnapshot: string[];
  attachedFilesSnapshot: Array<AttachedFile | string>;
  runSessionKey: string;
  runWorkspace: string;
  runSessionId: number | null | undefined;
  runScopeKey: string;
  currentMainModeKey: MainModeKey;
  parsedSetupEngineCommand?: ParsedSetupEngineArgs | null;
  parsedStudioCommand: PendingSlashCommand | null;
  cachedWorkspaceTreeForGameDetection: string;
  preferredLanguage: "zh" | "en";
  effectiveRunIntent: ResolvedRunIntent;
  runtimeRunIntent: ResolvedRunIntent;
  goalCreationAuthorization: GoalCreationAuthorization | null;
  goalContinuationAuthorization: GoalContinuationAuthorization | null;
  /** Commits the Goal's active state only after this continuation owns a Run. */
  activateGoalContinuation: (input: {
    authorization: GoalContinuationAuthorization;
    ownerTurnId: string;
    timestampMs: number;
  }) => boolean;
  effectiveWorkflowMode: LegacyWorkflowMode;
  effectiveCommandDirective: CommandDirective | null;
  effectiveIntentSummary: string;
  preservePlanState: boolean;
  shouldContinuePlanIntent: boolean;
  shouldContinuePreviousTurnIntent: boolean;
  shouldExecuteOnceFromReplyOption: boolean;
  currentTurn: ConversationTurn | null;
  previousTurnContinuationTarget: ConversationTurn | null;
  existingTurn: ConversationTurn | null;
  selectedChoiceText: string;
  goalSourceContextSnapshot?: string;
  parentRunIdOverride?: string;
  runIdOverride?: string;
  turnInputContextSignals: TurnInputContextSignals;
  remoteFeishu: FeishuRemoteContext | undefined;
  options: unknown;
  isHidden: boolean;
  createVisibleTurnForHiddenMessage: boolean;
  nextTaskId: () => number;
  sessionGet: () => TState;
  sessionSet: SubmitAsyncWorkflowSet;
  getSessionRuntimeOwnerToken: () => object;
  hasSessionRuntimeOwnership: (expectedOwnerToken?: object) => boolean;
  getSessionRevisionToken: () => unknown;
  elapsedTimer: SubmitAsyncWorkflowElapsedTimer;
  markUserContextItemFailed: (path: string | undefined | null) => void;
  ingestAttachmentFile: SubmitAttachmentContextInput["ingestAttachmentFile"];
  readFile: SubmitAttachmentContextInput["readFile"];
  readDocument: SubmitAttachmentContextInput["readDocument"];
  analyzeTabularDocument: SubmitAttachmentContextInput["analyzeTabularDocument"];
  runtimeService: GameStudioTurnRuntimeService;
  logWarning: (event: string, data: Record<string, unknown>) => void;
  invalidateWorkspaceTreeCache: () => void;
  createAbortController: () => TAbortController;
  getCurrentHarnessInstanceId: () => string;
  readHarnessRunMarker: () => HarnessRunMarker | null;
  acquireHarnessRunMarker: (
    marker: HarnessRunMarker,
    expectedCurrent: HarnessRunMarker | null,
  ) => HarnessRunMarker | null;
  persistHarnessRunMarkerIfOwned: (
    marker: HarnessRunMarker,
    owner: HarnessRunOwner,
  ) => HarnessRunMarker | null;
  getWorkspaceTree: (workspace: string) => Promise<string>;
  nowMs: () => number;
  sendStartedAt: number;
  getLastTurnToolSummary: (turnId: string, taskFlow: TaskBlock[]) => string;
  getLastVisibleTurnAgentSummary: (turnId: string, taskFlow: TaskBlock[]) => string;
  persistBootstrapProjection: (state: TState) => Promise<TState>;
  phaseRunners?: SubmitAsyncWorkflowRunPhaseRunners<TState, TAbortController>;
  PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: number;
  PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: number;
  PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: number;
}

function resolveApprovedProposal(input: {
  shouldExecuteOnceFromReplyOption: boolean;
  existingTurn: ConversationTurn | null;
  currentTurn: ConversationTurn | null;
  previousTurnContinuationTarget: ConversationTurn | null;
}): PendingOperationProposal | undefined {
  if (!input.shouldExecuteOnceFromReplyOption) return undefined;
  return (
    input.existingTurn?.pendingOperationProposal ||
    input.currentTurn?.pendingOperationProposal ||
    input.previousTurnContinuationTarget?.pendingOperationProposal
  );
}

/**
 * Submission setup happens before WorkflowEngine owns the run. Any exception
 * in that window still has to produce one visible conclusion and close the
 * logical turn; otherwise the UI can remain generating forever.
 */
interface SubmitBootstrapRunOwner {
  harnessRunId: string;
  runId: string;
  parentRunId: string | null;
  instanceId: string;
  startedAt: number;
}

function toExactBootstrapHarnessOwner(marker: HarnessRunMarker): HarnessRunOwner {
  return {
    runId: marker.runId,
    sessionKey: marker.sessionKey,
    turnId: marker.turnId || "",
    instanceId: marker.instanceId,
    startedAt: marker.startedAt,
  };
}

function isRepairableBootstrapErrorTerminal(event: ReturnType<typeof withEventSchema> | undefined): boolean {
  return event?.type === "run.failed" ||
    (event?.type === "run.completed" && event.resultKind === "error");
}

export function projectSubmitBootstrapErrorConclusion<
  TState extends SubmitAsyncWorkflowRunState,
>(input: {
  state: TState;
  sessionKey: string;
  turnId: string;
  uiDisplayTurnId: string;
  submissionRunId: string;
  parentRunId: string | null;
  message: string;
  detail: string;
  elapsedTime: number;
  timestampMs: number;
  nextTaskId: () => number;
  ownsActiveMarker: boolean;
  ownsActionRequest: boolean;
  hasForeignControlOwner: boolean;
}): TState {
  const ownerTurnIds = new Set([input.turnId, input.uiDisplayTurnId].filter(Boolean));
  const existingFinal = [...input.state.taskFlow].reverse().find((block) =>
    !!block.turnId &&
    ownerTurnIds.has(block.turnId) &&
    block.type === "agent" &&
    block.visibility === "assistant_final"
  );
  const finalBlockId = existingFinal?.id ?? input.nextTaskId();
  let foundFinal = false;
  let taskFlow = input.state.taskFlow.map((block) => {
    if (block.id === finalBlockId && block.type === "agent") {
      foundFinal = true;
      return {
        ...block,
        content: input.message,
        streaming: false,
        hiddenProcess: false,
        visibility: "assistant_final" as const,
      };
    }
    if (
      !!block.turnId &&
      ownerTurnIds.has(block.turnId) &&
      block.type === "agent" &&
      block.visibility === "assistant_final"
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
      content: input.message,
      streaming: false,
      visibility: "assistant_final" as const,
    }];
  }

  let runtimeEvents = input.state.runtimeEvents || [];
  const existingRunTerminal = runtimeEvents.find((event) =>
    isRunTerminalEvent(event) &&
    event.threadId === input.sessionKey &&
    event.turnId === input.turnId &&
    event.runId === input.submissionRunId
  );
  if (!existingRunTerminal) {
    if (!runtimeEvents.some((event) =>
      event.type === "run.started" &&
      event.threadId === input.sessionKey &&
      event.turnId === input.turnId &&
      event.runId === input.submissionRunId
    )) {
      runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
        type: "run.started",
        threadId: input.sessionKey,
        turnId: input.turnId,
        timestampMs: input.timestampMs,
        runId: input.submissionRunId,
        parentRunId: input.parentRunId,
      }));
    }
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
      type: "run.completed",
      threadId: input.sessionKey,
      turnId: input.turnId,
      timestampMs: input.timestampMs,
      runId: input.submissionRunId,
      parentRunId: input.parentRunId,
      resultKind: "error",
      summary: input.message,
    }));
  }
  runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
    type: "turn.completed",
    threadId: input.sessionKey,
    turnId: input.turnId,
    timestampMs: input.timestampMs,
    resultKind: "error",
  }));

  const marker = input.state.harnessRunMarker;
  const harnessRunMarker = input.ownsActiveMarker && marker
    ? {
        ...marker,
        status: "completed",
        closeReason: "submit_bootstrap_error",
        closedAt: input.timestampMs,
        updatedAt: input.timestampMs,
      } as HarnessRunMarker
    : marker;

  return {
    ...input.state,
    taskFlow,
    runtimeEvents,
    harnessRunMarker,
    activeActionRequest: input.ownsActionRequest ? null : input.state.activeActionRequest,
    conversationTurns: input.state.conversationTurns.map((turn) =>
      ownerTurnIds.has(turn.id)
        ? {
            ...turn,
            status: "done" as const,
            summary: input.message,
            collapsed: false,
            runtimeOutcome: {
              status: "completed" as const,
              reason: input.detail,
              resultKind: "error" as const,
              runId: input.submissionRunId,
              parentRunId: input.parentRunId,
              updatedAt: input.timestampMs,
            },
            blockIds: turn.id === (input.uiDisplayTurnId || input.turnId) &&
              !turn.blockIds.includes(finalBlockId)
              ? [...turn.blockIds, finalBlockId]
              : turn.blockIds,
          }
        : turn
    ),
    ...(!input.hasForeignControlOwner
      ? {
          agentStatus: "idle" as const,
          isGenerating: false,
          abortController: null,
          elapsedTime: input.elapsedTime,
          pendingSlashCommand: null,
        }
      : {}),
  } as TState;
}

export function finalizeSubmitBootstrapFailure<
  TState extends SubmitAsyncWorkflowRunState,
  TAbortController extends AbortController,
>(
  input: StartSubmitAsyncWorkflowRunInput<TState, TAbortController>,
  error: unknown,
  owner: {
    submissionRunId: string;
    parentRunId: string | null;
    acquired: SubmitBootstrapRunOwner | null;
  },
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error || "unknown error");
  const message = input.preferredLanguage === "en"
    ? `This turn is complete, but MAIN could not start the workflow. ${detail}`
    : `本回合已结束，但 MAIN 未能启动工作流。原因：${detail}`;
  input.elapsedTimer.dispose();
  const elapsedTime = input.elapsedTimer.getElapsedSeconds();

  const finalize = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revisionToken = input.getSessionRevisionToken();
      const state = input.sessionGet();
      if (input.getSessionRevisionToken() !== revisionToken) {
        input.logStoreEvent("submit_bootstrap_projection_retry", {
          sessionKey: input.runSessionKey,
          turnId: input.turnId,
          runId: owner.submissionRunId,
          attempt: attempt + 1,
          phase: "snapshot",
        });
        continue;
      }
      const marker = state.harnessRunMarker;
      const existingRunTerminal = (state.runtimeEvents || []).find((event) =>
        isRunTerminalEvent(event) &&
        event.threadId === input.runSessionKey &&
        event.turnId === input.turnId &&
        event.runId === owner.submissionRunId
      );
      const existingTurnTerminal = (state.runtimeEvents || []).find((event) =>
        isTerminalTurnEvent(event) &&
        event.threadId === input.runSessionKey &&
        event.turnId === input.turnId
      );
      if (existingTurnTerminal || (existingRunTerminal && !isRepairableBootstrapErrorTerminal(existingRunTerminal))) {
        input.logStoreEvent("submit_bootstrap_terminal_already_committed", {
          sessionKey: input.runSessionKey,
          turnId: input.turnId,
          runId: owner.submissionRunId,
          runTerminalType: existingRunTerminal?.type || null,
          turnTerminalType: existingTurnTerminal?.type || null,
        });
        return;
      }
      if (existingRunTerminal) {
        input.logStoreEvent("submit_bootstrap_partial_terminal_repair", {
          sessionKey: input.runSessionKey,
          turnId: input.turnId,
          runId: owner.submissionRunId,
          runTerminalType: existingRunTerminal.type,
        });
      }
      const ownsActiveMarker = !!marker &&
        marker.status === "running" &&
        marker.sessionKey === input.runSessionKey &&
        marker.turnId === input.turnId &&
        marker.runId === (owner.acquired?.harnessRunId || owner.submissionRunId) &&
        (!owner.acquired || (
          marker.instanceId === owner.acquired.instanceId &&
          marker.startedAt === owner.acquired.startedAt
        ));
      const markerOwnsControl = !!marker &&
        (marker.status === "running" || marker.status === "paused");
      const ownsActionRequest = !!state.activeActionRequest &&
        state.activeActionRequest.sessionKey === input.runSessionKey &&
        state.activeActionRequest.turnId === input.turnId &&
        (
          state.activeActionRequest.runId === owner.submissionRunId ||
          (!!owner.parentRunId && state.activeActionRequest.runId === owner.parentRunId)
        );
      const newerRunOwnsTurn = markerOwnsControl &&
        marker.sessionKey === input.runSessionKey &&
        marker.turnId === input.turnId &&
        !ownsActiveMarker;
      const newerActionOwnsTurn = !!state.activeActionRequest &&
        state.activeActionRequest.sessionKey === input.runSessionKey &&
        state.activeActionRequest.turnId === input.turnId &&
        !ownsActionRequest;
      if (newerRunOwnsTurn || newerActionOwnsTurn) {
        input.logStoreEvent("submit_bootstrap_stale_owner_skipped", {
          sessionKey: input.runSessionKey,
          turnId: input.turnId,
          runId: owner.submissionRunId,
          activeRunId: marker?.activeRunId || marker?.runId || null,
        });
        return;
      }

      const hasForeignControlOwner = (
        markerOwnsControl && !ownsActiveMarker
      ) || (
        !!state.activeActionRequest && !ownsActionRequest
      );
      const projectedState = projectSubmitBootstrapErrorConclusion({
        state,
        sessionKey: input.runSessionKey,
        turnId: input.turnId,
        uiDisplayTurnId: input.uiDisplayTurnId,
        submissionRunId: owner.submissionRunId,
        parentRunId: owner.parentRunId,
        message,
        detail,
        elapsedTime,
        timestampMs: input.nowMs(),
        nextTaskId: input.nextTaskId,
        ownsActiveMarker,
        ownsActionRequest,
        hasForeignControlOwner,
      });
      const harnessRunMarker = projectedState.harnessRunMarker;
      const exactHarnessOwner = ownsActiveMarker && marker
        ? toExactBootstrapHarnessOwner(marker)
        : null;
      let durableState = projectedState;
      try {
        durableState = await input.persistBootstrapProjection(projectedState);
      } catch (persistError) {
        input.logStoreEvent("submit_bootstrap_conclusion_persist_unavailable", {
          sessionKey: input.runSessionKey,
          turnId: input.turnId,
          runId: owner.submissionRunId,
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }
      if (input.getSessionRevisionToken() !== revisionToken) {
        input.logStoreEvent("submit_bootstrap_projection_retry", {
          sessionKey: input.runSessionKey,
          turnId: input.turnId,
          runId: owner.submissionRunId,
          attempt: attempt + 1,
        });
        continue;
      }
      if (exactHarnessOwner && harnessRunMarker) {
        try {
          const persistedMarker = input.persistHarnessRunMarkerIfOwned(
            harnessRunMarker,
            exactHarnessOwner,
          );
          if (persistedMarker) {
            durableState = {
              ...durableState,
              harnessRunMarker: persistedMarker,
            };
          } else {
            input.logStoreEvent("submit_bootstrap_harness_close_owner_lost", {
              sessionKey: input.runSessionKey,
              turnId: input.turnId,
              runId: owner.submissionRunId,
              instanceId: exactHarnessOwner.instanceId || null,
            });
          }
        } catch (markerError) {
          input.logStoreEvent("submit_bootstrap_harness_close_unavailable", {
            sessionKey: input.runSessionKey,
            turnId: input.turnId,
            runId: owner.submissionRunId,
            error: markerError instanceof Error ? markerError.message : String(markerError),
          });
        }
      }
      const publication = input.publishOwnerScopedRuntimeProjection({
        projectedState,
        durableState,
        scopeKey: input.runScopeKey,
        sessionId: input.runSessionId,
        expectedRevisionToken: revisionToken,
      });
      if (!publication.published) {
        if (publication.disposition === "revision_conflict") {
          input.logStoreEvent("submit_bootstrap_projection_retry", {
            sessionKey: input.runSessionKey,
            turnId: input.turnId,
            runId: owner.submissionRunId,
            attempt: attempt + 1,
            phase: "owner_scoped_publish",
          });
          continue;
        }
        input.logStoreEvent("submit_bootstrap_projection_owner_lost", {
          sessionKey: input.runSessionKey,
          turnId: input.turnId,
          runId: owner.submissionRunId,
          disposition: publication.disposition,
        });
        return;
      }
      input.logStoreEvent("submit_bootstrap_completed_with_error", {
        sessionKey: input.runSessionKey,
        turnId: input.turnId,
        runId: owner.submissionRunId,
        error: detail,
      });
      return;
    }
    let fallbackCommitted = false;
    let fallbackMarker: HarnessRunMarker | null = null;
    let fallbackHarnessOwner: HarnessRunOwner | null = null;
    let fallbackSkipReason = "owner_changed";
    input.sessionSet((latest: TState) => {
      const latestRunTerminal = (latest.runtimeEvents || []).find((event) =>
        isRunTerminalEvent(event) &&
        event.threadId === input.runSessionKey &&
        event.turnId === input.turnId &&
        event.runId === owner.submissionRunId
      );
      const latestTurnTerminal = (latest.runtimeEvents || []).find((event) =>
        isTerminalTurnEvent(event) &&
        event.threadId === input.runSessionKey &&
        event.turnId === input.turnId
      );
      if (latestTurnTerminal) {
        fallbackSkipReason = "turn_already_terminal";
        return {};
      }
      if (latestRunTerminal && !isRepairableBootstrapErrorTerminal(latestRunTerminal)) {
        fallbackSkipReason = `run_already_${latestRunTerminal.type}`;
        return {};
      }

      const latestMarker = latest.harnessRunMarker;
      const ownsActiveMarker = !!latestMarker &&
        latestMarker.status === "running" &&
        latestMarker.sessionKey === input.runSessionKey &&
        latestMarker.turnId === input.turnId &&
        latestMarker.runId === (owner.acquired?.harnessRunId || owner.submissionRunId) &&
        (!owner.acquired || (
          latestMarker.instanceId === owner.acquired.instanceId &&
          latestMarker.startedAt === owner.acquired.startedAt
        ));
      const markerOwnsControl = !!latestMarker &&
        (latestMarker.status === "running" || latestMarker.status === "paused");
      const ownsActionRequest = !!latest.activeActionRequest &&
        latest.activeActionRequest.sessionKey === input.runSessionKey &&
        latest.activeActionRequest.turnId === input.turnId &&
        (
          latest.activeActionRequest.runId === owner.submissionRunId ||
          (!!owner.parentRunId && latest.activeActionRequest.runId === owner.parentRunId)
        );
      const newerRunOwnsTurn = markerOwnsControl &&
        latestMarker.sessionKey === input.runSessionKey &&
        latestMarker.turnId === input.turnId &&
        !ownsActiveMarker;
      const newerActionOwnsTurn = !!latest.activeActionRequest &&
        latest.activeActionRequest.sessionKey === input.runSessionKey &&
        latest.activeActionRequest.turnId === input.turnId &&
        !ownsActionRequest;
      if (newerRunOwnsTurn || newerActionOwnsTurn) {
        fallbackSkipReason = "newer_same_turn_owner";
        return {};
      }
      const hasForeignControlOwner = (
        markerOwnsControl && !ownsActiveMarker
      ) || (
        !!latest.activeActionRequest && !ownsActionRequest
      );
      const projected = projectSubmitBootstrapErrorConclusion({
        state: latest,
        sessionKey: input.runSessionKey,
        turnId: input.turnId,
        uiDisplayTurnId: input.uiDisplayTurnId,
        submissionRunId: owner.submissionRunId,
        parentRunId: owner.parentRunId,
        message,
        detail,
        elapsedTime,
        timestampMs: input.nowMs(),
        nextTaskId: input.nextTaskId,
        ownsActiveMarker,
        ownsActionRequest,
        hasForeignControlOwner,
      });
      fallbackCommitted = true;
      fallbackMarker = projected.harnessRunMarker || null;
      fallbackHarnessOwner = ownsActiveMarker && latestMarker
        ? toExactBootstrapHarnessOwner(latestMarker)
        : null;
      return projected;
    });

    if (!fallbackCommitted) {
      input.logStoreEvent("submit_bootstrap_retry_exhaustion_reconciled", {
        sessionKey: input.runSessionKey,
        turnId: input.turnId,
        runId: owner.submissionRunId,
        reason: fallbackSkipReason,
      });
      return;
    }

    const liveAfterFallback = input.sessionGet();
    const committedFallbackMarker = fallbackMarker as HarnessRunMarker | null;
    const committedFallbackHarnessOwner = fallbackHarnessOwner as HarnessRunOwner | null;
    if (
      committedFallbackMarker &&
      committedFallbackHarnessOwner &&
      liveAfterFallback.harnessRunMarker?.runId === committedFallbackMarker.runId &&
      liveAfterFallback.harnessRunMarker?.instanceId === committedFallbackMarker.instanceId &&
      liveAfterFallback.harnessRunMarker?.sessionKey === committedFallbackMarker.sessionKey &&
      liveAfterFallback.harnessRunMarker?.turnId === committedFallbackMarker.turnId &&
      liveAfterFallback.harnessRunMarker?.status === "completed"
    ) {
      try {
        const persistedMarker = input.persistHarnessRunMarkerIfOwned(
          committedFallbackMarker,
          committedFallbackHarnessOwner,
        );
        if (persistedMarker) {
          input.sessionSet((latest: TState) =>
            latest.harnessRunMarker?.runId === persistedMarker.runId &&
            latest.harnessRunMarker?.instanceId === persistedMarker.instanceId &&
            latest.harnessRunMarker?.sessionKey === persistedMarker.sessionKey &&
            latest.harnessRunMarker?.turnId === persistedMarker.turnId &&
            latest.harnessRunMarker?.status === "completed"
              ? { harnessRunMarker: persistedMarker }
              : {}
          );
        } else {
          input.logStoreEvent("submit_bootstrap_harness_close_owner_lost", {
            sessionKey: input.runSessionKey,
            turnId: input.turnId,
            runId: owner.submissionRunId,
            instanceId: committedFallbackHarnessOwner.instanceId || null,
            phase: "retry_exhaustion",
          });
        }
      } catch (markerError) {
        input.logStoreEvent("submit_bootstrap_harness_close_unavailable", {
          sessionKey: input.runSessionKey,
          turnId: input.turnId,
          runId: owner.submissionRunId,
          error: markerError instanceof Error ? markerError.message : String(markerError),
        });
      }
    }
    try {
      const fallbackRevisionToken = input.getSessionRevisionToken();
      const fallbackProjectedState = input.sessionGet();
      const fallbackDurableState = await input.persistBootstrapProjection(fallbackProjectedState);
      const publication = input.publishOwnerScopedRuntimeProjection({
        projectedState: fallbackProjectedState,
        durableState: fallbackDurableState,
        scopeKey: input.runScopeKey,
        sessionId: input.runSessionId,
        expectedRevisionToken: fallbackRevisionToken,
      });
      if (!publication.published) {
        input.logStoreEvent("submit_bootstrap_fallback_durable_publish_skipped", {
          sessionKey: input.runSessionKey,
          turnId: input.turnId,
          runId: owner.submissionRunId,
          disposition: publication.disposition,
        });
      }
    } catch (persistError) {
      input.logStoreEvent("submit_bootstrap_conclusion_persist_unavailable", {
        sessionKey: input.runSessionKey,
        turnId: input.turnId,
        runId: owner.submissionRunId,
        error: persistError instanceof Error ? persistError.message : String(persistError),
        durability: "memory_only_after_retry_exhaustion",
      });
    }
    input.logStoreEvent("submit_bootstrap_completed_with_error", {
      sessionKey: input.runSessionKey,
      turnId: input.turnId,
      runId: owner.submissionRunId,
      error: detail,
      durability: "memory_first_after_retry_exhaustion",
    });
  };

  return finalize();
}

export async function runSubmitAsyncWorkflowRun<
  TState extends SubmitAsyncWorkflowRunState,
  TAbortController extends AbortController,
>(
  input: StartSubmitAsyncWorkflowRunInput<TState, TAbortController>,
): Promise<void> {
  const phaseRunners = input.phaseRunners || {};
  const phaseLanguage = input.preferredLanguage === "en" ? "en" : "zh";
  const submissionRunId = String(input.runIdOverride || "").trim() ||
    createSubmitHarnessRunId(input.nowMs());
  const initialRuntimeOwnerToken = input.getSessionRuntimeOwnerToken();
  const expectedHarnessRunMarker = input.readHarnessRunMarker();
  let submissionParentRunId = String(input.parentRunIdOverride || "").trim() || null;
  let acquiredRunOwner: SubmitBootstrapRunOwner | null = null;
  let userContent = input.text;
  const activeStudioAgentKey = input.sessionGet().activeStudioAgentKey;
  const gameStudioInitialized = input.sessionGet().gameStudioInitialized;

  try {
  const attachmentContext = await (phaseRunners.buildAttachmentContext || buildSubmitAttachmentContext)({
    text: input.text,
    mentions: input.mentionSnapshot,
    files: input.attachedFilesSnapshot,
    runSessionKey: input.runSessionKey,
    runWorkspace: input.runWorkspace,
    preferredLanguage: input.preferredLanguage,
    markUserContextItemFailed: input.markUserContextItemFailed,
    ingestAttachmentFile: input.ingestAttachmentFile,
    readFile: input.readFile,
    readDocument: input.readDocument,
    analyzeTabularDocument: input.analyzeTabularDocument,
  });
  userContent = attachmentContext.userContent;

  const taskFlowForSummaries = input.sessionGet().taskFlow;
  const previousTurnLastToolSummary =
    input.shouldContinuePreviousTurnIntent && input.previousTurnContinuationTarget
      ? input.getLastTurnToolSummary(input.previousTurnContinuationTarget.id, taskFlowForSummaries)
      : "";
  const previousTurnLastAssistantSummary =
    input.shouldContinuePreviousTurnIntent && input.previousTurnContinuationTarget
      ? input.getLastVisibleTurnAgentSummary(input.previousTurnContinuationTarget.id, taskFlowForSummaries)
      : "";
  const approvedProposal = resolveApprovedProposal(input);
  const latestAssistantSummary =
    input.shouldExecuteOnceFromReplyOption
      ? input.getLastVisibleTurnAgentSummary(input.turnId, input.sessionGet().taskFlow)
      : "";

  userContent = (phaseRunners.buildPromptContext || buildSubmitPromptContext)({
    userContent,
    text: input.text,
    preferredLanguage: phaseLanguage,
    effectiveRunIntent: input.effectiveRunIntent,
    effectiveWorkflowMode: input.effectiveWorkflowMode,
    preservePlanState: input.preservePlanState,
    isPlanApproved: input.sessionGet().isPlanApproved,
    shouldContinuePlanIntent: input.shouldContinuePlanIntent,
    shouldContinuePreviousTurnIntent: input.shouldContinuePreviousTurnIntent,
    shouldExecuteOnceFromReplyOption: input.shouldExecuteOnceFromReplyOption,
    currentTurnUserPrompt: input.currentTurn?.userPrompt,
    previousTurnContinuationTarget: input.previousTurnContinuationTarget,
    previousTurnLastToolSummary,
    previousTurnLastAssistantSummary,
    approvedProposal,
    latestAssistantSummary,
    selectedChoiceText: input.selectedChoiceText,
    turnInputContextSignals: input.turnInputContextSignals,
  }).userContent;

  const gameStudioPreparation = await (phaseRunners.runGameStudioPreparation || runSubmitGameStudioPreparation)({
    currentMainModeKey: input.currentMainModeKey,
    text: input.text,
    userContent,
    parsedSetupEngineCommand: input.parsedSetupEngineCommand,
    parsedStudioCommand: input.parsedStudioCommand,
    activeStudioAgentKey,
    gameStudioInitialized,
    cachedWorkspaceTreeForGameDetection: input.cachedWorkspaceTreeForGameDetection,
    preferredLanguage: input.preferredLanguage,
    runtimeService: input.runtimeService,
    logWarning: input.logWarning,
    sessionGet: input.sessionGet,
    sessionSet: input.sessionSet,
    invalidateWorkspaceTreeCache: input.invalidateWorkspaceTreeCache,
  });
  if (!gameStudioPreparation.ok) {
    throw new Error(gameStudioPreparation.errorMessage || "Game Studio preparation did not complete.");
  }
  userContent = gameStudioPreparation.userContent;

  input.sessionSet({ contextMentions: [], attachedFiles: [] });

  const goalSourceContext = input.effectiveRunIntent === "goal"
    ? input.goalSourceContextSnapshot || buildGoalSourceContextSnapshot({
        objective: input.text,
        agentMessages: input.sessionGet().agentMessages,
        conversationTurns: input.sessionGet().conversationTurns,
        planArtifacts: input.sessionGet().planArtifacts,
      })
    : undefined;

  // Workspace discovery is fallible and does not require an execution lease.
  // Resolve it before marking the harness/run as active so a read failure can
  // be finalized as a pre-run conclusion instead of stranding a running lease.
  const workspaceTreeStartedAt = input.nowMs();
  const workspaceTree = await input.getWorkspaceTree(input.runWorkspace);
  input.logStoreEvent("workspace_tree_ready", {
    turnId: input.turnId,
    workspace: input.runWorkspace || "global",
    chars: workspaceTree.length,
    elapsedMs: Math.round(input.nowMs() - workspaceTreeStartedAt),
  });

  // Bootstrap work above intentionally runs without an execution lease. A
  // workspace clear/delete can remove this Session while an attachment, Game
  // Studio, or workspace discovery promise is pending. Key presence alone is
  // insufficient because a recreated Session may reuse it: require the exact
  // runtime generation captured before the first await.
  if (!input.hasSessionRuntimeOwnership(initialRuntimeOwnerToken)) {
    input.elapsedTimer.dispose();
    input.logStoreEvent("submit_bootstrap_skipped_stale_session_owner", {
      sessionKey: input.runSessionKey,
      turnId: input.turnId,
      runId: submissionRunId,
    });
    return;
  }

  // Cancellation can close a still-owned durable Turn during bootstrap. Check
  // its structured terminal fact after the owner-generation gate and before
  // acquiring any execution capability.
  const terminalTurn = (input.sessionGet().runtimeEvents || []).find((event) =>
    isTerminalTurnEvent(event) &&
    event.threadId === input.runSessionKey &&
    event.turnId === input.turnId
  );
  if (terminalTurn) {
    input.elapsedTimer.dispose();
    input.logStoreEvent("submit_bootstrap_skipped_terminal_turn", {
      sessionKey: input.runSessionKey,
      turnId: input.turnId,
      runId: submissionRunId,
      terminalType: terminalTurn.type,
      terminalResultKind: terminalTurn.type === "turn.completed"
        ? terminalTurn.resultKind || "success"
        : "error",
    });
    return;
  }

  const runLease = (phaseRunners.startRunLease || startSubmitRunLease)({
    userContent,
    canonicalUserText: input.text,
    goalSourceContext,
    currentImages: input.currentImages,
    runSessionKey: input.runSessionKey,
    runWorkspace: input.runWorkspace,
    runSessionId: input.runSessionId,
    turnId: input.turnId,
    effectiveRunIntent: input.effectiveRunIntent,
    runtimeRunIntent: input.runtimeRunIntent,
    continueExistingGoal: !!input.goalContinuationAuthorization,
    goalCreationAuthorization: input.goalCreationAuthorization,
    subagentPreference: input.turnInputContextSignals.subagentPreference,
    parentRunIdOverride: input.parentRunIdOverride,
    runIdOverride: submissionRunId,
    getRuntimeSnapshot: () => ({
      agentMessagesLength: input.sessionGet().agentMessages.length,
      planStage: input.sessionGet().planStage,
      isPlanApproved: input.sessionGet().isPlanApproved,
      harnessRunMarker: input.sessionGet().harnessRunMarker ?? null,
    }),
    appendAgentMessage: (message: AgentMessage) => {
      input.sessionSet((s: TState) => ({ agentMessages: [...s.agentMessages, message] }));
    },
    createAbortController: input.createAbortController,
    setAbortController: (abortController: TAbortController) => {
      input.sessionSet({ abortController });
    },
    startGoal: (objective: string, goalOptions: { sessionKey: string; sourceContext?: string; ownerTurnId: string; subagentPreference?: SubagentDelegationPreference }) => {
      input.sessionGet().startGoal(objective, goalOptions);
    },
    getCurrentHarnessInstanceId: input.getCurrentHarnessInstanceId,
    expectedHarnessRunMarker,
    acquireHarnessRunMarker: input.acquireHarnessRunMarker,
    setHarnessRunMarker: (harnessRunMarker: HarnessRunMarker) => {
      input.sessionSet({ harnessRunMarker });
    },
  } satisfies StartSubmitRunLeaseInput<TAbortController>);
  submissionParentRunId = runLease.parentRunId;
  acquiredRunOwner = {
    harnessRunId: runLease.harnessRunMarker.runId,
    runId: runLease.runId,
    parentRunId: runLease.parentRunId,
    instanceId: runLease.harnessRunMarker.instanceId,
    startedAt: runLease.harnessRunMarker.startedAt,
  };
  if (input.goalContinuationAuthorization) {
    const activated = input.activateGoalContinuation({
      authorization: input.goalContinuationAuthorization,
      ownerTurnId: input.turnId,
      timestampMs: input.nowMs(),
    });
    if (!activated) {
      throw new Error(
        "GOAL_CONTINUATION_OWNER_LOST: the Goal changed before the resume Run lease was accepted",
      );
    }
  }

  const context = (phaseRunners.createWorkflowContext || createSubmitWorkflowContext)({
    turnId: input.turnId,
    uiDisplayTurnId: input.uiDisplayTurnId,
    runWorkspace: input.runWorkspace,
    runSessionKey: input.runSessionKey,
    runSessionId: input.runSessionId,
    runScopeKey: input.runScopeKey,
    phaseLanguage,
    effectiveRunIntent: input.effectiveRunIntent,
    runtimeRunIntent: input.runtimeRunIntent,
    effectiveCommandDirective: input.effectiveCommandDirective,
    options: input.options,
    attachedFilesSnapshot: input.attachedFilesSnapshot,
    mentionSnapshot: input.mentionSnapshot,
    remoteFeishu: input.remoteFeishu,
    workspaceTree,
    gameStudioConfigForTurn: gameStudioPreparation.gameStudioConfigForTurn,
    abortCtrl: runLease.abortController,
    timerInterval: input.elapsedTimer.timerInterval,
    sendStartedAt: input.sendStartedAt,
    harnessRunId: runLease.harnessRunMarker.runId,
    turnAgentMessagesStart: runLease.turnAgentMessagesStart,
    getElapsedSeconds: input.elapsedTimer.getElapsedSeconds,
    PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: input.PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
    PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: input.PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
    PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: input.PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK,
  } satisfies CreateSubmitWorkflowContextInput);

  (phaseRunners.startStreamingUi || startSubmitStreamingUi)({
    context,
    sessionGet: input.sessionGet,
    sessionSet: input.sessionSet,
    nextTaskId: input.nextTaskId,
    currentImageCount: input.currentImages.length,
    contextSignals: input.turnInputContextSignals,
    effectiveIntentSummary: input.effectiveIntentSummary,
    isHidden: input.isHidden,
    createVisibleTurnForHiddenMessage: input.createVisibleTurnForHiddenMessage,
  } satisfies StartSubmitStreamingUiInput);

  await (phaseRunners.runWorkflowEngine || runSubmitWorkflowEngine)({
    get: input.sessionGet,
    set: input.sessionSet,
    getSessionRevisionToken: input.getSessionRevisionToken,
    context,
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    sanitizeAgentMessagesForPersist: input.sanitizeAgentMessagesForPersist,
    normalizeSessionRuntimeSnapshot: input.normalizeSessionRuntimeSnapshot,
    normalizeProviderCompatibilityByRuntimeKey: input.normalizeProviderCompatibilityByRuntimeKey,
    compactCompletedTurnAgentMessages: input.compactCompletedTurnAgentMessages,
    normalizeQueuedUserMessage: input.normalizeQueuedUserMessage,
    publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
    startApprovedPlanExecutionInCurrentTurn: input.startApprovedPlanExecutionInCurrentTurn,
    logStoreEvent: input.logStoreEvent,
  } satisfies RunSubmitWorkflowEngineInput);
  } catch (error) {
    await finalizeSubmitBootstrapFailure(input, error, {
      submissionRunId: acquiredRunOwner?.runId || submissionRunId,
      parentRunId: acquiredRunOwner?.parentRunId ?? submissionParentRunId,
      acquired: acquiredRunOwner,
    });
  }
}

export function startSubmitAsyncWorkflowRun<
  TState extends SubmitAsyncWorkflowRunState,
  TAbortController extends AbortController,
>(
  input: StartSubmitAsyncWorkflowRunInput<TState, TAbortController>,
): Promise<void> {
  return runSubmitAsyncWorkflowRun(input);
}
