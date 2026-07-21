import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const workspaceRoot = process.cwd();
const sourcePath = path.join(workspaceRoot, "src/lib/toolCallNormalization.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
new Function("exports", "module", transpiled)(module.exports, module);

const { normalizeToolCallForExecution } = module.exports;
const workspace = "/Users/example/Documents/Vibe Coding Projects/MD Viewer";

test("shell normalization converts a literal leading workspace cd into structured cwd", () => {
  assert.deepEqual(
    normalizeToolCallForExecution("run_command", {
      command: `cd "${workspace}" && grep -n "未命名文档" src/main.js`,
      description: "verify title changes",
    }, workspace),
    {
      command: 'grep -n "未命名文档" src/main.js',
      description: "verify title changes",
      cwd: ".",
    },
  );

  assert.deepEqual(
    normalizeToolCallForExecution("run_command", {
      command: "cd src-tauri && cargo check",
      description: "check Rust",
      cwd: ".",
    }, workspace),
    {
      command: "cargo check",
      description: "check Rust",
      cwd: "src-tauri",
    },
  );
});

test("shell normalization leaves dynamic and out-of-workspace cd for Rust to reject", () => {
  for (const command of [
    "cd $TARGET && npm test",
    "cd ../outside && npm test",
    "cd /tmp/outside && npm test",
    "cd \"/tmp/outside\" && npm test",
  ]) {
    const normalized = normalizeToolCallForExecution("run_command", {
      command,
      description: "unsafe cwd remains visible",
    }, workspace);
    assert.equal(normalized.command, command);
    assert.equal(normalized.cwd, undefined);
  }
});
