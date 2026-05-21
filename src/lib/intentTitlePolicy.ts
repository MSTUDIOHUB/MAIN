export interface SessionTitleSeedState {
  title?: string | null;
  messages?: unknown[] | null;
  titleSource?: SessionTitleSource | string | null;
}

export type SessionTitleSource = "default" | "local_seed" | "semantic" | "manual";

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

export interface IntentTitleCandidate {
  title?: string;
  summary?: string;
}

export interface IntentTitleParseResult {
  metadata: IntentTitleCandidate | null;
  source: "json" | "loose_key_value" | "first_line" | "reasoning_json" | "reasoning_loose_key_value" | "reasoning_first_line" | "none";
  failureReason?: string;
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
  const titleSource = String(session.titleSource || "").trim();
  if (!title || isDefaultSeedSessionTitle(title)) return true;
  if (titleSource === "default") return true;
  if (titleSource === "local_seed" && (session.messages?.length ?? 0) === 0) return true;
  if (titleSource === "semantic" || titleSource === "manual") return false;
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
  const titleSource = String(session.titleSource || "").trim();
  if (!title) return true;
  if (isDefaultSeedSessionTitle(title)) return true;
  if (titleSource === "default" || titleSource === "local_seed") return true;
  if (titleSource === "semantic" || titleSource === "manual") return false;
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

function stripJsonFence(text: string): string {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1]?.trim() || trimmed;
}

function extractJsonObject(text: string): string | null {
  const cleaned = stripJsonFence(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return null;
}

function cleanTitleModelText(text: string): string {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi, " ")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning|think)(?:\s[^>]*)?>/gi, " ")
    .replace(/```[\s\S]*?```/g, (match) => stripJsonFence(match))
    .trim();
}

function parseTitleJson(text: string): IntentTitleCandidate | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    return title || summary ? { title, summary } : null;
  } catch {
    return null;
  }
}

function parseLooseTitleText(text: string): { metadata: IntentTitleCandidate | null; source: "loose_key_value" | "first_line" | "none" } {
  const normalized = cleanTitleModelText(text);
  if (!normalized) return { metadata: null, source: "none" };

  const titleMatch = normalized.match(/(?:^|[\n,，])\s*(?:title|标题)\s*[:：=]\s*["“”']?([^\n,"“”'}]+)["“”']?/i);
  const summaryMatch = normalized.match(/(?:^|[\n,，])\s*(?:summary|摘要|总结)\s*[:：=]\s*["“”']?([^\n"“”'}]+)["“”']?/i);
  const title = titleMatch?.[1]?.trim();
  const summary = summaryMatch?.[1]?.trim();
  if (title || summary) return { metadata: { title, summary }, source: "loose_key_value" };

  const firstLine = normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#>\s]+/, "").trim())
    .filter((line) => !/^(?:title|标题|summary|摘要|json)\b/i.test(line))
    .find(Boolean);
  return firstLine ? { metadata: { title: firstLine }, source: "first_line" } : { metadata: null, source: "none" };
}

export function parseIntentTitleCandidate(input: {
  content?: string | null;
  reasoning?: string | null;
}): IntentTitleParseResult {
  const content = String(input.content || "").trim();
  const reasoning = String(input.reasoning || "").trim();

  const json = parseTitleJson(content);
  if (json) return { metadata: json, source: "json" };

  const loose = parseLooseTitleText(content);
  if (loose.metadata) return { metadata: loose.metadata, source: loose.source };

  const reasoningJson = parseTitleJson(reasoning);
  if (reasoningJson) return { metadata: reasoningJson, source: "reasoning_json" };

  const reasoningLoose = parseLooseTitleText(reasoning);
  if (reasoningLoose.metadata) {
    return {
      metadata: reasoningLoose.metadata,
      source: reasoningLoose.source === "loose_key_value" ? "reasoning_loose_key_value" : "reasoning_first_line",
    };
  }

  return {
    metadata: null,
    source: "none",
    failureReason: !content && !reasoning ? "empty_model_output" : "unparseable_title_output",
  };
}
