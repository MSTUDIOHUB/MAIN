import {
  buildSubmitLocalStudioTurnPatch,
  resolveSubmitExistingTurnAdoptionDecision,
  type SubmitExistingTurnAdoptionDecision,
} from "../lib/submit/turnSubmission";
import type { TaskBlock } from "../lib/taskTypes";
import type { ConversationTurn } from "../lib/workflowModels";
import type { CommandDirective, LegacyWorkflowMode, ResolvedRunIntent } from "../lib/runIntent";
import {
  MAIN_THREAD_EVENT_SCHEMA_VERSION,
  appendRuntimeEvent,
  normalizeEventStreamMode,
  withEventSchema,
  type MainThreadEventInput,
  type TerminalResultKind,
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
  /** Adopt the exact Turn admitted by the workspace FIFO instead of creating another user block. */
  adoptExistingTurn?: boolean;
  /** Exact visible user block already linked to the admitted Turn. */
  admittedUserBlockId?: number;
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

export interface GameStudioLocalSlashTerminalContext {
  runId: string;
  parentRunId: string | null;
  resultKind: TerminalResultKind;
  reason: string;
  timestampMs?: number;
}

export interface GameStudioLocalSlashAppendOptions {
  systemVariant?: Extract<TaskBlock, { type: "system" }>["variant"];
  /** Errors and cancellations are rendered as the unique visible assistant conclusion. */
  presentation?: "system" | "assistant_final";
  terminal?: GameStudioLocalSlashTerminalContext;
}

export type GameStudioLocalSlashAppendResult =
  | {
      disposition: "appended";
      turnId: string;
      conclusionBlockId: number;
      userBlockId: number | null;
      presentation: "system" | "assistant_final";
      adoptionDecision: Exclude<SubmitExistingTurnAdoptionDecision, { kind: "rejected" }>;
      terminal: GameStudioLocalSlashTerminalContext | null;
    }
  | {
      disposition: "rejected";
      turnId: string;
      conclusionBlockId: null;
      userBlockId: number | null;
      presentation: "system" | "assistant_final";
      adoptionDecision: Extract<SubmitExistingTurnAdoptionDecision, { kind: "rejected" }>;
      terminal: GameStudioLocalSlashTerminalContext | null;
    };

export interface GameStudioLocalSlashBridge {
  appendLocalStudioTurn: (
    systemContent: string,
    options?: GameStudioLocalSlashAppendOptions,
  ) => Promise<GameStudioLocalSlashAppendResult>;
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
    workspaceTurnQueue: state.workspaceTurnQueue,
  };
}

export function createGameStudioLocalSlashBridge(
  input: GameStudioLocalSlashBridgeInput,
): GameStudioLocalSlashBridge {
  const appendLocalStudioTurn: GameStudioLocalSlashBridge["appendLocalStudioTurn"] = async (
    systemContent,
    options,
  ) => {
    const presentation = options?.presentation || "system";
    const createdAtMs = Date.now();
    let appendResult: GameStudioLocalSlashAppendResult | null = null;
    input.sessionSet((s: any) => {
      const adoptionDecision = resolveSubmitExistingTurnAdoptionDecision({
        adoptExistingTurn: input.adoptExistingTurn,
        reuseCurrentTurn: input.reuseCurrentTurn,
        isHidden: input.isHidden,
        turnIdOverride: input.turnId,
        admittedUserBlockId: input.admittedUserBlockId,
        conversationTurns: s.conversationTurns as ConversationTurn[],
        taskFlow: s.taskFlow as TaskBlock[],
      });
      if (adoptionDecision.kind === "rejected") {
        appendResult = {
          disposition: "rejected",
          turnId: input.turnId,
          conclusionBlockId: null,
          userBlockId: input.admittedUserBlockId ?? null,
          presentation,
          adoptionDecision,
          terminal: options?.terminal || null,
        };
        return {};
      }

      const userBlockId = input.isHidden || adoptionDecision.kind === "adopted"
        ? null
        : input.nextTaskId();
      const conclusionBlockId = input.nextTaskId();

      if (adoptionDecision.kind === "adopted") {
        const conclusionBlock: TaskBlock = presentation === "assistant_final"
          ? {
              id: conclusionBlockId,
              turnId: input.turnId,
              type: "agent",
              content: systemContent,
              streaming: false,
              visibility: "assistant_final",
            }
          : {
              id: conclusionBlockId,
              turnId: input.turnId,
              type: "system",
              content: systemContent,
              ...(options?.systemVariant ? { variant: options.systemVariant } : {}),
            };
        const terminal = options?.terminal;
        appendResult = {
          disposition: "appended",
          turnId: input.turnId,
          conclusionBlockId,
          userBlockId: adoptionDecision.userBlockId,
          presentation,
          adoptionDecision,
          terminal: terminal || null,
        };
        const baseTaskFlow = presentation === "assistant_final"
          ? (s.taskFlow as TaskBlock[]).map((block) =>
              block.turnId === input.turnId &&
              block.type === "agent" &&
              block.visibility === "assistant_final"
                ? { ...block, visibility: "assistant_update" as const }
                : block
            )
          : s.taskFlow;
        return {
          taskFlow: [...baseTaskFlow, conclusionBlock],
          conversationTurns: (s.conversationTurns as ConversationTurn[]).map((turn) =>
            turn.id === input.turnId
              ? {
                  ...turn,
                  userPrompt: input.text,
                  title: input.turnTitle,
                  status: terminal?.resultKind === "error" ? "error" as const : "done" as const,
                  summary: systemContent,
                  mode: input.effectiveWorkflowMode,
                  intent: input.effectiveRunIntent,
                  displayIntent: input.effectiveDisplayIntent,
                  intentSummary: input.effectiveIntentSummary,
                  commandDirective: input.effectiveCommandDirective || undefined,
                  blockIds: turn.blockIds.includes(conclusionBlockId)
                    ? turn.blockIds
                    : [...turn.blockIds, conclusionBlockId],
                  ...(terminal
                    ? {
                        runtimeOutcome: {
                          status: "completed" as const,
                          reason: terminal.reason,
                          resultKind: terminal.resultKind,
                          runId: terminal.runId,
                          parentRunId: terminal.parentRunId,
                          updatedAt: terminal.timestampMs ?? createdAtMs,
                        },
                      }
                    : {}),
                }
              : turn
          ),
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
      }

      const localStudioTurnPatch = buildSubmitLocalStudioTurnPatch({
        taskFlow: s.taskFlow,
        conversationTurns: s.conversationTurns as ConversationTurn[],
        text: input.text,
        systemContent,
        turnId: input.turnId,
        userBlockId,
        systemBlockId: conclusionBlockId,
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
      const taskFlow = presentation === "assistant_final"
        ? localStudioTurnPatch.taskFlow.map((block) =>
            block.id === conclusionBlockId && block.type === "system"
              ? {
                  id: block.id,
                  turnId: block.turnId,
                  type: "agent" as const,
                  content: block.content,
                  streaming: false,
                  visibility: "assistant_final" as const,
                }
              : block.turnId === input.turnId &&
                block.type === "agent" &&
                block.visibility === "assistant_final"
                ? { ...block, visibility: "assistant_update" as const }
              : block
          )
        : localStudioTurnPatch.taskFlow;
      const terminal = options?.terminal;
      const conversationTurns = localStudioTurnPatch.conversationTurns.map((turn) =>
        turn.id === input.turnId
          ? {
              ...turn,
              status: terminal?.resultKind === "error" ? "error" as const : "done" as const,
              summary: systemContent,
              ...(terminal
                ? {
                    runtimeOutcome: {
                      status: "completed" as const,
                      reason: terminal.reason,
                      resultKind: terminal.resultKind,
                      runId: terminal.runId,
                      parentRunId: terminal.parentRunId,
                      updatedAt: terminal.timestampMs ?? createdAtMs,
                    },
                  }
                : {}),
            }
          : turn
      );
      appendResult = {
        disposition: "appended",
        turnId: input.turnId,
        conclusionBlockId,
        userBlockId: localStudioTurnPatch.userBlock?.id ?? null,
        presentation,
        adoptionDecision,
        terminal: terminal || null,
      };
      return {
        taskFlow,
        conversationTurns,
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

    const resolvedAppendResult = appendResult as GameStudioLocalSlashAppendResult | null;
    if (!resolvedAppendResult) {
      throw new Error("Local slash bridge did not produce an append result");
    }
    if (resolvedAppendResult.disposition === "rejected") return resolvedAppendResult;

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
    return resolvedAppendResult;
  };

  const emitLocalSlashRuntimeEvent = (event: MainThreadEventInput) => {
    const eventStreamMode = normalizeEventStreamMode(input.sessionGet().config.eventStreamMode);
    // Canonical run/Turn lifecycle remains authoritative even when legacy
    // transcript diagnostics are disabled.
    if (eventStreamMode === "legacy" && event.type.startsWith("slash.command.")) return;
    input.sessionSet((s: any) => ({
      runtimeEvents: appendRuntimeEvent(s.runtimeEvents, withEventSchema(event)),
    }));
  };

  return {
    appendLocalStudioTurn,
    emitLocalSlashRuntimeEvent,
  };
}
