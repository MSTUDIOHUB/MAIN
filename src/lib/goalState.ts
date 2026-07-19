// lib/goalState.ts
// Goal lifecycle data model for MAIN's /目标 (Goal Mode).
// Tracks goal definition, iteration progress, and checkpoints.
// ────────────────────────────────────────────────────────────────────

import type {
  ExecuteRecoveryContractPhase,
  ExecuteRecoveryMode,
  ExecutionDecisionCheckpoint,
  RecoveryReadLease,
} from "./executeRecoveryTools";
import {
  normalizeSubagentDelegationPreference,
  resolveEffectiveSubagentDelegationPreference,
  type SubagentDelegationPreference,
} from "./turnIntake";
import type {
  AgentLoopPauseKind,
  AgentLoopResultKind,
  LegacyAgentLoopOutcomeStatus,
} from "./runOutcome";

export type GoalStatus =
  | "active"           // Currently executing
  | "pausing"          // Abort/checkpoint requested; waiting for a safe boundary
  | "paused"           // User paused or checkpoint reached
  | "awaiting_input"   // A permission, decision, or external validation is required
  | "blocked"          // Same normalized recoverable cause repeated to the safety threshold
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

/** Machine-readable reason for the latest internal continuation or outer boundary. */
export type GoalStopClass =
  | "completed"
  | "evidence_missing"
  | "slice_budget_exhausted"
  | "recoverable_error"
  | "no_progress"
  | "awaiting_input"
  | "user_paused"
  | "cancelled"
  | "unrecoverable_error"
  | "total_slice_budget_exhausted"
  | "token_budget_exhausted"
  | "tool_call_budget_exhausted"
  | "duration_budget_exhausted"
  | "blocked"
  | "migration_review_required";

export const GOAL_SCHEMA_VERSION = 3 as const;
export const GOAL_SOURCE_CONTEXT_MAX_CHARS = 6_000;
/**
 * Compatibility-only emergency guard for internal continuation boundaries.
 * It is not a task estimate and must not be presented as user progress.
 */
export const DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT = 200;

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
  | "desktop"
  | "mcp"
  | "user_validation"
  | "blocker"
  | "unknown";

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
  /** Completion criteria this evidence can support. Added in Goal schema v3. */
  criterionIds?: string[];
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

export interface GoalIterationUsage {
  modelIterations: number;
  toolCalls: number;
  tokensUsed: number;
  estimatedTokens: boolean;
}

export interface GoalRecoveryState {
  normalizedCause: string;
  consecutiveCount: number;
  lastReason: string;
  updatedAt: number;
}

export interface GoalContinuationToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * A persisted, provider-neutral message from the active Goal conversation.
 * Reasoning fields are deliberately excluded; visible conclusions and complete
 * tool call/result pairs are enough to continue the work safely.
 */
export interface GoalContinuationMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: GoalContinuationToolCall[];
  tool_call_id?: string;
}

export interface GoalContinuationState {
  sourceIteration: number;
  updatedAt: number;
  messages: GoalContinuationMessage[];
  /** Durable compact memory used when older exact messages leave the context window. */
  memoryPacket?: string;
  messageCountBefore: number;
  compacted: boolean;
  operationCount: number;
  /** Exact provider-neutral recovery transaction captured at the slice boundary. */
  executeRecoveryState?: {
    mode: ExecuteRecoveryMode;
    reason: string;
    expectedTarget: string | null;
    /** Recovery activations already spent before this Goal continuation. */
    attempts?: number;
    /** Derived contract phase retained for diagnostics and schema consistency. */
    phase?: ExecuteRecoveryContractPhase;
    /** Consecutive no-progress turns in this phase, not a transaction-wide budget. */
    phaseNoProgressCount?: number;
    /** Monotonic retries of the same semantic request, separate from tool failures. */
    protocolNoProgressCount?: number;
    protocolNoProgressFingerprint?: string | null;
    /** Exact source read permission/identity carried across Goal slice boundaries. */
    readLease?: RecoveryReadLease | null;
    sourceObservationKey?: string | null;
    /** Evidence identity and required next capability for deterministic resume. */
    decisionCheckpoint?: ExecutionDecisionCheckpoint | null;
  };
}

export interface GoalOperationSummary {
  iteration: number;
  tool: string;
  target: string;
  status: GoalEvidenceStatus;
  summary: string;
}

export interface GoalDefinition {
  /** Persistence schema version. Missing means legacy v1. */
  schemaVersion?: 1 | 2 | 3;
  /** Unique goal ID */
  id: string;
  /** User-defined objective text */
  objective: string;
  /** Verbatim user-authored goal contract. */
  rawText?: string;
  /** Bounded runtime-supplied context kept separate from the canonical objective. */
  sourceContext?: string;
  /** Effective user/session delegation preference retained across continuations. */
  subagentPreference?: SubagentDelegationPreference;
  /** A polluted legacy objective was canonicalized and must be reviewed before resume. */
  migrationReviewRequired?: boolean;
  /** A referential objective could not be expanded into auditable criteria. */
  criteriaReviewRequired?: boolean;
  /** Completion criteria (auto-extracted or user-specified) */
  definitionOfDone: string[];
  /** Evidence-aware completion criteria used by Goal Runtime v3. */
  criteria?: GoalCriterion[];
  constraints?: string[];
  verificationHints?: string[];
  revision?: number;
  updatedAt?: number;
  /** Timestamp when the goal was created */
  createdAt: number;
  /** Current goal status */
  status: GoalStatus;
  /**
   * Legacy/internal emergency continuation limit. This is not an estimate of
   * work size and must not be rendered as n/total progress.
   */
  iterationBudget: number;
  /** Optional total token budget */
  tokenBudget?: number;
  /** Optional total tool-call budget */
  toolCallBudget?: number;
  /** Optional max duration in milliseconds */
  maxDurationMs?: number;
  /** Session key associated with this goal */
  sessionKey?: string;
  /** Logical conversation turn that owns every resume and internal continuation. */
  ownerTurnId?: string;
}

export interface GoalIteration {
  /** Iteration index (1-based) */
  index: number;
  /** Current phase within this iteration */
  phase: GoalIterationPhase;
  /** Stable identity for the child run that continues the same logical Goal task. */
  goalSliceId?: string;
  /** Goal definition revision that produced this continuation. */
  goalRevision?: number;
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
  /** Exact inner-loop outcome and stop reason for this internal continuation. */
  innerOutcomeStatus?: LegacyAgentLoopOutcomeStatus;
  innerOutcomeResultKind?: AgentLoopResultKind;
  innerOutcomePauseKind?: AgentLoopPauseKind;
  stopReason?: string;
  stopClass?: GoalStopClass;
  usage?: GoalIterationUsage;
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
  /** Most recent visible model conclusions, compacted without hidden reasoning. */
  lastAssistantContext?: string;
  /** Recent structured tool operations, retained independently of prose quality. */
  recentOperations?: GoalOperationSummary[];
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
  /** Structured evidence, recovery state, and milestones for Goal Runtime v3. */
  evidence?: GoalEvidenceEntry[];
  milestones?: GoalMilestone[];
  currentMilestoneId?: string | null;
  lastUserConfirmedIteration?: number;
  pauseReason?: string;
  lastStopReason?: string;
  /** Exact normalized class for the latest continuation or outer-loop stop. */
  stopClass?: GoalStopClass;
  recoveryState?: GoalRecoveryState;
  /** Exact recent conversation plus durable compact memory for the next continuation. */
  continuation?: GoalContinuationState;
  /** Earlier iterations remain history but do not count toward a resumed blocked audit. */
  recoveryAuditStartIteration?: number;
  usage?: GoalUsage;
}

export interface GoalRuntimeSnapshot {
  schemaVersion: 3;
  goal: GoalDefinition;
  progress: GoalProgress;
  status: GoalStatus;
  phase: GoalIterationPhase | null;
  pauseReason?: string;
  stopClass?: GoalStopClass;
  lastError?: string;
  updatedAt: number;
}

export interface GoalTurnContract {
  goalId: string;
  goalSliceId: string;
  /** Canonical user-authored objective retained across internal continuations. */
  objective: string;
  subagentPreference: SubagentDelegationPreference;
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
  /** Aggregate real loop counters plus explicitly marked token estimates. */
  usage?: GoalUsage;
  /** Exact stop reason reported by the last inner continuation. */
  lastStopReason?: string;
  stopClass?: GoalStopClass;
}

// ── Factory helpers ──────────────────────────────────────────────

let goalIdCounter = 0;

function generateGoalId(): string {
  goalIdCounter += 1;
  return `goal_${Date.now()}_${goalIdCounter}`;
}

function finitePositiveInt(value: unknown, fallback?: number): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return fallback;
  return Math.max(1, Math.floor(numberValue));
}

export function createGoalDefinition(input: {
  objective: string;
  sourceContext?: string;
  subagentPreference?: SubagentDelegationPreference;
  definitionOfDone?: string[];
  iterationBudget?: number;
  tokenBudget?: number;
  toolCallBudget?: number;
  maxDurationMs?: number;
  sessionKey?: string;
  ownerTurnId?: string;
}): GoalDefinition {
  const canonicalInput = canonicalizeGoalInput(input.objective, input.sourceContext);
  const objective = canonicalInput.objective;
  const sourceCriteria = extractGoalDefinitionOfDoneFromSourceContext(canonicalInput.sourceContext || "");
  const referentialObjective = isReferentialGoalObjective(objective);
  const definitionOfDone = normalizeGoalDefinitionOfDone(
    input.definitionOfDone?.length
      ? input.definitionOfDone
      : referentialObjective && sourceCriteria.length > 0
        ? sourceCriteria
        : extractGoalDefinitionOfDone(objective),
  );
  const criteriaReviewRequired = referentialObjective && sourceCriteria.length === 0 && !input.definitionOfDone?.length;
  return {
    schemaVersion: GOAL_SCHEMA_VERSION,
    id: generateGoalId(),
    objective,
    rawText: objective,
    sourceContext: canonicalInput.sourceContext,
    subagentPreference: resolveEffectiveSubagentDelegationPreference({
      rawUserInput: objective,
      defaultPreference: input.subagentPreference,
    }),
    criteriaReviewRequired,
    definitionOfDone,
    criteria: createGoalCriteria(definitionOfDone),
    constraints: extractGoalConstraints(objective),
    verificationHints: extractGoalVerificationHints(objective),
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: criteriaReviewRequired ? "awaiting_input" : "active",
    iterationBudget: Math.min(
      finitePositiveInt(input.iterationBudget, DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT)
        || DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
      500,
    ),
    tokenBudget: finitePositiveInt(input.tokenBudget),
    toolCallBudget: finitePositiveInt(input.toolCallBudget),
    maxDurationMs: finitePositiveInt(input.maxDurationMs),
    sessionKey: input.sessionKey,
    ownerTurnId: String(input.ownerTurnId || "").trim() || undefined,
  };
}

export function buildGoalSliceId(goalId: string, iteration: number): string {
  return `${String(goalId || "goal")}:slice:${Math.max(1, Math.floor(Number(iteration) || 1))}`;
}

export function createGoalIteration(index: number, goalId?: string, goalRevision = 1): GoalIteration {
  return {
    index,
    phase: "execute",
    goalSliceId: goalId ? buildGoalSliceId(goalId, index) : undefined,
    goalRevision: Math.max(1, Number(goalRevision) || 1),
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
    recoveryAuditStartIteration: 0,
  };
}

function sanitizeGoalSourceContext(value: string): string {
  const raw = String(value || "").trim();
  if (!/\[turn_intake\]/i.test(raw)) return raw;
  const intakeStart = raw.search(/\[turn_intake\]/i);
  const beforeIntake = intakeStart > 0 ? raw.slice(0, intakeStart).trim() : "";
  const intake = raw.match(/\[turn_intake\]([\s\S]*?)\[\/turn_intake\]/i)?.[1] || "";
  const metadata = intake
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:workflowMode|imageParts|mentionedFiles|attachedFiles|@file|attachment)\s*:/i.test(line));
  return [beforeIntake, metadata.length > 0 ? `[turn_context]\n${metadata.join("\n")}\n[/turn_context]` : ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function normalizeGoalSourceContext(value: string): string | undefined {
  const normalized = sanitizeGoalSourceContext(value);
  if (!normalized) return undefined;
  if (normalized.length <= GOAL_SOURCE_CONTEXT_MAX_CHARS) return normalized;
  const marker = "\n...[goal source context truncated]...\n";
  const remaining = GOAL_SOURCE_CONTEXT_MAX_CHARS - marker.length;
  const headLength = Math.max(1, Math.floor(remaining * 0.65));
  const tailLength = Math.max(1, remaining - headLength);
  return `${normalized.slice(0, headLength)}${marker}${normalized.slice(-tailLength)}`;
}

function extractCanonicalGoalObjective(value: string): string {
  const raw = String(value || "").trim();
  const marked = raw.match(/\[user_request\]\s*([\s\S]*?)\s*\[\/user_request\]/i);
  if (marked?.[1]?.trim()) return marked[1].trim();
  return raw;
}

export function canonicalizeGoalInput(
  objectiveInput: string,
  sourceContextInput?: string,
): { objective: string; sourceContext?: string } {
  const original = String(objectiveInput || "").trim();
  const objective = extractCanonicalGoalObjective(original);
  const explicitSourceContext = String(sourceContextInput || "").trim();
  const derivedSourceContext = objective !== original ? original : "";
  return {
    objective,
    sourceContext: normalizeGoalSourceContext(explicitSourceContext || derivedSourceContext),
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
  lastAssistantContext?: string;
  recentOperations?: GoalOperationSummary[];
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
    lastAssistantContext: input.lastAssistantContext,
    recentOperations: input.recentOperations,
  };
}

// ── Status predicates ────────────────────────────────────────────

export function isGoalTerminal(status: GoalStatus): boolean {
  return status === "completed" || status === "failed" || status === "blocked" || status === "budget_exceeded" || status === "cancelled";
}

export function isGoalRunnable(status: GoalStatus): boolean {
  return status === "active" || status === "paused" || status === "awaiting_input" || status === "blocked";
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
    blocked: { zh: "已阻塞", en: "Blocked" },
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

const REFERENTIAL_GOAL_RE = /(?:这些|上述|前述|上面的|刚才的|前面提到的)(?:问题|事项|任务|修复)?|(?:fix|resolve|complete|continue|address)\s+(?:these|those|the above|them|the previous (?:issues|items|tasks))/i;
const SOURCE_CRITERION_ACTION_RE = /(?:implement|fix|repair|refactor|migrate|update|modify|change|create|write|remove|delete|test|build|verify|validate|ensure|prevent|实现|修复|重构|迁移|更新|修改|创建|编写|删除|测试|构建|验证|确保|避免|保留|支持)/i;

export function isReferentialGoalObjective(objective: string): boolean {
  return REFERENTIAL_GOAL_RE.test(String(objective || "").trim());
}

function extractCriteriaLines(section: string): string[] {
  return String(section || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+(?:\[[ xX]\]\s*)?|^\d+[.)]\s+/.test(line))
    .map((line) => line
      .replace(/^[-*]\s+(?:\[[ xX]\]\s*)?/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim())
    .filter((line) => line.length >= 4 && line.length <= 320)
    .filter((line) => SOURCE_CRITERION_ACTION_RE.test(line) || /(?:[\w.-]+\/[\w./-]+|\.[a-z0-9]{1,8}\b)/i.test(line));
}

/** Expand deictic goals such as "fix these issues" from bounded durable/Plan context. */
export function extractGoalDefinitionOfDoneFromSourceContext(sourceContext: string): string[] {
  const source = String(sourceContext || "");
  if (!source.trim()) return [];
  const preferredSections = [
    ...source.matchAll(/\[unfinished_criteria\]([\s\S]*?)(?:\[\/unfinished_criteria\]|(?=\n\[[a-z_]+[^\]]*\])|$)/gi),
    ...source.matchAll(/\[plan_artifact[^\]]*\]([\s\S]*?)(?:\[\/plan_artifact\]|(?=\n\[[a-z_]+[^\]]*\])|$)/gi),
  ].map((match) => match[1] || "");
  const preferred = normalizeGoalDefinitionOfDone(preferredSections.flatMap(extractCriteriaLines));
  if (preferred.length > 0) return preferred;

  const humanSections = [
    ...source.matchAll(/\[(?:prior_user|prior_assistant_summary|prior_turn_final)\]([\s\S]*?)\[\/(?:prior_user|prior_assistant_summary|prior_turn_final)\]/gi),
  ].map((match) => match[1] || "");
  return normalizeGoalDefinitionOfDone(humanSections.flatMap(extractCriteriaLines));
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
  const legacyObjective = String(goal.objective || goal.rawText || "").trim();
  const legacyRawText = String(goal.rawText || legacyObjective).trim();
  const canonicalInput = canonicalizeGoalInput(
    legacyObjective,
    goal.sourceContext || (legacyRawText !== legacyObjective ? legacyRawText : undefined),
  );
  const objective = canonicalInput.objective;
  const canonicalRawText = extractCanonicalGoalObjective(legacyRawText) || objective;
  const pollutedLegacyDefinition = goal.schemaVersion !== GOAL_SCHEMA_VERSION
    && /\[turn_intake\]/i.test(`${legacyObjective}\n${legacyRawText}`)
    && (objective !== legacyObjective || canonicalRawText !== legacyRawText);
  const rawText = canonicalRawText || objective;
  const sourceCriteria = extractGoalDefinitionOfDoneFromSourceContext(canonicalInput.sourceContext || "");
  const referentialObjective = isReferentialGoalObjective(objective);
  const legacyDefinitionIsOnlyReference = goal.definitionOfDone?.length === 1 &&
    String(goal.definitionOfDone[0] || "").trim() === objective;
  const legacyCriteriaOnlyReference = goal.criteria?.length === 1 &&
    String(goal.criteria[0]?.text || "").trim() === objective;
  const expandedReferentialCriteria = referentialObjective && sourceCriteria.length > 0 &&
    (legacyDefinitionIsOnlyReference || legacyCriteriaOnlyReference);
  const definitionOfDone = normalizeGoalDefinitionOfDone(
    pollutedLegacyDefinition
      ? extractGoalDefinitionOfDone(rawText)
      : goal.definitionOfDone?.length && !(referentialObjective && sourceCriteria.length > 0 && legacyDefinitionIsOnlyReference)
        ? goal.definitionOfDone
        : referentialObjective && sourceCriteria.length > 0
          ? sourceCriteria
        : extractGoalDefinitionOfDone(rawText),
  );
  const criteriaReviewRequired = (goal.criteriaReviewRequired === true && sourceCriteria.length === 0) || (
    referentialObjective &&
    sourceCriteria.length === 0 &&
    (!goal.definitionOfDone?.length || goal.definitionOfDone.every((item) => item.trim() === objective))
  );
  const revision = Math.max(1, Number(goal.revision) || 1) +
    (pollutedLegacyDefinition || expandedReferentialCriteria ? 1 : 0);
  return {
    ...goal,
    schemaVersion: GOAL_SCHEMA_VERSION,
    objective,
    rawText,
    sourceContext: canonicalInput.sourceContext,
    subagentPreference: goal.subagentPreference
      ? normalizeSubagentDelegationPreference(goal.subagentPreference)
      : resolveEffectiveSubagentDelegationPreference({ rawUserInput: objective }),
    migrationReviewRequired: pollutedLegacyDefinition || goal.migrationReviewRequired === true,
    criteriaReviewRequired,
    definitionOfDone,
    criteria: pollutedLegacyDefinition || expandedReferentialCriteria
      ? createGoalCriteria(definitionOfDone)
      : normalizeGoalCriteria({ ...goal, definitionOfDone }),
    constraints: pollutedLegacyDefinition || !Array.isArray(goal.constraints)
      ? extractGoalConstraints(rawText)
      : goal.constraints,
    verificationHints: pollutedLegacyDefinition || !Array.isArray(goal.verificationHints)
      ? extractGoalVerificationHints(rawText)
      : goal.verificationHints,
    iterationBudget: Math.min(
      finitePositiveInt(goal.iterationBudget, DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT)
        || DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
      500,
    ),
    tokenBudget: finitePositiveInt(goal.tokenBudget),
    toolCallBudget: finitePositiveInt(goal.toolCallBudget),
    maxDurationMs: finitePositiveInt(goal.maxDurationMs),
    revision,
    updatedAt: pollutedLegacyDefinition || expandedReferentialCriteria
      ? Date.now()
      : Number(goal.updatedAt) || goal.createdAt || Date.now(),
    status: pollutedLegacyDefinition
      ? "paused"
      : criteriaReviewRequired && goal.status === "active"
        ? "awaiting_input"
        : goal.status,
  };
}

export function updateGoalDefinitionText(goal: GoalDefinition, rawText: string): GoalDefinition {
  const canonicalInput = canonicalizeGoalInput(rawText);
  const objective = canonicalInput.objective;
  const sourceContext = canonicalInput.sourceContext || goal.sourceContext;
  const sourceCriteria = extractGoalDefinitionOfDoneFromSourceContext(sourceContext || "");
  const criteriaReviewRequired = isReferentialGoalObjective(objective) && sourceCriteria.length === 0;
  const definitionOfDone = isReferentialGoalObjective(objective) && sourceCriteria.length > 0
    ? sourceCriteria
    : extractGoalDefinitionOfDone(objective);
  return {
    ...migrateGoalDefinition(goal),
    objective,
    rawText: objective,
    sourceContext,
    subagentPreference: resolveEffectiveSubagentDelegationPreference({
      rawUserInput: objective,
      defaultPreference: goal.subagentPreference,
    }),
    migrationReviewRequired: false,
    criteriaReviewRequired,
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
