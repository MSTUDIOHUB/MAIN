import type { LegacyWorkflowMode, ResolvedRunIntent } from "./runIntent";
import {
  resolveConversationTurnIntent,
  resolveRunIntentFromLegacyWorkflowMode,
} from "./runIntent";

// lib/workflowModels.ts
// 计划面板、回合视图、流式归一化共享模型。
// 这里集中定义前端工作流需要复用的类型和轻量工具函数，
// 避免 store / orchestrator / 组件各自维护一套相近结构。

// region: 共享类型

export type RightPanelTab = "plan" | "diff" | "terminal" | "file";

export function detectDominantLanguage(text: string, fallback: "zh" | "en" = "zh"): "zh" | "en" {
  const hanCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;

  if (hanCount === 0 && latinCount === 0) return fallback;
  return hanCount * 2 >= latinCount ? "zh" : "en";
}

export type PlanArtifactKind = "requirements" | "design" | "tasks" | "bugfix" | "summary";

export type PlanStage =
  | "idle"
  | "requirements"
  | "design"
  | "tasks"
  | "bugfix"
  | "ready_to_execute"
  | "executing"
  | "completed";

export type PlanTaskStatus = "pending" | "in_progress" | "completed";

export interface PlanArtifact {
  kind: PlanArtifactKind;
  path: string;
  title: string;
  content: string;
  updatedAt: number;
}

export interface PlanTask {
  id: string;
  text: string;
  status: PlanTaskStatus;
  requirementRef?: string;
  commands?: string[];
}

export interface ReplyOption {
  label: string;
  value: string;
}

export type ConversationTurnStatus =
  | "planning"
  | "awaiting_approval"
  | "awaiting_input"
  | "executing"
  | "completed_with_changes"
  | "stopped_no_action"
  | "stopped_no_output"
  | "done"
  | "error";

export type VisibleConversationTurnStatus = ConversationTurnStatus | "paused";

export interface ConversationTurn {
  id: string;
  userPrompt: string;
  title: string;
  intentSummary?: string;
  mode: LegacyWorkflowMode;
  intent?: ResolvedRunIntent;
  status: ConversationTurnStatus;
  summary: string;
  blockIds: number[];
  collapsed: boolean;
  createdAt: number;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
  source: "native" | "text";
}

export interface NormalizedStreamState {
  visibleText: string;
  hiddenThought: string;
  replyOptions: ReplyOption[];
  toolCalls: NormalizedToolCall[];
  finishReason: "stop" | "length" | "tool_calls" | null;
}

// endregion

// region: 轻量摘要工具

const TITLE_META_PREFIX_RE =
  /^(?:@\S+\s+)?(?:[A-Za-z][\w.-]{0,31}\s*@?\s*[:：-]\s*)?(?:(?:\d{2,4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*/;
const TITLE_INTENT_PREFIX_RE = /^(?:当前查看|viewing)\s*/i;
const TITLE_MODE_PREFIX_RE =
  /^(?:讨论|discuss|计划|plan|直接执行|execute|总结|summarize|报告|report|Game Studio 工作流|Game Studio Workflow)\s*[:：-]\s*/i;
const TITLE_REASONING_LEAK_RE =
  /(?:thinking process|here'?s a thinking|chain of thought|reasoning process|analy(?:s|z)e user input|step\s*1\b|let'?s think|思考过程|分析用户输入|先分析|先思考)/i;
const GENERIC_TURN_TITLE_RE = /^(?:新的任务|新任务|new task|turn decision|本轮决策|new conversation|新会话|new chat|新聊天)$/i;

/**
 * 统一清理标题中的转录元信息、Markdown 噪音和误入的状态前缀，
 * 避免 sidebar / TopIsland 直接展示用户名、时间戳或推理泄漏文本。
 */
export function normalizeConversationDisplayTitle(
  input: string,
  maxLength = 44,
  fallback = "新的任务",
): string {
  const base = String(input || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi, " ")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/gi, " ")
    .replace(/[#>*_`~[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stripped = base
    .replace(TITLE_INTENT_PREFIX_RE, "")
    .replace(TITLE_MODE_PREFIX_RE, "")
    .replace(TITLE_META_PREFIX_RE, "")
    .replace(/^[\"'“”‘’]+|[\"'“”‘’]+$/g, "")
    .trim();

  if (!stripped || TITLE_REASONING_LEAK_RE.test(stripped) || GENERIC_TURN_TITLE_RE.test(stripped)) return fallback;
  return stripped.length <= maxLength ? stripped : `${stripped.slice(0, maxLength).trim()}...`;
}

export function isGenericConversationTitle(input: string): boolean {
  const normalized = String(input || "").replace(/\s+/g, " ").trim();
  return !normalized || GENERIC_TURN_TITLE_RE.test(normalized) || TITLE_REASONING_LEAK_RE.test(normalized);
}

/**
 * 某些旧会话标题会被错误写成“思考过程”一类文本。
 * 这里单独做一次检测，便于 UI 退回到更稳定的 turn 标题。
 */
export function looksLikeReasoningLeakTitle(input: string): boolean {
  const raw = String(input || "");
  if (TITLE_REASONING_LEAK_RE.test(raw)) return true;
  const normalized = normalizeConversationDisplayTitle(raw, 120, "");
  if (!normalized) return false;
  return TITLE_REASONING_LEAK_RE.test(normalized);
}

/**
 * 将用户原始输入整理成适合回合标题展示的短标题。
 */
export function summarizeUserPrompt(prompt: string, maxLength = 44): string {
  return normalizeConversationDisplayTitle(prompt, maxLength, "新的任务");
}

/**
 * 将 AI 可见回复压缩为适合回合摘要栏展示的短摘要。
 */
export function summarizeAssistantText(text: string, maxLength = 96): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "已完成本轮处理";
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength).trim()}...`;
}

/**
 * 为聊天区的 Plan 入口卡生成稳定的人话概述，避免直接显示流式过程碎片。
 */
export function summarizePlanIntent(prompt: string, maxLength = 40, language: "zh" | "en" = "zh"): string {
  const subject = summarizeUserPrompt(prompt, maxLength);
  return language === "zh"
    ? `已根据你的需求生成「${subject}」的计划草案，包含目标梳理、方案设计和后续执行步骤。`
    : `A plan draft for "${subject}" has been prepared with goals, design, and next execution steps.`;
}

/**
 * TopIsland 在贴底自动跟随时应始终代表最新回合；
 * 只有用户主动滚回历史内容时，才回到按可见回合定位。
 */
export function resolveActiveConversationTurn(
  turns: ConversationTurn[],
  activeVisibleTurnId: string | null,
  preferLatest = false,
): ConversationTurn | null {
  const latestTurn = turns[turns.length - 1] || null;
  if (!latestTurn) return null;
  if (preferLatest) return latestTurn;
  if (!activeVisibleTurnId) return latestTurn;
  return turns.find((turn) => turn.id === activeVisibleTurnId) || latestTurn;
}

/**
 * 当前执行中的 turn 不应随滚动浏览而漂移；
 * TopIsland 的任务区/审批区应绑定这个稳定上下文。
 */
export function resolvePinnedConversationTurn(
  turns: ConversationTurn[],
  currentTurnId: string | null,
): ConversationTurn | null {
  const latestTurn = turns[turns.length - 1] || null;
  if (!latestTurn) return null;
  if (!currentTurnId) return latestTurn;
  return turns.find((turn) => turn.id === currentTurnId) || latestTurn;
}

export function deriveVisibleConversationTurnStatus(params: {
  baseStatus: ConversationTurnStatus;
  workflowMode?: LegacyWorkflowMode;
  turnIntent?: ResolvedRunIntent;
  isPinnedPlanTurnVisible: boolean;
  isPlanApproved: boolean;
  planStage: PlanStage;
  agentStatus: "idle" | "running" | "pending_review" | "error";
  hasIncompletePlanTasks: boolean;
  hasTasksArtifact: boolean;
}): VisibleConversationTurnStatus {
  const {
    baseStatus,
    workflowMode,
    turnIntent,
    isPinnedPlanTurnVisible,
    isPlanApproved,
    planStage,
    agentStatus,
    hasIncompletePlanTasks,
    hasTasksArtifact,
  } = params;
  const effectiveIntent = turnIntent ?? resolveRunIntentFromLegacyWorkflowMode(workflowMode ?? "chat");

  if (effectiveIntent !== "plan" || !isPinnedPlanTurnVisible) {
    return baseStatus;
  }

  if (!isPlanApproved && (agentStatus === "pending_review" || planStage === "ready_to_execute")) {
    return "awaiting_approval";
  }

  const pausedExecution =
    isPlanApproved &&
    planStage === "executing" &&
    (agentStatus === "idle" || agentStatus === "error") &&
    (hasIncompletePlanTasks || !hasTasksArtifact);

  if (pausedExecution) {
    return "paused";
  }

  return baseStatus;
}

// endregion

// region: 计划文件解析

/**
 * 通过计划文件路径判断产物类型。
 */
export function detectPlanArtifactKind(path: string): PlanArtifactKind | null {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (!normalized.includes(".main/plans/")) return null;
  if (normalized.endsWith("requirements.md")) return "requirements";
  if (normalized.endsWith("design.md")) return "design";
  if (normalized.endsWith("tasks.md")) return "tasks";
  if (normalized.endsWith("bugfix.md")) return "bugfix";
  return null;
}

export function isPlanConversationTurn(turn: ConversationTurn | null | undefined): boolean {
  return resolveConversationTurnIntent(turn) === "plan";
}

/**
 * 根据产物类型推导当前计划阶段。
 */
export function planStageFromArtifactKind(kind: PlanArtifactKind): PlanStage {
  switch (kind) {
    case "requirements":
      return "requirements";
    case "design":
      return "design";
    case "tasks":
      return "tasks";
    case "bugfix":
      return "bugfix";
    default:
      return "idle";
  }
}

const SHELL_COMMAND_START_RE = /^(?:pnpm|npm|npx|yarn|bun|cargo|rustup|pip3?|python3?|uv|go|dotnet|git|brew|mkdir|cp|mv|rm|touch|chmod|tauri|vite|node|deno|composer|php|ruby|rails|make|cmake|xcodebuild)\b/i;
const SHELL_COMMAND_FRAGMENT_RE = /\b(?:pnpm|npm|npx|yarn|bun|cargo|rustup|pip3?|python3?|uv|go|dotnet|git|brew|mkdir|cp|mv|rm|touch|chmod|tauri|vite|node|deno|composer|php|ruby|rails|make|cmake|xcodebuild)\b[^\n`"'，。；;)]*/gi;

function pushShellCommand(target: string[], candidate: string) {
  const normalized = candidate.replace(/\s+/g, " ").trim();
  if (!normalized || !SHELL_COMMAND_START_RE.test(normalized)) return;
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

export function extractShellCommandsFromText(text: string): string[] {
  if (!text.trim()) return [];

  const commands: string[] = [];

  for (const matched of text.matchAll(/```(?:bash|sh|zsh|shell)?\s*\n([\s\S]*?)```/gi)) {
    const block = matched[1] ?? "";
    for (const line of block.split(/\r?\n/)) {
      pushShellCommand(commands, line);
    }
  }

  for (const matched of text.matchAll(/`([^`\n]+)`/g)) {
    pushShellCommand(commands, matched[1] ?? "");
  }

  for (const matched of text.matchAll(SHELL_COMMAND_FRAGMENT_RE)) {
    pushShellCommand(commands, matched[0] ?? "");
  }

  return commands;
}

export function getPendingPlanTaskCommandFocus(
  tasks: PlanTask[],
  maxTasks = 3,
): Array<{ task: PlanTask; commands: string[] }> {
  return tasks
    .filter((task) => task.status !== "completed")
    .slice(0, maxTasks)
    .map((task) => {
      const commands = task.commands && task.commands.length > 0
        ? task.commands
        : extractShellCommandsFromText(task.text);
      return { task, commands };
    })
    .filter((entry) => entry.commands.length > 0);
}

/**
 * 从 tasks.md / bugfix.md 中抽取 checkbox 任务。
 */
export function extractPlanTasks(markdown: string): PlanTask[] {
  if (!markdown.trim()) return [];

  const tasks: PlanTask[] = [];
  const lines = markdown.split(/\r?\n/);

  for (const line of lines) {
    const matched = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (!matched) continue;

    const rawText = matched[2].trim();
    const requirementMatched = rawText.match(/REQ-[A-Za-z0-9_-]+/);
    const text = rawText.replace(/\s*→\s*对应需求[:：]?\s*REQ-[A-Za-z0-9_-]+/i, "").trim();
    const commands = extractShellCommandsFromText(rawText);

    tasks.push({
      id: `plan-task-${tasks.length + 1}`,
      text,
      status: matched[1].toLowerCase() === "x" ? "completed" : "pending",
      ...(requirementMatched ? { requirementRef: requirementMatched[0] } : {}),
      ...(commands.length > 0 ? { commands } : {}),
    });
  }

  return tasks;
}

/**
 * 为计划产物生成友好的标题。
 */
export function getPlanArtifactTitle(kind: PlanArtifactKind, language: "zh" | "en" = "zh"): string {
  switch (kind) {
    case "requirements":
      return language === "zh" ? "需求规格" : "Requirements";
    case "design":
      return language === "zh" ? "设计方案" : "Design";
    case "tasks":
      return language === "zh" ? "执行任务" : "Tasks";
    case "bugfix":
      return language === "zh" ? "问题修复" : "Bugfix";
    default:
      return language === "zh" ? "计划产物" : "Plan Artifact";
  }
}

// endregion
