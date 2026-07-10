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

const { resolveAssistantLanguageRecoveryRoute } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantLanguageRecoveryRouting.ts"),
);

const MISMATCH_TEXT = "Let me summarize the findings. The root cause is a null pointer.";

function route(overrides = {}) {
  return resolveAssistantLanguageRecoveryRoute({
    text: MISMATCH_TEXT,
    targetLanguage: "zh",
    suppressedByPlanGuard: false,
    toolCallCount: 0,
    alreadyRetried: false,
    chatFinalSynthesisActive: false,
    workflowMode: "edit",
    runtimeIntent: "execute",
    recentReadOnlyActivityCountForChat: 0,
    consecutiveNoToolCount: 0,
    ...overrides,
  });
}

test("assistant language recovery reprompts once for no-tool wrong-language text", () => {
  const decision = route();

  assert.equal(decision.action, "recover_once");
  assert.equal(decision.decision.detectedLanguage, "en");
  assert.equal(decision.decision.shouldRecover, true);
});

test("assistant language recovery hides wrong-language text when tool calls are present", () => {
  const decision = route({ toolCallCount: 1 });

  assert.equal(decision.action, "hide_text_continue");
  assert.equal(decision.decision.hideTextForToolCall, true);
  assert.equal(decision.decision.exhausted, false);
});

test("assistant language recovery activates chat final synthesis after a retry is exhausted", () => {
  const decision = route({
    workflowMode: "chat",
    runtimeIntent: "respond",
    alreadyRetried: true,
  });

  assert.equal(decision.action, "activate_chat_final_synthesis");
  assert.equal(decision.reason, "language_mismatch_after_retry");
  assert.equal(decision.logContext.detectedLanguage, "en");
  assert.equal(decision.logContext.visibleChars, MISMATCH_TEXT.length);
});

test("assistant language recovery preserves exhausted pass outside chat respond turns", () => {
  const decision = route({ alreadyRetried: true });

  assert.equal(decision.action, "pass");
  assert.equal(decision.decision.exhausted, true);
});

test("assistant language recovery respects approved-plan suppression", () => {
  const decision = route({ suppressedByPlanGuard: true });

  assert.equal(decision.action, "pass");
  assert.equal(decision.decision.mismatch, true);
  assert.equal(decision.decision.shouldRecover, false);
  assert.equal(decision.decision.exhausted, false);
});
