import type { AppConfig } from "../../appTypes";
import type { ExecuteRecoveryMode } from "../../executeRecoveryTools";
import {
  resolveAgentLoopMaxIterations,
  type AgentLoopIterationLimits,
} from "../../agentLoopSafety";
import {
  buildPlanExecutionProgressUpdate,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import type { TaskOrchestratorPhase } from "../../taskTargeting";
import type {
  PlanExecutionProgressPhase,
  PlanExecutionProgressUpdate,
  PlanRuntimePhase,
} from "../../workflowModels";
import {
  logAgentEvent,
  shouldUseXmlToolProtocol,
} from "../../orchestrator";
import type { ToolDefinition } from "../../toolSchemas";
import type { FetchLLMStreamOptions, OrchestratorCallbacks } from "../types";
import {
  continueApprovedPlanWithStrategySwitch as continueApprovedPlanWithStrategySwitchAction,
  pauseApprovedPlanNoProgressLoop as pauseApprovedPlanNoProgressLoopAction,
  pauseApprovedPlanStreamWatchdog as pauseApprovedPlanStreamWatchdogAction,
} from "./approvedPlanRecoveryActions";
import {
  applyApprovedPlanStrategySwitchRecoveryState,
  type ApprovedPlanRecoveryRuntimeState,
} from "./approvedPlanRecoveryRuntime";
import {
  resolveMaxOutputEscalations,
  resolvePlanStreamWatchdogState,
  type AgentLoopStreamRuntimeState,
} from "./streamRuntimeState";
import type { AgentLoopRuntimeState } from "./turnPreparation";

type EmitTaskOrchestratorPhase = (
  phase: TaskOrchestratorPhase,
  extra?: Record<string, unknown>,
) => void;

type SetPlanRuntimePhase = (
  phase: PlanRuntimePhase,
  reason?: string,
  status?: "pending" | "running" | "done" | "failed",
) => void;

export interface AgentLoopControlRuntime {
  effectiveMaxIterations: number;
  emitPlanExecutionProgress: (
    phase: PlanExecutionProgressPhase,
    overrides?: Partial<PlanExecutionProgressUpdate>,
  ) => void;
  getMaxOutputEscalations: () => number;
  getPlanStreamWatchdogOptions: (nativeToolCount: number) => FetchLLMStreamOptions | undefined;
  pauseApprovedPlanNoProgressLoop: (input: {
    reason: string;
    repeats: number;
    remainingText?: string;
    logContext?: Record<string, unknown>;
  }) => void;
  pauseApprovedPlanStreamWatchdog: (
    message: string,
    logContext?: Record<string, unknown>,
  ) => boolean;
  continueApprovedPlanWithStrategySwitch: (input: {
    reason: string;
    remainingText: string;
    logContext?: Record<string, unknown>;
  }) => void;
  startLoop: (input: {
    runtimeIntent: ResolvedUserIntent;
    loopStartTools: ToolDefinition[];
    mcpToolCount: number;
    unityMcpFirstPhaseActive: boolean;
    unityMcpFallbackReason: string | null;
  }) => void;
}

export function createAgentLoopControlRuntime(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  recentPlanToolActivity: PlanToolActivitySummary[];
  getIteration: () => number;
  getRuntimeIntent: () => ResolvedUserIntent;
  getExecuteRecoveryMode: () => ExecuteRecoveryMode;
  getStreamRuntimeState: () => AgentLoopStreamRuntimeState;
  setStreamRuntimeState: (state: AgentLoopStreamRuntimeState) => void;
  getApprovedPlanRecoveryState: () => ApprovedPlanRecoveryRuntimeState;
  setApprovedPlanRecoveryState: (state: ApprovedPlanRecoveryRuntimeState) => void;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  setPlanRuntimePhase: SetPlanRuntimePhase;
}): AgentLoopControlRuntime {
  const {
    callbacks,
    runtimeState,
    recentPlanToolActivity,
    getIteration,
    getRuntimeIntent,
    getExecuteRecoveryMode,
    getStreamRuntimeState,
    setStreamRuntimeState,
    getApprovedPlanRecoveryState,
    setApprovedPlanRecoveryState,
    emitTaskOrchestratorPhase,
    setPlanRuntimePhase,
  } = input;
  const {
    config,
    effectiveToolProtocol,
    settings,
    turnIntent,
    workflowMode,
  } = runtimeState;
  const agentLoopConfig = config as AppConfig & {
    agentLoop?: { iterationLimits?: AgentLoopIterationLimits | null } | null;
  };
  const effectiveMaxIterations = resolveAgentLoopMaxIterations({
    workflowMode,
    runtimeIntent: getRuntimeIntent(),
    isPlanApproved: callbacks.getIsPlanApproved(),
    limits: agentLoopConfig.agentLoop?.iterationLimits ?? null,
  });

  const emitPlanExecutionProgress = (
    phase: PlanExecutionProgressPhase,
    overrides: Partial<PlanExecutionProgressUpdate> = {},
  ) => {
    if (workflowMode !== "plan" || !callbacks.getIsPlanApproved() || !callbacks.onPlanExecutionProgress) return;
    callbacks.onPlanExecutionProgress({
      ...buildPlanExecutionProgressUpdate({
        language: callbacks.getPreferredLanguage(),
        phase,
        iterationCount: getIteration(),
        maxIterations: effectiveMaxIterations,
        autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
        tasks: callbacks.getPlanTasks(),
        evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
        recentToolActivity: recentPlanToolActivity,
      }),
      ...overrides,
    });
  };

  const getMaxOutputEscalations = () => resolveMaxOutputEscalations({
    executeRecoveryMode: getExecuteRecoveryMode(),
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
  });

  const getPlanStreamWatchdogOptions = (nativeToolCount: number) => {
    const streamRuntimeState = getStreamRuntimeState();
    const watchdogDecision = resolvePlanStreamWatchdogState(streamRuntimeState, {
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      nativeToolCount,
      activeProfile: config.activeProfile,
      provider: settings.provider,
      toolProtocol: effectiveToolProtocol,
    });
    setStreamRuntimeState(watchdogDecision.state);
    if (watchdogDecision.shouldLogLocalPlanNotice) {
      logAgentEvent("plan_no_visible_token_notice_only", {
        activeProfile: config.activeProfile,
        provider: settings.provider || "unknown",
        toolProtocol: effectiveToolProtocol,
        workflowMode,
        turnIntent,
      });
    }
    return watchdogDecision.options;
  };

  const pauseApprovedPlanNoProgressLoop: AgentLoopControlRuntime["pauseApprovedPlanNoProgressLoop"] = (pauseInput) => {
    pauseApprovedPlanNoProgressLoopAction({
      callbacks,
      iteration: getIteration(),
      recentPlanToolActivity,
      emitTaskOrchestratorPhase,
      emitPlanExecutionProgress,
      ...pauseInput,
    });
  };

  const pauseApprovedPlanStreamWatchdog: AgentLoopControlRuntime["pauseApprovedPlanStreamWatchdog"] = (
    message,
    logContext,
  ) => {
    return pauseApprovedPlanStreamWatchdogAction({
      callbacks,
      workflowMode,
      iteration: getIteration(),
      recentPlanToolActivity,
      emitTaskOrchestratorPhase,
      emitPlanExecutionProgress,
      message,
      logContext,
    });
  };

  const continueApprovedPlanWithStrategySwitch: AgentLoopControlRuntime["continueApprovedPlanWithStrategySwitch"] = (strategyInput) => {
    const approvedPlanRecoveryState = getApprovedPlanRecoveryState();
    const result = continueApprovedPlanWithStrategySwitchAction({
      callbacks,
      iteration: getIteration(),
      recentPlanToolActivity,
      approvedPlanNoProgressRecoveryAttempts:
        approvedPlanRecoveryState.approvedPlanNoProgressRecoveryAttempts,
      emitTaskOrchestratorPhase,
      emitPlanExecutionProgress,
      ...strategyInput,
    });
    setApprovedPlanRecoveryState(
      applyApprovedPlanStrategySwitchRecoveryState(
        approvedPlanRecoveryState,
        result,
      ),
    );
  };

  const startLoop: AgentLoopControlRuntime["startLoop"] = (startInput) => {
    const { runtimeIntent, loopStartTools, mcpToolCount } = startInput;
    logAgentEvent("loop_start", {
      workflowMode,
      turnIntent,
      runtimeIntent,
      messagesLen: callbacks.getMessages().length,
      allTools: loopStartTools.length,
      mcpTools: mcpToolCount,
      builtinAndSkillTools: Math.max(0, loopStartTools.length - mcpToolCount),
      activeProfile: config.activeProfile,
      provider: settings.provider || "unknown",
      maxIterations: effectiveMaxIterations,
      iterationLimitSource: {
        chatRespond: agentLoopConfig.agentLoop?.iterationLimits?.chatRespond ?? null,
        editExecute: agentLoopConfig.agentLoop?.iterationLimits?.editExecute ?? null,
        planDraft: agentLoopConfig.agentLoop?.iterationLimits?.planDraft ?? null,
        planExecution: agentLoopConfig.agentLoop?.iterationLimits?.planExecution ?? null,
      },
      nativeToolsEnabled: !shouldUseXmlToolProtocol(
        config,
        settings,
        callbacks.getMessages(),
        callbacks.shouldForceXmlForProviderCompatibility?.(),
      ),
      toolProtocol: effectiveToolProtocol,
      xmlToolsEnabled: true,
      unityMcpFirstPhaseActive: startInput.unityMcpFirstPhaseActive,
      unityMcpFallbackReason: startInput.unityMcpFallbackReason,
      maxOutputEscalations: getMaxOutputEscalations(),
    });
    emitPlanExecutionProgress("starting");
    if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
      setPlanRuntimePhase("explore_structure", "start");
    }
  };

  return {
    effectiveMaxIterations,
    emitPlanExecutionProgress,
    getMaxOutputEscalations,
    getPlanStreamWatchdogOptions,
    pauseApprovedPlanNoProgressLoop,
    pauseApprovedPlanStreamWatchdog,
    continueApprovedPlanWithStrategySwitch,
    startLoop,
  };
}
