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
  buildRuntimeProgressProjection,
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

test("runtime progress ledger exposes model stream idle warnings without duplicating them", () => {
  const events = [
    withEventSchema({
      type: "harness.telemetry",
      threadId: "thread-a",
      turnId: "turn-a",
      timestampMs: 10,
      telemetry: {
        name: "no_chunk_progress_warning",
        details: {
          activeStreamId: "stream-a",
          streamElapsedMs: 45_000,
          streamChunkCount: 1,
          streamByteCount: 14,
        },
      },
    }),
    withEventSchema({
      type: "harness.telemetry",
      threadId: "thread-a",
      turnId: "turn-a",
      timestampMs: 55,
      telemetry: {
        name: "no_chunk_progress_warning",
        details: {
          activeStreamId: "stream-a",
          streamElapsedMs: 90_000,
          streamChunkCount: 1,
          streamByteCount: 14,
        },
      },
    }),
  ];

  const items = buildRuntimeProgressLedger({ events, turnId: "turn-a", language: "zh" });

  assert.equal(items.length, 1);
  assert.equal(items[0].repeatCount, 2);
  assert.match(items[0].title, /等待模型继续输出/);
  assert.match(items[0].summary, /90 秒/);
});

test("runtime progress projection keeps latest status and only recent four details", () => {
  const events = Array.from({ length: 6 }, (_, index) => withEventSchema({
    type: "progress.updated",
    threadId: "thread-a",
    turnId: "turn-a",
    timestampMs: 10 + index,
    progress: {
      phase: index === 0 ? "understanding" : "investigating",
      title: index === 0 ? "理解需求" : `读取目标 ${index}`,
      status: index < 5 ? "done" : "running",
      summary: index === 0 ? "已确认用户目标和约束。" : `正在处理第 ${index} 个目标。`,
      target: index === 0 ? "" : `src/file-${index}.ts`,
      tool: index === 0 ? "" : "read_file",
      dedupeKey: index === 0 ? "understanding:turn-a" : `read:${index}`,
    },
  }));

  const items = buildRuntimeProgressLedger({ events, turnId: "turn-a", language: "zh", maxItems: 12 });
  const projection = buildRuntimeProgressProjection(items, "zh", 4);

  assert.equal(projection.latest.title, "读取目标 5");
  assert.equal(projection.latest.status, "running");
  assert.equal(projection.recent.length, 4);
  assert.equal(projection.recent[0].target, "src/file-2.ts");
  assert.match(projection.activityText, /读取目标 5/);
  assert.match(projection.activityText, /第 5 个目标/);
});

test("runtime pause projection hides raw repeated read diagnostics", () => {
  const event = withEventSchema({
    type: "run.paused",
    threadId: "thread-a",
    turnId: "turn-a",
    timestampMs: 10,
    reason: "no_action",
    message: [
      "执行已暂停：连续重复探索，没有产生新的可用证据。",
      "重复轮数：3",
      "最近工具：succeeded:read_file src/components/Dashboard/TrendLineChart.tsx - FILE_UNCHANGED_STUB: src/components/Dashboard/TrendLineChart.tsx",
      "建议恢复动作：不要继续读取同一文件；改为写入/替换、运行命令验证，或说明真实阻塞原因。",
    ].join("\n"),
    progress: {
      phase: "blocked",
      title: "运行已暂停",
      status: "paused",
      summary: "基于当前 workspace 状态恢复执行",
      next: "基于当前 workspace 状态恢复执行",
      dedupeKey: "pause:no_action",
    },
  });
  const block = {
    id: 1,
    turnId: "turn-a",
    type: "system",
    content: event.message,
  };

  const items = buildRuntimeProgressLedger({ blocks: [block], events: [event], turnId: "turn-a", language: "zh" });
  const projection = buildRuntimeProgressProjection(items, "zh", 4);

  assert.match(projection.activityText, /运行已暂停/);
  assert.doesNotMatch(projection.activityText, /FILE_UNCHANGED_STUB/);
  assert.doesNotMatch(projection.activityText, /succeeded:read_file/);
  assert.doesNotMatch(projection.summary, /FILE_UNCHANGED_STUB/);
});
