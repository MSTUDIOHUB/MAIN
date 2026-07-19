import type { MainModeKey } from "../../mainModes";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import type { EffectiveTurnContract } from "../../runIntent";
import { logAgentEvent } from "../../orchestrator";
import type { TaskOrchestratorPhase } from "../../taskTargeting";
import type { MainThreadEventInput } from "../../turnEvents";
import type {
  NormalizedStreamState,
  PlanExecutionProgressPhase,
  PlanExecutionProgressUpdate,
  PlanTaskEvidenceAudit,
  ReplyOption,
} from "../../workflowModels";
import type { OrchestratorCallbacks, ToolCallToExecute } from "../types";
import { handleApprovedPlanFinalization } from "./approvedPlanFinalization";
import type { ProviderReasoningForHistory } from "./assistantResponseProcessing";
import { handleExecuteNoToolRecovery } from "./executeNoToolRecovery";
import { handleFinalNoToolAssistantTurn, handleReplyOptionsPause } from "./finalTurnCompletion";
import { handleMissingToolNoToolRecovery } from "./missingToolNoToolRecovery";
import type { AgentLoopNoToolRuntimeState } from "./noToolRuntimeState";
import {
  applyConsecutiveNoToolRuntimeState,
  applyRecoveringFromEmptyAssistantReplyRuntimeState,
} from "./noToolRuntimeState";
import { handlePlanNoToolRecovery } from "./planNoToolRecovery";
import type { PlanLoopRuntimeState } from "./planRuntimeState";
import { applyPlanNoToolRuntimeState, applyPlanRuntimePhase } from "./planRuntimeState";
import type { TurnIterationContext } from "./turnIterationContext";
import { joinPendingSubagentsForParent } from "./subagentJoinRuntime";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import type { ExecuteRecoveryMode, RecoveryReadLease } from "../../executeRecoveryTools";
import { resolvePreCompletionEvidenceRecoveryDecision } from "./preCompletionEvidenceRecovery";
import { resolveCommandEvidenceRequirements } from "../../verificationEvidence";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../workspaceMutationTools";
import { workspacePathsReferToSameFile } from "../../workspacePaths";

type WorkflowMode = "chat" | "edit" | "plan";

// Semantic fingerprints reject an identical validation-to-mutation retry.
// This higher independent-action ceiling is only a final safety fuse for
// objectives that legitimately require several distinct edits.
export const MAX_VALIDATION_MUTATION_REOPENS = 8;

export interface RecoveryReadObservationResolution {
  key: string;
  path: string;
  requestSignature: string;
  versionToken: string;
  requestedRange?: { startLine?: number; endLine?: number; maxLines?: number } | null;
}

export function objectiveAuditHasCurrentClosureEvidence(
  recoveryState: ExecuteRecoveryRuntimeState,
): boolean {
  const checkpoint = recoveryState.decisionCheckpoint;
  if (
    checkpoint?.objectiveClosurePending !== true ||
    checkpoint.objectiveKind !== "root"
  ) {
    return false;
  }
  const revision = Math.max(
    1,
    Math.floor(Number(checkpoint.objectiveRevision) || 1),
  );
  if (checkpoint.objectiveValidationEvidence?.revision !== revision) return false;
  const mutationEvidence = checkpoint.objectiveMutationEvidence || [];
  if (mutationEvidence.length === 0) return false;
  const expectedTargets = checkpoint.objectiveExpectedTargets?.length
    ? checkpoint.objectiveExpectedTargets
    : recoveryState.expectedTarget
      ? [recoveryState.expectedTarget]
      : [];
  return expectedTargets.length > 0 && expectedTargets.every((target) =>
    mutationEvidence.some((entry) =>
      workspacePathsReferToSameFile(entry.target, target)
    )
  );
}

export function resolveValidationMutationReopenTargetBinding(input: {
  recoveryState: ExecuteRecoveryRuntimeState;
  requestedTarget: string | null;
  reusableObservation: RecoveryReadObservationResolution | null;
}): {
  mode: "mutation_first" | "patch_recovery_read";
  targetChanged: boolean;
  expectedTarget: string | null;
  sourceObservationKey: string | null;
  readLease: RecoveryReadLease | null;
} {
  const expectedTarget = input.requestedTarget || input.recoveryState.expectedTarget;
  const targetChanged = Boolean(
    input.requestedTarget &&
    (
      !input.recoveryState.expectedTarget ||
      !workspacePathsReferToSameFile(
        input.requestedTarget,
        input.recoveryState.expectedTarget,
      )
    ),
  );
  if (!targetChanged || !expectedTarget) {
    return {
      mode: "mutation_first",
      targetChanged,
      expectedTarget,
      sourceObservationKey: input.recoveryState.sourceObservationKey,
      readLease: input.recoveryState.readLease,
    };
  }
  if (input.reusableObservation) {
    return {
      mode: "mutation_first",
      targetChanged: true,
      expectedTarget,
      sourceObservationKey: input.reusableObservation.key,
      readLease: {
        purpose: "context_restore",
        target: expectedTarget,
        requestedRange: input.reusableObservation.requestedRange,
        observationKey: input.reusableObservation.key,
        observedVersion: input.reusableObservation.versionToken,
        state: "consumed",
      },
    };
  }
  return {
    mode: "patch_recovery_read",
    targetChanged: true,
    expectedTarget,
    sourceObservationKey: null,
    readLease: {
      purpose: "missing_window",
      target: expectedTarget,
      state: "available",
    },
  };
}

type EmitTaskOrchestratorPhase = (
  phase: TaskOrchestratorPhase,
  extra?: Record<string, unknown>,
) => void;

type EmitPlanExecutionProgress = (
  phase: PlanExecutionProgressPhase,
  overrides?: Partial<PlanExecutionProgressUpdate>,
) => void;

export type AssistantCompletionPhaseResult = {
  status: "completed" | "continue" | "stopped";
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
};

function stableEditFingerprintHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableSerializeEditArgs(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableSerializeEditArgs).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerializeEditArgs(entry)}`)
    .join(",")}}`;
}

function resolveEditLocusSeed(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === "replace_in_file") {
    const searchText = String(
      args.search_text ?? args.old_text ?? args.oldString ?? args.search ??
      "",
    );
    const replaceText = String(
      args.replace_text ?? args.new_text ?? args.newString ?? args.replace ?? "",
    );
    return `${searchText}\u0000${replaceText}`;
  }
  if (toolName === "apply_patch") return String(args.patch || "");
  if (toolName === "write_file") return String(args.content || "");
  return stableSerializeEditArgs(args);
}

export function resolveValidationMutationReopen(input: {
  recoveryState: ExecuteRecoveryRuntimeState;
  protocolViolation?: NormalizedStreamState["protocolViolation"];
  protocolActualTools?: string[];
  protocolActualToolCalls?: NormalizedStreamState["protocolActualToolCalls"];
}): {
  requestedTools: string[];
  requestedTargets: string[];
  semanticFingerprints: string[];
  budgetExhausted: boolean;
} | null {
  const validationActive =
    input.recoveryState.mode === "validation_only" ||
    input.recoveryState.mode === "finite_validation_only" ||
    input.recoveryState.decisionCheckpoint?.nextRequiredCapability === "validation";
  if (!validationActive) return null;
  if (
    input.protocolViolation !== "required_tool_call_not_available" &&
    input.protocolViolation !== "required_function_call_mismatch"
  ) return null;

  const requestedTools = [...new Set((input.protocolActualTools || [])
    .filter((name) => isWorkspaceMutationToolName(name)))];
  if (requestedTools.length === 0) return null;

  const requestedMutationIntents = (input.protocolActualToolCalls || [])
    .filter((call) => isWorkspaceMutationToolName(call.name))
    .flatMap((call) => {
      try {
        const parsed = JSON.parse(call.arguments || "{}");
        const args = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
        const locusHash = stableEditFingerprintHash(resolveEditLocusSeed(call.name, args));
        const targets = resolveWorkspaceMutationTargets(call.name, args);
        return (targets.length > 0 ? targets : [""]).map((target) => ({
          toolName: call.name,
          target: target.replace(/\\/g, "/").trim(),
          locusHash,
        }));
      } catch {
        return [];
      }
    });
  const canonicalMutationIntents = requestedMutationIntents.map((intent) => ({
    ...intent,
    target:
      intent.target &&
      input.recoveryState.expectedTarget &&
      workspacePathsReferToSameFile(intent.target, input.recoveryState.expectedTarget)
        ? input.recoveryState.expectedTarget
        : intent.target,
  }));
  const requestedTargets = [...new Set(canonicalMutationIntents
    .map((intent) => intent.target)
    .filter(Boolean))];
  const checkpoint = input.recoveryState.decisionCheckpoint;
  const requirementRef = checkpoint?.requirementRef?.trim().toLowerCase() || "";
  const semanticFingerprints = canonicalMutationIntents.length > 0
    ? canonicalMutationIntents.map((intent) => [
        `tool:${intent.toolName.toLowerCase()}`,
        intent.target ? `target:${intent.target.toLowerCase()}` : "target:(unknown)",
        `locus:${intent.locusHash}`,
        requirementRef ? `requirement:${requirementRef}` : "",
      ].filter(Boolean).join("|"))
    : input.recoveryState.expectedTarget
      ? [[
          `target:${input.recoveryState.expectedTarget.replace(/\\/g, "/").toLowerCase()}`,
          requirementRef ? `requirement:${requirementRef}` : "",
          `tools:${requestedTools.slice().sort().join(",")}`,
        ].filter(Boolean).join("|")]
    : requirementRef
      ? [`requirement:${requirementRef}`]
      : [`objective-tools:${requestedTools.slice().sort().join(",")}`];
  const spentFingerprints = new Set(
    (checkpoint?.validationMutationReopenFingerprints || [])
      .map((fingerprint) => fingerprint.trim().toLowerCase())
      .filter(Boolean),
  );
  const newSemanticFingerprints = [...new Set(semanticFingerprints.filter((fingerprint) =>
    !spentFingerprints.has(fingerprint.toLowerCase())
  ))];
  if (newSemanticFingerprints.length === 0) return null;
  const reopenCount = Math.max(
    0,
    Math.floor(Number(checkpoint?.validationMutationReopenCount) || 0),
  );
  return {
    requestedTools,
    requestedTargets,
    semanticFingerprints: newSemanticFingerprints,
    budgetExhausted: reopenCount >= MAX_VALIDATION_MUTATION_REOPENS,
  };
}

export async function handleAssistantCompletionPhase(input: {
  callbacks: OrchestratorCallbacks;
  activeProfile: string;
  iteration: number;
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  effectiveTurnContract: EffectiveTurnContract | null;
  mainModeKey?: MainModeKey;
  commandDirectiveAction?: string | null;
  workspace: string;
  latestUserPromptText: string;
  forceXmlTools: boolean;
  availableToolNames: Set<string>;
  effectiveToolCalls: ToolCallToExecute[];
  finalReplyOptions: ReplyOption[];
  shouldPauseForUserChoice: boolean;
  shouldSuppressApprovedPlanNoToolText: boolean;
  hasStructuredProposal: boolean;
  currentPlanStageForReview: ReturnType<OrchestratorCallbacks["getPlanStage"]>;
  approvedPlanAuditForNoTool: PlanTaskEvidenceAudit | null;
  rejectedCompletionClaim: boolean;
  wasTruncated: boolean;
  sawExecuteOperationEvidence: boolean;
  normalized: NormalizedStreamState;
  streamText: string;
  recentPlanToolActivity: PlanToolActivitySummary[];
  recentToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  sourceVisibleText: string;
  assistantHistoryText: string;
  providerReasoningForHistory: ProviderReasoningForHistory;
  assistantMsgId: string;
  hasReviewablePlanArtifacts: boolean;
  hasExecutablePlanProposalOptions: boolean;
  planReplyOptionsRoutedToArtifact: boolean;
  hasMeaningfulVisibleText: boolean;
  visibleAssistantText: string;
  userVisibleText: string;
  compactedProseCodeDump: boolean;
  hiddenThoughtOnlyNoToolStop: boolean;
  recentSuccessfulProjectWrite?: {
    name?: string | null;
    target?: string | null;
  } | null;
  recoveringFromEmptyAssistantReplyAfterWrite: boolean;
  turnInputContextSignals: Parameters<typeof handlePlanNoToolRecovery>[0]["turnInputContextSignals"];
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  unityConsoleDiagnosticsRequested: boolean;
  unityConsoleFinalVerificationRequired: boolean;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId">;
  emitTurnEvent: (event: MainThreadEventInput) => void;
  emitTurnCompletedEvent: () => void;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  emitPlanExecutionProgress: EmitPlanExecutionProgress;
  setPlanRuntimePhase: Parameters<typeof handlePlanNoToolRecovery>[0]["setPlanRuntimePhase"];
  waitForPlanApprovalIfNeeded: Parameters<typeof handlePlanNoToolRecovery>[0]["waitForPlanApprovalIfNeeded"];
  tryClosePlanWithEvidence: Parameters<typeof handlePlanNoToolRecovery>[0]["tryClosePlanWithEvidence"];
  getExecuteRecoveryState: () => ExecuteRecoveryRuntimeState;
  clearExecuteRecovery: (
    reason: string,
    resetTarget?: string,
    stateOverride?: ExecuteRecoveryRuntimeState,
  ) => ExecuteRecoveryRuntimeState;
  resolveRecoveryReadObservation?: (
    target: string,
  ) => Promise<RecoveryReadObservationResolution | null>;
  activateExecuteRecovery: (
    mode: Exclude<ExecuteRecoveryMode, "normal">,
    reason: string,
    context?: Record<string, unknown>,
  ) => void;
}): Promise<AssistantCompletionPhaseResult> {
  let noToolRuntimeState = input.noToolRuntimeState;
  let planRuntimeState = input.planRuntimeState;
  const effectiveToolCallCount = input.effectiveToolCalls.length;
  const completion = {
    assistantHistoryText: input.assistantHistoryText,
    providerReasoningForHistory: input.providerReasoningForHistory,
    assistantMsgId: input.assistantMsgId,
    iterationContext: input.iterationContext,
    emitTurnEvent: input.emitTurnEvent,
    emitTurnCompletedEvent: input.emitTurnCompletedEvent,
  };

  if (
    effectiveToolCallCount === 0 &&
    await joinPendingSubagentsForParent({
      callbacks: input.callbacks,
      recentToolActivity: input.recentToolActivity,
      recentPlanToolActivity: input.recentPlanToolActivity,
      reason: "parent_final_response",
    })
  ) {
    input.callbacks.onStatusChange("running");
    return finish("continue");
  }

  const replyOptionsPause = handleReplyOptionsPause({
    callbacks: input.callbacks,
    iteration: input.iteration,
    shouldPauseForUserChoice: input.shouldPauseForUserChoice,
    shouldSuppressApprovedPlanNoToolText: input.shouldSuppressApprovedPlanNoToolText,
    replyOptions: input.finalReplyOptions,
    effectiveToolCallCount,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
    hasStructuredProposal: input.hasStructuredProposal,
    planStage: input.currentPlanStageForReview,
    isPlanApproved: input.callbacks.getIsPlanApproved(),
    completion,
  });
  if (replyOptionsPause.status === "stopped") {
    return finish("stopped");
  }

  if (effectiveToolCallCount > 0) {
    return finish("completed");
  }

  // Runtime evidence owns the next action before any prose-based missing-tool
  // heuristic. A completion-looking sentence cannot redirect a known ledger
  // gap into a generic reprompt or end the turn.
  const externalReviewIsAdvisory = Boolean(
    input.callbacks.getIsPlanApproved() &&
    input.approvedPlanAuditForNoTool?.acceptedCompletion &&
    input.approvedPlanAuditForNoTool.pendingExternalValidation
  );
  let currentExecuteRecoveryState = input.getExecuteRecoveryState();
  const preCompletionRecovery = resolvePreCompletionEvidenceRecoveryDecision({
    ledger: input.callbacks.getPlanExecutionEvidenceLedger(),
    // Manual/user review remains an advisory conclusion. It never turns off
    // the independent post-mutation automatic validation contract.
    validationExpected: input.effectiveTurnContract?.validationExpected === true,
    mutationExpected: input.effectiveTurnContract?.mutationExpected === true,
    transactionId: input.iterationContext.eventTurnId,
    requiredCommandEvidence: resolveCommandEvidenceRequirements({
      tasks: input.callbacks.getIsPlanApproved()
        ? input.callbacks.getPlanTasks()
        : [],
      commandDirective: input.callbacks.getCommandDirective?.() || null,
    }),
    currentRecoveryMode: currentExecuteRecoveryState.mode,
    currentRequiredCapability:
      currentExecuteRecoveryState.decisionCheckpoint?.nextRequiredCapability || null,
    availableToolNames: input.availableToolNames,
  });
  if (preCompletionRecovery) {
    input.callbacks.onStreamToken("__ESCALATION_RESET__:evidence_recovery", input.assistantMsgId);
    input.activateExecuteRecovery(
      preCompletionRecovery.mode,
      preCompletionRecovery.reason,
      {
        expectedTarget: preCompletionRecovery.expectedTarget,
        evidenceGap: preCompletionRecovery.gap,
        nextRequiredCapability: preCompletionRecovery.nextRequiredCapability,
        decisionCheckpoint: {
          expectedTarget: preCompletionRecovery.expectedTarget,
          sourceObservationKey: null,
          nextRequiredCapability: preCompletionRecovery.nextRequiredCapability,
        },
        source: "precompletion_evidence_audit",
      },
    );
    const nextState = input.getExecuteRecoveryState();
    input.callbacks.onStatusChange("running");
    const language = input.callbacks.getPreferredLanguage();
    input.callbacks.appendMessage({
      role: "system",
      content: language === "zh"
        ? `[System: 最终结论暂存，尚未提交。执行证据缺口为 ${preCompletionRecovery.gap}；下一步必须调用 ${preCompletionRecovery.nextRequiredCapability} 能力取得真实证据，再重新核对完成条件。]`
        : `[System: The final conclusion is being held as a draft. The execution-evidence gap is ${preCompletionRecovery.gap}; next call the ${preCompletionRecovery.nextRequiredCapability} capability, collect real evidence, and re-audit completion.]`,
    });
    logAgentEvent("precompletion_evidence_recovery_activated", {
      iteration: input.iteration,
      gap: preCompletionRecovery.gap,
      recoveryMode: nextState.mode,
      expectedTarget: nextState.expectedTarget,
      nextRequiredCapability: preCompletionRecovery.nextRequiredCapability,
      draftChars: input.visibleAssistantText.length,
      validationExpected: input.effectiveTurnContract?.validationExpected === true,
      mutationExpected: input.effectiveTurnContract?.mutationExpected === true,
      externalReviewIsAdvisory,
    });
    return finish("continue");
  }

  if (currentExecuteRecoveryState.mode === "objective_audit") {
    const checkpoint = currentExecuteRecoveryState.decisionCheckpoint;
    const revision = Math.max(1, Math.floor(Number(checkpoint?.objectiveRevision) || 1));
    if (objectiveAuditHasCurrentClosureEvidence(currentExecuteRecoveryState)) {
      currentExecuteRecoveryState = input.clearExecuteRecovery(
        "objective_audit_model_stop",
        currentExecuteRecoveryState.expectedTarget || undefined,
        currentExecuteRecoveryState,
      );
      logAgentEvent("objective_closure_audit_completed", {
        iteration: input.iteration,
        objectiveObligationId: checkpoint?.objectiveObligationId || null,
        objectiveRevision: revision,
        mutationTargets: (checkpoint?.objectiveMutationEvidence || []).map((entry) => entry.target),
        validationTool: checkpoint?.objectiveValidationEvidence?.tool || null,
        completionSignal: "assistant_stop_without_tool_call",
      });
    } else {
      const language = input.callbacks.getPreferredLanguage();
      input.callbacks.onNonActionableStop(
        language === "zh"
          ? "执行已暂停：objective closure audit 缺少同一 revision 的结构化 mutation/validation 证据，不能把零工具响应当作完成。"
          : "Execution paused: the objective closure audit lacks structured mutation/validation evidence for the same revision, so a no-tool response cannot be accepted as completion.",
        "no_action",
        {
          phase: "paused",
          recoveryReason: "objective_closure_audit_evidence_missing",
          nextStep: language === "zh"
            ? "从保留的 objective checkpoint 恢复并补齐缺失证据。"
            : "Resume from the retained objective checkpoint and collect the missing evidence.",
        },
      );
      input.callbacks.onStatusChange("idle");
      return finish("stopped");
    }
  }

  const validationMutationReopen = resolveValidationMutationReopen({
    recoveryState: currentExecuteRecoveryState,
    protocolViolation: input.normalized.protocolViolation,
    protocolActualTools: input.normalized.protocolActualTools,
    protocolActualToolCalls: input.normalized.protocolActualToolCalls,
  });
  if (validationMutationReopen) {
    const currentCheckpoint = currentExecuteRecoveryState.decisionCheckpoint;
    if (validationMutationReopen.budgetExhausted) {
      const language = input.callbacks.getPreferredLanguage();
      const message = language === "zh"
        ? `执行已暂停：同一目标在校验阶段已用尽 ${MAX_VALIDATION_MUTATION_REOPENS} 次独立修改重开预算，仍有结构化编辑请求未完成。现有变更、目标证据和校验检查点均已保留。`
        : `Execution paused: this objective exhausted its ${MAX_VALIDATION_MUTATION_REOPENS} distinct validation-to-mutation reopens while another structured edit was still requested. Existing changes, target evidence, and the validation checkpoint were preserved.`;
      input.callbacks.onNonActionableStop(message, "missing_tool_loop", {
        phase: "paused",
        recoveryReason: "validation_mutation_reopen_budget_exhausted",
        nextStep: language === "zh"
          ? "从保留的 objective checkpoint 恢复，重新核对剩余目标或由用户调整范围；不要继续尝试新的编辑位置。"
          : "Resume from the retained objective checkpoint to re-audit the remaining target or let the user revise scope; do not keep trying new edit loci.",
      });
      input.callbacks.onStatusChange("idle");
      logAgentEvent("validation_mutation_reopen_budget_exhausted", {
        iteration: input.iteration,
        requestedTools: validationMutationReopen.requestedTools,
        requestedTargets: validationMutationReopen.requestedTargets,
        validationMutationReopenCount:
          currentCheckpoint?.validationMutationReopenCount || 0,
        maxValidationMutationReopens: MAX_VALIDATION_MUTATION_REOPENS,
      });
      return finish("stopped");
    }
    const validationMutationReopenCount = Math.max(
      0,
      Math.floor(Number(currentCheckpoint?.validationMutationReopenCount) || 0),
    ) + 1;
    // Recovery is a serial transaction. A multi-target patch reopens against
    // its first target; the remaining targets stay in objectiveExpectedTargets
    // and are handled by subsequent read -> mutation steps.
    const requestedTarget = validationMutationReopen.requestedTargets[0] || null;
    const targetChanged = Boolean(
      requestedTarget &&
      (
        !currentExecuteRecoveryState.expectedTarget ||
        !workspacePathsReferToSameFile(
          requestedTarget,
          currentExecuteRecoveryState.expectedTarget,
        )
      ),
    );
    const nextExpectedTarget = requestedTarget || currentExecuteRecoveryState.expectedTarget;
    const reusableObservation = targetChanged && requestedTarget
      ? await input.resolveRecoveryReadObservation?.(requestedTarget) || null
      : null;
    const targetBinding = resolveValidationMutationReopenTargetBinding({
      recoveryState: currentExecuteRecoveryState,
      requestedTarget,
      reusableObservation,
    });
    const targetReadRequired = targetBinding.mode === "patch_recovery_read";
    const nextSourceObservationKey = targetBinding.sourceObservationKey;
    const priorObjectiveTargets = currentCheckpoint?.objectiveExpectedTargets || [];
    const objectiveExpectedTargets = [
      ...priorObjectiveTargets,
      ...validationMutationReopen.requestedTargets,
    ].reduce<string[]>((targets, target) =>
      targets.some((entry) => workspacePathsReferToSameFile(entry, target))
        ? targets
        : [...targets, target], []);
    const validationMutationReopenFingerprints = [...new Set([
      ...(currentCheckpoint?.validationMutationReopenFingerprints || []),
      ...validationMutationReopen.semanticFingerprints,
    ])].slice(-32);
    input.callbacks.onStreamToken("__ESCALATION_RESET__:validation_mutation_reopen", input.assistantMsgId);
    input.activateExecuteRecovery(
      targetBinding.mode,
      "validation_followup_mutation_requested",
      {
        expectedTarget: nextExpectedTarget,
        resetExpectedTarget: targetChanged,
        sourceObservationKey: nextSourceObservationKey,
        ...(targetBinding.readLease ? { readLease: targetBinding.readLease } : {}),
        ...(reusableObservation ? { readFileObservation: reusableObservation } : {}),
        decisionCheckpoint: {
          ...(currentCheckpoint || {}),
          expectedTarget: nextExpectedTarget,
          sourceObservationKey: nextSourceObservationKey,
          nextRequiredCapability: targetReadRequired ? "targeted_read" : "mutation",
          ...(!targetChanged && currentCheckpoint?.evidenceVersion
            ? { evidenceVersion: currentCheckpoint.evidenceVersion }
            : {}),
          validationMutationReopenCount,
          validationMutationReopenFingerprints,
          ...(objectiveExpectedTargets.length > 0 ? { objectiveExpectedTargets } : {}),
          objectiveClosurePending: true,
        },
        source: "validation_requested_followup_mutation",
      },
    );
    input.callbacks.onStatusChange("running");
    const requestExcerpt = input.latestUserPromptText.replace(/\s+/g, " ").trim().slice(0, 800);
    input.callbacks.appendMessage({
      role: "system",
      content: [
        "VALIDATION_MUTATION_REOPEN: The validation checkpoint is retained, but the mutation surface has been reopened for a distinct structured objective/target because the previous response explicitly requested a workspace edit tool.",
        `Requested edit tools: ${validationMutationReopen.requestedTools.join(", ")}.`,
        validationMutationReopen.requestedTargets.length > 0
          ? `Requested edit targets: ${validationMutationReopen.requestedTargets.join(", ")}.`
          : "",
        requestExcerpt ? `Original turn objective: ${requestExcerpt}` : "",
        "Make only the remaining task-relevant edit. Do not substitute a cosmetic or nearby change for an unresolved requested outcome. The retained finite validation will run after the mutation.",
      ].filter(Boolean).join("\n"),
    });
    logAgentEvent("validation_mutation_surface_reopened", {
      iteration: input.iteration,
      requestedTools: validationMutationReopen.requestedTools,
      requestedTargets: validationMutationReopen.requestedTargets,
      semanticFingerprints: validationMutationReopen.semanticFingerprints,
      expectedTarget: nextExpectedTarget,
      targetReadRequired,
      reusedObservationKey: reusableObservation?.key || null,
      recoveryAttempts: currentExecuteRecoveryState.attempts,
      validationMutationReopenCount,
      pendingFiniteValidation: currentCheckpoint?.pendingFiniteValidation || null,
    });
    return finish("continue");
  }

  // Transport errors must be observable before an active evidence contract
  // sends the next identical request. Keep generic prose/XML recovery out of
  // the evidence transaction; the contract already owns its next capability.
  const executeNoToolRecovery = handleExecuteNoToolRecovery({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    iteration: input.iteration,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
    runtimeIntent: input.runtimeIntent,
    forceXmlTools: input.forceXmlTools,
    availableToolNames: input.availableToolNames,
    effectiveToolCallCount,
    finalReplyOptionsCount: input.finalReplyOptions.length,
    shouldPauseForUserChoice: input.shouldPauseForUserChoice,
    sawExecuteOperationEvidence: input.sawExecuteOperationEvidence,
    visibleText: input.visibleAssistantText || input.userVisibleText,
    protocolViolation: input.normalized.protocolViolation,
    protocolViolationOnly: currentExecuteRecoveryState.mode !== "normal",
    assistantMsgId: input.assistantMsgId,
    consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
  });
  noToolRuntimeState = applyConsecutiveNoToolRuntimeState(
    noToolRuntimeState,
    executeNoToolRecovery,
  );
  if (executeNoToolRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (executeNoToolRecovery.status === "continue") {
    return finish("continue");
  }

  if (currentExecuteRecoveryState.mode !== "normal") {
    // The active recovery transaction still owns the next capability. The
    // resolver deliberately does not reactivate an existing transaction, but
    // that must never be interpreted as evidence closure or permission to
    // publish the held final draft.
    input.callbacks.onStreamToken("__ESCALATION_RESET__:evidence_recovery", input.assistantMsgId);
    input.callbacks.onStatusChange("running");
    logAgentEvent("precompletion_evidence_recovery_still_active", {
      iteration: input.iteration,
      recoveryMode: currentExecuteRecoveryState.mode,
      expectedTarget: currentExecuteRecoveryState.expectedTarget,
      nextRequiredCapability: currentExecuteRecoveryState.decisionCheckpoint?.nextRequiredCapability || null,
    });
    return finish("continue");
  }

  const setPlanRuntimePhaseAndSync: typeof input.setPlanRuntimePhase = (
    phase,
    reason,
    status,
    qualitySnapshot,
  ) => {
    input.setPlanRuntimePhase(phase, reason, status, qualitySnapshot);
    planRuntimeState = applyPlanRuntimePhase({
      ...planRuntimeState,
      ...(qualitySnapshot?.qualityRejectCount != null
        ? { planQualityRejectCount: qualitySnapshot.qualityRejectCount }
        : {}),
      ...(qualitySnapshot?.missingSections
        ? { planLastMissingSections: [...qualitySnapshot.missingSections] }
        : {}),
    }, { phase, reason }).state;
  };
  const planNoToolRecovery = await handlePlanNoToolRecovery({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    iteration: input.iteration,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
    commandDirectiveAction: input.commandDirectiveAction,
    workspace: input.workspace,
    latestUserPromptText: input.latestUserPromptText,
    streamText: input.streamText,
    sourceVisibleText: input.sourceVisibleText,
    assistantHistoryText: input.assistantHistoryText,
    providerReasoningForHistory: input.providerReasoningForHistory,
    hasStructuredProposal: input.hasStructuredProposal,
    hasReviewablePlanArtifacts: input.hasReviewablePlanArtifacts,
    wasTruncated: input.wasTruncated,
    hasExecutablePlanProposalOptions: input.hasExecutablePlanProposalOptions,
    planReplyOptionsRoutedToArtifact: input.planReplyOptionsRoutedToArtifact,
    finalReplyOptionsCount: input.finalReplyOptions.length,
    effectiveToolCallCount,
    hasMeaningfulVisibleText: input.hasMeaningfulVisibleText,
    normalizedVisibleText: input.normalized.visibleText,
    normalizedFinishReason: input.normalized.finishReason,
    recentPlanToolActivity: input.recentPlanToolActivity,
    attemptedPlanWriteTargets: input.attemptedPlanWriteTargets,
    turnInputContextSignals: input.turnInputContextSignals,
    consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
    ...planRuntimeState,
    setPlanRuntimePhase: setPlanRuntimePhaseAndSync,
    waitForPlanApprovalIfNeeded: input.waitForPlanApprovalIfNeeded,
    tryClosePlanWithEvidence: input.tryClosePlanWithEvidence,
  });
  noToolRuntimeState = applyConsecutiveNoToolRuntimeState(
    noToolRuntimeState,
    planNoToolRecovery,
  );
  planRuntimeState = applyPlanNoToolRuntimeState(
    planRuntimeState,
    planNoToolRecovery,
  );
  if (planNoToolRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (planNoToolRecovery.status === "continue") {
    return finish("continue");
  }

  const missingToolNoToolRecovery = handleMissingToolNoToolRecovery({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    iteration: input.iteration,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
    runtimeIntent: input.runtimeIntent,
    forceXmlTools: input.forceXmlTools,
    mainModeKey: input.mainModeKey,
    hasMeaningfulVisibleText: input.hasMeaningfulVisibleText,
    compactedProseCodeDump: input.compactedProseCodeDump,
    wasTruncated: input.wasTruncated,
    normalizedFinishReason: input.normalized.finishReason,
    normalizedToolCallCount: input.normalized.toolCalls.length,
    visibleText: input.normalized.visibleText,
    visibleFallbackText: input.visibleAssistantText || input.userVisibleText,
    assistantMsgId: input.assistantMsgId,
    hiddenThoughtOnlyNoToolStop: input.hiddenThoughtOnlyNoToolStop,
    recentSuccessfulProjectWrite: input.recentSuccessfulProjectWrite,
    recoveringFromEmptyAssistantReplyAfterWrite:
      input.recoveringFromEmptyAssistantReplyAfterWrite,
    recentToolActivity: input.recentToolActivity,
    sawExecuteOperationEvidence: input.sawExecuteOperationEvidence,
    consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
  });
  noToolRuntimeState = applyConsecutiveNoToolRuntimeState(
    noToolRuntimeState,
    missingToolNoToolRecovery,
  );
  noToolRuntimeState = applyRecoveringFromEmptyAssistantReplyRuntimeState(
    noToolRuntimeState,
    missingToolNoToolRecovery,
  );
  if (missingToolNoToolRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (missingToolNoToolRecovery.status === "continue") {
    return finish("continue");
  }

  if (
    input.unityConsoleDiagnosticsRequested &&
    input.unityConsoleFinalVerificationRequired
  ) {
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: input.callbacks.getPreferredLanguage() === "zh"
        ? "在输出最终结论前，必须先完成一次最终验证：先调用 refresh_unity，再调用 read_console。完成这一次验证后再给结论，不要重复多轮验证。"
        : "Before giving the final conclusion, run one final verification pass: call refresh_unity first, then read_console. After this single verification pass, provide the conclusion without repeating more verification loops.",
    });
    return finish("continue");
  }

  const approvedPlanFinalization = handleApprovedPlanFinalization({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    iteration: input.iteration,
    approvedPlanAuditForNoTool: input.approvedPlanAuditForNoTool,
    rejectedCompletionClaim: input.rejectedCompletionClaim,
    availableToolNames: input.availableToolNames,
    consecutiveNoToolCount: noToolRuntimeState.consecutiveNoToolCount,
    emitTaskOrchestratorPhase: input.emitTaskOrchestratorPhase,
    emitPlanExecutionProgress: input.emitPlanExecutionProgress,
    executeRecoveryState: input.getExecuteRecoveryState(),
  });
  noToolRuntimeState = applyConsecutiveNoToolRuntimeState(
    noToolRuntimeState,
    approvedPlanFinalization,
  );
  if (approvedPlanFinalization.status === "stopped") {
    return finish("stopped");
  }
  if (approvedPlanFinalization.status === "continue") {
    return finish("continue");
  }

  input.callbacks.onStreamToken("__EVIDENCE_DRAFT_COMMIT__:evidence_closed", input.assistantMsgId);
  const finalNoToolAssistantTurn = handleFinalNoToolAssistantTurn({
    callbacks: input.callbacks,
    iteration: input.iteration,
    workflowMode: input.workflowMode,
    isPlanApproved: input.callbacks.getIsPlanApproved(),
    normalizedVisibleChars: input.normalized.visibleText.length,
    normalizedReplyOptionCount: input.normalized.replyOptions.length,
    completion,
  });
  if (finalNoToolAssistantTurn.status === "stopped") {
    return finish("stopped");
  }

  return finish("completed");

  function finish(
    status: AssistantCompletionPhaseResult["status"],
  ): AssistantCompletionPhaseResult {
    return {
      status,
      noToolRuntimeState,
      planRuntimeState,
    };
  }
}
