/** Tolerant read boundary for older snapshots. MAIN has one normal surface. */
export const MAIN_MODE_KEYS = ["main_mode"] as const;
export type MainModeKey = "main_mode";
export type SessionModeAffinity = MainModeKey;
export interface SessionModeAffinityLike {
  sessionModeAffinity?: unknown;
  runtimeSnapshot?: { sessionModeAffinity?: unknown; selectedMainModeKey?: unknown; selectedNexusModeKey?: unknown; selectedAgentKey?: unknown } | null;
}
export function mapLegacyNexusModeToMainMode(_value: unknown): MainModeKey { return "main_mode"; }
export function normalizeSessionModeAffinity(_value: unknown, _fallback: SessionModeAffinity = "main_mode"): SessionModeAffinity { return "main_mode"; }
export function resolveSessionModeAffinity(_session: SessionModeAffinityLike | null | undefined, _fallback: SessionModeAffinity = "main_mode"): SessionModeAffinity { return "main_mode"; }
export function buildStandardSessionDefaultTitle(language: "zh" | "en", scopeKey: string, globalChatKey: string): string {
  return scopeKey === globalChatKey ? (language === "en" ? "New Chat" : "新聊天") : (language === "en" ? "New Conversation" : "新会话");
}
