import type { Skill } from "./appTypes";
import {
  extensionSkillProjection,
  type GeminiExtensionInstallation,
} from "./geminiExtensions";
import type {
  MCPServer,
  MCPTool,
  MCPServerStatusSnapshot,
} from "./mcpClient";
import { normalizeRuntimeV2CheckpointMap } from "./runtime-v2/checkpoint";
import { isRuntimeV2TurnTerminallyClosed } from "./runtime-v2/terminal";

/** Rebuildable connection observations. Never persisted as a live capability. */
export interface ExtensionMcpDiscovery {
  tools: MCPTool[];
  toolServerMap: Record<string, string>;
  serverStatuses: MCPServerStatusSnapshot[];
}

export interface WorkspaceMcpSnapshot {
  readonly workspace: string;
  readonly mcpServers: MCPServer[];
  readonly mcpDiscoveredTools: MCPTool[];
  readonly mcpToolServerMap: Record<string, string>;
}

export function normalizeExtensionWorkspace(workspace: string): string {
  const normalized = String(workspace || "").trim().replace(/\\/g, "/");
  return normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)
    ? normalized
    : normalized.replace(/\/+$/, "");
}

export function extensionMcpDiscoveryKey(installation: GeminiExtensionInstallation): string {
  return `${normalizeExtensionWorkspace(installation.workspaceScope)}\u0000${installation.id}\u0000${installation.packageHash}`;
}

export function extensionMcpServers(installation: GeminiExtensionInstallation): MCPServer[] {
  if (!installation.enabled) return [];
  return installation.mcpServers
    .filter((component) => component.supported && component.status === "supported" && component.enabled && component.url)
    .map((component) => ({
      name: `gemini:${installation.id}:${component.key}`,
      type: "http" as const,
      url: component.url!,
      enabled: true,
    }));
}

export function workspaceExtensionSkills(
  skills: readonly Skill[],
  installations: readonly GeminiExtensionInstallation[],
  workspace: string,
): Skill[] {
  const scope = normalizeExtensionWorkspace(workspace);
  return [...(skills || []), ...(installations || [])
    .filter((installation) => normalizeExtensionWorkspace(installation.workspaceScope) === scope)
    .map(extensionSkillProjection)
    .filter((skill): skill is Skill => Boolean(skill))];
}

/** Compose connector inputs for the Run's workspace, never the visible tab.
 * The result is a detached admission snapshot consumed by the existing tool
 * catalog and permission owner. Extension state does not enter the loop. */
export function resolveWorkspaceMcpView(input: {
  readonly workspace: string;
  readonly manualServers: readonly MCPServer[];
  readonly manualTools: readonly MCPTool[];
  readonly manualToolServerMap: Readonly<Record<string, string>>;
  readonly installations: readonly GeminiExtensionInstallation[];
  readonly discoveries: Readonly<Record<string, ExtensionMcpDiscovery>>;
}): WorkspaceMcpSnapshot {
  const workspace = normalizeExtensionWorkspace(input.workspace);
  const servers = input.manualServers.map((server) => ({ ...server }));
  const manualUrls = new Set(servers.filter((server) => server.enabled !== false).map((server) => server.url));
  const tools = input.manualTools.filter((tool) => {
    const url = tool._mainMcpOrigin?.serverUrl || input.manualToolServerMap[tool.name];
    return url && manualUrls.has(url);
  });
  for (const installation of input.installations) {
    if (normalizeExtensionWorkspace(installation.workspaceScope) !== workspace) continue;
    const extensionServers = extensionMcpServers(installation);
    servers.push(...extensionServers);
    const discovery = input.discoveries[extensionMcpDiscoveryKey(installation)];
    if (!discovery) continue;
    const allowed = new Set(extensionServers.map((server) => `${server.name}\u0000${server.url}`));
    tools.push(...discovery.tools.filter((tool) => {
      const origin = tool._mainMcpOrigin;
      return origin && allowed.has(`${origin.serverName}\u0000${origin.serverUrl}`);
    }));
  }
  const enabledUrls = new Set(servers.filter((server) => server.enabled !== false).map((server) => server.url));
  const toolServerMap: Record<string, string> = {};
  const admittedTools = tools.filter((tool) => {
    const url = tool._mainMcpOrigin?.serverUrl || input.manualToolServerMap[tool.name];
    if (!url || !enabledUrls.has(url)) return false;
    toolServerMap[tool.name] = url;
    return true;
  }).map((tool) => JSON.parse(JSON.stringify(tool)) as MCPTool);
  return Object.freeze({
    workspace,
    mcpServers: Object.freeze(servers) as unknown as MCPServer[],
    mcpDiscoveredTools: Object.freeze(admittedTools) as unknown as MCPTool[],
    mcpToolServerMap: Object.freeze(toolServerMap),
  });
}

/** Management guard only: existing task lifecycle remains the authority. */
export function workspaceHasUnfinishedTurns(state: any, requestedWorkspace: string): boolean {
  const workspace = normalizeExtensionWorkspace(requestedWorkspace);
  const unfinished = (runtime: any): boolean => {
    if (!runtime) return false;
    if (runtime.isGenerating || runtime.workspaceTurnQueue?.entries?.length) return true;
    // Cold Session metadata may contain only v5 event ledgers, without an
    // aggregate cache or the Turn's transcript page. Replay through the
    // canonical checkpoint boundary before consulting its terminal state.
    const checkpoints = normalizeRuntimeV2CheckpointMap(runtime.runtimeV2Checkpoints, { workspaceKey: workspace });
    if (Object.values(checkpoints).some((checkpoint) => !isRuntimeV2TurnTerminallyClosed(checkpoint.aggregate))) return true;
    const rawCheckpoints = runtime.runtimeV2Checkpoints;
    if (rawCheckpoints && typeof rawCheckpoints === "object" && !Array.isArray(rawCheckpoints)) {
      for (const [turnId, raw] of Object.entries(rawCheckpoints)) {
        const ownerWorkspace = normalizeExtensionWorkspace((raw as any)?.owner?.workspaceKey);
        if (ownerWorkspace && ownerWorkspace !== workspace) continue;
        // An unreadable owned ledger cannot establish that its package is
        // no longer referenced. This is a management guard, not a new Run
        // lifecycle outcome or a guessed repair of the checkpoint.
        if (!checkpoints[turnId]) return true;
      }
    }
    return (runtime.conversationTurns || []).some((turn: any) => {
      // A replay-validated terminal ledger outranks stale UI projections.
      if (checkpoints[turn.id]) return false;
      if (turn.runtimeOutcome) return turn.runtimeOutcome.status === "paused";
      return ["pending", "running", "paused", "planning", "executing", "awaiting_input", "awaiting_approval", "queued"].includes(turn.status);
    });
  };
  if (normalizeExtensionWorkspace(state.currentWorkspace) === workspace && unfinished(state)) return true;
  if (Object.entries(state.runtimeBySessionKey || {}).some(([key, runtime]) =>
    key.startsWith(`${workspace}:`) && unfinished(runtime))) return true;
  return (state.sessionsByWorkspace?.[requestedWorkspace] || state.sessionsByWorkspace?.[workspace] || [])
    .some((session: any) => unfinished(session.runtimeSnapshot));
}
