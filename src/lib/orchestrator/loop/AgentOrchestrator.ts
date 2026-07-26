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
import {
  pinExecuteRecoveryFiniteValidationCheckpoint,
  shouldPinExecuteRecoveryFiniteValidationCheckpoint,
} from "./executeRecoveryRuntime";
import { buildExecutionCheckpointPresentation } from "./completionGuards";
import {
  compactObservedVisualContextPayload,
  normalizeReservedVisualObservationProtocol,
  parseVisualContextRecognition,
  persistVisualContextDeliveryObservation,
  resolveMonotonicVisualContextStatus,
  resolveTurnVisualPayloadBinding,
  resolveVisualContextDeliveryStateFromReceipt,
  type VisualContextDeliveryStatus,
} from "../../visualContext";
import { resolveEffectiveSubagentDelegationPreference } from "../../turnIntake";
import type { CollaborationTaskJoinOutcome } from "../../subagents";
import { restoreDurableTurnPlanningActivities } from "../../turnRuntimeCheckpoint";
import {
  getFileReadObservationForState,
  selectFileReadStateForRecoveryContext,
} from "../fileReadCache";
import {
  hasPlanVisualContextGrounding,
  prepareReviewablePlanArtifactForReview,
  readFileMetadataIfAvailable,
} from "../../orchestrator";
import { resolveRecoverySourceContextFreshness } from "./contextManagement";
import { executeTool } from "../../toolExecutor";
import { resolveTrustedProjectValidationCommands } from "../../projectValidationCommands";
import type { PendingFiniteValidationCheckpoint } from "../../executeRecoveryTools";
import { resolveStoppedRunDisposition } from "./stoppedRunDisposition";
import { assessPlanEvidenceReadiness } from "../../planReadOnlyConvergence";
import type { RuntimeGuidanceCompletionFenceDecision } from "../../runtimeGuidanceCompletion";
import { hasSuccessfulWorkspaceMutationEvidence } from "../../verificationEvidence";
import { hasStartedCollaborationForCurrentTurn } from "./toolCallPlanning";

const EXECUTE_RECOVERY_STREAM_MAX_ELAPSED_MS = 120_000;

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
        let lateGuidanceContinuationsUsed = 0;
        let lateGuidanceIterationAllowance = 0;
        const resolveStagedCompletionFence = (
          iteration: number,
        ): "continue" | "complete" | "pause" => {
          if (!turnEvents.hasStagedTurnCompletion()) return "complete";
          // A review-ready Plan is a pause inside the same Turn, not a Run
          // completion candidate. Preserve the existing review projection.
          if (
            workflowMode === "plan" &&
            !callbacks.getIsPlanApproved() &&
            callbacks.getStatus() === "pending_review"
          ) {
            return "complete";
          }
          const decision: RuntimeGuidanceCompletionFenceDecision =
            callbacks.tryAcquireRunCompletionFence?.({
              completionCandidate: true,
              lateGuidanceContinuationsUsed,
            }) || { kind: "acquire_completion", alreadyFinalizing: false };
          if (decision.kind === "continue_with_guidance") {
            turnEvents.discardStagedTurnCompletion();
            lateGuidanceContinuationsUsed += 1;
            if (iteration >= getEffectiveMaxIterations() + lateGuidanceIterationAllowance) {
              lateGuidanceIterationAllowance += 1;
            }
            callbacks.onLateGuidanceContinuation?.({
              guidanceId: decision.guidanceId,
              iteration,
            });
            callbacks.onDebugEvent?.("runtime_guidance_completion_continued", {
              iteration,
              guidanceId: decision.guidanceId,
              lateGuidanceContinuationsUsed,
              lateGuidanceIterationAllowance,
            });
            return "continue";
          }
          if (decision.kind === "reject_completion") {
            turnEvents.discardStagedTurnCompletion();
            emitRunPausedEvent(
              "runtime_guidance_completion_fence_rejected",
              "Completion paused because pending runtime guidance could not be consumed safely.",
            );
            callbacks.onDebugEvent?.("runtime_guidance_completion_rejected", {
              iteration,
              reason: decision.reason,
              lateGuidanceContinuationsUsed,
            });
            return "pause";
          }
          return "complete";
        };
        const finishStoppedRun = (input: {
          iteration: number;
          fallbackReason: string;
          fallbackMessage: string;
        }) => {
          const committedPauseReason = turnEvents.getRunPauseReason();
          const stoppedDisposition = resolveStoppedRunDisposition({
            workflowMode,
            isPlanApproved: callbacks.getIsPlanApproved(),
            status: callbacks.getStatus(),
            hasStagedTurnCompletion: turnEvents.hasStagedTurnCompletion(),
            committedPauseReason,
          });
          if (stoppedDisposition === "plan_review") {
            // Review readiness can be discovered after either assistant text
            // materialization or a Plan artifact tool result. Both paths must
            // supersede stale generic completion/stop projections.
            const discardedStagedCompletion =
              turnEvents.discardStagedTurnCompletion();
            callbacks.onDebugEvent?.("plan_review_completion_superseded", {
              iteration: input.iteration,
              discardedStagedCompletion,
              planStage: callbacks.getPlanStage(),
              fallbackReason: input.fallbackReason,
            });
            emitRunPausedEvent(
              "plan_review_required",
              "The reviewed Plan artifact is awaiting approval in the same logical turn.",
            );
            return;
          }
          if (stoppedDisposition === "staged_completion") return;
          if (stoppedDisposition === "committed_pause" && committedPauseReason) {
            this.latestRunPauseReason = committedPauseReason;
            return;
          }
          emitRunPausedEvent(input.fallbackReason, input.fallbackMessage);
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
        const restoredTurnRuntimeCheckpoint = callbacks.getTurnRuntimeCheckpoint?.() || null;
        const checkpointOwnsCurrentTurn = !!restoredTurnRuntimeCheckpoint &&
          restoredTurnRuntimeCheckpoint.owner.sessionKey === callbacks.getSessionKey() &&
          restoredTurnRuntimeCheckpoint.owner.turnId === callbacks.getCurrentTurnId?.();
        const restoredVisualContext = checkpointOwnsCurrentTurn
          ? restoredTurnRuntimeCheckpoint.input.visualContext
          : null;
        let visualContextRunStatus: VisualContextDeliveryStatus =
          restoredVisualContext?.status ||
          (turnInputContextSignals.imageParts > 0 ? "queued" : "none");
        let visualRecognitionObservation = (
          restoredVisualContext?.recognition === "observed" &&
          restoredVisualContext.observationSummary &&
          restoredVisualContext.observationId
        )
          ? {
              turnId: eventTurnId,
              imageCount: restoredVisualContext.expectedImageParts,
              summary: restoredVisualContext.observationSummary,
              observationId: restoredVisualContext.observationId,
              recognition: "observed" as const,
              evidenceMeaning: "model_visual_observation" as const,
            }
          : null as ReturnType<typeof parseVisualContextRecognition>["observation"];
        if (restoredVisualContext) {
          callbacks.onDebugEvent?.("agent.turn_runtime_visual_checkpoint_restored", {
            checkpointRevision: restoredTurnRuntimeCheckpoint!.revision,
            status: restoredVisualContext.status,
            recognition: restoredVisualContext.recognition || null,
            expectedImageParts: restoredVisualContext.expectedImageParts,
            observationId: restoredVisualContext.observationId || null,
          });
        }
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
          subagentAccessMode:
            callbacks.getSubagentScope?.()?.accessMode || "read",
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
        if (checkpointOwnsCurrentTurn) {
          const restoredPlanningActivities = restoreDurableTurnPlanningActivities(
            restoredTurnRuntimeCheckpoint,
            callbacks.getSubagentClosureReceiptLedger?.() || null,
          );
          loopState.recentPlanToolActivity.push(...restoredPlanningActivities);
          loopState.recentToolActivity.push(...restoredPlanningActivities);
          callbacks.onDebugEvent?.("agent.turn_runtime_planning_checkpoint_restored", {
            checkpointRevision: restoredTurnRuntimeCheckpoint.revision,
            collaborationEntryCount:
              restoredTurnRuntimeCheckpoint.planning.collaborationLedger?.entries.length || 0,
            adoptedEvidenceCount: restoredPlanningActivities.length,
          });
        } else if (restoredTurnRuntimeCheckpoint) {
          callbacks.onDebugEvent?.("agent.turn_runtime_planning_checkpoint_rejected", {
            reason: "turn_owner_mismatch",
            checkpointSessionKey: restoredTurnRuntimeCheckpoint.owner.sessionKey,
            checkpointTurnId: restoredTurnRuntimeCheckpoint.owner.turnId,
          });
        }
        const publishCollaborationCheckpoint = async () => {
          await callbacks.publishTurnRuntimePlanningCheckpoint?.({
            recentPlanToolActivity: loopState.recentPlanToolActivity,
            updatedAt: Date.now(),
          });
        };
        const emitCollaborationTaskOutcomes = async (
          outcomes: CollaborationTaskJoinOutcome[],
          joinBoundary:
            | "plan_finalization"
            | "parent_final_response"
            | "tool_iteration",
        ) => {
          await publishCollaborationCheckpoint();
          callbacks.onDebugEvent?.("agent.semantic_collaboration_evidence_consumed", {
            iteration: loopState.iteration,
            joinBoundary,
            outcomes: outcomes.map((outcome) => ({
              subagentId: outcome.subagentId,
              collaborationTaskId: outcome.collaborationTaskId,
              taskKey: outcome.taskKey,
              status: outcome.status,
              closureState: outcome.closureState,
              adoptedEvidenceCount: outcome.adoptedEvidenceCount,
              adoptedEvidenceTargets: outcome.adoptedEvidenceTargets,
              evidenceAdopted: outcome.evidenceAdopted,
              terminalComplete: outcome.terminalComplete,
            })),
            consumedScopeKeys: outcomes
              .filter((outcome) => outcome.evidenceAdopted)
              .map((outcome) => outcome.taskKey),
            adoptedTaskIds: outcomes
              .filter((outcome) => outcome.evidenceAdopted)
              .map((outcome) => outcome.collaborationTaskId),
            providerNeutral: true,
          });
        };
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
          visualObservationRequest:
            turnInputContextSignals.imageParts > 0
            ? { turnId: eventTurnId, imageCount: turnInputContextSignals.imageParts }
            : null,
          getVisualContextRecognitionObservation: () => visualRecognitionObservation,
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

        while (
          loopState.iteration <
          getEffectiveMaxIterations() + lateGuidanceIterationAllowance
        ) {
        loopState.iteration++;
        const iteration = loopState.iteration;
        const effectiveMaxIterations = getEffectiveMaxIterations();
        emitPlanExecutionProgress("running");

        if (abortController.signal.aborted) {
          callbacks.onStatusChange("idle");
          emitRunPausedEvent("aborted", "The run was aborted and can be resumed in the same turn.");
          return;
        }
        if (hasSuccessfulWorkspaceMutationEvidence({
          ledger: callbacks.getPlanExecutionEvidenceLedger(),
          transactionId: eventTurnId,
        })) {
          markExecuteOperationEvidence();
        }

        if (
          (callbacks.getSubagentDepth?.() || 0) === 0 &&
          shouldPinExecuteRecoveryFiniteValidationCheckpoint(
            loopState.executeRecoveryState,
          )
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
          const joinResult = await joinPendingSubagentsForParent({
            callbacks,
            recentToolActivity: loopState.recentToolActivity,
            recentPlanToolActivity: loopState.recentPlanToolActivity,
            reason: "plan_finalization",
          });
          if (joinResult.joined) {
            await emitCollaborationTaskOutcomes(
              joinResult.taskOutcomes,
              "plan_finalization",
            );
            const joinedEvidenceReadiness = assessPlanEvidenceReadiness({
              userGoal: latestUserPromptText,
              userContext: turnInputContextSignals,
              recentToolActivity: loopState.recentPlanToolActivity,
              hasGroundedVisualContext: hasPlanVisualContextGrounding(
                callbacks.getMessages(),
                callbacks.getCurrentTurnId?.(),
              ),
            });
            if (joinedEvidenceReadiness.status === "ready_for_plan") {
              setPlanRuntimePhase("drafting", "joined evidence passed Plan readiness gate");
            } else {
              callbacks.onDebugEvent?.("agent.semantic_collaboration_joined_without_evidence", {
                iteration,
                resultIds: joinResult.resultIds,
                sourceEvidenceCount: joinResult.sourceEvidenceCount,
                joinBoundary: "plan_finalization",
                providerNeutral: true,
              });
              setPlanRuntimePhase(
                "needs_evidence",
                joinedEvidenceReadiness.reason,
              );
            }
          }
        }

        const turnIterationContext = startTurnIteration({
          currentThread: this.loopThread,
          eventThreadId,
          eventTurnId,
          runId: callbacks.getCurrentRunIdentity?.()?.runId || turnEvents.eventRunId,
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
          providerCompatibilityPlanAuthoringCard,
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
          executeRecoveryStreamMaxElapsedMs: EXECUTE_RECOVERY_STREAM_MAX_ELAPSED_MS,
          preapprovalPlanQualityRecoveryStreamPolicy,
          priorSemanticToolMisses:
            loopState.noToolRuntimeState.consecutiveNoToolCount,
          providerCompatibilityPlanAuthoringCard,
          planEvidenceObligationRequired:
            !!toolSurfaceDecision.planEvidenceObligation,
          planCandidateRepairActive:
            iterationStreamPreparation.planRuntimeState
              .planCandidateRepairCheckpoint?.exhausted === false,
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
        const currentTurnRuntimeCheckpoint = callbacks.getTurnRuntimeCheckpoint?.() || null;
        const currentCanonicalRunIdentity = currentTurnRuntimeCheckpoint?.canonical.run?.identity || null;
        const expectedVisualTransportBinding = currentTurnRuntimeCheckpoint &&
          currentCanonicalRunIdentity &&
          currentTurnRuntimeCheckpoint.owner.sessionKey === callbacks.getSessionKey() &&
          currentTurnRuntimeCheckpoint.owner.turnId === eventTurnId &&
          currentCanonicalRunIdentity.sessionKey === currentTurnRuntimeCheckpoint.owner.sessionKey &&
          currentCanonicalRunIdentity.sessionEpoch === currentTurnRuntimeCheckpoint.owner.sessionEpoch &&
          currentCanonicalRunIdentity.turnId === eventTurnId
          ? resolveTurnVisualPayloadBinding(messagesSentToLLM, {
              owner: {
                sessionKey: currentCanonicalRunIdentity.sessionKey,
                sessionEpoch: currentCanonicalRunIdentity.sessionEpoch,
                turnId: currentCanonicalRunIdentity.turnId,
                runId: currentCanonicalRunIdentity.runId,
                attemptId: currentCanonicalRunIdentity.attemptId,
              },
              expectedImageParts: turnInputContextSignals.imageParts,
            })
          : null;
        const currentVisualContextDelivery = resolveVisualContextDeliveryStateFromReceipt({
          expectedImageParts: turnInputContextSignals.imageParts,
          expectedBinding: expectedVisualTransportBinding,
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
            await callbacks.publishTurnRuntimeVisualContextCheckpoint?.({
              visualContext: publishedVisualContext,
              updatedAt: Date.now(),
            });
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
        const normalizedVisualProtocol = normalizeReservedVisualObservationProtocol({
          text: streamResult.content,
          toolCalls: streamResult.toolCalls,
          expectedTurnId: eventTurnId,
          expectedImageParts: turnInputContextSignals.imageParts,
          // Recognition belongs to the exact provider request that produced
          // this response. A prior delivered request cannot authorize metadata
          // emitted after later context trimming removed the image.
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
        const strippedActionableContent = stripVisualProtocol(streamResult.actionableContent);
        const strippedSemanticContent = stripVisualProtocol(streamResult.semanticContent);
        const strippedReasoningContent = stripVisualProtocol(streamResult.reasoningContent);
        if (
          normalizedVisualProtocol.cleanedText !== streamResult.content ||
          normalizedVisualProtocol.isolatedToolCallCount > 0 ||
          strippedActionableContent !== streamResult.actionableContent ||
          strippedSemanticContent !== streamResult.semanticContent ||
          strippedReasoningContent !== streamResult.reasoningContent
        ) {
          streamResult = {
            ...streamResult,
            content: normalizedVisualProtocol.cleanedText,
            actionableContent: strippedActionableContent,
            semanticContent: strippedSemanticContent,
            reasoningContent: strippedReasoningContent,
            toolCalls: normalizedVisualProtocol.toolCalls,
          };
        }
        if (normalizedVisualProtocol.isolatedToolCallCount > 0) {
          callbacks.onDebugEvent?.("agent.visual_observation_reserved_tool_isolated", {
            iteration,
            isolatedToolCallCount: normalizedVisualProtocol.isolatedToolCallCount,
            isolatedToolCallIds: normalizedVisualProtocol.isolatedToolCallIds,
            observationAccepted:
              normalizedVisualProtocol.observationSource === "reserved_tool_call",
            expectedImageParts: turnInputContextSignals.imageParts,
            deliveryStatus: currentVisualContextDelivery.status,
            providerNeutral: true,
          });
        }
        if (turnInputContextSignals.imageParts > 0) {
          const observation = normalizedVisualProtocol.observation;
          if (
            observation &&
            !visualRecognitionObservation
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
            await callbacks.publishTurnRuntimeVisualContextCheckpoint?.({
              visualContext,
              updatedAt: Date.now(),
            });
            const compactedVisualPayload = compactObservedVisualContextPayload(
              callbacks.getMessages(),
              {
                expectedImageParts: observation.imageCount,
                turnId: eventTurnId,
                payloadDigest: expectedVisualTransportBinding?.payloadDigest,
              },
            );
            if (compactedVisualPayload.changed) {
              callbacks.replaceMessages(compactedVisualPayload.messages);
            }
            callbacks.onDebugEvent?.("agent.visual_payload_compacted_after_observation", {
              turnId: eventTurnId,
              observationId: observation.observationId,
              removedImageParts: compactedVisualPayload.removedImageParts,
              changed: compactedVisualPayload.changed,
              providerRequestWillRetainDataUrl: !compactedVisualPayload.changed,
            });
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
          toolCatalog,
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
          onCollaborationTaskOutcomes: async (outcomes) => {
            await emitCollaborationTaskOutcomes(
              outcomes,
              "parent_final_response",
            );
          },
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
            !hasStartedCollaborationForCurrentTurn(callbacks)
          ) {
            callbacks.onDebugEvent?.("collaboration_preference_not_used", {
              iteration,
              reason: availableToolNames.has("spawn_subagent")
                ? "model_declined_after_admission"
                : toolSurfaceDecision.delegationDecision.reason,
              workflowMode,
              runtimeIntent,
              spawnToolExposed: availableToolNames.has("spawn_subagent"),
              recentToolNames: [...new Set(loopState.recentToolActivity.map((activity) => activity.name))].slice(0, 12),
            });
          }
          const completionFence = resolveStagedCompletionFence(iteration);
          if (completionFence === "continue") continue;
          if (completionFence === "pause") return;
          finishStoppedRun({
            iteration,
            fallbackReason: "assistant_stopped",
            fallbackMessage: "The assistant run stopped in a resumable state.",
          });
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
        const executionToolCalls = effectiveToolCalls;

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
          effectiveToolCalls: executionToolCalls,
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
          onSubagentSpawnCreated: async (outcome) => {
            await publishCollaborationCheckpoint();
            callbacks.onDebugEvent?.("agent.semantic_collaboration_task_spawned", {
              iteration,
              pendingSubagentIds: callbacks.getPendingSubagentIds?.() || [],
              subagentId: outcome.subagentId,
              collaborationTaskId: outcome.collaborationTaskId,
              scopeKey: outcome.scopeKey,
              allowedPaths: outcome.subagentId === null ? [] : outcome.allowedPaths,
            });
          },
          onCollaborationTaskOutcomes: async (outcomes) => {
            await emitCollaborationTaskOutcomes(outcomes, "tool_iteration");
          },
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
          const completionFence = resolveStagedCompletionFence(iteration);
          if (completionFence === "continue") continue;
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
          const completionFence = resolveStagedCompletionFence(iteration);
          if (completionFence === "continue") continue;
          return;
        }
        if (toolIterationPhase.status === "aborted") {
          emitRunPausedEvent("aborted", "The tool run was aborted and can be resumed in the same turn.");
          return;
        }
        if (toolIterationPhase.status === "stopped") {
          const completionFence = resolveStagedCompletionFence(iteration);
          if (completionFence === "continue") continue;
          if (completionFence === "pause") return;
          finishStoppedRun({
            iteration,
            fallbackReason: "tool_loop_stopped",
            fallbackMessage: "The tool loop stopped in a resumable state.",
          });
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
