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

function createHarness({ resolution, appendThrows = false } = {}) {
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
        async setActiveStudioAgentKey(agent, options) {
          activeAgentCalls.push({ agent, options });
        },
        async appendLocalStudioTurn(content, options) {
          if (appendThrows) throw new Error("append failed");
          appendedTurns.push({ content, options });
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
  const result = startGameStudioLocalSlashSubmission(harness.input());

  assert.equal(result.handled, true);
  assert.equal(result.runId, "run-local-slash-turn-1");
  const completion = await result.completion;
  assert.equal(completion.resultKind, "success");
  assert.equal(completion.conclusionAppended, true);
  assert.deepEqual(harness.appendedTurns, [
    {
      content: "# Help",
      options: {
        systemVariant: "game_studio_local_markdown",
        terminal: {
          runId: "run-local-slash-turn-1",
          parentRunId: null,
          resultKind: "success",
          reason: "local_slash_completed",
        },
      },
    },
  ]);
  assert.deepEqual(harness.runtimeEvents.map((event) => event.type), [
    "run.started",
    "slash.command.started",
    "slash.command.completed",
    "run.completed",
    "turn.completed",
  ]);
  assert.equal(harness.runtimeEvents[0].runId, "run-local-slash-turn-1");
  assert.equal(harness.runtimeEvents[1].command, "/help");
  assert.equal(harness.runtimeEvents[1].executionMode, "local_fast");
  assert.equal(harness.runtimeEvents[3].resultKind, "success");
  assert.equal(harness.runtimeEvents[4].resultKind, "success");
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
  assert.equal(harness.runtimeEvents[2].type, "slash.command.completed");
  assert.deepEqual(harness.runtimeEvents.slice(-2).map((event) => [event.type, event.resultKind]), [
    ["run.completed", "success"],
    ["turn.completed", "success"],
  ]);
});

test("game studio local slash submission records failed handlers", async () => {
  const harness = createHarness({
    resolution: { kind: "auto" },
    appendThrows: true,
  });
  const fallbackTurns = [];
  const result = startGameStudioLocalSlashSubmission(harness.input({
    command: { type: "auto", canonicalCommand: "/auto" },
    async appendLocalStudioTurn(content, options) {
      if (harness.appendedTurns.length === 0) {
        harness.appendedTurns.push({ content, options });
        throw new Error("append failed");
      }
      fallbackTurns.push({ content, options });
    },
  }));

  assert.equal(result.handled, true);
  const completion = await result.completion;
  assert.equal(completion.resultKind, "error");
  assert.equal(completion.conclusionAppended, true);
  assert.equal(harness.runtimeEvents[0].type, "run.started");
  assert.equal(harness.runtimeEvents[1].type, "slash.command.started");
  assert.equal(harness.runtimeEvents[2].type, "slash.command.failed");
  assert.equal(harness.runtimeEvents[2].error.message, "append failed");
  assert.equal(harness.runtimeEvents[3].type, "run.completed");
  assert.equal(harness.runtimeEvents[3].resultKind, "error");
  assert.equal(harness.runtimeEvents[4].type, "turn.completed");
  assert.equal(harness.runtimeEvents[4].resultKind, "error");
  assert.match(fallbackTurns[0].content, /斜杠命令执行失败：append failed/);
  assert.equal(fallbackTurns[0].options.presentation, "assistant_final");
  assert.equal(fallbackTurns[0].options.terminal.resultKind, "error");
});

test("game studio local slash submission closes cancellation with one visible final and canonical terminals", async () => {
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
  assert.equal(harness.appendedTurns[0].options.terminal.resultKind, "canceled");
  assert.deepEqual(harness.runtimeEvents.map((event) => event.type), [
    "run.started",
    "slash.command.started",
    "slash.command.failed",
    "run.completed",
    "turn.completed",
  ]);
  assert.equal(harness.runtimeEvents.filter((event) => event.type === "run.completed").length, 1);
  assert.equal(harness.runtimeEvents.filter((event) => event.type === "turn.completed").length, 1);
  assert.equal(harness.runtimeEvents.at(-2).resultKind, "canceled");
  assert.equal(harness.runtimeEvents.at(-1).resultKind, "canceled");
});

test("game studio local slash submission reports exact Turn adoption rejection to its caller", async () => {
  const harness = createHarness({
    resolution: { kind: "local_markdown", content: "# Help", systemVariant: "game_studio_local_markdown" },
  });
  const appendCalls = [];
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
        : { ...rejected, presentation: options.presentation, terminal: options.terminal };
    },
  }));

  const completion = await result.completion;

  assert.equal(completion.resultKind, "error");
  assert.equal(completion.conclusionAppended, false);
  assert.equal(completion.appendResult.disposition, "rejected");
  assert.equal(completion.appendResult.adoptionDecision.reason, "user_block_not_linked");
  assert.equal(appendCalls.length, 2);
  assert.equal(appendCalls[1].options.presentation, "assistant_final");
  assert.equal(harness.runtimeEvents.filter((event) => event.type === "run.completed").length, 1);
  assert.equal(harness.runtimeEvents.filter((event) => event.type === "turn.completed").length, 1);
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
