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

const {
  deriveToolPhase,
  deriveToolIntentSummary,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolPresentation.ts"));
const {
  buildTurnProcessArchiveModel,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnProcessArchive.ts"));

test("tool intent helpers derive stable phases without model metadata", () => {
  assert.equal(deriveToolPhase({ toolName: "grep_search", target: "TurnProcessArchive" }), "discover");
  assert.equal(deriveToolPhase({ toolName: "read_file", target: "src/components/ChatArea.tsx" }), "inspect");
  assert.equal(deriveToolPhase({ toolName: "write_file", target: "src/lib/example.ts" }), "edit");
  assert.equal(deriveToolPhase({ toolName: "execute_command", target: "npm run build" }), "verify");
  assert.equal(deriveToolPhase({ toolName: "execute_command", target: "node scripts/inspect.js" }), "command");
  assert.equal(deriveToolPhase({ toolName: "read_file", target: "missing.ts", toolStatus: "failed" }), "blocked");

  assert.equal(
    deriveToolIntentSummary({ toolName: "grep_search", target: "ChatArea", language: "zh" }),
    "定位相关文件或符号，再收敛后续读取范围。",
  );
});

test("turn archive model groups latest thought, context, edits, verification, and blocked steps", () => {
  const blocks = [
    { id: 1, type: "user", content: "实现归档时间线" },
    { id: 2, type: "thought", content: "旧摘要不应该继续显示。" },
    { id: 3, type: "thought", content: "现在准备验证结果，并保留最新步骤摘要。" },
    { id: 4, type: "tool", toolName: "grep_search", target: "TurnProcessArchive", status: "done", toolStatus: "executed" },
    { id: 5, type: "tool", toolName: "read_file", target: "src/components/ChatArea.tsx", status: "done", toolStatus: "executed" },
    {
      id: 6,
      type: "tool",
      toolName: "write_file",
      target: "src/lib/turnProcessArchive.ts",
      status: "done",
      toolStatus: "executed",
      diff: { old: "", new: "export const ok = true;\n", path: "src/lib/turnProcessArchive.ts" },
    },
    { id: 7, type: "tool", toolName: "execute_command", target: "npm run build", status: "done", toolStatus: "executed" },
    { id: 8, type: "tool", toolName: "read_file", target: "missing.ts", status: "error", toolStatus: "failed", message: "ENOENT" },
    { id: 9, type: "agent", content: "完成。", streaming: false },
  ];

  const archive = buildTurnProcessArchiveModel({
    blocks,
    finalVisibleAgentIndex: 8,
    language: "zh",
  });

  assert.equal(archive.totalCount, 6);
  assert.equal(archive.stepCount, 5);
  assert.deepEqual(
    archive.steps.map((step) => step.kind),
    ["thinking", "discover", "edit", "verify", "blocked"],
  );
  assert.equal(archive.steps[0].items[0].id, 3);
  assert.equal(archive.steps[1].items.length, 2);
  assert.match(archive.steps[1].intent, /收敛相关范围/);
  assert.doesNotMatch(archive.steps[1].intent, /结果|下一步/);
  assert.match(archive.steps[1].why, /定位/);
  assert.match(archive.steps[1].action, /搜索|扫描/);
  assert.match(archive.steps[1].result, /ChatArea\.tsx|TurnProcessArchive|范围/);
  assert.match(archive.steps[2].intent, /实施聚焦修改/);
  assert.match(archive.steps[2].next, /验证/);
  assert.equal(archive.steps[3].summary, "npm run build");
  assert.match(archive.steps[3].intent, /验证受影响行为/);
  assert.equal(archive.steps[4].expandedByDefault, true);
  assert.match(archive.steps[4].next, /调整目标|权限|方案/);
  assert.match(archive.summaryText, /5 步/);
  assert.match(archive.summaryText, /编辑 1/);
});

test("persisted tool intent summaries win over deterministic fallback", () => {
  const archive = buildTurnProcessArchiveModel({
    blocks: [
      { id: 1, type: "user", content: "run" },
      {
        id: 2,
        type: "tool",
        toolName: "execute_command",
        target: "node scripts/check.js",
        status: "done",
        toolStatus: "executed",
        intentSummary: "用已有脚本检查归档 UI 状态。",
      },
      { id: 3, type: "agent", content: "done" },
    ],
    finalVisibleAgentIndex: 2,
    language: "zh",
  });

  assert.equal(archive.steps.length, 1);
  assert.equal(archive.steps[0].intent, "用已有脚本检查归档 UI 状态。");
});
