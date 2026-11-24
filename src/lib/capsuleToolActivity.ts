type CapsuleLanguage = "zh" | "en";

interface ToolActivityCopy {
  readonly zh: string;
  readonly en: string;
  readonly enLive: string;
  readonly target?: "path" | "host";
  readonly liveWithTarget?: string;
}

const READ_FILE: ToolActivityCopy = {
  zh: "读取文件", en: "Read file", enLive: "Reading file", target: "path", liveWithTarget: "读取",
};
const EDIT_FILE: ToolActivityCopy = {
  zh: "修改文件", en: "Edit file", enLive: "Editing file", target: "path", liveWithTarget: "修改",
};
const RUN_COMMAND: ToolActivityCopy = {
  zh: "运行命令", en: "Run command", enLive: "Running command",
};
const RUN_CHECK: ToolActivityCopy = {
  zh: "运行检查", en: "Run check", enLive: "Running a check",
};
const TOOL_ACTIVITY_COPY: Readonly<Record<string, ToolActivityCopy>> = {
  read_file: READ_FILE,
  read_document: READ_FILE,
  get_file_outline: READ_FILE,
  code_ast_query: READ_FILE,
  write_file: EDIT_FILE,
  replace_in_file: EDIT_FILE,
  apply_patch: EDIT_FILE,
  delete_workspace_path: {
    zh: "删除文件", en: "Delete file", enLive: "Deleting file", target: "path", liveWithTarget: "删除",
  },
  get_project_skeleton: { zh: "查看项目结构", en: "Inspect project structure", enLive: "Inspecting project structure" },
  list_directory: { zh: "查看目录", en: "List directory", enLive: "Listing directory", target: "path" },
  glob_search: { zh: "搜索文件", en: "Find files", enLive: "Finding files" },
  grep_search: { zh: "搜索内容", en: "Search content", enLive: "Searching content" },
  find_symbol_references: { zh: "查找符号引用", en: "Find references", enLive: "Finding references" },
  load_skill: { zh: "查看技能", en: "Inspect skill", enLive: "Inspecting skill" },
  tool_search: { zh: "查找可用工具", en: "Find tools", enLive: "Finding tools" },
  knowledge_search: { zh: "搜索知识库", en: "Search knowledge base", enLive: "Searching knowledge base" },
  knowledge_get_excerpt: { zh: "读取知识摘录", en: "Read knowledge excerpt", enLive: "Reading knowledge excerpt" },
  analyze_tabular_document: { zh: "分析表格", en: "Analyze table", enLive: "Analyzing table", target: "path" },
  query_tabular_document: { zh: "查询表格", en: "Query table", enLive: "Querying table", target: "path" },
  git_status: { zh: "查看 Git 状态", en: "Check Git status", enLive: "Checking Git status" },
  git_diff: { zh: "查看 Git 差异", en: "Inspect Git diff", enLive: "Inspecting Git diff" },
  web_search: { zh: "搜索网页", en: "Search web", enLive: "Searching the web" },
  web_fetch: { zh: "读取网页", en: "Read web page", enLive: "Reading web page", target: "host" },
  run_command: RUN_COMMAND,
  unity_compile_project: { zh: "检查引擎编译", en: "Check Editor compilation", enLive: "Checking Editor compilation" },
  execute_command: RUN_COMMAND,
  browser_evaluate: { zh: "操作浏览器", en: "Use browser", enLive: "Using the browser", target: "host" },
  computer_use: { zh: "操作桌面应用", en: "Use desktop app", enLive: "Using a desktop app" },
  send_pty_input: { zh: "发送终端输入", en: "Send terminal input", enLive: "Sending terminal input" },
  read_pty_buffer: { zh: "读取终端", en: "Read terminal", enLive: "Reading terminal" },
  read_pty_tail: { zh: "读取终端", en: "Read terminal", enLive: "Reading terminal" },
  read_pty_since: { zh: "读取终端", en: "Read terminal", enLive: "Reading terminal" },
  submit_plan_document: { zh: "保存计划文档", en: "Save plan document", enLive: "Saving plan document" },
};

function compactPath(raw: string, workspaceKey: string | null | undefined): string | undefined {
  if (!raw || /[\x00-\x1f\x7f]/.test(raw) || raw.includes("://")) return undefined;
  const path = raw.trim().replace(/\\/g, "/").replace(/\/$/, "");
  const workspace = workspaceKey?.replace(/\\/g, "/").replace(/\/$/, "");
  if (path === workspace || path === ".") return undefined;

  // Expose workspace-relative paths. Paths outside the workspace reveal only
  // their filename, not the user's home directory or host filesystem layout.
  const relativeToWorkspace = workspace && path.startsWith(`${workspace}/`)
    ? path.slice(workspace.length + 1)
    : undefined;
  const absolute = /^(?:[A-Za-z]:)?\//.test(path) || path.startsWith("~/");
  const relative = relativeToWorkspace ?? path;
  const segments = relative.split("/").filter(Boolean);
  if (segments.includes("..")) return undefined;
  const display = absolute && relativeToWorkspace === undefined ? segments[segments.length - 1] : relative;
  if (!display) return undefined;
  return display.length <= 120 ? display : `…${display.slice(-119)}`;
}

function safeWebHost(target: string): string | undefined {
  try {
    const url = new URL(target);
    return url.protocol === "https:" || url.protocol === "http:" ? url.host : undefined;
  } catch {
    return undefined;
  }
}

/** Shared live/history copy. Only known path fields and URL hosts are shown.
 * Tool names, shell input, search terms, and payloads are never rendered. */
export function describeCapsuleToolActivity(input: {
  readonly toolName: string;
  readonly target?: string;
  readonly validation?: boolean;
  readonly workspaceKey?: string | null;
  readonly language: CapsuleLanguage;
  readonly live?: boolean;
}): { title: string; target?: string } {
  const copy = Object.prototype.hasOwnProperty.call(TOOL_ACTIVITY_COPY, input.toolName)
    ? TOOL_ACTIVITY_COPY[input.toolName]
    : undefined;
  const rawTarget = typeof input.target === "string" ? input.target : "";
  const target = copy?.target === "path"
    ? compactPath(input.toolName === "apply_patch" ? rawTarget.split(", ", 1)[0] : rawTarget, input.workspaceKey)
    : copy?.target === "host" ? safeWebHost(rawTarget)
    : undefined;
  const labels = input.validation ? RUN_CHECK : copy || {
    zh: "调用工具", en: "Run tool", enLive: "Running a tool",
  };
  const title = input.language === "en"
    ? input.live ? labels.enLive : labels.en
    : input.live ? `正在${target ? labels.liveWithTarget || labels.zh : labels.zh}` : labels.zh;
  return { title, ...(target ? { target } : {}) };
}
