import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }

    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { shouldRecoverLanguageMismatchTurn } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator.ts"),
);

test("language mismatch guard hides wrong-language visible text on tool-call turns without reprompt", () => {
  const first = shouldRecoverLanguageMismatchTurn({
    text: "Let me summarize the findings. The root cause is a null pointer.",
    targetLanguage: "zh",
    suppressedByPlanGuard: false,
    toolCallCount: 1,
    alreadyRetried: false,
  });

  assert.equal(first.mismatch, true);
  assert.equal(first.detectedLanguage, "en");
  assert.equal(first.action, "hide_text_continue");
  assert.equal(first.shouldRecover, false);
  assert.equal(first.exhausted, false);
  assert.equal(first.hideTextForToolCall, true);
});

test("language mismatch guard still triggers one recovery attempt when no tools are present", () => {
  const first = shouldRecoverLanguageMismatchTurn({
    text: "Let me summarize the findings. The root cause is a null pointer.",
    targetLanguage: "zh",
    suppressedByPlanGuard: false,
    toolCallCount: 0,
    alreadyRetried: false,
  });

  assert.equal(first.mismatch, true);
  assert.equal(first.detectedLanguage, "en");
  assert.equal(first.action, "recover_once");
  assert.equal(first.shouldRecover, true);
  assert.equal(first.exhausted, false);
  assert.equal(first.hideTextForToolCall, false);
});

test("language mismatch guard hides visible text when mismatch persists in tool-call turns", () => {
  const exhausted = shouldRecoverLanguageMismatchTurn({
    text: "Let me summarize the findings. The root cause is a null pointer.",
    targetLanguage: "zh",
    suppressedByPlanGuard: false,
    toolCallCount: 2,
    alreadyRetried: true,
  });

  assert.equal(exhausted.mismatch, true);
  assert.equal(exhausted.action, "hide_text_continue");
  assert.equal(exhausted.shouldRecover, false);
  assert.equal(exhausted.exhausted, false);
  assert.equal(exhausted.hideTextForToolCall, true);
});

test("language mismatch guard keeps no-tool exhausted behavior after one retry", () => {
  const exhausted = shouldRecoverLanguageMismatchTurn({
    text: "Let me summarize the findings. The root cause is a null pointer.",
    targetLanguage: "zh",
    suppressedByPlanGuard: false,
    toolCallCount: 0,
    alreadyRetried: true,
  });

  assert.equal(exhausted.mismatch, true);
  assert.equal(exhausted.action, "pass");
  assert.equal(exhausted.shouldRecover, false);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.hideTextForToolCall, false);
});

test("language mismatch guard skips code-like responses without natural-language signal", () => {
  const codeLike = shouldRecoverLanguageMismatchTurn({
    text: "```ts\\nconst value = 1;\\nfunction run(){ return value; }\\n```",
    targetLanguage: "zh",
    suppressedByPlanGuard: false,
    toolCallCount: 0,
    alreadyRetried: false,
  });

  assert.equal(codeLike.mismatch, false);
  assert.equal(codeLike.action, "pass");
  assert.equal(codeLike.shouldRecover, false);
  assert.equal(codeLike.exhausted, false);
  assert.equal(codeLike.hideTextForToolCall, false);
});
