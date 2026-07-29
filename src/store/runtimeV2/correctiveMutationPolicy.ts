import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { extractReadFileWindowMetadata } from "../../lib/readFileWindow";
import {
  latestAcceptanceFailureSourceWindow,
  normalizeRuntimeV2WorkspacePath,
} from "./executionProviderContext";
import { aggregateForCurrentTurn } from "./executionAggregate";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export interface RuntimeV2MutationLease {
  readonly target: string;
  readonly authority: "acceptance_failure" | "fresh_parent_read";
  readonly evidenceId: string;
}

function freshSuccessfulParentReads(
  input: RuntimeV2ExecutionPortsInput,
): RuntimeV2MutationLease[] {
  const workspace = input.context.runWorkspace || "";
  const leases = new Map<string, RuntimeV2MutationLease>();
  for (const entry of input.live.modelContext) {
    if (
      entry.source === "tool" &&
      entry.status === "succeeded" &&
      isWorkspaceMutationToolName(entry.label)
    ) {
      // A committed mutation changes the source boundary. Require fresh
      // versioned reads before any subsequent direct edit.
      leases.clear();
      continue;
    }
    if (
      entry.source !== "tool" ||
      entry.label !== "read_file" ||
      entry.status !== "succeeded"
    ) {
      continue;
    }
    const target = normalizeRuntimeV2WorkspacePath(entry.target, workspace);
    if (
      !target ||
      target.startsWith("/") ||
      target.startsWith("../") ||
      target.includes(", ")
    ) {
      continue;
    }
    const version = String(
      extractReadFileWindowMetadata(entry.content)?.contentVersion || "",
    ).trim();
    if (!version) continue;
    leases.delete(target);
    leases.set(target, {
      target,
      authority: "fresh_parent_read",
      evidenceId: entry.id,
    });
  }
  return [...leases.values()];
}

/**
 * Every corrective mutation is bound to failed acceptance evidence. A direct
 * Execute turn has the same safety property for every edit: each requested
 * target must have a fresh versioned parent read. Reading another file never
 * revokes an earlier target's authority. Plan turns keep their sealed scope.
 */
export function runtimeV2MutationLeases(
  input: RuntimeV2ExecutionPortsInput,
): RuntimeV2MutationLease[] {
  if (aggregateForCurrentTurn(input)?.strategy === "plan") return [];
  const leases = new Map(
    freshSuccessfulParentReads(input).map((lease) => [
      lease.target,
      lease,
    ]),
  );
  const acceptance = latestAcceptanceFailureSourceWindow(
    input.live,
    input.context.runWorkspace || "",
  );
  if (acceptance) {
    leases.set(acceptance.path, {
      target: acceptance.path,
      authority: "acceptance_failure",
      evidenceId: acceptance.evidenceId,
    });
  }
  return [...leases.values()];
}

export function runtimeV2MutationLease(
  input: RuntimeV2ExecutionPortsInput,
): RuntimeV2MutationLease | null {
  const acceptance = latestAcceptanceFailureSourceWindow(
    input.live,
    input.context.runWorkspace || "",
  );
  if (acceptance) {
    return {
      target: acceptance.path,
      authority: "acceptance_failure",
      evidenceId: acceptance.evidenceId,
    };
  }
  const leases = runtimeV2MutationLeases(input);
  return leases[leases.length - 1] || null;
}

/** Attribute a structurally invalid editor call to its active lease only for
 * recovery bookkeeping. The original empty/malformed arguments still reach
 * authorization unchanged and therefore cannot acquire write authority. */
export function runtimeV2MutationFailureContextTarget(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolName: string;
  readonly requestedTarget: string;
}): string {
  if (input.requestedTarget) return input.requestedTarget;
  if (!isWorkspaceMutationToolName(input.toolName)) return "";
  return runtimeV2MutationLease(input.ports)?.target || "";
}

export function validateRuntimeV2MutationLease(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
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
  const leases = runtimeV2MutationLeases(input.ports);
  const aggregate = aggregateForCurrentTurn(input.ports);
  if (leases.length === 0) {
    if (!aggregate || aggregate.strategy === "plan") return null;
    return {
      allowed: false,
      lease: null,
      leases: [],
      unexpectedTargets: [],
      reasonCode: "mutation_source_lease_missing",
    };
  }
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
  const leasesByTarget = new Map(
    leases.map((lease) => [lease.target, lease]),
  );
  const unexpectedTargets = requestedTargets.filter(
    (target) => !leasesByTarget.has(target),
  );
  return {
    lease: requestedTargets
      .map((target) => leasesByTarget.get(target))
      .find(Boolean) || leases[leases.length - 1] || null,
    leases,
    unexpectedTargets,
    allowed: requestedTargets.length > 0 &&
      unexpectedTargets.length === 0,
    reasonCode: "mutation_target_lease_mismatch",
  };
}
