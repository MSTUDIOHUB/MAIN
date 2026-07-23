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
  appendActiveRuntimeGuidance,
  buildRuntimeGuidanceMessage,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"),
);
const {
  decideRuntimeGuidanceCompletionFence,
  shouldTransitionRunToFinalizing,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/runtimeGuidanceCompletion.ts"),
);

test("iteration stream preparation builds localized runtime guidance messages", () => {
  const en = buildRuntimeGuidanceMessage({
    language: "en",
    text: "  focus on validation  ",
  });
  assert.equal(en.role, "user");
  assert.match(en.content, /Runtime guidance from the user/);
  assert.match(en.content, /focus on validation$/);
  assert.doesNotMatch(en.content, /  focus/);

  const zh = buildRuntimeGuidanceMessage({
    language: "zh",
    text: "继续修复",
  });
  assert.match(zh.content, /用户在当前执行中追加的运行引导/);
  assert.match(zh.content, /继续修复$/);
});

test("iteration stream preparation appends active runtime guidance to model messages", () => {
  const appended = [];
  const injected = [];
  const baseMessages = [{ role: "user", content: "Original task" }];
  const callbacks = {
    getPreferredLanguage: () => "en",
    consumeActiveGuidance: () => ({
      id: "guidance_1",
      text: "Use the cached context.",
      turnId: "turn_1",
    }),
    appendMessage: (message) => appended.push(message),
    onGuidanceInjected: (guidance) => injected.push(guidance),
  };

  const nextMessages = appendActiveRuntimeGuidance({
    callbacks,
    managedAgentMessages: baseMessages,
    iteration: 3,
  });

  assert.equal(nextMessages.length, 2);
  assert.equal(baseMessages.length, 1);
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0], nextMessages[1]);
  assert.deepEqual(injected, [{
    id: "guidance_1",
    text: "Use the cached context.",
    turnId: "turn_1",
  }]);
  assert.match(nextMessages[1].content, /Use the cached context\.$/);
});

test("iteration stream preparation leaves messages unchanged without active guidance", () => {
  const baseMessages = [{ role: "user", content: "Original task" }];
  const callbacks = {
    getPreferredLanguage: () => "en",
    consumeActiveGuidance: () => ({ id: "empty", text: "   ", turnId: null }),
    appendMessage: () => {
      throw new Error("appendMessage should not be called");
    },
    onGuidanceInjected: () => {
      throw new Error("onGuidanceInjected should not be called");
    },
  };

  const nextMessages = appendActiveRuntimeGuidance({
    callbacks,
    managedAgentMessages: baseMessages,
    iteration: 4,
  });

  assert.equal(nextMessages, baseMessages);
});

test("late Guide wins completion, is consumed next iteration, then completion alone finalizes", () => {
  let runPhase = "executing";
  let pendingGuidance = {
    id: "guidance-late-1",
    text: "Inspect the exact failing assertion.",
    turnId: "turn-1",
  };
  let lateGuidanceContinuationsUsed = 0;

  const firstFence = decideRuntimeGuidanceCompletionFence({
    completionCandidate: true,
    runStatus: "running",
    runPhase,
    exactPendingGuidanceId: pendingGuidance.id,
    lateGuidanceContinuationsUsed,
  });
  assert.equal(firstFence.kind, "continue_with_guidance");
  if (shouldTransitionRunToFinalizing(firstFence)) runPhase = "finalizing";
  assert.equal(runPhase, "executing", "Guide continuation must keep the Run consumable");
  lateGuidanceContinuationsUsed += 1;

  const appended = [];
  const injected = [];
  const nextMessages = appendActiveRuntimeGuidance({
    callbacks: {
      getPreferredLanguage: () => "en",
      consumeActiveGuidance: () => {
        const consumed = pendingGuidance;
        pendingGuidance = null;
        return consumed;
      },
      appendMessage: (message) => appended.push(message),
      onGuidanceInjected: (guidance) => injected.push(guidance),
    },
    managedAgentMessages: [{ role: "user", content: "Original task" }],
    iteration: 2,
  });
  assert.equal(pendingGuidance, null);
  assert.equal(appended.length, 1);
  assert.equal(injected[0].id, "guidance-late-1");
  assert.match(nextMessages.at(-1).content, /Inspect the exact failing assertion\.$/);

  const secondFence = decideRuntimeGuidanceCompletionFence({
    completionCandidate: true,
    runStatus: "running",
    runPhase,
    exactPendingGuidanceId: null,
    lateGuidanceContinuationsUsed,
  });
  assert.equal(secondFence.kind, "acquire_completion");
  if (shouldTransitionRunToFinalizing(secondFence)) runPhase = "finalizing";
  assert.equal(runPhase, "finalizing");

  const racedSecondGuide = decideRuntimeGuidanceCompletionFence({
    completionCandidate: true,
    runStatus: "running",
    runPhase: "executing",
    exactPendingGuidanceId: "guidance-late-2",
    lateGuidanceContinuationsUsed,
  });
  assert.deepEqual(racedSecondGuide, {
    kind: "reject_completion",
    reason: "late_guidance_budget_exhausted",
  });
  assert.equal(shouldTransitionRunToFinalizing(racedSecondGuide), false);
});
