import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadProviderCompatibilityModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/providerCompatibility.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, require);
  return module.exports;
}

const {
  buildProviderCompatibilitySystemMessage,
  buildCompatibilityRetryMessages,
  buildTranscriptCompatibilityRetryMessages,
  isProviderCompatibilityErrorMessage,
  isNativeToolCompatibilityErrorMessage,
} = await loadProviderCompatibilityModule();

test("provider compatibility error helper matches weak OpenAI-compatible gateways", () => {
  assert.equal(
    isProviderCompatibilityErrorMessage('HTTP 400 Bad Request: {"error":{"message":"Unsupported content type","type":"invalid_request_error"}}'),
    true,
  );
  assert.equal(
    isProviderCompatibilityErrorMessage('HTTP 400 Bad Request: {"error":{"message":"Invalid type for messages[3].content","type":"invalid_request_error"}}'),
    true,
  );
  assert.equal(
    isProviderCompatibilityErrorMessage("HTTP 400: Responses API is not supported"),
    true,
  );
  assert.equal(
    isProviderCompatibilityErrorMessage("HTTP 400: Invalid 'messages' in payload"),
    true,
  );
  assert.equal(
    isNativeToolCompatibilityErrorMessage('HTTP 400: Invalid "messages" in payload'),
    true,
  );
  assert.equal(
    isNativeToolCompatibilityErrorMessage("HTTP 400: invalid messages"),
    true,
  );
  assert.equal(
    isProviderCompatibilityErrorMessage('HTTP 502 Bad Gateway: {"error":{"message":"Upstream request failed","type":"upstream_error"}}'),
    false,
  );
});

test("provider compatibility prompt exposes XML write tools for implementation mode", () => {
  const message = buildProviderCompatibilitySystemMessage("edit");

  assert.equal(message.role, "system");
  assert.match(message.content, /Tool access is available through XML tool calls/);
  assert.match(message.content, /write_file: create or overwrite a workspace file/);
  assert.match(message.content, /replace_in_file: edit an existing workspace file/);
  assert.match(message.content, /run_command: run workspace commands/);
  assert.match(message.content, /Never claim that write tools or folder access are unavailable/);
  assert.match(message.content, /<tool>write_file<\/tool>/);
});

test("compatibility retry flattens multimodal and tool history into plain text", () => {
  const messages = buildCompatibilityRetryMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "请看截图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    },
    {
      role: "assistant",
      content: "我先检查文件。",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: "{\"path\":\"src/App.tsx\"}" },
      }],
    },
    {
      role: "tool",
      content: "{\"ok\":true}",
      tool_call_id: "call_1",
    },
  ]);

  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content, /请看截图/);
  assert.match(messages[0].content, /Image omitted/);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "我先检查文件。");
  assert.equal(messages[2].role, "user");
  assert.match(messages[2].content, /\[Tool result\]/);
});

test("transcript compatibility retry collapses history into one plain-text user message", () => {
  const messages = buildTranscriptCompatibilityRetryMessages([
    { role: "system", content: "You are helpful." },
    { role: "user", content: "帮我读一下 src/App.tsx" },
    { role: "assistant", content: "我先检查。" },
    { role: "tool", content: "{\"ok\":true}" },
  ], "edit");

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content, /transcript_mode=true/);
  assert.match(messages[0].content, /\[Conversation Transcript\]/);
  assert.match(messages[0].content, /\[System 1\]/);
  assert.match(messages[0].content, /\[User 2\]/);
  assert.match(messages[0].content, /\[Assistant 3\]/);
  assert.match(messages[0].content, /\[User 4\]/);
  assert.match(messages[0].content, /emit XML <tool_use> blocks only/);
});
