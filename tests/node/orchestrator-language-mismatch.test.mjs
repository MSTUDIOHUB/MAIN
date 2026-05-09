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

test("language mismatch guard triggers one recovery attempt on first mismatch", () => {
  const first = shouldRecoverLanguageMismatchTurn({
    text: "Let me summarize the findings. The root cause is a null pointer.",
    targetLanguage: "zh",
    suppressedByPlanGuard: false,
    toolCallCount: 0,
    alreadyRetried: false,
  });

  assert.equal(first.mismatch, true);
  assert.equal(first.detectedLanguage, "en");
  assert.equal(first.shouldRecover, true);
  assert.equal(first.exhausted, false);
});

test("language mismatch guard does not retry more than once", () => {
  const exhausted = shouldRecoverLanguageMismatchTurn({
    text: "Let me summarize the findings. The root cause is a null pointer.",
    targetLanguage: "zh",
    suppressedByPlanGuard: false,
    toolCallCount: 0,
    alreadyRetried: true,
  });

  assert.equal(exhausted.mismatch, true);
  assert.equal(exhausted.shouldRecover, false);
  assert.equal(exhausted.exhausted, true);
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
  assert.equal(codeLike.shouldRecover, false);
  assert.equal(codeLike.exhausted, false);
});
