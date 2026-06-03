import type { MainModeKey } from "./mainModes";

export type SessionModeAffinity = MainModeKey;

export interface SessionModeAffinityLike {
  sessionModeAffinity?: unknown;
  runtimeSnapshot?: {
    sessionModeAffinity?: unknown;
    selectedMainModeKey?: unknown;
    selectedNexusModeKey?: unknown;
    selectedAgentKey?: unknown;
  } | null;
}

export function normalizeSessionModeAffinity(
  value: unknown,
  fallback: SessionModeAffinity = "main_mode",
): SessionModeAffinity {
  return value === "image_studio" || value === "game_studio" || value === "main_mode"
    ? value
    : fallback;
}

export function resolveSessionModeAffinity(
  session: SessionModeAffinityLike | null | undefined,
  fallback: SessionModeAffinity = "main_mode",
): SessionModeAffinity {
  if (!session || typeof session !== "object") return fallback;
  return normalizeSessionModeAffinity(
    session.sessionModeAffinity ??
      session.runtimeSnapshot?.sessionModeAffinity ??
      session.runtimeSnapshot?.selectedMainModeKey,
    fallback,
  );
}

export function isImageStudioSessionAffinity(
  value: SessionModeAffinityLike | SessionModeAffinity | null | undefined,
): boolean {
  if (typeof value === "string") return value === "image_studio";
  return resolveSessionModeAffinity(value, "main_mode") === "image_studio";
}

export function findLatestSessionForAffinity<T extends SessionModeAffinityLike & {
  id: number;
  updatedAtMs?: number;
  updatedAt?: string | number;
  date?: string;
}>(
  sessions: T[],
  targetAffinity: SessionModeAffinity,
  options: { excludeSessionId?: number | null } = {},
): T | null {
  const excludeId = options.excludeSessionId ?? null;
  return [...(sessions || [])]
    .filter((session) => session && session.id !== excludeId && resolveSessionModeAffinity(session, "main_mode") === targetAffinity)
    .sort((a, b) => getSessionRecencyScore(b) - getSessionRecencyScore(a))[0] || null;
}

export function buildImageSessionDefaultTitle(language: "zh" | "en"): string {
  return language === "en" ? "Image Studio" : "图像工作室";
}

export function buildStandardSessionDefaultTitle(
  language: "zh" | "en",
  scopeKey: string,
  globalChatKey: string,
): string {
  return scopeKey === globalChatKey
    ? (language === "en" ? "New Chat" : "新聊天")
    : (language === "en" ? "New Conversation" : "新会话");
}

function getSessionRecencyScore(session: {
  updatedAtMs?: number;
  updatedAt?: string | number;
  date?: string;
  id: number;
}): number {
  const candidates = [
    session.updatedAtMs,
    session.updatedAt,
    session.date,
    session.id,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
  }
  return 0;
}
