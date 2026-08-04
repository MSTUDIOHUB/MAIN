import {
  getLocalFileReadPathForToolCall,
  getToolRiskLevelForCall,
  isLocalFileReadApproved,
  isPerCallOnlyToolRisk,
} from "../../lib/toolCapabilities";
import { shellPermissionPreflight } from "../../lib/ipc";
import {
  canApplyShellAutoReview,
  resolveShellAutoApproval,
} from "../../lib/shellAutoApproval";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import {
  deriveRuntimeV2PlanSourceFreshness,
  resolveRuntimeV2PlanMutationScope,
  resolveRuntimeV2PlanValidationScope,
  type RuntimeV2Command,
} from "../../lib/runtime-v2";
import {
  isRuntimeV2ReadOnlyToolName,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  aggregateForCurrentTurn,
  approvedPlanForCurrentTurn,
} from "./executionAggregate";
import {
  validateRuntimeV2MutationLease,
} from "./correctiveMutationPolicy";
import {
  runtimeV2MutationLeaseRejectionReason,
} from "./executionMutationRejection";
import {
  activeRuntimeV2ChildWriteConflict,
  activeRuntimeV2SubagentJobWriteConflict,
} from "./executionSubagentWriteScope";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import { finiteValidationCommandRejection } from "./executionValidationCommand";
import { preferredFiniteValidationCommand } from "./executionProviderContext";
import {
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
  deriveRuntimeV2ExecutionContract,
  runtimeV2ExecutionContractAllowsTargets,
  runtimeV2ExecutionContractMutationTargets,
  runtimeV2ExecutionContractRequired,
  validateRuntimeV2ExecutionContractSubmission,
} from "./executionContract";
import {
  deriveRuntimeV2ExecutionContractAdvance,
} from "./executionContractAdvance";
import {
  deriveRuntimeV2ValidationCorrectionWindow,
} from "./executionValidationCorrection";
import {
  authorizationFor,
  type RuntimeV2ToolAuthorizationResult,
} from "./executionAuthorizationContext";

export {
  authorizationFor,
  compactTextEnvelopeCatalog,
  createRuntimeV2ExecutionAuthorization,
  providerToolDefinitionsForCommand,
  RUNTIME_V2_VALIDATION_TOOL_NAMES,
  type RuntimeV2ToolAuthorizationResult,
} from "./executionAuthorizationContext";

export {
  runtimeV2ProviderActionWindowFor,
} from "./executionProviderActionWindow";
export {
  correctiveFiniteValidationCommand,
  finiteValidationCommandRejection,
  type RuntimeV2FiniteValidationRejection,
} from "./executionValidationCommand";
export {
  runtimeV2MutationLeaseRejectionReason,
} from "./executionMutationRejection";

export function validateToolAgainstPhaseAndPlan(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly failureKind:
    | "not_authorized"
    | "protocol_invalid"
    | "source_mismatch"
    | null;
  readonly reasonCode: string | null;
} {
  const aggregate = aggregateForCurrentTurn(input.ports);
  const durableChildWritePending = (aggregate?.subagents || []).some(
    (job) =>
      (job.status === "queued" || job.status === "running") &&
      job.taskKind === "implement" &&
      job.accessMode === "write",
  );
  const directExecutionContractAdvance = aggregate?.strategy === "execute"
    ? deriveRuntimeV2ExecutionContractAdvance(aggregate)
    : null;
  const validationCorrection = aggregate?.strategy === "execute"
    ? deriveRuntimeV2ValidationCorrectionWindow(aggregate)
    : null;
  if (
    input.toolName === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
  ) {
    const validation = validateRuntimeV2ExecutionContractSubmission({
      aggregate,
      args: input.args,
    });
    return validation.allowed
      ? { allowed: true, reason: null, failureKind: null, reasonCode: null }
      : {
          allowed: false,
          reason: validation.reason,
          failureKind: "protocol_invalid",
          reasonCode: "execution_contract_invalid",
        };
  }
  if (
    input.command.kind === "execute_validation" &&
    (
      (input.ports.live.childWriteScopes?.size || 0) > 0 ||
      durableChildWritePending
    )
  ) {
    return {
      allowed: false,
      reason:
        "实现子智能体仍持有待汇合的写入事务；必须先 wait_subagents 并提交或丢弃这些事务，才能验证最终工作区版本。",
      failureKind: "not_authorized",
      reasonCode: "active_child_write_pending",
    };
  }
  if (
    input.command.kind === "execute_validation" &&
    directExecutionContractAdvance?.required &&
    directExecutionContractAdvance.pendingTargets.length > 0
  ) {
    return {
      allowed: false,
      reason: [
        "当前 Execute 实施契约仍有尚未提交修改的目标，不能用提前验证跳过实施步骤。",
        `待实施目标：${directExecutionContractAdvance.pendingTargets.join(", ")}。`,
        "请先完成这些目标，或依据新证据显式修订执行契约。",
      ].join(" "),
      failureKind: "not_authorized",
      reasonCode: "execution_contract_pending_mutations",
    };
  }
  if (
    input.command.kind === "execute_validation" &&
    input.toolName === "run_command"
  ) {
    const command = String(
      input.args.command || input.args.cmd || "",
    ).trim();
    const rejection = finiteValidationCommandRejection(command);
    if (rejection) {
      return {
        allowed: false,
        reason: rejection.message,
        failureKind: "protocol_invalid",
        reasonCode: rejection.reasonCode,
      };
    }
    if (aggregate?.strategy === "execute") {
      const preferred = preferredFiniteValidationCommand(input.ports);
      if (
        validationCorrection?.validationCommandUnavailable &&
        command === validationCorrection.failedValidationCommand
      ) {
        return {
          allowed: false,
          reason:
            `有限验证命令 ${JSON.stringify(command)} 已在当前工作区证明无法执行；请选择另一个有限 build、test、lint、typecheck、check 或行为断言。`,
          failureKind: "not_authorized",
          reasonCode: "failed_validation_command_repeated",
        };
      }
      if (
        !validationCorrection?.validationCommandUnavailable &&
        preferred &&
        command !== preferred
      ) {
        return {
          allowed: false,
          reason:
            `当前 Execute 验证权威只允许精确命令 ${JSON.stringify(preferred)}；不得改用另一个有限命令。`,
          failureKind: "not_authorized",
          reasonCode: "execution_contract_validation_scope",
        };
      }
    }
  }
  if (
    aggregate?.strategy === "analyze" &&
    (
      !isRuntimeV2ReadOnlyToolName(input.toolName) ||
      input.command.kind === "execute_validation"
    )
  ) {
    return {
      allowed: false,
      reason: "工作区只读任务没有修改或验证效果权限。",
      failureKind: "not_authorized",
      reasonCode: "workspace_read_only_authority",
    };
  }
  if (
    aggregate?.strategy === "execute" &&
    input.command.kind === "execute_tool" &&
    input.toolName === "read_file" &&
    directExecutionContractAdvance?.required
  ) {
    const target = String(input.args.path || input.target || "").trim();
    if (
      !directExecutionContractAdvance.sourceReviewAvailable ||
      !directExecutionContractAdvance.sourceReviewTargets.some((candidate) =>
        workspacePathsReferToSameFile(candidate, target)
      )
    ) {
      return {
        allowed: false,
        reason: directExecutionContractAdvance.sourceReviewAvailable
          ? `本轮只允许复查刚修改的目标：${directExecutionContractAdvance.sourceReviewTargets.join(", ")}。`
          : "本次修改后的单批源码复查已经结束；请继续契约修改或进入验收。",
        failureKind: "not_authorized",
        reasonCode: "execution_contract_source_review_scope",
      };
    }
  }
  if (
    input.command.kind === "execute_tool" &&
    isWorkspaceMutationToolName(input.toolName)
  ) {
    const requestedTargets = resolveWorkspaceMutationTargets(
      input.toolName,
      input.args,
      input.target,
    );
    if (aggregate?.strategy === "execute") {
      const executionContract = deriveRuntimeV2ExecutionContract(aggregate);
      if (
        !executionContract &&
        runtimeV2ExecutionContractRequired(aggregate)
      ) {
        return {
          allowed: false,
          reason:
            "多个版本化源码责任方已经可见；必须先用 record_execution_contract 固化根因、精确修改范围和验收方法，再执行首次修改。",
          failureKind: "protocol_invalid",
          reasonCode: "execution_contract_required",
        };
      }
      if (
        executionContract &&
        !validationCorrection?.active &&
        !runtimeV2ExecutionContractAllowsTargets({
          contract: executionContract,
          targets: requestedTargets,
        })
      ) {
        return {
          allowed: false,
          reason: [
            "修改目标超出当前 Execute 实施契约。",
            `允许目标：${runtimeV2ExecutionContractMutationTargets(executionContract).join(", ") || "无"}。`,
            "如新证据确实改变方案，请先读取精确目标并用 record_execution_contract + revision_reason 显式修订；不得在修改动作中临时扩张范围。",
          ].join(" "),
          failureKind: "not_authorized",
          reasonCode: "execution_contract_mutation_scope",
        };
      }
    }
    const childConflict = activeRuntimeV2ChildWriteConflict({
      live: input.ports.live,
      targets: requestedTargets,
    }) || activeRuntimeV2SubagentJobWriteConflict({
      jobs: aggregate?.subagents || [],
      targets: requestedTargets,
    });
    if (childConflict) {
      return {
        allowed: false,
        reason: [
          "目标正由实现子智能体持有排他写入所有权。",
          `child=${childConflict.jobId}`,
          `scope=${childConflict.scope.join(", ")}`,
          "请继续处理不重叠工作，并在需要这些修改时 wait_subagents。",
        ].join(" "),
        failureKind: "not_authorized",
        reasonCode: "active_child_write_scope_conflict",
      };
    }
    const mutationLease = validateRuntimeV2MutationLease({
      ports: input.ports,
      toolCallId: String(input.command.payload.toolCallId || ""),
      toolName: input.toolName,
      args: input.args,
      target: input.target,
    });
    if (mutationLease && !mutationLease.allowed) {
      return {
        allowed: false,
        reason: runtimeV2MutationLeaseRejectionReason({
          toolName: input.toolName,
          unexpectedTargets: mutationLease.unexpectedTargets,
          leaseTargets: mutationLease.leases.map((lease) => lease.target),
          recoveryExcerpt: mutationLease.recoveryExcerpt,
        }),
        failureKind:
          mutationLease.reasonCode === "mutation_source_text_mismatch"
            ? "source_mismatch"
            : "protocol_invalid",
        reasonCode: mutationLease.reasonCode,
      };
    }
  }
  if (aggregate?.strategy !== "plan") {
    return { allowed: true, reason: null, failureKind: null, reasonCode: null };
  }
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
    const freshness = deriveRuntimeV2PlanSourceFreshness(aggregate);
    const mutationAlreadyCommitted = aggregate.evidence.some(
      (evidence) => evidence.kind === "mutation",
    );
    if (!mutationAlreadyCommitted && freshness && !freshness.allFresh) {
      const stale = [...freshness.staleTargets, ...freshness.unversionedTargets];
      return stale.length > 0
        ? {
            allowed: false,
            reason: `已批准 WorkPlan 的源版本已变化或缺少版本权威：${stale.join(", ")}`,
            failureKind: "not_authorized",
            reasonCode: "approved_plan_source_version_stale",
          }
        : {
            allowed: false,
            reason: `执行已批准 WorkPlan 前必须重新读取当前目标：${freshness.missingTargets.join(", ")}`,
            failureKind: "protocol_invalid",
            reasonCode: "approved_plan_source_refresh_required",
          };
    }
    const scope = resolveRuntimeV2PlanMutationScope({
      plan: approved.plan,
      requestedTargets: resolveWorkspaceMutationTargets(
        input.toolName,
        input.args,
        input.target,
      ),
    });
    if (!scope.allowed) {
      return {
        allowed: false,
        reason: `修改目标不在已批准 WorkPlan 范围内：${scope.unexpectedTargets.join(", ") || "未解析目标"}`,
        failureKind: "not_authorized",
        reasonCode: "approved_plan_mutation_scope",
      };
    }
  }
  if (input.command.kind === "execute_validation") {
    const scope = resolveRuntimeV2PlanValidationScope({
      plan: approved.plan,
      toolName: input.toolName,
      args: input.args,
    });
    if (!scope.allowed) {
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

export async function authorizeToolForCurrentTurn(
  input: RuntimeV2ExecutionPortsInput,
  name: string,
  args: Record<string, unknown>,
): Promise<RuntimeV2ToolAuthorizationResult> {
  const state = input.get();
  const authorization = authorizationFor(input);
  const catalogResolution = authorization.toolCatalog.lookup(name);
  if (
    catalogResolution.status !== "resolved" ||
    catalogResolution.entry.source !== "built_in"
  ) {
    return {
      allowed: false,
      reason: `当前 Runtime v2 未暴露工具 ${name}。`,
      allowExternalLocalRead: false,
    };
  }
  const localFileReadPath = getLocalFileReadPathForToolCall(
    name,
    args,
    input.context.runWorkspace,
  );
  // Approval changes whether the call needs review; it must not erase the
  // fact that execution still crosses the workspace boundary. Preserve the
  // boundary risk so the executor receives allowExternalLocalRead exactly
  // for the approved target.
  const risk = localFileReadPath
    ? "local_file_read"
    : getToolRiskLevelForCall(
        name,
        args,
        authorization.capabilityRegistry,
        {
          workspace: input.context.runWorkspace,
          approvedLocalFileReadPaths: state.approvedLocalFileReadPaths,
        },
      );
  const capability = authorization.capabilityRegistry.tools[name];
  if (
    !capability?.enabled ||
    authorization.policy.disabledRiskLevels.includes(risk)
  ) {
    return {
      allowed: false,
      reason: `工具 ${name} 的 ${risk} 权限已被当前策略禁用。`,
      allowExternalLocalRead: false,
    };
  }
  if (risk === "read_only") {
    return { allowed: true, reason: null, allowExternalLocalRead: false };
  }
  if (risk === "external_read") {
    const networkTool = name === "web_search" || name === "web_fetch";
    return networkTool && state.webSearchEnabled !== true
      ? {
          allowed: false,
          reason: "当前会话未启用网络访问。",
          allowExternalLocalRead: false,
        }
      : { allowed: true, reason: null, allowExternalLocalRead: false };
  }
  if (risk === "local_file_read") {
    const approved = !!localFileReadPath &&
      isLocalFileReadApproved(
        localFileReadPath,
        state.approvedLocalFileReadPaths,
      );
    return approved
      ? { allowed: true, reason: null, allowExternalLocalRead: true }
      : {
          allowed: false,
          reason: "读取工作区外本地文件需要用户明确授权。",
          allowExternalLocalRead: false,
          approvalRequired: true,
          risk,
          ...(localFileReadPath ? { localFileReadPath } : {}),
        };
  }
  const consent = state.currentTurnExecutionConsent;
  if (consent?.turnId !== input.context.turnId || consent.granted !== true) {
    return {
      allowed: false,
      reason: `执行 ${risk} 工具前需要本轮执行授权。`,
      allowExternalLocalRead: false,
    };
  }
  if (risk === "workspace_write") {
    return { allowed: true, reason: null, allowExternalLocalRead: false };
  }
  if (risk === "shell") {
    const shell = await resolveShellAutoApproval({
      toolName: name,
      args,
      workspace: input.context.runWorkspace || "",
      preflight: shellPermissionPreflight,
    });
    if (!canApplyShellAutoReview(shell)) {
      return {
        allowed: false,
        reason: shell.error || "该 Shell 命令需要单独审批，未执行。",
        allowExternalLocalRead: false,
      };
    }
    return {
      allowed: true,
      reason: null,
      allowExternalLocalRead: false,
      ...(shell.approval
        ? { shellPermissionApproval: shell.approval }
        : {}),
    };
  }
  if (isPerCallOnlyToolRisk(risk)) {
    return {
      allowed: false,
      reason: `工具 ${name} 的 ${risk} 权限需要单次审批，不能复用本轮授权。`,
      allowExternalLocalRead: false,
      approvalRequired: true,
      risk,
    };
  }
  return {
    allowed: true,
    reason: null,
    allowExternalLocalRead: false,
  };
}
