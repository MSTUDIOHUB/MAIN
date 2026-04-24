import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadProtocolPackagesModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/protocolPackages.ts");
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
  getProtocolPackageEntryPath,
  resolveProtocolPackageReadPath,
} = await loadProtocolPackagesModule();

const workspace = "/Users/michael/Documents/GitHub/MAIN";

test("protocol packages expose a fully qualified entry path", () => {
  assert.equal(
    getProtocolPackageEntryPath({
      packagePath: ".protocols/Auto-Optimize-main-1776311699903/Auto-Optimize-main",
      entryPoint: "SKILL.md",
    }),
    ".protocols/Auto-Optimize-main-1776311699903/Auto-Optimize-main/SKILL.md",
  );
});

test("protocol entry lookup resolves a bare SKILL.md to the active package entry path", () => {
  const resolved = resolveProtocolPackageReadPath("SKILL.md", [
    {
      active: true,
      type: "package",
      packagePath: ".protocols/Auto-Optimize-main-1776311699903/Auto-Optimize-main",
      entryPoint: "SKILL.md",
      workspaceScope: workspace,
    },
  ], workspace);

  assert.equal(
    resolved,
    ".protocols/Auto-Optimize-main-1776311699903/Auto-Optimize-main/SKILL.md",
  );
});

test("protocol entry lookup leaves ambiguous bare names unchanged", () => {
  const resolved = resolveProtocolPackageReadPath("SKILL.md", [
    {
      active: true,
      type: "package",
      packagePath: ".protocols/one",
      entryPoint: "SKILL.md",
      workspaceScope: workspace,
    },
    {
      active: true,
      type: "package",
      packagePath: ".protocols/two",
      entryPoint: "SKILL.md",
      workspaceScope: workspace,
    },
  ], workspace);

  assert.equal(resolved, "SKILL.md");
});

test("protocol entry lookup resolves a nested entry by basename when unique", () => {
  const resolved = resolveProtocolPackageReadPath("program.md", [
    {
      active: true,
      type: "package",
      packagePath: ".protocols/my-protocol",
      entryPoint: "docs/program.md",
      workspaceScope: workspace,
    },
  ], workspace);

  assert.equal(resolved, ".protocols/my-protocol/docs/program.md");
});

test("protocol entry lookup does not rewrite normal workspace file paths", () => {
  const resolved = resolveProtocolPackageReadPath("src/App.tsx", [
    {
      active: true,
      type: "package",
      packagePath: ".protocols/Auto-Optimize-main-1776311699903/Auto-Optimize-main",
      entryPoint: "SKILL.md",
      workspaceScope: workspace,
    },
  ], workspace);

  assert.equal(resolved, "src/App.tsx");
});
