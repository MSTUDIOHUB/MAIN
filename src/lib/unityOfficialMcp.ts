import { invoke } from "@tauri-apps/api/core";
import { runUnityEditorOperation } from "./ipc";
import { formatMcpToolCallResult, type MCPServer, type MCPTool } from "./mcpClient";
import { resolveWorkspaceEngineProfile } from "./workspaceEngineProfile";

export const UNITY_OFFICIAL_MCP_SERVER: MCPServer = Object.freeze({
  name: "Unity Official MCP",
  type: "stdio",
  url: "stdio:unity-official-mcp",
  enabled: true,
});

export interface UnityOfficialMcpBinding {
  readonly workspace: string;
  readonly instanceId: string;
  readonly editorPid: number;
  readonly editorVersion: string;
}

export interface UnityCliUpdateStatus {
  executablePath: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  packageManagerCommand?: string;
  checkError?: string;
}

export async function checkUnityCliUpdate(): Promise<UnityCliUpdateStatus> {
  const status = await invoke<UnityCliUpdateStatus>("unity_cli_check_update");
  if (!status?.currentVersion) throw new Error("UNITY_CLI_VERSION_UNAVAILABLE");
  return status;
}

export async function applyUnityCliUpdate(status: UnityCliUpdateStatus): Promise<UnityCliUpdateStatus> {
  if (!status.updateAvailable || !status.latestVersion || status.packageManagerCommand) {
    throw new Error("UNITY_CLI_UPDATE_UNAVAILABLE");
  }
  const updated = await invoke<UnityCliUpdateStatus>("unity_cli_apply_update", {
    expectedPath: status.executablePath,
    expectedVersion: status.currentVersion,
    targetVersion: status.latestVersion,
  });
  if (!updated?.packageManagerCommand && updated?.currentVersion !== status.latestVersion) {
    throw new Error("UNITY_CLI_UPDATE_UNVERIFIED");
  }
  return updated;
}

export async function scanWorkspaceUnityOfficialMcp(workspace: string, signal: AbortSignal) {
  if (!workspace) throw new Error("UNITY_OFFICIAL_MCP_WORKSPACE_REQUIRED");
  const profile = await resolveWorkspaceEngineProfile(workspace);
  signal.throwIfAborted();
  if (profile?.manualPresetId !== "unity6" || profile.descriptorPath !== "ProjectSettings/ProjectVersion.txt" || !profile.projectVersion) {
    throw new Error("UNITY_OFFICIAL_MCP_PROJECT_MISMATCH");
  }
  return discoverUnityOfficialMcp(workspace, profile.projectVersion, signal);
}

export async function discoverUnityOfficialMcp(workspace: string, editorVersion: string, signal: AbortSignal) {
  const result = await runUnityEditorOperation("unity_official_mcp", { workspace, editorVersion }, signal, Date.now() + 10_000) as {
    editorPid?: number;
    tools?: MCPTool[];
  };
  const pid = result?.editorPid;
  const tools = result?.tools;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || !Array.isArray(tools) || !tools.length ||
      tools.some(tool => !/^[A-Za-z0-9_-]{1,64}$/.test(tool?.name || "") || !tool.inputSchema || typeof tool.inputSchema !== "object") ||
      new Set(tools.map(tool => tool.name)).size !== tools.length) {
    throw new Error("UNITY_OFFICIAL_MCP_LIST_INVALID");
  }
  const binding: UnityOfficialMcpBinding = Object.freeze({
    workspace, instanceId: `unity-official-mcp:${pid}`, editorPid: pid, editorVersion,
  });
  return { binding, server: UNITY_OFFICIAL_MCP_SERVER, tools: tools.map(tool => ({
    ...tool, _mainMcpOrigin: {
      serverName: UNITY_OFFICIAL_MCP_SERVER.name, serverUrl: UNITY_OFFICIAL_MCP_SERVER.url, remoteName: tool.name, connector: "unity_official" as const,
    },
  })) };
}

export async function executeUnityOfficialMcp(
  binding: UnityOfficialMcpBinding, toolName: string, args: Record<string, unknown>, signal: AbortSignal,
  consoleObservation = false,
): Promise<string> {
  const result = await runUnityEditorOperation("unity_official_mcp", {
    workspace: binding.workspace, editorVersion: binding.editorVersion, expectedPid: binding.editorPid,
    call: { name: toolName, arguments: args }, ...(consoleObservation ? { consoleObservation: true } : {}),
  }, signal, Date.now() + (consoleObservation ? 12_000 : 90_000));
  return formatMcpToolCallResult(toolName, result);
}

export function executeUnityOfficialMcpConsole(binding: UnityOfficialMcpBinding, signal: AbortSignal): Promise<string> {
  return executeUnityOfficialMcp(binding, "console", { command: "get", args: { tail: 100, level: "warn" } }, signal, true);
}
