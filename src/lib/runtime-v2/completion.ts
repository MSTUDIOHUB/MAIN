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
  readonly failedValidationCount: number;
  readonly stalledValidationCount: number;
  readonly hasProviderConclusion: boolean;
}

export interface RuntimeV2CompletionDecision {
  readonly resultKind: RuntimeV2ResultKind;
  readonly resultReason: string;
}

/** Three identical normalized validator receipts mean corrective work has
 * stopped changing the observable failure. A separate epoch-wide ceiling
 * keeps genuinely changing diagnostics bounded without treating progress as
 * stagnation. The Run lifecycle deadline remains the outer wall-clock bound. */
export const RUNTIME_V2_MAX_STALLED_VALIDATION_CYCLES = 3;
export const RUNTIME_V2_MAX_TOTAL_FAILED_VALIDATION_CYCLES = 8;

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
 * In particular, an investigation summary without a tool call is not a
 * partial conclusion: local models often emit it immediately before their
 * first useful action, and the bounded command policy should get its chance
 * to recover the protocol first.
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
  if (
    facts.mutationCount > 0 &&
    facts.passedValidationCount === 0 &&
    (
      facts.stalledValidationCount >=
        RUNTIME_V2_MAX_STALLED_VALIDATION_CYCLES ||
      facts.failedValidationCount >=
        RUNTIME_V2_MAX_TOTAL_FAILED_VALIDATION_CYCLES
    )
  ) {
    return {
      resultKind: "partial",
      resultReason:
        facts.stalledValidationCount >=
            RUNTIME_V2_MAX_STALLED_VALIDATION_CYCLES
          ? "已完成有限修改，但连续三次验收仍返回同一项标准化失败；运行时已保留修改、失败证据和具体文件，并结束本轮以避免无进展循环。"
          : "已完成有限修改，但本轮已达到变化中失败证据的全局安全上限；运行时已保留修改、验证轨迹和具体文件，并结束本轮以避免无限循环。",
    };
  }
  const approvedPlanCoverage = deriveRuntimeV2PlanExecutionCoverage(aggregate);
  if (
    approvedPlanCoverage &&
    (
      !approvedPlanCoverage.allMutationTargetsCovered ||
      !approvedPlanCoverage.allRequiredValidationsPassed
    )
  ) {
    return null;
  }
  if (
    facts.mutationCount > 0 &&
    facts.passedValidationCount > 0 &&
    facts.hasProviderConclusion
  ) {
    return {
      resultKind: "success",
      resultReason: "已完成修改，并通过结构化验证结果确认。",
    };
  }
  return null;
}
