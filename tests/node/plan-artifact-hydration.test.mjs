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
      ".MAIN/plans/design.md",
      "# Design\n\n## 方案\n\nconversation intent 保持 plan，runtime intent 在批准后使用 execute，计划面板继续显示任务进度。\n\n## 验证\n\n- 覆盖计划文件 hydrate。\n- 覆盖执行工具能力和恢复提示。\n",
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
    ".MAIN/plans/requirements.md",
    ".MAIN/plans/design.md",
    ".MAIN/plans/tasks.md",
  ]);
  assert.equal(hydrated.hasTasksArtifact, true);
  assert.equal(hydrated.tasks.length, 2);
  assert.equal(hydrated.tasks[0].evidence[0].value, "src/lib/orchestrator.ts");
});

test("hydrates design-only plans without requiring requirements.md", async () => {
  const files = new Map([
    [
      ".MAIN/plans/design.md",
      "# Design\n\n## 方案\n\n默认计划模式只需要 design.md 作为可审批方案，内容包含当前状态发现、影响文件、执行顺序、风险和验证方式。\n\n## 验证\n\n- 缺少 requirements.md 不会阻止计划进入审阅。\n- 批准后再从 design.md 生成 tasks.md。\n",
    ],
  ]);

  const hydrated = await hydratePlanArtifactsFromReader(async (filePath) => {
    if (!files.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
    return files.get(filePath);
  }, "zh", 2000);

  assert.deepEqual(hydrated.artifacts.map((artifact) => artifact.path), [
    ".MAIN/plans/design.md",
  ]);
  assert.equal(hydrated.artifacts[0].kind, "design");
  assert.equal(hydrated.hasTasksArtifact, false);
  assert.equal(hydrated.tasks.length, 0);
});

test("available path filter avoids probing missing optional tasks.md", async () => {
  const readPaths = [];
  const files = new Map([
    [
      ".MAIN/plans/design.md",
      "# Design\n\n## 方案\n\n计划恢复时先列出实际存在的计划文件，只读取 design.md，不把缺失的 tasks.md 当作必读输入。影响文件包括 src/store/useAppStore.ts 和 src/lib/planArtifactHydration.ts，执行顺序是先收窄读取范围，再恢复 runtime 任务清单。\n\n## 验证\n\n- 不读取缺失的 tasks.md。\n- 仍可恢复 design 方案。\n- 运行 node --test tests/node/plan-artifact-hydration.test.mjs。\n",
    ],
  ]);

  const hydrated = await hydratePlanArtifactsFromReader(async (filePath) => {
    readPaths.push(filePath);
    if (!files.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
    return files.get(filePath);
  }, "zh", 3000, { availablePaths: [".MAIN/plans/design.md"] });

  assert.deepEqual(readPaths, [".MAIN/plans/design.md"]);
  assert.deepEqual(hydrated.artifacts.map((artifact) => artifact.path), [".MAIN/plans/design.md"]);
  assert.equal(hydrated.hasTasksArtifact, false);
});
