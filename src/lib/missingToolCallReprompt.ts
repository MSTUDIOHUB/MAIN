import type { MainModeKey } from "./mainModes";

export type WorkflowModeLike = "chat" | "edit" | "plan";
export type MissingToolCallRepromptKind = "none" | "generic" | "read_only" | "post_write_verify";

export interface MissingToolCallRecentWriteContext {
  lastSuccessfulToolName?: string | null;
  lastSuccessfulTargetPath?: string | null;
  lastSuccessfulTargetOutsidePlan?: boolean;
  recoveringFromEmptyAssistantReply?: boolean;
}

const GENERIC_INTENT_PATTERNS = [
  /现在我来?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /我(?:现在|先|马上|立即)(?:开始|去|来)?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /让我来?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /我将?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /我(?:将|会)?(?:通过|使用|调用)\s*`?(?:read_file|read_document|get_file_outline|grep_search|glob_search|list_directory|analyze_tabular_document|query_tabular_document|write_file|replace_in_file|run_command|execute_command)`?\s*(?:来)?(?:创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索|验证|测试)/i,
  /接下来我?(?:将|会)?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /然后我?(?:将|会)?(创建|执行|生成|写入|修改|删除|添加|运行|实现|获取|查看|扫描|读取|分析|检查|搜索|访问|浏览|查找|探索)/,
  /现在让?我(?:重新|再|继续)?(运行|执行|查看|检查|读取|分析|生成|写入|修改|修复|验证|测试)/,
  /让我(?:重新|再|继续)?(运行|执行|查看|检查|读取|分析|生成|写入|修改|修复|验证|测试)/,
  /(?:重新|再|继续)(运行|执行|查看|检查|读取|分析|生成|写入|修改|修复|验证|测试)(?:一下|.*结果)?/,
  /(?:需要|正在|开始|准备)(?:重新|再|继续|精确|完整|先|马上|立即|进一步){0,4}(?:获取|读取|查看|检查|搜索|分析|验证|测试|修改|写入|执行)/,
  /看看(?:修复后|更新后|运行后|执行后)?(?:的)?结果/,
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
  /我(?:将|会)?(?:通过|使用|调用)\s*`?(?:read_file|read_document|get_file_outline|grep_search|glob_search|list_directory|analyze_tabular_document|query_tabular_document)`?\s*(?:来)?(?:获取|读取|查看|检查|搜索|分析|查询|提取|汇总)/i,
  /现在让?我(?:重新|再|继续)?(运行|执行|查看|检查|读取|分析|查询|验证|测试)/,
  /让我(?:重新|再|继续)?(运行|执行|查看|检查|读取|分析|查询|验证|测试)/,
  /(?:需要|正在|开始|准备)(?:重新|再|继续|精确|完整|先|马上|立即|进一步){0,4}(?:获取|读取|查看|检查|搜索|分析|查询|提取|汇总)/,
  /看看(?:修复后|更新后|运行后|执行后)?(?:的)?结果/,
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

const POST_WRITE_VERIFY_PATTERNS = [
  /我(?:将|会|现在要|接下来要)?(?:立即|马上|先)?(?:运行|测试|验证|执行)(?:一下|这个|该)?(?:程序|项目|脚本|游戏|命令|文件)?/i,
  /(?:下一步|接下来).*(?:运行|测试|验证|执行)/i,
  /(?:run_command|execute_command)\b/i,
  /\bpython\s+\S+/i,
  /\bnpm\s+(?:run\s+)?(?:test|build|start|dev)\b/i,
  /\bpnpm\s+(?:run\s+)?(?:test|build|start|dev)\b/i,
  /\byarn\s+(?:test|build|start|dev)\b/i,
  /\bpytest\b/i,
  /\bplaywright\b/i,
  /\bcargo\s+(?:test|run|build)\b/i,
  /I(?: will|'ll)?(?: now| next)? (?:run|test|verify|execute)\b/i,
  /let me (?:run|test|verify|execute)\b/i,
  /next(?:,? I(?: will|'ll)?)?.*(?:run|test|verify|execute)\b/i,
];

function hasRecentProjectWrite(context?: MissingToolCallRecentWriteContext): boolean {
  return !!context &&
    (context.lastSuccessfulToolName === "write_file" || context.lastSuccessfulToolName === "replace_in_file") &&
    !!context.lastSuccessfulTargetPath &&
    context.lastSuccessfulTargetOutsidePlan === true;
}

function looksLikeGeneratedCodeDump(text: string): boolean {
  if (text.length < 4_000) return false;
  const fenceCount = (text.match(/```/g) ?? []).length;
  const fileMarkerCount = (
    text.match(/(?:^|\n)\s*(?:#{1,4}\s*)?(?:文件|File)\s*[:：]\s*[\w./ -]+\.(?:cs|ts|tsx|js|jsx|json|css|html|md)\b/gi) ?? []
  ).length;
  const codeKeywordCount = (
    text.match(/\b(?:using|namespace|public|private|protected|internal|class|struct|interface|enum|function|const|let|var|import|export)\b/g) ?? []
  ).length;
  return fenceCount >= 4 || fileMarkerCount >= 2 || (text.length >= 12_000 && codeKeywordCount >= 20);
}

export function resolveMissingToolCallRepromptKind(input: {
  workflowMode: WorkflowModeLike;
  visibleText: string;
  mainModeKey?: MainModeKey;
  recentWrite?: MissingToolCallRecentWriteContext;
}): MissingToolCallRepromptKind {
  const text = input.visibleText.trim();
  const isChatLike = input.workflowMode === "chat";
  const recentProjectWrite = hasRecentProjectWrite(input.recentWrite);
  const recoveringFromEmptyAssistantReply = input.recentWrite?.recoveringFromEmptyAssistantReply === true;
  const promisesPostWriteVerification = POST_WRITE_VERIFY_PATTERNS.some((pattern) => pattern.test(text));

  if (input.workflowMode === "edit" && recentProjectWrite) {
    if (!text && recoveringFromEmptyAssistantReply) {
      return "post_write_verify";
    }
    if (promisesPostWriteVerification) {
      return "post_write_verify";
    }
  }

  if (!text) return isChatLike ? "none" : "generic";

  const hasGenericIntent = GENERIC_INTENT_PATTERNS.some((pattern) => pattern.test(text));
  if (!isChatLike) {
    if (looksLikeGeneratedCodeDump(text)) return "generic";
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
  attempt = 1,
): string {
  if (kind === "post_write_verify" && attempt >= 2) {
    return language === "zh"
      ? "上一条回复仍然只是说明接下来要怎么验证，没有真正执行工具。下一条回复必须严格满足：\n" +
          "1. 只输出一个 `<tool_use>` 工具调用块，不要输出任何普通正文、解释、总结或寒暄。\n" +
          "2. 立即调用真实验证工具：优先使用 `run_command` 执行一次性运行/测试命令；只有在需要长驻或交互式进程时才使用 `execute_command`。\n" +
          "3. 直接给出可执行命令，不要只说“我将运行/测试/验证”。\n" +
          "4. `<tool_use>` 外面不要写字。格式必须是：\n" +
          "<tool_use>\n<tool>run_command</tool>\n<parameter name=\"command\">真实可执行的验证命令</parameter>\n</tool_use>"
      : "Your previous reply still only described the validation step instead of executing a tool. The next reply must strictly follow this:\n" +
          "1. Output exactly one `<tool_use>` block and no prose, explanation, summary, or greeting outside it.\n" +
          "2. Call a real validation tool immediately: prefer `run_command` for one-shot run/test commands, and use `execute_command` only when validation truly needs a long-running or interactive process.\n" +
          "3. Provide the actual executable command instead of saying you will run or test it.\n" +
          "4. Nothing outside `<tool_use>`. Required shape:\n" +
          "<tool_use>\n<tool>run_command</tool>\n<parameter name=\"command\">real validation command</parameter>\n</tool_use>";
  }

  if (attempt >= 2) {
    return language === "zh"
      ? "上一条回复仍然只是重复说明，没有真正调用工具。下一条回复必须严格满足：\n" +
          "1. 只输出一个 `<tool_use>` 工具调用块，不要输出任何普通正文、解释、计划或寒暄。\n" +
          "2. 如果要创建文件，用 `write_file`；如果要改已有文件，用 `replace_in_file`；如果还缺上下文，用 `read_file` 或 `get_file_outline`。路径必须是当前任务的真实相对路径，不能写占位符。\n" +
          "3. 如果文件很大，先写最小可编译/可运行骨架，后续再补齐；不要在聊天正文输出完整项目代码。\n" +
          "4. `<tool_use>` 外面不要写字。格式必须是：\n" +
          "<tool_use>\n<tool>write_file</tool>\n<parameter name=\"path\">当前任务的真实相对路径</parameter>\n<parameter name=\"content\">完整文件内容</parameter>\n</tool_use>"
      : "Your previous reply only repeated prose and did not call a tool. The next reply must strictly follow this:\n" +
          "1. Output exactly one `<tool_use>` block and no prose, explanation, plan, or greeting outside it.\n" +
          "2. Use `write_file` to create a file, `replace_in_file` to edit an existing file, or `read_file` / `get_file_outline` if more context is required. The path must be the real relative path for the current task, not a placeholder.\n" +
          "3. If the file is large, write the smallest compilable/runnable skeleton first and fill it in later. Do not output full project code in chat prose.\n" +
          "4. Nothing outside `<tool_use>`. Required shape:\n" +
          "<tool_use>\n<tool>write_file</tool>\n<parameter name=\"path\">real/relative/path</parameter>\n<parameter name=\"content\">full file content</parameter>\n</tool_use>";
  }

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

  if (kind === "post_write_verify") {
    return language === "zh"
      ? "不要只描述接下来要怎么验证。刚刚已经写入了项目文件，现在请立即执行真实验证：\n" +
          "1. 优先使用 `run_command` 运行一次性验证或测试命令。\n" +
          "2. 只有在验证需要长驻或交互式进程时才使用 `execute_command`。\n" +
          "3. 不要再输出“我将运行/测试/验证”，直接调用工具。"
      : "Do not only describe how you will validate the change. A project file was just written, so run the real verification now:\n" +
          "1. Prefer `run_command` for one-shot validation or test commands.\n" +
          "2. Use `execute_command` only when validation needs a long-running or interactive process.\n" +
          "3. Do not say you will run, test, or verify it. Call the tool directly.";
  }

  return language === "zh"
    ? "请继续执行当前任务。注意以下规则：\n" +
        "1. 直接调用最小必要工具推进，不要只写“我将执行/我会处理”这类过程化台词。\n" +
        "2. 必须使用 <tool_use> 格式调用工具，不要只用文字描述。例如：\n" +
        "<tool_use>\n<tool>read_file</tool>\n<parameter name=\"path\">src/foo.ts</parameter>\n</tool_use>\n" +
        "或：\n<tool_use>\n<tool>write_file</tool>\n<parameter name=\"path\">report.md</parameter>\n<parameter name=\"content\"># 分析报告\n...</parameter>\n</tool_use>\n" +
        "3. 不要在聊天区输出完整项目代码或大段 Markdown；如果要生成多个文件，只先写第一个最小核心文件。\n" +
        "4. 若关键参数缺失且会影响结果，可先用一句话提出澄清；否则先执行最小可验证步骤并标注你的假设。\n" +
        "现在请立即用工具继续执行。"
    : "Please continue the current task. Follow these rules:\n" +
        "1. Call the smallest necessary tool step now instead of process narration like “I will do X”.\n" +
        "2. You must call tools with the <tool_use> format instead of only describing them in prose. For example:\n" +
        "<tool_use>\n<tool>read_file</tool>\n<parameter name=\"path\">src/foo.ts</parameter>\n</tool_use>\n" +
        "or:\n" +
        "<tool_use>\n<tool>write_file</tool>\n<parameter name=\"path\">report.md</parameter>\n<parameter name=\"content\"># Analysis Report\n...</parameter>\n</tool_use>\n" +
        "3. Do not output full project code or large Markdown blocks in chat. If generating multiple files, write only the first minimal core file now.\n" +
        "4. If a missing key parameter would change the result, ask one short clarifying question first; otherwise execute the smallest verifiable step and state your assumption.\n" +
        "Now immediately continue using tools.";
}
