export type ToolPresentationLanguage = "zh" | "en";

const TOOL_VERB_LABELS: Record<string, { zh: string; en: string }> = {
  list_directory: { zh: "扫描目录", en: "Scan directory" },
  get_project_skeleton: { zh: "查看项目结构", en: "Inspect project structure" },
  get_file_outline: { zh: "读取文件结构", en: "Read file outline" },
  glob_search: { zh: "搜索文件", en: "Search files" },
  grep_search: { zh: "搜索内容", en: "Search content" },
  read_file: { zh: "读取文件", en: "Read file" },
  read_document: { zh: "读取文档", en: "Read document" },
  analyze_tabular_document: { zh: "分析表格", en: "Analyze table" },
  query_tabular_document: { zh: "查询表格", en: "Query table" },
  index_workspace_documents: { zh: "索引文档", en: "Index documents" },
  replace_in_file: { zh: "修改文件", en: "Edit file" },
  write_file: { zh: "写入文件", en: "Write file" },
  execute_command: { zh: "执行命令", en: "Run command" },
  run_command: { zh: "运行命令", en: "Run command" },
  send_pty_input: { zh: "发送终端输入", en: "Send terminal input" },
  read_pty_buffer: { zh: "读取终端", en: "Read terminal" },
  read_pty_tail: { zh: "读取终端尾部", en: "Read terminal tail" },
  read_pty_since: { zh: "读取新增终端输出", en: "Read new terminal output" },
  get_pty_status: { zh: "检查终端状态", en: "Check terminal status" },
  clear_pty_buffer: { zh: "清空终端缓冲", en: "Clear terminal buffer" },
  Error: { zh: "系统请求失败", en: "System request failed" },
};

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
  if (toolName === "run_command" || toolName === "execute_command") {
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
