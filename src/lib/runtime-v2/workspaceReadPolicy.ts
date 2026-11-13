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

const EDITOR_READ_TOOLS = ["unity_mcp_scene", "unity_mcp_console"] as const;
export type RuntimeV2EditorReadToolName = typeof EDITOR_READ_TOOLS[number];
/** Live Editor observations have no file-version authority or source replay. */
export const RUNTIME_V2_EDITOR_READ_TOOL_NAMES: ReadonlySet<string> = new Set(EDITOR_READ_TOOLS);

/** Reads immutable Turn guidance, not workspace source. Keeping this separate
 * prevents a Skill body from satisfying source-version or mutation leases. */
export const RUNTIME_V2_SKILL_READ_TOOL_NAMES = new Set([
  "load_skill",
  "tool_search",
]);

export const RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES = new Set([
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
]);

export const RUNTIME_V2_KNOWLEDGE_READ_TOOL_NAMES = new Set(["knowledge_search", "knowledge_get_excerpt"]);

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
    RUNTIME_V2_EDITOR_READ_TOOL_NAMES.has(toolName) ||
    RUNTIME_V2_SKILL_READ_TOOL_NAMES.has(toolName) ||
    RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(toolName) ||
    RUNTIME_V2_KNOWLEDGE_READ_TOOL_NAMES.has(toolName);
}

export function isRuntimeV2ReadOnlyToolCall(call: { readonly name: string; readonly boundEditorObservation?: true }): boolean {
  return call.boundEditorObservation === true || isRuntimeV2ReadOnlyToolName(call.name);
}
