// lib/goalContextStrategy.ts
// Context management strategy for Goal Mode.
// Between iterations, compresses the context window aggressively
// while preserving goal definition and recent evidence.
// Inspired by Codex CLI's "fresh context per iteration" approach.
// ────────────────────────────────────────────────────────────────────

import type { GoalCheckpoint, GoalDefinition } from "./goalState";
import type { VerificationResult } from "./goalVerification";
import { buildCheckpointContextForLLM } from "./goalPersistence";
import { buildVerificationSummary } from "./goalVerification";

export interface GoalIterationContextInput {
  /** Current goal definition */
  goal: GoalDefinition;
  /** Last saved checkpoint (null for first iteration) */
  checkpoint: GoalCheckpoint | null;
  /** Latest verification result (null if no verification ran) */
  latestVerification: VerificationResult | null;
  /** The iteration index about to start */
  nextIteration: number;
  /** Language preference */
  language: "zh" | "en";
  /** Additional user-provided guidance (optional) */
  userGuidance?: string;
}

/**
 * Build the initial system-level context for a new goal iteration.
 * This replaces the full message history with a compressed summary,
 * following the Ralph Loop pattern of "fresh context per iteration".
 */
export function buildGoalIterationSystemContext(input: GoalIterationContextInput): string {
  const { goal, checkpoint, latestVerification, nextIteration, language, userGuidance } = input;
  const isZh = language === "zh";
  const sections: string[] = [];

  // ── Section 1: Goal & Phase Identity ──
  sections.push(isZh
    ? [
        `## 目标模式 — 迭代 ${nextIteration}/${goal.iterationBudget}`,
        "",
        `**目标**: ${goal.objective}`,
        "",
      ].join("\n")
    : [
        `## Goal Mode — Iteration ${nextIteration}/${goal.iterationBudget}`,
        "",
        `**Objective**: ${goal.objective}`,
        "",
      ].join("\n"),
  );

  // ── Section 2: Definition of Done ──
  if (goal.definitionOfDone.length > 0) {
    const heading = isZh ? "**完成标准**:" : "**Definition of Done**:";
    const items = goal.definitionOfDone.map((criterion, i) => {
      const done = checkpoint?.completedTasks.some((t) =>
        t.toLowerCase().includes(criterion.toLowerCase()),
      );
      return `${i + 1}. [${done ? "x" : " "}] ${criterion}`;
    });
    sections.push([heading, ...items, ""].join("\n"));
  }

  // ── Section 3: Checkpoint Summary ──
  if (checkpoint) {
    sections.push(buildCheckpointContextForLLM({ goal, checkpoint, language }));
  } else {
    sections.push(isZh
      ? "这是本目标的第一轮迭代。还没有之前的执行记录。"
      : "This is the first iteration of this goal. No prior execution history.",
    );
    sections.push("");
  }

  // ── Section 4: Latest Verification Result ──
  if (latestVerification) {
    const verificationSection = isZh ? "## 上一轮验证结果" : "## Previous Verification Result";
    const summary = buildVerificationSummary({ result: latestVerification, language });
    sections.push([verificationSection, "", summary, ""].join("\n"));
  }

  // ── Section 5: User Guidance ──
  if (userGuidance) {
    const guidanceHeading = isZh ? "## 用户补充指导" : "## User Guidance";
    sections.push([guidanceHeading, "", userGuidance, ""].join("\n"));
  }

  // ── Section 6: Iteration Instructions ──
  sections.push(buildIterationInstructions(nextIteration, goal, checkpoint, language));

  return sections.join("\n");
}

/**
 * Build specific instructions for this iteration of the goal loop.
 */
function buildIterationInstructions(
  _iteration: number,
  _goal: GoalDefinition,
  checkpoint: GoalCheckpoint | null,
  language: "zh" | "en",
): string {
  const isZh = language === "zh";
  const remainingTasks = checkpoint?.remainingTasks ?? [];
  const hasRemainingTasks = remainingTasks.length > 0;

  if (isZh) {
    const lines: string[] = [
      "## 本轮迭代指令",
      "",
      "遵循 Plan → Execute → Observe 循环：",
      "",
      "1. **Plan**: 分析当前状态，从剩余任务中选择一个最小可行任务。",
      "2. **Execute**: 使用工具实现该任务（编辑文件、运行命令等）。",
      "3. **Observe**: 运行相关验证（测试/构建/lint），确认修改正确。",
      "",
    ];

    if (hasRemainingTasks) {
      lines.push("**建议下一步**:");
      lines.push(`优先完成：${remainingTasks[0]}`);
      lines.push("");
    }

    lines.push(
      "**约束**:",
      "- 每轮只做一个明确的小任务，不要试图一次性完成所有工作",
      "- 每次修改文件后必须运行验证命令",
      "- 遇到阻塞时记录具体阻塞原因并尝试替代方案",
      "- 完成本轮任务后，更新 `.MAIN/goals/progress.md`",
      `- 如果目标已完全达成，在回复末尾明确声明 "GOAL_COMPLETED"`,
      `- 如果遇到无法解决的阻塞，声明 "GOAL_BLOCKED: <原因>"`,
      "",
    );

    return lines.join("\n");
  }

  const lines: string[] = [
    "## Iteration Instructions",
    "",
    "Follow the Plan → Execute → Observe cycle:",
    "",
    "1. **Plan**: Analyze current state, pick one small verifiable task from remaining work.",
    "2. **Execute**: Use tools to implement it (edit files, run commands, etc.).",
    "3. **Observe**: Run relevant verification (tests/build/lint) to confirm correctness.",
    "",
  ];

  if (hasRemainingTasks) {
    lines.push("**Suggested next task**:");
    lines.push(`Prioritize: ${remainingTasks[0]}`);
    lines.push("");
  }

  lines.push(
    "**Constraints**:",
    "- Do one small, clear task per iteration. Do not try to finish everything at once.",
    "- Run verification commands after every file change.",
    "- When blocked, record the specific blocker and try an alternative approach.",
    "- After completing this iteration's task, update `.MAIN/goals/progress.md`.",
    '- If the goal is fully met, end your response with "GOAL_COMPLETED".',
    '- If encountering an unresolvable blocker, state "GOAL_BLOCKED: <reason>".',
    "",
  );

  return lines.join("\n");
}

// ── Goal completion detection from model output ──────────────────

const GOAL_COMPLETED_RE = /\bGOAL_COMPLETED\b/i;
const GOAL_BLOCKED_RE = /\bGOAL_BLOCKED\s*[:：]\s*(.+)/i;

export function detectGoalCompletionSignal(assistantText: string): {
  completed: boolean;
  blocked: boolean;
  blockerReason?: string;
} {
  if (GOAL_COMPLETED_RE.test(assistantText)) {
    return { completed: true, blocked: false };
  }
  const blockedMatch = GOAL_BLOCKED_RE.exec(assistantText);
  if (blockedMatch) {
    return { completed: false, blocked: true, blockerReason: blockedMatch[1].trim() };
  }
  return { completed: false, blocked: false };
}

// ── Extract modified files from tool call results ────────────────

const FILE_MODIFY_TOOLS = new Set([
  "write_file",
  "replace_in_file",
  "create_file",
  "apply_diff",
  "apply_patch",
  "insert_content",
]);

export function extractModifiedFilesFromToolCalls(
  toolCalls: Array<{ name: string; target?: string; arguments?: Record<string, unknown> }>,
): string[] {
  const files = new Set<string>();
  for (const call of toolCalls) {
    if (!FILE_MODIFY_TOOLS.has(call.name)) continue;
    const target = call.target
      || (call.arguments?.path as string)
      || (call.arguments?.file_path as string)
      || (call.arguments?.target_file as string);
    if (target && typeof target === "string") {
      files.add(target);
    }
  }
  return [...files];
}

// ── Extract test commands from tool call results ─────────────────

const TEST_COMMAND_RE = /\b(?:npm\s+test|npm\s+run\s+test|cargo\s+test|pytest|python\s+-m\s+pytest|go\s+test|jest|vitest|playwright\s+test)\b/i;

export function extractTestCommandsFromToolCalls(
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>,
): string[] {
  const commands: string[] = [];
  for (const call of toolCalls) {
    if (call.name !== "run_command" && call.name !== "execute_command") continue;
    const cmd = (call.arguments?.command as string) || (call.arguments?.cmd as string) || "";
    if (TEST_COMMAND_RE.test(cmd)) {
      commands.push(cmd);
    }
  }
  return commands;
}
