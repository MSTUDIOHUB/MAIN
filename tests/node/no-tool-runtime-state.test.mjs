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
  applyConsecutiveNoToolRuntimeState,
  applyEmptyResponseNoToolRuntimeState,
  applyReasoningDominatedNoToolRuntimeState,
  applyRecoveringFromEmptyAssistantReplyRuntimeState,
  createAgentLoopNoToolRuntimeState,
  incrementConsecutiveNoToolRuntimeState,
  resetConsecutiveNoToolRuntimeState,
  resetEmptyAndReasoningNoToolRuntimeState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/noToolRuntimeState.ts"),
);

test("no-tool runtime state initializes counters and recovery flags", () => {
  assert.deepEqual(createAgentLoopNoToolRuntimeState(), {
    consecutiveNoToolCount: 0,
    consecutiveEmptyResponseCount: 0,
    emptyResponseCountThisTurn: 0,
    consecutiveReasoningDominatedCount: 0,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  });
});

test("no-tool streak helpers apply, increment, and reset the shared counter", () => {
  const initial = createAgentLoopNoToolRuntimeState();
  const applied = applyConsecutiveNoToolRuntimeState(initial, {
    consecutiveNoToolCount: 3,
  });
  assert.equal(applied.consecutiveNoToolCount, 3);

  const incremented = incrementConsecutiveNoToolRuntimeState(applied);
  assert.equal(incremented.consecutiveNoToolCount, 4);
  assert.equal(resetConsecutiveNoToolRuntimeState(incremented).consecutiveNoToolCount, 0);

  const clean = createAgentLoopNoToolRuntimeState();
  assert.equal(resetConsecutiveNoToolRuntimeState(clean), clean);
});

test("reasoning-only and empty-response reducers apply helper-owned fields", () => {
  let state = createAgentLoopNoToolRuntimeState();
  state = applyReasoningDominatedNoToolRuntimeState(state, {
    consecutiveReasoningDominatedCount: 2,
  });
  assert.equal(state.consecutiveReasoningDominatedCount, 2);

  state = applyEmptyResponseNoToolRuntimeState(state, {
    consecutiveEmptyResponseCount: 1,
    emptyResponseCountThisTurn: 1,
    recoveringFromEmptyAssistantReplyAfterWrite: true,
  });
  assert.equal(state.consecutiveEmptyResponseCount, 1);
  assert.equal(state.emptyResponseCountThisTurn, 1);
  assert.equal(state.recoveringFromEmptyAssistantReplyAfterWrite, true);
});

test("empty and reasoning reset keeps per-turn empty counter intact", () => {
  const state = {
    ...createAgentLoopNoToolRuntimeState(),
    consecutiveEmptyResponseCount: 2,
    emptyResponseCountThisTurn: 5,
    consecutiveReasoningDominatedCount: 1,
  };
  assert.deepEqual(resetEmptyAndReasoningNoToolRuntimeState(state), {
    ...state,
    consecutiveEmptyResponseCount: 0,
    consecutiveReasoningDominatedCount: 0,
  });

  const clean = createAgentLoopNoToolRuntimeState();
  assert.equal(resetEmptyAndReasoningNoToolRuntimeState(clean), clean);
});

test("post-write empty assistant recovery flag has an explicit reducer", () => {
  const state = createAgentLoopNoToolRuntimeState();
  assert.deepEqual(applyRecoveringFromEmptyAssistantReplyRuntimeState(state, {
    recoveringFromEmptyAssistantReplyAfterWrite: true,
  }), {
    ...state,
    recoveringFromEmptyAssistantReplyAfterWrite: true,
  });
});
