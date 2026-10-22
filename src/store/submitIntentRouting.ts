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
  resolveSubmitEffectiveIntentDecision,
  type SubmitBlockingPreflightEffect,
  type SubmitEffectiveIntentInput,
  type GoalCreationAuthorization,
  type GoalContinuationAuthorization,
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
  submittedText?: string;
  currentMainModeKey: MainModeKey;
  hasWorkspace: boolean;
  isHidden: boolean;
  autoApproveTools: boolean;
  fallbackRunIntent: ResolvedRunIntent;
  mainDebugShortcut: SubmitEffectiveIntentInput["mainDebugShortcut"];
  mainIntentShortcut: SubmitEffectiveIntentInput["mainIntentShortcut"];
  lockedComposerIntent: SubmitEffectiveIntentInput["lockedComposerIntent"];
  goalCreationAuthorization: GoalCreationAuthorization | null;
  goalContinuationAuthorization: GoalContinuationAuthorization | null;
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
      goalCreationAuthorization: GoalCreationAuthorization | null;
    };

/**
 * Semantic intent describes the work and required capabilities. The existing
 * application contract owns authority; operation metadata cannot approve it.
 * An explicit execution choice remains a separate user authorization.
 */
export function resolveWorkspaceTurnRuntimeIntent(input: {
  hasWorkspace: boolean;
  currentMainModeKey: MainModeKey;
  shouldExecuteOnceFromReplyOption: boolean;
  resolution: RunIntentResolution;
}): ResolvedRunIntent {
  if (
    input.hasWorkspace &&
    input.shouldExecuteOnceFromReplyOption &&
    (input.resolution.intent === "respond" ||
      input.resolution.intent === "discuss" ||
      input.resolution.intent === "analyze")
  ) {
    return "execute";
  }
  return input.resolution.intent;
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
    isHidden: input.isHidden,
    autoApproveTools: input.autoApproveTools,
    fallbackRunIntent: input.fallbackRunIntent,
    mainDebugShortcut: input.mainDebugShortcut,
    mainIntentShortcut: input.mainIntentShortcut,
    lockedComposerIntent: input.lockedComposerIntent,
    goalCreationAuthorization: input.goalCreationAuthorization,
    goalContinuationAuthorization: input.goalContinuationAuthorization,
    currentTurn: input.currentTurn,
    currentTurnIntent: input.currentTurnIntent,
    shouldContinuePlanIntent: input.shouldContinuePlanIntent,
    shouldContinuePreviousTurnIntent: input.shouldContinuePreviousTurnIntent,
    previousTurnContinuationTarget: input.previousTurnContinuationTarget,
    previousTurnContinuationIntent: input.previousTurnContinuationIntent,
    shouldReuseExistingTurnIntent: input.shouldReuseExistingTurnIntent,
    shouldExecuteOnceFromReplyOption: input.shouldExecuteOnceFromReplyOption,
  });
  const effectiveRunIntent = initialIntentDecision.effectiveRunIntent;
  let effectiveIntentSummary = initialIntentDecision.effectiveIntentSummary;
  let effectiveCommandDirective = initialIntentDecision.effectiveCommandDirective;

  // Deterministic control stays with explicit modes and trusted resumptions.
  // Every new natural-language request is interpreted once, including a short
  // continuation: lexical matches may supply relevant context, never authority.
  const trustedSubmission = input.isHidden || !!input.mainDebugShortcut ||
    input.lockedComposerIntent === "image_studio" || input.mainIntentShortcut?.intent === "image_studio" ||
    input.options?.skipIntentResolution === true || !!input.options?.resolvedIntent ||
    input.shouldExecuteOnceFromReplyOption || !!input.goalCreationAuthorization ||
    !!input.goalContinuationAuthorization;
  if (input.currentMainModeKey === "main_mode" && !trustedSubmission) {
    const resolution = resolveTurnRunIntent(input.text, {
      language: input.preferredLanguage,
      mainModeKey: input.currentMainModeKey,
      hasWorkspace: input.hasWorkspace,
      hasPlanArtifacts: input.hasPlanArtifacts,
      planStage: input.planStage,
      isPlanApproved: input.isPlanApproved,
      previousTurnIntent: input.currentTurnIntent,
    });
    const previousRequest = input.shouldContinuePreviousTurnIntent
      ? input.previousTurnContinuationTarget?.userPrompt
      : input.shouldContinuePlanIntent || input.shouldReuseExistingTurnIntent || input.shouldRouteContinuationToPlanResume
      ? input.currentTurn?.userPrompt
      : undefined;
    const blockingPreflightEffect = buildSubmitBlockingPreflightEffect({
      resolution,
      currentMainModeKey: input.currentMainModeKey,
      hasWorkspace: input.hasWorkspace,
      explicitIntent: input.options?.explicitIntent || input.lockedComposerIntent || input.mainIntentShortcut?.intent || undefined,
      previousRequest,
      text: input.text,
      originalComposerInput: input.submittedText,
      images: input.images,
      options: input.options,
      preferredLanguage: input.preferredLanguage,
      currentConfig: input.currentConfig,
      sendOriginSessionKey: input.sendOriginSessionKey,
    });
    if (blockingPreflightEffect) {
      input.logStoreEvent("turn_intent_semantic_requested", {
        heuristicHint: resolution.intent,
        heuristicConfidence: resolution.confidence,
        explicitIntent: blockingPreflightEffect.request.explicitIntent ?? null,
        hasPreviousRequest: !!previousRequest,
        inputChars: input.text.length,
      });
      input.startBlockingPreflight(blockingPreflightEffect);
      return { handled: true, returnValue: true };
    }
  }

  const shouldInferCommandDirective = !(
    input.isHidden &&
    input.options?.skipIntentResolution === true
  );
  if (!effectiveCommandDirective && shouldInferCommandDirective) {
    effectiveCommandDirective = inferCommandDirective(input.text, effectiveRunIntent, {
      source: input.mainIntentShortcut ? "main_shortcut" : "natural_language",
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
    goalCreationAuthorization: effectiveRunIntent === "goal"
      ? input.goalCreationAuthorization
      : null,
  };
}
