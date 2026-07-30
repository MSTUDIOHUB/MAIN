import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  buildToolCapabilityRegistry,
  getLocalFileReadPathForToolCall,
  getToolRiskLevelForCall,
  isLocalFileReadApproved,
  isPerCallOnlyToolRisk,
  normalizeToolPermissionPolicy,
  type ToolRiskLevel,
} from "../../lib/toolCapabilities";
import { buildToolCatalog } from "../../lib/toolCatalog";
import {
  shellPermissionPreflight,
  type ShellPermissionApproval,
} from "../../lib/ipc";
import { analyzeValidationCommand } from "../../lib/validationContract";
import {
  canApplyShellAutoReview,
  resolveShellAutoApproval,
} from "../../lib/shellAutoApproval";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
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
  runtimeV2ToolDefinitions,
} from "./executionToolDefinitions";
import {
  buildRuntimeV2TextEnvelopeCatalog,
  selectRuntimeV2ProviderToolDefinitions,
} from "./executionProviderTools";
import type {
  RuntimeV2ExecutionAuthorization,
  RuntimeV2ExecutionPortsInput,
} from "./executionTypes";

export const RUNTIME_V2_VALIDATION_TOOL_NAMES = new Set([
  "run_command", "browser_evaluate", "computer_use",
]);

export interface RuntimeV2FiniteValidationRejection {
  readonly reasonCode: "finite_validation_contract_required";
  readonly rejectionReason: string;
  readonly message: string;
}

export function runtimeV2MutationLeaseRejectionReason(input: {
  readonly toolName: string;
  readonly unexpectedTargets: readonly string[];
  readonly leaseTargets: readonly string[];
}): string {
  const visibleTargets = new Set(input.leaseTargets);
  const missingTargets = input.unexpectedTargets.filter(
    (target) => !visibleTargets.has(target),
  );
  if (missingTargets.length > 0) {
    return [
      "MUTATION_SOURCE_NOT_VISIBLE:",
      `修改前必须先读取当前请求中尚不可见的目标：${missingTargets.join(", ")}。`,
    ].join(" ");
  }
  if (input.toolName === "replace_in_file") {
    return [
      "REPLACE_SEARCH_TEXT_NOT_VISIBLE:",
      "search_text 与当前请求中已经可见的版本化源码不完全匹配。",
      "请直接复制已返回源码中的精确字节，或只读取尚未覆盖的范围；不要重复读取已完整覆盖的同版本文件。",
    ].join(" ");
  }
  return [
    "MUTATION_SOURCE_RANGE_NOT_VISIBLE:",
    `拟修改内容未被当前请求中的版本化源码安全覆盖：${input.unexpectedTargets.join(", ") || "未解析目标"}。`,
  ].join(" ");
}

/** One finite-validation contract shared by provider retries and execution.
 * Rejecting an invalid proposal before scheduling it prevents model protocol
 * drift from spending an execution attempt. Authorization repeats the
 * same check at the effect boundary so no adapter can bypass it. */
export function finiteValidationCommandRejection(
  value: unknown,
): RuntimeV2FiniteValidationRejection | null {
  const command = String(value || "").trim();
  const analysis = analyzeValidationCommand(command);
  if (analysis.spec?.kind === "finite_command") return null;
  const rejectionReason = analysis.rejectionReason ||
    "no_validation_segment";
  return {
    reasonCode: "finite_validation_contract_required",
    rejectionReason,
    message: [
      "验证阶段需要能以退出状态证明结果的有限 build、test、lint、typecheck 或 check 命令。",
      "cat、grep、sed、head、tail、wc 等只读检查只能补充观察，不能作为验收。",
      `当前命令未满足有限验证契约：${rejectionReason}。`,
    ].join(" "),
  };
}

export interface RuntimeV2ToolAuthorizationResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly allowExternalLocalRead: boolean;
  readonly shellPermissionApproval?: ShellPermissionApproval;
  readonly approvalRequired?: boolean;
  readonly risk?: ToolRiskLevel;
  readonly localFileReadPath?: string;
}

/** Freeze the built-in tool surface and policy for this Runtime v2 Turn.
 * Extensions stay on the legacy adapter until their own capability contract
 * is migrated; an unknown tool can therefore never bypass the catalog. */
export function createRuntimeV2ExecutionAuthorization(
  state: any,
): RuntimeV2ExecutionAuthorization {
  const toolDefinitions = runtimeV2ToolDefinitions(state);
  const policy = normalizeToolPermissionPolicy(
    state?.config?.toolPermissionPolicy,
  );
  const toolCatalog = buildToolCatalog({ builtInDefinitions: toolDefinitions });
  const capabilityRegistry = buildToolCapabilityRegistry({
    toolDefinitions,
    toolCatalog,
    policy,
  });
  return { toolDefinitions, toolCatalog, capabilityRegistry, policy };
}

export function authorizationFor(
  input: RuntimeV2ExecutionPortsInput,
): RuntimeV2ExecutionAuthorization {
  if (!input.live.authorization) {
    input.live.authorization = createRuntimeV2ExecutionAuthorization(
      input.get(),
    );
  }
  return input.live.authorization;
}

export function providerToolDefinitionsForCommand(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
): ToolDefinition[] {
  return selectRuntimeV2ProviderToolDefinitions({
    ports: input,
    command,
    available: authorizationFor(input).toolDefinitions,
  });
}

export function compactTextEnvelopeCatalog(
  tools: readonly ToolDefinition[],
): string {
  return buildRuntimeV2TextEnvelopeCatalog(tools);
}

export function validateToolAgainstPhaseAndPlan(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly failureKind: "not_authorized" | "protocol_invalid" | null;
  readonly reasonCode: string | null;
} {
  const aggregate = aggregateForCurrentTurn(input.ports);
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
    input.command.kind === "execute_tool" &&
    isWorkspaceMutationToolName(input.toolName)
  ) {
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
        }),
        failureKind: "protocol_invalid",
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
    };
  }
  return {
    allowed: true,
    reason: null,
    allowExternalLocalRead: false,
  };
}
