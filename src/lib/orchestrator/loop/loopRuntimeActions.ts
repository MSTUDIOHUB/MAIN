import {
  describeExecuteRecoveryToolSurface,
  shouldAllowExecuteRecoveryFileRead,
  summarizeRepeatedExecuteTargets,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";
import {
  logAgentEvent,
} from "../../orchestrator";
import { planRuntimePhasePresentation } from "../../orchestrator/planOrchestration";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { PlanRuntimePhase } from "../../workflowModels";
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

  const activateExecuteRecovery: AgentLoopRuntimeActions["activateExecuteRecovery"] = (
    mode,
    reason,
    context = {},
  ) => {
    const nextState = activateExecuteRecoveryRuntimeState(
      getExecuteRecoveryState(),
      { mode, reason },
    );
    setExecuteRecoveryState(nextState);
    logAgentEvent("execute_recovery_activated", {
      iteration: getIteration(),
      executeRecoveryMode: nextState.mode,
      executeRecoveryAttempts: nextState.attempts,
      reason,
      recoveryToolSurface: describeExecuteRecoveryToolSurface(
        nextState.mode,
        shouldAllowExecuteRecoveryFileRead(recentToolActivity),
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
    const presentation = planRuntimePhasePresentation(
      phase,
      callbacks.getPreferredLanguage(),
      reason,
    );
    callbacks.onTurnRuntimePhaseChanged?.({
      id: `plan_${phase}`,
      kind: presentation.kind,
      title: presentation.title,
      summary: presentation.summary,
      domain: "plan_runtime",
      status,
      reason: reason || "",
      iteration: getIteration(),
      qualityRejectCount: phaseUpdate.state.planQualityRejectCount,
    });
    logAgentEvent("plan_runtime_phase_changed", {
      phase,
      reason: reason || "",
      iteration: getIteration(),
      qualityRejectCount: phaseUpdate.state.planQualityRejectCount,
      missingSections: phaseUpdate.state.planLastMissingSections,
    });
  };

  return {
    activateExecuteRecovery,
    activateChatFinalSynthesis,
    clearExecuteRecovery,
    setPlanRuntimePhase,
  };
}
