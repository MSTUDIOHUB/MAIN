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

test("provider tool batches execute one action before Runtime v2 decides again", () => {
  const bounded = surface.boundRuntimeV2ProviderToolCalls([
    call("read_file"),
    call("replace_in_file"),
    call("run_command"),
  ]);
  assert.deepEqual(bounded.accepted.map((item) => item.name), ["read_file"]);
  assert.deepEqual(
    bounded.discarded.map((item) => item.name),
    ["replace_in_file", "run_command"],
  );
  assert.equal(bounded.selection, "first");
});

test("provider tool batches skip a regenerated stale head for the first novel action", () => {
  const repeated = {
    id: "read-again",
    name: "read_file",
    arguments: { path: "src/main.js" },
  };
  const contract = {
    id: "contract",
    name: "submit_execution_contract",
    arguments: { targets: [{ path: "src/main.js", operation: "modify" }] },
  };
  const bounded = surface.boundRuntimeV2ProviderToolCalls(
    [repeated, contract],
    new Set([surface.runtimeV2ProviderToolCallIdentity(repeated)]),
  );
  assert.deepEqual(
    bounded.accepted.map((item) => item.name),
    ["submit_execution_contract"],
  );
  assert.deepEqual(
    bounded.discarded.map((item) => item.name),
    ["read_file"],
  );
  assert.equal(bounded.selection, "first_novel_after_attempt");
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
      requiresMutation: false,
    }).map((item) => item.function.name),
    ["read_file", "grep_search"],
  );
  assert.deepEqual(
    surface.selectRuntimeV2ExecuteToolDefinitions({
      available,
      sourceToolNames,
      isMutationToolName,
      requiresFreshSourceReads: false,
      requiresMutation: false,
    }).map((item) => item.function.name),
    ["read_file", "grep_search", "apply_patch"],
  );
});

test("Execute keeps safe reads beside leased mutations after its source-gap pass", () => {
  const available = [
    definition("read_file"),
    definition("grep_search"),
    definition("apply_patch"),
    definition("replace_in_file"),
    definition("write_file"),
    definition("run_command"),
  ];
  assert.deepEqual(
    surface.selectRuntimeV2ExecuteToolDefinitions({
      available,
      sourceToolNames: new Set(["read_file", "grep_search"]),
      isMutationToolName: (name) =>
        name === "apply_patch" ||
        name === "replace_in_file" ||
        name === "write_file",
      createOnlyMutationToolNames: new Set(["write_file"]),
      requiresFreshSourceReads: false,
      requiresMutation: true,
    }).map((item) => item.function.name),
    ["read_file", "grep_search", "apply_patch", "replace_in_file"],
  );
});
