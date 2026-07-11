import { buildSubmitLocalStudioTurnPatch } from "../lib/submit/turnSubmission";
import type { TaskBlock } from "../lib/taskTypes";
import type { ConversationTurn } from "../lib/workflowModels";
import type { CommandDirective, LegacyWorkflowMode, ResolvedRunIntent } from "../lib/runIntent";
import {
  MAIN_THREAD_EVENT_SCHEMA_VERSION,
  appendRuntimeEvent,
  normalizeEventStreamMode,
  withEventSchema,
  type MainThreadEventInput,
} from "../lib/turnEvents";

type SessionGet = () => any;
type SessionSet = (patch: any) => void;

export interface GameStudioLocalSlashBridgeInput {
  sessionGet: SessionGet;
  sessionSet: SessionSet;
  nextTaskId: () => number;
  text: string;
  turnId: string;
  userContextItems: Extract<TaskBlock, { type: "user" }>["contextItems"];
  isHidden: boolean;
  reuseCurrentTurn: boolean;
  parentPlanTurnId?: string | null;
  preferredLanguage: "zh" | "en";
  effectiveRunIntent: ResolvedRunIntent;
  effectiveDisplayIntent: ResolvedRunIntent;
  effectiveIntentSummary: string;
  effectiveCommandDirective: CommandDirective | null;
  effectiveWorkflowMode: LegacyWorkflowMode;
  turnTitle: string;
  shouldSeedSessionTitleForTurn: boolean;
  ensuredSessionId: number | null | undefined;
  sessionScopeKey: string;
  titleIntentSignature: string | null;
  sanitizeTaskBlocksForPersist: (blocks: TaskBlock[]) => TaskBlock[];
  normalizeSessionRuntimeSnapshot: (snapshot: Record<string, unknown>) => unknown;
}

export interface GameStudioLocalSlashBridge {
  appendLocalStudioTurn: (
    systemContent: string,
    options?: { systemVariant?: Extract<TaskBlock, { type: "system" }>["variant"] },
  ) => Promise<void>;
  emitLocalSlashRuntimeEvent: (event: MainThreadEventInput) => void;
}

function buildLocalSlashRuntimeSnapshot(state: any): Record<string, unknown> {
  return {
    runtimeEventSchemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
    runtimeEvents: state.runtimeEvents,
    harnessRunMarker: state.harnessRunMarker,
    taskFlow: state.taskFlow,
    agentMessages: state.agentMessages,
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
    webSearchEnabled: state.webSearchEnabled,
    webSearchProvider: state.webSearchProvider,
    queuedUserMessage: state.queuedUserMessage,
    activeGuidance: state.activeGuidance,
  };
}

export function createGameStudioLocalSlashBridge(
  input: GameStudioLocalSlashBridgeInput,
): GameStudioLocalSlashBridge {
  const appendLocalStudioTurn: GameStudioLocalSlashBridge["appendLocalStudioTurn"] = async (
    systemContent,
    options,
  ) => {
    const userBlockId = input.isHidden ? null : input.nextTaskId();
    const systemBlockId = input.nextTaskId();
    const createdAtMs = Date.now();
    input.sessionSet((s: any) => {
      const localStudioTurnPatch = buildSubmitLocalStudioTurnPatch({
        taskFlow: s.taskFlow,
        conversationTurns: s.conversationTurns as ConversationTurn[],
        text: input.text,
        systemContent,
        turnId: input.turnId,
        userBlockId,
        systemBlockId,
        userContextItems: input.userContextItems,
        isHidden: input.isHidden,
        reuseCurrentTurn: input.reuseCurrentTurn,
        parentPlanTurnId: input.parentPlanTurnId || undefined,
        parentPlanTurnDoneSummary: input.preferredLanguage === "en"
          ? "Plan approved; execution was handed off to a new turn."
          : "计划已批准，执行已交接到新的回合。",
        effectiveRunIntent: input.effectiveRunIntent,
        effectiveDisplayIntent: input.effectiveDisplayIntent,
        effectiveIntentSummary: input.effectiveIntentSummary,
        effectiveCommandDirective: input.effectiveCommandDirective,
        effectiveWorkflowMode: input.effectiveWorkflowMode,
        turnTitle: input.turnTitle,
        systemVariant: options?.systemVariant,
        createdAtMs,
      });
      return {
        taskFlow: localStudioTurnPatch.taskFlow,
        conversationTurns: localStudioTurnPatch.conversationTurns,
        currentTurnId: input.turnId,
        input: input.isHidden ? s.input : "",
        contextMentions: [],
        attachedFiles: [],
        pendingSlashCommand: null,
        lockedComposerIntent: null,
        pendingRunDecision: null,
        preferredResponseLanguage: input.preferredLanguage,
        isGenerating: false,
        agentStatus: "idle",
        elapsedTime: 0,
      };
    });

    if (!input.isHidden && input.shouldSeedSessionTitleForTurn && input.ensuredSessionId) {
      const latest = input.sessionGet();
      latest.updateSession(input.sessionScopeKey, input.ensuredSessionId, {
        title: input.turnTitle,
        titleSource: "local_seed",
        titleIntentSignature: input.titleIntentSignature,
        active: true,
        messages: input.sanitizeTaskBlocksForPersist(latest.taskFlow),
        storageStatus: latest.config.sessionRecordingEnabled ? "ok" : "temporary",
        recordingDisabled: !latest.config.sessionRecordingEnabled,
        runtimeSnapshot: input.normalizeSessionRuntimeSnapshot(
          buildLocalSlashRuntimeSnapshot(latest),
        ),
      });
    }
  };

  const emitLocalSlashRuntimeEvent = (event: MainThreadEventInput) => {
    if (normalizeEventStreamMode(input.sessionGet().config.eventStreamMode) === "legacy") return;
    input.sessionSet((s: any) => ({
      runtimeEvents: appendRuntimeEvent(s.runtimeEvents, withEventSchema(event)),
    }));
  };

  return {
    appendLocalStudioTurn,
    emitLocalSlashRuntimeEvent,
  };
}
