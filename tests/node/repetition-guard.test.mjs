import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadRepetitionGuardModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/repetitionGuard.ts");
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
  buildRepeatLoopArgsKey,
  formatRepeatLoopFatalMessage,
  formatRepeatLoopRecoveryMessage,
  registerToolCallForRepeatGuard,
} = await loadRepetitionGuardModule();

test("repeat guard normalizes argument ordering", () => {
  const keyA = buildRepeatLoopArgsKey({ path: "src-tauri", depth: 3 });
  const keyB = buildRepeatLoopArgsKey({ depth: 3, path: "src-tauri" });
  assert.equal(keyA, keyB);
});

test("repeat guard uses a higher threshold for read-only tools", () => {
  const history = [];
  let result = null;

  for (let i = 0; i < 6; i += 1) {
    result = registerToolCallForRepeatGuard(history, "list_directory", { path: "src-tauri" }, true);
  }

  assert.equal(result.repeated, true);
  assert.equal(result.threshold, 6);
});

test("repeat guard keeps write tools on the stricter threshold", () => {
  const history = [];
  let result = null;

  for (let i = 0; i < 3; i += 1) {
    result = registerToolCallForRepeatGuard(history, "write_file", { path: "a.txt" }, false);
  }

  assert.equal(result.repeated, true);
  assert.equal(result.threshold, 3);
});

test("repeat guard messages include the actual threshold and target", () => {
  const recovery = formatRepeatLoopRecoveryMessage("list_directory", "src-tauri", 6);
  const fatal = formatRepeatLoopFatalMessage("write_file", "notes.md", 3);

  assert.match(recovery, /6\+ times/);
  assert.match(recovery, /src-tauri/);
  assert.match(fatal, /3\+ times/);
  assert.match(fatal, /notes\.md/);
});
