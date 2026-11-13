import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import { unityMcpObservationTools, UNITY_MCP_OBSERVATION_NAMES } from "../../lib/workspaceMcp";
import { UNITY_CREATE_SCENE_TOOL } from "../../lib/workspaceMutationTools";
import {
  buildLoadSkillToolDefinition,
  LOAD_SKILL_TOOL_NAME,
  type SkillCatalogSnapshot,
} from "../../lib/agentSkills";
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
  "computer_use",
  "get_project_skeleton",
  "spawn_subagent",
  "wait_subagents",
  "record_execution_contract",
  "load_skill",
  "tool_search",
  UNITY_CREATE_SCENE_TOOL,
]);

const UNITY_SCENE_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: UNITY_CREATE_SCENE_TOOL,
    description: "Create the exact approved Unity 6 scene with one root and the named project MonoBehaviour. The connected Editor refreshes and recompiles first, saves once, and verifies the saved asset. Unity generates .meta files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Approved new workspace-relative Assets/... .unity path." },
        root_name: { type: "string", description: "Name of the scene's single GameObject." },
        script_path: { type: "string", description: "Workspace-relative Assets/... .cs path from the approved Plan, already committed or preserved." },
      },
      required: ["path", "root_name", "script_path"],
    },
  },
};

export function runtimeV2ToolDefinitions(
  state?: any,
  skillCatalog?: SkillCatalogSnapshot | null,
  knowledgeContext?: import("../../lib/knowledgeReferences").KnowledgeContextPacket,
): ToolDefinition[] {
  const includeNetwork = state?.webSearchEnabled === true;
  const loadSkillDefinition = buildLoadSkillToolDefinition(skillCatalog);
  const builtIns = [
    ...TOOL_DEFINITIONS,
    ...unityMcpObservationTools(state),
    UNITY_SCENE_DEFINITION,
    RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL,
    ...(loadSkillDefinition ? [loadSkillDefinition] : []),
  ].filter((definition) => {
    const name = definition.function.name;
    return RUNTIME_V2_CORE_TOOL_NAMES.has(name) || UNITY_MCP_OBSERVATION_NAMES.has(name) ||
      (!!knowledgeContext?.references.length && knowledgeContext.state !== "stale" && knowledgeContext.state !== "error" && ["knowledge_search", "knowledge_get_excerpt"].includes(name)) ||
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
          "创建新文件或写入完整文件内容（写入前会自动记录 Checkpoint 快照；局部小改动也可使用 replace_in_file）。",
      },
    };
  });
  return builtIns;
}

export function logRuntimeV2SkillLoad(input: {
  readonly toolName: string;
  readonly succeeded: boolean;
  readonly rawOutput: unknown;
  readonly skillId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly sessionKey: string;
  readonly commandKey: string;
  readonly logStoreEvent: (type: string, payload: Record<string, unknown>) => void;
}): void {
  if (input.toolName !== LOAD_SKILL_TOOL_NAME || !input.succeeded) return;
  const trace = { sessionKey: input.sessionKey, turnId: input.turnId, runId: input.runId, commandKey: input.commandKey };
  let revision: string | null = null;
  let skillId = input.skillId;
  let complete = true;
  let disclosure: string | null = null;
  let returnedRange: unknown = null;
  try {
    const result = JSON.parse(String(input.rawOutput || ""));
    if (result.type === "skill.catalog") {
      input.logStoreEvent("runtime_v2_skill_catalog_listed", {
        ...trace,
        total: result.total,
        returned: Array.isArray(result.entries) ? result.entries.length : 0,
        hasNextPage: !!result.nextCursor,
        effect: "metadata_only",
      });
      return;
    }
    if (result.type === "skill.resource") {
      input.logStoreEvent("runtime_v2_skill_resource_read", {
        ...trace, skillId: String(result.id || input.skillId),
        resource: result.resource, revision: result.version, complete: result.complete !== false,
        disclosure: result.disclosure, returnedRange: result.returnedRange,
        effect: "resource_guidance_only",
      });
      return;
    }
    revision = String(result.version || "") || null;
    skillId = String(result.id || skillId);
    complete = result.complete !== false;
    disclosure = typeof result.disclosure === "string" ? result.disclosure : null;
    returnedRange = result.returnedRange || null;
  } catch {
    revision = null;
  }
  input.logStoreEvent(complete ? "runtime_v2_skill_loaded" : "runtime_v2_skill_disclosed", {
    ...trace,
    skillId,
    revision,
    complete,
    disclosure,
    returnedRange,
    effect: complete ? "instructions_only" : "partial_instructions_only",
  });
}
