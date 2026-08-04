import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2ResultKind } from "./contracts";
import { deriveRuntimeV2PlanExecutionCoverage } from "./planExecution";

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

/**
 * A tool-free response is the provider's voluntary loop-completion signal in
 * every Execute decision mode. Protocol diagnostics are deliberately excluded:
 * the adapter may rewrite a rejected duplicate into an empty response, but
 * that feedback receipt is not a provider-authored conclusion.
 */
export function latestRuntimeV2ProviderConclusionText(
  aggregate: TurnAggregateV1,
): string {
  const scheduledModes = new Map<string, string>();
  for (const event of aggregate.events) {
    if (
      event.type === "command.scheduled" &&
      event.command.kind === "request_model"
    ) {
      scheduledModes.set(
        event.command.idempotencyKey,
        String(event.command.payload.mode || "").trim(),
      );
    }
  }
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (event.type !== "provider.responded") continue;
    const mode = scheduledModes.get(event.idempotencyKey) || "";
    if (
      !["execute", "validate", "conclude"].includes(mode) ||
      event.result.toolCalls.length > 0 ||
      event.result.diagnostics.length > 0
    ) {
      continue;
    }
    const text = String(event.result.visibleText || "").trim();
    if (text) return text.slice(0, 24_000);
  }
  return "";
}

export function exhaustedRuntimeV2ResultKind(
  aggregate: TurnAggregateV1,
): Extract<RuntimeV2ResultKind, "partial" | "error"> {
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
 * A provider response without a tool call is the ordinary agent-loop finish
 * signal. The Runtime never upgrades its prose into success: structured
 * mutation and validation facts still decide whether that finish is success,
 * partial, or error.
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
