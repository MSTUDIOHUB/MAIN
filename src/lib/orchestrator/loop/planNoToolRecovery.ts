import type { StreamResult } from "../../streaming";
import {
  classifyPlanArtifactQualityResult,
  type PlanRuntimePhase,
} from "../../workflowModels";
import type { ResolvedUserIntent } from "../../runIntent";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import { buildPlanClosureEvidenceRecoveryPrompt } from "../planOrchestration";
import {
  autoMaterializePlanArtifactFromEvidence,
  autoMaterializePlanArtifactFromVisibleText,
  buildAssistantHistoryMessage,
  buildPlanRecoveryPrompt,
  CONCISE_PLAN_ARTIFACT_HINT_EN,
  CONCISE_PLAN_ARTIFACT_HINT_ZH,
  logAgentEvent,
} from "../../orchestrator";
import { MAX_PLAN_EVIDENCE_RECOVERY_PASSES } from "../../planRuntime";
import type { OrchestratorCallbacks } from "../types";
import { resolveExecuteNoToolCheckpointLimit } from "./executeNoToolRecovery";
import { handlePlanQualityRecoveryAfterVisibleMaterialization } from "./planQualityRecovery";
import type { PlanRuntimePhaseQualitySnapshot } from "./planRuntimeState";

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
  planArtifactQualityRejected: boolean;
  planAutoScaffoldPromptIssued: boolean;
  planEvidenceRecoveryPasses: number;
};

export { buildPlanClosureEvidenceRecoveryPrompt } from "../planOrchestration";

function buildPlanGenerationFailedMessage(language: "zh" | "en", reason: string): string {
  return language === "zh"
    ? `计划生成失败：经过有界的计划物化恢复后，仍未得到通过校验的计划产物（${reason}）。请补充约束或重试计划生成。`
    : `Plan generation failed: bounded materialization recovery did not produce a validated plan artifact (${reason}). Add constraints or retry plan generation.`;
}

function buildPlanGenerationFailedProgress(reason: string) {
  return {
    recoveryReason: "plan_generation_failed",
    nextStep: reason,
  };
}

export function shouldAttemptPlanEvidenceMaterialization(input: {
  recoveryAction?: string | null;
  qualityRejectCount: number;
  qualityGateReason?: string | null;
  finishReason?: string | null;
}): boolean {
  if (input.recoveryAction === "ask_user") return false;
  return input.finishReason === "length" ||
    input.qualityRejectCount >= 2 ||
    /excessive_plan_code_dump|insufficient_actionable_plan_signals|missing_plan_required_sections/i.test(
      String(input.qualityGateReason || ""),
    );
}

export function resolvePlanNoToolRecoveryDecision(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  planArtifactQualityRejected?: boolean;
  hasStructuredProposal: boolean;
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
}): {
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
  const planningStillIncomplete =
    isUnapprovedPlan &&
    !hasAcceptedReviewArtifact &&
    input.currentPlanStage !== "ready_to_execute";
  const hasMeaningfulSourcePlanText = input.sourceVisibleText.trim().length > 0;
  const shouldMaterializeFallbackPlan =
    planningStillIncomplete &&
    hasMeaningfulSourcePlanText &&
    !input.hasReviewablePlanArtifacts &&
    (
      input.sawPlanModeToolActivity ||
      input.wasTruncated ||
      input.hasExecutablePlanProposalOptions ||
      input.planReplyOptionsRoutedToArtifact
    );
  const shouldTryPlanTextMaterialization =
    planningStillIncomplete &&
    hasMeaningfulSourcePlanText &&
    !input.hasReviewablePlanArtifacts &&
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
    shouldEnterReview:
      isUnapprovedPlan && hasAcceptedReviewArtifact,
    shouldMaterializeStructuredProposal:
      isUnapprovedPlan &&
      input.hasStructuredProposal &&
      (!input.hasReviewablePlanArtifacts || input.planArtifactQualityRejected === true),
    shouldTryPlanTextMaterialization,
    shouldMaterializeFallbackPlan,
    shouldRefineLongPlanIntoChoice:
      planningStillIncomplete &&
      input.hasMeaningfulVisibleText &&
      input.wasTruncated &&
      !shouldMaterializeFallbackPlan,
    shouldForcePlanContinuation: planningStillIncomplete && !input.hasMeaningfulVisibleText,
  };
}

function buildForcePlanContinuationPrompt(input: {
  language: "zh" | "en";
  currentPlanStage: string;
  sawPlanModeToolActivity: boolean;
  wasTruncated: boolean;
}): string {
  const { language, currentPlanStage, sawPlanModeToolActivity, wasTruncated } = input;
  const missingStepHint =
    language === "zh"
      ? currentPlanStage === "requirements"
        ? "你已经有旧流程的 requirements.md，下一步必须创建/更新 `.MAIN/plans/plan.md` 作为可审批方案；如果设计方向仍不明确，只能用 `<user_options>` 给出面向用户的选择并停止。不要重复读取已读文件。"
        : currentPlanStage === "design"
        ? "你已经有 plan.md，下一步应输出正式 Proposal 或给用户关键选择；不要在批准前提前生成 tasks.md。"
        : sawPlanModeToolActivity
        ? "你已经开始做项目探索了，但还没有给出可让用户决策的规划结果。下一步应先收束分歧并询问用户。"
        : "请先给出可让用户决策的规划问题。"
      : currentPlanStage === "requirements"
      ? "A legacy requirements.md exists. Next create/update `.MAIN/plans/plan.md` as the reviewable plan; if the plan direction is still unclear, offer `<user_options>` and stop. Do not repeat reads of files already in context."
      : currentPlanStage === "design"
      ? "plan.md exists. Next submit the formal Proposal or offer the key choices; do not generate tasks.md before approval."
      : sawPlanModeToolActivity
      ? "You have started project exploration but have not produced a planning result the user can decide on. Next condense the tradeoffs and ask the user."
      : "First present a planning question the user can decide on.";

  return language === "zh"
    ? `当前规划还没有进入可执行阶段。${missingStepHint}\n` +
        `${CONCISE_PLAN_ARTIFACT_HINT_ZH}\n` +
        "请继续规划，并在本轮结束前完成以下其一：\n" +
        "1. 用普通 Markdown 输出 3-8 条关键判断，然后用面向用户的口吻给出 2-4 个 `<user_options>` 让用户选择；每个选项必须是用户可直接点击发送的完整选择，不要写成“是否……”问题句。\n" +
        "2. 如果信息已经足够，用 write_file 或 replace_in_file 创建/更新 `.MAIN/plans/plan.md`，提交正式可审批方案。\n" +
        "3. 如果这是复杂实现计划，必须落盘可审批 plan.md；requirements.md 只是可选需求台账，在用户批准之前不要生成 `tasks.md` 或修改源码。\n" +
        `${currentPlanStage === "requirements" ? "当前已经有旧流程 requirements.md，本轮不要重复读文件；请直接写入 plan.md，或用 user_options 询问设计分叉。\n" : ""}` +
        `${wasTruncated ? "你上一条回复已经发生截断，请从中断处继续，不要重头重复。\n" : ""}` +
        "不要只输出一句总结、结束语，或空结束符。"
    : `The current plan has not reached an executable stage. ${missingStepHint}\n` +
        `${CONCISE_PLAN_ARTIFACT_HINT_EN}\n` +
        "Continue planning and complete one of these before ending this turn:\n" +
        "1. Output 3-8 key judgments in Markdown, then offer 2-4 `<user_options>` for the user to choose from.\n" +
        "2. If there is enough information, use write_file or replace_in_file to create/update `.MAIN/plans/plan.md` as the formal reviewable plan.\n" +
        "3. For complex implementation planning, the reviewable plan must be persisted to plan.md; requirements.md is only an optional requirement ledger. Do not generate `tasks.md` or edit source files before approval.\n" +
        `${currentPlanStage === "requirements" ? "A legacy requirements.md already exists. Do not repeat file reads in this turn; write plan.md directly, or ask for design choices with user_options.\n" : ""}` +
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
  setPlanRuntimePhase("review_ready", phaseReason, "done", qualitySnapshot);
  if (callbacks.getStatus() !== "pending_review") {
    callbacks.onStatusChange("pending_review");
  }
  callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
  logAgentEvent("plan_review_run_paused", {
    phaseReason,
    planStage: callbacks.getPlanStage(),
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
  recentPlanToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  turnInputContextSignals: TurnInputContextSignals;
  consecutiveNoToolCount: number;
  usedPlanRecoveryPrompt: boolean;
  planClosureEvidenceRecoveryIssued: boolean;
  planRuntimePhase: PlanRuntimePhase;
  planEvidenceRecoveryPasses: number;
  planQualityRejectCount: number;
  planLastQualityGateReason: string;
  planLastMissingSections: string[];
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
    rejectedVisibleChars?: number;
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
    recentPlanToolActivity,
    attemptedPlanWriteTargets,
    turnInputContextSignals,
    planEvidenceRecoveryPasses,
    planQualityRejectCount: initialPlanQualityRejectCount,
    planLastQualityGateReason,
    planLastMissingSections: initialPlanLastMissingSections,
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
  let currentPlanArtifactQualityRejected = planArtifactQualityRejected === true;
  let planAutoScaffoldPromptIssued = input.planAutoScaffoldPromptIssued;
  let currentPlanEvidenceRecoveryPasses = planEvidenceRecoveryPasses;
  const finish = (status: PlanNoToolRecoveryStatus): PlanNoToolRecoveryResult => ({
    status,
    consecutiveNoToolCount,
    usedPlanRecoveryPrompt,
    planClosureEvidenceRecoveryIssued,
    planQualityRejectCount,
    planLastQualityGateReason: currentPlanLastQualityGateReason,
    planLastMissingSections,
    planArtifactQualityRejected: currentPlanArtifactQualityRejected,
    planAutoScaffoldPromptIssued,
    planEvidenceRecoveryPasses: currentPlanEvidenceRecoveryPasses,
  });

  const currentPlanStage = callbacks.getPlanStage();
  const decision = resolvePlanNoToolRecoveryDecision({
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    planArtifactQualityRejected: currentPlanArtifactQualityRejected,
    hasStructuredProposal,
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
  });

  const recoverRejectedVisibleCandidate = async (
    materialized: Awaited<ReturnType<typeof autoMaterializePlanArtifactFromVisibleText>>,
  ): Promise<PlanNoToolRecoveryResult> => {
    const priorPlanAutoScaffoldPromptIssued = planAutoScaffoldPromptIssued;
    const priorPlanClosureEvidenceRecoveryIssued = planClosureEvidenceRecoveryIssued;
    const quality = materialized.quality || classifyPlanArtifactQualityResult({
      ok: false,
      reason: materialized.reason || "quality_gate",
    });
    const recovery = handlePlanQualityRecoveryAfterVisibleMaterialization({
      callbacks,
      workflowMode,
      iteration,
      planRuntimePhase: input.planRuntimePhase,
      recentPlanToolActivity,
      attemptedPlanWriteTargets,
      latestUserPromptText,
      planQualityRejectCount,
      planLastQualityGateReason: currentPlanLastQualityGateReason,
      planLastMissingSections,
      planArtifactQualityRejected: currentPlanArtifactQualityRejected,
      planAutoScaffoldPromptIssued,
      planClosureEvidenceRecoveryIssued,
      planEvidenceRecoveryPasses: currentPlanEvidenceRecoveryPasses,
      setPlanRuntimePhase,
      quality,
    });
    planQualityRejectCount = recovery.planQualityRejectCount;
    currentPlanLastQualityGateReason = recovery.planLastQualityGateReason;
    planLastMissingSections = recovery.planLastMissingSections;
    currentPlanArtifactQualityRejected = recovery.planArtifactQualityRejected;
    planAutoScaffoldPromptIssued = recovery.planAutoScaffoldPromptIssued;
    planClosureEvidenceRecoveryIssued = recovery.planClosureEvidenceRecoveryIssued;
    currentPlanEvidenceRecoveryPasses = recovery.planEvidenceRecoveryPasses;

    const shouldAttemptEvidenceMaterialization = shouldAttemptPlanEvidenceMaterialization({
      recoveryAction: quality.recoveryAction,
      qualityRejectCount: recovery.planQualityRejectCount,
      qualityGateReason: recovery.planLastQualityGateReason,
      finishReason: normalizedFinishReason,
    });
    if (shouldAttemptEvidenceMaterialization) {
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
        evidenceMaterialized.toolResult?.isError === true ||
        recovery.planQualityRejectCount >= 2
      ) {
        const failureReason = evidenceMaterialized.toolResult?.isError === true
          ? `evidence_materialization_write_failed:${evidenceMaterialized.reason || "unknown"}`
          : `evidence_materialization_rejected:${evidenceMaterialized.reason || recovery.planLastQualityGateReason || "quality_gate"}`;
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

    if (recovery.pendingPlanRuntimeRecoveryPrompt) {
      callbacks.onStatusChange("running");
      callbacks.appendMessage({
        role: "user",
        content: recovery.pendingPlanRuntimeRecoveryPrompt,
      });
      return finish("continue");
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

  if (decision.shouldMaterializeStructuredProposal) {
    const visibleText = sourceVisibleText || streamText;
    const materializedProposal = await autoMaterializePlanArtifactFromVisibleText({
      visibleText,
      workspace,
      callbacks,
      userGoal: latestUserPromptText,
      recentToolActivity: recentPlanToolActivity,
      attemptedTargets: attemptedPlanWriteTargets,
      turnContext: turnInputContextSignals,
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
      return recoverRejectedVisibleCandidate(materializedProposal);
    }

    currentPlanArtifactQualityRejected = false;
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
    });

    if (materializedPlan.ok) {
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
        rejectedVisibleChars: sourceVisibleText.length,
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
        if (!planClosureEvidenceRecoveryIssued && currentPlanEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES) {
          planClosureEvidenceRecoveryIssued = true;
          setPlanRuntimePhase("needs_evidence", "plan closure failed");
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildPlanClosureEvidenceRecoveryPrompt(
              callbacks.getPreferredLanguage(),
              currentPlanLastQualityGateReason || "plan closure failed",
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
      content: callbacks.getPreferredLanguage() === "zh"
        ? "上一条规划内容过长并发生截断。不要继续输出长篇计划，也不要写入 `.MAIN/plans/`。请把刚才内容收束成不超过 8 条要点，然后用面向用户的口吻提出 2-4 个可点击选项。每个 `<option>` 必须是用户点击后会发送的完整选择，不要写成“是否……”问题句。使用 `<user_options>` 后立刻停止等待。"
        : "The previous planning reply was too long and was truncated. Do not continue with a long plan and do not write `.MAIN/plans/` files. Condense it into no more than 8 bullets, then offer 2-4 decision options with `<user_options>` and stop immediately.",
    });
    return finish("continue");
  }

  if (decision.shouldForcePlanContinuation) {
    consecutiveNoToolCount += 1;
    if (consecutiveNoToolCount >= resolveExecuteNoToolCheckpointLimit(activeProfile)) {
      const closureResult = await tryClosePlanWithEvidence("force_plan_continuation_limit", {
        rejectedVisibleChars: sourceVisibleText.length,
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
        language: callbacks.getPreferredLanguage(),
        currentPlanStage,
        sawPlanModeToolActivity,
        wasTruncated,
      }),
    });
    return finish("continue");
  }

  return finish("none");
}
