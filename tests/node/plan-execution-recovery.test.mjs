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
  PLAN_MAX_AUTO_RESUME_LIMIT,
  buildExecuteMaxIterationsAutoResumeNotice,
  buildExecuteMaxIterationsPauseNotice,
  buildExecuteMaxIterationsResumePrompt,
  buildPlanNoProgressLoopPauseNotice,
  buildPlanProgressSignatureFromToolActivity,
  buildPlanExecutionProgressUpdate,
  buildPlanMaxIterationsCheckpoint,
  buildPlanMaxIterationsPauseNotice,
  buildPlanMaxIterationsResumePrompt,
  formatPlanExecutionProgressSnapshot,
  isCachedReadOnlyPlanActivity,
  normalizePlanExecutionProgressSnapshot,
  summarizeRepeatedPlanTargetsFromToolActivity,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planExecutionRecovery.ts"));

const {
  describeApprovedPlanRecoveryToolSurface,
  isApprovedPlanRecoveryToolName,
  shouldAllowApprovedPlanRecoveryFileRead,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/approvedPlanRecoveryTools.ts"));

const tasks = [
  {
    id: "1",
    text: "Update orchestrator recovery handling",
    status: "completed",
    evidenceStatus: "satisfied",
    evidence: [{ kind: "file", value: "src/lib/orchestrator.ts" }],
  },
  {
    id: "2",
    text: "Add resume guard tests",
    status: "in_progress",
    evidenceStatus: "partial",
    evidence: [{ kind: "file", value: "tests/node/plan-execution-recovery.test.mjs" }],
  },
];

const evidenceLedger = [
  {
    id: "plan",
    kind: "file",
    value: ".MAIN/plans/tasks.md",
    target: ".MAIN/plans/tasks.md",
    sourceTool: "write_file",
    createdAt: 1,
  },
  {
    id: "source",
    kind: "file",
    value: "src/lib/orchestrator.ts",
    target: "src/lib/orchestrator.ts",
    sourceTool: "replace_in_file",
    createdAt: 2,
  },
];

test("max-iteration checkpoint keeps internal plan files out of project-source evidence", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "replace_in_file", target: "src/lib/orchestrator.ts", status: "succeeded" }],
    lastAssistantText: "Continuing with tests.",
  });

  assert.equal(checkpoint.reason, "max_iterations_checkpoint");
  assert.equal(checkpoint.currentTask.includes("Add resume guard tests"), true);
  assert.equal(checkpoint.completedEvidence.some((line) => line.includes("src/lib/orchestrator.ts")), true);
  assert.equal(checkpoint.completedEvidence.some((line) => line.includes(".MAIN/plans")), false);
});

test("pause notice is structured and points to manual resume after one auto-resume", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: PLAN_MAX_AUTO_RESUME_LIMIT,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "run_command", target: "npm test", status: "failed", detail: "exitCode 1" }],
    unresolvedBlockers: ["Agent loop reached maximum iterations (50)."],
  });
  const notice = buildPlanMaxIterationsPauseNotice(checkpoint, "en");

  assert.match(notice, /RecoveryDetails:/);
  assert.match(notice, /autoResumeCount: 1\/1/);
  assert.match(notice, /Resume Execution/);
  assert.match(notice, /Add resume guard tests/);
});

test("execute max-iteration notices describe a recoverable boundary instead of failure", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 25,
    maxIterations: 25,
    autoResumeCount: PLAN_MAX_AUTO_RESUME_LIMIT,
    tasks: [],
    evidenceLedger: [],
    recentToolActivity: [{ name: "run_command", target: "npm test", status: "succeeded", detail: "exitCode 0" }],
    lastAssistantText: "继续验证剩余步骤。",
    unresolvedBlockers: ["Agent loop reached maximum iterations (25)."],
  });

  const autoNotice = buildExecuteMaxIterationsAutoResumeNotice({ ...checkpoint, autoResumeCount: 1 }, "zh");
  const pauseNotice = buildExecuteMaxIterationsPauseNotice(checkpoint, "zh");
  const prompt = buildExecuteMaxIterationsResumePrompt({ language: "zh", checkpoint });

  assert.match(autoNotice, /恢复点/);
  assert.match(pauseNotice, /不是工具权限或模式切换失败/);
  assert.match(pauseNotice, /Resume Execution/);
  assert.match(prompt, /如果任务已经完成，直接输出最终总结/);
});

test("resume prompt requires fresh workspace reads and treats .MAIN plans as internal state", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 1,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "replace_in_file", target: "src/store/useAppStore.ts", status: "succeeded" }],
  });
  const prompt = buildPlanMaxIterationsResumePrompt({
    language: "en",
    checkpoint,
    hasTasksArtifact: true,
    tasks,
    artifacts: [{ kind: "tasks", path: ".MAIN/plans/tasks.md", title: "Tasks", content: "- [ ] Add resume guard tests", updatedAt: 1 }],
    evidenceLedger,
  });

  assert.match(prompt, /fresh recovery context/);
  assert.match(prompt, /Do not treat `\.MAIN\/plans` as project-source evidence/);
  assert.match(prompt, /First reread current workspace state/);
  assert.match(prompt, /Add resume guard tests/);
});

test("resume prompt does not tell the model to read missing optional tasks.md", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 1,
    tasks,
    evidenceLedger: [],
    recentToolActivity: [{ name: "read_file", target: "src/App.tsx", status: "succeeded" }],
  });
  const prompt = buildPlanMaxIterationsResumePrompt({
    language: "zh",
    checkpoint,
    hasTasksArtifact: false,
    tasks,
    artifacts: [{ kind: "design", path: ".MAIN/plans/plan.md", title: "Design", content: "# Design\n\n方案", updatedAt: 1 }],
    evidenceLedger: [],
  });

  assert.match(prompt, /runtime 任务清单/);
  assert.match(prompt, /不要为了确认它是否存在而读取它/);
  assert.doesNotMatch(prompt, /先重新读取当前 workspace 状态和 `\.MAIN\/plans\/tasks\.md`/);
});

test("empty checkpoint fallback treats tasks.md as optional", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 1,
    tasks: [],
    evidenceLedger: [],
    recentToolActivity: [{ name: "read_file", target: "src/App.tsx", status: "succeeded" }],
  });
  const notice = buildPlanMaxIterationsPauseNotice(checkpoint, "zh");

  assert.match(checkpoint.currentTask, /runtime task list/);
  assert.match(checkpoint.remainingTasks.join("\n"), /Read tasks\.md only if it is already known to exist/);
  assert.match(notice, /runtime 任务清单/);
  assert.match(notice, /只有已知存在时才读取 tasks\.md/);
  assert.doesNotMatch(notice, /重新读取 tasks\.md/);
});

test("plan execution progress snapshot is structured and ignores internal plan evidence", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "en",
    phase: "tool_done",
    iterationCount: 7,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "replace_in_file", target: "src/lib/orchestrator.ts", status: "succeeded" }],
  });
  const snapshot = normalizePlanExecutionProgressSnapshot({
    turnId: "turn-1",
    update,
    now: 123,
  });
  const text = formatPlanExecutionProgressSnapshot(snapshot, "en");

  assert.equal(snapshot.turnId, "turn-1");
  assert.equal(snapshot.phase, "tool_done");
  assert.equal(snapshot.iteration, 7);
  assert.match(snapshot.currentTask, /Update orchestrator recovery handling/);
  assert.match(snapshot.latestEvidence, /src\/lib\/orchestrator\.ts/);
  assert.match(snapshot.nextStep, /Add resume guard tests/);
  assert.doesNotMatch(snapshot.latestEvidence, /\.MAIN\/plans/);
  assert.match(text, /Tool done/);
  assert.match(text, /Tool result recorded/);
  assert.doesNotMatch(text, /Current task:/);
  assert.doesNotMatch(text, /Latest evidence:/);
  assert.doesNotMatch(text, /Current tool:/);
  assert.doesNotMatch(text, /Next:/);
});

test("no-progress loop notice names repeated target evidence gap and recovery action", () => {
  const recentToolActivity = [
    { name: "read_file", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts" },
    { name: "read_file", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts" },
    { name: "read_file", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts" },
  ];
  const notice = buildPlanNoProgressLoopPauseNotice({
    language: "zh",
    repeats: 3,
    remainingTask: "测试所有页面和组件 [需要浏览器验证]",
    evidenceLedger,
    recentToolActivity,
  });
  const signature = buildPlanProgressSignatureFromToolActivity(recentToolActivity);

  assert.match(notice, /连续重复探索/);
  assert.match(notice, /src\/store\/dashboardstore\.ts/i);
  assert.match(notice, /缺失证据：测试所有页面和组件/);
  assert.match(notice, /Browser\/Playwright/);
  assert.match(signature, /cached/);
});

test("cached read-only helpers identify repeated plan targets", () => {
  const recentToolActivity = [
    { name: "grep_search", target: "loadOrders", status: "succeeded", detail: "src/store/dashboardStore.ts:307" },
    { name: "read_file", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts" },
    { name: "read_file", target: "src/hooks/useChartData.ts", status: "succeeded", detail: "READ_FILE_RESULT path: src/hooks/useChartData.ts" },
  ];

  assert.equal(isCachedReadOnlyPlanActivity(recentToolActivity[1]), true);
  assert.equal(isCachedReadOnlyPlanActivity(recentToolActivity[2]), false);
  assert.deepEqual(
    summarizeRepeatedPlanTargetsFromToolActivity(recentToolActivity),
    ["src/store/dashboardstore.ts"],
  );
});

test("approved plan strategy switch continues the agent loop after recovery prompt", () => {
  const orchestratorSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator.ts"),
    "utf8",
  );

  assert.match(
    orchestratorSource,
    /if\s*\(\s*truncatedAfterCachedReadOnly\s*\)\s*{[\s\S]*?continueApprovedPlanWithStrategySwitch\(recoveryInput\);\s*continue;/,
  );
  assert.match(
    orchestratorSource,
    /if\s*\(\s*approvedPlanNoProgressDecision\s*\)\s*{[\s\S]*?approvedPlanNoProgressDecision\.action\s*===\s*"recover"[\s\S]*?continueApprovedPlanWithStrategySwitch\(approvedPlanNoProgressDecision\);\s*continue;/,
  );
});

test("approved plan no-progress recovery keeps targeted reads without broad discovery", () => {
  const orchestratorSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator.ts"),
    "utf8",
  );
  const readOnlyTools = new Set([
    "get_project_skeleton",
    "list_directory",
    "glob_search",
    "grep_search",
    "read_file",
    "get_file_outline",
    "read_pty_buffer",
    "get_pty_status",
  ]);
  const fullToolNames = [
    "list_directory",
    "glob_search",
    "grep_search",
    "read_file",
    "replace_in_file",
    "write_file",
    "run_command",
    "browser_evaluate",
    "get_file_outline",
    "get_pty_status",
  ];

  const cachedReadRecoveryTools = fullToolNames.filter((name) =>
    isApprovedPlanRecoveryToolName(name, readOnlyTools, { allowFileRead: false })
  );
  const patchRecoveryTools = fullToolNames.filter((name) =>
    isApprovedPlanRecoveryToolName(name, readOnlyTools, { allowFileRead: true })
  );

  assert.deepEqual(cachedReadRecoveryTools, [
    "grep_search",
    "read_file",
    "replace_in_file",
    "write_file",
    "run_command",
    "browser_evaluate",
    "get_file_outline",
    "get_pty_status",
  ]);
  assert.equal(patchRecoveryTools.includes("read_file"), true);
  assert.equal(patchRecoveryTools.includes("list_directory"), false);
  assert.equal(
    shouldAllowApprovedPlanRecoveryFileRead([
      { name: "read_file", target: "src/App.tsx", status: "succeeded", detail: "FILE_UNCHANGED_STUB" },
    ]),
    false,
  );
  assert.equal(
    shouldAllowApprovedPlanRecoveryFileRead([
      { name: "replace_in_file", target: "src/App.tsx", status: "failed", detail: "search_text 与文件内容不一致，未执行写入。" },
    ]),
    true,
  );
  assert.equal(
    shouldAllowApprovedPlanRecoveryFileRead([
      { name: "replace_in_file", target: "src/App.tsx", status: "failed", detail: "search_text 与文件内容不一致，未执行写入。" },
      { name: "read_file", target: "src/App.tsx", status: "succeeded", detail: "READ_FILE_RESULT" },
    ]),
    false,
  );
  assert.equal(describeApprovedPlanRecoveryToolSurface(false), "action_plus_targeting_reads");
  assert.equal(describeApprovedPlanRecoveryToolSurface(true), "action_plus_patch_file_read");
  assert.match(
    orchestratorSource,
    /recoveryIterationAllTools\.filter\(\(tool\)\s*=>\s*isApprovedPlanRecoveryTool\(tool,[\s\S]*allowFileRead: allowApprovedPlanRecoveryFileRead/,
  );
  assert.doesNotMatch(
    orchestratorSource,
    /rawIterationAllTools\.filter\(isApprovedPlanActionTool\)/,
  );
  assert.match(orchestratorSource, /targeted `read_file`/);
  assert.match(orchestratorSource, /exact current content/);
});

test("plan progress snapshot carries no-progress recovery metadata", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "paused",
    iterationCount: 8,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "read_file", target: "src/store/dashboardStore.ts", status: "succeeded", detail: "FILE_UNCHANGED_STUB" }],
    progressSignature: "read_file:src/store/dashboardStore.ts:succeeded:cached",
    repeatedTargets: ["src/store/dashboardStore.ts"],
    recoveryReason: "no_progress_batch_loop",
  });
  const snapshot = normalizePlanExecutionProgressSnapshot({
    turnId: "turn-repeat",
    update,
    now: 456,
  });

  assert.equal(snapshot.recoveryReason, "no_progress_batch_loop");
  assert.deepEqual(snapshot.repeatedTargets, ["src/store/dashboardStore.ts"]);
  assert.match(snapshot.progressSignature, /cached/);
});

test("plan execution progress prefers active tool-matched task over broad first pending task", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "tool_start",
    iterationCount: 3,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks: [
      {
        id: "broad",
        text: "目标：修复 4 个核心问题，同时按 Linear.app 设计规范重构 UI 配色",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "text", value: "overall dashboard polish" }],
      },
      {
        id: "upload",
        text: "修复 DragUpload 导入状态和 CSV 数据流",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "file", value: "src/components/FileUploader/DragUpload.tsx" }],
      },
    ],
    evidenceLedger: [],
    recentToolActivity: [{ name: "replace_in_file", target: "src/components/FileUploader/DragUpload.tsx", status: "succeeded" }],
  });

  assert.match(update.currentTask, /DragUpload/);
  assert.doesNotMatch(update.currentTask, /^目标：/);
});

test("plan execution progress shows current action when first pending task is too broad", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "zh",
    phase: "tool_start",
    iterationCount: 4,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks: [
      {
        id: "broad",
        text: "目标：修复 4 个核心问题，同时按 Linear.app 设计规范重构 UI 配色",
        status: "pending",
        evidenceStatus: "missing",
        evidence: [{ kind: "text", value: "overall dashboard polish" }],
      },
    ],
    evidenceLedger: [],
    recentToolActivity: [{ name: "read_file", target: "src/App.tsx", status: "succeeded" }],
  });

  assert.match(update.currentTask, /当前动作：/);
  assert.match(update.currentTask, /src\/App\.tsx/);
});
