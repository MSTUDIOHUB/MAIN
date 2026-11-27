import {
  bindWorkspaceUnityCliConsole, bindWorkspaceUnityOfficialMcp, normalizeMcpWorkspace, probeWorkspaceUnityCliConsole,
  withoutWorkspaceUnityOfficialMcp, workspaceEditorObservationTools, type WorkspaceMcpSnapshot,
} from "../../lib/workspaceMcp";
import { UNITY_CONSOLE_TOOL_NAMES, UNITY_OFFICIAL_MCP_CONSOLE_TOOL } from "../../lib/runtime-v2/workspaceReadPolicy";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export function runtimeV2WorkspaceMcpSnapshot(ports: RuntimeV2ExecutionPortsInput) {
  return ports.live.workspaceMcpOverride ?? ports.context.workspaceMcpSnapshot;
}

export function setRuntimeV2WorkspaceMcpSnapshot(ports: RuntimeV2ExecutionPortsInput, snapshot: WorkspaceMcpSnapshot) {
  ports.live.workspaceMcpOverride = snapshot;
  ports.live.authorization = null;
}

export function dismissRuntimeV2UnityOfficialMcpOffer(ports: RuntimeV2ExecutionPortsInput) {
  const snapshot = runtimeV2WorkspaceMcpSnapshot(ports);
  if (snapshot?.unityOfficialMcpOfferVersion) {
    setRuntimeV2WorkspaceMcpSnapshot(ports, Object.freeze({ ...snapshot, unityOfficialMcpOfferVersion: undefined }));
  }
}

/** Runs only after the permission adapter accepts this exact invocation. */
export async function enableRuntimeV2UnityOfficialMcp(
  ports: RuntimeV2ExecutionPortsInput, args: Record<string, unknown>, signal: AbortSignal,
) {
  const snapshot = runtimeV2WorkspaceMcpSnapshot(ports);
  const version = snapshot?.unityOfficialMcpOfferVersion;
  if (!snapshot || !version || snapshot.workspace !== normalizeMcpWorkspace(ports.context.runWorkspace || "") ||
      Object.keys(args).length) throw new Error("UNITY_OFFICIAL_MCP_ENABLE_SCOPE_MISMATCH");
  signal.throwIfAborted();
  dismissRuntimeV2UnityOfficialMcpOffer(ports);
  ports.get().setConfig({ unityOfficialMcpEnabled: true });
  try {
    const connected = await bindWorkspaceUnityOfficialMcp(snapshot, version, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    signal.throwIfAborted();
    const enabled = ports.get().config.unityOfficialMcpEnabled === true;
    if (enabled) setRuntimeV2WorkspaceMcpSnapshot(ports, connected);
    return { enabled, connected: enabled, tools: enabled ? connected.mcpDiscoveredTools.filter(
      tool => tool._mainMcpOrigin?.connector === "unity_official").length : 0 };
  } catch (error) {
    signal.throwIfAborted();
    ports.logStoreEvent("workspace_unity_official_mcp_unavailable", { workspace: snapshot.workspace, reason: String(error) });
    return { enabled: ports.get().config.unityOfficialMcpEnabled === true, connected: false,
      message: "The official Unity MCP server could not connect to this workspace. Use another available Editor connector." };
  }
}

/** Refresh the Run's alternatives after a read failed, without replaying a call. */
export async function recoverRuntimeV2UnityConsole(
  ports: RuntimeV2ExecutionPortsInput, failedTool: string, reason: string, signal: AbortSignal,
) {
  const snapshot = runtimeV2WorkspaceMcpSnapshot(ports);
  const official = failedTool === UNITY_OFFICIAL_MCP_CONSOLE_TOOL;
  const prior = official ? snapshot?.unityOfficialMcp : snapshot?.unityCliConsole;
  if (!snapshot || !prior || signal.aborted) return undefined;
  const base = official ? withoutWorkspaceUnityOfficialMcp(snapshot) : Object.freeze({ ...snapshot, unityCliConsole: undefined });
  let fallback: WorkspaceMcpSnapshot | undefined;
  if (official && reason.includes("UNITY_OFFICIAL_MCP_EDITOR_UNAVAILABLE") && ports.get().config.unityOfficialMcpEnabled) {
    const rebound = await bindWorkspaceUnityOfficialMcp(base, prior.editorVersion,
      AbortSignal.any([signal, AbortSignal.timeout(10_000)])).catch(() => undefined);
    if (rebound?.unityOfficialMcp && rebound.unityOfficialMcp.editorPid !== prior.editorPid &&
        ports.get().config.unityOfficialMcpEnabled) fallback = rebound;
  }
  if (!fallback && !signal.aborted && (official || reason.includes("UNITY_CONSOLE_EDITOR_UNAVAILABLE"))) {
    const rebound = await bindWorkspaceUnityCliConsole(base, prior.editorVersion,
      (workspace, version) => probeWorkspaceUnityCliConsole(workspace, version, signal));
    if (official || (rebound.unityCliConsole && rebound.unityCliConsole.editorPid !== prior.editorPid)) fallback = rebound;
  }
  if (signal.aborted || runtimeV2WorkspaceMcpSnapshot(ports) !== snapshot) return undefined;
  const refreshed = fallback ?? base;
  setRuntimeV2WorkspaceMcpSnapshot(ports, refreshed);
  return workspaceEditorObservationTools(refreshed).find(tool => UNITY_CONSOLE_TOOL_NAMES.has(tool.function.name))?.function.name;
}
