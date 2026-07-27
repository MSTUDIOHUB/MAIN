import type { QueuedUserMessage } from "../lib/sessionTypes";
import {
  WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
  type WorkspaceInstruction,
  type WorkspaceInstructionLedgerEntry,
  type WorkspaceInstructionReceipt,
  type WorkspaceJsonObject,
  type WorkspaceTurnQueueState,
} from "../lib/workspaceInstruction";
import { buildWorkspaceInstructionPayloadIdentity } from "./workspaceInstructionAdmission";
import { reduceWorkspaceTurnQueue } from "./workspaceTurnQueue";

export type WorkspaceLegacyQueueMigrationResult =
  | {
      disposition: "migrated";
      queue: WorkspaceTurnQueueState;
      instruction: WorkspaceInstruction;
      receipt: WorkspaceInstructionReceipt;
      ledgerEntry: WorkspaceInstructionLedgerEntry;
    }
  | { disposition: "error"; reason: string };

/**
 * One-way compatibility adapter. Workspace legacy queue data becomes the same
 * immutable receipt/FIFO contract as a new Composer admission; it is never
 * replayed through the old latest-wins slot.
 */
export function migrateLegacyQueuedMessageToWorkspaceTurn(input: {
  legacy: QueuedUserMessage;
  queue: WorkspaceTurnQueueState;
  sessionKey: string;
  sessionEpoch: string;
  clientSubmissionId: string;
  receiptId: string;
  turnId: string;
  userBlockId: number;
  at: number;
}): WorkspaceLegacyQueueMigrationResult {
  if (
    input.queue.sessionKey !== input.sessionKey ||
    input.queue.sessionEpoch !== input.sessionEpoch ||
    (input.legacy.sessionKey && input.legacy.sessionKey !== input.sessionKey)
  ) return { disposition: "error", reason: "legacy_queue_owner_mismatch" };

  let dispatchHints: WorkspaceJsonObject;
  try {
    dispatchHints = JSON.parse(JSON.stringify({
      ...(input.legacy.runtimeIntentOverride
        ? { resolvedIntent: input.legacy.runtimeIntentOverride }
        : {}),
      ...(input.legacy.goalSourceContextSnapshot
        ? { goalSourceContextSnapshot: input.legacy.goalSourceContextSnapshot }
        : {}),
      ...(input.legacy.goalCreationAuthorization
        ? { goalCreationAuthorization: input.legacy.goalCreationAuthorization }
        : {}),
      ...(input.legacy.goalContinuationAuthorization
        ? { goalContinuationAuthorization: input.legacy.goalContinuationAuthorization }
        : {}),
      ...(input.legacy.goalContinuationGuidance
        ? { goalContinuationGuidance: input.legacy.goalContinuationGuidance }
        : {}),
      legacyQueuedMessageId: input.legacy.id,
    })) as WorkspaceJsonObject;
  } catch {
    return { disposition: "error", reason: "legacy_queue_dispatch_hints_not_json" };
  }
  const instruction: WorkspaceInstruction = {
    schemaVersion: WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
    kind: "workspace_instruction",
    clientSubmissionId: input.clientSubmissionId,
    sessionKey: input.sessionKey,
    sessionEpoch: input.sessionEpoch,
    source: "replay",
    submittedAt: input.legacy.createdAt,
    payload: {
      text: input.legacy.text,
      ...(input.legacy.images?.length ? { images: [...input.legacy.images] } : {}),
      ...(input.legacy.contextMentions?.length
        ? { contextMentions: [...input.legacy.contextMentions] }
        : {}),
      ...(input.legacy.attachedFiles?.length
        ? { attachedFiles: input.legacy.attachedFiles.map((file) => ({ ...file })) }
        : {}),
      ...(Object.keys(dispatchHints).length ? { dispatchHints } : {}),
    },
  };
  const receipt: WorkspaceInstructionReceipt = {
    schemaVersion: WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
    kind: "workspace_turn_receipt",
    receiptId: input.receiptId,
    clientSubmissionId: input.clientSubmissionId,
    sessionKey: input.sessionKey,
    sessionEpoch: input.sessionEpoch,
    turnId: input.turnId,
    userBlockId: input.userBlockId,
    acceptedAt: input.at,
  };
  const appended = reduceWorkspaceTurnQueue(input.queue, {
    type: "append",
    expectedVersion: input.queue.version,
    at: input.at,
    instruction,
    receipt,
  });
  if (appended.disposition !== "applied") {
    return { disposition: "error", reason: appended.reason || appended.disposition };
  }
  const committed = reduceWorkspaceTurnQueue(appended.state, {
    type: "commit",
    expectedVersion: appended.state.version,
    at: input.at,
    clientSubmissionId: input.clientSubmissionId,
    receiptId: input.receiptId,
    sessionKey: input.sessionKey,
    sessionEpoch: input.sessionEpoch,
  });
  if (committed.disposition !== "applied") {
    return { disposition: "error", reason: committed.reason || committed.disposition };
  }
  return {
    disposition: "migrated",
    queue: committed.state,
    instruction,
    receipt,
    ledgerEntry: {
      clientSubmissionId: input.clientSubmissionId,
      payloadIdentity: buildWorkspaceInstructionPayloadIdentity({
        text: input.legacy.text,
        images: input.legacy.images || [],
        contextMentions: input.legacy.contextMentions || [],
        attachedFiles: input.legacy.attachedFiles || [],
        source: "replay",
        dispatchHints,
      }),
      receipt,
    },
  };
}
