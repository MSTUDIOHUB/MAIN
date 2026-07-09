import {
  canUpdateSeedSessionTitle,
  isSemanticTurnMetadataCallbackCurrent,
} from "../lib/intentTitlePolicy";
import {
  isGenericConversationTitle,
  looksLikeReasoningLeakTitle,
} from "../lib/workflowModels";
import type { SubmitSemanticMetadataDecision } from "../lib/submit/turnSubmission";

export interface SubmitSemanticTurnMetadata {
  title: string;
  summary: string;
}

export interface SubmitTitleEffectsSession {
  id?: number | null;
  title?: string | null;
  titleSource?: string | null;
  messages?: unknown[] | null;
}

export interface SubmitTitleEffectsTurn {
  id?: string | null;
  userPrompt?: string | null;
}

export interface ApplySubmitSeedSessionTitleInput<TTaskBlock> {
  isHidden: boolean;
  shouldSeedSessionTitleForTurn: boolean;
  ensuredSessionId?: number | null;
  sessionScopeKey: string;
  turnTitle: string;
  titleIntentSignature: string;
  taskFlow: TTaskBlock[];
  sessionRecordingEnabled: boolean;
  sanitizeTaskBlocksForPersist: (blocks: TTaskBlock[]) => TTaskBlock[];
  updateSession: (sessionScopeKey: string, sessionId: number, patch: Record<string, unknown>) => void;
}

export function applySubmitSeedSessionTitle<TTaskBlock>(
  input: ApplySubmitSeedSessionTitleInput<TTaskBlock>,
): boolean {
  if (input.isHidden || !input.shouldSeedSessionTitleForTurn || !input.ensuredSessionId) {
    return false;
  }

  input.updateSession(input.sessionScopeKey, input.ensuredSessionId, {
    title: input.turnTitle,
    titleSource: "local_seed",
    titleIntentSignature: input.titleIntentSignature,
    active: true,
    messages: input.sanitizeTaskBlocksForPersist(input.taskFlow),
    storageStatus: input.sessionRecordingEnabled ? "ok" : "temporary",
    recordingDisabled: !input.sessionRecordingEnabled,
  });
  return true;
}

export interface SubmitSemanticMetadataLatestSnapshot<
  TTurn extends SubmitTitleEffectsTurn,
  TSession extends SubmitTitleEffectsSession,
> {
  conversationTurns: TTurn[];
  sessionsByWorkspace: Record<string, TSession[]>;
}

export interface StartSubmitSemanticMetadataEffectInput<
  TConfig extends object,
  TTurn extends SubmitTitleEffectsTurn,
  TSession extends SubmitTitleEffectsSession,
> {
  decision: SubmitSemanticMetadataDecision<TConfig> | null;
  requestSemanticTurnMetadata: (
    request: SubmitSemanticMetadataDecision<TConfig>["request"],
  ) => Promise<SubmitSemanticTurnMetadata | null>;
  getLatestSnapshot: () => SubmitSemanticMetadataLatestSnapshot<TTurn, TSession>;
  updateConversationTurn: (
    turnId: string,
    patch: { title: string; intentSummary: string },
  ) => void;
  updateSession: (sessionScopeKey: string, sessionId: number, patch: Record<string, unknown>) => void;
  logStoreEvent: (event: string, data: Record<string, unknown>) => void;
  runSessionKey: string;
  runWorkspace: string | null | undefined;
  nowMs?: () => number;
}

export function startSubmitSemanticMetadataEffect<
  TConfig extends object,
  TTurn extends SubmitTitleEffectsTurn,
  TSession extends SubmitTitleEffectsSession,
>(
  input: StartSubmitSemanticMetadataEffectInput<TConfig, TTurn, TSession>,
): Promise<void> | null {
  const decision = input.decision;
  if (!decision) return null;

  const started = input.requestSemanticTurnMetadata(decision.request).then((metadata) => {
    if (!metadata) return;

    const latestState = input.getLatestSnapshot();
    const targetTurn = latestState.conversationTurns.find((turn) => turn.id === decision.expectedTurnId);
    const latestSession = decision.expectedSessionId != null
      ? (latestState.sessionsByWorkspace[decision.sessionScopeKey] || [])
        .find((session) => session.id === decision.expectedSessionId) || null
      : null;

    if (!isSemanticTurnMetadataCallbackCurrent({
      expectedTurnId: decision.expectedTurnId,
      expectedUserPrompt: decision.expectedTurnPrompt,
      expectedSessionId: decision.expectedSessionId,
      turn: targetTurn,
      session: latestSession,
    })) return;

    if (
      looksLikeReasoningLeakTitle(metadata.title) ||
      looksLikeReasoningLeakTitle(metadata.summary) ||
      isGenericConversationTitle(metadata.title)
    ) {
      return;
    }

    input.updateConversationTurn(decision.expectedTurnId, {
      title: metadata.title,
      intentSummary: metadata.summary,
    });

    if (decision.expectedSessionId == null) return;

    if (!canUpdateSeedSessionTitle({
      session: latestSession,
      seededTitle: decision.seededSessionTitleCandidate,
    })) {
      input.logStoreEvent("semantic_title_session_update_skipped", {
        turnId: decision.expectedTurnId,
        sessionKey: input.runSessionKey,
        workspace: input.runWorkspace || null,
        reason: "session_title_not_auto_seed",
        titleSource: latestSession?.titleSource || null,
      });
      return;
    }

    input.updateSession(decision.sessionScopeKey, decision.expectedSessionId, {
      title: metadata.title,
      titleSource: "semantic",
      semanticTitleUpdatedAt: (input.nowMs || Date.now)(),
      titleIntentSignature: decision.titleIntentSignature,
      active: true,
    });
  }).catch(() => {
    // Background title sync must never block or fail the main submission path.
  });

  return started;
}
