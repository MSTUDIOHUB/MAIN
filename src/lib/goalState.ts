// lib/goalState.ts
// Goal lifecycle data model for MAIN's /目标 (Goal Mode).
// Tracks goal definition, iteration progress, and checkpoints.
// ────────────────────────────────────────────────────────────────────

export type GoalStatus =
  | "active"           // Currently executing
  | "pausing"          // Abort/checkpoint requested; waiting for a safe boundary
  | "paused"           // User paused or checkpoint reached
  | "awaiting_input"   // A permission, decision, or external validation is required
  | "completed"        // Objective met (verification passed)
  | "failed"           // Unrecoverable failure
  | "budget_exceeded"  // Iteration/token budget exhausted
  | "cancelled";       // Goal tracking was explicitly cleared

export type GoalIterationPhase =
  | "plan"      // Analyzing current state, choosing next task
  | "execute"   // Running tools to implement the task
  | "observe"   // Verifying results (tests, build, lint)
  | "re_plan";  // Adjusting strategy based on observation

export type GoalCriterionStatus = "pending" | "satisfied" | "failed" | "invalidated";

export interface GoalCriterion {
  id: string;
  text: string;
  required: boolean;
  status: GoalCriterionStatus;
  evidenceIds: string[];
}

export type GoalEvidenceKind =
  | "read"
  | "file_change"
  | "command"
  | "test"
  | "build"
  | "browser"
  | "mcp"
  | "user_validation"
  | "blocker";

export type GoalEvidenceStatus = "observed" | "passed" | "failed";

export interface GoalEvidenceEntry {
  id: string;
  goalId: string;
  goalRevision: number;
  iteration: number;
  kind: GoalEvidenceKind;
  status: GoalEvidenceStatus;
  sourceTool: string;
  target: string;
  summary: string;
  references: string[];
  createdAt: number;
}

export interface GoalMilestone {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  criterionIds: string[];
  blockerReason?: string;
}

export interface GoalUsage {
  modelIterations: number;
  toolCalls: number;
  totalTokensUsed: number;
  activeDurationMs: number;
  activeStartedAt: number | null;
  estimatedTokens: boolean;
}

export interface GoalDefinition {
  /** Persistence schema version. Missing means legacy v1. */
  schemaVersion?: 2;
  /** Unique goal ID */
  id: string;
  /** User-defined objective text */
  objective: string;
  /** Verbatim user-authored goal contract. */
  rawText?: string;
  /** Completion criteria (auto-extracted or user-specified) */
  definitionOfDone: string[];
  /** Evidence-aware completion criteria used by Goal Runtime v2. */
  criteria?: GoalCriterion[];
  constraints?: string[];
  verificationHints?: string[];
  revision?: number;
  updatedAt?: number;
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
  id?: string;
  goalRevision?: number;
  evidenceCursor?: number;
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
  /** Whether token usage is estimated because the provider omitted usage data. */
  estimatedTokens?: boolean;
  /** Full iteration history */
  iterations: GoalIteration[];
  /** Last saved checkpoint (null if none yet) */
  lastCheckpoint: GoalCheckpoint | null;
  /** Path to the progress file (.MAIN/goals/progress.md) */
  progressFile: string;
  /** Timestamp of last progress update */
  lastUpdatedAt: number;
  /** Structured evidence and milestones for Goal Runtime v2. */
  evidence?: GoalEvidenceEntry[];
  milestones?: GoalMilestone[];
  currentMilestoneId?: string | null;
  lastUserConfirmedIteration?: number;
  pauseReason?: string;
  usage?: GoalUsage;
}

export interface GoalRuntimeSnapshot {
  schemaVersion: 2;
  goal: GoalDefinition;
  progress: GoalProgress;
  status: GoalStatus;
  phase: GoalIterationPhase | null;
  pauseReason?: string;
  lastError?: string;
  updatedAt: number;
}

export interface GoalTurnContract {
  goalId: string;
  revision: number;
  iteration: number;
  maxIterations: number;
  status: GoalStatus;
  phase: GoalIterationPhase;
  context: string;
  cacheKey: string;
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
  const objective = input.objective.trim();
  const definitionOfDone = normalizeGoalDefinitionOfDone(
    input.definitionOfDone?.length ? input.definitionOfDone : extractGoalDefinitionOfDone(objective),
  );
  return {
    schemaVersion: 2,
    id: generateGoalId(),
    objective,
    rawText: objective,
    definitionOfDone,
    criteria: createGoalCriteria(definitionOfDone),
    constraints: extractGoalConstraints(objective),
    verificationHints: extractGoalVerificationHints(objective),
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
    estimatedTokens: false,
    iterations: [],
    lastCheckpoint: null,
    progressFile,
    lastUpdatedAt: Date.now(),
    evidence: [],
    milestones: [],
    currentMilestoneId: null,
    usage: {
      modelIterations: 0,
      toolCalls: 0,
      totalTokensUsed: 0,
      activeDurationMs: 0,
      activeStartedAt: Date.now(),
      estimatedTokens: false,
    },
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
  goalRevision?: number;
  evidenceCursor?: number;
}): GoalCheckpoint {
  return {
    id: `checkpoint_${input.iteration}_${Date.now()}`,
    goalRevision: input.goalRevision,
    evidenceCursor: input.evidenceCursor,
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
  return status === "completed" || status === "failed" || status === "budget_exceeded" || status === "cancelled";
}

export function isGoalRunnable(status: GoalStatus): boolean {
  return status === "active" || status === "paused" || status === "awaiting_input";
}

export function canResumeGoal(goal: GoalDefinition): boolean {
  if (!isGoalRunnable(goal.status)) return false;
  if (goal.maxDurationMs && Date.now() - goal.createdAt > goal.maxDurationMs) return false;
  return true;
}

// ── Progress summary ─────────────────────────────────────────────

export function buildGoalProgressPercentage(progress: GoalProgress, goal: GoalDefinition): number {
  const criteria = normalizeGoalCriteria(goal);
  if (criteria.length > 0) {
    const required = criteria.filter((criterion) => criterion.required);
    const denominator = required.length || criteria.length;
    const satisfied = (required.length ? required : criteria).filter((criterion) => criterion.status === "satisfied").length;
    return Math.min(100, Math.round((satisfied / denominator) * 100));
  }
  if (goal.iterationBudget <= 0) return 0;
  const doneCount = progress.lastCheckpoint?.completedTasks.length ?? 0;
  const totalCount = doneCount + (progress.lastCheckpoint?.remainingTasks.length ?? 1);
  if (totalCount === 0) return 0;
  return Math.min(100, Math.round((doneCount / totalCount) * 100));
}

export function buildGoalStatusLabel(status: GoalStatus, language: "zh" | "en"): string {
  const labels: Record<GoalStatus, { zh: string; en: string }> = {
    active: { zh: "执行中", en: "Active" },
    pausing: { zh: "正在暂停", en: "Pausing" },
    paused: { zh: "已暂停", en: "Paused" },
    awaiting_input: { zh: "等待输入", en: "Needs Input" },
    completed: { zh: "已完成", en: "Completed" },
    failed: { zh: "失败", en: "Failed" },
    budget_exceeded: { zh: "预算耗尽", en: "Budget Exceeded" },
    cancelled: { zh: "已取消", en: "Cancelled" },
  };
  return language === "en" ? labels[status].en : labels[status].zh;
}

function normalizeGoalDefinitionOfDone(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const text = String(value || "").replace(/^[-*\d.)\s]+/, "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    normalized.push(text);
  }
  return normalized.slice(0, 20);
}

function extractGoalLabeledSection(
  objective: string,
  startLabel: RegExp,
  stopLabel: RegExp,
): string[] {
  const text = String(objective || "");
  const startMatch = startLabel.exec(text);
  if (!startMatch) return [];
  const tail = text.slice((startMatch.index || 0) + startMatch[0].length);
  const stopMatch = stopLabel.exec(tail);
  const section = (stopMatch ? tail.slice(0, stopMatch.index) : tail).trim();
  return normalizeGoalDefinitionOfDone(section.split(/[\r\n；;]+/));
}

export function extractGoalDefinitionOfDone(objective: string): string[] {
  const text = String(objective || "").trim();
  if (!text) return [];
  const labeled = extractGoalLabeledSection(
    text,
    /(?:完成标准|验收标准|definition\s+of\s+done|\bDoD\b)\s*[:：]\s*/i,
    /(?:约束|限制|constraints?)\s*[:：]\s*/i,
  );
  if (labeled.length > 0) return labeled;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const explicit = lines
    .filter((line) => /^[-*]\s+|^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+|^\d+[.)]\s+/, "").trim());
  return normalizeGoalDefinitionOfDone(explicit.length ? explicit : [text]);
}

export function extractGoalConstraints(objective: string): string[] {
  const text = String(objective || "");
  const labeled = extractGoalLabeledSection(
    text,
    /(?:约束|限制|constraints?)\s*[:：]\s*/i,
    /(?:完成标准|验收标准|definition\s+of\s+done|\bDoD\b)\s*[:：]\s*/i,
  );
  if (labeled.length > 0) return labeled.slice(0, 12);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(?:必须|不得|不要|保持|限制|约束|must|must not|do not|keep|constraint)/i.test(line))
    .slice(0, 12);
}

export function extractGoalVerificationHints(objective: string): string[] {
  return String(objective || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(?:测试|构建|验证|检查|通过|test|build|verify|check|pass)/i.test(line))
    .slice(0, 12);
}

export function createGoalCriteria(values: string[]): GoalCriterion[] {
  return normalizeGoalDefinitionOfDone(values).map((text, index) => ({
    id: `criterion_${index + 1}`,
    text,
    required: true,
    status: "pending",
    evidenceIds: [],
  }));
}

export function normalizeGoalCriteria(goal: GoalDefinition): GoalCriterion[] {
  if (Array.isArray(goal.criteria) && goal.criteria.length > 0) {
    return goal.criteria.map((criterion, index) => ({
      id: String(criterion.id || `criterion_${index + 1}`),
      text: String(criterion.text || "").trim(),
      required: criterion.required !== false,
      status: criterion.status || "pending",
      evidenceIds: Array.isArray(criterion.evidenceIds) ? criterion.evidenceIds.filter(Boolean) : [],
    })).filter((criterion) => criterion.text);
  }
  return createGoalCriteria(
    goal.definitionOfDone?.length ? goal.definitionOfDone : extractGoalDefinitionOfDone(goal.rawText || goal.objective),
  );
}

export function migrateGoalDefinition(goal: GoalDefinition): GoalDefinition {
  const rawText = String(goal.rawText || goal.objective || "").trim();
  const definitionOfDone = normalizeGoalDefinitionOfDone(
    goal.definitionOfDone?.length ? goal.definitionOfDone : extractGoalDefinitionOfDone(rawText),
  );
  return {
    ...goal,
    schemaVersion: 2,
    objective: String(goal.objective || rawText).trim(),
    rawText,
    definitionOfDone,
    criteria: normalizeGoalCriteria({ ...goal, definitionOfDone }),
    constraints: Array.isArray(goal.constraints) ? goal.constraints : extractGoalConstraints(rawText),
    verificationHints: Array.isArray(goal.verificationHints) ? goal.verificationHints : extractGoalVerificationHints(rawText),
    revision: Math.max(1, Number(goal.revision) || 1),
    updatedAt: Number(goal.updatedAt) || goal.createdAt || Date.now(),
  };
}

export function updateGoalDefinitionText(goal: GoalDefinition, rawText: string): GoalDefinition {
  const objective = rawText.trim();
  const definitionOfDone = extractGoalDefinitionOfDone(objective);
  return {
    ...migrateGoalDefinition(goal),
    objective,
    rawText: objective,
    definitionOfDone,
    criteria: createGoalCriteria(definitionOfDone),
    constraints: extractGoalConstraints(objective),
    verificationHints: extractGoalVerificationHints(objective),
    revision: Math.max(1, Number(goal.revision) || 1) + 1,
    updatedAt: Date.now(),
    status: "paused",
  };
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
