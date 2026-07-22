import {
  buildExecutionActionContractCard,
  resolveExecuteRecoveryActionContract,
  summarizeRepeatedExecuteTargets,
} from "../../executeRecoveryTools";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import {
  collectPlanClosureMaterializationInput,
  logAgentEvent,
  readFileMetadataIfAvailable,
} from "../../orchestrator";
import {
  invalidateStaleFileReadStatesForPath,
  selectFileReadStateForRecoveryContext,
} from "../../orchestrator/fileReadCache";
import {
  assessPlanClosureEvidence,
  formatPlanEvidenceBundleForModel,
  isPlanEvidenceBundleReady,
} from "../../planEvidence";
import {
  resolveApprovedPlanRecoveryReconciliation,
  type PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import { buildPreferredDelegationActionContract } from "../../subagents";
import type { ToolDefinition } from "../../toolSchemas";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { PlanExecutionProgressPhase } from "../../workflowModels";
import { hasDurableExecutionProgress } from "../../verificationEvidence";
import { generateId } from "../../utils";
import type { AgentMessage, OrchestratorCallbacks } from "../types";
import {
  prepareManagedMessagesForIteration,
  resolveRecoverySourceContextFreshness,
} from "./contextManagement";
import {
  activateExecuteRecoveryRuntimeState,
  advanceExecuteRecoveryRuntimeIteration,
  buildExecuteRecoveryMaxIterationsPrompt,
  createExecuteRecoveryRuntimeState,
  resolveExecuteRecoveryNoProgressBoundary,
  shouldReleaseExecuteRecoveryPolicyBoundary,
  type ExecuteRecoveryRuntimeState,
} from "./executeRecoveryRuntime";
import type { AgentLoopRuntimeState } from "./turnPreparation";
import type { PlanLoopRuntimeState } from "./planRuntimeState";
import {
  resolveFinalTextOnlyStepState,
  type AgentLoopStreamRuntimeState,
} from "./streamRuntimeState";
import {
  buildDirectFileModifyActionContractCard,
  hasStructuredWorkspaceMutationEvidence,
  resolveIterationToolSurface,
  type IterationToolSurfaceDecision,
} from "./toolCallPlanning";
import type { AgentLoopToolExecutionRuntimeState } from "./toolExecutionRuntimeState";
import type { TurnIterationContext } from "./turnIterationContext";
import {
  resolvePreapprovalPlanQualityRecoveryStreamPolicy,
  type PreapprovalPlanQualityRecoveryStreamPolicy,
} from "./preapprovalPlanRecoveryStreamPolicy";

type RuntimeGuidanceCallbacks = Pick<
  OrchestratorCallbacks,
  "appendMessage" | "consumeActiveGuidance" | "getPreferredLanguage"
>;

export function buildRuntimeGuidanceMessage(input: {
  language: "zh" | "en";
  text: string;
}): AgentMessage {
  const guidanceText = input.text.trim();
  return {
    role: "user",
    content: input.language === "en"
      ? `Runtime guidance from the user for the current run. Treat this as high-priority direction for the next step without restarting the task:\n\n${guidanceText}`
      : `用户在当前执行中追加的运行引导。请把它作为下一步的高优先级方向，不要重启任务：\n\n${guidanceText}`,
  };
}

export function appendActiveRuntimeGuidance(input: {
  callbacks: RuntimeGuidanceCallbacks;
  managedAgentMessages: AgentMessage[];
  iteration: number;
}): AgentMessage[] {
  const activeGuidance = input.callbacks.consumeActiveGuidance?.();
  if (!activeGuidance?.text?.trim()) {
    return input.managedAgentMessages;
  }

  const guidanceText = activeGuidance.text.trim();
  const guidanceMessage = buildRuntimeGuidanceMessage({
    language: input.callbacks.getPreferredLanguage(),
    text: guidanceText,
  });
  input.callbacks.appendMessage(guidanceMessage);
  logAgentEvent("runtime_guidance_injected", {
    iteration: input.iteration,
    guidanceId: activeGuidance.id,
    chars: guidanceText.length,
  });
  return [...input.managedAgentMessages, guidanceMessage];
}

export interface IterationStreamPreparationResult {
  runtimeIntent: ResolvedUserIntent;
  streamRuntimeState: AgentLoopStreamRuntimeState;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  executeRecoveryIterationAdvance: ReturnType<typeof advanceExecuteRecoveryRuntimeIteration>;
  recoveryPause: {
    message: string;
    previousMode: ExecuteRecoveryRuntimeState["mode"];
    expectedTarget: string | null;
    phaseNoProgressCount: number;
    protocolNoProgressCount: number;
  } | null;
  finalTextOnlyStep: boolean;
  toolSurfaceDecision: IterationToolSurfaceDecision;
  managedAgentMessages: AgentMessage[];
  providerCompatibilityOverride: boolean | undefined;
  forceXmlTools: boolean;
  llmTools: ToolDefinition[];
  assistantMsgId: string;
  maxOutputEscalations: number;
  iterationRequestStartedAt: number;
  preapprovalPlanQualityRecoveryStreamPolicy: PreapprovalPlanQualityRecoveryStreamPolicy;
}

export async function prepareIterationStreamRequest(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  iteration: number;
  effectiveMaxIterations: number;
  snapshotContextLimit: number | undefined;
  streamRuntimeState: AgentLoopStreamRuntimeState;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  toolExecutionRuntimeState: Pick<AgentLoopToolExecutionRuntimeState, "fileReadStates">;
  iterationContext: Pick<TurnIterationContext, "eventTurnId" | "turnContext">;
  turnInputContextSignals: TurnInputContextSignals;
  latestUserPromptText?: string;
  preferredDelegationSatisfied?: boolean;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  lastAssistantTextForCheckpoint: string;
  mcpToolCount: number;
  resolveRuntimeIntent: () => ResolvedUserIntent;
  resolveAllToolsForRuntime: (runtimeIntent: ResolvedUserIntent) => ToolDefinition[];
  applySystemPromptForRuntime: (runtimeIntent: ResolvedUserIntent, tools: ToolDefinition[]) => void;
  clearExecuteRecovery: (
    reason: string,
    resetTarget?: string,
    stateOverride?: ExecuteRecoveryRuntimeState,
  ) => ExecuteRecoveryRuntimeState;
  getMaxOutputEscalations: () => number;
  emitPlanExecutionProgress: (phase: PlanExecutionProgressPhase) => void;
}): Promise<IterationStreamPreparationResult> {
  const {
    callbacks,
    runtimeState,
    iteration,
    effectiveMaxIterations,
    snapshotContextLimit,
    planRuntimeState,
    toolExecutionRuntimeState,
    iterationContext,
    turnInputContextSignals,
    latestUserPromptText = "",
    preferredDelegationSatisfied = false,
    recentToolActivity,
    recentPlanToolActivity,
    lastAssistantTextForCheckpoint,
    mcpToolCount,
    resolveRuntimeIntent,
    resolveAllToolsForRuntime,
    applySystemPromptForRuntime,
    clearExecuteRecovery,
    getMaxOutputEscalations,
    emitPlanExecutionProgress,
  } = input;
  const {
    config,
    isCloudProfile,
    settings,
    effectiveToolProtocol,
    turnIntent,
    workflowMode,
  } = runtimeState;

  callbacks.startNewTurn();
  const runtimeIntent = resolveRuntimeIntent();
  const finalTextOnlyDecision = resolveFinalTextOnlyStepState(input.streamRuntimeState, {
    workflowMode,
    runtimeIntent,
    isPlanApproved: callbacks.getIsPlanApproved(),
    iteration,
    maxIterations: effectiveMaxIterations,
  });
  let streamRuntimeState = finalTextOnlyDecision.state;
  const finalTextOnlyStep = finalTextOnlyDecision.finalTextOnlyStep;
  if (finalTextOnlyStep) {
    logAgentEvent("max_steps_final_text_prompt", {
      iteration,
      maxIterations: effectiveMaxIterations,
      workflowMode,
      runtimeIntent,
      repeatedTargets: summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
    });
  }

  const capabilityRuntimeIntent: ResolvedUserIntent =
    workflowMode === "chat" &&
    isMutationRuntimeIntent(turnIntent) &&
    input.executeRecoveryState.reason.startsWith("chat_repair_strategy_pivot:")
      ? "execute"
      : runtimeIntent;
  const rawIterationAllTools = finalTextOnlyStep || streamRuntimeState.chatFinalSynthesisActive
    ? []
    : resolveAllToolsForRuntime(capabilityRuntimeIntent);
  const rawIterationToolNames = new Set(
    rawIterationAllTools.map((tool) => tool.function.name),
  );
  let recoveryStateBeforeBoundary = input.executeRecoveryState;
  if (callbacks.getIsPlanApproved()) {
    const reconciliation = resolveApprovedPlanRecoveryReconciliation({
      tasks: callbacks.getPlanTasks(),
      evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
      current: recoveryStateBeforeBoundary,
      options: { availableToolNames: rawIterationToolNames },
    });
    if (reconciliation.action === "advance") {
      const previousTaskId =
        recoveryStateBeforeBoundary.decisionCheckpoint?.planTaskId || null;
      recoveryStateBeforeBoundary = createExecuteRecoveryRuntimeState({
        workflowMode,
        forcedState: reconciliation.next,
      });
      logAgentEvent("approved_plan_recovery_rebased_before_surface", {
        iteration,
        previousTaskId,
        nextTaskId:
          reconciliation.next.decisionCheckpoint?.planTaskId || null,
        nextRequiredCapability:
          reconciliation.next.decisionCheckpoint?.nextRequiredCapability || null,
        expectedTarget: reconciliation.next.expectedTarget,
      });
    } else if (reconciliation.action === "complete") {
      recoveryStateBeforeBoundary = clearExecuteRecovery(
        "approved_plan_automation_obligations_satisfied",
        undefined,
        recoveryStateBeforeBoundary,
      );
      logAgentEvent("approved_plan_recovery_released_after_evidence", {
        iteration,
        reason: "no_remaining_automatable_obligation",
      });
    }
  }
  const structuredWorkspaceMutationObserved = hasStructuredWorkspaceMutationEvidence({
    callbacks,
    recentToolActivity,
  });
  const recoveryCheckpointCapability =
    recoveryStateBeforeBoundary.decisionCheckpoint?.nextRequiredCapability || null;
  const prematureFileModifyLifecycleRecovery =
    callbacks.getCommandDirective?.()?.kind === "file_modify" &&
    workflowMode === "edit" &&
    isMutationRuntimeIntent(runtimeIntent) &&
    !callbacks.getIsPlanApproved() &&
    !structuredWorkspaceMutationObserved &&
    recoveryStateBeforeBoundary.mode !== "normal" &&
    new Set([
      "launch_long_process",
      "observe_pty",
      "browser_validation",
      "browser_diagnostic",
      "desktop_validation",
      "recover_process",
      "reconcile_server",
    ]).has(String(recoveryCheckpointCapability || ""));
  const recoveryStateForIteration = prematureFileModifyLifecycleRecovery
    ? clearExecuteRecovery(
        "file_modify_requires_structured_mutation_before_process_validation",
        undefined,
        recoveryStateBeforeBoundary,
      )
    : recoveryStateBeforeBoundary;
  if (prematureFileModifyLifecycleRecovery) {
    logAgentEvent("premature_file_modify_lifecycle_recovery_cleared", {
      iteration,
      previousMode: recoveryStateBeforeBoundary.mode,
      previousCapability: recoveryCheckpointCapability,
      expectedTarget: input.executeRecoveryState.expectedTarget,
      structuredMutationObserved: false,
      nextPhase: "source_change",
    });
  }
  let executeRecoveryIterationAdvance =
    advanceExecuteRecoveryRuntimeIteration(recoveryStateForIteration);
  let executeRecoveryState = executeRecoveryIterationAdvance.state;
  let recoveryPause: IterationStreamPreparationResult["recoveryPause"] = null;
  let recoveryBoundaryReleaseNotice = "";
  if (executeRecoveryIterationAdvance.reachedMaxIterations) {
    const exhaustedState = executeRecoveryState;
    const exhaustedContract = resolveExecuteRecoveryActionContract(
      exhaustedState.mode,
      {
        expectedTarget: exhaustedState.expectedTarget,
        readLease: exhaustedState.readLease,
        sourceObservationKey: exhaustedState.sourceObservationKey,
        decisionCheckpoint: exhaustedState.decisionCheckpoint,
        phaseNoProgressCount: exhaustedState.phaseNoProgressCount,
        protocolNoProgressCount: exhaustedState.protocolNoProgressCount,
        protocolNoProgressFingerprint:
          exhaustedState.protocolNoProgressFingerprint,
      },
    );
    const releasePolicyBoundary = shouldReleaseExecuteRecoveryPolicyBoundary({
      state: exhaustedState,
      hasDurableEvidence: hasDurableExecutionProgress({
        ledger: callbacks.getPlanExecutionEvidenceLedger(),
        transactionId: iterationContext.eventTurnId,
        recoveryActionContract: exhaustedContract,
      }),
      maxIterations: executeRecoveryIterationAdvance.maxIterations,
    });
    let boundaryDisposition = "pause";
    if (releasePolicyBoundary) {
      executeRecoveryState = clearExecuteRecovery(
        "policy_no_progress_boundary_released",
        undefined,
        executeRecoveryState,
      );
      recoveryBoundaryReleaseNotice = callbacks.getPreferredLanguage() === "zh"
        ? "RECOVERY_POLICY_BOUNDARY_RELEASED: 已保留本轮真实执行证据，并释放了过期的窄事务目标。请使用当前完整但仍受批准范围约束的工具面继续下一项未完成工作或验证；不要重复刚才被策略推迟的同一调用。"
        : "RECOVERY_POLICY_BOUNDARY_RELEASED: durable evidence from this turn was retained and the stale narrow transaction target was released. Continue the next unfinished approved action or validation with the current full, still scope-constrained tool surface; do not repeat the same policy-deferred call.";
      boundaryDisposition = "normal_surface_continuation";
      logAgentEvent("execute_recovery_policy_boundary_released", {
        iteration,
        previousMode: exhaustedState.mode,
        previousTarget: exhaustedState.expectedTarget,
        protocolNoProgressCount: exhaustedState.protocolNoProgressCount,
      });
    } else {
      const currentTaskId = exhaustedState.decisionCheckpoint?.planTaskId || "";
      const currentTask = callbacks.getPlanTasks().find((task) =>
        currentTaskId && String(task.id || "") === currentTaskId
      );
      const strategyBoundary = resolveExecuteRecoveryNoProgressBoundary({
        state: exhaustedState,
        cause: "execute_recovery_phase_budget",
        language: callbacks.getPreferredLanguage(),
        availableToolNames: rawIterationToolNames,
        unfinishedObjective: currentTask?.text || latestUserPromptText,
      });
      if (strategyBoundary.decision.action === "continue_with_pivot") {
        executeRecoveryState = strategyBoundary.state;
        recoveryBoundaryReleaseNotice = strategyBoundary.decision.prompt;
        boundaryDisposition = `strategy_pivot:${strategyBoundary.decision.strategy}`;
        logAgentEvent("execute_recovery_strategy_pivot", {
          iteration,
          strategy: strategyBoundary.decision.strategy,
          attemptedStrategies: strategyBoundary.decision.attemptedStrategies,
          currentTaskId: executeRecoveryState.decisionCheckpoint?.planTaskId || null,
          expectedTarget: executeRecoveryState.expectedTarget,
        });
      } else {
        const pauseMessage = buildExecuteRecoveryMaxIterationsPrompt({
          language: callbacks.getPreferredLanguage(),
          maxIterations: executeRecoveryIterationAdvance.maxIterations,
        });
        recoveryPause = {
          message: pauseMessage,
          previousMode: exhaustedState.mode,
          expectedTarget: exhaustedState.expectedTarget,
          phaseNoProgressCount: exhaustedState.phaseNoProgressCount,
          protocolNoProgressCount: exhaustedState.protocolNoProgressCount,
        };
        executeRecoveryState = clearExecuteRecovery(
          "max_recovery_iterations_reached",
          undefined,
          executeRecoveryState,
        );
      }
    }
    logAgentEvent("execute_recovery_max_iterations_reached", {
      iteration,
      executeRecoveryMode: exhaustedState.mode,
      executeRecoveryAttempts: exhaustedState.attempts,
      recoveryIterationCount: exhaustedState.iterationCount,
      protocolNoProgressCount: exhaustedState.protocolNoProgressCount,
      protocolNoProgressFingerprint: exhaustedState.protocolNoProgressFingerprint,
      maxRecoveryIterations: executeRecoveryIterationAdvance.maxIterations,
      attemptedStrategies:
        exhaustedState.decisionCheckpoint?.noProgressStrategyPivots || [],
      disposition: boundaryDisposition,
    });
    executeRecoveryIterationAdvance = {
      ...executeRecoveryIterationAdvance,
      state: executeRecoveryState,
      reachedMaxIterations: recoveryPause !== null,
    };
  }

  const recoverySourceContract = resolveExecuteRecoveryActionContract(executeRecoveryState.mode, {
    expectedTarget: executeRecoveryState.expectedTarget,
    readLease: executeRecoveryState.readLease,
    sourceObservationKey: executeRecoveryState.sourceObservationKey,
    decisionCheckpoint: executeRecoveryState.decisionCheckpoint,
    phaseNoProgressCount: executeRecoveryState.phaseNoProgressCount,
    protocolNoProgressCount: executeRecoveryState.protocolNoProgressCount,
    protocolNoProgressFingerprint: executeRecoveryState.protocolNoProgressFingerprint,
  });
  if (
    executeRecoveryState.sourceObservationKey &&
    executeRecoveryState.expectedTarget &&
    (recoverySourceContract.phase === "context" || recoverySourceContract.phase === "mutation")
  ) {
    const sourceState = selectFileReadStateForRecoveryContext({
      states: toolExecutionRuntimeState.fileReadStates,
      targetPath: executeRecoveryState.expectedTarget,
      observationKey: executeRecoveryState.sourceObservationKey,
    });
    if (sourceState) {
      const currentMetadata = await readFileMetadataIfAvailable(sourceState.path, runtimeState.config.workspace);
      const freshness = resolveRecoverySourceContextFreshness({
        state: sourceState,
        currentMetadata,
      });
      if (!freshness.current) {
        const invalidatedSignatures = currentMetadata
          ? invalidateStaleFileReadStatesForPath({
              states: toolExecutionRuntimeState.fileReadStates,
              path: currentMetadata.path,
              sizeBytes: currentMetadata.sizeBytes,
              modifiedMs: currentMetadata.modifiedMs,
            })
          : [...toolExecutionRuntimeState.fileReadStates.entries()]
              .filter(([, state]) => state === sourceState)
              .map(([signature]) => {
                toolExecutionRuntimeState.fileReadStates.delete(signature);
                return signature;
              });
        const target = executeRecoveryState.expectedTarget;
        const nextCheckpoint = {
          expectedTarget: target,
          sourceObservationKey: null,
          nextRequiredCapability: "targeted_read" as const,
          evidenceVersion: freshness.currentVersion,
        };
        executeRecoveryState = {
          ...activateExecuteRecoveryRuntimeState(executeRecoveryState, {
            mode: "patch_recovery_read",
            reason: "recovery_source_version_changed",
            expectedTarget: target,
            readLease: {
              purpose: "context_restore",
              target,
              ...(sourceState.window
                ? {
                    requestedRange: {
                      startLine: sourceState.window.startLine,
                      endLine: sourceState.window.endLine,
                      maxLines: Math.max(
                        1,
                        sourceState.window.endLine - sourceState.window.startLine + 1,
                      ),
                    },
                  }
                : {}),
              // This is the version the recovery read is expected to observe,
              // not the stale version that triggered invalidation.
              observedVersion: freshness.currentVersion,
              state: "available",
            },
            decisionCheckpoint: nextCheckpoint,
          }),
          sourceObservationKey: null,
          decisionCheckpoint: nextCheckpoint,
        };
        callbacks.appendMessage({
          role: "system",
          content: `RECOVERY_SOURCE_VERSION_CHANGED: The retained source observation for ${target} is no longer current (${freshness.observedVersion} -> ${freshness.currentVersion || "unknown"}). Read the exact target range again before modifying it; do not reuse the stale cached window.`,
        });
        logAgentEvent("execute_recovery_source_context_invalidated", {
          iteration,
          target,
          reason: freshness.reason,
          observedVersion: freshness.observedVersion,
          currentVersion: freshness.currentVersion,
          invalidatedCount: invalidatedSignatures.length,
          nextCapability: "targeted_read",
        });
      }
    }
  }

  const toolSurfaceDecision = resolveIterationToolSurface({
    callbacks,
    iteration,
    workflowMode,
    runtimeIntent,
    turnIntent,
    rawIterationAllTools,
    executeRecoveryMode: executeRecoveryState.mode,
    executeRecoveryReason: executeRecoveryState.reason,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    executeRecoveryExpectedTarget: executeRecoveryState.expectedTarget,
    executeRecoveryReadLease: executeRecoveryState.readLease,
    executeRecoverySourceObservationKey: executeRecoveryState.sourceObservationKey,
    executeRecoveryDecisionCheckpoint: executeRecoveryState.decisionCheckpoint,
    executeRecoveryProtocolNoProgressCount: executeRecoveryState.protocolNoProgressCount,
    executeRecoveryProtocolNoProgressFingerprint: executeRecoveryState.protocolNoProgressFingerprint,
    recoveryIterationCount: executeRecoveryState.iterationCount,
    maxRecoveryIterations: executeRecoveryIterationAdvance.maxIterations,
    recentToolActivity,
    recentPlanToolActivity,
    ...planRuntimeState,
    turnInputContextSignals,
    latestUserPromptText,
    lastAssistantTextForCheckpoint,
    preferredDelegationSatisfied,
  });
  applySystemPromptForRuntime(capabilityRuntimeIntent, toolSurfaceDecision.iterationAllTools);

  const contextManagementResult = prepareManagedMessagesForIteration({
    callbacks,
    config,
    settings,
    isCloudProfile,
    iteration,
    workflowMode,
    iterationContext,
    iterationAllTools: toolSurfaceDecision.iterationAllTools,
    snapshotContextLimit,
    isExecuteRecoveryEligible: toolSurfaceDecision.isExecuteRecoveryEligible,
    executeRecoveryMode: executeRecoveryState.mode,
    executeRecoveryReason: executeRecoveryState.reason,
    recoveryActionContract: toolSurfaceDecision.recoveryActionContract,
    executeRecoveryExpectedTarget: executeRecoveryState.expectedTarget,
    executeRecoverySourceObservationKey: executeRecoveryState.sourceObservationKey,
    executeRecoverySourceObservationKeys: executeRecoveryState.readLease?.observationKeys || [],
    recentToolActivity,
    fileReadStates: toolExecutionRuntimeState.fileReadStates,
    emitPlanExecutionProgress,
  });
  let managedAgentMessages = appendActiveRuntimeGuidance({
    callbacks,
    managedAgentMessages: contextManagementResult.managedAgentMessages,
    iteration,
  });
  if (toolSurfaceDecision.preferredDelegationRequirement.required) {
    const delegationContract = buildPreferredDelegationActionContract({
      language: callbacks.getPreferredLanguage(),
      candidateScopeKeys:
        toolSurfaceDecision.preferredDelegationRequirement.candidateScopeKeys,
    });
    managedAgentMessages = [
      ...managedAgentMessages,
      { role: "system", content: delegationContract },
    ];
    logAgentEvent("preferred_delegation_action_contract_injected", {
      iteration,
      candidateScopeKeys:
        toolSurfaceDecision.preferredDelegationRequirement.candidateScopeKeys,
      toolNames: toolSurfaceDecision.iterationAllTools.map((tool) =>
        tool.function.name
      ),
      toolChoiceRequired: !contextManagementResult.forceXmlTools,
    });
  }
  if (recoveryBoundaryReleaseNotice) {
    managedAgentMessages = [
      ...managedAgentMessages,
      { role: "system", content: recoveryBoundaryReleaseNotice },
    ];
  }
  if (
    toolSurfaceDecision.recoveryActionContract.phase !== "normal" ||
    toolSurfaceDecision.recoveryActionContract.modeLabel === "objective_audit"
  ) {
    const contractCard = buildExecutionActionContractCard({
      contract: toolSurfaceDecision.recoveryActionContract,
      language: MODEL_CONTROL_LANGUAGE,
      turnObjective: latestUserPromptText,
      availableToolNames: toolSurfaceDecision.iterationAllTools.map(
        (tool) => tool.function.name,
      ),
    });
    managedAgentMessages = [
      ...managedAgentMessages,
      { role: "system", content: contractCard },
    ];
    logAgentEvent("execution_action_contract_injected", {
      iteration,
      phase: toolSurfaceDecision.recoveryActionContract.phase,
      nextRequiredCapability:
        toolSurfaceDecision.recoveryActionContract.nextRequiredCapability,
      expectedTarget: toolSurfaceDecision.recoveryActionContract.expectedTarget,
      sourceObservationKey:
        toolSurfaceDecision.recoveryActionContract.sourceObservationKey,
      toolCount: toolSurfaceDecision.iterationAllTools.length,
    });
  } else if (toolSurfaceDecision.directFileModifyPhase) {
    managedAgentMessages = [
      ...managedAgentMessages,
      {
        role: "system",
        content: buildDirectFileModifyActionContractCard({
          phase: toolSurfaceDecision.directFileModifyPhase,
          availableToolNames: toolSurfaceDecision.iterationAllTools.map(
            (tool) => tool.function.name,
          ),
        }),
      },
    ];
    logAgentEvent("direct_file_modify_action_contract_injected", {
      iteration,
      phase: toolSurfaceDecision.directFileModifyPhase,
      toolCount: toolSurfaceDecision.iterationAllTools.length,
      structuredMutationObserved:
        toolSurfaceDecision.directFileModifyPhase === "validation",
    });
  }
  const shouldInjectPlanEvidenceBundle =
    workflowMode === "plan" &&
    !callbacks.getIsPlanApproved() &&
    ["synthesis", "drafting", "needs_rewrite", "review_ready"].includes(planRuntimeState.planRuntimePhase);
  if (shouldInjectPlanEvidenceBundle) {
    const closureInput = collectPlanClosureMaterializationInput(
      callbacks,
      recentPlanToolActivity,
      [],
      "",
    );
    const bundle = closureInput.evidenceBundle;
    const closureAssessment = assessPlanClosureEvidence(bundle);
    managedAgentMessages = [
      ...managedAgentMessages,
      {
        role: "system",
        content: formatPlanEvidenceBundleForModel(bundle, MODEL_CONTROL_LANGUAGE),
      },
    ];
    logAgentEvent("plan_evidence_bundle_injected", {
      iteration,
      planRuntimePhase: planRuntimeState.planRuntimePhase,
      evidenceBundleId: bundle.bundleId,
      evidenceBundleHash: bundle.hash,
      objectiveChars: bundle.objective.length,
      semanticFacts: bundle.facts.length,
      changeTargets: bundle.changeTargets.length,
      verificationTargets: bundle.verificationTargets.length,
      bundleReady: isPlanEvidenceBundleReady(bundle),
      closureReady: closureAssessment.ready,
      ready: closureAssessment.ready,
      closureReason: closureAssessment.reason,
      objectiveTargetMatches: closureAssessment.objectiveTargetMatches,
      defectSignalMatches: closureAssessment.defectSignalMatches,
      contractMismatchMatches: closureAssessment.contractMismatchMatches,
      contractMismatchKinds: closureAssessment.contractMismatchKinds,
      unresolvedContractKinds: closureAssessment.unresolvedContractKinds,
      transcriptToolMessages: managedAgentMessages.filter((message) => message.role === "tool").length,
    });
  }

  const assistantMsgId = generateId();
  const maxOutputEscalations = getMaxOutputEscalations();
  const iterationRequestStartedAt = Date.now();
  const preapprovalPlanQualityRecoveryStreamPolicy =
    resolvePreapprovalPlanQualityRecoveryStreamPolicy({
      workflowMode,
      isPlanApproved: callbacks.getIsPlanApproved(),
      planRuntimePhase: planRuntimeState.planRuntimePhase,
      planAutoScaffoldPromptIssued:
        planRuntimeState.planAutoScaffoldPromptIssued,
      llmToolNames: contextManagementResult.llmTools.map(
        (tool) => tool.function.name,
      ),
      forceXmlTools: contextManagementResult.forceXmlTools,
    });

  callbacks.onToolSurfaceResolved?.(
    toolSurfaceDecision.iterationAllTools.map((tool) => tool.function.name),
  );

  callbacks.onDebugEvent?.("agent.iteration_start", {
    iteration,
    workflowMode,
    turnIntent,
    runtimeIntent,
    messagesLen: managedAgentMessages.length,
    allTools: toolSurfaceDecision.iterationAllTools.length,
    llmTools: contextManagementResult.llmTools.length,
    toolProtocol: effectiveToolProtocol,
    xmlToolsEnabled: true,
    mcpTools: mcpToolCount,
    currentMaxTokens: streamRuntimeState.currentMaxTokens ?? "default",
    preapprovalPlanQualityRecovery: preapprovalPlanQualityRecoveryStreamPolicy.active
      ? {
          stage: preapprovalPlanQualityRecoveryStreamPolicy.stage,
          maxOutputTokens:
            preapprovalPlanQualityRecoveryStreamPolicy.maxOutputTokens,
          maxStreamElapsedMs:
            preapprovalPlanQualityRecoveryStreamPolicy.maxStreamElapsedMs,
          toolChoice:
            preapprovalPlanQualityRecoveryStreamPolicy.toolChoice ?? null,
          stopClass: preapprovalPlanQualityRecoveryStreamPolicy.stopClass,
        }
      : null,
  });
  callbacks.onHarnessRunUpdate?.({
    status: "running",
    iteration,
    maxIterations: effectiveMaxIterations,
    workflowMode,
    runtimeIntent,
    planStage: callbacks.getPlanStage(),
    isPlanApproved: callbacks.getIsPlanApproved(),
    messagesLen: managedAgentMessages.length,
    toolCount: toolSurfaceDecision.iterationAllTools.length,
    activeStreamId: null,
    streamStatus: "iteration_started",
    streamChunkCount: 0,
    streamByteCount: 0,
    lastStreamError: null,
  });

  return {
    runtimeIntent,
    streamRuntimeState,
    executeRecoveryState,
    executeRecoveryIterationAdvance,
    recoveryPause,
    finalTextOnlyStep,
    toolSurfaceDecision,
    managedAgentMessages,
    providerCompatibilityOverride:
      contextManagementResult.providerCompatibilityOverride,
    forceXmlTools: contextManagementResult.forceXmlTools,
    llmTools: contextManagementResult.llmTools,
    assistantMsgId,
    maxOutputEscalations,
    iterationRequestStartedAt,
    preapprovalPlanQualityRecoveryStreamPolicy,
  };
}
