import type { StreamResult } from "../../streaming";
import type { PlanRuntimePhase } from "../../workflowModels";
import type { ResolvedUserIntent } from "../../runIntent";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import {
  autoMaterializePlanArtifactFromVisibleText,
  buildApprovedPlanContinuationPrompt,
  buildAssistantHistoryMessage,
  buildNonActionableStopMessage,
  buildPlanRecoveryPrompt,
  CONCISE_PLAN_ARTIFACT_HINT_EN,
  CONCISE_PLAN_ARTIFACT_HINT_ZH,
  logAgentEvent,
} from "../../orchestrator";
import { MAX_PLAN_EVIDENCE_RECOVERY_PASSES } from "../../planRuntime";
import type { OrchestratorCallbacks } from "../types";
import { resolveExecuteNoToolCheckpointLimit } from "./executeNoToolRecovery";

export type PlanNoToolRecoveryStatus = "none" | "continue" | "stopped";
export type PlanClosureAttemptResult = "not_attempted" | "failed" | "stopped" | "approved_continue";

export type PlanNoToolRecoveryResult = {
  status: PlanNoToolRecoveryStatus;
  consecutiveNoToolCount: number;
  usedPlanRecoveryPrompt: boolean;
  planClosureEvidenceRecoveryIssued: boolean;
};

export function buildPlanClosureEvidenceRecoveryPrompt(language: "zh" | "en", reason: string): string {
  if (language === "en") {
    return [
      "PLAN_CLOSURE_NEEDS_EVIDENCE: MAIN could not get a model-authored reviewable plan from the current clean evidence.",
      reason ? `Failure reason: ${reason}.` : "",
      "Do exactly one targeted read/search for the missing source or data fact. Prefer the specific file, symbol, or dataset already implicated by the user request.",
      "After that single tool result, stop exploring and write `.MAIN/plans/plan.md`; if write tools are unavailable, produce a concise visible `<proposed_plan>`.",
      "Do not call broad directory scans, do not edit source files, and do not create `tasks.md` before approval.",
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_CLOSURE_NEEDS_EVIDENCE: MAIN 无法基于当前干净证据拿到模型亲自生成的可审批计划。",
    reason ? `失败原因：${reason}。` : "",
    "下一步只做一次定向读取/搜索，补齐缺失的源码或数据事实。优先读取用户目标已经指向的具体文件、符号或数据集。",
    "拿到这一次工具结果后，停止探索并写入 `.MAIN/plans/plan.md`；如果写入工具不可用，输出精简可见 `<proposed_plan>`。",
    "不要再泛扫目录；批准前不要修改源码，也不要创建 `tasks.md`。",
  ].filter(Boolean).join("\n");
}

export function resolvePlanNoToolRecoveryDecision(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
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
  shouldTryPlanTextMaterialization: boolean;
  shouldMaterializeFallbackPlan: boolean;
  shouldRefineLongPlanIntoChoice: boolean;
  shouldForcePlanContinuation: boolean;
} {
  const planningStillIncomplete =
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    !input.hasStructuredProposal &&
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
      input.workflowMode === "plan" &&
      !input.isPlanApproved &&
      (input.hasStructuredProposal || input.hasReviewablePlanArtifacts),
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
  setPlanRuntimePhase: (phase: PlanRuntimePhase, reason?: string, status?: "pending" | "running" | "done" | "failed") => void;
  phaseReason: string;
  assistantHistoryText: string;
  providerReasoningForHistory?: Pick<StreamResult, "reasoningContent" | "reasoningField"> | null;
}): Promise<"continue" | "stopped"> {
  const {
    callbacks,
    waitForPlanApprovalIfNeeded,
    setPlanRuntimePhase,
    phaseReason,
    assistantHistoryText,
    providerReasoningForHistory,
  } = input;
  setPlanRuntimePhase("review_ready", phaseReason, "done");
  callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
  const approved = await waitForPlanApprovalIfNeeded();
  if (!approved) {
    if (callbacks.getStatus() !== "pending_review") {
      callbacks.onStatusChange("idle");
    }
    return "stopped";
  }

  callbacks.onPlanStageChanged("executing");
  const continuationPrompt = buildApprovedPlanContinuationPrompt(callbacks);
  if (callbacks.onApprovedPlanHandoff) {
    callbacks.onApprovedPlanHandoff(continuationPrompt);
    callbacks.onStatusChange("idle");
    return "stopped";
  }

  callbacks.appendMessage({
    role: "user",
    content: continuationPrompt,
  });
  return "continue";
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
  planEvidenceRecoveryPasses: number;
  planLastQualityGateReason: string;
  setPlanRuntimePhase: (phase: PlanRuntimePhase, reason?: string, status?: "pending" | "running" | "done" | "failed") => void;
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
    planLastQualityGateReason,
    setPlanRuntimePhase,
    waitForPlanApprovalIfNeeded,
    tryClosePlanWithEvidence,
  } = input;
  let consecutiveNoToolCount = input.consecutiveNoToolCount;
  let usedPlanRecoveryPrompt = input.usedPlanRecoveryPrompt;
  let planClosureEvidenceRecoveryIssued = input.planClosureEvidenceRecoveryIssued;
  const finish = (status: PlanNoToolRecoveryStatus): PlanNoToolRecoveryResult => ({
    status,
    consecutiveNoToolCount,
    usedPlanRecoveryPrompt,
    planClosureEvidenceRecoveryIssued,
  });

  const currentPlanStage = callbacks.getPlanStage();
  const decision = resolvePlanNoToolRecoveryDecision({
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
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

  if (decision.shouldEnterReview) {
    let hasMaterializedStructuredProposal = hasReviewablePlanArtifacts;
    if (hasStructuredProposal && !hasReviewablePlanArtifacts) {
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
          planArtifactSource: materializedProposal.source || "",
          visibleChars: visibleText.length,
          replyOptionsCount: (materializedProposal.replyOptions || []).length,
        },
      );
      hasMaterializedStructuredProposal = materializedProposal.ok;
    }

    if (hasMaterializedStructuredProposal) {
      const handoff = await handOffApprovedPlan({
        callbacks,
        waitForPlanApprovalIfNeeded,
        setPlanRuntimePhase,
        phaseReason: "proposal ready",
        assistantHistoryText,
        providerReasoningForHistory,
      });
      return finish(handoff);
    }
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
        phaseReason: "materialized plan accepted",
        assistantHistoryText,
        providerReasoningForHistory,
      });
      return finish(handoff);
    }

    logAgentEvent("plan_text_materialization_rejected", {
      iteration,
      reason: materializedPlan.reason || "unknown",
      visibleChars: sourceVisibleText.length,
    });
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
        if (!planClosureEvidenceRecoveryIssued && planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES) {
          planClosureEvidenceRecoveryIssued = true;
          setPlanRuntimePhase("needs_evidence", "plan closure failed");
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildPlanClosureEvidenceRecoveryPrompt(
              callbacks.getPreferredLanguage(),
              planLastQualityGateReason || "plan closure failed",
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
        buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
        "incomplete_plan",
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
        buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
        "incomplete_plan",
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
        buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "no_output"),
        "no_output",
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
