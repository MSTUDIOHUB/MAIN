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
  stripReasoningBlocks,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/sanitize.ts"));

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
