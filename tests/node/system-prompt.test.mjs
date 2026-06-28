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

const { buildSystemPrompt, buildToolProtocolCard } = loadTranspiledModuleSync(
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

test("respond intent still injects workspace instructions and templates", () => {
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

  assert.match(prompt, /\[TURN INTENT: RESPOND\]/);
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
  assert.match(prompt, /确认表结构、关键字段、数据类型、时间\/数值\/分类维度、缺失值和聚合口径/);
  assert.doesNotMatch(prompt, /金额、课程字段|课程字段/);
  assert.match(prompt, /避免输出“我将再次执行”“请稍候确认是否同意降级”这类过程化台词/);
  assert.match(prompt, /不要先输出“下一步行动计划”“请稍候，我将开始分析”之类的过渡台词后停住/);
  assert.match(prompt, /一旦你判断需要读取本地文件才能回答，就在同一轮直接调用只读工具/);
});

test("system prompt only adds web-search guidance when web tools are available", () => {
  const withoutWeb = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "main_mode",
    "",
    [],
    [],
    "chat",
    "zh",
    null,
    undefined,
    undefined,
    "english_core_localized_output",
    ["read_file", "grep_search"],
  );
  const withWeb = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "main_mode",
    "",
    [],
    [],
    "chat",
    "zh",
    null,
    undefined,
    undefined,
    "english_core_localized_output",
    ["read_file", "grep_search", "web_search", "web_fetch"],
  );

  assert.doesNotMatch(withoutWeb, /网络搜索已开启/);
  assert.doesNotMatch(withoutWeb, /网络搜索日期锚点/);
  assert.match(withWeb, /网络搜索已开启/);
  assert.match(withWeb, /网络搜索日期锚点/);
  assert.match(withWeb, /当前本地日期为 \d{4}-\d{2}-\d{2}/);
  assert.match(withWeb, /不要按模型训练截止日期或旧年份理解/);
  assert.match(withWeb, /来源 URL/);
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
  assert.match(prompt, /resolvedResponseLanguage/);
  assert.match(prompt, /Any user-visible pre-tool narration must also use the resolved target language/);
  assert.doesNotMatch(prompt, /[⚠🚫]/);
  assert.doesNotMatch(prompt, /在执行文件读取、搜索、修改、构建、测试等操作前，必须先用普通 Markdown 输出一句/);
  assert.doesNotMatch(prompt, /调用工具前，先用普通 Markdown 写一句用户可见的操作说明/);
});

test("system prompt separates display language from resolved response language", () => {
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
    ["read_file", "write_file"],
    null,
    undefined,
    {
      displayLanguage: "zh",
      resolvedResponseLanguage: "en",
    },
  );

  assert.match(prompt, /\[LANGUAGE CONTRACT\]/);
  assert.match(prompt, /displayLanguage: zh/);
  assert.match(prompt, /resolvedResponseLanguage: en/);
  assert.match(prompt, /MUST use English/);
  assert.doesNotMatch(prompt, /<analysis>我需要先检查/);
  assert.doesNotMatch(prompt, /<analysis>`? 仅用于极简内心备注/);
  assert.match(prompt, /不要输出 `<analysis>`、`<thought>`、`<thinking>` 或 `<reasoning>`/);
  assert.match(prompt, /需要工具时只输出完整工具调用/);
});

test("system prompt respects Chinese response language contract even if UI language is English", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "main_mode",
    "",
    [],
    [],
    "plan",
    "en",
    null,
    undefined,
    undefined,
    "english_core_localized_output",
    ["read_file", "write_file"],
    null,
    undefined,
    {
      displayLanguage: "en",
      resolvedResponseLanguage: "zh",
    },
  );

  assert.match(prompt, /\[LANGUAGE CONTRACT\]/);
  assert.match(prompt, /displayLanguage: en/);
  assert.match(prompt, /resolvedResponseLanguage: zh/);
});

test("English system prompt uses domain-neutral tabular guidance", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "main_mode",
    "",
    [],
    [],
    "plan",
    "en",
    null,
    undefined,
    undefined,
    "english_core_localized_output",
    ["read_file", "analyze_tabular_document", "query_tabular_document"],
    null,
    undefined,
    {
      displayLanguage: "en",
      resolvedResponseLanguage: "en",
    },
  );

  assert.match(prompt, /If the task is closer to reporting, summarization, or research analysis/);
  assert.match(prompt, /confirm table structure, key fields, data types, temporal\/numeric\/categorical dimensions, missing values, and aggregation semantics/);
  assert.match(prompt, /Continue analyzing the tabular parsing path/);
  assert.doesNotMatch(prompt, /amount|course|orders\.csv|written to Store|CSV parsing/i);
});

test("tool protocol card gives compact XML instructions for local text tools", () => {
  const card = buildToolProtocolCard({
    activeProfile: "local",
    provider: "Ollama",
    toolProtocol: "xml",
    nativeToolsEnabled: false,
    workflowMode: "plan",
    availableToolNames: ["read_file", "analyze_tabular_document", "query_tabular_document"],
    language: "zh",
  });

  assert.match(card, /\[TOOL PROTOCOL CARD\]/);
  assert.match(card, /protocol: xml-text/);
  assert.match(card, /<tool_use>/);
  assert.match(card, /<parameter name="path">/);
  assert.doesNotMatch(card, /orders\.csv/);
  assert.match(card, /禁止输出 `\[Tool call: read_file\]`/);
  assert.doesNotMatch(card, /run_command\(command/);
});

test("tool protocol card with no tools does not emit XML examples", () => {
  const card = buildToolProtocolCard({
    activeProfile: "local",
    provider: "OMLX",
    toolProtocol: "xml",
    nativeToolsEnabled: false,
    workflowMode: "plan",
    availableToolNames: [],
    language: "zh",
  });

  assert.match(card, /availableTools: none/);
  assert.doesNotMatch(card, /<tool_use>/);
  assert.doesNotMatch(card, /<tool>read_file<\/tool>/);
  assert.match(card, /不要输出 XML 工具块/);
});

test("workflow prompt with no tools does not show executable XML templates", () => {
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
    "plan",
    "english_core_localized_output",
    [],
    null,
    undefined,
    {
      displayLanguage: "zh",
      resolvedResponseLanguage: "zh",
    },
  );

  assert.match(prompt, /availableTools: none/);
  assert.match(prompt, /本轮没有暴露可调用工具/);
  assert.match(prompt, /没有计划写入工具时 plan\.md 不强制/);
  assert.match(prompt, /不要声称已经写入计划文件/);
  assert.doesNotMatch(prompt, /<tool_use>/);
  assert.doesNotMatch(prompt, /<tool>read_file<\/tool>/);
  assert.doesNotMatch(prompt, /plan\.md 必选/);
  assert.doesNotMatch(prompt, /先用 `get_project_skeleton`/);
});

test("English tabular XML example avoids domain-specific sample names", () => {
  const card = buildToolProtocolCard({
    activeProfile: "local",
    provider: "Ollama",
    toolProtocol: "xml",
    nativeToolsEnabled: false,
    workflowMode: "plan",
    availableToolNames: ["analyze_tabular_document"],
    language: "en",
  });

  assert.match(card, /<tool>analyze_tabular_document<\/tool>/);
  assert.match(card, /<parameter name="path">data\.csv<\/parameter>/);
  assert.doesNotMatch(card, /orders\.csv|amount|course/i);
});

test("tool protocol card uses native contract for native-capable providers", () => {
  const card = buildToolProtocolCard({
    activeProfile: "cloud",
    provider: "OpenAI",
    toolProtocol: "native",
    nativeToolsEnabled: true,
    availableToolNames: ["read_file", "write_file"],
    language: "en",
  });

  assert.match(card, /protocol: native/);
  assert.match(card, /emit a native tool call directly/);
  assert.doesNotMatch(card, /<tool_use>/);
});

test("tool protocol card adds model normalization notes for Gemma-style thought output", () => {
  const card = buildToolProtocolCard({
    activeProfile: "local",
    provider: "OMLX",
    model: "gemma-4-26b-a4b-it-8bit",
    toolProtocol: "auto",
    nativeToolsEnabled: true,
    availableToolNames: ["read_file", "replace_in_file"],
    language: "zh",
    modelProtocolNotes: [
      "Fold `thought`, `thinking`, `reasoning`, and `reasoning_content` fields or labels into hidden metadata.",
      "If a tool is needed, emit the actual tool call instead of prose saying `I will use read_file`.",
    ],
  });

  assert.match(card, /模型格式归一化/);
  assert.match(card, /`thought`\/`thinking`\/`reasoning`/);
  assert.match(card, /actual tool call/);
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
    ["read_file", "write_file", "replace_in_file"],
  );

  assert.match(prompt, /可用的工具：read_file, replace_in_file, write_file|可用的工具：read_file, write_file, replace_in_file/);
  assert.doesNotMatch(prompt, /run_command/);
  assert.doesNotMatch(prompt, /execute_command/);
});

test("execute prompt does not instruct unavailable apply_patch", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "main_mode",
    "",
    [],
    [],
    "edit",
    "zh",
    null,
    undefined,
    "execute",
    "english_core_localized_output",
    ["read_file", "write_file", "replace_in_file"],
    { kind: "file_modify", requiresApproval: true },
    undefined,
    {
      displayLanguage: "zh",
      resolvedResponseLanguage: "zh",
    },
  );

  assert.match(prompt, /\[TURN INTENT: EXECUTE\]/);
  assert.match(prompt, /可用写入工具：`replace_in_file`、`write_file`|可用写入工具：`write_file`、`replace_in_file`/);
  assert.doesNotMatch(prompt, /apply_patch/);
  assert.doesNotMatch(prompt, /\[TURN INTENT: PLAN\]/);
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
  assert.match(prompt, /规划产物应表达分析目标、数据范围/);
  assert.doesNotMatch(prompt, /必须生成精简的 `\.MAIN\/plans\/requirements\.md`/);
});

test("plan prompt prefers pre-approval plan.md writes for complex planning", () => {
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
    "plan",
    "english_core_localized_output",
    ["read_file", "write_file", "replace_in_file"],
  );

  assert.match(prompt, /正式审批首选写入 `\.MAIN\/plans\/plan\.md`/);
  assert.match(prompt, /证据足够后用 `write_file`、`replace_in_file` 写 `\.MAIN\/plans\/plan\.md`|收集只读证据后，用本轮可用计划写入工具/);
  assert.doesNotMatch(prompt, /\.\.MAIN\/plans\/plan\.md|\.\\\.MAIN\/plans\/plan\.md/);
  assert.doesNotMatch(prompt, /MAIN runtime 会物化为 `\.MAIN\/plans\/plan\.md`/);
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
  assert.match(prompt, /如果选项是让你继续调查、确认、读取、分析或执行，必须写成用户指令口吻/);
  assert.match(prompt, /不要写成模型自述的“我来确认\/我来检查\/我来分析”/);
});

test("respond prompt no longer tells the user to switch Chat or Fast or Plan", () => {
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
  assert.match(prompt, /\[TURN INTENT: RESPOND\]/);
  assert.match(prompt, /批准执行本轮操作/);
  assert.match(prompt, /action="approve_operation_once"/);
  assert.match(prompt, /未获批准时不要调用本轮写入或执行工具/);
  assert.match(prompt, /运行时已经把本轮升级到 execute 能力/);
  assert.match(prompt, /如果不确定用户到底是要继续讨论\/调整方案，还是要进入真实执行/);
  assert.doesNotMatch(prompt, /不要调用 replace_in_file、write_file、execute_command 等写入或执行工具。/);
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

test("game studio prompt gives engine-specific MCP workflow contracts for Godot", () => {
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
      activeStudioAgentKey: "godot-specialist",
      pendingSlashCommand: null,
      studioConfig: {
        engine: "godot",
        engineLanguage: "GDScript",
        engineVersion: "4.3",
      },
    },
    "respond",
    "english_core_localized_output",
    ["read_file", "godot_get_scene_tree"],
    null,
    {
      gameStudioMcpFirst: true,
      engine: "godot",
      connectedServerNames: ["Godot MCP"],
    },
  );

  assert.match(prompt, /\[ENGINE MCP PRIORITY\]/);
  assert.match(prompt, /engine: godot/);
  assert.match(prompt, /connectedEngineMcpServers: Godot MCP/);
  assert.match(prompt, /prioritize matching engine MCP\/editor tools/);
  assert.match(prompt, /Godot workflow contract/);
  assert.match(prompt, /Godot 场景\/节点\/资源\/脚本\/导出操作优先走 Godot MCP/);
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
    ["read_console", "get_project_skeleton", "read_file"],
    { kind: "unity", action: "console_diagnostics" },
    {
      unityMcpFirst: true,
      unityConsoleFirst: true,
      connectedServerNames: ["Unity"],
    },
  );

  assert.match(prompt, /\[ENGINE MCP PRIORITY\]/);
  assert.match(prompt, /engine: unity/);
  assert.match(prompt, /Do not start with get_project_skeleton or local log file scanning/);
  assert.match(prompt, /call read_console first/);
  assert.match(prompt, /prefer script_apply_edits/i);
});

test("system prompt prioritizes turn intake screenshots and attached context before broad discovery", () => {
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
    "plan",
    "english_core_localized_output",
    ["read_file", "grep_search", "list_directory", "get_project_skeleton", "write_file"],
  );

  assert.match(prompt, /\[turn_intake\]/);
  assert.match(prompt, /Codex App 式处理顺序/);
  assert.match(prompt, /图片要先总结可见 UI\/文本\/状态\/异常/);
  assert.match(prompt, /先读取并利用用户已给上下文/);
});

test("execute prompt enforces strict immediate tool execution constraints", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "main_mode",
    "",
    [],
    [],
    "edit",
    "zh",
    null,
    undefined,
    "execute",
  );

  assert.match(prompt, /【必须立即行动，禁止在正文输出纯文字规划或步骤描述】/);
  assert.match(prompt, /绝对禁止输出类似“我接下来的计划是：”/);
  assert.match(prompt, /必须立刻发起本轮真实暴露的工具调用/);
  assert.match(prompt, /【绝对禁止只说不做】/);
});

test("tool protocol card uses web_search XML example when read_file is not available", () => {
  const card = buildToolProtocolCard({
    activeProfile: "local",
    provider: "LM Studio",
    toolProtocol: "xml",
    nativeToolsEnabled: false,
    workflowMode: "chat",
    availableToolNames: ["web_search", "web_fetch"],
    language: "zh",
  });

  assert.match(card, /<tool>web_search<\/tool>/);
  assert.match(card, /<parameter name="query">/);
  assert.doesNotMatch(card, /<tool>read_file<\/tool>/);
});

test("system prompt contains strict steering file creation prohibition rules", () => {
  const prompt = buildSystemPrompt(
    [],
    "/tmp/workspace",
    "main_mode",
    "",
    [],
    [],
    "edit",
    "zh",
    null,
  );

  assert.match(prompt, /Steering 发现规则/);
  assert.match(prompt, /绝对禁止主动创建此目录或任何 steering 规范文件/);
});
