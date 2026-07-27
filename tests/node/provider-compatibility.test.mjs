import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const providerCompatibility = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/providerCompatibility.ts"));
const toolFeedbackEnvelope = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolFeedbackEnvelope.ts"));

const {
  NATIVE_TOOL_HISTORY_RESULT_BUDGET_CHARS,
  buildProviderCompatibilitySystemMessage,
  buildCompatibilityRetryMessages,
  buildTranscriptCompatibilityRetryMessages,
  ensureProviderCompatibilityMode,
  isolateNativeToolHistoryForActiveSurface,
  isProviderCompatibilityErrorMessage,
  isProviderImageContentCompatibilityErrorMessage,
  isNativeToolCompatibilityErrorMessage,
  isRequiredToolChoiceCompatibilityErrorMessage,
} = providerCompatibility;

const { TOOL_FEEDBACK_ENVELOPE_PREFIX, formatToolFeedbackEnvelope } = toolFeedbackEnvelope;

const readFileTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read one workspace file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative path." } },
      required: ["path"],
    },
  },
};

const writeFileTool = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write one workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
    },
  },
};

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
    isProviderCompatibilityErrorMessage('HTTP 400 Bad Request: {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API.","type":"invalid_request_error"}}'),
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
  assert.equal(
    isProviderImageContentCompatibilityErrorMessage('HTTP 400 Bad Request: {"error":{"message":"Unsupported image_url content type"}}'),
    true,
  );
  assert.equal(
    isProviderImageContentCompatibilityErrorMessage('HTTP 400: invalid tools payload'),
    false,
  );
});

test("required tool_choice incompatibility is classified without disabling native tools", () => {
  const thinkingModeError =
    "InternalError.Algo.InvalidParameter: The tool_choice parameter does not support being set to required or object in thinking mode";
  assert.equal(
    isRequiredToolChoiceCompatibilityErrorMessage(thinkingModeError),
    true,
  );
  assert.equal(
    isRequiredToolChoiceCompatibilityErrorMessage(
      "HTTP 400: Invalid value 'required' for tool choice; supported values are none and auto",
    ),
    true,
  );
  assert.equal(
    isRequiredToolChoiceCompatibilityErrorMessage(
      "HTTP 400: unsupported parameter: tools",
    ),
    false,
  );
  assert.equal(
    isProviderCompatibilityErrorMessage(thinkingModeError),
    false,
    "a narrow tool_choice miss must not enter the broad XML transport fallback",
  );
  assert.equal(
    isProviderCompatibilityErrorMessage(
      'HTTP 400: {"type":"invalid_request_error","message":"temperature is out of range"}',
    ),
    false,
    "an error type alone is not evidence of a message/tool protocol incompatibility",
  );
});

test("narrowed native surfaces flatten stale historical calls but retain native tools", () => {
  const original = [
    { role: "system", content: "Use the active tool catalog." },
    { role: "user", content: "Fix the editor." },
    {
      role: "assistant",
      content: "I will search first.",
      tool_calls: [{
        id: "call-search",
        type: "function",
        function: { name: "grep_search", arguments: '{"query":"unsaved"}' },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call-search",
      content: "0 matches",
    },
  ];
  const isolated = isolateNativeToolHistoryForActiveSurface(
    original,
    ["apply_patch", "replace_in_file", "write_file"],
  );

  assert.equal(isolated.changed, true);
  assert.deepEqual(isolated.isolatedToolNames, ["grep_search"]);
  assert.equal(isolated.messages.some((message) => message.role === "tool"), false);
  assert.equal(
    isolated.messages.some((message) => Array.isArray(message.tool_calls)),
    false,
  );
  assert.match(isolated.messages[2].content, /Historical tool calls: grep_search/);
  assert.match(isolated.messages[3].content, /Historical tool result: grep_search/);
  assert.match(isolated.messages[3].content, /0 matches/);

  const unchanged = isolateNativeToolHistoryForActiveSurface(
    original,
    ["grep_search", "apply_patch"],
  );
  assert.equal(unchanged.changed, false);
  assert.strictEqual(unchanged.messages, original);
});

test("narrowed native history keeps newest evidence under a fixed request budget", () => {
  const messages = [{ role: "user", content: "Repair the current validation failure." }];
  for (let index = 0; index < 8; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: `call-${index}`,
        type: "function",
        function: { name: "grep_search", arguments: `{"query":"q-${index}"}` },
      }],
    });
    messages.push({
      role: "tool",
      tool_call_id: `call-${index}`,
      content: `result-${index}-head\n${"x".repeat(9_000)}\nresult-${index}-tail`,
    });
  }
  const isolated = isolateNativeToolHistoryForActiveSurface(
    messages,
    ["apply_patch"],
  );
  const historicalResultText = isolated.messages
    .filter((message) => message.role === "user" &&
      String(message.content || "").includes("[Historical tool result"))
    .map((message) => String(message.content || ""))
    .join("\n");

  assert.equal(isolated.changed, true);
  assert.ok(
    historicalResultText.length < NATIVE_TOOL_HISTORY_RESULT_BUDGET_CHARS + 2_000,
    `isolated result history should be bounded, received ${historicalResultText.length} chars`,
  );
  assert.match(historicalResultText, /historical result compacted|Historical tool result omitted/);
  assert.match(historicalResultText, /result-7-tail/);
});

test("provider compatibility prompt derives its XML catalog from the active edit schemas", () => {
  const message = buildProviderCompatibilitySystemMessage("edit", [writeFileTool]);

  assert.equal(message.role, "system");
  assert.match(message.content, /protocol=xml-text/);
  assert.match(message.content, /write_file\(path: string, content: string\)/);
  assert.match(message.content, /<tool>write_file<\/tool>/);
  assert.doesNotMatch(message.content, /replace_in_file|run_command|browser_evaluate|read_file/);
});

test("provider compatibility replaces a native tool card instead of appending a conflicting catalog", () => {
  const messages = ensureProviderCompatibilityMode([{
    role: "system",
    content: [
      "[ROLE]",
      "Work on the request.",
      "",
      "[TOOLS]",
      "profile=cloud/openai; protocol=native; available=write_file, run_command.",
      "Call native tools directly and do not emit XML.",
      "",
      "[COMPLETION]",
      "Use real evidence.",
    ].join("\n"),
  }], "edit", [writeFileTool]);

  const text = messages.map((message) => String(message.content || "")).join("\n");
  assert.equal((text.match(/\[TOOLS\]/g) || []).length, 1);
  assert.match(text, /protocol=xml-text/);
  assert.doesNotMatch(text, /protocol=native|run_command|do not emit XML/i);
  assert.match(text, /\[ROLE\][\s\S]*\[COMPLETION\]/);
});

test("Plan native fallback atomically replaces the authoring card with its text transport twin", () => {
  const nativePlanCard = [
    "[PLAN AUTHORING CONTRACT]",
    "version=1; id=plan-contract; stage=revise; runtimePhase=needs_rewrite.",
    "Submission transport: native tool submit_plan_candidate.",
    "Call `submit_plan_candidate` exactly once and do not emit `<plan_candidate>`.",
    "[/PLAN AUTHORING CONTRACT]",
  ].join("\n");
  const textPlanCard = [
    "[PLAN AUTHORING CONTRACT]",
    "version=1; id=plan-contract; stage=revise; runtimePhase=needs_rewrite.",
    "Submission transport: text envelope <plan_candidate>.",
    "Emit exactly one complete `<plan_candidate>` and no surrounding prose.",
    "[/PLAN AUTHORING CONTRACT]",
  ].join("\n");

  const messages = ensureProviderCompatibilityMode([{
    role: "system",
    content: nativePlanCard,
  }], "plan", [], {
    replacementPlanAuthoringContract: textPlanCard,
  });
  const text = messages.map((message) => String(message.content || "")).join("\n");

  assert.equal((text.match(/\[PLAN AUTHORING CONTRACT\]/g) || []).length, 1);
  assert.equal((text.match(/\[\/PLAN AUTHORING CONTRACT\]/g) || []).length, 1);
  assert.match(text, /Submission transport: text envelope <plan_candidate>/);
  assert.doesNotMatch(text, /native tool submit_plan_candidate|Call `submit_plan_candidate`/);
  assert.match(text, /native_tools_disabled=true/);
});

test("XML tool compatibility preserves multimodal user content while flattening tool history", () => {
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
      reasoning_content: "Need to inspect before answering.",
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
  assert.equal(Array.isArray(messages[0].content), true);
  assert.equal(messages[0].content[0].text, "请看截图");
  assert.equal(messages[0].content[1].type, "image_url");
  assert.equal(messages[0].content[1].image_url.url, "data:image/png;base64,abc");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "我先检查文件。");
  assert.equal(messages[1].reasoning_content, undefined);
  assert.equal(messages[2].role, "user");
  assert.match(messages[2].content, /\[Tool result\]/);
});

test("explicit image incompatibility omits images with structured unsupported state", () => {
  const [message] = buildCompatibilityRetryMessages([{
    role: "user",
    runtimeTurnId: "turn-image-owner",
    runtimeVisualImageParts: 1,
    runtimeVisualPayloadDigest: "digest-image-owner",
    content: [
      { type: "text", text: "Inspect the screenshot" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ],
  }], { imageHandling: "omit_unsupported" });

  assert.equal(message.role, "user");
  assert.equal(typeof message.content, "string");
  assert.match(message.content, /\[visual_context_omission\]/);
  assert.match(message.content, /status: provider_unsupported/);
  assert.match(message.content, /imageCount: 1/);
  assert.match(message.content, /Do not infer or claim visual details/);
  assert.doesNotMatch(message.content, /data:image/);
  assert.equal(message.runtimeTurnId, "turn-image-owner");
  assert.equal(message.runtimeVisualImageParts, 1);
  assert.equal(message.runtimeVisualPayloadDigest, "digest-image-owner");
});

test("transcript compatibility retry collapses history into one plain-text user message", () => {
  const messages = buildTranscriptCompatibilityRetryMessages([
    { role: "system", content: "You are helpful." },
    { role: "user", content: [
      { type: "text", text: "帮我读一下 src/App.tsx 和截图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ] },
    { role: "assistant", content: "我先检查。" },
    { role: "tool", content: "{\"ok\":true}" },
  ], "edit", [readFileTool]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content, /transcript_mode=true/);
  assert.match(messages[0].content, /\[Conversation Transcript\]/);
  assert.match(messages[0].content, /\[System 1\]/);
  assert.match(messages[0].content, /\[User 2\]/);
  assert.match(messages[0].content, /\[Assistant 3\]/);
  assert.match(messages[0].content, /\[User 4\]/);
  assert.match(messages[0].content, /read_file\(path: string\)/);
  assert.match(messages[0].content, /emit only one XML call from the active catalog/);
  assert.doesNotMatch(messages[0].content, /write_file|replace_in_file|run_command/);
  assert.match(messages[0].content, /status: provider_unsupported/);
  assert.match(messages[0].content, /imageCount: 1/);
});

test("compatibility retry preserves v1 envelope header for tool messages", () => {
  const enveloped = formatToolFeedbackEnvelope({
    status: "blocked",
    toolCallId: "call_9",
    tool: "write_file",
    target: "src/App.tsx",
    content: "Error: PLAN_STAGE_BLOCKED",
  });
  const retried = buildCompatibilityRetryMessages([
    {
      role: "tool",
      content: enveloped,
      tool_call_id: "call_9",
    },
  ]);

  assert.equal(retried.length, 1);
  assert.equal(retried[0].role, "user");
  assert.match(retried[0].content, /\[Tool result\]:/);
  assert.match(retried[0].content, new RegExp(`\\${TOOL_FEEDBACK_ENVELOPE_PREFIX}\\{\"version\":1,\"status\":\"blocked\"`));
  assert.match(retried[0].content, /PLAN_STAGE_BLOCKED/);
});

test("XML compatibility preserves exact read_file windows beyond the generic 800 character cap", () => {
  const exactRead = [
    "READ_FILE_RESULT",
    "path: src/App.tsx",
    "---CONTENT START---",
    "x".repeat(1_200),
    "TAIL_MARKER_REQUIRED_FOR_PATCH",
    "---CONTENT END---",
  ].join("\n");
  const enveloped = formatToolFeedbackEnvelope({
    status: "completed",
    toolCallId: "call_read_long",
    tool: "read_file",
    target: "src/App.tsx",
    content: exactRead,
  });

  const [converted] = buildCompatibilityRetryMessages([{
    role: "tool",
    content: enveloped,
    tool_call_id: "call_read_long",
  }]);

  assert.equal(converted.role, "user");
  assert.equal(converted.content.includes(exactRead), true);
  assert.match(converted.content, /TAIL_MARKER_REQUIRED_FOR_PATCH/);

  const legacyConverted = buildCompatibilityRetryMessages([
    {
      role: "assistant",
      content: "Inspecting source.",
      tool_calls: [{
        id: "call_legacy_read",
        type: "function",
        function: { name: "read_file", arguments: "{\"path\":\"src/App.tsx\"}" },
      }],
    },
    {
      role: "tool",
      content: exactRead,
      tool_call_id: "call_legacy_read",
    },
  ]);
  assert.equal(legacyConverted[1].content.includes(exactRead), true);
});
