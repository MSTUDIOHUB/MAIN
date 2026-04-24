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
