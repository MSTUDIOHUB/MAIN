import type { ResolvedUserIntent } from "./runIntent";
import {
  classifyBuiltInTool,
  getToolRiskLevelForCall,
  getLocalFileReadPathForToolCall,
  isLocalFileReadApproved,
  isToolAutoExecutableForCall,
  type ToolCapabilityRegistry,
  type ToolRiskLevel,
  type ToolPermissionPolicy,
} from "./toolCapabilities";
import type { ToolDefinition } from "./toolSchemas";
import { normalizeToolCallForExecution } from "./toolCallNormalization";

export type ToolLifecycleState =
  | "queued"
  | "awaiting_review"
  | "running"
  | "completed"
  | "failed"
  | "declined"
  | "blocked";

export interface ToolLifecycleRecord {
  id: string;
  toolCallId: string;
  toolName: string;
  target: string;
  state: ToolLifecycleState;
  reason?: string;
  updatedAt: number;
}

export interface RuntimeToolSpec {
  name: string;
  source: "built_in" | "skill" | "mcp" | "unknown";
  risk: ToolRiskLevel;
  autoExecutable: boolean;
  approvalRequired: boolean;
  enabled: boolean;
}

export interface RuntimeToolSpecRegistry {
  tools: Record<string, RuntimeToolSpec>;
}

export interface RuntimeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type RuntimeToolPlanAction =
  | "blocked_unavailable"
  | "blocked_plan_gate"
  | "local_file_read_review"
  | "auto_execute"
  | "spec_file_auto_approved"
  | "review_required";

export type SessionAutoApproveScope =
  | "workspace_write"
  | "shell"
  | "local_file_read"
  | "external_write"
  | "browser_control"
  | "mcp_action";

export interface RuntimeToolPlanResult {
  action: RuntimeToolPlanAction;
  toolArgs: Record<string, unknown>;
  target: string;
  source?: RuntimeToolSpec["source"];
  risk?: ToolRiskLevel;
  localFileReadPath?: string;
  sessionAutoApproved?: boolean;
  reason?: "pre_approval_source_write" | "pre_approval_tasks" | "missing_tasks_before_source";
}

export interface PlanRuntimeToolCallInput {
  toolCall: RuntimeToolCall;
  workspace: string;
  availableToolNames: Set<string>;
  capabilityRegistry: ToolCapabilityRegistry;
  toolPermissionPolicy: ToolPermissionPolicy;
  approvedLocalFileReadPaths: string[];
  autoApproveToolScopes?: Iterable<SessionAutoApproveScope> | null;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  isPlanApproved: boolean;
  planTaskCount: number;
  getToolTarget: (name: string, args: Record<string, unknown>) => string;
  isPreApprovalPlanDraftWrite: (name: string, args: Record<string, unknown>) => boolean;
  isExecutionPlanArtifactWrite: (name: string, args: Record<string, unknown>) => boolean;
  isTasksPlanWrite: (name: string, args: Record<string, unknown>) => boolean;
}

function scopeForRisk(risk: ToolRiskLevel): SessionAutoApproveScope | null {
  switch (risk) {
    case "workspace_write":
      return "workspace_write";
    case "shell":
      return "shell";
    case "local_file_read":
      return "local_file_read";
    case "external_write":
      return "external_write";
    case "browser_control":
      return "browser_control";
    default:
      return null;
  }
}

function sessionAutoApproveScopesInclude(
  scopes: Iterable<SessionAutoApproveScope> | null | undefined,
  expected: SessionAutoApproveScope,
): boolean {
  if (!scopes) return false;
  for (const item of scopes) {
    if (item === expected) return true;
  }
  return false;
}

export function isAllowedBySessionAutoApprove(
  risk: ToolRiskLevel,
  source: RuntimeToolSpec["source"],
  scopes: Iterable<SessionAutoApproveScope> | null | undefined,
  policy: ToolPermissionPolicy,
): boolean {
  if (risk === "destructive") return false;
  if (policy.disabledRiskLevels.includes(risk)) return false;
  if (source === "mcp" && sessionAutoApproveScopesInclude(scopes, "mcp_action")) {
    return true;
  }
  const scope = scopeForRisk(risk);
  return !!scope && sessionAutoApproveScopesInclude(scopes, scope);
}

function parseToolCallArguments(call: RuntimeToolCall, workspace?: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.arguments || "{}");
    const args = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    return normalizeToolCallForExecution(call.name, args, workspace);
  } catch {
    return {};
  }
}

function isPlanFileReadBeforeTasks(name: string, args: Record<string, unknown>, target: string): boolean {
  if (!["read_file", "read_document", "get_file_outline", "code_ast_query", "find_symbol_references", "git_status", "git_diff", "list_directory"].includes(name)) return false;
  const rawPath = String(args.path || args.file_path || target || "")
    .replace(/\\/g, "/")
    .toLowerCase();
  if (!rawPath) return false;
  return rawPath.includes(".main/plans");
}

export function createRuntimeToolSpecRegistry(input: {
  toolDefinitions: ToolDefinition[];
  capabilityRegistry: ToolCapabilityRegistry;
}): RuntimeToolSpecRegistry {
  const tools: Record<string, RuntimeToolSpec> = {};

  for (const tool of input.toolDefinitions) {
    const name = tool.function.name;
    const capability = input.capabilityRegistry.tools[name];
    const risk = capability?.risk ?? classifyBuiltInTool(name);
    const approvalRequired = input.capabilityRegistry.policy.approvalRequiredRiskLevels.includes(risk);
    const enabled = capability?.enabled ?? !input.capabilityRegistry.policy.disabledRiskLevels.includes(risk);

    tools[name] = {
      name,
      source: capability?.source ?? "unknown",
      risk,
      autoExecutable: capability?.autoExecutable ?? false,
      approvalRequired,
      enabled,
    };
  }

  return { tools };
}

export function initialLifecycleStateForPlanAction(action: RuntimeToolPlanAction): ToolLifecycleState {
  switch (action) {
    case "auto_execute":
    case "spec_file_auto_approved":
      return "queued";
    case "local_file_read_review":
    case "review_required":
      return "awaiting_review";
    case "blocked_unavailable":
    case "blocked_plan_gate":
      return "blocked";
    default:
      return "queued";
  }
}

export function planRuntimeToolCall(input: PlanRuntimeToolCallInput): RuntimeToolPlanResult {
  const toolArgs = parseToolCallArguments(input.toolCall, input.workspace);
  const target = input.getToolTarget(input.toolCall.name, toolArgs);
  const capability = input.capabilityRegistry.tools[input.toolCall.name];
  const source = capability?.source ?? "unknown";
  const risk = getToolRiskLevelForCall(
    input.toolCall.name,
    toolArgs,
    input.capabilityRegistry,
    {
      workspace: input.workspace,
      approvedLocalFileReadPaths: input.approvedLocalFileReadPaths,
    },
  );
  const planMetadata = { source, risk };

  if (!input.availableToolNames.has(input.toolCall.name)) {
    return {
      action: "blocked_unavailable",
      ...planMetadata,
      toolArgs,
      target,
    };
  }

  if (
    input.isPlanApproved &&
    input.runtimeIntent === "execute" &&
    input.planTaskCount === 0
  ) {
    if (input.isExecutionPlanArtifactWrite(input.toolCall.name, toolArgs)) {
      return {
        action: "spec_file_auto_approved",
        ...planMetadata,
        toolArgs,
        target,
      };
    }

    if (isPlanFileReadBeforeTasks(input.toolCall.name, toolArgs, target)) {
      return {
        action: "auto_execute",
        ...planMetadata,
        toolArgs,
        target,
      };
    }

    return {
      action: "blocked_plan_gate",
      ...planMetadata,
      toolArgs,
      target,
      reason: "missing_tasks_before_source",
    };
  }

  const localFileReadPath = getLocalFileReadPathForToolCall(input.toolCall.name, toolArgs, input.workspace) || undefined;
  const shouldGateLocalFileRead =
    !!localFileReadPath &&
    !isLocalFileReadApproved(localFileReadPath, input.approvedLocalFileReadPaths);
  const sessionAutoApproved = isAllowedBySessionAutoApprove(
    risk,
    source,
    input.autoApproveToolScopes,
    input.toolPermissionPolicy,
  );
  if (shouldGateLocalFileRead) {
    if (sessionAutoApproved) {
      return {
        action: "auto_execute",
        ...planMetadata,
        toolArgs,
        target,
        localFileReadPath,
        sessionAutoApproved: true,
      };
    }
    return {
      action: "local_file_read_review",
      ...planMetadata,
      toolArgs,
      target,
      localFileReadPath,
    };
  }

  if (sessionAutoApproved) {
    return {
      action: "auto_execute",
      ...planMetadata,
      toolArgs,
      target,
      localFileReadPath,
      sessionAutoApproved: true,
    };
  }

  if (isToolAutoExecutableForCall(
    input.toolCall.name,
    toolArgs,
    input.capabilityRegistry,
    input.toolPermissionPolicy,
    {
      workspace: input.workspace,
      approvedLocalFileReadPaths: input.approvedLocalFileReadPaths,
    },
  )) {
    return {
      action: "auto_execute",
      ...planMetadata,
      toolArgs,
      target,
      localFileReadPath,
    };
  }

  if (input.workflowMode === "plan" && input.runtimeIntent !== "execute" && input.runtimeIntent !== "studio_workflow") {
    if (!input.isPlanApproved && input.isPreApprovalPlanDraftWrite(input.toolCall.name, toolArgs)) {
      return {
        action: "spec_file_auto_approved",
        ...planMetadata,
        toolArgs,
        target,
      };
    }

    if (input.isPlanApproved && input.isExecutionPlanArtifactWrite(input.toolCall.name, toolArgs)) {
      return {
        action: "spec_file_auto_approved",
        ...planMetadata,
        toolArgs,
        target,
      };
    }

    const reason: RuntimeToolPlanResult["reason"] =
      !input.isPlanApproved && input.isTasksPlanWrite(input.toolCall.name, toolArgs)
        ? "pre_approval_tasks"
        : input.isPlanApproved && input.planTaskCount === 0
        ? "missing_tasks_before_source"
        : "pre_approval_source_write";

    return {
      action: "blocked_plan_gate",
      ...planMetadata,
      toolArgs,
      target,
      reason,
    };
  }

  if (risk === "browser_control") {
    return {
      action: "review_required",
      ...planMetadata,
      toolArgs,
      target,
      localFileReadPath,
    };
  }

  return {
    action: "review_required",
    ...planMetadata,
    toolArgs,
    target,
    localFileReadPath,
  };
}
