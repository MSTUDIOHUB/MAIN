import {
  filterGlobalChatToolDefinitions,
  logAgentEvent,
} from "../../orchestrator";
import type { ResolvedUserIntent } from "../../runIntent";
import {
  filterToolDefinitionsForIntent,
  type ToolCapabilityRegistry,
} from "../../toolCapabilities";
import type { ToolDefinition } from "../../toolSchemas";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { OrchestratorCallbacks } from "../types";
import type { AgentLoopRuntimeState } from "./turnPreparation";
import {
  activateUnityMcpFallbackState,
  resolveUnityMcpFirstPhaseTools,
  type UnityMcpRuntimeState,
} from "./unityMcpRuntime";

export interface AgentLoopToolSurfaceRuntime {
  resolveRuntimeIntent: () => ResolvedUserIntent;
  activateUnityMcpFallback: (reason: string) => void;
  resolveAllToolsForRuntime: (runtimeIntent: ResolvedUserIntent) => ToolDefinition[];
}

export function createAgentLoopToolSurfaceRuntime(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  workspace: string;
  routedToolDefinitions: ToolDefinition[];
  toolCapabilityRegistry: ToolCapabilityRegistry;
  turnInputContextSignals: TurnInputContextSignals;
  unityCommandRequested: boolean;
  unityConsoleDiagnosticsRequested: boolean;
  effectivePreferredUnityUrls: string[];
  effectiveUnityMcpToolNameSet: Set<string>;
  getUnityMcpRuntimeState: () => UnityMcpRuntimeState;
  setUnityMcpRuntimeState: (state: UnityMcpRuntimeState) => void;
}): AgentLoopToolSurfaceRuntime {
  const {
    callbacks,
    runtimeState,
    workspace,
    routedToolDefinitions,
    toolCapabilityRegistry,
    turnInputContextSignals,
    unityCommandRequested,
    unityConsoleDiagnosticsRequested,
    effectivePreferredUnityUrls,
    effectiveUnityMcpToolNameSet,
    getUnityMcpRuntimeState,
    setUnityMcpRuntimeState,
  } = input;
  const { workflowMode } = runtimeState;

  const resolveRuntimeIntent = (): ResolvedUserIntent => {
    return callbacks.getRuntimeRunIntent?.() ?? callbacks.getCurrentRunIntent();
  };

  const activateUnityMcpFallback = (reason: string) => {
    const fallbackState = activateUnityMcpFallbackState(
      getUnityMcpRuntimeState(),
      reason,
    );
    setUnityMcpRuntimeState(fallbackState.state);
    if (!fallbackState.didActivate) return;
    logAgentEvent("unity_mcp_fallback", {
      reason,
      unityCommandRequested,
      unityConsoleDiagnosticsRequested,
      preferredServers: effectivePreferredUnityUrls,
    });
  };

  const resolveAllToolsForRuntime = (
    runtimeIntent: ResolvedUserIntent,
  ): ToolDefinition[] => {
    const intentFiltered = filterToolDefinitionsForIntent(
      routedToolDefinitions,
      runtimeIntent,
      toolCapabilityRegistry,
    );
    const filtered = filterGlobalChatToolDefinitions({
      tools: intentFiltered,
      workspace,
      userContext: turnInputContextSignals,
    });
    if (!workspace.trim() && filtered.length !== intentFiltered.length) {
      logAgentEvent("global_chat_tool_scope_applied", {
        runtimeIntent,
        workflowMode,
        explicitFileContext:
          turnInputContextSignals.mentionedFilePaths.length +
          turnInputContextSignals.attachedFilePaths.length,
        rawTools: intentFiltered
          .map((tool) => tool.function.name)
          .slice(0, 24),
        scopedTools: filtered.map((tool) => tool.function.name),
        removedToolCount: Math.max(0, intentFiltered.length - filtered.length),
      });
    }

    const unityMcpRuntimeState = getUnityMcpRuntimeState();
    const unityMcpTools = resolveUnityMcpFirstPhaseTools({
      tools: filtered,
      unityMcpFirstPhaseActive: unityMcpRuntimeState.firstPhaseActive,
      unityMcpForceConsoleFirstPending:
        unityMcpRuntimeState.forceConsoleFirstPending,
      unityMcpStrictRetryPending: unityMcpRuntimeState.strictRetryPending,
      effectiveUnityMcpToolNameSet,
    });
    if (unityMcpTools.fallbackReason) {
      activateUnityMcpFallback(unityMcpTools.fallbackReason);
    }
    return unityMcpTools.tools;
  };

  return {
    resolveRuntimeIntent,
    activateUnityMcpFallback,
    resolveAllToolsForRuntime,
  };
}
