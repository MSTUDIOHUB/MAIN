import type { AppConfig, Skill } from "../../appTypes";
import {
  discoverAllMcpTools,
  getMcpToolServerMap,
  setMcpToolServerMap,
  type MCPServer,
  type MCPServerStatusSnapshot,
  type MCPTool,
} from "../../mcpClient";
import {
  annotateUnityEditToolDescriptions,
  isGameEngineLikelyServer,
  type GameStudioEngineKey,
} from "../../orchestrator/unityDiagnostics";
import {
  KNOWLEDGE_TOOL_NAMES,
  WEB_RESEARCH_TOOL_NAMES,
  logAgentEvent,
} from "../../orchestrator";
import {
  buildToolCapabilityRegistry,
  routeMcpToolsForPrompt,
  type McpRoutingPriorityMode,
  type ToolCapabilityRegistry,
} from "../../toolCapabilities";
import { buildToolDefinitions, type ToolDefinition } from "../../toolSchemas";
import { UNITY_MCP_STRICT_RETRY_FORCED_TOOLS } from "./unityMcpRuntime";

export interface AgentLoopToolRegistryState {
  mcpTools: MCPTool[];
  mcpServerStatuses: MCPServerStatusSnapshot[];
  mcpPriorityEngine: GameStudioEngineKey | null;
  gameStudioMcpFirstEligible: boolean;
  unityMcpFirstEligible: boolean;
  effectivePreferredUnityUrls: string[];
  effectiveUnityMcpToolNameSet: Set<string>;
  routedToolDefinitions: ToolDefinition[];
  toolCapabilityRegistry: ToolCapabilityRegistry;
  webSearchEnabled: boolean;
  knowledgeToolsEnabled: boolean;
}

export async function prepareAgentLoopToolRegistry(input: {
  config: AppConfig;
  skills: Skill[];
  mcpServers: MCPServer[];
  initialMcpTools: MCPTool[];
  latestUserPromptText: string;
  gameStudioEngine: GameStudioEngineKey | null;
  gameStudioEngineContext: boolean;
  gameStudioUnityContext: boolean;
  unityCommandRequested: boolean;
  unityConsoleDiagnosticsRequested: boolean;
  unityScriptEditRequested: boolean;
  gameStudioScriptEditRequested: boolean;
  webSearchEnabled: boolean;
  enabledKnowledgeBaseIds: string[];
}): Promise<AgentLoopToolRegistryState> {
  const {
    config,
    skills,
    mcpServers,
    initialMcpTools,
    latestUserPromptText,
    gameStudioEngine,
    gameStudioEngineContext,
    gameStudioUnityContext,
    unityCommandRequested,
    unityConsoleDiagnosticsRequested,
    unityScriptEditRequested,
    gameStudioScriptEditRequested,
    webSearchEnabled,
    enabledKnowledgeBaseIds,
  } = input;

  const enabledMcpServers = mcpServers.filter((server) => server.enabled !== false);
  let mcpTools = initialMcpTools;
  let mcpToolServerMap = getMcpToolServerMap();
  let mcpServerStatuses: MCPServerStatusSnapshot[] = mcpServers.map((server) => ({
    serverName: server.name,
    url: server.url,
    enabled: server.enabled !== false,
    status: server.enabled === false ? "disabled" : "failed",
    toolCount: 0,
    category: server.enabled === false ? "ok" : "invalid_response",
    message: server.enabled === false
      ? "Server is disabled in settings."
      : "Server status is unknown until discovery runs.",
  }));

  if (mcpServers.length > 0) {
    logAgentEvent("mcp_discovery_start", {
      enabledServers: enabledMcpServers.length,
      totalServers: mcpServers.length,
    });
    const { tools: discovered, toolServerMap, serverStatuses } = await discoverAllMcpTools(mcpServers);
    mcpServerStatuses = serverStatuses;
    mcpToolServerMap = toolServerMap;
    setMcpToolServerMap(toolServerMap);
    if (discovered.length > 0) {
      logAgentEvent("mcp_discovery_done", {
        discoveredTools: discovered.length,
        toolNames: discovered.map((tool) => tool.name).slice(0, 24),
      });
      mcpTools = discovered;
    } else {
      logAgentEvent("mcp_discovery_done", {
        discoveredTools: 0,
      });
      mcpTools = [];
    }
  }

  const connectedMcpServerUrls = new Set(
    mcpServerStatuses
      .filter((status) => status.status === "connected" && status.enabled)
      .map((status) => status.url),
  );
  const connectedMcpServers = enabledMcpServers.filter((server) => connectedMcpServerUrls.has(server.url));
  const mcpPriorityEngine = gameStudioEngine ?? (unityCommandRequested ? "unity" : null);
  const preferredGameStudioMcpServerUrls = mcpPriorityEngine
    ? connectedMcpServers
      .filter((server) => isGameEngineLikelyServer(server, mcpPriorityEngine))
      .map((server) => server.url)
    : [];
  const effectiveGameStudioMcpServerUrls = preferredGameStudioMcpServerUrls.length > 0
    ? preferredGameStudioMcpServerUrls
    : connectedMcpServers.map((server) => server.url);
  const gameStudioMcpFirstEligible = (gameStudioEngineContext || unityCommandRequested) &&
    !!mcpPriorityEngine &&
    effectiveGameStudioMcpServerUrls.length > 0;
  const effectivePreferredUnityUrls = mcpPriorityEngine === "unity" ? effectiveGameStudioMcpServerUrls : [];
  const unityMcpFirstEligible = unityCommandRequested && mcpPriorityEngine === "unity" && gameStudioMcpFirstEligible;
  const mcpPriorityMode: McpRoutingPriorityMode = gameStudioMcpFirstEligible ? "game_studio_mcp_first" : "none";
  const forceFirstMcpTools = unityMcpFirstEligible && unityConsoleDiagnosticsRequested
    ? [...UNITY_MCP_STRICT_RETRY_FORCED_TOOLS]
    : [];

  logAgentEvent("mcp_server_status", {
    requestedUnityRouting: unityCommandRequested,
    gameStudioUnityContext,
    gameStudioEngine,
    gameStudioEngineContext,
    requestedGameStudioMcpRouting: gameStudioMcpFirstEligible,
    unityConsoleDiagnosticsRequested,
    statuses: mcpServerStatuses.map((status) => ({
      server: status.serverName,
      url: status.url,
      enabled: status.enabled,
      state: status.status,
      toolCount: status.toolCount,
      category: status.category,
      httpStatus: status.httpStatus,
      cached: status.cached === true,
    })),
  });

  const mcpRoutingResult = routeMcpToolsForPrompt({
    tools: mcpTools,
    servers: connectedMcpServers,
    toolServerMap: mcpToolServerMap,
    userPrompt: latestUserPromptText,
    config: config.mcpRouting,
    priorityMode: mcpPriorityMode,
    preferredServerUrls: preferredGameStudioMcpServerUrls,
    forceFirstTools: forceFirstMcpTools,
    unityRoutingContext: {
      preferStructuredScriptEdits: unityScriptEditRequested,
    },
    gameStudioRoutingContext: {
      engine: mcpPriorityEngine,
      preferStructuredScriptEdits: unityScriptEditRequested || gameStudioScriptEditRequested,
    },
  });
  mcpTools = annotateUnityEditToolDescriptions(mcpRoutingResult.tools, unityCommandRequested);
  logAgentEvent("mcp_routing", { ...mcpRoutingResult.telemetry });

  const knowledgeToolsEnabled = enabledKnowledgeBaseIds.length > 0;
  const routedToolDefinitions = buildToolDefinitions(skills, mcpTools).filter((tool) => {
    if (!webSearchEnabled && WEB_RESEARCH_TOOL_NAMES.has(tool.function.name)) return false;
    if (!knowledgeToolsEnabled && KNOWLEDGE_TOOL_NAMES.has(tool.function.name)) return false;
    return true;
  });
  const toolCapabilityRegistry = buildToolCapabilityRegistry({
    toolDefinitions: routedToolDefinitions,
    skills,
    mcpTools,
    mcpServers: connectedMcpServers,
    mcpToolServerMap,
    policy: config.toolPermissionPolicy,
  });
  const preferredUnityServerUrlSet = new Set(effectivePreferredUnityUrls);
  const preferredUnityMcpToolNameSet = new Set(
    mcpTools
      .filter((tool) => preferredUnityServerUrlSet.has(mcpToolServerMap[tool.name] || ""))
      .map((tool) => tool.name),
  );
  const fallbackUnityMcpToolNameSet = new Set(mcpTools.map((tool) => tool.name));
  const effectiveUnityMcpToolNameSet = preferredUnityMcpToolNameSet.size > 0
    ? preferredUnityMcpToolNameSet
    : fallbackUnityMcpToolNameSet;

  return {
    mcpTools,
    mcpServerStatuses,
    mcpPriorityEngine,
    gameStudioMcpFirstEligible,
    unityMcpFirstEligible,
    effectivePreferredUnityUrls,
    effectiveUnityMcpToolNameSet,
    routedToolDefinitions,
    toolCapabilityRegistry,
    webSearchEnabled,
    knowledgeToolsEnabled,
  };
}
