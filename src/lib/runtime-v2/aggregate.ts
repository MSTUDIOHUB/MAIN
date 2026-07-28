import type {
  RuntimeV2Command,
  RuntimeV2CommandReceipt,
  RuntimeV2EvidenceReference,
  RuntimeV2NormalizedToolCall,
  RuntimeV2Objective,
  RuntimeV2Phase,
  RuntimeV2RecoveryBudget,
  RuntimeV2RunIdentity,
  RuntimeV2Strategy,
  RuntimeV2SubagentJob,
  RuntimeV2TerminalOutcome,
  RuntimeV2TurnIdentity,
  RuntimeV2WorkPlanReference,
} from "./contracts";
import type { RuntimeV2Event } from "./events";
import type {
  RuntimeV2PlanReviewCommit,
  SealedWorkPlanV1,
} from "./workPlan";
import type { RuntimeV2ExecutionContractV1 } from "./executionContract";

export interface RuntimeV2RunState {
  readonly identity: RuntimeV2RunIdentity;
  readonly status: "running" | "reviewing" | "completed";
  readonly phase: RuntimeV2Phase;
  readonly terminalOutcome: RuntimeV2TerminalOutcome | null;
}

export interface TurnAggregateV1 {
  readonly schemaVersion: "turn-aggregate.v1";
  readonly turn: RuntimeV2TurnIdentity;
  readonly strategy: RuntimeV2Strategy;
  readonly objective: RuntimeV2Objective;
  readonly run: RuntimeV2RunState | null;
  readonly phase: RuntimeV2Phase;
  readonly events: readonly RuntimeV2Event[];
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly workPlan: RuntimeV2WorkPlanReference | null;
  /** Durable Runtime v2 Plan authority. The Markdown artifact and UI surfaces
   * are projections of this value, never inputs used to reconstruct it. */
  readonly sealedWorkPlan: SealedWorkPlanV1 | null;
  readonly planReviewCommit: RuntimeV2PlanReviewCommit | null;
  /** Runtime-owned Execute authority. Provider drafts are compiled against
   * the immutable admitted objective and versioned source evidence. */
  readonly executionContract: RuntimeV2ExecutionContractV1 | null;
  readonly scheduledCommands: readonly RuntimeV2Command[];
  /** Completed receipts make a cold recovery distinguish an unstarted effect
   * from a command that already consumed its bounded retry budget. */
  readonly completedCommands: readonly RuntimeV2CommandReceipt[];
  readonly pendingToolCalls: readonly RuntimeV2NormalizedToolCall[];
  readonly subagents: readonly RuntimeV2SubagentJob[];
  readonly recovery: RuntimeV2RecoveryBudget;
  readonly terminalOutcome: RuntimeV2TerminalOutcome | null;
  readonly finalProjectionId: string | null;
  readonly nextSequence: number;
  readonly updatedAt: number;
}
