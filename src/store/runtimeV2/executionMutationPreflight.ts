import {
  checkSourceSyntax,
  findSymbolReferences,
  getFileMetadata,
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
import { inferMutationRecoveryRange, preflightWorkspaceMutation, type WorkspaceWriteFileTargetFact } from "../../lib/workspaceMutationPreflight";
import { parseApplyPatch } from "../../lib/applyPatchTool";
import { sha256Hex } from "../../lib/sha256";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import { isWorkspaceUnityProject } from "../../lib/unityAssemblyReferences";
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
import { runtimeV2MutationLeases } from "./correctiveMutationPolicy";
import { MUTATION_SOURCE_CHANGED_REASON, runtimeV2MutationSourceRefreshInstruction } from "./executionMutationRejection";

type RuntimeV2MutationPreparation =
  | {
      readonly allowed: true;
      readonly diffPreview?: ToolDiffPreview;
      readonly writeFileTarget?: WorkspaceWriteFileTargetFact;
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
  const leases = input.toolName === "replace_in_file" || input.toolName === "apply_patch"
    ? runtimeV2MutationLeases(input.ports, String(input.command.payload.toolCallId || ""))
    : [];
  const changedSources = new Map<string, string>();
  const preflight = await preflightWorkspaceMutation({
    toolName: input.toolName,
    args: input.args,
    language: input.ports.context.phaseLanguage,
    sessionKey: input.ports.context.runSessionKey,
    workspaceRoot: workspace,
    unityProject: isWorkspaceUnityProject(input.ports.context.projectBaselineContext, workspace),
    includeRecoverySource: false,
    readFile: async (path) => {
      const current = String(await executeRuntimeV2ToolWithDeadline({
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
      }));
      const lease = leases.find(entry => workspacePathsReferToSameFile(entry.target, path));
      if (lease && /^sha256-[a-f0-9]{64}$/.test(lease.version) && lease.version !== `sha256-${sha256Hex(current)}`) {
        changedSources.set(path, current);
        throw new Error("Source version changed before mutation preparation.");
      }
      return current;
    },
    probeFileAvailability: async (path) => {
      try {
        await getFileMetadata(path, workspace);
        return "exists";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "");
        return message.startsWith("FILE_METADATA_NOT_FOUND:") ? "absent" : "unknown";
      }
    },
    checkSyntax: checkSourceSyntax,
    findReferences: (symbol) => findSymbolReferences({
      symbol,
      maxResults: 80,
    }, workspace),
  });
  if (!preflight.ok || changedSources.size > 0) {
    const rejectedActionIdentity =
      runtimeV2ProviderToolCallIdentity({
        name: input.toolName,
        arguments: input.args,
      });
    const staleSource = changedSources.entries().next().value;
    const mismatchPath = staleSource?.[0] || preflight.patchRecoveryMismatch?.target || preflight.path || input.target;
    const mismatchRange = preflight.patchRecoveryMismatch?.target === mismatchPath
      ? preflight.patchRecoveryMismatch?.requestedRange
      : null;
    const sourceMismatch = preflight.recoveryKind === "source_mismatch";
    const requiresCurrentRead = sourceMismatch || !!staleSource;
    let recoveryRange = mismatchRange;
    if (staleSource && !recoveryRange) {
      const current = staleSource[1];
      const anchors = input.toolName === "apply_patch"
        ? parseApplyPatch(String(input.args.patch || "")).operations
          .filter(operation => workspacePathsReferToSameFile(operation.path, mismatchPath))
          .flatMap(operation => operation.hunks.map(hunk => hunk.oldText))
        : [String(input.args.search_text || "")];
      const anchor = anchors.find(text => !current.includes(text.replace(/\n$/, ""))) || anchors[0];
      if (anchor) recoveryRange = inferMutationRecoveryRange(current, anchor);
    }
    const failureReceipt = requiresCurrentRead
      ? {
          content: [
            `MUTATION_SOURCE_CHANGED: ${mismatchPath}. The edit was rejected before writing.`,
            runtimeV2MutationSourceRefreshInstruction({ target: mismatchPath, requestedRange: recoveryRange }),
          ].join("\n"),
          failureKind: "source_mismatch" as const,
          failureReasonCode: MUTATION_SOURCE_CHANGED_REASON,
        }
      : runtimeV2MutationPreflightFailureReceipt({
          message: preflight.message,
          reason: preflight.reason,
          recoveryKind: preflight.recoveryKind,
        });
    const receiptTarget = requiresCurrentRead ? mismatchPath : preflight.path || input.failureContextTarget;
    const content = failureReceipt.content;
    recordToolResultHistory({
      ports: input.ports,
      command: input.command,
      toolName: input.toolName,
      target: receiptTarget,
      status: "failed",
      content,
    });
    input.ports.logStoreEvent("runtime_v2_mutation_preflight_rejected", {
      turnId: input.command.run.turnId,
      runId: input.command.run.runId,
      commandKind: input.command.kind,
      toolName: input.toolName,
      target: receiptTarget || null,
      reason: requiresCurrentRead ? MUTATION_SOURCE_CHANGED_REASON : preflight.reason || "invalid_mutation",
      recoveryKind: requiresCurrentRead ? "source_mismatch" : preflight.recoveryKind || null,
      mismatchTarget: requiresCurrentRead ? mismatchPath : null,
      mismatchStartLine: recoveryRange?.startLine || null,
      mismatchEndLine: recoveryRange?.endLine || null,
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
        receiptTarget,
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
      writeFileTarget: preflight.writeFileTarget,
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
    return { allowed: true, writeFileTarget: preflight.writeFileTarget };
  }
}
