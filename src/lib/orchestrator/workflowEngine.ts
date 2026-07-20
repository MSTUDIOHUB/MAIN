import { executeAgentLoop, getSessionTaskTargetingEvidence, isReviewablePlanStage, type AgentLoopOutcome, type OrchestratorCallbacks } from "../orchestrator";
import { executeGoalLoop, type GoalEngineCallbacks } from "../goalEngine";
import { isGoalRuntimeDeleted } from "../goalPersistence";
import { isCurrentGoalWorkflowOwner } from "../goalRunOwnership";
import {
  evaluateGoalEvidenceCheckpoint,
  goalRequiresMutation,
  mergeGoalToolObservations,
  type GoalToolObservation,
} from "../goalRuntime";
import {
  buildGoalContinuationPrompt,
  createGoalContinuationState,
  resolveGoalContinuationExecuteRecoveryState,
  restoreGoalContinuationMessages,
} from "../goalContinuity";
import { invoke } from "@tauri-apps/api/core";
import {
  appendThoughtDelta, 
  compactThoughtContent, 
  compactThoughtContentForPersist,
  pickProcessAssistantText,
} from "../thoughtCompaction";
import { resolveStreamingAssistantDisplay } from "../streamDisplayPolicy";
import {
  makeTurnRuntimePhase,
  normalizeTurnRuntimePhase,
  type TurnRuntimePhase,
} from "../turnPhase";
import { getIntentPolicy, type CommandDirective, type ResolvedRunIntent } from "../runIntent";
import {
  resolveContextMemoryStateForRuntimeLane,
  resolveRuntimeLaneKey,
} from "../appConfig";
import {
  resolveSessionRuntimeKey,
  resolveSessionWorkspaceKey,
  type PlanApprovalHandoff,
  type ProviderCompatibilityRuntimeLaneState,
} from "../sessionTypes";
import type { TaskBlock } from "../taskTypes";
import type { AttachedFile } from "../attachments";
import type { FeishuRemoteContext } from "../remoteContextTypes";
import type { StudioConfig as GameStudioConfig } from "../gameStudio/catalog";
import { appendDebugLog } from "../debugLog";
import {
  MAIN_THREAD_EVENT_SCHEMA_VERSION,
  appendRuntimeEvent,
  appendRuntimeEventWithResult,
  isRunBoundaryEvent,
  isRunTerminalEvent,
  isTerminalTurnEvent,
  withEventSchema,
  type MainThreadProgressUpdate,
} from "../turnEvents";
import { type DurableTurnContext, type PlanExecutionEvidenceEntry, type PlanExecutionProgressPhase, type PlanExecutionProgressUpdate, getPlanArtifactTitle, extractPlanTasks, isEphemeralPlanArtifactPath, reconcilePlanTaskCompletion, resolvePlanExecutionEvidenceIdentity, canonicalizePlanArtifactPath, detectPlanArtifactKind, projectAgentLoopStatusToConversationTurnRuntimeStatus } from "../workflowModels";
import {
  PLAN_MAX_AUTO_RESUME_LIMIT,
  buildChatMaxIterationsResumePrompt,
  buildExecuteMaxIterationsAutoResumeNotice,
  buildExecuteMaxIterationsPauseNotice,
  buildExecuteMaxIterationsResumePrompt,
  buildPlanMaxIterationsAutoResumeNotice,
  buildPlanMaxIterationsPauseNotice,
  buildPlanMaxIterationsResumePrompt,
  buildPlanExecutionProgressUpdate,
  normalizePlanExecutionProgressSnapshot,
  resolveExecuteMaxIterationsRecoveryDecision,
  resolveApprovedPlanSameTurnFallbackDecision,
  toPlanExecutionRuntimeProgressUpdate,
  type PlanMaxIterationsCheckpoint,
} from "../planExecutionRecovery";
import {
  appendPlanEvidenceEntry,
  classifyCommandResultOutcome,
  createPlanExecutionEvidenceEntry,
  createPlanExecutionFailureEntry,
  shouldRecordPlanExecutionFailure,
} from "../planEvidence";
import {
  getHarnessActionRunId,
  isHarnessRunMarkerOwnedByRun,
  persistHarnessRunMarkerIfOwned,
  readHarnessRunMarker,
  settleHarnessRunMarkerIfOwned,
  type ExactHarnessRunOwner,
  type HarnessRunMarker,
} from "../harnessCrashTelemetry";
import { generateId } from "../utils";
import { runAfterNextPaint } from "../uiScheduling";
import { supportsToolDiffPreview } from "../toolDiff";
import { findToolLifecycleBlockIndex, type ToolLifecycleMeta } from "../toolLifecycle";
import type { ToolErrorLifecycleMeta } from "./types";
import { deriveToolIntentSummary } from "../toolPresentation";
import { buildToolProgressNarration, summarizeToolObservation } from "../progressNarration";
import { deriveTurnRuntimePhaseForTool, withTurnRuntimePhaseStatus } from "../turnPhase";
import { scheduleControlledSubagent } from "../subagentRuntime";
import {
  buildSubagentPolicyDeferral,
  cancelSubagentRun,
  countParentObservedDelegationPaths,
  finalizeCoordinatedSubagentsForParent,
  getCoordinatedSubagentRunCount,
  getPendingCoordinatedSubagentIds,
  isSubagentActiveStatus,
  parseSubagentAllowedPaths,
  projectSubagentRuns,
  waitForCoordinatedSubagents,
} from "../subagents";
import {
  buildPendingPlanToolPermissionInvalidation,
  buildGoalConfirmationActionRequest,
  buildPlanReviewActionRequest,
  buildUserChoiceActionRequest,
  isPlanExecutionAttemptIdentityCurrentForRun,
  isToolPermissionPlanExecutionIdentityCurrent,
  isActionRequestOwnedByRun,
  settlePendingPlanToolPermissionInvalidation,
  toUserChoiceResolutionIdentity,
  type ActionRequest,
  type PendingPlanToolPermissionInvalidation,
  type UserChoiceActionRequest,
} from "../actionRequest";
import { buildToolPermissionActionRequest } from "../pendingToolReview";
import { createAbortableReviewSettlement } from "../actionReviewSettlement";
import {
  buildPlanApprovalIdentity,
  buildPlanExecutionInstructionHash,
} from "../planApprovalIdentity";
import {
  issuePlanAutoResumeAttempt,
  issuePlanExplicitResumeAttempt,
} from "../planExecutionContinuation";
import {
  capturePlanExecutionRunProvenance,
  doesLifecycleRetainPlanExecutionProvenance,
  type PlanExecutionRunProvenance,
} from "../planExecutionProvenance";
import {
  applyPlanArtifactIdentity,
  applyPlanReviewIdentity,
  ensurePlanLifecycleOwner,
  isPlanApprovalLeaseBoundToState,
  isPlanLifecycleExecutionAuthorizedForRun,
  reducePlanLifecycle,
  type PlanArtifactIdentity,
  type PlanLifecycleState,
  type PlanReviewIdentity,
} from "../planLifecycle";
import { resolveRuntimeRunIdentity, type RuntimeRunIdentity } from "../runIdentity";
import { buildDurableTurnContext, shouldCanonicalizeTerminalTurnContext } from "../durableTurnContext";
import {
  collectPlanTaskTerminalProjection,
  resolveCompletedTurnFinalPresentation,
  resolvePausedTurnFinalPresentation,
  resolveTerminalTurnOwnership,
  shouldCommitCompletedTurnFinalPresentation,
  shouldCommitPausedTurnFinalPresentation,
} from "../terminalAssistantFinal";
import { reduceRunTransition } from "../runTransitionReducer";
import { createTerminalStatusPublicationGate } from "../terminalStatusPublication";
import { findLatestRunOwnedAgentBlock } from "./runOwnedAgentBlocks";
import {
  resolveExecuteRecoveryActionContract,
  type ForcedExecuteRecoveryRuntimeState,
} from "../executeRecoveryTools";
import { scopeExecutionEvidenceLedger } from "../verificationEvidence";
import { isNoOpToolFeedback } from "../toolFeedbackEnvelope";
import { isWorkspaceMutationToolName } from "../workspaceMutationTools";
import {
  isThinModelToolNarration,
  normalizeModelFeedbackForDedupe,
} from "../modelFeedbackDedupe";

type WorkflowStoreState = any;

function toWorkflowPlanArtifactIdentity(
  identity: ReturnType<typeof buildPlanApprovalIdentity>,
): PlanArtifactIdentity | null {
  return identity
    ? {
        revision: identity.revision,
        artifactHash: identity.artifactHash,
        artifactPaths: identity.artifactPaths,
      }
    : null;
}

function alignWorkflowPlanReviewLifecycle(input: {
  lifecycle: PlanLifecycleState | null | undefined;
  request: Extract<ActionRequest, { kind: "plan_review" }>;
  artifactIdentity: PlanArtifactIdentity;
  at: number;
}): PlanLifecycleState | null {
  const owner = ensurePlanLifecycleOwner({
    lifecycle: input.lifecycle,
    sessionKey: input.request.sessionKey,
    at: input.at,
  });
  const reviewIdentity: PlanReviewIdentity = {
    sessionKey: input.request.sessionKey,
    sessionEpoch: owner.sessionEpoch,
    turnId: input.request.turnId,
    runId: input.request.runId,
    parentRunId: input.request.parentRunId || null,
    requestId: input.request.requestId,
    planRevision: input.request.planRevision,
    artifactHash: input.request.artifactHash,
    artifactPaths: input.request.artifactPaths,
  };
  return applyPlanReviewIdentity({
    lifecycle: owner,
    artifactIdentity: input.artifactIdentity,
    reviewIdentity,
    at: input.at,
  });
}

export interface WorkflowEngineStoreHelpers {
  sanitizeTaskBlocksForPersist: (blocks: TaskBlock[]) => TaskBlock[];
  sanitizeAgentMessagesForPersist: (messages: any[]) => any[];
  normalizeSessionRuntimeSnapshot: (snapshot: Record<string, unknown>) => unknown;
  normalizeProviderCompatibilityByRuntimeKey: (value: unknown) => Record<string, ProviderCompatibilityRuntimeLaneState>;
  compactCompletedTurnAgentMessages: (params: {
    agentMessages: any[];
    turnStartIndex: number;
    turnSummary: string;
    turnBlocks: TaskBlock[];
    durableContext?: DurableTurnContext | null;
    language: "zh" | "en";
  }) => any[];
  normalizeQueuedUserMessage: (value: unknown) => any | null;
  getSessionRevisionToken: () => unknown;
  publishOwnerScopedRuntimeProjection: (input: {
    projectedState: WorkflowStoreState;
    durableState?: WorkflowStoreState;
    scopeKey: string;
    sessionId: number | string | null | undefined;
    expectedRevisionToken: unknown;
    beforePublish?: () => void;
  }) => {
    published: boolean;
    disposition: "published" | "revision_conflict" | "ownership_lost" | "durable_session_missing";
  };
  startApprovedPlanExecutionInCurrentTurn: (input: {
    get: () => WorkflowStoreState;
    setActiveState: (patch: Record<string, unknown>) => void;
    planTurnId: string;
    handoff: PlanApprovalHandoff;
    sessionKey: string;
    source: "workflow_fallback";
  }) => void;
  persistSessionRecord: (workspace: string, session: unknown) => Promise<unknown>;
  logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

export interface WorkflowContext {
  // Constants & Parameters
  turnId: string;
  uiDisplayTurnId: string;
  runWorkspace: string | undefined;
  runSessionKey: string;
  runSessionId: number | null | undefined;
  runScopeKey: string;
  phaseLanguage: "zh" | "en";
  effectiveRunIntent: ResolvedRunIntent;
  runtimeRunIntent: ResolvedRunIntent;
  effectiveCommandDirective: CommandDirective | null;
  options: any; // sendMessage options
  attachedFilesSnapshot: Array<AttachedFile | string>;
  mentionSnapshot: string[];
  remoteFeishu: FeishuRemoteContext | undefined;
  workspaceTree: string | null;
  gameStudioConfigForTurn: GameStudioConfig | null;
  abortCtrl: AbortController;
  timerInterval: any;
  sendStartedAt: number;
  harnessRunId: string;
  /** Immutable Plan attempt captured when this Harness Run crossed admission. */
  planExecution: PlanExecutionRunProvenance | null;
  streamBuffer: any; // StreamingCadenceBuffer
  thinkingInterceptor: any; // StreamingThinkingInterceptor
  turnAgentMessagesStart: number;
  getElapsedSeconds: () => number;

  // Mutable Stream Execution State
  agentBlockIdsCreatedThisRun: Set<number>;
  firstStreamTokenAt: number | null;
  streamTokenCount: number;
  streamTextChars: number;
  iterationStreamTokenCount: number;
  iterationStreamTextChars: number;
  runStreamTokenCount: number;
  runStreamTextChars: number;
  noFirstTokenNoticeTimer: any;
  currentStreamingBlockId: number | null;
  currentThoughtBlockId: number | null;
  thoughtStartTime: number | null;
  streamingAssistantDisplayBuffer: string;
  executionEvidenceDraftHeld: boolean;
  executionEvidenceDraftBuffer: string;
  understandingProgressBlockId: number | null;
  understandingProgressClosed: boolean;

  // Constants
  PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: number;
  PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: number;
  PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: number;
}

export class WorkflowEngine {
  constructor(
    private get: () => WorkflowStoreState,
    private set: any,
    private helpers: WorkflowEngineStoreHelpers,
  ) {}

  public run(context: WorkflowContext): Promise<boolean> {
    const sessionGet = this.get;
    const sessionSet = this.set;
    const {
      sanitizeTaskBlocksForPersist,
      sanitizeAgentMessagesForPersist,
      normalizeSessionRuntimeSnapshot,
      normalizeProviderCompatibilityByRuntimeKey,
      compactCompletedTurnAgentMessages,
      normalizeQueuedUserMessage,
      getSessionRevisionToken,
      publishOwnerScopedRuntimeProjection,
      startApprovedPlanExecutionInCurrentTurn,
      persistSessionRecord,
      logStoreEvent: writeStoreEvent,
    } = this.helpers;

    const phaseLanguage = context.phaseLanguage;
    const turnId = context.turnId;
    const runWorkspace = context.runWorkspace;
    const runSessionKey = context.runSessionKey;
    const runSessionId = context.runSessionId;
    const runScopeKey = context.runScopeKey;
    const effectiveRunIntent = context.effectiveRunIntent;
    const runtimeRunIntent = context.runtimeRunIntent;
    const effectiveCommandDirective = context.effectiveCommandDirective;
    const options = context.options;
    let latestExecuteRecoveryState: ForcedExecuteRecoveryRuntimeState | null =
      options?.forceExecuteRecoveryState
        ? {
            ...options.forceExecuteRecoveryState,
            readLease: options.forceExecuteRecoveryState.readLease
              ? { ...options.forceExecuteRecoveryState.readLease }
              : null,
            decisionCheckpoint: options.forceExecuteRecoveryState.decisionCheckpoint
              ? { ...options.forceExecuteRecoveryState.decisionCheckpoint }
              : null,
          }
        : null;
    const resolveCurrentPlanEvidenceIdentity = (record: PlanExecutionEvidenceEntry): {
      planTaskId?: string;
      requirementRef?: string;
    } => {
      const state = sessionGet();
      if (!state.isPlanApproved) return {};
      const checkpoint = latestExecuteRecoveryState?.decisionCheckpoint;
      return resolvePlanExecutionEvidenceIdentity({
        tasks: state.planTasks || [],
        evidenceLedger: state.planExecutionEvidenceLedger || [],
        record,
        preferredPlanTaskId: checkpoint?.planTaskId || null,
        preferredRequirementRef: checkpoint?.requirementRef || null,
      }) || {};
    };
    // const attachedFilesSnapshot = context.attachedFilesSnapshot;
    // const mentionSnapshot = context.mentionSnapshot;
    const remoteFeishu = context.remoteFeishu;
    const workspaceTree = context.workspaceTree;
    const gameStudioConfigForTurn = context.gameStudioConfigForTurn;
    const abortCtrl = context.abortCtrl;
    const timerInterval = context.timerInterval;
    const sendStartedAt = context.sendStartedAt;
    const initialHarnessMarker = sessionGet().harnessRunMarker as HarnessRunMarker | null;
    const harnessRunOwner: ExactHarnessRunOwner = {
      runId: context.harnessRunId,
      sessionKey: runSessionKey,
      turnId,
      instanceId: initialHarnessMarker?.instanceId || "",
      startedAt: initialHarnessMarker?.startedAt ?? -1,
    };
    let activeRuntimeRunIdentity: RuntimeRunIdentity = {
      runId: context.harnessRunId,
      parentRunId:
        initialHarnessMarker?.runId === context.harnessRunId
          ? initialHarnessMarker.parentRunId || null
          : null,
      outerRunId: context.harnessRunId,
      source: "harness_marker",
    };
    let activePlanExecutionIdentity: PlanExecutionRunProvenance | null =
      context.planExecution ? Object.freeze({ ...context.planExecution }) : null;
    let rejectedPlanActionContinuationIdentity: PlanExecutionRunProvenance | null = null;
    let lastNonActionableStopDiagnostic: {
      reason: string;
      recoveryReason: string | null;
      phase: string | null;
      nextStep: string | null;
      repeatedTargets: string[];
    } | null = null;
    const getScopedDurableMutationEvidence = () => scopeExecutionEvidenceLedger(
      sessionGet().planExecutionEvidenceLedger || [],
      turnId,
    ).filter((entry) =>
      entry.kind === "file" &&
      isWorkspaceMutationToolName(entry.sourceTool) &&
      !["failed", "pending", "unknown", "running", "stopped"].includes(
        String(entry.observationStatus || ""),
      )
    );
    let pendingMaxIterationsAutoResume: {
      kind: "chat" | "plan" | "execute";
      start: () => void;
      cancel: (reason: string, options?: { visible?: boolean }) => void;
    } | null = null;
    let pendingEvidenceDraftFinalPresentation: {
      text: any;
      replyOptions: any[];
      meta: any;
    } | null = null;
    // Set only from a committed assistant item event. Streamed progress,
    // provisional plan text, and evidence-held drafts never enter this slot.
    let publishedCompletedAssistantFinalText: string | null = null;
    // The terminal Plan summary must use the same final iteration tool surface
    // as approved-Plan finalization when classifying browser validation.
    let terminalAvailableToolNames: Set<string> | null = null;
    const logStoreEvent = (event: string, data: Record<string, unknown> = {}) => {
      const state = sessionGet();
      const goal = state.goalRuntime?.goal || state.activeGoal || null;
      const planIdentity = buildPlanApprovalIdentity(state.planArtifacts || []);
      writeStoreEvent(event, {
        ...data,
        sessionKey: runSessionKey,
        turnId,
        runId: activeRuntimeRunIdentity.runId,
        parentRunId: activeRuntimeRunIdentity.parentRunId,
        goalId: goal?.id || null,
        goalSliceId: activeRuntimeRunIdentity.goalSliceId || null,
        planRevision: planIdentity?.revision || null,
        stopClass: state.goalRuntime?.stopClass || state.goalProgress?.stopClass || null,
        actionRequestId: state.activeActionRequest?.requestId || null,
      });
    };
    const streamBuffer = context.streamBuffer;
    const thinkingInterceptor = context.thinkingInterceptor;
    const turnAgentMessagesStart = context.turnAgentMessagesStart;
    const getElapsedSeconds = context.getElapsedSeconds;

    const PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS = context.PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS;
    const PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS = context.PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS;
    const PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK = context.PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK;

    // Helpers
    const attachRuntimePhase = <T extends TaskBlock>(block: T, phase?: TurnRuntimePhase): T => {
      const normalized = normalizeTurnRuntimePhase(block.turnPhase || phase || makeTurnRuntimePhase("scope", phaseLanguage), phaseLanguage);
      return normalized ? { ...block, turnPhase: normalized } : block;
    };

    const appendTurnBlock = (block: TaskBlock) => {
      const targetTurnId = block.turnId && block.turnId !== turnId ? block.turnId : context.uiDisplayTurnId;
      const blockWithTurn: TaskBlock = attachRuntimePhase({ ...block, turnId: targetTurnId } as TaskBlock);
      if (blockWithTurn.type === "agent") {
        context.agentBlockIdsCreatedThisRun.add(blockWithTurn.id);
      }
      sessionSet((s: any) => {
        const taskFlow = [...s.taskFlow, blockWithTurn];
        const conversationTurns = s.conversationTurns.map((turn: any) =>
          turn.id === turnId && !turn.blockIds.includes(blockWithTurn.id)
            ? { ...turn, blockIds: [...turn.blockIds, blockWithTurn.id] }
            : turn
        );
        return { taskFlow, conversationTurns };
      });
    };

    const toolDisplayTurnId = context.uiDisplayTurnId || turnId;

    const resolveCurrentTurnTitle = (): string => {
      const turn = sessionGet().conversationTurns.find((candidate: any) =>
        candidate.id === toolDisplayTurnId || candidate.id === turnId
      );
      return String(turn?.title || turn?.userPrompt || "").trim() ||
        (phaseLanguage === "zh" ? "当前任务" : "Current task");
    };

    const appendWorkflowRuntimeEvent = (event: Parameters<typeof withEventSchema>[0]) => {
      const normalizedEvent = withEventSchema(event as any);
      sessionSet((state: any) => reduceRunTransition(state, {
        type: "runtime_event",
        event: normalizedEvent,
      }));
    };

    const closeProjectedSubagentRuns = (input: {
      ids: Iterable<string>;
      error: string;
      title: string;
      reason: string;
    }): string[] => {
      const ids = new Set(input.ids);
      if (ids.size === 0) return [];
      const activeRuns = projectSubagentRuns(sessionGet().runtimeEvents).filter((run) =>
        ids.has(run.id) && isSubagentActiveStatus(run.status)
      );
      if (activeRuns.length === 0) return [];
      const timestampMs = Date.now();
      sessionSet((state: any) => ({
        runtimeEvents: activeRuns.reduce((events, run) => {
          const updated = appendRuntimeEvent(events, withEventSchema({
            type: "subagent.updated",
            threadId: run.threadId,
            turnId: run.parentTurnId,
            timestampMs,
            subagentId: run.id,
            patch: {
              status: "canceled",
              updatedAt: timestampMs,
              completedAt: timestampMs,
              error: input.error,
              progress: {
                phase: "done",
                title: input.title,
                completedToolCalls: run.progress?.completedToolCalls || 0,
              },
            },
          }));
          return appendRuntimeEvent(updated, withEventSchema({
            type: "subagent.closed",
            threadId: run.threadId,
            turnId: run.parentTurnId,
            timestampMs,
            subagentId: run.id,
            closedAt: timestampMs,
            reason: input.reason,
          }));
        }, state.runtimeEvents),
      }));
      return activeRuns.map((run) => run.id);
    };

    const prepareSubagentsForNewTurn = async (): Promise<void> => {
      const currentParentTurnId = context.uiDisplayTurnId || turnId;
      const priorRuns = projectSubagentRuns(sessionGet().runtimeEvents).filter((run) =>
        run.threadId === runSessionKey &&
        run.parentTurnId !== currentParentTurnId &&
        isSubagentActiveStatus(run.status)
      );
      if (priorRuns.length === 0) return;

      const priorParentTurnIds = [...new Set(priorRuns.map((run) => run.parentTurnId))];
      const requestedIds = new Set<string>();
      const canceledIds = new Set<string>();
      const controllerMissingIds = new Set<string>();
      const timedOutIds = new Set<string>();
      let releasedCount = 0;

      for (const run of priorRuns) {
        if (cancelSubagentRun(run.id)) canceledIds.add(run.id);
        else controllerMissingIds.add(run.id);
      }
      for (const parentTurnId of priorParentTurnIds) {
        const result = await finalizeCoordinatedSubagentsForParent({
          threadId: runSessionKey,
          parentTurnId,
          graceMs: 2_000,
        });
        result.requestedIds.forEach((id) => requestedIds.add(id));
        result.canceledIds.forEach((id) => canceledIds.add(id));
        result.controllerMissingIds.forEach((id) => controllerMissingIds.add(id));
        result.timedOutIds.forEach((id) => timedOutIds.add(id));
        releasedCount += result.releasedCount;
      }

      const reconciledIds = closeProjectedSubagentRuns({
        ids: priorRuns.map((run) => run.id),
        error: "SUBAGENT_SUPERSEDED_BY_NEW_TURN: a new user turn started before this child runtime settled.",
        title: "Closed before the new turn",
        reason: "superseded_by_new_turn",
      });
      logStoreEvent("subagent_new_turn_preflight", {
        currentParentTurnId,
        priorParentTurnIds,
        detectedIds: priorRuns.map((run) => run.id),
        requestedCount: requestedIds.size,
        canceledCount: canceledIds.size,
        controllerMissingCount: controllerMissingIds.size,
        timedOutCount: timedOutIds.size,
        reconciledCount: reconciledIds.length,
        releasedCount,
      });
    };

    const publishActionRequest = (
      request: ActionRequest,
      input: { reason: string; target?: string; pauseMessage: string },
    ) => {
      const requestedAt = Date.now();
      sessionSet((state: any) => {
        const transitioned = reduceRunTransition(state, {
          type: "action_required",
          request,
          events: [
            withEventSchema({
              type: "approval.requested",
              threadId: runSessionKey,
              turnId: request.turnId,
              timestampMs: requestedAt,
              requestId: request.requestId,
              actionKind: request.kind,
              title: request.title,
              reason: input.reason,
              ...(input.target ? { target: input.target } : {}),
              runId: request.runId,
              parentRunId: request.parentRunId || null,
              ...(activeRuntimeRunIdentity.goalSliceId
                ? { goalSliceId: activeRuntimeRunIdentity.goalSliceId }
                : {}),
            }),
          ],
        });
        if (request.kind === "tool_permission") {
          const lifecycle = state.planLifecycle as PlanLifecycleState | undefined;
          const executionLease = lifecycle?.executionLease;
          const executionOwner = lifecycle?.execution;
          const ownsPlanExecution = isToolPermissionPlanExecutionIdentityCurrent(
            request,
            lifecycle,
          );
          if (!ownsPlanExecution || !lifecycle || !executionLease || !executionOwner) {
            return transitioned;
          }
          const paused = reducePlanLifecycle(lifecycle, {
            type: "pause",
            expectedVersion: lifecycle.version,
            at: requestedAt,
            expectedExecutionLeaseId: executionLease.executionLeaseId,
            expectedExecution: executionOwner,
            pause: {
              reason: "tool_permission",
              resultKind: "partial",
              resumeCondition: "resolve_action_request",
            },
          });
          if (paused.disposition === "rejected") {
            logStoreEvent("plan_tool_permission_pause_rejected", {
              requestId: request.requestId,
              runId: request.runId,
              reason: paused.reason || "unknown",
            });
            return transitioned;
          }
          return {
            ...transitioned,
            planLifecycle: paused.state,
            isPlanApproved: false,
            currentTurnExecutionConsent: { turnId: null, granted: false },
            planApprovalExecutionStartedForTurnId: null,
            planStage: "ready_to_execute",
          };
        }
        if (request.kind !== "plan_review") return transitioned;
        const artifactIdentity: PlanArtifactIdentity = {
          revision: request.planRevision,
          artifactHash: request.artifactHash,
          artifactPaths: request.artifactPaths,
        };
        const planLifecycle = alignWorkflowPlanReviewLifecycle({
          lifecycle: state.planLifecycle,
          request,
          artifactIdentity,
          at: requestedAt,
        });
        if (!planLifecycle) {
          logStoreEvent("plan_review_lifecycle_alignment_rejected", {
            sessionKey: request.sessionKey,
            turnId: request.turnId,
            runId: request.runId,
            requestId: request.requestId,
          });
          return transitioned;
        }
        return {
          ...transitioned,
          planLifecycle,
          isPlanApproved: false,
        };
      });
      logStoreEvent("action_request_created", {
        sessionKey: request.sessionKey,
        turnId: request.turnId,
        runId: request.runId,
        parentRunId: request.parentRunId || null,
        requestId: request.requestId,
        actionKind: request.kind,
        goalSliceId: activeRuntimeRunIdentity.goalSliceId || null,
        reason: input.reason,
        pauseMessage: input.pauseMessage,
        target: input.target || null,
      });
    };

    const beginActionContinuationRun = (request: ActionRequest): boolean => {
      const previous = activeRuntimeRunIdentity;
      const nextRunId = `run-action-${Date.now()}-${generateId()}`;
      const requestPlanExecution = request.kind === "tool_permission"
        ? request.planExecution || null
        : null;
      const isPlanScopedRequest = !!requestPlanExecution;
      if (isPlanScopedRequest) {
        let admitted = false;
        let admittedPlanExecutionIdentity: PlanExecutionRunProvenance | null = null;
        let rejectionReason = "plan_action_continuation_owner_mismatch";
        const startedAt = Date.now();
        sessionSet((state: any) => {
          const lifecycle = state.planLifecycle as PlanLifecycleState | undefined;
          const marker = state.harnessRunMarker as HarnessRunMarker | null;
          const currentPlanIdentity = buildPlanApprovalIdentity(state.planArtifacts || []);
          const planArtifactIdentityCurrent = request.kind === "tool_permission" &&
            !!request.planExecution &&
            !!currentPlanIdentity &&
            currentPlanIdentity.revision === request.planExecution.planRevision &&
            currentPlanIdentity.artifactHash === request.planExecution.artifactHash;
          if (
            request.kind !== "tool_permission" ||
            !lifecycle ||
            lifecycle.status !== "paused" ||
            lifecycle.pause?.resumeCondition !== "resolve_action_request" ||
            !isToolPermissionPlanExecutionIdentityCurrent(request, lifecycle) ||
            !planArtifactIdentityCurrent ||
            lifecycle.execution?.turnId !== request.turnId ||
            lifecycle.execution.runId !== request.runId ||
            !marker ||
            !isHarnessRunMarkerOwnedByRun(marker, harnessRunOwner)
          ) {
            if (!planArtifactIdentityCurrent) {
              rejectionReason = "plan_artifact_identity_stale";
            }
            return {};
          }
          const instruction = JSON.stringify({
            kind: "tool_permission_continuation",
            requestId: request.requestId,
            turnId: request.turnId,
            runId: request.runId,
            taskId: request.taskId,
            toolName: request.toolName,
            target: request.target,
            risk: request.risk || "unknown",
          });
          const issued = issuePlanExplicitResumeAttempt({
            lifecycle,
            instruction,
            executionRunId: nextRunId,
            executionLeaseId: `plan-execution-action-${startedAt}-${generateId()}`,
            authorization: {
              kind: "action_decision",
              turnId: request.turnId,
              runId: request.runId,
              requestId: request.requestId,
            },
            issuedAt: startedAt,
          });
          if (!issued.ok) {
            rejectionReason = issued.reason;
            return {};
          }
          const executionStarted = reducePlanLifecycle(issued.lifecycle, {
            type: "execution_started",
            expectedVersion: issued.lifecycle.version,
            at: startedAt,
            executionLeaseId: issued.handoff.executionLeaseId,
            instructionHash: issued.handoff.executionInstructionHash,
            execution: {
              turnId: issued.handoff.executionTurnId,
              runId: issued.handoff.executionRunId,
              parentRunId: issued.handoff.parentRunId,
              attempt: issued.handoff.executionAttempt,
              startedAt,
            },
          });
          if (executionStarted.disposition !== "applied") {
            rejectionReason = executionStarted.reason || "execution_started_rejected";
            return {};
          }
          admittedPlanExecutionIdentity = capturePlanExecutionRunProvenance(
            executionStarted.state,
          );
          if (!admittedPlanExecutionIdentity) {
            rejectionReason = "plan_execution_provenance_capture_failed";
            return {};
          }
          const nextMarker = {
            ...marker,
            activeRunId: nextRunId,
            activeParentRunId: request.runId,
            activePlanExecutionProvenance: admittedPlanExecutionIdentity,
            planStage: "executing",
            isPlanApproved: true,
            updatedAt: startedAt,
          } as HarnessRunMarker;
          const startedEvent = withEventSchema({
            type: "run.started",
            threadId: runSessionKey,
            turnId: request.turnId,
            timestampMs: startedAt,
            runId: nextRunId,
            parentRunId: request.runId,
            ...(previous.goalSliceId ? { goalSliceId: previous.goalSliceId } : {}),
          });
          const eventAppend = appendRuntimeEventWithResult(
            state.runtimeEvents,
            startedEvent,
          );
          if (eventAppend.disposition === "conflict") {
            rejectionReason = "run_started_conflict";
            return {};
          }
          // The disk marker is the final admission CAS. All pure lifecycle and
          // event checks run first so a rejected child cannot advance Harness.
          const persistedMarker = persistHarnessRunMarkerIfOwned(nextMarker, harnessRunOwner);
          if (!persistedMarker) {
            rejectionReason = "harness_owner_mismatch";
            return {};
          }
          admitted = true;
          return {
            runtimeEvents: eventAppend.events,
            harnessRunMarker: persistedMarker,
            planLifecycle: executionStarted.state,
            isPlanApproved: true,
            currentTurnExecutionConsent: {
              turnId: issued.handoff.executionTurnId,
              granted: true,
            },
            pendingPlanApprovalHandoff: null,
            planApprovalExecutionStartedForTurnId: issued.handoff.executionTurnId,
            planStage: "executing",
          };
        });
        if (!admitted) {
          let pauseReclassified = false;
          sessionSet((state: any) => {
            const lifecycle = state.planLifecycle as PlanLifecycleState | undefined;
            const ownsRejectedExecution = !!requestPlanExecution &&
              !!lifecycle &&
              lifecycle.status === "paused" &&
              lifecycle.pause?.resumeCondition === "resolve_action_request" &&
              doesLifecycleRetainPlanExecutionProvenance(
                lifecycle,
                requestPlanExecution,
              );
            const pauseTransition = ownsRejectedExecution &&
              lifecycle?.executionLease &&
              lifecycle.execution
              ? reducePlanLifecycle(lifecycle, {
                  type: "pause",
                  expectedVersion: lifecycle.version,
                  at: Date.now(),
                  expectedExecutionLeaseId: lifecycle.executionLease.executionLeaseId,
                  expectedExecution: lifecycle.execution,
                  pause: {
                    reason: "plan_action_continuation_admission_rejected",
                    resultKind: "error",
                    resumeCondition: "explicit_resume",
                  },
                })
              : null;
            pauseReclassified = !!pauseTransition &&
              pauseTransition.disposition !== "rejected";
            return {
              ...(pauseReclassified
                ? {
                    planLifecycle: pauseTransition!.state,
                    pendingPlanApprovalHandoff: null,
                    planApprovalExecutionStartedForTurnId: null,
                    planStage: "ready_to_execute",
                  }
                : {}),
              isPlanApproved: false,
              currentTurnExecutionConsent: { turnId: null, granted: false },
              taskFlow: state.taskFlow.map((block: any) =>
                request.kind === "tool_permission" && block.id === request.taskId
                  ? {
                      ...block,
                      status: "error",
                      toolStatus: "failed",
                      message: phaseLanguage === "zh"
                        ? "工具批准已记录，但 Plan 子运行接纳失败；执行已安全暂停。"
                        : "The tool decision was recorded, but the Plan child Run was not admitted; execution paused safely.",
                    }
                  : block
              ),
            };
          });
          if (pauseReclassified && requestPlanExecution) {
            rejectedPlanActionContinuationIdentity = requestPlanExecution;
          }
          // The review settlement has already detached its abort listener
          // before entering this continuation callback. Abort the obsolete
          // parent Run explicitly so it cannot resume with revoked Plan
          // consent after the child admission failed.
          abortCtrl.abort();
          logStoreEvent("plan_action_continuation_admission_rejected", {
            requestId: request.requestId,
            runId: request.runId,
            nextRunId,
            reason: rejectionReason,
          });
          return false;
        }
        activeRuntimeRunIdentity = {
          runId: nextRunId,
          parentRunId: request.runId,
          outerRunId: previous.outerRunId,
          ...(previous.goalSliceId ? { goalSliceId: previous.goalSliceId } : {}),
          source: previous.source,
        };
        activePlanExecutionIdentity = admittedPlanExecutionIdentity;
        logStoreEvent("plan_action_continuation_run_admitted", {
          requestId: request.requestId,
          actionKind: request.kind,
          runId: nextRunId,
          parentRunId: request.runId,
          goalSliceId: previous.goalSliceId || null,
        });
        return true;
      }
      if (activePlanExecutionIdentity) {
        logStoreEvent("plan_action_continuation_admission_rejected", {
          requestId: request.requestId,
          runId: request.runId,
          nextRunId,
          reason: "plan_request_missing_immutable_provenance",
        });
        return false;
      }
      activeRuntimeRunIdentity = {
        runId: nextRunId,
        parentRunId: request.runId,
        outerRunId: previous.outerRunId,
        ...(previous.goalSliceId ? { goalSliceId: previous.goalSliceId } : {}),
        source: previous.source,
      };
      activePlanExecutionIdentity = null;
      updateHarnessRunMarker({
        activeRunId: nextRunId,
        activeParentRunId: request.runId,
        activePlanExecutionProvenance: null,
      });
      appendWorkflowRuntimeEvent({
        type: "run.started",
        threadId: runSessionKey,
        turnId: request.turnId,
        timestampMs: Date.now(),
        runId: nextRunId,
        parentRunId: request.runId,
        ...(previous.goalSliceId ? { goalSliceId: previous.goalSliceId } : {}),
      });
      logStoreEvent("action_request_continuation_run_started", {
        sessionKey: runSessionKey,
        turnId: request.turnId,
        requestId: request.requestId,
        actionKind: request.kind,
        runId: nextRunId,
        parentRunId: request.runId,
        goalSliceId: previous.goalSliceId || null,
      });
      return true;
    };

    const beginTerminalConclusionRun = (parentRunId: string, reason: string): boolean => {
      const previous = activeRuntimeRunIdentity;
      const nextRunId = `run-conclusion-${Date.now()}-${generateId()}`;
      const marker = sessionGet().harnessRunMarker as HarnessRunMarker | null;
      if (!marker || !isHarnessRunMarkerOwnedByRun(marker, harnessRunOwner)) {
        logStoreEvent("terminal_conclusion_run_skipped", {
          sessionKey: runSessionKey,
          turnId,
          parentRunId,
          reason: "harness_ownership_lost",
        });
        return false;
      }
      const persistedMarker = persistHarnessRunMarkerIfOwned({
        ...marker,
        activeRunId: nextRunId,
        activeParentRunId: parentRunId,
        activePlanExecutionProvenance: null,
      }, harnessRunOwner);
      if (!persistedMarker) {
        logStoreEvent("terminal_conclusion_run_skipped", {
          sessionKey: runSessionKey,
          turnId,
          parentRunId,
          reason: "global_harness_ownership_lost",
        });
        return false;
      }
      activeRuntimeRunIdentity = {
        runId: nextRunId,
        parentRunId,
        outerRunId: previous.outerRunId,
        ...(previous.goalSliceId ? { goalSliceId: previous.goalSliceId } : {}),
        source: previous.source,
      };
      activePlanExecutionIdentity = null;
      sessionSet((state: any) =>
        isHarnessRunMarkerOwnedByRun(state.harnessRunMarker, harnessRunOwner)
          ? { harnessRunMarker: persistedMarker }
          : {}
      );
      appendWorkflowRuntimeEvent({
        type: "run.started",
        threadId: runSessionKey,
        turnId,
        timestampMs: Date.now(),
        runId: nextRunId,
        parentRunId,
        ...(previous.goalSliceId ? { goalSliceId: previous.goalSliceId } : {}),
      });
      logStoreEvent("terminal_conclusion_run_started", {
        sessionKey: runSessionKey,
        turnId,
        runId: nextRunId,
        parentRunId,
        reason,
      });
      return true;
    };

    const normalizeToolLifecycleMeta = (meta?: { toolCallId?: string | null }): ToolLifecycleMeta => {
      const toolCallId = String(meta?.toolCallId || "").trim();
      return toolCallId ? { toolCallId } : {};
    };

    const findCurrentToolLifecycleBlockIndex = (
      taskFlow: any[],
      toolName: string,
      target: string,
      allowedStatuses: string[],
      meta?: ToolLifecycleMeta,
    ) => {
      const turnIds = Array.from(new Set([toolDisplayTurnId, turnId].filter(Boolean)));
      for (const candidateTurnId of turnIds) {
        const index = findToolLifecycleBlockIndex({
          taskFlow,
          turnId: candidateTurnId,
          toolName,
          target,
          allowedStatuses,
          meta,
        });
        if (index >= 0) return index;
      }

      const toolCallId = String(meta?.toolCallId || "").trim();
      if (!toolCallId) return -1;
      for (let index = taskFlow.length - 1; index >= 0; index -= 1) {
        const block = taskFlow[index];
        if (block?.type !== "tool") continue;
        if (!allowedStatuses.includes(String(block.toolStatus || ""))) continue;
        if (String(block.toolCallId || block.executionId || "") === toolCallId) return index;
      }
      return -1;
    };

    const shouldAttachToolDiffPreview = (toolName: string, target: string, diffPreview: any) => {
      if (!diffPreview || !supportsToolDiffPreview(toolName)) return false;
      const diffPath = String(diffPreview.path || target || "").trim();
      return !isEphemeralPlanArtifactPath(diffPath);
    };

    const summarizeReviewPatchTarget = (patch: string): string => {
      const text = String(patch || "");
      const targets: string[] = [];
      const addTarget = (value: string) => {
        const clean = String(value || "")
          .replace(/^["']|["']$/g, "")
          .replace(/^[ab]\//, "")
          .trim();
        if (!clean || clean === "/dev/null" || targets.includes(clean)) return;
        targets.push(clean);
      };

      for (const line of text.split(/\r?\n/)) {
        const update = line.match(/^\*\*\* Update File:\s+(.+)$/);
        const add = line.match(/^\*\*\* Add File:\s+(.+)$/);
        const del = line.match(/^\*\*\* Delete File:\s+(.+)$/);
        const unified = line.match(/^\+\+\+\s+(.+)$/);
        if (update) addTarget(update[1]);
        else if (add) addTarget(add[1]);
        else if (del) addTarget(del[1]);
        else if (unified) addTarget(unified[1]);
        if (targets.length >= 3) break;
      }

      if (targets.length === 0) return "";
      const suffix = targets.length > 1 ? ` +${targets.length - 1}` : "";
      return `${targets[0]}${suffix}`;
    };

    const deriveReviewToolTarget = (toolCall: any): string => {
      const args = toolCall?.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments : {};
      const name = String(toolCall?.name || "");
      if (typeof toolCall?.localFileReadPath === "string" && toolCall.localFileReadPath.trim()) {
        return toolCall.localFileReadPath.trim();
      }
      if (name === "apply_patch") {
        return summarizeReviewPatchTarget(String(args.patch || "")) || "workspace patch";
      }
      const candidateKeys = [
        "path",
        "command",
        "url",
        "query",
        "pattern",
        "target",
        "file",
        "cwd",
        "input",
      ];
      for (const key of candidateKeys) {
        const value = args[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return name || "tool request";
    };

    const clearNoFirstTokenNoticeTimer = () => {
      if (context.noFirstTokenNoticeTimer !== null) {
        clearTimeout(context.noFirstTokenNoticeTimer);
        context.noFirstTokenNoticeTimer = null;
      }
    };

    const enterRealPendingReviewState = () => {
      sessionSet({ agentStatus: "pending_review", isGenerating: false });
      sessionGet().setConversationTurnStatus(turnId, "awaiting_approval");
      if (context.uiDisplayTurnId !== turnId) {
        sessionGet().setConversationTurnStatus(context.uiDisplayTurnId, "awaiting_approval");
      }
    };

    type TerminalHarnessProjection = {
      source: HarnessRunMarker;
      terminal: HarnessRunMarker;
    };
    type TerminalHarnessProjectionResult = TerminalHarnessProjection | "absent" | "ownership_lost";

    const projectCurrentHarnessRunMarker = (
      status: "completed" | "paused" | "error",
      reason: string,
      allowErrorOverride = false,
    ): TerminalHarnessProjectionResult => {
      const runtime = sessionGet();
      const marker = runtime.harnessRunMarker as HarnessRunMarker | null;
      if (!marker) return "absent";
      const ownsIdentity =
        marker.runId === harnessRunOwner.runId &&
        marker.sessionKey === harnessRunOwner.sessionKey &&
        marker.turnId === harnessRunOwner.turnId &&
        marker.instanceId === harnessRunOwner.instanceId &&
        marker.startedAt === harnessRunOwner.startedAt;
      if (!isHarnessRunMarkerOwnedByRun(marker, harnessRunOwner) && !(allowErrorOverride && ownsIdentity)) {
        if (marker?.status === "running") {
          logStoreEvent("harness_close_skipped_owner_mismatch", {
            expected: harnessRunOwner,
            actual: {
              sessionKey: marker.sessionKey,
              turnId: marker.turnId,
              startedAt: marker.startedAt,
            },
            requestedStatus: status,
            reason,
          });
        }
        return "ownership_lost";
      }
      const closedAt = Date.now();
      const terminal: HarnessRunMarker = {
        ...marker,
        status,
        planStage: runtime.planStage,
        isPlanApproved: runtime.isPlanApproved,
        updatedAt: closedAt,
        closedAt,
        closeReason: reason,
      };
      return { source: marker, terminal };
    };

    const publishCurrentHarnessRunMarkerClose = (result: TerminalHarnessProjectionResult): void => {
      if (result === "absent" || result === "ownership_lost") return;
      const { source, terminal } = result;
      const currentGlobalMarker = readHarnessRunMarker();
      const ownsExactGlobalGeneration = !!currentGlobalMarker &&
        currentGlobalMarker.runId === harnessRunOwner.runId &&
        currentGlobalMarker.sessionKey === harnessRunOwner.sessionKey &&
        currentGlobalMarker.turnId === harnessRunOwner.turnId &&
        currentGlobalMarker.instanceId === harnessRunOwner.instanceId &&
        currentGlobalMarker.startedAt === harnessRunOwner.startedAt;
      if (!ownsExactGlobalGeneration) {
        logStoreEvent("harness_close_owner_lost_before_terminal_publish", {
          expected: harnessRunOwner,
          actual: currentGlobalMarker
            ? {
                runId: currentGlobalMarker.runId,
                sessionKey: currentGlobalMarker.sessionKey,
                turnId: currentGlobalMarker.turnId,
                instanceId: currentGlobalMarker.instanceId,
                startedAt: currentGlobalMarker.startedAt,
                status: currentGlobalMarker.status,
              }
            : null,
          requestedStatus: terminal.status,
          reason: terminal.closeReason,
        });
        return;
      }
      if (
        currentGlobalMarker.status !== "running" &&
        currentGlobalMarker.status !== "paused" &&
        (
          currentGlobalMarker.status !== terminal.status ||
          currentGlobalMarker.closeReason !== terminal.closeReason
        )
      ) {
        logStoreEvent("harness_close_terminal_conflict", {
          expected: harnessRunOwner,
          existingStatus: currentGlobalMarker.status,
          existingReason: currentGlobalMarker.closeReason,
          requestedStatus: terminal.status,
          requestedReason: terminal.closeReason,
        });
        return;
      }
      const closedMarker = settleHarnessRunMarkerIfOwned(terminal, harnessRunOwner);
      if (!closedMarker) {
        logStoreEvent("harness_close_persist_degraded", {
          expected: harnessRunOwner,
          requestedStatus: terminal.status,
          reason: terminal.closeReason,
        });
        return;
      }
      const latestRuntime = sessionGet();
      logStoreEvent("agent_loop_stop_summary", {
        turnId,
        sessionKey: runSessionKey,
        workspace: runWorkspace || null,
        status: terminal.status,
        reason: terminal.closeReason,
        workflowMode: source.workflowMode,
        runtimeIntent: source.runtimeIntent,
        planStage: latestRuntime.planStage,
        isPlanApproved: latestRuntime.isPlanApproved,
        iteration: source.iteration,
        maxIterations: source.maxIterations,
        latestTool: source.latestTool || null,
        latestToolTarget: source.latestToolTarget || null,
        activeStreamId: source.activeStreamId || null,
        streamStatus: source.streamStatus || null,
        streamElapsedMs: source.streamElapsedMs || 0,
        streamLifecycleStatus: source.streamLifecycleStatus || null,
        lastStreamError: source.lastStreamError || null,
        stopDiagnostic: lastNonActionableStopDiagnostic,
      });
    };

    const emitProgressRuntimeEvent = (
      progress: MainThreadProgressUpdate,
      meta: { dedupeKey?: string } = {},
    ) => {
      const runtimeEvent = withEventSchema({
        type: "progress.updated",
        threadId: runSessionKey,
        turnId,
        timestampMs: Date.now(),
        runId: activeRuntimeRunIdentity.runId,
        parentRunId: activeRuntimeRunIdentity.parentRunId || null,
        ...(activeRuntimeRunIdentity.goalSliceId
          ? { goalSliceId: activeRuntimeRunIdentity.goalSliceId }
          : {}),
        progress: {
          ...progress,
          ...(meta.dedupeKey ? { dedupeKey: meta.dedupeKey } : {}),
        },
      });
      sessionSet((state: any) => reduceRunTransition(state, {
        type: "runtime_event",
        event: runtimeEvent,
      }));
    };

    const isUnapprovedPlanRuntime = () =>
      getIntentPolicy(effectiveRunIntent).workflowMode === "plan" &&
      sessionGet().isPlanApproved !== true;

    const emitLocalPlanExecutionProgress = (phase: PlanExecutionProgressPhase, update: Partial<PlanExecutionProgressUpdate>) => {
      const marker = sessionGet().harnessRunMarker;
      const markerRunId = getHarnessActionRunId(marker);
      if (
        marker?.status === "running" &&
        marker?.turnId === turnId &&
        markerRunId &&
        markerRunId !== activeRuntimeRunIdentity.runId
      ) {
        logStoreEvent("plan_execution_progress_ignored_stale_run", {
          turnId,
          expectedRunId: markerRunId,
          receivedRunId: activeRuntimeRunIdentity.runId,
          phase,
        });
        return;
      }
      const previousSnapshot = sessionGet().planExecutionProgressSnapshot;
      const progressSnapshot = normalizePlanExecutionProgressSnapshot({
        turnId,
        update: {
          ...buildPlanExecutionProgressUpdate({
            language: phaseLanguage,
            phase,
            iterationCount: update.iteration ?? 0,
            maxIterations: update.maxIterations ?? PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
            autoResumeCount: sessionGet().planAutoResumeCount,
            tasks: sessionGet().planTasks,
            evidenceLedger: sessionGet().planExecutionEvidenceLedger,
            recentToolActivity: [],
            currentTaskId: update.currentTaskId,
            currentTask: update.currentTask,
            currentTool: update.currentTool,
            latestEvidence: update.latestEvidence,
            nextStep: update.nextStep,
            progressSignature: update.progressSignature,
            lastEffectiveEvidenceAt: update.lastEffectiveEvidenceAt,
            recoveryReason: update.recoveryReason,
            repeatedTargets: update.repeatedTargets,
          }),
          runId: activeRuntimeRunIdentity.runId,
          parentRunId: activeRuntimeRunIdentity.parentRunId || null,
        },
        previous: previousSnapshot?.runId && previousSnapshot.runId !== activeRuntimeRunIdentity.runId
          ? null
          : previousSnapshot,
        now: Date.now(),
      });
      sessionSet({ planExecutionProgressSnapshot: progressSnapshot });
      emitProgressRuntimeEvent(
        toPlanExecutionRuntimeProgressUpdate({
          snapshot: progressSnapshot,
          language: phaseLanguage,
          dedupeKey: `plan-execution-progress:${activeRuntimeRunIdentity.runId}`,
        }),
      );
    };

    const updateHarnessRunMarker = (patch: Partial<HarnessRunMarker>) => {
      sessionSet((s: any) => {
        if (!isHarnessRunMarkerOwnedByRun(s.harnessRunMarker, harnessRunOwner)) return {};
        const nextMarker = {
          ...s.harnessRunMarker,
          ...patch,
        } as HarnessRunMarker;
        const persisted = persistHarnessRunMarkerIfOwned(nextMarker, harnessRunOwner);
        if (!persisted) {
          logStoreEvent("harness_update_skipped_global_owner_mismatch", {
            expected: harnessRunOwner,
            patchKeys: Object.keys(patch),
          });
          return {};
        }
        return {
          harnessRunMarker: persisted,
        };
      });
    };

    const terminalStatusPublicationGate = createTerminalStatusPublicationGate();

    const callbacks: OrchestratorCallbacks = {
      getMessages: () => sessionGet().agentMessages,
      getConfig: () => ({ ...sessionGet().config, workspace: runWorkspace || "" }),
      getPreferredLanguage: () => sessionGet().preferredResponseLanguage || sessionGet().config.language,
      getSkills: () => sessionGet().skills,
      getMainModeKey: () => sessionGet().selectedMainModeKey,
      getActiveStudioAgentKey: () => sessionGet().activeStudioAgentKey,
      getGameStudioInitialized: () => sessionGet().gameStudioInitialized,
      getPendingSlashCommand: () => sessionGet().pendingSlashCommand,
      getGameStudioConfig: () => gameStudioConfigForTurn,
      getWorkspaceTree: () => workspaceTree || "",
      getMcpServers: () => sessionGet().mcpServers,
      getMcpDiscoveredTools: () => sessionGet().mcpDiscoveredTools,
      getWebSearchEnabled: () => sessionGet().webSearchEnabled === true,
      getWebSearchProvider: () => sessionGet().webSearchProvider || "duckduckgo",
      getEnabledKnowledgeBaseIds: () => sessionGet().getEnabledKnowledgeBaseIds?.() || [],
      getAssociatedPaths: () => sessionGet().resolvedInstructionSet?.associatedPaths ?? [],
      getSessionKey: () => runSessionKey,
      getCurrentTurnId: () => turnId,
      getCurrentRunIdentity: () => ({
        runId: activeRuntimeRunIdentity.runId,
        parentRunId: activeRuntimeRunIdentity.parentRunId,
        ...(activeRuntimeRunIdentity.goalSliceId
          ? { goalSliceId: activeRuntimeRunIdentity.goalSliceId }
          : {}),
      }),
      getRuntimeTraceContext: () => ({
        threadId: runSessionKey,
        turnId,
        runId: activeRuntimeRunIdentity.runId,
        parentRunId: activeRuntimeRunIdentity.parentRunId,
        agentKind: "parent",
      }),
      hasRuntimeThreadStarted: (threadId: string) => sessionGet().runtimeEvents.some((event: any) =>
        event.type === "thread.started" && event.threadId === threadId
      ),
      onTurnEvent: (event) => {
        if (
          event.type === "item.completed" &&
          event.item?.details?.type === "agent_message" &&
          !context.executionEvidenceDraftHeld
        ) {
          const committedText = String(event.item.details.text || "").trim();
          if (committedText) publishedCompletedAssistantFinalText = committedText;
        }
        if (isRunTerminalEvent(event) || isTerminalTurnEvent(event)) {
          // The loop may discover a terminal candidate, but production
          // publication belongs to the WorkflowEngine transaction after the
          // final presentation and durable session projection are ready.
          logStoreEvent("inner_terminal_candidate_deferred", {
            eventType: event.type,
            sessionKey: runSessionKey,
            turnId,
            runId: "runId" in event ? event.runId : activeRuntimeRunIdentity.runId,
          });
          return;
        }
        sessionSet((state: any) => reduceRunTransition(state, { type: "runtime_event", event }));
      },
      hasSessionHookInitialized: (key: string) => sessionGet().hasSessionHookInitialized(key),
      markSessionHookInitialized: (key: string) => sessionGet().markSessionHookInitialized(key),
      onInstructionsResolved: (resolved: any) => sessionGet().setResolvedInstructionSet(resolved),
      onHooksLoaded: (hooks: any, loadedAt: any) => sessionGet().setLoadedHookDefinitions(hooks, loadedAt),
      onHookStart: (_event: any, _hook: any) => { /* UI feedback placeholder */ },
      onHookResult: (record: any) => sessionGet().appendHookExecutionRecords([record]),
      onHookBlocked: (_event: any, _reason: any, _record: any) => { /* UI feedback placeholder */ },
      // Intent and workflow mode are immutable properties of this run. Store
      // selection may move while a background run is active, so deriving them
      // from the currently displayed turn would reintroduce a second truth.
      getCurrentRunIntent: () => effectiveRunIntent,
      getRuntimeRunIntent: () => runtimeRunIntent,
      getExecutionConsentGranted: () => {
        const consent = sessionGet().currentTurnExecutionConsent;
        return consent?.granted === true && !!consent.turnId && consent.turnId === turnId;
      },
      getForcedExecuteRecoveryState: () => latestExecuteRecoveryState,
      getForcedExecuteRecoveryMode: () =>
        latestExecuteRecoveryState?.mode ?? options?.forceExecuteRecoveryMode ?? null,
      onExecuteRecoveryStateChange: (state) => {
        latestExecuteRecoveryState = {
          mode: state.mode,
          reason: state.reason,
          expectedTarget: state.expectedTarget,
          attempts: state.attempts,
          phaseNoProgressCount: state.phaseNoProgressCount,
          protocolNoProgressCount: state.protocolNoProgressCount,
          protocolNoProgressFingerprint: state.protocolNoProgressFingerprint,
          readLease: state.readLease ? { ...state.readLease } : null,
          sourceObservationKey: state.sourceObservationKey,
          decisionCheckpoint: state.decisionCheckpoint
            ? { ...state.decisionCheckpoint }
            : null,
        };
      },
      getCommandDirective: () => effectiveCommandDirective,
      getWorkflowMode: () => getIntentPolicy(effectiveRunIntent).workflowMode,
      getIsPlanApproved: () => sessionGet().isPlanApproved,
      getPlanApprovalChoice: () => sessionGet().planApprovalChoice,
      getReadOnlyAutoApproveForSession: () => sessionGet().readOnlyAutoApproveForSession,
      getApprovedLocalFileReadPaths: () => sessionGet().approvedLocalFileReadPaths || [],
      getAutoApproveToolScopes: () => sessionGet().autoApproveToolScopes || [],
      getPlanStage: () => sessionGet().planStage,
      getPlanArtifacts: () => sessionGet().planArtifacts,
      getPlanTasks: () => sessionGet().planTasks,
      getPlanExecutionEvidenceLedger: () => sessionGet().planExecutionEvidenceLedger,
      getPlanAutoResumeCount: () => sessionGet().planAutoResumeCount,
      getIsApprovedPlanExecutionTransitionPending: () => {
        const latest = sessionGet();
        const lifecycle = latest.planLifecycle as PlanLifecycleState | undefined;
        return lifecycle?.status === "handoff_pending" &&
          lifecycle.executionLease?.executionLeaseId === latest.pendingPlanApprovalHandoff?.executionLeaseId &&
          latest.pendingPlanApprovalHandoff?.planTurnId === turnId;
      },
      getStatus: () => sessionGet().agentStatus,
      consumeActiveGuidance: () => sessionGet().consumeActiveGuidance(turnId),
      onGuidanceInjected: (text: string) => {
        sessionSet((s: any) => {
          const blockWithTurn = {
            id: generateId(),
            type: "user",
            turnId,
            content: text,
          };
          return { taskFlow: [...s.taskFlow, blockWithTurn] };
        });
      },
      startNewTurn: () => sessionGet().startNewTurn(remoteFeishu),
      onGoalProgressUpdate: (progress, goal) => {
        sessionGet().updateGoalProgress(progress);
        const currentRuntime = sessionGet().goalRuntime;
        if (currentRuntime) {
          sessionGet().updateGoalRuntime({
            ...currentRuntime,
            goal,
            progress,
            status: goal.status,
            updatedAt: Date.now(),
          });
        }
      },
      onGoalRuntimeUpdate: (runtime) => sessionGet().updateGoalRuntime(runtime),
      onGoalIterationStart: (_iter) => {}, // Optionally add detailed store updates later
      onGoalIterationEnd: (_iter) => {},
      onGoalCheckpointSaved: (checkpoint) => {
        const goalId = sessionGet().goalRuntime?.goal.id || sessionGet().activeGoal?.id;
        if (!goalId) return;
        sessionSet((state: any) => ({
          runtimeEvents: appendRuntimeEvent(state.runtimeEvents, withEventSchema({
            type: "goal.checkpoint_saved",
            threadId: runSessionKey,
            turnId,
            timestampMs: Date.now(),
            goalId,
            checkpointId: checkpoint.id || `checkpoint_${checkpoint.iteration}`,
            iteration: checkpoint.iteration,
          })),
        }));
      },
      onGoalUserConfirmNeeded: async (message) => {
        const state = sessionGet();
        const goal = state.goalRuntime?.goal || state.activeGoal;
        if (!goal) return false;
        const existing = state.activeActionRequest;
        const sameConfirmation =
          existing?.kind === "goal_confirmation" &&
          existing.status === "pending" &&
          isActionRequestOwnedByRun(existing, {
            sessionKey: runSessionKey,
            turnId,
            runId: activeRuntimeRunIdentity.runId,
          }) &&
          existing.goalId === goal.id &&
          existing.goalRevision === (goal.revision || 1);
        if (!sameConfirmation) {
          const request = buildGoalConfirmationActionRequest({
            sessionKey: runSessionKey,
            turnId,
            runId: activeRuntimeRunIdentity.runId,
            parentRunId: activeRuntimeRunIdentity.parentRunId,
            title: resolveCurrentTurnTitle(),
            goalId: goal.id,
            goalRevision: goal.revision || 1,
            reason: message,
          });
          publishActionRequest(request, {
            reason: "goal_confirmation",
            pauseMessage: message,
          });
        }
        sessionSet((current: any) => ({
          activeGoal: current.activeGoal
            ? { ...current.activeGoal, status: "awaiting_input", updatedAt: Date.now() }
            : current.activeGoal,
          goalStatus: "awaiting_input",
          conversationTurns: current.conversationTurns.map((candidate: any) =>
            candidate.id === turnId
              ? { ...candidate, status: "awaiting_input", summary: message }
              : candidate
          ),
        }));
        return false;
      },
      onGoalOutcome: (outcome) => {
        const state = sessionGet();
        if (!state.activeGoal || !state.goalProgress) return;
        const goal = { ...state.activeGoal, status: outcome.status, updatedAt: Date.now() };
        const runtime = state.goalRuntime || {
          schemaVersion: 3 as const,
          goal,
          progress: state.goalProgress,
          status: outcome.status,
          phase: null,
          updatedAt: Date.now(),
        };
        sessionGet().updateGoalRuntime({
          ...runtime,
          goal,
          status: outcome.status,
          phase: outcome.status === "completed" ? "observe" : "re_plan",
          pauseReason:
            outcome.status === "paused" ||
            outcome.status === "blocked" ||
            outcome.status === "awaiting_input" ||
            outcome.status === "budget_exceeded"
              ? outcome.reason
              : runtime.pauseReason,
          stopClass: outcome.stopClass || runtime.stopClass,
          lastError: outcome.status === "failed" ? outcome.reason : runtime.lastError,
          updatedAt: Date.now(),
        });
      },
      getContextMemoryState: () => {
        const latest = sessionGet();
        const laneKey = resolveRuntimeLaneKey(latest.config);
        return resolveContextMemoryStateForRuntimeLane(
          laneKey,
          latest.contextMemoryStateByRuntimeKey,
          latest.contextMemoryState,
        );
      },
      shouldForceXmlForProviderCompatibility: () => {
        const latest = sessionGet();
        const laneKey = resolveRuntimeLaneKey(latest.config);
        const normalizedMap = normalizeProviderCompatibilityByRuntimeKey(latest.providerCompatibilityByRuntimeKey);
        const laneState = normalizedMap[laneKey];
        if (!laneState?.forceXmlTools) return false;
        if (laneState.fallbackExpiresAt != null && Date.now() >= laneState.fallbackExpiresAt) {
          sessionSet((s: any) => {
            const nextMap = normalizeProviderCompatibilityByRuntimeKey(s.providerCompatibilityByRuntimeKey);
            const currentLane = nextMap[laneKey];
            if (!currentLane) return {};
            nextMap[laneKey] = {
              ...currentLane,
              forceXmlTools: false,
              fallbackExpiresAt: null,
              nativeSuccessStreak: 0,
            };
            return { providerCompatibilityByRuntimeKey: nextMap };
          });
          return false;
        }
        return true;
      },
      onProviderCompatibilityFallback: (reason: any) => {
        const laneKey = resolveRuntimeLaneKey(sessionGet().config);
        const now = Date.now();
        logStoreEvent("provider_compatibility_fallback", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          laneKey,
          reason: String(reason || "").slice(0, 240),
          cooldownMs: PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
        });
        sessionSet((s: any) => {
          const nextMap = normalizeProviderCompatibilityByRuntimeKey(s.providerCompatibilityByRuntimeKey);
          nextMap[laneKey] = {
            forceXmlTools: true,
            fallbackExpiresAt: now + PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
            nativeSuccessStreak: 0,
            lastFallbackAt: now,
          };
          return { providerCompatibilityByRuntimeKey: nextMap };
        });
      },
      onProviderNativeToolSuccess: () => {
        const laneKey = resolveRuntimeLaneKey(sessionGet().config);
        sessionSet((s: any) => {
          const nextMap = normalizeProviderCompatibilityByRuntimeKey(s.providerCompatibilityByRuntimeKey);
          const currentLane = nextMap[laneKey];
          if (!currentLane) return {};
          const nextSuccessStreak = currentLane.nativeSuccessStreak + 1;
          if (nextSuccessStreak >= PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK) {
            const rest = { ...nextMap };
            delete rest[laneKey];
            logStoreEvent("provider_compatibility_recovered", {
              turnId,
              sessionKey: runSessionKey,
              workspace: runWorkspace || null,
              laneKey,
              successStreak: nextSuccessStreak,
            });
            return { providerCompatibilityByRuntimeKey: rest };
          }
          nextMap[laneKey] = {
            ...currentLane,
            forceXmlTools: false,
            fallbackExpiresAt: null,
            nativeSuccessStreak: nextSuccessStreak,
          };
          return { providerCompatibilityByRuntimeKey: nextMap };
        });
      },
      onToolSurfaceResolved: (availableToolNames) => {
        terminalAvailableToolNames = new Set(availableToolNames);
      },
      onHarnessRunUpdate: (patch: any) => {
        const markerPatch = patch as Partial<HarnessRunMarker> & Record<string, unknown>;
        updateHarnessRunMarker(markerPatch);
      },
      onDebugEvent: (event: any, data: any = {}) => {
        try {
          if (
            event === "memory_pressure_sample" &&
            data.runtimeEventOwner === true &&
            typeof data.laneKey === "string" &&
            typeof data.availableBytes === "number" &&
            typeof data.reserveBytes === "number"
          ) {
            sessionSet((state: any) => ({
              runtimeEvents: appendRuntimeEvent(state.runtimeEvents, withEventSchema({
                type: "model_lane.pressure",
                threadId: String(data.threadId || runSessionKey),
                turnId: String(data.turnId || turnId),
                timestampMs: Date.now(),
                laneKey: data.laneKey,
                availableBytes: data.availableBytes,
                reserveBytes: data.reserveBytes,
                action: data.action === "degrade" ? "degrade" : data.action === "hold" ? "hold" : "sample",
              })),
            }));
          }
          const latest = sessionGet();
          const goal = latest.goalRuntime?.goal || latest.activeGoal || null;
          const planIdentity = buildPlanApprovalIdentity(latest.planArtifacts || []);
          appendDebugLog("info", event, {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            ...data,
            runId: data.runId ?? activeRuntimeRunIdentity.runId,
            parentRunId: data.parentRunId ?? activeRuntimeRunIdentity.parentRunId,
            goalId: goal?.id || null,
            goalSliceId: activeRuntimeRunIdentity.goalSliceId || null,
            planRevision: planIdentity?.revision || null,
            stopClass: latest.goalRuntime?.stopClass || latest.goalProgress?.stopClass || null,
            actionRequestId: latest.activeActionRequest?.requestId || null,
          });
        } catch {
          // Diagnostics must never affect user workflows.
        }
      },

      onStreamToken: (token: string, _msgId: string | undefined | null) => {
        if (token.startsWith("__EVIDENCE_DRAFT_HOLD__:")) {
          streamBuffer.reset();
          thinkingInterceptor.reset();
          context.executionEvidenceDraftHeld = true;
          context.executionEvidenceDraftBuffer = "";
          pendingEvidenceDraftFinalPresentation = null;
          context.streamingAssistantDisplayBuffer = "";
          logStoreEvent("execution_evidence_draft_held", {
            turnId,
            reason: token.slice("__EVIDENCE_DRAFT_HOLD__:".length) || "execution_evidence",
          });
          return;
        }
        if (token.startsWith("__EVIDENCE_DRAFT_COMMIT__:")) {
          if (!context.executionEvidenceDraftHeld) return;
          const commitReason = token.slice("__EVIDENCE_DRAFT_COMMIT__:".length) || "evidence_closed";
          const draft = context.executionEvidenceDraftBuffer;
          const finalPresentation = pendingEvidenceDraftFinalPresentation;
          context.executionEvidenceDraftHeld = false;
          context.executionEvidenceDraftBuffer = "";
          pendingEvidenceDraftFinalPresentation = null;
          if (finalPresentation) {
            // No-tool final text is published exactly once, only after the
            // runtime evidence audit commits it. Publishing the raw stream as
            // well would create a duplicate streaming block after onStreamDone.
            callbacks.onAssistantFinalText(
              finalPresentation.text,
              finalPresentation.replyOptions,
              finalPresentation.meta,
            );
          } else if (draft && commitReason === "tool_call") {
            // Do not briefly publish model-authored tool narration and hide it
            // a moment later. assistantOutputPhase persists the same text as a
            // hidden process block while structured tool/progress events own
            // the visible activity projection.
            context.streamingAssistantDisplayBuffer = "";
          }
          logStoreEvent("execution_evidence_draft_committed", {
            turnId,
            reason: commitReason,
            draftChars: draft.length,
            finalPresentationCommitted: Boolean(finalPresentation),
          });
          return;
        }
        // Handle escalation reset signal
        if (token.startsWith("__ESCALATION_RESET__:")) {
          const resetType = token.slice("__ESCALATION_RESET__:".length) || "unknown";
          logStoreEvent("stream_reset", {
            turnId,
            resetType,
            currentStreamingBlockId: context.currentStreamingBlockId,
            tokenBufferChars: 0,
            agentBlocksCreatedThisRun: context.agentBlockIdsCreatedThisRun.size,
            taskFlowBlocks: sessionGet().taskFlow.length,
          });
          
          // For quality_gate resets: only reset the stream buffer, keep already-displayed content.
          // This prevents the "content appears then disappears" effect when a plan fails validation.
          if (resetType === "quality_gate") {
            // Only reset the streaming buffer, not the displayed content
            context.streamingAssistantDisplayBuffer = "";
            context.executionEvidenceDraftHeld = false;
            context.executionEvidenceDraftBuffer = "";
            pendingEvidenceDraftFinalPresentation = null;
            context.firstStreamTokenAt = null;
            context.streamTokenCount = 0;
            context.streamTextChars = 0;
            context.iterationStreamTokenCount = 0;
            context.iterationStreamTextChars = 0;
            if (thinkingInterceptor) {
              thinkingInterceptor.reset();
            }
            return;
          }
          
          // Standard reset behavior for other reset types (evidence_recovery, unknown, etc.)
          streamBuffer.reset();
          context.executionEvidenceDraftHeld = false;
          context.executionEvidenceDraftBuffer = "";
          pendingEvidenceDraftFinalPresentation = null;
          if (thinkingInterceptor) {
            thinkingInterceptor.reset();
          }
          context.firstStreamTokenAt = null;
          context.streamTokenCount = 0;
          context.streamTextChars = 0;
          context.iterationStreamTokenCount = 0;
          context.iterationStreamTextChars = 0;
          context.streamingAssistantDisplayBuffer = "";

          const currentTaskFlow = sessionGet().taskFlow;
          const agentBlock = currentTaskFlow.find((t: any) => t.id === context.currentStreamingBlockId && t.type === "agent") as any;
          const thoughtBlock = currentTaskFlow.find((t: any) => t.id === context.currentThoughtBlockId && t.type === "thought") as any;

          const failedAttemptContent = agentBlock ? agentBlock.content : "";
          const failedAttemptReasoning = thoughtBlock ? thoughtBlock.content : "";

          // Reset the streaming block content for retry
          if (context.currentStreamingBlockId !== null) {
            const blockId = context.currentStreamingBlockId;
            sessionSet((s: any) => ({
              taskFlow: s.taskFlow.map((t: any) => {
                if (t.id === blockId && t.type === "agent") {
                  const existingAttempts = t.failedAttempts || [];
                  return {
                    ...t,
                    content: "",
                    isEscalating: true,
                    escalationReason: resetType,
                    failedAttempts: [
                      ...existingAttempts,
                      {
                        content: failedAttemptContent,
                        reasoning: failedAttemptReasoning,
                        reason: resetType,
                        timestamp: Date.now(),
                      }
                    ]
                  };
                }
                if (t.id === context.currentThoughtBlockId && t.type === "thought") {
                  return { ...t, content: "" };
                }
                return t;
              }),
            }));
          } else {
            sessionSet((s: any) => {
              const latestAgent = findLatestRunOwnedAgentBlock(
                s.taskFlow,
                context.uiDisplayTurnId,
                context.agentBlockIdsCreatedThisRun,
              );
              if (latestAgent) {
                const targetId = latestAgent.id;
                context.agentBlockIdsCreatedThisRun.delete(targetId);
                return {
                  taskFlow: s.taskFlow.filter((block: any) => block.id !== targetId),
                  conversationTurns: s.conversationTurns.map((turn: any) =>
                    turn.id === turnId
                      ? { ...turn, blockIds: turn.blockIds.filter((id: any) => id !== targetId) }
                      : turn
                  ),
                };
              }
              return {};
            });
          }
          return;
        }

        if (context.thoughtStartTime === null) context.thoughtStartTime = Date.now();
        if (context.firstStreamTokenAt === null) {
          context.firstStreamTokenAt = typeof performance !== "undefined"
            ? performance.now()
            : Date.now();
          clearNoFirstTokenNoticeTimer();
          logStoreEvent("stream_first_token", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            elapsedMs: Math.round(context.firstStreamTokenAt! - sendStartedAt),
            tokenChars: token.length,
          });
        }
        context.streamTokenCount++;
        context.streamTextChars += token.length;
        context.iterationStreamTokenCount++;
        context.iterationStreamTextChars += token.length;
        context.runStreamTokenCount++;
        context.runStreamTextChars += token.length;
        if (context.executionEvidenceDraftHeld) {
          context.executionEvidenceDraftBuffer += token;
          return;
        }
        streamBuffer.append(token);
      },

      onStreamDone: (_fullText: string, _msgId: string | undefined | null, truncated: boolean, meta?: any) => {
        streamBuffer.flush();
        clearNoFirstTokenNoticeTimer();

        let { agent: remainingAgent, thoughtEnded } = thinkingInterceptor.flush();

        // Stream end: if thinking content was accumulated, log it for later context memory injection
        if (thoughtEnded) {
          const thinkingContent = thinkingInterceptor.getThinkingContent();
          if (thinkingContent && thinkingContent.length > 100) {
            // Summary will be injected by the orchestrator after turn completion
          }
        }

        if (remainingAgent) {
          const displayCandidate = context.streamingAssistantDisplayBuffer + remainingAgent;
          const displayDecision = resolveStreamingAssistantDisplay({
            text: displayCandidate,
            language: phaseLanguage,
            workflowMode: sessionGet().config.workflowMode,
            runIntent: effectiveRunIntent,
            hasVisibleAgentBlock: context.currentStreamingBlockId !== null,
          });
          if (displayDecision.action === "show") {
            remainingAgent = displayDecision.text;
          } else {
            remainingAgent = "";
          }
          context.streamingAssistantDisplayBuffer = "";
        } else {
          context.streamingAssistantDisplayBuffer = "";
        }
        if (remainingAgent) {
          if (context.currentStreamingBlockId === null) {
            // ── Duplicate agent block deduplication ──────────────────────
            // When the model outputs the same visible text across consecutive
            // iterations (e.g., repeated "I need to read file X" preambles),
            // replace the last agent block instead of appending a duplicate.
            const currentTaskFlow = sessionGet().taskFlow;
            const lastAgentBlock = findLatestRunOwnedAgentBlock(
              currentTaskFlow,
              context.uiDisplayTurnId,
              context.agentBlockIdsCreatedThisRun,
              { requireSettled: true },
            );
            const trimmedNew = remainingAgent.trim();
            const trimmedLast = lastAgentBlock ? String(lastAgentBlock.content || "").trim() : "";
            const isDuplicate = trimmedLast.length > 0 && trimmedNew.length > 0 && (
              trimmedNew === trimmedLast ||
              // Near-duplicate: same first 80% of content (handles minor suffix differences)
              (trimmedNew.length >= 20 && trimmedLast.length >= 20 &&
                trimmedNew.slice(0, Math.floor(trimmedNew.length * 0.8)) ===
                trimmedLast.slice(0, Math.floor(trimmedLast.length * 0.8)))
            );
            if (isDuplicate && lastAgentBlock) {
              // Replace the existing block content instead of creating a new one
              const existingId = lastAgentBlock.id;
              sessionSet((s: WorkflowStoreState) => ({
                taskFlow: s.taskFlow.map((t: TaskBlock) =>
                  t.id === existingId && t.type === "agent"
                    ? { ...t, content: remainingAgent }
                    : t
                ),
              }));
              context.currentStreamingBlockId = existingId;
            } else {
              const blockId = sessionGet()._nextTaskId();
              context.currentStreamingBlockId = blockId;
              appendTurnBlock({ id: blockId, turnId, type: "agent", content: remainingAgent, streaming: true });
            }
          } else {
            const blockId = context.currentStreamingBlockId;
            sessionSet((s: WorkflowStoreState) => ({
              taskFlow: s.taskFlow.map((t: TaskBlock) =>
                t.id === blockId && t.type === "agent"
                  ? { ...t, content: (t as Extract<TaskBlock, { type: "agent" }>).content + remainingAgent }
                  : t
              ),
            }));
          }
        }

        const duration = context.thoughtStartTime ? Math.round((Date.now() - context.thoughtStartTime) / 1000) : undefined;
        sessionSet((s: WorkflowStoreState) => {
          const finalizeStreamingTaskBlocks = (taskFlow: TaskBlock[], targetTurnId: string, duration?: number): TaskBlock[] => {
            return taskFlow.map((t) => {
              if (t.turnId !== targetTurnId) return t;
              if (t.type === "agent" && t.streaming) {
                return { ...t, streaming: false };
              }
              if (t.type === "thought" && t.isStreaming) {
                return { ...t, isStreaming: false, duration };
              }
              return t;
            });
          };
          return { taskFlow: finalizeStreamingTaskBlocks(s.taskFlow, turnId, duration) };
        });

        context.currentStreamingBlockId = null;
        context.currentThoughtBlockId = null;
        context.thoughtStartTime = null;

        const suppressTruncationWarning =
          !!meta?.suppressTruncationWarning &&
          effectiveRunIntent === "plan" &&
          !sessionGet().isPlanApproved;
        logStoreEvent("stream_done", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          fullTextChars: _fullText.length,
          truncated,
          suppressTruncationWarning,
          truncationReason: meta?.reason || null,
          firstTokenElapsedMs: context.firstStreamTokenAt == null ? null : Math.round(context.firstStreamTokenAt - sendStartedAt),
          streamTokenCount: context.iterationStreamTokenCount,
          streamTextChars: context.iterationStreamTextChars,
          metricScope: "iteration",
          iterationStreamTokenCount: context.iterationStreamTokenCount,
          iterationStreamTextChars: context.iterationStreamTextChars,
          runStreamTokenCount: context.runStreamTokenCount,
          runStreamTextChars: context.runStreamTextChars,
          rawContentChars: meta?.streamDiagnostics?.rawContentChars ?? _fullText.length,
          reasoningChars: meta?.streamDiagnostics?.reasoningChars ?? 0,
          semanticVisibleChars: meta?.streamDiagnostics?.semanticVisibleChars ?? _fullText.length,
          mirrorKind: meta?.streamDiagnostics?.mirrorKind ?? "none",
          overlapRatio: meta?.streamDiagnostics?.overlapRatio ?? 0,
          contentHash: meta?.streamDiagnostics?.contentHash ?? null,
          reasoningHash: meta?.streamDiagnostics?.reasoningHash ?? null,
          normalizedContentHash: meta?.streamDiagnostics?.normalizedContentHash ?? null,
          normalizedReasoningHash: meta?.streamDiagnostics?.normalizedReasoningHash ?? null,
          firstSemanticVisibleElapsedMs: meta?.streamDiagnostics?.firstSemanticVisibleElapsedMs ?? null,
          firstToolElapsedMs: meta?.streamDiagnostics?.firstToolElapsedMs ?? null,
          taskFlowBlocks: sessionGet().taskFlow.length,
          agentBlocksCreatedThisRun: context.agentBlockIdsCreatedThisRun.size,
        });
        context.iterationStreamTokenCount = 0;
        context.iterationStreamTextChars = 0;
        context.firstStreamTokenAt = null;

        // Show truncation warning if the model hit max_tokens
        if (truncated && !suppressTruncationWarning) {
          const warnId = sessionGet()._nextTaskId();
          const warnBlock: TaskBlock = {
            id: warnId,
            turnId,
            type: "system",
            content: "⚠️ 回复被截断 — 模型达到了最大 token 限制。回复可能不完整。",
          };
          appendTurnBlock(warnBlock);
        }

        sessionSet((s: WorkflowStoreState) => ({
          normalizedStreamState: {
            ...s.normalizedStreamState,
            finishReason: truncated ? "length" : "stop",
          },
        }));
      },

      onThought: (thought: any) => {
        const duration = context.thoughtStartTime
          ? Math.round((Date.now() - context.thoughtStartTime) / 1000)
          : undefined;

        // ── Turn-based deduplication: clean matching ──────────────
        const normalizeForComp = (s: string) => s.trim().replace(/\s+/g, ' ');
        const incoming = normalizeForComp(thought);
        
        const currentTurn = sessionGet().currentTurnState;

        // ── Interceptor dedup: if StreamingThinkingInterceptor already
        // captured and rendered this exact content, skip it entirely.
        if (currentTurn.interceptorHandled && currentTurn.interceptorThought) {
          const interceptorNorm = normalizeForComp(currentTurn.interceptorThought);
          if (interceptorNorm === incoming || interceptorNorm.includes(incoming) || incoming.includes(interceptorNorm)) {
            return;
          }
        }
        
        // If this exact text (or a subset) was already reported in this turn, ignore it.
        if (currentTurn.lastReportedThought.includes(incoming)) {
          return;
        }

        // Update turn state
        sessionSet((s: any) => ({
          normalizedStreamState: {
            ...s.normalizedStreamState,
            hiddenThought: appendThoughtDelta(
              s.normalizedStreamState.hiddenThought,
              s.normalizedStreamState.hiddenThought ? `\n\n${thought}` : thought,
            ),
          },
          currentTurnState: {
            ...s.currentTurnState,
            lastReportedThought: appendThoughtDelta(s.currentTurnState.lastReportedThought, thought),
          }
        }));

        if (sessionGet().config.reasoningDisplay === "hidden") {
          logStoreEvent("reasoning_suppressed", {
            turnId,
            source: "normalized_hidden_thought",
            chars: thought.length,
          });
          return;
        }

        const currentFlow = sessionGet().taskFlow;
        const turnBlocks = currentFlow.filter((b: any) => b.turnId === turnId);
        const lastThoughtBlock = [...turnBlocks].reverse().find((b) => b.type === "thought");

        if (lastThoughtBlock) {
          const existingContent = (lastThoughtBlock as Extract<TaskBlock, { type: "thought" }>).content;
          const existing = normalizeForComp(existingContent);
          
          if (existing.includes(incoming)) {
            if (duration !== undefined) {
              const tid = lastThoughtBlock.id;
              sessionSet((s: any) => ({
                taskFlow: s.taskFlow.map((t: any) =>
                  t.id === tid && t.type === "thought"
                    ? { ...t, duration, isStreaming: false, content: incoming.length > existing.length ? thought : t.content }
                    : t
                ),
              }));
            }
            return;
          }
          const tid = lastThoughtBlock.id;
          const nextContent = appendThoughtDelta(existingContent, thought);
          sessionSet((s: any) => ({
            taskFlow: s.taskFlow.map((t: any) =>
              t.id === tid && t.type === "thought"
                ? { ...t, content: nextContent, isStreaming: true, duration }
                : t
            ),
          }));
          // Auto-collapse after a brief display period
          setTimeout(() => {
            sessionSet((s: any) => ({
              taskFlow: s.taskFlow.map((t: any) =>
                t.id === tid && t.type === "thought"
                  ? { ...t, content: compactThoughtContentForPersist((t as Extract<TaskBlock, { type: "thought" }>).content), isStreaming: false }
                  : t
              ),
            }));
            context.thoughtStartTime = null;
          }, 1200);
        } else {
          const thoughtBlockId = sessionGet()._nextTaskId();
          const block: TaskBlock = {
            id: thoughtBlockId,
            turnId,
            type: "thought",
            content: compactThoughtContent(thought),
            isStreaming: true,
            duration,
          };
          appendTurnBlock(block);

          // Auto-collapse after a brief display period
          setTimeout(() => {
            sessionSet((s: any) => ({
              taskFlow: s.taskFlow.map((t: any) =>
                t.id === thoughtBlockId && t.type === "thought"
                  ? { ...t, content: compactThoughtContentForPersist((t as Extract<TaskBlock, { type: "thought" }>).content), isStreaming: false }
                  : t
              ),
            }));
            context.thoughtStartTime = null;
          }, 1200);
        }
      },

      onAssistantCommentary: (text, meta) => {
        const visibleText = String(text || "").trim();
        if (!visibleText || isThinModelToolNarration(visibleText)) {
          logStoreEvent("assistant_commentary_suppressed", {
            turnId,
            reason: visibleText ? "thin_tool_narration" : "empty",
          });
          return;
        }

        const normalized = normalizeModelFeedbackForDedupe(visibleText);
        if (!normalized) return;

        sessionSet((state: any) => {
          const ownedTurnIds = new Set([turnId, toolDisplayTurnId].filter(Boolean));
          const matchingBlocks = state.taskFlow.filter((block: any) =>
            block.type === "agent" &&
            ownedTurnIds.has(block.turnId) &&
            block.visibility !== "assistant_final" &&
            (
              block.visibility === "assistant_update" ||
              context.agentBlockIdsCreatedThisRun.has(block.id)
            ) &&
            normalizeModelFeedbackForDedupe(String(block.content || "")) === normalized
          );
          const existing = matchingBlocks[matchingBlocks.length - 1];
          if (existing?.visibility === "assistant_update") {
            logStoreEvent("assistant_commentary_deduped", {
              turnId,
              blockId: existing.id,
            });
            return {};
          }

          const blockId = existing?.id ?? state._nextTaskId();
          if (!existing) context.agentBlockIdsCreatedThisRun.add(blockId);
          const commentaryBlock = attachRuntimePhase({
            ...(existing || {}),
            id: blockId,
            turnId: toolDisplayTurnId,
            type: "agent",
            content: visibleText,
            streaming: false,
            hiddenProcess: false,
            visibility: "assistant_update",
          } as TaskBlock);
          const taskFlow = existing
            ? state.taskFlow.map((block: any) => block.id === blockId ? commentaryBlock : block)
            : [...state.taskFlow, commentaryBlock];
          const conversationTurns = state.conversationTurns.map((turn: any) =>
            turn.id === turnId
              ? {
                  ...turn,
                  status: turn.status === "awaiting_approval"
                    ? turn.status
                    : isUnapprovedPlanRuntime()
                    ? "planning"
                    : "executing",
                  blockIds: turn.blockIds.includes(blockId)
                    ? turn.blockIds
                    : [...turn.blockIds, blockId],
                }
              : turn
          );
          return { taskFlow, conversationTurns };
        });

        logStoreEvent("assistant_commentary_published", {
          turnId,
          visibleChars: visibleText.length,
          modelAuthored: meta?.modelAuthored !== false,
          toolCalls: meta?.toolCalls?.length || 0,
        });
      },

      onAssistantFinalText: (text: any, replyOptions: any[] = [], meta: any) => {
        const hasToolCalls = meta?.hasToolCalls === true;
        const awaitingInput = meta?.awaitingInput === true && replyOptions.length > 0;
        if (context.executionEvidenceDraftHeld && !awaitingInput) {
          pendingEvidenceDraftFinalPresentation = {
            text,
            replyOptions: [...replyOptions],
            meta: meta ? { ...meta } : meta,
          };
          logStoreEvent("execution_evidence_final_presentation_held", {
            turnId,
            visibleChars: String(text || "").length,
            replyOptions: replyOptions.length,
            hasToolCalls,
          });
          return;
        }
        if (context.executionEvidenceDraftHeld && awaitingInput) {
          // A real user-choice pause is not a completion claim. Publish the
          // choice UI, but discard the raw held stream so it cannot be replayed
          // later as a second assistant block.
          context.executionEvidenceDraftHeld = false;
          context.executionEvidenceDraftBuffer = "";
          pendingEvidenceDraftFinalPresentation = null;
        }
        // A pre-approval Plan response is only a quality candidate. The Plan
        // runtime decides after this callback whether it becomes a materialized
        // artifact, needs another bounded rewrite, or pauses. Do not publish a
        // terminal turn/assistant answer before that decision exists.
        const provisionalPlanCandidate =
          isUnapprovedPlanRuntime() &&
          !hasToolCalls &&
          !awaitingInput &&
          sessionGet().agentStatus !== "pending_review";
        const language = sessionGet().config.language === "en" ? "en" : "zh";
        const fallbackText = replyOptions.length > 0
          ? language === "en"
            ? "Choose how you'd like to continue."
            : "请选择你希望我如何继续。"
          : "";

        const visibleText = String(text || "").trim() || fallbackText;
        const normalizedFinal = sanitizeFinalTextForPersist({
          visibleText,
          language,
        });
        let choiceActionRequest: UserChoiceActionRequest | null = null;
        if (awaitingInput) {
          const existing = sessionGet().activeActionRequest;
          const optionValues = replyOptions
            .map((option: any) => String(option?.value || option?.label || "").trim())
            .filter(Boolean);
          const sameChoiceRequest =
            existing?.kind === "user_choice" &&
            existing.status === "pending" &&
            isActionRequestOwnedByRun(existing, {
              sessionKey: runSessionKey,
              turnId,
              runId: activeRuntimeRunIdentity.runId,
            }) &&
            existing.allowCustomReply === true &&
            existing.optionValues.join("\u001f") === optionValues.join("\u001f");
          if (sameChoiceRequest) {
            choiceActionRequest = existing;
          } else {
            const request = buildUserChoiceActionRequest({
              sessionKey: runSessionKey,
              turnId,
              runId: activeRuntimeRunIdentity.runId,
              parentRunId: activeRuntimeRunIdentity.parentRunId,
              title: resolveCurrentTurnTitle(),
              optionValues,
              allowCustomReply: true,
            });
            publishActionRequest(request, {
              reason: "user_choice",
              pauseMessage: language === "zh"
                ? "等待用户选择后在同一回合创建后续运行。"
                : "Waiting for a user choice before starting a continuation run in this turn.",
            });
            choiceActionRequest = request;
          }
        }
        const choiceRequestIdentity = choiceActionRequest
          ? toUserChoiceResolutionIdentity(choiceActionRequest)
          : undefined;

        // A user-choice pause may be surfaced remotely, but it is not a
        // successful terminal answer. The completion card is deferred until
        // the outer loop commits a completed outcome below.
        if (remoteFeishu && awaitingInput && !hasToolCalls && !provisionalPlanCandidate) {
          const cardTitle = sessionGet().config.language === "en" ? "Input Required" : "需要用户选择";
          const displaySummary = pickProcessAssistantText(
            text,
            sessionGet().normalizedStreamState.hiddenThought,
            language
          );

          void invoke("send_feishu_message", {
            chatId: remoteFeishu.chatId,
            userId: remoteFeishu.userId,
            openId: remoteFeishu.userId,
            messageId: remoteFeishu.messageId,
            text: displaySummary,
            feishuCardTitle: cardTitle,
            feishuCardMarkdown: displaySummary,
            harnessIterationCount: meta?.iterationCount || 0,
            harnessMaxIterations: meta?.maxIterations || PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
            isFeishuReplyCard: true,
          }).catch(() => {});
        }

        if (awaitingInput && context.understandingProgressBlockId != null) {
          context.understandingProgressClosed = true;
        }

        // Complete understanding progress
        if (!awaitingInput && !provisionalPlanCandidate && !context.understandingProgressClosed && context.understandingProgressBlockId != null) {
          context.understandingProgressClosed = true;
          const progress = {
            phase: "understanding" as const,
            title: phaseLanguage === "zh" ? "理解需求" : "Understanding request",
            why: sessionGet().planExecutionProgressSnapshot?.nextStep || "",
            action: "",
            evidence: "",
            next: "",
            targets: [],
            status: "done" as const,
            source: "runtime" as const,
            hypothesisStatus: "confirmed" as const,
          };
          const blockId = context.understandingProgressBlockId;
          sessionSet((s: any) => ({
            taskFlow: s.taskFlow.map((block: any) =>
              block.id === blockId && block.type === "progress"
                ? {
                    ...block,
                    ...progress,
                    turnPhase: makeTurnRuntimePhase("scope", phaseLanguage, { status: "done" }),
                  }
                : block
            ),
          }));
          emitProgressRuntimeEvent(progress, { dedupeKey: `understanding:${turnId}` });
        }

        // Finalize state
        sessionSet((s: any) => {
          let taskFlow = s.taskFlow;
          let conversationTurns = s.conversationTurns;
          let nextStreamingBlockId = context.currentStreamingBlockId;
          const assistantPresentationPatch = provisionalPlanCandidate
            ? { hiddenProcess: true, visibility: "hidden_process" as const }
            : meta?.visibility
            ? {
                hiddenProcess: meta.visibility === "hidden_process",
                visibility: meta.visibility,
              }
            : {};

          // Merge answer/progress block. When this text precedes tool calls, close
          // the visible block but keep the overall run active for tool execution
          // and the next model iteration.
          if (context.currentStreamingBlockId !== null) {
            const blockId = context.currentStreamingBlockId;
            const streamingBlock = taskFlow.find((t: any) => t.id === blockId && t.type === "agent") as any;
            if (streamingBlock?.archivedAfterChoice) {
              const replacementBlockId = s._nextTaskId();
              const replacementBlock = attachRuntimePhase({
                id: replacementBlockId,
                turnId,
                type: "agent",
                content: visibleText,
                streaming: false,
                options: replyOptions,
                choiceRequest: choiceRequestIdentity,
                ...assistantPresentationPatch,
              } as TaskBlock);
              taskFlow = [...taskFlow, replacementBlock];
              conversationTurns = conversationTurns.map((turn: any) =>
                turn.id === turnId && !turn.blockIds.includes(replacementBlockId)
                  ? { ...turn, blockIds: [...turn.blockIds, replacementBlockId] }
                  : turn
              );
            } else {
              taskFlow = taskFlow.map((t: any) =>
                t.id === blockId && t.type === "agent"
                  ? { ...t, content: visibleText, streaming: false, options: replyOptions, choiceRequest: choiceRequestIdentity, ...assistantPresentationPatch }
                  : t
              );
            }
            if (hasToolCalls) {
              nextStreamingBlockId = null;
            }
          } else {
            const normalizedVisibleCandidate = normalizeModelFeedbackForDedupe(visibleText);
            const existingAgentBlock = [...taskFlow]
              .reverse()
              .find((block) =>
                block.turnId === turnId &&
                block.type === "agent" &&
                !block.archivedAfterChoice &&
                block.visibility !== "assistant_update" &&
                block.visibility !== "assistant_final" &&
                context.agentBlockIdsCreatedThisRun.has(block.id) &&
                normalizeModelFeedbackForDedupe(String(block.content || "")) ===
                  normalizedVisibleCandidate
              );

            if (existingAgentBlock) {
              const blockId = existingAgentBlock.id;
              taskFlow = taskFlow.map((t: any) =>
                t.id === blockId && t.type === "agent"
                  ? { ...t, content: visibleText, streaming: false, options: replyOptions, choiceRequest: choiceRequestIdentity, ...assistantPresentationPatch }
                  : t
              );
            } else {
              const blockId = s._nextTaskId();
              const blockWithTurn = attachRuntimePhase({
                id: blockId,
                turnId,
                type: "agent",
                content: visibleText,
                streaming: false,
                options: replyOptions,
                choiceRequest: choiceRequestIdentity,
                ...assistantPresentationPatch,
              } as TaskBlock);

              taskFlow = [...taskFlow, blockWithTurn];
              conversationTurns = conversationTurns.map((turn: any) =>
                turn.id === turnId && !turn.blockIds.includes(blockId)
                  ? { ...turn, blockIds: [...turn.blockIds, blockId] }
                  : turn
              );
            }
          }

          if (awaitingInput && context.understandingProgressBlockId != null) {
            const progressBlockId = context.understandingProgressBlockId;
            taskFlow = taskFlow.filter((block: any) =>
              !(block.id === progressBlockId && block.type === "progress")
            );
            conversationTurns = conversationTurns.map((turn: any) =>
              turn.id === turnId && Array.isArray(turn.blockIds) && turn.blockIds.includes(progressBlockId)
                ? { ...turn, blockIds: turn.blockIds.filter((id: number) => id !== progressBlockId) }
                : turn
            );
            context.understandingProgressBlockId = null;
          }

          context.currentStreamingBlockId = nextStreamingBlockId;

          conversationTurns = conversationTurns.map((turn: any) =>
            turn.id === turnId
              ? awaitingInput
                ? {
                    ...turn,
                    status: "awaiting_input",
                    summary: normalizedFinal || turn.summary,
                  }
                : provisionalPlanCandidate
                ? {
                    ...turn,
                    status: turn.status === "awaiting_approval" ? turn.status : "planning",
                  }
                : hasToolCalls
                ? {
                    ...turn,
                    status: turn.status === "awaiting_approval"
                      ? turn.status
                      : isUnapprovedPlanRuntime()
                      ? "planning"
                      : "executing",
                  }
                : {
                    ...turn,
                    // A model final is only a terminal candidate. Completion
                    // guards, durable persistence, and the harness lease must
                    // all settle before the workflow owner closes the turn.
                    status: turn.status === "awaiting_approval"
                      ? turn.status
                      : isUnapprovedPlanRuntime()
                      ? "planning"
                      : "executing",
                    summary: normalizedFinal,
                  }
              : turn
          );

          if (awaitingInput) {
            return {
              taskFlow,
              conversationTurns,
            };
          }

          if (provisionalPlanCandidate) {
            return {
              taskFlow,
              conversationTurns,
              agentStatus: "running",
              isGenerating: true,
            };
          }

          if (hasToolCalls) {
            return {
              taskFlow,
              conversationTurns,
              agentStatus: s.agentStatus === "pending_review" ? "pending_review" : "running",
              isGenerating: true,
            };
          }

          return {
            taskFlow,
            conversationTurns,
          };
        });
      },

      onToolExecuting: (toolName: string, target: string, diffPreview?: any, meta?: { toolCallId?: string }) => {
        const lifecycleMeta = normalizeToolLifecycleMeta(meta);
        const executionId = lifecycleMeta.toolCallId || undefined;
        const isInternalPlanArtifactMutation =
          isUnapprovedPlanRuntime() &&
          (toolName === "write_file" || toolName === "replace_in_file") &&
          detectPlanArtifactKind(target) !== null;
        logStoreEvent("tool_start", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          toolName,
          executionId,
        });

        // Auto collapse understanding progress
        if (!context.understandingProgressClosed && context.understandingProgressBlockId != null) {
          context.understandingProgressClosed = true;
          const progress = {
            phase: "understanding" as const,
            title: phaseLanguage === "zh" ? "理解需求" : "Understanding request",
            why: sessionGet().planExecutionProgressSnapshot?.nextStep || "",
            action: "",
            evidence: "",
            next: "",
            targets: [],
            status: "done" as const,
            source: "runtime" as const,
            hypothesisStatus: "confirmed" as const,
          };
          const blockId = context.understandingProgressBlockId;
          sessionSet((s: any) => ({
            taskFlow: s.taskFlow.map((block: any) =>
              block.id === blockId && block.type === "progress"
                ? {
                    ...block,
                    ...progress,
                    turnPhase: makeTurnRuntimePhase("scope", phaseLanguage, { status: "done" }),
                  }
                : block
            ),
          }));
          emitProgressRuntimeEvent(progress, { dedupeKey: `understanding:${turnId}` });
        }

        const blockId = sessionGet()._nextTaskId();
        const turnPhase = deriveTurnRuntimePhaseForTool({
          toolName,
          target,
          language: phaseLanguage,
          status: "running",
        });
        const progress = buildToolProgressNarration({
          toolName,
          target,
          language: phaseLanguage,
          status: "running",
          source: "runtime",
          turnIntent: effectiveRunIntent,
          workflowMode: sessionGet().config.workflowMode,
          sourceToolCallIds: executionId ? [executionId] : [],
        });
        const diff = shouldAttachToolDiffPreview(toolName, target, diffPreview) ? diffPreview : undefined;
        const intentSummary = deriveToolIntentSummary({
          toolName,
          target,
          language: phaseLanguage,
          status: "running",
          toolStatus: "running",
        });
        emitProgressRuntimeEvent({
          ...progress,
          ...(isInternalPlanArtifactMutation ? { audience: "internal" as const } : {}),
        }, { dedupeKey: `tool:${executionId || `${toolName}:${target}`}` });
        sessionSet((s: any) => {
          const existingIndex = findCurrentToolLifecycleBlockIndex(
            s.taskFlow,
            toolName,
            target,
            ["pending", "running"],
            lifecycleMeta,
          );
          const updateToolBlock = (block: any) => attachRuntimePhase({
            ...block,
            ...(isInternalPlanArtifactMutation ? { audience: "internal" } : {}),
            turnId: block.turnId || toolDisplayTurnId,
            type: "tool",
            toolName,
            target,
            status: "running",
            toolStatus: "running",
            toolCallId: executionId,
            executionId,
            intentSummary,
            why: progress.why,
            evidence: progress.evidence,
            observationSummary: progress.observedFact,
            turnPhase,
            ...(diff ? { diff } : {}),
          } as any, turnPhase);

          if (existingIndex >= 0) {
            return {
              agentStatus: s.agentStatus === "pending_review" ? "pending_review" : "running",
              isGenerating: true,
              taskFlow: s.taskFlow.map((block: any, index: number) =>
                index === existingIndex ? updateToolBlock(block) : block
              ),
            };
          }

          const blockWithTurn = updateToolBlock({
            id: blockId,
            turnId: toolDisplayTurnId,
          });
          return {
            agentStatus: s.agentStatus === "pending_review" ? "pending_review" : "running",
            isGenerating: true,
            taskFlow: [...s.taskFlow, blockWithTurn],
            conversationTurns: s.conversationTurns.map((turn: any) =>
              turn.id === turnId && !turn.blockIds.includes(blockId)
                ? { ...turn, blockIds: [...turn.blockIds, blockId] }
                : turn
            ),
          };
        });
      },

      onToolDone: (
        toolName: string,
        target: string,
        result: string,
        meta?: {
          toolCallId?: string;
          diff?: any;
          internalFeedback?: boolean;
          qualityGateReason?: string | null;
          evidenceResult?: string;
        },
      ) => {
        const lifecycleMeta = normalizeToolLifecycleMeta(meta);
        const executionId = lifecycleMeta.toolCallId || undefined;
        const resultText = String(result || "");
        if (meta?.internalFeedback === true) {
          logStoreEvent("tool_result_internal_feedback", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            toolName,
            target,
            executionId,
            qualityGateReason: meta.qualityGateReason || null,
            resultChars: resultText.length,
          });
          sessionSet((s: any) => {
            const existingIndex = findCurrentToolLifecycleBlockIndex(
              s.taskFlow,
              toolName,
              target,
              ["pending", "running", "executed"],
              lifecycleMeta,
            );
            if (existingIndex < 0) return {};
            const blockId = s.taskFlow[existingIndex]?.id;
            return {
              taskFlow: s.taskFlow.filter((_: any, index: number) => index !== existingIndex),
              conversationTurns: s.conversationTurns.map((turn: any) =>
                blockId != null && turn.blockIds.includes(blockId)
                  ? { ...turn, blockIds: turn.blockIds.filter((id: number) => id !== blockId) }
                  : turn
              ),
            };
          });
          return;
        }
        const completedDiff = shouldAttachToolDiffPreview(toolName, target, meta?.diff) ? meta?.diff : undefined;
        const evidenceResultText = typeof meta?.evidenceResult === "string"
          ? meta.evidenceResult
          : resultText;
        const operationOutcome = classifyCommandResultOutcome(toolName, evidenceResultText);
        const operationFailed = operationOutcome === "failed";
        const operationRunning = operationOutcome === "running";
        // The tool call itself finished even when it reported an already-live
        // PTY process. Process liveness belongs to the evidence ledger; leaving
        // the tool card running would make later lifecycle matching ambiguous.
        const operationStatus = operationFailed ? "failed" : "done";
        const operationToolStatus = operationFailed ? "failed" : "executed";
        const noOp = isNoOpToolFeedback(evidenceResultText);
        const unownedEntry = createPlanExecutionEvidenceEntry({
          toolName,
          target,
          result: evidenceResultText,
          noOp,
          diff: completedDiff,
          transactionId: turnId,
          runId: activeRuntimeRunIdentity.runId,
        });
        const entry = unownedEntry
          ? { ...unownedEntry, ...resolveCurrentPlanEvidenceIdentity(unownedEntry) }
          : null;
        const observationSummary = summarizeToolObservation({
          toolName,
          target,
          result: resultText,
          language: phaseLanguage,
          noOp,
        });
        const progress = buildToolProgressNarration({
          toolName,
          target,
          language: phaseLanguage,
          status: operationStatus,
          source: "tool_result",
          turnIntent: effectiveRunIntent,
          workflowMode: sessionGet().config.workflowMode,
          previousObservation: observationSummary,
          result: resultText,
          noOp,
          hypothesisStatus: noOp || operationFailed
            ? "blocked"
            : operationRunning
            ? "unverified"
            : "confirmed",
          sourceToolCallIds: executionId ? [executionId] : [],
        });
        logStoreEvent("tool_result", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          toolName,
          executionId,
          resultChars: result?.length ?? 0,
          isError: operationFailed,
        });

        sessionSet((s: any) => {
          const existingIndex = findCurrentToolLifecycleBlockIndex(
            s.taskFlow,
            toolName,
            target,
            ["pending", "running", "executed"],
            lifecycleMeta,
          );
          const currentLedger = s.planExecutionEvidenceLedger || [];
          const nextLedger = appendPlanEvidenceEntry(currentLedger, entry);
          const gainedDurableExecutionEvidence = nextLedger !== currentLedger;
          const nextTasks = reconcilePlanTaskCompletion(
            s.planTasks || [],
            s.planTasks || [],
            nextLedger,
            {
              preserveMissing: s.isPlanApproved || s.planStage === "executing" || s.planStage === "completed" || s.planTasks.length > 0,
              highlightNext: s.isPlanApproved && nextLedger.length > 0,
            }
          );

          // Durable execution evidence belongs to the tool result, not to its
          // presentation block. A lifecycle card may be absent after restore,
          // compaction, or a UI timing race; dropping a successful result here
          // leaves approved tasks pending and can make the model rerun an
          // already-successful command until the repetition guard fires.
          const evidencePatch = {
            planExecutionEvidenceLedger: nextLedger,
            planExecutionEvidenceCount: nextLedger.length,
            planTasks: nextTasks,
            // This is a consecutive no-progress strategy budget, not a
            // lifetime task limit. Fresh durable evidence starts a new finite
            // pivot epoch when unfinished work remains.
            ...(gainedDurableExecutionEvidence ? { planAutoResumeCount: 0 } : {}),
          };
          if (existingIndex < 0) return evidencePatch;

          return {
            ...evidencePatch,
            taskFlow: s.taskFlow.map((block: any, index: number) => {
              if (index !== existingIndex) return block;
              const completedPhase = withTurnRuntimePhaseStatus(
                block.turnPhase || deriveTurnRuntimePhaseForTool({
                  toolName,
                  target,
                  language: phaseLanguage,
                  status: operationStatus,
                }),
                operationStatus,
                phaseLanguage,
              );
              return {
                ...block,
                status: operationStatus,
                toolStatus: operationToolStatus,
                // Preserve the exact structured apply_patch evidence (not its
                // UI-truncated display) so terminal summaries retain every
                // changed source/destination path.
                output: toolName === "apply_patch" ? evidenceResultText : resultText,
                message: resultText,
                ...(completedDiff ? { diff: completedDiff } : block.diff ? { diff: block.diff } : {}),
                intentSummary: block.intentSummary || deriveToolIntentSummary({
                  toolName,
                  target,
                  language: phaseLanguage,
                  status: operationStatus,
                  toolStatus: operationToolStatus,
                }),
                why: block.why || progress.why,
                evidence: progress.evidence || block.evidence,
                observationSummary,
                turnPhase: completedPhase || block.turnPhase,
              };
            }),
          };
        });
        emitProgressRuntimeEvent(
          progress,
          { dedupeKey: `tool:${executionId || `${toolName}:${target}`}` },
        );
      },

      onPlanRuntimeNarration: (narration) => {
        sessionSet((state: any) => ({
          currentTurnState: {
            ...state.currentTurnState,
            capsuleExplanation: narration
              ? {
                  turnId: toolDisplayTurnId,
                  text: narration,
                  updatedAt: Date.now(),
                  source: "runtime" as const,
                }
              : null,
          },
        }));
      },

      onToolError: (
        toolName: string,
        target: string,
        error: string,
        meta?: ToolErrorLifecycleMeta,
      ) => {
        const lifecycleMeta = normalizeToolLifecycleMeta(meta);
        const executionId = lifecycleMeta.toolCallId || undefined;
        const errorText = String(error || "");
        const failureKind = meta?.failureKind || "policy";
        if (meta?.internalFeedback === true) {
          logStoreEvent("tool_error_internal_feedback", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            toolName,
            target,
            executionId,
            failureKind,
            qualityGateReason: meta.qualityGateReason || null,
            planRecoveryReason: meta.planRecoveryReason || null,
            errorChars: errorText.length,
          });
          sessionSet((s: any) => {
            const existingIndex = findCurrentToolLifecycleBlockIndex(
              s.taskFlow,
              toolName,
              target,
              ["pending", "running", "failed"],
              lifecycleMeta,
            );
            if (existingIndex < 0) return {};
            const blockId = s.taskFlow[existingIndex]?.id;
            return {
              taskFlow: s.taskFlow.filter((_: any, index: number) => index !== existingIndex),
              conversationTurns: s.conversationTurns.map((turn: any) =>
                blockId != null && turn.blockIds.includes(blockId)
                  ? { ...turn, blockIds: turn.blockIds.filter((id: number) => id !== blockId) }
                  : turn
              ),
            };
          });
          return;
        }
        const observationSummary = summarizeToolObservation({
          toolName,
          target,
          result: errorText,
          language: phaseLanguage,
        });
        const progress = buildToolProgressNarration({
          toolName,
          target,
          language: phaseLanguage,
          status: "failed",
          source: "tool_result",
          turnIntent: effectiveRunIntent,
          workflowMode: sessionGet().config.workflowMode,
          previousObservation: observationSummary,
          result: errorText,
          hypothesisStatus: "blocked",
          sourceToolCallIds: executionId ? [executionId] : [],
        });
        const unownedFailureEntry = shouldRecordPlanExecutionFailure(meta)
          ? createPlanExecutionFailureEntry({
              toolName,
              target,
              error: errorText,
              transactionId: turnId,
              runId: activeRuntimeRunIdentity.runId,
            })
          : null;
        const failureEntry = unownedFailureEntry
          ? {
              ...unownedFailureEntry,
              ...resolveCurrentPlanEvidenceIdentity(unownedFailureEntry),
            }
          : null;
        logStoreEvent("tool_result", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          toolName,
          executionId,
          resultChars: error?.length ?? 0,
          isError: true,
          failureKind,
          failureKindExplicit: meta?.failureKind != null,
          ledgerRecorded: failureEntry != null,
        });

        sessionSet((s: any) => {
          const existingIndex = findCurrentToolLifecycleBlockIndex(
            s.taskFlow,
            toolName,
            target,
            ["pending", "running", "failed"],
            lifecycleMeta,
          );
          const evidencePatch = failureEntry
            ? (() => {
                const nextLedger = appendPlanEvidenceEntry(
                  s.planExecutionEvidenceLedger || [],
                  failureEntry,
                );
                const nextTasks = reconcilePlanTaskCompletion(
                  s.planTasks || [],
                  s.planTasks || [],
                  nextLedger,
                  {
                    preserveMissing:
                      s.isPlanApproved ||
                      s.planStage === "executing" ||
                      s.planStage === "completed" ||
                      s.planTasks.length > 0,
                    highlightNext: s.isPlanApproved && nextLedger.length > 0,
                  },
                );
                return {
                  planExecutionEvidenceLedger: nextLedger,
                  planExecutionEvidenceCount: nextLedger.length,
                  planTasks: nextTasks,
                };
              })()
            : {};
          if (existingIndex < 0) return evidencePatch;
          return {
            ...evidencePatch,
            taskFlow: s.taskFlow.map((block: any, index: number) => {
              if (index !== existingIndex) return block;
              const failedPhase = withTurnRuntimePhaseStatus(
                block.turnPhase || deriveTurnRuntimePhaseForTool({
                  toolName,
                  target,
                  language: phaseLanguage,
                  status: "failed",
                }),
                "failed",
                phaseLanguage,
              );
              return {
                ...block,
                status: "error",
                toolStatus: "failed",
                output: errorText,
                message: errorText,
                intentSummary: block.intentSummary || deriveToolIntentSummary({
                  toolName,
                  target,
                  language: phaseLanguage,
                  status: "failed",
                  toolStatus: "failed",
                }),
                why: block.why || progress.why,
                evidence: progress.evidence || block.evidence,
                observationSummary,
                turnPhase: failedPhase || block.turnPhase,
              };
            }),
          };
        });
        emitProgressRuntimeEvent(
          progress,
          { dedupeKey: `tool:${executionId || `${toolName}:${target}`}` },
        );
      },

      requestReview: (toolCall: any) => {
        const toolName = String(toolCall?.name || "tool");
        const reviewTarget = deriveReviewToolTarget(toolCall);
        const reviewToolCallId = String(toolCall?.toolCallId || toolCall?.id || "").trim();
        const autoApproveToolScopes = sessionGet().autoApproveToolScopes || [];
        const reviewRunOwner = {
          sessionKey: runSessionKey,
          turnId,
          runId: activeRuntimeRunIdentity.runId,
          parentRunId: activeRuntimeRunIdentity.parentRunId,
        };
        const reviewLifecycle = sessionGet().planLifecycle as PlanLifecycleState | undefined;
        const reviewExecutionLease = reviewLifecycle?.executionLease;
        const reviewExecutionOwner = reviewLifecycle?.execution;
        const currentPlanIdentity = buildPlanApprovalIdentity(
          sessionGet().planArtifacts || [],
        );
        const activePlanArtifactIdentityCurrent = !activePlanExecutionIdentity || (
          !!currentPlanIdentity &&
          currentPlanIdentity.revision === activePlanExecutionIdentity.planRevision &&
          currentPlanIdentity.artifactHash === activePlanExecutionIdentity.artifactHash
        );
        const liveRunClaimsPlanExecution = !!reviewLifecycle &&
          !!reviewExecutionLease &&
          !!reviewExecutionOwner &&
          isPlanLifecycleExecutionAuthorizedForRun(reviewLifecycle, {
            executionLeaseId: reviewExecutionLease.executionLeaseId,
            turnId: reviewRunOwner.turnId,
            runId: reviewRunOwner.runId,
            parentRunId: reviewRunOwner.parentRunId,
            attempt: reviewExecutionOwner.attempt,
          });
        if (
          (
            activePlanExecutionIdentity &&
            (
              !isPlanExecutionAttemptIdentityCurrentForRun({
                identity: activePlanExecutionIdentity,
                owner: reviewRunOwner,
                lifecycle: reviewLifecycle,
              }) ||
              !activePlanArtifactIdentityCurrent
            )
          ) ||
          (!activePlanExecutionIdentity && liveRunClaimsPlanExecution)
        ) {
          logStoreEvent("plan_tool_permission_rejected_stale_run_provenance", {
            turnId,
            toolName,
            target: reviewTarget,
            toolCallId: reviewToolCallId || null,
            executionLeaseId: activePlanExecutionIdentity?.executionLeaseId ||
              reviewExecutionLease?.executionLeaseId || null,
            executionAttempt: activePlanExecutionIdentity?.attempt ||
              reviewExecutionOwner?.attempt || null,
            reason: activePlanExecutionIdentity
              ? activePlanArtifactIdentityCurrent
                ? "plan_attempt_identity_stale"
                : "plan_artifact_identity_stale"
              : "plan_attempt_identity_missing_from_run",
          });
          return Promise.resolve({ action: "reject" });
        }
        logStoreEvent("request_review_started", {
          turnId,
          toolName,
          target: reviewTarget,
          toolCallId: reviewToolCallId || null,
          toolSource: toolCall?.source ?? null,
          toolRisk: toolCall?.risk ?? null,
          autoApproveToolScopes,
          shellPermissionGated: !!toolCall?.shellPermissionDecision,
        });

        return new Promise<any>((resolve) => {
          enterRealPendingReviewState();

          const taskFlow = sessionGet().taskFlow;
          const toolBlock = [...taskFlow]
            .reverse()
            .find((block: any) => {
              if (block.turnId !== turnId && block.turnId !== toolDisplayTurnId) return false;
              if (block.type !== "tool" || block.toolName !== toolName) return false;
              if (reviewToolCallId && String(block.toolCallId || block.executionId || "") === reviewToolCallId) return true;
              return block.toolStatus === "running" && String(block.target || "") === reviewTarget;
            });
          const taskId = toolBlock ? toolBlock.id : sessionGet()._nextTaskId();
          const pendingPhase = deriveTurnRuntimePhaseForTool({
            toolName,
            target: reviewTarget,
            language: phaseLanguage,
            status: "pending",
          });
          const progress = buildToolProgressNarration({
            toolName,
            target: reviewTarget,
            language: phaseLanguage,
            status: "running",
            source: "runtime",
            turnIntent: effectiveRunIntent,
            workflowMode: sessionGet().config.workflowMode,
            sourceToolCallIds: reviewToolCallId ? [reviewToolCallId] : [],
          });
          const pendingMessage = phaseLanguage === "zh"
            ? "等待用户批准后执行。"
            : "Waiting for approval before execution.";

          sessionSet((s: any) => {
            const updatePendingBlock = (block: any) => attachRuntimePhase({
              ...block,
              turnId: block.turnId || toolDisplayTurnId,
              type: "tool",
              toolName,
              target: block.target || reviewTarget,
              status: "pending_review",
              toolStatus: "pending",
              ...(reviewToolCallId ? { toolCallId: reviewToolCallId, executionId: reviewToolCallId } : {}),
              ...(toolCall?.shellPermissionDecision ? { shellPermissionDecision: toolCall.shellPermissionDecision } : {}),
              message: block.message || pendingMessage,
              intentSummary: block.intentSummary || deriveToolIntentSummary({
                toolName,
                target: reviewTarget,
                language: phaseLanguage,
                status: "running",
                toolStatus: "pending",
              }),
              why: block.why || progress.why,
              evidence: block.evidence || progress.evidence,
              observationSummary: block.observationSummary || progress.observedFact,
              turnPhase: pendingPhase,
            } as any, pendingPhase);

            if (toolBlock) {
              return {
                taskFlow: s.taskFlow.map((block: any) =>
                  block.id === taskId ? updatePendingBlock(block) : block
                ),
              };
            }

            const pendingBlock = updatePendingBlock({
              id: taskId,
              turnId: toolDisplayTurnId,
            });
            return {
              taskFlow: [...s.taskFlow, pendingBlock],
              conversationTurns: s.conversationTurns.map((turn: any) =>
                (turn.id === turnId || turn.id === toolDisplayTurnId) && !turn.blockIds.includes(taskId)
                  ? { ...turn, blockIds: [...turn.blockIds, taskId] }
                  : turn
              ),
            };
          });

          sessionSet({
            pendingReviewTaskId: taskId,
            pendingToolCall: toolCall,
          });
          const permissionRequest = buildToolPermissionActionRequest({
            sessionKey: runSessionKey,
            turnId,
            runId: activeRuntimeRunIdentity.runId,
            parentRunId: activeRuntimeRunIdentity.parentRunId,
            title: resolveCurrentTurnTitle(),
            taskId,
            toolCall,
            ...(activePlanExecutionIdentity
              ? { planExecution: activePlanExecutionIdentity }
              : {}),
          });
          const permissionPauseMessage = phaseLanguage === "zh"
            ? `等待批准：${permissionRequest.toolName} · ${permissionRequest.target}`
            : `Awaiting approval: ${permissionRequest.toolName} · ${permissionRequest.target}`;
          publishActionRequest(permissionRequest, {
            reason: "tool_permission",
            target: permissionRequest.target,
            pauseMessage: permissionPauseMessage,
          });
          appendWorkflowRuntimeEvent({
            type: "run.paused",
            threadId: runSessionKey,
            turnId,
            timestampMs: Date.now(),
            runId: permissionRequest.runId,
            parentRunId: permissionRequest.parentRunId || null,
            ...(activeRuntimeRunIdentity.goalSliceId
              ? { goalSliceId: activeRuntimeRunIdentity.goalSliceId }
              : {}),
            reason: "tool_permission",
            message: permissionPauseMessage,
          });

          const reviewSettlement = createAbortableReviewSettlement({
            signal: abortCtrl.signal,
            abortedDecision: { action: "reject" },
            onContinue: () => beginActionContinuationRun(permissionRequest),
            onAbort: () => {
              sessionSet((state: any) =>
                state.activeActionRequest?.requestId === permissionRequest.requestId
                  ? {
                      pendingReviewResolve: null,
                      pendingReviewTaskId: null,
                      pendingToolCall: null,
                      activeActionRequest: null,
                    }
                  : {}
              );
            },
            onDecision: resolve,
          });
          sessionSet({
            pendingReviewResolve: reviewSettlement.resolve,
          });
          reviewSettlement.arm();
        });
      },

      onPlanExecutionProgress: (progress: PlanExecutionProgressUpdate) => {
        logStoreEvent("plan_execution_progress", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          phase: progress.phase,
          iteration: progress.iteration,
          autoResume: progress.autoResumeCount,
          currentTaskId: progress.currentTaskId || null,
          currentTask: progress.currentTask,
          currentTool: progress.currentTool,
          latestEvidence: progress.latestEvidence,
          progressSignature: progress.progressSignature || null,
          recoveryReason: progress.recoveryReason || null,
          repeatedTargets: progress.repeatedTargets || [],
        });

        emitLocalPlanExecutionProgress(progress.phase, {
          iteration: progress.iteration,
          maxIterations: progress.maxIterations,
          currentTaskId: progress.currentTaskId,
          currentTask: progress.currentTask,
          currentTool: progress.currentTool,
          latestEvidence: progress.latestEvidence,
          progressSignature: progress.progressSignature,
          lastEffectiveEvidenceAt: progress.lastEffectiveEvidenceAt,
          recoveryReason: progress.recoveryReason,
          repeatedTargets: progress.repeatedTargets,
          nextStep: progress.nextStep,
        });
      },

      onChatMaxIterationsCheckpoint: (checkpoint: PlanMaxIterationsCheckpoint) => {
        const currentCount = Math.max(
          0,
          Number(sessionGet().planAutoResumeCount) || 0,
        );
        const shouldAutoResume =
          checkpoint.autoResumeEligible &&
          checkpoint.strategyPivot !== null &&
          currentCount < checkpoint.strategyPivotBudget;
        if (!shouldAutoResume) return false;

        const effectiveCheckpoint = {
          ...checkpoint,
          autoResumeCount: currentCount + 1,
        };
        sessionSet((state: any) => ({
          planAutoResumeCount: currentCount,
          conversationTurns: state.conversationTurns.map((turn: any) =>
            turn.id === turnId || turn.id === context.uiDisplayTurnId
              ? { ...turn, collapsed: false }
              : turn
          ),
        }));
        logStoreEvent("chat_max_iterations_auto_resume_pending", {
          autoResumeCount: effectiveCheckpoint.autoResumeCount,
          maxIterations: checkpoint.maxIterations,
          runtimeIntent: effectiveRunIntent,
          strategyPivot: effectiveCheckpoint.strategyPivot,
        });

        const cancelAutoResume = (reason: string, options?: { visible?: boolean }) => {
          const latest = sessionGet();
          const latestSessionKey = resolveSessionRuntimeKey(
            resolveSessionWorkspaceKey(latest.currentWorkspace),
            latest.currentSessionId,
          );
          if (latestSessionKey !== runSessionKey) return;
          const cancellationNotice = phaseLanguage === "zh"
            ? "对话策略续跑已取消：新的用户消息或运行时交接优先。已有上下文仍会保留。"
            : "Conversation strategy continuation was canceled because a newer user message or runtime handoff took priority. Retained context remains available.";
          sessionSet((state: any) => ({
            planAutoResumeCount: currentCount,
            conversationTurns: state.conversationTurns.map((turn: any) =>
              turn.id === turnId || turn.id === context.uiDisplayTurnId
                ? { ...turn, collapsed: false }
                : turn
            ),
            runtimeEvents: state.runtimeEvents.map((event: any) =>
              event.type === "run.paused" &&
              event.runId === activeRuntimeRunIdentity.runId &&
              event.reason === "max_iterations_auto_resume"
                ? {
                    ...event,
                    reason: "max_iterations_auto_resume_canceled",
                    message: cancellationNotice,
                  }
                : event
            ),
          }));
          if (options?.visible) {
            sessionGet().setConversationTurnSummary(
              context.uiDisplayTurnId,
              cancellationNotice,
            );
          }
          logStoreEvent("chat_max_iterations_auto_resume_canceled", {
            reason,
            autoResumeCount: currentCount,
          });
        };

        pendingMaxIterationsAutoResume = {
          kind: "chat",
          cancel: cancelAutoResume,
          start: () => {
            const latest = sessionGet();
            const latestSessionKey = resolveSessionRuntimeKey(
              resolveSessionWorkspaceKey(latest.currentWorkspace),
              latest.currentSessionId,
            );
            if (latestSessionKey !== runSessionKey) return;
            if (
              latest.isGenerating ||
              latest.agentStatus === "running" ||
              latest.agentStatus === "pending_review"
            ) {
              logStoreEvent("chat_max_iterations_auto_resume_skipped", {
                reason: "newer_run_active",
                agentStatus: latest.agentStatus,
                isGenerating: latest.isGenerating,
              });
              return;
            }

            sessionSet((state: any) => ({
              planAutoResumeCount: effectiveCheckpoint.autoResumeCount,
              conversationTurns: state.conversationTurns.map((turn: any) =>
                turn.id === turnId || turn.id === context.uiDisplayTurnId
                  ? { ...turn, status: "executing" }
                  : turn
              ),
            }));
            let started = false;
            try {
              started = latest.sendMessage(
                buildChatMaxIterationsResumePrompt({
                  language: phaseLanguage,
                  runtimeIntent: effectiveRunIntent,
                  checkpoint: effectiveCheckpoint,
                }),
                undefined,
                {
                  hidden: true,
                  reuseCurrentTurn: true,
                  turnIdOverride: context.uiDisplayTurnId || turnId,
                  preservePlanState: true,
                  resolvedIntent: effectiveRunIntent,
                  runtimeIntentOverride: effectiveRunIntent,
                  parentRunIdOverride: activeRuntimeRunIdentity.runId,
                  skipIntentResolution: true,
                  turnTitle: phaseLanguage === "zh"
                    ? "对话策略续跑"
                    : "Conversation Strategy Continuation",
                  intentSummary: phaseLanguage === "zh"
                    ? `达到安全轮次边界后切换策略：${effectiveCheckpoint.strategyPivot}。`
                    : `Switch bounded strategy after the conversation safety boundary: ${effectiveCheckpoint.strategyPivot}.`,
                },
              ) === true;
            } catch (error) {
              logStoreEvent("chat_max_iterations_auto_resume_submission_failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
            if (started) {
              logStoreEvent("chat_max_iterations_auto_resume_dispatched", {
                autoResumeCount: effectiveCheckpoint.autoResumeCount,
                runtimeIntent: effectiveRunIntent,
                parentRunId: activeRuntimeRunIdentity.runId,
              });
            } else {
              cancelAutoResume("resume_submission_rejected", { visible: true });
            }
          },
        };
        return {
          status: "auto_resume_scheduled" as const,
          checkpoint: effectiveCheckpoint,
        };
      },

      onPlanMaxIterationsCheckpoint: (checkpoint: PlanMaxIterationsCheckpoint) => {
        const currentCount = Math.max(
          0,
          Number(sessionGet().planAutoResumeCount) || 0,
        );
        const shouldAutoResume =
          checkpoint.autoResumeEligible &&
          checkpoint.strategyPivot !== null &&
          currentCount < PLAN_MAX_AUTO_RESUME_LIMIT;
        const effectiveCheckpoint = {
          ...checkpoint,
          autoResumeCount: shouldAutoResume ? currentCount + 1 : currentCount,
        };
        const notice = shouldAutoResume
          ? buildPlanMaxIterationsAutoResumeNotice(effectiveCheckpoint, phaseLanguage)
          : buildPlanMaxIterationsPauseNotice(effectiveCheckpoint, phaseLanguage);

        appendDebugLog(
          shouldAutoResume ? "info" : "warn",
          shouldAutoResume
            ? "plan.max_iterations_auto_resume_pending"
            : "plan.max_iterations_paused",
          {
            turnId,
            uiDisplayTurnId: context.uiDisplayTurnId,
            checkpoint: effectiveCheckpoint,
            notice,
          },
        );
        sessionSet((state: any) => ({
          planAutoResumeCount: currentCount,
          planStage: state.planStage === "completed" ? "completed" : "executing",
          conversationTurns: state.conversationTurns.map((turn: any) =>
            turn.id === turnId || turn.id === context.uiDisplayTurnId
              ? { ...turn, collapsed: false }
              : turn
          ),
        }));
        if (!shouldAutoResume) {
          emitLocalPlanExecutionProgress("paused", {
            iteration: effectiveCheckpoint.iterationCount,
            maxIterations: effectiveCheckpoint.maxIterations,
            currentTask: effectiveCheckpoint.currentTask,
            latestEvidence: effectiveCheckpoint.completedEvidence[0],
            recoveryReason: "plan_max_iterations_checkpoint",
            nextStep: phaseLanguage === "zh"
              ? "点击 Resume Execution 后从检查点继续"
              : "click Resume Execution to continue from checkpoint",
          });
          const visibleNotice = phaseLanguage === "zh"
            ? "计划执行已暂停：已达到安全轮次边界。MAIN 已保留当前 workspace 状态；可使用 Resume Execution 从这里继续。"
            : "Plan execution paused after reaching the safety boundary. MAIN kept the current workspace state; use Resume Execution to continue from here.";
          appendTurnBlock({
            id: sessionGet()._nextTaskId(),
            turnId: context.uiDisplayTurnId,
            type: "system",
            content: notice,
            variant: "plan_execution_checkpoint",
          });
          sessionGet().setConversationTurnSummary(
            context.uiDisplayTurnId,
            visibleNotice,
          );
          logStoreEvent("plan_max_iterations_paused", {
            autoResumeCount: currentCount,
            maxIterations: checkpoint.maxIterations,
            reason: checkpoint.autoResumeEligible
              ? "auto_resume_limit_reached"
              : "strategy_pivots_exhausted_or_blocked",
          });
          return true;
        }

        const issuedHandoffRef: { current: PlanApprovalHandoff | null } = { current: null };
        let issueFailureReason = "plan_execution_not_authorized";
        sessionSet((state: any) => {
          const lifecycle = state.planLifecycle as PlanLifecycleState | undefined;
          const executionLease = lifecycle?.executionLease;
          const executionOwner = lifecycle?.execution;
          if (
            !lifecycle ||
            !executionLease ||
            !executionOwner ||
            !isPlanLifecycleExecutionAuthorizedForRun(lifecycle, {
              executionLeaseId: executionLease.executionLeaseId,
              turnId,
              runId: activeRuntimeRunIdentity.runId,
              parentRunId: activeRuntimeRunIdentity.parentRunId,
              attempt: executionOwner.attempt,
            })
          ) {
            return {};
          }
          const instruction = buildPlanMaxIterationsResumePrompt({
            language: phaseLanguage,
            checkpoint: effectiveCheckpoint,
            hasTasksArtifact:
              state.planArtifacts.some((artifact: any) => artifact.kind === "tasks") ||
              state.planTasks.length > 0,
            tasks: state.planTasks,
            artifacts: state.planArtifacts,
            evidenceLedger: state.planExecutionEvidenceLedger,
          });
          const issuedAt = Date.now();
          const checkpointHash = buildPlanExecutionInstructionHash(JSON.stringify({
            iterationCount: effectiveCheckpoint.iterationCount,
            maxIterations: effectiveCheckpoint.maxIterations,
            autoResumeCount: effectiveCheckpoint.autoResumeCount,
            strategyPivot: effectiveCheckpoint.strategyPivot,
            attemptedStrategyPivots: effectiveCheckpoint.attemptedStrategyPivots,
            priorExecutionLeaseId: executionLease.executionLeaseId,
            priorRunId: executionOwner.runId,
          }));
          const issued = issuePlanAutoResumeAttempt({
            lifecycle,
            instruction,
            checkpointHash,
            executionRunId: `run-plan-auto-${issuedAt}-${generateId()}`,
            executionLeaseId: `plan-execution-auto-${issuedAt}-${generateId()}`,
            authorizationRequestId: `plan-auto-checkpoint-${issuedAt}-${generateId()}`,
            issuedAt,
            pause: {
              reason: "max_iterations_auto_resume",
              resultKind: "partial",
              resumeCondition: "bounded_auto_resume_checkpoint",
            },
          });
          if (!issued.ok) {
            issueFailureReason = issued.reason;
            return {};
          }
          issuedHandoffRef.current = issued.handoff;
          return {
            planLifecycle: issued.lifecycle,
            pendingPlanApprovalHandoff: issued.handoff,
            planAutoResumeCount: effectiveCheckpoint.autoResumeCount,
            isPlanApproved: false,
            currentTurnExecutionConsent: { turnId: null, granted: false },
            planApprovalExecutionStartedForTurnId: null,
            planStage: "ready_to_execute",
            conversationTurns: state.conversationTurns.map((candidate: any) =>
              candidate.id === turnId || candidate.id === context.uiDisplayTurnId
                ? { ...candidate, collapsed: false }
                : candidate
            ),
          };
        });
        const issuedHandoff = issuedHandoffRef.current;
        if (!issuedHandoff) {
          const pauseNotice = buildPlanMaxIterationsPauseNotice({
            ...effectiveCheckpoint,
            autoResumeCount: currentCount,
          }, phaseLanguage);
          appendTurnBlock({
            id: sessionGet()._nextTaskId(),
            turnId: context.uiDisplayTurnId,
            type: "system",
            content: pauseNotice,
            variant: "plan_execution_checkpoint",
          });
          sessionGet().setConversationTurnSummary(
            context.uiDisplayTurnId,
            phaseLanguage === "zh"
              ? "计划自动续跑授权未能签发，已安全暂停；可使用 Resume Execution 重试。"
              : "The Plan auto-resume lease could not be issued, so execution paused safely; use Resume Execution to retry.",
          );
          logStoreEvent("plan_max_iterations_auto_resume_lease_rejected", {
            reason: issueFailureReason,
            autoResumeCount: currentCount,
            maxIterations: checkpoint.maxIterations,
          });
          return true;
        }
        logStoreEvent("plan_max_iterations_auto_resume_handoff_issued", {
          autoResumeCount: effectiveCheckpoint.autoResumeCount,
          maxIterations: checkpoint.maxIterations,
          strategyPivot: effectiveCheckpoint.strategyPivot,
          attemptedStrategyPivots: effectiveCheckpoint.attemptedStrategyPivots,
          executionLeaseId: issuedHandoff.executionLeaseId,
          executionRunId: issuedHandoff.executionRunId,
          executionAttempt: issuedHandoff.executionAttempt,
          parentRunId: issuedHandoff.parentRunId,
        });
        return {
          status: "auto_resume_scheduled" as const,
          checkpoint: effectiveCheckpoint,
        };
      },

      onExecuteMaxIterationsCheckpoint: (checkpoint: PlanMaxIterationsCheckpoint) => {
        const currentCount = Math.max(
          0,
          Number(sessionGet().planAutoResumeCount) || 0,
        );
        const shouldAutoResume =
          checkpoint.autoResumeEligible &&
          checkpoint.strategyPivot !== null &&
          currentCount < PLAN_MAX_AUTO_RESUME_LIMIT;
        const effectiveCheckpoint = {
          ...checkpoint,
          autoResumeCount: shouldAutoResume ? currentCount + 1 : currentCount,
        };
        const executeEvidenceLedger = sessionGet().planExecutionEvidenceLedger || [];
        const scopedExecuteEvidenceLedger = scopeExecutionEvidenceLedger(
          executeEvidenceLedger,
          turnId,
        );
        const executeRecoveryDecision = resolveExecuteMaxIterationsRecoveryDecision({
          evidenceLedger: executeEvidenceLedger,
          recoveryState: latestExecuteRecoveryState,
          transactionId: turnId,
        });
        const latestMutationEvidence = [...scopedExecuteEvidenceLedger].reverse().find((entry: any) =>
          entry?.kind === "file" || entry?.kind === "deliverable"
        );
        const expectedTarget =
          latestExecuteRecoveryState?.expectedTarget?.trim() ||
          String(latestMutationEvidence?.target || latestMutationEvidence?.value || "").trim() ||
          null;
        const previousRecoveryContract = latestExecuteRecoveryState
          ? resolveExecuteRecoveryActionContract(latestExecuteRecoveryState.mode, {
              expectedTarget: latestExecuteRecoveryState.expectedTarget,
              readLease: latestExecuteRecoveryState.readLease,
              sourceObservationKey: latestExecuteRecoveryState.sourceObservationKey,
              decisionCheckpoint: latestExecuteRecoveryState.decisionCheckpoint,
              phaseNoProgressCount: latestExecuteRecoveryState.phaseNoProgressCount,
              protocolNoProgressCount: latestExecuteRecoveryState.protocolNoProgressCount,
              protocolNoProgressFingerprint: latestExecuteRecoveryState.protocolNoProgressFingerprint,
            })
          : null;
        const nextRecoveryContract = resolveExecuteRecoveryActionContract(
          executeRecoveryDecision.mode,
          {
            expectedTarget,
            readLease: latestExecuteRecoveryState?.readLease || null,
            sourceObservationKey: latestExecuteRecoveryState?.sourceObservationKey || null,
            decisionCheckpoint: latestExecuteRecoveryState?.decisionCheckpoint || null,
            phaseNoProgressCount: latestExecuteRecoveryState?.phaseNoProgressCount || 0,
            protocolNoProgressCount: latestExecuteRecoveryState?.protocolNoProgressCount || 0,
            protocolNoProgressFingerprint: latestExecuteRecoveryState?.protocolNoProgressFingerprint || null,
          },
        );
        const recoveryPhaseChanged =
          previousRecoveryContract?.phase !== nextRecoveryContract.phase;
        const forcedExecuteRecoveryState: ForcedExecuteRecoveryRuntimeState = {
          mode: executeRecoveryDecision.mode,
          reason: executeRecoveryDecision.reason,
          expectedTarget,
          attempts: Math.max(0, latestExecuteRecoveryState?.attempts || 0),
          phaseNoProgressCount: recoveryPhaseChanged
            ? 0
            : Math.max(0, latestExecuteRecoveryState?.phaseNoProgressCount || 0),
          protocolNoProgressCount: recoveryPhaseChanged
            ? 0
            : Math.max(0, latestExecuteRecoveryState?.protocolNoProgressCount || 0),
          protocolNoProgressFingerprint: recoveryPhaseChanged
            ? null
            : latestExecuteRecoveryState?.protocolNoProgressFingerprint || null,
          readLease:
            nextRecoveryContract.phase === "context" ||
            nextRecoveryContract.phase === "mutation"
              ? latestExecuteRecoveryState?.readLease
                ? { ...latestExecuteRecoveryState.readLease }
                : null
              : null,
          sourceObservationKey: latestExecuteRecoveryState?.sourceObservationKey || null,
          decisionCheckpoint: executeRecoveryDecision.mode === "normal"
            ? null
            : {
                expectedTarget,
                sourceObservationKey:
                  latestExecuteRecoveryState?.sourceObservationKey || null,
                nextRequiredCapability: nextRecoveryContract.nextRequiredCapability,
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.evidenceVersion
                  ? {
                      evidenceVersion:
                        latestExecuteRecoveryState.decisionCheckpoint.evidenceVersion,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.planTaskId
                  ? {
                      planTaskId:
                        latestExecuteRecoveryState.decisionCheckpoint.planTaskId,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.requirementRef
                  ? {
                      requirementRef:
                        latestExecuteRecoveryState.decisionCheckpoint.requirementRef,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.noProgressStrategyPivots?.length
                  ? {
                      noProgressStrategyPivots: [
                        ...latestExecuteRecoveryState.decisionCheckpoint.noProgressStrategyPivots,
                      ],
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.pendingFiniteValidation
                  ? {
                      pendingFiniteValidation:
                        latestExecuteRecoveryState.decisionCheckpoint.pendingFiniteValidation,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.validationMutationReopenCount
                  ? {
                      validationMutationReopenCount:
                        latestExecuteRecoveryState.decisionCheckpoint.validationMutationReopenCount,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.validationMutationReopenFingerprints
                  ? {
                      validationMutationReopenFingerprints: [
                        ...latestExecuteRecoveryState.decisionCheckpoint
                          .validationMutationReopenFingerprints,
                      ],
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.objectiveMutationEvidence
                  ? {
                      objectiveMutationEvidence:
                        latestExecuteRecoveryState.decisionCheckpoint.objectiveMutationEvidence
                          .map((entry) => ({ ...entry })),
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.objectiveClosurePending
                  ? { objectiveClosurePending: true }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.objectiveObligationId
                  ? {
                      objectiveObligationId:
                        latestExecuteRecoveryState.decisionCheckpoint.objectiveObligationId,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.objectiveRevision
                  ? {
                      objectiveRevision:
                        latestExecuteRecoveryState.decisionCheckpoint.objectiveRevision,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.objectiveKind
                  ? {
                      objectiveKind:
                        latestExecuteRecoveryState.decisionCheckpoint.objectiveKind,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.objectiveExpectedTargets
                  ? {
                      objectiveExpectedTargets: [
                        ...latestExecuteRecoveryState.decisionCheckpoint.objectiveExpectedTargets,
                      ],
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.objectiveValidationEvidence !== undefined
                  ? {
                      objectiveValidationEvidence:
                        latestExecuteRecoveryState.decisionCheckpoint.objectiveValidationEvidence
                          ? {
                              ...latestExecuteRecoveryState.decisionCheckpoint.objectiveValidationEvidence,
                            }
                          : null,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.browserFailureFingerprint
                  ? {
                      browserFailureFingerprint:
                        latestExecuteRecoveryState.decisionCheckpoint.browserFailureFingerprint,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.browserFailureCallSignature
                  ? {
                      browserFailureCallSignature:
                        latestExecuteRecoveryState.decisionCheckpoint.browserFailureCallSignature,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.browserFailureDetail
                  ? {
                      browserFailureDetail:
                        latestExecuteRecoveryState.decisionCheckpoint.browserFailureDetail,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.browserFailedLocator
                  ? {
                      browserFailedLocator:
                        latestExecuteRecoveryState.decisionCheckpoint.browserFailedLocator,
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.browserLocatorCandidates?.length
                  ? {
                      browserLocatorCandidates: [
                        ...latestExecuteRecoveryState.decisionCheckpoint.browserLocatorCandidates,
                      ],
                    }
                  : {}),
                ...(latestExecuteRecoveryState?.decisionCheckpoint?.browserRequestedUrl
                  ? {
                      browserRequestedUrl:
                        latestExecuteRecoveryState.decisionCheckpoint.browserRequestedUrl,
                    }
                  : {}),
              },
        };
        const notice = shouldAutoResume
          ? buildExecuteMaxIterationsAutoResumeNotice(effectiveCheckpoint, phaseLanguage)
          : buildExecuteMaxIterationsPauseNotice(effectiveCheckpoint, phaseLanguage);

        appendDebugLog(
          shouldAutoResume ? "info" : "warn",
          shouldAutoResume
            ? "execute.max_iterations_auto_resume_pending"
            : "execute.max_iterations_paused",
          {
            turnId,
            uiDisplayTurnId: context.uiDisplayTurnId,
            checkpoint: effectiveCheckpoint,
            executeRecoveryDecision,
            forcedExecuteRecoveryState,
            notice,
          },
        );
        sessionSet((state: any) => ({
          planAutoResumeCount: currentCount,
          conversationTurns: state.conversationTurns.map((turn: any) =>
            turn.id === turnId || turn.id === context.uiDisplayTurnId
              ? { ...turn, collapsed: false }
              : turn
          ),
        }));

        if (!shouldAutoResume) {
          const visibleNotice = phaseLanguage === "zh"
            ? "执行已暂停：本轮达到安全边界。MAIN 已保留当前 workspace 状态；可继续执行以从这里恢复。"
            : "Execution paused after reaching the safety boundary. MAIN kept the current workspace state; continue execution to resume from here.";
          appendTurnBlock({
            id: sessionGet()._nextTaskId(),
            turnId: context.uiDisplayTurnId,
            type: "system",
            content: notice,
            variant: "execution_checkpoint",
          });
          sessionGet().setConversationTurnSummary(
            context.uiDisplayTurnId,
            visibleNotice,
          );
          logStoreEvent("execute_max_iterations_paused", {
            autoResumeCount: currentCount,
            maxIterations: checkpoint.maxIterations,
            reason: checkpoint.autoResumeEligible
              ? "auto_resume_limit_reached"
              : "strategy_pivots_exhausted_or_blocked",
          });
          return true;
        }

        logStoreEvent("execute_max_iterations_auto_resume_pending", {
          autoResumeCount: effectiveCheckpoint.autoResumeCount,
          maxIterations: checkpoint.maxIterations,
          strategyPivot: effectiveCheckpoint.strategyPivot,
          attemptedStrategyPivots: effectiveCheckpoint.attemptedStrategyPivots,
        });
        const cancelAutoResume = (reason: string, options?: { visible?: boolean }) => {
          const latest = sessionGet();
          const latestSessionKey = resolveSessionRuntimeKey(
            resolveSessionWorkspaceKey(latest.currentWorkspace),
            latest.currentSessionId,
          );
          if (latestSessionKey !== runSessionKey) return;
          const pauseCheckpoint = {
            ...effectiveCheckpoint,
            autoResumeCount: currentCount,
          };
          const pauseNotice = buildExecuteMaxIterationsPauseNotice(
            pauseCheckpoint,
            phaseLanguage,
          );
          const cancellationNotice = options?.visible
            ? pauseNotice
            : phaseLanguage === "zh"
              ? "自动续跑已取消：新的用户消息或运行时交接优先。"
              : "Auto-resume was canceled because a newer user message or runtime handoff took priority.";
          sessionSet((state: any) => ({
            planAutoResumeCount: currentCount,
            conversationTurns: state.conversationTurns.map((turn: any) =>
              turn.id === turnId || turn.id === context.uiDisplayTurnId
                ? { ...turn, collapsed: false }
                : turn
            ),
            runtimeEvents: state.runtimeEvents.map((event: any) =>
              event.type === "run.paused" &&
              event.runId === activeRuntimeRunIdentity.runId &&
              event.reason === "max_iterations_auto_resume"
                ? {
                    ...event,
                    reason: "max_iterations_auto_resume_canceled",
                    message: cancellationNotice,
                  }
                : event
            ),
          }));
          logStoreEvent("execute_max_iterations_auto_resume_canceled", {
            reason,
            autoResumeCount: currentCount,
            maxIterations: checkpoint.maxIterations,
          });
          if (options?.visible) {
            appendTurnBlock({
              id: sessionGet()._nextTaskId(),
              turnId: context.uiDisplayTurnId,
              type: "system",
              content: pauseNotice,
              variant: "execution_checkpoint",
            });
            sessionGet().setConversationTurnSummary(
              context.uiDisplayTurnId,
              phaseLanguage === "zh"
                ? "自动续跑未能启动，已安全暂停；可继续执行以重试。"
                : "Auto-resume could not start and paused safely; continue execution to retry.",
            );
          }
        };
        pendingMaxIterationsAutoResume = {
          kind: "execute",
          cancel: cancelAutoResume,
          start: () => {
            const latest = sessionGet();
            const latestSessionKey = resolveSessionRuntimeKey(
              resolveSessionWorkspaceKey(latest.currentWorkspace),
              latest.currentSessionId,
            );
            if (latestSessionKey !== runSessionKey) return;
            if (
              latest.isGenerating ||
              latest.agentStatus === "running" ||
              latest.agentStatus === "pending_review"
            ) {
              logStoreEvent("execute_max_iterations_auto_resume_skipped", {
                reason: "newer_run_active",
                agentStatus: latest.agentStatus,
                isGenerating: latest.isGenerating,
              });
              return;
            }

            sessionSet((state: any) => ({
              planAutoResumeCount: effectiveCheckpoint.autoResumeCount,
              conversationTurns: state.conversationTurns.map((turn: any) =>
                turn.id === turnId || turn.id === context.uiDisplayTurnId
                  ? { ...turn, status: "executing" }
                  : turn
              ),
            }));
            let started = false;
            try {
              started = latest.sendMessage(
                buildExecuteMaxIterationsResumePrompt({
                  language: phaseLanguage,
                  checkpoint: effectiveCheckpoint,
                }),
                undefined,
                {
                  hidden: true,
                  reuseCurrentTurn: true,
                  turnIdOverride: context.uiDisplayTurnId || turnId,
                  preservePlanState: true,
                  resolvedIntent: "execute",
                  forceExecuteRecoveryMode: executeRecoveryDecision.mode,
                  forceExecuteRecoveryState: forcedExecuteRecoveryState,
                  executionConsentGranted: true,
                  parentRunIdOverride: activeRuntimeRunIdentity.runId,
                  skipIntentResolution: true,
                  turnTitle: phaseLanguage === "zh"
                    ? "执行自动恢复"
                    : "Execution Auto-Resume",
                  intentSummary: phaseLanguage === "zh"
                    ? `执行达到安全轮次边界后切换策略：${effectiveCheckpoint.strategyPivot}。`
                    : `Switch strategy after the execution safety boundary: ${effectiveCheckpoint.strategyPivot}.`,
                },
              ) === true;
            } catch (error) {
              logStoreEvent("execute_max_iterations_auto_resume_submission_failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
            if (started) {
              logStoreEvent("execute_max_iterations_auto_resume_dispatched", {
                autoResumeCount: effectiveCheckpoint.autoResumeCount,
                parentRunId: activeRuntimeRunIdentity.runId,
              });
            } else {
              cancelAutoResume("resume_submission_rejected", { visible: true });
            }
          },
        };
        return {
          status: "auto_resume_scheduled" as const,
          checkpoint: effectiveCheckpoint,
        };
      },

      onStatusChange: (status: "idle" | "running" | "pending_review" | "error") => {
        if (status === "idle" || status === "error") {
          const publicationDecision = terminalStatusPublicationGate.requestStatus(
            "idle",
            activeRuntimeRunIdentity.runId,
          );
          logStoreEvent("terminal_idle_notification_deferred", {
            sessionKey: runSessionKey,
            turnId,
            runId: activeRuntimeRunIdentity.runId,
            requestedStatus: status,
            deferredIdleCount: publicationDecision.deferredIdleCount,
          });
          return;
        }
        const publicationDecision = terminalStatusPublicationGate.requestStatus(
          status,
          activeRuntimeRunIdentity.runId,
        );
        if (!publicationDecision.publishNow) {
          logStoreEvent("stale_runtime_status_publication_skipped", {
            sessionKey: runSessionKey,
            turnId,
            runId: activeRuntimeRunIdentity.runId,
            requestedStatus: status,
          });
          return;
        }
        const latest = sessionGet();
        const planApprovalIdentity = status === "pending_review"
          ? buildPlanApprovalIdentity(latest.planArtifacts)
          : null;
        const shouldMarkPlanAwaitingApproval =
          status === "pending_review" &&
          getIntentPolicy(latest.getCurrentRunIntent()).workflowMode === "plan" &&
          latest.isPlanApproved !== true &&
          isReviewablePlanStage(latest.planStage) &&
          !!planApprovalIdentity;
        if (shouldMarkPlanAwaitingApproval && planApprovalIdentity) {
          const existing = latest.activeActionRequest;
          const sameReviewRequest =
            existing?.kind === "plan_review" &&
            existing.status === "pending" &&
            isActionRequestOwnedByRun(existing, {
              sessionKey: runSessionKey,
              turnId,
              runId: activeRuntimeRunIdentity.runId,
            }) &&
            existing.planRevision === planApprovalIdentity.revision &&
            existing.artifactHash === planApprovalIdentity.artifactHash;
          if (!sameReviewRequest) {
            const request = buildPlanReviewActionRequest({
              sessionKey: runSessionKey,
              turnId,
              runId: activeRuntimeRunIdentity.runId,
              parentRunId: activeRuntimeRunIdentity.parentRunId,
              title: resolveCurrentTurnTitle(),
              planRevision: planApprovalIdentity.revision,
              artifactHash: planApprovalIdentity.artifactHash,
              artifactPaths: planApprovalIdentity.artifactPaths,
            });
            publishActionRequest(request, {
              reason: "plan_review",
              target: planApprovalIdentity.artifactPaths.join(", "),
              pauseMessage: phaseLanguage === "zh"
                ? "计划产物已物化并通过校验，等待审核。"
                : "The materialized plan passed validation and is awaiting review.",
            });
          }
        }
        sessionSet((s: any) => ({
          agentStatus: status,
          isGenerating: status === "running",
          ...(status === "running" && isUnapprovedPlanRuntime()
            ? {
                conversationTurns: s.conversationTurns.map((turn: any) =>
                  turn.id === turnId &&
                  turn.status !== "awaiting_input" &&
                  turn.status !== "awaiting_approval"
                    ? { ...turn, status: "planning" }
                    : turn
                ),
              }
            : {}),
          ...(shouldMarkPlanAwaitingApproval
            ? {
                conversationTurns: s.conversationTurns.map((turn: any) =>
                  turn.id === turnId ? { ...turn, status: "awaiting_approval" } : turn
                ),
              }
            : {}),
        }));
      },

      onError: (error: string) => {
        appendTurnBlock({
          id: sessionGet()._nextTaskId(),
          turnId,
          type: "system",
          content: `❌ 出错了：${error}`,
        });
      },

      onNonActionableStop: (message: string, reason: "no_output" | "no_action" | "missing_tool_loop" | "incomplete_plan", progress?: Partial<PlanExecutionProgressUpdate>) => {
        lastNonActionableStopDiagnostic = {
          reason,
          recoveryReason: progress?.recoveryReason || null,
          phase: progress?.phase || null,
          nextStep: progress?.nextStep || null,
          repeatedTargets: progress?.repeatedTargets || [],
        };
        logStoreEvent("non_actionable_stop", {
          reason,
          recoveryReason: progress?.recoveryReason || null,
          phase: progress?.phase || null,
          nextStep: progress?.nextStep || null,
          repeatedTargets: progress?.repeatedTargets || [],
          messageChars: message.length,
          messagePreview: message.replace(/\s+/g, " ").slice(0, 260),
        });
        const isDurableRecoveryPause =
          (
            progress?.recoveryReason === "execute_recovery_no_progress_limit" &&
            getScopedDurableMutationEvidence().length > 0
          ) || progress?.recoveryReason === "execute_no_progress_batch_loop";
        if (isDurableRecoveryPause) {
          const previous = sessionGet().planExecutionProgressSnapshot;
          emitLocalPlanExecutionProgress("paused", {
            iteration: progress?.iteration ?? previous?.iteration ?? 0,
            maxIterations:
              progress?.maxIterations ??
              previous?.maxIterations ??
              PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
            currentTaskId: progress?.currentTaskId ?? previous?.currentTaskId,
            currentTask: progress?.currentTask ?? previous?.currentTask,
            currentTool: progress?.currentTool ?? previous?.currentTool,
            latestEvidence: progress?.latestEvidence ?? previous?.latestEvidence,
            nextStep: progress?.nextStep ?? previous?.nextStep ?? message,
            progressSignature:
              progress?.progressSignature ?? previous?.progressSignature,
            lastEffectiveEvidenceAt:
              progress?.lastEffectiveEvidenceAt ?? previous?.lastEffectiveEvidenceAt,
            recoveryReason:
              progress?.recoveryReason ?? previous?.recoveryReason,
            repeatedTargets:
              progress?.repeatedTargets ?? previous?.repeatedTargets,
          });
        }
        const isPlanGenerationFailure =
          reason === "incomplete_plan" && progress?.recoveryReason === "plan_generation_failed";
        sessionSet((s: any) => {
          const currentStreamingBlockId = context.currentStreamingBlockId;
          const currentThoughtBlockId = context.currentThoughtBlockId;
          let taskFlow = s.taskFlow;

          if (currentStreamingBlockId !== null) {
            taskFlow = taskFlow.map((t: any) => {
              if (t.id === currentStreamingBlockId && t.type === "agent") {
                const existingAttempts = t.failedAttempts || [];
                const agentContent = t.content || "";

                // Get corresponding thought/reasoning content if available
                const thoughtBlock = s.taskFlow.find((tb: any) => tb.id === currentThoughtBlockId && tb.type === "thought");
                const thoughtContent = thoughtBlock ? thoughtBlock.content : "";

                return {
                  ...t,
                  content: isPlanGenerationFailure ? agentContent : `❌ **${message}**`,
                  streaming: false,
                  failedAttempts: [
                    ...existingAttempts,
                    {
                      content: agentContent,
                      reasoning: thoughtContent,
                      reason: reason,
                      timestamp: Date.now(),
                    }
                  ]
                };
              }
              if (t.id === currentThoughtBlockId && t.type === "thought") {
                return { ...t, isStreaming: false };
              }
              return t;
            });
          }
          const stopBlock = {
            id: sessionGet()._nextTaskId(),
            turnId,
            type: "system",
            content: message,
            variant: isPlanGenerationFailure ? "plan_quality_gate" : "execution_checkpoint",
            ...(progress ? { planExecutionProgress: progress } : {}),
          } as TaskBlock;
          taskFlow = [...taskFlow, stopBlock];

          return {
            taskFlow,
            conversationTurns: s.conversationTurns.map((turn: any) =>
              turn.id === turnId && turn.status !== "awaiting_approval"
                ? {
                    ...turn,
                    // A held model draft cannot own terminal presentation.
                    // Persist the runtime-owned evidence checkpoint so a
                    // paused turn remains understandable after reload.
                    summary: message,
                    blockIds: Array.from(new Set([
                      ...turn.blockIds,
                      ...taskFlow
                        .filter((block: any) => block.turnId === turnId)
                        .map((block: any) => block.id),
                    ])),
                  }
                : turn
            ),
          };
        });
      },

      onPlanArtifactUpdated: (path: string, content: string, kind: "plan" | "requirements" | "design" | "tasks" | "bugfix") => {
        const wasApproved = sessionGet().isPlanApproved === true;
        const previousIdentity = buildPlanApprovalIdentity(sessionGet().planArtifacts);
        sessionGet().upsertPlanArtifact({
          kind,
          path,
          title: getPlanArtifactTitle(kind, sessionGet().config.language === "en" ? "en" : "zh"),
          content,
          updatedAt: Date.now(),
        });
        const nextIdentity = buildPlanApprovalIdentity(sessionGet().planArtifacts);
        if (
          wasApproved &&
          kind !== "tasks" &&
          previousIdentity?.artifactHash &&
          nextIdentity?.artifactHash &&
          previousIdentity.artifactHash !== nextIdentity.artifactHash
        ) {
          callbacks.onPlanApprovalInvalidated?.("approved_plan_artifact_revision_changed");
        }
      },

      onPlanArtifactRejected: (path, kind, reason) => {
        const canonicalPath = canonicalizePlanArtifactPath(path);
        const liveBeforeRejection = sessionGet();
        const rejectedApprovedArtifact = liveBeforeRejection.planArtifacts.find(
          (artifact: any) => canonicalizePlanArtifactPath(artifact.path) === canonicalPath,
        );
        const pendingApprovedReviewOwnsPath =
          liveBeforeRejection.activeActionRequest?.kind === "plan_review" &&
          liveBeforeRejection.activeActionRequest.artifactPaths.some(
            (artifactPath: string) => canonicalizePlanArtifactPath(artifactPath) === canonicalPath,
          );
        const pendingPlanToolOwnsExecution =
          liveBeforeRejection.activeActionRequest?.kind === "tool_permission" &&
          !!liveBeforeRejection.activeActionRequest.planExecution;
        const invalidatesApprovedExecution =
          (
            liveBeforeRejection.isPlanApproved === true ||
            !!liveBeforeRejection.planLifecycle?.approvalLease ||
            pendingPlanToolOwnsExecution
          ) &&
          (kind === "plan" || kind === "design" || kind === "bugfix") &&
          (!!rejectedApprovedArtifact || pendingApprovedReviewOwnsPath);

        const invalidatedPlanToolReviewRef: {
          current: PendingPlanToolPermissionInvalidation | null;
        } = { current: null };
        sessionSet((state: any) => {
          const rejectedArtifact = state.planArtifacts.find(
            (artifact: any) => canonicalizePlanArtifactPath(artifact.path) === canonicalPath,
          );
          const pendingReviewOwnsPath =
            state.activeActionRequest?.kind === "plan_review" &&
            state.activeActionRequest.artifactPaths.some(
              (artifactPath: string) => canonicalizePlanArtifactPath(artifactPath) === canonicalPath,
            );
          if (!rejectedArtifact && !pendingReviewOwnsPath) return {};

          const nextArtifacts = state.planArtifacts.filter(
            (artifact: any) => canonicalizePlanArtifactPath(artifact.path) !== canonicalPath,
          );
          const artifactKinds = new Set(nextArtifacts.map((artifact: any) => artifact.kind));
          const preserveApprovedTasksExecutionStage =
            kind === "tasks" &&
            state.isPlanApproved === true &&
            (state.planStage === "ready_to_execute" ||
              state.planStage === "executing" ||
              state.planStage === "completed");
          const nextStage = preserveApprovedTasksExecutionStage
            ? state.planStage
            : artifactKinds.has("tasks")
            ? (state.planTasks.length > 0 ? "ready_to_execute" : "tasks")
            : artifactKinds.has("bugfix")
            ? "bugfix"
            : artifactKinds.has("plan")
            ? "plan"
            : artifactKinds.has("design")
            ? "design"
            : artifactKinds.has("requirements")
            ? "requirements"
            : "idle";
          const invalidatesApproval =
            state.isPlanApproved === true &&
            (kind === "plan" || kind === "design" || kind === "bugfix");
          const nextPlanLifecycle = applyPlanArtifactIdentity({
            lifecycle: state.planLifecycle,
            sessionKey: runSessionKey,
            artifactIdentity: toWorkflowPlanArtifactIdentity(
              buildPlanApprovalIdentity(nextArtifacts),
            ),
            at: Date.now(),
          });
          const lifecycleApprovalInvalidated = Boolean(
            state.planLifecycle?.approvalLease && !nextPlanLifecycle.approvalLease,
          );
          const shouldRevokeApproval = invalidatesApproval || lifecycleApprovalInvalidated;
          const planToolInvalidation = buildPendingPlanToolPermissionInvalidation(
            state,
            shouldRevokeApproval,
          );
          invalidatedPlanToolReviewRef.current = planToolInvalidation;
          logStoreEvent("plan_artifact_rejection_invalidated_state", {
            path: canonicalPath,
            reportedPath: path,
            kind,
            reason,
            removedExistingArtifact: !!rejectedArtifact,
            clearedPlanReviewRequest: pendingReviewOwnsPath,
            invalidatedApproval: shouldRevokeApproval,
            preservedApprovedTasksExecutionStage: preserveApprovedTasksExecutionStage,
            nextStage,
          });
          return {
            planLifecycle: nextPlanLifecycle,
            planArtifacts: nextArtifacts,
            planStage: nextStage,
            showPlanPanel: nextArtifacts.length > 0 && state.showPlanPanel,
            ...(pendingReviewOwnsPath ? { activeActionRequest: null } : {}),
            ...(planToolInvalidation?.patch || {}),
            ...(shouldRevokeApproval
              ? {
                  isPlanApproved: false,
                  planApprovalChoice: null,
                  pendingPlanApprovalHandoff: null,
                  planApprovalExecutionStartedForTurnId: null,
                  planTasks: [],
                  planExecutionEvidenceLedger: [],
                  planExecutionEvidenceCount: 0,
                  planExecutionProgressSnapshot: null,
                }
              : {}),
          };
        });
        const invalidatedPlanToolReview = invalidatedPlanToolReviewRef.current;
        if (invalidatedPlanToolReview) {
          const settled = settlePendingPlanToolPermissionInvalidation(
            invalidatedPlanToolReview,
          );
          logStoreEvent("plan_tool_permission_invalidated_by_artifact_rejection", {
            requestId: invalidatedPlanToolReview.requestId,
            taskId: invalidatedPlanToolReview.taskId,
            sessionKey: runSessionKey,
            path: canonicalPath,
            settled,
          });
        }

        // A rejected rewrite of an already-approved artifact invalidates the
        // active execution lease. Reuse the central invalidation boundary so
        // the run is paused, the old approval is cleared, and any surviving
        // reviewable revision receives a fresh identity before execution can
        // continue in a child run.
        if (invalidatesApprovedExecution) {
          callbacks.onPlanApprovalInvalidated?.("approved_plan_artifact_quality_rejected");
        }
      },

      onPlanStageChanged: (stage: "idle" | "plan" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed") => {
        if (stage !== "completed") {
          sessionSet({ planStage: stage });
          return;
        }
        logStoreEvent("plan_completion_declared", {
          sessionKey: runSessionKey,
          turnId,
          runId: activeRuntimeRunIdentity.runId,
          note: "canonical_projection_deferred_to_terminal_transaction",
        });
      },

      onPlanApprovalInvalidated: (reason: string) => {
        const currentIdentity = buildPlanApprovalIdentity(sessionGet().planArtifacts);
        sessionSet((state: any) => {
          const planLifecycle = applyPlanArtifactIdentity({
            lifecycle: state.planLifecycle,
            sessionKey: runSessionKey,
            artifactIdentity: toWorkflowPlanArtifactIdentity(currentIdentity),
            at: Date.now(),
          });
          return {
            planLifecycle,
            isPlanApproved: false,
            planApprovalChoice: null,
            pendingPlanApprovalHandoff: null,
            planApprovalExecutionStartedForTurnId: null,
            currentTurnExecutionConsent: { turnId: null, granted: false },
            activeActionRequest: null,
            planExecutionEvidenceLedger: [],
            planExecutionEvidenceCount: 0,
            planAutoResumeCount: 0,
            planExecutionProgressSnapshot: null,
            ...(currentIdentity
              ? { agentStatus: "pending_review", isGenerating: false }
              : {}),
            conversationTurns: state.conversationTurns.map((candidate: any) =>
              candidate.id === turnId
                ? {
                    ...candidate,
                    ...(currentIdentity ? { status: "awaiting_approval" as const } : {}),
                    summary: phaseLanguage === "zh"
                      ? "计划内容在批准后发生变化，旧批准已失效。"
                      : "The plan changed after review, so the previous approval is stale.",
                  }
                : candidate
            ),
          };
        });
        if (currentIdentity) {
          const request = buildPlanReviewActionRequest({
            sessionKey: runSessionKey,
            turnId,
            runId: activeRuntimeRunIdentity.runId,
            parentRunId: activeRuntimeRunIdentity.parentRunId,
            title: resolveCurrentTurnTitle(),
            planRevision: currentIdentity.revision,
            artifactHash: currentIdentity.artifactHash,
            artifactPaths: currentIdentity.artifactPaths,
          });
          publishActionRequest(request, {
            reason: "plan_revision_changed",
            target: currentIdentity.artifactPaths.join(", "),
            pauseMessage: phaseLanguage === "zh"
              ? "计划内容已变化，旧批准失效；请审核新的修订。"
              : "The plan changed, invalidating the old approval; review the new revision.",
          });
        }
        abortCtrl.abort();
        logStoreEvent("plan_approval_invalidated", {
          sessionKey: runSessionKey,
          turnId,
          runId: activeRuntimeRunIdentity.runId,
          planRevision: currentIdentity?.revision || null,
          reason,
        });
      },

      onPlanTasksUpdated: (content: string) => {
        sessionGet().setPlanTasks(extractPlanTasks(content));
      },

      onTurnSummaryReady: (summary: string) => {
        if (isUnapprovedPlanRuntime() || context.executionEvidenceDraftHeld) return;
        sessionSet((s: any) => ({
          conversationTurns: s.conversationTurns.map((turn: any) =>
            turn.id === turnId ? { ...turn, summary } : turn
          ),
        }));
      },

      appendMessage: (msg: any) => {
        sessionSet((s: any) => ({ agentMessages: [...s.agentMessages, msg] }));
      },

      replaceMessages: (msgs: any[]) => {
        sessionSet({ agentMessages: msgs });
      },

      onContextCompress: (stats: any, reason: "proactive" | "reactive" | "execute_recovery") => {
        logStoreEvent("context_compress", { stats, reason });
      },
    };

    callbacks.runSubagent = (request, runOptions) => {
      const parentTurnId = context.uiDisplayTurnId || turnId;
      const existingRunCount = getCoordinatedSubagentRunCount(runSessionKey, parentTurnId);
      const allowedPaths = parseSubagentAllowedPaths(request.allowedPaths, runWorkspace);
      const duplicateCount = countParentObservedDelegationPaths({
        allowedPaths,
        evidenceKeys: getSessionTaskTargetingEvidence(runSessionKey),
      });
      const independentReviewer = /reviewer|independent[_ -]?review/i.test(request.role || "");
      if (!independentReviewer && allowedPaths.length > 0 && duplicateCount / allowedPaths.length > 0.5) {
        const deferred = buildSubagentPolicyDeferral({
          name: request.name,
          scopeKey: request.scopeKey || request.scope || request.objective,
          reason: "parent_scope_already_observed",
        });
        callbacks.onDebugEvent?.("delegation_scope_decision", {
          decision: "deferred",
          reason: deferred.reason,
          allowedPaths,
          duplicateCount,
          failureKind: "policy",
        });
        return Promise.resolve(deferred);
      }
      return Promise.resolve(scheduleControlledSubagent({
        request,
        parentCallbacks: callbacks,
        parentTurnId,
        parentSignal: runOptions?.signal || abortCtrl.signal,
        existingRunCount,
        emitEvent: (event) => {
          sessionSet((state: any) => ({
            runtimeEvents: appendRuntimeEvent(state.runtimeEvents, event),
          }));
        },
        executeAgentLoop,
      }));
    };
    callbacks.getPendingSubagentIds = () => getPendingCoordinatedSubagentIds(
      runSessionKey,
      context.uiDisplayTurnId || turnId,
    );
    callbacks.waitSubagents = async (request) => {
      const parentTurnId = context.uiDisplayTurnId || turnId;
      const waitStartedAt = Date.now();
      callbacks.onDebugEvent?.("parent_wait", {
        subagentIds: request.subagentIds || [],
        parentTurnId,
      });
      const result = await waitForCoordinatedSubagents({
        threadId: runSessionKey,
        parentTurnId,
        subagentIds: request.subagentIds,
      });
      callbacks.onDebugEvent?.("parent_resume", {
        subagentIds: result.results.map((entry) => entry.subagentId),
        statuses: result.results.map((entry) => entry.status),
        parentTurnId,
        parentBlockedMs: Math.max(0, Date.now() - waitStartedAt),
      });
      callbacks.onDebugEvent?.("coordinated_run_released", {
        parentTurnId,
        releasedIds: result.results.map((entry) => entry.subagentId),
        releasedCount: result.results.length,
      });
      return result;
    };

    type TerminalStateAccess = {
      get: () => any;
      set: (patchOrUpdater: any) => void;
    };
    const liveTerminalStateAccess: TerminalStateAccess = {
      get: sessionGet,
      set: sessionSet,
    };
    const createTerminalDraftAccess = (initialState: any) => {
      let draftState = initialState;
      const access: TerminalStateAccess & { snapshot: () => any } = {
        get: () => draftState,
        set: (patchOrUpdater: any) => {
          const patch = typeof patchOrUpdater === "function"
            ? patchOrUpdater(draftState)
            : patchOrUpdater;
          if (patch && typeof patch === "object") {
            draftState = { ...draftState, ...patch };
          }
        },
        snapshot: () => draftState,
      };
      return access;
    };

    let completedTurnHasChanges = false;
    const ensureCompletedTurnFinalPresentation = (
      outcome: AgentLoopOutcome,
      access: TerminalStateAccess = liveTerminalStateAccess,
    ): string | null => {
      if (outcome.status !== "completed") return null;
      const current = access.get();
      const terminalOwnership = resolveTerminalTurnOwnership({
        turnId,
        uiDisplayTurnId: context.uiDisplayTurnId,
      });
      const terminalTurnIds = new Set(terminalOwnership.evidenceTurnIds);
      const presentationTurn = current.conversationTurns.find((candidate: any) =>
        candidate.id === terminalOwnership.ownerTurnId
      ) || current.conversationTurns.find((candidate: any) => candidate.id === turnId);
      const presentationTurnId = presentationTurn?.id || terminalOwnership.ownerTurnId;
      const turnBlocks = current.taskFlow.filter((block: TaskBlock) =>
        !!block.turnId && terminalTurnIds.has(block.turnId)
      );
      const isPlanTurn = presentationTurn?.mode === "plan" || presentationTurn?.intent === "plan";
      const planTerminalProjection = isPlanTurn
        ? collectPlanTaskTerminalProjection({
            tasks: current.planTasks || [],
            evidenceLedger: current.planExecutionEvidenceLedger || [],
            availableToolNames: terminalAvailableToolNames,
          })
        : { blocking: [], advisories: [] };
      const finalPresentation = resolveCompletedTurnFinalPresentation({
        turnBlocks,
        publishedModelFinalText: publishedCompletedAssistantFinalText,
        artifactPaths: isPlanTurn
          ? (current.planArtifacts || []).map((artifact: any) => artifact.path)
          : [],
        unfinished: planTerminalProjection.blocking,
        advisories: planTerminalProjection.advisories,
        language: (current.preferredResponseLanguage || current.config.language) === "en" ? "en" : "zh",
      });
      completedTurnHasChanges = finalPresentation.hasChanges;

      const matchingPublishedBlock = publishedCompletedAssistantFinalText
        ? [...turnBlocks].reverse().find((block: TaskBlock) =>
            block.turnId === presentationTurnId &&
            block.type === "agent" &&
            block.hiddenProcess !== true &&
            block.streaming !== true &&
            String(block.content || "").trim() === publishedCompletedAssistantFinalText
          )
        : null;
      const existingTerminalFinalBlock = [...turnBlocks].reverse().find((block: TaskBlock) =>
        block.turnId === presentationTurnId &&
        block.type === "agent" &&
        block.visibility === "assistant_final"
      );
      const reusableFinalBlock = matchingPublishedBlock || existingTerminalFinalBlock || null;
      const finalBlockId = reusableFinalBlock?.id ?? current._nextTaskId();
      access.set((state: any) => {
        let taskFlow = state.taskFlow.map((block: TaskBlock) => {
          if (
            block.type === "agent" &&
            terminalTurnIds.has(block.turnId || "") &&
            block.visibility === "assistant_final" &&
            block.id !== finalBlockId
          ) {
            return { ...block, visibility: "assistant_update" as const };
          }
          return block.id === finalBlockId && block.type === "agent"
            ? {
                ...block,
                content: finalPresentation.text,
                streaming: false,
                hiddenProcess: false,
                visibility: "assistant_final" as const,
                turnPhase: withTurnRuntimePhaseStatus(block.turnPhase, "done", phaseLanguage),
              }
            : block;
        });
        if (!reusableFinalBlock) {
          taskFlow = [...taskFlow, {
            id: finalBlockId,
            turnId: presentationTurnId,
            type: "agent" as const,
            content: finalPresentation.text,
            streaming: false,
            visibility: "assistant_final" as const,
          }];
        }
        return {
          taskFlow,
          conversationTurns: state.conversationTurns.map((candidate: any) =>
            terminalTurnIds.has(candidate.id)
              ? {
                  ...candidate,
                  summary: finalPresentation.text,
                  blockIds: candidate.id === presentationTurnId && !candidate.blockIds.includes(finalBlockId)
                    ? [...candidate.blockIds, finalBlockId]
                    : candidate.blockIds,
                }
              : candidate
          ),
        };
      });
      logStoreEvent("completed_turn_final_presentation_staged", {
        source: finalPresentation.source,
        finalChars: finalPresentation.text.length,
        modifiedFiles: finalPresentation.execution.modifiedFiles,
        validations: finalPresentation.execution.validations,
        failures: finalPresentation.execution.failures,
        unfinished: finalPresentation.execution.unfinished,
        advisories: finalPresentation.execution.advisories,
      });
      return finalPresentation.text;
    };

    const ensureClosedTurnConclusion = (
      outcome: AgentLoopOutcome,
      access: TerminalStateAccess = liveTerminalStateAccess,
    ): string | null => {
      const resultKind = outcome.status === "aborted"
        ? "canceled"
        : outcome.status === "completed"
        ? outcome.resultKind
        : null;
      if (resultKind !== "error" && resultKind !== "blocked" && resultKind !== "canceled") {
        return null;
      }
      const current = access.get();
      const terminalOwnership = resolveTerminalTurnOwnership({
        turnId,
        uiDisplayTurnId: context.uiDisplayTurnId,
      });
      const terminalTurnIds = new Set(terminalOwnership.evidenceTurnIds);
      const presentationTurn = current.conversationTurns.find((candidate: any) =>
        candidate.id === terminalOwnership.ownerTurnId
      ) || current.conversationTurns.find((candidate: any) => candidate.id === turnId);
      const presentationTurnId = presentationTurn?.id || terminalOwnership.ownerTurnId;
      const language = (current.preferredResponseLanguage || current.config.language) === "en"
        ? "en"
        : "zh";
      const reason = String(outcome.reason || "").trim() || (language === "en" ? "Unknown reason" : "未知原因");
      const conclusion = language === "en"
        ? resultKind === "canceled"
          ? `This turn was canceled and is now closed. ${reason}`
          : resultKind === "blocked"
          ? `This turn is complete with a blocked result. ${reason}`
          : `This turn is complete, but MAIN could not finish the requested work. ${reason}`
        : resultKind === "canceled"
        ? `本回合已取消并完成收口。${reason}`
        : resultKind === "blocked"
        ? `本回合已完成收口，但结果受到阻塞。原因：${reason}`
        : `本回合已完成收口，但 MAIN 未能完成所请求的工作。原因：${reason}`;
      const turnBlocks = current.taskFlow.filter((block: TaskBlock) =>
        !!block.turnId && terminalTurnIds.has(block.turnId)
      );
      const existingTerminalFinalBlock = [...turnBlocks].reverse().find((block: TaskBlock) =>
        block.type === "agent" && block.visibility === "assistant_final"
      );
      const finalBlockId = existingTerminalFinalBlock?.id ?? current._nextTaskId();
      access.set((state: any) => {
        let foundFinal = false;
        let taskFlow = state.taskFlow.map((block: TaskBlock) => {
          if (block.id === finalBlockId && block.type === "agent") {
            foundFinal = true;
            return {
              ...block,
              content: conclusion,
              streaming: false,
              hiddenProcess: false,
              visibility: "assistant_final" as const,
              turnPhase: withTurnRuntimePhaseStatus(block.turnPhase, "done", phaseLanguage),
            };
          }
          if (
            block.type === "agent" &&
            terminalTurnIds.has(block.turnId || "") &&
            block.visibility === "assistant_final"
          ) {
            return { ...block, visibility: "assistant_update" as const };
          }
          return block;
        });
        if (!foundFinal) {
          taskFlow = [...taskFlow, {
            id: finalBlockId,
            turnId: presentationTurnId,
            type: "agent" as const,
            content: conclusion,
            streaming: false,
            visibility: "assistant_final" as const,
          }];
        }
        return {
          taskFlow,
          conversationTurns: state.conversationTurns.map((candidate: any) =>
            terminalTurnIds.has(candidate.id)
              ? {
                  ...candidate,
                  summary: conclusion,
                  blockIds: candidate.id === presentationTurnId && !candidate.blockIds.includes(finalBlockId)
                    ? [...candidate.blockIds, finalBlockId]
                    : candidate.blockIds,
                }
              : candidate
          ),
        };
      });
      completedTurnHasChanges = getScopedDurableMutationEvidence().length > 0;
      logStoreEvent("closed_turn_conclusion_staged", {
        outcomeStatus: outcome.status,
        resultKind,
        finalChars: conclusion.length,
      });
      return conclusion;
    };

    const ensurePausedTurnFinalPresentation = (
      outcome: AgentLoopOutcome,
      access: TerminalStateAccess = liveTerminalStateAccess,
    ): string | null => {
      if (
        outcome.status !== "paused" ||
        (
          outcome.reason !== "execute_recovery_no_progress_limit" &&
          outcome.reason !== "execute_no_progress_batch_loop"
        )
      ) {
        return null;
      }
      const durableMutationEvidence = getScopedDurableMutationEvidence();
      if (
        outcome.reason === "execute_recovery_no_progress_limit" &&
        durableMutationEvidence.length === 0
      ) return null;
      const current = access.get();
      const terminalOwnership = resolveTerminalTurnOwnership({
        turnId,
        uiDisplayTurnId: context.uiDisplayTurnId,
      });
      const terminalTurnIds = new Set(terminalOwnership.evidenceTurnIds);
      const presentationTurn = current.conversationTurns.find((candidate: any) =>
        candidate.id === terminalOwnership.ownerTurnId
      ) || current.conversationTurns.find((candidate: any) => candidate.id === turnId);
      const presentationTurnId = presentationTurn?.id || terminalOwnership.ownerTurnId;
      const turnBlocks = current.taskFlow.filter((block: TaskBlock) =>
        !!block.turnId && terminalTurnIds.has(block.turnId)
      );
      const isPlanTurn = presentationTurn?.mode === "plan" || presentationTurn?.intent === "plan";
      const planTerminalProjection = isPlanTurn
        ? collectPlanTaskTerminalProjection({
            tasks: current.planTasks || [],
            evidenceLedger: current.planExecutionEvidenceLedger || [],
            availableToolNames: terminalAvailableToolNames,
          })
        : { blocking: [], advisories: [] };
      const finalPresentation = resolvePausedTurnFinalPresentation({
        turnBlocks,
        artifactPaths: isPlanTurn
          ? (current.planArtifacts || []).map((artifact: any) => artifact.path)
          : [],
        unfinished: planTerminalProjection.blocking,
        advisories: planTerminalProjection.advisories,
        durableMutationPaths: durableMutationEvidence
          .map((entry) => String(entry.target || entry.value || "").trim())
          .filter(Boolean),
        nextStep: lastNonActionableStopDiagnostic?.nextStep,
        language: (current.preferredResponseLanguage || current.config.language) === "en" ? "en" : "zh",
      });
      const existingTerminalFinalBlock = [...turnBlocks].reverse().find((block: TaskBlock) =>
        block.turnId === presentationTurnId &&
        block.type === "agent" &&
        block.visibility === "assistant_final"
      );
      const finalBlockId = existingTerminalFinalBlock?.id ?? current._nextTaskId();
      access.set((state: any) => {
        let foundFinal = false;
        const taskFlow = state.taskFlow.map((block: TaskBlock) => {
          if (block.id === finalBlockId && block.type === "agent") {
            foundFinal = true;
            return {
              ...block,
              content: finalPresentation.text,
              streaming: false,
              hiddenProcess: false,
              visibility: "assistant_final" as const,
            };
          }
          if (
            block.type === "agent" &&
            terminalTurnIds.has(block.turnId || "") &&
            block.visibility === "assistant_final"
          ) {
            return { ...block, visibility: "assistant_update" as const };
          }
          return block;
        });
        if (!foundFinal) {
          taskFlow.push({
            id: finalBlockId,
            turnId: presentationTurnId,
            type: "agent" as const,
            content: finalPresentation.text,
            streaming: false,
            visibility: "assistant_final" as const,
          });
        }
        return {
          taskFlow,
          conversationTurns: state.conversationTurns.map((candidate: any) =>
            terminalTurnIds.has(candidate.id)
              ? {
                  ...candidate,
                  summary: finalPresentation.text,
                  blockIds: candidate.id === presentationTurnId && !candidate.blockIds.includes(finalBlockId)
                    ? [...candidate.blockIds, finalBlockId]
                    : candidate.blockIds,
                }
              : candidate
          ),
        };
      });
      logStoreEvent("paused_turn_final_presentation_staged", {
        source: finalPresentation.source,
        recoveryReason: outcome.reason,
        finalChars: finalPresentation.text.length,
        modifiedFiles: finalPresentation.execution.modifiedFiles,
        validations: finalPresentation.execution.validations,
        failures: finalPresentation.execution.failures,
        unfinished: finalPresentation.execution.unfinished,
        advisories: finalPresentation.execution.advisories,
        nextStep: lastNonActionableStopDiagnostic?.nextStep || null,
      });
      return finalPresentation.text;
    };

    const projectHarnessForAgentLoopOutcome = (outcome: AgentLoopOutcome): TerminalHarnessProjectionResult => {
      switch (outcome.status) {
        case "completed":
          return projectCurrentHarnessRunMarker("completed", outcome.reason || "agent_loop_completed");
        case "paused":
          return projectCurrentHarnessRunMarker("paused", outcome.reason || "agent_loop_paused");
        case "aborted":
          // Aborted describes why the execution run stopped. The harness lease
          // itself still closes cleanly after the cancellation conclusion is
          // durably committed.
          return projectCurrentHarnessRunMarker("completed", outcome.reason || "agent_loop_aborted");
      }
    };

    const commitTerminalProjectionBeforeStatusPublication = async (
      outcome: AgentLoopOutcome,
      harnessProjection: TerminalHarnessProjectionResult,
      options: { pendingSameTurnExecution?: boolean } = {},
    ): Promise<{ committed: boolean; finalText: string | null }> => {
      if (harnessProjection === "ownership_lost") {
        return { committed: false, finalText: null };
      }
      const requestedHarnessProjection: Exclude<TerminalHarnessProjectionResult, "ownership_lost"> =
        harnessProjection;
      const isSameTurnExecutionContinuation = options.pendingSameTurnExecution === true;
      const terminalTurnIds = new Set([turnId, context.uiDisplayTurnId].filter(Boolean));
      const terminalRunIdentity = { ...activeRuntimeRunIdentity };
      const closesLogicalTurn =
        !isSameTurnExecutionContinuation && outcome.status !== "paused";
      const turnResultKind = outcome.status === "completed"
        ? outcome.resultKind
        : "canceled" as const;
      let committedFinalText: string | null = null;
      let committedTurnStatus = "paused";
      let committedIsIntentionalActionPause = false;
      let committedPendingAction: ActionRequest | null = null;
      const terminalCommitted = await terminalStatusPublicationGate.commitTerminal({
        runKey: terminalRunIdentity.runId,
        persistTerminalProjection: async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const baseRevisionToken = getSessionRevisionToken();
            const baseState = sessionGet();
            if (getSessionRevisionToken() !== baseRevisionToken) {
              logStoreEvent("terminal_projection_retry_after_concurrent_update", {
                sessionKey: runSessionKey,
                turnId,
                runId: terminalRunIdentity.runId,
                attempt: attempt + 1,
                phase: "snapshot",
              });
              continue;
            }
            let attemptHarnessProjection: TerminalHarnessProjectionResult = "absent";
            if (requestedHarnessProjection !== "absent") {
              const marker = baseState.harnessRunMarker as HarnessRunMarker | null;
              if (!marker || !isHarnessRunMarkerOwnedByRun(marker, harnessRunOwner)) {
                logStoreEvent("terminal_projection_owner_changed", {
                  sessionKey: runSessionKey,
                  turnId,
                  runId: terminalRunIdentity.runId,
                  attempt,
                });
                return false;
              }
              const closedAt = Date.now();
              attemptHarnessProjection = {
                source: marker,
                terminal: {
                  ...marker,
                  status: requestedHarnessProjection.terminal.status,
                  planStage: baseState.planStage,
                  isPlanApproved: baseState.isPlanApproved,
                  updatedAt: closedAt,
                  closedAt,
                  closeReason: requestedHarnessProjection.terminal.closeReason,
                },
              };
            }

            completedTurnHasChanges = false;
            const draft = createTerminalDraftAccess(baseState);
            commitFinalElapsedTime(draft);
            let finalText: string | null = null;
            if (
              outcome.status === "completed" &&
              (outcome.resultKind === "success" || outcome.resultKind === "partial") &&
              shouldCommitCompletedTurnFinalPresentation({
                outcomeStatus: outcome.status,
                hasPendingSameTurnExecution: isSameTurnExecutionContinuation,
              })
            ) {
              finalText = ensureCompletedTurnFinalPresentation(outcome, draft);
            } else if (!isSameTurnExecutionContinuation) {
              finalText = ensureClosedTurnConclusion(outcome, draft);
            }
            if (shouldCommitPausedTurnFinalPresentation({
              outcomeStatus: outcome.status,
              recoveryReason: outcome.reason,
              hasDurableMutationEvidence: getScopedDurableMutationEvidence().length > 0,
              hasPendingSameTurnExecution: isSameTurnExecutionContinuation,
            })) {
              finalText = ensurePausedTurnFinalPresentation(outcome, draft) || finalText;
            }
            if (shouldCanonicalizeTerminalTurnContext(outcome.status) && !isSameTurnExecutionContinuation) {
              commitTerminalTurnContext(outcome, draft);
            }

            const projectedState = draft.get();
            const pendingAction = projectedState.activeActionRequest as ActionRequest | null;
            const isIntentionalActionPause =
              !isSameTurnExecutionContinuation &&
              outcome.status === "paused" &&
              pendingAction?.status === "pending" &&
              isActionRequestOwnedByRun(pendingAction, {
                sessionKey: runSessionKey,
                turnId,
                runId: terminalRunIdentity.runId,
              });
            const terminalTurnStatus = isSameTurnExecutionContinuation
              ? "executing"
              : outcome.status === "completed"
              ? completedTurnHasChanges ? "completed_with_changes" : "done"
              : outcome.status === "aborted"
              ? "done"
              : "paused";
            const timestampMs = Date.now();
            const summary = projectedState.conversationTurns.find((candidate: any) =>
              terminalTurnIds.has(candidate.id)
            )?.summary || outcome.reason;
            const runBoundaryEvent = outcome.status === "aborted"
              ? withEventSchema({
                  type: "run.aborted",
                  threadId: runSessionKey,
                  turnId,
                  timestampMs,
                  runId: terminalRunIdentity.runId,
                  parentRunId: terminalRunIdentity.parentRunId,
                  ...(terminalRunIdentity.goalSliceId
                    ? { goalSliceId: terminalRunIdentity.goalSliceId }
                    : {}),
                  reason: outcome.reason,
                  message: summary,
                })
              : outcome.status === "paused"
              ? withEventSchema({
                  type: "run.paused",
                  threadId: runSessionKey,
                  turnId,
                  timestampMs,
                  runId: terminalRunIdentity.runId,
                  parentRunId: terminalRunIdentity.parentRunId,
                  ...(terminalRunIdentity.goalSliceId
                    ? { goalSliceId: terminalRunIdentity.goalSliceId }
                    : {}),
                  reason: outcome.reason,
                  message: summary,
                })
              : null;
            const runConclusionEvent = outcome.status === "completed"
              ? withEventSchema({
                  type: "run.completed",
                  threadId: runSessionKey,
                  turnId,
                  timestampMs,
                  runId: terminalRunIdentity.runId,
                  parentRunId: terminalRunIdentity.parentRunId,
                  ...(terminalRunIdentity.goalSliceId
                    ? { goalSliceId: terminalRunIdentity.goalSliceId }
                    : {}),
                  resultKind: outcome.resultKind,
                  summary,
                })
              : outcome.status === "aborted"
              ? withEventSchema({
                  type: "run.completed",
                  threadId: runSessionKey,
                  turnId,
                  timestampMs,
                  runId: terminalRunIdentity.runId,
                  parentRunId: terminalRunIdentity.parentRunId,
                  ...(terminalRunIdentity.goalSliceId
                    ? { goalSliceId: terminalRunIdentity.goalSliceId }
                    : {}),
                  resultKind: "canceled",
                  summary,
                })
              : null;
            const runLifecycleEvents = [runBoundaryEvent, runConclusionEvent]
              .filter((event): event is NonNullable<typeof event> => !!event);
            let validatedRuntimeEvents = projectedState.runtimeEvents;
            for (const event of runLifecycleEvents) {
              const append = appendRuntimeEventWithResult(validatedRuntimeEvents, event);
              if (append.disposition === "conflict") {
                logStoreEvent("terminal_run_projection_conflict", {
                  sessionKey: runSessionKey,
                  turnId,
                  runId: terminalRunIdentity.runId,
                  requestedType: event.type,
                  existingType: append.existingEvent?.type || null,
                });
                return false;
              }
              validatedRuntimeEvents = append.events;
            }
            const turnTerminalEvent = closesLogicalTurn
              ? withEventSchema({
                  type: "turn.completed",
                  threadId: runSessionKey,
                  turnId,
                  timestampMs,
                  resultKind: turnResultKind,
                })
              : null;
            if (turnTerminalEvent) {
              const turnAppend = appendRuntimeEventWithResult(validatedRuntimeEvents, turnTerminalEvent);
              if (turnAppend.disposition === "conflict") {
                logStoreEvent("terminal_turn_projection_conflict", {
                  sessionKey: runSessionKey,
                  turnId,
                  runId: terminalRunIdentity.runId,
                  existingType: turnAppend.existingEvent?.type || null,
                });
                return false;
              }
            }

            let planTerminalProjectionRejected = false;
            draft.set((state: any) => {
              let nextState = state;
              for (const event of runLifecycleEvents) {
                nextState = reduceRunTransition(nextState, {
                  type: "runtime_event",
                  event,
                });
              }
              if (turnTerminalEvent) {
                nextState = reduceRunTransition(nextState, {
                  type: "runtime_event",
                  event: turnTerminalEvent,
                });
              }
              const planLifecycle = state.planLifecycle as PlanLifecycleState | undefined;
              const planExecutionLease = planLifecycle?.executionLease || null;
              const planExecutionOwner = planLifecycle?.execution || null;
              const exactPlanExecutionOwner = !!planLifecycle &&
                !!planExecutionLease &&
                !!planExecutionOwner &&
                isPlanLifecycleExecutionAuthorizedForRun(planLifecycle, {
                  executionLeaseId: planExecutionLease.executionLeaseId,
                  turnId,
                  runId: terminalRunIdentity.runId,
                  parentRunId: terminalRunIdentity.parentRunId,
                  attempt: planExecutionOwner.attempt,
                });
              let planLifecyclePatch: Record<string, unknown> = {};
              if (exactPlanExecutionOwner && planLifecycle && planExecutionLease && planExecutionOwner) {
                const terminalPlanProjection = collectPlanTaskTerminalProjection({
                  tasks: state.planTasks || [],
                  evidenceLedger: state.planExecutionEvidenceLedger || [],
                  availableToolNames: terminalAvailableToolNames,
                });
                const canCompletePlan = outcome.status === "completed" &&
                  outcome.resultKind === "success" &&
                  terminalPlanProjection.blocking.length === 0;
                const planTransition = canCompletePlan
                  ? reducePlanLifecycle(planLifecycle, {
                      type: "complete",
                      expectedVersion: planLifecycle.version,
                      at: timestampMs,
                      expectedExecutionLeaseId: planExecutionLease.executionLeaseId,
                      expectedExecution: planExecutionOwner,
                    })
                  : reducePlanLifecycle(planLifecycle, {
                      type: "pause",
                      expectedVersion: planLifecycle.version,
                      at: timestampMs,
                      expectedExecutionLeaseId: planExecutionLease.executionLeaseId,
                      expectedExecution: planExecutionOwner,
                      pause: {
                        reason: outcome.reason || "plan_execution_stopped",
                        resultKind: outcome.status === "completed" && outcome.resultKind !== "success"
                          ? outcome.resultKind
                          : (state.planExecutionEvidenceLedger || []).length > 0
                          ? "partial"
                          : "blocked",
                        resumeCondition: outcome.status === "paused" && outcome.pauseKind === "action_required"
                          ? "resolve_action_request"
                          : "explicit_resume",
                      },
                    });
                if (planTransition.disposition === "rejected") {
                  planTerminalProjectionRejected = true;
                  logStoreEvent("plan_terminal_projection_rejected", {
                    sessionKey: runSessionKey,
                    turnId,
                    runId: terminalRunIdentity.runId,
                    executionLeaseId: planExecutionLease.executionLeaseId,
                    reason: planTransition.reason || "unknown",
                  });
                  return state;
                }
                planLifecyclePatch = {
                  planLifecycle: planTransition.state,
                  isPlanApproved: false,
                  currentTurnExecutionConsent: { turnId: null, granted: false },
                  pendingPlanApprovalHandoff: null,
                  planApprovalExecutionStartedForTurnId: null,
                  planStage: canCompletePlan ? "completed" : "ready_to_execute",
                };
              }
              return {
                ...nextState,
                ...planLifecyclePatch,
                ...(attemptHarnessProjection === "absent"
                  ? {}
                  : {
                      harnessRunMarker: {
                        ...attemptHarnessProjection.terminal,
                        ...(exactPlanExecutionOwner
                          ? {
                              isPlanApproved: false,
                              planStage: planLifecyclePatch.planStage,
                            }
                          : {}),
                      },
                    }),
                conversationTurns: nextState.conversationTurns.map((candidate: any) =>
                  terminalTurnIds.has(candidate.id)
                    ? {
                        ...candidate,
                        status: isIntentionalActionPause ? candidate.status : terminalTurnStatus,
                        collapsed: false,
                        runtimeOutcome: {
                          status: projectAgentLoopStatusToConversationTurnRuntimeStatus(outcome.status),
                          reason: outcome.reason,
                          ...(outcome.status === "completed"
                            ? { resultKind: outcome.resultKind }
                            : outcome.status === "paused"
                            ? { pauseKind: outcome.pauseKind }
                            : { resultKind: "canceled" as const }),
                          runId: terminalRunIdentity.runId,
                          parentRunId: terminalRunIdentity.parentRunId,
                          updatedAt: timestampMs,
                        },
                      }
                    : candidate
                ),
              };
            });
            if (planTerminalProjectionRejected) return false;

            let durableState: any;
            try {
              durableState = await persistCurrentSessionRuntime(draft.snapshot());
            } catch (error) {
              if (outcome.status !== "completed" || outcome.resultKind !== "error") {
                throw error;
              }
              if (getSessionRevisionToken() !== baseRevisionToken && attempt < 2) {
                continue;
              }
              logStoreEvent("terminal_error_conclusion_persist_unavailable", {
                sessionKey: runSessionKey,
                turnId,
                runId: terminalRunIdentity.runId,
                error: error instanceof Error ? error.message : String(error),
              });
              durableState = draft.snapshot();
            }
            if (getSessionRevisionToken() !== baseRevisionToken) {
              logStoreEvent("terminal_projection_retry_after_concurrent_update", {
                sessionKey: runSessionKey,
                turnId,
                runId: terminalRunIdentity.runId,
                attempt: attempt + 1,
              });
              continue;
            }
            const publication = publishOwnerScopedRuntimeProjection({
              projectedState: draft.snapshot(),
              durableState,
              scopeKey: runScopeKey,
              sessionId: runSessionId,
              expectedRevisionToken: baseRevisionToken,
              beforePublish: () => {
                publishCurrentHarnessRunMarkerClose(attemptHarnessProjection);
              },
            });
            if (!publication.published) {
              if (publication.disposition === "revision_conflict") {
                logStoreEvent("terminal_projection_retry_after_concurrent_update", {
                  sessionKey: runSessionKey,
                  turnId,
                  runId: terminalRunIdentity.runId,
                  attempt: attempt + 1,
                  phase: "owner_scoped_publish",
                });
                continue;
              }
              logStoreEvent("terminal_projection_owner_changed", {
                sessionKey: runSessionKey,
                turnId,
                runId: terminalRunIdentity.runId,
                attempt,
                disposition: publication.disposition,
              });
              return false;
            }
            committedFinalText = finalText;
            committedTurnStatus = terminalTurnStatus;
            committedIsIntentionalActionPause = isIntentionalActionPause;
            committedPendingAction = pendingAction;
            return true;
          }
          throw new Error("TERMINAL_PROJECTION_CONCURRENT_UPDATE_LIMIT");
        },
        publishTerminalStatus: () => {
          sessionSet({
            agentStatus: committedIsIntentionalActionPause &&
              (committedPendingAction?.kind === "plan_review" || committedPendingAction?.kind === "tool_permission")
              ? "pending_review"
              : "idle",
            isGenerating: false,
            abortController: null,
          });
        },
      });
      if (terminalCommitted) {
        const committed = sessionGet();
        logStoreEvent("terminal_run_projection_committed", {
          outcomeStatus: outcome.status,
          outcomeKind: outcome.status === "completed"
            ? outcome.resultKind
            : outcome.status === "paused"
            ? outcome.pauseKind
            : "canceled",
          turnStatus: committedTurnStatus,
          pendingSameTurnExecution: isSameTurnExecutionContinuation,
          turnIds: Array.from(terminalTurnIds),
          planStage: committed.planStage,
          isPlanApproved: committed.isPlanApproved,
        });
      }
      return { committed: terminalCommitted, finalText: committedFinalText };
    };

    const commitTerminalTurnContext = (
      loopOutcome: AgentLoopOutcome,
      access: TerminalStateAccess = liveTerminalStateAccess,
    ) => {
      let latestState = access.get();
      if (!shouldCanonicalizeTerminalTurnContext(loopOutcome.status)) return latestState;
      const terminalOwnership = resolveTerminalTurnOwnership({
        turnId,
        uiDisplayTurnId: context.uiDisplayTurnId,
      });
      const terminalTurnIds = new Set(terminalOwnership.evidenceTurnIds);
      const completedTurn = latestState.conversationTurns.find((candidate: any) =>
        candidate.id === terminalOwnership.ownerTurnId
      ) || latestState.conversationTurns.find((candidate: any) => candidate.id === turnId);
      const turnBlocks = latestState.taskFlow.filter((block: any) =>
        !!block.turnId && terminalTurnIds.has(block.turnId)
      );
      const isPlanTurn = completedTurn?.mode === "plan" || completedTurn?.intent === "plan";
      const planTerminalProjection = isPlanTurn
        ? collectPlanTaskTerminalProjection({
            tasks: latestState.planTasks || [],
            evidenceLedger: latestState.planExecutionEvidenceLedger || [],
            availableToolNames: terminalAvailableToolNames,
          })
        : { blocking: [], advisories: [] };
      const durableContext = buildDurableTurnContext({
        turnId: terminalOwnership.ownerTurnId,
        turnBlocks,
        fallbackAssistantText: completedTurn?.summary || loopOutcome.reason,
        artifactPaths: isPlanTurn
          ? (latestState.planArtifacts || []).map((artifact: any) => artifact.path)
          : [],
        unfinished: [
          ...planTerminalProjection.blocking,
          ...(loopOutcome.status === "aborted" ||
          (loopOutcome.status === "completed" &&
            (loopOutcome.resultKind === "error" || loopOutcome.resultKind === "blocked"))
            ? [loopOutcome.reason]
            : []),
        ],
        advisories: planTerminalProjection.advisories,
      });
      if (durableContext) {
        access.set((state: any) => ({
          conversationTurns: state.conversationTurns.map((candidate: any) =>
            candidate.id === terminalOwnership.ownerTurnId
              ? { ...candidate, durableContext }
              : candidate
          ),
        }));
        logStoreEvent("durable_turn_context_staged", {
          outcomeStatus: loopOutcome.status,
          visibleUserMessages: durableContext.visibleUserMessages.length,
          finalAnswerChars: durableContext.finalAssistantAnswer.length,
          decisions: durableContext.execution.decisions.length,
          modifiedFiles: durableContext.execution.modifiedFiles.length,
          validations: durableContext.execution.validations.length,
          failures: durableContext.execution.failures.length,
          unfinished: durableContext.execution.unfinished.length,
          advisories: durableContext.execution.advisories.length,
          artifacts: durableContext.execution.artifacts.length,
        });
        latestState = access.get();
      }

      const terminalTurn = latestState.conversationTurns.find((candidate: any) =>
        candidate.id === terminalOwnership.ownerTurnId
      ) || completedTurn;
      const terminalSummary = String(terminalTurn?.summary || loopOutcome.reason || "").trim();
      if (!terminalSummary) return latestState;
      const terminalBlocks = latestState.taskFlow.filter((block: any) =>
        !!block.turnId && terminalTurnIds.has(block.turnId)
      );
      const compactedMessages = compactCompletedTurnAgentMessages({
        agentMessages: latestState.agentMessages,
        turnStartIndex: turnAgentMessagesStart,
        turnSummary: terminalSummary,
        turnBlocks: terminalBlocks,
        durableContext: terminalTurn?.durableContext,
        language: (latestState.preferredResponseLanguage || latestState.config.language) === "en" ? "en" : "zh",
      });
      if (compactedMessages !== latestState.agentMessages) {
        const beforeMessageCount = latestState.agentMessages.length;
        access.set({ agentMessages: compactedMessages });
        latestState = access.get();
        logStoreEvent("terminal_turn_context_compaction_staged", {
          outcomeStatus: loopOutcome.status,
          contextSource: "canonical_visible_messages_and_durable_summary",
          beforeMessageCount,
          afterMessageCount: compactedMessages.length,
          omittedRuntimeControlMessages: Math.max(0, beforeMessageCount - compactedMessages.length),
        });
      }
      return latestState;
    };

    const commitFinalElapsedTime = (access: TerminalStateAccess = liveTerminalStateAccess) => {
      const elapsedTime = Math.max(0, getElapsedSeconds());
      const elapsedTurnIds = new Set([turnId, context.uiDisplayTurnId].filter(Boolean));
      access.set((state: any) => ({
        pendingSlashCommand: null,
        elapsedTime,
        conversationTurns: state.conversationTurns.map((candidate: any) =>
          elapsedTurnIds.has(candidate.id)
            ? {
                ...candidate,
                elapsedTime: Math.max(0, Number(candidate.elapsedTime) || 0, elapsedTime),
              }
            : candidate
        ),
      }));
      return elapsedTime;
    };

    const persistCurrentSessionRuntime = async (state: any): Promise<any> => {
      if (runSessionId == null) return state;
      const messages = sanitizeTaskBlocksForPersist(state.taskFlow);
      const sessionRecord = (state.sessionsByWorkspace?.[runScopeKey] || []).find(
        (candidate: any) => candidate.id === runSessionId,
      );
      const shouldPersist =
        state.config.sessionRecordingEnabled === true && sessionRecord?.recordingDisabled !== true;
      const updatedAtMs = Date.now();
      const sessionPatch = {
        updatedAt: new Date(updatedAtMs).toISOString(),
        updatedAtMs,
        messages,
        storageStatus: "temporary" as const,
        recordingDisabled: sessionRecord?.recordingDisabled === true || !state.config.sessionRecordingEnabled,
        runtimeSnapshot: normalizeSessionRuntimeSnapshot({
          runtimeEventSchemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
          runtimeEvents: state.runtimeEvents,
          harnessRunMarker: state.harnessRunMarker,
          activeActionRequest: state.activeActionRequest,
          taskFlow: messages,
          agentMessages: sanitizeAgentMessagesForPersist(state.agentMessages),
          contextMemoryState: state.contextMemoryState,
          contextMemoryStateByRuntimeKey: state.contextMemoryStateByRuntimeKey,
          providerCompatibilityByRuntimeKey: state.providerCompatibilityByRuntimeKey,
          conversationTurns: state.conversationTurns,
          currentTurnId: state.currentTurnId,
          selectedMainModeKey: state.selectedMainModeKey,
          selectedNexusModeKey: state.selectedNexusModeKey,
          imageStudio: state.imageStudio,
          activeStudioAgentKey: state.activeStudioAgentKey,
          gameStudioInitialized: state.gameStudioInitialized,
          pendingSlashCommand: state.pendingSlashCommand,
          planArtifacts: state.planArtifacts,
          planTasks: state.planTasks,
          planExecutionEvidenceLedger: state.planExecutionEvidenceLedger,
          planExecutionEvidenceCount: state.planExecutionEvidenceCount,
          planAutoResumeCount: state.planAutoResumeCount,
          planExecutionProgressSnapshot: state.planExecutionProgressSnapshot,
          planLifecycle: state.planLifecycle,
          planStage: state.planStage,
          isPlanApproved: state.isPlanApproved,
          showPlanPanel: state.showPlanPanel,
          showDiff: state.showDiff,
          showTerminal: state.showTerminal,
          showFilePanel: state.showFilePanel,
          rightPanelTab: state.rightPanelTab,
          selectedDiffTaskId: state.selectedDiffTaskId,
          autoApproveTools: state.autoApproveTools,
          autoApproveToolScopes: state.autoApproveToolScopes,
          queuedUserMessage: state.queuedUserMessage,
          activeGuidance: state.activeGuidance,
          activeGoal: state.activeGoal,
          goalProgress: state.goalProgress,
          goalStatus: state.goalStatus,
          goalIterationBudget: state.goalIterationBudget,
          goalRuntime: state.goalRuntime,
        }),
      };
      let committedSessionPatch: Record<string, unknown> = sessionPatch;
      if (!shouldPersist) {
        const sessions = state.sessionsByWorkspace?.[runScopeKey] || [];
        return {
          ...state,
          sessionsByWorkspace: {
            ...state.sessionsByWorkspace,
            [runScopeKey]: sessions.map((candidate: any) =>
              candidate.id === runSessionId
                ? { ...candidate, ...committedSessionPatch }
                : candidate
            ),
          },
        };
      }

      if (!sessionRecord) {
        throw new Error(`SESSION_RUNTIME_RECORD_MISSING: ${runScopeKey}:${runSessionId}`);
      }

      try {
        const saved = await persistSessionRecord(runScopeKey, {
          ...sessionRecord,
          ...sessionPatch,
        });
        committedSessionPatch = {
          ...sessionPatch,
          ...(saved && typeof saved === "object" ? saved : {}),
          storageStatus: "ok",
          recordingDisabled: false,
        };
      } catch (error) {
        logStoreEvent("session_runtime_persist_failed", {
          scopeKey: runScopeKey,
          sessionId: runSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const sessions = state.sessionsByWorkspace?.[runScopeKey] || [];
      return {
        ...state,
        sessionsByWorkspace: {
          ...state.sessionsByWorkspace,
          [runScopeKey]: sessions.map((candidate: any) =>
            candidate.id === runSessionId
              ? { ...candidate, ...committedSessionPatch }
              : candidate
          ),
        },
      };
    };

    const publishEmergencyErrorConclusion = async (input: {
      reason: string;
      triggerError: string;
    }): Promise<{ committed: boolean; finalText: string | null }> => {
      const outcome: AgentLoopOutcome = {
        status: "completed",
        reason: input.reason,
        resultKind: "error",
      };
      const terminalRunIdentity = { ...activeRuntimeRunIdentity };
      const terminalTurnIds = new Set([turnId, context.uiDisplayTurnId].filter(Boolean));
      const baseRevisionToken = getSessionRevisionToken();
      const current = sessionGet();
      if (current.runtimeEvents.some((event: any) =>
        isTerminalTurnEvent(event) &&
        event.threadId === runSessionKey &&
        terminalTurnIds.has(event.turnId)
      )) {
        return { committed: true, finalText: null };
      }
      const harnessProjection = projectCurrentHarnessRunMarker(
        "completed",
        "terminal_error_memory_fallback",
        true,
      );
      if (harnessProjection === "ownership_lost") {
        return { committed: false, finalText: null };
      }

      const draft = createTerminalDraftAccess(current);
      commitFinalElapsedTime(draft);
      const finalText = ensureClosedTurnConclusion(outcome, draft);
      commitTerminalTurnContext(outcome, draft);
      const timestampMs = Date.now();
      const runTerminalEvent = withEventSchema({
        type: "run.completed",
        threadId: runSessionKey,
        turnId,
        timestampMs,
        runId: terminalRunIdentity.runId,
        parentRunId: terminalRunIdentity.parentRunId,
        ...(terminalRunIdentity.goalSliceId
          ? { goalSliceId: terminalRunIdentity.goalSliceId }
          : {}),
        resultKind: "error",
        summary: finalText || input.reason,
      });
      const runAppend = appendRuntimeEventWithResult(
        draft.get().runtimeEvents,
        runTerminalEvent,
      );
      if (runAppend.disposition === "conflict") {
        logStoreEvent("terminal_error_memory_fallback_conflict", {
          runId: terminalRunIdentity.runId,
          existingType: runAppend.existingEvent?.type || null,
          triggerError: input.triggerError,
        });
        return { committed: false, finalText: null };
      }
      const turnTerminalEvent = withEventSchema({
        type: "turn.completed",
        threadId: runSessionKey,
        turnId,
        timestampMs,
        resultKind: "error",
      });
      const turnAppend = appendRuntimeEventWithResult(runAppend.events, turnTerminalEvent);
      if (turnAppend.disposition === "conflict") {
        return { committed: false, finalText: null };
      }

      draft.set((state: any) => {
        let nextState = reduceRunTransition(state, {
          type: "runtime_event",
          event: runTerminalEvent,
        });
        nextState = reduceRunTransition(nextState, {
          type: "runtime_event",
          event: turnTerminalEvent,
        });
        return {
          ...nextState,
          ...(harnessProjection === "absent"
            ? {}
            : { harnessRunMarker: harnessProjection.terminal }),
          agentStatus: "idle",
          isGenerating: false,
          abortController: null,
          conversationTurns: nextState.conversationTurns.map((candidate: any) =>
            terminalTurnIds.has(candidate.id)
              ? {
                  ...candidate,
                  status: "done",
                  collapsed: false,
                  runtimeOutcome: {
                    status: "completed",
                    reason: input.reason,
                    resultKind: "error",
                    runId: terminalRunIdentity.runId,
                    parentRunId: terminalRunIdentity.parentRunId,
                    updatedAt: timestampMs,
                  },
                }
              : candidate
          ),
        };
      });
      const projectedState = draft.snapshot();
      const memoryPublication = publishOwnerScopedRuntimeProjection({
        projectedState,
        durableState: projectedState,
        scopeKey: runScopeKey,
        sessionId: runSessionId,
        expectedRevisionToken: baseRevisionToken,
        beforePublish: () => {
          publishCurrentHarnessRunMarkerClose(harnessProjection);
        },
      });
      if (!memoryPublication.published) {
        logStoreEvent("terminal_error_memory_fallback_owner_changed", {
          runId: terminalRunIdentity.runId,
          disposition: memoryPublication.disposition,
          triggerError: input.triggerError,
        });
        return { committed: false, finalText: null };
      }
      const publishedRevisionToken = getSessionRevisionToken();
      try {
        const durableState = await persistCurrentSessionRuntime(projectedState);
        const durablePublication = publishOwnerScopedRuntimeProjection({
          projectedState,
          durableState,
          scopeKey: runScopeKey,
          sessionId: runSessionId,
          expectedRevisionToken: publishedRevisionToken,
        });
        if (durablePublication.published) {
          logStoreEvent("terminal_error_memory_fallback_reconciled", {
            runId: terminalRunIdentity.runId,
            durability: "durable_after_memory_publication",
            disposition: durablePublication.disposition,
            triggerError: input.triggerError,
          });
        } else {
          logStoreEvent("terminal_error_memory_fallback_reconcile_skipped", {
            runId: terminalRunIdentity.runId,
            durability: "durable_not_published_after_concurrent_update",
            disposition: durablePublication.disposition,
            triggerError: input.triggerError,
          });
        }
      } catch (persistError) {
        logStoreEvent("terminal_error_memory_fallback_committed", {
          runId: terminalRunIdentity.runId,
          durability: "memory_only",
          triggerError: input.triggerError,
          persistError: persistError instanceof Error
            ? persistError.message
            : String(persistError),
        });
      }
      return { committed: true, finalText };
    };

    const executeLoopStrategy = (): Promise<AgentLoopOutcome> => {
      if (context.runtimeRunIntent === "goal") {
        const activeGoal = sessionGet().goalRuntime?.goal || sessionGet().activeGoal;
        if (!activeGoal) {
          return Promise.resolve({
            status: "completed",
            reason: "no_active_goal",
            resultKind: "error",
          });
        }

        const goalOwnerId = activeGoal.id;
        const goalOwnerRevision = activeGoal.revision || 1;
        const goalOwnerTurnId = String(activeGoal.ownerTurnId || turnId).trim();
        const goalOwnerWorkspace = String(sessionGet().currentWorkspace || "").trim();
        let staleGoalCallbackLogged = false;
        const isCurrentGoalOwner = () => {
          const state = sessionGet();
          const currentGoal = state.goalRuntime?.goal || state.activeGoal;
          return String(state.currentWorkspace || "").trim() === goalOwnerWorkspace &&
            isCurrentGoalWorkflowOwner({
              goalId: goalOwnerId,
              goalRevision: goalOwnerRevision,
              ownerTurnId: goalOwnerTurnId,
              currentGoal,
              fallbackOwnerTurnId: turnId,
            }) &&
            !isGoalRuntimeDeleted(goalOwnerWorkspace, goalOwnerId);
        };
        const acceptGoalCallback = (callback: string) => {
          const accepted = isCurrentGoalOwner();
          if (!accepted && !staleGoalCallbackLogged) {
            staleGoalCallbackLogged = true;
            callbacks.onDebugEvent?.("goal_callback_ignored_stale_owner", {
              callback,
              goalId: goalOwnerId,
              goalRevision: goalOwnerRevision,
              ownerTurnId: goalOwnerTurnId,
              currentOwnerTurnId: String(
                (sessionGet().goalRuntime?.goal || sessionGet().activeGoal)?.ownerTurnId || "",
              ).trim() || null,
              workspace: goalOwnerWorkspace || null,
            });
          }
          return accepted;
        };

        let latestGoalEvidence = [
          ...(sessionGet().goalRuntime?.progress?.evidence || sessionGet().goalProgress?.evidence || []),
        ];
        const goalCallbacks: GoalEngineCallbacks = {
          getPreferredLanguage: callbacks.getPreferredLanguage,
          getWorkspacePath: () => goalOwnerWorkspace || resolveSessionWorkspaceKey(null),
          runAgentIteration: async (iterInput) => {
            if (!acceptGoalCallback("runAgentIteration")) {
              throw new Error("GOAL_OWNER_RELEASED: the Goal was deleted or replaced");
            }
            activeRuntimeRunIdentity = resolveRuntimeRunIdentity({
              marker: sessionGet().harnessRunMarker,
              sessionKey: runSessionKey,
              turnId,
              fallbackRunId: context.harnessRunId,
              goalSliceId: iterInput.goalSliceId,
            });
            activePlanExecutionIdentity = null;
            updateHarnessRunMarker({
              activeRunId: activeRuntimeRunIdentity.runId,
              activeParentRunId: activeRuntimeRunIdentity.parentRunId,
              activePlanExecutionProvenance: null,
            });
            const retainedContinuationMessages = restoreGoalContinuationMessages(iterInput.continuation);
            let iterationMessages: import("../orchestrator").AgentMessage[] = [
              { role: "system", content: "" },
              ...retainedContinuationMessages,
              {
                role: "user",
                content: buildGoalContinuationPrompt({
                  language: callbacks.getPreferredLanguage(),
                  goalId: iterInput.goalTurnContract.goalId,
                  continuationIndex: iterInput.iteration,
                }),
              },
            ];
            // Keep a separate append-only ledger for this continuation. The
            // active context can be replaced by compaction, so an array index
            // into iterationMessages is not a stable work boundary.
            let currentContinuationMessages: import("../orchestrator").AgentMessage[] = [];
            const goalInnerIterationLimit = callbacks.getConfig().activeProfile === "local" ? 8 : 12;
            let maxObservedModelIteration = 0;
            let providerUsageReports = 0;
            let providerInputTokens = 0;
            let providerOutputTokens = 0;
            let providerTotalTokens = 0;
            const deferredNonActionableStops: Array<
              Parameters<OrchestratorCallbacks["onNonActionableStop"]>
            > = [];
            const continuationRecoveryState = resolveGoalContinuationExecuteRecoveryState(
              iterInput.continuation,
              { mutationRequired: goalRequiresMutation(activeGoal) },
            );
            if (continuationRecoveryState) {
              callbacks.onDebugEvent?.("goal_continuation_recovery_mode_restored", {
                continuationId: iterInput.goalSliceId,
                continuation: iterInput.iteration,
                executeRecoveryMode: continuationRecoveryState.mode,
                executeRecoveryReason: continuationRecoveryState.reason,
                expectedTarget: continuationRecoveryState.expectedTarget,
                executeRecoveryAttempts: continuationRecoveryState.attempts || 0,
                executeRecoveryPhase: continuationRecoveryState.phase,
                phaseNoProgressCount: continuationRecoveryState.phaseNoProgressCount,
                protocolNoProgressCount: continuationRecoveryState.protocolNoProgressCount,
                protocolNoProgressFingerprint: continuationRecoveryState.protocolNoProgressFingerprint,
                readLeasePurpose: continuationRecoveryState.readLease?.purpose || null,
                readLeaseState: continuationRecoveryState.readLease?.state || null,
                sourceObservationKey: continuationRecoveryState.sourceObservationKey,
                nextRequiredCapability:
                  continuationRecoveryState.decisionCheckpoint?.nextRequiredCapability || null,
                planTaskId: continuationRecoveryState.decisionCheckpoint?.planTaskId || null,
                requirementRef: continuationRecoveryState.decisionCheckpoint?.requirementRef || null,
              });
            }
            let latestExecuteRecoveryState: Parameters<
              NonNullable<OrchestratorCallbacks["onExecuteRecoveryStateChange"]>
            >[0] = continuationRecoveryState
              ? {
                  ...continuationRecoveryState,
                  attempts: Math.max(1, continuationRecoveryState.attempts || 1),
                }
              : {
                mode: "normal" as const,
                reason: "",
                expectedTarget: null,
                attempts: 0,
                phase: "normal" as const,
                phaseNoProgressCount: 0,
                protocolNoProgressCount: 0,
                protocolNoProgressFingerprint: null,
                readLease: null,
                sourceObservationKey: null,
                decisionCheckpoint: null,
              };
            let checkpointEvidence = [...latestGoalEvidence];
            const iterCallbacks = {
              ...callbacks,
              onStreamToken: (...args: Parameters<OrchestratorCallbacks["onStreamToken"]>) => {
                if (acceptGoalCallback("onStreamToken")) callbacks.onStreamToken(...args);
              },
              onStreamDone: (...args: Parameters<OrchestratorCallbacks["onStreamDone"]>) => {
                if (acceptGoalCallback("onStreamDone")) callbacks.onStreamDone(...args);
              },
              onThought: (...args: Parameters<OrchestratorCallbacks["onThought"]>) => {
                if (acceptGoalCallback("onThought")) callbacks.onThought(...args);
              },
              onAssistantFinalText: (
                ...args: Parameters<OrchestratorCallbacks["onAssistantFinalText"]>
              ) => {
                if (acceptGoalCallback("onAssistantFinalText")) {
                  callbacks.onAssistantFinalText(...args);
                }
              },
              requestReview: async (
                ...args: Parameters<OrchestratorCallbacks["requestReview"]>
              ) => {
                if (!acceptGoalCallback("requestReview")) {
                  return { action: "reject" as const };
                }
                return callbacks.requestReview(...args);
              },
              getGoalTurnContract: () => iterInput.goalTurnContract,
              getForcedExecuteRecoveryState: () =>
                continuationRecoveryState || callbacks.getForcedExecuteRecoveryState?.() || null,
              getForcedExecuteRecoveryMode: () =>
                continuationRecoveryState?.mode || callbacks.getForcedExecuteRecoveryMode?.() || null,
              onExecuteRecoveryStateChange: (state: typeof latestExecuteRecoveryState) => {
                latestExecuteRecoveryState = { ...state };
                callbacks.onExecuteRecoveryStateChange?.(state);
              },
              getConfig: () => {
                const config = callbacks.getConfig();
                const currentAgentLoop = (config as any).agentLoop || {};
                const currentLimits = currentAgentLoop.iterationLimits || {};
                return {
                  ...config,
                  agentLoop: {
                    ...currentAgentLoop,
                    iterationLimits: {
                      ...currentLimits,
                      goalIteration: goalInnerIterationLimit,
                    },
                  },
                };
              },
              getMessages: () => iterationMessages,
              appendMessage: (message: import("../orchestrator").AgentMessage) => {
                iterationMessages = [...iterationMessages, message];
                currentContinuationMessages = [...currentContinuationMessages, message];
              },
              replaceMessages: (messages: import("../orchestrator").AgentMessage[]) => {
                iterationMessages = [...messages];
              },
              onExecuteMaxIterationsCheckpoint: async () => false,
              onHarnessRunUpdate: (patch: Record<string, unknown>) => {
                const iteration = Number(patch.iteration);
                if (Number.isFinite(iteration)) {
                  maxObservedModelIteration = Math.max(maxObservedModelIteration, Math.floor(iteration));
                }
                callbacks.onHarnessRunUpdate?.(patch);
              },
              onModelUsage: (usage: NonNullable<import("../streaming").StreamResult["usage"]>) => {
                providerUsageReports += 1;
                providerInputTokens += usage.inputTokens;
                providerOutputTokens += usage.outputTokens;
                providerTotalTokens += usage.totalTokens;
                callbacks.onModelUsage?.(usage);
              },
              evaluateGoalToolResultCheckpoint: (results: import("../orchestrator").ToolExecutionResult[]) => {
                const observations: GoalToolObservation[] = results
                  .filter((result) => !result.internalFeedback)
                  .map((result) => ({
                    id: result.toolCallId,
                    name: result.name,
                    target: result.target,
                    result: result.content,
                    success: !result.isError,
                  }));
                if (observations.length === 0) {
                  return {
                    complete: false,
                    reasons: ["no_external_tool_results"],
                    evidenceCount: checkpointEvidence.length,
                    supportingEvidenceIds: [],
                  };
                }
                const checkpoint = evaluateGoalEvidenceCheckpoint({
                  goal: activeGoal,
                  iteration: iterInput.iteration,
                  evidence: checkpointEvidence,
                  observations,
                });
                checkpointEvidence = checkpoint.evidence;
                callbacks.onDebugEvent?.("goal_tool_result_checkpoint", {
                  continuationId: iterInput.goalSliceId,
                  continuation: iterInput.iteration,
                  complete: checkpoint.passed,
                  reasons: checkpoint.reasons,
                  observedEvidence: checkpoint.observedEvidence.map((entry) => ({
                    kind: entry.kind,
                    status: entry.status,
                    tool: entry.sourceTool,
                    target: entry.target,
                  })),
                  evidenceCount: checkpoint.evidence.length,
                  supportingEvidenceIds: checkpoint.supportingEvidenceIds,
                });
                return {
                  complete: checkpoint.passed,
                  reasons: checkpoint.reasons,
                  evidenceCount: checkpoint.evidence.length,
                  supportingEvidenceIds: checkpoint.supportingEvidenceIds,
                };
              },
              onNonActionableStop: (...args: Parameters<OrchestratorCallbacks["onNonActionableStop"]>) => {
                deferredNonActionableStops.push(args);
              },
            };
            const startTaskFlowLength = sessionGet().taskFlow.length;
            let outcome: AgentLoopOutcome;
            try {
              outcome = await executeAgentLoop(iterCallbacks, abortCtrl);
            } catch (error) {
              const assistantResponseCount = currentContinuationMessages.filter((message) => message.role === "assistant").length;
              const modelIterationsUsed = Math.max(1, maxObservedModelIteration, assistantResponseCount);
              const observedToolIds = new Set<string>();
              for (const message of currentContinuationMessages) {
                if (message.role !== "assistant" || !message.tool_calls) continue;
                for (const toolCall of message.tool_calls) observedToolIds.add(toolCall.id);
              }
              for (const block of sessionGet().taskFlow.slice(startTaskFlowLength)) {
                if (block.type === "tool") observedToolIds.add(block.toolCallId || String(block.id));
              }
              const estimatedTokens = Math.ceil(iterationMessages.reduce((total, message) => {
                const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
                return total + content.length;
              }, 0) / 4);
              const hasCompleteProviderUsage = providerUsageReports >= modelIterationsUsed;
              const failureUsage = {
                modelIterations: modelIterationsUsed,
                toolCalls: observedToolIds.size,
                tokensUsed: hasCompleteProviderUsage
                  ? providerTotalTokens
                  : Math.max(providerTotalTokens, estimatedTokens),
                estimatedTokens: !hasCompleteProviderUsage,
              };
              const enrichedError = error instanceof Error ? error : new Error(String(error));
              const failureContinuation = createGoalContinuationState({
                messages: [...retainedContinuationMessages, ...currentContinuationMessages],
                sourceIteration: iterInput.iteration,
                previous: iterInput.continuation,
                executeRecoveryState: latestExecuteRecoveryState,
              });
              const goalError = enrichedError as Error & {
                goalIterationUsage?: typeof failureUsage;
                goalContinuationState?: typeof failureContinuation;
              };
              goalError.goalIterationUsage = failureUsage;
              goalError.goalContinuationState = failureContinuation;
              callbacks.onDebugEvent?.("goal_inner_continuation_threw", {
                continuationId: iterInput.goalSliceId,
                continuation: iterInput.iteration,
                error: enrichedError.message,
                usage: failureUsage,
                retainedMessages: failureContinuation.messages.length,
                retainedOperations: failureContinuation.operationCount,
                memoryChars: failureContinuation.memoryPacket?.length || 0,
              });
              throw enrichedError;
            }
            const assistantResponseCount = currentContinuationMessages.filter((message) => message.role === "assistant").length;
            const modelIterationsUsed = Math.max(maxObservedModelIteration, assistantResponseCount);
            const deferredNonActionableStop = deferredNonActionableStops[0];
            const deferredRecoveryReason = deferredNonActionableStop?.[2]?.recoveryReason;
            const exactMaxIterationBoundary =
              deferredRecoveryReason === "max_iterations_boundary" ||
              outcome.reason === "max_iterations_boundary";
            const sliceBoundaryReached = outcome.status === "completed"
              && outcome.resultKind !== "success"
              && modelIterationsUsed >= goalInnerIterationLimit
              && exactMaxIterationBoundary;
            if (deferredNonActionableStop && !sliceBoundaryReached) {
              callbacks.onNonActionableStop(...deferredNonActionableStop);
            }
            const stopReason = sliceBoundaryReached
              ? "max_iterations_boundary"
              : deferredRecoveryReason || outcome.reason;
            
            const newFlow = sessionGet().taskFlow.slice(startTaskFlowLength);
            let assistantText = "";
            const transcriptToolCalls: GoalToolObservation[] = [];
            const toolCallById = new Map<string, GoalToolObservation>();

            for (const block of newFlow) {
               if (block.type === "agent" && block.content) {
                 assistantText += block.content + "\n";
               }
            }
            
            for (const msg of currentContinuationMessages) {
              if (msg.role === "assistant" && msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                  let args = {};
                  try { args = JSON.parse(tc.function.arguments); } catch (e) {}
                  const observation = {
                    id: tc.id,
                    name: tc.function.name,
                    arguments: args,
                  };
                  transcriptToolCalls.push(observation);
                  toolCallById.set(tc.id, observation);
                }
              }
              if (msg.role === "tool" && msg.tool_call_id) {
                const observation = toolCallById.get(msg.tool_call_id);
                if (!observation) continue;
                const result = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
                observation.result = result;
              }
            }

            const runtimeToolCalls: GoalToolObservation[] = newFlow
              .filter((block: TaskBlock): block is Extract<TaskBlock, { type: "tool" }> => block.type === "tool")
              .map((block: Extract<TaskBlock, { type: "tool" }>) => ({
                id: block.toolCallId || String(block.id),
                name: block.toolName,
                target: block.target,
                result: block.message || block.observationSummary || block.evidence || block.status,
                success: block.toolStatus === "executed",
              }));
            const toolCalls = mergeGoalToolObservations(transcriptToolCalls, runtimeToolCalls);

            if (!assistantText.trim()) {
              assistantText = currentContinuationMessages
                .filter((message) => message.role === "assistant" && typeof message.content === "string")
                .map((message) => String(message.content || ""))
                .filter(Boolean)
                .join("\n");
            }

            const estimatedTokens = Math.ceil(iterationMessages.reduce((total, message) => {
              const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
              return total + content.length;
            }, 0) / 4);
            const hasCompleteProviderUsage = providerUsageReports >= modelIterationsUsed && modelIterationsUsed > 0;
            const tokensUsed = hasCompleteProviderUsage
              ? providerTotalTokens
              : Math.max(providerTotalTokens, estimatedTokens);
            const estimatedTokenUsage = !hasCompleteProviderUsage;
            const continuation = createGoalContinuationState({
              messages: [...retainedContinuationMessages, ...currentContinuationMessages],
              sourceIteration: iterInput.iteration,
              previous: iterInput.continuation,
              executeRecoveryState: latestExecuteRecoveryState,
            });

            callbacks.onDebugEvent?.("goal_inner_continuation_outcome", {
              continuationId: iterInput.goalSliceId,
              continuation: iterInput.iteration,
              outcomeStatus: outcome.status,
              stopReason,
              sliceBoundaryReached,
              usage: {
                modelIterations: modelIterationsUsed,
                toolCalls: toolCalls.length,
                tokensUsed,
                estimatedTokens: estimatedTokenUsage,
                providerUsageReports,
                providerInputTokens,
                providerOutputTokens,
              },
              retainedMessages: continuation.messages.length,
              retainedOperations: continuation.operationCount,
              continuationCompacted: continuation.compacted,
              memoryChars: continuation.memoryPacket?.length || 0,
            });

            return {
              assistantText: assistantText.trim() || (
                outcome.status === "completed" && outcome.resultKind === "error"
                  ? outcome.reason
                  : "Iteration completed without textual response"
              ),
              toolCalls,
              tokensUsed,
              completed: outcome.status === "completed" && outcome.resultKind !== "error" && outcome.resultKind !== "blocked",
              outcomeStatus: outcome.status,
              outcomeResultKind: outcome.status === "completed" ? outcome.resultKind : undefined,
              outcomePauseKind: outcome.status === "paused" ? outcome.pauseKind : undefined,
              error: outcome.status === "completed" && outcome.resultKind === "error"
                ? outcome.reason
                : undefined,
              stopReason,
              sliceBoundaryReached,
              usage: {
                modelIterations: modelIterationsUsed,
                toolCalls: toolCalls.length,
                tokensUsed,
                estimatedTokens: estimatedTokenUsage,
              },
              continuation,
            };
          },
          writeFile: async (path, content) => {
            if (!acceptGoalCallback("writeFile")) return;
            const { writeFileAtomic } = await import("../ipc");
            if (!acceptGoalCallback("writeFile")) return;
            await writeFileAtomic(path, content);
          },
          readFile: async (path) => {
            if (!acceptGoalCallback("readFile")) return null;
            try {
              const { readFile } = await import("../ipc");
              if (!acceptGoalCallback("readFile")) return null;
              return await readFile(path);
            } catch {
              return null;
            }
          },
          isAborted: () => abortCtrl.signal.aborted || !isCurrentGoalOwner(),
          onGoalProgressUpdate: (progress, goal) => {
            if (!acceptGoalCallback("onGoalProgressUpdate")) return;
            latestGoalEvidence = [...(progress.evidence || [])];
            callbacks.onGoalProgressUpdate?.(progress, goal);
          },
          onGoalRuntimeUpdate: (runtime) => {
            if (acceptGoalCallback("onGoalRuntimeUpdate")) callbacks.onGoalRuntimeUpdate?.(runtime);
          },
          onGoalIterationStart: (iter) => {
            if (acceptGoalCallback("onGoalIterationStart")) callbacks.onGoalIterationStart?.(iter);
          },
          onGoalIterationEnd: (iter) => {
            if (acceptGoalCallback("onGoalIterationEnd")) callbacks.onGoalIterationEnd?.(iter);
          },
          onGoalCheckpointSaved: (ckpt) => {
            if (acceptGoalCallback("onGoalCheckpointSaved")) callbacks.onGoalCheckpointSaved?.(ckpt);
          },
          onGoalUserConfirmNeeded: async (message) => acceptGoalCallback("onGoalUserConfirmNeeded")
            ? callbacks.onGoalUserConfirmNeeded?.(message) ?? false
            : false,
          onGoalOutcome: (outcome) => {
            if (acceptGoalCallback("onGoalOutcome")) callbacks.onGoalOutcome?.(outcome);
          },
          onDebugEvent: callbacks.onDebugEvent,
        };

        return executeGoalLoop({
          goal: activeGoal,
          callbacks: goalCallbacks,
          existingProgress: sessionGet().goalRuntime?.progress || sessionGet().goalProgress,
          userGuidance: String(
            (context.options as { goalContinuationGuidance?: string } | null | undefined)
              ?.goalContinuationGuidance || "",
          ).trim() || undefined,
        }).then((goalOutcome) => {
          if (goalOutcome.status === "completed") {
            return {
              status: "completed" as const,
              reason: goalOutcome.reason,
              resultKind: "success" as const,
            };
          }
          if (goalOutcome.status === "failed") {
            return {
              status: "completed" as const,
              reason: goalOutcome.reason,
              resultKind: "error" as const,
            };
          }
          if (goalOutcome.status === "blocked" || goalOutcome.status === "budget_exceeded") {
            return {
              status: "completed" as const,
              reason: goalOutcome.reason,
              resultKind: "blocked" as const,
            };
          }
          if (goalOutcome.status === "cancelled") {
            return { status: "aborted" as const, reason: goalOutcome.reason };
          }
          return {
            status: "paused" as const,
            reason: goalOutcome.reason,
            pauseKind: goalOutcome.status === "awaiting_input"
              ? "action_required" as const
              : "recoverable" as const,
          };
        });
      }

      return executeAgentLoop(callbacks, abortCtrl);
    };

    return prepareSubagentsForNewTurn().then(executeLoopStrategy).then(async (loopOutcome) => {
      const parentTurnId = context.uiDisplayTurnId || turnId;
      const subagentFinalization = await finalizeCoordinatedSubagentsForParent({
        threadId: runSessionKey,
        parentTurnId,
      });
      if (subagentFinalization.requestedIds.length > 0 || subagentFinalization.releasedCount > 0) {
        callbacks.onDebugEvent?.("parent_subagents_finalized", {
          parentTurnId,
          outcomeStatus: loopOutcome.status,
          ...subagentFinalization,
        });
      }
      const unresolvedIds = new Set([
        ...subagentFinalization.controllerMissingIds,
        ...subagentFinalization.timedOutIds,
      ]);
      closeProjectedSubagentRuns({
        ids: unresolvedIds,
        error: "SUBAGENT_PARENT_TERMINATED: the parent run ended before the child runtime settled.",
        title: "Closed with parent run",
        reason: "canceled",
      });
      clearInterval(timerInterval);
      let latestState = sessionGet();
      const queuedAfterRun = normalizeQueuedUserMessage(latestState.queuedUserMessage);
      const pendingPlanHandoff = latestState.pendingPlanApprovalHandoff as PlanApprovalHandoff | null;
      const pendingPlanLifecycle = latestState.planLifecycle as PlanLifecycleState | undefined;
      const pendingExecutionLease = pendingPlanLifecycle?.executionLease || null;
      const hasExactPendingPlanHandoff = !!pendingPlanHandoff &&
        !!pendingPlanLifecycle &&
        pendingPlanLifecycle.status === "handoff_pending" &&
        isPlanApprovalLeaseBoundToState(pendingPlanLifecycle) &&
        pendingPlanHandoff.planTurnId === turnId &&
        pendingExecutionLease?.executionLeaseId === pendingPlanHandoff.executionLeaseId &&
        pendingExecutionLease.executionRunId === pendingPlanHandoff.executionRunId &&
        pendingExecutionLease.parentRunId === pendingPlanHandoff.parentRunId &&
        pendingExecutionLease.attempt === pendingPlanHandoff.executionAttempt &&
        pendingExecutionLease.instructionHash === pendingPlanHandoff.executionInstructionHash;
      const pendingSameTurnExecution = hasExactPendingPlanHandoff ? pendingPlanHandoff : null;
      const ownedPendingAction = latestState.activeActionRequest as ActionRequest | null;
      const hasExactRejectedPlanActionContinuation =
        !!rejectedPlanActionContinuationIdentity &&
        pendingPlanLifecycle?.status === "paused" &&
        pendingPlanLifecycle.pause?.reason === "plan_action_continuation_admission_rejected" &&
        pendingPlanLifecycle.pause.resumeCondition === "explicit_resume" &&
        doesLifecycleRetainPlanExecutionProvenance(
          pendingPlanLifecycle,
          rejectedPlanActionContinuationIdentity,
        );
      if (hasExactRejectedPlanActionContinuation) {
        // The permission wait already emitted this exact Run's durable pause.
        // Preserve that non-terminal Turn boundary after child admission fails
        // so an explicit resume can mint a fresh attempt instead of targeting a
        // Turn that the finalizer has already completed.
        loopOutcome = {
          status: "paused",
          reason: "tool_permission",
          pauseKind: "recoverable",
        };
      }
      if (
        !hasExactRejectedPlanActionContinuation &&
        loopOutcome.status === "aborted" &&
        ownedPendingAction?.status === "pending" &&
        isActionRequestOwnedByRun(ownedPendingAction, {
          sessionKey: runSessionKey,
          turnId,
          runId: activeRuntimeRunIdentity.runId,
        })
      ) {
        loopOutcome = {
          status: "paused",
          reason: loopOutcome.reason || "action_required",
          pauseKind: "action_required",
        };
      }
      if (pendingSameTurnExecution) {
        loopOutcome = {
          status: "paused",
          reason: "plan_approval_handoff_pending",
          pauseKind: "recoverable",
        };
      }
      const preTerminalRunId = activeRuntimeRunIdentity.runId;
      const preConclusionLifecycleEvent = [...sessionGet().runtimeEvents].reverse().find((event: any) =>
        (isRunTerminalEvent(event) || isRunBoundaryEvent(event)) &&
        event.threadId === runSessionKey &&
        event.turnId === turnId &&
        event.runId === preTerminalRunId
      );
      if (loopOutcome.status !== "paused" && preConclusionLifecycleEvent?.type === "run.paused") {
        if (!beginTerminalConclusionRun(preTerminalRunId, loopOutcome.reason)) {
          // A canonical cancellation or a newer run already owns closure. A
          // stale workflow must not append an unowned child run.
          return true;
        }
      }
      // Approval is a lease boundary, not completion of the logical turn. Close
      // the review run as paused while the durable turn remains executing.
      const harnessProjection = pendingSameTurnExecution
        ? projectCurrentHarnessRunMarker("paused", "plan_approval_handoff_pending")
        : projectHarnessForAgentLoopOutcome(loopOutcome);
      if (harnessProjection === "ownership_lost") {
        logStoreEvent("terminal_run_publication_skipped", {
          reason: "harness_ownership_lost",
          sessionKey: runSessionKey,
          turnId,
          runId: activeRuntimeRunIdentity.runId,
        });
        return true;
      }
      if (pendingMaxIterationsAutoResume && (pendingSameTurnExecution || queuedAfterRun)) {
        pendingMaxIterationsAutoResume.cancel(
          pendingSameTurnExecution ? "plan_approval_handoff" : "queued_user_message",
        );
        pendingMaxIterationsAutoResume = null;
        latestState = sessionGet();
      }
      // The closed run marker, elapsed time, durable turn context, and terminal
      // turn status are staged off-store, persisted, then published together.
      const terminalProjection = await commitTerminalProjectionBeforeStatusPublication(
        loopOutcome,
        harnessProjection,
        { pendingSameTurnExecution: !!pendingSameTurnExecution },
      );
      if (!terminalProjection.committed) {
        logStoreEvent("terminal_run_publication_skipped", {
          reason: "harness_ownership_changed_before_publish",
          sessionKey: runSessionKey,
          turnId,
          runId: activeRuntimeRunIdentity.runId,
        });
        return true;
      }
      const completedFinalTextForRemote = terminalProjection.finalText;
      if (remoteFeishu && completedFinalTextForRemote) {
        const language = sessionGet().config.language === "en" ? "en" : "zh";
        void invoke("send_feishu_message", {
          chatId: remoteFeishu.chatId,
          userId: remoteFeishu.userId,
          openId: remoteFeishu.userId,
          messageId: remoteFeishu.messageId,
          text: completedFinalTextForRemote,
          feishuCardTitle: language === "en" ? "Task Complete" : "任务处理完成",
          feishuCardMarkdown: completedFinalTextForRemote,
          isFeishuReplyCard: true,
        }).catch(() => {});
      }
      latestState = sessionGet();
      if (pendingSameTurnExecution) {
        const attemptSameTurnExecutionFallback = (busyRetryAttempt: number) => {
          const latest = sessionGet();
          const latestSessionKey = resolveSessionRuntimeKey(
            resolveSessionWorkspaceKey(latest.currentWorkspace),
            latest.currentSessionId,
          );
          const liveLifecycle = latest.planLifecycle as PlanLifecycleState | undefined;
          const hasExactPlanApprovalHandoff = !!liveLifecycle &&
            liveLifecycle.status === "handoff_pending" &&
            isPlanApprovalLeaseBoundToState(liveLifecycle) &&
            liveLifecycle.executionLease?.executionLeaseId === pendingSameTurnExecution.executionLeaseId &&
            liveLifecycle.executionLease.executionRunId === pendingSameTurnExecution.executionRunId &&
            liveLifecycle.executionLease.attempt === pendingSameTurnExecution.executionAttempt;
          const decision = resolveApprovedPlanSameTurnFallbackDecision({
            expectedSessionKey: runSessionKey,
            currentSessionKey: latestSessionKey,
            expectedHandoff: pendingSameTurnExecution,
            currentHandoff: latest.pendingPlanApprovalHandoff,
            hasExactPlanApprovalHandoff,
            isAgentBusy:
              latest.isGenerating ||
              latest.agentStatus === "running" ||
              latest.agentStatus === "pending_review",
            busyRetryAttempt,
            maxBusyRetries: 1,
          });
          if (decision === "session_changed") {
            latest.updateRuntimeForSession?.(runSessionKey, { pendingPlanApprovalHandoff: null });
            logStoreEvent("plan_approval_handoff_skipped", {
              reason: "session_changed",
              planTurnId: pendingSameTurnExecution.planTurnId,
              executionTurnId: pendingSameTurnExecution.planTurnId,
              expectedSessionKey: runSessionKey,
              latestSessionKey,
            });
            return;
          }
          if (decision === "transition_stale") {
            logStoreEvent("plan_approval_handoff_skipped", {
              reason: "transition_stale",
              planTurnId: pendingSameTurnExecution.planTurnId,
              executionTurnId: pendingSameTurnExecution.planTurnId,
              busyRetryAttempt,
              currentHandoff: latest.pendingPlanApprovalHandoff,
              planApprovalExecutionStartedForTurnId: latest.planApprovalExecutionStartedForTurnId,
            });
            return;
          }
          if (decision === "retry_busy") {
            logStoreEvent("plan_approval_handoff_rescheduled", {
              reason: "agent_busy",
              planTurnId: pendingSameTurnExecution.planTurnId,
              executionTurnId: pendingSameTurnExecution.planTurnId,
              busyRetryAttempt,
              nextBusyRetryAttempt: busyRetryAttempt + 1,
              agentStatus: latest.agentStatus,
              isGenerating: latest.isGenerating,
            });
            runAfterNextPaint(() => attemptSameTurnExecutionFallback(busyRetryAttempt + 1));
            return;
          }
          if (decision === "busy_retry_exhausted") {
            logStoreEvent("plan_approval_handoff_skipped", {
              reason: "agent_busy_retry_exhausted",
              planTurnId: pendingSameTurnExecution.planTurnId,
              executionTurnId: pendingSameTurnExecution.planTurnId,
              busyRetryAttempt,
              agentStatus: latest.agentStatus,
              isGenerating: latest.isGenerating,
              pendingPlanApprovalHandoff: latest.pendingPlanApprovalHandoff,
              conversationTurns: latest.conversationTurns.length,
            });
            return;
          }
          startApprovedPlanExecutionInCurrentTurn({
            get: sessionGet,
            setActiveState: (patch) => sessionSet(patch as any),
            planTurnId: pendingSameTurnExecution.planTurnId,
            handoff: pendingSameTurnExecution,
            sessionKey: runSessionKey,
            source: "workflow_fallback",
          });
        };
        runAfterNextPaint(() => attemptSameTurnExecutionFallback(0));
      } else if (queuedAfterRun) {
        if (latestState.agentStatus === "pending_review") {
          // Skip dequeuing if agentStatus is pending_review so the message stays in composer queue bar
          return false;
        }

        runAfterNextPaint(() => {
          const latest = sessionGet();
          const latestSessionKey = resolveSessionRuntimeKey(
            resolveSessionWorkspaceKey(latest.currentWorkspace),
            latest.currentSessionId,
          );
          if (latestSessionKey !== runSessionKey) {
            logStoreEvent("queued_user_message_skipped", {
              reason: "session_changed",
              expectedSessionKey: runSessionKey,
              latestSessionKey,
            });
            return;
          }
          if (latest.agentStatus === "pending_review") {
            logStoreEvent("queued_user_message_skipped", {
              reason: "agent_pending_review",
              agentStatus: latest.agentStatus,
            });
            return;
          }
          if (latest.isGenerating || latest.agentStatus === "running") {
            logStoreEvent("queued_user_message_deferred", {
              reason: "newer_run_active",
              agentStatus: latest.agentStatus,
              isGenerating: latest.isGenerating,
            });
            return;
          }
          logStoreEvent("queued_user_message_sending", {
            chars: queuedAfterRun.text.length,
            images: queuedAfterRun.images?.length || 0,
            contextMentions: queuedAfterRun.contextMentions?.length || 0,
            attachedFiles: queuedAfterRun.attachedFiles?.length || 0,
          });
          let started = false;
          try {
            started = latest.sendMessage(queuedAfterRun.text, queuedAfterRun.images, {
              contextMentionsSnapshot: queuedAfterRun.contextMentions || [],
              attachedFilesSnapshot: queuedAfterRun.attachedFiles || [],
              runtimeIntentOverride: queuedAfterRun.runtimeIntentOverride,
              goalSourceContextSnapshot: queuedAfterRun.goalSourceContextSnapshot,
              goalContinuationGuidance: queuedAfterRun.goalContinuationGuidance,
              queuedUserMessageId: queuedAfterRun.id,
            }) === true;
          } catch (error) {
            logStoreEvent("queued_user_message_submission_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          if (!started) {
            logStoreEvent("queued_user_message_submission_rejected", {
              chars: queuedAfterRun.text.length,
            });
            return;
          }

          // Keep the payload durable until the new run has synchronously
          // acquired its lease. A rejected submission remains visible/retryable.
          sessionSet({
            queuedUserMessage: null,
            input: "",
            contextMentions: [],
            attachedFiles: [],
          });
        });
      } else if (pendingMaxIterationsAutoResume) {
        const pending = pendingMaxIterationsAutoResume;
        pendingMaxIterationsAutoResume = null;
        logStoreEvent(`${pending.kind}_max_iterations_auto_resume_scheduled`, {});
        runAfterNextPaint(() => pending.start());
      }

      return true;
    }).catch(async (err: any) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const alreadyCommittedRunLifecycleEvent = sessionGet().runtimeEvents.find((event: any) =>
        (isRunTerminalEvent(event) || isRunBoundaryEvent(event)) &&
        event.threadId === runSessionKey &&
        event.turnId === turnId &&
        event.runId === activeRuntimeRunIdentity.runId
      );
      const alreadyCommittedTurn = sessionGet().runtimeEvents.some((event: any) =>
        isTerminalTurnEvent(event) &&
        event.threadId === runSessionKey &&
        event.turnId === turnId
      );
      if (
        alreadyCommittedRunLifecycleEvent &&
        alreadyCommittedTurn &&
        sessionGet().harnessRunMarker?.status !== "running"
      ) {
        logStoreEvent("post_terminal_exception_recorded", {
          sessionKey: runSessionKey,
          turnId,
          runId: activeRuntimeRunIdentity.runId,
          lifecycleEventType: alreadyCommittedRunLifecycleEvent.type,
          error: errorMessage,
        });
        return false;
      }
      const catchLifecycle = sessionGet().planLifecycle as PlanLifecycleState | undefined;
      const preservesRejectedPlanActionPause =
        alreadyCommittedRunLifecycleEvent?.type === "run.paused" &&
        !!rejectedPlanActionContinuationIdentity &&
        catchLifecycle?.status === "paused" &&
        catchLifecycle.pause?.reason === "plan_action_continuation_admission_rejected" &&
        catchLifecycle.pause.resumeCondition === "explicit_resume" &&
        doesLifecycleRetainPlanExecutionProvenance(
          catchLifecycle,
          rejectedPlanActionContinuationIdentity,
        );
      if (preservesRejectedPlanActionPause) {
        const pauseOutcome: AgentLoopOutcome = {
          status: "paused",
          reason: "tool_permission",
          pauseKind: "recoverable",
        };
        const pauseHarnessProjection = projectCurrentHarnessRunMarker(
          "paused",
          "tool_permission",
        );
        clearInterval(timerInterval);
        if (pauseHarnessProjection === "ownership_lost") {
          logStoreEvent("plan_action_continuation_pause_publication_skipped", {
            reason: "harness_ownership_lost",
            error: errorMessage,
          });
          return true;
        }
        const parentTurnId = context.uiDisplayTurnId || turnId;
        const subagentFinalization = await finalizeCoordinatedSubagentsForParent({
          threadId: runSessionKey,
          parentTurnId,
        }).catch(() => null);
        if (subagentFinalization) {
          closeProjectedSubagentRuns({
            ids: [
              ...subagentFinalization.controllerMissingIds,
              ...subagentFinalization.timedOutIds,
            ],
            error: "SUBAGENT_PARENT_PAUSED: the parent Plan Run paused after child admission was rejected.",
            title: "Closed with paused Plan run",
            reason: "canceled",
          });
        }
        const pauseProjection = await commitTerminalProjectionBeforeStatusPublication(
          pauseOutcome,
          pauseHarnessProjection,
        ).catch((pauseError) => {
          logStoreEvent("plan_action_continuation_pause_publication_failed", {
            error: pauseError instanceof Error ? pauseError.message : String(pauseError),
            triggerError: errorMessage,
          });
          return { committed: false, finalText: null };
        });
        logStoreEvent("plan_action_continuation_exception_preserved_pause", {
          triggerError: errorMessage,
          committed: pauseProjection.committed,
        });
        return !pauseProjection.committed;
      }
      if (alreadyCommittedRunLifecycleEvent?.type === "run.paused") {
        beginTerminalConclusionRun(
          activeRuntimeRunIdentity.runId,
          "terminal_error_after_paused_run",
        );
      }
      const errorOutcome: AgentLoopOutcome = {
        status: "completed",
        reason: errorMessage,
        resultKind: "error",
      };
      const errorHarnessProjection = projectCurrentHarnessRunMarker(
        "completed",
        "agent_loop_error_conclusion",
        true,
      );
      if (errorHarnessProjection === "ownership_lost") {
        clearInterval(timerInterval);
        logStoreEvent("stale_run_error_publication_skipped", {
          sessionKey: runSessionKey,
          turnId,
          runId: activeRuntimeRunIdentity.runId,
          error: errorMessage,
        });
        return true;
      }
      const parentTurnId = context.uiDisplayTurnId || turnId;
      const subagentFinalization = await finalizeCoordinatedSubagentsForParent({
        threadId: runSessionKey,
        parentTurnId,
      }).catch(() => null);
      if (subagentFinalization) {
        callbacks.onDebugEvent?.("parent_subagents_finalized", {
          parentTurnId,
          outcomeStatus: "completed",
          outcomeKind: "error",
          ...subagentFinalization,
        });
        closeProjectedSubagentRuns({
          ids: [
            ...subagentFinalization.controllerMissingIds,
            ...subagentFinalization.timedOutIds,
          ],
          error: "SUBAGENT_PARENT_CRASHED: the parent run crashed before the child runtime settled.",
          title: "Closed after parent failure",
          reason: "canceled",
        });
      }
      clearInterval(timerInterval);
      logStoreEvent("agent_loop_crashed", {
        turnId,
        error: errorMessage,
        stack: err instanceof Error ? err.stack?.slice(0, 1200) : null,
        stopClass: "unrecoverable_error",
      });
      // Preserve the technical incident as evidence; the assistant final below
      // owns the user-facing conclusion.
      const crashId = sessionGet()._nextTaskId();
      sessionSet((s: any) => ({
        taskFlow: [...s.taskFlow, {
          id: crashId,
          turnId,
          type: "system" as const,
          content: `❌ Agent loop crashed: ${errorMessage}`,
        }],
        conversationTurns: s.conversationTurns.map((turn: any) =>
          turn.id === turnId
            ? {
                ...turn,
                summary: errorMessage,
                blockIds: turn.blockIds.includes(crashId)
                  ? turn.blockIds
                  : [...turn.blockIds, crashId],
              }
            : turn
        ),
      }));

      let terminalProjection: { committed: boolean; finalText: string | null };
      try {
        terminalProjection = await commitTerminalProjectionBeforeStatusPublication(
          errorOutcome,
          errorHarnessProjection,
        );
      } catch (terminalError) {
        const terminalErrorMessage = terminalError instanceof Error
          ? terminalError.message
          : String(terminalError);
        terminalProjection = await publishEmergencyErrorConclusion({
          reason: `${errorMessage}; terminal publication recovery: ${terminalErrorMessage}`,
          triggerError: terminalErrorMessage,
        });
      }
      const finalText = terminalProjection.finalText;
      if (remoteFeishu && finalText && terminalProjection.committed) {
        const language = sessionGet().config.language === "en" ? "en" : "zh";
        void invoke("send_feishu_message", {
          chatId: remoteFeishu.chatId,
          userId: remoteFeishu.userId,
          openId: remoteFeishu.userId,
          messageId: remoteFeishu.messageId,
          text: finalText,
          feishuCardTitle: language === "en" ? "Task Conclusion" : "任务结论",
          feishuCardMarkdown: finalText,
          isFeishuReplyCard: true,
        }).catch(() => {});
      }

      return false;
    });
  }
}

function sanitizeFinalTextForPersist(params: { visibleText: string; language: "zh" | "en" }): string {
  const visible = String(params.visibleText || "").trim();
  if (visible) return visible;
  return params.language === "en" ? "No visible reply was produced." : "本轮未生成可见回复。";
}
