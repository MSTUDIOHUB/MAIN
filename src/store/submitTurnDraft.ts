import type { AttachedFile } from "../lib/attachments";
import { normalizeAttachedFile } from "../lib/attachments";
import {
  resolveSubmitExistingTurnAdoptionDecision,
  resolveSubmitTurnTitleDecision,
  type SubmitExistingTurnAdoptionDecision,
  type SubmitTurnTitleDecision,
} from "../lib/submit/turnSubmission";
import type { TaskBlock } from "../lib/taskTypes";
import {
  normalizeTurnInputContextSignals,
  resolveEffectiveSubagentDelegationPreference,
  type SubagentDelegationPreference,
  type TurnInputContextSignals,
} from "../lib/turnIntake";
import { buildUserContextItems } from "../lib/userContextItems";
import type { ResolvedRunIntent } from "../lib/runIntent";
import type { ConversationTurn } from "../lib/workflowModels";
import type { SessionTitleSeedState } from "../lib/intentTitlePolicy";

export interface SubmitTurnDraftSessionState {
  _nextTaskId: () => number;
  sessionsByWorkspace: Record<string, Array<SessionTitleSeedState & { id: number }>>;
}

export interface PrepareSubmitTurnDraftInput {
  sessionGet: () => SubmitTurnDraftSessionState;
  conversationTurns: ConversationTurn[];
  text: string;
  images?: string[];
  mentionSnapshot: string[];
  attachedFilesSnapshot: Array<AttachedFile | string>;
  runWorkspace?: string | null;
  preferredLanguage: "zh" | "en";
  preferSubagents?: boolean;
  subagentPreference?: SubagentDelegationPreference;
  effectiveRunIntent: ResolvedRunIntent;
  isMainDebugShortcut: boolean;
  optionTurnTitle?: string | null;
  reuseCurrentTurn: boolean;
  adoptExistingTurn?: boolean;
  admittedUserBlockId?: number;
  reusableTurnId?: string | null;
  turnIdOverride?: string;
  uiParentTurnId?: string | null;
  ensuredSessionId?: number | null;
  sessionScopeKey: string;
  createTurnId?: () => string;
}

export interface SubmitTurnDraft {
  nextTaskId: () => number;
  turnId: string;
  uiDisplayTurnId: string;
  currentImages: string[];
  turnInputContextSignals: TurnInputContextSignals;
  userContextItems: Extract<TaskBlock, { type: "user" }>["contextItems"];
  existingTurn: ConversationTurn | null;
  activeSession: SessionTitleSeedState | null;
  titleDecision: SubmitTurnTitleDecision;
  adoptionDecision: SubmitExistingTurnAdoptionDecision;
}

export function prepareSubmitTurnDraft(input: PrepareSubmitTurnDraftInput): SubmitTurnDraft {
  const sessionState = input.sessionGet();
  const nextTaskId = sessionState._nextTaskId;
  const requestedTurnId = String(input.turnIdOverride || "").trim();
  const adoptionDecision = resolveSubmitExistingTurnAdoptionDecision({
    adoptExistingTurn: input.adoptExistingTurn,
    reuseCurrentTurn: input.reuseCurrentTurn,
    turnIdOverride: requestedTurnId,
    admittedUserBlockId: input.admittedUserBlockId,
    conversationTurns: input.conversationTurns,
  });
  const availableNewTurnId = requestedTurnId &&
    !input.conversationTurns.some((turn) => turn.id === requestedTurnId)
    ? requestedTurnId
    : null;
  const turnId = adoptionDecision.kind === "adopted"
    ? adoptionDecision.turnId
    : adoptionDecision.kind === "rejected"
      ? requestedTurnId
      : input.reuseCurrentTurn
        ? input.reusableTurnId!
        : availableNewTurnId || input.createTurnId?.() || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const uiDisplayTurnId = input.uiParentTurnId || turnId;
  const currentImages = input.images || [];
  const turnInputContextSignals = normalizeTurnInputContextSignals({
    imageParts: currentImages.length,
    mentionedFilePaths: input.mentionSnapshot,
    attachedFilePaths: input.attachedFilesSnapshot.map((file) => {
      const attachment = normalizeAttachedFile(file);
      return attachment.sourcePath || attachment.path;
    }),
    subagentPreference: resolveEffectiveSubagentDelegationPreference({
      rawUserInput: input.text,
      defaultPreference: input.subagentPreference ??
        (input.preferSubagents ? "preferred" : "unspecified"),
    }),
  });
  const userContextItems = buildUserContextItems({
    contextMentions: input.mentionSnapshot,
    attachedFiles: input.attachedFilesSnapshot,
    images: currentImages,
    workspace: input.runWorkspace,
    language: input.preferredLanguage,
  });
  const existingTurn = input.reuseCurrentTurn || adoptionDecision.kind === "adopted"
    ? input.conversationTurns.find((turn) => turn.id === turnId) || null
    : null;
  const activeSession = input.ensuredSessionId
    ? (sessionState.sessionsByWorkspace[input.sessionScopeKey] || []).find((session) => session.id === input.ensuredSessionId) || null
    : null;
  const titleDecision = resolveSubmitTurnTitleDecision({
    text: input.text,
    effectiveRunIntent: input.effectiveRunIntent,
    preferredLanguage: input.preferredLanguage,
    isMainDebugShortcut: input.isMainDebugShortcut,
    contextSignals: turnInputContextSignals,
    // Durable admission creates a provisional title before dispatch. An exact
    // persisted Composer/MDEBUG title must replace that placeholder when this
    // existing Turn is adopted; ordinary turn reuse still keeps its title.
    existingTurnTitle:
      input.adoptExistingTurn && input.optionTurnTitle
        ? null
        : existingTurn?.title,
    optionTurnTitle: input.optionTurnTitle,
    activeSession,
  });

  return {
    nextTaskId,
    turnId,
    uiDisplayTurnId,
    currentImages,
    turnInputContextSignals,
    userContextItems,
    existingTurn,
    activeSession,
    titleDecision,
    adoptionDecision,
  };
}
