import {
  checkSourceSyntax,
  findSymbolReferences,
} from "../../lib/ipc";
import { sha256Hex } from "../../lib/sha256";
import { executeTool } from "../../lib/toolExecutor";
import { getToolTarget } from "../../lib/toolTarget";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { preflightWorkspaceMutation } from "../../lib/workspaceMutationPreflight";
import {
  resolveRuntimeV2PlanMutationScope,
  type RuntimeV2Command,
  type RuntimeV2EvidenceReference,
  type RuntimeV2NormalizedToolCall,
  type RuntimeV2SubagentJob,
} from "../../lib/runtime-v2";
import {
  approvedPlanForCurrentTurn,
  aggregateForCurrentTurn,
} from "./executionAggregate";
import {
  authorizationFor,
  authorizeToolForCurrentTurn,
} from "./executionAuthorization";
import { requestRuntimeV2ToolPermission } from "./executionToolPermission";
import {
  activeRuntimeV2ChildWriteConflict,
  normalizedRuntimeV2SubagentPath,
  runtimeV2JobOwnsMutationTargets,
  runtimeV2SubagentPathsOverlap,
} from "./executionSubagentWriteScope";
import { runtimeV2ContextBoundToolArguments } from "./executionText";
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

function applyPatchOperations(patch: string): Set<"create" | "modify" | "delete"> {
  const operations = new Set<"create" | "modify" | "delete">();
  for (const match of patch.matchAll(
    /^\*\*\*\s+(Add|Update|Delete)\s+File:/gm,
  )) {
    if (match[1] === "Add") operations.add("create");
    else if (match[1] === "Delete") operations.add("delete");
    else operations.add("modify");
  }
  return operations;
}

function mutationMatchesJobOperation(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}): boolean {
  const expected = input.job.implementationOperation;
  if (!expected) return false;
  if (input.toolName === "write_file") return expected === "create";
  if (input.toolName === "replace_in_file") return expected === "modify";
  if (input.toolName === "delete_workspace_path") return expected === "delete";
  if (input.toolName !== "apply_patch") return false;
  const operations = applyPatchOperations(String(input.args.patch || ""));
  return operations.size === 1 && operations.has(expected);
}

function sourceObservationRequired(toolName: string): boolean {
  return toolName !== "write_file";
}

async function readRawWorkspaceFile(
  ports: RuntimeV2ExecutionPortsInput,
  path: string,
): Promise<string> {
  return String(await executeTool(
    "read_file",
    { path, __raw: true },
    ports.context.runWorkspace || "",
    ports.context.runSessionKey,
    { toolCatalog: authorizationFor(ports).toolCatalog },
  ));
}

async function mutationPreflight(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly baseVersions: Record<string, string | null>;
}): Promise<{ readonly ok: boolean; readonly message: string }> {
  const preflight = await preflightWorkspaceMutation({
    toolName: input.toolName,
    args: input.args,
    language: input.ports.context.phaseLanguage,
    workspaceRoot: input.ports.context.runWorkspace || "",
    readFile: async (path) => {
      const content = await readRawWorkspaceFile(input.ports, path);
      input.baseVersions[normalizedRuntimeV2SubagentPath(path)] =
        sha256Hex(content);
      return content;
    },
    checkSyntax: checkSourceSyntax,
    findReferences: (symbol) => findSymbolReferences({
      symbol,
      maxResults: 80,
    }, input.ports.context.runWorkspace || ""),
  });
  return preflight.ok
    ? { ok: true, message: "" }
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
    !isWorkspaceMutationToolName(input.call.name) ||
    !mutationMatchesJobOperation({
      job: input.job,
      toolName: input.call.name,
      args: input.call.arguments,
    })
  ) {
    return {
      allowed: false,
      message:
        "CHILD_MUTATION_REJECTED: the mutation tool does not match the parent-assigned implementation operation.",
    };
  }
  const target = getToolTarget(input.call.name, input.call.arguments);
  const targets = [...new Set(
    resolveWorkspaceMutationTargets(
      input.call.name,
      input.call.arguments,
      target,
    ).map(normalizedRuntimeV2SubagentPath).filter(Boolean),
  )];
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
  if (
    sourceObservationRequired(input.call.name) &&
    targets.some((targetPath) =>
      ![...input.observedTargets].some((observed) =>
        runtimeV2SubagentPathsOverlap(observed, targetPath)
      )
    )
  ) {
    return {
      allowed: false,
      message:
        "CHILD_MUTATION_REJECTED: read the exact current source for every modify/delete target before staging the transaction.",
    };
  }

  const baseVersions: Record<string, string | null> = {};
  if (input.call.name === "delete_workspace_path") {
    for (const targetPath of targets) {
      try {
        baseVersions[targetPath] = sha256Hex(
          await readRawWorkspaceFile(input.ports, targetPath),
        );
      } catch (error) {
        return {
          allowed: false,
          message: `CHILD_MUTATION_REJECTED: cannot read delete target ${targetPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
  }
  const preflight = await mutationPreflight({
    ports: input.ports,
    toolName: input.call.name,
    args: { ...input.call.arguments },
    baseVersions,
  });
  if (!preflight.ok) return { allowed: false, message: preflight.message };
  for (const targetPath of targets) {
    if (targetPath in baseVersions) continue;
    try {
      baseVersions[targetPath] = sha256Hex(
        await readRawWorkspaceFile(input.ports, targetPath),
      );
    } catch {
      baseVersions[targetPath] = null;
    }
  }
  return {
    allowed: true,
    message: [
      "CHILD_MUTATION_STAGED",
      `evidenceId: ${input.evidenceId}`,
      `targets: ${targets.join(", ")}`,
      "effect: staged_only",
      "The live workspace is unchanged. Conclude with this evidence id; the parent Runtime will revalidate and commit at join.",
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

export async function commitRuntimeV2StagedChildMutation(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly parentCommand: RuntimeV2Command;
  readonly job: RuntimeV2SubagentJob;
  readonly staged: RuntimeV2StagedChildMutation;
  readonly signal?: AbortSignal;
}): Promise<RuntimeV2ChildMutationCommitResult> {
  if (input.signal?.aborted) {
    return { committed: false, message: "parent Run was canceled before child commit", evidence: [] };
  }
  if (!runtimeV2JobOwnsMutationTargets({
    job: input.job,
    targets: input.staged.targets,
  })) {
    return { committed: false, message: "write scope ownership is invalid", evidence: [] };
  }
  const aggregate = aggregateForCurrentTurn(input.ports);
  if (aggregate?.strategy === "plan") {
    const approved = approvedPlanForCurrentTurn(input.ports);
    if (!approved) {
      return { committed: false, message: "approved WorkPlan authority is missing", evidence: [] };
    }
    const scope = resolveRuntimeV2PlanMutationScope({
      plan: approved.plan,
      requestedTargets: input.staged.targets,
    });
    if (!scope.allowed) {
      return {
        committed: false,
        message: `staged targets are outside the approved WorkPlan: ${scope.unexpectedTargets.join(", ")}`,
        evidence: [],
      };
    }
  }
  for (const target of input.staged.targets) {
    const expected = input.staged.baseVersions[target];
    try {
      const current = sha256Hex(await readRawWorkspaceFile(input.ports, target));
      if (expected === null || expected === undefined || current !== expected) {
        return {
          committed: false,
          message: `source version changed before child join: ${target}`,
          evidence: [],
        };
      }
    } catch {
      if (expected !== null) {
        return {
          committed: false,
          message: `source disappeared before child join: ${target}`,
          evidence: [],
        };
      }
    }
  }
  const syntheticCommand: RuntimeV2Command = {
    ...input.parentCommand,
    idempotencyKey:
      `${input.parentCommand.idempotencyKey}:child-mutation:${input.job.id}`,
    kind: "execute_tool",
    payload: {
      toolCallId: input.staged.id,
      toolName: input.staged.toolName,
      arguments: { ...input.staged.arguments },
      childJobId: input.job.id,
      childTransaction: true,
    },
  };
  const authorization = await authorizeStagedMutation({
    ports: input.ports,
    command: syntheticCommand,
    staged: input.staged,
    signal: input.signal,
  });
  if (!authorization.allowed) {
    return { committed: false, message: authorization.message, evidence: [] };
  }
  const freshVersions: Record<string, string | null> = {};
  const preflight = await mutationPreflight({
    ports: input.ports,
    toolName: input.staged.toolName,
    args: { ...input.staged.arguments },
    baseVersions: freshVersions,
  });
  if (!preflight.ok) {
    return { committed: false, message: preflight.message, evidence: [] };
  }
  if (input.signal?.aborted) {
    return { committed: false, message: "parent Run was canceled before child commit", evidence: [] };
  }
  await executeTool(
    input.staged.toolName,
    runtimeV2ContextBoundToolArguments(
      input.staged.toolName,
      { ...input.staged.arguments },
      input.ports.context.runtimeContextBudget,
    ),
    input.ports.context.runWorkspace || "",
    input.ports.context.runSessionKey,
    { toolCatalog: authorizationFor(input.ports).toolCatalog },
  );
  const evidence: RuntimeV2EvidenceReference[] = [];
  for (const [index, target] of input.staged.targets.entries()) {
    let version: string | null = null;
    try {
      version = sha256Hex(await readRawWorkspaceFile(input.ports, target));
    } catch {
      version = `deleted:${input.staged.baseVersions[target] || "unknown"}`;
    }
    evidence.push({
      id: index === 0
        ? input.staged.evidenceId
        : `${input.staged.evidenceId}:${index + 1}`,
      kind: "mutation",
      target,
      version,
    });
  }
  input.ports.live.hasExecutedMutationEffect = true;
  input.ports.live.mutationSourceCoverageByToolCallId.clear();
  input.ports.live.latestProviderRequestSourceCoverage = [];
  input.ports.logStoreEvent("runtime_v2_subagent_mutation_committed", {
    turnId: input.parentCommand.run.turnId,
    runId: input.parentCommand.run.runId,
    childRunId: input.job.run.runId,
    jobId: input.job.id,
    operation: input.job.implementationOperation,
    toolName: input.staged.toolName,
    targets: input.staged.targets,
    evidenceIds: evidence.map((item) => item.id),
  });
  return {
    committed: true,
    message: `Committed child transaction for ${input.staged.targets.join(", ")}.`,
    evidence,
  };
}
