import type { WorkspaceTurnQueueState } from "../lib/workspaceInstruction";
import type { SubmitPipelineOptions } from "../lib/submit/turnSubmission";
import { getPendingSessionCancellation, hasCanceledTurnTerminalProjection } from "./sessionCancellationBarrier";
import { isWorkspaceInstructionDispatchClaimCurrent, reduceWorkspaceTurnQueue } from "./workspaceTurnQueue";

export interface SubmitWorkspacePreflightRuntime {
  workspaceTurnQueue?: WorkspaceTurnQueueState | null;
  currentTurnId?: string | null;
  abortController?: AbortController | null;
  isGenerating?: boolean;
  agentStatus?: string;
  runtimeEvents?: Parameters<typeof hasCanceledTurnTerminalProjection>[0]["runtimeEvents"];
  taskFlow?: Parameters<typeof hasCanceledTurnTerminalProjection>[0]["taskFlow"];
}

export interface SubmitWorkspacePreflightStore extends SubmitWorkspacePreflightRuntime {
  input?: string;
  runtimeBySessionKey?: Record<string, SubmitWorkspacePreflightRuntime>;
}

interface WorkspacePreflightEffect {
  originalOptions?: SubmitPipelineOptions;
  sendOriginSessionKey: string | null;
}

export function isSubmitWorkspacePreflightLive(runtime: SubmitWorkspacePreflightRuntime): boolean {
  const head = runtime.workspaceTurnQueue?.entries[0];
  return head?.status === "dispatching" && head.claim?.phase === "intent_preflight" &&
    runtime.currentTurnId === head.receipt.turnId && !!runtime.abortController &&
    !runtime.abortController.signal.aborted &&
    !getPendingSessionCancellation(head.receipt.sessionKey) &&
    !hasCanceledTurnTerminalProjection({
      sessionKey: head.receipt.sessionKey, turnId: head.receipt.turnId,
      runtimeEvents: runtime.runtimeEvents || [], taskFlow: runtime.taskFlow || [],
    });
}

function isPreflightCanceled(runtime: SubmitWorkspacePreflightRuntime, sessionKey: string, turnId: string): boolean {
  return !!getPendingSessionCancellation(sessionKey) || hasCanceledTurnTerminalProjection({
    sessionKey, turnId, runtimeEvents: runtime.runtimeEvents || [], taskFlow: runtime.taskFlow || [],
  });
}

export function beginSubmitWorkspacePreflight<TState extends SubmitWorkspacePreflightStore>(input: {
  effect: WorkspacePreflightEffect;
  getState: () => TState;
  setState: (updater: (state: TState) => Partial<TState>) => void;
  isSessionRuntimeActive: (state: TState, sessionKey: string) => boolean;
}): AbortController | null {
  const claim = input.effect.originalOptions?.workspaceInstructionClaim;
  if (!claim) return null;
  const controller = new AbortController();
  let started = false;
  input.setState((state) => {
    if (!input.isSessionRuntimeActive(state, claim.sessionKey) ||
      !isWorkspaceInstructionDispatchClaimCurrent(state.workspaceTurnQueue, input.effect.originalOptions) ||
      state.isGenerating || state.abortController || isPreflightCanceled(state, claim.sessionKey, claim.turnId)) return {};
    const queue = state.workspaceTurnQueue!;
    const transition = reduceWorkspaceTurnQueue(queue, {
      type: "set_dispatch_phase", expectedVersion: queue.version, at: Date.now(),
      claimId: claim.claimId, sessionKey: claim.sessionKey, sessionEpoch: claim.sessionEpoch,
      fromPhase: "dispatch", phase: "intent_preflight",
    });
    if (transition.disposition !== "applied") return {};
    started = true;
    return { workspaceTurnQueue: transition.state, currentTurnId: claim.turnId,
      abortController: controller, isGenerating: true, agentStatus: "running", input: "" } as Partial<TState>;
  });
  return started ? controller : null;
}

/** Consume this claim phase once, or release it for a fresh owner after interruption. */
export function settleSubmitWorkspacePreflight<TState extends SubmitWorkspacePreflightStore>(input: {
  effect: WorkspacePreflightEffect;
  controller: AbortController;
  disposition: "resume" | "release";
  setState: (updater: (state: TState) => Partial<TState>) => void;
  isSessionRuntimeActive: (state: TState, sessionKey: string) => boolean;
}): boolean {
  const claim = input.effect.originalOptions?.workspaceInstructionClaim;
  if (!claim) return false;
  let settled = false;
  input.setState((state) => {
    const active = input.isSessionRuntimeActive(state, claim.sessionKey);
    const runtime = active ? state : state.runtimeBySessionKey?.[claim.sessionKey];
    if (!runtime || runtime.abortController !== input.controller ||
      !isWorkspaceInstructionDispatchClaimCurrent(runtime.workspaceTurnQueue, input.effect.originalOptions) ||
      runtime.workspaceTurnQueue?.entries[0]?.claim?.phase !== "intent_preflight") return {};
    if (input.disposition === "resume" && (!active || !isSubmitWorkspacePreflightLive(runtime))) return {};
    const queue = runtime.workspaceTurnQueue;
    // Cancellation already owns this Turn's terminal transaction. Keep its
    // dispatching head for canonical removal; queuing it again would replay it.
    const canceled = input.disposition === "release" &&
      (input.controller.signal.aborted || isPreflightCanceled(runtime, claim.sessionKey, claim.turnId));
    // Cancellation owns both transient cleanup and durable terminal state.
    // A late provider result may request reconciliation, but cannot publish
    // idle or clear that transaction's controller before its commit.
    if (canceled) return {};
    const transition = reduceWorkspaceTurnQueue(queue, {
      ...(input.disposition === "resume"
        ? { type: "set_dispatch_phase" as const, fromPhase: "intent_preflight" as const, phase: "dispatch" as const }
        : { type: "release" as const }),
      expectedVersion: queue.version, at: Date.now(), claimId: claim.claimId,
      sessionKey: claim.sessionKey, sessionEpoch: claim.sessionEpoch,
    });
    if (transition.disposition !== "applied") return {};
    settled = true;
    const patch = { workspaceTurnQueue: transition.state, abortController: null, isGenerating: false, agentStatus: "idle" };
    return (active ? patch : { runtimeBySessionKey: { ...state.runtimeBySessionKey,
      [claim.sessionKey]: { ...runtime, ...patch } } }) as Partial<TState>;
  });
  return settled;
}
