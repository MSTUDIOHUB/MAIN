import { parseApplyPatch } from "../../lib/applyPatchTool";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationCreationTargets,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { normalizeRuntimeV2WorkspacePath } from "./executionProviderContext";
import { aggregateForCurrentTurn } from "./executionAggregate";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export interface RuntimeV2MutationLease {
  readonly target: string;
  readonly authority: "materialized_provider_source";
  readonly evidenceId: string;
  readonly version: string;
  readonly complete: boolean;
  readonly windows: readonly {
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
  }[];
}

/**
 * A mutation lease belongs to the exact provider response that proposed the
 * mutation. Historical model context, acceptance digests, and source that was
 * removed by final token bounding cannot manufacture write authority.
 */
export function runtimeV2MutationLeases(
  input: RuntimeV2ExecutionPortsInput,
  toolCallId: string,
): RuntimeV2MutationLease[] {
  if (aggregateForCurrentTurn(input)?.strategy === "plan") return [];
  const coverage =
    input.live.mutationSourceCoverageByToolCallId.get(toolCallId) || [];
  return coverage.map((source) => ({
    target: source.target,
    authority: "materialized_provider_source" as const,
    evidenceId:
      `provider-request-source:${toolCallId}:${source.target}:${source.version}`,
    version: source.version,
    complete: source.complete,
    windows: source.windows,
  }));
}

export function runtimeV2MutationLease(
  input: RuntimeV2ExecutionPortsInput,
  toolCallId: string,
): RuntimeV2MutationLease | null {
  const leases = runtimeV2MutationLeases(input, toolCallId);
  return leases[leases.length - 1] || null;
}

/** Attribute a structurally invalid editor call to its active lease only for
 * recovery bookkeeping. The original empty/malformed arguments still reach
 * authorization unchanged and therefore cannot acquire write authority. */
export function runtimeV2MutationFailureContextTarget(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly requestedTarget: string;
}): string {
  if (input.requestedTarget) return input.requestedTarget;
  if (!isWorkspaceMutationToolName(input.toolName)) return "";
  return runtimeV2MutationLease(input.ports, input.toolCallId)?.target || "";
}

function joinedVisibleSourceWindows(
  lease: RuntimeV2MutationLease,
): Array<{
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}> {
  const ordered = [...lease.windows].sort((left, right) =>
    left.startLine - right.startLine || left.endLine - right.endLine
  );
  const groups: Array<{
    startLine: number;
    endLine: number;
    content: string;
  }> = [];
  for (const window of ordered) {
    const previous = groups[groups.length - 1];
    if (previous && window.startLine === previous.endLine + 1) {
      previous.content += `${
        previous.content.endsWith("\n") ? "" : "\n"
      }${window.content}`;
      previous.endLine = window.endLine;
    } else {
      groups.push({
        startLine: window.startLine,
        endLine: window.endLine,
        content: window.content,
      });
    }
  }
  return groups;
}

function visibleSourceContains(
  lease: RuntimeV2MutationLease,
  value: string,
): boolean {
  if (!value) return false;
  const alternatives = value.endsWith("\n")
    ? [value, value.slice(0, -1)]
    : [value];
  return joinedVisibleSourceWindows(lease).some((source) =>
    alternatives.some((candidate) =>
      !!candidate && source.content.includes(candidate)
    )
  );
}

function leaseCoversMutation(
  toolName: string,
  args: Record<string, unknown>,
  target: string,
  lease: RuntimeV2MutationLease,
  workspace: string,
): boolean {
  if (toolName === "replace_in_file") {
    // The mutation preflight and executor both require search_text to be
    // unique in the complete current file. The lease therefore needs to prove
    // only that the exact proposed block was visible to the model; it does not
    // force an unrelated prefix read for a focused large-file correction.
    const searchText = String(
      args.search_text ?? args.old_text ?? "",
    );
    if (!searchText) return false;
    return visibleSourceContains(lease, searchText);
  }
  if (toolName === "apply_patch") {
    const parsed = parseApplyPatch(String(args.patch || ""));
    if (!parsed.ok) return false;
    const operations = parsed.operations.filter((operation) =>
      normalizeRuntimeV2WorkspacePath(operation.path, workspace) === target
    );
    if (operations.length === 0) return false;
    return operations.every((operation) => {
      if (operation.kind === "add") return true;
      if (operation.kind === "delete") return lease.complete;
      return operation.hunks.length > 0 &&
        operation.hunks.every((hunk) =>
          visibleSourceContains(lease, hunk.oldText)
        );
    });
  }
  return lease.complete;
}

export function validateRuntimeV2MutationLease(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): {
  readonly allowed: boolean;
  readonly lease: RuntimeV2MutationLease | null;
  readonly leases: readonly RuntimeV2MutationLease[];
  readonly unexpectedTargets: readonly string[];
  readonly reasonCode:
    | "mutation_source_lease_missing"
    | "mutation_target_lease_mismatch";
} | null {
  const leases = runtimeV2MutationLeases(
    input.ports,
    input.toolCallId,
  );
  const aggregate = aggregateForCurrentTurn(input.ports);
  if (aggregate?.strategy === "plan") return null;
  const workspace = input.ports.context.runWorkspace || "";
  const requestedTargets = resolveWorkspaceMutationTargets(
    input.toolName,
    input.args,
    input.target,
  ).map((target) =>
    normalizeRuntimeV2WorkspacePath(
      target,
      input.ports.context.runWorkspace || "",
    )
  );
  const creationTargets = new Set(
    resolveWorkspaceMutationCreationTargets(
      input.toolName,
      input.args,
      input.target,
    ).map((target) =>
      normalizeRuntimeV2WorkspacePath(target, workspace)
    ),
  );
  if (input.toolName === "write_file") {
    requestedTargets.forEach((target) => creationTargets.add(target));
  }
  const leasesByTarget = new Map(
    leases.map((lease) => [lease.target, lease]),
  );
  const unexpectedTargets = requestedTargets.filter(
    (target) => {
      if (creationTargets.has(target) && !leasesByTarget.has(target)) {
        return false;
      }
      const lease = leasesByTarget.get(target);
      return !lease || !leaseCoversMutation(
        input.toolName,
        input.args,
        target,
        lease,
        workspace,
      );
    },
  );
  if (
    leases.length === 0 &&
    unexpectedTargets.length > 0 &&
    !aggregate
  ) {
    return null;
  }
  return {
    lease: requestedTargets
      .map((target) => leasesByTarget.get(target))
      .find(Boolean) || leases[leases.length - 1] || null,
    leases,
    unexpectedTargets,
    allowed: requestedTargets.length > 0 &&
      unexpectedTargets.length === 0,
    reasonCode: leases.length === 0
      ? "mutation_source_lease_missing"
      : "mutation_target_lease_mismatch",
  };
}
