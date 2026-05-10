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

const { buildExecutionDigest } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/executionDigest.ts"),
);

test("execution digest summarizes goal/latest/next for successful tool batches", () => {
  const digest = buildExecutionDigest({
    language: "zh",
    turnIntent: "execute",
    toolResults: [
      {
        name: "read_file",
        target: "src/a.ts",
        isError: false,
        content: "ok",
      },
    ],
    remainingTask: "修复回调超时",
  });

  assert.ok(digest.includes("执行摘要"));
  assert.ok(digest.includes("read_file"));
  assert.ok(digest.includes("修复回调超时"));
});

test("execution digest reports error-first next step for failures", () => {
  const digest = buildExecutionDigest({
    language: "en",
    turnIntent: "execute",
    toolResults: [
      {
        name: "run_command",
        target: "npm test",
        isError: true,
        content: "exitCode: 1",
      },
    ],
  });

  assert.ok(digest.includes("Execution digest"));
  assert.ok(digest.includes("run_command"));
  assert.ok(digest.includes("Diagnose the latest error"));
});
