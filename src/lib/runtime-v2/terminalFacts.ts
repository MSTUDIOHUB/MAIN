import { workspacePathsReferToSameFile } from "../workspacePaths";
import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2ResultKind } from "./contracts";
import type { RuntimeV2Event } from "./events";
import { approvedRuntimeV2PlanContinuation } from "./planContinuationBaseline";
import { deriveRuntimeV2PlanExecutionCoverage } from "./planExecution";
import {
  deriveRuntimeV2ReviewDispositionLedger,
  type RuntimeV2ReviewDispositionLedger,
} from "./reviewFindings";
import {
  deriveUnityCompilation,
  deriveUnityShaderImport,
  unityCompilationMessage,
  type UnityCompilationResult,
  unresolvedUnityEditorCheck,
} from "./unityCompilation";
import { isRuntimeV2ValidationAttempt } from "./validationAttempt";
import {
  runtimeV2ValidationBoundaryMatchesCurrent,
  runtimeV2WorkspaceChangeReceipts,
} from "./validationReceipt";

export interface RuntimeV2TerminalUnityCheckFact {
  readonly kind: "csharp" | "shader_import";
  readonly status: UnityCompilationResult["status"] | "pending";
  readonly errorCount: number;
  readonly targets: readonly string[];
  readonly message?: string;
}

export interface RuntimeV2TerminalManualCheckFact {
  readonly command: string;
  readonly expectedOutcome: string;
}

export interface RuntimeV2TerminalAcceptanceFacts {
  readonly hasApprovedWorkPlan: boolean;
  readonly isManualVerification: boolean;
  readonly deliveredFiles: readonly string[];
  readonly plannedTargets: readonly string[];
  readonly missingTargets: readonly string[];
  readonly completedStepCount: number;
  readonly totalExecutableStepCount: number;
  readonly automatedValidations: {
    readonly totalCount: number;
    readonly currentPassedCount: number;
    readonly currentFailedCount: number;
    readonly requiredCount: number;
    readonly passedRequiredCount: number;
    readonly missingRequiredCount: number;
    readonly allRequiredPassed: boolean;
    readonly passedTargets: readonly string[];
    readonly failedTargets: readonly string[];
  };
  readonly unityChecks: readonly RuntimeV2TerminalUnityCheckFact[];
  readonly manualChecklist: readonly RuntimeV2TerminalManualCheckFact[];
  readonly reviewLedger: RuntimeV2ReviewDispositionLedger;
  readonly hasPostApprovalGuidance: boolean;
  readonly latestMutationSequence: number;
  readonly allDeliveredAndVerified: boolean;
}

function markdownCode(value: string): string {
  const clean = value.trim().replace(/`/g, "");
  return clean ? `\`${clean}\`` : "";
}

function workspaceRelativeTarget(value: string, workspaceKey: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  const workspace = workspaceKey.replace(/\\/g, "/").replace(/\/+$/, "");
  if (workspace && normalized.startsWith(`${workspace}/`)) {
    return normalized.slice(workspace.length + 1);
  }
  return raw;
}

function approvedSequence(aggregate: TurnAggregateV1): number {
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index];
    if (event?.type === "work_plan.approved") return event.sequence;
  }
  return -1;
}

function uniqueOrderedPaths(paths: readonly string[]): readonly string[] {
  const seen: string[] = [];
  for (const candidate of paths) {
    const clean = candidate.trim();
    if (!clean) continue;
    if (!seen.some((item) => workspacePathsReferToSameFile(item, clean))) {
      seen.push(clean);
    }
  }
  return seen;
}

const terminalFactsCache = new WeakMap<TurnAggregateV1, RuntimeV2TerminalAcceptanceFacts>();

export function deriveRuntimeV2TerminalAcceptanceFacts(
  aggregate: TurnAggregateV1,
): RuntimeV2TerminalAcceptanceFacts {
  const cached = terminalFactsCache.get(aggregate);
  if (cached) return cached;

  const plan = aggregate.sealedWorkPlan;
  const hasApprovedWorkPlan =
    aggregate.strategy === "plan" &&
    aggregate.workPlan?.status === "approved" &&
    !!plan;
  const approvedSeq = approvedSequence(aggregate);
  const continuation = approvedRuntimeV2PlanContinuation(aggregate.events);
  const coverage = hasApprovedWorkPlan
    ? deriveRuntimeV2PlanExecutionCoverage(aggregate)
    : null;

  const rawMutationReceipts = runtimeV2WorkspaceChangeReceipts(aggregate);
  const relevantMutations = hasApprovedWorkPlan && approvedSeq >= 0
    ? rawMutationReceipts.filter((event) => event.sequence > approvedSeq)
    : rawMutationReceipts;
  const latestMutationSequence = relevantMutations.reduce(
    (max, event) => Math.max(max, event.sequence),
    hasApprovedWorkPlan ? Math.max(0, approvedSeq) : 0,
  );

  const deliveredFiles = uniqueOrderedPaths([
    ...relevantMutations.flatMap((event) =>
      event.evidence
        .filter((ev) => ev.kind === "mutation")
        .map((ev) => workspaceRelativeTarget(ev.target, aggregate.turn.workspaceKey)),
    ),
    ...(continuation?.continuation.carriedTargets.map((item) =>
      workspaceRelativeTarget(item.target, aggregate.turn.workspaceKey),
    ) || []),
  ]);

  const plannedTargets = coverage
    ? coverage.plannedMutationTargets.map((target) =>
        workspaceRelativeTarget(target, aggregate.turn.workspaceKey),
      )
    : [];
  const missingTargets = coverage
    ? coverage.missingMutationTargets.map((target) =>
        workspaceRelativeTarget(target, aggregate.turn.workspaceKey),
      )
    : [];

  const executableSteps = hasApprovedWorkPlan && plan
    ? plan.draft.steps.filter((step) => step.operation !== "preserve")
    : [];
  const totalExecutableStepCount = executableSteps.length;
  const completedStepCount = hasApprovedWorkPlan && coverage
    ? plan!.draft.steps.filter(
        (step, index) => step.operation !== "preserve" && coverage.completedStepIndexes.includes(index),
      ).length
    : 0;

  const allValidationAttempts = aggregate.events.filter(
    (event): event is Extract<RuntimeV2Event, { type: "validation.completed" }> =>
      isRuntimeV2ValidationAttempt(event) && (!hasApprovedWorkPlan || event.sequence > approvedSeq),
  );
  const currentValidations = allValidationAttempts.filter((event) =>
    event.sequence > latestMutationSequence &&
    runtimeV2ValidationBoundaryMatchesCurrent({
      aggregate,
      targetPaths: event.authority?.targetPaths || deliveredFiles,
      mutationBoundarySequence: event.mutationBoundarySequence,
      validatedMutationVersions: event.validatedMutationVersions,
    }),
  );
  const currentPassed = currentValidations.filter((event) => event.passed);
  const currentFailed = allValidationAttempts.filter(
    (event) => !event.passed && event.sequence > latestMutationSequence,
  );
  const passedTargets = [...new Set(
    currentPassed.map((event) => event.presentation?.target?.trim() || "").filter(Boolean),
  )];
  const failedTargets = [...new Set(
    currentFailed.map((event) => event.presentation?.target?.trim() || "").filter(Boolean),
  )];

  const unityChecks: RuntimeV2TerminalUnityCheckFact[] = [];
  for (const check of [deriveUnityCompilation(aggregate), deriveUnityShaderImport(aggregate)]) {
    if (!check) continue;
    unityChecks.push({
      kind: check.kind,
      status: check.receipt ? check.receipt.result.status : "pending",
      errorCount: check.receipt?.result.errorCount ?? 0,
      targets: [...check.targets],
      ...(check.receipt?.result.status === "failed"
        ? { message: unityCompilationMessage(check.receipt.result) }
        : check.receipt?.result.message
          ? { message: check.receipt.result.message }
          : {}),
    });
  }

  const manualChecklist: RuntimeV2TerminalManualCheckFact[] = hasApprovedWorkPlan && plan
    ? plan.draft.validations
        .filter((validation) => !validation.required)
        .map((validation) => ({
          command: validation.command || "manual_verification",
          expectedOutcome: validation.expectedOutcome || validation.command || "manual_verification",
        }))
    : [];

  const requiredCount = coverage ? coverage.requiredValidationIndexes.length : 0;
  const isManualVerification =
    hasApprovedWorkPlan &&
    requiredCount === 0 &&
    manualChecklist.length > 0;

  const reviewLedger = deriveRuntimeV2ReviewDispositionLedger(aggregate);
  const hasPostApprovalGuidance = hasApprovedWorkPlan &&
    (aggregate.events || []).some(
      (event) => event.type === "guidance.admitted" && event.sequence > approvedSeq,
    );

  const hasUnresolvedUnity = Boolean(unresolvedUnityEditorCheck(aggregate));
  const hasActiveSubagent = (aggregate.subagents || []).some(
    (job) => job.status === "queued" || job.status === "running",
  );
  const allDeliveredAndVerified = hasApprovedWorkPlan
    ? Boolean(
        coverage?.allMutationTargetsCovered &&
          coverage.allRequiredValidationsPassed &&
          currentFailed.length === 0 &&
          !hasUnresolvedUnity &&
          !hasActiveSubagent &&
          reviewLedger.pendingBlockingCount === 0 &&
          !reviewLedger.breaksAcceptance,
      )
    : deliveredFiles.length > 0 &&
      currentFailed.length === 0 &&
      !hasUnresolvedUnity &&
      !hasActiveSubagent &&
      reviewLedger.pendingBlockingCount === 0 &&
      !reviewLedger.breaksAcceptance;

  const facts: RuntimeV2TerminalAcceptanceFacts = {
    hasApprovedWorkPlan,
    isManualVerification,
    deliveredFiles,
    plannedTargets,
    missingTargets,
    completedStepCount,
    totalExecutableStepCount,
    automatedValidations: {
      totalCount: allValidationAttempts.length,
      currentPassedCount: currentPassed.length,
      currentFailedCount: currentFailed.length,
      requiredCount,
      passedRequiredCount: coverage ? coverage.passedRequiredValidationIndexes.length : 0,
      missingRequiredCount: coverage ? coverage.missingRequiredValidationIndexes.length : 0,
      allRequiredPassed: coverage ? coverage.allRequiredValidationsPassed : currentFailed.length === 0,
      passedTargets,
      failedTargets,
    },
    unityChecks,
    manualChecklist,
    reviewLedger,
    hasPostApprovalGuidance,
    latestMutationSequence,
    allDeliveredAndVerified,
  };
  terminalFactsCache.set(aggregate, facts);
  return facts;
}

function formatUnityCheckLine(
  check: RuntimeV2TerminalUnityCheckFact,
  language: "zh" | "en",
): string {
  const zh = language === "zh";
  if (check.kind === "csharp") {
    switch (check.status) {
      case "not_unity_project":
        return zh
          ? "- Unity 编译检查：当前目录不适用 Unity 编译检查。"
          : "- Unity compilation check: Unity compilation check not applicable to this directory.";
      case "passed":
        return zh
          ? "- Unity 编译检查：C# 编译通过。"
          : "- Unity compilation check: C# compilation passed.";
      case "failed":
        return zh
          ? `- Unity 编译检查：C# 编译存在错误${check.errorCount > 0 ? `（${check.errorCount} 个）` : ""}${check.message ? `（${check.message}）` : ""}。`
          : `- Unity compilation check: C# compilation failed${check.errorCount > 0 ? ` (${check.errorCount} error(s))` : ""}${check.message ? ` (${check.message})` : ""}.`;
      case "unavailable":
      case "deferred_closed":
      case "pending":
        return zh
          ? "- Unity 编译检查：待 Unity Editor 或编译器验证。"
          : "- Unity compilation check: pending Unity Editor or compiler verification.";
    }
  }
  switch (check.status) {
    case "not_unity_project":
      return zh
        ? "- Unity Shader 导入检查：当前目录不适用 Unity 编译检查。"
        : "- Unity shader import check: Unity compilation check not applicable to this directory.";
    case "passed":
      return zh
        ? "- Unity Shader 导入检查：Shader 导入通过。"
        : "- Unity shader import check: passed.";
    case "failed":
      return zh
        ? `- Unity Shader 导入检查：存在错误${check.message ? `（${check.message}）` : ""}。`
        : `- Unity shader import check: failed${check.message ? ` (${check.message})` : ""}.`;
    case "unavailable":
    case "deferred_closed":
    case "pending":
      return zh
        ? "- Unity Shader 导入检查：待 Unity Editor 验证。"
        : "- Unity shader import check: pending Unity Editor verification.";
  }
}

export function renderRuntimeV2AcceptanceSection(
  facts: RuntimeV2TerminalAcceptanceFacts,
  language: "zh" | "en" = "zh",
  reason?: string,
): string {
  const zh = language === "zh";
  const lines: string[] = [];

  if (facts.deliveredFiles.length > 0) {
    const fileList = facts.deliveredFiles.map(markdownCode).filter(Boolean).join(zh ? "、" : ", ");
    lines.push(
      zh
        ? `- 实际交付文件（${facts.deliveredFiles.length} 个）：${fileList}`
        : `- Delivered files (${facts.deliveredFiles.length}): ${fileList}`,
    );
  } else {
    lines.push(
      zh
        ? "- 实际交付文件：本轮没有已提交的文件修改。"
        : "- Delivered files: no committed file changes in this turn.",
    );
  }

  if (facts.missingTargets.length > 0) {
    const missingList = facts.missingTargets.map(markdownCode).filter(Boolean).join(zh ? "、" : ", ");
    lines.push(
      zh
        ? `- 尚未交付的计划目标（${facts.missingTargets.length} 个）：${missingList}`
        : `- Missing planned targets (${facts.missingTargets.length}): ${missingList}`,
    );
  }

  const auto = facts.automatedValidations;
  if (auto.totalCount > 0) {
    if (auto.requiredCount > 0) {
      lines.push(
        zh
          ? `- 最新修改后的自动验证：必选检查 ${auto.passedRequiredCount}/${auto.requiredCount} 通过（当前边界通过 ${auto.currentPassedCount} 次，未通过 ${auto.currentFailedCount} 次，累计执行 ${auto.totalCount} 次）。`
          : `- Automated checks after latest change: ${auto.passedRequiredCount}/${auto.requiredCount} required passed (${auto.currentPassedCount} passed, ${auto.currentFailedCount} failed at current boundary; ${auto.totalCount} total runs).`,
      );
    } else {
      lines.push(
        zh
          ? `- 最新修改后的自动验证：当前边界通过 ${auto.currentPassedCount} 次，未通过 ${auto.currentFailedCount} 次（累计执行 ${auto.totalCount} 次）。`
          : `- Automated checks after latest change: ${auto.currentPassedCount} passed, ${auto.currentFailedCount} failed at current boundary (${auto.totalCount} total runs).`,
      );
    }
  } else if (facts.isManualVerification) {
    lines.push(
      zh
        ? "- 自动测试：未运行（最新修改后的自动验证 0 次通过；已确认采用人工 / 外部验证，文件交付完成，人工验收待办）。"
        : "- Automated checks after latest change: 0 passed (manual / external verification confirmed; file delivery complete, manual acceptance pending).",
    );
  } else if (facts.hasApprovedWorkPlan && auto.requiredCount > 0) {
    lines.push(
      zh
        ? `- 最新修改后的自动验证：0 次通过（必选检查 0/${auto.requiredCount} 完成）。`
        : `- Automated checks after latest change: 0 passed (0/${auto.requiredCount} required completed).`,
    );
  } else {
    lines.push(
      zh
        ? "- 最新修改后的自动验证：0 次通过。"
        : "- Automated checks after latest change: 0 passed.",
    );
  }

  for (const unity of facts.unityChecks) {
    lines.push(formatUnityCheckLine(unity, language));
  }

  if (facts.manualChecklist.length > 0) {
    lines.push(
      zh
        ? `- 待你人工验收清单：\n${facts.manualChecklist.map((item) => `  - ${item.expectedOutcome}`).join("\n")}`
        : `- Manual verification checklist:\n${facts.manualChecklist.map((item) => `  - ${item.expectedOutcome}`).join("\n")}`,
    );
  }

  const review = facts.reviewLedger;
  if (review.reviewJobCount > 0 || review.findings.length > 0) {
    lines.push(
      zh
        ? `- 审查处置账本：送达 ${review.reviewDeliveredCount} 份，采纳 ${review.reviewAdoptedCount} 份，已修复 ${review.repairedFindings.length} 项，已证伪 ${review.falsifiedFindings.length} 项，待处理/遗留 ${review.unresolvedFindings.length} 项。`
        : `- Review ledger: ${review.reviewDeliveredCount} delivered, ${review.reviewAdoptedCount} adopted, ${review.repairedFindings.length} repaired, ${review.falsifiedFindings.length} falsified, ${review.unresolvedFindings.length} unresolved.`,
    );
    if (review.unresolvedFindings.length > 0) {
      lines.push(
        zh
          ? `- 未解决审查发现：\n${review.unresolvedFindings.map((item) => `  - [${item.findingId}] ${item.statement}${item.dispositionSummary ? `（${item.dispositionSummary}）` : ""}`).join("\n")}`
          : `- Unresolved review findings:\n${review.unresolvedFindings.map((item) => `  - [${item.findingId}] ${item.statement}${item.dispositionSummary ? ` (${item.dispositionSummary})` : ""}`).join("\n")}`,
      );
    }
  }

  if (reason && !/^[a-z][a-z0-9_:-]*$/.test(reason)) {
    lines.push(`- ${reason}`);
  }
  return lines.join("\n");
}

function deterministicHeader(
  facts: RuntimeV2TerminalAcceptanceFacts,
  resultKind: RuntimeV2ResultKind,
  language: "zh" | "en",
): string {
  const zh = language === "zh";
  if (resultKind === "success" && facts.isManualVerification) {
    return zh ? "### 文件交付完成，人工验收待办" : "### File delivery complete, manual acceptance pending";
  }
  if (resultKind === "success") {
    return zh ? "### 已完成" : "### Completed";
  }
  if (resultKind === "partial") {
    return zh ? "### 部分完成" : "### Partially completed";
  }
  if (resultKind === "blocked") {
    return zh ? "### 已阻塞" : "### Blocked";
  }
  if (resultKind === "canceled") {
    return zh ? "### 已取消" : "### Canceled";
  }
  return zh ? "### 执行失败" : "### Failed";
}

export function buildRuntimeV2DeterministicPlanSummary(
  aggregate: TurnAggregateV1,
  facts: RuntimeV2TerminalAcceptanceFacts,
  resultKind: RuntimeV2ResultKind,
  reason: string,
  language: "zh" | "en" = "zh",
): string {
  const zh = language === "zh";
  const planTitle = aggregate.sealedWorkPlan?.draft.objective?.trim();
  const titleLine = deterministicHeader(facts, resultKind, language);
  const introLine = planTitle
    ? zh
      ? `计划「${planTitle}」已完成执行汇总（计划步 ${facts.completedStepCount}/${facts.totalExecutableStepCount || facts.completedStepCount}）。`
      : `Execution summary for plan "${planTitle}" (${facts.completedStepCount}/${facts.totalExecutableStepCount || facts.completedStepCount} steps).`
    : "";
  const sectionTitle = zh ? "#### 验收与交付事实" : "#### Delivery & Acceptance Facts";
  const body = renderRuntimeV2AcceptanceSection(facts, language, reason);
  return [titleLine, introLine, sectionTitle, body].filter(Boolean).join("\n\n");
}

/** Skip the redundant `conclude` LLM request only for standard approved WorkPlan
 * execution when every target, validation, subagent, Unity check, and blocking
 * review finding is settled and no post-approval guidance requires model prose. */
export function canFinalizeApprovedWorkPlanWithoutModel(
  aggregate: TurnAggregateV1 | null | undefined,
): boolean {
  if (!aggregate || aggregate.strategy !== "plan" || !aggregate.sealedWorkPlan) {
    return false;
  }
  if (aggregate.workPlan?.status !== "approved" || !aggregate.planReviewCommit) {
    return false;
  }
  if ((aggregate.subagents || []).some((job) => job.status === "queued" || job.status === "running")) {
    return false;
  }
  const facts = deriveRuntimeV2TerminalAcceptanceFacts(aggregate);
  if (facts.hasPostApprovalGuidance) return false;
  if (facts.reviewLedger.pendingBlockingCount > 0) return false;
  if (aggregate.objective.completionRequirement?.kind === "requested_operation") return false;
  if (facts.reviewLedger.breaksAcceptance) return true;
  return facts.allDeliveredAndVerified;
}
