import {
  BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { getFileMetadata, readFileWindow } from "../../lib/ipc";
import { getMcpToolOrigin } from "../../lib/mcpClient";
import { normalizeMcpWorkspace } from "../../lib/workspaceMcp";
import { normalizeValidationWorkspaceCwd } from "../../lib/validationContract";
import type { RuntimeV2ToolEffectKind } from "../../lib/runtime-v2";
import { RUNTIME_V2_SOURCE_READ_TOOL_NAMES, isRuntimeV2ReadOnlyToolName } from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  authorizationFor,
  isRuntimeV2ObservationRisk,
  isRuntimeV2EffectRisk,
  runtimeV2BoundEditorObservation,
  runtimeV2CatalogToolSource,
  runtimeV2ToolApprovalCapability,
  runtimeV2ToolCapabilityRestriction,
  runtimeV2ToolRiskForCall,
} from "./executionAuthorizationContext";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export async function boundUnityWorkspaceWriteVersions(ports: RuntimeV2ExecutionPortsInput, name: string, args: Record<string, unknown>, target: string) {
  const entry = authorizationFor(ports).toolCatalog.lookup(name);
  const workspace = ports.context.runWorkspace;
  const snapshot = ports.context.workspaceMcpSnapshot;
  if (!workspace || snapshot?.workspace !== normalizeMcpWorkspace(workspace) || entry.status !== "resolved" || entry.entry.source !== "mcp" ||
      !entry.entry.mcpTool || !entry.entry.serverUrl || !snapshot.unityBindings?.[entry.entry.serverUrl] ||
      getMcpToolOrigin(entry.entry.mcpTool)?.connector !== "unity" || runtimeV2ToolCapabilityRestriction(ports, "read_file") ||
      runtimeV2ToolApprovalCapability(ports, "read_file")) return;
  const paths = [...new Set(resolveWorkspaceMutationTargets(entry.entry.executionName, args, target).flatMap(value => {
    const path = normalizeValidationWorkspaceCwd(value, workspace);
    return path && /^(?:Assets|Packages)\/.+\.cs$/i.test(path) ? [path] : [];
  }))];
  if (!paths.length) return;
  const sample = async (path: string): Promise<string | null> => {
    try {
      await getFileMetadata(path, workspace);
      const file = await readFileWindow(path, workspace, 1, 1, 1, 1);
      return /^sha256-[a-f0-9]{64}$/.test(file.contentVersion) ? file.contentVersion : null;
    } catch (error) {
      return String(error instanceof Error ? error.message : error).startsWith("FILE_METADATA_NOT_FOUND:") ? "deleted" : null;
    }
  };
  const previous = await Promise.all(paths.map(sample));
  return async () => {
    const current = await Promise.all(paths.map(sample));
    return paths.flatMap((path, index) => {
      const version = current[index];
      return version && previous[index] && version !== previous[index] ? [{ target: path, version }] : [];
    });
  };
}

export function runtimeV2ToolEvidenceProjection(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly result: Record<string, unknown> | null;
}): {
  readonly targets: readonly { target: string; version?: string }[];
  readonly kind: "source" | "mutation" | "tool";
  readonly effectKind?: RuntimeV2ToolEffectKind;
  readonly operationName?: string;
} {
  const authorization = authorizationFor(input.ports);
  const tool = authorization.toolCatalog.lookup(input.toolName);
  const builtIn = tool.status === "resolved" && tool.entry.source === "built_in";
  if (builtIn && BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES.has(tool.entry.executionName) && input.result?.success === true) {
    const entries = tool.entry.executionName === "unity_create_scene"
      ? [{ path: input.result.path || input.target, version: input.result.version }]
      : input.result.mutationVersions;
    const targets = Array.isArray(entries) ? entries.flatMap(entry => {
      const target = normalizeValidationWorkspaceCwd(entry?.path, input.ports.context.runWorkspace);
      const version = entry?.version;
      return target && target !== "." && typeof version === "string" && /^(?:sha256-[a-f0-9]{64}|deleted)$/.test(version)
        ? [{ target, version }] : [];
    }) : [];
    return targets.length ? { targets, kind: "mutation", effectKind: "workspace_change" }
      : { targets: [], kind: "tool", effectKind: "observation" };
  }
  const risk = runtimeV2ToolRiskForCall(authorization, input.toolName, input.args, { workspace: input.ports.context.runWorkspace });
  const observation = runtimeV2BoundEditorObservation(input.ports, input.toolName, input.args) ||
    isRuntimeV2ObservationRisk(risk) || isRuntimeV2ReadOnlyToolName(input.toolName);
  const externalOperation = !observation && isRuntimeV2EffectRisk(risk);
  return {
    targets: [{ target: input.target || input.toolName }],
    kind: RUNTIME_V2_SOURCE_READ_TOOL_NAMES.has(input.toolName) ? "source" : "tool",
    effectKind: observation ? "observation" : externalOperation ? "external_operation" : undefined,
    ...(externalOperation && tool.status === "resolved" ? { operationName: tool.entry.executionName } : {}),
  };
}

export function recordRuntimeV2CommittedToolEffect(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly effectKind: RuntimeV2ToolEffectKind | undefined;
  readonly status: "succeeded" | "failed" | "blocked";
}): boolean {
  if (input.status !== "succeeded" || !input.effectKind || input.effectKind === "observation") return false;
  if (input.effectKind !== "workspace_change") return true;
  input.ports.live.hasExecutedMutationEffect = true;
  input.ports.live.correctiveValidationCommand = null;
  input.ports.live.mutationSourceCoverageByToolCallId.clear();
  input.ports.live.latestProviderRequestSourceCoverage = [];
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
