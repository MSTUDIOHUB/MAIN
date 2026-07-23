import type { StreamResult } from "../../streaming";
import {
  classifyPlanArtifactQualityResult,
  type NormalizedStreamState,
  type PlanRuntimePhase,
} from "../../workflowModels";
import type { ResolvedUserIntent } from "../../runIntent";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import {
  buildTypedPlanApprovalIdentity,
  resolveTypedPlanReviewAuthority,
} from "../../planApprovalIdentity";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { buildPlanSubmissionGuidance } from "../../planSubmissionGuidance";
import { hasTypedPlanDraftEnvelope } from "../../planDraftIngress";
import {
  buildPlanCandidateRepairPrompt,
  type PlanCandidateRepairCheckpoint,
} from "../../planCandidateRepair";
import { buildPlanClosureEvidenceRecoveryPrompt } from "../planOrchestration";
import {
  autoMaterializePlanArtifactFromEvidence,
  autoMaterializePlanArtifactFromVisibleText,
  buildAssistantHistoryMessage,
  buildPlanRecoveryPrompt,
  CONCISE_PLAN_ARTIFACT_HINT_EN,
  CONCISE_PLAN_ARTIFACT_HINT_ZH,
  isReviewablePlanStage,
  logAgentEvent,
} from "../../orchestrator";
import type { OrchestratorCallbacks } from "../types";
import { resolveExecuteNoToolCheckpointLimit } from "./executeNoToolRecovery";
import { handlePlanQualityRecoveryAfterVisibleMaterialization } from "./planQualityRecovery";
import type {
  PlanEvidenceRecoveryObjective,
  PlanRuntimePhaseQualitySnapshot,
  PlanVisibleQualityPromptBudgetState,
} from "./planRuntimeState";

export type PlanNoToolRecoveryStatus = "none" | "continue" | "stopped";
export type PlanClosureAttemptResult = "not_attempted" | "failed" | "stopped" | "approved_continue";

export type PlanNoToolRecoveryResult = {
  status: PlanNoToolRecoveryStatus;
  consecutiveNoToolCount: number;
  usedPlanRecoveryPrompt: boolean;
  planClosureEvidenceRecoveryIssued: boolean;
  planQualityRejectCount: number;
  planLastQualityGateReason: string;
  planLastMissingSections: string[];
  planFacetMappingSource: string;
  planArtifactQualityRejected: boolean;
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  planAutoScaffoldPromptIssued: boolean;
  planEvidenceRecoveryPasses: number;
  planEvidenceNoProgressPasses: number;
  planEvidenceProgressFingerprint: string;
  planVisibleQualityPromptBudget: PlanVisibleQualityPromptBudgetState;
  planCandidateRepairCheckpoint: PlanCandidateRepairCheckpoint | null;
};

export { buildPlanClosureEvidenceRecoveryPrompt } from "../planOrchestration";

/**
 * Structured proposal detection runs against the raw provider stream. When it
 * succeeds, materialization must use that same source; the user-visible text
 * may already have had the proposal protocol removed for display.
 */
export function selectPlanMaterializationSourceText(input: {
  hasStructuredProposal: boolean;
  streamText: string;
  sourceVisibleText: string;
}): string {
  const streamText = String(input.streamText || "").trim();
  const sourceVisibleText = String(input.sourceVisibleText || "").trim();
  return input.hasStructuredProposal && streamText
    ? streamText
    : sourceVisibleText || streamText;
}

export function buildPlanGenerationFailedMessage(language: "zh" | "en", reason: string): string {
  return language === "zh"
    ? `计划生成失败：经过有界的计划物化恢复后，仍未得到通过校验的计划产物（${reason}）。请补充约束或重试计划生成。`
    : `Plan generation failed: bounded materialization recovery did not produce a validated plan artifact (${reason}). Add constraints or retry plan generation.`;
}

export function buildPlanGenerationFailedProgress(reason: string) {
  return {
    recoveryReason: "plan_generation_failed",
    nextStep: reason,
  };
}

export function buildPlanCandidateRepairPausedProgress(reason: string) {
  return {
    phase: "paused" as const,
    recoveryReason: "plan_candidate_repair_budget_exhausted",
    nextStep: reason,
  };
}

export function resolvePlanNoToolRecoveryDecision(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  planRuntimePhase?: PlanRuntimePhase;
  planArtifactQualityRejected?: boolean;
  hasStructuredProposal: boolean;
  /** Complete typed envelopes must reach typed ingress before legacy gates. */
  hasTypedPlanCandidate?: boolean;
  hasReviewablePlanArtifacts: boolean;
  currentPlanStage: string;
  sourceVisibleText: string;
  hasMeaningfulVisibleText: boolean;
  sawPlanModeToolActivity: boolean;
  wasTruncated: boolean;
  hasExecutablePlanProposalOptions: boolean;
  planReplyOptionsRoutedToArtifact: boolean;
  finalReplyOptionsCount: number;
  turnIntent: ResolvedUserIntent;
  commandDirectiveAction?: string | null;
  effectiveToolCallCount?: number;
  protocolViolation?: NormalizedStreamState["protocolViolation"];
}): {
  shouldRecoverRequiredToolProtocol: boolean;
  shouldEnterReview: boolean;
  shouldMaterializeStructuredProposal: boolean;
  shouldTryPlanTextMaterialization: boolean;
  shouldMaterializeFallbackPlan: boolean;
  shouldRefineLongPlanIntoChoice: boolean;
  shouldForcePlanContinuation: boolean;
} {
  const isUnapprovedPlan =
    input.workflowMode === "plan" &&
    !input.isPlanApproved;
  const hasAcceptedReviewArtifact =
    input.hasReviewablePlanArtifacts && input.planArtifactQualityRejected !== true;
  const hasTypedPlanCandidate = input.hasTypedPlanCandidate === true;
  const planningEvidenceBlocked =
    input.planRuntimePhase === "blocked" && !hasAcceptedReviewArtifact;
  const planningStillIncomplete =
    isUnapprovedPlan &&
    (!planningEvidenceBlocked || hasTypedPlanCandidate) &&
    !hasAcceptedReviewArtifact &&
    input.currentPlanStage !== "ready_to_execute";
  const shouldRecoverRequiredToolProtocol =
    planningStillIncomplete &&
    !hasTypedPlanCandidate &&
    (input.effectiveToolCallCount ?? 0) === 0 &&
    (
      input.protocolViolation === "required_tool_call_missing" ||
      input.protocolViolation === "required_function_call_mismatch" ||
      input.protocolViolation === "required_tool_call_not_available"
    );
  const hasMeaningfulSourcePlanText = input.sourceVisibleText.trim().length > 0;
  const canReplaceReviewArtifact =
    !input.hasReviewablePlanArtifacts || input.planArtifactQualityRejected === true;
  const shouldMaterializeFallbackPlan =
    planningStillIncomplete &&
    !shouldRecoverRequiredToolProtocol &&
    hasMeaningfulSourcePlanText &&
    canReplaceReviewArtifact &&
    (
      input.sawPlanModeToolActivity ||
      input.wasTruncated ||
      input.hasExecutablePlanProposalOptions ||
      input.planReplyOptionsRoutedToArtifact
    );
  const shouldTryPlanTextMaterialization =
    planningStillIncomplete &&
    !shouldRecoverRequiredToolProtocol &&
    hasMeaningfulSourcePlanText &&
    canReplaceReviewArtifact &&
    (
      input.finalReplyOptionsCount === 0 ||
      input.hasExecutablePlanProposalOptions ||
      input.planReplyOptionsRoutedToArtifact
    ) &&
    !input.hasStructuredProposal &&
    (
      input.sawPlanModeToolActivity ||
      input.wasTruncated ||
      input.hasExecutablePlanProposalOptions ||
      input.planReplyOptionsRoutedToArtifact ||
      input.turnIntent === "plan" ||
      input.commandDirectiveAction === "plan_file_change"
    );

  return {
    shouldRecoverRequiredToolProtocol,
    shouldEnterReview:
      isUnapprovedPlan && hasAcceptedReviewArtifact,
    shouldMaterializeStructuredProposal:
      isUnapprovedPlan &&
      (!planningEvidenceBlocked || hasTypedPlanCandidate) &&
      !shouldRecoverRequiredToolProtocol &&
      (input.hasStructuredProposal || hasTypedPlanCandidate) &&
      (!input.hasReviewablePlanArtifacts || input.planArtifactQualityRejected === true),
    shouldTryPlanTextMaterialization,
    shouldMaterializeFallbackPlan,
    shouldRefineLongPlanIntoChoice:
      planningStillIncomplete &&
      !shouldRecoverRequiredToolProtocol &&
      input.hasMeaningfulVisibleText &&
      input.wasTruncated &&
      !shouldMaterializeFallbackPlan,
    shouldForcePlanContinuation:
      planningStillIncomplete &&
      !shouldRecoverRequiredToolProtocol &&
      !input.hasMeaningfulVisibleText,
  };
}

function buildForcePlanContinuationPrompt(input: {
  language: "zh" | "en";
  currentPlanStage: string;
  sawPlanModeToolActivity: boolean;
  wasTruncated: boolean;
}): string {
  const { language, currentPlanStage, sawPlanModeToolActivity, wasTruncated } = input;
  const submissionGuidance = buildPlanSubmissionGuidance(language);
  const missingStepHint =
    language === "zh"
      ? currentPlanStage === "requirements"
        ? "你已经有旧流程的 requirements.md，下一步必须按最新 authoring contract 提交完整 typed graph，交由 runtime 校验并渲染；如果设计方向仍不明确，只能用 `<user_options>` 给出真实阻塞选择并停止。不要重复读取已读文件。"
        : currentPlanStage === "design"
        ? "当前已有设计/计划上下文；不要再输出独立 Proposal 文本。若 sealed typed authority 已存在，runtime review resolver 会直接处理；否则按最新 authoring contract 提交完整 typed graph。只有真实阻塞决策才给用户选择；批准前不要生成 tasks.md。"
        : sawPlanModeToolActivity
        ? "你已经开始做项目探索了，但还没有给出可让用户决策的规划结果。下一步应先收束分歧并询问用户。"
        : "请先给出可让用户决策的规划问题。"
      : currentPlanStage === "requirements"
      ? "A legacy requirements.md exists. Next submit the complete typed graph under the latest authoring contract for runtime validation and rendering; if the plan direction is still unclear, offer a real blocking `<user_options>` choice and stop. Do not repeat reads of files already in context."
      : currentPlanStage === "design"
      ? "Design/Plan context exists; do not emit a separate Proposal text authority. If a sealed typed authority exists, the runtime review resolver handles it; otherwise submit one complete typed graph under the latest authoring contract. Offer choices only for a genuinely blocking decision, and do not generate tasks.md before approval."
      : sawPlanModeToolActivity
      ? "You have started project exploration but have not produced a planning result the user can decide on. Next condense the tradeoffs and ask the user."
      : "First present a planning question the user can decide on.";

  return language === "zh"
    ? `当前规划还没有进入可执行阶段。${missingStepHint}\n` +
        `${CONCISE_PLAN_ARTIFACT_HINT_ZH}\n` +
        `${submissionGuidance}\n` +
        "请继续规划，并在本轮结束前完成以下其一：\n" +
        "1. 如果信息足够，通过 contract 声明的当前入口提交一个完整 typed graph；MAIN runtime 会校验并渲染 plan.md。\n" +
        "2. 只有真正阻塞执行的用户决策才输出 2-4 个 `<user_options>`；不要把继续读取、检查或先后顺序包装成选项。\n" +
        "3. requirements.md 只是可选需求台账，在用户批准之前不要生成 `tasks.md` 或修改源码。\n" +
        `${currentPlanStage === "requirements" ? "当前已经有旧流程 requirements.md，本轮不要重复读文件；请直接按最新 contract 提交 typed graph，或询问真实设计分叉。\n" : ""}` +
        `${wasTruncated ? "你上一条回复已经发生截断，请从中断处继续，不要重头重复。\n" : ""}` +
        "不要只输出一句总结、结束语，或空结束符。"
    : `The current plan has not reached an executable stage. ${missingStepHint}\n` +
        `${CONCISE_PLAN_ARTIFACT_HINT_EN}\n` +
        `${submissionGuidance}\n` +
        "Continue planning and complete one of these before ending this turn:\n" +
        "1. If information is sufficient, submit one complete typed graph through the contract-declared ingress; MAIN runtime validates and renders plan.md.\n" +
        "2. Offer 2-4 `<user_options>` only for a genuinely blocking user-owned decision; never turn reading/checking order into choices.\n" +
        "3. requirements.md is only an optional requirement ledger. Do not generate `tasks.md` or edit source files before approval.\n" +
        `${currentPlanStage === "requirements" ? "A legacy requirements.md already exists. Do not repeat reads; submit the typed graph under the latest contract, or ask for a real design fork.\n" : ""}` +
        `${wasTruncated ? "Your previous reply was truncated; continue from the interruption point without restarting.\n" : ""}` +
        "Do not output only a summary, sign-off, or empty stop.";
}

async function handOffApprovedPlan(input: {
  callbacks: OrchestratorCallbacks;
  waitForPlanApprovalIfNeeded: () => Promise<boolean>;
  setPlanRuntimePhase: (
    phase: PlanRuntimePhase,
    reason?: string,
    status?: "pending" | "running" | "done" | "failed",
    qualitySnapshot?: PlanRuntimePhaseQualitySnapshot,
  ) => void;
  qualitySnapshot?: PlanRuntimePhaseQualitySnapshot;
  recentPlanToolActivity: PlanToolActivitySummary[];
  phaseReason: string;
  assistantHistoryText: string;
  providerReasoningForHistory?: Pick<StreamResult, "reasoningContent" | "reasoningField"> | null;
}): Promise<"continue" | "stopped"> {
  const {
    callbacks,
    setPlanRuntimePhase,
    phaseReason,
    assistantHistoryText,
    providerReasoningForHistory,
    qualitySnapshot,
  } = input;
  const planArtifacts = callbacks.getPlanArtifacts?.() || [];
  const authority = resolveTypedPlanReviewAuthority(planArtifacts);
  if (!authority.ok) {
    const failureReason = `typed_plan_review_authority:${authority.reason}`;
    logAgentEvent("plan_review_handoff_recovering_typed_authority", {
      phaseReason,
      path: authority.path || null,
      reason: authority.reason,
    });
    callbacks.onPlanApprovalInvalidated?.(failureReason);
    setPlanRuntimePhase("needs_rewrite", failureReason, "failed", qualitySnapshot);
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: buildPlanRecoveryPrompt(
        callbacks,
        assistantHistoryText,
        input.recentPlanToolActivity.map((item) => item.target || "").filter(Boolean),
      ),
    });
    return "continue";
  }
  const approvalIdentity = buildTypedPlanApprovalIdentity(planArtifacts);
  const planStage = callbacks.getPlanStage();
  if (!approvalIdentity || !isReviewablePlanStage(planStage)) {
    const failureReason = !approvalIdentity
      ? "plan_review_artifact_identity_missing"
      : "plan_review_stage_not_reviewable";
    logAgentEvent(
      !approvalIdentity
        ? "plan_review_handoff_blocked_missing_artifact_identity"
        : "plan_review_handoff_blocked_nonreviewable_stage",
      {
      phaseReason,
      planStage,
      hasArtifactAccessor: typeof callbacks.getPlanArtifacts === "function",
      hasApprovalIdentity: !!approvalIdentity,
      },
    );
    setPlanRuntimePhase("blocked", failureReason, "failed", qualitySnapshot);
    callbacks.onNonActionableStop(
      buildPlanGenerationFailedMessage(callbacks.getPreferredLanguage(), failureReason),
      "incomplete_plan",
      buildPlanGenerationFailedProgress(failureReason),
    );
    callbacks.onStatusChange("idle");
    return "stopped";
  }
  setPlanRuntimePhase("review_ready", phaseReason, "done", qualitySnapshot);
  if (callbacks.getStatus() !== "pending_review") {
    callbacks.onStatusChange("pending_review");
  }
  callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
  logAgentEvent("plan_review_run_paused", {
    phaseReason,
    planStage,
    planRevision: approvalIdentity.revision,
    artifactHash: approvalIdentity.artifactHash,
    artifactPaths: approvalIdentity.artifactPaths,
  });
  // Review is the terminal state of this run. Approval validates the current
  // artifact identity and starts a child execution run in the same turn.
  return "stopped";
}

export async function handlePlanNoToolRecovery(input: {
  callbacks: OrchestratorCallbacks;
  activeProfile: string;
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  turnIntent: ResolvedUserIntent;
  commandDirectiveAction?: string | null;
  workspace: string;
  latestUserPromptText: string;
  streamText: string;
  sourceVisibleText: string;
  assistantHistoryText: string;
  providerReasoningForHistory?: Pick<StreamResult, "reasoningContent" | "reasoningField"> | null;
  hasStructuredProposal: boolean;
  hasReviewablePlanArtifacts: boolean;
  sawPlanModeToolActivity: boolean;
  wasTruncated: boolean;
  hasExecutablePlanProposalOptions: boolean;
  planReplyOptionsRoutedToArtifact: boolean;
  finalReplyOptionsCount: number;
  effectiveToolCallCount: number;
  hasMeaningfulVisibleText: boolean;
  normalizedVisibleText: string;
  normalizedFinishReason?: string | null;
  protocolViolation?: NormalizedStreamState["protocolViolation"];
  protocolAllowedTools?: string[];
  protocolActualTools?: string[];
  assistantMsgId: string;
  recentPlanToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  turnInputContextSignals: TurnInputContextSignals;
  consecutiveNoToolCount: number;
  usedPlanRecoveryPrompt: boolean;
  planClosureEvidenceRecoveryIssued: boolean;
  planRuntimePhase: PlanRuntimePhase;
  planEvidenceRecoveryObjective: PlanEvidenceRecoveryObjective;
  planEvidenceRecoveryPasses: number;
  planEvidenceNoProgressPasses: number;
  planEvidenceProgressFingerprint: string;
  planVisibleQualityPromptBudget?: PlanVisibleQualityPromptBudgetState;
  planCandidateRepairCheckpoint?: PlanCandidateRepairCheckpoint | null;
  planQualityRejectCount: number;
  planLastQualityGateReason: string;
  planLastMissingSections: string[];
  planFacetMappingSource: string;
  planArtifactQualityRejected?: boolean;
  planAutoScaffoldPromptIssued: boolean;
  setPlanRuntimePhase: (
    phase: PlanRuntimePhase,
    reason?: string,
    status?: "pending" | "running" | "done" | "failed",
    qualitySnapshot?: PlanRuntimePhaseQualitySnapshot,
  ) => void;
  waitForPlanApprovalIfNeeded: () => Promise<boolean>;
  tryClosePlanWithEvidence: (trigger: string, details?: {
    consecutiveEmptyResponseCount?: number;
    rejectedVisibleCandidate?: boolean;
    toolCallCount?: number;
    replyOptionCount?: number;
  }) => Promise<PlanClosureAttemptResult>;
}): Promise<PlanNoToolRecoveryResult> {
  const {
    callbacks,
    activeProfile,
    iteration,
    workflowMode,
    turnIntent,
    commandDirectiveAction,
    workspace,
    latestUserPromptText,
    streamText,
    sourceVisibleText,
    assistantHistoryText,
    providerReasoningForHistory,
    hasStructuredProposal,
    hasReviewablePlanArtifacts,
    planArtifactQualityRejected,
    sawPlanModeToolActivity,
    wasTruncated,
    hasExecutablePlanProposalOptions,
    planReplyOptionsRoutedToArtifact,
    finalReplyOptionsCount,
    effectiveToolCallCount,
    hasMeaningfulVisibleText,
    normalizedVisibleText,
    normalizedFinishReason,
    protocolViolation,
    protocolAllowedTools,
    protocolActualTools,
    assistantMsgId,
    recentPlanToolActivity,
    attemptedPlanWriteTargets,
    turnInputContextSignals,
    planEvidenceRecoveryPasses,
    planQualityRejectCount: initialPlanQualityRejectCount,
    planLastQualityGateReason,
    planLastMissingSections: initialPlanLastMissingSections,
    planFacetMappingSource: initialPlanFacetMappingSource,
    setPlanRuntimePhase,
    waitForPlanApprovalIfNeeded,
    tryClosePlanWithEvidence,
  } = input;
  let consecutiveNoToolCount = input.consecutiveNoToolCount;
  let usedPlanRecoveryPrompt = input.usedPlanRecoveryPrompt;
  let planClosureEvidenceRecoveryIssued = input.planClosureEvidenceRecoveryIssued;
  let planQualityRejectCount = initialPlanQualityRejectCount ?? 0;
  let currentPlanLastQualityGateReason = planLastQualityGateReason;
  let planLastMissingSections = initialPlanLastMissingSections ?? [];
  let currentPlanFacetMappingSource = initialPlanFacetMappingSource || "";
  let currentPlanArtifactQualityRejected = planArtifactQualityRejected === true;
  let planEvidenceRecoveryObjective = input.planEvidenceRecoveryObjective ?? "none";
  let planAutoScaffoldPromptIssued = input.planAutoScaffoldPromptIssued;
  let currentPlanEvidenceRecoveryPasses = planEvidenceRecoveryPasses;
  let currentPlanEvidenceNoProgressPasses = input.planEvidenceNoProgressPasses ?? 0;
  let currentPlanEvidenceProgressFingerprint = input.planEvidenceProgressFingerprint ?? "";
  let currentPlanVisibleQualityPromptBudget = input.planVisibleQualityPromptBudget ?? [];
  let currentPlanCandidateRepairCheckpoint = input.planCandidateRepairCheckpoint ?? null;
  const finish = (status: PlanNoToolRecoveryStatus): PlanNoToolRecoveryResult => ({
    status,
    consecutiveNoToolCount,
    usedPlanRecoveryPrompt,
    planClosureEvidenceRecoveryIssued,
    planQualityRejectCount,
    planLastQualityGateReason: currentPlanLastQualityGateReason,
    planLastMissingSections,
    planFacetMappingSource: currentPlanFacetMappingSource,
    planArtifactQualityRejected: currentPlanArtifactQualityRejected,
    planEvidenceRecoveryObjective,
    planAutoScaffoldPromptIssued,
    planEvidenceRecoveryPasses: currentPlanEvidenceRecoveryPasses,
    planEvidenceNoProgressPasses: currentPlanEvidenceNoProgressPasses,
    planEvidenceProgressFingerprint: currentPlanEvidenceProgressFingerprint,
    planVisibleQualityPromptBudget: currentPlanVisibleQualityPromptBudget,
    planCandidateRepairCheckpoint: currentPlanCandidateRepairCheckpoint,
  });

  const currentPlanStage = callbacks.getPlanStage();
  const typedPlanCandidateInStream = hasTypedPlanDraftEnvelope(streamText);
  const typedPlanCandidateInVisibleText = hasTypedPlanDraftEnvelope(sourceVisibleText);
  const hasTypedPlanCandidate = typedPlanCandidateInStream || typedPlanCandidateInVisibleText;
  const decision = resolvePlanNoToolRecoveryDecision({
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    planRuntimePhase: input.planRuntimePhase,
    planArtifactQualityRejected: currentPlanArtifactQualityRejected,
    hasStructuredProposal,
    hasTypedPlanCandidate,
    hasReviewablePlanArtifacts,
    currentPlanStage,
    sourceVisibleText,
    hasMeaningfulVisibleText,
    sawPlanModeToolActivity,
    wasTruncated,
    hasExecutablePlanProposalOptions,
    planReplyOptionsRoutedToArtifact,
    finalReplyOptionsCount,
    turnIntent,
    commandDirectiveAction,
    effectiveToolCallCount,
    protocolViolation,
  });

  if (decision.shouldRecoverRequiredToolProtocol) {
    consecutiveNoToolCount += 1;
    callbacks.onStreamToken("__ESCALATION_RESET__:plan_tool_protocol", assistantMsgId);
    logAgentEvent("plan_required_tool_protocol_recovery", {
      iteration,
      consecutiveNoToolCount,
      protocolViolation,
      allowedTools: protocolAllowedTools || [],
      actualTools: protocolActualTools || [],
      qualityRejectCount: planQualityRejectCount,
    });
    if (consecutiveNoToolCount >= resolveExecuteNoToolCheckpointLimit(activeProfile)) {
      callbacks.onNonActionableStop(
        callbacks.getPreferredLanguage() === "zh"
          ? "计划生成已暂停：模型连续违反当前 required 工具契约，违规回复未被当作计划，也没有消耗计划质量预算。请从当前检查点重试。"
          : "Plan generation paused because the model repeatedly violated the active required-tool contract. The invalid replies were not treated as plans and did not consume Plan quality budget. Retry from the current checkpoint.",
        "missing_tool_loop",
        {
          recoveryReason: "plan_required_tool_protocol_violation",
          nextStep: protocolViolation || "required_tool_call_missing",
        },
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }
    callbacks.onStatusChange("running");
    const allowedTools = (protocolAllowedTools || []).filter(Boolean);
    callbacks.appendMessage({
      role: "user",
      content: [
        "PLAN_TOOL_PROTOCOL_RECOVERY: The previous response violated the active required-tool contract. Its tool calls and prose were quarantined and must not be treated as a Plan candidate.",
        allowedTools.length > 0
          ? `Call exactly one currently exposed tool: ${allowedTools.join(", ")}.`
          : "Call exactly one tool currently exposed by the active capability contract.",
        "Do not repeat the quarantined prose, emit a plan, restart analysis, or claim completion in this recovery response.",
      ].join("\n"),
    });
    return finish("continue");
  }

  const recoverRejectedVisibleCandidate = async (
    materialized: Awaited<ReturnType<typeof autoMaterializePlanArtifactFromVisibleText>>,
    candidateSourceText = sourceVisibleText,
  ): Promise<PlanNoToolRecoveryResult> => {
    const localRepairCheckpoint = materialized.candidateRepairCheckpoint || null;
    if (localRepairCheckpoint || materialized.candidateRepairExhausted) {
      currentPlanCandidateRepairCheckpoint = localRepairCheckpoint;
      currentPlanArtifactQualityRejected = true;
      planQualityRejectCount += 1;
      currentPlanLastQualityGateReason =
        localRepairCheckpoint?.terminalReason || materialized.reason || "typed_plan_candidate_repair_required";
      if (materialized.candidateRepairExhausted || localRepairCheckpoint?.exhausted) {
        const terminalReason = currentPlanLastQualityGateReason;
        setPlanRuntimePhase("blocked", terminalReason, "failed", {
          qualityRejectCount: planQualityRejectCount,
          missingSections: [],
        });
        logAgentEvent("plan_candidate_local_repair_exhausted", {
          iteration,
          reason: terminalReason,
          attempts: localRepairCheckpoint?.attempts || 0,
          cumulativeOutputChars: localRepairCheckpoint?.cumulativeOutputChars || 0,
        });
        callbacks.onNonActionableStop(
          buildPlanGenerationFailedMessage(callbacks.getPreferredLanguage(), terminalReason),
          "incomplete_plan",
          buildPlanCandidateRepairPausedProgress(terminalReason),
        );
        // onNonActionableStop owns the canonical paused/action_required
        // projection. Emitting idle here would overwrite that terminal state.
        return finish("stopped");
      }

      setPlanRuntimePhase("needs_rewrite", currentPlanLastQualityGateReason, "failed", {
        qualityRejectCount: planQualityRejectCount,
        missingSections: [],
      });
      logAgentEvent("plan_candidate_local_repair_dispatched", {
        iteration,
        reason: currentPlanLastQualityGateReason,
        baseDraftHash: localRepairCheckpoint!.baseDraftHash,
        attempts: localRepairCheckpoint!.attempts,
        invalidTargets: localRepairCheckpoint!.invalidTargets.length,
        addableKinds: localRepairCheckpoint!.addableKinds,
      });
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: buildPlanCandidateRepairPrompt(localRepairCheckpoint!),
      });
      return finish("continue");
    }

    const rejectedCandidateText = String(candidateSourceText || "").trim();
    let rejectedCandidateContextPreserved = false;
    const preserveRejectedCandidateForRecovery = () => {
      if (rejectedCandidateContextPreserved) return;
      const candidate = rejectedCandidateText;
      if (!candidate) return;
      callbacks.appendMessage(buildAssistantHistoryMessage(candidate));
      rejectedCandidateContextPreserved = true;
      logAgentEvent("plan_rejected_candidate_context_preserved", {
        iteration,
        qualityGateReason: currentPlanLastQualityGateReason || materialized.reason || "quality_gate",
        candidateChars: candidate.length,
      });
    };
    const priorPlanAutoScaffoldPromptIssued = planAutoScaffoldPromptIssued;
    const priorPlanClosureEvidenceRecoveryIssued = planClosureEvidenceRecoveryIssued;
    const quality = materialized.quality || classifyPlanArtifactQualityResult({
      ok: false,
      reason: materialized.reason || "quality_gate",
    });
    const candidateMappingSource = rejectedCandidateText;
    if (
      quality.recoveryAction === "targeted_evidence" &&
      candidateMappingSource.length >= 120
    ) {
      currentPlanFacetMappingSource = candidateMappingSource.slice(0, 24_000);
      logAgentEvent("plan_facet_mapping_source_retained", {
        iteration,
        qualityGateReason: quality.reason || materialized.reason || "quality_gate",
        sourceChars: currentPlanFacetMappingSource.length,
      });
    }
    const recovery = handlePlanQualityRecoveryAfterVisibleMaterialization({
      callbacks,
      workflowMode,
      iteration,
      planRuntimePhase: input.planRuntimePhase,
      recentPlanToolActivity,
      attemptedPlanWriteTargets,
      latestUserPromptText,
      turnInputContextSignals,
      planQualityRejectCount,
      planLastQualityGateReason: currentPlanLastQualityGateReason,
      planLastMissingSections,
      planArtifactQualityRejected: currentPlanArtifactQualityRejected,
      planEvidenceRecoveryObjective,
      planAutoScaffoldPromptIssued,
      planClosureEvidenceRecoveryIssued,
      planEvidenceRecoveryPasses: currentPlanEvidenceRecoveryPasses,
      planEvidenceNoProgressPasses: currentPlanEvidenceNoProgressPasses,
      planEvidenceProgressFingerprint: currentPlanEvidenceProgressFingerprint,
      planVisibleQualityPromptBudget: currentPlanVisibleQualityPromptBudget,
      setPlanRuntimePhase,
      quality,
    });
    planQualityRejectCount = recovery.planQualityRejectCount;
    currentPlanLastQualityGateReason = recovery.planLastQualityGateReason;
    planLastMissingSections = recovery.planLastMissingSections;
    currentPlanArtifactQualityRejected = recovery.planArtifactQualityRejected;
    planAutoScaffoldPromptIssued = recovery.planAutoScaffoldPromptIssued;
    planClosureEvidenceRecoveryIssued = recovery.planClosureEvidenceRecoveryIssued;
    planEvidenceRecoveryObjective = recovery.planEvidenceRecoveryObjective;
    currentPlanEvidenceRecoveryPasses = recovery.planEvidenceRecoveryPasses;
    currentPlanEvidenceNoProgressPasses = recovery.planEvidenceNoProgressPasses;
    currentPlanEvidenceProgressFingerprint = recovery.planEvidenceProgressFingerprint;
    currentPlanVisibleQualityPromptBudget = recovery.planVisibleQualityPromptBudget;

    const newlyIssuedClosureEvidenceRecovery =
      !!recovery.pendingPlanRuntimeRecoveryPrompt &&
      recovery.planClosureEvidenceRecoveryIssued &&
      !priorPlanClosureEvidenceRecoveryIssued;
    if (recovery.pendingPlanRuntimeRecoveryPrompt) {
      if (newlyIssuedClosureEvidenceRecovery) {
        logAgentEvent("plan_evidence_materialization_deferred", {
          iteration,
          reason: "targeted_closure_evidence_pending",
          qualityGateReason: recovery.planLastQualityGateReason,
          qualityRejectCount: recovery.planQualityRejectCount,
          evidenceRecoveryPasses: recovery.planEvidenceRecoveryPasses,
        });
      } else {
        // A quality decision is an ordered protocol: first let the model
        // revise the rejected candidate against the already-injected authoring
        // contract, then validate that revision.  Running deterministic
        // materialization first used to skip the visible rewrite entirely as
        // soon as any unrelated bundle defect happened to be closed.
        logAgentEvent("plan_visible_recovery_prompt_dispatched", {
          iteration,
          qualityGateReason: recovery.planLastQualityGateReason,
          qualityRejectCount: recovery.planQualityRejectCount,
          recoveryAction: recovery.pendingPlanRuntimeRecoveryPrompt.includes("PLAN_NEEDS_USER_DECISION")
            ? "ask_user"
            : "rewrite",
          deterministicFallbackDeferred: recovery.deterministicEvidenceMaterializationCandidate,
        });
      }
      callbacks.onStatusChange("running");
      preserveRejectedCandidateForRecovery();
      callbacks.appendMessage({
        role: "user",
        content: recovery.pendingPlanRuntimeRecoveryPrompt,
      });
      return finish("continue");
    }

    if (recovery.awaitingPlanEvidenceResult) {
      // The current candidate arrived while a typed evidence transaction was
      // still active. Only the matching tool-result reconciliation may close
      // that transaction; do not append another prompt, preserve the rejected
      // candidate as new evidence, or misclassify the quiet hold as exhausted.
      logAgentEvent("plan_visible_candidate_held_for_evidence", {
        iteration,
        qualityGateReason: recovery.planLastQualityGateReason,
        qualityRejectCount: recovery.planQualityRejectCount,
        recoveryObjective: recovery.planEvidenceRecoveryObjective,
      });
      callbacks.onStatusChange("running");
      return finish("continue");
    }

    if (recovery.deterministicEvidenceMaterializationCandidate) {
      setPlanRuntimePhase("needs_rewrite", "runtime evidence materialization");
      const evidenceMaterialized = await autoMaterializePlanArtifactFromEvidence({
        workspace,
        callbacks,
        userGoal: latestUserPromptText,
        recentToolActivity: recentPlanToolActivity,
        attemptedTargets: attemptedPlanWriteTargets,
        turnContext: turnInputContextSignals,
      });
      logAgentEvent(
        evidenceMaterialized.ok
          ? "plan_evidence_materialization_succeeded"
          : "plan_evidence_materialization_failed",
        {
          iteration,
          qualityGateReason: recovery.planLastQualityGateReason,
          qualityRejectCount: recovery.planQualityRejectCount,
          sourceFinishReason: normalizedFinishReason || "unknown",
          path: evidenceMaterialized.path || "",
          source: evidenceMaterialized.source || "",
          reason: evidenceMaterialized.reason || "",
          writeFailed: evidenceMaterialized.toolResult?.isError === true,
        },
      );
      if (evidenceMaterialized.ok) {
        currentPlanArtifactQualityRejected = false;
        currentPlanLastQualityGateReason = "";
        planLastMissingSections = [];
        // The typed recovery prompt was only prepared, not appended. Preserve
        // the prior sent-state so a successful runtime materialization cannot
        // manufacture a prompt-history flag that never reached the model.
        planAutoScaffoldPromptIssued = priorPlanAutoScaffoldPromptIssued;
        planClosureEvidenceRecoveryIssued = priorPlanClosureEvidenceRecoveryIssued;
        planEvidenceRecoveryObjective = "none";
        const language = callbacks.getPreferredLanguage();
        return finish(await handOffApprovedPlan({
          callbacks,
          waitForPlanApprovalIfNeeded,
          setPlanRuntimePhase,
          recentPlanToolActivity,
          phaseReason: "runtime evidence artifact accepted",
          qualitySnapshot: {
            qualityRejectCount: planQualityRejectCount,
            missingSections: [],
          },
          assistantHistoryText: language === "zh"
            ? "MAIN 已根据当前用户目标和已确认的只读证据生成并校验计划产物，等待审阅。"
            : "MAIN generated and validated the Plan artifact from the current user goal and confirmed read-only evidence; it is ready for review.",
        }));
      }

      if (
        evidenceMaterialized.quality?.recoveryAction === "targeted_evidence" &&
        !planClosureEvidenceRecoveryIssued
      ) {
        const materializationReason = evidenceMaterialized.reason || "deterministic_plan_needs_targeted_evidence";
        currentPlanArtifactQualityRejected = true;
        currentPlanLastQualityGateReason = materializationReason;
        planClosureEvidenceRecoveryIssued = true;
        planEvidenceRecoveryObjective = "deterministic_closure";
        setPlanRuntimePhase("needs_evidence", materializationReason);
        const targetedPrompt = buildPlanClosureEvidenceRecoveryPrompt(
          MODEL_CONTROL_LANGUAGE,
          materializationReason,
          latestUserPromptText,
        );
        logAgentEvent("plan_evidence_materialization_targeted_recovery", {
          iteration,
          qualityGateReason: recovery.planLastQualityGateReason,
          materializationReason,
          qualityRejectCount: recovery.planQualityRejectCount,
          evidenceRecoveryPasses: currentPlanEvidenceRecoveryPasses,
        });
        callbacks.onStatusChange("running");
        preserveRejectedCandidateForRecovery();
        callbacks.appendMessage({ role: "user", content: targetedPrompt });
        return finish("continue");
      }

      if (
        evidenceMaterialized.quality?.recoveryAction === "targeted_evidence" &&
        planClosureEvidenceRecoveryIssued
      ) {
        logAgentEvent("plan_evidence_materialization_targeted_recovery_suppressed", {
          iteration,
          reason: "closure_evidence_recovery_already_issued",
          materializationReason: evidenceMaterialized.reason || "",
          qualityRejectCount: recovery.planQualityRejectCount,
          evidenceRecoveryPasses: currentPlanEvidenceRecoveryPasses,
        });
      }

      if (evidenceMaterialized.toolResult?.isError === true) {
        const failureReason = `evidence_materialization_write_failed:${evidenceMaterialized.reason || "unknown"}`;
        logAgentEvent("loop_stop", {
          reason: "plan_evidence_materialization_exhausted",
          iteration,
          qualityGateReason: recovery.planLastQualityGateReason,
          qualityRejectCount: recovery.planQualityRejectCount,
          materializationReason: evidenceMaterialized.reason || "",
        });
        callbacks.onNonActionableStop(
          buildPlanGenerationFailedMessage(callbacks.getPreferredLanguage(), failureReason),
          "incomplete_plan",
          buildPlanGenerationFailedProgress(failureReason),
        );
        callbacks.onStatusChange("idle");
        return finish("stopped");
      }

    }

    logAgentEvent("loop_stop", {
      reason: "plan_visible_quality_recovery_exhausted",
      iteration,
      qualityGateReason: currentPlanLastQualityGateReason,
      qualityRejectCount: planQualityRejectCount,
    });
    callbacks.onNonActionableStop(
      buildPlanGenerationFailedMessage(
        callbacks.getPreferredLanguage(),
        currentPlanLastQualityGateReason || "materialization_quality_gate",
      ),
      "incomplete_plan",
      buildPlanGenerationFailedProgress(currentPlanLastQualityGateReason || "materialization_quality_gate"),
    );
    callbacks.onStatusChange("idle");
    return finish("stopped");
  };

  if (decision.shouldEnterReview) {
    currentPlanLastQualityGateReason = "";
    planLastMissingSections = [];
    const handoff = await handOffApprovedPlan({
      callbacks,
      waitForPlanApprovalIfNeeded,
      setPlanRuntimePhase,
      recentPlanToolActivity,
      phaseReason: "accepted artifact ready",
      assistantHistoryText,
      providerReasoningForHistory,
    });
    if (handoff === "continue") {
      consecutiveNoToolCount = 0;
      attemptedPlanWriteTargets.length = 0;
    }
    return finish(handoff);
  }

  if (
    workflowMode === "plan" &&
    !callbacks.getIsPlanApproved() &&
    input.planRuntimePhase === "blocked" &&
    !hasReviewablePlanArtifacts &&
    !hasTypedPlanCandidate
  ) {
    const failureReason = currentPlanLastQualityGateReason || "plan_evidence_recovery_exhausted";
    logAgentEvent("plan_blocked_candidate_rejected", {
      iteration,
      reason: failureReason,
      hasStructuredProposal,
      evidenceRecoveryPasses: currentPlanEvidenceRecoveryPasses,
    });
    callbacks.onNonActionableStop(
      buildPlanGenerationFailedMessage(callbacks.getPreferredLanguage(), failureReason),
      "incomplete_plan",
      buildPlanGenerationFailedProgress(failureReason),
    );
    callbacks.onStatusChange("idle");
    return finish("stopped");
  }

  if (decision.shouldMaterializeStructuredProposal) {
    const visibleText = hasTypedPlanCandidate
      ? typedPlanCandidateInStream ? streamText : sourceVisibleText
      : selectPlanMaterializationSourceText({
          hasStructuredProposal,
          streamText,
          sourceVisibleText,
        });
    const materializedProposal = await autoMaterializePlanArtifactFromVisibleText({
      visibleText,
      workspace,
      callbacks,
      userGoal: latestUserPromptText,
      recentToolActivity: recentPlanToolActivity,
      attemptedTargets: attemptedPlanWriteTargets,
      turnContext: turnInputContextSignals,
      candidateRepairCheckpoint: currentPlanCandidateRepairCheckpoint,
    });
    logAgentEvent(
      materializedProposal.ok
        ? "plan_structured_proposal_materialized"
        : "plan_structured_proposal_materialization_rejected",
      {
        iteration,
        ok: materializedProposal.ok,
        path: materializedProposal.path || "",
        kind: materializedProposal.kind || "",
        reason: materializedProposal.reason || "",
        recoveryAction: materializedProposal.quality?.recoveryAction || "",
        planArtifactSource: materializedProposal.source || "",
        visibleChars: visibleText.length,
        replyOptionsCount: (materializedProposal.replyOptions || []).length,
      },
    );
    if (!materializedProposal.ok) {
      return recoverRejectedVisibleCandidate(materializedProposal, visibleText);
    }

    currentPlanArtifactQualityRejected = false;
    currentPlanCandidateRepairCheckpoint = null;
    currentPlanLastQualityGateReason = "";
    planLastMissingSections = [];
    const handoff = await handOffApprovedPlan({
      callbacks,
      waitForPlanApprovalIfNeeded,
      setPlanRuntimePhase,
      recentPlanToolActivity,
      phaseReason: "visible candidate accepted",
      assistantHistoryText,
      providerReasoningForHistory,
    });
    if (handoff === "continue") {
      consecutiveNoToolCount = 0;
      attemptedPlanWriteTargets.length = 0;
    }
    return finish(handoff);
  }

  if (decision.shouldTryPlanTextMaterialization) {
    const materializedPlan = await autoMaterializePlanArtifactFromVisibleText({
      visibleText: sourceVisibleText,
      workspace,
      callbacks,
      userGoal: latestUserPromptText,
      recentToolActivity: recentPlanToolActivity,
      attemptedTargets: attemptedPlanWriteTargets,
      turnContext: turnInputContextSignals,
      candidateRepairCheckpoint: currentPlanCandidateRepairCheckpoint,
    });

    if (materializedPlan.ok) {
      currentPlanCandidateRepairCheckpoint = null;
      logAgentEvent("plan_text_materialized", {
        iteration,
        path: materializedPlan.path,
        kind: materializedPlan.kind,
        planArtifactSource: materializedPlan.source || "",
        visibleChars: sourceVisibleText.length,
        sawPlanModeToolActivity,
        wasTruncated,
      });
      const handoff = await handOffApprovedPlan({
        callbacks,
        waitForPlanApprovalIfNeeded,
        setPlanRuntimePhase,
        recentPlanToolActivity,
        phaseReason: "materialized plan accepted",
        assistantHistoryText,
        providerReasoningForHistory,
      });
      if (handoff === "continue") {
        consecutiveNoToolCount = 0;
        attemptedPlanWriteTargets.length = 0;
      }
      return finish(handoff);
    }

    logAgentEvent("plan_text_materialization_rejected", {
      iteration,
      reason: materializedPlan.reason || "unknown",
      recoveryAction: materializedPlan.quality?.recoveryAction || "",
      visibleChars: sourceVisibleText.length,
    });
    return recoverRejectedVisibleCandidate(materializedPlan);
  }

  if (decision.shouldMaterializeFallbackPlan) {
    if (sourceVisibleText.trim()) {
      callbacks.onAssistantFinalText(sourceVisibleText, [], {
        hasToolCalls: false,
        visibility: "substantive_plan_text",
      });
    }
    callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));

    if (usedPlanRecoveryPrompt) {
      const closureResult = await tryClosePlanWithEvidence("plan_recovery_prompt_limit", {
        rejectedVisibleCandidate: sourceVisibleText.trim().length > 0,
        toolCallCount: effectiveToolCallCount,
        replyOptionCount: finalReplyOptionsCount,
      });
      if (closureResult === "approved_continue") return finish("continue");
      if (closureResult === "stopped") return finish("stopped");
      if (closureResult === "failed") {
        logAgentEvent("plan_empty_after_closure_failed", {
          iteration,
          visibleChars: sourceVisibleText.length,
        });
        if (!planClosureEvidenceRecoveryIssued) {
          planClosureEvidenceRecoveryIssued = true;
          planEvidenceRecoveryObjective = "deterministic_closure";
          setPlanRuntimePhase("needs_evidence", "plan closure failed");
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildPlanClosureEvidenceRecoveryPrompt(
              MODEL_CONTROL_LANGUAGE,
              currentPlanLastQualityGateReason || "plan closure failed",
              latestUserPromptText,
            ),
          });
          return finish("continue");
        }
      }
      logAgentEvent("loop_stop", {
        reason: "plan_recovery_prompt_limit",
        iteration,
        visibleChars: sourceVisibleText.length,
        finishReason: normalizedFinishReason || "unknown",
      });
      callbacks.onNonActionableStop(
        buildPlanGenerationFailedMessage(callbacks.getPreferredLanguage(), "materialization_recovery_exhausted"),
        "incomplete_plan",
        buildPlanGenerationFailedProgress("materialization_recovery_exhausted"),
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }

    usedPlanRecoveryPrompt = true;
    logAgentEvent("plan_recovery_prompt_start", {
      iteration,
      visibleChars: sourceVisibleText.length,
      finishReason: normalizedFinishReason || "unknown",
      sawPlanModeToolActivity,
    });
    callbacks.onStatusChange("running");
    callbacks.appendMessage({
      role: "user",
      content: buildPlanRecoveryPrompt(callbacks, sourceVisibleText, attemptedPlanWriteTargets),
    });
    return finish("continue");
  }

  if (decision.shouldRefineLongPlanIntoChoice) {
    callbacks.onStatusChange("running");
    consecutiveNoToolCount += 1;
    logAgentEvent("plan_refine_long_output", {
      iteration,
      consecutiveNoToolCount,
      visibleChars: normalizedVisibleText.length,
      finishReason: normalizedFinishReason || "unknown",
    });
    if (consecutiveNoToolCount >= resolveExecuteNoToolCheckpointLimit(activeProfile)) {
      logAgentEvent("loop_stop", {
        reason: "plan_refine_long_output_limit",
        iteration,
        consecutiveNoToolCount,
      });
      callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
      callbacks.onNonActionableStop(
        buildPlanGenerationFailedMessage(callbacks.getPreferredLanguage(), "truncated_plan_refinement_exhausted"),
        "incomplete_plan",
        buildPlanGenerationFailedProgress("truncated_plan_refinement_exhausted"),
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }
    callbacks.appendMessage({
      role: "user",
      content: "The previous planning reply was too long and was truncated. Do not continue with a long plan and do not write `.MAIN/plans/` files. Condense it into no more than 8 bullets, then offer 2-4 decision options with `<user_options>` in MAIN's configured response language and stop immediately.",
    });
    return finish("continue");
  }

  if (decision.shouldForcePlanContinuation) {
    consecutiveNoToolCount += 1;
    if (consecutiveNoToolCount >= resolveExecuteNoToolCheckpointLimit(activeProfile)) {
      const closureResult = await tryClosePlanWithEvidence("force_plan_continuation_limit", {
        rejectedVisibleCandidate: sourceVisibleText.trim().length > 0,
        toolCallCount: effectiveToolCallCount,
        replyOptionCount: finalReplyOptionsCount,
      });
      if (closureResult === "approved_continue") return finish("continue");
      if (closureResult === "stopped") return finish("stopped");
      if (closureResult === "failed") {
        logAgentEvent("plan_empty_after_closure_failed", {
          iteration,
          consecutiveNoToolCount,
        });
      }
      logAgentEvent("loop_stop", {
        reason: "force_plan_continuation_limit",
        iteration,
        consecutiveNoToolCount,
      });
      callbacks.onNonActionableStop(
        buildPlanGenerationFailedMessage(callbacks.getPreferredLanguage(), "plan_continuation_exhausted"),
        "incomplete_plan",
        buildPlanGenerationFailedProgress("plan_continuation_exhausted"),
      );
      callbacks.onStatusChange("idle");
      return finish("stopped");
    }
    callbacks.appendMessage({
      role: "user",
      content: buildForcePlanContinuationPrompt({
        language: MODEL_CONTROL_LANGUAGE,
        currentPlanStage,
        sawPlanModeToolActivity,
        wasTruncated,
      }),
    });
    return finish("continue");
  }

  return finish("none");
}
