import type { ToolCatalog } from "./toolCatalog";
import type { ToolDefinition } from "./toolSchemas";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/**
 * Inspired by gg-framework / ggcoder:
 * Keep the default exposed tool surface small (8 orthogonal core tools) and
 * static across turns so local models (Ollama, LM Studio, llama.cpp) preserve
 * 100% prefix KV Cache and avoid tool-choice paralysis across 28+ overlapping schemas.
 */
export const CORE_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "replace_in_file",
  "grep_search",
  "glob_search",
  "run_command",
  "load_skill",
  TOOL_SEARCH_TOOL_NAME,
]);

export const TOOL_SEARCH_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: TOOL_SEARCH_TOOL_NAME,
    description:
      "按关键词按需搜索并解锁扩展工具（如 git、AST/符号引用、文档/表格分析、浏览器验证 browser_evaluate、桌面控制 computer_use、子智能体 spawn_subagent 及 MCP 外部工具）。调用后匹配的工具会在当前会话中解锁并可直接调用。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "要搜索的工具名称、类别或能力关键词（如 'git'、'ast'、'tabular'、'excel'、'pdf'、'browser'、'desktop'、'subagent'、'mcp'，或传 'all' 查看全部扩展工具摘要）",
        },
        limit: {
          type: "number",
          description: "最多解锁并返回多少个匹配工具（默认 8，最大 20）",
        },
      },
      required: ["query"],
    },
  },
};

const DEFAULT_SESSION_KEY = "__default__";
const unlockedToolsBySession = new Map<string, Set<string>>();

function normalizeSessionKey(sessionKey?: string | null): string {
  const trimmed = String(sessionKey || "").trim();
  return trimmed || DEFAULT_SESSION_KEY;
}

export function getUnlockedToolsForSession(
  sessionKey?: string | null,
): ReadonlySet<string> {
  return unlockedToolsBySession.get(normalizeSessionKey(sessionKey)) || new Set();
}

export function unlockToolsForSession(
  sessionKey: string | null | undefined,
  toolNames: Iterable<string>,
): string[] {
  const key = normalizeSessionKey(sessionKey);
  let set = unlockedToolsBySession.get(key);
  if (!set) {
    set = new Set<string>();
    unlockedToolsBySession.set(key, set);
  }
  const newlyUnlocked: string[] = [];
  for (const rawName of toolNames) {
    const name = String(rawName || "").trim();
    if (!name || CORE_DEFAULT_TOOL_NAMES.has(name)) continue;
    if (!set.has(name)) {
      set.add(name);
      newlyUnlocked.push(name);
    }
  }
  return newlyUnlocked;
}

export function clearUnlockedToolsForSession(sessionKey?: string | null): void {
  unlockedToolsBySession.delete(normalizeSessionKey(sessionKey));
}

const PROMPT_CAPABILITY_UNLOCK_RULES: readonly {
  readonly pattern: RegExp;
  readonly tools: readonly string[];
}[] = [
  {
    pattern: /\b(xlsx|xls|csv|tsv|parquet|spreadsheet|tabular|表格|工作表|列名|数据透视)\b/i,
    tools: ["analyze_tabular_document", "query_tabular_document", "read_document"],
  },
  {
    pattern: /\b(pdf|docx|pptx|epub|文档解析|读取文档)\b/i,
    tools: ["read_document"],
  },
  {
    pattern: /\b(browser_evaluate|playwright|localhost:\d+|127\.0\.0\.1:\d+|浏览器验证|页面断言|前端页面检查)\b/i,
    tools: ["browser_evaluate"],
  },
  {
    pattern: /\b(computer_use|accessibility|桌面控制|桌面应用验证|窗口控制)\b/i,
    tools: ["computer_use"],
  },
  {
    pattern: /\b(git_status|git_diff|git\s+status|git\s+diff)\b/i,
    tools: ["git_status", "git_diff"],
  },
  {
    pattern: /\b(apply_patch|unified\s+diff|补丁)\b/i,
    tools: ["apply_patch"],
  },
  {
    pattern: /\b(delete_workspace_path|删除文件|删除目录|移除文件)\b/i,
    tools: ["delete_workspace_path"],
  },
  {
    pattern: /\b(spawn_subagent|wait_subagents|子智能体|并行子任务|subagent)\b/i,
    tools: ["spawn_subagent", "wait_subagents"],
  },
  {
    pattern: /\b(code_ast_query|find_symbol_references|get_file_outline|get_project_skeleton|repo_map_search|repo_map_context)\b/i,
    tools: [
      "get_project_skeleton",
      "get_file_outline",
      "code_ast_query",
      "find_symbol_references",
      "repo_map_search",
      "repo_map_context",
    ],
  },
  {
    pattern: /\b(web_search|web_fetch|联网搜索|搜索网页|抓取网页)\b/i,
    tools: ["web_search", "web_fetch"],
  },
];

const EXTENDED_TOOL_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  list_directory: ["directory", "folder", "ls", "tree", "目录", "文件夹"],
  get_project_skeleton: ["skeleton", "architecture", "tree", "overview", "unity", "骨架", "目录树", "架构"],
  get_file_outline: ["outline", "signature", "csharp", "c#", "class", "interface", "大纲", "签名"],
  code_ast_query: ["ast", "symbol", "definition", "syntax", "语法树", "符号定义"],
  find_symbol_references: ["references", "usages", "callers", "symbol", "引用", "调用方"],
  repo_map_search: ["repomap", "repo_map", "symbol", "search", "仓库索引"],
  repo_map_context: ["repomap", "repo_map", "context", "dependencies", "上下文"],
  read_document: ["pdf", "docx", "doc", "document", "markdown", "文档"],
  analyze_tabular_document: ["csv", "xlsx", "excel", "table", "tabular", "schema", "表格", "数据分析"],
  query_tabular_document: ["csv", "xlsx", "excel", "sql", "filter", "group", "aggregate", "表格查询"],
  apply_patch: ["patch", "diff", "edit", "补丁"],
  delete_workspace_path: ["delete", "remove", "unlink", "rm", "删除"],
  git_status: ["git", "status", "staged", "modified", "版本控制"],
  git_diff: ["git", "diff", "changes", "patch", "差异"],
  browser_evaluate: ["browser", "playwright", "web", "dom", "ui", "screenshot", "浏览器", "前端验证"],
  computer_use: ["desktop", "macos", "accessibility", "gui", "app", "window", "桌面", "窗口"],
  spawn_subagent: ["subagent", "delegate", "parallel", "child", "子智能体", "并行"],
  wait_subagents: ["subagent", "wait", "join", "子智能体", "等待"],
  web_search: ["web", "search", "internet", "google", "bing", "联网", "搜索"],
  web_fetch: ["web", "fetch", "url", "http", "抓取", "网页"],
};

export function inferPreUnlockedToolsFromPrompt(prompt: string): string[] {
  const text = String(prompt || "").trim();
  if (!text) return [];
  const matched = new Set<string>();
  for (const rule of PROMPT_CAPABILITY_UNLOCK_RULES) {
    if (rule.pattern.test(text)) {
      for (const tool of rule.tools) matched.add(tool);
    }
  }
  return [...matched];
}

export function filterToCoreAndUnlockedTools(
  definitions: readonly ToolDefinition[],
  options: {
    readonly sessionKey?: string | null;
    readonly prompt?: string;
    readonly alwaysInclude?: Iterable<string>;
  } = {},
): ToolDefinition[] {
  if (
    definitions.length <= 8 &&
    !definitions.some((def) => def.function.name === TOOL_SEARCH_TOOL_NAME)
  ) {
    return [...definitions];
  }
  if (options.prompt) {
    const inferred = inferPreUnlockedToolsFromPrompt(options.prompt);
    if (inferred.length > 0) {
      unlockToolsForSession(options.sessionKey, inferred);
    }
  }
  const unlocked = getUnlockedToolsForSession(options.sessionKey);
  const always = new Set(options.alwaysInclude || []);

  // Keep core tools first in their exact canonical order, then append unlocked
  // extended tools in stable order so the prefix remains cache-friendly.
  const core: ToolDefinition[] = [];
  const extended: ToolDefinition[] = [];
  for (const def of definitions) {
    const name = def.function.name;
    if (CORE_DEFAULT_TOOL_NAMES.has(name) || always.has(name)) {
      core.push(def);
    } else if (unlocked.has(name)) {
      extended.push(def);
    }
  }
  return [...core, ...extended];
}

export function executeToolSearch(
  args: Record<string, unknown>,
  options: {
    readonly sessionKey?: string;
    readonly toolCatalog?: ToolCatalog;
  } = {},
): string {
  const rawQuery = String(args.query || "").trim();
  const limit = Math.max(
    1,
    Math.min(20, Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 8),
  );
  const catalogDefinitions = options.toolCatalog?.toolDefinitions || [];
  const candidates = catalogDefinitions.filter(
    (def) => !CORE_DEFAULT_TOOL_NAMES.has(def.function.name),
  );

  if (!rawQuery || rawQuery === "*" || rawQuery.toLowerCase() === "all") {
    const unlockedNow = unlockToolsForSession(
      options.sessionKey,
      candidates.slice(0, limit).map((def) => def.function.name),
    );
    return JSON.stringify(
      {
        type: "tool_search.result",
        query: rawQuery || "all",
        unlockedInSession: [
          ...getUnlockedToolsForSession(options.sessionKey),
        ],
        newlyUnlocked: unlockedNow,
        availableExtendedTools: candidates.map((def) => ({
          name: def.function.name,
          description: def.function.description.slice(0, 160),
          requiredParameters: def.function.parameters.required || [],
        })),
      },
      null,
      2,
    );
  }

  const tokens = rawQuery
    .toLowerCase()
    .split(/[\s,;+|/]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const scored = candidates
    .map((def) => {
      const name = def.function.name.toLowerCase();
      const desc = def.function.description.toLowerCase();
      const extraKeywords = (EXTENDED_TOOL_KEYWORDS[def.function.name] || [])
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (name === token) score += 100;
        else if (name.includes(token)) score += 40;
        if (extraKeywords.includes(token)) score += 30;
        if (desc.includes(token)) score += 15;
        if (token === "mcp" && options.toolCatalog?.lookup(def.function.name).status === "resolved") {
          const entry = options.toolCatalog.lookup(def.function.name);
          if (entry.status === "resolved" && entry.entry.source === "mcp") {
            score += 50;
          }
        }
      }
      return { def, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const matchedDefs = scored.map((item) => item.def);
  const matchedNames = matchedDefs.map((def) => def.function.name);
  unlockToolsForSession(options.sessionKey, matchedNames);

  return JSON.stringify(
    {
      type: "tool_search.result",
      query: rawQuery,
      matchedCount: matchedDefs.length,
      unlockedTools: matchedDefs.map((def) => ({
        name: def.function.name,
        description: def.function.description,
        parameters: def.function.parameters,
      })),
      hint:
        matchedDefs.length > 0
          ? `已解锁 ${matchedNames.join(", ")}，现在可以在下一步直接调用这些工具。`
          : "未找到匹配的扩展工具，请尝试使用 query='all' 查看全部可用扩展工具列表，或直接使用 read_file / grep_search / glob_search / run_command 等核心工具。",
    },
    null,
    2,
  );
}
