import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2ResultKind } from "./contracts";
import {
  deriveRuntimeV2PlanExecutionCoverage,
  deriveRuntimeV2PlanValidationCorrectionScope,
} from "./planExecution";
import type { RuntimeV2PlanPanelProjection } from "./workPlan";
import { deriveUnityCompilation } from "./unityCompilation";

export interface RuntimeV2PlanProgressPresentation {
  readonly status: RuntimeV2ResultKind | "executing" | "validating" | "paused";
  readonly completedCount: number;
  readonly totalCount: number;
  readonly compilation?: "passed" | "failed" | "unavailable";
  readonly steps: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: "applied" | "ready" | "dependency_blocked" | "preserve";
  }[];
  readonly requiredValidations: readonly {
    readonly id: string;
    readonly description: string;
    readonly status: "passed" | "pending" | "failed";
  }[];
}

/** Project execution separately from the immutable, validated review commit. */
export function projectRuntimeV2PlanProgress(
  aggregate: TurnAggregateV1,
  review: RuntimeV2PlanPanelProjection,
): RuntimeV2PlanProgressPresentation | null {
  const { workPlan, sealedWorkPlan } = aggregate;
  const { authority } = review;
  if (
    workPlan?.status !== "approved" || !sealedWorkPlan ||
    workPlan.id !== authority.id || workPlan.revision !== authority.revision ||
    workPlan.digest !== authority.digest || workPlan.projectionHash !== authority.projectionHash
  ) {
    return null;
  }
  const coverage = deriveRuntimeV2PlanExecutionCoverage(aggregate);
  if (!coverage) return null;

  const correction = coverage.missingRequiredValidationIndexes.length
    ? deriveRuntimeV2PlanValidationCorrectionScope(aggregate)
    : null;
  const compilation = deriveUnityCompilation(aggregate)?.receipt?.result.status;
  return {
    status: aggregate.terminalOutcome?.resultKind ??
      (aggregate.run?.status === "paused" ? "paused"
        : aggregate.phase === "validating" ? "validating" : "executing"),
    completedCount: coverage.completedStepIndexes.length,
    totalCount: review.steps.filter((step) => step.operation !== "preserve").length,
    ...(compilation && compilation !== "not_unity_project" && compilation !== "deferred_closed" ? { compilation } : {}),
    steps: review.steps.map((step, index) => ({
      id: step.id,
      title: step.title,
      status: step.operation === "preserve" ? "preserve"
        : coverage.completedStepIndexes.includes(index) ? "applied"
        : coverage.blockedStepIndexes.includes(index) ? "dependency_blocked" : "ready",
    })),
    requiredValidations: coverage.requiredValidationIndexes.map((index) => ({
      id: `V${index + 1}`,
      description: sealedWorkPlan.draft.validations[index]!.expectedOutcome,
      status: coverage.passedRequiredValidationIndexes.includes(index) ? "passed"
        : correction?.validationIndex === index ? "failed" : "pending",
    })),
  };
}
