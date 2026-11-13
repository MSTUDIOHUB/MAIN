/** Built-ins whose existing execution contract requires a real project root.
 * Global file reads have their own attachment/approval guards. */
const WORKSPACE_REQUIRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "code_ast_query",
  "find_symbol_references",
  "get_project_skeleton",
  "get_file_outline",
  "index_workspace_documents",
  "replace_in_file",
  "write_file",
  "apply_patch",
  "unity_create_scene",
  "git_status",
  "git_diff",
  "delete_workspace_path",
  "run_command",
  "browser_evaluate",
  "computer_use",
  "execute_command",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

export function builtInToolRequiresWorkspace(name: string): boolean {
  return WORKSPACE_REQUIRED_TOOL_NAMES.has(name);
}
