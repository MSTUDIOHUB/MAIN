import {
  isExactUserChoiceResolutionIdentity,
  isMatchingUserChoiceResolution,
  type ActionRequest,
  type UserChoiceResolutionIdentity,
} from "../lib/actionRequest";
import type { TaskBlock } from "../lib/taskTypes";
import type { ReplyOption } from "../lib/workflowModels";
import type { WorkspaceJsonObject } from "../lib/workspaceInstruction";

export interface WorkspaceInstructionChoiceResolutionInput {
  sessionKey: string;
  taskFlow: TaskBlock[];
  hints: WorkspaceJsonObject;
  activeActionRequest: ActionRequest | null | undefined;
}

type WorkspaceInstructionChoiceFailureReason =
  | "not_requested"
  | "missing_identity"
  | "owner_mismatch"
  | "stale_request";

export type WorkspaceInstructionConsentDecision =
  | { granted: false; reason: "not_requested" }
  | {
      granted: false;
      reason:
        | "missing_identity"
        | "owner_mismatch"
        | "stale_request"
        | "option_not_authorized";
    }
  | {
      granted: true;
      reason: "exact_pending_choice";
      identity: UserChoiceResolutionIdentity;
    };

export type WorkspaceInstructionActionDecision =
  | {
      actionDecision: null;
      reason: WorkspaceInstructionChoiceFailureReason | "option_not_action_decision";
    }
  | {
      actionDecision: "approve" | "reject";
      reason: "exact_pending_choice";
      identity: UserChoiceResolutionIdentity;
    };

/**
 * A durable FIFO head must not be adopted while another Run owns the Session.
 * The only pending-review exception is an exact, revalidated ActionDecision,
 * because that resolves the existing owner instead of starting a second Run.
 * Ordinary durable Turns remain queued until the reviewed owner concludes;
 * choosing Queue must never implicitly reject the current approval.
 * A failed cancellation fence is intentionally allowed through so the
 * dispatcher can close the admitted Turn with its fail-closed conclusion.
 */
export function shouldDeferWorkspaceInstructionDispatchForActiveOwner(input: {
  isGenerating: boolean;
  agentStatus: string;
  hasPendingActionRequest: boolean;
  hasExactPendingReviewActionDecision: boolean;
  cancellationFenceFailed: boolean;
}): boolean {
  if (input.cancellationFenceFailed) return false;
  const activeOwner = input.isGenerating ||
    input.agentStatus === "running" ||
    input.agentStatus === "pending_review" ||
    input.hasPendingActionRequest;
  if (!activeOwner) return false;
  return !(
    input.agentStatus === "pending_review" &&
    input.hasExactPendingReviewActionDecision
  );
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value.map((item) => typeof item === "string" ? item : "");
  return normalized.every((item) => item.length > 0) ? normalized : null;
}

function normalizeChoiceIdentity(value: unknown): UserChoiceResolutionIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const optionValues = normalizeStringArray(candidate.optionValues);
  if (
    typeof candidate.sessionKey !== "string" || !candidate.sessionKey.trim() ||
    typeof candidate.turnId !== "string" || !candidate.turnId.trim() ||
    typeof candidate.runId !== "string" || !candidate.runId.trim() ||
    typeof candidate.requestId !== "string" || !candidate.requestId.trim() ||
    (candidate.parentRunId !== undefined && candidate.parentRunId !== null &&
      typeof candidate.parentRunId !== "string") ||
    !optionValues ||
    typeof candidate.allowCustomReply !== "boolean" ||
    candidate.status !== "pending"
  ) return null;
  return {
    sessionKey: candidate.sessionKey,
    turnId: candidate.turnId,
    runId: candidate.runId,
    requestId: candidate.requestId,
    parentRunId: typeof candidate.parentRunId === "string" ? candidate.parentRunId : null,
    optionValues,
    allowCustomReply: candidate.allowCustomReply,
    status: "pending",
  };
}

function resolveExactWorkspaceInstructionChoice(
  input: WorkspaceInstructionChoiceResolutionInput,
):
  | { matched: false; reason: WorkspaceInstructionChoiceFailureReason }
  | {
      matched: true;
      identity: UserChoiceResolutionIdentity;
      selectedOption: ReplyOption | null;
    } {
  const sourceTurnId = typeof input.hints.replyOptionSourceTurnId === "string"
    ? input.hints.replyOptionSourceTurnId.trim()
    : "";
  const selectedText = typeof input.hints.selectedReplyOptionText === "string"
    ? input.hints.selectedReplyOptionText
    : "";
  const identity = normalizeChoiceIdentity(input.hints.replyOptionRequestIdentity);
  if (
    !sourceTurnId &&
    !selectedText.trim() &&
    input.hints.replyOptionRequestIdentity == null
  ) {
    return { matched: false, reason: "not_requested" };
  }
  if (!sourceTurnId || !selectedText.trim() || !identity) {
    return { matched: false, reason: "missing_identity" };
  }
  if (identity.sessionKey !== input.sessionKey || identity.turnId !== sourceTurnId) {
    return { matched: false, reason: "owner_mismatch" };
  }
  const activeActionRequest = input.activeActionRequest;
  if (
    !activeActionRequest ||
    activeActionRequest.kind !== "user_choice" ||
    activeActionRequest.status !== "pending" ||
    !isExactUserChoiceResolutionIdentity(activeActionRequest, identity)
  ) {
    return { matched: false, reason: "stale_request" };
  }
  const sourceBlock = input.taskFlow.find((block): block is Extract<TaskBlock, { type: "agent" }> =>
    block.type === "agent" &&
    block.turnId === sourceTurnId &&
    block.archivedAfterChoice !== true &&
    Array.isArray(block.options) &&
    block.options.length > 0 &&
    isExactUserChoiceResolutionIdentity(block.choiceRequest, identity)
  );
  if (!sourceBlock || !isMatchingUserChoiceResolution({
    identity: sourceBlock.choiceRequest,
    sessionKey: input.sessionKey,
    turnId: sourceTurnId,
    optionValue: selectedText,
    isCustomReply: input.hints.replyOptionIsCustom === true,
  })) {
    return { matched: false, reason: "stale_request" };
  }
  const normalizedSelectedText = selectedText.trim();
  const selectedOption = (sourceBlock.options || []).find((option) =>
    String(option.value || "").trim() === normalizedSelectedText ||
    String(option.label || "").trim() === normalizedSelectedText
  ) || null;
  return { matched: true, identity, selectedOption };
}

/** Resolve an exact pending user-choice into the pending-review transition. */
export function resolveWorkspaceInstructionActionDecision(
  input: WorkspaceInstructionChoiceResolutionInput,
): WorkspaceInstructionActionDecision {
  const choice = resolveExactWorkspaceInstructionChoice(input);
  if (!choice.matched) {
    return { actionDecision: null, reason: choice.reason };
  }
  const action = choice.selectedOption?.action;
  if (action === "execute_once" || action === "approve_operation_once") {
    return {
      actionDecision: "approve",
      reason: "exact_pending_choice",
      identity: choice.identity,
    };
  }
  if (action === "cancel_operation") {
    return {
      actionDecision: "reject",
      reason: "exact_pending_choice",
      identity: choice.identity,
    };
  }
  return { actionDecision: null, reason: "option_not_action_decision" };
}

/**
 * Revalidate an execution-once candidate at FIFO dispatch time. A persisted
 * boolean is never authority: consent exists only while the exact source
 * choice is still pending and the selected option explicitly grants one
 * execution. Archiving that source block consumes the capability.
 */
export function resolveWorkspaceInstructionExecutionConsent(
  input: WorkspaceInstructionChoiceResolutionInput,
): WorkspaceInstructionConsentDecision {
  if (input.hints.executionConsentGranted !== true) {
    return { granted: false, reason: "not_requested" };
  }
  const choice = resolveExactWorkspaceInstructionChoice(input);
  if (!choice.matched) {
    return {
      granted: false,
      reason: choice.reason === "not_requested" ? "missing_identity" : choice.reason,
    };
  }
  const selectedOption = choice.selectedOption;
  if (
    !selectedOption ||
    (selectedOption.action !== "execute_once" &&
      selectedOption.action !== "approve_operation_once")
  ) {
    return { granted: false, reason: "option_not_authorized" };
  }
  return { granted: true, reason: "exact_pending_choice", identity: choice.identity };
}
