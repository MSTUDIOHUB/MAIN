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
  buildCapsuleActivityText,
  buildCapsuleGuidanceText,
  buildRuntimeProgressLedger,
  buildRuntimeProgressProjection,
  buildRunStatusProjection,
  summarizeRuntimeProgressLedger,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/runtimeProgressLedger.ts"));
const {
  withEventSchema,
  normalizePersistedMainThreadEvent,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnEvents.ts"));

test("active Run keeps exact-turn legacy progress when the display block has no runId", () => {
  const ledger = buildRuntimeProgressLedger({
    turnId: "turn-current",
    activeRunId: "run-current",
    blocks: [
      {
        id: "tool-current",
        type: "tool",
        turnId: "turn-current",
        toolName: "read_file",
        target: "src/main.js",
        toolStatus: "running",
        createdAt: 20,
      },
      {
        id: "tool-foreign",
        type: "tool",
        turnId: "turn-current",
        runId: "run-foreign",
        toolName: "read_file",
        target: "src/foreign.js",
        toolStatus: "running",
        createdAt: 30,
      },
    ],
    events: [],
    language: "zh",
  });

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].target, "src/main.js");
  assert.equal(
    buildCapsuleGuidanceText(buildRunStatusProjection(ledger), "zh"),
    "我正在读取 `main.js`，确认与当前问题相关的实现。",
  );
});

test("runtime progress ledger keeps an approved child run separate from its parent plan-review pause", () => {
  const parentRunId = "run-plan-review";
  const childRunId = "run-plan-execution";
  const planExecutionSnapshot = {
    turnId: "turn-plan",
    runId: childRunId,
    parentRunId,
    phase: "tool_start",
    currentTask: "按计划修复 Rust 保存命令",
    currentTool: "replace_in_file · src-tauri/src/main.rs",
    latestEvidence: "已定位缺失的 save_file_content 命令",
    nextStep: "写入 Rust 命令并运行检查",
    iteration: 1,
    maxIterations: 50,
    autoResumeCount: 0,
    updatedAt: 30,
  };
  const events = [
    withEventSchema({
      type: "run.paused",
      threadId: "thread-a",
      turnId: "turn-plan",
      runId: parentRunId,
      parentRunId: null,
      timestampMs: 10,
      reason: "plan_review",
      message: "计划产物已物化并通过校验，等待审核。",
      progress: {
        phase: "plan_review",
        title: "计划已生成，等待审核",
        status: "paused",
        summary: "等待用户批准计划。",
      },
    }),
    withEventSchema({
      type: "progress.updated",
      threadId: "thread-a",
      turnId: "turn-plan",
      runId: parentRunId,
      parentRunId: null,
      timestampMs: 11,
      progress: {
        phase: "plan_review",
        title: "计划已生成，等待审核",
        status: "paused",
        summary: "等待用户批准计划。",
        dedupeKey: `plan-review:${parentRunId}`,
      },
    }),
    withEventSchema({
      type: "progress.updated",
      threadId: "thread-a",
      turnId: "turn-plan",
      runId: childRunId,
      parentRunId,
      timestampMs: 20,
      progress: {
        phase: "plan_execution:tool_start",
        title: "正在执行已批准计划",
        status: "running",
        summary: "按计划修复 Rust 保存命令 · replace_in_file · src-tauri/src/main.rs",
        dedupeKey: `plan-execution-progress:${childRunId}`,
      },
    }),
  ];

  const items = buildRuntimeProgressLedger({
    blocks: [
      {
        id: 1,
        turnId: "turn-plan",
        type: "system",
        content: "计划产物已物化并通过校验，等待审核。",
      },
    ],
    events,
    turnId: "turn-plan",
    activeRunId: childRunId,
    planExecutionSnapshot,
    language: "zh",
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].status, "running");
  assert.equal(items[0].title, "正在执行已批准计划");
  assert.match(items[0].summary, /按计划修复 Rust 保存命令/);
  assert.doesNotMatch(items.map((item) => `${item.title} ${item.summary}`).join("\n"), /等待审核|等待用户批准/);
});

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

test("Capsule activity is regenerated from structured tool fields without model prose or raw tool names", () => {
  const projection = buildRunStatusProjection([{
    key: "run:1:search",
    runId: "run-1",
    phase: "tool_start",
    title: "模型声称正在做一些不应进入 Capsule 的事情",
    status: "running",
    summary: "grep_search · src/components/ChatArea.tsx · secret reasoning",
    target: "src/components/ChatArea.tsx",
    tool: "grep_search",
    sourceToolCallIds: ["call-1", "call-2"],
    repeatCount: 2,
    cacheHits: 0,
    firstSeenAt: 1,
    lastSeenAt: 2,
  }], "zh");

  const activityText = buildCapsuleActivityText(projection, "zh");
  assert.equal(activityText, "正在搜索 ChatArea.tsx · 2 次");
  assert.doesNotMatch(activityText, /grep_search|secret reasoning|模型声称/);
  assert.equal(buildCapsuleActivityText({ ...projection, currentActivity: null }, "zh"), "");
});

test("Capsule guidance explains the purpose of the latest structured action", () => {
  const projection = buildRunStatusProjection([{
    key: "run:1:edit",
    runId: "run-1",
    phase: "tool_start",
    title: "raw model prose",
    status: "running",
    summary: "replace_in_file · private detail",
    target: "src/components/ChatArea.tsx",
    tool: "replace_in_file",
    sourceToolCallIds: ["call-1"],
    repeatCount: 1,
    cacheHits: 0,
    firstSeenAt: 1,
    lastSeenAt: 2,
  }], "zh");

  assert.equal(
    buildCapsuleGuidanceText(projection, "zh"),
    "我正在修改 `ChatArea.tsx`，把已确认的方案落实到代码。",
  );
  assert.equal(
    buildCapsuleGuidanceText(projection, "en"),
    "I'm updating `ChatArea.tsx` to put the confirmed approach into the code.",
  );
  assert.doesNotMatch(buildCapsuleGuidanceText(projection, "zh"), /replace_in_file|private detail|raw model prose/);
});

test("Capsule collaboration guidance stays complete while ChatArea owns the full assignment", () => {
  const projection = buildRunStatusProjection([{
    key: "run:1:spawn-subagent",
    runId: "run-1",
    phase: "tool_result",
    title: "raw objective that must not be copied into Capsule",
    status: "done",
    summary: "spawn_subagent · private protocol detail",
    target: "Euler",
    tool: "spawn_subagent",
    sourceToolCallIds: ["call-spawn"],
    repeatCount: 1,
    cacheHits: 0,
    firstSeenAt: 1,
    lastSeenAt: 2,
  }], "zh");

  const guidance = buildCapsuleGuidanceText(projection, "zh");
  assert.equal(guidance, "子智能体 `Euler` 已开始独立调查，主体正在继续推进。");
  assert.doesNotMatch(guidance, /\.\.\.|raw objective|spawn_subagent|private protocol/);
});

test("Capsule does not let a long-lived spawn heartbeat overwrite newer parent work", () => {
  const projection = buildRunStatusProjection([
    {
      key: "run:1:spawn-subagent",
      runId: "run-1",
      phase: "tool_start",
      title: "启动子智能体",
      status: "running",
      summary: "",
      target: "Euler",
      tool: "spawn_subagent",
      sourceToolCallIds: ["call-spawn"],
      repeatCount: 1,
      cacheHits: 0,
      firstSeenAt: 10,
      lastSeenAt: 90,
    },
    {
      key: "run:1:grep-main",
      runId: "run-1",
      phase: "tool_result",
      title: "搜索主流程",
      status: "done",
      summary: "",
      target: "src/main.js",
      tool: "grep_search",
      sourceToolCallIds: ["call-grep"],
      repeatCount: 1,
      cacheHits: 0,
      firstSeenAt: 50,
      lastSeenAt: 60,
    },
  ], "zh");

  assert.equal(projection.currentActivity, null);
  assert.equal(projection.lastGuidanceActivity?.tool, "grep_search");
  assert.equal(
    buildCapsuleGuidanceText(projection, "zh"),
    "我已搜索 `main.js`，正在收窄真正相关的路径。",
  );
});

test("Capsule never presents a truncated protocol target as a complete thought", () => {
  const projection = buildRunStatusProjection([{
    key: "run:1:unknown",
    runId: "run-1",
    phase: "tool_start",
    title: "raw model prose",
    status: "running",
    summary: "unknown_tool · private detail",
    target: "x".repeat(400),
    tool: "unknown_tool",
    sourceToolCallIds: ["call-unknown"],
    repeatCount: 1,
    cacheHits: 0,
    firstSeenAt: 1,
    lastSeenAt: 2,
  }], "zh");

  const guidance = buildCapsuleGuidanceText(projection, "zh");
  assert.equal(guidance, "我正在处理 当前工作区，确认这一步带来的变化。");
  assert.doesNotMatch(guidance, /\.\.\.|xxx/);
});

test("Capsule guidance retains the last structured activity without a lifecycle prose fallback", () => {
  const emptyProjection = {
    currentActivity: null,
    lastGuidanceActivity: null,
    milestones: [],
    healthSignals: [],
    activityText: "",
  };
  assert.equal(
    buildCapsuleGuidanceText(emptyProjection, "zh"),
    "",
  );
  assert.equal(
    buildCapsuleGuidanceText(emptyProjection, "en"),
    "",
  );

  const completedEdit = buildRunStatusProjection([{
    key: "run:1:edit-complete",
    runId: "run-1",
    phase: "tool_result",
    title: "raw model prose",
    status: "done",
    summary: "replace_in_file · private detail",
    target: "src/components/ChatArea.tsx",
    tool: "replace_in_file",
    sourceToolCallIds: ["call-1"],
    repeatCount: 1,
    cacheHits: 0,
    firstSeenAt: 1,
    lastSeenAt: 2,
  }], "zh");
  assert.equal(completedEdit.currentActivity, null);
  assert.equal(completedEdit.lastGuidanceActivity?.tool, "replace_in_file");
  assert.equal(
    buildCapsuleGuidanceText(completedEdit, "zh"),
    "修改已写入 `ChatArea.tsx`，接下来我会验证结果。",
  );
  const completedStatusEdit = buildRunStatusProjection([{
    ...completedEdit.lastGuidanceActivity,
    key: "run:1:edit-completed-status",
    status: "completed",
  }], "zh");
  assert.equal(completedStatusEdit.lastGuidanceActivity?.tool, "replace_in_file");
  assert.equal(
    buildCapsuleGuidanceText(completedStatusEdit, "zh"),
    "修改已写入 `ChatArea.tsx`，接下来我会验证结果。",
  );
  const repeatedAfterCompletedEdit = {
    ...completedStatusEdit,
    healthSignals: [{
      key: "repeat-edit",
      kind: "repetition",
      status: "done",
      title: "重复操作 ChatArea.tsx",
      summary: "同一目标共 2 次。",
      lastSeenAt: 3,
    }],
  };
  assert.equal(
    buildCapsuleGuidanceText(repeatedAfterCompletedEdit, "zh"),
    "修改已写入 `ChatArea.tsx`，接下来我会验证结果。",
  );

  const blockedAfterEdit = buildRunStatusProjection([
    completedEdit.lastGuidanceActivity,
    {
      key: "run:1:blocked",
      runId: "run-1",
      phase: "blocked",
      title: "运行受阻",
      status: "failed",
      summary: "需要处理新的阻塞。",
      target: "",
      tool: "",
      sourceToolCallIds: [],
      repeatCount: 1,
      cacheHits: 0,
      firstSeenAt: 3,
      lastSeenAt: 3,
    },
  ].filter(Boolean), "zh");
  assert.equal(blockedAfterEdit.lastGuidanceActivity?.tool, "replace_in_file");
  assert.ok(blockedAfterEdit.healthSignals.some((signal) => signal.kind === "failure"));
  assert.equal(buildCapsuleGuidanceText(blockedAfterEdit, "zh"), "");
});

test("Capsule activity never falls back to an unproven progress title", () => {
  const projection = buildRunStatusProjection([{
    key: "run:unknown",
    runId: "run-unknown",
    phase: "investigating",
    title: "raw model prose must stay private",
    status: "running",
    summary: "also private",
    target: "",
    tool: "custom_unknown_tool",
    sourceToolCallIds: [],
    repeatCount: 1,
    cacheHits: 0,
    firstSeenAt: 1,
    lastSeenAt: 1,
  }], "zh");

  assert.equal(buildCapsuleActivityText(projection, "zh"), "正在分析");
  assert.doesNotMatch(buildCapsuleActivityText(projection, "zh"), /raw model prose|private/);
});

test("Capsule maps approved Plan execution to a fixed public phase label", () => {
  const projection = buildRunStatusProjection([{
    key: "run:approved-plan",
    runId: "run-approved-plan",
    phase: "plan_execution:tool_start",
    title: "raw runtime title",
    status: "running",
    summary: "internal plan detail",
    target: "",
    tool: "",
    sourceToolCallIds: [],
    repeatCount: 1,
    cacheHits: 0,
    firstSeenAt: 1,
    lastSeenAt: 1,
  }], "zh");

  assert.equal(buildCapsuleActivityText(projection, "zh"), "正在执行已批准计划");
  assert.equal(buildCapsuleActivityText(projection, "en"), "Executing approved plan");
});

test("runtime progress ledger merges a progress snapshot with a tool occurrence without double-counting", () => {
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
  assert.equal(items[0].repeatCount, 1);
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
  assert.equal(items[0].repeatCount, 1);
  assert.match(items[0].title, /等待模型继续输出/);
  assert.match(items[0].summary, /90 秒/);
});

test("runtime progress ledger excludes internal Plan heartbeats and synthetic understanding snapshots", () => {
  const planEvents = Array.from({ length: 25 }, (_, index) => withEventSchema({
    type: "progress.updated",
    threadId: "thread-a",
    turnId: "turn-a",
    timestampMs: 10 + index,
    progress: {
      phase: "investigating",
      title: "Exploring",
      status: "running",
      summary: `第 ${index + 1} 次内部计划心跳。`,
      dedupeKey: "plan-runtime:run-plan:plan_context",
    },
  }));
  const understandingEvent = withEventSchema({
    type: "progress.updated",
    threadId: "thread-a",
    turnId: "turn-a",
    timestampMs: 40,
    progress: {
      phase: "understanding",
      title: "理解需求",
      status: "running",
      summary: "仅供运行时诊断。",
      audience: "internal",
    },
  });
  const blocks = [
    {
      id: 1,
      turnId: "turn-a",
      type: "progress",
      phase: "investigating",
      title: "Exploring",
      status: "running",
      turnPhase: {
        id: "plan_context",
        kind: "context",
        title: "Exploring",
        domain: "plan_runtime",
        status: "running",
      },
    },
    {
      id: 2,
      turnId: "turn-a",
      type: "progress",
      phase: "understanding",
      title: "理解需求",
      status: "running",
      audience: "internal",
    },
  ];

  const items = buildRuntimeProgressLedger({
    blocks,
    events: [...planEvents, understandingEvent],
    turnId: "turn-a",
    language: "zh",
  });

  assert.deepEqual(items, []);
  assert.equal(summarizeRuntimeProgressLedger(items, "zh"), "");
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

  assert.equal(items.length, 5);
  assert.ok(items.every((item) => item.phase !== "understanding"));
  assert.equal(projection.latest.title, "读取目标 5");
  assert.equal(projection.latest.status, "running");
  assert.equal(projection.recent.length, 4);
  assert.equal(projection.recent[0].target, "src/file-2.ts");
  assert.match(projection.activityText, /读取目标 5/);
  assert.match(projection.activityText, /第 5 个目标/);
});

test("runtime progress projection lets later browser validation success clear stale failure", () => {
  const events = [
    withEventSchema({
      type: "progress.updated",
      threadId: "thread-a",
      turnId: "turn-a",
      timestampMs: 10,
      progress: {
        phase: "verifying",
        title: "验证浏览器页面 `http://127.0.0.1:1420/`",
        status: "failed",
        summary: "browser_evaluate timed out after 60000ms",
        target: "http://127.0.0.1:1420/",
        tool: "browser_evaluate",
      },
    }),
    withEventSchema({
      type: "progress.updated",
      threadId: "thread-a",
      turnId: "turn-a",
      timestampMs: 20,
      progress: {
        phase: "verifying",
        title: "验证浏览器页面 `http://127.0.0.1:1420/`",
        status: "done",
        summary: "浏览器验证已通过。",
        target: "http://127.0.0.1:1420/",
        tool: "browser_evaluate",
      },
    }),
  ];

  const items = buildRuntimeProgressLedger({ events, turnId: "turn-a", language: "zh", maxItems: 12 });
  const projection = buildRuntimeProgressProjection(items, "zh", 4);

  assert.equal(items.length, 1);
  assert.equal(items[0].status, "done");
  assert.equal(projection.latest.status, "done");
  assert.doesNotMatch(projection.activityText, /timed out/);
  assert.match(projection.activityText, /浏览器验证已通过/);
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

test("runtime progress events normalize structured tool identity before ledger aggregation", () => {
  const events = Array.from({ length: 4 }, (_, index) => withEventSchema({
    type: "progress.updated",
    threadId: "thread-a",
    turnId: "turn-a",
    runId: "run-a",
    parentRunId: null,
    timestampMs: 10 + index,
    progress: {
      phase: "investigating",
      title: "读取 src/main.js",
      status: "done",
      summary: "已获得后续判断所需上下文。",
      toolName: "read_file",
      targets: ["src\\main.js"],
      sourceToolCallIds: [`read-${index + 1}`, `read-${index + 1}`],
      dedupeKey: `tool:read-${index + 1}`,
    },
  }));

  assert.equal(events[0].runId, "run-a");
  assert.equal(events[0].progress.tool, "read_file");
  assert.equal(events[0].progress.target, "src/main.js");
  assert.equal(events[0].progress.canonicalTarget, "src/main.js");
  assert.deepEqual(events[0].progress.sourceToolCallIds, ["read-1"]);

  const items = buildRuntimeProgressLedger({
    events,
    turnId: "turn-a",
    activeRunId: "run-a",
    language: "zh",
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].target, "src/main.js");
  assert.equal(items[0].tool, "read_file");
  assert.equal(items[0].repeatCount, 4);
  assert.deepEqual(items[0].sourceToolCallIds, ["read-1", "read-2", "read-3", "read-4"]);
  const projection = buildRunStatusProjection(items, "zh");
  assert.equal(projection.currentActivity, null);
  assert.deepEqual(projection.milestones, []);
  assert.equal(projection.healthSignals.length, 1);
  assert.equal(projection.healthSignals[0].kind, "repetition");
  assert.match(projection.healthSignals[0].title, /重复读取/);
});

test("runtime progress ledger counts a tool call once across running, done, and transcript block", () => {
  const running = withEventSchema({
    type: "progress.updated",
    threadId: "thread-a",
    turnId: "turn-a",
    runId: "run-a",
    parentRunId: null,
    timestampMs: 10,
    progress: {
      phase: "investigating",
      title: "正在读取 main.js",
      status: "running",
      tool: "read_file",
      target: "src/main.js",
      sourceToolCallIds: ["read-1"],
    },
  });
  const done = withEventSchema({
    ...running,
    timestampMs: 20,
    progress: {
      ...running.progress,
      title: "已读取 main.js",
      status: "done",
      summary: "读取完成。",
    },
  });

  const items = buildRuntimeProgressLedger({
    blocks: [{
      id: 1,
      turnId: "turn-a",
      runId: "run-a",
      type: "tool",
      toolName: "read_file",
      target: "src/main.js",
      toolCallId: "read-1",
      toolStatus: "executed",
      observationSummary: "读取完成。",
    }],
    events: [running, done],
    turnId: "turn-a",
    activeRunId: "run-a",
    language: "zh",
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].repeatCount, 1);
  assert.deepEqual(items[0].sourceToolCallIds, ["read-1"]);
});

test("runtime progress ledger never merges the same target across run identities", () => {
  const events = ["run-parent", "run-child"].map((runId, index) => withEventSchema({
    type: "progress.updated",
    threadId: "thread-a",
    turnId: "turn-a",
    runId,
    parentRunId: index === 0 ? null : "run-parent",
    timestampMs: 10 + index,
    progress: {
      phase: "investigating",
      title: "已读取 main.js",
      status: "done",
      tool: "read_file",
      target: "src/main.js",
      sourceToolCallIds: [`read-${index}`],
    },
  }));

  const items = buildRuntimeProgressLedger({ events, turnId: "turn-a", language: "zh" });

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.runId), ["run-parent", "run-child"]);
  assert.ok(items.every((item) => item.repeatCount === 1));
});

test("run status projection separates current activity, three milestones, and health signals", () => {
  const events = [
    ...Array.from({ length: 4 }, (_, index) => withEventSchema({
      type: "progress.updated",
      threadId: "thread-a",
      turnId: "turn-a",
      runId: "run-a",
      parentRunId: null,
      timestampMs: 10 + index,
      progress: {
        phase: index === 0 ? "investigating" : "editing",
        title: index === 0 ? "已读取 main.js" : `已编辑 file-${index}.ts`,
        status: "done",
        tool: index === 0 ? "read_file" : "apply_patch",
        target: index === 0 ? "src/main.js" : `src/file-${index}.ts`,
        sourceToolCallIds: [`tool-${index}`],
      },
    })),
    withEventSchema({
      type: "progress.updated",
      threadId: "thread-a",
      turnId: "turn-a",
      runId: "run-a",
      parentRunId: null,
      timestampMs: 20,
      progress: {
        phase: "investigating",
        title: "已读取 main.js",
        status: "done",
        summary: "再次核对同一文件。",
        tool: "read_file",
        target: "src/main.js",
        sourceToolCallIds: ["tool-read-again"],
      },
    }),
    withEventSchema({
      type: "progress.updated",
      threadId: "thread-a",
      turnId: "turn-a",
      runId: "run-a",
      parentRunId: null,
      timestampMs: 30,
      progress: {
        phase: "verifying",
        title: "正在运行回归测试",
        status: "running",
        tool: "execute_command",
        target: "npm test",
        sourceToolCallIds: ["command-1"],
      },
    }),
  ];

  const items = buildRuntimeProgressLedger({
    events,
    turnId: "turn-a",
    activeRunId: "run-a",
    language: "zh",
  });
  const projection = buildRunStatusProjection(items, "zh", 9);

  assert.equal(projection.currentActivity.title, "正在运行回归测试");
  assert.equal(projection.milestones.length, 3);
  assert.equal(projection.healthSignals.length, 1);
  assert.equal(projection.healthSignals[0].kind, "repetition");
  assert.match(projection.healthSignals[0].title, /重复读取 main\.js/);
  assert.match(projection.healthSignals[0].summary, /2 次/);
});

test("run status projection keeps cache-only stubs out of current activity and milestones", () => {
  const event = withEventSchema({
    type: "progress.updated",
    threadId: "thread-a",
    turnId: "turn-a",
    runId: "run-a",
    parentRunId: null,
    timestampMs: 10,
    progress: {
      phase: "investigating",
      title: "已读取 main.js",
      status: "done",
      summary: "FILE_UNCHANGED_STUB: src/main.js",
      tool: "read_file",
      target: "src/main.js",
      sourceToolCallIds: ["read-cache-1"],
    },
  });
  const items = buildRuntimeProgressLedger({
    events: [event],
    turnId: "turn-a",
    activeRunId: "run-a",
    language: "zh",
  });
  const projection = buildRunStatusProjection(items, "zh");

  assert.equal(projection.currentActivity, null);
  assert.deepEqual(projection.milestones, []);
  assert.equal(projection.healthSignals[0].kind, "repetition");
});

test("canonical conclusions and nonterminal boundaries override older running activity", () => {
  for (const terminal of [
    "completed",
    "partial_conclusion",
    "blocked_conclusion",
    "error_conclusion",
    "canceled_conclusion",
    "paused",
    "aborted",
    "legacy_failed",
  ]) {
    const running = withEventSchema({
      type: "progress.updated",
      threadId: "thread-terminal",
      turnId: `turn-${terminal}`,
      runId: `run-${terminal}`,
      parentRunId: null,
      timestampMs: 10,
      progress: {
        phase: "investigating",
        title: "正在读取 App.tsx",
        status: "running",
        tool: "read_file",
        target: "src/App.tsx",
        sourceToolCallIds: [`read-${terminal}`],
      },
    });
    const terminalEvent = [
      "completed",
      "partial_conclusion",
      "blocked_conclusion",
      "error_conclusion",
      "canceled_conclusion",
    ].includes(terminal)
      ? withEventSchema({
          type: "run.completed",
          threadId: "thread-terminal",
          turnId: `turn-${terminal}`,
          runId: `run-${terminal}`,
          parentRunId: null,
          timestampMs: 20,
          resultKind: terminal === "partial_conclusion"
            ? "partial"
            : terminal === "blocked_conclusion"
            ? "blocked"
            : terminal === "error_conclusion"
            ? "error"
            : terminal === "canceled_conclusion"
            ? "canceled"
            : "success",
          summary: "All runtime evidence is complete.",
        })
      : terminal === "paused"
      ? withEventSchema({
          type: "run.paused",
          threadId: "thread-terminal",
          turnId: `turn-${terminal}`,
          runId: `run-${terminal}`,
          parentRunId: null,
          timestampMs: 20,
          reason: "bounded_recovery",
          message: "Recovery paused after the bounded retry limit.",
        })
      : terminal === "aborted"
      ? withEventSchema({
          type: "run.aborted",
          threadId: "thread-terminal",
          turnId: `turn-${terminal}`,
          runId: `run-${terminal}`,
          parentRunId: null,
          timestampMs: 20,
          reason: "user_cancelled",
          message: "The user canceled this run.",
        })
      : normalizePersistedMainThreadEvent({
          type: "run.failed",
          threadId: "thread-terminal",
          turnId: `turn-${terminal}`,
          runId: `run-${terminal}`,
          parentRunId: null,
          timestampMs: 20,
          error: { code: "VALIDATION_FAILED", message: "Validation failed." },
        });
    const items = buildRuntimeProgressLedger({
      events: [running, terminalEvent],
      turnId: `turn-${terminal}`,
      activeRunId: `run-${terminal}`,
      language: "zh",
    });
    const projection = buildRunStatusProjection(items, "zh");

    assert.equal(projection.currentActivity, null, `${terminal} must clear stale running activity`);
    if (
      terminal === "completed" ||
      terminal === "partial_conclusion" ||
      terminal === "blocked_conclusion" ||
      terminal === "error_conclusion" ||
      terminal === "canceled_conclusion" ||
      terminal === "legacy_failed"
    ) {
      assert.ok(projection.milestones.some((item) => item.status === "completed"));
      assert.match(
        projection.activityText,
        terminal === "partial_conclusion"
          ? /部分完成/
          : terminal === "blocked_conclusion"
          ? /受阻结论/
          : terminal === "error_conclusion"
          ? /错误结论/
          : terminal === "legacy_failed"
          ? /错误结论/
          : terminal === "canceled_conclusion"
          ? /运行已取消/
          : /运行已完成/,
      );
      assert.equal(
        projection.healthSignals.some((signal) => signal.kind === "failure" || signal.kind === "pause"),
        false,
        `${terminal} is a closed conclusion, not an app-level failed or paused state`,
      );
    } else {
      assert.deepEqual(projection.milestones, []);
      assert.ok(projection.healthSignals.some((signal) => signal.kind === "pause"));
      assert.match(projection.activityText, terminal === "paused" ? /运行已暂停/ : /运行取消中/);
    }
    assert.doesNotMatch(projection.activityText, /正在读取 App\.tsx/);
  }
});

test("active child run filters parent harness telemetry", () => {
  const events = [
    withEventSchema({
      type: "harness.telemetry",
      threadId: "thread-run-filter",
      turnId: "turn-run-filter",
      runId: "run-parent",
      parentRunId: null,
      timestampMs: 10,
      telemetry: {
        name: "stream_error",
        details: { activeStreamId: "parent-stream", lastStreamError: "parent failed" },
      },
    }),
    withEventSchema({
      type: "progress.updated",
      threadId: "thread-run-filter",
      turnId: "turn-run-filter",
      runId: "run-child",
      parentRunId: "run-parent",
      timestampMs: 20,
      progress: {
        phase: "verifying",
        title: "正在验证子运行",
        status: "running",
        tool: "run_command",
        target: "npm test",
        sourceToolCallIds: ["child-test"],
      },
    }),
  ];
  const items = buildRuntimeProgressLedger({
    events,
    turnId: "turn-run-filter",
    activeRunId: "run-child",
    language: "zh",
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].runId, "run-child");
  assert.doesNotMatch(items[0].summary, /parent failed/);
});

test("active recovery child retains concrete parent guidance until it produces newer work", () => {
  const parentEvents = [
    withEventSchema({
      type: "run.started",
      threadId: "thread-lineage",
      turnId: "turn-lineage",
      runId: "run-parent",
      parentRunId: null,
      timestampMs: 10,
    }),
    withEventSchema({
      type: "progress.updated",
      threadId: "thread-lineage",
      turnId: "turn-lineage",
      runId: "run-parent",
      parentRunId: null,
      timestampMs: 20,
      progress: {
        phase: "investigating",
        title: "已读取源码",
        status: "done",
        tool: "read_file",
        target: "src/main.js",
        sourceToolCallIds: ["read-parent"],
      },
    }),
    withEventSchema({
      type: "run.completed",
      threadId: "thread-lineage",
      turnId: "turn-lineage",
      runId: "run-parent",
      parentRunId: null,
      timestampMs: 30,
      resultKind: "partial",
      summary: "继续自动恢复。",
    }),
    withEventSchema({
      type: "run.started",
      threadId: "thread-lineage",
      turnId: "turn-lineage",
      runId: "run-child",
      parentRunId: "run-parent",
      timestampMs: 40,
    }),
  ];
  const inheritedItems = buildRuntimeProgressLedger({
    events: parentEvents,
    turnId: "turn-lineage",
    activeRunId: "run-child",
    language: "zh",
  });
  const inheritedProjection = buildRunStatusProjection(inheritedItems, "zh");

  assert.equal(inheritedItems.length, 1);
  assert.equal(inheritedItems[0].runId, "run-parent");
  assert.equal(
    buildCapsuleGuidanceText(inheritedProjection, "zh"),
    "我已读完 `main.js`，正在整理它说明了什么。",
  );
  assert.doesNotMatch(inheritedProjection.activityText, /部分完成|继续自动恢复/);

  const childItems = buildRuntimeProgressLedger({
    events: [
      ...parentEvents,
      withEventSchema({
        type: "progress.updated",
        threadId: "thread-lineage",
        turnId: "turn-lineage",
        runId: "run-child",
        parentRunId: "run-parent",
        timestampMs: 50,
        progress: {
          phase: "editing",
          title: "正在修改源码",
          status: "running",
          tool: "replace_in_file",
          target: "src/components/editor.js",
          sourceToolCallIds: ["edit-child"],
        },
      }),
    ],
    turnId: "turn-lineage",
    activeRunId: "run-child",
    language: "zh",
  });
  const childProjection = buildRunStatusProjection(childItems, "zh");

  assert.equal(childProjection.currentActivity?.runId, "run-child");
  assert.equal(
    buildCapsuleGuidanceText(childProjection, "zh"),
    "我正在修改 `editor.js`，把已确认的方案落实到代码。",
  );
});

test("visual progress keeps delivery distinct from recognition and surfaces provider omission", () => {
  const queued = withEventSchema({
    type: "progress.updated",
    threadId: "thread-visual",
    turnId: "turn-visual",
    runId: "run-visual",
    parentRunId: null,
    timestampMs: 10,
    progress: {
      phase: "understanding",
      title: "截图待发送",
      status: "running",
      audience: "user",
      tool: "visual_context",
      target: "images:1",
      dedupeKey: "visual-context:turn-visual",
      visualContext: {
        status: "queued",
        expectedImageParts: 1,
        deliveredImageParts: 0,
        omittedImageParts: 0,
        recognition: "pending",
      },
    },
  });
  const unsupported = withEventSchema({
    type: "progress.updated",
    threadId: "thread-visual",
    turnId: "turn-visual",
    runId: "run-visual",
    parentRunId: null,
    timestampMs: 20,
    progress: {
      phase: "blocked",
      title: "当前模型或端点不支持截图",
      status: "failed",
      audience: "user",
      summary: "截图未提供给模型，不计为识别证据。",
      tool: "visual_context",
      target: "images:1",
      dedupeKey: "visual-context:turn-visual",
      visualContext: {
        status: "provider_unsupported",
        expectedImageParts: 1,
        deliveredImageParts: 0,
        omittedImageParts: 1,
      },
    },
  });

  assert.equal(unsupported.progress.visualContext.status, "provider_unsupported");
  const items = buildRuntimeProgressLedger({
    events: [queued, unsupported],
    turnId: "turn-visual",
    activeRunId: "run-visual",
    language: "zh",
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "failed");
  assert.equal(items[0].title, "当前模型或端点不支持截图");
  assert.doesNotMatch(items[0].title, /已识别/);
  const projection = buildRunStatusProjection(items, "zh");
  assert.ok(projection.healthSignals.some((signal) => signal.kind === "failure"));
});

test("visual progress preserves an explicit bounded observation separately from delivery", () => {
  const observed = withEventSchema({
    type: "progress.updated",
    threadId: "thread-visual-observed",
    turnId: "turn-visual-observed",
    runId: "run-visual-observed",
    parentRunId: null,
    timestampMs: 30,
    progress: {
      phase: "understanding",
      title: "模型已报告截图观察",
      status: "done",
      audience: "user",
      tool: "visual_context",
      target: "images:1",
      visualContext: {
        status: "delivered",
        expectedImageParts: 1,
        deliveredImageParts: 1,
        omittedImageParts: 0,
        recognition: "observed",
        observationSummary: "A compact toolbar is visible.",
        observationId: "visual-observed-1",
      },
    },
  });

  assert.equal(observed.progress.visualContext.status, "delivered");
  assert.equal(observed.progress.visualContext.recognition, "observed");
  assert.equal(observed.progress.visualContext.observationSummary, "A compact toolbar is visible.");
  assert.equal(observed.progress.visualContext.observationId, "visual-observed-1");
  const items = buildRuntimeProgressLedger({
    events: [observed],
    turnId: "turn-visual-observed",
    activeRunId: "run-visual-observed",
    language: "zh",
  });
  const projection = buildRunStatusProjection(items, "zh");
  assert.equal(
    projection.currentActivity,
    null,
    "a delivered/observed screenshot is a milestone, not perpetual current activity",
  );
  const guidance = buildCapsuleGuidanceText(projection, "zh");
  assert.equal(guidance, "");
  assert.equal(projection.lastGuidanceActivity, null);
});
