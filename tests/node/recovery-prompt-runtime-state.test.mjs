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
  applyExecuteConvergencePromptState,
  applyMalformedToolUseRecoveryPromptState,
  createAgentLoopRecoveryPromptRuntimeState,
  markLanguageMismatchRecoveryPromptUsed,
  markPseudoToolCallRecoveryPromptUsed,
  markReadOnlyPermissionHardRecoveryPromptUsed,
  markToolUnavailableRecoveryPromptUsed,
  resetTransientRecoveryPromptRuntimeState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/recoveryPromptRuntimeState.ts"),
);

test("recovery prompt runtime state initializes all prompt flags as unused", () => {
  assert.deepEqual(createAgentLoopRecoveryPromptRuntimeState(), {
    usedToolUnavailableRecoveryPrompt: false,
    usedPseudoToolCallRecoveryPrompt: false,
    usedMalformedToolUseRecoveryPrompt: false,
    usedLanguageMismatchRecoveryPrompt: false,
    usedExecuteConvergencePrompt: false,
    usedReadOnlyPermissionHardRecoveryPrompt: false,
  });
});

test("recovery prompt mark helpers are idempotent", () => {
  let state = createAgentLoopRecoveryPromptRuntimeState();

  state = markToolUnavailableRecoveryPromptUsed(state);
  assert.equal(state.usedToolUnavailableRecoveryPrompt, true);
  assert.equal(markToolUnavailableRecoveryPromptUsed(state), state);

  state = markPseudoToolCallRecoveryPromptUsed(state);
  assert.equal(state.usedPseudoToolCallRecoveryPrompt, true);
  assert.equal(markPseudoToolCallRecoveryPromptUsed(state), state);

  state = markLanguageMismatchRecoveryPromptUsed(state);
  assert.equal(state.usedLanguageMismatchRecoveryPrompt, true);
  assert.equal(markLanguageMismatchRecoveryPromptUsed(state), state);

  state = markReadOnlyPermissionHardRecoveryPromptUsed(state);
  assert.equal(state.usedReadOnlyPermissionHardRecoveryPrompt, true);
  assert.equal(markReadOnlyPermissionHardRecoveryPromptUsed(state), state);
});

test("recovery prompt reducers apply helper-owned state fields", () => {
  const state = createAgentLoopRecoveryPromptRuntimeState();

  assert.deepEqual(applyMalformedToolUseRecoveryPromptState(state, {
    usedMalformedToolUseRecoveryPrompt: true,
  }), {
    ...state,
    usedMalformedToolUseRecoveryPrompt: true,
  });

  assert.deepEqual(applyExecuteConvergencePromptState(state, {
    usedExecuteConvergencePrompt: true,
  }), {
    ...state,
    usedExecuteConvergencePrompt: true,
  });
});

test("transient recovery prompt reset preserves execute convergence state", () => {
  const state = {
    usedToolUnavailableRecoveryPrompt: true,
    usedPseudoToolCallRecoveryPrompt: true,
    usedMalformedToolUseRecoveryPrompt: true,
    usedLanguageMismatchRecoveryPrompt: true,
    usedExecuteConvergencePrompt: true,
    usedReadOnlyPermissionHardRecoveryPrompt: true,
  };
  assert.deepEqual(resetTransientRecoveryPromptRuntimeState(state), {
    usedToolUnavailableRecoveryPrompt: false,
    usedPseudoToolCallRecoveryPrompt: false,
    usedMalformedToolUseRecoveryPrompt: false,
    usedLanguageMismatchRecoveryPrompt: false,
    usedExecuteConvergencePrompt: true,
    usedReadOnlyPermissionHardRecoveryPrompt: false,
  });

  const alreadyClean = createAgentLoopRecoveryPromptRuntimeState();
  assert.equal(resetTransientRecoveryPromptRuntimeState(alreadyClean), alreadyClean);
});
