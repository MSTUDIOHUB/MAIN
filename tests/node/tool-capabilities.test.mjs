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
  getToolRiskLevelForCall,
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
  assert.equal(classifyBuiltInTool("write_file"), "workspace_write");
  assert.equal(classifyBuiltInTool("run_command"), "shell");
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
    filterToolDefinitionsForIntent(tools, "discuss", registry).map((item) => item.function.name),
    ["read_file", "web_search"],
  );
  assert.deepEqual(
    filterToolDefinitionsForIntent(tools, "plan", registry).map((item) => item.function.name),
    ["read_file", "write_file", "web_search"],
  );
  assert.deepEqual(
    filterToolDefinitionsForIntent(tools, "plan", registry, { planApproved: true }).map((item) => item.function.name),
    ["read_file", "write_file", "run_command", "web_search"],
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
  assert.equal(isToolAutoExecutableForCall("write_file", {}, registry), false);
  assert.equal(isToolAutoExecutableForCall("browser_click", {}, registry), false);
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
