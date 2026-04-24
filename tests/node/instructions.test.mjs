import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

const workspaceRoot = process.cwd();

async function loadInstructionsModule(ipcStubs) {
  const sourcePath = path.join(workspaceRoot, "src/lib/instructions.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "./ipc") {
      return ipcStubs;
    }
    throw new Error(`Unexpected require in test: ${specifier}`);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  return module.exports;
}

test("loadResolvedInstructions keeps normal MAIN templates but skips game-studio templates", async () => {
  const files = {
    ".MAIN/templates/plan/design.md": "---\npaths:\n  - src/**\n---\n# Design Template",
    ".MAIN/templates/game-studio/gdd.md": "# GDD Template",
  };

  const { loadResolvedInstructions } = await loadInstructionsModule({
    globSearch: async (pattern) => {
      if (pattern === ".MAIN/rules/*.md") return [];
      if (pattern === ".MAIN/templates/**/*.md") return Object.keys(files);
      return [];
    },
    readFile: async (targetPath) => {
      if (!(targetPath in files)) {
        throw new Error(`Unknown path: ${targetPath}`);
      }
      return files[targetPath];
    },
  });

  const resolved = await loadResolvedInstructions("/tmp/workspace", [], ["src/main.ts"]);

  assert.equal(resolved.templates.length, 1);
  assert.equal(resolved.templates[0].source.path, ".MAIN/templates/plan/design.md");
  assert.match(resolved.templates[0].content, /Design Template/);
  assert.equal(
    resolved.templates.some((template) => template.source.path === ".MAIN/templates/game-studio/gdd.md"),
    false,
  );
});
