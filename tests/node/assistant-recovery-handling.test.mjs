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
  handleAssistantLanguageRecovery,
  handleAssistantNoToolRecovery,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantRecoveryHandling.ts"),
);
const {
  createAgentLoopRecoveryPromptRuntimeState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/recoveryPromptRuntimeState.ts"),
);

function createCallbacks(language = "en") {
  const events = [];
  return {
    events,
    callbacks: {
      appendMessage: (message) => events.push({ type: "appendMessage", message }),
      getPreferredLanguage: () => language,
      onNonActionableStop: (message, reason) =>
        events.push({ type: "nonActionableStop", message, reason }),
      onStatusChange: (status) => events.push({ type: "status", status }),
      onStreamToken: (token, messageId) =>
        events.push({ type: "streamToken", token, messageId }),
    },
  };
}

function noToolInput(overrides = {}) {
  const { callbacks } = createCallbacks();
  return {
    callbacks,
    assistantMsgId: "assistant-1",
    iteration: 2,
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    finishReason: "stop",
    effectiveToolCallCount: 0,
    finalReplyOptionCount: 0,
    userVisibleText: "I cannot access local workspace files or tools.",
    normalizedVisibleText: "I cannot access local workspace files or tools.",
    normalizedHiddenThought: "",
    compactedProseCodeDump: false,
    chatFinalSynthesisActive: false,
    recentToolActivity: [],
    consecutiveNoToolCount: 0,
    isCloudProfile: true,
    iterationToolCount: 3,
    llmToolCount: 3,
    forceXmlTools: false,
    pseudoToolCallPlaceholder: false,
    pseudoToolNameCandidate: null,
    recoveryPromptState: createAgentLoopRecoveryPromptRuntimeState(),
    activateChatFinalSynthesis: () => {},
    ...overrides,
  };
}

test("assistant no-tool recovery handler reprompts tool-unavailable claims and records state", () => {
  const context = createCallbacks();
  const result = handleAssistantNoToolRecovery(noToolInput({
    callbacks: context.callbacks,
    recentToolActivity: [
      { name: "read_file", status: "succeeded" },
      { name: "run_command", status: "succeeded" },
    ],
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.recoveryPromptState.usedToolUnavailableRecoveryPrompt, true);
  assert.equal(result.recentReadOnlyActivityCountForChat, 1);
  assert.deepEqual(
    context.events.map((event) => event.type),
    ["status", "appendMessage"],
  );
  assert.equal(context.events[0].status, "running");
  assert.match(context.events[1].message.content, /tools/i);
  assert.match(context.events[1].message.content, /native tool schemas/i);
  assert.doesNotMatch(context.events[1].message.content, /XML|<tool_use>|<tool>|<parameter/i);
});

test("assistant pseudo-tool recovery preserves native protocol", () => {
  const context = createCallbacks();
  const result = handleAssistantNoToolRecovery(noToolInput({
    callbacks: context.callbacks,
    isCloudProfile: false,
    userVisibleText: "[Tool call: read_file]",
    normalizedVisibleText: "[Tool call: read_file]",
    pseudoToolCallPlaceholder: true,
    pseudoToolNameCandidate: "read_file",
    forceXmlTools: false,
  }));

  assert.equal(result.status, "continue");
  const prompt = context.events.find((event) => event.type === "appendMessage")?.message.content || "";
  assert.match(prompt, /native tool call/i);
  assert.doesNotMatch(prompt, /XML|<tool_use>|<tool>|<parameter/i);
});

test("assistant no-tool recovery handler stops repeated pseudo-tool repair loops", () => {
  const context = createCallbacks();
  const usedRecoveryState = {
    ...createAgentLoopRecoveryPromptRuntimeState(),
    usedPseudoToolCallRecoveryPrompt: true,
  };
  const result = handleAssistantNoToolRecovery(noToolInput({
    callbacks: context.callbacks,
    isCloudProfile: false,
    iterationToolCount: 0,
    userVisibleText: "<tool>read_file</tool>",
    normalizedVisibleText: "<tool>read_file</tool>",
    pseudoToolCallPlaceholder: true,
    pseudoToolNameCandidate: "read_file",
    recoveryPromptState: usedRecoveryState,
  }));

  assert.equal(result.status, "stopped");
  assert.deepEqual(
    context.events.map((event) => event.type),
    ["streamToken", "nonActionableStop", "status"],
  );
  assert.equal(context.events[1].reason, "missing_tool_loop");
  assert.doesNotMatch(context.events[1].message, /XML|<tool_use>|<tool>|<parameter/i);
  assert.equal(context.events[2].status, "idle");
});

test("assistant language recovery handler reprompts once and marks recovery state", () => {
  const context = createCallbacks("zh");
  const result = handleAssistantLanguageRecovery({
    callbacks: context.callbacks,
    assistantMsgId: "assistant-2",
    iteration: 1,
    workflowMode: "edit",
    runtimeIntent: "execute",
    userVisibleText: "The root cause is a missing null guard.",
    shouldSuppressApprovedPlanNoToolText: false,
    effectiveToolCallCount: 0,
    injectedRequiredWebResearchCall: false,
    chatFinalSynthesisActive: false,
    recoveryPromptState: createAgentLoopRecoveryPromptRuntimeState(),
    recentReadOnlyActivityCountForChat: 0,
    consecutiveNoToolCount: 0,
    activateChatFinalSynthesis: () => {},
  });

  assert.equal(result.status, "continue");
  assert.equal(result.recoveryPromptState.usedLanguageMismatchRecoveryPrompt, true);
  assert.deepEqual(
    context.events.map((event) => event.type),
    ["streamToken", "status", "appendMessage"],
  );
  assert.match(context.events[2].message.content, /中文|Chinese/i);
});

test("assistant language recovery handler hides wrong-language text while preserving tool calls", () => {
  const context = createCallbacks("zh");
  const result = handleAssistantLanguageRecovery({
    callbacks: context.callbacks,
    assistantMsgId: "assistant-3",
    iteration: 1,
    workflowMode: "edit",
    runtimeIntent: "execute",
    userVisibleText: "I will inspect the file now.",
    shouldSuppressApprovedPlanNoToolText: false,
    effectiveToolCallCount: 1,
    injectedRequiredWebResearchCall: false,
    chatFinalSynthesisActive: false,
    recoveryPromptState: createAgentLoopRecoveryPromptRuntimeState(),
    recentReadOnlyActivityCountForChat: 0,
    consecutiveNoToolCount: 0,
    activateChatFinalSynthesis: () => {},
  });

  assert.equal(result.status, "pass");
  assert.equal(result.visibleAssistantText, "");
  assert.deepEqual(
    context.events.map((event) => event.type),
    ["streamToken"],
  );
});
