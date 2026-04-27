import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadContextWindowModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/contextWindow.ts");
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
  clampContextLimitToReported,
  extractReportedContextWindowLimit,
} = await loadContextWindowModule();

test("extractReportedContextWindowLimit parses local provider prompt-too-long errors", () => {
  const message = 'HTTP 400: {"error":{"message":"Prompt too long: 35057 tokens exceeds max context window of 32768 tokens"}}';

  assert.equal(extractReportedContextWindowLimit(message), 32768);
});

test("clampContextLimitToReported keeps configured limit below provider window", () => {
  const result = clampContextLimitToReported(24576, "Prompt too long: 35057 tokens exceeds max context window of 32,768 tokens");

  assert.equal(result.contextLimit, 24576);
  assert.equal(result.reportedContextLimit, 32768);
});

test("clampContextLimitToReported clamps configured limit above provider window", () => {
  const result = clampContextLimitToReported(65536, "Prompt too long: 35057 tokens exceeds max context window of 32768 tokens");

  assert.equal(result.contextLimit, 32768);
  assert.equal(result.reportedContextLimit, 32768);
});
