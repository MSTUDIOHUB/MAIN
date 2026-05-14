import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadFilePreviewStrategyModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/filePreviewStrategy.ts");
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
  EXTERNAL_OPEN_SIZE_THRESHOLD_BYTES,
  getFilePreviewStrategy,
  shouldUseExternalOpen,
} = await loadFilePreviewStrategyModule();

test("Office files use external open regardless of casing", () => {
  const strategy = getFilePreviewStrategy({ path: "reports/Q4-FORECAST.XLSX" });

  assert.equal(strategy.mode, "externalOnly");
  assert.equal(strategy.reason, "office");
  assert.equal(shouldUseExternalOpen({ path: "docs/brief.PPTM" }), true);
});

test("large text files recommend external open", () => {
  const strategy = getFilePreviewStrategy({
    path: "logs/build.log",
    sizeBytes: EXTERNAL_OPEN_SIZE_THRESHOLD_BYTES + 1,
  });

  assert.equal(strategy.mode, "externalRecommended");
  assert.equal(strategy.reason, "largeFile");
  assert.equal(strategy.shouldUseExternalOpen, true);
});

test("small markdown files remain inline", () => {
  const strategy = getFilePreviewStrategy({
    path: "README.md",
    sizeBytes: 12_000,
  });

  assert.equal(strategy.mode, "inline");
  assert.equal(strategy.reason, "inlineSupported");
  assert.equal(shouldUseExternalOpen({ path: "README.md", sizeBytes: 12_000 }), false);
});

test("extension parsing does not misjudge extensionless files or dotfiles", () => {
  assert.equal(shouldUseExternalOpen({ path: "Makefile" }), false);
  assert.equal(shouldUseExternalOpen({ path: ".env" }), false);
  assert.equal(shouldUseExternalOpen({ path: "notes" }), false);
  assert.equal(shouldUseExternalOpen({ path: "archive.ZIP" }), true);
});
