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
  buildChatRenderSegments,
  buildRepeatedBrowserFailureSignature,
  getRepeatedBrowserFailureCallsForUi,
  summarizeBrowserFailureForUi,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolUiGrouping.ts"));
const { dedupeModelFeedbackText, createModelFeedbackDedupeState } = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/modelFeedbackDedupe.ts"));

test("model feedback plus three reads renders as one collapsed operation cluster", () => {
  const segments = buildChatRenderSegments({
    language: "zh",
    includeUser: false,
    blocks: [
      { id: 1, type: "agent", content: "根据截图观察到的现象：CSV 已加载，但图表没有渲染。", streaming: false },
      { id: 2, type: "tool", toolName: "read_file", target: "src/App.tsx", toolStatus: "executed" },
      { id: 3, type: "tool", toolName: "read_file", target: "src/components/Dashboard/OverviewCards.tsx", toolStatus: "executed" },
      { id: 4, type: "tool", toolName: "read_file", target: "src/components/Dashboard/CourseBarChart.tsx", toolStatus: "executed" },
    ],
  });

  assert.equal(segments.length, 2);
  assert.equal(segments[0].kind, "block");
  assert.equal(segments[1].kind, "operationCluster");
  assert.equal(segments[1].cluster.totalCount, 3);
  assert.match(segments[1].cluster.title, /已读取 3 项上下文/);
  assert.match(segments[1].cluster.countSummary, /3 次读取/);
});

test("thin repeated read narration is suppressed while substantive findings remain visible", () => {
  const segments = buildChatRenderSegments({
    language: "zh",
    includeUser: false,
    blocks: [
      { id: 1, type: "agent", content: "从已读取的文件中，我发现数据 hook 返回空数组，这是需要验证的根因。", streaming: false },
      { id: 2, type: "tool", toolName: "read_file", target: "src/hooks/useChartData.ts", toolStatus: "executed" },
      { id: 3, type: "agent", content: "让我继续读取关键文件来确认问题根因。", streaming: false },
      { id: 4, type: "tool", toolName: "read_file", target: "src/store/dashboardStore.ts", toolStatus: "executed" },
      { id: 5, type: "agent", content: "让我继续读取关键文件来确认问题根因。", streaming: false },
      { id: 6, type: "tool", toolName: "read_file", target: "src/styles/theme.css", toolStatus: "executed" },
    ],
  });

  assert.equal(segments.length, 2);
  assert.equal(segments[0].kind, "block");
  assert.match(segments[0].block.content, /发现数据 hook/);
  assert.equal(segments[1].kind, "operationCluster");
  assert.equal(segments[1].cluster.totalCount, 3);
});

test("commands and failed tools are not swallowed by read/search clusters", () => {
  const segments = buildChatRenderSegments({
    language: "zh",
    includeUser: false,
    completedToolGrouping: {
      enabled: true,
      includeReadContextTools: true,
      includeDiff: true,
      minGroupSize: 2,
    },
    blocks: [
      { id: 1, type: "tool", toolName: "read_file", target: "package.json", toolStatus: "executed" },
      { id: 2, type: "tool", toolName: "run_command", target: "npm run build", toolStatus: "executed", message: "ok" },
      { id: 3, type: "tool", toolName: "read_file", target: "src/App.tsx", toolStatus: "executed" },
      { id: 4, type: "tool", toolName: "read_file", target: "src/Missing.tsx", toolStatus: "failed", message: "missing" },
    ],
  });

  assert.equal(segments.length, 4);
  assert.equal(segments[0].kind, "operationCluster");
  assert.equal(segments[1].kind, "block");
  assert.equal(segments[1].block.toolName, "run_command");
  assert.equal(segments[2].kind, "operationCluster");
  assert.equal(segments[3].kind, "block");
  assert.equal(segments[3].block.toolStatus, "failed");
});

test("single project skeleton renders as the opencode-style Explore cluster", () => {
  const segments = buildChatRenderSegments({
    language: "zh",
    includeUser: false,
    blocks: [
      { id: 1, type: "agent", content: "我会先整体理解项目结构。", streaming: false },
      { id: 2, type: "tool", toolName: "get_project_skeleton", target: "", toolStatus: "executed" },
    ],
  });

  assert.equal(segments.length, 2);
  assert.equal(segments[1].kind, "operationCluster");
  assert.equal(segments[1].cluster.kind, "explore");
  assert.match(segments[1].cluster.title, /Explore.*探索项目结构/);
});

test("dedupe keeps substantive repeated-looking findings but suppresses thin duplicates", () => {
  const state = createModelFeedbackDedupeState();
  const first = dedupeModelFeedbackText("让我继续读取关键文件来确认问题根因。", state);
  const second = dedupeModelFeedbackText("让我继续读取关键文件来确认问题根因。", state);
  const finding = dedupeModelFeedbackText("我发现主题变量没有绑定到图表容器，这是根因。", state);

  assert.equal(first.shouldSuppress, false);
  assert.equal(second.shouldSuppress, true);
  assert.equal(second.reason, "thin_duplicate");
  assert.equal(finding.shouldSuppress, false);
});

function failedBrowserBlock({
  id,
  selector = "#new-file-btn",
  reason = `runtime_error: locator.click: Timeout 15000ms exceeded. Call log: - waiting for locator('${selector}').first() | action_failed: click: ${selector}`,
  screenshot = `.MAIN/browser-validation/browser-${id}.png`,
  requestedChecks,
}) {
  const result = {
    ok: false,
    failureSummary: reason,
    failureReasons: ["runtime_error", "action_failed"],
    actions: [{ id: "action-1", kind: "click", value: selector, ok: false }],
    screenshotPath: screenshot,
    ...(requestedChecks ? { requestedChecks } : {}),
  };
  return {
    id,
    type: "tool",
    toolName: "browser_evaluate",
    toolStatus: "failed",
    target: "http://localhost:1420/",
    message: `BROWSER_VALIDATION_FAILED: ${reason}\n${JSON.stringify(result)}`,
    evidence: `evidence-${id}`,
  };
}

test("identical consecutive browser failures collapse into one card with every raw call retained", () => {
  const blocks = [
    failedBrowserBlock({ id: 11 }),
    failedBrowserBlock({ id: 12 }),
    failedBrowserBlock({ id: 13 }),
  ];
  const segments = buildChatRenderSegments({ blocks, language: "zh" });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "block");
  assert.equal(segments[0].index, 0);
  const grouped = JSON.parse(segments[0].block.message);
  assert.equal(grouped.type, "MAIN_REPEATED_BROWSER_FAILURE");
  assert.equal(grouped.repeatCount, 3);
  assert.deepEqual(grouped.calls.map((call) => call.id), [11, 12, 13]);
  assert.deepEqual(grouped.calls.map((call) => call.evidence), ["evidence-11", "evidence-12", "evidence-13"]);
  assert.match(grouped.calls[2].message, /browser-13\.png/);

  const summary = summarizeBrowserFailureForUi({
    message: segments[0].block.message,
    language: "zh",
  });
  assert.equal(summary.action, "click");
  assert.equal(summary.selector, "#new-file-btn");
  assert.equal(summary.repeatCount, 3);
  assert.match(summary.reason, /选择器超时/);
  const retainedCalls = getRepeatedBrowserFailureCallsForUi(segments[0].block.message);
  assert.equal(retainedCalls.length, 3);
  assert.match(retainedCalls[0].message, /BROWSER_VALIDATION_FAILED/);
});

test("browser failure grouping keeps distinct selectors, errors, specs, and interrupted calls separate", () => {
  const selectorA = failedBrowserBlock({ id: 21, selector: "#new-file-btn" });
  const selectorB = failedBrowserBlock({ id: 22, selector: "#new-btn" });
  assert.notEqual(buildRepeatedBrowserFailureSignature(selectorA), buildRepeatedBrowserFailureSignature(selectorB));

  const reasonA = failedBrowserBlock({ id: 23, reason: "assertion_failed: expected text A" });
  const reasonB = failedBrowserBlock({ id: 24, reason: "assertion_failed: expected text B" });
  assert.notEqual(buildRepeatedBrowserFailureSignature(reasonA), buildRepeatedBrowserFailureSignature(reasonB));

  const specA = failedBrowserBlock({ id: 25, requestedChecks: ["text: created"] });
  const specB = failedBrowserBlock({ id: 26, requestedChecks: ["selector: #editor"] });
  assert.notEqual(buildRepeatedBrowserFailureSignature(specA), buildRepeatedBrowserFailureSignature(specB));

  const interrupted = buildChatRenderSegments({
    language: "zh",
    blocks: [
      failedBrowserBlock({ id: 31 }),
      { id: 32, type: "agent", content: "检查源码后再重试。", streaming: false },
      failedBrowserBlock({ id: 33 }),
    ],
  });
  assert.equal(interrupted.length, 3);
  assert.ok(interrupted.every((segment) => segment.kind === "block"));
});

test("browser failure summary explains the page-title versus body-text mismatch", () => {
  const reason = 'runtime_error: page.waitForFunction: Timeout 15000ms exceeded. wait_for_text only searches document.body text; "MD Viewer" matches the current page title "MD Viewer" instead.';
  const result = {
    ok: false,
    failureSummary: reason,
    failureReasons: ["runtime_error", "action_failed"],
    actions: [{ kind: "wait_for_text", value: "MD Viewer", ok: false }],
  };
  const summary = summarizeBrowserFailureForUi({
    message: `BROWSER_VALIDATION_FAILED: ${reason}\n${JSON.stringify(result)}`,
    language: "zh",
  });

  assert.equal(summary.action, "wait_for_text");
  assert.equal(summary.selector, "MD Viewer");
  assert.match(summary.reason, /正文未出现目标文本/);
  assert.match(summary.reason, /页面标题/);
});
