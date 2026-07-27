import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import {
  RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES,
} from "../../lib/runtime-v2/workspaceReadPolicy";

const RUNTIME_V2_CORE_TOOL_NAMES = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_search",
  "repo_map_context",
  "code_ast_query",
  "find_symbol_references",
  "read_file",
  "get_file_outline",
  "replace_in_file",
  "write_file",
  "apply_patch",
  "git_status",
  "git_diff",
  "run_command",
  "browser_evaluate",
  "get_project_skeleton",
  "spawn_subagent",
  "wait_subagents",
]);

export function runtimeV2ToolDefinitions(state?: any): ToolDefinition[] {
  const includeNetwork = state?.webSearchEnabled === true;
  return TOOL_DEFINITIONS.filter((definition) => {
    const name = definition.function.name;
    return RUNTIME_V2_CORE_TOOL_NAMES.has(name) ||
      (includeNetwork && RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name));
  }).map((definition) => {
    if (definition.function.name === "spawn_subagent") {
      return {
        ...definition,
        function: {
          ...definition.function,
          description:
            "Create one fresh, read-only, semantically independent child investigation. You—not Runtime—must provide its task_key, name, role, objective, and success_criteria. Paths are only a permission boundary and must not be used to invent generic directory-based work.",
          parameters: {
            ...definition.function.parameters,
            properties: {
              ...definition.function.parameters.properties,
              name: {
                type: "string",
                description:
                  "模型为当前一次性调查选择的真实显示名称；必填，不得由 Runtime 从目录名生成",
              },
              role: {
                type: "string",
                description:
                  "模型根据实际调查职责选择的角色；必填，如 event-flow reviewer 或 test analyst",
              },
              success_criteria: {
                type: "string",
                description:
                  "当前调查可判定的成功标准；必填，必须对应真实目标和可返回证据",
              },
            },
            required: [
              "task_key",
              "name",
              "role",
              "objective",
              "success_criteria",
            ],
          },
        },
      };
    }
    if (definition.function.name !== "write_file") return definition;
    return {
      ...definition,
      function: {
        ...definition.function,
        description:
          "Create a new file with complete content. Runtime v2 rejects overwriting an existing file; use replace_in_file or apply_patch for bounded edits to existing source.",
      },
    };
  });
}
