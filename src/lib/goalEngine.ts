// lib/goalEngine.ts
// Core Goal Engine — implements the Ralph Loop for MAIN's Goal Mode.
//
// Architecture:
//   The Goal Engine is a HIGHER-LEVEL loop that wraps the existing
//   AgentOrchestrator. Each "goal iteration" triggers one run of the
//   orchestrator with a compressed context window.
//
//   ┌─────────────────────────────────────────┐
//   │              Goal Engine                │
//   │  ┌──────┐  ┌─────────┐  ┌──────────┐   │
//   │  │ Plan │→ │ Execute │→ │ Observe  │   │
//   │  └──────┘  └─────────┘  └──────────┘   │
//   │       ↑         │            │          │
//   │       └─── Re-plan ←─────────┘          │
//   │                                         │
//   │  Per iteration:                         │
//   │  1. Build compressed context            │
//   │  2. Run AgentOrchestrator               │
//   │  3. Extract evidence (files, tests)     │
//   │  4. Optionally run verification         │
//   │  5. Create checkpoint if due            │
//   │  6. Check termination conditions        │
//   └─────────────────────────────────────────┘
// ────────────────────────────────────────────────────────────────────

import type {
  GoalCheckpoint,
  GoalDefinition,
  GoalIteration,
  GoalLoopOutcome,
  GoalProgress,
} from "./goalState";
import {
  createGoalCheckpoint,
  createGoalIteration,
  createGoalProgress,
  isGoalTerminal,
} from "./goalState";
import type { GoalBudget } from "./goalBudget";
import {
  checkGoalBudget,
  resolveGoalBudget,
  shouldCreateCheckpoint,
} from "./goalBudget";
import {
  buildGoalIterationSystemContext,
  detectGoalCompletionSignal,
  extractModifiedFilesFromToolCalls,
  extractTestCommandsFromToolCalls,
} from "./goalContextStrategy";
import {
  buildGoalProgressMarkdown,
  resolveGoalProgressFilePath,
} from "./goalPersistence";

// ── Goal Engine callbacks ────────────────────────────────────────

export interface GoalEngineCallbacks {
  /** Language preference */
  getPreferredLanguage: () => "zh" | "en";
  /** Workspace root path */
  getWorkspacePath: () => string;
  /** Run one iteration of the agent loop with given context */
  runAgentIteration: (input: {
    goalSystemContext: string;
    iteration: number;
    maxIterations: number;
  }) => Promise<GoalAgentIterationResult>;
  /** Write a file to the workspace */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Read a file from the workspace */
  readFile: (path: string) => Promise<string | null>;
  /** Check if aborted */
  isAborted: () => boolean;
  /** Notify UI of progress update */
  onGoalProgressUpdate: (progress: GoalProgress, goal: GoalDefinition) => void;
  /** Notify UI of iteration start */
  onGoalIterationStart: (iteration: GoalIteration) => void;
  /** Notify UI of iteration end */
  onGoalIterationEnd: (iteration: GoalIteration) => void;
  /** Notify UI of checkpoint saved */
  onGoalCheckpointSaved: (checkpoint: GoalCheckpoint) => void;
  /** Notify UI that user confirmation is needed */
  onGoalUserConfirmNeeded: (message: string) => Promise<boolean>;
  /** Notify UI of goal completion/failure */
  onGoalOutcome: (outcome: GoalLoopOutcome) => void;
  /** Log a debug event */
  onDebugEvent?: (event: string, data?: Record<string, unknown>) => void;
}

export interface GoalAgentIterationResult {
  /** Final assistant text from this iteration */
  assistantText: string;
  /** Tool calls made during this iteration */
  toolCalls: Array<{
    name: string;
    target?: string;
    arguments?: Record<string, unknown>;
  }>;
  /** Estimated tokens used in this iteration */
  tokensUsed: number;
  /** Whether the iteration completed normally */
  completed: boolean;
  /** Error message if iteration failed */
  error?: string;
}

// ── Main entry point ─────────────────────────────────────────────

export async function executeGoalLoop(input: {
  goal: GoalDefinition;
  callbacks: GoalEngineCallbacks;
  budgetOverrides?: Partial<GoalBudget>;
  existingProgress?: GoalProgress | null;
}): Promise<GoalLoopOutcome> {
  const { goal, callbacks, budgetOverrides, existingProgress } = input;
  const budget = resolveGoalBudget(budgetOverrides);
  const language = callbacks.getPreferredLanguage();
  const workspacePath = callbacks.getWorkspacePath();
  const progressFilePath = resolveGoalProgressFilePath(workspacePath);

  // Initialize or restore progress
  const progress: GoalProgress = existingProgress
    ? { ...existingProgress }
    : createGoalProgress(goal.id, progressFilePath);

  let lastCheckpoint: GoalCheckpoint | null = progress.lastCheckpoint;
  let lastVerificationResult = null;
  let consecutiveNoProgressCount = 0;

  callbacks.onDebugEvent?.("goal_loop_start", {
    goalId: goal.id,
    objective: goal.objective.slice(0, 200),
    budget: { maxIterations: budget.maxIterations, maxDurationMs: budget.maxDurationMs },
    resuming: !!existingProgress,
    startIteration: progress.totalIterationsUsed,
  });

  // ── Main Loop ──────────────────────────────────────────────────
  while (!isGoalTerminal(goal.status)) {
    // Check abort
    if (callbacks.isAborted()) {
      goal.status = "paused";
      return buildOutcome("paused", "User aborted the goal", progress, lastCheckpoint);
    }

    // Check budget
    const recentIterations = progress.iterations.slice(-budget.maxNoProgressIterations);
    const budgetCheck = checkGoalBudget({
      goal,
      progress,
      budget,
      recentIterations,
    });

    if (!budgetCheck.ok) {
      if (budgetCheck.reason === "user_confirm_needed") {
        // Request user confirmation
        const shouldContinue = await callbacks.onGoalUserConfirmNeeded(budgetCheck.message);
        if (!shouldContinue) {
          goal.status = "paused";
          return buildOutcome("paused", budgetCheck.message, progress, lastCheckpoint);
        }
        // User confirmed — continue
      } else if (budgetCheck.reason === "no_progress") {
        goal.status = "paused";
        callbacks.onGoalOutcome(buildOutcome("paused", budgetCheck.message, progress, lastCheckpoint));
        return buildOutcome("paused", budgetCheck.message, progress, lastCheckpoint);
      } else {
        goal.status = "budget_exceeded";
        const outcome = buildOutcome("budget_exceeded", budgetCheck.message, progress, lastCheckpoint);
        callbacks.onGoalOutcome(outcome);
        return outcome;
      }
    }

    // ── Start new iteration ──
    progress.totalIterationsUsed += 1;
    progress.currentIteration = progress.totalIterationsUsed;

    const iteration = createGoalIteration(progress.currentIteration);
    progress.iterations.push(iteration);

    callbacks.onGoalIterationStart(iteration);
    callbacks.onDebugEvent?.("goal_iteration_start", {
      iteration: iteration.index,
      phase: iteration.phase,
      totalUsed: progress.totalIterationsUsed,
      budget: budget.maxIterations,
    });

    // ── Build context for this iteration ──
    const systemContext = buildGoalIterationSystemContext({
      goal,
      checkpoint: lastCheckpoint,
      latestVerification: lastVerificationResult,
      nextIteration: progress.currentIteration,
      language,
    });

    // ── Execute one agent iteration ──
    let agentResult: GoalAgentIterationResult;
    try {
      agentResult = await callbacks.runAgentIteration({
        goalSystemContext: systemContext,
        iteration: progress.currentIteration,
        maxIterations: budget.maxIterations,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      iteration.phase = "execute";
      iteration.endedAt = Date.now();
      iteration.unresolvedBlockers.push(`Agent iteration error: ${errorMsg}`);
      iteration.summary = `Error: ${errorMsg.slice(0, 200)}`;

      callbacks.onGoalIterationEnd(iteration);
      callbacks.onDebugEvent?.("goal_iteration_error", {
        iteration: iteration.index,
        error: errorMsg.slice(0, 500),
      });

      // Don't immediately fail — allow retry in next iteration
      consecutiveNoProgressCount += 1;
      if (consecutiveNoProgressCount >= budget.maxNoProgressIterations) {
        goal.status = "failed";
        const outcome = buildOutcome(
          "failed",
          `Failed after ${consecutiveNoProgressCount} consecutive errors: ${errorMsg}`,
          progress,
          lastCheckpoint,
        );
        callbacks.onGoalOutcome(outcome);
        return outcome;
      }
      continue;
    }

    // ── Extract evidence from the iteration ──
    iteration.phase = "observe";
    iteration.toolCallCount = agentResult.toolCalls.length;
    iteration.filesModified = extractModifiedFilesFromToolCalls(agentResult.toolCalls);
    iteration.testsRun = extractTestCommandsFromToolCalls(agentResult.toolCalls);
    iteration.summary = extractIterationSummary(agentResult.assistantText, language);
    iteration.endedAt = Date.now();

    progress.totalTokensUsed += agentResult.tokensUsed;
    progress.lastUpdatedAt = Date.now();

    // Track no-progress
    if (iteration.filesModified.length === 0 && iteration.testsRun.length === 0) {
      consecutiveNoProgressCount += 1;
    } else {
      consecutiveNoProgressCount = 0;
    }

    // ── Check for goal completion signal ──
    const completionSignal = detectGoalCompletionSignal(agentResult.assistantText);
    if (completionSignal.completed) {
      goal.status = "completed";
      lastCheckpoint = createGoalCheckpoint({
        iteration: iteration.index,
        completedTasks: extractCompletedTasks(progress),
        remainingTasks: [],
        currentPhase: "observe",
        contextSummary: iteration.summary,
        workspaceSnapshot: extractAllModifiedFiles(progress),
      });
      progress.lastCheckpoint = lastCheckpoint;

      // Persist final progress
      await persistProgress(callbacks, goal, progress, language);

      const outcome = buildOutcome("completed", "Goal objective met", progress, lastCheckpoint);
      callbacks.onGoalIterationEnd(iteration);
      callbacks.onGoalOutcome(outcome);
      return outcome;
    }

    if (completionSignal.blocked) {
      iteration.unresolvedBlockers.push(completionSignal.blockerReason || "Unknown blocker");
    }

    callbacks.onGoalIterationEnd(iteration);

    // ── Create checkpoint if due ──
    if (shouldCreateCheckpoint(iteration.index, budget)) {
      lastCheckpoint = createGoalCheckpoint({
        iteration: iteration.index,
        completedTasks: extractCompletedTasks(progress),
        remainingTasks: extractRemainingTasks(agentResult.assistantText, language),
        currentPhase: "re_plan",
        contextSummary: buildCheckpointSummary(progress, language),
        workspaceSnapshot: extractAllModifiedFiles(progress),
        lastVerificationSummary: iteration.testsPassed !== null
          ? (iteration.testsPassed ? "Tests passed" : "Tests failed")
          : undefined,
      });
      progress.lastCheckpoint = lastCheckpoint;
      callbacks.onGoalCheckpointSaved(lastCheckpoint);

      callbacks.onDebugEvent?.("goal_checkpoint_saved", {
        iteration: iteration.index,
        completedTasks: lastCheckpoint.completedTasks.length,
        remainingTasks: lastCheckpoint.remainingTasks.length,
      });
    }

    // ── Persist progress ──
    await persistProgress(callbacks, goal, progress, language);

    // ── Notify UI ──
    callbacks.onGoalProgressUpdate(progress, goal);
  }

  // Should not normally reach here
  return buildOutcome(goal.status, "Goal loop exited", progress, lastCheckpoint);
}

// ── Helper functions ─────────────────────────────────────────────

function buildOutcome(
  status: GoalLoopOutcome["status"],
  reason: string,
  progress: GoalProgress,
  checkpoint: GoalCheckpoint | null,
): GoalLoopOutcome {
  return {
    status,
    reason,
    iterationsUsed: progress.totalIterationsUsed,
    finalCheckpoint: checkpoint,
  };
}

async function persistProgress(
  callbacks: GoalEngineCallbacks,
  goal: GoalDefinition,
  progress: GoalProgress,
  language: "zh" | "en",
): Promise<void> {
  try {
    const markdown = buildGoalProgressMarkdown({ goal, progress, language });
    await callbacks.writeFile(progress.progressFile, markdown);
  } catch (err) {
    callbacks.onDebugEvent?.("goal_persist_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function extractIterationSummary(assistantText: string, _language: "zh" | "en"): string {
  // Extract the first meaningful paragraph as a summary
  const lines = assistantText.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "(no summary)";

  // Skip lines that are just headers or tool markers
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("```")) continue;
    if (/^(?:GOAL_COMPLETED|GOAL_BLOCKED)/i.test(trimmed)) continue;
    // Return first substantive line, truncated
    return trimmed.length > 200 ? trimmed.slice(0, 200) + "..." : trimmed;
  }

  return lines[0].trim().slice(0, 200);
}

function extractCompletedTasks(progress: GoalProgress): string[] {
  const tasks: string[] = [];
  for (const iter of progress.iterations) {
    if (iter.summary && iter.endedAt) {
      tasks.push(`[Iteration ${iter.index}] ${iter.summary}`);
    }
  }
  return tasks.slice(-20); // Keep last 20
}

function extractRemainingTasks(assistantText: string, _language: "zh" | "en"): string[] {
  // Try to extract remaining tasks from the assistant's output
  const tasks: string[] = [];
  const lines = assistantText.split("\n");
  let inRemainingSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/(?:剩余|Remaining|TODO|Next|待完成|下一步)/i.test(trimmed) && /^#+\s/.test(trimmed)) {
      inRemainingSection = true;
      continue;
    }
    if (inRemainingSection) {
      if (/^#+\s/.test(trimmed)) break; // Hit next section
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        tasks.push(trimmed.slice(2).trim());
      }
    }
  }

  return tasks.slice(0, 20);
}

function buildCheckpointSummary(progress: GoalProgress, language: "zh" | "en"): string {
  const recentIterations = progress.iterations.slice(-3);
  const isZh = language === "zh";

  const summaries = recentIterations.map((iter) => {
    const files = iter.filesModified.length > 0
      ? ` (${isZh ? "修改" : "modified"}: ${iter.filesModified.join(", ")})`
      : "";
    return `${isZh ? "迭代" : "Iter"} ${iter.index}: ${iter.summary}${files}`;
  });

  return summaries.join("\n");
}

function extractAllModifiedFiles(progress: GoalProgress): string[] {
  const files = new Set<string>();
  for (const iter of progress.iterations) {
    for (const file of iter.filesModified) {
      files.add(file);
    }
  }
  return [...files].sort();
}
