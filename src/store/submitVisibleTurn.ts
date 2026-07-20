import {
  buildSubmitRunStatePatch,
  buildSubmitVisibleTurnPatch,
  type SubmitExistingTurnAdoptionDecision,
} from "../lib/submit/turnSubmission";
import type { TaskBlock } from "../lib/taskTypes";
import type { UserChoiceResolutionIdentity } from "../lib/actionRequest";
import type { ConversationTurnStatus } from "../lib/workflowModels";
import type { CommandDirective, LegacyWorkflowMode, ResolvedRunIntent } from "../lib/runIntent";
import type { PendingSlashCommand } from "../lib/gameStudio/catalog";

type SubmitVisibleTurnSessionGet = () => any;
type SubmitVisibleTurnSessionSet = (patch: any) => void;

export interface ApplySubmitVisibleTurnInput {
  sessionGet: SubmitVisibleTurnSessionGet;
  sessionSet: SubmitVisibleTurnSessionSet;
  nextTaskId: () => number;
  nowMs: () => number;
  logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
  sendStartedAt: number;
  runSessionKey: string;
  runWorkspace: string | undefined;
  text: string;
  turnId: string;
  userContextItems: Extract<TaskBlock, { type: "user" }>["contextItems"];
  currentImages: string[];
  isHidden: boolean;
  reuseCurrentTurn: boolean;
  adoptExistingTurn?: boolean;
  admittedUserBlockId?: number;
  uiParentTurnId?: string | null;
  parentPlanTurnId?: string | null;
  isInternalTurn: boolean;
  shouldExplicitlyReuseCurrentTurn: boolean;
  shouldAutoResumeChoiceTurn: boolean;
  currentTurnHasReplyOptions: boolean;
  explicitReplyOptionSourceTurnId?: string;
  selectedReplyOptionText?: string;
  submittedChoiceIdentity?: UserChoiceResolutionIdentity;
  effectiveRunIntent: ResolvedRunIntent;
  effectiveDisplayIntent: ResolvedRunIntent;
  effectiveIntentSummary: string;
  effectiveCommandDirective: CommandDirective | null;
  effectiveWorkflowMode: LegacyWorkflowMode;
  initialTurnStatus: ConversationTurnStatus;
  operationProposalChoiceAction?: unknown;
  turnTitle: string;
  parsedStudioCommand: PendingSlashCommand | null;
  preferredLanguage: "zh" | "en";
  preservePlanState: boolean;
  shouldGrantExecutionConsentForTurn: boolean;
  requiresPlanExecutionAdmission?: boolean;
}

export interface ApplySubmitVisibleTurnResult {
  selectedChoiceText: string;
  adoptionDecision: SubmitExistingTurnAdoptionDecision;
  markUserContextItemFailed: (path: string | undefined | null) => void;
}

export function markSubmitUserContextItemFailed(input: {
  sessionSet: SubmitVisibleTurnSessionSet;
  turnId: string;
  userContextItems: Extract<TaskBlock, { type: "user" }>["contextItems"];
  path: string | undefined | null;
}): void {
  const failedPath = String(input.path || "").trim();
  if (!failedPath || (input.userContextItems || []).length === 0) return;
  input.sessionSet((s: any) => ({
    taskFlow: s.taskFlow.map((block: TaskBlock) => {
      if (block.turnId !== input.turnId || block.type !== "user" || !Array.isArray(block.contextItems)) return block;
      return {
        ...block,
        contextItems: block.contextItems.map((item) =>
          item.path === failedPath ? { ...item, status: "failed" as const } : item
        ),
      };
    }),
  }));
}

export function applySubmitVisibleTurn(
  input: ApplySubmitVisibleTurnInput,
): ApplySubmitVisibleTurnResult {
  const visibleTurnUserBlockId = input.isHidden
    ? null
    : input.adoptExistingTurn
      ? input.admittedUserBlockId ?? null
      : input.nextTaskId();
  const parentPlanTurnDoneSummary = input.preferredLanguage === "en"
    ? "Plan approved; execution was handed off to a new turn."
    : "计划已批准，执行已交接到新的回合。";
  const visibleTurnState = input.sessionGet();
  const visibleTurnPatch = buildSubmitVisibleTurnPatch({
    taskFlow: visibleTurnState.taskFlow,
    conversationTurns: visibleTurnState.conversationTurns,
    text: input.text,
    turnId: input.turnId,
    userBlockId: visibleTurnUserBlockId,
    userContextItems: input.userContextItems,
    images: input.currentImages,
    isHidden: input.isHidden,
    reuseCurrentTurn: input.reuseCurrentTurn,
    adoptExistingTurn: input.adoptExistingTurn,
    admittedUserBlockId: input.admittedUserBlockId,
    uiParentTurnId: input.uiParentTurnId || undefined,
    parentPlanTurnId: input.parentPlanTurnId || undefined,
    parentPlanTurnDoneSummary,
    isInternalTurn: input.isInternalTurn,
    shouldExplicitlyReuseCurrentTurn: input.shouldExplicitlyReuseCurrentTurn,
    shouldAutoResumeChoiceTurn: input.shouldAutoResumeChoiceTurn,
    currentTurnHasReplyOptions: input.currentTurnHasReplyOptions,
    explicitReplyOptionSourceTurnId: !input.isHidden ? input.explicitReplyOptionSourceTurnId : undefined,
    selectedReplyOptionText: input.selectedReplyOptionText,
    submittedChoiceIdentity: !input.isHidden ? input.submittedChoiceIdentity : undefined,
    effectiveRunIntent: input.effectiveRunIntent,
    effectiveDisplayIntent: input.effectiveDisplayIntent,
    effectiveIntentSummary: input.effectiveIntentSummary,
    effectiveCommandDirective: input.effectiveCommandDirective,
    effectiveWorkflowMode: input.effectiveWorkflowMode,
    initialTurnStatus: input.initialTurnStatus,
    operationProposalChoiceAction: input.operationProposalChoiceAction as any,
    turnTitle: input.turnTitle,
    createdAtMs: Date.now(),
  });
  if (visibleTurnPatch.adoptionDecision.kind === "rejected") {
    input.logStoreEvent("visible_turn_adoption_rejected", {
      turnId: input.turnId || null,
      userBlockId: input.admittedUserBlockId ?? null,
      reason: visibleTurnPatch.adoptionDecision.reason,
      sessionKey: input.runSessionKey,
      workspace: input.runWorkspace || null,
    });
    return {
      selectedChoiceText: "",
      adoptionDecision: visibleTurnPatch.adoptionDecision,
      markUserContextItemFailed: () => undefined,
    };
  }
  input.sessionSet({
    taskFlow: visibleTurnPatch.taskFlow,
    conversationTurns: visibleTurnPatch.conversationTurns,
  });

  const userBlock = visibleTurnPatch?.userBlock ?? null;
  const replyOptionArchiveTurnId = visibleTurnPatch?.replyOptionArchiveTurnId;
  const shouldArchiveChoiceFeedback = visibleTurnPatch?.shouldArchiveChoiceFeedback === true;
  const selectedChoiceText = visibleTurnPatch?.selectedChoiceText ?? "";
  if (shouldArchiveChoiceFeedback) {
    input.logStoreEvent("reply_options_archived", {
      turnId: input.turnId,
      sourceTurnId: replyOptionArchiveTurnId ?? null,
      sessionKey: input.runSessionKey,
      workspace: input.runWorkspace || null,
      selectedChoiceChars: selectedChoiceText.length,
      optionBlocks: visibleTurnPatch?.archiveSummary.optionBlocks ?? 0,
      archivedOptionBlocks: visibleTurnPatch?.archiveSummary.archivedOptionBlocks ?? 0,
      selectedFallbackBlocks: visibleTurnPatch?.archiveSummary.selectedFallbackBlocks ?? 0,
      matchMode: visibleTurnPatch?.archiveSummary.matchMode ?? "none",
    });
  }

  input.sessionSet((s: any) =>
    buildSubmitRunStatePatch({
      turnId: input.turnId,
      isHidden: input.isHidden,
      currentInput: s.input,
      preferredLanguage: input.preferredLanguage,
      shouldArchiveChoiceFeedback,
      currentNormalizedStreamState: s.normalizedStreamState,
      parsedStudioCommand: input.parsedStudioCommand,
      effectiveWorkflowMode: input.effectiveWorkflowMode,
      preservePlanState: input.preservePlanState,
      shouldGrantExecutionConsentForTurn: input.shouldGrantExecutionConsentForTurn,
      requiresPlanExecutionAdmission: input.requiresPlanExecutionAdmission,
      currentConfig: s.config,
    }),
  );

  input.logStoreEvent("visible_turn_appended", {
    turnId: input.turnId,
    sessionKey: input.runSessionKey,
    workspace: input.runWorkspace || null,
    reuseCurrentTurn: input.reuseCurrentTurn,
    shouldArchiveChoiceFeedback,
    selectedChoiceChars: selectedChoiceText.length,
    userBlockId: userBlock?.id ?? null,
    effectiveRunIntent: input.effectiveRunIntent,
    effectiveWorkflowMode: input.effectiveWorkflowMode,
    commandDirectiveKind: input.effectiveCommandDirective?.kind ?? null,
    commandDirectiveAction: input.effectiveCommandDirective?.action ?? null,
    initialTurnStatus: input.initialTurnStatus,
    elapsedMs: Math.round(input.nowMs() - input.sendStartedAt),
    taskFlowBlocks: input.sessionGet().taskFlow.length,
    conversationTurns: input.sessionGet().conversationTurns.length,
  });

  return {
    selectedChoiceText,
    adoptionDecision: visibleTurnPatch.adoptionDecision,
    markUserContextItemFailed: (path) =>
      markSubmitUserContextItemFailed({
        sessionSet: input.sessionSet,
        turnId: input.turnId,
        userContextItems: input.userContextItems,
        path,
      }),
  };
}
