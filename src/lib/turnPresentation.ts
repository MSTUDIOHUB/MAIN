import type {
  ConversationTurn,
  ConversationTurnStatus,
  PlanExecutionProgressSnapshot,
  PlanTask,
} from "./workflowModels";
import type { ActionRequestKind, ActionRequestStatus } from "./actionRequest";

export type TurnPresentationKind =
  | "ordinary"
  | "plan"
  | "goal"
  | "awaiting"
  | "paused"
  | "blocked"
  | "failed";

export type TurnPresentationLifecycle =
  | "active"
  | "action_required"
  | "resumable"
  | "success"
  | "no_action"
  | "failed";

export type TurnPresentationSource = Pick<
  ConversationTurn,
  | "id"
  | "userPrompt"
  | "title"
  | "intentSummary"
  | "mode"
  | "intent"
  | "displayIntent"
  | "status"
  | "processCollapsed"
  | "collapsed"
>;

export interface TurnPresentationIdentity {
  turnId?: string;
  runId?: string;
  requestId?: string;
}

export interface TurnPresentationModel extends TurnPresentationIdentity {
  kind: TurnPresentationKind;
  lifecycle: TurnPresentationLifecycle;
  actionKind?: ActionRequestKind;
  title: string;
  status: ConversationTurnStatus | string;
  statusLabel: string;
  intent: string;
  isPlan: boolean;
  isGoal: boolean;
  isAwaiting: boolean;
  showStateAnchor: boolean;
  processCollapsed: boolean;
  keepUserVisible: true;
  keepFinalAssistantVisible: true;
}

export interface BuildTurnPresentationModelInput extends TurnPresentationIdentity {
  turn?: TurnPresentationSource | null;
  language?: "zh" | "en";
  fallbackTitle?: string;
  statusLabel?: string;
  statusOverride?: ConversationTurnStatus | string;
  kindOverride?: TurnPresentationKind;
  lifecycleOverride?: TurnPresentationLifecycle;
  actionKind?: ActionRequestKind;
  hasActionRequest?: boolean;
  forceProcessExpanded?: boolean;
}

export function resolveTurnPresentationLifecycle(
  statusValue: unknown,
  hasActionRequest = false,
): TurnPresentationLifecycle {
  if (hasActionRequest) return "action_required";
  const status = String(statusValue || "").trim().toLowerCase();
  if (status === "awaiting_input" || status === "awaiting_approval") return "action_required";
  if (status === "paused" || status === "pausing" || status === "blocked" || status === "budget_exceeded") {
    return "resumable";
  }
  if (status === "done" || status === "completed" || status === "completed_with_changes") return "success";
  if (status === "stopped_no_action" || status === "stopped_no_output" || status === "cancelled" || status === "idle") {
    return "no_action";
  }
  if (status === "error" || status === "failed") return "failed";
  return "active";
}

export type PlanPresentationMode =
  | "review"
  | "choice"
  | "action_required"
  | "active"
  | "resumable"
  | "success"
  | "no_action"
  | "failed";

export interface PlanPresentationBehavior {
  mode: PlanPresentationMode;
  showReviewActions: boolean;
  showChoiceCheckpoint: boolean;
  showContinuePlanning: boolean;
  showResumeExecution: boolean;
}

export function canOfferPlanContinuation(input: {
  hasActivePlanContext: boolean;
  isPlanApproved: boolean;
  isAwaitingInput: boolean;
  canApproveExecution: boolean;
  materializedArtifactCount: number;
  agentStatus: string;
}): boolean {
  return input.hasActivePlanContext &&
    !input.isPlanApproved &&
    !input.isAwaitingInput &&
    !input.canApproveExecution &&
    input.materializedArtifactCount > 0 &&
    input.agentStatus !== "running" &&
    input.agentStatus !== "pending_review";
}

/**
 * Projects the shared turn lifecycle into Plan-specific UI behavior. Business
 * readiness stays an additional gate: a plan_review request alone cannot make
 * a stale or unmaterialized plan approvable.
 */
export function resolvePlanPresentationBehavior(input: {
  lifecycle: TurnPresentationLifecycle;
  actionKind?: ActionRequestKind;
  canApproveExecution?: boolean;
  canContinuePlanning?: boolean;
  canResumeExecution?: boolean;
}): PlanPresentationBehavior {
  const { lifecycle, actionKind } = input;
  const mode: PlanPresentationMode = lifecycle === "action_required"
    ? actionKind === "plan_review"
      ? "review"
      : actionKind === "user_choice"
      ? "choice"
      : "action_required"
    : lifecycle;

  return {
    mode,
    showReviewActions: mode === "review" && input.canApproveExecution === true,
    showChoiceCheckpoint: mode === "choice",
    showContinuePlanning: mode === "resumable" && input.canContinuePlanning === true,
    showResumeExecution: mode === "resumable" && input.canResumeExecution === true,
  };
}

export type GoalPresentationTone = "active" | "paused" | "completed" | "failed";
export type GoalPresentationPrimaryAction = "pause" | "resume" | null;

export interface GoalPresentationBehavior {
  tone: GoalPresentationTone;
  primaryAction: GoalPresentationPrimaryAction;
  primaryActionPending: boolean;
  canEdit: boolean;
  canResume: boolean;
}

/** Goal controls consume the same lifecycle projection as chat and Plan UI. */
export function resolveGoalPresentationBehavior(input: {
  lifecycle: TurnPresentationLifecycle;
  status?: string;
  actionKind?: ActionRequestKind;
}): GoalPresentationBehavior {
  const status = String(input.status || "").trim().toLowerCase();
  const primaryActionPending = status === "pausing";
  const tone: GoalPresentationTone = input.lifecycle === "success"
    ? "completed"
    : input.lifecycle === "failed"
    ? "failed"
    : input.lifecycle === "active"
    ? "active"
    : "paused";
  const isNonGoalConfirmationAction = input.lifecycle === "action_required" &&
    !!input.actionKind &&
    input.actionKind !== "goal_confirmation";
  const primaryAction: GoalPresentationPrimaryAction = input.lifecycle === "active" || primaryActionPending
    ? "pause"
    : isNonGoalConfirmationAction && status === "awaiting_input"
    ? "pause"
    : input.lifecycle === "resumable" || (input.lifecycle === "action_required" && !isNonGoalConfirmationAction)
    ? "resume"
    : null;
  const canResume = primaryAction === "resume";

  return {
    tone,
    primaryAction,
    primaryActionPending,
    canEdit: !primaryActionPending && (
      input.lifecycle === "active" ||
      input.lifecycle === "resumable" ||
      (input.lifecycle === "action_required" && !isNonGoalConfirmationAction)
    ),
    canResume,
  };
}

/**
 * A Plan action is presentable only while the exact owning run is paused at a
 * user boundary. Completed, failed and still-running markers cannot revive an
 * old approval or choice checkpoint.
 */
export function isPlanActionRequestPresentationEligible(input: {
  actionKind?: ActionRequestKind | null;
  requestStatus?: ActionRequestStatus | null;
  requestSessionKey?: string | null;
  requestTurnId?: string | null;
  requestRunId?: string | null;
  markerStatus?: string | null;
  markerSessionKey?: string | null;
  markerTurnId?: string | null;
  markerRunId?: string | null;
  expectedSessionKey?: string | null;
  expectedTurnId?: string | null;
}): boolean {
  if (input.actionKind !== "plan_review" && input.actionKind !== "user_choice") return false;
  if (input.requestStatus !== "pending" || input.markerStatus !== "paused") return false;
  if (!input.expectedSessionKey || !input.expectedTurnId) return false;
  return input.requestSessionKey === input.expectedSessionKey &&
    input.markerSessionKey === input.expectedSessionKey &&
    input.requestTurnId === input.expectedTurnId &&
    input.markerTurnId === input.expectedTurnId &&
    !!input.requestRunId &&
    input.requestRunId === input.markerRunId;
}

/**
 * The compact Plan-review entry is a projection of the same durable
 * `plan_review` request used by PlanPanel. It is never inferred from a turn
 * status alone: the current artifact revision/hash and paused run lease must
 * all still match.
 */
export function isPlanReviewCapsulePresentationEligible(input: {
  actionKind?: ActionRequestKind | null;
  requestStatus?: ActionRequestStatus | null;
  requestSessionKey?: string | null;
  requestTurnId?: string | null;
  requestRunId?: string | null;
  requestPlanRevision?: number | null;
  requestArtifactHash?: string | null;
  markerStatus?: string | null;
  markerSessionKey?: string | null;
  markerTurnId?: string | null;
  markerRunId?: string | null;
  expectedSessionKey?: string | null;
  expectedTurnId?: string | null;
  currentPlanRevision?: number | null;
  currentArtifactHash?: string | null;
}): boolean {
  if (input.actionKind !== "plan_review") return false;
  if (!isPlanActionRequestPresentationEligible(input)) return false;
  if (
    !Number.isFinite(Number(input.requestPlanRevision)) ||
    !Number.isFinite(Number(input.currentPlanRevision)) ||
    !input.requestArtifactHash ||
    !input.currentArtifactHash
  ) {
    return false;
  }
  return Number(input.requestPlanRevision) === Number(input.currentPlanRevision) &&
    input.requestArtifactHash === input.currentArtifactHash;
}

export type PlanExecutionCapsuleTone = "active" | "waiting" | "recovery" | "failed" | "success";

export interface PlanExecutionCapsuleProjection {
  phase: PlanExecutionProgressSnapshot["phase"];
  tone: PlanExecutionCapsuleTone;
  headline: string;
  currentTask: string;
  currentTool: string;
  recoveryReason: string;
  nextStep: string;
  repeatedTargets: string[];
  currentTaskId: string | null;
}

function compactProgressValue(value: unknown, maxLength = 180): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function normalizeProgressMatchText(value: unknown): string {
  return String(value || "")
    .replace(/(?:—|-)?\s*(?:证据|evidence)\s*[:：].*$/i, "")
    .replace(/[`*_#>\[\](){}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isPlaceholderProgressTool(value: string): boolean {
  return !value || /^(?:暂无工具调用|no tool call yet|none|n\/a)$/i.test(value);
}

function isReadOnlyPlanningPlaceholder(value: string): boolean {
  return /^(?:(?:需要|需|先|请|继续|首先|下一步)\s*)?(?:读取|查看|检查|确认|定位|分析|排查|梳理|调研|审查|理解)|^(?:(?:need(?:s)?\s+to|first|please|next)\s+)?(?:read|inspect|review|analy[sz]e|identify|investigate|check|confirm|understand)\b/i.test(value);
}

function isAuthoredExecutablePlanTask(task: PlanTask): boolean {
  const text = String(task.text || "").trim();
  const evidence = task.evidence || [];
  const mutationActionPattern = /(?:修改|更新|新增|添加|修复|补齐|调整|接入|集成|生成|输出|落地|创建|删除|替换|重构|保存|导出|实现|implement|update|modify|fix|add|wire|integrate|generate|write|create|delete|replace|refactor|save|export)/i;
  const mutationAfterReadPattern = /(?:然后|随后|之后|再|并(?:且)?).{0,120}(?:修改|更新|新增|添加|修复|补齐|调整|接入|集成|生成|输出|落地|创建|删除|替换|重构|保存|导出|实现)|(?:then|after(?:wards)?|and then).{0,120}(?:implement|update|modify|fix|add|wire|integrate|generate|write|create|delete|replace|refactor|save|export)/i;
  const hasMutationAction = mutationActionPattern.test(text) &&
    (!isReadOnlyPlanningPlaceholder(text) || mutationAfterReadPattern.test(text));
  const hasValidationAction = /(?:验证|测试|验收|构建|编译|lint|类型检查|回归|verify|validate|test|acceptance|build|compile|typecheck|type-check|regression)/i.test(text);
  const hasMutationTarget = evidence.some((item) =>
    item.kind === "deliverable" || item.kind === "file"
  );
  const hasExecutableValidation = evidence.some((item) =>
    item.kind === "cmd" ||
    item.kind === "browser_dom" ||
    item.kind === "browser_screenshot" ||
    item.kind === "dev_server_url" ||
    item.kind === "tauri_required" ||
    item.kind === "manual_user_validation"
  ) || (task.commands || []).some((command) => String(command || "").trim().length > 0);
  return (hasMutationAction && hasMutationTarget) || (hasValidationAction && hasExecutableValidation);
}

function resolvePlanExecutionCurrentTaskTextMatch(
  tasks: PlanTask[],
  snapshot: PlanExecutionProgressSnapshot,
): PlanTask | null {
  const currentTask = normalizeProgressMatchText(snapshot.currentTask);
  if (currentTask.length < 8) return null;
  return tasks.find((task) => {
    const taskText = normalizeProgressMatchText(task.text);
    return taskText.length >= 8 && currentTask === taskText;
  }) || null;
}

/**
 * Match a runtime checkpoint to the authored checklist without selecting the
 * first incomplete artifact task by default. A task is highlighted only when
 * the current checkpoint explicitly references its text or evidence target.
 */
export function resolvePlanExecutionCurrentTaskId(
  tasks: PlanTask[],
  snapshot: PlanExecutionProgressSnapshot | null | undefined,
): string | null {
  if (!snapshot || tasks.length === 0) return null;
  const currentTask = normalizeProgressMatchText(snapshot.currentTask);
  const currentTool = normalizeProgressMatchText(snapshot.currentTool);

  for (const task of tasks) {
    const taskText = normalizeProgressMatchText(task.text);
    if (
      taskText.length >= 8 &&
      currentTask.length >= 8 &&
      (currentTask.includes(taskText) || taskText.includes(currentTask))
    ) {
      return task.id;
    }
  }

  if (currentTool) {
    for (const task of tasks) {
      if ((task.evidence || []).some((item) => {
        const value = normalizeProgressMatchText(item.value);
        return value.length >= 3 && currentTool.includes(value);
      })) {
        return task.id;
      }
    }
  }
  return null;
}

/**
 * Runtime progress owns the live Capsule headline. Artifact tasks remain a
 * stable checklist and are never promoted to the headline merely because they
 * are the first item without evidence.
 */
export function buildPlanExecutionCapsuleProjection(input: {
  snapshot: PlanExecutionProgressSnapshot | null | undefined;
  tasks?: PlanTask[];
  language?: "zh" | "en";
}): PlanExecutionCapsuleProjection | null {
  const snapshot = input.snapshot;
  if (!snapshot) return null;
  const language = input.language === "en" ? "en" : "zh";
  const rawCurrentTask = compactProgressValue(snapshot.currentTask);
  const rawCurrentTool = compactProgressValue(snapshot.currentTool);
  const currentTool = isPlaceholderProgressTool(rawCurrentTool) ? "" : rawCurrentTool;
  const textMatchedAuthoredTask = resolvePlanExecutionCurrentTaskTextMatch(
    input.tasks || [],
    snapshot,
  );
  const suppressReadOnlyPlaceholder =
    isReadOnlyPlanningPlaceholder(rawCurrentTask) &&
    (!textMatchedAuthoredTask || !isAuthoredExecutablePlanTask(textMatchedAuthoredTask));
  const currentTask = suppressReadOnlyPlaceholder ? "" : rawCurrentTask;
  const recoveryReason = compactProgressValue(snapshot.recoveryReason, 160);
  const nextStep = compactProgressValue(snapshot.nextStep);
  const repeatedTargets = (snapshot.repeatedTargets || [])
    .map((target) => compactProgressValue(target, 100))
    .filter(Boolean)
    .slice(0, 4);
  const primary = currentTool || currentTask;

  let tone: PlanExecutionCapsuleTone = "active";
  let headline: string;
  switch (snapshot.phase) {
    case "tool_error":
      tone = "failed";
      headline = language === "zh"
        ? `工具执行失败${primary ? `：${primary}` : ""}`
        : `Tool execution failed${primary ? `: ${primary}` : ""}`;
      break;
    case "paused":
      tone = recoveryReason ? "recovery" : "waiting";
      headline = language === "zh"
        ? `计划执行已暂停${recoveryReason ? `：${recoveryReason}` : primary ? `：${primary}` : ""}`
        : `Plan execution paused${recoveryReason ? `: ${recoveryReason}` : primary ? `: ${primary}` : ""}`;
      break;
    case "waiting_review":
      tone = "waiting";
      headline = language === "zh"
        ? `等待工具批准${primary ? `：${primary}` : ""}`
        : `Waiting for tool approval${primary ? `: ${primary}` : ""}`;
      break;
    case "auto_resume":
    case "checkpoint":
    case "context_compression":
      tone = "recovery";
      headline = language === "zh"
        ? `正在恢复计划执行${recoveryReason ? `：${recoveryReason}` : primary ? `：${primary}` : ""}`
        : `Recovering plan execution${recoveryReason ? `: ${recoveryReason}` : primary ? `: ${primary}` : ""}`;
      break;
    case "completed":
      tone = "success";
      headline = language === "zh" ? "计划执行已完成" : "Plan execution completed";
      break;
    case "tool_start":
      headline = language === "zh"
        ? `正在执行${primary ? `：${primary}` : "工具"}`
        : `Running${primary ? `: ${primary}` : " tool"}`;
      break;
    case "tool_done":
      headline = language === "zh"
        ? `工具结果已记录${primary ? `：${primary}` : ""}`
        : `Tool result recorded${primary ? `: ${primary}` : ""}`;
      break;
    case "starting":
      headline = language === "zh" ? "正在启动计划执行" : "Starting plan execution";
      break;
    default:
      if (recoveryReason) tone = "recovery";
      headline = recoveryReason
        ? language === "zh" ? `正在恢复：${recoveryReason}` : `Recovering: ${recoveryReason}`
        : language === "zh"
        ? `正在推进${primary ? `：${primary}` : "计划任务"}`
        : `Working${primary ? `: ${primary}` : " through the plan"}`;
      break;
  }

  return {
    phase: snapshot.phase,
    tone,
    headline: compactProgressValue(headline, 220),
    currentTask,
    currentTool,
    recoveryReason,
    nextStep,
    repeatedTargets,
    currentTaskId: suppressReadOnlyPlaceholder
      ? null
      : resolvePlanExecutionCurrentTaskId(input.tasks || [], snapshot),
  };
}

const GENERIC_TURN_TITLES = new Set([
  "new task",
  "new chat",
  "new conversation",
  "新的任务",
  "新任务",
  "新聊天",
  "新会话",
]);

function compactTitle(value: unknown, maxLength: number): string {
  const normalized = String(value || "")
    .replace(/^\s*[/／](?:plan|计划|goal|目标|execute|执行|chat|讨论)\b[:：]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function resolvePresentationIntent(turn?: TurnPresentationSource | null): string {
  // Logical intent owns the presentation category. displayIntent may temporarily
  // become `execute` during approved Plan execution without making it an ordinary turn.
  return String(turn?.intent || turn?.displayIntent || turn?.mode || "respond");
}

function resolvePresentationKind(input: {
  intent: string;
  status: string;
  kindOverride?: TurnPresentationKind;
}): TurnPresentationKind {
  if (input.kindOverride) return input.kindOverride;
  if (input.status === "error") return "failed";
  if (input.status === "awaiting_input" || input.status === "awaiting_approval") return "awaiting";
  if (input.status === "paused") return "paused";
  if (input.status === "stopped_no_action" || input.status === "stopped_no_output") return "blocked";
  if (input.intent === "goal") return "goal";
  if (input.intent === "plan") return "plan";
  return "ordinary";
}

function resolvePresentationTitle(input: BuildTurnPresentationModelInput): string {
  const { turn } = input;
  const language = input.language === "en" ? "en" : "zh";
  const fallback = compactTitle(input.fallbackTitle, language === "en" ? 64 : 48) ||
    (language === "en" ? "Current turn" : "当前回合");
  const explicitTitle = compactTitle(turn?.title, language === "en" ? 64 : 48);
  const titleIsGeneric = GENERIC_TURN_TITLES.has(explicitTitle.toLowerCase());
  return (
    (!titleIsGeneric ? explicitTitle : "") ||
    compactTitle(turn?.intentSummary, language === "en" ? 64 : 48) ||
    compactTitle(turn?.userPrompt, language === "en" ? 64 : 48) ||
    fallback
  );
}

export function buildTurnPresentationModel(
  input: BuildTurnPresentationModelInput,
): TurnPresentationModel {
  const intent = resolvePresentationIntent(input.turn);
  const status = String(input.statusOverride || input.turn?.status || "done");
  const kind = resolvePresentationKind({ intent, status, kindOverride: input.kindOverride });
  const lifecycle = input.lifecycleOverride || resolveTurnPresentationLifecycle(
    status,
    input.hasActionRequest || !!input.actionKind,
  );
  const isAwaiting = kind === "awaiting";
  const isPlan = intent === "plan";
  const isGoal = intent === "goal";

  return {
    kind,
    lifecycle,
    ...(input.actionKind ? { actionKind: input.actionKind } : {}),
    title: resolvePresentationTitle(input),
    status,
    statusLabel: compactTitle(input.statusLabel, 40) || status,
    intent,
    isPlan,
    isGoal,
    isAwaiting,
    showStateAnchor: kind !== "ordinary",
    // `collapsed` remains a persisted compatibility fallback only. Both fields
    // represent process folding; user and final assistant content stay visible.
    processCollapsed:
      input.forceProcessExpanded === true || isAwaiting
        ? false
        : (input.turn?.processCollapsed ?? input.turn?.collapsed) === true,
    keepUserVisible: true,
    keepFinalAssistantVisible: true,
    ...(input.turnId || input.turn?.id ? { turnId: input.turnId || input.turn?.id } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  };
}

export function shouldRenderTurnBoundary(index: number, visibleTurnCount: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < Math.max(0, visibleTurnCount - 1);
}
