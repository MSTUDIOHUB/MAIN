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

test("hydrates existing .MAIN/plans artifacts and tasks from a reader", async () => {
  const files = new Map([
    [
      ".MAIN/plans/requirements.md",
      "# Requirements\n\n## 需求\n\n用户批准或要求按 `.MAIN/plans` 执行时，MAIN 必须进入计划执行语义并暴露执行工具，同时保持 PlanPanel、任务证据和逐项审查。普通 Execute 长任务达到安全边界时，应保存恢复点而不是显示系统失败。\n\n## 验收\n\n- 保留逐项工具审查。\n- 不再把长任务安全边界显示成系统失败。\n",
    ],
    [
      ".MAIN/plans/plan.md",
      "# Plan\n\n## 用户目标\n\n- 让批准后的计划执行继续沿 plan.md 恢复，并保持 PlanPanel、任务证据和逐项审查。\n\n## 截图/附件观察\n\n- 未提供截图或附件；本计划基于现有计划文件和执行恢复链路。\n\n## 已读证据\n\n- `.MAIN/plans/requirements.md` 已说明执行语义和审查边界。\n- `.MAIN/plans/tasks.md` 已列出恢复逻辑与 TypeScript 检查任务。\n\n## 真实发现\n\n- conversation intent 保持 plan，runtime intent 在批准后使用 execute，计划面板继续显示任务进度。\n\n## 未验证假设\n\n- 未验证：长任务恢复时仍可能需要额外 checkpoint 文案。\n\n## 影响文件和接口\n\n- `src/lib/orchestrator.ts`\n- `src/lib/planArtifactHydration.ts`\n\n## 执行步骤\n\n1. 恢复 plan.md hydrate 为主计划上下文。\n2. 保持 tasks.md 只作为可选审计任务来源。\n\n## 验证标准\n\n- 覆盖计划文件 hydrate。\n- 覆盖执行工具能力和恢复提示。\n",
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

test("hydrates design-only plans without requiring requirements.md", async () => {
  const files = new Map([
    [
      ".MAIN/plans/plan.md",
      "# Plan\n\n## 用户目标\n\n- 默认计划模式只需要 plan.md 作为可审批方案。\n\n## 截图/附件观察\n\n- 未提供截图或附件；本计划基于用户请求和计划恢复规则。\n\n## 已读证据\n\n- `.MAIN/plans/plan.md` 是当前唯一存在的计划文件。\n\n## 真实发现\n\n- 缺少 requirements.md 不会阻止计划进入审阅。\n\n## 未验证假设\n\n- 未验证：旧会话若存在 design.md，应只作为历史辅助上下文。\n\n## 影响文件和接口\n\n- `src/lib/planArtifactHydration.ts`\n\n## 执行步骤\n\n1. 读取存在的 plan.md。\n2. 批准后再从 plan.md 派生 runtime 任务清单。\n\n## 验证标准\n\n- 缺少 requirements.md 不会阻止计划进入审阅。\n- 批准后再从 plan.md 生成 tasks.md。\n",
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
  assert.equal(hydrated.tasks.length, 0);
});

test("available path filter avoids probing missing optional tasks.md", async () => {
  const readPaths = [];
  const files = new Map([
    [
      ".MAIN/plans/plan.md",
      "# Plan\n\n## 用户目标\n\n- 恢复计划时只读取实际存在的计划文件，不把缺失的 tasks.md 当作必读输入。\n\n## 截图/附件观察\n\n- 未提供截图或附件；本计划基于可用路径过滤行为。\n\n## 已读证据\n\n- availablePaths 只包含 `.MAIN/plans/plan.md`。\n\n## 真实发现\n\n- 计划恢复时先列出实际存在的计划文件，只读取 plan.md。\n\n## 未验证假设\n\n- 未验证：旧 design.md 存在时只应作为历史辅助上下文读取。\n\n## 影响文件和接口\n\n- `src/store/useAppStore.ts`\n- `src/lib/planArtifactHydration.ts`\n\n## 执行步骤\n\n1. 先收窄读取范围。\n2. 再恢复 runtime 任务清单。\n\n## 验证标准\n\n- 不读取缺失的 tasks.md。\n- 仍可恢复 plan 方案。\n- 运行 node --test tests/node/plan-artifact-hydration.test.mjs。\n",
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
