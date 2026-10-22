import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2ResultKind } from "./contracts";
import { deriveRuntimeV2PlanExecutionCoverage } from "./planExecution";
import { latestRuntimeV2Answer } from "./providerAnswer";
import {
  deriveRuntimeV2ExecutionContract,
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
} from "./executionContract";
import { summarizeRuntimeV2ExecuteEvidence } from "./phaseTransition";
import { isWorkspaceMutationToolName } from "../workspaceMutationTools";
import { isRuntimeV2ReadOnlyToolName } from "./workspaceReadPolicy";
import { isRuntimeV2ValidationAttempt } from "./validationAttempt";

/** Facts supplied by a store adapter after it has inspected actual tool and
 * validation receipts. Provider wording is intentionally reduced to a
 * boolean: prose cannot independently conclude a Turn. */
export interface RuntimeV2CompletionFacts {
  readonly canceled: boolean;
  readonly mutationCount: number;
  readonly passedValidationCount: number;
  readonly hasAcceptanceValidation: boolean;
  readonly failedValidationCount: number;
  readonly stalledValidationCount: number;
  readonly hasProviderConclusion: boolean;
}

export interface RuntimeV2CompletionDecision {
  readonly resultKind: RuntimeV2ResultKind;
  readonly resultReason: string;
}

/** Ordinary command tasks have no file artifact to mutate or validate. Their
 * real effect receipts may support a later natural final, without switching
 * the next request to `conclude` or withdrawing Execute tools. */
export function runtimeV2CommandTaskReadyForConclusion(
  aggregate: TurnAggregateV1,
): boolean {
  if (
    aggregate.strategy !== "execute" || !aggregate.run ||
    aggregate.workPlan || aggregate.sealedWorkPlan ||
    aggregate.objective.acceptanceEvidenceRequirements?.some((requirement) => requirement !== null) ||
    deriveRuntimeV2ExecutionContract(aggregate) ||
    summarizeRuntimeV2ExecuteEvidence(aggregate, {
      isMutationToolName: isWorkspaceMutationToolName,
    }).mutationCount > 0
  ) return false;

  // Unlike recovery fingerprints, this key preserves every normalized tool
  // argument. Only the same action can resolve its earlier failed receipt.
  const actionKey = (toolName: string, args: unknown): string => JSON.stringify(
    [toolName, args],
    (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value,
  );
  const commands = new Map<string, { key: string; operation: boolean; readOnly: boolean }>();
  const results = new Map<string, { settled: boolean; operation: boolean }>();
  for (const event of aggregate.events) {
    if (!("run" in event) || event.run.runId !== aggregate.run.identity.runId) continue;
    if (event.type === "command.scheduled") {
      const command = event.command;
      if (command.kind !== "execute_tool" && command.kind !== "execute_validation") continue;
      const name = String(command.payload.toolName || "");
      const key = actionKey(name, command.payload.arguments || {});
      const readOnly = isRuntimeV2ReadOnlyToolName(name);
      const operation = !!name && !readOnly &&
        name !== RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME &&
        !isWorkspaceMutationToolName(name);
      commands.set(command.idempotencyKey, { key, operation, readOnly });
      results.set(key, { settled: false, operation: false });
      continue;
    }
    if (event.type !== "tool.completed" && event.type !== "validation.completed") continue;
    const command = commands.get(event.idempotencyKey);
    if (!command) continue;
    const attempted = event.type !== "validation.completed" || isRuntimeV2ValidationAttempt(event);
    const succeeded = attempted && (event.type === "validation.completed" ? event.passed : event.status === "succeeded");
    const executed = event.type === "validation.completed" || event.receiptOrigin !== "replayed";
    const hasEffect = executed && event.evidence.some((evidence) =>
      evidence.kind === "tool" || evidence.kind === "mutation" || evidence.kind === "validation",
    );
    results.set(command.key, {
      settled: succeeded && (command.readOnly || hasEffect),
      operation: succeeded && command.operation && hasEffect,
    });
  }
  return [...results.values()].some((result) => result.operation) &&
    [...results.values()].every((result) => result.settled);
}

/** Mutation tasks retain the evidence-ready `conclude` gate. A command task
 * may instead finish through a clean, tool-free natural response after its
 * real receipts; source reads and provider prose alone never grant success. */
export function latestRuntimeV2ProviderConclusionText(
  aggregate: TurnAggregateV1,
): string {
  return (
    latestRuntimeV2Answer(aggregate, true) ||
    (runtimeV2CommandTaskReadyForConclusion(aggregate)
      ? latestRuntimeV2Answer(aggregate)
      : "")
  ).slice(0, 24_000);
}

export function exhaustedRuntimeV2ResultKind(
  aggregate: TurnAggregateV1,
): Extract<RuntimeV2ResultKind, "partial" | "error"> {
  if (aggregate.strategy === "chat" || aggregate.strategy === "analyze") return "error";
  const mutationRequired = aggregate.strategy === "execute" ||
    (
      aggregate.strategy === "plan" &&
      aggregate.workPlan?.status === "approved"
    );
  if (mutationRequired) {
    return aggregate.evidence.some((evidence) => evidence.kind === "mutation")
      ? "partial"
      : "error";
  }
  return aggregate.evidence.length > 0 ? "partial" : "error";
}

/**
 * Determine only outcomes that the runtime can prove from structured facts.
 * A provider response without a tool call is a finish signal after verified
 * mutations or actual command results. Prose alone never creates evidence.
 */
export function decideRuntimeV2TerminalOutcome(
  aggregate: TurnAggregateV1,
  facts: RuntimeV2CompletionFacts,
): RuntimeV2CompletionDecision | null {
  if (facts.canceled) {
    return {
      resultKind: "canceled",
      resultReason: "用户已停止本轮执行；已保留此前已提交的证据和修改。",
    };
  }
  if (aggregate.recovery.exhausted) {
    return {
      resultKind: exhaustedRuntimeV2ResultKind(aggregate),
      resultReason: aggregate.recovery.exhausted.reason,
    };
  }
  if (aggregate.strategy === "execute") {
    const hasVerifiedEffect =
      facts.mutationCount > 0 &&
      facts.hasAcceptanceValidation &&
      facts.failedValidationCount === 0;
    if (!facts.hasProviderConclusion) return null;
    if (hasVerifiedEffect) {
      return {
        resultKind: "success",
        resultReason:
          "最新工作区效果已由后续有限验证确认，并已生成基于实际证据的完成报告。",
      };
    }
    if (facts.mutationCount === 0 && runtimeV2CommandTaskReadyForConclusion(aggregate)) {
      return {
        resultKind: "success",
        resultReason: "请求的命令或外部操作已取得实际成功回执，并已生成基于实际证据的完成报告。",
      };
    }
    return facts.mutationCount > 0
      ? {
          resultKind: "partial",
          resultReason:
            "模型已结束本轮，但最新修改尚未获得与用户目标匹配的完整验收证据。",
        }
      : {
          resultKind: "error",
          resultReason:
            "模型已结束本轮，但没有形成可验收的实际修改。",
        };
  }
  const approvedPlanCoverage = deriveRuntimeV2PlanExecutionCoverage(aggregate);
  if (approvedPlanCoverage) {
    if (
      !approvedPlanCoverage.allMutationTargetsCovered ||
      !approvedPlanCoverage.allRequiredValidationsPassed
    ) {
      if (!facts.hasProviderConclusion) return null;
      const missingTargets =
        approvedPlanCoverage.missingMutationTargets;
      const missingValidationIds =
        approvedPlanCoverage.missingRequiredValidationIndexes.map(
          (index) => `work-plan-validation-${index + 1}`,
        );
      const detail = [
        missingTargets.length > 0
          ? `未覆盖修改目标：${missingTargets.join("、")}。`
          : "",
        missingValidationIds.length > 0
          ? `未通过必需验证：${missingValidationIds.join("、")}。`
          : "",
      ].filter(Boolean).join(" ");
      return facts.mutationCount > 0
        ? {
            resultKind: "partial",
            resultReason:
              `模型已结束本轮；已保留实际修改，但已批准 WorkPlan 尚未完整闭环。${detail}`,
          }
        : {
            resultKind: "error",
            resultReason:
              `模型已结束本轮，但已批准 WorkPlan 没有形成可验收的实际修改。${detail}`,
          };
    }
    return facts.hasProviderConclusion
      ? {
          resultKind: "success",
          resultReason:
            "已批准 WorkPlan 的全部修改目标和必需验证均由最终修改后的匹配回执覆盖。",
        }
      : null;
  }
  return null;
}
