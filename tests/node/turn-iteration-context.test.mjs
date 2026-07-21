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
  startTurnIteration,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/turnIterationContext.ts"),
);

test("turn iteration context creates and reuses the session thread", () => {
  const first = startTurnIteration({
    currentThread: null,
    eventThreadId: "session-a",
    eventTurnId: "turn-root",
    runId: "run-a",
    iteration: 1,
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(first.thread.threadId, "session-a");
  assert.equal(first.runId, "run-a");
  assert.equal(first.iterationTurnId, "turn-root-run-a-1");
  assert.equal(first.turn.turnId, "turn-root-run-a-1");
  assert.equal(first.thread.turns.length, 1);
  assert.equal(first.turnContext.turnId, "turn-root-run-a-1");

  const second = startTurnIteration({
    currentThread: first.thread,
    eventThreadId: "session-a",
    eventTurnId: "turn-root",
    runId: "run-a",
    iteration: 2,
    messages: [{ role: "user", content: "continue" }],
  });

  assert.equal(second.thread, first.thread);
  assert.equal(second.thread.turns.length, 2);
  assert.equal(second.turn.turnId, "turn-root-run-a-2");
});

test("turn iteration context resets the thread when the event thread changes", () => {
  const first = startTurnIteration({
    currentThread: null,
    eventThreadId: "session-a",
    eventTurnId: "turn-root",
    runId: "run-a",
    iteration: 1,
    messages: [],
  });
  const next = startTurnIteration({
    currentThread: first.thread,
    eventThreadId: "session-b",
    eventTurnId: "turn-root",
    runId: "run-b",
    iteration: 1,
    messages: [],
  });

  assert.notEqual(next.thread, first.thread);
  assert.equal(next.thread.threadId, "session-b");
  assert.equal(next.thread.turns.length, 1);
});

test("turn iteration identity is scoped by Run when one logical Turn resumes", () => {
  const firstRun = startTurnIteration({
    currentThread: null,
    eventThreadId: "session-a",
    eventTurnId: "turn-shared",
    runId: "run-source",
    iteration: 1,
    messages: [],
  });
  const resumedRun = startTurnIteration({
    currentThread: firstRun.thread,
    eventThreadId: "session-a",
    eventTurnId: "turn-shared",
    runId: "run-recovery",
    iteration: 1,
    messages: [],
  });

  assert.equal(firstRun.iterationTurnId, "turn-shared-run-source-1");
  assert.equal(resumedRun.iterationTurnId, "turn-shared-run-recovery-1");
  assert.notEqual(resumedRun.iterationTurnId, firstRun.iterationTurnId);
});
