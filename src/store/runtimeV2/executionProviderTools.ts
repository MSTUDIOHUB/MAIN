import { isChatContext } from "./readOnlyPolicy";
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
 * Inspired by gg-framework / ggcoder:
 * 1. Expose the compact core toolset (read_file, write_file, replace_in_file,
 *    grep_search, glob_search, run_command, load_skill, tool_search) plus any
 *    tools unlocked via `tool_search` in the current session.
 * 2. Never mutate tool descriptions or parameter enums per step, and never
 *    confiscate core inspection/edit tools in punitive recovery windows. This
 *    keeps the `tools` prefix 100% static for local model KV Cache reuse.
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
      )
    );
  }
  if (mode === "analyze") {
    const readCandidates = !String(input.ports.context.runWorkspace || "").trim()
      ? input.available.filter((definition) => {
          const name = definition.function.name;
          return RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES.has(name) ||
            RUNTIME_V2_SKILL_READ_TOOL_NAMES.has(name) ||
            RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
            isMcpObservation(name);
        })
      : input.available.filter((definition) => {
          const name = definition.function.name;
          return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
            RUNTIME_V2_SKILL_READ_TOOL_NAMES.has(name) ||
            RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
            isMcpObservation(name) ||
            collaboration.has(name);
        });
    return filterToCoreAndUnlockedTools(readCandidates, {
      sessionKey,
      prompt: objectiveText,
      alwaysInclude: collaboration.has("wait_subagents")
        ? ["wait_subagents"]
        : [],
    });
  }

  // Execute & Validate modes: keep a consistent, static tool surface across
  // steps so local models never lose their KV cache or get trapped in a
  // tool-confiscated recovery window.
  const executeCandidates = input.available.filter((definition) => {
    const name = definition.function.name;
    if (name === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME) {
      return false;
    }
    return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
      RUNTIME_V2_SKILL_READ_TOOL_NAMES.has(name) ||
      RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
      isWorkspaceMutationToolName(name) ||
      VALIDATION_TOOL_NAMES.has(name) ||
      isMcpObservation(name) ||
      isMcpEffect(name) ||
      collaboration.has(name);
  });

  return filterToCoreAndUnlockedTools(executeCandidates, {
    sessionKey,
    prompt: objectiveText,
    alwaysInclude: collaboration.has("wait_subagents")
      ? ["wait_subagents"]
      : [],
  });
}

/**
 * Preserve canonical tool order across every step of the turn so local LLM
 * engines (Ollama / llama.cpp / LM Studio) never invalidate their prefix KV
 * cache due to tool array reordering.
 */
export function prioritizeRuntimeV2ProviderToolDefinitions(input: {
  readonly command: RuntimeV2Command;
  readonly tools: readonly ToolDefinition[];
  readonly hasMaterializedSourceEvidence: boolean;
}): ToolDefinition[] {
  return [...input.tools];
}

export {
  buildRuntimeV2TextEnvelopeCatalog,
  normalizeRuntimeV2ProviderToolCalls,
  runtimeV2ProviderToolArgumentViolation,
} from "./executionProviderToolSchema";
