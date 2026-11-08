import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
const cache = new Map();
function load(file) {
  const filename = path.resolve(file);
  if (cache.has(filename)) return cache.get(filename);
  const module = { exports: {} }; cache.set(filename, module.exports);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const localRequire = createRequire(filename);
  new Function("exports", "module", "require", compiled)(module.exports, module, name => {
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(filename), name);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return load(candidate);
    }
    return localRequire(name);
  });
  cache.set(filename, module.exports); return module.exports;
}
const runtime = load("src/lib/runtime-v2/index.ts");
const context = load("src/store/runtimeV2/executionContext.ts");
const requests = load("src/store/runtimeV2/executionProviderRequest.ts");
const provider = load("src/store/runtimeV2/executionProviderPort.ts");
const types = load("src/store/runtimeV2/executionTypes.ts");
const tools = load("src/store/runtimeV2/executionToolPort.ts");
const executor = load("src/lib/toolExecutor.ts");
const authorization = load("src/store/runtimeV2/executionAuthorization.ts");
const definitions = load("src/lib/toolSchemas.ts").buildToolDefinitions([]);
const references = [{ kind: "source", kbId: "kb-1", sourceId: "source-1", sourceRevision: "v1" }];
const call = index => ({ id: `wire-${index}`, name: "knowledge_get_excerpt", arguments: { source_id: "source-1", chunk_id: `source-1:${index}` } });
const command = ordinal => ({ idempotencyKey: `request-${ordinal}`, kind: "request_model", phase: "acting", run: { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" }, payload: { mode: "execute", collaborationAllowed: false, remainingSubagentCapacity: 0 } });

test("real provider/tool boundaries reopen an omitted parallel excerpt only when a larger serial window can reveal it", async () => {
  const live = types.createRuntimeV2LiveExecutionState();
  live.providerLaneProfile = { schemaVersion: "provider-lane.v1", nativeTools: true, requiredToolChoice: false, streaming: true, textToolEnvelope: true, reasoning: false, imageInput: false, toolResultRole: "tool" };
  live.messages = [{ role: "system", content: "[MAIN RUNTIME V2] fixture" }, { role: "user", content: "Read the selected document chunks." }];
  let proposed = [call(0), call(1)]; let counter = 0;
  const originalSurface = Object.getOwnPropertyDescriptor(context, "providerToolDefinitionsForCommand");
  const originalRequest = requests.requestRuntimeV2ProviderOnce;
  const originalExecute = executor.executeTool;
  const originalAuthorize = authorization.authorizeToolForCurrentTurn;
  const raw = index => ({ text: "文".repeat(2800), excerpt: "文".repeat(700), citation: { kbId: "kb-1", sourceId: "source-1", sourceRevision: "v1", chunkId: `source-1:${index}`, indexRevision: "index-v1" }, returnedCharRange: { start: 0, end: 2800 }, totalChars: 2800, complete: true, retrievalKind: "source_excerpt" });
  Object.defineProperty(context, "providerToolDefinitionsForCommand", { configurable: true, enumerable: true, value: () => definitions.filter(tool => tool.function.name === "knowledge_get_excerpt") });
  requests.requestRuntimeV2ProviderOnce = async () => runtime.normalizeProviderResponseV1({ tool_calls: proposed.map(item => ({ id: item.id, type: "function", function: { name: item.name, arguments: JSON.stringify(item.arguments) } })) });
  authorization.authorizeToolForCurrentTurn = async () => ({ allowed: true, reason: null });
  const executed = [];
  executor.executeTool = async (name, args, _workspace, _session, options) => { assert.equal(name, "knowledge_get_excerpt"); assert.deepEqual(options.knowledgeReferences, references); executed.push(args.chunk_id); return raw(args.chunk_id.endsWith(":0") ? 0 : 1); };
  const ports = { get: () => ({}), context: { turnId: "turn", runtimeRunIntent: "execute", runtimeContextBudget: { readWindowChars: 4000, inputBudget: 8000, contextLimit: 16000, outputBudget: 2000 }, knowledgeContext: { state: "retrieved", references, hits: [], query: "read", note: "" }, runWorkspace: "/tmp/knowledge-fixture", runSessionKey: "session", phaseLanguage: "en" }, live, nextId: scope => `${scope}-${++counter}`, now: () => 100, logStoreEvent() {} };
  const providerPort = provider.createRuntimeV2ProviderPort(ports);
  const toolPort = tools.createRuntimeV2ToolPort(ports);
  const runTool = async (selected, ordinal) => toolPort.execute({ command: { ...command(ordinal), idempotencyKey: `tool-${ordinal}`, kind: "execute_tool", payload: { toolCallId: selected.id, toolName: selected.name, arguments: selected.arguments } }, signal: new AbortController().signal });
  try {
    const batch = await providerPort.request({ command: command(1), signal: new AbortController().signal });
    assert.equal(batch.toolCalls.length, 2);
    for (const [index, selected] of batch.toolCalls.entries()) {
      const completed = await runTool(selected, index);
      assert.equal(completed.status, "succeeded");
      assert.deepEqual(JSON.parse(completed.modelContent).hits, []);
      assert.ok(completed.evidence.every(evidence => evidence.kind === "tool"), "knowledge never grants workspace source leases");
    }
    const sameWindow = await providerPort.request({ command: command(2), signal: new AbortController().signal });
    assert.equal(sameWindow.toolCalls.length, 0, "the same undersized batch cannot reopen unchanged observations");
    const canonicalBefore = structuredClone(live.messages);
    // Cold reconstruction uses receipts, not an in-memory retry counter.
    live.messages = structuredClone(canonicalBefore);
    proposed = [call(0)];
    const serial = await providerPort.request({ command: command(3), signal: new AbortController().signal });
    assert.equal(serial.toolCalls.length, 1, "body omitted at the shared window must remain eligible at a larger serial window");
    assert.deepEqual(live.messages.slice(0, canonicalBefore.length), canonicalBefore);
    const visible = await runTool(serial.toolCalls[0], 4);
    assert.equal(JSON.parse(visible.modelContent).text.length, 2800);
    const repeated = await providerPort.request({ command: command(4), signal: new AbortController().signal });
    assert.equal(repeated.toolCalls.length, 0, "a previously delivered complete excerpt is still duplicate-closed");
    assert.deepEqual(executed, ["source-1:0", "source-1:1", "source-1:0"]);
  } finally {
    requests.requestRuntimeV2ProviderOnce = originalRequest; executor.executeTool = originalExecute; authorization.authorizeToolForCurrentTurn = originalAuthorize;
    Object.defineProperty(context, "providerToolDefinitionsForCommand", originalSurface);
  }
});


test("knowledge receipt reopening requires unchanged frozen scope, larger capacity, and no later authoritative denial", () => {
  const receipts = load("src/store/runtimeV2/providerReadReceipts.ts");
  const knowledge = load("src/lib/knowledgeReferences.ts");
  const item = call(0);
  const result = { text: "文".repeat(2800), citation: { kbId: "kb-1", sourceId: "source-1", sourceRevision: "v1", chunkId: "source-1:0" } };
  const pair = content => [{ role: "assistant", content: "", tool_calls: [{ id: "read-one", type: "function", function: { name: item.name, arguments: JSON.stringify(item.arguments) } }] }, { role: "tool", tool_call_id: "read-one", content }];
  const omitted = knowledge.boundKnowledgeToolResult(result, references, 1000);
  assert.equal(receipts.runtimeV2ProviderOmittedKnowledgeCanReplay(item, pair(omitted), references, 4000), true);
  assert.equal(receipts.runtimeV2ProviderOmittedKnowledgeCanReplay(item, pair(omitted), references, 1000), false);
  assert.equal(receipts.runtimeV2ProviderOmittedKnowledgeCanReplay(item, pair(omitted), [{ ...references[0], sourceRevision: "v2" }], 4000), false);
  assert.equal(receipts.runtimeV2ProviderOmittedKnowledgeCanReplay(call(1), pair(omitted), references, 4000), false);
  assert.equal(receipts.runtimeV2ProviderOmittedKnowledgeCanReplay(item, pair(JSON.stringify(result)), references, 4000), false);
  assert.equal(receipts.runtimeV2ProviderOmittedKnowledgeCanReplay(item, [...pair(omitted), ...pair("TOOL_BLOCKED: permission denied")], references, 4000), false);
  assert.equal(receipts.runtimeV2ProviderOmittedKnowledgeCanReplay({ ...item, name: "run_command" }, pair(omitted), references, 4000), false);
  assert.equal(receipts.runtimeV2ProviderOmittedKnowledgeCanReplay(item, pair(JSON.stringify({ hits: [], truncated: true, omittedHits: 1 })), references, 4000), false, "arbitrary empty JSON is not a runtime-owned omitted delivery receipt");
});
