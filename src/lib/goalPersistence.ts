// lib/goalPersistence.ts
// File-system persistence for Goal Mode progress.
// Writes goal state to .MAIN/goals/ directory so progress survives
// app restarts, crashes, or context window resets.
// ────────────────────────────────────────────────────────────────────

import type {
  GoalCheckpoint,
  GoalDefinition,
  GoalProgress,
  GoalRuntimeSnapshot,
} from "./goalState";
import { buildGoalStatusLabel, migrateGoalDefinition, normalizeGoalCriteria, summarizeGoalIteration } from "./goalState";
import { normalizeGoalRuntimeSnapshot } from "./goalRuntime";

export const GOAL_DIR_NAME = "goals";
export const GOAL_ACTIVE_FILE = "active-goal.json";
export const GOAL_PROGRESS_FILE = "progress.md";
export const GOAL_CHECKPOINT_DIR = "checkpoints";
export const GOAL_STATE_FILE = "state.json";
export const GOAL_EVIDENCE_FILE = "evidence.jsonl";
export const GOAL_DELETION_FENCE_DIR = ".deleted";

const SAFE_GOAL_ID_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const deletedGoalRuntimeKeys = new Set<string>();
const liveGoalDeletionFenceKeys = new Set<string>();

function normalizeGoalRuntimeDeletionKey(workspacePath: string, goalId: string): string {
  return `${String(workspacePath || "").trim()}\0${assertSafeGoalIdPathSegment(goalId)}`;
}

/** Goal ids are persisted as a single directory segment. Never let restored or
 * UI-supplied state turn that segment into an absolute or traversing path. */
export function assertSafeGoalIdPathSegment(goalId: string): string {
  const normalized = String(goalId || "");
  if (!SAFE_GOAL_ID_PATH_SEGMENT_RE.test(normalized)) {
    throw new Error("Invalid Goal id path segment");
  }
  return normalized;
}

/** Relative path is intentional: delete_workspace_path resolves it against the
 * captured workspace and applies its existing workspace-containment check. */
export function resolveGoalRuntimeRelativeDirPath(goalId: string): string {
  return `.MAIN/${GOAL_DIR_NAME}/${assertSafeGoalIdPathSegment(goalId)}`;
}

export function resolveGoalDeletionFenceDirPath(): string {
  return `.MAIN/${GOAL_DIR_NAME}/${GOAL_DELETION_FENCE_DIR}`;
}

export function resolveGoalDeletionFenceRelativePath(goalId: string): string {
  return `${resolveGoalDeletionFenceDirPath()}/${assertSafeGoalIdPathSegment(goalId)}.json`;
}

export function serializeGoalDeletionFence(input: {
  goalId: string;
  ownerSessionKey: string;
  deletedAt: number;
}): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    goalId: assertSafeGoalIdPathSegment(input.goalId),
    ownerSessionKey: String(input.ownerSessionKey || "").trim(),
    deletedAt: Math.max(0, Number(input.deletedAt) || Date.now()),
  }, null, 2)}\n`;
}

export interface GoalDeletionFence {
  schemaVersion: 1;
  goalId: string;
  ownerSessionKey: string;
  deletedAt: number;
}

export function deserializeGoalDeletionFence(
  json: string,
  expectedGoalId?: string,
): GoalDeletionFence | null {
  try {
    const parsed = JSON.parse(json) as Partial<GoalDeletionFence>;
    const goalId = assertSafeGoalIdPathSegment(String(parsed.goalId || ""));
    const ownerSessionKey = String(parsed.ownerSessionKey || "").trim();
    const deletedAt = Number(parsed.deletedAt);
    if (
      parsed.schemaVersion !== 1 ||
      (expectedGoalId && goalId !== assertSafeGoalIdPathSegment(expectedGoalId)) ||
      !ownerSessionKey ||
      !Number.isFinite(deletedAt) ||
      deletedAt <= 0
    ) {
      return null;
    }
    return { schemaVersion: 1, goalId, ownerSessionKey, deletedAt };
  } catch {
    return null;
  }
}

/** Marker filenames are sufficient identity: they are workspace-contained,
 * validated as one safe segment, and created only before destructive delete. */
export function registerGoalDeletionFenceEntries(
  workspacePath: string,
  entries: Array<{ name?: string; is_dir?: boolean }>,
): string[] {
  const registered: string[] = [];
  for (const entry of entries) {
    if (entry?.is_dir || typeof entry?.name !== "string" || !entry.name.endsWith(".json")) {
      continue;
    }
    const goalId = entry.name.slice(0, -5);
    try {
      markGoalRuntimeDeleted(workspacePath, goalId);
      registered.push(goalId);
    } catch {
      // Ignore malformed or traversing marker names.
    }
  }
  return registered;
}

/** A deletion tombstone closes the race where an aborted Goal loop finishes a
 * late persistence callback after the user has requested deletion. */
export function markGoalRuntimeDeleted(
  workspacePath: string,
  goalId: string,
  options?: { retainFenceForProcess?: boolean },
): void {
  const key = normalizeGoalRuntimeDeletionKey(workspacePath, goalId);
  deletedGoalRuntimeKeys.add(key);
  if (options?.retainFenceForProcess) {
    liveGoalDeletionFenceKeys.add(key);
  }
}

export function unmarkGoalRuntimeDeleted(workspacePath: string, goalId: string): void {
  const key = normalizeGoalRuntimeDeletionKey(workspacePath, goalId);
  deletedGoalRuntimeKeys.delete(key);
  liveGoalDeletionFenceKeys.delete(key);
}

export function isGoalRuntimeDeleted(workspacePath: string, goalId: string): boolean {
  try {
    return deletedGoalRuntimeKeys.has(normalizeGoalRuntimeDeletionKey(workspacePath, goalId));
  } catch {
    return true;
  }
}

/** A fence created by this live process must survive until restart. Session
 * autosaves are asynchronous and an older in-flight write can finish after
 * the explicit cleared-session save. The next process has no entry in this
 * set, so startup recovery can safely scrub the final on-disk snapshot and
 * remove the fence. */
export function shouldRetainGoalDeletionFenceForCurrentProcess(
  workspacePath: string,
  goalId: string,
): boolean {
  try {
    return liveGoalDeletionFenceKeys.has(
      normalizeGoalRuntimeDeletionKey(workspacePath, goalId),
    );
  } catch {
    return true;
  }
}

// ── Path helpers ─────────────────────────────────────────────────

export function resolveGoalDirPath(workspacePath: string): string {
  return `${workspacePath}/.MAIN/${GOAL_DIR_NAME}`;
}

export function resolveGoalActiveFilePath(workspacePath: string): string {
  return `${resolveGoalDirPath(workspacePath)}/${GOAL_ACTIVE_FILE}`;
}

export function resolveGoalProgressFilePath(workspacePath: string): string {
  return `${resolveGoalDirPath(workspacePath)}/${GOAL_PROGRESS_FILE}`;
}

export function resolveGoalRuntimeDirPath(workspacePath: string, goalId: string): string {
  return `${resolveGoalDirPath(workspacePath)}/${assertSafeGoalIdPathSegment(goalId)}`;
}

export function resolveGoalRuntimeStateFilePath(workspacePath: string, goalId: string): string {
  return `${resolveGoalRuntimeDirPath(workspacePath, goalId)}/${GOAL_STATE_FILE}`;
}

export function resolveGoalRuntimeProgressFilePath(workspacePath: string, goalId: string): string {
  return `${resolveGoalRuntimeDirPath(workspacePath, goalId)}/${GOAL_PROGRESS_FILE}`;
}

export function resolveGoalEvidenceFilePath(workspacePath: string, goalId: string): string {
  return `${resolveGoalRuntimeDirPath(workspacePath, goalId)}/${GOAL_EVIDENCE_FILE}`;
}

export function resolveGoalCheckpointFilePath(workspacePath: string, iteration: number): string {
  const paddedIndex = String(iteration).padStart(3, "0");
  return `${resolveGoalDirPath(workspacePath)}/${GOAL_CHECKPOINT_DIR}/checkpoint-${paddedIndex}.json`;
}

// ── Serialization: Active Goal ───────────────────────────────────

export function serializeGoalDefinition(goal: GoalDefinition): string {
  return JSON.stringify(goal, null, 2);
}

export function deserializeGoalDefinition(json: string): GoalDefinition | null {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || !parsed.id || !parsed.objective) return null;
    return migrateGoalDefinition(parsed as GoalDefinition);
  } catch {
    return null;
  }
}

// ── Serialization: Checkpoint ────────────────────────────────────

export function serializeGoalCheckpoint(checkpoint: GoalCheckpoint): string {
  return JSON.stringify(checkpoint, null, 2);
}

export function deserializeGoalCheckpoint(json: string): GoalCheckpoint | null {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || typeof parsed.iteration !== "number") return null;
    return parsed as GoalCheckpoint;
  } catch {
    return null;
  }
}

// ── Progress markdown generation ─────────────────────────────────

export function buildGoalProgressMarkdown(input: {
  goal: GoalDefinition;
  progress: GoalProgress;
  language: "zh" | "en";
}): string {
  const { goal, progress, language } = input;
  const isZh = language === "zh";
  const lines: string[] = [];

  // Title
  lines.push(`# ${isZh ? "目标" : "Goal"}: ${goal.objective}`);
  lines.push("");

  // Status
  const statusLabel = buildGoalStatusLabel(goal.status, language);
  lines.push(`## ${isZh ? "当前状态" : "Current Status"}`);
  lines.push(`- ${isZh ? "状态" : "Status"}: ${statusLabel}`);
  lines.push(`- ${isZh ? "内部连续执行" : "Internal continuations"}: ${progress.currentIteration}`);
  if (progress.lastStopReason) {
    lines.push(`- ${isZh ? "最近停止原因" : "Last stop reason"}: ${progress.lastStopReason}`);
  }
  if (progress.usage) {
    lines.push(`- ${isZh ? "模型轮次" : "Model iterations"}: ${progress.usage.modelIterations}`);
    lines.push(`- ${isZh ? "工具调用" : "Tool calls"}: ${progress.usage.toolCalls}`);
    lines.push(`- Token: ${progress.usage.totalTokensUsed}${progress.usage.estimatedTokens ? " (estimated)" : ""}`);
  }
  if (progress.recoveryState) {
    lines.push(`- ${isZh ? "恢复原因" : "Recovery cause"}: ${progress.recoveryState.normalizedCause} (${progress.recoveryState.consecutiveCount}/${3})`);
  }
  if (progress.lastCheckpoint) {
    lines.push(`- ${isZh ? "最近检查点" : "Last Checkpoint"}: ${isZh ? "连续执行" : "Continuation"} ${progress.lastCheckpoint.iteration}`);
  }
  lines.push("");

  // Definition of Done
  const criteria = normalizeGoalCriteria(goal);
  if (criteria.length > 0) {
    lines.push(`## ${isZh ? "完成标准" : "Definition of Done"}`);
    for (const criterion of criteria) {
      lines.push(`- [${criterion.status === "satisfied" ? "x" : " "}] ${criterion.text}`);
    }
    lines.push("");
  }

  // Progress history
  const completedIterations = progress.iterations.filter((iter) => iter.endedAt != null);
  if (completedIterations.length > 0) {
    lines.push(`## ${isZh ? "进展记录" : "Progress History"}`);
    for (const iter of completedIterations.slice(-20)) {
      const summary = summarizeGoalIteration(iter, language);
      lines.push(`${iter.index}. [${isZh ? "连续执行" : "Continuation"} ${iter.index}] ${summary}`);
    }
    if (completedIterations.length > 20) {
      lines.push(`... ${isZh ? "更早的" : "earlier"} ${completedIterations.length - 20} ${isZh ? "步已省略" : "steps omitted"}`);
    }
    lines.push("");
  }

  // Remaining Work
  if (progress.lastCheckpoint && progress.lastCheckpoint.remainingTasks.length > 0) {
    lines.push(`## ${isZh ? "剩余工作" : "Remaining Work"}`);
    for (const task of progress.lastCheckpoint.remainingTasks) {
      lines.push(`- ${task}`);
    }
    lines.push("");
  }

  // Blockers
  const currentIteration = progress.iterations[progress.iterations.length - 1];
  const blockers = currentIteration?.unresolvedBlockers ?? [];
  lines.push(`## ${isZh ? "阻塞" : "Blockers"}`);
  if (blockers.length > 0) {
    for (const blocker of blockers) {
      lines.push(`- ${blocker}`);
    }
  } else {
    lines.push(`- ${isZh ? "暂无" : "None currently"}`);
  }
  lines.push("");

  // Modified Files
  const allModifiedFiles = new Set<string>();
  for (const iter of progress.iterations) {
    for (const file of iter.filesModified) {
      allModifiedFiles.add(file);
    }
  }
  if (allModifiedFiles.size > 0) {
    lines.push(`## ${isZh ? "已修改文件" : "Modified Files"}`);
    for (const file of [...allModifiedFiles].sort()) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function serializeGoalRuntimeSnapshot(snapshot: GoalRuntimeSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function deserializeGoalRuntimeSnapshot(json: string): GoalRuntimeSnapshot | null {
  try {
    const parsed = JSON.parse(json) as GoalRuntimeSnapshot;
    if (
      !parsed
      || ![2, 3].includes(Number(parsed.schemaVersion))
      || !parsed.goal?.id
      || !parsed.progress?.goalId
    ) return null;
    return normalizeGoalRuntimeSnapshot(parsed);
  } catch {
    return null;
  }
}

export function serializeGoalEvidenceJsonl(progress: GoalProgress): string {
  return (progress.evidence || []).map((entry) => JSON.stringify(entry)).join("\n");
}

// ── Checkpoint summary for LLM context ───────────────────────────

export function buildCheckpointContextForLLM(input: {
  goal: GoalDefinition;
  checkpoint: GoalCheckpoint;
  language: "zh" | "en";
}): string {
  const { goal, checkpoint, language } = input;
  const isZh = language === "zh";

  const lines: string[] = [];
  lines.push(isZh ? "## 目标检查点摘要" : "## Goal Checkpoint Summary");
  lines.push("");
  lines.push(`**${isZh ? "目标" : "Objective"}**: ${goal.objective}`);
  lines.push(`**${isZh ? "连续执行" : "Continuation"}**: ${checkpoint.iteration}`);
  lines.push("");

  if (checkpoint.completedTasks.length > 0) {
    lines.push(isZh ? "**已完成**:" : "**Completed**:");
    for (const task of checkpoint.completedTasks.slice(-10)) {
      lines.push(`- ✅ ${task}`);
    }
    lines.push("");
  }

  if (checkpoint.remainingTasks.length > 0) {
    lines.push(isZh ? "**待完成**:" : "**Remaining**:");
    for (const task of checkpoint.remainingTasks.slice(0, 10)) {
      lines.push(`- ⬜ ${task}`);
    }
    lines.push("");
  }

  if (checkpoint.lastVerificationSummary) {
    lines.push(isZh ? "**最近验证结果**:" : "**Last Verification**:");
    lines.push(checkpoint.lastVerificationSummary);
    lines.push("");
  }

  if (checkpoint.lastAssistantContext) {
    lines.push(isZh ? "**最近模型结论**:" : "**Latest Model Conclusions**:");
    lines.push(checkpoint.lastAssistantContext);
    lines.push("");
  }

  if (checkpoint.recentOperations?.length) {
    lines.push(isZh ? "**最近工具操作**:" : "**Recent Tool Operations**:");
    for (const operation of checkpoint.recentOperations.slice(-12)) {
      const target = operation.target ? ` · ${operation.target}` : "";
      lines.push(`- [${operation.status}] ${operation.tool}${target} · ${operation.summary}`);
    }
    lines.push("");
  }

  if (checkpoint.contextSummary) {
    lines.push(isZh ? "**上下文摘要**:" : "**Context Summary**:");
    lines.push(checkpoint.contextSummary);
    lines.push("");
  }

  if (checkpoint.workspaceSnapshot.length > 0) {
    lines.push(isZh ? "**已修改文件**:" : "**Modified Files**:");
    for (const file of checkpoint.workspaceSnapshot.slice(0, 20)) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Parse existing progress from file ────────────────────────────

const ITERATION_LINE_RE = /^\d+\.\s*\[(?:迭代|Iteration|连续执行|Continuation)\s+(\d+)\]\s*(.+)$/;

export function parseGoalProgressFromMarkdown(markdown: string): {
  objective: string | null;
  completedSteps: Array<{ index: number; summary: string }>;
  remainingTasks: string[];
} {
  const lines = markdown.split("\n");
  let objective: string | null = null;
  const completedSteps: Array<{ index: number; summary: string }> = [];
  const remainingTasks: string[] = [];
  let section = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect title
    if (trimmed.startsWith("# ")) {
      const goalMatch = trimmed.match(/^#\s*(?:目标|Goal)\s*[:：]\s*(.+)/);
      if (goalMatch) objective = goalMatch[1].trim();
      continue;
    }

    // Detect section headers
    if (trimmed.startsWith("## ")) {
      if (/已完成|Completed Steps|进展记录|Progress History/i.test(trimmed)) section = "completed";
      else if (/剩余|Remaining/i.test(trimmed)) section = "remaining";
      else section = "";
      continue;
    }

    if (section === "completed") {
      const match = ITERATION_LINE_RE.exec(trimmed);
      if (match) {
        completedSteps.push({ index: parseInt(match[1], 10), summary: match[2] });
      }
    }

    if (section === "remaining" && trimmed.startsWith("- ")) {
      remainingTasks.push(trimmed.slice(2).trim());
    }
  }

  return { objective, completedSteps, remainingTasks };
}
