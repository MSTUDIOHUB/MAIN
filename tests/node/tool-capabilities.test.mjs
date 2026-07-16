import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }

    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

async function loadToolCapabilitiesModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolCapabilities.ts"));
}

const {
  buildToolCapabilityRegistry,
  classifyBuiltInTool,
  classifyMcpTool,
  createDefaultToolPermissionPolicy,
  filterToolDefinitionsForIntent,
  getLocalFileReadPathForToolCall,
  getToolRiskLevelForCall,
  isUnityApplyTextPrecisePatchArgs,
  isToolAutoExecutableForCall,
  routeMcpToolsForPrompt,
} = await loadToolCapabilitiesModule();

function tool(name, description = "") {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: {}, required: [] },
    },
  };
}

test("built-in tool risks separate read, write, shell, and destructive operations", () => {
  assert.equal(classifyBuiltInTool("read_file"), "read_only");
  assert.equal(classifyBuiltInTool("knowledge_search"), "read_only");
  assert.equal(classifyBuiltInTool("knowledge_get_excerpt"), "read_only");
  assert.equal(classifyBuiltInTool("write_file"), "workspace_write");
  assert.equal(classifyBuiltInTool("apply_patch"), "workspace_write");
  assert.equal(classifyBuiltInTool("repo_map_search"), "read_only");
  assert.equal(classifyBuiltInTool("code_ast_query"), "read_only");
  assert.equal(classifyBuiltInTool("find_symbol_references"), "read_only");
  assert.equal(classifyBuiltInTool("git_status"), "read_only");
  assert.equal(classifyBuiltInTool("git_diff"), "read_only");
  assert.equal(classifyBuiltInTool("web_search"), "external_read");
  assert.equal(classifyBuiltInTool("web_fetch"), "external_read");
  assert.equal(classifyBuiltInTool("run_command"), "shell");
  assert.equal(classifyBuiltInTool("browser_evaluate"), "browser_control");
  assert.equal(classifyBuiltInTool("delete_workspace_path"), "destructive");
});

test("MCP classification recognizes browser, search, GitHub write, and database tools", () => {
  assert.equal(
    classifyMcpTool({ name: "browser_screenshot", description: "Take a page screenshot", inputSchema: {} }),
    "browser_control",
  );
  assert.equal(
    classifyMcpTool({ name: "web_search", description: "Search the web and return sources", inputSchema: {} }),
    "external_read",
  );
  assert.equal(
    classifyMcpTool({ name: "github_create_issue_comment", description: "Post a comment to an issue", inputSchema: {} }),
    "external_write",
  );
  assert.equal(
    classifyMcpTool({ name: "postgres_query", description: "Run SQL against a database", inputSchema: {} }),
    "external_write",
  );
  assert.equal(
    classifyMcpTool(
      { name: "apply_text_edits", description: "Apply text edits to a Unity script", inputSchema: {} },
      { name: "Unity", type: "http", url: "http://127.0.0.1:8080/mcp" },
    ),
    "external_write",
  );
  assert.equal(
    classifyMcpTool(
      { name: "find_gameobjects", description: "Find GameObjects in the active Unity scene", inputSchema: {} },
      { name: "Unity", type: "http", url: "http://127.0.0.1:8080/mcp" },
    ),
    "external_read",
  );
});

test("intent filtering exposes read-only tools for chat and write/shell tools for execute", () => {
  const tools = [
    tool("read_file", "Read a file"),
    tool("write_file", "Write a file"),
    tool("run_command", "Run shell command"),
    tool("web_search", "Search the web"),
  ];
  const mcpTools = [{ name: "web_search", description: "Search the web", inputSchema: {} }];
  const registry = buildToolCapabilityRegistry({
    toolDefinitions: tools,
    mcpTools,
    mcpToolServerMap: { web_search: "http://mcp.test" },
    policy: createDefaultToolPermissionPolicy(),
  });

  assert.deepEqual(
    filterToolDefinitionsForIntent(tools, "respond", registry).map((item) => item.function.name),
    ["read_file", "write_file", "run_command", "web_search"],
  );
  assert.deepEqual(
    filterToolDefinitionsForIntent(tools, "discuss", registry).map((item) => item.function.name),
    ["read_file", "write_file", "run_command", "web_search"],
  );
  assert.deepEqual(
    filterToolDefinitionsForIntent(tools, "plan", registry).map((item) => item.function.name),
    ["read_file", "write_file", "web_search"],
  );
  assert.deepEqual(
    filterToolDefinitionsForIntent(tools, "plan", registry, { runtimeIntent: "execute" }).map((item) => item.function.name),
    ["read_file", "write_file", "run_command", "web_search"],
  );
  assert.deepEqual(
    filterToolDefinitionsForIntent(tools, "execute", registry).map((item) => item.function.name),
    ["read_file", "write_file", "run_command", "web_search"],
  );
});

test("execute intent exposes run_command for Git workflows", () => {
  const tools = [
    tool("read_file", "Read a file"),
    tool("run_command", "Run shell command"),
    tool("execute_command", "Run interactive shell command"),
  ];
  const registry = buildToolCapabilityRegistry({
    toolDefinitions: tools,
    policy: createDefaultToolPermissionPolicy(),
  });

  const names = filterToolDefinitionsForIntent(tools, "execute", registry).map((item) => item.function.name);
  assert.ok(names.includes("run_command"));
  assert.ok(names.includes("execute_command"));
});

test("approved execution exposes browser validation while keeping it approval gated", () => {
  const tools = [
    tool("read_file", "Read a file"),
    tool("write_file", "Write a file"),
    tool("browser_evaluate", "Validate localhost UI with Playwright"),
  ];
  const registry = buildToolCapabilityRegistry({
    toolDefinitions: tools,
    policy: createDefaultToolPermissionPolicy(),
  });

  assert.equal(registry.tools.browser_evaluate.risk, "browser_control");
  assert.equal(registry.tools.browser_evaluate.category, "browser");
  assert.equal(isToolAutoExecutableForCall("browser_evaluate", { url: "http://localhost:5173" }, registry), false);
  assert.deepEqual(
    filterToolDefinitionsForIntent(tools, "respond", registry).map((item) => item.function.name),
    ["read_file", "write_file", "browser_evaluate"],
  );
  assert.deepEqual(
    filterToolDefinitionsForIntent(tools, "plan", registry).map((item) => item.function.name),
    ["read_file", "write_file"],
  );
  assert.deepEqual(
    filterToolDefinitionsForIntent(tools, "execute", registry).map((item) => item.function.name),
    ["read_file", "write_file", "browser_evaluate"],
  );
});

test("permission policy auto-executes only safe read classes by default", () => {
  const tools = [
    tool("read_file", "Read a file"),
    tool("write_file", "Write a file"),
    tool("web_search", "Search the web"),
    tool("browser_click", "Click the current browser page"),
  ];
  const mcpTools = [
    { name: "web_search", description: "Search the web", inputSchema: {} },
    { name: "browser_click", description: "Click the current browser page", inputSchema: {} },
  ];
  const registry = buildToolCapabilityRegistry({
    toolDefinitions: tools,
    mcpTools,
    mcpToolServerMap: { web_search: "http://mcp.test", browser_click: "http://mcp.test" },
    policy: createDefaultToolPermissionPolicy(),
  });

  assert.equal(isToolAutoExecutableForCall("read_file", {}, registry), true);
  assert.equal(isToolAutoExecutableForCall("web_search", {}, registry), true);
  assert.equal(registry.tools.web_search.risk, "external_read");
  assert.equal(registry.tools.web_search.category, "research");
  assert.equal(isToolAutoExecutableForCall("write_file", {}, registry), false);
  assert.equal(isToolAutoExecutableForCall("browser_click", {}, registry), false);
});

test("workspace-external local file reads require approval until the path is granted", () => {
  const registry = buildToolCapabilityRegistry({
    toolDefinitions: [
      tool("read_file", "Read a file"),
      tool("read_document", "Read a document"),
      tool("analyze_tabular_document", "Analyze a table"),
      tool("query_tabular_document", "Query a table"),
    ],
    policy: createDefaultToolPermissionPolicy(),
  });
  const workspace = "/tmp/workspace";
  const externalLog = "/tmp/outside/main-debug.log";

  assert.equal(
    getLocalFileReadPathForToolCall("read_file", { path: externalLog }, workspace),
    externalLog,
  );
  assert.equal(
    getLocalFileReadPathForToolCall("read_file", { path: "/tmp/outside/../outside/main-debug.log" }, workspace),
    externalLog,
  );
  assert.equal(
    getToolRiskLevelForCall("read_file", { path: `${workspace}/README.md` }, registry, { workspace }),
    "read_only",
  );
  assert.equal(
    getToolRiskLevelForCall("read_file", { path: externalLog }, registry, { workspace }),
    "local_file_read",
  );
  assert.equal(
    isToolAutoExecutableForCall("read_file", { path: externalLog }, registry, undefined, { workspace }),
    false,
  );
  assert.equal(
    getToolRiskLevelForCall("read_document", { path: externalLog }, registry, {
      workspace,
      approvedLocalFileReadPaths: [externalLog],
    }),
    "read_only",
  );
  assert.equal(
    isToolAutoExecutableForCall("read_file", { path: externalLog }, registry, undefined, {
      workspace,
      approvedLocalFileReadPaths: ["/tmp/outside/../outside/main-debug.log"],
    }),
    true,
  );
});

test("SQL call risk is refined from arguments", () => {
  const registry = buildToolCapabilityRegistry({
    toolDefinitions: [tool("postgres_query", "Run SQL against a database")],
    mcpTools: [{ name: "postgres_query", description: "Run SQL against a database", inputSchema: {} }],
    mcpToolServerMap: { postgres_query: "http://mcp.test" },
    policy: createDefaultToolPermissionPolicy(),
  });

  assert.equal(getToolRiskLevelForCall("postgres_query", { sql: "select * from users" }, registry), "external_read");
  assert.equal(getToolRiskLevelForCall("postgres_query", { sql: "update users set admin = true" }, registry), "external_write");
  assert.equal(getToolRiskLevelForCall("postgres_query", { sql: "drop table users" }, registry), "destructive");
});

test("dangerous shell command calls are elevated to destructive risk", () => {
  const registry = buildToolCapabilityRegistry({
    toolDefinitions: [tool("run_command", "Run shell command")],
    policy: createDefaultToolPermissionPolicy(),
  });

  assert.equal(
    getToolRiskLevelForCall("run_command", { command: "git reset --hard HEAD" }, registry),
    "destructive",
  );
  assert.equal(
    getToolRiskLevelForCall("run_command", { command: "git status --short" }, registry),
    "shell",
  );
});

test("MCP routing keeps small lists and heuristically selects relevant tools above threshold", () => {
  const servers = [
    { name: "browser", type: "http", url: "http://browser.test" },
    { name: "research", type: "http", url: "http://research.test" },
  ];
  const tools = [
    { name: "browser_screenshot", description: "Take a page screenshot", inputSchema: {} },
    { name: "browser_click", description: "Click the page", inputSchema: {} },
    { name: "web_search", description: "Search the web", inputSchema: {} },
    { name: "github_list_issues", description: "List GitHub issues", inputSchema: {} },
  ];
  const toolServerMap = {
    browser_screenshot: "http://browser.test",
    browser_click: "http://browser.test",
    web_search: "http://research.test",
    github_list_issues: "http://research.test",
  };

  const small = routeMcpToolsForPrompt({
    tools,
    servers,
    toolServerMap,
    userPrompt: "anything",
    config: { enabled: true, threshold: 10, routerModel: "", timeoutMs: 800, fallbackToFullList: true, disabledToolKeys: [] },
  });
  assert.equal(small.telemetry.pickSource, "full_list");
  assert.equal(small.tools.length, 4);

  const routed = routeMcpToolsForPrompt({
    tools,
    servers,
    toolServerMap,
    userPrompt: "please screenshot localhost and inspect the page",
    config: { enabled: true, threshold: 2, routerModel: "", timeoutMs: 800, fallbackToFullList: true, disabledToolKeys: [] },
  });
  assert.equal(routed.telemetry.pickSource, "heuristic");
  assert.deepEqual(
    routed.tools.map((item) => item.name).sort(),
    ["browser_click", "browser_screenshot"],
  );
});

test("Unity MCP-first routing scopes Unity console diagnostics instead of exposing every Unity tool", () => {
  const servers = [
    { name: "unityMCP", type: "http", url: "http://127.0.0.1:8080/mcp" },
    { name: "research", type: "http", url: "http://research.test" },
  ];
  const tools = [
    { name: "manage_scene", description: "Manage Unity scenes", inputSchema: {} },
    { name: "read_console", description: "Read Unity Console errors and warnings", inputSchema: {} },
    { name: "web_search", description: "Search the web", inputSchema: {} },
  ];
  const toolServerMap = {
    manage_scene: "http://127.0.0.1:8080/mcp",
    read_console: "http://127.0.0.1:8080/mcp",
    web_search: "http://research.test",
  };

  const routed = routeMcpToolsForPrompt({
    tools,
    servers,
    toolServerMap,
    userPrompt: "检查一下 Unity console 报错",
    config: { enabled: true, threshold: 1, routerModel: "", timeoutMs: 800, fallbackToFullList: true, disabledToolKeys: [] },
    priorityMode: "unity_mcp_first",
    preferredServerUrls: ["http://127.0.0.1:8080/mcp"],
    forceFirstTools: ["read_console", "set_active_instance"],
  });

  assert.equal(routed.telemetry.pickSource, "heuristic");
  assert.equal(routed.telemetry.selectedIntent, "unity_console_diagnostics");
  assert.equal(routed.telemetry.selectedBundle, "unity_console_diagnostics");
  assert.equal(routed.tools[0]?.name, "read_console");
  assert.deepEqual(routed.tools.map((item) => item.name), ["read_console"]);
  assert.ok(routed.telemetry.selectedToolCount < tools.length);
});

test("Unity MCP-first routing prefers script_apply_edits over apply_text_edits for script fixes", () => {
  const servers = [{ name: "unityMCP", type: "http", url: "http://127.0.0.1:8080/mcp" }];
  const tools = [
    { name: "apply_text_edits", description: "Apply text edits to Unity script using coordinates", inputSchema: {} },
    { name: "script_apply_edits", description: "Structured script edits for Unity C#", inputSchema: {} },
    { name: "manage_scene", description: "Manage Unity scenes", inputSchema: {} },
  ];
  const toolServerMap = {
    apply_text_edits: "http://127.0.0.1:8080/mcp",
    script_apply_edits: "http://127.0.0.1:8080/mcp",
    manage_scene: "http://127.0.0.1:8080/mcp",
  };

  const routed = routeMcpToolsForPrompt({
    tools,
    servers,
    toolServerMap,
    userPrompt: "请修复 Unity C# 脚本报错",
    config: { enabled: true, threshold: 4, routerModel: "", timeoutMs: 800, fallbackToFullList: true, disabledToolKeys: [] },
    priorityMode: "unity_mcp_first",
    preferredServerUrls: ["http://127.0.0.1:8080/mcp"],
    unityRoutingContext: { preferStructuredScriptEdits: true },
  });

  const orderedNames = routed.tools.map((item) => item.name);
  assert.equal(routed.telemetry.selectedIntent, "unity_script_fix");
  assert.equal(routed.telemetry.selectedBundle, "unity_script_fix");
  assert.ok(orderedNames.indexOf("script_apply_edits") >= 0);
  assert.ok(orderedNames.indexOf("apply_text_edits") >= 0);
  assert.ok(orderedNames.indexOf("script_apply_edits") < orderedNames.indexOf("apply_text_edits"));
  assert.ok(routed.telemetry.selectedToolCount <= 4);
});

test("Game Studio MCP-first routing selects Godot MCP tools for Godot scene and script work", () => {
  const servers = [
    { name: "Godot MCP", type: "http", url: "http://127.0.0.1:9001/mcp" },
    { name: "research", type: "http", url: "http://research.test" },
  ];
  const tools = [
    { name: "godot_list_nodes", description: "List Godot scene nodes", inputSchema: {} },
    { name: "godot_edit_script", description: "Edit GDScript files in the Godot project", inputSchema: {} },
    { name: "godot_read_output", description: "Read Godot editor output and errors", inputSchema: {} },
    { name: "web_search", description: "Search the web", inputSchema: {} },
  ];
  const toolServerMap = {
    godot_list_nodes: "http://127.0.0.1:9001/mcp",
    godot_edit_script: "http://127.0.0.1:9001/mcp",
    godot_read_output: "http://127.0.0.1:9001/mcp",
    web_search: "http://research.test",
  };

  const routed = routeMcpToolsForPrompt({
    tools,
    servers,
    toolServerMap,
    userPrompt: "Godot 场景节点点击后没有响应，检查节点和脚本",
    config: { enabled: true, threshold: 4, routerModel: "", timeoutMs: 800, fallbackToFullList: true, disabledToolKeys: [] },
    priorityMode: "game_studio_mcp_first",
    preferredServerUrls: ["http://127.0.0.1:9001/mcp"],
    gameStudioRoutingContext: { engine: "godot" },
  });

  const names = routed.tools.map((item) => item.name);
  assert.equal(routed.telemetry.pickSource, "heuristic");
  assert.equal(routed.telemetry.selectedIntent, "godot_script_fix");
  assert.equal(routed.telemetry.selectedBundle, "godot_script_fix");
  assert.ok(names.includes("godot_edit_script"));
  assert.ok(names.includes("godot_read_output"));
  assert.ok(names.includes("godot_list_nodes"));
  assert.ok(!names.includes("web_search"));
});

test("Game Studio MCP-first routing selects Unreal MCP tools for Unreal log and actor work", () => {
  const servers = [
    { name: "Unreal MCP", type: "http", url: "http://127.0.0.1:9002/mcp" },
    { name: "research", type: "http", url: "http://research.test" },
  ];
  const tools = [
    { name: "unreal_find_actors", description: "Find Unreal level actors", inputSchema: {} },
    { name: "unreal_read_output_log", description: "Read Unreal Output Log errors", inputSchema: {} },
    { name: "unreal_edit_blueprint", description: "Edit Unreal Blueprint graphs", inputSchema: {} },
    { name: "web_search", description: "Search the web", inputSchema: {} },
  ];
  const toolServerMap = {
    unreal_find_actors: "http://127.0.0.1:9002/mcp",
    unreal_read_output_log: "http://127.0.0.1:9002/mcp",
    unreal_edit_blueprint: "http://127.0.0.1:9002/mcp",
    web_search: "http://research.test",
  };

  const routed = routeMcpToolsForPrompt({
    tools,
    servers,
    toolServerMap,
    userPrompt: "UE5 关卡 Actor 行为异常，先看输出日志和关卡 Actor",
    config: { enabled: true, threshold: 3, routerModel: "", timeoutMs: 800, fallbackToFullList: true, disabledToolKeys: [] },
    priorityMode: "game_studio_mcp_first",
    preferredServerUrls: ["http://127.0.0.1:9002/mcp"],
    gameStudioRoutingContext: { engine: "unreal" },
  });

  const names = routed.tools.map((item) => item.name);
  assert.equal(routed.telemetry.pickSource, "heuristic");
  assert.equal(routed.telemetry.selectedIntent, "unreal_level_actor");
  assert.equal(routed.telemetry.selectedBundle, "unreal_level_actor");
  assert.ok(names.includes("unreal_find_actors"));
  assert.ok(names.includes("unreal_read_output_log"));
  assert.ok(!names.includes("web_search"));
});

test("Unity apply_text_edits precise patch validator enforces uri, coordinates, and precondition sha", () => {
  const valid = isUnityApplyTextPrecisePatchArgs({
    uri: "Assets/Scripts/Player.cs",
    precondition_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    edits: [{ startLine: 10, startCol: 5, endLine: 10, endCol: 12, newText: "foo" }],
  });
  assert.equal(valid, true);

  const missingPrecondition = isUnityApplyTextPrecisePatchArgs({
    uri: "Assets/Scripts/Player.cs",
    edits: [{ startLine: 10, startCol: 5, endLine: 10, endCol: 12, newText: "foo" }],
  });
  assert.equal(missingPrecondition, false);

  const missingCoordinates = isUnityApplyTextPrecisePatchArgs({
    uri: "Assets/Scripts/Player.cs",
    precondition_sha: "0123456789abcdef0123456789abcdef01234567",
    edits: [{ startLine: 10, endLine: 10, newText: "foo" }],
  });
  assert.equal(missingCoordinates, false);
});
