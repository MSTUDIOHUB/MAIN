import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

  const source = fs.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    runtimeRequire,
  );
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { buildSubagentAssignmentUpdate } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/collaborationPresentation.ts"),
);

test("an admitted subagent produces a complete durable ChatArea assignment", () => {
  const update = buildSubagentAssignmentUpdate({
    language: "zh",
    request: {
      objective: [
        "追踪编辑器标签标题从文件状态到 DOM 渲染的完整链路。",
        "确认保存弹窗与打开文件后的异常是否共享同一状态根因。",
      ].join("\n"),
      successCriteria: "给出可复核的源码证据。",
      expectedOutput: "返回涉及的文件、符号、根因和建议修复边界。",
    },
    result: {
      subagentId: "subagent-euler",
      runId: "run-euler",
      name: "Euler",
      accessMode: "read",
      taskKind: "explore",
      allowedPaths: ["src/main.js", "src/components/editor.js"],
    },
  });

  assert.match(update, /^我已把一项独立工作交给子智能体 \*\*Euler\*\*/);
  assert.match(update, /\*\*分工\*\*/);
  assert.match(update, /追踪编辑器标签标题从文件状态到 DOM 渲染的完整链路。/);
  assert.match(update, /确认保存弹窗与打开文件后的异常是否共享同一状态根因。/);
  assert.match(update, /\*\*授权范围\*\*/);
  assert.match(update, /`src\/main\.js`、`src\/components\/editor\.js`（只读调查）/);
  assert.match(update, /\*\*预期交付\*\*/);
  assert.match(update, /返回涉及的文件、符号、根因和建议修复边界。/);
  assert.doesNotMatch(update, /\.\.\.|…/);
});
