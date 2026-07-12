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
  resolveReactiveContextLimit,
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

test("clampContextLimitToReported preserves configured limit when provider window is unknown", () => {
  const result = clampContextLimitToReported(102400, "The number of tokens to keep from the initial prompt is greater than the context length.");

  assert.equal(result.contextLimit, 102400);
  assert.equal(result.reportedContextLimit, null);
});

test("clampContextLimitToReported never collapses local empty completion to 4096", () => {
  const result = clampContextLimitToReported(81920, "Local model returned an empty completion. Treating as context window limit exceeded to trigger reactive compaction.");

  assert.equal(result.contextLimit, 81920);
  assert.equal(result.reportedContextLimit, null);
});

test("resolveReactiveContextLimit uses the provider-reported window when available", () => {
  assert.deepEqual(
    resolveReactiveContextLimit(
      150000,
      "Prompt too long: maximum context length is 131,072 tokens",
    ),
    {
      contextLimit: 131072,
      reportedContextLimit: 131072,
      source: "reported",
    },
  );
});

test("resolveReactiveContextLimit derives headroom from the current request when the window is unknown", () => {
  assert.deepEqual(resolveReactiveContextLimit(50000, "context too large"), {
    contextLimit: 35000,
    reportedContextLimit: null,
    source: "estimated_headroom",
  });
  assert.equal(resolveReactiveContextLimit(1000, "context too large").contextLimit, 4096);
});
