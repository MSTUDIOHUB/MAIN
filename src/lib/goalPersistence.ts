// lib/goalPersistence.ts
// File-system persistence for Goal Mode progress.
// Writes goal state to .MAIN/goals/ directory so progress survives
// app restarts, crashes, or context window resets.
// ────────────────────────────────────────────────────────────────────

import type {
  GoalCheckpoint,
  GoalDefinition,
  GoalProgress,
} from "./goalState";
import { buildGoalStatusLabel, summarizeGoalIteration } from "./goalState";

export const GOAL_DIR_NAME = "goals";
export const GOAL_ACTIVE_FILE = "active-goal.json";
export const GOAL_PROGRESS_FILE = "progress.md";
export const GOAL_CHECKPOINT_DIR = "checkpoints";

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
    return parsed as GoalDefinition;
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
  lines.push(`- ${isZh ? "迭代" : "Iteration"}: ${progress.currentIteration}/${goal.iterationBudget}`);
  if (progress.lastCheckpoint) {
    lines.push(`- ${isZh ? "最近检查点" : "Last Checkpoint"}: ${isZh ? "迭代" : "Iteration"} ${progress.lastCheckpoint.iteration}`);
  }
  lines.push("");

  // Definition of Done
  if (goal.definitionOfDone.length > 0) {
    lines.push(`## ${isZh ? "完成标准" : "Definition of Done"}`);
    for (const criterion of goal.definitionOfDone) {
      const done = progress.lastCheckpoint?.completedTasks.some((task) =>
        task.toLowerCase().includes(criterion.toLowerCase()),
      );
      lines.push(`- [${done ? "x" : " "}] ${criterion}`);
    }
    lines.push("");
  }

  // Completed Steps
  const completedIterations = progress.iterations.filter((iter) => iter.endedAt != null);
  if (completedIterations.length > 0) {
    lines.push(`## ${isZh ? "已完成步骤" : "Completed Steps"}`);
    for (const iter of completedIterations.slice(-20)) {
      const summary = summarizeGoalIteration(iter, language);
      lines.push(`${iter.index}. [${isZh ? "迭代" : "Iteration"} ${iter.index}] ${summary}`);
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
  lines.push(`**${isZh ? "迭代" : "Iteration"}**: ${checkpoint.iteration}/${goal.iterationBudget}`);
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

const ITERATION_LINE_RE = /^\d+\.\s*\[(?:迭代|Iteration)\s+(\d+)\]\s*(.+)$/;

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
      if (/已完成|Completed Steps/i.test(trimmed)) section = "completed";
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
