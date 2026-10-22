import type { IntentPreflightResult, MainIntentShortcut, PendingRunDecision } from "../lib/runIntent";
import type { MainModeKey } from "../lib/mainModes";
import { isWorkspaceInstructionDispatchClaimCurrent } from "./workspaceTurnQueue";
import { beginSubmitWorkspacePreflight, isSubmitWorkspacePreflightLive, settleSubmitWorkspacePreflight,
  type SubmitWorkspacePreflightStore } from "./submitWorkspacePreflight";
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
  isOriginOwnerCurrent?: boolean;
}

export interface SubmitBlockingPreflightStarterState extends SubmitWorkspacePreflightStore {
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
  claimResume?: () => boolean;
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
    isOriginOwnerCurrent: latestSnapshot.isOriginOwnerCurrent,
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

  if (input.claimResume && !input.claimResume()) {
    return { kind: "skip_inactive_session", phase: "intent_preflight", sessionKey: input.effect.sendOriginSessionKey || "" };
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
  setState?: (updater: (state: TState) => Partial<TState>) => void;
  isSessionRuntimeActive: (state: TState, sessionKey: string) => boolean;
  applyPreRunSessionPatch: (patch: { pendingRunDecision: PendingRunDecision }) => void;
  resumeSubmission: (
    text: string,
    images: string[] | undefined,
    options: TOptions & SubmitPreflightResumeOptions,
  ) => void;
  logStoreEvent: (event: string, data: Record<string, unknown>) => void;
  closeTurnAsCanceled?: (turnId: string) => void;
  redispatchWorkspaceInstruction?: (sessionKey: string) => void;
}

export function startSubmitBlockingPreflightEffect<
  TState extends SubmitBlockingPreflightStarterState,
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
>(
  input: StartSubmitBlockingPreflightEffectInput<TState, TConfig, TOptions>,
): Promise<SubmitPreflightEffectAction<TOptions>> {
  const workspace = input.effect.request.hasWorkspace === true;
  const controller = workspace && input.setState
    ? beginSubmitWorkspacePreflight({ ...input, setState: input.setState }) : null;
  if (workspace && !controller) {
    return Promise.resolve({ kind: "skip_inactive_session", phase: "intent_preflight", sessionKey: input.effect.sendOriginSessionKey || "" });
  }
  const settle = (disposition: "resume" | "release") => !!controller && !!input.setState &&
    settleSubmitWorkspacePreflight({ ...input, setState: input.setState, controller, disposition });
  return executeSubmitBlockingPreflight({
    effect: input.effect,
    runIntentPreflight: (request) => input.runIntentPreflight(controller ? { ...request, signal: controller.signal } : request),
    getLatestSnapshot: (effect) => {
      const latestState = input.getState();
      const claim = effect.originalOptions?.workspaceInstructionClaim;
      const isOriginOwnerCurrent = !effect.request.hasWorkspace || (
        isWorkspaceInstructionDispatchClaimCurrent(latestState.workspaceTurnQueue, effect.originalOptions) &&
        !!claim &&
        latestState.abortController === controller && isSubmitWorkspacePreflightLive(latestState)
      );
      return {
        input: latestState.input,
        selectedMainModeKey: latestState.selectedMainModeKey,
        lockedComposerIntent: latestState.lockedComposerIntent,
        isOriginSessionActive: effect.sendOriginSessionKey
          ? input.isSessionRuntimeActive(latestState, effect.sendOriginSessionKey)
          : true,
        isOriginOwnerCurrent,
      };
    },
    applyPendingRunDecision: (pendingRunDecision) => {
      input.applyPreRunSessionPatch({ pendingRunDecision });
    },
    claimResume: workspace ? () => settle("resume") : undefined,
    resumeSubmission: (text, images, options) => {
      input.resumeSubmission(text, images, options);
      if (workspace && input.effect.sendOriginSessionKey) input.redispatchWorkspaceInstruction?.(input.effect.sendOriginSessionKey);
    },
    logStoreEvent: input.logStoreEvent,
  }).then((action) => {
    if (workspace && action.kind !== "resume" && settle("release")) {
      const claim = input.effect.originalOptions?.workspaceInstructionClaim;
      if (action.kind === "stale_discard" && claim &&
        input.isSessionRuntimeActive(input.getState(), claim.sessionKey)) input.closeTurnAsCanceled?.(claim.turnId);
      if (input.effect.sendOriginSessionKey) input.redispatchWorkspaceInstruction?.(input.effect.sendOriginSessionKey);
    }
    return action;
  });
}
