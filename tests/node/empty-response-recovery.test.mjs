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
  handleEmptyResponseRecovery,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/emptyResponseRecovery.ts"),
);

function makeCallbacks({ language = "en", approved = false, planStage = "drafting" } = {}) {
  const events = [];
  return {
    events,
    callbacks: {
      getPreferredLanguage: () => language,
      getIsPlanApproved: () => approved,
      getPlanStage: () => planStage,
      onStatusChange: (status) => events.push({ type: "status", status }),
      appendMessage: (message) => events.push({ type: "append", message }),
      onNonActionableStop: (message, reason, details) =>
        events.push({ type: "stop", message, reason, details }),
    },
  };
}

function emptyNormalized() {
  return {
    visibleText: "",
    hiddenThought: "",
    replyOptions: [],
    hasExplicitUserChoiceRequest: false,
    toolCalls: [],
    finishReason: "stop",
  };
}

function baseInput(overrides = {}) {
  const generated = makeCallbacks(overrides.callbackOptions);
  const callbacks = overrides.callbacks ?? generated.callbacks;
  return {
    callbacks,
    activeProfile: "local",
    iteration: 4,
    workflowMode: "chat",
    turnIntent: "respond",
    runtimeIntent: "respond",
    forceXmlTools: false,
    streamText: "",
    normalized: emptyNormalized(),
    normalizedBaseToolCallCount: 0,
    recentToolActivity: [],
    recentSuccessfulProjectWrite: null,
    consecutiveEmptyResponseCount: 0,
    emptyResponseCountThisTurn: 0,
    usedMalformedToolUseRecoveryPrompt: false,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
    pauseForReviewablePlanArtifact: async () => "not_reviewable",
    tryClosePlanWithEvidence: async () => "not_attempted",
    ...overrides,
    callbacks,
  };
}

test("empty chat response stops after the per-turn retry budget", async () => {
  const { callbacks, events } = makeCallbacks({ language: "zh" });
  const result = await handleEmptyResponseRecovery(baseInput({
    callbacks,
    emptyResponseCountThisTurn: 1,
    consecutiveEmptyResponseCount: 1,
  }));

  assert.equal(result.status, "stopped");
  assert.equal(result.emptyResponseCountThisTurn, 2);
  assert.equal(result.consecutiveEmptyResponseCount, 2);
  assert.equal(events.some((event) => event.type === "stop" && event.reason === "no_output"), true);
  assert.equal(events.some((event) => event.type === "status" && event.status === "idle"), true);
});

test("first unapproved plan empty response appends placeholder and plan continuation prompt", async () => {
  const { callbacks, events } = makeCallbacks({ language: "en", approved: false });
  const result = await handleEmptyResponseRecovery(baseInput({
    callbacks,
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveEmptyResponseCount, 1);
  assert.equal(events.filter((event) => event.type === "append").length, 2);
  assert.equal(events[0].message.content, "...");
  assert.match(events[1].message.content, /reviewable `<proposed_plan>`/);
  assert.match(events[1].message.content, /runtime owns materialization/);
});

test("second unapproved plan empty response attempts closure then continues with a stricter recovery", async () => {
  const { callbacks, events } = makeCallbacks({ language: "en", approved: false });
  const closureCalls = [];
  const result = await handleEmptyResponseRecovery(baseInput({
    callbacks,
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    consecutiveEmptyResponseCount: 1,
    tryClosePlanWithEvidence: async (trigger, details) => {
      closureCalls.push({ trigger, details });
      return "failed";
    },
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveEmptyResponseCount, 2);
  assert.deepEqual(closureCalls[0], {
    trigger: "empty_response_checkpoint",
    details: {
      consecutiveEmptyResponseCount: 2,
      toolCallCount: 0,
      replyOptionCount: 0,
    },
  });
  assert.equal(events.some((event) => event.type === "stop"), false);
  assert.equal(events.filter((event) => event.type === "append").length, 2);
  assert.match(events.at(-1)?.message.content || "", /task must continue/i);
  assert.match(events.at(-1)?.message.content || "", /exactly one targeted read-only tool/i);
});

test("third unapproved plan empty response stops only after bounded recovery is exhausted", async () => {
  const { callbacks, events } = makeCallbacks({ language: "en", approved: false });
  const result = await handleEmptyResponseRecovery(baseInput({
    callbacks,
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    consecutiveEmptyResponseCount: 2,
    tryClosePlanWithEvidence: async () => "failed",
  }));

  assert.equal(result.status, "stopped");
  assert.equal(result.consecutiveEmptyResponseCount, 3);
  assert.equal(events.some((event) => event.type === "stop" && event.reason === "incomplete_plan"), true);
});

test("empty edit response after project write asks for post-write verification", async () => {
  const { callbacks, events } = makeCallbacks({ language: "en" });
  const result = await handleEmptyResponseRecovery(baseInput({
    callbacks,
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    recentSuccessfulProjectWrite: { name: "replace_in_file", target: "src/app.ts" },
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.recoveringFromEmptyAssistantReplyAfterWrite, true);
  const userPrompt = events.find((event) => event.type === "append" && event.message.role === "user")?.message.content || "";
  assert.match(userPrompt, /verify|validation|inspect/i);
});

test("second native empty response after a write keeps verification on native tools", async () => {
  const { callbacks, events } = makeCallbacks({ language: "en" });
  const result = await handleEmptyResponseRecovery(baseInput({
    callbacks,
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    forceXmlTools: false,
    consecutiveEmptyResponseCount: 1,
    recentSuccessfulProjectWrite: { name: "replace_in_file", target: "src/app.ts" },
  }));

  assert.equal(result.status, "continue");
  const userPrompt = events.find((event) => event.type === "append" && event.message.role === "user")?.message.content || "";
  assert.match(userPrompt, /native tool call/i);
  assert.doesNotMatch(userPrompt, /XML|<tool_use>|<tool>|<parameter/i);
});

test("malformed plan tool-use block recovers before empty counters increment", async () => {
  const { callbacks, events } = makeCallbacks({ language: "en", approved: false });
  const result = await handleEmptyResponseRecovery(baseInput({
    callbacks,
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    streamText: "<tool_use><tool>write_file</tool></tool_use>",
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.usedMalformedToolUseRecoveryPrompt, true);
  assert.equal(result.consecutiveEmptyResponseCount, 0);
  assert.equal(result.emptyResponseCountThisTurn, 0);
  assert.equal(events.some((event) => event.type === "append" && /Malformed|tool_use|XML/i.test(event.message.content)), true);
});
