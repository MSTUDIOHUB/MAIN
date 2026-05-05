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
  formatTargetProgressLoopRecoveryMessage,
  isReadOnlyShellInspectionToolCall,
  registerTargetProgressForLoopGuard,
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

test("repeat guard treats read-only shell inspection commands as recoverable reads", () => {
  const args = {
    command: "sed -n '1690,1700p' /Users/michael/Documents/GitHub/MAIN/src-tauri/src/lib.rs",
  };
  const history = [];
  let result = null;

  assert.equal(isReadOnlyShellInspectionToolCall("run_command", args), true);
  for (let i = 0; i < 6; i += 1) {
    result = registerToolCallForRepeatGuard(
      history,
      "run_command",
      args,
      isReadOnlyShellInspectionToolCall("run_command", args),
    );
  }

  assert.equal(result.repeated, true);
  assert.equal(result.threshold, 6);
});

test("repeat guard keeps non-inspection shell commands on the strict threshold", () => {
  const args = { command: "npm test" };
  const history = [];
  let result = null;

  assert.equal(isReadOnlyShellInspectionToolCall("run_command", args), false);
  for (let i = 0; i < 3; i += 1) {
    result = registerToolCallForRepeatGuard(
      history,
      "run_command",
      args,
      isReadOnlyShellInspectionToolCall("run_command", args),
    );
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

test("target progress guard catches repeated edits to the same target even with different content", () => {
  const history = [];
  let result = null;

  for (const tool of ["replace_in_file", "write_file", "replace_in_file", "replace_in_file"]) {
    result = registerTargetProgressForLoopGuard(history, tool, "src/App.tsx");
  }

  assert.equal(result.repeated, true);
  assert.equal(result.threshold, 4);
  assert.equal(result.family, "edit");

  const recovery = formatTargetProgressLoopRecoveryMessage(result.family, result.targetKey, result.threshold);
  assert.match(recovery, /Progress guard/);
  assert.match(recovery, /src\/app\.tsx/);
});
