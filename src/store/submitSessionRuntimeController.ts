import { sanitizePlanArtifactContent } from "../lib/sanitize";
import {
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
import {
  createSubmitSessionRuntimeFacade,
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
  planStage: PlanStage;
  isPlanApproved: boolean;
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
              elapsedTime: turn.elapsedTime || s.elapsedTime || 0,
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

  const sessionUpsertPlanArtifact = (artifact: PlanArtifact) =>
    sessionSet((s) => {
      const sanitizedContent = sanitizePlanArtifactContent(artifact.content);
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
      const existingIndex = nextArtifacts.findIndex((item) => item.path === artifact.path);
      if (existingIndex >= 0) {
        nextArtifacts[existingIndex] = { ...artifact, content: sanitizedContent };
      } else {
        nextArtifacts.push({ ...artifact, content: sanitizedContent });
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
      return {
        planArtifacts: nextArtifacts.sort((a, b) => a.updatedAt - b.updatedAt),
        planStage: input.derivePlanStageFromArtifacts(
          nextArtifacts,
          normalizedTasks,
          s.isPlanApproved,
          s.planStage,
        ),
        planTasks: normalizedTasks,
        clearedPlanTurnId: null,
        showPlanPanel: true,
        rightPanelTab: s.showDiff && s.rightPanelTab === "diff" ? "diff" : "plan",
      } as unknown as Partial<TState>;
    });

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
  };
}
