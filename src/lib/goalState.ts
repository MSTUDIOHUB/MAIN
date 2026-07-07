// lib/goalState.ts
// Goal lifecycle data model for MAIN's /目标 (Goal Mode).
// Tracks goal definition, iteration progress, and checkpoints.
// ────────────────────────────────────────────────────────────────────

export type GoalStatus =
  | "active"           // Currently executing
  | "paused"           // User paused or checkpoint reached
  | "completed"        // Objective met (verification passed)
  | "failed"           // Unrecoverable failure
  | "budget_exceeded"; // Iteration/token budget exhausted

export type GoalIterationPhase =
  | "plan"      // Analyzing current state, choosing next task
  | "execute"   // Running tools to implement the task
  | "observe"   // Verifying results (tests, build, lint)
  | "re_plan";  // Adjusting strategy based on observation

export interface GoalDefinition {
  /** Unique goal ID */
  id: string;
  /** User-defined objective text */
  objective: string;
  /** Completion criteria (auto-extracted or user-specified) */
  definitionOfDone: string[];
  /** Timestamp when the goal was created */
  createdAt: number;
  /** Current goal status */
  status: GoalStatus;
  /** Total iteration budget for this goal */
  iterationBudget: number;
  /** Optional total token budget */
  tokenBudget?: number;
  /** Optional max duration in milliseconds */
  maxDurationMs?: number;
  /** Session key associated with this goal */
  sessionKey?: string;
}

export interface GoalIteration {
  /** Iteration index (1-based) */
  index: number;
  /** Current phase within this iteration */
  phase: GoalIterationPhase;
  /** When the iteration started */
  startedAt: number;
  /** When the iteration ended (null if still running) */
  endedAt?: number;
  /** Human-readable summary of what was accomplished */
  summary: string;
  /** Number of tool calls made in this iteration */
  toolCallCount: number;
  /** Files modified during this iteration */
  filesModified: string[];
  /** Test commands that were run */
  testsRun: string[];
  /** Whether tests passed (null if no tests ran) */
  testsPassed: boolean | null;
  /** Unresolved blockers encountered */
  unresolvedBlockers: string[];
}

export interface GoalCheckpoint {
  /** Iteration number at checkpoint */
  iteration: number;
  /** Timestamp of checkpoint creation */
  timestamp: number;
  /** Tasks completed so far */
  completedTasks: string[];
  /** Remaining tasks */
  remainingTasks: string[];
  /** Current phase at checkpoint time */
  currentPhase: GoalIterationPhase;
  /** Compressed context summary for the next iteration */
  contextSummary: string;
  /** List of files modified across all iterations */
  workspaceSnapshot: string[];
  /** Recent verification result summary */
  lastVerificationSummary?: string;
}

export interface GoalProgress {
  /** Goal ID this progress belongs to */
  goalId: string;
  /** Current iteration number */
  currentIteration: number;
  /** Total iterations used so far */
  totalIterationsUsed: number;
  /** Estimated total tokens used */
  totalTokensUsed: number;
  /** Full iteration history */
  iterations: GoalIteration[];
  /** Last saved checkpoint (null if none yet) */
  lastCheckpoint: GoalCheckpoint | null;
  /** Path to the progress file (.MAIN/goals/progress.md) */
  progressFile: string;
  /** Timestamp of last progress update */
  lastUpdatedAt: number;
}

export interface GoalLoopOutcome {
  /** Final status of the goal loop */
  status: GoalStatus;
  /** Human-readable reason for the outcome */
  reason: string;
  /** Total iterations used */
  iterationsUsed: number;
  /** Final checkpoint (if available) */
  finalCheckpoint: GoalCheckpoint | null;
}

// ── Factory helpers ──────────────────────────────────────────────

let goalIdCounter = 0;

function generateGoalId(): string {
  goalIdCounter += 1;
  return `goal_${Date.now()}_${goalIdCounter}`;
}

export function createGoalDefinition(input: {
  objective: string;
  definitionOfDone?: string[];
  iterationBudget?: number;
  tokenBudget?: number;
  maxDurationMs?: number;
  sessionKey?: string;
}): GoalDefinition {
  return {
    id: generateGoalId(),
    objective: input.objective.trim(),
    definitionOfDone: input.definitionOfDone ?? [],
    createdAt: Date.now(),
    status: "active",
    iterationBudget: Math.min(Math.max(1, input.iterationBudget ?? 200), 500),
    tokenBudget: input.tokenBudget,
    maxDurationMs: input.maxDurationMs,
    sessionKey: input.sessionKey,
  };
}

export function createGoalIteration(index: number): GoalIteration {
  return {
    index,
    phase: "plan",
    startedAt: Date.now(),
    summary: "",
    toolCallCount: 0,
    filesModified: [],
    testsRun: [],
    testsPassed: null,
    unresolvedBlockers: [],
  };
}

export function createGoalProgress(goalId: string, progressFile: string): GoalProgress {
  return {
    goalId,
    currentIteration: 0,
    totalIterationsUsed: 0,
    totalTokensUsed: 0,
    iterations: [],
    lastCheckpoint: null,
    progressFile,
    lastUpdatedAt: Date.now(),
  };
}

export function createGoalCheckpoint(input: {
  iteration: number;
  completedTasks: string[];
  remainingTasks: string[];
  currentPhase: GoalIterationPhase;
  contextSummary: string;
  workspaceSnapshot: string[];
  lastVerificationSummary?: string;
}): GoalCheckpoint {
  return {
    iteration: input.iteration,
    timestamp: Date.now(),
    completedTasks: input.completedTasks,
    remainingTasks: input.remainingTasks,
    currentPhase: input.currentPhase,
    contextSummary: input.contextSummary,
    workspaceSnapshot: input.workspaceSnapshot,
    lastVerificationSummary: input.lastVerificationSummary,
  };
}

// ── Status predicates ────────────────────────────────────────────

export function isGoalTerminal(status: GoalStatus): boolean {
  return status === "completed" || status === "failed" || status === "budget_exceeded";
}

export function isGoalRunnable(status: GoalStatus): boolean {
  return status === "active" || status === "paused";
}

export function canResumeGoal(goal: GoalDefinition): boolean {
  if (!isGoalRunnable(goal.status)) return false;
  if (goal.maxDurationMs && Date.now() - goal.createdAt > goal.maxDurationMs) return false;
  return true;
}

// ── Progress summary ─────────────────────────────────────────────

export function buildGoalProgressPercentage(progress: GoalProgress, goal: GoalDefinition): number {
  if (goal.iterationBudget <= 0) return 0;
  const doneCount = progress.lastCheckpoint?.completedTasks.length ?? 0;
  const totalCount = doneCount + (progress.lastCheckpoint?.remainingTasks.length ?? 1);
  if (totalCount === 0) return 0;
  return Math.min(100, Math.round((doneCount / totalCount) * 100));
}

export function buildGoalStatusLabel(status: GoalStatus, language: "zh" | "en"): string {
  const labels: Record<GoalStatus, { zh: string; en: string }> = {
    active: { zh: "执行中", en: "Active" },
    paused: { zh: "已暂停", en: "Paused" },
    completed: { zh: "已完成", en: "Completed" },
    failed: { zh: "失败", en: "Failed" },
    budget_exceeded: { zh: "预算耗尽", en: "Budget Exceeded" },
  };
  return language === "en" ? labels[status].en : labels[status].zh;
}

export function summarizeGoalIteration(iteration: GoalIteration, language: "zh" | "en"): string {
  const parts: string[] = [];
  if (iteration.summary) {
    parts.push(iteration.summary);
  }
  if (iteration.filesModified.length > 0) {
    const filesLabel = language === "en" ? "Modified" : "修改了";
    parts.push(`${filesLabel}: ${iteration.filesModified.join(", ")}`);
  }
  if (iteration.testsPassed !== null) {
    const testLabel = language === "en"
      ? (iteration.testsPassed ? "Tests passed" : "Tests failed")
      : (iteration.testsPassed ? "测试通过" : "测试失败");
    parts.push(testLabel);
  }
  if (iteration.unresolvedBlockers.length > 0) {
    const blockerLabel = language === "en" ? "Blockers" : "阻塞";
    parts.push(`${blockerLabel}: ${iteration.unresolvedBlockers.join("; ")}`);
  }
  return parts.join(" | ") || (language === "en" ? "(no summary)" : "(无摘要)");
}
