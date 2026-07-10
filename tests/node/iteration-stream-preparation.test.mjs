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
  const baseMessages = [{ role: "user", content: "Original task" }];
  const callbacks = {
    getPreferredLanguage: () => "en",
    consumeActiveGuidance: () => ({
      id: "guidance_1",
      text: "Use the cached context.",
      turnId: "turn_1",
    }),
    appendMessage: (message) => appended.push(message),
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
  };

  const nextMessages = appendActiveRuntimeGuidance({
    callbacks,
    managedAgentMessages: baseMessages,
    iteration: 4,
  });

  assert.equal(nextMessages, baseMessages);
});
