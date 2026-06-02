import type { MCPServer, MCPTool } from "./mcpClient";
import type { ResolvedUserIntent } from "./runIntent";
import type { ToolDefinition } from "./toolSchemas";
import { looksDangerousShellCommand } from "./toolExecutionContract";

export type PromptLanguageStrategy = "english_core_localized_output";

export type ToolRiskLevel =
  | "read_only"
  | "workspace_write"
  | "shell"
  | "local_file_read"
  | "external_read"
  | "external_write"
  | "browser_control"
  | "destructive";

export interface ToolPermissionPolicy {
  autoExecuteRiskLevels: ToolRiskLevel[];
  approvalRequiredRiskLevels: ToolRiskLevel[];
  disabledRiskLevels: ToolRiskLevel[];
}

export type ToolSourceKind = "built_in" | "skill" | "mcp";

export interface ToolCapability {
  key: string;
  name: string;
  source: ToolSourceKind;
  category: string;
  risk: ToolRiskLevel;
  enabled: boolean;
  autoExecutable: boolean;
  description?: string;
  serverName?: string;
  serverUrl?: string;
}

export interface ToolCapabilityRegistry {
  tools: Record<string, ToolCapability>;
  policy: ToolPermissionPolicy;
}

export interface ToolCallRiskContext {
  workspace?: string | null;
  approvedLocalFileReadPaths?: Iterable<string> | null;
}

export interface ToolIntentFilterOptions {
  runtimeIntent?: ResolvedUserIntent;
  planApproved?: boolean;
}

const PLAN_DRAFT_WRITE_TOOL_NAMES = new Set(["write_file", "replace_in_file"]);

export interface McpRoutingConfig {
  enabled: boolean;
  threshold: number;
  routerModel: string;
  timeoutMs: number;
  fallbackToFullList: boolean;
  disabledToolKeys: string[];
}

export interface McpRoutingTelemetry {
  routingRan: boolean;
  selectedServerCount: number;
  selectedToolCount: number;
  totalToolCount: number;
  pickSource: "disabled" | "full_list" | "heuristic" | "fallback_full_list" | "safe_empty";
  fallbackReason?: string;
  latencyMs: number;
  estimatedTokenCost?: number;
  selectedIntent?: McpToolsetIntent;
  selectedBundle?: string;
  selectedToolNames?: string[];
  schemaChars?: number;
}

export type GameStudioMcpEngine = "unity" | "godot" | "unreal";

export type McpRoutingPriorityMode = "none" | "unity_mcp_first" | "game_studio_mcp_first";

export interface UnityMcpRoutingContext {
  preferStructuredScriptEdits?: boolean;
}

export interface GameStudioMcpRoutingContext extends UnityMcpRoutingContext {
  engine?: GameStudioMcpEngine | null;
}

export type McpToolsetIntent =
  | "general"
  | "unity_console_diagnostics"
  | "unity_script_fix"
  | "unity_scene_object"
  | "unity_asset_prefab_material"
  | "unity_build_package"
  | "unity_editor_action"
  | "godot_console_diagnostics"
  | "godot_script_fix"
  | "godot_scene_node"
  | "godot_asset_resource"
  | "godot_build_export"
  | "godot_editor_action"
  | "unreal_output_log_diagnostics"
  | "unreal_blueprint_or_code_fix"
  | "unreal_level_actor"
  | "unreal_asset_material"
  | "unreal_build_package"
  | "unreal_editor_action";

export interface McpToolsetBundle {
  id: string;
  intent: McpToolsetIntent;
  requiredTools: string[];
  preferredTools: string[];
  maxTools: number;
}

type SkillLike = {
  name: string;
  desc?: string;
  type?: string;
  active?: boolean;
};

const READ_ONLY_BUILT_INS = new Set([
  "list_directory",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
  "get_project_skeleton",
  "get_file_outline",
]);

const WORKSPACE_WRITE_BUILT_INS = new Set(["replace_in_file", "write_file", "apply_patch"]);
const SHELL_BUILT_INS = new Set(["run_command", "execute_command", "send_pty_input"]);
const BROWSER_CONTROL_BUILT_INS = new Set(["browser_evaluate"]);
const DESTRUCTIVE_BUILT_INS = new Set(["delete_workspace_path"]);
const EXTERNAL_READ_BUILT_INS = new Set(["web_search", "web_fetch"]);

const LOCAL_FILE_READ_BUILT_INS = new Set([
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
]);

const EXTERNAL_READ_MCP_TOOL_NAMES = new Set([
  "find_gameobjects",
  "get_sha",
  "read_console",
  "unity_docs",
  "unity_reflect",
]);

const READ_VERBS = [
  "read",
  "get",
  "list",
  "search",
  "find",
  "fetch",
  "query",
  "select",
  "inspect",
  "analyze",
  "summarize",
  "lookup",
  "retrieve",
  "status",
  "diagnostics",
  "symbols",
  "references",
];

const WRITE_VERBS = [
  "write",
  "create",
  "update",
  "patch",
  "replace",
  "insert",
  "post",
  "comment",
  "send",
  "publish",
  "close",
  "merge",
  "approve",
  "assign",
  "label",
  "edit",
  "set",
  "run",
  "execute",
  "call",
];

const DESTRUCTIVE_TERMS = [
  "delete",
  "remove",
  "drop",
  "truncate",
  "reset",
  "destroy",
  "erase",
  "purge",
  "kill",
  "terminate",
  "format",
  "rm ",
];

const BROWSER_TERMS = [
  "browser",
  "devtools",
  "playwright",
  "puppeteer",
  "chromium",
  "chrome",
  "page",
  "dom",
  "screenshot",
  "click",
  "type",
  "fill",
  "navigate",
  "press",
  "hover",
  "viewport",
  "localhost",
];

const WEB_RESEARCH_TERMS = [
  "web",
  "search",
  "research",
  "exa",
  "tavily",
  "searx",
  "serp",
  "crawl",
  "fetch",
  "url",
  "http",
];

const GITHUB_TERMS = ["github", "git hub", "issue", "pull request", " pr ", "repo", "repository"];
const DATABASE_TERMS = ["sql", "sqlite", "postgres", "postgresql", "mysql", "database", "db", "table"];
const UNITY_TERMS = ["unity", "gameobject", "prefab", "scene", "asset", "editor"];
const GODOT_TERMS = [
  "godot",
  "gdscript",
  "gds",
  "scene",
  "node",
  "resource",
  "project",
  "editor",
];
const UNREAL_TERMS = [
  "unreal",
  " ue ",
  "ue4",
  "ue5",
  "blueprint",
  "actor",
  "level",
  "map",
  "asset",
  "editor",
];
const GAME_ENGINE_COMMON_TERMS = [
  "scene",
  "asset",
  "editor",
  "script",
  "code",
  "build",
  "package",
  "export",
  "log",
  "console",
  "diagnostic",
  "error",
  "warning",
  "场景",
  "资源",
  "编辑器",
  "脚本",
  "代码",
  "构建",
  "打包",
  "导出",
  "日志",
  "控制台",
  "诊断",
  "报错",
  "错误",
  "警告",
];
const UNITY_CONSOLE_TERMS = ["console", "error", "warning", "compile", "报错", "错误", "警告", "编译"];
const UNITY_SCRIPT_EDIT_TERMS = [
  "fix",
  "repair",
  "patch",
  "edit",
  "modify",
  "refactor",
  "script",
  "code",
  "c#",
  "cs",
  "修复",
  "补丁",
  "修改",
  "脚本",
  "代码",
  "编译",
  "报错",
  "错误",
];

export function createDefaultToolPermissionPolicy(): ToolPermissionPolicy {
  return {
    autoExecuteRiskLevels: ["read_only", "external_read"],
    approvalRequiredRiskLevels: [
      "local_file_read",
      "workspace_write",
      "shell",
      "external_write",
      "browser_control",
      "destructive",
    ],
    disabledRiskLevels: [],
  };
}

export function normalizeToolPermissionPolicy(policy?: Partial<ToolPermissionPolicy> | null): ToolPermissionPolicy {
  const defaults = createDefaultToolPermissionPolicy();
  const valid = new Set<ToolRiskLevel>([
    "read_only",
    "workspace_write",
    "shell",
    "local_file_read",
    "external_read",
    "external_write",
    "browser_control",
    "destructive",
  ]);
  const normalizeRiskList = (value: unknown, fallback: ToolRiskLevel[]) =>
    Array.isArray(value)
      ? value.filter((item): item is ToolRiskLevel => valid.has(item as ToolRiskLevel))
      : fallback;

  return {
    autoExecuteRiskLevels: normalizeRiskList(policy?.autoExecuteRiskLevels, defaults.autoExecuteRiskLevels),
    approvalRequiredRiskLevels: normalizeRiskList(
      policy?.approvalRequiredRiskLevels,
      defaults.approvalRequiredRiskLevels,
    ),
    disabledRiskLevels: normalizeRiskList(policy?.disabledRiskLevels, defaults.disabledRiskLevels),
  };
}

export function createDefaultMcpRoutingConfig(): McpRoutingConfig {
  return {
    enabled: true,
    threshold: 24,
    routerModel: "",
    timeoutMs: 800,
    fallbackToFullList: true,
    disabledToolKeys: [],
  };
}

export function normalizeMcpRoutingConfig(config?: Partial<McpRoutingConfig> | null): McpRoutingConfig {
  const defaults = createDefaultMcpRoutingConfig();
  const threshold = Number(config?.threshold);
  const timeoutMs = Number(config?.timeoutMs);
  return {
    enabled: typeof config?.enabled === "boolean" ? config.enabled : defaults.enabled,
    threshold: Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : defaults.threshold,
    routerModel: typeof config?.routerModel === "string" ? config.routerModel : defaults.routerModel,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : defaults.timeoutMs,
    fallbackToFullList:
      typeof config?.fallbackToFullList === "boolean"
        ? config.fallbackToFullList
        : defaults.fallbackToFullList,
    disabledToolKeys: Array.isArray(config?.disabledToolKeys)
      ? config.disabledToolKeys.filter((key): key is string => typeof key === "string" && key.trim().length > 0)
      : defaults.disabledToolKeys,
  };
}

function normalizeText(value: string | undefined): string {
  return (value || "").toLowerCase().replace(/[_/-]+/g, " ");
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function containsWriteIntent(text: string): boolean {
  return containsAny(text, WRITE_VERBS) || containsAny(text, DESTRUCTIVE_TERMS);
}

function containsReadIntent(text: string): boolean {
  return containsAny(text, READ_VERBS);
}

function isSqlReadOnly(args: Record<string, unknown>): boolean | null {
  const sqlValue = args.sql ?? args.query ?? args.statement ?? args.input;
  if (typeof sqlValue !== "string") return null;
  const normalized = sqlValue.trim().toLowerCase().replace(/^\s*--.*$/gm, "").trim();
  if (!normalized) return null;
  if (/^(select|with|explain|describe|show|pragma)\b/.test(normalized)) return true;
  if (/\b(insert|update|delete|drop|alter|truncate|create|replace|vacuum|grant|revoke)\b/.test(normalized)) {
    return false;
  }
  return null;
}

export function normalizeLocalFileReadPath(value: string | null | undefined): string {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw) return "";

  const driveMatch = raw.match(/^([A-Za-z]:)(?:\/+|$)(.*)$/);
  const root = driveMatch ? `${driveMatch[1]}/` : raw.startsWith("/") ? "/" : "";
  const rest = driveMatch ? driveMatch[2] : root ? raw.replace(/^\/+/, "") : raw;
  const parts: string[] = [];

  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) {
        parts.pop();
      } else if (!root) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  const normalized = `${root}${parts.join("/")}`;
  if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized || root;
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function pathStartsWithRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeLocalFileReadPath(path);
  const normalizedRoot = normalizeLocalFileReadPath(root);
  if (!normalizedPath || !normalizedRoot) return false;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function getLocalFileReadPathForToolCall(
  name: string,
  args: Record<string, unknown>,
  workspace?: string | null,
): string | null {
  if (!LOCAL_FILE_READ_BUILT_INS.has(name)) return null;
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath || !isAbsoluteLocalPath(rawPath)) return null;
  if (workspace && pathStartsWithRoot(rawPath, workspace)) return null;
  return normalizeLocalFileReadPath(rawPath);
}

export function isLocalFileReadApproved(
  path: string,
  approvedPaths?: Iterable<string> | null,
): boolean {
  const normalizedPath = normalizeLocalFileReadPath(path);
  if (!normalizedPath || !approvedPaths) return false;
  for (const approved of approvedPaths) {
    if (normalizeLocalFileReadPath(approved) === normalizedPath) return true;
  }
  return false;
}

export function classifyBuiltInTool(name: string): ToolRiskLevel {
  if (READ_ONLY_BUILT_INS.has(name)) return "read_only";
  if (EXTERNAL_READ_BUILT_INS.has(name)) return "external_read";
  if (WORKSPACE_WRITE_BUILT_INS.has(name)) return "workspace_write";
  if (SHELL_BUILT_INS.has(name)) return "shell";
  if (BROWSER_CONTROL_BUILT_INS.has(name)) return "browser_control";
  if (DESTRUCTIVE_BUILT_INS.has(name)) return "destructive";
  return "external_write";
}

export function classifySkillTool(skillOrTool: SkillLike | ToolDefinition): ToolRiskLevel {
  const name = "function" in skillOrTool ? skillOrTool.function.name : skillOrTool.name;
  const description = "function" in skillOrTool ? skillOrTool.function.description : skillOrTool.desc;
  const text = normalizeText(`${name} ${description || ""}`);

  if (containsAny(text, DESTRUCTIVE_TERMS)) return "destructive";
  if (containsAny(text, BROWSER_TERMS)) return "browser_control";
  if (containsWriteIntent(text)) return "external_write";
  if (containsReadIntent(text)) return "external_read";
  return "external_write";
}

export function classifyMcpTool(tool: MCPTool, server?: MCPServer): ToolRiskLevel {
  const text = normalizeText(`${server?.name || ""} ${tool.name} ${tool.description || ""}`);
  if (EXTERNAL_READ_MCP_TOOL_NAMES.has(tool.name)) return "external_read";

  if (containsAny(text, DESTRUCTIVE_TERMS)) return "destructive";

  if (containsAny(text, DATABASE_TERMS)) {
    if (containsAny(text, ["drop", "truncate", "delete", "alter"])) return "destructive";
    if (containsAny(text, ["select", "read", "list", "schema", "explain", "describe"])) return "external_read";
    return "external_write";
  }

  if (containsAny(text, BROWSER_TERMS)) return "browser_control";

  if (containsAny(text, GITHUB_TERMS)) {
    if (containsWriteIntent(text) && !/(\bget\b|\blist\b|\bsearch\b|\bread\b)/.test(text)) {
      return "external_write";
    }
    if (containsAny(text, ["comment", "create", "update", "close", "merge", "label", "assign"])) {
      return "external_write";
    }
    return "external_read";
  }

  if (containsAny(text, WEB_RESEARCH_TERMS)) {
    if (containsWriteIntent(text) && !containsReadIntent(text)) return "external_write";
    return "external_read";
  }

  if (containsWriteIntent(text)) return "external_write";
  if (containsReadIntent(text)) return "external_read";
  return "external_write";
}

export function classifyMcpToolName(name: string): ToolRiskLevel {
  return classifyMcpTool({ name, description: "", inputSchema: null });
}

function buildServerLookup(servers: MCPServer[]): Record<string, MCPServer> {
  const lookup: Record<string, MCPServer> = {};
  for (const server of servers) {
    lookup[server.url] = server;
  }
  return lookup;
}

export function isRiskAutoExecutable(risk: ToolRiskLevel, policy?: ToolPermissionPolicy): boolean {
  const normalized = normalizeToolPermissionPolicy(policy);
  return normalized.autoExecuteRiskLevels.includes(risk) && !normalized.disabledRiskLevels.includes(risk);
}

export function buildToolCapabilityRegistry(params: {
  toolDefinitions: ToolDefinition[];
  skills?: SkillLike[];
  mcpTools?: MCPTool[];
  mcpServers?: MCPServer[];
  mcpToolServerMap?: Record<string, string>;
  policy?: ToolPermissionPolicy;
}): ToolCapabilityRegistry {
  const policy = normalizeToolPermissionPolicy(params.policy);
  const tools: Record<string, ToolCapability> = {};
  const skillToolNames = new Set(
    (params.skills ?? [])
      .filter((skill) => skill.active !== false && skill.type === "tool")
      .map((skill) =>
        skill.name
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .replace(/_+/g, "_"),
      )
      .filter(Boolean),
  );
  const mcpToolByName = new Map((params.mcpTools ?? []).map((tool) => [tool.name, tool]));
  const serverByUrl = buildServerLookup(params.mcpServers ?? []);

  for (const definition of params.toolDefinitions) {
    const name = definition.function.name;
    const serverUrl = params.mcpToolServerMap?.[name];
    const mcpTool = mcpToolByName.get(name);
    const server = serverUrl ? serverByUrl[serverUrl] : undefined;
    const source: ToolSourceKind = mcpTool ? "mcp" : skillToolNames.has(name) ? "skill" : "built_in";
    const risk =
      source === "mcp" && mcpTool
        ? classifyMcpTool(mcpTool, server)
        : source === "skill"
        ? classifySkillTool(definition)
        : classifyBuiltInTool(name);

    tools[name] = {
      key: source === "mcp" && server?.name ? `${server.name}:${name}` : name,
      name,
      source,
      category: deriveToolCategory(name, definition.function.description, risk, source),
      risk,
      enabled: !policy.disabledRiskLevels.includes(risk),
      autoExecutable: isRiskAutoExecutable(risk, policy),
      description: definition.function.description,
      serverName: server?.name,
      serverUrl,
    };
  }

  return { tools, policy };
}

function deriveToolCategory(
  name: string,
  description: string | undefined,
  risk: ToolRiskLevel,
  source: ToolSourceKind,
): string {
  const text = normalizeText(`${name} ${description || ""}`);
  if (source === "built_in" && containsAny(text, BROWSER_TERMS)) return "browser";
  if (source === "built_in" && EXTERNAL_READ_BUILT_INS.has(name)) return "research";
  if (source === "mcp" && containsAny(text, BROWSER_TERMS)) return "browser";
  if (source === "mcp" && containsAny(text, GITHUB_TERMS)) return "github";
  if (source === "mcp" && containsAny(text, DATABASE_TERMS)) return "database";
  if (source === "mcp" && containsAny(text, WEB_RESEARCH_TERMS)) return "research";
  if (risk === "shell") return "shell";
  if (risk === "workspace_write") return "workspace";
  if (risk === "read_only") return "workspace_read";
  return source;
}

export function getToolRiskLevelForCall(
  name: string,
  args: Record<string, unknown>,
  registry?: ToolCapabilityRegistry,
  context: ToolCallRiskContext = {},
): ToolRiskLevel {
  const capability = registry?.tools[name];
  const localFileReadPath = getLocalFileReadPathForToolCall(name, args, context.workspace);
  if (
    localFileReadPath &&
    !isLocalFileReadApproved(localFileReadPath, context.approvedLocalFileReadPaths)
  ) {
    return "local_file_read";
  }
  if (capability?.category === "database" || containsAny(normalizeText(name), DATABASE_TERMS)) {
    const readOnlySql = isSqlReadOnly(args);
    if (readOnlySql === true) return "external_read";
    if (readOnlySql === false) {
      const sqlValue = String(args.sql ?? args.query ?? args.statement ?? args.input ?? "").toLowerCase();
      return /\b(drop|truncate|delete|alter)\b/.test(sqlValue) ? "destructive" : "external_write";
    }
  }
  if (SHELL_BUILT_INS.has(name) && looksDangerousShellCommand(args.command)) {
    return "destructive";
  }
  if (capability) return capability.risk;
  return classifyBuiltInTool(name);
}

export function isToolAutoExecutableForCall(
  name: string,
  args: Record<string, unknown>,
  registry?: ToolCapabilityRegistry,
  policy?: ToolPermissionPolicy,
  context: ToolCallRiskContext = {},
): boolean {
  const effectivePolicy = normalizeToolPermissionPolicy(policy ?? registry?.policy);
  const risk = getToolRiskLevelForCall(name, args, registry, context);
  return effectivePolicy.autoExecuteRiskLevels.includes(risk) && !effectivePolicy.disabledRiskLevels.includes(risk);
}

export function filterToolDefinitionsForIntent(
  tools: ToolDefinition[],
  intent: ResolvedUserIntent,
  registry: ToolCapabilityRegistry,
  options: ToolIntentFilterOptions = {},
): ToolDefinition[] {
  const effectiveIntent =
    options.runtimeIntent ??
    (intent === "plan" && options.planApproved ? "execute" : intent);

  return tools.filter((tool) => {
    const name = tool.function.name;
    const capability = registry.tools[name];
    if (capability && !capability.enabled) return false;
    const risk = capability?.risk ?? classifyBuiltInTool(name);

    if (effectiveIntent === "plan") {
      if (PLAN_DRAFT_WRITE_TOOL_NAMES.has(name)) return true;
      return risk === "read_only" || risk === "external_read";
    }

    return !registry.policy.disabledRiskLevels.includes(risk);
  });
}

function extractQueryTerms(userPrompt: string): string[] {
  const normalized = normalizeText(userPrompt);
  const latinTerms = normalized.match(/[a-z0-9]{3,}/g) ?? [];
  const cjkTerms = [
    "浏览器",
    "截图",
    "点击",
    "页面",
    "前端",
    "搜索",
    "最新",
    "资料",
    "研究",
    "竞品",
    "github",
    "issue",
    "pr",
    "数据库",
    "表",
    "sql",
    "诊断",
    "符号",
    "引用",
    "引擎",
    "场景",
    "节点",
    "脚本",
    "蓝图",
    "关卡",
    "资源",
    "材质",
    "控制台",
    "日志",
    "构建",
    "打包",
    "导出",
  ].filter((term) => userPrompt.toLowerCase().includes(term));
  return Array.from(new Set([...latinTerms, ...cjkTerms])).slice(0, 48);
}

function scoreMcpToolForPrompt(tool: MCPTool, server: MCPServer | undefined, userPrompt: string): number {
  const prompt = normalizeText(userPrompt);
  const text = normalizeText(`${server?.name || ""} ${tool.name} ${tool.description || ""}`);
  let score = 0;

  for (const term of extractQueryTerms(userPrompt)) {
    if (text.includes(term.toLowerCase())) score += 3;
  }

  if (containsAny(prompt, ["browser", "localhost", "screenshot", "dom", "click", "网页", "页面", "截图", "点击", "前端"]) && containsAny(text, BROWSER_TERMS)) {
    score += 14;
  }
  if (containsAny(prompt, ["search", "latest", "research", "docs", "资料", "最新", "搜索", "研究", "竞品"]) && containsAny(text, WEB_RESEARCH_TERMS)) {
    score += 12;
  }
  if (containsAny(prompt, ["github", "issue", "pull request", " pr ", "代码搜索"]) && containsAny(text, GITHUB_TERMS)) {
    score += 12;
  }
  if (containsAny(prompt, ["database", "sqlite", "postgres", "mysql", "sql", "数据库"]) && containsAny(text, DATABASE_TERMS)) {
    score += 10;
  }
  if (containsAny(prompt, ["diagnostic", "symbol", "reference", "rename", "诊断", "符号", "引用"]) && containsAny(text, ["lsp", "diagnostic", "symbol", "reference", "rename"])) {
    score += 10;
  }
  if (containsAny(prompt, UNITY_TERMS) && containsAny(text, UNITY_TERMS)) {
    score += 12;
  }
  if (containsAny(prompt, GODOT_TERMS) && containsAny(text, GODOT_TERMS)) {
    score += 12;
  }
  if (containsAny(prompt, UNREAL_TERMS) && containsAny(text, UNREAL_TERMS)) {
    score += 12;
  }
  if (containsAny(prompt, UNITY_CONSOLE_TERMS) && containsAny(text, ["read_console", "console"])) {
    score += 64;
  }

  if (score === 0 && classifyMcpTool(tool, server) === "external_read" && containsReadIntent(text)) {
    score += 1;
  }

  return score;
}

function normalizeGameStudioMcpEngine(engine: string | null | undefined): GameStudioMcpEngine | null {
  const normalized = String(engine || "").trim().toLowerCase();
  if (normalized === "unity") return "unity";
  if (normalized === "godot") return "godot";
  if (normalized === "unreal") return "unreal";
  return null;
}

function getGameStudioEngineTerms(engine: GameStudioMcpEngine): string[] {
  if (engine === "godot") return GODOT_TERMS;
  if (engine === "unreal") return UNREAL_TERMS;
  return UNITY_TERMS;
}

function scoreGameStudioIntentToolPreference(
  tool: MCPTool,
  server: MCPServer | undefined,
  intent: McpToolsetIntent,
): number {
  const text = normalizeText(`${server?.name || ""} ${tool.name} ${tool.description || ""}`);
  if (/(console|output|log|diagnostic|error|warning|read_|get_|list_|inspect|控制台|日志|诊断|错误|警告)/.test(text)) {
    if (
      intent === "unity_console_diagnostics" ||
      intent === "godot_console_diagnostics" ||
      intent === "unreal_output_log_diagnostics"
    ) {
      return 28;
    }
  }
  if (/(script|code|gdscript|c#|cpp|c\+\+|blueprint|apply|edit|patch|脚本|代码|蓝图|修改|修复)/.test(text)) {
    if (
      intent === "unity_script_fix" ||
      intent === "godot_script_fix" ||
      intent === "unreal_blueprint_or_code_fix"
    ) {
      return 24;
    }
  }
  if (/(scene|node|gameobject|component|actor|level|map|hierarchy|camera|场景|节点|对象|组件|关卡)/.test(text)) {
    if (
      intent === "unity_scene_object" ||
      intent === "godot_scene_node" ||
      intent === "unreal_level_actor"
    ) {
      return 22;
    }
  }
  if (/(asset|resource|prefab|material|texture|mesh|animation|资源|预制体|材质|贴图|动画)/.test(text)) {
    if (
      intent === "unity_asset_prefab_material" ||
      intent === "godot_asset_resource" ||
      intent === "unreal_asset_material"
    ) {
      return 18;
    }
  }
  if (/(build|package|export|cook|apk|ipa|shipping|构建|打包|导出|发布)/.test(text)) {
    if (
      intent === "unity_build_package" ||
      intent === "godot_build_export" ||
      intent === "unreal_build_package"
    ) {
      return 18;
    }
  }
  if (/(editor|menu|run|play|simulate|编辑器|菜单|运行|播放)/.test(text)) {
    if (
      intent === "unity_editor_action" ||
      intent === "godot_editor_action" ||
      intent === "unreal_editor_action"
    ) {
      return 16;
    }
  }
  return 0;
}

function scoreGameStudioMcpToolPreference(
  tool: MCPTool,
  server: MCPServer | undefined,
  userPrompt: string,
  context?: GameStudioMcpRoutingContext,
): number {
  const engine = normalizeGameStudioMcpEngine(context?.engine);
  if (!engine) return 0;
  const prompt = normalizeText(userPrompt);
  const text = normalizeText(`${server?.name || ""} ${tool.name} ${tool.description || ""}`);
  const engineTerms = getGameStudioEngineTerms(engine);
  const selectedIntent = inferGameStudioMcpToolsetIntent(userPrompt, context);
  const bundle = buildGameStudioMcpToolsetBundle(selectedIntent, context);
  let score = 0;

  if (containsAny(text, engineTerms)) score += 36;
  if (containsAny(text, GAME_ENGINE_COMMON_TERMS)) score += 6;
  if (containsAny(prompt, GAME_ENGINE_COMMON_TERMS) && containsAny(text, GAME_ENGINE_COMMON_TERMS)) {
    score += 10;
  }
  if (bundle?.requiredTools.includes(tool.name)) score += 56;
  if (bundle?.preferredTools.includes(tool.name)) score += 34;
  score += scoreGameStudioIntentToolPreference(tool, server, selectedIntent);
  if (engine === "unity") {
    score += scoreUnityStructuredEditPreference(tool, userPrompt, context);
  }
  return score;
}

function scoreUnityStructuredEditPreference(
  tool: MCPTool,
  userPrompt: string,
  context?: UnityMcpRoutingContext,
): number {
  if (!context?.preferStructuredScriptEdits) return 0;
  const prompt = normalizeText(userPrompt);
  if (!containsAny(prompt, UNITY_SCRIPT_EDIT_TERMS)) return 0;
  if (tool.name === "script_apply_edits") return 48;
  if (tool.name === "apply_text_edits") return -48;
  return 0;
}

function compareGameStudioPriorityToolNames(
  left: MCPTool,
  right: MCPTool,
  context?: GameStudioMcpRoutingContext,
): number {
  const engine = normalizeGameStudioMcpEngine(context?.engine);
  if (engine === "unity") return compareUnityPriorityToolNames(left, right, context);

  const rank = (tool: MCPTool): number => {
    const text = normalizeText(`${tool.name} ${tool.description || ""}`);
    if (/(console|output|log|diagnostic|error|warning|read_|get_|list_|inspect|控制台|日志|诊断|错误|警告)/.test(text)) {
      return 200;
    }
    if (/(scene|node|actor|level|map|hierarchy|asset|resource|blueprint|场景|节点|关卡|资源|蓝图)/.test(text)) {
      return 170;
    }
    if (/(script|code|gdscript|c#|cpp|c\+\+|edit|apply|patch|脚本|代码|修改|修复)/.test(text)) {
      return 150;
    }
    if (/(build|package|export|cook|构建|打包|导出|发布)/.test(text)) {
      return 120;
    }
    if (/(editor|menu|run|play|simulate|编辑器|菜单|运行|播放)/.test(text)) {
      return 110;
    }
    return 100;
  };
  const rankDelta = rank(right) - rank(left);
  if (rankDelta !== 0) return rankDelta;
  return left.name.localeCompare(right.name);
}

function compareUnityPriorityToolNames(
  left: MCPTool,
  right: MCPTool,
  context?: UnityMcpRoutingContext,
): number {
  if (!context?.preferStructuredScriptEdits) {
    return left.name.localeCompare(right.name);
  }
  const rank = (name: string): number => {
    if (name === "read_console") return 200;
    if (name === "set_active_instance") return 180;
    if (name === "script_apply_edits") return 160;
    if (name === "apply_text_edits") return 10;
    return 100;
  };
  const rankDelta = rank(right.name) - rank(left.name);
  if (rankDelta !== 0) return rankDelta;
  return left.name.localeCompare(right.name);
}

type UnityMcpToolsetIntent = Extract<
  McpToolsetIntent,
  | "unity_console_diagnostics"
  | "unity_script_fix"
  | "unity_scene_object"
  | "unity_asset_prefab_material"
  | "unity_build_package"
  | "unity_editor_action"
>;

const UNITY_TOOLSET_BUNDLES: Record<UnityMcpToolsetIntent, McpToolsetBundle> = {
  unity_console_diagnostics: {
    id: "unity_console_diagnostics",
    intent: "unity_console_diagnostics",
    requiredTools: ["read_console", "set_active_instance"],
    preferredTools: [
      "refresh_unity",
      "get_active_instance",
      "list_instances",
      "find_in_file",
      "get_sha",
    ],
    maxTools: 8,
  },
  unity_script_fix: {
    id: "unity_script_fix",
    intent: "unity_script_fix",
    requiredTools: ["read_console", "set_active_instance", "script_apply_edits"],
    preferredTools: [
      "refresh_unity",
      "find_in_file",
      "get_sha",
      "apply_text_edits",
      "manage_script",
      "read_resource",
      "get_active_instance",
    ],
    maxTools: 12,
  },
  unity_scene_object: {
    id: "unity_scene_object",
    intent: "unity_scene_object",
    requiredTools: ["set_active_instance"],
    preferredTools: [
      "find_gameobjects",
      "manage_gameobject",
      "manage_components",
      "manage_scene",
      "manage_camera",
      "refresh_unity",
      "read_console",
    ],
    maxTools: 12,
  },
  unity_asset_prefab_material: {
    id: "unity_asset_prefab_material",
    intent: "unity_asset_prefab_material",
    requiredTools: ["set_active_instance"],
    preferredTools: [
      "manage_asset",
      "manage_prefabs",
      "manage_material",
      "manage_packages",
      "refresh_unity",
      "read_console",
    ],
    maxTools: 10,
  },
  unity_build_package: {
    id: "unity_build_package",
    intent: "unity_build_package",
    requiredTools: ["read_console", "set_active_instance"],
    preferredTools: [
      "manage_build",
      "manage_packages",
      "refresh_unity",
      "get_active_instance",
    ],
    maxTools: 10,
  },
  unity_editor_action: {
    id: "unity_editor_action",
    intent: "unity_editor_action",
    requiredTools: ["set_active_instance"],
    preferredTools: [
      "execute_menu_item",
      "manage_editor",
      "refresh_unity",
      "read_console",
      "get_active_instance",
    ],
    maxTools: 10,
  },
};

function inferUnityMcpToolsetIntent(
  userPrompt: string,
  context?: UnityMcpRoutingContext,
): McpToolsetIntent {
  const prompt = normalizeText(userPrompt);
  const hasConsoleIntent = containsAny(prompt, UNITY_CONSOLE_TERMS);
  const hasFixVerb = containsAny(prompt, [
    "fix",
    "repair",
    "patch",
    "edit",
    "modify",
    "refactor",
    "resolve",
    "修复",
    "补丁",
    "修改",
    "改",
    "解决",
  ]);
  const hasScriptIntent =
    context?.preferStructuredScriptEdits === true ||
    containsAny(prompt, ["script", "c#", "cs", "compiler", "脚本", "代码"]) ||
    (hasFixVerb && containsAny(prompt, UNITY_SCRIPT_EDIT_TERMS));
  if (hasConsoleIntent && hasScriptIntent) return "unity_script_fix";
  if (hasScriptIntent) return "unity_script_fix";
  if (containsAny(prompt, ["build", "package", "apk", "ipa", "player", "构建", "打包", "发布", "包管理"])) {
    return "unity_build_package";
  }
  if (containsAny(prompt, ["prefab", "asset", "material", "texture", "资源", "预制体", "材质", "贴图"])) {
    return "unity_asset_prefab_material";
  }
  if (containsAny(prompt, ["gameobject", "component", "scene", "camera", "hierarchy", "对象", "组件", "场景", "相机"])) {
    return "unity_scene_object";
  }
  if (containsAny(prompt, ["menu item", "editor", "菜单", "编辑器", "窗口"])) {
    return "unity_editor_action";
  }
  return "unity_console_diagnostics";
}

function inferGameStudioMcpToolsetIntent(
  userPrompt: string,
  context?: GameStudioMcpRoutingContext,
): McpToolsetIntent {
  const engine = normalizeGameStudioMcpEngine(context?.engine);
  if (engine === "unity") return inferUnityMcpToolsetIntent(userPrompt, context);

  const prompt = normalizeText(userPrompt);
  const hasConsoleIntent = containsAny(prompt, [
    ...UNITY_CONSOLE_TERMS,
    "log",
    "output",
    "diagnostic",
    "crash",
    "trace",
    "stack",
    "日志",
    "控制台",
    "输出",
    "诊断",
    "崩溃",
    "堆栈",
  ]);
  const hasFixVerb = containsAny(prompt, [
    "fix",
    "repair",
    "patch",
    "edit",
    "modify",
    "refactor",
    "resolve",
    "修复",
    "补丁",
    "修改",
    "改",
    "解决",
  ]);

  if (engine === "godot") {
    const hasScriptIntent =
      containsAny(prompt, ["script", "gdscript", "gds", "c#", "cs", "code", "脚本", "代码"]) ||
      (hasFixVerb && containsAny(prompt, ["compile", "error", "报错", "错误", "编译"]));
    if (hasConsoleIntent && hasScriptIntent) return "godot_script_fix";
    if (hasScriptIntent) return "godot_script_fix";
    if (containsAny(prompt, ["build", "export", "package", "apk", "ipa", "构建", "导出", "打包", "发布"])) {
      return "godot_build_export";
    }
    if (containsAny(prompt, ["resource", "asset", "material", "texture", "shader", "资源", "材质", "贴图", "着色器"])) {
      return "godot_asset_resource";
    }
    if (containsAny(prompt, ["scene", "node", "camera", "control", "canvas", "场景", "节点", "相机", "控件", "画布"])) {
      return "godot_scene_node";
    }
    if (containsAny(prompt, ["editor", "menu", "run", "play", "编辑器", "菜单", "运行", "播放"])) {
      return "godot_editor_action";
    }
    if (hasConsoleIntent) return "godot_console_diagnostics";
    return "godot_scene_node";
  }

  if (engine === "unreal") {
    const hasScriptIntent =
      containsAny(prompt, ["blueprint", "c++", "cpp", "script", "code", "蓝图", "脚本", "代码"]) ||
      (hasFixVerb && containsAny(prompt, ["compile", "error", "报错", "错误", "编译"]));
    if (hasConsoleIntent && hasScriptIntent) return "unreal_blueprint_or_code_fix";
    if (hasScriptIntent) return "unreal_blueprint_or_code_fix";
    if (containsAny(prompt, ["build", "package", "cook", "shipping", "构建", "打包", "烘焙", "发布"])) {
      return "unreal_build_package";
    }
    if (containsAny(prompt, ["asset", "material", "texture", "mesh", "animation", "资源", "材质", "贴图", "网格", "动画"])) {
      return "unreal_asset_material";
    }
    if (containsAny(prompt, ["level", "actor", "map", "pawn", "component", "camera", "关卡", "蓝图", "角色", "组件", "相机"])) {
      return "unreal_level_actor";
    }
    if (containsAny(prompt, ["editor", "menu", "run", "play", "simulate", "编辑器", "菜单", "运行", "播放", "模拟"])) {
      return "unreal_editor_action";
    }
    if (hasConsoleIntent) return "unreal_output_log_diagnostics";
    return "unreal_level_actor";
  }

  return "general";
}

function buildGameStudioMcpToolsetBundle(
  intent: McpToolsetIntent,
  context?: GameStudioMcpRoutingContext,
): McpToolsetBundle | null {
  const engine = normalizeGameStudioMcpEngine(context?.engine);
  if (engine === "unity" && intent !== "general" && intent in UNITY_TOOLSET_BUNDLES) {
    return UNITY_TOOLSET_BUNDLES[intent as UnityMcpToolsetIntent];
  }
  if (engine === "godot") {
    switch (intent) {
      case "godot_console_diagnostics":
        return {
          id: "godot_console_diagnostics",
          intent,
          requiredTools: [],
          preferredTools: [
            "godot_read_output",
            "read_output",
            "read_console",
            "get_errors",
            "get_diagnostics",
            "read_editor_log",
            "godot_get_errors",
            "godot_get_diagnostics",
          ],
          maxTools: 8,
        };
      case "godot_script_fix":
        return {
          id: "godot_script_fix",
          intent,
          requiredTools: [],
          preferredTools: [
            "godot_edit_script",
            "edit_script",
            "apply_text_edits",
            "manage_script",
            "read_script",
            "godot_get_script",
            "godot_apply_patch",
            "godot_read_output",
            "read_output",
            "get_errors",
          ],
          maxTools: 12,
        };
      case "godot_asset_resource":
        return {
          id: "godot_asset_resource",
          intent,
          requiredTools: [],
          preferredTools: [
            "godot_list_resources",
            "list_resources",
            "inspect_resource",
            "edit_resource",
            "manage_resource",
            "manage_asset",
            "manage_material",
            "import_asset",
          ],
          maxTools: 10,
        };
      case "godot_build_export":
        return {
          id: "godot_build_export",
          intent,
          requiredTools: [],
          preferredTools: [
            "godot_export_project",
            "export_project",
            "build_project",
            "run_project",
            "godot_read_output",
            "read_output",
          ],
          maxTools: 10,
        };
      case "godot_editor_action":
        return {
          id: "godot_editor_action",
          intent,
          requiredTools: [],
          preferredTools: [
            "godot_editor_action",
            "run_project",
            "play_scene",
            "reload_project",
            "execute_editor_command",
            "godot_read_output",
            "read_output",
          ],
          maxTools: 10,
        };
      case "godot_scene_node":
      default:
        return {
          id: "godot_scene_node",
          intent: "godot_scene_node",
          requiredTools: [],
          preferredTools: [
            "godot_get_scene_tree",
            "get_scene_tree",
            "list_nodes",
            "find_nodes",
            "inspect_scene",
            "inspect_node",
            "manage_node",
            "edit_node",
            "manage_scene",
            "godot_read_output",
          ],
          maxTools: 12,
        };
    }
  }
  if (engine === "unreal") {
    switch (intent) {
      case "unreal_output_log_diagnostics":
        return {
          id: "unreal_output_log_diagnostics",
          intent,
          requiredTools: [],
          preferredTools: [
            "unreal_read_output_log",
            "read_output_log",
            "read_log",
            "get_errors",
            "get_diagnostics",
            "unreal_get_diagnostics",
          ],
          maxTools: 8,
        };
      case "unreal_blueprint_or_code_fix":
        return {
          id: "unreal_blueprint_or_code_fix",
          intent,
          requiredTools: [],
          preferredTools: [
            "unreal_read_output_log",
            "read_output_log",
            "find_blueprints",
            "inspect_blueprint",
            "edit_blueprint",
            "compile_blueprint",
            "apply_text_edits",
            "find_symbols",
          ],
          maxTools: 12,
        };
      case "unreal_asset_material":
        return {
          id: "unreal_asset_material",
          intent,
          requiredTools: [],
          preferredTools: [
            "list_assets",
            "find_assets",
            "inspect_asset",
            "edit_asset",
            "manage_asset",
            "manage_material",
            "import_asset",
          ],
          maxTools: 10,
        };
      case "unreal_build_package":
        return {
          id: "unreal_build_package",
          intent,
          requiredTools: [],
          preferredTools: [
            "package_project",
            "build_project",
            "cook_content",
            "run_automation_test",
            "unreal_read_output_log",
            "read_output_log",
          ],
          maxTools: 10,
        };
      case "unreal_editor_action":
        return {
          id: "unreal_editor_action",
          intent,
          requiredTools: [],
          preferredTools: [
            "execute_editor_command",
            "run_editor_utility",
            "play_in_editor",
            "simulate",
            "unreal_read_output_log",
            "read_output_log",
          ],
          maxTools: 10,
        };
      case "unreal_level_actor":
      default:
        return {
          id: "unreal_level_actor",
          intent: "unreal_level_actor",
          requiredTools: [],
          preferredTools: [
            "unreal_find_actors",
            "find_actors",
            "list_actors",
            "inspect_actor",
            "edit_actor",
            "manage_actor",
            "inspect_level",
            "manage_level",
            "unreal_read_output_log",
          ],
          maxTools: 12,
        };
    }
  }
  return null;
}

function selectToolsByName(tools: MCPTool[], names: string[]): MCPTool[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const selected: MCPTool[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const tool = byName.get(name);
    if (!tool || seen.has(tool.name)) continue;
    seen.add(tool.name);
    selected.push(tool);
  }
  return selected;
}

function pushUniqueTool(target: MCPTool[], tool: MCPTool | undefined, seen: Set<string>): void {
  if (!tool || seen.has(tool.name)) return;
  seen.add(tool.name);
  target.push(tool);
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function hasValidApplyTextPreconditionSha(args: Record<string, unknown>): boolean {
  const candidates = [
    args.precondition_sha256,
    args.precondition_sha,
    args.preconditionSha256,
    args.preconditionSha,
  ];
  return candidates.some((value) =>
    typeof value === "string" && /^[a-f0-9]{40,128}$/i.test(value.trim()),
  );
}

export function isUnityApplyTextPrecisePatchArgs(args: Record<string, unknown>): boolean {
  const uri = typeof args.uri === "string" ? args.uri.trim() : "";
  if (!uri) return false;
  if (!hasValidApplyTextPreconditionSha(args)) return false;
  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length === 0) return false;

  return edits.every((edit) => {
    if (!edit || typeof edit !== "object") return false;
    const record = edit as Record<string, unknown>;
    const startLine = toPositiveInteger(record.startLine);
    const startCol = toPositiveInteger(record.startCol);
    const endLine = toPositiveInteger(record.endLine);
    const endCol = toPositiveInteger(record.endCol);
    if (startLine == null || startCol == null || endLine == null || endCol == null) {
      return false;
    }
    if (endLine < startLine) return false;
    if (endLine === startLine && endCol < startCol) return false;
    if (!Object.prototype.hasOwnProperty.call(record, "newText")) return false;
    return true;
  });
}

export function routeMcpToolsForPrompt(params: {
  tools: MCPTool[];
  servers: MCPServer[];
  toolServerMap: Record<string, string>;
  userPrompt: string;
  config?: McpRoutingConfig;
  priorityMode?: McpRoutingPriorityMode;
  preferredServerUrls?: string[];
  forceFirstTools?: string[];
  unityRoutingContext?: UnityMcpRoutingContext;
  gameStudioRoutingContext?: GameStudioMcpRoutingContext;
}): { tools: MCPTool[]; telemetry: McpRoutingTelemetry } {
  const startedAt = Date.now();
  const config = normalizeMcpRoutingConfig(params.config);
  const disabledKeys = new Set(config.disabledToolKeys);
  const enabledTools = params.tools.filter((tool) => !disabledKeys.has(tool.name));
  const baseTelemetry = {
    selectedServerCount: 0,
    selectedToolCount: enabledTools.length,
    totalToolCount: params.tools.length,
    latencyMs: 0,
    estimatedTokenCost: 0,
  };

  const finish = (
    selectedTools: MCPTool[],
    pickSource: McpRoutingTelemetry["pickSource"],
    fallbackReason?: string,
    extra: Partial<McpRoutingTelemetry> = {},
  ) => {
    const serverUrls = new Set(
      selectedTools
        .map((tool) => params.toolServerMap[tool.name])
        .filter((url): url is string => typeof url === "string" && url.length > 0),
    );
    const latencyMs = Date.now() - startedAt;
    return {
      tools: selectedTools,
      telemetry: {
        ...baseTelemetry,
        routingRan: pickSource === "heuristic",
        selectedServerCount: serverUrls.size,
        selectedToolCount: selectedTools.length,
        pickSource,
        fallbackReason,
        latencyMs,
        estimatedTokenCost: Math.ceil(JSON.stringify(selectedTools).length / 4),
        selectedToolNames: selectedTools.map((tool) => tool.name),
        schemaChars: JSON.stringify(selectedTools).length,
        ...extra,
      },
    };
  };

  if (!config.enabled) return finish(enabledTools, "disabled");

  if (params.priorityMode === "unity_mcp_first" || params.priorityMode === "game_studio_mcp_first") {
    const gameStudioRoutingContext: GameStudioMcpRoutingContext = {
      ...(params.unityRoutingContext ?? {}),
      ...(params.gameStudioRoutingContext ?? {}),
      engine: params.gameStudioRoutingContext?.engine ?? (
        params.priorityMode === "unity_mcp_first" ? "unity" : params.gameStudioRoutingContext?.engine
      ),
    };
    const priorityEngine = normalizeGameStudioMcpEngine(gameStudioRoutingContext.engine);
    const preferredServerUrls = new Set(
      (params.preferredServerUrls ?? []).filter((url) => typeof url === "string" && url.trim().length > 0),
    );
    const scopedTools = preferredServerUrls.size > 0
      ? enabledTools.filter((tool) => preferredServerUrls.has(params.toolServerMap[tool.name] || ""))
      : enabledTools;
    const candidateTools = scopedTools.length > 0 ? scopedTools : enabledTools;

    const serverByUrl = buildServerLookup(params.servers);
    const scoredEntries = candidateTools
      .map((tool) => {
        const server = serverByUrl[params.toolServerMap[tool.name]];
        return {
          tool,
          score:
            scoreMcpToolForPrompt(tool, server, params.userPrompt) +
            scoreGameStudioMcpToolPreference(tool, server, params.userPrompt, gameStudioRoutingContext),
        };
      });
    const scoredTools = scoredEntries
      .filter((entry) => entry.score > 0 || preferredServerUrls.has(params.toolServerMap[entry.tool.name] || ""))
      .sort((a, b) => b.score - a.score || compareGameStudioPriorityToolNames(a.tool, b.tool, gameStudioRoutingContext))
      .map((entry) => entry.tool);

    const selectedIntent = inferGameStudioMcpToolsetIntent(params.userPrompt, gameStudioRoutingContext);
    const bundle = buildGameStudioMcpToolsetBundle(selectedIntent, gameStudioRoutingContext);
    const forcedNames = Array.from(new Set([
      ...(params.forceFirstTools ?? []),
      ...(bundle?.requiredTools ?? []),
    ]));
    const forcedOrder = selectToolsByName(candidateTools, forcedNames);
    const preferredOrder = selectToolsByName(candidateTools, bundle?.preferredTools ?? []);
    const selected: MCPTool[] = [];
    const selectedNames = new Set<string>();
    for (const tool of forcedOrder) pushUniqueTool(selected, tool, selectedNames);
    for (const tool of preferredOrder) pushUniqueTool(selected, tool, selectedNames);

    const maxByThreshold = Math.max(forcedOrder.length, Math.min(config.threshold, bundle?.maxTools ?? 12, 16));
    for (const tool of scoredTools) {
      if (selected.length >= maxByThreshold) break;
      pushUniqueTool(selected, tool, selectedNames);
    }

    const prioritized = selected.slice(0, Math.max(forcedOrder.length, maxByThreshold));
    if (prioritized.length > 0) {
      return finish(prioritized, "heuristic", undefined, {
        selectedIntent,
        selectedBundle: bundle?.id ?? `${priorityEngine ?? "game_studio"}_scored`,
      });
    }

    if (config.fallbackToFullList) {
      const fallbackTools = scoredTools.slice(0, Math.min(config.threshold, 16));
      return finish(
        fallbackTools.length > 0 ? fallbackTools : enabledTools.slice(0, Math.min(config.threshold, 16)),
        "fallback_full_list",
        `${priorityEngine ?? "game_studio"}_priority_no_candidates`,
        {
          selectedIntent,
          selectedBundle: bundle?.id ?? `${priorityEngine ?? "game_studio"}_scored`,
        },
      );
    }
    return finish([], "safe_empty", `${priorityEngine ?? "game_studio"}_priority_no_candidates`, {
      selectedIntent,
      selectedBundle: bundle?.id ?? `${priorityEngine ?? "game_studio"}_scored`,
    });
  }

  if (enabledTools.length <= config.threshold) return finish(enabledTools, "full_list");

  const serverByUrl = buildServerLookup(params.servers);
  const scored = enabledTools
    .map((tool) => {
      const server = serverByUrl[params.toolServerMap[tool.name]];
      return { tool, score: scoreMcpToolForPrompt(tool, server, params.userPrompt) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

  const selectedTools = scored.slice(0, config.threshold).map((item) => item.tool);
  if (selectedTools.length > 0) return finish(selectedTools, "heuristic");
  if (config.fallbackToFullList) return finish(enabledTools, "fallback_full_list", "no_relevant_mcp_tools_matched");
  return finish([], "safe_empty", "no_relevant_mcp_tools_matched");
}
