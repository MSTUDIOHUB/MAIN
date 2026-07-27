import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import {
  buildToolCapabilityRegistry,
  getLocalFileReadPathForToolCall,
  getToolRiskLevelForCall,
  isLocalFileReadApproved,
  normalizeToolPermissionPolicy,
} from "../../lib/toolCapabilities";
import { buildToolCatalog } from "../../lib/toolCatalog";
import {
  shellPermissionPreflight,
  type ShellPermissionApproval,
} from "../../lib/ipc";
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
  isRuntimeV2WorkspaceReadToolName,
  RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES,
  RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  aggregateForCurrentTurn,
  approvedPlanForCurrentTurn,
} from "./executionAggregate";
import { selectRuntimeV2ExecuteToolDefinitions } from "./providerToolSurface";
import type {
  RuntimeV2ExecutionAuthorization,
  RuntimeV2ExecutionPortsInput,
} from "./executionTypes";

export const RUNTIME_V2_VALIDATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
]);

const RUNTIME_V2_CORE_TOOL_NAMES = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_search",
  "repo_map_context",
  "code_ast_query",
  "find_symbol_references",
  "read_file",
  "get_file_outline",
  "replace_in_file",
  "write_file",
  "apply_patch",
  "git_status",
  "git_diff",
  "run_command",
  "browser_evaluate",
  "get_project_skeleton",
]);

interface RuntimeV2ToolAuthorizationResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly allowExternalLocalRead: boolean;
  readonly shellPermissionApproval?: ShellPermissionApproval;
}

function runtimeToolDefinitions(state?: any): ToolDefinition[] {
  const includeNetwork = state?.webSearchEnabled === true;
  return TOOL_DEFINITIONS.filter((definition) => {
    const name = definition.function.name;
    return RUNTIME_V2_CORE_TOOL_NAMES.has(name) ||
      (includeNetwork && RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name));
  });
}

/** Freeze the built-in tool surface and policy for this Runtime v2 Turn.
 * Extensions stay on the legacy adapter until their own capability contract
 * is migrated; an unknown tool can therefore never bypass the catalog. */
export function createRuntimeV2ExecutionAuthorization(
  state: any,
): RuntimeV2ExecutionAuthorization {
  const toolDefinitions = runtimeToolDefinitions(state);
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
  const available = [...authorizationFor(input).toolDefinitions];
  const mode = String(command.payload.mode || "").trim();
  if (mode === "conclude") return [];
  if (mode === "analyze") {
    return available.filter((definition) =>
      isRuntimeV2WorkspaceReadToolName(definition.function.name)
    );
  }
  if (mode === "validate") {
    const approved = approvedPlanForCurrentTurn(input);
    const allowed = approved
      ? new Set(approved.plan.draft.validations.flatMap((validation) => {
          if (validation.kind === "finite_command") return ["run_command"];
          if (validation.kind === "browser") return ["browser_evaluate"];
          if (validation.kind === "desktop") return ["computer_use"];
          return [];
        }))
      : RUNTIME_V2_VALIDATION_TOOL_NAMES;
    return available.filter((definition) =>
      allowed.has(definition.function.name)
    );
  }
  if (mode === "execute") {
    const aggregate = aggregateForCurrentTurn(input);
    const approvedPlanNeedsFreshReads =
      aggregate?.strategy === "plan" &&
      aggregate.workPlan?.status === "approved" &&
      !aggregate.evidence.some((evidence) => evidence.kind === "mutation") &&
      deriveRuntimeV2PlanSourceFreshness(aggregate)?.allFresh === false;
    // Keep one capability-based Execute surface for the rest of the phase.
    // Dynamically withdrawing safe reads after the first successful call
    // turns a recoverable extra observation into a provider transport error.
    // Duplicate action fingerprints remain bounded by the Runtime core, while
    // plan freshness, mutation scope and validation authority stay enforced
    // independently below this presentation surface.
    return selectRuntimeV2ExecuteToolDefinitions({
      available,
      sourceToolNames: RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES,
      isMutationToolName: isWorkspaceMutationToolName,
      requiresFreshSourceReads: approvedPlanNeedsFreshReads,
    });
  }
  if (mode === "observe") {
    const childEvidencePending = command.payload.childEvidencePending === true;
    return available.filter((definition) =>
      (!childEvidencePending &&
        isWorkspaceMutationToolName(definition.function.name)) ||
      RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(definition.function.name) ||
      RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(
        definition.function.name,
      )
    );
  }
  return available.filter((definition) =>
    isWorkspaceMutationToolName(definition.function.name) ||
    RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(definition.function.name)
  );
}

export function compactTextEnvelopeCatalog(
  tools: readonly ToolDefinition[],
): string {
  const entries = tools.map((definition) => ({
    name: definition.function.name,
    required: definition.function.parameters.required,
    properties: Object.fromEntries(
      Object.entries(definition.function.parameters.properties).map(
        ([name, schema]) => [
          name,
          {
            type: schema.type,
            ...(schema.enum ? { enum: schema.enum } : {}),
          },
        ],
      ),
    ),
  }));
  return [
    "[runtime-v2 allowed tool catalog]",
    JSON.stringify(entries),
  ].join("\n").slice(0, 12_000);
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
  if (
    input.command.kind === "execute_tool" &&
    RUNTIME_V2_VALIDATION_TOOL_NAMES.has(input.toolName)
  ) {
    return {
      allowed: false,
      reason: "有限验证只能在验证阶段执行；当前应先提交计划内的最小修改。",
      failureKind: "protocol_invalid",
      reasonCode: "validation_phase_required",
    };
  }

  const aggregate = aggregateForCurrentTurn(input.ports);
  if (
    aggregate?.strategy === "analyze" &&
    (
      !isRuntimeV2WorkspaceReadToolName(input.toolName) ||
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
    input.command.phase === "observing" &&
    isWorkspaceMutationToolName(input.toolName) &&
    aggregate?.subagents.some((job) =>
      job.status === "queued" || job.status === "running"
    )
  ) {
    return {
      allowed: false,
      reason: "并行只读调查尚未汇合；当前修改调用已拒绝，先消费已调度的子智能体证据。",
      failureKind: "protocol_invalid",
      reasonCode: "subagent_join_required_before_mutation",
    };
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
  const risk = getToolRiskLevelForCall(
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
    const path = getLocalFileReadPathForToolCall(
      name,
      args,
      input.context.runWorkspace,
    );
    const approved = !!path &&
      isLocalFileReadApproved(path, state.approvedLocalFileReadPaths);
    return approved
      ? { allowed: true, reason: null, allowExternalLocalRead: true }
      : {
          allowed: false,
          reason: "读取工作区外本地文件需要用户明确授权。",
          allowExternalLocalRead: false,
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
  return {
    allowed: false,
    reason: `Runtime v2 不会自动执行 ${risk} 工具。`,
    allowExternalLocalRead: false,
  };
}
