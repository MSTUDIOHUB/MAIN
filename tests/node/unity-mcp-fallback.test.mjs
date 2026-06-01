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

const {
  shouldRepromptBeforeUnityConsoleFallback,
  shouldTriggerUnityMcpFirstIterationFallback,
  shouldTriggerUnityMcpStrictRetry,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator.ts"),
);

test("unity XML console path strict-retries before local fallback", () => {
  assert.equal(
    shouldTriggerUnityMcpStrictRetry({
      toolCallCount: 0,
      replyOptionCount: 0,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: true,
      strictRetryAlreadyIssued: false,
    }),
    true,
  );

  assert.equal(
    shouldTriggerUnityMcpStrictRetry({
      toolCallCount: 0,
      replyOptionCount: 0,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: true,
      strictRetryAlreadyIssued: true,
    }),
    false,
  );
});

test("unity fallback triggers only when no tool call, no reply options, and no strict console retry exists", () => {
  assert.equal(
    shouldTriggerUnityMcpFirstIterationFallback({
      toolCallCount: 0,
      replyOptionCount: 0,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: false,
    }),
    true,
  );

  assert.equal(
    shouldTriggerUnityMcpFirstIterationFallback({
      toolCallCount: 0,
      replyOptionCount: 2,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: false,
    }),
    false,
  );

  assert.equal(
    shouldTriggerUnityMcpFirstIterationFallback({
      toolCallCount: 1,
      replyOptionCount: 0,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: false,
    }),
    false,
  );

  assert.equal(
    shouldTriggerUnityMcpFirstIterationFallback({
      toolCallCount: 0,
      replyOptionCount: 0,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: true,
    }),
    false,
  );
});

test("unity forced console path gives one soft reprompt after valid read-only activity", () => {
  assert.equal(
    shouldRepromptBeforeUnityConsoleFallback({
      readConsoleCalled: false,
      hasSuccessfulReadOnlyActivity: true,
      repromptAlreadyIssued: false,
    }),
    true,
  );

  assert.equal(
    shouldRepromptBeforeUnityConsoleFallback({
      readConsoleCalled: true,
      hasSuccessfulReadOnlyActivity: true,
      repromptAlreadyIssued: false,
    }),
    false,
  );

  assert.equal(
    shouldRepromptBeforeUnityConsoleFallback({
      readConsoleCalled: false,
      hasSuccessfulReadOnlyActivity: false,
      repromptAlreadyIssued: false,
    }),
    false,
  );

  assert.equal(
    shouldRepromptBeforeUnityConsoleFallback({
      readConsoleCalled: false,
      hasSuccessfulReadOnlyActivity: true,
      repromptAlreadyIssued: true,
    }),
    false,
  );
});
