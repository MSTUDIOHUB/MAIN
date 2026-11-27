import { getFileMetadata } from "../../lib/ipc";
import { sha256Hex } from "../../lib/sha256";
import { executeTool } from "../../lib/toolExecutor";
import {
  resolveWorkspaceMutationRequests,
  type WorkspaceMutationOperation,
} from "../../lib/workspaceMutationTools";
import type { WorkspaceWriteFileTargetFact } from "../../lib/workspaceMutationPreflight";
import {
  authorizeRuntimeV2WriteDelegation,
  type RuntimeV2Command,
  type RuntimeV2EvidenceReference,
  type RuntimeV2SubagentJob,
} from "../../lib/runtime-v2";
import {
  aggregateForCurrentTurn,
  approvedPlanForCurrentTurn,
} from "./executionAggregate";
import { authorizationFor } from "./executionAuthorization";
import {
  deriveRuntimeV2ExecutionContract,
  runtimeV2ExecutionContractAllowsTargets,
  runtimeV2ExecutionContractMutationTargets,
} from "./executionContract";
import {
  normalizedRuntimeV2SubagentPath,
  runtimeV2JobOwnsMutationTargets,
  runtimeV2SubagentPathsOverlap,
} from "./executionSubagentWriteScope";
import { runtimeV2ContextBoundToolArguments } from "./executionText";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2StagedChildMutation,
} from "./executionTypes";
import { deriveRuntimeV2ValidationCorrectionWindow } from "./executionValidationCorrection";

export interface PreparedSubagentStagedCommit {
  readonly staged: RuntimeV2StagedChildMutation;
  readonly writeFileTarget?: WorkspaceWriteFileTargetFact;
}

export interface BatchCommitResult {
  readonly committed: boolean;
  readonly message: string;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
}

export async function readRawSubagentWorkspaceFile(
  ports: RuntimeV2ExecutionPortsInput,
  path: string,
): Promise<string> {
  return String(await executeTool(
    "read_file",
    { path, __raw: true },
    ports.context.runWorkspace || "",
    ports.context.runSessionKey,
    {
      toolCatalog: authorizationFor(ports).toolCatalog,
      skillCatalog: ports.context.skillCatalog,
    },
  ));
}

export async function probeSubagentDiskAvailability(
  ports: RuntimeV2ExecutionPortsInput,
  path: string,
): Promise<"exists" | "absent" | "unknown"> {
  try {
    await getFileMetadata(path, ports.context.runWorkspace || "");
    return "exists";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return message.startsWith("FILE_METADATA_NOT_FOUND:") ? "absent" : "unknown";
  }
}

export function directExecuteScopeForSubagent(
  ports: RuntimeV2ExecutionPortsInput,
  allowedPaths: readonly string[],
) {
  const aggregate = aggregateForCurrentTurn(ports);
  if (aggregate?.strategy !== "execute") return undefined;
  const executionContract = deriveRuntimeV2ExecutionContract(aggregate);
  const validationCorrection = deriveRuntimeV2ValidationCorrectionWindow(aggregate);
  return {
    hasContract: !!executionContract,
    validationCorrectionActive: validationCorrection.active,
    targetsAllowed: executionContract
      ? runtimeV2ExecutionContractAllowsTargets({
          contract: executionContract,
          targets: allowedPaths,
        })
      : false,
    contractTargets: executionContract
      ? runtimeV2ExecutionContractMutationTargets(executionContract)
      : [],
  };
}

/** Resolve per-target mutation requests and validate every operation against the job contract. */
export function resolveJobMatchingTargetRequests(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly fallbackTarget: string;
}):
  | { readonly ok: true; readonly requests: readonly { readonly target: string; readonly operation: WorkspaceMutationOperation }[] }
  | { readonly ok: false; readonly message: string } {
  const expected = input.job.implementationOperation;
  if (!expected) {
    return {
      ok: false,
      message: "CHILD_MUTATION_REJECTED: missing parent-assigned implementation_operation.",
    };
  }
  const rawRequests = resolveWorkspaceMutationRequests(
    input.toolName,
    { ...input.args },
    input.fallbackTarget,
  );
  if (rawRequests.length === 0) {
    return {
      ok: false,
      message: "CHILD_MUTATION_REJECTED: could not determine mutation targets from tool arguments.",
    };
  }
  const normalized: { target: string; operation: WorkspaceMutationOperation }[] = [];
  for (const request of rawRequests) {
    const target = normalizedRuntimeV2SubagentPath(request.target);
    if (!target || request.operation !== expected) {
      return {
        ok: false,
        message: `CHILD_MUTATION_REJECTED: per-target operation "${request.operation || "unknown"}" for ${target || "(unknown)"} does not match assigned operation "${expected}".`,
      };
    }
    normalized.push({ target, operation: request.operation });
  }
  return { ok: true, requests: normalized };
}

/** Verify disk availability/base version per operation: `create` asserts absent without read_file; `modify`/`delete` require prior read + SHA-256 baseline. */
export async function captureStagedTargetBaseVersions(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly requests: readonly { readonly target: string; readonly operation: WorkspaceMutationOperation }[];
  readonly observedTargets: ReadonlySet<string>;
}): Promise<{ readonly ok: true; readonly baseVersions: Record<string, string | null> } | { readonly ok: false; readonly message: string }> {
  const baseVersions: Record<string, string | null> = {};
  for (const request of input.requests) {
    if (request.operation === "create") {
      const availability = await probeSubagentDiskAvailability(input.ports, request.target);
      if (availability === "exists") {
        return {
          ok: false,
          message: `CHILD_MUTATION_REJECTED: create target already exists on disk: ${request.target}.`,
        };
      }
      baseVersions[request.target] = null;
      continue;
    }
    const observed = [...input.observedTargets].some((item) =>
      runtimeV2SubagentPathsOverlap(item, request.target),
    );
    if (!observed) {
      return {
        ok: false,
        message: `CHILD_MUTATION_REJECTED: read the exact current source for every ${request.operation} target before staging (${request.target}).`,
      };
    }
    try {
      baseVersions[request.target] = sha256Hex(
        await readRawSubagentWorkspaceFile(input.ports, request.target),
      );
    } catch (error) {
      return {
        ok: false,
        message: `CHILD_MUTATION_REJECTED: cannot read ${request.operation} target ${request.target}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true, baseVersions };
}

export function upsertStagedChildMutation(
  stagedMutations: RuntimeV2StagedChildMutation[],
  next: RuntimeV2StagedChildMutation,
): { readonly ok: true; readonly replacedEvidenceId?: string } | { readonly ok: false; readonly message: string } {
  const overlappingIndices: number[] = [];
  for (let i = 0; i < stagedMutations.length; i += 1) {
    const existing = stagedMutations[i]!;
    if (
      existing.targets.some((a) =>
        next.targets.some((b) => runtimeV2SubagentPathsOverlap(a, b)),
      )
    ) {
      overlappingIndices.push(i);
    }
  }
  if (overlappingIndices.length === 0) {
    stagedMutations.push(next);
    return { ok: true };
  }
  if (overlappingIndices.length === 1) {
    const existing = stagedMutations[overlappingIndices[0]!]!;
    const sameTargetSet =
      existing.targets.length === next.targets.length &&
      existing.targets.every((a) => next.targets.some((b) => runtimeV2SubagentPathsOverlap(a, b)));
    if (sameTargetSet) {
      stagedMutations[overlappingIndices[0]!] = next;
      return { ok: true, replacedEvidenceId: existing.evidenceId };
    }
  }
  return {
    ok: false,
    message: `CHILD_MUTATION_REJECTED: targets (${next.targets.join(", ")}) conflict with another staged mutation in the same child batch.`,
  };
}

export function allAllowedTargetsStaged(
  allowedPaths: readonly string[],
  stagedMutations: readonly RuntimeV2StagedChildMutation[],
): boolean {
  if (allowedPaths.length === 0 || stagedMutations.length === 0) return false;
  return allowedPaths.every((allowed) =>
    stagedMutations.some((staged) =>
      staged.targets.some((target) => runtimeV2SubagentPathsOverlap(allowed, target)),
    ),
  );
}

/** Two-phase atomic batch commit for 1+ staged mutations from an `implement` child.
 * Phase 1 validates authority, scope, permissions, preflight, and live disk versions
 * across the entire batch before Phase 2 writes any target to disk. */
export async function commitRuntimeV2StagedBatch(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly parentCommand: RuntimeV2Command;
  readonly job: RuntimeV2SubagentJob;
  readonly stagedList: readonly RuntimeV2StagedChildMutation[];
  readonly signal?: AbortSignal;
  readonly authorizeStaged: (opts: {
    readonly ports: RuntimeV2ExecutionPortsInput;
    readonly command: RuntimeV2Command;
    readonly staged: RuntimeV2StagedChildMutation;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly allowed: boolean; readonly message: string }>;
  readonly runPreflight: (opts: {
    readonly ports: RuntimeV2ExecutionPortsInput;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
    readonly baseVersions: Record<string, string | null>;
  }) => Promise<{ readonly ok: boolean; readonly message: string; readonly writeFileTarget?: WorkspaceWriteFileTargetFact }>;
}): Promise<BatchCommitResult> {
  if (input.signal?.aborted) {
    return { committed: false, message: "parent Run was canceled before child commit", evidence: [] };
  }
  if (input.stagedList.length === 0) {
    return { committed: false, message: "no staged mutations to commit", evidence: [] };
  }
  const seenTargets: string[] = [];
  const aggregate = typeof aggregateForCurrentTurn === "function"
    ? aggregateForCurrentTurn(input.ports)
    : null;
  const approved = typeof approvedPlanForCurrentTurn === "function"
    ? approvedPlanForCurrentTurn(input.ports)
    : null;
  const workspace = input.ports.context?.runWorkspace || aggregate?.turn.workspaceKey || "";
  const activeChildJobs = aggregate?.subagents || [];
  const prepared: PreparedSubagentStagedCommit[] = [];

  for (const staged of input.stagedList) {
    if (!runtimeV2JobOwnsMutationTargets({ job: input.job, targets: staged.targets })) {
      return { committed: false, message: "write scope ownership is invalid", evidence: [] };
    }
    for (const target of staged.targets) {
      if (seenTargets.some((prev) => runtimeV2SubagentPathsOverlap(prev, target))) {
        return {
          committed: false,
          message: `duplicate target within child batch: ${target}`,
          evidence: [],
        };
      }
      seenTargets.push(target);
    }

    const reqCheck = resolveJobMatchingTargetRequests({
      job: input.job,
      toolName: staged.toolName,
      args: staged.arguments,
      fallbackTarget: staged.targets[0] || "",
    });
    if (!reqCheck.ok) {
      return { committed: false, message: reqCheck.message, evidence: [] };
    }

    const authDecision = authorizeRuntimeV2WriteDelegation({
      aggregate,
      approved,
      workspace,
      taskKind: input.job.taskKind || "implement",
      accessMode: input.job.accessMode || "write",
      implementationOperation: input.job.implementationOperation,
      allowedPaths: staged.targets,
      activeChildJobs,
      excludeJobId: input.job.id,
      skipSourceCoverageCheck: true,
      directExecuteScope: directExecuteScopeForSubagent(input.ports, staged.targets),
    });
    if (!authDecision.allowed) {
      return { committed: false, message: authDecision.message, evidence: [] };
    }

    for (const target of staged.targets) {
      if (!(target in staged.baseVersions)) {
        return {
          committed: false,
          message: `missing base version snapshot for ${target}`,
          evidence: [],
        };
      }
      const expected = staged.baseVersions[target];
      if (expected === null) {
        const disk = await probeSubagentDiskAvailability(input.ports, target);
        if (disk !== "absent") {
          return {
            committed: false,
            message: `target was created externally before child join; preserving external file: ${target}`,
            evidence: [],
          };
        }
      } else {
        try {
          const current = sha256Hex(await readRawSubagentWorkspaceFile(input.ports, target));
          if (current !== expected) {
            return {
              committed: false,
              message: `source version changed externally before child join; preserving external file: ${target}`,
              evidence: [],
            };
          }
        } catch {
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
      idempotencyKey: `${input.parentCommand.idempotencyKey}:child-mutation:${input.job.id}:${staged.evidenceId}`,
      kind: "execute_tool",
      payload: {
        toolCallId: staged.id,
        toolName: staged.toolName,
        arguments: { ...staged.arguments },
        childJobId: input.job.id,
        childTransaction: true,
      },
    };
    const permission = await input.authorizeStaged({
      ports: input.ports,
      command: syntheticCommand,
      staged,
      signal: input.signal,
    });
    if (!permission.allowed) {
      return { committed: false, message: permission.message, evidence: [] };
    }
    const freshVersions: Record<string, string | null> = {};
    const preflight = await input.runPreflight({
      ports: input.ports,
      toolName: staged.toolName,
      args: { ...staged.arguments },
      baseVersions: freshVersions,
    });
    if (!preflight.ok) {
      return { committed: false, message: preflight.message, evidence: [] };
    }
    prepared.push({ staged, writeFileTarget: preflight.writeFileTarget });
  }

  if (input.signal?.aborted) {
    return { committed: false, message: "parent Run was canceled before child commit", evidence: [] };
  }

  const evidence: RuntimeV2EvidenceReference[] = [];
  for (const { staged, writeFileTarget } of prepared) {
    await executeTool(
      staged.toolName,
      runtimeV2ContextBoundToolArguments(
        staged.toolName,
        { ...staged.arguments },
        input.ports.context.runtimeContextBudget,
      ),
      input.ports.context.runWorkspace || "",
      input.ports.context.runSessionKey,
      {
        toolCatalog: authorizationFor(input.ports).toolCatalog,
        skillCatalog: input.ports.context.skillCatalog,
        writeFileTarget,
      },
    );
    for (const [index, target] of staged.targets.entries()) {
      let version: string | null = null;
      try {
        version = sha256Hex(await readRawSubagentWorkspaceFile(input.ports, target));
      } catch {
        version = `deleted:${staged.baseVersions[target] || "unknown"}`;
      }
      evidence.push({
        id: index === 0 ? staged.evidenceId : `${staged.evidenceId}:${index + 1}`,
        kind: "mutation",
        target,
        version,
        previousVersion: staged.baseVersions[target] ?? "deleted",
      });
    }
    input.ports.logStoreEvent("runtime_v2_subagent_mutation_committed", {
      turnId: input.parentCommand.run.turnId,
      runId: input.parentCommand.run.runId,
      childRunId: input.job.run.runId,
      jobId: input.job.id,
      operation: input.job.implementationOperation,
      toolName: staged.toolName,
      targets: staged.targets,
      evidenceIds: evidence.map((item) => item.id),
    });
  }

  input.ports.live.hasExecutedMutationEffect = true;
  input.ports.live.mutationSourceCoverageByToolCallId.clear();
  input.ports.live.latestProviderRequestSourceCoverage = [];
  return {
    committed: true,
    message: `Committed child transaction for ${seenTargets.join(", ")}.`,
    evidence,
  };
}
