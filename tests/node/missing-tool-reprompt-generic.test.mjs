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

const { buildMissingToolCallContinuationPrompt } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/missingToolCallReprompt.ts"),
);

test("generic reprompt no longer hard-forces 'do not ask user' behavior", () => {
  const zh = buildMissingToolCallContinuationPrompt("generic", "zh", 1, true);
  assert.equal(zh.includes("不要询问用户指示"), false);
  assert.equal(zh.includes("不要等待确认"), false);
  assert.ok(zh.includes("关键参数缺失"));
  assert.ok(zh.includes("<tool_use>"));
});

test("generic reprompt keeps one-question clarification escape hatch", () => {
  const en = buildMissingToolCallContinuationPrompt("generic", "en", 1, true);
  assert.equal(en.includes("Do not ask the user what to do next"), false);
  assert.equal(en.includes("instead of waiting for confirmation"), false);
  assert.ok(en.includes("ask one short clarifying question"));
  assert.ok(en.includes("<tool_use>"));
});

test("generic native reprompt never emits the XML fallback protocol", () => {
  const prompt = buildMissingToolCallContinuationPrompt("generic", "en", 1, false);

  assert.match(prompt, /native tool call/i);
  assert.doesNotMatch(prompt, /XML|<tool_use>|<tool>|<parameter/i);
});
