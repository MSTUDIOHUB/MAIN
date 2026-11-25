import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2ResultKind } from "./contracts";
import {
  deriveRuntimeV2PlanExecutionCoverage,
  deriveRuntimeV2PlanValidationCorrectionScope,
} from "./planExecution";
import { deriveRuntimeV2ReviewDispositionLedger } from "./reviewFindings";
import type { RuntimeV2PlanPanelProjection } from "./workPlan";
import { deriveUnityCompilation } from "./unityCompilation";

export interface RuntimeV2PlanProgressPresentation {
  readonly status: RuntimeV2ResultKind | "executing" | "validating" | "paused";
  readonly completedCount: number;
  readonly totalCount: number;
  readonly compilation?: "passed" | "failed" | "unavailable" | "not_applicable";
  readonly manualValidationCount?: number;
  readonly unresolvedFindingsCount?: number;
  readonly steps: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: "applied" | "ready" | "dependency_blocked" | "preserve";
    readonly dependsOnIds?: readonly string[];
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
  const rawCompilation = deriveUnityCompilation(aggregate)?.receipt?.result.status;
  const compilation = rawCompilation === "not_unity_project"
    ? "not_applicable"
    : rawCompilation && rawCompilation !== "deferred_closed"
      ? rawCompilation
      : undefined;
  const manualValidationCount = sealedWorkPlan.draft.validations.filter((v) => !v.required).length;
  const reviewLedger = deriveRuntimeV2ReviewDispositionLedger(aggregate);
  const unresolvedFindingsCount = reviewLedger.unresolvedFindings.length;
  return {
    status: aggregate.terminalOutcome?.resultKind ??
      (aggregate.run?.status === "paused" ? "paused"
        : aggregate.phase === "validating" ? "validating" : "executing"),
    completedCount: coverage.completedStepIndexes.length,
    totalCount: review.steps.filter((step) => step.operation !== "preserve").length,
    ...(compilation ? { compilation } : {}),
    ...(manualValidationCount > 0 ? { manualValidationCount } : {}),
    ...(unresolvedFindingsCount > 0 ? { unresolvedFindingsCount } : {}),
    steps: review.steps.map((step, index) => {
      const deps = sealedWorkPlan.draft.steps[index]?.dependsOn || step.dependsOn || [];
      return {
        id: step.id,
        title: step.title,
        status: step.operation === "preserve" ? "preserve"
          : coverage.completedStepIndexes.includes(index) ? "applied"
          : coverage.blockedStepIndexes.includes(index) ? "dependency_blocked" : "ready",
        ...(deps.length > 0 ? { dependsOnIds: deps.map((dep) => `S${dep + 1}`) } : {}),
      };
    }),
    requiredValidations: coverage.requiredValidationIndexes.map((index) => ({
      id: `V${index + 1}`,
      description: sealedWorkPlan.draft.validations[index]!.expectedOutcome,
      status: coverage.passedRequiredValidationIndexes.includes(index) ? "passed"
        : correction?.validationIndex === index ? "failed" : "pending",
    })),
  };
}
