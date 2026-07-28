import type { ToolDefinition } from "../../lib/toolSchemas";
import type { TurnAggregateV1 } from "../../lib/runtime-v2";
import { resolveWorkspaceMutationTargets } from "../../lib/workspaceMutationTools";
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

function latestSuccessfulParentRead(
  input: RuntimeV2ExecutionPortsInput,
): RuntimeV2MutationLease | null {
  const workspace = input.context.runWorkspace || "";
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

/**
 * A failed editor is not retried immediately against the same source bytes.
 * Once a newer exact read arrives, the editor becomes eligible again.
 */
export function latestFailedMutationToolForLease(
  input: RuntimeV2ExecutionPortsInput,
  lease: RuntimeV2MutationLease,
): "replace_in_file" | "apply_patch" | null {
  const workspace = input.context.runWorkspace || "";
  let latestReadIndex = -1;
  for (let index = input.live.modelContext.length - 1; index >= 0; index -= 1) {
    const entry = input.live.modelContext[index]!;
    const target = normalizeRuntimeV2WorkspacePath(entry.target, workspace);
    if (
      target === lease.target &&
      entry.source === "tool" &&
      entry.label === "read_file" &&
      entry.status === "succeeded"
    ) {
      latestReadIndex = index;
      break;
    }
  }
  for (
    let index = input.live.modelContext.length - 1;
    index > latestReadIndex;
    index -= 1
  ) {
    const entry = input.live.modelContext[index]!;
    if (
      entry.source !== "tool" ||
      entry.status !== "failed" ||
      (entry.label !== "replace_in_file" && entry.label !== "apply_patch")
    ) {
      continue;
    }
    const target = normalizeRuntimeV2WorkspacePath(entry.target, workspace);
    if (target === lease.target) return entry.label;
  }
  return null;
}

export function constrainRuntimeV2MutationTools(
  definitions: readonly ToolDefinition[],
  lease: RuntimeV2MutationLease,
  allowClarifyingRead = false,
  excludedMutationTool: "replace_in_file" | "apply_patch" | null = null,
): ToolDefinition[] {
  const target = lease.target;
  return definitions
    .filter((definition) => {
      const name = definition.function.name;
      return (
        (name === "replace_in_file" || name === "apply_patch") &&
        name !== excludedMutationTool
      ) ||
        (allowClarifyingRead && name === "read_file");
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
      const path = definition.function.parameters.properties.path;
      return {
        ...definition,
        function: {
            ...definition.function,
            description: [
              definition.function.description,
              name === "read_file"
                ? `This is the final clarifying read for exactly ${target}; after it returns, submit a mutation instead of reading again.`
              : `This mutation is leased to exactly ${target}; no other file is authorized in this request.`,
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
