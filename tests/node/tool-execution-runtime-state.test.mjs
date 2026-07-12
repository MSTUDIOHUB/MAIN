import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
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

const {
  createAgentLoopToolExecutionRuntimeState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolExecutionRuntimeState.ts"),
);

test("tool execution runtime state initializes per-loop caches", () => {
  const state = createAgentLoopToolExecutionRuntimeState("tool-runtime-state-test-a");

  assert.equal(state.readOnlyResultCache.size, 0);
  assert.equal(state.browserValidationCache.size, 0);
  assert.equal(state.readOnlyDuplicateSkipCounts.size, 0);
  assert.equal(state.fileReadStates.size, 0);
});

test("tool execution runtime state keeps file-read states session scoped", () => {
  const sessionKey = `tool-runtime-state-test-${Date.now()}-${Math.random()}`;
  const first = createAgentLoopToolExecutionRuntimeState(sessionKey);
  const second = createAgentLoopToolExecutionRuntimeState(sessionKey);
  const other = createAgentLoopToolExecutionRuntimeState(`${sessionKey}-other`);

  assert.notEqual(first.readOnlyResultCache, second.readOnlyResultCache);
  assert.notEqual(first.browserValidationCache, second.browserValidationCache);
  assert.notEqual(first.readOnlyDuplicateSkipCounts, second.readOnlyDuplicateSkipCounts);
  assert.equal(first.fileReadStates, second.fileReadStates);
  assert.notEqual(first.fileReadStates, other.fileReadStates);
});
