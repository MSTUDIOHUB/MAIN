import { summarizeApplyPatchTarget } from "./applyPatchTool";
import { formatPtyInputTarget } from "./ptyCommandRuntime";
import { resolveWorkspaceMutationTargets } from "./workspaceMutationTools";

/** Derive a short display target from tool arguments. */
export function getToolTarget(name: string, args: Record<string, unknown>): string {
  const mutationTargets = resolveWorkspaceMutationTargets(name, args);
  if (mutationTargets.length > 0) return mutationTargets.join(", ");
  switch (name) {
    // The objective is durable ChatArea content, not a compact tool target.
    // Falling back to the full assignment here made Capsule cut a sentence in
    // half and left users without any complete account of the delegation.
    case "spawn_subagent": return (args.name as string) || "subagent";
    case "wait_subagents": return (args.subagent_ids as string) ||
      (args.collaboration_task_ids as string) || "all subagents";
    case "cancel_subagent": return (args.subagent_id as string) ||
      (args.collaboration_task_id as string) || "subagent";
    case "list_directory": return (args.path as string) || ".";
    case "read_file": return (args.path as string) || "";
    case "read_document": return (args.path as string) || "";
    case "analyze_tabular_document": return (args.path as string) || "";
    case "query_tabular_document": return (args.path as string) || "";
    case "index_workspace_documents": return (args.path as string) || ".";
    case "knowledge_search": return (args.query as string) || "knowledge";
    case "knowledge_get_excerpt": return (args.chunk_id as string) || (args.chunkId as string) || "knowledge excerpt";
    case "glob_search": return (args.pattern as string) || "";
    case "grep_search": return (args.path as string) || (args.query as string) || "";
    case "web_search": return (args.query as string) || "web search";
    case "web_fetch": return (args.url as string) || "";
    case "repo_map_search": return (args.query as string) || "";
    case "repo_map_context": return (args.task as string) || "repo map context";
    case "repo_map_files": return (args.filter as string) || "repo map files";
    case "repo_map_impact": return (args.target as string) || "";
    case "repo_map_status": return "repo map";
    case "get_file_outline": return (args.path as string) || "";
    case "code_ast_query": return (args.path as string) || "";
    case "find_symbol_references": return (args.path as string) || (args.symbol as string) || "";
    case "git_status": return "git status";
    case "git_diff": return (args.path as string) || (args.filter as string) || "workspace diff";
    case "execute_command": return (args.command as string) || "";
    case "send_pty_input": return formatPtyInputTarget(
      typeof args.input === "string" ? args.input : "",
      typeof args.control === "string" ? args.control : undefined,
    );
    case "run_command": return (args.command as string) || "";
    case "browser_evaluate": return (args.url as string) || "";
    case "computer_use": return (args.app_name as string) || (args.appName as string) || (args.app as string) || "desktop app";
    case "read_pty_buffer": return "terminal";
    case "read_pty_tail": return "terminal tail";
    case "read_pty_since": return `terminal @ ${args.offset ?? 0}`;
    case "get_pty_status": return "terminal status";
    case "clear_pty_buffer": return "terminal buffer";
    case "replace_in_file": return (args.path as string) || "";
    case "write_file": return (args.path as string) || "";
    case "apply_patch": return summarizeApplyPatchTarget((args.patch as string) || "") || "workspace patch";
    default: return (args.input as string) || name;
  }
}
