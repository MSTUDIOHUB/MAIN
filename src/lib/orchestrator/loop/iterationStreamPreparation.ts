import {
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
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import type { ToolDefinition } from "../../toolSchemas";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { PlanExecutionProgressPhase } from "../../workflowModels";
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
  type ExecuteRecoveryRuntimeState,
} from "./executeRecoveryRuntime";
import type { ApprovedPlanRecoveryRuntimeState } from "./approvedPlanRecoveryRuntime";
import type { AgentLoopRuntimeState } from "./turnPreparation";
import type { PlanLoopRuntimeState } from "./planRuntimeState";
import {
  resolveFinalTextOnlyStepState,
  type AgentLoopStreamRuntimeState,
} from "./streamRuntimeState";
import {
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
  approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  toolExecutionRuntimeState: Pick<AgentLoopToolExecutionRuntimeState, "fileReadStates">;
  iterationContext: Pick<TurnIterationContext, "eventTurnId" | "turnContext">;
  turnInputContextSignals: TurnInputContextSignals;
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
    approvedPlanRecoveryState,
    planRuntimeState,
    toolExecutionRuntimeState,
    iterationContext,
    turnInputContextSignals,
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

  const rawIterationAllTools = finalTextOnlyStep || streamRuntimeState.chatFinalSynthesisActive
    ? []
    : resolveAllToolsForRuntime(runtimeIntent);
  let executeRecoveryIterationAdvance =
    advanceExecuteRecoveryRuntimeIteration(input.executeRecoveryState);
  let executeRecoveryState = executeRecoveryIterationAdvance.state;
  if (executeRecoveryIterationAdvance.reachedMaxIterations) {
    logAgentEvent("execute_recovery_max_iterations_reached", {
      iteration,
      executeRecoveryMode: executeRecoveryState.mode,
      executeRecoveryAttempts: executeRecoveryState.attempts,
      recoveryIterationCount: executeRecoveryState.iterationCount,
      maxRecoveryIterations: executeRecoveryIterationAdvance.maxIterations,
    });
    executeRecoveryState = clearExecuteRecovery(
      "max_recovery_iterations_reached",
      undefined,
      executeRecoveryState,
    );
    executeRecoveryIterationAdvance = {
      ...executeRecoveryIterationAdvance,
      state: executeRecoveryState,
    };
    callbacks.appendMessage({
      role: "system",
      content: buildExecuteRecoveryMaxIterationsPrompt({
        language: MODEL_CONTROL_LANGUAGE,
        maxIterations: executeRecoveryIterationAdvance.maxIterations,
      }),
    });
  }

  const recoverySourceContract = resolveExecuteRecoveryActionContract(executeRecoveryState.mode, {
    expectedTarget: executeRecoveryState.expectedTarget,
    readLease: executeRecoveryState.readLease,
    sourceObservationKey: executeRecoveryState.sourceObservationKey,
    decisionCheckpoint: executeRecoveryState.decisionCheckpoint,
    phaseNoProgressCount: executeRecoveryState.phaseNoProgressCount,
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
              observedVersion: freshness.observedVersion,
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
    rawIterationAllTools,
    executeRecoveryMode: executeRecoveryState.mode,
    executeRecoveryReason: executeRecoveryState.reason,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    executeRecoveryExpectedTarget: executeRecoveryState.expectedTarget,
    executeRecoveryReadLease: executeRecoveryState.readLease,
    executeRecoverySourceObservationKey: executeRecoveryState.sourceObservationKey,
    executeRecoveryDecisionCheckpoint: executeRecoveryState.decisionCheckpoint,
    recoveryIterationCount: executeRecoveryState.iterationCount,
    maxRecoveryIterations: executeRecoveryIterationAdvance.maxIterations,
    ...approvedPlanRecoveryState,
    recentToolActivity,
    recentPlanToolActivity,
    ...planRuntimeState,
    turnInputContextSignals,
    lastAssistantTextForCheckpoint,
  });
  applySystemPromptForRuntime(runtimeIntent, toolSurfaceDecision.iterationAllTools);

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
    executeRecoveryExpectedTarget: executeRecoveryState.expectedTarget,
    executeRecoverySourceObservationKey: executeRecoveryState.sourceObservationKey,
    recentToolActivity,
    fileReadStates: toolExecutionRuntimeState.fileReadStates,
    allowExecuteRecoveryFileRead: toolSurfaceDecision.allowExecuteRecoveryFileRead,
    emitPlanExecutionProgress,
  });
  let managedAgentMessages = appendActiveRuntimeGuidance({
    callbacks,
    managedAgentMessages: contextManagementResult.managedAgentMessages,
    iteration,
  });
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
      planQualityRejectCount: planRuntimeState.planQualityRejectCount,
      planAutoScaffoldPromptIssued:
        planRuntimeState.planAutoScaffoldPromptIssued,
      llmToolNames: contextManagementResult.llmTools.map(
        (tool) => tool.function.name,
      ),
      forceXmlTools: contextManagementResult.forceXmlTools,
    });

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
