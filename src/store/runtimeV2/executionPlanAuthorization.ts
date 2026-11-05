import { resolveRuntimeV2PlanMutationScope } from "../../lib/runtime-v2";
import type { WorkspaceWriteFileTargetFact } from "../../lib/workspaceMutationPreflight";
import type {
  RuntimeV2Command,
  TurnAggregateV1,
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

/**
 * Approved Plan execution requires an active approved plan authority, while
 * avoiding brittle step-order (`dependsOn`) or `write_file` vs `replace_in_file`
 * operation-mismatch lockouts that stall local models during implementation.
 */
export function validateToolAgainstApprovedPlan(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly aggregate: TurnAggregateV1;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly writeFileTarget?: WorkspaceWriteFileTargetFact;
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
  if (input.toolName === "write_file" && input.writeFileTarget) {
    const scope = resolveRuntimeV2PlanMutationScope({
      plan: approved.plan,
      requestedTargets: [input.writeFileTarget.path],
      requestedMutations: [{ target: input.writeFileTarget.path, operation: input.writeFileTarget.exists ? "modify" : "create" }],
    });
    if (!scope.allowed) return {
      allowed: false, reason: "The actual write_file operation does not match the approved Plan's exact target and create/modify scope.",
      failureKind: "not_authorized", reasonCode: "approved_plan_write_file_operation_scope",
    };
  }
  return { allowed: true, reason: null, failureKind: null, reasonCode: null };
}
