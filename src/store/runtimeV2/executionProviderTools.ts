import type { ToolDefinition } from "../../lib/toolSchemas";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import {
  deriveRuntimeV2PlanSourceFreshness,
  RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS,
  type TurnAggregateV1,
  type RuntimeV2Command,
} from "../../lib/runtime-v2";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import {
  isRuntimeV2WorkspaceReadToolName,
  RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES,
  RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  aggregateForCurrentTurn,
  approvedPlanForCurrentTurn,
} from "./executionAggregate";
import {
  allowsRuntimeV2CorrectiveClarifyingRead,
  constrainRuntimeV2MutationTools,
  runtimeV2MutationLease,
} from "./correctiveMutationPolicy";
import {
  RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
} from "./executionToolDefinitions";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import { selectRuntimeV2ExecuteToolDefinitions } from "./providerToolSurface";

export function hasRuntimeV2ContractSourceCoverage(
  aggregate: TurnAggregateV1 | null,
): boolean {
  if (!aggregate?.executionContract || aggregate.phase !== "acting") {
    return false;
  }
  let boundary = 0;
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (
      (event.type === "phase.changed" && event.phase === "acting") ||
      (event.type === "run.started" && event.phase === "acting")
    ) {
      boundary = index + 1;
      break;
    }
  }
  const sourceTargets = aggregate.events.slice(boundary).flatMap((event) =>
    event.type === "tool.completed" && event.status === "succeeded"
      ? event.evidence.filter((evidence) =>
          evidence.kind === "source" && !!evidence.version
        ).map((evidence) => evidence.target)
      : []
  );
  return aggregate.executionContract.changes.every((change) =>
    change.operation === "create" ||
    sourceTargets.some((target) =>
      workspacePathsReferToSameFile(target, change.target)
    )
  );
}

export function forcedRuntimeV2MutationToolName(
  command: RuntimeV2Command,
  allowedToolNames: readonly string[],
  aggregate: TurnAggregateV1 | null = null,
): string | null {
  if (command.payload.mutationProgressionRequired !== true) return null;
  const availableEditors = [
    "replace_in_file",
    "apply_patch",
    "write_file",
  ].filter((name) => allowedToolNames.includes(name));
  if (availableEditors.length <= 1 || !aggregate) {
    return availableEditors[0] || null;
  }

  // A progression signal should force a mutation class, not pin every retry
  // to the first editor forever. Rotate away from the most recently failed
  // editor while retaining the full authorized mutation surface. A committed
  // mutation is the reset boundary, so later targets may use the first editor
  // normally.
  let latestFailedEditor: string | null = null;
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.evidence.some((evidence) => evidence.kind === "mutation")
    ) {
      break;
    }
    if (
      event.type === "tool.completed" &&
      event.status !== "succeeded" &&
      event.presentation &&
      availableEditors.includes(event.presentation.toolName)
    ) {
      latestFailedEditor = event.presentation.toolName;
      break;
    }
  }
  return availableEditors.find((name) => name !== latestFailedEditor) ||
    availableEditors[0] ||
    null;
}

export function runtimeV2ProviderAttemptTools(
  tools: readonly ToolDefinition[],
  forcedMutationToolName: string | null,
): ToolDefinition[] {
  return forcedMutationToolName
    ? tools.filter((tool) =>
        tool.function.name === forcedMutationToolName
      )
    : [...tools];
}

export function runtimeV2RequiredSourceToolDefinitions(
  tools: readonly ToolDefinition[],
  target: string,
): ToolDefinition[] {
  return tools
    .filter((tool) => tool.function.name === "read_file")
    .map((tool) => {
      const path = tool.function.parameters.properties.path;
      return {
        ...tool,
        function: {
          ...tool.function,
          description: [
            tool.function.description,
            `Read exactly ${target}; this source receipt is required before the next contracted mutation.`,
          ].join(" "),
          parameters: {
            ...tool.function.parameters,
            properties: {
              ...tool.function.parameters.properties,
              path: {
                ...path,
                type: "string",
                enum: [target],
                description: `Exact required source target: ${target}`,
              },
            },
          },
        },
      };
    });
}

export function runtimeV2SubagentStartHasRunway(input: {
  readonly now: number;
  readonly lifecycleDeadlineAt?: number;
}): boolean {
  const deadlineAt = input.lifecycleDeadlineAt;
  return deadlineAt === undefined ||
    !Number.isFinite(deadlineAt) ||
    deadlineAt - input.now >=
      RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS;
}

/** Select the provider-visible surface from capability, lifecycle and durable
 * authority. Authorization of an actual call remains a separate effect-boundary
 * check. */
export function selectRuntimeV2ProviderToolDefinitions(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly available: readonly ToolDefinition[];
}): ToolDefinition[] {
  const available = [...input.available];
  const command = input.command;
  const mode = String(command.payload.mode || "").trim();
  const collaborationAllowed =
    command.payload.collaborationAllowed !== false;
  const subagentStartHasRunway = runtimeV2SubagentStartHasRunway({
    now:
      typeof input.ports.now === "function"
        ? input.ports.now()
        : Date.now(),
    lifecycleDeadlineAt: input.ports.lifecycleDeadlineAt,
  });
  const activeSubagents = Array.isArray(command.payload.activeSubagents)
    ? command.payload.activeSubagents
    : [];
  const remainingSubagentCapacity = Math.max(
    0,
    Number(command.payload.remainingSubagentCapacity) || 0,
  );
  const collaborationNames = new Set<string>();
  if (
    collaborationAllowed &&
    remainingSubagentCapacity > 0 &&
    subagentStartHasRunway
  ) {
    collaborationNames.add("spawn_subagent");
  }
  if (collaborationAllowed && activeSubagents.length > 0) {
    collaborationNames.add("wait_subagents");
  }
  if (mode === "conclude") {
    return available.filter((definition) =>
      collaborationNames.has(definition.function.name)
    );
  }
  if (mode === "analyze") {
    return available.filter((definition) =>
      isRuntimeV2WorkspaceReadToolName(definition.function.name) ||
      collaborationNames.has(definition.function.name)
    );
  }
  if (mode === "validate") {
    const approved = approvedPlanForCurrentTurn(input.ports);
    const allowed = approved
      ? new Set(approved.plan.draft.validations.flatMap((validation) => {
          if (validation.kind === "finite_command") return ["run_command"];
          if (validation.kind === "browser") return ["browser_evaluate"];
          if (validation.kind === "desktop") return ["computer_use"];
          return [];
        }))
      : new Set(
          aggregateForCurrentTurn(input.ports)?.executionContract?.validations
            .flatMap((validation) => {
              if (validation.kind === "finite_command") {
                return ["run_command"];
              }
              if (validation.kind === "browser") {
                return ["browser_evaluate"];
              }
              if (validation.kind === "desktop") {
                return ["computer_use"];
              }
              return [];
            }) || [],
        );
    const parentTakeoverReadRequired =
      command.payload.validationParentTakeoverReadRequired === true;
    const selected = available.filter((definition) =>
      allowed.has(definition.function.name) ||
      (
        parentTakeoverReadRequired &&
        isRuntimeV2WorkspaceReadToolName(definition.function.name)
      ) ||
      collaborationNames.has(definition.function.name)
    );
    const retryTarget = String(
      command.payload.validationRetryTarget || "",
    ).trim();
    if (!retryTarget) return selected;
    return selected.map((definition) => {
      if (definition.function.name !== "browser_evaluate") {
        return definition;
      }
      const url = definition.function.parameters.properties.url;
      return {
        ...definition,
        function: {
          ...definition.function,
          description: [
            definition.function.description,
            `Reuse the last authorized validation target exactly: ${retryTarget}`,
          ].join(" "),
          parameters: {
            ...definition.function.parameters,
            properties: {
              ...definition.function.parameters.properties,
              url: {
                ...url,
                type: "string",
                enum: [retryTarget],
                description:
                  `Exact previously authorized validation target: ${retryTarget}`,
              },
            },
          },
        },
      };
    });
  }
  if (mode === "execute") {
    const aggregate = aggregateForCurrentTurn(input.ports);
    const requiredMutationSourceTarget =
      String(command.payload.requiredMutationSourceTarget || "").trim();
    if (requiredMutationSourceTarget) {
      return runtimeV2RequiredSourceToolDefinitions(
        available,
        requiredMutationSourceTarget,
      );
    }
    const requiresMutation =
      command.payload.executePolicy === "mutation_required";
    const requiresSourceReorientation =
      command.payload.executePolicy === "source_reorientation_required";
    const requiresInitialSourceGap =
      command.payload.executePolicy === "source_gap_allowed";
    const approvedPlanNeedsFreshReads =
      aggregate?.strategy === "plan" &&
      aggregate.workPlan?.status === "approved" &&
      !aggregate.evidence.some((evidence) =>
        evidence.kind === "mutation"
      ) &&
      deriveRuntimeV2PlanSourceFreshness(aggregate)?.allFresh === false;
    const selected = selectRuntimeV2ExecuteToolDefinitions({
      available,
      sourceToolNames: RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES,
      isMutationToolName: isWorkspaceMutationToolName,
      createOnlyMutationToolNames: new Set(["write_file"]),
      requiresFreshSourceReads:
        approvedPlanNeedsFreshReads ||
        requiresSourceReorientation ||
        requiresInitialSourceGap,
      requiresMutation,
    });
    const selectedWithLifecycleTools = [
      ...selected,
      ...available.filter((definition) =>
        collaborationNames.has(definition.function.name) ||
        (
          aggregate?.strategy === "execute" &&
          definition.function.name ===
            RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
        )
      ),
    ].filter((definition, index, definitions) =>
      definitions.findIndex((candidate) =>
        candidate.function.name === definition.function.name
      ) === index
    );
    const contractSourceScopeReady =
      aggregate?.strategy === "execute" &&
      hasRuntimeV2ContractSourceCoverage(aggregate);
    const selectedForLease = requiresMutation && contractSourceScopeReady
      ? selectedWithLifecycleTools.filter((definition) =>
          definition.function.name === "read_file" ||
          isWorkspaceMutationToolName(definition.function.name) ||
          collaborationNames.has(definition.function.name) ||
          definition.function.name ===
            RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
        )
      : selectedWithLifecycleTools;
    if (!requiresMutation) return selectedWithLifecycleTools;
    const lease = runtimeV2MutationLease(input.ports);
    if (!lease) {
      return aggregate?.strategy === "plan"
        ? selectedForLease
        : selectedForLease.filter((definition) =>
            !isWorkspaceMutationToolName(definition.function.name)
          );
    }
    const allowClarifyingRead =
      lease.authority === "acceptance_failure" &&
      allowsRuntimeV2CorrectiveClarifyingRead(aggregate);
    const correctiveSurface = allowClarifyingRead
      ? [
          ...selectedForLease,
          ...available.filter((definition) =>
            definition.function.name === "read_file"
          ),
        ]
      : selectedForLease;
    const constrained = constrainRuntimeV2MutationTools(
      correctiveSurface,
      lease,
    );
    return constrained;
  }
  if (mode === "observe") {
    const aggregate = aggregateForCurrentTurn(input.ports);
    const requiredContractSourceTarget = String(
      command.payload.requiredExecutionContractSourceTarget || "",
    ).trim();
    if (requiredContractSourceTarget) {
      return runtimeV2RequiredSourceToolDefinitions(
        available,
        requiredContractSourceTarget,
      );
    }
    if (
      command.payload.observationPolicy ===
        "execution_contract_required"
    ) {
      return available.filter((definition) =>
        definition.function.name ===
          RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME ||
        (
          definition.function.name === "wait_subagents" &&
          activeSubagents.length > 0
        )
      );
    }
    return available.filter((definition) =>
      RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(
        definition.function.name,
      ) ||
      RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(
        definition.function.name,
      ) ||
      collaborationNames.has(definition.function.name) ||
      (
        aggregate?.strategy === "execute" &&
        definition.function.name ===
          RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
      )
    );
  }
  return available.filter((definition) =>
    isWorkspaceMutationToolName(definition.function.name) ||
    RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(definition.function.name)
  );
}

export function buildRuntimeV2TextEnvelopeCatalog(
  tools: readonly ToolDefinition[],
): string {
  const entries = tools.map((definition) => ({
    name: definition.function.name,
    required: definition.function.parameters.required,
    properties: Object.fromEntries(
      Object.entries(definition.function.parameters.properties).map(
        ([name, schema]) => [
          name,
          {
            type: schema.type,
            ...(schema.enum ? { enum: schema.enum } : {}),
          },
        ],
      ),
    ),
  }));
  return [
    "[runtime-v2 allowed tool catalog]",
    JSON.stringify(entries),
  ].join("\n").slice(0, 12_000);
}
