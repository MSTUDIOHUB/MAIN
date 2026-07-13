import { executeAgentLoop, getSessionTaskTargetingEvidence, isReviewablePlanStage, type AgentLoopOutcome, type OrchestratorCallbacks } from "../orchestrator";
import { executeGoalLoop, type GoalEngineCallbacks } from "../goalEngine";
import { mergeGoalToolObservations, type GoalToolObservation } from "../goalRuntime";
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
  withEventSchema,
  type MainThreadProgressUpdate,
} from "../turnEvents";
import { type DurableTurnContext, type PlanExecutionProgressPhase, type PlanExecutionProgressUpdate, getPlanArtifactTitle, extractPlanTasks, isEphemeralPlanArtifactPath, reconcilePlanTaskCompletion, canonicalizePlanArtifactPath, detectPlanArtifactKind } from "../workflowModels";
import {
  buildPlanExecutionProgressUpdate,
  normalizePlanExecutionProgressSnapshot,
  resolveApprovedPlanSameTurnFallbackDecision,
  toPlanExecutionRuntimeProgressUpdate,
} from "../planExecutionRecovery";
import { createPlanExecutionEvidenceEntry, appendPlanEvidenceEntry } from "../planEvidence";
import { closeHarnessRunMarker, getHarnessActionRunId, isHarnessRunMarkerOwnedByRun, persistHarnessRunMarkerIfOwned, type HarnessRunMarker } from "../harnessCrashTelemetry";
import { generateId } from "../utils";
import { runAfterNextPaint } from "../uiScheduling";
import { supportsToolDiffPreview } from "../toolDiff";
import { findToolLifecycleBlockIndex, type ToolLifecycleMeta } from "../toolLifecycle";
import { deriveToolIntentSummary } from "../toolPresentation";
import { buildToolProgressNarration, summarizeToolObservation } from "../progressNarration";
import { deriveTurnRuntimePhaseForTool, withTurnRuntimePhaseStatus } from "../turnPhase";
import { scheduleControlledSubagent } from "../subagentRuntime";
import { getCoordinatedSubagentRunCount, parseSubagentAllowedPaths, waitForCoordinatedSubagents } from "../subagents";
import {
  buildGoalConfirmationActionRequest,
  buildPlanReviewActionRequest,
  buildUserChoiceActionRequest,
  isActionRequestOwnedByRun,
  toUserChoiceResolutionIdentity,
  type ActionRequest,
  type UserChoiceActionRequest,
} from "../actionRequest";
import { buildToolPermissionActionRequest } from "../pendingToolReview";
import { buildPlanApprovalIdentity } from "../planApprovalIdentity";
import { resolveRuntimeRunIdentity, type RuntimeRunIdentity } from "../runIdentity";
import { buildDurableTurnContext, shouldCanonicalizeTerminalTurnContext } from "../durableTurnContext";
import { reduceRunTransition } from "../runTransitionReducer";
import { findLatestRunOwnedAgentBlock } from "./runOwnedAgentBlocks";

type WorkflowStoreState = any;

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
  startApprovedPlanExecutionInCurrentTurn: (input: {
    get: () => WorkflowStoreState;
    setActiveState: (patch: Record<string, unknown>) => void;
    planTurnId: string;
    handoff: {
      planTurnId: string;
      requestedAt: number;
      executionTurnId?: string;
      prompt?: string;
      planRevision?: number;
      artifactHash?: string;
      artifactPaths?: string[];
      parentRunId?: string | null;
    };
    sessionKey: string;
    source: "workflow_fallback";
  }) => void;
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
      startApprovedPlanExecutionInCurrentTurn,
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
    // const attachedFilesSnapshot = context.attachedFilesSnapshot;
    // const mentionSnapshot = context.mentionSnapshot;
    const remoteFeishu = context.remoteFeishu;
    const workspaceTree = context.workspaceTree;
    const gameStudioConfigForTurn = context.gameStudioConfigForTurn;
    const abortCtrl = context.abortCtrl;
    const timerInterval = context.timerInterval;
    const sendStartedAt = context.sendStartedAt;
    const harnessRunOwner = {
      runId: context.harnessRunId,
      sessionKey: runSessionKey,
      turnId,
    };
    const initialHarnessMarker = sessionGet().harnessRunMarker as HarnessRunMarker | null;
    let activeRuntimeRunIdentity: RuntimeRunIdentity = {
      runId: context.harnessRunId,
      parentRunId:
        initialHarnessMarker?.runId === context.harnessRunId
          ? initialHarnessMarker.parentRunId || null
          : null,
      outerRunId: context.harnessRunId,
      source: "harness_marker",
    };
    let lastNonActionableStopDiagnostic: {
      reason: string;
      recoveryReason: string | null;
      phase: string | null;
      nextStep: string | null;
      repeatedTargets: string[];
    } | null = null;
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
      sessionSet((state: any) => ({
        runtimeEvents: appendRuntimeEvent(state.runtimeEvents, withEventSchema(event as any)),
      }));
    };

    const publishActionRequest = (
      request: ActionRequest,
      input: { reason: string; target?: string; pauseMessage: string },
    ) => {
      sessionSet((state: any) => reduceRunTransition(state, {
        type: "action_required",
        request,
        events: [
          withEventSchema({
            type: "approval.requested",
            threadId: runSessionKey,
            turnId: request.turnId,
            timestampMs: Date.now(),
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
          withEventSchema({
            type: "run.paused",
            threadId: runSessionKey,
            turnId: request.turnId,
            timestampMs: Date.now(),
            runId: request.runId,
            parentRunId: request.parentRunId || null,
            ...(activeRuntimeRunIdentity.goalSliceId
              ? { goalSliceId: activeRuntimeRunIdentity.goalSliceId }
              : {}),
            reason: input.reason,
            message: input.pauseMessage,
          }),
        ],
      }));
      logStoreEvent("action_request_created", {
        sessionKey: request.sessionKey,
        turnId: request.turnId,
        runId: request.runId,
        parentRunId: request.parentRunId || null,
        requestId: request.requestId,
        actionKind: request.kind,
        goalSliceId: activeRuntimeRunIdentity.goalSliceId || null,
        reason: input.reason,
        target: input.target || null,
      });
    };

    const beginActionContinuationRun = (request: ActionRequest) => {
      const previous = activeRuntimeRunIdentity;
      const nextRunId = `run-action-${Date.now()}-${generateId()}`;
      activeRuntimeRunIdentity = {
        runId: nextRunId,
        parentRunId: request.runId,
        outerRunId: previous.outerRunId,
        ...(previous.goalSliceId ? { goalSliceId: previous.goalSliceId } : {}),
        source: previous.source,
      };
      updateHarnessRunMarker({
        activeRunId: nextRunId,
        activeParentRunId: request.runId,
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

    const isNoOpToolResult = (text: string) =>
      /FILE_UNCHANGED_STUB|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT|empty_change|invalid_patch|identical_content|no changes|no-op|nothing to (?:change|patch|write)|"noOp"\s*:\s*true/i.test(text);

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

	    const closeCurrentHarnessRunMarker = (status: "completed" | "paused" | "error", reason: string) => {
	      const runtimeAtClose = sessionGet();
	      const marker = runtimeAtClose.harnessRunMarker;
	      if (isHarnessRunMarkerOwnedByRun(marker, harnessRunOwner)) {
	        const closedAt = Date.now();
        const nextMarker: HarnessRunMarker = {
          ...marker,
          status,
          planStage: runtimeAtClose.planStage,
          isPlanApproved: runtimeAtClose.isPlanApproved,
          updatedAt: closedAt,
          closedAt,
          closeReason: reason,
        };
	        sessionSet({ harnessRunMarker: nextMarker });
	        closeHarnessRunMarker({ status, closeReason: reason }, harnessRunOwner);
	        const latestRuntime = sessionGet();
	        logStoreEvent("agent_loop_stop_summary", {
	          turnId,
	          sessionKey: runSessionKey,
	          workspace: runWorkspace || null,
	          status,
	          reason,
	          workflowMode: marker.workflowMode,
	          runtimeIntent: marker.runtimeIntent,
	          // Plan review and approval can change while the same run marker is
	          // alive. Report reducer-owned current state, not the immutable
	          // start snapshot (the latest log incorrectly said planStage=idle
	          // immediately after plan.md revision 1 reached review).
	          planStage: latestRuntime.planStage,
	          isPlanApproved: latestRuntime.isPlanApproved,
	          iteration: marker.iteration,
	          maxIterations: marker.maxIterations,
	          latestTool: marker.latestTool || null,
	          latestToolTarget: marker.latestToolTarget || null,
	          activeStreamId: marker.activeStreamId || null,
	          streamStatus: marker.streamStatus || null,
	          streamElapsedMs: marker.streamElapsedMs || 0,
	          streamLifecycleStatus: marker.streamLifecycleStatus || null,
	          lastStreamError: marker.lastStreamError || null,
	          stopDiagnostic: lastNonActionableStopDiagnostic,
	        });
	      }
	      else if (marker?.status === "running") {
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
      getIntentPolicy(sessionGet().getCurrentRunIntent()).workflowMode === "plan" &&
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

    const emitPlanStreamHeartbeat = (marker: any) => {
      const previous = sessionGet().planExecutionProgressSnapshot;
      if (!previous || previous.turnId !== turnId) return;
      const currentTool = marker.currentToolName
        ? [
            marker.currentToolName,
            marker.currentToolInputKey,
            marker.currentToolInputTarget,
          ].filter(Boolean).join(" · ")
        : "";
      const zh = phaseLanguage === "zh";
      const streamStatus = marker.streamStatus;
      emitLocalPlanExecutionProgress("running", {
        iteration: marker.iteration || previous.iteration || 0,
        maxIterations: marker.maxIterations || previous.maxIterations || PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
        currentTask: previous.currentTask,
        currentTool,
        latestEvidence: previous.latestEvidence,
        nextStep: streamStatus === "no_chunk_progress_warning"
          ? zh
            ? "模型仍在流式生成但间隔偏长；可继续等待，或停止后查看日志与恢复点"
            : "model is still streaming with a long gap; keep waiting or stop and inspect logs/recovery details"
          : zh
          ? "模型仍在生成；ChatArea 会持续显示流式进度"
          : "model is still generating; ChatArea will keep showing stream progress",
        progressSignature: previous.progressSignature,
        repeatedTargets: previous.repeatedTargets,
        recoveryReason: streamStatus === "no_chunk_progress_warning"
          ? "stream_no_chunk_progress"
          : previous.recoveryReason,
      });
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
        }
        return {
          harnessRunMarker: nextMarker,
        };
      });
    };

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
        sessionSet((state: any) => reduceRunTransition(state, { type: "runtime_event", event }));
      },
      hasSessionHookInitialized: (key: string) => sessionGet().hasSessionHookInitialized(key),
      markSessionHookInitialized: (key: string) => sessionGet().markSessionHookInitialized(key),
      onInstructionsResolved: (resolved: any) => sessionGet().setResolvedInstructionSet(resolved),
      onHooksLoaded: (hooks: any, loadedAt: any) => sessionGet().setLoadedHookDefinitions(hooks, loadedAt),
      onHookStart: (_event: any, _hook: any) => { /* UI feedback placeholder */ },
      onHookResult: (record: any) => sessionGet().appendHookExecutionRecords([record]),
      onHookBlocked: (_event: any, _reason: any, _record: any) => { /* UI feedback placeholder */ },
      getCurrentRunIntent: () => sessionGet().getCurrentRunIntent(),
      getRuntimeRunIntent: () => runtimeRunIntent,
      getExecutionConsentGranted: () => {
        const consent = sessionGet().currentTurnExecutionConsent;
        return consent?.granted === true && !!consent.turnId && consent.turnId === turnId;
      },
      getForcedExecuteRecoveryMode: () => options?.forceExecuteRecoveryMode ?? null,
      getCommandDirective: () => effectiveCommandDirective,
      getWorkflowMode: () => getIntentPolicy(sessionGet().getCurrentRunIntent()).workflowMode,
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
      getIsApprovedPlanExecutionTransitionPending: () =>
        sessionGet().pendingPlanApprovalHandoff?.planTurnId === turnId &&
        sessionGet().planApprovalExecutionStartedForTurnId !== turnId,
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
      onApprovedPlanExecutionStarted: () => {
        const pendingHandoff = sessionGet().pendingPlanApprovalHandoff;
        const startedForTurn = sessionGet().planApprovalExecutionStartedForTurnId;
        if (startedForTurn === turnId) {
          logStoreEvent("plan_approval_handoff_deduped", {
            reason: "same_turn_execution_already_started",
            planTurnId: turnId,
            executionTurnId: turnId,
            currentTurnStatus: sessionGet().conversationTurns.find((turn: any) => turn.id === turnId)?.status ?? null,
            agentStatus: sessionGet().agentStatus,
            isGenerating: sessionGet().isGenerating,
            pendingPlanApprovalHandoff: pendingHandoff,
            conversationTurns: sessionGet().conversationTurns.length,
          });
          return;
        }
        if (pendingHandoff && pendingHandoff.planTurnId !== turnId) {
          logStoreEvent("plan_approval_handoff_ignored", {
            reason: "different_pending_plan_turn",
            planTurnId: turnId,
            pendingPlanTurnId: pendingHandoff.planTurnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
          });
          return;
        }
        const language = sessionGet().config.language === "en" ? "en" : "zh";
        const previousSnapshot = sessionGet().planExecutionProgressSnapshot;
        const progressSnapshot = normalizePlanExecutionProgressSnapshot({
          turnId,
          update: {
            ...buildPlanExecutionProgressUpdate({
              language,
              phase: "starting",
              iterationCount: 0,
              maxIterations: PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
              autoResumeCount: 0,
              tasks: sessionGet().planTasks,
              evidenceLedger: [],
              recentToolActivity: [],
              nextStep: language === "zh"
                ? "在当前回合按已批准 plan.md 继续执行"
                : "continue in the current turn and follow the approved plan.md",
            }),
            runId: activeRuntimeRunIdentity.runId,
            parentRunId: activeRuntimeRunIdentity.parentRunId || null,
          },
          previous: previousSnapshot?.runId && previousSnapshot.runId !== activeRuntimeRunIdentity.runId
            ? null
            : previousSnapshot,
          now: Date.now(),
        });
        sessionSet((s: any) => ({
          currentTurnExecutionConsent: { turnId, granted: true },
          pendingPlanApprovalHandoff: null,
          planApprovalExecutionStartedForTurnId: turnId,
          planExecutionProgressSnapshot: progressSnapshot,
          currentTurnState: {
            ...s.currentTurnState,
            capsuleExplanation: null,
          },
          planStage: "executing",
          agentStatus: "running",
          isGenerating: true,
          conversationTurns: s.conversationTurns.map((turn: any) =>
            turn.id === turnId
              ? {
                  ...turn,
                  status: "executing",
                  summary: language === "zh"
                    ? "计划已批准，正在当前回合继续执行。"
                    : "Plan approved; execution is continuing in the current turn.",
                }
              : turn,
          ),
        }));
        updateHarnessRunMarker({
          turnId,
          runtimeIntent: "execute",
          planStage: "executing",
          isPlanApproved: true,
          status: "running",
        });
        emitProgressRuntimeEvent(
          toPlanExecutionRuntimeProgressUpdate({
            snapshot: progressSnapshot,
            language,
            dedupeKey: `plan-execution-progress:${activeRuntimeRunIdentity.runId}`,
          }),
        );
        logStoreEvent("plan_approval_same_turn_execution_started", {
          planTurnId: turnId,
          executionTurnId: turnId,
          currentTurnStatus: sessionGet().conversationTurns.find((turn: any) => turn.id === turnId)?.status ?? null,
          agentStatus: sessionGet().agentStatus,
          isGenerating: sessionGet().isGenerating,
          pendingPlanApprovalHandoff: pendingHandoff,
          conversationTurns: sessionGet().conversationTurns.length,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
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
      onHarnessRunUpdate: (patch: any) => {
        const markerPatch = patch as Partial<HarnessRunMarker> & Record<string, unknown>;
        updateHarnessRunMarker(markerPatch);
        emitPlanStreamHeartbeat(markerPatch);
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
          context.firstStreamTokenAt = Date.now();
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

      onAssistantFinalText: (text: any, replyOptions: any[] = [], meta: any) => {
        const hasToolCalls = meta?.hasToolCalls === true;
        const awaitingInput = meta?.awaitingInput === true && replyOptions.length > 0;
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

        // Resolve Feishu adaptive card sending. Text emitted before a tool call is
        // progress, not completion, so remote replies wait for the final answer.
        if (remoteFeishu && !hasToolCalls && !provisionalPlanCandidate) {
          const cardTitle = sessionGet().config.language === "en" ? "Task Complete" : "任务处理完成";
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
            const existingAgentBlock = [...taskFlow]
              .reverse()
              .find((block) =>
                block.turnId === turnId &&
                block.type === "agent" &&
                !block.archivedAfterChoice
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
                    summary: normalizedFinal || turn.summary,
                  }
                : {
                    ...turn,
                    status: turn.status === "awaiting_approval" || turn.status === "done" ? turn.status : "done",
                    summary: normalizedFinal,
                  }
              : turn
          );

          if (awaitingInput) {
            return {
              taskFlow,
              conversationTurns,
              agentStatus: "idle",
              isGenerating: false,
              abortController: null,
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
            agentStatus: s.agentStatus === "pending_review" ? "pending_review" : "idle",
            isGenerating: false,
            ...(s.agentStatus === "pending_review" ? {} : { abortController: null }),
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
        const noOp = isNoOpToolResult(resultText);
        const entry = createPlanExecutionEvidenceEntry({
          toolName,
          target,
          result: resultText,
          noOp,
          diff: completedDiff,
        });
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
          status: "done",
          source: "tool_result",
          turnIntent: effectiveRunIntent,
          workflowMode: sessionGet().config.workflowMode,
          previousObservation: observationSummary,
          result: resultText,
          noOp,
          hypothesisStatus: noOp ? "blocked" : "confirmed",
          sourceToolCallIds: executionId ? [executionId] : [],
        });
        logStoreEvent("tool_result", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          toolName,
          executionId,
          resultChars: result?.length ?? 0,
          isError: false,
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

          const nextLedger = appendPlanEvidenceEntry(s.planExecutionEvidenceLedger || [], entry);
          const nextTasks = reconcilePlanTaskCompletion(
            s.planTasks || [],
            s.planTasks || [],
            nextLedger,
            {
              preserveMissing: s.isPlanApproved || s.planStage === "executing" || s.planStage === "completed" || s.planTasks.length > 0,
              highlightNext: s.isPlanApproved && nextLedger.length > 0,
            }
          );

          return {
            planExecutionEvidenceLedger: nextLedger,
            planExecutionEvidenceCount: nextLedger.length,
            planTasks: nextTasks,
            taskFlow: s.taskFlow.map((block: any, index: number) => {
              if (index !== existingIndex) return block;
              const completedPhase = withTurnRuntimePhaseStatus(
                block.turnPhase || deriveTurnRuntimePhaseForTool({
                  toolName,
                  target,
                  language: phaseLanguage,
                  status: "done",
                }),
                "done",
                phaseLanguage,
              );
              return {
                ...block,
                status: "done",
                toolStatus: "executed",
                output: resultText,
                message: resultText,
                ...(completedDiff ? { diff: completedDiff } : block.diff ? { diff: block.diff } : {}),
                intentSummary: block.intentSummary || deriveToolIntentSummary({
                  toolName,
                  target,
                  language: phaseLanguage,
                  status: "done",
                  toolStatus: "executed",
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

      onToolError: (toolName: string, target: string, error: string, meta?: { toolCallId?: string }) => {
        const lifecycleMeta = normalizeToolLifecycleMeta(meta);
        const executionId = lifecycleMeta.toolCallId || undefined;
        const errorText = String(error || "");
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
        logStoreEvent("tool_result", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          toolName,
          executionId,
          resultChars: error?.length ?? 0,
          isError: true,
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
          return {
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
          });
          publishActionRequest(permissionRequest, {
            reason: "tool_permission",
            target: permissionRequest.target,
            pauseMessage: phaseLanguage === "zh"
              ? `等待批准：${permissionRequest.toolName} · ${permissionRequest.target}`
              : `Awaiting approval: ${permissionRequest.toolName} · ${permissionRequest.target}`,
          });
          sessionSet({
            pendingReviewResolve: (decision: any) => {
              beginActionContinuationRun(permissionRequest);
              resolve(decision);
            },
          });
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

      onStatusChange: (status: "idle" | "running" | "pending_review" | "error") => {
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
          ...(status === "idle" || status === "error" ? { abortController: null } : {}),
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
        sessionSet({ agentStatus: "error", isGenerating: false, abortController: null });
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
        const stoppedStatus = reason === "no_output"
          ? "stopped_no_output"
          : progress?.recoveryReason === "approved_plan_completion_guard_no_evidence"
          ? "stopped_no_action"
          : reason === "incomplete_plan"
          ? "paused"
          : "stopped_no_action";
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
                  content: `❌ **${message}**`,
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
            variant: "execution_checkpoint",
          } as TaskBlock;
          taskFlow = [...taskFlow, stopBlock];

          return {
            taskFlow,
            conversationTurns: s.conversationTurns.map((turn: any) =>
              turn.id === turnId && turn.status !== "awaiting_approval"
                ? {
                    ...turn,
                    status: stoppedStatus,
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
        const invalidatesApprovedExecution =
          liveBeforeRejection.isPlanApproved === true &&
          (kind === "plan" || kind === "design" || kind === "bugfix") &&
          (!!rejectedApprovedArtifact || pendingApprovedReviewOwnsPath);

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
          logStoreEvent("plan_artifact_rejection_invalidated_state", {
            path: canonicalPath,
            reportedPath: path,
            kind,
            reason,
            removedExistingArtifact: !!rejectedArtifact,
            clearedPlanReviewRequest: pendingReviewOwnsPath,
            invalidatedApproval: invalidatesApproval,
            preservedApprovedTasksExecutionStage: preserveApprovedTasksExecutionStage,
            nextStage,
          });
          return {
            planArtifacts: nextArtifacts,
            planStage: nextStage,
            showPlanPanel: nextArtifacts.length > 0 && state.showPlanPanel,
            ...(pendingReviewOwnsPath ? { activeActionRequest: null } : {}),
            ...(invalidatesApproval
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
        sessionSet({ planStage: stage });
      },

      onPlanApprovalInvalidated: (reason: string) => {
        const currentIdentity = buildPlanApprovalIdentity(sessionGet().planArtifacts);
        sessionSet((state: any) => ({
          isPlanApproved: false,
          planApprovalChoice: null,
          pendingPlanApprovalHandoff: null,
          planApprovalExecutionStartedForTurnId: null,
          activeActionRequest: null,
          agentStatus: currentIdentity ? "pending_review" : "idle",
          isGenerating: false,
          conversationTurns: state.conversationTurns.map((candidate: any) =>
            candidate.id === turnId
              ? {
                  ...candidate,
                  status: currentIdentity ? "awaiting_approval" : "paused",
                  summary: phaseLanguage === "zh"
                    ? "计划内容在批准后发生变化，旧批准已失效。"
                    : "The plan changed after review, so the previous approval is stale.",
                }
              : candidate
          ),
        }));
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
        if (isUnapprovedPlanRuntime()) return;
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
      const parentEvidencePaths = [...getSessionTaskTargetingEvidence(runSessionKey)]
        .filter((entry) => entry.startsWith("file:"))
        .map((entry) => entry.slice("file:".length));
      const duplicateCount = allowedPaths.filter((allowed) => parentEvidencePaths.some((path) =>
        path === allowed || path.startsWith(`${allowed}/`) || allowed.startsWith(`${path}/`)
      )).length;
      const independentReviewer = /reviewer|independent[_ -]?review/i.test(request.role || "");
      if (!independentReviewer && allowedPaths.length > 0 && duplicateCount / allowedPaths.length > 0.5) {
        callbacks.onDebugEvent?.("delegation_scope_decision", {
          decision: "rejected",
          reason: "duplicate_parent_scope",
          allowedPaths,
          duplicateCount,
        });
        return Promise.reject(new Error(
          `SUBAGENT_DUPLICATE_SCOPE: ${duplicateCount}/${allowedPaths.length} allowed paths were already explored by the parent. Delegate an independent scope or use role=reviewer for an explicit independent review.`,
        ));
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
    callbacks.waitSubagents = async (request) => {
      const parentTurnId = context.uiDisplayTurnId || turnId;
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
      });
      return result;
    };

    const closeHarnessForAgentLoopOutcome = (outcome: AgentLoopOutcome) => {
      switch (outcome.status) {
        case "completed":
          closeCurrentHarnessRunMarker("completed", outcome.reason || "agent_loop_completed");
          break;
        case "paused":
          closeCurrentHarnessRunMarker("paused", outcome.reason || "agent_loop_paused");
          break;
        case "stopped_no_output":
          closeCurrentHarnessRunMarker("paused", outcome.reason || "agent_loop_no_output");
          break;
        case "stopped_no_action":
          closeCurrentHarnessRunMarker("paused", outcome.reason || "agent_loop_no_action");
          break;
        case "aborted":
          closeCurrentHarnessRunMarker("paused", outcome.reason || "agent_loop_aborted");
          break;
        case "error":
          closeCurrentHarnessRunMarker("error", outcome.reason || "agent_loop_error");
          break;
      }
    };

    const commitTerminalTurnContext = (loopOutcome: AgentLoopOutcome) => {
      let latestState = sessionGet();
      if (!shouldCanonicalizeTerminalTurnContext(loopOutcome.status)) return latestState;
      const completedTurn = latestState.conversationTurns.find((candidate: any) => candidate.id === turnId);
      const turnBlocks = latestState.taskFlow.filter((block: any) => block.turnId === turnId);
      const isPlanTurn = completedTurn?.mode === "plan" || completedTurn?.intent === "plan";
      const durableContext = buildDurableTurnContext({
        turnId,
        turnBlocks,
        fallbackAssistantText: completedTurn?.summary || loopOutcome.reason,
        artifactPaths: isPlanTurn
          ? (latestState.planArtifacts || []).map((artifact: any) => artifact.path)
          : [],
        unfinished: isPlanTurn
          ? [
              ...(latestState.planTasks || [])
                .filter((task: any) => task.evidenceStatus !== "satisfied")
                .map((task: any) => task.text),
              ...(loopOutcome.status === "error" ? [loopOutcome.reason] : []),
            ]
          : loopOutcome.status === "error" ? [loopOutcome.reason] : [],
      });
      if (durableContext) {
        sessionSet((state: any) => ({
          conversationTurns: state.conversationTurns.map((candidate: any) =>
            candidate.id === turnId ? { ...candidate, durableContext } : candidate
          ),
        }));
        logStoreEvent("durable_turn_context_committed", {
          outcomeStatus: loopOutcome.status,
          visibleUserMessages: durableContext.visibleUserMessages.length,
          finalAnswerChars: durableContext.finalAssistantAnswer.length,
          decisions: durableContext.execution.decisions.length,
          modifiedFiles: durableContext.execution.modifiedFiles.length,
          validations: durableContext.execution.validations.length,
          failures: durableContext.execution.failures.length,
          unfinished: durableContext.execution.unfinished.length,
          artifacts: durableContext.execution.artifacts.length,
        });
        latestState = sessionGet();
      }

      const terminalTurn = latestState.conversationTurns.find((candidate: any) => candidate.id === turnId);
      const terminalSummary = String(terminalTurn?.summary || loopOutcome.reason || "").trim();
      if (!terminalSummary) return latestState;
      const compactedMessages = compactCompletedTurnAgentMessages({
        agentMessages: latestState.agentMessages,
        turnStartIndex: turnAgentMessagesStart,
        turnSummary: terminalSummary,
        turnBlocks: latestState.taskFlow.filter((block: any) => block.turnId === turnId),
        durableContext: terminalTurn?.durableContext,
        language: (latestState.preferredResponseLanguage || latestState.config.language) === "en" ? "en" : "zh",
      });
      if (compactedMessages !== latestState.agentMessages) {
        const beforeMessageCount = latestState.agentMessages.length;
        sessionSet({ agentMessages: compactedMessages });
        latestState = sessionGet();
        logStoreEvent("terminal_turn_context_compacted", {
          outcomeStatus: loopOutcome.status,
          contextSource: "canonical_visible_messages_and_durable_summary",
          beforeMessageCount,
          afterMessageCount: compactedMessages.length,
          omittedRuntimeControlMessages: Math.max(0, beforeMessageCount - compactedMessages.length),
        });
      }
      return latestState;
    };

    const persistCurrentSessionRuntime = (state = sessionGet()) => {
      if (!runSessionId) return;
      const messages = sanitizeTaskBlocksForPersist(state.taskFlow);
      state.updateSession(runScopeKey, runSessionId, {
        messages,
        storageStatus: state.config.sessionRecordingEnabled ? "ok" : "temporary",
        recordingDisabled: !state.config.sessionRecordingEnabled,
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
      });
    };

    const executeLoopStrategy = (): Promise<AgentLoopOutcome> => {
      if (context.runtimeRunIntent === "goal") {
        const activeGoal = sessionGet().goalRuntime?.goal || sessionGet().activeGoal;
        if (!activeGoal) {
          return Promise.resolve({ status: "error", reason: "no_active_goal" });
        }
        
        const goalCallbacks: GoalEngineCallbacks = {
          getPreferredLanguage: callbacks.getPreferredLanguage,
          getWorkspacePath: () => resolveSessionWorkspaceKey(sessionGet().currentWorkspace) || "",
          runAgentIteration: async (iterInput) => {
            activeRuntimeRunIdentity = resolveRuntimeRunIdentity({
              marker: sessionGet().harnessRunMarker,
              sessionKey: runSessionKey,
              turnId,
              fallbackRunId: context.harnessRunId,
              goalSliceId: iterInput.goalSliceId,
            });
            updateHarnessRunMarker({
              activeRunId: activeRuntimeRunIdentity.runId,
              activeParentRunId: activeRuntimeRunIdentity.parentRunId,
            });
            let iterationMessages: import("../orchestrator").AgentMessage[] = [
              { role: "system", content: "" },
              {
                role: "user",
                content: callbacks.getPreferredLanguage() === "en"
                  ? `Execute bounded goal slice ${iterInput.iteration}/${iterInput.maxIterations} (${iterInput.goalSliceId}). Use the Goal Runtime contract as the source of truth, advance one verifiable milestone, and finish with evidence plus the next step.`
                  : `执行有界目标切片 ${iterInput.iteration}/${iterInput.maxIterations}（${iterInput.goalSliceId}）。以 Goal Runtime 合同为准，推进一个可验证里程碑，并在结束时给出证据与下一步。`,
              },
            ];
            const goalInnerIterationLimit = callbacks.getConfig().activeProfile === "local" ? 8 : 12;
            let maxObservedModelIteration = 0;
            let providerUsageReports = 0;
            let providerInputTokens = 0;
            let providerOutputTokens = 0;
            let providerTotalTokens = 0;
            const deferredNonActionableStops: Array<
              Parameters<OrchestratorCallbacks["onNonActionableStop"]>
            > = [];
            const iterCallbacks = {
              ...callbacks,
              getGoalTurnContract: () => iterInput.goalTurnContract,
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
              onNonActionableStop: (...args: Parameters<OrchestratorCallbacks["onNonActionableStop"]>) => {
                deferredNonActionableStops.push(args);
              },
            };
            const startTaskFlowLength = sessionGet().taskFlow.length;
            let outcome: AgentLoopOutcome;
            try {
              outcome = await executeAgentLoop(iterCallbacks, abortCtrl);
            } catch (error) {
              const assistantResponseCount = iterationMessages.filter((message) => message.role === "assistant").length;
              const modelIterationsUsed = Math.max(1, maxObservedModelIteration, assistantResponseCount);
              const observedToolIds = new Set<string>();
              for (const message of iterationMessages) {
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
              (enrichedError as Error & { goalIterationUsage?: typeof failureUsage }).goalIterationUsage = failureUsage;
              callbacks.onDebugEvent?.("goal_inner_slice_threw", {
                goalSliceId: iterInput.goalSliceId,
                iteration: iterInput.iteration,
                error: enrichedError.message,
                usage: failureUsage,
              });
              throw enrichedError;
            }
            const assistantResponseCount = iterationMessages.filter((message) => message.role === "assistant").length;
            const modelIterationsUsed = Math.max(maxObservedModelIteration, assistantResponseCount);
            const deferredNonActionableStop = deferredNonActionableStops[0];
            const deferredRecoveryReason = deferredNonActionableStop?.[2]?.recoveryReason;
            const sliceBoundaryReached = outcome.status === "stopped_no_action"
              && modelIterationsUsed >= goalInnerIterationLimit
              && (
                deferredNonActionableStop?.[1] === "no_action"
                || deferredRecoveryReason === "max_iterations_boundary"
              );
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
            
            for (const msg of iterationMessages) {
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
              assistantText = iterationMessages
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

            callbacks.onDebugEvent?.("goal_inner_slice_outcome", {
              goalSliceId: iterInput.goalSliceId,
              iteration: iterInput.iteration,
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
            });

            return {
              assistantText: assistantText.trim() || (outcome.status === "error" ? outcome.reason : "Iteration completed without textual response"),
              toolCalls,
              tokensUsed,
              completed: outcome.status === "completed",
              outcomeStatus: outcome.status,
              error: outcome.status === "error" ? outcome.reason : undefined,
              stopReason,
              sliceBoundaryReached,
              usage: {
                modelIterations: modelIterationsUsed,
                toolCalls: toolCalls.length,
                tokensUsed,
                estimatedTokens: estimatedTokenUsage,
              },
            };
          },
          writeFile: async (path, content) => {
            const { writeFileAtomic } = await import("../ipc");
            await writeFileAtomic(path, content);
          },
          readFile: async (path) => {
            try {
              const { readFile } = await import("../ipc");
              return await readFile(path);
            } catch {
              return null;
            }
          },
          isAborted: () => abortCtrl.signal.aborted,
          onGoalProgressUpdate: (progress, goal) => callbacks.onGoalProgressUpdate?.(progress, goal),
          onGoalRuntimeUpdate: (runtime) => callbacks.onGoalRuntimeUpdate?.(runtime),
          onGoalIterationStart: (iter) => callbacks.onGoalIterationStart?.(iter),
          onGoalIterationEnd: (iter) => callbacks.onGoalIterationEnd?.(iter),
          onGoalCheckpointSaved: (ckpt) => callbacks.onGoalCheckpointSaved?.(ckpt),
          onGoalUserConfirmNeeded: async (message) =>
            callbacks.onGoalUserConfirmNeeded?.(message) ?? false,
          onGoalOutcome: (outcome) => callbacks.onGoalOutcome?.(outcome),
          onDebugEvent: callbacks.onDebugEvent,
        };

        return executeGoalLoop({
          goal: activeGoal,
          callbacks: goalCallbacks,
          existingProgress: sessionGet().goalRuntime?.progress || sessionGet().goalProgress,
        }).then((goalOutcome) => {
          if (goalOutcome.status === "completed") {
            appendWorkflowRuntimeEvent({
              type: "turn.completed",
              threadId: runSessionKey,
              turnId,
              timestampMs: Date.now(),
            });
          } else if (goalOutcome.status === "failed") {
            appendWorkflowRuntimeEvent({
              type: "turn.failed",
              threadId: runSessionKey,
              turnId,
              timestampMs: Date.now(),
              error: { message: goalOutcome.reason },
            });
          }
          return {
            status: goalOutcome.status === "completed"
              ? "completed"
              : goalOutcome.status === "failed"
                ? "error"
                : "paused",
            reason: goalOutcome.reason,
          };
        });
      }

      return executeAgentLoop(callbacks, abortCtrl);
    };

    return executeLoopStrategy().then((loopOutcome) => {
      closeHarnessForAgentLoopOutcome(loopOutcome);
      clearInterval(timerInterval);
      sessionSet({ pendingSlashCommand: null, elapsedTime: getElapsedSeconds() });

      const pausedActionRequest = sessionGet().activeActionRequest as ActionRequest | null;
      if (loopOutcome.status !== "completed" && loopOutcome.status !== "error" && pausedActionRequest) {
        sessionSet({
          agentStatus: pausedActionRequest.kind === "plan_review" || pausedActionRequest.kind === "tool_permission"
            ? "pending_review"
            : "idle",
          isGenerating: false,
          abortController: null,
        });
      }

      if (loopOutcome.status === "completed" || loopOutcome.status === "error") {
        const request = sessionGet().activeActionRequest as ActionRequest | null;
        if (request && isActionRequestOwnedByRun(request, {
          sessionKey: runSessionKey,
          turnId,
          runId: activeRuntimeRunIdentity.runId,
        })) {
          sessionSet((state: any) => reduceRunTransition(state, {
            type: "terminal_cleanup",
            owner: {
              sessionKey: runSessionKey,
              turnId,
              runId: activeRuntimeRunIdentity.runId,
            },
          }));
          logStoreEvent("terminal_run_action_request_cleared", {
            sessionKey: runSessionKey,
            turnId,
            runId: activeRuntimeRunIdentity.runId,
            requestId: request.requestId,
            actionKind: request.kind,
            outcomeStatus: loopOutcome.status,
          });
        }
      }

      let latestState = sessionGet();
      const queuedAfterRun = normalizeQueuedUserMessage(latestState.queuedUserMessage);
      const pendingSameTurnExecution =
        latestState.isPlanApproved === true &&
        latestState.pendingPlanApprovalHandoff?.planTurnId === turnId &&
        latestState.planApprovalExecutionStartedForTurnId !== turnId
          ? latestState.pendingPlanApprovalHandoff
          : null;
      if (pendingSameTurnExecution) {
        sessionSet({ agentStatus: "idle", isGenerating: false, abortController: null });
        latestState = sessionGet();
      }
      if (shouldCanonicalizeTerminalTurnContext(loopOutcome.status) && !pendingSameTurnExecution) {
        latestState = commitTerminalTurnContext(loopOutcome);
      }

      // Save session messages (sanitized for serialization safety)
      persistCurrentSessionRuntime(latestState);
      if (pendingSameTurnExecution) {
        const attemptSameTurnExecutionFallback = (busyRetryAttempt: number) => {
          const latest = sessionGet();
          const latestSessionKey = resolveSessionRuntimeKey(
            resolveSessionWorkspaceKey(latest.currentWorkspace),
            latest.currentSessionId,
          );
          const decision = resolveApprovedPlanSameTurnFallbackDecision({
            expectedSessionKey: runSessionKey,
            currentSessionKey: latestSessionKey,
            expectedHandoff: pendingSameTurnExecution,
            currentHandoff: latest.pendingPlanApprovalHandoff,
            isPlanApproved: latest.isPlanApproved === true,
            executionStartedForTurnId: latest.planApprovalExecutionStartedForTurnId,
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
          let latest = sessionGet();
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
            logStoreEvent("queued_user_message_force_idle", {
              reason: "stale_running_or_generating",
              agentStatus: latest.agentStatus,
              isGenerating: latest.isGenerating,
            });
            sessionSet({ agentStatus: "idle", isGenerating: false });
            latest = sessionGet();
          }
          logStoreEvent("queued_user_message_sending", {
            chars: queuedAfterRun.text.length,
            images: queuedAfterRun.images?.length || 0,
            contextMentions: queuedAfterRun.contextMentions?.length || 0,
            attachedFiles: queuedAfterRun.attachedFiles?.length || 0,
          });

          // Only clear queuedUserMessage when actually sending the message
          sessionSet({
            queuedUserMessage: null,
            input: "",
            contextMentions: [],
            attachedFiles: [],
          });

          latest.sendMessage(queuedAfterRun.text, queuedAfterRun.images, {
            contextMentionsSnapshot: queuedAfterRun.contextMentions || [],
            attachedFilesSnapshot: queuedAfterRun.attachedFiles || [],
            runtimeIntentOverride: queuedAfterRun.runtimeIntentOverride,
            goalSourceContextSnapshot: queuedAfterRun.goalSourceContextSnapshot,
          });
        });
      }

      return true;
    }).catch((err: any) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      closeCurrentHarnessRunMarker("error", "agent_loop_crashed");
      clearInterval(timerInterval);
      sessionSet({ pendingSlashCommand: null, elapsedTime: getElapsedSeconds() });
      appendWorkflowRuntimeEvent({
        type: "run.failed",
        threadId: runSessionKey,
        turnId,
        timestampMs: Date.now(),
        runId: activeRuntimeRunIdentity.runId,
        parentRunId: activeRuntimeRunIdentity.parentRunId,
        ...(activeRuntimeRunIdentity.goalSliceId ? { goalSliceId: activeRuntimeRunIdentity.goalSliceId } : {}),
        error: { message: errorMessage },
      });
      appendWorkflowRuntimeEvent({
        type: "turn.failed",
        threadId: runSessionKey,
        turnId,
        timestampMs: Date.now(),
        error: { message: errorMessage },
      });
      sessionSet((state: any) => reduceRunTransition(state, {
        type: "terminal_cleanup",
        owner: {
          sessionKey: runSessionKey,
          turnId,
          runId: activeRuntimeRunIdentity.runId,
        },
      }));
      logStoreEvent("agent_loop_crashed", {
        turnId,
        error: errorMessage,
        stack: err instanceof Error ? err.stack?.slice(0, 1200) : null,
        stopClass: "unrecoverable_error",
      });
      if (remoteFeishu) {
        const language = sessionGet().config.language === "en" ? "en" : "zh";
        void invoke("send_feishu_message", {
          chatId: remoteFeishu.chatId,
          userId: remoteFeishu.userId,
          openId: remoteFeishu.userId,
          messageId: remoteFeishu.messageId,
          text: language === "en"
            ? `MAIN crashed while handling the remote task: ${errorMessage}`
            : `MAIN 处理远程任务时崩溃：${errorMessage}`,
        }).catch(() => {});
      }
      // Show crash as visible system block
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
                status: "error",
                summary: errorMessage,
                blockIds: [...turn.blockIds, crashId],
              }
            : turn
        ),
        agentStatus: "error",
        isGenerating: false,
        abortController: null,
      }));

      const terminalState = commitTerminalTurnContext({
        status: "error",
        reason: errorMessage,
      });
      persistCurrentSessionRuntime(terminalState);

      return false;
    });
  }
}

function sanitizeFinalTextForPersist(params: { visibleText: string; language: "zh" | "en" }): string {
  const visible = String(params.visibleText || "").trim();
  if (visible) return visible;
  return params.language === "en" ? "No visible reply was produced." : "本轮未生成可见回复。";
}
