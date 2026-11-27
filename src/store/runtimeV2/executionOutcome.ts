import {
  RuntimeV2Controller,
  canFinalizeApprovedWorkPlanWithoutModel,
  countDistinctRuntimeV2EvidenceFacts,
  decideRuntimeV2TerminalOutcome,
  deriveRuntimeV2PlanExecutionCoverage,
  deriveRuntimeV2ProviderRecoveryPressure,
  latestRuntimeV2ProviderConclusionText,
  runtimeV2DirectExecuteReadyForConclusion,
  summarizeRuntimeV2ExecuteEvidence,
  type RuntimeV2ExecutePhaseTransition,
  type RuntimeV2ResultKind,
} from "../../lib/runtime-v2";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import { deriveUnityCompilation, unresolvedUnityEditorCheck, unityCompilationMessage } from "../../lib/runtime-v2/unityCompilation";
import { deriveRuntimeV2ExecutionContract } from "../../lib/runtime-v2/executionContract";
import { runtimeV2PendingGuidance } from "../../lib/runtime-v2/guidance";
import { runtimeV2DeliveredWorkspacePaths } from "../../lib/runtime-v2/validationReceipt";

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
    mutationCount: runtimeV2DeliveredWorkspacePaths(aggregate).length,
    passedValidationCount: evidence.passedValidationCount,
    hasAcceptanceValidation:
      runtimeV2DirectExecuteReadyForConclusion(aggregate),
    failedValidationCount: evidence.failedValidationCount,
    stalledValidationCount: evidence.stalledValidationCount,
    hasProviderConclusion: !!finalMarkdown || canFinalizeApprovedWorkPlanWithoutModel(aggregate),
  });
  if (!decision) return null;
  const compilation = unresolvedUnityEditorCheck(aggregate);
  if (compilation && decision.resultKind === "success") {
    const checkLabel = compilation.result.kind === "shader_import" ? "Shader 导入" : "引擎编译";
    const reason = compilation.result.status === "failed" ? `${checkLabel}仍有错误，修改已保留。`
      : `未取得${checkLabel}结果，修改已保留。`;
    return { resultKind: "partial", resultReason: reason, finalMarkdown: [reason, unityCompilationMessage(compilation.result)].filter(Boolean).join("\n\n") };
  }
  return {
    ...decision,
    ...(finalMarkdown ? { finalMarkdown } : {}),
  };
}

export function runtimeV2ValidationRecoveryDecision(input: {
  aggregate: NonNullable<ReturnType<RuntimeV2Controller["snapshot"]>["aggregate"]>;
  language?: "en" | "zh";
  hasProjectValidation: boolean;
}): { resultKind: "partial" | "blocked"; resultReason: string }
  | { pauseMessage: string; evidenceSequence: number }
  | null {
  const { aggregate } = input;
  if (aggregate.phase !== "validating" || aggregate.run?.status !== "running" ||
      aggregate.scheduledCommands.length > 0 || aggregate.pendingToolCalls.length > 0 ||
      runtimeV2PendingGuidance(aggregate) ||
      aggregate.subagents.some(job => job.status === "queued" || job.status === "running")) return null;
  const pressure = deriveRuntimeV2ProviderRecoveryPressure(aggregate);
  if (pressure?.reason !== "non_actionable_response") return null;
  const runId = aggregate.run.identity.runId;
  const response = [...aggregate.events].reverse().find(event => event.type === "provider.responded" && event.run.runId === runId);
  if (response?.type !== "provider.responded" || response.result.toolCalls.length || response.result.diagnostics.length) return null;
  const request = [...aggregate.events].reverse().find(event => event.type === "command.scheduled" &&
    event.command.kind === "request_model" && event.command.idempotencyKey === response.idempotencyKey);
  if (request?.type !== "command.scheduled" || request.command.payload.mode !== "validate") return null;
  const compilation = deriveUnityCompilation(aggregate)?.receipt;
  const english = input.language === "en";
  // A verified source-only workspace is a real prerequisite gap. A summary
  // is only the signal to assess it; it cannot discharge validation.
  if (compilation?.result.status === "project_fragment" && !input.hasProjectValidation &&
      aggregate.strategy === "execute" && !aggregate.workPlan && !deriveRuntimeV2ExecutionContract(aggregate)) {
    const reason = english
      ? "Unity compilation and tests require a complete project. This workspace contains Unity source without a bound project."
      : "当前工作区只有 Unity 源码，缺少已绑定的完整工程，无法运行 Unity 编译和测试。";
    return { resultKind: runtimeV2DeliveredWorkspacePaths(aggregate).length > 0 ? "partial" : "blocked", resultReason: reason };
  }
  const previousPressure = request.command.payload.recoveryPressure as typeof pressure | undefined;
  if (previousPressure?.reason !== "non_actionable_response" || previousPressure.stage !== "alternative" ||
      pressure.occurrence <= previousPressure.occurrence) return null;
  // The alternative recovery was actually offered and produced no validation
  // action at this frontier. Pause rather than resending that same work.
  return {
    evidenceSequence: response.sequence,
    pauseMessage: english
      ? "The current changes still lack an applicable validation result. Provide a runnable project check or recheck the prerequisites."
      : "最新改动仍缺可核验的验证结果。请提供可运行的工程验证命令，或在前置条件就绪后重新检查。",
  };
}

export async function recoverRuntimeV2Validation(
  controller: RuntimeV2Controller,
  input: Parameters<typeof runtimeV2ValidationRecoveryDecision>[0],
  nextId: (scope: string) => string,
): Promise<boolean> {
  const recovery = runtimeV2ValidationRecoveryDecision(input);
  if (!recovery) return false;
  if ("resultKind" in recovery) {
    return controller.driveOnce(recovery);
  }
  await controller.pauseRun({
    requestId: nextId("execution-choice"),
    reasonCode: "recovery_stalled",
    evidenceSequence: recovery.evidenceSequence,
    message: recovery.pauseMessage,
    options: ["recheck", "stop"],
  });
  return true;
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
  const evidence = summarizeRuntimeV2ExecuteEvidence(input.aggregate, {
    isMutationToolName: isWorkspaceMutationToolName,
  });
  const hasMutation = runtimeV2DeliveredWorkspacePaths(input.aggregate).length > 0;
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
    delegated_mutation_active: "已向实现子任务委派写操作，进入实施阶段。",
    delegated_mutation_committed: "实现子任务修改已提交；继续完成其余计划目标。",
  } as const;
  return messages[reason];
}
