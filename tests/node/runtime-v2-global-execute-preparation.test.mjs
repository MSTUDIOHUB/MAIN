import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

async function runPreparation(workspace, { coldPreparing = false } = {}) {
  const scope = workspace || "__MAIN_GLOBAL_CHAT__";
  const sessionKey = `${scope}:1`;
  const abort = new AbortController();
  const calls = [];
  const requests = [];
  const logs = [];
  let state;
  let id = 0;
  const load = createTsModuleLoader({
    "../../lib/providerLaneSettings": {
      deriveStreamSettings: () => ({ provider: "OMLX", apiProtocol: "openai", toolProtocol: "native", model: "fixture", contextLimit: 32768 }),
      deriveBudgetedStreamSettings: () => ({ provider: "OMLX", apiProtocol: "openai", toolProtocol: "native", model: "fixture", contextLimit: 32768 }),
      deriveProviderAdapterCapabilities: () => ({ nativeToolRoundTrip: true, reasoningToggle: false }),
    },
    "../../lib/modelLaneCoordinator": { acquireModelLane: async () => ({ markFirstToken() {}, reportFailure() {}, release() {}, setPressureHandler() {} }) },
    "../../lib/streaming": {
      isStreamOutputLimited: () => false,
      streamChatCompletion: async (messages, settings, callbacks, signal, tools) => {
        requests.push({ messages, tools, aggregate: JSON.parse(JSON.stringify(state.runtimeV2Checkpoints.turn.aggregate)) });
        // Stop at the first actual provider boundary. No inference or tool
        // proposal is needed to prove preparation handed control to the model.
        abort.abort();
        return { content: "Captured provider boundary.", toolCalls: [], finishReason: "stop", usage: {} };
      },
    },
    "../../lib/toolExecutor": { executeTool: async (name, args, actualWorkspace) => {
      calls.push({ name, args, workspace: actualWorkspace });
      if (!actualWorkspace) {
        // The regression must fail finitely on the old infinite-loop path.
        // This models the existing global workspace denial, not a retry policy.
        abort.abort();
        throw new Error("WORKSPACE_REQUIRED_FOR_TOOL: get_project_skeleton requires an active workspace.");
      }
      assert.equal(name, "get_project_skeleton");
      return "fixture.txt\n";
    } },
  });
  state = {
    config: { language: "en", activeProfile: "local", local: { provider: "OMLX", model: "fixture", toolProtocol: "native" }, sessionRecordingEnabled: false },
    currentWorkspace: workspace, currentSessionId: 1,
    sessionsByWorkspace: { [scope]: [{ id: 1, planLifecycleEpoch: "epoch", recordingDisabled: true, messages: [] }] },
    conversationTurns: [{ id: "turn", userPrompt: "Inspect the current remote service.", title: "Inspect service", status: "executing", blockIds: [], networkRead: { enabled: true, provider: "bing" } }],
    taskFlow: [], agentMessages: [], runtimeEvents: [], runtimeV2Checkpoints: {}, currentTurnId: "turn",
    harnessRunMarker: { sessionKey, turnId: "turn", runId: "run", status: "running" },
    currentTurnExecutionConsent: { turnId: "turn", granted: false }, autoApproveTools: false,
    webSearchEnabled: true, webSearchProvider: "bing", skills: [], _nextTaskId: () => ++id,
  };
  const context = {
    turnId: "turn", uiDisplayTurnId: "turn", runScopeKey: scope, runSessionKey: sessionKey, runSessionId: 1, runSessionEpoch: "epoch",
    runWorkspace: workspace, harnessRunId: "run", abortCtrl: abort, phaseLanguage: "en",
    effectiveRunIntent: "execute", runtimeRunIntent: "execute", requiredCapabilities: ["external_interaction"],
    turnInputContextSignals: { imageParts: 0, mentionedFilePaths: [], attachedFilePaths: [], subagentPreference: "unspecified" },
    runtimeContextBudget: { contextLimit: 32768, inputBudget: 28672, outputBudget: 4096, readWindowChars: 18000 },
  };
  if (coldPreparing) {
    const runtime = load("src/lib/runtime-v2/index.ts");
    let checkpoint = null;
    const controller = new runtime.RuntimeV2Controller({
      checkpoint: { append: async input => {
        const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input });
        if (result.checkpoint) checkpoint = result.checkpoint;
        return result;
      } },
      projection: { publish: async () => {} },
      tool: { execute: async () => { throw new Error("WORKSPACE_REQUIRED_FOR_TOOL: get_project_skeleton requires an active workspace."); } },
      provider: { request: async () => { throw new Error("The historical checkpoint never reached a provider"); } },
      clockId: { now: () => ++id, nextId: kind => `${kind}-${++id}` },
    });
    await controller.admit({ turn: { workspaceKey: scope, sessionKey, sessionEpoch: "epoch", clientSubmissionId: "turn", turnId: "turn" },
      run: { sessionKey, sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "run" },
      strategy: "execute", objective: state.conversationTurns[0].userPrompt, initialPhase: "preparing" });
    await controller.driveOnce();
    assert.equal(checkpoint.aggregate.phase, "preparing");
    state.runtimeV2Checkpoints.turn = JSON.parse(JSON.stringify(checkpoint));
  }
  const result = await load("src/store/runtimeV2/executeRunner.ts").runSubmitRuntimeV2Execute({
    get: () => state,
    set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    context, getSessionRevisionToken: () => state,
    sanitizeTaskBlocksForPersist: blocks => blocks,
    buildSessionRuntimeSnapshot: current => ({ runtimeV2Checkpoints: current.runtimeV2Checkpoints }),
    persistSessionRecord: async () => { throw new Error("Recording is disabled"); },
    publishOwnerScopedRuntimeProjection: ({ projectedState }) => { state = projectedState; return { published: true, disposition: "published" }; },
    logStoreEvent: (name, detail) => logs.push({ name, ...detail }),
  });
  const authorization = load("src/store/runtimeV2/executionAuthorizationContext.ts").createRuntimeV2ExecutionAuthorization(state);
  return { state, calls, requests, logs, result, authorization };
}

test("global Execute completes inapplicable workspace preparation and reaches its web-enabled provider without fabricated evidence", async () => {
  const f = await runPreparation("");
  assert.equal(f.requests.length, 1, "global preparation must reach the real provider port instead of retrying a workspace-only read");
  assert.deepEqual(f.calls, [], "the global scope key is never used as a filesystem workspace");
  const { aggregate, tools } = f.requests[0];
  assert.equal(aggregate.phase, "observing");
  assert.deepEqual(aggregate.evidence, []);
  assert.equal(aggregate.events.some(event => ["observation.recorded", "tool.completed", "validation.completed", "work_plan.approved"].includes(event.type)), false);
  const preparation = aggregate.events.filter(event => event.type === "command.scheduled" && event.command.kind === "collect_observation");
  assert.equal(preparation.length, 1);
  assert.ok(aggregate.events.some(event => event.type === "command.completed" && event.idempotencyKey === preparation[0].command.idempotencyKey && event.status === "succeeded"));
  assert.ok(f.authorization.toolDefinitions.some(tool => tool.function.name === "web_search"), "the enabled network tool remains in the actual capability catalog");
  assert.equal(f.authorization.capabilityRegistry.tools.web_search.enabled, true);
  assert.ok(tools.some(tool => tool.function.name === "tool_search"), "the first Execute request retains the existing tool-discovery path");
  for (const name of ["web_search", "web_fetch"]) assert.ok(tools.some(tool => tool.function.name === name), `global provider directly sees enabled ${name}`);
  for (const name of ["glob_search", "grep_search", "replace_in_file", "write_file", "run_command"]) assert.ok(!tools.some(tool => tool.function.name === name), `global provider omits unavailable ${name}`);
  assert.equal(f.state.currentTurnExecutionConsent.granted, false);
  assert.equal(f.state.autoApproveTools, false);
});

test("workspace Execute still collects its real project overview before the first provider request", async () => {
  const f = await runPreparation("/fixture");
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.calls, [{ name: "get_project_skeleton", args: {}, workspace: "/fixture" }]);
  assert.equal(f.requests[0].aggregate.phase, "observing");
  assert.equal(f.requests[0].aggregate.evidence.length, 1);
  assert.equal(f.requests[0].aggregate.evidence[0].kind, "source");
  assert.equal(f.requests[0].aggregate.events.some(event => ["tool.completed", "validation.completed", "work_plan.approved"].includes(event.type)), false);
});

test("a durable global preparing checkpoint recovers the same Run without retrying the rejected project read", async () => {
  const f = await runPreparation("", { coldPreparing: true });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.calls, []);
  const aggregate = f.requests[0].aggregate;
  assert.equal(aggregate.run.identity.runId, "run");
  assert.equal(aggregate.phase, "observing");
  assert.equal(aggregate.events.filter(event => event.type === "run.started").length, 1);
  assert.equal(aggregate.events.filter(event => event.type === "command.completed" && event.status === "failed").length, 1, "the historical denial remains intact");
  assert.equal(aggregate.events.filter(event => event.type === "command.completed" && event.status === "succeeded").length, 1);
  assert.deepEqual(aggregate.evidence, []);
  assert.equal(aggregate.events.some(event => ["observation.recorded", "tool.completed", "validation.completed", "work_plan.approved"].includes(event.type)), false);
});
