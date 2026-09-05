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
  isProtocolPackageApplicableToWorkspace,
  isSafeProtocolPackagePath,
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

test("protocol package paths reject traversal and absolute entry points", () => {
  assert.equal(isSafeProtocolPackagePath(".protocols/reviewer", "SKILL.md"), true);
  assert.equal(isSafeProtocolPackagePath(".protocols/../src", "SKILL.md"), false);
  assert.equal(isSafeProtocolPackagePath(".protocols/reviewer", "../secret.md"), false);
  assert.equal(isSafeProtocolPackagePath(".protocols/reviewer", "/tmp/secret.md"), false);
  assert.throws(
    () => getProtocolPackageEntryPath({
      packagePath: ".protocols/reviewer",
      entryPoint: "../secret.md",
    }),
    /invalid protocol package path/i,
  );
});

test("protocol packages fail closed without an exact workspace scope", () => {
  const base = {
    active: true,
    type: "package",
    packagePath: ".protocols/reviewer",
    entryPoint: "SKILL.md",
  };
  assert.equal(
    isProtocolPackageApplicableToWorkspace(base, workspace),
    false,
  );
  assert.equal(
    isProtocolPackageApplicableToWorkspace(
      { ...base, workspaceScope: workspace },
      workspace,
    ),
    true,
  );
  assert.equal(
    isProtocolPackageApplicableToWorkspace(
      {
        ...base,
        packagePath: ".protocols/../src",
        workspaceScope: workspace,
      },
      workspace,
    ),
    false,
  );
});
