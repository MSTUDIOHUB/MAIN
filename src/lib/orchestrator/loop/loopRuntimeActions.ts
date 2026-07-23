import {
  buildExecutePatchMismatchFingerprint,
  buildPatchRecoveryReadNoProgressFingerprint,
  normalizeRecoveryReadRange,
  patchRecoveryLeaseIdentityMatches,
  requestedRangeFromReadObservationSignature,
  resolveExecuteRecoveryActionContract,
  summarizeRepeatedExecuteTargets,
  type ExecutionDecisionCheckpoint,
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
  registerExecuteRecoveryProtocolNoProgress,
  type ExecuteRecoveryRuntimeState,
} from "./executeRecoveryRuntime";
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
    const expectedTarget = typeof context.expectedTarget === "string"
      ? context.expectedTarget
      : typeof context.target === "string"
        ? context.target
        : null;
    // Repetition is a loop symptom, not causal source attribution. Promoting a
    // lone recently-read path here made unrelated files become mutation
    // targets after browser/spec failures. Callers that have real stack,
    // plan-task, grep-hit, or mutation evidence must pass target explicitly.
    const currentRecoveryState = getExecuteRecoveryState();
    const explicitObservation = context.readFileObservation && typeof context.readFileObservation === "object"
      ? context.readFileObservation as PlanToolActivitySummary["readFileObservation"]
      : null;
    const retainedObservation = explicitObservation || (
      mode === "patch_recovery_read"
        ? null
        : [...recentToolActivity]
          .reverse()
          .find((activity) =>
            activity.readFileObservation &&
            expectedTarget &&
            workspacePathsReferToSameFile(activity.readFileObservation.path, expectedTarget)
          )?.readFileObservation || null
    );
    const hasExplicitSourceObservationKey = Object.prototype.hasOwnProperty.call(
      context,
      "sourceObservationKey",
    );
    const explicitSourceObservationKey = typeof context.sourceObservationKey === "string"
      ? context.sourceObservationKey.trim() || null
      : null;
    const sourceObservationKey = hasExplicitSourceObservationKey
      ? explicitSourceObservationKey
      : retainedObservation?.key || null;
    const explicitReadLease = context.readLease && typeof context.readLease === "object"
      ? context.readLease as RecoveryReadLease
      : null;
    const explicitDecisionCheckpoint = context.decisionCheckpoint && typeof context.decisionCheckpoint === "object"
      ? context.decisionCheckpoint as ExecutionDecisionCheckpoint
      : undefined;
    const priorTargetLease = expectedTarget && currentRecoveryState.readLease &&
      workspacePathsReferToSameFile(currentRecoveryState.readLease.target, expectedTarget)
        ? currentRecoveryState.readLease
        : null;
    const requestedRange = normalizeRecoveryReadRange(context.requestedRange) ||
      normalizeRecoveryReadRange(explicitReadLease?.requestedRange) ||
      normalizeRecoveryReadRange(priorTargetLease?.requestedRange) ||
      (explicitObservation
        ? requestedRangeFromReadObservationSignature(explicitObservation.requestSignature)
        : null);
    const observedVersion = String(
      context.observedVersion ||
      explicitReadLease?.observedVersion ||
      priorTargetLease?.observedVersion ||
      explicitObservation?.versionToken ||
      "",
    ).trim() || null;
    const explicitContextLease =
      mode === "patch_recovery_read" &&
      expectedTarget &&
      explicitReadLease &&
      explicitReadLease.purpose !== "patch_recovery"
        ? {
            ...explicitReadLease,
            target: expectedTarget,
            ...(requestedRange ? { requestedRange } : {}),
            observedVersion,
            state: "available" as const,
          }
        : null;
    const patchReadLeaseCandidate: RecoveryReadLease | null = explicitContextLease || (
      mode === "patch_recovery_read" && expectedTarget
        ? {
            purpose: "patch_recovery",
            target: expectedTarget,
            ...(requestedRange ? { requestedRange } : {}),
            observationKey:
              explicitReadLease?.observationKey || priorTargetLease?.observationKey || null,
            observedVersion,
            mismatchFingerprint: String(
              context.mismatchFingerprint || explicitReadLease?.mismatchFingerprint ||
              buildExecutePatchMismatchFingerprint({ reason, target: expectedTarget }),
            ).trim(),
            state: "available",
          }
        : null
    );
    const repeatedPatchMismatch = patchRecoveryLeaseIdentityMatches(
      currentRecoveryState.readLease,
      patchReadLeaseCandidate,
    );
    const readLease: RecoveryReadLease | null = repeatedPatchMismatch
      ? currentRecoveryState.readLease
      : patchReadLeaseCandidate || explicitReadLease || (
        retainedObservation && expectedTarget
        ? {
            purpose: "context_restore",
            target: expectedTarget,
            requestedRange: requestedRangeFromReadObservationSignature(
              retainedObservation.requestSignature,
            ),
            observationKey: retainedObservation.key,
            observedVersion: retainedObservation.versionToken,
            state: "consumed",
          }
        : null
      );
    // A lease is one-shot for a target/version/range mismatch identity. If the
    // next patch still misses the same snapshot, stay in mutation instead of
    // minting another read phase; the monotonic protocol counter will bound
    // retries even when cache stubs or policy deferrals are budget-neutral.
    let nextState: ExecuteRecoveryRuntimeState;
    if (repeatedPatchMismatch && patchReadLeaseCandidate?.mismatchFingerprint) {
      const mutationCheckpoint: ExecutionDecisionCheckpoint = explicitDecisionCheckpoint || {
        expectedTarget,
        sourceObservationKey: currentRecoveryState.sourceObservationKey,
        nextRequiredCapability: "mutation",
        ...(currentRecoveryState.decisionCheckpoint?.evidenceVersion
          ? { evidenceVersion: currentRecoveryState.decisionCheckpoint.evidenceVersion }
          : {}),
        ...(currentRecoveryState.decisionCheckpoint?.planTaskId
          ? { planTaskId: currentRecoveryState.decisionCheckpoint.planTaskId }
          : {}),
        ...(currentRecoveryState.decisionCheckpoint?.requirementRef
          ? { requirementRef: currentRecoveryState.decisionCheckpoint.requirementRef }
          : {}),
        ...(currentRecoveryState.decisionCheckpoint?.pendingFiniteValidation
          ? {
              pendingFiniteValidation:
                currentRecoveryState.decisionCheckpoint.pendingFiniteValidation,
            }
          : {}),
      };
      nextState = registerExecuteRecoveryProtocolNoProgress(
        {
          ...currentRecoveryState,
          mode: "mutation_first",
          reason,
          expectedTarget,
          readLease,
          decisionCheckpoint: mutationCheckpoint,
        },
        buildPatchRecoveryReadNoProgressFingerprint(patchReadLeaseCandidate.target),
      );
    } else {
      nextState = activateExecuteRecoveryRuntimeState(
        currentRecoveryState,
        {
          mode,
          reason,
          expectedTarget,
          readLease,
          decisionCheckpoint: explicitDecisionCheckpoint,
          resetExpectedTarget: context.resetExpectedTarget === true,
          sourceObservationKey: mode === "patch_recovery_read"
            ? explicitObservation?.key || null
            : sourceObservationKey,
        },
      );
    }
    const explicitProtocolNoProgressFingerprint = String(
      context.protocolNoProgressFingerprint || "",
    ).trim();
    if (explicitProtocolNoProgressFingerprint) {
      nextState = registerExecuteRecoveryProtocolNoProgress(
        nextState,
        explicitProtocolNoProgressFingerprint,
      );
    }
    setExecuteRecoveryState(nextState);
    logAgentEvent("execute_recovery_activated", {
      ...context,
      iteration: getIteration(),
      executeRecoveryMode: nextState.mode,
      executeRecoveryAttempts: nextState.attempts,
      reason,
      sourceObservationKey: nextState.sourceObservationKey,
      readLeasePurpose: nextState.readLease?.purpose || null,
      readLeaseRange: nextState.readLease?.requestedRange || null,
      readLeaseState: nextState.readLease?.state || null,
      observedVersion: nextState.readLease?.observedVersion || null,
      mismatchFingerprint: nextState.readLease?.mismatchFingerprint || null,
      repeatedPatchMismatch,
      protocolNoProgressCount: nextState.protocolNoProgressCount,
      planTaskId: nextState.decisionCheckpoint?.planTaskId || null,
      requirementRef: nextState.decisionCheckpoint?.requirementRef || null,
      recoveryToolSurface: resolveExecuteRecoveryActionContract(nextState.mode, {
        expectedTarget: nextState.expectedTarget,
        readLease: nextState.readLease,
        sourceObservationKey: nextState.sourceObservationKey,
        decisionCheckpoint: nextState.decisionCheckpoint,
        phaseNoProgressCount: nextState.phaseNoProgressCount,
        protocolNoProgressCount: nextState.protocolNoProgressCount,
        protocolNoProgressFingerprint: nextState.protocolNoProgressFingerprint,
      }).surfaceDescription,
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
    if (phaseUpdate.rejectedReason) {
      logAgentEvent("plan_runtime_phase_transition_rejected", {
        currentPhase: currentState.planRuntimePhase,
        requestedPhase: phase,
        reason: phaseUpdate.rejectedReason,
        triggerReason: reason || "",
        iteration: getIteration(),
        status,
      });
      return;
    }
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
