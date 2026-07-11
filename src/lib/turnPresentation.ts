import type { ConversationTurn, ConversationTurnStatus } from "./workflowModels";
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
  const primaryAction: GoalPresentationPrimaryAction = input.lifecycle === "active" || primaryActionPending
    ? "pause"
    : input.lifecycle === "resumable" || input.lifecycle === "action_required"
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
      input.lifecycle === "action_required"
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
