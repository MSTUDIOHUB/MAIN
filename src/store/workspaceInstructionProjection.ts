import type { TaskBlock } from "../lib/taskTypes";
import {
  getIntentPolicy,
  looksLikeExplicitWorkspaceMutationRequest,
  type ResolvedRunIntent,
} from "../lib/runIntent";
import { sanitizeUserContextItemsForPersist } from "../lib/userContextItems";
import type {
  WorkspaceInstruction,
  WorkspaceInstructionReceipt,
  WorkspaceTurnQueueEntry,
} from "../lib/workspaceInstruction";
import {
  normalizeConversationDisplayTitle,
  type ConversationTurn,
} from "../lib/workflowModels";

type WorkspaceUserBlock = Extract<TaskBlock, { type: "user" }>;

const WORKSPACE_TURN_INTENT_HINTS = new Set<ResolvedRunIntent>([
  "respond",
  "discuss",
  "plan",
  "execute",
  "analyze",
  "summarize",
  "report",
  "studio_workflow",
  "image_studio",
  "goal",
]);

export type WorkspaceInstructionProjectionConflict =
  | "receipt_owner_mismatch"
  | "turn_id_collision"
  | "submission_id_collision"
  | "receipt_id_collision"
  | "user_block_id_collision"
  | "user_block_owner_collision";

export type WorkspaceInstructionProjectionResult =
  | {
      readonly disposition: "ready";
      readonly changed: boolean;
      readonly taskFlow: TaskBlock[];
      readonly conversationTurns: ConversationTurn[];
      readonly turn: ConversationTurn;
      readonly userBlock: WorkspaceUserBlock;
    }
  | {
      readonly disposition: "conflict";
      readonly reason: WorkspaceInstructionProjectionConflict;
    };

function stringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const normalizedLeft = left || [];
  const normalizedRight = right || [];
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function userContextItemIdentitiesEqual(
  left: WorkspaceUserBlock["contextItems"],
  right: WorkspaceUserBlock["contextItems"],
): boolean {
  const normalizedLeft = sanitizeUserContextItemsForPersist(left) || [];
  const normalizedRight = sanitizeUserContextItemsForPersist(right) || [];
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((item, index) => {
      const candidate = normalizedRight[index];
      return item.id === candidate.id &&
        item.kind === candidate.kind &&
        (item.path || "") === (candidate.path || "");
    });
}

function insertTurnByAdmissionTime(
  turns: readonly ConversationTurn[],
  turn: ConversationTurn,
): ConversationTurn[] {
  const insertionIndex = turns.findIndex((candidate) => candidate.createdAt >= turn.createdAt);
  if (insertionIndex < 0) return [...turns, turn];
  return [
    ...turns.slice(0, insertionIndex),
    turn,
    ...turns.slice(insertionIndex),
  ];
}

function insertUserBlockAtTurnBoundary(input: {
  taskFlow: readonly TaskBlock[];
  conversationTurns: readonly ConversationTurn[];
  turn: ConversationTurn;
  userBlock: WorkspaceUserBlock;
}): TaskBlock[] {
  const exactTurnBlockIndex = input.taskFlow.findIndex(
    (block) => block.turnId === input.turn.id,
  );
  if (exactTurnBlockIndex >= 0) {
    return [
      ...input.taskFlow.slice(0, exactTurnBlockIndex),
      input.userBlock,
      ...input.taskFlow.slice(exactTurnBlockIndex),
    ];
  }
  const laterTurnIds = new Set(
    input.conversationTurns
      .filter((candidate) => candidate.createdAt >= input.turn.createdAt)
      .map((candidate) => candidate.id),
  );
  const laterTurnBlockIndex = input.taskFlow.findIndex(
    (block) => !!block.turnId && laterTurnIds.has(block.turnId),
  );
  if (laterTurnBlockIndex < 0) return [...input.taskFlow, input.userBlock];
  return [
    ...input.taskFlow.slice(0, laterTurnBlockIndex),
    input.userBlock,
    ...input.taskFlow.slice(laterTurnBlockIndex),
  ];
}

function normalizeIntentSummaryCandidate(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 240)
    : "";
}

export function normalizeWorkspaceInstructionIntentHint(
  candidate: unknown,
): ResolvedRunIntent | null {
  return typeof candidate === "string" &&
    WORKSPACE_TURN_INTENT_HINTS.has(candidate as ResolvedRunIntent)
      ? candidate as ResolvedRunIntent
      : null;
}

export function resolveWorkspaceInstructionIntentHint(
  instruction: WorkspaceInstruction,
): ResolvedRunIntent | null {
  return normalizeWorkspaceInstructionIntentHint(
    instruction.payload.dispatchHints?.resolvedIntent,
  );
}

/**
 * Builds the visible, non-authoritative Turn projection for an admitted
 * instruction. Runtime admission still revalidates every capability carried
 * in dispatchHints; this projection only keeps the queued UI semantically
 * truthful before dispatch starts.
 */
export function buildWorkspaceInstructionConversationTurn(input: {
  instruction: WorkspaceInstruction;
  receipt: WorkspaceInstructionReceipt;
  language: "zh" | "en";
  blockIds?: number[];
}): ConversationTurn {
  const hintedIntent = resolveWorkspaceInstructionIntentHint(input.instruction);
  // This projection is presentation-only: it grants no capability and the
  // dispatcher still owns authoritative intent resolution. An ordinary
  // workspace repair must nevertheless look like an Execute Turn immediately
  // after durable admission instead of briefly masquerading as chat.
  const projectedIntent = hintedIntent ||
    (looksLikeExplicitWorkspaceMutationRequest(input.instruction.payload.text)
      ? "execute"
      : "respond");
  const hintedTitle = input.instruction.payload.dispatchHints?.turnTitle;
  const hintedIntentSummary = normalizeIntentSummaryCandidate(
    input.instruction.payload.dispatchHints?.intentSummary,
  );
  const fallbackTitle = input.language === "en"
    ? "Workspace instruction"
    : "工作区指令";

  return {
    id: input.receipt.turnId,
    clientSubmissionId: input.instruction.clientSubmissionId,
    workspaceInstructionReceiptId: input.receipt.receiptId,
    workspaceInstructionSource: input.instruction.source,
    userPrompt: input.instruction.payload.text,
    title: normalizeConversationDisplayTitle(
      typeof hintedTitle === "string" && hintedTitle.trim()
        ? hintedTitle
        : input.instruction.payload.text,
      input.language === "en" ? 48 : 40,
      fallbackTitle,
    ),
    intentSummary: hintedIntentSummary || (
      input.language === "en"
        ? "Accepted as a durable workspace Turn; routing is pending."
        : "已接纳为持久化工作区回合，等待路由执行。"
    ),
    mode: getIntentPolicy(projectedIntent).workflowMode,
    intent: projectedIntent,
    displayIntent: projectedIntent,
    status: "planning",
    summary: "",
    blockIds: input.blockIds || [input.receipt.userBlockId],
    processCollapsed: false,
    collapsed: false,
    createdAt: input.receipt.acceptedAt,
  };
}

function hasSameTurnProjectionMetadata(
  turn: ConversationTurn,
  projected: ConversationTurn,
): boolean {
  return turn.title === projected.title &&
    turn.intentSummary === projected.intentSummary &&
    turn.mode === projected.mode &&
    turn.intent === projected.intent &&
    turn.displayIntent === projected.displayIntent;
}

/**
 * Rebuilds the exact visible projection for a durable queue head when the
 * transcript page containing it is not loaded. IDs are never substituted: a
 * conflicting Turn or block is rejected so the dispatcher can close the head
 * with a visible error instead of adopting unrelated state.
 */
export function reconcileWorkspaceInstructionProjection(input: {
  entry: WorkspaceTurnQueueEntry;
  taskFlow: readonly TaskBlock[];
  conversationTurns: readonly ConversationTurn[];
  userContextItems?: WorkspaceUserBlock["contextItems"];
  language: "zh" | "en";
}): WorkspaceInstructionProjectionResult {
  const { instruction, receipt } = input.entry;
  if (
    instruction.clientSubmissionId !== receipt.clientSubmissionId ||
    instruction.sessionKey !== receipt.sessionKey ||
    instruction.sessionEpoch !== receipt.sessionEpoch ||
    !Number.isSafeInteger(receipt.userBlockId) ||
    receipt.userBlockId <= 0
  ) {
    return { disposition: "conflict", reason: "receipt_owner_mismatch" };
  }

  const exactTurnCandidates = input.conversationTurns.filter(
    (turn) => turn.id === receipt.turnId,
  );
  const sameSubmissionCandidates = input.conversationTurns.filter(
    (turn) => turn.clientSubmissionId === instruction.clientSubmissionId,
  );
  const sameReceiptCandidates = input.conversationTurns.filter(
    (turn) => turn.workspaceInstructionReceiptId === receipt.receiptId,
  );
  const exactTurn = exactTurnCandidates.length === 1 ? exactTurnCandidates[0] : null;
  if (
    exactTurnCandidates.length > 1 ||
    sameSubmissionCandidates.length > 1 ||
    sameReceiptCandidates.length > 1
  ) {
    return { disposition: "conflict", reason: "turn_id_collision" };
  }
  const sameSubmission = sameSubmissionCandidates[0] || null;
  const sameReceipt = sameReceiptCandidates[0] || null;
  if (sameSubmission && sameSubmission.id !== receipt.turnId) {
    return { disposition: "conflict", reason: "submission_id_collision" };
  }
  if (sameReceipt && sameReceipt.id !== receipt.turnId) {
    return { disposition: "conflict", reason: "receipt_id_collision" };
  }
  if (exactTurn && (
    exactTurn.clientSubmissionId !== instruction.clientSubmissionId ||
    exactTurn.workspaceInstructionReceiptId !== receipt.receiptId ||
    exactTurn.workspaceInstructionSource !== instruction.source ||
    exactTurn.userPrompt !== instruction.payload.text ||
    exactTurn.createdAt !== receipt.acceptedAt
  )) {
    return { disposition: "conflict", reason: "turn_id_collision" };
  }

  const blocksWithReceiptId = input.taskFlow.filter(
    (block) => block.id === receipt.userBlockId,
  );
  if (blocksWithReceiptId.length > 1) {
    return { disposition: "conflict", reason: "user_block_id_collision" };
  }
  const exactBlock = blocksWithReceiptId[0];
  if (exactBlock && (
    exactBlock.type !== "user" ||
    exactBlock.turnId !== receipt.turnId ||
    exactBlock.content !== instruction.payload.text ||
    !stringArraysEqual(exactBlock.images, instruction.payload.images) ||
    !userContextItemIdentitiesEqual(exactBlock.contextItems, input.userContextItems)
  )) {
    return { disposition: "conflict", reason: "user_block_id_collision" };
  }
  const differentlyIdentifiedUserBlock = input.taskFlow.find(
    (block) => block.type === "user" &&
      block.turnId === receipt.turnId &&
      block.id !== receipt.userBlockId,
  );
  if (differentlyIdentifiedUserBlock) {
    return { disposition: "conflict", reason: "user_block_owner_collision" };
  }

  const userBlock: WorkspaceUserBlock = exactBlock && exactBlock.type === "user"
    ? exactBlock
    : {
        id: receipt.userBlockId,
        turnId: receipt.turnId,
        type: "user",
        content: instruction.payload.text,
        ...(instruction.payload.images && instruction.payload.images.length > 0
          ? { images: [...instruction.payload.images] }
          : {}),
        ...(input.userContextItems && input.userContextItems.length > 0
          ? { contextItems: [...input.userContextItems] }
          : {}),
      };

  const projectedTurn = buildWorkspaceInstructionConversationTurn({
    instruction,
    receipt,
    language: input.language,
  });
  const exactTurnBlockIds = exactTurn?.blockIds.includes(receipt.userBlockId)
    ? exactTurn.blockIds
    : exactTurn
      ? [receipt.userBlockId, ...exactTurn.blockIds]
      : projectedTurn.blockIds;
  const mayRefreshProvisionalMetadata = !!exactTurn &&
    exactTurn.status === "planning" &&
    !exactTurn.runtimeOutcome &&
    !exactTurn.summary;
  const exactMetadataMatches = !!exactTurn &&
    hasSameTurnProjectionMetadata(exactTurn, projectedTurn);
  const exactBlocksMatch = !!exactTurn && exactTurnBlockIds === exactTurn.blockIds;
  const turn: ConversationTurn = !exactTurn
    ? projectedTurn
    : exactBlocksMatch && (!mayRefreshProvisionalMetadata || exactMetadataMatches)
      ? exactTurn
      : {
          ...exactTurn,
          ...(mayRefreshProvisionalMetadata
            ? {
                title: projectedTurn.title,
                intentSummary: projectedTurn.intentSummary,
                mode: projectedTurn.mode,
                intent: projectedTurn.intent,
                displayIntent: projectedTurn.displayIntent,
              }
            : {}),
          blockIds: exactTurnBlockIds,
        };

  const conversationTurns = exactTurn
    ? turn === exactTurn
      ? input.conversationTurns as ConversationTurn[]
      : input.conversationTurns.map((candidate) =>
          candidate.id === exactTurn.id ? turn : candidate
        )
    : insertTurnByAdmissionTime(input.conversationTurns, turn);
  const taskFlow = exactBlock
    ? input.taskFlow as TaskBlock[]
    : insertUserBlockAtTurnBoundary({
        taskFlow: input.taskFlow,
        conversationTurns: input.conversationTurns,
        turn,
        userBlock,
      });

  return {
    disposition: "ready",
    changed: !exactTurn || !exactBlock || turn !== exactTurn,
    taskFlow,
    conversationTurns,
    turn,
    userBlock,
  };
}
