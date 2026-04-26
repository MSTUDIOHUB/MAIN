import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadCloudProtocolModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/cloudProtocol.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const localRequire = createRequire(sourcePath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(sourcePath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!require("node:fs").existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          const nestedSource = require("node:fs").readFileSync(candidate, "utf8");
          const nestedTranspiled = ts.transpileModule(nestedSource, {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2020,
            },
            fileName: candidate,
          }).outputText;
          const nestedModule = { exports: {} };
          const nestedFactory = new Function("exports", "module", "require", nestedTranspiled);
          nestedFactory(nestedModule.exports, nestedModule, runtimeRequire);
          return nestedModule.exports;
        }
      }
    }

    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  return module.exports;
}

const {
  buildOpenAiResponsesInputCandidates,
  buildOpenAiResponsesRequestExtras,
  buildOpenAiResponsesTranscript,
  extractOpenAiResponsesInstructions,
  buildAnthropicRequestBody,
  buildCloudHeaders,
  buildCloudMessagesApiUrl,
  buildCloudModelListCandidates,
  compactCloudResponsesInstructions,
  compactCloudResponsesMessages,
  createAnthropicStreamProcessor,
  extractAnthropicResponseText,
  extractOpenAiResponseText,
  mapMessagesForAnthropic,
  parseCloudCustomHeaders,
} = await loadCloudProtocolModule();

test("anthropic request body lifts system prompts and converts native tools/tool results", () => {
  const body = buildAnthropicRequestBody({
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Follow repo rules." },
      { role: "user", content: "Read the file." },
      { role: "user", content: [{ type: "text", text: "Use the attached screenshot." }] },
      {
        role: "assistant",
        content: "I will inspect it.",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: "{\"path\":\"src/App.tsx\"}",
          },
        }],
      },
      {
        role: "tool",
        content: "{\"ok\":true}",
        tool_call_id: "call_1",
      },
    ],
    model: "claude-sonnet-4-5",
    maxTokens: 1024,
    stream: true,
    temperature: 0.2,
    topP: 0.9,
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from disk",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative path" },
          },
          required: ["path"],
        },
      },
    }],
  });

  assert.equal(body.system, "You are helpful.\n\nFollow repo rules.");
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content.length, 2);
  assert.equal(body.messages[1].role, "assistant");
  assert.equal(body.messages[1].content[0].type, "text");
  assert.equal(body.messages[1].content[1].type, "tool_use");
  assert.equal(body.messages[1].content[1].id, "call_1");
  assert.equal(body.messages[1].content[1].name, "read_file");
  assert.deepEqual(body.messages[1].content[1].input, { path: "src/App.tsx" });
  assert.equal(body.messages[2].role, "user");
  assert.equal(body.messages[2].content[0].type, "tool_result");
  assert.equal(body.messages[2].content[0].tool_use_id, "call_1");
  assert.equal(body.tools[0].name, "read_file");
  assert.deepEqual(body.tools[0].input_schema.required, ["path"]);
});

test("anthropic mapper prepends a user turn when history starts with assistant", () => {
  const mapped = mapMessagesForAnthropic([
    { role: "assistant", content: "Continuing..." },
  ]);

  assert.equal(mapped.messages.length, 2);
  assert.equal(mapped.messages[0].role, "user");
  assert.equal(mapped.messages[1].role, "assistant");
  assert.equal(mapped.messages[1].content[0].text, "Continuing...");
});

test("anthropic stream processor handles named SSE events and tool json deltas", () => {
  const tokens = [];
  const processor = createAnthropicStreamProcessor((token) => tokens.push(token));

  const chunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel',
    'lo"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"src/"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"App.tsx\\"}"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  processor.flush();

  const result = processor.getResult();
  assert.deepEqual(tokens, ["Hello"]);
  assert.equal(result.content, "Hello");
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, "toolu_1");
  assert.equal(result.toolCalls[0].name, "read_file");
  assert.equal(result.toolCalls[0].arguments, "{\"path\":\"src/App.tsx\"}");
});

test("cloud helpers build protocol-specific endpoints and headers", () => {
  assert.equal(
    buildCloudMessagesApiUrl("https://api.anthropic.com", "anthropic"),
    "https://api.anthropic.com/v1/messages",
  );
  assert.equal(
    buildCloudMessagesApiUrl("https://api.openai.com/v1", "openai", "chat_completions"),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    buildCloudMessagesApiUrl("https://api.openai.com/v1", "openai", "responses"),
    "https://api.openai.com/v1/responses",
  );
  assert.deepEqual(
    buildCloudModelListCandidates("https://api.anthropic.com/v1/messages", "anthropic"),
    ["https://api.anthropic.com/v1/models"],
  );
  assert.deepEqual(
    buildCloudHeaders("anthropic", "test-key", true),
    {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "test-key",
    },
  );
  assert.deepEqual(
    buildCloudHeaders("openai", "test-key", true),
    {
      "Content-Type": "application/json",
      "Authorization": "Bearer test-key",
      "x-api-key": "test-key",
    },
  );
});

test("cloud header parser accepts JSON object and array formats", () => {
  assert.deepEqual(
    parseCloudCustomHeaders("{\"HTTP-Referer\":\"https://example.com\",\"X-Title\":\"MAIN\"}"),
    {
      headers: {
        "HTTP-Referer": "https://example.com",
        "X-Title": "MAIN",
      },
      error: null,
    },
  );
  assert.deepEqual(
    parseCloudCustomHeaders('[{"header":"X-Test","value":"123"},{"key":"X-Mode","value":"compat"}]'),
    {
      headers: {
        "X-Test": "123",
        "X-Mode": "compat",
      },
      error: null,
    },
  );
  assert.match(
    parseCloudCustomHeaders("{invalid").error,
    /合法 JSON/,
  );
});

test("responses helpers build multiple compatibility input shapes", () => {
  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Ping" },
    { role: "assistant", content: "Pong" },
  ];

  assert.equal(
    buildOpenAiResponsesTranscript(messages),
    "[User 1]\nPing\n\n[Assistant 2]\nPong",
  );
  assert.equal(extractOpenAiResponsesInstructions(messages), "You are helpful.");

  const candidates = buildOpenAiResponsesInputCandidates(messages);
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].mode, "message_text");
  assert.deepEqual(candidates[0].input, [
    { type: "message", role: "user", content: "Ping" },
    { type: "message", role: "assistant", content: "Pong" },
  ]);
  assert.equal(candidates[1].mode, "input_text_array");
  assert.deepEqual(candidates[1].input, [
    { role: "user", content: [{ type: "input_text", text: "Ping" }] },
    { role: "assistant", content: [{ type: "input_text", text: "Pong" }] },
  ]);
  assert.equal(candidates[2].mode, "transcript_text");
  assert.equal(
    candidates[2].input,
    "[User 1]\nPing\n\n[Assistant 2]\nPong",
  );
});

test("responses helpers build Codex-style store and reasoning options", () => {
  assert.deepEqual(
    buildOpenAiResponsesRequestExtras({
      disableResponseStorage: true,
      reasoningEffort: "xhigh",
    }),
    {
      stream: false,
      store: false,
      reasoning: { effort: "xhigh" },
    },
  );

  assert.deepEqual(
    buildOpenAiResponsesRequestExtras({
      disableResponseStorage: false,
      reasoningEffort: "none",
    }),
    {
      stream: false,
    },
  );
});

test("cloud responses compact instructions preserve workspace write tools", () => {
  const longInstructions = [
    "当前工作区绝对路径为：/tmp/workspace",
    "可用的工具：read_file, write_file, replace_in_file, run_command",
    "M Studio Unity 教程代码必须保留中文注释和 Region 分类。",
    "不要声称当前环境没有写入能力。",
    "low priority filler ".repeat(1200),
  ].join("\n");

  const compacted = compactCloudResponsesInstructions(longInstructions);

  assert.ok(compacted.length <= 8000);
  assert.match(compacted, /write_file/);
  assert.match(compacted, /replace_in_file/);
  assert.match(compacted, /run_command/);
  assert.match(compacted, /M Studio Unity/);
  assert.match(compacted, /Never claim write tools or folder access are unavailable/);
});

test("cloud responses compact messages keep recent context and summarize old history", () => {
  const messages = [
    { role: "system", content: "system" },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(1500)}`,
    })),
  ];

  const compacted = compactCloudResponsesMessages(messages);

  assert.equal(compacted[0].role, "system");
  assert.match(compacted[1].content, /older messages compacted/);
  assert.ok(compacted.length < messages.length);
  assert.match(compacted[compacted.length - 1].content, /message 11/);
});

test("anthropic response text extractor joins text content blocks", () => {
  const text = extractAnthropicResponseText({
    content: [
      { type: "text", text: "Short " },
      { type: "tool_use", id: "toolu_1", name: "noop", input: {} },
      { type: "text", text: "title" },
    ],
  });

  assert.equal(text, "Short title");
});

test("openai response text extractor supports chat completions and responses payloads", () => {
  const chatText = extractOpenAiResponseText({
    choices: [
      {
        message: {
          content: "hello from chat",
        },
      },
    ],
  }, "chat_completions");

  const responsesText = extractOpenAiResponseText({
    output: [
      {
        type: "message",
        content: [
          { type: "output_text", text: "hello from responses" },
        ],
      },
    ],
  }, "responses");

  assert.equal(chatText, "hello from chat");
  assert.equal(responsesText, "hello from responses");
});
