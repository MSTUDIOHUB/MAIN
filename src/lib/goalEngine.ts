// lib/goalEngine.ts
// Core Goal Engine for MAIN's persistent Goal Mode.
//
// Architecture:
//   The Goal Engine is a HIGHER-LEVEL loop that wraps the existing
//   AgentOrchestrator. Internal continuations share one logical turn and retain
//   recent messages; checkpoints and evidence provide durable recovery.
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
  GoalContinuationState,
  GoalEvidenceEntry,
} from "./goalState";
import {
  createGoalCheckpoint,
  createGoalIteration,
  createGoalProgress,
  isGoalTerminal,
  migrateGoalDefinition,
  normalizeGoalCriteria,
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
  isGoalRuntimeDeleted,
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
import {
  compactGoalAssistantContext,
  extractGoalAssistantSummary,
} from "./goalContinuity";
import { resolveSubagentDelegationPreference } from "./turnIntake";

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
    /** Retained exact recent messages plus durable memory from the same Goal task. */
    continuation: GoalContinuationState | null;
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
  /** Updated retained conversation for the next internal continuation or resume. */
  continuation?: GoalContinuationState;
}

// ── Main entry point ─────────────────────────────────────────────

export async function executeGoalLoop(input: {
  goal: GoalDefinition;
  callbacks: GoalEngineCallbacks;
  budgetOverrides?: Partial<GoalBudget>;
  existingProgress?: GoalProgress | null;
  /** One-shot guidance supplied while resuming the same logical Goal. */
  userGuidance?: string;
}): Promise<GoalLoopOutcome> {
  const { callbacks, budgetOverrides, existingProgress } = input;
  const goal = migrateGoalDefinition(input.goal);
  const budget = resolveGoalBudget({
    ...buildGoalBudgetOverrides(goal),
    ...budgetOverrides,
  });
  const language = callbacks.getPreferredLanguage();
  const workspacePath = callbacks.getWorkspacePath();
  const subagentPreference = resolveSubagentDelegationPreference(goal.objective);
  const progressFilePath = resolveGoalRuntimeProgressFilePath(workspacePath, goal.id);

  // Initialize or restore progress
  const progress: GoalProgress = existingProgress
    ? {
        ...existingProgress,
        iterations: [...(existingProgress.iterations || [])],
        evidence: [...(existingProgress.evidence || [])],
        milestones: [...(existingProgress.milestones || [])],
        continuation: existingProgress.continuation
          ? {
              ...existingProgress.continuation,
              messages: [...(existingProgress.continuation.messages || [])],
            }
          : undefined,
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
  let pendingUserGuidance = String(input.userGuidance || "").trim();

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

  if (
    existingProgress &&
    pendingUserGuidance &&
    (goal.status === "awaiting_input" || goal.status === "paused")
  ) {
    const previousStatus = goal.status;
    goal.status = "active";
    progress.pauseReason = undefined;
    if (progress.stopClass === "awaiting_input" || progress.stopClass === "user_paused") {
      progress.stopClass = undefined;
      progress.lastStopReason = undefined;
    }
    callbacks.onDebugEvent?.("goal_continuation_guidance_applied", {
      goalId: goal.id,
      previousStatus,
      guidanceChars: pendingUserGuidance.length,
      retainedMessages: progress.continuation?.messages.length || 0,
      retainedOperations: progress.continuation?.operationCount || 0,
      retainedEvidence: progress.evidence?.length || 0,
    });
  }

  callbacks.onDebugEvent?.("goal_loop_start", {
    goalId: goal.id,
    continuationId: `${goal.id}:slice:${progress.totalIterationsUsed + 1}`,
    objective: goal.objective.slice(0, 200),
    budget: {
      emergencyContinuationLimit: budget.maxIterations,
      maxDurationMs: budget.maxDurationMs,
      maxToolCalls: budget.maxToolCalls,
      maxTokens: budget.maxTokens,
    },
    resuming: !!existingProgress,
    retainedContinuations: progress.totalIterationsUsed,
    retainedMessages: progress.continuation?.messages.length || 0,
    retainedOperations: progress.continuation?.operationCount || 0,
    memoryChars: progress.continuation?.memoryPacket?.length || 0,
    subagentPreference,
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

    // ── Start an internal continuation boundary ──
    progress.totalIterationsUsed += 1;
    progress.currentIteration = progress.totalIterationsUsed;

    const iteration = createGoalIteration(progress.currentIteration, goal.id, goal.revision || 1);
    progress.iterations.push(iteration);

    callbacks.onGoalIterationStart(iteration);
    callbacks.onDebugEvent?.("goal_continuation_start", {
      continuation: iteration.index,
      continuationId: iteration.goalSliceId,
      phase: iteration.phase,
      emergencyContinuationLimit: budget.maxIterations,
      retainedMessages: progress.continuation?.messages.length || 0,
      retainedOperations: progress.continuation?.operationCount || 0,
      memoryChars: progress.continuation?.memoryPacket?.length || 0,
    });

    // ── Build the updated contract without discarding retained messages ──
    const continuationGuidance = pendingUserGuidance || undefined;
    const goalTurnContract = buildGoalTurnContract({
      goal,
      checkpoint: lastCheckpoint,
      latestVerification: lastVerificationResult,
      nextIteration: progress.currentIteration,
      language,
      evidence: progress.evidence || [],
      // Exact recent messages are already replayed. Add compact memory only
      // after older transcript content has actually left that exact window.
      continuationMemory: progress.continuation?.compacted
        ? progress.continuation.memoryPacket
        : undefined,
      userGuidance: continuationGuidance,
    });
    pendingUserGuidance = "";

    // ── Execute one agent iteration ──
    let agentResult: GoalAgentIterationResult;
    try {
      agentResult = await callbacks.runAgentIteration({
        goalSystemContext: goalTurnContract.context,
        goalTurnContract,
        goalSliceId: goalTurnContract.goalSliceId,
        iteration: progress.currentIteration,
        maxIterations: budget.maxIterations,
        continuation: progress.continuation || null,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const reportedFailure = err as {
        goalIterationUsage?: Partial<GoalIterationUsage>;
        goalContinuationState?: GoalContinuationState;
      } | null;
      const reportedFailureUsage = reportedFailure?.goalIterationUsage;
      if (reportedFailure?.goalContinuationState) {
        progress.continuation = reportedFailure.goalContinuationState;
      }
      const failureUsage: GoalIterationUsage = {
        // The continuation was invoked, so a thrown request must never vanish
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
      const remainingTasks = resolveRemainingTasks({
        goal,
        assistantText: iteration.summary,
        previous: lastCheckpoint?.remainingTasks || [],
      });
      lastCheckpoint = createCheckpointFromRuntime({
        goal,
        progress,
        iteration: { ...iteration, phase: "re_plan" },
        remainingTasks,
        language,
        assistantText: iteration.summary,
      });
      progress.lastCheckpoint = lastCheckpoint;
      if (stopStatus || shouldCreateCheckpoint(iteration.index, budget)) {
        callbacks.onGoalCheckpointSaved(lastCheckpoint);
      }

      callbacks.onGoalIterationEnd(iteration);
      callbacks.onDebugEvent?.("goal_continuation_error", {
        continuation: iteration.index,
        continuationId: iteration.goalSliceId,
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
    iteration.summary = "";
    iteration.endedAt = Date.now();

    const iterationEvidence = createGoalEvidenceEntries({
      goal,
      iteration: iteration.index,
      observations: agentResult.toolCalls,
    });
    if (
      iteration.index === 1 &&
      subagentPreference === "preferred" &&
      !agentResult.toolCalls.some((call) => call.name === "spawn_subagent")
    ) {
      callbacks.onDebugEvent?.("delegation_scope_decision", {
        decision: "skipped",
        reason: "preferred_parallelism_not_used_in_first_goal_continuation",
        preference: subagentPreference,
        continuationId: goalTurnContract.goalSliceId,
        observedToolCalls: agentResult.toolCalls.length,
        observedToolNames: [...new Set(agentResult.toolCalls.map((call) => call.name))].slice(0, 12),
      });
    }
    iteration.summary = extractIterationSummary(agentResult.assistantText, language, iterationEvidence);
    if (agentResult.continuation) {
      progress.continuation = agentResult.continuation;
    }
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

    callbacks.onDebugEvent?.("goal_continuation_outcome", {
      continuationId: goalTurnContract.goalSliceId,
      continuation: iteration.index,
      outcomeStatus: agentResult.outcomeStatus || (agentResult.completed ? "completed" : "unknown"),
      stopReason: iteration.stopReason || null,
      sliceBoundaryReached: agentResult.sliceBoundaryReached === true,
      usage: normalizedUsage,
      evidenceCount: iterationEvidence.length,
      retainedMessages: progress.continuation?.messages.length || 0,
      retainedOperations: progress.continuation?.operationCount || 0,
      memoryChars: progress.continuation?.memoryPacket?.length || 0,
    });

    const completionSignal = detectGoalCompletionSignal(agentResult.assistantText);
    const autoContinue = agentResult.sliceBoundaryReached === true
      || iteration.stopReason === "max_iterations_boundary";
    const effectiveStopReason = completionSignal.blocked
      ? completionSignal.blockerReason || "goal_blocked_without_reason"
      : iteration.stopReason || agentResult.error || agentResult.outcomeStatus || "agent_loop_completed";
    const innerDecision = resolveGoalInnerOutcomeDecision({
      status: completionSignal.blocked ? "stopped_no_action" : agentResult.outcomeStatus,
      stopReason: effectiveStopReason,
      sliceBoundaryReached: autoContinue,
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
        remainingTasks: resolveRemainingTasks({
          goal,
          assistantText: agentResult.assistantText,
          previous: lastCheckpoint?.remainingTasks || [],
        }),
        language,
        assistantText: agentResult.assistantText,
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

    if (autoContinue) {
      iteration.stopClass = "slice_budget_exhausted";
      progress.stopClass = "slice_budget_exhausted";
      callbacks.onDebugEvent?.("goal_continuation_auto_resume", {
        continuationId: goalTurnContract.goalSliceId,
        continuation: iteration.index,
        stopReason: iteration.stopReason,
        nextContinuationId: `${goal.id}:slice:${iteration.index + 1}`,
        retainedMessages: progress.continuation?.messages.length || 0,
        retainedOperations: progress.continuation?.operationCount || 0,
        memoryChars: progress.continuation?.memoryPacket?.length || 0,
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
          continuationId: goalTurnContract.goalSliceId,
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
        continuationId: goalTurnContract.goalSliceId,
        outcomeStatus: agentResult.outcomeStatus || (agentResult.completed ? "completed" : "unknown"),
        stopReason: effectiveStopReason,
        sliceBoundaryReached: autoContinue,
        evidenceCount: progress.evidence?.length || 0,
      });
    }
    if (completionCandidate.accepted && !completionGate.passed) {
      // Preserve the ordinary continuation-boundary status when completion was
      // runtime-nominated. A missing marker must not turn a normal bounded
      // continuation into a misleading evidence pause. Explicit model claims
      // still receive the more precise evidence_missing stop class.
      if (completionCandidate.source === "model_marker") {
        iteration.stopClass = "evidence_missing";
        progress.stopClass = "evidence_missing";
      }
      callbacks.onDebugEvent?.("goal_completion_rejected", {
        iteration: iteration.index,
        continuationId: goalTurnContract.goalSliceId,
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
        assistantText: agentResult.assistantText,
      });
      progress.lastCheckpoint = lastCheckpoint;
      callbacks.onGoalIterationEnd(iteration);
      callbacks.onGoalCheckpointSaved(lastCheckpoint);
      await persistProgress(callbacks, goal, progress, language);
      callbacks.onGoalProgressUpdate(progress, goal);
      emitRuntimeUpdate(callbacks, goal, progress, "observe");
      callbacks.onDebugEvent?.("goal_completion_accepted", {
        iteration: iteration.index,
        continuationId: goalTurnContract.goalSliceId,
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
      if (!autoContinue) {
        iteration.stopClass = recoveryStopClass;
        progress.stopClass = recoveryStopClass;
      }
      callbacks.onDebugEvent?.("goal_recovery_state_updated", {
        continuationId: goalTurnContract.goalSliceId,
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
          remainingTasks: resolveRemainingTasks({
            goal,
            assistantText: agentResult.assistantText,
            previous: lastCheckpoint?.remainingTasks || [],
          }),
          language,
          assistantText: agentResult.assistantText,
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

    // Keep a continuation checkpoint after every internal boundary. Exact
    // recent messages stay in progress.continuation; this checkpoint remains a
    // self-contained fallback for pause, restart, or later context compaction.
    lastCheckpoint = createCheckpointFromRuntime({
      goal,
      progress,
      iteration: { ...iteration, phase: "re_plan" },
      remainingTasks: resolveRemainingTasks({
        goal,
        assistantText: agentResult.assistantText,
        previous: lastCheckpoint?.remainingTasks || [],
      }),
      language,
      assistantText: agentResult.assistantText,
    });
    progress.lastCheckpoint = lastCheckpoint;

    if (shouldCreateCheckpoint(iteration.index, budget)) {
      callbacks.onGoalCheckpointSaved(lastCheckpoint);

      callbacks.onDebugEvent?.("goal_checkpoint_saved", {
        iteration: iteration.index,
        continuationId: goalTurnContract.goalSliceId,
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
  assistantText?: string;
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
    lastAssistantContext: compactGoalAssistantContext(input.assistantText),
    recentOperations: (input.progress.evidence || []).slice(-16).map((entry) => ({
      iteration: entry.iteration,
      tool: entry.sourceTool,
      target: entry.target,
      status: entry.status,
      summary: entry.summary,
    })),
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

  // A normal inner completion and the expected continuation boundary are
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
    const workspacePath = callbacks.getWorkspacePath();
    const persistenceWasDeleted = () => isGoalRuntimeDeleted(workspacePath, goal.id);
    if (persistenceWasDeleted()) {
      callbacks.onDebugEvent?.("goal_persist_skipped_deleted", {
        goalId: goal.id,
        reason: "deletion_tombstone",
      });
      return;
    }
    if (goal.status !== "active" && progress.usage?.activeStartedAt) {
      progress.usage.activeDurationMs += Math.max(0, Date.now() - progress.usage.activeStartedAt);
      progress.usage.activeStartedAt = null;
    }
    const markdown = buildGoalProgressMarkdown({ goal, progress, language });
    await callbacks.writeFile(progress.progressFile, markdown);
    if (persistenceWasDeleted()) return;
    const runtimeSnapshot = buildGoalRuntimeSnapshot({
      goal,
      progress,
      phase: progress.iterations[progress.iterations.length - 1]?.phase || null,
      pauseReason: progress.pauseReason,
    });
    await callbacks.writeFile(
      resolveGoalRuntimeStateFilePath(workspacePath, goal.id),
      serializeGoalRuntimeSnapshot(runtimeSnapshot),
    );
    if (persistenceWasDeleted()) return;
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

function buildIterationEvidenceSummary(
  evidence: GoalEvidenceEntry[],
  language: "zh" | "en",
): string {
  if (evidence.length === 0) return "";
  const failed = evidence.filter((entry) => entry.status === "failed");
  const changes = evidence.filter((entry) => entry.kind === "file_change");
  const validations = evidence.filter((entry) =>
    entry.kind === "test" || entry.kind === "build" || entry.kind === "browser"
  );
  const reads = evidence.filter((entry) => entry.kind === "read");
  const targets = (entries: GoalEvidenceEntry[], limit: number) => [...new Set(
    entries.map((entry) => entry.target || entry.sourceTool).filter(Boolean),
  )].slice(0, limit).join(", ");

  if (failed.length > 0) {
    return language === "zh"
      ? `失败操作：${targets(failed, 3)}`
      : `Failed operations: ${targets(failed, 3)}`;
  }
  const parts: string[] = [];
  if (changes.length > 0) {
    parts.push(language === "zh"
      ? `已修改 ${targets(changes, 4)}`
      : `Modified ${targets(changes, 4)}`);
  }
  if (validations.length > 0) {
    parts.push(language === "zh"
      ? `已验证 ${targets(validations, 3)}`
      : `Verified ${targets(validations, 3)}`);
  }
  if (parts.length === 0 && reads.length > 0) {
    parts.push(language === "zh"
      ? `已检查 ${targets(reads, 4)}`
      : `Inspected ${targets(reads, 4)}`);
  }
  return parts.join(language === "zh" ? "；" : "; ");
}

function extractIterationSummary(
  assistantText: string,
  language: "zh" | "en",
  evidence: GoalEvidenceEntry[],
): string {
  const conclusion = extractGoalAssistantSummary(assistantText, 480);
  const evidenceSummary = buildIterationEvidenceSummary(evidence, language);
  if (!conclusion) return evidenceSummary || (language === "zh" ? "本次连续执行没有可用摘要" : "No usable continuation summary");
  if (!evidenceSummary || conclusion.toLowerCase().includes(evidenceSummary.toLowerCase())) return conclusion;
  const combined = `${conclusion} | ${evidenceSummary}`;
  return combined.length <= 640 ? combined : `${combined.slice(0, 637)}...`;
}

function extractCompletedTasks(progress: GoalProgress): string[] {
  const tasks: string[] = [];
  for (const iter of progress.iterations) {
    const hasSuccessfulEvidence = (progress.evidence || []).some(
      (entry) => entry.iteration === iter.index && isGoalEvidenceMeaningfulProgress(entry),
    );
    if (iter.summary && iter.endedAt && hasSuccessfulEvidence && iter.unresolvedBlockers.length === 0) {
      tasks.push(`[Continuation ${iter.index}] ${iter.summary}`);
    }
  }
  return tasks.slice(-20); // Keep last 20
}

function extractExplicitRemainingTasks(assistantText: string): string[] {
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

function normalizeTaskKey(value: string): string {
  return String(value || "").toLowerCase().replace(/[\s`*_#.,，。:：;；-]+/g, "").trim();
}

function resolveRemainingTasks(input: {
  goal: GoalDefinition;
  assistantText: string;
  previous: string[];
}): string[] {
  const explicit = extractExplicitRemainingTasks(input.assistantText);
  const criteria = normalizeGoalCriteria(input.goal);
  const satisfiedKeys = criteria
    .filter((criterion) => criterion.status === "satisfied")
    .map((criterion) => normalizeTaskKey(criterion.text));
  const pending = criteria
    .filter((criterion) => criterion.required && criterion.status !== "satisfied")
    .map((criterion) => criterion.text);
  const fallback = explicit.length > 0 ? explicit : input.previous;
  const candidates = [...fallback, ...pending].filter((task) => {
    const key = normalizeTaskKey(task);
    if (!key) return false;
    return !satisfiedKeys.some((satisfied) =>
      satisfied && (key === satisfied || key.includes(satisfied) || satisfied.includes(key))
    );
  });
  const seen = new Set<string>();
  const remaining: string[] = [];
  for (const task of candidates) {
    const key = normalizeTaskKey(task);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    remaining.push(task.trim());
  }
  return remaining.slice(0, 20);
}

function buildCheckpointSummary(progress: GoalProgress, language: "zh" | "en"): string {
  const recentIterations = progress.iterations.slice(-3);
  const isZh = language === "zh";

  const summaries = recentIterations.map((iter) => {
    const files = iter.filesModified.length > 0
      ? ` (${isZh ? "修改" : "modified"}: ${iter.filesModified.join(", ")})`
      : "";
    return `${isZh ? "连续执行" : "Continuation"} ${iter.index}: ${iter.summary}${files}`;
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
