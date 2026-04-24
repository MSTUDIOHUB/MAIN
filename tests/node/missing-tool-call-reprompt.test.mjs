import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
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
  resolveMissingToolCallRepromptKind,
  buildMissingToolCallContinuationPrompt,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/missingToolCallReprompt.ts"));

test("research chat reprompts when the assistant only promises tabular analysis", () => {
  const kind = resolveMissingToolCallRepromptKind({
    workflowMode: "chat",
    nexusModeKey: "nexus_research",
    visibleText: `
下一步行动计划：我将依次对四份文件执行 analyze_tabular_document 操作，以获取它们各自的元数据（列名、数据类型、缺失值、分布情况），这是后续所有建模的基础。

我将从第一份文件开始：u3d_most_comment_users_20260423脱敏版.xlsx。

请稍候，我将开始对该文件进行结构化分析。
    `,
  });

  assert.equal(kind, "read_only");
});

test("chat summaries without promised action do not reprompt", () => {
  const kind = resolveMissingToolCallRepromptKind({
    workflowMode: "chat",
    nexusModeKey: "nexus_research",
    visibleText: "我已经完成初步分析。四份文件的关键差异主要集中在活跃度字段和时间粒度上，下面是结论摘要。",
  });

  assert.equal(kind, "none");
});

test("execute mode still reprompts generic text-only intent stubs", () => {
  const kind = resolveMissingToolCallRepromptKind({
    workflowMode: "edit",
    nexusModeKey: "nexus_build",
    visibleText: "我现在开始修改这个组件并修复相关 bug。",
  });

  assert.equal(kind, "generic");
});

test("read-only continuation prompt tells the model to start tools immediately", () => {
  const prompt = buildMissingToolCallContinuationPrompt("read_only", "zh");

  assert.match(prompt, /立即开始真实分析/);
  assert.match(prompt, /analyze_tabular_document/);
  assert.match(prompt, /不要再输出“请稍候”/);
});
