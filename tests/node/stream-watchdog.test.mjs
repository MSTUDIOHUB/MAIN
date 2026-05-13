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
  createStreamNoVisibleTokenTimeoutError,
  isStreamWatchdogTimeoutMessage,
  shouldUsePlanNoVisibleTokenWatchdog,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"));

test("classifies no-visible-token stream timeout as a plan watchdog timeout", () => {
  const error = createStreamNoVisibleTokenTimeoutError(125_000, "plan:preapproval_xml_tools");

  assert.equal(error.code, "STREAM_NO_VISIBLE_TOKEN_TIMEOUT");
  assert.match(error.message, /no visible model output/);
  assert.equal(isStreamWatchdogTimeoutMessage(error.message), true);
});

test("enables no-visible-token watchdog only for pre-approval plan text protocol", () => {
  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "plan",
      isPlanApproved: false,
      nativeToolCount: 0,
    }),
    true,
  );
  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "plan",
      isPlanApproved: true,
      nativeToolCount: 0,
    }),
    false,
  );
  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "plan",
      isPlanApproved: false,
      nativeToolCount: 2,
    }),
    false,
  );
  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "edit",
      isPlanApproved: false,
      nativeToolCount: 0,
    }),
    false,
  );
});
