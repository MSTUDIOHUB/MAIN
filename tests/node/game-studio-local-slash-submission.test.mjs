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
  await result.completion;
  assert.deepEqual(harness.appendedTurns, [
    { content: "# Help", options: { systemVariant: "game_studio_local_markdown" } },
  ]);
  assert.deepEqual(harness.runtimeEvents.map((event) => event.type), [
    "slash.command.started",
    "slash.command.completed",
  ]);
  assert.equal(harness.runtimeEvents[0].command, "/help");
  assert.equal(harness.runtimeEvents[0].executionMode, "local_fast");
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
  assert.equal(harness.runtimeEvents[1].type, "slash.command.completed");
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
  await result.completion;
  assert.equal(harness.runtimeEvents[0].type, "slash.command.started");
  assert.equal(harness.runtimeEvents[1].type, "slash.command.failed");
  assert.equal(harness.runtimeEvents[1].error.message, "append failed");
  assert.match(fallbackTurns[0].content, /斜杠命令执行失败：append failed/);
});

test("game studio local slash submission leaves model workflows unhandled", () => {
  const harness = createHarness({
    resolution: { kind: "workflow" },
  });
  const result = startGameStudioLocalSlashSubmission(harness.input({
    command: { type: "workflow", slug: "dev-story", args: "camera", canonicalCommand: "/dev-story camera" },
  }));

  assert.equal(result.handled, false);
  assert.equal(result.completion, null);
  assert.equal(harness.appendedTurns.length, 0);
  assert.equal(harness.runtimeEvents.length, 0);
});
