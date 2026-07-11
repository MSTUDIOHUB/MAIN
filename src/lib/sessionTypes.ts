import type { AttachedFile } from "./attachments";
import type { ResolvedRunIntent } from "./runIntent";

export const GLOBAL_CHAT_KEY = "__MAIN_GLOBAL_CHAT__";

export function resolveSessionWorkspaceKey(workspace: string | null | undefined): string {
  const normalizedWorkspace = String(workspace || "").trim();
  return normalizedWorkspace || GLOBAL_CHAT_KEY;
}

export function resolveGlobalChatSessionKey(sessionId: number | null | undefined): string | null {
  return sessionId ? `${GLOBAL_CHAT_KEY}:${sessionId}` : null;
}

export function resolveSessionRuntimeKey(
  workspaceOrScope: string | null | undefined,
  sessionId: number | null | undefined,
): string | null {
  if (!sessionId) return null;
  return `${resolveSessionWorkspaceKey(workspaceOrScope)}:${sessionId}`;
}

export interface SessionModelConfig {
  provider: string;
  endpoint: string;
  model: string;
  activeProfile: "local" | "cloud";
}

export interface ProviderCompatibilityRuntimeLaneState {
  forceXmlTools: boolean;
  fallbackExpiresAt: number | null;
  nativeSuccessStreak: number;
  lastFallbackAt: number;
}

export interface QueuedUserMessage {
  id: string;
  text: string;
  images?: string[];
  contextMentions?: string[];
  attachedFiles?: AttachedFile[];
  /** Preserve the resolved workflow contract across the busy-run queue. */
  runtimeIntentOverride?: ResolvedRunIntent;
  /** Immutable Goal source captured before Plan state can change or reset. */
  goalSourceContextSnapshot?: string;
  createdAt: number;
  status: "queued";
}

export interface ActiveGuidance {
  id: string;
  text: string;
  turnId: string | null;
  createdAt: number;
  consumedAt?: number | null;
}

export interface PlanApprovalHandoff {
  planTurnId: string;
  requestedAt: number;
  executionTurnId?: string;
  prompt?: string;
  /** Identity of the exact reviewable artifact revision the user approved. */
  planRevision?: number;
  artifactHash?: string;
  artifactPaths?: string[];
  /** The planning run that produced the reviewed artifact. */
  parentRunId?: string | null;
}
