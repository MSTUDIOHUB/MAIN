// lib/goalContextStrategy.ts
// Context management strategy for Goal Mode.
// Between iterations, compresses the context window aggressively
// while preserving goal definition and recent evidence.
// Inspired by Codex CLI's "fresh context per iteration" approach.
// ────────────────────────────────────────────────────────────────────

import { normalizeGoalCriteria, type GoalCheckpoint, type GoalDefinition, type GoalTurnContract } from "./goalState";
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
  const criteria = normalizeGoalCriteria(goal);
  if (criteria.length > 0) {
    const heading = isZh ? "**完成标准**:" : "**Definition of Done**:";
    const items = criteria.map((criterion, i) => {
      const done = criterion.status === "satisfied" || checkpoint?.completedTasks.some((t) =>
        t.toLowerCase().includes(criterion.text.toLowerCase()),
      );
      return `${i + 1}. [${done ? "x" : " "}] ${criterion.text}`;
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
      "这是 Goal Runtime 分配的一次有界执行切片。遵循 Plan → Execute → Observe 循环：",
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
      "- 本切片只推进一个明确、可验证的里程碑；不要在模型内部自行开启无限循环",
      "- 每次修改文件后必须运行验证命令",
      "- 遇到阻塞时记录具体阻塞原因并尝试替代方案",
      "- 不要修改 `.MAIN/goals/` 中的运行时状态文件；Goal Runtime 会根据真实工具结果保存进度、检查点和证据",
      `- 如果所有完成标准都有证据支持，在回复末尾声明 "GOAL_COMPLETION_CANDIDATE"；最终完成由运行时证据门禁决定`,
      `- 如果遇到无法解决的阻塞，声明 "GOAL_BLOCKED: <原因>"`,
      "",
    );

    return lines.join("\n");
  }

  const lines: string[] = [
    "## Iteration Instructions",
    "",
    "This is one bounded execution slice assigned by Goal Runtime. Follow the Plan → Execute → Observe cycle:",
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
    "- Advance one clear, verifiable milestone in this slice. Do not start an unbounded model-side loop.",
    "- Run verification commands after every file change.",
    "- When blocked, record the specific blocker and try an alternative approach.",
    "- Do not modify runtime state files under `.MAIN/goals/`; Goal Runtime persists progress, checkpoints, and evidence from real tool results.",
    '- If every completion criterion is supported by evidence, end with "GOAL_COMPLETION_CANDIDATE". The runtime evidence gate makes the final decision.',
    '- If encountering an unresolvable blocker, state "GOAL_BLOCKED: <reason>".',
    "",
  );

  return lines.join("\n");
}

// ── Goal completion detection from model output ──────────────────

const GOAL_COMPLETED_RE = /\b(?:GOAL_COMPLETION_CANDIDATE|GOAL_COMPLETED)\b/i;
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

export function buildGoalTurnContract(input: GoalIterationContextInput): GoalTurnContract {
  const goal = input.goal;
  const context = buildGoalIterationSystemContext(input);
  const revision = Math.max(1, Number(goal.revision) || 1);
  return {
    goalId: goal.id,
    revision,
    iteration: input.nextIteration,
    maxIterations: goal.iterationBudget,
    status: goal.status,
    phase: input.checkpoint?.currentPhase || "plan",
    context,
    cacheKey: `${goal.id}:${revision}:${input.nextIteration}:${input.checkpoint?.iteration || 0}:${input.checkpoint?.evidenceCursor || 0}`,
  };
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
