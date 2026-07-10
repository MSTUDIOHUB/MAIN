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
  createTaskTargetingRuntime,
  runAgentLoopStartHooks,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/turnPreparation.ts"),
);

function baseRuntimeState(overrides = {}) {
  return {
    config: {
      hooksEnabled: false,
    },
    skills: [],
    workspace: workspaceRoot,
    turnIntent: "execute",
    workflowMode: "edit",
    ...overrides,
  };
}

test("turn preparation task targeting runtime builds scoped intake profile", () => {
  const callbacks = {
    getSessionKey: () => "turn-prep-test",
    getPlanTasks: () => [{ text: "Fix src/App.tsx render bug" }],
    getIsPlanApproved: () => false,
  };
  const runtime = createTaskTargetingRuntime({
    callbacks,
    runtimeState: baseRuntimeState(),
    turnInputContext: {
      latestUserPromptText: "Fix src/App.tsx render bug",
      turnInputContextSignals: {
        imageParts: 1,
        mentionedFilePaths: ["src/App.tsx"],
        attachedFilePaths: [],
      },
    },
    associatedPaths: ["src/App.tsx"],
  });

  const profile = runtime.buildCurrentTaskTargetingProfile();
  assert.ok(runtime.taskTargetingEvidence instanceof Set);
  assert.ok(profile.explicitPaths.includes("src/App.tsx"));
  assert.ok(profile.mentionedFilePaths.includes("src/App.tsx"));
  assert.equal(profile.imageParts, 1);
  assert.equal(profile.hasUserProvidedContext, true);
});

test("turn preparation start hooks are a no-op when hooks are disabled", async () => {
  const events = [];
  const callbacks = {
    getSessionKey: () => "hooks-disabled-test",
    hasSessionHookInitialized: () => false,
    getPreferredLanguage: () => "en",
    appendMessage: (message) => events.push({ type: "append", message }),
    markSessionHookInitialized: () => events.push({ type: "mark" }),
    onStatusChange: (status) => events.push({ type: "status", status }),
    getMessages: () => [{ role: "user", content: "Hello" }],
  };

  const result = await runAgentLoopStartHooks({
    callbacks,
    runtimeState: baseRuntimeState(),
    hooksConfig: {
      path: null,
      hooks: {
        SessionStart: [],
        UserPromptSubmit: [],
        PreToolUse: [],
        PostToolUse: [],
      },
      loadedAt: 1,
    },
    associatedPaths: [],
  });

  assert.equal(result, "continue");
  assert.deepEqual(events, []);
});
