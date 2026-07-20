import {
  buildSubmitLocalStudioTurnPatch,
  resolveSubmitExistingTurnAdoptionDecision,
  type SubmitExistingTurnAdoptionDecision,
} from "../lib/submit/turnSubmission";
import type { TaskBlock } from "../lib/taskTypes";
import {
  isConversationTurnRuntimeClosed,
  type ConversationTurn,
} from "../lib/workflowModels";
import type { CommandDirective, LegacyWorkflowMode, ResolvedRunIntent } from "../lib/runIntent";
import {
  MAIN_THREAD_EVENT_SCHEMA_VERSION,
  appendRuntimeEvent,
  normalizeEventStreamMode,
  withEventSchema,
  type MainThreadEvent,
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
  runSessionKey: string;
  titleIntentSignature: string | null;
  sanitizeTaskBlocksForPersist: (blocks: TaskBlock[]) => TaskBlock[];
  normalizeSessionRuntimeSnapshot: (snapshot: Record<string, unknown>) => unknown;
  /**
   * Production durability barrier for a completed local-fast conclusion. The
   * callback persists the exact owner projection (including FIFO retirement)
   * and publishes it under the captured Session revision before resolving.
   */
  commitLocalSlashProjection?: (
    context: GameStudioLocalSlashProjectionCommitContext,
  ) => Promise<void>;
}

export interface GameStudioLocalSlashTerminalContext {
  runId: string;
  parentRunId: string | null;
  resultKind: TerminalResultKind;
  reason: string;
  timestampMs?: number;
}

export interface GameStudioLocalSlashLifecycleContext {
  terminal: GameStudioLocalSlashTerminalContext;
  slash: {
    command: string;
    executionMode: "local_fast" | "model_workflow";
    outcome: "completed" | "failed";
    error?: { message: string };
  };
}

export interface GameStudioLocalSlashConclusionOwner {
  disposition: "original_appended" | "original_repaired" | "recovery_completed";
  turnId: string;
  runId: string;
  parentRunId: string | null;
  resultKind: TerminalResultKind;
  summary: string;
}

export interface GameStudioLocalSlashProjectionCommitContext {
  includeTitle: boolean;
  sessionKey: string;
  sourceTurnId: string;
  sourceRunId: string;
  conclusionOwner: GameStudioLocalSlashConclusionOwner;
}

export interface GameStudioLocalSlashAppendOptions {
  systemVariant?: Extract<TaskBlock, { type: "system" }>["variant"];
  /** Errors and cancellations are rendered as the unique visible assistant conclusion. */
  presentation?: "system" | "assistant_final";
  /**
   * The visible conclusion and complete slash/Run/Turn terminal lifecycle are
   * committed by one owner-revalidated state transition.
   */
  lifecycle?: GameStudioLocalSlashLifecycleContext;
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

export type GameStudioLocalSlashConclusionResolution =
  | {
      disposition: "original_repaired";
      turnId: string;
      runId: string;
      parentRunId: string | null;
      resultKind: TerminalResultKind;
      summary: string;
    }
  | {
      disposition: "recovery_completed";
      turnId: string;
      runId: string;
      parentRunId: string;
      resultKind: TerminalResultKind;
      summary: string;
    };

export interface GameStudioLocalSlashFailureContext {
  command: string;
  executionMode: "local_fast" | "model_workflow";
  error: { message: string };
}

export interface GameStudioLocalSlashBridge {
  appendLocalStudioTurn: (
    systemContent: string,
    options?: GameStudioLocalSlashAppendOptions,
  ) => Promise<GameStudioLocalSlashAppendResult>;
  ensureVisibleConclusion: (input: {
    content: string;
    terminal: GameStudioLocalSlashTerminalContext;
    rejectedAppend: Extract<GameStudioLocalSlashAppendResult, { disposition: "rejected" }> | null;
    slashFailure: GameStudioLocalSlashFailureContext;
  }) => Promise<GameStudioLocalSlashConclusionResolution>;
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
  const initialState = input.sessionGet();
  const initialOwnerTurns = input.adoptExistingTurn
    ? (initialState.conversationTurns as ConversationTurn[]).filter(
        (turn) => turn.id === input.turnId,
      )
    : [];
  const initialOwnerBlocks = input.adoptExistingTurn && input.admittedUserBlockId != null
    ? (initialState.taskFlow as TaskBlock[]).filter(
        (block) => block.id === input.admittedUserBlockId,
      )
    : [];
  const initialOwnerTurn = initialOwnerTurns.length === 1 ? initialOwnerTurns[0] : null;
  const initialOwnerBlock = initialOwnerBlocks.length === 1 && initialOwnerBlocks[0].type === "user"
    ? initialOwnerBlocks[0]
    : null;
  const capturedAdoptionOwner = initialOwnerTurn && initialOwnerBlock &&
      initialOwnerBlock.turnId === input.turnId &&
      initialOwnerTurn.blockIds.includes(initialOwnerBlock.id)
    ? {
        turnId: input.turnId,
        userBlockId: initialOwnerBlock.id,
        userBlockContent: initialOwnerBlock.content,
        createdAt: initialOwnerTurn.createdAt,
        clientSubmissionId: initialOwnerTurn.clientSubmissionId || null,
        workspaceInstructionReceiptId: initialOwnerTurn.workspaceInstructionReceiptId || null,
      }
    : null;

  const stillOwnsCapturedAdoptionTurn = (state: any): boolean => {
    if (!capturedAdoptionOwner) return false;
    const turns = (state.conversationTurns as ConversationTurn[]).filter(
      (turn) => turn.id === capturedAdoptionOwner.turnId,
    );
    const blocks = (state.taskFlow as TaskBlock[]).filter(
      (block) => block.id === capturedAdoptionOwner.userBlockId,
    );
    if (turns.length !== 1 || blocks.length !== 1 || blocks[0].type !== "user") return false;
    const turn = turns[0];
    const block = blocks[0];
    return block.turnId === capturedAdoptionOwner.turnId &&
      block.content === capturedAdoptionOwner.userBlockContent &&
      turn.blockIds.includes(capturedAdoptionOwner.userBlockId) &&
      turn.createdAt === capturedAdoptionOwner.createdAt &&
      (turn.clientSubmissionId || null) === capturedAdoptionOwner.clientSubmissionId &&
      (turn.workspaceInstructionReceiptId || null) ===
        capturedAdoptionOwner.workspaceInstructionReceiptId;
  };

  const projectLocalSlashSessionRecord = (includeTitle: boolean) => {
    if (input.isHidden || !input.ensuredSessionId) return;
    const latest = input.sessionGet();
    const maySeedTitle = includeTitle &&
      input.shouldSeedSessionTitleForTurn &&
      latest.currentTurnId === input.turnId;
    latest.updateSession(input.sessionScopeKey, input.ensuredSessionId, {
      ...(maySeedTitle
        ? {
            title: input.turnTitle,
            titleSource: "local_seed",
            titleIntentSignature: input.titleIntentSignature,
          }
        : {}),
      active: true,
      messages: input.sanitizeTaskBlocksForPersist(latest.taskFlow),
      storageStatus: latest.config.sessionRecordingEnabled ? "ok" : "temporary",
      recordingDisabled: !latest.config.sessionRecordingEnabled,
      runtimeSnapshot: input.normalizeSessionRuntimeSnapshot(
        buildLocalSlashRuntimeSnapshot(latest),
      ),
    });
  };

  const commitLocalSlashProjection = async (
    context: GameStudioLocalSlashProjectionCommitContext,
    projectionMutated: boolean,
  ): Promise<void> => {
    if (input.commitLocalSlashProjection) {
      // The production callback is also invoked for an already-canonical
      // projection. That path is the durability retry after a prior save/CAS
      // interruption and must not be optimized away as an idempotent replay.
      await input.commitLocalSlashProjection(context);
      return;
    }
    // Unit/embedding fallback: retain the historical in-memory Session
    // projection when no durable Project Session adapter is available.
    if (projectionMutated) projectLocalSlashSessionRecord(context.includeTitle);
  };

  const assertLifecycleAuthorityAvailable = (
    state: any,
    lifecycle: GameStudioLocalSlashLifecycleContext,
  ) => {
    const terminal = lifecycle.terminal;
    const turn = (state.conversationTurns as ConversationTurn[]).find(
      (candidate) => candidate.id === input.turnId,
    );
    const runtimeEvents = (state.runtimeEvents || []) as MainThreadEvent[];
    const hasRunConclusion = runtimeEvents.some((event) =>
      event.type === "run.completed" &&
      event.threadId === input.runSessionKey &&
      event.turnId === input.turnId &&
      event.runId === terminal.runId
    );
    const hasTurnConclusion = runtimeEvents.some((event) =>
      event.type === "turn.completed" &&
      event.threadId === input.runSessionKey &&
      event.turnId === input.turnId
    );
    const hasSlashConclusion = runtimeEvents.some((event) =>
      (event.type === "slash.command.completed" || event.type === "slash.command.failed") &&
      event.threadId === input.runSessionKey &&
      event.turnId === input.turnId &&
      event.command === lifecycle.slash.command
    );
    if (
      hasRunConclusion ||
      hasTurnConclusion ||
      hasSlashConclusion ||
      isConversationTurnRuntimeClosed(turn?.runtimeOutcome)
    ) {
      throw new Error(
        `Local slash lifecycle authority conflict for ${input.turnId}/${terminal.runId}`,
      );
    }
  };

  const appendAtomicLifecycle = (
    state: any,
    lifecycle: GameStudioLocalSlashLifecycleContext | undefined,
    summary: string,
    timestampMs: number,
  ): MainThreadEvent[] | undefined => {
    if (!lifecycle) return undefined;
    const terminal = lifecycle.terminal;
    const slash = lifecycle.slash;
    const expectsCompletedSlash = terminal.resultKind === "success";
    if (
      (expectsCompletedSlash && slash.outcome !== "completed") ||
      (!expectsCompletedSlash && slash.outcome !== "failed") ||
      (slash.outcome === "failed" && !slash.error?.message)
    ) {
      throw new Error(
        `Local slash lifecycle outcome mismatch for ${input.turnId}/${terminal.runId}`,
      );
    }
    let runtimeEvents = (state.runtimeEvents || []) as MainThreadEvent[];
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
      type: "run.started",
      threadId: input.runSessionKey,
      turnId: input.turnId,
      timestampMs,
      runId: terminal.runId,
      parentRunId: terminal.parentRunId,
    }));
    const eventStreamMode = normalizeEventStreamMode(state.config.eventStreamMode);
    if (eventStreamMode !== "legacy") {
      const hasSlashStart = runtimeEvents.some((event) =>
        event.type === "slash.command.started" &&
        event.threadId === input.runSessionKey &&
        event.turnId === input.turnId &&
        event.command === slash.command
      );
      if (!hasSlashStart) {
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "slash.command.started",
          threadId: input.runSessionKey,
          turnId: input.turnId,
          timestampMs,
          command: slash.command,
          executionMode: slash.executionMode,
        }));
      }
      if (slash.outcome === "completed") {
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "slash.command.completed",
          threadId: input.runSessionKey,
          turnId: input.turnId,
          timestampMs,
          command: slash.command,
          executionMode: slash.executionMode,
        }));
      }
    }
    // Failure evidence remains structured even when legacy transcript
    // diagnostics suppress ordinary slash start/success events.
    if (slash.outcome === "failed") {
      runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
        type: "slash.command.failed",
        threadId: input.runSessionKey,
        turnId: input.turnId,
        timestampMs,
        command: slash.command,
        executionMode: slash.executionMode,
        error: slash.error!,
      }));
    }
    if (terminal.resultKind === "canceled") {
      runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
        type: "run.aborted",
        threadId: input.runSessionKey,
        turnId: input.turnId,
        timestampMs,
        runId: terminal.runId,
        parentRunId: terminal.parentRunId,
        reason: terminal.reason,
        message: summary,
      }));
    }
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
      type: "run.completed",
      threadId: input.runSessionKey,
      turnId: input.turnId,
      timestampMs,
      runId: terminal.runId,
      parentRunId: terminal.parentRunId,
      resultKind: terminal.resultKind,
      summary,
    }));
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
      type: "turn.completed",
      threadId: input.runSessionKey,
      turnId: input.turnId,
      timestampMs,
      resultKind: terminal.resultKind,
    }));
    return runtimeEvents;
  };

  const appendLocalStudioTurn: GameStudioLocalSlashBridge["appendLocalStudioTurn"] = async (
    systemContent,
    options,
  ) => {
    const presentation = options?.presentation || "system";
    const createdAtMs = options?.lifecycle?.terminal.timestampMs ?? Date.now();
    let appendResult: GameStudioLocalSlashAppendResult | null = null;
    input.sessionSet((s: any) => {
      if (options?.lifecycle) {
        assertLifecycleAuthorityAvailable(s, options.lifecycle);
      }
      let adoptionDecision = resolveSubmitExistingTurnAdoptionDecision({
        adoptExistingTurn: input.adoptExistingTurn,
        reuseCurrentTurn: input.reuseCurrentTurn,
        isHidden: input.isHidden,
        turnIdOverride: input.turnId,
        admittedUserBlockId: input.admittedUserBlockId,
        conversationTurns: s.conversationTurns as ConversationTurn[],
        taskFlow: s.taskFlow as TaskBlock[],
      });
      // The generic adoption validator proves that the current state is
      // internally consistent. Local-fast work also has to prove that it is
      // still the exact immutable owner captured at FIFO admission; otherwise
      // a same-ID replacement could be mistaken for the original Turn.
      if (
        adoptionDecision.kind === "adopted" &&
        !stillOwnsCapturedAdoptionTurn(s)
      ) {
        adoptionDecision = {
          kind: "rejected",
          reason: "turn_identity_not_exact",
          turnId: input.turnId,
          userBlockId: input.admittedUserBlockId ?? null,
        };
      }
      if (adoptionDecision.kind === "rejected") {
        appendResult = {
          disposition: "rejected",
          turnId: input.turnId,
          conclusionBlockId: null,
          userBlockId: input.admittedUserBlockId ?? null,
          presentation,
          adoptionDecision,
          terminal: options?.lifecycle?.terminal || null,
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
        const terminal = options?.lifecycle?.terminal;
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
        const runtimeEvents = appendAtomicLifecycle(
          s,
          options?.lifecycle,
          systemContent,
          createdAtMs,
        );
        const ownsCurrentTurn = s.currentTurnId === input.turnId || !s.currentTurnId;
        return {
          taskFlow: [...baseTaskFlow, conclusionBlock],
          conversationTurns: (s.conversationTurns as ConversationTurn[]).map((turn) =>
            turn.id === input.turnId
              ? {
                  ...turn,
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
          ...(runtimeEvents ? { runtimeEvents } : {}),
          ...(ownsCurrentTurn
            ? {
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
              }
            : {}),
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
      const terminal = options?.lifecycle?.terminal;
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
      const ownsCurrentTurn = s.currentTurnId === input.turnId || !s.currentTurnId;
      const runtimeEvents = appendAtomicLifecycle(
        s,
        options?.lifecycle,
        systemContent,
        createdAtMs,
      );
      return {
        taskFlow,
        conversationTurns,
        ...(runtimeEvents ? { runtimeEvents } : {}),
        ...(ownsCurrentTurn
          ? {
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
            }
          : {}),
      };
    });

    const resolvedAppendResult = appendResult as GameStudioLocalSlashAppendResult | null;
    if (!resolvedAppendResult) {
      throw new Error("Local slash bridge did not produce an append result");
    }
    if (resolvedAppendResult.disposition === "rejected") return resolvedAppendResult;

    if (resolvedAppendResult.terminal) {
      await commitLocalSlashProjection({
        includeTitle: true,
        sessionKey: input.runSessionKey,
        sourceTurnId: input.turnId,
        sourceRunId: resolvedAppendResult.terminal.runId,
        conclusionOwner: {
          disposition: "original_appended",
          turnId: input.turnId,
          runId: resolvedAppendResult.terminal.runId,
          parentRunId: resolvedAppendResult.terminal.parentRunId,
          resultKind: resolvedAppendResult.terminal.resultKind,
          summary: systemContent,
        },
      }, true);
    } else {
      projectLocalSlashSessionRecord(true);
    }
    return resolvedAppendResult;
  };

  const ensureVisibleConclusion: GameStudioLocalSlashBridge["ensureVisibleConclusion"] = async ({
    content,
    terminal,
    rejectedAppend,
    slashFailure,
  }) => {
    let resolution: GameStudioLocalSlashConclusionResolution | null = null;
    let projectionMutated = false;
    let conflictError: Error | null = null;
    input.sessionSet((s: any) => {
      const turns = s.conversationTurns as ConversationTurn[];
      const blocks = s.taskFlow as TaskBlock[];
      const matchingTurns = turns.filter(
        (turn) => turn.id === input.turnId,
      );
      const matchingBlocks = blocks.filter((block) => block.turnId === input.turnId);
      const originalTurn = matchingTurns.length === 1 ? matchingTurns[0] : null;
      const closedStatus = originalTurn && new Set([
        "completed_with_changes",
        "stopped_no_action",
        "stopped_no_output",
        "done",
        "error",
      ]).has(originalTurn.status);
      const alreadyOwnsTerminalRun = !!originalTurn &&
        originalTurn.runtimeOutcome?.status === "completed" &&
        originalTurn.runtimeOutcome.runId === terminal.runId &&
        originalTurn.runtimeOutcome.parentRunId === terminal.parentRunId;
      const originalIsOpen = !!originalTurn &&
        !closedStatus &&
        !isConversationTurnRuntimeClosed(originalTurn.runtimeOutcome);
      const capturedOwnerIsExact = input.adoptExistingTurn === true &&
        stillOwnsCapturedAdoptionTurn(s);
      const canRepairOriginal = input.adoptExistingTurn === true
        ? capturedOwnerIsExact && (originalIsOpen || alreadyOwnsTerminalRun)
        : matchingTurns.length === 0 && matchingBlocks.length === 0
        ? true
        : matchingTurns.length === 1 && alreadyOwnsTerminalRun;

      const createdAtMs = terminal.timestampMs ?? Date.now();
      const recoveryRunId = `${terminal.runId}-presentation-recovery`;
      const existingRecoveryTurns = turns.filter((turn) =>
        turn.runtimeOutcome?.status === "completed" &&
        turn.runtimeOutcome.runId === recoveryRunId
      );
      const existingRecoveryTurn = existingRecoveryTurns.length === 1
        ? existingRecoveryTurns[0]
        : null;
      let targetTurnId = input.turnId;
      let targetTurn = canRepairOriginal ? originalTurn : existingRecoveryTurn;
      const usingRecoveryTurn = !canRepairOriginal;
      if (usingRecoveryTurn) {
        if (existingRecoveryTurn) {
          targetTurnId = existingRecoveryTurn.id;
        } else {
          const safeRunId = terminal.runId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
          const baseTurnId = `local-slash-recovery-${safeRunId}`;
          targetTurnId = baseTurnId;
          let suffix = 0;
          while (
            turns.some((turn) => turn.id === targetTurnId) ||
            blocks.some((block) => block.turnId === targetTurnId)
          ) {
            suffix += 1;
            targetTurnId = `${baseTurnId}-${createdAtMs}-${suffix}`;
          }
          targetTurn = null;
        }
      }

      const projectedRunId = usingRecoveryTurn ? recoveryRunId : terminal.runId;
      const projectedParentRunId = usingRecoveryTurn ? terminal.runId : terminal.parentRunId;
      const runtimeEventsBefore = (s.runtimeEvents || []) as MainThreadEvent[];
      const targetRunTerminals = runtimeEventsBefore.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
        event.type === "run.completed" &&
        event.threadId === input.runSessionKey &&
        event.turnId === targetTurnId &&
        event.runId === projectedRunId,
      );
      const targetTurnTerminals = runtimeEventsBefore.filter(
        (event): event is Extract<MainThreadEvent, { type: "turn.completed" }> =>
        event.type === "turn.completed" &&
        event.threadId === input.runSessionKey &&
        event.turnId === targetTurnId,
      );
      const targetAborts = runtimeEventsBefore.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.aborted" }> =>
        event.type === "run.aborted" &&
        event.threadId === input.runSessionKey &&
        event.turnId === targetTurnId &&
        event.runId === projectedRunId,
      );
      const targetOutcome = targetTurn?.runtimeOutcome?.status === "completed"
        ? targetTurn.runtimeOutcome
        : null;
      const existingTargetFinals = blocks.filter(
        (block): block is Extract<TaskBlock, { type: "agent" }> =>
        block.turnId === targetTurnId &&
        block.type === "agent" &&
        block.visibility === "assistant_final",
      );
      const existingRunTerminal = targetRunTerminals.length === 1
        ? targetRunTerminals[0]
        : null;
      const existingTurnTerminal = targetTurnTerminals.length === 1
        ? targetTurnTerminals[0]
        : null;
      const existingResultKind = existingRunTerminal?.type === "run.completed"
        ? existingRunTerminal.resultKind
        : null;
      const abortPrecedesConclusion = existingResultKind !== "canceled" || (
        targetAborts.length === 1 &&
        runtimeEventsBefore.indexOf(targetAborts[0]) < runtimeEventsBefore.indexOf(existingRunTerminal!)
      );
      const hasCanonicalLifecycle = !!targetTurn &&
        !!existingRunTerminal &&
        !!existingTurnTerminal &&
        !!targetOutcome &&
        targetRunTerminals.length === 1 &&
        targetTurnTerminals.length === 1 &&
        targetOutcome.runId === projectedRunId &&
        targetOutcome.parentRunId === projectedParentRunId &&
        existingRunTerminal.parentRunId === projectedParentRunId &&
        existingTurnTerminal.resultKind === existingResultKind &&
        targetOutcome.resultKind === existingResultKind &&
        abortPrecedesConclusion;
      if (hasCanonicalLifecycle && existingRunTerminal?.type === "run.completed") {
        const canonicalSummary = existingRunTerminal.summary;
        const projectionIsCanonical = existingTargetFinals.length === 1 &&
          existingTargetFinals[0].streaming !== true &&
          existingTargetFinals[0].content === canonicalSummary &&
          targetTurn!.summary === canonicalSummary;
        if (projectionIsCanonical) {
          resolution = usingRecoveryTurn
            ? {
                disposition: "recovery_completed",
                turnId: targetTurnId,
                runId: projectedRunId,
                parentRunId: terminal.runId,
                resultKind: existingResultKind!,
                summary: canonicalSummary,
              }
            : {
                disposition: "original_repaired",
                turnId: input.turnId,
                runId: projectedRunId,
                parentRunId: projectedParentRunId,
                resultKind: existingResultKind!,
                summary: canonicalSummary,
              };
          return {};
        }
      }
      const hasPartialOrConflictingAuthority = targetRunTerminals.length > 0 ||
        targetTurnTerminals.length > 0 ||
        !!targetOutcome;
      if (hasPartialOrConflictingAuthority) {
        conflictError = new Error(
          `Local slash conclusion authority conflict for ${targetTurnId}/${projectedRunId}`,
        );
        return {};
      }

      const finalIndexes = blocks.flatMap((block, index) =>
        block.turnId === targetTurnId &&
        block.type === "agent" &&
        block.visibility === "assistant_final"
          ? [index]
          : []
      );
      const canonicalFinalIndex = finalIndexes.length > 0
        ? finalIndexes[finalIndexes.length - 1]
        : undefined;
      const existingFinal = canonicalFinalIndex === undefined
        ? null
        : blocks[canonicalFinalIndex];
      const userBlockId = targetTurn ? null : input.nextTaskId();
      const finalBlockId = existingFinal?.id ?? input.nextTaskId();
      let taskFlow = blocks.map((block, index) => {
        if (
          block.turnId !== targetTurnId ||
          block.type !== "agent" ||
          block.visibility !== "assistant_final"
        ) return block;
        if (index !== canonicalFinalIndex) {
          return { ...block, visibility: "assistant_update" as const };
        }
        return {
          ...block,
          content,
          streaming: false,
          hiddenProcess: false,
          visibility: "assistant_final" as const,
        };
      });
      if (!targetTurn && userBlockId != null) {
        taskFlow = [...taskFlow, {
          id: userBlockId,
          turnId: targetTurnId,
          type: "user" as const,
          content: input.text,
          ...(input.userContextItems?.length
            ? { contextItems: input.userContextItems }
            : {}),
        }];
      }
      if (canonicalFinalIndex === undefined) {
        taskFlow = [...taskFlow, {
          id: finalBlockId,
          turnId: targetTurnId,
          type: "agent" as const,
          content,
          streaming: false,
          visibility: "assistant_final" as const,
        }];
      }

      const terminalTurnPatch = {
        status: terminal.resultKind === "error" ? "error" as const : "done" as const,
        summary: content,
        runtimeOutcome: {
          status: "completed" as const,
          reason: usingRecoveryTurn ? "local_slash_presentation_recovered" : terminal.reason,
          resultKind: terminal.resultKind,
          runId: projectedRunId,
          parentRunId: projectedParentRunId,
          updatedAt: createdAtMs,
        },
      };
      const conversationTurns = targetTurn
        ? turns.map((turn) =>
            turn.id === targetTurnId
              ? {
                  ...turn,
                  ...terminalTurnPatch,
                  blockIds: turn.blockIds.includes(finalBlockId)
                    ? turn.blockIds
                    : [...turn.blockIds, finalBlockId],
                }
              : turn
          )
        : [...turns, {
            id: targetTurnId,
            userPrompt: input.text,
            title: input.turnTitle,
            intentSummary: usingRecoveryTurn && rejectedAppend
              ? `${input.effectiveIntentSummary} (${rejectedAppend.adoptionDecision.reason})`
              : input.effectiveIntentSummary,
            mode: input.effectiveWorkflowMode,
            intent: input.effectiveRunIntent,
            displayIntent: input.effectiveDisplayIntent,
            commandDirective: input.effectiveCommandDirective || undefined,
            ...terminalTurnPatch,
            blockIds: [userBlockId!, finalBlockId],
            processCollapsed: false,
            collapsed: false,
            createdAt: createdAtMs,
          }];
      let runtimeEvents = runtimeEventsBefore;
      const appendSlashFailure = (turnId: string) => {
        const alreadyRecorded = runtimeEvents.some((event) =>
          event.type === "slash.command.failed" &&
          event.threadId === input.runSessionKey &&
          event.turnId === turnId &&
          event.command === slashFailure.command &&
          event.error.message === slashFailure.error.message
        );
        if (alreadyRecorded) return;
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "slash.command.failed",
          threadId: input.runSessionKey,
          turnId,
          timestampMs: createdAtMs,
          command: slashFailure.command,
          executionMode: slashFailure.executionMode,
          error: slashFailure.error,
        }));
      };
      const appendAbort = (
        turnId: string,
        runId: string,
        parentRunId: string | null,
      ) => {
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "run.aborted",
          threadId: input.runSessionKey,
          turnId,
          timestampMs: createdAtMs,
          runId,
          parentRunId,
          reason: terminal.reason,
          message: content,
        }));
      };
      const appendRunConclusion = (
        turnId: string,
        runId: string,
        parentRunId: string | null,
      ) => {
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "run.completed",
          threadId: input.runSessionKey,
          turnId,
          timestampMs: createdAtMs,
          runId,
          parentRunId,
          resultKind: terminal.resultKind,
          summary: content,
        }));
      };
      if (usingRecoveryTurn) {
        // The immutable Run still owns its own conclusion even though its
        // stale Turn identifier can no longer own a Turn terminal. Closing it
        // here prevents a permanent running parent in trace/replay.
        appendSlashFailure(input.turnId);
        if (terminal.resultKind === "canceled") {
          appendAbort(input.turnId, terminal.runId, terminal.parentRunId);
        }
        appendRunConclusion(input.turnId, terminal.runId, terminal.parentRunId);
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "run.started",
          threadId: input.runSessionKey,
          turnId: targetTurnId,
          timestampMs: createdAtMs,
          runId: projectedRunId,
          parentRunId: projectedParentRunId,
        }));
      } else {
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "run.started",
          threadId: input.runSessionKey,
          turnId: targetTurnId,
          timestampMs: createdAtMs,
          runId: projectedRunId,
          parentRunId: projectedParentRunId,
        }));
        appendSlashFailure(targetTurnId);
      }
      if (terminal.resultKind === "canceled") {
        appendAbort(targetTurnId, projectedRunId, projectedParentRunId);
      }
      appendRunConclusion(targetTurnId, projectedRunId, projectedParentRunId);
      runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
        type: "turn.completed",
        threadId: input.runSessionKey,
        turnId: targetTurnId,
        timestampMs: createdAtMs,
        resultKind: terminal.resultKind,
      }));
      const ownsCurrentTurn = usingRecoveryTurn
        ? s.currentTurnId === targetTurnId || !s.currentTurnId
        : s.currentTurnId === input.turnId || !s.currentTurnId;
      resolution = usingRecoveryTurn
        ? {
            disposition: "recovery_completed",
            turnId: targetTurnId,
            runId: recoveryRunId,
            parentRunId: terminal.runId,
            resultKind: terminal.resultKind,
            summary: content,
          }
        : {
            disposition: "original_repaired",
            turnId: input.turnId,
            runId: terminal.runId,
            parentRunId: terminal.parentRunId,
            resultKind: terminal.resultKind,
            summary: content,
          };
      projectionMutated = true;
      return {
        taskFlow,
        conversationTurns,
        runtimeEvents,
        ...(ownsCurrentTurn
          ? {
              currentTurnId: targetTurnId,
              input: input.isHidden ? s.input : "",
              contextMentions: [],
              attachedFiles: [],
              pendingSlashCommand: null,
              lockedComposerIntent: null,
              pendingRunDecision: null,
              isGenerating: false,
              agentStatus: "idle",
              elapsedTime: 0,
            }
          : {}),
      };
    });
    if (conflictError) throw conflictError;
    if (!resolution) {
      throw new Error("Local slash conclusion repair did not resolve a terminal owner");
    }
    const resolvedConclusion = resolution as GameStudioLocalSlashConclusionResolution;
    await commitLocalSlashProjection({
      includeTitle: false,
      sessionKey: input.runSessionKey,
      sourceTurnId: input.turnId,
      sourceRunId: terminal.runId,
      conclusionOwner: resolvedConclusion,
    }, projectionMutated);
    return resolvedConclusion;
  };

  const emitLocalSlashRuntimeEvent = (event: MainThreadEventInput) => {
    const eventStreamMode = normalizeEventStreamMode(input.sessionGet().config.eventStreamMode);
    // Canonical run/Turn lifecycle remains authoritative even when legacy
    // transcript diagnostics are disabled.
    if (
      eventStreamMode === "legacy" &&
      event.type.startsWith("slash.command.") &&
      event.type !== "slash.command.failed"
    ) return;
    input.sessionSet((s: any) => {
      const runtimeEvents = (s.runtimeEvents || []) as MainThreadEvent[];
      if (
        event.type.startsWith("slash.command.") &&
        runtimeEvents.some((candidate) =>
          candidate.type === event.type &&
          candidate.threadId === event.threadId &&
          "turnId" in candidate &&
          "turnId" in event &&
          candidate.turnId === event.turnId &&
          "command" in candidate &&
          "command" in event &&
          candidate.command === event.command
        )
      ) return {};
      return {
        runtimeEvents: appendRuntimeEvent(runtimeEvents, withEventSchema(event)),
      };
    });
  };

  return {
    appendLocalStudioTurn,
    ensureVisibleConclusion,
    emitLocalSlashRuntimeEvent,
  };
}
