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
  readonly hasProviderConclusion: boolean;
}

export interface RuntimeV2CompletionDecision {
  readonly resultKind: RuntimeV2ResultKind;
  readonly resultReason: string;
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
