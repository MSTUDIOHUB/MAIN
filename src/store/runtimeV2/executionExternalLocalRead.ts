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
 * Resolve authorization at the effect boundary. External local reads are the
 * only Runtime v2 effect that can pause here for an existing UI decision; all
 * other denials remain ordinary blocked tool completions.
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
    authorization.risk === "local_file_read" &&
    authorization.localFileReadPath
  ) {
    const requestedPath = authorization.localFileReadPath;
    const review = await requestRuntimeV2ToolPermission({
      ports: input.ports,
      command: input.command,
      toolName: input.toolName,
      args: input.args,
      target: input.target,
      risk: authorization.risk,
      localFileReadPath: requestedPath,
      signal: input.signal,
    });
    if (review.action === "reject") {
      const reason = input.ports.context.phaseLanguage === "en"
        ? `The user denied access to the local file outside the workspace: ${requestedPath}.`
        : `用户拒绝了对工作区外本地文件 ${requestedPath} 的读取授权。`;
      const finalMarkdown = input.ports.context.phaseLanguage === "en"
        ? `Did not read \`${requestedPath}\`: permission to access this local file outside the workspace was denied. The file was not ingested or read.`
        : `未读取 \`${requestedPath}\`：你拒绝了工作区外本地文件访问。本轮未导入或读取该文件。`;
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
      // The UI resolver grants one exact normalized path. Re-read current
      // authority exactly once before any ingest or read side effect.
      authorization = await authorizeToolForCurrentTurn(
        input.ports,
        input.toolName,
        input.args,
      );
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
