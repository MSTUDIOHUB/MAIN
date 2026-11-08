import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

function loadModule(entry, invoke, listen) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; cache.set(file, module.exports);
    const localRequire = createRequire(file);
    const output = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file }).outputText;
    new Function("exports", "module", "require", output)(module.exports, module, name => {
      if (name === "@tauri-apps/api/core") return { invoke };
      if (name === "@tauri-apps/api/event") return { listen };
      return name.startsWith(".") ? load(path.resolve(path.dirname(file), name + ".ts")) : localRequire(name);
    });
    return module.exports;
  }
  return load(path.resolve(entry));
}

const tools = [{ type: "function", function: { name: "read_file", description: "Read the named source.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
const preamble = "我将先读取项目约束。\n\n请稍候，我将开始调查。";
const calls = [
  { id: "read-agents", type: "function", function: { name: "read_file", arguments: '{"path":"AGENTS.md"}' } },
  { id: "read-package", type: "function", function: { name: "read_file", arguments: '{"path":"package.json"}' } },
];
const history = [
  { role: "system", content: "Use the actual tool results; preserve scope and review authority." },
  { role: "user", content: "调查项目，再起草规则。" },
  { role: "assistant", content: preamble, reasoning_content: "Inspect both sources before drafting.", tool_calls: calls },
  { role: "tool", tool_call_id: "read-agents", content: "[E1] AGENTS.md\nHUMAN_RULE_913\n保留人工规则。" },
  { role: "tool", tool_call_id: "read-package", content: '{"scripts":{"test":"node --test"}}' },
  { role: "system", content: "These sources do not grant write permission or prove validation." },
];

async function captureWire({ proxy, provider = "OpenAI Compatible", apiProtocol = "openai", apiFormat, transcript = false }) {
  const bodies = []; const listeners = new Map();
  const chunk = provider === "Ollama"
    ? JSON.stringify({ message: { content: "Investigation recorded." }, done: true, done_reason: "stop" }) + "\n"
    : apiProtocol === "anthropic"
      ? [
          ["message_start", { type: "message_start", message: { id: "fixture-reply", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Investigation recorded." } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
          ["message_stop", { type: "message_stop" }],
        ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")
      : "data: " + JSON.stringify({ choices: [{ delta: { content: "Investigation recorded." }, finish_reason: "stop" }] }) + "\n\n";
  const api = loadModule("src/lib/streaming.ts", async (name, args) => {
    if (name === "cancel_chat_stream") return;
    bodies.push(JSON.parse(args.body));
    if (name === "proxy_request") return JSON.stringify({ output_text: "Investigation recorded.", choices: [{ message: { content: "Investigation recorded." }, finish_reason: "stop" }] });
    assert.equal(name, "start_chat_stream");
    queueMicrotask(() => {
      listeners.get("chat-stream-chunk")?.({ payload: { stream_id: args.streamId, chunk } });
      listeners.get("chat-stream-done")?.({ payload: { stream_id: args.streamId, status: "success" } });
    });
  }, async (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name); });
  const input = structuredClone(history);
  if (transcript) input.unshift({ role: "system", content: "[PROVIDER_COMPATIBILITY_MODE] transcript_mode=true" });
  const canonical = structuredClone(input);
  const originalFetch = globalThis.fetch;
  try {
    if (!proxy) globalThis.fetch = async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response(chunk, { status: 200 }); };
    await api.streamChatCompletion(input, {
      baseUrl: "http://fixture.invalid/v1", apiKey: "", model: "generic-fixture", provider, apiProtocol, apiFormat,
      toolProtocol: "native", useRustProxy: proxy, preserveAssistantReasoning: true,
    }, { onToken() {}, onDone() {}, onError(error) { throw error; } }, undefined, tools, 512, { contextOwnership: "caller", reasoningOnlyCharLimit: null });
    assert.deepEqual(input, canonical, "serialization never changes canonical messages, reasoning or tool IDs");
    return bodies[0];
  } finally { globalThis.fetch = originalFetch; }
}

function assertPreambleBeforeTools(body, offset = 0) {
  const messages = body.messages.slice(offset);
  assert.equal(messages.length, history.length + 1, "one native assistant preamble becomes two chronological protocol messages");
  assert.deepEqual(messages[2], { role: "assistant", content: preamble });
  assert.deepEqual(messages[3], { role: "assistant", content: "", reasoning_content: history[2].reasoning_content, tool_calls: calls });
  assert.deepEqual(messages.slice(4, 6), history.slice(3, 5), "each real tool result stays adjacent to its original call ID");
  assert.deepEqual(messages[6], history[5], "the trailing runtime authority remains after the actual results");
  assert.equal(messages.filter(message => message.content === preamble).length, 1, "never duplicate or discard the preamble");
  assert.equal(JSON.stringify(messages).match(/Inspect both sources before drafting\./g)?.length, 1, "reasoning stays on the original tool-call assistant only");
  assert.equal(body.max_tokens, 512);
  assert.equal(body.tools[0].function.name, "read_file");
}

test("OpenAI-compatible Rust wire separates the native tool preamble before its call and results", async () => {
  assertPreambleBeforeTools(await captureWire({ proxy: true }));
});

test("OpenAI-compatible frontend wire uses the same provider-neutral chronological tool history", async () => {
  assertPreambleBeforeTools(await captureWire({ proxy: false, provider: "LM Studio" }));
});

test("OpenAI-compatible non-streaming Chat compatibility serializes preambles without changing result-role fallback", async () => {
  const body = await captureWire({ proxy: true, transcript: true });
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages[3], { role: "assistant", content: preamble });
  assert.deepEqual(body.messages[4], { role: "assistant", content: "", reasoning_content: history[2].reasoning_content, tool_calls: calls });
  assert.deepEqual(body.messages.slice(5, 7), history.slice(3, 5).map(message => ({ role: "user", content: message.content })));
});

test("wire normalizer retains opaque metadata, content parts and empty/non-tool messages without mutation", () => {
  const { normalizeOpenAiNativeToolPreambles } = loadModule("src/lib/providerCompatibility.ts");
  const parts = [{ type: "text", text: preamble }, { type: "refusal", refusal: "Keep human rules." }];
  const signed = { role: "assistant", content: parts, tool_calls: calls, reasoning: "tool reasoning", provider_signature: { opaque: "state" } };
  const unchanged = [{ role: "assistant", content: "ordinary response" }, { role: "assistant", content: "", tool_calls: calls }, { role: "assistant", content: "text", tool_calls: [] }, ...history.slice(3)];
  const input = [signed, ...unchanged]; const canonical = structuredClone(input);
  const output = normalizeOpenAiNativeToolPreambles(input);
  assert.deepEqual(output, [{ role: "assistant", content: parts }, { ...signed, content: "" }, ...unchanged]);
  assert.deepEqual(normalizeOpenAiNativeToolPreambles(output), output, "normalization is idempotent");
  assert.deepEqual(input, canonical);
});

test("Responses, Anthropic and native Ollama retain their own transcript mappings", async () => {
  const responses = await captureWire({ proxy: true, apiFormat: "responses" });
  assert.equal(responses.messages, undefined);
  assert.deepEqual(responses.input, history.filter(message => message.role !== "system").map(message => ({
    type: "message", role: message.role === "tool" ? "user" : message.role, content: message.content,
  })), "do not alter the existing Responses compatibility mapping as part of Chat serialization");
  const anthropic = await captureWire({ proxy: true, apiProtocol: "anthropic", provider: "Anthropic" });
  const assistant = anthropic.messages.find(message => message.role === "assistant");
  assert.equal(assistant.content[0].type, "text");
  assert.equal(assistant.content[0].text, preamble);
  assert.equal(assistant.content.filter(part => part.type === "tool_use").length, 2);
  assert.equal(anthropic.messages.filter(message => message.role === "assistant").length, 1);
  const ollama = await captureWire({ proxy: true, provider: "Ollama" });
  assert.equal(ollama.messages.length, history.length);
  assert.deepEqual(ollama.messages[2], history[2], "native /api/chat keeps its existing combined assistant format");
});
