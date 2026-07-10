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
  migrateGoalDefinition,
  type GoalRuntimeSnapshot,
  type GoalTurnContract,
} from "./goalState";
import type { GoalBudget } from "./goalBudget";
import {
  checkGoalBudget,
  resolveGoalBudget,
  shouldCreateCheckpoint,
} from "./goalBudget";
import {
  buildGoalTurnContract,
  detectGoalCompletionSignal,
  extractModifiedFilesFromToolCalls,
  extractTestCommandsFromToolCalls,
} from "./goalContextStrategy";
import {
  buildGoalProgressMarkdown,
  resolveGoalEvidenceFilePath,
  resolveGoalRuntimeProgressFilePath,
  resolveGoalRuntimeStateFilePath,
  serializeGoalEvidenceJsonl,
  serializeGoalRuntimeSnapshot,
} from "./goalPersistence";
import {
  buildGoalBudgetOverrides,
  buildGoalRuntimeSnapshot,
  createGoalEvidenceEntries,
  evaluateGoalCompletion,
  type GoalToolObservation,
} from "./goalRuntime";

// ── Goal Engine callbacks ────────────────────────────────────────

export interface GoalEngineCallbacks {
  /** Language preference */
  getPreferredLanguage: () => "zh" | "en";
  /** Workspace root path */
  getWorkspacePath: () => string;
  /** Run one iteration of the agent loop with given context */
  runAgentIteration: (input: {
    goalSystemContext: string;
    goalTurnContract: GoalTurnContract;
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
  /** Notify clients that the authoritative runtime snapshot changed. */
  onGoalRuntimeUpdate?: (runtime: GoalRuntimeSnapshot) => void;
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
  toolCalls: Array<GoalToolObservation & {
    name: string;
  }>;
  /** Estimated tokens used in this iteration */
  tokensUsed: number;
  /** Whether the iteration completed normally */
  completed: boolean;
  /** Exact inner-loop outcome; non-completed outcomes must not be auto-restarted. */
  outcomeStatus?: "completed" | "paused" | "stopped_no_action" | "stopped_no_output" | "aborted" | "error";
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
  const { callbacks, budgetOverrides, existingProgress } = input;
  const goal = migrateGoalDefinition(input.goal);
  const budget = resolveGoalBudget({
    ...buildGoalBudgetOverrides(goal),
    ...budgetOverrides,
  });
  const language = callbacks.getPreferredLanguage();
  const workspacePath = callbacks.getWorkspacePath();
  const progressFilePath = resolveGoalRuntimeProgressFilePath(workspacePath, goal.id);

  // Initialize or restore progress
  const progress: GoalProgress = existingProgress
    ? {
        ...existingProgress,
        iterations: [...(existingProgress.iterations || [])],
        evidence: [...(existingProgress.evidence || [])],
        milestones: [...(existingProgress.milestones || [])],
        usage: existingProgress.usage ? { ...existingProgress.usage, activeStartedAt: Date.now() } : undefined,
      }
    : createGoalProgress(goal.id, progressFilePath);

  if (!progress.usage) {
    progress.usage = {
      modelIterations: 0,
      toolCalls: 0,
      totalTokensUsed: progress.totalTokensUsed || 0,
      activeDurationMs: 0,
      activeStartedAt: Date.now(),
      estimatedTokens: progress.estimatedTokens === true,
    };
  }
  progress.progressFile = progressFilePath;

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
      progress.pauseReason = "User paused the goal";
      if (progress.usage?.activeStartedAt) {
        progress.usage.activeDurationMs += Math.max(0, Date.now() - progress.usage.activeStartedAt);
        progress.usage.activeStartedAt = null;
      }
      await persistProgress(callbacks, goal, progress, language);
      callbacks.onGoalProgressUpdate(progress, goal);
      emitRuntimeUpdate(callbacks, goal, progress, "re_plan", progress.pauseReason);
      const outcome = buildOutcome("paused", progress.pauseReason, progress, lastCheckpoint);
      callbacks.onGoalOutcome(outcome);
      return outcome;
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
          progress.pauseReason = budgetCheck.message;
          await persistProgress(callbacks, goal, progress, language);
          callbacks.onGoalProgressUpdate(progress, goal);
          emitRuntimeUpdate(callbacks, goal, progress, "re_plan", budgetCheck.message);
          const outcome = buildOutcome("paused", budgetCheck.message, progress, lastCheckpoint);
          callbacks.onGoalOutcome(outcome);
          return outcome;
        }
        // User confirmed — continue
        progress.lastUserConfirmedIteration = progress.totalIterationsUsed;
      } else if (budgetCheck.reason === "no_progress") {
        goal.status = "paused";
        progress.pauseReason = budgetCheck.message;
        await persistProgress(callbacks, goal, progress, language);
        callbacks.onGoalProgressUpdate(progress, goal);
        emitRuntimeUpdate(callbacks, goal, progress, "re_plan", budgetCheck.message);
        const outcome = buildOutcome("paused", budgetCheck.message, progress, lastCheckpoint);
        callbacks.onGoalOutcome(outcome);
        return outcome;
      } else {
        goal.status = "budget_exceeded";
        const outcome = buildOutcome("budget_exceeded", budgetCheck.message, progress, lastCheckpoint);
        await persistProgress(callbacks, goal, progress, language);
        callbacks.onGoalProgressUpdate(progress, goal);
        emitRuntimeUpdate(callbacks, goal, progress, null, budgetCheck.message);
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
    const goalTurnContract = buildGoalTurnContract({
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
        goalSystemContext: goalTurnContract.context,
        goalTurnContract,
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
        await persistProgress(callbacks, goal, progress, language);
        callbacks.onGoalProgressUpdate(progress, goal);
        emitRuntimeUpdate(callbacks, goal, progress, "execute", outcome.reason);
        callbacks.onGoalOutcome(outcome);
        return outcome;
      }
      await persistProgress(callbacks, goal, progress, language);
      callbacks.onGoalProgressUpdate(progress, goal);
      emitRuntimeUpdate(callbacks, goal, progress, "execute", errorMsg);
      continue;
    }

    // ── Extract observable evidence from tool results, not model claims ──
    iteration.phase = "observe";
    iteration.toolCallCount = agentResult.toolCalls.length;
    iteration.filesModified = extractModifiedFilesFromToolCalls(agentResult.toolCalls);
    iteration.testsRun = extractTestCommandsFromToolCalls(agentResult.toolCalls);
    iteration.summary = extractIterationSummary(agentResult.assistantText, language);
    iteration.endedAt = Date.now();

    const iterationEvidence = createGoalEvidenceEntries({
      goal,
      iteration: iteration.index,
      observations: agentResult.toolCalls,
    });
    progress.evidence = [...(progress.evidence || []), ...iterationEvidence];
    const testEvidence = iterationEvidence.filter((entry) => entry.kind === "test" || entry.kind === "build");
    iteration.testsPassed = testEvidence.length > 0
      ? testEvidence.every((entry) => entry.status === "passed")
      : null;

    const tokensUsed = Math.max(0, Math.floor(agentResult.tokensUsed || 0));
    progress.totalTokensUsed += tokensUsed;
    progress.estimatedTokens = true;
    progress.lastUpdatedAt = Date.now();
    progress.usage = {
      ...(progress.usage || {
        modelIterations: 0,
        toolCalls: 0,
        totalTokensUsed: 0,
        activeDurationMs: 0,
        activeStartedAt: Date.now(),
        estimatedTokens: true,
      }),
      modelIterations: (progress.usage?.modelIterations || 0) + 1,
      toolCalls: (progress.usage?.toolCalls || 0) + agentResult.toolCalls.length,
      totalTokensUsed: progress.totalTokensUsed,
      estimatedTokens: true,
    };

    if (iterationEvidence.length === 0) consecutiveNoProgressCount += 1;
    else consecutiveNoProgressCount = 0;

    const completionSignal = detectGoalCompletionSignal(agentResult.assistantText);
    if (completionSignal.blocked) {
      iteration.unresolvedBlockers.push(completionSignal.blockerReason || "Unknown blocker");
    }

    // Inner-loop pauses and errors are terminal for this Goal slice. The outer
    // runtime must not silently restart them as a new autonomous iteration.
    if (agentResult.outcomeStatus && agentResult.outcomeStatus !== "completed") {
      const innerReason = agentResult.error || `Agent loop ended with ${agentResult.outcomeStatus}`;
      if (agentResult.outcomeStatus === "error") {
        iteration.unresolvedBlockers.push(innerReason);
      }
      goal.status = "paused";
      progress.pauseReason = innerReason;
      lastCheckpoint = createCheckpointFromRuntime({
        goal,
        progress,
        iteration,
        remainingTasks: extractRemainingTasks(agentResult.assistantText, language),
        language,
      });
      progress.lastCheckpoint = lastCheckpoint;
      callbacks.onGoalCheckpointSaved(lastCheckpoint);
      callbacks.onGoalIterationEnd(iteration);
      await persistProgress(callbacks, goal, progress, language);
      callbacks.onGoalProgressUpdate(progress, goal);
      emitRuntimeUpdate(callbacks, goal, progress, "re_plan", innerReason);
      const outcome = buildOutcome("paused", innerReason, progress, lastCheckpoint);
      callbacks.onGoalOutcome(outcome);
      return outcome;
    }

    const completionGate = evaluateGoalCompletion({
      goal,
      evidence: progress.evidence || [],
      completionCandidate: completionSignal.completed,
      unresolvedBlockers: iteration.unresolvedBlockers,
    });
    if (completionSignal.completed && !completionGate.passed) {
      callbacks.onDebugEvent?.("goal_completion_rejected", {
        iteration: iteration.index,
        reasons: completionGate.reasons,
        evidenceCount: progress.evidence?.length || 0,
      });
    }

    if (completionGate.passed) {
      goal.criteria = completionGate.criteria;
      goal.status = "completed";
      goal.updatedAt = Date.now();
      lastCheckpoint = createCheckpointFromRuntime({
        goal,
        progress,
        iteration,
        remainingTasks: [],
        language,
      });
      progress.lastCheckpoint = lastCheckpoint;
      callbacks.onGoalIterationEnd(iteration);
      callbacks.onGoalCheckpointSaved(lastCheckpoint);
      await persistProgress(callbacks, goal, progress, language);
      callbacks.onGoalProgressUpdate(progress, goal);
      emitRuntimeUpdate(callbacks, goal, progress, "observe");
      const outcome = buildOutcome("completed", "Goal completion evidence gate passed", progress, lastCheckpoint);
      callbacks.onGoalOutcome(outcome);
      return outcome;
    }

    callbacks.onGoalIterationEnd(iteration);

    // Keep a lightweight continuation checkpoint after every bounded slice so
    // the next fresh context never loses the most recent work. Checkpoint
    // events remain interval-based to avoid noisy UI/runtime telemetry.
    lastCheckpoint = createCheckpointFromRuntime({
      goal,
      progress,
      iteration: { ...iteration, phase: "re_plan" },
      remainingTasks: extractRemainingTasks(agentResult.assistantText, language),
      language,
    });
    progress.lastCheckpoint = lastCheckpoint;

    if (shouldCreateCheckpoint(iteration.index, budget)) {
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
    emitRuntimeUpdate(callbacks, goal, progress, "re_plan");
  }

  // Should not normally reach here
  return buildOutcome(goal.status, "Goal loop exited", progress, lastCheckpoint);
}

// ── Helper functions ─────────────────────────────────────────────

function createCheckpointFromRuntime(input: {
  goal: GoalDefinition;
  progress: GoalProgress;
  iteration: GoalIteration;
  remainingTasks: string[];
  language: "zh" | "en";
}): GoalCheckpoint {
  return createGoalCheckpoint({
    iteration: input.iteration.index,
    completedTasks: extractCompletedTasks(input.progress),
    remainingTasks: input.remainingTasks,
    currentPhase: input.iteration.phase,
    contextSummary: buildCheckpointSummary(input.progress, input.language),
    workspaceSnapshot: extractAllModifiedFiles(input.progress),
    lastVerificationSummary: input.iteration.testsPassed === null
      ? undefined
      : input.iteration.testsPassed ? "Tests passed" : "Tests failed",
    goalRevision: input.goal.revision,
    evidenceCursor: input.progress.evidence?.length || 0,
  });
}

function emitRuntimeUpdate(
  callbacks: GoalEngineCallbacks,
  goal: GoalDefinition,
  progress: GoalProgress,
  phase: GoalIteration["phase"] | null,
  pauseReason?: string,
): void {
  callbacks.onGoalRuntimeUpdate?.(buildGoalRuntimeSnapshot({
    goal,
    progress,
    phase,
    pauseReason,
  }));
}

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
    if (goal.status !== "active" && progress.usage?.activeStartedAt) {
      progress.usage.activeDurationMs += Math.max(0, Date.now() - progress.usage.activeStartedAt);
      progress.usage.activeStartedAt = null;
    }
    const markdown = buildGoalProgressMarkdown({ goal, progress, language });
    await callbacks.writeFile(progress.progressFile, markdown);
    const runtimeSnapshot = buildGoalRuntimeSnapshot({
      goal,
      progress,
      phase: progress.iterations[progress.iterations.length - 1]?.phase || null,
      pauseReason: progress.pauseReason,
    });
    const workspacePath = callbacks.getWorkspacePath();
    await callbacks.writeFile(
      resolveGoalRuntimeStateFilePath(workspacePath, goal.id),
      serializeGoalRuntimeSnapshot(runtimeSnapshot),
    );
    await callbacks.writeFile(
      resolveGoalEvidenceFilePath(workspacePath, goal.id),
      serializeGoalEvidenceJsonl(progress),
    );
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
    const hasSuccessfulEvidence = (progress.evidence || []).some(
      (entry) => entry.iteration === iter.index && entry.status !== "failed" && entry.kind !== "blocker" && entry.kind !== "read",
    );
    if (iter.summary && iter.endedAt && hasSuccessfulEvidence && iter.unresolvedBlockers.length === 0) {
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
