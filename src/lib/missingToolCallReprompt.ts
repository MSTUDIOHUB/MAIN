import type { MainModeKey } from "./mainModes";

export type WorkflowModeLike = "chat" | "edit" | "plan";
export type MissingToolCallRepromptKind = "none" | "generic" | "read_only";

const GENERIC_INTENT_PATTERNS = [
  /现在我来?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /我(?:现在|先|马上|立即)(?:开始|去|来)?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /让我来?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /我将?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /接下来我?(?:将|会)?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /然后我?(?:将|会)?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /需要(?:先)?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /先(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /I will (create|execute|generate|write|modify|delete|add|run|implement|get|read|check|search|explore|analyze|access|look)/i,
  /let me (create|execute|generate|write|modify|delete|add|run|implement|get|read|check|search|explore|analyze|access|look)/i,
  /now I'll (create|execute|generate|write|modify|delete|add|run|implement|get|read|check|search|explore|analyze|access|look)/i,
  /next,? I(?: will)?(?:'ll)? (create|execute|generate|write|modify|delete|add|run|implement|get|read|check|search|explore|analyze|access|look)/i,
  /I need to (create|execute|generate|write|modify|delete|add|run|implement|get|read|check|search|explore|analyze|access|look)/i,
  /let's (create|execute|generate|write|modify|delete|add|run|implement|get|read|check|search|explore|analyze|access|look)/i,
];

const PROMISED_READ_ONLY_ACTION_PATTERNS = [
  /我(?:将|会)?(?:先|马上|立即|接着)?(?:开始|从.*开始|依次|逐个)?(?:对.*)?(分析|读取|扫描|检查|搜索|查看|浏览|查找|探索|梳理|提取|汇总|查询)/,
  /(?:我将|我会).*(?:开始|着手).*(分析|读取|扫描|检查|搜索|查看|浏览|查找|探索|梳理|提取|汇总|查询)/,
  /请稍候.*(?:开始|分析|读取|扫描|检查|搜索|查看|汇总)/,
  /下一步行动计划/,
  /I(?: will|'ll)? start by (?:reading|analyzing|scanning|checking|searching|reviewing|inspecting|querying|summarizing)/i,
  /I(?: will|'ll)? begin by (?:reading|analyzing|scanning|checking|searching|reviewing|inspecting|querying|summarizing)/i,
  /let me start by (?:reading|analyzing|scanning|checking|searching|reviewing|inspecting|querying|summarizing)/i,
  /let me begin by (?:reading|analyzing|scanning|checking|searching|reviewing|inspecting|querying|summarizing)/i,
  /please wait.*(?:start|analyz|read|scan|check|search|review|inspect|query|summar)/i,
  /next action plan/i,
];

const READ_ONLY_TOOL_MENTION_PATTERNS = [
  /\banalyze_tabular_document\b/i,
  /\bquery_tabular_document\b/i,
  /\bread_document\b/i,
  /\bread_file\b/i,
  /\bget_project_skeleton\b/i,
  /\bget_file_outline\b/i,
  /\blist_directory\b/i,
  /\bglob_search\b/i,
  /\bgrep_search\b/i,
  /\bindex_workspace_documents\b/i,
];

const READ_ONLY_TASK_CUE_PATTERNS = [
  /结构化分析/,
  /元数据/,
  /列名/,
  /字段/,
  /数据类型/,
  /缺失值/,
  /分布情况/,
  /表格/,
  /文档/,
  /文件/,
  /工作区/,
  /报告/,
  /分析/,
  /metadata/i,
  /columns?/i,
  /missing values?/i,
  /distribution/i,
  /spreadsheet/i,
  /document/i,
  /workspace/i,
  /report/i,
  /dataset/i,
  /analy(?:s|z)e/i,
];

export function resolveMissingToolCallRepromptKind(input: {
  workflowMode: WorkflowModeLike;
  visibleText: string;
  mainModeKey?: MainModeKey;
}): MissingToolCallRepromptKind {
  const text = input.visibleText.trim();
  const isChatLike = input.workflowMode === "chat";
  if (!text) return isChatLike ? "none" : "generic";

  const hasGenericIntent = GENERIC_INTENT_PATTERNS.some((pattern) => pattern.test(text));
  if (!isChatLike) {
    return hasGenericIntent ? "generic" : "none";
  }

  const hasPromisedReadOnlyAction = PROMISED_READ_ONLY_ACTION_PATTERNS.some((pattern) => pattern.test(text));
  const hasReadOnlyToolMention = READ_ONLY_TOOL_MENTION_PATTERNS.some((pattern) => pattern.test(text));
  const hasReadOnlyTaskCue = READ_ONLY_TASK_CUE_PATTERNS.some((pattern) => pattern.test(text));
  const looksLikeReadOnlyKickoff =
    hasPromisedReadOnlyAction &&
    (hasReadOnlyToolMention || hasReadOnlyTaskCue || input.mainModeKey === "main_mode");

  if (looksLikeReadOnlyKickoff) {
    return "read_only";
  }

  const isShortIntentStub = text.length < 200;
  return isShortIntentStub && hasGenericIntent ? "generic" : "none";
}

export function buildMissingToolCallContinuationPrompt(
  kind: Exclude<MissingToolCallRepromptKind, "none">,
  language: "zh" | "en",
): string {
  if (kind === "read_only") {
    return language === "zh"
      ? "不要只描述接下来要做什么。现在请立即开始真实分析：\n" +
          "1. 如果任务涉及工作区文件、文档、表格或数据，请立刻调用合适的只读工具，例如 `list_directory`、`read_file`、`read_document`、`analyze_tabular_document`、`query_tabular_document`。\n" +
          "2. 不要再输出“请稍候”“我将开始”或“下一步行动计划”这类过程化台词。\n" +
          "3. 只有在你已经实际读取了文件内容后，才总结发现、生成报告结构或提出下一步建议。"
      : "Do not only narrate what you are about to do. Start the real analysis now:\n" +
          "1. If the task depends on workspace files, documents, spreadsheets, or data, immediately call the appropriate read-only tools such as `list_directory`, `read_file`, `read_document`, `analyze_tabular_document`, or `query_tabular_document`.\n" +
          "2. Do not output process filler like “please wait”, “I will start”, or “next action plan”.\n" +
          "3. Only summarize findings, draft the report structure, or recommend next steps after you have actually read the relevant file contents.";
  }

  return language === "zh"
    ? "请继续执行你的计划。注意以下规则：\n" +
        "1. 不要询问用户指示，你自己做决定并执行。\n" +
        "2. 必须使用 <tool_use> 格式调用工具，不要只用文字描述。例如：\n" +
        "<tool_use>\n<tool>read_file</tool>\n<parameter name=\"path\">src/foo.ts</parameter>\n</tool_use>\n" +
        "或：\n<tool_use>\n<tool>write_file</tool>\n<parameter name=\"path\">report.md</parameter>\n<parameter name=\"content\"># 分析报告\n...</parameter>\n</tool_use>\n" +
        "3. 如果不确定，选择最合理的方案直接执行，不要等待确认。\n" +
        "现在请立即用工具继续执行。"
    : "Please continue executing your plan. Follow these rules:\n" +
        "1. Do not ask the user what to do next. Make the best reasonable decision and proceed.\n" +
        "2. You must call tools with the <tool_use> format instead of only describing them in prose. For example:\n" +
        "<tool_use>\n<tool>read_file</tool>\n<parameter name=\"path\">src/foo.ts</parameter>\n</tool_use>\n" +
        "or:\n" +
        "<tool_use>\n<tool>write_file</tool>\n<parameter name=\"path\">report.md</parameter>\n<parameter name=\"content\"># Analysis Report\n...</parameter>\n</tool_use>\n" +
        "3. If uncertain, choose the most reasonable path and execute it instead of waiting for confirmation.\n" +
        "Now immediately continue using tools.";
}
