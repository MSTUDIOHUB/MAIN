import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadWorkspacePathsModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/workspacePaths.ts");
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
  relativizeToWorkspacePath,
  formatDirectoryNodesForTool,
  workspacePathsReferToSameFile,
} = await loadWorkspacePathsModule();

test("relativizeToWorkspacePath keeps nested directories relative to the workspace root", () => {
  const result = relativizeToWorkspacePath(
    "/Users/example/GameProject/Assets/Scripts/Battle/Core/BattleEntity.cs",
    "/Users/example/GameProject",
  );

  assert.equal(result, "Assets/Scripts/Battle/Core/BattleEntity.cs");
});

test("formatDirectoryNodesForTool returns reusable relative paths for nested listings", () => {
  const result = formatDirectoryNodesForTool([
    {
      name: "Scripts",
      path: "/Users/example/GameProject/Assets/Scripts",
      is_dir: true,
    },
    {
      name: "BattleEntity.cs",
      path: "/Users/example/GameProject/Assets/Scripts/Battle/Core/BattleEntity.cs",
      is_dir: false,
    },
  ], "/Users/example/GameProject");

  assert.deepEqual(result, [
    "Assets/Scripts/",
    "Assets/Scripts/Battle/Core/BattleEntity.cs",
  ]);
});

test("relativizeToWorkspacePath normalizes Windows separators", () => {
  const result = relativizeToWorkspacePath(
    "C:\\Projects\\GameProject\\Assets\\Scripts\\BattleEntity.cs",
    "C:\\Projects\\GameProject",
  );

  assert.equal(result, "Assets/Scripts/BattleEntity.cs");
});

test("workspace path identity rejects an overlapping relative suffix but accepts an absolute tool target", () => {
  assert.equal(
    workspacePathsReferToSameFile("src-tauri/src/main.rs", "src/main.rs"),
    false,
  );
  assert.equal(
    workspacePathsReferToSameFile(
      "/Users/example/MD Viewer/src-tauri/src/main.rs",
      "src-tauri/src/main.rs",
    ),
    true,
  );
});
