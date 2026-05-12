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

const hydration = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planStateHydration.ts"));
const catalog = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/gameStudioCatalog.ts"));

const { resolvePlanStateHydrationReason, shouldPromoteHydratedPlanToExecuting } = hydration;
const { parseGameStudioSlashCommand } = catalog;

test("plan state hydration prefers explicit existing-plan execution semantics", () => {
  const reason = resolvePlanStateHydrationReason({
    text: "请按照 .MAIN/plans/tasks.md 继续执行",
    hasPlanState: false,
    hasContinuationState: false,
    slashCommand: null,
  });
  assert.equal(reason, "existing_plan_execution");
  assert.equal(shouldPromoteHydratedPlanToExecuting(reason), true);
});

test("plan state hydration triggers for continuation state and execution studio commands", () => {
  const continuation = resolvePlanStateHydrationReason({
    text: "继续",
    hasPlanState: false,
    hasContinuationState: true,
    slashCommand: null,
  });
  assert.equal(continuation, "continuation_state");
  assert.equal(shouldPromoteHydratedPlanToExecuting(continuation), true);

  const execCmd = resolvePlanStateHydrationReason({
    text: "/dev-story",
    hasPlanState: false,
    hasContinuationState: false,
    slashCommand: parseGameStudioSlashCommand("/dev-story"),
  });
  assert.equal(execCmd, "studio_execution_command");
});

test("plan state hydration remains conservative when plan state already exists or command is non-execution", () => {
  const alreadyHasState = resolvePlanStateHydrationReason({
    text: "继续执行",
    hasPlanState: true,
    hasContinuationState: true,
    slashCommand: parseGameStudioSlashCommand("/dev-story"),
  });
  assert.equal(alreadyHasState, null);

  const nonExecStudioCommand = resolvePlanStateHydrationReason({
    text: "/help",
    hasPlanState: false,
    hasContinuationState: false,
    slashCommand: parseGameStudioSlashCommand("/help"),
  });
  assert.equal(nonExecStudioCommand, null);
});
