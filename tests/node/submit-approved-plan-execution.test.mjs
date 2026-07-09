import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

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
  moduleCache.set(normalizedPath, module.exports);
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
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildApprovedPlanExecutionPrompt,
  buildPlanCommandExecutionHint,
  detectRequestedRootMarkdownDeliverables,
  ensureApprovedPlanRuntimeTasksForState,
  formatPlanTaskListForPrompt,
  normalizeApprovedPlanTaskStatuses,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitApprovedPlanExecution.ts"),
);

function task(overrides = {}) {
  return {
    id: "task-1",
    text: "运行 `npm test`",
    completed: false,
    source: "runtime",
    evidence: [{ kind: "cmd", value: "npm test" }],
    ...overrides,
  };
}

function baseState(overrides = {}) {
  return {
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    isPlanApproved: true,
    currentTurnId: "turn-1",
    conversationTurns: [
      {
        id: "turn-1",
        userPrompt: "请在项目根目录生成 Report.md 和 plan.md",
      },
    ],
    ...overrides,
  };
}

test("approved plan execution detects requested root markdown deliverables", () => {
  assert.deepEqual(
    detectRequestedRootMarkdownDeliverables("Write project root CHANGELOG.md and README.md, ignore plan.md"),
    ["CHANGELOG.md", "Readme.md"],
  );
  assert.deepEqual(
    detectRequestedRootMarkdownDeliverables("请在项目根目录生成总结 md 文档"),
    ["Readme.md"],
  );
});

test("approved plan execution formats task list and command hints", () => {
  const tasks = [task(), task({ id: "task-2", text: "修复 src/App.tsx", evidence: [{ kind: "file", value: "src/App.tsx" }] })];

  const list = formatPlanTaskListForPrompt(tasks, "zh");
  const hint = buildPlanCommandExecutionHint(tasks, "zh");

  assert.match(list, /1\. 运行 `npm test` \[cmd:npm test\]/);
  assert.match(list, /2\. 修复 src\/App\.tsx \[file:src\/App\.tsx\]/);
  assert.match(hint, /运行 `npm test`/);
  assert.match(hint, /run_command/);
});

test("approved plan execution prompt preserves runtime task and requested deliverable hints", () => {
  const prompt = buildApprovedPlanExecutionPrompt({
    state: baseState({
      planArtifacts: [
        {
          kind: "design",
          path: ".MAIN/plans/design.md",
          title: "Design",
          content: "# Design",
          updatedAt: 1,
        },
      ],
    }),
    language: "zh",
    executionPlanTasks: [task({ text: "实现 Report.md 输出 — 证据: file:Report.md" })],
    normalizedApprovalChoice: "execute",
  });

  assert.match(prompt, /计划已批准/);
  assert.match(prompt, /项目根目录 `Report\.md`/);
  assert.match(prompt, /MAIN 已经从批准后的 design 派生出 runtime 任务清单/);
  assert.match(prompt, /实现 Report\.md 输出/);
});

test("approved plan execution normalizes existing runtime tasks without requiring plan artifacts", () => {
  const state = baseState({
    planTasks: [task({ id: "task-1", completed: true })],
  });

  const normalized = ensureApprovedPlanRuntimeTasksForState(state, "en");
  const statuses = normalizeApprovedPlanTaskStatuses(state.planTasks, [], true);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].text, "运行 `npm test`");
  assert.equal(statuses.length, 1);
});
