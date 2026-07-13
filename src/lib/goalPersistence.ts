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
  return `${resolveGoalDirPath(workspacePath)}/${goalId}`;
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
