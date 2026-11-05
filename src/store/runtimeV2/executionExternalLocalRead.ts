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
      authorization = await authorizeToolForCurrentTurn(input.ports, input.toolName, input.args);
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

  const content =
    `TOOL_BLOCKED: ${authorization.reason || `${input.toolName} is not authorized for this Turn.`}`;
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
    ),
  };
}
