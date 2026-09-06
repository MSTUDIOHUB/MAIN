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
const { buildRuntimeV2ChatIdentities } = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/chatRunner.ts"),
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
  const requests = [];
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
      async request({ command }) {
        requests.push(command);
        providerCalls += 1;
        const value = providerResults.shift();
        if (value instanceof Error) throw value;
        if (typeof value === "function") return value({ abort, advance: (ms) => { clock += ms; } });
        return value || { visibleText: "", toolCalls: [], diagnostics: [] };
      },
    },
    tool: {
      async execute(input) {
        toolCalls += 1;
        if (options.toolExecute) return options.toolExecute(input);
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
    requests,
    read: () => ({ aggregate, providerCalls, toolCalls, schedulerCalls }),
    now: () => clock,
  };
}

const progress = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/readOnlyProgress.ts"));
const history = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/readOnlyHistory.ts"));
const types = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionTypes.ts"));
const network = loadTs(path.join(workspaceRoot, "src/lib/networkRead.ts"));
const token = loadTs(path.join(workspaceRoot, "src/lib/contextTrim.ts"));
const auth = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionAuthorizationContext.ts"));
const toolPolicy = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionAuthorization.ts"));
const requestPolicy = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionProviderRequestPolicy.ts"));
const enabled = { enabled: true, provider: "bing" };
const answer = { visibleText: "根据已取得的资料给出完整回答。", toolCalls: [], diagnostics: [] };
const resultData = (query, snippet = "same fact", url = "https://example.com/source") => ({ query, results: [{ url, title: "Source", snippet }] });
const call = (id, query) => ({ visibleText: "", toolCalls: [{ id, name: "web_search", arguments: { query } }], diagnostics: [] });
const runLoop = (h, extra = {}) => runRuntimeV2ChatLoop({ ports: h.ports, turn, run, objective: "查阅资料并回答", signal: h.abort.signal, now: h.now, networkRead: enabled, ...extra });
function receipt(command, data, extra = {}) {
  return { type: "tool.completed", run: command.run, idempotencyKey: command.idempotencyKey, status: "succeeded", evidence: [{ id: `E${command.payload.toolCallId.replace(/\D/g, "") || 1}`, kind: "tool", target: "query", version: progress.readOnlyEvidenceVersion("web_search", data) }], modelContent: JSON.stringify(data), ...extra };
}

test("network permission is frozen and absent/invalid legacy snapshots stay disabled", () => {
  const state = { webSearchEnabled: true, webSearchProvider: "bing" };
  const policy = network.captureNetworkRead(state);
  state.webSearchEnabled = false;
  state.webSearchProvider = "baidu";
  assert.deepEqual(policy, enabled);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(network.normalizeNetworkRead(undefined).enabled, false);
  assert.equal(network.normalizeNetworkRead({ enabled: true, provider: "invalid" }).enabled, false);
});

test("search version ignores query spelling, result order and tracking URLs but keeps changed facts", () => {
  const a = resultData("one");
  const b = resultData("two", "same fact", "https://example.com/source?utm_source=tracking#top");
  assert.equal(progress.readOnlyEvidenceVersion("web_search", a), progress.readOnlyEvidenceVersion("web_search", b));
  assert.notEqual(progress.readOnlyEvidenceVersion("web_search", a), progress.readOnlyEvidenceVersion("web_search", resultData("one", "new fact")));
  assert.notEqual(progress.readOnlyEvidenceVersion("web_fetch", { final_url: "https://example.com", content: "fact", truncated: true }), progress.readOnlyEvidenceVersion("web_fetch", { final_url: "https://example.com", content: "fact", truncated: false }));
});

test("Bing tracking identity and unverified reader pages cannot mint fresh source versions", () => {
  const target = "https://example.com/source";
  const encoded = Buffer.from(target).toString("base64url");
  assert.equal(progress.normalizedEvidenceUrl(`https://www.bing.com/ck/a?p=first&u=a1${encoded}&ntb=1`), target);
  assert.equal(progress.readOnlyEvidenceVersion("web_search", resultData("one", "fact", target)), progress.readOnlyEvidenceVersion("web_search", resultData("two", "fact", `https://www.bing.com/ck/a?p=other&u=a1${encoded}`)));
  const unavailable = { url: target, content: "An error page body", retrieval: { usable: false, readerStatus: 200, originStatus: 404, directError: "HTTP 404" } };
  assert.deepEqual(progress.webEvidenceVersions("web_fetch", unavailable), []);
});

test("search discovery without reading a source cannot indefinitely renew semantic progress", async () => {
  const h = harness([call("s1", "first"), call("s2", "different"), call("s3", "another"), answer], { toolExecute: ({ command }) => receipt(command, resultData(command.payload.arguments.query, "different snippet", `https://example.com/${command.payload.arguments.query}`)) });
  await runLoop(h);
  assert.equal(h.requests.at(-1).payload.conclusionKind, "read_only");
  assert.equal(h.requests.at(-1).payload.recoveryPressure.occurrence, 2);
});

test("two settled non-novel batches close tools and produce a real answer", async () => {
  const h = harness([call("s1", "one"), call("s2", "two"), call("s3", "three"), answer], { toolExecute: ({ command }) => receipt(command, resultData(command.payload.arguments.query)) });
  const result = await runLoop(h);
  assert.equal(result.resultKind, "success");
  assert.deepEqual(h.requests.map((item) => item.payload.mode), ["chat", "chat", "chat", "conclude"]);
  assert.equal(h.requests.at(-1).payload.conclusionKind, "read_only");
  assert.equal(h.requests.at(-1).payload.recoveryPressure.reason, "non_novel_evidence");
  assert.equal(h.requests.at(-1).payload.recoveryPressure.occurrence, 2);
  const order = result.aggregate.events.filter((event) => event.type === "run.completed" || (event.type === "projection.published" && event.projection.kind === "final") || event.type === "turn.completed").map((event) => event.type);
  assert.deepEqual(order, ["run.completed", "projection.published", "turn.completed"]);
});

test("replayed successes with empty evidence do not clear pressure; new evidence does", async () => {
  const fetch = (id) => ({ visibleText: "", diagnostics: [], toolCalls: [{ id, name: "web_fetch", arguments: { url: "https://example.com/source" } }] });
  const h = harness([call("s1", "one"), call("s2", "replay"), fetch("s3"), fetch("s4"), answer], { toolExecute: ({ command }) => receipt(command, command.payload.toolName === "web_fetch" ? { url: "https://example.com/source", content: "new source fact" } : resultData("ignored"), command.payload.toolCallId === "s2" ? { receiptOrigin: "replayed", evidence: [] } : {}) });
  await runLoop(h);
  assert.equal(h.requests[2].payload.recoveryPressure.occurrence, 1);
  assert.equal(h.requests[3].payload.recoveryPressure, undefined);
  assert.equal(h.requests[4].payload.recoveryPressure.occurrence, 1);
});

test("novelty counts cumulative source coverage, not a reshaped overlapping window", () => {
  const events = [];
  for (const [i, start, end] of [[1, 1, 10], [2, 11, 20], [3, 5, 15]]) {
    const command = { idempotencyKey: `t${i}`, payload: { toolCallId: `s${i}` }, kind: "execute_tool" };
    events.push({ type: "provider.responded", at: i * 10, result: { toolCalls: [{ id: `s${i}`, name: "read_file", arguments: {} }], diagnostics: [] } }, { type: "command.scheduled", command }, {
      type: "tool.completed", at: i * 10 + 1, idempotencyKey: `t${i}`, status: "succeeded", evidence: [{ id: `E${i}`, kind: "source", target: "file.ts", version: "v1" }], modelContent: `READ_FILE_RESULT\npath: file.ts\ntotalLines: 20\ntotalChars: 80\nreturnedLines: ${start}-${end}\nreturnedChars: 40\n---CONTENT START---\ncontents`,
    });
  }
  const state = { events: events.map((event, sequence) => ({ ...event, sequence })), pendingToolCalls: [], scheduledCommands: [] };
  assert.equal(progress.deriveReadOnlyRecoveryWindow(state).pressure.occurrence, 1);
});

test("slow valid answers and slow new evidence survive more than ten minutes", async () => {
  const h = harness([({ advance }) => { advance(11 * 60_000); return call("s1", "new"); }, ({ advance }) => { advance(11 * 60_000); return answer; }], { toolExecute: ({ command }) => receipt(command, resultData("new")) });
  const result = await runLoop(h);
  assert.equal(result.resultKind, "success");
  assert.equal(h.now() > 22 * 60_000, true);
});

test("a valid slow recovery response wins over the old stall lease", async () => {
  const h = harness([{ visibleText: "", toolCalls: [], diagnostics: [] }, ({ advance }) => { advance(11 * 60_000); return answer; }]);
  assert.equal((await runLoop(h)).resultKind, "success");
});

test("recovery lease exhaustion without an answer is error even with evidence", async () => {
  const h = harness([call("s1", "one"), { visibleText: "", toolCalls: [], diagnostics: [] }, ({ advance }) => { advance(11 * 60_000); return { visibleText: "", toolCalls: [], diagnostics: [] }; }], { toolExecute: ({ command }) => receipt(command, resultData("one")) });
  const result = await runLoop(h);
  assert.equal(result.resultKind, "error");
  assert.match(result.reason, /恢复租约/);
});

test("an empty or truncated conclusion recovers before a truthful final answer", async () => {
  for (const final of [{ visibleText: "", toolCalls: [], diagnostics: [] }, { visibleText: "unfinished", toolCalls: [], diagnostics: [{ code: "output_truncated", message: "length", retryable: false }] }]) {
    const h = harness([{ visibleText: "", toolCalls: [], diagnostics: [] }, { visibleText: "", toolCalls: [], diagnostics: [] }, final, answer]);
    assert.equal((await runLoop(h)).resultKind, "success");
    assert.equal(h.requests.length, 4);
    assert.equal(h.requests.at(-1).payload.mode, "conclude");
  }
  assert.equal(requestPolicy.runtimeV2ProviderOutputWasTruncated({ finishReason: "length", toolCallCount: 0, availableToolCount: 0 }), true);
});

test("consecutive empty conclude attempts hit retry cap and stop spinning without waiting 10 minutes", async () => {
  const emptyConclude = { visibleText: "", toolCalls: [], diagnostics: [] };
  const h = harness([
    emptyConclude,
    emptyConclude,
    emptyConclude,
    emptyConclude,
    emptyConclude,
    emptyConclude,
  ]);
  const result = await runLoop(h);
  assert.equal(result.resultKind, "error");
  assert.match(result.reason, /最大重试次数/);
  // Total requests: 2 chat + 3 conclude attempts = 5 requests total (not 59)
  assert.equal(h.requests.length, 5);
  assert.equal(h.requests[2].payload.mode, "conclude");
  assert.equal(h.requests[3].payload.mode, "conclude");
  assert.equal(h.requests[4].payload.mode, "conclude");
});

test("the incident's repeated action commentary cannot finish Chat", async () => {
  const commentary = "让我尝试从东方财富网获取科创板芯片指数的数据。";
  const h = harness([{ ...call("s1", "source"), visibleText: commentary }, { ...answer, visibleText: commentary }, answer], { toolExecute: ({ command }) => receipt(command, resultData("source")) });
  const result = await runLoop(h);
  assert.equal(h.requests.length, 3);
  assert.equal(result.aggregate.events.find((event) => event.type === "projection.published" && event.projection.kind === "final").projection.markdown, answer.visibleText);
  assert.equal(h.requests[2].payload.recoveryPressure.occurrence, 1);
});

test("history preserves distinct evidence and tool pairs but references duplicate Web bodies even under budget", () => {
  const pair = (id, content) => [{ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "web_fetch", arguments: "{}" } }] }, { role: "tool", tool_call_id: id, content }];
  const messages = [{ role: "system", content: "instructions" }, { role: "user", content: "old question" }, { role: "assistant", content: "old answer" }, { role: "user", content: "current question" }, ...pair("one", "A ".repeat(1000)), ...pair("two", "B ".repeat(1000)), ...pair("again", "A ".repeat(1000))];
  const affordable = history.boundReadOnlyHistory(messages, { contextLimit: 100_000, reservedOutputTokens: 4_000 });
  assert.equal(affordable.length, messages.length);
  assert.equal(affordable.find((item) => item.tool_call_id === "one").content, "A ".repeat(1000));
  assert.equal(affordable.find((item) => item.tool_call_id === "two").content, "B ".repeat(1000));
  assert.equal(JSON.parse(affordable.find((item) => item.tool_call_id === "again").content).receiptReplayOf, "one");
  assert.equal(messages.at(-1).content, "A ".repeat(1000), "canonical history remains lossless");
  const bounded = history.boundReadOnlyHistory(messages, { contextLimit: 1500, reservedOutputTokens: 300 });
  assert.ok(token.estimateMessagesTokens(bounded) <= 1200);
  for (const item of bounded.filter((item) => item.role === "tool")) assert.ok(bounded.some((candidate) => candidate.tool_calls?.some((call) => call.id === item.tool_call_id)));
  for (const item of bounded.filter((item) => item.tool_calls?.length)) for (const call of item.tool_calls) assert.ok(bounded.some((candidate) => candidate.tool_call_id === call.id));
  assert.ok(bounded.some((item) => item.content === "current question"));
  for (const item of bounded.filter((item) => item.role === "tool" && String(item.content).includes('"receiptReplayOf"'))) {
    const original = bounded.find((candidate) => candidate.tool_call_id === JSON.parse(item.content).receiptReplayOf);
    assert.ok(original && !original.content.includes('"receiptReplayOf"'), "replay references always point to a retained original body");
  }
});

test("cold restore reconstructs exact tool pairs and evidence ordinals from the ledger", async () => {
  const h = harness([call("s1", "one"), answer], { toolExecute: ({ command }) => receipt(command, resultData("one")) });
  const result = await runLoop(h);
  const live = types.createRuntimeV2LiveExecutionState();
  history.restoreReadOnlyHistory(live, result.aggregate);
  assert.ok(live.messages.some((item) => item.tool_calls?.some((call) => call.id === "s1")));
  assert.equal(live.messages.find((item) => item.tool_call_id === "s1").content, JSON.stringify(resultData("one")));
  assert.equal(live.evidenceCounter, 1);
  assert.equal(progress.deriveReadOnlyRecoveryWindow(result.aggregate), null);
});

test("Chat tools use the snapshot, reject workspace tools, and conclude has an empty surface", async () => {
  let state = { config: {}, webSearchEnabled: false };
  const input = { get: () => state, context: { runtimeRunIntent: "respond", runWorkspace: "", networkRead: enabled, turnId: turn.turnId }, live: types.createRuntimeV2LiveExecutionState() };
  const names = auth.providerToolDefinitionsForCommand(input, { payload: { mode: "chat" } }).map((item) => item.function.name);
  assert.ok(names.includes("web_search") && names.includes("web_fetch"));
  assert.ok(names.every((name) => ["load_skill", "web_search", "web_fetch"].includes(name)));
  assert.equal((await toolPolicy.authorizeToolForCurrentTurn(input, "web_search", { query: "one" })).allowed, true);
  assert.deepEqual(auth.providerToolDefinitionsForCommand(input, { payload: { mode: "conclude", conclusionKind: "read_only" } }), []);
  state.webSearchEnabled = true;
  const legacy = { ...input, context: { ...input.context, networkRead: undefined }, live: types.createRuntimeV2LiveExecutionState() };
  assert.equal(auth.providerToolDefinitionsForCommand(legacy, { payload: { mode: "chat" } }).some((item) => item.function.name === "web_search"), false);
});

test("terminal recovery closes every durable interruption boundary exactly once", async () => {
  const h = harness([answer]);
  const completed = await runLoop(h);
  const events = completed.aggregate.events;
  for (const boundary of ["run.completed", "projection.published"]) {
    const cut = events.findIndex((event) => event.type === boundary && (boundary !== "projection.published" || event.projection.kind === "final"));
    let aggregate = events.slice(0, cut + 1).reduce((state, event) => runtime.transition(state, event), null);
    let revision = cut + 1;
    const published = [];
    const controller = new runtime.RuntimeV2Controller({ ...h.ports, checkpoint: { async append({ event }) { aggregate = runtime.transition(aggregate, event); return { disposition: "committed", checkpoint: { revision: ++revision } }; } }, projection: { async publish({ projection }) { published.push(projection); } } }, { aggregate, revision });
    await controller.resumeTerminalProjection();
    await controller.resumeTerminalProjection();
    const restored = controller.snapshot().aggregate;
    assert.equal(restored.events.filter((event) => event.type === "run.completed").length, 1);
    assert.equal(restored.events.filter((event) => event.type === "turn.completed").length, 1);
    assert.equal(restored.events.filter((event) => event.type === "projection.published" && event.projection.kind === "final").length, 1);
    assert.ok(published.every((item) => item.markdown === answer.visibleText && item.id === restored.terminalOutcome.finalProjectionId));
  }
});

test("executor forces the captured provider and disables Rust cross-provider fallback", async () => {
  const ipc = loadTs(path.join(workspaceRoot, "src/lib/ipc.ts"));
  const executor = loadTs(path.join(workspaceRoot, "src/lib/toolExecutor.ts"));
  const original = ipc.webSearch;
  const calls = [];
  ipc.webSearch = async (...args) => { calls.push(args); return resultData(args[0]); };
  try {
    await executor.executeTool("web_search", { query: "test", provider: "baidu", max_results: 3 }, "", "session", { networkRead: enabled });
    assert.deepEqual(calls, [["test", "bing", 3, false]]);
    await assert.rejects(() => executor.executeTool("web_search", { query: "test" }, "", "session", { networkRead: network.normalizeNetworkRead(undefined) }), /NETWORK_READ_NOT_AUTHORIZED/);
  } finally { ipc.webSearch = original; }
});

test("legacy iteration signals select conclusion once without becoming a terminal", async () => {
  const h = harness([answer]);
  const result = await runLoop(h);
  const last = result.aggregate.events.findIndex((event) => event.type === "command.scheduled" && event.command.kind === "request_model");
  let state = result.aggregate.events.slice(0, last).reduce((state, event) => runtime.transition(state, event), null);
  state = runtime.transition(state, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "soft_signal.observed", sequence: state.nextSequence, eventId: "old-limit", at: state.updatedAt, run, signal: "iteration_limit" });
  const next = runtime.decideNextCommands(state);
  assert.equal(state.terminalOutcome, null);
  assert.equal(next[0].kind, "request_model");
  assert.equal(next[0].payload.conclusionKind, "read_only");
});

test("large Web receipts retain valid JSON and redirect identity for cold replay", () => {
  const modelReceipt = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/readOnlyToolReceipt.ts"));
  const data = { url: "https://example.com/redirect", finalUrl: "https://example.com/document", content: "source ".repeat(4000), truncated: true };
  const input = { context: { runtimeRunIntent: "respond" } };
  const text = modelReceipt.runtimeV2ToolModelContent(input, "web_fetch", data);
  assert.deepEqual(JSON.parse(text), data);
  assert.equal(progress.readOnlyEvidenceVersion("web_fetch", data), progress.readOnlyEvidenceVersion("web_fetch", { ...data, url: "https://example.com/another-redirect" }));
  assert.deepEqual(progress.webEvidenceVersions("web_fetch", { content: "", truncated: false }), []);
});
