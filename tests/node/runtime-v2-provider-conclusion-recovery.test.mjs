import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const cache = new Map();
function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(fs.readFileSync(normalized, "utf8"), {
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
  return module.exports;
}

const request = loadTs("src/store/runtimeV2/executionProviderRequest.ts");
const history = loadTs("src/store/runtimeV2/executionProviderHistory.ts");
const types = loadTs("src/store/runtimeV2/executionTypes.ts");
const emptySurface = loadTs("src/store/runtimeV2/executionProviderEmptySurface.ts");
const streaming = loadTs("src/lib/streaming.ts");
const lanes = loadTs("src/lib/modelLaneCoordinator.ts");
const runtime = loadTs("src/lib/runtime-v2/index.ts");
const actionWindows = loadTs("src/store/runtimeV2/executionProviderActionWindow.ts");

function command(mode = "conclude", extra = {}) {
  return {
    kind: "request_model", phase: "finalizing",
    run: { turnId: "turn", runId: "run" },
    payload: { mode, ...extra },
  };
}

function ports(provider = "omlx") {
  const live = types.createRuntimeV2LiveExecutionState();
  live.messages.push(
    { role: "system", content: "[MAIN RUNTIME V2] instructions" },
    { role: "user", content: "Answer from the cited source." },
    { role: "assistant", content: "", tool_calls: [{ id: "source", type: "function", function: { name: "web_fetch", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "source", content: "SOURCE_RECEIPT: a cloned value is independent of the original." },
  );
  return {
    live,
    get: () => ({ agentMessages: [], conversationTurns: [], config: {
      activeProfile: "local",
      local: { provider, endpoint: "http://fixture.invalid", model: "fixture", contextLimit: 32768, toolProtocol: "native" },
    } }),
    context: { turnId: "turn", runtimeRunIntent: "respond", runWorkspace: null, phaseLanguage: "en",
      runtimeContextBudget: { contextLimit: 32768, outputBudget: 8192, inputBudget: 24576, preserveAssistantReasoning: true },
    },
    nextId: (prefix) => `${prefix}-fixture`,
    logStoreEvent: () => {},
  };
}

const truncatedResult = () => ({
  visibleText: "##", toolCalls: [], usage: null,
  diagnostics: [{ code: "output_truncated", message: "The provider output limit prevented a complete conclusion.", retryable: true }],
});

test("conclusion output respects the Run allocation instead of the action recovery cap", () => {
  assert.equal(request.runtimeV2ExecutionProviderOutputTokenLimit(command(), false, { outputBudget: 8192 }), 8192);
  assert.equal(request.runtimeV2ExecutionProviderOutputTokenLimit(command(), false, { outputBudget: 1024 }), 1024);
  assert.equal(request.runtimeV2ExecutionProviderOutputTokenLimit(command(), false, { outputBudget: 32768 }), 8192);
  assert.equal(request.runtimeV2ExecutionProviderOutputTokenLimit(command("conclude", { recoveryPressure: { reason: "output_truncated" } }), false, { outputBudget: 8192 }), 8192);
  assert.equal(request.runtimeV2ExecutionProviderOutputTokenLimit(command("execute"), false, { outputBudget: 8192 }), 4096);
  assert.equal(request.runtimeV2ExecutionProviderOutputTokenLimit(command("execute", { recoveryPressure: { reason: "output_truncated" } }), false, { outputBudget: 8192 }), 2048);
});

test("Chat and analyze recovery retain their answer budget while keeping tools available", () => {
  for (const mode of ["chat", "analyze"]) {
    assert.equal(request.runtimeV2ExecutionProviderOutputTokenLimit(command(mode, { recoveryPressure: { reason: "output_truncated" } }), false, { outputBudget: 8192 }), 8192);
    assert.equal(request.runtimeV2ExecutionProviderOutputTokenLimit(command(mode, { recoveryPressure: { reason: "output_truncated" } }), false, { outputBudget: 1024 }), 1024);
  }
});

test("reasoning-only truncation can recover a no-tool conclusion through adapter capability", () => {
  const input = { finishReason: "length", reasoningChars: 8097, actionChars: 2, toolCallCount: 0, availableToolCount: 0, reasoningRequest: "auto", providerSupportsReasoningToggle: true };
  assert.equal(request.shouldRetryRuntimeV2WithoutReasoning(input), true);
  assert.equal(request.shouldRetryRuntimeV2WithoutReasoning({ ...input, providerSupportsReasoningToggle: false }), false);
  assert.equal(request.shouldRetryRuntimeV2WithoutReasoning({ ...input, reasoningChars: 0 }), false);
  assert.equal(request.shouldRetryRuntimeV2WithoutReasoning({ ...input, finishReason: "stop" }), false);
});

test("a truncated no-tool draft remains causal feedback and never becomes the accepted visible answer", () => {
  const fixture = ports();
  history.rememberRuntimeV2ProviderResult(fixture, truncatedResult(), command(), []);
  assert.equal(fixture.live.latestVisibleText, "");
  assert.deepEqual(fixture.live.messages.slice(-2).map((message) => message.role), ["assistant", "system"]);
  assert.equal(fixture.live.messages.at(-2).content, "##");
  assert.match(fixture.live.messages.at(-1).content, /output_truncated/);
  assert.match(fixture.live.messages.at(-1).content, /complete conclusion/);
  const before = fixture.live.messages.length;
  history.rememberRuntimeV2ProviderResult(fixture, truncatedResult(), command(), []);
  assert.equal(fixture.live.messages.length, before, "only identical draft/feedback pairs coalesce");
});

async function withStreamFixture(provider, responseFactory, task) {
  const originalStream = streaming.streamChatCompletion;
  const originalLane = lanes.acquireModelLane;
  const calls = [];
  streaming.streamChatCompletion = async (messages, settings, _callbacks, _signal, tools, maxOutputTokens, options) => {
    calls.push({ messages, settings, tools, maxOutputTokens, options });
    return responseFactory(calls.length);
  };
  lanes.acquireModelLane = async () => ({ markFirstToken() {}, reportFailure() {}, release() {} });
  try { await task(ports(provider), calls); }
  finally { streaming.streamChatCompletion = originalStream; lanes.acquireModelLane = originalLane; }
}

const truncatedStream = () => ({ content: "##", semanticContent: "##", finishReason: "length", toolCalls: [], reasoningContent: "r".repeat(8097), usage: null });
const completedStream = () => ({ content: "A complete answer from SOURCE_RECEIPT.", semanticContent: "A complete answer from SOURCE_RECEIPT.", finishReason: "stop", toolCalls: [], usage: null });

function assertOutboundRecoveryPair(messages, draft) {
  const drafts = messages.filter((message) => message.role === "assistant" && message.content === draft);
  assert.equal(drafts.length, 1, "the exact failed draft remains once in canonical wire history");
  const feedbackIndices = messages.flatMap((message, index) =>
    message.role === "system" && message.content.startsWith("[runtime-v2 provider feedback: output_truncated]") ? [index] : []);
  assert.equal(feedbackIndices.length, 1, "one causal feedback entry owns the failed draft");
  const index = feedbackIndices[0];
  assert.equal(messages[index - 1], drafts[0], "feedback immediately follows its original assistant draft");
  const authority = messages.slice(index + 1).filter((message) => message.role === "system" && message.content.includes("CURRENT_TOOL_SURFACE:"));
  assert.equal(authority.length, 1, "current phase authority follows the preserved recovery pair");
  return { feedback: messages[index], authority: authority[0] };
}

for (const surface of ["Chat", "workspace"]) {
test(`${surface} cold requests preserve decision provenance and carry the shared continuity contract on the wire`, async () => {
  await withStreamFixture("omlx", completedStream, async (fixture, calls) => {
    const conversation = [
      { role: "user", content: "I choose PDF; the budget is undecided." },
      { role: "assistant", content: "I recommend HTML and suggest a $500 budget." },
      { role: "user", content: "Change my format choice to Markdown. The budget remains undecided." },
      { role: "assistant", content: "I will regard $500 as confirmed unless you object." },
      { role: "user", content: "Recall my current choices and continue the discussion.", runtimeTurnId: "turn" },
    ];
    const state = { ...fixture.get(), agentMessages: conversation, conversationTurns: [] };
    fixture.get = () => state;
    fixture.live.messages = [];
    fixture.context.runtimeRunIntent = surface === "Chat" ? "respond" : "analyze";
    fixture.context.runWorkspace = surface === "Chat" ? null : "/fixture";
    const tools = surface === "Chat" ? [] : [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }];
    await request.requestRuntimeV2ProviderOnce({ live: fixture.live, ports: fixture, command: command(surface === "Chat" ? "chat" : "analyze"), tools, textEnvelope: false, toolChoice: null, signal: new AbortController().signal });
    const wire = calls[0].messages;
    const contract = wire.find((message) => message.role === "system" && message.content.startsWith("[MAIN RUNTIME V2]"))?.content || "";
    assert.match(contract, /\[CONVERSATION CONTINUITY\]/, "the live system contract must own decision attribution");
    assert.match(contract, /user.*selects.*accepts.*delegates/i);
    assert.match(contract, /suggestions.*assumptions.*inferences/i);
    assert.match(contract, /undecided.*deferred.*pending/i);
    assert.match(contract, /silence.*(?:not|never).*consent/i);
    assert.match(contract, /later user changes.*supersed/i);
    assert.match(contract, /summaries.*documents.*confirmed.*pending/i);
    assert.match(contract, /earlier assistant.*incorrectly.*confirmation.*correct/i);
    assert.match(contract, /recording or summarizing.*confirmed choice.*cite.*user selected.*accepted.*delegated.*stated scope/i);
    assert.match(contract, /inferred extensions pending.*never label.*extension confirmed.*asking.*user agrees/i);
    assert.match(contract, /without requiring.*question.*approval.*every turn/i);
    assert.equal(wire.filter((message) => typeof message.content === "string" && message.content.includes("[CONVERSATION CONTINUITY]")).length, 1);
    for (const original of conversation) {
      const exact = wire.filter((message) => message.content === original.content);
      assert.equal(exact.length, 1);
      assert.equal(exact[0].role, original.role, "suggestions and false assistant confirmation must not become user decisions");
    }
    assert.equal(calls[0].options.toolChoice, undefined);
  });
});
}

test("empty-surface live request retries as a complete answer and includes the failed draft", async () => {
  await withStreamFixture("omlx", (attempt) => attempt === 1 ? truncatedStream() : completedStream(), async (fixture, calls) => {
    const result = await emptySurface.requestRuntimeV2ProviderWithEmptySurface({ ports: fixture, command: command(), signal: new AbortController().signal });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].settings.reasoningRequest, "auto");
    assert.equal(calls[1].settings.reasoningRequest, "off");
    assert.equal(calls[1].maxOutputTokens, 8192);
    assert.deepEqual(calls[1].tools, []);
    const { feedback, authority } = assertOutboundRecoveryPair(calls[1].messages, "##");
    assert.match(feedback.content, /complete.*answer/i);
    assert.doesNotMatch(feedback.content, /Submit exactly one.*tool/);
    assert.match(authority.content, /CURRENT_TOOL_SURFACE: this decision exposes no tools/);
    assert.equal(calls[1].messages.at(-1).role, "user");
    assert.match(calls[1].messages.at(-1).content, /^All tools are closed\. Deliver the final Markdown answer/);
    assert.doesNotMatch(JSON.stringify(calls[1].messages), /rrrrrrrr/);
    assert.equal(result.diagnostics.length, 0);
    assert.equal(fixture.live.latestVisibleText, completedStream().content);
    assert.match(JSON.stringify(fixture.live.messages), /output_truncated/);
  });
});

test("unsupported reasoning controls retain a truncated result and expose feedback to the next request", async () => {
  await withStreamFixture("ollama", truncatedStream, async (fixture, calls) => {
    const input = { ports: fixture, command: command(), signal: new AbortController().signal };
    const result = await emptySurface.requestRuntimeV2ProviderWithEmptySurface(input);
    assert.equal(calls.length, 1, "a provider without a documented toggle must not get an invented recovery control");
    assert.equal(result.diagnostics[0].code, "output_truncated");
    assert.equal(fixture.live.latestVisibleText, "");
    await emptySurface.requestRuntimeV2ProviderWithEmptySurface(input);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].settings.reasoningRequest, "auto");
    assert.match(JSON.stringify(calls[1].messages), /provider feedback: output_truncated/);
    assert.ok(calls[1].messages.some((message) => message.role === "assistant" && message.content === "##"));
  });
});

test("Execute action recovery still submits an advertised tool after a reasoning-only draft", async () => {
  const tool = { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } };
  await withStreamFixture("omlx", (attempt) => attempt === 1 ? truncatedStream() : { content: "", semanticContent: "", finishReason: "tool_calls", toolCalls: [{ id: "read", name: "read_file", arguments: { path: "src/main.ts" } }], usage: null }, async (fixture, calls) => {
    fixture.context.runtimeRunIntent = "execute";
    const result = await request.requestRuntimeV2ProviderOnce({ live: fixture.live, ports: fixture, command: command("execute"), tools: [tool], textEnvelope: false, toolChoice: null, signal: new AbortController().signal });
    assert.equal(calls.length, 2);
    const { feedback, authority } = assertOutboundRecoveryPair(calls[1].messages, "##");
    assert.match(feedback.content, /Submit exactly one.*structured tool action/);
    assert.equal(calls[1].messages.at(-1), authority, "the actual tool surface is the final phase instruction");
    assert.match(authority.content, /CURRENT_TOOL_SURFACE: this decision exposes exactly 1 tool: read_file/);
    assert.equal(calls[1].maxOutputTokens, 4096);
    assert.deepEqual(calls[1].tools, [tool]);
    assert.equal(result.toolCalls[0].name, "read_file");
  });
});

test("Execute outbound decision retains only the assistant draft adjacent to its latest feedback", async () => {
  await withStreamFixture("ollama", truncatedStream, async (fixture, calls) => {
    fixture.context.runtimeRunIntent = "execute";
    fixture.live.messages.push({ role: "assistant", content: "OLD_DRAFT_WITHOUT_CURRENT_FEEDBACK" });
    const input = { live: fixture.live, ports: fixture, command: command("execute"), tools: [], textEnvelope: false, toolChoice: null, signal: new AbortController().signal };
    const failed = await request.requestRuntimeV2ProviderOnce(input);
    history.rememberRuntimeV2ProviderResult(fixture, failed, input.command, []);
    await request.requestRuntimeV2ProviderOnce({ ...input, command: command("execute", { recoveryPressure: { reason: "output_truncated" } }) });
    assert.equal(calls.length, 2);
    const next = calls[1].messages;
    const feedbackIndex = next.findIndex((message) => message.role === "system" && message.content.startsWith("[runtime-v2 provider feedback:"));
    assert.ok(feedbackIndex > 0);
    assert.equal(next[feedbackIndex - 1].role, "assistant");
    assert.equal(next[feedbackIndex - 1].content, "##");
    assert.doesNotMatch(JSON.stringify(next), /OLD_DRAFT_WITHOUT_CURRENT_FEEDBACK/);
  });
});

test("Chat reasoning recovery permits a complete answer and preserves its web tools", async () => {
  const tool = { type: "function", function: { name: "web_fetch", description: "fetch", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } };
  await withStreamFixture("omlx", (attempt) => attempt === 1 ? truncatedStream() : completedStream(), async (fixture, calls) => {
    const result = await request.requestRuntimeV2ProviderOnce({ live: fixture.live, ports: fixture, command: command("chat", { recoveryPressure: { reason: "output_truncated" } }), tools: [tool], textEnvelope: false, toolChoice: null, signal: new AbortController().signal });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].settings.reasoningRequest, "off");
    assert.deepEqual(calls[1].tools, [tool]);
    assert.equal(calls[1].maxOutputTokens, 8192);
    assert.match(calls[1].messages.at(-1).content, /complete concise answer/);
    assert.match(calls[1].messages.at(-1).content, /tools remain available/);
    assert.doesNotMatch(calls[1].messages.at(-1).content, /Submit exactly one/);
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.diagnostics.length, 0);
  });
});

test("visible required-action recovery preserves settings for an adapter without a reasoning toggle", async () => {
  const tool = { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } };
  await withStreamFixture("ollama", (attempt) => attempt === 1
    ? { content: "visible incomplete action draft", semanticContent: "visible incomplete action draft", finishReason: "length", toolCalls: [], reasoningContent: "", usage: null }
    : { content: "", semanticContent: "", finishReason: "tool_calls", toolCalls: [{ id: "read", name: "read_file", arguments: { path: "src/main.ts" } }], usage: null }, async (fixture, calls) => {
    const result = await request.requestRuntimeV2ProviderOnce({ live: fixture.live, ports: fixture, command: command("execute", { recoveryPressure: { reason: "output_truncated" } }), tools: [tool], textEnvelope: false, toolChoice: null, signal: new AbortController().signal });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].settings.reasoningRequest, "auto");
    const { feedback, authority } = assertOutboundRecoveryPair(calls[1].messages, "visible incomplete action draft");
    assert.match(feedback.content, /Submit exactly one/);
    assert.equal(calls[1].messages.at(-1), authority, "required-action authority follows the causal draft/feedback pair");
    assert.match(authority.content, /requires exactly one structured action, and it must be read_file/);
    assert.equal(calls[1].maxOutputTokens, 2048);
    assert.equal(result.toolCalls[0].name, "read_file");
  });
});

function executeReplyAggregate(result, phase = "observing") {
  const turn = { workspaceKey: "/fixture", sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" };
  const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
  const event = (state, type, fields) => ({ schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: state?.nextSequence || 0, eventId: `event-${state?.nextSequence || 0}`, at: (state?.updatedAt || 0) + 1, type, ...fields });
  let state = runtime.transition(null, event(null, "turn.admitted", { turn, strategy: "execute", objective: "The current user request", constraints: [], acceptanceCriteria: ["The authorized effect is verified"], acceptanceCriterionIds: ["criterion-user-objective"], acceptanceEvidenceRequirements: ["behavioral"] }));
  state = runtime.transition(state, event(state, "run.started", { run, phase }));
  const next = runtime.decideNextCommands(state)[0];
  state = runtime.transition(state, event(state, "command.scheduled", { run, command: next }));
  return runtime.transition(state, event(state, "provider.responded", { run, idempotencyKey: next.idempotencyKey, result: { visibleText: "", toolCalls: [], diagnostics: [], ...result } }));
}

test("a cold Execute checkpoint restores its current reply and feedback before the actual request", async () => {
  const reply = "COLD_CANONICAL_REPLY: which core game idea should we discuss first?";
  let aggregate = executeReplyAggregate({ visibleText: reply });
  const next = runtime.decideNextCommands(aggregate)[0];
  aggregate = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: aggregate.nextSequence, eventId: "cold-next-request", at: aggregate.updatedAt + 1, type: "command.scheduled", run: next.run, command: next });
  const checkpoint = runtime.createRuntimeV2Checkpoint({ revision: aggregate.events.length, aggregate, updatedAt: aggregate.updatedAt });
  const tools = [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }];
  await withStreamFixture("omlx", completedStream, async (fixture, calls) => {
    const state = { ...fixture.get(), runtimeV2Checkpoints: runtime.serializeRuntimeV2CheckpointMap({ turn: checkpoint }) };
    fixture.get = () => state;
    fixture.context.runtimeRunIntent = "execute";
    fixture.context.runWorkspace = "/fixture";
    fixture.live.messages = [];
    const input = { live: fixture.live, ports: fixture, command: next, tools, textEnvelope: false, toolChoice: null, signal: new AbortController().signal };
    await request.requestRuntimeV2ProviderOnce(input);
    await request.requestRuntimeV2ProviderOnce(input);
    for (const call of calls) {
      const index = call.messages.findIndex((message) => message.role === "system" && message.content.startsWith("[runtime-v2 provider feedback: non_actionable_response]"));
      assert.ok(index > 0, "the persisted latest reply needs its accurate feedback on the first restored wire request");
      assert.equal(call.messages[index - 1].content, reply);
      assert.equal(call.messages.filter((message) => message.role === "assistant" && message.content === reply).length, 1);
      assert.equal(call.options.toolChoice, undefined);
    }
    assert.equal(fixture.live.latestVisibleText, "", "restoration does not accept Execute completion");
  });
});

test("canonical reply restoration cannot cross later work, a different Run, or a request mode boundary", () => {
  const aggregate = executeReplyAggregate({ visibleText: "SUPERSEDED_CANONICAL_REPLY" });
  const next = runtime.decideNextCommands(aggregate)[0];
  const event = (type, fields = {}) => ({ schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: aggregate.nextSequence, eventId: `new-${type}`, at: aggregate.updatedAt + 1, run: next.run, type, ...fields });
  const barriers = [
    event("tool.completed", { status: "failed", evidence: [] }),
    event("validation.completed", { passed: false, evidence: [] }),
    event("observation.recorded", { evidence: { id: "new-source", kind: "source", target: "README.md", version: "v2" } }),
    event("subagent.completed", { status: "failed", jobId: "child", summary: "failed", evidence: [] }),
    event("subagent.handoff_delivered", { jobId: "child", contextEntryId: "context", evidenceIds: [] }),
    event("subagent.handoff_applied", { jobId: "child", evidenceIds: [], source: "provider_result", sourceEventId: "new-answer" }),
    event("command.completed", { status: "failed", idempotencyKey: next.idempotencyKey }),
    event("command.scheduled", { command: { ...next, idempotencyKey: "new-work", kind: "execute_tool" } }),
    event("provider.responded", { idempotencyKey: next.idempotencyKey, result: { visibleText: "", toolCalls: [], diagnostics: [] } }),
    event("phase.changed", { phase: "validating", reason: "new phase" }),
  ];
  for (const barrier of barriers) {
    const fixture = ports();
    fixture.live.messages = [];
    history.restoreRuntimeV2ProviderRecoveryHistory(fixture, { ...aggregate, events: [...aggregate.events, barrier] }, next);
    assert.deepEqual(fixture.live.messages, [], `${barrier.type} must supersede the old reply even with a stale recovery hint`);
  }
  for (const changedCommand of [
    { ...next, run: { ...next.run, runId: "different-run" } },
    { ...next, run: { ...next.run, turnId: "different-turn" } },
    { ...next, payload: { ...next.payload, mode: "validate" } },
  ]) {
    const fixture = ports();
    fixture.live.messages = [];
    history.restoreRuntimeV2ProviderRecoveryHistory(fixture, aggregate, changedCommand);
    assert.deepEqual(fixture.live.messages, []);
  }
});

test("Execute recovery distinguishes a complete no-action reply from empty and rejected protocol output", () => {
  const cases = [
    [{ visibleText: "What is the core game idea you would like to discuss?" }, "non_actionable_response"],
    [{ visibleText: "" }, "empty_response"],
    [{ visibleText: "I will inspect it.", diagnostics: [{ code: "native_tool_calls_invalid", message: "Invalid native arguments", retryable: true }] }, "provider_response_rejected"],
  ];
  for (const phase of ["observing", "validating"]) {
    for (const [result, reason] of cases) {
      const state = executeReplyAggregate(result, phase);
      const next = runtime.decideNextCommands(state)[0];
      assert.equal(next.kind, "request_model");
      assert.equal(next.payload.mode, phase === "validating" ? "validate" : "execute");
      assert.equal(next.payload.recoveryPressure.reason, reason);
      assert.equal(runtime.runtimeV2DirectExecuteReadyForConclusion(state), false, "provider prose cannot discharge effect or validation debt");
      assert.equal(state.terminalOutcome, null);
    }
  }
});

for (const mode of ["execute", "validate"]) {
test(`complete ${mode} replies retain causal feedback on the actual wire without forcing a new action`, async () => {
  const tools = ["read_file", "apply_patch"].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }));
  const reply = "我有一些设计问题想和你讨论：你最初的核心玩法想法是什么？";
  await withStreamFixture("omlx", completedStream, async (fixture, calls) => {
    fixture.context.runtimeRunIntent = "execute";
    fixture.context.runWorkspace = "/fixture";
    fixture.live.messages = [
      { role: "system", content: "[MAIN RUNTIME V2] instructions" },
      { role: "user", content: "Discuss the game idea before deciding whether to create a document.", runtimeTurnId: "turn" },
      { role: "assistant", content: "", tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] },
      { role: "tool", tool_call_id: "read", content: "READ_FILE_RESULT\npath: README.md\ncontentVersion: source-v1\ntruncated: false\ntotalLines: 1\nreturnedLines: 1-1\n---CONTENT START---\n# Game design workspace\n---CONTENT END---" },
    ];
    const result = { visibleText: reply, toolCalls: [], diagnostics: [] };
    history.rememberRuntimeV2ProviderResult(fixture, result, command(mode), tools);
    assert.equal(fixture.live.latestVisibleText, "", "an incomplete Execute effect cannot be accepted as a final answer");
    assert.equal(fixture.live.messages.at(-2).content, reply);
    assert.match(fixture.live.messages.at(-1).content, /non_actionable_response/);
    const count = fixture.live.messages.length;
    history.rememberRuntimeV2ProviderResult(fixture, result, command(mode), tools);
    assert.equal(fixture.live.messages.length, count, "identical causal pairs coalesce");
    await request.requestRuntimeV2ProviderOnce({ live: fixture.live, ports: fixture, command: command(mode, { recoveryPressure: { schemaVersion: "runtime-v2-provider-recovery.v1", reason: "non_actionable_response", occurrence: 1, stage: "reconsider" }, effectPressure: { reason: "source_only_frontier" } }), tools, textEnvelope: false, toolChoice: null, signal: new AbortController().signal });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.toolChoice, undefined, "a complete no-action reply is a soft strategy signal");
    assert.equal(calls[0].maxOutputTokens, mode === "execute" ? 4096 : 2048);
    assert.deepEqual(new Set(calls[0].tools.map((tool) => tool.function.name)), new Set(["read_file", "apply_patch"]));
    const feedbackIndex = calls[0].messages.findIndex((message) => message.role === "system" && message.content.startsWith("[runtime-v2 provider feedback: non_actionable_response]"));
    assert.ok(feedbackIndex > 0);
    assert.equal(calls[0].messages[feedbackIndex - 1].content, reply);
    assert.match(calls[0].messages[feedbackIndex].content, /not empty/i);
    assert.match(calls[0].messages[feedbackIndex].content, /source.*(?:does not|not).*mutation|source.*not.*obligation/i);
    assert.doesNotMatch(JSON.stringify(calls[0].messages), /exactly one structured action|submit the mutation now/i);
  });
});
}

test("empty or malformed action recovery keeps its explicit protocol feedback and required tool decoding", () => {
  assert.equal(request.runtimeV2RecoveryRequiresStructuredAction({ reason: "empty_response" }), true);
  assert.equal(request.runtimeV2RecoveryRequiresStructuredAction({ reason: "provider_response_rejected" }), true);
  assert.equal(request.runtimeV2RecoveryRequiresStructuredAction({ reason: "non_actionable_response" }), false);
});

test("a complete Validate reply cannot close inspection solely from recovery occurrence", () => {
  const input = { command: command("validate", { recoveryPressure: { reason: "non_actionable_response", occurrence: 3 } }), effects: {}, sourceCoverage: [] };
  assert.equal(actionWindows.runtimeV2ProviderActionWindowFor(input), null);
  assert.equal(actionWindows.runtimeV2ProviderActionWindowFor({ ...input, command: command("validate", { recoveryPressure: { reason: "empty_response", occurrence: 1 } }) }), "closed_recovery");
  assert.equal(actionWindows.runtimeV2ProviderActionWindowFor({ ...input, effects: { replayedSourceReceiptCountSinceMutation: 1 } }), "closed_recovery", "an actual replay remains structured recovery evidence");
});

test("empty protocol feedback cannot bind an older unrelated assistant draft on the actual wire", async () => {
  const tools = [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }];
  await withStreamFixture("ollama", completedStream, async (fixture, calls) => {
    fixture.context.runtimeRunIntent = "execute";
    fixture.live.messages.push({ role: "assistant", content: "OLDER_UNRELATED_REPLY" });
    const rejected = { visibleText: "", toolCalls: [], diagnostics: [{ code: "native_tool_calls_invalid", message: "Invalid native call arguments; no action executed.", retryable: true }] };
    history.rememberRuntimeV2ProviderResult(fixture, rejected, command("execute"), tools);
    assert.equal(fixture.live.messages.at(-2).role, "assistant");
    assert.equal(fixture.live.messages.at(-2).content, "", "the newest empty response owns this feedback");
    const size = fixture.live.messages.length;
    history.rememberRuntimeV2ProviderResult(fixture, rejected, command("execute"), tools);
    assert.equal(fixture.live.messages.length, size);
    await request.requestRuntimeV2ProviderOnce({ live: fixture.live, ports: fixture, command: command("execute", { recoveryPressure: { reason: "provider_response_rejected", occurrence: 1, stage: "reconsider" } }), tools, textEnvelope: false, toolChoice: null, signal: new AbortController().signal });
    assert.equal(calls[0].options.toolChoice, "required");
    const index = calls[0].messages.findIndex((message) => message.role === "system" && message.content.startsWith("[runtime-v2 provider feedback: native_tool_calls_invalid]"));
    assert.ok(index > 0);
    assert.equal(calls[0].messages[index - 1].content, "");
    assert.doesNotMatch(JSON.stringify(calls[0].messages), /OLDER_UNRELATED_REPLY/);
  });
});

test("provider feedback only coalesces an identical response and feedback pair", () => {
  const live = types.createRuntimeV2LiveExecutionState();
  for (const pair of [{ visibleText: "first reply", feedback: "first feedback" }, { visibleText: "second reply", feedback: "first feedback" }, { visibleText: "second reply", feedback: "different feedback" }]) {
    history.appendRuntimeV2ProviderFeedbackHistory(live, { code: "non_actionable_response", ...pair });
  }
  assert.equal(live.messages.length, 6);
  history.appendRuntimeV2ProviderFeedbackHistory(live, { code: "non_actionable_response", visibleText: "second reply", feedback: "different feedback" });
  assert.equal(live.messages.length, 6);
});

test("a truly empty Execute reply retains its own feedback and required decoding on the actual wire", async () => {
  const tools = [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }];
  await withStreamFixture("ollama", completedStream, async (fixture, calls) => {
    fixture.context.runtimeRunIntent = "execute";
    history.rememberRuntimeV2ProviderResult(fixture, { visibleText: "", toolCalls: [], diagnostics: [] }, command("execute"), tools);
    assert.equal(fixture.live.messages.at(-2).content, "");
    assert.match(fixture.live.messages.at(-1).content, /empty_response/);
    await request.requestRuntimeV2ProviderOnce({ live: fixture.live, ports: fixture, command: command("execute", { recoveryPressure: { reason: "empty_response", occurrence: 1, stage: "reconsider" } }), tools, textEnvelope: false, toolChoice: null, signal: new AbortController().signal });
    assert.equal(calls[0].options.toolChoice, "required");
    const index = calls[0].messages.findIndex((message) => message.role === "system" && message.content.startsWith("[runtime-v2 provider feedback: empty_response]"));
    assert.ok(index > 0);
    assert.equal(calls[0].messages[index - 1].content, "");
    assert.match(calls[0].messages[index].content, /no visible reply and no structured tool action/);
  });
});

test("repeated complete no-action replies keep the canonical recovery lease and never create acceptance", () => {
  let state = executeReplyAggregate({ visibleText: "An essential user decision is still missing." });
  const first = runtime.deriveRuntimeV2ProviderRecoveryWindow(state);
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    const next = runtime.decideNextCommands(state)[0];
    const event = (type, fields) => ({ schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: state.nextSequence, eventId: `repeat-${state.nextSequence}`, at: state.updatedAt + 1, type, ...fields });
    state = runtime.transition(state, event("command.scheduled", { run: next.run, command: next }));
    state = runtime.transition(state, event("provider.responded", { run: next.run, idempotencyKey: next.idempotencyKey, result: { visibleText: "An essential user decision is still missing.", toolCalls: [], diagnostics: [] } }));
  }
  const window = runtime.deriveRuntimeV2ProviderRecoveryWindow(state);
  assert.equal(window.pressure.reason, "non_actionable_response");
  assert.equal(window.pressure.occurrence, 3);
  assert.equal(window.startedAt, first.startedAt, "complete prose does not restart the no-progress lease");
  assert.equal(state.terminalOutcome, null, "no fixed repetition count accepts or terminates the Run");
  assert.equal(runtime.runtimeV2DirectExecuteReadyForConclusion(state), false);
  const lease = runtime.advanceRuntimeV2ProviderRecoveryStallLease({ current: null, pressure: window.pressure, startedAt: window.startedAt, now: window.startedAt });
  assert.equal(runtime.runtimeV2ProviderRecoveryStallExpired(lease, window.startedAt + runtime.RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS), true, "the existing stall boundary still prevents indefinite no-progress recovery");
});
