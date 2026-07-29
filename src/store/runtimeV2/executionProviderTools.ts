import type { ToolDefinition } from "../../lib/toolSchemas";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import {
  RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS,
  type RuntimeV2Command,
} from "../../lib/runtime-v2";
import {
  RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES,
  RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

const VALIDATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "computer_use",
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
  if (mode === "conclude") {
    return input.available.filter((definition) =>
      definition.function.name === "wait_subagents" &&
      collaboration.has("wait_subagents")
    );
  }
  if (mode === "analyze") {
    return input.available.filter((definition) => {
      const name = definition.function.name;
      return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
        RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
        collaboration.has(name);
    });
  }
  return input.available.filter((definition) => {
    const name = definition.function.name;
    return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
      RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
      isWorkspaceMutationToolName(name) ||
      VALIDATION_TOOL_NAMES.has(name) ||
      collaboration.has(name);
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
