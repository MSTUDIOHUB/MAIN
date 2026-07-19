import type { TaskBlock } from "../taskTypes";
import type { AttachedFile } from "../attachments";
import type { FeishuRemoteContext } from "../remoteContextTypes";
import {
  GLOBAL_CHAT_KEY,
  resolveSessionRuntimeKey,
  resolveSessionWorkspaceKey,
} from "../sessionTypes";
import type { HarnessRunMarker } from "../harnessCrashTelemetry";
import {
  isExactUserChoiceResolutionIdentity,
  isMatchingUserChoiceResolution,
  type ActionRequest,
  type UserChoiceResolutionIdentity,
} from "../actionRequest";
import {
  normalizeTurnInputContextSignals,
  type TurnInputContextLike,
  type TurnInputContextSignals,
} from "../turnIntake";
import {
  shouldSeedSessionTitle,
  shouldRequestSemanticTurnMetadataForTurn,
  type SessionTitleSeedState,
} from "../intentTitlePolicy";
import type { PendingSlashCommand } from "../gameStudio/catalog";
import { parseGameStudioSlashCommand } from "../gameStudio/catalog";
import { detectGameDevelopmentIntent, type GameDevelopmentIntentSignal } from "../gameStudio/detection";
import type { MainModeKey } from "../mainModes";
import {
  isMainIntentShortcutAllowedInMainMode,
  isResumablePreviousTurnStatus,
  looksLikeExistingPlanExecutionRequest,
  looksLikePlanContinuationOrApprovalInput,
  looksLikePreviousTurnContinuationInput,
  parseMainDebugShortcut,
  parseMainIntentShortcutForMode,
  resolveConversationTurnIntent,
  shouldContinuePreviousTurnFromInput,
  shouldUseBlockingIntentPreflight,
  createPendingDecisionCopy,
  getIntentPolicy,
  inferCommandDirective,
  type CommandDirective,
  type IntentPreflightResult,
  type LegacyWorkflowMode,
  type MainIntentShortcut,
  type PendingRunDecision,
  type PendingRunDecisionChoice,
  type PendingRunDecisionOption,
  type ResolvedRunIntent,
  type ResolvedUserIntent,
  type RunIntentResolution,
} from "../runIntent";
import { shouldReuseLogicalTurnForSubmission } from "../runIdentity";
import {
  resolvePlanStateHydrationReason,
  type PlanStateHydrationReason,
} from "../planStateHydration";
import {
  isGenericConversationTitle,
  normalizeConversationDisplayTitle,
  resolveTurnResponseLanguage,
  summarizeUserPrompt,
  type ResponseLanguagePolicy,
} from "../workflowModels";
import type {
  ConversationTurn,
  ConversationTurnStatus,
  NormalizedStreamState,
  PendingOperationProposal,
  PlanStage,
  ReplyOption,
} from "../workflowModels";

const RUN_INTENT_LABELS: Record<ResolvedRunIntent, { zh: string; en: string }> = {
  respond: { zh: "回复", en: "Respond" },
  discuss: { zh: "回复", en: "Respond" },
  plan: { zh: "计划", en: "Plan" },
  execute: { zh: "直接执行", en: "Execute" },
  analyze: { zh: "分析", en: "Analyze" },
  summarize: { zh: "总结", en: "Summarize" },
  report: { zh: "报告", en: "Report" },
  studio_workflow: { zh: "Game Studio 工作流", en: "Game Studio Workflow" },
  image_studio: { zh: "生成图片", en: "Generate Image" },
  goal: { zh: "目标", en: "Goal" },
};

const RESOLVED_USER_INTENT_KEYS = new Set<ResolvedUserIntent>([
  "respond",
  "discuss",
  "plan",
  "execute",
  "analyze",
  "summarize",
  "report",
  "studio_workflow",
  "image_studio",
  "goal",
]);

export function isResolvedUserIntentChoice(choice: PendingRunDecisionChoice): choice is ResolvedUserIntent {
  return RESOLVED_USER_INTENT_KEYS.has(choice as ResolvedUserIntent);
}

export function buildSubmitInputEnvelope(params: {
  text: string;
  options?: SubmitInputEnvelopeOptions;
  state: SubmitInputEnvelopeState;
  cache: SubmitInputEnvelopeCache;
}): SubmitInputEnvelope {
  const { text, state } = params;
  const options = params.options || {};
  const isHidden = options.hidden === true;
  const createVisibleTurnForHiddenMessage =
    isHidden && options.createVisibleTurnForHiddenMessage === true;
  const hasTurn = (turnId: string | undefined): turnId is string =>
    !!turnId && state.conversationTurns.some((turn) => turn.id === turnId);
  const parentPlanTurnId = hasTurn(options.parentPlanTurnId)
    ? options.parentPlanTurnId
    : null;
  const requestedUiParentTurnId = options.uiParentTurnId || null;
  const uiParentTurnId = hasTurn(options.uiParentTurnId)
    ? options.uiParentTurnId
    : null;
  const mentionSnapshot = options.contextMentionsSnapshot ?? state.contextMentions;
  const attachedFilesSnapshot = options.attachedFilesSnapshot ?? state.attachedFiles;
  const remoteFeishu = options.remoteFeishu || (
    state.feishuLinkedSessionId === state.currentSessionId && state.feishuLinkedContext
      ? state.feishuLinkedContext
      : undefined
  );
  const currentMainModeKey = state.selectedMainModeKey;
  const preParsedStudioCommand = currentMainModeKey === "game_studio"
    ? parseGameStudioSlashCommand(text)
    : null;
  const preParsedStudioWorkflowArgs = preParsedStudioCommand?.type === "workflow"
    ? preParsedStudioCommand.args
    : "";
  const languageResolutionInput =
    preParsedStudioCommand?.type === "workflow"
      ? (preParsedStudioWorkflowArgs || text)
      : text;
  const systemLanguage = state.config.language === "en" ? "en" : "zh";
  const preferredLanguage = isHidden
    ? state.preferredResponseLanguage
    : resolveTurnResponseLanguage({
        text: languageResolutionInput,
        policy: state.config.responseLanguagePolicy,
        systemLanguage,
        fallbackLanguage: systemLanguage,
      });
  const cachedWorkspaceTreeForGameDetection =
    state.currentWorkspace &&
    params.cache.workspaceTreeCacheKey === state.currentWorkspace &&
    params.cache.workspaceTreeCacheVersion === state.workspaceContentVersion
      ? params.cache.workspaceTreeCache
      : "";

  return {
    isHidden,
    createVisibleTurnForHiddenMessage,
    parentPlanTurnId,
    requestedUiParentTurnId,
    uiParentTurnId,
    mentionSnapshot,
    attachedFilesSnapshot,
    remoteFeishu,
    hasSupplementalInput: mentionSnapshot.length > 0 || attachedFilesSnapshot.length > 0,
    currentMainModeKey,
    preParsedStudioCommand,
    preParsedStudioWorkflowArgs,
    languageResolutionInput,
    preferredLanguage,
    cachedWorkspaceTreeForGameDetection,
    shouldWarmWorkspaceTreeCache:
      !cachedWorkspaceTreeForGameDetection && !!state.currentWorkspace?.trim(),
  };
}

export function buildSubmitIntentConfirmationPendingDecision(params: {
  text: string;
  images?: string[];
  preferredLanguage: "zh" | "en";
  source?: PendingRunDecision["source"];
  decision: Pick<RunIntentResolution, "riskLevel" | "reason"> &
    Partial<Pick<RunIntentResolution, "suggestedIntent" | "decisionOptions">>;
  suggestedIntentFallback?: ResolvedUserIntent;
  titleOverride?: string;
  reasonOverride?: string;
  optionsOverride?: PendingRunDecisionOption[];
}): PendingRunDecision {
  const suggestedIntent =
    params.decision.suggestedIntent ?? params.suggestedIntentFallback ?? "plan";
  const pendingCopy = createPendingDecisionCopy(
    {
      suggestedIntent,
      decisionOptions: params.decision.decisionOptions,
      riskLevel: params.decision.riskLevel,
      reason: params.decision.reason,
    },
    params.preferredLanguage,
  );
  return {
    kind: "intent_confirmation",
    source: params.source ?? "pre_submit",
    originalInput: params.text,
    originalImages: params.images || [],
    suggestedIntent,
    reason: params.reasonOverride ?? pendingCopy.reason,
    title: params.titleOverride ?? pendingCopy.title,
    options: params.optionsOverride?.length ? params.optionsOverride : pendingCopy.options,
  };
}

export function normalizeIntentSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim();
}

export function buildRunIntentSummary(params: {
  input: string;
  intent: ResolvedRunIntent;
  language: "zh" | "en";
  preflightSummary?: string | null;
  reason?: string | null;
}): string {
  const fromPreflight = normalizeIntentSummary(params.preflightSummary || "");
  if (fromPreflight) return fromPreflight.length <= 72 ? fromPreflight : `${fromPreflight.slice(0, 72).trim()}...`;

  const label = RUN_INTENT_LABELS[params.intent]?.[params.language] || params.intent;
  const subject = summarizeUserPrompt(params.input, params.language === "zh" ? 34 : 42);
  if (subject && subject !== "新的任务") {
    return params.language === "zh" ? `${label}：${subject}` : `${label}: ${subject}`;
  }

  const reason = normalizeIntentSummary(params.reason || "");
  return reason || (params.language === "zh" ? `${label}：新的任务` : `${label}: New task`);
}

export function buildMainDebugPrompt(feedback: string): string {
  const trimmedFeedback = feedback.trim();
  const feedbackBlock = trimmedFeedback || "未提供反馈正文。请先向用户索取完整反馈内容，再生成 bugfix 计划。";
  return [
    "[MDEBUG: USER FEEDBACK SELF-REPAIR]",
    "以下是来自 MAIN Beta 用户反馈的修复请求。请在当前 MAIN 源码工作区中处理。",
    "",
    "工作流程：",
    "1. 先只读定位相关源码、日志入口、复现路径和可能根因。",
    "2. 基于反馈生成精简的 `.MAIN/plans/bugfix.md`，内容包含：现象、根因假设、影响范围、修复方案、验证方式。",
    "3. 输出审批 Proposal，等待用户批准。",
    "4. 批准前不要修改源码，不要生成 `.MAIN/plans/tasks.md`，不要绕过计划审批。",
    "",
    "用户反馈：",
    feedbackBlock,
  ].join("\n");
}

export interface SubmitPipelineOptions {
  hidden?: boolean;
  reuseCurrentTurn?: boolean;
  turnIdOverride?: string;
  preservePlanState?: boolean;
  resolvedIntent?: ResolvedRunIntent;
  commandDirective?: CommandDirective | null;
  intentSummary?: string;
  turnTitle?: string;
  skipIntentResolution?: boolean;
  suppressGameStudioSuggestion?: boolean;
  skipAutoPlanHydration?: boolean;
  executionConsentGranted?: boolean;
  createVisibleTurnForHiddenMessage?: boolean;
  replyOptionSourceTurnId?: string;
  selectedReplyOptionText?: string;
  replyOptionRequestIdentity?: UserChoiceResolutionIdentity;
  replyOptionIsCustom?: boolean;
  parentRunIdOverride?: string;
  /** Internal identity for replaying the exact durable queued submission. */
  queuedUserMessageId?: string;
  /**
   * Session/workspace identity captured when the user submitted the message.
   * Async continuations must still match it before they can mutate another
   * session. This is a stale-work guard, not an intent authorization.
   */
  submissionOriginSessionKey?: string;
  /** @deprecated Untrusted compatibility field. Store requires a one-shot continuation envelope. */
  continueExistingGoal?: boolean;
  /** One-shot user choice injected into the next Goal continuation contract. */
  goalContinuationGuidance?: string;
}

export interface SubmitPipelineSnapshot {
  agentStatus: string;
  currentTurnId: string | null;
  currentSessionKey?: string | null;
  conversationTurns: ConversationTurn[];
  taskFlow: TaskBlock[];
  selectedMainModeKey: MainModeKey;
  currentWorkspace?: string | null;
  contextMentions?: string[];
  attachedFilesCount?: number;
  planArtifactsCount: number;
  planTasksCount?: number;
  planStage: PlanStage;
  isPlanApproved: boolean;
  pendingRunDecision?: PendingRunDecision | null;
  lockedComposerIntent?: MainIntentShortcut | null;
}

export interface SubmitPipelineInput {
  text: string;
  images?: string[];
  options?: SubmitPipelineOptions;
  /** One-shot authorization consumed from the exact visible UI submission envelope. */
  validatedVisibleGoalCreationAuthorization?: GoalCreationAuthorization | null;
  /** Authorization restored only after matching the current queued message id. */
  validatedQueuedGoalCreationAuthorization?: GoalCreationAuthorization | null;
  snapshot: SubmitPipelineSnapshot;
  workspaceTreeForGameDetection?: string;
  preferredLanguage?: "zh" | "en";
  createGameStudioModeSwitchDecision?: (input: {
    input: string;
    images?: string[];
    language: "zh" | "en";
    signal: GameDevelopmentIntentSignal;
  }) => PendingRunDecision;
}

export interface SubmitInputEnvelopeOptions {
  hidden?: boolean;
  createVisibleTurnForHiddenMessage?: boolean;
  parentPlanTurnId?: string;
  uiParentTurnId?: string;
  contextMentionsSnapshot?: string[];
  attachedFilesSnapshot?: Array<AttachedFile | string>;
  remoteFeishu?: FeishuRemoteContext;
}

export interface SubmitInputEnvelopeState {
  selectedMainModeKey: MainModeKey;
  conversationTurns: Array<Pick<ConversationTurn, "id">>;
  contextMentions: string[];
  attachedFiles: Array<AttachedFile | string>;
  currentWorkspace?: string | null;
  currentSessionId?: number | null;
  feishuLinkedSessionId?: number | null;
  feishuLinkedContext?: FeishuRemoteContext | null;
  preferredResponseLanguage: "zh" | "en";
  workspaceContentVersion: number;
  config: {
    language: string;
    responseLanguagePolicy: ResponseLanguagePolicy;
  };
}

export interface SubmitInputEnvelopeCache {
  workspaceTreeCacheKey: string;
  workspaceTreeCacheVersion: number;
  workspaceTreeCache: string;
}

export interface SubmitInputEnvelope {
  isHidden: boolean;
  createVisibleTurnForHiddenMessage: boolean;
  parentPlanTurnId: string | null;
  requestedUiParentTurnId: string | null;
  uiParentTurnId: string | null;
  mentionSnapshot: string[];
  attachedFilesSnapshot: Array<AttachedFile | string>;
  remoteFeishu?: FeishuRemoteContext;
  hasSupplementalInput: boolean;
  currentMainModeKey: MainModeKey;
  preParsedStudioCommand: PendingSlashCommand | null;
  preParsedStudioWorkflowArgs: string;
  languageResolutionInput: string;
  preferredLanguage: "zh" | "en";
  cachedWorkspaceTreeForGameDetection: string;
  shouldWarmWorkspaceTreeCache: boolean;
}

export interface SubmitPendingReviewDecision {
  selectedReplyOption: ReplyOption | null;
  isApprovalBypass: boolean;
  shouldAbortAndStartNewTurn: boolean;
}

export interface SubmitTurnReuseDecision {
  currentTurn: ConversationTurn | null;
  currentTurnReplyOptionBlocks: Array<Extract<TaskBlock, { type: "agent" }>>;
  currentTurnHasReplyOptions: boolean;
  currentTurnIntent: ResolvedRunIntent;
  hasPlanArtifacts: boolean;
  hasApprovedOrExecutingPlanState: boolean;
  planExecutionResumeContinuationTarget: ConversationTurn | null;
  shouldRouteContinuationToPlanResume: boolean;
  shouldContinuePlanIntent: boolean;
  shouldAllowPreviousTurnContinuation: boolean;
  previousTurnContinuationTarget: ConversationTurn | null;
  shouldContinuePreviousTurnIntent: boolean;
  previousTurnContinuationIntent: ResolvedRunIntent | null;
  selectedAwaitingReplyOption: ReplyOption | null;
  shouldAutoResumeChoiceTurn: boolean;
  shouldExplicitlyReuseCurrentTurn: boolean;
  reusableTurnId: string | null;
  reuseCurrentTurn: boolean;
  isInternalTurn: boolean;
  shouldReuseExistingTurnIntent: boolean;
  shouldExecuteOnceFromReplyOption: boolean;
  operationProposalChoiceAction?: ReplyOption["action"];
  preservePlanState: boolean;
}

export interface SubmitPlanHydrationDecision {
  shouldAttempt: boolean;
  reason: PlanStateHydrationReason | null;
}

export interface SubmitShortcutDecision {
  mainDebugShortcut: ReturnType<typeof parseMainDebugShortcut> | null;
  mainIntentShortcut: ReturnType<typeof parseMainIntentShortcutForMode> | null;
  lockedComposerIntent: MainIntentShortcut | null;
  /** One-shot authority minted only from this visible submission's explicit Goal UI. */
  goalCreationAuthorization: GoalCreationAuthorization | null;
  textAfterIntentShortcut: string;
}

export interface GoalCreationAuthorization {
  kind: "goal_creation_authorization";
  intent: "goal";
  source: "visible_goal_shortcut" | "visible_goal_composer_capsule";
}

export interface VisibleGoalSubmissionEnvelope {
  kind: "visible_goal_submission_envelope";
  id: string;
}

export interface GoalContinuationAuthorization {
  kind: "goal_continuation_authorization";
  source: "goal_user_choice" | "goal_manual_resume" | "goal_e2e_resume";
  workspaceKey: string;
  sessionKey: string;
  goalId: string;
  goalRevision: number;
  ownerTurnId: string;
  requestId?: string;
}

export interface GoalContinuationEnvelope {
  kind: "goal_continuation_envelope";
  id: string;
}

export function createGoalCreationAuthorization(
  source: GoalCreationAuthorization["source"],
): GoalCreationAuthorization {
  return {
    kind: "goal_creation_authorization",
    intent: "goal",
    source,
  };
}

export function createGoalContinuationAuthorization(input: Omit<
  GoalContinuationAuthorization,
  "kind"
>): GoalContinuationAuthorization {
  return {
    kind: "goal_continuation_authorization",
    ...input,
    goalRevision: Math.max(1, Math.floor(Number(input.goalRevision) || 1)),
    ...(String(input.requestId || "").trim()
      ? { requestId: String(input.requestId).trim() }
      : {}),
  };
}

export function resolveVisibleGoalSubmissionSessionKey(input: {
  currentWorkspace?: string | null;
  currentSessionId?: number | null;
}): string {
  const workspaceKey = resolveSessionWorkspaceKey(input.currentWorkspace);
  return resolveSessionRuntimeKey(workspaceKey, input.currentSessionId) ||
    `workspace-only:${workspaceKey}`;
}

export function isGoalCreationAuthorization(value: unknown): value is GoalCreationAuthorization {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GoalCreationAuthorization>;
  return candidate.kind === "goal_creation_authorization" &&
    candidate.intent === "goal" &&
    (
      candidate.source === "visible_goal_shortcut" ||
      candidate.source === "visible_goal_composer_capsule"
    );
}

export function isGoalContinuationAuthorization(
  value: unknown,
): value is GoalContinuationAuthorization {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GoalContinuationAuthorization>;
  const sourceValid = candidate.source === "goal_user_choice" ||
    candidate.source === "goal_manual_resume" ||
    candidate.source === "goal_e2e_resume";
  const requestId = String(candidate.requestId || "").trim();
  return candidate.kind === "goal_continuation_authorization" &&
    sourceValid &&
    !!String(candidate.workspaceKey || "").trim() &&
    !!String(candidate.sessionKey || "").trim() &&
    !!String(candidate.goalId || "").trim() &&
    Number.isFinite(Number(candidate.goalRevision)) &&
    Number(candidate.goalRevision) >= 1 &&
    !!String(candidate.ownerTurnId || "").trim() &&
    (candidate.source === "goal_user_choice" ? !!requestId : !requestId);
}

export function validateGoalContinuationAuthorization(input: {
  authorization?: unknown;
  currentWorkspace?: string | null;
  currentSessionId?: number | null;
  activeGoal?: {
    id: string;
    revision?: number;
    sessionKey?: string;
    ownerTurnId?: string;
    status?: string;
  } | null;
  activeActionRequest?: ActionRequest | null;
}): GoalContinuationAuthorization | null {
  if (!isGoalContinuationAuthorization(input.authorization) || !input.activeGoal) {
    return null;
  }
  const authorization = input.authorization;
  const workspaceKey = resolveSessionWorkspaceKey(input.currentWorkspace);
  const sessionKey = resolveVisibleGoalSubmissionSessionKey(input);
  const goal = input.activeGoal;
  const goalSessionKey = String(goal.sessionKey || "").trim();
  const continuationStatusMatches = authorization.source === "goal_user_choice"
    ? goal.status === "awaiting_input" || goal.status === "paused"
    : goal.status === "active";
  if (
    !continuationStatusMatches ||
    authorization.workspaceKey !== workspaceKey ||
    authorization.sessionKey !== sessionKey ||
    authorization.goalId !== goal.id ||
    authorization.goalRevision !== Math.max(1, Number(goal.revision) || 1) ||
    authorization.ownerTurnId !== String(goal.ownerTurnId || "").trim() ||
    (
      goalSessionKey &&
      goalSessionKey !== sessionKey &&
      goalSessionKey !== workspaceKey
    )
  ) {
    return null;
  }

  if (authorization.source !== "goal_user_choice") return authorization;
  const request = input.activeActionRequest;
  return request?.kind === "user_choice" &&
    request.status === "pending" &&
    request.requestId === authorization.requestId &&
    request.sessionKey === authorization.sessionKey &&
    request.turnId === authorization.ownerTurnId
      ? authorization
      : null;
}

/**
 * Resolve Goal authority from the explicit controls visible at submit time.
 * A locked capsule wins over slash text just as it does in the submit pipeline;
 * hidden/internal submissions can never mint this authority.
 */
export function resolveVisibleGoalCreationAuthorization(input: {
  text: string;
  isHidden?: boolean;
  currentMainModeKey: MainModeKey;
  lockedComposerIntent?: MainIntentShortcut | null;
}): GoalCreationAuthorization | null {
  if (input.isHidden) return null;
  const mainDebugShortcut = input.currentMainModeKey === "main_mode"
    ? parseMainDebugShortcut(input.text)
    : null;
  if (mainDebugShortcut) return null;

  const modeScopedLockedComposerIntent =
    input.lockedComposerIntent &&
    isMainIntentShortcutAllowedInMainMode(
      input.lockedComposerIntent,
      input.currentMainModeKey,
    )
      ? input.lockedComposerIntent
      : null;
  if (modeScopedLockedComposerIntent) {
    return modeScopedLockedComposerIntent === "goal"
      ? createGoalCreationAuthorization("visible_goal_composer_capsule")
      : null;
  }

  const mainIntentShortcut = parseMainIntentShortcutForMode(
    input.text,
    input.currentMainModeKey,
  );
  return mainIntentShortcut?.intent === "goal"
    ? createGoalCreationAuthorization("visible_goal_shortcut")
    : null;
}

export interface VisibleGoalSubmissionAuthorizationBroker {
  capture(input: {
    text: string;
    sessionKey: string;
    currentMainModeKey: MainModeKey;
    lockedComposerIntent?: MainIntentShortcut | null;
  }): VisibleGoalSubmissionEnvelope | null;
  carryValidated(input: {
    text: string;
    sessionKey: string;
    authorization: GoalCreationAuthorization;
  }): VisibleGoalSubmissionEnvelope;
  consume(input: {
    envelope?: VisibleGoalSubmissionEnvelope | null;
    text: string;
    sessionKey: string;
    isHidden?: boolean;
  }): GoalCreationAuthorization | null;
}

/**
 * Keeps the visible Goal decision alive across UI cleanup / next-paint
 * scheduling without making the authorization replayable. The opaque envelope
 * is bound to the exact text and session and is deleted on the first consume
 * attempt, including mismatches.
 */
export function createVisibleGoalSubmissionAuthorizationBroker(options?: {
  now?: () => number;
  createId?: () => string;
  ttlMs?: number;
}): VisibleGoalSubmissionAuthorizationBroker {
  const now = options?.now || (() => Date.now());
  const createId = options?.createId || (() =>
    `visible-goal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const ttlMs = Math.max(1, options?.ttlMs ?? 30_000);
  const pending = new Map<string, {
    text: string;
    sessionKey: string;
    authorization: GoalCreationAuthorization;
    expiresAt: number;
  }>();

  const pruneExpired = (at: number) => {
    for (const [id, entry] of pending) {
      if (entry.expiresAt <= at) pending.delete(id);
    }
  };

  const storeAuthorization = (input: {
    text: string;
    sessionKey: string;
    authorization: GoalCreationAuthorization;
    capturedAt: number;
  }): VisibleGoalSubmissionEnvelope => {
    const id = createId();
    pending.set(id, {
      text: input.text,
      sessionKey: input.sessionKey,
      authorization: input.authorization,
      expiresAt: input.capturedAt + ttlMs,
    });
    return { kind: "visible_goal_submission_envelope", id };
  };

  return {
    capture(input) {
      const capturedAt = now();
      pruneExpired(capturedAt);
      const authorization = resolveVisibleGoalCreationAuthorization({
        text: input.text,
        currentMainModeKey: input.currentMainModeKey,
        lockedComposerIntent: input.lockedComposerIntent,
      });
      if (!authorization) return null;
      return storeAuthorization({
        text: input.text,
        sessionKey: input.sessionKey,
        authorization,
        capturedAt,
      });
    },
    carryValidated(input) {
      const capturedAt = now();
      pruneExpired(capturedAt);
      if (!isGoalCreationAuthorization(input.authorization)) {
        throw new Error("Invalid Goal creation authorization carry");
      }
      return storeAuthorization({
        ...input,
        capturedAt,
      });
    },
    consume(input) {
      const consumedAt = now();
      pruneExpired(consumedAt);
      const envelope = input.envelope;
      if (
        !envelope ||
        envelope.kind !== "visible_goal_submission_envelope" ||
        !String(envelope.id || "").trim()
      ) {
        return null;
      }

      const entry = pending.get(envelope.id);
      pending.delete(envelope.id);
      if (
        !entry ||
        input.isHidden ||
        entry.text !== input.text ||
        entry.sessionKey !== input.sessionKey
      ) {
        return null;
      }
      return entry.authorization;
    },
  };
}

export interface GoalContinuationAuthorizationBroker {
  issueValidated(input: {
    text: string;
    authorization: GoalContinuationAuthorization;
  }): GoalContinuationEnvelope;
  consume(input: {
    envelope?: GoalContinuationEnvelope | null;
    text: string;
  }): GoalContinuationAuthorization | null;
}

export function createGoalContinuationAuthorizationBroker(options?: {
  now?: () => number;
  createId?: () => string;
  ttlMs?: number;
}): GoalContinuationAuthorizationBroker {
  const now = options?.now || (() => Date.now());
  const createId = options?.createId || (() =>
    `goal-continuation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const ttlMs = Math.max(1, options?.ttlMs ?? 5 * 60_000);
  const pending = new Map<string, {
    text: string;
    authorization: GoalContinuationAuthorization;
    expiresAt: number;
  }>();
  const pruneExpired = (at: number) => {
    for (const [id, entry] of pending) {
      if (entry.expiresAt <= at) pending.delete(id);
    }
  };

  return {
    issueValidated(input) {
      if (!isGoalContinuationAuthorization(input.authorization)) {
        throw new Error("Invalid Goal continuation authorization");
      }
      const issuedAt = now();
      pruneExpired(issuedAt);
      const id = createId();
      pending.set(id, {
        text: input.text,
        authorization: input.authorization,
        expiresAt: issuedAt + ttlMs,
      });
      return { kind: "goal_continuation_envelope", id };
    },
    consume(input) {
      const consumedAt = now();
      pruneExpired(consumedAt);
      const envelope = input.envelope;
      if (
        !envelope ||
        envelope.kind !== "goal_continuation_envelope" ||
        !String(envelope.id || "").trim()
      ) {
        return null;
      }
      const entry = pending.get(envelope.id);
      pending.delete(envelope.id);
      return entry && entry.text === input.text ? entry.authorization : null;
    },
  };
}

export function resolveQueuedGoalCreationAuthorization(input: {
  queuedMessageId?: string | null;
  replayMessageId?: string | null;
  queuedText?: string | null;
  replayText?: string | null;
  queuedSessionKey?: string | null;
  replaySessionKey?: string | null;
  authorization?: unknown;
}): GoalCreationAuthorization | null {
  if (!isExactQueuedMessageReplay(input)) return null;
  return isGoalCreationAuthorization(input.authorization) ? input.authorization : null;
}

export function resolveQueuedGoalContinuationAuthorization(input: {
  queuedMessageId?: string | null;
  replayMessageId?: string | null;
  queuedText?: string | null;
  replayText?: string | null;
  queuedSessionKey?: string | null;
  replaySessionKey?: string | null;
  authorization?: unknown;
}): GoalContinuationAuthorization | null {
  if (!isExactQueuedMessageReplay(input)) return null;
  return isGoalContinuationAuthorization(input.authorization)
    ? input.authorization
    : null;
}

export function isExactQueuedMessageReplay(input: {
  queuedMessageId?: string | null;
  replayMessageId?: string | null;
  queuedText?: string | null;
  replayText?: string | null;
  queuedSessionKey?: string | null;
  replaySessionKey?: string | null;
}): boolean {
  const queuedMessageId = String(input.queuedMessageId || "").trim();
  const replayMessageId = String(input.replayMessageId || "").trim();
  const queuedSessionKey = String(input.queuedSessionKey || "").trim();
  const replaySessionKey = String(input.replaySessionKey || "").trim();
  return !(
    !queuedMessageId ||
    queuedMessageId !== replayMessageId ||
    !queuedSessionKey ||
    queuedSessionKey !== replaySessionKey ||
    String(input.queuedText ?? "") !== String(input.replayText ?? "")
  );
}

export interface SubmitGameStudioModeSwitchDecision {
  shouldConsider: boolean;
  signal: GameDevelopmentIntentSignal | null;
  pendingRunDecision: PendingRunDecision | null;
}

export type SubmitPipelineRouteKind =
  | "plan_hydration"
  | "mode_switch_decision"
  | "agent_loop";

export interface SubmitPipelineEffects {
  abortPendingReview?: SubmitPendingReviewDecision;
  setPendingDecision?: PendingRunDecision;
  startAutoPlanHydration?: PlanStateHydrationReason;
  launchAgentLoop?: boolean;
}

export interface SubmitPipelineDecision {
  routeKind: SubmitPipelineRouteKind;
  text: string;
  originalText: string;
  isHidden: boolean;
  hasSupplementalInput: boolean;
  parsedStudioCommand: PendingSlashCommand | null;
  turnReuse: SubmitTurnReuseDecision;
  pendingReview: SubmitPendingReviewDecision;
  planHydration: SubmitPlanHydrationDecision;
  shortcuts: SubmitShortcutDecision;
  gameStudioModeSwitch: SubmitGameStudioModeSwitchDecision;
  effects: SubmitPipelineEffects;
}

export interface SubmitEffectiveIntentInput {
  text: string;
  preferredLanguage: "zh" | "en";
  options?: SubmitPipelineOptions;
  currentMainModeKey: MainModeKey;
  parsedStudioCommand: PendingSlashCommand | null;
  isHidden: boolean;
  autoApproveTools: boolean;
  fallbackRunIntent: ResolvedRunIntent;
  mainDebugShortcut: ReturnType<typeof parseMainDebugShortcut> | null;
  mainIntentShortcut: ReturnType<typeof parseMainIntentShortcutForMode> | null;
  lockedComposerIntent: MainIntentShortcut | null;
  goalCreationAuthorization?: GoalCreationAuthorization | null;
  goalContinuationAuthorization?: GoalContinuationAuthorization | null;
  currentTurn: Pick<ConversationTurn, "userPrompt"> | null;
  currentTurnIntent: ResolvedRunIntent;
  shouldContinuePlanIntent: boolean;
  shouldContinuePreviousTurnIntent: boolean;
  previousTurnContinuationTarget: Pick<ConversationTurn, "userPrompt"> | null;
  previousTurnContinuationIntent: ResolvedRunIntent | null;
  shouldReuseExistingTurnIntent: boolean;
  shouldExecuteOnceFromReplyOption: boolean;
  unitySetupEngineSelected?: boolean;
}

export interface SubmitEffectiveIntentDecision {
  effectiveRunIntent: ResolvedRunIntent;
  effectiveIntentSummary: string;
  effectiveCommandDirective: CommandDirective | null;
  shouldForceExecuteForAutoApprove: boolean;
}

export type SubmitPreflightResultDecisionKind =
  | "ask_user_choice"
  | "ask_execution_confirmation"
  | "resume_with_preflight";

export interface SubmitPreflightResultDecision {
  kind: SubmitPreflightResultDecisionKind;
  pendingRunDecision: PendingRunDecision | null;
  resolvedIntent: ResolvedRunIntent;
  commandDirective: CommandDirective;
  turnTitle?: string;
  intentSummary: string;
  preflightSuggestsOperation: boolean;
}

export interface SubmitPreflightStalenessDecision {
  stale: boolean;
  latestInput: string;
  latestChars: number;
  selectedMainModeKey: MainModeKey;
  hasLockedComposerIntent: boolean;
  hasExplicitShortcut: boolean;
}

export interface SubmitPreflightResumeOptions extends SubmitPipelineOptions {
  skipIntentResolution: true;
  resolvedIntent: ResolvedRunIntent;
  commandDirective: CommandDirective;
  turnTitle?: string;
  intentSummary: string;
}

export interface SubmitBlockingPreflightEffect<
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
> {
  request: {
    input: string;
    language: "zh" | "en";
    mainModeKey: MainModeKey;
    config: TConfig;
  };
  originalText: string;
  originalImages?: string[];
  originalOptions?: TOptions;
  originalMainModeKey: MainModeKey;
  preferredLanguage: "zh" | "en";
  resolution: RunIntentResolution;
  sendOriginSessionKey: string | null;
}

export type SubmitPreflightEffectAction<
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
> =
  | {
      kind: "stale_discard";
      log: {
        originalChars: number;
        latestChars: number;
        selectedMainModeKey: MainModeKey;
        hasLockedComposerIntent: boolean;
        hasExplicitShortcut: boolean;
      };
    }
  | {
      kind: "set_pending_decision";
      pendingRunDecision: PendingRunDecision;
    }
  | {
      kind: "skip_inactive_session";
      phase: "intent_preflight";
      sessionKey: string;
    }
  | {
      kind: "resume";
      text: string;
      images?: string[];
      options: TOptions & SubmitPreflightResumeOptions;
    };

export interface SubmitExecutionApprovalDecision {
  locallyRequiresExecutionApproval: boolean;
  pendingRunDecision: PendingRunDecision | null;
}

export interface SubmitRuntimeDecision {
  effectiveWorkflowMode: LegacyWorkflowMode;
  runtimeRunIntent: ResolvedRunIntent;
  effectiveDisplayIntent: ResolvedRunIntent;
  shouldGrantExecutionConsentForTurn: boolean;
  initialTurnStatus: ConversationTurnStatus;
  shouldResetPlanState: boolean;
}

export interface SubmitRunStatePatchInput<TConfig extends object> {
  turnId: string;
  isHidden: boolean;
  currentInput: string;
  preferredLanguage: "zh" | "en";
  shouldArchiveChoiceFeedback: boolean;
  currentNormalizedStreamState: NormalizedStreamState;
  parsedStudioCommand: PendingSlashCommand | null;
  effectiveWorkflowMode: LegacyWorkflowMode;
  preservePlanState: boolean;
  shouldGrantExecutionConsentForTurn: boolean;
  currentConfig: TConfig;
}

export type SubmitRunStatePatch<TConfig extends object> = {
  currentTurnId: string;
  input: string;
  preferredResponseLanguage: "zh" | "en";
  pendingSlashCommand: PendingSlashCommand | null;
  lockedComposerIntent: null;
  pendingRunDecision: null;
  activeActionRequest: null;
  isGenerating: true;
  config: TConfig & { workflowMode: LegacyWorkflowMode };
  elapsedTime: 0;
  normalizedStreamState?: NormalizedStreamState;
  isPlanApproved?: false;
  planApprovalChoice?: null;
  pendingPlanApprovalHandoff?: null;
  planApprovalExecutionStartedForTurnId?: string | null;
  clearedPlanTurnId?: null;
  planAutoResumeCount?: 0;
  planExecutionProgressSnapshot?: null;
  currentTurnExecutionConsent?: { turnId: string; granted: true };
};

export interface SubmitHarnessRunMarkerDraftInput {
  runId: string;
  instanceId: string;
  runSessionKey: string;
  runWorkspace?: string | null;
  runSessionId?: number | null;
  turnId: string;
  effectiveRunIntent: ResolvedRunIntent;
  runtimeRunIntent: ResolvedRunIntent;
  planStage: PlanStage;
  isPlanApproved: boolean;
  messagesLen: number;
  startedAtMs: number;
}

export type SubmitSendGateQueueReason =
  | "generation_in_progress"
  | "agent_running_or_pending_review";

export type SubmitSendGateAllowedBusyReason =
  | "generation_in_progress"
  | "agent_running";

export type SubmitSendGateAction =
  | { kind: "continue" }
  | { kind: "block_empty"; reason: "empty_text_no_images_no_context" }
  | { kind: "queue"; reason: SubmitSendGateQueueReason; agentStatus?: string }
  | { kind: "approve_pending_review" }
  | {
      kind: "reset_stuck_state";
      previousStatus: string;
      turnStatus?: ConversationTurnStatus;
    };

export interface SubmitSendGateDecision {
  allowHiddenExecutionWhileBusy: boolean;
  allowedBusyReasons: SubmitSendGateAllowedBusyReason[];
  action: SubmitSendGateAction;
}

export interface SubmitSessionBootstrapSession {
  id: number;
  title: string;
  titleSource: "default";
  date: string;
  updatedAt: string;
  updatedAtMs: number;
  active: true;
  storageStatus: "temporary";
  recordingDisabled: boolean;
  messages: [];
}

export interface SubmitSessionBootstrapDecision {
  sessionScopeKey: string;
  ensuredSessionId: number;
  hasValidCurrentSession: boolean;
  autoSession: SubmitSessionBootstrapSession | null;
  runWorkspace: string;
  runScopeKey: string;
  runSessionId: number;
  runSessionKey: string;
  commandIssuedAtMs: number;
  commandIssuedAtIso: string;
}

export interface SubmitSessionBootstrapPatchInput<
  TSession extends { id: number; active?: boolean },
  TAutoApproveScope,
  TWebSearchProvider,
> {
  decision: SubmitSessionBootstrapDecision;
  sessionsByWorkspace: Record<string, TSession[]>;
  activeSessionByWorkspace: Record<string, number | null>;
  autoApproveTools: boolean;
  autoApproveToolScopes: TAutoApproveScope[];
  webSearchEnabled: boolean;
  webSearchProvider: TWebSearchProvider;
}

export type SubmitSessionBootstrapPatch<
  TSession extends { id: number; active?: boolean },
  TAutoApproveScope,
  TWebSearchProvider,
> = {
  sessionsByWorkspace: Record<string, Array<TSession | SubmitSessionBootstrapSession>>;
  currentSessionId: number;
  activeSessionByWorkspace: Record<string, number | null>;
  autoApproveTools: boolean;
  autoApproveToolScopes: TAutoApproveScope[];
  webSearchEnabled: boolean;
  webSearchProvider: TWebSearchProvider;
  approvedLocalFileReadPaths: [];
  approvedShellPermissionRules: [];
  readOnlyAutoApproveForSession: false;
};

export interface SubmitTurnTitleDecision {
  turnInputContextSignals: TurnInputContextSignals;
  existingTitle: string;
  optionTitle: string;
  localTurnTitle: string;
  turnTitle: string;
  titleIntentSignature: string;
  shouldSeedSessionTitleForTurn: boolean;
  seededSessionTitleCandidate: string;
}

export interface SubmitSemanticMetadataDecision<TConfig extends object> {
  expectedTurnId: string;
  expectedTurnPrompt: string;
  expectedSessionId: number | null;
  sessionScopeKey: string;
  titleIntentSignature: string;
  seededSessionTitleCandidate: string;
  request: {
    input: string;
    intent: ResolvedRunIntent;
    language: "zh" | "en";
    config: TConfig;
    contextSignals: TurnInputContextSignals;
  };
}

export interface SubmitVisibleTurnPatchInput {
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  text: string;
  turnId: string;
  userBlockId: number | null;
  userContextItems?: Extract<TaskBlock, { type: "user" }>["contextItems"];
  images?: string[];
  isHidden: boolean;
  reuseCurrentTurn: boolean;
  uiParentTurnId?: string;
  parentPlanTurnId?: string;
  parentPlanTurnDoneSummary: string;
  isInternalTurn: boolean;
  shouldExplicitlyReuseCurrentTurn: boolean;
  shouldAutoResumeChoiceTurn: boolean;
  currentTurnHasReplyOptions: boolean;
  explicitReplyOptionSourceTurnId?: string;
  selectedReplyOptionText?: string;
  effectiveRunIntent: ResolvedRunIntent;
  effectiveDisplayIntent: ResolvedRunIntent;
  effectiveIntentSummary: string;
  effectiveCommandDirective: CommandDirective | null;
  effectiveWorkflowMode: LegacyWorkflowMode;
  initialTurnStatus: ConversationTurnStatus;
  operationProposalChoiceAction?: ReplyOption["action"];
  turnTitle: string;
  createdAtMs: number;
}

export interface SubmitLocalStudioTurnPatchInput {
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  text: string;
  systemContent: string;
  turnId: string;
  userBlockId: number | null;
  systemBlockId: number;
  userContextItems?: Extract<TaskBlock, { type: "user" }>["contextItems"];
  isHidden: boolean;
  reuseCurrentTurn: boolean;
  parentPlanTurnId?: string;
  parentPlanTurnDoneSummary: string;
  effectiveRunIntent: ResolvedRunIntent;
  effectiveDisplayIntent: ResolvedRunIntent;
  effectiveIntentSummary: string;
  effectiveCommandDirective: CommandDirective | null;
  effectiveWorkflowMode: LegacyWorkflowMode;
  turnTitle: string;
  systemVariant?: Extract<TaskBlock, { type: "system" }>["variant"];
  createdAtMs: number;
}

export interface SubmitVisibleTurnPatch {
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  userBlock: Extract<TaskBlock, { type: "user" }> | null;
  replyOptionArchiveTurnId?: string;
  shouldArchiveChoiceFeedback: boolean;
  selectedChoiceText: string;
  archiveSummary: {
    optionBlocks: number;
    archivedOptionBlocks: number;
    selectedFallbackBlocks: number;
    matchMode: "turn" | "selected_fallback" | "none";
  };
}

export interface SubmitLocalStudioTurnPatch {
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  userBlock: Extract<TaskBlock, { type: "user" }> | null;
  systemBlock: Extract<TaskBlock, { type: "system" }>;
}

export function resolveSubmitEffectiveIntentDecision(
  input: SubmitEffectiveIntentInput,
): SubmitEffectiveIntentDecision {
  const {
    text,
    preferredLanguage,
    options,
    currentMainModeKey,
    parsedStudioCommand,
    isHidden,
    autoApproveTools,
    fallbackRunIntent,
    mainDebugShortcut,
    mainIntentShortcut,
    lockedComposerIntent,
    currentTurn,
    currentTurnIntent,
    shouldContinuePlanIntent,
    shouldContinuePreviousTurnIntent,
    previousTurnContinuationTarget,
    previousTurnContinuationIntent,
    shouldReuseExistingTurnIntent,
    shouldExecuteOnceFromReplyOption,
    unitySetupEngineSelected,
  } = input;

  let effectiveRunIntent: ResolvedRunIntent =
    mainDebugShortcut ? "plan" :
    options?.resolvedIntent ||
    lockedComposerIntent ||
    (shouldContinuePlanIntent ? "plan" : null) ||
    (shouldContinuePreviousTurnIntent && previousTurnContinuationIntent ? previousTurnContinuationIntent : null) ||
    (shouldReuseExistingTurnIntent ? currentTurnIntent : fallbackRunIntent);
  // Goal is the only intent that creates a durable autonomous runtime. An
  // inferred/inherited intent or an internal resolvedIntent must not mint that
  // runtime. Existing Goal continuations carry their own explicit contract.
  if (
    effectiveRunIntent === "goal" &&
    !isGoalContinuationAuthorization(input.goalContinuationAuthorization) &&
    !isGoalCreationAuthorization(input.goalCreationAuthorization)
  ) {
    effectiveRunIntent = "execute";
  }
  let effectiveIntentSummary = normalizeIntentSummary(options?.intentSummary || "");
  let effectiveCommandDirective: CommandDirective | null = options?.commandDirective ?? null;
  const shouldForceExecuteForAutoApprove =
    !isHidden &&
    autoApproveTools === true &&
    !mainDebugShortcut &&
    !lockedComposerIntent &&
    !shouldContinuePlanIntent &&
    !shouldContinuePreviousTurnIntent &&
    !shouldReuseExistingTurnIntent &&
    !options?.skipIntentResolution &&
    !options?.resolvedIntent;

  if (
    shouldExecuteOnceFromReplyOption &&
    !isGoalContinuationAuthorization(input.goalContinuationAuthorization) &&
    effectiveRunIntent !== "execute" &&
    effectiveRunIntent !== "studio_workflow"
  ) {
    effectiveRunIntent = currentMainModeKey === "game_studio" ? "studio_workflow" : "execute";
    effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(text, effectiveRunIntent, {
      source: "continuation",
    });
    effectiveIntentSummary = effectiveIntentSummary || buildRunIntentSummary({
      input: text,
      intent: effectiveRunIntent,
      language: preferredLanguage,
      reason: preferredLanguage === "en"
        ? "The user selected an execution reply option, so this turn resumes with execute runtime tools."
        : "用户选择了执行型回复选项，本轮使用执行运行能力继续。",
    });
  }

  if (shouldForceExecuteForAutoApprove) {
    effectiveRunIntent = currentMainModeKey === "game_studio" ? "studio_workflow" : "execute";
    effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(text, effectiveRunIntent, {
      source: "natural_language",
      parsedStudioCommand,
    });
    effectiveIntentSummary = effectiveIntentSummary || buildRunIntentSummary({
      input: text,
      intent: effectiveRunIntent,
      language: preferredLanguage,
      reason: preferredLanguage === "en"
        ? "Auto-approval is enabled, so this turn uses execution semantics instead of natural chat."
        : "自动审批已开启，本轮按执行语义处理，而不是普通聊天。",
    });
  }

  if (!effectiveCommandDirective && parsedStudioCommand?.type === "workflow") {
    effectiveCommandDirective = inferCommandDirective(text, "studio_workflow", {
      source: "studio_slash",
      parsedStudioCommand,
    });
  }

  if (unitySetupEngineSelected) {
    effectiveCommandDirective = {
      kind: "unity",
      action: "setup-engine",
      target: "unity",
      source: "studio_slash",
      requiresWorkspace: true,
      requiresApproval: false,
      confidence: 0.98,
      reason: "Game Studio setup-engine explicitly selected Unity.",
    };
  }

  if (mainDebugShortcut && !effectiveIntentSummary) {
    effectiveIntentSummary = "MDEBUG：用户反馈自修复";
    effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(text, "plan", { source: "debug" });
  }

  if (shouldContinuePlanIntent && !effectiveIntentSummary) {
    effectiveIntentSummary = buildRunIntentSummary({
      input: currentTurn?.userPrompt || text,
      intent: "plan",
      language: preferredLanguage,
      reason: preferredLanguage === "en"
        ? "Continue the previous planning turn until the plan is produced."
        : "继续上一轮计划目标，直到生成计划结果。",
    });
    effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(text, "plan", { source: "continuation" });
  }

  if (shouldContinuePreviousTurnIntent && previousTurnContinuationTarget && !effectiveIntentSummary) {
    effectiveIntentSummary = buildRunIntentSummary({
      input: previousTurnContinuationTarget.userPrompt || text,
      intent: previousTurnContinuationIntent || effectiveRunIntent,
      language: preferredLanguage,
      reason: preferredLanguage === "en"
        ? "Continue the previous unfinished turn and complete the remaining work."
        : "继续上一轮未完成内容并完成剩余操作。",
    });
    effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(
      previousTurnContinuationTarget.userPrompt || text,
      previousTurnContinuationIntent || effectiveRunIntent,
      { source: "continuation" },
    );
  }

  if (lockedComposerIntent && !effectiveIntentSummary) {
    effectiveIntentSummary = buildRunIntentSummary({
      input: text,
      intent: lockedComposerIntent,
      language: preferredLanguage,
      reason: preferredLanguage === "en"
        ? "The user confirmed this composer intent before sending."
        : "用户已在发送前确认本轮胶囊意图。",
    });
    effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(text, lockedComposerIntent, {
      source: mainIntentShortcut ? "main_shortcut" : "natural_language",
    });
  }

  return {
    effectiveRunIntent,
    effectiveIntentSummary,
    effectiveCommandDirective,
    shouldForceExecuteForAutoApprove,
  };
}

function commandDirectiveLooksOperational(commandDirective: CommandDirective): boolean {
  return (
    commandDirective.requiresApproval === true ||
    commandDirective.kind === "file_modify" ||
    commandDirective.kind === "shell" ||
    commandDirective.kind === "git" ||
    commandDirective.kind === "unity" ||
    commandDirective.kind === "studio" ||
    commandDirective.kind === "mcp"
  );
}

export function resolveSubmitExecutionApprovalDecision(params: {
  text: string;
  images?: string[];
  preferredLanguage: "zh" | "en";
  resolution: RunIntentResolution;
  effectiveCommandDirective: CommandDirective | null;
  isLocalFastStudioCommand: boolean;
}): SubmitExecutionApprovalDecision {
  const {
    text,
    images,
    preferredLanguage,
    resolution,
    effectiveCommandDirective,
    isLocalFastStudioCommand,
  } = params;
  const locallyRequiresExecutionApproval =
    resolution.requiresApproval === true ||
    (effectiveCommandDirective ? commandDirectiveLooksOperational(effectiveCommandDirective) : false);

  if (
    (resolution.intent === "execute" || resolution.intent === "studio_workflow") &&
    locallyRequiresExecutionApproval &&
    !isLocalFastStudioCommand
  ) {
    return {
      locallyRequiresExecutionApproval,
      pendingRunDecision: buildSubmitIntentConfirmationPendingDecision({
        text,
        images,
        preferredLanguage,
        decision: {
          suggestedIntent: "execute",
          decisionOptions: ["execute", "respond"],
          riskLevel: resolution.riskLevel,
          reason: resolution.reason,
        },
      }),
    };
  }

  return {
    locallyRequiresExecutionApproval,
    pendingRunDecision: null,
  };
}

export function resolveSubmitRuntimeDecision(params: {
  effectiveRunIntent: ResolvedRunIntent;
  runtimeIntentOverride?: ResolvedRunIntent;
  currentMainModeKey: MainModeKey;
  isPlanApproved: boolean;
  autoApproveTools: boolean;
  executionConsentGranted?: boolean;
  shouldExecuteOnceFromReplyOption: boolean;
  preservePlanState: boolean;
  isLocalStudioCommand: boolean;
  goalCreationAuthorization?: GoalCreationAuthorization | null;
  goalContinuationAuthorization?: GoalContinuationAuthorization | null;
}): SubmitRuntimeDecision {
  const requestedRuntimeRunIntent =
    params.runtimeIntentOverride ||
    (params.shouldExecuteOnceFromReplyOption && params.effectiveRunIntent !== "plan"
      ? params.currentMainModeKey === "game_studio" ? "studio_workflow" : "execute"
      : params.effectiveRunIntent);
  const runtimeRunIntent = requestedRuntimeRunIntent === "goal" &&
    !isGoalCreationAuthorization(params.goalCreationAuthorization) &&
    !isGoalContinuationAuthorization(params.goalContinuationAuthorization)
      ? "execute"
      : requestedRuntimeRunIntent;
  const effectiveDisplayIntent: ResolvedRunIntent =
    params.effectiveRunIntent === "plan" && runtimeRunIntent === "execute"
      ? "execute"
      : params.effectiveRunIntent;

  return {
    effectiveWorkflowMode: getIntentPolicy(params.effectiveRunIntent).workflowMode,
    runtimeRunIntent,
    effectiveDisplayIntent,
    shouldGrantExecutionConsentForTurn:
      params.executionConsentGranted === true ||
      params.shouldExecuteOnceFromReplyOption ||
      params.autoApproveTools === true,
    initialTurnStatus:
      params.effectiveRunIntent === "plan" && !params.isPlanApproved
        ? "planning"
        : "executing",
    shouldResetPlanState: !params.preservePlanState && !params.isLocalStudioCommand,
  };
}

export function buildSubmitSessionBootstrapDecision(params: {
  currentWorkspace: string | null | undefined;
  currentSessionId: number | null | undefined;
  sessionsByWorkspace: Record<string, Array<{ id: number }>>;
  language: "zh" | "en";
  sessionRecordingEnabled: boolean;
  autoSessionNowMs: number;
  commandIssuedAtMs: number;
}): SubmitSessionBootstrapDecision {
  const sessionScopeKey = resolveSessionWorkspaceKey(params.currentWorkspace);
  const workspaceSessions = params.sessionsByWorkspace[sessionScopeKey] || [];
  const hasValidCurrentSession =
    params.currentSessionId != null &&
    workspaceSessions.some((session) => session.id === params.currentSessionId);
  const ensuredSessionId = hasValidCurrentSession
    ? params.currentSessionId!
    : params.autoSessionNowMs;
  const autoSessionDate = new Date(params.autoSessionNowMs).toISOString();
  const commandIssuedAtIso = new Date(params.commandIssuedAtMs).toISOString();
  const autoSessionTitle = String(params.currentWorkspace || "").trim()
    ? (params.language === "en" ? "New Conversation" : "新会话")
    : (params.language === "en" ? "New Chat" : "新聊天");
  const runWorkspace = String(params.currentWorkspace || "");
  const runScopeKey = sessionScopeKey;
  const runSessionId = ensuredSessionId;
  const runSessionKey = resolveSessionRuntimeKey(runScopeKey, runSessionId)!;

  return {
    sessionScopeKey,
    ensuredSessionId,
    hasValidCurrentSession,
    autoSession: hasValidCurrentSession
      ? null
      : {
          id: ensuredSessionId,
          title: autoSessionTitle,
          titleSource: "default",
          date: autoSessionDate,
          updatedAt: autoSessionDate,
          updatedAtMs: params.autoSessionNowMs,
          active: true,
          storageStatus: "temporary",
          recordingDisabled: !params.sessionRecordingEnabled,
          messages: [],
        },
    runWorkspace,
    runScopeKey,
    runSessionId,
    runSessionKey,
    commandIssuedAtMs: params.commandIssuedAtMs,
    commandIssuedAtIso,
  };
}

export function buildSubmitSessionBootstrapPatch<
  TSession extends { id: number; active?: boolean },
  TAutoApproveScope,
  TWebSearchProvider,
>(
  params: SubmitSessionBootstrapPatchInput<TSession, TAutoApproveScope, TWebSearchProvider>,
): SubmitSessionBootstrapPatch<TSession, TAutoApproveScope, TWebSearchProvider> | null {
  const { decision } = params;
  if (!decision.autoSession) return null;

  return {
    sessionsByWorkspace: {
      ...params.sessionsByWorkspace,
      [decision.sessionScopeKey]: [
        decision.autoSession,
        ...(params.sessionsByWorkspace[decision.sessionScopeKey] || []).map((session) => ({
          ...session,
          active: false,
        })),
      ],
    },
    currentSessionId: decision.ensuredSessionId,
    activeSessionByWorkspace: {
      ...params.activeSessionByWorkspace,
      [decision.sessionScopeKey]: decision.ensuredSessionId,
    },
    autoApproveTools: params.autoApproveTools,
    autoApproveToolScopes: params.autoApproveToolScopes,
    webSearchEnabled: params.webSearchEnabled,
    webSearchProvider: params.webSearchProvider,
    approvedLocalFileReadPaths: [],
    approvedShellPermissionRules: [],
    readOnlyAutoApproveForSession: false,
  };
}

export function buildLocalTurnTitle(
  input: string,
  intent: ResolvedRunIntent,
  language: "zh" | "en",
  contextSignals?: TurnInputContextLike,
): string {
  const lowerInput = input.toLowerCase();
  const context = normalizeTurnInputContextSignals(contextSignals);
  if (/(?:codex|plan mode|计划模式|\.main\/plans\/plan\.md|plan\.md|proposed_plan)/i.test(input)) {
    return language === "en" ? "Codex-style planning flow" : "重构 Codex 式计划流程";
  }
  if (/(?:sidebar|侧边栏|会话).*(?:标题|title)|(?:标题|title).*(?:sidebar|侧边栏|会话)/i.test(input)) {
    return language === "en" ? "Fix semantic session titles" : "修复会话语义标题";
  }
  if (context.imageParts > 0) {
    if (intent === "plan") return language === "en" ? "Plan screenshot-based fix" : "基于截图制定修复方案";
    if (intent === "analyze") return language === "en" ? "Analyze screenshot issue" : "分析截图中的问题";
    return language === "en" ? "Review screenshot context" : "分析截图上下文";
  }
  if (context.mentionedFilePaths.length > 0 || context.attachedFilePaths.length > 0) {
    const fileName = [...context.mentionedFilePaths, ...context.attachedFilePaths][0]?.split(/[\\/]/).pop() || "";
    if (fileName) return language === "en" ? `Analyze ${fileName}` : `分析 ${fileName}`;
    return language === "en" ? "Analyze provided files" : "分析提供的文件";
  }
  const dataKeywords = /表格|excel|xlsx|csv|数据|用户画像|ltv|rfm|k-means|聚类|付费|注册|评论/i;
  if (dataKeywords.test(lowerInput)) {
    return language === "en" ? "Analyze user data" : "分析用户行为数据";
  }
  const cleanedInput = summarizeUserPrompt(input, language === "en" ? 52 : 40);
  if (cleanedInput) return cleanedInput;
  if (intent === "plan") return language === "en" ? "Create analysis plan" : "制定分析计划";
  if (intent === "report") return language === "en" ? "Generate report" : "生成分析报告";
  if (intent === "summarize") return language === "en" ? "Summarize materials" : "总结资料内容";
  if (intent === "analyze") return language === "en" ? "Analyze materials" : "分析资料内容";
  return language === "en" ? "New task" : "新的任务";
}

export function buildTitleIntentSignature(
  input: string,
  intent: ResolvedRunIntent,
  contextSignals?: TurnInputContextLike,
): string {
  const context = normalizeTurnInputContextSignals(contextSignals);
  return [
    intent,
    String(input || "").replace(/\s+/g, " ").trim().slice(0, 160),
    `images:${context.imageParts}`,
    `mentions:${context.mentionedFilePaths.slice(0, 3).join(",")}`,
    `attachments:${context.attachedFilePaths.slice(0, 3).join(",")}`,
  ].join("|");
}

export function resolveSubmitTurnTitleDecision(params: {
  text: string;
  effectiveRunIntent: ResolvedRunIntent;
  preferredLanguage: "zh" | "en";
  isMainDebugShortcut?: boolean;
  contextSignals?: TurnInputContextLike;
  existingTurnTitle?: string | null;
  optionTurnTitle?: string | null;
  activeSession?: SessionTitleSeedState | null;
}): SubmitTurnTitleDecision {
  const turnInputContextSignals = normalizeTurnInputContextSignals(params.contextSignals);
  const existingTitle =
    params.existingTurnTitle && !isGenericConversationTitle(params.existingTurnTitle)
      ? params.existingTurnTitle
      : "";
  const optionTitle =
    params.optionTurnTitle && !isGenericConversationTitle(params.optionTurnTitle)
      ? params.optionTurnTitle
      : "";
  const localTurnTitle = params.isMainDebugShortcut
    ? "MDEBUG：用户反馈自修复"
    : buildLocalTurnTitle(
        params.text,
        params.effectiveRunIntent,
        params.preferredLanguage,
        turnInputContextSignals,
      );
  const turnTitle = normalizeConversationDisplayTitle(
    existingTitle || optionTitle || localTurnTitle,
    params.preferredLanguage === "en" ? 48 : 40,
    localTurnTitle,
  );
  const titleIntentSignature = buildTitleIntentSignature(
    params.text,
    params.effectiveRunIntent,
    turnInputContextSignals,
  );
  const shouldSeedSessionTitleForTurn = shouldSeedSessionTitle(params.activeSession);

  return {
    turnInputContextSignals,
    existingTitle,
    optionTitle,
    localTurnTitle,
    turnTitle,
    titleIntentSignature,
    shouldSeedSessionTitleForTurn,
    seededSessionTitleCandidate: shouldSeedSessionTitleForTurn ? turnTitle : "",
  };
}

export function resolveSubmitSemanticMetadataDecision<TConfig extends object>(params: {
  text: string;
  isHidden: boolean;
  reuseCurrentTurn: boolean;
  optionTurnTitle?: string | null;
  currentMainModeKey: MainModeKey;
  turnId: string;
  ensuredSessionId: number | null | undefined;
  sessionScopeKey: string;
  effectiveRunIntent: ResolvedRunIntent;
  preferredLanguage: "zh" | "en";
  currentConfig: TConfig;
  contextSignals?: TurnInputContextLike;
  titleIntentSignature: string;
  seededSessionTitleCandidate: string;
}): SubmitSemanticMetadataDecision<TConfig> | null {
  if (!shouldRequestSemanticTurnMetadataForTurn({
    input: params.text,
    hidden: params.isHidden,
    reuseCurrentTurn: params.reuseCurrentTurn,
    turnTitle: params.optionTurnTitle,
    mainModeKey: params.currentMainModeKey,
  })) {
    return null;
  }

  return {
    expectedTurnId: params.turnId,
    expectedTurnPrompt: params.text.trim(),
    expectedSessionId: params.ensuredSessionId ?? null,
    sessionScopeKey: params.sessionScopeKey,
    titleIntentSignature: params.titleIntentSignature,
    seededSessionTitleCandidate: params.seededSessionTitleCandidate,
    request: {
      input: params.text,
      intent: params.effectiveRunIntent,
      language: params.preferredLanguage,
      config: params.currentConfig,
      contextSignals: normalizeTurnInputContextSignals(params.contextSignals),
    },
  };
}

export function resolveSubmitSendGateDecision(params: {
  text: string;
  imagesLength: number;
  hasSupplementalInput: boolean;
  isHidden: boolean;
  executionConsentGranted?: boolean;
  shouldExecuteOnceFromReplyOption: boolean;
  isGenerating: boolean;
  agentStatus: string;
  hasAbortController: boolean;
  hasCurrentTurn: boolean;
}): SubmitSendGateDecision {
  const isEmptyInput =
    !params.text.trim() &&
    params.imagesLength === 0 &&
    !params.hasSupplementalInput;
  if (isEmptyInput) {
    return {
      allowHiddenExecutionWhileBusy: false,
      allowedBusyReasons: [],
      action: { kind: "block_empty", reason: "empty_text_no_images_no_context" },
    };
  }

  // Execution consent authorizes the operation, not a second runtime owner.
  // Hidden resumes must still wait for the active lease to finish.
  const allowHiddenExecutionWhileBusy = false;
  const allowedBusyReasons: SubmitSendGateAllowedBusyReason[] = [];

  if (params.isGenerating) {
    if (!allowHiddenExecutionWhileBusy) {
      return {
        allowHiddenExecutionWhileBusy,
        allowedBusyReasons,
        action: { kind: "queue", reason: "generation_in_progress" },
      };
    }
    allowedBusyReasons.push("generation_in_progress");
  }

  if (
    params.agentStatus === "pending_review" &&
    params.hasAbortController &&
    (params.executionConsentGranted === true || params.shouldExecuteOnceFromReplyOption)
  ) {
    return {
      allowHiddenExecutionWhileBusy,
      allowedBusyReasons,
      action: { kind: "approve_pending_review" },
    };
  }

  if (params.agentStatus === "running" || params.agentStatus === "pending_review") {
    if (!allowHiddenExecutionWhileBusy && !params.hasAbortController) {
      return {
        allowHiddenExecutionWhileBusy,
        allowedBusyReasons,
        action: {
          kind: "reset_stuck_state",
          previousStatus: params.agentStatus,
          turnStatus: params.hasCurrentTurn
            ? params.agentStatus === "pending_review"
              ? "awaiting_approval"
              : "stopped_no_action"
            : undefined,
        },
      };
    }

    if (!allowHiddenExecutionWhileBusy) {
      return {
        allowHiddenExecutionWhileBusy,
        allowedBusyReasons,
        action: {
          kind: "queue",
          reason: "agent_running_or_pending_review",
          agentStatus: params.agentStatus,
        },
      };
    }

    allowedBusyReasons.push("agent_running");
  }

  return {
    allowHiddenExecutionWhileBusy,
    allowedBusyReasons,
    action: { kind: "continue" },
  };
}

export function resolveSubmitPreflightResultDecision(params: {
  text: string;
  images?: string[];
  preferredLanguage: "zh" | "en";
  resolution: RunIntentResolution;
  preflight: IntentPreflightResult | null;
}): SubmitPreflightResultDecision {
  const { text, images, preferredLanguage, resolution, preflight } = params;
  const resolvedByPreflight =
    preflight?.intent === "studio_workflow" ? resolution.intent : preflight?.intent;
  const resolvedIntent = (resolvedByPreflight || resolution.intent) as ResolvedRunIntent;
  const commandDirective =
    preflight?.commandDirective ||
    resolution.commandDirective ||
    inferCommandDirective(text, resolvedIntent);
  const preflightSuggestsOperation =
    !!preflight &&
    (
      resolvedIntent === "execute" ||
      resolvedIntent === "studio_workflow" ||
      commandDirectiveLooksOperational(commandDirective)
    );

  if (preflight?.needsUserChoice) {
    const decisionOptions = preflight.options
      ?.map((option) => option.id)
      .filter(isResolvedUserIntentChoice);
    return {
      kind: "ask_user_choice",
      pendingRunDecision: buildSubmitIntentConfirmationPendingDecision({
        text,
        images,
        source: "preflight",
        preferredLanguage,
        decision: {
          suggestedIntent: preflight.intent,
          decisionOptions,
          riskLevel: resolution.riskLevel,
          reason: resolution.reason,
        },
        titleOverride: preflight.question,
        reasonOverride: resolution.reason,
        optionsOverride: preflight.options,
      }),
      resolvedIntent,
      commandDirective,
      turnTitle: preflight.title,
      intentSummary: buildRunIntentSummary({
        input: text,
        intent: resolvedIntent,
        language: preferredLanguage,
        preflightSummary: preflight.summary,
        reason: preflight.reason || resolution.reason,
      }),
      preflightSuggestsOperation,
    };
  }

  const localWasNatural =
    (resolution.intent === "respond" || resolution.intent === "discuss") &&
    resolution.riskLevel === "low";
  const shouldAskForPreflightExecutionDecision =
    localWasNatural &&
    preflightSuggestsOperation &&
    (
      preflight?.intent !== resolution.intent ||
      preflight?.requiresApproval === true ||
      (preflight?.confidence ?? 0) < 0.92
    );

  if (shouldAskForPreflightExecutionDecision) {
    return {
      kind: "ask_execution_confirmation",
      pendingRunDecision: buildSubmitIntentConfirmationPendingDecision({
        text,
        images,
        source: "preflight",
        preferredLanguage,
        decision: {
          suggestedIntent: "execute",
          decisionOptions: ["execute", "respond", "plan"],
          riskLevel: preflight?.riskLevel || "medium",
          reason: preflight?.reason || resolution.reason,
        },
      }),
      resolvedIntent,
      commandDirective,
      turnTitle: preflight?.title,
      intentSummary: buildRunIntentSummary({
        input: text,
        intent: resolvedIntent,
        language: preferredLanguage,
        preflightSummary: preflight?.summary,
        reason: preflight?.reason || resolution.reason,
      }),
      preflightSuggestsOperation,
    };
  }

  return {
    kind: "resume_with_preflight",
    pendingRunDecision: null,
    resolvedIntent,
    commandDirective,
    turnTitle: preflight?.title,
    intentSummary: buildRunIntentSummary({
      input: text,
      intent: resolvedIntent,
      language: preferredLanguage,
      preflightSummary: preflight?.summary,
      reason: preflight?.reason || resolution.reason,
    }),
    preflightSuggestsOperation,
  };
}

export function resolveSubmitPreflightStalenessDecision(params: {
  originalText: string;
  latestInput: string;
  originalMainModeKey: MainModeKey;
  latestMainModeKey: MainModeKey;
  lockedComposerIntent?: MainIntentShortcut | null;
}): SubmitPreflightStalenessDecision {
  const latestInput = params.latestInput.trim();
  const hasComparableLatestInput = latestInput.length > 0;
  const hasExplicitShortcut =
    !!parseMainIntentShortcutForMode(latestInput, params.latestMainModeKey) ||
    !!parseMainDebugShortcut(latestInput);
  const hasLockedComposerIntent = !!params.lockedComposerIntent;
  return {
    stale:
      (hasComparableLatestInput && latestInput !== params.originalText.trim()) ||
      params.latestMainModeKey !== params.originalMainModeKey ||
      hasLockedComposerIntent ||
      hasExplicitShortcut,
    latestInput,
    latestChars: latestInput.length,
    selectedMainModeKey: params.latestMainModeKey,
    hasLockedComposerIntent,
    hasExplicitShortcut,
  };
}

export function buildSubmitBlockingPreflightEffect<
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
>(params: {
  resolution: RunIntentResolution;
  currentMainModeKey: MainModeKey;
  text: string;
  images?: string[];
  options?: TOptions;
  preferredLanguage: "zh" | "en";
  currentConfig: TConfig;
  sendOriginSessionKey: string | null;
}): SubmitBlockingPreflightEffect<TConfig, TOptions> | null {
  if (!shouldUseBlockingIntentPreflight(params.resolution, params.currentMainModeKey, params.text)) {
    return null;
  }

  return {
    request: {
      input: params.text,
      language: params.preferredLanguage,
      mainModeKey: params.currentMainModeKey,
      config: params.currentConfig,
    },
    originalText: params.text,
    originalImages: params.images,
    originalOptions: params.options,
    originalMainModeKey: params.currentMainModeKey,
    preferredLanguage: params.preferredLanguage,
    resolution: params.resolution,
    sendOriginSessionKey: params.sendOriginSessionKey,
  };
}

export function buildSubmitPreflightResumeOptions<
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
>(params: {
  options?: TOptions;
  decision: SubmitPreflightResultDecision;
}): TOptions & SubmitPreflightResumeOptions {
  return {
    ...(params.options || {}),
    resolvedIntent: params.decision.resolvedIntent,
    commandDirective: params.decision.commandDirective,
    skipIntentResolution: true,
    turnTitle: params.decision.turnTitle,
    intentSummary: params.decision.intentSummary,
  } as TOptions & SubmitPreflightResumeOptions;
}

export function resolveSubmitPreflightEffectAction<
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
>(params: {
  effect: SubmitBlockingPreflightEffect<TConfig, TOptions>;
  preflight: IntentPreflightResult | null;
  latestInput: string;
  latestMainModeKey: MainModeKey;
  lockedComposerIntent?: MainIntentShortcut | null;
  isOriginSessionActive: boolean;
}): SubmitPreflightEffectAction<TOptions> {
  const staleness = resolveSubmitPreflightStalenessDecision({
    originalText: params.effect.originalText,
    latestInput: params.latestInput,
    originalMainModeKey: params.effect.originalMainModeKey,
    latestMainModeKey: params.latestMainModeKey,
    lockedComposerIntent: params.lockedComposerIntent,
  });

  if (staleness.stale) {
    return {
      kind: "stale_discard",
      log: {
        originalChars: params.effect.originalText.trim().length,
        latestChars: staleness.latestChars,
        selectedMainModeKey: staleness.selectedMainModeKey,
        hasLockedComposerIntent: staleness.hasLockedComposerIntent,
        hasExplicitShortcut: staleness.hasExplicitShortcut,
      },
    };
  }

  const preflightDecision = resolveSubmitPreflightResultDecision({
    text: params.effect.originalText,
    images: params.effect.originalImages,
    preferredLanguage: params.effect.preferredLanguage,
    resolution: params.effect.resolution,
    preflight: params.preflight,
  });

  if (
    preflightDecision.kind === "ask_user_choice" ||
    preflightDecision.kind === "ask_execution_confirmation"
  ) {
    return {
      kind: "set_pending_decision",
      pendingRunDecision: preflightDecision.pendingRunDecision!,
    };
  }

  if (params.effect.sendOriginSessionKey && !params.isOriginSessionActive) {
    return {
      kind: "skip_inactive_session",
      phase: "intent_preflight",
      sessionKey: params.effect.sendOriginSessionKey,
    };
  }

  return {
    kind: "resume",
    text: params.effect.originalText,
    images: params.effect.originalImages,
    options: buildSubmitPreflightResumeOptions({
      options: params.effect.originalOptions,
      decision: preflightDecision,
    }),
  };
}

export function hasOperationApprovalReplyOption(replyOptions: ReplyOption[]): boolean {
  return replyOptions.some((option) =>
    option.action === "approve_operation_once" ||
    option.action === "execute_once" ||
    option.source === "proposal_follow_up" ||
    option.source === "operation_approval"
  );
}

export function replyOptionMatchesSelectedText(
  replyOptions: ReplyOption[],
  selectedChoiceText: string,
): boolean {
  const selected = selectedChoiceText.trim();
  if (!selected) return false;
  return replyOptions.some((option) =>
    String(option.value || "").trim() === selected ||
    String(option.label || "").trim() === selected
  );
}

export function findReplyOptionMatchingSelectedText(
  replyOptions: ReplyOption[],
  selectedChoiceText: string,
): ReplyOption | null {
  const selected = selectedChoiceText.trim();
  if (!selected) return null;
  return replyOptions.find((option) =>
    String(option.value || "").trim() === selected ||
    String(option.label || "").trim() === selected
  ) || null;
}

export function archiveReplyOptionBlocksForChoice(
  taskFlow: TaskBlock[],
  turnId: string | undefined,
  selectedChoiceText: string,
): {
  taskFlow: TaskBlock[];
  archivedCount: number;
  exactTurnOptionBlocks: number;
  selectedFallbackBlocks: number;
  matchMode: "turn" | "selected_fallback" | "none";
} {
  const exactTurnOptionBlocks = turnId
    ? taskFlow.filter((block) =>
        block.turnId === turnId &&
        block.type === "agent" &&
        Array.isArray(block.options) &&
        block.options.length > 0
      ).length
    : 0;
  const useSelectedFallback = exactTurnOptionBlocks === 0 && selectedChoiceText.trim().length > 0;
  let archivedCount = 0;
  let selectedFallbackBlocks = 0;
  const nextTaskFlow = taskFlow.map((block) => {
    if (
      block.type !== "agent" ||
      !Array.isArray(block.options) ||
      block.options.length === 0
    ) {
      return block;
    }
    const matchesTurn = !!turnId && block.turnId === turnId;
    const matchesFallback =
      useSelectedFallback && replyOptionMatchesSelectedText(block.options, selectedChoiceText);
    if (!matchesTurn && !matchesFallback) return block;
    archivedCount += 1;
    if (matchesFallback && !matchesTurn) selectedFallbackBlocks += 1;
    return {
      ...block,
      options: undefined,
      choiceRequest: undefined,
      archivedAfterChoice: true,
      ...(hasOperationApprovalReplyOption(block.options) ? { archivedProposal: true } : {}),
      ...(selectedChoiceText.trim() ? { selectedOption: selectedChoiceText.trim() } : {}),
    };
  });

  return {
    taskFlow: nextTaskFlow,
    archivedCount,
    exactTurnOptionBlocks,
    selectedFallbackBlocks,
    matchMode: archivedCount > 0
      ? exactTurnOptionBlocks > 0
        ? "turn"
        : "selected_fallback"
      : "none",
  };
}

export function archiveConsumedReplyOptionsFromTaskFlow(taskFlow: TaskBlock[]): TaskBlock[] {
  let changed = false;
  const selectedUsersByTurn = new Map<string, Array<Extract<TaskBlock, { type: "user" }>>>();
  taskFlow.forEach((block) => {
    if (block.type !== "user" || !block.turnId) return;
    const existing = selectedUsersByTurn.get(block.turnId) || [];
    existing.push(block);
    selectedUsersByTurn.set(block.turnId, existing);
  });
  const nextTaskFlow = taskFlow.map((block, index) => {
    if (
      block.type !== "agent" ||
      !Array.isArray(block.options) ||
      block.options.length === 0
    ) {
      return block;
    }
    const turnUsers = block.turnId ? selectedUsersByTurn.get(block.turnId) || [] : [];
    const selectedUserBlock =
      (
        taskFlow
          .slice(index + 1)
          .find((candidate) =>
            candidate.turnId === block.turnId &&
            candidate.type === "user" &&
            replyOptionMatchesSelectedText(block.options!, String(candidate.content || ""))
          ) as Extract<TaskBlock, { type: "user" }> | undefined
      ) ||
      turnUsers.find((candidate) =>
        replyOptionMatchesSelectedText(block.options!, String(candidate.content || ""))
      );
    if (!selectedUserBlock) return block;
    changed = true;
    const selected = String(selectedUserBlock.content || "").trim();
    return {
      ...block,
      options: undefined,
      choiceRequest: undefined,
      archivedAfterChoice: true,
      ...(hasOperationApprovalReplyOption(block.options) ? { archivedProposal: true } : {}),
      ...(selected ? { selectedOption: selected } : {}),
    };
  });
  return changed ? nextTaskFlow : taskFlow;
}

export function normalizeTaskFlowPatchForConsumedReplyOptions<T extends Record<string, unknown>>(
  patch: T,
): T {
  if (!Array.isArray((patch as any).taskFlow)) return patch;
  const taskFlow = (patch as any).taskFlow as TaskBlock[];
  const normalizedTaskFlow = archiveConsumedReplyOptionsFromTaskFlow(taskFlow);
  return normalizedTaskFlow === taskFlow
    ? patch
    : ({ ...patch, taskFlow: normalizedTaskFlow } as T);
}

export function applyOperationProposalChoice(
  proposal: PendingOperationProposal | undefined,
  action?: ReplyOption["action"],
): PendingOperationProposal | undefined {
  if (!proposal) return proposal;
  if (action === "approve_operation_once" || action === "execute_once") {
    return {
      ...proposal,
      approvalStatus: "approved",
      approvedAt: Date.now(),
    };
  }
  if (action === "adjust_plan") {
    return {
      ...proposal,
      approvalStatus: "adjusting",
    };
  }
  if (action === "cancel_operation") {
    return {
      ...proposal,
      approvalStatus: "cancelled",
    };
  }
  return proposal;
}

export function buildSubmitVisibleTurnPatch(
  params: SubmitVisibleTurnPatchInput,
): SubmitVisibleTurnPatch {
  if (!params.isHidden && params.userBlockId == null) {
    throw new Error("userBlockId is required for visible submit turns");
  }

  const replyOptionArchiveTurnId =
    params.explicitReplyOptionSourceTurnId ||
    ((params.shouldExplicitlyReuseCurrentTurn || params.shouldAutoResumeChoiceTurn) &&
    params.currentTurnHasReplyOptions
      ? params.turnId
      : undefined);
  const shouldArchiveChoiceFeedback = !params.isHidden && !!replyOptionArchiveTurnId;
  const selectedChoiceText = shouldArchiveChoiceFeedback
    ? String(params.selectedReplyOptionText || params.text || "").trim()
    : "";
  const archiveResult = shouldArchiveChoiceFeedback
    ? archiveReplyOptionBlocksForChoice(
        params.taskFlow,
        replyOptionArchiveTurnId,
        selectedChoiceText,
      )
    : {
        taskFlow: params.taskFlow,
        archivedCount: 0,
        exactTurnOptionBlocks: 0,
        selectedFallbackBlocks: 0,
        matchMode: "none" as const,
      };
  const userBlock: Extract<TaskBlock, { type: "user" }> | null = params.isHidden
    ? null
    : {
        id: params.userBlockId!,
        turnId: params.turnId,
        type: "user",
        content: params.text,
        ...(params.userContextItems && params.userContextItems.length > 0
          ? { contextItems: params.userContextItems }
          : {}),
        ...(params.images && params.images.length > 0 ? { images: params.images } : {}),
      };
  const taskFlow = userBlock
    ? [...archiveResult.taskFlow, userBlock]
    : archiveResult.taskFlow;

  const autoCollapsePreviousTurnForNewTurn = (turns: ConversationTurn[]): ConversationTurn[] => {
    if (params.isHidden || params.reuseCurrentTurn || turns.length === 0) return turns;
    const previousTurnIndex = turns.length - 1;
    const previousTurn = turns[previousTurnIndex];
    if (!previousTurn || (previousTurn.processCollapsed ?? previousTurn.collapsed)) return turns;
    return turns.map((turn, index) =>
      index === previousTurnIndex ? { ...turn, processCollapsed: true, collapsed: true } : turn,
    );
  };

  const markParentPlanTurnDoneForExecution = (turns: ConversationTurn[]): ConversationTurn[] => {
    if (!params.parentPlanTurnId) return turns;
    return turns.map((turn) =>
      turn.id === params.parentPlanTurnId
        ? {
            ...turn,
            status: "done" as const,
            summary: params.parentPlanTurnDoneSummary,
          }
        : turn,
    );
  };

  const updateExistingTurn = (turn: ConversationTurn): ConversationTurn =>
    turn.id === params.turnId
      ? (() => {
          const preservePlanIdentity =
            turn.intent === "plan" &&
            params.effectiveRunIntent === "execute";
          return {
          ...turn,
          status: params.initialTurnStatus,
          intent: preservePlanIdentity ? "plan" : params.effectiveRunIntent,
          displayIntent: params.effectiveDisplayIntent,
          intentSummary: turn.intentSummary || params.effectiveIntentSummary,
          commandDirective: turn.commandDirective || params.effectiveCommandDirective || undefined,
          pendingOperationProposal: applyOperationProposalChoice(
            turn.pendingOperationProposal,
            params.operationProposalChoiceAction,
          ),
          mode: preservePlanIdentity ? "plan" : params.effectiveWorkflowMode,
          ...(userBlock && !turn.blockIds.includes(userBlock.id)
            ? { blockIds: [...turn.blockIds, userBlock.id] }
            : {}),
          };
        })()
      : turn;

  if (params.reuseCurrentTurn) {
    return {
      taskFlow,
      conversationTurns: params.conversationTurns.map(updateExistingTurn),
      userBlock,
      replyOptionArchiveTurnId,
      shouldArchiveChoiceFeedback,
      selectedChoiceText,
      archiveSummary: {
        optionBlocks: archiveResult.exactTurnOptionBlocks,
        archivedOptionBlocks: archiveResult.archivedCount,
        selectedFallbackBlocks: archiveResult.selectedFallbackBlocks,
        matchMode: archiveResult.matchMode,
      },
    };
  }

  const baseTurns = markParentPlanTurnDoneForExecution(
    autoCollapsePreviousTurnForNewTurn(params.conversationTurns).map((turn) =>
      !userBlock && params.uiParentTurnId && turn.id === params.uiParentTurnId
        ? {
            ...turn,
            status: params.initialTurnStatus,
            intent: turn.intent || params.effectiveRunIntent,
            displayIntent: turn.displayIntent || params.effectiveDisplayIntent,
          }
        : turn,
    ),
  );
  const newTurn: ConversationTurn = userBlock
    ? {
        id: params.turnId,
        userPrompt: params.text,
        title: params.turnTitle,
        intentSummary: params.effectiveIntentSummary,
        commandDirective: params.effectiveCommandDirective || undefined,
        mode: params.effectiveWorkflowMode,
        intent: params.effectiveRunIntent,
        displayIntent: params.effectiveDisplayIntent,
        status: params.initialTurnStatus,
        summary: "",
        blockIds: [userBlock.id],
        processCollapsed: false,
        collapsed: false,
        createdAt: params.createdAtMs,
      }
    : {
        id: params.turnId,
        userPrompt: params.text,
        title: params.turnTitle,
        intentSummary: params.effectiveIntentSummary,
        commandDirective: params.effectiveCommandDirective || undefined,
        uiVisibility: params.isInternalTurn ? "internal" : "visible",
        ...(params.parentPlanTurnId ? { parentPlanTurnId: params.parentPlanTurnId } : {}),
        mode: params.effectiveWorkflowMode,
        intent: params.effectiveRunIntent,
        displayIntent: params.effectiveDisplayIntent,
        status: params.initialTurnStatus,
        summary: "",
        blockIds: [],
        processCollapsed: false,
        collapsed: false,
        createdAt: params.createdAtMs,
      };

  return {
    taskFlow,
    conversationTurns: [...baseTurns, newTurn],
    userBlock,
    replyOptionArchiveTurnId,
    shouldArchiveChoiceFeedback,
    selectedChoiceText,
    archiveSummary: {
      optionBlocks: archiveResult.exactTurnOptionBlocks,
      archivedOptionBlocks: archiveResult.archivedCount,
      selectedFallbackBlocks: archiveResult.selectedFallbackBlocks,
      matchMode: archiveResult.matchMode,
    },
  };
}

function autoCollapsePreviousTurnForLocalStudioTurn(params: {
  turns: ConversationTurn[];
  isHidden: boolean;
  reuseCurrentTurn: boolean;
}): ConversationTurn[] {
  if (params.isHidden || params.reuseCurrentTurn || params.turns.length === 0) return params.turns;
  const previousTurnIndex = params.turns.length - 1;
  const previousTurn = params.turns[previousTurnIndex];
  if (!previousTurn || (previousTurn.processCollapsed ?? previousTurn.collapsed)) return params.turns;
  return params.turns.map((turn, index) =>
    index === previousTurnIndex ? { ...turn, processCollapsed: true, collapsed: true } : turn,
  );
}

function markParentPlanTurnDoneForLocalStudioTurn(
  turns: ConversationTurn[],
  parentPlanTurnId: string | undefined,
  summary: string,
): ConversationTurn[] {
  if (!parentPlanTurnId) return turns;
  return turns.map((turn) =>
    turn.id === parentPlanTurnId
      ? {
          ...turn,
          status: "done" as const,
          summary,
        }
      : turn,
  );
}

export function buildSubmitLocalStudioTurnPatch(
  params: SubmitLocalStudioTurnPatchInput,
): SubmitLocalStudioTurnPatch {
  if (!params.isHidden && params.userBlockId == null) {
    throw new Error("userBlockId is required for visible local studio turns");
  }

  const userBlock: Extract<TaskBlock, { type: "user" }> | null = params.isHidden
    ? null
    : {
        id: params.userBlockId!,
        turnId: params.turnId,
        type: "user",
        content: params.text,
        ...(params.userContextItems && params.userContextItems.length > 0
          ? { contextItems: params.userContextItems }
          : {}),
      };
  const systemBlock: Extract<TaskBlock, { type: "system" }> = {
    id: params.systemBlockId,
    turnId: params.turnId,
    type: "system",
    content: params.systemContent,
    ...(params.systemVariant ? { variant: params.systemVariant } : {}),
  };

  const taskFlow = [
    ...params.taskFlow,
    ...(userBlock ? [userBlock] : []),
    systemBlock,
  ];

  if (params.reuseCurrentTurn) {
    return {
      taskFlow,
      conversationTurns: params.conversationTurns.map((turn) =>
        turn.id === params.turnId
          ? {
              ...turn,
              status: "done",
              displayIntent: params.effectiveDisplayIntent,
              intentSummary: turn.intentSummary || params.effectiveIntentSummary,
              commandDirective: turn.commandDirective || params.effectiveCommandDirective || undefined,
              blockIds: [
                ...turn.blockIds,
                ...(userBlock ? [userBlock.id] : []),
                systemBlock.id,
              ].filter((value, index, array) => array.indexOf(value) === index),
            }
          : turn,
      ),
      userBlock,
      systemBlock,
    };
  }

  const baseTurns = markParentPlanTurnDoneForLocalStudioTurn(
    autoCollapsePreviousTurnForLocalStudioTurn({
      turns: params.conversationTurns,
      isHidden: params.isHidden,
      reuseCurrentTurn: params.reuseCurrentTurn,
    }),
    params.parentPlanTurnId,
    params.parentPlanTurnDoneSummary,
  );
  return {
    taskFlow,
    conversationTurns: [
      ...baseTurns,
      {
        id: params.turnId,
        userPrompt: params.text,
        title: params.turnTitle,
        intentSummary: params.effectiveIntentSummary,
        commandDirective: params.effectiveCommandDirective || undefined,
        ...(params.parentPlanTurnId ? { parentPlanTurnId: params.parentPlanTurnId } : {}),
        mode: params.effectiveWorkflowMode,
        intent: params.effectiveRunIntent,
        displayIntent: params.effectiveDisplayIntent,
        status: "done",
        summary: params.systemContent,
        blockIds: [...(userBlock ? [userBlock.id] : []), systemBlock.id],
        processCollapsed: false,
        collapsed: false,
        createdAt: params.createdAtMs,
      },
    ],
    userBlock,
    systemBlock,
  };
}

export function buildSubmitRunStatePatch<TConfig extends object>(
  params: SubmitRunStatePatchInput<TConfig>,
): SubmitRunStatePatch<TConfig> {
  return {
    currentTurnId: params.turnId,
    input: params.isHidden ? params.currentInput : "",
    preferredResponseLanguage: params.preferredLanguage,
    ...(params.shouldArchiveChoiceFeedback
      ? {
          normalizedStreamState: {
            ...params.currentNormalizedStreamState,
            replyOptions: [],
            finishReason: null,
          },
        }
      : {}),
    pendingSlashCommand:
      params.parsedStudioCommand?.type === "workflow" ? params.parsedStudioCommand : null,
    lockedComposerIntent: null,
    pendingRunDecision: null,
    activeActionRequest: null,
    isGenerating: true,
    config: {
      ...params.currentConfig,
      workflowMode: params.effectiveWorkflowMode,
    },
    ...(params.preservePlanState
      ? {}
      : {
          isPlanApproved: false,
          planApprovalChoice: null,
          pendingPlanApprovalHandoff: null,
          planApprovalExecutionStartedForTurnId: null,
          clearedPlanTurnId: null,
          planAutoResumeCount: 0,
          planExecutionProgressSnapshot: null,
        }),
    ...(params.shouldGrantExecutionConsentForTurn
      ? { currentTurnExecutionConsent: { turnId: params.turnId, granted: true } as const }
      : {}),
    ...(params.preservePlanState && params.shouldGrantExecutionConsentForTurn
      ? {
          pendingPlanApprovalHandoff: null,
          planApprovalExecutionStartedForTurnId: params.turnId,
        }
      : {}),
    elapsedTime: 0,
  };
}

export function buildSubmitHarnessRunMarkerDraft(
  params: SubmitHarnessRunMarkerDraftInput,
): HarnessRunMarker {
  return {
    schemaVersion: 1,
    runId: params.runId,
    instanceId: params.instanceId,
    sessionKey: params.runSessionKey,
    workspace: params.runWorkspace || null,
    sessionId: params.runSessionId ?? null,
    turnId: params.turnId,
    status: "running",
    workflowMode: getIntentPolicy(params.effectiveRunIntent).workflowMode,
    runtimeIntent: params.runtimeRunIntent,
    planStage: params.planStage,
    isPlanApproved: params.isPlanApproved,
    iteration: 0,
    maxIterations: 0,
    messagesLen: params.messagesLen,
    toolCount: 0,
    latestTool: null,
    latestToolTarget: null,
    activeStreamId: null,
    streamStatus: "run_started",
    streamChunkCount: 0,
    streamByteCount: 0,
    streamElapsedMs: null,
    streamLifecycleStatus: null,
    lastStreamError: null,
    startedAt: params.startedAtMs,
    updatedAt: params.startedAtMs,
    closedAt: null,
    closeReason: null,
  };
}

function turnHasActivity(turn: ConversationTurn | null, taskFlow: TaskBlock[]): boolean {
  if (!turn) return false;
  if (Array.isArray(turn.blockIds) && turn.blockIds.length > 0) return true;
  return taskFlow.some((block) => block.turnId === turn.id);
}

function turnHasToolBlocks(turnId: string, taskFlow: TaskBlock[]): boolean {
  return taskFlow.some((block) => block.turnId === turnId && block.type === "tool");
}

function isContinuationEchoTurn(turn: ConversationTurn | null, taskFlow: TaskBlock[]): boolean {
  if (!turn) return false;
  if (turn.status !== "done") return false;
  const intent = resolveConversationTurnIntent(turn);
  if (intent !== "respond" && intent !== "discuss") return false;
  if (!looksLikePreviousTurnContinuationInput(turn.userPrompt || "")) return false;
  return !turnHasToolBlocks(turn.id, taskFlow);
}

export function findPreviousTurnContinuationTarget(
  input: string,
  currentTurn: ConversationTurn | null,
  conversationTurns: ConversationTurn[],
  taskFlow: TaskBlock[],
): ConversationTurn | null {
  const canResume = (turn: ConversationTurn | null): boolean =>
    shouldContinuePreviousTurnFromInput(input, {
      currentTurnIntent: resolveConversationTurnIntent(turn),
      currentTurnStatus: turn?.status ?? null,
      hasCurrentTurn: !!turn,
      hasTurnActivity: turnHasActivity(turn, taskFlow),
    });

  if (currentTurn && canResume(currentTurn)) return currentTurn;
  if (!isContinuationEchoTurn(currentTurn, taskFlow)) return null;

  for (let index = conversationTurns.length - 1; index >= 0; index--) {
    const turn = conversationTurns[index];
    if (turn.id === currentTurn?.id) continue;
    if (canResume(turn)) return turn;
  }

  return null;
}

const PLAN_EXECUTION_CONTEXT_RE = /执行已批准计划|计划执行|已批准计划|执行回合|计划执行恢复|剩余任务|未完成任务|可信执行证据|继续执行|resume execution|plan execution|execute approved plan|remaining tasks/i;

function collectPlanResumeContextText(turn: ConversationTurn | null, taskFlow: TaskBlock[]): string {
  if (!turn) return "";
  const parts: string[] = [
    turn.userPrompt || "",
    turn.title || "",
    turn.intentSummary || "",
    turn.summary || "",
  ];
  let collectedChars = parts.reduce((count, part) => count + part.length, 0);

  const appendValue = (value: unknown, depth = 0) => {
    if (value == null || depth > 2 || collectedChars > 12_000) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value).replace(/\s+/g, " ").trim();
      if (text) {
        const clipped = text.slice(0, Math.max(0, 12_000 - collectedChars));
        if (clipped) {
          parts.push(clipped);
          collectedChars += clipped.length;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) appendValue(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of [
        "path",
        "sourcePath",
        "displayName",
        "content",
        "message",
        "target",
        "title",
        "summary",
        "intentSummary",
        "evidence",
        "why",
        "next",
        "action",
        "contextItems",
        "attachedFiles",
        "images",
      ]) {
        appendValue(record[key], depth + 1);
      }
    }
  };

  for (const block of taskFlow) {
    if (block.turnId !== turn.id) continue;
    appendValue(block);
  }

  return parts.join("\n");
}

function turnSuggestsPlanExecutionResume(turn: ConversationTurn | null, taskFlow: TaskBlock[]): boolean {
  if (!turn) return false;
  const intent = resolveConversationTurnIntent(turn);
  const contextText = collectPlanResumeContextText(turn, taskFlow);
  if (looksLikeExistingPlanExecutionRequest(contextText)) return true;

  if (intent === "plan") {
    return isResumablePreviousTurnStatus(turn.status) && PLAN_EXECUTION_CONTEXT_RE.test(contextText);
  }

  return false;
}

export function findPlanExecutionResumeContinuationTarget(
  input: string,
  currentTurn: ConversationTurn | null,
  conversationTurns: ConversationTurn[],
  taskFlow: TaskBlock[],
): ConversationTurn | null {
  if (!looksLikePreviousTurnContinuationInput(input)) return null;
  if (currentTurn && turnSuggestsPlanExecutionResume(currentTurn, taskFlow)) return currentTurn;

  let inspected = 0;
  for (let index = conversationTurns.length - 1; index >= 0; index--) {
    const turn = conversationTurns[index];
    if (turn.id === currentTurn?.id) continue;
    inspected += 1;
    if (inspected > 4) break;
    if (turnSuggestsPlanExecutionResume(turn, taskFlow)) return turn;
  }

  return null;
}

export function resolvePendingReviewSubmissionDecision(input: {
  text: string;
  executionConsentGranted?: boolean;
  agentStatus: string;
  currentTurn: ConversationTurn | null;
  taskFlow: TaskBlock[];
}): SubmitPendingReviewDecision {
  const replyOptions = input.currentTurn
    ? input.taskFlow
        .filter((block): block is Extract<TaskBlock, { type: "agent" }> =>
          block.turnId === input.currentTurn!.id &&
          block.type === "agent" &&
          Array.isArray(block.options) &&
          block.options.length > 0,
        )
        .flatMap((block) => block.options || [])
    : [];
  const selectedReplyOption = findReplyOptionMatchingSelectedText(replyOptions, input.text);
  const isApprovalBypass =
    input.executionConsentGranted === true ||
    selectedReplyOption?.action === "execute_once" ||
    selectedReplyOption?.action === "approve_operation_once";
  return {
    selectedReplyOption,
    isApprovalBypass,
    shouldAbortAndStartNewTurn: input.agentStatus === "pending_review" && !isApprovalBypass,
  };
}

export function resolveSubmitTurnReuseDecision(input: {
  text: string;
  isHidden: boolean;
  createVisibleTurnForHiddenMessage?: boolean;
  options?: SubmitPipelineOptions;
  currentTurnId: string | null;
  currentSessionKey?: string | null;
  currentTurn: ConversationTurn | null;
  conversationTurns: ConversationTurn[];
  taskFlow: TaskBlock[];
  currentMainModeKey: MainModeKey;
  planArtifactsCount: number;
  planStage: PlanStage;
  isPlanApproved: boolean;
}): SubmitTurnReuseDecision {
  const currentTurnReplyOptionBlocks = input.currentTurn
    ? input.taskFlow.filter((block): block is Extract<TaskBlock, { type: "agent" }> =>
        block.turnId === input.currentTurn!.id &&
        block.type === "agent" &&
        Array.isArray(block.options) &&
        block.options.length > 0,
      )
    : [];
  const currentTurnHasReplyOptions = currentTurnReplyOptionBlocks.length > 0;
  const currentTurnIntent = resolveConversationTurnIntent(input.currentTurn);
  const hasPlanArtifacts = input.planArtifactsCount > 0 || input.planStage !== "idle";
  const hasApprovedOrExecutingPlanState =
    hasPlanArtifacts &&
    (input.isPlanApproved || input.planStage === "executing");
  const planExecutionResumeContinuationTarget =
    !input.isHidden && input.currentMainModeKey === "main_mode"
      ? findPlanExecutionResumeContinuationTarget(
          input.text,
          input.currentTurn,
          input.conversationTurns,
          input.taskFlow,
        )
      : null;
  const shouldRouteContinuationToPlanResume =
    !input.isHidden &&
    !input.options?.skipIntentResolution &&
    !input.options?.resolvedIntent &&
    looksLikePreviousTurnContinuationInput(input.text) &&
    (
      hasApprovedOrExecutingPlanState ||
      !!planExecutionResumeContinuationTarget
    );
  const shouldContinuePlanIntent =
    !input.isHidden &&
    !shouldRouteContinuationToPlanResume &&
    currentTurnIntent === "plan" &&
    looksLikePreviousTurnContinuationInput(input.text) &&
    (input.planStage !== "completed" || input.planArtifactsCount === 0);
  const shouldAllowPreviousTurnContinuation =
    !input.isHidden &&
    !shouldRouteContinuationToPlanResume &&
    !shouldContinuePlanIntent &&
    (
      input.currentMainModeKey === "main_mode" ||
      (input.currentMainModeKey === "game_studio" && (currentTurnIntent === "plan" || hasPlanArtifacts))
    );
  const previousTurnContinuationTarget =
    shouldAllowPreviousTurnContinuation
      ? findPreviousTurnContinuationTarget(
          input.text,
          input.currentTurn,
          input.conversationTurns,
          input.taskFlow,
        )
      : null;
  const shouldContinuePreviousTurnIntent = !!previousTurnContinuationTarget;
  const previousTurnContinuationIntent = previousTurnContinuationTarget
    ? resolveConversationTurnIntent(previousTurnContinuationTarget)
    : null;
  const submittedChoiceIdentity = input.options?.replyOptionRequestIdentity;
  const identityOwnedChoiceBlock = submittedChoiceIdentity
    ? currentTurnReplyOptionBlocks.find((block) =>
        isExactUserChoiceResolutionIdentity(block.choiceRequest, submittedChoiceIdentity)
      )
    : null;
  const choiceIdentityMatches = !!identityOwnedChoiceBlock && !!input.currentTurn &&
    isMatchingUserChoiceResolution({
      identity: identityOwnedChoiceBlock.choiceRequest,
      sessionKey: input.currentSessionKey || "",
      turnId: input.currentTurn.id,
      optionValue: input.options?.selectedReplyOptionText || input.text,
      isCustomReply: input.options?.replyOptionIsCustom === true,
    });
  const selectedAwaitingReplyOption = choiceIdentityMatches
    ? findReplyOptionMatchingSelectedText(
        identityOwnedChoiceBlock?.options || [],
        input.options?.selectedReplyOptionText || input.text,
      )
    : null;
  const shouldAutoResumeChoiceTurn =
    !input.isHidden &&
    input.options?.reuseCurrentTurn !== true &&
    !!input.currentTurn &&
    currentTurnHasReplyOptions &&
    choiceIdentityMatches &&
    !!selectedAwaitingReplyOption;
  const isExplicitChoiceSubmission = !!input.options?.replyOptionSourceTurnId || !!submittedChoiceIdentity;
  const shouldExplicitlyReuseCurrentTurn = input.options?.reuseCurrentTurn === true &&
    (!isExplicitChoiceSubmission || choiceIdentityMatches);
  const requestedReuseTurnId = String(input.options?.turnIdOverride || "").trim();
  const reusableTurnId = requestedReuseTurnId
    ? input.conversationTurns.some((turn) => turn.id === requestedReuseTurnId)
      ? requestedReuseTurnId
      : null
    : input.currentTurnId;
  const reuseCurrentTurn = shouldReuseLogicalTurnForSubmission({
    explicitReuse: shouldExplicitlyReuseCurrentTurn,
    exactChoiceMatch: shouldAutoResumeChoiceTurn,
  }) && !!reusableTurnId;
  const isInternalTurn = input.isHidden && !reuseCurrentTurn && input.createVisibleTurnForHiddenMessage !== true;
  const shouldReuseExistingTurnIntent =
    reuseCurrentTurn &&
    !!input.currentTurn &&
    (input.currentTurn.status === "awaiting_input" || currentTurnHasReplyOptions);
  const shouldExecuteOnceFromReplyOption =
    selectedAwaitingReplyOption?.action === "execute_once" ||
    selectedAwaitingReplyOption?.action === "approve_operation_once";
  const preservePlanState =
    input.options?.preservePlanState === true ||
    shouldContinuePlanIntent ||
    shouldContinuePreviousTurnIntent ||
    (shouldReuseExistingTurnIntent && currentTurnIntent === "plan") ||
    (shouldAutoResumeChoiceTurn && currentTurnIntent === "plan") ||
    looksLikePlanContinuationOrApprovalInput(input.text, {
      hasPlanArtifacts,
      planStage: input.planStage,
      isPlanApproved: input.isPlanApproved,
    });

  return {
    currentTurn: input.currentTurn,
    currentTurnReplyOptionBlocks,
    currentTurnHasReplyOptions,
    currentTurnIntent,
    hasPlanArtifacts,
    hasApprovedOrExecutingPlanState,
    planExecutionResumeContinuationTarget,
    shouldRouteContinuationToPlanResume,
    shouldContinuePlanIntent,
    shouldAllowPreviousTurnContinuation,
    previousTurnContinuationTarget,
    shouldContinuePreviousTurnIntent,
    previousTurnContinuationIntent,
    selectedAwaitingReplyOption,
    shouldAutoResumeChoiceTurn,
    shouldExplicitlyReuseCurrentTurn,
    reusableTurnId,
    reuseCurrentTurn,
    isInternalTurn,
    shouldReuseExistingTurnIntent,
    shouldExecuteOnceFromReplyOption,
    operationProposalChoiceAction: selectedAwaitingReplyOption?.action,
    preservePlanState,
  };
}

export function resolveSubmitPlanHydrationDecision(input: {
  text: string;
  isHidden: boolean;
  skipAutoPlanHydration?: boolean;
  currentWorkspace?: string | null;
  planArtifactsCount: number;
  planTasksCount: number;
  planStage: PlanStage;
  isPlanApproved: boolean;
  parsedStudioCommand: PendingSlashCommand | null;
}): SubmitPlanHydrationDecision {
  const hasRuntimePlanState =
    input.planArtifactsCount > 0 ||
    input.planTasksCount > 0 ||
    input.planStage !== "idle";
  const shouldAttempt =
    !input.isHidden &&
    input.skipAutoPlanHydration !== true &&
    !!String(input.currentWorkspace || "").trim();
  return {
    shouldAttempt,
    reason: shouldAttempt
      ? resolvePlanStateHydrationReason({
          text: input.text,
          hasPlanState: hasRuntimePlanState,
          hasContinuationState: input.isPlanApproved || input.planStage === "executing",
          slashCommand: input.parsedStudioCommand,
        })
      : null,
  };
}

export function resolveSubmitShortcutDecision(input: {
  text: string;
  isHidden: boolean;
  currentMainModeKey: MainModeKey;
  hasWorkspace?: boolean;
  lockedComposerIntent?: MainIntentShortcut | null;
  validatedVisibleGoalCreationAuthorization?: GoalCreationAuthorization | null;
  validatedQueuedGoalCreationAuthorization?: GoalCreationAuthorization | null;
  isQueuedReplay?: boolean;
}): SubmitShortcutDecision {
  const mainDebugShortcut = !input.isHidden && input.currentMainModeKey === "main_mode"
    ? parseMainDebugShortcut(input.text)
    : null;
  const textAfterDebug = mainDebugShortcut ? input.text : input.text;
  const mainIntentShortcut = !input.isHidden && !mainDebugShortcut
    ? parseMainIntentShortcutForMode(textAfterDebug, input.currentMainModeKey)
    : null;
  const textAfterIntentShortcut = mainIntentShortcut
    ? mainIntentShortcut.rest.trimStart()
    : textAfterDebug;
  const modeScopedLockedComposerIntent =
    input.lockedComposerIntent && isMainIntentShortcutAllowedInMainMode(input.lockedComposerIntent, input.currentMainModeKey)
      ? input.lockedComposerIntent
      : null;
  const directLockedComposerIntent = !input.isHidden && !mainDebugShortcut
    ? modeScopedLockedComposerIntent || mainIntentShortcut?.intent || null
    : null;
  // Raw /goal text is self-authenticating at the submit boundary. A capsule is
  // not: Store callers unrelated to the composer can observe the same global
  // lock, so capsule authority must arrive through the one-shot visible
  // envelope captured by the UI event.
  const directGoalCreationAuthorization =
    input.hasWorkspace !== false &&
    !input.isHidden &&
    !input.isQueuedReplay &&
    !mainDebugShortcut &&
    mainIntentShortcut?.intent === "goal" &&
    (!modeScopedLockedComposerIntent || modeScopedLockedComposerIntent === "goal")
      ? createGoalCreationAuthorization("visible_goal_shortcut")
      : null;
  const capturedVisibleGoalCreationAuthorization = input.hasWorkspace !== false &&
    !input.isHidden &&
    !input.isQueuedReplay &&
    isGoalCreationAuthorization(input.validatedVisibleGoalCreationAuthorization)
      ? input.validatedVisibleGoalCreationAuthorization
      : null;
  const replayedGoalCreationAuthorization = input.hasWorkspace !== false &&
    !input.isHidden &&
    isGoalCreationAuthorization(input.validatedQueuedGoalCreationAuthorization)
      ? input.validatedQueuedGoalCreationAuthorization
      : null;
  const carriedGoalCreationAuthorization =
    capturedVisibleGoalCreationAuthorization || replayedGoalCreationAuthorization;
  const lockedComposerIntent = directLockedComposerIntent ||
    (carriedGoalCreationAuthorization ? "goal" : null);
  const goalCreationAuthorization: GoalCreationAuthorization | null =
    directGoalCreationAuthorization || carriedGoalCreationAuthorization;
  return {
    mainDebugShortcut,
    mainIntentShortcut,
    lockedComposerIntent,
    goalCreationAuthorization,
    textAfterIntentShortcut,
  };
}

export function shouldConsiderSubmitGameStudioSuggestion(input: {
  isHidden: boolean;
  currentMainModeKey: MainModeKey;
  hasPendingRunDecision: boolean;
  hasMainDebugShortcut: boolean;
  hasMainIntentShortcut: boolean;
  hasLockedComposerIntent: boolean;
  skipIntentResolution?: boolean;
  resolvedIntent?: ResolvedRunIntent;
  shouldContinuePlanIntent: boolean;
  shouldContinuePreviousTurnIntent: boolean;
  shouldReuseExistingTurnIntent: boolean;
  suppressGameStudioSuggestion?: boolean;
  text: string;
  hasPlanArtifacts: boolean;
  planStage: PlanStage;
  isPlanApproved: boolean;
}): boolean {
  if (input.isHidden) return false;
  if (input.currentMainModeKey !== "main_mode") return false;
  if (input.hasPendingRunDecision) return false;
  if (input.hasMainDebugShortcut || input.hasMainIntentShortcut || input.hasLockedComposerIntent) return false;
  if (input.skipIntentResolution || input.resolvedIntent || input.suppressGameStudioSuggestion) return false;
  if (input.shouldContinuePlanIntent || input.shouldContinuePreviousTurnIntent || input.shouldReuseExistingTurnIntent) return false;
  if (looksLikePlanContinuationOrApprovalInput(input.text, {
    hasPlanArtifacts: input.hasPlanArtifacts,
    planStage: input.planStage,
    isPlanApproved: input.isPlanApproved,
  })) return false;
  return true;
}

export function resolveSubmitGameStudioModeSwitchDecision(input: {
  text: string;
  images?: string[];
  language: "zh" | "en";
  workspaceTreeForGameDetection?: string;
  createGameStudioModeSwitchDecision?: SubmitPipelineInput["createGameStudioModeSwitchDecision"];
  isHidden: boolean;
  currentMainModeKey: MainModeKey;
  hasPendingRunDecision: boolean;
  hasMainDebugShortcut: boolean;
  hasMainIntentShortcut: boolean;
  hasLockedComposerIntent: boolean;
  skipIntentResolution?: boolean;
  resolvedIntent?: ResolvedRunIntent;
  shouldContinuePlanIntent: boolean;
  shouldContinuePreviousTurnIntent: boolean;
  shouldReuseExistingTurnIntent: boolean;
  suppressGameStudioSuggestion?: boolean;
  hasPlanArtifacts: boolean;
  planStage: PlanStage;
  isPlanApproved: boolean;
}): SubmitGameStudioModeSwitchDecision {
  const shouldConsider = shouldConsiderSubmitGameStudioSuggestion(input);
  if (!shouldConsider) {
    return { shouldConsider, signal: null, pendingRunDecision: null };
  }
  const signal = detectGameDevelopmentIntent(input.text, {
    workspaceTree: input.workspaceTreeForGameDetection || "",
  });
  if (!signal.shouldSuggest || !input.createGameStudioModeSwitchDecision) {
    return { shouldConsider, signal, pendingRunDecision: null };
  }
  return {
    shouldConsider,
    signal,
    pendingRunDecision: input.createGameStudioModeSwitchDecision({
      input: input.text,
      images: input.images,
      language: input.language,
      signal,
    }),
  };
}

export function buildSubmitPipelineDecision(input: SubmitPipelineInput): SubmitPipelineDecision {
  const snapshot = input.snapshot;
  const options = input.options || {};
  const originalText = input.text;
  const isHidden = options.hidden === true;
  const createVisibleTurnForHiddenMessage = isHidden && options.createVisibleTurnForHiddenMessage === true;
  const currentTurn = snapshot.currentTurnId
    ? snapshot.conversationTurns.find((turn) => turn.id === snapshot.currentTurnId) || null
    : null;
  const pendingReview = resolvePendingReviewSubmissionDecision({
    text: input.text,
    executionConsentGranted: options.executionConsentGranted,
    agentStatus: snapshot.agentStatus,
    currentTurn,
    taskFlow: snapshot.taskFlow,
  });
  const turnReuse = resolveSubmitTurnReuseDecision({
    text: input.text,
    isHidden,
    createVisibleTurnForHiddenMessage,
    options,
    currentTurnId: snapshot.currentTurnId,
    currentSessionKey: snapshot.currentSessionKey,
    currentTurn,
    conversationTurns: snapshot.conversationTurns,
    taskFlow: snapshot.taskFlow,
    currentMainModeKey: snapshot.selectedMainModeKey,
    planArtifactsCount: snapshot.planArtifactsCount,
    planStage: snapshot.planStage,
    isPlanApproved: snapshot.isPlanApproved,
  });
  const parsedStudioCommand = snapshot.selectedMainModeKey === "game_studio"
    ? parseGameStudioSlashCommand(input.text)
    : null;
  const planHydration = resolveSubmitPlanHydrationDecision({
    text: input.text,
    isHidden,
    skipAutoPlanHydration: options.skipAutoPlanHydration,
    currentWorkspace: snapshot.currentWorkspace,
    planArtifactsCount: snapshot.planArtifactsCount,
    planTasksCount: snapshot.planTasksCount || 0,
    planStage: snapshot.planStage,
    isPlanApproved: snapshot.isPlanApproved,
    parsedStudioCommand,
  });
  const shortcuts = resolveSubmitShortcutDecision({
    text: input.text,
    isHidden,
    currentMainModeKey: snapshot.selectedMainModeKey,
    hasWorkspace:
      resolveSessionWorkspaceKey(snapshot.currentWorkspace) !== GLOBAL_CHAT_KEY,
    lockedComposerIntent: snapshot.lockedComposerIntent,
    validatedVisibleGoalCreationAuthorization: input.validatedVisibleGoalCreationAuthorization,
    validatedQueuedGoalCreationAuthorization: input.validatedQueuedGoalCreationAuthorization,
    isQueuedReplay: !!options.queuedUserMessageId,
  });
  const gameStudioModeSwitch = resolveSubmitGameStudioModeSwitchDecision({
    text: shortcuts.textAfterIntentShortcut,
    images: input.images,
    language: input.preferredLanguage || "zh",
    workspaceTreeForGameDetection: input.workspaceTreeForGameDetection,
    createGameStudioModeSwitchDecision: input.createGameStudioModeSwitchDecision,
    isHidden,
    currentMainModeKey: snapshot.selectedMainModeKey,
    hasPendingRunDecision: !!snapshot.pendingRunDecision,
    hasMainDebugShortcut: !!shortcuts.mainDebugShortcut,
    hasMainIntentShortcut: !!shortcuts.mainIntentShortcut,
    hasLockedComposerIntent: !!shortcuts.lockedComposerIntent,
    skipIntentResolution: options.skipIntentResolution,
    resolvedIntent: options.resolvedIntent,
    shouldContinuePlanIntent: turnReuse.shouldContinuePlanIntent,
    shouldContinuePreviousTurnIntent: turnReuse.shouldContinuePreviousTurnIntent,
    shouldReuseExistingTurnIntent: turnReuse.shouldReuseExistingTurnIntent,
    suppressGameStudioSuggestion: options.suppressGameStudioSuggestion,
    hasPlanArtifacts: turnReuse.hasPlanArtifacts,
    planStage: snapshot.planStage,
    isPlanApproved: snapshot.isPlanApproved,
  });
  const hasSupplementalInput =
    (snapshot.contextMentions?.length || 0) > 0 ||
    (snapshot.attachedFilesCount || 0) > 0;
  const routeKind: SubmitPipelineRouteKind =
    planHydration.reason
      ? "plan_hydration"
      : gameStudioModeSwitch.pendingRunDecision
      ? "mode_switch_decision"
      : "agent_loop";
  return {
    routeKind,
    text: shortcuts.textAfterIntentShortcut,
    originalText,
    isHidden,
    hasSupplementalInput,
    parsedStudioCommand,
    turnReuse,
    pendingReview,
    planHydration,
    shortcuts,
    gameStudioModeSwitch,
    effects: {
      ...(pendingReview.shouldAbortAndStartNewTurn ? { abortPendingReview: pendingReview } : {}),
      ...(gameStudioModeSwitch.pendingRunDecision ? { setPendingDecision: gameStudioModeSwitch.pendingRunDecision } : {}),
      ...(planHydration.reason ? { startAutoPlanHydration: planHydration.reason } : {}),
      ...(routeKind === "agent_loop" ? { launchAgentLoop: true } : {}),
    },
  };
}
