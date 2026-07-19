import { sanitizePlanArtifactContent } from "../lib/sanitize";
import {
  canonicalizePlanArtifactPath,
  detectPlanArtifactKind,
  extractPlanTasks,
  reconcilePlanTaskCompletion,
  validatePlanArtifactContent,
  type ConversationTurn,
  type ConversationTurnStatus,
  type NormalizedStreamState,
  type PlanArtifact,
  type PlanExecutionEvidenceEntry,
  type PlanStage,
  type PlanTask,
  type RightPanelTab,
} from "../lib/workflowModels";
import {
  resolveConversationTurnIntent,
  resolveRunIntentFromLegacyWorkflowMode,
  type LegacyWorkflowMode,
} from "../lib/runIntent";
import { normalizeApprovedPlanTaskStatuses } from "./submitApprovedPlanExecution";
import { buildPlanApprovalIdentity } from "../lib/planApprovalIdentity";
import type { HarnessRunMarker } from "../lib/harnessCrashTelemetry";
import { isHarnessMarkerOwnedByPlanExecution } from "../lib/planExecutionOwnership";
import {
  applyPlanArtifactIdentity,
  applyPlanReviewIdentity,
  ensurePlanLifecycleOwner,
  isPlanApprovalLeaseBoundToState,
  type PlanLifecycleState,
  type PlanReviewIdentity,
} from "../lib/planLifecycle";
import {
  buildPendingPlanToolPermissionInvalidation,
  buildPlanReviewActionRequest,
  settlePendingPlanToolPermissionInvalidation,
  type ActionRequest,
  type PendingPlanToolPermissionInvalidation,
} from "../lib/actionRequest";
import {
  createSubmitSessionRuntimeFacade,
  type SubmitOwnerScopedRuntimeProjectionInput,
  type SubmitOwnerScopedRuntimePublicationResult,
  type SubmitSessionPatch,
  type SubmitSessionPatchInput,
  type SubmitSessionRuntimeFacade,
  type SubmitSessionRuntimeFacadeState,
} from "./submitRuntimeFacade";

export interface SubmitSessionRuntimeControllerState<TRuntime extends object>
  extends SubmitSessionRuntimeFacadeState<TRuntime> {
  currentTurnId?: string | null;
  conversationTurns: ConversationTurn[];
  elapsedTime: number;
  planArtifacts: PlanArtifact[];
  planTasks: PlanTask[];
  planExecutionEvidenceLedger: PlanExecutionEvidenceEntry[];
  planExecutionEvidenceCount: number;
  planAutoResumeCount: number;
  planExecutionProgressSnapshot?: unknown | null;
  planLifecycle: PlanLifecycleState;
  planStage: PlanStage;
  isPlanApproved: boolean;
  planApprovalChoice?: string | null;
  pendingPlanApprovalHandoff?: unknown | null;
  planApprovalExecutionStartedForTurnId?: string | null;
  currentTurnExecutionConsent?: { turnId: string | null; granted: boolean };
  activeActionRequest?: ActionRequest | null;
  pendingReviewResolve?: ((decision: { action: "reject" }) => void) | null;
  pendingReviewTaskId?: number | null;
  pendingToolCall?: unknown | null;
  abortController?: { abort: () => void; signal?: { aborted?: boolean } } | null;
  harnessRunMarker?: HarnessRunMarker | null;
  showPlanPanel: boolean;
  showDiff: boolean;
  showTerminal: boolean;
  rightPanelTab: RightPanelTab;
  normalizedStreamState: NormalizedStreamState;
  currentTurnState: unknown;
  config: {
    workflowMode: LegacyWorkflowMode;
  };
}

export interface SubmitSessionRuntimeControllerInput<
  TState extends SubmitSessionRuntimeControllerState<TRuntime>,
  TRuntime extends object,
> {
  get: () => TState;
  set: (patchOrUpdater: Partial<TState> | ((state: TState) => Partial<TState>)) => void;
  runSessionKey: string;
  createRuntimeFromState: (state: Partial<TState>) => TRuntime;
  pickRuntimePatch: (source: SubmitSessionPatch<TState>) => Partial<TRuntime>;
  normalizePatch?: (patch: SubmitSessionPatch<TState>) => SubmitSessionPatch<TState>;
  derivePlanStageFromArtifacts: (
    artifacts: PlanArtifact[],
    tasks: PlanTask[],
    isApproved: boolean,
    currentStage: PlanStage,
  ) => PlanStage;
  createDefaultCurrentTurnState: () => Record<string, unknown>;
  logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
  nowMs?: () => number;
}

export interface SubmitSessionRuntimeController<
  TState extends SubmitSessionRuntimeControllerState<TRuntime>,
  TRuntime extends object,
> {
  sessionRuntimeFacade: SubmitSessionRuntimeFacade<TState, TRuntime>;
  sessionSet: (patchOrUpdater: SubmitSessionPatchInput<TState>) => void;
  sessionGet: () => TState;
  getSessionRuntimeOwnerToken: () => object;
  hasSessionRuntimeOwnership: (expectedOwnerToken?: object) => boolean;
  getSessionRevisionToken: () => unknown;
  publishOwnerScopedRuntimeProjection: (
    input: SubmitOwnerScopedRuntimeProjectionInput<TState>,
  ) => SubmitOwnerScopedRuntimePublicationResult;
}

export function createSubmitSessionRuntimeController<
  TState extends SubmitSessionRuntimeControllerState<TRuntime>,
  TRuntime extends object,
>(
  input: SubmitSessionRuntimeControllerInput<TState, TRuntime>,
): SubmitSessionRuntimeController<TState, TRuntime> {
  let sessionSet!: (patchOrUpdater: SubmitSessionPatchInput<TState>) => void;
  let sessionGet!: () => TState;
  const nowMs = input.nowMs || Date.now;

  const sessionSetConversationTurnStatus = (targetTurnId: string, status: ConversationTurnStatus) =>
    sessionSet((s) => ({
      conversationTurns: s.conversationTurns.map((turn) =>
        turn.id === targetTurnId
          ? {
              ...turn,
              status,
              collapsed:
                status === "awaiting_approval" || status === "awaiting_input" || status === "error"
                  ? false
                  : turn.collapsed,
              elapsedTime: Math.max(
                0,
                Number(turn.elapsedTime) || 0,
                Number(s.elapsedTime) || 0,
              ),
            }
          : turn,
      ),
    } as Partial<TState>));

  const sessionUpdateConversationTurn = (targetTurnId: string, patch: Partial<ConversationTurn>) =>
    sessionSet((s) => ({
      conversationTurns: s.conversationTurns.map((turn) =>
        turn.id === targetTurnId ? { ...turn, ...patch } : turn
      ),
    } as Partial<TState>));

  const sessionSetConversationTurnSummary = (targetTurnId: string, summary: string) =>
    sessionUpdateConversationTurn(targetTurnId, { summary });

  const sessionSetPlanTasks = (tasks: PlanTask[]) =>
    sessionSet((s) => ({
      planTasks: reconcilePlanTaskCompletion(
        s.planTasks,
        tasks,
        s.planExecutionEvidenceLedger,
        {
          preserveMissing:
            s.isPlanApproved ||
            s.planStage === "executing" ||
            s.planStage === "completed" ||
            s.planTasks.length > 0,
          highlightNext: s.isPlanApproved && s.planExecutionEvidenceLedger.length > 0,
        },
      ),
    } as Partial<TState>));

  const sessionUpsertPlanArtifact = (artifact: PlanArtifact) => {
    const invalidatedPlanToolReviewRef: {
      current: PendingPlanToolPermissionInvalidation | null;
    } = { current: null };
    const revokedPlanExecutionAbortRef: { current: (() => void) | null } = { current: null };
    sessionSet((s) => {
      const canonicalPath = canonicalizePlanArtifactPath(artifact.path);
      const sanitizedContent = sanitizePlanArtifactContent(artifact.content);
      if (!canonicalPath || detectPlanArtifactKind(canonicalPath) !== artifact.kind) {
        input.logStoreEvent("plan_artifact_rejected_by_identity_gate", {
          path: artifact.path,
          canonicalPath,
          kind: artifact.kind,
        });
        return {} as Partial<TState>;
      }
      const normalizedArtifact = { ...artifact, path: canonicalPath };
      const validation = validatePlanArtifactContent(sanitizedContent, artifact.kind);
      if (!validation.ok) {
        input.logStoreEvent("plan_artifact_rejected_by_quality_gate", {
          path: artifact.path,
          kind: artifact.kind,
          reason: validation.reason,
          contentChars: sanitizedContent.length,
        });
        return {} as Partial<TState>;
      }

      const nextArtifacts = [...s.planArtifacts];
      const currentMaxPlanRevision = s.planArtifacts.reduce(
        (max, candidate) => Math.max(max, Number(candidate.revision) || 0),
        0,
      );
      const existingIndex = nextArtifacts.findIndex(
        (item) => canonicalizePlanArtifactPath(item.path) === canonicalPath,
      );
      if (existingIndex >= 0) {
        const existingArtifact = nextArtifacts[existingIndex];
        const contentChanged = existingArtifact.content !== sanitizedContent || existingArtifact.kind !== artifact.kind;
        nextArtifacts[existingIndex] = {
          ...normalizedArtifact,
          content: sanitizedContent,
          revision: contentChanged
            ? Math.max(1, currentMaxPlanRevision + 1)
            : Math.max(1, Number(existingArtifact.revision) || Number(artifact.revision) || 1),
        };
      } else {
        nextArtifacts.push({
          ...normalizedArtifact,
          content: sanitizedContent,
          revision: Math.max(1, currentMaxPlanRevision + 1),
        });
      }

      const parsedTasks = artifact.kind === "tasks" || artifact.kind === "bugfix"
        ? extractPlanTasks(sanitizedContent)
        : s.planTasks;
      const preserveTaskHistory =
        s.isPlanApproved ||
        s.planStage === "executing" ||
        s.planStage === "completed" ||
        s.planTasks.length > 0;
      const normalizedTasks = artifact.kind === "tasks" || artifact.kind === "bugfix"
        ? reconcilePlanTaskCompletion(s.planTasks, parsedTasks, s.planExecutionEvidenceLedger, {
            preserveMissing: preserveTaskHistory,
            highlightNext: s.isPlanApproved && s.planExecutionEvidenceLedger.length > 0,
          })
        : normalizeApprovedPlanTaskStatuses(
            s.planTasks,
            s.planExecutionEvidenceLedger,
            s.isPlanApproved && s.planExecutionEvidenceLedger.length > 0,
          );
      const nextApprovalIdentity = buildPlanApprovalIdentity(nextArtifacts);
      const lifecycleAt = nowMs();
      const lifecycleOwner = ensurePlanLifecycleOwner({
        lifecycle: s.planLifecycle,
        sessionKey: input.runSessionKey,
        at: lifecycleAt,
      });
      let nextPlanLifecycle = applyPlanArtifactIdentity({
        lifecycle: lifecycleOwner,
        sessionKey: input.runSessionKey,
        artifactIdentity: nextApprovalIdentity
          ? {
              revision: nextApprovalIdentity.revision,
              artifactHash: nextApprovalIdentity.artifactHash,
              artifactPaths: nextApprovalIdentity.artifactPaths,
            }
          : null,
        at: lifecycleAt,
      });
      const approvalInvalidated = Boolean(
        (s.isPlanApproved || s.planLifecycle?.approvalLease) &&
        !nextPlanLifecycle.approvalLease,
      );
      const planToolInvalidation = buildPendingPlanToolPermissionInvalidation(
        s,
        approvalInvalidated,
      );
      invalidatedPlanToolReviewRef.current = planToolInvalidation;
      if (
        approvalInvalidated &&
        !planToolInvalidation &&
        isHarnessMarkerOwnedByPlanExecution({
          lifecycle: s.planLifecycle,
          marker: s.harnessRunMarker,
        }) &&
        s.abortController &&
        s.abortController.signal?.aborted !== true
      ) {
        revokedPlanExecutionAbortRef.current = () => s.abortController?.abort();
      }
      const effectivePlanApproved = s.isPlanApproved &&
        isPlanApprovalLeaseBoundToState(nextPlanLifecycle);
      const shouldRefreshPlanReviewRequest =
        s.activeActionRequest?.kind === "plan_review" &&
        !!nextApprovalIdentity &&
        (
          s.activeActionRequest.planRevision !== nextApprovalIdentity.revision ||
          s.activeActionRequest.artifactHash !== nextApprovalIdentity.artifactHash
        );
      const nextPlanReviewRequest = shouldRefreshPlanReviewRequest &&
        s.activeActionRequest?.kind === "plan_review" &&
        nextApprovalIdentity
        ? buildPlanReviewActionRequest({
            sessionKey: s.activeActionRequest.sessionKey,
            turnId: s.activeActionRequest.turnId,
            runId: s.activeActionRequest.runId,
            parentRunId: s.activeActionRequest.parentRunId,
            title: s.activeActionRequest.title,
            planRevision: nextApprovalIdentity.revision,
            artifactHash: nextApprovalIdentity.artifactHash,
            artifactPaths: nextApprovalIdentity.artifactPaths,
          })
        : s.activeActionRequest;
      if (
        shouldRefreshPlanReviewRequest &&
        nextPlanReviewRequest?.kind === "plan_review" &&
        nextApprovalIdentity
      ) {
        const reviewIdentity: PlanReviewIdentity = {
          sessionKey: nextPlanReviewRequest.sessionKey,
          sessionEpoch: nextPlanLifecycle.sessionEpoch,
          turnId: nextPlanReviewRequest.turnId,
          runId: nextPlanReviewRequest.runId,
          parentRunId: nextPlanReviewRequest.parentRunId || null,
          requestId: nextPlanReviewRequest.requestId,
          planRevision: nextPlanReviewRequest.planRevision,
          artifactHash: nextPlanReviewRequest.artifactHash,
          artifactPaths: nextPlanReviewRequest.artifactPaths,
        };
        const aligned = applyPlanReviewIdentity({
          lifecycle: nextPlanLifecycle,
          artifactIdentity: {
            revision: nextApprovalIdentity.revision,
            artifactHash: nextApprovalIdentity.artifactHash,
            artifactPaths: nextApprovalIdentity.artifactPaths,
          },
          reviewIdentity,
          at: lifecycleAt,
        });
        if (aligned) nextPlanLifecycle = aligned;
      }
      return {
        planLifecycle: nextPlanLifecycle,
        planArtifacts: nextArtifacts.sort((a, b) => a.updatedAt - b.updatedAt),
        planStage: input.derivePlanStageFromArtifacts(
          nextArtifacts,
          approvalInvalidated ? [] : normalizedTasks,
          effectivePlanApproved,
          s.planStage,
        ),
        planTasks: approvalInvalidated ? [] : normalizedTasks,
        ...(shouldRefreshPlanReviewRequest ? { activeActionRequest: nextPlanReviewRequest } : {}),
        ...(planToolInvalidation?.patch || {}),
        clearedPlanTurnId: null,
        ...(approvalInvalidated
          ? {
              isPlanApproved: false,
              planApprovalChoice: null,
              pendingPlanApprovalHandoff: null,
              planApprovalExecutionStartedForTurnId: null,
              currentTurnExecutionConsent: { turnId: null, granted: false },
              planExecutionEvidenceLedger: [],
              planExecutionEvidenceCount: 0,
              planAutoResumeCount: 0,
              planExecutionProgressSnapshot: null,
            }
          : {}),
        showPlanPanel: true,
        rightPanelTab: s.showDiff && s.rightPanelTab === "diff" ? "diff" : "plan",
      } as unknown as Partial<TState>;
    });
    const invalidatedPlanToolReview = invalidatedPlanToolReviewRef.current;
    if (invalidatedPlanToolReview) {
      const settled = settlePendingPlanToolPermissionInvalidation(invalidatedPlanToolReview);
      input.logStoreEvent("plan_tool_permission_invalidated_by_artifact_change", {
        requestId: invalidatedPlanToolReview.requestId,
        taskId: invalidatedPlanToolReview.taskId,
        sessionKey: input.runSessionKey,
        settled,
      });
    }
    if (revokedPlanExecutionAbortRef.current) {
      try {
        revokedPlanExecutionAbortRef.current();
        input.logStoreEvent("plan_execution_aborted_by_artifact_change", {
          sessionKey: input.runSessionKey,
          source: "session_controller",
        });
      } catch (error) {
        input.logStoreEvent("plan_execution_abort_failed_after_artifact_change", {
          sessionKey: input.runSessionKey,
          source: "session_controller",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const sessionOpenRightPanelTab = (tab: RightPanelTab) =>
    sessionSet({
      rightPanelTab: tab,
      showPlanPanel: tab === "plan",
      showDiff: tab === "diff",
      showTerminal: tab === "terminal",
    } as Partial<TState>);

  const sessionOpenPlanWorkspacePanel = async () => {
    sessionOpenRightPanelTab("plan");
    const live = input.get();
    const runtime = (
      live.runtimeBySessionKey[input.runSessionKey] ||
      input.createRuntimeFromState(live)
    ) as Partial<SubmitSessionRuntimeControllerState<TRuntime>>;
    return (
      (runtime.planArtifacts?.length ?? 0) > 0 ||
      (runtime.planTasks?.length ?? 0) > 0 ||
      (runtime.planStage ?? "idle") !== "idle"
    );
  };

  const sessionRuntimeFacade = createSubmitSessionRuntimeFacade<TState, TRuntime>({
    get: input.get,
    set: input.set,
    runSessionKey: input.runSessionKey,
    createRuntimeFromState: input.createRuntimeFromState,
    pickRuntimePatch: input.pickRuntimePatch,
    normalizePatch: input.normalizePatch,
    decorateScopedState: (scoped) => ({
      ...scoped,
      setConversationTurnStatus: sessionSetConversationTurnStatus,
      updateConversationTurn: sessionUpdateConversationTurn,
      setConversationTurnSummary: sessionSetConversationTurnSummary,
      setPlanStage: (stage: PlanStage) => sessionSet({ planStage: stage } as Partial<TState>),
      setPlanTasks: sessionSetPlanTasks,
      upsertPlanArtifact: sessionUpsertPlanArtifact,
      setNormalizedStreamState: (streamState: NormalizedStreamState) =>
        sessionSet({ normalizedStreamState: streamState } as Partial<TState>),
      openRightPanelTab: sessionOpenRightPanelTab,
      setRightPanelTab: sessionOpenRightPanelTab,
      ensurePlanArtifactsHydratedForWorkspace: sessionOpenPlanWorkspacePanel,
      openPlanWorkspacePanel: sessionOpenPlanWorkspacePanel,
      closeRightPanel: () =>
        sessionSet({ showPlanPanel: false, showDiff: false, showTerminal: false } as Partial<TState>),
      startNewTurn: (remoteFeishu: unknown) =>
        sessionSet({
          currentTurnState: {
            ...input.createDefaultCurrentTurnState(),
            turnId: String(nowMs()),
            ...(remoteFeishu ? { remoteFeishu } : {}),
          },
        } as Partial<TState>),
      getCurrentRunIntent: () => {
        const current = scoped.currentTurnId
          ? scoped.conversationTurns.find((turn) => turn.id === scoped.currentTurnId) || null
          : null;
        return current
          ? resolveConversationTurnIntent(current)
          : resolveRunIntentFromLegacyWorkflowMode(scoped.config.workflowMode);
      },
    } as TState),
  });

  sessionRuntimeFacade.seedSessionRuntime();
  sessionSet = sessionRuntimeFacade.sessionSet;
  sessionGet = sessionRuntimeFacade.sessionGet;

  return {
    sessionRuntimeFacade,
    sessionSet,
    sessionGet,
    getSessionRuntimeOwnerToken: sessionRuntimeFacade.getSessionRuntimeOwnerToken,
    hasSessionRuntimeOwnership: sessionRuntimeFacade.hasSessionRuntimeOwnership,
    getSessionRevisionToken: sessionRuntimeFacade.getSessionRevisionToken,
    publishOwnerScopedRuntimeProjection:
      sessionRuntimeFacade.publishOwnerScopedRuntimeProjection,
  };
}
