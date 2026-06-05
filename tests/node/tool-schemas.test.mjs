import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadToolSchemasModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/toolSchemas.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, require);
  return module.exports;
}

const {
  buildToolDefinitions,
  normalizeToolParametersSchema,
  normalizeToolDefinition,
} = await loadToolSchemasModule();

test("tool schema normalization patches description-only leaf fields", () => {
  const schema = normalizeToolParametersSchema({
    type: "object",
    properties: {
      query: {
        description: "Search string without explicit type",
      },
      nested: {
        type: "object",
        properties: {
          mode: {
            description: "Nested field should also become string",
          },
        },
      },
    },
    required: [],
  });

  assert.equal(schema.properties.query.type, "string");
  assert.equal(schema.properties.nested.properties.mode.type, "string");
});

test("tool definition normalization fills missing object properties", () => {
  const tool = normalizeToolDefinition({
    type: "function",
    function: {
      name: "example_tool",
      description: "Example",
      parameters: {
        type: "object",
        description: "root object",
      },
    },
  });

  assert.deepEqual(tool.function.parameters.properties, {});
  assert.deepEqual(tool.function.parameters.required, []);
});

test("shell tool schemas require execution descriptions and expose cwd metadata", () => {
  const tools = buildToolDefinitions([]);
  const runCommand = tools.find((tool) => tool.function.name === "run_command");
  const executeCommand = tools.find((tool) => tool.function.name === "execute_command");

  assert.ok(runCommand);
  assert.ok(executeCommand);
  assert.ok(runCommand.function.parameters.required.includes("description"));
  assert.ok(executeCommand.function.parameters.required.includes("description"));
  assert.ok(runCommand.function.parameters.properties.cwd);
  assert.ok(runCommand.function.parameters.properties.workdir);
  assert.ok(executeCommand.function.parameters.properties.cwd);
  assert.ok(executeCommand.function.parameters.properties.wait_ms);
  assert.ok(executeCommand.function.parameters.properties.max_chars);
});

test("browser validation schema exposes local Playwright checks", () => {
  const tools = buildToolDefinitions([]);
  const browserEvaluate = tools.find((tool) => tool.function.name === "browser_evaluate");

  assert.ok(browserEvaluate);
  assert.match(browserEvaluate.function.description, /Playwright/);
  assert.match(browserEvaluate.function.description, /localhost/);
  assert.deepEqual(browserEvaluate.function.parameters.required, ["url"]);
  assert.ok(browserEvaluate.function.parameters.properties.actions);
  assert.ok(browserEvaluate.function.parameters.properties.checks);
  assert.ok(browserEvaluate.function.parameters.properties.wait_for_text);
  assert.ok(browserEvaluate.function.parameters.properties.screenshot);
});

test("repo_map and apply_patch schemas are exposed for built-in code intelligence and edits", () => {
  const tools = buildToolDefinitions([]);
  const names = new Set(tools.map((tool) => tool.function.name));
  assert.equal(names.has("repo_map_search"), true);
  assert.equal(names.has("repo_map_context"), true);
  assert.equal(names.has("repo_map_impact"), true);
  assert.equal(names.has("apply_patch"), true);

  const applyPatch = tools.find((tool) => tool.function.name === "apply_patch");
  assert.deepEqual(applyPatch.function.parameters.required, ["patch"]);
  assert.match(applyPatch.function.description, /Codex/);
});

test("web search schemas expose free external read tools", () => {
  const tools = buildToolDefinitions([]);
  const webSearch = tools.find((tool) => tool.function.name === "web_search");
  const webFetch = tools.find((tool) => tool.function.name === "web_fetch");

  assert.ok(webSearch);
  assert.ok(webFetch);
  assert.deepEqual(webSearch.function.parameters.required, ["query"]);
  assert.ok(webSearch.function.parameters.properties.provider);
  assert.ok(webSearch.function.parameters.properties.max_results);
  assert.deepEqual(webFetch.function.parameters.required, ["url"]);
  assert.ok(webFetch.function.parameters.properties.max_chars);
  assert.match(webFetch.function.description, /GitHub/);
});

test("knowledge base schemas expose local RAG search tools", () => {
  const tools = buildToolDefinitions([]);
  const knowledgeSearch = tools.find((tool) => tool.function.name === "knowledge_search");
  const knowledgeExcerpt = tools.find((tool) => tool.function.name === "knowledge_get_excerpt");

  assert.ok(knowledgeSearch);
  assert.ok(knowledgeExcerpt);
  assert.deepEqual(knowledgeSearch.function.parameters.required, ["query"]);
  assert.ok(knowledgeSearch.function.parameters.properties.kb_ids);
  assert.ok(knowledgeSearch.function.parameters.properties.limit);
  assert.deepEqual(knowledgeExcerpt.function.parameters.required, ["source_id", "chunk_id"]);
});

test("pty observation schemas expose wait controls", () => {
  const tools = buildToolDefinitions([]);
  const readSince = tools.find((tool) => tool.function.name === "read_pty_since");
  const readTail = tools.find((tool) => tool.function.name === "read_pty_tail");
  const status = tools.find((tool) => tool.function.name === "get_pty_status");

  assert.ok(readSince.function.parameters.properties.wait_ms);
  assert.ok(readTail.function.parameters.properties.wait_ms);
  assert.ok(status.function.parameters.properties.wait_ms);
});

test("read_file schema exposes line-window parameters and does not promise full-file reads", () => {
  const tools = buildToolDefinitions([]);
  const readFile = tools.find((tool) => tool.function.name === "read_file");

  assert.ok(readFile);
  assert.match(readFile.function.description, /内容窗口/);
  assert.match(readFile.function.description, /工作区外/);
  assert.match(readFile.function.description, /用户授权/);
  assert.match(readFile.function.description, /truncated/);
  assert.doesNotMatch(readFile.function.description, /^读取文件完整内容$/);
  assert.ok(readFile.function.parameters.properties.start_line);
  assert.ok(readFile.function.parameters.properties.end_line);
  assert.ok(readFile.function.parameters.properties.max_lines);
  assert.deepEqual(readFile.function.parameters.required, ["path"]);
});
