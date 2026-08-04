import {
  RuntimeV2Controller,
  countDistinctRuntimeV2EvidenceFacts,
  decideRuntimeV2TerminalOutcome,
  deriveRuntimeV2PlanExecutionCoverage,
  latestRuntimeV2ProviderConclusionText,
  runtimeV2DirectExecuteReadyForConclusion,
  summarizeRuntimeV2ExecuteEvidence,
  type RuntimeV2ExecutePhaseTransition,
  type RuntimeV2ResultKind,
} from "../../lib/runtime-v2";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";

export function runtimeV2ExecuteTerminalDecision(input: {
  aggregate: ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"];
  signal: AbortSignal;
}): {
  resultKind: RuntimeV2ResultKind;
  resultReason: string;
  finalMarkdown?: string;
} | null {
  const { aggregate, signal } = input;
  if (!aggregate) return null;
  const evidence = summarizeRuntimeV2ExecuteEvidence(aggregate, {
    isMutationToolName: isWorkspaceMutationToolName,
  });
  const finalMarkdown = sanitizeAssistantDisplayContent(
    latestRuntimeV2ProviderConclusionText(aggregate),
  ).trim().slice(0, 24_000);
  const decision = decideRuntimeV2TerminalOutcome(aggregate, {
    canceled: signal.aborted,
    mutationCount: evidence.mutationCount,
    passedValidationCount: evidence.passedValidationCount,
    hasAcceptanceValidation:
      runtimeV2DirectExecuteReadyForConclusion(aggregate),
    failedValidationCount: evidence.failedValidationCount,
    stalledValidationCount: evidence.stalledValidationCount,
    hasProviderConclusion: !!finalMarkdown,
  });
  if (!decision) return null;
  return {
    ...decision,
    ...(finalMarkdown ? { finalMarkdown } : {}),
  };
}

export function truthfulRuntimeV2RecoveryStallDecision(input: {
  aggregate: NonNullable<
    ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"]
  >;
  recoveryOccurrence: number;
}): {
  resultKind: "partial" | "error";
  resultReason: string;
  finalMarkdown?: string;
} {
  const hasMutation = input.aggregate.evidence.some(
    (evidence) => evidence.kind === "mutation",
  );
  const evidence = summarizeRuntimeV2ExecuteEvidence(input.aggregate, {
    isMutationToolName: isWorkspaceMutationToolName,
  });
  const planCoverage =
    deriveRuntimeV2PlanExecutionCoverage(input.aggregate);
  const missingTargets = planCoverage?.missingMutationTargets || [];
  const missingValidations =
    planCoverage?.missingRequiredValidationIndexes.map(
      (index) => `work-plan-validation-${index + 1}`,
    ) || [];
  const readOnlyEvidenceCount = input.aggregate.evidence.filter(
    (item) =>
      item.kind === "source" ||
      item.kind === "tool" ||
      item.kind === "subagent",
  );
  const distinctReadOnlyEvidenceCount =
    countDistinctRuntimeV2EvidenceFacts(readOnlyEvidenceCount);
  const details = [
    missingTargets.length > 0
      ? `未修改目标：${missingTargets.join("、")}`
      : "",
    missingValidations.length > 0
      ? `缺少验证：${missingValidations.join("、")}`
      : "",
    hasMutation && evidence.passedValidationCount === 0
      ? "最新修改之后没有通过有限验证"
      : "",
    evidence.failedValidationCount > 0
      ? "最近一次验证仍未通过"
      : "",
    !hasMutation && distinctReadOnlyEvidenceCount > 0
      ? `已完成 ${distinctReadOnlyEvidenceCount} 条只读证据收集`
      : "",
    evidence.failedProviderRequestCount > 0
      ? `模型有 ${evidence.failedProviderRequestCount} 次决策请求未形成可执行结果`
      : "",
    evidence.failedOperationCount > 0
      ? `${evidence.failedOperationCount} 个动作被拒绝或执行失败`
      : "",
  ].filter(Boolean);
  const resultKind = hasMutation ? "partial" as const : "error" as const;
  const resultReason = [
      `模型恢复已连续停滞，最近 ${input.recoveryOccurrence} 次决策没有形成新的可执行进展。`,
      hasMutation
        ? "已保留实际修改，但没有把未覆盖目标或条件表述为成功。"
        : "本轮没有形成可验收的实际修改。",
      hasMutation
        ? "自动验收尚未完成；请按原始用户场景手动验证，并可将结果在同一任务中继续反馈。"
        : "",
      ...details,
    ].filter(Boolean).join(" ");
  const providerHandoff = hasMutation
    ? sanitizeAssistantDisplayContent(
        latestRuntimeV2ProviderConclusionText(input.aggregate),
      ).trim().slice(0, 12_000)
    : "";
  const finalMarkdown = hasMutation
    ? [
        "### 部分完成：等待用户验证",
        resultReason,
        providerHandoff
          ? `#### 模型交接（未经自动验收）\n\n${providerHandoff}`
          : "",
      ].filter(Boolean).join("\n\n")
    : "";
  return {
    resultKind,
    resultReason,
    ...(finalMarkdown ? { finalMarkdown } : {}),
  };
}

export function runtimeV2PhaseTransitionMessage(
  reason: RuntimeV2ExecutePhaseTransition["reason"],
): string {
  const messages = {
    pending_mutation_call: "模型已经提交结构化修改动作，开始实施最小修复。",
    pending_validation_call: "模型已经提交验证动作，开始检查当前工作区结果。",
    mutation_committed: "工作区修改已经真实落账；下一步执行有限验证。",
    unvalidated_mutation_pending:
      "本次修改没有落账；较早的工作区修改仍需有限验证。",
    validation_failed: "有限验证未通过；返回修改阶段，根据失败证据进行一次针对性修复。",
  } as const;
  return messages[reason];
}
