import {
  reconcilePlanTaskCompletion,
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
  preparePlanArtifactCommit,
  reducePlanArtifactCommit,
} from "../lib/planArtifactCommit";
import {
  resolveConversationTurnIntent,
  resolveRunIntentFromLegacyWorkflowMode,
  type LegacyWorkflowMode,
} from "../lib/runIntent";
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
      const preparedCommit = preparePlanArtifactCommit(artifact);
      if (!preparedCommit.accepted) {
        if (preparedCommit.gate === "authority") {
          input.logStoreEvent("plan_artifact_rejected_by_authority_gate", {
            path: artifact.path,
            kind: artifact.kind,
            reason: preparedCommit.reason,
          });
        } else if (preparedCommit.gate === "typed_contract") {
          input.logStoreEvent("plan_artifact_rejected_by_typed_contract_gate", {
            path: artifact.path,
            kind: artifact.kind,
            failures: preparedCommit.failures,
            candidateHashMismatch: preparedCommit.candidateHashMismatch,
            authoringContractMismatch: preparedCommit.authoringContractMismatch,
          });
        } else {
          input.logStoreEvent("plan_artifact_rejected_before_commit", {
            path: artifact.path,
            kind: artifact.kind,
            gate: preparedCommit.gate,
          });
        }
        return {} as Partial<TState>;
      }
      const commit = reducePlanArtifactCommit({
        state: {
          artifacts: s.planArtifacts,
          tasks: s.planTasks,
          evidenceLedger: s.planExecutionEvidenceLedger,
          isApproved: s.isPlanApproved,
          stage: s.planStage,
        },
        commit: preparedCommit.commit,
      });
      if (!commit.accepted) {
        if (commit.gate === "authority") {
          input.logStoreEvent("plan_artifact_rejected_by_authority_gate", {
            path: artifact.path,
            kind: artifact.kind,
            reason: commit.reason,
          });
        } else if (commit.gate === "identity") {
          input.logStoreEvent("plan_artifact_rejected_by_identity_gate", {
            path: artifact.path,
            canonicalPath: commit.canonicalPath,
            kind: artifact.kind,
          });
        } else if (commit.gate === "typed_contract") {
          input.logStoreEvent("plan_artifact_rejected_by_typed_contract_gate", {
            path: artifact.path,
            kind: artifact.kind,
            failures: commit.failures,
            candidateHashMismatch: commit.candidateHashMismatch,
            authoringContractMismatch: commit.authoringContractMismatch,
          });
        } else {
          input.logStoreEvent("plan_artifact_rejected_by_quality_gate", {
            path: artifact.path,
            kind: artifact.kind,
            reason: commit.reason,
            contentChars: commit.contentChars,
          });
        }
        return {} as Partial<TState>;
      }

      const {
        artifacts: nextArtifacts,
        tasks: normalizedTasks,
        droppedTasks,
        artifactIdentity: nextArtifactIdentity,
        reviewIdentity: nextReviewIdentity,
      } = commit;
      if (droppedTasks.length > 0) {
        input.logStoreEvent("plan_tasks_preserved_missing_history", {
          path: artifact.path,
          droppedTasks: droppedTasks.map((task) => task.text).slice(0, 8),
          droppedCount: droppedTasks.length,
        });
      }
      const lifecycleAt = nowMs();
      const lifecycleOwner = ensurePlanLifecycleOwner({
        lifecycle: s.planLifecycle,
        sessionKey: input.runSessionKey,
        at: lifecycleAt,
      });
      let nextPlanLifecycle = applyPlanArtifactIdentity({
        lifecycle: lifecycleOwner,
        sessionKey: input.runSessionKey,
        artifactIdentity: nextArtifactIdentity
          ? {
              revision: nextArtifactIdentity.revision,
              artifactHash: nextArtifactIdentity.artifactHash,
              artifactPaths: nextArtifactIdentity.artifactPaths,
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
        !!nextReviewIdentity &&
        (
          s.activeActionRequest.planRevision !== nextReviewIdentity.revision ||
          s.activeActionRequest.artifactHash !== nextReviewIdentity.artifactHash
        );
      const clearsPlanReviewRequest =
        s.activeActionRequest?.kind === "plan_review" && !nextReviewIdentity;
      const nextPlanReviewRequest = shouldRefreshPlanReviewRequest &&
        s.activeActionRequest?.kind === "plan_review" &&
        nextReviewIdentity
        ? buildPlanReviewActionRequest({
            sessionKey: s.activeActionRequest.sessionKey,
            turnId: s.activeActionRequest.turnId,
            runId: s.activeActionRequest.runId,
            parentRunId: s.activeActionRequest.parentRunId,
            title: s.activeActionRequest.title,
            planRevision: nextReviewIdentity.revision,
            artifactHash: nextReviewIdentity.artifactHash,
            artifactPaths: nextReviewIdentity.artifactPaths,
          })
        : s.activeActionRequest;
      if (
        shouldRefreshPlanReviewRequest &&
        nextPlanReviewRequest?.kind === "plan_review" &&
        nextReviewIdentity
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
            revision: nextReviewIdentity.revision,
            artifactHash: nextReviewIdentity.artifactHash,
            artifactPaths: nextReviewIdentity.artifactPaths,
          },
          reviewIdentity,
          at: lifecycleAt,
        });
        if (aligned) nextPlanLifecycle = aligned;
      }
      return {
        planLifecycle: nextPlanLifecycle,
        planArtifacts: nextArtifacts,
        planStage: input.derivePlanStageFromArtifacts(
          nextArtifacts,
          approvalInvalidated ? [] : normalizedTasks,
          effectivePlanApproved,
          s.planStage,
        ),
        planTasks: approvalInvalidated ? [] : normalizedTasks,
        ...(shouldRefreshPlanReviewRequest
          ? { activeActionRequest: nextPlanReviewRequest }
          : clearsPlanReviewRequest
            ? { activeActionRequest: null }
            : {}),
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
