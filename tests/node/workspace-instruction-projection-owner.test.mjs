import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

const workspaceRoot = process.cwd();

async function loadProjectionOwnerModule() {
  const sourcePath = path.join(
    workspaceRoot,
    "src/store/workspaceInstructionProjectionOwner.ts",
  );
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
  factory(module.exports, module, () => {
    throw new Error("workspace projection owner must remain dependency-free");
  });
  return module.exports;
}

test("a late A refresh cannot overwrite the current B workspace projection", async () => {
  const { createWorkspaceInstructionProjectionOwner } =
    await loadProjectionOwnerModule();
  const ownership = createWorkspaceInstructionProjectionOwner();

  const ownerA = ownership.claim("/tmp/workspace-a");
  ownership.invalidate();
  const ownerB = ownership.claim("/tmp/workspace-b");

  assert.equal(
    ownership.canCommit(ownerA, "/tmp/workspace-b"),
    false,
  );
  assert.equal(
    ownership.canCommit(ownerB, "/tmp/workspace-b"),
    true,
  );
  assert.equal(
    ownership.canCommit(ownerB, "/tmp/workspace-a"),
    false,
  );
});
