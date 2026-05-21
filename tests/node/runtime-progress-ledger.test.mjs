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
  if (transpiledModuleCache.has(normalizedPath)) return transpiledModuleCache.get(normalizedPath);

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
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) return loadTranspiledModuleSync(candidate);
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
  buildRuntimeProgressLedger,
  summarizeRuntimeProgressLedger,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/runtimeProgressLedger.ts"));
const {
  withEventSchema,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnEvents.ts"));

test("runtime progress ledger dedupes repeated read blocks and exposes cache reuse", () => {
  const blocks = [
    {
      id: 1,
      turnId: "turn-a",
      type: "tool",
      toolName: "read_file",
      target: "src/store/dashboardStore.ts",
      status: "done",
      toolStatus: "executed",
      observationSummary: "找到 CSV 导入后的 store 写入入口。",
    },
    {
      id: 2,
      turnId: "turn-a",
      type: "tool",
      toolName: "read_file",
      target: "src/store/dashboardStore.ts",
      status: "done",
      toolStatus: "executed",
      message: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts",
    },
    {
      id: 3,
      turnId: "turn-a",
      type: "tool",
      toolName: "read_file",
      target: "src/App.tsx",
      status: "done",
      toolStatus: "executed",
      observationSummary: "确认 Dashboard 入口。",
    },
  ];

  const items = buildRuntimeProgressLedger({ blocks, turnId: "turn-a", language: "zh" });
  const dashboardItem = items.find((item) => item.target === "src/store/dashboardStore.ts");

  assert.equal(items.length, 2);
  assert.equal(dashboardItem.repeatCount, 2);
  assert.equal(dashboardItem.cacheHits, 1);
  assert.match(summarizeRuntimeProgressLedger(items, "zh"), /dashboardStore\.ts ×2/);
  assert.match(summarizeRuntimeProgressLedger(items, "zh"), /缓存复用/);
});

test("runtime progress ledger merges structured progress events with legacy blocks", () => {
  const event = withEventSchema({
    type: "progress.updated",
    threadId: "thread-a",
    turnId: "turn-a",
    timestampMs: 10,
    progress: {
      phase: "investigating",
      title: "读取 Dashboard 数据链路",
      status: "running",
      summary: "正在定位 CSV 到图表的状态流。",
      tool: "read_file",
      target: "src/store/dashboardStore.ts",
      dedupeKey: "investigating:read_file:src/store/dashboardStore.ts",
    },
  });

  const items = buildRuntimeProgressLedger({
    blocks: [
      {
        id: 1,
        turnId: "turn-a",
        type: "tool",
        toolName: "read_file",
        target: "src/store/dashboardStore.ts",
        status: "done",
        toolStatus: "executed",
        observationSummary: "找到导入入口。",
      },
    ],
    events: [event],
    turnId: "turn-a",
    language: "zh",
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].repeatCount, 2);
  assert.equal(items[0].status, "running");
  assert.match(items[0].summary, /定位 CSV|找到导入入口/);
});

