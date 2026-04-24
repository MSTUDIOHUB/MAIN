import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadChatScrollModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/chatScroll.ts");
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
  getDistanceFromBottom,
  resolveAutoScrollState,
} = await loadChatScrollModule();

test("getDistanceFromBottom clamps to zero", () => {
  assert.equal(getDistanceFromBottom(500, 450, 100), 0);
});

test("resolveAutoScrollState releases auto-follow immediately when the user scrolls upward", () => {
  const shouldAutoScroll = resolveAutoScrollState({
    scrollTop: 980,
    previousScrollTop: 1000,
    scrollHeight: 1400,
    clientHeight: 320,
  });

  assert.equal(shouldAutoScroll, false);
});

test("resolveAutoScrollState re-enables auto-follow when the user returns near the bottom", () => {
  const shouldAutoScroll = resolveAutoScrollState({
    scrollTop: 1085,
    previousScrollTop: 980,
    scrollHeight: 1400,
    clientHeight: 320,
  });

  assert.equal(shouldAutoScroll, true);
});
