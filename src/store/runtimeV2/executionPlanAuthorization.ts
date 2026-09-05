import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationRequests,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import {
  deriveRuntimeV2PlanExecutionFrontier,
  deriveRuntimeV2PlanValidationCorrectionScope,
  deriveRuntimeV2PlanSourceFreshness,
  resolveRuntimeV2PlanMutationScope,
  resolveRuntimeV2PlanValidationScope,
  type RuntimeV2Command,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import { approvedPlanForCurrentTurn } from "./executionAggregate";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export interface RuntimeV2PlanToolAuthorizationResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly failureKind:
    | "not_authorized"
    | "protocol_invalid"
    | "source_mismatch"
    | null;
  readonly reasonCode: string | null;
}

/** Approved Plan execution is a separate scope authority from generic tool
 * risk and Direct Execute leases. Keeping it here makes the shared admission
 * entry point compose the authority without owning every Plan frontier rule. */
export function validateToolAgainstApprovedPlan(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly aggregate: TurnAggregateV1;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): RuntimeV2PlanToolAuthorizationResult {
  const approved = approvedPlanForCurrentTurn(input.ports);
  if (!approved) {
    return {
      allowed: false,
      reason: "当前 Plan 的批准权威无效或已过期，运行时拒绝执行外部效果。",
      failureKind: "not_authorized",
      reasonCode: "approved_plan_authority_missing",
    };
  }
  if (isWorkspaceMutationToolName(input.toolName)) {
    const freshness = deriveRuntimeV2PlanSourceFreshness(input.aggregate);
    const mutationAlreadyCommitted = input.aggregate.evidence.some(
      (evidence) => evidence.kind === "mutation",
    );
    if (!mutationAlreadyCommitted && freshness && !freshness.allFresh) {
      const stale = [
        ...freshness.staleTargets,
        ...freshness.unversionedTargets,
      ];
      return stale.length > 0
        ? {
            allowed: false,
            reason:
              `已批准 WorkPlan 的源版本已变化或缺少版本权威：${stale.join(", ")}`,
            failureKind: "not_authorized",
            reasonCode: "approved_plan_source_version_stale",
          }
        : {
            allowed: false,
            reason:
              `执行已批准 WorkPlan 前必须重新读取当前目标：${freshness.missingTargets.join(", ")}`,
            failureKind: "protocol_invalid",
            reasonCode: "approved_plan_source_refresh_required",
          };
    }
    const requestedTargets = resolveWorkspaceMutationTargets(
      input.toolName,
      input.args,
      input.target,
    );
    const correction = deriveRuntimeV2PlanValidationCorrectionScope(
      input.aggregate,
    );
    if (correction.active) {
      const requestedMutations = resolveWorkspaceMutationRequests(
        input.toolName,
        input.args,
        input.target,
      );
      const invalid = requestedMutations.filter((request) =>
        request.operation !== "modify" ||
        !correction.targets.some((target) =>
          workspacePathsReferToSameFile(target, request.target)
        )
      );
      if (requestedMutations.length > 0 && invalid.length === 0) {
        return {
          allowed: true,
          reason: null,
          failureKind: null,
          reasonCode: null,
        };
      }
      return {
        allowed: false,
        reason:
          `失败验证的纠错权威只允许修改这些现有目标：${correction.targets.join(", ")}`,
        failureKind: "not_authorized",
        reasonCode: "approved_plan_validation_correction_scope",
      };
    }
    const scope = resolveRuntimeV2PlanMutationScope({
      plan: approved.plan,
      aggregate: input.aggregate,
      requestedTargets,
      requestedMutations: resolveWorkspaceMutationRequests(
        input.toolName,
        input.args,
        input.target,
      ),
    });
    if (!scope.allowed) {
      if (scope.blockedTargets.length > 0) {
        return {
          allowed: false,
          reason: [
            `该修改目标尚未进入已批准 WorkPlan 的当前执行阶段：${scope.blockedTargets.join(", ")}`,
            `当前可执行步骤：${
              scope.matchingReadyStepIndexes.length > 0
                ? scope.matchingReadyStepIndexes.map((index) =>
                    `S${index + 1}`
                  ).join(", ")
                : "无"
            }。`,
            "先完成其结构化依赖步骤，再请求该修改。",
          ].join(" "),
          failureKind: "not_authorized",
          reasonCode: "approved_plan_dependency_unsatisfied",
        };
      }
      if (scope.operationMismatchTargets.length > 0) {
        return {
          allowed: false,
          reason:
            `修改操作与已批准 WorkPlan 当前步骤不一致：${scope.operationMismatchTargets.join(", ")}`,
          failureKind: "not_authorized",
          reasonCode: "approved_plan_operation_mismatch",
        };
      }
      return {
        allowed: false,
        reason:
          `修改目标不在已批准 WorkPlan 范围内：${
            scope.unexpectedTargets.join(", ") || "未解析目标"
          }`,
        failureKind: "not_authorized",
        reasonCode: "approved_plan_mutation_scope",
      };
    }
  }
  if (input.command.kind === "execute_validation") {
    const scope = resolveRuntimeV2PlanValidationScope({
      plan: approved.plan,
      aggregate: input.aggregate,
      toolName: input.toolName,
      args: input.args,
    });
    if (!scope.allowed) {
      const frontier = deriveRuntimeV2PlanExecutionFrontier(input.aggregate);
      if (frontier && !frontier.validationReady) {
        return {
          allowed: false,
          reason:
            `已批准 WorkPlan 仍有未完成的阶段步骤：${[
              ...frontier.readyStepIndexes,
              ...frontier.blockedStepIndexes,
            ].map((index) => `S${index + 1}`).join(", ")}`,
          failureKind: "not_authorized",
          reasonCode: "approved_plan_validation_before_mutations_complete",
        };
      }
      return {
        allowed: false,
        reason: "该验证调用与已批准 WorkPlan 中的命令或验证类型不一致。",
        failureKind: "not_authorized",
        reasonCode: "approved_plan_validation_scope",
      };
    }
  }
  return { allowed: true, reason: null, failureKind: null, reasonCode: null };
}
