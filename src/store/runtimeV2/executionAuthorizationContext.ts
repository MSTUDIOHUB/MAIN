import type { ToolDefinition } from "../../lib/toolSchemas";
import { getUnlockedToolsForSession } from "../../lib/toolSearch";
import { isReadOnlyContext, readOnlyNetworkPolicy } from "./readOnlyPolicy";
import { runtimeV2ApprovalRequiredCapabilities, runtimeV2CapabilityRestrictions, runtimeV2ForbiddenToolCapability } from "./executionCapabilityRestrictions";
import {
  buildToolCapabilityRegistry,
  getToolRiskLevelForCall,
  normalizeMcpRoutingConfig,
  normalizeToolPermissionPolicy,
  routeMcpToolsForPrompt,
  type ToolCallRiskContext,
  type ToolRiskLevel,
} from "../../lib/toolCapabilities";
import {
  buildToolCatalog,
  type ToolCatalogEntry,
} from "../../lib/toolCatalog";
import type { RuntimeV2Command } from "../../lib/runtime-v2";
import { aggregateForCurrentTurn } from "./executionAggregate";
import {
  deriveRuntimeV2ProviderEffectFacts,
  latestRuntimeV2CorrectiveMutationFailure,
} from "./executionProviderEffectFacts";
import { buildRuntimeV2DecisionView } from "./executionProviderDecisionView";
import {
  materializedRuntimeV2SourceCoverage,
} from "./executionProviderSourceCoverage";
import { runtimeV2ProviderActionWindowFor } from "./executionProviderActionWindow";
import { runtimeV2ToolDefinitions } from "./executionToolDefinitions";
import { builtInToolRequiresWorkspace } from "../../lib/workspaceToolScope";
import { boundUnityMcpObservation, type WorkspaceMcpSnapshot } from "../../lib/workspaceMcp";
import {
  buildRuntimeV2TextEnvelopeCatalog,
  selectRuntimeV2ProviderToolDefinitions,
} from "./executionProviderTools";
import type {
  RuntimeV2ExecutionAuthorization,
  RuntimeV2ExecutionPortsInput,
} from "./executionTypes";
import { preferredFiniteValidationCommand } from "./executionProviderContext";
import {
  deriveRuntimeV2ExecutionContractAdvance,
} from "./executionContractAdvance";
import {
  deriveRuntimeV2ValidationCorrectionWindow,
} from "./executionValidationCorrection";

export const RUNTIME_V2_VALIDATION_TOOL_NAMES = new Set([
  "run_command", "browser_evaluate", "computer_use",
]);

export interface RuntimeV2ToolAuthorizationResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly allowExternalLocalRead: boolean;
  readonly shellPermissionApproval?: import("../../lib/ipc").ShellPermissionApproval;
  readonly shellPermissionDecision?: import("../../lib/ipc").ShellPermissionDecision;
  readonly approvalRequired?: boolean;
  readonly approvalRequiredCapability?: import("../../lib/turnCapabilities").TurnCapability;
  readonly risk?: ToolRiskLevel;
  readonly localFileReadPath?: string;
}

function resolvedRuntimeV2CatalogEntry(
  authorization: RuntimeV2ExecutionAuthorization,
  name: string,
): ToolCatalogEntry | null {
  const resolution = authorization.toolCatalog.lookup(name);
  return resolution.status === "resolved" ? resolution.entry : null;
}

export function runtimeV2BoundEditorObservation(input: RuntimeV2ExecutionPortsInput, name: string, args: Readonly<Record<string, unknown>>) {
  const entry = resolvedRuntimeV2CatalogEntry(authorizationFor(input), name);
  return entry ? boundUnityMcpObservation(input.context.workspaceMcpSnapshot, input.context.runWorkspace, entry, args) : null;
}

export function runtimeV2CatalogToolSource(
  authorization: RuntimeV2ExecutionAuthorization,
  name: string,
): ToolCatalogEntry["source"] | null {
  return resolvedRuntimeV2CatalogEntry(authorization, name)?.source || null;
}

export function runtimeV2ToolRiskForCall(
  authorization: RuntimeV2ExecutionAuthorization,
  name: string,
  args: Record<string, unknown> = {},
  context: ToolCallRiskContext & { readonly workspaceMcpSnapshot?: WorkspaceMcpSnapshot | null } = {},
): ToolRiskLevel | null {
  const entry = resolvedRuntimeV2CatalogEntry(authorization, name);
  if (!entry || entry.source === "skill") return null;
  if (boundUnityMcpObservation(context.workspaceMcpSnapshot, context.workspace ?? undefined, entry, args)) return "external_read";
  return getToolRiskLevelForCall(
    entry.exposedName,
    args,
    authorization.capabilityRegistry,
    context,
  );
}

export function isRuntimeV2ObservationRisk(
  risk: ToolRiskLevel | null | undefined,
): boolean {
  return risk === "read_only" ||
    risk === "external_read" ||
    risk === "local_file_read";
}

export function isRuntimeV2EffectRisk(
  risk: ToolRiskLevel | null | undefined,
): boolean {
  return risk === "workspace_write" ||
    risk === "external_write" ||
    risk === "browser_control" ||
    risk === "desktop_control" ||
    risk === "destructive";
}

function promptExplicitlyNamesTool(
  prompt: string,
  entry: ToolCatalogEntry,
): boolean {
  const text = String(prompt || "");
  if (!text) return false;
  return [entry.exposedName, entry.canonicalName, entry.executionName]
    .filter((name) => name.length >= 3)
    .some((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i")
        .test(text);
    });
}

function mcpEntryMatchesDisabledKey(
  entry: ToolCatalogEntry,
  disabledToolKeys: readonly string[],
): boolean {
  if (entry.source !== "mcp") return false;
  const keys = [
    entry.executionName,
    entry.exposedName,
    entry.canonicalName,
    entry.mcpTool?.name,
    entry.serverName && `${entry.serverName}:${entry.executionName}`,
    entry.serverName && `${entry.serverName}:${entry.exposedName}`,
    entry.serverName && `${entry.serverName}/${entry.executionName}`,
    entry.serverUrl && `${entry.serverUrl}:${entry.executionName}`,
    entry.serverUrl && `${entry.serverUrl}#${entry.executionName}`,
  ].filter((value): value is string => !!value)
    .map((value) => value.trim().toLowerCase());
  const disabled = new Set(
    disabledToolKeys.map((value) => String(value).trim().toLowerCase()),
  );
  return keys.some((key) => disabled.has(key));
}

/** Keep the native provider schema bounded while retaining every MCP tool the
 * user named exactly. Authorization still uses the complete frozen catalog,
 * so routing is presentation-only and never grants a missing capability. */
export function runtimeV2ProviderToolDefinitionsForPrompt(
  authorization: RuntimeV2ExecutionAuthorization,
  userPrompt: string,
  sessionKey?: string,
): ToolDefinition[] {
  const mcpEntries = authorization.toolCatalog.entries.filter((entry) =>
    entry.source === "mcp" &&
    !!entry.mcpTool &&
    authorization.capabilityRegistry.tools[entry.exposedName]?.enabled === true
  );

  const servers = [...new Map(
    mcpEntries
      .filter((entry) => entry.serverUrl)
      .map((entry) => [entry.serverUrl!, {
        name: entry.serverName || "MCP",
        type: "http" as const,
        url: entry.serverUrl!,
        enabled: true,
      }]),
  ).values()];
  const routed = routeMcpToolsForPrompt({
    tools: mcpEntries.map((entry) => entry.mcpTool!),
    servers,
    toolServerMap: authorization.toolCatalog.mcpToolServerMap,
    userPrompt,
    config: authorization.mcpRouting,
  }).tools;
  const routedTools = new Set(routed);
  const explicitEntries = mcpEntries.filter((entry) =>
    promptExplicitlyNamesTool(userPrompt, entry)
  );
  const threshold = Math.max(1, authorization.mcpRouting.threshold);
  const selectedNames = new Set(
    explicitEntries.map((entry) => entry.exposedName),
  );
  for (const entry of mcpEntries) {
    if (selectedNames.size >= Math.max(threshold, explicitEntries.length)) {
      break;
    }
    if (entry.mcpTool && routedTools.has(entry.mcpTool)) {
      selectedNames.add(entry.exposedName);
    }
  }
  const unlocked = getUnlockedToolsForSession(sessionKey);
  for (const entry of mcpEntries) if (unlocked.has(entry.exposedName)) selectedNames.add(entry.exposedName);

  const available = authorization.toolDefinitions.filter((definition) => {
    const entry = resolvedRuntimeV2CatalogEntry(
      authorization,
      definition.function.name,
    );
    return entry?.source === "built_in" ||
      (entry?.source === "mcp" && selectedNames.has(entry.exposedName));
  });
  const consoleIndex = available.findIndex(definition => definition.function.name === "unity_mcp_console");
  const rawConsoleIndex = available.findIndex(definition => {
    const entry = resolvedRuntimeV2CatalogEntry(authorization, definition.function.name);
    return entry?.source === "mcp" && entry.executionName === "read_console";
  });
  if (rawConsoleIndex >= 0 && consoleIndex > rawConsoleIndex) available.splice(rawConsoleIndex, 0, ...available.splice(consoleIndex, 1));
  return available;
}

/** Freeze built-ins, discovered MCP schemas and their shared permission
 * policy for this Runtime v2 Turn. Unknown and executable Skill tools remain
 * fail-closed at this boundary. */
export function createRuntimeV2ExecutionAuthorization(
  state: any,
  skillCatalog?: import("../../lib/agentSkills").SkillCatalogSnapshot | null,
  knowledgeContext?: import("../../lib/knowledgeReferences").KnowledgeContextPacket,
  runWorkspace?: string,
): RuntimeV2ExecutionAuthorization {
  const builtInDefinitions = runtimeV2ToolDefinitions(state, skillCatalog, knowledgeContext);
  const policy = normalizeToolPermissionPolicy(
    state?.config?.toolPermissionPolicy,
  );
  const mcpTools = Array.isArray(state?.mcpDiscoveredTools)
    ? [...state.mcpDiscoveredTools]
    : [];
  const mcpServers = Array.isArray(state?.mcpServers)
    ? [...state.mcpServers]
    : [];
  const mcpToolServerMap = state?.mcpToolServerMap &&
      typeof state.mcpToolServerMap === "object"
    ? { ...state.mcpToolServerMap }
    : {};
  const completeCatalog = buildToolCatalog({
    builtInDefinitions,
    mcpTools,
    mcpServers,
    mcpToolServerMap,
  });
  // Assign MCP identities before filtering built-ins, so a remote tool cannot
  // acquire a removed built-in's bare name. The frozen Run scope owns this
  // availability view; mutable workspace selection does not supply a root.
  const unavailable = new Set(runWorkspace !== undefined && !runWorkspace.trim()
    ? completeCatalog.entries.filter(entry => entry.source === "built_in" &&
      builtInToolRequiresWorkspace(entry.executionName)).map(entry => entry.exposedName)
    : []);
  const toolCatalog = unavailable.size === 0 ? completeCatalog : {
    ...completeCatalog,
    entries: completeCatalog.entries.filter(entry => !unavailable.has(entry.exposedName)),
    toolDefinitions: completeCatalog.toolDefinitions.filter(tool => !unavailable.has(tool.function.name)),
    lookup: (name: string): ReturnType<typeof completeCatalog.lookup> => {
      const result = completeCatalog.lookup(name);
      return result.status === "resolved" && result.entry.source === "built_in" &&
          unavailable.has(result.entry.exposedName)
        ? { status: "unknown", requestedName: name } : result;
    },
  };
  const toolDefinitions = toolCatalog.toolDefinitions;
  const mcpRouting = normalizeMcpRoutingConfig(state?.config?.mcpRouting);
  const discoveredCapabilityRegistry = buildToolCapabilityRegistry({
    toolDefinitions,
    toolCatalog,
    mcpTools,
    mcpServers,
    mcpToolServerMap,
    policy,
  });
  const capabilityRegistry = {
    ...discoveredCapabilityRegistry,
    tools: Object.fromEntries(Object.entries(
      discoveredCapabilityRegistry.tools,
    ).map(([name, capability]) => {
      const resolution = toolCatalog.lookup(name);
      const disabled = resolution.status === "resolved" &&
        mcpEntryMatchesDisabledKey(
          resolution.entry,
          mcpRouting.disabledToolKeys,
        );
      return [name, disabled
        ? { ...capability, enabled: false, autoExecutable: false }
        : capability];
    })),
  };
  return {
    toolDefinitions,
    toolCatalog,
    capabilityRegistry,
    policy,
    mcpRouting,
  };
}

export function authorizationFor(
  input: RuntimeV2ExecutionPortsInput,
): RuntimeV2ExecutionAuthorization {
  if (!input.live.authorization) {
    const state = { ...input.get(), ...(input.context.workspaceMcpSnapshot || {}) };
    input.live.authorization = createRuntimeV2ExecutionAuthorization(
      { ...state, webSearchEnabled: readOnlyNetworkPolicy(input).enabled },
      input.context.skillCatalog,
      input.context.knowledgeContext,
      String(input.context.runWorkspace || ""),
    );
  }
  return input.live.authorization;
}

export function runtimeV2ToolCapabilityRestriction(
  input: RuntimeV2ExecutionPortsInput, name: string, args: Record<string, unknown> = {},
) {
  const authorization = authorizationFor(input);
  return runtimeV2ForbiddenToolCapability({
    restrictions: runtimeV2CapabilityRestrictions(input), toolName: name,
    risk: runtimeV2ToolRiskForCall(authorization, name, args, {
      workspace: input.context.runWorkspace,
      approvedLocalFileReadPaths: input.get()?.approvedLocalFileReadPaths,
      workspaceMcpSnapshot: input.context.workspaceMcpSnapshot,
    }),
    editorObservation: !!runtimeV2BoundEditorObservation(input, name, args),
    source: runtimeV2CatalogToolSource(authorization, name),
  });
}

export function runtimeV2ToolApprovalCapability(
  input: RuntimeV2ExecutionPortsInput, name: string, args: Record<string, unknown> = {},
) {
  const authorization = authorizationFor(input);
  return runtimeV2ForbiddenToolCapability({
    restrictions: runtimeV2ApprovalRequiredCapabilities(input), toolName: name,
    risk: runtimeV2ToolRiskForCall(authorization, name, args, { workspace: input.context.runWorkspace, approvedLocalFileReadPaths: input.get()?.approvedLocalFileReadPaths, workspaceMcpSnapshot: input.context.workspaceMcpSnapshot }),
    editorObservation: !!runtimeV2BoundEditorObservation(input, name, args),
    source: runtimeV2CatalogToolSource(authorization, name),
  });
}

export function filterRuntimeV2CapabilityRestrictedTools(
  input: RuntimeV2ExecutionPortsInput, tools: readonly ToolDefinition[],
): ToolDefinition[] {
  return tools.filter((tool) => !runtimeV2ToolCapabilityRestriction(input, tool.function.name));
}

export function providerToolDefinitionsForCommand(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
): ToolDefinition[] {
  const aggregate = aggregateForCurrentTurn(input);
  if (isReadOnlyContext(input)) {
    input.live.latestProviderActionWindow = null;
    const authorization = authorizationFor(input);
    const available = filterRuntimeV2CapabilityRestrictedTools(input, runtimeV2ProviderToolDefinitionsForPrompt(
      authorization, aggregate?.objective?.text || "", input.context.runSessionKey));
    return selectRuntimeV2ProviderToolDefinitions({ ports: input, command, available, capabilityRegistry: authorization.capabilityRegistry });
  }
  const effects = deriveRuntimeV2ProviderEffectFacts(aggregate);
  const executionContractAdvance =
    deriveRuntimeV2ExecutionContractAdvance(aggregate);
  const validationCorrection =
    deriveRuntimeV2ValidationCorrectionWindow(aggregate);
  // Tool selection runs before the next provider request rebuilds its final
  // decision view. Refresh this presentation-derived fact from the durable
  // transcript now so a just-completed corrective read can reopen mutation
  // immediately instead of forcing one redundant read decision.
  const currentSourceCoverage = materializedRuntimeV2SourceCoverage(
    buildRuntimeV2DecisionView(input.live.messages, effects),
    input.context.runWorkspace || "",
    effects,
  );
  input.live.latestProviderRequestSourceCoverage = currentSourceCoverage;
  const actionWindow = runtimeV2ProviderActionWindowFor({
    command,
    effects,
    sourceCoverage: currentSourceCoverage,
    workspace: input.context.runWorkspace || "",
    completedContractAwaitingValidation:
      executionContractAdvance.required &&
      executionContractAdvance.pendingTargets.length === 0,
    newerValidationFailureSequence: validationCorrection.active
      ? validationCorrection.failureSequence
      : null,
  });
  const correctiveSourceTargets = actionWindow === "corrective_source"
    ? [...new Set(
        (latestRuntimeV2CorrectiveMutationFailure(effects)?.targets || [])
          .map((target) => String(target || "").trim())
          .filter(Boolean),
      )]
    : [];
  input.live.latestProviderActionWindow = actionWindow;
  const authorization = authorizationFor(input);
  return selectRuntimeV2ProviderToolDefinitions({
    ports: input,
    command,
    available: filterRuntimeV2CapabilityRestrictedTools(input, runtimeV2ProviderToolDefinitionsForPrompt(
      authorization,
      aggregate?.objective?.text || "",
      input.context.runSessionKey,
    )),
    capabilityRegistry: authorization.capabilityRegistry,
    actionWindow,
    correctiveSourceTargets,
    correctiveValidationCommand:
      String(command.payload.mode || "").trim() === "validate"
        ? validationCorrection.validationCommandUnavailable
          ? ""
          : input.live.correctiveValidationCommand ||
            preferredFiniteValidationCommand(input)
        : "",
  });
}

export function compactTextEnvelopeCatalog(
  tools: readonly ToolDefinition[],
): string {
  return buildRuntimeV2TextEnvelopeCatalog(tools);
}
