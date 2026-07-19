import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadStreamingModule(invokeMock, listenMock) {
  const sourcePath = path.join(workspaceRoot, "src/lib/streaming.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const runtimeRequire = (specifier) => {
    if (specifier === "@tauri-apps/api/core") {
      return { invoke: invokeMock };
    }
    if (specifier === "@tauri-apps/api/event") {
      return { listen: listenMock ?? (async () => () => {}) };
    }
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(sourcePath), specifier);
      const candidate = `${basePath}.ts`;
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
    return require(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  return module.exports;
}

// #region Responses 路由与降级
test("OpenAI Responses cloud requests use the non-streaming Rust proxy path", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "proxy_request");
    const body = JSON.parse(args.body);
    requests.push(body);
    assert.equal(args.url, "https://www.aiwanwu.cc/v1/responses");
    assert.equal(body.stream, false);
    assert.equal(body.model, "gpt-5.4");
    assert.equal(body.user_prompt_id, undefined);
    assert.equal(Array.isArray(body.input), true);
    return JSON.stringify({ output_text: "ok" });
  });
  const tokens = [];
  let doneCount = 0;

  const result = await streamChatCompletion(
    [{ role: "user", content: "你好" }],
    {
      baseUrl: "https://www.aiwanwu.cc/v1",
      apiKey: "test-key",
      model: "gpt-5.4",
      apiProtocol: "openai",
      apiFormat: "responses",
      useRustProxy: true,
      reasoningEffort: "xhigh",
    },
    {
      onToken: (token) => tokens.push(token),
      onDone: () => { doneCount += 1; },
      onError: (error) => { throw error; },
    },
  );

  assert.equal(result.content, "ok");
  assert.deepEqual(tokens, ["ok"]);
  assert.equal(doneCount, 1);
  assert.equal(requests[0].reasoning.effort, "xhigh");
});

test("OpenAI Responses reports image delivery from the accepted serialized request", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (_command, args) => {
    requests.push(JSON.parse(args.body));
    return JSON.stringify({ output_text: "observed" });
  });
  const imageUrl = "data:image/png;base64,AAAA";
  const result = await streamChatCompletion(
    [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: imageUrl } },
        { type: "text", text: "Inspect this screenshot" },
      ],
    }],
    {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-5.4",
      apiProtocol: "openai",
      apiFormat: "responses",
      useRustProxy: true,
    },
    { onToken: () => {}, onDone: () => {}, onError: (error) => { throw error; } },
  );

  assert.equal(JSON.stringify(requests[0]).includes('"type":"input_image"'), true);
  assert.deepEqual(result.visualTransportReceipt, {
    protocol: "openai_responses",
    requestAccepted: true,
    logicalImageParts: 1,
    serializedImageParts: 1,
    omittedImageParts: 0,
  });
});

test("OpenAI Responses gateway timeouts preserve the current image in aggressive structured fallback", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "proxy_request");
    const body = JSON.parse(args.body);
    requests.push(body);
    if (requests.length === 1) {
      throw new Error("HTTP 504: Gateway Time-out");
    }
    return JSON.stringify({ output_text: "fallback ok" });
  });

  const longChunk = "important context ".repeat(420);
  const result = await streamChatCompletion(
    [
      {
        role: "system",
        content: [
          "当前工作区绝对路径为：/tmp/project",
          "工具调用格式必须使用可用工具。",
          "write_file replace_in_file read_file grep_search glob_search run_command",
          "filler ".repeat(1200),
        ].join("\n"),
      },
      ...Array.from({ length: 18 }, (_, index) => ({
        role: index % 3 === 0 ? "tool" : index % 2 === 0 ? "user" : "assistant",
        content: `message ${index} ${longChunk}`,
      })),
      {
        role: "user",
        content: [
          { type: "text", text: "请继续检查当前截图并完成计划文件。" },
          { type: "image_url", image_url: { url: "data:image/png;base64,CURRENT" } },
        ],
      },
    ],
    {
      baseUrl: "https://www.aiwanwu.cc/v1",
      apiKey: "test-key",
      model: "gpt-5.5",
      apiProtocol: "openai",
      apiFormat: "responses",
      useRustProxy: true,
      reasoningEffort: "xhigh",
      disableResponseStorage: true,
      contextLimit: 32768,
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
    undefined,
    [{
      type: "function",
      function: {
        name: "write_file",
        description: "Write a file",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      },
    }],
  );

  assert.equal(result.content, "fallback ok");
  assert.equal(requests.length, 2);
  assert.equal(Array.isArray(requests[0].input), true);
  assert.equal(requests[0].tools[0].name, "write_file");
  assert.deepEqual(requests[0].reasoning, { effort: "xhigh" });
  assert.match(requests[0].instructions, /protocol=native/);
  assert.doesNotMatch(requests[0].instructions, /<tool_use>|protocol=xml-text/);

  assert.equal(Array.isArray(requests[1].input), true);
  assert.match(JSON.stringify(requests[1].input), /input_image/);
  assert.match(JSON.stringify(requests[1].input), /CURRENT/);
  assert.equal(requests[1].tools, undefined);
  assert.equal(requests[1].reasoning, undefined);
  assert.equal(requests[1].user_prompt_id, undefined);
  assert.equal(requests[1].store, false);
  assert.match(requests[1].instructions, /Cloud Gateway Compact Instructions/);
  assert.match(requests[1].instructions, /protocol=none; available=none/);
  assert.doesNotMatch(requests[1].instructions, /<tool_use>|write_file|replace_in_file|run_command/);
  assert.ok(requests[1].instructions.length <= 3100);
  assert.ok(JSON.stringify(requests[1].input).length < 12000);
  assert.deepEqual(result.visualTransportReceipt, {
    protocol: "openai_responses",
    requestAccepted: true,
    logicalImageParts: 1,
    serializedImageParts: 1,
    omittedImageParts: 0,
  });
});

test("OpenAI ChatGPT OAuth cloud requests pass token references to the Rust proxy without sampling params", async () => {
  const invokeArgs = [];
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "proxy_request");
    invokeArgs.push(args);
    const body = JSON.parse(args.body);
    assert.equal(args.authMode, "openai_chatgpt_oauth");
    assert.equal(args.tokenRef, "openai-login");
    assert.equal(args.headers.Authorization, undefined);
    assert.equal(args.headers["x-api-key"], undefined);
    assert.equal(body.user_prompt_id, "main-cloud-test");
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(typeof body.instructions, "string");
    assert.equal(body.instructions.length > 0, true);
    assert.equal(body.temperature, undefined);
    assert.equal(body.top_p, undefined);
    return "__CONTENT_TYPE__:text/event-stream\n"
      + "event: response.output_text.delta\n"
      + "data: {\"delta\":\"ok\"}\n\n"
      + "event: response.completed\n"
      + "data: {\"response\":{\"status\":\"completed\",\"output_text\":\"ok\"}}\n\n";
  });

  await streamChatCompletion(
    [{ role: "user", content: "hi" }],
    {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-5.4",
      apiProtocol: "openai",
      apiFormat: "responses",
      authMode: "openai_chatgpt_oauth",
      tokenRef: "openai-login",
      useRustProxy: true,
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.equal(invokeArgs[0].url, "https://api.openai.com/v1/responses");
});

test("OpenAI ChatGPT OAuth forces responses endpoint even when apiFormat is chat_completions", async () => {
  const invokeArgs = [];
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "proxy_request");
    invokeArgs.push(args);
    const body = JSON.parse(args.body);
    assert.equal(args.authMode, "openai_chatgpt_oauth");
    assert.equal(body.user_prompt_id, "main-cloud-test");
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(typeof body.instructions, "string");
    return "__CONTENT_TYPE__:text/event-stream\n"
      + "event: response.output_text.delta\n"
      + "data: {\"delta\":\"ok\"}\n\n"
      + "event: response.completed\n"
      + "data: {\"response\":{\"status\":\"completed\",\"output_text\":\"ok\"}}\n\n";
  });

  await streamChatCompletion(
    [{ role: "user", content: "hi" }],
    {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-5.4",
      apiProtocol: "openai",
      apiFormat: "chat_completions",
      authMode: "openai_chatgpt_oauth",
      tokenRef: "openai-login",
      useRustProxy: true,
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.equal(invokeArgs[0].url, "https://api.openai.com/v1/responses");
});

test("OpenAI Responses propagates incomplete JSON as length and suppresses partial tool calls", async () => {
  const tokens = [];
  let doneCount = 0;
  let errorCount = 0;
  const { streamChatCompletion } = await loadStreamingModule(async () => JSON.stringify({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output_text: "partial answer",
    output: [{
      type: "function_call",
      call_id: "partial-call",
      name: "write_file",
      arguments: "{\"path\":\"src/a.ts\"",
    }],
  }));

  const result = await streamChatCompletion(
    [{ role: "user", content: "finish the task" }],
    {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-5.4",
      apiProtocol: "openai",
      apiFormat: "responses",
      useRustProxy: true,
    },
    {
      onToken: (token) => tokens.push(token),
      onDone: () => { doneCount += 1; },
      onError: () => { errorCount += 1; },
    },
  );

  assert.equal(result.content, "partial answer");
  assert.equal(result.finishReason, "length");
  assert.equal(result.responseStatus, "incomplete");
  assert.equal(result.responseIncompleteReason, "max_output_tokens");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(tokens, ["partial answer"]);
  assert.equal(doneCount, 1);
  assert.equal(errorCount, 0);
});

test("OpenAI Responses rejects failed SSE without publishing partial output as done", async () => {
  const tokens = [];
  let doneCount = 0;
  const errors = [];
  const { streamChatCompletion } = await loadStreamingModule(async () => (
    "__CONTENT_TYPE__:text/event-stream\n"
    + "event: response.output_text.delta\n"
    + "data: {\"delta\":\"partial\"}\n\n"
    + "event: response.failed\n"
    + "data: {\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"generation crashed\"}}}\n\n"
  ));

  await assert.rejects(
    () => streamChatCompletion(
      [{ role: "user", content: "finish the task" }],
      {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        model: "gpt-5.4",
        apiProtocol: "openai",
        apiFormat: "responses",
        useRustProxy: true,
      },
      {
        onToken: (token) => tokens.push(token),
        onDone: () => { doneCount += 1; },
        onError: (error) => { errors.push(error); },
      },
    ),
    /OPENAI_RESPONSES_FAILED: generation crashed/,
  );

  assert.deepEqual(tokens, []);
  assert.equal(doneCount, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /OPENAI_RESPONSES_FAILED/);
});

test("Gemini OAuth cloud requests use native generateContent endpoint and token refs", async () => {
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "proxy_request");
    const body = JSON.parse(args.body);
    assert.equal(args.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
    assert.equal(args.authMode, "gemini_google_oauth");
    assert.equal(args.tokenRef, "gemini-login");
    assert.equal(args.headers.Authorization, undefined);
    assert.equal(args.headers["x-goog-api-key"], undefined);
    assert.equal(body.contents[0].parts[0].text, "你好");
    assert.equal(body.generationConfig.maxOutputTokens > 0, true);
    assert.equal(body.temperature, undefined);
    assert.equal(body.top_p, undefined);
    return JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  });

  const result = await streamChatCompletion(
    [{ role: "user", content: "你好" }],
    {
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "",
      model: "gemini-2.5-pro",
      apiProtocol: "gemini",
      authMode: "gemini_google_oauth",
      tokenRef: "gemini-login",
      useRustProxy: true,
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.equal(result.content, "ok");
});

test("Gemini reports delivery only for an accepted inlineData image part", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (_command, args) => {
    requests.push(JSON.parse(args.body));
    return JSON.stringify({ candidates: [{ content: { parts: [{ text: "observed" }] } }] });
  });
  const result = await streamChatCompletion(
    [{
      role: "user",
      content: [
        { type: "text", text: "Inspect" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
      ],
    }],
    {
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      model: "gemini-2.5-pro",
      apiProtocol: "gemini",
      useRustProxy: true,
    },
    { onToken: () => {}, onDone: () => {}, onError: (error) => { throw error; } },
  );

  assert.deepEqual(requests[0].contents[0].parts[1], {
    inlineData: { mimeType: "image/jpeg", data: "BBBB" },
  });
  assert.deepEqual(result.visualTransportReceipt, {
    protocol: "gemini",
    requestAccepted: true,
    logicalImageParts: 1,
    serializedImageParts: 1,
    omittedImageParts: 0,
  });
});

test("a serialized historical image cannot impersonate an omitted current screenshot", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (_command, args) => {
    requests.push(JSON.parse(args.body));
    return JSON.stringify({ candidates: [{ content: { parts: [{ text: "observed" }] } }] });
  });
  const result = await streamChatCompletion(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "Old screenshot" },
          { type: "image_url", image_url: { url: "data:image/png;base64,OLD" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect the current screenshot" },
          { type: "image_url", image_url: { url: "https://example.test/current.png" } },
        ],
      },
    ],
    {
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      model: "gemini-2.5-pro",
      apiProtocol: "gemini",
      useRustProxy: true,
    },
    { onToken: () => {}, onDone: () => {}, onError: (error) => { throw error; } },
  );

  assert.equal(JSON.stringify(requests[0]).includes("OLD"), true);
  assert.equal(JSON.stringify(requests[0]).includes("current.png"), false);
  assert.deepEqual(result.visualTransportReceipt, {
    protocol: "gemini",
    requestAccepted: true,
    logicalImageParts: 1,
    serializedImageParts: 0,
    omittedImageParts: 1,
    omissionReason: "serialization_omitted_images",
  });
});

test("OpenAI Responses respects XML tool protocol by omitting native tools", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "proxy_request");
    const body = JSON.parse(args.body);
    requests.push(body);
    return JSON.stringify({ output_text: "ok" });
  });

  await streamChatCompletion(
    [{ role: "user", content: "读文件" }],
    {
      baseUrl: "https://api.openai.test/v1",
      apiKey: "test-key",
      model: "gpt-5.4",
      apiProtocol: "openai",
      apiFormat: "responses",
      useRustProxy: true,
      toolProtocol: "xml",
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
    undefined,
    [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
  );

  assert.equal(requests[0].tools, undefined);
});

test("OpenAI-compatible history keeps tool call arguments as JSON strings", async () => {
  const listeners = new Map();
  const bodies = [];
  const listenMock = async (eventName, handler) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  };
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "start_chat_stream");
    bodies.push(JSON.parse(args.body));
    const streamId = args.streamId;
    queueMicrotask(() => {
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        },
      });
      listeners.get("chat-stream-done")?.({
        payload: {
          stream_id: streamId,
          status: "success",
        },
      });
    });
    return undefined;
  }, listenMock);

  const result = await streamChatCompletion(
    [
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: "{\"path\":\"README.md\"}",
          },
        }],
      },
      {
        role: "tool",
        content: "ok",
        tool_call_id: "call_1",
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_2",
          type: "function",
          function: {
            name: "list_directory",
            arguments: { path: "." },
          },
        }],
      },
    ],
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "not-needed",
      model: "local-model",
      provider: "LM Studio",
      useRustProxy: true,
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.equal(result.content, "ok");
  assert.equal(typeof bodies[0].messages[0].tool_calls[0].function.arguments, "string");
  assert.equal(bodies[0].messages[0].tool_calls[0].function.arguments, "{\"path\":\"README.md\"}");
  assert.equal(typeof bodies[0].messages[2].tool_calls[0].function.arguments, "string");
  assert.equal(bodies[0].messages[2].tool_calls[0].function.arguments, "{\"path\":\".\"}");
});

test("OpenAI-compatible Rust proxy attaches required tool_choice when requested", async () => {
  const listeners = new Map();
  const bodies = [];
  const listenMock = async (eventName, handler) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  };
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "start_chat_stream");
    bodies.push(JSON.parse(args.body));
    const streamId = args.streamId;
    queueMicrotask(() => {
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        },
      });
      listeners.get("chat-stream-done")?.({
        payload: {
          stream_id: streamId,
          status: "success",
        },
      });
    });
    return undefined;
  }, listenMock);

  const result = await streamChatCompletion(
    [{ role: "user", content: "请直接修改文件" }],
    {
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "local",
      model: "Qwen-local",
      apiProtocol: "openai",
      apiFormat: "chat_completions",
      provider: "OMLX",
      useRustProxy: true,
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
    undefined,
    [{
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply a patch",
        parameters: {
          type: "object",
          properties: { patch: { type: "string" } },
          required: ["patch"],
        },
      },
    }],
    4096,
    { toolChoice: "required" },
  );

  assert.equal(result.content, "ok");
  assert.equal(bodies[0].tool_choice, "required");
  assert.equal(bodies[0].tools[0].function.name, "apply_patch");
});

test("local Rust stream read errors fall back to a non-streaming request", async () => {
  const listeners = new Map();
  const invokeCalls = [];
  const listenMock = async (eventName, handler) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  };
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    invokeCalls.push({ command, args });
    if (command === "start_chat_stream") {
      const streamId = args.streamId;
      queueMicrotask(() => {
        listeners.get("chat-stream-chunk")?.({
          payload: {
            stream_id: streamId,
            chunk: 'data: {"choices":[{"delta":{"content":"partial "}}]}\n\n',
          },
        });
        listeners.get("chat-stream-done")?.({
          payload: {
            stream_id: streamId,
            status: "error",
            error: "流读取错误: error decoding response body",
          },
        });
      });
      return undefined;
    }
    if (command === "proxy_request") {
      const body = JSON.parse(args.body);
      assert.equal(body.stream, false);
      assert.equal(args.url, "http://127.0.0.1:1234/v1/chat/completions");
      assert.deepEqual(body.messages[0].content, [
        { type: "text", text: "继续检查截图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,FALLBACK" } },
      ]);
      return JSON.stringify({
        choices: [
          {
            message: { content: "fallback ok" },
            finish_reason: "stop",
          },
        ],
      });
    }
    throw new Error(`Unexpected command: ${command}`);
  }, listenMock);

  const tokens = [];
  const errors = [];
  let doneCount = 0;
  const result = await streamChatCompletion(
    [{
      role: "user",
      content: [
        { type: "text", text: "继续检查截图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,FALLBACK" } },
      ],
    }],
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "not-needed",
      model: "local-model",
      provider: "LM Studio",
      useRustProxy: true,
    },
    {
      onToken: (token) => tokens.push(token),
      onDone: () => { doneCount += 1; },
      onError: (error) => { errors.push(error.message); },
    },
  );

  assert.equal(result.content, "fallback ok");
  assert.deepEqual(tokens, ["partial ", "__ESCALATION_RESET__:", "fallback ok"]);
  assert.deepEqual(errors, []);
  assert.equal(doneCount, 1);
  assert.deepEqual(result.visualTransportReceipt, {
    protocol: "openai_chat_completions",
    requestAccepted: true,
    logicalImageParts: 1,
    serializedImageParts: 1,
    omittedImageParts: 0,
  });
  assert.deepEqual(invokeCalls.map((call) => call.command), ["start_chat_stream", "proxy_request"]);
});

test("Ollama frontend Load failed retries through the Rust stream proxy", async () => {
  const listeners = new Map();
  const invokeCalls = [];
  const listenMock = async (eventName, handler) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  };
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    invokeCalls.push({ command, args });
    assert.equal(command, "start_chat_stream");
    assert.equal(args.url, "http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(args.body);
    assert.equal(body.model, "gemma4:31b-mlx");
    assert.equal(body.stream, true);
    assert.equal(args.headers.Authorization, undefined);
    const streamId = args.streamId;
    queueMicrotask(() => {
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: "{\"message\":{\"content\":\"pong\"},\"done\":false}\n",
        },
      });
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: "{\"done\":true}\n",
        },
      });
      listeners.get("chat-stream-done")?.({
        payload: {
          stream_id: streamId,
          status: "ok",
          error: null,
        },
      });
    });
    return undefined;
  }, listenMock);

  const originalFetch = globalThis.fetch;
  const fetchUrls = [];
  globalThis.fetch = async (url) => {
    fetchUrls.push(String(url));
    throw new TypeError("Load failed");
  };

  const tokens = [];
  const errors = [];
  const lifecycle = [];
  let doneCount = 0;
  try {
    const result = await streamChatCompletion(
      [{ role: "user", content: "ping" }],
      {
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "not-needed",
        model: "gemma4:31b-mlx",
        provider: "Ollama",
        useRustProxy: false,
      },
      {
        onToken: (token) => tokens.push(token),
        onDone: () => { doneCount += 1; },
        onError: (error) => { errors.push(error.message); },
        onLifecycle: (event) => { lifecycle.push(event); },
      },
    );

    assert.equal(result.content, "pong");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(fetchUrls, ["http://127.0.0.1:11434/api/chat"]);
  assert.deepEqual(tokens, ["pong"]);
  assert.deepEqual(errors, []);
  assert.equal(doneCount, 1);
  assert.deepEqual(invokeCalls.map((call) => call.command), ["start_chat_stream"]);
  assert.equal(lifecycle.some((event) => event.status === "frontend_transport_retry_rust_proxy"), true);
});

test("local Rust streams convert cumulative text payloads into visible deltas", async () => {
  const listeners = new Map();
  const invokeCalls = [];
  const listenMock = async (eventName, handler) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  };
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    invokeCalls.push({ command, args });
    assert.equal(command, "start_chat_stream");
    const streamId = args.streamId;
    queueMicrotask(() => {
      for (const text of ["A", "AB", "ABC"]) {
        listeners.get("chat-stream-chunk")?.({
          payload: {
            stream_id: streamId,
            chunk: `data: ${JSON.stringify({ text })}\n\n`,
          },
        });
      }
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: "data: [DONE]\n\n",
        },
      });
      listeners.get("chat-stream-done")?.({
        payload: {
          stream_id: streamId,
          status: "success",
        },
      });
    });
    return undefined;
  }, listenMock);

  const tokens = [];
  let doneCount = 0;
  const result = await streamChatCompletion(
    [{ role: "user", content: "继续" }],
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "not-needed",
      model: "local-model",
      provider: "LM Studio",
      useRustProxy: true,
    },
    {
      onToken: (token) => tokens.push(token),
      onDone: () => { doneCount += 1; },
      onError: (error) => { throw error; },
    },
  );

  assert.equal(result.content, "ABC");
  assert.deepEqual(tokens, ["A", "B", "C"]);
  assert.equal(doneCount, 1);
  assert.deepEqual(invokeCalls.map((call) => call.command), ["start_chat_stream"]);
});

test("local Rust streams store cumulative reasoning payloads as hidden metadata", async () => {
  const listeners = new Map();
  const listenMock = async (eventName, handler) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  };
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "start_chat_stream");
    const streamId = args.streamId;
    queueMicrotask(() => {
      for (const reasoning_content of ["A", "AB", "ABC"]) {
        listeners.get("chat-stream-chunk")?.({
          payload: {
            stream_id: streamId,
            chunk: `data: ${JSON.stringify({ choices: [{ message: { reasoning_content } }] })}\n\n`,
          },
        });
      }
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: `data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}\n\n`,
        },
      });
      listeners.get("chat-stream-done")?.({
        payload: {
          stream_id: streamId,
          status: "success",
        },
      });
    });
    return undefined;
  }, listenMock);

  const tokens = [];
  const result = await streamChatCompletion(
    [{ role: "user", content: "继续" }],
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "not-needed",
      model: "local-model",
      provider: "LM Studio",
      useRustProxy: true,
    },
    {
      onToken: (token) => tokens.push(token),
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.equal(result.content, "done");
  assert.equal(result.reasoningContent, "ABC");
  assert.equal(result.reasoningField, "reasoning_content");
  assert.deepEqual(tokens, ["done"]);
});

test("semantic stream progress excludes hidden reasoning and tool protocol while preserving real markdown", async () => {
  const { analyzeSemanticStreamProgress } = await loadStreamingModule(async () => undefined);
  const hidden = analyzeSemanticStreamProgress({
    content: [
      `<thinking>${"内部分析。".repeat(900)}</thinking>`,
      "<tool_use>",
      "<tool>read_file</tool>",
      '<parameter name="path">src/App.tsx</parameter>',
      "</tool_use>",
    ].join("\n"),
    reasoningContent: "",
  });
  assert.equal(hidden.semanticVisibleChars, 0);
  assert.equal(hidden.semanticContent, "");
  assert.match(hidden.actionableContent, /<tool_use>/);

  const visible = analyzeSemanticStreamProgress({
    content: `${hidden.rawContent}\n\n## 可审批计划\n\n- 修改 src/App.tsx`,
    reasoningContent: "",
  });
  assert.match(visible.semanticContent, /## 可审批计划/);
  assert.equal(visible.semanticVisibleChars > 0, true);
});

test("semantic stream progress classifies exact and whitespace-normalized reasoning mirrors without leaking text", async () => {
  const { analyzeSemanticStreamProgress } = await loadStreamingModule(async () => undefined);
  const reasoning = "需要继续分析。\n".repeat(900);
  const exact = analyzeSemanticStreamProgress({
    content: reasoning,
    reasoningContent: reasoning,
  });
  assert.equal(exact.mirrorKind, "exact");
  assert.equal(exact.semanticContent, "");
  assert.equal(exact.semanticVisibleChars, 0);
  assert.equal(exact.contentHash, exact.reasoningHash);
  assert.equal(exact.overlapRatio, 1);

  const whitespaceMirror = analyzeSemanticStreamProgress({
    content: reasoning.replaceAll("\n", "  \n"),
    reasoningContent: reasoning,
  });
  assert.equal(whitespaceMirror.mirrorKind, "normalized_exact");
  assert.equal(whitespaceMirror.semanticContent, "");
  assert.equal(whitespaceMirror.semanticVisibleChars, 0);
  assert.notEqual(whitespaceMirror.contentHash, whitespaceMirror.reasoningHash);
  assert.equal(whitespaceMirror.normalizedContentHash, whitespaceMirror.normalizedReasoningHash);
});

test("semantic stream progress retains a real final suffix after a mirrored reasoning prefix", async () => {
  const { analyzeSemanticStreamProgress } = await loadStreamingModule(async () => undefined);
  const reasoning = "内部推演。".repeat(900);
  const result = analyzeSemanticStreamProgress({
    content: `${reasoning}\n\n## 最终结论\n\n- 直接修复事件参数传递。`,
    reasoningContent: reasoning,
  });
  assert.equal(result.mirrorKind, "reasoning_prefix");
  assert.doesNotMatch(result.semanticContent, /内部推演/);
  assert.match(result.semanticContent, /## 最终结论/);
  assert.equal(result.semanticVisibleChars > 0, true);
});

test("local Rust streams suppress OMLX-style recovered reasoning mirrors but keep diagnostics", async () => {
  const listeners = new Map();
  const listenMock = async (eventName, handler) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  };
  const reasoning = "未闭合的后台分析。".repeat(1200);
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "start_chat_stream");
    const streamId = args.streamId;
    queueMicrotask(() => {
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`,
        },
      });
      // oMLX ThinkingParser.finish() recovery re-emits the same unclosed
      // thinking transcript as content so generic clients do not get an
      // empty answer. MAIN must not mistake that mirror for visible progress.
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: `data: ${JSON.stringify({ choices: [{ delta: { content: reasoning }, finish_reason: "length" }] })}\n\n`,
        },
      });
      listeners.get("chat-stream-done")?.({
        payload: { stream_id: streamId, status: "success" },
      });
    });
    return undefined;
  }, listenMock);

  const tokens = [];
  const result = await streamChatCompletion(
    [{ role: "user", content: "继续" }],
    {
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "not-needed",
      model: "Qwen3.6-35B-A3B-6bit",
      provider: "OMLX",
      useRustProxy: true,
    },
    {
      onToken: (token) => tokens.push(token),
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.deepEqual(tokens, []);
  assert.equal(result.content, reasoning);
  assert.equal(result.semanticContent, "");
  assert.equal(result.reasoningContent, reasoning);
  assert.equal(result.streamDiagnostics?.mirrorKind, "exact");
  assert.equal(result.streamDiagnostics?.semanticVisibleChars, 0);
  assert.equal(result.streamDiagnostics?.rawContentChars, reasoning.length);
  assert.equal(result.streamDiagnostics?.reasoningChars, reasoning.length);
  assert.equal(result.streamDiagnostics?.contentHash, result.streamDiagnostics?.reasoningHash);
});

test("local Rust streams keep slow genuine visible output and native tool progress", async () => {
  const listeners = new Map();
  const listenMock = async (eventName, handler) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  };
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "start_chat_stream");
    const streamId = args.streamId;
    queueMicrotask(() => {
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "brief hidden analysis" } }] })}\n\n`,
        },
      });
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: `data: ${JSON.stringify({ choices: [{ delta: { content: "## 可见进展\n\n正在核对事件参数。" } }] })}\n\n`,
        },
      });
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"src/main.js"}' } }] }, finish_reason: "tool_calls" }] })}\n\n`,
        },
      });
      listeners.get("chat-stream-done")?.({
        payload: { stream_id: streamId, status: "success" },
      });
    });
    return undefined;
  }, listenMock);

  const tokens = [];
  const result = await streamChatCompletion(
    [{ role: "user", content: "继续" }],
    {
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "not-needed",
      model: "local-model",
      provider: "OMLX",
      useRustProxy: true,
    },
    {
      onToken: (token) => tokens.push(token),
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.deepEqual(tokens, ["## 可见进展\n\n正在核对事件参数。"]);
  assert.equal(result.semanticContent, "## 可见进展\n\n正在核对事件参数。");
  assert.equal(result.streamDiagnostics?.semanticVisibleChars > 0, true);
  assert.equal(result.streamDiagnostics?.firstSemanticVisibleElapsedMs != null, true);
  assert.equal(result.streamDiagnostics?.firstToolElapsedMs != null, true);
  assert.equal(result.toolCalls[0]?.name, "read_file");
});

test("reasoning does not exempt a semantically hidden stream from the no-visible timeout", async () => {
  const { shouldStopNoVisibleStreamStall } = await loadStreamingModule(async () => undefined);
  assert.equal(shouldStopNoVisibleStreamStall({
    elapsedMs: 120_000,
    visibleChars: 0,
    toolCallCount: 0,
    reasoningChars: 24_000,
  }), true);
  assert.equal(shouldStopNoVisibleStreamStall({
    elapsedMs: 240_000,
    visibleChars: 1,
    toolCallCount: 0,
    reasoningChars: 24_000,
  }), false);
  assert.equal(shouldStopNoVisibleStreamStall({
    elapsedMs: 240_000,
    visibleChars: 0,
    toolCallCount: 1,
    reasoningChars: 24_000,
  }), false);
});

test("OMLX reasoning-off requests disable thinking without leaking provider extras to unknown endpoints", async () => {
  const requests = [];
  const run = async (provider, reasoningRequest) => {
    const listeners = new Map();
    const listenMock = async (eventName, handler) => {
      listeners.set(eventName, handler);
      return () => listeners.delete(eventName);
    };
    const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
      assert.equal(command, "start_chat_stream");
      requests.push({ provider, body: JSON.parse(args.body) });
      const streamId = args.streamId;
      queueMicrotask(() => {
        listeners.get("chat-stream-chunk")?.({
          payload: {
            stream_id: streamId,
            chunk: `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
          },
        });
        listeners.get("chat-stream-done")?.({
          payload: { stream_id: streamId, status: "success" },
        });
      });
      return undefined;
    }, listenMock);
    await streamChatCompletion(
      [{ role: "user", content: "继续" }],
      {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "not-needed",
        model: "local-model",
        provider,
        reasoningRequest,
        useRustProxy: true,
      },
      { onToken: () => {}, onDone: () => {}, onError: (error) => { throw error; } },
    );
  };

  await run("OMLX", "off");
  await run("Custom Local", "off");
  await run("OMLX", "auto");

  assert.deepEqual(requests[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(requests[1].body.chat_template_kwargs, undefined);
  assert.equal(requests[2].body.chat_template_kwargs, undefined);
});

test("local Rust streams stop reasoning-only runaway output", async () => {
  const listeners = new Map();
  const invokeCalls = [];
  const listenMock = async (eventName, handler) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  };
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    invokeCalls.push(command);
    if (command === "cancel_chat_stream") return undefined;
    assert.equal(command, "start_chat_stream");
    const streamId = args.streamId;
    queueMicrotask(() => {
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: `data: ${JSON.stringify({ choices: [{ message: { reasoning_content: "loop ".repeat(22_000) } }] })}\n\n`,
        },
      });
    });
    return undefined;
  }, listenMock);

  const tokens = [];
  let doneCount = 0;
  const result = await streamChatCompletion(
    [{ role: "user", content: "继续" }],
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "not-needed",
      model: "local-model",
      provider: "LM Studio",
      useRustProxy: true,
    },
    {
      onToken: (token) => tokens.push(token),
      onDone: () => { doneCount += 1; },
      onError: (error) => { throw error; },
    },
  );

  assert.equal(result.finishReason, "length");
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.content, "");
  assert.equal(result.reasoningContent.length > 12_000, true);
  assert.deepEqual(invokeCalls, ["start_chat_stream", "cancel_chat_stream"]);
  assert.equal(doneCount, 1);
  assert.deepEqual(tokens, []);
});

test("OpenAI-compatible chat does not replay assistant reasoning_content by default", async () => {
  const listeners = new Map();
  const listenMock = async (eventName, handler) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  };
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (command, args) => {
    assert.equal(command, "start_chat_stream");
    const body = JSON.parse(args.body);
    requests.push(body);
    const streamId = args.streamId;
    queueMicrotask(() => {
      listeners.get("chat-stream-chunk")?.({
        payload: {
          stream_id: streamId,
          chunk: `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        },
      });
      listeners.get("chat-stream-done")?.({
        payload: {
          stream_id: streamId,
          status: "success",
        },
      });
    });
    return undefined;
  }, listenMock);

  const result = await streamChatCompletion(
    [
      { role: "user", content: "先读文件" },
      {
        role: "assistant",
        content: "我先读取。",
        reasoning_content: "Need to inspect the file before answering.",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"src/App.tsx\"}" },
        }],
      },
      { role: "tool", content: "ok", tool_call_id: "call_1" },
    ],
    {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      apiProtocol: "openai",
      apiFormat: "chat_completions",
      provider: "OpenAI",
      useRustProxy: true,
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.equal(result.content, "ok");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[1].reasoning_content, undefined);
  assert.equal(requests[0].messages[1].tool_calls[0].function.name, "read_file");
  assert.equal(requests[0].messages[2].reasoning_content, undefined);
});

test("OpenAI Responses retries 524 failures with aggressive compact input without reasoning", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (_command, args) => {
    const body = JSON.parse(args.body);
    requests.push(body);
    if (requests.length === 1) {
      throw new Error("HTTP 524: error code: 524");
    }
    return JSON.stringify({ output_text: "ok after fallback" });
  });

  const result = await streamChatCompletion(
    [{ role: "user", content: "生成长回答" }],
    {
      baseUrl: "https://www.aiwanwu.cc/v1",
      apiKey: "test-key",
      model: "gpt-5.5",
      apiProtocol: "openai",
      apiFormat: "responses",
      useRustProxy: true,
      reasoningEffort: "xhigh",
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.equal(result.content, "ok after fallback");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reasoning.effort, "xhigh");
  assert.equal(requests[1].reasoning, undefined);
  assert.equal(requests[1].tools, undefined);
  assert.equal(Array.isArray(requests[1].input), true);
});

test("OpenAI Responses retries 502 upstream failures with compact input", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (_command, args) => {
    const body = JSON.parse(args.body);
    requests.push(body);
    if (requests.length === 1) {
      throw new Error('HTTP 502: {"error":{"type":"upstream_error"}}');
    }
    return JSON.stringify({ output_text: "ok after upstream fallback" });
  });

  const result = await streamChatCompletion(
    [{ role: "user", content: "生成长回答" }],
    {
      baseUrl: "https://www.aiwanwu.cc/v1",
      apiKey: "test-key",
      model: "gpt-5.5",
      apiProtocol: "openai",
      apiFormat: "responses",
      useRustProxy: true,
      reasoningEffort: "xhigh",
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.equal(result.content, "ok after upstream fallback");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reasoning.effort, "xhigh");
  assert.equal(requests[1].reasoning, undefined);
  assert.equal(requests[1].tools, undefined);
  assert.equal(Array.isArray(requests[1].input), true);
});

test("OpenAI Responses falls back when a successful candidate returns empty content and no tool calls", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (_command, args) => {
    requests.push(JSON.parse(args.body));
    if (requests.length === 1) {
      return JSON.stringify({ output_text: "" });
    }
    return JSON.stringify({ output_text: "ok after empty fallback" });
  });

  const result = await streamChatCompletion(
    [{ role: "user", content: "继续执行" }],
    {
      baseUrl: "https://www.aiwanwu.cc/v1",
      apiKey: "test-key",
      model: "gpt-5.5",
      apiProtocol: "openai",
      apiFormat: "responses",
      useRustProxy: true,
      reasoningEffort: "high",
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.equal(result.content, "ok after empty fallback");
  assert.equal(requests.length >= 2, true);
});

test("OpenAI Responses throws a tagged compatibility error when every candidate is empty", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (_command, args) => {
    requests.push(JSON.parse(args.body));
    return JSON.stringify({ output_text: "" });
  });

  await assert.rejects(
    () => streamChatCompletion(
      [{ role: "user", content: "继续执行" }],
      {
        baseUrl: "https://www.aiwanwu.cc/v1",
        apiKey: "test-key",
        model: "gpt-5.5",
        apiProtocol: "openai",
        apiFormat: "responses",
        useRustProxy: true,
        reasoningEffort: "high",
      },
      {
        onToken: () => {},
        onDone: () => {},
        onError: () => {},
      },
    ),
    /responses_empty_after_fallbacks/,
  );

  assert.equal(requests.length >= 2, true);
});

test("OpenAI Responses without attached tools compacts to an explicit no-tool contract", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (_command, args) => {
    const body = JSON.parse(args.body);
    requests.push(body);
    return JSON.stringify({ output_text: "ok" });
  });

  await streamChatCompletion(
    [
      { role: "system", content: [
        "当前工作区绝对路径为：/tmp/workspace",
        "可用的工具：read_file, write_file, replace_in_file, run_command",
        "M Studio Unity 教程代码必须保留中文注释和 Region 分类。",
        "filler ".repeat(3000),
      ].join("\n") },
      { role: "user", content: "实现功能" },
    ],
    {
      baseUrl: "https://www.aiwanwu.cc/v1",
      apiKey: "test-key",
      model: "gpt-5.5",
      apiProtocol: "openai",
      apiFormat: "responses",
      useRustProxy: true,
      reasoningEffort: "xhigh",
    },
    {
      onToken: () => {},
      onDone: () => {},
      onError: (error) => { throw error; },
    },
  );

  assert.ok(requests[0].instructions.length <= 8000);
  assert.equal(requests[0].tools, undefined);
  assert.match(requests[0].instructions, /protocol=none; available=none/);
  assert.doesNotMatch(requests[0].instructions, /<tool_use>|write_file|replace_in_file|run_command/);
  assert.equal(requests[0].reasoning.effort, "xhigh");
});

test("OpenAI Responses stops after bounded structured and transcript retries when 524 persists", async () => {
  const requests = [];
  const { streamChatCompletion } = await loadStreamingModule(async (_command, args) => {
    requests.push(JSON.parse(args.body));
    throw new Error("HTTP 524: error code: 524");
  });

  await assert.rejects(
    () => streamChatCompletion(
      [{ role: "user", content: "生成长回答" }],
      {
        baseUrl: "https://www.aiwanwu.cc/v1",
        apiKey: "test-key",
        model: "gpt-5.5",
        apiProtocol: "openai",
        apiFormat: "responses",
        useRustProxy: true,
        reasoningEffort: "xhigh",
      },
      {
        onToken: () => {},
        onDone: () => {},
        onError: () => {},
      },
    ),
    /HTTP 524/,
  );

  assert.equal(requests.length, 3);
  assert.equal(requests[0].reasoning.effort, "xhigh");
  assert.equal(requests[1].reasoning, undefined);
  assert.equal(requests[1].tools, undefined);
  assert.equal(Array.isArray(requests[1].input), true);
  assert.equal(typeof requests[2].input, "string");
});
// #endregion
