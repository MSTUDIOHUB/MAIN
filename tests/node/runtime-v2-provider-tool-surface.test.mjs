import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const sourcePath = path.join(
  process.cwd(),
  "src/store/runtimeV2/providerToolSurface.ts",
);
const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
new Function("exports", "module", output)(module.exports, module);
const surface = module.exports;

const definition = (name) => ({ function: { name } });
const call = (name) => ({ id: `call-${name}`, name, arguments: {} });

test("provider results cannot widen the current Runtime v2 phase tool surface", () => {
  assert.deepEqual(
    surface.unexpectedRuntimeV2ProviderToolNames(
      [definition("apply_patch"), definition("replace_in_file")],
      [call("apply_patch")],
    ),
    [],
  );
  assert.deepEqual(
    surface.unexpectedRuntimeV2ProviderToolNames(
      [definition("apply_patch")],
      [call("read_file"), call("read_file"), call("run_command")],
    ),
    ["read_file", "run_command"],
  );
  assert.deepEqual(
    surface.unexpectedRuntimeV2ProviderToolNames([], [call("read_file")]),
    ["read_file"],
  );
});

test("Execute keeps safe reads available beside mutations after source freshness", () => {
  const available = [
    definition("read_file"),
    definition("grep_search"),
    definition("apply_patch"),
    definition("run_command"),
  ];
  const sourceToolNames = new Set(["read_file", "grep_search"]);
  const isMutationToolName = (name) => name === "apply_patch";
  assert.deepEqual(
    surface.selectRuntimeV2ExecuteToolDefinitions({
      available,
      sourceToolNames,
      isMutationToolName,
      requiresFreshSourceReads: true,
    }).map((item) => item.function.name),
    ["read_file", "grep_search"],
  );
  assert.deepEqual(
    surface.selectRuntimeV2ExecuteToolDefinitions({
      available,
      sourceToolNames,
      isMutationToolName,
      requiresFreshSourceReads: false,
    }).map((item) => item.function.name),
    ["read_file", "grep_search", "apply_patch"],
  );
});
