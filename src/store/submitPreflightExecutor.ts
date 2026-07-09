import type { IntentPreflightResult, MainIntentShortcut, PendingRunDecision } from "../lib/runIntent";
import type { MainModeKey } from "../lib/mainModes";
import {
  resolveSubmitPreflightEffectAction,
  type SubmitBlockingPreflightEffect,
  type SubmitPipelineOptions,
  type SubmitPreflightEffectAction,
  type SubmitPreflightResumeOptions,
} from "../lib/submit/turnSubmission";

export interface SubmitPreflightLatestSnapshot {
  input: string;
  selectedMainModeKey: MainModeKey;
  lockedComposerIntent?: MainIntentShortcut | null;
  isOriginSessionActive: boolean;
}

export interface SubmitBlockingPreflightStarterState {
  input: string;
  selectedMainModeKey: MainModeKey;
  lockedComposerIntent?: MainIntentShortcut | null;
  currentWorkspace?: string | null;
  currentSessionId?: number | null;
}

export interface SubmitBlockingPreflightExecutorInput<
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
> {
  effect: SubmitBlockingPreflightEffect<TConfig, TOptions>;
  runIntentPreflight: (
    request: SubmitBlockingPreflightEffect<TConfig, TOptions>["request"],
  ) => Promise<IntentPreflightResult | null>;
  getLatestSnapshot: (
    effect: SubmitBlockingPreflightEffect<TConfig, TOptions>,
  ) => SubmitPreflightLatestSnapshot;
  applyPendingRunDecision: (pendingRunDecision: PendingRunDecision) => void;
  resumeSubmission: (
    text: string,
    images: string[] | undefined,
    options: TOptions & SubmitPreflightResumeOptions,
  ) => void;
  logStoreEvent: (event: string, data: Record<string, unknown>) => void;
}

export async function executeSubmitBlockingPreflight<
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
>(
  input: SubmitBlockingPreflightExecutorInput<TConfig, TOptions>,
): Promise<SubmitPreflightEffectAction<TOptions>> {
  const preflight = await input.runIntentPreflight(input.effect.request);
  const latestSnapshot = input.getLatestSnapshot(input.effect);
  const action = resolveSubmitPreflightEffectAction({
    effect: input.effect,
    preflight,
    latestInput: latestSnapshot.input,
    latestMainModeKey: latestSnapshot.selectedMainModeKey,
    lockedComposerIntent: latestSnapshot.lockedComposerIntent,
    isOriginSessionActive: latestSnapshot.isOriginSessionActive,
  });

  if (action.kind === "stale_discard") {
    input.logStoreEvent("intent_preflight_stale_discarded", {
      originalChars: action.log.originalChars,
      latestChars: action.log.latestChars,
      selectedMainModeKey: action.log.selectedMainModeKey,
      hasLockedComposerIntent: action.log.hasLockedComposerIntent,
      hasExplicitShortcut: action.log.hasExplicitShortcut,
    });
    return action;
  }

  if (action.kind === "set_pending_decision") {
    input.applyPendingRunDecision(action.pendingRunDecision);
    return action;
  }

  if (action.kind === "skip_inactive_session") {
    input.logStoreEvent("send_async_resume_skipped_inactive_session", {
      phase: action.phase,
      sessionKey: action.sessionKey,
    });
    return action;
  }

  input.resumeSubmission(action.text, action.images, action.options);
  return action;
}

export interface StartSubmitBlockingPreflightEffectInput<
  TState extends SubmitBlockingPreflightStarterState,
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
> {
  effect: SubmitBlockingPreflightEffect<TConfig, TOptions>;
  runIntentPreflight: (
    request: SubmitBlockingPreflightEffect<TConfig, TOptions>["request"],
  ) => Promise<IntentPreflightResult | null>;
  getState: () => TState;
  isSessionRuntimeActive: (state: TState, sessionKey: string) => boolean;
  applyPreRunSessionPatch: (patch: { pendingRunDecision: PendingRunDecision }) => void;
  resumeSubmission: (
    text: string,
    images: string[] | undefined,
    options: TOptions & SubmitPreflightResumeOptions,
  ) => void;
  logStoreEvent: (event: string, data: Record<string, unknown>) => void;
}

export function startSubmitBlockingPreflightEffect<
  TState extends SubmitBlockingPreflightStarterState,
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
>(
  input: StartSubmitBlockingPreflightEffectInput<TState, TConfig, TOptions>,
): Promise<SubmitPreflightEffectAction<TOptions>> {
  return executeSubmitBlockingPreflight({
    effect: input.effect,
    runIntentPreflight: input.runIntentPreflight,
    getLatestSnapshot: (effect) => {
      const latestState = input.getState();
      return {
        input: latestState.input,
        selectedMainModeKey: latestState.selectedMainModeKey,
        lockedComposerIntent: latestState.lockedComposerIntent,
        isOriginSessionActive: effect.sendOriginSessionKey
          ? input.isSessionRuntimeActive(latestState, effect.sendOriginSessionKey)
          : true,
      };
    },
    applyPendingRunDecision: (pendingRunDecision) => {
      input.applyPreRunSessionPatch({ pendingRunDecision });
    },
    resumeSubmission: input.resumeSubmission,
    logStoreEvent: input.logStoreEvent,
  });
}
