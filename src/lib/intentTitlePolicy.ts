export interface SessionTitleSeedState {
  title?: string | null;
  messages?: unknown[] | null;
}

export interface SemanticTurnMetadataRequestGateInput {
  input: string;
  hidden?: boolean;
  reuseCurrentTurn?: boolean;
  turnTitle?: string | null;
  mainModeKey?: string | null;
}

export interface SemanticTurnMetadataCallbackTurn {
  id?: string | null;
  userPrompt?: string | null;
}

export interface SemanticTurnMetadataCallbackSession {
  id?: number | null;
}

export interface SemanticTurnMetadataCallbackGuardInput {
  expectedTurnId: string;
  expectedUserPrompt: string;
  expectedSessionId?: number | null;
  turn: SemanticTurnMetadataCallbackTurn | null | undefined;
  session: SemanticTurnMetadataCallbackSession | null | undefined;
}

const DEFAULT_SEEDED_SESSION_TITLES = new Set([
  "New Conversation",
  "新会话",
  "New Chat",
  "新聊天",
]);

export function isDefaultSeedSessionTitle(title: string): boolean {
  const normalized = String(title || "").trim();
  return normalized.length > 0 && DEFAULT_SEEDED_SESSION_TITLES.has(normalized);
}

export function shouldSeedSessionTitle(session: SessionTitleSeedState | null | undefined): boolean {
  if (!session) return false;
  const title = String(session.title || "").trim();
  if (!title || isDefaultSeedSessionTitle(title)) return true;
  return (session.messages?.length ?? 0) === 0;
}

export function shouldRequestSemanticTurnMetadataForTurn(
  params: SemanticTurnMetadataRequestGateInput,
): boolean {
  const normalizedInput = String(params.input || "").trim();
  if (!normalizedInput) return false;
  if (params.hidden) return false;
  if (params.reuseCurrentTurn) return false;
  if (String(params.turnTitle || "").trim()) return false;
  return true;
}

export function canUpdateSeedSessionTitle(params: {
  session: SessionTitleSeedState | null | undefined;
  seededTitle: string;
}): boolean {
  const session = params.session;
  if (!session) return false;
  const title = String(session.title || "").trim();
  if (!title) return true;
  if (isDefaultSeedSessionTitle(title)) return true;
  return !!params.seededTitle && title === params.seededTitle;
}

export function isSemanticTurnMetadataCallbackCurrent(
  params: SemanticTurnMetadataCallbackGuardInput,
): boolean {
  if (!params.turn) return false;
  if (String(params.turn.id || "") !== String(params.expectedTurnId || "")) return false;
  if (
    String(params.turn.userPrompt || "").trim() !==
    String(params.expectedUserPrompt || "").trim()
  ) return false;
  if (params.expectedSessionId != null) {
    return !!params.session && params.session.id === params.expectedSessionId;
  }
  return true;
}
