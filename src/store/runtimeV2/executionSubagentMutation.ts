import {
  checkSourceSyntax,
  findSymbolReferences,
} from "../../lib/ipc";
import { getToolTarget } from "../../lib/toolTarget";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import { preflightWorkspaceMutation, type WorkspaceWriteFileTargetFact } from "../../lib/workspaceMutationPreflight";
import { sha256Hex } from "../../lib/sha256";
import type {
  RuntimeV2Command,
  RuntimeV2EvidenceReference,
  RuntimeV2NormalizedToolCall,
  RuntimeV2SubagentJob,
} from "../../lib/runtime-v2";
import { authorizeToolForCurrentTurn } from "./executionAuthorization";
import { requestRuntimeV2ToolPermission } from "./executionToolPermission";
import {
  activeRuntimeV2ChildWriteConflict,
  normalizedRuntimeV2SubagentPath,
  runtimeV2JobOwnsMutationTargets,
} from "./executionSubagentWriteScope";
import {
  captureStagedTargetBaseVersions,
  commitRuntimeV2StagedBatch,
  probeSubagentDiskAvailability,
  readRawSubagentWorkspaceFile,
  resolveJobMatchingTargetRequests,
} from "./executionSubagentStaging";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2StagedChildMutation,
} from "./executionTypes";

const CHILD_MUTATION_TOOL_NAMES = new Set([
  "replace_in_file",
  "write_file",
  "apply_patch",
  "delete_workspace_path",
]);

export interface RuntimeV2ChildMutationStageResult {
  readonly allowed: boolean;
  readonly message: string;
  readonly staged?: RuntimeV2StagedChildMutation;
}

export interface RuntimeV2ChildMutationCommitResult {
  readonly committed: boolean;
  readonly message: string;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
}

async function mutationPreflight(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly baseVersions: Record<string, string | null>;
}): Promise<{ readonly ok: boolean; readonly message: string; readonly writeFileTarget?: WorkspaceWriteFileTargetFact }> {
  const preflight = await preflightWorkspaceMutation({
    toolName: input.toolName,
    args: input.args,
    language: input.ports.context.phaseLanguage,
    workspaceRoot: input.ports.context.runWorkspace || "",
    readFile: async (path) => {
      const content = await readRawSubagentWorkspaceFile(input.ports, path);
      input.baseVersions[normalizedRuntimeV2SubagentPath(path)] =
        sha256Hex(content);
      return content;
    },
    probeFileAvailability: (path) => probeSubagentDiskAvailability(input.ports, path),
    checkSyntax: checkSourceSyntax,
    findReferences: (symbol) => findSymbolReferences({
      symbol,
      maxResults: 80,
    }, input.ports.context.runWorkspace || ""),
  });
  if (input.toolName === "write_file" && preflight.writeFileTarget?.exists) {
    return { ok: false, message: "CHILD_MUTATION_REJECTED: a create transaction cannot overwrite an existing target." };
  }
  return preflight.ok
    ? { ok: true, message: "", writeFileTarget: preflight.writeFileTarget }
    : {
        ok: false,
        message: preflight.message ||
          `MUTATION_PREFLIGHT_BLOCKED: ${preflight.reason || "invalid mutation"}`,
      };
}

export async function stageRuntimeV2ChildMutation(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly job: RuntimeV2SubagentJob;
  readonly call: RuntimeV2NormalizedToolCall;
  readonly observedTargets: ReadonlySet<string>;
  readonly evidenceId: string;
}): Promise<RuntimeV2ChildMutationStageResult> {
  if (
    !CHILD_MUTATION_TOOL_NAMES.has(input.call.name) ||
    !isWorkspaceMutationToolName(input.call.name)
  ) {
    return {
      allowed: false,
      message:
        "CHILD_MUTATION_REJECTED: the mutation tool does not match the parent-assigned implementation operation.",
    };
  }
  const fallbackTarget = getToolTarget(input.call.name, input.call.arguments);
  const reqCheck = resolveJobMatchingTargetRequests({
    job: input.job,
    toolName: input.call.name,
    args: { ...input.call.arguments },
    fallbackTarget,
  });
  if (!reqCheck.ok) {
    return { allowed: false, message: reqCheck.message };
  }
  const targets = [...new Set(reqCheck.requests.map((item) => item.target))];
  if (!runtimeV2JobOwnsMutationTargets({ job: input.job, targets })) {
    return {
      allowed: false,
      message:
        "CHILD_MUTATION_REJECTED: one or more targets are outside the child's exclusive write scope.",
    };
  }
  const siblingConflict = activeRuntimeV2ChildWriteConflict({
    live: input.ports.live,
    targets,
    excludeJobId: input.job.id,
  });
  if (siblingConflict) {
    return {
      allowed: false,
      message:
        `CHILD_MUTATION_REJECTED: target overlaps active writer ${siblingConflict.jobId}.`,
    };
  }
  const captured = await captureStagedTargetBaseVersions({
    ports: input.ports,
    requests: reqCheck.requests,
    observedTargets: input.observedTargets,
  });
  if (!captured.ok) {
    return { allowed: false, message: captured.message };
  }
  const baseVersions = { ...captured.baseVersions };
  const preflight = await mutationPreflight({
    ports: input.ports,
    toolName: input.call.name,
    args: { ...input.call.arguments },
    baseVersions,
  });
  if (!preflight.ok) return { allowed: false, message: preflight.message };
  return {
    allowed: true,
    message: [
      "CHILD_MUTATION_STAGED",
      `evidenceId: ${input.evidenceId}`,
      `targets: ${targets.join(", ")}`,
      "effect: staged_only",
      "The live workspace is unchanged. Conclude with this evidence id (or stage another un-staged target in your allowed_paths); the parent Runtime will revalidate and commit at join.",
    ].join("\n"),
    staged: {
      schemaVersion: "runtime-v2-staged-child-mutation.v1",
      id: input.call.id,
      evidenceId: input.evidenceId,
      toolName: input.call.name as RuntimeV2StagedChildMutation["toolName"],
      arguments: { ...input.call.arguments },
      targets,
      baseVersions,
    },
  };
}

async function authorizeStagedMutation(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly staged: RuntimeV2StagedChildMutation;
  readonly signal?: AbortSignal;
}): Promise<{ readonly allowed: boolean; readonly message: string }> {
  let authorization = await authorizeToolForCurrentTurn(
    input.ports,
    input.staged.toolName,
    { ...input.staged.arguments },
  );
  if (
    !authorization.allowed &&
    authorization.approvalRequired &&
    authorization.risk
  ) {
    const target = input.staged.targets[0] ||
      getToolTarget(input.staged.toolName, input.staged.arguments);
    const review = await requestRuntimeV2ToolPermission({
      ports: input.ports,
      command: input.command,
      toolName: input.staged.toolName,
      args: { ...input.staged.arguments },
      target,
      risk: authorization.risk,
      approvalRequiredCapability: authorization.approvalRequiredCapability,
      permissionTarget: target,
      signal: input.signal,
    });
    if (review.action !== "accept") {
      return {
        allowed: false,
        message: review.action === "reject"
          ? "The user rejected the staged per-call mutation."
          : review.error || "The staged mutation approval could not be resolved.",
      };
    }
    authorization = {
      ...authorization,
      allowed: true,
      reason: null,
      approvalRequired: false,
    };
  }
  return authorization.allowed
    ? { allowed: true, message: "" }
    : {
        allowed: false,
        message: authorization.reason || "The staged mutation is not authorized.",
      };
}

export async function commitRuntimeV2StagedChildBatch(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly parentCommand: RuntimeV2Command;
  readonly job: RuntimeV2SubagentJob;
  readonly stagedList: readonly RuntimeV2StagedChildMutation[];
  readonly signal?: AbortSignal;
}): Promise<RuntimeV2ChildMutationCommitResult> {
  return commitRuntimeV2StagedBatch({
    ...input,
    authorizeStaged: authorizeStagedMutation,
    runPreflight: mutationPreflight,
  });
}

export async function commitRuntimeV2StagedChildMutation(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly parentCommand: RuntimeV2Command;
  readonly job: RuntimeV2SubagentJob;
  readonly staged: RuntimeV2StagedChildMutation;
  readonly signal?: AbortSignal;
}): Promise<RuntimeV2ChildMutationCommitResult> {
  return commitRuntimeV2StagedChildBatch({
    ports: input.ports,
    parentCommand: input.parentCommand,
    job: input.job,
    stagedList: [input.staged],
    signal: input.signal,
  });
}
