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
  computeContextBudgets,
  computeContextTokenBreakdown,
  compactToolResults,
  manageContext,
  activeMemoryReclamation,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/contextTrim.ts"));

test("computeContextBudgets reserves a smaller, capped output budget for long contexts", () => {
  const budgets16k = computeContextBudgets(16384);
  const budgets128k = computeContextBudgets(131072);

  assert.equal(budgets16k.outputBudget, 3276);
  assert.equal(budgets16k.inputBudget, 13108);
  assert.equal(budgets128k.outputBudget, 4096);
  assert.equal(budgets128k.inputBudget, 126976);
});

test("manageContext leaves long tool output untouched while under the proactive trigger", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "tool", content: "A".repeat(12000) },
  ];

  const result = manageContext(messages, 32768, undefined, 100, 2000);

  assert.equal(result.droppedCount, 0);
  assert.equal(result.changed, true);
  assert.equal(result.tokenReduction, 0);
  assert.match(result.memoryPacket, /ContextMemoryState v1/);
  assert.equal(result.messages.length, messages.length + 1);
  assert.equal(result.messages[2].content, messages[1].content);
});

test("manageContext can persist token savings once the proactive trigger is crossed", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "tool", content: "A".repeat(80000) },
  ];

  const result = manageContext(messages, 32768, undefined, 100, 2000);

  assert.equal(result.droppedCount, 0);
  assert.equal(result.changed, true);
  assert.ok(result.tokenReduction > 0);
  assert.equal(result.messages.length, messages.length + 1);
  assert.notEqual(result.messages[2].content, messages[1].content);
  assert.equal(result.microCompactionKind, "tool_results");
  assert.equal(result.microCompactedCount, 1);
});

test("compactToolResults summarizes read_file windows with meaningful savings", () => {
  const source = [
    "[MAIN_TOOL_FEEDBACK_V1]{\"version\":1,\"status\":\"completed\",\"tool\":\"read_file\",\"target\":\"src/store/dashboardStore.ts\",\"summary\":\"READ_FILE_RESULT path: src/store/dashboardStore.ts\"}",
    "READ_FILE_RESULT",
    "path: src/store/dashboardStore.ts",
    "truncated: true",
    "totalLines: 392",
    "totalChars: 12439",
    "returnedLines: 1-180",
    "returnedChars: 6200",
    "nextStartLine: 181",
    "nextRead: read_file({\"path\":\"src/store/dashboardStore.ts\",\"start_line\":181,\"max_lines\":180})",
    "note: read_file returns a bounded content window for large or ranged reads.",
    "---CONTENT START---",
    "import { create } from 'zustand';",
    "export const useDashboardStore = create((set, get) => ({",
    "  rawOrders: [],",
    "  setOrders: (orders) => set({ rawOrders: orders }),",
    ...Array.from({ length: 180 }, (_, index) => `  const filler${index} = "${"x".repeat(42)}";`),
    "  get filteredOrders() { return get().rawOrders.filter(order => order.status === 'finished'); }",
    "  get statusDistribution() { return get().filteredOrders.length; }",
    "}));",
    "---CONTENT END---",
  ].join("\n");

  const [compacted] = compactToolResults([{ role: "tool", content: source }], 700);

  assert.ok(String(compacted.content).length < source.length - 2500);
  assert.match(compacted.content, /READ_FILE_SUMMARY path: src\/store\/dashboardStore\.ts/);
  assert.match(compacted.content, /COMPACTED SIGNAL LINES/);
  assert.match(compacted.content, /filteredOrders|setOrders/);
  assert.match(compacted.content, /\[compact: \d+ chars omitted from read_file content\]/);
});

test("manageContext trims down to a lower hysteresis target once the trigger is crossed", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}-` + "B".repeat(900),
    })),
  ];

  const result = manageContext(messages, 4096, undefined, 4000, 4000);

  assert.equal(result.changed, true);
  assert.ok(result.droppedCount > 0);
  assert.ok(result.tokenReduction > 0);
  assert.ok(result.tokenCountAfter <= result.budgets.proactiveTargetBudget);
});

test("manageContext preserves pinned memory and latest user request under small windows", () => {
  const toolCall = {
    id: "call_read_latest",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "Assets/Scripts/GameManager.cs" }),
    },
  };
  const messages = [
    { role: "system", content: "system prompt" },
    ...Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `old-${index} ` + "O".repeat(700),
    })),
    { role: "user", content: "继续修复 Unity 编译错误，必须保留 README 中列出的 Snake 玩法要求。" },
    { role: "assistant", content: "", tool_calls: [toolCall] },
    { role: "tool", tool_call_id: "call_read_latest", content: "public class GameManager {}\n" + "line\n".repeat(260) },
  ];

  const result = manageContext(messages, 4096, 1024, 4000, 4000, true);
  const combined = result.messages.map((message) => String(message.content || "")).join("\n");

  assert.match(combined, /ContextMemoryState v1/);
  assert.match(combined, /继续修复 Unity 编译错误/);
  assert.match(combined, /必须保留 README/);
  assert.match(result.memoryPacket, /Assets\/Scripts\/GameManager\.cs/);
});

test("manageContext keeps default memory buckets above two entries", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    ...Array.from({ length: 6 }, (_, index) => ({
      role: "user",
      content: `必须保留约束 ${index}: do not drop verified requirement ${index}.`,
    })),
  ];

  const result = manageContext(messages, 65536);

  assert.equal(result.droppedCount, 0);
  assert.ok(result.memoryState.constraints.length >= 6);
  assert.match(result.memoryPacket, /verified requirement 5/);
});

test("manageContext force mode trims even after microcompaction leaves context over provider window", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    ...Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}-` + "C".repeat(3200),
    })),
  ];

  const result = manageContext(messages, 32768, 2048, 4000, 4000, true);

  assert.equal(result.changed, true);
  assert.ok(result.droppedCount > 0);
  assert.ok(result.tokenCountAfter <= result.budgets.proactiveTargetBudget);
});

test("manageContext builds state-first compressed memory instead of tool transcript noise", () => {
  const readToolCall = {
    id: "call_read",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "snake.py" }),
    },
  };
  const replaceToolCall = {
    id: "call_replace",
    function: {
      name: "replace_in_file",
      arguments: JSON.stringify({ path: "snake.py" }),
    },
  };
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "请修复 snake.py 的重复替换问题，必须保留审计历史，不要删除 .MAIN/plans 文件。" },
    { role: "assistant", content: "", tool_calls: [readToolCall] },
    { role: "tool", tool_call_id: "call_read", content: "snake.py contents\n" + "def move(): pass\n".repeat(900) },
    { role: "assistant", content: "", tool_calls: [replaceToolCall] },
    {
      role: "tool",
      tool_call_id: "call_replace",
      content: [
        'Detected a repetition loop: tool "replace_in_file" called with identical arguments 3+ times (target: "snake.py").',
        "RecoveryDetails:",
        "- duplicateTool: replace_in_file",
        "- target: snake.py",
        "- duplicateCount: 3+",
        "- suggestedNextTask: 核查 runtime 任务清单、当前 workspace 状态和证据摘要后继续；只有已知存在时才读取 tasks.md",
      ].join("\n"),
    },
    ...Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `recent-${index} ` + "R".repeat(900),
    })),
  ];

  const result = manageContext(messages, 4096, 1024, 4000, 4000, true);
  const compressed = String(result.compressedContext || "");
  const marker = result.messages.find((message) =>
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.includes("ContextState")
  );

  assert.ok(marker, "expected a ContextState marker in the managed messages");
  assert.match(compressed, /ContextState/);
  assert.match(compressed, /snake\.py/);
  assert.match(compressed, /duplicateTool=replace_in_file|repeat loop/);
  assert.match(compressed, /runtime 任务清单/);
  assert.match(compressed, /只有已知存在时才读取 tasks\.md/);
  assert.doesNotMatch(compressed, /重新读取 tasks\.md/);
  assert.doesNotMatch(compressed, /助手调用工具|工具结果：/);
});

test("manageContext carries compressed state without nesting earlier transcript summaries", () => {
  const first = manageContext([
    { role: "system", content: "system prompt" },
    { role: "user", content: "目标：实现 TopIsland 步骤进度，必须只展示当前回合。" },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `old-${index} ` + "A".repeat(1000),
    })),
  ], 4096, 1024, 4000, 4000, true);

  const second = manageContext([
    ...first.messages,
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `new-${index} ` + "B".repeat(1000),
    })),
  ], 4096, 1024, 4000, 4000, true);

  const compressed = String(second.compressedContext || "");
  assert.doesNotMatch(compressed, /更早历史摘要/);
  assert.doesNotMatch(compressed, /助手调用工具|工具结果：/);
  assert.ok((compressed.match(/ContextState:/g) || []).length <= 1);
});

test("computeContextTokenBreakdown reports tool results as the largest source", () => {
  const result = computeContextTokenBreakdown([
    { role: "system", content: "system prompt" },
    { role: "user", content: "short request" },
    { role: "tool", content: "T".repeat(12000) },
  ]);

  assert.equal(result.topSource, "toolResult");
  assert.match(result.topSourceLabel, /tool results/);
  assert.ok(result.topSourceTokens > result.user);
});

test("activeMemoryReclamation prunes historical reads once a successful mutation occurs", () => {
  const readCall = {
    id: "call_read_1",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "src/components/Chart.tsx" }),
    },
  };
  const writeCall = {
    id: "call_write_1",
    function: {
      name: "write_file",
      arguments: JSON.stringify({ path: "src/components/Chart.tsx", content: "new content" }),
    },
  };

  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "please update the chart component" },
    { role: "assistant", content: "", tool_calls: [readCall] },
    { role: "tool", tool_call_id: "call_read_1", content: "old content ".repeat(100) },
    { role: "assistant", content: "", tool_calls: [writeCall] },
    { role: "tool", tool_call_id: "call_write_1", content: '{"success":true,"message":"File src/components/Chart.tsx written successfully."}' },
  ];

  const result = activeMemoryReclamation(messages);

  assert.equal(result.length, messages.length);
  // The first read tool result content must be replaced by a stub
  assert.match(result[3].content, /removed; file was successfully mutated/);
  // The write tool result must remain unchanged
  assert.match(result[5].content, /written successfully/);
});

