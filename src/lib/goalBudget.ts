// lib/goalBudget.ts
// Budget management and safety controls for Goal Mode.
// Enforces iteration limits, duration caps, and no-progress detection.
// ────────────────────────────────────────────────────────────────────

import type { GoalDefinition, GoalIteration, GoalProgress } from "./goalState";
import { isGoalEvidenceMeaningfulProgress } from "./goalToolCapabilities";

export interface GoalBudget {
  /** Maximum total iterations across all rounds (hard cap: 500) */
  maxIterations: number;
  /** Optional total token budget */
  maxTokens?: number;
  /** Maximum total tool calls across all slices. */
  maxToolCalls: number;
  /** Maximum active execution duration in ms (default: 4 hours; pauses excluded) */
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
  maxToolCalls: 2_000,
  maxDurationMs: 4 * 60 * 60 * 1000,  // 4 hours
  checkpointInterval: 5,
  userConfirmInterval: 50,
  maxNoProgressIterations: 3,
};

/** Absolute hard caps that cannot be overridden */
export const GOAL_HARD_CAPS = {
  maxIterations: 500,
  maxToolCalls: 10_000,
  maxDurationMs: 12 * 60 * 60 * 1000,  // 12 hours
  minCheckpointInterval: 2,
} as const;

export function resolveGoalBudget(overrides?: Partial<GoalBudget> | null): GoalBudget {
  const base = { ...DEFAULT_GOAL_BUDGET, ...overrides };
  const maxIterations = finiteNumber(base.maxIterations, DEFAULT_GOAL_BUDGET.maxIterations);
  const maxDurationMs = finiteNumber(base.maxDurationMs, DEFAULT_GOAL_BUDGET.maxDurationMs);
  const maxToolCalls = finiteNumber(base.maxToolCalls, DEFAULT_GOAL_BUDGET.maxToolCalls);
  const checkpointInterval = finiteNumber(base.checkpointInterval, DEFAULT_GOAL_BUDGET.checkpointInterval);
  const userConfirmInterval = finiteNumber(base.userConfirmInterval, DEFAULT_GOAL_BUDGET.userConfirmInterval);
  const maxNoProgressIterations = finiteNumber(
    base.maxNoProgressIterations,
    DEFAULT_GOAL_BUDGET.maxNoProgressIterations,
  );
  const maxTokens = base.maxTokens == null
    ? undefined
    : Number.isFinite(Number(base.maxTokens))
      ? Math.max(1, Math.floor(Number(base.maxTokens)))
      : undefined;
  return {
    maxIterations: clampInt(maxIterations, 1, GOAL_HARD_CAPS.maxIterations),
    maxTokens,
    maxToolCalls: clampInt(maxToolCalls, 1, GOAL_HARD_CAPS.maxToolCalls),
    maxDurationMs: clampInt(maxDurationMs, 60_000, GOAL_HARD_CAPS.maxDurationMs),
    checkpointInterval: clampInt(checkpointInterval, GOAL_HARD_CAPS.minCheckpointInterval, 50),
    userConfirmInterval: Math.max(0, Math.floor(userConfirmInterval)),
    maxNoProgressIterations: clampInt(maxNoProgressIterations, 1, 10),
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
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
  | "tool_call_limit"
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

  // 3. Tool-call limit
  const toolCallsUsed = progress.usage?.toolCalls || 0;
  if (toolCallsUsed >= budget.maxToolCalls) {
    return {
      ok: false,
      reason: "tool_call_limit",
      message: `Goal reached tool-call limit: ${toolCallsUsed}/${budget.maxToolCalls}`,
    };
  }

  // 4. Duration limit
  const elapsed = progress.usage
    ? progress.usage.activeDurationMs + (progress.usage.activeStartedAt ? Math.max(0, Date.now() - progress.usage.activeStartedAt) : 0)
    : Date.now() - goal.createdAt;
  if (elapsed > budget.maxDurationMs) {
    return {
      ok: false,
      reason: "duration_limit",
      message: `Goal exceeded duration limit: ${formatDuration(elapsed)} / ${formatDuration(budget.maxDurationMs)}`,
    };
  }

  // 5. No-progress detection
  if (recentIterations && recentIterations.length >= budget.maxNoProgressIterations) {
    const recent = recentIterations.slice(-budget.maxNoProgressIterations);
    const evidence = progress.evidence || [];
    const trackedNoProgress = progress.recoveryState?.normalizedCause === "no_progress"
      && progress.recoveryState.consecutiveCount >= budget.maxNoProgressIterations;
    const legacyAllNoProgress = !progress.recoveryState
      && recent.every((iter) => !iter.stopReason)
      && recent.every((iter) =>
        !evidence.some((entry) =>
          entry.iteration === iter.index
          && isGoalEvidenceMeaningfulProgress(entry)
        )
      );
    const allNoProgress = trackedNoProgress || legacyAllNoProgress;
    if (allNoProgress) {
      return {
        ok: false,
        reason: "no_progress",
        message: `No meaningful execution evidence in the last ${budget.maxNoProgressIterations} iterations`,
      };
    }
  }

  // 6. User confirmation checkpoint
  if (
    budget.userConfirmInterval > 0 &&
    progress.totalIterationsUsed > 0 &&
    progress.totalIterationsUsed % budget.userConfirmInterval === 0 &&
    progress.lastUserConfirmedIteration !== progress.totalIterationsUsed
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
  const elapsed = progress.usage
    ? progress.usage.activeDurationMs + (progress.usage.activeStartedAt ? Math.max(0, Date.now() - progress.usage.activeStartedAt) : 0)
    : Date.now() - goal.createdAt;
  const iterLabel = `${progress.totalIterationsUsed}/${budget.maxIterations}`;
  const timeLabel = `${formatDuration(elapsed)} / ${formatDuration(budget.maxDurationMs)}`;

  if (language === "zh") {
    return [
      `迭代进度：${iterLabel}`,
      `运行时间：${timeLabel}`,
      budget.maxTokens ? `Token 用量：${progress.totalTokensUsed}/${budget.maxTokens}` : "",
      `工具调用：${progress.usage?.toolCalls || 0}/${budget.maxToolCalls}`,
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
    `Tool calls: ${progress.usage?.toolCalls || 0}/${budget.maxToolCalls}`,
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
    tool_call_limit: {
      zh: "目标已达到工具调用预算上限",
      en: "Goal reached tool-call budget limit",
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
