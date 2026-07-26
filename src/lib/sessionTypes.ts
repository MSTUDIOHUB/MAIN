import type { AttachedFile } from "./attachments";
import type { ResolvedRunIntent } from "./runIntent";
import type {
  GoalContinuationAuthorization,
  GoalCreationAuthorization,
} from "./submit/turnSubmission";
import type { CanonicalRunIdentity } from "./turnRuntimeContract";

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
  /** Until this instant, preserve native tools but omit the rejected `required` value. */
  requiredToolChoiceFallbackExpiresAt?: number | null;
}

export interface QueuedUserMessage {
  id: string;
  /** Session owner captured when the queue entry is created. */
  sessionKey?: string;
  text: string;
  images?: string[];
  contextMentions?: string[];
  attachedFiles?: AttachedFile[];
  /** Preserve the resolved workflow contract across the busy-run queue. */
  runtimeIntentOverride?: ResolvedRunIntent;
  /** Immutable Goal source captured before Plan state can change or reset. */
  goalSourceContextSnapshot?: string;
  /** Explicit Goal authority bound to this queued message id. */
  goalCreationAuthorization?: GoalCreationAuthorization;
  /** Exact existing-Goal continuation contract bound to this queue id. */
  goalContinuationAuthorization?: GoalContinuationAuthorization;
  /** User guidance captured with the authorized continuation; never rebuilt from queue text. */
  goalContinuationGuidance?: string;
  createdAt: number;
  status: "queued";
}

export interface ActiveGuidance {
  schemaVersion: 1;
  id: string;
  text: string;
  /** Guidance is a one-shot input owned by one exact Run attempt. */
  target: CanonicalRunIdentity;
  createdAt: number;
  consumedAt?: number | null;
}

export interface PlanApprovalHandoff {
  planTurnId: string;
  requestedAt: number;
  /** Exact immutable approval capability that owns this handoff. */
  approvalLeaseId: string;
  /** One-shot execution attempt minted from the approval capability. */
  executionLeaseId: string;
  /** Session generation captured when the review decision was accepted. */
  sessionEpoch: string;
  /** Exact review request resolved by the user. */
  reviewRequestId: string;
  executionTurnId: string;
  /** Preallocated child owner so approval progress is never unowned. */
  executionRunId: string;
  executionAttempt: number;
  executionInstructionHash: string;
  prompt: string;
  /** Identity of the exact reviewable artifact revision the user approved. */
  planRevision: number;
  artifactHash: string;
  artifactPaths: string[];
  /** The planning run that produced the reviewed artifact. */
  parentRunId: string | null;
}
