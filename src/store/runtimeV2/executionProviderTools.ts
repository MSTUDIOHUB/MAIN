import { isChatContext } from "./readOnlyPolicy";
import { RUNTIME_V2_KNOWLEDGE_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import { type ToolDefinition } from "../../lib/toolSchemas";
import type { ToolCapabilityRegistry } from "../../lib/toolCapabilities";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import {
  runtimeV2SubagentStartHasRunway,
  type RuntimeV2Command,
} from "../../lib/runtime-v2";
import {
  RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES,
  RUNTIME_V2_SKILL_READ_TOOL_NAMES,
  RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES,
  RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import { filterToCoreAndUnlockedTools } from "../../lib/toolSearch";
import { aggregateForCurrentTurn } from "./executionAggregate";
import {
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
  deriveRuntimeV2ExecutionContract,
  runtimeV2ExecutionContractMutationTargets,
} from "./executionContract";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2ProviderActionWindow,
} from "./executionTypes";

const VALIDATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "computer_use",
]);

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
 * Expose the compact core and session-unlocked tools while preserving the
 * collaboration tools admitted by the Run. Discovery must not hide an enabled
 * spawn capability, and cannot override capacity or phase restrictions.
 */
export function selectRuntimeV2ProviderToolDefinitions(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly available: readonly ToolDefinition[];
  readonly capabilityRegistry?: ToolCapabilityRegistry;
  readonly actionWindow?: RuntimeV2ProviderActionWindow | null;
  readonly correctiveSourceTargets?: readonly string[];
  readonly correctiveValidationCommand?: string;
}): ToolDefinition[] {
  const mode = String(input.command.payload.mode || "").trim();
  const mcpRiskFor = (name: string) => {
    const capability = input.capabilityRegistry?.tools[name];
    return capability?.source === "mcp" && capability.enabled
      ? capability.risk
      : null;
  };
  const isMcpObservation = (name: string) => {
    const risk = mcpRiskFor(name);
    return risk === "read_only" ||
      risk === "external_read" ||
      risk === "local_file_read";
  };
  const isMcpEffect = (name: string) => {
    const risk = mcpRiskFor(name);
    return risk === "workspace_write" ||
      risk === "external_write" ||
      risk === "browser_control" ||
      risk === "desktop_control" ||
      risk === "destructive";
  };
  const collaboration = collaborationToolNames(input);
  const aggregate = typeof input.ports.get === "function"
    ? aggregateForCurrentTurn(input.ports)
    : null;
  const sessionKey = input.ports.context?.runSessionKey;
  const objectiveText = aggregate?.objective?.text || "";
  const hasWorkspace = !!String(input.ports.context.runWorkspace || "").trim();
  const globalNetworkTools = hasWorkspace ? [] :
    [...RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES].filter(name =>
      input.capabilityRegistry?.tools[name]?.enabled === true);
  const knowledgeTool = (name: string) => !!input.ports.context?.knowledgeContext?.references.length &&
    input.ports.context.knowledgeContext.state !== "stale" && input.ports.context.knowledgeContext.state !== "error" &&
    RUNTIME_V2_KNOWLEDGE_READ_TOOL_NAMES.has(name);

  if (mode === "conclude") {
    if (input.command.payload.conclusionKind === "read_only") return [];
    return input.available.filter((definition) =>
      definition.function.name === "wait_subagents" &&
      collaboration.has("wait_subagents")
    );
  }
  if (mode === "chat" || isChatContext(input.ports)) {
    return input.available.filter((definition) =>
      ["load_skill", "tool_search", "web_search", "web_fetch"].includes(
        definition.function.name,
      ) || knowledgeTool(definition.function.name)
    );
  }
  if (mode === "analyze") {
    const readCandidates = !String(input.ports.context.runWorkspace || "").trim()
      ? input.available.filter((definition) => {
          const name = definition.function.name;
          return RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES.has(name) ||
            knowledgeTool(name) ||
            RUNTIME_V2_SKILL_READ_TOOL_NAMES.has(name) ||
            RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
            isMcpObservation(name);
        })
      : input.available.filter((definition) => {
          const name = definition.function.name;
          return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
            knowledgeTool(name) ||
            RUNTIME_V2_SKILL_READ_TOOL_NAMES.has(name) ||
            RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
            isMcpObservation(name) ||
            collaboration.has(name);
        });
    return filterToCoreAndUnlockedTools(readCandidates, {
      sessionKey,
      prompt: objectiveText,
      // Runtime admission already checked collaboration, capacity and runway.
      // Tool discovery must not hide that admitted capability from this request.
      alwaysInclude: new Set([...collaboration, ...globalNetworkTools]),
    });
  }

  // Execute & Validate modes: keep a consistent, static tool surface across
  // steps so local models never lose their KV cache or get trapped in a
  // tool-confiscated recovery window.
  const executeCandidates = input.available.filter((definition) => {
    const name = definition.function.name;
    if (name === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME) {
      return true;
    }
    return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
      (!hasWorkspace && RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES.has(name)) ||
      knowledgeTool(name) ||
      RUNTIME_V2_SKILL_READ_TOOL_NAMES.has(name) ||
      RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
      isWorkspaceMutationToolName(name) ||
      VALIDATION_TOOL_NAMES.has(name) ||
      isMcpObservation(name) ||
      isMcpEffect(name) ||
      collaboration.has(name);
  });

  const selected = filterToCoreAndUnlockedTools(executeCandidates, {
    sessionKey,
    prompt: objectiveText,
    alwaysInclude: new Set([...collaboration, RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME, ...globalNetworkTools]),
  });
  const contract = deriveRuntimeV2ExecutionContract(aggregate);
  const contractMutationTargets = runtimeV2ExecutionContractMutationTargets(contract);
  return selected.filter(definition =>
    !contract || contractMutationTargets.length > 0 || !isWorkspaceMutationToolName(definition.function.name)
  ).map((definition) => {
    if (contract && isWorkspaceMutationToolName(definition.function.name) && definition.function.parameters.properties?.path) {
      return {
        ...definition,
        function: {
          ...definition.function,
          parameters: {
            ...definition.function.parameters,
            properties: {
              ...definition.function.parameters.properties,
              path: { ...definition.function.parameters.properties.path, enum: contractMutationTargets },
            },
          },
        },
      };
    }
    if (definition.function.name === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME &&
      aggregate?.objective.acceptanceEvidenceRequirements?.some(requirement =>
        requirement === "behavioral" || requirement === "interaction"
      )) {
      return {
        ...definition,
        function: {
          ...definition.function,
          description: `${definition.function.description} The admitted objective requires behavioral acceptance: build, lint, and typecheck alone are invalid.`,
          parameters: {
            ...definition.function.parameters,
            required: [...new Set([...(definition.function.parameters.required || []), "behavioral_validation"])],
          },
        },
      };
    }
    if (mode !== "validate" || definition.function.name !== "run_command") return definition;
    const sealedCommand = input.actionWindow === "validation_handoff"
      ? String(input.correctiveValidationCommand || "").trim()
      : "";
    return {
      ...definition,
      function: {
        ...definition.function,
        description: `${definition.function.description} Still-needed authorized ordinary shell actions remain available; they do not discharge file validation debt.`,
        ...(sealedCommand ? {
          parameters: {
            ...definition.function.parameters,
            properties: {
              ...definition.function.parameters.properties,
              command: {
                ...(definition.function.parameters.properties?.command || {}),
                enum: [sealedCommand],
              },
            },
          },
        } : {}),
      },
    };
  });
}

/**
 * Source-only pressure may prioritize an available mutation, but cannot revoke
 * reads or turn the observed files into mandatory mutation targets.
 */
export function prioritizeRuntimeV2ProviderToolDefinitions(input: {
  readonly command: RuntimeV2Command;
  readonly tools: readonly ToolDefinition[];
  readonly hasMaterializedSourceEvidence: boolean;
}): ToolDefinition[] {
  const pressure = input.command.payload.effectPressure as { reason?: string } | undefined;
  if (!input.hasMaterializedSourceEvidence || pressure?.reason !== "source_only_frontier") {
    return [...input.tools];
  }
  return [
    ...input.tools.filter((tool) => isWorkspaceMutationToolName(tool.function.name)),
    ...input.tools.filter((tool) => !isWorkspaceMutationToolName(tool.function.name)),
  ];
}

export {
  buildRuntimeV2TextEnvelopeCatalog,
  normalizeRuntimeV2ProviderToolCalls,
  runtimeV2ProviderToolArgumentViolation,
} from "./executionProviderToolSchema";
