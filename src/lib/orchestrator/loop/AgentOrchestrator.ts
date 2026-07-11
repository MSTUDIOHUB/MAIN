import type { LegacyConversationThread } from "../state/Thread";
import { type EffectiveTurnContract } from "../../runIntent";
import { createSystemPromptApplier, createTaskTargetingRuntime, createTurnEventEmitter, emitInitialTurnPreparationEvents, loadAgentLoopHooksConfig, loadAgentLoopResolvedInstructions, prepareAgentLoopRuntimeState, resolveAgentLoopTurnInputContext, runAgentLoopStartHooks, startModelProbeForTurn, type TurnEventEmitter } from "./turnPreparation";
import { invokeStreamWithRecoveryForIteration } from "./streamRecovery";
import { prepareAgentLoopToolRegistry } from "./toolRegistrySetup";
import { handleMaxIterationBoundary } from "./maxIterationBoundary";
import { createUnityMcpRuntimeState } from "./unityMcpRuntime";
import { startTurnIteration } from "./turnIterationContext";
import { createPlanReviewRuntimeHandlers } from "./planReviewRuntime";
import {
  applyAssistantIterationMutableState,
  applyIterationStreamPreparationMutableState,
  applyToolIterationMutableState,
  createAgentLoopMutableState,
  markChatFinalSynthesisPromptUsedMutableState,
  markExecuteOperationEvidenceMutableState,
  resetAgentLoopMutableStateForApprovedPlanExecution,
} from "./loopMutableState";
import { createAgentLoopControlRuntime } from "./loopControlRuntime";
import { prepareIterationStreamRequest } from "./iterationStreamPreparation";
import { handleToolIterationPhase } from "./toolIterationPhase";
import { handleAssistantIterationPhase } from "./assistantIterationPhase";
import { createAgentLoopToolSurfaceRuntime } from "./toolSurfaceRuntime";
import { createAgentLoopRuntimeActions } from "./loopRuntimeActions";
import type { OrchestratorCallbacks } from "../types";

const APPROVED_PLAN_RECOVERY_STREAM_MAX_ELAPSED_MS = 90_000;

export class AgentOrchestrator {
    private sawExecutionEvidence = false;
    private latestTurnContract: EffectiveTurnContract | null = null;
    private latestRunPauseReason: string | null = null;
    private loopThread: LegacyConversationThread | null = null;
    private activeTurnEvents: TurnEventEmitter | null = null;

    hasExecuteOperationEvidence(): boolean {
        return this.sawExecutionEvidence;
    }

    getLatestTurnContract(): EffectiveTurnContract | null {
        return this.latestTurnContract;
    }

    getLatestRunPauseReason(): string | null {
        return this.latestRunPauseReason;
    }

    failActiveRun(message: string): void {
        this.activeTurnEvents?.emitTurnFailedEvent(message);
    }

    async execute(callbacks: OrchestratorCallbacks, abortController: AbortController) {
        this.sawExecutionEvidence = false;
        this.latestTurnContract = null;
        this.latestRunPauseReason = null;
        const runtimeState = await prepareAgentLoopRuntimeState(callbacks);
        const {
          config,
          isCloudProfile,
          skills,
          settings,
          workspace,
          turnIntent,
          workflowMode,
        } = runtimeState;
        const turnEvents = createTurnEventEmitter(callbacks);
        this.activeTurnEvents = turnEvents;
        const {
          eventThreadId,
          eventTurnId,
          emitTurnEvent,
          emitTurnCompletedEvent,
          emitTurnFailedEvent,
          emitRunPausedEvent: emitPreparedRunPausedEvent,
        } = turnEvents;
        const emitRunPausedEvent: typeof emitPreparedRunPausedEvent = (reason, message, progress) => {
          const emitted = emitPreparedRunPausedEvent(reason, message, progress);
          if (emitted) this.latestRunPauseReason = reason;
          return emitted;
        };
        emitInitialTurnPreparationEvents({
          callbacks,
          runtimeState,
          turnEvents,
        });
        let snapshotContextLimit = isCloudProfile ? undefined : config.local.contextLimit;
        const mcpServers = callbacks.getMcpServers();
        const turnInputContext = resolveAgentLoopTurnInputContext(runtimeState, callbacks);
        const {
          latestUserPromptText,
          repairExecutionRequestInChat,
          turnInputContextSignals,
          commandDirective,
          gameStudioEngine,
          gameStudioEngineContext,
          gameStudioUnityContext,
          unityCommandRequested,
          unityConsoleDiagnosticsRequested,
          gameStudioScriptEditRequested,
          unityScriptEditRequested,
        } = turnInputContext;
        const toolRegistryState = await prepareAgentLoopToolRegistry({
          config,
          skills,
          mcpServers,
          initialMcpTools: callbacks.getMcpDiscoveredTools(),
          latestUserPromptText,
          gameStudioEngine,
          gameStudioEngineContext,
          gameStudioUnityContext,
          unityCommandRequested,
          unityConsoleDiagnosticsRequested,
          unityScriptEditRequested,
          gameStudioScriptEditRequested,
          subagentDepth: callbacks.getSubagentDepth?.() ?? 0,
          webSearchEnabled: callbacks.getWebSearchEnabled?.() === true,
          enabledKnowledgeBaseIds: callbacks.getEnabledKnowledgeBaseIds?.() || [],
        });
        const {
          mcpTools,
          mcpServerStatuses,
          mcpPriorityEngine,
          gameStudioMcpFirstEligible,
          unityMcpFirstEligible,
          effectivePreferredUnityUrls,
          effectiveUnityMcpToolNameSet,
          routedToolDefinitions,
          toolCapabilityRegistry,
          webSearchEnabled,
        } = toolRegistryState;
        const initialUnityMcpRuntimeState = createUnityMcpRuntimeState({
          unityMcpFirstEligible,
          unityMcpToolCount: effectiveUnityMcpToolNameSet.size,
          unityConsoleDiagnosticsRequested,
        });
        const loopState = createAgentLoopMutableState({
          callbacks,
          workflowMode,
          unityMcpRuntimeState: initialUnityMcpRuntimeState,
        });
        const notifyApprovedPlanExecutionStarted = callbacks.onApprovedPlanExecutionStarted;
        let approvedPlanExecutionPhaseStarted = false;
        let approvedPlanExecutionResetPendingFold = false;
        callbacks.onApprovedPlanExecutionStarted = () => {
          if (!approvedPlanExecutionPhaseStarted) {
            approvedPlanExecutionPhaseStarted = true;
            approvedPlanExecutionResetPendingFold = true;
            resetAgentLoopMutableStateForApprovedPlanExecution(loopState);
          }
          notifyApprovedPlanExecutionStarted?.();
        };
        const reapplyApprovedPlanExecutionResetAfterPhaseFold = () => {
          if (!approvedPlanExecutionResetPendingFold) return;
          approvedPlanExecutionResetPendingFold = false;
          resetAgentLoopMutableStateForApprovedPlanExecution(loopState);
        };
        const toolSurfaceRuntime = createAgentLoopToolSurfaceRuntime({
          callbacks,
          runtimeState,
          workspace,
          routedToolDefinitions,
          toolCapabilityRegistry,
          turnInputContextSignals,
          unityCommandRequested,
          unityConsoleDiagnosticsRequested,
          effectivePreferredUnityUrls,
          effectiveUnityMcpToolNameSet,
          getUnityMcpRuntimeState: () => loopState.unityMcpRuntimeState,
          setUnityMcpRuntimeState: (state) => {
            loopState.unityMcpRuntimeState = state;
          },
        });
        const {
          activateUnityMcpFallback,
          resolveAllToolsForRuntime,
          resolveRuntimeIntent,
        } = toolSurfaceRuntime;
        const associatedPaths = callbacks.getAssociatedPaths();
        const resolvedInstructions = await loadAgentLoopResolvedInstructions({
          callbacks,
          runtimeState,
          associatedPaths,
        });
        const {
          taskTargetingEvidence,
          emitTaskOrchestratorPhase,
          buildCurrentTaskTargetingProfile,
        } = createTaskTargetingRuntime({
          callbacks,
          runtimeState,
          turnInputContext,
          associatedPaths,
        });
        const hooksConfig = await loadAgentLoopHooksConfig({
          callbacks,
          runtimeState,
        });
        const { applySystemPromptForRuntime } = createSystemPromptApplier({
          callbacks,
          runtimeState,
          resolvedInstructions,
          mcpTools,
          mcpServerStatuses,
          mcpPriorityEngine,
          gameStudioMcpFirstEligible,
          unityConsoleDiagnosticsRequested,
          getUnityMcpFirstPhaseActive: () => loopState.unityMcpRuntimeState.firstPhaseActive,
          setLatestTurnContract: (contract) => {
            this.latestTurnContract = contract;
          },
        });
        const initialRuntimeIntent = resolveRuntimeIntent();
        startModelProbeForTurn(settings);
        applySystemPromptForRuntime(initialRuntimeIntent, resolveAllToolsForRuntime(initialRuntimeIntent));
        const startHooksResult = await runAgentLoopStartHooks({
          callbacks,
          runtimeState,
          hooksConfig,
          associatedPaths,
        });
        if (startHooksResult === "blocked") {
          return;
        }

        callbacks.onStatusChange("running");
        const markExecuteOperationEvidence = () => {
          markExecuteOperationEvidenceMutableState(loopState);
          this.sawExecutionEvidence = true;
        };
        const runtimeActions = createAgentLoopRuntimeActions({
          callbacks,
          runtimeState,
          recentToolActivity: loopState.recentToolActivity,
          getIteration: () => loopState.iteration,
          getExecuteRecoveryState: () => loopState.executeRecoveryState,
          setExecuteRecoveryState: (state) => {
            loopState.executeRecoveryState = state;
          },
          getStreamRuntimeState: () => loopState.streamRuntimeState,
          setStreamRuntimeState: (state) => {
            loopState.streamRuntimeState = state;
          },
          getLoopGuardRuntimeState: () => loopState.loopGuardRuntimeState,
          setLoopGuardRuntimeState: (state) => {
            loopState.loopGuardRuntimeState = state;
          },
          getPlanRuntimeState: () => loopState.planRuntimeState,
          setPlanRuntimeState: (state) => {
            loopState.planRuntimeState = state;
          },
        });
        const {
          activateExecuteRecovery,
          activateChatFinalSynthesis,
          clearExecuteRecovery,
          setPlanRuntimePhase,
        } = runtimeActions;
        const {
          waitForPlanApprovalIfNeeded,
          pauseForReviewablePlanArtifact,
          tryClosePlanWithEvidence,
        } = createPlanReviewRuntimeHandlers({
          callbacks,
          abortController,
          workflowMode,
          latestUserPromptText,
          recentPlanToolActivity: loopState.recentPlanToolActivity,
          attemptedPlanWriteTargets: loopState.attemptedPlanWriteTargets,
          getIteration: () => loopState.iteration,
          getPlanRuntimeState: () => loopState.planRuntimeState,
          setPlanRuntimeState: (state) => {
            loopState.planRuntimeState = state;
          },
          getApprovedPlanRecoveryState: () => loopState.approvedPlanRecoveryState,
          setApprovedPlanRecoveryState: (state) => {
            loopState.approvedPlanRecoveryState = state;
          },
          setPlanRuntimePhase,
        });

        const loopControl = createAgentLoopControlRuntime({
          callbacks,
          runtimeState,
          recentPlanToolActivity: loopState.recentPlanToolActivity,
          getIteration: () => loopState.iteration,
          getRuntimeIntent: resolveRuntimeIntent,
          getExecuteRecoveryMode: () => loopState.executeRecoveryState.mode,
          getStreamRuntimeState: () => loopState.streamRuntimeState,
          setStreamRuntimeState: (state) => {
            loopState.streamRuntimeState = state;
          },
          getApprovedPlanRecoveryState: () => loopState.approvedPlanRecoveryState,
          setApprovedPlanRecoveryState: (state) => {
            loopState.approvedPlanRecoveryState = state;
          },
          emitTaskOrchestratorPhase,
          setPlanRuntimePhase,
        });
        const {
          getEffectiveMaxIterations,
          emitPlanExecutionProgress,
          getMaxOutputEscalations,
          getPlanStreamWatchdogOptions,
          pauseApprovedPlanNoProgressLoop,
          pauseApprovedPlanStreamWatchdog,
          continueApprovedPlanWithStrategySwitch,
        } = loopControl;
        const loopStartRuntimeIntent = resolveRuntimeIntent();
        const loopStartTools = resolveAllToolsForRuntime(loopStartRuntimeIntent);
        const loopStartTargetingProfile = buildCurrentTaskTargetingProfile();
        loopControl.startLoop({
          runtimeIntent: loopStartRuntimeIntent,
          loopStartTools,
          mcpToolCount: mcpTools.length,
          unityMcpFirstPhaseActive: loopState.unityMcpRuntimeState.firstPhaseActive,
          unityMcpFallbackReason: loopState.unityMcpRuntimeState.fallbackReason,
          allowRootSkeleton: loopStartTargetingProfile.allowRootSkeleton,
        });

        while (loopState.iteration < getEffectiveMaxIterations()) {
        loopState.iteration++;
        const iteration = loopState.iteration;
        const effectiveMaxIterations = getEffectiveMaxIterations();
        emitPlanExecutionProgress("running");

        if (abortController.signal.aborted) {
          callbacks.onStatusChange("idle");
          emitRunPausedEvent("aborted", "The run was aborted and can be resumed in the same turn.");
          return;
        }

        const turnIterationContext = startTurnIteration({
          currentThread: this.loopThread,
          eventThreadId,
          eventTurnId,
          iteration,
          messages: callbacks.getMessages(),
        });
        this.loopThread = turnIterationContext.thread;

        // ── Pre-LLM Turn Preparation ──
        const iterationStreamPreparation = prepareIterationStreamRequest({
          callbacks,
          runtimeState,
          iteration,
          effectiveMaxIterations,
          snapshotContextLimit,
          streamRuntimeState: loopState.streamRuntimeState,
          executeRecoveryState: loopState.executeRecoveryState,
          approvedPlanRecoveryState: loopState.approvedPlanRecoveryState,
          planRuntimeState: loopState.planRuntimeState,
          toolExecutionRuntimeState: loopState.toolExecutionRuntimeState,
          iterationContext: turnIterationContext,
          turnInputContextSignals,
          recentToolActivity: loopState.recentToolActivity,
          recentPlanToolActivity: loopState.recentPlanToolActivity,
          lastAssistantTextForCheckpoint:
            loopState.evidenceRuntimeState.lastAssistantTextForCheckpoint,
          mcpToolCount: mcpTools.length,
          resolveRuntimeIntent,
          resolveAllToolsForRuntime,
          applySystemPromptForRuntime,
          clearExecuteRecovery,
          getMaxOutputEscalations,
          emitPlanExecutionProgress,
        });
        applyIterationStreamPreparationMutableState(
          loopState,
          iterationStreamPreparation,
        );
        const {
          runtimeIntent,
          finalTextOnlyStep,
          toolSurfaceDecision,
          managedAgentMessages,
          providerCompatibilityOverride,
          forceXmlTools,
          llmTools,
          assistantMsgId,
          maxOutputEscalations,
          iterationRequestStartedAt,
          preapprovalPlanQualityRecoveryStreamPolicy,
        } = iterationStreamPreparation;
        const {
          isExecuteRecoveryEligible,
          allowExecuteRecoveryFileRead,
          effectiveExecuteRecoveryFileRead,
          allowApprovedPlanRecoveryFileRead,
          iterationAllTools,
          availableToolNames,
        } = toolSurfaceDecision;

        // 2. Stream LLM response
        const streamInvocation = await invokeStreamWithRecoveryForIteration({
          callbacks,
          abortSignal: abortController.signal,
          runtimeState,
          assistantMsgId,
          iteration,
          effectiveMaxIterations,
          runtimeIntent,
          managedAgentMessages,
          iterationAllTools,
          llmTools,
          currentMaxTokens: loopState.streamRuntimeState.currentMaxTokens,
          maxOutputEscalations,
          forceXmlTools,
          providerCompatibilityOverride,
          snapshotContextLimit,
          executeRecoveryMode: loopState.executeRecoveryState.mode,
          executeRecoveryReason: loopState.executeRecoveryState.reason,
          allowExecuteRecoveryFileRead,
          isExecuteRecoveryEligible,
          ...loopState.approvedPlanRecoveryState,
          finalTextOnlyStep,
          chatFinalSynthesisActive: loopState.streamRuntimeState.chatFinalSynthesisActive,
          chatFinalSynthesisReason: loopState.streamRuntimeState.chatFinalSynthesisReason,
          usedChatFinalSynthesisPrompt: loopState.streamRuntimeState.usedChatFinalSynthesisPrompt,
          markChatFinalSynthesisPromptUsed: () => {
            markChatFinalSynthesisPromptUsedMutableState(loopState);
          },
          recentToolActivity: loopState.recentToolActivity,
          consecutiveNoToolCount: loopState.noToolRuntimeState.consecutiveNoToolCount,
          getPlanStreamWatchdogOptions,
          approvedPlanRecoveryStreamMaxElapsedMs: APPROVED_PLAN_RECOVERY_STREAM_MAX_ELAPSED_MS,
          preapprovalPlanQualityRecoveryStreamPolicy,
          pauseApprovedPlanStreamWatchdog,
          emitPlanExecutionProgress,
        });
        snapshotContextLimit = streamInvocation.snapshotContextLimit;
        if (streamInvocation.status === "stopped") {
          emitRunPausedEvent(
            streamInvocation.pauseReason || "stream_stopped",
            streamInvocation.pauseMessage ||
              "The model stream stopped before the run reached a terminal turn result.",
          );
          return;
        }
        const streamResult = streamInvocation.streamResult;
        if (streamResult.usage) {
          callbacks.onModelUsage?.(streamResult.usage);
        }

        const assistantIterationPhase = await handleAssistantIterationPhase({
          callbacks,
          runtimeState,
          streamResult,
          iteration,
          effectiveMaxIterations,
          iterationRequestStartedAt,
          runtimeIntent,
          forceXmlTools,
          iterationAllTools,
          llmTools,
          managedMessageCount: managedAgentMessages.length,
          assistantMsgId,
          finalTextOnlyStep,
          availableToolNames,
          webSearchEnabled,
          latestUserPromptText,
          repairExecutionRequestInChat,
          commandDirectiveAction: commandDirective?.action,
          unityConsoleDiagnosticsRequested,
          turnInputContextSignals,
          recentPlanToolActivity: loopState.recentPlanToolActivity,
          recentToolActivity: loopState.recentToolActivity,
          attemptedPlanWriteTargets: loopState.attemptedPlanWriteTargets,
          streamRuntimeState: loopState.streamRuntimeState,
          noToolRuntimeState: loopState.noToolRuntimeState,
          planRuntimeState: loopState.planRuntimeState,
          approvedPlanRecoveryState: loopState.approvedPlanRecoveryState,
          recoveryPromptState: loopState.recoveryPromptState,
          evidenceRuntimeState: loopState.evidenceRuntimeState,
          loopGuardRuntimeState: loopState.loopGuardRuntimeState,
          unityMcpRuntimeState: loopState.unityMcpRuntimeState,
          iterationContext: turnIterationContext,
          emitTurnEvent,
          emitTurnCompletedEvent,
          emitTaskOrchestratorPhase,
          emitPlanExecutionProgress,
          setPlanRuntimePhase,
          activateExecuteRecovery,
          activateChatFinalSynthesis,
          activateUnityMcpFallback,
          pauseForReviewablePlanArtifact,
          tryClosePlanWithEvidence,
          waitForPlanApprovalIfNeeded,
        });
        applyAssistantIterationMutableState(loopState, assistantIterationPhase);
        reapplyApprovedPlanExecutionResetAfterPhaseFold();
        if (assistantIterationPhase.status === "stopped") {
          const pauseReason = workflowMode === "plan" && !callbacks.getIsPlanApproved() && callbacks.getStatus() === "pending_review"
            ? "plan_review_required"
            : "assistant_stopped";
          emitRunPausedEvent(pauseReason, "The assistant run stopped in a resumable state.");
          return;
        }
        if (assistantIterationPhase.status === "continue") {
          continue;
        }
        const {
          effectiveToolCalls,
          historyAssistantText,
          providerReasoningForHistory,
          finalReplyOptionCount,
          hasStructuredProposal,
        } = assistantIterationPhase;

        const toolIterationPhase = await handleToolIterationPhase({
          callbacks,
          abortSignal: abortController.signal,
          workspace,
          activeProfile: config.activeProfile,
          toolFeedbackFormat: config.toolFeedbackFormat,
          iteration,
          effectiveMaxIterations,
          workflowMode,
          turnIntent,
          runtimeIntent,
          effectiveToolCalls,
          historyAssistantText,
          providerReasoningForHistory,
          finalReplyOptionCount,
          hasStructuredProposal,
          iterationAllTools,
          availableToolNames,
          toolCapabilityRegistry,
          toolPermissionPolicy: config.toolPermissionPolicy,
          recentPlanToolActivity: loopState.recentPlanToolActivity,
          recentToolActivity: loopState.recentToolActivity,
          attemptedPlanWriteTargets: loopState.attemptedPlanWriteTargets,
          latestUserPromptText,
          managedAgentMessages,
          snapshotContextLimit,
          repairExecutionRequestInChat,
          allowApprovedPlanRecoveryFileRead,
          effectiveExecuteRecoveryFileRead,
          hooksConfig,
          turnInputContextSignals,
          taskTargetingEvidence,
          unityConsoleDiagnosticsRequested,
          noToolRuntimeState: loopState.noToolRuntimeState,
          planRuntimeState: loopState.planRuntimeState,
          loopGuardRuntimeState: loopState.loopGuardRuntimeState,
          executeRecoveryState: loopState.executeRecoveryState,
          recoveryPromptState: loopState.recoveryPromptState,
          unityMcpRuntimeState: loopState.unityMcpRuntimeState,
          evidenceRuntimeState: loopState.evidenceRuntimeState,
          approvedPlanRecoveryState: loopState.approvedPlanRecoveryState,
          toolExecutionRuntimeState: loopState.toolExecutionRuntimeState,
          failedToolCallCounts: loopState.loopGuardRuntimeState.failedToolCallCounts,
          buildCurrentTaskTargetingProfile,
          iterationContext: turnIterationContext,
          emitTurnEvent,
          emitTaskOrchestratorPhase,
          markExecuteOperationEvidence,
          activateUnityMcpFallback,
          setPlanRuntimePhase,
          clearExecuteRecovery,
          emitTurnFailedEvent,
          emitPlanExecutionProgress,
          activateExecuteRecovery,
          activateChatFinalSynthesis,
          continueApprovedPlanWithStrategySwitch,
          pauseApprovedPlanNoProgressLoop,
          pauseForReviewablePlanArtifact,
        });
        applyToolIterationMutableState(loopState, toolIterationPhase);
        reapplyApprovedPlanExecutionResetAfterPhaseFold();
        if (toolIterationPhase.status === "aborted") {
          emitRunPausedEvent("aborted", "The tool run was aborted and can be resumed in the same turn.");
          return;
        }
        if (toolIterationPhase.status === "stopped") {
          emitRunPausedEvent("tool_loop_stopped", "The tool loop stopped in a resumable state.");
          return;
        }
        if (toolIterationPhase.status === "continue") {
          continue;
        }
        // Loop continues — the model sees all tool results and can respond
        }

        const effectiveMaxIterations = getEffectiveMaxIterations();
        await handleMaxIterationBoundary({
          callbacks,
          workflowMode,
          runtimeIntent: resolveRuntimeIntent(),
          effectiveMaxIterations,
          recentPlanToolActivity: loopState.recentPlanToolActivity,
          recentToolActivity: loopState.recentToolActivity,
          lastAssistantTextForCheckpoint:
            loopState.evidenceRuntimeState.lastAssistantTextForCheckpoint,
          sawExecuteOperationEvidence:
            loopState.evidenceRuntimeState.sawExecuteOperationEvidence,
          executeRecoveryMode: loopState.executeRecoveryState.mode,
          emitPlanExecutionProgress,
          emitRunPausedEvent,
        });
    }
}
