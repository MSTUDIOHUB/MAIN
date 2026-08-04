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
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return require(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { parseTextForTools } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/textToolParser.ts"),
);
const { sanitizeAIOutput } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/sanitize.ts"),
);
const { TOOL_DEFINITIONS } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/toolSchemas.ts"),
);
const { normalizeToolCallForExecution } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/toolCallNormalization.ts"),
);
const { resolveExecuteRecoveryBatchDecision } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/executeRecoveryTools.ts"),
);

test("parses legacy execute_command wrapper into a real read-only tool call", () => {
  const parsed = parseTextForTools([
    "我需要先查看 gdjrpg-prepare 目录。",
    "",
    "<execute_command>list_directory path=\"gdjrpg-prepare\"</execute_command>",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "list_directory");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "gdjrpg-prepare" });
  assert.match(parsed.cleanText, /我需要先查看/);
  assert.doesNotMatch(parsed.cleanText, /execute_command|list_directory path=/);
});

test("parses direct legacy tool tags with inline attributes", () => {
  const parsed = parseTextForTools("<list_directory path=\"gdjrpg-prepare\"></list_directory>");

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "list_directory");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "gdjrpg-prepare" });
  assert.equal(parsed.cleanText, "");
});

test("legacy tool tags are removed from visible text after parsing and sanitizing", () => {
  const parsed = parseTextForTools([
    "我先查看一下目录内容，然后再继续整理录制大纲。",
    "",
    "<execute_command>list_directory path=\"gdjrpg-prepare\"</execute_command>",
  ].join("\n"));

  const visibleText = sanitizeAIOutput(parsed.cleanText);

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "list_directory");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "gdjrpg-prepare" });
  assert.match(visibleText, /我先查看一下目录内容/);
  assert.doesNotMatch(visibleText, /execute_command|list_directory path=/);
});

test("parses local-model function-style tool calls", () => {
  const skeleton = parseTextForTools("get_project_skeleton()");
  assert.equal(skeleton.toolCalls.length, 1);
  assert.equal(skeleton.toolCalls[0].name, "get_project_skeleton");
  assert.deepEqual(skeleton.toolCalls[0].arguments, {});
  assert.equal(skeleton.cleanText, "");

  const readFile = parseTextForTools('read_file(path="Assets/Scripts/BattleManager.cs", maxBytes=4096)');
  assert.equal(readFile.toolCalls.length, 1);
  assert.equal(readFile.toolCalls[0].name, "read_file");
  assert.deepEqual(readFile.toolCalls[0].arguments, {
    path: "Assets/Scripts/BattleManager.cs",
    maxBytes: 4096,
  });
  assert.equal(readFile.cleanText, "");
});

test("parses local-model single positional argument safely for whitelisted tools", () => {
  const parsed = parseTextForTools('list_directory("src")');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "list_directory");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "src" });
  assert.equal(parsed.cleanText, "");
});

test("parses AST and Git tools emitted by local models", () => {
  const ast = parseTextForTools('code_ast_query(path="src/lib/orchestrator.ts", query="getToolTarget", max_results=20)');
  assert.equal(ast.toolCalls.length, 1);
  assert.equal(ast.toolCalls[0].name, "code_ast_query");
  assert.deepEqual(ast.toolCalls[0].arguments, {
    path: "src/lib/orchestrator.ts",
    query: "getToolTarget",
    max_results: 20,
  });

  const references = parseTextForTools('find_symbol_references("getToolTarget")');
  assert.equal(references.toolCalls.length, 1);
  assert.equal(references.toolCalls[0].name, "find_symbol_references");
  assert.deepEqual(references.toolCalls[0].arguments, { symbol: "getToolTarget" });

  const gitStatus = parseTextForTools("git_status()");
  assert.equal(gitStatus.toolCalls.length, 1);
  assert.equal(gitStatus.toolCalls[0].name, "git_status");

  const gitDiff = parseTextForTools([
    "<tool_use>",
    "<tool>git_diff</tool>",
    "<parameter name=\"path\">src/lib/orchestrator.ts</parameter>",
    "<parameter name=\"context_lines\">4</parameter>",
    "</tool_use>",
  ].join("\n"));
  assert.equal(gitDiff.toolCalls.length, 1);
  assert.equal(gitDiff.toolCalls[0].name, "git_diff");
  assert.deepEqual(gitDiff.toolCalls[0].arguments, {
    path: "src/lib/orchestrator.ts",
    context_lines: "4",
  });
});

test("parses every registered built-in tool from XML without registry drift", () => {
  for (const tool of TOOL_DEFINITIONS) {
    const name = tool.function.name;
    const parsed = parseTextForTools(`<tool_use><tool>${name}</tool></tool_use>`);
    assert.equal(parsed.toolCalls.length, 1, `expected ${name} to be parsed`);
    assert.equal(parsed.toolCalls[0].name, name);
  }
});

test("native collaboration schema exposes bounded read and transactional write contracts", () => {
  const spawn = TOOL_DEFINITIONS.find((tool) => tool.function.name === "spawn_subagent");
  const wait = TOOL_DEFINITIONS.find((tool) => tool.function.name === "wait_subagents");
  const cancel = TOOL_DEFINITIONS.find((tool) => tool.function.name === "cancel_subagent");

  assert.ok(spawn);
  assert.deepEqual(
    spawn.function.parameters.required,
    ["objective", "required_paths"],
  );
  assert.deepEqual(spawn.function.parameters.properties.task_kind.enum, [
    "explore",
    "review",
    "validate",
    "implement",
  ]);
  assert.deepEqual(spawn.function.parameters.properties.access_mode.enum, [
    "read",
    "write",
  ]);
  assert.deepEqual(
    spawn.function.parameters.properties.implementation_operation.enum,
    ["create", "modify", "delete"],
  );
  assert.ok(spawn.function.parameters.properties.implementation_plan);
  assert.ok(wait.function.parameters.properties.collaboration_task_ids);
  assert.ok(cancel.function.parameters.properties.collaboration_task_id);
  assert.equal(
    TOOL_DEFINITIONS.some((tool) => tool.function.name === "followup_subagent"),
    false,
  );
});

test("parses parallel subagent spawn calls and a join from local-model XML", () => {
  const parsed = parseTextForTools([
    "<tool_use>",
    "<tool>spawn_subagent</tool>",
    '<parameter name="task_key">frontend-title-chain</parameter>',
    '<parameter name="task_kind">explore</parameter>',
    '<parameter name="objective">Inspect frontend initialization</parameter>',
    '<parameter name="delegation_reason">The title state chain is independently diagnosable</parameter>',
    '<parameter name="success_criteria">Identify the state owner and render projection</parameter>',
    '<parameter name="scope">Frontend only</parameter>',
    '<parameter name="required_paths"></parameter>',
    '<parameter name="allowed_paths">src/main.js,src/components</parameter>',
    '<parameter name="access_mode">read</parameter>',
    '<parameter name="expected_output">Evidence-backed findings</parameter>',
    "</tool_use>",
    "<tool_use>",
    "<tool>spawn_subagent</tool>",
    '<parameter name="task_key">tauri-open-dialog-chain</parameter>',
    '<parameter name="task_kind">explore</parameter>',
    '<parameter name="objective">Inspect Tauri configuration</parameter>',
    '<parameter name="delegation_reason">The native open path is an independent causal chain</parameter>',
    '<parameter name="success_criteria">Identify the open command and dialog trigger</parameter>',
    '<parameter name="scope">Tauri only</parameter>',
    '<parameter name="required_paths">src-tauri/src/main.rs</parameter>',
    '<parameter name="allowed_paths">src-tauri/tauri.conf.json,src-tauri/src/main.rs</parameter>',
    '<parameter name="access_mode">read</parameter>',
    '<parameter name="expected_output">Evidence-backed findings</parameter>',
    "</tool_use>",
    "<tool_use>",
    "<tool>wait_subagents</tool>",
    "</tool_use>",
  ].join("\n"));

  assert.deepEqual(parsed.toolCalls.map((call) => call.name), [
    "spawn_subagent",
    "spawn_subagent",
    "wait_subagents",
  ]);
  assert.equal(parsed.toolCalls[0].arguments.task_key, "frontend-title-chain");
  assert.equal(parsed.toolCalls[1].arguments.task_key, "tauri-open-dialog-chain");
  assert.equal(parsed.toolCalls[0].arguments.access_mode, "read");
});

test("parses Gemma OMLX text tool tokens as executable calls", () => {
  const parsed = parseTextForTools([
    "<|tool_call>call:get_file_outline{path: 'src/hooks/useCsvParser.ts'}",
    '<|tool_call>call:code_ast_query{path: "src/hooks/useChartData.ts", query: "creatorName"}',
  ].join("\n"));

  assert.deepEqual(parsed.toolCalls.map((call) => call.name), [
    "get_file_outline",
    "code_ast_query",
  ]);
  assert.deepEqual(parsed.toolCalls[0].arguments, {
    path: "src/hooks/useCsvParser.ts",
  });
  assert.deepEqual(parsed.toolCalls[1].arguments, {
    path: "src/hooks/useChartData.ts",
    query: "creatorName",
  });
  assert.equal(parsed.cleanText, "");
});

test("parses a complete one-shot semantic spawn from plain-text tool tokens", () => {
  const parsed = parseTextForTools(
    "<|tool_call>call:spawn_subagent{" +
      "task_key: 'title-state-chain'," +
      "task_kind: 'explore'," +
      "objective: 'Trace the dirty title projection'," +
      "delegation_reason: 'The UI state chain can be diagnosed independently'," +
      "success_criteria: 'Identify the state owner and final render projection'," +
      "required_paths: 'src/main.js'," +
      "allowed_paths: 'src/main.js,src/components'," +
      "access_mode: 'read'," +
      "expected_output: 'Evidence-backed findings with exact paths'" +
    "}",
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "spawn_subagent");
  assert.deepEqual(parsed.toolCalls[0].arguments, {
    task_key: "title-state-chain",
    task_kind: "explore",
    objective: "Trace the dirty title projection",
    delegation_reason: "The UI state chain can be diagnosed independently",
    success_criteria: "Identify the state owner and final render projection",
    required_paths: "src/main.js",
    allowed_paths: "src/main.js,src/components",
    access_mode: "read",
    expected_output: "Evidence-backed findings with exact paths",
  });
  assert.equal(parsed.cleanText, "");
});

test("parses a complete Gemma text mutation when replacement source contains braces and quotes", () => {
  const newContent = [
    "export function updateFileInfo(filePath, isDirty = false) {",
    "  const fileInfo = document.getElementById('file-info');",
    "  if (fileInfo) {",
    "    fileInfo.textContent = filePath ? filePath.split('/').pop() : '未打开文件';",
    "  }",
    "}",
  ].join("\n");
  const oldContent = [
    "export function updateFileInfo(filePath) {",
    "  const fileInfo = document.getElementById('file-info');",
    "  if (fileInfo) {",
    "    fileInfo.textContent = filePath;",
    "  }",
    "}",
  ].join("\n");
  const parsed = parseTextForTools(
    `<|tool_call>call:replace_in_file{new_content: '${newContent}',old_content: '${oldContent}',target: 'src/components/statusbar.js'}`,
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "replace_in_file");
  assert.deepEqual(parsed.toolCalls[0].arguments, {
    new_content: newContent,
    old_content: oldContent,
    target: "src/components/statusbar.js",
  });
  assert.equal(parsed.cleanText, "");
});

test("incident-shaped Gemma mutation remains executable through normalization and recovery selection", () => {
  const parsed = parseTextForTools(
    [
      "<|tool_call>call:replace_in_file{",
      "new_content: 'export function updateFileInfo(filePath) {",
      "  const title = filePath ? filePath.split('/').pop() : '未打开文件';",
      "  return { title, dirty: false };",
      "}',",
      "old_content: 'export function updateFileInfo(filePath) {",
      "  return { title: filePath };",
      "}',",
      "target: 'src/components/statusbar.js'",
      "}",
    ].join("\n"),
  );

  assert.equal(parsed.toolCalls.length, 1);
  const call = parsed.toolCalls[0];
  const args = normalizeToolCallForExecution(
    call.name,
    call.arguments,
    "/workspace",
  );
  assert.equal(args.path, "src/components/statusbar.js");
  assert.match(String(args.search_text), /title: filePath/);
  assert.match(String(args.replace_text), /dirty: false/);

  const decision = resolveExecuteRecoveryBatchDecision({
    mode: "mutation_first",
    expectedTarget: "src/components/statusbar.js",
    calls: [{
      id: call.id,
      name: call.name,
      target: String(args.path || ""),
    }],
  });
  assert.equal(decision.phase, "need_mutation");
  assert.equal(decision.selectedCallId, call.id);
  assert.deepEqual(decision.deferredCallIds, []);
});

test("parses local-model knowledge search calls", () => {
  const parsed = parseTextForTools('knowledge_search("Unity Rigidbody AddForce")');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "knowledge_search");
  assert.deepEqual(parsed.toolCalls[0].arguments, { query: "Unity Rigidbody AddForce" });
  assert.equal(parsed.cleanText, "");
});

test("parses <tool_code> wrapper into a real tool call and strips wrapper text", () => {
  const parsed = parseTextForTools([
    "先看项目目录。",
    "<tool_code>",
    "list_directory(\"src\")",
    "</tool_code>",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "list_directory");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "src" });
  assert.match(parsed.cleanText, /先看项目目录/);
  assert.doesNotMatch(parsed.cleanText, /tool_code|list_directory\(\"src\"\)/i);
});

test("recovers malformed tool_use with tool name in a parameter", () => {
  const parsed = parseTextForTools([
    "<tool_use>",
    "<parameter name=\"path\">/Users/michael/Desktop/DataFiles/cn_tutorial_orders_by_creator_20260512.csv</parameter>",
    "<parameter name=\"query\">SELECT DISTINCT \"课程名称\" FROM \"cn_tutorial_orders_by_creator_20260512.csv\" LIMIT 20</parameter>",
    "<parameter name=\"tool\">query_tabular_document</parameter>",
    "</tool_use>",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "query_tabular_document");
  assert.deepEqual(parsed.toolCalls[0].arguments, {
    path: "/Users/michael/Desktop/DataFiles/cn_tutorial_orders_by_creator_20260512.csv",
    query: "SELECT DISTINCT \"课程名称\" FROM \"cn_tutorial_orders_by_creator_20260512.csv\" LIMIT 20",
  });
  assert.equal("tool" in parsed.toolCalls[0].arguments, false);
  assert.equal(parsed.cleanText, "");
});

test("strips tool name recovery fields from XML execution arguments", () => {
  const parsed = parseTextForTools([
    "<tool_use>",
    "<tool>query_tabular_document</tool>",
    "<parameter name=\"tool\">query_tabular_document</parameter>",
    "<parameter name=\"name\">query_tabular_document</parameter>",
    "<parameter name=\"function\">query_tabular_document</parameter>",
    "<parameter name=\"path\">orders.csv</parameter>",
    "<parameter name=\"query\">SELECT COUNT(*) FROM orders</parameter>",
    "</tool_use>",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "query_tabular_document");
  assert.deepEqual(parsed.toolCalls[0].arguments, {
    path: "orders.csv",
    query: "SELECT COUNT(*) FROM orders",
  });
});

test("does not recover malformed tool_use with an unknown tool name", () => {
  const parsed = parseTextForTools([
    "<tool_use>",
    "<parameter name=\"path\">orders.csv</parameter>",
    "<parameter name=\"tool\">not_a_real_tool</parameter>",
    "</tool_use>",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.cleanText, "");
});

test("parses bare tool name followed by path and key-value arguments", () => {
  const parsed = parseTextForTools([
    "read_file",
    "/Users/michael/Documents/GitHub/MAIN/src/lib/orchestrator.ts",
    "max_lines=100",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "read_file");
  assert.deepEqual(parsed.toolCalls[0].arguments, {
    path: "/Users/michael/Documents/GitHub/MAIN/src/lib/orchestrator.ts",
    max_lines: 100,
  });
  assert.equal(parsed.cleanText, "");
});

test("strips malformed parameter fragments from visible text", () => {
  const visibleText = sanitizeAIOutput([
    "准备读取文件。",
    "</parametermax_lines\">100",
    "path=src/lib/orchestrator.ts",
  ].join("\n"));

  assert.equal(visibleText, "准备读取文件。");
});

test("parses bare get_project_skeleton as a tool call", () => {
  const parsed = parseTextForTools("get_project_skeleton");

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "get_project_skeleton");
  assert.deepEqual(parsed.toolCalls[0].arguments, {});
  assert.equal(parsed.cleanText, "");
});

test("parses web_search and web_fetch XML blocks successfully", () => {
  const parsedSearch = parseTextForTools([
    "<tool_use>",
    "<tool>web_search</tool>",
    "<parameter name=\"query\">weather in Shenyang</parameter>",
    "</tool_use>",
  ].join("\n"));

  assert.equal(parsedSearch.toolCalls.length, 1);
  assert.equal(parsedSearch.toolCalls[0].name, "web_search");
  assert.deepEqual(parsedSearch.toolCalls[0].arguments, { query: "weather in Shenyang" });

  const parsedFetch = parseTextForTools([
    "<tool_use>",
    "<tool>web_fetch</tool>",
    "<parameter name=\"url\">https://example.com</parameter>",
    "</tool_use>",
  ].join("\n"));

  assert.equal(parsedFetch.toolCalls.length, 1);
  assert.equal(parsedFetch.toolCalls[0].name, "web_fetch");
  assert.deepEqual(parsedFetch.toolCalls[0].arguments, { url: "https://example.com" });
});

test("recovers bare web_search and web_fetch using preceding prose line fallbacks", () => {
  const parsedSearch = parseTextForTools([
    "我来帮你查询沈阳未来一周的天气情况。",
    "",
    "web_search",
  ].join("\n"));

  assert.equal(parsedSearch.toolCalls.length, 1);
  assert.equal(parsedSearch.toolCalls[0].name, "web_search");
  assert.deepEqual(parsedSearch.toolCalls[0].arguments, { query: "沈阳未来一周的天气情况" });

  const parsedFetch = parseTextForTools([
    "让我获取 https://example.com/api/v1 的内容。",
    "",
    "web_fetch",
  ].join("\n"));

  assert.equal(parsedFetch.toolCalls.length, 1);
  assert.equal(parsedFetch.toolCalls[0].name, "web_fetch");
  assert.deepEqual(parsedFetch.toolCalls[0].arguments, { url: "https://example.com/api/v1" });
});
