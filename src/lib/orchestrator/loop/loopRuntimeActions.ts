import {
  describeExecuteRecoveryToolSurface,
  shouldAllowExecuteRecoveryFileRead,
  summarizeRepeatedExecuteTargets,
  type ExecuteRecoveryMode,
  type RecoveryReadLease,
} from "../../executeRecoveryTools";
import {
  logAgentEvent,
} from "../../orchestrator";
import { buildPlanRuntimeCapsuleNarration } from "../../orchestrator/planOrchestration";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { PlanRuntimePhase } from "../../workflowModels";
import { workspacePathsReferToSameFile } from "../../workspacePaths";
import type { OrchestratorCallbacks } from "../types";
import {
  activateExecuteRecoveryRuntimeState,
  clearExecuteRecoveryRuntimeState,
  type ExecuteRecoveryRuntimeState,
} from "./executeRecoveryRuntime";
import {
  clearCrossIterationReadTrackingForTarget,
  type AgentLoopGuardRuntimeState,
} from "./loopGuardRuntimeState";
import {
  applyPlanRuntimePhase,
  type PlanLoopRuntimeState,
  type PlanRuntimePhaseQualitySnapshot,
} from "./planRuntimeState";
import {
  activateChatFinalSynthesisState,
  type AgentLoopStreamRuntimeState,
} from "./streamRuntimeState";
import type { AgentLoopRuntimeState } from "./turnPreparation";

export interface AgentLoopRuntimeActions {
  activateExecuteRecovery: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => ExecuteRecoveryRuntimeState;
  activateChatFinalSynthesis: (
    reason: string,
    context?: Record<string, unknown>,
  ) => void;
  clearExecuteRecovery: (
    reason: string,
    resetTarget?: string,
    stateOverride?: ExecuteRecoveryRuntimeState,
  ) => ExecuteRecoveryRuntimeState;
  setPlanRuntimePhase: (
    phase: PlanRuntimePhase,
    reason?: string,
    status?: "pending" | "running" | "done" | "failed",
    qualitySnapshot?: PlanRuntimePhaseQualitySnapshot,
  ) => void;
}

function requestedRangeFromObservationSignature(
  requestSignature: string,
): RecoveryReadLease["requestedRange"] {
  const argsSeparator = requestSignature.lastIndexOf("::");
  if (argsSeparator < 0) return null;
  try {
    const entries = JSON.parse(requestSignature.slice(argsSeparator + 2));
    if (!Array.isArray(entries)) return null;
    const args = Object.fromEntries(entries) as Record<string, unknown>;
    const requestedRange = {
      ...(Number.isFinite(args.start_line) ? { startLine: Number(args.start_line) } : {}),
      ...(Number.isFinite(args.end_line) ? { endLine: Number(args.end_line) } : {}),
      ...(Number.isFinite(args.max_lines) ? { maxLines: Number(args.max_lines) } : {}),
    };
    return Object.keys(requestedRange).length > 0 ? requestedRange : null;
  } catch {
    return null;
  }
}

export function createAgentLoopRuntimeActions(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  recentToolActivity: PlanToolActivitySummary[];
  getIteration: () => number;
  getExecuteRecoveryState: () => ExecuteRecoveryRuntimeState;
  setExecuteRecoveryState: (state: ExecuteRecoveryRuntimeState) => void;
  getStreamRuntimeState: () => AgentLoopStreamRuntimeState;
  setStreamRuntimeState: (state: AgentLoopStreamRuntimeState) => void;
  getLoopGuardRuntimeState: () => AgentLoopGuardRuntimeState;
  setLoopGuardRuntimeState: (state: AgentLoopGuardRuntimeState) => void;
  getPlanRuntimeState: () => PlanLoopRuntimeState;
  setPlanRuntimeState: (state: PlanLoopRuntimeState) => void;
}): AgentLoopRuntimeActions {
  const {
    callbacks,
    runtimeState,
    recentToolActivity,
    getIteration,
    getExecuteRecoveryState,
    setExecuteRecoveryState,
    getStreamRuntimeState,
    setStreamRuntimeState,
    getLoopGuardRuntimeState,
    setLoopGuardRuntimeState,
    getPlanRuntimeState,
    setPlanRuntimeState,
  } = input;
  const {
    workflowMode,
  } = runtimeState;
  const publishPlanRuntimeNarration = (phase: PlanRuntimePhase) => {
    callbacks.onPlanRuntimeNarration?.(
      buildPlanRuntimeCapsuleNarration(phase, callbacks.getPreferredLanguage()) || null,
    );
  };

  // The initial exploration phase has no transition yet, but it still needs a
  // user-safe capsule description before the first tool or model token.
  if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
    publishPlanRuntimeNarration(getPlanRuntimeState().planRuntimePhase);
  }

  const activateExecuteRecovery: AgentLoopRuntimeActions["activateExecuteRecovery"] = (
    mode,
    reason,
    context = {},
  ) => {
    const repeatedTargets = Array.isArray(context.repeatedTargets)
      ? context.repeatedTargets.filter((target): target is string => typeof target === "string" && !!target.trim())
      : [];
    const expectedTarget = typeof context.expectedTarget === "string"
      ? context.expectedTarget
      : typeof context.target === "string"
        ? context.target
        : repeatedTargets.length === 1
          ? repeatedTargets[0]
          : null;
    const explicitObservation = context.readFileObservation && typeof context.readFileObservation === "object"
      ? context.readFileObservation as PlanToolActivitySummary["readFileObservation"]
      : null;
    const retainedObservation = explicitObservation || [...recentToolActivity]
      .reverse()
      .find((activity) =>
        activity.readFileObservation &&
        expectedTarget &&
        workspacePathsReferToSameFile(activity.readFileObservation.path, expectedTarget)
      )?.readFileObservation || null;
    const sourceObservationKey = typeof context.sourceObservationKey === "string"
      ? context.sourceObservationKey.trim() || null
      : retainedObservation?.key || null;
    const explicitReadLease = context.readLease && typeof context.readLease === "object"
      ? context.readLease as RecoveryReadLease
      : null;
    const readLease: RecoveryReadLease | null = explicitReadLease || (
      retainedObservation && expectedTarget
        ? {
            purpose: mode === "patch_recovery_read" ? "patch_recovery" : "context_restore",
            target: expectedTarget,
            requestedRange: requestedRangeFromObservationSignature(
              retainedObservation.requestSignature,
            ),
            observationKey: retainedObservation.key,
            observedVersion: retainedObservation.versionToken,
            state: mode === "patch_recovery_read" ? "active" : "consumed",
          }
        : null
    );
    const nextState = activateExecuteRecoveryRuntimeState(
      getExecuteRecoveryState(),
      { mode, reason, expectedTarget, readLease, sourceObservationKey },
    );
    setExecuteRecoveryState(nextState);
    logAgentEvent("execute_recovery_activated", {
      iteration: getIteration(),
      executeRecoveryMode: nextState.mode,
      executeRecoveryAttempts: nextState.attempts,
      reason,
      sourceObservationKey,
      readLeasePurpose: readLease?.purpose || null,
      readLeaseRange: readLease?.requestedRange || null,
      observedVersion: readLease?.observedVersion || null,
      recoveryToolSurface: describeExecuteRecoveryToolSurface(
        nextState.mode,
        shouldAllowExecuteRecoveryFileRead(recentToolActivity, nextState.mode),
      ),
      ...context,
    });
    return nextState;
  };

  const activateChatFinalSynthesis: AgentLoopRuntimeActions["activateChatFinalSynthesis"] = (
    reason,
    context = {},
  ) => {
    const activation = activateChatFinalSynthesisState(
      getStreamRuntimeState(),
      { reason },
    );
    setStreamRuntimeState(activation.state);
    if (!activation.changed) return;
    logAgentEvent("chat_final_synthesis_activated", {
      iteration: getIteration(),
      reason: activation.state.chatFinalSynthesisReason,
      recentToolActivity: recentToolActivity.length,
      repeatedTargets: summarizeRepeatedExecuteTargets(
        recentToolActivity.slice(-12),
      ),
      ...context,
    });
  };

  const clearExecuteRecovery: AgentLoopRuntimeActions["clearExecuteRecovery"] = (
    reason,
    resetTarget,
    stateOverride = getExecuteRecoveryState(),
  ) => {
    if (stateOverride.mode === "normal") return stateOverride;
    const previousState = stateOverride;
    const nextState = clearExecuteRecoveryRuntimeState(stateOverride);
    setExecuteRecoveryState(nextState);
    logAgentEvent("execute_recovery_cleared", {
      iteration: getIteration(),
      previousMode: previousState.mode,
      executeRecoveryAttempts: previousState.attempts,
      reason,
      resetTarget: resetTarget || null,
    });
    setLoopGuardRuntimeState(
      clearCrossIterationReadTrackingForTarget(
        getLoopGuardRuntimeState(),
        resetTarget,
      ),
    );
    return nextState;
  };

  const setPlanRuntimePhase: AgentLoopRuntimeActions["setPlanRuntimePhase"] = (
    phase,
    reason,
    status = "running",
    qualitySnapshot,
  ) => {
    if (workflowMode !== "plan" || callbacks.getIsPlanApproved()) return;
    const currentState = getPlanRuntimeState();
    const qualityState: PlanLoopRuntimeState = {
      ...currentState,
      ...(qualitySnapshot?.qualityRejectCount != null
        ? {
            planQualityRejectCount: Math.max(
              0,
              Number(qualitySnapshot.qualityRejectCount) || 0,
            ),
          }
        : {}),
      ...(qualitySnapshot?.missingSections
        ? { planLastMissingSections: [...qualitySnapshot.missingSections] }
        : {}),
    };
    const phaseUpdate = applyPlanRuntimePhase(
      qualityState,
      { phase, reason },
    );
    if (!phaseUpdate.changed) return;
    setPlanRuntimeState(phaseUpdate.state);
    publishPlanRuntimeNarration(phase);
    logAgentEvent("plan_runtime_phase_changed", {
      phase,
      reason: reason || "",
      iteration: getIteration(),
      qualityRejectCount: phaseUpdate.state.planQualityRejectCount,
      missingSections: phaseUpdate.state.planLastMissingSections,
      userVisible: false,
      status,
    });
  };

  return {
    activateExecuteRecovery,
    activateChatFinalSynthesis,
    clearExecuteRecovery,
    setPlanRuntimePhase,
  };
}
