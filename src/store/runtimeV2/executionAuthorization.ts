import {
  getLocalFileReadPathForToolCall,
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
  type RuntimeV2Command,
} from "../../lib/runtime-v2";
import {
  isRuntimeV2ReadOnlyToolName,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  aggregateForCurrentTurn,
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
  isRuntimeV2EffectRisk,
  isRuntimeV2ObservationRisk,
  runtimeV2CatalogToolSource,
  runtimeV2ToolRiskForCall,
  type RuntimeV2ToolAuthorizationResult,
} from "./executionAuthorizationContext";
import {
  validateToolAgainstApprovedPlan,
  type RuntimeV2PlanToolAuthorizationResult,
} from "./executionPlanAuthorization";

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
}): RuntimeV2PlanToolAuthorizationResult {
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
  const authorization = authorizationFor(input.ports);
  const catalogSource = runtimeV2CatalogToolSource(
    authorization,
    input.toolName,
  );
  const catalogRisk = runtimeV2ToolRiskForCall(
    authorization,
    input.toolName,
    input.args,
    {
      workspace: input.ports.context.runWorkspace,
      approvedLocalFileReadPaths:
        input.ports.get()?.approvedLocalFileReadPaths,
    },
  );
  if (
    input.command.kind === "execute_validation" &&
    catalogSource !== "built_in"
  ) {
    return {
      allowed: false,
      reason:
        "当前验收窗口只接受 Runtime 拥有结构化判定契约的内置 validator；MCP transport success 不能作为验收结果。",
      failureKind: "protocol_invalid",
      reasonCode: "validation_tool_source_untrusted",
    };
  }
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
      (
        !isRuntimeV2ReadOnlyToolName(input.toolName) &&
        !(
          catalogSource === "mcp" &&
          isRuntimeV2ObservationRisk(catalogRisk)
        )
      ) ||
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
    aggregate?.strategy === "plan" &&
    catalogSource === "mcp" &&
    isRuntimeV2EffectRisk(catalogRisk)
  ) {
    return {
      allowed: false,
      reason:
        "已批准 WorkPlan 只为精确工作区操作授予效果范围；当前 MCP 效果没有可验证的 Plan 目标契约。",
      failureKind: "not_authorized",
      reasonCode: "approved_plan_mcp_effect_scope_missing",
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
  return validateToolAgainstApprovedPlan({ ...input, aggregate });
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
    (
      catalogResolution.entry.source !== "built_in" &&
      catalogResolution.entry.source !== "mcp"
    )
  ) {
    return {
      allowed: false,
      reason: `当前 Runtime v2 未暴露工具 ${name}。`,
      allowExternalLocalRead: false,
    };
  }
  const exposedName = catalogResolution.entry.exposedName;
  const localFileReadPath = getLocalFileReadPathForToolCall(
    exposedName,
    args,
    input.context.runWorkspace,
  );
  // Approval changes whether the call needs review; it must not erase the
  // fact that execution still crosses the workspace boundary. Preserve the
  // boundary risk so the executor receives allowExternalLocalRead exactly
  // for the approved target.
  const risk = localFileReadPath
    ? "local_file_read"
    : runtimeV2ToolRiskForCall(
        authorization,
        exposedName,
        args,
        {
          workspace: input.context.runWorkspace,
          approvedLocalFileReadPaths: state.approvedLocalFileReadPaths,
        },
      );
  const capability = authorization.capabilityRegistry.tools[exposedName];
  if (
    !risk ||
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
    const networkTool = catalogResolution.entry.source === "built_in" &&
      (exposedName === "web_search" || exposedName === "web_fetch");
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
      toolName: exposedName,
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
