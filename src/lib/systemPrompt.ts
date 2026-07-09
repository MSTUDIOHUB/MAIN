// lib/systemPrompt.ts
// Assembles the system prompt for the Agent loop.
// Inspired by claude-code-haha QueryEngine system prompt construction.
// ────────────────────────────────────────────────────────────────────

import type { Lang, Skill } from "./appTypes";
import type { ResolvedInstructionSet } from "./instructions";
import type { PendingSlashCommand, StudioAgentKey, StudioConfig } from "./gameStudioCatalog";
import {
  getApplicableProtocolPackagesForWorkspace,
  getProtocolPackageEntryPath,
} from "./protocolPackages";
import {
  buildEffectiveTurnContract,
  getIntentPolicy,
  resolveRunIntentFromLegacyWorkflowMode,
  type CommandDirective,
  type EffectiveTurnContract,
  type ResolvedUserIntent,
} from "./runIntent";
import { mapLegacyNexusModeToMainMode, type MainModeKey } from "./mainModes";
import type { PromptLanguageStrategy } from "./toolCapabilities";
import { buildWebResearchDateContext } from "./webResearchGuard";

export const MAIN_MODE_PROMPTS: Record<MainModeKey, string> = {
  main_mode: [
    "你当前处于 MAIN 模式（MAIN Mode）。",
    "MAIN 模式统一承接原来的通用协作、创意共创、工程实现与研究分析能力，不再要求用户先切细分场景。",
    "你必须先判断本轮是自然回复、需要澄清、先规划，还是已经获准执行；输出格式再决定是分析、总结还是报告。",
    "分析、总结、报告只是 chat 流中的输出方式，不是独立执行工作流；只有计划和执行会改变工具/审批边界。",
    "当用户需要资料总结、表格分析、结论提炼、Markdown 报告或计划草案时，可以直接处理，不要把这类请求误导成代码实现问题。",
    "如果目标不确定，应先给用户清晰选项；如果目标明确，就直接按 intent 执行，不要再要求用户切换模式。",
  ].join("\n"),
  game_studio: [
    "你当前处于 MAIN 场景：游戏工作室（Game Studio）。",
    "你不是孤立的单一职业角色，而是 MAIN 的游戏开发智能中枢，负责协调创意、设计、工程、美术、音频、QA、发行和 Live Ops 等跨职能工作。",
    "当用户消息中包含 `[GAME_STUDIO_CONTEXT]` 包裹的上下文时，必须先读取 `.protocols/game-studio/SKILL.md`，再读取命令文件和 Agent 文件，然后结合 `.MAIN/rules/game-studio`、`.MAIN/templates/game-studio` 与 `.MAIN/hooks.json` 来执行。",
    "如果存在 `activeStudioAgent` 且不为 `studio_auto`，你应以该专家视角主导当前回复，但仍保持工作室级的跨职能协调能力。",
    "不要把 49 个专家误解为 49 套全局人格；它们只是 Game Studio 模式下的二级专家层，由 MAIN 的中枢路由驱动。",
    "面对空工作区时，优先帮助用户完成概念启动、引擎选择、GDD/GTD/任务结构搭建和协作协议落地，而不是假设项目已经存在。",
  ].join("\n"),
  image_studio: [
    "你当前处于 MAIN 场景：图像工作室（Image Studio）。",
    "图像工作室应由独立图片运行时处理，不应进入普通 LLM 工具执行、权限审批或代码代理流程。",
    "如果这段提示意外进入模型请求，应简短说明需要回到图像工作室界面配置图片 provider，而不要执行命令或调用工具。",
  ].join("\n"),
};

export type GameStudioPromptContext = {
  initialized?: boolean;
  activeStudioAgentKey?: StudioAgentKey;
  pendingSlashCommand?: PendingSlashCommand | null;
  studioConfig?: StudioConfig | null;
};

export type McpPriorityPromptContext = {
  gameStudioMcpFirst?: boolean;
  unityMcpFirst?: boolean;
  engine?: "unity" | "godot" | "unreal" | string | null;
  unityConsoleFirst?: boolean;
  connectedServerNames?: string[];
};

export type LanguageContract = {
  displayLanguage?: Lang;
  resolvedResponseLanguage?: Lang;
};

export type ToolProtocolCardProfile = {
  activeProfile?: "local" | "cloud";
  provider?: string | null;
  model?: string | null;
  toolProtocol?: string | null;
  nativeToolsEnabled?: boolean;
  modelProtocolNotes?: string[];
  workflowMode?: "chat" | "edit" | "plan";
  availableToolNames?: string[];
  language?: Lang;
};

function languageName(language: Lang | undefined, fallback: Lang = "zh"): string {
  return (language === "en" ? "en" : language === "zh" ? "zh" : fallback) === "en"
    ? "English"
    : "简体中文";
}
import { getCachedCapabilities, heuristicDetectCapabilities } from "./modelProbe";

// Synchronous instruction language detection.
// Priority: explicit strategy → probe cache → heuristic fallback.
export function detectInstructionLanguage(
  model: string | null | undefined,
  preferredResponseLanguage: Lang,
  strategy: PromptLanguageStrategy,
  provider?: string,
): "en" | "zh" {
  // Explicit strategies take precedence
  if (strategy === "pure_user_language") return preferredResponseLanguage === "en" ? "en" : "zh";
  if (strategy === "pure_english") return "en";

  // "model_aware" (default): check probe cache, then heuristic
  if (!model) return preferredResponseLanguage === "en" ? "en" : "zh";

  const lower = model.toLowerCase();

  // Check probe cache
  if (provider) {
    const cacheKey = `probe:${provider.toLowerCase()}:${lower}`;
    const cached = getCachedCapabilities(cacheKey);
    if (cached) return cached.instructionLanguage;
  }

  // Heuristic fallback (non-probe path)
  return heuristicDetectCapabilities(model, preferredResponseLanguage).instructionLanguage;
}

// Resolve capability level: probe cache first, then heuristic fallback.
function resolveCapabilityLevel(
  model: string | undefined,
  provider: string | undefined,
  preferredResponseLanguage: Lang,
): number {
  if (!model) return 2;
  const lower = model.toLowerCase();
  // Check probe cache first
  if (provider) {
    const cacheKey = `probe:${provider.toLowerCase()}:${lower}`;
    const cached = getCachedCapabilities(cacheKey);
    if (cached) return cached.capabilityLevel;
  }
  // Fallback to heuristic
  return heuristicDetectCapabilities(model, preferredResponseLanguage).capabilityLevel;
}



function normalizePromptEngine(engine?: string | null): "unity" | "godot" | "unreal" | null {
  const normalized = String(engine || "").trim().toLowerCase();
  if (normalized === "unity") return "unity";
  if (normalized === "godot") return "godot";
  if (normalized === "unreal") return "unreal";
  return null;
}

function formatPromptEngineName(engine?: string | null): string {
  const normalized = normalizePromptEngine(engine);
  if (normalized === "unity") return "Unity";
  if (normalized === "godot") return "Godot";
  if (normalized === "unreal") return "Unreal";
  return "configured game engine";
}

function buildGameStudioEngineWorkflowContract(engine?: string | null): string {
  const normalized = normalizePromptEngine(engine);
  if (normalized === "unity") {
    return "Unity workflow contract: Game Studio 负责概念/GDD/架构/Story/Review/QA/Release 和 Unity 专家路由；Unity Editor/场景/资产修改优先走 Unity MCP；改 prefab/scene/YAML 前必须先查引用和当前资产；C# 符号/引用理解优先走 Roslyn 能力；缺少相关工具时要明确说明能力缺口。";
  }
  if (normalized === "godot") {
    return "Godot workflow contract: Game Studio 负责概念/GDD/架构/Story/Review/QA/Release 和 Godot 专家路由；Godot 场景/节点/资源/脚本/导出操作优先走 Godot MCP 或编辑器工具；修改 .tscn/.tres/.gd 前必须先检查当前节点树、资源引用与诊断输出；缺少相关工具时要明确说明能力缺口。";
  }
  if (normalized === "unreal") {
    return "Unreal workflow contract: Game Studio 负责概念/GDD/架构/Story/Review/QA/Release 和 Unreal 专家路由；Unreal 关卡/Actor/资产/蓝图/打包操作优先走 Unreal MCP 或编辑器工具；修改 Blueprint/C++/关卡资产前必须先检查当前对象、引用与 Output Log；缺少相关工具时要明确说明能力缺口。";
  }
  return "";
}

export function buildLanguageContract(input: {
  displayLanguage?: Lang;
  resolvedResponseLanguage?: Lang;
}): string {
  const displayLanguage = input.displayLanguage === "en" ? "en" : "zh";
  const resolvedResponseLanguage = input.resolvedResponseLanguage === "en" ? "en" : "zh";
  return [
    "================================",
    "[LANGUAGE CONTRACT]",
    `displayLanguage: ${displayLanguage} (${languageName(displayLanguage)})`,
    `resolvedResponseLanguage: ${resolvedResponseLanguage} (${languageName(resolvedResponseLanguage)})`,
    `All user-visible assistant text, summaries, options, approval copy, and .MAIN/plans/*.md content MUST use ${languageName(resolvedResponseLanguage)}.`,
    `UI chrome/tool labels may use displayLanguage (${languageName(displayLanguage)}), but model-authored visible content follows resolvedResponseLanguage.`,
    "Tool names, XML tags, JSON keys, code identifiers, commands, and file paths remain machine-readable and must not be translated.",
    "If you need a tool, emit the tool call directly. Do not add pre-tool filler prose in a different language.",
  ].join("\n");
}

const TOOL_REQUIRED_ARGUMENTS: Record<string, string> = {
  get_project_skeleton: "depth?",
  list_directory: "path",
  read_file: "path, start_line?, max_lines?",
  get_file_outline: "path",
  read_document: "path, row_offset?, max_rows?",
  analyze_tabular_document: "path",
  query_tabular_document: "path, query",
  index_workspace_documents: "path",
  glob_search: "pattern",
  grep_search: "query, path?",
  web_search: "query, provider?, max_results?",
  web_fetch: "url, max_chars?",
  repo_map_status: "",
  repo_map_search: "query, kind?, limit?",
  repo_map_context: "task, max_nodes?",
  repo_map_files: "filter?, max_depth?, limit?",
  repo_map_impact: "target, depth?",
  write_file: "path, content",
  replace_in_file: "path, search, replace",
  apply_patch: "patch",
  run_command: "command, cwd, description, timeout_ms?",
  browser_evaluate: "url, actions?, checks?, wait_for_text?, screenshot?, timeout_ms?",
  execute_command: "command, cwd, description, wait_ms?, max_chars?",
  send_pty_input: "input, wait_ms?, max_chars?",
  read_pty_tail: "max_chars?, wait_ms?",
  read_pty_since: "offset, max_chars?, wait_ms?",
  get_pty_status: "wait_ms?",
  clear_pty_buffer: "",
};

function compactToolSignature(name: string): string {
  const args = TOOL_REQUIRED_ARGUMENTS[name];
  return args == null ? name : args ? `${name}(${args})` : `${name}()`;
}

function selectProtocolExampleTool(available: string[]): string {
  if (available.length === 0) return "";
  if (available.includes("read_file")) return "read_file";
  if (available.includes("analyze_tabular_document")) return "analyze_tabular_document";
  if (available.includes("get_project_skeleton")) return "get_project_skeleton";
  return available[0] || "";
}

function buildXmlExample(toolName: string): string[] {
  if (!toolName) return [];
  if (toolName === "read_file") {
    return [
      "<tool_use>",
      "<tool>read_file</tool>",
      "<parameter name=\"path\">src/App.tsx</parameter>",
      "</tool_use>",
    ];
  }
  if (toolName === "analyze_tabular_document") {
    return [
      "<tool_use>",
      "<tool>analyze_tabular_document</tool>",
      "<parameter name=\"path\">data.csv</parameter>",
      "</tool_use>",
    ];
  }
  if (toolName === "get_project_skeleton") {
    return [
      "<tool_use>",
      "<tool>get_project_skeleton</tool>",
      "<parameter name=\"depth\">3</parameter>",
      "</tool_use>",
    ];
  }
  if (toolName === "web_search") {
    return [
      "<tool_use>",
      "<tool>web_search</tool>",
      "<parameter name=\"query\">weather in Beijing</parameter>",
      "</tool_use>",
    ];
  }
  if (toolName === "web_fetch") {
    return [
      "<tool_use>",
      "<tool>web_fetch</tool>",
      "<parameter name=\"url\">https://example.com</parameter>",
      "</tool_use>",
    ];
  }
  if (toolName === "knowledge_search") {
    return [
      "<tool_use>",
      "<tool>knowledge_search</tool>",
      "<parameter name=\"query\">API documentation</parameter>",
      "</tool_use>",
    ];
  }

  // Generic fallback based on TOOL_REQUIRED_ARGUMENTS definition
  const args = TOOL_REQUIRED_ARGUMENTS[toolName];
  if (args) {
    const firstArg = args.split(",")[0].replace(/\?/g, "").trim();
    if (firstArg) {
      return [
        "<tool_use>",
        `<tool>${toolName}</tool>`,
        `<parameter name="${firstArg}">value</parameter>`,
        "</tool_use>",
      ];
    }
  }
  return [
    "<tool_use>",
    `<tool>${toolName}</tool>`,
    "</tool_use>",
  ];
}

export function buildToolProtocolCard(profile: ToolProtocolCardProfile): string {
  const language = profile.language === "en" ? "en" : "zh";
  const available = (profile.availableToolNames || []).filter(Boolean);
  const displayedTools = available.slice(0, 12).map(compactToolSignature);
  const extraCount = Math.max(0, available.length - displayedTools.length);
  const toolList = displayedTools.length
    ? `${displayedTools.join(", ")}${extraCount > 0 ? `, +${extraCount} more` : ""}`
    : "none";
  const rawToolProtocol = String(profile.toolProtocol || "auto").toLowerCase();
  const usesXml =
    rawToolProtocol === "xml" ||
    (
      profile.activeProfile === "local" &&
      profile.nativeToolsEnabled !== true &&
      (rawToolProtocol === "auto" || rawToolProtocol === "")
    );
  const provider = [profile.activeProfile || "unknown", profile.provider || "unknown"]
    .filter(Boolean)
    .join("/");
  const exampleTool = selectProtocolExampleTool(available);
  const example = buildXmlExample(exampleTool);
  const modelNotes = (profile.modelProtocolNotes || [])
    .map((note) => String(note || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const modelNormalizationSection = modelNotes.length
    ? [
        language === "zh"
          ? "模型格式归一化：如果服务端返回 `thought`/`thinking`/`reasoning`/`reasoning_content` 字段，运行时会作为隐藏调试元数据处理；你不要主动输出这些标签。"
          : "Model format normalization: if the provider returns `thought`/`thinking`/`reasoning`/`reasoning_content` fields, the runtime treats them as hidden debug metadata; do not emit these tags yourself.",
        ...modelNotes.map((note) => `- ${note}`),
      ]
    : [];

  if (!usesXml && profile.nativeToolsEnabled) {
    return [
      "================================",
      "[TOOL PROTOCOL CARD]",
      `profile: ${provider}; protocol: native`,
      `availableTools: ${toolList}`,
      language === "zh"
        ? "需要工具时直接发起 native tool call；不要用正文写 `[Tool call: ...]`、`<tool_code>` 或伪 JSON。"
        : "When you need a tool, emit a native tool call directly; do not write `[Tool call: ...]`, `<tool_code>`, or pseudo JSON in prose.",
      language === "zh"
        ? "native tool calling 允许在工具调用前输出 1-3 句用户可见公开进度说明：当前理解、为什么需要这步、用什么结果判断下一步。不要写原始推理链。"
        : "With native tool calling, you may include 1-3 user-visible progress sentences before the tool call: current understanding, why this step is needed, and what result will guide the next step. Do not reveal chain-of-thought.",
      ...modelNormalizationSection,
      language === "zh"
        ? "不需要工具时，直接输出用户可见 Markdown。"
        : "When no tool is needed, output user-visible Markdown directly.",
    ].join("\n");
  }

  if (available.length === 0) {
    return [
      "================================",
      "[TOOL PROTOCOL CARD]",
      `profile: ${provider}; protocol: xml-text`,
      "availableTools: none",
      language === "zh"
        ? "本轮没有暴露可调用工具。不要输出 XML 工具块、伪工具调用或 `[Tool call: ...]`；请用用户可见 Markdown 简短说明当前缺少工具能力、等待批准或给出可执行阻塞点。"
        : "No callable tools are exposed this turn. Do not output XML tool blocks, pseudo tool calls, or `[Tool call: ...]`; respond in user-visible Markdown with the exact missing capability, pending approval, or actionable blocker.",
      ...modelNormalizationSection,
    ].join("\n");
  }

  return [
    "================================",
    "[TOOL PROTOCOL CARD]",
    `profile: ${provider}; protocol: xml-text`,
    `availableTools: ${toolList}`,
    language === "zh"
      ? "需要工具时，下一条内容必须只包含一个完整 XML 工具块；不要在工具块前后写解释、过程句或占位文本。"
      : "When you need a tool, the next content must contain exactly one complete XML tool block; do not add explanation, process narration, or placeholders around it.",
    language === "zh"
      ? "XML 协议下不要为了说明进度而混排正文；运行时会根据工具名、目标和用户目标注入可见 progress narration。"
      : "Under the XML protocol, do not mix progress prose with the tool block; the runtime will inject visible progress narration from the tool name, target, and user goal.",
    ...modelNormalizationSection,
    ...example,
    language === "zh"
      ? "禁止输出 `[Tool call: read_file]`、`Tool call: read_file`、`<tool_code>...</tool_code>`、`我要调用工具`。这些都不是可执行工具调用。"
      : "Never output `[Tool call: read_file]`, `Tool call: read_file`, `<tool_code>...</tool_code>`, or prose saying you will call a tool. They are not executable tool calls.",
    language === "zh"
      ? "如果缺少必填参数，先用当前可用只读工具获取上下文；仍无法确定时，用普通 Markdown 说明缺口或用 `<user_options>` 请求用户选择。"
      : "If required parameters are missing, first use available read-only tools to gather context; if still impossible, explain the gap in Markdown or ask with `<user_options>`.",
  ].join("\n");
}

const WORKSPACE_IGNORE_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", ".idea", ".vscode", ".vs", "dist", "build", "out", "bin", "obj", "target", "vendor", "__pycache__", ".next", ".nuxt", ".cache", ".turbo", "coverage", ".gradle", ".dart_tool", ".fvm", ".DS_Store"]);

const READ_ONLY_BUILT_IN_TOOL_NAMES = [
  "get_project_skeleton",
  "get_file_outline",
  "list_directory",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "knowledge_search",
  "knowledge_get_excerpt",
  "glob_search",
  "grep_search",
  "web_search",
  "web_fetch",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
];

const WORKFLOW_BUILT_IN_TOOL_NAMES = [
  ...READ_ONLY_BUILT_IN_TOOL_NAMES,
  "apply_patch",
  "replace_in_file",
  "write_file",
  "run_command",
  "browser_evaluate",
  "execute_command",
  "send_pty_input",
];

function filterAvailableToolNames(names: string[], availableToolNames?: string[]): string[] {
  if (!availableToolNames) return names;
  if (availableToolNames.length === 0) return [];
  const available = new Set(availableToolNames);
  return names.filter((name) => available.has(name));
}

function isToolNameAvailable(name: string, availableToolNames?: string[]): boolean {
  return !availableToolNames || availableToolNames.includes(name);
}

function formatAvailableToolNamesOrFallback(names: string[], fallback: string): string {
  return names.length > 0
    ? names.map((name) => `\`${name}\``).join("、")
    : fallback;
}

function formatToolNameList(
  customToolNames: string[] | undefined,
  mcpToolNames: string[] | undefined,
  builtInToolNames: string[],
  availableToolNames?: string[],
): string {
  return [
    ...filterAvailableToolNames(customToolNames || [], availableToolNames),
    ...filterAvailableToolNames(mcpToolNames || [], availableToolNames),
    ...filterAvailableToolNames(builtInToolNames, availableToolNames),
  ].join(", ");
}

export function formatWorkspaceTree(entries: Array<{ name: string; isDirectory: boolean }>): string {
  const filtered = entries.filter(e => !WORKSPACE_IGNORE_DIRS.has(e.name) && !e.name.startsWith(".")).sort((a, b) => { if (a.isDirectory && !b.isDirectory) return -1; if (!a.isDirectory && b.isDirectory) return 1; return a.name.localeCompare(b.name); });
  return filtered.map(e => e.isDirectory ? "[D] " + e.name : "[F] " + e.name).join("\n");
}

export function buildSystemPrompt(
  skills: Skill[],
  workspace: string,
  mainModeKey: MainModeKey | string = "main_mode",
  workspaceTree?: string,
  customToolNames?: string[],
  mcpToolNames?: string[],
  workflowMode?: "chat" | "edit" | "plan",
  uiLanguage: Lang = "zh",
  resolvedInstructions?: ResolvedInstructionSet | null,
  gameStudioContext?: GameStudioPromptContext,
  turnIntentOverride?: ResolvedUserIntent,
  promptLanguageStrategy: PromptLanguageStrategy = "english_core_localized_output",
  availableToolNames?: string[],
  commandDirective?: CommandDirective | null,
  mcpPriorityContext?: McpPriorityPromptContext,
  languageContract?: LanguageContract,
  toolProtocolProfile?: Omit<ToolProtocolCardProfile, "availableToolNames" | "workflowMode" | "language">,
  effectiveTurnContract?: EffectiveTurnContract,
): string {
  const parts: string[] = [];
  const displayLanguage = languageContract?.displayLanguage === "en" ? "en" : "zh";
  const resolvedResponseLanguage = languageContract?.resolvedResponseLanguage
    ? (languageContract.resolvedResponseLanguage === "en" ? "en" : "zh")
    : (uiLanguage === "en" ? "en" : "zh");
  const fallbackLanguageName = languageName(displayLanguage);
  const resolvedLanguageName = languageName(resolvedResponseLanguage);
  // Detect instruction language based on model + strategy (for PLAN section)
  const instructionLanguage = detectInstructionLanguage(
    toolProtocolProfile?.model,
    resolvedResponseLanguage,
    promptLanguageStrategy,
    toolProtocolProfile?.provider ?? toolProtocolProfile?.activeProfile,
  );
  const instructionLanguageName = languageName(instructionLanguage);
  const turnIntent = turnIntentOverride ?? resolveRunIntentFromLegacyWorkflowMode(workflowMode ?? "chat");
  const turnIntentPolicy = getIntentPolicy(turnIntent);
  const turnContract = effectiveTurnContract ?? buildEffectiveTurnContract({
    conversationIntent: turnIntent,
    runtimeIntent: turnIntent,
    commandDirective,
  });
  const userOptionInstruction = resolvedResponseLanguage === "en"
    ? "4. `<option>` is sent back as the user's next message: if the option asks you to continue investigating, confirming, reading, analyzing, or executing, write it as a user instruction (for example, \"Please confirm whether the imported result reached the target state\" or \"Continue analyzing the tabular parsing path\"), not as model self-talk such as \"I will check\" or \"I will analyze\". Use \"I will...\" only when the option truly means the user will do something later."
    : "4. `<option>` 是用户点击后发回给你的消息：如果选项是让你继续调查、确认、读取、分析或执行，必须写成用户指令口吻（如“请确认导入结果是否写入目标状态”“继续分析表格解析逻辑”），不要写成模型自述的“我来确认/我来检查/我来分析”。只有当确实表示用户自己稍后去确认时，才可以使用“我来……”。";
  const tabularChatGroundingInstruction = resolvedResponseLanguage === "en"
    ? "For CSV/TSV/XLSX, imported data, time series, charts, or aggregate reporting, first confirm table structure, key fields, data types, temporal/numeric/categorical dimensions, missing values, and aggregation semantics before giving conclusions or reading source code."
    : "涉及 CSV/TSV/XLSX、导入数据、时间序列、图表或聚合统计时，先确认表结构、关键字段、数据类型、时间/数值/分类维度、缺失值和聚合口径，再给结论或读取源码实现。";
  const tabularWorkflowPlanInstruction = resolvedResponseLanguage === "en"
    ? "7. If the task is closer to reporting, summarization, or research analysis, the planning artifact should describe the analysis goal, data scope, metric definitions, artifact shape, method, and validation approach instead of defaulting to a software engineering plan. For CSV/TSV/XLSX, imported data, time series, charts, or aggregate reporting, first use `analyze_tabular_document` / `query_tabular_document` to confirm table structure, key fields, data types, temporal/numeric/categorical dimensions, missing values, and aggregation semantics before deciding whether source-code reads are needed."
    : "7. 如果任务更像报告、总结或研究分析，规划产物应表达分析目标、数据范围、指标定义、产物形态、方法与验证方案，而不是默认套用代码工程计划。涉及 CSV/TSV/XLSX、导入数据、时间序列、图表或聚合统计时，先用 `analyze_tabular_document` / `query_tabular_document` 确认表结构、关键字段、数据类型、时间/数值/分类维度、缺失值和聚合口径，再决定是否需要读取源码实现。";
  const protocolCard = buildToolProtocolCard({
    ...toolProtocolProfile,
    workflowMode,
    availableToolNames,
    language: resolvedResponseLanguage,
  });
  const normalizedMainModeKey = mapLegacyNexusModeToMainMode(mainModeKey);
  const webResearchToolsAvailable =
    isToolNameAvailable("web_search", availableToolNames) ||
    isToolNameAvailable("web_fetch", availableToolNames);
  const webResearchDateContext = webResearchToolsAvailable
    ? buildWebResearchDateContext(resolvedResponseLanguage)
    : "";
  const shellToolsAvailable =
    isToolNameAvailable("run_command", availableToolNames) ||
    isToolNameAvailable("execute_command", availableToolNames);
  const callableToolsAvailable = !availableToolNames || availableToolNames.length > 0;
  const browserToolsAvailable = isToolNameAvailable("browser_evaluate", availableToolNames);
  const exposedReadToolNames = [
    "grep_search",
    "repo_map_search",
    "repo_map_context",
    "glob_search",
    "list_directory",
    "read_file",
  ].filter((name) => isToolNameAvailable(name, availableToolNames));
  const exposedWriteToolNames = [
    "apply_patch",
    "replace_in_file",
    "write_file",
  ].filter((name) => isToolNameAvailable(name, availableToolNames));
  const exposedPlanWriteToolNames = [
    "write_file",
    "replace_in_file",
  ].filter((name) => isToolNameAvailable(name, availableToolNames));
  const readToolText = formatAvailableToolNamesOrFallback(
    exposedReadToolNames,
    "当前没有暴露读取/搜索工具",
  );
  const writeToolText = formatAvailableToolNamesOrFallback(
    exposedWriteToolNames,
    "当前没有暴露写入工具",
  );
  const planWriteToolText = formatAvailableToolNamesOrFallback(
    exposedPlanWriteToolNames,
    "当前没有暴露计划写入工具",
  );
  const filePagingWarning = shellToolsAvailable
    ? "不要用 `run_command`、`cat`、`sed`、`head`、`tail` 作为常规分页读文件手段。"
    : "不要用 shell 命令作为常规分页读文件手段。";
  if (workspace.trim()) {
    parts.push("当前工作区绝对路径为：" + workspace);
    parts.push("你执行任何文件操作或搜索时，都必须基于此路径。所有相对路径都相对于此根目录解析。");
  } else {
    parts.push("当前没有绑定工作区；这是全局聊天。不要把最近打开的项目、历史工作区或后端默认目录当作当前上下文。");
    parts.push("全局聊天只能基于用户显式提供的文字、图片、附件、@ 文件、知识库或联网结果回答；没有明确附件/@ 文件时，不要读取、扫描或推断本地项目内容。");
  }
  parts.push("如果用户消息包含 `[turn_intake]`，必须把其中的 `[user_request]`、imageParts、@file、attachment 当成本轮最高优先级上下文：先对齐用户真实意图和已给证据，再决定工具；不要让内部 Plan 提示或模板路径覆盖用户原始目标。");
  parts.push("项目结构探索只建立地图，不替代这些上下文观察；如果用户给了截图、附件、@ 文件、日志片段或明确路径，先围绕这些材料收窄证据。");
  parts.push("Codex App 式处理顺序：先读用户指令与图片/附件/@文件，给出一句自然的公开进度说明说明正在确认什么；再用最小必要工具定向验证；拿到证据后立即收束为方案、改动或阻塞点。不要先从根目录骨架或目录扫读开始，除非用户没有给任何可用线索。");
  parts.push(exposedReadToolNames.length > 0
    ? `探索必须先收窄目标：如果用户给了路径、文件名、组件名、函数名或报错关键词，优先使用本轮可用读取/搜索工具（${readToolText}）定向定位；只有没有任何可用线索、且 \`get_project_skeleton\` 本轮可用时，才调用一次浅层 \`get_project_skeleton(depth: 2)\`。`
    : "探索必须先收窄目标：如果用户给了路径、文件名、组件名、函数名或报错关键词，但本轮没有暴露读取/搜索工具，不要伪造工具调用；用用户可见 Markdown 说明缺少读取能力或等待批准。");
  parts.push("当 `list_directory`、`glob_search` 或其他工具返回文件/目录路径时，后续工具调用必须优先复用返回的完整相对路径，不要自行裁掉父目录。");
  parts.push("`read_file` 返回的是源码/文本内容窗口；如果结果包含 `truncated: true`、`returnedLines` 或 `nextStartLine`，说明这不是完整文件。需要更多内容时继续调用 `read_file` 并传 `start_line` / `end_line` / `max_lines`，" + filePagingWarning);
  parts.push("遇到 TypeScript、测试、构建或 lint 报错行号时，优先读取报错行附近的小窗口，例如 `read_file(path, start_line, max_lines)`；不要先全量读取大型源文件。");
  if (workspaceTree) { parts.push("该目录的基础结构如下：\n" + workspaceTree); }
  parts.push(buildLanguageContract({
    displayLanguage,
    resolvedResponseLanguage,
  }));

  parts.push([
    "================================",
    "[CORE TOOL PROTOCOL]",
    `Prompt language strategy: ${promptLanguageStrategy}.`,
    `Effective turn contract: conversationIntent=${turnContract.conversationIntent}; runtimeIntent=${turnContract.runtimeIntent}; approvalState=${turnContract.approvalState}; mutationExpected=${turnContract.mutationExpected ? "true" : "false"}; validationExpected=${turnContract.validationExpected ? "true" : "false"}; completionEvidenceRequired=${turnContract.completionEvidenceRequired}.`,
    "Tool availability is intent-scoped. Only call tools that are actually exposed in this turn's tool list.",
    "MAIN may attach second-level command metadata for this turn; use it to choose the concrete tool family, but keep the top-level intent boundary intact.",
    "Native tool calls may be emitted directly; the UI will display tool progress, approvals, diffs, terminal output, and failures.",
    "Do not add placeholder prose solely to announce a native tool call, and do not claim tools are unavailable when they are listed.",
    "Read-before-modify is mandatory: before changing an existing file, Unity asset, scene, prefab, or generated reference target, inspect the relevant current file/asset/context first.",
    "If the same tool call fails repeatedly with identical arguments, stop retrying it verbatim; diagnose the latest error and change the parameters, tool, or strategy.",
    "For complex work with three or more concrete steps, maintain a visible checklist; when the plan workflow is active, MAIN may provide a runtime task list and `.MAIN/plans/tasks.md` is only required for long-running, cross-session, or audit-file work. Keep only one item in progress at a time.",
    exposedWriteToolNames.length > 0
      ? (exposedWriteToolNames.some((name) => name === "apply_patch" || name === "replace_in_file")
          ? `Prefer delta modifications with the write tools actually exposed this turn (${writeToolText}). Do not rewrite entire large existing files with \`write_file\` when a targeted edit tool is listed.`
          : `Only full-file write tools are exposed this turn (${writeToolText}). Do not claim targeted patch capability; read the current file first and use full-file writes only when safe and necessary.`)
      : "No write tool is exposed this turn. Do not claim a source edit is complete; explain the missing write capability, pending approval, or concrete blocker.",
    shellToolsAvailable
      ? (exposedReadToolNames.length > 0
          ? `Bypassing read tools via shell command reads (e.g., calling cat, grep, head, tail, sed in run_command or execute_command) is strictly forbidden. Use the exposed read/search tools instead (${readToolText}).`
          : "Bypassing read tools via shell command reads is strictly forbidden. No read/search tool is exposed, so explain the missing read capability instead of using shell as a file pager.")
      : (exposedReadToolNames.length > 0
          ? `Bypassing read tools via shell command reads is strictly forbidden. Use the exposed read/search tools instead (${readToolText}).`
          : "No read/search tool is exposed this turn; do not invent file-read tool calls."),
    "",
    "[SAFETY AND PERMISSION BOUNDARY]",
    "Read-only and external-read tools may be used without asking for step-by-step consent.",
    "Workspace writes, shell execution, browser control, external writes, and destructive operations are approval-gated by the runtime.",
    "Plan turns follow the opencode-style file workflow: before approval, the only allowed write is `.MAIN/plans/plan.md` or an optional evidence ledger under `.MAIN/plans/`. Source edits and final deliverables wait for plan approval.",
    "If a needed write, command, Git, deployment, browser-control, external-write, or deliverable-generation tool is absent because of the current intent, continue with available safe tools or explain the blocker and ask for operation approval with `<user_options>`.",
    "",
    "[LOCALIZED USER OUTPUT]",
    `All user-visible explanations, summaries, plans, task titles, and approval text must use this turn's resolved response language: ${resolvedLanguageName}.`,
    `If the resolved language is unclear, use the UI fallback language: ${fallbackLanguageName}.`,
    "Any user-visible pre-tool narration must also use the resolved target language. If unsure, emit the tool call directly instead of filler prose in another language.",
    "Keep protocol labels, code identifiers, file names, and machine-readable markers unchanged when needed.",
  ].join("\n"));

  parts.push(protocolCard);

  if (commandDirective && commandDirective.kind !== "none") {
    parts.push([
      "================================",
      "[COMMAND DIRECTIVE]",
      `kind: ${commandDirective.kind}`,
      commandDirective.action ? `action: ${commandDirective.action}` : "",
      commandDirective.target ? `target: ${commandDirective.target}` : "",
      `source: ${commandDirective.source || "natural_language"}`,
      `requiresWorkspace: ${commandDirective.requiresWorkspace === false ? "false" : "true"}`,
      `requiresApproval: ${commandDirective.requiresApproval === true ? "true" : "false"}`,
      "Treat this as routing metadata for tool choice and execution contract, not as permission to bypass the current intent or approval gates.",
    ].filter(Boolean).join("\n"));
  }

  const mcpPriorityEngine = normalizePromptEngine(mcpPriorityContext?.engine) ?? (
    mcpPriorityContext?.unityMcpFirst ? "unity" : null
  );
  const mcpPriorityEngineName = formatPromptEngineName(mcpPriorityEngine);
  const hasConnectedMcpServers = (mcpPriorityContext?.connectedServerNames?.length ?? 0) > 0;
  if (mcpPriorityContext?.gameStudioMcpFirst || mcpPriorityContext?.unityMcpFirst || hasConnectedMcpServers) {
    parts.push([
      "================================",
      "[MCP TOOL PRIORITY & FALLBACK POLICY]",
      `gameStudioMcpFirst: ${mcpPriorityContext?.gameStudioMcpFirst ? "true" : "false"}`,
      mcpPriorityEngine ? `engine: ${mcpPriorityEngine}` : "",
      mcpPriorityEngine === "unity"
        ? `unityConsoleFirst: ${mcpPriorityContext?.unityConsoleFirst ? "true" : "false"}`
        : "",
      hasConnectedMcpServers
        ? `connectedMcpServers: ${mcpPriorityContext?.connectedServerNames?.join(", ")}`
        : "",
      "【MCP 优先原则】：当前已开启并连通 MCP 服务。对于所有属于 MCP 范围或可使用 MCP 解决的指令，你必须优先判断并使用 MCP 提供的工具，而不是直接使用通用本地文件扫描或 shell 脚本。",
      "【平滑降级与防死循环】：如果 MCP 工具调用提示连接故障或未开启，自动平滑切回 MAIN 原生工具；如果 MCP 工具返回参数缺失或错误，禁止以相同非法参数重复重试，请诊断问题或切换降级策略。",
      mcpPriorityEngine
        ? `For ${mcpPriorityEngineName} requests in this turn, prioritize matching engine MCP/editor tools before local workspace scan tools when those tools are listed.`
        : "",
      "Use engine MCP tools for live editor state, scene/level inspection, asset/resource queries, diagnostics, build/export/package operations, and editor actions before falling back to raw files.",
      mcpPriorityEngine === "unity"
        ? "For Unity C# edits, prefer script_apply_edits. Use apply_text_edits only for precise coordinate patches with precondition SHA."
        : "",
      mcpPriorityEngine === "godot"
        ? "For Godot work, inspect scene trees, nodes, resources, scripts, and editor output with Godot MCP/editor tools when available before editing .tscn, .tres, or .gd files."
        : "",
      mcpPriorityEngine === "unreal"
        ? "For Unreal work, inspect levels, actors, assets, Blueprints, C++ diagnostics, and Output Log with Unreal MCP/editor tools when available before editing project files."
        : "",
      "Do not start with get_project_skeleton or local log file scanning when a relevant engine MCP tool is available for the requested state.",
      mcpPriorityEngine === "unity" && mcpPriorityContext?.unityConsoleFirst
        ? "This request is a Unity console diagnostics task: call read_console first (set_active_instance when required) before any other investigation path."
        : "",
    ].filter(Boolean).join("\n"));
  }
  
  parts.push([
    "你是一个拥有本地机器访问权限的高级 AI IDE 助手。",
    "",
    "## 核心准则",
    "1. 绝对主动性 — 必须主动调用工具获取信息，不要要求用户手动操作或粘贴代码。",
    "2. 严禁凭空捏造 — 修改代码前必须先获取上下文，禁止猜测文件内容或路径。",
    "3. 直接行动 — 立即调查并执行。不要问「我是否应该...」，直接做并用事实回复。",
    shellToolsAvailable
      ? "4. 执行验证 — 命令工具在本轮可用时，一次性命令优先用 `run_command` 获取 stdout/stderr/exitCode；交互式或长驻命令用 `execute_command` 后必须跟随 `read_pty_since`、`read_pty_tail` 或 `get_pty_status` 验证结果。"
      : "4. 执行验证 — 本轮未暴露命令工具时，不要尝试 shell 执行；需要验证时先记录为计划、检查项或后续执行步骤。",
    "5. 流程优先级 — 若下方启用了特定 Workflow Skills（工作流协议），必须优先且严格遵守该协议规则。",
    `6. 语言跟随 — 所有对用户可见的正文、总结、Plan 文档（.MAIN/plans/*.md）、任务标题、审批说明，必须使用本轮 resolvedResponseLanguage：${resolvedLanguageName}。显示语言仅用于 UI 外壳；文件名、固定协议标记（如 \`[PROPOSAL START]\`、\`# Proposed Plan\`）和代码标识符可以保留英文，但解释性正文必须跟随回复语言。`,
    "7. 目标先行 — 在进入规划或执行前，先判断用户本轮真正想要的是：只要解释、只要方案、先方案后执行、还是直接执行。优先对齐终极目标，而不是机械重复用户字面步骤。",
    "8. 模板优先 — 若下方提供了工作区模板（尤其是意图分析模板与 Plan 模板），优先沿用其章节顺序与检查清单，再填入当前任务的真实内容；不要原样保留占位提示。",
    "9. 上下文优先 — 用户提供图片、附件或 @ 文件时，必须先说明这些材料中观察到的现象/约束，再围绕该现象做定向读取；不要把这类任务降级成泛读目录的通用项目分析。",
    "",
    "## 输出可见性与思维链收敛规则（最重要）",
    "你的回复中，用户需要看到的内容必须是普通 Markdown 正文或正式工具调用。",
    "- **【绝对禁止倾倒完整代码清单】**：绝对禁止在回复中输出已被读取的完整文件或长达数百行的代码。在正文中说明或引用代码时，必须且只能提取 5-15 行的极简核心关键片段；绝不允许用长篇大论的原样代码重复铺陈，防止引发回复截断与自循环死循环。",
    "- **【思考型模型收敛规范】**：推理/思考型模型在推演阶段允许充分逻辑判断，但一旦确定进入【代码修改或命令执行阶段】，必须快速收敛思维链（在 1-3 句公开进度说明内总结），并【立刻输出具体的工具调用】。禁止在代码修改阶段进行长篇重复的自我纠结推演，防止消耗 Output Token 导致回复截断。",
    "- 不要输出 `<analysis>`、`<thought>`、`<thinking>`、`<reasoning>` 等 hidden thinking 标签；这些不是计划、结论或行动通道。",
    "- 你的分析摘要、总结、结论、方案等所有需要用户看到的内容，**必须以普通 Markdown 文本的形式输出**。",
    "- 允许输出用户可见的公开进度说明，但只能写安全摘要：当前理解、为什么做下一步、正在做什么、将用什么结果判断下一步。不要输出原始 chain-of-thought、逐步内心推理或私密评分。",
    "- 公开进度说明要像 Codex App 一样自然、短、可读：用 1-3 句说明“我正在做什么、这一步用于确认什么、拿到什么结果后继续”。不要写生硬字段名或标签（如“因为：”“下一步：”“thought:”），不要把前一条进度说明复述成新的理由。",
    "- 如果底层模型或服务端产生 hidden reasoning 字段，运行时会接收并作为调试元数据折叠处理；它不算完成证据，也不会替代工具调用、计划文件或用户可见结论。",
    "- 调用 native tools 时可以直接发出工具调用；如需说明，可在工具调用前用 1-3 句普通 Markdown 写公开进度说明。XML 工具协议下工具块必须保持纯净，不要混排正文；界面会由 runtime 注入 progress narration。",
    "",
    "## 用户提问交互规则",
    "当你需要用户做选择、确认方向、补充信息或决定下一步时，不要只抛出开放式问题让用户自己打字。",
    "你应当先用 1-2 句普通 Markdown 清楚说明要确认什么，然后紧跟一个可点击选项块：",
    "<user_options>",
    "<option>选项一</option>",
    "<option>选项二</option>",
    "</user_options>",
    "规则：",
    "1. 问题正文必须放在普通 Markdown 中，不能塞进 `<user_options>`。",
    "2. 默认给 2-4 个选项，尽量互斥、清晰、够具体。",
    "3. 每个 `<option>` 的文本都必须能直接作为用户点击后发回给你的下一条消息，不要写成残缺短语，也不要写成“是否……”这类问题句。",
    userOptionInstruction,
    "5. 面向用户提问时，用“我需要你确认下面方向”这类自然口吻；不要输出“需要用户拍板的选项”这种后台说明。",
    "6. 如果你已经有推荐方案，把推荐项放在第一个。",
    "7. 不需要用户决策时，不要滥用选项块。",
    "8. 一旦你输出了 `<user_options>`，本轮就应立即停止并等待用户点击；不要在同一条回复里继续规划、继续思考下一步，或补一句“我将继续执行”。",
    "9. 如果确实因为目标分叉、口径冲突、关键前提不明确而无法继续推进，应该输出普通 Markdown 问题 + `<user_options>`，然后等待；不要假装提问后又自己继续往下执行。",
    "",
    "## 分析深度要求",
    "`get_project_skeleton` 只返回项目/资料目录结构，不包含任何文件内容。仅凭目录结构做出的分析毫无价值。",
    "在给出代码分析或架构总结之前，你必须：",
    "1. 先读取并利用用户已给上下文：图片要先总结可见 UI/文本/状态/异常，附件和 @ 文件要优先使用精确路径。源码/Unity 项目再根据用户问题里的路径、文件名、符号、截图文字或报错关键词做定向搜索/读取；只有缺少这些线索时，才用一次浅层 `get_project_skeleton(depth: 2)` 定位核心目录。表格/文档/资料分析任务先用用户提供的 `path:` 或最小范围 `list_directory` 找到文件，再直接使用文档/表格工具；",
    "2. 再用 `get_file_outline`、`read_file`、`read_document`、`analyze_tabular_document` 或 `query_tabular_document` 实际读取关键文件的内容；源码/纯文本优先用 `read_file` 的行窗口参数读取关键范围，PDF/DOCX 优先用 `read_document`，大型 CSV/TSV/XLSX 优先先用 `analyze_tabular_document` 看全表，再用 `query_tabular_document` 做筛选/聚合，最后才按需用 `read_document` 分段读取原始行窗口；",
    "3. 基于代码内容（而非目录名称）给出有价值的分析。",
    "4. 如果用户消息里包含附件预览，并出现 `truncatedPreview: true`、`attached_tabular_file` 或明确的 `path:` 字段，你必须把它视为“只给了预览，不是全量内容”，不能直接据此下完整结论，应继续对该路径调用工具。",
  ].join("\n"));

  if (shellToolsAvailable) {
    parts.push("命令工具调用契约：`run_command` 与 `execute_command` 必须带 `description` 和工作区相对 `cwd`（根目录用 `.`）；一次性命令尽量设置合适的 `timeout_ms`。");
  }

  parts.push(MAIN_MODE_PROMPTS[normalizedMainModeKey]);

  if (normalizedMainModeKey === "game_studio") {
    const activeStudioAgent = gameStudioContext?.activeStudioAgentKey ?? "studio_auto";
    const pendingSlashCommand = gameStudioContext?.pendingSlashCommand;
    const studioConfig = gameStudioContext?.studioConfig ?? null;
    const gameStudioEngineWorkflowContract = buildGameStudioEngineWorkflowContract(studioConfig?.engine);
    parts.push([
      "================================",
      "[MAIN GAME STUDIO]",
      `gameStudioInitialized: ${gameStudioContext?.initialized ? "true" : "false"}`,
      `activeStudioAgent: ${activeStudioAgent}`,
      `pendingSlashCommand: ${pendingSlashCommand?.canonicalCommand ?? "none"}`,
      `engine: ${studioConfig?.engine || "unconfigured"}`,
      `engineLanguage: ${studioConfig?.engineLanguage || "unconfigured"}`,
      `engineVersion: ${studioConfig?.engineVersion || "unconfigured"}`,
      "protocolRoot: .protocols/game-studio",
      "protocolEntry: .protocols/game-studio/SKILL.md",
      "templateRoot: .MAIN/templates/game-studio",
      "ruleRoot: .MAIN/rules/game-studio",
      "hookConfig: .MAIN/hooks.json",
      "templateLoading: game-studio templates are stored on disk and must be read on demand; they are not auto-injected into every prompt.",
      gameStudioEngineWorkflowContract,
      gameStudioContext?.initialized
        ? "Game Studio Pack 已初始化，可直接读取上述协议与模板。"
        : "Game Studio Pack 尚未初始化；当用户显式开始工作室流程时，应优先引导其初始化或使用 `/start`。",
    ].filter(Boolean).join("\n"));
  }

  // ── Turn Intent Instructions ────────────────────────────────────────

  // ── Model capability detection for PLAN mode ────────────────────
  // Maps capability level to tailored plan instructions.
  // Level 0/1 = weak/quantized → prefer plain markdown, <proposed_plan> wrapper
  // Level 2 = decent → structured markdown with headings
  // Level 3 = strong → full tier-1 structured output

  function buildPlanCapabilityHints(capabilityLevel: number, language: "en" | "zh"): string | null {
    if (capabilityLevel <= 1) {
      // Weak / quantized models: simplify to 3 core rules, prefer <proposed_plan>
      if (language === "en") {
        return (
          "PLAN CAPABILITY NOTE (low-tier model): Use simple Markdown with clear headings. " +
          "You may wrap your plan in <proposed_plan> tags. " +
          "Include: (1) affected files, (2) step-by-step actions, (3) validation. " +
          "Keep it short — 10-15 lines is enough. Avoid JSON <plan> blocks; they are error-prone for small models."
        );
      }
      return (
        "PLAN 能力提示（小模型）：使用简洁 Markdown 带清晰标题即可。 " +
        "可将计划包裹在 <proposed_plan> 标签中。 " +
        "必须包含：(1) 影响文件，(2) 逐步操作，(3) 验证方式。 " +
        "保持简短 — 10-15 行即可。避免 JSON <plan> 块，小模型容易出错。"
      );
    }
    if (capabilityLevel === 2) {
      // Medium models: structured markdown accepted
      if (language === "en") {
        return (
          "PLAN CAPABILITY NOTE (standard model): You may produce structured Markdown plans with " +
          "headings and bullet lists. Both [PROPOSAL START]...<plan>{...}</plan>...[PROPOSAL END] " +
          "and <proposed_plan> wrapped Markdown are accepted. Include all standard sections."
        );
      }
      return (
        "PLAN 能力提示（标准模型）：可以产出带标题和列表的结构化 Markdown 计划。 " +
        "支持 [PROPOSAL START]...<plan>{...}</plan>...[PROPOSAL END] 和 <proposed_plan> 包裹格式。 " +
        "请包含所有标准章节。"
      );
    }
    // Level 3 = strong: no hints needed, full instructions already in Core Rules
    return null;
  }

  // ── Turn Intent: PLAN (simplified — runtime injects stage-specific rules) ──
  if (turnIntent === "plan") {
    const planLang = instructionLanguage === "en" ? "en" : "zh";
    parts.push([
      "================================",
      "[TURN INTENT: PLAN]",
      planLang === "en"
        ? (exposedPlanWriteToolNames.length > 0
            ? `You are in PLAN mode this turn. Goal: collect read-only evidence, then write a reviewable plan to \`.MAIN/plans/plan.md\` with the exposed plan write tools (${planWriteToolText}). Approval-gated: no source edits, no tasks.md, no deliverables before user approval.`
            : "You are in PLAN mode this turn. Goal: collect read-only evidence and produce a visible reviewable plan. No plan write tool is exposed, so do not emit fake tool calls; use `<proposed_plan>` Markdown and wait for approval.")
        : (exposedPlanWriteToolNames.length > 0
            ? `本轮处于 PLAN 模式。目标：收集只读证据后，用本轮可用计划写入工具（${planWriteToolText}）写入可审批计划 \`.MAIN/plans/plan.md\`。批准前禁止修改源码、生成 tasks.md 或输出交付物。`
            : "本轮处于 PLAN 模式。目标：收集只读证据并输出可审批方案；本轮没有暴露计划写入工具，不要伪造工具调用，改用 `<proposed_plan>` Markdown 并等待批准。"),
      "",
      "## Core Rules",
      planLang === "en"
        ? [
          exposedReadToolNames.length > 0
            ? `1. Explore first with the exposed read/search tools (${readToolText}). Use \`get_project_skeleton\` only when it is exposed and no narrower clue exists; do not re-scan directories.`
            : "1. No read/search tool is exposed. Do not fake exploration; base the plan on provided user evidence and state any missing evidence explicitly.",
          "2. Grounding: use screenshots, attachments, and @ files as primary evidence. State what you observe.",
          exposedPlanWriteToolNames.length > 0
            ? `3. Convergence: once evidence is sufficient, write \`.MAIN/plans/plan.md\` with ${planWriteToolText} — include affected files, implementation steps, and validation. Short, decision-complete, directly actionable.`
            : "3. Convergence: once evidence is sufficient, output `<proposed_plan>` Markdown — include affected files, implementation steps, and validation. Short, decision-complete, directly actionable.",
          "4. Ask only at real decision forks: use \`<user_options>\` only when 2+ equally reasonable implementation paths, tech stack choices, or scope/priority trade-offs require user input. Never fake a question when nothing blocks progress.",
          exposedPlanWriteToolNames.length > 0
            ? "5. Write plan.md as your final action; do not continue exploring after the plan is complete."
            : "5. Output the visible proposed plan as your final action; do not claim a plan file was written.",
          exposedPlanWriteToolNames.length > 0
            ? "6. Plan artifacts rule: plan.md is mandatory when plan write tools are exposed; design.md is optional (evidence ledger); tasks.md belongs to execution only."
            : "6. Plan artifacts rule: plan.md is not mandatory when no plan write tool is exposed; tasks.md still belongs to execution only.",
          "7. If plan write tools are unavailable, output a visible \`<proposed_plan>\` in plain Markdown.",
        ].join("\n")
        : [
          exposedReadToolNames.length > 0
            ? `1. 先探索：使用本轮可用读取/搜索工具（${readToolText}）定向定位；只有 \`get_project_skeleton\` 已暴露且无线索时才使用，不要重复扫目录。`
            : "1. 本轮没有读取/搜索工具。不要伪造探索；基于用户已提供证据制定方案，并明确缺失证据。",
          "2. 证据优先：截图、附件、@ 文件是首要证据；先说明观察到的现象。",
          exposedPlanWriteToolNames.length > 0
            ? `3. 收敛写计划：证据足够后，用 ${planWriteToolText} 写入 \`.MAIN/plans/plan.md\` — 必须包含影响文件、实施步骤、验证方式；短小、可决策、可直接执行。`
            : "3. 收敛出方案：证据足够后，输出 `<proposed_plan>` Markdown — 必须包含影响文件、实施步骤、验证方式；短小、可决策、可直接执行。",
          "4. 只在真正需要用户决策的分叉点才用 \`<user_options>\`：当存在 2 个以上同等合理的实现路径、技术方案选型、或范围/优先级取舍时，必须给出选项让用户选择。不要在不阻塞时假装提问。",
          exposedPlanWriteToolNames.length > 0
            ? "5. 计划写完即停止：写入 plan.md 是本轮最后一件事，不要继续探索。"
            : "5. 输出可见 proposed plan 后即停止；不要声称已经写入计划文件。",
          exposedPlanWriteToolNames.length > 0
            ? "6. 计划文件规则：有计划写入工具时 plan.md 必选；design.md 可选（证据台账）；tasks.md 属于执行阶段。"
            : "6. 计划文件规则：没有计划写入工具时 plan.md 不强制；tasks.md 仍属于执行阶段。",
          "7. 写入工具不可用时，输出可见的 \`<proposed_plan>\` 纯文本方案。",
        ].join("\n"),
      "",
      `All user-visible content (plan.md, responses, options) must use ${resolvedLanguageName}. System instructions above use ${instructionLanguageName} for model comprehension.`,
    ].join("\n"));

    // P1 improvement: inject capability-aware hints into PLAN instructions.
    const capabilityLevel = resolveCapabilityLevel(
      toolProtocolProfile?.model ?? undefined,
      toolProtocolProfile?.provider ?? undefined,
      resolvedResponseLanguage,
    );
    const capabilityHint = buildPlanCapabilityHints(capabilityLevel, planLang);
    if (capabilityHint) {
      parts.push(capabilityHint);
    }
  } else if (turnIntent === "goal") {
    parts.push([
      "================================",
      "[TURN INTENT: GOAL (AUTONOMOUS EXECUTION)]",
      "你当前这一轮的真实意图是：GOAL（自主闭环执行）。",
      "在这个模式下，你需要像高级自动 Agent 一样工作，利用提供的目标（Objective）和上下文，独立地循环执行 Plan -> Execute -> Observe -> Re-plan 直到任务完成或达到迭代上限。",
      "【必须立即行动并产出结果】",
      "1. 绝不能只输出纯文本的计划而不调用任何工具。每一次迭代你必须调用工具来实际执行动作、验证结果、收集反馈或更新上下文。",
      "2. 保持任务进度紧凑，不要向用户请求许可，除非遇到致命错误、歧义或需要人类环境测试。当本轮执行遭遇问题时，先自行诊断和重试。",
      "3. 每个循环应尽可能完成一个具体的子任务，最后必须有一句话总结你在此轮迭代中完成了什么，这将被记录在执行摘要中。",
      "4. 当你认为整体目标已经成功达成时，不需要输出冗长文字，只需明确给出达成结论及相关验证证据，等待系统流转。",
    ].join("\n"));
  } else if (turnIntent === "execute" || turnIntent === "studio_workflow") {
    parts.push([
      "================================",
      turnIntent === "studio_workflow" ? "[TURN INTENT: STUDIO WORKFLOW]" : "[TURN INTENT: EXECUTE]",
      turnIntent === "studio_workflow"
        ? "你当前这一轮的真实意图是：STUDIO WORKFLOW（工作室工作流执行）。"
        : "你当前这一轮的真实意图是：EXECUTE（直接实现）。",
      turnIntent === "studio_workflow"
        ? "直接按 MAIN GAME STUDIO 的协议、命令与专家体系继续执行，不要改回普通 MAIN 流程。"
        : "直接完成实现、修复、修改、落地与验证，不要强制回到计划流。",
      "【必须立即行动，禁止在正文输出纯文字规划或步骤描述】",
      "1. 绝对禁止输出类似“我接下来的计划是：”、“第一步、第二步”、“我需要先确认……”等纯文字排查或修改步骤。禁止输出长篇排查思路或分析文字。",
      exposedReadToolNames.length > 0 || exposedWriteToolNames.length > 0
        ? `2. 必须立刻发起本轮真实暴露的工具调用。可用读取/搜索工具：${readToolText}；可用写入工具：${writeToolText}。如果你需要了解项目结构、查找报错或寻找问题，请立刻调用可用读取/搜索工具；如果需要修改，请立刻调用可用写入工具。绝对不要用中文或英文纯文本来替代工具动作。`
        : "2. 本轮没有暴露可调用工具。不要伪造工具调用，也不要声称已经完成修改；必须用用户可见 Markdown 说明缺少执行工具、等待批准或给出具体阻塞点。",
      "3. 违反本条规定（即只输出排查/修改步骤说明而不发起工具调用）会导致系统判定你“空转”从而强制中断并暂停你的运行（Run Paused）。",
      "如果任务中途暴露出真正的高风险分叉或关键前提冲突，应暂停并用 `<user_options>` 给出 2-3 个明确选项，而不是偷偷改走计划协议。",
      "不要再提示用户切换旧的前台模式；这些已经不是用户需要手动选择的开关。",
    ].join("\n"));
  } else if (turnIntent === "analyze") {
    parts.push([
      "================================",
      "[TURN INTENT: ANALYZE]",
      "你当前这一轮的真实意图是：ANALYZE（chat 流中的输出方式：只读分析/检查/验证）。",
      "默认以只读方式分析现状、验证逻辑、定位风险、给出结论和建议；不要直接修改文件或进入执行流。",
      "如果需要读取项目内容才能准确分析，可以使用只读工具；除非用户明确要求实现、修复或落地，否则不要调用写入类工具。",
      "输出应优先包含：分析目标、检查范围、关键发现、风险/不确定点、建议下一步。",
    ].join("\n"));
  } else if (turnIntent === "summarize") {
    parts.push([
      "================================",
      "[TURN INTENT: SUMMARIZE]",
      "你当前这一轮的真实意图是：SUMMARIZE（chat 流中的输出方式：总结输出）。",
      "优先产出简洁清晰的结论摘要、重点归纳、异常提示和下一步建议。",
      "如需读取文件才能准确总结，可以使用只读工具；不要误入计划流，也不要默认开始写代码。",
      "总结应短于正式报告，重点是快速提炼信息，而不是铺成长篇说明。",
    ].join("\n"));
  } else if (turnIntent === "report") {
    parts.push([
      "================================",
      "[TURN INTENT: REPORT]",
      "你当前这一轮的真实意图是：REPORT（chat 流中的输出方式：正式报告输出）。",
      "默认输出结构化 Markdown 报告，优先包含目标、范围、关键发现、风险、限制和建议。",
      "如需读取文件或表格才能形成报告，可以使用只读工具；不要把正式报告误导成普通聊天回复或计划协议。",
      "除非用户明确要求写入文件，否则先把报告正文直接呈现给用户。",
    ].join("\n"));
  } else {
    parts.push([
      "================================",
      "[TURN INTENT: RESPOND]",
      "你当前这一轮的真实意图是：RESPOND（自然回复）。",
      "这一轮用于普通聊天、问答、解释、头脑风暴、澄清需求、比较方案和轻量方案交流。",
      "不要主动进入正式计划协议，不要擅自生成 requirements.md / plan.md / tasks.md，也不要输出仅供执行流使用的 Proposal 结构。",
      "默认不要修改文件、不要执行命令、不要调用写入类工具；如果本轮运行面已经是 EXECUTE、用户已通过批准选项进入执行，或工具审批卡随后批准了具体操作，则可以按批准范围使用写入、命令、浏览器等真实操作工具。",
      "如果你判断下一步需要真实操作（写文件、改代码、运行命令、Git、部署、外部写入、生成交付文件等），先输出简短方案和 `<user_options>`：第一个选项用 action=\"approve_operation_once\" 表达“批准执行本轮操作”，第二个用 action=\"adjust_plan\" 表达“继续调整方案”，必要时第三个用 action=\"cancel_operation\" 表达取消。输出选项后立即停止。",
      "如果不确定用户到底是要继续讨论/调整方案，还是要进入真实执行，不要自作主张；必须给出 `<user_options>` 让用户选择这轮是继续调整方案、先出正式计划，还是批准真实操作。",
      "不要再提及需要用户去切换 Chat / Fast / Plan 之类的界面选项。",
    ].join("\n"));
  }

  if (turnIntentPolicy.workflowMode === "chat") {
    const chatInstructions: string[] = [];
    chatInstructions.push("## 工具调用格式");
    chatInstructions.push(turnIntent === "respond" || turnIntent === "discuss"
      ? "自然回复回合下，优先直接回答。只有在用户的问题必须读取项目内容才能准确回答时，才使用只读工具；如果用户明确批准本轮执行，或运行时已经把本轮升级到 execute 能力，可使用当前工具列表中的写入/命令/浏览器工具，并接受运行时审批约束。"
      : turnIntent === "analyze"
      ? "分析回合下，优先直接给出检查结论。只有在必须读取项目或资料内容才能正确分析时，才使用只读工具。"
      : turnIntent === "summarize"
      ? "总结回合下，优先直接提炼结论。只有在必须读取项目或资料内容才能正确总结时，才使用只读工具。"
      : "报告回合下，优先直接整理结构化报告。只有在必须读取项目或资料内容才能正确成文时，才使用只读工具。");
    chatInstructions.push("数据分析、文档解读、报表总结属于 MAIN 模式内允许的只读工作，不需要为了继续分析切换到 Plan 模式。");
    chatInstructions.push("不要为了这种只读降级向用户申请批准；如果某个只读工具不兼容，就直接换另一条只读路径继续。");
    chatInstructions.push("只读读取、搜索、查看、查询、分析本身不需要逐步征求用户同意；除非存在业务口径冲突或真实分叉，否则不要问“是否同意我读取下一个文件”。");
    if (webResearchToolsAvailable) {
      chatInstructions.push(webResearchDateContext);
      chatInstructions.push("网络搜索已开启：遇到最新信息、网页/GitHub 链接、外部文档、版本/发布断言或需要验证的实时事实，优先使用 `web_search` / `web_fetch`；最终结论必须带来源 URL。不要把模型记忆伪装成联网结果，也不要在未联网取证时直接否定用户看到的最新版本/发布信息。");
    }
    chatInstructions.push("如果 `analyze_tabular_document`、`query_tabular_document`、`read_document` 中某个只读工具失败，不要停下来征求用户是否允许降级；应在同一轮自动改用其他只读工具继续。");
    chatInstructions.push("推荐回退顺序：`analyze_tabular_document` 全表概览 → `query_tabular_document` 结构化筛选/聚合 → `read_document` 原始行窗口/分页读取；可按问题类型调整，但必须继续推进。");
    if (isToolNameAvailable("knowledge_search", availableToolNames)) {
      chatInstructions.push("知识库已启用：当用户问题可能被已导入资料（例如 Unity/API/PDF 手册）覆盖时，先调用 `knowledge_search` 获取片段和 citation，再基于检索证据回答。回答应保留来源文件/页码或块号；如果没有命中，明确说明当前启用知识库未找到依据，不要凭记忆编造。");
    }
    chatInstructions.push(tabularChatGroundingInstruction);
    chatInstructions.push("只有在文件不存在、指标定义或业务口径冲突、或所有只读路径都无法支持当前问题时，才向用户解释 blocker。");
    chatInstructions.push("不要先输出“下一步行动计划”“请稍候，我将开始分析”之类的过渡台词后停住。");
    chatInstructions.push("避免输出“我将再次执行”“请稍候确认是否同意降级”这类过程化台词；直接执行，最后统一汇报结果或剩余阻塞。");
    chatInstructions.push("一旦你判断需要读取本地文件才能回答，就在同一轮直接调用只读工具，不要先发一段“我将开始分析/读取”的文字后停住。");
    chatInstructions.push("如果分析、报告、总结或自然回复最终形成了可执行的修复/实现/生成方案，但本轮尚未获得执行批准，请用普通 Markdown 给出方案，并紧跟 `<user_options>` 请求用户批准执行；不能只在正文里问“是否开始执行”。");
    chatInstructions.push("可用只读工具：" + formatToolNameList(
      customToolNames,
      mcpToolNames,
      READ_ONLY_BUILT_IN_TOOL_NAMES,
      availableToolNames,
    ));
    chatInstructions.push(exposedWriteToolNames.length > 0 || shellToolsAvailable
      ? `未获批准时不要调用本轮写入或执行工具（${[
          ...exposedWriteToolNames,
          ...(shellToolsAvailable ? ["run_command/execute_command"] : []),
        ].join("、")}）；一旦本轮已获用户批准或运行时明确处于 execute 能力，按当前暴露工具和审批结果执行。`
      : "未获批准时不要伪造写入或执行工具调用；一旦本轮已获用户批准或运行时明确处于 execute 能力，也只能按当前真实暴露的工具面执行。");
    parts.push(chatInstructions.join("\n"));
  } else {
    const tfl: string[] = [];
    const compactWorkflowToolGuide =
      toolProtocolProfile?.activeProfile === "local" &&
      toolProtocolProfile?.nativeToolsEnabled !== true &&
      turnIntent === "plan";
    const compactWorkflowToolDescriptions = new Set([
      "get_project_skeleton",
      "read_file",
      "read_document",
      "analyze_tabular_document",
      "query_tabular_document",
      "web_search",
      "web_fetch",
      "repo_map_search",
      "repo_map_context",
      "write_file",
      "apply_patch",
      "browser_evaluate",
    ]);
    tfl.push("## 工具调用格式");
    if (callableToolsAvailable) {
      tfl.push("优先使用 native tool calling；如果当前模型只支持文本工具协议，则使用 XML 格式调用工具：");
      tfl.push("");
      tfl.push("需要工具时只输出完整工具调用，不要先写“我将读取/Let me check/I need to...”这类过程句：");
      tfl.push("如果当前实际使用 native tool calling，可以用 1-3 句普通 Markdown 写公开进度说明；如果使用 XML 工具协议，工具块前后必须纯净，运行时会注入可见进度说明。");
      tfl.push("<tool_use>");
      tfl.push("<tool>工具名称</tool>");
      tfl.push(String.raw`<parameter name="参数名">参数值</parameter>`);
      tfl.push("</tool_use>");
      tfl.push("禁止输出 `[Tool call: ...]`、`Tool call: read_file`、`<tool_code>...</tool_code>`、`我要调用工具` 这类占位文本；这些不是可执行工具调用，会被视为协议错误。需要工具时必须输出完整 `<tool_use>`，并补齐必填参数。");
      tfl.push("");
    } else {
      tfl.push("本轮没有暴露可调用工具。不要输出 XML 工具模板、伪工具调用、占位工具名或 `[Tool call: ...]`；必须用用户可见 Markdown 说明缺少工具能力、等待批准或具体阻塞点。");
      tfl.push("");
    }
    tfl.push(`重要：需要用户看到的分析、总结、方案必须以普通 Markdown 输出，并使用 ${resolvedLanguageName}；不要放进 XML 分析标签或 hidden reasoning。`);
    tfl.push("");
    tfl.push("可用的工具：" + (callableToolsAvailable ? formatToolNameList(
      customToolNames,
      mcpToolNames,
      WORKFLOW_BUILT_IN_TOOL_NAMES,
      availableToolNames,
    ) : "none"));
    if (webResearchToolsAvailable) {
      tfl.push(webResearchDateContext);
      tfl.push("网络搜索已开启：涉及最新信息、外部网页/文档、GitHub URL、版本/发布断言、第三方 API 文档或必须验证的公开事实时，优先用 `web_search` / `web_fetch` 获取证据；最终结论必须包含来源 URL。不要把模型记忆当作联网结果，也不要在未联网取证时直接否定用户看到的最新版本/发布信息。");
    }
    if (turnIntent === "plan") {
      if (instructionLanguage === "en") {
        tfl.push(exposedPlanWriteToolNames.length > 0
          ? "Plan turn: gather read-only evidence, then write `.MAIN/plans/plan.md`. Only write plan.md/design.md before approval; no source edits or tasks.md."
          : "Plan turn: gather evidence from the provided context and output a visible `<proposed_plan>`. No plan write tool is exposed, so do not claim plan.md/design.md was written.");
      } else {
        tfl.push(exposedPlanWriteToolNames.length > 0
          ? "规划回合：先收集只读证据，再写 `.MAIN/plans/plan.md`。批准前只允许写 plan.md/可选证据台账，不修改源码或生成 tasks.md。"
          : "规划回合：基于已提供上下文收集证据并输出可见 `<proposed_plan>`。本轮没有计划写入工具，不要声称已经写入 plan.md/design.md。");
      }
      tfl.push("如果用户最终目标是实现、修复、生成文件或修改项目，本回合仍只产出可审批计划；源码写入、命令执行和最终交付物必须等计划批准后的执行 runtime。不要声称环境没有写入能力，也不要在批准前修改源码。");
      tfl.push("实现/生成类任务禁止在聊天区输出完整项目代码或大段 Markdown 代码清单；计划只描述要改什么、为何改、如何验证。批准后再通过当前执行工具面落地真实文件。");
    }
    tfl.push("");
    tfl.push("### 工具说明：");
    const addToolDescription = (name: string, description: string) => {
      if (compactWorkflowToolGuide && !compactWorkflowToolDescriptions.has(name)) return;
      if (isToolNameAvailable(name, availableToolNames)) tfl.push(description);
    };
    addToolDescription("get_project_skeleton", "- get_project_skeleton: (depth?: number) 极速获取项目宏观骨架。仅在没有明确路径/文件名/符号线索时作为一次浅层发现使用，建议 depth: 2；拿到结构后必须转向定向搜索或读取。");
    addToolDescription("get_file_outline", "- get_file_outline: (path: string) 提取 C# 文件的类型定义和 public/protected 成员签名，剔除函数体。用于理解类的接口和耦合关系，无需读取完整源码。");
    addToolDescription("list_directory", "- list_directory: 列出特定目录内容。优先用于用户给出目录、文件附近路径，或通过搜索结果锁定目标后的定向检查。");
    addToolDescription("web_search", "- web_search: 在公共网络上搜索最新信息、外部资料或网页线索。返回标题、URL、摘要和来源；最终结论必须引用来源 URL。");
    addToolDescription("web_fetch", "- web_fetch: 读取指定 HTTP/HTTPS URL 的正文；GitHub repo/blob/tree/raw 链接会优先解析公开仓库结构或 raw 内容。用于用户给出链接、GitHub 地址、外部文档时定向取证。");
    addToolDescription("repo_map_search", "- repo_map_search: MAIN 内置代码图谱搜索。优先用符号/组件/函数/文件名定位源码，返回文件、行号、签名，不返回大段源码。");
    addToolDescription("repo_map_context", "- repo_map_context: 根据任务从内置代码图谱生成小型上下文包，包含相关文件、符号、行号和关系摘要；拿到行号后再用小窗口 read_file。");
    addToolDescription("repo_map_impact", "- repo_map_impact: 根据符号或文件估算影响范围和测试候选，适合修改后决定验证目标。");
    addToolDescription("read_file", "- read_file: 读取源码、Markdown、JSON、纯文本等可直接按文本处理的文件窗口。支持 start_line/end_line/max_lines；大文件会返回 truncated、returnedLines、nextStartLine。遇到报错行号时读附近窗口；" + (shellToolsAvailable ? "不要用 run_command/cat/sed/head/tail 作为常规文件分页工具。" : "不要用 shell 命令作为常规文件分页工具。"));
    addToolDescription("read_document", "- read_document: 读取 PDF、DOCX、XLSX、CSV、TSV 等文档内容，返回提取文本和来源元数据（页码、sheet、单元格范围等）；对表格文件可结合 `row_offset` / `max_rows` 做分段读取。");
    addToolDescription("analyze_tabular_document", "- analyze_tabular_document: 对 CSV、TSV、XLSX 等大表格做全表统计分析，返回总行数、列概况、缺失值、数值统计和样本行。处理大型表格时优先用它，而不是盲目把整张表塞进上下文。");
    addToolDescription("query_tabular_document", "- query_tabular_document: 对 CSV、TSV、XLSX 做结构化查询，支持筛选、选列、排序、分页、分组聚合。要回答计数、汇总、Top N、条件过滤等问题时优先用它。");
    addToolDescription("index_workspace_documents", "- index_workspace_documents: 扫描某个目录中的文档文件并生成索引摘要。适合先了解资料库，再决定进一步读取哪些文件。");
    addToolDescription("knowledge_search", "- knowledge_search: 在 MAIN 全局知识库中检索当前界面已启用的资料库，返回 Top-K 片段和 citation。涉及已导入手册/API/PDF/HTML 资料的问题，先检索再回答；无命中时说明知识库未找到依据。");
    addToolDescription("knowledge_get_excerpt", "- knowledge_get_excerpt: 根据 knowledge_search 的 source_id/chunk_id 展开已命中的知识库片段；只在需要更多同一 citation 内容时使用。");
    addToolDescription("apply_patch", "- apply_patch: 用补丁真实修改工作区文件。优先使用 Codex 风格 `*** Begin Patch` / `*** End Patch` 与 `*** Update File:`、`*** Add File:`、`*** Delete File:`；也兼容常见 `--- a/file` / `+++ b/file` unified diff。上下文必须来自当前文件内容。");
    addToolDescription("replace_in_file", "- replace_in_file: 精确替换单个文件中的旧文本。只有 search_text 与当前文件完全一致时才会写入；不匹配时只允许定向读取一次当前内容再重试。");
    addToolDescription("write_file", "- write_file: 完整创建或覆盖文件。适合新文件或全文件重写；已有文件同内容写入会被视为无效进展。");
    addToolDescription("run_command", "- run_command: 同步执行一次性 shell 命令并等待完成，返回 stdout、stderr、exitCode、timedOut、durationMs。必须传 `description` 和工作区相对 `cwd`（根目录用 `.`），长命令设置 `timeout_ms`。运行测试、构建、Python 脚本、Git 状态检查/提交/推送等有限命令时优先使用它，并基于返回结果总结成功/失败；不要把它当作常规文件分页读取工具。");
    addToolDescription("browser_evaluate", "- browser_evaluate: 打开本地 dev server 或工作区内 file:// 页面进行真实浏览器验证。必须传 `url`；可传 `actions`（逐行：click/fill/press/select_file/wait_for_selector/wait_for_text）和 `checks`（逐行：text/not_text/selector/not_selector/title/console/not_console/no_console_errors）。用于 UI/DOM/console 渲染验证；不要用 curl/grep/cat 替代它。");
    addToolDescription("execute_command", "- execute_command: 向集成 PTY 发送命令，适合开发服务器、watch 模式、交互式程序或需要保留终端上下文的命令。必须传 `description` 和工作区相对 `cwd`（根目录用 `.`），不要在 command 里用 `cd ... &&` 代替 cwd。可传 `wait_ms` 等待输出，默认 4000，最多 30000。它返回本次发送后的新增输出和 offset；后续用 read_pty_since/read_pty_tail/get_pty_status 继续检查。");
    addToolDescription("send_pty_input", "- send_pty_input: 向当前 PTY 前台进程发送原始输入，适合回答交互提示、输入 y/n、发送 Ctrl+C（input 使用 \\u0003）。可传 `wait_ms` 等待交互程序回显。");
    addToolDescription("read_pty_tail", "- read_pty_tail: 读取终端最近日志，适合快速查看错误栈或长任务尾部输出。命令还在跑且需要观察时，传 `wait_ms` 先等一小段时间再读。");
    addToolDescription("read_pty_since", "- read_pty_since: 按 offset 读取新增终端输出，适合检查某次命令之后发生了什么。命令还在跑且输出未完整时，传 `wait_ms` 等待后再观察，不要用 shell sleep 来等待。");
    addToolDescription("get_pty_status", "- get_pty_status: 检查 PTY 是否运行、当前 buffer offset、最近输出；可传 `wait_ms` 在检查前等待。");
    addToolDescription("clear_pty_buffer", "- clear_pty_buffer: 清空 AI 侧 PTY 捕获缓冲，适合在启动长日志任务前建立干净读取起点。");
    if (shellToolsAvailable) {
      tfl.push("Shell 恢复规则：权限错误会说明来自内置默认策略还是项目策略；不要尝试读取不存在的 `.MAIN/permissions.yaml`。脚手架命令如果报 `not a terminal` / `non-interactive`，不要循环重试，改用非交互参数或按计划用文件工具手动创建结构。");
    }
    tfl.push("");
    tfl.push("### 意图分类与执行边界");
    tfl.push("收到任务后，先判断它是 Atomic（小范围直接落地）还是 Architectural（多阶段、多模块、需要收敛分叉）。");
    tfl.push("在用户可见正文中可以声明你的判断：`任务分类：Atomic / Architectural`。");
    tfl.push("");
    if (turnIntent === "plan") {
      const tflLang = instructionLanguage === "en" ? "en" : "zh";
      if (tflLang === "en") {
        tfl.push(exposedPlanWriteToolNames.length > 0
          ? `Plan turn — read-only evidence gathering first, then write \`.MAIN/plans/plan.md\` with ${planWriteToolText}. No source edits, no tasks.md before approval.`
          : "Plan turn — read-only evidence gathering first, then output a visible `<proposed_plan>` because no plan write tool is exposed. No source edits, no tasks.md before approval.");
        tfl.push("Use \`<user_options>\` only for real branching decisions, not for generic 'continue reading' prompts.");
        tfl.push("If plan isn't ready, give 2-4 clear options; don't force a full plan.md.");
        tfl.push(exposedPlanWriteToolNames.length > 0
          ? "When plan is mature, write plan.md; fall back to \`<proposed_plan>\` only if write tools are unavailable."
          : "When plan is mature, output `<proposed_plan>` Markdown and stop; do not claim a file write.");
        tfl.push(exposedPlanWriteToolNames.length > 0
          ? "Plan artifacts: plan.md is mandatory when plan write tools are exposed, design.md optional (evidence ledger), tasks.md is execution-only."
          : "Plan artifacts: plan.md is not mandatory when no plan write tool is exposed; tasks.md is execution-only.");
        tfl.push(exposedPlanWriteToolNames.length > 0
          ? "Keep plan.md concise: title, summary, key changes, API/interface impact, test plan, assumptions. No tutorial text, no full code dumps."
          : "Keep the visible plan concise: title, summary, key changes, API/interface impact, test plan, assumptions. No tutorial text, no full code dumps.");
        tfl.push(tabularWorkflowPlanInstruction);
      } else {
        tfl.push(exposedPlanWriteToolNames.length > 0
          ? `规划回合：先只读探索，证据足够后用 ${planWriteToolText} 写 \`.MAIN/plans/plan.md\`。批准前不修改源码、不生成 tasks.md。`
          : "规划回合：先只读探索，证据足够后输出可见 `<proposed_plan>`；本轮没有计划写入工具时不要伪造工具调用。批准前不修改源码、不生成 tasks.md。");
        tfl.push("真正分叉才用 \`<user_options>\`，不给'继续读取'类泛化选项。");
        tfl.push("方案未收敛时给 2-4 个明确选择，不要强行写完整 plan.md。");
        tfl.push(exposedPlanWriteToolNames.length > 0
          ? "方案成熟时写入 plan.md；写入工具不可用才降级为 \`<proposed_plan>\`。"
          : "方案成熟时输出 `<proposed_plan>` Markdown 并停止；不要声称已经写入计划文件。");
        tfl.push(exposedPlanWriteToolNames.length > 0
          ? "计划文件：有计划写入工具时 plan.md 必选，design.md 可选（证据台账），tasks.md 属执行阶段。"
          : "计划文件：没有计划写入工具时 plan.md 不强制，tasks.md 属执行阶段。");
        tfl.push(exposedPlanWriteToolNames.length > 0
          ? "plan.md 精简：标题、摘要、关键改动、API/接口影响、测试方案、假设。不写教程、不输出完整代码。"
          : "可见方案保持精简：标题、摘要、关键改动、API/接口影响、测试方案、假设。不写教程、不输出完整代码。");
        tfl.push(tabularWorkflowPlanInstruction);
      }
    } else {
      tfl.push("当前回合是直接实现回合：");
      tfl.push("1. Atomic 任务直接实现，不要为了完成小改动而强行转去计划流。");
      tfl.push("2. 如果当前是在延续一个已批准的计划，则优先遵循当前 runtime 任务清单；不要为了确认 `.MAIN/plans/tasks.md` 是否存在而主动读取它；如果它已知存在，完成后再同步更新对应 checkbox 状态。");
      tfl.push("3. 只有在用户明确要求保存方案、当前回合本来就是计划落盘，或你正在继续一个已批准计划时，才写入 `.MAIN/plans/*.md`。");
      tfl.push(shellToolsAvailable || browserToolsAvailable
        ? `4. 凡是需要命令或浏览器验证的步骤，必须使用本轮实际暴露的执行工具完成：${[
            shellToolsAvailable ? "`run_command`/`execute_command` 及 PTY 读取工具" : "",
            browserToolsAvailable ? "`browser_evaluate`" : "",
          ].filter(Boolean).join("、")}。工具调用必须带必要参数，并基于 stdout/stderr/exitCode、PTY 输出或 DOM/console 断言总结结果。`
        : "4. 本轮未暴露命令或浏览器验证工具；不要声称已经运行测试、构建、Git、浏览器或 DOM 验证。需要这些能力时，明确暂停并说明缺少的工具/审批。");
      tfl.push(shellToolsAvailable
        ? "5. 当用户要求 Git 提交、推送或“提交并推送”时，不要因为 PTY 未启动而声称无法执行；Git 是有限命令，优先用 `run_command` 依次检查 `git status`，必要时查看 `git diff --stat` / `git diff`，再按用户要求执行 `git add ...`、`git commit -m ...`、`git push`。如果没有变更、没有 remote、认证失败、upstream 未设置或 push 被拒绝，必须把 stdout/stderr/exitCode 如实反馈给用户并停止猜测。"
        : "5. 当用户要求 Git 提交、推送或部署但本轮未暴露命令工具时，不要假装完成；说明缺少命令执行能力或等待批准。");
      tfl.push(exposedReadToolNames.length > 0 || exposedWriteToolNames.length > 0
        ? `6. 【绝对禁止只说不做】任何以自然语言输出的“排查说明”、“寻找方案”、“我想先确认”等内容，若无实际工具调用配合，都是违规行为。如果你需要检查，立刻调用本轮可用读取/搜索工具（${readToolText}）；如果你需要修改，立刻调用本轮可用写入工具（${writeToolText}）。必须通过当前或下一条消息的工具调用发出你的动作，不得用纯文本解释代替工具执行。`
        : "6. 【绝对禁止假执行】本轮没有读写工具时，不要用纯文本声称已经排查或修改。必须说明缺少工具能力、等待批准或具体阻塞点。");
    }
    tfl.push("");
    tfl.push("### Steering 发现规则（Steering Discovery）");
    tfl.push("在开始任何实施或正式方案提交之前，你应当：");
    tfl.push("1. 使用 `list_directory` 检查 `.MAIN/steering/` 目录是否存在。如果不存在，直接跳过并开始执行用户任务，**绝对禁止主动创建此目录或任何 steering 规范文件（如 product.md, tech.md 等）**。它们是由用户或项目维护者创建的只读规范，非用户要求时模型不得生成它们。");
    tfl.push("2. 如果存在，优先读取基础文件（product.md、tech.md、structure.md、project_conventions.md）。");
    tfl.push("3. 再根据任务类型选择性读取 fileMatch / auto 领域文件。");
    tfl.push("4. 严格遵守 Steering 文件中的项目级规范；这些规范优先级高于通用建议。");
    tfl.push("");
    tfl.push("### 强制响应格式");
    tfl.push("1. 所有用户需要看到的分析、方案、结论，都必须写在普通 Markdown 中。");
    tfl.push("2. 不要输出 `<analysis>`、`<thought>`、`<thinking>` 或 `<reasoning>` hidden thinking 标签；不要把真正的方案正文、结论、用户需要看到的解释或下一步计划藏进去。");
    tfl.push("3. native tool calling 可以直接发出工具调用；如果需要解释判断、结果或阻塞，再用 1-3 句普通 Markdown 面向用户说明公开进度。XML 工具协议不混排正文，由 runtime 注入 progress narration。");
    tfl.push("4. 工具调用只能通过正式工具格式表达；不要在普通正文中泄露裸工具名、JSON 参数或命令调用痕迹。");
    tfl.push("5. 如果本轮只是解释、总结、继续讨论或提出选择，不要伪装成正式 Proposal。");
    tfl.push("");
    tfl.push("### 正式 Proposal 渲染规则");
    tfl.push("只有当你已经完成规划、准备把正式方案提交给用户审核时，才能进入以下格式：");
    tfl.push("1. 不要输出任何 `<analysis>`、`<thought>`、`<thinking>`、`<reasoning>` hidden thinking 标签。");
    tfl.push("2. 输出一行 `[PROPOSAL START]`。");
    tfl.push("3. 紧接着以 `# Proposed Plan` 作为第一个 Markdown 标题。");
    tfl.push("4. 方案正文必须是根级别 Markdown，且结构化清晰；保持一页审阅摘要风格，不要复制完整规格全文。");
    tfl.push("5. PLAN 正式审批首选写入 `.MAIN/plans/plan.md`；如果只能使用旧 Proposal 协议，则在方案正文最后附加合法 `<plan>` JSON。提交后立即停止，不要再追加寒暄或日志。");

    parts.push(tfl.join("\n"));
  }

  if (resolvedInstructions && resolvedInstructions.layers.length > 0) {
    parts.push(
      "================================\n[WORKSPACE INSTRUCTIONS]\n以下规则由工作区指令文件、兼容规则文件和当前启用的 instruction skills 共同组成。它们的顺序已经按优先级排好，请严格遵守：\n",
    );
    for (const layer of resolvedInstructions.layers) {
      const sourceLabel =
        layer.source.path && !layer.source.path.startsWith("skill:")
          ? ` (${layer.source.path})`
          : "";
      parts.push(`### ${layer.title}${sourceLabel}\n${layer.content}`);
    }
  } else {
    const activeInstructionSkills = skills.filter(
      (s) => s.active && (!s.type || s.type === "instruction"),
    );
    if (activeInstructionSkills.length > 0) {
      parts.push("================================\n[ACTIVE WORKFLOW SKILLS]\n以下是当前生效的高级流程规则，其优先级高于通用准则，请严格执行：\n");
      for (const skill of activeInstructionSkills) {
        parts.push("### " + skill.name + "\n" + skill.content);
      }
    }
  }

  if (resolvedInstructions && resolvedInstructions.templates.length > 0) {
    parts.push(
      "================================\n[WORKSPACE TEMPLATES]\n以下模板是当前工作区约定的推荐骨架。生成意图分析或 Plan 文档时，优先沿用这些章节结构与检查项，但必须替换成当前任务的真实内容，不要照抄占位说明：\n",
    );
    for (const template of resolvedInstructions.templates) {
      const sourceLabel =
        template.source.path && !template.source.path.startsWith("skill:")
          ? ` (${template.source.path})`
          : "";
      parts.push(`### ${template.title}${sourceLabel}\n${template.content}`);
    }
  }

  // Active Protocol Packages — on-disk multi-file workflows
  const activePackages = getApplicableProtocolPackagesForWorkspace(skills, workspace);
  if (activePackages.length > 0) {
    parts.push("================================\n[ACTIVE PROFESSIONAL PROTOCOLS]\nThe following on-disk protocols are active for this workspace:\n");
    for (const pkg of activePackages) {
      const root = pkg.packagePath || "(unknown)";
      const entryPath = getProtocolPackageEntryPath(pkg) || (pkg.entryPoint || "SKILL.md");
      parts.push(`- Skill: ${pkg.name} | Root: ${root} | Entry: ${entryPath}`);
    }
    parts.push("\n这些协议通常存储在磁盘上的隐藏目录中。只有当上面列出的 Entry 路径与当前任务直接相关时，才使用 `read_file` 读取它们的完整路径；不要只传裸文件名。如果某个 Entry 读取失败，不要为了寻找它而反复扫描工作区根目录，最多只在对应协议根目录做一次定向检查，然后继续主任务。");
  }

  return parts.join("\n\n");
}
