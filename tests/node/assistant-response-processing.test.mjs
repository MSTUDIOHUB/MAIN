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
  processAssistantStreamResponse,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantResponseProcessing.ts"),
);

function baseInput(overrides = {}) {
  const turnContextEvents = [];
  return {
    streamResult: {
      content: "Done.",
      reasoningContent: "",
      reasoningField: undefined,
      toolCalls: [],
      finishReason: "stop",
    },
    iteration: 2,
    iterationRequestStartedAt: Date.now(),
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    activeProfile: "local",
    provider: "test-provider",
    model: "test-model",
    contextLimit: 4096,
    effectiveToolProtocol: "xml",
    forceXmlTools: true,
    reasoningDisplay: "hidden",
    llmToolCount: 3,
    managedMessageCount: 4,
    currentMaxTokens: 512,
    turnContext: {
      setSummary: (summary) => turnContextEvents.push({ type: "summary", summary }),
      accumulateReasoning: (chars) => turnContextEvents.push({ type: "reasoning", chars }),
    },
    turnContextEvents,
    ...overrides,
  };
}

test("assistant response processing preserves provider reasoning as hidden history metadata", () => {
  const reasoningContent = "Need to inspect context and then answer. ".repeat(12);
  const input = baseInput({
    streamResult: {
      content: "Visible answer",
      reasoningContent,
      reasoningField: "reasoning_content",
      toolCalls: [],
      finishReason: "stop",
    },
  });

  const result = processAssistantStreamResponse(input);

  assert.equal(result.streamText, "Visible answer");
  assert.equal(result.providerReasoningForHistory.reasoningContent, reasoningContent);
  assert.equal(result.normalized.visibleText, "Visible answer");
  assert.equal(input.turnContextEvents.some((event) => event.type === "summary" && event.summary.length > 0), true);
  assert.equal(input.turnContextEvents.some((event) => event.type === "reasoning" && event.chars === reasoningContent.length), true);
});

test("assistant response processing enforces the configured hidden reasoning display cap", () => {
  const reasoningContent = "Need to inspect another branch before concluding. ".repeat(100);
  const result = processAssistantStreamResponse(baseInput({
    maxHiddenChars: 240,
    streamResult: {
      content: "Visible answer",
      reasoningContent,
      reasoningField: "reasoning_content",
      toolCalls: [],
      finishReason: "stop",
    },
  }));

  assert.equal(result.providerReasoningForHistory.reasoningContent, reasoningContent);
  assert.ok(result.normalized.hiddenThought.length <= 240);
  assert.match(result.normalized.hiddenThought, /hidden reasoning compacted/);
});

test("assistant response processing returns normalized tool calls without reasoning metadata", () => {
  const result = processAssistantStreamResponse(baseInput({
    streamResult: {
      content: "",
      reasoningContent: "",
      reasoningField: undefined,
      toolCalls: [{ id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }],
      finishReason: "tool_calls",
    },
  }));

  assert.equal(result.providerReasoningForHistory, null);
  assert.equal(result.normalized.toolCalls.length, 1);
  assert.equal(result.normalized.toolCalls[0].name, "read_file");
});
