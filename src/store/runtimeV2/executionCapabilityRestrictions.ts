import { normalizeTurnCapabilityRestrictions, type TurnCapability } from "../../lib/turnCapabilities";
import { classifyKnownBuiltInTool, type ToolRiskLevel } from "../../lib/toolCapabilities";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import { RUNTIME_V2_SOURCE_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import { aggregateForCurrentTurn } from "./executionAggregate";

/** Replay authority wins over mutable context. Missing legacy restrictions
 * retain the prior contract; model requirements never become permissions. */
export function runtimeV2CapabilityRestrictions(input: RuntimeV2ExecutionPortsInput): readonly TurnCapability[] {
  const aggregate = aggregateForCurrentTurn(input);
  return normalizeTurnCapabilityRestrictions(aggregate
    ? aggregate.objective.capabilityRestrictions
    : input.context.capabilityRestrictions);
}

/** Reuse the catalog's risk classification. Opaque executors cannot prove
 * they will respect a narrower write/network/command restriction, so approval
 * cannot make them exceptions. Known file tools remain distinct from shell. */
export function runtimeV2ForbiddenToolCapability(input: {
  readonly restrictions: readonly TurnCapability[];
  readonly toolName: string;
  readonly risk: ToolRiskLevel | null;
  readonly source?: "built_in" | "mcp" | "skill" | null;
}): TurnCapability | null {
  const mutation = isWorkspaceMutationToolName(input.toolName);
  const opaque = !mutation && ["shell", "external_write", "browser_control", "desktop_control", "destructive"].includes(input.risk || "");
  for (const restriction of input.restrictions) {
    if (restriction === "workspace_read" && (
      RUNTIME_V2_SOURCE_READ_TOOL_NAMES.has(input.toolName) ||
      input.risk === "local_file_read" || opaque
    )) return restriction;
    if (restriction === "workspace_write" && (
      mutation || input.risk === "workspace_write" || opaque
    )) return restriction;
    if (restriction === "command" && opaque) return restriction;
    if ((restriction === "network" || restriction === "external_interaction") && (
      input.source === "mcp" || input.risk === "external_read" || opaque
    )) return restriction;
  }
  return null;
}

/** Plan's fixed built-in read surface uses the same predicate without
 * constructing another authorization registry or consulting model prose. */
export function runtimeV2BuiltinCapabilityRestriction(
  restrictions: readonly TurnCapability[], toolName: string,
): TurnCapability | null {
  return runtimeV2ForbiddenToolCapability({ restrictions, toolName, risk: classifyKnownBuiltInTool(toolName), source: "built_in" });
}
