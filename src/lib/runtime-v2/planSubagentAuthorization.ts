import {
  normalizeWorkspacePathIdentity,
  workspacePathsReferToSameFile,
} from "../workspacePaths";
import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2SubagentJob } from "./contracts";
import {
  deriveRuntimeV2PlanExecutionFrontier,
  deriveRuntimeV2PlanSourceFreshness,
  resolveRuntimeV2PlanMutationScope,
} from "./planExecution";
import { isApprovedSameTurnDefectCorrection } from "./reviewFindings";
import type {
  RuntimeV2PlanReviewCommit,
  SealedWorkPlanV1,
  WorkPlanOperation,
} from "./workPlan";

export interface RuntimeV2WriteDelegationStepInfo {
  readonly stepIndex: number;
  readonly stepId: string;
  readonly operation: Exclude<WorkPlanOperation, "preserve">;
  readonly targets: readonly string[];
}

export interface RuntimeV2WriteDelegationDecision {
  readonly allowed: boolean;
  readonly reasonCode:
    | null
    | "invalid_write_contract"
    | "plan_not_approved"
    | "target_locked_by_active_subagent"
    | "prerequisite_dependency_pending"
    | "operation_mismatch"
    | "outside_approved_plan"
    | "execution_contract_required"
    | "outside_execution_contract"
    | "missing_source_authority";
  readonly message: string;
  readonly readySteps: readonly RuntimeV2WriteDelegationStepInfo[];
  readonly readyTargets: readonly string[];
  readonly sameTurnDefectRepair?: boolean;
}

function normalizedRelativePath(value: string): string {
  return normalizeWorkspacePathIdentity(value);
}

function writePathsOverlap(left: string, right: string): boolean {
  if (workspacePathsReferToSameFile(left, right)) return true;
  const a = normalizedRelativePath(left);
  const b = normalizedRelativePath(right);
  if (!a || !b || a === "." || b === ".") return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function uniqueOrdered(paths: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const candidate of paths) {
    const clean = String(candidate || "").trim();
    if (!clean) continue;
    if (!result.some((existing) => workspacePathsReferToSameFile(existing, clean))) {
      result.push(clean);
    }
  }
  return result;
}

export function delegableReadyStepsForAggregate(
  aggregate: TurnAggregateV1 | null | undefined,
  activeChildJobs: readonly RuntimeV2SubagentJob[] = aggregate?.subagents || [],
): readonly RuntimeV2WriteDelegationStepInfo[] {
  if (
    !aggregate ||
    aggregate.strategy !== "plan" ||
    aggregate.workPlan?.status !== "approved" ||
    !aggregate.sealedWorkPlan
  ) {
    return [];
  }
  const frontier = deriveRuntimeV2PlanExecutionFrontier(aggregate);
  if (!frontier) return [];
  const activeWriters = activeChildJobs.filter(
    (job) =>
      (job.status === "queued" || job.status === "running") &&
      (job.accessMode === "write" || job.taskKind === "implement"),
  );
  return frontier.steps.flatMap((step) => {
    if (step.status !== "ready" || step.operation === "preserve") return [];
    const availableTargets = step.targets.filter(
      (target) =>
        !activeWriters.some((writer) =>
          writer.allowedPaths.some((owned) => writePathsOverlap(owned, target)),
        ),
    );
    if (availableTargets.length === 0) return [];
    return [{
      stepIndex: step.stepIndex,
      stepId: `S${step.stepIndex + 1}`,
      operation: step.operation,
      targets: availableTargets,
    }];
  });
}

function formatDelegableScope(
  readySteps: readonly RuntimeV2WriteDelegationStepInfo[],
  readyTargets: readonly string[],
): string {
  if (readySteps.length > 0) {
    return `Currently delegable ready steps: ${readySteps
      .map((step) => `${step.stepId}(${step.operation}: ${step.targets.join(", ")})`)
      .join("; ")}.`;
  }
  if (readyTargets.length > 0) {
    return `Currently delegable targets: ${readyTargets.join(", ")}.`;
  }
  return "No remaining ready write targets are currently delegable.";
}

export function authorizeRuntimeV2WriteDelegation(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly approved?: {
    readonly plan: SealedWorkPlanV1;
    readonly commit: RuntimeV2PlanReviewCommit;
  } | null;
  readonly workspace: string;
  readonly taskKind: string;
  readonly accessMode: string;
  readonly implementationOperation?: "create" | "modify" | "delete";
  readonly allowedPaths: readonly string[];
  readonly activeChildJobs?: readonly RuntimeV2SubagentJob[];
  readonly sourceCoverage?: readonly {
    readonly target: string;
    readonly version: string | null;
    readonly complete?: boolean;
  }[];
  readonly skipSourceCoverageCheck?: boolean;
  readonly excludeJobId?: string;
  readonly directExecuteScope?: {
    readonly hasContract: boolean;
    readonly validationCorrectionActive: boolean;
    readonly targetsAllowed: boolean;
    readonly contractTargets?: readonly string[];
  };
}): RuntimeV2WriteDelegationDecision {
  const aggregate = input.aggregate;
  const activeJobs = input.activeChildJobs ?? aggregate?.subagents ?? [];
  const readySteps = delegableReadyStepsForAggregate(aggregate, activeJobs);
  const readyTargets = aggregate?.strategy === "plan"
    ? uniqueOrdered(readySteps.flatMap((step) => step.targets))
    : uniqueOrdered(input.directExecuteScope?.contractTargets || []);

  if (input.taskKind !== "implement" && input.accessMode !== "write") {
    return {
      allowed: true,
      reasonCode: null,
      message: "",
      readySteps,
      readyTargets,
    };
  }

  if (
    input.taskKind !== "implement" ||
    input.accessMode !== "write" ||
    !input.implementationOperation ||
    input.allowedPaths.length === 0 ||
    input.allowedPaths.includes(".")
  ) {
    return {
      allowed: false,
      reasonCode: "invalid_write_contract",
      message: `implement subagents require task_kind="implement", access_mode="write", explicit implementation_operation, and exact non-root file targets. ${formatDelegableScope(readySteps, readyTargets)}`,
      readySteps,
      readyTargets,
    };
  }

  const activeWriters = activeJobs.filter(
    (job) =>
      job.id !== input.excludeJobId &&
      (job.status === "queued" || job.status === "running") &&
      (job.accessMode === "write" || job.taskKind === "implement"),
  );
  const lockedBy = activeWriters.find((writer) =>
    input.allowedPaths.some((target) =>
      writer.allowedPaths.some((owned) => writePathsOverlap(owned, target)),
    ),
  );
  if (lockedBy) {
    return {
      allowed: false,
      reasonCode: "target_locked_by_active_subagent",
      message: `Write paths overlap active implementation child ${lockedBy.id} (${lockedBy.allowedPaths.join(", ")}). ${formatDelegableScope(readySteps, readyTargets)}`,
      readySteps,
      readyTargets,
    };
  }

  if (aggregate?.strategy === "plan") {
    const approvedPlan = input.approved?.plan ?? aggregate.sealedWorkPlan;
    const approvedCommit = input.approved?.commit ?? aggregate.planReviewCommit;
    if (
      !aggregate.run ||
      aggregate.workPlan?.status !== "approved" ||
      !approvedPlan ||
      !approvedCommit ||
      approvedPlan.id !== aggregate.workPlan.id ||
      approvedPlan.revision !== aggregate.workPlan.revision ||
      approvedPlan.digest !== aggregate.workPlan.digest
    ) {
      return {
        allowed: false,
        reasonCode: "plan_not_approved",
        message: "An approved WorkPlan is required before delegating implement/write work; planning children must remain read-only.",
        readySteps,
        readyTargets,
      };
    }

    const op = input.implementationOperation;
    const scope = resolveRuntimeV2PlanMutationScope({
      plan: approvedPlan,
      aggregate,
      requestedTargets: input.allowedPaths,
      requestedMutations: input.allowedPaths.map((target) => ({ target, operation: op })),
    });
    const sameTurnRepairAllowed =
      !scope.allowed &&
      op !== "delete" &&
      input.allowedPaths.every((targetPath) =>
        isApprovedSameTurnDefectCorrection({ aggregate, targetPath, operation: op }),
      );

    if (!scope.allowed && !sameTurnRepairAllowed) {
      if (scope.blockedTargets.length > 0) {
        return {
          allowed: false,
          reasonCode: "prerequisite_dependency_pending",
          message: `Cannot delegate ${scope.blockedTargets.join(", ")}: prerequisite dependency steps (dependsOn) have not completed yet. ${formatDelegableScope(readySteps, readyTargets)}`,
          readySteps,
          readyTargets,
        };
      }
      if (scope.operationMismatchTargets.length > 0) {
        return {
          allowed: false,
          reasonCode: "operation_mismatch",
          message: `Requested operation "${op}" does not match the approved WorkPlan operation for ${scope.operationMismatchTargets.join(", ")}. ${formatDelegableScope(readySteps, readyTargets)}`,
          readySteps,
          readyTargets,
        };
      }
      return {
        allowed: false,
        reasonCode: "outside_approved_plan",
        message: `Requested targets are outside the approved WorkPlan: ${scope.unexpectedTargets.join(", ") || input.allowedPaths.join(", ")}. ${formatDelegableScope(readySteps, readyTargets)}`,
        readySteps,
        readyTargets,
      };
    }

    if (!input.skipSourceCoverageCheck && (op === "modify" || op === "delete") && !sameTurnRepairAllowed) {
      const freshness = op === "modify" ? deriveRuntimeV2PlanSourceFreshness(aggregate) : null;
      const missingAuthority = input.allowedPaths.some((path) => {
        const covered = (input.sourceCoverage || []).some(
          (cov) =>
            !!cov.version &&
            workspacePathsReferToSameFile(cov.target, path) &&
            (op !== "delete" || cov.complete === true),
        );
        if (covered) return false;
        const freshEntry = freshness?.entries.find((entry) =>
          workspacePathsReferToSameFile(entry.target, path),
        );
        return !(freshEntry && (freshEntry.status === "fresh" || freshEntry.status === "unversioned") && freshEntry.currentVersion);
      });
      if (missingAuthority) {
        return {
          allowed: false,
          reasonCode: "missing_source_authority",
          message: `implement subagents may ${op} existing files only after the parent has current versioned source evidence for every exact assigned file path. ${formatDelegableScope(readySteps, readyTargets)}`,
          readySteps,
          readyTargets,
        };
      }
    }

    return {
      allowed: true,
      reasonCode: null,
      message: "",
      readySteps,
      readyTargets,
      ...(sameTurnRepairAllowed ? { sameTurnDefectRepair: true } : {}),
    };
  }

  if (aggregate?.strategy === "execute") {
    const scope = input.directExecuteScope;
    if (!scope || (!scope.hasContract && !scope.validationCorrectionActive)) {
      return {
        allowed: false,
        reasonCode: "execution_contract_required",
        message: "implement subagents require a recorded parent execution contract; use a read-only child until the parent has an evidence-backed solution.",
        readySteps,
        readyTargets,
      };
    }
    if (scope.hasContract && !scope.validationCorrectionActive && !scope.targetsAllowed) {
      return {
        allowed: false,
        reasonCode: "outside_execution_contract",
        message: `implement subagent write paths must be exact mutation targets in the current parent execution contract. ${formatDelegableScope(readySteps, readyTargets)}`,
        readySteps,
        readyTargets,
      };
    }
    if (!input.skipSourceCoverageCheck && (input.implementationOperation === "modify" || input.implementationOperation === "delete")) {
      const missingAuthority = input.allowedPaths.some(
        (path) =>
          !(input.sourceCoverage || []).some(
            (cov) =>
              !!cov.version &&
              workspacePathsReferToSameFile(cov.target, path) &&
              (input.implementationOperation !== "delete" || cov.complete === true),
          ),
      );
      if (missingAuthority) {
        return {
          allowed: false,
          reasonCode: "missing_source_authority",
          message: "implement subagents may modify or delete only after the parent has versioned source evidence for every exact assigned file path.",
          readySteps,
          readyTargets,
        };
      }
    }
    return {
      allowed: true,
      reasonCode: null,
      message: "",
      readySteps,
      readyTargets,
    };
  }

  return {
    allowed: false,
    reasonCode: "plan_not_approved",
    message: "Only an Execute Run or an approved WorkPlan Run may delegate an implement/write child; planning and analysis children are read-only.",
    readySteps,
    readyTargets,
  };
}
