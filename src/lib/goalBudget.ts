// lib/goalBudget.ts
// Budget management and safety controls for Goal Mode.
// Enforces iteration limits, duration caps, and no-progress detection.
// ────────────────────────────────────────────────────────────────────

import type { GoalDefinition, GoalIteration, GoalProgress } from "./goalState";

export interface GoalBudget {
  /** Maximum total iterations across all rounds (hard cap: 500) */
  maxIterations: number;
  /** Optional total token budget */
  maxTokens?: number;
  /** Maximum wall-clock duration in ms (default: 4 hours) */
  maxDurationMs: number;
  /** Save a checkpoint every N iterations */
  checkpointInterval: number;
  /** Pause for user confirmation every N iterations (0 = never) */
  userConfirmInterval: number;
  /** Max consecutive iterations with no file changes before pausing */
  maxNoProgressIterations: number;
}

export const DEFAULT_GOAL_BUDGET: GoalBudget = {
  maxIterations: 200,
  maxDurationMs: 4 * 60 * 60 * 1000,  // 4 hours
  checkpointInterval: 5,
  userConfirmInterval: 50,
  maxNoProgressIterations: 3,
};

/** Absolute hard caps that cannot be overridden */
export const GOAL_HARD_CAPS = {
  maxIterations: 500,
  maxDurationMs: 12 * 60 * 60 * 1000,  // 12 hours
  minCheckpointInterval: 2,
} as const;

export function resolveGoalBudget(overrides?: Partial<GoalBudget> | null): GoalBudget {
  const base = { ...DEFAULT_GOAL_BUDGET, ...overrides };
  return {
    maxIterations: clampInt(base.maxIterations, 1, GOAL_HARD_CAPS.maxIterations),
    maxTokens: base.maxTokens != null ? Math.max(1, base.maxTokens) : undefined,
    maxDurationMs: clampInt(base.maxDurationMs, 60_000, GOAL_HARD_CAPS.maxDurationMs),
    checkpointInterval: clampInt(base.checkpointInterval, GOAL_HARD_CAPS.minCheckpointInterval, 50),
    userConfirmInterval: Math.max(0, Math.floor(base.userConfirmInterval)),
    maxNoProgressIterations: clampInt(base.maxNoProgressIterations, 1, 10),
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

// ── Budget check results ─────────────────────────────────────────

export type GoalBudgetCheckResult =
  | { ok: true }
  | { ok: false; reason: GoalBudgetExceededReason; message: string };

export type GoalBudgetExceededReason =
  | "iteration_limit"
  | "token_limit"
  | "duration_limit"
  | "no_progress"
  | "user_confirm_needed";

export function checkGoalBudget(input: {
  goal: GoalDefinition;
  progress: GoalProgress;
  budget: GoalBudget;
  recentIterations?: GoalIteration[];
}): GoalBudgetCheckResult {
  const { goal, progress, budget, recentIterations } = input;

  // 1. Iteration limit
  if (progress.totalIterationsUsed >= budget.maxIterations) {
    return {
      ok: false,
      reason: "iteration_limit",
      message: `Goal reached iteration limit: ${progress.totalIterationsUsed}/${budget.maxIterations}`,
    };
  }

  // 2. Token limit
  if (budget.maxTokens != null && progress.totalTokensUsed >= budget.maxTokens) {
    return {
      ok: false,
      reason: "token_limit",
      message: `Goal reached token limit: ${progress.totalTokensUsed}/${budget.maxTokens}`,
    };
  }

  // 3. Duration limit
  const elapsed = Date.now() - goal.createdAt;
  if (elapsed > budget.maxDurationMs) {
    return {
      ok: false,
      reason: "duration_limit",
      message: `Goal exceeded duration limit: ${formatDuration(elapsed)} / ${formatDuration(budget.maxDurationMs)}`,
    };
  }

  // 4. No-progress detection
  if (recentIterations && recentIterations.length >= budget.maxNoProgressIterations) {
    const recent = recentIterations.slice(-budget.maxNoProgressIterations);
    const allNoProgress = recent.every(
      (iter) => iter.filesModified.length === 0 && iter.testsRun.length === 0,
    );
    if (allNoProgress) {
      return {
        ok: false,
        reason: "no_progress",
        message: `No file changes or tests in the last ${budget.maxNoProgressIterations} iterations`,
      };
    }
  }

  // 5. User confirmation checkpoint
  if (
    budget.userConfirmInterval > 0 &&
    progress.totalIterationsUsed > 0 &&
    progress.totalIterationsUsed % budget.userConfirmInterval === 0
  ) {
    return {
      ok: false,
      reason: "user_confirm_needed",
      message: `Periodic user confirmation checkpoint at iteration ${progress.totalIterationsUsed}`,
    };
  }

  return { ok: true };
}

// ── Checkpoint scheduling ────────────────────────────────────────

export function shouldCreateCheckpoint(
  iterationIndex: number,
  budget: GoalBudget,
): boolean {
  if (iterationIndex <= 0) return false;
  return iterationIndex % budget.checkpointInterval === 0;
}

// ── UI helpers ───────────────────────────────────────────────────

export function buildGoalBudgetSummary(input: {
  progress: GoalProgress;
  budget: GoalBudget;
  goal: GoalDefinition;
  language: "zh" | "en";
}): string {
  const { progress, budget, goal, language } = input;
  const elapsed = Date.now() - goal.createdAt;
  const iterLabel = `${progress.totalIterationsUsed}/${budget.maxIterations}`;
  const timeLabel = `${formatDuration(elapsed)} / ${formatDuration(budget.maxDurationMs)}`;

  if (language === "zh") {
    return [
      `迭代进度：${iterLabel}`,
      `运行时间：${timeLabel}`,
      budget.maxTokens ? `Token 用量：${progress.totalTokensUsed}/${budget.maxTokens}` : "",
      `检查点间隔：每 ${budget.checkpointInterval} 轮`,
      budget.userConfirmInterval > 0
        ? `用户确认：每 ${budget.userConfirmInterval} 轮`
        : "用户确认：关闭（自动运行）",
    ].filter(Boolean).join("\n");
  }

  return [
    `Iterations: ${iterLabel}`,
    `Duration: ${timeLabel}`,
    budget.maxTokens ? `Tokens: ${progress.totalTokensUsed}/${budget.maxTokens}` : "",
    `Checkpoint: every ${budget.checkpointInterval} iterations`,
    budget.userConfirmInterval > 0
      ? `User confirm: every ${budget.userConfirmInterval} iterations`
      : "User confirm: off (auto-run)",
  ].filter(Boolean).join("\n");
}

export function buildGoalBudgetExceededNotice(input: {
  reason: GoalBudgetExceededReason;
  message: string;
  progress: GoalProgress;
  budget: GoalBudget;
  language: "zh" | "en";
}): string {
  const { reason, message, progress, budget, language } = input;

  const reasonLabels: Record<GoalBudgetExceededReason, { zh: string; en: string }> = {
    iteration_limit: {
      zh: `目标已达到迭代上限（${progress.totalIterationsUsed}/${budget.maxIterations}）`,
      en: `Goal reached iteration limit (${progress.totalIterationsUsed}/${budget.maxIterations})`,
    },
    token_limit: {
      zh: `目标已达到 Token 预算上限`,
      en: `Goal reached token budget limit`,
    },
    duration_limit: {
      zh: `目标已达到运行时长上限`,
      en: `Goal reached duration limit`,
    },
    no_progress: {
      zh: `目标连续 ${budget.maxNoProgressIterations} 轮无进展，已自动暂停`,
      en: `Goal had no progress for ${budget.maxNoProgressIterations} consecutive iterations, paused automatically`,
    },
    user_confirm_needed: {
      zh: `已运行 ${progress.totalIterationsUsed} 轮，等待用户确认后继续`,
      en: `Ran ${progress.totalIterationsUsed} iterations, waiting for user confirmation to continue`,
    },
  };

  const label = language === "en" ? reasonLabels[reason].en : reasonLabels[reason].zh;
  const nextStep = reason === "user_confirm_needed"
    ? (language === "zh" ? "输入 /目标 继续 或 /目标 取消 来控制目标执行" : 'Type "/goal resume" or "/goal clear" to control goal execution')
    : (language === "zh" ? "可以调整预算后重新启动，或设定新目标" : "Adjust the budget and restart, or set a new goal");

  return [label, message, nextStep].filter(Boolean).join("\n");
}

// ── Internal helpers ─────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}
