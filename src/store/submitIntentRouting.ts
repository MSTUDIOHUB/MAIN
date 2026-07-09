import type { PendingSlashCommand } from "../lib/gameStudioCatalog";
import type { MainModeKey } from "../lib/mainModes";
import {
  inferCommandDirective,
  resolveTurnRunIntent,
  type CommandDirective,
  type ResolvedRunIntent,
  type RunIntentResolution,
} from "../lib/runIntent";
import {
  buildRunIntentSummary,
  buildSubmitBlockingPreflightEffect,
  buildSubmitIntentConfirmationPendingDecision,
  resolveSubmitEffectiveIntentDecision,
  resolveSubmitExecutionApprovalDecision,
  type SubmitBlockingPreflightEffect,
  type SubmitEffectiveIntentInput,
  type SubmitPipelineOptions,
} from "../lib/submit/turnSubmission";
import type { PlanStage } from "../lib/workflowModels";

export interface SubmitIntentRoutingPlanResumeRequest {
  text: string;
  images?: string[];
  preferredLanguage: "zh" | "en";
  shouldRouteContinuationToPlanResume: boolean;
  uiParentTurnId?: string;
  commandDirective: CommandDirective | null | undefined;
}

export interface SubmitIntentRoutingInput<
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
> {
  text: string;
  images?: string[];
  preferredLanguage: "zh" | "en";
  options?: TOptions;
  currentMainModeKey: MainModeKey;
  parsedStudioCommand: PendingSlashCommand | null;
  isHidden: boolean;
  autoApproveTools: boolean;
  fallbackRunIntent: ResolvedRunIntent;
  mainDebugShortcut: SubmitEffectiveIntentInput["mainDebugShortcut"];
  mainIntentShortcut: SubmitEffectiveIntentInput["mainIntentShortcut"];
  lockedComposerIntent: SubmitEffectiveIntentInput["lockedComposerIntent"];
  currentTurn: SubmitEffectiveIntentInput["currentTurn"];
  currentTurnIntent: ResolvedRunIntent;
  hasPlanArtifacts: boolean;
  shouldContinuePlanIntent: boolean;
  shouldContinuePreviousTurnIntent: boolean;
  previousTurnContinuationTarget: SubmitEffectiveIntentInput["previousTurnContinuationTarget"];
  previousTurnContinuationIntent: ResolvedRunIntent | null;
  shouldReuseExistingTurnIntent: boolean;
  shouldExecuteOnceFromReplyOption: boolean;
  shouldRouteContinuationToPlanResume: boolean;
  planExecutionResumeContinuationTarget: { id: string } | null;
  planStage: PlanStage;
  isPlanApproved: boolean;
  currentTurnId: string | null;
  isLocalFastStudioCommand: boolean;
  unitySetupEngineSelected?: boolean;
  dismissedPendingDecisionInputKey?: string | null;
  currentConfig: TConfig;
  sendOriginSessionKey: string | null;
  setState: (patch: { dismissedPendingDecisionInputKey: null }) => void;
  applyPreRunSessionPatch: (patch: Record<string, unknown>) => void;
  approvePlan: () => void;
  startPlanExecutionResume: (request: SubmitIntentRoutingPlanResumeRequest) => void;
  startBlockingPreflight: (
    effect: SubmitBlockingPreflightEffect<TConfig, TOptions>,
  ) => void;
  logStoreEvent: (event: string, data: Record<string, unknown>) => void;
}

export type SubmitIntentRoutingResult =
  | {
      handled: true;
      returnValue: boolean;
    }
  | {
      handled: false;
      effectiveRunIntent: ResolvedRunIntent;
      effectiveIntentSummary: string;
      effectiveCommandDirective: CommandDirective | null;
      shouldForceExecuteForAutoApprove: boolean;
    };

function looksLikeExecutionIntent(params: {
  shouldExecuteOnceFromReplyOption: boolean;
  resolution: RunIntentResolution;
}): boolean {
  const { resolution } = params;
  return (
    params.shouldExecuteOnceFromReplyOption ||
    resolution.intent === "execute" ||
    resolution.intent === "studio_workflow" ||
    resolution.commandDirective?.kind === "file_modify" ||
    resolution.commandDirective?.kind === "shell" ||
    resolution.commandDirective?.kind === "git" ||
    resolution.commandDirective?.kind === "unity"
  );
}

function normalizeSubmitPendingDecisionInputKey(input: string): string {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildPlanResumeResolution(input: {
  text: string;
  preferredLanguage: "zh" | "en";
}): RunIntentResolution {
  return {
    intent: "plan",
    reason: input.preferredLanguage === "en"
      ? "Continuation input is attached to an approved/executing or recently misrouted plan context, so MAIN resumes plan execution instead of ordinary chat."
      : "短继续指令关联到已批准/执行中计划或上一轮误路由的计划上下文，因此恢复计划执行而不是普通聊天续跑。",
    confidence: 0.95,
    bypassMainRouter: false,
    riskLevel: "low",
    controlAction: "resume_plan_execution",
    commandDirective: inferCommandDirective(input.text, "plan", {
      source: "continuation",
      controlAction: "resume_plan_execution",
    }),
  };
}

export function resolveAndApplySubmitIntentRouting<
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
>(
  input: SubmitIntentRoutingInput<TConfig, TOptions>,
): SubmitIntentRoutingResult {
  const initialIntentDecision = resolveSubmitEffectiveIntentDecision({
    text: input.text,
    preferredLanguage: input.preferredLanguage,
    options: input.options,
    currentMainModeKey: input.currentMainModeKey,
    parsedStudioCommand: input.parsedStudioCommand,
    isHidden: input.isHidden,
    autoApproveTools: input.autoApproveTools,
    fallbackRunIntent: input.fallbackRunIntent,
    mainDebugShortcut: input.mainDebugShortcut,
    mainIntentShortcut: input.mainIntentShortcut,
    lockedComposerIntent: input.lockedComposerIntent,
    currentTurn: input.currentTurn,
    currentTurnIntent: input.currentTurnIntent,
    shouldContinuePlanIntent: input.shouldContinuePlanIntent,
    shouldContinuePreviousTurnIntent: input.shouldContinuePreviousTurnIntent,
    previousTurnContinuationTarget: input.previousTurnContinuationTarget,
    previousTurnContinuationIntent: input.previousTurnContinuationIntent,
    shouldReuseExistingTurnIntent: input.shouldReuseExistingTurnIntent,
    shouldExecuteOnceFromReplyOption: input.shouldExecuteOnceFromReplyOption,
    unitySetupEngineSelected: input.unitySetupEngineSelected,
  });
  let effectiveRunIntent = initialIntentDecision.effectiveRunIntent;
  let effectiveIntentSummary = initialIntentDecision.effectiveIntentSummary;
  let effectiveCommandDirective = initialIntentDecision.effectiveCommandDirective;
  const shouldForceExecuteForAutoApprove =
    initialIntentDecision.shouldForceExecuteForAutoApprove;

  const normalizedPendingDecisionInputKey = normalizeSubmitPendingDecisionInputKey(input.text);
  const shouldSuppressSameInputDecision =
    !input.isHidden &&
    normalizedPendingDecisionInputKey.length > 0 &&
    input.dismissedPendingDecisionInputKey === normalizedPendingDecisionInputKey;
  let decisionSuppressionConsumed = false;
  const consumeDecisionSuppression = () => {
    if (!shouldSuppressSameInputDecision || decisionSuppressionConsumed) return false;
    decisionSuppressionConsumed = true;
    input.setState({ dismissedPendingDecisionInputKey: null });
    return true;
  };

  const applyDecisionSuppressedFallback = (
    source: "reuse_resolution" | "resolution",
    reason: string,
  ) => {
    effectiveRunIntent = "respond";
    effectiveIntentSummary = buildRunIntentSummary({
      input: input.text,
      intent: "respond",
      language: input.preferredLanguage,
      reason,
    });
    effectiveCommandDirective = inferCommandDirective(input.text, "respond", {
      source: source === "reuse_resolution" ? "continuation" : "natural_language",
    });
    input.logStoreEvent("intent_decision_suppressed_for_same_input", {
      source,
      inputChars: input.text.trim().length,
    });
  };

  const shouldReevaluateReuseTurnIntent =
    !input.isHidden &&
    input.shouldReuseExistingTurnIntent &&
    !input.mainDebugShortcut &&
    !input.lockedComposerIntent &&
    !input.shouldContinuePlanIntent &&
    !input.shouldContinuePreviousTurnIntent &&
    !input.options?.skipIntentResolution &&
    !input.options?.resolvedIntent;

  if (shouldReevaluateReuseTurnIntent) {
    const reuseResolution = resolveTurnRunIntent(input.text, {
      language: input.preferredLanguage,
      mainModeKey: input.currentMainModeKey,
      parsedStudioCommand: input.parsedStudioCommand,
      hasPlanArtifacts: input.hasPlanArtifacts,
      planStage: input.planStage,
      isPlanApproved: input.isPlanApproved,
      previousTurnIntent: input.currentTurnIntent,
    });
    const reuseLooksLikeExecutionIntent = looksLikeExecutionIntent({
      shouldExecuteOnceFromReplyOption: input.shouldExecuteOnceFromReplyOption,
      resolution: reuseResolution,
    });
    const shouldRequestPlanDecision =
      reuseResolution.needsDecision === true ||
      (reuseLooksLikeExecutionIntent &&
        (reuseResolution.riskLevel === "high" || reuseResolution.intent === "plan"));

    if (shouldRequestPlanDecision) {
      if (consumeDecisionSuppression()) {
        applyDecisionSuppressedFallback(
          "reuse_resolution",
          input.preferredLanguage === "en"
            ? "You ignored the same intent decision for this draft, so this turn continues as a natural reply without showing the popup again."
            : "你刚刚忽略了同一草稿的意图确认，本轮先按自然回复继续，不再重复弹窗。",
        );
      } else {
        input.applyPreRunSessionPatch({
          pendingRunDecision: buildSubmitIntentConfirmationPendingDecision({
            text: input.text,
            images: input.images,
            preferredLanguage: input.preferredLanguage,
            decision: {
              suggestedIntent: "plan",
              decisionOptions: ["plan", "respond", "execute"],
              riskLevel: reuseResolution.riskLevel,
              reason: reuseResolution.reason,
            },
          }),
        });
        return { handled: true, returnValue: true };
      }
    }

    if (
      reuseLooksLikeExecutionIntent &&
      (reuseResolution.intent === "execute" || reuseResolution.intent === "studio_workflow")
    ) {
      effectiveRunIntent = reuseResolution.intent;
      effectiveCommandDirective =
        reuseResolution.commandDirective ||
        effectiveCommandDirective ||
        inferCommandDirective(input.text, reuseResolution.intent, { source: "continuation" });
      effectiveIntentSummary = buildRunIntentSummary({
        input: input.text,
        intent: reuseResolution.intent,
        language: input.preferredLanguage,
        reason: input.preferredLanguage === "en"
          ? "The user selected a fix/implement continuation option, so this reused turn is auto-upgraded to execution."
          : "用户在复用回合中选择了修复/实现型选项，本轮自动升级为执行模式。",
      });
    }
  }

  if (
    !input.isHidden &&
    !input.mainDebugShortcut &&
    !input.lockedComposerIntent &&
    !input.shouldContinuePlanIntent &&
    !input.shouldContinuePreviousTurnIntent &&
    !input.shouldReuseExistingTurnIntent &&
    !shouldForceExecuteForAutoApprove &&
    !input.options?.skipIntentResolution &&
    !input.options?.resolvedIntent
  ) {
    const resolution: RunIntentResolution = input.shouldRouteContinuationToPlanResume
      ? buildPlanResumeResolution({
          text: input.text,
          preferredLanguage: input.preferredLanguage,
        })
      : resolveTurnRunIntent(input.text, {
          language: input.preferredLanguage,
          mainModeKey: input.currentMainModeKey,
          parsedStudioCommand: input.parsedStudioCommand,
          hasPlanArtifacts: input.hasPlanArtifacts,
          planStage: input.planStage,
          isPlanApproved: input.isPlanApproved,
          previousTurnIntent: input.currentTurnIntent,
        });
    effectiveIntentSummary = buildRunIntentSummary({
      input: input.text,
      intent: resolution.intent,
      language: input.preferredLanguage,
      reason: resolution.reason,
    });
    effectiveCommandDirective =
      resolution.commandDirective || inferCommandDirective(input.text, resolution.intent);

    if (resolution.controlAction === "approve_plan") {
      input.applyPreRunSessionPatch({
        input: "",
        contextMentions: [],
        attachedFiles: [],
        lockedComposerIntent: null,
        pendingRunDecision: null,
      });
      input.approvePlan();
      return { handled: true, returnValue: true };
    }

    if (resolution.controlAction === "resume_plan_execution") {
      input.startPlanExecutionResume({
        text: input.text,
        images: input.images,
        preferredLanguage: input.preferredLanguage,
        shouldRouteContinuationToPlanResume: input.shouldRouteContinuationToPlanResume,
        uiParentTurnId:
          input.planExecutionResumeContinuationTarget?.id ||
          input.currentTurnId ||
          undefined,
        commandDirective:
          resolution.commandDirective ||
          inferCommandDirective(input.text, "plan", {
            source: "continuation",
            controlAction: "resume_plan_execution",
          }),
      });
      return { handled: true, returnValue: true };
    }

    if (resolution.needsDecision) {
      if (consumeDecisionSuppression()) {
        applyDecisionSuppressedFallback(
          "resolution",
          input.preferredLanguage === "en"
            ? "You ignored the same intent decision for this draft, so this turn continues as a natural reply without showing the popup again."
            : "你刚刚忽略了同一草稿的意图确认，本轮先按自然回复继续，不再重复弹窗。",
        );
      } else {
        input.applyPreRunSessionPatch({
          pendingRunDecision: buildSubmitIntentConfirmationPendingDecision({
            text: input.text,
            images: input.images,
            preferredLanguage: input.preferredLanguage,
            decision: resolution,
            suggestedIntentFallback: "plan",
          }),
        });
        return { handled: true, returnValue: true };
      }
    }

    const executionApprovalDecision = resolveSubmitExecutionApprovalDecision({
      text: input.text,
      images: input.images,
      preferredLanguage: input.preferredLanguage,
      resolution,
      effectiveCommandDirective,
      isLocalFastStudioCommand: input.isLocalFastStudioCommand,
    });
    if (executionApprovalDecision.pendingRunDecision) {
      input.applyPreRunSessionPatch({
        pendingRunDecision: executionApprovalDecision.pendingRunDecision,
      });
      return { handled: true, returnValue: true };
    }

    const blockingPreflightEffect = buildSubmitBlockingPreflightEffect({
      resolution,
      currentMainModeKey: input.currentMainModeKey,
      text: input.text,
      images: input.images,
      options: input.options,
      preferredLanguage: input.preferredLanguage,
      currentConfig: input.currentConfig,
      sendOriginSessionKey: input.sendOriginSessionKey,
    });
    if (blockingPreflightEffect) {
      input.startBlockingPreflight(blockingPreflightEffect);
      return { handled: true, returnValue: true };
    }

    effectiveRunIntent = resolution.intent;
  }

  if (!effectiveCommandDirective) {
    effectiveCommandDirective = inferCommandDirective(input.text, effectiveRunIntent, {
      source: input.mainIntentShortcut
        ? "main_shortcut"
        : input.parsedStudioCommand?.type === "workflow"
        ? "studio_slash"
        : "natural_language",
      parsedStudioCommand: input.parsedStudioCommand,
    });
  }

  if (!effectiveIntentSummary) {
    effectiveIntentSummary = buildRunIntentSummary({
      input: input.text,
      intent: effectiveRunIntent,
      language: input.preferredLanguage,
    });
  }

  return {
    handled: false,
    effectiveRunIntent,
    effectiveIntentSummary,
    effectiveCommandDirective,
    shouldForceExecuteForAutoApprove,
  };
}
