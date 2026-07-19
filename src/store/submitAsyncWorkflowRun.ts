import type { AttachedFile } from "../lib/attachments";
import type { FeishuRemoteContext } from "../lib/remoteContextTypes";
import {
  getHarnessActionRunId,
  type HarnessRunMarker,
  type HarnessRunOwner,
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
  appendRuntimeEventWithResult,
  isRunTerminalEvent,
  isTerminalTurnEvent,
  withEventSchema,
} from "../lib/turnEvents";
import {
  buildPlanApprovalIdentity,
  buildPlanExecutionInstructionHash,
} from "../lib/planApprovalIdentity";
import {
  isPlanApprovalLeaseBoundToState,
  isPlanLifecycleExecutionAuthorizedForRun,
  reducePlanLifecycle,
  type PlanLifecycleState,
} from "../lib/planLifecycle";
import { releasePlanExecutionDispatch } from "../lib/planExecutionDispatchClaim";
import type { PlanApprovalHandoff } from "../lib/sessionTypes";
import {
  capturePlanExecutionRunProvenance,
  type PlanExecutionRunProvenance,
} from "../lib/planExecutionProvenance";

type SubmitAsyncWorkflowSet = (patchOrUpdater: any) => void;

export interface SubmitAsyncWorkflowRunState extends SubmitGameStudioPreparationState {
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  isPlanApproved: boolean;
  planStage: PlanStage;
  planArtifacts: PlanArtifact[];
  planLifecycle: PlanLifecycleState;
  planApprovalChoice?: string | null;
  showPlanPanel?: boolean;
  pendingPlanApprovalHandoff?: PlanApprovalHandoff | null;
  planApprovalExecutionStartedForTurnId?: string | null;
  currentTurnExecutionConsent?: { turnId: string | null; granted: boolean };
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
  planExecutionLeaseId?: string;
  planExecutionInstructionHash?: string;
  requiresPlanExecutionAdmission?: boolean;
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

  const planLifecycle = input.state.planLifecycle;
  const planExecutionLease = planLifecycle?.executionLease || null;
  const planExecutionOwner = planLifecycle?.execution || null;
  const ownsExecutingPlan = !!planExecutionLease && !!planExecutionOwner &&
    isPlanLifecycleExecutionAuthorizedForRun(planLifecycle, {
      executionLeaseId: planExecutionLease.executionLeaseId,
      turnId: input.turnId,
      runId: input.submissionRunId,
      parentRunId: input.parentRunId,
      attempt: planExecutionOwner.attempt,
    });
  const ownsPendingPlanHandoff = planLifecycle?.status === "handoff_pending" &&
    planExecutionLease?.executionTurnId === input.turnId &&
    planExecutionLease.executionRunId === input.submissionRunId &&
    planExecutionLease.parentRunId === input.parentRunId;
  const planTransition = ownsExecutingPlan && planExecutionLease && planExecutionOwner
    ? reducePlanLifecycle(planLifecycle, {
        type: "pause",
        expectedVersion: planLifecycle.version,
        at: input.timestampMs,
        expectedExecutionLeaseId: planExecutionLease.executionLeaseId,
        expectedExecution: planExecutionOwner,
        pause: {
          reason: "submit_bootstrap_error",
          resultKind: "error",
          resumeCondition: "explicit_resume",
        },
      })
    : ownsPendingPlanHandoff
    ? reducePlanLifecycle(planLifecycle, {
        type: "pause",
        expectedVersion: planLifecycle.version,
        at: input.timestampMs,
        pause: {
          reason: "plan_execution_admission_rejected",
          resultKind: "error",
          resumeCondition: "explicit_resume",
        },
      })
    : null;
  const hasPlanTerminalProjection = planTransition && planTransition.disposition !== "rejected";
  const marker = input.state.harnessRunMarker;
  const harnessRunMarker = input.ownsActiveMarker && marker
    ? {
        ...marker,
        status: "completed",
        ...(hasPlanTerminalProjection
          ? { isPlanApproved: false, planStage: "ready_to_execute" }
          : {}),
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
    ...(hasPlanTerminalProjection
      ? {
          planLifecycle: planTransition.state,
          isPlanApproved: false,
          planStage: "ready_to_execute" as const,
          pendingPlanApprovalHandoff: null,
          planApprovalExecutionStartedForTurnId: null,
          currentTurnExecutionConsent: { turnId: null, granted: false },
        }
      : {}),
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

export type TerminalPlanHandoffRollbackDisposition =
  | "rolled_back"
  | "terminal_turn_missing"
  | "not_handoff_pending"
  | "owner_mismatch"
  | "transition_rejected";

/**
 * A bootstrap that discovers an already-terminal logical Turn must never leave
 * the exact child-attempt reservation in handoff_pending. Roll back only the
 * immutable Session/lease/Run owner that this submission was going to admit;
 * a newer or unrelated reservation remains untouched.
 */
export function projectTerminalPlanExecutionHandoffRollback<
  TState extends SubmitAsyncWorkflowRunState,
>(input: {
  state: TState;
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId?: string | null;
  timestampMs: number;
}): {
  disposition: TerminalPlanHandoffRollbackDisposition;
  patch: Partial<TState>;
} {
  const terminalTurn = (input.state.runtimeEvents || []).some((event) =>
    isTerminalTurnEvent(event) &&
    event.threadId === input.sessionKey &&
    event.turnId === input.turnId
  );
  if (!terminalTurn) {
    return { disposition: "terminal_turn_missing", patch: {} };
  }

  const lifecycle = input.state.planLifecycle;
  if (lifecycle?.status !== "handoff_pending") {
    return { disposition: "not_handoff_pending", patch: {} };
  }
  const lease = lifecycle.executionLease;
  const handoff = input.state.pendingPlanApprovalHandoff || null;
  const expectedParentRunId = input.parentRunId === undefined
    ? lease?.parentRunId ?? null
    : input.parentRunId;
  const exactLifecycleOwner = !!lease &&
    !!lifecycle.approvalLease &&
    !!lifecycle.planTurnId &&
    isPlanApprovalLeaseBoundToState(lifecycle) &&
    lifecycle.sessionKey === input.sessionKey &&
    lease.sessionKey === input.sessionKey &&
    lease.sessionEpoch === lifecycle.sessionEpoch &&
    lease.planTurnId === lifecycle.planTurnId &&
    lease.executionTurnId === input.turnId &&
    lease.executionRunId === input.runId &&
    lease.parentRunId === expectedParentRunId;
  const exactHandoffOwner = !handoff || (!!lease &&
    handoff.planTurnId === lifecycle.planTurnId &&
    handoff.approvalLeaseId === lease.approvalLeaseId &&
    handoff.executionLeaseId === lease.executionLeaseId &&
    handoff.sessionEpoch === lifecycle.sessionEpoch &&
    handoff.executionTurnId === lease.executionTurnId &&
    handoff.executionRunId === lease.executionRunId &&
    handoff.executionAttempt === lease.attempt &&
    handoff.executionInstructionHash === lease.instructionHash &&
    handoff.parentRunId === lease.parentRunId &&
    handoff.planRevision === lifecycle.artifactIdentity?.revision &&
    handoff.artifactHash === lifecycle.artifactIdentity?.artifactHash);
  if (!exactLifecycleOwner || !exactHandoffOwner) {
    return { disposition: "owner_mismatch", patch: {} };
  }

  const reset = reducePlanLifecycle(lifecycle, {
    type: "reset",
    expectedVersion: lifecycle.version,
    at: input.timestampMs,
  });
  if (reset.disposition === "rejected") {
    return { disposition: "transition_rejected", patch: {} };
  }
  const currentArtifactIdentity = buildPlanApprovalIdentity(input.state.planArtifacts);
  const discovery = currentArtifactIdentity
    ? reducePlanLifecycle(reset.state, {
        type: "hydrate_discovery",
        expectedVersion: reset.state.version,
        at: input.timestampMs,
        planTurnId: input.turnId,
        artifactIdentity: {
          revision: currentArtifactIdentity.revision,
          artifactHash: currentArtifactIdentity.artifactHash,
          artifactPaths: currentArtifactIdentity.artifactPaths,
        },
      })
    : null;
  if (discovery?.disposition === "rejected") {
    return { disposition: "transition_rejected", patch: {} };
  }
  const discoveredLifecycle = discovery?.state || reset.state;
  const artifactKinds = new Set(input.state.planArtifacts.map((artifact) => artifact.kind));
  const discoveryStage: PlanStage = artifactKinds.has("tasks")
    ? "tasks"
    : artifactKinds.has("bugfix")
    ? "bugfix"
    : artifactKinds.has("plan")
    ? "plan"
    : artifactKinds.has("design")
    ? "design"
    : artifactKinds.has("requirements")
    ? "requirements"
    : "idle";
  return {
    disposition: "rolled_back",
    patch: {
      planLifecycle: discoveredLifecycle,
      isPlanApproved: false,
      planApprovalChoice: null,
      planStage: discoveryStage,
      showPlanPanel: discoveryStage !== "idle",
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: null,
      currentTurnExecutionConsent: { turnId: null, granted: false },
    } as Partial<TState>,
  };
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

export type PlanExecutionAdmissionResult =
  | { ok: true; disposition: "not_applicable"; planExecution: null }
  | {
      ok: true;
      disposition: "applied";
      planExecution: PlanExecutionRunProvenance;
    }
  | { ok: false; reason: string };

/** Consume a Plan execution attempt only after the Harness Run is admitted. */
export function commitPlanExecutionRunAdmission<TState extends SubmitAsyncWorkflowRunState>(input: {
  text: string;
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId: string | null;
  harnessRunMarker: HarnessRunMarker;
  required?: boolean;
  planExecutionLeaseId?: string;
  planExecutionInstructionHash?: string;
  at: number;
  sessionSet: SubmitAsyncWorkflowSet;
  persistHarnessRunMarkerIfOwned: (
    marker: HarnessRunMarker,
    owner: HarnessRunOwner,
  ) => HarnessRunMarker | null;
}): PlanExecutionAdmissionResult {
  const executionLeaseId = String(input.planExecutionLeaseId || "").trim();
  const suppliedInstructionHash = String(input.planExecutionInstructionHash || "").trim();
  if (!executionLeaseId && !suppliedInstructionHash) {
    return input.required === true
      ? { ok: false, reason: "plan_execution_admission_fields_incomplete" }
      : { ok: true, disposition: "not_applicable", planExecution: null };
  }
  if (!executionLeaseId || !suppliedInstructionHash) {
    return { ok: false, reason: "plan_execution_admission_fields_incomplete" };
  }
  const computedInstructionHash = buildPlanExecutionInstructionHash(input.text);
  if (computedInstructionHash !== suppliedInstructionHash) {
    return { ok: false, reason: "plan_execution_instruction_hash_mismatch" };
  }

  let result: PlanExecutionAdmissionResult = {
    ok: false,
    reason: "plan_execution_admission_not_committed",
  };
  input.sessionSet((state: TState) => {
    const marker = state.harnessRunMarker;
    if (
      !marker ||
      marker.status !== "running" ||
      marker.runId !== input.harnessRunMarker.runId ||
      marker.instanceId !== input.harnessRunMarker.instanceId ||
      marker.startedAt !== input.harnessRunMarker.startedAt ||
      marker.sessionKey !== input.sessionKey ||
      marker.turnId !== input.turnId ||
      marker.runId !== input.runId ||
      input.harnessRunMarker.runId !== input.runId ||
      getHarnessActionRunId(marker) !== input.runId ||
      getHarnessActionRunId(marker) !== getHarnessActionRunId(input.harnessRunMarker) ||
      (marker.activeParentRunId || null) !==
        (input.harnessRunMarker.activeParentRunId || null) ||
      (marker.parentRunId || null) !== input.parentRunId ||
      (input.harnessRunMarker.parentRunId || null) !== input.parentRunId
    ) {
      result = { ok: false, reason: "plan_execution_harness_owner_mismatch" };
      return {};
    }
    if ((state.runtimeEvents || []).some((event) =>
      (isTerminalTurnEvent(event) || isRunTerminalEvent(event)) &&
      event.threadId === input.sessionKey &&
      event.turnId === input.turnId &&
      (isTerminalTurnEvent(event) || event.runId === input.runId)
    )) {
      result = { ok: false, reason: "plan_execution_owner_already_terminal" };
      return {};
    }

    const lifecycle = state.planLifecycle;
    const lease = lifecycle?.executionLease;
    const handoff = state.pendingPlanApprovalHandoff;
    if (
      lifecycle?.status !== "handoff_pending" ||
      !lease ||
      !isPlanApprovalLeaseBoundToState(lifecycle) ||
      lease.executionLeaseId !== executionLeaseId ||
      lease.instructionHash !== computedInstructionHash ||
      lease.executionTurnId !== input.turnId ||
      lease.executionRunId !== input.runId ||
      lease.parentRunId !== input.parentRunId ||
      !handoff ||
      handoff.executionLeaseId !== executionLeaseId ||
      handoff.executionAttempt !== lease.attempt ||
      handoff.executionInstructionHash !== computedInstructionHash
    ) {
      result = { ok: false, reason: "plan_execution_lifecycle_owner_mismatch" };
      return {};
    }

    const transition = reducePlanLifecycle(lifecycle, {
      type: "execution_started",
      expectedVersion: lifecycle.version,
      at: input.at,
      executionLeaseId,
      instructionHash: computedInstructionHash,
      execution: {
        turnId: input.turnId,
        runId: input.runId,
        parentRunId: input.parentRunId,
        attempt: lease.attempt,
        startedAt: input.at,
      },
    });
    if (transition.disposition !== "applied") {
      result = {
        ok: false,
        reason: `plan_execution_lifecycle_${transition.reason || transition.disposition}`,
      };
      return {};
    }

    const planExecution = capturePlanExecutionRunProvenance(transition.state);
    if (!planExecution) {
      result = { ok: false, reason: "plan_execution_provenance_capture_failed" };
      return {};
    }
    const runStarted = withEventSchema({
      type: "run.started",
      threadId: input.sessionKey,
      turnId: input.turnId,
      timestampMs: input.at,
      runId: input.runId,
      parentRunId: input.parentRunId,
    });
    const eventAppend = appendRuntimeEventWithResult(state.runtimeEvents, runStarted);
    if (eventAppend.disposition === "conflict") {
      result = { ok: false, reason: "plan_execution_run_started_conflict" };
      return {};
    }
    const nextMarker: HarnessRunMarker = {
      ...marker,
      activeRunId: input.runId,
      activeParentRunId: input.parentRunId,
      activePlanExecutionProvenance: planExecution,
      isPlanApproved: true,
      planStage: "executing",
      updatedAt: input.at,
    };
    const persistedMarker = input.persistHarnessRunMarkerIfOwned(nextMarker, {
      runId: marker.runId,
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      instanceId: marker.instanceId,
      startedAt: marker.startedAt,
    });
    if (!persistedMarker) {
      result = { ok: false, reason: "plan_execution_harness_persist_cas_rejected" };
      return {};
    }
    result = {
      ok: true,
      disposition: "applied",
      planExecution,
    };
    return {
      planLifecycle: transition.state,
      isPlanApproved: true,
      planStage: "executing" as const,
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: input.turnId,
      currentTurnExecutionConsent: { turnId: input.turnId, granted: true },
      harnessRunMarker: persistedMarker,
      runtimeEvents: eventAppend.events,
      conversationTurns: state.conversationTurns.map((turn) =>
        turn.id === input.turnId
          ? { ...turn, status: "executing" as const, summary: "Executing the approved plan." }
          : turn
      ),
    };
  });
  return result;
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
  let dispatchedPlanExecutionLeaseId = String(input.planExecutionLeaseId || "").trim();
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
    let handoffRollbackDisposition: TerminalPlanHandoffRollbackDisposition =
      "not_handoff_pending";
    let handoffRollbackRunId = submissionRunId;
    input.sessionSet((state: TState) => {
      const reservedLease = state.planLifecycle?.status === "handoff_pending" &&
        state.planLifecycle.sessionKey === input.runSessionKey &&
        state.planLifecycle.executionLease?.executionTurnId === input.turnId
        ? state.planLifecycle.executionLease
        : null;
      handoffRollbackRunId = String(input.runIdOverride || "").trim() ||
        reservedLease?.executionRunId ||
        submissionRunId;
      const rollback = projectTerminalPlanExecutionHandoffRollback({
        state,
        sessionKey: input.runSessionKey,
        turnId: input.turnId,
        runId: handoffRollbackRunId,
        parentRunId: String(input.parentRunIdOverride || "").trim()
          ? submissionParentRunId
          : undefined,
        timestampMs: input.nowMs(),
      });
      handoffRollbackDisposition = rollback.disposition;
      return rollback.patch;
    });
    input.elapsedTimer.dispose();
    input.logStoreEvent("submit_bootstrap_skipped_terminal_turn", {
      sessionKey: input.runSessionKey,
      turnId: input.turnId,
      runId: submissionRunId,
      terminalType: terminalTurn.type,
      terminalResultKind: terminalTurn.type === "turn.completed"
        ? terminalTurn.resultKind || "success"
        : "error",
      planHandoffRollbackDisposition: handoffRollbackDisposition,
      planHandoffRollbackRunId: handoffRollbackRunId,
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
  const hasPlanExecutionAdmissionFields = Boolean(
    input.planExecutionLeaseId || input.planExecutionInstructionHash,
  );
  const livePlanLifecycle = input.sessionGet().planLifecycle;
  const liveExecutionLease = livePlanLifecycle?.executionLease || null;
  const runMatchesReservedPlanAttempt =
    livePlanLifecycle?.status === "handoff_pending" &&
    !!liveExecutionLease &&
    liveExecutionLease.executionTurnId === input.turnId &&
    liveExecutionLease.executionRunId === runLease.runId &&
    liveExecutionLease.parentRunId === runLease.parentRunId;
  const mustAdmitPlanExecution =
    input.requiresPlanExecutionAdmission === true ||
    hasPlanExecutionAdmissionFields ||
    runMatchesReservedPlanAttempt;
  // A live, exact lifecycle reservation is authoritative even if a caller
  // omitted the duplicated transport fields. Conversely, a caller cannot
  // downgrade a required Plan admission to a generic Run merely by omitting
  // one or both fields.
  const planExecutionLeaseId = String(
    input.planExecutionLeaseId ||
      (runMatchesReservedPlanAttempt ? liveExecutionLease?.executionLeaseId : "") ||
      "",
  ).trim();
  const planExecutionInstructionHash = String(
    input.planExecutionInstructionHash ||
      (runMatchesReservedPlanAttempt ? liveExecutionLease?.instructionHash : "") ||
      "",
  ).trim();
  dispatchedPlanExecutionLeaseId = planExecutionLeaseId || dispatchedPlanExecutionLeaseId;
  const planExecutionAdmission = mustAdmitPlanExecution
    ? !planExecutionLeaseId || !planExecutionInstructionHash
      ? { ok: false, reason: "plan_execution_admission_fields_incomplete" } as const
      : commitPlanExecutionRunAdmission<TState>({
          text: input.text,
          sessionKey: input.runSessionKey,
          turnId: input.turnId,
          runId: runLease.runId,
          parentRunId: runLease.parentRunId,
          harnessRunMarker: runLease.harnessRunMarker,
          required: true,
          planExecutionLeaseId,
          planExecutionInstructionHash,
          at: input.nowMs(),
          sessionSet: input.sessionSet,
          persistHarnessRunMarkerIfOwned: input.persistHarnessRunMarkerIfOwned,
        })
    : { ok: true, disposition: "not_applicable", planExecution: null } as const;
  if (!planExecutionAdmission.ok) {
    throw new Error(`PLAN_EXECUTION_ADMISSION_REJECTED: ${planExecutionAdmission.reason}`);
  }
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
    planExecution: planExecutionAdmission.planExecution,
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
  } finally {
    releasePlanExecutionDispatch(dispatchedPlanExecutionLeaseId);
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
