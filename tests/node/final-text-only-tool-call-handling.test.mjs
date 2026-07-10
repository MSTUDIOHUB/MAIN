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
  handleFinalTextOnlyToolCalls,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/finalTextOnlyToolCallHandling.ts"),
);

function createHarness(overrides = {}) {
  const streamTokens = [];
  const finalTexts = [];
  const appended = [];
  const statuses = [];
  const stops = [];
  const events = [];
  const completed = [];
  const callbacks = {
    getPreferredLanguage: () => overrides.language || "en",
    onStreamToken: (token, messageId) => streamTokens.push({ token, messageId }),
    onAssistantFinalText: (text, replyOptions, meta) => finalTexts.push({ text, replyOptions, meta }),
    appendMessage: (message) => appended.push(message),
    onStatusChange: (status) => statuses.push(status),
    onNonActionableStop: (message, reason, progress) => stops.push({ message, reason, progress }),
  };

  return {
    callbacks,
    streamTokens,
    finalTexts,
    appended,
    statuses,
    stops,
    events,
    completed,
    input: {
      callbacks,
      assistantMsgId: "assistant_1",
      iteration: 7,
      effectiveMaxIterations: 8,
      runtimeIntent: "execute",
      finalTextOnlyStep: true,
      chatFinalSynthesisActive: false,
      chatFinalSynthesisReason: "",
      repairExecutionRequestInChat: false,
      normalizedVisibleText: "Done.",
      effectiveToolCalls: [{ id: "call_1", name: "read_file", arguments: "{}" }],
      recentToolActivity: [],
      noProgressBatchRepeatCount: 0,
      providerReasoningForHistory: null,
      iterationContext: {
        eventThreadId: "thread_1",
        eventTurnId: "turn_1",
      },
      emitTurnEvent: (event) => events.push(event),
      emitTurnCompletedEvent: () => completed.push(true),
    },
  };
}

test("final text-only tool-call handling passes when the final-only routes are inactive", () => {
  const harness = createHarness();
  const result = handleFinalTextOnlyToolCalls({
    ...harness.input,
    finalTextOnlyStep: false,
    chatFinalSynthesisActive: false,
  });

  assert.deepEqual(result, { status: "none" });
  assert.deepEqual(harness.streamTokens, []);
  assert.deepEqual(harness.statuses, []);
});

test("final text-only tool-call handling passes when no tool calls exist", () => {
  const harness = createHarness();
  const result = handleFinalTextOnlyToolCalls({
    ...harness.input,
    effectiveToolCalls: [],
  });

  assert.deepEqual(result, { status: "none" });
  assert.deepEqual(harness.streamTokens, []);
});

test("final text-only tool-call handling completes with model-authored final text", () => {
  const harness = createHarness();
  const result = handleFinalTextOnlyToolCalls(harness.input);

  assert.deepEqual(result, { status: "stopped" });
  assert.deepEqual(harness.streamTokens, [
    { token: "__ESCALATION_RESET__:", messageId: "assistant_1" },
  ]);
  assert.deepEqual(harness.finalTexts, [{
    text: "Done.",
    replyOptions: [],
    meta: { hasToolCalls: false, modelAuthored: true },
  }]);
  assert.deepEqual(harness.appended, [{ role: "assistant", content: "Done." }]);
  assert.deepEqual(harness.statuses, ["idle"]);
  assert.equal(harness.completed.length, 1);
  assert.equal(harness.events[0].type, "item.completed");
  assert.equal(harness.events[0].threadId, "thread_1");
  assert.equal(harness.events[0].turnId, "turn_1");
  assert.equal(harness.events[0].item.details.text, "Done.");
});

test("chat final synthesis with unresolved repair request pauses as no-action", () => {
  const harness = createHarness();
  const result = handleFinalTextOnlyToolCalls({
    ...harness.input,
    runtimeIntent: "respond",
    finalTextOnlyStep: false,
    chatFinalSynthesisActive: true,
    chatFinalSynthesisReason: "length_no_tool_chat",
    repairExecutionRequestInChat: true,
    normalizedVisibleText: "I should inspect more files.",
    recentToolActivity: [
      { name: "read_file", target: "src/App.tsx", status: "succeeded" },
      { name: "read_file", target: "src/App.tsx", status: "succeeded" },
    ],
    noProgressBatchRepeatCount: 2,
  });

  assert.deepEqual(result, { status: "stopped" });
  assert.equal(harness.finalTexts.length, 0);
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "no_action");
  assert.equal(harness.stops[0].progress.phase, "paused");
  assert.deepEqual(harness.statuses, ["idle"]);
});

test("max-step final text-only tool calls without final text stop as no-action", () => {
  const harness = createHarness();
  const result = handleFinalTextOnlyToolCalls({
    ...harness.input,
    normalizedVisibleText: "   ",
  });

  assert.deepEqual(result, { status: "stopped" });
  assert.equal(harness.finalTexts.length, 0);
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "no_action");
  assert.equal(harness.stops[0].progress.recoveryReason, "max_iterations_boundary");
  assert.deepEqual(harness.statuses, ["idle"]);
});
