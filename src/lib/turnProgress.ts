import { parsePlanJobs, type PlanJobItem } from "./planProposal";

export type TurnProgressStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TurnProgressItem {
  id: string;
  text: string;
  status: TurnProgressStatus;
}

interface ProgressBlock {
  id?: number | string;
  type?: string;
  content?: string;
  streaming?: boolean;
  jobs?: Array<{ id: string; subject: string; status: string }>;
  toolName?: string;
  target?: string;
  toolStatus?: string;
}

const PLAN_BLOCK_RE = /<plan>([\s\S]*?)<\/plan>/gi;

const TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  get_project_skeleton: { zh: "扫描项目", en: "Scan project" },
  get_file_outline: { zh: "读取结构", en: "Read outline" },
  list_directory: { zh: "扫描目录", en: "Scan directory" },
  read_file: { zh: "读取文件", en: "Read file" },
  read_document: { zh: "读取文档", en: "Read document" },
  glob_search: { zh: "搜索文件", en: "Search files" },
  grep_search: { zh: "搜索内容", en: "Search content" },
  index_workspace_documents: { zh: "索引文档", en: "Index documents" },
  analyze_tabular_document: { zh: "分析表格", en: "Analyze table" },
  query_tabular_document: { zh: "查询表格", en: "Query table" },
  write_file: { zh: "写入文件", en: "Write file" },
  replace_in_file: { zh: "修改文件", en: "Edit file" },
  delete_workspace_path: { zh: "删除路径", en: "Delete path" },
  run_command: { zh: "执行命令", en: "Run command" },
  execute_command: { zh: "启动命令", en: "Start command" },
  send_pty_input: { zh: "发送终端输入", en: "Send terminal input" },
  Error: { zh: "报告错误", en: "Report error" },
};

function normalizeJobStatus(status: string): TurnProgressStatus {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "in_progress";
  if (status === "failed") return "failed";
  return "pending";
}

function normalizeToolStatus(status: string): TurnProgressStatus {
  if (status === "executed") return "completed";
  if (status === "failed" || status === "rejected") return "failed";
  if (status === "running" || status === "pending") return "in_progress";
  return "pending";
}

function compactToolTarget(rawTarget: unknown, toolName: string, language: "zh" | "en"): string {
  const target = String(rawTarget || "").trim();
  if (!target) {
    if (toolName === "get_project_skeleton") return language === "zh" ? "项目骨架" : "Project skeleton";
    if (toolName === "index_workspace_documents") return language === "zh" ? "工作区文档" : "Workspace documents";
    return language === "zh" ? "当前工作区" : "Current workspace";
  }

  if (target === "." || target === "./") return language === "zh" ? "项目根目录" : "Project root";
  const normalized = target.replace(/[\\/]+$/g, "");
  return normalized.split(/[\\/]/).pop() || target;
}

function parsePlanJobsFromAgentContent(content: string): PlanJobItem[] | null {
  let latest: PlanJobItem[] | null = null;
  let match: RegExpExecArray | null;
  PLAN_BLOCK_RE.lastIndex = 0;

  while ((match = PLAN_BLOCK_RE.exec(content)) !== null) {
    const parsed = parsePlanJobs(match[1] || "");
    if (parsed && parsed.length > 0) latest = parsed;
  }

  return latest;
}

function mapJobsToProgressItems(jobs: PlanJobItem[]): TurnProgressItem[] {
  return jobs.map((job, index) => ({
    id: String(job.id || index + 1),
    text: job.subject,
    status: normalizeJobStatus(job.status),
  }));
}

function findLatestExplicitProgress(blocks: ProgressBlock[]): TurnProgressItem[] {
  let latestIndex = -1;
  let latestItems: TurnProgressItem[] = [];

  blocks.forEach((block, index) => {
    if (block.type === "jobList" && Array.isArray(block.jobs) && block.jobs.length > 0) {
      latestIndex = index;
      latestItems = block.jobs.map((job, jobIndex) => ({
        id: String(job.id || jobIndex + 1),
        text: String(job.subject || "").trim(),
        status: normalizeJobStatus(String(job.status || "")),
      })).filter((item) => item.text.length > 0);
      return;
    }

    if (block.type !== "agent" || block.streaming) return;
    const parsed = parsePlanJobsFromAgentContent(String(block.content || ""));
    if (!parsed || parsed.length === 0 || index < latestIndex) return;
    latestIndex = index;
    latestItems = mapJobsToProgressItems(parsed);
  });

  return latestItems;
}

function deriveToolProgressItems(blocks: ProgressBlock[], language: "zh" | "en"): TurnProgressItem[] {
  return blocks
    .filter((block) => block.type === "tool")
    .map((block, index) => {
      const toolName = String(block.toolName || "");
      const label = TOOL_LABELS[toolName]?.[language] || (language === "zh" ? "调用工具" : "Use tool");
      const target = compactToolTarget(block.target, toolName, language);
      return {
        id: String(block.id || `tool-${index + 1}`),
        text: `${label}: ${target}`,
        status: normalizeToolStatus(String(block.toolStatus || "")),
      };
    });
}

export function deriveTurnProgressItems(
  blocks: ProgressBlock[],
  language: "zh" | "en" = "zh",
): TurnProgressItem[] {
  const explicitItems = findLatestExplicitProgress(blocks);
  if (explicitItems.length > 0) return explicitItems;
  return deriveToolProgressItems(blocks, language);
}
