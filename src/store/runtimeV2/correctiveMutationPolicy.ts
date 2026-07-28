import type { ToolDefinition } from "../../lib/toolSchemas";
import type { TurnAggregateV1 } from "../../lib/runtime-v2";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import {
  isRuntimeV2WorkspaceReadToolName,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  latestAcceptanceFailureSourceWindow,
  normalizeRuntimeV2WorkspacePath,
} from "./executionProviderContext";
import { aggregateForCurrentTurn } from "./executionAggregate";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";

export interface RuntimeV2MutationLease {
  readonly target: string;
  readonly authority: "acceptance_failure" | "fresh_parent_read";
  readonly evidenceId: string;
}

export function runtimeV2ContractAllowsMutationTarget(
  aggregate: TurnAggregateV1 | null,
  target: string,
): boolean {
  const targets = aggregate?.executionContract?.changes.map(
    (change) => change.target,
  ) || [];
  return targets.length === 0 || targets.some((declared) =>
    workspacePathsReferToSameFile(declared, target)
  );
}

function latestSuccessfulParentRead(
  input: RuntimeV2ExecutionPortsInput,
): RuntimeV2MutationLease | null {
  const workspace = input.context.runWorkspace || "";
  const aggregate = aggregateForCurrentTurn(input);
  for (let index = input.live.modelContext.length - 1; index >= 0; index -= 1) {
    const entry = input.live.modelContext[index]!;
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
    if (!runtimeV2ContractAllowsMutationTarget(aggregate, target)) {
      continue;
    }
    return {
      target,
      authority: "fresh_parent_read",
      evidenceId: entry.id,
    };
  }
  return null;
}

/**
 * Every corrective mutation is bound to failed acceptance evidence. A direct
 * Execute turn has the same safety property for its first edit: the target is
 * the exact file most recently read by the parent. Plan turns keep their
 * sealed multi-file scope instead of inheriting this single-file lease.
 */
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
  if (aggregateForCurrentTurn(input)?.strategy === "plan") return null;
  return latestSuccessfulParentRead(input);
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

export function constrainRuntimeV2MutationTools(
  definitions: readonly ToolDefinition[],
  lease: RuntimeV2MutationLease,
): ToolDefinition[] {
  const target = lease.target;
  return definitions
    .filter((definition) => {
      const name = definition.function.name;
      if (isWorkspaceMutationToolName(name)) {
        return name === "replace_in_file" || name === "apply_patch";
      }
      return isRuntimeV2WorkspaceReadToolName(name) ||
        name === "spawn_subagent" ||
        name === "wait_subagents" ||
        name === "submit_execution_contract";
    })
    .map((definition) => {
      const name = definition.function.name;
      if (name === "apply_patch") {
        return {
          ...definition,
          function: {
            ...definition.function,
            description: [
              definition.function.description,
              `Every patch target in this leased action must be exactly ${target}; the executor rejects any other file.`,
            ].join(" "),
          },
        };
      }
      if (name !== "replace_in_file" && name !== "apply_patch") {
        return definition;
      }
      const path = definition.function.parameters.properties.path;
      return {
        ...definition,
        function: {
            ...definition.function,
            description: [
              definition.function.description,
              `This mutation is leased to exactly ${target}; no other file is authorized in this request.`,
            ].join(" "),
          parameters: {
            ...definition.function.parameters,
            properties: {
              ...definition.function.parameters.properties,
              path: {
                ...path,
                type: "string",
                enum: [target],
                description: `Exact leased mutation target: ${target}`,
              },
            },
          },
        },
      };
  });
}

/** The failed validator already receives one Runtime-owned exact source
 * refresh. One additional provider-requested read of that same leased target
 * is allowed for weaker models; the durable phase ledger prevents a third
 * read from reopening the loop. */
export function allowsRuntimeV2CorrectiveClarifyingRead(
  aggregate: TurnAggregateV1 | null,
): boolean {
  if (!aggregate || aggregate.phase !== "acting") return false;
  let actingBoundary = -1;
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (
      (event.type === "phase.changed" && event.phase === "acting") ||
      (event.type === "run.started" && event.phase === "acting")
    ) {
      actingBoundary = index;
      break;
    }
  }
  const successfulSourceReads = aggregate.events
    .slice(actingBoundary + 1)
    .filter((event) =>
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.evidence.length > 0 &&
      event.evidence.every((evidence) => evidence.kind === "source")
    )
    .length;
  return successfulSourceReads === 1;
}

export function validateRuntimeV2MutationLease(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): {
  readonly allowed: boolean;
  readonly lease: RuntimeV2MutationLease | null;
  readonly reasonCode:
    | "mutation_source_lease_missing"
    | "mutation_target_lease_mismatch";
} | null {
  const lease = runtimeV2MutationLease(input.ports);
  const aggregate = aggregateForCurrentTurn(input.ports);
  if (!lease) {
    if (!aggregate || aggregate.strategy === "plan") return null;
    return {
      allowed: false,
      lease: null,
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
  return {
    lease,
    allowed: requestedTargets.length > 0 &&
      requestedTargets.every((target) => target === lease.target),
    reasonCode: "mutation_target_lease_mismatch",
  };
}
