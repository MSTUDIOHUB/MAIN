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
      + "data: {\"delta\":\"ok\"}\n\n";
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
      + "data: {\"delta\":\"ok\"}\n\n";
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
    [{ role: "user", content: "继续总结刚才读取的文件" }],
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
  assert.deepEqual(invokeCalls.map((call) => call.command), ["start_chat_stream", "proxy_request"]);
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

test("local Rust streams convert cumulative reasoning payloads into thinking deltas", async () => {
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

  assert.equal(result.content, "<thinking>ABC</thinking>done");
  assert.equal(result.reasoningContent, "ABC");
  assert.equal(result.reasoningField, "reasoning_content");
  assert.deepEqual(tokens, ["<thinking>", "A", "B", "C", "</thinking>", "done"]);
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
          chunk: `data: ${JSON.stringify({ choices: [{ message: { reasoning_content: "loop ".repeat(3000) } }] })}\n\n`,
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
  assert.match(result.content, /^<thinking>/);
  assert.equal(result.content.endsWith("</thinking>"), true);
  assert.equal(result.reasoningContent.length > 12_000, true);
  assert.deepEqual(invokeCalls, ["start_chat_stream", "cancel_chat_stream"]);
  assert.equal(doneCount, 1);
  assert.equal(tokens[0], "<thinking>");
});

test("OpenAI-compatible chat replays assistant reasoning_content when the provider emitted it", async () => {
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
  assert.equal(requests[0].messages[1].reasoning_content, "Need to inspect the file before answering.");
  assert.equal(requests[0].messages[1].tool_calls[0].function.name, "read_file");
  assert.equal(requests[0].messages[2].reasoning_content, undefined);
});

test("OpenAI Responses retries 524 failures with compact input while preserving reasoning effort", async () => {
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
  assert.equal(requests[1].reasoning.effort, "xhigh");
  assert.equal(typeof requests[1].input, "string");
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
  assert.equal(requests[1].reasoning.effort, "xhigh");
  assert.equal(typeof requests[1].input, "string");
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

test("OpenAI Responses sends compacted system instructions for cloud requests", async () => {
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
  assert.match(requests[0].instructions, /write_file/);
  assert.match(requests[0].instructions, /replace_in_file/);
  assert.equal(requests[0].reasoning.effort, "xhigh");
});

test("OpenAI Responses stops after one compact retry when 524 persists", async () => {
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

  assert.equal(requests.length, 2);
  assert.equal(requests[0].reasoning.effort, "xhigh");
  assert.equal(requests[1].reasoning.effort, "xhigh");
  assert.equal(typeof requests[1].input, "string");
});
// #endregion
