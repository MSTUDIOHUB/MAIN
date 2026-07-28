import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  cache.set(normalized, module.exports);
  return module.exports;
}

const { runRuntimeV2ChatLoop } = loadTs(
  path.join(workspaceRoot, "src/lib/runtime-v2/chat.ts"),
);
const runtime = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));

const turn = {
  workspaceKey: "/fixture",
  sessionKey: "session-chat",
  sessionEpoch: "epoch-chat",
  clientSubmissionId: "submission-chat",
  turnId: "turn-chat",
};
const run = {
  sessionKey: "session-chat",
  sessionEpoch: "epoch-chat",
  turnId: "turn-chat",
  runId: "run-chat",
  parentRunId: null,
  attemptId: "run-chat",
};

function harness(providerResults, options = {}) {
  let revision = 0;
  let clock = options.clock ?? 100;
  let ordinal = 0;
  let aggregate = null;
  const projections = [];
  let toolCalls = 0;
  let schedulerCalls = 0;
  let providerCalls = 0;
  const abort = options.abort || new AbortController();
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        aggregate = runtime.transition(aggregate, event);
        revision += 1;
        return {
          disposition: "committed",
          checkpoint: {
            schemaVersion: runtime.RUNTIME_V2_CHECKPOINT_SCHEMA_VERSION,
            revision,
            aggregate,
            updatedAt: clock,
          },
        };
      },
    },
    provider: {
      async request() {
        providerCalls += 1;
        const value = providerResults.shift();
        if (value instanceof Error) throw value;
        if (typeof value === "function") return value({ abort, advance: (ms) => { clock += ms; } });
        return value || { visibleText: "", toolCalls: [], diagnostics: [] };
      },
    },
    tool: {
      async execute() {
        toolCalls += 1;
        throw new Error("tool port must be unreachable");
      },
    },
    scheduler: {
      async execute() {
        schedulerCalls += 1;
        throw new Error("scheduler port must be unreachable");
      },
    },
    projection: {
      async publish(value) { projections.push(value); },
    },
    clockId: {
      now: () => clock,
      nextId: (scope) => `${scope}-${++ordinal}`,
      nextIdempotencyKey: ({ run: owner, kind }) => `${owner.runId}:${kind}:${++ordinal}`,
    },
  };
  return {
    abort,
    ports,
    projections,
    read: () => ({ aggregate, providerCalls, toolCalls, schedulerCalls }),
    now: () => clock,
  };
}

test("read-only Chat publishes one final and never reaches effect ports", async () => {
  const testHarness = harness([{
    visibleText: "这是完整的只读回答。",
    toolCalls: [],
    diagnostics: [],
  }]);
  const result = await runRuntimeV2ChatLoop({
    ports: testHarness.ports,
    turn,
    run,
    objective: "解释这个概念",
    signal: testHarness.abort.signal,
    now: testHarness.now,
    deadlineMs: 1_000,
  });
  const state = testHarness.read();
  assert.equal(result.resultKind, "success");
  assert.equal(state.providerCalls, 1);
  assert.equal(state.toolCalls, 0);
  assert.equal(state.schedulerCalls, 0);
  const modelCommand = result.aggregate.events.find((event) =>
    event.type === "command.scheduled" && event.command.kind === "request_model"
  );
  assert.equal(modelCommand?.command.payload.mode, "chat");
  assert.equal(result.aggregate.events.filter((event) => event.type === "run.completed").length, 1);
  assert.equal(result.aggregate.events.filter((event) => event.type === "turn.completed").length, 1);
  assert.equal(
    result.aggregate.events.filter((event) =>
      event.type === "projection.published" && event.audience === "final"
    ).length,
    1,
  );
  const finalProjection = testHarness.projections.find((entry) => entry.audience === "final");
  assert.equal(finalProjection.projection.markdown, "这是完整的只读回答。");
  const liveChatProjection = testHarness.projections.find((entry) =>
    entry.audience === "capsule_live" &&
    /理解当前问题/.test(entry.projection.markdown)
  );
  assert.ok(liveChatProjection);
  assert.doesNotMatch(liveChatProjection.projection.markdown, /根本原因|代码证据/);
  const milestones = testHarness.projections.filter((entry) => entry.audience === "chat_milestone");
  assert.equal(milestones.length, 0);
});

test("a hallucinated tool call concludes error without invoking the tool", async () => {
  const testHarness = harness([{
    visibleText: "准备修改。",
    toolCalls: [{ id: "call-1", name: "apply_patch", arguments: {} }],
    diagnostics: [],
  }]);
  const result = await runRuntimeV2ChatLoop({
    ports: testHarness.ports,
    turn,
    run,
    objective: "只解释，不修改",
    signal: testHarness.abort.signal,
    now: testHarness.now,
    deadlineMs: 1_000,
  });
  assert.equal(result.resultKind, "error");
  assert.equal(testHarness.read().toolCalls, 0);
  assert.equal(testHarness.read().schedulerCalls, 0);
  assert.equal(
    result.aggregate.events.filter((event) =>
      event.type === "command.scheduled" && event.command.kind === "execute_tool"
    ).length,
    0,
  );
});

test("transport exhaustion concludes error instead of pausing", async () => {
  const testHarness = harness([
    new Error("transport unavailable"),
    new Error("transport unavailable"),
    new Error("transport unavailable"),
    new Error("transport unavailable"),
  ]);
  const result = await runRuntimeV2ChatLoop({
    ports: testHarness.ports,
    turn,
    run,
    objective: "回答问题",
    signal: testHarness.abort.signal,
    now: testHarness.now,
    deadlineMs: 1_000,
  });
  assert.equal(result.resultKind, "error");
  assert.equal(result.reason, "provider_transport_exhausted");
  assert.equal(testHarness.read().providerCalls, 4);
  assert.equal(
    result.aggregate.events.filter((event) => event.type === "run.paused").length,
    0,
  );
  assert.equal(result.aggregate.events.filter((event) => event.type === "turn.completed").length, 1);
  assert.equal(result.aggregate.recovery.exhausted?.scope, "transport");
});

test("deadline and cancellation are distinct canonical conclusions", async (t) => {
  await t.test("deadline", async () => {
    const testHarness = harness([
      ({ advance }) => {
        advance(2_000);
        return { visibleText: "", toolCalls: [], diagnostics: [] };
      },
    ]);
    const result = await runRuntimeV2ChatLoop({
      ports: testHarness.ports,
      turn,
      run,
      objective: "回答问题",
      signal: testHarness.abort.signal,
      now: testHarness.now,
      deadlineMs: 1_000,
    });
    assert.equal(result.resultKind, "partial");
    assert.match(result.reason, /运行时限/);
  });

  await t.test("canceled", async () => {
    const abort = new AbortController();
    abort.abort("user-stop");
    const testHarness = harness([], { abort });
    const result = await runRuntimeV2ChatLoop({
      ports: testHarness.ports,
      turn,
      run,
      objective: "回答问题",
      signal: abort.signal,
      now: testHarness.now,
      deadlineMs: 1_000,
    });
    assert.equal(result.resultKind, "canceled");
    assert.equal(testHarness.read().providerCalls, 0);
    const ordered = result.aggregate.events
      .filter((event) =>
        event.type === "run.aborted" ||
        event.type === "run.completed" ||
        event.type === "turn.completed"
      )
      .map((event) => event.type);
    assert.deepEqual(ordered, ["run.aborted", "run.completed", "turn.completed"]);
  });
});

test("Chat adapter has no legacy runtime import, tools, or prose lifecycle classifier", () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/chatRunner.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /orchestrator|workflowEngine|AgentOrchestrator|WorkflowContext/);
  assert.doesNotMatch(source, /TOOL_DEFINITIONS|executeTool|createRuntimeV2ToolPort/);
  assert.doesNotMatch(
    source,
    /visibleText\.(?:includes|match|search|startsWith)|RegExp\([^)]*visibleText/,
  );
  assert.match(source, /offeredToolCount:\s*0/);
  assert.match(source, /toolChoice:\s*"none"/);
  assert.match(source, /isRuntimeV2GlobalChatTurn/);
  assert.match(source, /RUNTIME_V2_CHAT_REJECTS_WORKSPACE_SESSION/);
});
