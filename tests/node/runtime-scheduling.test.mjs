import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();

function loadRuntimeScheduling() {
  const sourcePath = path.join(workspaceRoot, "src/lib/runtimeScheduling.ts");
  const source = fsSync.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, createRequire(sourcePath));
  return module.exports;
}

test("runtime scheduling progresses even when requestAnimationFrame never paints", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    requestAnimationFrame: () => 1,
  };
  try {
    const { scheduleRuntimeTask } = loadRuntimeScheduling();
    let completed = false;
    await new Promise((resolve, reject) => {
      scheduleRuntimeTask(() => {
        completed = true;
        resolve();
      });
      setTimeout(() => reject(new Error("runtime task stayed coupled to paint")), 100);
    });
    assert.equal(completed, true);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});
