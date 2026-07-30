export const RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_search",
  "repo_map_context",
  "code_ast_query",
  "find_symbol_references",
  "read_file",
  "get_file_outline",
  "git_status",
  "git_diff",
  "get_project_skeleton",
]);

export const RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
]);

export const RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES = new Set([
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
]);

export const RUNTIME_V2_SOURCE_READ_TOOL_NAMES = new Set([
  ...RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES,
  ...RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES,
]);

export function isRuntimeV2WorkspaceReadToolName(toolName: string): boolean {
  return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(toolName) ||
    RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(toolName);
}

export function isRuntimeV2ReadOnlyToolName(toolName: string): boolean {
  return RUNTIME_V2_SOURCE_READ_TOOL_NAMES.has(toolName) ||
    RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(toolName);
}
