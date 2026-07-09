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
  looksLongRunningShellCommand,
  validateShellToolContract,
} = await loadToolExecutionContractModule();

test("shell contract rejects missing description and validates cwd metadata", () => {
  assert.match(
    validateShellToolContract("run_command", { command: "npm test", cwd: "." }),
    /description/,
  );
  assert.equal(
    validateShellToolContract("run_command", { command: "npm test", description: "Run tests" }),
    null,
  );
  assert.equal(
    validateShellToolContract("execute_command", { command: "npm test", description: "Run tests" }),
    null,
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

test("run_command rejects long-running dev servers and watchers", () => {
  assert.equal(looksLongRunningShellCommand("npm run tauri dev"), true);
  assert.equal(looksLongRunningShellCommand("pnpm run dev"), true);
  assert.equal(looksLongRunningShellCommand("vite --host 127.0.0.1"), true);
  assert.equal(looksLongRunningShellCommand("next dev"), true);
  assert.equal(looksLongRunningShellCommand("next start"), true);
  assert.equal(looksLongRunningShellCommand("storybook dev --port 6006"), true);
  assert.equal(looksLongRunningShellCommand("npm run build"), false);
  assert.equal(looksLongRunningShellCommand("vite build"), false);
  assert.equal(looksLongRunningShellCommand("next build"), false);
  assert.equal(looksLongRunningShellCommand("storybook build"), false);
  assert.match(
    validateShellToolContract("run_command", {
      command: "npm run tauri dev",
      description: "Start the desktop dev server",
      cwd: ".",
    }),
    /execute_command/,
  );
  assert.equal(
    validateShellToolContract("execute_command", {
      command: "npm run tauri dev",
      description: "Start the desktop dev server",
      cwd: ".",
    }),
    null,
  );
});
