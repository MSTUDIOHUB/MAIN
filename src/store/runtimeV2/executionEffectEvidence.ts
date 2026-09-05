import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { RUNTIME_V2_SOURCE_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  isRuntimeV2EffectRisk,
  runtimeV2CatalogToolSource,
  runtimeV2ToolRiskForCall,
} from "./executionAuthorizationContext";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export function runtimeV2ToolEvidenceProjection(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): {
  readonly targets: readonly string[];
  readonly kind: "source" | "mutation" | "tool";
} {
  const workspaceMutation = isWorkspaceMutationToolName(input.toolName);
  const catalogEffect = runtimeV2ToolCallIsMcpEffect(
    input.ports,
    input.toolName,
    input.args,
  );
  return {
    targets: workspaceMutation
      ? resolveWorkspaceMutationTargets(
          input.toolName,
          input.args,
          input.target,
        )
      : [input.target || input.toolName],
    kind: workspaceMutation || catalogEffect
      ? "mutation"
      : RUNTIME_V2_SOURCE_READ_TOOL_NAMES.has(input.toolName)
        ? "source"
        : "tool",
  };
}

function runtimeV2ToolCallIsMcpEffect(
  ports: RuntimeV2ExecutionPortsInput,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const authorization = ports.live.authorization;
  return !!authorization &&
    runtimeV2CatalogToolSource(authorization, toolName) === "mcp" &&
    isRuntimeV2EffectRisk(runtimeV2ToolRiskForCall(
      authorization,
      toolName,
      args,
      { workspace: ports.context.runWorkspace },
    ));
}

export function recordRuntimeV2CommittedToolEffect(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly status: "succeeded" | "failed" | "blocked";
}): boolean {
  const workspaceMutation = isWorkspaceMutationToolName(input.toolName);
  const committed = input.status === "succeeded" && (
    workspaceMutation ||
    runtimeV2ToolCallIsMcpEffect(input.ports, input.toolName, input.args)
  );
  if (!committed) return false;
  input.ports.live.hasExecutedMutationEffect = true;
  input.ports.live.correctiveValidationCommand = null;
  if (workspaceMutation) {
    input.ports.live.mutationSourceCoverageByToolCallId.clear();
    input.ports.live.latestProviderRequestSourceCoverage = [];
  }
  return true;
}

const BUILT_IN_STRUCTURED_VALIDATORS = new Set([
  "run_command",
  "browser_evaluate",
  "computer_use",
]);

/** MCP completion is an effect receipt. It cannot become acceptance evidence
 * until Runtime owns an explicit structured validator contract for its source. */
export function runtimeV2ToolHasStructuredValidatorContract(
  ports: RuntimeV2ExecutionPortsInput,
  toolName: string,
): boolean {
  const authorization = ports.live.authorization;
  if (!authorization) return BUILT_IN_STRUCTURED_VALIDATORS.has(toolName);
  return runtimeV2CatalogToolSource(authorization, toolName) === "built_in" &&
    BUILT_IN_STRUCTURED_VALIDATORS.has(toolName);
}
