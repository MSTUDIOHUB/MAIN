import type { CommandDirective, LegacyWorkflowMode, ResolvedRunIntent } from "./runIntent";
import {
  resolveConversationTurnIntent,
  resolveRunIntentFromLegacyWorkflowMode,
} from "./runIntent";

// lib/workflowModels.ts
// 计划面板、回合视图、流式归一化共享模型。
// 这里集中定义前端工作流需要复用的类型和轻量工具函数，
// 避免 store / orchestrator / 组件各自维护一套相近结构。

// region: 共享类型

export type RightPanelTab = "plan" | "diff" | "terminal";

export type ResponseLanguagePolicy =
  | "follow_input_language"
  | "prefer_system_language_with_explicit_switch";

export function normalizeResponseLanguagePolicy(value: unknown): ResponseLanguagePolicy {
  return value === "prefer_system_language_with_explicit_switch"
    ? "prefer_system_language_with_explicit_switch"
    : "follow_input_language";
}

function stripLeadingSlashCommand(text: string): string {
  return String(text || "").replace(/^\/[^\s]+\s*/u, "").trim();
}

export function detectDominantLanguage(text: string, fallback: "zh" | "en" = "zh"): "zh" | "en" {
  const probe = stripNonNaturalLanguageContent(stripLeadingSlashCommand(text));
  const hanCount = (probe.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (probe.match(/[A-Za-z]/g) || []).length;

  if (hanCount === 0 && latinCount === 0) return fallback;
  return hanCount * 2 >= latinCount ? "zh" : "en";
}

const EXPLICIT_ENGLISH_OVERRIDE_PATTERNS = [
  /请(?:你)?用(?:英文|英语|English|EN)(?:回复|回答|输出|说明|继续)?/i,
  /请改用(?:英文|英语|English|EN)/i,
  /切换到(?:英文|英语|English|EN)/i,
  /\b(?:reply|respond|answer|write)(?:\s+to\s+me)?\s+(?:in|using)\s+(?:english|en)\b/i,
  /\b(?:please\s+)?use\s+english\s+(?:for\s+)?(?:reply|response|responses)\b/i,
];

const EXPLICIT_CHINESE_OVERRIDE_PATTERNS = [
  /请(?:你)?用(?:中文|汉语|简体中文|Chinese|ZH)(?:回复|回答|输出|说明|继续)?/i,
  /请改用(?:中文|汉语|简体中文|Chinese|ZH)/i,
  /切换到(?:中文|汉语|简体中文|Chinese|ZH)/i,
  /\b(?:reply|respond|answer|write)(?:\s+to\s+me)?\s+(?:in|using)\s+(?:chinese|mandarin|zh|simplified chinese)\b/i,
  /\b(?:please\s+)?use\s+(?:chinese|mandarin|zh)\s+(?:for\s+)?(?:reply|response|responses)\b/i,
];

function hasAnyPatternMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectExplicitLanguageOverride(text: string): "zh" | "en" | null {
  const probe = stripLeadingSlashCommand(text);
  if (!probe) return null;
  const wantsEnglish = hasAnyPatternMatch(probe, EXPLICIT_ENGLISH_OVERRIDE_PATTERNS);
  const wantsChinese = hasAnyPatternMatch(probe, EXPLICIT_CHINESE_OVERRIDE_PATTERNS);
  if (wantsEnglish === wantsChinese) return null;
  return wantsEnglish ? "en" : "zh";
}

export function resolveTurnResponseLanguage(input: {
  text: string;
  policy: ResponseLanguagePolicy;
  systemLanguage: "zh" | "en";
  fallbackLanguage: "zh" | "en";
}): "zh" | "en" {
  const override = detectExplicitLanguageOverride(input.text);
  if (override) return override;

  if (input.policy === "prefer_system_language_with_explicit_switch") {
    return input.systemLanguage === "en" ? "en" : "zh";
  }
  return detectDominantLanguage(input.text, input.fallbackLanguage);
}

function stripNonNaturalLanguageContent(text: string): string {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(?:^|\s)(?:\/[^\s`'"，。；、]+)+/g, " ")
    .replace(/(?:^|\s)[A-Za-z]:[\\/][^\s`'"，。；、]+/g, " ")
    .replace(/(?:^|\n)\s*>.*$/gm, " ")
    .replace(/[\[\]{}()<>_=+*/\\|~^#@:$%&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectResponseNaturalLanguage(input: string): {
  hasEnoughSignal: boolean;
  detectedLanguage: "zh" | "en" | null;
  hanCount: number;
  latinLetters: number;
  latinWords: number;
} {
  const cleaned = stripNonNaturalLanguageContent(input);
  const hanCount = (cleaned.match(/[\u3400-\u9fff]/g) || []).length;
  const latinLetters = (cleaned.match(/[A-Za-z]/g) || []).length;
  const latinWords = (cleaned.match(/[A-Za-z]{2,}/g) || []).length;

  const hasZhSignal = hanCount >= 4;
  const hasEnSignal = latinLetters >= 12 && latinWords >= 3;
  if (!hasZhSignal && !hasEnSignal) {
    return {
      hasEnoughSignal: false,
      detectedLanguage: null,
      hanCount,
      latinLetters,
      latinWords,
    };
  }

  if (hasZhSignal && (!hasEnSignal || hanCount >= Math.max(6, Math.floor(latinLetters * 1.2)))) {
    return {
      hasEnoughSignal: true,
      detectedLanguage: "zh",
      hanCount,
      latinLetters,
      latinWords,
    };
  }

  if (hasEnSignal && (!hasZhSignal || latinLetters >= Math.max(14, Math.floor(hanCount * 1.8)))) {
    return {
      hasEnoughSignal: true,
      detectedLanguage: "en",
      hanCount,
      latinLetters,
      latinWords,
    };
  }

  return {
    hasEnoughSignal: false,
    detectedLanguage: null,
    hanCount,
    latinLetters,
    latinWords,
  };
}

export function detectResponseLanguageMismatch(input: {
  text: string;
  targetLanguage: "zh" | "en";
}): {
  mismatch: boolean;
  hasEnoughSignal: boolean;
  detectedLanguage: "zh" | "en" | null;
  hanCount: number;
  latinLetters: number;
  latinWords: number;
} {
  const signal = detectResponseNaturalLanguage(input.text);
  if (!signal.hasEnoughSignal || !signal.detectedLanguage) {
    return {
      mismatch: false,
      hasEnoughSignal: signal.hasEnoughSignal,
      detectedLanguage: signal.detectedLanguage,
      hanCount: signal.hanCount,
      latinLetters: signal.latinLetters,
      latinWords: signal.latinWords,
    };
  }

  return {
    mismatch: signal.detectedLanguage !== input.targetLanguage,
    hasEnoughSignal: true,
    detectedLanguage: signal.detectedLanguage,
    hanCount: signal.hanCount,
    latinLetters: signal.latinLetters,
    latinWords: signal.latinWords,
  };
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
export type PlanTaskEvidenceKind = "file" | "cmd" | "deliverable" | "tool" | "text";
export type PlanTaskEvidenceStatus = "missing" | "partial" | "satisfied";
export type PlanExecutionProgressPhase =
  | "starting"
  | "running"
  | "tool_start"
  | "tool_done"
  | "tool_error"
  | "waiting_review"
  | "context_compression"
  | "checkpoint"
  | "auto_resume"
  | "paused"
  | "completed";

export interface PlanTaskEvidence {
  kind: PlanTaskEvidenceKind;
  value: string;
  inferred?: boolean;
}

export interface PlanExecutionEvidenceEntry {
  id: string;
  kind: PlanTaskEvidenceKind;
  value: string;
  sourceTool: string;
  target?: string;
  references?: string[];
  createdAt: number;
}

export interface PlanExecutionProgressSnapshot {
  turnId: string;
  phase: PlanExecutionProgressPhase;
  currentTask: string;
  currentTool: string;
  latestEvidence: string;
  nextStep: string;
  iteration: number;
  maxIterations: number;
  autoResumeCount: number;
  updatedAt: number;
}

export type PlanExecutionProgressUpdate = Omit<PlanExecutionProgressSnapshot, "turnId" | "updatedAt"> & {
  turnId?: string;
  updatedAt?: number;
};

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
  claimedStatus?: PlanTaskStatus;
  requirementRef?: string;
  commands?: string[];
  evidence?: PlanTaskEvidence[];
  evidenceStatus?: PlanTaskEvidenceStatus;
  blockedReason?: string;
  retained?: boolean;
}

export interface PlanTaskEvidenceAudit {
  tasks: PlanTask[];
  completedCount: number;
  totalCount: number;
  remainingTasks: PlanTask[];
  blockedReasons: string[];
  acceptedCompletion: boolean;
}

export interface PlanArtifactValidationResult {
  ok: boolean;
  reason?: string;
}

export interface ChangeEntry {
  taskId: number;
  target: string;
  displayTarget: string;
  added: number;
  removed: number;
  editCount: number;
  order: number;
  isPlanFile: boolean;
}

export interface ReplyOption {
  label: string;
  value: string;
  action?: "continue_readonly_once" | "allow_readonly_session" | "execute_once";
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
  commandDirective?: CommandDirective | null;
  mode: LegacyWorkflowMode;
  intent?: ResolvedRunIntent;
  status: ConversationTurnStatus;
  summary: string;
  blockIds: number[];
  collapsed: boolean;
  createdAt: number;
}

export function shouldPlanShortcutReplaceTurn(input: {
  isPlanTurn: boolean;
  hasCompletePlan: boolean;
  isPlanExecutionVisible: boolean;
}): boolean {
  return input.isPlanTurn && input.hasCompletePlan && !input.isPlanExecutionVisible;
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
  hasExplicitUserChoiceRequest: boolean;
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
  const stripped = String(prompt || "")
    .replace(/^\/[^\s]+\s*/u, "")
    .replace(/^(?:请|帮我|麻烦|please)\s*/i, "")
    .replace(/^你是[^，。.!?]{2,80}[，,]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/(?:CTB|回合制).*(?:战斗|Battle)|(?:战斗|Battle).*(?:CTB|回合制)/i.test(stripped)) {
    return maxLength <= 18 ? "CTB 战斗框架" : "实现 CTB 战斗框架";
  }
  if (/(?:sidebar|侧边栏|会话).*(?:标题|title)|(?:标题|title).*(?:sidebar|侧边栏|会话)/i.test(stripped)) {
    return maxLength <= 18 ? "会话标题优化" : "优化会话标题";
  }
  if (/(?:计划|plan).*(?:审批|批准|approval)|(?:审批|批准|approval).*(?:计划|plan)/i.test(stripped)) {
    return maxLength <= 18 ? "计划审批流程" : "修复计划审批流程";
  }

  return normalizeConversationDisplayTitle(stripped || prompt, maxLength, "新的任务");
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

export function isEphemeralPlanArtifactPath(path: string | undefined | null): boolean {
  const kind = detectPlanArtifactKind(String(path || ""));
  return kind === "requirements" || kind === "design" || kind === "tasks";
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

function hashStringStable(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizePlanTaskText(text: string): string {
  return String(text || "")
    .replace(/\s*→\s*对应需求[:：]?\s*REQ-[A-Za-z0-9_-]+/i, "")
    .replace(/^\s*(?:任务\s*)?\d+\s*[.、):：-]\s*/i, "")
    .replace(/\s*[（(]\s*(?:已完成|完成|done|completed)\s*[）)]\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getPlanTaskIdentity(task: Pick<PlanTask, "text" | "requirementRef">): string {
  const normalizedText = normalizePlanTaskText(task.text).toLowerCase();
  return task.requirementRef
    ? `req:${task.requirementRef.toLowerCase()}:${hashStringStable(normalizedText).slice(0, 8)}`
    : `text:${hashStringStable(normalizedText)}`;
}

export function createPlanTaskId(text: string, requirementRef?: string): string {
  return `plan-task-${getPlanTaskIdentity({ text, requirementRef }).replace(/[^a-z0-9_-]+/gi, "-")}`;
}

const PLAN_TASK_EVIDENCE_LABEL_RE = /(?:^|\s)[（(]?\s*(?:证据|evidence)\s*[:：]\s*([\s\S]+?)\s*[）)]?\s*$/i;
const PLAN_TASK_EVIDENCE_ITEM_RE =
  /\b(file|cmd|command|deliverable|tool|text)\s*[:：]\s*([^,，;；]+(?:\s+(?!\b(?:file|cmd|command|deliverable|tool|text)\s*[:：])[^,，;；]+)*)/gi;
const PLAN_TASK_FILE_REF_RE =
  /(?:^|[\s`"'(（])((?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})(?=$|[\s`"',，。；;:)）])/g;

function normalizeEvidenceKind(kind: string): PlanTaskEvidenceKind {
  const normalized = String(kind || "").trim().toLowerCase();
  if (normalized === "command") return "cmd";
  if (normalized === "file" || normalized === "cmd" || normalized === "deliverable" || normalized === "tool" || normalized === "text") {
    return normalized;
  }
  return "text";
}

export function normalizePlanEvidenceValue(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const INTERNAL_PLAN_EVIDENCE_RE = /(?:^|[\\/])\.main[\\/]plans[\\/]/i;

function isInternalPlanEvidenceValue(value: string | undefined | null): boolean {
  return INTERNAL_PLAN_EVIDENCE_RE.test(String(value || "").replace(/\\/g, "/").toLowerCase());
}

function normalizeCommandEvidenceValue(value: string): string {
  return normalizePlanEvidenceValue(value)
    .replace(/\s+\d?>&\d+\b/g, "")
    .replace(/\s+\d?>{1,2}\s*(?:"[^"]+"|'[^']+'|\S+)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitCommandEvidenceSegments(value: string): string[] {
  const normalized = normalizeCommandEvidenceValue(value);
  if (!normalized) return [];
  const segments = normalized
    .split(/\s*(?:&&|\|\||;)\s*/g)
    .map((segment) => segment.replace(/^\(\s*/, "").replace(/\s*\)$/, "").trim())
    .filter(Boolean)
    .filter((segment) => !/^(?:cd|pushd|popd)\b/.test(segment));
  return segments.length > 0 ? segments : [normalized];
}

function commandEvidenceMatches(expectedRaw: string, actualRaw: string): boolean {
  const expected = normalizeCommandEvidenceValue(expectedRaw);
  const actual = normalizeCommandEvidenceValue(actualRaw);
  if (!expected || !actual) return false;
  if (expected === actual) return true;

  const actualSegments = splitCommandEvidenceSegments(actual);
  return actualSegments.some((segment) =>
    segment === expected ||
    segment.startsWith(`${expected} `)
  );
}

function evidencePathMatches(candidateRaw: string, expectedRaw: string): boolean {
  const expected = normalizePlanEvidenceValue(expectedRaw);
  const candidate = normalizePlanEvidenceValue(candidateRaw);
  if (!expected || !candidate) return false;
  if (isInternalPlanEvidenceValue(expected) || isInternalPlanEvidenceValue(candidate)) return false;
  if (candidate === expected || candidate.endsWith(`/${expected}`) || expected.endsWith(`/${candidate}`)) return true;

  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'(:=])${escaped}(?:$|[\\s"',):;])`, "i").test(candidate);
}

function makePlanTaskEvidence(
  kind: PlanTaskEvidenceKind,
  value: string,
  inferred = false,
): PlanTaskEvidence | null {
  const clean = String(value || "").replace(/^['"`]+|['"`]+$/g, "").trim();
  if (!clean) return null;
  return { kind, value: clean, ...(inferred ? { inferred: true } : {}) };
}

function dedupePlanTaskEvidence(evidence: PlanTaskEvidence[]): PlanTaskEvidence[] {
  const seen = new Set<string>();
  const deduped: PlanTaskEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.kind}:${normalizePlanEvidenceValue(item.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function parsePlanTaskEvidenceLabel(rawText: string): { text: string; evidence: PlanTaskEvidence[] } {
  const matched = rawText.match(PLAN_TASK_EVIDENCE_LABEL_RE);
  if (!matched) return { text: rawText.trim(), evidence: [] };

  const evidenceText = matched[1] || "";
  const evidence: PlanTaskEvidence[] = [];
  for (const item of evidenceText.matchAll(PLAN_TASK_EVIDENCE_ITEM_RE)) {
    const kind = normalizeEvidenceKind(item[1] || "");
    const parsed = makePlanTaskEvidence(kind, item[2] || "");
    if (parsed) evidence.push(parsed);
  }

  if (evidence.length === 0) return { text: rawText.trim(), evidence: [] };
  return {
    text: rawText.slice(0, matched.index).replace(/\s*[—-]\s*$/, "").trim(),
    evidence: dedupePlanTaskEvidence(evidence),
  };
}

export function inferPlanTaskEvidence(text: string, commands: string[] = []): PlanTaskEvidence[] {
  const evidence: PlanTaskEvidence[] = [];
  for (const command of commands) {
    const parsed = makePlanTaskEvidence("cmd", command, true);
    if (parsed) evidence.push(parsed);
  }

  for (const matched of String(text || "").matchAll(PLAN_TASK_FILE_REF_RE)) {
    const parsed = makePlanTaskEvidence("file", matched[1] || "", true);
    if (parsed) evidence.push(parsed);
  }

  return dedupePlanTaskEvidence(evidence);
}

function evidenceMatchesRecord(
  evidence: PlanTaskEvidence,
  record: PlanExecutionEvidenceEntry,
): boolean {
  const expected = normalizePlanEvidenceValue(evidence.value);
  const actual = normalizePlanEvidenceValue(record.value || record.target || "");
  if (!expected || !actual) return false;

  if (evidence.kind === "cmd") {
    return record.kind === "cmd" && commandEvidenceMatches(evidence.value, record.value || record.target || "");
  }

  if (evidence.kind === "tool") {
    return normalizePlanEvidenceValue(record.sourceTool) === expected || actual === expected;
  }

  if (evidence.kind === "text") {
    return actual.includes(expected) || expected.includes(actual);
  }

  if (evidence.kind === "file" || evidence.kind === "deliverable") {
    if (record.kind === "file" || record.kind === "deliverable") {
      return evidencePathMatches(record.value || record.target || "", evidence.value);
    }
    return false;
  }

  return false;
}

function resolvePlanTaskEvidenceStatus(
  task: PlanTask,
  evidenceLedger: PlanExecutionEvidenceEntry[],
): { status: PlanTaskEvidenceStatus; matched: number; total: number; blockedReason?: string } {
  const evidence = task.evidence && task.evidence.length > 0
    ? task.evidence
    : inferPlanTaskEvidence(task.text, task.commands || []);
  if (evidence.length === 0) {
    return {
      status: "missing",
      matched: 0,
      total: 0,
      blockedReason: "缺少可验证证据标签或可推断的文件/命令引用",
    };
  }

  const matched = evidence.filter((item) =>
    evidenceLedger.some((record) => evidenceMatchesRecord(item, record))
  ).length;

  if (matched === evidence.length) {
    return { status: "satisfied", matched, total: evidence.length };
  }

  return {
    status: matched > 0 ? "partial" : "missing",
    matched,
    total: evidence.length,
    blockedReason: matched > 0
      ? `仅满足 ${matched}/${evidence.length} 条证据`
      : "缺少真实执行证据，暂不能标记完成",
  };
}

export function isPlanTaskTrustedComplete(task: PlanTask): boolean {
  return task.status === "completed" && task.evidenceStatus === "satisfied";
}

export function reconcilePlanTaskCompletion(
  previousTasks: PlanTask[],
  parsedTasks: PlanTask[],
  evidenceLedger: PlanExecutionEvidenceEntry[],
  options: { preserveMissing?: boolean; highlightNext?: boolean } = {},
): PlanTask[] {
  const merged = mergePlanTasks(previousTasks, parsedTasks, options.preserveMissing ?? true);
  const reconciled = merged.map((task) => {
    const evidence = task.evidence && task.evidence.length > 0
      ? task.evidence
      : inferPlanTaskEvidence(task.text, task.commands || []);
    const evidenceResult = resolvePlanTaskEvidenceStatus({ ...task, evidence }, evidenceLedger);
    const claimedStatus = task.claimedStatus || task.status;
    const status: PlanTaskStatus =
      evidenceResult.status === "satisfied"
        ? "completed"
        : task.status === "in_progress" || claimedStatus === "completed" || evidenceResult.status === "partial"
        ? "in_progress"
        : "pending";

    return {
      ...task,
      claimedStatus,
      status,
      evidence,
      evidenceStatus: evidenceResult.status,
      blockedReason: evidenceResult.status === "satisfied" ? undefined : evidenceResult.blockedReason,
    };
  });

  if (!options.highlightNext) return reconciled;
  const hasInProgress = reconciled.some((task) => task.status === "in_progress");
  if (hasInProgress) return reconciled;
  const firstPendingIndex = reconciled.findIndex((task) => task.status === "pending");
  if (firstPendingIndex === -1) return reconciled;
  return reconciled.map((task, index) =>
    index === firstPendingIndex ? { ...task, status: "in_progress" as const } : task
  );
}

function formatAuditEvidence(task: PlanTask): string {
  const evidence = task.evidence && task.evidence.length > 0
    ? task.evidence.map((item) => `${item.kind}:${item.value}`).join(", ")
    : "";
  return evidence || "missing evidence label";
}

export function buildPlanTaskEvidenceAudit(input: {
  tasks: PlanTask[];
  evidenceLedger?: PlanExecutionEvidenceEntry[];
  preserveMissing?: boolean;
  highlightNext?: boolean;
}): PlanTaskEvidenceAudit {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const auditedTasks = input.evidenceLedger
    ? reconcilePlanTaskCompletion([], tasks, input.evidenceLedger, {
        preserveMissing: input.preserveMissing ?? false,
        highlightNext: input.highlightNext ?? false,
      })
    : tasks;
  const remainingTasks = auditedTasks.filter((task) => !isPlanTaskTrustedComplete(task));
  const blockedReasons = remainingTasks.map((task, index) => {
    const status = task.evidenceStatus || task.status || "missing";
    const reason = task.blockedReason || (task.evidence && task.evidence.length > 0
      ? "waiting for trusted execution evidence"
      : "missing verifiable evidence label or inferable file/command reference");
    return `${index + 1}. ${task.text} [${status}; ${formatAuditEvidence(task)}] - ${reason}`;
  });

  return {
    tasks: auditedTasks,
    completedCount: auditedTasks.filter(isPlanTaskTrustedComplete).length,
    totalCount: auditedTasks.length,
    remainingTasks,
    blockedReasons,
    acceptedCompletion: auditedTasks.length > 0 && remainingTasks.length === 0,
  };
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
    const withoutRequirement = rawText.replace(/\s*→\s*对应需求[:：]?\s*REQ-[A-Za-z0-9_-]+/i, "").trim();
    const parsedEvidence = parsePlanTaskEvidenceLabel(withoutRequirement);
    const text = parsedEvidence.text;
    const commands = extractShellCommandsFromText(rawText);
    const inferredEvidence = parsedEvidence.evidence.length > 0
      ? []
      : inferPlanTaskEvidence(text, commands);
    const evidence = dedupePlanTaskEvidence([...parsedEvidence.evidence, ...inferredEvidence]);
    const claimedStatus: PlanTaskStatus = matched[1].toLowerCase() === "x" ? "completed" : "pending";

    tasks.push({
      id: createPlanTaskId(text, requirementMatched?.[0]),
      text,
      // Checkbox state is model-authored and therefore only a claim. The
      // trusted status is reconciled later against the evidence ledger.
      status: "pending",
      claimedStatus,
      ...(requirementMatched ? { requirementRef: requirementMatched[0] } : {}),
      ...(commands.length > 0 ? { commands } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
      evidenceStatus: "missing",
      ...(claimedStatus === "completed" ? { blockedReason: "等待真实执行证据确认完成" } : {}),
    });
  }

  return tasks;
}

function mergePlanTaskStatus(previous: PlanTask | undefined, next: PlanTask): PlanTaskStatus {
  if (!previous) return next.status;
  if (isPlanTaskTrustedComplete(previous)) return "completed";
  if (isPlanTaskTrustedComplete(next)) return "completed";
  if (previous.status === "in_progress" && next.status === "pending") return "in_progress";
  return next.status;
}

export function mergePlanTasks(
  previousTasks: PlanTask[],
  parsedTasks: PlanTask[],
  preserveMissing = true,
): PlanTask[] {
  if (!previousTasks.length) return parsedTasks;
  if (!parsedTasks.length) return preserveMissing ? previousTasks.map((task) => ({ ...task, retained: true })) : [];

  const previousById = new Map(previousTasks.map((task) => [task.id, task]));
  const previousByIdentity = new Map(previousTasks.map((task) => [getPlanTaskIdentity(task), task]));
  const usedPreviousIds = new Set<string>();

  const merged: PlanTask[] = parsedTasks.map((task) => {
    const previous = previousById.get(task.id) || previousByIdentity.get(getPlanTaskIdentity(task));
    if (previous) usedPreviousIds.add(previous.id);
    return {
      ...task,
      id: previous?.id || task.id,
      status: mergePlanTaskStatus(previous, task),
      claimedStatus: task.claimedStatus || previous?.claimedStatus || task.status,
      evidence: task.evidence && task.evidence.length > 0 ? task.evidence : previous?.evidence,
      evidenceStatus: previous?.evidenceStatus || task.evidenceStatus,
      blockedReason: previous?.blockedReason || task.blockedReason,
      retained: false,
    };
  });

  if (!preserveMissing) return merged;

  for (const previous of previousTasks) {
    if (usedPreviousIds.has(previous.id)) continue;
    merged.push({
      ...previous,
      claimedStatus: previous.claimedStatus || previous.status,
      retained: true,
    });
  }

  return merged;
}

export function findDroppedPlanTasks(previousTasks: PlanTask[], parsedTasks: PlanTask[]): PlanTask[] {
  if (!previousTasks.length) return [];
  if (!parsedTasks.length) return previousTasks;
  const parsedIds = new Set(parsedTasks.map((task) => task.id));
  const parsedIdentities = new Set(parsedTasks.map((task) => getPlanTaskIdentity(task)));
  return previousTasks.filter((task) => !parsedIds.has(task.id) && !parsedIdentities.has(getPlanTaskIdentity(task)));
}

const PLAN_ARTIFACT_NOISE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /自动生成的兜底草稿|Auto-generated fallback draft|MAIN\s+将可用输出收束|condensed the usable output/i, reason: "fallback_notice" },
  { pattern: /Repeated read-only tool call skipped|Duplicate skip count|FILE_UNCHANGED_STUB|already called with identical arguments/i, reason: "tool_log" },
  { pattern: /后台思考已折叠|thinking process|chain of thought|<\/thinking>|<\/analysis>|让我(?:先|再)|但是等等|我认为/i, reason: "reasoning_leak" },
  { pattern: /回复被截断|maximum token|max token|finish_reason.*length/i, reason: "truncation_log" },
  { pattern: /\busing\s+System\s*;|namespace\s+[A-Za-z0-9_.]+\s*\{|public\s+(?:class|enum|struct|interface)\s+[A-Za-z0-9_]+/i, reason: "raw_source_code" },
];

function hasMeaningfulPlanSections(content: string, kind: PlanArtifactKind): boolean {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length < 120) return false;
  if (kind === "requirements") {
    return /(用户目标|目标|需求|范围|交付|验收|User Goal|Requirements|Scope|Deliverables|Acceptance)/i.test(content);
  }
  if (kind === "design") {
    return /(设计|方案|执行|影响文件|数据流|验证|Approach|Design|Execution|Files|Validation)/i.test(content);
  }
  if (kind === "bugfix") {
    return /(现象|根因|修复|影响范围|验证|Symptom|Root Cause|Fix|Validation)/i.test(content);
  }
  return true;
}

export function validatePlanArtifactContent(
  content: string,
  kind: PlanArtifactKind,
): PlanArtifactValidationResult {
  if (kind === "summary") return { ok: true };

  const raw = String(content || "").trim();
  if (!raw) return { ok: false, reason: "empty" };

  if (kind === "tasks") {
    const hasCheckboxTasks = /^\s*[-*]\s+\[[ xX]\]\s+.+$/m.test(raw);
    const tasks = extractPlanTasks(raw);
    if (hasCheckboxTasks && tasks.some((task) => !task.evidence || task.evidence.length === 0)) {
      return { ok: false, reason: "missing_task_evidence" };
    }
    return { ok: true };
  }

  for (const entry of PLAN_ARTIFACT_NOISE_PATTERNS) {
    if (entry.pattern.test(raw)) {
      return { ok: false, reason: entry.reason };
    }
  }

  if (!hasMeaningfulPlanSections(raw, kind)) {
    return { ok: false, reason: "missing_plan_sections" };
  }

  return { ok: true };
}

export function collectChangeEntries(
  blocks: Array<{
    id: number;
    type: string;
    toolName?: string;
    toolStatus?: string;
    target?: string;
    diff?: { old: string; new: string; path?: string; existed?: boolean; fullFile?: boolean };
    revertStatus?: string;
  }>,
  getStats: (oldText: string, newText: string) => { added: number; removed: number },
): { entries: ChangeEntry[]; totalExecutedEdits: number } {
  const entries: ChangeEntry[] = [];
  const indexByTarget = new Map<string, number>();
  let totalExecutedEdits = 0;

  blocks.forEach((block, order) => {
    if (block.type !== "tool" || block.toolStatus !== "executed" || !block.diff) return;
    if (block.toolName !== "write_file" && block.toolName !== "replace_in_file") return;
    if (block.revertStatus === "reverted") return;

    const target = String(block.target || block.diff.path || block.toolName || "");
    if (isEphemeralPlanArtifactPath(target)) return;

    totalExecutedEdits++;
    const displayTarget = target.split("/").pop() || target;
    const stats = getStats(block.diff.old, block.diff.new);
    const existingIndex = indexByTarget.get(target);

    if (existingIndex == null) {
      indexByTarget.set(target, entries.length);
      entries.push({
        taskId: block.id,
        target,
        displayTarget,
        added: stats.added,
        removed: stats.removed,
        editCount: 1,
        order,
        isPlanFile: target.replace(/\\/g, "/").toLowerCase().includes(".main/plans/"),
      });
      return;
    }

    entries[existingIndex] = {
      ...entries[existingIndex],
      taskId: block.id,
      added: stats.added,
      removed: stats.removed,
      editCount: entries[existingIndex].editCount + 1,
      order,
    };
  });

  return {
    entries: entries.sort((a, b) => {
      if (a.isPlanFile !== b.isPlanFile) return a.isPlanFile ? 1 : -1;
      return a.order - b.order;
    }),
    totalExecutedEdits,
  };
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
