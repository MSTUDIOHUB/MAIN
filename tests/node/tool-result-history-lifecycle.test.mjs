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
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { appendToolResultsToHistory } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultHistory.ts"),
);

function createFixture(startedIds = []) {
  const events = [];
  const messages = [];
  return {
    events,
    messages,
    input: {
      callbacks: {
        appendMessage: (message) => messages.push(message),
      },
      toolFeedbackFormat: "envelope_v1",
      toolArgsByCallId: new Map(),
      iterationContext: {
        eventThreadId: "thread-a",
        eventTurnId: "turn-a",
        turnContext: {
          registerToolExecution: () => {},
          addItem: () => {},
        },
        startedToolCallIds: new Set(startedIds),
        completedToolCallIds: new Set(),
      },
      emitTurnEvent: (event) => events.push(event),
    },
  };
}

test("started internal policy feedback closes exactly one blocked lifecycle item", () => {
  const fixture = createFixture(["call-shell-read"]);
  const result = {
    toolCallId: "call-shell-read",
    name: "run_command",
    target: "grep -n needle src/main.js",
    content: "internal policy prose must not enter the event",
    displayContent: "internal policy prose must not enter the event",
    isError: false,
    internalFeedback: true,
    lifecycleState: "blocked",
    qualityGateReason: "shell_read_forbidden",
  };

  appendToolResultsToHistory({ ...fixture.input, results: [result] });
  appendToolResultsToHistory({ ...fixture.input, results: [result] });

  assert.equal(fixture.messages.length, 2, "model protocol history may be appended by both folds");
  assert.equal(fixture.events.length, 1, "the item lifecycle is terminal exactly once");
  assert.equal(fixture.events[0].type, "item.completed");
  assert.deepEqual(fixture.events[0].item.details, {
    type: "tool_lifecycle",
    toolCallId: "call-shell-read",
    tool: "run_command",
    target: "grep -n needle src/main.js",
    status: "blocked",
    reason: "shell_read_forbidden",
  });
  assert.equal(JSON.stringify(fixture.events).includes("internal policy prose"), false);
});

test("unstarted internal feedback does not synthesize an orphan completion", () => {
  const fixture = createFixture();
  appendToolResultsToHistory({
    ...fixture.input,
    results: [{
      toolCallId: "call-preexecution",
      name: "read_file",
      target: "src/main.js",
      content: "protocol-only feedback",
      isError: false,
      internalFeedback: true,
      lifecycleState: "blocked",
      qualityGateReason: "required_tool_call_not_available",
    }],
  });

  assert.equal(fixture.messages.length, 1);
  assert.deepEqual(fixture.events, []);
});

test("normal started results retain the public tool_result completion shape", () => {
  const fixture = createFixture(["call-read"]);
  appendToolResultsToHistory({
    ...fixture.input,
    results: [{
      toolCallId: "call-read",
      name: "read_file",
      target: "src/main.js",
      content: "const ready = true;",
      isError: false,
      lifecycleState: "completed",
    }],
  });

  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0].item.details.type, "tool_result");
  assert.equal(fixture.events[0].item.details.status, "completed");
  assert.equal(fixture.events[0].item.details.text, "const ready = true;");
});
