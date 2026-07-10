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
  resolveAssistantActionRouting,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantActionRouting.ts"),
);

function route(overrides = {}) {
  return resolveAssistantActionRouting({
    effectiveToolCalls: [],
    finalReplyOptions: [],
    compactedProseCodeDump: false,
    compactedIncompletePlanText: false,
    streamText: "",
    normalizedVisibleText: "",
    normalizedHiddenThought: "",
    finalVisibleText: "I will use a tool.",
    messages: [],
    availableToolNames: new Set(["read_file", "web_search"]),
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    webSearchEnabled: false,
    latestUserPromptText: "Fix the issue",
    recentToolActivity: [],
    webSearchProvider: "duckduckgo",
    buildToolCallId: () => "call_fixed",
    ...overrides,
  });
}

test("assistant action routing recovers pseudo read_file with a single mentioned path", () => {
  const decision = route({
    normalizedVisibleText: "[Tool call: read_file]",
    streamText: "[Tool call: read_file]",
    messages: [{
      role: "user",
      content: [
        "Please inspect this file.",
        "[user_mentioned_files]",
        "path: src/App.tsx",
      ].join("\n"),
    }],
  });

  assert.equal(decision.recoveredPseudoToolCall, true);
  assert.equal(decision.pseudoToolNameCandidate, "read_file");
  assert.equal(decision.pseudoRecovery.reason, "unique_mentioned_path");
  assert.equal(decision.effectiveToolCalls.length, 1);
  assert.equal(decision.effectiveToolCalls[0].name, "read_file");
  assert.deepEqual(JSON.parse(decision.effectiveToolCalls[0].arguments), { path: "src/App.tsx" });
  assert.equal(decision.syntheticVisibleConclusion, true);
  assert.equal(decision.userVisibleText, "");
});

test("assistant action routing leaves unrecoverable pseudo tools as placeholders", () => {
  const decision = route({
    normalizedVisibleText: "[Tool call: read_file]",
    streamText: "[Tool call: read_file]",
    messages: [],
  });

  assert.equal(decision.recoveredPseudoToolCall, false);
  assert.equal(decision.pseudoRecovery.reason, "missing_required_path");
  assert.equal(decision.effectiveToolCalls.length, 0);
  assert.equal(decision.pseudoToolCallPlaceholder, true);
  assert.equal(decision.syntheticVisibleConclusion, true);
  assert.equal(decision.userVisibleText, "");
});

test("assistant action routing injects required web_search for fresh chat requests", () => {
  const decision = route({
    workflowMode: "chat",
    turnIntent: "respond",
    runtimeIntent: "respond",
    finalVisibleText: "I should look this up.",
    webSearchEnabled: true,
    latestUserPromptText: "今天沈阳天气怎么样",
    webSearchProvider: "duckduckgo",
  });

  assert.equal(decision.injectedRequiredWebResearchCall, true);
  assert.equal(decision.effectiveToolCalls.length, 1);
  assert.equal(decision.effectiveToolCalls[0].id, "call_fixed");
  assert.equal(decision.effectiveToolCalls[0].name, "web_search");
  const args = JSON.parse(decision.effectiveToolCalls[0].arguments);
  assert.match(args.query, /沈阳天气/);
  assert.equal(args.provider, "duckduckgo");
  assert.equal(args.max_results, 5);
  assert.equal(decision.webResearchProvider, "duckduckgo");
});

test("assistant action routing does not inject duplicate web research after a web search", () => {
  const decision = route({
    workflowMode: "chat",
    turnIntent: "respond",
    runtimeIntent: "respond",
    webSearchEnabled: true,
    latestUserPromptText: "最新 Unity 版本是多少",
    recentToolActivity: [{ name: "web_search", status: "succeeded" }],
  });

  assert.equal(decision.injectedRequiredWebResearchCall, false);
  assert.equal(decision.effectiveToolCalls.length, 0);
});
