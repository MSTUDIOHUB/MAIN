export type ToolPresentationLanguage = "zh" | "en";
export type ToolExecutionPhase = "discover" | "inspect" | "edit" | "command" | "verify" | "blocked" | "message";

const TOOL_VERB_LABELS: Record<string, { zh: string; en: string }> = {
  list_directory: { zh: "扫描目录", en: "Scan directory" },
  get_project_skeleton: { zh: "查看项目结构", en: "Inspect project structure" },
  get_file_outline: { zh: "读取文件结构", en: "Read file outline" },
  glob_search: { zh: "搜索文件", en: "Search files" },
  grep_search: { zh: "搜索内容", en: "Search content" },
  web_search: { zh: "搜索网络", en: "Search web" },
  web_fetch: { zh: "读取网页", en: "Read web page" },
  repo_map_status: { zh: "检查代码图谱", en: "Check repo map" },
  repo_map_search: { zh: "搜索代码图谱", en: "Search repo map" },
  repo_map_context: { zh: "读取代码图谱上下文", en: "Read repo-map context" },
  repo_map_files: { zh: "查看代码图谱文件", en: "Inspect repo-map files" },
  repo_map_impact: { zh: "分析影响范围", en: "Analyze impact" },
  read_file: { zh: "读取文件", en: "Read file" },
  read_document: { zh: "读取文档", en: "Read document" },
  analyze_tabular_document: { zh: "分析表格", en: "Analyze table" },
  query_tabular_document: { zh: "查询表格", en: "Query table" },
  index_workspace_documents: { zh: "索引文档", en: "Index documents" },
  knowledge_search: { zh: "搜索知识库", en: "Search knowledge base" },
  knowledge_get_excerpt: { zh: "读取知识库摘录", en: "Read knowledge excerpt" },
  replace_in_file: { zh: "修改文件", en: "Edit file" },
  write_file: { zh: "写入文件", en: "Write file" },
  apply_patch: { zh: "应用补丁", en: "Apply patch" },
  execute_command: { zh: "执行命令", en: "Run command" },
  run_command: { zh: "运行命令", en: "Run command" },
  browser_evaluate: { zh: "浏览器验证", en: "Validate in browser" },
  send_pty_input: { zh: "发送终端输入", en: "Send terminal input" },
  read_pty_buffer: { zh: "读取终端", en: "Read terminal" },
  read_pty_tail: { zh: "读取终端尾部", en: "Read terminal tail" },
  read_pty_since: { zh: "读取新增终端输出", en: "Read new terminal output" },
  get_pty_status: { zh: "检查终端状态", en: "Check terminal status" },
  clear_pty_buffer: { zh: "清空终端缓冲", en: "Clear terminal buffer" },
  find_gameobjects: { zh: "查找场景对象", en: "Find game objects" },
  manage_camera: { zh: "管理相机", en: "Manage camera" },
  execute_code: { zh: "执行代码", en: "Execute code" },
  Error: { zh: "系统请求失败", en: "System request failed" },
};

const DISCOVERY_TOOLS = new Set([
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "web_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "index_workspace_documents",
  "knowledge_search",
  "find_gameobjects",
]);

const INSPECTION_TOOLS = new Set([
  "get_file_outline",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "knowledge_get_excerpt",
  "web_fetch",
  "execute_code",
]);

const EDIT_TOOLS = new Set(["replace_in_file", "write_file", "apply_patch"]);
const COMMAND_TOOLS = new Set([
  "execute_command",
  "run_command",
  "browser_evaluate",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
  "manage_camera",
]);

const VERIFY_COMMAND_RE = /\b(?:test|build|lint|check|typecheck|tsc|playwright|vitest|jest|pytest|cargo\s+(?:test|check)|go\s+test)\b/i;

function localize(language: ToolPresentationLanguage, labels: { zh: string; en: string }): string {
  return language === "en" ? labels.en : labels.zh;
}

function shortenPathLikeTarget(target: string): string {
  const normalized = target.replace(/[\\/]+$/g, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return target;
  if (parts.length <= 3) return normalized;
  return `.../${parts.slice(-3).join("/")}`;
}

export function getToolPresentationLabel(
  toolName: string,
  language: ToolPresentationLanguage = "zh",
): string {
  const labels = TOOL_VERB_LABELS[toolName];
  if (labels) return localize(language, labels);
  const fallback = toolName.replace(/_/g, " ").trim() || "tool";
  return language === "en" ? fallback : "调用工具";
}

export function compactToolPresentationTarget(
  rawTarget: string,
  toolName: string,
  language: ToolPresentationLanguage = "zh",
): string {
  const target = String(rawTarget || "").trim();
  if (!target) {
    if (toolName === "get_project_skeleton") return language === "en" ? "Project skeleton" : "项目骨架";
    if (toolName === "index_workspace_documents") return language === "en" ? "Workspace documents" : "工作区文档";
    if (toolName === "read_pty_buffer" || toolName === "read_pty_tail" || toolName === "read_pty_since" || toolName === "get_pty_status" || toolName === "clear_pty_buffer") {
      return language === "en" ? "Terminal" : "终端";
    }
    return language === "en" ? "Current workspace" : "当前工作区";
  }

  if (target === "." || target === "./") return language === "en" ? "Project root" : "项目根目录";
  if (toolName === "run_command" || toolName === "execute_command" || toolName === "browser_evaluate") {
    return target.length > 80 ? `${target.slice(0, 77).trim()}...` : target;
  }

  return shortenPathLikeTarget(target);
}

export function formatToolPresentation(input: {
  toolName: string;
  target?: string;
  language?: ToolPresentationLanguage;
}): { label: string; target: string; summary: string } {
  const language = input.language || "zh";
  const label = getToolPresentationLabel(input.toolName, language);
  const target = compactToolPresentationTarget(input.target || "", input.toolName, language);
  return {
    label,
    target,
    summary: language === "en" ? `${label}: ${target}` : `${label}：${target}`,
  };
}

export function deriveToolPhase(input: {
  toolName: string;
  target?: string;
  status?: string;
  toolStatus?: string;
}): ToolExecutionPhase {
  const status = String(input.toolStatus || input.status || "").toLowerCase();
  if (status === "failed" || status === "error" || status === "rejected") return "blocked";

  const toolName = String(input.toolName || "");
  if (DISCOVERY_TOOLS.has(toolName)) return "discover";
  if (INSPECTION_TOOLS.has(toolName)) return "inspect";
  if (EDIT_TOOLS.has(toolName)) return "edit";
  if (toolName === "browser_evaluate") return "verify";
  if (COMMAND_TOOLS.has(toolName)) {
    const target = String(input.target || "");
    return VERIFY_COMMAND_RE.test(target) ? "verify" : "command";
  }
  if (toolName === "Error") return "blocked";
  return "message";
}

function trimIntentSummary(text: string): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 117).trim()}...`;
}

function compactContextText(text: string, maxChars = 72): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

function inferTargetRole(input: {
  toolName: string;
  target?: string;
  targetRole?: string;
  language: ToolPresentationLanguage;
}): string {
  const explicit = compactContextText(input.targetRole || "", 90);
  if (explicit) return explicit;
  const target = String(input.target || "").trim();
  const compactTarget = compactToolPresentationTarget(target, input.toolName, input.language);
  if (/ChatArea/i.test(target)) return input.language === "en" ? "ChatArea rendering logic" : "ChatArea 渲染逻辑";
  if (/ActionCard/i.test(target)) return input.language === "en" ? "ActionCard tool-card UI" : "ActionCard 工具卡展示";
  if (/useAppStore/i.test(target)) return input.language === "en" ? "message visibility state" : "消息可见性状态";
  if (/orchestrator/i.test(target)) return input.language === "en" ? "agent orchestration flow" : "agent 编排流程";
  if (/toolPresentation/i.test(target)) return input.language === "en" ? "tool intent copy" : "工具意图说明";
  if (/systemPrompt/i.test(target)) return input.language === "en" ? "system prompt rules" : "系统提示规则";
  if (/hiddenProcess/i.test(target)) return input.language === "en" ? "hiddenProcess visibility path" : "hiddenProcess 可见性链路";
  return compactTarget;
}

function joinZhVerbObject(verb: string, object: string): string {
  return /^[A-Za-z0-9_`]/.test(object) ? `${verb} ${object}` : `${verb}${object}`;
}

function deriveContextualToolIntent(input: {
  phase: ToolExecutionPhase;
  toolName: string;
  target?: string;
  language: ToolPresentationLanguage;
  userGoal?: string;
  currentHypothesis?: string;
  previousObservation?: string;
  targetRole?: string;
}): string {
  const role = inferTargetRole(input);
  const hypothesis = compactContextText(input.currentHypothesis || "", 88);
  const observation = compactContextText(input.previousObservation || "", 88);
  const goal = compactContextText(input.userGoal || "", input.language === "en" ? 56 : 44);
  const target = String(input.target || "");

  if (input.language === "en") {
    if (input.phase === "edit") {
      return trimIntentSummary(goal
        ? `Edit ${role} so the implementation matches the user goal: ${goal}.`
        : `Edit ${role} where the relevant implementation has been confirmed.`);
    }
    if (input.phase === "verify") {
      if (/npm\s+(?:run\s+)?build/i.test(target)) return "Run the build to confirm TypeScript/Vite accepts the changed code.";
      if (/\btest|vitest|jest|playwright|pytest|go\s+test|cargo\s+test\b/i.test(target)) return "Run tests to confirm the changed behavior still passes.";
      return `Run verification for ${role} and use the result as completion evidence.`;
    }
    if (input.phase === "command") return `Run the command for ${role} and use its output to decide the next step.`;
    if (input.phase === "discover" || input.phase === "inspect") {
      if (hypothesis) return trimIntentSummary(`Check ${role} to test the current hypothesis: ${hypothesis}`);
      if (observation) return trimIntentSummary(`Read ${role} after the previous observation: ${observation}`);
      if (goal) return trimIntentSummary(`Read ${role} because the user goal depends on how it currently works: ${goal}`);
      return `Read ${role} and confirm the implementation details before changing anything.`;
    }
    return "";
  }

  if (input.phase === "edit") {
    return trimIntentSummary(goal
      ? `${joinZhVerbObject("修改", role)}，让实现对齐用户目标：${goal}。`
      : `${joinZhVerbObject("修改", role)}，把已确认的方案落到代码里。`);
  }
  if (input.phase === "verify") {
    if (/npm\s+(?:run\s+)?build/i.test(target)) return "运行构建，确认 TypeScript/Vite 能接受这次改动。";
    if (/\btest|vitest|jest|playwright|pytest|go\s+test|cargo\s+test\b/i.test(target)) return "运行测试，确认受影响行为仍然通过。";
    return `${joinZhVerbObject("验证", role)}，用结果作为完成或继续修复的证据。`;
  }
  if (input.phase === "command") return `${joinZhVerbObject("执行", role)}，根据输出决定下一步。`;
  if (input.phase === "discover" || input.phase === "inspect") {
    if (hypothesis) return trimIntentSummary(`${joinZhVerbObject("读取", role)}，确认当前判断是否成立：${hypothesis}`);
    if (observation) return trimIntentSummary(`基于前一步观察继续${joinZhVerbObject("读取", role)}：${observation}`);
    if (goal) return trimIntentSummary(`${joinZhVerbObject("读取", role)}，因为用户目标依赖它当前如何实现：${goal}`);
    return `${joinZhVerbObject("读取", role)}，确认实现细节后再修改。`;
  }
  return "";
}

export function deriveToolIntentSummary(input: {
  toolName: string;
  target?: string;
  language?: ToolPresentationLanguage;
  status?: string;
  toolStatus?: string;
  userGoal?: string;
  currentHypothesis?: string;
  previousObservation?: string;
  targetRole?: string;
}): string {
  const language = input.language || "zh";
  const phase = deriveToolPhase(input);
  const toolName = String(input.toolName || "");
  const contextual = deriveContextualToolIntent({
    phase,
    toolName,
    target: input.target,
    language,
    userGoal: input.userGoal,
    currentHypothesis: input.currentHypothesis,
    previousObservation: input.previousObservation,
    targetRole: input.targetRole,
  });
  if (contextual) return trimIntentSummary(contextual);

  if (language === "en") {
    if (phase === "blocked") return "Preserve the blocked step and its reason so recovery is possible.";
    if (phase === "edit") return "Apply the planned change to the target file.";
    if (phase === "verify") return "Run a verification command to check whether the change holds.";
    if (phase === "command") return "Run the command and use its output to decide the next step.";
    if (phase === "discover") {
      if (toolName === "grep_search" || toolName === "glob_search") {
        return "Locate relevant files or symbols before reading more context.";
      }
      return "Inspect the workspace shape and narrow the useful context.";
    }
    if (phase === "inspect") {
      if (toolName === "analyze_tabular_document" || toolName === "query_tabular_document") {
        return "Analyze the table data and confirm the relevant facts.";
      }
      if (toolName === "get_file_outline") return "Read the file structure before touching implementation details.";
      return "Read the target content and confirm the implementation details.";
    }
    return "Keep the process message for traceability.";
  }

  if (phase === "blocked") return "保留受阻步骤和原因，方便后续恢复。";
  if (phase === "edit") return "按方案修改目标文件。";
  if (phase === "verify") return "运行验证命令，确认改动是否成立。";
  if (phase === "command") return "执行命令并根据输出决定下一步。";
  if (phase === "discover") {
    if (toolName === "grep_search" || toolName === "glob_search") {
      return "定位相关文件或符号，再收敛后续读取范围。";
    }
    return "查看工作区结构，缩小有效上下文范围。";
  }
  if (phase === "inspect") {
    if (toolName === "analyze_tabular_document" || toolName === "query_tabular_document") {
      return "分析表格数据，确认相关事实。";
    }
    if (toolName === "get_file_outline") return "先查看文件结构，再进入实现细节。";
    return "读取目标内容，确认实现细节。";
  }
  return trimIntentSummary("记录过程消息，保留可追溯上下文。");
}
