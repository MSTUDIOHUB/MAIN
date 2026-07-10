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
  handleFinalNoToolAssistantTurn,
  handleReplyOptionsPause,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/finalTurnCompletion.ts"));

function createHarness(overrides = {}) {
  const appended = [];
  const events = [];
  const statuses = [];
  const stops = [];
  const completed = [];
  const callbacks = {
    getPreferredLanguage: () => overrides.language || "en",
    getPlanStage: () => overrides.planStage || "idle",
    appendMessage: (message) => appended.push(message),
    onStatusChange: (status) => statuses.push(status),
    onNonActionableStop: (message, reason) => stops.push({ message, reason }),
  };
  return {
    appended,
    events,
    statuses,
    stops,
    completed,
    callbacks,
    completion: {
      assistantHistoryText: "Assistant answer",
      providerReasoningForHistory: null,
      assistantMsgId: "assistant_1",
      iterationContext: {
        eventThreadId: "thread_1",
        eventTurnId: "turn_1",
      },
      emitTurnEvent: (event) => events.push(event),
      emitTurnCompletedEvent: () => completed.push(true),
    },
  };
}

test("reply option pause completes the assistant turn and leaves awaiting-input state to the runner", () => {
  const harness = createHarness({ planStage: "plan" });

  const result = handleReplyOptionsPause({
    callbacks: harness.callbacks,
    iteration: 2,
    shouldPauseForUserChoice: true,
    shouldSuppressApprovedPlanNoToolText: false,
    replyOptions: [{ id: "approve", label: "Approve", value: "approve" }],
    effectiveToolCallCount: 0,
    workflowMode: "plan",
    turnIntent: "plan",
    hasStructuredProposal: true,
    planStage: "plan",
    isPlanApproved: false,
    completion: harness.completion,
  });

  assert.equal(result.status, "stopped");
  assert.deepEqual(harness.appended, [{ role: "assistant", content: "Assistant answer" }]);
  assert.deepEqual(harness.statuses, ["idle"]);
  assert.deepEqual(harness.stops, []);
  assert.equal(harness.completed.length, 1);
  assert.equal(harness.events[0].type, "item.completed");
  assert.equal(harness.events[0].threadId, "thread_1");
  assert.equal(harness.events[0].turnId, "turn_1");
  assert.equal(harness.events[0].item.details.text, "Assistant answer");
});

test("unapproved plan final text pauses as incomplete when no review-ready plan exists", () => {
  const harness = createHarness({ planStage: "plan" });

  const result = handleFinalNoToolAssistantTurn({
    callbacks: harness.callbacks,
    iteration: 3,
    workflowMode: "plan",
    isPlanApproved: false,
    normalizedVisibleChars: 42,
    normalizedReplyOptionCount: 0,
    completion: harness.completion,
  });

  assert.equal(result.status, "stopped");
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "incomplete_plan");
  assert.deepEqual(harness.statuses, ["idle"]);
  assert.equal(harness.completed.length, 1);
  assert.equal(harness.events[0].item.details.type, "agent_message");
});

test("normal no-tool final text completes without a non-actionable stop", () => {
  const harness = createHarness();

  const result = handleFinalNoToolAssistantTurn({
    callbacks: harness.callbacks,
    iteration: 4,
    workflowMode: "edit",
    isPlanApproved: false,
    normalizedVisibleChars: 64,
    normalizedReplyOptionCount: 0,
    completion: harness.completion,
  });

  assert.equal(result.status, "stopped");
  assert.deepEqual(harness.stops, []);
  assert.deepEqual(harness.statuses, ["idle"]);
  assert.equal(harness.completed.length, 1);
  assert.equal(harness.appended[0].content, "Assistant answer");
});
