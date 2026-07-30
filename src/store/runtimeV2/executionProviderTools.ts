import {
  READ_ONLY_SUBAGENT_ACCESS_MODES,
  READ_ONLY_SUBAGENT_TASK_KINDS,
  type ToolDefinition,
  type ToolParameterSchema,
} from "../../lib/toolSchemas";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import {
  RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS,
  type RuntimeV2Command,
  type RuntimeV2NormalizedToolCall,
} from "../../lib/runtime-v2";
import {
  RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES,
  RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES,
  RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import { normalizeToolCallForExecution } from "../../lib/toolCallNormalization";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

const VALIDATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
]);

export function runtimeV2SubagentStartHasRunway(input: {
  readonly now: number;
  readonly lifecycleDeadlineAt?: number;
}): boolean {
  const deadlineAt = input.lifecycleDeadlineAt;
  return deadlineAt === undefined ||
    !Number.isFinite(deadlineAt) ||
    deadlineAt - input.now >= RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS;
}

function collaborationToolNames(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
}): ReadonlySet<string> {
  const names = new Set<string>();
  if (input.command.payload.collaborationAllowed === false) return names;
  const active = Array.isArray(input.command.payload.activeSubagents)
    ? input.command.payload.activeSubagents
    : [];
  const remainingCapacity = Math.max(
    0,
    Number(input.command.payload.remainingSubagentCapacity) || 0,
  );
  if (
    remainingCapacity > 0 &&
    runtimeV2SubagentStartHasRunway({
      now: input.ports.now(),
      lifecycleDeadlineAt: input.ports.lifecycleDeadlineAt,
    })
  ) {
    names.add("spawn_subagent");
  }
  if (active.length > 0) names.add("wait_subagents");
  return names;
}

function runtimeV2ToolDefinition(definition: ToolDefinition): ToolDefinition {
  if (definition.function.name !== "spawn_subagent") return definition;
  const properties = definition.function.parameters.properties;
  return {
    ...definition,
    function: {
      ...definition.function,
      description:
        "Optionally delegate one independent read-only explore, review, or validate task. The parent remains the only writer and should continue unrelated work while the child runs. Delegate only when parallel work has a concrete benefit.",
      parameters: {
        ...definition.function.parameters,
        properties: {
          ...properties,
          task_kind: {
            ...properties.task_kind,
            enum: [...READ_ONLY_SUBAGENT_TASK_KINDS],
            description:
              "Optional read-only task kind. Defaults to explore.",
          },
          access_mode: {
            ...properties.access_mode,
            enum: [...READ_ONLY_SUBAGENT_ACCESS_MODES],
            description:
              "Optional and always read. Runtime v2 children never receive file-mutation authority.",
          },
          required_paths: {
            ...properties.required_paths,
            description:
              "Required narrow workspace-relative read scope, as comma-separated paths.",
          },
        },
        required: ["objective", "required_paths"],
      },
    },
  };
}

/**
 * Keep one capability surface for an Execute loop. Phases describe progress
 * to the UI; they never revoke safe reads or make a previously advertised
 * editor/validator disappear. The effect boundary remains the sole authority.
 */
export function selectRuntimeV2ProviderToolDefinitions(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly available: readonly ToolDefinition[];
}): ToolDefinition[] {
  const mode = String(input.command.payload.mode || "").trim();
  const collaboration = collaborationToolNames(input);
  const adapt = (definition: ToolDefinition) =>
    runtimeV2ToolDefinition(definition);
  if (mode === "conclude") {
    return input.available.filter((definition) =>
      definition.function.name === "wait_subagents" &&
      collaboration.has("wait_subagents")
    ).map(adapt);
  }
  if (mode === "analyze") {
    if (!String(input.ports.context.runWorkspace || "").trim()) {
      return input.available.filter((definition) =>
        RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES.has(
          definition.function.name,
        )
      ).map(adapt);
    }
    return input.available.filter((definition) => {
      const name = definition.function.name;
      return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
        RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
        collaboration.has(name);
    }).map(adapt);
  }
  return input.available.filter((definition) => {
    const name = definition.function.name;
    return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
      RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
      isWorkspaceMutationToolName(name) ||
      VALIDATION_TOOL_NAMES.has(name) ||
      collaboration.has(name);
  }).map(adapt);
}

/**
 * Tool order is request guidance, never authorization. Once the exact current
 * source is materialized and the durable ledger shows only source progress,
 * put existing mutation capabilities first while preserving the complete
 * inspect-edit-verify surface and each group's original order.
 */
export function prioritizeRuntimeV2ProviderToolDefinitions(input: {
  readonly command: RuntimeV2Command;
  readonly tools: readonly ToolDefinition[];
  readonly hasMaterializedSourceEvidence: boolean;
}): ToolDefinition[] {
  const pressure =
    input.command.payload.effectPressure &&
      typeof input.command.payload.effectPressure === "object" &&
      !Array.isArray(input.command.payload.effectPressure)
      ? input.command.payload.effectPressure as Record<string, unknown>
      : null;
  const shouldPrioritizeMutation =
    String(input.command.payload.mode || "") === "execute" &&
    input.hasMaterializedSourceEvidence &&
    pressure?.reason === "source_only_frontier";
  if (!shouldPrioritizeMutation) return [...input.tools];

  const mutationRank = (toolName: string): number => {
    if (toolName === "replace_in_file") return 0;
    if (toolName === "apply_patch") return 1;
    if (toolName === "write_file") return 2;
    return isWorkspaceMutationToolName(toolName) ? 3 : 4;
  };
  return input.tools
    .map((tool, index) => ({ tool, index }))
    .sort((left, right) => {
      const leftRank = mutationRank(left.tool.function.name);
      const rightRank = mutationRank(right.tool.function.name);
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ tool }) => tool);
}

function normalizedSchemaScalar(
  schema: ToolParameterSchema | undefined,
  value: unknown,
): unknown {
  if (!schema) return value;
  if (schema.type === "number" && typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed &&
      /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)
    ) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (schema.type === "boolean" && typeof value === "string") {
    if (value.trim().toLowerCase() === "true") return true;
    if (value.trim().toLowerCase() === "false") return false;
  }
  if (
    schema.type === "string" &&
    (typeof value === "number" || typeof value === "boolean")
  ) {
    return String(value);
  }
  if (
    schema.type === "array" &&
    Array.isArray(value) &&
    schema.items
  ) {
    return value.map((item) =>
      normalizedSchemaScalar(schema.items, item)
    );
  }
  if (
    schema.type === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    schema.properties
  ) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([key, item]) => [
          key,
          normalizedSchemaScalar(schema.properties?.[key], item),
        ],
      ),
    );
  }
  return value;
}

/** Normalize transport-level scalar drift through the advertised schema
 * before action identity, scheduling, authorization, and execution see it. */
export function normalizeRuntimeV2ProviderToolCalls(
  calls: readonly RuntimeV2NormalizedToolCall[],
  tools: readonly ToolDefinition[],
  workspace?: string | null,
): RuntimeV2NormalizedToolCall[] {
  const schemas = new Map(
    tools.map((tool) => [
      tool.function.name,
      tool.function.parameters.properties,
    ]),
  );
  return calls.map((call) => {
    const properties = schemas.get(call.name);
    if (!properties) return call;
    const canonicalArguments = normalizeToolCallForExecution(
      call.name,
      call.arguments,
      workspace,
    );
    return {
      ...call,
      arguments: Object.fromEntries(
        Object.entries(canonicalArguments).map(([key, value]) => [
          key,
          normalizedSchemaScalar(properties[key], value),
        ]),
      ),
    };
  });
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
