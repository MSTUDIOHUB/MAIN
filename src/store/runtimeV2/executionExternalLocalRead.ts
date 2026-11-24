import type {
  RuntimeV2Command,
  RuntimeV2EventDraft,
} from "../../lib/runtime-v2";
import {
  authorizeToolForCurrentTurn,
  type RuntimeV2ToolAuthorizationResult,
} from "./executionAuthorization";
import {
  recordToolResultHistory,
  toolCompletionFor,
} from "./executionEvidence";
import { requestRuntimeV2ToolPermission } from "./executionToolPermission";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import { getShellPermissionCommandForTool } from "../../lib/shellAutoApproval";

const shellDenialRecovery = new Map([
  ["trusted_execution::PathnameExpansion", {
    code: "shell_pathname_expansion",
    en: 'Reuse exact paths from earlier results. For filename patterns use glob_search or pass a quoted pattern to find -name, such as "*.hlsl". Use grep_search for text.',
    zh: '复用前面返回的精确路径。文件名模式用 glob_search 或把 "*.hlsl" 这样的模式作为带引号的 find -name 参数。搜索正文用 grep_search。',
  }],
  ["trusted_execution::WorkingDirectoryChange", {
    code: "shell_working_directory_change",
    en: "Set the run_command cwd field to the exact workspace-relative directory and use literal paths in the command.",
    zh: "把精确的工作区相对目录填入 run_command 的 cwd 字段，命令内使用确定的路径。",
  }],
  ["trusted_execution::WorkspacePathEscape", {
    code: "shell_workspace_path_escape",
    en: "Search the exact workspace-relative directory already identified. For project dependencies, reuse the resolved package path inside the workspace. Submit independent observations as separate tool calls.",
    zh: "在已确定的工作区相对目录内查询。调查项目依赖时复用工作区内实际解析的包路径。各项独立读取分别提交工具调用。",
  }],
]);

export type RuntimeV2ToolAuthorizationResolution =
  | {
      readonly allowed: true;
      readonly authorization: RuntimeV2ToolAuthorizationResult;
    }
  | {
      readonly allowed: false;
      readonly completion: RuntimeV2EventDraft;
    };

/**
 * Resolve authorization at the effect boundary. Missing Turn consent and
 * concrete per-call review requirements await the existing ActionRequest UI.
 * Policy denials remain ordinary blocked tool completions.
 */
export async function resolveRuntimeV2ToolAuthorization(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly failureContextTarget: string;
  readonly signal?: AbortSignal;
}): Promise<RuntimeV2ToolAuthorizationResolution> {
  let authorization = await authorizeToolForCurrentTurn(
    input.ports,
    input.toolName,
    input.args,
    { command: input.command, target: input.target },
  );
  if (
    !authorization.allowed &&
    authorization.approvalRequired === true &&
    authorization.risk
  ) {
    const requestedPath = authorization.localFileReadPath || input.target;
    if (!requestedPath) {
      return {
        allowed: false,
        completion: toolCompletionFor(
          input.ports,
          input.command,
          input.toolName,
          input.args,
          input.failureContextTarget,
          "TOOL_BLOCKED: the per-call approval target is missing.",
          "blocked",
          "not_authorized",
        ),
      };
    }
    const review = await requestRuntimeV2ToolPermission({
      ports: input.ports,
      command: input.command,
      toolName: input.toolName,
      args: input.args,
      target: input.target,
      risk: authorization.risk,
      approvalRequiredCapability: authorization.approvalRequiredCapability,
      permissionTarget: requestedPath,
      shellPermissionDecision: authorization.shellPermissionDecision,
      signal: input.signal,
    });
    if (review.action === "reject") {
      const externalRead = authorization.risk === "local_file_read";
      const reason = input.ports.context.phaseLanguage === "en"
        ? externalRead
          ? `The user denied access to the local file outside the workspace: ${requestedPath}.`
          : `The user denied the ${authorization.risk} operation on ${requestedPath}.`
        : externalRead
          ? `用户拒绝了对工作区外本地文件 ${requestedPath} 的读取授权。`
          : `用户拒绝了对 ${requestedPath} 执行 ${authorization.risk} 操作。`;
      const finalMarkdown = input.ports.context.phaseLanguage === "en"
        ? externalRead
          ? `Did not read \`${requestedPath}\`: permission to access this local file outside the workspace was denied. The file was not ingested or read.`
          : `Did not execute \`${input.toolName}\` on \`${requestedPath}\`: the per-call operation was denied.`
        : externalRead
          ? `未读取 \`${requestedPath}\`：你拒绝了工作区外本地文件访问。本轮未导入或读取该文件。`
          : `未对 \`${requestedPath}\` 执行 \`${input.toolName}\`：你拒绝了这次单独授权。`;
      input.ports.live.permissionRejection = { reason, finalMarkdown };
      recordToolResultHistory({
        ports: input.ports,
        command: input.command,
        toolName: input.toolName,
        target: requestedPath,
        status: "blocked",
        content: finalMarkdown,
      });
      input.ports.logStoreEvent("runtime_v2_tool_permission_rejected", {
        turnId: input.command.run.turnId,
        runId: input.command.run.runId,
        commandIdempotencyKey: input.command.idempotencyKey,
        toolName: input.toolName,
        target: requestedPath,
      });
      return {
        allowed: false,
        completion: toolCompletionFor(
          input.ports,
          input.command,
          input.toolName,
          input.args,
          requestedPath,
          finalMarkdown,
          "blocked",
          "not_authorized",
        ),
      };
    }
    if (review.action === "accept") {
      const pendingAuthorization = authorization;
      authorization = await authorizeToolForCurrentTurn(input.ports, input.toolName, input.args, { command: input.command, target: input.target });
      const sameReview = authorization.approvalRequired === true &&
        authorization.risk === pendingAuthorization.risk &&
        authorization.approvalRequiredCapability === pendingAuthorization.approvalRequiredCapability;
      // The existing permission adapter has fenced this exact Run, command,
      // arguments and (when external) granted path. A new policy denial wins;
      // only that invocation's still-required review is satisfied here.
      if (!authorization.allowed && !sameReview) {
        // Preserve the new denial for the ordinary blocked receipt below.
      } else if (pendingAuthorization.risk === "local_file_read") {
        authorization = { ...authorization, allowed: true, reason: null, approvalRequired: false, allowExternalLocalRead: true };
      } else if (authorization.shellPermissionDecision || pendingAuthorization.shellPermissionDecision) {
        const decision = authorization.shellPermissionDecision || pendingAuthorization.shellPermissionDecision!;
        const command = getShellPermissionCommandForTool(input.toolName, input.args);
        const packet = review.shellPermissionApproval;
        const approved = !!command && decision.command === command &&
          decision.decision !== "deny" &&
          (!decision.requiresApproval || packet?.command === command);
        authorization = {
          ...authorization,
          allowed: approved,
          reason: approved ? null : "The shell approval did not match the pending command.",
          approvalRequired: false,
          ...(approved && packet ? { shellPermissionApproval: packet } : {}),
        };
      } else {
        // Per-call risks are intentionally not persisted in policy. The
        // accepted ActionRequest authorizes this exact invocation only.
        authorization = {
          ...authorization,
          allowed: true,
          reason: null,
          approvalRequired: false,
        };
      }
    }
  }
  if (authorization.allowed) {
    return { allowed: true, authorization };
  }

  const correction = shellDenialRecovery.get(authorization.shellPermissionDecision?.matchedRule || "");
  const content = [
    `TOOL_BLOCKED: ${authorization.reason || `${input.toolName} is not authorized for this Turn.`}`,
    correction?.[input.ports.context.phaseLanguage],
  ].filter(Boolean).join("\n");
  recordToolResultHistory({
    ports: input.ports,
    command: input.command,
    toolName: input.toolName,
    target: input.failureContextTarget,
    status: "blocked",
    content,
  });
  input.ports.logStoreEvent("runtime_v2_tool_execution_blocked", {
    turnId: input.command.run.turnId,
    runId: input.command.run.runId,
    commandKind: input.command.kind,
    toolName: input.toolName,
    target: input.target || null,
    reason: authorization.reason || "authorization_required",
    ...(correction ? { reasonCode: correction.code } : {}),
  });
  return {
    allowed: false,
    completion: toolCompletionFor(
      input.ports,
      input.command,
      input.toolName,
      input.args,
      input.failureContextTarget,
      content,
      "blocked",
      "not_authorized",
      undefined,
      undefined,
      correction?.code,
    ),
  };
}
