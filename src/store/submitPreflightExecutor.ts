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
  concludeWithoutExecution?: (action: Extract<SubmitPreflightEffectAction<TOptions>, { kind: "conclude_without_execution" }>) => void;
}

export async function executeSubmitBlockingPreflight<
  TConfig extends object,
  TOptions extends SubmitPipelineOptions = SubmitPipelineOptions,
>(
  input: SubmitBlockingPreflightExecutorInput<TConfig, TOptions>,
): Promise<SubmitPreflightEffectAction<TOptions>> {
  const preflight = await input.runIntentPreflight(input.effect.request).catch(() => null);
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

  if (action.kind === "conclude_without_execution") {
    if (input.claimResume && !input.claimResume()) {
      return { kind: "skip_inactive_session", phase: "intent_preflight", sessionKey: input.effect.sendOriginSessionKey || "" };
    }
    input.logStoreEvent("intent_preflight_concluded_without_execution", {
      resultKind: action.resultKind,
      turnId: input.effect.originalOptions?.workspaceInstructionClaim?.turnId ?? null,
    });
    input.concludeWithoutExecution?.(action);
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
  ) => boolean;
  onWorkspaceResumeAccepted?: (options: TOptions & SubmitPreflightResumeOptions) => boolean;
  onWorkspaceResumeRejected?: (options: TOptions & SubmitPreflightResumeOptions) => void;
  concludeWithoutExecution?: (action: Extract<SubmitPreflightEffectAction<TOptions>, { kind: "conclude_without_execution" }>) => void;
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
    concludeWithoutExecution: input.concludeWithoutExecution,
    resumeSubmission: (text, images, options) => {
      const accepted = input.resumeSubmission(text, images, options);
      // Reuse the dispatcher's synchronous adoption handoff before any queued
      // UI drain can mistake an asynchronous bootstrap for a stale executor.
      if (workspace && !(accepted && input.onWorkspaceResumeAccepted?.(options))) {
        input.onWorkspaceResumeRejected?.(options);
      }
    },
    logStoreEvent: input.logStoreEvent,
  }).then((action) => {
    if (workspace && action.kind !== "resume") {
      const released = settle("release");
      const claim = input.effect.originalOptions?.workspaceInstructionClaim;
      if (released && action.kind === "stale_discard" && claim &&
        input.isSessionRuntimeActive(input.getState(), claim.sessionKey)) input.closeTurnAsCanceled?.(claim.turnId);
      // Even if cancellation already cleared the controller, its exact queue
      // claim still needs the canonical dispatcher to observe the terminal
      // transaction. That dispatcher owns waiting for cancellation and removal.
      const current = input.getState();
      if (claim && input.isSessionRuntimeActive(current, claim.sessionKey) &&
        isWorkspaceInstructionDispatchClaimCurrent(current.workspaceTurnQueue, input.effect.originalOptions)) {
        input.redispatchWorkspaceInstruction?.(claim.sessionKey);
      }
    }
    return action;
  });
}
