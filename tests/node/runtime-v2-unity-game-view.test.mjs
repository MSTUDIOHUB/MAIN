import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

test("Unity Game View pixels reach the next provider request without becoming a validation or checkpoint payload", async () => {
  const workspace = "/tmp/main-unity-project";
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l44AAAAASUVORK5CYII=";
  const toolName = "capture_unity_game_view";
  const ipcCalls = [];
  const load = createTsModuleLoader({ "@tauri-apps/api/core": { invoke: async (name, args) => {
    assert.equal(name, toolName);
    assert.equal(args.workspace, workspace);
    ipcCalls.push(args);
    return { status: "captured", imageDataUrl: image, width: 1, height: 1 };
  } } });
  const runtime = load("src/lib/runtime-v2/index.ts");
  const live = load("src/store/runtimeV2/executionTypes.ts").createRuntimeV2LiveExecutionState();
  const { createRuntimeV2ToolPort } = load("src/store/runtimeV2/executionToolPort.ts");
  const { authorizationFor } = load("src/store/runtimeV2/executionAuthorizationContext.ts");
  const { selectRuntimeV2ProviderToolDefinitions } = load("src/store/runtimeV2/executionProviderTools.ts");
  const { requestRuntimeV2ProviderOnce } = load("src/store/runtimeV2/executionProviderRequest.ts");
  const { runtimeV2UnityGameViewMessage } = load("src/store/runtimeV2/executionUnityGameView.ts");
  const streaming = load("src/lib/streaming.ts");
  const lanes = load("src/lib/modelLaneCoordinator.ts");
  const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
  let checkpoint = null;
  let serial = 0;
  const trace = [];
  const ports = {
    context: {
      turnId: run.turnId, runWorkspace: workspace, runSessionKey: run.sessionKey, phaseLanguage: "en", runtimeRunIntent: "execute",
      workspaceMcpSnapshot: { workspace, mcpDiscoveredTools: [], mcpServers: [], mcpToolServerMap: {}, unityGameViewSupported: true },
      runtimeContextBudget: { contextLimit: 16000, inputBudget: 14000, outputBudget: 2000 },
    },
    get: () => ({ runtimeV2Checkpoints: checkpoint ? { turn: checkpoint } : {}, config: {
      activeProfile: "local", local: { provider: "omlx", endpoint: "http://fixture.invalid", model: "fixture", contextLimit: 16000 },
    } }),
    live, now: Date.now, nextId: scope => `${scope}-${++serial}`,
    logStoreEvent: (name, payload) => trace.push({ name, payload }),
  };
  const toolPort = createRuntimeV2ToolPort(ports);
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: { append: async input => {
      const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input });
      checkpoint = result.checkpoint;
      return result;
    } },
    provider: { request: async () => assert.fail("unexpected provider action") },
    tool: toolPort, scheduler: { execute: async () => [] }, projection: { publish: async () => {} },
    clockId: { now: Date.now, nextId: ports.nextId, nextIdempotencyKey: ({ kind }) => `${kind}-${++serial}` },
  });
  await controller.admit({ turn: { workspaceKey: workspace, sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" }, run,
    strategy: "execute", objective: "Inspect the Unity Game View", initialPhase: "validating" });
  const providerCommand = { run, kind: "request_model", phase: "validating", idempotencyKey: "inspect", payload: { mode: "validate" } };
  const authorized = authorizationFor(ports);
  const tools = selectRuntimeV2ProviderToolDefinitions({ ports, command: providerCommand,
    available: authorized.toolDefinitions, capabilityRegistry: authorized.capabilityRegistry });
  assert.ok(tools.some(tool => tool.function.name === toolName));
  live.messages.push({ role: "user", content: "Inspect the Unity Game View." }, {
    role: "assistant", content: "", tool_calls: [{ id: "capture-call", type: "function", function: { name: toolName, arguments: "{}" } }],
  });
  await controller.schedule({ run, kind: "execute_tool", phase: "validating", idempotencyKey: "capture",
    payload: { toolCallId: "capture-call", toolName, arguments: {} } });
  await controller.resumeScheduled();
  assert.equal(ipcCalls.length, 1);
  const captured = controller.snapshot().aggregate.events.find(event => event.type === "tool.completed" && event.idempotencyKey === "capture");
  assert.equal(captured?.status, "succeeded");
  assert.equal(captured?.effectKind, "observation");
  assert.ok(captured.evidence.every(item => item.kind === "tool"));
  assert.doesNotMatch(JSON.stringify(checkpoint), /data:image/);
  assert.doesNotMatch(JSON.stringify(live.messages), /data:image/);
  const aggregate = controller.snapshot().aggregate;
  assert.equal(runtimeV2UnityGameViewMessage(aggregate, run, undefined), undefined, "cold restore requires a new capture");
  assert.equal(runtimeV2UnityGameViewMessage(aggregate, { ...run, sessionEpoch: "different" }, live.unityGameViewCapture), undefined);
  const afterAnotherCheck = { ...aggregate, events: [...aggregate.events, {
    type: "validation.completed", sequence: aggregate.nextSequence,
  }] };
  assert.ok(runtimeV2UnityGameViewMessage(afterAnotherCheck, run, live.unityGameViewCapture), "the first request can inspect a frame taken during a batch of checks");

  const requests = [];
  lanes.acquireModelLane = async () => ({ markFirstToken() {}, reportFailure() {}, release() {} });
  streaming.streamChatCompletion = async (messages, _settings, _callbacks, _signal, _tools, _maxTokens, options) => {
    requests.push(messages);
    const serializedImageParts = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(part => part.type === "image_url" && part.image_url.url === image).length;
    return { content: "The Game View shows a flat background.", semanticContent: "The Game View shows a flat background.", toolCalls: [],
      finishReason: "stop", usage: null, visualTransportReceipt: {
        ...options.visualTransportBinding, requestAccepted: true, logicalImageParts: serializedImageParts, serializedImageParts,
      } };
  };
  const request = () => requestRuntimeV2ProviderOnce({ live, ports, command: providerCommand, tools, textEnvelope: false,
    toolChoice: null, signal: new AbortController().signal });
  await request();
  const images = requests[0].flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === "image_url");
  assert.deepEqual(images, [{ type: "image_url", image_url: { url: image } }]);
  assert.equal(runtimeV2UnityGameViewMessage(afterAnotherCheck, run, live.unityGameViewCapture), undefined, "a later check invalidates a frame the model has already received");
  assert.ok(trace.some(entry => entry.name === "runtime_v2_unity_game_view_transport" && entry.payload.serializedImageParts === 1));
  assert.doesNotMatch(JSON.stringify(trace), /data:image/);

  const streamed = streaming.streamChatCompletion;
  streaming.streamChatCompletion = async (messages, ...args) => {
    if (JSON.stringify(messages).includes(image)) throw new Error("image_url is not supported");
    return streamed(messages, ...args);
  };
  await request();
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /data:image/);
  assert.match(JSON.stringify(requests.at(-1)), /Visual inspection is still pending/);
  assert.ok(trace.some(entry => entry.name === "runtime_v2_unity_game_view_transport" && entry.payload.omissionReason === "provider_unsupported"));
});
