import type { AppConfig, Skill } from "../../appTypes";
import {
  discoverAllMcpTools,
  getMcpToolServerMap,
  getMcpToolServerUrl,
  setMcpToolServerMap,
  type MCPServer,
  type MCPServerStatusSnapshot,
  type MCPTool,
} from "../../mcpClient";
import {
  annotateUnityEditToolDescriptions,
  isGameEngineLikelyServer,
  shouldExposeGameEngineMcpServer,
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
import { buildToolCatalog, type ToolCatalog } from "../../toolCatalog";
import type { ToolDefinition } from "../../toolSchemas";
import type { CollaborationAccessMode } from "../../collaborationWorkItems";
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
  toolCatalog: ToolCatalog;
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
  subagentDepth?: number;
  subagentAccessMode?: CollaborationAccessMode;
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
    subagentDepth = 0,
    subagentAccessMode = "read",
    webSearchEnabled,
    enabledKnowledgeBaseIds,
  } = input;

  const enabledMcpServers = mcpServers.filter((server) => server.enabled !== false);
  const normalizedPrompt = latestUserPromptText.toLowerCase();
  const mcpDiscoveryRelevantToTurn =
    unityCommandRequested ||
    gameStudioEngineContext ||
    /\bmcp\b/i.test(latestUserPromptText) ||
    enabledMcpServers.some((server) =>
      !!server.name.trim() && normalizedPrompt.includes(server.name.trim().toLowerCase())
    );
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

  if (mcpServers.length > 0 && subagentDepth === 0) {
    const discoveryStartedAt = Date.now();
    if (mcpDiscoveryRelevantToTurn) {
      logAgentEvent("mcp_discovery_start", {
        enabledServers: enabledMcpServers.length,
        totalServers: mcpServers.length,
        requestedServerNames: enabledMcpServers
          .filter((server) => {
            const normalizedName = server.name.trim().toLowerCase();
            return !!normalizedName && normalizedPrompt.includes(normalizedName);
          })
          .map((server) => server.name),
      });
    }
    const { tools: discovered, toolServerMap, serverStatuses } = await discoverAllMcpTools(
      mcpServers,
      { logFailures: mcpDiscoveryRelevantToTurn },
    );
    mcpServerStatuses = serverStatuses;
    mcpToolServerMap = toolServerMap;
    setMcpToolServerMap(toolServerMap);
    if (discovered.length > 0) {
      mcpTools = discovered;
    } else {
      mcpTools = [];
    }
    if (mcpDiscoveryRelevantToTurn) {
      logAgentEvent("mcp_discovery_done", {
        discoveredTools: discovered.length,
        toolNames: discovered.map((tool) => tool.name).slice(0, 24),
        elapsedMs: Date.now() - discoveryStartedAt,
        connectedServers: serverStatuses
          .filter((status) => status.status === "connected")
          .map((status) => status.serverName),
        failedServers: serverStatuses
          .filter((status) => status.status === "failed")
          .map((status) => ({
            server: status.serverName,
            category: status.category,
            httpStatus: status.httpStatus,
            cached: status.cached === true,
          })),
      });
    }
  }

  const connectedMcpServerUrls = new Set(
    mcpServerStatuses
      .filter((status) => status.status === "connected" && status.enabled)
      .map((status) => status.url),
  );
  const connectedMcpServers = enabledMcpServers.filter((server) => connectedMcpServerUrls.has(server.url));
  const hiddenGameEngineMcpServerUrls = new Set(
    connectedMcpServers
      .filter((server) => !shouldExposeGameEngineMcpServer({
        server,
        gameStudioEngineContext,
        unityCommandRequested,
      }))
      .map((server) => server.url),
  );
  const hiddenGameEngineMcpTools = mcpTools.filter((tool) =>
    hiddenGameEngineMcpServerUrls.has(getMcpToolServerUrl(tool, mcpToolServerMap) || "")
  );
  if (hiddenGameEngineMcpTools.length > 0) {
    mcpTools = mcpTools.filter((tool) =>
      !hiddenGameEngineMcpServerUrls.has(getMcpToolServerUrl(tool, mcpToolServerMap) || "")
    );
    logAgentEvent("mcp_game_engine_tools_scoped", {
      gameStudioEngineContext,
      unityCommandRequested,
      hiddenToolCount: hiddenGameEngineMcpTools.length,
      hiddenToolNames: hiddenGameEngineMcpTools.map((tool) => tool.name).slice(0, 24),
    });
  }
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
    discoveryRelevantToTurn: mcpDiscoveryRelevantToTurn,
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

  const toolCatalog = buildToolCatalog({
    skills,
    mcpTools,
    mcpServers: connectedMcpServers,
    mcpToolServerMap,
  });
  mcpTools = toolCatalog.mcpTools;
  mcpToolServerMap = toolCatalog.mcpToolServerMap;
  setMcpToolServerMap(mcpToolServerMap);
  if (toolCatalog.diagnostics.length > 0) {
    logAgentEvent("tool_catalog_diagnostics", {
      count: toolCatalog.diagnostics.length,
      diagnostics: toolCatalog.diagnostics.slice(0, 24).map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        requestedName: diagnostic.requestedName,
        winner: diagnostic.winner?.canonicalName || null,
        candidates: diagnostic.candidates.map((candidate) => candidate.canonicalName),
      })),
    });
  }

  const knowledgeToolsEnabled = enabledKnowledgeBaseIds.length > 0;
  let routedToolDefinitions = toolCatalog.toolDefinitions.filter((tool) => {
    if (!webSearchEnabled && WEB_RESEARCH_TOOL_NAMES.has(tool.function.name)) return false;
    if (!knowledgeToolsEnabled && KNOWLEDGE_TOOL_NAMES.has(tool.function.name)) return false;
    return true;
  });
  let toolCapabilityRegistry = buildToolCapabilityRegistry({
    toolDefinitions: routedToolDefinitions,
    skills,
    mcpTools,
    mcpServers: connectedMcpServers,
    mcpToolServerMap,
    toolCatalog,
    policy: config.toolPermissionPolicy,
  });
  if (subagentDepth > 0) {
    const childToolNames = new Set([
      "read_file",
      "grep_search",
      "get_file_outline",
      "code_ast_query",
      "find_symbol_references",
      "git_status",
      "git_diff",
      ...(subagentAccessMode === "write"
        ? ["apply_patch", "replace_in_file", "write_file"]
        : []),
    ]);
    routedToolDefinitions = routedToolDefinitions.filter((tool) => {
      return childToolNames.has(tool.function.name);
    });
    mcpTools = [];
    toolCapabilityRegistry = buildToolCapabilityRegistry({
      toolDefinitions: routedToolDefinitions,
      skills,
      mcpTools,
      mcpServers: connectedMcpServers,
      mcpToolServerMap,
      toolCatalog,
      policy: config.toolPermissionPolicy,
    });
  }
  const preferredUnityServerUrlSet = new Set(effectivePreferredUnityUrls);
  const preferredUnityMcpToolNameSet = new Set(
    mcpTools
      .filter((tool) => preferredUnityServerUrlSet.has(getMcpToolServerUrl(tool, mcpToolServerMap) || ""))
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
    toolCatalog,
    toolCapabilityRegistry,
    webSearchEnabled,
    knowledgeToolsEnabled,
  };
}
