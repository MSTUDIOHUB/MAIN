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

const { buildSystemPrompt } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/systemPrompt.ts"),
);

function createInstructionLayer(title, content, kind = "scoped_rule") {
  return {
    id: `${kind}:${title}`,
    title,
    content,
    order: 0,
    source: {
      id: `${kind}:${title}:source`,
      name: title,
      kind,
      path: `.MAIN/${title}`,
      enabled: true,
      order: 0,
    },
  };
}

test("discuss intent still injects workspace instructions and templates", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "nexus_research",
    "",
    [],
    [],
    "chat",
    "zh",
    {
      layers: [
        createInstructionLayer(
          "rules/data_analysis_workflow.md",
          "Rule content: auto fallback in chat mode.",
        ),
      ],
      templates: [
        createInstructionLayer(
          "templates/report/data_summary.md",
          "# Data Summary Template",
          "template",
        ),
      ],
      sources: [],
      matchedRules: [],
      associatedPaths: [],
      loadedAt: Date.now(),
      debugSummary: "test",
    },
  );

  assert.match(prompt, /\[TURN INTENT: DISCUSS\]/);
  assert.match(prompt, /\[WORKSPACE INSTRUCTIONS\]/);
  assert.match(prompt, /Rule content: auto fallback in chat mode\./);
  assert.match(prompt, /\[WORKSPACE TEMPLATES\]/);
  assert.match(prompt, /# Data Summary Template/);
});

test("data analyst chat prompt tells the model to auto-fallback on read-only failures", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "nexus_research",
    "",
    [],
    [],
    "chat",
    "zh",
    null,
  );

  assert.match(prompt, /不要为了这种只读降级向用户申请批准/);
  assert.match(prompt, /不要停下来征求用户是否允许降级/);
  assert.match(prompt, /推荐回退顺序：`analyze_tabular_document` 全表概览 → `query_tabular_document` 结构化筛选\/聚合 → `read_document` 原始行窗口\/分页读取/);
  assert.match(prompt, /避免输出“我将再次执行”“请稍候确认是否同意降级”这类过程化台词/);
  assert.match(prompt, /不要先输出“下一步行动计划”“请稍候，我将开始分析”之类的过渡台词后停住/);
  assert.match(prompt, /一旦你判断需要读取本地文件才能回答，就在同一轮直接调用只读工具/);
});

test("system prompt uses English core tool protocol with localized output strategy", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "main_mode",
    "",
    [],
    [],
    "chat",
    "zh",
    null,
  );

  assert.match(prompt, /\[CORE TOOL PROTOCOL\]/);
  assert.match(prompt, /Prompt language strategy: english_core_localized_output/);
  assert.match(prompt, /Tool availability is intent-scoped/);
  assert.match(prompt, /\[LOCALIZED USER OUTPUT\]/);
  assert.match(prompt, /本轮已解析的目标语言/);
  assert.doesNotMatch(prompt, /在执行文件读取、搜索、修改、构建、测试等操作前，必须先用普通 Markdown 输出一句/);
  assert.doesNotMatch(prompt, /调用工具前，先用普通 Markdown 写一句用户可见的操作说明/);
});

test("system prompt lists only intent-filtered tools when available names are provided", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "main_mode",
    "",
    [],
    [],
    "plan",
    "zh",
    null,
    undefined,
    undefined,
    "english_core_localized_output",
    "normal",
    ["read_file", "write_file", "replace_in_file"],
  );

  assert.match(prompt, /可用的工具：read_file, replace_in_file, write_file|可用的工具：read_file, write_file, replace_in_file/);
  assert.doesNotMatch(prompt, /run_command/);
  assert.doesNotMatch(prompt, /execute_command/);
});

test("data analyst plan prompt uses interactive planning and analysis semantics", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "nexus_research",
    "",
    [],
    [],
    "plan",
    "zh",
    null,
  );

  assert.match(prompt, /\[TURN INTENT: PLAN\]/);
  assert.match(prompt, /交互式规划回合/);
  assert.match(prompt, /关键决策点用可点击选项引导用户/);
  assert.match(prompt, /选项必须通用真实/);
  assert.match(prompt, /用户能真实拍板的选择/);
  assert.match(prompt, /Design-First 计划落盘规则/);
  assert.match(prompt, /默认只把可审批方案写入 `\.MAIN\/plans\/design\.md`/);
  assert.match(prompt, /requirements\.md.*审批的前置条件/);
  assert.match(prompt, /复杂实现默认包含 1 个简短 Mermaid 图/);
  assert.match(prompt, /简单结构不需要，除非用户明确要求生成图/);
  assert.match(prompt, /数据分析\/报表类请求：规划阶段优先输出分析目标、数据范围、指标口径、报表结构、验证方式/);
  assert.match(prompt, /复杂实现请求默认生成精简的 `\.MAIN\/plans\/design\.md` 草稿供审批/);
  assert.match(prompt, /批准执行前仍然不能写源码或生成 tasks\.md/);
  assert.doesNotMatch(prompt, /必须生成精简的 `\.MAIN\/plans\/requirements\.md` 与 `\.MAIN\/plans\/design\.md`/);
});

test("system prompt tells the model to stop after emitting user options", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "nexus_general",
    "",
    [],
    [],
    "plan",
    "zh",
    null,
  );

  assert.match(prompt, /一旦你输出了 `<user_options>`，本轮就应立即停止并等待用户点击/);
  assert.match(prompt, /不要假装提问后又自己继续往下执行/);
});

test("discuss prompt no longer tells the user to switch Chat or Fast or Plan", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "nexus_general",
    "",
    [],
    [],
    "chat",
    "zh",
    null,
  );

  assert.doesNotMatch(prompt, /切换到 Fast \/ Plan/);
  assert.doesNotMatch(prompt, /切换到工程实现 MAIN 场景/);
  assert.match(prompt, /\[TURN INTENT: DISCUSS\]/);
});

test("game studio prompt exposes protocol paths and sticky specialist context", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "nexus_game_studio",
    "",
    [],
    [],
    "chat",
    "zh",
    null,
    {
      initialized: true,
      activeStudioAgentKey: "creative-director",
      pendingSlashCommand: {
        type: "workflow",
        slug: "start",
        args: "",
        canonicalCommand: "/start",
      },
    },
  );

  assert.match(prompt, /\[MAIN GAME STUDIO\]/);
  assert.match(prompt, /protocolEntry: \.protocols\/game-studio\/SKILL\.md/);
  assert.match(prompt, /activeStudioAgent: creative-director/);
  assert.match(prompt, /pendingSlashCommand: \/start/);
  assert.match(prompt, /templateLoading: game-studio templates are stored on disk and must be read on demand/);
  assert.match(prompt, /Game Studio Pack 已初始化/);
});

test("execute prompt forbids pseudo tool call placeholders", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "nexus_game_studio",
    "",
    [],
    [],
    "studio_workflow",
    "zh",
    null,
    {
      initialized: true,
      activeStudioAgentKey: "studio_auto",
      pendingSlashCommand: null,
    },
    "studio_workflow",
    "english_core_localized_output",
    "normal",
    ["read_file", "replace_in_file"],
  );

  assert.match(prompt, /禁止输出 `\[Tool call: \.\.\.\]`/);
  assert.match(prompt, /必须输出完整 `<tool_use>`/);
});

test("active protocol packages advertise the exact entry path instead of a bare file name", () => {
  const prompt = buildSystemPrompt(
    [{
      id: "pkg-1",
      name: "Auto Optimize",
      desc: "",
      content: "",
      active: true,
      type: "package",
      packagePath: ".protocols/Auto-Optimize-main-1776311699903/Auto-Optimize-main",
      entryPoint: "SKILL.md",
      workspaceScope: "/tmp/workspace",
    }],
    "/tmp/workspace",
    "nexus_general",
    "",
    [],
    [],
    "chat",
    "zh",
    null,
  );

  assert.match(prompt, /Entry: \.protocols\/Auto-Optimize-main-1776311699903\/Auto-Optimize-main\/SKILL\.md/);
  assert.match(prompt, /不要只传裸文件名/);
});

test("Unity MCP-first prompt explicitly prioritizes read_console over local scans", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "main_mode",
    "",
    [],
    ["read_console", "manage_scene"],
    "chat",
    "zh",
    null,
    undefined,
    "analyze",
    "english_core_localized_output",
    "normal",
    ["read_console", "get_project_skeleton", "read_file"],
    { kind: "unity", action: "console_diagnostics" },
    {
      unityMcpFirst: true,
      unityConsoleFirst: true,
      connectedServerNames: ["Unity"],
    },
  );

  assert.match(prompt, /\[UNITY MCP PRIORITY\]/);
  assert.match(prompt, /Do not start with get_project_skeleton or local log file scanning/);
  assert.match(prompt, /call read_console first/);
});
