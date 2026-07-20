import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

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
  moduleCache.set(normalizedPath, module.exports);
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
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { startGameStudioLocalSlashSubmission } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/gameStudioLocalSlashSubmission.ts"),
);

function createHarness({ resolution } = {}) {
  const appendedTurns = [];
  const activeAgentCalls = [];
  const runtimeEvents = [];
  const logs = [];
  const runtimeService = {
    resolveSlashCommand(params) {
      if (typeof resolution === "function") return resolution(params);
      return resolution;
    },
  };

  return {
    appendedTurns,
    activeAgentCalls,
    runtimeEvents,
    logs,
    input(overrides = {}) {
      return {
        command: { type: "workflow", slug: "help", args: "", canonicalCommand: "/help" },
        preferredLanguage: "zh",
        runSessionKey: "workspace-a:1",
        turnId: "turn-1",
        runtimeService,
        getGameStudioInitialized: () => true,
        async commitActiveStudioAgentKey(agent, options) {
          activeAgentCalls.push({ agent, options });
        },
        async appendLocalStudioTurn(content, options) {
          appendedTurns.push({ content, options });
        },
        ensureVisibleConclusion({ terminal, content }) {
          return {
            disposition: "original_repaired",
            turnId: "turn-1",
            runId: terminal.runId,
            parentRunId: terminal.parentRunId,
            resultKind: terminal.resultKind,
            summary: content,
          };
        },
        emitRuntimeEvent(event) {
          runtimeEvents.push(event);
        },
        logStoreEvent(event, data) {
          logs.push({ event, data });
        },
        nowMs: () => 1234 + runtimeEvents.length,
        ...overrides,
      };
    },
  };
}

test("game studio local slash submission renders local markdown help", async () => {
  const harness = createHarness({
    resolution: { kind: "local_markdown", content: "# Help", systemVariant: "game_studio_local_markdown" },
  });
  const result = startGameStudioLocalSlashSubmission(harness.input({
    runId: "run-approved-help",
    parentRunId: "run-plan-parent",
  }));

  assert.equal(result.handled, true);
  assert.equal(result.runId, "run-approved-help");
  const completion = await result.completion;
  assert.equal(completion.resultKind, "success");
  assert.equal(completion.conclusionAppended, true);
  assert.deepEqual(completion.conclusionOwner, {
    disposition: "original_appended",
    turnId: "turn-1",
    runId: "run-approved-help",
    parentRunId: "run-plan-parent",
    resultKind: "success",
    summary: "# Help",
  });
  assert.deepEqual(harness.appendedTurns, [
    {
      content: "# Help",
      options: {
        systemVariant: "game_studio_local_markdown",
        presentation: "assistant_final",
        lifecycle: {
          terminal: {
            runId: "run-approved-help",
            parentRunId: "run-plan-parent",
            resultKind: "success",
            reason: "local_slash_completed",
          },
          slash: {
            command: "/help",
            executionMode: "local_fast",
            outcome: "completed",
          },
        },
      },
    },
  ]);
  assert.deepEqual(harness.runtimeEvents.map((event) => event.type), [
    "run.started",
    "slash.command.started",
  ]);
  assert.equal(harness.runtimeEvents[0].runId, "run-approved-help");
  assert.equal(harness.runtimeEvents[0].parentRunId, "run-plan-parent");
  assert.equal(harness.runtimeEvents[1].command, "/help");
  assert.equal(harness.runtimeEvents[1].executionMode, "local_fast");
});

test("game studio local slash submission switches sticky specialists", async () => {
  const harness = createHarness({
    resolution: { kind: "agent", slug: "unity-specialist" },
  });
  const result = startGameStudioLocalSlashSubmission(harness.input({
    command: { type: "agent", slug: "unity-specialist", canonicalCommand: "/agent unity-specialist" },
    preferredLanguage: "en",
    getGameStudioInitialized: () => false,
  }));

  assert.equal(result.handled, true);
  await result.completion;
  assert.deepEqual(harness.activeAgentCalls, [
    { agent: "unity-specialist", options: { persistToWorkspace: false } },
  ]);
  assert.match(harness.appendedTurns[0].content, /unity-specialist/);
  assert.equal(harness.appendedTurns[0].options.lifecycle.slash.outcome, "completed");
  assert.equal(harness.appendedTurns[0].options.lifecycle.terminal.resultKind, "success");
  assert.deepEqual(harness.runtimeEvents.map((event) => event.type), [
    "run.started",
    "slash.command.started",
  ]);
});

test("game studio local slash submission records failed handlers", async () => {
  const harness = createHarness({
    resolution: { kind: "agent", slug: "unity-specialist" },
  });
  const result = startGameStudioLocalSlashSubmission(harness.input({
    command: {
      type: "agent",
      slug: "unity-specialist",
      canonicalCommand: "/agent unity-specialist",
    },
    async commitActiveStudioAgentKey() {
      throw new Error("agent metadata unavailable");
    },
  }));

  assert.equal(result.handled, true);
  const completion = await result.completion;
  assert.equal(completion.resultKind, "error");
  assert.equal(completion.conclusionAppended, true);
  assert.equal(harness.appendedTurns.length, 1);
  assert.match(harness.appendedTurns[0].content, /斜杠命令执行失败：agent metadata unavailable/);
  assert.equal(harness.appendedTurns[0].options.presentation, "assistant_final");
  assert.deepEqual(harness.appendedTurns[0].options.lifecycle, {
    terminal: {
      runId: "run-local-slash-turn-1",
      parentRunId: null,
      resultKind: "error",
      reason: "local_slash_error",
    },
    slash: {
      command: "/agent unity-specialist",
      executionMode: "local_fast",
      outcome: "failed",
      error: { message: "agent metadata unavailable" },
    },
  });
  assert.deepEqual(harness.runtimeEvents.map((event) => event.type), [
    "run.started",
    "slash.command.started",
  ]);
});

test("game studio local slash submission delegates cancellation as one atomic bridge conclusion", async () => {
  const harness = createHarness({
    resolution: { kind: "local_markdown", content: "# Help", systemVariant: "game_studio_local_markdown" },
  });
  const controller = new AbortController();
  controller.abort();
  const result = startGameStudioLocalSlashSubmission(harness.input({
    abortSignal: controller.signal,
    preferredLanguage: "en",
  }));

  const completion = await result.completion;

  assert.equal(completion.resultKind, "canceled");
  assert.equal(completion.conclusionAppended, true);
  assert.equal(harness.appendedTurns.length, 1);
  assert.match(harness.appendedTurns[0].content, /Slash command canceled/);
  assert.equal(harness.appendedTurns[0].options.presentation, "assistant_final");
  assert.deepEqual(harness.appendedTurns[0].options.lifecycle.terminal, {
    runId: "run-local-slash-turn-1",
    parentRunId: null,
    resultKind: "canceled",
    reason: "local_slash_canceled",
  });
  assert.equal(harness.appendedTurns[0].options.lifecycle.slash.command, "/help");
  assert.equal(harness.appendedTurns[0].options.lifecycle.slash.executionMode, "local_fast");
  assert.equal(harness.appendedTurns[0].options.lifecycle.slash.outcome, "failed");
  assert.match(harness.appendedTurns[0].options.lifecycle.slash.error.message, /cancel/i);
  assert.deepEqual(harness.runtimeEvents.map((event) => event.type), [
    "run.started",
    "slash.command.started",
  ]);
});

test("game studio local slash cancellation before the side-effect commit linearizes as canceled", async () => {
  const harness = createHarness({
    resolution: { kind: "agent", slug: "unity-specialist" },
  });
  const controller = new AbortController();
  const committedAgents = [];
  let releaseSideEffect;
  const sideEffectBarrier = new Promise((resolve) => {
    releaseSideEffect = resolve;
  });
  const result = startGameStudioLocalSlashSubmission(harness.input({
    command: {
      type: "agent",
      slug: "unity-specialist",
      canonicalCommand: "/agent unity-specialist",
    },
    abortSignal: controller.signal,
    preferredLanguage: "en",
    async commitActiveStudioAgentKey(agent) {
      await sideEffectBarrier;
      if (controller.signal.aborted) {
        const error = new Error("agent switch canceled before commit");
        error.name = "AbortError";
        throw error;
      }
      committedAgents.push(agent);
    },
  }));

  controller.abort();
  releaseSideEffect();
  const completion = await result.completion;

  assert.equal(completion.resultKind, "canceled");
  assert.deepEqual(committedAgents, []);
  assert.equal(harness.appendedTurns.length, 1);
  assert.equal(harness.appendedTurns[0].options.lifecycle.terminal.resultKind, "canceled");
  assert.equal(harness.appendedTurns[0].options.lifecycle.slash.outcome, "failed");
});

test("game studio local slash abort after the side-effect commit linearizes as success", async () => {
  const harness = createHarness({
    resolution: { kind: "agent", slug: "unity-specialist" },
  });
  const controller = new AbortController();
  const committedAgents = [];
  const result = startGameStudioLocalSlashSubmission(harness.input({
    command: {
      type: "agent",
      slug: "unity-specialist",
      canonicalCommand: "/agent unity-specialist",
    },
    abortSignal: controller.signal,
    preferredLanguage: "en",
    async commitActiveStudioAgentKey(agent) {
      committedAgents.push(agent);
      queueMicrotask(() => controller.abort());
    },
  }));

  const completion = await result.completion;

  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(committedAgents, ["unity-specialist"]);
  assert.equal(completion.resultKind, "success");
  assert.equal(harness.appendedTurns.length, 1);
  assert.equal(harness.appendedTurns[0].options.lifecycle.terminal.resultKind, "success");
  assert.equal(harness.appendedTurns[0].options.lifecycle.slash.outcome, "completed");
});

test("game studio local slash bounds a never-settling committed side effect as error", { timeout: 1_000 }, async () => {
  const harness = createHarness({
    resolution: { kind: "agent", slug: "unity-specialist" },
  });
  const rejected = {
    disposition: "rejected",
    turnId: "turn-1",
    conclusionBlockId: null,
    userBlockId: 999,
    presentation: "system",
    adoptionDecision: {
      kind: "rejected",
      reason: "user_block_not_linked",
      turnId: "turn-1",
      userBlockId: 999,
    },
    terminal: null,
  };
  let sideEffectCalls = 0;
  let terminalAppendCalls = 0;
  let terminalRepairCalls = 0;
  const startedAt = Date.now();
  const result = startGameStudioLocalSlashSubmission(harness.input({
    command: {
      type: "agent",
      slug: "unity-specialist",
      canonicalCommand: "/agent unity-specialist",
    },
    preferredLanguage: "en",
    executionTimeoutMs: 20,
    commitActiveStudioAgentKey() {
      sideEffectCalls += 1;
      return new Promise(() => {});
    },
    async appendLocalStudioTurn() {
      terminalAppendCalls += 1;
      return rejected;
    },
    ensureVisibleConclusion(input) {
      terminalRepairCalls += 1;
      return {
        disposition: "recovery_completed",
        turnId: "local-slash-recovery-turn-1",
        runId: "run-local-slash-turn-1-presentation-recovery",
        parentRunId: "run-local-slash-turn-1",
        resultKind: "error",
        summary: input.content,
      };
    },
  }));

  const completion = await result.completion;
  const elapsedMs = Date.now() - startedAt;

  assert.equal(sideEffectCalls, 1);
  assert.equal(terminalAppendCalls, 1);
  assert.equal(terminalRepairCalls, 1);
  assert.equal(completion.resultKind, "error");
  assert.notEqual(completion.resultKind, "canceled");
  assert.equal(completion.conclusionAppended, true);
  assert.equal(completion.conclusionOwner.disposition, "recovery_completed");
  assert.match(completion.error.message, /timed out.*specialist switch persistence/i);
  assert.ok(elapsedMs < 500, `completion exceeded its bounded deadline: ${elapsedMs}ms`);
});

test("game studio local slash bounds never-settling append and repair projections", { timeout: 1_000 }, async () => {
  const harness = createHarness({
    resolution: { kind: "local_markdown", content: "# Help", systemVariant: "game_studio_local_markdown" },
  });
  let terminalAppendCalls = 0;
  let terminalRepairCalls = 0;
  const startedAt = Date.now();
  const result = startGameStudioLocalSlashSubmission(harness.input({
    executionTimeoutMs: 20,
    appendLocalStudioTurn() {
      terminalAppendCalls += 1;
      return new Promise(() => {});
    },
    ensureVisibleConclusion() {
      terminalRepairCalls += 1;
      return new Promise(() => {});
    },
  }));

  const completion = await result.completion;
  const elapsedMs = Date.now() - startedAt;

  assert.equal(completion.resultKind, "error");
  assert.equal(completion.conclusionAppended, false);
  assert.equal(completion.conclusionOwner, null);
  assert.equal(terminalAppendCalls, 2);
  assert.equal(terminalRepairCalls, 1);
  assert.match(completion.error.message, /timed out.*terminal projection/i);
  assert.match(completion.error.message, /timed out.*visible conclusion repair/i);
  assert.ok(elapsedMs < 500, `completion exceeded its bounded deadline: ${elapsedMs}ms`);
});

test("game studio local slash abort before side-effect admission remains canceled", { timeout: 1_000 }, async () => {
  const harness = createHarness({
    resolution: { kind: "agent", slug: "unity-specialist" },
  });
  const controller = new AbortController();
  let sideEffectCalls = 0;
  const result = startGameStudioLocalSlashSubmission(harness.input({
    command: {
      type: "agent",
      slug: "unity-specialist",
      canonicalCommand: "/agent unity-specialist",
    },
    abortSignal: controller.signal,
    preferredLanguage: "en",
    executionTimeoutMs: 20,
    async commitActiveStudioAgentKey() {
      sideEffectCalls += 1;
    },
  }));

  controller.abort();
  const completion = await result.completion;

  assert.equal(sideEffectCalls, 0);
  assert.equal(completion.resultKind, "canceled");
  assert.notEqual(completion.resultKind, "error");
});

test("game studio local slash submission repairs a visible final after exact Turn adoption rejection", async () => {
  const harness = createHarness({
    resolution: { kind: "local_markdown", content: "# Help", systemVariant: "game_studio_local_markdown" },
  });
  const appendCalls = [];
  const repairCalls = [];
  const rejected = {
    disposition: "rejected",
    turnId: "turn-1",
    conclusionBlockId: null,
    userBlockId: 999,
    presentation: "system",
    adoptionDecision: {
      kind: "rejected",
      reason: "user_block_not_linked",
      turnId: "turn-1",
      userBlockId: 999,
    },
    terminal: null,
  };
  const result = startGameStudioLocalSlashSubmission(harness.input({
    async appendLocalStudioTurn(content, options) {
      appendCalls.push({ content, options });
      return appendCalls.length === 1
        ? rejected
        : {
            ...rejected,
            presentation: options.presentation,
            terminal: options.lifecycle.terminal,
          };
    },
    async ensureVisibleConclusion(input) {
      repairCalls.push(input);
      return {
        disposition: "recovery_completed",
        turnId: "local-slash-recovery-run-local-slash-turn-1",
        runId: "run-local-slash-turn-1-presentation-recovery",
        parentRunId: "run-local-slash-turn-1",
        resultKind: "error",
        summary: input.content,
      };
    },
  }));

  const completion = await result.completion;

  assert.equal(completion.resultKind, "error");
  assert.equal(completion.conclusionAppended, true);
  assert.equal(completion.appendResult.disposition, "rejected");
  assert.equal(completion.appendResult.adoptionDecision.reason, "user_block_not_linked");
  assert.equal(appendCalls.length, 2);
  assert.equal(appendCalls[1].options.presentation, "assistant_final");
  assert.equal(appendCalls[1].options.lifecycle.slash.outcome, "failed");
  assert.equal(appendCalls[1].options.lifecycle.terminal.resultKind, "error");
  assert.equal(repairCalls.length, 1);
  assert.match(repairCalls[0].content, /斜杠命令执行失败/);
  assert.equal(repairCalls[0].terminal.resultKind, "error");
  assert.equal(repairCalls[0].rejectedAppend.adoptionDecision.reason, "user_block_not_linked");
  assert.equal(repairCalls[0].slashFailure.command, "/help");
  assert.equal(harness.runtimeEvents.filter((event) => event.type === "run.completed").length, 0);
  assert.equal(harness.runtimeEvents.filter((event) => event.type === "turn.completed").length, 0);
  assert.equal(completion.conclusionOwner.disposition, "recovery_completed");
  assert.equal(harness.logs.at(-1).event, "game_studio_local_slash_conclusion_append_failed");
});

test("game studio local slash submission leaves model workflows unhandled", () => {
  const harness = createHarness({
    resolution: { kind: "workflow" },
  });
  const result = startGameStudioLocalSlashSubmission(harness.input({
    command: { type: "workflow", slug: "dev-story", args: "camera", canonicalCommand: "/dev-story camera" },
  }));

  assert.equal(result.handled, false);
  assert.equal(result.runId, null);
  assert.equal(result.completion, null);
  assert.equal(harness.appendedTurns.length, 0);
  assert.equal(harness.runtimeEvents.length, 0);
});
