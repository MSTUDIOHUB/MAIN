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
        if (!providerResults.length) {
          abort.abort();
          throw new Error("Read-only fixture provider responses exhausted.");
        }
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
      prepareSchedule: options.prepareSchedule,
      async execute(input) {
        schedulerCalls += 1;
        if (options.schedulerExecute) return options.schedulerExecute(input);
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
    advance: (ms) => { clock += ms; },
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

test("search recovery keeps authorized source reads available until the answer is complete", async () => {
  const fetch = { visibleText: "", toolCalls: [{ id: "f4", name: "web_fetch", arguments: { url: "https://example.com/source" } }], diagnostics: [] };
  const h = harness([call("s1", "one"), call("s2", "two"), call("s3", "three"), fetch, answer], {
    toolExecute: ({ command }) => receipt(command, command.payload.toolName === "web_fetch"
      ? { url: "https://example.com/source", content: "verified source fact" }
      : resultData(command.payload.arguments.query)),
  });
  const result = await runLoop(h);
  assert.equal(result.resultKind, "success");
  assert.equal(h.requests[3].payload.mode, "chat");
  assert.equal(h.requests[3].payload.recoveryPressure.reason, "non_novel_evidence");
  assert.equal(h.requests[3].payload.conclusionKind, undefined);
  const tools = auth.providerToolDefinitionsForCommand({ get: () => ({ config: {} }), context: { runtimeRunIntent: "respond", runWorkspace: "", networkRead: enabled, turnId: turn.turnId }, live: types.createRuntimeV2LiveExecutionState() }, h.requests[3]);
  assert.ok(tools.some((tool) => tool.function.name === "web_fetch"));
  assert.equal(h.read().toolCalls, 4);
});

test("analyze joins an active child after a valid parent draft and regenerates the answer from its handoff", async () => {
  let joined = false;
  let schedulerAttempts = 0;
  const childEvidence = { id: "child-review:E1", kind: "subagent", target: "src/source.ts", version: "source-v1" };
  const completedAnswer = { visibleText: "已整合子任务证据 child-review:E1 的最终答复。", toolCalls: [], diagnostics: [] };
  const surface = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/providerToolSurface.ts"));
  const initialBatch = surface.boundRuntimeV2ProviderToolCalls([
    { id: "spawn-child", name: "spawn_subagent", arguments: { objective: "Review source" } },
    { id: "parent-read-1", name: "read_file", arguments: { path: "README.md" } },
    { id: "parent-read-2", name: "read_file", arguments: { path: "src/main.ts" } },
  ], new Set(), new Set(), { maxSpawnSubagents: 1 });
  const h = harness([
    { visibleText: "", toolCalls: initialBatch.accepted, diagnostics: [] },
    () => {
      assert.equal(h.read().toolCalls, 2, "the decision's independent reads execute before another provider request");
      return { visibleText: "交接前的完整父线程答复。", toolCalls: [], diagnostics: [] };
    },
    ({ abort }) => {
      // Bound the failing fixture: an unnecessary provider request before
      // joining cannot spin forever while the child is still in flight.
      if (!joined) abort.abort();
      return completedAnswer;
    },
    ({ abort }) => { abort.abort(); return { visibleText: "", toolCalls: [], diagnostics: [] }; },
  ], {
    toolExecute: ({ command }) => receipt(command, { content: "Parent source fact" }, {
      evidence: [{ id: `E-${command.payload.toolCallId}`, kind: "source", target: command.payload.arguments.path, version: "source-v1" }],
    }),
    prepareSchedule: async ({ command }) => ({
      type: "subagents.scheduled", run: command.run, maxActiveSubagents: 1,
      jobs: runtime.scheduleRuntimeV2Subagents({
        parentRun: command.run, maxActiveJobs: 1, requestedAt: 100,
        nextId: () => "child-review",
        candidates: [{ scopeKey: "source-review", taskKind: "review", accessMode: "read", objective: "Review source", allowedPaths: ["src/source.ts"], sourceToolCallId: command.payload.toolCallId }],
      }).jobs,
    }),
    schedulerExecute: async ({ command, scheduledSubagents }) => {
      const job = scheduledSubagents[0];
      // A broken join adapter must fail this finite fixture promptly too.
      if (++schedulerAttempts > 2) { h.abort.abort(); return []; }
      if (command.kind === "schedule_subagents") return [{ type: "subagent.telemetry", run: command.run, telemetry: { jobId: job.id, phase: "request_opened", at: 100 } }];
      assert.equal(command.kind, "join_subagents");
      assert.deepEqual(command.payload.jobIds, ["child-review"]);
      const beforeJoin = { ...h.read().aggregate, scheduledCommands: [] };
      assert.equal(progress.latestReadOnlyAnswer(beforeJoin), "", "a pending child draft cannot pass the ordinary acceptance gate");
      assert.equal(progress.latestReadOnlyAnswer(beforeJoin, { allowPendingChildJoin: true }), "交接前的完整父线程答复。");
      joined = true;
      return [
        { type: "subagent.telemetry", run: command.run, telemetry: { jobId: job.id, phase: "closed", at: 100 } },
        { type: "subagent.completed", run: command.run, jobId: job.id, status: "degraded", summary: "A source fact is ready for the parent.", evidence: [childEvidence] },
        { type: "subagent.handoff_delivered", run: command.run, jobId: job.id, contextEntryId: `child:${job.id}`, evidenceIds: [childEvidence.id] },
      ];
    },
  });
  const result = await runLoop(h, { strategy: "analyze", decisionInput: () => ({ subagentPreference: "allowed", subagentCapacity: 1 }) });
  assert.equal(result.resultKind, "success");
  assert.equal(h.requests.length, 3);
  assert.deepEqual(result.aggregate.events.filter((event) => event.type === "command.scheduled").map((event) => event.command.kind), ["request_model", "schedule_subagents", "execute_tool", "execute_tool", "request_model", "join_subagents", "request_model", "finalize_turn"]);
  assert.equal(h.requests.at(-1).payload.mode, "analyze", "joining must preserve ordinary read authority");
  assert.equal(progress.latestReadOnlyAnswer({ ...result.aggregate, terminalOutcome: null }), completedAnswer.visibleText);
  const adoption = result.aggregate.events.find((event) => event.type === "subagent.handoff_applied");
  const parentResponse = result.aggregate.events.find((event) => event.eventId === adoption.sourceEventId);
  assert.equal(adoption.source, "provider_result");
  assert.equal(parentResponse.result.visibleText, completedAnswer.visibleText);
  const mismatchedAdoption = { ...result.aggregate, events: result.aggregate.events.map((event) => event === adoption ? { ...event, sourceEventId: "different-parent-response" } : event) };
  assert.equal(progress.latestReadOnlyAnswer(mismatchedAdoption), "", "an adoption for another parent response must not validate this answer");
  const newerDelivery = { ...result.aggregate, events: [...result.aggregate.events, { ...adoption, type: "subagent.handoff_delivered", eventId: "newer-handoff" }] };
  assert.equal(progress.latestReadOnlyAnswer(newerDelivery), "", "a newer child handoff invalidates the old synthesis");
  assert.equal(result.aggregate.events.filter((event) => event.type === "run.completed").length, 1);
  assert.equal(result.aggregate.events.filter((event) => event.type === "turn.completed").length, 1);
  assert.equal(result.aggregate.events.filter((event) => event.type === "projection.published" && event.projection.kind === "final").length, 1);
});

test("analyze lets the parent take over a slow child handoff without spending the recovery lease on the join", async () => {
  for (const status of ["degraded", "failed"]) {
    const evidence = status === "degraded"
      ? [{ id: "slow-child:E1", kind: "subagent", target: "src/source.ts", version: "v1" }]
      : [];
    const h = harness([
      { visibleText: "", diagnostics: [], toolCalls: [{ id: "spawn", name: "spawn_subagent", arguments: { objective: "Review source" } }] },
      { visibleText: "", diagnostics: [], toolCalls: [{ id: "wait", name: "wait_subagents", arguments: { subagent_ids: "slow-child" } }] },
      answer,
    ], {
      prepareSchedule: async ({ command }) => ({
        type: "subagents.scheduled", run: command.run, maxActiveSubagents: 1,
        jobs: runtime.scheduleRuntimeV2Subagents({
          parentRun: command.run, maxActiveJobs: 1, requestedAt: h.now(), nextId: () => "slow-child",
          candidates: [{ scopeKey: "source", taskKind: "explore", accessMode: "read", objective: "Review source", allowedPaths: ["src/source.ts"], sourceToolCallId: command.payload.toolCallId }],
        }).jobs,
      }),
      schedulerExecute: async ({ command, scheduledSubagents }) => {
        const job = scheduledSubagents[0];
        if (command.kind === "schedule_subagents") return [{ type: "subagent.telemetry", run: command.run, telemetry: { jobId: job.id, phase: "request_opened", at: h.now() } }];
        assert.equal(command.kind, "join_subagents");
        // The production incident waited eleven minutes for report repair.
        // A failed child still resolves a delegated obligation for takeover.
        h.advance(11 * 60_000);
        return [
          { type: "subagent.telemetry", run: command.run, telemetry: { jobId: job.id, phase: "closed", at: h.now() } },
          { type: "subagent.completed", run: command.run, jobId: job.id, status, summary: "Parent must take over.", evidence },
          { type: "subagent.handoff_delivered", run: command.run, jobId: job.id, contextEntryId: `child:${job.id}`, evidenceIds: evidence.map((item) => item.id) },
        ];
      },
    });
    const result = await runLoop(h, { strategy: "analyze", decisionInput: () => ({ subagentPreference: "allowed", subagentCapacity: 1 }) });
    assert.equal(result.resultKind, "success", `${status} must return work to the parent`);
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[1].payload.recoveryPressure, undefined, "successful scheduling is orchestration progress");
    assert.equal(h.requests[2].payload.recoveryPressure, undefined, "the resolved child is a new parent decision boundary");
    assert.equal(result.aggregate.subagents[0].status, status);
    assert.equal(result.aggregate.subagents[0].report, null, "takeover does not fabricate a child report");
    assert.equal(result.aggregate.events.filter((event) => event.type === "run.completed").length, 1);
    assert.equal(result.aggregate.events.filter((event) => event.type === "turn.completed").length, 1);
    assert.equal(result.aggregate.events.filter((event) => event.type === "projection.published" && event.projection.kind === "final").length, 1);
  }
});

test("replayed child deliveries cannot repeatedly renew read-only recovery", () => {
  const handoff = { type: "subagent.handoff_delivered", jobId: "child", evidenceIds: ["child:E1"] };
  const events = [
    { ...handoff, at: 1 },
    { type: "provider.responded", at: 2, result: { visibleText: "", toolCalls: [], diagnostics: [] } },
    { ...handoff, at: 3 },
  ].map((event, sequence) => ({ ...event, sequence }));
  const recovery = progress.deriveReadOnlyRecoveryWindow({ events, pendingToolCalls: [], scheduledCommands: [] });
  assert.equal(recovery.startedAt, 2);
  assert.equal(recovery.pressure.occurrence, 1);
});

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
  assert.equal(h.requests.at(-1).payload.conclusionKind, undefined);
  assert.equal(h.requests.at(-1).payload.recoveryPressure.occurrence, 2);
});

test("settled non-novel batches provide recovery guidance before a real answer", async () => {
  const h = harness([call("s1", "one"), call("s2", "two"), call("s3", "three"), answer], { toolExecute: ({ command }) => receipt(command, resultData(command.payload.arguments.query)) });
  const result = await runLoop(h);
  assert.equal(result.resultKind, "success");
  assert.deepEqual(h.requests.map((item) => item.payload.mode), ["chat", "chat", "chat", "chat"]);
  assert.equal(h.requests.at(-1).payload.conclusionKind, undefined);
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
    assert.equal(h.requests.at(-1).payload.mode, "chat");
  }
  assert.equal(requestPolicy.runtimeV2ProviderOutputWasTruncated({ finishReason: "length", toolCallCount: 0, availableToolCount: 0 }), true);
});

test("recovery survives repeated empty responses until a valid answer within its lease", async () => {
  const h = harness([...Array(6).fill({ visibleText: "", toolCalls: [], diagnostics: [] }), answer]);
  const result = await runLoop(h);
  assert.equal(result.resultKind, "success");
  assert.equal(h.requests.length, 7);
  assert.ok(h.requests.every((request) => request.payload.mode === "chat"));
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

test("legacy iteration signals do not withdraw safe read authority", async () => {
  const h = harness([answer]);
  const result = await runLoop(h);
  const last = result.aggregate.events.findIndex((event) => event.type === "command.scheduled" && event.command.kind === "request_model");
  let state = result.aggregate.events.slice(0, last).reduce((state, event) => runtime.transition(state, event), null);
  state = runtime.transition(state, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "soft_signal.observed", sequence: state.nextSequence, eventId: "old-limit", at: state.updatedAt, run, signal: "iteration_limit" });
  const next = runtime.decideNextCommands(state);
  assert.equal(state.terminalOutcome, null);
  assert.equal(next[0].kind, "request_model");
  assert.equal(next[0].payload.mode, "chat");
  assert.equal(next[0].payload.conclusionKind, undefined);
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
