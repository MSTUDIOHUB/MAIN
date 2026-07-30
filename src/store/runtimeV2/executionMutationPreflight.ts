import { checkSourceSyntax } from "../../lib/ipc";
import {
  executeTool,
  type ToolExecutionOptions,
} from "../../lib/toolExecutor";
import {
  buildToolDiffPreview,
  type ToolDiffPreview,
} from "../../lib/toolDiff";
import type {
  RuntimeV2Command,
  RuntimeV2EventDraft,
} from "../../lib/runtime-v2";
import { preflightWorkspaceMutation } from "../../lib/workspaceMutationPreflight";
import { executeRuntimeV2ToolWithDeadline } from "./executionToolDeadline";
import {
  recordToolResultHistory,
  toolCompletionFor,
} from "./executionEvidence";
import {
  runtimeV2ProviderToolCallIdentity,
} from "./providerToolSurface";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

type RuntimeV2MutationPreparation =
  | {
      readonly allowed: true;
      readonly diffPreview?: ToolDiffPreview;
    }
  | {
      readonly allowed: false;
      readonly completion: RuntimeV2EventDraft;
    };

/**
 * Run the source-safety gate and prepare a bounded diff before the Tool port
 * commits a workspace mutation. This module owns mutation preparation only;
 * authorization and the eventual write remain Tool-port responsibilities.
 */
export async function prepareRuntimeV2Mutation(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly failureContextTarget: string;
  readonly toolExecutionOptions: ToolExecutionOptions;
}): Promise<RuntimeV2MutationPreparation> {
  const workspace = input.ports.context.runWorkspace || "";
  const preflight = await preflightWorkspaceMutation({
    toolName: input.toolName,
    args: input.args,
    language: input.ports.context.phaseLanguage,
    workspaceRoot: workspace,
    readFile: async (path) => String(
      await executeRuntimeV2ToolWithDeadline({
        toolName: "read_file",
        lifecycleDeadlineAt: input.ports.lifecycleDeadlineAt,
        now: input.ports.now,
        task: () => executeTool(
          "read_file",
          { path, __raw: true },
          workspace,
          input.ports.context.runSessionKey,
          input.toolExecutionOptions,
        ),
      }),
    ),
    checkSyntax: checkSourceSyntax,
  });
  if (!preflight.ok) {
    const rejectedActionIdentity =
      runtimeV2ProviderToolCallIdentity({
        name: input.toolName,
        arguments: input.args,
      });
    const mismatchRange = preflight.patchRecoveryMismatch?.requestedRange;
    const mismatchPath =
      preflight.patchRecoveryMismatch?.target ||
      preflight.path ||
      input.target;
    const sourceMismatch = preflight.recoveryKind === "source_mismatch";
    const targetInvalid = preflight.recoveryKind === "target_invalid";
    const mutationRejected = preflight.recoveryKind === "mutation_rejected";
    const refreshLine = mismatchRange?.startLine
      ? Math.floor(
          (
            mismatchRange.startLine +
            (mismatchRange.endLine || mismatchRange.startLine)
          ) / 2,
        )
      : null;
    const sourceRefreshHint =
      (sourceMismatch || mutationRejected) &&
        mismatchPath &&
        refreshLine
        ? `${mismatchPath}:${refreshLine}:1 - refresh this exact source window before retrying a smaller valid mutation`
        : "";
    const content = [
      preflight.message ||
        `MUTATION_PREFLIGHT_BLOCKED: ${preflight.reason || "invalid mutation"}`,
      sourceRefreshHint,
    ].filter(Boolean).join("\n");
    recordToolResultHistory({
      ports: input.ports,
      command: input.command,
      toolName: input.toolName,
      target: preflight.path || input.failureContextTarget,
      status: "failed",
      content,
    });
    input.ports.logStoreEvent("runtime_v2_mutation_preflight_rejected", {
      turnId: input.command.run.turnId,
      runId: input.command.run.runId,
      commandKind: input.command.kind,
      toolName: input.toolName,
      target: preflight.path || input.target || null,
      reason: preflight.reason || "invalid_mutation",
      recoveryKind: preflight.recoveryKind || null,
      mismatchTarget: preflight.patchRecoveryMismatch?.target || null,
      mismatchStartLine: mismatchRange?.startLine || null,
      mismatchEndLine: mismatchRange?.endLine || null,
      message: preflight.message?.slice(0, 1_000) || null,
      actionIdentity: rejectedActionIdentity,
    });
    return {
      allowed: false,
      completion: toolCompletionFor(
        input.ports,
        input.command,
        input.toolName,
        input.args,
        preflight.path || input.failureContextTarget,
        null,
        "failed",
        sourceMismatch
          ? "source_mismatch"
          : targetInvalid
            ? "target_invalid"
            : mutationRejected
              ? "mutation_rejected"
              : "protocol_invalid",
      ),
    };
  }
  try {
    return {
      allowed: true,
      diffPreview: await buildToolDiffPreview(
        input.toolName,
        input.args,
        {
          workspace,
          sessionKey: input.ports.context.runSessionKey,
        },
      ),
    };
  } catch (error) {
    input.ports.logStoreEvent("runtime_v2_tool_diff_preview_failed", {
      turnId: input.command.run.turnId,
      runId: input.command.run.runId,
      commandKind: input.command.kind,
      toolName: input.toolName,
      target: input.target || null,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true };
  }
}
