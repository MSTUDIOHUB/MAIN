import type { GoalBudget } from "./goalBudget";
import {
  GOAL_SCHEMA_VERSION,
  buildGoalSliceId,
  migrateGoalDefinition,
  normalizeGoalCriteria,
  type GoalCriterion,
  type GoalDefinition,
  type GoalEvidenceEntry,
  type GoalProgress,
  type GoalRuntimeSnapshot,
} from "./goalState";
import {
  classifyGoalToolCapability,
  isGoalEvidenceCompletionEligible,
} from "./goalToolCapabilities";
import {
  createGoalContinuationState,
  sanitizeGoalContinuationMemoryPacket,
} from "./goalContinuity";

export interface GoalToolObservation {
  id?: string;
  name: string;
  target?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  success?: boolean;
}

export interface GoalCompletionGateResult {
  passed: boolean;
  reasons: string[];
  criteria: GoalCriterion[];
  supportingEvidenceIds: string[];
}

function readArgumentString(args: Record<string, unknown> | undefined, keys: string[]): string {
  if (!args) return "";
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function resolveGoalToolTarget(observation: GoalToolObservation): string {
  return String(observation.target || "").trim() || readArgumentString(observation.arguments, [
    "path",
    "file_path",
    "target_file",
    "target",
    "command",
    "cmd",
    "query",
    "pattern",
  ]);
}

/**
 * Reconcile provider transcript tool calls with the UI/runtime lifecycle blocks
 * produced for the same calls. A completed tool result must enrich the existing
 * observation, never manufacture a second budget/evidence entry.
 */
export function mergeGoalToolObservations(
  transcriptObservations: GoalToolObservation[],
  runtimeObservations: GoalToolObservation[],
): GoalToolObservation[] {
  const merged = transcriptObservations.map((observation) => ({ ...observation }));
  const fallbackMatchedIndexes = new Set<number>();

  for (const runtimeObservation of runtimeObservations) {
    const runtimeId = String(runtimeObservation.id || "").trim();
    const runtimeName = String(runtimeObservation.name || "").trim();
    const runtimeTarget = resolveGoalToolTarget(runtimeObservation);
    let matchIndex = runtimeId
      ? merged.findIndex((candidate) => String(candidate.id || "").trim() === runtimeId)
      : -1;

    if (matchIndex < 0) {
      matchIndex = merged.findIndex((candidate, index) =>
        !fallbackMatchedIndexes.has(index)
        && candidate.name === runtimeName
        && resolveGoalToolTarget(candidate) === runtimeTarget
      );
    }
    if (matchIndex < 0 && !runtimeTarget) {
      matchIndex = merged.findIndex((candidate, index) =>
        !fallbackMatchedIndexes.has(index)
        && candidate.name === runtimeName
        && !resolveGoalToolTarget(candidate)
      );
    }

    if (matchIndex < 0) {
      merged.push({ ...runtimeObservation });
      continue;
    }

    fallbackMatchedIndexes.add(matchIndex);
    const existing = merged[matchIndex];
    merged[matchIndex] = {
      ...existing,
      ...(existing.id ? {} : runtimeId ? { id: runtimeId } : {}),
      ...(existing.arguments ? {} : runtimeObservation.arguments ? { arguments: runtimeObservation.arguments } : {}),
      target: runtimeTarget || existing.target,
      result: existing.result ?? runtimeObservation.result,
      success: runtimeObservation.success ?? existing.success,
    };
  }

  return merged;
}

export function isGoalToolResultSuccessful(result: string | undefined, explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  const text = String(result || "").trim();
  if (!text) return true;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.success === false || parsed.ok === false) return false;
    if (typeof parsed.exitCode === "number") return parsed.exitCode === 0;
    if (typeof parsed.code === "number") return parsed.code === 0;
    if (typeof parsed.error === "string" && parsed.error.trim()) return false;
  } catch {
    // Tool adapters may return plain text. Clear failure markers remain authoritative.
  }
  return !(
    /exit\s*code\s*[:=]\s*[1-9]\d*/i.test(text)
    || /\b[1-9]\d*\s+(?:errors?|failed|failures?)\b/i.test(text)
    || /(?:^|\n)\s*(?:error|failed|failure|panic|exception)\s*[:：]/i.test(text)
    || /\b(?:command|test|tests|build|lint|typecheck)\s+(?:has\s+)?failed\b/i.test(text)
  );
}

function compactEvidenceSummary(result: string | undefined, fallback: string): string {
  const text = String(result || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function createGoalEvidenceEntries(input: {
  goal: GoalDefinition;
  iteration: number;
  observations: GoalToolObservation[];
  now?: number;
}): GoalEvidenceEntry[] {
  const goal = migrateGoalDefinition(input.goal);
  const createdAt = input.now ?? Date.now();
  const entries = input.observations.map((observation, index) => {
    const target = resolveGoalToolTarget(observation);
    const success = isGoalToolResultSuccessful(observation.result, observation.success);
    const capability = classifyGoalToolCapability({
      name: observation.name,
      target,
      arguments: observation.arguments,
    });
    const kind = capability.kind;
    return {
      id: `goal_evidence_${input.iteration}_${createdAt}_${index + 1}`,
      goalId: goal.id,
      goalRevision: goal.revision || 1,
      iteration: input.iteration,
      kind,
      status: !success
        ? "failed" as const
        : !capability.known || kind === "read"
          ? "observed" as const
          : "passed" as const,
      sourceTool: observation.name,
      target,
      summary: compactEvidenceSummary(observation.result, `${observation.name}${target ? `: ${target}` : ""}`),
      references: kind === "file_change" && target ? [target] : [],
      criterionIds: [],
      createdAt: createdAt + index,
    };
  });
  return assignGoalEvidenceCriterionIds(goal, entries);
}

export function goalRequiresMutation(goal: GoalDefinition): boolean {
  return /(?:implement|fix|repair|refactor|migrate|update|modify|change|create|build|write|remove|delete|实现|修复|重构|迁移|更新|修改|创建|开发|编写|删除)/i.test(
    goal.rawText || goal.objective,
  );
}

export function goalExplicitlyRequiresVerification(goal: GoalDefinition): boolean {
  return /(?:test|build|lint|typecheck|verify|validation|playwright|测试|构建|验证|检查|通过)/i.test(
    `${goal.rawText || goal.objective}\n${(goal.verificationHints || []).join("\n")}`,
  );
}

function evidenceIsFresh(goal: GoalDefinition, entry: GoalEvidenceEntry): boolean {
  return entry.goalId === goal.id && entry.goalRevision === (goal.revision || 1);
}

const CRITERION_MUTATION_RE = /(?:implement|fix|repair|refactor|migrate|update|modify|change|create|write|remove|delete|实现|修复|重构|迁移|更新|修改|创建|编写|删除)/i;
const CRITERION_TEST_RE = /(?:\btests?\b|pytest|jest|vitest|playwright\s+test|测试|用例)/i;
const CRITERION_BUILD_RE = /(?:\bbuild\b|\blint\b|type\s*check|typecheck|tsc|cargo\s+check|构建|编译|静态检查|类型检查)/i;
const CRITERION_BROWSER_RE = /(?:browser|screenshot|render|visual|dom|浏览器|截图|渲染|视觉)/i;
const CRITERION_VERIFICATION_RE = /(?:verify|verification|validate|validation|pass|regression|compatible|compatibility|验证|校验|通过|回归|兼容)/i;
const CRITERION_TEST_BUILD_ALTERNATIVE_RE = /(?:\b(?:tests?|pytest|jest|vitest|playwright\s+test)\b|测试|用例).{0,80}?(?:\bor\b|或者|或|\/).{0,80}?(?:\b(?:build|lint|type\s*check|typecheck|tsc)\b|构建|编译|静态检查|类型检查)|(?:\b(?:build|lint|type\s*check|typecheck|tsc)\b|构建|编译|静态检查|类型检查).{0,80}?(?:\bor\b|或者|或|\/).{0,80}?(?:\b(?:tests?|pytest|jest|vitest|playwright\s+test)\b|测试|用例)/i;
const CRITERION_IGNORED_TOKENS = new Set([
  "this", "that", "with", "from", "into", "then", "goal", "runtime",
  "implement", "implemented", "update", "updated", "modify", "modified", "change", "changed", "fix", "fixed",
  "verify", "verified", "validation", "test", "tests", "build", "lint",
  "完成", "标准", "必须", "确保", "支持", "实现", "更新", "修改", "修复", "验证", "测试", "构建",
]);

function criterionTokens(text: string): string[] {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9_./-]{4,}|[\u4e00-\u9fff]{2,}/g) || [],
  )].filter((token) => !CRITERION_IGNORED_TOKENS.has(token)).slice(0, 16);
}

function evidenceSearchText(entry: GoalEvidenceEntry): string {
  return `${entry.sourceTool}\n${entry.target}\n${entry.summary}\n${entry.references.join("\n")}`.toLowerCase();
}

function latestEvidence(
  entries: GoalEvidenceEntry[],
  predicate: (entry: GoalEvidenceEntry) => boolean,
): GoalEvidenceEntry | null {
  return [...entries].reverse().find(predicate) || null;
}

function selectEvidenceForCriterion(
  criterion: GoalCriterion,
  evidence: GoalEvidenceEntry[],
  reservedEvidenceIds: ReadonlySet<string> = new Set(),
): { selected: GoalEvidenceEntry[]; supported: boolean; failed: boolean } {
  const text = criterion.text;
  const eligible = evidence.filter((entry) =>
    isGoalEvidenceCompletionEligible(entry) && !reservedEvidenceIds.has(entry.id)
  );
  const selected = new Map<string, GoalEvidenceEntry>();
  const tokens = criterionTokens(text);
  const requiresMutation = CRITERION_MUTATION_RE.test(text);
  const requiresTest = CRITERION_TEST_RE.test(text);
  const requiresBuild = CRITERION_BUILD_RE.test(text);
  const requiresBrowser = CRITERION_BROWSER_RE.test(text);
  const requiresGenericVerification = CRITERION_VERIFICATION_RE.test(text)
    && !requiresTest
    && !requiresBuild
    && !requiresBrowser;
  const requirements: Array<(entry: GoalEvidenceEntry) => boolean> = [];

  if (requiresMutation) requirements.push((entry) => entry.kind === "file_change");
  // Preserve an explicit "test OR build/typecheck" definition of done as an
  // alternative, rather than treating keyword detection as two conjunctive
  // requirements. This keeps completion tied to the user's stated contract.
  const allowsTestOrBuild = requiresTest
    && requiresBuild
    && CRITERION_TEST_BUILD_ALTERNATIVE_RE.test(text);
  if (allowsTestOrBuild) {
    requirements.push((entry) => entry.kind === "test" || entry.kind === "build");
  } else {
    if (requiresTest) requirements.push((entry) => entry.kind === "test");
    if (requiresBuild) requirements.push((entry) => entry.kind === "build");
  }
  if (requiresBrowser) requirements.push((entry) => entry.kind === "browser");
  if (requiresGenericVerification) {
    requirements.push((entry) =>
      entry.kind === "test"
      || entry.kind === "build"
      || entry.kind === "browser"
      || entry.kind === "user_validation"
    );
  }

  let supported = true;
  for (const requirement of requirements) {
    const matchingKind = eligible.filter(requirement);
    const lexicalMatch = latestEvidence(matchingKind, (entry) => {
      const haystack = evidenceSearchText(entry);
      return tokens.some((token) => haystack.includes(token));
    });
    // Kind is an explicit criterion contract. When prose tokens are generic or
    // intentionally filtered (for example "fix runtime"), use the latest
    // unreserved evidence of that required kind instead of making the
    // criterion permanently unsatisfiable. Cross-criterion reuse remains
    // prevented by reservedEvidenceIds.
    const match = lexicalMatch || latestEvidence(matchingKind, () => true);
    if (match) selected.set(match.id, match);
    else supported = false;
  }

  if (requirements.length === 0) {
    const lexicalMatch = latestEvidence(eligible, (entry) => {
      const haystack = evidenceSearchText(entry);
      return tokens.some((token) => haystack.includes(token));
    });
    const fallback = lexicalMatch || eligible[eligible.length - 1] || null;
    if (fallback) selected.set(fallback.id, fallback);
    else supported = false;
  }

  const relevantKinds = new Set([...selected.values()].map((entry) => entry.kind));
  const failed = evidence.some((entry) =>
    entry.status === "failed"
    && (relevantKinds.size === 0 || relevantKinds.has(entry.kind))
    && !evidence.some((candidate) =>
      candidate.createdAt > entry.createdAt
      && candidate.status !== "failed"
      && candidate.kind === entry.kind
      && candidate.target === entry.target
    )
  );

  return { selected: [...selected.values()], supported, failed };
}

export function assignGoalEvidenceCriterionIds(
  inputGoal: GoalDefinition,
  evidence: GoalEvidenceEntry[],
): GoalEvidenceEntry[] {
  const goal = migrateGoalDefinition(inputGoal);
  const freshEvidence = evidence.filter((entry) => evidenceIsFresh(goal, entry));
  const criterionIdsByEvidence = new Map<string, Set<string>>();
  const reservedEvidenceIds = new Set<string>();
  for (const criterion of normalizeGoalCriteria(goal)) {
    const selection = selectEvidenceForCriterion(criterion, freshEvidence, reservedEvidenceIds);
    for (const entry of selection.selected) {
      const ids = criterionIdsByEvidence.get(entry.id) || new Set<string>();
      ids.add(criterion.id);
      criterionIdsByEvidence.set(entry.id, ids);
      reservedEvidenceIds.add(entry.id);
    }
  }
  return evidence.map((entry) => ({
    ...entry,
    criterionIds: evidenceIsFresh(goal, entry)
      ? [...(criterionIdsByEvidence.get(entry.id) || new Set<string>())]
      : [],
  }));
}

export function evaluateGoalCompletion(input: {
  goal: GoalDefinition;
  evidence: GoalEvidenceEntry[];
  completionCandidate: boolean;
  unresolvedBlockers?: string[];
}): GoalCompletionGateResult {
  const goal = migrateGoalDefinition(input.goal);
  const reasons: string[] = [];
  const revisionEvidence = input.evidence.filter((entry) => evidenceIsFresh(goal, entry));
  const mutationRequired = goalRequiresMutation(goal) ||
    normalizeGoalCriteria(goal).some((criterion) => CRITERION_MUTATION_RE.test(criterion.text));
  const successfulRevisionEvidence = revisionEvidence.filter(isGoalEvidenceCompletionEligible);
  const evidenceOrder = new Map(revisionEvidence.map((entry, index) => [entry.id, index]));
  const occursAfter = (entry: GoalEvidenceEntry, baseline: GoalEvidenceEntry): boolean =>
    entry.iteration > baseline.iteration ||
    (entry.iteration === baseline.iteration && (
      entry.createdAt > baseline.createdAt ||
      (entry.createdAt === baseline.createdAt &&
        (evidenceOrder.get(entry.id) || 0) > (evidenceOrder.get(baseline.id) || 0))
    ));
  const latestMutation = successfulRevisionEvidence
    .filter((entry) => entry.kind === "file_change")
    .reduce<GoalEvidenceEntry | null>((latest, entry) => {
      if (!latest || occursAfter(entry, latest)) return entry;
      return latest;
    }, null);
  const isVerificationEvidence = (entry: GoalEvidenceEntry) =>
    entry.kind === "test" || entry.kind === "build" || entry.kind === "browser" || entry.kind === "user_validation";
  // A validation result describes the workspace state that existed when it ran.
  // Any later mutation invalidates it, even when both entries belong to the same
  // Goal revision. Criteria assignment must therefore see only post-mutation
  // verification evidence.
  const completionEvidence = revisionEvidence.filter((entry) =>
    !mutationRequired || !latestMutation || !isVerificationEvidence(entry) || occursAfter(entry, latestMutation)
  );
  const freshEvidence = assignGoalEvidenceCriterionIds(goal, completionEvidence);
  const successfulEvidence = freshEvidence.filter(isGoalEvidenceCompletionEligible);
  const mutationEvidence = successfulEvidence.filter((entry) => entry.kind === "file_change");
  const verificationEvidence = successfulEvidence.filter(isVerificationEvidence);
  const revisionVerificationEvidence = revisionEvidence.filter(isVerificationEvidence);
  const failedVerificationScope = revisionEvidence.filter((entry) =>
    !mutationRequired || !latestMutation || occursAfter(entry, latestMutation)
  );
  const failedVerification = failedVerificationScope.filter((entry) => {
    if (entry.status !== "failed" || !(
      entry.kind === "test" || entry.kind === "build" || entry.kind === "browser" || entry.kind === "command"
    )) return false;
    return !failedVerificationScope.some((candidate) =>
      candidate.createdAt > entry.createdAt
      && candidate.status !== "failed"
      && candidate.kind === entry.kind
      && candidate.target === entry.target
    );
  });

  if (!input.completionCandidate) reasons.push("model_has_not_proposed_completion");
  if (goal.criteriaReviewRequired) reasons.push("goal_criteria_review_required");
  if (successfulEvidence.length === 0) reasons.push("no_fresh_execution_evidence");
  if (mutationRequired && mutationEvidence.length === 0) reasons.push("mutation_evidence_required");
  if (mutationRequired && revisionVerificationEvidence.length > 0 && verificationEvidence.length === 0) {
    reasons.push("verification_stale_after_mutation");
  }
  if ((mutationRequired || goalExplicitlyRequiresVerification(goal)) && verificationEvidence.length === 0) {
    reasons.push("verification_evidence_required");
  }
  if (failedVerification.length > 0) reasons.push("verification_failed");
  if ((input.unresolvedBlockers || []).some((item) => String(item || "").trim())) reasons.push("unresolved_blockers");

  const criteria = normalizeGoalCriteria(goal).map((criterion) => {
    const criterionEvidence = freshEvidence.filter((entry) =>
      (entry.criterionIds || []).includes(criterion.id)
    );
    const selection = selectEvidenceForCriterion(criterion, criterionEvidence);
    const evidenceIds = selection.selected.map((entry) => entry.id);
    const status = selection.supported
      ? "satisfied" as const
      : selection.failed
        ? "failed" as const
        : criterion.status === "satisfied"
          ? "invalidated" as const
          : "pending" as const;
    if (criterion.required && status !== "satisfied") {
      reasons.push(`criterion_evidence_required:${criterion.id}`);
    }
    return { ...criterion, status, evidenceIds };
  });
  const supportingEvidenceIds = [...new Set(
    criteria
      .filter((criterion) => criterion.status === "satisfied")
      .flatMap((criterion) => criterion.evidenceIds),
  )];

  return {
    passed: reasons.length === 0,
    reasons,
    criteria,
    supportingEvidenceIds,
  };
}

export function buildGoalBudgetOverrides(goal: GoalDefinition): Partial<GoalBudget> {
  const overrides: Partial<GoalBudget> = {};
  if (Number.isFinite(goal.iterationBudget) && goal.iterationBudget > 0) {
    overrides.maxIterations = Math.floor(goal.iterationBudget);
  }
  if (Number.isFinite(goal.tokenBudget) && Number(goal.tokenBudget) > 0) {
    overrides.maxTokens = Math.floor(Number(goal.tokenBudget));
  }
  if (Number.isFinite(goal.toolCallBudget) && Number(goal.toolCallBudget) > 0) {
    overrides.maxToolCalls = Math.floor(Number(goal.toolCallBudget));
  }
  if (Number.isFinite(goal.maxDurationMs) && Number(goal.maxDurationMs) > 0) {
    overrides.maxDurationMs = Math.floor(Number(goal.maxDurationMs));
  }
  return overrides;
}

export function buildGoalRuntimeSnapshot(input: {
  goal: GoalDefinition;
  progress: GoalProgress;
  phase?: GoalRuntimeSnapshot["phase"];
  pauseReason?: string;
  lastError?: string;
}): GoalRuntimeSnapshot {
  const goal = migrateGoalDefinition(input.goal);
  const migrationPauseReason = goal.migrationReviewRequired
    ? "goal_definition_migrated_review_required"
    : goal.criteriaReviewRequired
      ? "goal_criteria_clarification_required"
    : undefined;
  return {
    schemaVersion: GOAL_SCHEMA_VERSION,
    goal,
    progress: {
      ...input.progress,
      evidence: input.progress.evidence || [],
      milestones: input.progress.milestones || [],
      currentMilestoneId: input.progress.currentMilestoneId ?? null,
      pauseReason: migrationPauseReason || input.progress.pauseReason,
      recoveryState: input.progress.recoveryState ? { ...input.progress.recoveryState } : undefined,
    },
    status: goal.status,
    phase: input.phase ?? null,
    pauseReason: migrationPauseReason || input.pauseReason,
    stopClass: goal.migrationReviewRequired
      ? "migration_review_required"
      : goal.criteriaReviewRequired
        ? "awaiting_input"
        : input.progress.stopClass,
    lastError: input.lastError,
    updatedAt: Date.now(),
  };
}

export function restoreGoalRuntimeSnapshot(
  snapshot: GoalRuntimeSnapshot,
  now: number = Date.now(),
): GoalRuntimeSnapshot {
  const normalized = normalizeGoalRuntimeSnapshot(snapshot);
  const goal = normalized.goal;
  const wasInterrupted = normalized.status === "active" || normalized.status === "pausing";
  const status = wasInterrupted ? "paused" as const : normalized.status;
  const pauseReason = wasInterrupted
    ? "Application restarted; resume explicitly from the last checkpoint."
    : normalized.pauseReason;
  const usage = normalized.progress.usage
    ? {
        ...normalized.progress.usage,
        activeDurationMs: normalized.progress.usage.activeDurationMs + (
          wasInterrupted && normalized.progress.usage.activeStartedAt
            ? Math.max(
                0,
                Math.min(now, normalized.updatedAt || now) - normalized.progress.usage.activeStartedAt,
              )
            : 0
        ),
        activeStartedAt: null,
      }
    : undefined;

  return {
    ...normalized,
    goal: { ...goal, status },
    progress: {
      ...normalized.progress,
      pauseReason: pauseReason || normalized.progress.pauseReason,
      usage,
    },
    status,
    phase: wasInterrupted ? "re_plan" : snapshot.phase,
    pauseReason,
  };
}

export function normalizeGoalRuntimeSnapshot(snapshot: GoalRuntimeSnapshot): GoalRuntimeSnapshot {
  const goal = migrateGoalDefinition(snapshot.goal);
  const migrationPauseReason = goal.migrationReviewRequired
    ? "goal_definition_migrated_review_required"
    : goal.criteriaReviewRequired
      ? "goal_criteria_clarification_required"
    : undefined;
  const status = goal.migrationReviewRequired
    ? "paused" as const
    : goal.criteriaReviewRequired
      ? "awaiting_input" as const
      : snapshot.status || goal.status;
  const evidence = assignGoalEvidenceCriterionIds(goal, [...(snapshot.progress.evidence || [])]);
  const persistedContinuation = snapshot.progress.continuation;
  const normalizedContinuation = persistedContinuation
      ? createGoalContinuationState({
        messages: persistedContinuation.messages || [],
        sourceIteration: persistedContinuation.sourceIteration,
        executeRecoveryState: persistedContinuation.executeRecoveryState,
        now: persistedContinuation.updatedAt || snapshot.updatedAt || Date.now(),
      })
    : undefined;
  return {
    ...snapshot,
    schemaVersion: GOAL_SCHEMA_VERSION,
    goal: { ...goal, status },
    progress: {
      ...snapshot.progress,
      iterations: [...(snapshot.progress.iterations || [])].map((iteration) => ({
        ...iteration,
        goalSliceId: iteration.goalSliceId || buildGoalSliceId(goal.id, iteration.index),
        usage: iteration.usage ? { ...iteration.usage } : undefined,
      })),
      evidence,
      milestones: [...(snapshot.progress.milestones || [])],
      usage: snapshot.progress.usage ? { ...snapshot.progress.usage } : undefined,
      pauseReason: migrationPauseReason || snapshot.progress.pauseReason,
      recoveryState: snapshot.progress.recoveryState ? { ...snapshot.progress.recoveryState } : undefined,
      continuation: normalizedContinuation
        ? {
            ...normalizedContinuation,
            // Normalization is idempotent: keep durable memory produced at the
            // execution boundary instead of summarizing that packet into itself.
            memoryPacket:
              sanitizeGoalContinuationMemoryPacket(persistedContinuation?.memoryPacket)
              || normalizedContinuation.memoryPacket,
            compacted: persistedContinuation?.compacted === true || normalizedContinuation.compacted,
            messageCountBefore: Math.max(
              persistedContinuation?.messageCountBefore || 0,
              normalizedContinuation.messageCountBefore,
            ),
          }
        : undefined,
    },
    status,
    pauseReason: migrationPauseReason || snapshot.pauseReason,
    stopClass: goal.migrationReviewRequired
      ? "migration_review_required"
      : goal.criteriaReviewRequired
        ? "awaiting_input"
        : snapshot.stopClass,
  };
}
