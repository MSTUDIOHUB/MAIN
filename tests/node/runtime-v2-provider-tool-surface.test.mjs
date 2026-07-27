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
