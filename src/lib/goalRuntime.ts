import type { GoalBudget } from "./goalBudget";
import {
  migrateGoalDefinition,
  normalizeGoalCriteria,
  type GoalCriterion,
  type GoalDefinition,
  type GoalEvidenceEntry,
  type GoalEvidenceKind,
  type GoalProgress,
  type GoalRuntimeSnapshot,
} from "./goalState";
import { isReadOnlyShellInspectionToolCall } from "./repetitionGuard";

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

const FILE_MUTATION_TOOLS = new Set([
  "write_file",
  "replace_in_file",
  "create_file",
  "apply_diff",
  "apply_patch",
  "insert_content",
  "delete_workspace_path",
]);

const READ_TOOLS = new Set([
  "read_file",
  "read_document",
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_search",
  "repo_map_context",
  "knowledge_search",
  "knowledge_get_excerpt",
]);

const COMMAND_TOOLS = new Set(["run_command", "execute_command", "send_pty_input"]);
const TEST_COMMAND_RE = /\b(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|pytest|python\s+-m\s+pytest|cargo\s+test|go\s+test|jest|vitest|playwright\s+test)\b/i;
const BUILD_COMMAND_RE = /\b(?:npm\s+run\s+(?:build|lint|typecheck)|pnpm\s+(?:run\s+)?(?:build|lint|typecheck)|yarn\s+(?:build|lint|typecheck)|tsc\b|cargo\s+(?:build|check)|go\s+build)\b/i;

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

function inferEvidenceKind(observation: GoalToolObservation, target: string): GoalEvidenceKind {
  if (FILE_MUTATION_TOOLS.has(observation.name)) return "file_change";
  if (READ_TOOLS.has(observation.name)) return "read";
  if (COMMAND_TOOLS.has(observation.name)) {
    if (TEST_COMMAND_RE.test(target)) return "test";
    if (BUILD_COMMAND_RE.test(target)) return "build";
    if (isReadOnlyShellInspectionToolCall(
      observation.name,
      observation.arguments || (target ? { command: target } : {}),
    )) return "read";
    return "command";
  }
  if (/(?:browser|playwright|puppeteer|cypress)/i.test(observation.name)) return "browser";
  if (observation.name.startsWith("mcp_") || observation.name.includes("__")) return "mcp";
  return "command";
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
  return input.observations.map((observation, index) => {
    const target = resolveGoalToolTarget(observation);
    const success = isGoalToolResultSuccessful(observation.result, observation.success);
    const kind = inferEvidenceKind(observation, target);
    return {
      id: `goal_evidence_${input.iteration}_${createdAt}_${index + 1}`,
      goalId: goal.id,
      goalRevision: goal.revision || 1,
      iteration: input.iteration,
      kind,
      status: kind === "read" && success ? "observed" : success ? "passed" : "failed",
      sourceTool: observation.name,
      target,
      summary: compactEvidenceSummary(observation.result, `${observation.name}${target ? `: ${target}` : ""}`),
      references: kind === "file_change" && target ? [target] : [],
      createdAt: createdAt + index,
    };
  });
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

export function evaluateGoalCompletion(input: {
  goal: GoalDefinition;
  evidence: GoalEvidenceEntry[];
  completionCandidate: boolean;
  unresolvedBlockers?: string[];
}): GoalCompletionGateResult {
  const goal = migrateGoalDefinition(input.goal);
  const reasons: string[] = [];
  const freshEvidence = input.evidence.filter((entry) => evidenceIsFresh(goal, entry));
  const successfulEvidence = freshEvidence.filter((entry) => entry.status !== "failed" && entry.kind !== "blocker");
  const mutationEvidence = successfulEvidence.filter((entry) => entry.kind === "file_change");
  const verificationEvidence = successfulEvidence.filter((entry) =>
    entry.kind === "test" || entry.kind === "build" || entry.kind === "browser" || entry.kind === "user_validation"
  );
  const failedVerification = freshEvidence.filter((entry) => {
    if (entry.status !== "failed" || !(
      entry.kind === "test" || entry.kind === "build" || entry.kind === "browser" || entry.kind === "command"
    )) return false;
    return !freshEvidence.some((candidate) =>
      candidate.createdAt > entry.createdAt
      && candidate.status !== "failed"
      && candidate.kind === entry.kind
      && candidate.target === entry.target
    );
  });

  if (!input.completionCandidate) reasons.push("model_has_not_proposed_completion");
  if (successfulEvidence.length === 0) reasons.push("no_fresh_execution_evidence");
  if (goalRequiresMutation(goal) && mutationEvidence.length === 0) reasons.push("mutation_evidence_required");
  if ((goalRequiresMutation(goal) || goalExplicitlyRequiresVerification(goal)) && verificationEvidence.length === 0) {
    reasons.push("verification_evidence_required");
  }
  if (failedVerification.length > 0) reasons.push("verification_failed");
  if ((input.unresolvedBlockers || []).some((item) => String(item || "").trim())) reasons.push("unresolved_blockers");

  const supportingEvidenceIds = successfulEvidence.map((entry) => entry.id);
  const criteria = normalizeGoalCriteria(goal).map((criterion) => ({
    ...criterion,
    status: reasons.length === 0 ? "satisfied" as const : criterion.status === "satisfied" ? "invalidated" as const : criterion.status,
    evidenceIds: reasons.length === 0 ? supportingEvidenceIds : criterion.evidenceIds,
  }));

  return {
    passed: reasons.length === 0,
    reasons,
    criteria,
    supportingEvidenceIds,
  };
}

export function buildGoalBudgetOverrides(goal: GoalDefinition): Partial<GoalBudget> {
  return {
    maxIterations: goal.iterationBudget,
    maxTokens: goal.tokenBudget,
    maxDurationMs: goal.maxDurationMs,
  };
}

export function buildGoalRuntimeSnapshot(input: {
  goal: GoalDefinition;
  progress: GoalProgress;
  phase?: GoalRuntimeSnapshot["phase"];
  pauseReason?: string;
  lastError?: string;
}): GoalRuntimeSnapshot {
  const goal = migrateGoalDefinition(input.goal);
  return {
    schemaVersion: 2,
    goal,
    progress: {
      ...input.progress,
      evidence: input.progress.evidence || [],
      milestones: input.progress.milestones || [],
      currentMilestoneId: input.progress.currentMilestoneId ?? null,
    },
    status: goal.status,
    phase: input.phase ?? null,
    pauseReason: input.pauseReason,
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
  const status = snapshot.status || goal.status;
  return {
    ...snapshot,
    goal: { ...goal, status },
    progress: {
      ...snapshot.progress,
      evidence: [...(snapshot.progress.evidence || [])],
      milestones: [...(snapshot.progress.milestones || [])],
      usage: snapshot.progress.usage ? { ...snapshot.progress.usage } : undefined,
    },
    status,
  };
}
