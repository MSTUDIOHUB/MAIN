import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import {
  SUPPORTED_BROWSER_INTERACTION_ACTION_KINDS,
  SUPPORTED_DESKTOP_INTERACTION_ACTION_KINDS,
  SUPPORTED_INTERACTION_ASSERTION_KINDS,
} from "../../lib/validationContract";
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
  "computer_use",
  "get_project_skeleton",
  "spawn_subagent",
  "wait_subagents",
]);

export const RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME =
  "submit_execution_contract";

const RUNTIME_V2_EXECUTION_CONTRACT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
    description:
      "Commit or revise the Runtime v2 execution contract before the next workspace mutation. Criterion ids are runtime-owned: multi-criterion objectives require exact ids, while a sole non-empty criterion reference is bound to the one runtime criterion. The runtime binds modify/delete targets to matching versioned source evidence; basis_evidence_ids are optional evidence hints and never grant authority. Every target and criterion must have a matching validation.",
    parameters: {
      type: "object",
      properties: {
        criteria: {
          type: "array",
          minItems: 1,
          description:
            "Optional evidence-strength hints. Omit for a sole runtime criterion; the runtime owns its id and minimum evidence requirement. Multi-criterion objectives require the exact catalog ids.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              evidence_requirement: {
                type: "string",
                enum: ["static", "behavioral", "interaction"],
              },
            },
            required: ["id", "evidence_requirement"],
          },
        },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              operation: {
                type: "string",
                enum: ["modify", "create", "delete"],
              },
              target: { type: "string" },
              basis_evidence_ids: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["operation", "target"],
          },
        },
        validations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              criterion_ids: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                description:
                  "Optional when the runtime catalog contains one criterion; otherwise list the exact runtime criterion ids covered by this validation.",
              },
              target_paths: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
              },
              kind: {
                type: "string",
                enum: ["finite_command", "browser", "desktop"],
                description:
                  "Use finite_command for a real bounded test or executable assertion, browser/desktop for user interaction. Static build/lint/typecheck cannot prove behavioral acceptance.",
              },
              command: {
                type: "string",
                description:
                  "finite_command only. Must execute a real bounded test or assertion. echo, grep, sed, cat, head, tail, and wc are inspection, not validation.",
              },
              cwd: { type: "string" },
              actions: {
                type: "array",
                description:
                  "Browser/desktop only. Structured actions that the validation result must actually report as succeeded.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    kind: {
                      type: "string",
                      enum: [...new Set([
                        ...SUPPORTED_BROWSER_INTERACTION_ACTION_KINDS,
                        ...SUPPORTED_DESKTOP_INTERACTION_ACTION_KINDS,
                      ])],
                    },
                    target: { type: "string" },
                  },
                  required: ["id", "kind", "target"],
                },
              },
              assertions: {
                type: "array",
                description:
                  "Browser/desktop only. Structured post-action assertions that must match returned causal evidence.",
                items: {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      enum: [...SUPPORTED_INTERACTION_ASSERTION_KINDS],
                    },
                    target: { type: "string" },
                    after_action_id: { type: "string" },
                    expected: {},
                  },
                  required: ["kind", "target", "after_action_id"],
                },
              },
              require_causal_assertion: { type: "boolean" },
              expected_outcome: { type: "string" },
            },
            required: [
              "id",
              "target_paths",
              "kind",
              "expected_outcome",
            ],
          },
        },
      },
      required: ["changes", "validations"],
    },
  },
};

export function runtimeV2ToolDefinitions(state?: any): ToolDefinition[] {
  const includeNetwork = state?.webSearchEnabled === true;
  const builtIns = TOOL_DEFINITIONS.filter((definition) => {
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
            "Create a fresh, read-only, semantically independent explore, review, or validate child whenever it helps the current lifecycle phase. The parent remains the only writer. You—not Runtime—must provide its task_key, task_kind, name, role, objective, and success_criteria. Paths are a permission boundary and may overlap other read-only jobs.",
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
            },
            required: [
              "task_key",
              "task_kind",
              "name",
              "role",
              "objective",
              "success_criteria",
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
            "Wait for one or all active read-only child tasks only when their result is now a dependency. Omit ids to wait for all, or pass the exact short task_key handles shown in the current parent context. A failed child never blocks the parent from continuing directly.",
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
  return [...builtIns, RUNTIME_V2_EXECUTION_CONTRACT_TOOL];
}
