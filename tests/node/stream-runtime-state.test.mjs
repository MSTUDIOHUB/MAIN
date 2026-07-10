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
  activateChatFinalSynthesisState,
  createAgentLoopStreamRuntimeState,
  markChatFinalSynthesisPromptUsed,
  resolveFinalTextOnlyStepState,
  resolveMaxOutputEscalations,
  resolvePlanStreamWatchdogState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/streamRuntimeState.ts"),
);

test("stream runtime state initializes final-text and synthesis flags", () => {
  assert.deepEqual(createAgentLoopStreamRuntimeState(), {
    usedMaxStepsFinalTextPrompt: false,
    chatFinalSynthesisActive: false,
    chatFinalSynthesisReason: "",
    usedChatFinalSynthesisPrompt: false,
    currentMaxTokens: undefined,
    loggedLocalPlanNoVisibleTokenNoticeOnly: false,
  });
});

test("max-output escalation is disabled for recovery and unapproved plan drafting", () => {
  assert.equal(resolveMaxOutputEscalations({
    executeRecoveryMode: "mutation_first",
    workflowMode: "chat",
    isPlanApproved: false,
  }), 0);

  assert.equal(resolveMaxOutputEscalations({
    executeRecoveryMode: "normal",
    workflowMode: "plan",
    isPlanApproved: false,
  }), 0);

  assert.equal(resolveMaxOutputEscalations({
    executeRecoveryMode: "normal",
    workflowMode: "chat",
    isPlanApproved: false,
  }), 2);
});

test("final-text-only state marks the max-step prompt once", () => {
  let state = createAgentLoopStreamRuntimeState();
  const first = resolveFinalTextOnlyStepState(state, {
    workflowMode: "chat",
    runtimeIntent: "respond",
    isPlanApproved: false,
    iteration: 25,
    maxIterations: 25,
  });
  assert.equal(first.finalTextOnlyStep, true);
  assert.equal(first.state.usedMaxStepsFinalTextPrompt, true);
  state = first.state;

  const second = resolveFinalTextOnlyStepState(state, {
    workflowMode: "chat",
    runtimeIntent: "respond",
    isPlanApproved: false,
    iteration: 26,
    maxIterations: 25,
  });
  assert.equal(second.finalTextOnlyStep, false);
  assert.equal(second.state, state);
});

test("chat final synthesis activation is idempotent and caps max tokens", () => {
  const state = {
    ...createAgentLoopStreamRuntimeState(),
    currentMaxTokens: 4096,
  };
  const activated = activateChatFinalSynthesisState(state, {
    reason: "length_no_tool_chat",
  });
  assert.equal(activated.changed, true);
  assert.equal(activated.state.chatFinalSynthesisActive, true);
  assert.equal(activated.state.chatFinalSynthesisReason, "length_no_tool_chat");
  assert.equal(activated.state.currentMaxTokens, 2048);

  const repeated = activateChatFinalSynthesisState(activated.state, {
    reason: "different_reason",
  });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.state, activated.state);

  const promptUsed = markChatFinalSynthesisPromptUsed(activated.state);
  assert.equal(promptUsed.usedChatFinalSynthesisPrompt, true);
  assert.equal(markChatFinalSynthesisPromptUsed(promptUsed), promptUsed);
});

test("plan stream watchdog state separates local notice from active watchdog options", () => {
  let state = createAgentLoopStreamRuntimeState();
  const localXml = resolvePlanStreamWatchdogState(state, {
    workflowMode: "plan",
    isPlanApproved: false,
    nativeToolCount: 0,
    activeProfile: "local",
    provider: "ollama",
    toolProtocol: "xml",
  });
  assert.equal(localXml.options, undefined);
  assert.equal(localXml.shouldLogLocalPlanNotice, true);
  assert.equal(localXml.state.loggedLocalPlanNoVisibleTokenNoticeOnly, true);
  state = localXml.state;

  const localXmlRepeat = resolvePlanStreamWatchdogState(state, {
    workflowMode: "plan",
    isPlanApproved: false,
    nativeToolCount: 0,
    activeProfile: "local",
    provider: "ollama",
    toolProtocol: "xml",
  });
  assert.equal(localXmlRepeat.options, undefined);
  assert.equal(localXmlRepeat.shouldLogLocalPlanNotice, false);
  assert.equal(localXmlRepeat.state, state);

  const cloudNative = resolvePlanStreamWatchdogState(state, {
    workflowMode: "plan",
    isPlanApproved: false,
    nativeToolCount: 0,
    activeProfile: "cloud",
    provider: "openai",
    toolProtocol: "native",
  });
  assert.equal(cloudNative.shouldLogLocalPlanNotice, false);
  assert.equal(cloudNative.options.noVisibleTokenTimeoutMs > 0, true);
  assert.equal(cloudNative.options.noVisibleTokenTimeoutLabel, "plan:preapproval_xml_tools");
});
