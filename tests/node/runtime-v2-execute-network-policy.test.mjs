import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

function fixture({ intent = "execute", workspace = "", policy = { enabled: true, provider: "bing" }, liveEnabled = true } = {}) {
  const calls = [];
  const requests = [];
  const abort = new AbortController();
  let state;
  let id = 0;
  const load = createTsModuleLoader({
    "./ipc": {
      webSearch: async (query, provider, maxResults, allowFallback) => { calls.push({ query, provider, maxResults, allowFallback }); return { query, provider: provider ?? "duckduckgo", results: [] }; },
    },
    "../../lib/providerLaneSettings": {
      deriveStreamSettings: () => ({ provider: "OMLX", apiProtocol: "openai", toolProtocol: "native", model: "fixture", contextLimit: 32768 }),
      deriveBudgetedStreamSettings: () => ({ provider: "OMLX", apiProtocol: "openai", toolProtocol: "native", model: "fixture", contextLimit: 32768 }),
      deriveProviderAdapterCapabilities: () => ({ nativeToolRoundTrip: true, reasoningToggle: false }),
    },
    "../../lib/modelLaneCoordinator": { acquireModelLane: async () => ({ markFirstToken() {}, reportFailure() {}, release() {}, setPressureHandler() {} }) },
    "../../lib/streaming": {
      isStreamOutputLimited: () => false,
      streamChatCompletion: async (messages, settings, callbacks, signal, tools) => {
        requests.push({ tools: tools.map(tool => tool.function.name), aggregate: JSON.parse(JSON.stringify(state.runtimeV2Checkpoints.turn.aggregate)) });
        if (calls.length || !tools.some(tool => tool.function.name === "web_search")) {
          abort.abort();
          return { content: "Stop after recording the actual native invocation.", toolCalls: [], finishReason: "stop", usage: {} };
        }
        return { content: "", toolCalls: [{ id: "native-search", name: "web_search", arguments: JSON.stringify({ query: "service status" }) }], finishReason: "tool_calls", usage: {} };
      },
    },
  });
  const runtime = load("src/lib/runtime-v2/index.ts");
  const scope = workspace || "__MAIN_GLOBAL_CHAT__";
  const sessionKey = `${scope}:1`;
  const turn = { workspaceKey: scope, sessionKey, sessionEpoch: "epoch", clientSubmissionId: "turn", turnId: "turn" };
  const run = { sessionKey, sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "run" };
  let aggregate = runtime.transition(null, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "turn.admitted", sequence: 0, eventId: "admit", at: 1,
    turn, strategy: intent === "respond" ? "chat" : "execute", objective: "Inspect the current service.", acceptanceCriteria: [], constraints: [], ...(policy ? { networkRead: policy } : {}) });
  aggregate = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: "run.started", sequence: 1, eventId: "start", at: 2, run, phase: "observing" });
  state = { config: { activeProfile: "local", language: "en", local: { provider: "OMLX", model: "fixture", toolProtocol: "native" }, sessionRecordingEnabled: false },
    currentWorkspace: workspace, currentSessionId: 1, webSearchEnabled: liveEnabled, webSearchProvider: "baidu",
    sessionsByWorkspace: { [scope]: [{ id: 1, planLifecycleEpoch: "epoch", recordingDisabled: true, messages: [] }] },
    conversationTurns: [{ id: "turn", title: "Inspect service", userPrompt: "Inspect the current service.", status: "executing", blockIds: [], networkRead: policy }],
    runtimeV2Checkpoints: { turn: runtime.createRuntimeV2Checkpoint({ aggregate, revision: 2, updatedAt: 2 }) },
    currentTurnId: "turn", taskFlow: [], runtimeEvents: [], agentMessages: [], _nextTaskId: () => ++id,
    harnessRunMarker: { sessionKey, turnId: "turn", runId: "run", status: "running" },
    currentTurnExecutionConsent: { turnId: "turn", granted: false }, autoApproveTools: false, skills: [],
  };
  const context = { turnId: "turn", uiDisplayTurnId: "turn", runWorkspace: workspace, runScopeKey: scope, runSessionKey: sessionKey, runSessionEpoch: "epoch", runSessionId: 1,
    harnessRunId: "run", abortCtrl: abort, runtimeRunIntent: intent, effectiveRunIntent: intent, phaseLanguage: "en", networkRead: policy,
    turnInputContextSignals: { imageParts: 0, mentionedFilePaths: [], attachedFilePaths: [], subagentPreference: "unspecified" },
    runtimeContextBudget: { contextLimit: 32768, inputBudget: 28672, outputBudget: 4096, readWindowChars: 18000 } };
  const live = load("src/store/runtimeV2/executionTypes.ts").createRuntimeV2LiveExecutionState();
  const ports = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; }, context, live,
    now: () => 3, nextId: kind => `${kind}-${++id}`, logStoreEvent() {} };
  return { calls, requests, context, runtime, load, run, turn, abort, ports, get state() { return state; },
    async search(args = { query: "service status" }) {
      const command = { kind: "execute_tool", phase: "observing", run, idempotencyKey: "search", payload: { toolName: "web_search", toolCallId: "search-call", arguments: args } };
      live.messages.push({ role: "assistant", content: "", tool_calls: [{ id: "search-call", type: "function", function: { name: "web_search", arguments: JSON.stringify(args) } }] });
      const before = JSON.stringify(command);
      const result = await load("src/store/runtimeV2/executionToolPort.ts").createRuntimeV2ToolPort(ports).execute({ command, signal: abort.signal });
      assert.equal(JSON.stringify(command), before, "the canonical model arguments are never rewritten to insert a provider");
      return result;
    },
    async runActualRunner({ fresh = false, legacy = false } = {}) {
      if (fresh) state.runtimeV2Checkpoints = {};
      if (legacy) {
        const checkpoint = state.runtimeV2Checkpoints.turn;
        const events = checkpoint.events.map(event => { const copy = { ...event }; if (event.type === "turn.admitted") delete copy.networkRead; return copy; });
        let restored = null;
        for (const event of events) restored = runtime.transition(restored, event);
        state.runtimeV2Checkpoints.turn = runtime.createRuntimeV2Checkpoint({ aggregate: restored, revision: events.length, updatedAt: 2 });
      }
      return load("src/store/runtimeV2/executeRunner.ts").runSubmitRuntimeV2Execute({ get: ports.get, set: ports.set, context,
        getSessionRevisionToken: () => state, sanitizeTaskBlocksForPersist: blocks => blocks,
        buildSessionRuntimeSnapshot: current => ({ runtimeV2Checkpoints: current.runtimeV2Checkpoints }),
        persistSessionRecord: async () => { throw new Error("Recording disabled"); },
        publishOwnerScopedRuntimeProjection: ({ projectedState }) => { state = projectedState; return { published: true, disposition: "published" }; }, logStoreEvent() {} });
    },
  };
}

for (const intent of ["execute", "respond"]) {
  test(`${intent} query-only search uses the admitted Bing default and fallback policy`, async () => {
    const f = fixture({ intent });
    assert.equal((await f.search()).status, "succeeded");
    assert.deepEqual(f.calls, [{ query: "service status", provider: "bing", maxResults: undefined, allowFallback: false }]);
  });
}

test("the frozen network selection overrides model provider arguments without altering their canonical history", async () => {
  const f = fixture();
  await f.search({ query: "service status", provider: "baidu" });
  assert.equal(f.calls[0].provider, "bing");
  assert.equal(f.calls[0].allowFallback, false);
});

test("Execute uses the admitted enabled flag instead of a later disabled UI toggle", async () => {
  const f = fixture({ liveEnabled: false });
  assert.equal((await f.search()).status, "succeeded");
  assert.equal(f.calls[0].provider, "bing");
});

test("disabled or missing historical network policy cannot be enabled by the live UI", async () => {
  for (const policy of [{ enabled: false, provider: "bing" }, null]) {
    const f = fixture({ policy });
    const result = await f.search();
    assert.notEqual(result.status, "succeeded", "a forged call outside the advertised network scope cannot succeed");
    assert.deepEqual(result.evidence, []);
    assert.deepEqual(f.calls, []);
    assert.equal(f.load("src/store/runtimeV2/executionAuthorizationContext.ts").authorizationFor(f.ports).toolCatalog.lookup("web_search").status, "unknown");
  }
});

test("fresh Execute seals the Turn's network selection before a real provider/tool roundtrip", async () => {
  const f = fixture();
  // The admitted read restriction avoids an unrelated project overview.
  f.context.capabilityRestrictions = ["workspace_read"];
  await f.runActualRunner({ fresh: true });
  assert.deepEqual(f.requests[0].aggregate.networkRead, { enabled: true, provider: "bing" });
  assert.equal(f.calls[0].provider, "bing");
  assert.equal(f.calls[0].allowFallback, false);
  const call = f.state.runtimeV2Checkpoints.turn.aggregate.events.find(event => event.type === "provider.responded").result.toolCalls[0];
  assert.deepEqual(call.arguments, { query: "service status" });
});

test("cold Execute restores canonical Bing even when the Turn projection and current context now say Baidu", async () => {
  const f = fixture();
  f.context.networkRead = { enabled: true, provider: "baidu" };
  f.state.conversationTurns[0].networkRead = { enabled: true, provider: "baidu" };
  f.state.runtimeV2Checkpoints = JSON.parse(JSON.stringify(f.state.runtimeV2Checkpoints));
  await f.runActualRunner();
  assert.equal(f.calls[0].provider, "bing");
  assert.equal(f.calls[0].allowFallback, false);
  assert.equal(f.state.runtimeV2Checkpoints.turn.aggregate.events.filter(event => event.type === "run.started").length, 1);
});

test("a legacy Execute checkpoint without network policy remains offline despite newer Turn/UI selections", async () => {
  const f = fixture();
  await f.runActualRunner({ legacy: true });
  assert.ok(!f.requests[0].tools.includes("web_search"));
  assert.deepEqual(f.calls, []);
});

test("project Execute search retains its admitted provider through the same native boundary", async () => {
  const f = fixture({ workspace: "/fixture" });
  await f.search();
  assert.equal(f.calls[0].provider, "bing");
  assert.equal(f.calls[0].allowFallback, false);
});
