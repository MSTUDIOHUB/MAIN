import {
  checkSourceSyntax,
  findSymbolReferences,
} from "../../lib/ipc";
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
import {
  executeRuntimeV2ToolWithDeadline,
  type RuntimeV2ToolDeadlineBoundary,
} from "./executionToolDeadline";
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

type RuntimeV2MutationPreflightFailureKind =
  | "source_mismatch"
  | "target_invalid"
  | "mutation_rejected"
  | "protocol_invalid";

/** Build the single canonical rejection receipt consumed by provider history,
 * the durable effect ledger, projections, and terminal diagnostics. */
export function runtimeV2MutationPreflightFailureReceipt(input: {
  readonly message?: string | null;
  readonly reason?: string | null;
  readonly recoveryKind?: string | null;
  readonly sourceRefreshHint?: string | null;
}): {
  readonly content: string;
  readonly failureKind: RuntimeV2MutationPreflightFailureKind;
  readonly failureReasonCode: string;
} {
  const reason = String(input.reason || "invalid_mutation").trim() ||
    "invalid_mutation";
  const normalizedReason = reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "invalid_mutation";
  const recoveryKind = String(input.recoveryKind || "").trim();
  return {
    content: [
      String(input.message || "").trim() ||
        `MUTATION_PREFLIGHT_BLOCKED: ${reason}`,
      String(input.sourceRefreshHint || "").trim(),
    ].filter(Boolean).join("\n"),
    failureKind: recoveryKind === "source_mismatch"
      ? "source_mismatch"
      : recoveryKind === "target_invalid"
        ? "target_invalid"
        : recoveryKind === "mutation_rejected"
          ? "mutation_rejected"
          : "protocol_invalid",
    failureReasonCode: `mutation_preflight_${normalizedReason}`,
  };
}

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
        onTimeout: (
          timeoutMs: number,
          boundary: RuntimeV2ToolDeadlineBoundary,
        ) => {
          input.ports.logStoreEvent(
            boundary === "lifecycle"
              ? "runtime_v2_lifecycle_deadline_reached"
              : "runtime_v2_tool_deadline_exceeded",
            {
              turnId: input.command.run.turnId,
              runId: input.command.run.runId,
              commandKind: input.command.kind,
              toolName: "read_file",
              target: path,
              timeoutMs,
              lifecycleDeadlineAt: boundary === "lifecycle"
                ? input.ports.lifecycleDeadlineAt
                : null,
            },
          );
        },
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
    findReferences: (symbol) => findSymbolReferences({
      symbol,
      maxResults: 80,
    }, workspace),
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
    const failureReceipt = runtimeV2MutationPreflightFailureReceipt({
      message: preflight.message,
      reason: preflight.reason,
      recoveryKind: preflight.recoveryKind,
      sourceRefreshHint,
    });
    const content = failureReceipt.content;
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
        content,
        "failed",
        failureReceipt.failureKind,
        undefined,
        undefined,
        failureReceipt.failureReasonCode,
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
