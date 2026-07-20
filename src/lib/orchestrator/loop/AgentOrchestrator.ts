import type { LegacyConversationThread } from "../state/Thread";
import { type EffectiveTurnContract } from "../../runIntent";
import { createSystemPromptApplier, createTaskTargetingRuntime, createTurnEventEmitter, emitInitialTurnPreparationEvents, loadAgentLoopHooksConfig, loadAgentLoopResolvedInstructions, prepareAgentLoopRuntimeState, resolveAgentLoopTurnInputContext, runAgentLoopStartHooks, type TurnEventEmitter } from "./turnPreparation";
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
} from "./loopMutableState";
import { createAgentLoopControlRuntime } from "./loopControlRuntime";
import { prepareIterationStreamRequest } from "./iterationStreamPreparation";
import { handleToolIterationPhase } from "./toolIterationPhase";
import { handleAssistantIterationPhase } from "./assistantIterationPhase";
import { createAgentLoopToolSurfaceRuntime } from "./toolSurfaceRuntime";
import { createAgentLoopRuntimeActions } from "./loopRuntimeActions";
import type { OrchestratorCallbacks } from "../types";
import { completeAssistantTurn } from "./finalTurnCompletion";
import { buildApprovedPlanEvidenceCompletionMessage } from "./approvedPlanFinalization";
import { isPlanRuntimeFinalizationPhase } from "../../planRuntime";
import { joinPendingSubagentsForParent } from "./subagentJoinRuntime";
import { resolveExecuteRecoveryActionContract } from "../../executeRecoveryTools";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import { pinExecuteRecoveryFiniteValidationCheckpoint } from "./executeRecoveryRuntime";
import { buildExecutionCheckpointPresentation } from "./completionGuards";
import {
  parseVisualContextRecognition,
  persistVisualContextDeliveryObservation,
  resolveMonotonicVisualContextStatus,
  resolveVisualContextDeliveryStateFromReceipt,
  type VisualContextDeliveryStatus,
} from "../../visualContext";
import { resolveEffectiveSubagentDelegationPreference } from "../../turnIntake";
import {
  getFileReadObservationForState,
  selectFileReadStateForRecoveryContext,
} from "../fileReadCache";
import {
  prepareReviewablePlanArtifactForReview,
  readFileMetadataIfAvailable,
} from "../../orchestrator";
import { resolveRecoverySourceContextFreshness } from "./contextManagement";
import { executeTool } from "../../toolExecutor";
import { resolveTrustedProjectValidationCommands } from "../../projectValidationCommands";
import type { PendingFiniteValidationCheckpoint } from "../../executeRecoveryTools";

const APPROVED_PLAN_RECOVERY_STREAM_MAX_ELAPSED_MS = 90_000;

export class AgentOrchestrator {
    private sawExecutionEvidence = false;
    private latestTurnContract: EffectiveTurnContract | null = null;
    private latestRunPauseReason: string | null = null;
    private latestExecuteRecoveryState: ExecuteRecoveryRuntimeState | null = null;
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

    hasPendingTurnCompletion(): boolean {
        return this.activeTurnEvents?.hasStagedTurnCompletion() ?? false;
    }

    commitPendingTurnCompletion(): boolean {
        return this.activeTurnEvents?.commitStagedTurnCompletion() ?? false;
    }

    discardPendingTurnCompletion(): boolean {
        return this.activeTurnEvents?.discardStagedTurnCompletion() ?? false;
    }

    pauseActiveRun(reason: string, message: string): boolean {
        const emitted = this.activeTurnEvents?.emitRunPausedEvent(reason, message) ?? false;
        if (emitted) this.latestRunPauseReason = reason;
        return emitted;
    }

    getLatestExecuteRecoveryState(): ExecuteRecoveryRuntimeState | null {
        return this.latestExecuteRecoveryState;
    }

    async execute(callbacks: OrchestratorCallbacks, abortController: AbortController) {
        this.sawExecutionEvidence = false;
        this.latestTurnContract = null;
        this.latestRunPauseReason = null;
        this.latestExecuteRecoveryState = null;
        this.activeTurnEvents = null;
        const runtimeState = await prepareAgentLoopRuntimeState(callbacks);
        const {
          config,
          isCloudProfile,
          skills,
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
        const effectiveSubagentPreference = resolveEffectiveSubagentDelegationPreference({
          rawUserInput: latestUserPromptText,
          defaultPreference: turnInputContextSignals.subagentPreference && turnInputContextSignals.subagentPreference !== "unspecified"
            ? turnInputContextSignals.subagentPreference
            : callbacks.getGoalTurnContract?.()?.subagentPreference,
        });
        let visualContextRunStatus: VisualContextDeliveryStatus =
          turnInputContextSignals.imageParts > 0 ? "queued" : "none";
        let visualRecognitionObservation = null as ReturnType<typeof parseVisualContextRecognition>["observation"];
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
          toolCatalog,
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
        const publishExecuteRecoveryState = () => {
          this.latestExecuteRecoveryState = {
            ...loopState.executeRecoveryState,
            readLease: loopState.executeRecoveryState.readLease
              ? { ...loopState.executeRecoveryState.readLease }
              : null,
            decisionCheckpoint: loopState.executeRecoveryState.decisionCheckpoint
              ? { ...loopState.executeRecoveryState.decisionCheckpoint }
              : null,
          };
          const contract = resolveExecuteRecoveryActionContract(
            loopState.executeRecoveryState.mode,
            {
              expectedTarget: loopState.executeRecoveryState.expectedTarget,
              readLease: loopState.executeRecoveryState.readLease,
              sourceObservationKey: loopState.executeRecoveryState.sourceObservationKey,
              decisionCheckpoint: loopState.executeRecoveryState.decisionCheckpoint,
              phaseNoProgressCount: loopState.executeRecoveryState.phaseNoProgressCount,
              protocolNoProgressCount: loopState.executeRecoveryState.protocolNoProgressCount,
              protocolNoProgressFingerprint: loopState.executeRecoveryState.protocolNoProgressFingerprint,
            },
          );
          callbacks.onExecuteRecoveryStateChange?.({
            mode: loopState.executeRecoveryState.mode,
            reason: loopState.executeRecoveryState.reason,
            expectedTarget: loopState.executeRecoveryState.expectedTarget,
            attempts: loopState.executeRecoveryState.attempts,
            phase: contract.phase,
            phaseNoProgressCount: loopState.executeRecoveryState.phaseNoProgressCount,
            protocolNoProgressCount: loopState.executeRecoveryState.protocolNoProgressCount,
            protocolNoProgressFingerprint: loopState.executeRecoveryState.protocolNoProgressFingerprint,
            readLease: loopState.executeRecoveryState.readLease,
            sourceObservationKey: loopState.executeRecoveryState.sourceObservationKey,
            decisionCheckpoint: loopState.executeRecoveryState.decisionCheckpoint,
          });
        };
        publishExecuteRecoveryState();
        let trustedValidationCheckpointPromise:
          Promise<PendingFiniteValidationCheckpoint | null> | null = null;
        const resolveTrustedValidationCheckpoint = () => {
          if (trustedValidationCheckpointPromise) return trustedValidationCheckpointPromise;
          trustedValidationCheckpointPromise = (async () => {
            try {
              const packageManifest = String(await executeTool(
                "read_file",
                { path: "package.json", __raw: true },
                workspace,
                callbacks.getSessionKey(),
              ) ?? "");
              const resolution = resolveTrustedProjectValidationCommands(packageManifest, {
                maxCommands: 1,
              });
              if (!resolution.ok) {
                callbacks.onDebugEvent?.("agent.execute_recovery_validation_unpinned", {
                  reason: resolution.reason,
                  manifestPath: "package.json",
                });
                return null;
              }
              const selected = resolution.commands[0];
              if (!selected) return null;
              callbacks.onDebugEvent?.("agent.execute_recovery_validation_pinned", {
                command: selected.command,
                scriptName: selected.scriptName,
                manifestPath: selected.manifestPath,
              });
              return { command: selected.command, cwd: "." };
            } catch (error) {
              callbacks.onDebugEvent?.("agent.execute_recovery_validation_unpinned", {
                reason: "package_manifest_unavailable",
                manifestPath: "package.json",
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            }
          })();
          return trustedValidationCheckpointPromise;
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
          visualObservationRequest: turnInputContextSignals.imageParts > 0
            ? { turnId: eventTurnId, imageCount: turnInputContextSignals.imageParts }
            : null,
        });
        const initialRuntimeIntent = resolveRuntimeIntent();
        applySystemPromptForRuntime(initialRuntimeIntent, resolveAllToolsForRuntime(initialRuntimeIntent));
        const startHooksResult = await runAgentLoopStartHooks({
          callbacks,
          runtimeState,
          hooksConfig,
          associatedPaths,
        });
        if (startHooksResult === "blocked") {
          emitRunPausedEvent(
            "start_hook_blocked",
            callbacks.getPreferredLanguage() === "zh"
              ? "启动钩子阻止了本轮执行；处理钩子要求后可在同一任务中恢复。"
              : "A start hook blocked this run; address the hook requirement, then resume in the same task.",
          );
          callbacks.onStatusChange("idle");
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
            publishExecuteRecoveryState();
          },
          getStreamRuntimeState: () => loopState.streamRuntimeState,
          setStreamRuntimeState: (state) => {
            loopState.streamRuntimeState = state;
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
          setPlanRuntimePhase,
          prepareReviewablePlanArtifact: () => prepareReviewablePlanArtifactForReview({
            workspace,
            callbacks,
          }),
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
          getPlanRuntimeState: () => loopState.planRuntimeState,
          emitTaskOrchestratorPhase,
          setPlanRuntimePhase,
        });
        const {
          getEffectiveMaxIterations,
          emitPlanExecutionProgress,
          getMaxOutputEscalations,
          getPlanStreamWatchdogOptions,
          pauseApprovedPlanStreamWatchdog,
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

        if (
          (loopState.executeRecoveryState.mode === "validation_only" ||
            loopState.executeRecoveryState.mode === "finite_validation_only") &&
          !loopState.executeRecoveryState.decisionCheckpoint?.pendingFiniteValidation
        ) {
          const checkpoint = await resolveTrustedValidationCheckpoint();
          if (abortController.signal.aborted) {
            callbacks.onStatusChange("idle");
            emitRunPausedEvent("aborted", "The run was aborted and can be resumed in the same turn.");
            return;
          }
          if (checkpoint) {
            loopState.executeRecoveryState = pinExecuteRecoveryFiniteValidationCheckpoint(
              loopState.executeRecoveryState,
              checkpoint,
            );
            publishExecuteRecoveryState();
          }
        }

        if (
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          isPlanRuntimeFinalizationPhase(loopState.planRuntimeState.planRuntimePhase)
        ) {
          const joined = await joinPendingSubagentsForParent({
            callbacks,
            recentToolActivity: loopState.recentToolActivity,
            recentPlanToolActivity: loopState.recentPlanToolActivity,
            reason: "plan_finalization",
          });
          if (joined) {
            setPlanRuntimePhase("drafting", "subagent results joined before plan drafting");
          }
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
        const iterationStreamPreparation = await prepareIterationStreamRequest({
          callbacks,
          runtimeState,
          iteration,
          effectiveMaxIterations,
          snapshotContextLimit,
          streamRuntimeState: loopState.streamRuntimeState,
          executeRecoveryState: loopState.executeRecoveryState,
          planRuntimeState: loopState.planRuntimeState,
          toolExecutionRuntimeState: loopState.toolExecutionRuntimeState,
          iterationContext: turnIterationContext,
          turnInputContextSignals,
          latestUserPromptText,
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
        publishExecuteRecoveryState();
        if (iterationStreamPreparation.recoveryPause) {
          const pause = iterationStreamPreparation.recoveryPause;
          const checkpoint = buildExecutionCheckpointPresentation({
            ledger: callbacks.getPlanExecutionEvidenceLedger(),
            transactionId: eventTurnId,
            language: callbacks.getPreferredLanguage(),
            fallbackMessage: pause.message,
            fallbackNextStep: callbacks.getPreferredLanguage() === "zh"
              ? "从保留的证据检查点恢复当前精确修改或验证。"
              : "Resume the exact mutation or validation from the preserved evidence checkpoint.",
          });
          callbacks.onNonActionableStop(
            checkpoint.message,
            "no_action",
            {
              phase: "paused",
              currentTask: checkpoint.title,
              currentTool: checkpoint.tool,
              latestEvidence: checkpoint.latestEvidence,
              recoveryReason: "execute_recovery_no_progress_limit",
              nextStep: checkpoint.nextStep,
              repeatedTargets: checkpoint.target ? [checkpoint.target] : [],
            },
          );
          emitRunPausedEvent(
            "execute_recovery_no_progress_limit",
            checkpoint.message,
            {
              phase: "blocked",
              title: checkpoint.title,
              status: "paused",
              summary: checkpoint.summary,
              next: checkpoint.nextStep,
              ...(checkpoint.target
                ? { canonicalTarget: checkpoint.target, target: checkpoint.target }
                : {}),
              ...(checkpoint.tool ? { tool: checkpoint.tool } : {}),
              dedupeKey: "execution-terminal-checkpoint",
            },
          );
          callbacks.onStatusChange("idle");
          return;
        }
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
          recoveryActionContract,
          iterationAllTools,
          availableToolNames,
        } = toolSurfaceDecision;

        const preStreamTurnContract = this.getLatestTurnContract();
        const requiresExecutionEvidence =
          preStreamTurnContract?.completionEvidenceRequired === "execution_evidence" ||
          preStreamTurnContract?.mutationExpected === true ||
          preStreamTurnContract?.validationExpected === true ||
          callbacks.getIsPlanApproved();
        const holdExecuteConclusionDraft =
          runtimeIntent === "execute" &&
          requiresExecutionEvidence;
        if (holdExecuteConclusionDraft) {
          callbacks.onStreamToken("__EVIDENCE_DRAFT_HOLD__:execution_evidence", assistantMsgId);
        }

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
          recoveryActionContract,
          isExecuteRecoveryEligible,
          finalTextOnlyStep,
          chatFinalSynthesisActive: loopState.streamRuntimeState.chatFinalSynthesisActive,
          chatFinalSynthesisReason: loopState.streamRuntimeState.chatFinalSynthesisReason,
          usedChatFinalSynthesisPrompt: loopState.streamRuntimeState.usedChatFinalSynthesisPrompt,
          markChatFinalSynthesisPromptUsed: () => {
            markChatFinalSynthesisPromptUsedMutableState(loopState);
          },
          recentToolActivity: loopState.recentToolActivity,
          getPlanStreamWatchdogOptions,
          approvedPlanRecoveryStreamMaxElapsedMs: APPROVED_PLAN_RECOVERY_STREAM_MAX_ELAPSED_MS,
          preapprovalPlanQualityRecoveryStreamPolicy,
          fileReadStates: loopState.toolExecutionRuntimeState.fileReadStates,
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
        let streamResult = streamInvocation.streamResult;
        const messagesSentToLLM = streamInvocation.messagesSentToLLM;
        const currentVisualContextDelivery = resolveVisualContextDeliveryStateFromReceipt({
          expectedImageParts: turnInputContextSignals.imageParts,
          receipt: streamResult.visualTransportReceipt,
        });
        if (turnInputContextSignals.imageParts > 0) {
          const visualContext = currentVisualContextDelivery;
          const nextVisualContextRunStatus = resolveMonotonicVisualContextStatus(
            visualContextRunStatus,
            visualContext.status,
          );
          const persistedVisualContext = persistVisualContextDeliveryObservation(
            callbacks.getMessages(),
            { turnId: eventTurnId, state: visualContext },
          );
          if (persistedVisualContext.changed) {
            callbacks.replaceMessages(persistedVisualContext.messages);
          }
          const shouldPublishVisualContext = nextVisualContextRunStatus !== visualContextRunStatus;
          if (shouldPublishVisualContext) {
            visualContextRunStatus = nextVisualContextRunStatus;
            const language = callbacks.getPreferredLanguage();
            const delivered = visualContext.status === "delivered";
            const partiallyDelivered = visualContext.status === "partially_delivered";
            const providerUnsupported = visualContext.status === "provider_unsupported";
            const publishedVisualContext = delivered
              ? {
                  ...visualContext,
                  recognition: visualRecognitionObservation ? "observed" as const : "pending" as const,
                  ...(visualRecognitionObservation
                    ? {
                        observationSummary: visualRecognitionObservation.summary,
                        observationId: visualRecognitionObservation.observationId,
                      }
                    : {}),
                }
              : { ...visualContext, recognition: "unverified" as const };
            const alreadyObserved = delivered && !!visualRecognitionObservation;
            emitTurnEvent({
              type: "progress.updated",
              threadId: eventThreadId,
              turnId: eventTurnId,
              timestampMs: Date.now(),
              progress: {
                phase: delivered ? "understanding" : "blocked",
                title: language === "zh"
                  ? delivered
                    ? alreadyObserved ? "模型已报告截图观察" : "正在识别截图证据"
                    : providerUnsupported
                    ? "当前模型或端点不支持截图"
                    : partiallyDelivered
                    ? "截图仅部分随请求发送"
                    : "截图未随请求发送"
                  : delivered
                  ? alreadyObserved ? "Model reported a screenshot observation" : "Inspecting screenshot evidence"
                  : providerUnsupported
                  ? "Current model or endpoint does not support screenshots"
                  : partiallyDelivered
                  ? "Screenshots only partially sent"
                  : "Screenshots were not sent",
                status: delivered ? alreadyObserved ? "done" : "running" : "failed",
                audience: "user",
                summary: language === "zh"
                  ? delivered
                    ? alreadyObserved
                      ? visualRecognitionObservation!.summary
                      : `${visualContext.deliveredImageParts} 张截图已作为视觉内容实际送入模型请求；模型会结合其可见内容继续分析，但送达本身不冒充视觉结论。`
                    : providerUnsupported
                    ? `兼容重试已移除 ${visualContext.omittedImageParts || visualContext.expectedImageParts} 张截图并明确标记为未提供；MAIN 不会把本轮文本计为截图识别证据。`
                    : `预期发送 ${visualContext.expectedImageParts} 张截图，实际送达 ${visualContext.deliveredImageParts} 张；未送达部分不会作为视觉证据。`
                  : delivered
                  ? alreadyObserved
                    ? visualRecognitionObservation!.summary
                    : `${visualContext.deliveredImageParts} screenshot${visualContext.deliveredImageParts === 1 ? "" : "s"} were included as actual visual content for model analysis. Delivery alone is not promoted to a visual conclusion.`
                  : providerUnsupported
                  ? `Compatibility retry omitted ${visualContext.omittedImageParts || visualContext.expectedImageParts} screenshot${(visualContext.omittedImageParts || visualContext.expectedImageParts) === 1 ? "" : "s"} and marked them unavailable. MAIN will not count the resulting text as screenshot recognition evidence.`
                  : `Expected ${visualContext.expectedImageParts} screenshot${visualContext.expectedImageParts === 1 ? "" : "s"}, but ${visualContext.deliveredImageParts} reached the model. Missing images are not visual evidence.`,
                tool: "visual_context",
                canonicalTarget: `images:${visualContext.expectedImageParts}`,
                dedupeKey: `visual-context:${eventTurnId}`,
                visualContext: publishedVisualContext,
              },
            });
          }
        }
        if (turnInputContextSignals.imageParts > 0) {
          const parsedVisualRecognition = parseVisualContextRecognition({
            text: streamResult.content,
            expectedTurnId: eventTurnId,
            expectedImageParts: turnInputContextSignals.imageParts,
            // Recognition belongs to the exact provider request that produced
            // this response. A prior delivered request cannot authorize a
            // marker emitted after later context trimming removed the image.
            deliveryStatus: currentVisualContextDelivery.status,
          });
          const stripVisualProtocol = (text: string | undefined): string | undefined =>
            typeof text === "string"
              ? parseVisualContextRecognition({
                  text,
                  expectedTurnId: eventTurnId,
                  expectedImageParts: turnInputContextSignals.imageParts,
                  deliveryStatus: "not_delivered",
                }).cleanedText
              : text;
          if (
            parsedVisualRecognition.cleanedText !== streamResult.content ||
            (typeof streamResult.actionableContent === "string" &&
              stripVisualProtocol(streamResult.actionableContent) !== streamResult.actionableContent) ||
            (typeof streamResult.semanticContent === "string" &&
              stripVisualProtocol(streamResult.semanticContent) !== streamResult.semanticContent) ||
            (typeof streamResult.reasoningContent === "string" &&
              stripVisualProtocol(streamResult.reasoningContent) !== streamResult.reasoningContent)
          ) {
            streamResult = {
              ...streamResult,
              content: parsedVisualRecognition.cleanedText,
              actionableContent: stripVisualProtocol(streamResult.actionableContent),
              semanticContent: stripVisualProtocol(streamResult.semanticContent),
              reasoningContent: stripVisualProtocol(streamResult.reasoningContent),
            };
          }
          const observation = parsedVisualRecognition.observation;
          if (
            observation &&
            observation.observationId !== visualRecognitionObservation?.observationId
          ) {
            visualRecognitionObservation = observation;
            const language = callbacks.getPreferredLanguage();
            const visualContext = {
              status: "delivered" as const,
              expectedImageParts: observation.imageCount,
              deliveredImageParts: observation.imageCount,
              omittedImageParts: 0,
              recognition: "observed" as const,
              observationSummary: observation.summary,
              observationId: observation.observationId,
            };
            emitTurnEvent({
              type: "progress.updated",
              threadId: eventThreadId,
              turnId: eventTurnId,
              timestampMs: Date.now(),
              progress: {
                phase: "understanding",
                title: language === "zh" ? "模型已报告截图观察" : "Model reported a screenshot observation",
                status: "done",
                audience: "user",
                summary: observation.summary,
                evidence: observation.summary,
                tool: "visual_context",
                canonicalTarget: `images:${observation.imageCount}`,
                sourceToolCallIds: [observation.observationId],
                dedupeKey: `visual-context:${eventTurnId}`,
                visualContext,
              },
            });
            callbacks.onDebugEvent?.("agent.visual_context_observed", {
              turnId: eventTurnId,
              imageCount: observation.imageCount,
              observationId: observation.observationId,
              summaryChars: observation.summary.length,
              evidenceMeaning: observation.evidenceMeaning,
            });
          }
        }
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
          effectiveTurnContract: this.latestTurnContract,
          forceXmlTools,
          iterationAllTools,
          llmTools,
          managedMessageCount: messagesSentToLLM.length,
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
          clearExecuteRecovery,
          resolveRecoveryReadObservation: async (target) => {
            const sourceState = selectFileReadStateForRecoveryContext({
              states: loopState.toolExecutionRuntimeState.fileReadStates,
              targetPath: target,
            });
            if (!sourceState) return null;
            const currentMetadata = await readFileMetadataIfAvailable(
              sourceState.path,
              workspace,
            );
            const freshness = resolveRecoverySourceContextFreshness({
              state: sourceState,
              currentMetadata,
            });
            if (!freshness.current) return null;
            const observation = getFileReadObservationForState(sourceState, "replay");
            return {
              key: observation.key,
              path: observation.path,
              requestSignature: observation.requestSignature,
              versionToken: observation.versionToken,
              ...(sourceState.window
                ? {
                    requestedRange: {
                      startLine: sourceState.window.startLine,
                      endLine: sourceState.window.endLine,
                      maxLines:
                        sourceState.window.endLine - sourceState.window.startLine + 1,
                    },
                  }
                : {}),
            };
          },
          activateChatFinalSynthesis,
          activateUnityMcpFallback,
          pauseForReviewablePlanArtifact,
          tryClosePlanWithEvidence,
          waitForPlanApprovalIfNeeded,
          getExecuteRecoveryState: () => loopState.executeRecoveryState,
        });
        applyAssistantIterationMutableState(loopState, assistantIterationPhase);
        if (assistantIterationPhase.status === "stopped") {
          if (
            effectiveSubagentPreference === "preferred" &&
            !loopState.recentToolActivity.some((activity) =>
              activity.name === "spawn_subagent" && activity.status === "succeeded"
            )
          ) {
            callbacks.onDebugEvent?.("preferred_delegation_not_used", {
              iteration,
              reason: availableToolNames.has("spawn_subagent")
                ? "model_declined_after_admission"
                : "phase_scope_or_capacity_not_admitted",
              workflowMode,
              runtimeIntent,
              spawnToolExposed: availableToolNames.has("spawn_subagent"),
              recentToolNames: [...new Set(loopState.recentToolActivity.map((activity) => activity.name))].slice(0, 12),
            });
          }
          if (turnEvents.hasStagedTurnCompletion()) {
            return;
          }
          const committedPauseReason = turnEvents.getRunPauseReason();
          if (committedPauseReason) {
            this.latestRunPauseReason = committedPauseReason;
            return;
          }
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
          toolCatalog,
          toolCapabilityRegistry,
          toolPermissionPolicy: config.toolPermissionPolicy,
          recentPlanToolActivity: loopState.recentPlanToolActivity,
          recentToolActivity: loopState.recentToolActivity,
          attemptedPlanWriteTargets: loopState.attemptedPlanWriteTargets,
          latestUserPromptText,
          managedAgentMessages: messagesSentToLLM,
          snapshotContextLimit,
          repairExecutionRequestInChat,
          recoveryActionContract,
          hooksConfig,
          turnInputContextSignals,
          taskTargetingEvidence,
          unityConsoleDiagnosticsRequested,
          forceXmlTools,
          noToolRuntimeState: loopState.noToolRuntimeState,
          planRuntimeState: loopState.planRuntimeState,
          loopGuardRuntimeState: loopState.loopGuardRuntimeState,
          executeRecoveryState: loopState.executeRecoveryState,
          recoveryPromptState: loopState.recoveryPromptState,
          unityMcpRuntimeState: loopState.unityMcpRuntimeState,
          evidenceRuntimeState: loopState.evidenceRuntimeState,
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
          emitPlanExecutionProgress,
          activateExecuteRecovery,
          activateChatFinalSynthesis,
          pauseForReviewablePlanArtifact,
        });
        applyToolIterationMutableState(loopState, toolIterationPhase);
        publishExecuteRecoveryState();
        if (toolIterationPhase.status === "goal_completed") {
          turnEvents.stageTurnCompletion(emitTurnCompletedEvent);
          callbacks.onDebugEvent?.("goal_inner_loop_evidence_boundary", {
            iteration,
            reason: "goal_tool_result_checkpoint_completed",
            pendingSubagentIds: callbacks.getPendingSubagentIds?.() || [],
          });
          return;
        }
        if (toolIterationPhase.status === "plan_completed") {
          const audit = toolIterationPhase.completionAudit || {
            completedCount: callbacks.getPlanTasks().length,
            totalCount: callbacks.getPlanTasks().length,
            pendingUserValidationTasks: [],
          };
          const finalText = buildApprovedPlanEvidenceCompletionMessage({
            language: callbacks.getPreferredLanguage(),
            completedCount: audit.completedCount,
            totalCount: audit.totalCount,
            pendingUserValidationTasks: audit.pendingUserValidationTasks,
          });
          callbacks.onTurnSummaryReady(finalText);
          callbacks.onAssistantFinalText(finalText, [], {
            hasToolCalls: false,
            preserveAssistantText: true,
            capsuleCandidate: true,
            modelAuthored: false,
          });
          completeAssistantTurn({
            callbacks,
            assistantHistoryText: finalText,
            providerReasoningForHistory: null,
            assistantMsgId: `runtime-plan-complete-${eventTurnId}-${iteration}`,
            iterationContext: turnIterationContext,
            emitTurnEvent,
            emitTurnCompletedEvent,
          });
          return;
        }
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
          executeRecoveryState: loopState.executeRecoveryState,
          transactionId: eventTurnId,
          emitPlanExecutionProgress,
          emitRunPausedEvent,
        });
    }
}
