import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import {
  RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL,
} from "./executionContract";

const RUNTIME_V2_CORE_TOOL_NAMES = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_search",
  "repo_map_context",
  "code_ast_query",
  "find_symbol_references",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "get_file_outline",
  "replace_in_file",
  "write_file",
  "apply_patch",
  "delete_workspace_path",
  "git_status",
  "git_diff",
  "run_command",
  "browser_evaluate",
  "get_project_skeleton",
  "spawn_subagent",
  "wait_subagents",
  "record_execution_contract",
]);

export function runtimeV2ToolDefinitions(state?: any): ToolDefinition[] {
  const includeNetwork = state?.webSearchEnabled === true;
  const builtIns = [
    ...TOOL_DEFINITIONS,
    RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL,
  ].filter((definition) => {
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
            "Create a fresh, semantically independent child when real overlap helps. Explore, review, and validate children are read-only. After deriving a concrete evidence-backed solution, an implement child may stage one create/modify/delete transaction inside an exclusive narrow path scope; Runtime commits it at join. You must provide the task identity, objective, success criteria, and implementation contract.",
          parameters: {
            ...definition.function.parameters,
            properties: {
              ...definition.function.parameters.properties,
              name: {
                type: "string",
                description:
                  "模型为当前按需子任务选择的真实显示名称；必填，不得由 Runtime 从目录名生成",
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
              implementation_plan: {
                type: "string",
                description:
                  "implement 子任务必填：父线程已经形成的具体修改方案，含责任边界与预期行为；不得使用泛化的‘修复问题’",
              },
            },
            required: [
              "task_key",
              "task_kind",
              "name",
              "role",
              "objective",
              "success_criteria",
              "required_paths",
            ],
          },
        },
      };
    }
    if (definition.function.name === "wait_subagents") {
      return {
        ...definition,
        function: {
          ...definition.function,
          description:
            "Wait for one or all active child tasks only when their evidence or staged implementation is now a dependency. Omit ids to wait for all, or pass exact task_key handles. A failed child never blocks the parent from continuing directly.",
          parameters: {
            ...definition.function.parameters,
            properties: {
              ...definition.function.parameters.properties,
              subagent_ids: {
                type: "string",
                description:
                  "Optional comma-separated active task_key handles exactly as shown in current context; omit to wait for all active children.",
              },
              collaboration_task_ids: {
                type: "string",
                description:
                  "Compatibility alias for subagent_ids; use exact active task_key handles.",
              },
            },
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
  return builtIns;
}
