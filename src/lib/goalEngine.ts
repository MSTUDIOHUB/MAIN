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
  GoalIterationUsage,
  GoalStopClass,
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
  assignGoalEvidenceCriterionIds,
  type GoalToolObservation,
} from "./goalRuntime";
import { isGoalEvidenceMeaningfulProgress } from "./goalToolCapabilities";
import {
  GOAL_RECOVERY_BLOCK_THRESHOLD,
  advanceGoalRecoveryState,
  goalStatusForOutcomeAction,
  normalizeGoalRecoveryCause,
  resolveGoalInnerOutcomeDecision,
} from "./goalOutcomePolicy";

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
    goalSliceId: string;
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
  /** Exact stop reason returned by the inner agent loop. */
  stopReason?: string;
  /** True only for the expected inner max-iterations slice boundary. */
  sliceBoundaryReached?: boolean;
  /** Actual inner model/tool counters; token estimates remain explicitly marked. */
  usage?: GoalIterationUsage;
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

  if (goal.migrationReviewRequired) {
    const reason = "goal_definition_migrated_review_required";
    goal.status = "paused";
    progress.pauseReason = reason;
    progress.lastStopReason = reason;
    progress.stopClass = "migration_review_required";
    await persistProgress(callbacks, goal, progress, language);
    callbacks.onGoalProgressUpdate(progress, goal);
    emitRuntimeUpdate(callbacks, goal, progress, "re_plan", reason);
    callbacks.onDebugEvent?.("goal_migration_review_required", {
      goalId: goal.id,
      revision: goal.revision || 1,
      reason,
    });
    const outcome = buildOutcome("paused", reason, progress, lastCheckpoint);
    callbacks.onGoalOutcome(outcome);
    return outcome;
  }

  if (goal.criteriaReviewRequired) {
    const reason = "goal_criteria_clarification_required";
    await callbacks.onGoalUserConfirmNeeded(reason);
    goal.status = "awaiting_input";
    progress.pauseReason = reason;
    progress.lastStopReason = reason;
    progress.stopClass = "awaiting_input";
    await persistProgress(callbacks, goal, progress, language);
    callbacks.onGoalProgressUpdate(progress, goal);
    emitRuntimeUpdate(callbacks, goal, progress, "re_plan", reason);
    callbacks.onDebugEvent?.("goal_criteria_review_required", {
      goalId: goal.id,
      revision: goal.revision || 1,
      objective: goal.objective,
      reason,
    });
    const outcome = buildOutcome("awaiting_input", reason, progress, lastCheckpoint);
    callbacks.onGoalOutcome(outcome);
    return outcome;
  }

  callbacks.onDebugEvent?.("goal_loop_start", {
    goalId: goal.id,
    goalSliceId: `${goal.id}:slice:${progress.totalIterationsUsed + 1}`,
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
      progress.lastStopReason = progress.pauseReason;
      progress.stopClass = "user_paused";
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
    const recoveryAuditStartIteration = progress.recoveryAuditStartIteration || 0;
    const recentIterations = progress.iterations
      .filter((candidate) =>
        candidate.index > recoveryAuditStartIteration &&
        (candidate.goalRevision || 1) === (goal.revision || 1)
      )
      .slice(-budget.maxNoProgressIterations);
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
          goal.status = "awaiting_input";
          progress.pauseReason = budgetCheck.message;
          progress.lastStopReason = "user_confirm_needed";
          progress.stopClass = "awaiting_input";
          await persistProgress(callbacks, goal, progress, language);
          callbacks.onGoalProgressUpdate(progress, goal);
          emitRuntimeUpdate(callbacks, goal, progress, "re_plan", budgetCheck.message);
          const outcome = buildOutcome("awaiting_input", budgetCheck.message, progress, lastCheckpoint);
          callbacks.onGoalOutcome(outcome);
          return outcome;
        }
        // User confirmed — continue
        progress.lastUserConfirmedIteration = progress.totalIterationsUsed;
      } else if (budgetCheck.reason === "no_progress") {
        goal.status = "blocked";
        progress.pauseReason = budgetCheck.message;
        progress.lastStopReason = "no_progress";
        progress.stopClass = "blocked";
        progress.recoveryState = advanceGoalRecoveryState({
          previous: progress.recoveryState,
          normalizedCause: "no_progress",
          reason: budgetCheck.message,
        });
        await persistProgress(callbacks, goal, progress, language);
        callbacks.onGoalProgressUpdate(progress, goal);
        emitRuntimeUpdate(callbacks, goal, progress, "re_plan", budgetCheck.message);
        const outcome = buildOutcome("blocked", budgetCheck.message, progress, lastCheckpoint);
        callbacks.onGoalOutcome(outcome);
        return outcome;
      } else {
        // A total budget boundary is resumable after the user adjusts limits;
        // it must not masquerade as completion or an unrecoverable failure.
        goal.status = "paused";
        progress.pauseReason = budgetCheck.message;
        progress.lastStopReason = budgetCheck.reason;
        progress.stopClass = goalStopClassForBudgetReason(budgetCheck.reason);
        const outcome = buildOutcome("paused", budgetCheck.message, progress, lastCheckpoint);
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

    const iteration = createGoalIteration(progress.currentIteration, goal.id, goal.revision || 1);
    progress.iterations.push(iteration);

    callbacks.onGoalIterationStart(iteration);
    callbacks.onDebugEvent?.("goal_iteration_start", {
      iteration: iteration.index,
      goalSliceId: iteration.goalSliceId,
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
      evidence: progress.evidence || [],
    });

    // ── Execute one agent iteration ──
    let agentResult: GoalAgentIterationResult;
    try {
      agentResult = await callbacks.runAgentIteration({
        goalSystemContext: goalTurnContract.context,
        goalTurnContract,
        goalSliceId: goalTurnContract.goalSliceId,
        iteration: progress.currentIteration,
        maxIterations: budget.maxIterations,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const reportedFailureUsage = (err as { goalIterationUsage?: Partial<GoalIterationUsage> } | null)?.goalIterationUsage;
      const failureUsage: GoalIterationUsage = {
        // The bounded slice was invoked, so a thrown request must never vanish
        // from accounting even when its provider did not return token usage.
        modelIterations: Math.max(1, Math.floor(Number(reportedFailureUsage?.modelIterations) || 0)),
        toolCalls: Math.max(0, Math.floor(Number(reportedFailureUsage?.toolCalls) || 0)),
        tokensUsed: Math.max(0, Math.floor(Number(reportedFailureUsage?.tokensUsed) || 0)),
        estimatedTokens: reportedFailureUsage?.estimatedTokens !== false,
      };
      iteration.phase = "execute";
      iteration.endedAt = Date.now();
      iteration.summary = `Error: ${errorMsg.slice(0, 200)}`;
      iteration.innerOutcomeStatus = "error";
      iteration.stopReason = errorMsg;
      iteration.stopClass = "recoverable_error";
      iteration.usage = failureUsage;
      progress.lastStopReason = errorMsg;
      progress.totalTokensUsed += failureUsage.tokensUsed;
      progress.estimatedTokens = progress.estimatedTokens === true || failureUsage.estimatedTokens;
      progress.usage = {
        ...(progress.usage || {
          modelIterations: 0,
          toolCalls: 0,
          totalTokensUsed: progress.totalTokensUsed || 0,
          activeDurationMs: 0,
          activeStartedAt: Date.now(),
          estimatedTokens: true,
        }),
        modelIterations: (progress.usage?.modelIterations || 0) + failureUsage.modelIterations,
        toolCalls: (progress.usage?.toolCalls || 0) + failureUsage.toolCalls,
        totalTokensUsed: progress.totalTokensUsed,
        estimatedTokens: progress.estimatedTokens === true,
      };

      const decision = resolveGoalInnerOutcomeDecision({
        status: "error",
        stopReason: errorMsg,
        isAborted: callbacks.isAborted(),
      });
      let stopStatus = goalStatusForOutcomeAction(decision.action);
      if (decision.action === "recover") {
        progress.recoveryState = advanceGoalRecoveryState({
          previous: progress.recoveryState,
          normalizedCause: decision.normalizedCause || normalizeGoalRecoveryCause("exception", errorMsg),
          reason: errorMsg,
        });
        if (progress.recoveryState.consecutiveCount >= GOAL_RECOVERY_BLOCK_THRESHOLD) {
          stopStatus = "blocked";
        }
      }
      if (stopStatus) {
        goal.status = stopStatus;
        progress.pauseReason = errorMsg;
        progress.stopClass = stopStatus === "failed"
          ? "unrecoverable_error"
          : stopStatus === "blocked"
            ? "blocked"
            : stopStatus === "awaiting_input"
              ? "awaiting_input"
              : "user_paused";
        iteration.stopClass = progress.stopClass;
        iteration.unresolvedBlockers.push(`Agent iteration error: ${errorMsg}`);
      }
      const remainingTasks = lastCheckpoint?.remainingTasks || [];
      lastCheckpoint = createCheckpointFromRuntime({
        goal,
        progress,
        iteration: { ...iteration, phase: "re_plan" },
        remainingTasks,
        language,
      });
      progress.lastCheckpoint = lastCheckpoint;
      if (stopStatus || shouldCreateCheckpoint(iteration.index, budget)) {
        callbacks.onGoalCheckpointSaved(lastCheckpoint);
      }

      callbacks.onGoalIterationEnd(iteration);
      callbacks.onDebugEvent?.("goal_iteration_error", {
        iteration: iteration.index,
        goalSliceId: iteration.goalSliceId,
        error: errorMsg.slice(0, 500),
        action: decision.action,
        normalizedCause: decision.normalizedCause || null,
        consecutiveCount: progress.recoveryState?.consecutiveCount || 0,
        usage: failureUsage,
      });
      await persistProgress(callbacks, goal, progress, language);
      callbacks.onGoalProgressUpdate(progress, goal);
      emitRuntimeUpdate(callbacks, goal, progress, stopStatus ? "execute" : "re_plan", stopStatus ? errorMsg : undefined);
      if (stopStatus) {
        const outcome = buildOutcome(stopStatus, errorMsg, progress, lastCheckpoint);
        callbacks.onGoalOutcome(outcome);
        return outcome;
      }
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
    progress.evidence = assignGoalEvidenceCriterionIds(
      goal,
      [...(progress.evidence || []), ...iterationEvidence],
    );
    const testEvidence = iterationEvidence.filter((entry) => entry.kind === "test" || entry.kind === "build");
    iteration.testsPassed = testEvidence.length > 0
      ? testEvidence.every((entry) => entry.status === "passed")
      : null;

    const reportedUsage = agentResult.usage;
    const normalizedUsage: GoalIterationUsage = {
      modelIterations: Math.max(0, Math.floor(Number(reportedUsage?.modelIterations ?? 1) || 0)),
      toolCalls: Math.max(0, Math.floor(Number(reportedUsage?.toolCalls ?? agentResult.toolCalls.length) || 0)),
      tokensUsed: Math.max(0, Math.floor(Number(reportedUsage?.tokensUsed ?? agentResult.tokensUsed) || 0)),
      estimatedTokens: reportedUsage?.estimatedTokens !== false,
    };
    iteration.usage = normalizedUsage;
    iteration.innerOutcomeStatus = agentResult.outcomeStatus;
    iteration.stopReason = agentResult.stopReason
      || agentResult.error
      || (agentResult.outcomeStatus === "completed" ? "agent_loop_completed" : agentResult.outcomeStatus);
    progress.lastStopReason = iteration.stopReason;
    const tokensUsed = normalizedUsage.tokensUsed;
    progress.totalTokensUsed += tokensUsed;
    progress.estimatedTokens = progress.estimatedTokens === true || normalizedUsage.estimatedTokens;
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
      modelIterations: (progress.usage?.modelIterations || 0) + normalizedUsage.modelIterations,
      toolCalls: (progress.usage?.toolCalls || 0) + normalizedUsage.toolCalls,
      totalTokensUsed: progress.totalTokensUsed,
      estimatedTokens: progress.estimatedTokens === true,
    };

    const hasMeaningfulEvidence = iterationEvidence.some(isGoalEvidenceMeaningfulProgress);

    callbacks.onDebugEvent?.("goal_slice_outcome", {
      goalSliceId: goalTurnContract.goalSliceId,
      iteration: iteration.index,
      outcomeStatus: agentResult.outcomeStatus || (agentResult.completed ? "completed" : "unknown"),
      stopReason: iteration.stopReason || null,
      sliceBoundaryReached: agentResult.sliceBoundaryReached === true,
      usage: normalizedUsage,
      evidenceCount: iterationEvidence.length,
    });

    const completionSignal = detectGoalCompletionSignal(agentResult.assistantText);
    const autoNextSlice = agentResult.sliceBoundaryReached === true
      || iteration.stopReason === "max_iterations_boundary";
    const effectiveStopReason = completionSignal.blocked
      ? completionSignal.blockerReason || "goal_blocked_without_reason"
      : iteration.stopReason || agentResult.error || agentResult.outcomeStatus || "agent_loop_completed";
    const innerDecision = resolveGoalInnerOutcomeDecision({
      status: completionSignal.blocked ? "stopped_no_action" : agentResult.outcomeStatus,
      stopReason: effectiveStopReason,
      sliceBoundaryReached: autoNextSlice,
      isAborted: callbacks.isAborted(),
    });
    const immediateStopStatus = goalStatusForOutcomeAction(innerDecision.action);
    if (immediateStopStatus) {
      goal.status = immediateStopStatus;
      progress.pauseReason = effectiveStopReason;
      progress.lastStopReason = effectiveStopReason;
      progress.stopClass = immediateStopStatus === "failed"
        ? "unrecoverable_error"
        : immediateStopStatus === "awaiting_input"
          ? "awaiting_input"
          : "user_paused";
      iteration.stopClass = progress.stopClass;
      iteration.unresolvedBlockers.push(effectiveStopReason);
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
      emitRuntimeUpdate(
        callbacks,
        goal,
        progress,
        immediateStopStatus === "failed" ? "execute" : "re_plan",
        effectiveStopReason,
      );
      const outcome = buildOutcome(immediateStopStatus, effectiveStopReason, progress, lastCheckpoint);
      callbacks.onGoalOutcome(outcome);
      return outcome;
    }

    if (autoNextSlice) {
      iteration.stopClass = "slice_budget_exhausted";
      progress.stopClass = "slice_budget_exhausted";
      callbacks.onDebugEvent?.("goal_slice_auto_next", {
        goalSliceId: goalTurnContract.goalSliceId,
        iteration: iteration.index,
        stopReason: iteration.stopReason,
        nextGoalSliceId: `${goal.id}:slice:${iteration.index + 1}`,
      });
    }

    // A model marker is useful, but it cannot be the sole way to terminate a
    // Goal. The runtime owns terminal state from the evidence ledger and exact
    // criteria, so a local provider's missing final marker cannot force more
    // work after the task is already proven complete.
    let completionCandidate = resolveGoalCompletionCandidate({
      completionSignal,
      agentResult,
      innerDecision,
    });
    let completionGate = evaluateGoalCompletion({
      goal,
      evidence: progress.evidence || [],
      completionCandidate: completionCandidate.accepted,
      unresolvedBlockers: iteration.unresolvedBlockers,
    });
    // Some providers report an otherwise recoverable no-action/no-output stop
    // after successful tools. If all hard completion criteria are already
    // satisfied, the evidence gate is sufficient to settle that cleanly. This
    // cannot override user input, pause, abort, or provider-error states.
    if (!completionCandidate.accepted && canSettleGoalFromRuntimeEvidence({
      completionSignal,
      agentResult,
    })) {
      const evidenceOnlyGate = evaluateGoalCompletion({
        goal,
        evidence: progress.evidence || [],
        completionCandidate: true,
        unresolvedBlockers: iteration.unresolvedBlockers,
      });
      if (evidenceOnlyGate.passed) {
        completionCandidate = { accepted: true, source: "runtime_evidence" };
        completionGate = evidenceOnlyGate;
      } else {
        callbacks.onDebugEvent?.("goal_runtime_evidence_completion_rejected", {
          iteration: iteration.index,
          goalSliceId: goalTurnContract.goalSliceId,
          outcomeStatus: agentResult.outcomeStatus || (agentResult.completed ? "completed" : "unknown"),
          reasons: evidenceOnlyGate.reasons,
          evidenceCount: progress.evidence?.length || 0,
        });
      }
    }
    goal.criteria = completionGate.criteria;
    if (completionCandidate.source === "runtime_evidence") {
      callbacks.onDebugEvent?.("goal_runtime_evidence_completion_candidate", {
        iteration: iteration.index,
        goalSliceId: goalTurnContract.goalSliceId,
        outcomeStatus: agentResult.outcomeStatus || (agentResult.completed ? "completed" : "unknown"),
        stopReason: effectiveStopReason,
        sliceBoundaryReached: autoNextSlice,
        evidenceCount: progress.evidence?.length || 0,
      });
    }
    if (completionCandidate.accepted && !completionGate.passed) {
      // Preserve the ordinary slice-boundary status when completion was
      // runtime-nominated. A missing marker must not turn a normal bounded
      // continuation into a misleading evidence pause. Explicit model claims
      // still receive the more precise evidence_missing stop class.
      if (completionCandidate.source === "model_marker") {
        iteration.stopClass = "evidence_missing";
        progress.stopClass = "evidence_missing";
      }
      callbacks.onDebugEvent?.("goal_completion_rejected", {
        iteration: iteration.index,
        goalSliceId: goalTurnContract.goalSliceId,
        candidateSource: completionCandidate.source,
        reasons: completionGate.reasons,
        evidenceCount: progress.evidence?.length || 0,
      });
    }

    if (completionGate.passed) {
      goal.status = "completed";
      iteration.stopClass = "completed";
      progress.stopClass = "completed";
      progress.recoveryState = undefined;
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
      callbacks.onDebugEvent?.("goal_completion_accepted", {
        iteration: iteration.index,
        goalSliceId: goalTurnContract.goalSliceId,
        candidateSource: completionCandidate.source,
        supportingEvidenceIds: completionGate.supportingEvidenceIds,
      });
      const outcome = buildOutcome("completed", "Goal completion evidence gate passed", progress, lastCheckpoint);
      callbacks.onGoalOutcome(outcome);
      return outcome;
    }

    const recoveryCause = innerDecision.action === "recover"
      ? innerDecision.normalizedCause || normalizeGoalRecoveryCause(
          agentResult.outcomeStatus || "stopped_no_action",
          effectiveStopReason,
        )
      : !hasMeaningfulEvidence
        ? "no_progress"
        : null;
    if (recoveryCause) {
      const recoveryReason = recoveryCause === "no_progress" ? "no_progress" : effectiveStopReason;
      progress.recoveryState = advanceGoalRecoveryState({
        previous: progress.recoveryState,
        normalizedCause: recoveryCause,
        reason: recoveryReason,
      });
      const recoveryStopClass: GoalStopClass = recoveryCause === "no_progress"
        ? "no_progress"
        : "recoverable_error";
      if (!autoNextSlice) {
        iteration.stopClass = recoveryStopClass;
        progress.stopClass = recoveryStopClass;
      }
      callbacks.onDebugEvent?.("goal_recovery_state_updated", {
        goalSliceId: goalTurnContract.goalSliceId,
        normalizedCause: recoveryCause,
        consecutiveCount: progress.recoveryState.consecutiveCount,
        stopReason: recoveryReason,
      });
      if (progress.recoveryState.consecutiveCount >= GOAL_RECOVERY_BLOCK_THRESHOLD) {
        const blockedReason = progress.recoveryState.lastReason;
        goal.status = "blocked";
        progress.pauseReason = blockedReason;
        progress.lastStopReason = blockedReason;
        progress.stopClass = "blocked";
        iteration.stopClass = "blocked";
        iteration.unresolvedBlockers.push(blockedReason);
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
        emitRuntimeUpdate(callbacks, goal, progress, "re_plan", blockedReason);
        const outcome = buildOutcome("blocked", blockedReason, progress, lastCheckpoint);
        callbacks.onGoalOutcome(outcome);
        return outcome;
      }
    } else {
      progress.recoveryState = undefined;
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
        goalSliceId: goalTurnContract.goalSliceId,
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
    usage: progress.usage ? { ...progress.usage } : undefined,
    lastStopReason: progress.lastStopReason,
    stopClass: progress.stopClass,
  };
}

function resolveGoalCompletionCandidate(input: {
  completionSignal: ReturnType<typeof detectGoalCompletionSignal>;
  agentResult: GoalAgentIterationResult;
  innerDecision: ReturnType<typeof resolveGoalInnerOutcomeDecision>;
}): { accepted: boolean; source: "model_marker" | "runtime_evidence" | "none" } {
  if (input.completionSignal.completed && input.innerDecision.action === "continue") {
    return { accepted: true, source: "model_marker" };
  }

  // A normal inner completion and the expected bounded slice boundary are
  // clean terminal points. A stopped_no_action result can also be a normal
  // provider-side handoff after real tool work (especially with local models
  // that omit the final marker); let the evidence gate decide that narrow
  // case. Pauses, input requests, stream failures, blocked states, and other
  // recovery errors keep their explicit paths above.
  const reachedCleanBoundary = input.innerDecision.action === "continue" && (
    input.agentResult.completed === true
    || input.agentResult.outcomeStatus === "completed"
    || input.agentResult.sliceBoundaryReached === true
  );
  const toolBackedNoAction = input.agentResult.outcomeStatus === "stopped_no_action"
    && input.agentResult.toolCalls.length > 0;
  return reachedCleanBoundary || toolBackedNoAction
    ? { accepted: true, source: "runtime_evidence" }
    : { accepted: false, source: "none" };
}

function canSettleGoalFromRuntimeEvidence(input: {
  completionSignal: ReturnType<typeof detectGoalCompletionSignal>;
  agentResult: GoalAgentIterationResult;
}): boolean {
  if (input.completionSignal.blocked) return false;
  // Explicit user-control and provider-error outcomes have already been
  // handled above or need their own recovery path. A stopped_no_action or
  // stopped_no_output result is allowed here only when the evidence gate can
  // independently prove every required criterion.
  return input.agentResult.outcomeStatus !== "paused"
    && input.agentResult.outcomeStatus !== "aborted"
    && input.agentResult.outcomeStatus !== "error";
}

function goalStopClassForBudgetReason(
  reason: "iteration_limit" | "token_limit" | "tool_call_limit" | "duration_limit",
): GoalStopClass {
  if (reason === "token_limit") return "token_budget_exhausted";
  if (reason === "tool_call_limit") return "tool_call_budget_exhausted";
  if (reason === "duration_limit") return "duration_budget_exhausted";
  return "total_slice_budget_exhausted";
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
      (entry) => entry.iteration === iter.index && isGoalEvidenceMeaningfulProgress(entry),
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
