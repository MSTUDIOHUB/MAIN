import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadToolExecutionContractModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/toolExecutionContract.ts");
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
  applyShellCwd,
  looksDangerousShellCommand,
  validateShellToolContract,
} = await loadToolExecutionContractModule();

test("shell contract rejects missing description and cwd metadata", () => {
  assert.match(
    validateShellToolContract("run_command", { command: "npm test", cwd: "." }),
    /description/,
  );
  assert.match(
    validateShellToolContract("run_command", { command: "npm test", description: "Run tests" }),
    /cwd/,
  );
  assert.equal(
    validateShellToolContract("run_command", { command: "npm test", description: "Run tests", cwd: "." }),
    null,
  );
});

test("shell cwd is workspace-relative and can be applied to commands", () => {
  assert.match(
    validateShellToolContract("execute_command", { command: "npm run dev", description: "Start dev server", cwd: "../MAIN" }),
    /cannot contain/,
  );
  assert.equal(
    applyShellCwd("npm test", { cwd: "apps/web", description: "Run tests" }),
    "cd 'apps/web' && npm test",
  );
});

test("dangerous shell detection catches destructive command shapes", () => {
  assert.equal(looksDangerousShellCommand("git reset --hard HEAD"), true);
  assert.equal(looksDangerousShellCommand("rm -rf dist"), true);
  assert.equal(looksDangerousShellCommand("git status --short"), false);
});
