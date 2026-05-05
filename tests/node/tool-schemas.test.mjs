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
});

test("read_file schema exposes line-window parameters and does not promise full-file reads", () => {
  const tools = buildToolDefinitions([]);
  const readFile = tools.find((tool) => tool.function.name === "read_file");

  assert.ok(readFile);
  assert.match(readFile.function.description, /内容窗口/);
  assert.match(readFile.function.description, /truncated/);
  assert.doesNotMatch(readFile.function.description, /^读取文件完整内容$/);
  assert.ok(readFile.function.parameters.properties.start_line);
  assert.ok(readFile.function.parameters.properties.end_line);
  assert.ok(readFile.function.parameters.properties.max_lines);
  assert.deepEqual(readFile.function.parameters.required, ["path"]);
});
