import type { MCPServer, MCPTool } from "../mcpClient";
import type { CommandDirective } from "../runIntent";

interface UnityExecutionContextCallbacks {
  getCommandDirective?: () => CommandDirective | null;
  getMainModeKey: () => string;
  getGameStudioConfig?: () => { engine?: string | null } | null;
}

export type GameStudioEngineKey = "unity" | "godot" | "unreal";

export const UNITY_FALLBACK_RECOVERY_READ_ONLY_TOOL_NAMES = new Set([
  "list_directory",
  "get_project_skeleton",
  "glob_search",
  "grep_search",
  "read_file",
  "get_file_outline",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "unity_docs",
  "unity_reflect",
  "find_gameobjects",
  "find_in_file",
  "read_console",
]);

export function isUnityCommandDirective(commandDirective?: CommandDirective | null): boolean {
  return commandDirective?.kind === "unity";
}

export function isUnityConsoleDiagnosticsDirective(commandDirective?: CommandDirective | null): boolean {
  return commandDirective?.kind === "unity" && commandDirective?.action === "console_diagnostics";
}

export function shouldTriggerUnityMcpFirstIterationFallback(input: {
  toolCallCount: number;
  replyOptionCount: number;
  unityMcpFirstPhaseActive: boolean;
  unityMcpFirstIterationPending: boolean;
  unityConsoleDiagnosticsRequested?: boolean;
}): boolean {
  return (
    input.toolCallCount === 0 &&
    input.replyOptionCount === 0 &&
    input.unityMcpFirstPhaseActive &&
    input.unityMcpFirstIterationPending &&
    !input.unityConsoleDiagnosticsRequested
  );
}

export function shouldTriggerUnityMcpStrictRetry(input: {
  toolCallCount: number;
  replyOptionCount: number;
  unityMcpFirstPhaseActive: boolean;
  unityMcpFirstIterationPending: boolean;
  unityConsoleDiagnosticsRequested: boolean;
  strictRetryAlreadyIssued?: boolean;
}): boolean {
  return (
    input.toolCallCount === 0 &&
    input.replyOptionCount === 0 &&
    input.unityMcpFirstPhaseActive &&
    input.unityMcpFirstIterationPending &&
    input.unityConsoleDiagnosticsRequested &&
    !input.strictRetryAlreadyIssued
  );
}

export function shouldRepromptBeforeUnityConsoleFallback(input: {
  readConsoleCalled: boolean;
  hasSuccessfulReadOnlyActivity: boolean;
  repromptAlreadyIssued: boolean;
}): boolean {
  return !input.readConsoleCalled && input.hasSuccessfulReadOnlyActivity && !input.repromptAlreadyIssued;
}

export function isUnityLikelyServer(server: MCPServer): boolean {
  return isGameEngineLikelyServer(server, "unity");
}

export function normalizeGameStudioEngineKey(engine?: string | null): GameStudioEngineKey | null {
  const normalized = String(engine || "").trim().toLowerCase();
  if (normalized === "unity") return "unity";
  if (normalized === "godot") return "godot";
  if (normalized === "unreal") return "unreal";
  return null;
}

export function isGameEngineLikelyServer(
  server: Pick<MCPServer, "name" | "url">,
  engine?: string | null,
): boolean {
  const normalizedEngine = normalizeGameStudioEngineKey(engine);
  if (!normalizedEngine) return false;
  const text = `${server.name} ${server.url}`;
  if (normalizedEngine === "unity") return /unity/i.test(text);
  if (normalizedEngine === "godot") return /godot/i.test(text);
  return /\b(unreal|ue4|ue5|ue)\b/i.test(text);
}

export function extractMcpCallFailureCategory(content: string): string | null {
  const match = content.match(/MCP_CALL_FAILURE\[([^[\]]+)\]/i);
  return match ? match[1].toLowerCase() : null;
}

export function isUnityExecutionContext(callbacks: UnityExecutionContextCallbacks): boolean {
  const commandDirective = callbacks.getCommandDirective?.() ?? null;
  const gameStudioUnityContext =
    callbacks.getMainModeKey() === "game_studio" &&
    normalizeGameStudioEngineKey(callbacks.getGameStudioConfig?.()?.engine) === "unity";
  return isUnityCommandDirective(commandDirective) || gameStudioUnityContext;
}

export function isUnityScriptEditToolName(name: string): boolean {
  return name === "script_apply_edits" || name === "apply_text_edits";
}

export function isUnityScriptWriteToolCall(name: string, args: Record<string, unknown>): boolean {
  if (isUnityScriptEditToolName(name)) return true;
  if (name === "create_script" || name === "delete_script") return true;
  if (name !== "manage_script") return false;
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  return action === "create" || action === "delete";
}

export function resolveUnityScriptPathFromArgs(args: Record<string, unknown>): string | null {
  const folder = typeof args.path === "string" ? normalizePathLike(args.path) : "";
  const name = typeof args.name === "string" ? String(args.name).trim() : "";
  if (!folder || !name) return null;
  const fileName = name.endsWith(".cs") ? name : `${name}.cs`;
  return normalizePathLike(`${folder.replace(/\/+$/, "")}/${fileName}`);
}

export function buildUnityApplyTextPolicyBlockedMessage(language: "zh" | "en"): string {
  return language === "zh"
    ? "UNITY_EDIT_POLICY_BLOCKED: apply_text_edits 仅允许用于“精确补丁”（必须提供 uri、完整坐标 edits，以及 precondition_sha/ precondition_sha256）。当前参数不满足约束。请改用 script_apply_edits，或先读取文件并补全精确坐标与 precondition 后重试。"
    : "UNITY_EDIT_POLICY_BLOCKED: apply_text_edits is allowed only for precise patches (uri + full coordinate edits + precondition_sha/precondition_sha256). The current arguments are non-compliant. Use script_apply_edits instead, or read the file and retry with exact coordinates and precondition.";
}

export function annotateUnityEditToolDescriptions(tools: MCPTool[], enabled: boolean): MCPTool[] {
  if (!enabled) return tools;
  return tools.map((tool) => {
    if (tool.name === "script_apply_edits") {
      const guidance = "Unity policy: preferred tool for C# method/class edits.";
      if ((tool.description || "").includes(guidance)) return tool;
      return {
        ...tool,
        description: `${tool.description || ""}${tool.description ? " " : ""}${guidance}`.trim(),
      };
    }
    if (tool.name === "apply_text_edits") {
      const guidance = "Unity policy: only for precise coordinate patches with precondition SHA.";
      if ((tool.description || "").includes(guidance)) return tool;
      return {
        ...tool,
        description: `${tool.description || ""}${tool.description ? " " : ""}${guidance}`.trim(),
      };
    }
    return tool;
  });
}

function normalizePathLike(value: string): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}
