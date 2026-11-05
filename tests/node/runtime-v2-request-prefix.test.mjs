import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

function loadTs(sourcePath, mocks, cache = new Map()) {
  const filename = path.resolve(sourcePath);
  if (cache.has(filename)) return cache.get(filename);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  cache.set(filename, module.exports);
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText;
  const require = (name) => {
    if (mocks.has(name)) return mocks.get(name);
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(filename), name);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return loadTs(candidate, mocks, cache);
      }
    }
    return localRequire(name);
  };
  new Function("exports", "module", "require", source)(module.exports, module, require);
  cache.set(filename, module.exports);
  return module.exports;
}

test("changing decision guidance leaves the canonical conversation as a stable request prefix", async () => {
  const requests = [];
  const { isStreamOutputLimited } = loadTs(path.join(process.cwd(), "src/lib/streaming.ts"), new Map());
  const mocks = new Map([
    ["../../lib/modelLaneCoordinator", { acquireModelLane: async () => ({ markFirstToken() {}, release() {}, reportFailure() {} }) }],
    ["../../lib/streaming", { isStreamOutputLimited, streamChatCompletion: async (messages, _settings, _callbacks, _signal, _tools, _limit, options) => {
      requests.push({ messages: structuredClone(messages), options });
      return { content: "Answer", semanticContent: "Answer", toolCalls: [], finishReason: "stop", protocolViolation: null };
    } }],
  ]);
  const root = process.cwd();
  const { requestRuntimeV2ProviderOnce } = loadTs(path.join(root, "src/store/runtimeV2/executionProviderRequest.ts"), mocks);
  const { createRuntimeV2LiveExecutionState } = loadTs(path.join(root, "src/store/runtimeV2/executionTypes.ts"), mocks);
  const live = createRuntimeV2LiveExecutionState();
  live.messages = [
    { role: "system", content: "[MAIN RUNTIME V2] stable instructions" },
    { role: "user", content: "Explain the project." },
    { role: "system", content: "[runtime-v2 context: workspace-overview]\nStable workspace facts." },
    { role: "assistant", content: "", tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } }] },
    { role: "tool", tool_call_id: "read", content: "Stable README receipt." },
  ];
  const ports = {
    get: () => ({ config: { activeProfile: "local", local: { endpoint: "http://fixture.invalid/v1", model: "fixture", provider: "omlx", toolProtocol: "auto", contextLimit: 32768 } }, conversationTurns: [], agentMessages: [] }),
    context: { turnId: "turn", runWorkspace: "/fixture", phaseLanguage: "en", runtimeRunIntent: "summarize", runtimeContextBudget: { contextLimit: 32768, inputBudget: 24576, outputBudget: 8192 } },
    live, logStoreEvent() {},
  };
  const tools = [{ type: "function", function: { name: "read_file", description: "Read source", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
  const command = { kind: "request_model", phase: "observing", run: { runId: "run", turnId: "turn" }, payload: { mode: "analyze" } };
  const input = { live, ports, command, tools, textEnvelope: false, toolChoice: null, signal: new AbortController().signal };
  await requestRuntimeV2ProviderOnce(input);
  await requestRuntimeV2ProviderOnce({ ...input, command: { ...command, payload: { ...command.payload, recoveryPressure: { reason: "non_novel_evidence", occurrence: 1, stage: "reconsider" } } } });
  const prefix = requests[0].messages.slice(0, -1);
  assert.deepEqual(requests[1].messages.slice(0, -1), prefix, "recovery must not invalidate stable user/source bytes before the changing guidance");
  assert.equal(prefix.at(-1).tool_call_id, "read");
  assert.equal(requests[1].messages.at(-1).role, "system");
  assert.notEqual(requests[1].messages.at(-1).content, requests[0].messages.at(-1).content, "the new recovery instruction remains visible at the frontier");
  assert.ok(requests.every((request) => request.options.contextOwnership === "caller"));
  await requestRuntimeV2ProviderOnce({ ...input, textEnvelope: true });
  assert.deepEqual(requests[2].messages.slice(0, -3), prefix, "protocol instructions also belong after stable history");
});
