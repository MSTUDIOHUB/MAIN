import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

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

const {
  normalizeMarkdownForDisplay,
  markdownTableToTsv,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/markdownDisplay.ts"));

const {
  classifyChatError,
  getChatFeedbackStatusCopy,
  normalizeChatFeedbackStatus,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/chatFeedback.ts"));

const {
  sanitizeAIOutput,
  sanitizeAssistantDisplayContent,
  sanitizeVisibleAssistantText,
  stripReasoningBlocks,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/sanitize.ts"));

const {
  normalizeAssistantTurn,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/normalizedTurn.ts"));

const {
  resolveStreamingAssistantDisplay,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/streamDisplayPolicy.ts"));

const {
  getDisplayAgentContent,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/chat/chatContentPreview.ts"));

const {
  shouldSuppressAgentToolEcho,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/chat/chatBlockVisibility.ts"));

const {
  buildReadContextEntries,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/chat/chatRenderItems.ts"));

const {
  buildToolExecutionSummary,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/chat/chatToolSummary.ts"));

test("markdown display strips unsafe html and normalizes math and alerts", () => {
  const normalized = normalizeMarkdownForDisplay([
    "第一行",
    "第二行",
    "<script>alert(1)</script>",
    "<iframe src=\"https://example.com\"></iframe>",
    "$$",
    "E = mc^2",
    "$$",
    "内联公式 \\(x^2 + y^2\\)。",
    "> [!WARNING]",
    "> 注意风险",
  ].join("\n"));

  assert.doesNotMatch(normalized, /script|iframe/i);
  assert.match(normalized, /第一行第二行/);
  assert.match(normalized, /```math\nE = mc\^2\n```/);
  assert.match(normalized, /`math:x\^2 \+ y\^2`/);
  assert.match(normalized, /> \*\*WARNING\*\*/);
});

test("markdown math transform does not touch fenced code", () => {
  const normalized = normalizeMarkdownForDisplay([
    "```html",
    "<script>demo()</script>",
    "```",
    "```ts",
    "const price = \"$5\";",
    "const formula = \"\\(x^2\\)\";",
    "```",
  ].join("\n"));

  assert.match(normalized, /<script>demo\(\)<\/script>/);
  assert.match(normalized, /const price = "\$5";/);
  assert.match(normalized, /const formula = "\\\(x\^2\\\)";/);
  assert.doesNotMatch(normalized, /math:/);
});

test("markdown table copies as tsv without separator rows", () => {
  const tsv = markdownTableToTsv([
    "| 文件 | 状态 |",
    "| --- | --- |",
    "| src/App.tsx | 已读 |",
    "| a\\|b | done |",
  ].join("\n"));

  assert.equal(tsv, "文件\t状态\nsrc/App.tsx\t已读\na|b\tdone");
});

test("markdown display preserves regular GFM tables for PlanPanel rendering", () => {
  const normalized = normalizeMarkdownForDisplay([
    "## 验证矩阵",
    "",
    "| 模式 | 期望 |",
    "| --- | --- |",
    "| dark | 表格文字可见 |",
    "| light | 表格边框可见 |",
  ].join("\n"));

  assert.match(normalized, /\| 模式 \| 期望 \|/);
  assert.match(normalized, /\| dark \| 表格文字可见 \|/);
  assert.doesNotMatch(normalized, /- \| 模式/);
});

test("markdown display repairs bullet-prefixed GFM tables", () => {
  const normalized = normalizeMarkdownForDisplay([
    "## 关键改动",
    "- | 取舍点 | 选择 | 理由 |",
    "- |--------|------|------|",
    "- | 深色模式方案 | 使用 CSS 变量 + 主题切换 | 可维护性好 |",
    "- 普通列表项保留为列表。",
  ].join("\n"));

  assert.match(normalized, /\n\| 取舍点 \| 选择 \| 理由 \|/);
  assert.match(normalized, /\n\|--------\|------\|------\|/);
  assert.doesNotMatch(normalized, /- \| 取舍点/);
  assert.match(normalized, /- 普通列表项保留为列表。/);
});

test("chat content preview returns bounded agent text with truncation metadata", () => {
  const preview = getDisplayAgentContent("abcdef", false, 3);

  assert.equal(preview.content, "abc");
  assert.equal(preview.truncated, true);
  assert.equal(preview.hiddenChars, 3);
  assert.deepEqual(getDisplayAgentContent("abcdef", true, 3), {
    content: "abcdef",
    truncated: false,
    hiddenChars: 0,
  });
});

test("chat visibility suppresses thin agent echoes of nearby tool output", () => {
  const blocks = [
    {
      type: "tool",
      toolName: "read_file",
      toolStatus: "executed",
      target: "src/components/ChatArea.tsx",
      observationSummary: "Read complete src/components/ChatArea.tsx for context.",
    },
    {
      type: "agent",
      content: "Read complete src/components/ChatArea.tsx for context.",
    },
  ];

  assert.equal(shouldSuppressAgentToolEcho(blocks, 1), true);
});

test("chat visibility keeps a substantive stage summary that adds meaning to tool output", () => {
  const blocks = [
    {
      type: "tool",
      toolName: "execute_command",
      toolStatus: "executed",
      target: "npm test",
      observationSummary: "TypeError: canvasSize is missing from SnakeData.",
    },
    {
      type: "agent",
      content: [
        "阶段性结论：TypeError: canvasSize is missing from SnakeData.",
        "根因是数据模型没有声明控制器依赖的 canvasSize 字段，而不是测试环境失效。",
        "修复方案是补齐模型字段后重新运行编译验证，并保留失败输出作为证据。",
      ].join("\n\n"),
    },
  ];

  assert.equal(shouldSuppressAgentToolEcho(blocks, 1), false);
});

test("chat render helpers dedupe read context entries and track cached reads", () => {
  const entries = buildReadContextEntries([
    {
      type: "tool",
      toolName: "read_file",
      target: "src/App.tsx",
      observationSummary: "Opened app file",
    },
    {
      type: "tool",
      toolName: "read_file",
      target: "src/App.tsx",
      observationSummary: "FILE_UNCHANGED_STUB",
    },
  ], "en");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 2);
  assert.equal(entries[0].cachedCount, 1);
  assert.equal(entries[0].label, "Read file");
});

test("chat tool summary keeps read edit and failure counts", () => {
  const summary = buildToolExecutionSummary([
    { type: "tool", toolName: "read_file", toolStatus: "executed" },
    { type: "tool", toolName: "write_file", toolStatus: "running" },
    { type: "tool", toolName: "grep_search", toolStatus: "failed" },
  ], "zh");

  assert.match(summary, /读取\/搜索 1 次资料/);
  assert.match(summary, /修改 1 次文件/);
  assert.match(summary, /1 次请求失败/);
});

test("sanitize output removes raw protocols and complete reasoning blocks", () => {
  const raw = [
    "可见正文",
    "<thinking>不要展示这段原始思考</thinking>",
    "<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"secret\"}}</tool_call>",
    "<tool_use><tool>read_file</tool><parameter name=\"path\">src/App.tsx</parameter></tool_use>",
    "<|endoftext|>",
  ].join("\n");

  const cleaned = sanitizeAIOutput(raw);
  assert.match(cleaned, /可见正文/);
  assert.doesNotMatch(cleaned, /thinking|原始思考|tool_call|tool_use|read_file|secret|endoftext/i);
  assert.equal(stripReasoningBlocks("<thought>hidden</thought>visible"), "visible");
  assert.equal(sanitizeAIOutput("可见\n<thinking>仍在流式思考"), "可见");
});

test("Gemma4 proposal markers and user options are protocol, not chat text", () => {
  const raw = [
    "[PROPOSAL START]",
    "# 修复计划",
    "",
    "| 问题 | 修复 |",
    "| --- | --- |",
    "| 数据不显示 | 增加 CSV 字段映射 |",
    "",
    "<user_options>",
    "<option action=\"approve_operation_once\" value=\"批准执行\">批准执行</option>",
    "</user_options>",
    "<tool_use>",
    "<tool>read_file</tool>",
    "<parameter name=\"path\">src/App.tsx</parameter>",
    "</tool_use>",
    "[PROPOSAL END]",
  ].join("\n");

  const display = sanitizeAssistantDisplayContent(raw);
  const visible = sanitizeVisibleAssistantText(raw);
  for (const cleaned of [display, visible]) {
    assert.match(cleaned, /# 修复计划/);
    assert.match(cleaned, /\| 问题 \| 修复 \|/);
    assert.doesNotMatch(cleaned, /PROPOSAL|user_options|<option|tool_use|<tool>|read_file|src\/App\.tsx/i);
  }

  const normalized = normalizeAssistantTurn({
    content: raw,
    toolCalls: [],
    finishReason: "stop",
  });
  assert.match(normalized.visibleText, /# 修复计划/);
  assert.doesNotMatch(normalized.visibleText, /PROPOSAL|user_options|tool_use|read_file/i);
  assert.equal(normalized.replyOptions.length, 1);
  assert.equal(normalized.toolCalls.length, 1);
  assert.equal(normalized.toolCalls[0].name, "read_file");
});

test("streaming display policy buffers short protocol/noise tokens in plan execution", () => {
  const odd = resolveStreamingAssistantDisplay({
    text: "कल",
    language: "zh",
    workflowMode: "plan",
    runIntent: "plan",
  });
  assert.equal(odd.action, "buffer");
  assert.equal(odd.text, "");

  const protocol = resolveStreamingAssistantDisplay({
    text: "<user_options>\n<option>批准</option>",
    language: "zh",
    workflowMode: "plan",
    runIntent: "plan",
  });
  assert.equal(protocol.action, "buffer");
  assert.equal(protocol.text, "");

  const plan = resolveStreamingAssistantDisplay({
    text: "[PROPOSAL START]\n# 修复计划\n\n- 修复 CSV 字段映射。",
    language: "zh",
    workflowMode: "plan",
    runIntent: "plan",
  });
  assert.equal(plan.action, "show");
  assert.match(plan.text, /# 修复计划/);
  assert.doesNotMatch(plan.text, /PROPOSAL/);

  const continuation = resolveStreamingAssistantDisplay({
    text: " world",
    language: "en",
    workflowMode: "chat",
    runIntent: "chat",
    hasVisibleAgentBlock: true,
  });
  assert.equal(continuation.action, "show");
  assert.equal(continuation.text, " world");
});

test("streaming display policy preserves normal markdown tables", () => {
  const decision = resolveStreamingAssistantDisplay({
    text: "| 文件 | 状态 |\n| --- | --- |\n| src/App.tsx | 已读 |",
    language: "zh",
    workflowMode: "plan",
    runIntent: "plan",
  });

  assert.equal(decision.action, "show");
  assert.match(decision.text, /\| 文件 \| 状态 \|/);
});

test("chat feedback normalizes statuses and classifies common errors", () => {
  assert.equal(normalizeChatFeedbackStatus("pending"), "pending_approval");
  assert.equal(getChatFeedbackStatusCopy("pending_approval", "zh").label, "待批准");

  const auth = classifyChatError("HTTP 401 invalid_api_key", {
    language: "zh",
    activeProfile: "cloud",
  });
  assert.equal(auth.category, "auth");
  assert.equal(auth.settingsTab, "cloud");
  assert.match(auth.title, /认证/);

  const context = classifyChatError("maximum context length exceeded", { language: "zh" });
  assert.equal(context.category, "context_length");
  assert.equal(context.settingsTab, "context");

  const mcp = classifyChatError("MCP server did not respond", { language: "en" });
  assert.equal(mcp.category, "mcp");
  assert.equal(mcp.settingsTab, "mcp");
});
