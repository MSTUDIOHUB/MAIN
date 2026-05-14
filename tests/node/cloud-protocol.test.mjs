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
  buildOpenAiResponsesRequestCandidates,
  buildOpenAiResponsesProbeRequestCandidates,
  ensureOpenAiChatGptCodexRequestBody,
  parseOpenAiResponsesSseText,
  buildOpenAiResponsesRequestExtras,
  buildOpenAiResponsesTranscript,
  buildGeminiGenerateContentUrl,
  buildGeminiRequestBody,
  buildGeminiRequestForAuthMode,
  extractOpenAiResponsesInstructions,
  extractGeminiResponseText,
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
  getModelInstructionProfile,
  getDefaultLocalToolProtocol,
  normalizeCloudAuthMode,
  resolveEffectiveCloudApiFormat,
  normalizeCloudToolProtocol,
  normalizeLocalToolProtocol,
  parseCloudCustomHeaders,
} = await loadCloudProtocolModule();

function loadOrchestratorModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/orchestrator.ts");
  const source = require("node:fs").readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(sourcePath);
  const runtimeRequire = (specifier) => {
    if (specifier === "@tauri-apps/api/core") return { invoke: async () => "" };
    if (specifier === "@tauri-apps/api/event") return { listen: async () => () => {} };
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(sourcePath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
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
          new Function("exports", "module", "require", nestedTranspiled)(nestedModule.exports, nestedModule, runtimeRequire);
          return nestedModule.exports;
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  return module.exports;
}

const { resolveModelProtocolProfile } = loadOrchestratorModule();

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

test("anthropic stream processor routes thinking delta through thinking tags", () => {
  const tokens = [];
  const processor = createAnthropicStreamProcessor((token) => tokens.push(token));

  processor.processChunk('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hidden"}}\n\n');
  processor.processChunk('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"visible"}}\n\n');
  processor.flush();

  const result = processor.getResult();
  assert.deepEqual(tokens, ["<thinking>", "hidden", "</thinking>", "visible"]);
  assert.equal(result.content, "<thinking>hidden</thinking>visible");
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

test("responses request builder emits deterministic store false, instructions, and native tools", () => {
  const candidates = buildOpenAiResponsesRequestCandidates({
    messages: [
      { role: "system", content: "Follow rules." },
      { role: "user", content: "Read file" },
    ],
    model: "gpt-5.4",
    disableResponseStorage: true,
    reasoningEffort: "high",
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
  });

  assert.equal(candidates[0].body.model, "gpt-5.4");
  assert.equal(candidates[0].body.instructions, "Follow rules.");
  assert.equal(candidates[0].body.store, false);
  assert.deepEqual(candidates[0].body.reasoning, { effort: "high" });
  assert.equal(candidates[0].body.tools[0].name, "read_file");
  assert.equal(candidates[2].mode, "transcript_text");
  assert.equal(candidates[2].body.tools, undefined);
});

test("cloud tool protocol and model profile helpers normalize provider behavior", () => {
  assert.equal(normalizeCloudAuthMode("openai_chatgpt_oauth"), "openai_chatgpt_oauth");
  assert.equal(normalizeCloudAuthMode("gemini_google_oauth"), "gemini_google_oauth");
  assert.equal(normalizeCloudAuthMode("bad"), "api_key");
  assert.equal(resolveEffectiveCloudApiFormat({
    protocol: "openai",
    apiFormat: "chat_completions",
    authMode: "openai_chatgpt_oauth",
  }), "responses");
  assert.equal(resolveEffectiveCloudApiFormat({
    protocol: "openai",
    apiFormat: "responses",
    authMode: "api_key",
  }), "responses");
  assert.equal(resolveEffectiveCloudApiFormat({
    protocol: "gemini",
    apiFormat: "chat_completions",
    authMode: "openai_chatgpt_oauth",
  }), "chat_completions");
  assert.equal(normalizeCloudToolProtocol("native"), "native");
  assert.equal(normalizeCloudToolProtocol("xml"), "xml");
  assert.equal(normalizeCloudToolProtocol("bad"), "auto");
  assert.equal(getDefaultLocalToolProtocol("LM Studio"), "xml");
  assert.equal(getDefaultLocalToolProtocol("Ollama"), "xml");
  assert.equal(getDefaultLocalToolProtocol("OMLX"), "auto");
  assert.equal(normalizeLocalToolProtocol(undefined, "LM Studio"), "xml");
  assert.equal(normalizeLocalToolProtocol(undefined, "Ollama"), "xml");
  assert.equal(normalizeLocalToolProtocol(undefined, "OMLX"), "auto");
  assert.equal(normalizeLocalToolProtocol("native", "LM Studio"), "native");
  assert.equal(normalizeLocalToolProtocol("xml", "OMLX"), "xml");

  assert.equal(getModelInstructionProfile({ protocol: "anthropic", model: "claude-sonnet-4-5" }).provider, "anthropic");
  assert.equal(getModelInstructionProfile({ protocol: "openai", model: "qwen3-coder" }).reasoning, "tagged");
  assert.equal(getModelInstructionProfile({ protocol: "openai", model: "kimi-k2" }).toolProtocolPreference, "xml");
  assert.equal(getModelInstructionProfile({ protocol: "gemini", model: "gemini-2.5-pro" }).toolProtocolPreference, "xml");
});

test("model protocol profile covers local and cloud providers", () => {
  assert.equal(resolveModelProtocolProfile({
    activeProfile: "local",
    provider: "Ollama",
    model: "qwen3",
    configuredToolProtocol: "auto",
  }).toolProtocol, "xml");

  assert.equal(resolveModelProtocolProfile({
    activeProfile: "local",
    provider: "OMLX",
    model: "mlx-qwen",
    configuredToolProtocol: "auto",
  }).toolProtocol, "auto");

  assert.equal(resolveModelProtocolProfile({
    activeProfile: "cloud",
    provider: "OpenAI",
    model: "gpt-5.4",
    protocol: "openai",
    configuredToolProtocol: "auto",
  }).toolProtocol, "auto");

  assert.equal(resolveModelProtocolProfile({
    activeProfile: "cloud",
    provider: "Gemini",
    model: "gemini-2.5-pro",
    protocol: "gemini",
    configuredToolProtocol: "auto",
  }).toolProtocol, "xml");
});

test("gemini helpers build native generateContent requests and extract text", () => {
  const body = buildGeminiRequestBody({
    messages: [
      { role: "system", content: "Follow repo rules." },
      { role: "user", content: "Say ok" },
      { role: "assistant", content: "ok" },
    ],
    model: "gemini-2.5-pro",
    maxTokens: 64,
  });

  assert.equal(body.systemInstruction.parts[0].text, "Follow repo rules.");
  assert.equal(body.contents[0].role, "user");
  assert.equal(body.contents[1].role, "model");
  assert.equal(body.generationConfig.maxOutputTokens, 64);
  assert.equal(
    buildGeminiGenerateContentUrl("https://generativelanguage.googleapis.com", "models/gemini-2.5-pro"),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
  );
  assert.equal(
    extractGeminiResponseText({ candidates: [{ content: { parts: [{ text: "o" }, { text: "k" }] } }] }),
    "ok",
  );
  assert.equal(
    extractGeminiResponseText({ response: { candidates: [{ content: { parts: [{ text: "oauth ok" }] } }] } }),
    "oauth ok",
  );
  const oauthRequest = buildGeminiRequestForAuthMode("https://generativelanguage.googleapis.com", {
    messages: [{ role: "user", content: "Say ok" }],
    model: "models/gemini-2.5-pro",
    maxTokens: 64,
    projectId: "mock-code-assist-project",
  }, "gemini_google_oauth");
  assert.equal(oauthRequest.url, "https://cloudcode-pa.googleapis.com/v1internal:generateContent");
  assert.equal(oauthRequest.body.model, "gemini-2.5-pro");
  assert.equal(oauthRequest.body.project, "mock-code-assist-project");
  assert.equal(typeof oauthRequest.body.user_prompt_id, "string");
  assert.equal(oauthRequest.body.user_prompt_id.startsWith("main-"), true);
  assert.equal(oauthRequest.body.request.contents[0].parts[0].text, "Say ok");
  assert.equal(oauthRequest.body.request.generationConfig.maxOutputTokens, 64);
  assert.equal(oauthRequest.body.request.generationConfig.temperature, undefined);
  assert.equal(oauthRequest.body.request.generationConfig.topP, undefined);
});

test("cloud headers support Gemini API key and OAuth bearer modes", () => {
  assert.deepEqual(
    buildCloudHeaders("gemini", "api-key", true, undefined, "api_key"),
    { "Content-Type": "application/json", "x-goog-api-key": "api-key" },
  );
  assert.deepEqual(
    buildCloudHeaders("gemini", "access-token", true, undefined, "gemini_google_oauth"),
    { "Content-Type": "application/json", Authorization: "Bearer access-token" },
  );
});

test("OpenAI ChatGPT OAuth headers omit regular API key credentials", () => {
  assert.deepEqual(
    buildCloudHeaders("openai", "dummy-key", true, undefined, "openai_chatgpt_oauth"),
    { "Content-Type": "application/json" },
  );
});

test("responses probe helpers keep base probes minimal and advanced probes explicit", () => {
  const messages = [{ role: "user", content: "Ping" }];

  const baseCandidates = buildOpenAiResponsesProbeRequestCandidates({
    messages,
    model: "gpt-5.4",
    includeAdvanced: false,
    disableResponseStorage: true,
    reasoningEffort: "xhigh",
  });

  assert.equal(baseCandidates[0].mode, "transcript_text");
  assert.equal(baseCandidates[0].body.model, "gpt-5.4");
  assert.equal(baseCandidates[0].body.stream, false);
  assert.equal(baseCandidates[0].body.store, undefined);
  assert.equal(baseCandidates[0].body.reasoning, undefined);
  assert.equal(typeof baseCandidates[0].body.input, "string");

  const advancedCandidates = buildOpenAiResponsesProbeRequestCandidates({
    messages,
    model: "gpt-5.4",
    includeAdvanced: true,
    disableResponseStorage: true,
    reasoningEffort: "xhigh",
  });

  assert.equal(advancedCandidates[0].mode, "transcript_text");
  assert.equal(advancedCandidates[0].body.store, false);
  assert.deepEqual(advancedCandidates[0].body.reasoning, { effort: "xhigh" });

  const chatGptCandidates = buildOpenAiResponsesProbeRequestCandidates({
    messages,
    model: "gpt-5.4-mini",
    includeAdvanced: false,
    authMode: "openai_chatgpt_oauth",
  });
  assert.equal(chatGptCandidates[0].mode, "input_text_array");
  assert.equal(Array.isArray(chatGptCandidates[0].body.input), true);
  assert.equal(chatGptCandidates[0].body.input[0].content[0].type, "input_text");
  assert.equal(chatGptCandidates[0].body.user_prompt_id, "main-cloud-test");
});

test("ChatGPT OAuth Codex request helper adds required stream instructions and store false", () => {
  const body = ensureOpenAiChatGptCodexRequestBody({
    model: "gpt-5.4-mini",
    input: [{ role: "user", content: [{ type: "input_text", text: "ok" }] }],
  });

  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(typeof body.instructions, "string");
  assert.equal(body.instructions.length > 0, true);
  assert.equal(body.user_prompt_id, "main-cloud-test");
});

test("Responses SSE parser aggregates output text deltas", () => {
  const text = parseOpenAiResponsesSseText([
    "event: response.output_text.delta",
    "data: {\"delta\":\"o\"}",
    "",
    "event: response.output_text.delta",
    "data: {\"delta\":\"k\"}",
    "",
    "event: response.completed",
    "data: {\"output_text\":\"!\"}",
    "",
  ].join("\n"));

  assert.equal(text, "ok!");
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
  assert.match(compacted[1].content, /ContextMemoryState v1/);
  assert.match(compacted[2].content, /older non-pinned messages compacted/);
  assert.ok(compacted.length < messages.length);
  assert.match(compacted[compacted.length - 1].content, /message 11/);
});

test("cloud responses compact messages preserve explicit ContextState outside omitted summary", () => {
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "[System: ContextState\nContextMemoryState v1 id=test updatedAt=1\nLatest user request: fix Snake compile errors\nHard constraints:\n- preserve current files\n]" },
    ...Array.from({ length: 18 }, (_, index) => ({
      role: index % 3 === 0 ? "tool" : index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(900)}`,
    })),
  ];

  const compacted = compactCloudResponsesMessages(messages, { maxInputMessages: 10 });
  const memory = compacted.find((message) => String(message.content).includes("ContextMemoryState v1"));
  const summary = compacted.find((message) => String(message.content).includes("Cloud history summary"));

  assert.ok(memory, "expected pinned ContextState memory");
  assert.match(String(memory?.content || ""), /fix Snake compile errors/);
  assert.ok(summary, "expected old history summary");
  assert.doesNotMatch(String(summary?.content || ""), /ContextMemoryState v1/);
});

test("cloud responses compact messages keep small read_file tool content", () => {
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "请读取外部日志 /tmp/e2e-outside-main-debug.log。" },
    { role: "assistant", content: "" },
    {
      role: "tool",
      tool_call_id: "text_call_1",
      content: [
        "[MAIN_TOOL_FEEDBACK_V1]{\"version\":1,\"status\":\"completed\",\"tool_call_id\":\"text_call_1\",\"tool\":\"read_file\",\"target\":\"/tmp/e2e-outside-main-debug.log\",\"summary\":\"READ_FILE_RESULT path: .MAIN-chat-attachments/outside-main-debug.log truncated: false totalLines: 1 totalChars: 34 returnedLines: 1-1 returnedChars: 34 note: read_file returns a bounded content window for large or ranged reads.\"}",
        "READ_FILE_RESULT",
        "path: .MAIN-chat-attachments/outside-main-debug.log",
        "truncated: false",
        "totalLines: 1",
        "totalChars: 34",
        "returnedLines: 1-1",
        "returnedChars: 34",
        "note: read_file returns a bounded content window for large or ranged reads. For more source, call read_file with start_line/end_line/max_lines; do not use run_command merely to page file contents.",
        "---CONTENT START---",
        "LOCAL_FILE_READ_OK: debug log line",
        "---CONTENT END---",
      ].join("\n"),
    },
  ];

  const compacted = compactCloudResponsesMessages(messages);
  const toolMessage = compacted.find((message) => message.role === "tool");

  assert.ok(toolMessage, "expected compacted tool message");
  assert.match(String(toolMessage.content || ""), /LOCAL_FILE_READ_OK/);
});

test("responses compact transcript fallback keeps pinned ContextState memory", () => {
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "[System: ContextState\nContextMemoryState v1 id=test updatedAt=1\nLatest user request: continue Game Studio task\n]" },
    ...Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `history ${index} ${"x".repeat(700)}`,
    })),
  ];

  const candidates = buildOpenAiResponsesRequestCandidates({
    messages,
    model: "gpt-5.5",
    compact: true,
    includeTools: false,
  });
  const transcript = candidates.find((candidate) => candidate.mode === "transcript_text");

  assert.equal(typeof transcript?.body.input, "string");
  assert.match(String(transcript?.body.input || ""), /ContextMemoryState v1/);
  assert.match(String(transcript?.body.input || ""), /continue Game Studio task/);
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
