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
  hydratePlanArtifactsFromReader,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planArtifactHydration.ts"));
const {
  validateActionablePlanArtifact,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));

function buildReviewablePlan({
  title,
  goal,
  target,
  evidence,
  change,
  validation,
}) {
  return [
    `# ${title}`,
    "",
    "## 用户目标",
    `- ${goal}`,
    "",
    "## 摘要",
    `- ${goal}`,
    `- 已读取 \`${target}\`，并确认${evidence}。`,
    "",
    "## 已读证据",
    `- \`${target}\`：${evidence}。`,
    "",
    "## 关键改动",
    `- 修改 \`${target}\`：${change}。`,
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API、接口或类型变化；保持现有定义不变。",
    "",
    "## 执行步骤",
    `1. 依据已读证据更新 \`${target}\`。`,
    "2. 保持计划审批、任务证据和恢复语义一致。",
    "",
    "## 验证标准",
    `- ${validation}。`,
    "",
    "## 测试方案",
    "- 运行 `node --test tests/node/plan-artifact-hydration.test.mjs`，确认计划恢复和可选文件过滤断言全部通过。",
    "",
    "## 假设与默认值",
    "- 默认保持现有 `.MAIN/plans` 路径和事件协议不变。",
    "",
  ].join("\n");
}

function buildUnsupportedHypothesisPlan() {
  return [
    "# MD Viewer 文件打开修复计划",
    "",
    "## 用户目标",
    "- 修复双击 Markdown 文件后窗口空白和工具栏“打开”按钮无效的问题。",
    "",
    "## 摘要",
    "- 已读取 `src-tauri/src/main.rs`、`src/main.js` 和 `src/components/toolbar.js`，确认后端事件与前端文件加载链路需要闭环。",
    "",
    "## 关键改动",
    "- 在 `src-tauri/src/main.rs` 中将解析后的文件路径发送给前端。",
    "- `src/main.js` 可能需要新增 `open-file` 事件监听器后再调用现有加载入口。",
    "- 在 `src/components/toolbar.js` 中等待 dialog Promise 完成后传入文件路径。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持现有 `open-file` 事件名称和文件路径载荷类型不变。",
    "",
    "## 执行步骤",
    "1. 先补齐 Rust 文件打开事件发送。",
    "2. 再连接前端事件监听与 dialog 异步返回值。",
    "",
    "## 验证标准",
    "- 双击 Markdown 文件和点击“打开”按钮都能加载同一文件内容。",
    "",
    "## 测试方案",
    "- 运行 `cargo check`，再在桌面应用中分别双击文件和使用文件选择器，确认编译通过且内容正确渲染。",
    "",
    "## 假设与默认值",
    "- 默认保持当前 Tauri 事件名称和 Markdown 扩展名过滤规则。",
    "",
  ].join("\n");
}

test("hydrates existing .MAIN/plans artifacts and tasks from a reader", async () => {
  const files = new Map([
    [
      ".MAIN/plans/requirements.md",
      "# Requirements\n\n## 需求\n\n用户批准或要求按 `.MAIN/plans` 执行时，MAIN 必须进入计划执行语义并暴露执行工具，同时保持 PlanPanel、任务证据和逐项审查。普通 Execute 长任务达到安全边界时，应保存恢复点而不是显示系统失败。\n\n## 验收\n\n- 保留逐项工具审查。\n- 不再把长任务安全边界显示成系统失败。\n",
    ],
    [
      ".MAIN/plans/plan.md",
      buildReviewablePlan({
        title: "Plan 执行恢复计划",
        goal: "让批准后的计划执行继续沿 plan.md 恢复，并保持 PlanPanel、任务证据和逐项审查。",
        target: "src/lib/planArtifactHydration.ts",
        evidence: "hydrate 仅从实际存在的 `.MAIN/plans` 文件恢复上下文",
        change: "恢复可审批 plan.md，并将 tasks.md 保持为可选审计任务来源",
        validation: "可审批 plan.md 与带证据 tasks.md 都被恢复",
      }),
    ],
    [
      ".MAIN/plans/tasks.md",
      "# Tasks\n\n- [ ] 更新 src/lib/orchestrator.ts 的执行恢复逻辑 — 证据: file:src/lib/orchestrator.ts\n- [ ] 运行 TypeScript 检查 — 证据: cmd:npx tsc --noEmit\n",
    ],
  ]);

  const hydrated = await hydratePlanArtifactsFromReader(async (filePath) => {
    if (!files.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
    return files.get(filePath);
  }, "zh", 1000);

  assert.deepEqual(hydrated.artifacts.map((artifact) => artifact.path), [
    ".MAIN/plans/plan.md",
    ".MAIN/plans/requirements.md",
    ".MAIN/plans/tasks.md",
  ]);
  assert.equal(hydrated.hasTasksArtifact, true);
  assert.equal(hydrated.tasks.length, 2);
  assert.equal(hydrated.tasks[0].evidence[0].value, "src/lib/orchestrator.ts");
});

test("hydrates design-only legacy plans without requiring requirements.md or tasks.md", async () => {
  const files = new Map([
    [
      ".MAIN/plans/plan.md",
      buildReviewablePlan({
        title: "Design-only Plan 恢复计划",
        goal: "默认计划模式只需 plan.md 作为可审批方案。",
        target: "src/lib/planArtifactHydration.ts",
        evidence: "缺少 requirements.md 不会阻止可审批 plan.md 恢复",
        change: "仅从存在的 plan.md 恢复主计划，批准后再派生 runtime 任务",
        validation: "只有 plan.md 时仍能恢复审批方案，且不伪造 tasks.md",
      }),
    ],
  ]);

  const hydrated = await hydratePlanArtifactsFromReader(async (filePath) => {
    if (!files.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
    return files.get(filePath);
  }, "zh", 2000);

  assert.deepEqual(hydrated.artifacts.map((artifact) => artifact.path), [
    ".MAIN/plans/plan.md",
  ]);
  assert.equal(hydrated.artifacts[0].kind, "plan");
  assert.equal(hydrated.hasTasksArtifact, false);
  assert.equal(hydrated.tasks.length, 3);
  assert.deepEqual(
    hydrated.artifacts[0].legacyTaskProjection?.map((task) => task.id),
    hydrated.tasks.map((task) => task.id),
  );
  assert.equal(hydrated.tasks.some((task) => task.executionKind === "validation"), true);
});

test("available path filter avoids probing missing optional tasks.md", async () => {
  const readPaths = [];
  const files = new Map([
    [
      ".MAIN/plans/plan.md",
      buildReviewablePlan({
        title: "Plan 可用路径过滤计划",
        goal: "恢复计划时只读取实际存在的计划文件，不把缺失的 tasks.md 当作必读输入。",
        target: "src/lib/planArtifactHydration.ts",
        evidence: "availablePaths 只包含 `.MAIN/plans/plan.md` 时仅读取该文件",
        change: "使用 availablePaths 收窄恢复读取范围，保留 plan.md 的审批语义",
        validation: "不读取缺失的 tasks.md，且仍恢复 plan.md 方案",
      }),
    ],
  ]);

  const hydrated = await hydratePlanArtifactsFromReader(async (filePath) => {
    readPaths.push(filePath);
    if (!files.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
    return files.get(filePath);
  }, "zh", 3000, { availablePaths: [".MAIN/plans/plan.md"] });

  assert.deepEqual(readPaths, [".MAIN/plans/plan.md"]);
  assert.deepEqual(hydrated.artifacts.map((artifact) => artifact.path), [".MAIN/plans/plan.md"]);
  assert.equal(hydrated.hasTasksArtifact, false);
});

test("does not hydrate a disk-written plan whose concrete changes are still unsupported hypotheses", async () => {
  const invalidPlan = buildUnsupportedHypothesisPlan();
  const quality = validateActionablePlanArtifact(invalidPlan);
  assert.equal(quality.ok, false);
  assert.equal(quality.reason, "unsupported_hypothesis_as_plan");

  const readPaths = [];
  const hydrated = await hydratePlanArtifactsFromReader(async (filePath) => {
    readPaths.push(filePath);
    if (filePath === ".MAIN/plans/plan.md") return invalidPlan;
    throw new Error(`ENOENT: ${filePath}`);
  }, "zh", 4000, { availablePaths: [".MAIN/plans/plan.md"] });

  assert.deepEqual(readPaths, [".MAIN/plans/plan.md"]);
  assert.deepEqual(hydrated.artifacts, []);
  assert.equal(hydrated.hasTasksArtifact, false);
  assert.deepEqual(hydrated.tasks, []);
});
