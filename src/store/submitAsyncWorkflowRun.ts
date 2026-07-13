import type { AttachedFile } from "../lib/attachments";
import type { FeishuRemoteContext } from "../lib/remoteContextTypes";
import type { HarnessRunMarker } from "../lib/harnessCrashTelemetry";
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
import type { TurnInputContextSignals } from "../lib/turnIntake";
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
  config: {
    sessionRecordingEnabled?: boolean;
    reasoningDisplay?: string;
  };
  startGoal: (objective: string, options: { sessionKey: string; sourceContext?: string; ownerTurnId: string }) => void;
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
> extends WorkflowEngineStoreHelpers {
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
  persistHarnessRunMarker: (marker: HarnessRunMarker) => HarnessRunMarker;
  getWorkspaceTree: (workspace: string) => Promise<string>;
  nowMs: () => number;
  sendStartedAt: number;
  getLastTurnToolSummary: (turnId: string, taskFlow: TaskBlock[]) => string;
  getLastVisibleTurnAgentSummary: (turnId: string, taskFlow: TaskBlock[]) => string;
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

export async function runSubmitAsyncWorkflowRun<
  TState extends SubmitAsyncWorkflowRunState,
  TAbortController extends AbortController,
>(
  input: StartSubmitAsyncWorkflowRunInput<TState, TAbortController>,
): Promise<void> {
  const phaseRunners = input.phaseRunners || {};
  const phaseLanguage = input.preferredLanguage === "en" ? "en" : "zh";
  let userContent = input.text;
  const activeStudioAgentKey = input.sessionGet().activeStudioAgentKey;
  const gameStudioInitialized = input.sessionGet().gameStudioInitialized;

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
    turnId: input.turnId,
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
    nextTaskId: input.nextTaskId,
    sessionGet: input.sessionGet,
    sessionSet: input.sessionSet,
    disposeElapsedTimer: () => {
      input.elapsedTimer.dispose();
      input.sessionSet({ elapsedTime: input.elapsedTimer.getElapsedSeconds() });
    },
    invalidateWorkspaceTreeCache: input.invalidateWorkspaceTreeCache,
  });
  if (!gameStudioPreparation.ok) {
    return;
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
    continueExistingGoal:
      (input.options as { continueExistingGoal?: boolean } | null | undefined)?.continueExistingGoal === true,
    parentRunIdOverride: input.parentRunIdOverride,
    runIdOverride: input.runIdOverride,
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
    startGoal: (objective: string, goalOptions: { sessionKey: string; sourceContext?: string; ownerTurnId: string }) => {
      input.sessionGet().startGoal(objective, goalOptions);
    },
    getCurrentHarnessInstanceId: input.getCurrentHarnessInstanceId,
    persistHarnessRunMarker: input.persistHarnessRunMarker,
    setHarnessRunMarker: (harnessRunMarker: HarnessRunMarker) => {
      input.sessionSet({ harnessRunMarker });
    },
  } satisfies StartSubmitRunLeaseInput<TAbortController>);

  const workspaceTreeStartedAt = input.nowMs();
  const workspaceTree = await input.getWorkspaceTree(input.runWorkspace);
  input.logStoreEvent("workspace_tree_ready", {
    turnId: input.turnId,
    workspace: input.runWorkspace || "global",
    chars: workspaceTree.length,
    elapsedMs: Math.round(input.nowMs() - workspaceTreeStartedAt),
  });

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

  void (phaseRunners.runWorkflowEngine || runSubmitWorkflowEngine)({
    get: input.sessionGet,
    set: input.sessionSet,
    context,
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    sanitizeAgentMessagesForPersist: input.sanitizeAgentMessagesForPersist,
    normalizeSessionRuntimeSnapshot: input.normalizeSessionRuntimeSnapshot,
    normalizeProviderCompatibilityByRuntimeKey: input.normalizeProviderCompatibilityByRuntimeKey,
    compactCompletedTurnAgentMessages: input.compactCompletedTurnAgentMessages,
    normalizeQueuedUserMessage: input.normalizeQueuedUserMessage,
    startApprovedPlanExecutionInCurrentTurn: input.startApprovedPlanExecutionInCurrentTurn,
    logStoreEvent: input.logStoreEvent,
  } satisfies RunSubmitWorkflowEngineInput);
}

export function startSubmitAsyncWorkflowRun<
  TState extends SubmitAsyncWorkflowRunState,
  TAbortController extends AbortController,
>(
  input: StartSubmitAsyncWorkflowRunInput<TState, TAbortController>,
): Promise<void> {
  return runSubmitAsyncWorkflowRun(input);
}
