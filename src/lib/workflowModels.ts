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

export type RightPanelTab = "plan" | "diff" | "terminal" | "goal";

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

  // If the target language is Chinese ("zh"), and the response has Chinese characters (at least 4),
  // then we should NEVER treat it as a mismatch, even if the natural language detector classified it as "en"
  // due to a high density of English filenames, tools, or code terms.
  const isTargetZhButHasZhSignal = input.targetLanguage === "zh" && signal.hanCount >= 4;
  if (isTargetZhButHasZhSignal) {
    return {
      mismatch: false,
      hasEnoughSignal: true,
      detectedLanguage: "zh",
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

export type PlanArtifactKind = "plan" | "requirements" | "design" | "tasks" | "bugfix" | "summary";

export type PlanStage =
  | "idle"
  | "plan"
  | "requirements"
  | "design"
  | "tasks"
  | "bugfix"
  | "ready_to_execute"
  | "executing"
  | "completed";

export function hasLivePlanWorkspace(input: {
  planArtifacts?: unknown[] | null;
  planTasks?: unknown[] | null;
  planStage?: PlanStage | string | null;
  fallbackPlanPreview?: string | null;
}): boolean {
  return (
    (Array.isArray(input.planArtifacts) ? input.planArtifacts.length : 0) > 0 ||
    (Array.isArray(input.planTasks) ? input.planTasks.length : 0) > 0 ||
    String(input.planStage || "idle") !== "idle" ||
    String(input.fallbackPlanPreview || "").trim().length > 0
  );
}

export type PlanTaskStatus = "pending" | "in_progress" | "completed";
export type PlanTaskEvidenceKind =
  | "file"
  | "cmd"
  | "deliverable"
  | "tool"
  | "text"
  | "browser_dom"
  | "browser_screenshot"
  | "dev_server_url"
  | "tauri_required"
  | "manual_user_validation";
export type PlanTaskEvidenceStatus =
  | "missing"
  | "partial"
  | "satisfied"
  | "blocked"
  | "requires_browser_validation"
  | "requires_tauri_validation"
  | "requires_user_confirmation";
export type PlanTaskValidationCapability =
  | "shell_one_shot"
  | "dev_server"
  | "browser_dom"
  | "browser_screenshot"
  | "tauri_runtime"
  | "manual_user_validation";
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

export type PlanRuntimePhase =
  | "explore_structure"
  | "grounding"
  | "synthesis"
  | "drafting"
  | "needs_evidence"
  | "needs_rewrite"
  | "review_ready"
  | "blocked";

export type PlanArtifactRecoveryAction =
  | "rewrite"
  | "targeted_evidence"
  | "ask_user"
  | "auto_scaffold"
  | "accept";

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
  progressSignature?: string;
  repeatedTargets?: string[];
  lastEffectiveEvidenceAt?: number;
  recoveryReason?: string;
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
  validationCapability?: PlanTaskValidationCapability;
  evidenceStatus?: PlanTaskEvidenceStatus;
  blockedReason?: string;
  retained?: boolean;
}

export interface PlanTaskEvidenceAudit {
  tasks: PlanTask[];
  completedCount: number;
  totalCount: number;
  remainingTasks: PlanTask[];
  pendingUserValidationTasks: PlanTask[];
  automationComplete: boolean;
  allTrustedComplete: boolean;
  pendingExternalValidation: boolean;
  blockedReasons: string[];
  pendingUserValidationReasons: string[];
  acceptedCompletion: boolean;
}

export interface RuntimePlanTaskDerivationOptions {
  language?: "zh" | "en";
  maxTasks?: number;
}

export interface PlanArtifactValidationResult {
  ok: boolean;
  reason?: string;
  missingSections?: string[];
  recoveryAction?: PlanArtifactRecoveryAction;
  canAutoRepair?: boolean;
}

export interface PlanArtifactQualityResult extends PlanArtifactValidationResult {
  missingSections: string[];
  recoveryAction: PlanArtifactRecoveryAction;
  canAutoRepair: boolean;
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
  action?: "continue_readonly_once" | "allow_readonly_session" | "execute_once" | "approve_operation_once" | "adjust_plan" | "cancel_operation";
  source?: "explicit_user_options" | "inferred_binary" | "inferred_enumerated" | "readonly_permission" | "proposal_follow_up" | "operation_approval";
}

export interface PendingOperationProposal {
  sourceTurnId: string;
  proposalSummary: string;
  operationTypes: Array<"file_write" | "command" | "git" | "external_write" | "deploy" | "deliverable" | "unknown">;
  approvalStatus: "pending" | "approved" | "adjusting" | "cancelled";
  evidenceStatus: "none" | "tool_called" | "changed" | "verified" | "blocked";
  createdAt: number;
  approvedAt?: number;
}

export type ConversationTurnStatus =
  | "planning"
  | "awaiting_approval"
  | "awaiting_input"
  | "executing"
  | "completed_with_changes"
  | "paused"
  | "stopped_no_action"
  | "stopped_no_output"
  | "done"
  | "error";

export type VisibleConversationTurnStatus = ConversationTurnStatus;

export interface ConversationTurn {
  id: string;
  userPrompt: string;
  title: string;
  intentSummary?: string;
  commandDirective?: CommandDirective | null;
  pendingOperationProposal?: PendingOperationProposal;
  uiVisibility?: "visible" | "internal";
  parentPlanTurnId?: string;
  mode: LegacyWorkflowMode;
  intent?: ResolvedRunIntent;
  displayIntent?: ResolvedRunIntent;
  status: ConversationTurnStatus;
  summary: string;
  blockIds: number[];
  collapsed: boolean;
  createdAt: number;
  elapsedTime?: number;
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
const TITLE_MODE_PREFIX_RE =
  /^(?:回复|respond|讨论|discuss|计划|plan|直接执行|execute|总结|summarize|报告|report|Game Studio 工作流|Game Studio Workflow)\s*[:：-]\s*/i;
const TITLE_REASONING_LEAK_RE =
  /(?:thinking process|here'?s a thinking|chain of thought|reasoning process|analy(?:s|z)e user input|step\s*1\b|let'?s think|思考过程|分析用户输入|先分析|先思考)/i;
const GENERIC_TURN_TITLE_RE = /^(?:新的任务|新任务|new task|turn decision|本轮决策|new conversation|新会话|new chat|新聊天)$/i;

/**
 * 统一清理标题中的转录元信息、Markdown 噪音和误入的状态前缀，
 * 避免 sidebar / ExecutionCapsule 直接展示用户名、时间戳或推理泄漏文本。
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
 * ExecutionCapsule 在贴底自动跟随时应始终代表最新回合；
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
 * ExecutionCapsule 的任务区/审批区应绑定这个稳定上下文。
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

  if (
    !isPlanApproved &&
    (
      agentStatus === "pending_review" ||
      planStage === "ready_to_execute" ||
      planStage === "plan" ||
      planStage === "design" ||
      planStage === "bugfix"
    )
  ) {
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
  if (normalized.endsWith("plan.md")) return "plan";
  if (normalized.endsWith("requirements.md")) return "requirements";
  if (normalized.endsWith("design.md")) return "design";
  if (normalized.endsWith("tasks.md")) return "tasks";
  if (normalized.endsWith("bugfix.md")) return "bugfix";
  return null;
}

export function isEphemeralPlanArtifactPath(path: string | undefined | null): boolean {
  const kind = detectPlanArtifactKind(String(path || ""));
  return kind === "plan" || kind === "requirements" || kind === "tasks";
}

export function isPlanConversationTurn(turn: ConversationTurn | null | undefined): boolean {
  return resolveConversationTurnIntent(turn) === "plan";
}

/**
 * 根据产物类型推导当前计划阶段。
 */
export function planStageFromArtifactKind(kind: PlanArtifactKind): PlanStage {
  switch (kind) {
    case "plan":
      return "plan";
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
const SHELL_COMMAND_CODE_IDENTIFIER_RE = /^(?:tauri|vite|node|deno|composer|php|ruby|rails|make|cmake|xcodebuild)::|^[A-Za-z_$][\w$]*(?:::|[.[(])/;
const SHELL_COMMAND_REQUIRED_OPERAND_RE = /^(?:tauri|vite|node|deno|composer|php|ruby|rails|make|cmake|xcodebuild)$/i;

function pushShellCommand(target: string[], candidate: string) {
  const normalized = candidate
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || !SHELL_COMMAND_START_RE.test(normalized)) return;
  const head = normalized.match(/^([A-Za-z][\w.-]*)\b/)?.[1] || "";
  if (head && head !== head.toLowerCase()) return;
  if (/^[A-Za-z][\w.-]*\//.test(normalized)) return;
  if (SHELL_COMMAND_CODE_IDENTIFIER_RE.test(normalized)) return;
  if (SHELL_COMMAND_REQUIRED_OPERAND_RE.test(normalized)) return;
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
  /\b(file|cmd|command|deliverable|tool|text|browser_dom|browser_screenshot|dev_server_url|tauri_required|manual_user_validation|manual|browser|screenshot|tauri)\s*[:：]\s*([^,，;；]+(?:\s+(?!\b(?:file|cmd|command|deliverable|tool|text|browser_dom|browser_screenshot|dev_server_url|tauri_required|manual_user_validation|manual|browser|screenshot|tauri)\s*[:：])[^,，;；]+)*)/gi;
const PLAN_TASK_FILE_REF_RE =
  /(?:^|[\s`"'(（])((?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})(?=$|[\s`"',，。；;:)）])/g;

function isLikelyWorkspaceFileReference(value: string): boolean {
  const normalized = String(value || "").replace(/\\/g, "/").trim();
  if (!normalized) return false;
  if (/^\d+(?:\.\d+)+$/.test(normalized)) return false;
  const ext = normalized.split(".").pop() || "";
  if (/^\d+$/.test(ext) && !normalized.includes("/")) return false;
  return true;
}

function normalizeEvidenceKind(kind: string): PlanTaskEvidenceKind {
  const normalized = String(kind || "").trim().toLowerCase();
  if (normalized === "command") return "cmd";
  if (normalized === "browser") return "browser_dom";
  if (normalized === "screenshot") return "browser_screenshot";
  if (normalized === "manual") return "manual_user_validation";
  if (normalized === "tauri") return "tauri_required";
  if (
    normalized === "file" ||
    normalized === "cmd" ||
    normalized === "deliverable" ||
    normalized === "tool" ||
    normalized === "text" ||
    normalized === "browser_dom" ||
    normalized === "browser_screenshot" ||
    normalized === "dev_server_url" ||
    normalized === "tauri_required" ||
    normalized === "manual_user_validation"
  ) {
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

const INTERNAL_PLAN_EVIDENCE_RE = /(?:^|[\\/])\.?main[\\/]plans[\\/]/i;

function isInternalPlanEvidenceValue(value: string | undefined | null): boolean {
  return INTERNAL_PLAN_EVIDENCE_RE.test(String(value || "").replace(/\\/g, "/").toLowerCase());
}

function planEvidenceSectionsContainInternalPlanArtifacts(content: string): boolean {
  let inEvidenceSection = false;
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const heading = rawLine.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      const title = heading[1] || "";
      inEvidenceSection =
        /(?:已读证据|证据引用|Read Evidence|Evidence References|References)/i.test(title) &&
        !/(?:验证|测试|Validation|Test|Testing)/i.test(title);
      continue;
    }
    if (inEvidenceSection && isInternalPlanEvidenceValue(rawLine)) {
      return true;
    }
  }
  return false;
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

function commandLooksLikePlaywrightOrBrowserTest(value: string): boolean {
  return /\b(?:playwright|cypress|puppeteer|browser\s+test|e2e)\b/i.test(String(value || ""));
}

function commandLooksLikeDevServerOrHttpProbe(value: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:dev|preview|vite)\b/i.test(String(value || "")) ||
    /\b(?:vite|webpack-dev-server|next\s+dev)\b/i.test(String(value || "")) ||
    /\bcurl\b[\s\S]{0,120}\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)/i.test(String(value || ""));
}

function sourceToolLooksLikeBrowserAutomation(toolName: string): boolean {
  return /(?:browser|playwright|puppeteer|cypress)/i.test(String(toolName || ""));
}

function sourceToolLooksLikeTauriAutomation(toolName: string): boolean {
  return /(?:tauri|desktop|computer|osascript|applescript|webdriver)/i.test(String(toolName || ""));
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

const VALIDATION_ACTION_RE =
  /(?:验证|测试|检查|验收|确认|打开|预览|渲染|显示|截图|启动|verify|test|check|validate|render|preview|open|screenshot|start|serve)/i;
const BROWSER_VALIDATION_RE =
  /(?:浏览器|页面|前端|UI|DOM|截图|可视|可见|视觉|渲染|预览|图表|显示|颜色|深色|浅色|主题切换|localhost|127\.0\.0\.1|Playwright|Cypress|Puppeteer|browser|page|frontend|screenshot|render|preview|DOM)/i;
const MARKDOWN_VIEWER_VALIDATION_RE =
  /(?:Markdown|md|test-sample\.md|mermaid|代码块|表格|脚注|标题|preview|预览|渲染)/i;
const TAURI_VALIDATION_RE =
  /(?:Tauri|invoke\(['"`](?:open_file|save_file|save_file_as)|open_file|save_file|文件选择|文件对话框|系统浏览器|桌面|窗口|原生|desktop|file\s+dialog|native|system integration)/i;
const MANUAL_VALIDATION_RE =
  /(?:手动|人工|用户(?:自己)?|你自己|自行|肉眼|确认|manual|human|user confirmation|user validation|visually inspect)/i;
const SOURCE_MUTATION_TASK_RE =
  /(?:实现|修改|更新|新增|添加|修复|补齐|调整|接入|集成|生成|输出|落地|创建|删除|替换|重构|保存|导出|防御性编程|implement|update|modify|fix|add|wire|integrate|generate|write|create|delete|replace|refactor|save|export)/i;
const PRIMARY_VALIDATION_TASK_RE =
  /(?:^\s*(?:手动测试|自动测试|视觉回归|回归测试|测试|验证|验收|检查|打开|预览|截图)(?:\s|[:：]|$)|^\s*(?:run|verify|test|validate|check|visual regression|screenshot)\b|[:：]\s*(?:验证|测试|检查|验收|确认)|[:：]\s*(?:verify|test|validate|check)\b)/i;
const CODE_IDENTIFIER_REF_RE =
  /`([A-Za-z_$][\w$]*)`|(?:^|[\s（(【\[{:：，,])((?:use[A-Z][A-Za-z0-9_]*|[a-z][A-Za-z0-9_]*Store))(?=$|[\s）)】\]}，,。.;；:：])/g;

function inferValidationTaskEvidence(text: string, commands: string[] = []): PlanTaskEvidence[] {
  const normalized = String(text || "");
  if (!VALIDATION_ACTION_RE.test(normalized)) return [];
  if (commands.some(commandLooksLikePlaywrightOrBrowserTest)) {
    return [];
  }

  if (TAURI_VALIDATION_RE.test(normalized)) {
    const parsed = makePlanTaskEvidence("tauri_required", "tauri runtime validation", true);
    return parsed ? [parsed] : [];
  }

  if (BROWSER_VALIDATION_RE.test(normalized) || MARKDOWN_VIEWER_VALIDATION_RE.test(normalized)) {
    const parsed = makePlanTaskEvidence("browser_dom", "browser DOM validation", true);
    return parsed ? [parsed] : [];
  }

  if (MANUAL_VALIDATION_RE.test(normalized)) {
    const parsed = makePlanTaskEvidence("manual_user_validation", "user confirmation", true);
    return parsed ? [parsed] : [];
  }

  if (/(?:localhost|127\.0\.0\.1|\bdev server\b|开发服务器|服务器|服务|端口|\bport\b)/i.test(normalized)) {
    const parsed = makePlanTaskEvidence("dev_server_url", "dev server reachable", true);
    return parsed ? [parsed] : [];
  }

  return [];
}

function planTaskEvidenceStatusForUnmatchedValidation(evidence: PlanTaskEvidence[]): {
  status?: PlanTaskEvidenceStatus;
  capability?: PlanTaskValidationCapability;
  reason?: string;
} {
  if (evidence.some((item) => item.kind === "tauri_required")) {
    return {
      status: "requires_tauri_validation",
      capability: "tauri_runtime",
      reason: "需要 Tauri/桌面运行时或用户手动确认，普通 Vite/HTTP 验证不能替代",
    };
  }
  if (evidence.some((item) => item.kind === "manual_user_validation")) {
    return {
      status: "requires_user_confirmation",
      capability: "manual_user_validation",
      reason: "该任务需要用户确认，模型不能用命令输出替代人工验收",
    };
  }
  if (evidence.some((item) => item.kind === "browser_dom" || item.kind === "browser_screenshot")) {
    return {
      status: "requires_browser_validation",
      capability: evidence.some((item) => item.kind === "browser_screenshot") ? "browser_screenshot" : "browser_dom",
      reason: "需要浏览器 DOM/截图级验证；HTTP 可达性或 curl 输出不能证明页面渲染正确",
    };
  }
  if (evidence.some((item) => item.kind === "dev_server_url")) {
    return {
      status: "missing",
      capability: "dev_server",
      reason: "缺少 dev server URL 或 HTTP 可达性证据",
    };
  }
  return {};
}

function initialEvidenceStatusForEvidence(evidence: PlanTaskEvidence[]): PlanTaskEvidenceStatus {
  return planTaskEvidenceStatusForUnmatchedValidation(evidence).status || "missing";
}

function validationCapabilityForEvidence(evidence: PlanTaskEvidence[]): PlanTaskValidationCapability | undefined {
  return planTaskEvidenceStatusForUnmatchedValidation(evidence).capability;
}

function isPackageManifestEvidence(value: string): boolean {
  const normalized = normalizePlanEvidenceValue(value);
  if (!normalized) return false;

  const withoutQualifier = normalized
    .replace(/\s*[（(][^）)]*[）)]\s*$/u, "")
    .replace(/\s+(?:dependencies|devdependencies|scripts|section|block|区块|部分)\b.*$/iu, "")
    .trim();
  const manifestNameRe = /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i;
  return manifestNameRe.test(withoutQualifier);
}

function packageManagerCommandMutatesManifest(commandRaw: string): boolean {
  const segments = splitCommandEvidenceSegments(commandRaw);
  return segments.some((segment) =>
    /^(?:npm|pnpm|bun)\s+(?:i|install|add|remove|uninstall|update)\b/i.test(segment) ||
    /^yarn\s+(?:add|remove|install|upgrade)\b/i.test(segment)
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

function inferSourcePathFromCodeIdentifier(identifier: string): string | null {
  const clean = String(identifier || "").trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(clean)) return null;
  if (/^[a-z][A-Za-z0-9_]*Store$/.test(clean)) return `src/store/${clean}.ts`;
  if (/^use[A-Z][A-Za-z0-9_]*$/.test(clean)) return `src/hooks/${clean}.ts`;
  return null;
}

function inferSourceEvidenceFromCodeIdentifiers(text: string): PlanTaskEvidence[] {
  const evidence: PlanTaskEvidence[] = [];
  for (const matched of String(text || "").matchAll(CODE_IDENTIFIER_REF_RE)) {
    const identifier = matched[1] || matched[2] || "";
    const sourcePath = inferSourcePathFromCodeIdentifier(identifier);
    if (!sourcePath) continue;
    const parsed = makePlanTaskEvidence("file", sourcePath, true);
    if (parsed) evidence.push(parsed);
  }
  return dedupePlanTaskEvidence(evidence);
}

function isLikelySourceMutationTask(text: string): boolean {
  const normalized = String(text || "");
  if (!SOURCE_MUTATION_TASK_RE.test(normalized)) return false;
  return !PRIMARY_VALIDATION_TASK_RE.test(normalized);
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

  const fileEvidence: PlanTaskEvidence[] = [];
  for (const matched of String(text || "").matchAll(PLAN_TASK_FILE_REF_RE)) {
    if (!isLikelyWorkspaceFileReference(matched[1] || "")) continue;
    const parsed = makePlanTaskEvidence("file", matched[1] || "", true);
    if (parsed) fileEvidence.push(parsed);
  }

  if (isLikelySourceMutationTask(text)) {
    const sourceEvidence = dedupePlanTaskEvidence([
      ...fileEvidence,
      ...inferSourceEvidenceFromCodeIdentifiers(text),
    ]);
    if (sourceEvidence.length > 0) {
      return dedupePlanTaskEvidence([...evidence, ...sourceEvidence]);
    }
    return dedupePlanTaskEvidence(evidence);
  }

  const validationEvidence = inferValidationTaskEvidence(text, commands);
  if (validationEvidence.length > 0) {
    return dedupePlanTaskEvidence(validationEvidence);
  }

  evidence.push(...fileEvidence);

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

  if (evidence.kind === "dev_server_url") {
    if (record.kind === "dev_server_url") return true;
    return record.kind === "cmd" && commandLooksLikeDevServerOrHttpProbe(record.value || record.target || "");
  }

  if (evidence.kind === "browser_dom" || evidence.kind === "browser_screenshot") {
    if (record.kind === "browser_dom" || record.kind === "browser_screenshot") return true;
    if (record.kind === "cmd" && commandLooksLikePlaywrightOrBrowserTest(record.value || record.target || "")) return true;
    return sourceToolLooksLikeBrowserAutomation(record.sourceTool);
  }

  if (evidence.kind === "tauri_required") {
    return record.kind === "tauri_required" || sourceToolLooksLikeTauriAutomation(record.sourceTool);
  }

  if (evidence.kind === "manual_user_validation") {
    return record.kind === "manual_user_validation";
  }

  if (evidence.kind === "file" || evidence.kind === "deliverable") {
    if (record.kind === "file" || record.kind === "deliverable") {
      return evidencePathMatches(record.value || record.target || "", evidence.value);
    }
    if (
      record.kind === "cmd" &&
      isPackageManifestEvidence(evidence.value) &&
      packageManagerCommandMutatesManifest(record.value || record.target || "")
    ) {
      return true;
    }
    return false;
  }

  return false;
}

export function findFirstPlanTaskEvidenceRecord(
  task: Pick<PlanTask, "text" | "commands" | "evidence">,
  evidenceLedger: PlanExecutionEvidenceEntry[] = [],
): { record: PlanExecutionEvidenceEntry; ledgerIndex: number } | null {
  const evidence = task.evidence && task.evidence.length > 0
    ? task.evidence
    : inferPlanTaskEvidence(task.text, task.commands || []);
  if (evidence.length === 0 || evidenceLedger.length === 0) return null;

  for (let ledgerIndex = 0; ledgerIndex < evidenceLedger.length; ledgerIndex += 1) {
    const record = evidenceLedger[ledgerIndex];
    if (evidence.some((item) => evidenceMatchesRecord(item, record))) {
      return { record, ledgerIndex };
    }
  }

  return null;
}

function resolvePlanTaskEvidenceStatus(
  task: PlanTask,
  evidenceLedger: PlanExecutionEvidenceEntry[],
): { status: PlanTaskEvidenceStatus; matched: number; total: number; blockedReason?: string; validationCapability?: PlanTaskValidationCapability } {
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

  const validation = planTaskEvidenceStatusForUnmatchedValidation(evidence);
  if (validation.status) {
    return {
      status: validation.status,
      matched,
      total: evidence.length,
      blockedReason: validation.reason,
      validationCapability: validation.capability,
    };
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

export function isPlanTaskAwaitingExternalValidation(task: Pick<PlanTask, "evidenceStatus">): boolean {
  return task.evidenceStatus === "requires_user_confirmation" ||
    task.evidenceStatus === "requires_tauri_validation";
}

export function isPlanTaskAwaitingBrowserValidation(task: Pick<PlanTask, "evidenceStatus">): boolean {
  return task.evidenceStatus === "requires_browser_validation";
}

export function isPlanTaskBlockingAutomation(
  task: PlanTask,
  options: { browserValidationAvailable?: boolean } = {},
): boolean {
  if (isPlanTaskTrustedComplete(task)) return false;
  if (isPlanTaskAwaitingExternalValidation(task)) return false;
  if (isPlanTaskAwaitingBrowserValidation(task) && !options.browserValidationAvailable) return false;
  return true;
}

export function planTaskNeedsUserValidationLabel(
  task: Pick<PlanTask, "evidenceStatus" | "validationCapability">,
): boolean {
  return isPlanTaskAwaitingExternalValidation(task) ||
    (isPlanTaskAwaitingBrowserValidation(task) && task.validationCapability !== "browser_screenshot");
}

export function hasBrowserValidationCapability(toolNames: Iterable<string> | undefined | null): boolean {
  if (!toolNames) return false;
  for (const name of toolNames) {
    if (sourceToolLooksLikeBrowserAutomation(name)) return true;
  }
  return false;
}

export function describePlanValidationDecision(input: {
  task: Pick<PlanTask, "text" | "evidenceStatus" | "validationCapability">;
  language: "zh" | "en";
  browserValidationAvailable?: boolean;
}): string {
  const status = input.task.evidenceStatus;
  if (status === "requires_browser_validation") {
    if (input.browserValidationAvailable) {
      return input.language === "zh"
        ? "下一步应使用浏览器自动化：打开实际 dev server URL，执行 DOM 断言，必要时截图；不要用 curl/grep/cat 替代页面渲染验证。"
        : "Next use browser automation: open the real dev-server URL, run DOM assertions, and take a screenshot if needed; do not substitute curl/grep/cat for rendered-page validation.";
    }
    return input.language === "zh"
      ? "当前缺少浏览器自动化能力，自动验证到此为止；该项应标为待用户验证。"
      : "Browser automation is not available, so automated validation stops here; this item should be left for user validation.";
  }
  if (status === "requires_tauri_validation") {
    return input.language === "zh"
      ? "该项需要 Tauri/桌面运行时验证；普通 Vite 页面只能验证网页渲染，不能替代文件对话框或系统集成。"
      : "This item requires Tauri/desktop-runtime validation; a Vite page can only validate web rendering, not file dialogs or system integration.";
  }
  if (status === "requires_user_confirmation") {
    return input.language === "zh"
      ? "该项需要用户确认，模型应暂停并保留待验证状态。"
      : "This item requires user confirmation; the model should pause and keep it pending validation.";
  }
  return "";
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
      validationCapability: evidenceResult.validationCapability || task.validationCapability,
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
  const pendingUserValidationTasks = auditedTasks.filter((task) =>
    !isPlanTaskTrustedComplete(task) &&
    (isPlanTaskAwaitingExternalValidation(task) || isPlanTaskAwaitingBrowserValidation(task))
  );
  const remainingTasks = auditedTasks.filter((task) => isPlanTaskBlockingAutomation(task, {
    browserValidationAvailable: true,
  }));
  const blockedReasons = remainingTasks.map((task, index) => {
    const status = task.evidenceStatus || task.status || "missing";
    const reason = task.blockedReason || (task.evidence && task.evidence.length > 0
      ? "waiting for trusted execution evidence"
      : "missing verifiable evidence label or inferable file/command reference");
    return `${index + 1}. ${task.text} [${status}; ${formatAuditEvidence(task)}] - ${reason}`;
  });
  const pendingUserValidationReasons = pendingUserValidationTasks.map((task, index) => {
    const status = task.evidenceStatus || task.status || "requires_user_confirmation";
    const reason = task.blockedReason || "waiting for external validation";
    return `${index + 1}. ${task.text} [${status}; ${formatAuditEvidence(task)}] - ${reason}`;
  });
  const automationComplete = auditedTasks.length > 0 && remainingTasks.length === 0;
  const allTrustedComplete = auditedTasks.length > 0 && auditedTasks.every(isPlanTaskTrustedComplete);
  const pendingExternalValidation = pendingUserValidationTasks.length > 0;

  return {
    tasks: auditedTasks,
    completedCount: auditedTasks.filter(isPlanTaskTrustedComplete).length,
    totalCount: auditedTasks.length,
    remainingTasks,
    pendingUserValidationTasks,
    automationComplete,
    allTrustedComplete,
    pendingExternalValidation,
    blockedReasons,
    pendingUserValidationReasons,
    acceptedCompletion: automationComplete,
  };
}

export function syncPlanTaskCheckboxesFromTrustedTasks(
  markdown: string,
  trustedTasks: PlanTask[],
): string {
  if (!String(markdown || "").trim() || trustedTasks.length === 0) return markdown;

  const tasksById = new Map(trustedTasks.map((task) => [task.id, task]));
  const tasksByIdentity = new Map(trustedTasks.map((task) => [getPlanTaskIdentity(task), task]));
  let changed = false;
  const nextLines = markdown.split(/\r?\n/).map((line) => {
    const matched = line.match(/^(\s*[-*]\s+\[)([ xX])(\]\s+.+)$/);
    if (!matched) return line;

    const parsedTask = extractPlanTasks(line)[0];
    if (!parsedTask) return line;

    const trusted =
      tasksById.get(parsedTask.id) ||
      tasksByIdentity.get(getPlanTaskIdentity(parsedTask));
    if (!trusted) return line;

    const nextMark = isPlanTaskTrustedComplete(trusted) ? "x" : " ";
    if ((matched[2] || " ").toLowerCase() === nextMark) return line;
    changed = true;
    return `${matched[1]}${nextMark}${matched[3]}`;
  });

  return changed ? nextLines.join("\n") : markdown;
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
  let currentHeadingEvidence: PlanTaskEvidence[] = [];

  for (const line of lines) {
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) {
      const headingText = stripMarkdownTaskLine(heading[1] || "");
      currentHeadingEvidence = inferPlanTaskEvidence(headingText, extractShellCommandsFromText(headingText))
        .filter((item) => item.kind === "file" || item.kind === "deliverable");
      continue;
    }

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
    const inheritedHeadingEvidence =
      parsedEvidence.evidence.length === 0 &&
      inferredEvidence.length === 0 &&
      currentHeadingEvidence.length > 0 &&
      isLikelySourceMutationTask(text)
        ? currentHeadingEvidence
        : [];
    const evidence = dedupePlanTaskEvidence([
      ...parsedEvidence.evidence,
      ...inferredEvidence,
      ...inheritedHeadingEvidence,
    ]);
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
      ...(validationCapabilityForEvidence(evidence) ? { validationCapability: validationCapabilityForEvidence(evidence) } : {}),
      evidenceStatus: initialEvidenceStatusForEvidence(evidence),
      ...(claimedStatus === "completed" ? { blockedReason: "等待真实执行证据确认完成" } : {}),
    });
  }

  return tasks;
}

const RUNTIME_TASK_ACTION_RE =
  /(?:实现|修改|更新|新增|添加|修复|补齐|调整|接入|集成|生成|输出|执行|运行|验证|测试|检查|落地|implement|update|modify|fix|add|wire|integrate|generate|write|run|verify|test|check|validate)/i;
const RUNTIME_TASK_MUTATION_RE =
  /(?:实现|修改|更新|新增|添加|修复|补齐|调整|接入|集成|生成|输出|落地|创建|删除|替换|重构|保存|导出|implement|update|modify|fix|add|wire|integrate|generate|write|create|delete|replace|refactor|save|export)/i;
const RUNTIME_TASK_VERIFICATION_RE =
  /(?:执行|运行|验证|测试|验收|run|verify|test|validate|acceptance)/i;
const RUNTIME_TASK_READ_ONLY_RE =
  /(?:读取|查看|检查|确认|定位|分析|排查|梳理|调研|审查|理解|read|inspect|review|analy[sz]e|identify|investigate|check|confirm|understand)/i;
const RUNTIME_TASK_FILE_ROLE_RE =
  /(?:负责|用于|包含|当前|现有|可能|根因|原因|问题|错误|不匹配|responsible|handles|contains|current|existing|possible|root cause|finding|issue|mismatch)/i;
const RUNTIME_TASK_SECTION_RE =
  /(?:关键改动|实现改动|改动|执行|实施|任务|步骤|顺序|验证|验收|Key Changes|Implementation Changes|Changes|Execution|Implementation|Tasks|Steps|Order|Validation|Acceptance)/i;
const RUNTIME_TASK_EXCLUDED_SECTION_RE =
  /(?:用户目标|目标|摘要|概要|当前状态|状态发现|现状|背景|问题分析|根因|技术栈|整体结构|影响文件|涉及文件|证据|已读证据|最相关证据|假设|默认值|公共\s*API|接口|类型|数据流|控制流|设计思路|总体思路|User Goals?|Goals?|Summary|Overview|Current State|Findings|Background|Root Cause|Tech Stack|Architecture|Evidence|Read Evidence|Most Relevant Evidence|Assumptions|Defaults|Public APIs|Interfaces|Types|Files|Data Flow|Control Flow|Design Notes)/i;
const RUNTIME_TASK_PLACEHOLDER_RE =
  /(?:使用方式|示例|建议|当前状态|状态发现|项目基于|技术栈|本设计要解决的问题|总体思路|为什么这样拆分|哪些部分保持不变|数据分析类任务|模块\s*\/\s*文件|状态\s*\/\s*数据流|交互\s*\/\s*UX|错误处理\s*\/\s*回退|允许修改的区域|暂不修改的区域|需要哪些测试|REQ-xxx|占位|TBD|TODO|\.\.\.)/i;

function stripMarkdownTaskLine(line: string): string {
  return String(line || "")
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "")
    .replace(/^\s*(?:[-*]|\d+[.)、:：-])\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMarkdownTableSyntaxLine(line: string): boolean {
  const text = stripMarkdownTaskLine(line);
  if (!text.startsWith("|") || !text.endsWith("|")) return false;
  return text.slice(1, -1).includes("|");
}

function isRuntimeTaskActionableText(text: string): boolean {
  const normalized = String(text || "");
  if (!normalized.trim()) return false;
  if (isMarkdownTableSyntaxLine(normalized)) return false;

  const commands = extractShellCommandsFromText(normalized);
  if (commands.length > 0) return true;

  const parsedEvidence = parsePlanTaskEvidenceLabel(normalized).evidence;
  if (parsedEvidence.some((item) =>
    item.kind === "cmd" ||
    item.kind === "deliverable" ||
    item.kind === "browser_dom" ||
    item.kind === "browser_screenshot" ||
    item.kind === "dev_server_url" ||
    item.kind === "tauri_required" ||
    item.kind === "manual_user_validation"
  )) {
    return true;
  }

  if (RUNTIME_TASK_MUTATION_RE.test(normalized)) return true;
  if (RUNTIME_TASK_VERIFICATION_RE.test(normalized)) return true;
  if (RUNTIME_TASK_READ_ONLY_RE.test(normalized) || RUNTIME_TASK_FILE_ROLE_RE.test(normalized)) return false;
  return RUNTIME_TASK_ACTION_RE.test(normalized);
}

function collectRuntimeTaskCandidateLines(content: string): string[] {
  const lines = String(content || "").split(/\r?\n/);
  const candidates: string[] = [];
  let inUsefulSection = false;
  let inExcludedSection = false;

  for (const line of lines) {
    const heading = line.match(/^\s*#{1,4}\s+(.+)$/);
    if (heading) {
      const headingText = heading[1] || "";
      inExcludedSection = RUNTIME_TASK_EXCLUDED_SECTION_RE.test(headingText);
      inUsefulSection =
        RUNTIME_TASK_SECTION_RE.test(headingText) &&
        !inExcludedSection;
      continue;
    }

    if (inExcludedSection) continue;
    if (!/^\s*(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)、:：-]\s+)/.test(line)) continue;
    if (isMarkdownTableSyntaxLine(line)) continue;
    const text = stripMarkdownTaskLine(line);
    if (text.length < 8 || text.length > 220) continue;
    if (isMarkdownTableSyntaxLine(text)) continue;
    if (RUNTIME_TASK_PLACEHOLDER_RE.test(text)) continue;
    const evidence = inferPlanTaskEvidence(text, extractShellCommandsFromText(text));
    if (/[:：]\s*$/.test(text) && (evidence.length === 0 || !RUNTIME_TASK_MUTATION_RE.test(text))) continue;
    if (!isRuntimeTaskActionableText(text)) continue;
    const hasEvidence = evidence.length > 0;
    if (!inUsefulSection && !hasEvidence && !RUNTIME_TASK_ACTION_RE.test(text)) continue;
    candidates.push(text);
  }

  return candidates;
}

function stripRuntimeExcludedSections(content: string): string {
  const lines = String(content || "").split(/\r?\n/);
  const kept: string[] = [];
  let inExcludedSection = false;
  for (const line of lines) {
    const heading = line.match(/^\s*#{1,4}\s+(.+)$/);
    if (heading) {
      inExcludedSection = RUNTIME_TASK_EXCLUDED_SECTION_RE.test(heading[1] || "");
      if (!inExcludedSection) kept.push(line);
      continue;
    }
    if (!inExcludedSection) {
      if (/^\s*(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)、:：-]\s+)/.test(line)) {
        const text = stripMarkdownTaskLine(line);
        if (isMarkdownTableSyntaxLine(text)) continue;
        if (text && !isRuntimeTaskActionableText(text)) continue;
      }
      kept.push(line);
    }
  }
  return kept.join("\n");
}

function makeRuntimeTask(text: string, language: "zh" | "en"): PlanTask | null {
  const clean = stripMarkdownTaskLine(text);
  if (!clean) return null;
  if (isMarkdownTableSyntaxLine(clean)) return null;

  const parsedEvidence = parsePlanTaskEvidenceLabel(clean);
  const taskText = parsedEvidence.text || clean;
  const commands = extractShellCommandsFromText(clean);
  const inferredEvidence = parsedEvidence.evidence.length > 0
    ? []
    : inferPlanTaskEvidence(taskText, commands);
  const evidence = dedupePlanTaskEvidence([
    ...parsedEvidence.evidence,
    ...inferredEvidence,
  ]);
  if (evidence.length === 0) return null;

  return {
    id: createPlanTaskId(taskText),
    text: taskText,
    status: "pending",
    claimedStatus: "pending",
    ...(commands.length > 0 ? { commands } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(validationCapabilityForEvidence(evidence) ? { validationCapability: validationCapabilityForEvidence(evidence) } : {}),
    evidenceStatus: initialEvidenceStatusForEvidence(evidence),
    blockedReason: planTaskEvidenceStatusForUnmatchedValidation(evidence).reason ||
      (language === "en"
        ? "Waiting for trusted execution evidence"
        : "等待真实执行证据确认完成"),
  };
}

function makeRuntimeTaskFromEvidenceText(
  text: string,
  evidence: PlanTaskEvidence,
  language: "zh" | "en",
): PlanTask {
  return {
    id: createPlanTaskId(text),
    text,
    status: "pending",
    claimedStatus: "pending",
    evidence: [evidence],
    ...(evidence.kind === "cmd" ? { commands: [evidence.value] } : {}),
    ...(validationCapabilityForEvidence([evidence]) ? { validationCapability: validationCapabilityForEvidence([evidence]) } : {}),
    evidenceStatus: initialEvidenceStatusForEvidence([evidence]),
    blockedReason: planTaskEvidenceStatusForUnmatchedValidation([evidence]).reason ||
      (language === "en"
        ? "Waiting for trusted execution evidence"
        : "等待真实执行证据确认完成"),
  };
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
  if (cells.length < 2) return null;
  if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) return null;
  return cells;
}

function extractWorkspaceFileReferencesFromText(text: string): string[] {
  const refs: string[] = [];
  for (const matched of String(text || "").matchAll(PLAN_TASK_FILE_REF_RE)) {
    const value = matched[1] || "";
    if (!isLikelyWorkspaceFileReference(value)) continue;
    if (isInternalPlanEvidenceValue(value)) continue;
    refs.push(value);
  }
  return refs;
}

function collectRuntimeTaskTableTasks(
  content: string,
  language: "zh" | "en",
): PlanTask[] {
  const tasks: PlanTask[] = [];
  const seen = new Set<string>();

  for (const line of String(content || "").split(/\r?\n/)) {
    const cells = splitMarkdownTableRow(line);
    if (!cells) continue;

    const filePath = extractWorkspaceFileReferencesFromText(cells[0] || "")[0];
    if (!filePath) continue;

    const rowText = cells.join(" ");
    if (/(?:可选|optional|if needed|必要时|如需|若需要)/i.test(rowText)) continue;

    const actionCell = (cells[1] || "").replace(/\*\*/g, "").trim();
    const detail = cells.slice(2).join(" ").replace(/\*\*/g, "").trim();
    if (!RUNTIME_TASK_MUTATION_RE.test(`${actionCell} ${detail}`)) continue;

    const evidence = makePlanTaskEvidence("file", filePath, true);
    if (!evidence) continue;

    const verb = actionCell && !/^(?:改动类型|type|kind)$/i.test(actionCell)
      ? actionCell
      : language === "en"
        ? "Modify"
        : "修改";
    const taskText = detail
      ? `${verb} ${filePath}：${detail}`
      : `${verb} ${filePath}`;
    const task = makeRuntimeTaskFromEvidenceText(taskText, evidence, language);
    const key = getPlanTaskIdentity(task);
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push(task);
  }

  return tasks;
}

export function deriveRuntimePlanTasksFromArtifacts(
  artifacts: PlanArtifact[],
  options: RuntimePlanTaskDerivationOptions = {},
): PlanTask[] {
  const language = options.language === "en" ? "en" : "zh";
  const maxTasks = Math.max(2, Math.min(20, Number(options.maxTasks) || 8));
  const sourceArtifacts = artifacts.filter((artifact) =>
    artifact.kind === "plan" || artifact.kind === "design" || artifact.kind === "bugfix" || artifact.kind === "requirements"
  );
  const combinedContent = sourceArtifacts.map((artifact) => artifact.content).join("\n\n");
  if (!combinedContent.trim()) return [];
  const runtimeRelevantContent = stripRuntimeExcludedSections(combinedContent);

  const tasks: PlanTask[] = [];
  const seen = new Set<string>();
  const pushTask = (task: PlanTask | null) => {
    if (!task) return;
    const key = getPlanTaskIdentity(task);
    if (seen.has(key)) return;
    seen.add(key);
    tasks.push(task);
  };

  for (const task of collectRuntimeTaskTableTasks(runtimeRelevantContent, language)) {
    pushTask(task);
    if (tasks.length >= maxTasks) return tasks;
  }

  for (const line of collectRuntimeTaskCandidateLines(combinedContent)) {
    pushTask(makeRuntimeTask(line, language));
    if (tasks.length >= maxTasks) return tasks;
  }

  const existingCommandEvidence = new Set(
    tasks
      .flatMap((task) => task.evidence || [])
      .filter((item) => item.kind === "cmd")
      .map((item) => normalizeCommandEvidenceValue(item.value)),
  );
  for (const command of extractShellCommandsFromText(runtimeRelevantContent).slice(0, Math.max(1, maxTasks - tasks.length))) {
    const normalizedCommand = normalizeCommandEvidenceValue(command);
    if (existingCommandEvidence.has(normalizedCommand)) continue;
    pushTask(makeRuntimeTaskFromEvidenceText(
      language === "en" ? `Run verification command \`${command}\`` : `运行验证命令 \`${command}\``,
      { kind: "cmd", value: command, inferred: true },
      language,
    ));
    if (normalizedCommand) existingCommandEvidence.add(normalizedCommand);
    if (tasks.length >= maxTasks) return tasks;
  }

  if (tasks.length === 0) {
    return [];
  }

  return tasks.slice(0, maxTasks);
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
  { pattern: /自动生成的兜底草稿|兜底设计|Auto-generated fallback draft|fallback plan|MAIN\s+将可用输出收束|condensed the usable output/i, reason: "fallback_notice" },
  { pattern: /Repeated read-only tool call skipped|Duplicate skip count|FILE_UNCHANGED_STUB|already called with identical arguments|MAIN TOOL FEEDBACK|tool call id|status=observed|hash=[a-z0-9]+|excerpt=/i, reason: "tool_log" },
  { pattern: /ContextMemoryState|ContextState|\[System:\s*Context|Latest user request:|plan_empty_response_checkpoint|上一条\s*Plan\s*回复是空的|PLAN_REPEAT_READ_LIMIT/i, reason: "control_context" },
  { pattern: /后台思考已折叠|thinking process|chain of thought|<\/thinking>|<\/analysis>|但是等等/i, reason: "reasoning_leak" },
  { pattern: /回复被截断|maximum token|max token|finish_reason.*length/i, reason: "truncation_log" },
  { pattern: /\busing\s+System\s*;|namespace\s+[A-Za-z0-9_.]+\s*\{|public\s+(?:class|enum|struct|interface)\s+[A-Za-z0-9_]+/i, reason: "raw_source_code" },
];

function hasMeaningfulPlanSections(content: string, _kind: PlanArtifactKind): boolean {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length < 120) return false;
  // Model-driven semantic structure check: Ensure the markdown document has at least one heading section (# or ## or ###) with structured prose
  return /^\s{0,3}#{1,4}\s+.+/m.test(content);
}

const PLAN_STRUCTURAL_REQUIRED_SECTIONS = new Set([
  "user_goal",
  "key_changes",
  "public_interfaces",
  "execution_steps",
  "affected_files",
  "test_plan",
  "validation",
]);

export function parseMissingPlanRequiredSections(reason?: string): string[] {
  const match = String(reason || "").match(/^missing_plan_required_sections:(.+)$/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function classifyPlanArtifactQualityResult(
  result: PlanArtifactValidationResult,
): PlanArtifactQualityResult {
  if (result.ok) {
    return {
      ...result,
      missingSections: [],
      recoveryAction: "accept",
      canAutoRepair: false,
    };
  }

  const missingSections = result.missingSections?.length
    ? result.missingSections
    : parseMissingPlanRequiredSections(result.reason);
  const reason = result.reason || "quality_gate";
  
  // Evidence gap: only when the validation reason explicitly mentions evidence problems.
  // Evidence sections are no longer part of missingRequiredSections in the unified path,
  // so we only classify as evidence gap for explicit evidence issues.
  const hasEvidenceGap = /noisy_search_evidence|weak_path_echo_evidence|import_only_evidence/.test(reason);
  const hasOnlyStructuralGaps =
    missingSections.length > 0 &&
    missingSections.every((section) => PLAN_STRUCTURAL_REQUIRED_SECTIONS.has(section));

  if (hasEvidenceGap) {
    return {
      ...result,
      missingSections,
      recoveryAction: "targeted_evidence",
      canAutoRepair: false,
    };
  }

  if (hasOnlyStructuralGaps) {
    return {
      ...result,
      missingSections,
      recoveryAction: "rewrite",
      canAutoRepair: missingSections.every((section) =>
        section === "user_goal" ||
        section === "execution_steps" ||
        section === "affected_files" ||
        section === "validation" ||
        section === "test_plan" ||
        section === "key_changes" ||
        section === "public_interfaces"
      ),
    };
  }

  if (/unsupported_(?:hypothesis|debug_log)_advice/i.test(reason)) {
    return {
      ...result,
      missingSections,
      recoveryAction: "rewrite",
      canAutoRepair: true,
    };
  }

  if (/generic_fallback_plan|insufficient_actionable_plan_signals|missing_plan_sections/i.test(reason)) {
    return {
      ...result,
      missingSections,
      recoveryAction: "auto_scaffold",
      canAutoRepair: false,
    };
  }

  return {
    ...result,
    missingSections,
    recoveryAction: "rewrite",
    canAutoRepair: false,
  };
}

function detectPlanLanguage(content: string): "zh" | "en" {
  return /[\u4e00-\u9fff]/.test(String(content || "")) ? "zh" : "en";
}

function insertPlanSectionAfterTitle(content: string, section: string): string {
  const raw = String(content || "").trim();
  const lines = raw.split(/\r?\n/);
  const firstHeadingIndex = lines.findIndex((line) => /^#{1,2}\s+\S/.test(line.trim()));
  if (firstHeadingIndex < 0) return `${section.trim()}\n\n${raw}`.trim();
  const before = lines.slice(0, firstHeadingIndex + 1).join("\n").trimEnd();
  const after = lines.slice(firstHeadingIndex + 1).join("\n").trimStart();
  return `${before}\n\n${section.trim()}${after ? `\n\n${after}` : ""}`.trim();
}

export function repairActionablePlanArtifactContent(input: {
  content: string;
  userGoal?: string;
  quality?: PlanArtifactQualityResult | PlanArtifactValidationResult;
  language?: "zh" | "en";
}): { content: string; repairedSections: string[] } {
  const quality = input.quality
    ? classifyPlanArtifactQualityResult(input.quality)
    : validateActionablePlanArtifact(input.content);
  if (quality.ok || !quality.canAutoRepair) {
    return { content: input.content, repairedSections: [] };
  }

  const missingSections = quality.missingSections || [];
  const allowed = new Set([
    "user_goal",
    "execution_steps",
    "affected_files",
    "validation",
    "test_plan",
    "key_changes",
    "public_interfaces"
  ]);
  if (!missingSections.every((section) => allowed.has(section))) {
    return { content: input.content, repairedSections: [] };
  }

  const language = input.language || detectPlanLanguage(input.content);
  const goal = String(input.userGoal || "").replace(/\s+/g, " ").trim();
  let repaired = String(input.content || "").trim();
  const repairedSections: string[] = [];

  if (missingSections.includes("key_changes")) {
    const section = language === "en"
      ? "## Key Changes\n- Implement the smallest targeted change described by the affected files and execution steps, preserving existing behavior outside that scope."
      : "## 关键改动\n- 按影响文件和执行步骤实施最小必要改动，保持范围外现有行为不变。";
    repaired = insertPlanSectionAfterTitle(repaired, section);
    repairedSections.push("key_changes");
  }

  if (missingSections.includes("validation") || missingSections.includes("test_plan")) {
    const isTestPlan = missingSections.includes("test_plan");
    const section = language === "en"
      ? (isTestPlan ? "## Test Plan\n- Run the focused tests, build, or manual checks named by the affected surface and record the result before execution is considered complete." : "## Validation Standards\n- Run the focused tests, build, or manual checks named by the affected surface and record the result before execution is considered complete.")
      : (isTestPlan ? "## 测试方案\n- 运行与受影响范围匹配的测试、构建或人工检查，并记录结果后才视为执行完成。" : "## 验证标准\n- 运行与受影响范围匹配的测试、构建或人工检查，并记录结果后才视为执行完成。");
    repaired = `${repaired}\n\n${section}`.trim();
    repairedSections.push(isTestPlan ? "test_plan" : "validation");
  }

  if (missingSections.includes("public_interfaces")) {
    const section = language === "en"
      ? "## Public APIs / Interfaces / Types\n- No public API, interface, or type change is planned; preserve existing definitions."
      : "## 公共 API / 接口 / 类型\n- 无公共 API/接口/类型变化；保持现有定义不变。";
    repaired = `${repaired}\n\n${section}`.trim();
    repairedSections.push("public_interfaces");
  }

  if (missingSections.includes("affected_files")) {
    const section = language === "en"
      ? "## Affected Files\n- No files affected yet; the plan will identify specific targets during implementation."
      : "## 影响文件\n- 暂不影响具体文件；实施过程中将识别具体目标。";
    repaired = `${repaired}\n\n${section}`.trim();
    repairedSections.push("affected_files");
  }

  if (missingSections.includes("execution_steps")) {
    const step = language === "en"
      ? "## Execution Steps\n- 1. Implement the specific change identified by the plan.\n- 2. Validate with targeted tests and verify the fix resolves the user goal."
      : "## 执行步骤\n- 1. 按计划实施具体变更。\n- 2. 用针对性测试验证，确认变更解决了用户目标。";
    repaired = `${repaired}\n\n${step}`.trim();
    repairedSections.push("execution_steps");
  }

  if (missingSections.includes("user_goal") && goal) {
    const section = language === "en"
      ? `## User Goal\n- ${goal}`
      : `## 用户目标\n- ${goal}`;
    repaired = insertPlanSectionAfterTitle(repaired, section);
    repairedSections.push("user_goal");
  }

  return { content: repaired, repairedSections };
}

function hasGoalLikePlanTitle(content: string): boolean {
  const firstHeading = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,2}\s+\S/.test(line));
  if (!firstHeading) return false;
  return (
    /(?:计划|方案|修复|排查|诊断|改造|Plan|Fix|Repair|Diagnosis|Remediation)/i.test(firstHeading) &&
    /(?:CSV|Dashboard|面板|数据|导入|显示|图表|指标|修复|排查|诊断|用户|bug|issue|problem|data|chart|metric)/i.test(firstHeading)
  );
}

export function looksLikeSubstantivePlanAssistantText(text: string): boolean {
  const raw = String(text || "").trim();
  if (raw.length < 40) return false;
  if (/^#{1,6}\s+\S/m.test(raw)) return true;
  if (/^\s*\|.+\|\s*$/m.test(raw) && /\|\s*-{2,}/.test(raw)) return true;
  return /(?:截图观察|附件观察|已读证据|证据引用|已确认事实|真实发现|未验证假设|阻塞问题|执行步骤|影响文件|验证标准|用户目标|Screenshot observations|Read evidence|Confirmed facts|Unverified hypotheses|Execution steps|Affected files|Validation)/i.test(raw);
}

export type PlanDecisionForkClassification = "none" | "blocking" | "defaultable";

export interface PlanDecisionForkAnalysis {
  hasFork: boolean;
  classification: PlanDecisionForkClassification;
  requiresUserOptions: boolean;
  options: string[];
  recommendedDefault?: string;
  reason?: string;
  userVisibleDecision?: boolean;
}

function extractPlanDecisionForkOptions(content: string): string[] {
  const options: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:方案|选项|路径)\s*([A-CＡ-Ｃ1-3一二三])\s*[：:、.)-]\s*([^\n]{4,180})/gi,
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:Option|Approach|Path|Plan)\s*([A-C1-3])\s*[：:.)-]\s*([^\n]{4,180})/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const label = String(match[1] || "").trim();
      const body = String(match[2] || "").replace(/\s+/g, " ").trim();
      const option = `${label ? `${label}: ` : ""}${body}`.trim();
      if (option && !options.some((existing) => existing.toLowerCase() === option.toLowerCase())) {
        options.push(option);
      }
    }
  }
  return options.slice(0, 4);
}

function extractPlanDecisionForkContext(content: string): string {
  const relevantLines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /(?:方案|选项|路径)\s*[A-CＡ-Ｃ1-3一二三]\s*[：:、.)-]/i.test(line) ||
      /(?:Option|Approach|Path|Plan)\s*[A-C1-3]\s*[：:.)-]/i.test(line) ||
      /(?:推荐|建议|默认|优先采用|我会采用|本计划采用|默认选择|取舍|选择|确认|决定|Recommended|Recommend|Default|Chosen path|This plan uses|trade[- ]off|choose|decision)/i.test(line)
    );
  return relevantLines.join("\n");
}

function hasInternalImplementationDecisionCue(text: string): boolean {
  return /(?:内部实现|实现细节|代码组织|命名|helper|重构方式|抽成|内联|本地函数|私有函数|refactor only|internal implementation|implementation detail|code organization|naming only|helper|inline|private helper)/i.test(text);
}

function hasUserVisibleDecisionCue(text: string): boolean {
  const normalized = String(text || "");
  const userVisibleCue =
    /(?:体验|界面|UI|UX|窗口|面板|空白|开始|默认打开|启动|菜单|按钮|可见|交互|行为|范围|功能|API|接口|数据|兼容|权限|持久化|迁移|UX|UI|window|panel|blank|start|startup|visible|button|menu|behavior|interaction|scope|feature|API|interface|data|compatibility|permission|persist|migration)/i;
  return userVisibleCue.test(normalized) && !hasInternalImplementationDecisionCue(normalized);
}

export function analyzePlanDecisionFork(content: string): PlanDecisionForkAnalysis {
  const raw = String(content || "");
  const options = extractPlanDecisionForkOptions(raw);
  if (options.length < 2) {
    return { hasFork: false, classification: "none", requiresUserOptions: false, options: [] };
  }
  const hasExplicitUserOptions = /<user_options\b[\s\S]*?<\/user_options>/i.test(raw);
  const hasDefaultSelection =
    /(?:推荐|建议|默认|优先采用|我会采用|本计划采用|默认选择|Recommended|Recommend|Default|Chosen path|This plan uses).{0,40}(?:方案|选项|路径|Option|Approach|Path)\s*[A-CＡ-Ｃ1-3一二三]/i.test(raw);
  const forkContext = extractPlanDecisionForkContext(raw);
  const hasUserVisibleDecision = hasUserVisibleDecisionCue(`${options.join("\n")}\n${forkContext}`);
  const hasBlockingCue =
    /(?:需要|需|请|等待|必须).{0,32}(?:选择|确认|决定|取舍|拍板)/i.test(raw) ||
    /(?:选择|确认|决定).{0,24}(?:方案|选项|路径|优先级|[A-CＡ-Ｃ1-3一二三])/i.test(raw) ||
    /二选一|三选一|取舍|优先级|which option|choose|decision required|trade[- ]off|needs? confirmation/i.test(raw);

  if (hasExplicitUserOptions) {
    return {
      hasFork: true,
      classification: "defaultable",
      requiresUserOptions: false,
      options,
      recommendedDefault: hasDefaultSelection ? options[0] : undefined,
      reason: "explicit_user_options",
      userVisibleDecision: hasUserVisibleDecision,
    };
  }

  if (hasUserVisibleDecision) {
    return {
      hasFork: true,
      classification: "blocking",
      requiresUserOptions: true,
      options,
      recommendedDefault: hasDefaultSelection ? options[0] : undefined,
      reason: hasDefaultSelection
        ? "user_visible_decision_with_recommendation_without_user_options"
        : "user_visible_decision_without_user_options",
      userVisibleDecision: true,
    };
  }

  if (hasDefaultSelection) {
    return {
      hasFork: true,
      classification: "defaultable",
      requiresUserOptions: false,
      options,
      recommendedDefault: options[0],
      reason: "default_selection_present",
      userVisibleDecision: false,
    };
  }

  if (hasBlockingCue) {
    return {
      hasFork: true,
      classification: "blocking",
      requiresUserOptions: true,
      options,
      reason: "blocking_decision_without_user_options",
      userVisibleDecision: hasUserVisibleDecision,
    };
  }

  return {
    hasFork: true,
    classification: "defaultable",
    requiresUserOptions: false,
    options,
    reason: "fork_without_blocking_cue",
    userVisibleDecision: false,
  };
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
    if (!hasCheckboxTasks || tasks.length === 0) {
      return { ok: false, reason: "missing_checkbox_tasks" };
    }
    const hasAnyTaskEvidence = tasks.some((task) => task.evidence && task.evidence.length > 0);
    if (!hasAnyTaskEvidence) {
      return { ok: false, reason: "missing_task_evidence" };
    }
    return { ok: true };
  }

  // Strip markdown code blocks before validating noise patterns so code snippets inside markdown don't trigger raw_source_code
  const textWithoutCodeBlocks = raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "");

  for (const entry of PLAN_ARTIFACT_NOISE_PATTERNS) {
    const textToTest = entry.reason === "raw_source_code" ? textWithoutCodeBlocks : raw;
    if (entry.pattern.test(textToTest)) {
      return { ok: false, reason: entry.reason };
    }
  }

  if (!hasMeaningfulPlanSections(raw, kind)) {
    return { ok: false, reason: "missing_plan_sections" };
  }

  return { ok: true };
}

export function hasAnyContentUnderSection(text: string, sectionRegex: RegExp): boolean {
  const lines = text.split('\n');
  let inSection = false;
  let contentChars = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      if (inSection) {
        break; // reached next section
      }
      if (sectionRegex.test(trimmed)) {
        inSection = true;
      }
    } else if (inSection && trimmed.length > 0) {
      contentChars += trimmed.length;
    }
  }
  return inSection && contentChars > 5;
}

export function validateActionablePlanArtifact(
  content: string,
): PlanArtifactQualityResult {
  const base = validatePlanArtifactContent(content, "plan");
  if (!base.ok) return classifyPlanArtifactQualityResult(base);

  const raw = String(content || "").trim();
  if (/(?:如果确实缺少关键业务选择，用\s*提问|tsx\s*约束|imageParts\s*[0-9]|turn_intake|可见计划必须对齐|创建\s*plan\.md\s*是\s*runtime|本轮处于\s*PLAN\s*模式)/i.test(raw)) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "prompt_leakage_in_plan" });
  }
  if (/(?:最相关证据|Most relevant evidence)\s*[:：]\s*(?:已搜索文本|Searched text)\s*[:：]\s*\./i.test(raw)) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "noisy_search_evidence" });
  }
  if (/(?:最相关证据|Most relevant evidence).{0,260}(?:package-lock\.json|package\.json|<title\b|index\.html:\d+:\s*<title)/is.test(raw)) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "noisy_search_evidence" });
  }
  if (/(?:最小可用闭环|smallest useful workflow|Use the inspected context as the source of truth|基于当前可用的只读证据|available read-only evidence|基于已确认的证据先收窄实现目标|实施满足用户目标的最小源码变更|Use the confirmed evidence to narrow the implementation target|Apply the smallest source changes that satisfy the user goal)/i.test(raw)) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "generic_fallback_plan" });
  }
  if (/(?:直接相关的最小改动；写入前先用证据确认具体字段、状态或接口|smallest verified change .*confirm the exact edit from evidence before writing)/i.test(raw)) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "generic_fallback_plan" });
  }
  if (/(?:围绕\s*`?[^`\n]+`?\s*执行与用户目标直接相关的最小改动|Apply the smallest user-goal-specific change around)/i.test(raw)) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "generic_fallback_plan" });
  }
  const discoveryGroundingCount = (raw.match(/(?:依据证据|Grounding evidence)\s*[:：]\s*(?:已搜索文件|已查看目录|已查看项目结构|Searched files|Listed directory|Inspected project structure)/gi) || []).length;
  if (discoveryGroundingCount >= 2) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "generic_fallback_plan" });
  }
  const weakPathEchoGroundingCount = (raw.match(/(?:依据证据|Grounding evidence)\s*[:：]\s*(?:已读取文件|Read file)\s*[:：]\s*([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)\s*[;；]\s*(?:发现|found)\s*[:：]\s*\1/gi) || []).length;
  if (weakPathEchoGroundingCount >= 2) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "weak_path_echo_evidence" });
  }
  const importOnlyEvidenceCount = (raw.match(/(?:发现|found)\s*[:：]\s*(?:L\d+\s*[:：]\s*)?\s*import\s+[^;\n]+;?/gi) || []).length;
  if (importOnlyEvidenceCount >= 1) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "import_only_evidence" });
  }
  const genericThemeTokenChangeCount = (raw.match(/(?:更新|调整|改造|优化|modify|update|adjust)[^。\n]*(?:深色模式表面|主题\s*token|theme\s*tokens?|dark\s+mode\s+surface|图表\/容器对比度|chart\/container contrast)/gi) || []).length;
  if (genericThemeTokenChangeCount >= 2) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "generic_theme_token_plan" });
  }
  const hasPlaceholderValidationPlan =
    /(?:运行受影响子系统的聚焦测试、构建检查或浏览器\/桌面验证|Run the focused test, build, or browser\/desktop validation for the touched subsystem)/i.test(raw);
  if (
    hasPlaceholderValidationPlan &&
    (importOnlyEvidenceCount >= 1 || weakPathEchoGroundingCount >= 2 || genericThemeTokenChangeCount >= 2)
  ) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "placeholder_validation_plan" });
  }
  if (/(?:^|\n)\s*(?:[-*]\s*)?(?:用户目标|User goal)\s*[:：]\s*(?:$|\n)/i.test(raw)) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "empty_user_goal" });
  }
  if (/(?:以落实已批准目标|落实已批准方案中涉及|Apply the approved plan change|for the approved goal)/i.test(raw)) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "generic_approved_goal_plan" });
  }
  if (planEvidenceSectionsContainInternalPlanArtifacts(raw)) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "internal_plan_artifact_evidence" });
  }
  const decisionFork = analyzePlanDecisionFork(raw);
  if (decisionFork.requiresUserOptions) {
    return classifyPlanArtifactQualityResult({
      ok: false,
      reason: decisionFork.reason === "user_visible_decision_with_recommendation_without_user_options" ||
        decisionFork.reason === "user_visible_decision_without_user_options"
        ? "user_visible_decision_fork_without_options"
        : "blocking_plan_decision_without_user_options",
    });
  }

  const hasTargetOrData =
    /(?:\.tsx?|\.jsx?|\.swift|\.py|\.rs|\.go|\.json|\.csv|\.tsv|\.xlsx|\.md|\/[A-Za-z0-9_.-]+|\\[A-Za-z0-9_.-]+)/i.test(raw) ||
    /(?:CSV|TSV|XLSX|字段|列|指标|数据|表格|截图|附件|column|metric|dataset|table|screenshot|attachment)/i.test(raw);
  const hasObservedEvidence = /(?:截图观察|附件观察|已确认事实|已读证据|证据引用|真实发现|Observed|Evidence|Confirmed|Findings)/i.test(raw);
  const hasExecutionOrder = /(?:执行步骤|实施步骤|修复步骤|落地步骤|关键改动|关键实现改动|Key Changes|Implementation Changes|Execution Steps|Implementation Steps|Plan of Work|\b1\.\s+)/i.test(raw);
  const hasValidation = /(?:验证标准|验证方式|验收|测试|构建|Validation|Acceptance|Test|Build|测试方案|Test Plan)/i.test(raw);
  const hasConcreteUserGoal =
    (
      /(?:用户目标|目标|User Goal|Goal)/i.test(raw) ||
      hasGoalLikePlanTitle(raw)
    ) &&
    !/(?:最小可用闭环|smallest useful workflow).{0,80}(?:默认|first version)/i.test(raw);
  const hasKeyChanges = /(?:^|\n)\s*#{1,6}\s*(?:关键改动|关键实现改动|实现改动|Key Changes|Implementation Changes)/i.test(raw);
  const hasPublicInterfacesSection =
    /(?:^|\n)\s*#{1,6}\s*(?:公共\s*API\s*\/\s*接口\s*\/\s*类型|公共\s*API|接口|类型|Public APIs?\s*\/\s*Interfaces?\s*\/\s*Types?|Public APIs?|Interfaces?|Types?)/i.test(raw);
  const hasExplicitPublicInterfaceDisposition =
    /(?:无公共\s*API|无.*(?:接口|类型)变化|不(?:新增|改变|修改).*(?:公共\s*API|接口|类型)|保持.*(?:公共\s*API|接口|类型).*不变|No public API|No interface changes?|No type changes?|No public interface changes?|Public API.*unchanged|interfaces?.*unchanged|types?.*unchanged)/i.test(raw) ||
    /(?:公共\s*API|接口|类型|Public APIs?|Interfaces?|Types?).{0,120}(?:新增|修改|变化|保持|不变|added|modified|changed|unchanged|preserved)/i.test(raw) ||
    hasAnyContentUnderSection(raw, /(?:公共\s*API\s*\/\s*接口\s*\/\s*类型|公共\s*API|接口|类型|Public APIs?\s*\/\s*Interfaces?\s*\/\s*Types?|Public APIs?|Interfaces?|Types?)/i);
  const hasTestPlan = /(?:^|\n)\s*#{1,6}\s*(?:测试方案|测试计划|测试场景|验证方案|Test Plan|Testing|Tests?)/i.test(raw);
  const hasConcreteChangeSignal =
    /(?:修改|更新|新增|修复|补齐|调整|接入|生成|实现|重构|保持|不改变|不新增|验证|运行|modify|update|add|fix|adjust|wire|generate|implement|refactor|preserve|unchanged|run|verify)/i.test(raw) &&
    hasTargetOrData;

  // Unified validation path: single check list for all plans.
  // If a plan contains a section header, check that section's content.
  // If a plan does not contain a section header, skip that check (don't reject).
  // Always-required sections (checked regardless of header presence):
  const alwaysRequiredSections = [
    [hasConcreteUserGoal, "user_goal"],
    [hasExecutionOrder, "execution_steps"],
    [hasValidation, "validation"],
  ];

  const signalCount = [
    hasTargetOrData,
    hasObservedEvidence,
    hasExecutionOrder || hasKeyChanges,
    hasValidation,
    hasConcreteUserGoal,
    hasConcreteChangeSignal,
  ].filter(Boolean).length;

  if (signalCount < 4) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "insufficient_actionable_plan_signals" });
  }

  // Unified path: always required sections + Codex Plan Contract sections (only when headers present).
  // Evidence sections (screenshot, read evidence, confirmed findings, affected files) are NOT required.
  const hasSummary = /(?:^|\n)\s*#{1,6}\s*(?:摘要|Summary)/i.test(raw);
  const hasAssumptions =
    /(?:^|\n)\s*#{1,6}\s*(?:假设与默认值|默认假设|假设|默认值|Assumptions(?:\s*\/\s*Defaults)?|Defaults)/i.test(raw);

  const codexContractSections = [
    [hasSummary, "summary"],
    [hasKeyChanges && hasConcreteChangeSignal, "key_changes"],
    [hasPublicInterfacesSection && hasExplicitPublicInterfaceDisposition, "public_interfaces"],
    [hasTestPlan && hasValidation, "test_plan"],
    [hasAssumptions, "assumptions"],
  ];

  const missingRequiredSections: string[] = [
    ...alwaysRequiredSections,
    ...codexContractSections,
  ]
    .filter(([ok]) => !ok)
    .map(([, name]) => name) as string[];
  if (missingRequiredSections.length > 0) {
    return classifyPlanArtifactQualityResult({
      ok: false,
      reason: `missing_plan_required_sections:${missingRequiredSections.join(",")}`,
      missingSections: missingRequiredSections,
    });
  }

  const unsupportedHypothesisLines: string[] = [];
  let currentPlanQualityHeading = "";
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      currentPlanQualityHeading = heading[1] || "";
      continue;
    }
    const isSpeculationAllowedSection = /(?:未验证假设|待验证假设|假设与默认值|默认假设|假设|默认值|Unverified|Hypotheses|Assumptions|Defaults|摘要|Summary|用户目标|User Goal|现象|Symptom|根因|Root Cause|背景|Background)/i
      .test(currentPlanQualityHeading);
    if (
      !isSpeculationAllowedSection &&
      /(?:假设|可能|高概率|中概率|低概率|probably|possibly|hypothesis|likely)/i.test(line) &&
      !/(?:默认假设|未验证|待验证|需验证|证据|依据|观察|已读|default assumption|unverified|needs validation|evidence|observed)/i.test(line)
    ) {
      // Only classify as a speculative code change if it mentions code targets (files, paths, or code keywords)
      const mentionsCodeTargets = /(?:\.[a-z0-9]+|\b(?:function|class|interface|type|const|let|var|import|export|useEffect|useState)\b|\/|\\)/i.test(line);
      if (mentionsCodeTargets) {
        unsupportedHypothesisLines.push(line);
      }
    }
  }
  if (unsupportedHypothesisLines.length > 0) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "unsupported_hypothesis_as_plan" });
  }

  const unsupportedDebugAdviceLines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      !/^#{1,6}\s+/.test(line) &&
      /(?:console\.log|debug\s+log|调试日志|打印日志|临时日志)/i.test(line) &&
      !/(?:证据|依据|观察|已读|已确认|Evidence|Observed|Confirmed|Read)/i.test(line)
    );
  if (unsupportedDebugAdviceLines.length > 0) {
    return classifyPlanArtifactQualityResult({ ok: false, reason: "unsupported_debug_log_advice" });
  }

  return classifyPlanArtifactQualityResult({ ok: true });
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
  const editToolNames = new Set([
    "write_file",
    "replace_in_file",
    "apply_patch",
    "script_apply_edits",
    "apply_text_edits",
    "manage_script",
    "create_script",
    "delete_script",
  ]);

  blocks.forEach((block, order) => {
    if (block.type !== "tool" || block.toolStatus !== "executed" || !block.diff) return;
    if (!editToolNames.has(String(block.toolName || ""))) return;
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
    case "plan":
      return language === "zh" ? "执行计划" : "Plan";
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
