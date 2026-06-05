import { compactToolPresentationTarget, getToolPresentationLabel } from "../toolPresentation";
import type { ChatOperationCluster } from "../toolUiGrouping";
import type { ChatLanguage } from "../../types/chat";

export const TOOL_SUMMARY_GROUPS = {
  read: new Set(["get_project_skeleton", "get_file_outline", "read_file", "read_document", "list_directory", "glob_search", "grep_search", "repo_map_status", "repo_map_search", "repo_map_context", "repo_map_files", "repo_map_impact", "index_workspace_documents", "knowledge_search", "knowledge_get_excerpt"]),
  table: new Set(["analyze_tabular_document", "query_tabular_document"]),
  edit: new Set(["replace_in_file", "write_file", "apply_patch"]),
  command: new Set(["execute_command", "send_pty_input", "run_command", "browser_evaluate", "read_pty_buffer", "read_pty_tail", "read_pty_since", "get_pty_status", "clear_pty_buffer"]),
};

export const READ_CONTEXT_TOOL_NAMES = new Set([
  "get_project_skeleton",
  "get_file_outline",
  "read_file",
  "read_document",
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "index_workspace_documents",
  "knowledge_search",
  "knowledge_get_excerpt",
]);

const READ_CONTEXT_TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  get_project_skeleton: { zh: "扫描项目", en: "Scan project" },
  get_file_outline: { zh: "读取结构", en: "Read outline" },
  read_file: { zh: "读取文件", en: "Read file" },
  read_document: { zh: "读取文档", en: "Read document" },
  list_directory: { zh: "扫描目录", en: "Scan directory" },
  glob_search: { zh: "搜索文件", en: "Search files" },
  grep_search: { zh: "搜索内容", en: "Search content" },
  repo_map_status: { zh: "检查代码图谱", en: "Check repo map" },
  repo_map_search: { zh: "搜索代码图谱", en: "Search repo map" },
  repo_map_context: { zh: "读取代码图谱", en: "Read repo map" },
  repo_map_files: { zh: "查看代码图谱文件", en: "Inspect repo-map files" },
  repo_map_impact: { zh: "分析影响范围", en: "Analyze impact" },
  index_workspace_documents: { zh: "索引文档", en: "Index documents" },
  knowledge_search: { zh: "搜索知识库", en: "Search knowledge" },
  knowledge_get_excerpt: { zh: "读取摘录", en: "Read excerpt" },
};

const COMPLETED_TOOL_GROUP_LABELS: Record<string, { zh: string; en: string }> = {
  find_gameobjects: { zh: "查找对象", en: "Find objects" },
  find_in_file: { zh: "文件搜索", en: "Search file" },
  execute_code: { zh: "执行代码", en: "Execute code" },
  script_apply_edits: { zh: "脚本编辑", en: "Script edits" },
  manage_camera: { zh: "相机管理", en: "Manage camera" },
  manage_gameobject: { zh: "对象管理", en: "Manage object" },
  manage_components: { zh: "组件管理", en: "Manage components" },
  manage_scene: { zh: "场景管理", en: "Manage scene" },
  refresh_unity: { zh: "刷新 Unity", en: "Refresh Unity" },
};

export function isCommandLikeToolName(toolName: string) {
  return TOOL_SUMMARY_GROUPS.command.has(toolName);
}

export function compactToolTarget(rawTarget: string, toolName: string, language: ChatLanguage) {
  return compactToolPresentationTarget(rawTarget, toolName, language);
}

export function fullToolTarget(rawTarget: string, toolName: string, language: ChatLanguage) {
  const target = String(rawTarget || "").trim();
  if (target) return target;
  if (toolName === "get_project_skeleton") return language === "zh" ? "项目骨架" : "Project skeleton";
  return language === "zh" ? "当前工作区" : "Current workspace";
}

export function getReadContextToolLabel(toolName: string, language: ChatLanguage) {
  const labels = READ_CONTEXT_TOOL_LABELS[toolName];
  if (labels) return labels[language === "zh" ? "zh" : "en"];
  return getToolPresentationLabel(toolName, language);
}

export function getCompletedToolGroupToolLabel(toolName: string, language: ChatLanguage) {
  const labels = COMPLETED_TOOL_GROUP_LABELS[toolName];
  if (labels) return labels[language === "zh" ? "zh" : "en"];
  return getToolPresentationLabel(toolName, language);
}

export function buildToolExecutionSummary(blocks: any[], language: ChatLanguage) {
  const counts = { read: 0, table: 0, edit: 0, command: 0, failed: 0, other: 0 };

  blocks.forEach((block) => {
    if (block.type !== "tool") return;
    if (block.toolStatus === "failed") {
      counts.failed += 1;
      return;
    }
    if (block.toolStatus !== "executed" && block.toolStatus !== "running") return;
    const toolName = String(block.toolName || "");
    if (TOOL_SUMMARY_GROUPS.read.has(toolName)) counts.read += 1;
    else if (TOOL_SUMMARY_GROUPS.table.has(toolName)) counts.table += 1;
    else if (TOOL_SUMMARY_GROUPS.edit.has(toolName)) counts.edit += 1;
    else if (TOOL_SUMMARY_GROUPS.command.has(toolName)) counts.command += 1;
    else counts.other += 1;
  });

  const parts: string[] = [];
  if (language === "zh") {
    if (counts.table) parts.push(`分析/查询 ${counts.table} 次表格`);
    if (counts.read) parts.push(`读取/搜索 ${counts.read} 次资料`);
    if (counts.edit) parts.push(`修改 ${counts.edit} 次文件`);
    if (counts.command) parts.push(`执行 ${counts.command} 次命令`);
    if (counts.other) parts.push(`调用 ${counts.other} 次工具`);
    if (counts.failed) parts.push(`${counts.failed} 次请求失败`);
    return parts.length > 0 ? `本轮已${parts.join("，")}。` : "本轮过程已折叠，结论会优先保留在这里。";
  }

  if (counts.table) parts.push(`${counts.table} table operation(s)`);
  if (counts.read) parts.push(`${counts.read} read/search operation(s)`);
  if (counts.edit) parts.push(`${counts.edit} file edit(s)`);
  if (counts.command) parts.push(`${counts.command} command operation(s)`);
  if (counts.other) parts.push(`${counts.other} tool call(s)`);
  if (counts.failed) parts.push(`${counts.failed} failed request(s)`);
  return parts.length > 0 ? `This turn completed ${parts.join(", ")}.` : "This turn is collapsed. The conclusion is kept here first.";
}

export function shouldGroupPlanExecutionTools(input: {
  turnIntent: string;
  isPlanTurn: boolean;
  isPlanApproved: boolean;
  planStage: string;
  turnStatus?: string;
  isPlanExecutionVisible: boolean;
}) {
  if (input.turnIntent === "studio_workflow") {
    return {
      enabled: true,
      includeDiff: false,
      includeReadContextTools: false,
      minGroupSize: 2,
    };
  }
  const isApprovedPlanExecution =
    input.isPlanTurn &&
    (
      input.isPlanApproved ||
      input.planStage === "executing" ||
      input.isPlanExecutionVisible ||
      input.turnStatus === "executing" ||
      input.turnStatus === "stopped_no_action" ||
      input.turnStatus === "error"
    );
  return {
    enabled: input.turnIntent === "execute" || isApprovedPlanExecution,
    includeDiff: input.turnIntent === "execute" || isApprovedPlanExecution,
    includeReadContextTools: isApprovedPlanExecution,
    minGroupSize: input.turnIntent === "execute" || isApprovedPlanExecution ? 1 : 2,
    splitProjectStructureExplore: input.isPlanTurn && !input.isPlanApproved,
  };
}

export function getOperationClusterTone(kind: ChatOperationCluster["kind"]) {
  if (kind === "edit") return "text-[#93c5fd]";
  if (kind === "command" || kind === "verify") return "text-[#c4b5fd]";
  if (kind === "explore") return "text-[#fbbf24]";
  return "text-[#34d399]";
}
