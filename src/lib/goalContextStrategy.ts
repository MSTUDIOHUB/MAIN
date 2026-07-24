// lib/goalContextStrategy.ts
// Context management strategy for Goal Mode.
// Keeps one logical Goal conversation across internal continuation boundaries.
// Older context is compacted only when needed, while exact recent messages,
// checkpoints, and structured tool evidence remain available.
// ────────────────────────────────────────────────────────────────────

import {
  buildGoalSliceId,
  normalizeGoalCriteria,
  type GoalCheckpoint,
  type GoalDefinition,
  type GoalEvidenceEntry,
  type GoalTurnContract,
} from "./goalState";
import type { VerificationResult } from "./goalVerification";
import { buildCheckpointContextForLLM } from "./goalPersistence";
import { buildVerificationSummary } from "./goalVerification";
import { classifyGoalToolCapability } from "./goalToolCapabilities";
import { resolveEffectiveSubagentDelegationPreference } from "./turnIntake";

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
  /** Existing structured evidence from earlier internal continuations. */
  evidence?: GoalEvidenceEntry[];
  /** Durable memory produced from the retained Goal conversation. */
  continuationMemory?: string;
}

/**
 * Build the system-level contract for the next internal continuation.
 * The actual recent conversation is retained separately by Goal Runtime.
 */
export function buildGoalIterationSystemContext(input: GoalIterationContextInput): string {
  const { goal, checkpoint, latestVerification, nextIteration, language, userGuidance } = input;
  const isZh = language === "zh";
  const sections: string[] = [];

  // ── Section 1: Goal & Phase Identity ──
  sections.push(isZh
    ? [
        `## 持续目标 — 连续执行 ${nextIteration}`,
        "",
        `**目标**: ${goal.objective}`,
        `**修订**: ${goal.revision || 1}`,
        "",
      ].join("\n")
    : [
        `## Persistent Goal — Continuation ${nextIteration}`,
        "",
        `**Objective**: ${goal.objective}`,
        `**Revision**: ${goal.revision || 1}`,
        "",
      ].join("\n"),
  );

  if (goal.sourceContext) {
    sections.push([
      isZh ? "## 有界来源上下文" : "## Bounded Source Context",
      "",
      goal.sourceContext,
      "",
    ].join("\n"));
  }

  const subagentPreference = resolveEffectiveSubagentDelegationPreference({
    rawUserInput: goal.objective,
    defaultPreference: goal.subagentPreference,
  });
  if (subagentPreference === "preferred") {
    sections.push([
      isZh ? "## 子智能体协作偏好" : "## Subagent Collaboration Preference",
      "",
      isZh
        ? "本目标允许并优先考虑协作，但模型应先按目标与问题结构决定是否委派。只为具有独立成功标准和明确收益的窄语义任务创建全新一次性子智能体，不按目录凑数；每个实例终态后永久关闭，后续任务创建新实例并只继承已验证的精简证据。"
        : "Collaboration is allowed and preferred, but the model first decides from the goal and problem structure whether delegation helps. Create fresh one-shot agents only for narrow semantic tasks with independent success criteria and clear value, never as directory-based filler. Permanently close every terminal instance; later work gets a new instance with verified compact evidence only.",
      "",
    ].join("\n"));
  } else if (subagentPreference === "forbidden") {
    sections.push(isZh
      ? "用户明确要求本目标不使用子智能体。"
      : "The user explicitly disabled subagents for this goal.");
  }

  if (input.continuationMemory) {
    sections.push([
      isZh ? "## 连续执行记忆" : "## Continuation Memory",
      "",
      input.continuationMemory,
      "",
    ].join("\n"));
  }

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

  const existingEvidence = (input.evidence || [])
    .filter((entry) => entry.goalId === goal.id && entry.goalRevision === (goal.revision || 1))
    .slice(-20);
  if (existingEvidence.length > 0) {
    const evidenceLines = existingEvidence.map((entry) => {
      const criteriaLabel = (entry.criterionIds || []).join(",") || "unassigned";
      const compactSummary = String(entry.summary || "").replace(/\s+/g, " ").slice(0, 240);
      return `- [${entry.status}] ${entry.kind} · ${entry.sourceTool}${entry.target ? ` · ${entry.target}` : ""} · criteria=${criteriaLabel}${compactSummary ? ` · ${compactSummary}` : ""}`;
    });
    sections.push([
      isZh ? "## 已有结构化证据" : "## Existing Structured Evidence",
      "",
      ...evidenceLines,
      "",
    ].join("\n"));
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
      "## 当前连续执行指令",
      "",
      "这是同一个持续目标在内部安全边界后的连续执行。当前处于自主执行态，不是等待审批的 Plan 模式。沿用已有上下文，按以下闭环继续：",
      "",
      "1. **定位**: 用已有证据确定当前最小可验证动作；只在缺少关键事实时补充读取。",
      "2. **行动**: 立即调用工具推进该动作；证据足够时不得只输出诊断、修复方案或等待批准。",
      "3. **验证**: 对真实改动运行相关测试、构建、lint 或界面验证。",
      "",
    ];

    if (hasRemainingTasks) {
      lines.push("**建议下一步**:");
      lines.push(`优先完成：${remainingTasks[0]}`);
      lines.push("");
    }

    lines.push(
      "**约束**:",
      "- 继续推进一个明确、可验证的里程碑；不要重新开始任务，也不要在模型内部自行开启无限循环",
      "- 复用已有读取、工具结果和文件状态；只有工作区证据变化或确有缺口时才重复操作",
      "- 不要输出 `<plan_candidate>` 或其他 Plan 草稿协议，也不要把完整修复计划当作本轮交付；简短说明后必须继续执行真实工具动作",
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
    "## Current Continuation Instructions",
    "",
    "This continues the same persistent goal after an internal safety boundary. This is autonomous execution, not Plan mode awaiting approval. Reuse retained context and continue this loop:",
    "",
    "1. **Orient**: Select the smallest verifiable action from existing evidence; read only when a key fact is missing.",
    "2. **Act**: Call tools immediately. Once evidence is sufficient, do not stop at diagnosis, a repair proposal, or an approval request.",
    "3. **Verify**: Run relevant tests, build, lint, or UI validation for real changes.",
    "",
  ];

  if (hasRemainingTasks) {
    lines.push("**Suggested next task**:");
    lines.push(`Prioritize: ${remainingTasks[0]}`);
    lines.push("");
  }

  lines.push(
    "**Constraints**:",
    "- Continue one clear, verifiable milestone. Do not restart the task or start an unbounded model-side loop.",
    "- Reuse existing reads, tool results, and file state. Repeat an operation only when workspace evidence changed or a real gap remains.",
    "- Do not output `<plan_candidate>` or any other Plan draft protocol, and do not treat a full repair plan as this continuation's deliverable. After a brief orientation, continue with a real tool action.",
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
  const subagentPreference = resolveEffectiveSubagentDelegationPreference({
    rawUserInput: goal.objective,
    defaultPreference: goal.subagentPreference,
  });
  const revision = Math.max(1, Number(goal.revision) || 1);
  const goalSliceId = buildGoalSliceId(goal.id, input.nextIteration);
  return {
    goalId: goal.id,
    goalSliceId,
    objective: goal.objective,
    subagentPreference,
    revision,
    iteration: input.nextIteration,
    maxIterations: goal.iterationBudget,
    status: goal.status,
    phase: "execute",
    context,
    cacheKey: `${goal.id}:${revision}:${input.nextIteration}:${input.checkpoint?.iteration || 0}:${input.checkpoint?.evidenceCursor || 0}`,
  };
}

// ── Extract modified files from tool call results ────────────────

export function extractModifiedFilesFromToolCalls(
  toolCalls: Array<{ name: string; target?: string; arguments?: Record<string, unknown> }>,
): string[] {
  const files = new Set<string>();
  for (const call of toolCalls) {
    const target = call.target
      || (call.arguments?.path as string)
      || (call.arguments?.file_path as string)
      || (call.arguments?.target_file as string);
    if (classifyGoalToolCapability({
      name: call.name,
      target,
      arguments: call.arguments,
    }).kind !== "file_change") continue;
    if (target && typeof target === "string") {
      files.add(target);
    }
  }
  return [...files];
}

// ── Extract test commands from tool call results ─────────────────

export function extractTestCommandsFromToolCalls(
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>,
): string[] {
  const commands: string[] = [];
  for (const call of toolCalls) {
    const cmd = (call.arguments?.command as string) || (call.arguments?.cmd as string) || "";
    if (classifyGoalToolCapability({
      name: call.name,
      target: cmd,
      arguments: call.arguments,
    }).kind === "test") {
      commands.push(cmd);
    }
  }
  return commands;
}
