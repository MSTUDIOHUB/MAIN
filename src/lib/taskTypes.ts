import type { GitDiffEntry, ShellPermissionDecision } from "./ipc";
import type { ImageGenerationBlockPayload } from "./imageStudio";
import type { ProgressNarration } from "./progressNarration";
import type { TurnRuntimePhase } from "./turnPhase";
import type { UserContextItem } from "./userContextItems";
import type { PlanExecutionProgressSnapshot, ReplyOption } from "./workflowModels";
import type { UserChoiceResolutionIdentity } from "./actionRequest";

export interface JobItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TaskBlockBase {
  id: number;
  turnId?: string;
  turnPhase?: TurnRuntimePhase;
  /** Internal runtime diagnostics are persisted for recovery but never rendered. */
  audience?: "user" | "internal";
}

export interface ToolDiffSnapshot {
  old: string;
  new: string;
  path?: string;
  existed?: boolean;
  fullFile?: boolean;
  binary?: boolean;
}

export interface GitDiffPreviewState {
  entries: GitDiffEntry[];
  sourceLabel?: string;
}

export type DiffRevertStatus = "reverting" | "reverted" | "failed";

export interface DiffRevertRequest {
  path: string;
  taskIds: number[];
  oldText: string;
  newText: string;
  existed?: boolean;
  fullFile?: boolean;
}

export interface DiffRevertResult {
  path: string;
  taskIds: number[];
  ok: boolean;
  message: string;
}

export type AssistantTextVisibility =
  | "user_progress"
  | "hidden_process"
  | "assistant_update"
  /** @deprecated Persisted compatibility for the earlier lexical classifier. */
  | "stage_summary"
  | "substantive_plan_text";

export type ProgressTaskBlock = TaskBlockBase & ProgressNarration & {
  type: "progress";
  toolCallId?: string;
  toolCallIds?: string[];
  toolName?: string;
  target?: string;
  /** Runtime owner for durable phase/liveness projection. */
  runId?: string;
  parentRunId?: string | null;
  dedupeKey?: string;
  phaseReason?: string;
  iteration?: number;
  qualityRejectCount?: number;
  elapsedMs?: number;
  createdAt?: number;
  updatedAt?: number;
};

export type TaskBlock =
  | (TaskBlockBase & { type: "user"; content: string; images?: string[]; contextItems?: UserContextItem[] })
  | (TaskBlockBase & {
      type: "tool";
      toolName: string;
      target: string;
      status: string;
      toolStatus: "pending" | "executed" | "rejected" | "running" | "failed";
      toolCallId?: string;
      message?: string;
      diff?: ToolDiffSnapshot;
      shellPermissionDecision?: ShellPermissionDecision;
      revertStatus?: DiffRevertStatus;
      revertMessage?: string;
      intentSummary?: string;
      why?: string;
      evidence?: string;
      observationSummary?: string;
      qualityGateReason?: string;
      planRecoveryReason?: string;
    })
  | (TaskBlockBase & {
      type: "agent";
      content: string;
      options?: ReplyOption[];
      choiceRequest?: UserChoiceResolutionIdentity;
      streaming?: boolean;
      hiddenProcess?: boolean;
      visibility?: AssistantTextVisibility;
      archivedAfterChoice?: boolean;
      archivedProposal?: boolean;
      selectedOption?: string;
      isEscalating?: boolean;
      escalationReason?: string;
      failedAttempts?: Array<{ content: string; reasoning?: string; reason: string; timestamp: number }>;
    })
  | (TaskBlockBase & ImageGenerationBlockPayload)
  | ProgressTaskBlock
  | (TaskBlockBase & { type: "thought"; content: string; isStreaming?: boolean; duration?: number; originalChars?: number })
  | (TaskBlockBase & { type: "jobList"; jobs: JobItem[] })
  | (TaskBlockBase & {
      type: "system";
      content: string;
      icon?: string;
      variant?:
        | "context_compression"
        | "plan_quality_gate"
        | "plan_execution_progress"
        | "plan_execution_checkpoint"
        | "execution_checkpoint"
        | "game_studio_local_markdown";
      planExecutionProgress?: PlanExecutionProgressSnapshot;
      contextCompression?: {
        reason: "proactive" | "reactive" | "execute_recovery";
        droppedCount: number;
        tokenCountBefore: number;
        tokenCountAfter: number;
        tokenReduction: number;
        compressedContext?: string;
        displaySummary?: string;
        memoryPacket?: string;
        microCompactionKind?: "none" | "tool_results" | "assistant_messages" | "mixed";
        microCompactedCount?: number;
        droppedMessageCount?: number;
        topTokenSource?: {
          label: string;
          tokens: number;
          total?: number;
        };
      };
    });
