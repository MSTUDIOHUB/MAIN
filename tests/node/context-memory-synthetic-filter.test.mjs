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

const { buildContextMemoryState } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/contextMemory.ts"),
);

test("synthetic continuation prompts are excluded from durable goal/constraint/decision memory", () => {
  const syntheticPrompt = [
    "请继续执行你的计划。注意以下规则：",
    "1. 不要询问用户指示，你自己做决定并执行。",
    "2. 必须使用 <tool_use> 格式调用工具。",
    "<tool_use>",
    "<tool>read_file</tool>",
    "<parameter name=\"path\">src/foo.ts</parameter>",
    "</tool_use>",
  ].join("\n");

  const state = buildContextMemoryState([
    { role: "user", content: "请修复登录失败问题，并保留现有鉴权约束。" },
    { role: "user", content: syntheticPrompt },
  ]);

  const goals = state.goals.map((item) => item.text).join("\n");
  const constraints = state.constraints.map((item) => item.text).join("\n");
  const decisions = state.decisions.map((item) => item.text).join("\n");

  assert.ok(goals.includes("请修复登录失败问题"));
  assert.equal(goals.includes("不要询问用户指示"), false);
  assert.equal(constraints.includes("不要询问用户指示"), false);
  assert.equal(decisions.includes("tool_use"), false);
});

test("polluted previous memory entries are cleaned before reuse", () => {
  const previous = {
    version: 1,
    id: "ctx-test",
    updatedAt: Date.now() - 1000,
    goals: [
      { text: "请继续执行你的计划。现在请立即用工具继续执行。", source: { role: "user" }, updatedAt: Date.now() - 900 },
      { text: "完成登录模块修复", source: { role: "user" }, updatedAt: Date.now() - 800 },
    ],
    constraints: [
      { text: "不要询问用户指示，你自己做决定并执行。", source: { role: "user" }, updatedAt: Date.now() - 700 },
      { text: "必须保留现有 API 兼容性", source: { role: "user" }, updatedAt: Date.now() - 600 },
    ],
    decisions: [
      { text: "Output exactly one <tool_use> block", source: { role: "assistant" }, updatedAt: Date.now() - 500 },
      { text: "选择先跑回归测试再提交", source: { role: "user" }, updatedAt: Date.now() - 400 },
    ],
    progress: [],
    evidence: [],
    files: [],
    blockers: [],
    nextSteps: [
      { text: "Now immediately continue using tools.", source: { role: "user" }, updatedAt: Date.now() - 300 },
      { text: "下一步：修复回调超时", source: { role: "assistant" }, updatedAt: Date.now() - 200 },
    ],
    openQuestions: [],
  };

  const state = buildContextMemoryState([], { previous });
  const goals = state.goals.map((item) => item.text).join("\n");
  const constraints = state.constraints.map((item) => item.text).join("\n");
  const decisions = state.decisions.map((item) => item.text).join("\n");
  const nextSteps = state.nextSteps.map((item) => item.text).join("\n");

  assert.equal(goals.includes("请继续执行你的计划"), false);
  assert.ok(goals.includes("完成登录模块修复"));
  assert.equal(constraints.includes("不要询问用户指示"), false);
  assert.ok(constraints.includes("必须保留现有 API 兼容性"));
  assert.equal(decisions.includes("Output exactly one <tool_use> block"), false);
  assert.ok(decisions.includes("选择先跑回归测试再提交"));
  assert.equal(nextSteps.includes("Now immediately continue using tools"), false);
  assert.ok(nextSteps.includes("下一步：修复回调超时"));
});
