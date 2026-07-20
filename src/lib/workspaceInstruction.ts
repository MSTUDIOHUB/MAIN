/**
 * Provider-neutral, JSON-safe contract for one instruction submitted from a
 * workspace surface. Runtime capabilities carried in dispatchHints are only
 * candidates: the admission/dispatch layer must revalidate every Goal, reply,
 * Plan, permission, and continuation identity before use.
 */

export const WORKSPACE_INSTRUCTION_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_TURN_QUEUE_SCHEMA_VERSION = 1 as const;

export type WorkspaceJsonPrimitive = string | number | boolean | null;
export type WorkspaceJsonValue =
  | WorkspaceJsonPrimitive
  | readonly WorkspaceJsonValue[]
  | WorkspaceJsonObject;
export interface WorkspaceJsonObject {
  readonly [key: string]: WorkspaceJsonValue;
}

export const WORKSPACE_INSTRUCTION_SOURCES = Object.freeze([
  "composer",
  "guide",
  "custom_reply",
  "plan_adjustment",
  "natural_language_approval",
  "image_studio",
  "image_generation",
  "slash_command",
  "im_adapter",
  "replay",
] as const);

export type WorkspaceInstructionSource =
  (typeof WORKSPACE_INSTRUCTION_SOURCES)[number];

export interface WorkspaceInstructionAttachment {
  readonly id: string;
  readonly path: string;
  readonly displayName: string;
  readonly kind: "text" | "document" | "tabular";
  readonly sourcePath?: string;
  readonly workspace?: string;
  readonly readable?: boolean;
}

export interface WorkspaceInstructionPayload {
  /** Exact user-visible text. Whitespace is intentionally preserved. */
  readonly text: string;
  readonly images?: readonly string[];
  readonly contextMentions?: readonly string[];
  readonly attachedFiles?: readonly WorkspaceInstructionAttachment[];
  /**
   * JSON-only dispatch candidates such as resolved intent, Goal authority,
   * reply identity, or Plan lease. Persistence does not make them authority.
   */
  readonly dispatchHints?: WorkspaceJsonObject;
}

export interface WorkspaceInstruction {
  readonly schemaVersion: typeof WORKSPACE_INSTRUCTION_SCHEMA_VERSION;
  readonly kind: "workspace_instruction";
  /** Stable client-generated id used to make admission retries idempotent. */
  readonly clientSubmissionId: string;
  readonly sessionKey: string;
  /** Opaque Session generation. Reusing a Session key must mint a new epoch. */
  readonly sessionEpoch: string;
  readonly source: WorkspaceInstructionSource;
  readonly submittedAt: number;
  readonly payload: WorkspaceInstructionPayload;
}

/** Durable proof that one client submission was admitted as one Turn. */
export interface WorkspaceInstructionReceipt {
  readonly schemaVersion: typeof WORKSPACE_INSTRUCTION_SCHEMA_VERSION;
  readonly kind: "workspace_turn_receipt";
  readonly receiptId: string;
  readonly clientSubmissionId: string;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly turnId: string;
  /** Exact visible user block adopted by the admitted Turn/Run adapter. */
  readonly userBlockId: number;
  readonly acceptedAt: number;
}

/** Durable idempotency tombstone independent from paged conversation history. */
export interface WorkspaceInstructionLedgerEntry {
  readonly clientSubmissionId: string;
  readonly payloadIdentity: string;
  readonly receipt: WorkspaceInstructionReceipt;
}

export type WorkspaceTurnQueueStatus =
  | "persisting"
  | "queued"
  | "dispatching";

export interface WorkspaceTurnQueueClaim {
  readonly claimId: string;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly claimedAt: number;
}

export interface WorkspaceTurnQueueEntry {
  readonly instruction: WorkspaceInstruction;
  readonly receipt: WorkspaceInstructionReceipt;
  readonly status: WorkspaceTurnQueueStatus;
  readonly claim: WorkspaceTurnQueueClaim | null;
  readonly enqueuedAt: number;
  readonly persistedAt: number | null;
  readonly updatedAt: number;
}

/** One immutable FIFO belongs to one exact Session generation. */
export interface WorkspaceTurnQueueState {
  readonly schemaVersion: typeof WORKSPACE_TURN_QUEUE_SCHEMA_VERSION;
  /** Monotonic compare-and-swap revision. */
  readonly version: number;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly entries: readonly WorkspaceTurnQueueEntry[];
  readonly updatedAt: number;
}

/** Exact terminal fact used to discard work that already has a conclusion. */
export interface WorkspaceTurnTerminalOwner {
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly turnId: string;
}
