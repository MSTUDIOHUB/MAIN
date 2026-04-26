import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  buildPromptFromResponsesInput,
  extractTextDeltaFromUpstreamPayload,
  parseUpstreamTextStream,
} from "../../cloud-gateway/aimax/adapter.mjs";
import { createServer } from "../../cloud-gateway/aimax/server.mjs";

// #region 输入转换与上游流解析
test("buildPromptFromResponsesInput maps Codex text messages to upstream messages", () => {
  const messages = buildPromptFromResponsesInput({
    instructions: "遵守项目规则。",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "使用中文注释。" }] },
      { type: "message", role: "user", content: "实现网关。" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "我会开始。" }] },
    ],
  });

  assert.deepEqual(messages, [
    { role: "system", content: "遵守项目规则。" },
    { role: "system", content: "使用中文注释。" },
    { role: "user", content: "实现网关。" },
    { role: "assistant", content: "我会开始。" },
  ]);
});

test("buildPromptFromResponsesInput rejects non-text content", () => {
  assert.throws(
    () => buildPromptFromResponsesInput({
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "x" }] }],
    }),
    /Images, files, tool calls/,
  );
});

test("extractTextDeltaFromUpstreamPayload supports common stream payloads", () => {
  assert.deepEqual(
    extractTextDeltaFromUpstreamPayload({ choices: [{ delta: { content: "你" } }] }),
    { done: false, text: "你" },
  );
  assert.deepEqual(
    extractTextDeltaFromUpstreamPayload({ text: "好" }),
    { done: false, text: "好" },
  );
  assert.deepEqual(extractTextDeltaFromUpstreamPayload("[DONE]"), { done: true, text: "" });
});

test("parseUpstreamTextStream parses SSE chunks into payloads", async () => {
  const stream = ReadableStream.from([
    new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'),
    new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'),
    new TextEncoder().encode("data: [DONE]\n\n"),
  ]);

  const payloads = [];
  for await (const payload of parseUpstreamTextStream(stream)) payloads.push(payload);

  assert.equal(payloads.length, 3);
  assert.equal(payloads[0].choices[0].delta.content, "Hel");
  assert.equal(payloads[1].choices[0].delta.content, "lo");
  assert.equal(payloads[2], "[DONE]");
});
// #endregion

// #region 网关集成测试
test("gateway proxies non-streaming and streaming responses", async () => {
  const upstream = await listen(http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);

    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"云"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"端"}}]}\n\n');
      res.end("data: [DONE]\n\n");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "云端" } }] }));
  }));

  const gateway = await listen(createServer({
    port: 0,
    model: "ai-max-cloud",
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    upstreamPath: "/chat/completions",
    upstreamApiKey: "test-key",
    upstreamAuthHeader: "Authorization",
    upstreamAuthScheme: "Bearer",
    upstreamTimeoutMs: 300000,
  }));

  try {
    const nonStream = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "你好", stream: false }),
    });
    const nonStreamJson = await nonStream.json();
    assert.equal(nonStream.status, 200);
    assert.equal(nonStreamJson.output_text, "云端");

    const stream = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "你好", stream: true }),
    });
    const streamText = await stream.text();
    assert.equal(stream.status, 200);
    assert.match(streamText, /event: response.created/);
    assert.match(streamText, /event: response.output_text.delta/);
    assert.match(streamText, /"delta":"云"/);
    assert.match(streamText, /"delta":"端"/);
    assert.match(streamText, /event: response.completed/);
  } finally {
    await close(gateway.server);
    await close(upstream.server);
  }
});
// #endregion

// #region 测试服务器工具
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
// #endregion
