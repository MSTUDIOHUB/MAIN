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

const {
  buildToolDefinitions,
  normalizeToolParametersSchema,
  normalizeToolDefinition,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolSchemas.ts"));

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

test("typed Plan submission schema carries the complete provider-neutral graph", () => {
  const tools = buildToolDefinitions([]);
  const submit = tools.find((tool) =>
    tool.function.name === "submit_plan_candidate"
  );

  assert.ok(submit);
  assert.deepEqual(submit.function.parameters.required, [
    "schemaVersion",
    "evidenceRefs",
    "goalEvidenceBases",
    "summary",
    "diagnoses",
    "changes",
    "decisions",
    "interfaces",
    "validations",
    "assumptions",
    "blockingChoices",
  ]);
  const properties = submit.function.parameters.properties;
  assert.equal(properties.diagnoses.type, "array");
  assert.equal(properties.diagnoses.items.type, "object");
  assert.deepEqual(properties.diagnoses.items.properties.certainty.enum, [
    "observed",
    "inferred",
    "hypothesis",
  ]);
  assert.deepEqual(properties.goalEvidenceBases.items.required, [
    "goalRef",
    "componentRef",
    "evidenceRefs",
    "ownerRefs",
    "relationRefs",
    "diagnosisRefs",
  ]);
  assert.equal(properties.changes.items.properties.evidenceRefs.items.type, "string");
  const plannedHarness = properties.changes.items.properties.plannedValidationHarness;
  assert.deepEqual(plannedHarness.required, ["surface", "ownerRef", "binding"]);
  assert.deepEqual(
    plannedHarness.properties.binding.oneOf.map((branch) => branch.properties.kind.enum[0]),
    ["direct_target", "manifest_script"],
  );
  assert.equal(properties.validations.items.properties.harnessChangeRef.type, "string");
  const primitive = properties.validations.items.properties.primitive;
  assert.equal(primitive.type, undefined);
  assert.equal(primitive.oneOf.length, 6);
  const branchByKind = new Map(primitive.oneOf.map((branch) => [
    branch.properties.kind.enum[0],
    branch,
  ]));
  assert.deepEqual([...branchByKind.keys()], [
    "finite_command",
    "service_observation",
    "browser_interaction",
    "desktop_interaction",
    "assertion",
    "advisory",
  ]);
  assert.deepEqual(branchByKind.get("finite_command").required, ["kind", "command"]);
  assert.deepEqual(branchByKind.get("service_observation").required, [
    "kind",
    "launchCommand",
    "ownerKey",
    "readiness",
  ]);
  assert.deepEqual(branchByKind.get("assertion").required, [
    "kind",
    "acceptance",
    "target",
    "matcher",
    "producer",
  ]);
  assert.deepEqual(branchByKind.get("advisory").required, ["kind", "note"]);
  assert.deepEqual(branchByKind.get("assertion").properties.acceptance.enum, ["advisory"]);

  const browser = branchByKind.get("browser_interaction").properties;
  const desktop = branchByKind.get("desktop_interaction").properties;
  assert.ok(browser.actions.items.required.includes("id"));
  assert.ok(browser.actions.items.properties.kind.enum.includes("click"));
  assert.ok(browser.actions.items.properties.kind.enum.includes("navigate"));
  assert.ok(!browser.actions.items.properties.kind.enum.includes("open"));
  assert.ok(desktop.actions.items.properties.kind.enum.includes("open"));
  assert.ok(browser.assertions.items.properties.kind.enum.includes("visibility"));
  assert.ok(browser.assertions.items.properties.kind.enum.includes("dialog"));
  assert.equal(browser.assertions.minItems, 1);
  assert.match(browser.assertions.items.properties.afterActionId.description, /caus/i);

  const scalarTypes = (schema) => schema.anyOf.map((entry) => entry.type);
  assert.deepEqual(
    scalarTypes(branchByKind.get("service_observation").properties.readiness.properties.expected),
    ["string", "number", "boolean"],
  );
  assert.deepEqual(
    scalarTypes(browser.assertions.items.properties.expected),
    ["string", "number", "boolean", "null"],
  );
  assert.deepEqual(
    scalarTypes(branchByKind.get("assertion").properties.expected),
    ["string", "number", "boolean", "null"],
  );
  assert.match(submit.function.description, /never writes files/i);
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
  assert.match(browserEvaluate.function.parameters.properties.screenshot.description, /默认 true/);
  assert.match(browserEvaluate.function.parameters.properties.timeout_ms.description, /默认 15000/);
});

test("desktop control schema exposes only constrained accessibility actions", () => {
  const tools = buildToolDefinitions([]);
  const computerUse = tools.find((tool) => tool.function.name === "computer_use");

  assert.ok(computerUse);
  assert.match(computerUse.function.description, /Accessibility API/);
  assert.match(computerUse.function.description, /每次需要桌面控制审批/);
  assert.deepEqual(computerUse.function.parameters.required, ["app_name"]);
  assert.ok(computerUse.function.parameters.properties.actions);
  assert.ok(computerUse.function.parameters.properties.checks);
  assert.ok(computerUse.function.parameters.properties.app_path);
  assert.match(computerUse.function.parameters.properties.actions.description, /Accessibility 标签而非坐标/);
  assert.match(computerUse.function.parameters.properties.checks.description, /动作前为假、动作后为真/);
  assert.match(computerUse.function.parameters.properties.screenshot.description, /默认 false/);
  assert.equal(computerUse.function.parameters.properties.script, undefined);
  assert.equal(computerUse.function.parameters.properties.command, undefined);
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

test("Tree-sitter AST and native Git inspection schemas are exposed as bounded read-only tools", () => {
  const tools = buildToolDefinitions([]);
  const byName = new Map(tools.map((tool) => [tool.function.name, tool]));
  const ast = byName.get("code_ast_query");
  const references = byName.get("find_symbol_references");
  const gitStatus = byName.get("git_status");
  const gitDiff = byName.get("git_diff");

  assert.ok(ast);
  assert.ok(references);
  assert.ok(gitStatus);
  assert.ok(gitDiff);
  assert.deepEqual(ast.function.parameters.required, ["path"]);
  assert.deepEqual(references.function.parameters.required, ["symbol"]);
  assert.ok(ast.function.parameters.properties.max_results);
  assert.ok(references.function.parameters.properties.max_results);
  assert.ok(gitDiff.function.parameters.properties.max_chars);
  assert.match(ast.function.description, /Tree-sitter/);
  assert.match(references.function.description, /语法级/);
  assert.match(gitStatus.function.description, /原生 Git/);
  assert.match(gitDiff.function.description, /HEAD/);
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
  assert.ok(readFile.function.parameters.properties.start_char);
  assert.ok(readFile.function.parameters.properties.max_chars);
  assert.match(
    readFile.function.parameters.properties.start_char.description,
    /0-based/,
  );
  assert.deepEqual(readFile.function.parameters.required, ["path"]);
});
